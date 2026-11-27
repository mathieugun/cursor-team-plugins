'use strict';

// The view and the status bar show what the selection costs in the context: the plugin rows and tooltips, the item
// tooltips, the title's total, and all of it follows an edit of a rule and an unticked plugin.

const fs = require('fs');
const path = require('path');

const ALWAYS_STYLE =
  '---\ndescription: Team code style for the live test.\nalwaysApply: true\n---\nPrefer small functions and explicit names.\n';

module.exports = {
  timeoutSec: 120,

  setup(ctx) {
    const url = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'));
    return {
      settings: { 'teamPlugins.repositories': [url], 'teamPlugins.enabled': ['team-test:review'] },
      data: { bare: url },
    };
  },

  async run(t) {
    const { hook, assert } = t;
    const PLUGIN = 'plugin:team-test:review';
    const RULE = 'item:team-test:review/rules/style.mdc';
    const SKILL = 'item:team-test:review/skills/code-review';

    t.step('wait for review to be registered');
    const registered = await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    await t.idle();

    t.step('the plugin, its items, the title and the status bar');
    await t.waitFor(() => hook.viewDescription() === '~39 tokens per chat', 'the title to show ~39 tokens per chat');
    const plugin = t.find(PLUGIN);
    assert.ok(plugin.description.includes('~39 tokens'), plugin.description);
    assert.ok(plugin.tooltip.includes('In every chat: ~39 tokens (3 descriptions ~39)'), plugin.tooltip);
    const rule = t.find(RULE);
    assert.equal(rule.description, 'rule');
    assert.ok(
      rule.tooltip.includes('Applies when the agent asks for it: its description is in every chat (~9 tokens)'),
      rule.tooltip,
    );
    assert.ok(t.find(SKILL).tooltip.includes('In every chat: its description (~15 tokens)'), t.find(SKILL).tooltip);
    assert.ok(
      t.find('plugin:team-test:docs').tooltip.includes('If enabled, in every chat: ~12 tokens (1 description ~12)'),
      t.find('plugin:team-test:docs').tooltip,
    );
    assert.ok(hook.status().tooltip.includes('In every chat: ~39 tokens (3 descriptions ~39)'), hook.status().tooltip);

    t.step('make the rule always applied');
    const clone = path.dirname(registered);
    fs.writeFileSync(path.join(clone, 'review', 'rules', 'style.mdc'), ALWAYS_STYLE);
    await t.waitFor(() => (t.find(RULE) || { description: '' }).description === 'rule · always', 'the rule row to read rule · always');
    assert.ok(
      t.find(RULE).tooltip.includes('Applies always: the whole rule is in every chat (~11 tokens)'),
      t.find(RULE).tooltip,
    );
    await t.waitFor(() => hook.viewDescription() === '~41 tokens per chat', 'the title to show ~41 tokens per chat');
    assert.ok(
      t.find(PLUGIN).tooltip.includes('In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)'),
      t.find(PLUGIN).tooltip,
    );

    t.step('untick the plugin: nothing is in the chat');
    await hook.check(PLUGIN, false);
    await t.waitFor(() => hook.viewDescription() === '', 'the title to show nothing');
    assert.ok(!hook.status().tooltip.includes('In every chat'), hook.status().tooltip);
    assert.ok(!t.find(PLUGIN).description.includes('tokens'), t.find(PLUGIN).description);
    assert.ok(t.find(PLUGIN).tooltip.includes('If enabled, in every chat: ~41 tokens'), t.find(PLUGIN).tooltip);
    t.noSpinner();
  },
};
