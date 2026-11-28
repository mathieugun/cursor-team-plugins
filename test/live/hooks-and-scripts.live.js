'use strict';

const fs = require('fs');
const path = require('path');
const { commitAll, git, makePlugin, writeFile } = require('../helpers');
const { readHooks } = require('../../lib/hooks');

const PLUGIN = 'fixture-team:example';
const GROUP = `item:${PLUGIN}/hooks`;
const EVENT = `hookEvent:${PLUGIN}/hooks:sessionEnd`;
const SCRIPT = `script:${PLUGIN}:tool.py`;
const SKILL_SCRIPT = `script:${PLUGIN}/skills/check:check.py`;
const DEFAULT = 'hooks/hooks.json';
const CUSTOM = 'config/alternate.json';
const HOOK_CONFIG = JSON.stringify({ version: 1, hooks: { sessionEnd: [{ command: 'echo fixture hook' }] } });

module.exports = {
  setup(ctx) {
    const seed = path.join(ctx.repos, 'seed');
    const bare = path.join(ctx.repos, 'team.git');
    writeFile(seed, '.cursor-plugin/marketplace.json', JSON.stringify({
      name: 'fixture-team', plugins: [{ name: 'example', source: './example' }],
    }));
    makePlugin(seed, 'example', { skills: ['check'], rules: ['style.mdc'], extra: {
      [DEFAULT]: HOOK_CONFIG,
      'scripts/tool.py': '# plugin script\n',
      'skills/check/scripts/check.py': '# skill script\n',
    } });
    git(['init', '-q', '-b', 'main'], seed);
    const initial = commitAll(seed, 'Plugin with default hooks and scripts');
    writeFile(seed, `example/${CUSTOM}`, HOOK_CONFIG);
    writeFile(seed, 'example/.cursor-plugin/plugin.json', JSON.stringify({ name: 'example', displayName: 'Example', author: {} }));
    writeFile(seed, 'example/.claude-plugin/plugin.json', JSON.stringify({ name: 'example', hooks: CUSTOM }));
    writeFile(seed, 'example/scripts/tool.py', '# updated plugin script\n');
    const next = commitAll(seed, 'Move hook configuration');
    git(['clone', '-q', '--bare', seed, bare], ctx.repos);
    git(['update-ref', 'refs/heads/main', initial], bare);
    return {
      settings: { 'teamPlugins.repositories': [{ url: ctx.url(bare), branch: 'main' }], 'teamPlugins.enabled': [PLUGIN] },
      data: { bare, next },
    };
  },

  async run(t) {
    const { hook, assert, vscode } = t;
    const source = await t.waitFor(() => hook.registrations()[PLUGIN], 'whole plugin registered', 60000);
    await t.idle();

    t.step('show one checkbox and open the original hook and script files');
    assert.equal(t.find(GROUP).checked, true);
    for (const [id, file] of [
      [GROUP, DEFAULT], [EVENT, DEFAULT], [SCRIPT, 'scripts/tool.py'], [SKILL_SCRIPT, 'skills/check/scripts/check.py'],
    ]) {
      if (id !== GROUP) {
        assert.equal(t.find(id).checked, null);
      }
      const editor = await hook.open(id);
      assert.equal(editor.document.uri.fsPath, path.join(source, file));
    }

    t.step('untick Hooks and keep the rest of the full selection');
    await hook.check(GROUP, false);
    const partial = await t.waitFor(() => {
      const registered = hook.registrations()[PLUGIN];
      return registered && registered !== source && registered;
    }, 'filtered plugin registered');
    await t.idle();
    assert.deepEqual(readHooks(partial).events, []);
    assert.ok(!fs.existsSync(path.join(partial, DEFAULT)));
    assert.ok(fs.existsSync(path.join(partial, 'rules/style.mdc')));
    assert.ok(fs.existsSync(path.join(partial, 'skills/check/scripts/check.py')));
    assert.ok(fs.existsSync(path.join(partial, 'scripts/tool.py')));
    assert.ok(vscode.workspace.getConfiguration('teamPlugins').get('excluded').includes(`${PLUGIN}/hooks`));

    t.step('sync hooks in the fallback manifest after Cursor rejects the higher-priority manifest');
    const update = await t.git(['update-ref', 'refs/heads/main', t.data.next], t.data.bare);
    assert.equal(update.code, 0, update.stderr);
    await vscode.commands.executeCommand('teamPlugins.syncNow');
    await t.idle();
    assert.equal(hook.registrations()[PLUGIN], partial);
    assert.equal(t.find(GROUP).checked, false);
    assert.deepEqual(readHooks(partial).events, []);
    assert.ok(fs.existsSync(path.join(partial, CUSTOM)));
    assert.equal(fs.readFileSync(path.join(partial, 'scripts/tool.py'), 'utf8').trim(), '# updated plugin script');
    const editor = await hook.open(EVENT);
    assert.equal(editor.document.uri.fsPath, path.join(source, CUSTOM));

    t.step('re-enable Hooks');
    await hook.check(GROUP, true);
    await t.waitFor(() => hook.registrations()[PLUGIN] === source, 'whole plugin registered again');
    assert.equal(t.find(GROUP).checked, true);
    assert.deepEqual(readHooks(source).events, ['sessionEnd']);
  },
};
