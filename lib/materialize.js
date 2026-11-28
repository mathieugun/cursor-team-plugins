'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { removeTree } = require('./sync');
const { filterMcpJson } = require('./catalog');
const { DEFAULT_FILE, MANIFEST_FILES, withoutHooks, withoutDefaultHooks } = require('./hooks');

const MANIFEST = '.team-plugins-sync.json';

// Is b equal to a or below it?
function inside(a, b) {
  const x = path.relative(a, b);
  return x === '' || (!x.startsWith('..') && !path.isAbsolute(x));
}

function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

// { files: Map(rel (with '/') -> full path of every file below dir, skipping .git folders), skipped: [{ rel, reason }],
// unreadable: [{ rel, code }] }.
// Links (symlinks and junctions: a junction reads as isSymbolicLink(), never isDirectory()) are followed only inside
// `root` (the repository), so the copy holds real files and an edit in the copy reaches the linked file; a file
// listed through a link keeps the link's path, so writes go through the link. Without `root` (the partial copy
// side) a link is never followed. A link that is not followed is left out of `files` and reported in `skipped`.
// A folder that can't be listed (any error, the start folder included: rel '') is reported in `unreadable` and its
// content is missing from `files`: a caller must decide nothing below it.
function listFiles(dir, { root } = {}) {
  const files = new Map();
  const skipped = [];
  const unreadable = [];
  const rootReal = root ? realOf(root) || path.resolve(root) : null;
  const walk = (current, rel, currentReal, chain) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      unreadable.push({ rel, code: err.code || err.message });
      return;
    }
    for (const e of entries) {
      if (e.name === '.git') {
        continue;
      }
      const full = path.join(current, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        if (!rootReal) {
          skipped.push({ rel: r, reason: 'link in the partial copy' });
          continue;
        }
        let real;
        let st;
        try {
          real = fs.realpathSync(full);
          st = fs.statSync(real);
        } catch {
          skipped.push({ rel: r, reason: 'broken link' });
          continue;
        }
        if (!inside(rootReal, real)) {
          skipped.push({ rel: r, reason: 'link to a path outside the repository' });
          continue;
        }
        if (st.isDirectory()) {
          if (chain.some((c) => inside(real, c))) {
            skipped.push({ rel: r, reason: 'link loop' });
            continue;
          }
          walk(full, r, real, [...chain, real]);
        } else {
          files.set(r, full);
        }
      } else if (e.isDirectory()) {
        const real = path.join(currentReal, e.name);
        walk(full, r, real, [...chain, real]);
      } else {
        files.set(r, full);
      }
    }
  };
  const start = realOf(dir) || path.resolve(dir);
  walk(dir, '', start, [start]);
  return { files, skipped, unreadable };
}

// Is rel the folder u (rel '' = the whole start folder) or below it?
const belowFolder = (rel, u) => u === '' || rel === u || rel.startsWith(`${u}/`);

const lower = (rel) => rel.toLowerCase();
const identity = (rel) => rel;

const caseCache = new Map();

// The part with the case of every letter swapped (lower -> upper, else upper -> lower).
const swapCase = (part) => [...part].map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase())).join('');

// true when `a` and `b` are one file (dev and ino, bigint), false when `b` is missing or another file, null when it
// can't be told.
function sameFile(a, b) {
  let sa;
  try {
    sa = fs.statSync(a, { bigint: true });
  } catch {
    return null;
  }
  try {
    const sb = fs.statSync(b, { bigint: true });
    return sb.dev === sa.dev && sb.ino === sa.ino;
  } catch (err) {
    return err.code === 'ENOENT' ? false : null;
  }
}

// Does the folder `dir` look names up without case? Case sensitivity is a property of each folder (Windows sets it per
// folder), so the probe is a name inside it: an entry that has a cased letter, looked up with every letter's case
// swapped, is the same file -> case-insensitive, missing or another file -> case-sensitive (cached by resolved path).
// A folder without such an entry (empty, or unreadable) is judged by how its parent looks up its own name, which holds
// only when both folders agree (not cached); without that either: process.platform is 'win32' or 'darwin'.
function caseInsensitive(dir) {
  const resolved = path.resolve(dir);
  if (caseCache.has(resolved)) {
    return caseCache.get(resolved);
  }
  const fallback = process.platform === 'win32' || process.platform === 'darwin';
  let names = [];
  try {
    names = fs.readdirSync(resolved);
  } catch {
    // judged from the parent below
  }
  const name = names.find((n) => n.toLowerCase() !== n.toUpperCase());
  if (name !== undefined) {
    const same = sameFile(path.join(resolved, name), path.join(resolved, swapCase(name)));
    if (same !== null) {
      caseCache.set(resolved, same);
      return same;
    }
  }
  const base = path.basename(resolved);
  if (base && base.toLowerCase() !== base.toUpperCase()) {
    const same = sameFile(resolved, path.join(path.dirname(resolved), swapCase(base)));
    if (same !== null) {
      return same;
    }
  }
  return fallback;
}

// The folder of a partial copy that Cursor registers: the plugin's folder name below the holder folder.
function copyRootOf(plugin, holderDir) {
  return path.join(holderDir, plugin.folder || path.basename(plugin.dir));
}

// The folder name of a partial copy: plugin name and selection, not the files (the copy keeps its path while its files
// change, so an agent editing it keeps writing to a registered folder). The name part is the plugin name with every
// character other than a letter, digit, '.', '_' and '-' replaced by '_', at most 64 characters, so it is always one safe
// folder name; the hash (of the real name and the selection) keeps two names that clean up the same apart.
function suppressHooks(plugin, includedIds, hooksDisabled) {
  const id = `${plugin.name}/hooks`;
  return !includedIds.includes(id) && (hooksDisabled || plugin.hasHookConfig || plugin.children.some((c) => c.kind === 'hooks'));
}

function holderName(plugin, includedIds, hooksDisabled = false) {
  const marker = suppressHooks(plugin, includedIds, hooksDisabled) ? '\0hooks-disabled' : '';
  const hash = crypto
    .createHash('sha1')
    .update(`${plugin.name}\n${[...includedIds].sort().join('\n')}${marker}`)
    .digest('hex')
    .slice(0, 12);
  const safe = plugin.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  return `${safe}-${hash}`;
}

// What the selection does to the MCP files of the plugin (plugin.mcpFiles: file name -> its server names): `dropped`
// are the files whose every server is left out (never copied), `filtered` maps the files with some servers left out to
// the names to remove (the copy holds a generated version); the other files are normal files.
function mcpPlan(plugin, includedIds) {
  const included = new Set(includedIds);
  const left = new Set(plugin.children.filter((c) => c.kind === 'mcp' && !included.has(c.id)).map((c) => c.name));
  const dropped = [];
  const filtered = new Map();
  for (const [fileName, names] of Object.entries(plugin.mcpFiles || {})) {
    const remove = names.filter((n) => left.has(n));
    if (remove.length === 0) {
      continue;
    }
    if (remove.length === names.length) {
      dropped.push(fileName);
    } else {
      filtered.set(fileName, remove);
    }
  }
  return { dropped, filtered };
}

// rel prefixes (relative to the plugin folder) of the parts that are not part of the selection: the folder of a skill,
// the file of any other item, and the MCP files whose every server is left out (an MCP server is no file of its own).
function excludedPrefixes(plugin, includedIds, droppedMcp) {
  const included = new Set(includedIds);
  const prefixes = [];
  for (const c of plugin.children) {
    if (included.has(c.id) || c.kind === 'mcp' || c.kind === 'hooks') {
      continue;
    }
    const target = c.kind === 'skill' ? path.dirname(c.file) : c.file;
    prefixes.push(path.relative(plugin.dir, target).split(path.sep).join('/'));
  }
  return [...prefixes, ...droppedMcp];
}

// rel prefixes of the selected skills, rules, commands and agents (the folder of a skill, the file of any other item).
function selectedPrefixes(plugin, includedIds) {
  const included = new Set(includedIds);
  return plugin.children
    .filter((c) => included.has(c.id) && c.kind !== 'mcp')
    .map((c) => path.relative(plugin.dir, c.kind === 'skill' ? path.dirname(c.file) : c.file).split(path.sep).join('/'));
}

// Content hashes by full path, so a sync reads only the files whose stat changed. A copy keeps the source's mtime and
// ctime on Windows, so birthtime and ino are part of the key; two writes within one clock tick share their timestamps,
// so a file changed less than racyMs ago is never cached.
const hashCache = { racyMs: 2000, entries: new Map() };

function statKey(st) {
  return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.birthtimeMs}:${st.ino}`;
}

function hashFile(full) {
  const key = path.resolve(full);
  let before = null;
  try {
    before = fs.statSync(full);
  } catch {
    // no caching: reading the file below reports the error as before
  }
  if (!before) {
    return crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
  }
  const beforeKey = statKey(before);
  const cached = hashCache.entries.get(key);
  if (cached && cached.stat === beforeKey) {
    return cached.hash;
  }
  const hash = crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex');
  let after = null;
  try {
    after = fs.statSync(full);
  } catch {
    // not cached
  }
  if (after && statKey(after) === beforeKey && Date.now() - Math.max(before.mtimeMs, before.ctimeMs) > hashCache.racyMs) {
    hashCache.entries.set(key, { stat: beforeKey, hash });
  } else {
    hashCache.entries.delete(key);
  }
  return hash;
}

function forget(full) {
  hashCache.entries.delete(path.resolve(full));
}

// The record of the last sync, <holderDir>/.team-plugins-sync.json:
//   v2: { version: 2, syncedAt, files: { rel: sha1 of the content at the last sync ("" = unknown) }, conflicts: [rel],
//         foldCase?: true (the last sync compared paths without case: one side looks names up without case) }
//   v1 (old): { syncedAt, files: [rel] }
// Returns { version: 2, files, conflicts, foldCase }, { version: 1, syncedAt, list } or null (missing or unreadable).
// Never throws.
function readManifest(holderDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(holderDir, MANIFEST), 'utf8'));
    if (m && m.version === 2 && m.files && typeof m.files === 'object' && !Array.isArray(m.files) && Array.isArray(m.conflicts)) {
      return { version: 2, files: m.files, conflicts: m.conflicts, foldCase: m.foldCase === true };
    }
    if (m && typeof m.syncedAt === 'number' && Array.isArray(m.files)) {
      return { version: 1, syncedAt: m.syncedAt, list: m.files };
    }
  } catch {
    // none yet, or unreadable
  }
  return null;
}

function sortedFiles(files) {
  const out = {};
  for (const rel of Object.keys(files).sort()) {
    out[rel] = files[rel];
  }
  return out;
}

// Atomic: written to a temporary file and renamed over the record, so a crash never leaves half a record. On Windows
// the rename fails with EPERM while another process has the record open: retried a few times, then given up (returns
// false; a lost write is harmless, files already equal on both sides are settled by content at the next sync).
function writeManifest(holderDir, files, conflicts, foldCase = false) {
  const target = path.join(holderDir, MANIFEST);
  const tmp = path.join(holderDir, `${MANIFEST}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const data = {
    version: 2,
    syncedAt: Date.now(),
    files: sortedFiles(files),
    conflicts: [...conflicts].sort(),
    ...(foldCase ? { foldCase: true } : {}),
  };
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    for (let attempt = 1; ; attempt++) {
      try {
        fs.renameSync(tmp, target);
        return true;
      } catch (err) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
          throw err;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignored
    }
    return false;
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  forget(to);
}

function writeText(to, text) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, text);
  forget(to);
}

const MCP_LEFT_OUT = 'MCP servers left out of the selection: an edit in the copy never reaches the repository';

// Deletes a file and the folders it leaves empty, up to but excluding root.
function deleteFile(file, root) {
  fs.rmSync(file, { force: true });
  forget(file);
  let dir = path.dirname(file);
  const stop = path.resolve(root);
  while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop + path.sep)) {
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) {
        break; // a link folder is never removed
      }
      if (fs.readdirSync(dir).length > 0) {
        break;
      }
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

// Renames `from` to `to` (paths that differ only in case) through an intermediate name: a direct rename may be a no-op
// or fail on Windows.
function renameCase(from, to) {
  const mid = `${from}.team-plugins-case-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.renameSync(from, mid);
  try {
    fs.renameSync(mid, to);
  } catch (err) {
    try {
      fs.renameSync(mid, from);
    } catch {
      // the first error is the one to report
    }
    throw err;
  }
  forget(from);
  forget(to);
}

// Makes the on-disk spelling of the existing path `wantRel` below `root` equal `wantRel`, part by part from the top.
// Returns true when something was renamed; throws when a part can't be found or renamed.
function alignSpelling(root, wantRel) {
  const parts = wantRel.split('/');
  let renamed = false;
  for (let i = 0; i < parts.length; i++) {
    const dir = path.join(root, ...parts.slice(0, i));
    const matches = fs.readdirSync(dir).filter((n) => n.toLowerCase() === parts[i].toLowerCase());
    if (matches.length !== 1) {
      throw new Error(`cannot find ${parts.slice(0, i + 1).join('/')}`);
    }
    if (matches[0] !== parts[i]) {
      renameCase(path.join(dir, matches[0]), path.join(dir, parts[i]));
      renamed = true;
    }
  }
  return renamed;
}

const DUPLICATE_CASE = 'another file has the same name in another case: left out';
const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);

// Keeps the partial copy <holderDir>/<plugin folder> and the plugin folder of the repository in step both ways, so an
// edit made in the copy (where Cursor registered the plugin) reaches the repository. Decides by content: the record
// holds the hash of each file at the last sync (the base); a file changed on one side only goes to the other, a file
// changed on both sides is a conflict and neither side is touched. Returns the copy root (the path to register), what
// was done: [{ action: 'toCopy' | 'toSource' | 'deletedInCopy' | 'deletedInSource', rel }], the conflicts:
// [{ rel, source, copy }] (either path may not exist: a deletion on one side) and what was left out of the sync:
// [{ rel, reason }] (links that listFiles does not follow, folders it can't list, with `unreadable: true`, and files
// of the copy below a skill or rule that is not in the selection, which never reach the repository; neither side of
// such a path is touched, and nothing below an unreadable folder is decided). An MCP file with some
// servers left out is generated in the copy (the repository's file without them) and only goes from the repository to
// the copy: an edit or deletion there never reaches the repository.
// On a case-insensitive filesystem (`caseInsensitive`) paths that differ only in case are one file: everything is
// compared by the lower-cased path, and a spelling that differs between the sides is carried by a rename (`renamedInSource`
// / `renamedInCopy` actions) in the direction the record tells (the side whose spelling differs from the record's was
// renamed), else reported in `notes`: [{ rel, reason }]. A conflict below a folder that was left out stays in the record.
function syncCopy(plugin, includedIds, holderDir, hooksDisabled = false) {
  const base = plugin.folder || path.basename(plugin.dir);
  const copyRoot = copyRootOf(plugin, holderDir);
  const plan = mcpPlan(plugin, includedIds);
  const suppress = suppressHooks(plugin, includedIds, hooksDisabled);
  const hooks = plugin.children.find((c) => c.kind === 'hooks' && includedIds.includes(c.id));
  const hookFile = hooks && path.relative(plugin.dir, hooks.file).split(path.sep).join('/');
  const insensitiveSource = caseInsensitive(plugin.dir);
  const sourceKeyOf = insensitiveSource ? lower : identity;
  const selectedHookFile = (rel) => hookFile && sourceKeyOf(hookFile) === sourceKeyOf(rel);
  const sharedMcp = plan.dropped.find(selectedHookFile);
  if (sharedMcp) {
    // A custom hook config can also hold MCP servers. Filter the servers while retaining the file for Hooks.
    plan.filtered.set(sharedMcp, plugin.mcpFiles[sharedMcp]);
  }
  const prefixes = excludedPrefixes(plugin, includedIds, plan.dropped);
  const selected = selectedPrefixes(plugin, includedIds);
  let keyOf = identity; // set below, once the copy exists: where case does not count, paths are compared lower-cased
  const generate = (rel) => filterMcpJson(fs.readFileSync(path.join(plugin.dir, rel), 'utf8'), plan.filtered.get(rel));
  const defaultHook = (rel) => suppress && keyOf(rel) === keyOf(DEFAULT_FILE);
  const hookManifest = (rel) => suppress && MANIFEST_FILES.some((name) => keyOf(rel) === keyOf(name));
  const hookSource = (rel) => defaultHook(rel) || hookManifest(rel);
  // An excluded prefix matches without case too, except one that a selected item also matches without case (a
  // case-sensitive repository may hold both `skills/UP` and `skills/up`): that one matches only its exact spelling.
  const excluded = (rel) => {
    if (selectedHookFile(rel)) {
      return false;
    }
    return prefixes.some((x) => {
      if (rel === x || rel.startsWith(`${x}/`)) {
        return true;
      }
      const k = keyOf(rel);
      const kx = keyOf(x);
      return (k === kx || k.startsWith(`${kx}/`)) && !selected.some((y) => keyOf(y) === kx);
    });
  };
  const source = () => {
    const listed = listFiles(plugin.dir, { root: plugin.repoDir || plugin.dir });
    for (const rel of [...listed.files.keys()]) {
      if (excluded(rel)) {
        listed.files.delete(rel);
      }
    }
    // no warning for the parts that are not selected
    const unreadable = listed.unreadable
      .filter((u) => !excluded(u.rel) || (hookFile && belowFolder(keyOf(hookFile), keyOf(u.rel))))
      .map((u) => ({ rel: u.rel, reason: `folder can't be read in the repository (${u.code})`, unreadable: true }));
    return { files: listed.files, skipped: [...listed.skipped.filter((s) => !excluded(s.rel)), ...unreadable] };
  };

  // only a missing copy folder is rebuilt: an unreadable record never deletes a copy that may hold unsynced edits
  if (!fs.existsSync(copyRoot)) {
    if (fs.existsSync(holderDir)) {
      removeTree(holderDir);
    }
    fs.mkdirSync(path.dirname(holderDir), { recursive: true });
    const tmp = `${holderDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.mkdirSync(path.join(tmp, base), { recursive: true });
    const firstFold = insensitiveSource || caseInsensitive(path.join(tmp, base));
    keyOf = firstFold ? lower : identity;
    const listed = source();
    // two source files that one copy file would hold (names that differ only in case): both are left out, as below
    const byLower = new Map();
    for (const rel of listed.files.keys()) {
      byLower.set(lower(rel), [...(byLower.get(lower(rel)) || []), rel]);
    }
    const dups = firstFold ? [...byLower.values()].filter((rels) => rels.length > 1).flat() : [];
    const filteredFirst = new Map([...plan.filtered.keys()].map((name) => [sourceKeyOf(name), name]));
    const hashes = {};
    for (const [rel, full] of listed.files) {
      if (dups.includes(rel)) {
        continue;
      }
      const stripDefault = defaultHook(rel);
      const hookless = hookSource(rel)
        ? (stripDefault ? withoutDefaultHooks : withoutHooks)(fs.readFileSync(full, 'utf8')) : null;
      if (stripDefault && hookless === null) {
        continue;
      }
      const filteredMcp = filteredFirst.get(sourceKeyOf(rel));
      if (hookless !== null) {
        writeText(path.join(tmp, base, rel), hookless);
      } else if (filteredMcp) {
        writeText(path.join(tmp, base, rel), generate(filteredMcp));
      } else {
        copyFile(full, path.join(tmp, base, rel));
      }
      // the record holds what the copy contains: a source change during the build goes to the copy at the next sync,
      // never back to the source
      hashes[rel] = hashFile(path.join(tmp, base, rel));
    }
    writeManifest(tmp, hashes, [], firstFold);
    try {
      fs.renameSync(tmp, holderDir);
      const skipped = [...listed.skipped, ...dups.map((rel) => ({ rel, reason: DUPLICATE_CASE }))].sort(byRel);
      return { copyRoot, actions: [], conflicts: [], skipped, notes: [] };
    } catch (err) {
      removeTree(tmp);
      if (!fs.existsSync(copyRoot)) {
        throw err;
      }
      // another process built it meanwhile: whatever its record holds, the sync below copes
    }
  }

  const m = readManifest(holderDir);
  const insensitiveCopy = caseInsensitive(copyRoot);
  const fold = insensitiveSource || insensitiveCopy; // paths that differ only in case are one file
  const carry = insensitiveSource && insensitiveCopy; // a spelling may be carried by a rename
  keyOf = fold ? lower : identity;
  const filteredByKey = new Map([...plan.filtered.keys()].map((n) => [keyOf(n), n]));

  // Both sides as maps key -> { rel, full }, what was left out of the sync and the keys that two files of one side
  // share (possible on a case-sensitive side only: both are left out).
  let src;
  let copy;
  let skipped;
  let isSkipped;
  const dupSkipped = [];
  const scan = () => {
    const srcListed = source();
    const copyListed = listFiles(copyRoot);
    const copyUnreadable = copyListed.unreadable.map((u) => ({
      rel: u.rel,
      reason: `folder can't be read in the partial copy (${u.code})`,
      unreadable: true,
    }));
    const dupKeys = new Set();
    dupSkipped.length = 0;
    const toMap = (files) => {
      const map = new Map();
      const rels = new Map();
      for (const [rel, full] of files) {
        const k = keyOf(rel);
        if (map.has(k)) {
          dupKeys.add(k);
        } else {
          map.set(k, { rel, full });
        }
        rels.set(k, [...(rels.get(k) || []), rel]);
      }
      for (const k of dupKeys) {
        for (const rel of rels.get(k) || []) {
          if (!dupSkipped.some((d) => d.rel === rel)) {
            dupSkipped.push({ rel, reason: DUPLICATE_CASE });
          }
        }
      }
      return map;
    };
    src = toMap(srcListed.files);
    copy = toMap(copyListed.files);
    const skippedByKey = new Map();
    for (const s of [...srcListed.skipped, ...copyListed.skipped, ...copyUnreadable]) {
      if (!skippedByKey.has(keyOf(s.rel))) {
        skippedByKey.set(keyOf(s.rel), s);
      }
    }
    skipped = [...skippedByKey.values()].sort(byRel);
    isSkipped = (key) => skipped.some((s) => belowFolder(key, keyOf(s.rel))) || dupKeys.has(key);
  };
  scan();

  // The record by key: { rel (its spelling), hash, ambiguous }. Two entries with one key (a record written where case
  // counted) keep the first rel in sorted order, an unknown hash unless both agree, and never decide a spelling.
  const baseOf = new Map();
  const addBase = (rel, hash) => {
    const k = keyOf(rel);
    const old = baseOf.get(k);
    if (!old) {
      baseOf.set(k, { rel, hash, ambiguous: false });
    } else {
      baseOf.set(k, { rel: old.rel, hash: old.hash === hash ? hash : '', ambiguous: old.ambiguous || old.rel !== rel });
    }
  };
  if (m && m.version === 2) {
    for (const rel of Object.keys(m.files).sort()) {
      addBase(rel, m.files[rel]);
    }
  } else if (m) {
    // v1 record: a file not modified since the last sync still has its synced content, any other has an unknown base
    for (const rel of m.list) {
      const entry = copy.get(keyOf(rel)) || src.get(keyOf(rel));
      if (entry) {
        addBase(rel, fs.statSync(entry.full).mtimeMs <= m.syncedAt ? hashFile(entry.full) : '');
      }
    }
  } else {
    for (const entry of [...src.values(), ...copy.values()]) {
      addBase(entry.rel, '');
    }
  }
  const oldConflicts = m && m.version === 2 ? m.conflicts : [];
  const oldConflictKeys = new Set(oldConflicts.map(keyOf));

  const actions = [];
  const conflicts = [];
  const keptConflicts = [];
  const notes = [];
  const excludedSkipped = [];
  const newBase = {};
  const setBase = (rel, hash) => {
    if (hash !== undefined) {
      newBase[rel] = hash;
    }
  };

  // Spelling: a file or folder that is spelled differently on the two sides (a case-only rename on one of them) gets
  // the spelling of the side that was renamed, which the record tells (it holds the spelling of the last sync).
  let attempted = false;
  for (const key of [...src.keys()].sort()) {
    const s = src.get(key);
    const c = copy.get(key);
    if (!c || c.rel === s.rel || excluded(s.rel) || isSkipped(key) || filteredByKey.has(key) || hookSource(s.rel)) {
      continue;
    }
    const b = baseOf.get(key);
    const spelled = `spelled ${s.rel} in the repository and ${c.rel} in the partial copy: rename one of them so both match`;
    let toRoot = null;
    let want;
    let action;
    if (carry && b && !b.ambiguous && b.rel === s.rel) {
      [toRoot, want, action] = [plugin.dir, c.rel, 'renamedInSource'];
    } else if (carry && b && !b.ambiguous && b.rel === c.rel) {
      [toRoot, want, action] = [copyRoot, s.rel, 'renamedInCopy'];
    }
    if (!toRoot) {
      notes.push({ rel: c.rel, reason: spelled });
      continue;
    }
    attempted = true;
    try {
      if (alignSpelling(toRoot, want)) {
        actions.push({ action, rel: want });
      }
    } catch (err) {
      notes.push({
        rel: c.rel,
        reason: `spelled ${s.rel} in the repository: the rename to match failed (${err.code || err.message})`,
      });
    }
  }
  if (attempted) {
    scan();
  }

  const storedConflict = (key) => oldConflicts.find((x) => keyOf(x) === key);
  const keys = new Set([...src.keys(), ...copy.keys(), ...baseOf.keys(), ...oldConflictKeys]);
  const shownRel = (key) => (src.get(key) || copy.get(key) || baseOf.get(key) || {}).rel ?? storedConflict(key);
  for (const key of [...keys].sort((a, b) => byRel({ rel: shownRel(a) }, { rel: shownRel(b) }))) {
    const sEnt = src.get(key);
    const cEnt = copy.get(key);
    const baseEnt = baseOf.get(key);
    const sFile = sEnt && sEnt.full;
    const cFile = cEnt && cEnt.full;
    const rel = shownRel(key);
    if (excluded(rel)) {
      // never written to the repository: the selection leaves this path out
      if (cFile) {
        const eb = baseEnt ? baseEnt.hash : undefined;
        if (eb && hashFile(cFile) === eb) {
          deleteFile(cFile, copyRoot); // synced earlier, unchanged since: the repository keeps it, the copy drops it
          actions.push({ action: 'deletedInCopy', rel: cEnt.rel });
        } else {
          excludedSkipped.push({ rel: cEnt.rel, reason: 'not in the selection: never copied to the repository' });
        }
      }
      continue; // no record entry
    }
    if (isSkipped(key)) {
      // neither side is touched, and the record keeps what it had (a conflict too: a complete scan will judge it)
      if (baseEnt) {
        setBase(baseEnt.rel, baseEnt.hash);
      }
      if (oldConflictKeys.has(key)) {
        keptConflicts.push(storedConflict(key));
      }
      continue;
    }
    if (hookSource(rel)) {
      const stripDefault = defaultHook(rel);
      const sourceText = sFile ? fs.readFileSync(sFile, 'utf8') : null;
      const hookless = sourceText === null ? null : (stripDefault ? withoutDefaultHooks : withoutHooks)(sourceText);
      const copyText = cFile ? fs.readFileSync(cFile, 'utf8') : null;
      if (stripDefault || hookless !== null || (copyText !== null && withoutHooks(copyText) !== null)) {
        const wanted = stripDefault ? hookless : hookless ?? sourceText;
        if (wanted === null && cFile) {
          deleteFile(cFile, copyRoot);
          actions.push({ action: 'deletedInCopy', rel: cEnt.rel });
        } else if (wanted !== null) {
          const target = cEnt ? cEnt.rel : sEnt.rel;
          if (wanted !== copyText) {
            writeText(path.join(copyRoot, target), wanted);
            actions.push({ action: 'toCopy', rel: target });
          }
          setBase(target, crypto.createHash('sha1').update(wanted).digest('hex'));
        }
        continue;
      }
    }
    if (filteredByKey.has(key)) {
      // generated in the copy, repository -> copy only; the copy's file is replaced only while it still is what was
      // last written (or is missing)
      const name = filteredByKey.get(key);
      const fb = baseEnt ? baseEnt.hash : undefined;
      const fc = cFile ? hashFile(cFile) : undefined;
      const keep = () => {
        excludedSkipped.push({ rel: name, reason: MCP_LEFT_OUT });
        setBase(name, fb);
      };
      if (!sFile) {
        if (cFile) {
          if (fb && fc === fb) {
            deleteFile(cFile, copyRoot);
            actions.push({ action: 'deletedInCopy', rel: name });
          } else {
            keep();
          }
        }
        continue;
      }
      const text = generate(name);
      const g = crypto.createHash('sha1').update(text).digest('hex');
      if (!cFile || fc === g || (fb && fc === fb)) {
        if (fc !== g) {
          writeText(path.join(copyRoot, cEnt ? cEnt.rel : name), text);
          actions.push({ action: 'toCopy', rel: name });
        }
        setBase(name, g);
      } else {
        keep();
      }
      continue;
    }
    const s = sFile ? hashFile(sFile) : undefined;
    const c = cFile ? hashFile(cFile) : undefined;
    const b = baseEnt ? baseEnt.hash : undefined;
    // a new file is written in the other side's spelling; the record spells a path as the repository does
    const sPath = path.join(plugin.dir, sEnt ? sEnt.rel : cEnt ? cEnt.rel : rel);
    const cPath = path.join(copyRoot, cEnt ? cEnt.rel : sEnt ? sEnt.rel : rel);
    const recordRel = sEnt ? sEnt.rel : cEnt ? cEnt.rel : rel;
    const toCopy = () => {
      if (s !== undefined) {
        copyFile(sFile, cPath);
        actions.push({ action: 'toCopy', rel });
      } else {
        deleteFile(cFile, copyRoot);
        actions.push({ action: 'deletedInCopy', rel });
      }
      setBase(recordRel, s);
    };
    const toSource = () => {
      if (c !== undefined) {
        copyFile(cFile, sPath);
        actions.push({ action: 'toSource', rel });
      } else {
        deleteFile(sFile, plugin.dir);
        actions.push({ action: 'deletedInSource', rel });
      }
      setBase(recordRel, c);
    };
    const conflict = (keptBase) => {
      conflicts.push({ rel, source: sPath, copy: cPath });
      setBase(recordRel, keptBase);
    };
    if (s === c) {
      setBase(rel, s);
    } else if (b === '') {
      if (s === undefined) {
        toSource();
      } else if (c === undefined) {
        toCopy();
      } else {
        conflict('');
      }
    } else if (c === b) {
      toCopy();
    } else if (s === b) {
      toSource();
    } else {
      conflict(b);
    }
  }

  const conflictRels = [...conflicts.map((x) => x.rel), ...keptConflicts].sort();
  const unchanged =
    m &&
    m.version === 2 &&
    JSON.stringify(sortedFiles(m.files)) === JSON.stringify(sortedFiles(newBase)) &&
    JSON.stringify([...m.conflicts].sort()) === JSON.stringify(conflictRels) &&
    m.foldCase === fold;
  if (actions.length > 0 || !unchanged) {
    writeManifest(holderDir, newBase, conflictRels, fold);
  }
  const allSkipped = [...skipped, ...dupSkipped, ...excludedSkipped].sort(byRel);
  return { copyRoot, actions, conflicts, skipped: allSkipped, notes: notes.sort(byRel) };
}

function checkConflictRel(rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error('invalid conflict file');
  }
}

// The path of rel below root as it is on disk. Without `fold` it is rel joined to root. With it, each part is looked up
// without case; from the first part that is missing the rest is joined as given. A folder that can't be listed (any
// error but ENOENT/ENOTDIR), or two entries that match a part without case (a case-sensitive folder): throws, never
// guesses.
function findPath(root, rel, fold) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!fold) {
    return path.join(root, ...parts);
  }
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return path.join(dir, ...parts.slice(i)); // not there: the rest is missing too
      }
      // a folder that can't be listed may hold the file under another spelling: never read it as missing
      throw new Error(`${parts.slice(0, i).join('/') || '.'} can't be read (${err.code || err.message})`);
    }
    const matches = names.filter((n) => lower(n) === lower(parts[i]));
    if (matches.length === 0) {
      return path.join(dir, ...parts.slice(i));
    }
    if (matches.length > 1) {
      // picking one (even the exact spelling) could miss the file under the other and read it as deleted
      throw new Error(`${parts.slice(0, i + 1).join('/')} matches several names that differ only in case`);
    }
    dir = path.join(dir, matches[0]);
  }
  return dir;
}

// Whether conflicts of this copy compare paths without case: as the last sync did (its record), or as either side
// looks names up now.
function conflictFold(plugin, holderDir, m) {
  return (m && m.foldCase) || caseInsensitive(plugin.dir) || caseInsensitive(copyRootOf(plugin, holderDir));
}

// The actual paths of a conflicting file on both sides: { src, cp } (either may not exist).
function conflictPaths(plugin, holderDir, rel, fold) {
  return { src: findPath(plugin.dir, rel, fold), cp: findPath(copyRootOf(plugin, holderDir), rel, fold) };
}

// The two versions of a conflicting file as the user sees them: { source, copy }, each the sha1 (hex) of that side's
// file or null when it does not exist. Taken before the dialog and handed to resolveConflict, which applies the choice
// only if both still are what was shown. Each side's file is found as it is spelled on that side.
function conflictVersions(plugin, holderDir, rel) {
  checkConflictRel(rel);
  // only a file that is not there is a deletion: one that can't be read (access denied...) stops the choice
  const of = (file, side) => {
    try {
      return hashFile(file);
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        return null;
      }
      throw new Error(`the ${side} version of ${rel} can't be read (${err.code || err.message})`);
    }
  };
  const { src, cp } = conflictPaths(plugin, holderDir, rel, conflictFold(plugin, holderDir, readManifest(holderDir)));
  return { source: of(src, 'repository'), copy: of(cp, 'partial copy') };
}

// Takes one side of a conflict found by syncCopy: keep 'source' (the repository's version) or 'copy' (the partial
// copy's). A side that does not exist (a deletion) is kept as a deletion. `shown` is what conflictVersions returned
// when the choice was offered: if the conflict is gone from the record (another window resolved it) or a side no longer
// has the version shown, nothing is written and { changed: true, rel } is returned. Otherwise returns { action, rel }.
function resolveConflict(plugin, holderDir, rel, keep, shown) {
  checkConflictRel(rel);
  if (keep !== 'source' && keep !== 'copy') {
    throw new Error('keep must be "source" or "copy"');
  }
  const isVersion = (v) => v === null || typeof v === 'string';
  if (!shown || typeof shown !== 'object' || !isVersion(shown.source) || !isVersion(shown.copy)) {
    throw new Error('the versions shown are missing');
  }
  const copyRoot = copyRootOf(plugin, holderDir);
  const m = readManifest(holderDir);
  if (!m || m.version !== 2) {
    throw new Error('the partial copy has no sync record');
  }
  const fold = conflictFold(plugin, holderDir, m);
  const keyOf = fold ? lower : identity;
  const { src, cp } = conflictPaths(plugin, holderDir, rel, fold);
  if (!m.conflicts.some((x) => keyOf(x) === keyOf(rel))) {
    return { changed: true, rel };
  }
  const now = conflictVersions(plugin, holderDir, rel);
  if (now.source !== shown.source || now.copy !== shown.copy) {
    return { changed: true, rel };
  }
  const [from, to, toRoot, copied, deleted] =
    keep === 'source'
      ? [src, cp, copyRoot, 'toCopy', 'deletedInCopy']
      : [cp, src, plugin.dir, 'toSource', 'deletedInSource'];
  let action;
  const files = {};
  for (const [k, v] of Object.entries(m.files)) {
    if (keyOf(k) !== keyOf(rel)) {
      files[k] = v;
    }
  }
  // decided from the versions just checked (`now`), never from a second look that could read an error as absence
  const [kept, replaced] = keep === 'source' ? [now.source, now.copy] : [now.copy, now.source];
  if (kept !== null) {
    copyFile(from, to);
    action = copied;
    files[rel] = kept;
  } else {
    if (replaced !== null) {
      deleteFile(to, toRoot);
    }
    action = deleted;
  }
  writeManifest(holderDir, files, m.conflicts.filter((x) => keyOf(x) !== keyOf(rel)), m.foldCase);
  return { action, rel };
}

// Called after the repository was reset to the team version: the next syncCopy then takes the repository's side for
// every difference, except the conflicts, which stay conflicts (a copy version that never reached the repository is
// not lost). Nothing is deleted here: on Windows a folder Cursor watches cannot be removed (EPERM).
function markCopySynced(holderDir) {
  const copyDir = fs.existsSync(holderDir)
    ? fs.readdirSync(holderDir, { withFileTypes: true }).find((e) => e.isDirectory())
    : null;
  if (!copyDir) {
    return false;
  }
  const m = readManifest(holderDir);
  const conflicts = m && m.version === 2 ? m.conflicts : [];
  const old = m && m.version === 2 ? m.files : {};
  const copyFolder = path.join(holderDir, copyDir.name);
  // as the last sync compared (the repository may look names up without case while the copy does not)
  const foldCase = (m && m.version === 2 && m.foldCase) || caseInsensitive(copyFolder);
  const keyOf = foldCase ? lower : identity;
  const listed = listFiles(copyFolder);
  const files = listed.files;
  const conflictKeys = new Set(conflicts.map(keyOf));
  const oldByKey = new Map(Object.keys(old).map((rel) => [keyOf(rel), rel]));
  const listedKeys = new Set([...files.keys()].map(keyOf));
  const newBase = {};
  const newKeys = new Set();
  const keep = (rel) => {
    newBase[rel] = old[rel];
    newKeys.add(keyOf(rel));
  };
  for (const [rel, full] of files) {
    const k = keyOf(rel);
    if (conflictKeys.has(k)) {
      // the record's own spelling stays, so the next sync still finds the entry
      if (oldByKey.has(k)) {
        keep(oldByKey.get(k));
      }
    } else {
      newBase[rel] = hashFile(full);
      newKeys.add(k);
    }
  }
  for (const rel of conflicts) {
    const k = keyOf(rel);
    if (!listedKeys.has(k) && !newKeys.has(k) && oldByKey.has(k)) {
      keep(oldByKey.get(k));
    }
  }
  // what is below a folder that can't be listed was not seen: its record entries stay
  for (const rel of Object.keys(old)) {
    if (!newKeys.has(keyOf(rel)) && listed.unreadable.some((u) => belowFolder(keyOf(rel), keyOf(u.rel)))) {
      keep(rel);
    }
  }
  writeManifest(holderDir, newBase, conflicts, foldCase);
  return true;
}

function gcFiltered(filteredRoot, keepPaths, maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(filteredRoot);
  } catch {
    return [];
  }
  const keep = new Set(keepPaths.map((p) => path.resolve(p)));
  const removed = [];
  for (const name of names) {
    const full = path.join(filteredRoot, name);
    if (keep.has(path.resolve(full))) {
      continue;
    }
    let mtime;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      continue;
    }
    const age = now - mtime;
    if (age > maxAgeMs || (name.includes('.tmp-') && age > 60 * 60 * 1000)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch {
        // ignored
      }
    }
  }
  return removed;
}

module.exports = {
  holderName,
  copyRootOf,
  syncCopy,
  markCopySynced,
  resolveConflict,
  conflictVersions,
  gcFiltered,
  hashCache,
  caseInsensitive,
};
