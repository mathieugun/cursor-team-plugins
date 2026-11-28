"""Regression probes for request 25. Run from any directory with Python, Node and Git."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


CASES = (
    "push-ignored",
    "push-staged",
    "unreadable-case",
    "case-rename-file",
    "case-rename-folder",
    "case-rename-source",
    "unreadable-conflict",
    "linked-marketplace",
    "linked-item",
    "mcp-add",
    "mcp-rename",
)

# Run the actual CommonJS entry points in Node. Only the two network responses and
# the directory-read failures are simulated.
NODE_PROBE = r"""
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readCatalog, mcpServerNames, serverTable } = require('./lib/catalog');
const { parseJsonc } = require('./lib/checks');
const { pushToBranch } = require('./lib/contribute');
const { syncCopy, markCopySynced } = require('./lib/materialize');
const { createPlugin, createItem, addMcpServer } = require('./lib/authoring');
const { renameItem } = require('./lib/rename');

const [root, name] = process.argv.slice(2);
const repo = path.join(root, 'repo');
const pluginDir = path.join(repo, 'test');
const read = (file) => fs.readFileSync(file, 'utf8');

function write(dir, rel, text) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function runGit(args, cwd, _timeout, options) {
  const opts = ['-c', 'user.name=Request 25', '-c', 'user.email=review@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false'];
  const result = spawnSync('git', [...opts, ...args], { cwd, encoding: 'utf8' });
  if (result.error) {
    throw result.error;
  }
  return {
    code: result.status,
    stdout: options?.trim === false ? result.stdout : result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function git(...args) {
  const result = runGit(args, repo);
  assert.equal(result.code, 0, 'git ' + args.join(' ') + ': ' + result.stderr);
  return result.stdout;
}

async function pushDuring(save, prepare) {
  fs.mkdirSync(repo);
  git('init', '-b', 'main');
  write(repo, 'work.txt', 'team version\n');
  write(repo, 'ignored.txt', 'team version\n');
  write(repo, 'staged.txt', 'team version\n');
  git('add', '-A');
  git('commit', '-m', 'team version');
  git('remote', 'add', 'origin', path.join(root, 'unused-origin.git'));
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('branch', '--set-upstream-to=origin/main');
  write(repo, 'work.txt', 'edit to push\n');
  prepare?.();
  let wroteDuringPush = false;
  const run = (args, cwd, timeout, options) => {
    if (args[0] === 'ls-remote') {
      return { code: 2, stdout: '', stderr: '' };
    }
    if (args[0] === 'push') {
      save();
      wroteDuringPush = true;
      return { code: 0, stdout: '', stderr: '' };
    }
    return runGit(args, cwd, timeout, options);
  };
  const result = await pushToBranch({
    run, repo, branch: 'request-25-repro', message: 'work to push',
    lockFile: path.join(root, 'sync.lock'), stateFile: path.join(root, 'state.json'),
  });
  assert.equal(result.kind, 'pushedBranch', JSON.stringify(result));
  assert.ok(wroteDuringPush, 'fixture never reached the push');
  if (git('rev-parse', 'HEAD') === result.head) {
    assert.ok(result.resetSkipped, 'the clone stayed on the pushed commit without a skip result');
  }
}

function partialCopy(rel) {
  write(pluginDir, '.cursor-plugin/plugin.json', '{"name":"test"}');
  write(pluginDir, 'skills/a/SKILL.md', '---\ndescription: Fixture\n---\n');
  const source = write(pluginDir, rel, 'baseline');
  const [plugin] = readCatalog(repo).plugins;
  const holder = path.join(root, 'holder');
  const ids = ['test/skills/a'];
  const sync = () => syncCopy(plugin, ids, holder);
  const { copyRoot } = sync();
  const manifest = () => JSON.parse(read(path.join(holder, '.team-plugins-sync.json')));
  return { source, holder, copyRoot, copy: path.join(copyRoot, rel), sync, manifest };
}

function withoutListing(folder, run) {
  const original = fs.readdirSync;
  let hit = false;
  fs.readdirSync = (current, ...args) => {
    if (current === folder) {
      hit = true;
      throw Object.assign(new Error('fixture directory is unreadable'), { code: 'EACCES' });
    }
    return original(current, ...args);
  };
  try {
    const result = run();
    assert.ok(hit, 'fixture did not encounter the unreadable directory');
    return result;
  } finally {
    fs.readdirSync = original;
  }
}

// Renames `from` to `to` (paths that differ only in case) through an intermediate name.
function renameCase(from, to) {
  const intermediate = from + '-intermediate';
  fs.renameSync(from, intermediate);
  fs.renameSync(intermediate, to);
}

// A case-only rename on one side, then two syncs: the file must still exist on both sides with its content.
function caseRename(rename) {
  const rel = 'assets/example.txt';
  const f = partialCopy(rel);
  rename(f);
  if (!fs.existsSync(f.copy) || !fs.existsSync(f.source)) {
    return 'fixture is on a case-sensitive filesystem';
  }
  const check = () => {
    assert.ok(fs.existsSync(f.source), 'the case-only rename deleted the repository file');
    assert.ok(fs.existsSync(f.copy), 'the case-only rename deleted the copy file');
    assert.equal(read(f.source), 'baseline');
    assert.equal(read(f.copy), 'baseline');
  };
  f.sync();
  check();
  f.sync();
  check();
}

function linkDirectory(target, link) {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

function verifyMcpEdit(file, before, result, check) {
  const after = read(file);
  if (result.error) {
    assert.equal(after, before, 'a declined edit must leave the original text intact');
    return;
  }
  assert.equal(result.file, file, JSON.stringify(result));
  assert.ok(after.includes('// keep this comment'));
  check(parseJsonc(after));
}

const cases = {
  async 'push-ignored'() {
    await pushDuring(
      () => {
        write(repo, 'ignored.txt', 'new ignored work during push\n');
        assert.match(git('status', '--porcelain', '--ignored'), /^!! ignored\.txt$/m);
      },
      () => {
        fs.unlinkSync(path.join(repo, 'ignored.txt'));
        write(repo, '.gitignore', 'ignored.txt\n');
      },
    );
    assert.equal(read(path.join(repo, 'ignored.txt')), 'new ignored work during push\n');
  },

  async 'push-staged'() {
    await pushDuring(() => {
      write(repo, 'staged.txt', 'new staged work during push\n');
      git('add', 'staged.txt');
      write(repo, 'staged.txt', 'team version\n');
      assert.equal(git('show', ':staged.txt'), 'new staged work during push');
    });
    assert.equal(git('show', ':staged.txt'), 'new staged work during push');
    assert.equal(read(path.join(repo, 'staged.txt')), 'team version\n');
  },

  'unreadable-case'() {
    const rel = 'assets/example.txt';
    const f = partialCopy(rel);
    const renamed = path.join(f.copyRoot, 'Assets');
    const intermediate = path.join(f.copyRoot, 'intermediate');
    fs.renameSync(path.dirname(f.copy), intermediate);
    fs.renameSync(intermediate, renamed);
    if (!fs.existsSync(f.copy)) {
      return 'fixture is on a case-sensitive filesystem';
    }
    const before = f.manifest().files[rel];
    const result = withoutListing(renamed, f.sync);
    assert.ok(result.skipped.some((entry) => entry.unreadable && entry.rel === 'Assets'));
    assert.ok(fs.existsSync(f.source), 'the unreadable copy caused a repository deletion');
    assert.equal(read(f.copy), 'baseline');
    assert.equal(f.manifest().files[rel], before);
  },

  'case-rename-file'() {
    // an agent or the user renames example.txt to Example.txt in the partial copy
    return caseRename((f) => renameCase(f.copy, path.join(path.dirname(f.copy), 'Example.txt')));
  },

  'case-rename-folder'() {
    // the same with the folder: assets -> Assets in the partial copy, no unreadable folder involved
    return caseRename((f) => renameCase(path.dirname(f.copy), path.join(f.copyRoot, 'Assets')));
  },

  'case-rename-source'() {
    // a teammate's case-only rename reaches the clone through git
    return caseRename((f) => renameCase(f.source, path.join(path.dirname(f.source), 'Example.txt')));
  },

  'unreadable-conflict'() {
    const rel = 'assets/example.txt';
    const f = partialCopy(rel);
    fs.writeFileSync(f.source, 'repository conflict edit');
    fs.writeFileSync(f.copy, 'unsynced copy edit');
    assert.deepEqual(f.sync().conflicts.map((c) => c.rel), [rel]);
    withoutListing(path.dirname(f.source), f.sync);
    const remembered = f.manifest().conflicts;
    // The discard flow resets the clone, then marks copy baselines before applying again.
    fs.writeFileSync(f.source, 'team version after discard');
    markCopySynced(f.holder);
    f.sync();
    assert.equal(read(f.copy), 'unsynced copy edit');
    assert.deepEqual(remembered, [rel]);
  },

  'linked-marketplace'() {
    const outside = path.join(root, 'outside');
    const before = '{"plugins":[]}\n';
    const marketplace = write(outside, 'marketplace.json', before);
    fs.mkdirSync(repo);
    linkDirectory(outside, path.join(repo, '.cursor-plugin'));
    const result = createPlugin(repo, { name: 'new' });
    assert.equal(read(marketplace), before, 'authoring modified a marketplace outside the repository');
    assert.ok(result.error, 'authoring should reject the external destination');
    assert.ok(!fs.existsSync(path.join(repo, 'new')), 'authoring partially created the plugin');
  },

  'linked-item'() {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    write(pluginDir, '.cursor-plugin/plugin.json', '{"name":"test"}');
    linkDirectory(outside, path.join(pluginDir, 'commands'));
    const result = createItem(pluginDir, 'command', 'new', 'Fixture');
    assert.deepEqual(fs.readdirSync(outside), [], 'authoring created a command outside the repository');
    assert.ok(result.error, 'authoring should reject the external destination');
  },

  'mcp-add'() {
    const before = '{\n// keep this comment\n"lint":{"command":"node"},\n"notes":"keep me",\n}\n';
    const file = write(pluginDir, 'mcp.json', before);
    const result = addMcpServer(pluginDir, 'notes', { command: 'python' });
    verifyMcpEdit(file, before, result, (obj) => {
      assert.equal(obj.notes, 'keep me');
      assert.deepEqual(mcpServerNames(obj).sort(), ['lint', 'notes']);
      const servers = serverTable(obj) || obj;
      assert.deepEqual(servers.lint, { command: 'node' });
      assert.deepEqual(servers.notes, { command: 'python' });
    });
  },

  'mcp-rename'() {
    const before = '{\n// keep this comment\n"lint":{"command":"node"},\n"other":{"command":"python"},\n}\n';
    const file = write(pluginDir, 'mcp.json', before);
    const item = { pluginDir, pluginName: 'test', kind: 'mcp', name: 'lint', file };
    const result = renameItem(item, 'mcpServers');
    verifyMcpEdit(file, before, result, (obj) => {
      assert.deepEqual(mcpServerNames(obj).sort(), ['mcpServers', 'other']);
      const servers = serverTable(obj) || obj;
      assert.deepEqual(servers.mcpServers, { command: 'node' });
      assert.deepEqual(servers.other, { command: 'python' });
    });
  },
};

Promise.resolve().then(() => cases[name]()).then((skip) => {
  console.log(skip ? 'SKIP ' + name + ' (' + skip + ')' : 'PASS ' + name);
}).catch((error) => {
  console.error('FAIL ' + name, error);
  process.exitCode = 1;
});
"""


WINDOWS_ONLY = {"unreadable-case", "case-rename-file", "case-rename-folder", "case-rename-source"}


def node_command(env):
    """`node` when it is on PATH, else Cursor's runtime (ELECTRON_RUN_AS_NODE), as in AGENTS.md."""
    if shutil.which("node"):
        return ["node"]
    cursor = Path(os.environ.get("LOCALAPPDATA", ""), "Programs", "cursor", "Cursor.exe")
    if not cursor.is_file():
        raise SystemExit("node is not on PATH and Cursor's runtime was not found")
    env["ELECTRON_RUN_AS_NODE"] = "1"
    return [str(cursor)]


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog="Cases: " + ", ".join(CASES))
    parser.add_argument("cases", nargs="*", metavar="CASE", help="Run only these cases (default: all).")
    args = parser.parse_args()
    for case in args.cases:
        if case not in CASES:
            parser.error(f"unknown case {case!r}")

    # the repository root: the nearest folder above the script that holds package.json (requests/ or requests/done/)
    repo = next(p for p in Path(__file__).resolve().parents if (p / "package.json").is_file())
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
    node = node_command(env)
    failed = False
    for case in args.cases or CASES:
        if case in WINDOWS_ONLY and os.name != "nt":
            print(f"SKIP {case} (Windows only)", flush=True)
            continue
        with tempfile.TemporaryDirectory(prefix="team-plugins-request-25-") as temp:
            result = subprocess.run([*node, "-", temp, case], input=NODE_PROBE, text=True, cwd=repo, env=env)
        failed |= result.returncode != 0
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
