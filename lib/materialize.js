'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COMPLETE = '.team-plugins-complete';

function listFiles(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
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
      try {
        const st = fs.statSync(full);
        out.push({ rel: r, line: `${r}:${st.size}:${st.mtimeMs}` });
      } catch {
        // vanished while listing
      }
    }
  }
}

function filteredDirName(plugin, includedIds) {
  const lines = [];
  listFiles(plugin.dir, '', lines);
  lines.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = crypto
    .createHash('sha1')
    .update(`${plugin.name}\n${[...includedIds].sort().join('\n')}\n${lines.map((l) => l.line).join('\n')}`)
    .digest('hex')
    .slice(0, 12);
  return `${plugin.name}-${hash}`;
}

// Copies the plugin into destDir/<plugin folder name> (Cursor names an extension plugin after its folder, so the copy
// keeps the name the full plugin has) and returns that plugin root. destDir holds the completion marker.
function materialize(plugin, includedIds, destDir) {
  const base = path.basename(plugin.dir);
  if (fs.existsSync(path.join(destDir, COMPLETE))) {
    return path.join(destDir, base);
  }
  const included = new Set(includedIds);
  const skip = new Map(); // absolute path -> true
  for (const c of plugin.children) {
    if (!included.has(c.id)) {
      skip.set(c.kind === 'skill' ? path.dirname(c.file) : c.file, true);
    }
  }
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  const tmp = `${destDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.cpSync(plugin.dir, path.join(tmp, base), {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git' && !skip.has(path.resolve(src)),
  });
  fs.writeFileSync(path.join(tmp, COMPLETE), new Date().toISOString());
  try {
    fs.renameSync(tmp, destDir);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(destDir)) {
      throw err;
    }
  }
  return path.join(destDir, base);
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

module.exports = { filteredDirName, materialize, gcFiltered };
