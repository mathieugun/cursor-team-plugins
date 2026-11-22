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

function frontmatterDescription(text) {
  let t = stripBom(String(text)).replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) {
    return '';
  }
  const lines = t.slice(4).split('\n');
  for (const line of lines) {
    if (line === '---') {
      break;
    }
    const m = /^description:\s*(.*)$/.exec(line);
    if (m) {
      let v = m[1].trim();
      if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
        v = v.slice(1, -1);
      }
      return v;
    }
  }
  return '';
}

function inside(root, dir) {
  const rel = path.relative(root, dir);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function sortedNames(dir, filter) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(filter).map((e) => e.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function readChildren(pluginName, dir) {
  const children = [];
  const skillsDir = path.join(dir, 'skills');
  for (const name of sortedNames(skillsDir, (e) => e.isDirectory())) {
    const file = path.join(skillsDir, name, 'SKILL.md');
    if (!isFile(file)) {
      continue;
    }
    children.push({ id: `${pluginName}/skills/${name}`, kind: 'skill', name, file, description: describe(file) });
  }
  const rulesDir = path.join(dir, 'rules');
  for (const name of sortedNames(rulesDir, (e) => e.isFile() && (e.name.endsWith('.mdc') || e.name.endsWith('.md')))) {
    const file = path.join(rulesDir, name);
    children.push({
      id: `${pluginName}/rules/${name}`,
      kind: 'rule',
      name: name.replace(/\.(mdc|md)$/, ''),
      file,
      description: describe(file),
    });
  }
  return children;
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
  if (!repoDir || !isDir(repoDir)) {
    return { plugins, warnings: [`repository folder not found: ${repoDir}`] };
  }
  const root = path.resolve(repoDir);

  // candidates: { folder, entry }
  let candidates = null;
  const marketplaceFile = path.join(root, '.cursor-plugin', 'marketplace.json');
  if (isFile(marketplaceFile)) {
    try {
      const market = readJson(marketplaceFile);
      candidates = [];
      const root0 = market && market.metadata && typeof market.metadata.pluginRoot === 'string' && market.metadata.pluginRoot
        ? path.join(root, market.metadata.pluginRoot)
        : root;
      if (!market || !Array.isArray(market.plugins)) {
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
    const name = str(manifest.name) || str(entry.name) || path.basename(folder);
    if (taken.has(name)) {
      warnings.push(`duplicate plugin name "${name}" (${path.basename(folder)}): skipped`);
      continue;
    }
    taken.add(name);
    plugins.push({
      name,
      displayName: str(manifest.displayName) || name,
      version: str(manifest.version),
      description: str(manifest.description) || str(entry.description),
      dir: folder,
      children: readChildren(name, folder),
    });
  }
  return { plugins, warnings };
}

module.exports = { readCatalog, frontmatterDescription };
