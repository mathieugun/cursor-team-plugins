'use strict';

// A skill whose frontmatter Cursor can't parse shows as a problem in the view and as a diagnostic (on the clone file and
// on its partial copy). Either push command asks before continuing if the check fails. A failed queued write is reported.

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

    t.step('a failed pre-push check can cancel either push command');
    const failure = 'Could not collect changed paths in the live check';
    const warning = `The check before pushing failed: ${failure}`;
    const remoteRefs = async () => {
      const refs = await t.git(['--git-dir', t.data.bare, 'show-ref']);
      assert.equal(refs.code, 0, refs.stderr);
      return refs.stdout;
    };
    // Repository selection still uses real git status.
    hook.replaceChangedPaths(async () => {
      throw new Error(failure);
    });
    try {
      const refsBefore = await remoteRefs();
      for (const command of ['teamPlugins.commitAndPush', 'teamPlugins.pushToBranch']) {
        hook.clearCalls();
        await vscode.commands.executeCommand(command, { repo: key });
        const modal = t.messages('showWarningMessage').find((c) => c.message === warning);
        assert.ok(modal, JSON.stringify(t.messages()));
        assert.equal(modal.modal, true);
        assert.deepEqual(modal.buttons, ['Push anyway']);
        assert.equal(t.messages('showInputBox').length, 0, 'no branch or commit message was asked');
        assert.equal(await remoteRefs(), refsBefore);
      }

      t.step('push to a branch anyway after the check fails');
      hook.clearCalls();
      hook.respond((c) => {
        if (c.kind === 'showWarningMessage' && c.message === warning) {
          return 'Push anyway';
        }
        if (c.kind === 'showInputBox' && /^Branch to push/.test(c.prompt)) {
          return 'live-check';
        }
        if (c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt)) {
          return 'Live check branch commit';
        }
        return undefined;
      });
      await vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: key });
      const branchLog = await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'refs/heads/live-check']);
      assert.equal(branchLog.stdout, 'Live check branch commit', branchLog.stderr);

      t.step('commit and push anyway after the check fails');
      fs.writeFileSync(skill, `${FIXED}\nEdited by the live test.\n`);
      hook.clearCalls();
      hook.respond((c) => {
        if (c.kind === 'showWarningMessage' && c.message === warning) {
          return 'Push anyway';
        }
        return c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt)
          ? 'Live check override commit'
          : undefined;
      });
      await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: key });
      const mainLog = await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'main']);
      assert.equal(mainLog.stdout, 'Live check override commit', mainLog.stderr);
    } finally {
      hook.replaceChangedPaths(null);
    }

    t.step('New plugin reports a queued write failure, then works on retry');
    const drafts = path.join(hook.storage, '.cursor', 'plugins', 'drafts');
    const newPlugin = () => vscode.commands.executeCommand('teamPlugins.newPlugin');
    hook.respond((c) => {
      if (c.kind === 'showQuickPick' && c.placeHolder === 'Where to create the plugin') {
        return 'drafts';
      }
      if (c.kind === 'showInputBox' && c.prompt === 'Plugin name') {
        return 'live-check-draft';
      }
      return c.kind === 'showInputBox' && c.prompt === 'Plugin description (optional)' ? '' : undefined;
    });
    hook.clearCalls();
    fs.writeFileSync(drafts, 'Blocks creation of the drafts directory', { flag: 'wx' });
    try {
      await newPlugin();
      const errors = t.messages('showErrorMessage');
      assert.equal(errors.length, 1, JSON.stringify(t.messages()));
      assert.match(errors[0].message, /^Team plugins: EEXIST: .*mkdir /);
    } finally {
      fs.unlinkSync(drafts);
    }
    hook.clearCalls();
    await newPlugin();
    assert.equal(t.messages('showErrorMessage').length, 0, JSON.stringify(t.messages()));
    assert.ok(fs.existsSync(path.join(drafts, 'live-check-draft', '.cursor-plugin', 'plugin.json')));

    t.step('cancelling New plugin after choosing drafts stays silent');
    hook.clearCalls();
    hook.respond((c) => (c.kind === 'showQuickPick' ? 'drafts' : undefined));
    await newPlugin();
    assert.ok(t.messages('showInputBox').some((c) => c.prompt === 'Plugin name' && c.answer === null));
    assert.equal(t.messages('showErrorMessage').length, 0, JSON.stringify(t.messages()));
    t.noSpinner();
  },
};
