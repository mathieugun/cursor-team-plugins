'use strict';

// Builds a bare git repository from test/fixtures/team-repo (plugins `review` and `docs`), to stand in for the team
// repository in a live test: set teamPlugins.repoUrl to the path it prints.
//   node scripts/make-test-repo.js <target.git>

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { removeTree } = require('../lib/sync');

const FIXTURE = path.resolve(__dirname, '..', 'test', 'fixtures', 'team-repo');
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.error ? r.error.message : r.stderr}`);
  }
  return r.stdout.trim();
}

// Returns the target path (forward slashes, as repoUrl takes it). Refuses an existing target.
function makeTestRepo(target) {
  const bare = path.resolve(target);
  if (fs.existsSync(bare)) {
    throw new Error(`${bare} already exists`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'team-plugins-fixture-'));
  try {
    fs.cpSync(FIXTURE, work, { recursive: true });
    git(['init', '-q', '-b', 'main'], work);
    git(['add', '-A'], work);
    git([...IDENTITY, 'commit', '-q', '-m', 'test team plugins'], work);
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git(['clone', '-q', '--bare', work, bare], path.dirname(bare));
  } finally {
    removeTree(work);
  }
  return bare.split(path.sep).join('/');
}

module.exports = { makeTestRepo, FIXTURE };

if (require.main === module) {
  if (!process.argv[2]) {
    console.error('usage: node scripts/make-test-repo.js <target.git>');
    process.exit(2);
  }
  console.log(makeTestRepo(process.argv[2]));
}
