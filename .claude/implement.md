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
The install needs the user's OK (it changes the Cursor they use). The team repository is the fixture: build it with
`scripts/make-test-repo.js <scratchpad>/team-plugins.git` (plugins `review` and `docs`) and add the path it prints to
`teamPlugins.repositories` (a second one built with `--name team-two`). Test names stay generic: no company or team
names in fixtures, settings or test data.

Hand checks (the skill's checklist, step 7): template `.claude/hand-check-template.md`, file
`requests/NN-<name>.live.md` (not committed). Run `scripts/live-test.js` first; the checklist holds only what the
scenarios can't show.
- 📋 lines are checked with `live_check.py status --since install` (logs and registrations across reloads), the
  files the plan names, or git.
- Setup: install, `settings backup`, every fixture repository the tests need configured together
  (`teamPlugins.repositories` is application scope: one list for every window, a project folder can't change it; each
  fixture its own `--name`), one project folder per project setup under the scratchpad (`projectPlugins` /
  `projectRepositories` in its `.vscode/settings.json`, the resource-scope settings; a test names the folder to open
  with `Ctrl+R`), git identities in the test clones. The managed clone and partial copies are shared by every window:
  tests that change them come last.
- **Ping me** cases here: a teammate's push arriving, an edit of a registered copy or of the clone.
- The user is almost always out of Cursor usage: never ask. A test that needs Cursor's own agent goes in the optional
  group, named as "Cursor's chat panel (`Ctrl+L` in Cursor), not this Claude session".
- Cleanup: `settings diff` (only the test's changes), `settings restore`, `settings diff` (no difference), fixtures and
  project folders removed. The installed build stays.
- **Commit and push** is the view title's cloud icon or the Local changes row, not the repository row.

Tools (`python scripts/live_check.py`, from the repo root; `--host <ssh host>` for Remote-SSH):
- `status [--since install|host|10m|07:10] [--grep <regex>]`: the installed version and whether its files match the
  working tree, then per window the Team Plugins output lines and Cursor's plugin registrations since then (default:
  the current extension host; `install` reads across reloads). Check each hand step with it.
- `install [--no-package] [--dry-run]`: package, install (`cursor --install-extension --force`, or the Cursor
  server's CLI on the host), check the installed files; the user then reloads the window.
- `settings backup|diff|restore <dir>`: back up `%APPDATA%\Cursor\User\settings.json` before pointing
  `teamPlugins.repositories` at the fixture, `diff` to see only the test's own changes, `restore` at the end.
  `backup` refuses to overwrite an earlier backup (it may hold the real settings).

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

- A registered plugin folder, and a skill folder or rule file inside it, can be renamed in place with `fs.renameSync`,
  registered or not (probe scenario in the isolated Cursor, Cursor 3.32.4, 2026-11-25; request 12). Only its parent
  (clone, `filtered/` holder) is locked.
- Cursor's `marketplace.json` reader ignores unknown keys: its zod schemas in
  `resources/app/extensions/cursor-agent-host/dist/4846.js` never call `.strict()` on the marketplace objects (grep,
  Cursor 3.32.4, 2026-11-25).
- In a live scenario `t.find(id)` returns the test hook's snapshot of a tree node (`id`, `label`, `contextValue`,
  `children`), with no `kind` or `key`: a command that takes a node is called with `{ kind, key }` built by hand
  (request 12 review, 2026-11-25).

- A tree item whose click command opens a file with plain `showTextDocument` moves the focus to the editor: a view
  keybinding (`focusedView == ...`) then no longer fires, F2 goes to the editor. Open with `preserveFocus: true` (hand
  check, Cursor 3.32.4, 2026-11-26; request 12).

- `vscode.env.openExternal` given a **string** opens it exactly; a `Uri` is re-encoded with
  `encodeURI(uri.toString(true))` (decodes `%26`, `%2B`, `%23`). Read in the Cursor 3.32 bundles
  (`extensionHostProcess.js` `openUri`, `workbench.desktop.main.js` `$openUri`/`_doOpenExternal`), then checked by hand
  (installed 0.8.2, 2026-11-26): `https://example.com/pull/new?source=team-plugins%2Fa%2Bb%26c` reached the browser
  unchanged. The live scenarios record `ui.openExternal` and never open a browser.
- A hand check of a push needs a pre-receive hook in a local bare fixture (refuse `main`, print a URL on `remote:` lines);
  a hook's stderr reaches a local `git push --progress` as `remote:` lines, padded with trailing spaces (request 13,
  2026-11-26).

- Walkthroughs (Cursor 3.32.4, 2026-11-26, request 14; isolated probe runs, storage `memento/gettingStartedService`
  read from `state.vscdb` + `-wal` of a run without `--extensionTestsPath`, plus the bundle read):
  `workbench.action.openWalkthrough` needs the object form `{ category: '<ext>#<id>', step: '<ext>#<id>#<step>' }`
  (tab `Walkthrough: <displayName>`); called before Cursor has registered the walkthrough (a few seconds after
  startup, registration may wait 5 s for the experiment service) it opens the generic Welcome tab. A step's
  `onContext` key already true at registration never completes it in that session; `onCommand:` of the extension's
  own command fires only through the workbench (link, palette, `runCommands`), not `executeCommand` from the extension
  host. With `--extensionTestsPath` storage is in memory: progress can't be read in a live scenario.
- `scripts/package.js` packages `resources/` non-recursively: a new resource goes directly in `resources/`
  (request 14, read in `vsixEntries`).

- Cursor's logs: locally one `window*/exthost` per window in the newest `%APPDATA%\Cursor\logs\<session>` that has
  one (a `cursor --install-extension` run makes a newer folder without it), a new
  `output_logging_<local time>_<id>` folder per extension host (each reload), `Cursor Plugins.log` appended across
  reloads; on a Remote-SSH host each reload adds an `exthost<N>` under `~/.cursor-server/data/logs/<session>/`.
  Team Plugins lines carry a UTC `[...Z]` time, Cursor Plugins lines local time then a UTC `[...Z]`.
  `extensions.json` records `metadata.installedTimestamp` (ms) per extension (Cursor 3.32, 2026-11-26, read while
  writing `scripts/live_check.py`).
- From Python on Windows, Git for Windows' `ssh` hangs once a command prints more than a few kB (a 186 kB `tar` never
  arrived); `C:\Windows\System32\OpenSSH\ssh.exe` works and reads the same `~/.ssh/config` (`live_check.py` uses it;
  against gnosis, 2026-11-26).

- Cursor's own parsers can be run without a window: `resources/app/node_modules/gray-matter` (4.0.3, js-yaml 3.14.1,
  the same as the agent host's bundled module 70890) calibrates a frontmatter check against what Cursor loads; the
  agent host's loaders (`cursor-agent-host/dist/main.js` + chunks) run under `ELECTRON_RUN_AS_NODE=1 Cursor.exe` once
  webpack's `require` is captured (the entry module itself throws "Cannot convert object to primitive value"; ignore
  it). Request 16, Cursor 3.32.4, 2026-11-26.

- How Cursor applies a plugin rule or skill (read in `cursor-agent-host/dist/4846.js`, Cursor 3.32.4, 2026-11-27;
  YAML values run through Cursor's gray-matter): `To` picks `alwaysApply` (boolean `true` only: `"true"`, `yes` are
  strings) > non-empty `globs` (string split on commas outside `{}`, or a list) > non-empty string `description` >
  manual; skills go through `To` too (an `alwaysApply` skill becomes a whole-text rule and leaves the skill list);
  descriptions are cut to 1536 characters; the prompt itself is built on Cursor's server (not observable: wrapping,
  `disable-model-invocation`, subagent descriptions). Find it with `grep -o ".\{300\}alwaysApply.\{300\}" 4846.js`.
- In Git Bash, `cd "$UNSET_VAR"` succeeds and stays in the current folder: a probe written after `cd "$X" || cd <scratch>`
  lands in the repository. Use the scratchpad's literal path (2026-11-27).

## Implementer lessons
<!-- One line per project-specific mistake seen in review. -->
