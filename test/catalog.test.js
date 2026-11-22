'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog, frontmatterDescription } = require('../lib/catalog');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

function fixture(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  return root;
}

test('marketplace with two plugins, children sorted, skills before rules', (t) => {
  const root = fixture(t);
  writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({ plugins: [{ name: 'a', source: './plugin-a' }, { name: 'b', source: 'plugin-b' }] }),
  );
  makePlugin(root, 'plugin-a', { skills: ['s2', 's1'], rules: ['r.mdc', 'q.md', 'notes.txt'] });
  writeFile(root, 'plugin-a/.cursor-plugin/plugin.json', JSON.stringify({ name: 'alpha', version: '1.2.0', description: 'A' }));
  makePlugin(root, 'plugin-b', { skills: ['x'], manifest: false });
  const { plugins, warnings } = readCatalog(root);
  assert.deepEqual(warnings, []);
  assert.deepEqual(plugins.map((p) => p.name), ['alpha', 'b']);
  assert.equal(plugins[0].version, '1.2.0');
  assert.equal(plugins[0].description, 'A');
  assert.deepEqual(plugins[0].children.map((c) => c.id), [
    'alpha/skills/s1',
    'alpha/skills/s2',
    'alpha/rules/q.md',
    'alpha/rules/r.mdc',
  ]);
  assert.equal(plugins[1].displayName, 'b');
  assert.deepEqual(plugins[1].children.map((c) => c.id), ['b/skills/x']);
  assert.equal(plugins[0].children[0].description, 'Skill s1.');
});

test('empty skill folder and nested rules are not children', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { skills: ['ok'] });
  writeFile(root, 'p/skills/empty/readme.txt', 'x');
  writeFile(root, 'p/rules/sub/z.mdc', 'x');
  const { plugins } = readCatalog(root);
  assert.deepEqual(plugins[0].children.map((c) => c.id), ['p/skills/ok']);
});

test('source outside the repository is skipped', (t) => {
  const root = fixture(t);
  const repo = path.join(root, 'repo');
  writeFile(repo, '.cursor-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'o', source: '../outside' }] }));
  makePlugin(root, 'outside', {});
  const { plugins, warnings } = readCatalog(repo);
  assert.equal(plugins.length, 0);
  assert.ok(warnings.some((w) => w.includes('source outside the repository')));
});

test('unsupported source skipped, object path accepted', (t) => {
  const root = fixture(t);
  writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({
      plugins: [{ name: 'g', source: { source: 'github', repo: 'o/r' } }, { name: 'c', source: { path: 'plugin-c' } }],
    }),
  );
  makePlugin(root, 'plugin-c', { name: 'c' });
  const { plugins, warnings } = readCatalog(root);
  assert.deepEqual(plugins.map((p) => p.name), ['c']);
  assert.ok(warnings.some((w) => w.includes('unsupported source')));
});

test('missing folder warns', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'm', source: './missing' }] }));
  const { plugins, warnings } = readCatalog(root);
  assert.equal(plugins.length, 0);
  assert.ok(warnings.some((w) => w.includes('folder not found')));
});

test('without marketplace: folders with plugin.json, hidden ones skipped', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p1', {});
  makePlugin(root, '.hidden', {});
  writeFile(root, 'docs/readme.md', 'x');
  const { plugins } = readCatalog(root);
  assert.deepEqual(plugins.map((p) => p.name), ['p1']);
});

test('invalid marketplace.json falls back to the folder scan', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor-plugin/marketplace.json', '{');
  makePlugin(root, 'p1', {});
  const { plugins, warnings } = readCatalog(root);
  assert.deepEqual(plugins.map((p) => p.name), ['p1']);
  assert.ok(warnings[0].startsWith('marketplace.json:'));
});

test('duplicate plugin names: the second is skipped', (t) => {
  const root = fixture(t);
  writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({ plugins: [{ name: 'x', source: 'one' }, { name: 'y', source: 'two' }] }),
  );
  makePlugin(root, 'one', { name: 'same' });
  makePlugin(root, 'two', { name: 'same' });
  const { plugins, warnings } = readCatalog(root);
  assert.equal(plugins.length, 1);
  assert.ok(warnings.some((w) => w.includes('duplicate plugin name')));
});

test('metadata.pluginRoot', (t) => {
  const root = fixture(t);
  writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({ metadata: { pluginRoot: 'plugins' }, plugins: [{ name: 'a', source: 'a' }] }),
  );
  makePlugin(root, 'plugins/a', { name: 'a' });
  const { plugins, warnings } = readCatalog(root);
  assert.deepEqual(warnings, []);
  assert.equal(plugins[0].dir, path.join(root, 'plugins', 'a'));
});

test('missing repoDir', () => {
  const { plugins, warnings } = readCatalog(path.join(require('os').tmpdir(), 'team-plugins-does-not-exist-xyz'));
  assert.equal(plugins.length, 0);
  assert.ok(warnings[0].includes('repository folder not found'));
});

test('frontmatterDescription', () => {
  assert.equal(frontmatterDescription('---\nname: x\ndescription: Does X.\n---\nbody'), 'Does X.');
  assert.equal(frontmatterDescription('﻿---\r\ndescription: "Quoted"\r\n---\r\n'), 'Quoted');
  assert.equal(frontmatterDescription('no front matter'), '');
  assert.equal(frontmatterDescription('---\nname: x\n---\ndescription: outside\n'), '');
});

test('linked skill folders and rule files are listed', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { name: 'p', skills: ['a'], rules: ['q.mdc'] });
  writeFile(root, 'shared/s/SKILL.md', '---\ndescription: Linked skill.\n---\nbody\n');
  fs.symlinkSync(path.join(root, 'shared', 's'), path.join(root, 'p', 'skills', 's'), 'junction');
  writeFile(root, 'shared/r.mdc', '---\ndescription: Linked rule.\n---\nbody\n');
  let fileLink = true;
  try {
    fs.symlinkSync(path.join(root, 'shared', 'r.mdc'), path.join(root, 'p', 'rules', 'r.mdc'), 'file');
  } catch (err) {
    if (err.code !== 'EPERM') {
      throw err;
    }
    fileLink = false;
    t.diagnostic('file symlinks need privileges');
  }
  const ids = readCatalog(root).plugins[0].children.map((c) => c.id);
  assert.ok(ids.includes('p/skills/s'));
  assert.equal(ids.includes('p/rules/r.mdc'), fileLink);
});

test('a plugin knows its repository folder', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { name: 'p', skills: ['a'] });
  assert.equal(readCatalog(root).plugins[0].repoDir, path.resolve(root));
});

test('frontmatterDescription reads folded, literal and continued values', () => {
  const d = frontmatterDescription;
  assert.equal(d('---\ndescription: >\n  Folded line one\n  line two\n\n  para two\nname: x\n---\n'), 'Folded line one line two\npara two');
  assert.equal(d('---\ndescription: |\n  Line one\n  Line two\nname: x\n---\n'), 'Line one\nLine two');
  assert.equal(d('---\ndescription: >-\n  a\n  b\n---\n'), 'a b');
  assert.equal(d('---\r\ndescription: |+\r\n    deep\r\n    lines\r\n---\r\n'), 'deep\nlines');
  assert.equal(d('---\ndescription: plain start\n  continued here\nother: 1\n---\n'), 'plain start continued here');
  assert.equal(d('---\ndescription: >\nname: y\n---\n'), '');
  assert.equal(d('---\ndescription:\n  on the next line\n---\n'), 'on the next line');
  assert.equal(d('---\ndescription: |\n  x\n---\ndescription: outside\n'), 'x');
  // the single-line forms are unchanged
  assert.equal(d("---\ndescription: 'Quoted'\n---\n"), 'Quoted');
  assert.equal(d('---\ndescription: Does X.\nname: x\n---\n'), 'Does X.');
});
