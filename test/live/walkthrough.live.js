'use strict';

// Get started opens the walkthrough; Check git reports the machine's git, and a git.path that doesn't exist.

const os = require('os');
const path = require('path');

module.exports = {
  setup() {
    return { settings: {}, data: {} };
  },

  async run(t) {
    const { hook, assert, vscode } = t;
    const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((tab) => tab.label));

    t.step('open the walkthrough');
    // Cursor registers the walkthrough a few seconds after startup: until then the command opens the generic Welcome
    // tab, so it is run again until the walkthrough's own tab shows.
    await t.waitFor(
      async () => {
        await vscode.commands.executeCommand('teamPlugins.getStarted');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return labels().includes('Walkthrough: Team plugins');
      },
      `the walkthrough tab (tabs: ${JSON.stringify(labels())})`,
      30000,
    );

    t.step('check git');
    hook.clearCalls();
    await vscode.commands.executeCommand('teamPlugins.checkGit');
    await t.waitFor(() => hook.gitCheck(), 'the git check');
    assert.equal(hook.gitCheck().status, 'ok', JSON.stringify(hook.gitCheck()));
    const info = t.messages('showInformationMessage');
    assert.equal(info.length, 1, JSON.stringify(info));
    assert.match(info[0].message, /^Team plugins: git \d+\.\d+\.\d+ is ready\./);
    assert.deepEqual(info[0].buttons, []);

    t.step('missing git');
    hook.clearCalls();
    hook.respond((r) => (r.kind === 'showErrorMessage' ? 'Download git' : undefined));
    const noGit = path.join(os.tmpdir(), 'tp-no-git', 'git.exe');
    await vscode.workspace.getConfiguration('git').update('path', noGit, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand('teamPlugins.checkGit');
    assert.equal(hook.gitCheck().status, 'missing', JSON.stringify(hook.gitCheck()));
    const errors = t.messages('showErrorMessage');
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(errors[0].message.startsWith('Team plugins: git was not found (git.path is '), errors[0].message);
    assert.deepEqual(errors[0].buttons, ['Download git']);
    await t.waitFor(
      () => t.messages('openExternal').some((c) => c.url === 'https://git-scm.com/downloads'),
      'the download page opened',
    );

    t.step('restore');
    await vscode.workspace.getConfiguration('git').update('path', undefined, vscode.ConfigurationTarget.Global);
    hook.respond(null);
    await t.idle();
    assert.equal(t.messages('showErrorMessage').length, 1, JSON.stringify(t.messages('showErrorMessage')));
  },
};
