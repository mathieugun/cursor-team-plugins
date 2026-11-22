'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { effective } = require('../lib/selection');
const { buildTree } = require('../lib/treeModel');

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
