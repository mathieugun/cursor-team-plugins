'use strict';

const { execFile } = require('child_process');

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
// tree is killed.
function makeGit(gitPath = 'git') {
  return function run(args, cwd, timeoutMs = 120000, { trim = true, idleMs = 0 } = {}) {
    return new Promise((resolve) => {
      let timedOut;
      let limitMs;
      let totalTimer = null;
      let idleTimer = null;

      const stop = (kind, ms) => {
        if (timedOut) {
          return;
        }
        timedOut = kind;
        limitMs = ms;
        if (child.pid === undefined) {
          return;
        }
        if (process.platform === 'win32') {
          execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
        } else {
          child.kill('SIGKILL');
        }
      };
      const startIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop('idle', idleMs), idleMs);
      };

      const child = execFile(
        gitPath,
        args,
        {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          clearTimeout(totalTimer);
          clearTimeout(idleTimer);
          const cleaned = cleanProgress(stderr || '').trim();
          let code = 0;
          let err = cleaned;
          if (error) {
            if (typeof error.code === 'number') {
              code = error.code;
            } else {
              code = 1;
              err = err || error.message;
            }
          }
          if (timedOut) {
            // the kill's own error (`Command failed: ...`) says nothing: git's output and the reason it was stopped
            code = code || 1;
            const note =
              timedOut === 'idle'
                ? `git stopped: no output for ${Math.round(limitMs / 1000)} s`
                : `git stopped: still running after ${Math.round(limitMs / 1000)} s`;
            err = cleaned ? `${cleaned}\n${note}` : note;
          }
          const result = {
            code,
            stdout: trim ? String(stdout || '').trim() : String(stdout || ''),
            stderr: err.trim(),
          };
          if (timedOut) {
            result.timedOut = timedOut;
            result.limitMs = limitMs;
          }
          resolve(result);
        },
      );

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
