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

async function syncLocked({ run, managedRepo, repoUrl, branch, log }) {
  const git = async (args, cwd) => {
    const r = await run(args, cwd);
    log(`git ${args.join(' ')} -> ${r.code}${r.stderr ? `: ${r.stderr}` : ''}`);
    return r;
  };

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

  const remote = await git(['remote', 'get-url', 'origin'], managedRepo);
  let mismatch = remote.stdout !== repoUrl;
  let current = '';
  if (!mismatch && branch) {
    const b = await git(['rev-parse', '--abbrev-ref', 'HEAD'], managedRepo);
    current = b.stdout;
    mismatch = current !== branch;
  } else if (mismatch) {
    current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], managedRepo)).stdout;
  }
  if (mismatch) {
    const status = await git(['status', '--porcelain'], managedRepo);
    const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], managedRepo);
    const ahead = counts.code === 0 ? Number(counts.stdout.split(/\s+/)[0]) || 0 : 0;
    if (status.stdout !== '' || ahead > 0) {
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
  const [ahead, behind] = counts.stdout.split(/\s+/).map(Number);
  const dirty = (await git(['status', '--porcelain'], managedRepo)).stdout !== '';
  if (behind === 0 && ahead === 0) {
    return { kind: 'upToDate', head };
  }
  if (ahead > 0) {
    return { kind: 'diverged', head, ahead, behind };
  }
  if (dirty) {
    return { kind: 'dirty', head, behind };
  }
  const merge = await git(['merge', '--ff-only', '@{u}'], managedRepo);
  if (merge.code !== 0) {
    return { kind: 'error', message: `git merge failed: ${merge.stderr}` };
  }
  const newHead = (await git(['rev-parse', 'HEAD'], managedRepo)).stdout;
  return { kind: 'updated', from: head, to: newHead, commits: behind };
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

module.exports = { removeTree, acquireLock, releaseLock, syncManaged, discardLocalChanges, localStatus, changesBetween };
