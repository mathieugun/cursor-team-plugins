'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const { holderName, syncCopy, markCopySynced, gcFiltered } = require('../lib/materialize');
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
  assert.deepEqual(f.manifest().files, FOUR);
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
  setMtime(f.cp(SKILL_A), f.manifest().syncedAt + 10000);
  const r = syncCopy(f.plugin, f.ids, f.holder);
  assert.deepEqual(r.actions, [{ action: 'toSource', rel: SKILL_A }]);
  assert.equal(fs.readFileSync(f.src(SKILL_A), 'utf8'), 'edited by the agent');
});

test('an edit of the repository goes to the copy', (t) => {
  const f = setupCopy(t);
  fs.writeFileSync(f.src(SKILL_A), 'edited by the team');
  setMtime(f.cp(SKILL_A), f.manifest().syncedAt - 10000);
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
