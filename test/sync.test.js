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
    stateFile: path.join(store, 'state.json'),
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
  const d = await sync.discardLocalChanges({ run: args.run, managedRepo: args.managedRepo, lockFile: args.lockFile });
  assert.equal(d.ok, true);
  assert.equal(fs.readFileSync(path.join(args.managedRepo, 'p', 'notes.txt'), 'utf8'), 'one');
  // the reset goes to the already fetched upstream: a commit pushed after it is what the next sync updates to
  pushCommit(f.work, 'p/after-discard.txt', 'x', 'after discard');
  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'updated');
});

const refsOf = (clone, pattern) => git(['for-each-ref', '--format=%(refname:short)', pattern], clone);

// a marker inside .git: it survives only if the managed clone is switched in place, never deleted and cloned again
function addMarker(f) {
  const marker = path.join(f.args.managedRepo, '.git', 'team-marker');
  fs.writeFileSync(marker, 'x');
  return marker;
}

// a `dev` branch on origin with p/dev.txt
function pushDev(f) {
  git(['checkout', '-b', 'dev'], f.work);
  writeFile(f.work, 'p/dev.txt', 'dev');
  commitAll(f.work, 'dev commit');
  git(['push', 'origin', 'dev'], f.work);
  git(['checkout', 'main'], f.work);
}

test('sync switches in place when the url changes', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  assert.equal((await sync.syncManaged(f.args)).kind, 'cloned');
  const marker = addMarker(f);
  const other = makeOrigin(f.root, 'other');
  const r = await sync.syncManaged({ ...f.args, repoUrl: other.origin });
  assert.equal(r.kind, 'switched');
  assert.equal(r.branch, 'main');
  assert.equal(git(['remote', 'get-url', 'origin'], clone), other.origin);
  assert.ok(fs.existsSync(marker));
  assert.equal(git(['rev-parse', 'HEAD'], clone), git(['rev-parse', 'HEAD'], other.work));
  assert.equal(refsOf(clone, 'refs/heads/'), 'main');
  assert.equal(git(['rev-parse', '--abbrev-ref', '@{u}'], clone), 'origin/main');
  assert.equal(refsOf(clone, 'refs/team-plugins'), '');
  assert.equal((await sync.syncManaged({ ...f.args, repoUrl: other.origin })).kind, 'upToDate');
});

test('sync switches in place when the branch changes', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  pushDev(f);
  assert.equal((await sync.syncManaged(f.args)).kind, 'cloned');
  const marker = addMarker(f);
  const r = await sync.syncManaged({ ...f.args, branch: 'dev' });
  assert.equal(r.kind, 'switched');
  assert.equal(r.branch, 'dev');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'dev');
  assert.ok(fs.existsSync(path.join(clone, 'p', 'dev.txt')));
  assert.ok(fs.existsSync(marker));
  assert.equal(git(['rev-parse', '--abbrev-ref', '@{u}'], clone), 'origin/dev');
  assert.equal(refsOf(clone, 'refs/heads/'), 'dev');
});

test('an empty branch setting goes back to the default branch', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  pushDev(f);
  await sync.syncManaged(f.args);
  assert.equal((await sync.syncManaged({ ...f.args, branch: 'dev' })).kind, 'switched');
  const r = await sync.syncManaged({ ...f.args, branch: '' });
  assert.equal(r.kind, 'switched');
  assert.equal(r.branch, 'main');
  assert.ok(!fs.existsSync(path.join(clone, 'p', 'dev.txt')));
  assert.equal(git(['rev-parse', '--abbrev-ref', '@{u}'], clone), 'origin/main');
  assert.equal((await sync.syncManaged({ ...f.args, branch: '' })).kind, 'upToDate');
});

test('an empty branch setting follows a new default branch', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  pushDev(f);
  await sync.syncManaged(f.args);
  git(['symbolic-ref', 'HEAD', 'refs/heads/dev'], f.origin);
  const r = await sync.syncManaged({ ...f.args, branch: '' });
  assert.equal(r.kind, 'switched');
  assert.equal(r.branch, 'dev');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], f.args.managedRepo), 'dev');
});

test('a missing branch is an error that changes nothing', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  await sync.syncManaged(f.args);
  const marker = addMarker(f);
  const r = await sync.syncManaged({ ...f.args, branch: 'nope' });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'branchNotFound');
  assert.ok(r.message.startsWith(`branch nope not found on ${f.args.repoUrl}.`), r.message);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'main');
  assert.ok(fs.existsSync(marker));
  assert.equal(refsOf(clone, 'refs/team-plugins'), '');
});

test('a missing repository is an error that changes nothing', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  await sync.syncManaged(f.args);
  const r = await sync.syncManaged({ ...f.args, repoUrl: fwd(path.join(f.root, 'missing.git')) });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'notFound');
  assert.ok(r.message.startsWith(`repository ${fwd(path.join(f.root, 'missing.git'))} not found`), r.message);
  assert.equal(git(['remote', 'get-url', 'origin'], clone), f.args.repoUrl);
  assert.ok(fs.existsSync(clone));
});

test('a local edit blocks the switch', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  pushDev(f);
  await sync.syncManaged(f.args);
  const file = path.join(clone, 'p', 'skills', 's', 'SKILL.md');
  fs.writeFileSync(file, 'edited');
  const r = await sync.syncManaged({ ...f.args, branch: 'dev' });
  assert.equal(r.kind, 'error');
  assert.match(r.message, /has local changes/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'edited');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'main');
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

test('a commit on a branch without upstream blocks the switch', async (t) => {
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
  assert.equal(r.reason, 'notFound');
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
  assert.equal(r.upstream, git(['rev-parse', 'HEAD'], f.work));
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

const MIN2_AGO = () => new Date(Date.now() - 2 * 60 * 1000);

test('removeStaleIndexLock removes only an old index.lock', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const lock = path.join(root, '.git', 'index.lock');
  const messages = [];
  assert.equal(sync.removeStaleIndexLock(root, (m) => messages.push(m)), false);
  writeFile(root, '.git/index.lock', '');
  assert.equal(sync.removeStaleIndexLock(root, (m) => messages.push(m)), false);
  assert.ok(fs.existsSync(lock));
  fs.utimesSync(lock, MIN2_AGO(), MIN2_AGO());
  assert.equal(sync.removeStaleIndexLock(root, (m) => messages.push(m)), true);
  assert.ok(!fs.existsSync(lock));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /removed a stale .*index\.lock/);
});

test('a stale index.lock no longer blocks the sync', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  pushCommit(f.work, 'a.txt', 'a', 'team');
  fs.writeFileSync(path.join(f.clone, 'p', 'skills', 's', 'SKILL.md'), 'local edit');
  const lock = path.join(f.clone, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  fs.utimesSync(lock, MIN2_AGO(), MIN2_AGO());
  const r = await sync.syncManaged(f.args);
  assert.equal(r.kind, 'updated');
  assert.ok(!fs.existsSync(lock));
});

test('leftover temporary clones are removed', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const parent = path.dirname(f.args.managedRepo);
  const leftover = path.join(parent, 'repo.tmp-1-2');
  writeFile(parent, 'repo.tmp-1-2/x.txt', 'x');
  writeFile(parent, 'other/y.txt', 'y');
  assert.equal((await sync.syncManaged(f.args)).kind, 'cloned');
  assert.ok(!fs.existsSync(leftover));
  writeFile(parent, 'repo.tmp-1-2/x.txt', 'x');
  assert.equal((await sync.syncManaged(f.args)).kind, 'upToDate');
  assert.ok(!fs.existsSync(leftover));
  assert.ok(fs.existsSync(path.join(parent, 'other', 'y.txt')));
});

test('network commands have no total limit, a stall limit and --progress', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const calls = [];
  const run = (args, cwd, timeoutMs, opts) => {
    calls.push([args, timeoutMs, opts]);
    return f.args.run(args, cwd, timeoutMs, opts);
  };
  assert.equal((await sync.syncManaged({ ...f.args, run })).kind, 'cloned');
  pushCommit(f.work, 'a.txt', 'a', 'team');
  assert.equal((await sync.syncManaged({ ...f.args, run })).kind, 'updated');
  const clone = calls.find(([args]) => args.includes('clone'));
  const fetch = calls.find(([args]) => args.includes('fetch') && args.includes('origin'));
  for (const [args, timeoutMs, opts] of [clone, fetch]) {
    assert.equal(timeoutMs, 0);
    assert.equal(opts.idleMs, sync.NETWORK_IDLE_MS);
    assert.ok(args.includes('--progress'));
  }
});

test('withLock', async (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const lockFile = path.join(root, 'sub', 'x.lock');

  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, 'other');
  let called = false;
  assert.deepEqual(await sync.withLock({ lockFile }, () => { called = true; }), { kind: 'busy' });
  assert.equal(called, false);
  fs.rmSync(lockFile);

  assert.equal(await sync.withLock({ lockFile }, async () => 42), 42);
  assert.ok(!fs.existsSync(lockFile));

  await assert.rejects(
    sync.withLock({ lockFile }, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.ok(!fs.existsSync(lockFile));

  // the heartbeat keeps a long operation from being taken for a stale lock
  await sync.withLock({ lockFile, heartbeatMs: 20 }, async () => {
    const hourAgo = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(lockFile, hourAgo, hourAgo);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(Date.now() - fs.statSync(lockFile).mtimeMs < 5000);
  });
});

test('withLockSync', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const lockFile = path.join(root, 'x.lock');
  fs.writeFileSync(lockFile, 'other');
  assert.deepEqual(sync.withLockSync(lockFile, () => 1), { kind: 'busy' });
  fs.rmSync(lockFile);
  assert.deepEqual(sync.withLockSync(lockFile, () => 7), { kind: 'done', value: 7 });
  assert.ok(!fs.existsSync(lockFile));
  assert.throws(
    () =>
      sync.withLockSync(lockFile, () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  assert.ok(!fs.existsSync(lockFile));
});

test('discard is busy while the lock is held', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'a.md', 'local\n');
  fs.writeFileSync(f.args.lockFile, 'other');
  const d = await sync.discardLocalChanges({ run: f.args.run, managedRepo: f.clone, lockFile: f.args.lockFile });
  assert.equal(d.ok, false);
  assert.equal(d.busy, true);
  assert.equal(typeof d.message, 'string');
  assert.equal(f.read('a.md'), 'local\n');
});

// run that answers `git version` with `text` (the real run for everything else)
function withGitVersion(run, text) {
  return (args, cwd, timeoutMs, opts) =>
    args[args.length - 1] === 'version' ? Promise.resolve({ code: 0, stdout: text, stderr: '' }) : run(args, cwd, timeoutMs, opts);
}

test('a new team commit changes the conflict upstream', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  writeFile(f.clone, 'f.md', lines(1, 'local1'));
  pushCommit(f.work, 'f.md', lines(1, 'team1'), 'team f');
  const first = await sync.syncManaged(f.args);
  assert.equal(first.kind, 'conflict');
  pushCommit(f.work, 'other.md', 'x\n', 'team other');
  const second = await sync.syncManaged(f.args);
  assert.equal(second.kind, 'conflict');
  assert.equal(second.head, first.head);
  assert.notEqual(second.upstream, first.upstream);
  assert.equal(second.upstream, git(['rev-parse', 'HEAD'], f.work));
});

test('gitVersionOf', () => {
  assert.deepEqual(sync.gitVersionOf('git version 2.47.0.windows.1'), [2, 47, 0]);
  assert.deepEqual(sync.gitVersionOf('git version 2.38'), [2, 38, 0]);
  assert.deepEqual(sync.gitVersionOf('git version 1.9.5'), [1, 9, 5]);
  assert.equal(sync.gitVersionOf('nope'), null);
});

test('an old git is reported before an update', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setupFiles(t);
  const head = git(['rev-parse', 'HEAD'], f.clone);
  pushCommit(f.work, 'other.md', 'x\n', 'team other');
  const old = await sync.syncManaged({ ...f.args, run: withGitVersion(f.args.run, 'git version 2.37.1') });
  assert.equal(old.kind, 'error');
  assert.match(old.message, /git 2\.38 or later/);
  assert.match(old.message, /2\.37\.1/);
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), head);
  const ok = await sync.syncManaged({ ...f.args, run: withGitVersion(f.args.run, 'git version 2.38.0') });
  assert.equal(ok.kind, 'updated');
});

test('recentlySynced', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const min = 60000;
  const at = (offset) => new Date(now + offset).toISOString();
  const every = 60 * min;
  assert.equal(sync.recentlySynced(null, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'upToDate', at: at(-10 * min) }, every, now), true);
  assert.equal(sync.recentlySynced({ kind: 'upToDate', at: at(-40 * min) }, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'conflict', at: at(-1 * min) }, every, now), true);
  assert.equal(sync.recentlySynced({ kind: 'error', at: at(-1 * min) }, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'busy', at: at(-1 * min) }, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'offline', at: at(-1 * min) }, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'upToDate', at: at(5 * min) }, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'upToDate', at: 'x' }, every, now), false);
  assert.equal(sync.recentlySynced({ kind: 'upToDate' }, every, now), false);
});

test('a vanished lock is tried again, never deleted', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const lock = path.join(root, 'x.lock');
  fs.writeFileSync(lock, 'third window');
  const real = fs.statSync;
  let thrown = false;
  fs.statSync = (p, ...rest) => {
    if (!thrown && path.resolve(String(p)) === path.resolve(lock)) {
      thrown = true;
      const err = new Error('ENOENT: no such file or directory');
      err.code = 'ENOENT';
      throw err;
    }
    return real(p, ...rest);
  };
  try {
    assert.equal(sync.acquireLock(lock), false);
  } finally {
    fs.statSync = real;
  }
  assert.ok(thrown);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'third window');
});

test('an interrupted url switch is completed by the next sync', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  assert.equal((await sync.syncManaged(f.args)).kind, 'cloned');
  const other = makeOrigin(f.root, 'other');
  pushCommit(other.work, 'p/other.txt', 'other', 'other commit'); // a history of its own: the switch moves the branch
  let failed = false;
  const run = (args, cwd, timeoutMs, opts) => {
    if (!failed && args.includes('set-url')) {
      failed = true;
      return Promise.resolve({ code: 1, stdout: '', stderr: 'simulated failure' });
    }
    return f.args.run(args, cwd, timeoutMs, opts);
  };
  const args = { ...f.args, run, repoUrl: other.origin };
  const first = await sync.syncManaged(args);
  assert.equal(first.kind, 'error');
  assert.ok(failed);
  const second = await sync.syncManaged(args);
  assert.equal(second.kind, 'switched');
  assert.equal(git(['remote', 'get-url', 'origin'], clone), other.origin);
  assert.equal(refsOf(clone, 'refs/team-plugins'), '');
  assert.equal(git(['rev-parse', 'HEAD'], clone), git(['rev-parse', 'HEAD'], other.work));
});

test('localChanges reports a failing status', async (t) => {
  const run = (args) =>
    Promise.resolve(
      args.includes('status') ? { code: 128, stdout: '', stderr: 'fatal: boom' } : { code: 0, stdout: '0', stderr: '' },
    );
  await assert.rejects(sync.localChanges({ run, repo: 'x' }), /git status failed: fatal: boom/);
});

test('headFileArgs serves only HEAD of the managed clone', (t) => {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const M = path.join(root, 'store', 'repo');
  const ok = ['show', 'HEAD:p/skills/s/SKILL.md'];
  const req = (extra) => ({ repo: M, rev: 'HEAD', path: 'p/skills/s/SKILL.md', ...extra });
  assert.deepEqual(sync.headFileArgs(req(), M), ok);
  assert.deepEqual(sync.headFileArgs(req({ repo: M + path.sep }), M), ok);
  assert.deepEqual(sync.headFileArgs(req({ repo: path.join(M, '.') }), M), ok);
  assert.equal(sync.headFileArgs(req({ rev: '--output=x' }), M), null);
  assert.equal(sync.headFileArgs(req({ rev: '' }), M), null);
  assert.equal(sync.headFileArgs(req({ rev: 'HEAD~1' }), M), null);
  assert.equal(sync.headFileArgs(req({ repo: path.join(root, 'other') }), M), null);
  assert.equal(sync.headFileArgs(req({ path: '' }), M), null);
  assert.equal(sync.headFileArgs(req({ path: 5 }), M), null);
  assert.equal(sync.headFileArgs(null, M), null);
});

test('a missing branch at the first clone is reported', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const r = await sync.syncManaged({ ...f.args, branch: 'nope' });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'branchNotFound');
  assert.ok(!fs.existsSync(f.args.managedRepo));
  const parent = path.dirname(f.args.managedRepo);
  assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith('repo.tmp-')), []);
});

test('a branch deleted on the server is reported and changes nothing', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const clone = f.args.managedRepo;
  pushDev(f);
  assert.equal((await sync.syncManaged({ ...f.args, branch: 'dev' })).kind, 'cloned');
  const before = git(['rev-parse', 'HEAD'], clone);
  git(['push', 'origin', ':dev'], f.work);
  const r = await sync.syncManaged({ ...f.args, branch: 'dev' });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'branchNotFound');
  assert.ok(r.message.startsWith('branch dev not found on'), r.message);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], clone), 'dev');
  assert.equal(git(['rev-parse', 'HEAD'], clone), before);
});

test('an unreachable server is offline and changes nothing', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const dead = 'http://127.0.0.1:1/team.git';
  const f = setup(t);
  let r = await sync.syncManaged({ ...f.args, repoUrl: dead });
  assert.equal(r.kind, 'offline');
  assert.equal(r.reason, 'unreachable');
  assert.ok(!fs.existsSync(f.args.managedRepo));
  const parent = path.dirname(f.args.managedRepo);
  assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith('repo.tmp-')), []);

  assert.equal((await sync.syncManaged(f.args)).kind, 'cloned');
  const clone = f.args.managedRepo;
  const before = git(['rev-parse', 'HEAD'], clone);
  git(['remote', 'set-url', 'origin', dead], clone);
  r = await sync.syncManaged({ ...f.args, repoUrl: dead, branch: 'main' });
  assert.equal(r.kind, 'offline');
  assert.equal(git(['rev-parse', 'HEAD'], clone), before);
  assert.equal(JSON.parse(fs.readFileSync(f.args.stateFile, 'utf8')).kind, 'offline');
});

test('checkRemote', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = setup(t);
  const base = { run: f.args.run, cwd: f.root };
  assert.deepEqual(await sync.checkRemote({ ...base, repoUrl: f.origin }), {
    kind: 'reachable',
    defaultBranch: 'main',
    empty: false,
  });
  assert.equal((await sync.checkRemote({ ...base, repoUrl: f.origin, branch: 'main' })).kind, 'reachable');
  let r = await sync.checkRemote({ ...base, repoUrl: f.origin, branch: 'nope' });
  assert.equal(r.reason, 'branchNotFound');
  r = await sync.checkRemote({ ...base, repoUrl: fwd(path.join(f.root, 'missing.git')) });
  assert.equal(r.reason, 'notFound');
  r = await sync.checkRemote({ ...base, repoUrl: 'http://127.0.0.1:1/team.git' });
  assert.equal(r.kind, 'offline');
  const empty = path.join(f.root, 'empty.git');
  fs.mkdirSync(empty);
  git(['init', '--bare', '-b', 'main'], empty);
  assert.deepEqual(await sync.checkRemote({ ...base, repoUrl: fwd(empty) }), {
    kind: 'reachable',
    defaultBranch: '',
    empty: true,
  });
});
