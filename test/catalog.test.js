'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog, frontmatterDescription, frontmatterField, mcpServerNames, filterMcpJson } = require('../lib/catalog');
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

test('readCatalog returns the renamed record, keeping only usable entries', (t) => {
  const root = fixture(t);
  makePlugin(root, 'a', { skills: ['s'] });
  assert.deepEqual(readCatalog(root).renamed, {});
  writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({
      name: 'team',
      plugins: [{ name: 'a', source: './a' }],
      renamed: { old: 'a', 'a/skills/x': 'a/skills/s', same: 'same', empty: '', num: 3, '': 'x' },
    }),
  );
  const c = readCatalog(root);
  assert.deepEqual(c.renamed, { old: 'a', 'a/skills/x': 'a/skills/s' });
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.plugins.map((p) => p.name), ['a']);
});

test('readCatalog reads renamed from a marketplace.json without plugins, and warns when it is not an object', (t) => {
  const root = fixture(t);
  makePlugin(root, 'a', {});
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ renamed: { old: 'a' } }));
  const c = readCatalog(root);
  assert.deepEqual(c.renamed, { old: 'a' });
  assert.equal(c.name, '');
  assert.deepEqual(c.plugins.map((p) => p.name), ['a']);
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ renamed: ['x'] }));
  const bad = readCatalog(root);
  assert.deepEqual(bad.renamed, {});
  assert.deepEqual(bad.warnings, ['marketplace.json: "renamed" is not an object']);
  assert.deepEqual(bad.plugins.map((p) => p.name), ['a']);
});

// ---- problems (lib/checks.js) ------------------------------------------------------------------------------------

test('a skill with broken YAML is listed with a problem', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { skills: ['ok'] });
  const file = writeFile(root, 'p/skills/bad/SKILL.md', '---\nname: bad\ndescription: Use when: x\n---\nBody\n');
  const { plugins } = readCatalog(root);
  const bad = plugins[0].children.find((c) => c.id === 'p/skills/bad');
  assert.ok(bad);
  assert.equal(bad.description, frontmatterField(fs.readFileSync(file, 'utf8'), 'description'));
  assert.equal(bad.problems.length, 1);
  assert.equal(bad.problems[0].severity, 'error');
  assert.equal(bad.problems[0].file, file);
  assert.equal(bad.problems[0].line, 3);
  assert.equal(plugins[0].children.find((c) => c.id === 'p/skills/ok').problems, undefined);
});

test('skills and rules carry their context cost, commands do not', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', {});
  writeFile(root, 'p/rules/always.mdc', '---\nalwaysApply: true\n---\nabcd\n');
  writeFile(root, 'p/rules/ts.mdc', '---\nglobs: "*.ts"\n---\nx\n');
  writeFile(root, 'p/skills/s/SKILL.md', '---\nname: s\ndescription: Review code.\n---\nBody\n');
  writeFile(root, 'p/commands/c.md', '---\ndescription: A command\n---\nDo it\n');
  const { plugins } = readCatalog(root);
  const by = (id) => plugins[0].children.find((c) => c.id === id);
  assert.deepEqual(by('p/rules/always.mdc').context, { apply: 'always', chars: 4 });
  assert.deepEqual(by('p/rules/ts.mdc').context, { apply: 'globs', chars: 1, globs: ['*.ts'] });
  assert.deepEqual(by('p/skills/s').context, { apply: 'description', chars: 12 });
  assert.ok(by('p/commands/c.md'));
  assert.equal(Object.prototype.hasOwnProperty.call(by('p/commands/c.md'), 'context'), false);
});

test('skills (and rules) of one plugin with the same name: the later ones get a problem', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', {});
  const skill = (name) => (name ? `---\nname: ${name}\ndescription: d\n---\nb\n` : '---\ndescription: d\n---\nb\n');
  writeFile(root, 'p/skills/a-first/SKILL.md', skill('dup'));
  writeFile(root, 'p/skills/b-second/SKILL.md', skill('Dup'));
  writeFile(root, 'p/skills/dup/SKILL.md', skill(''));
  const { plugins } = readCatalog(root);
  const by = (id) => plugins[0].children.find((c) => c.id === id);
  assert.equal(by('p/skills/a-first').problems, undefined);
  assert.deepEqual(by('p/skills/b-second').problems.map((p) => p.message), [
    'Same name as a-first ("dup"), so Cursor loads only one of them',
  ]);
  assert.equal(by('p/skills/b-second').problems[0].line, 1);
  assert.equal(by('p/skills/b-second').problems[0].severity, 'error');
  assert.deepEqual(by('p/skills/dup').problems.map((p) => p.message), [
    'Same name as a-first ("dup"), so Cursor loads only one of them',
  ]);

  const rules = fixture(t);
  makePlugin(rules, 'p', { rules: ['a.md', 'a.mdc', 'b.mdc'] });
  const r = readCatalog(rules).plugins[0].children;
  assert.equal(r.find((c) => c.id === 'p/rules/a.md').problems, undefined);
  assert.deepEqual(r.find((c) => c.id === 'p/rules/a.mdc').problems.map((p) => p.message), [
    'Same name as a.md ("a"), so Cursor loads only one of them',
  ]);
  assert.equal(r.find((c) => c.id === 'p/rules/b.mdc').problems, undefined);
  // skills and rules are compared within their own kind
  const mixed = fixture(t);
  makePlugin(mixed, 'p', { skills: ['x'], rules: ['x.mdc'] });
  assert.ok(readCatalog(mixed).plugins[0].children.every((c) => !c.problems));
});

test('an mcp.json with comments and a trailing comma gives its servers, no warning and no problem', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', {
    extra: { 'mcp.json': '{\n  // servers\n  "mcpServers": {\n    "a": {"command": "x"}, /* c */\n  },\n}\n' },
  });
  const { plugins, warnings, problems } = readCatalog(root);
  assert.deepEqual(plugins[0].children.map((c) => `${c.kind}:${c.name}`), ['mcp:a']);
  assert.deepEqual(warnings, []);
  assert.deepEqual(problems, []);
  assert.equal(plugins[0].problems, undefined);
});

test('an mcp.json that does not parse is a warning and a problem of the plugin', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { extra: { 'mcp.json': "{'a': 1}" } });
  const { plugins, warnings } = readCatalog(root);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith('p: mcp.json:'));
  assert.equal(plugins[0].problems.length, 1);
  assert.ok(plugins[0].problems[0].message.startsWith('mcp.json is not valid JSON, so Cursor may not load its MCP servers: '));
  assert.equal(plugins[0].problems[0].file, path.join(root, 'p', 'mcp.json'));
});

test('a plugin.json that starts with a BOM is a problem, and is still read', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { manifest: false });
  writeFile(root, 'p/.cursor-plugin/plugin.json', '﻿' + JSON.stringify({ name: 'p', displayName: 'Pretty' }));
  const { plugins, warnings } = readCatalog(root);
  assert.equal(plugins[0].displayName, 'Pretty');
  assert.deepEqual(warnings, []);
  assert.equal(plugins[0].problems.length, 1);
  assert.equal(
    plugins[0].problems[0].message,
    'plugin.json starts with a byte order mark (BOM), so Cursor ignores it (its name, display name and declared folders): save it as UTF-8 without BOM',
  );
  assert.equal(plugins[0].problems[0].line, 1);
});

test('a marketplace.json that does not parse is a repository problem, the plugins are found by folder', (t) => {
  const root = fixture(t);
  makePlugin(root, 'a', {});
  const file = writeFile(root, '.cursor-plugin/marketplace.json', '{\n  "name": "t",\n  "plugins": [],\n}\n');
  const c = readCatalog(root);
  assert.equal(c.problems.length, 1);
  assert.equal(c.problems[0].file, file);
  assert.ok(c.problems[0].line >= 1);
  assert.ok(c.problems[0].message.startsWith('marketplace.json is not valid JSON, so Cursor ignores it (the plugin list and the repository name): '));
  assert.equal(c.warnings.length, 1);
  assert.ok(c.warnings[0].startsWith('marketplace.json: '));
  assert.deepEqual(c.plugins.map((p) => p.name), ['a']);
});

test('the warnings that are not about a loaded plugin are repository problems too', (t) => {
  const root = fixture(t);
  makePlugin(root, 'a', {});
  const file = writeFile(
    root,
    '.cursor-plugin/marketplace.json',
    JSON.stringify({ plugins: [{ name: 'a', source: './a' }, { name: 'x', source: './missing' }, { name: 'y' }], renamed: 3 }),
  );
  const c = readCatalog(root);
  assert.deepEqual(c.problems.map((p) => [p.file, p.line, p.severity, p.message]).sort(), [
    [file, 0, 'error', 'plugin "x": folder not found: missing'],
    [file, 0, 'error', 'plugin "y": unsupported source (only folders of this repository)'],
    [file, 0, 'warning', 'marketplace.json: "renamed" is not an object'],
  ].sort());
  const notArray = fixture(t);
  const f2 = writeFile(notArray, '.cursor-plugin/marketplace.json', JSON.stringify({ plugins: 3 }));
  assert.deepEqual(readCatalog(notArray).problems, [
    { file: f2, line: 0, severity: 'error', message: 'marketplace.json: "plugins" is not an array' },
  ]);
  const gone = readCatalog(path.join(root, 'nowhere'));
  assert.equal(gone.problems.length, 1);
  assert.equal(gone.problems[0].file, '');
  assert.ok(gone.problems[0].message.startsWith('repository folder not found'));
  const dup = fixture(t);
  makePlugin(dup, 'one', { name: 'same' });
  makePlugin(dup, 'two', { name: 'same' });
  const d = readCatalog(dup);
  assert.deepEqual(d.problems.map((p) => [p.file, p.message]), [
    [path.join(dup, 'two', '.cursor-plugin', 'plugin.json'), 'duplicate plugin name "same" (two): skipped'],
  ]);
});

test('the fixture repository has no problem', () => {
  const c = readCatalog(path.join(__dirname, 'fixtures', 'team-repo'));
  assert.deepEqual(c.problems, []);
  assert.deepEqual(c.warnings, []);
  assert.ok(c.plugins.length > 0);
  for (const p of c.plugins) {
    assert.equal(p.problems, undefined, p.name);
    for (const child of p.children) {
      assert.equal(child.problems, undefined, child.id);
    }
  }
});

test('filterMcpJson reads comments and trailing commas', () => {
  const text = '{\n  // c\n  "mcpServers": {"a": {"command": "x"}, "b": {"command": "y"},},\n}';
  assert.deepEqual(JSON.parse(filterMcpJson(text, ['a'])), { mcpServers: { b: { command: 'y' } } });
});
