# implement-brief: cursor-team-plugins specifics

Read by the user-level `implement-brief` skill.

## Checking assumptions
- Cursor behaviour (plugin API, what gets registered): a throwaway probe extension in the scratchpad, started with
  `"$LOCALAPPDATA/Programs/cursor/resources/app/bin/cursor.cmd" --new-window --extensionDevelopmentPath=<probe> <empty folder>`;
  the probe writes its results to a JSON file and closes its window (`workbench.action.closeWindow`).
- What Cursor did: `%APPDATA%\Cursor\logs\<latest session>\window<N>\exthost\anysphere.cursor-agent-host\Cursor Plugins.log`
  (`Registered extension plugin: <name> from <path>`, `Unregistered extension plugin: <path>`,
  `Plugins reload completed: N plugins loaded (M extension, ...)`).
- Only `vscode.cursor.plugins.addPlugin/removePlugin` are usable by a non-built-in extension; the rest of
  `vscode.cursor` throws "CANNOT use API proposal".

## Tests
No node on PATH: run with Cursor's runtime.
`ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js`
(`--test` needs explicit files under this runtime; scripts/test.js lists them).

## Keep in step
README.md (users, authors, limits), AGENTS.md, `package.json` version and `contributes` (settings, commands, menus).

## Live test
Needs the user's OK (it changes the Cursor they use): package
(`ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js`), then
`cursor --install-extension dist/cursor-team-plugins-<version>.vsix` and a window reload; check the Cursor Plugins
log and the Team Plugins view. The team repository is the fixture: build it with
`scripts/make-test-repo.js <scratchpad>/team-plugins.git` (plugins `review` and `docs`) and point `teamPlugins.repoUrl`
at the path it prints (a URL change switches the managed clone in place). Test names stay generic: no company or
team names in fixtures, settings or test data.

## Don't
Never install the extension or launch Cursor windows without the user asking (probe windows for checking
assumptions are fine when the user asked for the assumptions to be tested).

## Facts for plans
- Cursor names an extension plugin after its folder, not `plugin.json`'s `name` (a probe whose folder and name are
  equal can't tell them apart: give them different values).
- With Cursor's runtime on Windows, `fs.rmSync` throws EPERM on git's read-only object files: use `sync.removeTree`.
- `git reset --hard @{u}` resets to the upstream as of the last fetch: a test expecting `updated` afterwards needs a
  new remote commit.

- Partial copies sync both ways: any operation that resets the managed clone (discard, push to a branch) must also
  reset the copies (`resetPartialCopies` → `markCopySynced`), or their newer edits flow back into the clone.
- On Windows the **parent** of a registered plugin folder cannot be deleted or renamed while the plugin is registered
  (EPERM, possibly left half-deleted), in any window that registered it; the registered folder itself, its files and
  subfolders can be edited and deleted, and after `removePlugin` the parent can be deleted at once (probe, Cursor
  3.31, 2026-11-22). The managed clone and the `filtered/<name>-<hash>` holders are such parents: update them in
  place; delete only unregistered ones.

- On Windows `revealFileInOS` opens Explorer behind the Cursor window, so the user sees nothing happen: open the
  files in an editor instead (`showTextDocument`).

- Two test repositories built the same way (`makeOrigin` in `test/sync.test.js`) within one second get identical
  commit hashes (same tree, identity and time): a test that needs them to differ pushes an extra commit to one.

- A VSIX rebuilt without a version change may not replace the installed one: check
  `%USERPROFILE%\.cursor\extensions\mg.cursor-team-plugins-<version>\extension.js` after installing (`--force`).

## Implementer lessons
<!-- One line per project-specific mistake seen in review. -->
