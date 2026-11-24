'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { effective } = require('../lib/selection');
const {
  buildTree,
  buildChangesNode,
  buildConflictsNode,
  repoStatus,
  buildRepoNode,
  buildMissingNodes,
} = require('../lib/treeModel');

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
  assert.equal(p1.partial, true);
  assert.equal(p1.project, null);
  assert.equal(p1.checkboxTooltip, 'Partly enabled: 2 of 3 items. Tick to enable all.');
  assert.equal(p1.children[0].project, null);
  assert.equal(p1.children[0].partial, false);
  assert.equal(p1.children[0].checkboxTooltip, '');
  assert.equal(p1.children[0].checked, false);
  assert.equal(p1.children[0].contextValue, 'child');
  assert.equal(p1.children[1].checked, true);
  // the kind is written next to the name, so skills and rules read apart even without icons
  assert.equal(p1.children[0].description, 'skill');
  assert.equal(p1.children[2].kind, 'rule');
  assert.equal(p1.children[2].description, 'rule');

  assert.equal(p2.checked, true);
  assert.equal(p2.description, '');
  assert.equal(p2.project, 'all');
  assert.equal(p2.partial, false);
  assert.equal(p2.checkboxTooltip, '');
  assert.equal(p2.tooltip, 'P2\nEnabled by this project (.vscode/settings.json)');
  assert.equal(p2.contextValue, 'plugin.project');
  assert.equal(p2.children[0].description, 'skill');
  assert.equal(p2.children[0].project, 'all');
  assert.equal(p2.children[0].tooltip, 's3\nEnabled by this project (.vscode/settings.json)');
  assert.equal(p2.children[0].contextValue, 'child.project');

  assert.equal(p3.children.length, 0);
  assert.equal(p3.checked, false);
  assert.equal(p3.description, '');
  assert.equal(p3.project, null);
  assert.equal(p3.partial, false);
});

test('project state of a plugin', () => {
  const tree = (user, project) => buildTree(catalog, effective(catalog, user, project), project);
  const PARTLY = 'Partly enabled: 2 of 3 items. Tick to enable all.';

  let [p1] = tree({ enabled: ['P1/skills/s2'], excluded: [] }, ['P1/skills/s1']);
  assert.equal(p1.project, 'some');
  assert.equal(p1.partial, true);
  assert.equal(p1.description, 'v1.0.0 · 2/3');
  assert.equal(p1.tooltip, 'First\nPartly enabled by this project (.vscode/settings.json)');
  assert.equal(p1.checkboxTooltip, PARTLY);
  assert.equal(p1.contextValue, 'plugin.project');
  assert.deepEqual(p1.children.map((c) => c.project), ['all', null, null]);
  assert.deepEqual(p1.children.map((c) => c.checked), [true, true, false]);

  // everything enabled comes from the project
  [p1] = tree({ enabled: [], excluded: [] }, ['P1/skills/s1']);
  assert.equal(p1.project, 'all');
  assert.equal(p1.partial, true);
  assert.equal(p1.checkboxTooltip, 'Partly enabled: 1 of 3 items. Tick to enable all.');

  // enabled by both still counts as the project's
  [p1] = tree({ enabled: ['P1/skills/s1'], excluded: [] }, ['P1/skills/s1']);
  assert.equal(p1.project, 'all');

  [p1] = tree({ enabled: ['P1'], excluded: [] }, ['P1']);
  assert.equal(p1.project, 'all');
  assert.equal(p1.partial, false);
  assert.equal(p1.checked, true);
  assert.equal(p1.checkboxTooltip, '');
  assert.deepEqual(p1.children.map((c) => c.project), ['all', 'all', 'all']);

  // a leaf plugin listed by the project
  const p3 = tree({ enabled: [], excluded: [] }, ['P3'])[2];
  assert.equal(p3.project, 'all');
  assert.equal(p3.checked, true);
  assert.equal(p3.partial, false);
  assert.equal(p3.tooltip, 'P3\nEnabled by this project (.vscode/settings.json)');

  [p1] = tree({ enabled: ['P1'], excluded: [] }, []);
  assert.equal(p1.project, null);
  assert.equal(p1.partial, false);
  assert.equal(p1.checkboxTooltip, '');
});

test('buildChangesNode', () => {
  const node = buildChangesNode({
    files: [
      { path: 'p/skills/a/SKILL.md', status: 'modified' },
      { path: 'top.md', status: 'untracked' },
    ],
    ahead: 2,
  }, 'k');
  assert.equal(node.description, '2 file(s) · 2 unpushed commit(s)');
  assert.equal(node.contextValue, 'changes');
  assert.equal(node.id, 'changes:k');
  assert.equal(node.repo, 'k');
  assert.deepEqual(node.children.map((c) => c.id), ['change:k|p/skills/a/SKILL.md', 'change:k|top.md']);
  assert.ok(node.children.every((c) => c.repo === 'k'));
  assert.deepEqual(node.children.map((c) => c.label), ['SKILL.md', 'top.md']);
  assert.deepEqual(node.children.map((c) => c.description), ['p/skills/a · modified', 'untracked']);

  const onlyCommits = buildChangesNode({ files: [], ahead: 1 }, 'k');
  assert.equal(onlyCommits.description, '1 unpushed commit(s)');
  assert.equal(onlyCommits.children.length, 0);
  assert.equal(buildChangesNode({ files: [], ahead: 0 }, 'k'), null);
  assert.equal(buildChangesNode(null, 'k'), null);
});

test('plugin ids never collide with the built-in nodes', () => {
  const names = ['changes', 'conflicts', 'sync-error', 'repo', 'missing'];
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
  const changesNode = buildChangesNode({ files: [{ path: 'a', status: 'modified' }], ahead: 0 }, 'k');
  const conflictsNode = buildConflictsNode([{ plugin: 'changes', rel: 'x', source: '/s', copy: '/c', holder: 'H' }], 'k');
  const top = [changesNode, conflictsNode, ...tree];
  const ids = [...top, ...top.flatMap((n) => n.children)].map((n) => n.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const n of tree) {
    assert.ok(!['changes', 'conflicts', 'sync-error'].includes(n.id));
    assert.ok(!n.id.startsWith('repo:'));
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
  }, 'k');
  assert.equal(node.children[0].from, 'skills/old.md');
  assert.equal(node.children[0].tooltip, 'skills/old.md \u2192 skills/new.md');
  assert.ok(!('from' in node.children[1]));
  assert.equal(node.children[1].tooltip, 'a.md');
});

test('buildConflictsNode', () => {
  assert.equal(buildConflictsNode([], 'k'), null);
  const node = buildConflictsNode([
    { plugin: 'p', rel: 'skills/a/SKILL.md', source: 'S', copy: 'C', holder: 'H' },
    { plugin: 'p', rel: 'x.md', source: 'S2', copy: 'C2', holder: 'H' },
  ], 'k');
  assert.equal(node.id, 'conflicts:k');
  assert.equal(node.repo, 'k');
  assert.ok(node.children.every((c) => c.repo === 'k'));
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
  const node = buildChangesNode({ files: [], ahead: 0, error: 'git status failed: boom' }, 'k');
  assert.equal(node.id, 'changes:k');
  assert.equal(node.repo, 'k');
  assert.equal(node.kind, 'changes');
  assert.equal(node.contextValue, 'changes.error');
  assert.deepEqual(node.children, []);
  assert.equal(node.tooltip, 'git status failed: boom');
  assert.equal(node.error, 'git status failed: boom');
  assert.equal(node.description, 'cannot be read: see the log');
});

const MANAGED = { key: 'k', name: 'team', kind: 'managed', source: 'u', branch: '', dir: 'D', duplicateOf: null, hiddenBy: null };
const LOCAL = { key: 'l', name: 'mine', kind: 'local', source: '/p/mine', branch: '', dir: '/p/mine', duplicateOf: null, hiddenBy: null };

test('repoStatus', () => {
  const idle = { syncing: false, lastResult: { kind: 'upToDate' } };
  const status = (desc, state) => {
    const s = repoStatus(desc, state);
    return [s.text, s.icon, s.problem];
  };
  assert.deepEqual(status({ ...MANAGED, duplicateOf: 'x' }, idle), ['listed twice: not loaded', 'warning', true]);
  // the first rule wins over a sync in progress
  assert.deepEqual(status({ ...MANAGED, duplicateOf: 'x' }, { ...idle, syncing: true }), [
    'listed twice: not loaded',
    'warning',
    true,
  ]);
  const hiddenLocal = { ...MANAGED, hiddenBy: { key: 'l', source: '/p/mine', reason: 'local' } };
  assert.deepEqual(status(hiddenLocal, idle), ['replaced by your local clone', 'circle-slash', false]);
  const hiddenName = { ...MANAGED, hiddenBy: { key: 'o', source: 'https://h/o.git', reason: 'name' } };
  assert.deepEqual(status(hiddenName, idle), ['same name as https://h/o.git: not loaded', 'warning', true]);
  assert.deepEqual(status(MANAGED, { syncing: true, lastResult: null }), ['updating…', 'sync~spin', false]);
  assert.deepEqual(status(LOCAL, idle), ['local clone', 'folder', false]);
  assert.deepEqual(status(LOCAL, { syncing: true }), ['updating…', 'sync~spin', false]);
  assert.deepEqual(status(MANAGED, { syncing: false, lastResult: null }), ['not synced yet', 'repo', false]);
  assert.deepEqual(status(MANAGED, { lastResult: { kind: 'conflict' } }), ['updates paused: conflict', 'warning', true]);
  assert.deepEqual(status(MANAGED, { lastResult: { kind: 'error', message: 'boom' } }), ['error: boom', 'warning', true]);
  assert.deepEqual(status(MANAGED, { lastResult: { kind: 'offline' } }), ['offline', 'debug-disconnect', false]);
  assert.deepEqual(status(MANAGED, { lastResult: { kind: 'busy' } }), ['another window is updating it', 'sync', false]);
  for (const kind of ['upToDate', 'updated', 'cloned', 'switched']) {
    assert.deepEqual(status(MANAGED, { lastResult: { kind } }), ['up to date', 'repo', false]);
  }
});

test('buildRepoNode', () => {
  const state = { lastResult: { kind: 'upToDate', head: 'abcdef1234' } };
  const node = buildRepoNode(MANAGED, state, [{ id: 'x' }]);
  assert.equal(node.id, 'repo:k');
  assert.equal(node.kind, 'repo');
  assert.equal(node.key, 'k');
  assert.equal(node.label, 'team');
  assert.equal(node.description, 'up to date');
  assert.equal(node.icon, 'repo');
  assert.equal(node.contextValue, 'repo.managed');
  assert.deepEqual(node.children, [{ id: 'x' }]);
  assert.ok(node.tooltip.includes('Repository: u (default branch)'), node.tooltip);
  assert.ok(node.tooltip.includes('Folder: D'), node.tooltip);
  assert.ok(node.tooltip.includes('Commit: abcdef1'), node.tooltip);
  assert.ok(!node.tooltip.includes('Commit: abcdef12'), node.tooltip);
  assert.ok(node.tooltip.includes('State: up to date'), node.tooltip);
  assert.ok(!node.tooltip.includes('Last check'), node.tooltip);

  const checked = buildRepoNode({ ...MANAGED, branch: 'dev' }, { ...state, lastCheck: new Date(2026, 0, 2, 9, 5) }, []);
  assert.ok(checked.tooltip.includes('Repository: u (dev)'), checked.tooltip);
  assert.ok(checked.tooltip.includes('Last check: 09:05'), checked.tooltip);

  const local = buildRepoNode(LOCAL, {}, []);
  assert.equal(local.contextValue, 'repo.local');
  assert.ok(local.tooltip.includes('Repository: /p/mine\n'), local.tooltip);
  assert.ok(!local.tooltip.includes('default branch'), local.tooltip);
});

test('buildMissingNodes', () => {
  const nodes = buildMissingNodes(
    [{ name: '', url: 'https://h/org/b.git', branch: '', normalized: 'h/org/b' }],
    ['c'],
  );
  assert.deepEqual(nodes.map((n) => n.id), ['missing:h/org/b', 'unlocated:c']);
  assert.deepEqual(nodes.map((n) => n.label), ['b', 'c']);
  assert.deepEqual(nodes.map((n) => n.contextValue), ['missing', 'missing.unknown']);
  assert.ok(nodes.every((n) => n.kind === 'missing'));
  assert.equal(nodes[0].url, 'https://h/org/b.git');
  assert.ok(nodes[0].description.includes('not followed'));
  assert.ok(nodes[1].description.includes('location unknown'));
  assert.equal(buildMissingNodes([{ name: 'named', url: 'u', branch: 'dev', normalized: 'x/u' }], [])[0].label, 'named');
  assert.deepEqual(buildMissingNodes([], []), []);
});

test('item rows say their kind', () => {
  const kinds = ['skill', 'rule', 'command', 'agent', 'mcp'];
  const cat = {
    plugins: [
      {
        name: 'K',
        displayName: 'K',
        version: '',
        description: '',
        dir: '/repo/K',
        children: kinds.map((k) => child(`K/${k}/x`, k)),
      },
    ],
    warnings: [],
  };
  const [k] = buildTree(cat, effective(cat, { enabled: ['K'], excluded: [] }, []), []);
  assert.deepEqual(k.children.map((c) => c.description), ['skill', 'rule', 'command', 'agent', 'MCP server']);
});
