'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const { filteredDirName, materialize, gcFiltered } = require('../lib/materialize');
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

test('materialize copies only the selected children', (t) => {
  const { root, plugin } = setup(t);
  const dest = path.join(root, 'filtered', 'p-x');
  const out = materialize(plugin, ['p/skills/a', 'p/rules/x.mdc'], dest);
  // the copy keeps the plugin's folder name: Cursor names an extension plugin after its folder
  assert.equal(out, path.join(dest, 'p'));
  assert.ok(fs.existsSync(path.join(dest, '.team-plugins-complete')));
  for (const rel of ['.cursor-plugin/plugin.json', 'skills/a/SKILL.md', 'rules/x.mdc', 'agents/z.md']) {
    assert.ok(fs.existsSync(path.join(out, rel)), rel);
  }
  for (const rel of ['skills/b', 'rules/y.mdc', '.git']) {
    assert.ok(!fs.existsSync(path.join(out, rel)), rel);
  }
  assert.deepEqual(fs.readdirSync(path.join(root, 'filtered')).filter((n) => n.includes('.tmp-')), []);
});

test('materialize is a no-op on a complete destination', (t) => {
  const { root, plugin } = setup(t);
  const dest = path.join(root, 'filtered', 'p-x');
  materialize(plugin, ['p/skills/a'], dest);
  writeFile(dest, 'sentinel', 'x');
  assert.equal(materialize(plugin, ['p/skills/a'], dest), path.join(dest, 'p'));
  assert.ok(fs.existsSync(path.join(dest, 'sentinel')));
});

test('filteredDirName', (t) => {
  const { plugin } = setup(t);
  const ids = ['p/skills/a'];
  const a = filteredDirName(plugin, ids);
  assert.equal(filteredDirName(plugin, ids), a);
  assert.notEqual(filteredDirName(plugin, ['p/skills/a', 'p/skills/b']), a);
  assert.match(a, /^p-[0-9a-f]{12}$/);
  fs.appendFileSync(path.join(plugin.dir, 'skills', 'a', 'SKILL.md'), 'more text');
  assert.notEqual(filteredDirName(plugin, ids), a);
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
