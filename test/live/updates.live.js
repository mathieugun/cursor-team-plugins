'use strict';

// The update summary: a teammate's commit marks the items it changed and added, the notification names them, What
// changed opens their diffs (an item counts as seen once its diff is open), Show changes shows an item's last change.

const fs = require('fs');
const path = require('path');

const ALICE = ['-c', 'user.name=Alice', '-c', 'user.email=alice@example.com', '-c', 'commit.gpgsign=false'];

module.exports = {
  timeoutSec: 120,

  setup(ctx) {
    const url = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'));
    return {
      settings: { 'teamPlugins.repositories': [url], 'teamPlugins.enabled': ['team-test:review'] },
      data: { bare: url, work: path.join(ctx.repos, 'work') },
    };
  },

  async run(t) {
    const { hook, assert, vscode } = t;
    const CODE_REVIEW = 'item:team-test:review/skills/code-review';
    const NEW_SKILL = 'item:team-test:docs/skills/new-skill';
    const tabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).map((tab) => tab.label);
    const tabStarting = (prefix) => tabs().some((label) => label.startsWith(prefix));
    const must = async (promise, what) => {
      const r = await promise;
      assert.equal(r.code, 0, `${what}: ${r.stderr}`);
      return r;
    };

    t.step('wait for review to be registered');
    const registered = await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    const clone = path.dirname(registered);
    await t.idle();
    const key = hook.states()[0].key;
    assert.equal(hook.badge(), null);
    assert.equal(t.find(CODE_REVIEW).description, 'skill');
    assert.ok(fs.existsSync(path.join(hook.storage, 'seen', `${key}.json`)), 'the seen record is missing');

    t.step('a teammate changes code-review and adds a skill');
    const { bare, work } = t.data;
    await must(t.git(['clone', bare, work]), 'clone');
    fs.appendFileSync(path.join(work, 'review', 'skills', 'code-review', 'SKILL.md'), '\nAlways read the diff first.\n');
    fs.writeFileSync(path.join(work, 'review', 'skills', 'code-review', 'checklist.md'), '- tests\n- names\n');
    fs.mkdirSync(path.join(work, 'docs', 'skills', 'new-skill'), { recursive: true });
    fs.writeFileSync(
      path.join(work, 'docs', 'skills', 'new-skill', 'SKILL.md'),
      '---\nname: new-skill\ndescription: New skill\n---\nbody\n',
    );
    await must(t.git(['add', '-A'], work), 'add');
    await must(t.git([...ALICE, 'commit', '-m', 'Improve code-review'], work), 'commit');
    await must(t.git(['push', 'origin', 'HEAD'], work), 'push');

    t.step('sync: the notification names the changes');
    await vscode.commands.executeCommand('teamPlugins.syncNow');
    const notice = await t.waitFor(
      () =>
        t
          .messages('showInformationMessage')
          .find(
            (c) =>
              c.message ===
              'Team plugins (team-test): Alice updated code-review and Alice added new-skill. Start a new chat to use the changes.',
          ),
      'the update notification',
    );
    assert.deepEqual(notice.buttons, ['What changed']);
    await t.idle();

    t.step('the view marks the two items');
    const codeReview = t.find(CODE_REVIEW);
    assert.equal(codeReview.description, 'skill · updated');
    assert.equal(t.find(NEW_SKILL).description, 'skill · new');
    const tooltip = codeReview.tooltip;
    assert.ok(tooltip.includes('Last changed by Alice, just now'), tooltip);
    assert.ok(tooltip.includes('Updated since you last looked'), tooltip);
    assert.equal(hook.decoration('team-test:review/skills/code-review').badge, 'M');
    assert.equal(hook.decoration('team-test:docs/skills/new-skill').badge, 'N');
    assert.equal(hook.badge().value, 2);
    assert.ok(t.find(`repo:${key}`).description.includes('1 new · 1 updated'), t.find(`repo:${key}`).description);

    t.step('What changed lists them and opens a diff');
    hook.clearCalls();
    hook.respond((c) => (c.kind === 'showQuickPick' ? c.items.find((label) => label.endsWith(' code-review')) : undefined));
    await vscode.commands.executeCommand('teamPlugins.whatChanged', { repo: key });
    const pick = t.messages('showQuickPick')[0];
    assert.ok(pick, 'no pick list was shown');
    assert.equal(pick.items[0], '$(check-all) Mark all as seen');
    assert.equal(pick.items.length, 3, JSON.stringify(pick.items));
    await t.waitFor(() => tabStarting('code-review (Alice, '), 'the code-review diff tab');
    await t.waitFor(() => t.find(CODE_REVIEW).description === 'skill', 'code-review to count as seen');
    assert.equal(hook.badge().value, 1);

    t.step('the last one opens at once');
    hook.clearCalls();
    await vscode.commands.executeCommand('teamPlugins.whatChanged', { repo: key });
    assert.equal(t.messages('showQuickPick').length, 0, 'a pick list for one item');
    await t.waitFor(() => tabStarting('new-skill (Alice, '), 'the new-skill diff tab');
    await t.waitFor(() => hook.badge() === null, 'the badge to go');

    t.step('Show changes on a seen item shows its last change');
    await vscode.commands.executeCommand('teamPlugins.showChanges', { kind: 'skill', key: 'team-test:review/skills/code-review' });
    await t.waitFor(() => tabStarting('code-review: last change (Alice, '), 'the last change tab');

    t.step('delete the seen skill through a partial copy');
    await hook.check('item:team-test:review/skills/security-check', false);
    const copy = await t.waitFor(() => {
      const dir = hook.registrations()['team-test:review'];
      return dir?.includes(`${path.sep}filtered${path.sep}`) && dir;
    }, 'review registered from a filtered copy');
    await t.idle();
    hook.clearCalls();
    const skillDoc = path.join('skills', 'code-review', 'SKILL.md');
    const source = path.join(clone, 'review', skillDoc);
    fs.unlinkSync(path.join(copy, skillDoc));
    await t.waitFor(() => !fs.existsSync(source) && !t.find(CODE_REVIEW), 'the local deletion to reach the clone and view');
    await t.idle();
    assert.deepEqual(hook.updates(key).counts, { new: 0, updated: 0, removed: 0 });
    assert.equal(hook.badge(), null);
    assert.equal(t.messages('showInformationMessage').length, 0);

    t.step('discard the local deletion and check the restored skill');
    hook.respond((c) => (c.kind === 'showWarningMessage' && c.buttons.includes('Discard') ? 'Discard' : undefined));
    await vscode.commands.executeCommand('teamPlugins.discardLocalChanges', { repo: key });
    await t.waitFor(() => fs.existsSync(source) && t.find(CODE_REVIEW)?.description === 'skill', 'the unmarked skill to be restored');
    await t.idle();
    assert.deepEqual(hook.updates(key).counts, { new: 0, updated: 0, removed: 0 });
    assert.equal(hook.badge(), null);

    t.step('a teammate renames and edits a rule, then removes it before it is seen');
    const oldRule = 'review/rules/style.mdc';
    const newRule = 'review/rules/renamed-style.mdc';
    const originalText = fs.readFileSync(path.join(work, oldRule), 'utf8');
    const marketplace = path.join(work, '.cursor-plugin', 'marketplace.json');
    const manifest = JSON.parse(fs.readFileSync(marketplace, 'utf8'));
    manifest.renamed = { [oldRule]: newRule };
    fs.writeFileSync(marketplace, JSON.stringify(manifest));
    fs.renameSync(path.join(work, oldRule), path.join(work, newRule));
    fs.appendFileSync(path.join(work, newRule), '\nAn extra instruction.\n');
    const publish = async (subject) => {
      await must(t.git(['add', '-A'], work), 'add');
      await must(t.git([...ALICE, 'commit', '-m', subject], work), 'commit');
      await must(t.git(['push', 'origin', 'HEAD'], work), 'push');
      await vscode.commands.executeCommand('teamPlugins.syncNow');
      await t.idle();
    };
    await publish('Rename and edit the style rule');
    assert.equal(hook.updates(key).marks[newRule], 'updated');
    fs.unlinkSync(path.join(work, newRule));
    await publish('Remove the renamed rule');
    assert.deepEqual(hook.updates(key).removed, [newRule]);

    t.step('the removal diff opens the last-seen content at the old path');
    hook.respond(() => undefined);
    await vscode.commands.executeCommand('teamPlugins.whatChanged', { repo: key });
    const input = await t.waitFor(
      () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
        .find((tab) => tab.label.startsWith('renamed-style (Alice, '))?.input,
      'the rule removal diff',
    );
    assert.ok(input instanceof vscode.TabInputTextDiff);
    assert.equal(JSON.parse(decodeURIComponent(input.original.query)).path, oldRule);
    const original = await vscode.workspace.openTextDocument(input.original);
    assert.equal(original.getText().replace(/\r\n/g, '\n'), originalText.replace(/\r\n/g, '\n'));
    t.noSpinner();
  },
};
