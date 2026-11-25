'use strict';

// The remote cases that need no Cursor: real git against a fake ssh (core.sshCommand) and a `git http-backend` server
// on 127.0.0.1. Git is kept away from the user's configuration (see isolateGit). The server runs in this process: only
// async git (makeGit) may talk to it, a synchronous one would block the event loop and deadlock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeGit } = require('../lib/git');
const sync = require('../lib/sync');
const { commitAndPush, pushToBranch } = require('../lib/contribute');
const { tmpDir, rmDir, writeFile, gitAvailable } = require('./helpers');
const {
  fakeSshCommand,
  isolateGit,
  withConfig,
  credentialHelper,
  waitGone,
  makeServedRepo,
  startGitServer,
} = require('./remote-helpers');

const SSH_URL = 'git@example.test:team/plugins.git';
const IDENTITY = ['user.name=test', 'user.email=test@example.com', 'commit.gpgsign=false'];

const home = tmpDir();
isolateGit(home);
test.after(() => rmDir(home));

// A temporary folder removed (after the cleanups, in reverse order) when the test ends.
function fixture(t) {
  const dir = tmpDir();
  const cleanups = [() => rmDir(dir)];
  t.after(async () => {
    for (const fn of cleanups.reverse()) {
      await fn();
    }
  });
  return { dir, onEnd: (fn) => cleanups.push(fn) };
}

function sshRun(mode) {
  return withConfig(makeGit('git'), ['ssh.variant=ssh', `core.sshCommand=${fakeSshCommand(mode)}`]);
}

function setPidFile(t, file) {
  const before = process.env.FAKE_SSH_PID_FILE;
  process.env.FAKE_SSH_PID_FILE = file;
  t.after(() => {
    if (before === undefined) {
      delete process.env.FAKE_SSH_PID_FILE;
    } else {
      process.env.FAKE_SSH_PID_FILE = before;
    }
  });
}

// a served repository, its server and a runner that has the right credentials
async function served(t, opts = {}) {
  const fx = fixture(t);
  const root = path.join(fx.dir, 'served');
  const bare = makeServedRepo(root);
  const server = await startGitServer({ root, ...opts });
  fx.onEnd(() => server.close());
  const run = withConfig(makeGit('git'), [credentialHelper('u', 'p')]);
  const sargs = (extra = {}) => ({
    run,
    managedRepo: path.join(fx.dir, 'repos', 'm'),
    repoUrl: server.url('team.git'),
    branch: '',
    lockFile: path.join(fx.dir, 'l.lock'),
    stateFile: path.join(fx.dir, 's.json'),
    ...extra,
  });
  return { ...fx, root, bare, server, run, sargs, url: (name = 'team.git') => server.url(name) };
}

function protectMain(bare) {
  const hook =
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "error: main is protected" >&2; exit 1; fi\ndone\nexit 0\n';
  writeFile(bare, 'hooks/pre-receive', hook);
  fs.chmodSync(path.join(bare, 'hooks', 'pre-receive'), 0o755);
}

test('ssh: an unknown host key', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { dir } = fixture(t);
  const r = await sync.checkRemote({ run: sshRun('unknown'), cwd: dir, repoUrl: SSH_URL });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'hostKeyUnknown');
  assert.deepEqual(r.actions, ['terminal', 'retry']);
  assert.ok(r.message.includes('example.test'), r.message);
});

test('ssh: a changed host key', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { dir } = fixture(t);
  const r = await sync.checkRemote({ run: sshRun('changed'), cwd: dir, repoUrl: SSH_URL });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'hostKeyChanged');
  assert.deepEqual(r.actions, ['showLog']);
});

test('ssh: login refused', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { dir } = fixture(t);
  const r = await sync.checkRemote({ run: sshRun('auth'), cwd: dir, repoUrl: SSH_URL });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'sshAuth');
  assert.deepEqual(r.actions, ['terminal', 'retry']);
});

test('ssh: a silent ssh is stopped, with its process', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { dir } = fixture(t);
  const pidFile = path.join(dir, 'pid');
  setPidFile(t, pidFile);
  const r = await sync.checkRemote({ run: sshRun('silent'), cwd: dir, repoUrl: SSH_URL, idleMs: 1500 });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'timeout');
  assert.ok(r.message.includes('for 2 s'), r.message);
  assert.ok(fs.existsSync(pidFile));
  assert.equal(await waitGone(Number(fs.readFileSync(pidFile, 'utf8'))), true);
});

test('ssh: a silent ssh during the first clone leaves nothing behind', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { dir } = fixture(t);
  const pidFile = path.join(dir, 'pid');
  setPidFile(t, pidFile);
  const managedRepo = path.join(dir, 'repos', 'm');
  const lockFile = path.join(dir, 'l.lock');
  const r = await sync.syncManaged({
    run: sshRun('silent'),
    managedRepo,
    repoUrl: SSH_URL,
    branch: 'main',
    lockFile,
    stateFile: path.join(dir, 's.json'),
    idleMs: 1500,
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'timeout');
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'repos')).filter((n) => n.startsWith('m.tmp-')),
    [],
  );
  assert.ok(!fs.existsSync(managedRepo));
  assert.ok(!fs.existsSync(lockFile));
  assert.equal(await waitGone(Number(fs.readFileSync(pidFile, 'utf8'))), true);
});

test('http: no stored credentials', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t);
  const r = await sync.checkRemote({ run: makeGit('git'), cwd: s.dir, repoUrl: s.url() });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'credentials');
  assert.deepEqual(r.actions, ['terminal', 'retry']);
});

test('http: refused credentials', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t);
  const run = withConfig(makeGit('git'), [credentialHelper('u', 'wrong')]);
  const r = await sync.checkRemote({ run, cwd: s.dir, repoUrl: s.url() });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'authFailed');
});

test('http: a wrong URL', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t);
  const r = await sync.checkRemote({ run: s.run, cwd: s.dir, repoUrl: s.url('missing.git') });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'notFound');
  assert.deepEqual(r.actions, ['repositories', 'showLog']);
});

test('http: a wrong branch', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t);
  const check = await sync.checkRemote({ run: s.run, cwd: s.dir, repoUrl: s.url(), branch: 'nope' });
  assert.equal(check.kind, 'error');
  assert.equal(check.reason, 'branchNotFound');
  const args = s.sargs({ branch: 'nope' });
  const r = await sync.syncManaged(args);
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'branchNotFound');
  assert.ok(!fs.existsSync(args.managedRepo));
});

test('an unreachable server is offline', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const { dir } = fixture(t);
  const r = await sync.checkRemote({ run: makeGit('git'), cwd: dir, repoUrl: 'http://127.0.0.1:1/team.git' });
  assert.equal(r.kind, 'offline');
  assert.equal(r.reason, 'unreachable');
  assert.deepEqual(r.actions, ['retry']);
});

test('http: a valid repository is checked, cloned and updated', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t);
  const check = await sync.checkRemote({ run: s.run, cwd: s.dir, repoUrl: s.url() });
  assert.deepEqual(check, { kind: 'reachable', defaultBranch: 'main', empty: false });
  const args = s.sargs();
  assert.equal((await sync.syncManaged(args)).kind, 'cloned');
  const work = path.join(s.dir, 'work');
  assert.equal((await s.run(['clone', s.url(), work], s.dir)).code, 0);
  writeFile(work, 'b.txt', 'b\n');
  const identity = IDENTITY.flatMap((p) => ['-c', p]);
  assert.equal((await s.run(['add', '-A'], work)).code, 0);
  assert.equal((await s.run([...identity, 'commit', '-m', 'second'], work)).code, 0);
  assert.equal((await s.run(['push', 'origin', 'HEAD:main'], work)).code, 0);
  const again = await sync.syncManaged(args);
  assert.equal(again.kind, 'updated');
  assert.equal(again.commits, 1);
});

test('http: a push refused by a server rule', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t);
  protectMain(s.bare);
  const args = s.sargs();
  assert.equal((await sync.syncManaged(args)).kind, 'cloned');
  writeFile(args.managedRepo, 'a.txt', 'mine\n');
  const push = {
    run: s.run,
    repo: args.managedRepo,
    message: 'x',
    lockFile: args.lockFile,
    stateFile: args.stateFile,
    repoUrl: args.repoUrl,
  };
  const r = await commitAndPush(push);
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'push');
  assert.equal(r.reason, 'pushRejected');
  assert.ok(r.message.includes('main is protected'), r.message);
  const b = await pushToBranch({ ...push, branch: 'live/x' });
  assert.equal(b.kind, 'pushedBranch');
});

test('http: a push denied by a read-only server', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const s = await served(t, { readOnly: true });
  const args = s.sargs();
  assert.equal((await sync.syncManaged(args)).kind, 'cloned');
  writeFile(args.managedRepo, 'a.txt', 'mine\n');
  const r = await commitAndPush({
    run: s.run,
    repo: args.managedRepo,
    message: 'x',
    lockFile: args.lockFile,
    stateFile: args.stateFile,
    repoUrl: args.repoUrl,
  });
  assert.equal(r.kind, 'error');
  assert.equal(r.reason, 'denied');
  assert.deepEqual(r.actions, ['pushToBranch', 'showLog']);
});
