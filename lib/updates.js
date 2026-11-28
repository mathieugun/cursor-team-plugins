'use strict';

// The update summary: what the user has seen of a repository (fingerprints of its items at HEAD, kept in
// <storage>/seen/<key>.json), which items are new or updated since, who changed them last, and the texts that say so.
// Pure logic and git readers (they take `run`, like lib/sync.js); never requires `vscode`.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { setTimeout: delay } = require('timers/promises');
const { isDeepStrictEqual } = require('util');
const catalogLib = require('./catalog');
const checks = require('./checks');
const { followRenames } = require('./repos');
const { withLock } = require('./sync');

const SEEN_VERSION = 1;
const LOG_LIMIT = 1000;
const MARKETPLACE_FILE = '.cursor-plugin/marketplace.json';

const sha1 = (text) => crypto.createHash('sha1').update(text).digest('hex');

// ---- parsing git's output ----------------------------------------------------------------------------------------

// `git ls-tree -r -t -z`: Map path -> object id (trees included).
function parseLsTree(text, modes) {
  const map = new Map();
  for (const record of String(text).split('\0')) {
    const m = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
    if (m) {
      map.set(m[3], m[2]);
      modes?.set(m[3], m[1]);
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
  // A hook group can be part of the plugin manifest alongside unrelated settings.
  return plugins.flatMap((p) =>
    p.children
      .filter((c) => c.kind !== 'hooks')
      .map((c) => ({ id: c.id, kind: c.kind, name: c.name, path: itemPath(c, repoDir) })),
  );
}

// The entry of a server in the text of an MCP file, or undefined.
function serverEntry(text, name) {
  if (typeof text !== 'string') {
    return undefined;
  }
  let obj;
  try {
    obj = checks.parseJsonc(text);
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

function mcpPaths(file) {
  const name = path.posix.basename(file);
  if (name !== '.mcp.json' && name !== 'mcp.json') {
    return [file];
  }
  const other = name === '.mcp.json' ? 'mcp.json' : '.mcp.json';
  return [file, file.slice(0, -name.length) + other];
}

function mcpFilesOf(items) {
  return [...new Set(items.flatMap((item) => item?.kind === 'mcp' && typeof item.path === 'string' ? mcpPaths(item.path) : []))].sort();
}

function unresolvedPath(file, modes) {
  while (file !== '.') {
    const mode = modes?.get(file);
    if (mode === '120000' || mode === '160000') {
      return true;
    }
    const parent = path.posix.dirname(file);
    if (parent === file) {
      break;
    }
    file = parent;
  }
  return false;
}

// True or false when HEAD supplies evidence, undefined when it cannot answer.
function committedPresence(item, git) {
  if (!git?.tree || typeof item?.path !== 'string') {
    return undefined;
  }
  const { tree, modes, mcpTexts } = git;
  if (item.kind === 'mcp') {
    const files = mcpPaths(item.path);
    if (files.some((file) => serverEntry(mcpTexts?.get(file), item.name) !== undefined)) {
      return true;
    }
    return files.every((file) => !unresolvedPath(file, modes) && (!tree.has(file) || mcpTexts?.has(file))) ? false : undefined;
  }
  const file = item.kind === 'skill' ? `${item.path}/SKILL.md` : item.path;
  if (tree.has(file) && modes?.get(file) !== '040000') {
    return true;
  }
  return unresolvedPath(file, modes) ? undefined : false;
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
// last: lastChanges; self: the user's email ('' when unknown); head; git: committed tree and files; renamed: the
// committed `renamed` object;
// plugins: its catalog plugins (for followRenames). Returns { marks: Map id -> 'new' | 'updated', removed: [{ id, path,
// kind, name, commit }], record, changed }.
function computeMarks({ items, fps, record, last, self, head, git, renamed, plugins }) {
  const marks = new Map();
  if (record === null || record === undefined) {
    return { marks, removed: [], record: baselineRecord(items, fps, head), changed: true };
  }
  const recItems = { ...record.items };
  let changed = false;
  const byId = new Map(items.map((i) => [i.id, i]));
  const own = (id) => {
    const c = last.get(id);
    return self !== '' && !!c && c.email === self;
  };

  // A rename carries the record once both sides of the move are confirmed at HEAD.
  const known = { plugins: plugins || [{ name: '', children: items }], renamed: new Map(Object.entries(renamed || {})) };
  for (const id of Object.keys(recItems)) {
    if (byId.has(id) || committedPresence(recItems[id], git) !== false) {
      continue;
    }
    const to = followRenames(known, id);
    if (fps.has(to) && committedPresence(byId.get(to), git) === true && recItems[to] === undefined) {
      const prior = recItems[id];
      const item = byId.get(to);
      recItems[to] = prior.oid === fps.get(to)
        ? entryOf(item, prior.oid, head)
        : { ...entryOf(item, prior.oid, prior.commit), seenPath: prior.seenPath ?? prior.path, seenName: prior.seenName ?? prior.name };
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
    if (byId.has(id)) {
      continue;
    }
    const rec = recItems[id];
    if (committedPresence(rec, git) !== false) {
      continue;
    }
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
  return mergeSeen(record, [{ id, previous: record?.items[id], entry }]);
}

// Only change an entry that still matches the version shown by the window.
function mergeSeen(record, changes) {
  const items = { ...record?.items };
  let changed = false;
  for (const { id, previous, entry } of changes) {
    if (!isDeepStrictEqual(items[id], previous)) {
      continue;
    }
    if (entry === null) {
      delete items[id];
    } else {
      items[id] = entry;
    }
    changed = true;
  }
  return changed ? { version: SEEN_VERSION, items } : record;
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
  const tmp = `${file}.tmp-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Keep the original write error.
    }
    throw err;
  }
  return true;
}

// Read the latest record, compute its replacement and publish it under the repository's seen lock.
// An undefined replacement leaves the file alone.
async function updateSeen(file, update) {
  const lockFile = `${file}.lock`;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await withLock({ lockFile }, async () => {
      const record = await update(readSeen(file));
      if (record) {
        writeSeen(file, record);
      }
      return { kind: 'done' };
    });
    if (result.kind === 'done') {
      return;
    }
    await delay(50);
  }
  throw new Error('the seen record is busy in another window');
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

async function readHead({ run, repoDir }) {
  const result = await run(['rev-parse', 'HEAD'], repoDir);
  return result.code === 0 && result.stdout !== '' ? result.stdout : null;
}

// Read all evidence from the same commit. A failed tree read gives no evidence, even for an empty repository.
async function readGitData({ run, repoDir, items = [], head, mcpFiles = mcpFilesOf(items) }) {
  head ??= await readHead({ run, repoDir });
  if (!head) {
    return null;
  }
  const treeResult = await run(['ls-tree', '-r', '-t', '-z', head], repoDir, undefined, { trim: false });
  if (treeResult.code !== 0) {
    return null;
  }
  const modes = new Map();
  const tree = parseLsTree(treeResult.stdout, modes);
  const mcpTexts = new Map();
  for (const p of mcpFiles.filter((file) => tree.has(file))) {
    const r = await run(['show', `${head}:${p}`], repoDir, undefined, { trim: false });
    if (r.code === 0) {
      mcpTexts.set(p, r.stdout);
    }
  }
  let renamed = {};
  if (tree.has(MARKETPLACE_FILE)) {
    const market = await run(['show', `${head}:${MARKETPLACE_FILE}`], repoDir, undefined, { trim: false });
    if (market.code === 0) {
      try {
        const value = JSON.parse(market.stdout)?.renamed;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          renamed = Object.fromEntries(Object.entries(value).filter(([from, to]) => from && typeof to === 'string' && to && from !== to));
        }
      } catch {
        // An invalid manifest supplies no rename evidence.
      }
    } else {
      renamed = null; // A failed read can be retried at this HEAD.
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
      head,
    ],
    repoDir,
    undefined,
    { trim: false },
  );
  const commits = logResult.code === 0 ? parseLog(logResult.stdout) : [];
  const ident = await run(['var', 'GIT_AUTHOR_IDENT'], repoDir);
  const complete = logResult.code === 0 && renamed !== null && mcpFiles.every((file) => !tree.has(file) || mcpTexts.has(file));
  return { head, tree, modes, mcpTexts, renamed, complete, commits, self: ident.code === 0 ? parseIdent(ident.stdout) : '' };
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
  mcpFilesOf,
  lastChanges,
  baselineRecord,
  computeMarks,
  entryOf,
  markSeen,
  mergeSeen,
  readSeen,
  writeSeen,
  updateSeen,
  noticeEntries,
  noticeText,
  noticeMessage,
  ago,
  shortDate,
  lastLine,
  readHead,
  readGitData,
  rangeHashes,
  treeFiles,
};
