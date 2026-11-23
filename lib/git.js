'use strict';

const { execFile, spawn } = require('child_process');

const MAX_BUFFER = 16 * 1024 * 1024;

// Progress output ends its updates with '\r': keep the last update of each line.
function cleanProgress(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const pieces = line.split('\r').map((s) => s.trimEnd()).filter((s) => s !== '');
      return pieces.length ? pieces[pieces.length - 1] : '';
    })
    .join('\n');
}

// run(args, cwd, timeoutMs, { trim, idleMs }): timeoutMs is a total limit and idleMs a limit on the time without
// output (0 = none). A stopped command resolves with timedOut ('idle' | 'total') and limitMs, and its whole process
// tree is killed (taskkill /T on Windows, the process group elsewhere).
function makeGit(gitPath = 'git') {
  return function run(args, cwd, timeoutMs = 120000, { trim = true, idleMs = 0 } = {}) {
    return new Promise((resolve) => {
      let timedOut;
      let limitMs;
      let overflow = false;
      let settled = false;
      let totalTimer = null;
      let idleTimer = null;

      const kill = () => {
        if (child.pid === undefined) {
          return;
        }
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      };
      const stop = (kind, ms) => {
        if (timedOut) {
          return;
        }
        timedOut = kind;
        limitMs = ms;
        kill();
      };
      const startIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop('idle', idleMs), idleMs);
      };
      const settle = (result) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
        resolve(result);
      };

      // On Linux/macOS git gets its own process group, so a stop kills the helpers it started (an orphaned
      // `git-remote-http` or `ssh` keeps the output pipe open and the command never ends); `execFile` ignores `detached`.
      const child = spawn(gitPath, args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const out = { chunks: [], bytes: 0 };
      const errOut = { chunks: [], bytes: 0 };
      const collect = (box) => (chunk) => {
        box.chunks.push(chunk);
        box.bytes += chunk.length;
        if (box.bytes > MAX_BUFFER && !overflow) {
          overflow = true;
          kill();
        }
      };
      child.stdout.on('data', collect(out));
      child.stderr.on('data', collect(errOut));

      child.on('error', (error) => {
        // a spawn failure (ENOENT...): there is no `close` to wait for. A later error (a failed kill) is ignored.
        if (child.pid === undefined) {
          settle({ code: 1, stdout: '', stderr: String(error.message).trim() });
        }
      });
      child.on('close', (exitCode) => {
        const stdoutText = Buffer.concat(out.chunks).toString('utf8');
        const cleaned = cleanProgress(Buffer.concat(errOut.chunks).toString('utf8')).trim();
        let code = exitCode === null ? 1 : exitCode;
        let err = cleaned;
        if (overflow) {
          code = code || 1;
          err = cleaned ? `${cleaned}\ngit output exceeded 16 MB` : 'git output exceeded 16 MB';
        }
        if (timedOut) {
          // the kill's own error says nothing: git's output and the reason it was stopped do
          code = code || 1;
          const note =
            timedOut === 'idle'
              ? `git stopped: no output for ${Math.round(limitMs / 1000)} s`
              : `git stopped: still running after ${Math.round(limitMs / 1000)} s`;
          err = cleaned ? `${cleaned}\n${note}` : note;
        }
        const result = {
          code,
          stdout: trim ? stdoutText.trim() : stdoutText,
          stderr: err.trim(),
        };
        if (timedOut) {
          result.timedOut = timedOut;
          result.limitMs = limitMs;
        }
        settle(result);
      });

      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end();
      }
      if (timeoutMs > 0) {
        totalTimer = setTimeout(() => stop('total', timeoutMs), timeoutMs);
      }
      if (idleMs > 0) {
        startIdle();
        for (const stream of [child.stdout, child.stderr]) {
          if (stream) {
            stream.on('data', startIdle);
          }
        }
      }
    });
  };
}

module.exports = { makeGit, cleanProgress };
