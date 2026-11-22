'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const { holderName, copyRootOf, syncCopy, markCopySynced, resolveConflict, gcFiltered } = require('../lib/materialize');
const { removeTree } = require('../lib/sync');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

function setup(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const repo = path.join(root, 'repo');
  makePlugin(repo, 'p', {
    name: 'p',
    skills: ['a', 'b'],
    rules: ['x.mdc', 'y.mdc'],
    extra: { 'agents/z.md': 'agent', '.git/HEAD': 'ref: x' },
  });
  const plugin = readCatalog(repo).plugins[0];
  return { root, plugin };
}

const SKILL_A = 'skills/a/SKILL.md';
const FOUR = ['.cursor-plugin/plugin.json', 'rules/x.mdc', 'agents/z.md', SKILL_A].sort();

function setupCopy(t) {
  const f = setup(t);
  f.ids = ['p/skills/a', 'p/rules/x.mdc'];
  f.holder = path.join(f.root, 'filtered', holderName(f.plugin, f.ids));
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
  writeFile(f.plugin.dir, 'agents/new.md', 'new');
  r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toCopy', rel: 'agents/new.md' }]);
  assert.equal(fs.readFileSync(f.cp('agents/new.md'), 'utf8'), 'new');
});

test('deletions go both ways', (t) => {
  const f = setupCopy(t);
  fs.rmSync(f.cp('agents/z.md'));
  let r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'deletedInSource', rel: 'agents/z.md' }]);
  assert.ok(!fs.existsSync(f.src('agents/z.md')));
  assert.ok(!fs.existsSync(f.src('agents')), 'the emptied folder is removed');
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
  fs.rmSync(f.cp('agents/z.md'));
  fs.writeFileSync(f.src('agents/z.md'), 'team');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts.map((c) => c.rel), ['agents/z.md']);
  assert.equal(S(f, 'agents/z.md'), 'team');
});

test('resolveConflict keeps the repository version', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  assert.deepEqual(resolveConflict(f.plugin, f.ids, f.holder, SKILL_A, 'source'), { action: 'toCopy', rel: SKILL_A });
  assert.equal(C(f, SKILL_A), 'team');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(f.manifest().conflicts, []);
});

test('resolveConflict keeps the copy version', (t) => {
  const f = setupCopy(t);
  makeConflict(f);
  assert.deepEqual(resolveConflict(f.plugin, f.ids, f.holder, SKILL_A, 'copy'), { action: 'toSource', rel: SKILL_A });
  assert.equal(S(f, SKILL_A), 'agent');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(f.manifest().conflicts, []);
});

test('resolveConflict with the kept side deleted deletes the other', (t) => {
  const f = setupCopy(t);
  fs.rmSync(f.cp('agents/z.md'));
  fs.writeFileSync(f.src('agents/z.md'), 'team');
  syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(resolveConflict(f.plugin, f.ids, f.holder, 'agents/z.md', 'copy'), {
    action: 'deletedInSource',
    rel: 'agents/z.md',
  });
  assert.ok(!fs.existsSync(f.src('agents/z.md')));
  assert.throws(() => resolveConflict(f.plugin, f.ids, f.holder, '../x', 'copy'));
  assert.throws(() => resolveConflict(f.plugin, f.ids, f.holder, SKILL_A, 'both'));
});

test('an unreadable record never deletes unsynced edits', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.cp(SKILL_A), 'agent');
  writeFile(f.copyRoot, 'skills/a/notes.md', 'notes');
  writeFile(f.plugin.dir, 'agents/new.md', 'new');
  fs.writeFileSync(path.join(f.holder, '.team-plugins-sync.json'), '{"syncedAt":17');
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [
    { action: 'toCopy', rel: 'agents/new.md' },
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
  fs.rmSync(f.cp('agents/z.md'));
  setMtime(f.src('agents/z.md'), now - 10000);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [
    { action: 'deletedInSource', rel: 'agents/z.md' },
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
  const loop = path.join(f.plugin.dir, 'agents', 'loop');
  junction(f.plugin.dir, loop);
  try {
    const r = syncCopy(f.plugin, IDS, holderFor(f, IDS));
    assert.deepEqual(r.skipped, [{ rel: 'agents/loop', reason: 'link loop' }]);
    assert.ok(fs.existsSync(path.join(r.copyRoot, 'agents', 'z.md')));
  } finally {
    fs.rmdirSync(loop); // removes the junction only: the cleanup of the temporary folder can't follow a loop
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
