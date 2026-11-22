'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { removeTree } = require('./sync');

const MANIFEST = '.team-plugins-sync.json';

// rel (with '/') -> full path of every file below dir, skipping .git folders.
function listFiles(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === '.git') {
      continue;
    }
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      listFiles(full, r, out);
    } else {
      out.set(r, full);
    }
  }
  return out;
}

// The folder name of a partial copy: plugin name and selection, not the files (the copy keeps its path while its files
// change, so an agent editing it keeps writing to a registered folder).
function holderName(plugin, includedIds) {
  const hash = crypto
    .createHash('sha1')
    .update(`${plugin.name}\n${[...includedIds].sort().join('\n')}`)
    .digest('hex')
    .slice(0, 12);
  return `${plugin.name}-${hash}`;
}

// rel prefixes (relative to the plugin folder) of the skills and rules that are not part of the selection.
function excludedPrefixes(plugin, includedIds) {
  const included = new Set(includedIds);
  const prefixes = [];
  for (const c of plugin.children) {
    if (included.has(c.id)) {
      continue;
    }
    const target = c.kind === 'skill' ? path.dirname(c.file) : c.file;
    prefixes.push(path.relative(plugin.dir, target).split(path.sep).join('/'));
  }
  return prefixes;
}

function readManifest(holderDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(holderDir, MANIFEST), 'utf8'));
    if (m && typeof m.syncedAt === 'number' && Array.isArray(m.files)) {
      return m;
    }
  } catch {
    // none yet
  }
  return null;
}

function writeManifest(holderDir, files) {
  fs.writeFileSync(path.join(holderDir, MANIFEST), JSON.stringify({ syncedAt: Date.now(), files }));
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// Deletes a file and the folders it leaves empty, up to but excluding root.
function deleteFile(file, root) {
  fs.rmSync(file, { force: true });
  let dir = path.dirname(file);
  const stop = path.resolve(root);
  while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop + path.sep)) {
    try {
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

// Keeps the partial copy <holderDir>/<plugin folder> and the plugin folder of the repository in step both ways, so an
// edit made in the copy (where Cursor registered the plugin) reaches the repository. Returns the copy root (the path to
// register) and what was done: [{ action: 'toCopy' | 'toSource' | 'deletedInCopy' | 'deletedInSource', rel }].
function syncCopy(plugin, includedIds, holderDir) {
  const base = path.basename(plugin.dir);
  const copyRoot = path.join(holderDir, base);
  const prefixes = excludedPrefixes(plugin, includedIds);
  const source = () => {
    const all = listFiles(plugin.dir, '', new Map());
    for (const rel of [...all.keys()]) {
      if (prefixes.some((x) => rel === x || rel.startsWith(`${x}/`))) {
        all.delete(rel);
      }
    }
    return all;
  };

  // a manifest without its copy folder is stale: syncing it would read the missing files as deletions
  let manifest = fs.existsSync(copyRoot) ? readManifest(holderDir) : null;
  if (!manifest) {
    if (fs.existsSync(holderDir)) {
      removeTree(holderDir);
    }
    fs.mkdirSync(path.dirname(holderDir), { recursive: true });
    const tmp = `${holderDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const files = source();
    for (const [rel, full] of files) {
      copyFile(full, path.join(tmp, base, rel));
    }
    writeManifest(tmp, [...files.keys()].sort());
    try {
      fs.renameSync(tmp, holderDir);
      return { copyRoot, actions: [] };
    } catch (err) {
      removeTree(tmp);
      if (!fs.existsSync(holderDir)) {
        throw err;
      }
      manifest = readManifest(holderDir);
      if (!manifest) {
        throw err;
      }
    }
  }

  const src = source();
  const copy = listFiles(copyRoot, '', new Map());
  const known = new Set(manifest.files);
  const actions = [];
  for (const rel of [...new Set([...src.keys(), ...copy.keys()])].sort()) {
    const s = src.get(rel);
    const c = copy.get(rel);
    if (s && c) {
      if (fs.readFileSync(s).equals(fs.readFileSync(c))) {
        continue;
      }
      if (fs.statSync(c).mtimeMs > manifest.syncedAt) {
        copyFile(c, s);
        actions.push({ action: 'toSource', rel });
      } else {
        copyFile(s, c);
        actions.push({ action: 'toCopy', rel });
      }
    } else if (s) {
      if (known.has(rel)) {
        deleteFile(s, plugin.dir);
        actions.push({ action: 'deletedInSource', rel });
      } else {
        copyFile(s, path.join(copyRoot, rel));
        actions.push({ action: 'toCopy', rel });
      }
    } else if (known.has(rel)) {
      deleteFile(c, copyRoot);
      actions.push({ action: 'deletedInCopy', rel });
    } else {
      copyFile(c, path.join(plugin.dir, rel));
      actions.push({ action: 'toSource', rel });
    }
  }
  if (actions.length > 0) {
    writeManifest(holderDir, [...listFiles(copyRoot, '', new Map()).keys()].sort());
  }
  return { copyRoot, actions };
}

// Marks the copy as synced now, so that the next syncCopy takes the repository's side for every difference: files
// changed in the copy are overwritten, files only in the copy are deleted. Used after the repository was reset to the
// team version. Nothing is deleted here: on Windows a folder Cursor watches cannot be removed (EPERM).
function markCopySynced(holderDir) {
  const copyRoot = fs.existsSync(holderDir)
    ? fs.readdirSync(holderDir, { withFileTypes: true }).find((e) => e.isDirectory())
    : null;
  if (!copyRoot || !readManifest(holderDir)) {
    return false;
  }
  writeManifest(holderDir, [...listFiles(path.join(holderDir, copyRoot.name), '', new Map()).keys()].sort());
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

module.exports = { holderName, syncCopy, markCopySynced, gcFiltered };
