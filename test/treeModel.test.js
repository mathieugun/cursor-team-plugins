'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { effective } = require('../lib/selection');
const { buildTree, buildChangesNode, buildConflictsNode } = require('../lib/treeModel');

const child = (id, kind) => ({ id, kind, name: id.split('/').pop(), file: `/x/${id}`, description: '' });
const catalog = {
  plugins: [
    {
      name: 'P1',
      displayName: 'P1',
      version: '1.0.0',
      description: 'First',
      dir: '/repo/P1',
      children: [child('P1/skills/s1', 'skill'), child('P1/skills/s2', 'skill'), child('P1/rules/r1.mdc', 'rule')],
    },
    { name: 'P2', displayName: 'P2', version: '', description: '', dir: '/repo/P2', children: [child('P2/skills/s3', 'skill')] },
    { name: 'P3', displayName: 'P3', version: '', description: '', dir: '/repo/P3', children: [] },
  ],
  warnings: [],
};

test('tree nodes', () => {
  const project = ['P2'];
  const eff = effective(catalog, { enabled: ['P1'], excluded: ['P1/skills/s1'] }, project);
  const [p1, p2, p3] = buildTree(catalog, eff, project);

  // the node id is for the tree, the key is the selection id (a plugin named like a built-in node can't collide)
  assert.equal(p1.id, 'plugin:P1');
  assert.equal(p1.key, 'P1');
  assert.equal(p1.children[0].id, 'item:P1/skills/s1');
  assert.equal(p1.children[0].key, 'P1/skills/s1');
  assert.equal(p2.id, 'plugin:P2');
  assert.equal(p2.children[0].key, 'P2/skills/s3');
  assert.equal(p1.checked, false);
  assert.equal(p1.description, 'v1.0.0 · 2/3');
  assert.equal(p1.contextValue, 'plugin');
  assert.equal(p1.tooltip, 'First');
  assert.equal(p1.children[0].checked, false);
  assert.equal(p1.children[0].contextValue, 'child');
  assert.equal(p1.children[1].checked, true);
  // the kind is written next to the name, so skills and rules read apart even without icons
  assert.equal(p1.children[0].description, 'skill');
  assert.equal(p1.children[2].kind, 'rule');
  assert.equal(p1.children[2].description, 'rule');

  assert.equal(p2.checked, true);
  assert.equal(p2.description, 'project');
  assert.equal(p2.contextValue, 'plugin.project');
  assert.equal(p2.children[0].description, 'skill · project');
  assert.equal(p2.children[0].contextValue, 'child.project');

  assert.equal(p3.children.length, 0);
  assert.equal(p3.checked, false);
  assert.equal(p3.description, '');
});

test('buildChangesNode', () => {
  const node = buildChangesNode({
    files: [
      { path: 'p/skills/a/SKILL.md', status: 'modified' },
      { path: 'top.md', status: 'untracked' },
    ],
    ahead: 2,
  });
  assert.equal(node.description, '2 file(s) · 2 unpushed commit(s)');
  assert.equal(node.contextValue, 'changes');
  assert.deepEqual(node.children.map((c) => c.label), ['SKILL.md', 'top.md']);
  assert.deepEqual(node.children.map((c) => c.description), ['p/skills/a · modified', 'untracked']);

  const onlyCommits = buildChangesNode({ files: [], ahead: 1 });
  assert.equal(onlyCommits.description, '1 unpushed commit(s)');
  assert.equal(onlyCommits.children.length, 0);
  assert.equal(buildChangesNode({ files: [], ahead: 0 }), null);
  assert.equal(buildChangesNode(null), null);
});

test('plugin ids never collide with the built-in nodes', () => {
  const names = ['changes', 'conflicts', 'sync-error'];
  const cat = {
    plugins: names.map((name) => ({
      name,
      displayName: name,
      version: '',
      description: '',
      dir: `/repo/${name}`,
      children: [child(`${name}/skills/s`, 'skill')],
    })),
    warnings: [],
  };
  const tree = buildTree(cat, effective(cat, { enabled: [], excluded: [] }, []), []);
  const changesNode = buildChangesNode({ files: [{ path: 'a', status: 'modified' }], ahead: 0 });
  const conflictsNode = buildConflictsNode([{ plugin: 'changes', rel: 'x', source: '/s', copy: '/c', holder: 'H' }]);
  const top = [changesNode, conflictsNode, ...tree];
  const ids = [...top, ...top.flatMap((n) => n.children)].map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const n of tree) {
    assert.ok(!['changes', 'conflicts', 'sync-error'].includes(n.id));
    assert.equal(n.id, `plugin:${n.key}`);
  }
});

test('a renamed change keeps its old path', () => {
  const node = buildChangesNode({
    files: [
      { path: 'skills/new.md', status: 'renamed', from: 'skills/old.md' },
      { path: 'a.md', status: 'modified' },
    ],
    ahead: 0,
  });
  assert.equal(node.children[0].from, 'skills/old.md');
  assert.equal(node.children[0].tooltip, 'skills/old.md \u2192 skills/new.md');
  assert.ok(!('from' in node.children[1]));
  assert.equal(node.children[1].tooltip, 'a.md');
});

test('buildConflictsNode', () => {
  assert.equal(buildConflictsNode([]), null);
  const node = buildConflictsNode([
    { plugin: 'p', rel: 'skills/a/SKILL.md', source: 'S', copy: 'C', holder: 'H' },
    { plugin: 'p', rel: 'x.md', source: 'S2', copy: 'C2', holder: 'H' },
  ]);
  assert.equal(node.id, 'conflicts');
  assert.equal(node.description, '2 file(s)');
  assert.deepEqual(node.children.map((c) => c.id), ['conflict:H|skills/a/SKILL.md', 'conflict:H|x.md']);
  assert.deepEqual(node.children.map((c) => c.label), ['SKILL.md', 'x.md']);
  assert.deepEqual(node.children.map((c) => c.description), ['p/skills/a', 'p']);
  assert.ok(node.children.every((c) => c.contextValue === 'conflict'));
  assert.deepEqual(
    node.children.map((c) => [c.rel, c.source, c.copy, c.holder]),
    [
      ['skills/a/SKILL.md', 'S', 'C', 'H'],
      ['x.md', 'S2', 'C2', 'H'],
    ],
  );
});

test('buildChangesNode with a read error', () => {
  const node = buildChangesNode({ files: [], ahead: 0, error: 'git status failed: boom' });
  assert.equal(node.id, 'changes');
  assert.equal(node.kind, 'changes');
  assert.equal(node.contextValue, 'changes.error');
  assert.deepEqual(node.children, []);
  assert.equal(node.tooltip, 'git status failed: boom');
  assert.equal(node.error, 'git status failed: boom');
  assert.equal(node.description, 'cannot be read: see the log');
});
