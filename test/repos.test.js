'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const {
  normalizeUrl,
  baseName,
  repoName,
  originUrl,
  parseRepositories,
  parseLocalRepositories,
  parseProjectRepositories,
  migratedSettings,
  listRepos,
  assignNames,
  mergeCatalogs,
  normalizeIds,
  repoOfId,
  missingRepos,
  unlocatedRepos,
  projectRepoEntry,
  withProjectRepo,
  withoutProjectRepo,
} = require('../lib/repos');
const { tmpDir, rmDir, writeFile, makePlugin } = require('./helpers');

test('normalizeUrl', () => {
  assert.equal(normalizeUrl('https://github.com/org/plugins.git'), 'github.com/org/plugins');
  assert.equal(normalizeUrl('git@github.com:org/plugins.git'), 'github.com/org/plugins');
  assert.equal(normalizeUrl('ssh://git@GitHub.com:22/org/plugins/'), 'github.com/org/plugins');
  assert.equal(normalizeUrl('https://user:tok@github.com/org/plugins'), 'github.com/org/plugins');
  assert.equal(normalizeUrl('https://host/Org/Repo.GIT'), 'host/Org/Repo');
  assert.equal(normalizeUrl('C:\\Repos\\Team.git', 'win32'), 'file:c:/repos/team.git');
  assert.equal(normalizeUrl('file:///C:/Repos/x', 'win32'), 'file:c:/repos/x');
  assert.equal(normalizeUrl('/srv/git/team.git', 'linux'), 'file:/srv/git/team.git');
  assert.equal(normalizeUrl('  weird  '), 'weird');
});

test('baseName', () => {
  assert.equal(baseName('https://h/org/plugins.git'), 'plugins');
  assert.equal(baseName('git@h:plugins.git'), 'plugins');
  assert.equal(baseName('C:\\a\\team\\'), 'team');
  assert.equal(baseName(''), 'repo');
});

test('repoName', () => {
  assert.equal(repoName(' my team/plugins: x '), 'my-team-plugins-x');
  assert.equal(repoName(''), '');
});

test('originUrl', () => {
  const clone = [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    '\turl = https://github.com/mathieugun/team-plugins-test.git',
    '\tfetch = +refs/heads/*:refs/remotes/origin/*',
    '',
  ].join('\n');
  assert.equal(originUrl(clone), 'https://github.com/mathieugun/team-plugins-test.git');
  // git doubles the backslashes of a Windows path
  assert.equal(originUrl('[remote "origin"]\n\turl = C:\\\\Users\\\\me\\\\b a.git\n'), 'C:\\Users\\me\\b a.git');
  assert.equal(originUrl('[remote "upstream"]\n\turl = https://h/x.git\n[branch "main"]\n\tremote = origin\n'), '');
  assert.equal(originUrl('[remote "origin"]\n\tfetch = x\n[remote "other"]\n\turl = u\n'), '');
  assert.equal(originUrl(undefined), '');
  assert.equal(originUrl('[remote "origin"]\n\turl = "a\\"b"\n'), 'a"b');
});

test('parseRepositories', () => {
  assert.deepEqual(parseRepositories(['  u1 ', { url: 'u2', branch: ' dev ' }, { branch: 'x' }, 3, '']), [
    { url: 'u1', branch: '' },
    { url: 'u2', branch: 'dev' },
  ]);
  assert.deepEqual(parseRepositories('x'), []);
  assert.deepEqual(parseLocalRepositories([' D:/a ', '', 3, 'b']), ['D:/a', 'b']);
  assert.deepEqual(parseLocalRepositories('x'), []);
});

test('parseProjectRepositories', () => {
  assert.deepEqual(parseProjectRepositories([{ name: ' a ', url: 'u' }, 'v', {}]), [
    { name: 'a', url: 'u', branch: '' },
    { name: '', url: 'v', branch: '' },
  ]);
});

test('migratedSettings', () => {
  assert.deepEqual(migratedSettings({ repoUrl: ' u ', branch: 'main', repositories: undefined }), {
    repositories: [{ url: 'u', branch: 'main' }],
  });
  assert.deepEqual(migratedSettings({ repoUrl: 'u', branch: '' }), { repositories: [{ url: 'u' }] });
  assert.deepEqual(migratedSettings({ repoUrl: 'u', repositories: [] }), {});
  assert.deepEqual(migratedSettings({ localRepoPath: 'D:/c', localRepositories: undefined }), {
    localRepositories: ['D:/c'],
  });
  assert.deepEqual(migratedSettings({ localRepoPath: 'D:/c', localRepositories: ['x'] }), {});
  assert.deepEqual(migratedSettings({}), {});
});

const WIN = { platform: 'win32', pluginsRoot: 'C:\\s\\.cursor\\plugins', storage: 'C:\\s' };
const REPOSITORIES = [
  { url: 'https://h/org/a.git', branch: '' },
  { url: 'git@h:org/b.git', branch: 'dev' },
  { url: 'git@h:org/a', branch: '' },
];

test('listRepos', () => {
  const list = listRepos({ ...WIN, repositories: REPOSITORIES, localRepositories: ['D:\\src\\a'] });
  assert.deepEqual(list.map((d) => d.kind), ['local', 'managed', 'managed', 'managed']);
  const [local, first, second, third] = list;
  assert.match(local.key, /^local-a-[0-9a-f]{8}$/);
  assert.equal(local.dir, 'D:\\src\\a');
  assert.equal(local.url, '');
  assert.match(first.key, /^a-[0-9a-f]{8}$/);
  assert.equal(first.dir, `C:\\s\\.cursor\\plugins\\repos\\${first.key}`);
  assert.equal(first.lockFile, `C:\\s\\locks\\${first.key}.lock`);
  assert.equal(first.stateFile, `C:\\s\\state\\${first.key}.json`);
  assert.equal(first.url, 'https://h/org/a.git');
  assert.equal(second.branch, 'dev');
  assert.equal(first.duplicateOf, null);
  assert.equal(third.duplicateOf, first.key);
  assert.equal(third.key, 'dup-3');

  const legacy = listRepos({ ...WIN, repositories: REPOSITORIES, localRepositories: [], legacyOrigin: 'https://H/org/a' });
  assert.equal(legacy[0].key, 'repo');
  assert.equal(legacy[0].dir, 'C:\\s\\.cursor\\plugins\\repo');
  assert.equal(legacy[2].key, 'dup-2');
  // another origin: no legacy clone
  const other = listRepos({ ...WIN, repositories: REPOSITORIES, localRepositories: [], legacyOrigin: 'https://h/org/zzz' });
  assert.ok(other.every((d) => d.key !== 'repo'));
});

test('listRepos: the drafts folder comes first', () => {
  const drafts = 'C:\\s\\.cursor\\plugins\\drafts';
  const list = listRepos({ ...WIN, drafts, repositories: REPOSITORIES, localRepositories: ['D:\\src\\a'] });
  assert.deepEqual(list.map((d) => d.kind), ['drafts', 'local', 'managed', 'managed', 'managed']);
  const [d, local, first] = list;
  assert.equal(d.key, 'drafts');
  assert.equal(d.dir, drafts);
  assert.equal(d.source, drafts);
  assert.equal(d.url, '');
  assert.equal(d.branch, '');
  assert.equal(d.lockFile, 'C:\\s\\locks\\drafts.lock');
  assert.equal(d.stateFile, 'C:\\s\\state\\drafts.json');
  assert.equal(d.duplicateOf, null);
  // the rest of the list is unchanged
  assert.deepEqual(list.slice(1), listRepos({ ...WIN, repositories: REPOSITORIES, localRepositories: ['D:\\src\\a'] }));
  assert.match(local.key, /^local-a-[0-9a-f]{8}$/);
  assert.equal(first.duplicateOf, null);
  assert.equal(assignNames(list, new Map())[0].name, 'drafts');
  // no drafts: no descriptor
  assert.ok(listRepos({ ...WIN, drafts: '', repositories: REPOSITORIES }).every((x) => x.kind !== 'drafts'));
  // a local clone of the drafts folder is a duplicate of it
  const twice = listRepos({ ...WIN, drafts, repositories: [], localRepositories: [drafts] });
  assert.equal(twice[1].duplicateOf, 'drafts');
});

test('assignNames', () => {
  const list = listRepos({
    ...WIN,
    repositories: [
      { url: 'https://h/org/a.git', branch: '' },
      { url: 'https://h/org/b.git', branch: '' },
      { url: 'https://h/org/c.git', branch: '' },
      { url: 'https://h/org/a', branch: '' },
    ],
    localRepositories: ['D:\\src\\a'],
  });
  const [local, a, b, c, dup] = list;
  const named = assignNames(list, new Map([[local.key, 'team'], [a.key, 'team'], [b.key, 'x'], [c.key, 'x']]));
  assert.deepEqual(named.map((d) => d.name), ['team', 'team', 'x', 'x', '']);
  assert.equal(named[0].hiddenBy, null);
  assert.equal(named[1].hiddenBy.reason, 'local');
  assert.equal(named[1].hiddenBy.key, local.key);
  assert.equal(named[2].hiddenBy, null);
  assert.equal(named[3].hiddenBy.reason, 'name');
  assert.equal(named[3].hiddenBy.source, 'https://h/org/b.git');
  assert.equal(dup.duplicateOf, a.key);
  assert.equal(named[4].hiddenBy, null);

  // no marketplace name: the last part of the URL
  const unnamed = assignNames(list, new Map());
  assert.equal(unnamed[0].name, 'a');
  assert.equal(unnamed[1].hiddenBy.reason, 'local');
  assert.equal(unnamed[2].name, 'b');
});

function makeRepo(t, setup) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  setup(root);
  return root;
}

const market = (root, plugins) =>
  writeFile(root, '.cursor-plugin/marketplace.json', JSON.stringify({ plugins: plugins.map(([name, source]) => ({ name, source })) }));

function merged(t) {
  const one = makeRepo(t, (root) => {
    market(root, [['review', './review'], ['docs', './docs']]);
    makePlugin(root, 'review', { skills: ['s'] });
    makePlugin(root, 'docs', { skills: ['w'] });
  });
  const two = makeRepo(t, (root) => {
    makePlugin(root, 'review', { skills: ['s'] });
  });
  return mergeCatalogs([
    { desc: { name: 'one', key: 'k1' }, catalog: readCatalog(one) },
    { desc: { name: 'two', key: 'k2' }, catalog: readCatalog(two) },
  ]);
}

test('mergeCatalogs prefixes names and ids, and renames a taken folder', (t) => {
  const { plugins, warnings } = merged(t);
  assert.deepEqual(warnings, []);
  assert.deepEqual(plugins.map((p) => p.name), ['one:review', 'one:docs', 'two:review']);
  assert.deepEqual(plugins.map((p) => p.pluginName), ['review', 'docs', 'review']);
  assert.deepEqual(plugins.map((p) => p.repo), ['one', 'one', 'two']);
  assert.deepEqual(plugins.map((p) => p.repoKey), ['k1', 'k1', 'k2']);
  assert.deepEqual(plugins.map((p) => p.folder), [undefined, undefined, 'review-two']);
  assert.ok(!('folder' in plugins[0]));
  assert.deepEqual(plugins[0].children.map((c) => c.id), ['one:review/skills/s']);
  assert.deepEqual(plugins[2].children.map((c) => c.id), ['two:review/skills/s']);
  assert.equal(path.basename(plugins[2].dir), 'review');
});

test('mergeCatalogs renames folders taken inside one repository', (t) => {
  const root = makeRepo(t, (r) => {
    market(r, [['ra', 'a/review'], ['rb', 'b/review'], ['rc', 'c/review']]);
    makePlugin(r, 'a/review', { name: 'ra' });
    makePlugin(r, 'b/review', { name: 'rb' });
    makePlugin(r, 'c/review', { name: 'rc' });
  });
  const { plugins } = mergeCatalogs([{ desc: { name: 'one', key: 'k1' }, catalog: readCatalog(root) }]);
  assert.deepEqual(plugins.map((p) => p.name), ['one:ra', 'one:rb', 'one:rc']);
  assert.deepEqual(plugins.map((p) => p.folder), [undefined, 'review-one', 'review-one-2']);
});

test('mergeCatalogs compares folder names ignoring case, and prefixes the warnings', (t) => {
  const one = makeRepo(t, (r) => {
    makePlugin(r, 'Review', {});
    writeFile(r, '.cursor-plugin/marketplace.json', '{');
  });
  const two = makeRepo(t, (r) => makePlugin(r, 'review', {}));
  const { plugins, warnings } = mergeCatalogs([
    { desc: { name: 'one', key: 'k1' }, catalog: readCatalog(one) },
    { desc: { name: 'two', key: 'k2' }, catalog: readCatalog(two) },
  ]);
  assert.deepEqual(plugins.map((p) => p.folder), [undefined, 'review-two']);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].startsWith('one: marketplace.json:'), warnings[0]);
});

test('normalizeIds', (t) => {
  const catalog = merged(t);
  assert.deepEqual(normalizeIds(catalog, ['review', 'docs/skills/w', 'two:review', 'nope']), [
    'nope',
    'one:docs/skills/w',
    'one:review',
    'two:review',
  ]);
  assert.deepEqual(normalizeIds(catalog, ['review', 'one:review', 7, 'review']), ['one:review']);
  assert.deepEqual(normalizeIds(catalog, undefined), []);
});

test('repoOfId', () => {
  assert.equal(repoOfId('one:review/skills/s'), 'one');
  assert.equal(repoOfId('review'), '');
});

const FOLLOWED = [{ name: 'team-a', kind: 'managed', duplicateOf: null, normalized: 'h/org/a' }];

test('missingRepos', () => {
  const missing = missingRepos(
    [
      { name: '', url: 'git@h:org/a.git' },
      { name: 'team-a', url: 'https://other/x' },
      { name: 'b', url: 'https://h/org/b' },
      { name: 'b2', url: 'https://h/org/b.git' },
    ],
    FOLLOWED,
  );
  assert.equal(missing.length, 1);
  assert.equal(missing[0].url, 'https://h/org/b');
  assert.equal(missing[0].name, 'b');
  assert.equal(missing[0].normalized, 'h/org/b');
});

test('unlocatedRepos', () => {
  assert.deepEqual(
    unlocatedRepos(['team-a:x', 'c:y', 'b:z', 'legacy'], [{ name: 'b', url: 'u' }], FOLLOWED),
    ['c'],
  );
});

test('projectRepoEntry', () => {
  assert.deepEqual(projectRepoEntry({ kind: 'managed', name: 'n', url: 'u', branch: 'dev' }, ''), {
    name: 'n',
    url: 'u',
    branch: 'dev',
  });
  const noBranch = projectRepoEntry({ kind: 'managed', name: 'n', url: 'u', branch: '' }, '');
  assert.deepEqual(noBranch, { name: 'n', url: 'u' });
  assert.ok(!('branch' in noBranch));
  assert.deepEqual(projectRepoEntry({ kind: 'local', name: 'n', url: '' }, 'u'), { name: 'n', url: 'u' });
  assert.equal(projectRepoEntry({ kind: 'local', name: 'n', url: '' }, ''), null);
  // the project's settings are committed: a user and token written in an HTTPS URL stay out of them
  const managed = { kind: 'managed', name: 'n', url: 'https://me:secret@host/org/p.git', branch: '' };
  assert.deepEqual(projectRepoEntry(managed, ''), { name: 'n', url: 'https://host/org/p.git' });
  assert.deepEqual(projectRepoEntry({ kind: 'local', name: 'n', url: '' }, 'HTTP://tok@host/p'), {
    name: 'n',
    url: 'HTTP://host/p',
  });
  const ssh = { kind: 'managed', name: 'n', url: 'ssh://git@host/org/p.git', branch: '' };
  assert.equal(projectRepoEntry(ssh, '').url, 'ssh://git@host/org/p.git');
  assert.equal(projectRepoEntry({ ...ssh, url: 'git@host:org/p.git' }, '').url, 'git@host:org/p.git');
});

test('withProjectRepo', () => {
  const one = withProjectRepo([], { name: 'a', url: 'https://h/a.git' });
  assert.deepEqual(one, [{ name: 'a', url: 'https://h/a.git' }]);
  assert.deepEqual(withProjectRepo(one, { name: 'z', url: 'git@h:a' }), one);
  assert.deepEqual(withProjectRepo(one, { name: 'a', url: 'https://x/other' }), one);
  assert.deepEqual(withProjectRepo(one, { name: 'b', url: 'https://h/b', branch: 'dev' }), [
    ...one,
    { name: 'b', url: 'https://h/b', branch: 'dev' },
  ]);
});

test('withoutProjectRepo', () => {
  const list = [{ name: 'a', url: 'u' }, { name: 'b', url: 'v' }];
  assert.deepEqual(withoutProjectRepo(list, 'a', ['a:x']), list);
  assert.deepEqual(withoutProjectRepo(list, 'a', ['b:y']), [{ name: 'b', url: 'v' }]);
});
