'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const {
  NAME_RULE,
  SERVER_RULE,
  nameError,
  serverNameError,
  yamlScalar,
  itemFile,
  createItem,
  splitCommandLine,
  mcpEntry,
  addMcpServer,
  createPlugin,
  movePlugin,
  renameIds,
  declaredPathsError,
} = require('../lib/authoring');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

function fixture(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  return root;
}

const readText = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');
const marketplace = (root) => JSON.parse(readText(root, '.cursor-plugin', 'marketplace.json'));

test('nameError', () => {
  for (const ok of ['code-review', 'a', 'v1.2', 'x9', 'a'.repeat(64)]) {
    assert.equal(nameError(ok), '', ok);
  }
  for (const bad of ['Code', '-a', 'a-', 'a_b', 'a b', '', 'a'.repeat(65)]) {
    assert.equal(nameError(bad), NAME_RULE, bad);
  }
});

test('serverNameError', () => {
  for (const ok of ['lint', 'My_server-1', 'a.b']) {
    assert.equal(serverNameError(ok), '', ok);
  }
  for (const bad of ['.x', 'a b', 'a/b', '']) {
    assert.equal(serverNameError(bad), SERVER_RULE, bad);
  }
});

test('yamlScalar', () => {
  assert.equal(yamlScalar('Review a change.'), 'Review a change.');
  assert.equal(yamlScalar('Fix: bugs'), '"Fix: bugs"');
  assert.equal(yamlScalar('#tag'), '"#tag"');
  assert.equal(yamlScalar('- item'), '"- item"');
  assert.equal(yamlScalar('say "hi"'), 'say "hi"');
  assert.equal(yamlScalar('  padded  '), 'padded');
});

test('itemFile', () => {
  assert.deepEqual(itemFile('skill', 'code-review', 'Review a change.'), {
    rel: 'skills/code-review/SKILL.md',
    text:
      '---\nname: code-review\ndescription: Review a change.\n---\n\n# Code review\n\n' +
      'Describe when the agent should use this skill and the steps to follow.\n',
  });
  assert.deepEqual(itemFile('rule', 'style', 'House style.'), {
    rel: 'rules/style.mdc',
    text: '---\ndescription: House style.\nalwaysApply: false\n---\n\nWrite the rule here.\n',
  });
  assert.deepEqual(itemFile('command', 'review-pr', 'Review the open pull request.'), {
    rel: 'commands/review-pr.md',
    text: '---\ndescription: Review the open pull request.\n---\n\nWrite what the agent does when this command runs.\n',
  });
  assert.deepEqual(itemFile('agent', 'reviewer', 'Reviews a diff.'), {
    rel: 'agents/reviewer.md',
    text: "---\nname: reviewer\ndescription: Reviews a diff.\n---\n\nDescribe the agent's role and how it works.\n",
  });
  assert.ok(itemFile('skill', 'x', 'Fix: bugs').text.includes('\ndescription: "Fix: bugs"\n'));
});

test('createItem writes files the catalog reads back', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p');
  const dir = path.join(root, 'p');
  const made = [
    createItem(dir, 'skill', 'code-review', 'Review a change.'),
    createItem(dir, 'rule', 'style', 'House style.'),
    createItem(dir, 'command', 'review-pr', 'Review the open pull request.'),
    createItem(dir, 'agent', 'reviewer', 'Reviews a diff.'),
  ];
  assert.ok(made.every((m) => typeof m.file === 'string' && fs.existsSync(m.file)));
  assert.equal(made[0].file, path.join(dir, 'skills', 'code-review', 'SKILL.md'));
  const { plugins, warnings } = readCatalog(root);
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    plugins[0].children.map((c) => [c.id, c.description]),
    [
      ['p/skills/code-review', 'Review a change.'],
      ['p/rules/style.mdc', 'House style.'],
      ['p/commands/review-pr.md', 'Review the open pull request.'],
      ['p/agents/reviewer.md', 'Reviews a diff.'],
    ],
  );
  // a description with a colon survives the round trip
  assert.ok(createItem(dir, 'skill', 'colon', 'Fix: bugs').file);
  assert.equal(readCatalog(root).plugins[0].children.find((c) => c.name === 'colon').description, 'Fix: bugs');

  assert.deepEqual(createItem(dir, 'skill', 'code-review', 'again'), { error: 'skills/code-review already exists' });
  writeFile(root, 'p/rules/x.md', 'x');
  assert.deepEqual(createItem(dir, 'rule', 'x', 'd'), { error: 'rules/x.md already exists' });
  writeFile(root, 'p/commands/y.txt', 'y');
  assert.deepEqual(createItem(dir, 'command', 'y', 'd'), { error: 'commands/y.txt already exists' });
  assert.deepEqual(createItem(dir, 'agent', 'Bad', 'd'), { error: NAME_RULE });
  assert.equal(fs.existsSync(path.join(dir, 'agents', 'Bad.md')), false);
});

test('splitCommandLine', () => {
  assert.deepEqual(splitCommandLine('node server.js --port 3000'), ['node', 'server.js', '--port', '3000']);
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\x.exe" a'), ['C:\\Program Files\\x.exe', 'a']);
  assert.deepEqual(splitCommandLine('  npx  -y pkg '), ['npx', '-y', 'pkg']);
  assert.deepEqual(splitCommandLine('a ""'), ['a', '']);
  assert.equal(splitCommandLine('"open'), null);
  assert.deepEqual(splitCommandLine(''), []);
});

test('mcpEntry', () => {
  assert.deepEqual(mcpEntry({ command: 'npx -y srv' }), { command: 'npx', args: ['-y', 'srv'] });
  assert.deepEqual(mcpEntry({ command: 'srv' }), { command: 'srv' });
  assert.deepEqual(mcpEntry({ url: 'http://h/x' }), { url: 'http://h/x' });
});

test('addMcpServer', (t) => {
  const root = fixture(t);

  // no file: mcp.json is created
  makePlugin(root, 'fresh');
  const fresh = path.join(root, 'fresh');
  const r = addMcpServer(fresh, 'lint', { url: 'http://h/lint' });
  assert.equal(r.file, path.join(fresh, 'mcp.json'));
  assert.equal(readText(fresh, 'mcp.json'), '{\n  "mcpServers": {\n    "lint": {\n      "url": "http://h/lint"\n    }\n  }\n}\n');

  // an existing mcp.json keeps its servers
  makePlugin(root, 'p', { extra: { 'mcp.json': '{"mcpServers":{"a":{"command":"x"}}}' } });
  const p = path.join(root, 'p');
  assert.equal(addMcpServer(p, 'b', { command: 'y' }).file, path.join(p, 'mcp.json'));
  assert.deepEqual(JSON.parse(readText(p, 'mcp.json')), { mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
  const plugin = readCatalog(root).plugins.find((x) => x.name === 'p');
  assert.deepEqual(plugin.children.map((c) => c.id), ['p/mcp/a', 'p/mcp/b']);

  // only .mcp.json: written there
  makePlugin(root, 'dot', { extra: { '.mcp.json': '{"mcpServers":{"a":{"command":"x"}}}' } });
  const dot = path.join(root, 'dot');
  assert.equal(addMcpServer(dot, 'b', { command: 'y' }).file, path.join(dot, '.mcp.json'));
  assert.equal(fs.existsSync(path.join(dot, 'mcp.json')), false);

  // top-level form: stays top-level
  makePlugin(root, 'top', { extra: { 'mcp.json': '{"a":{"command":"x"}}' } });
  const top = path.join(root, 'top');
  addMcpServer(top, 'b', { command: 'y' });
  assert.deepEqual(JSON.parse(readText(top, 'mcp.json')), { a: { command: 'x' }, b: { command: 'y' } });

  // {}: mcpServers is created
  makePlugin(root, 'empty', { extra: { 'mcp.json': '{}' } });
  const empty = path.join(root, 'empty');
  addMcpServer(empty, 'a', { command: 'x' });
  assert.deepEqual(JSON.parse(readText(empty, 'mcp.json')), { mcpServers: { a: { command: 'x' } } });

  // the name is in the other file
  makePlugin(root, 'both', { extra: { 'mcp.json': '{"mcpServers":{"z":{"command":"x"}}}', '.mcp.json': '{"mcpServers":{"a":{"command":"x"}}}' } });
  assert.deepEqual(addMcpServer(path.join(root, 'both'), 'a', { command: 'y' }), {
    error: '.mcp.json already has a server named a',
  });

  // invalid JSON: error, file unchanged
  makePlugin(root, 'bad', { extra: { 'mcp.json': '{ nope' } });
  const bad = addMcpServer(path.join(root, 'bad'), 'a', { command: 'x' });
  assert.ok(bad.error.startsWith('mcp.json: '), bad.error);
  assert.equal(readText(root, 'bad', 'mcp.json'), '{ nope');

  assert.deepEqual(addMcpServer(fresh, 'a b', { command: 'x' }), { error: SERVER_RULE });
});

function teamRepo(root, extra = {}) {
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ name: 'team', plugins: [{ name: 'a', source: './a' }], ...extra }));
  makePlugin(root, extra.metadata && extra.metadata.pluginRoot ? `${extra.metadata.pluginRoot}/a` : 'a', { name: 'a' });
}

test('createPlugin with a marketplace that lists its plugins', (t) => {
  const root = fixture(t);
  teamRepo(root);
  const r = createPlugin(root, { name: 'tool', description: ' A tool. ' });
  assert.deepEqual(r, { dir: path.join(root, 'tool') });
  assert.equal(
    readText(root, 'tool', '.cursor-plugin', 'plugin.json'),
    '{\n  "name": "tool",\n  "description": "A tool.",\n  "version": "0.1.0"\n}\n',
  );
  const plugins = marketplace(root).plugins;
  assert.deepEqual(plugins[plugins.length - 1], { name: 'tool', source: './tool', description: 'A tool.' });
  assert.deepEqual(readCatalog(root).plugins.map((p) => p.name), ['a', 'tool']);

  // no description: none in plugin.json nor in the marketplace
  assert.ok(createPlugin(root, { name: 'bare', description: '' }).dir);
  assert.deepEqual(JSON.parse(readText(root, 'bare', '.cursor-plugin', 'plugin.json')), { name: 'bare', version: '0.1.0' });
  assert.deepEqual(marketplace(root).plugins.pop(), { name: 'bare', source: './bare' });

  assert.deepEqual(createPlugin(root, { name: 'tool', description: '' }), { error: 'tool already exists' });
  assert.deepEqual(createPlugin(root, { name: 'Bad', description: '' }), { error: NAME_RULE });
});

test('createPlugin under metadata.pluginRoot', (t) => {
  const root = fixture(t);
  teamRepo(root, { metadata: { pluginRoot: 'plugins' } });
  const r = createPlugin(root, { name: 'tool', description: '' });
  assert.deepEqual(r, { dir: path.join(root, 'plugins', 'tool') });
  assert.ok(fs.existsSync(path.join(root, 'plugins', 'tool', '.cursor-plugin', 'plugin.json')));
  const plugins = marketplace(root).plugins;
  assert.equal(plugins[plugins.length - 1].source, './tool');
  assert.deepEqual(readCatalog(root).plugins.map((p) => p.name), ['a', 'tool']);
});

test('createPlugin leaves a marketplace without plugins alone', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor-plugin/marketplace.json', '{ "name": "team" }');
  makePlugin(root, 'a');
  assert.ok(createPlugin(root, { name: 'tool', description: 'x' }).dir);
  assert.equal(readText(root, '.cursor-plugin', 'marketplace.json'), '{ "name": "team" }');
  assert.deepEqual(readCatalog(root).plugins.map((p) => p.name), ['a', 'tool']);

  const bare = fixture(t);
  makePlugin(bare, 'a');
  assert.ok(createPlugin(bare, { name: 'tool', description: '' }).dir);
  assert.equal(fs.existsSync(path.join(bare, '.cursor-plugin')), false);
});

test('createPlugin refuses a taken name and a broken marketplace', (t) => {
  const root = fixture(t);
  teamRepo(root);
  makePlugin(root, 'other', { name: 'tool' });
  const market = marketplace(root);
  market.plugins.push({ name: 'other', source: './other' });
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify(market));
  assert.deepEqual(createPlugin(root, { name: 'tool', description: '' }), {
    error: 'a plugin named tool already exists in this repository',
  });
  assert.equal(fs.existsSync(path.join(root, 'tool')), false);

  const broken = fixture(t);
  writeFile(broken, '.cursor-plugin/marketplace.json', '{ nope');
  const r = createPlugin(broken, { name: 'tool', description: '' });
  assert.ok(r.error.startsWith('marketplace.json: '), r.error);
  assert.equal(fs.existsSync(path.join(broken, 'tool')), false);

  const notArray = fixture(t);
  writeFile(notArray, '.cursor-plugin/marketplace.json', '{ "name": "team", "plugins": {} }');
  assert.deepEqual(createPlugin(notArray, { name: 'tool', description: '' }), {
    error: 'marketplace.json: "plugins" is not an array',
  });
  assert.equal(fs.existsSync(path.join(notArray, 'tool')), false);
});

test('movePlugin copies a draft into a repository and deletes it', (t) => {
  const drafts = fixture(t);
  const target = fixture(t);
  makePlugin(drafts, 'tool', { skills: ['s'] });
  teamRepo(target);
  const src = path.join(drafts, 'tool');
  const r = movePlugin(src, 'tool', 'A tool.', target);
  assert.deepEqual(r, { dir: path.join(target, 'tool') });
  assert.equal(readText(target, 'tool', 'skills', 's', 'SKILL.md'), '---\nname: s\ndescription: Skill s.\n---\nbody\n');
  const plugins = marketplace(target).plugins;
  assert.deepEqual(plugins[plugins.length - 1], { name: 'tool', source: './tool', description: 'A tool.' });
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.existsSync(drafts), true);

  // a folder of that name is already in the target: nothing is touched
  makePlugin(drafts, 'tool', { skills: ['s'] });
  const again = movePlugin(src, 'tool', '', target);
  assert.deepEqual(again, { error: 'tool already exists' });
  assert.ok(fs.existsSync(path.join(src, 'skills', 's', 'SKILL.md')));
});

// Windows: a file another handle keeps open is only "delete pending", so its folder is still listed (as when Cursor
// watches a registered draft): the draft is reported as left over.
test('movePlugin reports a draft it could not remove', { skip: process.platform !== 'win32' }, (t) => {
  const drafts = fixture(t);
  const target = fixture(t);
  makePlugin(drafts, 'tool', { skills: ['s'] });
  teamRepo(target);
  const src = path.join(drafts, 'tool');
  const fd = fs.openSync(path.join(src, 'skills', 's', 'SKILL.md'), 'r');
  let r;
  try {
    r = movePlugin(src, 'tool', '', target);
  } finally {
    fs.closeSync(fd);
  }
  assert.deepEqual(r, { dir: path.join(target, 'tool'), leftover: src });
  assert.ok(fs.existsSync(path.join(target, 'tool', 'skills', 's', 'SKILL.md')));
});

test('renameIds', () => {
  assert.deepEqual(
    renameIds(['drafts:tool', 'drafts:tool/skills/a', 'drafts:toolbox', 'team:x'], 'drafts:tool', 'team:tool'),
    ['drafts:toolbox', 'team:tool', 'team:tool/skills/a', 'team:x'],
  );
  assert.deepEqual(renameIds(['a', 'a'], 'b', 'c'), ['a']);
});

test('declaredPathsError', () => {
  const plugin = { name: 'r:p', customPaths: ['commands'] };
  assert.equal(
    declaredPathsError(plugin, 'command'),
    'r:p sets the paths of its commands in plugin.json: add the file there by hand.',
  );
  assert.equal(declaredPathsError(plugin, 'skill'), '');
  assert.equal(declaredPathsError({ name: 'r:p' }, 'command'), '');
  assert.equal(
    declaredPathsError({ name: 'r:p', customPaths: ['mcpServers'] }, 'mcp'),
    'r:p sets the paths of its MCP servers in plugin.json: add the file there by hand.',
  );
});
