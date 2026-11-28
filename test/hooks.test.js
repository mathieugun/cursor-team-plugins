'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const { readHooks } = require('../lib/hooks');
const { holderName, syncCopy } = require('../lib/materialize');
const { renameIds } = require('../lib/authoring');
const { effective, toggle, addToProject, removeFromProject, desiredRegistrations } = require('../lib/selection');
const { buildTree } = require('../lib/treeModel');
const { updateItems } = require('../lib/updates');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

const MANIFEST = '.cursor-plugin/plugin.json';
const DEFAULT = 'hooks/hooks.json';
const HOOKS = 'example/hooks';
const SKILL = 'example/skills/check';
const RULE = 'example/rules/style.mdc';
const config = (event) => ({ version: 1, hooks: { [event]: [{ command: 'fixture-hook' }] } });

function fixture(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  makePlugin(root, 'example', { skills: ['check'], rules: ['style.mdc'] });
  const dir = path.join(root, 'example');
  const json = (relative, value) => writeFile(dir, relative, `${JSON.stringify(value, null, 2)}\n`);
  const catalog = () => readCatalog(root);
  return { root, dir, json, catalog, plugin: () => catalog().plugins[0] };
}

test('Cursor hook configuration discovery and manifest precedence', (t) => {
  const f = fixture(t);
  const file = f.json(DEFAULT, { version: 1, hooks: {
    sessionEnd: [{ command: '' }, { command: 'second-hook' }],
    afterFileEdit: [{ type: 'prompt', prompt: 'Describe the change', model: 'fixture' }],
    stop: [],
  } });
  assert.deepEqual(f.plugin().children.at(-1), {
    id: HOOKS, name: 'Hooks', kind: 'hooks', file, events: ['afterFileEdit', 'sessionEnd'],
  });

  const customPath = f.json('config/alternative.json', config('preCompact'));
  f.json('plugin.json', { name: 'example', hooks: './config/alternative.json' });
  assert.equal(readHooks(f.dir).file, customPath);
  assert.deepEqual(readHooks(f.dir).events, ['preCompact']);

  const customDirectory = f.json('other/hooks.json', config('beforeReadFile'));
  f.json('.claude-plugin/plugin.json', { name: 'example', hooks: './other' });
  assert.equal(readHooks(f.dir).file, customDirectory);
  assert.deepEqual(readHooks(f.dir).events, ['beforeReadFile']);

  const manifest = f.json(MANIFEST, { name: 'example', hooks: config('afterTabFileEdit') });
  assert.equal(readHooks(f.dir).file, manifest);
  assert.deepEqual(readHooks(f.dir).events, ['afterTabFileEdit']);

  f.json(MANIFEST, { name: 'example', displayName: 'Example' });
  assert.equal(readHooks(f.dir).file, file);
  f.json(MANIFEST, { name: 'example', hooks: {} });
  assert.deepEqual(readHooks(f.dir).events, []);
});

test('Cursor-invalid hook configurations do not add a checkbox', (t) => {
  const f = fixture(t);
  const invalid = [
    { hooks: config('sessionEnd').hooks },
    { version: 1, hooks: { ...config('sessionEnd').hooks, imaginaryEvent: [] } },
    { version: 1, hooks: { sessionEnd: [{ command: 'x', matcher: '[' }] } },
    { version: 1, hooks: { sessionEnd: [{ type: 'prompt', prompt: ' ' }] } },
    { version: 1, hooks: { sessionEnd: [{ command: 'x', timeout: 0 }] } },
  ];
  for (const settings of invalid) {
    f.json(DEFAULT, settings);
    assert.ok(!f.plugin().children.some((child) => child.id === HOOKS));
  }
  writeFile(f.dir, DEFAULT, '{ "version": 1, "hooks": { "sessionEnd": [{ "command": "x" }] }, }');
  assert.deepEqual(readHooks(f.dir).events, []);
  f.json(DEFAULT, config('sessionEnd'));
  writeFile(f.root, 'outside.json', JSON.stringify(config('preCompact')));
  f.json(MANIFEST, { name: 'example', hooks: '../outside.json' });
  assert.deepEqual(readHooks(f.dir).events, []);
  f.json(MANIFEST, { name: 'example', hooks: config('sessionEnd').hooks });
  assert.deepEqual(readHooks(f.dir).events, []);
});

test('Claude-compatible hooks show the Cursor events and skip unsupported or empty groups', (t) => {
  const f = fixture(t);
  const group = (matcher) => [{ matcher, hooks: [{ type: 'command', command: 'fixture-hook' }] }];
  f.json(DEFAULT, { hooks: {
    UserPromptSubmit: group('*'),
    PreToolUse: group('Glob'),
    PostToolUse: group('Bash|Glob'),
    PermissionRequest: group('*'),
    Stop: [{ hooks: [] }],
    SessionEnd: [{ hooks: [{ type: 'command', command: 'x', args: 'invalid' }] }],
  } });
  assert.deepEqual(readHooks(f.dir).events, ['beforeSubmitPrompt', 'postToolUse']);
});

test('hook group and script rows respect their respective selection and file ownership', (t) => {
  const f = fixture(t);
  const hookPath = f.json(DEFAULT, config('afterFileEdit'));
  const pluginScript = writeFile(f.dir, 'scripts/tools/helper', 'plugin script');
  const skillScript = writeFile(f.dir, 'skills/check/scripts/check.py', 'skill script');
  writeFile(f.dir, 'skills/check/references/example.js', 'reference');
  const catalog = f.catalog();
  const whole = { enabled: ['example'], excluded: [] };
  const user = toggle(catalog, whole, HOOKS, false);
  assert.deepEqual(user, { enabled: ['example'], excluded: [HOOKS] });
  const state = effective(catalog, user, []);
  assert.deepEqual([...state.get('example').included], [SKILL, RULE]);
  const [plugin] = buildTree(catalog, state, []);
  const [skill, , hooks, script] = plugin.children;
  assert.equal(plugin.checked, false);
  assert.equal(hooks.checked, false);
  assert.equal(hooks.file, hookPath);
  assert.equal(hooks.contextValue, 'hooks');
  assert.deepEqual(hooks.children.map((row) => [row.label, row.file, row.checked]), [['afterFileEdit', hookPath, undefined]]);
  assert.deepEqual(skill.children.map((row) => [row.label, row.file, row.checked]), [['check.py', skillScript, undefined]]);
  assert.deepEqual([script.label, script.file, script.checked], ['tools/helper', pluginScript, undefined]);
  assert.ok(!updateItems(catalog.plugins, f.root).some((item) => item.kind === 'hooks'));

  const effectiveForProject = (project) => effective(catalog, user, project).get('example');
  assert.ok(effectiveForProject(addToProject(catalog, [], HOOKS)).included.has(HOOKS));
  assert.ok(!effectiveForProject(removeFromProject(catalog, ['example'], HOOKS)).included.has(HOOKS));
  assert.deepEqual(renameIds(user.excluded, 'example', 'new-name'), ['new-name/hooks']);
  const hooksOnly = toggle(catalog, { enabled: [], excluded: [] }, HOOKS, true);
  assert.deepEqual([...effective(catalog, hooksOnly, []).get('example').included], [HOOKS]);
});

test('default hooks stay out of a partial copy across sync while scripts follow their owner', (t) => {
  const f = fixture(t);
  const hookPath = f.json(DEFAULT, config('afterFileEdit'));
  writeFile(f.dir, 'scripts/tool.py', 'plugin script');
  writeFile(f.dir, 'skills/check/scripts/check.py', 'skill script');
  const plugin = f.plugin();
  const holderOf = (ids) => path.join(f.root, 'filtered', holderName(plugin, ids));
  const both = [SKILL, RULE];
  const holder = holderOf(both);
  assert.notEqual(holderName({ ...plugin, children: plugin.children.slice(0, -1), hasHookConfig: false }, both), path.basename(holder));
  const { copyRoot } = syncCopy(plugin, both, holder);
  assert.ok(!fs.existsSync(path.join(copyRoot, DEFAULT)));
  assert.ok(fs.existsSync(path.join(copyRoot, 'rules/style.mdc')));
  assert.ok(fs.existsSync(path.join(copyRoot, 'skills/check/scripts/check.py')));
  assert.ok(fs.existsSync(path.join(copyRoot, 'scripts/tool.py')));
  f.json(DEFAULT, config('sessionEnd'));
  syncCopy(f.plugin(), both, holder);
  assert.ok(!fs.existsSync(path.join(copyRoot, DEFAULT)));
  assert.ok(fs.existsSync(hookPath));

  const changed = syncCopy(f.plugin(), [RULE], holderOf([RULE])).copyRoot;
  assert.ok(!fs.existsSync(path.join(changed, 'skills/check')));
  assert.ok(fs.existsSync(path.join(changed, 'scripts/tool.py')));
  const selected = syncCopy(f.plugin(), [HOOKS], holderOf([HOOKS])).copyRoot;
  assert.deepEqual(readHooks(selected).events, ['sessionEnd']);

  const user = { enabled: ['example'], excluded: [HOOKS] };
  fs.unlinkSync(hookPath);
  const catalog = f.catalog();
  const eff = effective(catalog, user, []);
  const desired = desiredRegistrations(catalog, eff, (p, ids, disabled) => holderName(p, ids, disabled));
  assert.equal(desired.get('example'), path.basename(holder));
  assert.equal(desiredRegistrations(catalog, effective(catalog, user, ['example']), () => 'copy').get('example'), f.dir);
  assert.deepEqual(toggle(catalog, user, 'example', true), { enabled: ['example'], excluded: [] });
});

test('partial copy disables inline and custom manifest hooks, including after manifest changes', (t) => {
  const f = fixture(t);
  const custom = 'config/custom.json';
  f.json(DEFAULT, config('afterFileEdit'));
  f.json(custom, config('sessionEnd'));
  const source = f.json(MANIFEST, { name: 'example', description: 'preserved', hooks: `./${custom}` });
  const ids = [SKILL];
  const holder = path.join(f.root, 'filtered', holderName(f.plugin(), ids));
  const { copyRoot } = syncCopy(f.plugin(), ids, holder);
  const copied = path.join(copyRoot, MANIFEST);
  const manifest = () => JSON.parse(fs.readFileSync(copied, 'utf8'));
  assert.deepEqual(manifest(), { name: 'example', description: 'preserved', hooks: {} });
  assert.deepEqual(readHooks(copyRoot).events, []);
  assert.ok(fs.existsSync(path.join(copyRoot, custom)));

  f.json(MANIFEST, { name: 'example', description: 'changed', hooks: config('sessionEnd') });
  f.json('plugin.json', { name: 'example', hooks: config('preCompact') });
  syncCopy(f.plugin(), ids, holder);
  assert.deepEqual(manifest(), { name: 'example', description: 'changed', hooks: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(copyRoot, 'plugin.json'), 'utf8')).hooks, {});

  writeFile(copyRoot, MANIFEST, `${JSON.stringify({ ...manifest(), description: 'copy only' }, null, 2)}\n`);
  f.json(MANIFEST, { name: 'example', description: 'hooks moved out' });
  syncCopy(f.plugin(), ids, holder);
  assert.deepEqual(manifest(), { name: 'example', description: 'hooks moved out' });
  assert.equal(fs.readFileSync(copied, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.deepEqual(readHooks(copyRoot).events, []);
});

test('a selected hook source survives independently of an excluded skill or MCP server', (t) => {
  const f = fixture(t);
  const custom = 'skills/check/config.json';
  f.json(MANIFEST, { name: 'example', hooks: custom });
  f.json(custom, config('sessionEnd'));
  writeFile(f.dir, 'skills/check/scripts/check.py', 'skill script');
  const ids = [HOOKS];
  const copy = syncCopy(f.plugin(), ids, path.join(f.root, 'filtered', 'first')).copyRoot;
  assert.ok(!fs.existsSync(path.join(copy, 'skills/check/SKILL.md')));
  assert.ok(!fs.existsSync(path.join(copy, 'skills/check/scripts')));
  assert.deepEqual(readHooks(copy).events, ['sessionEnd']);

  f.json(MANIFEST, { name: 'example', hooks: 'mcp.json' });
  f.json('mcp.json', { ...config('sessionEnd'), mcpServers: { fixture: { command: 'fixture-mcp' } } });
  const shared = syncCopy(f.plugin(), ids, path.join(f.root, 'filtered', 'second')).copyRoot;
  assert.deepEqual(readHooks(shared).events, ['sessionEnd']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shared, 'mcp.json'), 'utf8')).mcpServers, {});
});

test('linked hook configs cannot become active in a copy and script rows stay in the plugin', (t) => {
  const f = fixture(t);
  const hookConfig = f.json('config/hooks.json', config('sessionEnd'));
  const outside = writeFile(f.root, 'outside/tool.py', '# outside the plugin\n');
  const hookLink = path.join(f.dir, DEFAULT);
  const scriptLink = path.join(f.dir, 'scripts/external.py');
  fs.mkdirSync(path.dirname(hookLink), { recursive: true });
  fs.mkdirSync(path.dirname(scriptLink), { recursive: true });
  try {
    fs.symlinkSync(hookConfig, hookLink, 'file');
    fs.symlinkSync(outside, scriptLink, 'file');
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'ENOSYS') {
      throw err;
    }
    t.skip(`symlinks unavailable: ${err.code}`);
    return;
  }
  const plugin = f.plugin();
  assert.ok(plugin.hasHookConfig);
  assert.ok(!plugin.children.some((child) => child.kind === 'hooks'));
  assert.equal(plugin.scripts, undefined);
  const copy = syncCopy(plugin, [SKILL], path.join(f.root, 'filtered', holderName(plugin, [SKILL]))).copyRoot;
  assert.ok(!fs.existsSync(path.join(copy, DEFAULT)));
});
