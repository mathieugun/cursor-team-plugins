'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeGit } = require('../lib/git');
const { gitAvailable } = require('./helpers');

test('run trims stdout unless asked not to', async (t) => {
  if (!gitAvailable()) {
    return t.skip('git is not available');
  }
  const run = makeGit('git');
  const trimmed = await run(['--version'], process.cwd());
  assert.equal(trimmed.code, 0);
  assert.ok(trimmed.stdout.startsWith('git version'));
  assert.ok(!trimmed.stdout.endsWith('\n'));
  const raw = await run(['--version'], process.cwd(), undefined, { trim: false });
  assert.equal(raw.code, 0);
  assert.ok(raw.stdout.endsWith('\n'));
});
