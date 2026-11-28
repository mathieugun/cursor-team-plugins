'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readCatalog } = require('../lib/catalog');
const { NAME_RULE, nameError } = require('../lib/authoring');
const {
  shareKind,
  shareableItem,
  projectItems,
  suggestName,
  shareNameError,
  shareItem,
  renameSkillName,
} = require('../lib/share');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

function fixture(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  return root;
}

test('shareKind', () => {
  const win = String.raw`d:\p\.cursor\rules\style.mdc`;
  assert.deepEqual(shareKind(win), { kind: 'rule', name: 'style', ext: '.mdc', src: win });
  assert.deepEqual(shareKind('/p/.cursor/rules/backend/db.md'), {
    kind: 'rule',
    name: 'db',
    ext: '.md',
    src: '/p/.cursor/rules/backend/db.md',
  });
  assert.deepEqual(shareKind('/p/.cursor/skills/code-review'), {
    kind: 'skill',
    name: 'code-review',
    ext: '',
    src: '/p/.cursor/skills/code-review',
  });
  assert.deepEqual(shareKind('/p/.cursor/skills/code-review/SKILL.md'), {
    kind: 'skill',
    name: 'code-review',
    ext: '',
    src: path.dirname('/p/.cursor/skills/code-review/SKILL.md'),
  });
  const command = shareKind('/p/.cursor/commands/review-pr.markdown');
  assert.equal(command.kind, 'command');
  assert.equal(command.name, 'review-pr');
  assert.equal(command.ext, '.markdown');
  const agent = shareKind('/p/.cursor/agents/reviewer.md');
  assert.equal(agent.kind, 'agent');
  assert.equal(agent.name, 'reviewer');
  for (const p of [
    '/p/.cursor/rules/a.txt',
    '/p/.cursor/agents/a.txt',
    '/p/.cursor/skills/x/scripts/a.md',
    '/p/.cursor/skills',
    '/s/.cursor/plugins/repos/r/review/skills/x/SKILL.md',
    '/p/x.cursor/rules/a.mdc',
    '/p/.cursor/commands/sub/c.md',
  ]) {
    assert.equal(shareKind(p), null, p);
  }
});

test("the explorer menu's regexes agree with shareKind", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const entry = pkg.contributes.menus['explorer/context'].find((e) => e.command === 'teamPlugins.shareWithTeam');
  assert.ok(entry);
  const regexes = [...entry.when.matchAll(/=~ \/(\S+)\/(?=\s|$)/g)].map((m) => new RegExp(m[1]));
  assert.equal(regexes.length, 2);
  const [folderRe, fileRe] = regexes;
  // [isFolder, path, shareable]
  const samples = [
    [true, String.raw`d:\p\.cursor\skills\code-review`, true],
    [true, '/home/u/p/.cursor/skills/x', true],
    [false, String.raw`d:\p\.cursor\rules\a.mdc`, true],
    [false, String.raw`d:\p\.cursor\rules\sub\a.md`, true],
    [false, '/p/.cursor/skills/x/SKILL.md', true],
    [false, '/p/.cursor/commands/c.markdown', true],
    [true, String.raw`d:\p\.cursor\skills\x\scripts`, false],
    [false, '/p/.cursor/rules/a.txt', false],
    [false, '/p/.cursor/skills/x/scripts/a.md', false],
    [false, '/p/.cursor/agents/a.txt', false],
    [false, '/s/.cursor/plugins/repos/r/review/skills/x/SKILL.md', false],
    [false, '/p/x.cursor/rules/a.mdc', false],
  ];
  for (const [isFolder, p, shareable] of samples) {
    assert.equal((isFolder ? folderRe : fileRe).test(p), shareable, p);
    if (shareable) {
      assert.notEqual(shareKind(p), null, p);
    } else if (!isFolder) {
      assert.equal(shareKind(p), null, p);
    }
  }
});

test('shareableItem', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor/skills/a/SKILL.md', 'x');
  fs.mkdirSync(path.join(root, '.cursor', 'skills', 'b'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cursor', 'rules', 'x.mdc'), { recursive: true });
  const dir = path.join(root, '.cursor', 'skills', 'a');
  assert.deepEqual(shareableItem(dir), { kind: 'skill', name: 'a', ext: '', src: dir });
  assert.equal(shareableItem(path.join(dir, 'SKILL.md')).src, dir);
  assert.equal(shareableItem(path.join(root, '.cursor', 'skills', 'b')), null);
  assert.equal(shareableItem(path.join(root, '.cursor', 'rules', 'x.mdc')), null);
  assert.equal(shareableItem(path.join(root, '.cursor', 'rules', 'missing.mdc')), null);
});

test('projectItems', (t) => {
  const root = fixture(t);
  writeFile(root, '.cursor/rules/b.mdc', 'b');
  writeFile(root, '.cursor/rules/a.md', 'a');
  writeFile(root, '.cursor/rules/sub/c.mdc', 'c');
  writeFile(root, '.cursor/rules/notes.txt', 'n');
  writeFile(root, '.cursor/skills/s1/SKILL.md', 's');
  writeFile(root, '.cursor/skills/s2/README.md', 'r');
  writeFile(root, '.cursor/commands/run.md', 'run');
  writeFile(root, '.cursor/agents/helper.md', 'h');
  const items = projectItems(root);
  assert.deepEqual(items.map((i) => i.rel), [
    '.cursor/skills/s1',
    '.cursor/rules/a.md',
    '.cursor/rules/b.mdc',
    '.cursor/rules/sub/c.mdc',
    '.cursor/commands/run.md',
    '.cursor/agents/helper.md',
  ]);
  assert.deepEqual(items.map((i) => [i.kind, i.name]), [
    ['skill', 's1'],
    ['rule', 'a'],
    ['rule', 'b'],
    ['rule', 'c'],
    ['command', 'run'],
    ['agent', 'helper'],
  ]);
  assert.equal(items[0].src, path.join(root, '.cursor', 'skills', 's1'));
  assert.deepEqual(projectItems(path.join(root, 'nothing')), []);
});

test('suggestName', () => {
  const cases = [
    ['My_Rule', 'my-rule'],
    ['Code Review!', 'code-review'],
    ['--x--', 'x'],
    ['___', ''],
    ['a..b', 'a..b'],
    ['x'.repeat(70), 'x'.repeat(64)],
  ];
  for (const [input, expected] of cases) {
    const got = suggestName(input);
    assert.equal(got, expected, input);
    if (got) {
      assert.equal(nameError(got), '', input);
    }
  }
});

test('shareNameError', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p', { rules: ['style.md'] });
  const dir = path.join(root, 'p');
  assert.equal(shareNameError(dir, 'rule', 'Bad'), NAME_RULE);
  assert.equal(shareNameError(dir, 'rule', 'style'), 'rules/style.md already exists');
  assert.equal(shareNameError(dir, 'rule', 'free'), '');
});

test('shareItem copies a rule and a command', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p');
  const dir = path.join(root, 'p');
  const text = '---\ndescription: House style.\nalwaysApply: false\n---\nUse tabs.\n';
  const src = writeFile(root, 'project/.cursor/rules/sub/style.mdc', text);
  const item = shareKind(src);
  const result = shareItem(item, dir, 'style');
  assert.deepEqual(result, { file: path.join(dir, 'rules', 'style.mdc'), skipped: [] });
  assert.equal(fs.readFileSync(result.file, 'utf8'), text);
  assert.ok(fs.existsSync(src));
  const child = readCatalog(root).plugins[0].children.find((c) => c.id === 'p/rules/style.mdc');
  assert.equal(child.description, 'House style.');
  assert.deepEqual(shareItem(item, dir, 'style'), { error: 'rules/style.mdc already exists' });

  const cmd = shareKind(writeFile(root, 'project/.cursor/commands/run.txt', 'Run it.'));
  const copied = shareItem(cmd, dir, 'run');
  assert.equal(copied.file, path.join(dir, 'commands', 'run.txt'));
  assert.equal(fs.readFileSync(copied.file, 'utf8'), 'Run it.');
});

test('shareItem copies a skill and leaves its links out', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p');
  const dir = path.join(root, 'p');
  writeFile(root, 'project/.cursor/skills/code-review/SKILL.md', '---\nname: code-review\ndescription: d\n---\nbody\n');
  writeFile(root, 'project/.cursor/skills/code-review/scripts/check.py', 'print(1)\n');
  writeFile(root, 'outside/secret.txt', 's');
  const skill = path.join(root, 'project', '.cursor', 'skills', 'code-review');
  const link = path.join(skill, 'scripts', 'linked');
  const target = path.join(root, 'outside');
  let linked = false;
  if (process.platform === 'win32') {
    const r = spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { encoding: 'utf8' });
    linked = r.status === 0 && fs.existsSync(link);
  } else {
    try {
      fs.symlinkSync(target, link, 'dir');
      linked = true;
    } catch {
      // no links here: the rest of the test still runs
    }
  }
  const result = shareItem(shareKind(skill), dir, 'code-review');
  assert.equal(result.error, undefined);
  assert.equal(result.file, path.join(dir, 'skills', 'code-review', 'SKILL.md'));
  assert.ok(fs.existsSync(result.file));
  assert.ok(fs.existsSync(path.join(dir, 'skills', 'code-review', 'scripts', 'check.py')));
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'code-review', 'scripts', 'linked')), false);
  assert.deepEqual(result.skipped, linked ? ['scripts/linked'] : []);
});

test('shareItem renames a skill', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p');
  const dir = path.join(root, 'p');
  const src = writeFile(
    root,
    'project/.cursor/skills/My_Skill/SKILL.md',
    '---\r\nname: "My_Skill"\r\ndescription: d\r\n---\r\nbody\r\n',
  );
  const result = shareItem(shareKind(src), dir, 'my-skill');
  assert.equal(result.file, path.join(dir, 'skills', 'my-skill', 'SKILL.md'));
  assert.equal(fs.readFileSync(result.file, 'utf8'), '---\r\nname: my-skill\r\ndescription: d\r\n---\r\nbody\r\n');
  assert.equal(fs.existsSync(path.join(dir, 'skills', 'My_Skill')), false);
});

test('renameSkillName', () => {
  assert.equal(renameSkillName('---\nname: old\ndescription: d\n---\nb\n', 'old', 'new'), '---\nname: new\ndescription: d\n---\nb\n');
  const other = '---\nname: other\n---\nb\n';
  assert.equal(renameSkillName(other, 'old', 'new'), other);
  const bare = 'name: old\nbody\n';
  assert.equal(renameSkillName(bare, 'old', 'new'), bare);
  const after = '---\ndescription: d\n---\nname: old\n';
  assert.equal(renameSkillName(after, 'old', 'new'), after);
  assert.equal(renameSkillName('\ufeff---\nname: old\n---\n', 'old', 'new'), '\ufeff---\nname: new\n---\n');
  assert.equal(renameSkillName("---\nname: 'old'\n---\n", 'old', 'new'), '---\nname: new\n---\n');
});

test('renameSkillName writes a name that needs quotes quoted', () => {
  assert.equal(
    renameSkillName('---\nname: old\ndescription: d\n---\n', 'old', '123'),
    '---\nname: "123"\ndescription: d\n---\n',
  );
});

test('shareItem refuses a bad name and writes nothing', (t) => {
  const root = fixture(t);
  makePlugin(root, 'p');
  const dir = path.join(root, 'p');
  const src = writeFile(root, 'project/.cursor/rules/a.mdc', 'x');
  assert.deepEqual(shareItem(shareKind(src), dir, 'Bad'), { error: NAME_RULE });
  assert.equal(fs.existsSync(path.join(dir, 'rules')), false);
  const skill = writeFile(root, 'project/.cursor/skills/s/SKILL.md', 'x');
  assert.deepEqual(shareItem(shareKind(skill), dir, 'Bad'), { error: NAME_RULE });
  assert.equal(fs.existsSync(path.join(dir, 'skills')), false);
});
