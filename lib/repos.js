'use strict';

// Everything about the list of team repositories: URL normalisation, folder keys, repository names, the merged catalog
// and the repositories a project needs. Pure: never requires vscode.

const crypto = require('crypto');
const path = require('path');

function sha8(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
}

function pathModule(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

// The same repository written two ways gives the same string: host and path of a URL (scheme, user, port and a final
// `.git` dropped, host lower-cased), the resolved path of a local one (`file:` prefix; lower-cased on Windows).
function normalizeUrl(url, platform = process.platform) {
  let s = String(url || '').trim();
  if (/^file:\/\//i.test(s)) {
    s = s.slice(7);
    if (/^\/[A-Za-z]:[\\/]/.test(s)) {
      s = s.slice(1);
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\/.test(s) || /^\//.test(s) || /^\.\.?([\\/]|$)/.test(s) || /^~/.test(s)) {
    let p = pathModule(platform).resolve(s).replace(/\\/g, '/').replace(/\/$/, '');
    if (platform === 'win32') {
      p = p.toLowerCase();
    }
    return `file:${p}`;
  }
  let host;
  let rest;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/i.exec(s);
  if (m) {
    host = m[2];
    rest = m[3] || '';
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(.*)$/.exec(s);
    if (!scp) {
      return s;
    }
    host = scp[1];
    rest = scp[2];
  }
  rest = rest.replace(/\/\/+/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return `${host.toLowerCase()}/${rest}`;
}

// The last part of a URL or path, without `.git`: the repository's name when its marketplace.json has none.
function baseName(source) {
  let s = String(source || '').replace(/[\\/]+$/, '');
  s = s.split(/[\\/]/).pop();
  if (s.includes(':')) {
    s = s.slice(s.lastIndexOf(':') + 1);
  }
  s = s.replace(/\.git$/i, '');
  return s || 'repo';
}

// A repository name is used in ids (`<repository>:<plugin>`): no ':' and no separators.
function repoName(raw) {
  return String(raw || '').trim().replace(/[:/\\\s]+/g, '-');
}

function safeFs(s) {
  return String(s).replace(/[^A-Za-z0-9._-]/g, '_');
}

// The url of [remote "origin"] in the text of a .git/config (git writes a Windows path with doubled backslashes).
function originUrl(text) {
  if (typeof text !== 'string') {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*\[\s*remote\s+"origin"\s*\]\s*$/.test(l));
  if (start < 0) {
    return '';
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      return '';
    }
    const m = /^\s*url\s*=\s*(.*)$/i.exec(lines[i]);
    if (m) {
      const raw = m[1].trim();
      let out = '';
      for (let j = 0; j < raw.length; j++) {
        const c = raw[j];
        if (c === '\\' && j + 1 < raw.length) {
          const n = raw[j + 1];
          const map = { '\\': '\\', '"': '"', t: '\t', n: '\n', b: '\b' };
          if (Object.prototype.hasOwnProperty.call(map, n)) {
            out += map[n];
            j++;
            continue;
          }
        }
        if (c !== '"') {
          out += c;
        }
      }
      return out;
    }
  }
  return '';
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function parseRepositories(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const list = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) {
        list.push({ url: item.trim(), branch: '' });
      }
    } else if (item && typeof item === 'object' && str(item.url)) {
      list.push({ url: str(item.url), branch: str(item.branch) });
    }
  }
  return list;
}

function parseLocalRepositories(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string').map((v) => v.trim()).filter(Boolean) : [];
}

function parseProjectRepositories(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const list = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item.trim()) {
        list.push({ name: '', url: item.trim(), branch: '' });
      }
    } else if (item && typeof item === 'object' && str(item.url)) {
      list.push({ name: str(item.name), url: str(item.url), branch: str(item.branch) });
    }
  }
  return list;
}

// What to write to the new settings from the 0.4 ones (the arguments are the global values; a new setting that is
// already set is never overwritten).
function migratedSettings({ repoUrl, branch, localRepoPath, repositories, localRepositories } = {}) {
  const result = {};
  if (repositories === undefined && typeof repoUrl === 'string' && repoUrl.trim()) {
    const b = typeof branch === 'string' ? branch.trim() : '';
    result.repositories = [b ? { url: repoUrl.trim(), branch: b } : { url: repoUrl.trim() }];
  }
  if (localRepositories === undefined && typeof localRepoPath === 'string' && localRepoPath.trim()) {
    result.localRepositories = [localRepoPath.trim()];
  }
  return result;
}

// Every configured repository, drafts (when `drafts`, the folder of the plugins being written, is set) then locals
// first: { key, kind, source, url, branch, normalized, dir, lockFile, stateFile, duplicateOf }. key names the folder of
// a managed clone and its lock and state files. The old single clone (<pluginsRoot>/repo) is kept as the repository
// whose URL equals the origin URL of that clone (legacyOrigin).
function listRepos({ repositories, localRepositories, drafts = '', pluginsRoot, storage, legacyOrigin = '', platform = process.platform }) {
  const P = pathModule(platform);
  const legacy = legacyOrigin ? normalizeUrl(legacyOrigin, platform) : '';
  const items = [
    ...(localRepositories || []).map((p) => ({ kind: 'local', source: p })),
    ...(repositories || []).map((r) => ({ kind: 'managed', source: r.url, branch: r.branch || '' })),
  ];
  const descs = [];
  const seen = new Map();
  if (drafts) {
    const draftsDesc = {
      key: 'drafts',
      kind: 'drafts',
      source: drafts,
      url: '',
      branch: '',
      normalized: normalizeUrl(drafts, platform),
      dir: P.resolve(drafts),
      lockFile: P.join(storage, 'locks', 'drafts.lock'),
      stateFile: P.join(storage, 'state', 'drafts.json'),
      duplicateOf: null,
    };
    seen.set(draftsDesc.normalized, draftsDesc);
    descs.push(draftsDesc);
  }
  let legacyTaken = false;
  items.forEach((item, i) => {
    const normalized = normalizeUrl(item.source, platform);
    const earlier = seen.get(normalized);
    let key;
    let dir;
    if (earlier) {
      key = `dup-${i}`;
      dir = P.join(pluginsRoot, 'repos', key);
    } else if (item.kind === 'local') {
      key = `local-${safeFs(baseName(item.source)).slice(0, 40)}-${sha8(normalized)}`;
      dir = P.resolve(item.source);
    } else if (legacy && legacy === normalized && !legacyTaken) {
      legacyTaken = true;
      key = 'repo';
      dir = P.join(pluginsRoot, 'repo');
    } else {
      key = `${safeFs(baseName(item.source)).slice(0, 40)}-${sha8(normalized)}`;
      dir = P.join(pluginsRoot, 'repos', key);
    }
    const desc = {
      key,
      kind: item.kind,
      source: item.source,
      url: item.kind === 'managed' ? item.source : '',
      branch: item.kind === 'managed' ? item.branch : '',
      normalized,
      dir,
      lockFile: P.join(storage, 'locks', `${key}.lock`),
      stateFile: P.join(storage, 'state', `${key}.json`),
      duplicateOf: earlier ? earlier.key : null,
    };
    if (!earlier) {
      seen.set(normalized, desc);
    }
    descs.push(desc);
  });
  return descs;
}

// Adds the name of each repository (its marketplace.json name, else the last part of its URL) and hiddenBy: the
// earlier repository that already has that name (the later one is not loaded; a local clone replaces a managed one).
// catalogNames: Map key -> marketplace name.
function assignNames(descs, catalogNames) {
  const winners = new Map();
  return descs.map((d) => {
    if (d.duplicateOf) {
      return { ...d, name: '', hiddenBy: null };
    }
    const name = repoName(catalogNames && catalogNames.get(d.key)) || repoName(baseName(d.source)) || 'repo';
    const w = winners.get(name);
    if (w) {
      return {
        ...d,
        name,
        hiddenBy: { key: w.key, source: w.source, reason: w.kind === 'local' && d.kind === 'managed' ? 'local' : 'name' },
      };
    }
    winners.set(name, d);
    return { ...d, name, hiddenBy: null };
  });
}

// One catalog of the plugins of every loaded repository: ids are `<repository>:<plugin>` (and `<repository>:<plugin>/
// skills/<folder>`...). Cursor names a registered plugin after its folder, so a plugin whose folder name is taken by
// an earlier one gets another (`folder`, used for its copy).
function mergeCatalogs(entries) {
  const plugins = [];
  const warnings = [];
  const taken = new Set();
  for (const { desc, catalog } of entries) {
    for (const p of catalog.plugins) {
      const base = path.basename(p.dir);
      let folder;
      if (taken.has(base.toLowerCase())) {
        const stem = `${base}-${safeFs(desc.name)}`;
        let candidate = stem;
        for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
          candidate = `${stem}-${n}`;
        }
        folder = candidate;
      }
      taken.add((folder || base).toLowerCase());
      const merged = {
        ...p,
        name: `${desc.name}:${p.name}`,
        pluginName: p.name,
        repo: desc.name,
        repoKey: desc.key,
        children: p.children.map((c) => ({ ...c, id: `${desc.name}:${c.id}` })),
      };
      if (folder) {
        merged.folder = folder;
      }
      plugins.push(merged);
    }
    for (const w of catalog.warnings || []) {
      warnings.push(`${desc.name}: ${w}`);
    }
  }
  return { plugins, warnings };
}

// 0.4 ids (`review`, `review/skills/x`) become `<repository>:<id>` of the first plugin they match.
function normalizeIds(catalog, list) {
  const out = [];
  for (const id of list || []) {
    if (typeof id !== 'string') {
      continue;
    }
    if (id.includes(':')) {
      out.push(id);
      continue;
    }
    const p = catalog.plugins.find((x) => x.pluginName === id || x.children.some((c) => c.id === `${x.repo}:${id}`));
    out.push(p ? `${p.repo}:${id}` : id);
  }
  return [...new Set(out)].sort();
}

function repoOfId(id) {
  const i = String(id).indexOf(':');
  return i < 0 ? '' : String(id).slice(0, i);
}

// The repositories a project lists that the user doesn't follow (one per URL).
function missingRepos(projectRepos, descs) {
  const followed = descs.filter((d) => !d.duplicateOf);
  const urls = new Set(followed.map((d) => d.normalized));
  const names = new Set(followed.map((d) => d.name));
  const seen = new Set();
  const out = [];
  for (const e of projectRepos || []) {
    const normalized = normalizeUrl(e.url);
    if (urls.has(normalized) || (e.name && names.has(e.name)) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push({ name: e.name || '', url: e.url, branch: e.branch || '', normalized });
  }
  return out;
}

// The repository names a project's ids use that the user doesn't follow and the project doesn't locate.
function unlocatedRepos(projectIds, projectRepos, descs) {
  const known = new Set(descs.filter((d) => !d.duplicateOf).map((d) => d.name));
  for (const e of projectRepos || []) {
    if (e.name) {
      known.add(e.name);
    }
  }
  const names = new Set();
  for (const id of projectIds || []) {
    const name = typeof id === 'string' && id.includes(':') ? repoOfId(id) : '';
    if (name && !known.has(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function clean(e) {
  const out = {};
  if (str(e.name)) {
    out.name = str(e.name);
  }
  out.url = str(e.url);
  if (str(e.branch)) {
    out.branch = str(e.branch);
  }
  return out;
}

// An HTTP(S) URL without its user and password: the project's settings are committed, so a token written in a
// repository URL must not reach them (the `git@` of an SSH URL is kept: it is not a secret and SSH needs it).
function withoutCredentials(url) {
  return String(url).replace(/^(https?:\/\/)[^@/]*@/i, '$1');
}

// The entry of teamPlugins.projectRepositories for a followed repository; null when a local clone has no origin URL.
function projectRepoEntry(desc, localOrigin) {
  if (desc.kind === 'managed') {
    return clean({ name: desc.name, url: withoutCredentials(desc.url), branch: desc.branch });
  }
  return localOrigin ? clean({ name: desc.name, url: withoutCredentials(localOrigin) }) : null;
}

function withProjectRepo(list, entry) {
  const items = parseProjectRepositories(list).map(clean);
  const url = normalizeUrl(entry.url);
  const name = str(entry.name);
  if (items.some((e) => (name && e.name === name) || normalizeUrl(e.url) === url)) {
    return items;
  }
  return [...items, clean(entry)];
}

// Keeps the entry while some project id still uses the repository.
function withoutProjectRepo(list, name, projectIds) {
  const items = parseProjectRepositories(list).map(clean);
  if ((projectIds || []).some((id) => repoOfId(id) === name)) {
    return items;
  }
  return items.filter((e) => e.name !== name);
}

module.exports = {
  normalizeUrl,
  baseName,
  repoName,
  safeFs,
  originUrl,
  parseRepositories,
  parseLocalRepositories,
  parseProjectRepositories,
  migratedSettings,
  listRepos,
  assignNames,
  mergeCatalogs,
  normalizeIds,
  repoOfId,
  missingRepos,
  unlocatedRepos,
  withoutCredentials,
  projectRepoEntry,
  withProjectRepo,
  withoutProjectRepo,
};
