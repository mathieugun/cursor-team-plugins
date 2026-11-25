'use strict';

// Ticking a plugin registers it; unticking one of its items registers a filtered copy without that item.

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
    await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    await t.idle();

    t.step('tick the docs plugin');
    await hook.check('plugin:team-test:docs', true);
    await t.waitFor(() => hook.registrations()['team-test:docs'], 'docs registered');
    await t.waitFor(() => /Registered extension plugin: docs from /.test(t.pluginsLog()), 'Cursor registered docs');

    t.step('untick the security-check skill');
    await hook.check('item:team-test:review/skills/security-check', false);
    const copy = await t.waitFor(
      () => {
        const p = hook.registrations()['team-test:review'];
        return p && p.includes(`${path.sep}filtered${path.sep}`) ? p : null;
      },
      'review registered from a filtered copy',
    );
    t.step('check the copy');
    assert.ok(fs.existsSync(path.join(copy, 'skills', 'code-review', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(copy, 'skills', 'security-check')));

    t.step('check the tree and the settings');
    await t.idle();
    const review = t.find('plugin:team-test:review');
    assert.equal(review.checked, false);
    assert.equal(review.icon, 'pie-chart');
    const excluded = vscode.workspace.getConfiguration('teamPlugins').get('excluded');
    assert.ok(excluded.includes('team-test:review/skills/security-check'), JSON.stringify(excluded));

    t.step('check what Cursor registered');
    const want = `Registered extension plugin: review from ${copy}`;
    const lower = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    await t.waitFor(() => lower(t.pluginsLog()).includes(lower(want)), 'Cursor registered the filtered copy of review');
  },
};
