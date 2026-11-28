'use strict';

const { withLock, writeState, logged, redacted, localChanges, checkConflicts, NETWORK_IDLE_MS } = require('./sync');
const { remoteResult, redactUrls } = require('./remoteErrors');
const { pullRequestPage } = require('./pullRequest');
const { caseInsensitive } = require('./materialize');

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

const IDENTITY_MESSAGE =
  'git doesn\'t know your name and email, which every commit records. Set them once in a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com", then try again.';

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
      return { kind: 'error', step: 'commit', message: IDENTITY_MESSAGE };
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
  const result = await withLock({ lockFile, repo, log }, async () => {
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
  return redacted(result);
}

// The way out of a conflict: commit and push the local changes to a new branch, then put the clone back on the team
// version (`reset --keep`: it keeps the changes saved after the commit). When one of them is on a file of the pushed
// commit, git refuses and changes nothing: the clone is left as it is (`resetSkipped`). So it is when a change was
// staged during the push or an ignored file would be overwritten: `reset --keep` protects neither.
async function pushToBranch({ run, repo, message, branch, lockFile, stateFile, repoUrl, log = () => {} }) {
  const url = repoUrl || 'the team repository';
  const result = await withLock({ lockFile, repo, log }, async () => {
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
    const pushedResult = { kind: 'pushedBranch', branch, remote, head: pushed, target: up.branch, pullRequest };
    const skipReset = (files, message) => {
      log(redactUrls(`push to ${branch} done, managed clone left as it is: ${message}`));
      return { ...pushedResult, resetSkipped: { files, message: redactUrls(message) } };
    };
    // changes staged during the push, and ignored files the reset would overwrite, are not protected by `reset --keep`
    const staged = await git(['diff', '--cached', '--name-only', '-z'], repo, 0, { trim: false });
    if (staged.code !== 0) {
      return skipReset([], `cannot check the staged changes: ${staged.stderr}`);
    }
    const stagedNames = staged.stdout.split('\0').filter(Boolean);
    if (stagedNames.length > 0) {
      return skipReset(stagedNames, `changes were staged during the push: ${stagedNames.join(', ')}`);
    }
    const changed = await git(['diff', '--name-only', '-z', 'HEAD', '@{u}'], repo, 0, { trim: false });
    const ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], repo, 0, {
      trim: false,
    });
    if (changed.code !== 0 || ignored.code !== 0) {
      return skipReset([], `cannot check the ignored files: ${changed.code !== 0 ? changed.stderr : ignored.stderr}`);
    }
    // where git compares paths without case (`core.ignorecase`, set in every Windows clone) or the clone's folder looks
    // names up without case (the option overridden by hand), `Saved.txt` is the file `saved.txt`: so the guard folds
    const ignoreCase =
      (await git(['config', '--bool', 'core.ignorecase'], repo)).stdout === 'true' || caseInsensitive(repo);
    const norm = (p) => (ignoreCase ? p.toLowerCase() : p).replace(/\/$/, '');
    const ignoredEntries = ignored.stdout.split('\0').filter(Boolean).map(norm);
    // an ignored file or folder at a path the reset restores, below it (an ignored folder `cache/` for the file `cache`)
    // or above it (an ignored file `cache` for `cache/item.txt`) would be replaced too
    const hits = changed.stdout
      .split('\0')
      .filter(Boolean)
      .filter((p) => {
        const q = norm(p);
        return ignoredEntries.some((e) => e === q || q.startsWith(`${e}/`) || e.startsWith(`${q}/`));
      });
    if (hits.length > 0) {
      return skipReset(hits, `ignored files would be overwritten by the reset: ${hits.join(', ')}`);
    }
    const reset = await git(['reset', '--keep', '@{u}'], repo);
    if (reset.code !== 0) {
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
      return skipReset(names, reset.stderr);
    }
    const head = (await git(['rev-parse', 'HEAD'], repo)).stdout;
    writeState(stateFile, { kind: 'upToDate', head });
    return pushedResult;
  });
  return redacted(result);
}

module.exports = { defaultBranchName, commitAll, IDENTITY_MESSAGE, commitAndPush, pushToBranch };
