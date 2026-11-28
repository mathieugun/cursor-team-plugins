'use strict';

// Classifies the failures of git commands that talk to the team repository, and words them with what to do about them.
// Pure: never requires vscode.

const RULES = [
  ['hostKeyChanged', /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for \S+ has changed/i],
  ['hostKeyUnknown', /Host key verification failed/i],
  [
    'unreachable',
    /Could not resolve host|Could not resolve hostname|Failed to connect to|Connection refused|Connection timed out|Network is unreachable|No route to host|Operation timed out|Could not connect to server|Temporary failure in name resolution|Name or service not known|No such host is known/i,
  ],
  ['sshAuth', /Permission denied \((?:publickey|[^)]*keyboard-interactive)|incorrect passphrase/i],
  ['credentials', /could not read (?:Username|Password)|Cannot prompt because user interactivity has been disabled/i],
  [
    'authFailed',
    /Authentication failed for|Invalid username or (?:password|token)|HTTP Basic: Access denied|returned error: 401/i,
  ],
  ['pushRejected', /\[remote rejected\]/i],
  ['notFastForward', /\[rejected\].*\((?:fetch first|non-fast-forward)\)/i],
  ['denied', /returned error: 403|Permission to \S+ denied|You are not allowed to push|access denied/i],
  ['branchNotFound', /Remote branch \S+ not found in upstream|couldn't find remote ref/i],
  [
    'notFound',
    /does not appear to be a git repository|repository '[^']*' does not exist|Repository not found|repository '[^']*' not found|returned error: 404|could not be found or you don't have permission|TF401019/i,
  ],
];

// The reason a git command failed ('timeout', 'hostKeyUnknown', ...), or null when it is not a known one.
function classify(result) {
  if (result && result.timedOut) {
    return 'timeout';
  }
  const stderr = String((result && result.stderr) || '');
  for (const [reason, regex] of RULES) {
    if (regex.test(stderr)) {
      return reason;
    }
  }
  return null;
}

// The host of a git URL, '' for a local path. The credentials go first (withoutCredentials): no character of a password
// (a raw `@`, a space) can end up in the host, nor a query of a URL without a path. Git's `<transport>::` prefix and
// extra slashes (`https:///host`) are skipped.
function remoteHost(url) {
  const text = withoutCredentials(url).replace(TRANSPORT, '');
  const m = /^([a-z][a-z0-9+.-]*):\/\/+(?:[^/?#]*@)?(\[[^\]]+\]|[^:/?#]*)/i.exec(text);
  if (m) {
    return m[1].toLowerCase() === 'file' ? '' : m[2];
  }
  if (!/^[a-z]:[\\/]/i.test(text)) {
    const s = /^(?:[^@/\\]+@)?([^:/\\]+):/.exec(text);
    if (s && s[1].length > 1) {
      return s[1];
    }
  }
  return '';
}

function detailOf(reason, stderr) {
  const lines = String(stderr || '').split(/\r?\n/);
  if (reason === 'pushRejected') {
    // the server's own words: its `remote: error:` line first, never a progress line of --progress
    const remote = lines
      .map((line) => /^remote:(.*)$/.exec(line))
      .filter((m) => m && m[1].trim() !== '')
      .map((m) => m[1].trim())
      .filter((text) => !/\d+% \(\d+\/\d+\)|^Total \d+/.test(text));
    const said = remote.find((text) => /^error:/i.test(text)) || remote[0];
    if (said) {
      return said;
    }
    for (const line of lines) {
      if (/\[remote rejected\]/i.test(line)) {
        const p = /\(([^)]*)\)\s*$/.exec(line);
        return p ? p[1] : '';
      }
    }
    return '';
  }
  const rule = RULES.find(([name]) => name === reason);
  if (!rule) {
    return '';
  }
  for (const line of lines) {
    if (rule[1].test(line)) {
      return line.trim().replace(/^(?:fatal: |error: |remote: |ssh: )/, '');
    }
  }
  return '';
}

// { message, actions } for a reason. The message has no prefix (the extension adds `Team plugins: `); actions are ids
// the extension maps to buttons. `op` is 'read', 'push' (push to the followed branch) or 'branch' (push of a new
// branch).
function describeRemote(reason, { url, branch, op = 'read', detail = '', limitMs } = {}) {
  const H = remoteHost(url) || url;
  const D = detail ? ` (${detail})` : '';
  const B = branch || 'the branch';
  switch (reason) {
    case 'timeout':
      return {
        message: `no answer from ${H} for ${Math.round(limitMs / 1000)} s, so git was stopped. If it's an SSH URL, SSH may be waiting for a question it can't ask here (host key, passphrase): open a terminal to answer it, or use the ssh that comes with Git.`,
        actions: ['terminal', 'retry'],
      };
    case 'hostKeyChanged':
      return {
        message: `the SSH host key of ${H} has changed. It happens when the server is reinstalled, or in an attack: ask the server's admin for the new fingerprint before you remove the old key (ssh-keygen -R ${H}). Nothing is synced until then.`,
        actions: ['showLog'],
      };
    case 'hostKeyUnknown':
      return {
        message: `SSH does not know the host key of ${H} yet (first connection). Open a terminal, check the fingerprint it shows against the one the server's admin gives you, answer yes, then Sync now.`,
        actions: ['terminal', 'retry'],
      };
    case 'unreachable':
      return {
        message: `cannot reach ${H}${D}. Offline, VPN down or DNS? The plugins already cloned keep working; the next update tries again.`,
        actions: ['retry'],
      };
    case 'sshAuth':
      return {
        message: `SSH could not log in to ${H}: no key, a key the server doesn't accept, or a key with a passphrase (not supported yet: use a key without one for this server). Open a terminal to see what SSH says, then Sync now.`,
        actions: ['terminal', 'retry'],
      };
    case 'credentials':
      return {
        message: `git has no stored credentials for ${H} and can't ask for them in the background. Open a terminal and sign in once (git keeps them if a credential helper is set up: Git Credential Manager on Windows), then Sync now.`,
        actions: ['terminal', 'retry'],
      };
    case 'authFailed':
      return {
        message: `${H} refused your credentials (wrong password, or an expired or revoked token). Open a terminal and sign in again, then Sync now.`,
        actions: ['terminal', 'retry'],
      };
    case 'pushRejected':
      return op === 'branch'
        ? {
            message: `the server refused the new branch ${B}${D}: a server rule on branch names, or on who may create branches. Try another branch name, or ask the repository's admins.`,
            actions: ['pushToBranch', 'showLog'],
          }
        : {
            message: `the server refused the push to ${B}${D}: a protected branch or a server rule. Open a pull request instead: your changes go to a new branch, and the hosting service's page to propose them opens.`,
            actions: ['pullRequest', 'showLog'],
          };
    case 'notFastForward':
      return { message: `someone pushed to ${B} in the meantime: try again.`, actions: ['retryPush'] };
    case 'denied':
      if (op === 'push') {
        return {
          message: `you have no write access to ${url}${D}. Open a pull request if you may create branches, or ask for write access.`,
          actions: ['pullRequest', 'showLog'],
        };
      }
      if (op === 'branch') {
        return {
          message: `you have no write access to ${url}${D}: the server refused a new branch too. Ask for write access (pull requests from a fork are not supported).`,
          actions: ['showLog'],
        };
      }
      return {
        message: `you have no access to ${url}${D}. Ask for access, or check its URL in teamPlugins.repositories.`,
        actions: ['repositories', 'showLog'],
      };
    case 'branchNotFound':
      return {
        message: `branch ${B} not found on ${url}. Check its branch in teamPlugins.repositories (none: the repository's default branch).`,
        actions: ['repositories'],
      };
    case 'notFound':
      return {
        message: `repository ${url} not found, or you have no access to it. Check its URL in teamPlugins.repositories.`,
        actions: ['repositories', 'showLog'],
      };
    default:
      return { message: '', actions: [] };
  }
}

// The result of a failed network git command: { kind: 'offline' | 'error', reason, message, actions }, or
// { kind: 'error', message: fallbackMessage } when the failure is not a known one.
function remoteResult(result, { url, branch, op } = {}, fallbackMessage) {
  const reason = classify(result);
  if (!reason) {
    return { kind: 'error', message: fallbackMessage };
  }
  return {
    kind: reason === 'unreachable' ? 'offline' : 'error',
    reason,
    ...describeRemote(reason, {
      url,
      branch,
      op,
      detail: detailOf(reason, result.stderr),
      limitMs: result.limitMs,
    }),
  };
}

// Git's explicit transport prefix: `https::https://host/x` is an HTTPS URL.
const TRANSPORT = /^[a-z][a-z0-9+.-]*::/i;

// A token is often the user part of an HTTPS URL; an SSH user name is no secret and SSH needs it, so only its password
// goes. A scheme has two characters at least (`C://dir@x/` is a Windows path) and may be followed by one slash or more
// than two (git reads `https:///user:pw@host/x` and `https::https:/user:pw@host/x` as HTTPS URLs with that user info).
// A `file:` URL has no credentials: `file:///alice@work/x` is a path, left as it is.
function stripUserinfo(all, scheme, userinfo) {
  if (/(?:^|::)file:/i.test(scheme)) {
    return all;
  }
  if (/(?:^|::)(?:ssh|git\+ssh|ssh\+git):\/+$/i.test(scheme)) {
    return `${scheme}${userinfo.split(':')[0]}@`;
  }
  return scheme;
}

// One URL (a setting, a repository's name, its host) without its credentials: the user info is everything up to the last
// `@` before the first `/`, `?` or `#` after the scheme's slashes (curl accepts any other character in a password,
// spaces and quotes included). Git's `<transport>::` prefix is kept. Nothing after the authority is touched
// (`https://h/r?u=https://b@m/p` keeps its query).
function withoutCredentials(url) {
  if (url === null || url === undefined) {
    return '';
  }
  return String(url).replace(/^((?:[a-z][a-z0-9+.-]*::)?[a-z][a-z0-9+.-]+:\/+)([^/?#]*)@/i, stripUserinfo);
}

// Free text (the log, a message, a notification) with the credentials of every URL in it removed. A URL can start
// anywhere and its user info runs to the last `@` before a line break, `/`, `?` or `#` (a password pasted with a space
// is still removed): it may remove more than the user info (`https://a.test and b@c.test/x` -> `https://c.test/x`)
// but never less.
function redactUrls(text) {
  if (text === null || text === undefined) {
    return '';
  }
  return String(text).replace(/([a-z][a-z0-9+.-]+:\/+)([^\r\n/?#]*)@/gi, stripUserinfo);
}

// The last net for what the user sees (and pastes into a bug report): `base` (vscode.window's dialogs or the Test-mode
// recorder) with every notification's text, and the `detail` of a modal dialog's options, passed through redactUrls.
function redactingUi(base) {
  const options = (o) =>
    o && typeof o === 'object' && typeof o.detail === 'string' ? { ...o, detail: redactUrls(o.detail) } : o;
  const wrap = (name) => (text, ...rest) => base[name](redactUrls(text), ...rest.map(options));
  return {
    ...base,
    showInformationMessage: wrap('showInformationMessage'),
    showWarningMessage: wrap('showWarningMessage'),
    showErrorMessage: wrap('showErrorMessage'),
  };
}

module.exports = { classify, remoteHost, describeRemote, remoteResult, withoutCredentials, redactUrls, redactingUi };
