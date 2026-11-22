'use strict';

const { execFile } = require('child_process');

function makeGit(gitPath = 'git') {
  return function run(args, cwd, timeoutMs = 120000) {
    return new Promise((resolve) => {
      execFile(
        gitPath,
        args,
        {
          cwd,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
          timeout: timeoutMs,
        },
        (error, stdout, stderr) => {
          let code = 0;
          let err = String(stderr || '');
          if (error) {
            if (typeof error.code === 'number') {
              code = error.code;
            } else {
              code = 1;
              err = err || error.message;
            }
          }
          resolve({ code, stdout: String(stdout || '').trim(), stderr: err.trim() });
        },
      );
    });
  };
}

module.exports = { makeGit };
