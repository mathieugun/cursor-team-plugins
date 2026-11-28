'use strict';

// Loaded by Cursor (--extensionTestsPath) in the extension host of the isolated instance started by
// scripts/live-test.js. It runs the scenario named by TEAM_PLUGINS_LIVE_SCENARIO and writes what happened to
// TEAM_PLUGINS_LIVE_RESULT: Cursor exits with code 0 even when run() fails, so that file is the only result.

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXTENSION_ID = 'mathieugun.cursor-team-plugins';

function findFiles(dir, name, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      findFiles(full, name, found);
    } else if (e.name === name) {
      found.push(full);
    }
  }
  return found;
}

exports.run = async () => {
  const result = { ok: false, error: null, steps: [], calls: [], log: [] };
  const save = () => {
    try {
      fs.writeFileSync(process.env.TEAM_PLUGINS_LIVE_RESULT, JSON.stringify(result, null, 2));
    } catch {
      // nothing to do: scripts/live-test.js reports a missing result
    }
  };
  let hook;
  try {
    hook = await vscode.extensions.getExtension(EXTENSION_ID).activate();
    if (!hook) {
      throw new Error('no test hook: the extension did not start in Test mode');
    }
    const scenario = require(process.env.TEAM_PLUGINS_LIVE_SCENARIO);
    const data = JSON.parse(fs.readFileSync(process.env.TEAM_PLUGINS_LIVE_DATA, 'utf8'));

    const t = {
      vscode,
      assert,
      hook,
      data,
      step(text) {
        result.steps.push(text);
        save();
      },
      async waitFor(fn, what, timeoutMs = 20000) {
        const end = Date.now() + timeoutMs;
        let lastError = null;
        for (;;) {
          try {
            const value = await fn();
            if (value) {
              return value;
            }
          } catch (err) {
            lastError = err;
          }
          if (Date.now() >= end) {
            throw new Error(`timed out waiting for ${what}${lastError ? ` (last error: ${lastError.message})` : ''}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      },
      idle: () => hook.idle(),
      find(id) {
        const walk = (nodes) => {
          for (const n of nodes) {
            if (n.id === id) {
              return n;
            }
            const found = walk(n.children);
            if (found) {
              return found;
            }
          }
          return undefined;
        };
        return walk(hook.tree());
      },
      sessionDir: () => path.resolve(hook.logUri, '..', '..', '..'),
      pluginsLog: () =>
        findFiles(t.sessionDir(), 'Cursor Plugins.log')
          .map((f) => fs.readFileSync(f, 'utf8'))
          .join('\n'),
      mcpLogs() {
        try {
          return fs.readdirSync(path.join(t.sessionDir(), 'window1')).filter((n) => n.startsWith('mcp-server-plugin-'));
        } catch {
          return [];
        }
      },
      git: (args, cwd) =>
        new Promise((resolve) => {
          execFile('git', args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout).trim(), stderr: String(stderr) });
          });
        }),
      messages: (kind) => hook.calls().filter((c) => !kind || c.kind === kind),
      noSpinner: () => assert.ok(!hook.status().text.includes('~spin'), `status bar still spinning: ${hook.status().text}`),
    };

    const limitSec = (scenario.timeoutSec || 90) - 10;
    let limit;
    const expired = new Promise((_resolve, reject) => {
      limit = setTimeout(() => reject(new Error(`scenario still running after ${limitSec} s`)), limitSec * 1000);
    });
    try {
      await Promise.race([scenario.run(t), expired]);
    } finally {
      clearTimeout(limit);
    }
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = err.stack || String(err);
  } finally {
    if (hook) {
      try {
        result.calls = hook.calls();
        result.log = hook.logLines().slice(-300);
      } catch (err) {
        result.log = [`cannot read the hook: ${err.message}`];
      }
    }
    save();
  }
};
