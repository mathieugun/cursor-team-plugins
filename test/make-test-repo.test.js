'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('../lib/catalog');
const { makeTestRepo, FIXTURE } = require('../scripts/make-test-repo');
const { tmpDir, rmDir, git, gitAvailable } = require('./helpers');

// The baseline the live tests rely on: change it together with test/fixtures/team-repo.
function assertBaseline(repoDir, name = 'team-test') {
  const { name: repoName, plugins, warnings } = readCatalog(repoDir);
  assert.deepEqual(warnings, []);
  assert.equal(repoName, name);
  assert.deepEqual(
    plugins.map((p) => [p.name, p.displayName, p.version]),
    [
      ['review', 'Review (test)', '0.1.0'],
      ['docs', 'Docs (test)', '0.1.0'],
    ],
  );
  const [review, docs] = plugins;
  assert.deepEqual(
    review.children.map((c) => [c.id, c.kind]),
    [
      ['review/skills/code-review', 'skill'],
      ['review/skills/security-check', 'skill'],
      ['review/rules/style.mdc', 'rule'],
      ['review/commands/review-pr.md', 'command'],
      ['review/agents/reviewer.md', 'agent'],
      ['review/mcp/lint', 'mcp'],
      ['review/mcp/tickets', 'mcp'],
    ],
  );
  assert.equal(review.children[2].description, 'Team code style for the live test.');
  assert.equal(review.children[3].description, 'Review the open pull request (live test).');
  assert.deepEqual(docs.children.map((c) => c.id), ['docs/skills/write-readme']);
  // a folded (>) description, read as one line
  assert.equal(docs.children[0].description, 'Write or update a project README from the code.');
}

test('the fixture team repository', () => {
  assertBaseline(FIXTURE);
});

test('makeTestRepo builds a bare repository of the fixture', (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = tmpDir();
  t.after(() => rmDir(root));
  const bare = makeTestRepo(path.join(root, 'nested', 'team.git'));
  assert.equal(bare, path.join(root, 'nested', 'team.git').split(path.sep).join('/'));
  assert.equal(git(['rev-parse', '--is-bare-repository'], bare), 'true');
  assert.equal(git(['symbolic-ref', 'HEAD'], bare), 'refs/heads/main');
  const clone = path.join(root, 'clone');
  git(['clone', '-q', bare, clone], root);
  assertBaseline(clone);
  assert.throws(() => makeTestRepo(bare), /already exists/);
  assert.deepEqual(fs.readdirSync(root).sort(), ['clone', 'nested']);
});

test('makeTestRepo with a name gives the copy another repository name', (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const root = tmpDir();
  t.after(() => rmDir(root));
  const bare = makeTestRepo(path.join(root, 'two.git'), { name: 'team-two' });
  const clone = path.join(root, 'clone');
  git(['clone', '-q', bare, clone], root);
  assertBaseline(clone, 'team-two');
});
