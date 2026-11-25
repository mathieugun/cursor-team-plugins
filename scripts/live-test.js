'use strict';

// Runs the live scenarios (test/live/*.live.js) in an isolated Cursor instance: one launch per scenario, with its own
// profile and extensions folder under the temp folder. The extension is loaded from this working tree in Test mode
// (--extensionDevelopmentPath + --extensionTestsPath), nothing is installed and the user's profile is never touched.
//   node scripts/live-test.js [scenario ...] [--timeout <seconds>]
// Cursor: CURSOR_EXE, else the runtime running this script when it is Cursor's, else the Windows default install.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { removeTree } = require('../lib/sync');
const { makeTestRepo } = require('./make-test-repo');
const { fakeSshCommand } = require('../test/remote-helpers');

const REPO_ROOT = path.resolve(__dirname, '..');
const LIVE_DIR = path.join(REPO_ROOT, 'test', 'live');
const DEFAULT_TIMEOUT_SEC = 90;

const fwd = (p) => p.split(path.sep).join('/');

function findCursor() {
  if (process.env.CURSOR_EXE) {
    return process.env.CURSOR_EXE;
  }
  if (/^(cursor|cursor\.exe)$/i.test(path.basename(process.execPath))) {
    return process.execPath;
  }
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const exe = path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe');
    if (fs.existsSync(exe)) {
      return exe;
    }
  }
  console.error('live-test: Cursor not found: set CURSOR_EXE to the Cursor executable');
  process.exit(2);
}

// Removes a folder, trying again for a while: the processes of a Cursor that just exited may still hold files.
async function wipe(dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      removeTree(dir);
      return;
    } catch (err) {
      if (attempt >= 20) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

function newestSession(logsDir) {
  try {
    const names = fs
      .readdirSync(logsDir)
      .filter((n) => fs.statSync(path.join(logsDir, n)).isDirectory())
      .sort();
    return names.length ? path.join(logsDir, names[names.length - 1]) : null;
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function runScenario(name, { cursor, root, timeoutOpt }) {
  const file = path.join(LIVE_DIR, `${name}.live.js`);
  const scenario = require(file);
  const out = path.join(root, 'out', name);
  const dirs = { ud: path.join(root, 'ud'), ext: path.join(root, 'ext'), repos: path.join(root, 'repos'), ws: path.join(root, 'ws') };
  for (const dir of Object.values(dirs)) {
    await wipe(dir);
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(dirs.ud, 'User'), { recursive: true });
  fs.mkdirSync(out, { recursive: true });

  const ctx = {
    root,
    repos: dirs.repos,
    ws: dirs.ws,
    repoRoot: REPO_ROOT,
    makeTestRepo,
    fakeSshCommand,
    url: fwd,
  };
  const s = (await scenario.setup(ctx)) || {};
  fs.writeFileSync(path.join(dirs.ud, 'User', 'settings.json'), JSON.stringify({ ...s.settings }, null, 2));
  if (s.workspaceSettings) {
    fs.mkdirSync(path.join(dirs.ws, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(dirs.ws, '.vscode', 'settings.json'), JSON.stringify(s.workspaceSettings, null, 2));
  }
  const dataFile = path.join(out, 'data.json');
  const resultFile = path.join(out, 'result.json');
  fs.writeFileSync(dataFile, JSON.stringify(s.data || {}));

  const args = [
    `--user-data-dir=${dirs.ud}`,
    `--extensions-dir=${dirs.ext}`,
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    `--extensionTestsPath=${path.join(LIVE_DIR, 'runner.js')}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--new-window',
    dirs.ws,
  ];
  const env = {
    ...process.env,
    ...s.env,
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    TEAM_PLUGINS_LIVE_SCENARIO: file,
    TEAM_PLUGINS_LIVE_RESULT: resultFile,
    TEAM_PLUGINS_LIVE_DATA: dataFile,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const timeoutSec = scenario.timeoutSec || timeoutOpt || DEFAULT_TIMEOUT_SEC;
  const started = Date.now();
  const logFd = fs.openSync(path.join(out, 'cursor.log'), 'w');
  const child = spawn(cursor, args, {
    env,
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
    detached: process.platform !== 'win32',
  });
  let killed = false;
  const exited = new Promise((resolve) => {
    child.on('error', () => resolve(null));
    child.on('exit', (code) => resolve(code));
  });
  const timer = setTimeout(() => {
    killed = true;
    killTree(child.pid);
  }, timeoutSec * 1000);
  const code = await exited;
  clearTimeout(timer);
  fs.closeSync(logFd);

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const result = readJson(resultFile);
  let failure = null;
  if (!result) {
    failure = killed ? `timed out after ${timeoutSec} s` : `no result (Cursor exited with code ${code}; see ${path.join(out, 'cursor.log')})`;
  } else if (!result.ok || killed) {
    const parts = [];
    if (result.error) {
      parts.push(String(result.error).split('\n')[0]);
    }
    const steps = result.steps || [];
    if (steps.length) {
      parts.push(`last step: ${steps[steps.length - 1]}`);
    }
    if (killed) {
      parts.push(`timed out after ${timeoutSec} s`);
    }
    failure = parts.join('; ') || 'failed';
  }
  if (failure) {
    const session = newestSession(path.join(dirs.ud, 'logs'));
    if (session) {
      try {
        fs.cpSync(session, path.join(out, 'logs'), { recursive: true });
      } catch (err) {
        console.error(`live-test: cannot copy the logs: ${err.message}`);
      }
    }
    console.log(`FAIL ${name} (${seconds} s): ${failure}`);
    console.log(`  details: ${out}`);
    return false;
  }
  console.log(`PASS ${name} (${seconds} s)`);
  return true;
}

async function main() {
  const argv = process.argv.slice(2);
  let timeoutOpt = 0;
  const names = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--timeout') {
      timeoutOpt = Number(argv[++i]);
      if (!(timeoutOpt > 0)) {
        console.error('usage: node scripts/live-test.js [scenario ...] [--timeout <seconds>]');
        process.exit(2);
      }
    } else {
      names.push(argv[i]);
    }
  }
  const all = fs
    .readdirSync(LIVE_DIR)
    .filter((n) => n.endsWith('.live.js'))
    .map((n) => n.slice(0, -'.live.js'.length))
    .sort();
  const chosen = names.length ? names : all;
  for (const n of chosen) {
    if (!all.includes(n)) {
      console.error(`live-test: no scenario ${n} (have: ${all.join(', ')})`);
      process.exit(2);
    }
  }

  const cursor = findCursor();
  const tmp = path.resolve(os.tmpdir());
  const root = path.resolve(tmp, 'tp-live');
  const rel = path.relative(tmp, root);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    console.error(`live-test: ${root} is not inside ${tmp}`);
    process.exit(2);
  }
  fs.mkdirSync(root, { recursive: true });
  await wipe(path.join(root, 'out'));
  fs.writeFileSync(
    path.join(root, 'gitconfig'),
    '[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n',
  );

  let passed = 0;
  for (const name of chosen) {
    if (await runScenario(name, { cursor, root, timeoutOpt })) {
      passed++;
    }
  }
  console.log(`${passed}/${chosen.length} scenarios passed`);
  process.exit(passed === chosen.length ? 0 : 1);
}

main().catch((err) => {
  console.error(`live-test: ${err.stack || err}`);
  process.exit(2);
});
