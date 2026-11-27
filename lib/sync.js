'use strict';

const fs = require('fs');
const path = require('path');
const { describeRemote, remoteResult } = require('./remoteErrors');

// fs.rmSync fails with EPERM on the read-only files git writes (objects, packs) under Windows: clear the flag, retry.
function removeTree(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    return;
  } catch {
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
  for (let attempt = 0; attempt < 3; attempt++) {
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
        // vanished: its holder released it. Try again without deleting anything, since the file may already be
        // another window's fresh lock: only a stale lock is ever removed.
        continue;
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

// Network git commands have no total limit (a first clone may take long) but are stopped after this long without
// output (--progress keeps a transfer talking): this is the default, `syncManaged` takes an `idleMs` (the tests make it
// short); CHECK_IDLE_MS is for the quick repository check.
const NETWORK_IDLE_MS = 2 * 60 * 1000;
const CHECK_IDLE_MS = 30 * 1000;
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

async function syncManaged({
  run,
  managedRepo,
  repoUrl,
  branch,
  lockFile,
  stateFile,
  log = () => {},
  idleMs = NETWORK_IDLE_MS,
}) {
  const result = await withLock({ lockFile, repo: managedRepo, log }, () =>
    syncLocked({ run, managedRepo, repoUrl, branch, log, idleMs }).catch((err) => ({
      kind: 'error',
      message: err.message,
    })),
  );
  if (result.kind === 'busy') {
    return result;
  }
  writeState(stateFile, result);
  return result;
}

// Whether a timed sync can be skipped: the state file records a sync (not an error, not an unreachable server) by any
// window less than half an interval ago. Startup, Sync now and settings changes always sync.
function recentlySynced(state, intervalMs, now = Date.now()) {
  const failed = ['error', 'busy', 'offline'];
  if (!state || !state.kind || failed.includes(state.kind) || typeof state.at !== 'string') {
    return false;
  }
  const at = Date.parse(state.at);
  if (!Number.isFinite(at)) {
    return false;
  }
  const age = now - at;
  return age >= 0 && age < intervalMs / 2;
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

// The uncommitted files and the number of commits ahead of the upstream. A failing `git status` throws: it never reads
// as "no changes" (a missing upstream, which makes the ahead count fail, is normal and reads as 0).
async function localChanges({ run, repo }) {
  const status = await run(['status', '--porcelain=v1', '-uall', '-z'], repo, undefined, { trim: false });
  if (status.code !== 0) {
    throw new Error(`git status failed: ${status.stderr}`);
  }
  const files = parseStatusZ(status.stdout);
  const count = await run(['rev-list', '--count', '@{u}..HEAD'], repo);
  const ahead = count.code === 0 ? Number(count.stdout) || 0 : 0;
  return { files, ahead };
}

// The repository-relative paths (POSIX, sorted, once each) a push would carry: the uncommitted files (a rename: both
// paths) and, when commits are unpushed, the files they changed. Throws like localChanges when `git status` fails; a
// failing diff (no upstream) adds nothing.
async function changedPaths({ run, repo }) {
  const { files, ahead } = await localChanges({ run, repo });
  const paths = new Set();
  for (const f of files) {
    paths.add(f.path);
    if (f.from) {
      paths.add(f.from);
    }
  }
  if (ahead > 0) {
    // --no-renames: a moved file lists its old path too (the push deletes it there)
    const diff = await run(
      ['-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', '-z', '@{u}...HEAD'],
      repo,
      undefined,
      { trim: false },
    );
    if (diff.code === 0) {
      for (const p of diff.stdout.split('\0')) {
        if (p !== '') {
          paths.add(p);
        }
      }
    }
  }
  return [...paths].sort();
}

// [major, minor, patch] of the text `git version` prints (e.g. 'git version 2.47.0.windows.1'), or null.
function gitVersionOf(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

// The files where the team's changes (as of the last fetch) and the local ones (uncommitted, untracked or committed)
// touch the same lines or the same new path. Changes nothing in the clone. Needs git 2.38 (merge-tree --write-tree).
async function checkConflicts({ run, repo, files }) {
  const v = await run(['version'], repo);
  const ver = v.code === 0 ? gitVersionOf(v.stdout) : null;
  if (ver && (ver[0] < 2 || (ver[0] === 2 && ver[1] < 38))) {
    throw new Error(
      `git 2.38 or later is needed to merge team updates (it finds conflicts with git merge-tree --write-tree); this git is ${ver.join('.')}: update git`,
    );
  }
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

// The git arguments for a team-plugins-git: document: `show <rev>:<file>` of a repository's HEAD or of a commit (the
// version the user last saw), never anything the URI could turn into a git option or another repository. null when
// the request is anything else.
function revFileArgs(request, repoDir) {
  if (
    !request ||
    typeof request.rev !== 'string' ||
    !/^(HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/.test(request.rev) ||
    typeof request.path !== 'string' ||
    request.path === ''
  ) {
    return null;
  }
  if (typeof request.repo !== 'string' || !repoDir || path.resolve(request.repo) !== path.resolve(repoDir)) {
    return null;
  }
  return ['show', `${request.rev}:${request.path}`];
}

// Asks the server for its HEAD (and for `branch` when given) without touching any clone: { kind: 'reachable',
// defaultBranch, empty }, or the classified failure (kind 'offline' or 'error', with reason, message, actions).
async function checkRemote({ run, cwd, repoUrl, branch = '', idleMs = NETWORK_IDLE_MS }) {
  const args = ['ls-remote', '--symref', '--', repoUrl, 'HEAD'];
  if (branch) {
    args.push(`refs/heads/${branch}`);
  }
  const r = await run(args, cwd, 0, { idleMs });
  if (r.code !== 0) {
    return remoteResult(r, { url: repoUrl, branch, op: 'read' }, `cannot reach ${repoUrl}: ${r.stderr}`);
  }
  const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(r.stdout);
  const defaultBranch = m ? m[1] : '';
  if (branch && !r.stdout.split(/\r?\n/).some((line) => line.endsWith(`\trefs/heads/${branch}`))) {
    return { kind: 'error', reason: 'branchNotFound', ...describeRemote('branchNotFound', { url: repoUrl, branch }) };
  }
  return { kind: 'reachable', defaultBranch, empty: r.stdout === '' };
}

// Switches the managed clone to repoUrl and branch `target` in place. It is never deleted or renamed: Windows refuses
// both while Cursor has a plugin folder of it registered (EPERM), in every window. Ordered so that a failure at any
// step leaves a state the next sync completes: the URL changes last, and the fetched target stays in
// refs/team-plugins/switch until the end, so the switched branch never counts as unpushed on a retry.
async function switchInPlace({ git, managedRepo, repoUrl, target, urlChanged, idleMs = NETWORK_IDLE_MS }) {
  const SWITCH_REF = 'refs/team-plugins/switch';
  const failed = (r) => ({
    kind: 'error',
    message: `switching the managed clone to ${repoUrl} (${target}) failed: ${r.stderr}`,
  });
  const fetch = await git(
    ['fetch', '--progress', '--no-tags', '--', repoUrl, `+refs/heads/${target}:${SWITCH_REF}`],
    managedRepo,
    0,
    { idleMs },
  );
  if (fetch.code !== 0) {
    return remoteResult(fetch, { url: repoUrl, branch: target, op: 'read' }, failed(fetch).message);
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
  // result ignored: the next sync fetches
  await git(['fetch', '--progress', '--prune', 'origin'], managedRepo, 0, { idleMs });
  const head = (await git(['rev-parse', 'HEAD'], managedRepo)).stdout;
  return { kind: 'switched', head, branch: target };
}

async function syncLocked({ run, managedRepo, repoUrl, branch, log, idleMs = NETWORK_IDLE_MS }) {
  const git = logged(run, log);

  // we hold the lock: no other window is cloning
  removeLeftovers(managedRepo, log);

  const clone = async () => {
    const parent = path.dirname(managedRepo);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = `${managedRepo}.tmp-${process.pid}-${Date.now()}`;
    const args = ['clone', '--progress'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push('--', repoUrl, tmp);
    const r = await git(args, parent, 0, { idleMs });
    if (r.code !== 0) {
      removeTree(tmp);
      return remoteResult(r, { url: repoUrl, branch, op: 'read' }, `git clone failed: ${r.stderr}`);
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
    const check = await checkRemote({ run: git, cwd: managedRepo, repoUrl, idleMs });
    if (check.kind !== 'reachable') {
      return check;
    }
    desired = check.defaultBranch; // empty repository: no branch yet
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
    // commits of local branches that no remote branch has and that are not the fetched switch target (an interrupted
    // switch leaves the branch on refs/team-plugins/switch); unlike @{u}, works on a branch without upstream
    const unpushedArgs = ['rev-list', '--count', '--branches', '--not', '--remotes', '--glob=refs/team-plugins/*'];
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
    return switchInPlace({ git, managedRepo, repoUrl, target: desired, urlChanged, idleMs });
  }

  const fetch = await git(['fetch', '--progress', '--prune', 'origin'], managedRepo, 0, { idleMs });
  if (fetch.code !== 0) {
    return remoteResult(
      fetch,
      { url: repoUrl, branch: desired, op: 'read' },
      `git fetch failed: ${fetch.stderr}`,
    );
  }
  const headR = await git(['rev-parse', 'HEAD'], managedRepo);
  const head = headR.stdout;
  const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], managedRepo);
  if (counts.code !== 0) {
    // the followed branch was deleted on the server: `fetch --prune` succeeded and removed its remote-tracking ref
    const cur = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], managedRepo)).stdout;
    const tracking = await git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${cur}`], managedRepo);
    if (tracking.code !== 0) {
      return {
        kind: 'error',
        reason: 'branchNotFound',
        ...describeRemote('branchNotFound', { url: repoUrl, branch: cur }),
      };
    }
    return { kind: 'error', message: `no upstream branch: ${counts.stderr}` };
  }
  const behind = Number(counts.stdout.split(/\s+/)[1]) || 0;
  if (behind === 0) {
    return { kind: 'upToDate', head };
  }
  const local = await localChanges({ run: git, repo: managedRepo });
  const conflicts = await checkConflicts({ run: git, repo: managedRepo, files: local.files });
  if (conflicts.length > 0) {
    const up = await git(['rev-parse', '@{u}'], managedRepo);
    return { kind: 'conflict', head, upstream: up.stdout, behind, files: conflicts };
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

module.exports = {
  removeTree,
  acquireLock,
  releaseLock,
  withLock,
  withLockSync,
  removeStaleIndexLock,
  removeLeftovers,
  NETWORK_IDLE_MS,
  CHECK_IDLE_MS,
  checkRemote,
  writeState,
  logged,
  parseStatusZ,
  localChanges,
  changedPaths,
  checkConflicts,
  gitVersionOf,
  revFileArgs,
  recentlySynced,
  syncManaged,
  discardLocalChanges,
  localStatus,
};
