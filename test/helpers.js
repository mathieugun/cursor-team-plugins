'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'team-plugins-'));
}

function rmDir(dir) {
  require('../lib/sync').removeTree(dir);
}

function writeFile(root, rel, text = '') {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  return full;
}

// makePlugin(root, folder, { name, skills: [names], rules: [file names], extra: {rel: text}, manifest: false })
function makePlugin(root, folder, { name, skills = [], rules = [], extra = {}, manifest = true } = {}) {
  if (manifest) {
    writeFile(root, `${folder}/.cursor-plugin/plugin.json`, JSON.stringify({ name: name || folder }));
  }
  for (const s of skills) {
    writeFile(root, `${folder}/skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: Skill ${s}.\n---\nbody\n`);
  }
  for (const r of rules) {
    writeFile(root, `${folder}/rules/${r}`, `---\ndescription: Rule ${r}\n---\nbody\n`);
  }
  for (const [rel, text] of Object.entries(extra)) {
    writeFile(root, `${folder}/${rel}`, text);
  }
}

const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}

function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function commitAll(cwd, message) {
  git(['add', '-A'], cwd);
  git([...IDENTITY, 'commit', '-m', message], cwd);
  return git(['rev-parse', 'HEAD'], cwd);
}

module.exports = { tmpDir, rmDir, writeFile, makePlugin, git, gitAvailable, commitAll, IDENTITY };
