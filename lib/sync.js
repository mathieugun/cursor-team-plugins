'use strict';

const fs = require('fs');
const path = require('path');

// fs.rmSync fails with EPERM on the read-only files git writes (objects, packs) under Windows: clear the flag, retry.
function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  } catch (err) {
    if (!fs.existsSync(target)) {
      return;
    }
  }
  const makeWritable = (p) => {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    try {
      fs.chmodSync(p, 0o666);
    } catch {
      // ignored
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p)) {
        makeWritable(path.join(p, name));
      }
    }
  };
  makeWritable(target);
  fs.rmSync(target, { recursive: true, force: true });
}

function acquireLock(lockFile, staleMs = 10 * 60 * 1000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}`);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') {
        throw err;
      }
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
      } catch {
        stale = true; // vanished: try again
      }
      if (!stale) {
        return false;
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // someone else removed it
      }
    }
  }
  return false;
}

function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    // ignored
  }
}

const CLONE_TIMEOUT_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5 * 60 * 1000;
const INDEX_LOCK_STALE_MS = 60 * 1000;
const LOCK_HEARTBEAT_MS = 60 * 1000;

// Removes <repo>/.git/index.lock when it is older than maxAgeMs (left by a killed git: every later git command that
// writes the index fails). Safe because it is called only while holding the sync lock: no git of this extension runs,
// and no other git holds an index lock for a minute. Returns true when it removed the file; never throws.
function removeStaleIndexLock(repo, log = () => {}, maxAgeMs = INDEX_LOCK_STALE_MS) {
  const file = path.join(repo, '.git', 'index.lock');
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age <= maxAgeMs) {
      return false;
    }
    fs.unlinkSync(file);
    log(`removed a stale ${file} (${Math.round(age / 1000)} s old)`);
    return true;
  } catch {
    return false;
  }
}

// Runs fn (async) while holding the lock file. { kind: 'busy' } when another process holds it. The lock's mtime is
// refreshed every heartbeatMs, so a long operation (a 30-minute clone) is never taken for a stale lock (10 min).
async function withLock({ lockFile, repo, log = () => {}, heartbeatMs = LOCK_HEARTBEAT_MS }, fn) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!acquireLock(lockFile)) {
    return { kind: 'busy' };
  }
  const beat = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(lockFile, now, now);
    } catch {
      // ignored
    }
  }, heartbeatMs);
  if (beat.unref) {
    beat.unref();
  }
  try {
    if (repo) {
      removeStaleIndexLock(repo, log);
    }
    return await fn();
  } finally {
    clearInterval(beat);
    releaseLock(lockFile);
  }
}

// For the short synchronous operations (partial-copy syncs): { kind: 'busy' } or { kind: 'done', value }.
function withLockSync(lockFile, fn) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!acquireLock(lockFile)) {
    return { kind: 'busy' };
  }
  try {
    return { kind: 'done', value: fn() };
  } finally {
    releaseLock(lockFile);
  }
}

// Removes the temporary clones (<managed clone>.tmp-*) that a failed or killed clone left. Called while holding the lock.
function removeLeftovers(managedRepo, log = () => {}) {
  const parent = path.dirname(managedRepo);
  const prefix = `${path.basename(managedRepo)}.tmp-`;
  let names;
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const full = path.join(parent, name);
    try {
      removeTree(full);
      log(`removed leftover ${full}`);
    } catch (err) {
      log(`cannot remove leftover ${full}: ${err.message}`);
    }
  }
}

async function renameWithRetry(from, to, attempts = 5, delayMs = 500) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function writeState(stateFile, result) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...result, at: new Date().toISOString() }));
    fs.renameSync(tmp, stateFile);
  } catch {
    // the state file is informative only
  }
}

async function syncManaged({ run, managedRepo, repoUrl, branch, lockFile, stateFile, log = () => {} }) {
  const result = await withLock({ lockFile, repo: managedRepo, log }, () =>
    syncLocked({ run, managedRepo, repoUrl, branch, log }).catch((err) => ({ kind: 'error', message: err.message })),
  );
  if (result.kind === 'busy') {
    return result;
  }
  writeState(stateFile, result);
  return result;
}

// Wraps `run` so that every git command is logged as `git <args> -> <code>: <stderr>`.
function logged(run, log) {
  return async (args, cwd, timeoutMs, opts) => {
    const r = await run(args, cwd, timeoutMs, opts);
    log(`git ${args.join(' ')} -> ${r.code}${r.stderr ? `: ${r.stderr}` : ''}`);
    return r;
  };
}

// Parses `git status --porcelain=v1 -uall -z` (untrimmed) into [{ path, status, from? }], in git's order.
function parseStatusZ(text) {
  const tokens = String(text).split('\0');
  const files = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '') {
      continue;
    }
    const xy = token.slice(0, 2);
    const entry = { path: token.slice(3) };
    let from;
    if (xy[0] === 'R' || xy[0] === 'C') {
      from = tokens[++i];
    }
    if (xy === '??') {
      entry.status = 'untracked';
    } else if (xy.includes('D')) {
      entry.status = 'deleted';
    } else if (xy[0] === 'R') {
      entry.status = 'renamed';
    } else if (xy[0] === 'A') {
      entry.status = 'added';
    } else {
      entry.status = 'modified';
    }
    if (from !== undefined) {
      entry.from = from;
    }
    files.push(entry);
  }
  return files;
}

async function localChanges({ run, repo }) {
  const status = await run(['status', '--porcelain=v1', '-uall', '-z'], repo, undefined, { trim: false });
  const files = status.code === 0 ? parseStatusZ(status.stdout) : [];
  const count = await run(['rev-list', '--count', '@{u}..HEAD'], repo);
  const ahead = count.code === 0 ? Number(count.stdout) || 0 : 0;
  return { files, ahead };
}

// The files where the team's changes (as of the last fetch) and the local ones (uncommitted, untracked or committed)
// touch the same lines or the same new path. Changes nothing in the clone.
async function checkConflicts({ run, repo, files }) {
  const conflicts = new Set();
  const stash = await run(['stash', 'create'], repo);
  if (stash.code !== 0) {
    throw new Error(`git stash create failed: ${stash.stderr}`);
  }
  const w = stash.stdout || 'HEAD';
  // quotePath off: names with non-ASCII characters are printed as they are, as `status -z` and `diff -z` give them
  const merge = await run(['-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', '@{u}', w], repo);
  if (merge.code === 1) {
    for (const line of merge.stdout.split(/\r?\n/).slice(1)) {
      if (line === '') {
        break;
      }
      conflicts.add(line);
    }
  } else if (merge.code !== 0) {
    throw new Error(`git merge-tree failed: ${merge.stderr}`);
  }
  const untracked = files.filter((f) => f.status === 'untracked').map((f) => f.path);
  if (untracked.length > 0) {
    const diff = await run(['diff', '--name-only', '-z', 'HEAD...@{u}'], repo);
    const team = new Set(diff.stdout.split('\0').filter((n) => n !== ''));
    for (const p of untracked) {
      if (team.has(p)) {
        conflicts.add(p);
      }
    }
  }
  return [...conflicts].sort();
}

// Switches the managed clone to repoUrl and branch `target` in place. It is never deleted or renamed: Windows refuses
// both while Cursor has a plugin folder of it registered (EPERM), in every window. Ordered so that a failure at any
// step leaves a state the next sync retries: the URL changes last, and the old remote refs stay until the final
// fetch, so the old local branches never count as unpushed on a retry.
async function switchInPlace({ git, managedRepo, repoUrl, target, urlChanged }) {
  const SWITCH_REF = 'refs/team-plugins/switch';
  const failed = (r) => ({
    kind: 'error',
    message: `switching the managed clone to ${repoUrl} (${target}) failed: ${r.stderr}`,
  });
  const fetch = await git(
    ['fetch', '--no-tags', '--', repoUrl, `+refs/heads/${target}:${SWITCH_REF}`],
    managedRepo,
    CLONE_TIMEOUT_MS,
  );
  if (fetch.code !== 0) {
    return /couldn't find remote ref/i.test(fetch.stderr)
      ? { kind: 'error', message: `branch ${target} not found on ${repoUrl}` }
      : failed(fetch);
  }
  const steps = [['checkout', '-B', target, SWITCH_REF]];
  if (urlChanged) {
    steps.push(['remote', 'set-url', 'origin', repoUrl]);
  }
  steps.push(['config', `branch.${target}.remote`, 'origin'], ['config', `branch.${target}.merge`, `refs/heads/${target}`]);
  for (const step of steps) {
    const r = await git(step, managedRepo);
    if (r.code !== 0) {
      return failed(r);
    }
  }
  const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], managedRepo);
  if (refs.code !== 0) {
    return failed(refs);
  }
  for (const b of refs.stdout.split(/\r?\n/).filter((n) => n !== '' && n !== target)) {
    const r = await git(['branch', '-D', b], managedRepo);
    if (r.code !== 0) {
      return failed(r);
    }
  }
  await git(['update-ref', '-d', SWITCH_REF], managedRepo);
  await git(['fetch', '--prune', 'origin'], managedRepo, FETCH_TIMEOUT_MS); // result ignored: the next sync fetches
  const head = (await git(['rev-parse', 'HEAD'], managedRepo)).stdout;
  return { kind: 'switched', head, branch: target };
}

async function syncLocked({ run, managedRepo, repoUrl, branch, log }) {
  const git = logged(run, log);

  // we hold the lock: no other window is cloning
  removeLeftovers(managedRepo, log);

  const clone = async () => {
    const parent = path.dirname(managedRepo);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = `${managedRepo}.tmp-${process.pid}-${Date.now()}`;
    const args = ['clone'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push('--', repoUrl, tmp);
    const r = await git(args, parent, CLONE_TIMEOUT_MS);
    if (r.code !== 0) {
      removeTree(tmp);
      return { kind: 'error', message: `git clone failed: ${r.stderr}` };
    }
    try {
      await renameWithRetry(tmp, managedRepo);
    } catch (err) {
      try {
        removeTree(tmp);
      } catch {
        // ignored
      }
      return { kind: 'error', message: `cannot move the new clone into place: ${err.code || err.message}` };
    }
    const head = await git(['rev-parse', 'HEAD'], managedRepo);
    return { kind: 'cloned', head: head.stdout };
  };

  if (!fs.existsSync(managedRepo)) {
    return clone();
  }

  // A git command that fails (git missing, a wrong git.path, a timeout) must never read as "clean": the clone is
  // deleted only when git confirmed a different URL or branch and no local work.
  const cannot = (args, r) => ({
    kind: 'error',
    message: `cannot check the managed clone: git ${args.join(' ')} failed: ${r.stderr}`,
  });
  const remoteArgs = ['remote', 'get-url', 'origin'];
  const remote = await git(remoteArgs, managedRepo);
  if (remote.code !== 0) {
    if (fs.existsSync(path.join(managedRepo, '.git'))) {
      return cannot(remoteArgs, remote);
    }
    removeTree(managedRepo); // not a clone: no .git, so nothing of the user's
    return clone();
  }
  // an empty branch setting means the repository's default branch, which can change after the clone (origin/HEAD is
  // only the default at clone time): ask the server
  let desired = branch;
  if (!branch) {
    const lsArgs = ['ls-remote', '--symref', '--', repoUrl, 'HEAD'];
    const ls = await git(lsArgs, managedRepo);
    if (ls.code !== 0) {
      return { kind: 'error', message: `cannot read the default branch of ${repoUrl}: ${ls.stderr}` };
    }
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(ls.stdout);
    desired = m ? m[1] : ''; // empty repository: no branch yet
  }
  const urlChanged = remote.stdout !== repoUrl;
  let current = '';
  if (urlChanged || desired) {
    // fails on an empty repository (no commit yet): then only the checks below decide
    const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], managedRepo);
    current = b.code === 0 ? b.stdout : '?';
  }
  const mismatch = urlChanged || (desired !== '' && current !== desired);
  if (mismatch) {
    const statusArgs = ['status', '--porcelain'];
    const status = await git(statusArgs, managedRepo);
    if (status.code !== 0) {
      return cannot(statusArgs, status);
    }
    // commits of local branches that no remote branch has; unlike @{u}, works on a branch without upstream
    const unpushedArgs = ['rev-list', '--count', '--branches', '--not', '--remotes'];
    const unpushed = await git(unpushedArgs, managedRepo);
    if (unpushed.code !== 0) {
      return cannot(unpushedArgs, unpushed);
    }
    if (status.stdout !== '' || Number(unpushed.stdout) > 0) {
      return {
        kind: 'error',
        message: `the managed clone follows ${remote.stdout} (${current}) and has local changes: push them to a branch or discard them first`,
      };
    }
    if (!desired) {
      return { kind: 'error', message: `${repoUrl} has no branch yet: the managed clone can't switch to it` };
    }
    return switchInPlace({ git, managedRepo, repoUrl, target: desired, urlChanged });
  }

  const fetch = await git(['fetch', '--prune', 'origin'], managedRepo, FETCH_TIMEOUT_MS);
  if (fetch.code !== 0) {
    return { kind: 'error', message: `git fetch failed: ${fetch.stderr}` };
  }
  const headR = await git(['rev-parse', 'HEAD'], managedRepo);
  const head = headR.stdout;
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], managedRepo);
  if (counts.code !== 0) {
    return { kind: 'error', message: `no upstream branch: ${counts.stderr}` };
  }
  const behind = Number(counts.stdout.split(/\s+/)[1]) || 0;
  if (behind === 0) {
    return { kind: 'upToDate', head };
  }
  const local = await localChanges({ run: git, repo: managedRepo });
  const conflicts = await checkConflicts({ run: git, repo: managedRepo, files: local.files });
  if (conflicts.length > 0) {
    return { kind: 'conflict', head, behind, files: conflicts };
  }
  // the exit code of an autostash rebase can't be trusted (a conflicting stash pop exits 0): conflicts were checked above
  const rebase = await git(['rebase', '--autostash', '@{u}'], managedRepo);
  if (rebase.code !== 0) {
    await git(['rebase', '--abort'], managedRepo);
    return { kind: 'error', message: `git rebase failed: ${rebase.stderr}` };
  }
  const unmerged = await git(['diff', '--name-only', '--diff-filter=U', '-z'], managedRepo);
  const left = unmerged.stdout.split('\0').filter((n) => n !== '');
  if (left.length > 0) {
    return {
      kind: 'error',
      message: `conflict markers left in ${left.join(', ')}: resolve them in the repository folder`,
    };
  }
  const newHead = (await git(['rev-parse', 'HEAD'], managedRepo)).stdout;
  return {
    kind: 'updated',
    from: head,
    to: newHead,
    commits: behind,
    kept: local.files.length + local.ahead,
  };
}

async function discardLocalChanges({ run, managedRepo, lockFile, log = () => {} }) {
  const result = await withLock({ lockFile, repo: managedRepo, log }, async () => {
    const reset = await run(['reset', '--hard', '@{u}'], managedRepo);
    if (reset.code !== 0) {
      return { ok: false, message: `git reset failed: ${reset.stderr}` };
    }
    const clean = await run(['clean', '-fd'], managedRepo);
    if (clean.code !== 0) {
      return { ok: false, message: `git clean failed: ${clean.stderr}` };
    }
    return { ok: true, message: 'local changes discarded' };
  });
  if (result.kind === 'busy') {
    return { ok: false, busy: true, message: 'another Cursor window is syncing the team plugins: try again in a moment' };
  }
  return result;
}

async function localStatus({ run, repoDir }) {
  const r = await run(['rev-parse', 'HEAD'], repoDir);
  return { kind: 'local', head: r.code === 0 ? r.stdout : null };
}

async function changesBetween({ run, repoDir, from, to }) {
  const r = await run(['log', '--oneline', `${from}..${to}`], repoDir);
  return r.stdout;
}

module.exports = {
  removeTree,
  acquireLock,
  releaseLock,
  withLock,
  withLockSync,
  removeStaleIndexLock,
  removeLeftovers,
  CLONE_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  writeState,
  logged,
  parseStatusZ,
  localChanges,
  checkConflicts,
  syncManaged,
  discardLocalChanges,
  localStatus,
  changesBetween,
};
