'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { removeTree } = require('./sync');
const { filterMcpJson } = require('./catalog');

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

// The folder of a partial copy that Cursor registers: the plugin's folder name below the holder folder.
function copyRootOf(plugin, holderDir) {
  return path.join(holderDir, plugin.folder || path.basename(plugin.dir));
}

// The folder name of a partial copy: plugin name and selection, not the files (the copy keeps its path while its files
// change, so an agent editing it keeps writing to a registered folder). The name part is the plugin name with every
// character other than a letter, digit, '.', '_' and '-' replaced by '_', at most 64 characters, so it is always one safe
// folder name; the hash (of the real name and the selection) keeps two names that clean up the same apart.
function holderName(plugin, includedIds) {
  const hash = crypto
    .createHash('sha1')
    .update(`${plugin.name}\n${[...includedIds].sort().join('\n')}`)
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
function excludedPrefixes(plugin, includedIds) {
  const included = new Set(includedIds);
  const prefixes = [];
  for (const c of plugin.children) {
    if (included.has(c.id) || c.kind === 'mcp') {
      continue;
    }
    const target = c.kind === 'skill' ? path.dirname(c.file) : c.file;
    prefixes.push(path.relative(plugin.dir, target).split(path.sep).join('/'));
  }
  return [...prefixes, ...mcpPlan(plugin, includedIds).dropped];
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
//   v2: { version: 2, syncedAt, files: { rel: sha1 of the content at the last sync ("" = unknown) }, conflicts: [rel] }
//   v1 (old): { syncedAt, files: [rel] }
// Returns { version: 2, files, conflicts }, { version: 1, syncedAt, list } or null (missing or unreadable). Never throws.
function readManifest(holderDir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(holderDir, MANIFEST), 'utf8'));
    if (m && m.version === 2 && m.files && typeof m.files === 'object' && !Array.isArray(m.files) && Array.isArray(m.conflicts)) {
      return { version: 2, files: m.files, conflicts: m.conflicts };
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
function writeManifest(holderDir, files, conflicts) {
  const target = path.join(holderDir, MANIFEST);
  const tmp = path.join(holderDir, `${MANIFEST}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const data = { version: 2, syncedAt: Date.now(), files: sortedFiles(files), conflicts: [...conflicts].sort() };
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
function syncCopy(plugin, includedIds, holderDir) {
  const base = plugin.folder || path.basename(plugin.dir);
  const copyRoot = copyRootOf(plugin, holderDir);
  const prefixes = excludedPrefixes(plugin, includedIds);
  const plan = mcpPlan(plugin, includedIds);
  const generate = (rel) => filterMcpJson(fs.readFileSync(path.join(plugin.dir, rel), 'utf8'), plan.filtered.get(rel));
  const excluded = (rel) => prefixes.some((x) => rel === x || rel.startsWith(`${x}/`));
  const source = () => {
    const listed = listFiles(plugin.dir, { root: plugin.repoDir || plugin.dir });
    for (const rel of [...listed.files.keys()]) {
      if (excluded(rel)) {
        listed.files.delete(rel);
      }
    }
    // no warning for the parts that are not selected
    const unreadable = listed.unreadable
      .filter((u) => !excluded(u.rel))
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
    const listed = source();
    const hashes = {};
    for (const [rel, full] of listed.files) {
      if (plan.filtered.has(rel)) {
        writeText(path.join(tmp, base, rel), generate(rel));
      } else {
        copyFile(full, path.join(tmp, base, rel));
      }
      // the record holds what the copy contains: a source change during the build goes to the copy at the next sync,
      // never back to the source
      hashes[rel] = hashFile(path.join(tmp, base, rel));
    }
    writeManifest(tmp, hashes, []);
    try {
      fs.renameSync(tmp, holderDir);
      return { copyRoot, actions: [], conflicts: [], skipped: listed.skipped };
    } catch (err) {
      removeTree(tmp);
      if (!fs.existsSync(copyRoot)) {
        throw err;
      }
      // another process built it meanwhile: whatever its record holds, the sync below copes
    }
  }

  const m = readManifest(holderDir);
  const srcListed = source();
  const copyListed = listFiles(copyRoot);
  const src = srcListed.files;
  const copy = copyListed.files;
  const copyUnreadable = copyListed.unreadable.map((u) => ({
    rel: u.rel,
    reason: `folder can't be read in the partial copy (${u.code})`,
    unreadable: true,
  }));
  const skippedByRel = new Map();
  for (const s of [...srcListed.skipped, ...copyListed.skipped, ...copyUnreadable]) {
    if (!skippedByRel.has(s.rel)) {
      skippedByRel.set(s.rel, s);
    }
  }
  const skipped = [...skippedByRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const isSkipped = (rel) => skipped.some((s) => belowFolder(rel, s.rel));
  const baseOf = {};
  if (m && m.version === 2) {
    Object.assign(baseOf, m.files);
  } else if (m) {
    // v1 record: a file not modified since the last sync still has its synced content, any other has an unknown base
    for (const rel of m.list) {
      const full = copy.get(rel) || src.get(rel);
      if (full) {
        baseOf[rel] = fs.statSync(full).mtimeMs <= m.syncedAt ? hashFile(full) : '';
      }
    }
  } else {
    for (const rel of [...src.keys(), ...copy.keys()]) {
      baseOf[rel] = '';
    }
  }

  const actions = [];
  const conflicts = [];
  const excludedSkipped = [];
  const newBase = {};
  const setBase = (rel, hash) => {
    if (hash !== undefined) {
      newBase[rel] = hash;
    }
  };
  for (const rel of [...new Set([...src.keys(), ...copy.keys(), ...Object.keys(baseOf)])].sort()) {
    const sFile = src.get(rel);
    const cFile = copy.get(rel);
    if (excluded(rel)) {
      // never written to the repository: the selection leaves this path out
      if (cFile) {
        const eb = Object.prototype.hasOwnProperty.call(baseOf, rel) ? baseOf[rel] : undefined;
        if (eb && hashFile(cFile) === eb) {
          deleteFile(cFile, copyRoot); // synced earlier, unchanged since: the repository keeps it, the copy drops it
          actions.push({ action: 'deletedInCopy', rel });
        } else {
          excludedSkipped.push({ rel, reason: 'not in the selection: never copied to the repository' });
        }
      }
      continue; // no record entry
    }
    if (isSkipped(rel)) {
      // neither side is touched, and the record keeps what it had
      if (Object.prototype.hasOwnProperty.call(baseOf, rel)) {
        setBase(rel, baseOf[rel]);
      }
      continue;
    }
    if (plan.filtered.has(rel)) {
      // generated in the copy, repository -> copy only; the copy's file is replaced only while it still is what was
      // last written (or is missing)
      const fb = Object.prototype.hasOwnProperty.call(baseOf, rel) ? baseOf[rel] : undefined;
      const fc = cFile ? hashFile(cFile) : undefined;
      const keep = () => {
        excludedSkipped.push({ rel, reason: MCP_LEFT_OUT });
        setBase(rel, fb);
      };
      if (!sFile) {
        if (cFile) {
          if (fb && fc === fb) {
            deleteFile(cFile, copyRoot);
            actions.push({ action: 'deletedInCopy', rel });
          } else {
            keep();
          }
        }
        continue;
      }
      const text = generate(rel);
      const g = crypto.createHash('sha1').update(text).digest('hex');
      if (!cFile || fc === g || (fb && fc === fb)) {
        if (fc !== g) {
          writeText(path.join(copyRoot, rel), text);
          actions.push({ action: 'toCopy', rel });
        }
        setBase(rel, g);
      } else {
        keep();
      }
      continue;
    }
    const s = sFile ? hashFile(sFile) : undefined;
    const c = cFile ? hashFile(cFile) : undefined;
    const b = Object.prototype.hasOwnProperty.call(baseOf, rel) ? baseOf[rel] : undefined;
    const sPath = path.join(plugin.dir, rel);
    const cPath = path.join(copyRoot, rel);
    const toCopy = () => {
      if (s !== undefined) {
        copyFile(sFile, cPath);
        actions.push({ action: 'toCopy', rel });
      } else {
        deleteFile(cFile, copyRoot);
        actions.push({ action: 'deletedInCopy', rel });
      }
      setBase(rel, s);
    };
    const toSource = () => {
      if (c !== undefined) {
        copyFile(cFile, sPath);
        actions.push({ action: 'toSource', rel });
      } else {
        deleteFile(sFile, plugin.dir);
        actions.push({ action: 'deletedInSource', rel });
      }
      setBase(rel, c);
    };
    const conflict = (keptBase) => {
      conflicts.push({ rel, source: sPath, copy: cPath });
      setBase(rel, keptBase);
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

  const conflictRels = conflicts.map((x) => x.rel);
  const unchanged =
    m &&
    m.version === 2 &&
    JSON.stringify(sortedFiles(m.files)) === JSON.stringify(sortedFiles(newBase)) &&
    JSON.stringify([...m.conflicts].sort()) === JSON.stringify(conflictRels);
  if (actions.length > 0 || !unchanged) {
    writeManifest(holderDir, newBase, conflictRels);
  }
  const allSkipped = [...skipped, ...excludedSkipped].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { copyRoot, actions, conflicts, skipped: allSkipped };
}

function checkConflictRel(rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new Error('invalid conflict file');
  }
}

// The two versions of a conflicting file as the user sees them: { source, copy }, each the sha1 (hex) of that side's
// file or null when it does not exist. Taken before the dialog and handed to resolveConflict, which applies the choice
// only if both still are what was shown.
function conflictVersions(plugin, holderDir, rel) {
  checkConflictRel(rel);
  const of = (file) => (fs.existsSync(file) ? hashFile(file) : null);
  return { source: of(path.join(plugin.dir, rel)), copy: of(path.join(copyRootOf(plugin, holderDir), rel)) };
}

// Takes one side of a conflict found by syncCopy: keep 'source' (the repository's version) or 'copy' (the partial
// copy's). A side that does not exist (a deletion) is kept as a deletion. `shown` is what conflictVersions returned
// when the choice was offered: if the conflict is gone from the record (another window resolved it) or a side no longer
// has the version shown, nothing is written and { changed: true, rel } is returned. Otherwise returns { action, rel }.
function resolveConflict(plugin, includedIds, holderDir, rel, keep, shown) {
  checkConflictRel(rel);
  if (keep !== 'source' && keep !== 'copy') {
    throw new Error('keep must be "source" or "copy"');
  }
  const isVersion = (v) => v === null || typeof v === 'string';
  if (!shown || typeof shown !== 'object' || !isVersion(shown.source) || !isVersion(shown.copy)) {
    throw new Error('the versions shown are missing');
  }
  const copyRoot = copyRootOf(plugin, holderDir);
  const src = path.join(plugin.dir, rel);
  const cp = path.join(copyRoot, rel);
  const m = readManifest(holderDir);
  if (!m || m.version !== 2) {
    throw new Error('the partial copy has no sync record');
  }
  if (!m.conflicts.includes(rel)) {
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
  const files = { ...m.files };
  if (fs.existsSync(from)) {
    copyFile(from, to);
    action = copied;
    files[rel] = hashFile(from);
  } else {
    if (fs.existsSync(to)) {
      deleteFile(to, toRoot);
    }
    action = deleted;
    delete files[rel];
  }
  writeManifest(holderDir, files, m.conflicts.filter((x) => x !== rel));
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
  const listed = listFiles(path.join(holderDir, copyDir.name));
  const files = listed.files;
  const newBase = {};
  for (const [rel, full] of files) {
    if (conflicts.includes(rel)) {
      if (Object.prototype.hasOwnProperty.call(old, rel)) {
        newBase[rel] = old[rel];
      }
    } else {
      newBase[rel] = hashFile(full);
    }
  }
  for (const rel of conflicts) {
    if (!files.has(rel) && Object.prototype.hasOwnProperty.call(old, rel)) {
      newBase[rel] = old[rel];
    }
  }
  // what is below a folder that can't be listed was not seen: its record entries stay
  for (const rel of Object.keys(old)) {
    if (!(rel in newBase) && listed.unreadable.some((u) => belowFolder(rel, u.rel))) {
      newBase[rel] = old[rel];
    }
  }
  writeManifest(holderDir, newBase, conflicts);
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
};
