'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const { NAME_RULE, SERVER_RULE } = require('../lib/authoring');
const { recordRename, renameItem, renamePlugin } = require('../lib/rename');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

function fixture(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  return root;
}

const MARKET = '.cursor-plugin/marketplace.json';
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const has = (root, rel) => fs.existsSync(path.join(root, rel));

function listed(root, plugins = [{ name: 'review', source: './review', description: 'Reviews' }]) {
  writeFile(root, MARKET, JSON.stringify({ name: 'team', plugins }));
}

// an item as the extension passes it: from the catalog of the repository
function itemOf(root, kind, name, pluginName = 'review') {
  const plugin = readCatalog(root).plugins.find((p) => p.name === pluginName);
  const child = plugin.children.find((c) => c.kind === kind && c.name === name);
  assert.ok(child, `no ${kind} ${name}`);
  return { pluginDir: plugin.dir, pluginName, kind, name, file: child.file };
}

test('recordRename', () => {
  assert.deepEqual(recordRename({}, 'a', 'b'), { a: 'b' });
  assert.deepEqual(recordRename({ a: 'b' }, 'b', 'c'), { a: 'c', b: 'c' });
  assert.deepEqual(recordRename({ a: 'b' }, 'b', 'a'), { b: 'a' });
  assert.deepEqual(recordRename({ 'p/skills/x': 'p/skills/y' }, 'p', 'q'), { 'p/skills/x': 'q/skills/y', p: 'q' });
  assert.deepEqual(recordRename({ c: 'd' }, 'x', 'c'), { x: 'c' });
  const input = { a: 'b' };
  recordRename(input, 'b', 'c');
  assert.deepEqual(input, { a: 'b' });
});

test('renameItem renames a skill: folder, name and record', (t) => {
  const root = fixture(t);
  listed(root);
  makePlugin(root, 'review', { skills: ['old', 'other'] });
  const before = read(root, 'review/skills/old/SKILL.md');
  const result = renameItem(itemOf(root, 'skill', 'old'), ' new ', { repoDir: root, record: true });
  assert.deepEqual(result, { id: 'review/skills/new', file: path.join(root, 'review', 'skills', 'new', 'SKILL.md') });
  assert.ok(!has(root, 'review/skills/old'));
  assert.equal(read(root, 'review/skills/new/SKILL.md'), before.replace('name: old', 'name: new'));
  assert.deepEqual(readJson(root, MARKET).renamed, { 'review/skills/old': 'review/skills/new' });
  assert.deepEqual(readJson(root, MARKET).plugins, [{ name: 'review', source: './review', description: 'Reviews' }]);
  assert.ok(has(root, 'review/skills/other/SKILL.md'));
});

test('renameItem leaves the name of a skill that differs from its folder', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', {});
  writeFile(root, 'review/skills/old/SKILL.md', '---\nname: something-else\ndescription: D\n---\nbody\n');
  const result = renameItem(itemOf(root, 'skill', 'old'), 'new', { repoDir: root, record: false });
  assert.equal(result.id, 'review/skills/new');
  assert.match(read(root, 'review/skills/new/SKILL.md'), /^name: something-else$/m);
});

test('renameItem renames a rule and refuses a clash', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', { rules: ['style.mdc'] });
  writeFile(root, 'review/rules/other.mdc', 'x');
  const clashing = renameItem(itemOf(root, 'rule', 'style'), 'other', { repoDir: root, record: true });
  assert.deepEqual(clashing, { error: 'rules/other.mdc already exists' });
  writeFile(root, 'review/rules/styling.md', 'y');
  assert.deepEqual(renameItem(itemOf(root, 'rule', 'style'), 'styling', { repoDir: root, record: true }), {
    error: 'rules/styling.md already exists',
  });
  assert.ok(has(root, 'review/rules/style.mdc'));
  assert.ok(!has(root, MARKET));
  fs.rmSync(path.join(root, 'review/rules/styling.md'));
  const result = renameItem(itemOf(root, 'rule', 'style'), 'styling', { repoDir: root, record: true });
  assert.deepEqual(result, { id: 'review/rules/styling.mdc', file: path.join(root, 'review', 'rules', 'styling.mdc') });
  assert.ok(has(root, 'review/rules/styling.mdc') && !has(root, 'review/rules/style.mdc'));
  assert.deepEqual(readJson(root, MARKET), { renamed: { 'review/rules/style.mdc': 'review/rules/styling.mdc' } });
});

test('renameItem keeps the extension of a command, and rewrites the name of an agent', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', {});
  writeFile(root, 'review/commands/x.txt', '---\ndescription: D\n---\nrun\n');
  writeFile(root, 'review/agents/x.md', '---\nname: x\ndescription: D\n---\nrole\n');
  const command = renameItem(itemOf(root, 'command', 'x'), 'y', { repoDir: root, record: false });
  assert.equal(command.id, 'review/commands/y.txt');
  assert.equal(read(root, 'review/commands/y.txt'), '---\ndescription: D\n---\nrun\n');
  const agent = renameItem(itemOf(root, 'agent', 'x'), 'y', { repoDir: root, record: false });
  assert.equal(agent.id, 'review/agents/y.md');
  assert.equal(read(root, 'review/agents/y.md'), '---\nname: y\ndescription: D\n---\nrole\n');
});

test('renameItem refuses a bad name and the same name', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', { skills: ['old'] });
  writeFile(root, 'review/mcp.json', JSON.stringify({ mcpServers: { a: { command: 'x' } } }));
  assert.deepEqual(renameItem(itemOf(root, 'skill', 'old'), 'Bad Name', { repoDir: root }), { error: NAME_RULE });
  assert.deepEqual(renameItem(itemOf(root, 'mcp', 'a'), 'bad name', { repoDir: root }), { error: SERVER_RULE });
  assert.deepEqual(renameItem(itemOf(root, 'skill', 'old'), 'old', { repoDir: root }), { error: 'That is already its name.' });
  assert.ok(has(root, 'review/skills/old/SKILL.md'));
});

test('renameItem renames an MCP server in place (mcpServers form)', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', {});
  const servers = { a: { command: 'x' }, b: { url: 'http://h' }, c: { command: 'z', args: ['1'] } };
  writeFile(root, 'review/mcp.json', JSON.stringify({ $schema: 's', mcpServers: servers }));
  const result = renameItem(itemOf(root, 'mcp', 'b'), 'z', { repoDir: root, record: true });
  assert.deepEqual(result, { id: 'review/mcp/z', file: path.join(root, 'review', 'mcp.json') });
  const file = readJson(root, 'review/mcp.json');
  assert.deepEqual(Object.keys(file), ['$schema', 'mcpServers']);
  assert.deepEqual(Object.keys(file.mcpServers), ['a', 'z', 'c']);
  assert.deepEqual(file.mcpServers.z, { url: 'http://h' });
  assert.deepEqual(readJson(root, MARKET).renamed, { 'review/mcp/b': 'review/mcp/z' });
});

test('renameItem renames an MCP server of the top-level form, in both files that have it', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', {});
  writeFile(root, 'review/mcp.json', JSON.stringify({ a: { command: 'x' }, b: { command: 'y' }, c: { url: 'u' } }));
  writeFile(root, 'review/.mcp.json', JSON.stringify({ mcpServers: { b: { command: 'other' } } }));
  const result = renameItem(itemOf(root, 'mcp', 'b'), 'z', { repoDir: root, record: false });
  assert.equal(result.id, 'review/mcp/z');
  assert.deepEqual(Object.keys(readJson(root, 'review/mcp.json')), ['a', 'z', 'c']);
  assert.deepEqual(readJson(root, 'review/.mcp.json'), { mcpServers: { z: { command: 'other' } } });
});

test('renameItem refuses an MCP name that either file already has, and changes nothing', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', {});
  const a = JSON.stringify({ mcpServers: { a: { command: 'x' } } });
  const b = JSON.stringify({ mcpServers: { b: { command: 'y' } } });
  writeFile(root, 'review/.mcp.json', a);
  writeFile(root, 'review/mcp.json', b);
  const item = itemOf(root, 'mcp', 'a');
  assert.deepEqual(renameItem(item, 'b', { repoDir: root, record: true }), { error: 'mcp.json already has a server named b' });
  assert.equal(read(root, 'review/.mcp.json'), a);
  assert.equal(read(root, 'review/mcp.json'), b);
  assert.ok(!has(root, MARKET));
});

test('renameItem with record false writes no marketplace.json; with record true it creates only the record', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', { skills: ['old'] });
  renameItem(itemOf(root, 'skill', 'old'), 'new', { repoDir: root, record: false });
  assert.ok(!has(root, MARKET));
  renameItem(itemOf(root, 'skill', 'new'), 'newer', { repoDir: root, record: true });
  assert.equal(read(root, MARKET), JSON.stringify({ renamed: { 'review/skills/new': 'review/skills/newer' } }, null, 2) + '\n');
  const catalog = readCatalog(root);
  assert.equal(catalog.name, '');
  assert.deepEqual(catalog.plugins.map((p) => p.name), ['review']);
  assert.deepEqual(catalog.renamed, { 'review/skills/new': 'review/skills/newer' });
});

test('renameItem refuses a marketplace.json it cannot record in, before changing anything', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', { skills: ['old'] });
  writeFile(root, MARKET, '{ nope');
  const result = renameItem(itemOf(root, 'skill', 'old'), 'new', { repoDir: root, record: true });
  assert.ok(result.error.startsWith('marketplace.json: '), result.error);
  assert.ok(has(root, 'review/skills/old/SKILL.md') && !has(root, 'review/skills/new'));
  writeFile(root, MARKET, JSON.stringify({ renamed: [1] }));
  assert.deepEqual(renameItem(itemOf(root, 'skill', 'old'), 'new', { repoDir: root, record: true }), {
    error: 'marketplace.json: "renamed" is not an object',
  });
  writeFile(root, MARKET, '[]');
  assert.deepEqual(renameItem(itemOf(root, 'skill', 'old'), 'new', { repoDir: root, record: true }), {
    error: 'marketplace.json is not a JSON object',
  });
  assert.ok(has(root, 'review/skills/old/SKILL.md'));
});

test('renamePlugin renames the folder, plugin.json, the marketplace entry and records it', (t) => {
  const root = fixture(t);
  listed(root);
  makePlugin(root, 'review', { skills: ['s'] });
  writeFile(root, 'review/.cursor-plugin/plugin.json', JSON.stringify({ version: '1.0.0', name: 'review', description: 'D' }));
  const result = renamePlugin({ dir: path.join(root, 'review'), pluginName: 'review' }, 'audit', { repoDir: root, record: true });
  assert.deepEqual(result, { id: 'audit', dir: path.join(root, 'audit') });
  assert.ok(!has(root, 'review'));
  const manifest = readJson(root, 'audit/.cursor-plugin/plugin.json');
  assert.deepEqual(Object.keys(manifest), ['version', 'name', 'description']);
  assert.equal(manifest.name, 'audit');
  const market = readJson(root, MARKET);
  assert.deepEqual(market.plugins, [{ name: 'audit', source: './audit', description: 'Reviews' }]);
  assert.deepEqual(market.renamed, { review: 'audit' });
  const catalog = readCatalog(root);
  assert.deepEqual(catalog.plugins.map((p) => p.name), ['audit']);
  assert.deepEqual(catalog.plugins[0].children.map((c) => c.id), ['audit/skills/s']);
});

test('renamePlugin writes the source relative to metadata.pluginRoot', (t) => {
  const root = fixture(t);
  writeFile(
    root,
    MARKET,
    JSON.stringify({ name: 'team', metadata: { pluginRoot: 'plugins' }, plugins: [{ name: 'review', source: { path: 'review' } }] }),
  );
  makePlugin(root, 'plugins/review', { skills: ['s'] });
  const result = renamePlugin({ dir: path.join(root, 'plugins', 'review'), pluginName: 'review' }, 'audit', {
    repoDir: root,
    record: true,
  });
  assert.equal(result.id, 'audit');
  assert.deepEqual(readJson(root, MARKET).plugins, [{ name: 'audit', source: { path: './audit' } }]);
  assert.ok(has(root, 'plugins/audit/skills/s/SKILL.md'));
  assert.deepEqual(readCatalog(root).plugins.map((p) => p.name), ['audit']);
});

test('renamePlugin puts a missing name first in plugin.json', (t) => {
  const root = fixture(t);
  listed(root);
  makePlugin(root, 'review', { manifest: false });
  writeFile(root, 'review/.cursor-plugin/plugin.json', JSON.stringify({ version: '1.0.0' }));
  renamePlugin({ dir: path.join(root, 'review'), pluginName: 'review' }, 'audit', { repoDir: root, record: false });
  assert.deepEqual(Object.entries(readJson(root, 'audit/.cursor-plugin/plugin.json')), [['name', 'audit'], ['version', '1.0.0']]);
});

test('renamePlugin in a repository without marketplace.json: folder and plugin.json only when record is false', (t) => {
  const root = fixture(t);
  makePlugin(root, 'review', { skills: ['s'] });
  const result = renamePlugin({ dir: path.join(root, 'review'), pluginName: 'review' }, 'audit', { repoDir: root, record: false });
  assert.equal(result.id, 'audit');
  assert.equal(readJson(root, 'audit/.cursor-plugin/plugin.json').name, 'audit');
  assert.ok(!has(root, MARKET));
  assert.deepEqual(readCatalog(root).plugins.map((p) => p.name), ['audit']);
  renamePlugin({ dir: path.join(root, 'audit'), pluginName: 'audit' }, 'final', { repoDir: root, record: true });
  assert.deepEqual(readJson(root, MARKET), { renamed: { audit: 'final' } });
});

test('renamePlugin refuses a name another plugin has or an existing folder, and changes nothing', (t) => {
  const root = fixture(t);
  listed(root, [
    { name: 'review', source: './review' },
    { name: 'docs', source: './docs' },
  ]);
  makePlugin(root, 'review', {});
  makePlugin(root, 'docs', {});
  writeFile(root, 'other/notes.txt', 'x'); // a folder that is not a plugin
  const plugin = { dir: path.join(root, 'review'), pluginName: 'review' };
  const before = read(root, MARKET);
  assert.deepEqual(renamePlugin(plugin, 'docs', { repoDir: root, record: true }), {
    error: 'docs already exists',
  });
  assert.deepEqual(renamePlugin(plugin, 'other', { repoDir: root, record: true }), { error: 'other already exists' });
  assert.deepEqual(renamePlugin(plugin, 'review', { repoDir: root, record: true }), { error: 'That is already its name.' });
  assert.deepEqual(renamePlugin(plugin, 'Bad Name', { repoDir: root, record: true }), { error: NAME_RULE });
  assert.ok(has(root, 'review/.cursor-plugin/plugin.json'));
  assert.equal(read(root, MARKET), before);
  // a plugin of that name in another folder
  makePlugin(root, 'zzz', { name: 'taken' });
  writeFile(root, MARKET, JSON.stringify({ plugins: [{ name: 'review', source: './review' }, { name: 'taken', source: './zzz' }] }));
  assert.deepEqual(renamePlugin(plugin, 'taken', { repoDir: root, record: true }), {
    error: 'a plugin named taken already exists in this repository',
  });
});

test('renamePlugin refuses a marketplace without an entry for the folder', (t) => {
  const root = fixture(t);
  listed(root, [{ name: 'docs', source: './docs' }]);
  makePlugin(root, 'docs', {});
  makePlugin(root, 'review', {});
  const result = renamePlugin({ dir: path.join(root, 'review'), pluginName: 'review' }, 'audit', { repoDir: root, record: true });
  assert.deepEqual(result, { error: 'marketplace.json has no entry for review' });
  assert.ok(has(root, 'review'));
});
