'use strict';

// The update summary: what the user has seen of a repository (fingerprints of its items at HEAD, kept in
// <storage>/seen/<key>.json), which items are new or updated since, who changed them last, and the texts that say so.
// Pure logic and git readers (they take `run`, like lib/sync.js); never requires `vscode`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const catalogLib = require('./catalog');
const { followRenames } = require('./repos');

const SEEN_VERSION = 1;
const LOG_LIMIT = 1000;

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

// ---- parsing git's output ----------------------------------------------------------------------------------------

// `git ls-tree -r -t -z`: Map path -> object id (trees included).
function parseLsTree(text) {
  const map = new Map();
  for (const record of String(text).split('\0')) {
    const m = /^\d+ \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (m) {
      map.set(m[2], m[1]);
    }
  }
  return map;
}

// `git log -z --name-only --format=%x01%H%x00%an%x00%ae%x00%aI%x00%s`: newest first.
function parseLog(text) {
  const commits = [];
  for (const piece of String(text).split('\x01').slice(1)) {
    const fields = piece.split('\0');
    if (fields.length < 5) {
      continue;
    }
    const [hash, author, email, date, subject, ...rest] = fields;
    const files = rest.map((f, i) => (i === 0 ? f.replace(/^\n/, '') : f)).filter((f) => f !== '');
    commits.push({ hash, author, email: email.toLowerCase(), date, subject, files });
  }
  return commits;
}

// `git var GIT_AUTHOR_IDENT` ("Name <email> 1795716034 +0100"): the email, lower-cased, or ''.
function parseIdent(text) {
  const s = String(text);
  const open = s.lastIndexOf('<');
  const close = open < 0 ? -1 : s.indexOf('>', open);
  return open >= 0 && close > open ? s.slice(open + 1, close).trim().toLowerCase() : '';
}

// ---- items and fingerprints --------------------------------------------------------------------------------------

// Where an item lives in the repository: a skill's folder, else its file (an MCP server: the file it comes from).
function itemPath(item, repoDir) {
  return path.relative(repoDir, item.kind === 'skill' ? path.dirname(item.file) : item.file).replace(/\\/g, '/');
}

function pluginPath(plugin, repoDir) {
  return path.relative(repoDir, plugin.dir).replace(/\\/g, '/');
}

// The items of a repository's plugins as the update pass uses them: { id (local), kind, name, path }.
function updateItems(plugins, repoDir) {
  return plugins.flatMap((p) =>
    p.children.map((c) => ({ id: c.id, kind: c.kind, name: c.name, path: itemPath(c, repoDir) })),
  );
}

// The entry of a server in the text of an MCP file, or undefined.
function serverEntry(text, name) {
  if (typeof text !== 'string') {
    return undefined;
  }
  let obj;
  try {
    obj = JSON.parse(stripBom(text));
  } catch {
    return undefined;
  }
  if (!catalogLib.mcpServerNames(obj).includes(name)) {
    return undefined;
  }
  return (catalogLib.serverTable(obj) || obj)[name];
}

// What a diff shows of one server: its entry alone ('' when the file has no such server).
function serverText(text, name) {
  const entry = serverEntry(text, name);
  return entry === undefined ? '' : JSON.stringify({ [name]: entry }, null, 2) + '\n';
}

// Map local id -> fingerprint at one revision: the object id of the item's folder or file, for an MCP server the hash
// of its entry. tree: Map path -> id (parseLsTree); mcpTexts: Map path -> text of the MCP files. An item that is not
// committed has none.
function fingerprints(items, tree, mcpTexts) {
  const fps = new Map();
  for (const item of items) {
    if (item.kind === 'mcp') {
      const entry = serverEntry(mcpTexts.get(item.path), item.name);
      if (entry !== undefined) {
        fps.set(item.id, `mcp:${sha1(JSON.stringify(entry))}`);
      }
    } else if (tree.has(item.path)) {
      fps.set(item.id, tree.get(item.path));
    }
  }
  return fps;
}

// ---- who changed what last ---------------------------------------------------------------------------------------

// paths: Map key -> path; commits: parseLog (newest first). Map key -> the newest commit that touched the path (the
// file itself or anything below it).
function lastChanges(paths, commits) {
  const found = new Map();
  const wanted = new Map(paths);
  for (const commit of commits) {
    if (wanted.size === 0) {
      break;
    }
    for (const [key, p] of wanted) {
      const prefix = `${p}/`;
      if (p === '' ? commit.files.length > 0 : commit.files.some((f) => f === p || f.startsWith(prefix))) {
        found.set(key, commit);
        wanted.delete(key);
      }
    }
  }
  return found;
}

// ---- marks -------------------------------------------------------------------------------------------------------

function entryOf(item, oid, head) {
  return { oid, commit: head, path: item.path, kind: item.kind, name: item.name };
}

// A record of everything as it is now: nothing is new or updated.
function baselineRecord(items, fps, head) {
  const out = {};
  for (const item of items) {
    if (fps.has(item.id)) {
      out[item.id] = entryOf(item, fps.get(item.id), head);
    }
  }
  return { version: SEEN_VERSION, items: out };
}

// items: { id, kind, name, path } in catalog order; fps: fingerprints; record: the seen record or null (never seen);
// last: lastChanges; self: the user's email ('' when unknown); head; renamed: the repository's `renamed` object;
// plugins: its catalog plugins (for followRenames). Returns { marks: Map id -> 'new' | 'updated', removed: [{ id, path,
// kind, name, commit }], record, changed }.
function computeMarks({ items, fps, record, last, self, head, renamed, plugins }) {
  const marks = new Map();
  if (record === null || record === undefined) {
    return { marks, removed: [], record: baselineRecord(items, fps, head), changed: true };
  }
  const recItems = { ...record.items };
  let changed = false;
  const ids = new Set(items.map((i) => i.id));
  const own = (id) => {
    const c = last.get(id);
    return self !== '' && !!c && c.email === self;
  };

  // a renamed item keeps its record
  const known = { plugins: plugins || [{ name: '', children: items }], renamed: new Map(Object.entries(renamed || {})) };
  for (const id of Object.keys(recItems)) {
    if (ids.has(id)) {
      continue;
    }
    const to = followRenames(known, id);
    if (to !== id && ids.has(to) && recItems[to] === undefined) {
      recItems[to] = recItems[id];
      delete recItems[id];
      changed = true;
    }
  }

  for (const item of items) {
    if (!fps.has(item.id)) {
      continue; // not committed: left alone
    }
    const oid = fps.get(item.id);
    const rec = recItems[item.id];
    if (rec && rec.oid === oid) {
      continue;
    }
    if (own(item.id)) {
      recItems[item.id] = entryOf(item, oid, head);
      changed = true;
    } else {
      marks.set(item.id, rec ? 'updated' : 'new');
    }
  }

  const removed = [];
  for (const id of Object.keys(recItems)) {
    if (ids.has(id)) {
      continue;
    }
    const rec = recItems[id];
    if (own(id)) {
      delete recItems[id];
      changed = true;
    } else {
      removed.push({ id, path: rec.path, kind: rec.kind, name: rec.name, commit: rec.commit });
    }
  }
  return { marks, removed, record: { version: SEEN_VERSION, items: recItems }, changed };
}

// A copy of the record with the item marked seen (entry) or forgotten (entry null: a removed item).
function markSeen(record, id, entry) {
  const items = { ...((record && record.items) || {}) };
  if (entry === null) {
    delete items[id];
  } else {
    items[id] = entry;
  }
  return { version: SEEN_VERSION, items };
}

// ---- the seen record's file --------------------------------------------------------------------------------------

// null when the file is missing, unreadable or of another version (the repository then counts as never seen).
function readSeen(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record && typeof record === 'object' && record.version === SEEN_VERSION && record.items && typeof record.items === 'object') {
      return record;
    }
  } catch {
    // none yet
  }
  return null;
}

// Writes the record unless the file already holds it (the folder is watched: a write that changes nothing would make
// every window apply again). Returns whether it wrote; throws when it cannot.
function writeSeen(file, record) {
  const text = JSON.stringify(record, null, 2);
  try {
    if (fs.readFileSync(file, 'utf8') === text) {
      return false;
    }
  } catch {
    // none yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return true;
}

// ---- the notification --------------------------------------------------------------------------------------------

// The items to name in the notification: { id, verb, author, name }. marks: Map id -> mark; removed: computeMarks'
// list; last: lastChanges; range: Set of the hashes of the commits just fetched; items: the catalog's items (their
// order); enabled: Set of the ids the user's selection includes. Enabled items come first, removed ones last.
function noticeEntries({ marks, removed, last, range, items, enabled }) {
  const entry = (id, verb, name) => {
    const c = last.get(id);
    return c && range.has(c.hash) ? { id, verb, author: c.author, name } : null;
  };
  const marked = items
    .filter((i) => marks.has(i.id))
    .map((i) => ({ i, e: entry(i.id, marks.get(i.id) === 'new' ? 'added' : 'updated', i.name) }))
    .filter((x) => x.e);
  const on = (x) => enabled.has(x.i.id);
  const ordered = [...marked.filter(on), ...marked.filter((x) => !on(x))].map((x) => x.e);
  for (const r of removed) {
    const e = entry(r.id, 'removed', r.name);
    if (e) {
      ordered.push(e);
    }
  }
  return ordered;
}

function noticeText(repoName, entries, { kept = 0 } = {}) {
  const p = (e) => `${e.author} ${e.verb} ${e.name}`;
  let list;
  if (entries.length === 1) {
    list = p(entries[0]);
  } else if (entries.length === 2) {
    list = `${p(entries[0])} and ${p(entries[1])}`;
  } else {
    list = `${p(entries[0])}, ${p(entries[1])} and ${entries.length - 2} more`;
  }
  return `Team plugins (${repoName}): ${list}. Start a new chat to use the changes.${kept > 0 ? ' Your local changes were kept.' : ''}`;
}

// What the notification of an update says: { text, button } (button: it offers What changed), or null when the user
// made every commit of it. entries: noticeEntries; count: the number of new commits; range: Set of their hashes;
// commits: parseLog; self: the user's email.
function noticeMessage({ repoName, entries, kept = 0, count, range, commits, self }) {
  if (entries.length > 0) {
    return { text: noticeText(repoName, entries, { kept }), button: true };
  }
  const inRange = commits.filter((c) => range.has(c.hash));
  if (self !== '' && inRange.length > 0 && inRange.every((c) => c.email === self)) {
    return null;
  }
  return {
    text: `Team plugins: ${repoName} updated (${count} new commit(s)). Start a new chat to use the changes.${
      kept > 0 ? ' Your local changes were kept.' : ''
    }`,
    button: false,
  };
}

// ---- ages and dates ----------------------------------------------------------------------------------------------

function ago(date, now) {
  const seconds = (new Date(now).getTime() - new Date(date).getTime()) / 1000;
  const unit = (n, name) => `${n} ${name}${n === 1 ? '' : 's'} ago`;
  if (!(seconds >= 60)) {
    return 'just now';
  }
  if (seconds < 3600) {
    return unit(Math.floor(seconds / 60), 'minute');
  }
  if (seconds < 86400) {
    return unit(Math.floor(seconds / 3600), 'hour');
  }
  const days = seconds / 86400;
  if (days < 30) {
    return unit(Math.floor(days), 'day');
  }
  if (days < 365) {
    return unit(Math.floor(days / 30), 'month');
  }
  return unit(Math.floor(days / 365), 'year');
}

// Local time, YYYY-MM-DD HH:MM.
function shortDate(date) {
  const d = new Date(date);
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function lastLine(commit, now) {
  return `Last changed by ${commit.author}, ${ago(commit.date, now)} (${shortDate(commit.date)})`;
}

// ---- git ---------------------------------------------------------------------------------------------------------

// What the update pass needs of a repository at HEAD: { head, tree, mcpTexts, commits, self }, or null when it has no
// HEAD (not a repository, no commit). items: the update items (their MCP files are read).
async function readGitData({ run, repoDir, items }) {
  const headResult = await run(['rev-parse', 'HEAD'], repoDir);
  if (headResult.code !== 0 || headResult.stdout === '') {
    return null;
  }
  const head = headResult.stdout;
  const treeResult = await run(['ls-tree', '-r', '-t', '-z', 'HEAD'], repoDir, undefined, { trim: false });
  const tree = treeResult.code === 0 ? parseLsTree(treeResult.stdout) : new Map();
  const mcpTexts = new Map();
  for (const p of new Set(items.filter((i) => i.kind === 'mcp').map((i) => i.path))) {
    const r = await run(['show', `HEAD:${p}`], repoDir, undefined, { trim: false });
    if (r.code === 0) {
      mcpTexts.set(p, r.stdout);
    }
  }
  const logResult = await run(
    [
      'log',
      '-z',
      `--max-count=${LOG_LIMIT}`,
      '--no-renames',
      '--name-only',
      '--format=%x01%H%x00%an%x00%ae%x00%aI%x00%s',
      'HEAD',
    ],
    repoDir,
    undefined,
    { trim: false },
  );
  const commits = logResult.code === 0 ? parseLog(logResult.stdout) : [];
  const ident = await run(['var', 'GIT_AUTHOR_IDENT'], repoDir);
  return { head, tree, mcpTexts, commits, self: ident.code === 0 ? parseIdent(ident.stdout) : '' };
}

// The hashes of the commits in from..to.
async function rangeHashes({ run, repoDir, from, to }) {
  const r = await run(['rev-list', `${from}..${to}`], repoDir);
  return new Set(r.code === 0 ? r.stdout.split(/\r?\n/).filter((h) => h !== '') : []);
}

// The paths of the files below dir at a revision, sorted ('' is no revision: nothing).
async function treeFiles({ run, repoDir, rev, dir }) {
  if (rev === '') {
    return [];
  }
  const r = await run(['ls-tree', '-r', '-z', '--name-only', rev, '--', `${dir}/`], repoDir, undefined, { trim: false });
  return r.code === 0 ? r.stdout.split('\0').filter((f) => f !== '').sort() : [];
}

module.exports = {
  parseLsTree,
  parseLog,
  parseIdent,
  itemPath,
  pluginPath,
  updateItems,
  serverEntry,
  serverText,
  fingerprints,
  lastChanges,
  baselineRecord,
  computeMarks,
  markSeen,
  readSeen,
  writeSeen,
  noticeEntries,
  noticeText,
  noticeMessage,
  ago,
  shortDate,
  lastLine,
  readGitData,
  rangeHashes,
  treeFiles,
};
