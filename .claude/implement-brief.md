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
log and the Team Plugins view. A local bare repo in the scratchpad can stand in for the team repository.

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
- On Windows a folder Cursor watches (a registered plugin) cannot be deleted: EPERM, and it is left half-deleted and
  unreadable. Update registered folders in place; delete only unregistered ones.

## Implementer lessons
<!-- One line per project-specific mistake seen in review. -->
