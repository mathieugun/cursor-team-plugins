'use strict';

// An edit in the managed clone shows as a local change; Commit and push sends it to the team repository.

const fs = require('fs');
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
    const { hook, assert, vscode } = t;
    t.step('wait for review to be registered');
    const registered = await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    await t.idle();
    const clone = path.dirname(registered);
    const states = hook.states();
    assert.equal(states.length, 1);
    const key = states[0].key;

    t.step('edit a skill in the clone');
    fs.appendFileSync(path.join(clone, 'review', 'skills', 'code-review', 'SKILL.md'), '\nEdited by the live test.\n');
    const changes = await t.waitFor(() => t.find(`changes:${key}`), 'the Local changes node');
    assert.ok(
      changes.children.some((c) => c.label.includes('SKILL.md')),
      JSON.stringify(changes.children.map((c) => c.label)),
    );

    t.step('commit and push');
    hook.respond((c) =>
      c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt) ? 'Live test commit' : undefined,
    );
    await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: key });
    await t.waitFor(
      () => t.messages('showInformationMessage').some((c) => /^Pushed [0-9a-f]{7} to main: /.test(c.message)),
      'the Pushed message',
    );

    t.step('check the team repository');
    const log = await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'main']);
    assert.equal(log.stdout, 'Live test commit');
    await t.waitFor(() => !t.find(`changes:${key}`), 'the Local changes node to go');
    t.noSpinner();
  },
};
