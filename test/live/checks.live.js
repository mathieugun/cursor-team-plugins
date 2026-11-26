'use strict';

// A skill whose frontmatter Cursor can't parse shows as a problem in the view and as a diagnostic (on the clone file and
// on its partial copy); Commit and push stops with the list until the user pushes anyway.

const fs = require('fs');
const path = require('path');

const BROKEN = '---\nname: code-review\ndescription: Use when: reviewing a change\n---\nReview the change.\n';
const FIXED = '---\nname: code-review\ndescription: "Use when: reviewing a change"\n---\nReview the change.\n';

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
    const { hook, assert, vscode } = t;
    const lower = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const diagnosticsOf = (file) => {
      const found = Object.entries(hook.diagnostics()).find(([f]) => lower(f) === lower(file));
      return found ? found[1] : null;
    };
    const ITEM = 'item:team-test:review/skills/code-review';
    const PLUGIN = 'plugin:team-test:review';

    t.step('wait for review to be registered');
    const registered = await t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000);
    await t.idle();
    const clone = path.dirname(registered);
    const skill = path.join(clone, 'review', 'skills', 'code-review', 'SKILL.md');
    const key = hook.states()[0].key;

    t.step('break the skill: unquoted description with ": "');
    fs.writeFileSync(skill, BROKEN);
    await t.waitFor(() => {
      const n = t.find(ITEM);
      return n && n.icon === 'error' && n.description.endsWith(' · problem');
    }, 'the code-review row to show a problem');
    await t.waitFor(() => (t.find(PLUGIN) || { description: '' }).description.includes('1 problem'), 'the plugin row to count 1 problem');

    t.step('the problem is a diagnostic');
    const first = await t.waitFor(() => diagnosticsOf(skill), 'a diagnostic on SKILL.md');
    assert.equal(first.length, 1, JSON.stringify(first));
    assert.equal(first[0].severity, 'error');
    assert.equal(first[0].line, 3);
    assert.ok(first[0].message.startsWith('Frontmatter is not valid YAML, so Cursor drops this skill'), first[0].message);

    t.step('commit and push, cancel the check');
    const before = (await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%H', 'main'])).stdout;
    hook.clearCalls();
    hook.respond(() => undefined);
    await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: key });
    const modal = t.messages('showWarningMessage').find((c) => /^1 problem\(s\) in your changes to/.test(c.message));
    assert.ok(modal, JSON.stringify(t.messages()));
    assert.equal(modal.modal, true);
    assert.deepEqual(modal.buttons, ['Push anyway', 'Open files']);
    assert.ok(modal.detail.includes('review/skills/code-review/SKILL.md:3: '), modal.detail);
    assert.equal(t.messages('showInputBox').length, 0, 'no commit message was asked');
    const after = (await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%H', 'main'])).stdout;
    assert.equal(after, before);

    t.step('commit and push anyway');
    hook.clearCalls();
    hook.respond((c) => {
      if (c.kind === 'showWarningMessage' && /problem\(s\) in your changes to/.test(c.message)) {
        return 'Push anyway';
      }
      if (c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt)) {
        return 'Live check commit';
      }
      return undefined;
    });
    await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: key });
    await t.waitFor(
      () => t.messages('showInformationMessage').some((c) => /^Pushed [0-9a-f]{7} to main: /.test(c.message)),
      'the Pushed message',
    );
    const log = await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'main']);
    assert.equal(log.stdout, 'Live check commit');
    hook.respond(() => undefined);

    t.step('untick security-check: the partial copy gets the diagnostic too');
    await hook.check('item:team-test:review/skills/security-check', false);
    const copy = await t.waitFor(() => {
      const p = hook.registrations()['team-test:review'];
      return p && p.includes(`${path.sep}filtered${path.sep}`) ? p : null;
    }, 'review registered from a filtered copy');
    const copySkill = path.join(copy, 'skills', 'code-review', 'SKILL.md');
    const mirrored = await t.waitFor(() => diagnosticsOf(copySkill), 'a diagnostic on the copy of SKILL.md');
    assert.equal(mirrored[0].line, 3);
    assert.ok(mirrored[0].message.startsWith('Frontmatter is not valid YAML, so Cursor drops this skill'), mirrored[0].message);

    t.step('fix the skill: the problem goes');
    fs.writeFileSync(skill, FIXED);
    await t.waitFor(() => {
      const n = t.find(ITEM);
      return n && n.icon === 'sparkle';
    }, 'the code-review row to show its skill icon again');
    await t.waitFor(() => Object.keys(hook.diagnostics()).length === 0, 'no diagnostic left', 30000);
    t.noSpinner();
  },
};
