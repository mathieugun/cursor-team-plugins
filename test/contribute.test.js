'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeGit } = require('../lib/git');
const sync = require('../lib/sync');
const { defaultBranchName, commitAndPush, pushToBranch } = require('../lib/contribute');
const { tmpDir, rmDir, writeFile, git, gitAvailable, commitAll } = require('./helpers');

const fwd = (p) => p.replace(/\\/g, '/');
const EIGHT = '1\n2\n3\n4\n5\n6\n7\n8\n';
const withLine = (n, text) => EIGHT.split('\n').map((l) => (l === String(n) ? text : l)).join('\n');

// git with an identity, whatever the machine's configuration
const OPTS = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
function makeRun() {
  const run = makeGit('git');
  return (args, cwd, timeoutMs, opts) => run([...OPTS, ...args], cwd, timeoutMs, opts);
}

// bare origin, a work clone of it (the team's) and a synced managed clone
async function setup(t) {
  const root = tmpDir();
  t.after(() => rmDir(root));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(origin);
  git(['init', '--bare', '-b', 'main'], origin);
  fs.mkdirSync(work);
  git(['init', '-b', 'main'], work);
  git(['config', 'core.autocrlf', 'false'], work);
  writeFile(work, 'f.md', EIGHT);
  writeFile(work, 'g.md', 'g\n');
  commitAll(work, 'initial');
  git(['remote', 'add', 'origin', fwd(origin)], work);
  git(['push', '-u', 'origin', 'main'], work);
  const store = path.join(root, 'store');
  const run = makeRun();
  const sargs = {
    run,
    managedRepo: path.join(store, 'repo'),
    repoUrl: fwd(origin),
    branch: '',
    lockFile: path.join(store, 'sync.lock'),
    stateFile: path.join(store, 'sync-state.json'),
  };
  assert.equal((await sync.syncManaged(sargs)).kind, 'cloned');
  const clone = sargs.managedRepo;
  git(['config', 'core.autocrlf', 'false'], clone);
  const args = { run, repo: clone, lockFile: sargs.lockFile, stateFile: sargs.stateFile, message: 'my change' };
  const teamPush = (file, text, message) => {
    writeFile(work, file, text);
    commitAll(work, message);
    git(['push', 'origin', 'main'], work);
  };
  return { root, origin: origin, work, clone, args, sargs, teamPush, run };
}

test('nothing to push on a clean clone', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  assert.deepEqual(await commitAndPush(f.args), { kind: 'nothing' });
});

test('commitAndPush commits files and pushes them', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  writeFile(f.clone, 'skills/new/SKILL.md', 'new\n');
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'pushed');
  assert.equal(r.branch, 'main');
  assert.equal(r.commits, 1);
  assert.equal(git(['log', '-1', '--format=%s', 'main'], f.origin), 'my change');
  assert.equal(git(['status', '--porcelain'], f.clone), '');
  const state = JSON.parse(fs.readFileSync(f.args.stateFile, 'utf8'));
  assert.equal(state.kind, 'upToDate');
  assert.equal(state.head, r.head);
  assert.equal(r.head, git(['rev-parse', 'HEAD'], f.clone));
});

test('commitAndPush pushes an unpushed local commit', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'g.md', 'mine\n');
  git(['add', '-A'], f.clone);
  git([...OPTS, 'commit', '-m', 'earlier'], f.clone);
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'pushed');
  assert.equal(r.commits, 1);
  assert.equal(git(['log', '-1', '--format=%s', 'main'], f.origin), 'earlier');
});

test('commitAndPush rebases on team commits to other files', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  f.teamPush('g.md', 'team\n', 'team g');
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'pushed');
  assert.deepEqual(git(['log', '-2', '--format=%s', 'main'], f.origin).split('\n'), ['my change', 'team g']);
});

test('commitAndPush reports a conflict and keeps the commit', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  const before = git(['rev-parse', 'main'], f.origin);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  f.teamPush('f.md', withLine(1, 'team'), 'team f');
  const teamHead = git(['rev-parse', 'main'], f.origin);
  assert.notEqual(teamHead, before);
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'conflict');
  assert.deepEqual(r.files, ['f.md']);
  assert.equal(git(['log', '-1', '--format=%s'], f.clone), 'my change');
  assert.equal(git(['rev-parse', 'main'], f.origin), teamHead);
  assert.ok(!fs.existsSync(path.join(f.clone, '.git', 'rebase-merge')));
});

test('commitAndPush reports a rejected push', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.origin, 'hooks/pre-receive', '#!/bin/sh\nexit 1\n');
  fs.chmodSync(path.join(f.origin, 'hooks', 'pre-receive'), 0o755);
  writeFile(f.clone, 'g.md', 'mine\n');
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'push');
  assert.ok(r.message.startsWith('git push failed'));
});

test('commitAndPush is busy while the lock is held', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  fs.writeFileSync(f.args.lockFile, 'other');
  assert.deepEqual(await commitAndPush(f.args), { kind: 'busy' });
});

test('commitAndPush is not blocked by a stale index.lock', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  const lock = path.join(f.clone, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 2 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'pushed');
  assert.ok(!fs.existsSync(lock));
});

test('defaultBranchName', () => {
  assert.equal(defaultBranchName('Jane D.', new Date(2026, 10, 22, 14, 5)), 'team-plugins/jane-d-20261122-1405');
  assert.equal(defaultBranchName('', new Date(2026, 0, 2, 3, 4)), 'team-plugins/20260102-0304');
});

test('pushToBranch gets out of a conflict', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  f.teamPush('f.md', withLine(1, 'team'), 'team f');
  const s = await sync.syncManaged(f.sargs);
  assert.equal(s.kind, 'conflict');
  const r = await pushToBranch({ ...f.args, message: 'mine', branch: 'team-plugins/t1' });
  assert.equal(r.kind, 'pushedBranch');
  assert.equal(r.branch, 'team-plugins/t1');
  assert.equal(r.remote, 'origin');
  assert.equal(git(['log', '-1', '--format=%s', 'team-plugins/t1'], f.origin), 'mine');
  assert.equal(git(['show', 'team-plugins/t1:f.md'], f.origin).split('\n')[0], 'mine');
  assert.equal(git(['status', '--porcelain'], f.clone), '');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), git(['rev-parse', '@{u}'], f.clone));
  assert.equal(JSON.parse(fs.readFileSync(f.args.stateFile, 'utf8')).kind, 'upToDate');
  // the reset went to the upstream as of the last fetch: a new team commit is what the next sync updates to
  f.teamPush('g.md', 'team again\n', 'team g');
  assert.equal((await sync.syncManaged(f.sargs)).kind, 'updated');
});

test('pushToBranch refuses bad or taken branch names and has nothing to push on a clean clone', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'g.md', 'mine\n');
  let r = await pushToBranch({ ...f.args, branch: 'main' });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'branch');
  assert.ok(r.message.includes('already exists'));
  r = await pushToBranch({ ...f.args, branch: 'bad..name' });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'branch');
  assert.ok(r.message.startsWith('invalid branch name'));
  git(['checkout', '--', 'g.md'], f.clone);
  r = await pushToBranch({ ...f.args, branch: 'team-plugins/clean' });
  assert.deepEqual(r, { kind: 'nothing' });
});

test('commitAndPush reports an old git', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  f.teamPush('f.md', withLine(1, 'team'), 'team f');
  const run = (args, cwd, timeoutMs, opts) =>
    args[args.length - 1] === 'version'
      ? Promise.resolve({ code: 0, stdout: 'git version 2.37.1', stderr: '' })
      : f.run(args, cwd, timeoutMs, opts);
  const r = await commitAndPush({ ...f.args, run });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'conflicts');
  assert.match(r.message, /git 2\.38 or later/);
});

test('a failing status is an error, not "nothing"', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  const run = (args, cwd, timeoutMs, opts) =>
    args.includes('status')
      ? Promise.resolve({ code: 128, stdout: '', stderr: 'fatal: boom' })
      : f.run(args, cwd, timeoutMs, opts);
  let r = await commitAndPush({ ...f.args, run });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'status');
  assert.match(r.message, /git status failed/);
  r = await pushToBranch({ ...f.args, run, branch: 'dev/mine' });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'status');
  assert.match(r.message, /git status failed/);
});
