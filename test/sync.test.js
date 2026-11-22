'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeGit } = require('../lib/git');
const sync = require('../lib/sync');
const { tmpDir, rmDir, writeFile, makePlugin, git, gitAvailable, commitAll, IDENTITY } = require('./helpers');

const fwd = (p) => p.replace(/\\/g, '/');

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
    run: makeGit('git'),
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

test('sync lifecycle: clone, upToDate, updated, dirty, discard, diverged', async (t) => {
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
  assert.equal(r.from, sha0);
  assert.equal(r.to, sha1);
  assert.equal(git(['rev-parse', 'HEAD'], args.managedRepo), sha1);
  const log = await sync.changesBetween({ run: args.run, repoDir: args.managedRepo, from: r.from, to: r.to });
  assert.ok(log.includes('second commit'));

  fs.appendFileSync(path.join(args.managedRepo, 'p', 'notes.txt'), ' local edit');
  pushCommit(f.work, 'p/other.txt', 'two', 'third commit');
  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'dirty');
  assert.equal(r.behind, 1);
  assert.equal(r.head, sha1);
  assert.equal(git(['rev-parse', 'HEAD'], args.managedRepo), sha1);

  const d = await sync.discardLocalChanges({ run: args.run, managedRepo: args.managedRepo });
  assert.equal(d.ok, true);
  // the reset goes to the already fetched upstream: a commit pushed after it is what the next sync updates to
  pushCommit(f.work, 'p/after-discard.txt', 'x', 'after discard');
  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'updated');

  writeFile(args.managedRepo, 'p/local.txt', 'local');
  git(['add', '-A'], args.managedRepo);
  git([...IDENTITY, 'commit', '-m', 'local commit'], args.managedRepo);
  pushCommit(f.work, 'p/fourth.txt', 'four', 'fourth commit');
  r = await sync.syncManaged(args);
  assert.equal(r.kind, 'diverged');
  assert.equal(r.ahead, 1);
  assert.equal(r.behind, 1);
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
