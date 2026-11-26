'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const checks = require('../lib/checks');
const { readCatalog, frontmatterField } = require('../lib/catalog');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

const { splitFrontmatter, lintFrontmatter, checkItemText, conflictMarkerLine, parseJsonc, checkJsonText, pushProblems } = checks;

const lint = (frontmatter) => lintFrontmatter(splitFrontmatter(`---\n${frontmatter}\n---\nBody text.\n`).frontmatter.lines);

// [frontmatter, expected]: expected is 'ok', 'notMapping', 'empty', 'unknown' or { line (0-based in the block), detail,
// starts }. The verdicts are gray-matter's (Cursor 3.32.4).
const FRONTMATTER_CASES = [
  ['name: x\ndescription: Use when: the user asks', { line: 1, detail: 'the value of "description" contains ": " or ends with ":": put the value in quotes' }],
  ['description: see http://x.y/z and a:b', 'ok'],
  ['description: fix #12 now', 'ok'],
  ['description: *important* thing', { starts: 'the value of "description" starts with "*"' }],
  ['description: &x thing', 'ok'],
  ['description: @user thing', {}],
  ['description: `code` thing', {}],
  ['description: [WIP] does x', { detail: 'text after the closing ] in the value of "description": put the whole value in quotes' }],
  ['description: {x} does x', {}],
  ['description: "a" b', {}],
  ['description: "abc', { detail: 'the quote that opens the value of "description" is never closed' }],
  ["description: 'it''s ok'", 'ok'],
  ["description: 'it's bad'", {}],
  ['metadata:\n\tkey: v', 'ok'],
  ['description: a\ndescription: b', { line: 1, detail: '"description" appears twice' }],
  ['description: |\nabc', { line: 1, starts: 'this line is not a "key: value" line' }],
  ['description: - x', {}],
  ['description: %x', {}],
  ['description: !x thing', {}],
  ['description: ? x', 'ok'],
  ['globs: *.py', { starts: 'the value of "globs" starts with "*"' }],
  ['globs: src/**, test/**', 'ok'],
  ['description: a\n  b: c\nname: x', { line: 1 }],
  ['metadata:\n  a: 1\n  b: x: y', { line: 2, includes: '"b"' }],
  ['metadata:\n  notes: |\n    Use when: x\n  b: 1', 'ok'],
  ['items:\n  - a: b\n  - c: d', 'ok'],
  ['tools: [a, b\nname: x', { detail: 'the [ that opens the value of "tools" is never closed' }],
  ['tools: [a,\n  b]\nname: x', 'ok'],
  ['description: ends with colon:', {}],
  ['description: : x', {}],
  ['name: x\n  description: y', { line: 1 }],
  ['  name: x\n  description: y', 'ok'],
  ['just text', 'notMapping'],
  ['just text: and more\nsecond line', { line: 1 }],
  ['tools:\n- a\n- b\nname: x', 'ok'],
  ['description: >\n  a\n  b\nname: x', 'ok'],
  ['description: >\n  a\n b\nname: x', { line: 2 }],
  ['description: "line one\n  line two"', 'ok'],
  ['description: "a\nname: b', {}],
  ['a: &x 1\nb: *x', 'ok'],
  ['b: *x\na: &x 1', {}],
  ['"a: b": c', 'ok'],
  ['"a": 1\na: 2', {}],
  ["description: it's fine", 'ok'],
  ['description: say "hi" now', 'ok'],
  ['description: "a" # c', 'ok'],
  ['tools: [a, b] # c', 'ok'],
  ['a: {b: c} d', {}],
  ['? a\n: b', 'unknown'],
  ['description: a | b > c', 'ok'],
  ['description: 100% sure', 'ok'],
  ['description: C# helper', 'ok'],
  ['homepage: https://x.y/z', 'ok'],
  [
    'description: y\nargument-hint: [file] [mode]',
    { line: 1, detail: 'text after the closing ] in the value of "argument-hint": put the whole value in quotes' },
  ],
  ['allowed-tools: Bash(git status:*), Read', 'ok'],
  ['description:\nname: x', 'ok'],
  ['description: |\nname: x', 'ok'],
  ['# just a comment', 'empty'],
];

test('lintFrontmatter: verdicts of gray-matter', () => {
  for (const [fm, expected] of FRONTMATTER_CASES) {
    const r = lint(fm);
    const label = JSON.stringify(fm);
    if (expected === 'ok') {
      assert.ok(r.keys, `${label} should be valid, got ${JSON.stringify(r)}`);
    } else if (typeof expected === 'string') {
      assert.ok(r[expected], `${label} should be ${expected}, got ${JSON.stringify(r)}`);
    } else {
      assert.ok(r.error, `${label} should be an error, got ${JSON.stringify(r)}`);
      if (expected.line !== undefined) {
        assert.equal(r.error.line, expected.line, label);
      }
      if (expected.detail !== undefined) {
        assert.equal(r.error.detail, expected.detail, label);
      }
      if (expected.starts !== undefined) {
        assert.ok(r.error.detail.startsWith(expected.starts), `${label}: ${r.error.detail}`);
      }
      if (expected.includes !== undefined) {
        assert.ok(r.error.detail.includes(expected.includes), `${label}: ${r.error.detail}`);
      }
    }
  }
  assert.ok(lintFrontmatter(splitFrontmatter('---\n---\nbody').frontmatter.lines).empty);
});

test('lintFrontmatter keeps the kind and the value of each key', () => {
  const { keys } = lint('name: x # c\ndescription: "q"\ntools:\n  - a\nmore: >\n  b');
  assert.deepEqual(keys.get('name'), { kind: 'plain', line: 0, value: 'x' });
  assert.deepEqual(keys.get('description'), { kind: 'quoted', line: 1, value: '' });
  assert.equal(keys.get('tools').kind, 'nested');
  assert.equal(keys.get('more').kind, 'block');
});

test('splitFrontmatter', () => {
  assert.deepEqual(splitFrontmatter('﻿---\na: 1\n---\nx'), { frontmatter: { lines: ['a: 1'], closed: true }, body: 'x' });
  assert.deepEqual(splitFrontmatter('---\r\na: 1\r\n---\r\nx').frontmatter, { lines: ['a: 1'], closed: true });
  assert.equal(splitFrontmatter('----\nname: a\n----\nx').frontmatter, null);
  const spaced = splitFrontmatter('---\nname: a\n---   \nbody');
  assert.equal(spaced.frontmatter.closed, true);
  assert.equal(spaced.body, 'body');
  assert.deepEqual(splitFrontmatter('---\nname: x\ndescription: y\n'), {
    frontmatter: { lines: ['name: x', 'description: y', ''], closed: false },
    body: '',
  });
  assert.deepEqual(splitFrontmatter('# Title\n'), { frontmatter: null, body: '# Title\n' });
});

test('conflictMarkerLine', () => {
  assert.equal(conflictMarkerLine('a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> branch\n'), 2);
  assert.equal(conflictMarkerLine('Title\n=======\n'), 0);
  assert.equal(conflictMarkerLine('<<<<<<< HEAD\nno end\n'), 0);
  assert.equal(conflictMarkerLine('<<<<<<<\nx\n>>>>>>>\n'), 1);
});

const item = (kind, text) => checkItemText(kind, text, '/r/f.md', frontmatterField);

test('checkItemText: frontmatter that Cursor drops', () => {
  const skill = item('skill', '---\nname: a\ndescription: Use when: x\n---\nBody');
  assert.deepEqual(skill, [
    {
      file: '/r/f.md',
      line: 3,
      severity: 'error',
      message:
        'Frontmatter is not valid YAML, so Cursor drops this skill: the value of "description" contains ": " or ends with ":": put the value in quotes',
    },
  ]);
  const rule = item('rule', '---\nglobs: *.ts\n---\nBody');
  assert.equal(rule.length, 1);
  assert.equal(rule[0].line, 2);
  assert.equal(rule[0].severity, 'error');
  const command = item('command', '---\ndescription: y\nargument-hint: [file] [mode]\n---\nBody');
  assert.equal(command.length, 1);
  assert.equal(command[0].line, 3);
  const unclosed = item('skill', '---\nname: a\ndescription: y\n\n# Title\n\nSome text.\n');
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].line, 1);
  assert.equal(
    unclosed[0].message,
    'The frontmatter has no closing "---" line, so Cursor reads the whole file as frontmatter and drops this skill',
  );
  assert.deepEqual(item('skill', '---\nname: a\ndescription: y\n'), []);
});

test('checkItemText: a skill or agent without a description', () => {
  const none = item('skill', '# Just a body\n');
  assert.deepEqual(none, [
    { file: '/r/f.md', line: 1, severity: 'warning', message: "No description: the agent can't tell when to use this skill" },
  ]);
  const empty = item('skill', '---\nname: a\ndescription:\n---\nBody');
  assert.equal(empty.length, 1);
  assert.equal(empty[0].severity, 'warning');
  assert.equal(empty[0].line, 3);
  assert.equal(item('skill', '---\nname: a\ndescription: ""\n---\nBody').length, 1);
  for (const value of ['12', '2024-01-01', 'true', 'null', '[a, b]']) {
    const r = item('skill', `---\nname: a\ndescription: ${value}\n---\nBody`);
    assert.equal(r.length, 1, value);
    assert.equal(r[0].severity, 'warning', value);
  }
  assert.deepEqual(item('skill', '---\nname: a\ndescription: yes\n---\nBody'), []);
  const folded = fs.readFileSync(path.join(__dirname, 'fixtures', 'team-repo', 'docs', 'skills', 'write-readme', 'SKILL.md'), 'utf8');
  assert.deepEqual(item('skill', folded), []);
  assert.deepEqual(item('rule', '# Just a body\n'), []);
  assert.deepEqual(item('command', 'Do it.\n'), []);
});

test('checkItemText: an agent', () => {
  const body = item('agent', '---\nname: r\ndescription: Reviews.\n---\n\n');
  assert.deepEqual(body, [
    { file: '/r/f.md', line: 1, severity: 'error', message: 'No instructions after the frontmatter, so Cursor drops this agent' },
  ]);
  const nodesc = item('agent', '---\nname: r\n---\nReview it.\n');
  assert.equal(nodesc.length, 1);
  assert.equal(nodesc[0].severity, 'warning');
  assert.equal(nodesc[0].message, "No description: the agent can't tell when to use this agent");
});

test('checkItemText: conflict markers', () => {
  const text = '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n';
  for (const kind of ['skill', 'rule', 'command', 'agent']) {
    const r = item(kind, `---\nname: a\ndescription: d\n---\n${text}`);
    const conflict = r.find((p) => p.message.startsWith('Conflict markers'));
    assert.ok(conflict, kind);
    assert.equal(conflict.line, 5);
    assert.equal(conflict.severity, 'error');
    assert.equal(conflict.message, 'Conflict markers (<<<<<<< ... >>>>>>>) are left from a merge');
  }
});

test('parseJsonc', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": [1, 2,], /* d */ "b": {"c": 1,}, }'), { a: [1, 2], b: { c: 1 } });
  assert.deepEqual(parseJsonc('{"u": "http://x//y", "s": "a,}"}'), { u: 'http://x//y', s: 'a,}' });
  assert.deepEqual(parseJsonc('﻿{"a":1}'), { a: 1 });
  assert.throws(() => parseJsonc("{'a': 1}"));
});

test('checkJsonText', () => {
  const file = '/r/.cursor-plugin/plugin.json';
  assert.deepEqual(checkJsonText('﻿{"name":"x"}', file, { what: ' (w)' }), [
    {
      file,
      line: 1,
      severity: 'error',
      message: 'plugin.json starts with a byte order mark (BOM), so Cursor ignores it (w): save it as UTF-8 without BOM',
    },
  ]);
  const trailing = checkJsonText('{\n  "name": "x",\n}', file, { what: ' (w)' });
  assert.equal(trailing.length, 1);
  assert.equal(trailing[0].severity, 'error');
  assert.ok(trailing[0].message.startsWith('plugin.json is not valid JSON, so Cursor ignores it (w): '));
  assert.ok(trailing[0].line >= 1);
  if (/position \d+/.test(trailing[0].message)) {
    assert.equal(trailing[0].line, 3);
  }
  assert.equal(checkJsonText('{"name": "x"} // c', file, { what: ' (w)' }).length, 1);
  assert.deepEqual(checkJsonText('{ // c\n "mcpServers": {"a": {"url": "u"},}, }', '/r/p/mcp.json', { jsonc: true }), []);
  const mcp = checkJsonText("{'mcpServers': {}}", '/r/p/mcp.json', { jsonc: true });
  assert.equal(mcp.length, 1);
  assert.ok(mcp[0].message.startsWith('mcp.json is not valid JSON, so Cursor may not load its MCP servers: '));
});

// ---- pushProblems ----------------------------------------------------------------------------------------------

const err = (file, line, message = `m${line}`, severity = 'error') => ({ file, line, severity, message });

function literal() {
  const root = path.resolve('/repo');
  const review = path.join(root, 'review');
  const docs = path.join(root, 'docs');
  return {
    root,
    catalog: {
      problems: [err('', 0, 'repo level')],
      plugins: [
        {
          dir: review,
          problems: [err(path.join(review, '.cursor-plugin', 'plugin.json'), 1, 'review plugin')],
          children: [{ problems: [err(path.join(review, 'skills', 'a', 'SKILL.md'), 3, 'review child')] }, { problems: undefined }],
        },
        {
          dir: docs,
          children: [{ problems: [err(path.join(docs, 'skills', 'b', 'SKILL.md'), 2, 'docs child')] }],
        },
      ],
    },
  };
}

test('pushProblems: the plugins that contain a changed path, and the repository level', () => {
  const { root, catalog } = literal();
  const inReview = pushProblems({ catalog, repoDir: root, changed: ['review/skills/a/SKILL.md'], readFile: () => null });
  assert.deepEqual(inReview.map((p) => p.message).sort(), ['repo level', 'review child', 'review plugin']);
  const inDocs = pushProblems({ catalog, repoDir: root, changed: ['docs/x.md'], readFile: () => null });
  assert.deepEqual(inDocs.map((p) => p.message).sort(), ['docs child', 'repo level']);
  const none = pushProblems({ catalog, repoDir: root, changed: ['README.md'], readFile: () => null });
  assert.deepEqual(none.map((p) => p.message), ['repo level']);
  // a folder whose name starts like another one is not inside it
  const near = pushProblems({ catalog, repoDir: root, changed: ['review-notes/x.md'], readFile: () => null });
  assert.deepEqual(near.map((p) => p.message), ['repo level']);
});

test('pushProblems: conflict markers in a changed file outside the items', () => {
  const { root, catalog } = literal();
  const texts = { [path.join(root, 'scripts', 'x.sh')]: 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n' };
  const found = pushProblems({
    catalog,
    repoDir: root,
    changed: ['scripts/x.sh', 'scripts/missing.sh'],
    readFile: (abs) => (abs in texts ? texts[abs] : null),
  });
  const conflicts = found.filter((p) => p.message.startsWith('Conflict markers'));
  assert.deepEqual(conflicts, [err(path.join(root, 'scripts', 'x.sh'), 2, 'Conflict markers (<<<<<<< ... >>>>>>>) are left from a merge')]);
});

test('pushProblems: a file that already has a problem is reported once, and the result is sorted', () => {
  const { root, catalog } = literal();
  const file = path.join(root, 'review', 'skills', 'a', 'SKILL.md');
  const marker = 'Conflict markers (<<<<<<< ... >>>>>>>) are left from a merge';
  catalog.plugins[0].children.push({ problems: [err(file, 2, marker)] });
  const found = pushProblems({
    catalog,
    repoDir: root,
    changed: ['review/skills/a/SKILL.md'],
    readFile: () => '<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> z\n',
  });
  assert.equal(found.filter((p) => p.message === marker).length, 1);
  const sorted = [...found].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  assert.deepEqual(found, sorted);
  assert.equal(found[0].file, '');
});

test('pushProblems on a real catalog', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  makePlugin(root, 'review', { skills: ['ok'] });
  makePlugin(root, 'docs', { skills: ['ok'] });
  writeFile(root, 'review/skills/bad/SKILL.md', '---\nname: bad\ndescription: Use when: x\n---\nBody\n');
  writeFile(root, 'docs/skills/bad/SKILL.md', '---\nname: bad\ndescription: Use when: y\n---\nBody\n');
  const catalog = readCatalog(root);
  const found = pushProblems({ catalog, repoDir: root, changed: ['review/skills/ok/SKILL.md'], readFile: () => null });
  assert.equal(found.length, 1);
  assert.equal(found[0].file, path.join(root, 'review', 'skills', 'bad', 'SKILL.md'));
  assert.equal(found[0].line, 3);
});
