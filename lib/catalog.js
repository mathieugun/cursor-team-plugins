'use strict';

const fs = require('fs');
const path = require('path');

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJson(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Folds lines the YAML way: blank lines are '', leading blank lines are ignored, consecutive non-blank lines are joined
// by one space, and a run of n blank lines between two non-blank lines gives n newlines instead of the space.
function fold(lines) {
  let out = '';
  let blanks = 0;
  for (const l of lines) {
    if (l === '') {
      blanks++;
      continue;
    }
    out = out === '' ? l : out + (blanks > 0 ? '\n'.repeat(blanks) : ' ') + l;
    blanks = 0;
  }
  return out;
}

// The description of the frontmatter: a plain, quoted (on one line), folded (>) or literal (|) value. A plain value may
// continue on indented lines. A quoted value over several lines is not handled (only its first line is read).
function frontmatterDescription(text) {
  let t = stripBom(String(text)).replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) {
    return '';
  }
  const lines = t.slice(4).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '---') {
      break;
    }
    const m = /^description:\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    let v = m[1].trim();
    const more = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l !== '---' && (l.trim() === '' || l[0] === ' ' || l[0] === '\t')) {
        more.push(l);
      } else {
        break;
      }
    }
    const lead = (l) => /^[ \t]*/.exec(l)[0].length;
    if (/^[|>][1-9+-]{0,2}$/.test(v)) {
      while (more.length > 0 && more[more.length - 1].trim() === '') {
        more.pop();
      }
      if (more.length === 0) {
        return '';
      }
      const indent = lead(more.find((l) => l.trim() !== ''));
      const block = more.map((l) => (l.trim() === '' ? '' : l.slice(Math.min(indent, lead(l)))));
      return (v[0] === '|' ? block.join('\n') : fold(block)).trimEnd();
    }
    if (v[0] === '"' || v[0] === "'") {
      if (v.length >= 2 && v[v.length - 1] === v[0]) {
        v = v.slice(1, -1);
      }
      return v;
    }
    return fold([v, ...more.map((l) => l.trim())]).trimEnd();
  }
  return '';
}

function inside(root, dir) {
  const rel = path.relative(root, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function sortedNames(dir, filter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(filter).map((e) => e.name).sort(byName);
}

// Files directly in <dir>/<folder> (a file, or a link to a file) whose name ends in one of the extensions.
function filesWithExt(dir, folder, extPattern) {
  const base = path.join(dir, folder);
  return sortedNames(
    base,
    (e) => (e.isFile() || (e.isSymbolicLink() && isFile(path.join(base, e.name)))) && extPattern.test(e.name),
  );
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The entries of an MCP file that are metadata, not servers (top-level form).
const MCP_METADATA = ['author', 'owner', 'source', 'metadata'];

// The server table of an MCP file: its `mcpServers` object when that has at least one key, else null.
function serverTable(obj) {
  return isPlainObject(obj) && isPlainObject(obj.mcpServers) && Object.keys(obj.mcpServers).length > 0 ? obj.mcpServers : null;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// The server names of a parsed MCP file, as Cursor reads them: the keys of `mcpServers` when it has at least one, else
// the top-level entries that are objects with a `command` or a `url` (not `$schema` and the metadata keys).
function mcpServerNames(obj) {
  if (!isPlainObject(obj)) {
    return [];
  }
  const table = serverTable(obj);
  if (table) {
    return Object.keys(table);
  }
  return Object.keys(obj).filter(
    (k) =>
      k !== 'mcpServers' &&
      k !== '$schema' &&
      !MCP_METADATA.includes(k.toLowerCase()) &&
      isPlainObject(obj[k]) &&
      (hasOwn(obj[k], 'command') || hasOwn(obj[k], 'url')),
  );
}

// The text of an MCP file without the servers `removeNames`, written with two-space indentation. A file that is not
// valid JSON or not an object is returned unchanged.
function filterMcpJson(text, removeNames) {
  let obj;
  try {
    obj = JSON.parse(stripBom(String(text)));
  } catch {
    return text;
  }
  if (!isPlainObject(obj)) {
    return text;
  }
  const table = serverTable(obj);
  if (table) {
    for (const n of removeNames) {
      delete table[n];
    }
  } else {
    const names = new Set(mcpServerNames(obj));
    for (const n of removeNames) {
      if (names.has(n)) {
        delete obj[n];
      }
    }
  }
  return JSON.stringify(obj, null, 2) + '\n';
}

// What a server of an MCP file shows next to its name: its command line, else its url.
function mcpDescription(entry) {
  if (!isPlainObject(entry)) {
    return '';
  }
  if (typeof entry.command === 'string' && entry.command) {
    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : [];
    return [entry.command, ...args].join(' ');
  }
  return typeof entry.url === 'string' ? entry.url : '';
}

// { children, mcpFiles, warnings }. A kind whose paths plugin.json declares (commands, agents, mcpServers) is left out:
// Cursor then reads those paths instead of the default folder or files. mcpFiles: file name -> its server names.
function readChildren(pluginName, dir, manifest) {
  const children = [];
  const mcpFiles = {};
  const warnings = [];
  const skillsDir = path.join(dir, 'skills');
  for (const name of sortedNames(skillsDir, (e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(skillsDir, e.name))))) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!isFile(file)) {
      continue;
    }
    children.push({ id: `${pluginName}/skills/${name}`, kind: 'skill', name, file, description: describe(file) });
  }
  const rulesDir = path.join(dir, 'rules');
  for (const name of sortedNames(
    rulesDir,
    (e) =>
      (e.isFile() || (e.isSymbolicLink() && isFile(path.join(rulesDir, e.name)))) &&
      (e.name.endsWith('.mdc') || e.name.endsWith('.md')),
  )) {
    const file = path.join(rulesDir, name);
    children.push({
      id: `${pluginName}/rules/${name}`,
      kind: 'rule',
      name: name.replace(/\.(mdc|md)$/, ''),
      file,
      description: describe(file),
    });
  }
  if (manifest.commands === undefined) {
    for (const name of filesWithExt(dir, 'commands', /\.(md|mdc|markdown|txt)$/)) {
      const file = path.join(dir, 'commands', name);
      children.push({
        id: `${pluginName}/commands/${name}`,
        kind: 'command',
        name: name.replace(/\.(md|mdc|markdown|txt)$/, ''),
        file,
        description: describe(file),
      });
    }
  }
  if (manifest.agents === undefined) {
    for (const name of filesWithExt(dir, 'agents', /\.(md|mdc|markdown)$/)) {
      const file = path.join(dir, 'agents', name);
      children.push({
        id: `${pluginName}/agents/${name}`,
        kind: 'agent',
        name: name.replace(/\.(md|mdc|markdown)$/, ''),
        file,
        description: describe(file),
      });
    }
  }
  if (manifest.mcpServers === undefined) {
    const servers = new Map(); // name -> { file, entry }
    for (const fileName of ['.mcp.json', 'mcp.json']) {
      const file = path.join(dir, fileName);
      if (!isFile(file)) {
        continue;
      }
      let obj;
      try {
        obj = readJson(file);
      } catch (err) {
        warnings.push(`${pluginName}: ${fileName}: ${err.message}`);
        continue;
      }
      const names = mcpServerNames(obj);
      if (names.length === 0) {
        continue;
      }
      mcpFiles[fileName] = names;
      const table = serverTable(obj) || obj;
      for (const n of names) {
        if (!servers.has(n)) {
          servers.set(n, { file, entry: table[n] });
        }
      }
    }
    for (const n of [...servers.keys()].sort(byName)) {
      const { file, entry } = servers.get(n);
      children.push({ id: `${pluginName}/mcp/${n}`, kind: 'mcp', name: n, file, description: mcpDescription(entry) });
    }
  }
  return { children, mcpFiles, warnings };
}

function describe(file) {
  try {
    return frontmatterDescription(fs.readFileSync(file, 'utf8'));
  } catch {
    return '';
  }
}

function readCatalog(repoDir) {
  const warnings = [];
  const plugins = [];
  let name = '';
  const renamed = {};
  if (!repoDir || !isDir(repoDir)) {
    return { name, plugins, renamed, warnings: [`repository folder not found: ${repoDir}`] };
  }
  const root = path.resolve(repoDir);

  // candidates: { folder, entry }
  let candidates = null;
  const marketplaceFile = path.join(root, '.cursor-plugin', 'marketplace.json');
  if (isFile(marketplaceFile)) {
    try {
      const market = readJson(marketplaceFile);
      if (market && typeof market.name === 'string') {
        name = market.name.trim();
      }
      if (market && market.renamed !== undefined) {
        if (isPlainObject(market.renamed)) {
          for (const [from, to] of Object.entries(market.renamed)) {
            if (from && typeof to === 'string' && to && from !== to) {
              renamed[from] = to;
            }
          }
        } else {
          warnings.push('marketplace.json: "renamed" is not an object');
        }
      }
      candidates = [];
      const root0 = market && market.metadata && typeof market.metadata.pluginRoot === 'string' && market.metadata.pluginRoot
        ? path.join(root, market.metadata.pluginRoot)
        : root;
      if (market && market.plugins === undefined) {
        // only a name (or nothing): the plugins are found by the folder scan
        candidates = null;
      } else if (!market || !Array.isArray(market.plugins)) {
        warnings.push('marketplace.json: "plugins" is not an array');
      } else {
        for (const entry of market.plugins) {
          const e = entry && typeof entry === 'object' ? entry : {};
          const label = e.name;
          let folder = null;
          if (typeof e.source === 'string') {
            folder = path.resolve(root0, e.source);
          } else if (e.source && typeof e.source === 'object' && typeof e.source.path === 'string') {
            folder = path.resolve(root0, e.source.path);
          } else {
            warnings.push(`plugin "${label}": unsupported source (only folders of this repository)`);
            continue;
          }
          if (!inside(root, folder)) {
            warnings.push(`plugin "${label}": source outside the repository`);
            continue;
          }
          if (!isDir(folder)) {
            warnings.push(`plugin "${label}": folder not found: ${path.relative(root, folder).split(path.sep).join('/')}`);
            continue;
          }
          candidates.push({ folder, entry: e });
        }
      }
    } catch (err) {
      warnings.push(`marketplace.json: ${err.message}`);
      candidates = null;
    }
  }
  if (candidates === null) {
    candidates = sortedNames(root, (e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((n) => path.join(root, n))
      .filter((f) => isFile(path.join(f, '.cursor-plugin', 'plugin.json')))
      .map((folder) => ({ folder, entry: {} }));
  }

  const taken = new Set();
  for (const { folder, entry } of candidates) {
    let manifest = {};
    const manifestFile = path.join(folder, '.cursor-plugin', 'plugin.json');
    if (isFile(manifestFile)) {
      try {
        const m = readJson(manifestFile);
        manifest = m && typeof m === 'object' ? m : {};
      } catch (err) {
        warnings.push(`${path.basename(folder)}: plugin.json: ${err.message}`);
      }
    }
    const str = (v) => (typeof v === 'string' && v ? v : '');
    const pluginName = str(manifest.name) || str(entry.name) || path.basename(folder);
    if (taken.has(pluginName)) {
      warnings.push(`duplicate plugin name "${pluginName}" (${path.basename(folder)}): skipped`);
      continue;
    }
    taken.add(pluginName);
    const read = readChildren(pluginName, folder, manifest);
    warnings.push(...read.warnings);
    const plugin = {
      name: pluginName,
      displayName: str(manifest.displayName) || pluginName,
      version: str(manifest.version),
      description: str(manifest.description) || str(entry.description),
      dir: folder,
      repoDir: root,
      children: read.children,
    };
    if (Object.keys(read.mcpFiles).length > 0) {
      plugin.mcpFiles = read.mcpFiles;
    }
    // the kinds whose paths plugin.json declares: no file can be scaffolded for them
    const customPaths = ['skills', 'rules', 'commands', 'agents', 'mcpServers'].filter((k) => manifest[k] !== undefined);
    if (customPaths.length > 0) {
      plugin.customPaths = customPaths;
    }
    plugins.push(plugin);
  }
  return { name, plugins, renamed, warnings };
}

module.exports = { readCatalog, frontmatterDescription, mcpServerNames, filterMcpJson, serverTable };
