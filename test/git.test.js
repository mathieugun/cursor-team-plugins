'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGit, cleanProgress } = require('../lib/git');
const fs = require('fs');
const path = require('path');
const { gitAvailable, tmpDir, rmDir } = require('./helpers');

test('run trims stdout unless asked not to', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const run = makeGit('git');
  const trimmed = await run(['--version'], process.cwd());
  assert.equal(trimmed.code, 0);
  assert.ok(trimmed.stdout.startsWith('git version'));
  assert.ok(!trimmed.stdout.endsWith('\n'));
  const raw = await run(['--version'], process.cwd(), undefined, { trim: false });
  assert.equal(raw.code, 0);
  assert.ok(raw.stdout.endsWith('\n'));
});

// A fake git: node itself, running a script.
const fake = makeGit(process.execPath);

test('an idle command is stopped', async () => {
  const started = Date.now();
  const r = await fake(['-e', 'setTimeout(() => {}, 30000)'], process.cwd(), 0, { idleMs: 1000 });
  assert.equal(r.timedOut, 'idle');
  assert.equal(r.limitMs, 1000);
  assert.notEqual(r.code, 0);
  assert.ok(r.stderr.endsWith('git stopped: no output for 1 s'), r.stderr);
  assert.ok(Date.now() - started < 10000);
});

test('output keeps an idle limit from firing', async () => {
  const script = "let n = 0; const t = setInterval(() => { process.stderr.write('.'); if (++n === 8) clearInterval(t); }, 200);";
  const r = await fake(['-e', script], process.cwd(), 0, { idleMs: 600 });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, undefined);
});

test('a command running too long is stopped', async () => {
  const r = await fake(['-e', "setInterval(() => process.stderr.write('.'), 100)"], process.cwd(), 800);
  assert.equal(r.timedOut, 'total');
  assert.ok(r.stderr.endsWith('git stopped: still running after 1 s'), r.stderr);
});

test('stopping a command kills its child processes too', async (t) => {
  if (process.platform !== 'win32') {
    return t.skip('taskkill /T is the Windows path');
  }
  const pidFile = path.join(tmpDir(), 'child.pid');
  t.after(() => {
    try {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
    } catch {
      // already gone
    }
    rmDir(path.dirname(pidFile));
  });
  const script =
    "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' }); " +
    "require('fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(c.pid)); setTimeout(() => {}, 30000);";
  const r = await fake(['-e', script], process.cwd(), 0, { idleMs: 1000 });
  assert.equal(r.timedOut, 'idle');
  // taskkill is not awaited: give it up to 10 s under a loaded machine
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code !== 'ESRCH';
    }
  };
  for (let i = 0; i < 100 && alive(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(alive(), false, `child ${pid} still runs`);
});

test('git runs without prompts', async () => {
  const script = 'console.log(JSON.stringify({ g: process.env.GCM_INTERACTIVE, t: process.env.GIT_TERMINAL_PROMPT }))';
  const r = await fake(['-e', script], process.cwd());
  assert.deepEqual(JSON.parse(r.stdout), { g: 'never', t: '0' });
});

test('stdin is closed', async () => {
  const r = await fake(['-e', "process.stdin.resume(); process.stdin.on('end', () => console.log('eof'));"], process.cwd(), 10000);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, 'eof');
});

test('cleanProgress keeps the last update of each line', () => {
  assert.equal(
    cleanProgress(
      'Cloning into x...\nremote: Counting objects:  50% (1/2)   \rremote: Counting objects: 100% (2/2), done.   \nReceiving objects: 100%\r\n',
    ),
    'Cloning into x...\nremote: Counting objects: 100% (2/2), done.\nReceiving objects: 100%\n',
  );
});
