'use strict';

const fs = require('fs');
const path = require('path');
const checks = require('./checks');
const { itemContext } = require('./context');
const { readHooks } = require('./hooks');

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

// A value of the frontmatter (key: a plain word such as `description` or `name`): a plain, quoted (on one line), folded
// (>) or literal (|) value. A plain value may continue on indented lines. A quoted value over several lines is not
// handled (only its first line is read).
function frontmatterField(text, key) {
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
    const m = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
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

const frontmatterDescription = (text) => frontmatterField(text, 'description');

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

// Files in a conventional scripts/ directory. Check each resolved path and stop symlink cycles.
function readScripts(owner, pluginRoot) {
  if (!pluginRoot) {
    return [];
  }
  const folder = path.join(owner, 'scripts');
  const files = [];
  const ancestors = new Set();
  const visit = (file) => {
    let real;
    let stat;
    try {
      real = fs.realpathSync(file);
      if (!inside(pluginRoot, real) || ancestors.has(real)) {
        return;
      }
      stat = fs.statSync(real);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      ancestors.add(real);
      for (const name of sortedNames(file, (entry) => entry.name !== '.git')) {
        visit(path.join(file, name));
      }
      ancestors.delete(real);
    } else if (stat.isFile() && file !== folder) {
      files.push({ name: path.relative(folder, file).split(path.sep).join('/'), file });
    }
  };
  visit(folder);
  return files;
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
    obj = checks.parseJsonc(String(text));
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

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// A skill, rule, command or agent: its file is read once, for the description and the problems.
function itemChild(id, kind, name, file) {
  const text = readText(file);
  const child = { id, kind, name, file, description: frontmatterField(text, 'description') };
  const problems = checks.checkItemText(kind, text, file, frontmatterField);
  if (problems.length > 0) {
    child.problems = problems;
  }
  const itemCost = itemContext(kind, text, frontmatterField);
  if (itemCost) {
    child.context = itemCost;
  }
  return { child, text };
}

// Cursor loads only one of the skills (or rules) of a plugin that have the same normalised name: the first in our order
// keeps it, each later one gets an error. entries: [{ child, text, stem }] of one kind, in order; label(entry): the name
// shown for the first.
function markDuplicates(entries, label) {
  const first = new Map();
  for (const entry of entries) {
    const key = checks.skillKey(frontmatterField(entry.text, 'name') || entry.stem);
    const other = first.get(key);
    if (!other) {
      first.set(key, entry);
      continue;
    }
    const problem = {
      file: entry.child.file,
      line: 1,
      severity: 'error',
      message: `Same name as ${label(other)} ("${key}"), so Cursor loads only one of them`,
    };
    entry.child.problems = [...(entry.child.problems || []), problem];
  }
}

// { children, mcpFiles, warnings, problems }. A kind whose paths plugin.json declares (commands, agents, mcpServers) is
// left out: Cursor then reads those paths instead of the default folder or files. mcpFiles: file name -> its server
// names. problems: those of the plugin's MCP files (the items carry their own).
function readChildren(pluginName, dir, manifest) {
  const children = [];
  const mcpFiles = {};
  const warnings = [];
  const problems = [];
  let pluginRoot;
  try {
    pluginRoot = fs.realpathSync(dir);
  } catch {
    // A removed or unreadable plugin has no script rows.
  }
  const skillsDir = path.join(dir, 'skills');
  const skills = [];
  for (const name of sortedNames(skillsDir, (e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(skillsDir, e.name))))) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!isFile(file)) {
      continue;
    }
    const { child, text } = itemChild(`${pluginName}/skills/${name}`, 'skill', name, file);
    const scripts = readScripts(path.dirname(file), pluginRoot);
    if (scripts.length > 0) {
      child.scripts = scripts;
    }
    skills.push({ child, text, stem: name });
    children.push(child);
  }
  markDuplicates(skills, (e) => e.child.name);
  const rulesDir = path.join(dir, 'rules');
  const rules = [];
  for (const name of sortedNames(
    rulesDir,
    (e) =>
      (e.isFile() || (e.isSymbolicLink() && isFile(path.join(rulesDir, e.name)))) &&
      (e.name.endsWith('.mdc') || e.name.endsWith('.md')),
  )) {
    const file = path.join(rulesDir, name);
    const stem = name.replace(/\.(mdc|md)$/, '');
    const { child, text } = itemChild(`${pluginName}/rules/${name}`, 'rule', stem, file);
    rules.push({ child, text, stem, fileName: name });
    children.push(child);
  }
  markDuplicates(rules, (e) => e.fileName);
  if (manifest.commands === undefined) {
    for (const name of filesWithExt(dir, 'commands', /\.(md|mdc|markdown|txt)$/)) {
      const file = path.join(dir, 'commands', name);
      children.push(
        itemChild(`${pluginName}/commands/${name}`, 'command', name.replace(/\.(md|mdc|markdown|txt)$/, ''), file).child,
      );
    }
  }
  if (manifest.agents === undefined) {
    for (const name of filesWithExt(dir, 'agents', /\.(md|mdc|markdown)$/)) {
      const file = path.join(dir, 'agents', name);
      children.push(
        itemChild(`${pluginName}/agents/${name}`, 'agent', name.replace(/\.(md|mdc|markdown)$/, ''), file).child,
      );
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
      let text = null;
      try {
        text = fs.readFileSync(file, 'utf8');
        obj = checks.parseJsonc(text);
      } catch (err) {
        warnings.push(`${pluginName}: ${fileName}: ${err.message}`);
        if (text !== null) {
          problems.push(...checks.checkJsonText(text, file, { jsonc: true }));
        }
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
  const hooks = readHooks(dir);
  if (hooks.events.length > 0) {
    children.push({ id: `${pluginName}/hooks`, kind: 'hooks', name: 'Hooks', file: hooks.file, events: hooks.events });
  }
  return { children, mcpFiles, warnings, problems, hasHookConfig: hooks.candidate, scripts: readScripts(dir, pluginRoot) };
}

// { name, plugins, renamed, warnings, problems }. warnings are logged; problems (see lib/checks.js) are shown in the view
// and checked before a push: those of the repository itself here, those of a plugin and its items on them.
function readCatalog(repoDir) {
  const warnings = [];
  const problems = [];
  const plugins = [];
  let name = '';
  const renamed = {};
  if (!repoDir || !isDir(repoDir)) {
    const message = `repository folder not found: ${repoDir}`;
    return {
      name,
      plugins,
      renamed,
      warnings: [message],
      problems: [{ file: '', line: 0, severity: 'error', message }],
    };
  }
  const root = path.resolve(repoDir);

  // candidates: { folder, entry }
  let candidates = null;
  const marketplaceFile = path.join(root, '.cursor-plugin', 'marketplace.json');
  // a problem of the repository itself: warnings that are not about one loaded plugin
  const repoProblem = (message, severity = 'error') => {
    warnings.push(message);
    problems.push({ file: marketplaceFile, line: 0, severity, message });
  };
  if (isFile(marketplaceFile)) {
    try {
      const marketText = fs.readFileSync(marketplaceFile, 'utf8');
      problems.push(
        ...checks.checkJsonText(marketText, marketplaceFile, { what: ' (the plugin list and the repository name)' }),
      );
    } catch {
      // unreadable: the parse below reports it
    }
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
          repoProblem('marketplace.json: "renamed" is not an object', 'warning');
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
        repoProblem('marketplace.json: "plugins" is not an array');
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
            repoProblem(`plugin "${label}": unsupported source (only folders of this repository)`);
            continue;
          }
          if (!inside(root, folder)) {
            repoProblem(`plugin "${label}": source outside the repository`);
            continue;
          }
          if (!isDir(folder)) {
            repoProblem(`plugin "${label}": folder not found: ${path.relative(root, folder).split(path.sep).join('/')}`);
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
    const manifestProblems = [];
    if (isFile(manifestFile)) {
      try {
        manifestProblems.push(
          ...checks.checkJsonText(fs.readFileSync(manifestFile, 'utf8'), manifestFile, {
            what: ' (its name, display name and declared folders)',
          }),
        );
      } catch {
        // unreadable: the parse below reports it
      }
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
      const message = `duplicate plugin name "${pluginName}" (${path.basename(folder)}): skipped`;
      warnings.push(message);
      problems.push({ file: isFile(manifestFile) ? manifestFile : folder, line: 0, severity: 'error', message });
      continue;
    }
    taken.add(pluginName);
    const read = readChildren(pluginName, folder, manifest);
    warnings.push(...read.warnings);
    const pluginProblems = [...manifestProblems, ...read.problems];
    const plugin = {
      name: pluginName,
      displayName: str(manifest.displayName) || pluginName,
      version: str(manifest.version),
      description: str(manifest.description) || str(entry.description),
      dir: folder,
      repoDir: root,
      children: read.children,
    };
    if (read.scripts.length > 0) {
      plugin.scripts = read.scripts;
    }
    if (read.hasHookConfig) {
      plugin.hasHookConfig = true;
    }
    if (pluginProblems.length > 0) {
      plugin.problems = pluginProblems;
    }
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
  return { name, plugins, renamed, warnings, problems };
}

module.exports = {
  readCatalog,
  frontmatterDescription,
  frontmatterField,
  mcpServerNames,
  filterMcpJson,
  serverTable,
  inside,
  MCP_METADATA,
};
