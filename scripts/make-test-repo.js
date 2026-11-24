'use strict';

// Builds a bare git repository from test/fixtures/team-repo (plugins `review` and `docs`), to stand in for the team
// repository in a live test: add the path it prints to teamPlugins.repositories. --name gives the copy another
// repository name (two test repositories need two names).
//   node scripts/make-test-repo.js <target.git> [--name <marketplace name>]

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

// Returns the target path (forward slashes, as a repository URL takes it). Refuses an existing target. name: the
// `name` of the copy's marketplace.json (the repository name in the view and in every id).
function makeTestRepo(target, { name } = {}) {
  const bare = path.resolve(target);
  if (fs.existsSync(bare)) {
    throw new Error(`${bare} already exists`);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'team-plugins-fixture-'));
  try {
    fs.cpSync(FIXTURE, work, { recursive: true });
    if (name) {
      const file = path.join(work, '.cursor-plugin', 'marketplace.json');
      const market = JSON.parse(fs.readFileSync(file, 'utf8'));
      market.name = name;
      fs.writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
    }
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
  const args = process.argv.slice(2);
  const at = args.indexOf('--name');
  const name = at >= 0 ? args.splice(at, 2)[1] : undefined;
  if (!args[0] || (at >= 0 && !name)) {
    console.error('usage: node scripts/make-test-repo.js <target.git> [--name <marketplace name>]');
    process.exit(2);
  }
  console.log(makeTestRepo(args[0], { name }));
}
