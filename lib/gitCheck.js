'use strict';

// The Check git command: whether git runs, is recent enough and knows who the user is, and what to tell them.

const { gitVersionOf } = require('./sync');

const MIN_VERSION = [2, 38];
const DOWNLOAD_URL = 'https://git-scm.com/downloads';

// run(args, cwd) -> { code, stdout, stderr } (see makeGit). status: 'missing' | 'error' | 'old' | 'ok'.
async function checkGit({ run, cwd }) {
  const v = await run(['--version'], cwd);
  if (v.code !== 0) {
    const stderr = (v.stderr || '').trim();
    return {
      status: /\bENOENT\b/.test(v.stderr || '') ? 'missing' : 'error',
      version: '',
      name: '',
      email: '',
      error: stderr || `exit code ${v.code}`,
    };
  }
  const ver = gitVersionOf(v.stdout);
  if (!ver) {
    return {
      status: 'error',
      version: '',
      name: '',
      email: '',
      error: `unexpected output of git --version: ${v.stdout}`,
    };
  }
  const old = ver[0] < MIN_VERSION[0] || (ver[0] === MIN_VERSION[0] && ver[1] < MIN_VERSION[1]);
  const read = async (key) => {
    const r = await run(['config', '--get', key], cwd);
    return r.code === 0 ? (r.stdout || '').trim() : '';
  };
  const name = await read('user.name');
  const email = await read('user.email');
  return { status: old ? 'old' : 'ok', version: ver.join('.'), name, email, error: '' };
}

// -> { level: 'info' | 'warning' | 'error', message, actions: ['downloadGit'] | [] }
function gitCheckMessage(result, { gitPath = 'git', machine = '' } = {}) {
  const where = machine ? ` on ${machine}` : '';
  const pathText = gitPath === 'git' ? 'git is not on PATH' : `git.path is ${gitPath}`;
  switch (result.status) {
    case 'missing':
      return {
        level: 'error',
        message: `git was not found${where} (${pathText}). Install git 2.38 or later, then restart Cursor.`,
        actions: ['downloadGit'],
      };
    case 'old':
      return {
        level: 'warning',
        message: `git ${result.version}${where} is too old: 2.38 or later is needed to merge team updates with your local changes. Update git, then run Check git again.`,
        actions: ['downloadGit'],
      };
    case 'ok': {
      let message = `git ${result.version} is ready${where}.`;
      if (!result.name || !result.email) {
        message +=
          ' To commit changes to a team repository, git also needs your name and email: git config --global user.name "Your Name" and git config --global user.email "you@example.com".';
      }
      return { level: 'info', message, actions: [] };
    }
    default:
      return { level: 'error', message: `cannot run git${where}: ${result.error}`, actions: [] };
  }
}

module.exports = { checkGit, gitCheckMessage, DOWNLOAD_URL, MIN_VERSION };
