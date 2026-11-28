'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGit, cleanProgress } = require('../lib/git');
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

async function stopCommandWithChild(t, stdio) {
  const script =
    "const child = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], " +
    `{ stdio: ${JSON.stringify(stdio)} }); ` +
    "require('fs').writeSync(1, String(child.pid)); setTimeout(() => {}, 30000);";
  // The PID reports readiness and resets the idle timer. Allow time for both processes to start on CI.
  const result = await fake(['-e', script], process.cwd(), 0, { idleMs: 3000 });
  const pid = Number(result.stdout);
  assert.ok(
    Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff && pid !== process.pid,
    `expected a child PID, got ${JSON.stringify(result.stdout)} (${result.stderr})`,
  );
  t.after(() => {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  });
  assert.equal(result.timedOut, 'idle');
  return pid;
}

test('stopping a command kills its child processes too', async (t) => {
  const pid = await stopCommandWithChild(t, 'ignore');
  // the kill is not awaited: give it up to 10 s under a loaded machine
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

test("a child process holding the output open doesn't keep a stopped command waiting", async (t) => {
  // the grandchild shares the stderr pipe (stdio: 'inherit') and outlives git unless the whole tree is killed
  const started = Date.now();
  await stopCommandWithChild(t, 'inherit');
  assert.ok(Date.now() - started < 10000, `took ${Date.now() - started} ms`);
});

test('a git that cannot start reports the error', async (t) => {
  const dir = tmpDir();
  t.after(() => rmDir(dir));
  const r = await makeGit(path.join(dir, 'no-such-git'))(['--version'], process.cwd());
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /ENOENT/);
});

test('output over 16 MB stops the command', async () => {
  const script = 'process.stdout.write(Buffer.alloc(17 * 1024 * 1024, 97)); setTimeout(() => {}, 30000);';
  const r = await fake(['-e', script], process.cwd(), 20000);
  assert.notEqual(r.code, 0);
  assert.equal(r.timedOut, undefined);
  assert.ok(r.stderr.endsWith('git output exceeded 16 MB'), r.stderr);
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
