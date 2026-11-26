'use strict';

// A refused Commit and push offers Open a pull request: the changes go to a new branch and the page that proposes them
// opens. The server prints that page's address (a pre-receive hook), as GitHub Enterprise or GitLab do.

const fs = require('fs');
const path = require('path');

const HOOK = `#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/main ]; then echo "error: main is protected" >&2; exit 1; fi
  b=\${ref#refs/heads/}
  echo "Create a pull request for $b:" >&2
  echo "     https://git.example.test/team/plugins/pull/new/$b" >&2
done
exit 0
`;
const PAGE = 'https://git.example.test/team/plugins/pull/new/live/pr';

module.exports = {
  setup(ctx) {
    const bare = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'));
    const hookFile = path.join(bare, 'hooks', 'pre-receive');
    fs.mkdirSync(path.dirname(hookFile), { recursive: true });
    fs.writeFileSync(hookFile, HOOK);
    fs.chmodSync(hookFile, 0o755);
    return {
      settings: { 'teamPlugins.repositories': [bare], 'teamPlugins.enabled': ['team-test:review'] },
      data: { bare },
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
    const skill = path.join(clone, 'review', 'skills', 'code-review', 'SKILL.md');
    fs.appendFileSync(skill, '\nEdited by the pull request live test.\n');
    await t.waitFor(() => t.find(`changes:${key}`), 'the Local changes node');

    t.step('a refused Commit and push offers Open a pull request');
    hook.respond((c) => {
      if (c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt)) {
        return 'Live PR commit';
      }
      if (c.kind === 'showErrorMessage' && /the server refused the push to main/.test(c.message)) {
        return 'Open a pull request';
      }
      if (c.kind === 'showInputBox' && /^Branch to push your changes to/.test(c.prompt)) {
        return 'live/pr';
      }
      return undefined;
    });
    await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: key });
    const refused = await t.waitFor(
      () => t.messages('showErrorMessage').find((c) => /the server refused the push to main/.test(c.message)),
      'the refused push message',
    );
    assert.deepEqual(refused.buttons, ['Open a pull request', 'Show log']);
    assert.ok(refused.message.includes('(error: main is protected)'), refused.message);

    t.step('the page opens');
    await t.waitFor(() => t.messages('openExternal').find((c) => c.url === PAGE), 'the pull request page opened');
    const opened = await t.waitFor(
      () =>
        t
          .messages('showInformationMessage')
          .find((c) =>
            c.message.startsWith('Pushed your changes to branch live/pr and opened the page to propose them as a pull request.'),
          ),
      'the opened page message',
    );
    assert.deepEqual(opened.buttons, ['Open pull request', 'Copy merge commands']);

    t.step('check the team repository');
    const log = await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'live/pr']);
    assert.equal(log.stdout, 'Live PR commit');
    const main = await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'main']);
    assert.notEqual(main.stdout, 'Live PR commit');
    await t.waitFor(() => !t.find(`changes:${key}`), 'the Local changes node to go');
    assert.ok(
      hook.logLines().some((l) => l.includes(`pull request page for live/pr: ${PAGE}`)),
      'the log has the page address',
    );

    t.step('Push to a branch offers the page, without opening it');
    await t.idle();
    fs.appendFileSync(skill, '\nEdited again.\n');
    await t.waitFor(() => t.find(`changes:${key}`), 'the Local changes node again');
    hook.respond((c) => {
      if (c.kind === 'showInputBox' && /^Branch to push your changes to/.test(c.prompt)) {
        return 'live/pr2';
      }
      if (c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt)) {
        return 'Second';
      }
      if (c.kind === 'showInformationMessage' && /^Pushed your changes to branch live\/pr2\. /.test(c.message)) {
        return 'Open pull request';
      }
      return undefined;
    });
    await vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: key });
    const second = await t.waitFor(
      () => t.messages('showInformationMessage').find((c) => /^Pushed your changes to branch live\/pr2\. /.test(c.message)),
      'the second Pushed message',
    );
    assert.ok(
      second.message.includes('Open a pull request to have them reviewed and merged, or merge it in your own clone:'),
      second.message,
    );
    assert.deepEqual(second.buttons, ['Open pull request', 'Copy merge commands']);
    await t.waitFor(
      () => t.messages('openExternal').find((c) => c.url.endsWith('/pull/new/live/pr2')),
      'the second page opened',
    );
    t.noSpinner();
  },
};
