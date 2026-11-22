'use strict';

const { withLock, writeState, logged, localChanges, checkConflicts, FETCH_TIMEOUT_MS } = require('./sync');

const PUSH_TIMEOUT_MS = 300000;

// 'team-plugins/<user>-YYYYMMDD-HHMM' (local time); the user part is left out when the name has no letter or digit.
function defaultBranchName(userName, date) {
  const slug = String(userName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `team-plugins/${slug ? `${slug}-` : ''}${stamp}`;
}

// Stages everything and commits it. null on success, an error result otherwise.
async function commitAll(git, repo, message) {
  const add = await git(['add', '-A'], repo);
  if (add.code !== 0) {
    return { kind: 'error', step: 'add', message: `git add failed: ${add.stderr}` };
  }
  const commit = await git(['commit', '-m', message], repo);
  if (commit.code !== 0) {
    await git(['reset', '-q'], repo);
    return { kind: 'error', step: 'commit', message: `git commit failed: ${commit.stderr || commit.stdout}` };
  }
  return null;
}

// { remote, branch } of the upstream (for example origin/main).
async function upstream(git, repo) {
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo);
  if (up.code !== 0) {
    return { error: { kind: 'error', step: 'upstream', message: `no upstream branch: ${up.stderr}` } };
  }
  const i = up.stdout.indexOf('/');
  return { remote: up.stdout.slice(0, i), branch: up.stdout.slice(i + 1) };
}

async function commitAndPush({ run, repo, message, lockFile, stateFile, log = () => {} }) {
  return withLock({ lockFile, repo, log }, async () => {
    const git = logged(run, log);
    const fetch = await git(['fetch', '--prune', 'origin'], repo, FETCH_TIMEOUT_MS);
    if (fetch.code !== 0) {
      return { kind: 'error', step: 'fetch', message: `git fetch failed: ${fetch.stderr}` };
    }
    const { files, ahead } = await localChanges({ run: git, repo });
    if (files.length === 0 && ahead === 0) {
      return { kind: 'nothing' };
    }
    if (files.length > 0) {
      const failed = await commitAll(git, repo, message);
      if (failed) {
        return failed;
      }
    }
    const counts = await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], repo);
    if (counts.code !== 0) {
      return { kind: 'error', step: 'fetch', message: `no upstream branch: ${counts.stderr}` };
    }
    const behind = Number(counts.stdout.split(/\s+/)[1]) || 0;
    if (behind > 0) {
      const conflicts = await checkConflicts({ run: git, repo, files: [] });
      if (conflicts.length > 0) {
        return { kind: 'conflict', files: conflicts };
      }
      const rebase = await git(['rebase', '@{u}'], repo);
      if (rebase.code !== 0) {
        await git(['rebase', '--abort'], repo);
        return { kind: 'error', step: 'rebase', message: `git rebase failed: ${rebase.stderr}` };
      }
    }
    const up = await upstream(git, repo);
    if (up.error) {
      return up.error;
    }
    const count = await git(['rev-list', '--count', '@{u}..HEAD'], repo);
    const commits = Number(count.stdout) || 0;
    const push = await git(['push', up.remote, `HEAD:refs/heads/${up.branch}`], repo, PUSH_TIMEOUT_MS);
    if (push.code !== 0) {
      return { kind: 'error', step: 'push', message: `git push failed: ${push.stderr}` };
    }
    const head = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    writeState(stateFile, { kind: 'upToDate', head });
    return { kind: 'pushed', head, branch: up.branch, commits };
  });
}

// The way out of a conflict: commit and push the local changes to a new branch, then put the clone back on the team
// version.
async function pushToBranch({ run, repo, message, branch, lockFile, stateFile, log = () => {} }) {
  return withLock({ lockFile, repo, log }, async () => {
    const git = logged(run, log);
    const ref = await git(['check-ref-format', '--branch', branch], repo);
    if (ref.code !== 0) {
      return { kind: 'error', step: 'branch', message: `invalid branch name: ${branch}` };
    }
    const up = await upstream(git, repo);
    if (up.error) {
      return up.error;
    }
    const remote = up.remote;
    const exists = await git(['ls-remote', '--exit-code', '--heads', remote, branch], repo);
    if (exists.code === 0) {
      return { kind: 'error', step: 'branch', message: `branch ${branch} already exists on the server` };
    }
    if (exists.code !== 2) {
      return { kind: 'error', step: 'branch', message: `git ls-remote failed: ${exists.stderr}` };
    }
    const { files, ahead } = await localChanges({ run: git, repo });
    if (files.length === 0 && ahead === 0) {
      return { kind: 'nothing' };
    }
    if (files.length > 0) {
      const failed = await commitAll(git, repo, message);
      if (failed) {
        return failed;
      }
    }
    const push = await git(['push', remote, `HEAD:refs/heads/${branch}`], repo, PUSH_TIMEOUT_MS);
    if (push.code !== 0) {
      return { kind: 'error', step: 'push', message: `git push failed: ${push.stderr}` };
    }
    const pushed = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    const reset = await git(['reset', '--hard', '@{u}'], repo);
    const clean = reset.code === 0 ? await git(['clean', '-fd'], repo) : reset;
    if (clean.code !== 0) {
      return {
        kind: 'error',
        step: 'reset',
        message: `pushed to ${branch}, but resetting the managed clone failed: ${clean.stderr}`,
      };
    }
    const head = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    writeState(stateFile, { kind: 'upToDate', head });
    return { kind: 'pushedBranch', branch, remote, head: pushed };
  });
}

module.exports = { defaultBranchName, commitAndPush, pushToBranch };
