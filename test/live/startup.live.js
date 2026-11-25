'use strict';

// A team repository in the settings is cloned, its selected plugin registered with Cursor, and the user told.

const path = require('path');

module.exports = {
  setup(ctx) {
    const url = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'));
    return {
      settings: { 'teamPlugins.repositories': [url], 'teamPlugins.enabled': ['team-test:review'] },
      data: { bare: url },
    };
  },

  async run(t) {
    const { hook, assert } = t;
    t.step('wait for review to be registered');
    const registered = await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    await t.idle();
    t.step('check the registrations');
    assert.ok(registered.endsWith(`${path.sep}review`), registered);
    assert.ok(registered.includes(`${path.sep}repos${path.sep}`), registered);
    assert.equal(hook.registrations()['team-test:docs'], undefined);

    t.step('check the tree');
    assert.equal(t.find('plugin:team-test:review').checked, true);
    assert.equal(t.find('plugin:team-test:docs').checked, false);
    const roots = hook.tree().filter((n) => n.id.startsWith('repo:'));
    assert.equal(roots.length, 1);
    assert.equal(roots[0].label, 'team-test');

    t.step('check what Cursor registered');
    await t.waitFor(
      () => /Registered extension plugin: review from .*[\\/]repos[\\/]/.test(t.pluginsLog()),
      'Cursor registered review',
    );
    await t.waitFor(
      () => ['-lint.workbench.log', '-tickets.workbench.log'].every((s) => t.mcpLogs().some((n) => n.endsWith(s))),
      'MCP servers lint and tickets',
    );

    t.step('check the messages');
    const cloned = t.messages('showInformationMessage').find((c) => /^Team plugins: team-test cloned\./.test(c.message));
    assert.ok(cloned, 'no "cloned" message');
    assert.deepEqual(cloned.buttons, ['Open view']);
    assert.equal(t.messages('showErrorMessage').length, 0, JSON.stringify(t.messages('showErrorMessage')));
    t.noSpinner();
  },
};
