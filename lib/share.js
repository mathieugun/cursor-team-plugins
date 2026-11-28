'use strict';

// Sharing a project's (or the user's ~/.cursor) rule, skill, command or agent: copying it into a plugin.
// Pure: never requires vscode. Errors are returned as { error: '<message>' }, never thrown.

const fs = require('fs');
const path = require('path');
const { KINDS, nameError, clashError, yamlScalar } = require('./authoring');
const { removeTree } = require('./sync');

// An item is { kind, name, ext, src }: ext is the file's own extension ('' for a skill), src the absolute path of the
// file, or of the skill folder.

// The item a path stands for, from its text alone (no file system access), or null. The same paths as the regexes of
// the `explorer/context` menu in package.json (share.test.js checks they agree).
function shareKind(p) {
  const s = p.replace(/\\/g, '/');
  let m = /\/\.cursor\/skills\/([^/]+)(\/SKILL\.md)?$/.exec(s);
  if (m) {
    return { kind: 'skill', name: m[1], ext: '', src: m[2] ? path.dirname(p) : p };
  }
  m = /\/\.cursor\/rules\/(?:.+\/)?([^/]+)(\.mdc|\.md)$/.exec(s);
  if (m) {
    return { kind: 'rule', name: m[1], ext: m[2], src: p };
  }
  m = /\/\.cursor\/commands\/([^/]+)(\.md|\.mdc|\.markdown|\.txt)$/.exec(s);
  if (m) {
    return { kind: 'command', name: m[1], ext: m[2], src: p };
  }
  m = /\/\.cursor\/agents\/([^/]+)(\.md|\.mdc|\.markdown)$/.exec(s);
  if (m) {
    return { kind: 'agent', name: m[1], ext: m[2], src: p };
  }
  return null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// shareKind, and the item is on disk (a skill needs its SKILL.md, links followed), else null.
function shareableItem(p) {
  const item = shareKind(p);
  if (!item) {
    return null;
  }
  return isFile(item.kind === 'skill' ? path.join(item.src, 'SKILL.md') : item.src) ? item : null;
}

function readEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// The files below a rules folder, recursively (a link to a folder is not followed).
function ruleFiles(dir) {
  const out = [];
  for (const e of readEntries(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...ruleFiles(full));
    } else if (e.isFile() || (e.isSymbolicLink() && isFile(full))) {
      out.push(full);
    }
  }
  return out;
}

// The items under <root>/.cursor, each with `rel` (from root, with '/'): skills, rules, commands, agents.
function projectItems(root) {
  const base = path.join(root, '.cursor');
  const found = { skill: [], rule: [], command: [], agent: [] };
  const add = (kind, full) => {
    const item = shareKind(full);
    if (item && item.kind === kind) {
      found[kind].push({ ...item, rel: path.relative(root, full).split(path.sep).join('/') });
    }
  };
  for (const e of readEntries(path.join(base, 'skills'))) {
    const full = path.join(base, 'skills', e.name);
    if ((e.isDirectory() || (e.isSymbolicLink() && isDirectory(full))) && isFile(path.join(full, 'SKILL.md'))) {
      add('skill', full);
    }
  }
  for (const full of ruleFiles(path.join(base, 'rules'))) {
    add('rule', full);
  }
  for (const [kind, folder] of [['command', 'commands'], ['agent', 'agents']]) {
    for (const e of readEntries(path.join(base, folder))) {
      const full = path.join(base, folder, e.name);
      if (e.isFile() || (e.isSymbolicLink() && isFile(full))) {
        add(kind, full);
      }
    }
  }
  const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  return [...found.skill.sort(byRel), ...found.rule.sort(byRel), ...found.command.sort(byRel), ...found.agent.sort(byRel)];
}

// A name that passes nameError built from the given one, or ''.
function suggestName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64)
    .replace(/[^a-z0-9]+$/, '');
}

// '' when the plugin can take an item of that kind under that name, else why not.
function shareNameError(pluginDir, kind, name) {
  return nameError(name) || clashError(pluginDir, kind, name);
}

// The text of a SKILL.md with its frontmatter `name:` set to newName, when that line equals oldName (quotes aside);
// else the text as it is.
function renameSkillName(text, oldName, newName) {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const open = /^---\r?\n/.exec(text.slice(start));
  if (!open) {
    return text;
  }
  let pos = start + open[0].length;
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) {
      end = text.length;
    }
    const line = text.slice(pos, end);
    if (/^---\r?$/.test(line)) {
      return text;
    }
    const m = /^name:[ \t]*(.*?)[ \t]*\r?$/.exec(line);
    if (m) {
      const quoted = /^(["'])(.*)\1$/.exec(m[1]);
      if ((quoted ? quoted[2] : m[1]) !== oldName) {
        return text;
      }
      return `${text.slice(0, pos)}name: ${yamlScalar(newName)}${line.endsWith('\r') ? '\r' : ''}${text.slice(end)}`;
    }
    pos = end + 1;
  }
  return text;
}

function renameSkill(file, oldName, newName) {
  const text = fs.readFileSync(file, 'utf8');
  const next = renameSkillName(text, oldName, newName);
  if (next !== text) {
    fs.writeFileSync(file, next);
  }
}

// Copies the item into the plugin folder as `name`: { file, skipped } or { error }. file: the copied rule, command or
// agent file, or the copied skill's SKILL.md. skipped: the links left out of a skill (relative to the skill, with '/').
function shareItem(item, pluginDir, name) {
  const bad = shareNameError(pluginDir, item.kind, name);
  if (bad) {
    return { error: bad };
  }
  if (item.kind === 'skill') {
    const dest = path.join(pluginDir, KINDS.skill.folder, name);
    const skipped = [];
    try {
      const from = fs.realpathSync(item.src); // a skill folder that is itself a link is copied, not skipped
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(from, dest, {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter: (s) => {
          if (fs.lstatSync(s).isSymbolicLink()) {
            skipped.push(path.relative(from, s).split(path.sep).join('/'));
            return false;
          }
          return true;
        },
      });
      const file = path.join(dest, 'SKILL.md');
      if (name !== item.name) {
        renameSkill(file, item.name, name);
      }
      return { file, skipped };
    } catch (err) {
      try {
        removeTree(dest);
      } catch {
        // nothing more to do: the error below is the one to report
      }
      return { error: err.message };
    }
  }
  const dest = path.join(pluginDir, KINDS[item.kind].folder, name + item.ext);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(item.src, dest, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    return { error: err.message };
  }
  return { file: dest, skipped: [] };
}

module.exports = {
  shareKind,
  shareableItem,
  projectItems,
  suggestName,
  shareNameError,
  shareItem,
  renameSkillName,
};
