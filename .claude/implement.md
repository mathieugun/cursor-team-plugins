# implement: cursor-team-plugins specifics

Read by the user-level `/implement` skill. Requests and plans follow the skill's default layout (`requests/`,
`requests/done/`, ideas in `requests/ideas.md`).

## Checking assumptions
- Cursor behaviour (plugin API, what gets registered): a throwaway probe extension in the scratchpad, started with
  `"$LOCALAPPDATA/Programs/cursor/resources/app/bin/cursor.cmd" --new-window --extensionDevelopmentPath=<probe> <empty folder>`;
  the probe writes its results to a JSON file and closes its window (`workbench.action.closeWindow`).
- Without touching the user's Cursor (probe, Cursor 3.31, 2026-11-25): an isolated instance,
  `Cursor.exe --user-data-dir=<root>/ud --extensions-dir=<root>/ext --extensionDevelopmentPath=<repo or probe>
  --extensionTestsPath=<root>/runner/index.js --disable-workspace-trust --skip-welcome --skip-release-notes
  --new-window <root>/ws`, settings in `<root>/ud/User/settings.json`. Signed out it still registers extension plugins
  and starts their MCP servers (a sign-in screen shows, blocking nothing); the window closes when the runner's `run()`
  settles (7 s for a clone and two plugins). The exit code is 0 even when `run()` rejects: read a result file the
  runner writes. `<root>` must be short (`%TEMP%\tp1`): under the scratchpad git hits MAX_PATH in the managed clone.
  Its `Cursor Plugins.log` may be under `exthost/anysphere.cursor-agent-exec`: search `<root>/ud/logs`. Still needs
  the user's OK (it opens a window).
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
README.md (Cursor users: features, install, usage, main limits), docs/development.md (internals, platform notes,
detailed limits, releasing), AGENTS.md, `package.json` version and `contributes` (settings, commands, menus).

## Live test
Run `scripts/live-test.js` first (pre-approved: isolated profile, nothing installed). A request that changes behaviour
adds or updates a scenario in `test/live/`; the install in the user's Cursor is asked only for what the scenarios can't
show (the look, Remote-SSH).
The install needs the user's OK (it changes the Cursor they use): package
(`ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js`), then
`cursor --install-extension dist/cursor-team-plugins-<version>.vsix` and a window reload; check the Cursor Plugins
log and the Team Plugins view. The team repository is the fixture: build it with
`scripts/make-test-repo.js <scratchpad>/team-plugins.git` (plugins `review` and `docs`) and add the path it prints to
`teamPlugins.repositories` (a second one built with `--name team-two`). Test names stay generic: no company or team
names in fixtures, settings or test data.
Setup and cleanup: copy `%APPDATA%\Cursor\User\settings.json` to the scratchpad first, point
`teamPlugins.repositories` at the fixture, and copy the backup back at the end (after a `diff` shows only the test's
own changes). Logs: the newest `%APPDATA%\Cursor\logs\<session>` folder that has `window*/exthost` (a
`cursor --install-extension` run makes a newer folder without it). Ask for each hand step with a question card
(exact action, where, what they should see) and check logs and files between steps.

## Don't
Never install the extension or launch the user's own Cursor without the user asking (probe windows for checking
assumptions are fine when the user asked for the assumptions to be tested). `scripts/live-test.js` (isolated profile
under the temp folder, nothing installed) may be run without asking.

## Facts for plans
- Cursor names an extension plugin after its folder, not `plugin.json`'s `name` (a probe whose folder and name are
  equal can't tell them apart: give them different values).
- Two extension plugins in folders of the same name (`a/same`, `b/same`) both load and are both named `same`: Cursor
  keys registrations by path (probe, Cursor 3.31.15, 2026-11-24). Never register two plugins with one folder name.
- With Cursor's runtime on Windows, `fs.rmSync` throws EPERM on git's read-only object files: use `sync.removeTree`.
- `git reset --hard @{u}` resets to the upstream as of the last fetch: a test expecting `updated` afterwards needs a
  new remote commit.

- Partial copies sync both ways: any operation that resets the managed clone (discard, push to a branch) must also
  reset the copies (`resetPartialCopies` → `markCopySynced`), or their newer edits flow back into the clone.
- On Windows the **parent** of a registered plugin folder cannot be deleted or renamed while the plugin is registered
  (EPERM, possibly left half-deleted), in any window that registered it; the registered folder itself, its files and
  subfolders can be edited and deleted, and after `removePlugin` the parent can be deleted at once (probe, Cursor
  3.31, 2026-11-22). Deleting the registered folder itself leaves it "delete pending" (still listed by `readdir`,
  `lstat` EPERM, `fs.existsSync` false) until the window unregisters it or reloads: a plan that deletes a registered
  folder unregisters it first, and checks deletion with `readdir` of the parent, not `existsSync` (live test 0.7.0,
  2026-11-25). The managed clone and the `filtered/<name>-<hash>` holders are such parents: update them in
  place; delete only unregistered ones.
- Remote-SSH: the extension runs in the remote extension host (UI-side addPlugin fails with ENOENT on the local
  path). Remote logs: `~/.cursor-server/data/logs/<session>/exthost<N>/`; the Cursor Plugins log is under
  `anysphere.cursor-agent-host` there. A remote probe window: `cursor.cmd --new-window --remote ssh-remote+<host>
  --extensionDevelopmentPath=vscode-remote://ssh-remote+<host>/<probe dir> <remote folder>` (needs the user's OK).
- Remote-SSH live test without a probe: `scp` the VSIX to the host and install it with the server's CLI
  (`~/.cursor-server/bin/linux-x64/<commit>/bin/cursor-server --install-extension <vsix> --force`), then a window
  reload. In a remote window `vscode.workspace.fs.delete(..., { useTrash: true })` fails ("provider does not support
  it"): a plan that deletes user files remotely needs another way (live test 0.8.0, Linux host, 2026-11-25).
- File watchers on a Linux remote miss subfolders that appear together with their parent (see `watchTree` in
  AGENTS.md): test watcher changes there with `mkdir -p a/b` and a write in `b`, not only a write in an existing folder.
- Run the suite on a Linux remote with the Cursor server's node (`git archive HEAD | ssh <host> 'tar -x -C <dir>'`,
  then `~/.cursor-server/bin/linux-x64/<commit>/node scripts/test.js`).

- On Windows `revealFileInOS` opens Explorer behind the Cursor window, so the user sees nothing happen: open the
  files in an editor instead (`showTextDocument`).

- Two test repositories built the same way (`makeOrigin` in `test/sync.test.js`) within one second get identical
  commit hashes (same tree, identity and time): a test that needs them to differ pushes an extra commit to one.

- A VSIX rebuilt without a version change may not replace the installed one: check
  `%USERPROFILE%\.cursor\extensions\mathieugun.cursor-team-plugins-<version>\extension.js` after installing (`--force`).

- MCP servers of a registered plugin can be observed without a probe extension: add a local repository to
  `teamPlugins.localRepositories` of the user's Cursor (with their OK; back up and restore `settings.json`), give the
  plugin stdio servers that are tiny node scripts run by `Cursor.exe` with `ELECTRON_RUN_AS_NODE=1` (answer
  `initialize` and `tools/list` with one tool named after an argument), then read
  `~/.cursor/projects/<workspace>/mcps/plugin-<plugin>-<server>/tools/` and the agent host's
  `Mcp FileSystem Writer.log` (`... left the lease` when a server goes). An edit of the registered folder's
  `mcp.json` takes effect within a few seconds for added or removed servers (a removed or unregistered server's
  process is killed a fixed 30 s after it leaves the lease: poll `Win32_Process` for `server.js` to time it); a server that keeps its name keeps its old
  config (new `args` are used only after a window reload), so test server changes by name, not by argument (probe,
  Cursor 3.31, 2026-11-25). Opening a probe window from an agent was refused by the auto-mode classifier: ask the user.

- Git calls `ssh -G` first when `core.sshCommand` is set without a variant; `-c ssh.variant=ssh` (or
  `GIT_SSH_VARIANT=ssh`) skips it (probe, Cursor 3.31, 2026-11-25).
- A node `http` server in the test process that runs `git http-backend` serves git over HTTP; a synchronous git
  (`spawnSync`, `helpers.git`) against it blocks the event loop and deadlocks: use only async git (probe, Cursor 3.31,
  2026-11-25).
- Each extension has its own `vscode` object: a test runner in the extension host can't patch the extension's
  `vscode.window` (probe, Cursor 3.31, 2026-11-25); hence the `ui` seam in `extension.js`.
- Settings written with `getConfiguration(...).update` from a runner persist in the isolated profile's
  `User/settings.json` for the next launch: write the file fresh before every launch (probe, Cursor 3.31, 2026-11-25).
- The isolated instance creates `~/.cursor/projects/<slug of the workspace path>/` in the real user home: keep one fixed
  workspace path and leave the folder (probe, Cursor 3.31, 2026-11-25).
- `extension.js` splits some calls over two lines (`vscode.window` then `.showErrorMessage(` on the next line: 11 of the
  81 dialog calls, request 10 review, 2026-11-25): count or check call sites with a multiline search
  (`vscode\.window\s*\.\s*show`), never a single-line grep.

- On the maintainer's machine git has no global `user.name`/`user.email` (only this repository's `.git/config`): a
  live **Commit and push** of a managed clone stops at "git doesn't know your name and email" (live test 0.8.0,
  2026-11-25, `git config --global user.name` exit 1). To test a commit live, set an identity in the managed clone's
  own `.git/config` first (with the user's OK), never the global one.

- Cursor's release build refuses debugger switches: `Cursor.exe ... --remote-debugging-port=0` prints
  `--remote-debugging-port is not supported in this build. Debugger switches work only in development builds.` and
  exits 1 in 0.2 s. `resources/app/out/main.js` (`electronFuses.js`) blocks `remote-debugging-port`,
  `remote-debugging-pipe` and every `--inspect*` argument unless the binary's inspect-arguments fuse is on, so no CDP
  to the workbench of an isolated instance (probe, Cursor 3.32.4, 2026-11-25, launcher in the scratchpad; request 11).

## Implementer lessons
<!-- One line per project-specific mistake seen in review. -->
