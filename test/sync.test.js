'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeGit } = require('../lib/git');
const sync = require('../lib/sync');
const { tmpDir, rmDir, writeFile, makePlugin, git, gitAvailable, commitAll, IDENTITY } = require('./helpers');

const fwd = (p) => p.replace(/\\/g, '/');

// git with an identity and without line-ending conversion, whatever the machine's configuration
const OPTS = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
function makeRun() {
  const run = makeGit('git');
  return (args, cwd, timeoutMs, opts) => run([...OPTS, ...args], cwd, timeoutMs, opts);
}

// origin.git (bare) + work clone with one commit pushed to main
function makeOrigin(root, name = 'origin') {
  const origin = path.join(root, `${name}.git`);
  const work = path.join(root, `${name}-work`);
  fs.mkdirSync(origin);
  git(['init', '--bare', '-b', 'main'], origin);
  fs.mkdirSync(work);
  git(['init', '-b', 'main'], work);
  writeFile(work, '.cursor-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'p', source: './p' }] }));
  makePlugin(work, 'p', { skills: ['s'] });
  commitAll(work, 'initial');
  git(['remote', 'add', 'origin', fwd(origin)], work);
  git(['push', '-u', 'origin', 'main'], work);
  return { origin: fwd(origin), work };
}

function setup(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const store = path.join(root, 'store');
  const o = makeOrigin(root);
  const args = {
    run: makeRun(),
    managedRepo: path.join(store, '.cursor', 'plugins', 'repo'),
    repoUrl: o.origin,
    branch: '',
    lockFile: path.join(store, 'sync.lock'),
    stateFile: path.join(store, 'sync-state.json'),
  };
  return { root, store, ...o, args };
}

function pushCommit(work, file, text, message) {
  writeFile(work, file, text);
  const sha = commitAll(work, message);
  git(['push', 'origin', 'main'], work);
  return sha;
}

test('sync lifecycle: clone, upToDate, updated, discard', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const { args } = f;
  const sha0 = git(['rev-parse', 'HEAD'], f.work);

  let r = await sync.syncManaged(args);
  assert.equal(r.kind, 'cloned');
  assert.equal(r.head, sha0);
  assert.ok(fs.existsSync(path.join(args.managedRepo, '.git')));
  const state = JSON.parse(fs.readFileSync(args.stateFile, 'utf8'));
  assert.equal(state.kind, 'cloned');
  assert.ok(state.at);

  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'upToDate');

  const sha1 = pushCommit(f.work, 'p/notes.txt', 'one', 'second commit');
  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'updated');
  assert.equal(r.commits, 1);
  assert.equal(r.kept, 0);
  assert.equal(r.from, sha0);
  assert.equal(r.to, sha1);
  assert.equal(git(['rev-parse', 'HEAD'], args.managedRepo), sha1);
  const log = await sync.changesBetween({ run: args.run, repoDir: args.managedRepo, from: r.from, to: r.to });
  assert.ok(log.includes('second commit'));

  fs.appendFileSync(path.join(args.managedRepo, 'p', 'notes.txt'), ' local edit');
  const d = await sync.discardLocalChanges({ run: args.run, managedRepo: args.managedRepo });
  assert.equal(d.ok, true);
  assert.equal(fs.readFileSync(path.join(args.managedRepo, 'p', 'notes.txt'), 'utf8'), 'one');
  // the reset goes to the already fetched upstream: a commit pushed after it is what the next sync updates to
  pushCommit(f.work, 'p/after-discard.txt', 'x', 'after discard');
  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'updated');
});

test('sync reclones when the url changes', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  await sync.syncManaged(f.args);
  const other = makeOrigin(f.root, 'other');
  const r = await sync.syncManaged({ ...f.args, repoUrl: other.origin });
  assert.equal(r.kind, 'cloned');
  assert.equal(git(['remote', 'get-url', 'origin'], f.args.managedRepo), other.origin);
});

test('sync reclones when the branch changes', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  git(['push', 'origin', 'main:dev'], f.work);
  await sync.syncManaged(f.args);
  const r = await sync.syncManaged({ ...f.args, branch: 'dev' });
  assert.equal(r.kind, 'cloned');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], f.args.managedRepo), 'dev');
});

test('a failing git never deletes the managed clone', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  await sync.syncManaged(f.args);
  const file = path.join(f.args.managedRepo, 'p', 'skills', 's', 'SKILL.md');
  fs.writeFileSync(file, 'edited');
  const r = await sync.syncManaged({ ...f.args, run: makeGit('git-not-there') });
  assert.equal(r.kind, 'error');
  assert.match(r.message, /^cannot check the managed clone: git remote get-url origin failed/);
  assert.ok(fs.existsSync(f.args.managedRepo));
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited');
});

test('a clone without origin is reported, not deleted', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  await sync.syncManaged(f.args);
  git(['remote', 'remove', 'origin'], f.args.managedRepo);
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'error');
  assert.match(r.message, /cannot check the managed clone/);
  assert.ok(fs.existsSync(f.args.managedRepo));
});

test('a commit on a branch without upstream blocks the reclone', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  await sync.syncManaged(f.args);
  const clone = f.args.managedRepo;
  git(['checkout', '-b', 'local'], clone);
  writeFile(clone, 'p/mine.txt', 'mine');
  git(['add', '-A'], clone);
  git([...IDENTITY, 'commit', '-m', 'mine'], clone);
  const other = makeOrigin(f.root, 'other');
  const r = await sync.syncManaged({ ...f.args, repoUrl: other.origin });
  assert.equal(r.kind, 'error');
  assert.match(r.message, /has local changes/);
  assert.ok(fs.existsSync(clone));
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'local');
});

test('sync lock: a fresh lock is busy, a stale one is replaced', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  fs.mkdirSync(f.store, { recursive: true });
  fs.writeFileSync(f.args.lockFile, 'other');
  let r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'busy');
  assert.ok(!fs.existsSync(f.args.stateFile));

  const hourAgo = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(f.args.lockFile, hourAgo, hourAgo);
  r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'cloned');
  assert.ok(!fs.existsSync(f.args.lockFile));
});

test('a failing clone leaves nothing behind', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const r = await sync.syncManaged({ ...f.args, repoUrl: fwd(path.join(f.root, 'missing.git')) });
  assert.equal(r.kind, 'error');
  assert.ok(r.message.startsWith('git clone failed'));
  assert.ok(!fs.existsSync(f.args.managedRepo));
  const parent = path.dirname(f.args.managedRepo);
  assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith('repo.tmp-')), []);
});

test('acquireLock / releaseLock', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const lock = path.join(root, 'x.lock');
  assert.equal(sync.acquireLock(lock), true);
  assert.equal(sync.acquireLock(lock), false);
  sync.releaseLock(lock);
  assert.equal(sync.acquireLock(lock), true);
});

const EIGHT = '1\n2\n3\n4\n5\n6\n7\n8\n';

// a synced clone whose origin also holds a.md, b.md and the eight-line f.md
async function setupFiles(t) {
  const f = setup(t);
  writeFile(f.work, 'a.md', 'a\n');
  writeFile(f.work, 'b.md', 'b\n');
  writeFile(f.work, 'f.md', EIGHT);
  commitAll(f.work, 'files');
  git(['push', 'origin', 'main'], f.work);
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'cloned');
  f.clone = f.args.managedRepo;
  git(['config', 'core.autocrlf', 'false'], f.clone);
  f.read = (rel) => fs.readFileSync(path.join(f.clone, rel), 'utf8');
  return f;
}

const stashes = (f) => git(['stash', 'list'], f.clone);
const lines = (n, text) => EIGHT.split('\n').map((l) => (l === String(n) ? text : l)).join('\n');

test('a local edit survives an update of other files', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'a.md', 'local\n');
  pushCommit(f.work, 'b.md', 'team\n', 'team b');
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'updated');
  assert.equal(r.kept, 1);
  assert.equal(f.read('a.md'), 'local\n');
  assert.equal(f.read('b.md'), 'team\n');
  assert.equal(stashes(f), '');
});

test('a local edit and a team edit of other lines of a file are both kept', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'f.md', lines(8, 'local8'));
  pushCommit(f.work, 'f.md', lines(1, 'team1'), 'team f');
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'updated');
  assert.equal(f.read('f.md'), lines(1, 'team1').replace('\n8\n', '\nlocal8\n'));
  assert.equal(stashes(f), '');
});

test('the same lines changed locally and by the team is a conflict that changes nothing', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  const head = git(['rev-parse', 'HEAD'], f.clone);
  writeFile(f.clone, 'f.md', lines(1, 'local1'));
  pushCommit(f.work, 'f.md', lines(1, 'team1'), 'team f');
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.files, ['f.md']);
  assert.equal(r.behind, 1);
  assert.equal(r.head, head);
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), head);
  assert.equal(f.read('f.md'), lines(1, 'local1'));
  assert.equal(stashes(f), '');
});

test('a local commit is rebased on the team commits', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'a.md', 'local\n');
  git(['add', '-A'], f.clone);
  git([...IDENTITY, 'commit', '-m', 'local'], f.clone);
  pushCommit(f.work, 'b.md', 'team\n', 'team b');
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'updated');
  assert.equal(r.kept, 1);
  assert.equal(git(['rev-list', '--count', '@{u}..HEAD'], f.clone), '1');
  assert.equal(f.read('b.md'), 'team\n');
});

test('a local commit on the same lines as the team is a conflict', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'f.md', lines(1, 'local1'));
  git(['add', '-A'], f.clone);
  git([...IDENTITY, 'commit', '-m', 'local'], f.clone);
  const head = git(['rev-parse', 'HEAD'], f.clone);
  pushCommit(f.work, 'f.md', lines(1, 'team1'), 'team f');
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.files, ['f.md']);
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), head);
  assert.ok(!fs.existsSync(path.join(f.clone, '.git', 'rebase-merge')));
});

test('an untracked local file that the team also adds is a conflict', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'skills/new/SKILL.md', 'local\n');
  pushCommit(f.work, 'skills/new/SKILL.md', 'team\n', 'team adds it');
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.files, ['skills/new/SKILL.md']);
  assert.equal(f.read('skills/new/SKILL.md'), 'local\n');
});

test('parseStatusZ', () => {
  assert.deepEqual(sync.parseStatusZ('R  new.md\0old.md\0 M a b.md\0?? d/e.md\0 D gone.md\0A  added.md\0'), [
    { path: 'new.md', status: 'renamed', from: 'old.md' },
    { path: 'a b.md', status: 'modified' },
    { path: 'd/e.md', status: 'untracked' },
    { path: 'gone.md', status: 'deleted' },
    { path: 'added.md', status: 'added' },
  ]);
});

test('localChanges lists modified, untracked and deleted files and the unpushed commits', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'a.md', 'local\n');
  writeFile(f.clone, 'new/dir/x.md', 'x\n');
  fs.rmSync(path.join(f.clone, 'b.md'));
  let c = await sync.localChanges({ run: f.args.run, repo: f.clone });
  assert.equal(c.ahead, 0);
  const byPath = Object.fromEntries(c.files.map((x) => [x.path, x.status]));
  assert.deepEqual(byPath, { 'a.md': 'modified', 'b.md': 'deleted', 'new/dir/x.md': 'untracked' });
  git(['add', '-A'], f.clone);
  git([...IDENTITY, 'commit', '-m', 'local'], f.clone);
  c = await sync.localChanges({ run: f.args.run, repo: f.clone });
  assert.deepEqual(c, { files: [], ahead: 1 });
});
