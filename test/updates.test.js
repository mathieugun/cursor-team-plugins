'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const updates = require('../lib/updates');
const { makeGit } = require('../lib/git');
const { tmpDir, rmDir, writeFile, git, gitAvailable, commitAll } = require('./helpers');

const ALICE = ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', '-c', 'commit.gpgsign=false'];

test('parseLsTree reads files and trees', () => {
  const text = [
    '040000 tree 7b6c0000000000000000000000000000000000aa\treview/skills/code-review',
    '100644 blob 1111111111111111111111111111111111111111\treview/skills/code-review/SKILL.md',
    '100644 blob 2222222222222222222222222222222222222222\treview/rules/é x.mdc',
    '',
  ].join('\0');
  const map = updates.parseLsTree(text);
  assert.equal(map.size, 3);
  assert.equal(map.get('review/skills/code-review'), '7b6c0000000000000000000000000000000000aa');
  assert.equal(map.get('review/skills/code-review/SKILL.md'), '1'.repeat(40));
  assert.equal(map.get('review/rules/é x.mdc'), '2'.repeat(40));
  assert.equal(updates.parseLsTree('').size, 0);
});

test('parseLog reads commits newest first', () => {
  const field = (h, name, email, date, subject, files) =>
    `\x01${h}\0${name}\0${email}\0${date}\0${subject}\0${files.length ? `\n${files.join('\0')}\0` : ''}`;
  const text =
    field('a'.repeat(40), 'Alice', 'Alice@Example.COM', '2026-11-26T10:00:00+01:00', 'two lines', [
      'review/skills/code-review/SKILL.md',
      'review/rules/é x.mdc',
    ]) +
    field('b'.repeat(40), 'Bob', 'bob@example.com', '2026-11-25T10:00:00+01:00', 'merge', []) +
    field('c'.repeat(40), 'Test', 'test@example.com', '2026-11-24T10:00:00+01:00', 'one', ['a.md']);
  const commits = updates.parseLog(text);
  assert.equal(commits.length, 3);
  assert.deepEqual(
    commits.map((c) => c.hash),
    ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)],
  );
  assert.equal(commits[0].author, 'Alice');
  assert.equal(commits[0].email, 'alice@example.com');
  assert.equal(commits[0].date, '2026-11-26T10:00:00+01:00');
  assert.equal(commits[0].subject, 'two lines');
  assert.deepEqual(commits[0].files, ['review/skills/code-review/SKILL.md', 'review/rules/é x.mdc']);
  assert.deepEqual(commits[1].files, []);
  assert.deepEqual(commits[2].files, ['a.md']);
  assert.deepEqual(updates.parseLog(''), []);
});

test('parseIdent', () => {
  assert.equal(updates.parseIdent('Agent <A@X.org> 1795716034 +0100'), 'a@x.org');
  assert.equal(updates.parseIdent(''), '');
  assert.equal(updates.parseIdent('no email'), '');
});

test('itemPath', () => {
  const repo = path.join(path.sep, 'r', 'repo');
  const skill = { kind: 'skill', file: path.join(repo, 'review', 'skills', 'code-review', 'SKILL.md') };
  const rule = { kind: 'rule', file: path.join(repo, 'review', 'rules', 'style.mdc') };
  const mcp = { kind: 'mcp', file: path.join(repo, 'review', 'mcp.json') };
  assert.equal(updates.itemPath(skill, repo), 'review/skills/code-review');
  assert.equal(updates.itemPath(rule, repo), 'review/rules/style.mdc');
  assert.equal(updates.itemPath(mcp, repo), 'review/mcp.json');
  assert.equal(updates.pluginPath({ dir: path.join(repo, 'review') }, repo), 'review');
});

test('serverEntry and serverText', () => {
  const table = JSON.stringify({ mcpServers: { lint: { command: 'lint', args: ['-x'] }, tickets: { url: 'http://t' } } });
  const top = JSON.stringify({ $schema: 'x', lint: { command: 'lint' }, author: { name: 'a' } });
  assert.deepEqual(updates.serverEntry(table, 'lint'), { command: 'lint', args: ['-x'] });
  assert.deepEqual(updates.serverEntry(`﻿${table}`, 'tickets'), { url: 'http://t' });
  assert.deepEqual(updates.serverEntry(top, 'lint'), { command: 'lint' });
  assert.equal(updates.serverEntry(top, 'author'), undefined);
  assert.equal(updates.serverEntry(table, 'nope'), undefined);
  assert.equal(updates.serverEntry('{ not json', 'lint'), undefined);
  assert.deepEqual(updates.serverEntry('{ // c\n "mcpServers": {"lint": {"command": "x"},},\n}', 'lint'), { command: 'x' });
  assert.equal(updates.serverEntry(undefined, 'lint'), undefined);
  assert.equal(updates.serverText(table, 'tickets'), '{\n  "tickets": {\n    "url": "http://t"\n  }\n}\n');
  assert.equal(updates.serverText(table, 'nope'), '');
  assert.equal(updates.serverText('{ not json', 'lint'), '');
});

test('fingerprints', () => {
  const items = [
    { id: 'p/skills/a', kind: 'skill', name: 'a', path: 'p/skills/a' },
    { id: 'p/skills/gone', kind: 'skill', name: 'gone', path: 'p/skills/gone' },
    { id: 'p/rules/r.mdc', kind: 'rule', name: 'r', path: 'p/rules/r.mdc' },
    { id: 'p/mcp/lint', kind: 'mcp', name: 'lint', path: 'p/mcp.json' },
    { id: 'p/mcp/tickets', kind: 'mcp', name: 'tickets', path: 'p/mcp.json' },
    { id: 'p/mcp/other', kind: 'mcp', name: 'other', path: 'p/missing.json' },
  ];
  const tree = new Map([
    ['p/skills/a', 'aaa'],
    ['p/rules/r.mdc', 'rrr'],
  ]);
  const mcp = (lintCommand) =>
    new Map([['p/mcp.json', JSON.stringify({ mcpServers: { lint: { command: lintCommand }, tickets: { url: 'u' } } })]]);
  const one = updates.fingerprints(items, tree, mcp('lint'));
  assert.equal(one.get('p/skills/a'), 'aaa');
  assert.equal(one.get('p/rules/r.mdc'), 'rrr');
  assert.ok(!one.has('p/skills/gone'));
  assert.ok(!one.has('p/mcp/other'));
  assert.match(one.get('p/mcp/lint'), /^mcp:[0-9a-f]{40}$/);
  const two = updates.fingerprints(items, tree, mcp('lint2'));
  assert.notEqual(two.get('p/mcp/lint'), one.get('p/mcp/lint'));
  assert.equal(two.get('p/mcp/tickets'), one.get('p/mcp/tickets'));
});

test('lastChanges', () => {
  const commit = (hash, ...files) => ({ hash, author: 'x', email: 'x@x', date: '', subject: '', files });
  const commits = [
    commit('new', 'review/skills/code-review-2/SKILL.md', 'review/rules/style.mdc'),
    commit('mid', 'review/skills/code-review/SKILL.md'),
    commit('old', 'review/skills/code-review/SKILL.md', 'docs/a.md'),
  ];
  const paths = new Map([
    ['review/skills/code-review', 'review/skills/code-review'],
    ['review', 'review'],
    ['rule', 'review/rules/style.mdc'],
    ['unknown', 'nope/x'],
  ]);
  const last = updates.lastChanges(paths, commits);
  assert.equal(last.get('review/skills/code-review').hash, 'mid');
  assert.equal(last.get('review').hash, 'new');
  assert.equal(last.get('rule').hash, 'new');
  assert.ok(!last.has('unknown'));
  assert.equal(updates.lastChanges(new Map(), commits).size, 0);
});

const item = (id, kind = 'skill') => {
  const parts = id.split('/');
  return { id, kind, name: parts[parts.length - 1], path: id };
};
const commitBy = (hash, email, author = 'Someone') => ({ hash, author, email, date: '2026-11-26T10:00:00+01:00', subject: `s ${hash}`, files: [] });
const rec = (oid, extra = {}) => ({ oid, commit: 'old', path: 'x', kind: 'skill', name: 'x', ...extra });

test('computeMarks: a repository never seen is a baseline', () => {
  const items = [item('p/skills/a'), item('p/skills/b'), item('p/skills/c')];
  const fps = new Map([
    ['p/skills/a', '1'],
    ['p/skills/b', '2'],
  ]);
  const r = updates.computeMarks({ items, fps, record: null, last: new Map(), self: '', head: 'H', renamed: {} });
  assert.equal(r.marks.size, 0);
  assert.deepEqual(r.removed, []);
  assert.equal(r.changed, true);
  assert.deepEqual(Object.keys(r.record.items), ['p/skills/a', 'p/skills/b']);
  assert.deepEqual(r.record.items['p/skills/a'], { oid: '1', commit: 'H', path: 'p/skills/a', kind: 'skill', name: 'a' });
});

test('computeMarks: unchanged, updated, new', () => {
  const items = [item('p/skills/a'), item('p/skills/b'), item('p/skills/c')];
  const record = { version: 1, items: { 'p/skills/a': rec('1'), 'p/skills/b': rec('2') } };
  const same = updates.computeMarks({
    items: items.slice(0, 2),
    fps: new Map([
      ['p/skills/a', '1'],
      ['p/skills/b', '2'],
    ]),
    record,
    last: new Map(),
    self: 'me@x.org',
    head: 'H',
    renamed: {},
  });
  assert.equal(same.marks.size, 0);
  assert.equal(same.changed, false);

  const last = new Map([
    ['p/skills/b', commitBy('c1', 'alice@example.com', 'Alice')],
    ['p/skills/c', commitBy('c2', 'alice@example.com', 'Alice')],
  ]);
  const r = updates.computeMarks({
    items,
    fps: new Map([
      ['p/skills/a', '1'],
      ['p/skills/b', '22'],
      ['p/skills/c', '3'],
    ]),
    record,
    last,
    self: 'me@x.org',
    head: 'H',
    renamed: {},
  });
  assert.deepEqual([...r.marks], [
    ['p/skills/b', 'updated'],
    ['p/skills/c', 'new'],
  ]);
  assert.equal(r.changed, false);
  assert.equal(r.record.items['p/skills/b'].oid, '2');
});

test('computeMarks: the user\'s own changes are recorded, not marked', () => {
  const items = [item('p/skills/a')];
  const record = { version: 1, items: { 'p/skills/a': rec('1') } };
  const last = new Map([['p/skills/a', commitBy('c1', 'me@x.org', 'Me')]]);
  const args = { items, fps: new Map([['p/skills/a', '2']]), record, last, head: 'H', renamed: {} };
  const own = updates.computeMarks({ ...args, self: 'me@x.org' });
  assert.equal(own.marks.size, 0);
  assert.equal(own.changed, true);
  assert.equal(own.record.items['p/skills/a'].oid, '2');
  assert.equal(own.record.items['p/skills/a'].commit, 'H');
  const unknown = updates.computeMarks({ ...args, self: '' });
  assert.deepEqual([...unknown.marks], [['p/skills/a', 'updated']]);
  assert.equal(unknown.changed, false);
});

test('computeMarks: removed items', () => {
  const record = {
    version: 1,
    items: {
      'p/skills/a': rec('1'),
      'p/skills/gone': rec('2', { path: 'p/skills/gone', name: 'gone', commit: 'c0' }),
      'p/skills/mine': rec('3', { path: 'p/skills/mine', name: 'mine' }),
    },
  };
  const last = new Map([
    ['p/skills/gone', commitBy('c1', 'alice@example.com', 'Alice')],
    ['p/skills/mine', commitBy('c2', 'me@x.org', 'Me')],
  ]);
  const r = updates.computeMarks({
    items: [item('p/skills/a')],
    fps: new Map([['p/skills/a', '1']]),
    record,
    last,
    self: 'me@x.org',
    head: 'H',
    renamed: {},
  });
  assert.deepEqual(r.removed, [{ id: 'p/skills/gone', path: 'p/skills/gone', kind: 'skill', name: 'gone', commit: 'c0' }]);
  assert.equal(r.changed, true);
  assert.deepEqual(Object.keys(r.record.items), ['p/skills/a', 'p/skills/gone']);
  const noSelf = updates.computeMarks({
    items: [item('p/skills/a')],
    fps: new Map([['p/skills/a', '1']]),
    record,
    last,
    self: '',
    head: 'H',
    renamed: {},
  });
  assert.deepEqual(noSelf.removed.map((x) => x.id), ['p/skills/gone', 'p/skills/mine']);
});

test('computeMarks: a rename moves the record', () => {
  const record = { version: 1, items: { 'review/skills/old': rec('1') } };
  const renamed = { 'review/skills/old': 'review/skills/new' };
  const base = { items: [item('review/skills/new')], record, last: new Map(), self: '', head: 'H', renamed };
  const changedContent = updates.computeMarks({ ...base, fps: new Map([['review/skills/new', '2']]) });
  assert.deepEqual([...changedContent.marks], [['review/skills/new', 'updated']]);
  assert.deepEqual(changedContent.removed, []);
  assert.equal(changedContent.changed, true);
  assert.deepEqual(Object.keys(changedContent.record.items), ['review/skills/new']);
  const sameContent = updates.computeMarks({ ...base, fps: new Map([['review/skills/new', '1']]) });
  assert.equal(sameContent.marks.size, 0);
  assert.equal(sameContent.changed, true);
  assert.equal(sameContent.record.items['review/skills/new'].oid, '1');
  // without the record of the rename the old item is removed and the new one is new
  const unrecorded = updates.computeMarks({ ...base, renamed: {}, fps: new Map([['review/skills/new', '1']]) });
  assert.deepEqual([...unrecorded.marks], [['review/skills/new', 'new']]);
  assert.deepEqual(unrecorded.removed.map((x) => x.id), ['review/skills/old']);
});

test('computeMarks: an item that is not committed is left alone', () => {
  const record = { version: 1, items: { 'p/skills/a': rec('1') } };
  const r = updates.computeMarks({
    items: [item('p/skills/a'), item('p/skills/draft')],
    fps: new Map(),
    record,
    last: new Map(),
    self: '',
    head: 'H',
    renamed: {},
  });
  assert.equal(r.marks.size, 0);
  assert.deepEqual(r.removed, []);
  assert.equal(r.changed, false);
  assert.deepEqual(r.record, record);
});

test('markSeen', () => {
  const record = { version: 1, items: { a: rec('1'), b: rec('2') } };
  const copy = JSON.stringify(record);
  const entry = { oid: '9', commit: 'H', path: 'a', kind: 'skill', name: 'a' };
  assert.deepEqual(updates.markSeen(record, 'a', entry).items.a, entry);
  assert.deepEqual(Object.keys(updates.markSeen(record, 'c', entry).items), ['a', 'b', 'c']);
  assert.deepEqual(Object.keys(updates.markSeen(record, 'a', null).items), ['b']);
  assert.equal(JSON.stringify(record), copy);
});

test('the seen record is written only when it changes', (t) => {
  const dir = tmpDir();
  t.after(() => rmDir(dir));
  const file = path.join(dir, 'seen', 'k.json');
  assert.equal(updates.readSeen(file), null);
  const record = { version: 1, items: { a: rec('1') } };
  assert.equal(updates.writeSeen(file, record), true);
  assert.deepEqual(updates.readSeen(file), record);
  assert.equal(updates.writeSeen(file, record), false);
  assert.equal(updates.writeSeen(file, { version: 1, items: {} }), true);
  assert.ok(!fs.existsSync(`${file}.tmp`));
  fs.writeFileSync(file, '{ not json');
  assert.equal(updates.readSeen(file), null);
  fs.writeFileSync(file, JSON.stringify({ version: 2, items: {} }));
  assert.equal(updates.readSeen(file), null);
  fs.writeFileSync(file, '[]');
  assert.equal(updates.readSeen(file), null);
});

test('noticeEntries and noticeText', () => {
  const items = [item('p/skills/a'), item('p/skills/b'), item('p/skills/c'), item('p/skills/d')];
  const marks = new Map([
    ['p/skills/a', 'new'],
    ['p/skills/b', 'updated'],
    ['p/skills/c', 'updated'],
    ['p/skills/d', 'updated'],
  ]);
  const last = new Map([
    ['p/skills/a', commitBy('c1', 'a@x', 'Alice')],
    ['p/skills/b', commitBy('c2', 'b@x', 'Bob')],
    ['p/skills/c', commitBy('c3', 'a@x', 'Alice')],
    ['p/skills/d', commitBy('c0', 'a@x', 'Alice')], // before the range
    ['p/skills/gone', commitBy('c4', 'b@x', 'Bob')],
  ]);
  const removed = [{ id: 'p/skills/gone', path: 'p/skills/gone', kind: 'skill', name: 'gone', commit: 'x' }];
  const range = new Set(['c1', 'c2', 'c3', 'c4']);
  const entries = updates.noticeEntries({ marks, removed, last, range, items, enabled: new Set(['p/skills/b', 'p/skills/c']) });
  assert.deepEqual(
    entries.map((e) => `${e.author} ${e.verb} ${e.name}`),
    ['Bob updated b', 'Alice updated c', 'Alice added a', 'Bob removed gone'],
  );
  assert.equal(entries[0].id, 'p/skills/b');

  const e = (author, verb, name) => ({ id: name, verb, author, name });
  const one = [e('Alice', 'updated', 'code-review')];
  const four = [e('Alice', 'updated', 'code-review'), e('Bob', 'added', 'lint'), e('Bob', 'added', 'x'), e('Bob', 'removed', 'y')];
  assert.equal(
    updates.noticeText('team-test', one),
    'Team plugins (team-test): Alice updated code-review. Start a new chat to use the changes.',
  );
  assert.equal(
    updates.noticeText('team-test', four.slice(0, 2)),
    'Team plugins (team-test): Alice updated code-review and Bob added lint. Start a new chat to use the changes.',
  );
  assert.equal(
    updates.noticeText('team-test', four.slice(0, 3)),
    'Team plugins (team-test): Alice updated code-review, Bob added lint and 1 more. Start a new chat to use the changes.',
  );
  assert.equal(
    updates.noticeText('team-test', four),
    'Team plugins (team-test): Alice updated code-review, Bob added lint and 2 more. Start a new chat to use the changes.',
  );
  assert.equal(
    updates.noticeText('team-test', one, { kept: 2 }),
    'Team plugins (team-test): Alice updated code-review. Start a new chat to use the changes. Your local changes were kept.',
  );
});

test('noticeMessage', () => {
  const entries = [{ id: 'a', verb: 'updated', author: 'Alice', name: 'a' }];
  const commits = [commitBy('c1', 'me@x.org'), commitBy('c2', 'me@x.org')];
  const range = new Set(['c1', 'c2']);
  const base = { repoName: 'team', entries: [], kept: 0, count: 2, range, commits, self: 'me@x.org' };
  assert.deepEqual(updates.noticeMessage({ ...base, entries }), {
    text: 'Team plugins (team): Alice updated a. Start a new chat to use the changes.',
    button: true,
  });
  // only the user's own commits: nothing
  assert.equal(updates.noticeMessage(base), null);
  // commits that touch no item, by someone else: today's message, without a button
  assert.deepEqual(updates.noticeMessage({ ...base, commits: [commitBy('c1', 'a@x'), commitBy('c2', 'me@x.org')], kept: 1 }), {
    text: 'Team plugins: team updated (2 new commit(s)). Start a new chat to use the changes. Your local changes were kept.',
    button: false,
  });
  // the user is unknown: the message stays
  assert.equal(updates.noticeMessage({ ...base, self: '' }).button, false);
  // commits older than the log: the message stays
  assert.equal(updates.noticeMessage({ ...base, commits: [] }).button, false);
});

test('ago and shortDate', () => {
  const now = new Date(2026, 10, 26, 12, 0, 0);
  const before = (seconds) => new Date(now.getTime() - seconds * 1000);
  assert.equal(updates.ago(before(0), now), 'just now');
  assert.equal(updates.ago(before(59), now), 'just now');
  assert.equal(updates.ago(before(60), now), '1 minute ago');
  assert.equal(updates.ago(before(150), now), '2 minutes ago');
  assert.equal(updates.ago(before(3600), now), '1 hour ago');
  assert.equal(updates.ago(before(2 * 3600), now), '2 hours ago');
  assert.equal(updates.ago(before(86400), now), '1 day ago');
  assert.equal(updates.ago(before(5 * 86400), now), '5 days ago');
  assert.equal(updates.ago(before(45 * 86400), now), '1 month ago');
  assert.equal(updates.ago(before(100 * 86400), now), '3 months ago');
  assert.equal(updates.ago(before(400 * 86400), now), '1 year ago');
  assert.equal(updates.ago(before(-3600), now), 'just now');
  assert.equal(updates.ago(before(7200).toISOString(), now), '2 hours ago');
  assert.equal(updates.shortDate(new Date(2026, 10, 24, 9, 5)), '2026-11-24 09:05');
  const commit = { author: 'Alice', date: new Date(2026, 10, 26, 10, 0, 0).toISOString() };
  assert.equal(updates.lastLine(commit, now), 'Last changed by Alice, 2 hours ago (2026-11-26 10:00)');
});

function makeRepo(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-q', '-b', 'main'], repo);
  writeFile(repo, 'review/skills/code-review/SKILL.md', '---\nname: code-review\n---\none\n');
  writeFile(repo, 'review/mcp.json', JSON.stringify({ mcpServers: { lint: { command: 'lint' } } }));
  commitAll(repo, 'first');
  fs.appendFileSync(path.join(repo, 'review', 'skills', 'code-review', 'SKILL.md'), 'two\n');
  writeFile(repo, 'review/skills/code-review/checklist.md', 'list\n');
  git(['add', '-A'], repo);
  git([...ALICE, 'commit', '-q', '-m', 'Improve code-review'], repo);
  return { root, repo };
}

test('readGitData, rangeHashes and treeFiles on a repository', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { root, repo } = makeRepo(t);
  const run = makeGit();
  const items = [
    { id: 'review/skills/code-review', kind: 'skill', name: 'code-review', path: 'review/skills/code-review' },
    { id: 'review/mcp/lint', kind: 'mcp', name: 'lint', path: 'review/mcp.json' },
  ];
  const data = await updates.readGitData({ run, repoDir: repo, items });
  const head = git(['rev-parse', 'HEAD'], repo);
  assert.equal(data.head, head);
  assert.ok(data.tree.has('review/skills/code-review'));
  assert.ok(data.tree.has('review/skills/code-review/checklist.md'));
  assert.equal(data.commits.length, 2);
  assert.equal(data.commits[0].author, 'Alice');
  assert.equal(data.commits[0].email, 'alice@example.com');
  assert.equal(data.commits[0].subject, 'Improve code-review');
  assert.deepEqual(data.commits[0].files, ['review/skills/code-review/SKILL.md', 'review/skills/code-review/checklist.md']);
  assert.ok(data.mcpTexts.get('review/mcp.json').includes('"lint"'));
  assert.equal(typeof data.self, 'string');

  const fps = updates.fingerprints(items, data.tree, data.mcpTexts);
  assert.equal(fps.get('review/skills/code-review'), git(['rev-parse', 'HEAD:review/skills/code-review'], repo));
  const last = updates.lastChanges(new Map([['s', 'review/skills/code-review'], ['m', 'review/mcp.json']]), data.commits);
  assert.equal(last.get('s').author, 'Alice');
  assert.equal(last.get('m').subject, 'first');

  const first = git(['rev-parse', 'HEAD~1'], repo);
  const range = await updates.rangeHashes({ run, repoDir: repo, from: first, to: head });
  assert.deepEqual([...range], [head]);
  assert.equal((await updates.rangeHashes({ run, repoDir: repo, from: 'nope', to: head })).size, 0);

  assert.deepEqual(await updates.treeFiles({ run, repoDir: repo, rev: 'HEAD', dir: 'review/skills/code-review' }), [
    'review/skills/code-review/SKILL.md',
    'review/skills/code-review/checklist.md',
  ]);
  assert.deepEqual(await updates.treeFiles({ run, repoDir: repo, rev: first, dir: 'review/skills/code-review' }), [
    'review/skills/code-review/SKILL.md',
  ]);
  assert.deepEqual(await updates.treeFiles({ run, repoDir: repo, rev: '', dir: 'review/skills/code-review' }), []);
  assert.deepEqual(await updates.treeFiles({ run, repoDir: repo, rev: 'nope', dir: 'review' }), []);

  const notRepo = path.join(root, 'plain');
  fs.mkdirSync(notRepo);
  assert.equal(await updates.readGitData({ run, repoDir: notRepo, items }), null);
});
