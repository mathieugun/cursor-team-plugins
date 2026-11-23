'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, remoteHost, remoteResult } = require('../lib/remoteErrors');

const CHANGED_KEY = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
  'Host key for github.com has changed and you have requested strict checking.',
  'Host key verification failed.',
  'fatal: Could not read from remote repository.',
].join('\n');

const GITLAB_REJECTED = [
  'remote: GitLab: You are not allowed to push code to protected branches on this project.',
  'To host:o/r.git',
  ' ! [remote rejected] main -> main (pre-receive hook declined)',
  "error: failed to push some refs to 'host:o/r.git'",
].join('\n');

const DENIED_403 = [
  'remote: Permission to o/r.git denied to someone.',
  "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
].join('\n');

const SAMPLES = [
  [
    'Host key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
    'hostKeyUnknown',
  ],
  [CHANGED_KEY, 'hostKeyChanged'],
  ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'sshAuth'],
  ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'credentials'],
  [
    "fatal: Cannot prompt because user interactivity has been disabled.\nfatal: could not read Username for 'https://github.com/o/r': terminal prompts disabled",
    'credentials',
  ],
  [
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
    'authFailed',
  ],
  [
    "fatal: unable to access 'http://127.0.0.1:1/x.git/': Failed to connect to 127.0.0.1 port 1 after 2050 ms: Could not connect to server",
    'unreachable',
  ],
  ['ssh: connect to host 127.0.0.1 port 1: Connection refused\nfatal: Could not read from remote repository.', 'unreachable'],
  [
    'ssh: Could not resolve hostname nonexistent.invalid: Name or service not known\nfatal: Could not read from remote repository.',
    'unreachable',
  ],
  ["fatal: unable to access 'https://nonexistent.invalid/x.git/': Could not resolve host: nonexistent.invalid", 'unreachable'],
  ["fatal: 'C:/x/missing.git' does not appear to be a git repository\nfatal: Could not read from remote repository.", 'notFound'],
  ["fatal: repository '/tmp/missing.git' does not exist", 'notFound'],
  ["remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", 'notFound'],
  ['ERROR: Repository not found.\nfatal: Could not read from remote repository.', 'notFound'],
  ["Cloning into 'x'...\nfatal: Remote branch nope not found in upstream origin", 'branchNotFound'],
  ["fatal: couldn't find remote ref refs/heads/nope", 'branchNotFound'],
  [GITLAB_REJECTED, 'pushRejected'],
  [
    'remote: error: GH006: Protected branch update failed for refs/heads/main.\n ! [remote rejected] main -> main (protected branch hook declined)',
    'pushRejected',
  ],
  [' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs to', 'notFastForward'],
  [DENIED_403, 'denied'],
  ['fatal: something else entirely', null],
];

test('classify', () => {
  for (const [stderr, reason] of SAMPLES) {
    assert.equal(classify({ stderr }), reason, stderr);
  }
  assert.equal(classify({ stderr: '', timedOut: 'idle', limitMs: 120000 }), 'timeout');
});

test('remoteHost', () => {
  const cases = [
    ['https://github.com/o/r.git', 'github.com'],
    ['https://user@git.example.com:8443/r.git', 'git.example.com'],
    ['ssh://git@host.example:2222/r.git', 'host.example'],
    ['git@github.com:o/r.git', 'github.com'],
    ['host.example:repo.git', 'host.example'],
    ['C:/repos/team.git', ''],
    ['C:\\repos\\team.git', ''],
    ['/srv/team.git', ''],
    ['file:///C:/r.git', ''],
    ['ssh://[::1]:22/r.git', '[::1]'],
  ];
  for (const [url, host] of cases) {
    assert.equal(remoteHost(url), host, url);
  }
});

test('remoteResult', () => {
  const offline = remoteResult(
    { code: 128, stderr: "fatal: unable to access 'https://h.example/x.git/': Could not resolve host: h.example" },
    { url: 'https://h.example/x.git', op: 'read' },
    'fb',
  );
  assert.equal(offline.kind, 'offline');
  assert.equal(offline.reason, 'unreachable');
  assert.equal(
    offline.message,
    "cannot reach h.example (unable to access 'https://h.example/x.git/': Could not resolve host: h.example). Offline, VPN down or DNS? The plugins already cloned keep working; the next update tries again.",
  );
  assert.deepEqual(offline.actions, ['retry']);

  const rejected = remoteResult({ code: 1, stderr: GITLAB_REJECTED }, { url: 'git@h:o/r.git', branch: 'main', op: 'push' }, 'fb');
  assert.equal(rejected.kind, 'error');
  assert.equal(
    rejected.message,
    'the server refused the push to main (GitLab: You are not allowed to push code to protected branches on this project.): a protected branch or a server rule. Push your changes to a branch instead, and open a pull request from it.',
  );
  assert.deepEqual(rejected.actions, ['pushToBranch', 'showLog']);

  const ctx = { url: 'https://github.com/o/r.git', branch: 'main' };
  assert.deepEqual(remoteResult({ stderr: DENIED_403 }, { ...ctx, op: 'push' }, 'fb').actions, ['pushToBranch', 'showLog']);
  assert.deepEqual(remoteResult({ stderr: DENIED_403 }, { ...ctx, op: 'read' }, 'fb').actions, ['setUrl', 'showLog']);

  const stalled = remoteResult(
    { stderr: 'git stopped: no output for 120 s', timedOut: 'idle', limitMs: 120000 },
    { url: 'git@h.example:o/r.git', op: 'read' },
    'fb',
  );
  assert.ok(stalled.message.startsWith('no answer from h.example for 120 s, so git was stopped.'), stalled.message);
  assert.deepEqual(stalled.actions, ['terminal', 'retry']);

  assert.deepEqual(remoteResult({ stderr: 'fatal: something else entirely' }, { url: 'x' }, 'fb'), {
    kind: 'error',
    message: 'fb',
  });
});

// GitHub's refusal of a push to a branch under a ruleset, as git prints it with --progress: progress lines come first.
test('a push refused by a GitHub ruleset quotes the server, not the progress', () => {
  const stderr = [
    'Enumerating objects: 9, done.',
    'Counting objects: 100% (9/9), done.',
    'Writing objects: 100% (5/5), 412 bytes | 412.00 KiB/s, done.',
    'Total 5 (delta 3), reused 0 (delta 0), pack-reused 0',
    'remote: Resolving deltas: 100% (3/3), completed with 3 local objects.',
    'remote: error: GH013: Repository rule violations found for refs/heads/main.',
    'remote: Review all repository rules at https://github.com/o/r/rules?ref=refs%2Fheads%2Fmain',
    'remote: - Changes must be made through a pull request.',
    'To https://github.com/o/r.git',
    ' ! [remote rejected] HEAD -> main (push declined due to repository rule violations)',
    "error: failed to push some refs to 'https://github.com/o/r.git'",
  ].join('\n');
  const r = remoteResult({ code: 1, stderr }, { url: 'https://github.com/o/r.git', branch: 'main', op: 'push' }, 'fb');
  assert.equal(r.reason, 'pushRejected');
  assert.equal(
    r.message,
    'the server refused the push to main (error: GH013: Repository rule violations found for refs/heads/main.): a protected branch or a server rule. Push your changes to a branch instead, and open a pull request from it.',
  );
});
