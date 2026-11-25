'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog, frontmatterDescription, mcpServerNames, filterMcpJson } = require('../lib/catalog');
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

test('the marketplace name is the repository name', (t) => {
  const root = fixture(t);
  writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({ name: ' team-test ', plugins: [{ name: 'a', source: './a' }] }),
  );
  makePlugin(root, 'a', {});
  assert.equal(readCatalog(root).name, 'team-test');

  const bare = fixture(t);
  makePlugin(bare, 'a', {});
  assert.equal(readCatalog(bare).name, '');

  const broken = fixture(t);
  writeFile(broken, '.cursor-plugin/marketplace.json', '{');
  assert.equal(readCatalog(broken).name, '');
  assert.equal(readCatalog(path.join(broken, 'missing')).name, '');
});

test('a marketplace with only a name finds the plugins by folder', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ name: 'only-name' }));
  makePlugin(root, 'one', {});
  makePlugin(root, 'two', {});
  const { name, plugins, warnings } = readCatalog(root);
  assert.equal(name, 'only-name');
  assert.deepEqual(plugins.map((p) => p.name), ['one', 'two']);
  assert.deepEqual(warnings, []);
});

test('a plugins value that is not an array still warns', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ plugins: 3 }));
  makePlugin(root, 'one', {});
  const { plugins, warnings } = readCatalog(root);
  assert.equal(plugins.length, 0);
  assert.deepEqual(warnings, ['marketplace.json: "plugins" is not an array']);
});

test('commands, agents and MCP servers are children, after skills and rules', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', {
    skills: ['s'],
    rules: ['r.mdc'],
    extra: {
      'commands/b.md': '---\ndescription: Command b\n---\n',
      'commands/a.txt': 'plain',
      'commands/notes.json': '{}',
      'commands/sub/deep.md': 'deep',
      'agents/helper.md': '---\ndescription: Helper agent\n---\n',
      'agents/x.txt': 'not an agent',
      'mcp.json':
        '{"mcpServers":{"zeta":{"command":"node","args":["z.js","--flag"]},"alpha":{"url":"http://h/mcp"}}}',
    },
  });
  const { plugins, warnings } = readCatalog(root);
  const [p] = plugins;
  assert.deepEqual(p.children.map((c) => c.id), [
    'p/skills/s',
    'p/rules/r.mdc',
    'p/commands/a.txt',
    'p/commands/b.md',
    'p/agents/helper.md',
    'p/mcp/alpha',
    'p/mcp/zeta',
  ]);
  assert.deepEqual(p.children.map((c) => c.kind), ['skill', 'rule', 'command', 'command', 'agent', 'mcp', 'mcp']);
  assert.deepEqual(p.children.slice(2, 5).map((c) => c.name), ['a', 'b', 'helper']);
  const byId = (id) => p.children.find((c) => c.id === id);
  assert.equal(byId('p/commands/b.md').description, 'Command b');
  assert.equal(byId('p/commands/a.txt').description, '');
  assert.equal(byId('p/mcp/zeta').description, 'node z.js --flag');
  assert.equal(byId('p/mcp/alpha').description, 'http://h/mcp');
  assert.equal(byId('p/mcp/zeta').file, path.join(p.dir, 'mcp.json'));
  assert.equal(byId('p/mcp/alpha').file, path.join(p.dir, 'mcp.json'));
  assert.deepEqual(p.mcpFiles, { 'mcp.json': ['zeta', 'alpha'] });
  assert.deepEqual(warnings, []);
});

test('.mcp.json wins and the top-level form is read', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', {
    extra: {
      '.mcp.json': '{"mcpServers":{"gamma":{"command":"dot"},"delta":{"command":"d"}}}',
      'mcp.json':
        '{"$schema":"x","gamma":{"command":"plain"},"epsilon":{"url":"u"},"metadata":{"url":"m"},"note":"text"}',
    },
  });
  const { plugins } = readCatalog(root);
  const [p] = plugins;
  assert.deepEqual(p.children.map((c) => c.id), ['p/mcp/delta', 'p/mcp/epsilon', 'p/mcp/gamma']);
  const gamma = p.children[2];
  assert.equal(gamma.description, 'dot');
  assert.ok(gamma.file.endsWith('.mcp.json'));
  assert.deepEqual(p.mcpFiles, { '.mcp.json': ['gamma', 'delta'], 'mcp.json': ['gamma', 'epsilon'] });
});

test('kinds declared in plugin.json are not selectable (no mcpFiles property)', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', {
    skills: ['s'],
    extra: {
      '.cursor-plugin/plugin.json': JSON.stringify({
        name: 'p',
        commands: './cmds/',
        agents: ['./a.md'],
        mcpServers: { x: { command: 'c' } },
      }),
      'commands/c.md': 'c',
      'agents/a.md': 'a',
      'mcp.json': '{"mcpServers":{"y":{"command":"c"}}}',
    },
  });
  const { plugins } = readCatalog(root);
  assert.deepEqual(plugins[0].children.map((c) => c.id), ['p/skills/s']);
  assert.equal(plugins[0].mcpFiles, undefined);
  assert.deepEqual(plugins[0].customPaths, ['commands', 'agents', 'mcpServers']);
});

test('customPaths lists the kinds plugin.json declares, only when there are some', (t) => {
  const root = fixture(t);
  makePlugin(root, 'declared', {
    extra: { '.cursor-plugin/plugin.json': JSON.stringify({ name: 'declared', commands: './cmds', skills: [] }) },
  });
  makePlugin(root, 'plain', { skills: ['s'] });
  const { plugins } = readCatalog(root);
  const byName = Object.fromEntries(plugins.map((p) => [p.name, p]));
  assert.deepEqual(byName.declared.customPaths, ['skills', 'commands']);
  assert.ok(!('customPaths' in byName.plain));
});

test('an invalid mcp.json is a warning', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { extra: { 'mcp.json': '{ nope' } });
  const { plugins, warnings } = readCatalog(root);
  assert.deepEqual(plugins[0].children, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith('p: mcp.json:'), warnings[0]);
});

test('mcpServerNames', () => {
  assert.deepEqual(mcpServerNames({}), []);
  assert.deepEqual(mcpServerNames({ mcpServers: {}, a: { command: 'x' } }), ['a']);
  assert.deepEqual(mcpServerNames([1]), []);
  assert.deepEqual(mcpServerNames({ mcpServers: { b: {} } }), ['b']);
  assert.deepEqual(mcpServerNames({ Owner: { url: 'u' }, k: { command: 'c' }, s: 'str' }), ['k']);
});

test('filterMcpJson', () => {
  assert.equal(
    filterMcpJson('{"$schema":"s","mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}', ['b']),
    '{\n  "$schema": "s",\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  }\n}\n',
  );
  assert.deepEqual(JSON.parse(filterMcpJson('{"a":{"command":"x"},"b":{"url":"u"},"c":3}', ['a'])), {
    b: { url: 'u' },
    c: 3,
  });
  assert.equal(filterMcpJson('{ nope', ['a']), '{ nope');
  assert.deepEqual(JSON.parse(filterMcpJson('﻿{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}', ['a'])), {
    mcpServers: { b: { command: 'y' } },
  });
});
