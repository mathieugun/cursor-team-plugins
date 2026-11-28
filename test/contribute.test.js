'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { makeGit } = require('../lib/git');
const { caseInsensitive } = require('../lib/materialize');
const sync = require('../lib/sync');
const { defaultBranchName, commitAndPush, pushToBranch, IDENTITY_MESSAGE } = require('../lib/contribute');
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
    stateFile: path.join(store, 'state.json'),
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
  const hook = '#!/bin/sh\necho "GitLab: You are not allowed to push code to protected branches on this project." >&2\nexit 1\n';
  writeFile(f.origin, 'hooks/pre-receive', hook);
  fs.chmodSync(path.join(f.origin, 'hooks', 'pre-receive'), 0o755);
  writeFile(f.clone, 'g.md', 'mine\n');
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'push');
  assert.equal(r.reason, 'pushRejected');
  assert.ok(r.actions.includes('pullRequest'));
  assert.ok(r.message.includes('You are not allowed to push code to protected branches'), r.message);
});

test('a push refused on main goes through Push to a branch', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  const hook =
    '#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "protected branch" >&2; exit 1; fi\n  echo "     https://git.example.test/o/r/pull/new/${ref#refs/heads/}" >&2\ndone\nexit 0\n';
  writeFile(f.origin, 'hooks/pre-receive', hook);
  fs.chmodSync(path.join(f.origin, 'hooks', 'pre-receive'), 0o755);
  writeFile(f.clone, 'g.md', 'mine\n');
  const r = await commitAndPush(f.args);
  assert.equal(r.reason, 'pushRejected');
  const b = await pushToBranch({ ...f.args, branch: 'team-plugins/x', message: 'mine' });
  assert.equal(b.kind, 'pushedBranch');
  assert.ok(git(['rev-parse', 'team-plugins/x'], f.origin));
  assert.equal(b.target, 'main');
  assert.deepEqual(b.pullRequest, { url: 'https://git.example.test/o/r/pull/new/team-plugins/x', target: null });
});

test('pushToBranch reports a refused new branch', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.origin, 'hooks/pre-receive', '#!/bin/sh\necho "branch names must start with feature/" >&2\nexit 1\n');
  fs.chmodSync(path.join(f.origin, 'hooks', 'pre-receive'), 0o755);
  writeFile(f.clone, 'g.md', 'mine\n');
  const r = await pushToBranch({ ...f.args, branch: 'team-plugins/y', message: 'mine' });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'push');
  assert.equal(r.reason, 'pushRejected');
  assert.deepEqual(r.actions, ['pushToBranch', 'showLog']);
  assert.ok(r.message.includes('the server refused the new branch team-plugins/y'), r.message);
});

test('commitAndPush reports an unreachable server', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  git(['remote', 'set-url', 'origin', 'http://127.0.0.1:1/x.git'], f.clone);
  writeFile(f.clone, 'g.md', 'mine\n');
  const r = await commitAndPush(f.args);
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'fetch');
  assert.equal(r.reason, 'unreachable');
});

test('a push and a fetch that fail never leak the credentials of the URL', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  const secretUrl = 'https://user:secret@127.0.0.1:9/team.git';
  // the wording of an older git, which repeats the URL with its user info
  const stderr = `fatal: unable to access '${secretUrl}/': Could not connect to server`;
  const logLines = [];
  const failing = (names) => (args, cwd, timeoutMs, opts) => {
    const name = args.find((a) => names.includes(a));
    if (name) {
      return Promise.resolve({ code: 128, stdout: '', stderr });
    }
    return f.run(args, cwd, timeoutMs, opts);
  };
  const common = { ...f.args, repoUrl: secretUrl, log: (line) => logLines.push(line) };
  writeFile(f.clone, 'g.md', 'mine\n');
  const results = [await commitAndPush({ ...common, run: failing(['fetch']) })];
  assert.equal(results[0].step, 'fetch');
  assert.equal(results[0].reason, 'unreachable');
  results.push(await commitAndPush({ ...common, run: failing(['push']) }));
  assert.equal(results[1].step, 'push');
  // the commit of the first failed push is already made: push it to a branch, failing the same way
  results.push(await pushToBranch({ ...common, run: failing(['push']), branch: 'team-plugins/leak' }));
  assert.equal(results[2].step, 'push');
  results.push(await pushToBranch({ ...common, run: failing(['ls-remote']), branch: 'team-plugins/leak2' }));
  assert.equal(results[3].step, 'branch');
  for (const r of results) {
    assert.ok(!JSON.stringify(r).includes('secret'), JSON.stringify(r));
  }
  assert.ok(logLines.length > 0);
  assert.ok(!logLines.join('\n').includes('secret'), logLines.join('\n'));
  // a failed push or fetch writes no state file (only a successful one does, with no message): nothing more to check
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
  assert.equal(r.pullRequest, null);
  assert.equal(git(['log', '-1', '--format=%s', 'team-plugins/t1'], f.origin), 'mine');
  assert.equal(git(['show', 'team-plugins/t1:f.md'], f.origin).split('\n')[0], 'mine');
  assert.equal(git(['status', '--porcelain'], f.clone), '');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), git(['rev-parse', '@{u}'], f.clone));
  assert.equal(JSON.parse(fs.readFileSync(f.args.stateFile, 'utf8')).kind, 'upToDate');
  // the reset went to the upstream as of the last fetch: a new team commit is what the next sync updates to
  f.teamPush('g.md', 'team again\n', 'team g');
  assert.equal((await sync.syncManaged(f.sargs)).kind, 'updated');
});

// f.run, plus `after()` once the first successful `push` returns
function writeAfterPush(f, after) {
  let done = false;
  return async (args, cwd, timeoutMs, opts) => {
    const r = await f.run(args, cwd, timeoutMs, opts);
    if (!done && args[0] === 'push' && r.code === 0) {
      done = true;
      after();
    }
    return r;
  };
}

test('pushToBranch keeps an edit and a new file saved during the push', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  const run = writeAfterPush(f, () => {
    writeFile(f.clone, 'g.md', 'later\n');
    writeFile(f.clone, 'new.md', 'new\n');
  });
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t3' });
  assert.equal(r.kind, 'pushedBranch');
  assert.equal(r.resetSkipped, undefined);
  assert.equal(fs.readFileSync(path.join(f.clone, 'f.md'), 'utf8'), EIGHT);
  assert.equal(fs.readFileSync(path.join(f.clone, 'g.md'), 'utf8'), 'later\n');
  assert.equal(fs.readFileSync(path.join(f.clone, 'new.md'), 'utf8'), 'new\n');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), git(['rev-parse', '@{u}'], f.clone));
  const status = git(['status', '--porcelain'], f.clone)
    .split('\n')
    .map((l) => l.trim())
    .sort();
  assert.deepEqual(status, ['?? new.md', 'M g.md']);
  assert.equal(git(['show', 'team-plugins/t3:f.md'], f.origin).split('\n')[0], 'mine');
  assert.deepEqual(git(['ls-tree', '--name-only', 'team-plugins/t3'], f.origin).split('\n'), ['f.md', 'g.md']);
});

test('pushToBranch leaves the clone as it is when a pushed file changed during the push', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  const run = writeAfterPush(f, () => writeFile(f.clone, 'f.md', withLine(1, 'again')));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t4' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['f.md']);
  assert.ok(r.resetSkipped.message.includes('f.md'), r.resetSkipped.message);
  assert.equal(fs.readFileSync(path.join(f.clone, 'f.md'), 'utf8'), withLine(1, 'again'));
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
  assert.equal(git(['show', 'team-plugins/t4:f.md'], f.origin).split('\n')[0], 'mine');
});

test('pushToBranch leaves the clone as it is when a new file would be overwritten', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  fs.rmSync(path.join(f.clone, 'g.md'));
  const run = writeAfterPush(f, () => writeFile(f.clone, 'g.md', 'mine\n'));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t5' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['g.md']);
  assert.equal(fs.readFileSync(path.join(f.clone, 'g.md'), 'utf8'), 'mine\n');
});

test('pushToBranch leaves the clone as it is when an ignored file would be overwritten', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  fs.rmSync(path.join(f.clone, 'g.md'));
  writeFile(f.clone, '.gitignore', 'g.md\n');
  const run = writeAfterPush(f, () => writeFile(f.clone, 'g.md', 'mine\n'));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t6' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['g.md']);
  assert.ok(r.resetSkipped.message.includes('ignored files would be overwritten'), r.resetSkipped.message);
  assert.equal(fs.readFileSync(path.join(f.clone, 'g.md'), 'utf8'), 'mine\n');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
});

test('pushToBranch leaves the clone as it is when an ignored folder holds the path of a file it would restore', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  fs.rmSync(path.join(f.clone, 'g.md'));
  writeFile(f.clone, '.gitignore', 'g.md\n');
  const run = writeAfterPush(f, () => writeFile(f.clone, 'g.md/notes.txt', 'notes\n'));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t8' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['g.md']);
  assert.equal(fs.readFileSync(path.join(f.clone, 'g.md', 'notes.txt'), 'utf8'), 'notes\n');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
});

test('pushToBranch leaves the clone as it is when an ignored file holds a folder of a path it would restore', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  f.teamPush('cache/item.txt', 'team\n', 'team cache');
  assert.equal((await sync.syncManaged(f.sargs)).kind, 'updated');
  fs.rmSync(path.join(f.clone, 'cache'), { recursive: true });
  writeFile(f.clone, '.gitignore', 'cache\n');
  const run = writeAfterPush(f, () => writeFile(f.clone, 'cache', 'mine\n'));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t9' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['cache/item.txt']);
  assert.equal(fs.readFileSync(path.join(f.clone, 'cache'), 'utf8'), 'mine\n');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
});

test('pushToBranch compares the ignored files without case where git does', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  const ignoreCase = spawnSync('git', ['config', '--bool', 'core.ignorecase'], { cwd: f.clone, encoding: 'utf8' });
  if (ignoreCase.stdout.trim() !== 'true') {
    return t.skip('the clone compares paths with case (core.ignorecase is not set)');
  }
  fs.rmSync(path.join(f.clone, 'g.md'));
  writeFile(f.clone, '.gitignore', 'g.md\n');
  const run = writeAfterPush(f, () => writeFile(f.clone, 'G.md', 'mine\n'));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t10' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['g.md']);
  assert.equal(fs.readFileSync(path.join(f.clone, 'G.md'), 'utf8'), 'mine\n');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
});

test('pushToBranch compares the ignored files without case where the folder does, whatever core.ignorecase says', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  if (!caseInsensitive(f.clone)) {
    return t.skip('the clone folder looks names up with case');
  }
  git(['config', 'core.ignorecase', 'false'], f.clone);
  fs.rmSync(path.join(f.clone, 'g.md'));
  writeFile(f.clone, '.gitignore', '*.md\n');
  const run = writeAfterPush(f, () => writeFile(f.clone, 'G.md', 'mine\n'));
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t11' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['g.md']);
  assert.equal(fs.readFileSync(path.join(f.clone, 'G.md'), 'utf8'), 'mine\n');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
});

test('pushToBranch leaves the clone as it is when a change was staged during the push', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  writeFile(f.clone, 'f.md', withLine(1, 'mine'));
  const run = writeAfterPush(f, () => {
    writeFile(f.clone, 'g.md', 'staged\n');
    git(['add', 'g.md'], f.clone);
    writeFile(f.clone, 'g.md', 'g\n');
  });
  const r = await pushToBranch({ ...f.args, run, message: 'mine', branch: 'team-plugins/t7' });
  assert.equal(r.kind, 'pushedBranch');
  assert.deepEqual(r.resetSkipped.files, ['g.md']);
  assert.ok(r.resetSkipped.message.includes('staged'), r.resetSkipped.message);
  assert.equal(git(['show', ':g.md'], f.clone), 'staged');
  assert.equal(git(['rev-parse', 'HEAD'], f.clone), r.head);
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

test('commitAndPush says how to set a missing git identity', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const f = await setup(t);
  // no global or system identity, no guessing from the machine: as on a computer where git was never set up
  const emptyConfig = writeFile(f.root, 'empty.gitconfig', '');
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = emptyConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  t.after(() => {
    for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]]) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  const plain = makeGit('git');
  const run = (args, cwd, timeoutMs, opts) => plain(['-c', 'user.useConfigOnly=true', ...args], cwd, timeoutMs, opts);
  writeFile(f.clone, 'g.md', 'mine\n');
  const r = await commitAndPush({ ...f.args, run });
  assert.equal(r.kind, 'error');
  assert.equal(r.step, 'commit');
  assert.equal(r.message, IDENTITY_MESSAGE);
  assert.ok(r.message.startsWith("git doesn't know your name and email"), r.message);
  assert.ok(r.message.includes('git config --global user.email'));
  assert.equal(git(['status', '--porcelain'], f.clone), 'M g.md');
});
