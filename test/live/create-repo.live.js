'use strict';

// Create team repository: scans the open project and a second one, previews, compares and merges a variant, pushes to
// an empty repository, follows it and replaces the originals. A second run is cancelled at the list of what to import, a
// third at the preview's Continue.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = `ghp_${'x'.repeat(36)}`;
const skill = (name) => `---\nname: ${name}\ndescription: Skill ${name}.\n---\nReview the change.\n`;

function write(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

module.exports = {
  timeoutSec: 180,

  setup(ctx) {
    const other = path.join(ctx.repos, 'other');
    write(ctx.ws, '.cursor/rules/style.mdc', '---\ndescription: Style\n---\nStyle rule.\n');
    write(ctx.ws, '.cursor/rules/db.mdc', '---\ndescription: Database\n---\nText A.\n');
    write(ctx.ws, '.cursor/skills/code-review/SKILL.md', skill('code-review'));
    write(
      ctx.ws,
      '.cursor/mcp.json',
      JSON.stringify(
        { mcpServers: { github: { command: 'npx', env: { GITHUB_TOKEN: TOKEN } }, lint: { command: 'node' } } },
        null,
        2,
      ),
    );
    write(other, '.cursor/rules/db.mdc', '---\ndescription: Database\n---\nText B.\n');
    write(other, '.cursor/skills/code-review/SKILL.md', skill('code-review').replace(/\n/g, '\r\n'));
    write(other, '.cursor/rules/api.mdc', '---\ndescription: Api\n---\nSee [t](mdc:src/x.ts)\n');
    write(other, 'src/x.ts', 'export {};\n');
    const bare = path.join(ctx.repos, 'new-team.git');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'trunk', bare]);
    return { settings: { 'teamPlugins.repositories': [] }, data: { bare, other, ws: ctx.ws } };
  },

  async run(t) {
    const { hook, assert, vscode } = t;
    const { bare, other, ws } = t.data;
    // every file of a folder and its content, to show that a folder was left untouched
    const snapshot = (root) =>
      Object.fromEntries(
        fs
          .readdirSync(root, { recursive: true })
          .map((rel) => String(rel))
          .filter((rel) => fs.statSync(path.join(root, rel)).isFile())
          .sort()
          .map((rel) => [rel, fs.readFileSync(path.join(root, rel)).toString('base64')]),
      );
    const otherBefore = snapshot(other);
    const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((tab) => tab.label));
    // the schemes of the two sides of the diff tab whose label matches
    const diffSides = (re) => {
      const tab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((x) => re.test(x.label));
      return tab && tab.input instanceof vscode.TabInputTextDiff
        ? { original: tab.input.original.scheme, modified: tab.input.modified.scheme }
        : null;
    };
    const saved = {};
    const identity = {
      GIT_AUTHOR_NAME: 'Live Test',
      GIT_AUTHOR_EMAIL: 'live@example.com',
      GIT_COMMITTER_NAME: 'Live Test',
      GIT_COMMITTER_EMAIL: 'live@example.com',
    };
    for (const k of Object.keys(identity)) {
      saved[k] = process.env[k];
    }
    Object.assign(process.env, identity);
    try {
      await t.idle();

      let expectedBranch = 'main';
      try {
        const configured = execFileSync('git', ['config', '--get', 'init.defaultBranch'], { encoding: 'utf8' }).trim();
        if (configured) {
          execFileSync('git', ['check-ref-format', '--branch', configured]);
          expectedBranch = configured;
        }
      } catch {
        // not set, or not a valid branch name: main
      }
      const url = path.resolve(bare);
      const expectedEntry = expectedBranch === 'trunk' ? { url } : { url, branch: expectedBranch };

      const seen = { groups: null, previewOpen: false, compared: false, decisions: 0, replaceItems: null };
      hook.respond(async (r, args) => {
        if (r.kind === 'showQuickPick') {
          const items = args[0];
          if (/^Where to look/.test(r.placeHolder)) {
            return items.filter((i) => i.folder || i.other);
          }
          if (/^What goes in/.test(r.placeHolder)) {
            seen.groups = items.map((i) => ({ label: i.label, picked: i.picked, description: i.description }));
            for (let i = 0; i < 20 && !labels().some((l) => l.includes('new-team-repository-preview.md')); i++) {
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
            seen.tabs = labels();
            seen.previewOpen = seen.tabs.some((l) => l.includes('new-team-repository-preview.md'));
            return items;
          }
          if (/versions\. Which one goes/.test(r.placeHolder)) {
            seen.decisions++;
            if (seen.decisions === 1) {
              return items.find((i) => i.compare);
            }
            seen.compared = labels().some((l) => l.startsWith('db:'));
            seen.compareSides = diffSides(/^db: (?!.*your merge)/);
            return items.find((i) => i.merge);
          }
          if (/^Version to start from/.test(r.placeHolder)) {
            return items[0];
          }
          if (/^Originals to replace/.test(r.placeHolder)) {
            seen.replaceItems = items.filter((i) => i.original).map((i) => ({ label: i.label, picked: i.picked }));
            // only the workspace's originals: the other project contributes to the plugin but keeps its files
            return items.filter((i) => i.original && i.picked && i.label.startsWith(`${path.basename(ws)}/`));
          }
        }
        if (r.kind === 'showOpenDialog') {
          return [vscode.Uri.file(other)];
        }
        if (r.kind === 'showInputBox') {
          if (/^Git URL of an empty repository/.test(r.prompt)) {
            return bare;
          }
          if (/^Name of the plugin/.test(r.prompt)) {
            return 'shared';
          }
        }
        if (r.kind === 'showInformationMessage') {
          if (/^Team plugins: read the preview of the new team repository/.test(r.message)) {
            seen.previewAsked = true;
            return 'Continue';
          }
          if (/^Comparing the rule db: /.test(r.message)) {
            seen.compareMessage = r.buttons;
            return 'Back to the choices';
          }
          const merging = /\((.+)\), save it/.exec(r.message);
          if (/^Merging the rule db/.test(r.message) && merging) {
            seen.mergeTries = (seen.mergeTries || 0) + 1;
            if (seen.mergeTries === 1) {
              // Done before any edit: the unchanged-merge warning must stop it
              seen.mergeSides = diffSides(/your merge \(edit this side\)/);
              return 'Done';
            }
            // the edit goes through the editor of the diff's right side, then a save, as a user does it
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(merging[1]));
            const edit = new vscode.WorkspaceEdit();
            edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), 'MERGED\n');
            assert.ok(await vscode.workspace.applyEdit(edit), 'the edit of the merge was not applied');
            assert.ok(await doc.save(), 'the merge was not saved');
            return 'Done';
          }
          if (/^Team plugins: created /.test(r.message)) {
            assert.ok(seen.previewOpen, 'the preview was not open at the list of what to import');
            return 'Replace the originals';
          }
        }
        if (r.kind === 'showWarningMessage' && /your merge of the rule db is still the /.test(r.message)) {
          seen.unchangedWarned = true;
          return 'Back to editing';
        }
        if (r.kind === 'showWarningMessage' && /^Create the team repository at /.test(r.message)) {
          return 'Create and push';
        }
        return undefined;
      });

      t.step('create the team repository');
      await vscode.commands.executeCommand('teamPlugins.createTeamRepository');

      t.step('what the list offered');
      assert.ok(seen.groups, 'the list of what to import was not shown');
      assert.equal(seen.groups.length, 6, JSON.stringify(seen.groups));
      assert.ok(seen.groups.every((g) => g.picked), JSON.stringify(seen.groups));
      const api = seen.groups.find((g) => g.label === 'api');
      assert.ok(api && api.description.endsWith('1 reference may break'), JSON.stringify(api));
      assert.ok(seen.compared, 'no diff tab starting with "db:" was open at the second decision');
      // the list and the choices wait for a click, so they don't cover the preview or the diff
      assert.ok(seen.previewAsked, 'the list of what to import did not wait for Continue');
      assert.deepEqual(seen.compareMessage, ['Back to the choices']);
      // the originals are shown read-only in the compare and merge diffs; only the merge file can be edited
      assert.deepEqual(seen.compareSides && [seen.compareSides.original, seen.compareSides.modified], [
        'team-plugins-readonly',
        'team-plugins-readonly',
      ]);
      assert.deepEqual(seen.mergeSides && [seen.mergeSides.original, seen.mergeSides.modified], ['team-plugins-readonly', 'file']);
      assert.ok(seen.unchangedWarned, 'Done on an unchanged merge did not warn');
      assert.equal(seen.mergeTries, 2);
      assert.ok(seen.previewOpen, JSON.stringify(seen.tabs));

      t.step('the new repository');
      const show = async (file) => {
        const r = await t.git(['--git-dir', bare, 'show', `${expectedBranch}:${file}`]);
        assert.equal(r.code, 0, `${file}: ${r.stderr}`);
        return r.stdout;
      };
      const market = JSON.parse(await show('.cursor-plugin/marketplace.json'));
      assert.equal(market.name, 'new-team');
      assert.ok((await show('shared/rules/style.mdc')).includes('Style rule.'));
      assert.equal(await show('shared/rules/db.mdc'), 'MERGED');
      assert.ok((await show('shared/rules/api.mdc')).includes('mdc:src/x.ts'));
      assert.ok((await show('shared/skills/code-review/SKILL.md')).includes('Review the change.'));
      const mcp = await show('shared/mcp.json');
      assert.ok(mcp.includes('${env:GITHUB_TOKEN}'), mcp);
      assert.ok(!mcp.includes('ghp_'), mcp);
      assert.deepEqual(vscode.workspace.getConfiguration('teamPlugins').get('repositories'), [expectedEntry]);

      t.step('the plugin is registered and ticked');
      await t.waitFor(() => hook.registrations()['new-team:shared'], 'new-team:shared registered', 60000);
      assert.ok(vscode.workspace.getConfiguration('teamPlugins').get('enabled').includes('new-team:shared'));

      t.step('the scratch tabs are closed');
      assert.ok(!labels().some((l) => l.includes('new-team-repository-preview.md') || l.includes('your merge')), JSON.stringify(labels()));

      t.step('the originals');
      await t.waitFor(
        () => t.messages('showInformationMessage').some((c) => /^Team plugins: replaced \d+ originals? with the plugin new-team:shared/.test(c.message)),
        'the replaced message',
      );
      assert.ok(seen.replaceItems && seen.replaceItems.length > 0);
      const has = (root, rel) => fs.existsSync(path.join(root, ...rel.split('/')));
      assert.ok(!has(ws, '.cursor/rules/style.mdc'), 'style.mdc should be gone');
      assert.ok(!has(ws, '.cursor/skills/code-review'), 'the skill should be gone');
      assert.ok(has(ws, '.cursor/rules/db.mdc'), 'db.mdc was merged by hand: it stays');
      const servers = JSON.parse(fs.readFileSync(path.join(ws, '.cursor', 'mcp.json'), 'utf8')).mcpServers;
      assert.deepEqual(Object.keys(servers), ['github']);
      // the other project's originals were not ticked: its files are byte for byte what they were
      assert.deepEqual(snapshot(other), otherBefore, 'the other project changed');
      assert.deepEqual(fs.readdirSync(path.join(hook.storage, 'new-repository')), []);
      const backups = fs.readdirSync(path.join(hook.storage, 'replaced-originals'), { recursive: true });
      assert.equal(backups.filter((f) => /(^|[\\/])\d+-mcp\.json$/.test(f)).length, 1, JSON.stringify(backups));
      assert.ok(!hook.logLines().some((l) => l.includes('ghp_')), 'a token reached the log');

      t.step('a second run, cancelled at the list of what to import');
      hook.clearCalls();
      hook.respond(async (r, args) => {
        if (r.kind === 'showQuickPick' && /^Where to look/.test(r.placeHolder)) {
          return args[0].filter((i) => i.folder);
        }
        if (r.kind === 'showInformationMessage' && /^Team plugins: read the preview/.test(r.message)) {
          return 'Continue';
        }
        return undefined;
      });
      await vscode.commands.executeCommand('teamPlugins.createTeamRepository');
      await t.waitFor(
        () => t.messages('showInformationMessage').some((c) => c.message === 'Team plugins: nothing was written.'),
        'the cancel message',
      );
      assert.deepEqual(fs.readdirSync(path.join(hook.storage, 'new-repository')), []);

      t.step('a third run, cancelled at the preview');
      hook.clearCalls();
      hook.respond(async (r, args) => {
        if (r.kind === 'showQuickPick' && /^Where to look/.test(r.placeHolder)) {
          return args[0].filter((i) => i.folder);
        }
        if (r.kind === 'showInformationMessage' && /^Team plugins: read the preview/.test(r.message)) {
          return 'Cancel';
        }
        return undefined;
      });
      await vscode.commands.executeCommand('teamPlugins.createTeamRepository');
      await t.waitFor(
        () => t.messages('showInformationMessage').some((c) => c.message === 'Team plugins: nothing was written.'),
        'the cancel message',
      );
      assert.ok(!t.messages('showQuickPick').some((c) => /^What goes in/.test(c.placeHolder)), 'the list showed');
      assert.deepEqual(fs.readdirSync(path.join(hook.storage, 'new-repository')), []);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      hook.respond(null);
    }
  },
};
