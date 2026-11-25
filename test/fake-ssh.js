'use strict';

// A stand-in for ssh, run by git through core.sshCommand (see remote-helpers.js `fakeSshCommand`):
//   node fake-ssh.js <mode> <ssh arguments...>
// unknown | changed | auth print what the real ssh prints and exit 255; silent never answers and never exits.
// With FAKE_SSH_PID_FILE set, the process id is written there first (a test checks that the process is gone).

const fs = require('fs');

const mode = process.argv[2];

if (process.env.FAKE_SSH_PID_FILE) {
  fs.writeFileSync(process.env.FAKE_SSH_PID_FILE, String(process.pid));
}

const CHANGED_KEY = [
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
  '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
  'IT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!',
  'Host key for example.test has changed and you have requested strict checking.',
  'Host key verification failed.',
].join('\n');

switch (mode) {
  case 'unknown':
    process.stderr.write('Host key verification failed.\n', () => process.exit(255));
    break;
  case 'changed':
    process.stderr.write(`${CHANGED_KEY}\n`, () => process.exit(255));
    break;
  case 'auth':
    process.stderr.write('git@example.test: Permission denied (publickey).\n', () => process.exit(255));
    break;
  case 'silent':
    setInterval(() => {}, 1 << 30);
    break;
  default:
    process.stderr.write(`fake-ssh: unknown mode ${mode}\n`, () => process.exit(2));
}
