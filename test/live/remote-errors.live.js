'use strict';

// A wrong URL, an unreachable server and an unknown SSH host key each end in a message with the right buttons.

const path = require('path');

module.exports = {
  timeoutSec: 120,

  setup(ctx) {
    return {
      settings: { 'teamPlugins.repositories': [ctx.url(path.join(ctx.repos, 'missing.git'))] },
      env: { GIT_SSH_COMMAND: ctx.fakeSshCommand('unknown'), GIT_SSH_VARIANT: 'ssh' },
      data: {},
    };
  },

  async run(t) {
    const { hook, assert, vscode } = t;
    const err = (re) => t.messages('showErrorMessage').filter((c) => re.test(c.message));
    const setRepositories = (list) =>
      vscode.workspace.getConfiguration('teamPlugins').update('repositories', list, vscode.ConfigurationTarget.Global);

    t.step('a repository that does not exist');
    const notFound = await t.waitFor(
      () => err(/^Team plugins \(missing\): repository .*missing\.git not found/)[0],
      'the not found message',
      60000,
    );
    assert.deepEqual(notFound.buttons, ['Open settings', 'Show log']);

    t.step('an unreachable server');
    await t.idle();
    await setRepositories(['http://127.0.0.1:1/team.git']);
    await t.idle();
    await vscode.commands.executeCommand('teamPlugins.syncNow');
    const unreachable = await t.waitFor(
      () => err(/^Team plugins \(team\): cannot reach 127\.0\.0\.1/)[0],
      'the cannot reach message',
      30000,
    );
    assert.deepEqual(unreachable.buttons, ['Sync now', 'Show log']);
    await t.idle();
    assert.ok(hook.status().text.startsWith('$(debug-disconnect)'), hook.status().text);
    t.noSpinner();

    t.step('an unknown SSH host key');
    let answered = false;
    hook.respond((c) => {
      if (c.kind === 'showErrorMessage' && /host key of example\.test/.test(c.message) && !answered) {
        answered = true;
        return 'Sync now';
      }
      return undefined;
    });
    await setRepositories(['git@example.test:team/plugins.git']);
    await t.idle();
    await vscode.commands.executeCommand('teamPlugins.syncNow');
    const unknown = await t.waitFor(
      () => {
        const found = err(/SSH does not know the host key of example\.test/);
        return found.length >= 2 ? found : null;
      },
      'two host key messages (the second from the scripted Sync now)',
      30000,
    );
    for (const c of unknown) {
      assert.deepEqual(c.buttons, ['Open terminal', 'Sync now', 'Show log']);
    }

    t.step('nothing is left registered');
    await t.idle();
    assert.deepEqual(hook.registrations(), {});
    t.noSpinner();
  },
};
