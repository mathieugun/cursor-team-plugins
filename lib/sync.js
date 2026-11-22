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
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  if (!acquireLock(lockFile)) {
    return { kind: 'busy' };
  }
  let result;
  try {
    result = await syncLocked({ run, managedRepo, repoUrl, branch, log });
  } catch (err) {
    result = { kind: 'error', message: err.message };
  } finally {
    releaseLock(lockFile);
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

async function syncLocked({ run, managedRepo, repoUrl, branch, log }) {
  const git = logged(run, log);

  const clone = async () => {
    const parent = path.dirname(managedRepo);
    fs.mkdirSync(parent, { recursive: true });
    const tmp = `${managedRepo}.tmp-${process.pid}-${Date.now()}`;
    const args = ['clone'];
    if (branch) {
      args.push('--branch', branch);
    }
    args.push('--', repoUrl, tmp);
    const r = await git(args, parent);
    if (r.code !== 0) {
      removeTree(tmp);
      return { kind: 'error', message: `git clone failed: ${r.stderr}` };
    }
    fs.renameSync(tmp, managedRepo);
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
  let mismatch = remote.stdout !== repoUrl;
  let current = '';
  if (mismatch || branch) {
    // fails on an empty repository (no commit yet): then only the checks below decide
    const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], managedRepo);
    current = b.code === 0 ? b.stdout : '?';
    if (branch && current !== branch) {
      mismatch = true;
    }
  }
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
        message: `the managed clone follows ${remote.stdout} (${current}) and has local changes: discard them or delete ${managedRepo}`,
      };
    }
    removeTree(managedRepo);
    return clone();
  }

  const fetch = await git(['fetch', '--prune', 'origin'], managedRepo);
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

async function discardLocalChanges({ run, managedRepo }) {
  const reset = await run(['reset', '--hard', '@{u}'], managedRepo);
  if (reset.code !== 0) {
    return { ok: false, message: `git reset failed: ${reset.stderr}` };
  }
  const clean = await run(['clean', '-fd'], managedRepo);
  if (clean.code !== 0) {
    return { ok: false, message: `git clean failed: ${clean.stderr}` };
  }
  return { ok: true, message: 'local changes discarded' };
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
