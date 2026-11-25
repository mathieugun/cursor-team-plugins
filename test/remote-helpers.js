'use strict';

// Stand-ins for the team's server, for remote.test.js: a fake ssh (core.sshCommand) and a node http server that runs
// `git http-backend` behind basic auth. The server runs in the test process: a synchronous git against it would block
// the event loop and deadlock, so tests use only async git (makeGit) against its URL.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { writeFile, git, commitAll } = require('./helpers');

const fwd = (p) => p.split(path.sep).join('/');

// The value of core.sshCommand (git runs it through its shell, so the paths use forward slashes).
function fakeSshCommand(mode) {
  return `ELECTRON_RUN_AS_NODE=1 "${fwd(process.execPath)}" "${fwd(path.join(__dirname, 'fake-ssh.js'))}" ${mode}`;
}

// Keeps git away from the user's configuration (and Git Credential Manager) and a real ssh away from their known_hosts.
function isolateGit(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const config = path.join(dir, 'gitconfig');
  fs.writeFileSync(config, '[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
}

// Wraps a makeGit runner so that every command gets `-c <pair>` for each pair.
function withConfig(run, pairs) {
  return (args, ...rest) => run([...pairs.flatMap((p) => ['-c', p]), ...args], ...rest);
}

function credentialHelper(user, pass) {
  return `credential.helper=!f() { echo username=${user}; echo password=${pass}; }; f`;
}

// Resolves true when the process is gone, false after ms.
async function waitGone(pid, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err.code === 'ESRCH') {
        return true;
      }
    }
    if (Date.now() >= end) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A bare repository <root>/<name> with branch main and one commit (a.txt). Local paths only: synchronous git is fine.
function makeServedRepo(root, name = 'team.git') {
  const bare = path.join(root, name);
  const work = path.join(root, `${name}.work`);
  fs.mkdirSync(bare, { recursive: true });
  git(['init', '--bare', '-b', 'main'], bare);
  fs.mkdirSync(work, { recursive: true });
  git(['init', '-b', 'main'], work);
  writeFile(work, 'a.txt', 'a\n');
  commitAll(work, 'first');
  git(['remote', 'add', 'origin', fwd(bare)], work);
  git(['push', 'origin', 'main'], work);
  return bare;
}

// { url(name), close() }: serves the bare repositories under root over http://127.0.0.1:<port>/<name> with basic auth.
// readOnly: no REMOTE_USER, so a push is refused with 403.
function startGitServer({ root, user = 'u', pass = 'p', readOnly = false }) {
  const expected = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== expected) {
      req.resume();
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
      res.end();
      return;
    }
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const env = {
      ...process.env,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: decodeURIComponent(parsed.pathname),
      QUERY_STRING: parsed.search.replace(/^\?/, ''),
      REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] || '',
      REMOTE_ADDR: '127.0.0.1',
    };
    if (!readOnly) {
      env.REMOTE_USER = user;
    }
    if (req.headers['content-encoding']) {
      env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    }
    if (req.headers['git-protocol']) {
      env.GIT_PROTOCOL = req.headers['git-protocol'];
    }
    const cgi = spawn('git', ['http-backend'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    cgi.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    });
    cgi.stderr.resume();
    cgi.stdin.on('error', () => {});
    req.pipe(cgi.stdin);

    let head = Buffer.alloc(0);
    let headDone = false;
    cgi.stdout.on('data', (chunk) => {
      if (headDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        return;
      }
      headDone = true;
      let status = 200;
      const headers = {};
      for (const line of head.slice(0, end).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i < 0) {
          continue;
        }
        const key = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (key.toLowerCase() === 'status') {
          status = parseInt(value, 10) || 200;
        } else {
          headers[key] = value;
        }
      }
      res.writeHead(status, headers);
      const rest = head.slice(end + 4);
      if (rest.length > 0) {
        res.write(rest);
      }
    });
    cgi.stdout.on('end', () => res.end());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: (name) => `http://127.0.0.1:${port}/${name}`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            if (server.closeAllConnections) {
              server.closeAllConnections();
            }
          }),
      });
    });
  });
}

module.exports = { fakeSshCommand, isolateGit, withConfig, credentialHelper, waitGone, makeServedRepo, startGitServer };
