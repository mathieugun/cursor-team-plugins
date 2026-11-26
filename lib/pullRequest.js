'use strict';

// The hosting service's "new pull request" page of a pushed branch. Pure: never requires vscode.

const enc = encodeURIComponent;
const encPath = (b) => b.split('/').map(encodeURIComponent).join('/');

function cleanPath(path) {
  return String(path || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

// { host, path } of a git URL (host lower-cased, path without leading slash, trailing slash and `.git`), or null for a
// local path or a scheme that is not http, https, ssh or git.
function parseRemote(url) {
  const text = String(url || '').trim();
  let host;
  let path;
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::\d+)?(?:\/(.*))?$/i.exec(text);
  if (m) {
    if (!['http', 'https', 'ssh', 'git'].includes(m[1].toLowerCase())) {
      return null;
    }
    host = m[2].toLowerCase();
    path = m[3] || '';
  } else {
    const s = /^(?:[^@/\\]+@)?([^:/\\]+):(.*)$/.exec(text);
    if (!s || text.includes('://') || /^[a-z]:[\\/]/i.test(text) || s[1].length < 2) {
      return null;
    }
    host = s[1].toLowerCase();
    path = s[2];
  }
  path = cleanPath(path);
  return path ? { host, path } : null;
}

// The first URL of a `remote:` line of the push output that names the branch (GitHub Enterprise, GitLab, Bitbucket
// Cloud and Azure DevOps Services print the page of the new pull request when a branch is created).
function printedUrl(pushOutput, branch) {
  const encoded = enc(branch);
  for (const line of String(pushOutput || '').split(/\r?\n|\r/)) {
    const r = /^remote:(.*)$/.exec(line);
    if (!r) {
      continue;
    }
    for (const found of r[1].match(/https?:\/\/[^\s'"<>]+/g) || []) {
      const url = found.replace(/[.,;:)]+$/, '');
      if (url.includes(branch) || url.includes(encoded)) {
        return url;
      }
    }
  }
  return null;
}

function builtUrl(r, branch, target) {
  const segs = r.path.split('/');
  if (r.host === 'github.com' && segs.length === 2) {
    return `https://github.com/${segs[0]}/${segs[1]}/compare/${encPath(target)}...${encPath(branch)}?quick_pull=1`;
  }
  if (r.host === 'gitlab.com' && segs.length >= 2) {
    return `https://gitlab.com/${r.path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(branch)}&merge_request%5Btarget_branch%5D=${enc(target)}`;
  }
  let base = null;
  if (r.host === 'dev.azure.com' && segs.length === 4 && segs[2] === '_git') {
    base = `https://dev.azure.com/${r.path}`;
  } else if (r.host === 'ssh.dev.azure.com' && segs.length === 4 && segs[0] === 'v3') {
    base = `https://dev.azure.com/${segs[1]}/${segs[2]}/_git/${segs[3]}`;
  } else if (r.host === 'vs-ssh.visualstudio.com' && segs.length === 4 && segs[0] === 'v3') {
    base = `https://${segs[1]}.visualstudio.com/${segs[2]}/_git/${segs[3]}`;
  } else if (
    r.host.endsWith('.visualstudio.com') &&
    (segs.length === 3 || segs.length === 4) &&
    segs[segs.length - 2] === '_git'
  ) {
    base = `https://${r.host}/${r.path}`;
  }
  return base ? `${base}/pullrequestcreate?sourceRef=${enc(branch)}&targetRef=${enc(target)}` : null;
}

// { url, target } of the page that proposes `branch` as a pull request into `target`, or null. `target` of the result
// is the target branch when the page was built from the repository URL (GitHub, GitLab, Azure DevOps), null when it is
// the one the server printed on the push (`pushOutput`), which targets the server's default branch.
function pullRequestPage({ url, branch, target, pushOutput } = {}) {
  if (!branch || !target) {
    return null;
  }
  const r = parseRemote(url);
  const built = r ? builtUrl(r, branch, target) : null;
  if (built) {
    return { url: built, target };
  }
  const printed = printedUrl(pushOutput, branch);
  return printed ? { url: printed, target: null } : null;
}

module.exports = { parseRemote, pullRequestPage };
