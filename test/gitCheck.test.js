'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkGit, gitCheckMessage, DOWNLOAD_URL } = require('../lib/gitCheck');

// A fake `run`: canned results by command line, recording the calls.
const fake = (answers) => {
  const calls = [];
  return {
    calls,
    run: async (args) => {
      calls.push(args.join(' '));
      return answers[args.join(' ')] || { code: 1, stdout: '', stderr: '' };
    },
  };
};

const version = (text) => ({ '--version': { code: 0, stdout: text, stderr: '' } });

test('checkGit: git is missing', async () => {
  const f = fake({ '--version': { code: 1, stdout: '', stderr: 'spawn nogit ENOENT' } });
  assert.deepEqual(await checkGit({ run: f.run, cwd: 'x' }), {
    status: 'missing',
    version: '',
    name: '',
    email: '',
    error: 'spawn nogit ENOENT',
  });
  assert.deepEqual(f.calls, ['--version']);
});

test('checkGit: git fails to run', async () => {
  const a = await checkGit({
    run: fake({ '--version': { code: 128, stdout: '', stderr: 'fatal: bad config line 1' } }).run,
    cwd: 'x',
  });
  assert.equal(a.status, 'error');
  assert.equal(a.error, 'fatal: bad config line 1');
  const b = await checkGit({ run: fake({ '--version': { code: 1, stdout: '', stderr: '' } }).run, cwd: 'x' });
  assert.equal(b.status, 'error');
  assert.equal(b.error, 'exit code 1');
});

test('checkGit: unexpected output of --version', async () => {
  const r = await checkGit({ run: fake(version('hello')).run, cwd: 'x' });
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'unexpected output of git --version: hello');
});

test('checkGit: a recent git with a name and an email', async () => {
  const f = fake({
    ...version('git version 2.47.0.windows.1'),
    'config --get user.name': { code: 0, stdout: 'Ann', stderr: '' },
    'config --get user.email': { code: 0, stdout: 'ann@example.com', stderr: '' },
  });
  assert.deepEqual(await checkGit({ run: f.run, cwd: 'x' }), {
    status: 'ok',
    version: '2.47.0',
    name: 'Ann',
    email: 'ann@example.com',
    error: '',
  });
});

test('checkGit: the minimum version is 2.38', async () => {
  const of = async (text) => checkGit({ run: fake(version(text)).run, cwd: 'x' });
  assert.equal((await of('git version 2.38.0')).status, 'ok');
  const old = await of('git version 2.37.9');
  assert.equal(old.status, 'old');
  assert.equal(old.version, '2.37.9');
  assert.equal((await of('git version 1.9.5')).status, 'old');
  assert.equal((await of('git version 3.0.0')).status, 'ok');
});

test('checkGit: no name and no email configured', async () => {
  const r = await checkGit({ run: fake(version('git version 2.47.0')).run, cwd: 'x' });
  assert.equal(r.status, 'ok');
  assert.equal(r.name, '');
  assert.equal(r.email, '');
});

test('gitCheckMessage: git is missing', () => {
  const missing = { status: 'missing', version: '', name: '', email: '', error: 'spawn git ENOENT' };
  assert.deepEqual(gitCheckMessage(missing), {
    level: 'error',
    message: 'git was not found (git is not on PATH). Install git 2.38 or later, then restart Cursor.',
    actions: ['downloadGit'],
  });
  assert.equal(
    gitCheckMessage(missing, { gitPath: 'C:\\tools\\git.exe', machine: 'devbox' }).message,
    'git was not found on devbox (git.path is C:\\tools\\git.exe). Install git 2.38 or later, then restart Cursor.',
  );
});

test('gitCheckMessage: git fails to run', () => {
  const r = { status: 'error', version: '', name: '', email: '', error: 'fatal: x' };
  assert.deepEqual(gitCheckMessage(r), { level: 'error', message: 'cannot run git: fatal: x', actions: [] });
});

test('gitCheckMessage: git is too old', () => {
  const r = { status: 'old', version: '2.30.1', name: 'Ann', email: 'a@b.c', error: '' };
  assert.deepEqual(gitCheckMessage(r), {
    level: 'warning',
    message:
      'git 2.30.1 is too old: 2.38 or later is needed to merge team updates with your local changes. Update git, then run Check git again.',
    actions: ['downloadGit'],
  });
});

test('gitCheckMessage: git is ready', () => {
  const r = { status: 'ok', version: '2.47.0', name: 'Ann', email: 'ann@example.com', error: '' };
  assert.deepEqual(gitCheckMessage(r, { machine: 'devbox' }), {
    level: 'info',
    message: 'git 2.47.0 is ready on devbox.',
    actions: [],
  });
  assert.equal(
    gitCheckMessage({ ...r, email: '' }).message,
    'git 2.47.0 is ready. To commit changes to a team repository, git also needs your name and email: git config --global user.name "Your Name" and git config --global user.email "you@example.com".',
  );
});

test('the download page', () => {
  assert.equal(DOWNLOAD_URL, 'https://git-scm.com/downloads');
});
