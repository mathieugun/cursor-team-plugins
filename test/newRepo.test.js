'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeGit } = require('../lib/git');
const { readCatalog } = require('../lib/catalog');
const { IDENTITY_MESSAGE } = require('../lib/contribute');
const { checkRemote } = require('../lib/sync');
const { projectItems } = require('../lib/share');
const { nameError } = require('../lib/authoring');
const n = require('../lib/newRepo');
const { tmpDir, rmDir, writeFile, git, gitAvailable, commitAll } = require('./helpers');

function fixture(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  return root;
}

const TOKEN = `ghp_${'a'.repeat(36)}`;
const skillText = (name, body = 'Body.') => `---\nname: ${name}\ndescription: Skill ${name}.\n---\n${body}\n`;

// { label, root, personal } of a project folder made of the given files (rel -> text)
function project(root, label, files = {}, personal = false) {
  for (const [rel, text] of Object.entries(files)) {
    writeFile(path.join(root, label), rel, text);
  }
  fs.mkdirSync(path.join(root, label), { recursive: true });
  return { label: personal ? '~/.cursor' : label, root: path.join(root, label), personal };
}

test('secretName reads names as Cursor does', () => {
  for (const name of ['GITHUB_TOKEN', 'apiKey', 'ApiKey', 'api-key', 'APIKEY', 'Authorization', 'DB_PASSWORD']) {
    assert.equal(n.secretName(name), true, name);
  }
  for (const name of ['KEYBOARD', 'MONKEY', 'PATH', 'HOME', 'TOKENIZER_MODE']) {
    assert.equal(n.secretName(name), false, name);
  }
});

test('envVarName', () => {
  assert.equal(n.envVarName('github-token'), 'GITHUB_TOKEN');
  assert.equal(n.envVarName('9lives'), 'MCP_9LIVES');
  assert.equal(n.envVarName('my server_Authorization'), 'MY_SERVER_AUTHORIZATION');
});

test('redactServer replaces literal secrets of env and keeps references', () => {
  const input = {
    command: 'npx',
    env: { GITHUB_TOKEN: 'ghp_abc', LOG_LEVEL: 'debug', API_KEY: '${env:X}', DB_PASSWORD: 'p-${env:X}' },
  };
  const copy = JSON.parse(JSON.stringify(input));
  const r = n.redactServer('gh', input);
  assert.deepEqual(input, copy);
  assert.equal(r.entry.env.GITHUB_TOKEN, '${env:GITHUB_TOKEN}');
  assert.equal(r.entry.env.LOG_LEVEL, 'debug');
  assert.equal(r.entry.env.API_KEY, '${env:X}');
  assert.equal(r.entry.env.DB_PASSWORD, '${env:DB_PASSWORD}');
  assert.deepEqual(r.replaced, [
    { where: 'env.GITHUB_TOKEN', variable: 'GITHUB_TOKEN' },
    { where: 'env.DB_PASSWORD', variable: 'DB_PASSWORD' },
  ]);
  assert.deepEqual(r.suspects, []);
  assert.deepEqual(n.redactServer('x', 5), { entry: 5, replaced: [], suspects: [], hidden: [] });
});

test('redactServer replaces the secret headers', () => {
  let r = n.redactServer('docs', {
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer abc123', 'X-Trace': '1' },
  });
  assert.equal(r.entry.headers.Authorization, 'Bearer ${env:DOCS_TOKEN}');
  assert.equal(r.entry.headers['X-Trace'], '1');
  assert.deepEqual(r.replaced, [{ where: 'headers.Authorization', variable: 'DOCS_TOKEN' }]);
  r = n.redactServer('docs', { url: 'https://x/mcp', headers: { Authorization: 'Bearer ${env:T}' } });
  assert.equal(r.entry.headers.Authorization, 'Bearer ${env:T}');
  assert.deepEqual(r.replaced, []);
  r = n.redactServer('a', { headers: { 'X-Api-Key': 'k' } });
  assert.equal(r.entry.headers['X-Api-Key'], '${env:A_X_API_KEY}');
  r = n.redactServer('a', { headers: { Authorization: 'Bearer x', 'Proxy-Authorization': 'Bearer y' } });
  assert.deepEqual(
    r.replaced.map((x) => x.variable),
    ['A_TOKEN', 'A_TOKEN_2'],
  );
});

test('redactServer reports the other suspected secrets without their values', () => {
  const suspects = (entry) => n.redactServer('s', entry).suspects;
  assert.deepEqual(suspects({ url: 'https://u:p@h/x' }), ['the URL holds credentials']);
  assert.deepEqual(suspects({ url: 'https://tok@h/x' }), ['the URL holds credentials']);
  assert.deepEqual(suspects({ url: 'https://h/x?to%6Ben=abc&q=1' }), ['the URL parameter token holds a value']);
  assert.deepEqual(suspects({ args: ['--api-key=abc'] }), ['args[0] sets api-key']);
  assert.deepEqual(suspects({ args: ['--token', 'abc'] }), ['args[1] follows --token']);
  assert.deepEqual(suspects({ args: ['--token', '${env:T}'] }), []);
  assert.deepEqual(suspects({ args: ['run', `ghp_${'a'.repeat(36)}`] }), ['args[1] looks like an access token']);
  assert.deepEqual(suspects({ args: [`x_ghp_${'a'.repeat(36)}`] }), ['args[0] looks like an access token']);
  for (const entry of [{ url: 'https://u:abc@h/x' }, { url: 'https://h/x?token=abc' }, { args: ['--api-key=abc'] }]) {
    assert.ok(!suspects(entry).join('\n').includes('abc'));
  }
  assert.ok(!suspects({ url: 'https://tok@h/x' }).join('\n').includes('tok'));
  assert.ok(!suspects({ args: ['run', TOKEN] }).join('\n').includes(TOKEN));
});

test('textSuspects', () => {
  assert.deepEqual(n.textSuspects('a\nkey: AKIAABCDEFGHIJKLMNOP\n'), [2]);
  assert.deepEqual(n.textSuspects('nothing here'), []);
});

test('contentKey ignores a BOM and CRLF, not content or bytes', (t) => {
  const root = fixture(t);
  const rule = (name, text) => ({ kind: 'rule', src: writeFile(root, `${name}.mdc`, text) });
  assert.equal(n.contentKey(rule('a', 'x\ny\n')), n.contentKey(rule('b', '﻿x\r\ny\r\n')));
  assert.notEqual(n.contentKey(rule('a', 'x\ny\n')), n.contentKey(rule('c', 'x\ny\nz\n')));
  const skill = (name, files) => {
    for (const [rel, data] of Object.entries(files)) {
      const full = path.join(root, name, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, data);
    }
    return { kind: 'skill', src: path.join(root, name) };
  };
  const base = skill('s1', { 'SKILL.md': skillText('s') });
  assert.equal(n.contentKey(base), n.contentKey(skill('s2', { 'SKILL.md': skillText('s') })));
  assert.notEqual(n.contentKey(base), n.contentKey(skill('s3', { 'SKILL.md': skillText('s'), 'notes.md': 'n' })));
  const png1 = skill('p1', { 'SKILL.md': 's', 'logo.png': Buffer.from([0xff, 0x01]) });
  const png2 = skill('p2', { 'SKILL.md': 's', 'logo.png': Buffer.from([0xfe, 0x01]) });
  assert.notEqual(n.contentKey(png1), n.contentKey(png2));
});

test('contentKey leaves the links of a skill out', (t) => {
  const root = fixture(t);
  const plain = path.join(root, 'plain');
  const linked = path.join(root, 'linked');
  for (const dir of [plain, linked]) {
    writeFile(dir, 'SKILL.md', skillText('s'));
  }
  fs.mkdirSync(path.join(root, 'outside'));
  try {
    fs.symlinkSync(path.join(root, 'outside'), path.join(linked, 'scripts'), 'junction');
  } catch (err) {
    return t.skip(`cannot create a link here: ${err.code}`);
  }
  assert.equal(n.contentKey({ kind: 'skill', src: linked }), n.contentKey({ kind: 'skill', src: plain }));
  assert.deepEqual(n.skillLinks(linked), ['scripts']);
  assert.deepEqual(n.skillFiles(linked).map((f) => f.rel), ['SKILL.md']);
  return undefined;
});

test('importName', () => {
  assert.equal(n.importName('style'), 'style');
  assert.equal(n.importName('My_Rule'), 'my-rule');
  assert.equal(n.importName('___'), '');
  assert.equal(n.importName('con'), 'con-item');
});

test('itemReferences finds links, mdc links and mentions of files that exist and stay', (t) => {
  const root = fixture(t);
  const p = path.join(root, 'p');
  writeFile(p, 'src/x.ts', 'x');
  writeFile(
    p,
    '.cursor/rules/a.mdc',
    'See [x](mdc:src/x.ts) and [y](../../src/x.ts#L3), [web](https://e.com), [top](#a), @src/x.ts, mail a@b.com, [gone](mdc:src/none.ts)\n',
  );
  const item = projectItems(p).find((i) => i.name === 'a');
  const refs = n.itemReferences(item, p);
  assert.deepEqual(
    refs.map((r) => [r.why, r.target, r.line]),
    [
      ['link', 'mdc:src/x.ts', 1],
      ['link', '../../src/x.ts#L3', 1],
      ['mention', 'src/x.ts', 1],
    ],
  );
  for (const r of refs) {
    assert.equal(r.resolved, path.join(p, 'src', 'x.ts'));
    assert.equal(r.file, path.join(p, '.cursor', 'rules', 'a.mdc'));
  }
  writeFile(p, '.cursor/skills/s/SKILL.md', skillText('s', '[r](reference.md)'));
  writeFile(p, '.cursor/skills/s/reference.md', 'ref');
  const skill = projectItems(p).find((i) => i.kind === 'skill');
  assert.deepEqual(n.itemReferences(skill, p), []);
  writeFile(p, '.cursor/skills/s/more.md', 'see [x](../../../src/x.ts)');
  assert.deepEqual(
    n.itemReferences(skill, p).map((r) => [r.why, path.basename(r.file), r.target]),
    [['link', 'more.md', '../../../src/x.ts']],
  );
});

test('serverReferences', (t) => {
  const root = fixture(t);
  const p = path.join(root, 'p');
  writeFile(p, 'tools/s.js', 'x');
  const refs = (entry) => n.serverReferences(entry, p).map((r) => [r.where, r.why]);
  assert.deepEqual(refs({ command: 'node', args: ['${workspaceFolder}/tools/s.js'] }), [['args[0]', 'workspaceFolder']]);
  assert.deepEqual(refs({ command: 'node', args: ['./server.js'] }), [['args[0]', 'relative']]);
  assert.deepEqual(refs({ command: 'node', args: ['tools/s.js'] }), [['args[0]', 'relative']]);
  assert.deepEqual(refs({ command: 'node', args: ['tools/none.js'] }), []);
  assert.deepEqual(refs({ command: 'node', args: ['https://x/y'] }), []);
  assert.deepEqual(refs({ command: path.join(p, 'tools', 's.js') }), [['command', 'absolute']]);
  assert.deepEqual(refs({ command: path.join(p, 'tools', 'none.js') }), []);
  assert.deepEqual(refs({ command: 'node', args: [TOKEN] }), []);
  assert.deepEqual(refs({ command: 'node', env: { A: './x' }, cwd: '${workspaceFolder}' }), [
    ['cwd', 'workspaceFolder'],
    ['env.A', 'relative'],
  ]);
});

test('scanSource reads the items and the servers of a project', (t) => {
  const root = fixture(t);
  const files = {
    '.cursor/skills/s1/SKILL.md': skillText('s1'),
    '.cursor/rules/a.md': 'a\n',
    '.cursor/rules/sub/b.mdc': 'b\n',
    '.cursor/commands/run.md': 'run\n',
    '.cursor/agents/helper.md': 'helper\n',
    '.cursor/mcp.json': `{\n  // servers\n  "mcpServers": {\n    "lint": { "command": "node" },\n    "gh": { "command": "npx", "env": { "GITHUB_TOKEN": "${TOKEN}" } },\n  },\n}\n`,
  };
  const source = project(root, 'proj', files);
  const found = n.scanSource(source);
  assert.deepEqual(found.errors, []);
  assert.equal(found.items.length, 5);
  assert.equal(found.servers.length, 2);
  const gh = found.servers.find((s) => s.name === 'gh');
  assert.equal(gh.entry.env.GITHUB_TOKEN, '${env:GITHUB_TOKEN}');
  assert.ok(!JSON.stringify(found.servers.map(({ source: _s, ...rest }) => rest)).includes(TOKEN));
  assert.equal(found.items.find((i) => i.name === 'b').where, 'proj/.cursor/rules/sub/b.mdc');
  assert.equal(found.items.find((i) => i.kind === 'skill').where, 'proj/.cursor/skills/s1');
  const personal = n.scanSource({ ...source, personal: true, label: '~/.cursor' });
  assert.equal(personal.items.length, 3);
  assert.ok(personal.items.every((i) => i.kind !== 'rule'));
  assert.equal(personal.servers[0].where, '~/.cursor/mcp.json');
});

test('scanSource reports an mcp.json it cannot use, without a parser message', (t) => {
  const root = fixture(t);
  const scan = (text) => n.scanSource(project(root, `p${Math.random()}`, { '.cursor/mcp.json': text }));
  assert.deepEqual(scan('[1]').errors.map((e) => e.message), ['not a JSON object']);
  let r = scan('{ "mcpServers": { "x": 1, "ok": { "command": "a" } } }');
  assert.deepEqual(r.errors.map((e) => e.message), ['the server x is not an object']);
  assert.deepEqual(r.servers.map((s) => s.name), ['ok']);
  r = scan('{ "x": 1 }');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.servers, []);
  r = scan('{ "mcpServers": { "../e": { "command": "a" } } }');
  assert.deepEqual(r.errors.map((e) => e.message), ["the server name ../e can't be used in a plugin"]);
  r = scan(`{ "a": ${TOKEN}`);
  assert.deepEqual(r.errors.map((e) => e.message), ['not valid JSONC']);
  assert.ok(!JSON.stringify(r.errors).includes('ghp_'));
});

function twoProjects(root) {
  const api = project(root, 'api', {
    '.cursor/skills/code-review/SKILL.md': skillText('code-review'),
    '.cursor/rules/db.mdc': 'one\ntwo\n',
    '.cursor/rules/ref.mdc': 'See [x](mdc:src/x.ts)\n',
    '.cursor/rules/style.mdc': 'Style\n',
    'src/x.ts': 'x',
    '.cursor/mcp.json': JSON.stringify({
      mcpServers: { lint: { command: 'node', args: ['lint.js'] }, gh: { command: 'npx', env: { GITHUB_TOKEN: TOKEN } } },
    }),
  });
  const web = project(root, 'web', {
    '.cursor/skills/code-review/SKILL.md': skillText('code-review').replace(/\n/g, '\r\n'),
    '.cursor/rules/db.mdc': 'one\ntwo\nthree\n',
    '.cursor/mcp.json': JSON.stringify({
      mcpServers: {
        lint: { command: 'node', args: ['lint.js'] },
        gh: { command: 'npx', env: { GITHUB_TOKEN: `ghp_${'b'.repeat(36)}` } },
      },
    }),
  });
  return { api, web };
}

test('scan groups the copies by kind and name', (t) => {
  const root = fixture(t);
  const { api, web } = twoProjects(root);
  writeFile(api.root, '.cursor/commands/go.md', 'go\n');
  writeFile(api.root, '.cursor/agents/helper.md', 'helper\n');
  const { groups, errors } = n.scan([api, web]);
  assert.deepEqual(errors, []);
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));
  assert.equal(byId['skill:code-review'].status, 'identical');
  assert.equal(byId['skill:code-review'].copies.length, 2);
  assert.equal(byId['skill:code-review'].versions.length, 1);
  assert.equal(byId['rule:db'].status, 'variants');
  assert.deepEqual(
    byId['rule:db'].versions.map((v) => v[0].source.label),
    ['api', 'web'],
  );
  assert.equal(byId['rule:style'].status, 'single');
  assert.equal(byId['mcp:lint'].status, 'identical');
  assert.equal(byId['mcp:gh'].status, 'identical');
  assert.deepEqual(
    groups.map((g) => g.kind),
    ['skill', 'rule', 'rule', 'rule', 'command', 'agent', 'mcp', 'mcp'],
  );
  assert.deepEqual(byId['mcp:gh'].replaced.map((r) => [r.where, r.field, r.variable]), [
    ['api/.cursor/mcp.json', 'env.GITHUB_TOKEN', 'GITHUB_TOKEN'],
    ['web/.cursor/mcp.json', 'env.GITHUB_TOKEN', 'GITHUB_TOKEN'],
  ]);
});

test('scan puts Style.mdc and style.md in one group and says it was renamed', (t) => {
  const root = fixture(t);
  const api = project(root, 'api', { '.cursor/rules/style.md': 'a\n' });
  const web = project(root, 'web', { '.cursor/rules/Style.mdc': 'b\n' });
  const { groups } = n.scan([api, web]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, 'rule:style');
  assert.deepEqual(groups[0].renamed.map((c) => c.originalName), ['Style']);
});

test('previewMarkdown', (t) => {
  const root = fixture(t);
  const { api, web } = twoProjects(root);
  const broken = project(root, 'broken', { '.cursor/mcp.json': '{ nope' });
  const sources = [api, web, broken];
  const { groups, errors } = n.scan(sources);
  const mcp = (p) => `${p}/.cursor/mcp.json`;
  const expected = [
    '# New team repository: preview',
    '',
    'Scanned: api, web, broken. Nothing is written until you confirm at the end.',
    '',
    '## Ready to import (5)',
    '',
    '- skill `code-review`: identical in api/.cursor/skills/code-review, web/.cursor/skills/code-review (2 copies, imported once)',
    '- rule `ref`: api/.cursor/rules/ref.mdc',
    '- rule `style`: api/.cursor/rules/style.mdc',
    `- MCP server \`lint\`: identical in ${mcp('api')}, ${mcp('web')} (2 copies, imported once)`,
    `- MCP server \`gh\`: identical in ${mcp('api')}, ${mcp('web')} (2 copies, imported once)`,
    '',
    '## Variants that need a decision (1)',
    '',
    '- rule `db`: 2 versions: api/.cursor/rules/db.mdc (2 lines), web/.cursor/rules/db.mdc (3 lines)',
    '',
    '## Secrets replaced (2)',
    '',
    `- MCP server \`gh\` (${mcp('api')}): env.GITHUB_TOKEN now reads the environment variable GITHUB_TOKEN.`,
    `- MCP server \`gh\` (${mcp('web')}): env.GITHUB_TOKEN now reads the environment variable GITHUB_TOKEN.`,
    '',
    '## References that may break (1)',
    '',
    '- rule `ref` (api/.cursor/rules/ref.mdc:1): links to mdc:src/x.ts, which stays where it is.',
    '',
    '## Not read (1)',
    '',
    `- ${path.join(broken.root, '.cursor', 'mcp.json')}: not valid JSONC`,
    '',
  ].join('\n');
  const text = n.previewMarkdown({ sources, groups, errors });
  assert.equal(text, expected);
  assert.ok(!text.includes('ghp_'));
});

test('previewMarkdown names the suspects, the renamed items and the paths of a server', (t) => {
  const root = fixture(t);
  const api = project(root, 'api', {
    '.cursor/rules/Style.mdc': `key ${TOKEN}\n`,
    'tools/s.js': 'x',
    '.cursor/mcp.json': JSON.stringify({
      mcpServers: {
        a: { command: 'node', args: ['${workspaceFolder}/s.js', './r.js', path.join(root, 'api', 'tools', 's.js')] },
      },
    }),
  });
  const { groups, errors } = n.scan([api]);
  const text = n.previewMarkdown({ sources: [api], groups, errors });
  assert.ok(text.includes('## May contain a secret (1)\n\nUnticked in the next step: tick them only if you checked them.\n\n'));
  assert.ok(text.includes('- rule `style` (api/.cursor/rules/Style.mdc): Style.mdc line 1 looks like an access token\n'));
  assert.ok(text.includes('## Renamed for Cursor (1)\n\nCursor accepts lowercase letters, digits, hyphens and dots.\n\n'));
  assert.ok(text.includes('- rule `Style` (api/.cursor/rules/Style.mdc) becomes `style`.\n'));
  assert.ok(text.includes('args[0] uses ${workspaceFolder}: every project needs that file.'));
  assert.ok(text.includes('args[1] is the relative path ./r.js: in a plugin, write ${CURSOR_PLUGIN_ROOT}/r.js for a file the plugin holds.'));
  assert.ok(text.includes(`args[2] is the absolute path ${path.join(root, 'api', 'tools', 's.js')}, a path on this machine only.`));
  assert.ok(!text.includes(TOKEN));
  assert.ok(text.endsWith('.\n') && !text.endsWith('\n\n'));
});

test('splitNames names each version after its source', (t) => {
  const root = fixture(t);
  const api = project(root, 'api', { '.cursor/rules/backend/db.mdc': 'a\n' });
  const web = project(root, 'web', { '.cursor/rules/db.mdc': 'b\n' });
  const { groups } = n.scan([api, web]);
  assert.deepEqual(n.splitNames(groups[0]), ['db-api-backend', 'db-web']);
  assert.deepEqual(n.splitNames(groups[0], new Set(['db-web'])), ['db-api-backend', 'db-web-2']);
});

test('splitNames keeps names valid, short and free of reserved words', (t) => {
  const root = fixture(t);
  const long = 'a'.repeat(64);
  const personal = project(root, 'home', { [`.cursor/commands/${long}.md`]: 'a\n' }, true);
  const web = project(root, 'web', { [`.cursor/commands/${long}.md`]: 'b\n' });
  const { groups } = n.scan([personal, web]);
  const names = n.splitNames(groups[0]);
  assert.equal(new Set(names).size, 2);
  for (const name of names) {
    assert.ok(name.length <= 64, name);
    assert.equal(nameError(name), '', name);
  }
  const con = project(root, 'con', { '.cursor/commands/co.md': 'a\n' });
  const other = project(root, 'x', { '.cursor/commands/co.md': 'b\n' });
  for (const name of n.splitNames(n.scan([con, other]).groups[0])) {
    assert.ok(!n.reservedName(name), name);
  }
  assert.equal(n.splitNames({ kind: 'rule', name: 'a', versions: [[{ source: { label: '___' }, kind: 'rule' }]] }).length, 1);
});

test('skillDiff lists the files that differ or exist on one side', (t) => {
  const root = fixture(t);
  writeFile(root, 'a/SKILL.md', 's');
  writeFile(root, 'a/same.md', 'x\r\n');
  writeFile(root, 'a/only-a.md', '1');
  writeFile(root, 'b/SKILL.md', 's2');
  writeFile(root, 'b/same.md', 'x\n');
  writeFile(root, 'b/only-b.md', '2');
  assert.deepEqual(n.skillDiff(path.join(root, 'a'), path.join(root, 'b')), ['SKILL.md', 'only-a.md', 'only-b.md']);
});

test('preparing a skill merge reports a file and directory at the same path', (t) => {
  const root = fixture(t);
  const fileVersion = path.join(root, 'file-version');
  const directoryVersion = path.join(root, 'directory-version');
  const script = writeFile(fileVersion, 'scripts', 'standalone script');
  const check = writeFile(directoryVersion, 'scripts/check.py', 'nested script');

  assert.deepEqual(n.prepareSkillMergeFile(fileVersion, 'scripts/check.py'), { conflict: 'scripts' });
  assert.deepEqual(n.prepareSkillMergeFile(directoryVersion, 'scripts'), { conflict: 'scripts' });
  assert.equal(fs.readFileSync(script, 'utf8'), 'standalone script');
  assert.equal(fs.readFileSync(check, 'utf8'), 'nested script');
  const placeholder = n.prepareSkillMergeFile(fileVersion, 'docs/notes.md');
  assert.equal(placeholder.created, true);
  assert.equal(fs.readFileSync(placeholder.file, 'utf8'), '');
});

function builtRepository(root) {
  const api = project(root, 'api', {
    '.cursor/skills/code-review/SKILL.md': skillText('code-review'),
    '.cursor/skills/code-review/notes.md': 'notes\n',
    '.cursor/rules/db.mdc': '---\ndescription: db\n---\nrule\n',
    '.cursor/agents/helper.md': '---\nname: helper\ndescription: Helps.\n---\nHelp.\n',
    '.cursor/agents/plain.md': '---\ndescription: Plain agent.\n---\nPlain.\n',
  });
  const items = projectItems(api.root);
  const find = (name) => items.find((i) => i.name === name);
  const entry = (item, name) => ({ kind: item.kind, name, originalName: item.name, ext: item.ext, src: item.src });
  const redacted = n.redactServer('gh', { command: 'npx', env: { GITHUB_TOKEN: TOKEN } }).entry;
  return {
    api,
    options: {
      marketplaceName: 'new-team',
      pluginName: 'team',
      items: [
        entry(find('code-review'), 'code-review'),
        entry(find('db'), 'db-api'),
        entry(find('helper'), 'helper-web'),
        entry({ ...find('plain') }, 'plain'),
      ],
      servers: [
        { name: 'lint', entry: { command: 'node' } },
        { name: 'gh', entry: redacted },
      ],
    },
  };
}

test('buildRepository writes the marketplace, the plugin and its items', (t) => {
  const root = fixture(t);
  const { options } = builtRepository(root);
  const repo = path.join(root, 'repo');
  const built = n.buildRepository(repo, options);
  assert.deepEqual(built.errors, []);
  assert.deepEqual(built.skipped, []);
  assert.deepEqual(built.files, [
    '.cursor-plugin/marketplace.json',
    'team/.cursor-plugin/plugin.json',
    'team/agents/helper-web.md',
    'team/agents/plain.md',
    'team/mcp.json',
    'team/rules/db-api.mdc',
    'team/skills/code-review/SKILL.md',
    'team/skills/code-review/notes.md',
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.cursor-plugin', 'marketplace.json'), 'utf8')), {
    name: 'new-team',
    plugins: [{ name: 'team', source: './team' }],
  });
  const agent = fs.readFileSync(path.join(repo, 'team', 'agents', 'helper-web.md'), 'utf8');
  assert.ok(agent.startsWith('---\nname: helper-web\n'), agent);
  assert.equal(
    fs.readFileSync(path.join(repo, 'team', 'agents', 'plain.md'), 'utf8'),
    '---\ndescription: Plain agent.\n---\nPlain.\n',
  );
  const mcp = fs.readFileSync(path.join(repo, 'team', 'mcp.json'), 'utf8');
  assert.ok(mcp.includes('${env:GITHUB_TOKEN}'));
  assert.ok(!mcp.includes('ghp_'));
  assert.deepEqual(Object.keys(JSON.parse(mcp).mcpServers), ['lint', 'gh']);
});

test('buildRepository reports the links it left out and the items it could not copy', (t) => {
  const root = fixture(t);
  const { options } = builtRepository(root);
  const skill = options.items[0];
  fs.mkdirSync(path.join(root, 'outside'));
  try {
    fs.symlinkSync(path.join(root, 'outside'), path.join(skill.src, 'scripts'), 'junction');
  } catch (err) {
    return t.skip(`cannot create a link here: ${err.code}`);
  }
  const bad = { ...options.items[1], name: 'Bad Name' };
  const built = n.buildRepository(path.join(root, 'repo'), { ...options, items: [skill, bad] });
  assert.deepEqual(built.skipped, ['code-review/scripts']);
  assert.equal(built.errors.length, 1);
  assert.equal(built.errors[0].name, 'Bad Name');
  return undefined;
});

test('the built repository is a catalog Cursor reads without problems', (t) => {
  const root = fixture(t);
  const { options } = builtRepository(root);
  const repo = path.join(root, 'repo');
  n.buildRepository(repo, options);
  const catalog = readCatalog(repo);
  assert.equal(catalog.name, 'new-team');
  assert.deepEqual(catalog.problems, []);
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0].name, 'team');
  assert.deepEqual(
    catalog.plugins[0].children.map((c) => `${c.kind}:${c.name}`).sort(),
    ['agent:helper-web', 'agent:plain', 'mcp:gh', 'mcp:lint', 'rule:db-api', 'skill:code-review'],
  );
});

test('stillSame notices an original that changed, went or was edited', (t) => {
  const root = fixture(t);
  const p = project(root, 'p', {
    '.cursor/rules/a.mdc': 'a\n',
    '.cursor/rules/gone.mdc': 'g\n',
    '.cursor/skills/s/SKILL.md': skillText('s'),
    '.cursor/mcp.json': JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: TOKEN } }, b: { command: 'b' } } }),
  });
  const { groups } = n.scan([p]);
  const copy = (id) => groups.find((g) => g.id === id).copies[0];
  for (const c of groups.flatMap((g) => g.copies)) {
    assert.equal(n.stillSame(c), true, c.where);
  }
  fs.writeFileSync(path.join(p.root, '.cursor/rules/a.mdc'), 'edited\n');
  assert.equal(n.stillSame(copy('rule:a')), false);
  fs.unlinkSync(path.join(p.root, '.cursor/rules/gone.mdc'));
  assert.equal(n.stillSame(copy('rule:gone')), false);
  writeFile(p.root, '.cursor/skills/s/new.md', 'n');
  assert.equal(n.stillSame(copy('skill:s')), false);
  const text = fs.readFileSync(path.join(p.root, '.cursor/mcp.json'), 'utf8');
  fs.writeFileSync(path.join(p.root, '.cursor/mcp.json'), text.replace(TOKEN, `ghp_${'z'.repeat(36)}`));
  assert.equal(n.stillSame(copy('mcp:gh')), false);
  assert.equal(n.stillSame(copy('mcp:b')), true);
  fs.writeFileSync(path.join(p.root, '.cursor/mcp.json'), '{ "mcpServers": { "other": { "command": "x" } } }');
  assert.equal(n.stillSame(copy('mcp:b')), false);
});

test('stillSame rejects a skill with a link added after preview', (t) => {
  const root = fixture(t);
  const p = project(root, 'p', { '.cursor/skills/s/SKILL.md': skillText('s') });
  const copy = n.scan([p]).groups[0].copies[0];
  assert.equal(n.stillSame(copy), true);

  const link = path.join(copy.src, 'scripts');
  fs.mkdirSync(link);
  // Simulate the link's lstat on hosts where creating symlinks or junctions needs extra privileges.
  const lstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) =>
    file === link ? { isSymbolicLink: () => true } : lstatSync(file, ...args),
  );
  assert.deepEqual(n.skillLinks(copy.src), ['scripts']);
  assert.equal(n.stillSame(copy), false);
});

test('checkReplacementPlugin rejects local edits to the plugin before removing originals', async (t) => {
  const dir = fixture(t);
  git(['init', '-q'], dir);
  const rule = writeFile(dir, 'team/rules/style.mdc', 'published\n');
  const readme = writeFile(dir, 'README.md', 'published\n');
  const head = commitAll(dir, 'Publish team plugin');
  const check = () => n.checkReplacementPlugin({ run: makeGit(), dir, folder: 'team', head });

  assert.equal((await check()).code, 0);
  fs.writeFileSync(readme, 'unrelated local edit\n');
  assert.equal((await check()).code, 0);
  fs.writeFileSync(rule, 'local plugin edit\n');
  assert.equal((await check()).code, 1);
  git(['add', 'team/rules/style.mdc'], dir);
  assert.equal((await check()).code, 1);
});

test('urlError and destination', (t) => {
  assert.equal(n.urlError(''), 'Enter a Git URL');
  assert.equal(n.urlError('-x'), "A Git URL can't start with -");
  const creds = 'Leave the user name and password out of the URL: git gets them from your credential manager.';
  assert.equal(n.urlError('https://u:p@h/x.git'), creds);
  assert.equal(n.urlError('https://tok@h/x.git'), creds);
  assert.equal(n.urlError('https://h/x.git?token=a'), 'A Git URL with ? or # is not supported here.');
  assert.equal(n.urlError('relative/path'), 'Give the absolute path of a local repository.');
  for (const ok of ['https://h/o/x.git', 'git@h:o/x.git', 'ssh://git@h/o/x.git', path.resolve('x')]) {
    assert.equal(n.urlError(ok), '', ok);
  }
  const dir = fixture(t);
  assert.equal(n.destination(`${dir}${path.sep}`), path.resolve(dir));
  assert.equal(n.destination(' https://h/o/x.git '), 'https://h/o/x.git');
  assert.equal(n.destination('git@h:o/x.git'), 'git@h:o/x.git');
});

const OPTS = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
function makeRun() {
  const run = makeGit('git');
  return (args, cwd, timeoutMs, opts) => run([...OPTS, ...args], cwd, timeoutMs, opts);
}

function bare(root, name, branch = 'trunk') {
  const dir = path.join(root, name);
  git(['init', '--bare', '-q', '-b', branch, dir]);
  return dir;
}

test('checkEmptyRemote', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = fixture(t);
  const run = makeRun();
  const empty = bare(root, 'empty.git');
  assert.deepEqual(await n.checkEmptyRemote({ run, cwd: root, url: empty, idleMs: 0 }), { kind: 'empty' });
  const full = bare(root, 'full.git');
  const work = path.join(root, 'work');
  writeFile(work, 'a.txt', 'a');
  git(['init', '-q', '-b', 'main'], work);
  git(['add', '-A'], work);
  git([...OPTS, 'commit', '-q', '-m', 'x'], work);
  git(['push', '-q', full, 'main'], work);
  const notEmpty = await n.checkEmptyRemote({ run, cwd: root, url: full, idleMs: 0 });
  assert.equal(notEmpty.reason, 'notEmpty');
  assert.equal(notEmpty.kind, 'error');
  const missing = path.join(root, 'missing.git');
  const gone = await n.checkEmptyRemote({ run, cwd: root, url: missing, idleMs: 0 });
  assert.notEqual(gone.kind, 'empty');
  assert.ok(gone.message.includes('missing.git'), gone.message);
  return undefined;
});

test('initAndCommit and pushNew create the branch the entry names', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = fixture(t);
  const run = makeRun();
  const { options } = builtRepository(root);
  const repo = path.join(root, 'repo');
  const built = n.buildRepository(repo, options);
  const trunk = bare(root, 'trunk.git', 'trunk');
  const committed = await n.initAndCommit({ run, dir: repo, branch: 'main', files: built.files });
  assert.match(committed.head, /^[0-9a-f]{40}$/);
  assert.deepEqual(await n.pushNew({ run, dir: repo, url: trunk, branch: 'main' }), { kind: 'pushed' });
  assert.equal(git(['rev-parse', 'refs/heads/main'], trunk), committed.head);
  const check = await checkRemote({ run, cwd: root, repoUrl: trunk });
  assert.equal(check.defaultBranch, '');
  assert.deepEqual(n.repositoryEntry(trunk, 'main', check), { url: trunk, branch: 'main' });
  // a server whose HEAD is the pushed branch needs no branch in the entry
  const main = bare(root, 'main.git', 'main');
  assert.deepEqual(await n.pushNew({ run, dir: repo, url: main, branch: 'main' }), { kind: 'pushed' });
  const check2 = await checkRemote({ run, cwd: root, repoUrl: main });
  assert.deepEqual(n.repositoryEntry(main, 'main', check2), { url: main });
  return undefined;
});

test('initAndCommit refuses a commit that left a file out', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = fixture(t);
  const src = project(root, 'p', {
    '.cursor/skills/s/SKILL.md': skillText('s'),
    '.cursor/skills/s/.gitignore': 'notes.md\n',
    '.cursor/skills/s/notes.md': 'n\n',
  });
  const item = projectItems(src.root)[0];
  const repo = path.join(root, 'repo');
  const built = n.buildRepository(repo, {
    marketplaceName: 'm',
    pluginName: 'team',
    items: [{ kind: 'skill', name: 's', originalName: 's', ext: '', src: item.src }],
    servers: [],
  });
  const result = await n.initAndCommit({ run: makeRun(), dir: repo, branch: 'main', files: built.files });
  assert.equal(result.kind, 'error');
  assert.match(result.message, /git left out team\/skills\/s\/notes\.md \(a \.gitignore in a copied skill\?\)/);
  assert.match(result.message, /nothing was pushed\.$/);
  return undefined;
});

test('remoteBranchState', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = fixture(t);
  const run = makeRun();
  const { options } = builtRepository(root);
  const repo = path.join(root, 'repo');
  const built = n.buildRepository(repo, options);
  const remote = bare(root, 'r.git');
  const state = (head) => n.remoteBranchState({ run, cwd: root, url: remote, branch: 'main', head });
  assert.equal(await state('0'.repeat(40)), 'absent');
  const { head } = await n.initAndCommit({ run, dir: repo, branch: 'main', files: built.files });
  await n.pushNew({ run, dir: repo, url: remote, branch: 'main' });
  assert.equal(await state(head), 'pushed');
  assert.equal(await state('1'.repeat(40)), 'other');
  const gone = await n.remoteBranchState({ run, cwd: root, url: path.join(root, 'none.git'), branch: 'main', head });
  assert.equal(typeof gone, 'object');
  assert.notEqual(gone.kind, undefined);
  return undefined;
});

test('gitReady needs a git identity', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = fixture(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const emptyConfig = writeFile(root, 'empty.gitconfig', '');
  const names = [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
  ];
  const saved = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  t.after(() => {
    for (const k of names) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
  });
  for (const k of names.filter((k) => k.startsWith('GIT_AUTHOR') || k.startsWith('GIT_COMMITTER'))) {
    delete process.env[k];
  }
  const plain = makeGit('git');
  // no guessing of an identity from the machine, as on a computer where git was never set up
  const run = (args, cwd, timeoutMs, opts) => plain(['-c', 'user.useConfigOnly=true', ...args], cwd, timeoutMs, opts);
  assert.deepEqual(await n.gitReady({ run, cwd: root }), { ok: false, message: IDENTITY_MESSAGE });
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'T',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T',
    GIT_COMMITTER_EMAIL: 't@example.com',
  });
  assert.deepEqual(await n.gitReady({ run, cwd: root }), { ok: true });
  const missing = makeGit(path.join(root, 'no-such-git'));
  const r = await n.gitReady({ run: missing, cwd: root });
  assert.equal(r.ok, false);
  assert.match(r.message, /git was not found|cannot run git/);
  return undefined;
});

test('defaultBranch', async () => {
  const stub = (config, check) => async (args) =>
    args[0] === 'config' ? config : args[0] === 'check-ref-format' ? check : { code: 1, stdout: '', stderr: '' };
  const ok = { code: 0, stdout: 'trunk\n', stderr: '' };
  const fine = { code: 0, stdout: '', stderr: '' };
  const fail = { code: 1, stdout: '', stderr: '' };
  assert.equal(await n.defaultBranch({ run: stub(ok, fine), cwd: '.' }), 'trunk');
  assert.equal(await n.defaultBranch({ run: stub(fail, fine), cwd: '.' }), 'main');
  assert.equal(await n.defaultBranch({ run: stub(ok, fail), cwd: '.' }), 'main');
});

function originalsFixture(root) {
  const personal = project(root, 'home', { '.cursor/skills/code-review/SKILL.md': skillText('code-review') }, true);
  const api = project(root, 'api', {
    '.cursor/skills/code-review/SKILL.md': skillText('code-review'),
    '.cursor/rules/db.mdc': 'A\n',
    '.cursor/rules/merged.mdc': 'A\n',
    '.cursor/rules/split.mdc': 'A\n',
    '.cursor/rules/style.mdc': 'S\n',
    '.cursor/commands/cmd.md': 'c\n',
    '.cursor/skills/linked/SKILL.md': skillText('linked'),
    '.cursor/mcp.json': JSON.stringify({ mcpServers: { gh: { command: 'npx', env: { GITHUB_TOKEN: TOKEN } } } }),
  });
  const web = project(root, 'web', {
    '.cursor/rules/db.mdc': 'B\n',
    '.cursor/rules/merged.mdc': 'B\n',
    '.cursor/rules/split.mdc': 'B\n',
  });
  return { sources: [personal, api, web], api };
}

test('originalsOf says which originals the repository fully represents', async (t) => {
  const root = fixture(t);
  const { sources, api } = originalsFixture(root);
  fs.mkdirSync(path.join(root, 'outside'));
  let linked = true;
  try {
    fs.symlinkSync(path.join(root, 'outside'), path.join(api.root, '.cursor/skills/linked/scripts'), 'junction');
  } catch {
    linked = false;
  }
  const { groups } = n.scan(sources);
  const choices = new Map([
    ['skill:code-review', { kind: 'use', version: 0 }],
    ['rule:db', { kind: 'use', version: 0 }],
    ['rule:merged', { kind: 'merged', src: path.join(root, 'merge.mdc'), ext: '.mdc' }],
    ['rule:split', { kind: 'split', names: ['split-api', 'split-web'] }],
    ['command:cmd', { kind: 'use', version: 0 }],
    ['skill:linked', { kind: 'use', version: 0 }],
    ['mcp:gh', { kind: 'use', version: 0 }],
  ]);
  const list = n.originalsOf(groups, choices, { dropped: new Set(['command:cmd']) });
  const row = (where) => list.find((o) => o.where === where);
  assert.equal(list.some((o) => o.name === 'style'), false);
  assert.deepEqual(
    list.slice(0, 1).map((o) => [o.personal, o.where]),
    [[true, '~/.cursor/skills/code-review']],
  );
  assert.equal(list.filter((o) => o.personal).length, 1);
  assert.equal(row('~/.cursor/skills/code-review').picked, true);
  assert.equal(row('api/.cursor/skills/code-review').picked, true);
  assert.equal(row('api/.cursor/rules/db.mdc').picked, true);
  assert.equal(row('web/.cursor/rules/db.mdc').picked, false);
  assert.equal(row('web/.cursor/rules/db.mdc').reason, 'another version was imported');
  for (const where of ['api/.cursor/rules/merged.mdc', 'web/.cursor/rules/merged.mdc']) {
    assert.equal(row(where).picked, false);
    assert.equal(row(where).reason, 'merged by hand: check that your merge covers it');
  }
  assert.equal(row('api/.cursor/rules/split.mdc').picked, true);
  assert.equal(row('web/.cursor/rules/split.mdc').picked, true);
  assert.equal(row('api/.cursor/rules/split.mdc').name, 'split-api');
  assert.equal(row('web/.cursor/rules/split.mdc').name, 'split-web');
  const gh = row('api/.cursor/mcp.json');
  assert.equal(gh.picked, false);
  assert.equal(gh.reason, 'holds your GITHUB_TOKEN value: set the environment variable first');
  assert.equal(gh.serverName, 'gh');
  assert.equal(row('api/.cursor/commands/cmd.md').picked, false);
  assert.equal(row('api/.cursor/commands/cmd.md').reason, 'Cursor would drop the imported copy');
  assert.ok(list.every((o) => o.source && o.copy));
  await t.test('a skill holding a link starts unticked', (st) => {
    if (!linked) {
      st.skip('this machine could not create a junction');
      return;
    }
    assert.equal(row('api/.cursor/skills/linked').picked, false);
    assert.equal(row('api/.cursor/skills/linked').reason, 'its links were not copied');
  });
});

test('planImport turns the choices into what buildRepository takes', (t) => {
  const root = fixture(t);
  const { sources } = originalsFixture(root);
  const { groups } = n.scan(sources);
  const choices = new Map([
    ['skill:code-review', { kind: 'use', version: 0 }],
    ['rule:db', { kind: 'use', version: 1 }],
    ['rule:split', { kind: 'split', names: ['split-api', 'split-web'] }],
    ['rule:style', { kind: 'out' }],
    ['mcp:gh', { kind: 'use', version: 0 }],
  ]);
  const plan = n.planImport(groups, choices);
  assert.deepEqual(
    plan.items.map((i) => [i.kind, i.name, i.originalName]),
    [
      ['skill', 'code-review', 'code-review'],
      ['rule', 'db', 'db'],
      ['rule', 'split-api', 'split'],
      ['rule', 'split-web', 'split'],
    ],
  );
  assert.equal(plan.items[1].src, path.join(root, 'web', '.cursor', 'rules', 'db.mdc'));
  assert.deepEqual(plan.servers.map((s) => s.name), ['gh']);
  assert.equal(plan.servers[0].entry.env.GITHUB_TOKEN, '${env:GITHUB_TOKEN}');
});

test('removeServers', () => {
  const nested = '{\n  "mcpServers": {\n    "a": { "command": "x" },\n    "b": { "command": "y" }\n  }\n}\n';
  assert.deepEqual(n.removeServers(nested, ['b']), {
    text: '{\n  "mcpServers": {\n    "a": { "command": "x" }\n  }\n}\n',
  });
  const top = '{\n  "a": { "command": "x" },\n  "b": { "url": "u" }\n}\n';
  assert.deepEqual(n.removeServers(top, ['a']), { text: '{\n  "b": { "url": "u" }\n}\n' });
  assert.deepEqual(n.removeServers('{ "mcpServers": { "a": { "command": "x" } }, "b": { "command": "x" } }', ['a']), {
    error: 'removing them would change other servers',
  });
  assert.deepEqual(n.removeServers('{ "mcpServers": ', ['a']), { error: 'not valid JSONC' });
  assert.deepEqual(n.removeServers('[1]', ['a']), { error: 'not a JSON object' });
});

// ---- after the Codex review of the implementation ----------------------------------------------------------------

test('redactServer: a default inside a reference counts as a literal', () => {
  const r = n.redactServer('s', { env: { MY_TOKEN: '${MY_TOKEN:-SYNTHETIC_LITERAL}', OTHER_TOKEN: '${env:X}' } });
  assert.equal(r.entry.env.MY_TOKEN, '${env:MY_TOKEN}');
  assert.equal(r.entry.env.OTHER_TOKEN, '${env:X}');
  assert.ok(!JSON.stringify(r).includes('SYNTHETIC_LITERAL'));
});

test('a flagged argument is never shown as a reference, in the scan or the preview', (t) => {
  const root = fixture(t);
  const src = project(root, 'api', {
    '.cursor/mcp.json': JSON.stringify({ mcpServers: { s: { command: 'node', args: ['--token', './SYNTHETIC_SECRET'] } } }),
    'SYNTHETIC_SECRET': 'x',
  });
  const r = n.redactServer('s', { command: 'node', args: ['--token', './SYNTHETIC_SECRET'] });
  assert.deepEqual(r.hidden, ['args[1]']);
  assert.deepEqual(n.serverReferences(r.entry, src.root, r.hidden), []);
  const { groups, errors } = n.scan([src]);
  assert.equal(groups[0].references.length, 0);
  const text = n.previewMarkdown({ sources: [src], groups, errors });
  assert.ok(!text.includes('SYNTHETIC_SECRET'), text);
  assert.ok(text.includes('args[1] follows --token'), text);
});

test('itemSuspects scans every text file of a skill and flags its .env file', (t) => {
  const root = fixture(t);
  const src = project(root, 'api', {
    '.cursor/skills/s1/SKILL.md': skillText('s1'),
    '.cursor/skills/s1/config.json': `{ "key": "${TOKEN}" }\n`,
    '.cursor/skills/s2/SKILL.md': skillText('s2'),
    '.cursor/skills/s2/.env': 'A=1\n',
  });
  assert.deepEqual(n.itemSuspects({ kind: 'skill', src: path.join(src.root, '.cursor', 'skills', 's1') }), [
    'config.json line 1 looks like an access token',
  ]);
  assert.deepEqual(n.itemSuspects({ kind: 'skill', src: path.join(src.root, '.cursor', 'skills', 's2') }), [
    '.env is an environment file',
  ]);
  const { groups } = n.scan([src]);
  assert.ok(groups.every((g) => g.suspects.length > 0), JSON.stringify(groups.map((g) => g.suspects)));
});

test('a split MCP server reads one variable per name', (t) => {
  const root = fixture(t);
  const entry = (arg) => JSON.stringify({ mcpServers: { gh: { command: 'npx', args: [arg], env: { GITHUB_TOKEN: 'abc' } } } });
  const sources = [
    project(root, 'work', { '.cursor/mcp.json': entry('work') }),
    project(root, 'home', { '.cursor/mcp.json': entry('home') }),
  ];
  const { groups } = n.scan(sources);
  assert.equal(groups[0].status, 'variants');
  const choices = new Map([['mcp:gh', { kind: 'split', names: ['gh-work', 'gh-home'] }]]);
  const plan = n.planImport(groups, choices);
  assert.deepEqual(
    plan.servers.map((s) => s.entry.env.GITHUB_TOKEN),
    ['${env:GH_WORK_GITHUB_TOKEN}', '${env:GH_HOME_GITHUB_TOKEN}'],
  );
  assert.deepEqual(plan.imported.map((e) => e.variables), [['GH_WORK_GITHUB_TOKEN'], ['GH_HOME_GITHUB_TOKEN']]);
  const originals = n.originalsOf(groups, choices);
  assert.deepEqual(
    originals.map((o) => o.reason),
    [
      'holds your GH_WORK_GITHUB_TOKEN value: set the environment variable first',
      'holds your GH_HOME_GITHUB_TOKEN value: set the environment variable first',
    ],
  );
  assert.equal(n.splitVariable('gh-work', 'GITHUB_TOKEN'), 'GH_WORK_GITHUB_TOKEN');
});

test('serverKeyIn fingerprints one server of an mcp.json text', () => {
  const text = JSON.stringify({ mcpServers: { a: { command: 'x' }, b: { command: 'y' } } });
  const key = n.serverKeyIn(text, 'a');
  assert.match(key, /^[0-9a-f]{40}$/);
  assert.equal(n.serverKeyIn(JSON.stringify({ mcpServers: { a: { command: 'x' } } }), 'a'), key);
  assert.notEqual(n.serverKeyIn(JSON.stringify({ mcpServers: { a: { command: 'z' } } }), 'a'), key);
  assert.equal(n.serverKeyIn(text, 'c'), '');
  assert.equal(n.serverKeyIn('{ not json', 'a'), '');
});

test('urlError refuses a password in any URL, an SSH user name alone is fine', () => {
  const msg = 'Leave the password out of the URL: git gets it from your SSH agent or credential manager.';
  assert.equal(n.urlError('ssh://git:SYNTHETIC_SECRET@host/repo.git'), msg);
  assert.equal(n.urlError('git+ssh://u:p@host/repo.git'), msg);
  assert.equal(n.urlError('ssh://git@host/repo.git'), '');
});
