'use strict';

// Renaming a plugin or one of its items (skill, rule, command, agent, MCP server) inside a repository, and the record
// of the rename in the repository's marketplace.json ("renamed": { "<old id>": "<new id>" }, ids without the repository
// name). Pure: never requires vscode. Errors are returned as { error: '<message>' }, never thrown; every check is made
// before the first file changes, and a failure after that puts back what was changed (best effort).

const fs = require('fs');
const path = require('path');
const { readCatalog, mcpServerNames, serverTable } = require('./catalog');
const { KINDS, nameError, serverNameError, clashError, pluginLocation, exists, readJson } = require('./authoring');
const { renameSkillName } = require('./share');

const SAME_NAME = 'That is already its name.';
const MCP_FILES = ['.mcp.json', 'mcp.json'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function posix(p) {
  return p.split(path.sep).join('/');
}

// The map of renames after oldId became newId (ids without the repository name), as a new object:
// 1. every entry but the key newId (that id is live again), 2. a value equal to oldId, or starting with `oldId/`,
// follows to newId, 3. an entry whose value is now its key is dropped (a rename back), 4. oldId -> newId.
function recordRename(renamed, oldId, newId) {
  const out = {};
  for (const [key, value] of Object.entries(renamed || {})) {
    if (key === newId) {
      continue;
    }
    let v = value;
    if (v === oldId) {
      v = newId;
    } else if (typeof v === 'string' && v.startsWith(`${oldId}/`)) {
      v = newId + v.slice(oldId.length);
    }
    if (v !== key) {
      out[key] = v;
    }
  }
  out[oldId] = newId;
  return out;
}

function renamedError(obj) {
  return obj.renamed !== undefined && !isPlainObject(obj.renamed) ? 'marketplace.json: "renamed" is not an object' : '';
}

// The marketplace.json to record a rename in: { file, obj } ({} when the file is missing) or { error }.
function readForRecord(repoDir) {
  const file = path.join(repoDir, '.cursor-plugin', 'marketplace.json');
  let obj = {};
  if (exists(file)) {
    try {
      obj = readJson(file);
    } catch (err) {
      return { error: `marketplace.json: ${err.message}` };
    }
    if (!isPlainObject(obj)) {
      return { error: 'marketplace.json is not a JSON object' };
    }
  }
  const bad = renamedError(obj);
  return bad ? { error: bad } : { file, obj };
}

// Writes marketplace.json (and its folder when missing); returns the function that puts it back.
function writeMarketplace(file, obj) {
  const had = exists(file);
  let before = '';
  if (had) {
    before = fs.readFileSync(file, 'utf8');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  return () => {
    if (had) {
      fs.writeFileSync(file, before);
    } else {
      fs.rmSync(file, { force: true });
    }
  };
}

function runUndo(undo) {
  for (const fn of undo.reverse()) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}

// The object with the key `from` renamed to `to`, at the same place.
function renameKey(obj, from, to) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k === from ? to : k] = v;
  }
  return out;
}

// Renames a skill, rule, command, agent or MCP server of a plugin: { id, file } (id without the repository name; file:
// the item's new file) or { error }.
// item: { pluginDir, pluginName, kind, name, file }; record: write the record in marketplace.json.
function renameItem(item, newNameRaw, { repoDir, record } = {}) {
  const { pluginDir, pluginName, kind, name, file } = item;
  const newName = String(newNameRaw).trim();
  const bad = kind === 'mcp' ? serverNameError(newName) : nameError(newName);
  if (bad) {
    return { error: bad };
  }
  if (newName === name) {
    return { error: SAME_NAME };
  }

  let oldId;
  let newId;
  let from;
  let to;
  let mcpTargets = [];
  if (kind === 'mcp') {
    oldId = `${pluginName}/mcp/${name}`;
    newId = `${pluginName}/mcp/${newName}`;
    const parsed = [];
    for (const fileName of MCP_FILES) {
      const full = path.join(pluginDir, fileName);
      if (!exists(full)) {
        continue;
      }
      let text;
      let obj;
      try {
        text = fs.readFileSync(full, 'utf8');
        obj = readJson(full);
      } catch {
        continue; // the catalog skipped it too
      }
      if (!isPlainObject(obj)) {
        continue;
      }
      parsed.push({ fileName, full, text, obj });
    }
    for (const p of parsed) {
      if (mcpServerNames(p.obj).includes(newName)) {
        return { error: `${p.fileName} already has a server named ${newName}` };
      }
    }
    mcpTargets = parsed.filter((p) => mcpServerNames(p.obj).includes(name));
    if (mcpTargets.length === 0) {
      return { error: `no MCP file of ${pluginName} has a server named ${name}` };
    }
  } else {
    const clash = clashError(pluginDir, kind, newName);
    if (clash) {
      return { error: clash };
    }
    const folder = KINDS[kind].folder;
    if (kind === 'skill') {
      from = path.dirname(file);
      const oldFolder = path.basename(from);
      to = path.join(pluginDir, 'skills', newName);
      oldId = `${pluginName}/skills/${oldFolder}`;
      newId = `${pluginName}/skills/${newName}`;
    } else {
      from = file;
      const base = path.basename(file);
      const ext = path.extname(base);
      to = path.join(path.dirname(file), `${newName}${ext}`);
      oldId = `${pluginName}/${folder}/${base}`;
      newId = `${pluginName}/${folder}/${newName}${ext}`;
    }
  }

  let market = null;
  if (record) {
    market = readForRecord(repoDir);
    if (market.error) {
      return { error: market.error };
    }
  }

  const undo = [];
  let resultFile;
  try {
    if (kind === 'mcp') {
      for (const t of mcpTargets) {
        const table = serverTable(t.obj);
        const next = table ? { ...t.obj, mcpServers: renameKey(table, name, newName) } : renameKey(t.obj, name, newName);
        fs.writeFileSync(t.full, JSON.stringify(next, null, 2) + '\n');
        undo.push(() => fs.writeFileSync(t.full, t.text));
      }
      resultFile = mcpTargets[0].full;
    } else {
      fs.renameSync(from, to);
      undo.push(() => fs.renameSync(to, from));
      const textFile = kind === 'skill' ? path.join(to, 'SKILL.md') : to;
      const oldName = kind === 'skill' ? path.basename(from) : name;
      const text = fs.readFileSync(textFile, 'utf8');
      const next = renameSkillName(text, oldName, newName);
      if (next !== text) {
        fs.writeFileSync(textFile, next);
        undo.push(() => fs.writeFileSync(textFile, text));
      }
      resultFile = textFile;
    }
    if (market) {
      market.obj.renamed = recordRename(market.obj.renamed, oldId, newId);
      undo.push(writeMarketplace(market.file, market.obj));
    }
  } catch (err) {
    runUndo(undo);
    return { error: err.message };
  }
  return { id: newId, file: resultFile };
}

// Renames a plugin: its folder, its plugin.json name and its marketplace.json entry: { id, dir } (id without the
// repository name) or { error }. plugin: { dir, pluginName }.
function renamePlugin(plugin, newNameRaw, { repoDir, record } = {}) {
  const newName = String(newNameRaw).trim();
  const bad = nameError(newName);
  if (bad) {
    return { error: bad };
  }
  if (newName === plugin.pluginName) {
    return { error: SAME_NAME };
  }
  const location = pluginLocation(repoDir);
  if (location.error) {
    return { error: location.error };
  }
  const newDir = path.join(path.dirname(plugin.dir), newName);
  if (exists(newDir)) {
    return { error: `${posix(path.relative(repoDir, newDir))} already exists` };
  }
  const listed = location.marketplace && location.marketplace.obj.plugins.some((e) => e && e.name === newName);
  if (listed || readCatalog(repoDir).plugins.some((p) => p.name === newName)) {
    return { error: `a plugin named ${newName} already exists in this repository` };
  }

  const manifestFile = path.join(plugin.dir, '.cursor-plugin', 'plugin.json');
  let manifest = null;
  if (exists(manifestFile)) {
    try {
      manifest = readJson(manifestFile);
    } catch (err) {
      return { error: `plugin.json: ${err.message}` };
    }
    if (!isPlainObject(manifest)) {
      return { error: 'plugin.json is not a JSON object' };
    }
  }

  let market = null;
  if (location.marketplace) {
    market = { file: location.marketplace.file, obj: location.marketplace.obj };
    const badRenamed = record ? renamedError(market.obj) : '';
    if (badRenamed) {
      return { error: badRenamed };
    }
    const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    const entry = market.obj.plugins.find((e) => {
      if (!isPlainObject(e)) {
        return false;
      }
      const src = typeof e.source === 'string' ? e.source : isPlainObject(e.source) ? e.source.path : undefined;
      return typeof src === 'string' && key(path.resolve(location.root, src)) === key(plugin.dir);
    });
    if (!entry) {
      return { error: `marketplace.json has no entry for ${path.basename(plugin.dir)}` };
    }
    entry.name = newName;
    const source = `./${posix(path.relative(location.root, newDir))}`;
    if (isPlainObject(entry.source)) {
      entry.source.path = source;
    } else {
      entry.source = source;
    }
  } else if (record) {
    market = readForRecord(repoDir);
    if (market.error) {
      return { error: market.error };
    }
  }
  if (record) {
    market.obj.renamed = recordRename(market.obj.renamed, plugin.pluginName, newName);
  }

  const undo = [];
  try {
    fs.renameSync(plugin.dir, newDir);
    undo.push(() => fs.renameSync(newDir, plugin.dir));
    if (manifest) {
      const next = Object.prototype.hasOwnProperty.call(manifest, 'name') ? { ...manifest, name: newName } : { name: newName, ...manifest };
      const movedManifest = path.join(newDir, '.cursor-plugin', 'plugin.json');
      const before = fs.readFileSync(movedManifest, 'utf8');
      fs.writeFileSync(movedManifest, JSON.stringify(next, null, 2) + '\n');
      undo.push(() => fs.writeFileSync(movedManifest, before));
    }
    if (market) {
      undo.push(writeMarketplace(market.file, market.obj));
    }
  } catch (err) {
    runUndo(undo);
    return { error: err.message };
  }
  return { id: newName, dir: newDir };
}

module.exports = { recordRename, renameItem, renamePlugin };
