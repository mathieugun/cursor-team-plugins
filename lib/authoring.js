'use strict';

// Writing plugins: scaffolds for a new plugin, skill, rule, command, agent or MCP server, and moving a draft plugin
// into a repository. Pure: never requires vscode. Errors are returned as { error: '<message>' }, never thrown.

const fs = require('fs');
const path = require('path');
const { readCatalog, mcpServerNames, serverTable, inside, MCP_METADATA } = require('./catalog');
const { removeTree } = require('./sync');
const { parseJsonc } = require('./checks');
const jsonc = require('./jsonc');

const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RULE = 'Use lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit (at most 64 characters).';
const SERVER_RULE = 'Use letters, digits, dots, hyphens and underscores, starting with a letter or digit (at most 64 characters).';
// kind -> { folder, label }: folder is plugin.json's key for that kind and (except mcp) the default folder
const KINDS = {
  skill: { folder: 'skills', label: 'skill' },
  rule: { folder: 'rules', label: 'rule' },
  command: { folder: 'commands', label: 'command' },
  agent: { folder: 'agents', label: 'agent' },
  mcp: { folder: 'mcpServers', label: 'MCP server' },
};

// The names of the files that would clash with a new item of that kind (relative to the plugin folder).
const EXISTING = {
  skill: (n) => [`skills/${n}`],
  rule: (n) => [`rules/${n}.mdc`, `rules/${n}.md`],
  command: (n) => [`commands/${n}.md`, `commands/${n}.mdc`, `commands/${n}.markdown`, `commands/${n}.txt`],
  agent: (n) => [`agents/${n}.md`, `agents/${n}.mdc`, `agents/${n}.markdown`],
};

function nameError(name) {
  return name.length <= 64 && NAME.test(name) ? '' : NAME_RULE;
}

function serverNameError(name) {
  return name.length <= 64 && SERVER_NAME.test(name) ? '' : SERVER_RULE;
}

// A YAML scalar for a frontmatter value that reads back as the same string: plain only when it starts with a letter
// (so it is no number, date, `~` or indicator), has no `: ` or ` #` trouble (no colon, no #, no control character) and
// is no boolean or null word of YAML 1.1 or 1.2; else double-quoted (a JSON string is one).
function yamlScalar(text) {
  const t = String(text).trim();
  return /^[A-Za-z][^:#\x00-\x1f]*$/.test(t) && !/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(t) ? t : JSON.stringify(t);
}

function title(name) {
  const t = name.replace(/[-.]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// { rel, text }: the path (with '/', from the plugin folder) and the text of the file for a new item.
function itemFile(kind, name, description) {
  const D = yamlScalar(description);
  switch (kind) {
    case 'skill':
      return {
        rel: `skills/${name}/SKILL.md`,
        text: `---\nname: ${yamlScalar(name)}\ndescription: ${D}\n---\n\n# ${title(name)}\n\nDescribe when the agent should use this skill and the steps to follow.\n`,
      };
    case 'rule':
      return {
        rel: `rules/${name}.mdc`,
        text: `---\ndescription: ${D}\nalwaysApply: false\n---\n\nWrite the rule here.\n`,
      };
    case 'command':
      return {
        rel: `commands/${name}.md`,
        text: `---\ndescription: ${D}\n---\n\nWrite what the agent does when this command runs.\n`,
      };
    case 'agent':
      return {
        rel: `agents/${name}.md`,
        text: `---\nname: ${yamlScalar(name)}\ndescription: ${D}\n---\n\nDescribe the agent's role and how it works.\n`,
      };
    default:
      throw new Error(`no file for the kind ${kind}`);
  }
}

// '' when the plugin can take a new item of that kind, else why not.
function declaredPathsError(plugin, kind) {
  if ((plugin.customPaths || []).includes(KINDS[kind].folder)) {
    return `${plugin.name} sets the paths of its ${KINDS[kind].label}s in plugin.json: add the file there by hand.`;
  }
  return '';
}

// Anything but ENOENT counts as there: a folder that is "delete pending" on Windows (deleted while another process
// still has it open) fails lstat with EPERM but still takes its name.
function exists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// '' when the plugin has no file that a new item of that kind and name would clash with, else why not.
function clashError(pluginDir, kind, name) {
  for (const rel of EXISTING[kind](name)) {
    if (exists(path.join(pluginDir, ...rel.split('/')))) {
      return `${rel} already exists`;
    }
  }
  return '';
}

// Writes the file of a new skill, rule, command or agent in the plugin folder: { file } (absolute) or { error }.
// `repoDir` (default: the plugin folder) is the repository the file must stay in.
function createItem(pluginDir, kind, name, description, repoDir = pluginDir) {
  const bad = nameError(name);
  if (bad) {
    return { error: bad };
  }
  const clash = clashError(pluginDir, kind, name);
  if (clash) {
    return { error: clash };
  }
  const { rel, text } = itemFile(kind, name, description);
  const file = path.join(pluginDir, ...rel.split('/'));
  const badDest = destinationError(repoDir, file);
  if (badDest) {
    return { error: badDest };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { flag: 'wx' });
  } catch (err) {
    return { error: err.message };
  }
  return { file };
}

// The words of a command line: split on whitespace, "..." keeps spaces together (backslashes are plain characters).
// null when a double quote is not closed.
function splitCommandLine(text) {
  const parts = [];
  let current = '';
  let has = false;
  let quoted = false;
  for (const c of String(text)) {
    if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && /\s/.test(c)) {
      if (has) {
        parts.push(current);
        current = '';
        has = false;
      }
    } else {
      current += c;
      has = true;
    }
  }
  if (quoted) {
    return null;
  }
  if (has) {
    parts.push(current);
  }
  return parts;
}

// The entry of an MCP server: a url, or a command line (the caller validated it).
function mcpEntry({ command, url }) {
  if (url) {
    return { url };
  }
  const parts = splitCommandLine(command);
  return { command: parts[0], ...(parts.length > 1 ? { args: parts.slice(1) } : {}) };
}

// '' when `name` can be a new server key of the parsed MCP file `obj` (named `fileName` in messages), else why not.
// Only a file whose servers are at the top level (no non-empty `mcpServers` object) restricts names.
function topLevelNameError(fileName, obj, name) {
  if (serverTable(obj)) {
    return '';
  }
  if (name === 'mcpServers') {
    return `"mcpServers" can't name a server in ${fileName}: its servers are at the top level, where that key would hold the whole server list`;
  }
  if (MCP_METADATA.includes(name.toLowerCase())) {
    return `${name} is a reserved key of ${fileName}: pick another name`;
  }
  if (Object.prototype.hasOwnProperty.call(obj, name)) {
    return `${fileName} already has a top-level "${name}": pick another name`;
  }
  return '';
}

// Adds a server to the plugin's mcp.json (or .mcp.json when only that exists): { file } (absolute) or { error }.
// `repoDir` (default: the plugin folder) is the repository the file must stay in.
function addMcpServer(pluginDir, name, entry, repoDir = pluginDir) {
  const bad = serverNameError(name);
  if (bad) {
    return { error: bad };
  }
  const files = ['mcp.json', '.mcp.json'].filter((f) => exists(path.join(pluginDir, f)));
  const targetName = files[0] || 'mcp.json';
  const read = {};
  for (const fileName of files) {
    try {
      const text = fs.readFileSync(path.join(pluginDir, fileName), 'utf8');
      read[fileName] = { text, obj: parseJsonc(text) };
    } catch (err) {
      read[fileName] = { err };
      continue;
    }
    if (mcpServerNames(read[fileName].obj).includes(name)) {
      return { error: `${fileName} already has a server named ${name}` };
    }
  }
  const file = path.join(pluginDir, targetName);
  const badDest = destinationError(repoDir, file);
  if (badDest) {
    return { error: badDest };
  }
  let out = JSON.stringify({ mcpServers: { [name]: entry } }, null, 2) + '\n';
  if (files.length > 0) {
    const { text, obj, err } = read[targetName];
    if (err) {
      return { error: `${targetName}: ${err.message}` };
    }
    if (!isPlainObject(obj)) {
      return { error: `${targetName} is not a JSON object` };
    }
    const useTable = serverTable(obj) || mcpServerNames(obj).length === 0;
    if (useTable && Object.prototype.hasOwnProperty.call(obj, 'mcpServers') && !isPlainObject(obj.mcpServers)) {
      return { error: `${targetName}: "mcpServers" is not an object` };
    }
    const badName = useTable ? '' : topLevelNameError(targetName, obj, name);
    if (badName) {
      return { error: badName };
    }
    try {
      if (!useTable) {
        out = jsonc.addMember(text, [], name, entry);
      } else if (Object.prototype.hasOwnProperty.call(obj, 'mcpServers')) {
        out = jsonc.addMember(text, ['mcpServers'], name, entry);
      } else {
        out = jsonc.addMember(text, [], 'mcpServers', { [name]: entry });
      }
    } catch (e) {
      return { error: `${targetName}: ${e.message}` };
    }
  }
  try {
    fs.writeFileSync(file, out);
  } catch (err) {
    return { error: err.message };
  }
  return { file };
}

// Where the plugins of a repository live: { root, marketplace: null | { file, obj } } or { error }. marketplace is set
// only when marketplace.json lists the plugins (then a new plugin needs an entry there).
function pluginLocation(repoDir) {
  const file = path.join(repoDir, '.cursor-plugin', 'marketplace.json');
  if (!exists(file)) {
    return { root: repoDir, marketplace: null };
  }
  let obj;
  try {
    obj = readJson(file);
  } catch (err) {
    return { error: `marketplace.json: ${err.message}` };
  }
  if (obj && obj.plugins === undefined) {
    return { root: repoDir, marketplace: null };
  }
  if (obj && Array.isArray(obj.plugins)) {
    const pluginRoot = obj.metadata && typeof obj.metadata.pluginRoot === 'string' ? obj.metadata.pluginRoot : '';
    return { root: pluginRoot ? path.join(repoDir, pluginRoot) : repoDir, marketplace: { file, obj } };
  }
  return { error: 'marketplace.json: "plugins" is not an array' };
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// '' when writing `target` stays inside the repository `repoDir`, else why not. Links are resolved through the deepest
// part of `target` that exists (the target itself when it exists), so a path not created yet is checked too; a link on
// the way that can't be resolved (broken) counts as leading outside.
function destinationError(repoDir, target) {
  const shown = path.relative(repoDir, path.resolve(target)).split(path.sep).join('/');
  const viaLink = `${shown} leads outside the repository through a link`;
  let probe = path.resolve(target);
  const rest = [];
  while (!exists(probe) && path.dirname(probe) !== probe) {
    rest.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  let realProbe;
  try {
    realProbe = fs.realpathSync(probe);
  } catch {
    return viaLink;
  }
  const real = path.join(realProbe, ...rest);
  const repoReal = realOr(repoDir);
  if (!inside(repoReal, real)) {
    return inside(path.resolve(repoDir), path.resolve(target)) ? viaLink : `${shown} is outside the repository`;
  }
  return '';
}

// '' when `dir` can be a plugin folder of the repository, else why not: it is the repository root, or it is outside the
// repository (a `..` in metadata.pluginRoot or a name, or a link on the way). The links are resolved through the deepest
// folder that exists, so a folder that is not there yet is checked too.
function pluginDirError(repoDir, dir) {
  const repoReal = realOr(repoDir);
  let probe = path.resolve(dir);
  const rest = [];
  while (!exists(probe) && path.dirname(probe) !== probe) {
    rest.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  if (path.relative(repoReal, path.join(realOr(probe), ...rest)) === '') {
    return 'the plugin folder would be the repository root';
  }
  return destinationError(repoDir, dir);
}

// The folder for a new plugin and the checks that nothing is in its way: { dir, location } or { error }.
function placePlugin(repoDir, folder, name) {
  const location = pluginLocation(repoDir);
  if (location.error) {
    return { error: location.error };
  }
  const dir = path.join(location.root, folder);
  const badDir = pluginDirError(repoDir, dir);
  if (badDir) {
    const hint = path.resolve(location.root) !== path.resolve(repoDir) ? ' (see metadata.pluginRoot in marketplace.json)' : '';
    return { error: `${badDir}${hint}` };
  }
  if (location.marketplace) {
    const badFile = destinationError(repoDir, location.marketplace.file);
    if (badFile) {
      return { error: badFile };
    }
  }
  if (exists(dir)) {
    return { error: `${path.relative(repoDir, dir).split(path.sep).join('/')} already exists` };
  }
  const listed = location.marketplace && location.marketplace.obj.plugins.some((e) => e && e.name === name);
  if (listed || readCatalog(repoDir).plugins.some((p) => p.name === name)) {
    return { error: `a plugin named ${name} already exists in this repository` };
  }
  return { dir, location };
}

// Lists the plugin in marketplace.json, when that file lists the plugins (else the file is not touched).
function addMarketplaceEntry(location, name, description, folder = name) {
  if (!location.marketplace) {
    return;
  }
  const { file, obj } = location.marketplace;
  obj.plugins.push({ name, source: `./${folder}`, ...(description ? { description } : {}) });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// A new plugin folder in the repository, with its plugin.json: { dir } or { error }.
function createPlugin(repoDir, { name, description }) {
  const bad = nameError(name);
  if (bad) {
    return { error: bad };
  }
  const placed = placePlugin(repoDir, name, name);
  if (placed.error) {
    return { error: placed.error };
  }
  const { dir, location } = placed;
  const desc = String(description || '').trim();
  try {
    fs.mkdirSync(path.join(dir, '.cursor-plugin'), { recursive: true });
    const manifest = { name, ...(desc ? { description: desc } : {}), version: '0.1.0' };
    fs.writeFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
    addMarketplaceEntry(location, name, desc);
  } catch (err) {
    removeTree(dir);
    return { error: err.message };
  }
  return { dir };
}

// Copies a plugin folder (a draft) into the repository, lists it in marketplace.json when that lists the plugins, then
// deletes the source: { dir, leftover? } or { error }. leftover: the source folder that could not be deleted.
function movePlugin(srcDir, pluginName, description, repoDir) {
  const folder = path.basename(srcDir);
  const placed = placePlugin(repoDir, folder, pluginName);
  if (placed.error) {
    return { error: placed.error };
  }
  const { dir, location } = placed;
  try {
    fs.cpSync(srcDir, dir, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    removeTree(dir);
    return { error: err.message };
  }
  try {
    addMarketplaceEntry(location, pluginName, String(description || '').trim(), folder);
  } catch (err) {
    removeTree(dir);
    return { error: err.message };
  }
  try {
    removeTree(srcDir);
  } catch {
    return { dir, leftover: srcDir };
  }
  let stillListed = false;
  try {
    stillListed = fs.readdirSync(path.dirname(srcDir)).includes(path.basename(srcDir)); // delete pending included
  } catch {
    // the parent is gone: so is the draft
  }
  return stillListed ? { dir, leftover: srcDir } : { dir };
}

// The ids of a list of selected ids after the plugin `from` became `to`: its own id and its items' ids change.
function renameIds(list, from, to) {
  const out = list.map((id) => {
    if (id === from) {
      return to;
    }
    return id.startsWith(`${from}/`) ? `${to}/${id.slice(from.length + 1)}` : id;
  });
  return [...new Set(out)].sort();
}

module.exports = {
  KINDS,
  NAME_RULE,
  SERVER_RULE,
  nameError,
  serverNameError,
  yamlScalar,
  itemFile,
  clashError,
  createItem,
  splitCommandLine,
  mcpEntry,
  addMcpServer,
  topLevelNameError,
  pluginLocation,
  destinationError,
  pluginDirError,
  createPlugin,
  movePlugin,
  renameIds,
  declaredPathsError,
  exists,
  readJson,
};
