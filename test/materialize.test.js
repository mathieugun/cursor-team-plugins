'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const {
  holderName,
  copyRootOf,
  syncCopy,
  markCopySynced,
  resolveConflict,
  conflictVersions,
  gcFiltered,
  hashCache,
  caseInsensitive,
} = require('../lib/materialize');
const { removeTree } = require('../lib/sync');
const { spawnSync } = require('child_process');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

function setup(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const repo = path.join(root, 'repo');
  makePlugin(repo, 'p', {
    name: 'p',
    skills: ['a', 'b'],
    rules: ['x.mdc', 'y.mdc'],
    extra: { 'hooks/z.md': 'agent', '.git/HEAD': 'ref: x' },
  });
  const plugin = readCatalog(repo).plugins[0];
  return { root, plugin };
}

const SKILL_A = 'skills/a/SKILL.md';
const FOUR = ['.cursor-plugin/plugin.json', 'rules/x.mdc', 'hooks/z.md', SKILL_A].sort();

function setupCopy(t) {
  return buildCopy(setup(t));
}

// The first sync of a partial copy of the plugin set up by `setup`, its holder below `parent`.
function buildCopy(f, parent = path.join(f.root, 'filtered')) {
  f.ids = ['p/skills/a', 'p/rules/x.mdc'];
  f.holder = path.join(parent, holderName(f.plugin, f.ids));
  f.first = syncCopy(f.plugin, f.ids, f.holder);
  f.copyRoot = f.first.copyRoot;
  f.manifest = () => JSON.parse(fs.readFileSync(path.join(f.holder, '.team-plugins-sync.json'), 'utf8'));
  f.src = (rel) => path.join(f.plugin.dir, rel);
  f.cp = (rel) => path.join(f.copyRoot, rel);
  return f;
}

function setMtime(file, ms) {
  fs.utimesSync(file, ms / 1000, ms / 1000);
}

test('the first syncCopy copies only the selected children', (t) => {
  const f = setupCopy(t);
  // the copy keeps the plugin's folder name: Cursor names an extension plugin after its folder
  assert.equal(f.copyRoot, path.join(f.holder, 'p'));
  assert.deepEqual(f.first.actions, []);
  for (const rel of FOUR) {
    assert.ok(fs.existsSync(f.cp(rel)), rel);
  }
  for (const rel of ['skills/b', 'rules/y.mdc', '.git']) {
    assert.ok(!fs.existsSync(f.cp(rel)), rel);
  }
  assert.equal(f.manifest().version, 2);
  assert.deepEqual(Object.keys(f.manifest().files).sort(), FOUR);
  assert.deepEqual(f.manifest().conflicts, []);
  assert.deepEqual(f.first.conflicts, []);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'filtered')).filter((n) => n.includes('.tmp-')), []);
});

test('holderName depends on the plugin and the selection only', (t) => {
  const { plugin } = setup(t);
  const ids = ['p/skills/a', 'p/rules/x.mdc'];
  const a = holderName(plugin, ids);
  assert.match(a, /^p-[0-9a-f]{12}$/);
  assert.equal(holderName(plugin, [...ids].reverse()), a);
  assert.notEqual(holderName(plugin, ['p/skills/a']), a);
  fs.appendFileSync(path.join(plugin.dir, 'skills', 'a', 'SKILL.md'), 'more text');
  assert.equal(holderName(plugin, ids), a);
});

test('an edit of the copy goes to the repository', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.cp(SKILL_A), 'edited by the agent');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toSource', rel: SKILL_A }]);
  assert.equal(fs.readFileSync(f.src(SKILL_A), 'utf8'), 'edited by the agent');
});

test('an edit of the repository goes to the copy', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.src(SKILL_A), 'edited by the team');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toCopy', rel: SKILL_A }]);
  assert.equal(fs.readFileSync(f.cp(SKILL_A), 'utf8'), 'edited by the team');
});

test('new files go both ways', (t) => {
  const f = setupCopy(t);
  writeFile(f.copyRoot, 'skills/a/notes.md', 'notes');
  let r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toSource', rel: 'skills/a/notes.md' }]);
  assert.equal(fs.readFileSync(f.src('skills/a/notes.md'), 'utf8'), 'notes');
  writeFile(f.plugin.dir, 'hooks/new.md', 'new');
  r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toCopy', rel: 'hooks/new.md' }]);
  assert.equal(fs.readFileSync(f.cp('hooks/new.md'), 'utf8'), 'new');
});

test('deletions go both ways', (t) => {
  const f = setupCopy(t);
  fs.rmSync(f.cp('hooks/z.md'));
  let r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'deletedInSource', rel: 'hooks/z.md' }]);
  assert.ok(!fs.existsSync(f.src('hooks/z.md')));
  assert.ok(!fs.existsSync(f.src('hooks')), 'the emptied folder is removed');
  fs.rmSync(f.src('rules/x.mdc'));
  r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'deletedInCopy', rel: 'rules/x.mdc' }]);
  assert.ok(!fs.existsSync(f.cp('rules/x.mdc')));
});

test('a second syncCopy with nothing changed writes nothing', (t) => {
  const f = setupCopy(t);
  const manifest = path.join(f.holder, '.team-plugins-sync.json');
  setMtime(manifest, Date.now() - 60000);
  const before = fs.statSync(manifest).mtimeMs;
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.equal(fs.statSync(manifest).mtimeMs, before);
});

test('after markCopySynced the repository wins every difference, in place', (t) => {
  // the repository was reset to the team version: the copy's edits must not flow back into it
  const f = setupCopy(t);
  fs.writeFileSync(f.cp(SKILL_A), 'edit already pushed to a branch');
  setMtime(f.cp(SKILL_A), Date.now() - 1000);
  writeFile(f.copyRoot, 'skills/a/notes.md', 'notes already pushed');
  assert.equal(markCopySynced(f.holder), true);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [
    { action: 'toCopy', rel: SKILL_A },
    { action: 'deletedInCopy', rel: 'skills/a/notes.md' },
  ]);
  assert.equal(fs.readFileSync(f.cp(SKILL_A), 'utf8'), fs.readFileSync(f.src(SKILL_A), 'utf8'));
  assert.ok(!fs.existsSync(f.src('skills/a/notes.md')));
  assert.equal(markCopySynced(path.join(f.root, 'filtered', 'missing')), false);
});

test('children outside the selection are left alone', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.src('skills/b/SKILL.md'), 'changed');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.ok(!fs.existsSync(f.cp('skills/b')));
});

const S = (f, rel) => fs.readFileSync(f.src(rel), 'utf8');
const C = (f, rel) => fs.readFileSync(f.cp(rel), 'utf8');

function makeConflict(f) {
  fs.writeFileSync(f.src(SKILL_A), 'team');
  fs.writeFileSync(f.cp(SKILL_A), 'agent');
  return syncCopy(f.plugin, f.ids, f.holder);
}

test('both sides changed is a conflict that changes nothing', (t) => {
  const f = setupCopy(t);
  const r = makeConflict(f);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, [{ rel: SKILL_A, source: f.src(SKILL_A), copy: f.cp(SKILL_A) }]);
  assert.equal(S(f, SKILL_A), 'team');
  assert.equal(C(f, SKILL_A), 'agent');
  assert.deepEqual(f.manifest().conflicts, [SKILL_A]);
  const again = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(again.actions, []);
  assert.deepEqual(again.conflicts, r.conflicts);
});

test('both sides changed the same way is not a conflict', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.src(SKILL_A), 'same');
  fs.writeFileSync(f.cp(SKILL_A), 'same');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, []);
  assert.equal(f.manifest().files[SKILL_A], crypto.createHash('sha1').update('same').digest('hex'));
});

test('a deletion against an edit is a conflict', (t) => {
  const f = setupCopy(t);
  fs.rmSync(f.cp('hooks/z.md'));
  fs.writeFileSync(f.src('hooks/z.md'), 'team');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts.map((c) => c.rel), ['hooks/z.md']);
  assert.equal(S(f, 'hooks/z.md'), 'team');
});

test('resolveConflict keeps the repository version', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  const shown = conflictVersions(f.plugin, f.holder, SKILL_A);
  assert.deepEqual(resolveConflict(f.plugin, f.holder, SKILL_A, 'source', shown), {
    action: 'toCopy',
    rel: SKILL_A,
  });
  assert.equal(C(f, SKILL_A), 'team');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(f.manifest().conflicts, []);
});

test('resolveConflict keeps the copy version', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  const shown = conflictVersions(f.plugin, f.holder, SKILL_A);
  assert.deepEqual(resolveConflict(f.plugin, f.holder, SKILL_A, 'copy', shown), {
    action: 'toSource',
    rel: SKILL_A,
  });
  assert.equal(S(f, SKILL_A), 'agent');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(f.manifest().conflicts, []);
});

// readFileSync throws `code` for the file `file` (compared resolved, case-insensitive on Windows); the hash cache is
// cleared so the file is read
function unreadableFile(t, file, code = 'EACCES') {
  const real = fs.readFileSync;
  const key = (p) => (process.platform === 'win32' ? path.resolve(String(p)).toLowerCase() : path.resolve(String(p)));
  hashCache.entries.clear();
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (typeof p === 'string' && key(p) === key(file)) {
      throw Object.assign(new Error(`${code}: cannot open ${p}`), { code });
    }
    return real.call(fs, p, ...rest);
  });
}

test('a conflict side that can not be read is never taken for a deletion', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  // unreadable before the dialog: no versions to offer
  unreadableFile(t, f.cp(SKILL_A));
  assert.throws(
    () => conflictVersions(f.plugin, f.holder, SKILL_A),
    /the partial copy version of skills\/a\/SKILL\.md can't be read \(EACCES\)/,
  );
  t.mock.restoreAll();
  // unreadable between the dialog and the choice: Keep copy version refuses
  const shown = conflictVersions(f.plugin, f.holder, SKILL_A);
  unreadableFile(t, f.cp(SKILL_A));
  assert.throws(() => resolveConflict(f.plugin, f.holder, SKILL_A, 'copy', shown), /can't be read \(EACCES\)/);
  t.mock.restoreAll();
  assert.equal(S(f, SKILL_A), 'team');
  assert.equal(C(f, SKILL_A), 'agent');
  assert.deepEqual(f.manifest().conflicts, [SKILL_A]);
});

test('resolveConflict with the kept side deleted deletes the other', (t) => {
  const f = setupCopy(t);
  fs.rmSync(f.cp('hooks/z.md'));
  fs.writeFileSync(f.src('hooks/z.md'), 'team');
  syncCopy(f.plugin, f.ids, f.holder);
  const shown = conflictVersions(f.plugin, f.holder, 'hooks/z.md');
  assert.deepEqual(resolveConflict(f.plugin, f.holder, 'hooks/z.md', 'copy', shown), {
    action: 'deletedInSource',
    rel: 'hooks/z.md',
  });
  assert.ok(!fs.existsSync(f.src('hooks/z.md')));
  assert.throws(() => resolveConflict(f.plugin, f.holder, '../x', 'copy', shown));
  assert.throws(() => resolveConflict(f.plugin, f.holder, SKILL_A, 'both', shown));
});

const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');

test('conflictVersions hashes both sides, null for a missing file', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  assert.deepEqual(conflictVersions(f.plugin, f.holder, SKILL_A), { source: sha1('team'), copy: sha1('agent') });
  fs.rmSync(f.cp(SKILL_A));
  assert.deepEqual(conflictVersions(f.plugin, f.holder, SKILL_A), { source: sha1('team'), copy: null });
  assert.throws(() => conflictVersions(f.plugin, f.holder, '../x'));
});

test('a stale conflict choice changes nothing', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  const shown = conflictVersions(f.plugin, f.holder, SKILL_A);
  // window A takes the repository version
  assert.deepEqual(resolveConflict(f.plugin, f.holder, SKILL_A, 'source', shown), {
    action: 'toCopy',
    rel: SKILL_A,
  });
  fs.writeFileSync(f.src(SKILL_A), 'newer');
  // window B still shows the old dialog and takes the copy version
  assert.deepEqual(resolveConflict(f.plugin, f.holder, SKILL_A, 'copy', shown), {
    changed: true,
    rel: SKILL_A,
  });
  assert.equal(S(f, SKILL_A), 'newer');
  assert.equal(C(f, SKILL_A), 'team');
});

test('a side edited after the choice was offered changes nothing', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  const shown = conflictVersions(f.plugin, f.holder, SKILL_A);
  fs.writeFileSync(f.cp(SKILL_A), 'agent2');
  assert.deepEqual(resolveConflict(f.plugin, f.holder, SKILL_A, 'source', shown), {
    changed: true,
    rel: SKILL_A,
  });
  assert.equal(C(f, SKILL_A), 'agent2');
  assert.equal(S(f, SKILL_A), 'team');
  assert.deepEqual(f.manifest().conflicts, [SKILL_A]);
});

test('resolveConflict without the versions shown throws', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  assert.throws(() => resolveConflict(f.plugin, f.holder, SKILL_A, 'source'));
});

test('a copy edit made after a push to a branch is not lost', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.cp('rules/x.mdc'), 'during push');
  // the clone goes back to the team version: a pushed file reverts
  fs.writeFileSync(f.src(SKILL_A), 'team version');
  // no markCopySynced: the pushed file takes the team version, the later edit reaches the clone
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.conflicts, []);
  assert.equal(C(f, SKILL_A), 'team version');
  assert.equal(S(f, 'rules/x.mdc'), 'during push');
});

// readdirSync throws `code` for the folder `dir` (compared resolved, case-insensitive on Windows)
function unreadable(t, dir, code = 'EACCES') {
  const real = fs.readdirSync;
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  t.mock.method(fs, 'readdirSync', (p, ...rest) => {
    if (key(p) === key(dir)) {
      throw Object.assign(new Error(`${code}: cannot read ${p}`), { code });
    }
    return real.call(fs, p, ...rest);
  });
}

test('an unreadable folder of the copy deletes nothing in the repository', (t) => {
  const f = setupCopy(t);
  const before = f.manifest().files;
  unreadable(t, f.cp('skills'));
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.ok(fs.existsSync(f.src(SKILL_A)));
  assert.deepEqual(r.skipped, [
    { rel: 'skills', reason: "folder can't be read in the partial copy (EACCES)", unreadable: true },
  ]);
  assert.equal(f.manifest().files[SKILL_A], before[SKILL_A]);
  t.mock.restoreAll();
  const again = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(again.actions, []);
  assert.deepEqual(again.conflicts, []);
  assert.equal(f.manifest().files[SKILL_A], before[SKILL_A]);
});

test('an unreadable folder of the repository deletes nothing in the copy', (t) => {
  const f = setupCopy(t);
  unreadable(t, f.src('skills'));
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.ok(fs.existsSync(f.cp(SKILL_A)));
  assert.deepEqual(r.skipped, [
    { rel: 'skills', reason: "folder can't be read in the repository (EACCES)", unreadable: true },
  ]);
  t.mock.restoreAll();
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, []);
});

test('an unreadable copy folder keeps everything', (t) => {
  const f = setupCopy(t);
  const before = f.manifest().files;
  unreadable(t, f.copyRoot);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  for (const rel of FOUR) {
    assert.ok(fs.existsSync(f.src(rel)), rel);
  }
  assert.deepEqual(r.skipped, [
    { rel: '', reason: "folder can't be read in the partial copy (EACCES)", unreadable: true },
  ]);
  assert.deepEqual(f.manifest().files, before);
});

test('a plugin folder gone from the repository empties nothing', (t) => {
  const f = setupCopy(t);
  removeTree(f.plugin.dir);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  for (const rel of FOUR) {
    assert.ok(fs.existsSync(f.cp(rel)), rel);
  }
  assert.deepEqual(r.skipped[0], {
    rel: '',
    reason: "folder can't be read in the repository (ENOENT)",
    unreadable: true,
  });
});

test('an edit below an unreadable folder waits', (t) => {
  const f = setupCopy(t);
  const original = S(f, SKILL_A);
  fs.writeFileSync(f.cp(SKILL_A), 'agent');
  unreadable(t, f.cp('skills'));
  syncCopy(f.plugin, f.ids, f.holder);
  assert.equal(S(f, SKILL_A), original);
  t.mock.restoreAll();
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, [{ action: 'toSource', rel: SKILL_A }]);
  assert.equal(S(f, SKILL_A), 'agent');
});

test('markCopySynced keeps the record below an unreadable folder', (t) => {
  const f = setupCopy(t);
  const before = f.manifest().files[SKILL_A];
  unreadable(t, f.cp('skills'));
  assert.equal(markCopySynced(f.holder), true);
  assert.equal(f.manifest().files[SKILL_A], before);
});

test('an unreadable record never deletes unsynced edits', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.cp(SKILL_A), 'agent');
  writeFile(f.copyRoot, 'skills/a/notes.md', 'notes');
  writeFile(f.plugin.dir, 'hooks/new.md', 'new');
  fs.writeFileSync(path.join(f.holder, '.team-plugins-sync.json'), '{"syncedAt":17');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [
    { action: 'toCopy', rel: 'hooks/new.md' },
    { action: 'toSource', rel: 'skills/a/notes.md' },
  ]);
  assert.deepEqual(r.conflicts.map((c) => c.rel), [SKILL_A]);
  assert.equal(C(f, SKILL_A), 'agent');
  assert.equal(f.manifest().version, 2);
  assert.equal(f.manifest().files[SKILL_A], '');
});

test('a v1 record is migrated', (t) => {
  const f = setupCopy(t);
  const now = Date.now();
  fs.writeFileSync(path.join(f.holder, '.team-plugins-sync.json'), JSON.stringify({ syncedAt: now, files: FOUR }));
  for (const rel of FOUR) {
    setMtime(f.cp(rel), now - 10000);
  }
  fs.writeFileSync(f.src(SKILL_A), 'team');
  fs.writeFileSync(f.cp('rules/x.mdc'), 'agent');
  fs.writeFileSync(f.src('rules/x.mdc'), 'team2');
  setMtime(f.cp('rules/x.mdc'), now + 10000);
  fs.rmSync(f.cp('hooks/z.md'));
  setMtime(f.src('hooks/z.md'), now - 10000);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [
    { action: 'deletedInSource', rel: 'hooks/z.md' },
    { action: 'toCopy', rel: SKILL_A },
  ]);
  assert.deepEqual(r.conflicts.map((c) => c.rel), ['rules/x.mdc']);
  assert.equal(f.manifest().version, 2);
});

test('markCopySynced keeps conflicts', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  assert.equal(markCopySynced(f.holder), true);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts.map((c) => c.rel), [SKILL_A]);
  assert.equal(C(f, SKILL_A), 'agent');
});

test('the record is written atomically', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.cp(SKILL_A), 'agent');
  const fd = fs.openSync(path.join(f.holder, '.team-plugins-sync.json'), 'r');
  try {
    syncCopy(f.plugin, f.ids, f.holder);
  } finally {
    fs.closeSync(fd);
  }
  assert.doesNotThrow(() => f.manifest());
  assert.deepEqual(fs.readdirSync(f.holder).filter((n) => n.includes('.tmp-')), []);
  // a stale record (the rename can fail on Windows while the record is open) is settled by content
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, []);
});

test('gcFiltered removes only old unreferenced folders', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const keep = path.join(root, 'keep');
  const old = path.join(root, 'old');
  const young = path.join(root, 'young');
  for (const d of [keep, old, young]) {
    fs.mkdirSync(d);
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  fs.utimesSync(keep, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  const removed = gcFiltered(root, [keep]);
  assert.deepEqual(removed, [old]);
  assert.ok(fs.existsSync(keep));
  assert.ok(fs.existsSync(young));
  assert.ok(!fs.existsSync(old));
});

// Links (junctions: a folder link needs no privilege on Windows)
const IDS = ['p/skills/a', 'p/rules/x.mdc'];

function junction(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'junction');
}

// setup() plus shared/l/SKILL.md at the repository root, outside the plugin, and p/skills/l linked to it
function setupLinked(t) {
  const f = setup(t);
  const repo = path.join(f.root, 'repo');
  writeFile(repo, 'shared/l/SKILL.md', '---\nname: l\ndescription: Skill l.\n---\nlinked\n');
  junction(path.join(repo, 'shared', 'l'), path.join(repo, 'p', 'skills', 'l'));
  f.repo = repo;
  f.plugin = readCatalog(repo).plugins[0];
  f.holder = path.join(f.root, 'filtered', holderName(f.plugin, IDS));
  return f;
}

function holderFor(f, ids) {
  return path.join(f.root, 'filtered', holderName(f.plugin, ids));
}

test('a linked folder inside the repository is copied as its content', (t) => {
  const f = setupLinked(t);
  const ids = ['p/skills/a', 'p/skills/l'];
  const holder = holderFor(f, ids);
  const first = syncCopy(f.plugin, ids, holder);
  const copyFile = path.join(first.copyRoot, 'skills', 'l', 'SKILL.md');
  assert.ok(fs.existsSync(copyFile));
  assert.equal(fs.lstatSync(path.join(first.copyRoot, 'skills', 'l')).isSymbolicLink(), false);
  assert.deepEqual(first.skipped, []);

  fs.writeFileSync(copyFile, 'edited in the copy');
  let r = syncCopy(f.plugin, ids, holder);
  assert.ok(r.actions.some((a) => a.action === 'toSource' && a.rel === 'skills/l/SKILL.md'));
  assert.equal(fs.readFileSync(path.join(f.repo, 'shared', 'l', 'SKILL.md'), 'utf8'), 'edited in the copy');

  fs.rmSync(copyFile);
  r = syncCopy(f.plugin, ids, holder);
  assert.ok(r.actions.some((a) => a.action === 'deletedInSource' && a.rel === 'skills/l/SKILL.md'));
  assert.ok(!fs.existsSync(path.join(f.repo, 'shared', 'l', 'SKILL.md')));
  assert.equal(fs.lstatSync(path.join(f.plugin.dir, 'skills', 'l')).isSymbolicLink(), true, 'the link survives');
});

test('a link outside the repository is left out and reported', (t) => {
  const f = setup(t);
  const outside = writeFile(f.root, 'outside/x.txt', 'outside');
  junction(path.join(f.root, 'outside'), path.join(f.plugin.dir, 'assets'));
  const holder = holderFor(f, IDS);
  const reason = 'link to a path outside the repository';
  const first = syncCopy(f.plugin, IDS, holder);
  assert.deepEqual(first.skipped, [{ rel: 'assets', reason }]);
  assert.ok(!fs.existsSync(path.join(first.copyRoot, 'assets')));
  const second = syncCopy(f.plugin, IDS, holder);
  assert.deepEqual(second.skipped, [{ rel: 'assets', reason }]);
  assert.ok(!second.actions.some((a) => a.rel.startsWith('assets')));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('a broken link is left out', (t) => {
  const f = setup(t);
  writeFile(f.root, 'tmpdir/x.txt', 'x');
  junction(path.join(f.root, 'tmpdir'), path.join(f.plugin.dir, 'gone'));
  removeTree(path.join(f.root, 'tmpdir'));
  const r = syncCopy(f.plugin, IDS, holderFor(f, IDS));
  assert.deepEqual(r.skipped, [{ rel: 'gone', reason: 'broken link' }]);
});

test('a link loop is left out', (t) => {
  const f = setup(t);
  const loop = path.join(f.plugin.dir, 'hooks', 'loop');
  junction(f.plugin.dir, loop);
  try {
    const r = syncCopy(f.plugin, IDS, holderFor(f, IDS));
    assert.deepEqual(r.skipped, [{ rel: 'hooks/loop', reason: 'link loop' }]);
    assert.ok(fs.existsSync(path.join(r.copyRoot, 'hooks', 'z.md')));
  } finally {
    // removes the link only (a junction on Windows, a symlink elsewhere): the cleanup of the temporary folder can't
    // follow a loop
    if (process.platform === 'win32') {
      fs.rmdirSync(loop);
    } else {
      fs.unlinkSync(loop);
    }
  }
});

test('a link inside the copy is never synced', (t) => {
  const f = setup(t);
  const holder = holderFor(f, IDS);
  const first = syncCopy(f.plugin, IDS, holder);
  writeFile(f.root, 'outside/x.txt', 'outside');
  junction(path.join(f.root, 'outside'), path.join(first.copyRoot, 'extra'));
  const r = syncCopy(f.plugin, IDS, holder);
  assert.ok(r.skipped.some((s) => s.rel === 'extra' && s.reason === 'link in the partial copy'));
  assert.ok(!fs.existsSync(path.join(f.plugin.dir, 'extra')));
  assert.deepEqual(r.actions, []);
});

test('an unselected linked skill is not reported', (t) => {
  const f = setupLinked(t);
  const ids = ['p/skills/a'];
  const r = syncCopy(f.plugin, ids, holderFor(f, ids));
  assert.ok(!fs.existsSync(path.join(r.copyRoot, 'skills', 'l')));
  assert.deepEqual(r.skipped, []);
});

test('copyRootOf is the copy root that syncCopy returns', (t) => {
  const f = setup(t);
  const holder = holderFor(f, IDS);
  assert.equal(copyRootOf(f.plugin, holder), syncCopy(f.plugin, IDS, holder).copyRoot);
});

const NOT_SELECTED = 'not in the selection: never copied to the repository';

test('a file at an excluded path in the copy never reaches the repository', (t) => {
  const f = setupCopy(t);
  const original = {
    b: fs.readFileSync(f.src('skills/b/SKILL.md'), 'utf8'),
    y: fs.readFileSync(f.src('rules/y.mdc'), 'utf8'),
  };
  fs.mkdirSync(path.dirname(f.cp('skills/b/SKILL.md')), { recursive: true });
  fs.writeFileSync(f.cp('skills/b/SKILL.md'), 'AGENT');
  fs.writeFileSync(f.cp('rules/y.mdc'), 'AGENT RULE');
  for (let i = 0; i < 2; i++) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.conflicts, []);
    assert.equal(fs.readFileSync(f.src('skills/b/SKILL.md'), 'utf8'), original.b);
    assert.equal(fs.readFileSync(f.src('rules/y.mdc'), 'utf8'), original.y);
    assert.equal(fs.readFileSync(f.cp('skills/b/SKILL.md'), 'utf8'), 'AGENT');
    assert.equal(fs.readFileSync(f.cp('rules/y.mdc'), 'utf8'), 'AGENT RULE');
    assert.ok(r.skipped.some((s) => s.rel === 'rules/y.mdc' && s.reason === NOT_SELECTED));
    assert.ok(r.skipped.some((s) => s.rel === 'skills/b/SKILL.md' && s.reason === NOT_SELECTED));
    assert.ok(!('skills/b/SKILL.md' in f.manifest().files));
    assert.ok(!('rules/y.mdc' in f.manifest().files));
  }
});

test('a new skill of the copy goes to the repository, then leaves the copy when it is not selected', (t) => {
  const f = setupCopy(t);
  fs.mkdirSync(path.dirname(f.cp('skills/c/SKILL.md')), { recursive: true });
  fs.writeFileSync(f.cp('skills/c/SKILL.md'), '---\ndescription: C\n---\n');
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, [{ action: 'toSource', rel: 'skills/c/SKILL.md' }]);
  const plugin = readCatalog(path.join(f.root, 'repo')).plugins[0];
  assert.ok(plugin.children.some((c) => c.id === 'p/skills/c'));
  assert.deepEqual(syncCopy(plugin, f.ids, f.holder).actions, [{ action: 'deletedInCopy', rel: 'skills/c/SKILL.md' }]);
  assert.ok(fs.existsSync(f.src('skills/c/SKILL.md')));
  assert.ok(!fs.existsSync(f.cp('skills/c/SKILL.md')));
});

test('a new skill of the copy edited after the sync stays in the copy when it is not selected', (t) => {
  const f = setupCopy(t);
  fs.mkdirSync(path.dirname(f.cp('skills/c/SKILL.md')), { recursive: true });
  fs.writeFileSync(f.cp('skills/c/SKILL.md'), '---\ndescription: C\n---\n');
  syncCopy(f.plugin, f.ids, f.holder);
  fs.writeFileSync(f.cp('skills/c/SKILL.md'), 'EDIT2');
  const plugin = readCatalog(path.join(f.root, 'repo')).plugins[0];
  const r = syncCopy(plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.equal(fs.readFileSync(f.src('skills/c/SKILL.md'), 'utf8'), '---\ndescription: C\n---\n');
  assert.equal(fs.readFileSync(f.cp('skills/c/SKILL.md'), 'utf8'), 'EDIT2');
  assert.ok(r.skipped.some((s) => s.rel === 'skills/c/SKILL.md' && s.reason === NOT_SELECTED));
});

test('holderName makes a safe folder name', (t) => {
  const { root, plugin } = setup(t);
  const ids = ['p/skills/a'];
  const filtered = path.join(root, 'filtered');
  assert.match(holderName({ ...plugin, name: 'a/b:c\\..' }, ids), /^a_b_c_\.\.-[0-9a-f]{12}$/);
  const evil = holderName({ ...plugin, name: '../../evil' }, ids);
  assert.match(evil, /^\.\._\.\._evil-[0-9a-f]{12}$/);
  assert.equal(path.dirname(path.join(filtered, evil)), filtered);
  const long = holderName({ ...plugin, name: 'x'.repeat(200) }, ids);
  assert.equal(long.slice(0, long.lastIndexOf('-')).length, 64);
  assert.notEqual(holderName({ ...plugin, name: 'a/b' }, ids), holderName({ ...plugin, name: 'a:b' }, ids));
});

test('a plugin name with path characters gets a working copy', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const repo = path.join(root, 'repo');
  makePlugin(repo, 'p', { name: 'team:review/x', skills: ['a', 'b'] });
  const plugin = readCatalog(repo).plugins[0];
  const ids = ['team:review/x/skills/a'];
  const holder = path.join(root, 'filtered', holderName(plugin, ids));
  const r = syncCopy(plugin, ids, holder);
  assert.ok(fs.existsSync(r.copyRoot));
  assert.equal(path.dirname(holder), path.join(root, 'filtered'));
  assert.ok(fs.existsSync(path.join(r.copyRoot, 'skills/a/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(r.copyRoot, 'skills/b')));
});

function cacheAll(t) {
  hashCache.racyMs = -Infinity;
  t.after(() => {
    hashCache.racyMs = 2000;
    hashCache.entries.clear();
  });
}

test('unchanged files are not read again', (t) => {
  cacheAll(t);
  const f = setupCopy(t);
  syncCopy(f.plugin, f.ids, f.holder);
  const real = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p, ...rest) => {
    if (!String(p).endsWith('.team-plugins-sync.json')) {
      reads++;
    }
    return real(p, ...rest);
  };
  try {
    assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, []);
  } finally {
    fs.readFileSync = real;
  }
  assert.equal(reads, 0);
  fs.writeFileSync(f.cp(SKILL_A), 'a longer edit by the agent');
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, [{ action: 'toSource', rel: SKILL_A }]);
});

test('a file changed in the last 2 seconds is not cached', (t) => {
  hashCache.entries.clear();
  t.after(() => hashCache.entries.clear());
  setupCopy(t);
  assert.equal(hashCache.entries.size, 0);
});

test("the sync's own writes are forgotten", (t) => {
  cacheAll(t);
  const f = setupCopy(t);
  syncCopy(f.plugin, f.ids, f.holder);
  fs.writeFileSync(f.src(SKILL_A), 'team edit');
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, [{ action: 'toCopy', rel: SKILL_A }]);
  assert.equal(hashCache.entries.has(path.resolve(f.cp(SKILL_A))), false);
});

test('a source changed while a copy is built goes to the copy, never back to the source', (t) => {
  const f = setup(t);
  const srcA = path.join(f.plugin.dir, SKILL_A);
  fs.writeFileSync(srcA, 'old');
  const ids = ['p/skills/a'];
  const holder = path.join(f.root, 'filtered', holderName(f.plugin, ids));
  const real = fs.copyFileSync;
  fs.copyFileSync = (from, to, ...rest) => {
    real(from, to, ...rest);
    if (path.resolve(from) === path.resolve(srcA)) {
      fs.writeFileSync(srcA, 'team update'); // the team's update lands right after the file was copied
    }
  };
  try {
    syncCopy(f.plugin, ids, holder);
  } finally {
    fs.copyFileSync = real;
  }
  const second = syncCopy(f.plugin, ids, holder);
  assert.deepEqual(second.actions, [{ action: 'toCopy', rel: SKILL_A }]);
  assert.equal(fs.readFileSync(srcA, 'utf8'), 'team update');
  assert.equal(fs.readFileSync(path.join(second.copyRoot, SKILL_A), 'utf8'), 'team update');
});

test('a renamed plugin keeps its copy under its new folder name, both ways', (t) => {
  const f = setup(t);
  const plugin = { ...f.plugin, folder: 'p-two' };
  const ids = ['p/skills/a', 'p/rules/x.mdc'];
  const holder = path.join(f.root, 'filtered', holderName(plugin, ids));
  const first = syncCopy(plugin, ids, holder);
  assert.equal(first.copyRoot, path.join(holder, 'p-two'));
  assert.equal(copyRootOf(plugin, holder), first.copyRoot);
  assert.ok(fs.existsSync(path.join(holder, 'p-two', SKILL_A)));
  assert.ok(!fs.existsSync(path.join(holder, 'p')));
  assert.deepEqual(fs.readdirSync(holder).filter((n) => n.includes('.tmp-')), []);

  fs.writeFileSync(path.join(first.copyRoot, SKILL_A), 'edited in the copy');
  const second = syncCopy(plugin, ids, holder);
  assert.deepEqual(second.actions, [{ action: 'toSource', rel: SKILL_A }]);
  assert.equal(fs.readFileSync(path.join(plugin.dir, SKILL_A), 'utf8'), 'edited in the copy');
  fs.writeFileSync(path.join(plugin.dir, SKILL_A), 'edited in the repository');
  assert.deepEqual(syncCopy(plugin, ids, holder).actions, [{ action: 'toCopy', rel: SKILL_A }]);
  assert.equal(fs.readFileSync(path.join(first.copyRoot, SKILL_A), 'utf8'), 'edited in the repository');
});

test('copyRootOf uses the renamed folder', () => {
  const H = path.join(path.sep, 'h');
  assert.equal(copyRootOf({ dir: '/x/review', folder: 'review-two' }, H), path.join(H, 'review-two'));
  assert.equal(copyRootOf({ dir: '/x/review' }, H), path.join(H, 'review'));
});

// ---- MCP servers, commands and agents in a partial copy ----

const MCP_REASON = 'MCP servers left out of the selection: an edit in the copy never reaches the repository';
const MCP_SOURCE = '{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}';
const ALL_IDS = ['p/skills/s', 'p/commands/c.md', 'p/agents/g.md', 'p/mcp/a', 'p/mcp/b'];
const A_ONLY_IDS = ['p/skills/s', 'p/commands/c.md', 'p/agents/g.md', 'p/mcp/a'];

function mcpSetup(t, ids) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const repo = path.join(root, 'repo');
  makePlugin(repo, 'p', {
    name: 'p',
    skills: ['s'],
    extra: { 'commands/c.md': 'command', 'agents/g.md': 'agent', 'mcp.json': MCP_SOURCE },
  });
  const f = { root, repo, ids };
  f.plugin = readCatalog(repo).plugins[0];
  f.holder = path.join(root, 'filtered', holderName(f.plugin, ids));
  f.first = syncCopy(f.plugin, ids, f.holder);
  f.copyRoot = f.first.copyRoot;
  f.src = (rel) => path.join(f.plugin.dir, rel);
  f.cp = (rel) => path.join(f.copyRoot, rel);
  return f;
}

const readJsonFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('an unselected command and agent are left out of the copy', (t) => {
  const f = mcpSetup(t, ALL_IDS.filter((id) => !id.includes('/commands/') && !id.includes('/agents/')));
  assert.ok(fs.existsSync(f.cp('skills/s/SKILL.md')));
  assert.equal(fs.readFileSync(f.cp('mcp.json'), 'utf8'), MCP_SOURCE);
  assert.ok(!fs.existsSync(f.cp('commands/c.md')));
  assert.ok(!fs.existsSync(f.cp('agents/g.md')));
});

test('a left-out MCP server is removed from the copy file', (t) => {
  const f = mcpSetup(t, A_ONLY_IDS);
  assert.deepEqual(readJsonFile(f.cp('mcp.json')), { mcpServers: { a: { command: 'x' } } });
  assert.ok(fs.existsSync(f.cp('commands/c.md')));
  assert.ok(fs.existsSync(f.cp('agents/g.md')));
  assert.equal(fs.readFileSync(f.src('mcp.json'), 'utf8'), MCP_SOURCE);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.skipped, []);
});

test('every server of a file left out drops the file', (t) => {
  const f = mcpSetup(t, ['p/skills/s']);
  assert.ok(!fs.existsSync(f.cp('mcp.json')));
  assert.ok(fs.existsSync(f.cp('skills/s/SKILL.md')));
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).actions, []);
  assert.equal(fs.readFileSync(f.src('mcp.json'), 'utf8'), MCP_SOURCE);
});

test('a source change regenerates the filtered file', (t) => {
  const f = mcpSetup(t, A_ONLY_IDS);
  fs.writeFileSync(f.src('mcp.json'), '{"mcpServers":{"a":{"command":"x2"},"b":{"command":"y"},"c":{"command":"z"}}}');
  const plugin = readCatalog(f.repo).plugins[0];
  const r = syncCopy(plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toCopy', rel: 'mcp.json' }]);
  assert.deepEqual(readJsonFile(f.cp('mcp.json')), { mcpServers: { a: { command: 'x2' } } });
  assert.deepEqual(syncCopy(plugin, f.ids, f.holder).actions, []);
});

test('an edit of the filtered file in the copy never reaches the repository', (t) => {
  const f = mcpSetup(t, A_ONLY_IDS);
  fs.writeFileSync(f.cp('mcp.json'), '{"mcpServers":{"a":{"command":"edited"}}}');
  for (let i = 0; i < 2; i++) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.equal(fs.readFileSync(f.src('mcp.json'), 'utf8'), MCP_SOURCE);
    assert.equal(fs.readFileSync(f.cp('mcp.json'), 'utf8'), '{"mcpServers":{"a":{"command":"edited"}}}');
    assert.deepEqual(r.skipped, [{ rel: 'mcp.json', reason: MCP_REASON }]);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.conflicts, []);
  }
});

test('a filtered file deleted in the copy is written again', (t) => {
  const f = mcpSetup(t, A_ONLY_IDS);
  fs.rmSync(f.cp('mcp.json'));
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toCopy', rel: 'mcp.json' }]);
  assert.deepEqual(readJsonFile(f.cp('mcp.json')), { mcpServers: { a: { command: 'x' } } });
  assert.ok(fs.existsSync(f.src('mcp.json')));
});

test('a filtered file deleted in the repository leaves the copy', (t) => {
  const f = mcpSetup(t, A_ONLY_IDS);
  fs.rmSync(f.src('mcp.json'));
  // the plugin object from before the deletion still lists the file: the "source missing" branch
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'deletedInCopy', rel: 'mcp.json' }]);
  assert.ok(!fs.existsSync(f.cp('mcp.json')));
});

test('after markCopySynced the filtered file is regenerated', (t) => {
  const f = mcpSetup(t, A_ONLY_IDS);
  fs.writeFileSync(f.cp('mcp.json'), '{"mcpServers":{"a":{"command":"edited"}}}');
  assert.equal(markCopySynced(f.holder), true);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toCopy', rel: 'mcp.json' }]);
  assert.deepEqual(readJsonFile(f.cp('mcp.json')), { mcpServers: { a: { command: 'x' } } });
});

// A case-only rename goes through an intermediate name (a direct rename may be a no-op on Windows).
function renameCase(from, to) {
  const mid = `${from}-intermediate`;
  fs.renameSync(from, mid);
  fs.renameSync(mid, to);
}

const names = (dir) => fs.readdirSync(dir).sort();
const recordKeys = (f) => Object.keys(f.manifest().files);

test('caseInsensitive tells the filesystem of a folder', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  // the answer the filesystem itself gives: a file written in one case is found in the other
  writeFile(root, 'probe/marker.txt', 'x');
  const dir = path.join(root, 'probe');
  const found = fs.existsSync(path.join(root, 'probe', 'MARKER.TXT'));
  assert.equal(caseInsensitive(dir), found);
  // a folder that is not there: the platform's usual answer, never an error
  assert.equal(typeof caseInsensitive(path.join(root, 'missing')), 'boolean');
});

test('a case-only rename of a copy file is carried to the repository', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  const text = S(f, 'rules/x.mdc');
  renameCase(f.cp('rules/x.mdc'), f.cp('rules/X.mdc'));
  for (const round of [1, 2]) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.deepEqual(r.actions, round === 1 ? [{ action: 'renamedInSource', rel: 'rules/X.mdc' }] : []);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(names(f.src('rules')), ['X.mdc', 'y.mdc']);
    assert.deepEqual(names(f.cp('rules')), ['X.mdc']);
    assert.equal(S(f, 'rules/x.mdc'), text);
    assert.equal(C(f, 'rules/x.mdc'), text);
    assert.ok(recordKeys(f).includes('rules/X.mdc'));
    assert.ok(!recordKeys(f).includes('rules/x.mdc'));
  }
});

test('a case-only rename of a copy folder is carried to the repository', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  const text = S(f, 'rules/x.mdc');
  renameCase(f.cp('rules'), f.cp('Rules'));
  for (let round = 1; round <= 2; round++) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.deepEqual(r.conflicts, []);
    assert.ok(names(f.plugin.dir).includes('Rules'));
    assert.ok(!names(f.plugin.dir).includes('rules'));
    assert.ok(names(f.copyRoot).includes('Rules'));
    assert.equal(S(f, 'rules/x.mdc'), text);
    assert.equal(C(f, 'rules/x.mdc'), text);
    assert.deepEqual(names(f.src('rules')), ['x.mdc', 'y.mdc']);
    assert.deepEqual(names(f.cp('rules')), ['x.mdc']);
  }
});

test('a case-only rename in the repository is carried to the copy', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  const text = S(f, 'rules/x.mdc');
  renameCase(f.src('rules/x.mdc'), f.src('rules/X.mdc'));
  for (const round of [1, 2]) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.deepEqual(r.actions, round === 1 ? [{ action: 'renamedInCopy', rel: 'rules/X.mdc' }] : []);
    assert.deepEqual(names(f.cp('rules')), ['X.mdc']);
    assert.deepEqual(names(f.src('rules')), ['X.mdc', 'y.mdc']);
    assert.equal(S(f, 'rules/x.mdc'), text);
    assert.equal(C(f, 'rules/x.mdc'), text);
  }
});

test('an unreadable folder in another case deletes nothing, and the spelling is carried once it can be read', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  const text = S(f, 'rules/x.mdc');
  const before = f.manifest().files['rules/x.mdc'];
  renameCase(f.cp('rules'), f.cp('Rules'));
  unreadable(t, f.cp('Rules'));
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.ok(r.skipped.some((s) => s.rel === 'Rules' && s.unreadable));
  assert.equal(S(f, 'rules/x.mdc'), text);
  assert.equal(C(f, 'rules/x.mdc'), text);
  assert.equal(f.manifest().files['rules/x.mdc'], before);
  t.mock.restoreAll();
  const again = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(again.actions, [{ action: 'renamedInSource', rel: 'Rules/x.mdc' }]);
  assert.deepEqual(names(f.src('rules')), ['x.mdc', 'y.mdc']);
  assert.ok(names(f.plugin.dir).includes('Rules'));
  assert.equal(S(f, 'rules/x.mdc'), text);
  assert.equal(C(f, 'rules/x.mdc'), text);
});

test('a spelling that differs on both sides from the record is reported, not renamed', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  const text = S(f, 'rules/x.mdc');
  renameCase(f.cp('rules'), f.cp('Rules'));
  renameCase(f.src('rules/x.mdc'), f.src('rules/X.mdc'));
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.notes, [
    {
      rel: 'Rules/x.mdc',
      reason: 'spelled rules/X.mdc in the repository and Rules/x.mdc in the partial copy: rename one of them so both match',
    },
  ]);
  assert.deepEqual(names(f.src('rules')), ['X.mdc', 'y.mdc']);
  assert.ok(names(f.copyRoot).includes('Rules'));
  assert.equal(S(f, 'rules/x.mdc'), text);
  assert.equal(C(f, 'rules/x.mdc'), text);
});

test('a copy file renamed in case and edited reaches the repository under its new spelling', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  renameCase(f.cp('rules/x.mdc'), f.cp('rules/X.mdc'));
  fs.writeFileSync(f.cp('rules/X.mdc'), 'edited');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [
    { action: 'renamedInSource', rel: 'rules/X.mdc' },
    { action: 'toSource', rel: 'rules/X.mdc' },
  ]);
  assert.deepEqual(names(f.src('rules')), ['X.mdc', 'y.mdc']);
  assert.equal(S(f, 'rules/X.mdc'), 'edited');
});

test('on a case-sensitive filesystem two names that differ only in case stay two files', (t) => {
  const f = setup(t);
  if (caseInsensitive(f.root)) {
    return t.skip('case-insensitive filesystem');
  }
  writeFile(f.plugin.dir, 'skills/a/n.txt', 'lower');
  writeFile(f.plugin.dir, 'skills/a/N.txt', 'upper');
  buildCopy(f);
  for (let round = 1; round <= 2; round++) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.deepEqual(r.notes, []);
    assert.deepEqual(r.skipped, []);
    assert.equal(C(f, 'skills/a/n.txt'), 'lower');
    assert.equal(C(f, 'skills/a/N.txt'), 'upper');
  }
  fs.writeFileSync(f.cp('skills/a/N.txt'), 'upper edited');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toSource', rel: 'skills/a/N.txt' }]);
  assert.equal(S(f, 'skills/a/N.txt'), 'upper edited');
  assert.equal(S(f, 'skills/a/n.txt'), 'lower');
});

// A new folder that looks names up with case (on Windows through fsutil's per-folder flag, inherited by the folders
// created in it; elsewhere a temp folder usually is one), or null.
function caseSensitiveDir(t) {
  const dir = tmpDir();
  t.after(() => rmDir(dir));
  if (process.platform === 'win32') {
    const r = spawnSync('fsutil.exe', ['file', 'setCaseSensitiveInfo', dir, 'enable'], { encoding: 'utf8' });
    if (r.error || r.status !== 0) {
      return null;
    }
  }
  writeFile(dir, 'marker.txt', 'x');
  return fs.existsSync(path.join(dir, 'MARKER.TXT')) ? null : dir;
}

test('caseInsensitive judges a folder by the names inside it, not by its parent', (t) => {
  if (process.platform !== 'win32') {
    return t.skip('needs a case-sensitive folder inside a case-insensitive one (Windows)');
  }
  const dir = caseSensitiveDir(t);
  if (!dir || !caseInsensitive(path.dirname(dir))) {
    return t.skip('needs a case-sensitive folder inside a case-insensitive one');
  }
  assert.equal(caseInsensitive(dir), false);
});

// A plugin repository that looks names up without case and a partial copy in a folder that does not, or null.
function mixedCopy(t) {
  const f = setup(t);
  const sensitive = caseSensitiveDir(t);
  if (!sensitive || !caseInsensitive(f.plugin.dir)) {
    return null;
  }
  return buildCopy(f, sensitive);
}

test('Keep copy version finds the copy file spelled in another case when only the repository ignores case', (t) => {
  const f = mixedCopy(t);
  if (!f) {
    return t.skip('needs a case-insensitive repository and a case-sensitive copy folder');
  }
  writeFile(f.plugin.dir, 'skills/a/Example.txt', 'base');
  syncCopy(f.plugin, f.ids, f.holder);
  fs.renameSync(f.cp('skills/a/Example.txt'), f.cp('skills/a/example.txt'));
  fs.writeFileSync(f.cp('skills/a/example.txt'), 'copy edit');
  fs.writeFileSync(f.src('skills/a/Example.txt'), 'repository edit');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(
    r.conflicts.map((c) => c.rel),
    ['skills/a/Example.txt'],
  );
  const shown = conflictVersions(f.plugin, f.holder, 'skills/a/Example.txt');
  assert.equal(shown.copy, crypto.createHash('sha1').update('copy edit').digest('hex'));
  assert.deepEqual(resolveConflict(f.plugin, f.holder, 'skills/a/Example.txt', 'copy', shown), {
    action: 'toSource',
    rel: 'skills/a/Example.txt',
  });
  assert.equal(S(f, 'skills/a/Example.txt'), 'copy edit');
  assert.equal(C(f, 'skills/a/example.txt'), 'copy edit');
});

test('Discard keeps a conflicting copy file spelled in another case when only the repository ignores case', (t) => {
  const f = mixedCopy(t);
  if (!f) {
    return t.skip('needs a case-insensitive repository and a case-sensitive copy folder');
  }
  writeFile(f.plugin.dir, 'skills/a/Example.txt', 'repository');
  writeFile(f.copyRoot, 'skills/a/example.txt', 'copy');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(
    r.conflicts.map((c) => c.rel),
    ['skills/a/Example.txt'],
  );
  // Discard: the clone loses its new file, then the copies are marked synced
  fs.rmSync(f.src('skills/a/Example.txt'));
  markCopySynced(f.holder);
  for (let round = 1; round <= 2; round++) {
    syncCopy(f.plugin, f.ids, f.holder);
    assert.equal(C(f, 'skills/a/example.txt'), 'copy');
  }
});

test('a conflict lookup that two folder spellings of a case-sensitive copy match refuses to guess', (t) => {
  const f = mixedCopy(t);
  if (!f) {
    return t.skip('needs a case-insensitive repository and a case-sensitive copy folder');
  }
  writeFile(f.plugin.dir, 'skills/a/assets/example.txt', 'base');
  writeFile(f.plugin.dir, 'skills/a/assets/other.txt', 'other');
  syncCopy(f.plugin, f.ids, f.holder);
  // an agent moves the file to `Assets/` in the copy and edits it; the repository edits it too
  fs.mkdirSync(f.cp('skills/a/Assets'));
  fs.renameSync(f.cp('skills/a/assets/example.txt'), f.cp('skills/a/Assets/example.txt'));
  fs.writeFileSync(f.cp('skills/a/Assets/example.txt'), 'copy edit');
  fs.writeFileSync(f.src('skills/a/assets/example.txt'), 'repository edit');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(
    r.conflicts.map((c) => c.rel),
    ['skills/a/assets/example.txt'],
  );
  const rel = 'skills/a/assets/example.txt';
  assert.throws(() => conflictVersions(f.plugin, f.holder, rel), /several names that differ only in case/);
  assert.throws(
    () => resolveConflict(f.plugin, f.holder, rel, 'copy', { source: null, copy: null }),
    /several names that differ only in case/,
  );
  assert.equal(S(f, rel), 'repository edit');
  assert.equal(C(f, 'skills/a/Assets/example.txt'), 'copy edit');
});

test('a conflict lookup through a copy folder that can not be listed refuses instead of reading the file as missing', (t) => {
  const f = mixedCopy(t);
  if (!f) {
    return t.skip('needs a case-insensitive repository and a case-sensitive copy folder');
  }
  const rel = 'skills/a/assets/example.txt';
  writeFile(f.plugin.dir, rel, 'base');
  syncCopy(f.plugin, f.ids, f.holder);
  fs.renameSync(f.cp('skills/a/assets'), f.cp('skills/a/Assets'));
  fs.renameSync(f.cp('skills/a/Assets/example.txt'), f.cp('skills/a/Assets/Example.txt'));
  fs.writeFileSync(f.cp('skills/a/Assets/Example.txt'), 'copy edit');
  fs.writeFileSync(f.src(rel), 'repository edit');
  assert.deepEqual(
    syncCopy(f.plugin, f.ids, f.holder).conflicts.map((c) => c.rel),
    [rel],
  );
  unreadable(t, f.cp('skills/a/Assets'));
  assert.throws(() => conflictVersions(f.plugin, f.holder, rel), /can't be read \(EACCES\)/);
  assert.throws(() => resolveConflict(f.plugin, f.holder, rel, 'copy', { source: null, copy: null }), /can't be read/);
  t.mock.restoreAll();
  assert.equal(S(f, rel), 'repository edit');
  assert.equal(C(f, 'skills/a/Assets/Example.txt'), 'copy edit');
});

test('an excluded skill never matches a selected one that differs only in case', (t) => {
  const sensitive = caseSensitiveDir(t);
  const plain = tmpDir();
  t.after(() => rmDir(plain));
  writeFile(plain, 'marker.txt', 'x');
  if (!sensitive || !fs.existsSync(path.join(plain, 'MARKER.TXT'))) {
    return t.skip('needs a case-sensitive repository folder and a case-insensitive copy folder');
  }
  const repo = path.join(sensitive, 'repo');
  makePlugin(repo, 'p', { name: 'p', skills: ['UP', 'up'] });
  const plugin = readCatalog(repo).plugins[0];
  const holder = path.join(plain, 'holder');
  const selectedText = fs.readFileSync(path.join(repo, 'p/skills/UP/SKILL.md'), 'utf8');
  for (let round = 1; round <= 2; round++) {
    const r = syncCopy(plugin, ['p/skills/UP'], holder);
    assert.deepEqual(r.actions, []);
    assert.equal(fs.readFileSync(path.join(r.copyRoot, 'skills/UP/SKILL.md'), 'utf8'), selectedText);
  }
  assert.ok(fs.existsSync(path.join(repo, 'p/skills/UP/SKILL.md')));
  assert.ok(fs.existsSync(path.join(repo, 'p/skills/up/SKILL.md')));
});

test('the first copy leaves out two names that differ only in case when the copy folder ignores case', (t) => {
  const sensitive = caseSensitiveDir(t);
  const plain = tmpDir();
  t.after(() => rmDir(plain));
  writeFile(plain, 'marker.txt', 'x');
  if (!sensitive || !fs.existsSync(path.join(plain, 'MARKER.TXT'))) {
    return t.skip('needs a case-sensitive repository folder and a case-insensitive copy folder');
  }
  const repo = path.join(sensitive, 'repo');
  makePlugin(repo, 'p', { name: 'p', skills: ['a'] });
  writeFile(repo, 'p/skills/a/n.txt', 'lower');
  writeFile(repo, 'p/skills/a/N.txt', 'upper');
  const plugin = readCatalog(repo).plugins[0];
  const holder = path.join(plain, 'holder');
  const dup = 'another file has the same name in another case: left out';
  for (let round = 1; round <= 2; round++) {
    const r = syncCopy(plugin, ['p/skills/a'], holder);
    assert.deepEqual(r.skipped, [
      { rel: 'skills/a/N.txt', reason: dup },
      { rel: 'skills/a/n.txt', reason: dup },
    ]);
    assert.deepEqual(fs.readdirSync(path.join(r.copyRoot, 'skills', 'a')), ['SKILL.md']);
    assert.equal(fs.readFileSync(path.join(repo, 'p/skills/a/n.txt'), 'utf8'), 'lower');
    assert.equal(fs.readFileSync(path.join(repo, 'p/skills/a/N.txt'), 'utf8'), 'upper');
  }
});

test('a conflict below an unreadable folder stays in the record', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  unreadable(t, f.src('skills'));
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(f.manifest().conflicts, [SKILL_A]);
  t.mock.restoreAll();
  fs.writeFileSync(f.src(SKILL_A), 'new team version');
  assert.equal(markCopySynced(f.holder), true);
  const again = syncCopy(f.plugin, f.ids, f.holder);
  assert.equal(C(f, SKILL_A), 'agent');
  assert.deepEqual(again.conflicts.map((c) => c.rel), [SKILL_A]);
});

test('a conflict below an unreadable folder stays in the record when the copy folder changed case', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  fs.writeFileSync(f.src('rules/x.mdc'), 'team');
  fs.writeFileSync(f.cp('rules/x.mdc'), 'agent');
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).conflicts.map((c) => c.rel), ['rules/x.mdc']);
  renameCase(f.cp('rules'), f.cp('Rules'));
  unreadable(t, f.src('rules'));
  syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(f.manifest().conflicts, ['rules/x.mdc']);
  t.mock.restoreAll();
  fs.writeFileSync(f.src('rules/x.mdc'), 'new team version');
  assert.equal(markCopySynced(f.holder), true);
  const again = syncCopy(f.plugin, f.ids, f.holder);
  assert.equal(C(f, 'rules/x.mdc'), 'agent');
  assert.deepEqual(again.conflicts.map((c) => c.rel.toLowerCase()), ['rules/x.mdc']);
});

// A conflict on rules/x.mdc whose record spells it rules/X.mdc.
function respelledConflict(t) {
  const f = setupCopy(t);
  fs.writeFileSync(f.src('rules/x.mdc'), 'team');
  fs.writeFileSync(f.cp('rules/x.mdc'), 'agent');
  assert.deepEqual(syncCopy(f.plugin, f.ids, f.holder).conflicts.map((c) => c.rel), ['rules/x.mdc']);
  const file = path.join(f.holder, '.team-plugins-sync.json');
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  record.files['rules/X.mdc'] = record.files['rules/x.mdc'];
  delete record.files['rules/x.mdc'];
  record.conflicts = ['rules/X.mdc'];
  fs.writeFileSync(file, JSON.stringify(record));
  return f;
}

for (const [keep, action, text] of [
  ['source', 'toCopy', 'team'],
  ['copy', 'toSource', 'agent'],
]) {
  test(`resolveConflict keeps the ${keep} when the record spells the file in another case`, (t) => {
    const f = respelledConflict(t);
    if (!caseInsensitive(f.root)) {
      return t.skip('case-sensitive filesystem');
    }
    const shown = conflictVersions(f.plugin, f.holder, 'rules/x.mdc');
    assert.deepEqual(resolveConflict(f.plugin, f.holder, 'rules/x.mdc', keep, shown), { action, rel: 'rules/x.mdc' });
    assert.equal(S(f, 'rules/x.mdc'), text);
    assert.equal(C(f, 'rules/x.mdc'), text);
    assert.equal(recordKeys(f).filter((k) => k.toLowerCase() === 'rules/x.mdc').length, 1);
    assert.deepEqual(f.manifest().conflicts, []);
  });
}

test('an excluded prefix is compared without case where case does not count', (t) => {
  const f = setupCopy(t);
  if (!caseInsensitive(f.root)) {
    return t.skip('case-sensitive filesystem');
  }
  const original = S(f, 'skills/b/SKILL.md');
  writeFile(f.copyRoot, 'skills/B/SKILL.md', 'AGENT');
  for (let round = 1; round <= 2; round++) {
    const r = syncCopy(f.plugin, f.ids, f.holder);
    assert.deepEqual(r.actions, []);
    assert.deepEqual(r.conflicts, []);
    assert.equal(S(f, 'skills/b/SKILL.md'), original);
    assert.ok(r.skipped.some((s) => s.rel === 'skills/B/SKILL.md' && s.reason === NOT_SELECTED));
    assert.deepEqual(names(f.src('skills')), ['a', 'b']);
  }
});
