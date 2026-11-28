'use strict';

const { withLock, writeState, logged, localChanges, checkConflicts, NETWORK_IDLE_MS } = require('./sync');
const { remoteResult } = require('./remoteErrors');
const { pullRequestPage } = require('./pullRequest');

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
    if (/Author identity unknown|Please tell me who you are/.test(commit.stderr)) {
      return {
        kind: 'error',
        step: 'commit',
        message:
          'git doesn\'t know your name and email, which every commit records. Set them once in a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com", then try again.',
      };
    }
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

async function commitAndPush({ run, repo, message, lockFile, stateFile, repoUrl, log = () => {} }) {
  const url = repoUrl || 'the team repository';
  return withLock({ lockFile, repo, log }, async () => {
    const git = logged(run, log);
    const fetch = await git(['fetch', '--progress', '--prune', 'origin'], repo, 0, { idleMs: NETWORK_IDLE_MS });
    if (fetch.code !== 0) {
      return {
        ...remoteResult(fetch, { url, op: 'read' }, `git fetch failed: ${fetch.stderr}`),
        kind: 'error',
        step: 'fetch',
      };
    }
    let local;
    try {
      local = await localChanges({ run: git, repo });
    } catch (err) {
      return { kind: 'error', step: 'status', message: err.message };
    }
    const { files, ahead } = local;
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
      let conflicts;
      try {
        conflicts = await checkConflicts({ run: git, repo, files: [] });
      } catch (err) {
        return { kind: 'error', step: 'conflicts', message: err.message };
      }
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
    const push = await git(['push', '--progress', up.remote, `HEAD:refs/heads/${up.branch}`], repo, 0, {
      idleMs: NETWORK_IDLE_MS,
    });
    if (push.code !== 0) {
      return {
        ...remoteResult(push, { url, branch: up.branch, op: 'push' }, `git push failed: ${push.stderr}`),
        kind: 'error',
        step: 'push',
      };
    }
    const head = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    writeState(stateFile, { kind: 'upToDate', head });
    return { kind: 'pushed', head, branch: up.branch, commits };
  });
}

// The way out of a conflict: commit and push the local changes to a new branch, then put the clone back on the team
// version (`reset --keep`: it keeps the changes saved after the commit). When one of them is on a file of the pushed
// commit, git refuses and changes nothing: the clone is left as it is (`resetSkipped`).
async function pushToBranch({ run, repo, message, branch, lockFile, stateFile, repoUrl, log = () => {} }) {
  const url = repoUrl || 'the team repository';
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
    const exists = await git(['ls-remote', '--exit-code', '--heads', remote, branch], repo, 0, {
      idleMs: NETWORK_IDLE_MS,
    });
    if (exists.code === 0) {
      return { kind: 'error', step: 'branch', message: `branch ${branch} already exists on the server` };
    }
    if (exists.code !== 2) {
      return {
        ...remoteResult(exists, { url, op: 'read' }, `git ls-remote failed: ${exists.stderr}`),
        kind: 'error',
        step: 'branch',
      };
    }
    let local;
    try {
      local = await localChanges({ run: git, repo });
    } catch (err) {
      return { kind: 'error', step: 'status', message: err.message };
    }
    const { files, ahead } = local;
    if (files.length === 0 && ahead === 0) {
      return { kind: 'nothing' };
    }
    if (files.length > 0) {
      const failed = await commitAll(git, repo, message);
      if (failed) {
        return failed;
      }
    }
    const push = await git(['push', '--progress', remote, `HEAD:refs/heads/${branch}`], repo, 0, {
      idleMs: NETWORK_IDLE_MS,
    });
    if (push.code !== 0) {
      return {
        ...remoteResult(push, { url, branch, op: 'branch' }, `git push failed: ${push.stderr}`),
        kind: 'error',
        step: 'push',
      };
    }
    const pullRequest = pullRequestPage({ url: repoUrl, branch, target: up.branch, pushOutput: push.stderr });
    const pushed = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    const result = { kind: 'pushedBranch', branch, remote, head: pushed, target: up.branch, pullRequest };
    const reset = await git(['reset', '--keep', '@{u}'], repo);
    if (reset.code !== 0) {
      log(`push to ${branch} done, managed clone left as it is: ${reset.stderr}`);
      const files = [];
      for (const re of [
        /^error: Entry '(.+)' not uptodate\. Cannot merge\.$/gm,
        /^error: Untracked working tree file '(.+)' would be overwritten by merge\.$/gm,
      ]) {
        for (const match of reset.stderr.matchAll(re)) {
          files.push({ at: match.index, name: match[1] });
        }
      }
      const names = [...new Set(files.sort((a, b) => a.at - b.at).map((x) => x.name))];
      return { ...result, resetSkipped: { files: names, message: reset.stderr } };
    }
    const head = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    writeState(stateFile, { kind: 'upToDate', head });
    return result;
  });
}

module.exports = { defaultBranchName, commitAndPush, pushToBranch };
