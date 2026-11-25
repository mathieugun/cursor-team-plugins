'use strict';

// Rename a skill and two plugins (one registered from the clone, one from a partial copy): files, marketplace.json and
// its record, the user's lists; then a teammate's old id and a repository renamed through its marketplace.json are read
// through the records.

const fs = require('fs');
const path = require('path');

module.exports = {
  timeoutSec: 150,

  setup(ctx) {
    const url = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'));
    return {
      settings: {
        'teamPlugins.repositories': [url],
        'teamPlugins.enabled': ['team-test:review', 'team-test:docs/skills/write-readme'],
      },
      data: { bare: url },
    };
  },

  async run(t) {
    const { hook, assert, vscode } = t;
    const config = () => vscode.workspace.getConfiguration('teamPlugins');
    const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    const answer = (prompt, value) =>
      hook.respond((c) => (c.kind === 'showInputBox' && c.prompt === prompt ? value : undefined));

    t.step('wait for review to be registered');
    const registered = await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    await t.idle();
    const clone = path.dirname(registered);
    const key = hook.states()[0].key;
    const market = path.join(clone, '.cursor-plugin', 'marketplace.json');

    t.step('rename the skill code-review');
    answer('New name for the skill code-review', 'review-code');
    assert.ok(t.find('item:team-test:review/skills/code-review'), 'the skill node is missing');
    await vscode.commands.executeCommand('teamPlugins.rename', { kind: 'skill', key: 'team-test:review/skills/code-review' });
    await t.idle();
    const skillFile = path.join(clone, 'review', 'skills', 'review-code', 'SKILL.md');
    assert.ok(fs.existsSync(skillFile), 'the renamed skill file is missing');
    assert.match(fs.readFileSync(skillFile, 'utf8'), /^name: review-code$/m);
    assert.ok(!fs.existsSync(path.join(clone, 'review', 'skills', 'code-review')), 'the old folder is still there');
    assert.equal(readJson(market).renamed['review/skills/code-review'], 'review/skills/review-code');
    await t.waitFor(() => t.find('item:team-test:review/skills/review-code'), 'the new item node');
    await t.waitFor(
      () => t.messages('showInformationMessage').some((c) => c.message.startsWith('Renamed code-review to review-code in team-test')),
      'the Renamed message',
    );
    await t.waitFor(() => t.find(`changes:${key}`), 'the Local changes node');

    t.step('rename the plugin docs');
    answer('New name for the plugin docs', 'guides');
    assert.ok(t.find('plugin:team-test:docs'), 'the docs node is missing');
    await vscode.commands.executeCommand('teamPlugins.rename', { kind: 'plugin', key: 'team-test:docs' });
    await t.idle();
    await t.waitFor(
      () => config().get('enabled').includes('team-test:guides/skills/write-readme'),
      'enabled to hold the renamed id',
    );
    const guides = await t.waitFor(() => hook.registrations()['team-test:guides'], 'guides registered');
    assert.ok(guides.endsWith('guides'), guides);
    await t.waitFor(() => /Registered extension plugin: guides from/.test(t.pluginsLog()), 'Cursor registered guides');
    const after = readJson(market);
    const entry = after.plugins.find((p) => p.name === 'guides');
    assert.ok(entry && entry.source === './guides', JSON.stringify(after.plugins));
    assert.equal(after.renamed.docs, 'guides');
    assert.equal(readJson(path.join(clone, 'guides', '.cursor-plugin', 'plugin.json')).name, 'guides');

    t.step("a teammate's old id is rewritten");
    await config().update('excluded', ['team-test:review/skills/code-review'], vscode.ConfigurationTarget.Global);
    await t.waitFor(
      () => JSON.stringify(config().get('excluded')) === JSON.stringify(['team-test:review/skills/review-code']),
      'excluded to read the new id',
    );

    t.step('rename review while it is registered from a partial copy');
    const filtered = (p) => p && p.includes(`${path.sep}filtered${path.sep}`);
    await t.waitFor(() => filtered(hook.registrations()['team-test:review']), 'review registered from a copy');
    answer('New name for the plugin review', 'audit');
    await vscode.commands.executeCommand('teamPlugins.rename', { kind: 'plugin', key: 'team-test:review' });
    await t.idle();
    const audit = await t.waitFor(() => {
      const p = hook.registrations()['team-test:audit'];
      return filtered(p) && path.basename(p) === 'audit' ? p : null;
    }, 'audit registered from a copy');
    assert.deepEqual(config().get('excluded'), ['team-test:audit/skills/review-code']);
    assert.ok(!fs.existsSync(path.join(audit, 'skills', 'review-code')), 'the excluded skill is in the copy');
    await t.idle();
    assert.ok(!fs.readdirSync(clone).includes('review'), 'the old plugin folder came back in the clone');
    assert.equal(readJson(market).renamed.review, 'audit');
    assert.equal(readJson(market).renamed['review/skills/code-review'], 'audit/skills/review-code');

    t.step('rename the repository');
    const renamedRepo = readJson(market);
    renamedRepo.name = 'team-renamed';
    fs.writeFileSync(market, JSON.stringify(renamedRepo, null, 2) + '\n');
    await t.waitFor(() => {
      const enabled = config().get('enabled');
      return enabled.includes('team-renamed:audit') && enabled.includes('team-renamed:guides/skills/write-readme');
    }, 'enabled to hold the new repository name');
    const names = await t.waitFor(() => {
      try {
        return readJson(path.join(hook.storage, 'repo-names.json'));
      } catch {
        return null;
      }
    }, 'repo-names.json');
    assert.deepEqual(names[key].former, ['team-test'], JSON.stringify(names));
  },
};
