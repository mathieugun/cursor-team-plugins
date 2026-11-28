'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classify,
  remoteHost,
  describeRemote,
  remoteResult,
  withoutCredentials,
  redactUrls,
  redactingUi,
} = require('../lib/remoteErrors');

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
    // a raw `@` in the password: the user info ends at the last one
    ['https://user:part@secret@host.test/team.git', 'host.test'],
    // a no-break space or an angle bracket in the password never ends the user info
    ['https://sec ret@host.test/team.git', 'host.test'],
    ['https://user:sec<ret@host.test/team.git', 'host.test'],
    // no path: the query is not part of the host
    ['https://host.test?access_token=secret@tag', 'host.test'],
    // git's transport prefix, extra slashes
    ['https::https://user:secret@host.test/x', 'host.test'],
    ['https:///user:secret@host.test/team.git', 'host.test'],
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
    'the server refused the push to main (GitLab: You are not allowed to push code to protected branches on this project.): a protected branch or a server rule. Open a pull request instead: your changes go to a new branch, and the hosting service\'s page to propose them opens.',
  );
  assert.deepEqual(rejected.actions, ['pullRequest', 'showLog']);

  const refusedBranch = remoteResult(
    { code: 1, stderr: GITLAB_REJECTED },
    { url: 'git@h:o/r.git', branch: 'team-plugins/x', op: 'branch' },
    'fb',
  );
  assert.equal(
    refusedBranch.message,
    'the server refused the new branch team-plugins/x (GitLab: You are not allowed to push code to protected branches on this project.): a server rule on branch names, or on who may create branches. Try another branch name, or ask the repository\'s admins.',
  );
  assert.deepEqual(refusedBranch.actions, ['pushToBranch', 'showLog']);

  const ctx = { url: 'https://github.com/o/r.git', branch: 'main' };
  assert.deepEqual(remoteResult({ stderr: DENIED_403 }, { ...ctx, op: 'push' }, 'fb').actions, ['pullRequest', 'showLog']);
  const deniedBranch = remoteResult({ stderr: DENIED_403 }, { ...ctx, op: 'branch' }, 'fb');
  assert.deepEqual(deniedBranch.actions, ['showLog']);
  assert.ok(deniedBranch.message.startsWith('you have no write access to https://github.com/o/r.git'), deniedBranch.message);
  assert.ok(
    deniedBranch.message.includes(': the server refused a new branch too. Ask for write access (pull requests from a fork are not supported).'),
    deniedBranch.message,
  );
  assert.deepEqual(remoteResult({ stderr: DENIED_403 }, { ...ctx, op: 'read' }, 'fb').actions, ['repositories', 'showLog']);

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
    'the server refused the push to main (error: GH013: Repository rule violations found for refs/heads/main.): a protected branch or a server rule. Open a pull request instead: your changes go to a new branch, and the hosting service\'s page to propose them opens.',
  );
});

test('the messages that point at a setting name teamPlugins.repositories', () => {
  const denied = describeRemote('denied', { url: 'https://h/o/r.git', op: 'read' });
  assert.equal(
    denied.message,
    'you have no access to https://h/o/r.git. Ask for access, or check its URL in teamPlugins.repositories.',
  );
  assert.deepEqual(denied.actions, ['repositories', 'showLog']);
  const branch = describeRemote('branchNotFound', { url: 'https://h/o/r.git', branch: 'nope' });
  assert.equal(
    branch.message,
    "branch nope not found on https://h/o/r.git. Check its branch in teamPlugins.repositories (none: the repository's default branch).",
  );
  assert.deepEqual(branch.actions, ['repositories']);
  const missing = describeRemote('notFound', { url: 'https://h/o/r.git' });
  assert.equal(
    missing.message,
    'repository https://h/o/r.git not found, or you have no access to it. Check its URL in teamPlugins.repositories.',
  );
  assert.deepEqual(missing.actions, ['repositories', 'showLog']);
});

test('redactUrls removes the credentials of URLs', () => {
  const cases = [
    ['git clone -- https://user:secret@host/o/r.git dir', 'git clone -- https://host/o/r.git dir'],
    ['HTTP://tok@host/p', 'HTTP://host/p'],
    ["fatal: unable to access 'https://u:p@h/x/': boom", "fatal: unable to access 'https://h/x/': boom"],
    ['https://u:p@ss@h/x', 'https://h/x'],
    ['a https://u:s@h1/x b http://t@h2:8080/y', 'a https://h1/x b http://h2:8080/y'],
    ['ssh://git:pw@h/x', 'ssh://git@h/x'],
    ['git+ssh://u:pw@h/x', 'git+ssh://u@h/x'],
    // curl accepts quotes, angle brackets and a no-break space in a password
    ["git clone -- https://user:sec'ret@host.test/team.git", 'git clone -- https://host.test/team.git'],
    ['https://u:a"b<c>@h/x', 'https://h/x'],
    ['https://user:sec ret@host.test/team.git', 'https://host.test/team.git'],
    // no path
    ['https://user:secret@host.test', 'https://host.test'],
    ["cannot reach 'https://user:secret@host.test': boom", "cannot reach 'https://host.test': boom"],
    // a URL starts anywhere, after punctuation too
    ['remote: ...https://user:secret@host.test/team.git', 'remote: ...https://host.test/team.git'],
    ['remote: see/https://user:secret@host.test/team.git', 'remote: see/https://host.test/team.git'],
    // free text: more than the user info may go, never less
    ['docs=https://docs.test,email=alice@example.test', 'docs=https://example.test'],
    // a password pasted with a space (git refuses the URL, but logs it first)
    ['git clone -- https://user:sec ret@host.test/team.git dir', 'git clone -- https://host.test/team.git dir'],
    // extra slashes, git's transport prefix
    ['https:///user:secret@host.test/team.git', 'https:///host.test/team.git'],
    ['git clone -- https::https://user:secret@host.test x', 'git clone -- https::https://host.test x'],
    ['git clone -- https::https:/user:secret@host.test x', 'git clone -- https::https:/host.test x'],
    ['line one https://host.test\nmail a@b.c', 'line one https://host.test\nmail a@b.c'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(redactUrls(text), expected);
  }
  for (const same of [
    'ssh://git@h/x',
    'git@host:org/p.git',
    'C:\\repos\\x.git',
    'file:///srv/x.git',
    'https://host/x',
    'mail me at a@b.c',
    // a drive letter is no scheme
    'C://team@work/plugins.git',
  ]) {
    assert.equal(redactUrls(same), same);
  }
  assert.equal(redactUrls(undefined), '');
  assert.equal(redactUrls(null), '');
});

test('withoutCredentials removes the user info of one URL and touches nothing else', () => {
  const cases = [
    ['https://user:secret@host.test/team.git', 'https://host.test/team.git'],
    ['HTTP://tok@host/p', 'HTTP://host/p'],
    ['https://user:secret@host.test', 'https://host.test'],
    ['https://u:p@ss@h/x', 'https://h/x'],
    ['https://user:sec<ret>@host.test/x', 'https://host.test/x'],
    ['https://user:sec ret@host.test/x', 'https://host.test/x'],
    ['ssh://git:pw@h/x', 'ssh://git@h/x'],
    // git's transport prefix, extra slashes
    ['https::https://user:secret@host.test', 'https::https://host.test'],
    ['https:///user:secret@host.test/team.git', 'https:///host.test/team.git'],
    ['ext::ssh://git:pw@h/x', 'ext::ssh://git@h/x'],
    ['https::https:/user:secret@host.test/team.git', 'https::https:/host.test/team.git'],
  ];
  for (const [url, expected] of cases) {
    assert.equal(withoutCredentials(url), expected);
  }
  for (const same of [
    'ssh://git@host/org/p.git',
    'git@host:org/p.git',
    'C://team@work/plugins.git',
    'D:\\src\\a',
    // a URL in the path or the query is not the URL's user info
    'https://host.test/repo/https://build@mirror.test.git',
    'https://host.test/team.git?redirect=https://build@mirror.test/path',
    // a file URL has no credentials: this is the path /alice@work/team.git
    'file:///alice@work/team.git',
  ]) {
    assert.equal(withoutCredentials(same), same);
  }
  assert.equal(withoutCredentials(undefined), '');
});

test('redactingUi redacts the text and the detail of notifications, nothing else', () => {
  const calls = [];
  const record = (kind) => (...a) => {
    calls.push([kind, ...a]);
    return 'answer';
  };
  const base = {
    showInformationMessage: record('info'),
    showWarningMessage: record('warning'),
    showErrorMessage: record('error'),
    showInputBox: record('input'),
  };
  const ui = redactingUi(base);
  const url = 'https://user:secret@host.test/team.git';
  assert.equal(ui.showErrorMessage(`cannot reach ${url}`, 'Sync now'), 'answer');
  ui.showWarningMessage('problems', { modal: true, detail: `x: ${url}` }, 'Push anyway');
  ui.showInformationMessage(url);
  ui.showInputBox({ value: url });
  assert.deepEqual(calls, [
    ['error', 'cannot reach https://host.test/team.git', 'Sync now'],
    ['warning', 'problems', { modal: true, detail: 'x: https://host.test/team.git' }, 'Push anyway'],
    ['info', 'https://host.test/team.git'],
    ['input', { value: url }],
  ]);
});
