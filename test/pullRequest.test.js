'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRemote, pullRequestPage } = require('../lib/pullRequest');

test('parseRemote', () => {
  assert.deepEqual(parseRemote('https://github.com/o/r.git'), { host: 'github.com', path: 'o/r' });
  assert.deepEqual(parseRemote('https://user:tok@GitHub.com/o/r/'), { host: 'github.com', path: 'o/r' });
  assert.deepEqual(parseRemote('git@github.com:o/r.git'), { host: 'github.com', path: 'o/r' });
  assert.deepEqual(parseRemote('ssh://git@gitlab.com:2222/g/sub/p.git'), { host: 'gitlab.com', path: 'g/sub/p' });
  for (const local of ['C:\\repos\\team.git', 'C:/repos/team.git', '/srv/team.git', 'file:///srv/team.git', '../team']) {
    assert.equal(parseRemote(local), null, local);
  }
});

const build = (url, branch, extra = {}) => pullRequestPage({ url, branch, target: 'main', ...extra });

test('pullRequestPage builds the GitHub page', () => {
  assert.deepEqual(build('https://github.com/o/r.git', 'team-plugins/ann-20261126-1200'), {
    url: 'https://github.com/o/r/compare/main...team-plugins/ann-20261126-1200?quick_pull=1',
    target: 'main',
  });
  assert.equal(
    pullRequestPage({ url: 'git@github.com:o/r.git', branch: 'fix#1+a&b', target: 'release/2' }).url,
    'https://github.com/o/r/compare/release/2...fix%231%2Ba%26b?quick_pull=1',
  );
  assert.equal(build('https://github.com/o/r/extra.git', 'b'), null);
});

test('pullRequestPage builds the GitLab page', () => {
  assert.equal(
    build('https://gitlab.com/g/sub/p.git', 'team-plugins/x').url,
    'https://gitlab.com/g/sub/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=team-plugins%2Fx&merge_request%5Btarget_branch%5D=main',
  );
  assert.equal(
    build('git@gitlab.com:g/p.git', 'b').url,
    'https://gitlab.com/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=b&merge_request%5Btarget_branch%5D=main',
  );
});

test('pullRequestPage builds the Azure DevOps page', () => {
  assert.equal(
    build('https://org@dev.azure.com/org/My%20Project/_git/repo', 'team-plugins/x').url,
    'https://dev.azure.com/org/My%20Project/_git/repo/pullrequestcreate?sourceRef=team-plugins%2Fx&targetRef=main',
  );
  assert.equal(
    build('git@ssh.dev.azure.com:v3/org/proj/repo', 'b').url,
    'https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main',
  );
  assert.equal(
    build('org@vs-ssh.visualstudio.com:v3/org/proj/repo', 'b').url,
    'https://org.visualstudio.com/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main',
  );
  assert.equal(
    build('https://org.visualstudio.com/DefaultCollection/proj/_git/repo', 'b').url,
    'https://org.visualstudio.com/DefaultCollection/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main',
  );
  assert.equal(
    build('https://org.visualstudio.com/proj/_git/repo', 'b').url,
    'https://org.visualstudio.com/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main',
  );
});

test('pullRequestPage falls back to the URL the server printed', () => {
  const ghe =
    "Enumerating objects: 3, done.\r\nremote: \r\nremote: Create a pull request for 'team-plugins/x' on GitHub by visiting:        \r\nremote:      https://ghe.example.test/o/r/pull/new/team-plugins/x        \r\nremote: \r\nTo ghe.example.test:o/r.git\r\n * [new branch]      HEAD -> team-plugins/x";
  assert.deepEqual(build('git@ghe.example.test:o/r.git', 'team-plugins/x', { pushOutput: ghe }), {
    url: 'https://ghe.example.test/o/r/pull/new/team-plugins/x',
    target: null,
  });

  const gitlab =
    'remote: To create a merge request for team-plugins/x, visit:\nremote:   https://git.example.test/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=team-plugins%2Fx\n';
  assert.deepEqual(build('https://git.example.test/g/p.git', 'team-plugins/x', { pushOutput: gitlab }), {
    url: 'https://git.example.test/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=team-plugins%2Fx',
    target: null,
  });

  assert.equal(
    build('https://git.example.test/g/p.git', 'team-plugins/x', {
      pushOutput: 'remote: See https://status.example.test for incidents.\n',
    }),
    null,
  );
  assert.equal(
    build('https://git.example.test/g/p.git', 'team-plugins/x', { pushOutput: 'To https://git.example.test/g/p.git\n' }),
    null,
  );
  assert.equal(
    build('https://h.example.test/g/p.git', 'b', { pushOutput: 'remote: visit https://h.example.test/pr/new/b.' }).url,
    'https://h.example.test/pr/new/b',
  );
  assert.deepEqual(
    build('C:/x/team.git', 'live/pr', {
      pushOutput: 'remote:      https://git.example.test/team/plugins/pull/new/live/pr        ',
    }),
    { url: 'https://git.example.test/team/plugins/pull/new/live/pr', target: null },
  );
});

test('pullRequestPage needs a branch', () => {
  assert.equal(build('https://github.com/o/r.git', ''), null);
  assert.equal(pullRequestPage({ url: 'https://github.com/o/r.git', branch: 'b', target: '' }), null);
});
