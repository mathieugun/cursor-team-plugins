# Plan: request 10, automated live tests

## Context

- Repository: cursor-team-plugins (Cursor extension, plain CommonJS, no dependency, no build). Request:
  `requests/10-live-tests.md`. Version stays **0.8.0**: nothing changes for users, so there is no bump and no release.
- Two layers:
  1. **Remote cases without Cursor:** `test/remote.test.js`, run by `scripts/test.js` and in CI. Real git against
     local stand-ins: a fake ssh script, and a node `http` server running `git http-backend`.
  2. **Extension-host scenarios in an isolated Cursor instance:** `scripts/live-test.js`, which launches Cursor once
     per scenario with its own profile under the temp folder. `test/live/runner.js` runs inside Cursor, and the
     scenarios are `test/live/*.live.js`.
- Files and functions involved:
  - `lib/sync.js`: `syncManaged` (l. 198), `syncLocked` (l. 405), `switchInPlace` (l. 362), `checkRemote` (l. 341,
    already takes `idleMs`), `NETWORK_IDLE_MS` (l. 84, used at l. 372, 400, 420 and 501), `removeTree` (l. 8).
  - `lib/git.js`: `makeGit`. Unchanged: it spawns git with `process.env` plus `GIT_TERMINAL_PROMPT=0` and
    `GCM_INTERACTIVE=never`, and kills the process tree on a timeout.
  - `lib/remoteErrors.js`: `classify`, `remoteResult`. Unchanged.
  - `lib/contribute.js`: `commitAndPush`, `pushToBranch`. Unchanged.
  - `extension.js`:
    - `log` (l. 89), `enqueue`/`queue` (l. 283), `ACTIONS` (l. 417), `showRemoteError` (l. 448).
    - `notifyAfterSync` (l. 497), whose `ask` at l. 504 calls `vscode.window[kind]`.
    - `updateStatus`/`statusItem` (l. 1032), `itemUri` (l. 1124), `projectDecorations` (l. 1145),
      `PluginTree` (l. 1171), `onCheckboxChange` (l. 1274), `debouncedApply`/`debounceTimer` (l. 1426).
    - `copyDebounce`/`copyRetryTimer` (l. 83–84), `activate` (l. 2688; the checkbox event is at l. 2714–2720).
    - 70 call sites of `vscode.window.show*` dialogs.
  - `scripts/make-test-repo.js`: `makeTestRepo(target, { name })` returns the target path with forward slashes. Its
    marketplace name is `team-test`; plugins `review` (skills `code-review`, `security-check`, rule `style.mdc`,
    command `review-pr`, agent `reviewer`, MCP `lint`/`tickets`) and `docs` (skill `write-readme`).
  - `test/manual-remote-checks.md`: rewritten (see **Keep in step**).

## Measured facts (don't measure them again)

All were measured on 2026-11-25 on Windows, with Cursor 3.31, git 2.47.0.windows.1, and Node 24.22 in Cursor's
runtime (`ELECTRON_RUN_AS_NODE=1 Cursor.exe`).

### Layer 1

1. **Fake ssh through `core.sshCommand` works.** `-c core.sshCommand=ELECTRON_RUN_AS_NODE=1 "<node>" "<fake-ssh.js>" <mode>`
   (forward slashes in both paths) is run by git through its shell, with or without `ELECTRON_RUN_AS_NODE` in the
   environment. `GIT_SSH_COMMAND` with the same value works too. Results through `sync.checkRemote`:
   - A fake ssh that prints `Host key verification failed.` and exits 255 gives `{ kind: 'error', reason: 'hostKeyUnknown', actions: ['terminal','retry'] }`
     in about 120 ms.
   - `git@example.test: Permission denied (publickey).` gives `reason: 'sshAuth'`.
   - A silent fake ssh with `idleMs: 2000` gives `reason: 'timeout'` after 2079 ms. Its process is gone afterwards:
     `process.kill(pid, 0)` throws `ESRCH`, so the tree kill also reaches the ssh that git started.
2. **Git calls `ssh -G` first.** With `core.sshCommand` set and no variant, git first runs `<ssh> -G -o SendEnv=GIT_PROTOCOL <host>`
   to detect the ssh variant (seen in the fake ssh's argument log). `-c ssh.variant=ssh` (or `GIT_SSH_VARIANT=ssh`)
   skips that call; the only call is then `-o SendEnv=GIT_PROTOCOL git@example.test git-upload-pack 'o/r.git'`.
3. **The `git http-backend` stand-in works.** It is a node `http` server that checks basic auth and runs
   `git http-backend` as a CGI per request, with these environment variables: `GIT_PROJECT_ROOT`,
   `GIT_HTTP_EXPORT_ALL=1`, `PATH_INFO`, `QUERY_STRING`, `REQUEST_METHOD`, `CONTENT_TYPE`, `REMOTE_ADDR`, and
   `REMOTE_USER` for pushes. The CGI's headers end at the first `\r\n\r\n`, and a `Status:` header gives the HTTP status.
   It runs in the test process; the client test runs git with `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=<empty file>`,
   so Git Credential Manager (from the system config) is never used. Results:

   | Case | Raw stderr | Classified |
   |---|---|---|
   | No credential helper | `fatal: could not read Username for 'http://127.0.0.1:<port>': terminal prompts disabled` | `credentials` |
   | Helper `!f() { echo username=u; echo password=bad; }; f` | `fatal: Authentication failed for 'http://127.0.0.1:<port>/team.git/'` | `authFailed` |
   | Right credentials | ls-remote succeeds | `checkRemote` → `reachable`, `defaultBranch: 'main'` |
   | `/missing.git` | `fatal: repository 'http://127.0.0.1:<port>/missing.git/' not found` | `notFound` |
   | `branch: 'nope'` | — | `checkRemote` → `branchNotFound` |
   | `http://127.0.0.1:1/team.git` | `Failed to connect to 127.0.0.1 port 1 after 2049 ms: Could not connect to server` | `kind: 'offline'`, `reason: 'unreachable'`; ls-remote plus `checkRemote` took 4.2 s |
   | `syncManaged` over HTTP | — | `{ kind: 'cloned' }`; `git push origin HEAD:main` from the clone succeeds |
   | Server without `REMOTE_USER` on a push | `fatal: unable to access '...': The requested URL returned error: 403` (exit 128) | `denied` |
   | `pre-receive` hook printing `error: main is protected` and exiting 1 | `remote: error: main is protected` … `! [remote rejected] HEAD -> main (pre-receive hook declined)` | `pushRejected` |
4. **Never block the event loop while the server runs.** The HTTP server lives in the test process. A synchronous git
   (`spawnSync`, `helpers.git`) against its URL blocks the event loop, so the server never answers: a deadlock. Against
   the server, use only async git (`makeGit`). `helpers.git` is fine for local paths, such as preparing the bare
   repository on disk.
5. **`fs.rmSync` fails on git's read-only files** with EPERM, with Cursor's runtime on Windows (a project fact). Use
   `sync.removeTree` / `helpers.rmDir`.

### Layer 2

6. **The isolated instance.** The command is:

   ```
   Cursor.exe --user-data-dir=<root>/ud --extensions-dir=<root>/ext --extensionDevelopmentPath=<repo>
              --extensionTestsPath=<runner.js> --disable-workspace-trust --skip-welcome --skip-release-notes
              --new-window <root>/ws
   ```

   It runs the runner's exported `run()` in the extension host. The window closes when `run()` settles, and the
   process exits with code 0 even when `run()` rejects, so the result must come from a file. Signed out, Cursor shows
   its sign-in screen, which blocks nothing. `<root>` must be short (`%TEMP%\tp1` works; under the scratchpad git
   hits MAX_PATH).
7. **Test mode.** An extension loaded through `--extensionDevelopmentPath` in that run has
   `context.extensionMode === vscode.ExtensionMode.Test` (3).
8. **The launcher's environment reaches the extension host.** A variable set when Cursor.exe was spawned was read by
   the extension as `process.env.X`.
9. **Each extension has its own `vscode` object.** In the runner, `require('vscode')` is not the extension's object,
   and its `window` namespace is not the extension's either. Assigning `vscode.window.showInformationMessage` in the
   runner does not reach the extension (`Object.isFrozen(vscode.window)` is false, but the object is a different one).
   A real notification then waited for a click and the run hung until it was killed. Hence the `ui` seam inside
   `extension.js`.
10. **The runner gets the exports.** `vscode.extensions.getExtension('mathieugun.cursor-team-plugins').activate()`
    resolves to what `activate` returns, which is `undefined` today.
11. **Cursor's plugin log can be read during the run.** It is at
    `<session>/window1/exthost/anysphere.cursor-agent-exec/Cursor Plugins.log`, where `<session>` is
    `path.resolve(context.logUri.fsPath, '..', '..', '..')`. Example `logUri`:
    `<root>\ud\logs\20261125T225657\window1\exthost\<extension id>`. Lines look like
    `... [info] Registered extension plugin: review from <path> (extension: mathieugun.cursor-team-plugins)` and
    `Plugins reload completed: 2 plugins loaded (2 extension, 0 retained), 0 failures`.
    - Cursor names the plugin after its **folder** (`review`), not the catalog's `team-test:review`.
    - Older session folders of the same profile also exist, so always search only the current `<session>`.
12. **MCP servers have workbench logs.** For each MCP server of a registered plugin there is
    `<session>/window1/mcp-server-plugin-<plugin display name, URL-encoded>-<server>.workbench.log`, for example
    `mcp-server-plugin-Review%20(test)-lint.workbench.log`.
13. **Settings writes persist.** `vscode.workspace.getConfiguration('teamPlugins').update(...)` from the runner
    triggers the extension's configuration handler (`docs` was registered 509 ms after enabling it). The value is
    also written to `<root>/ud/User/settings.json` and stays there for the next launch, so write that file fresh
    before every launch.
14. **Timings and the kill.** From launch to exit: about 10 s for one clone and two plugins. A run killed by a
    timeout (the main Cursor process killed) left no Cursor process with that `--user-data-dir`.
15. **One folder in the real home.** The isolated instance creates `~/.cursor/projects/<slug of the workspace path>/`
    in the real user home (canvases, mcps). It is harmless, like the many temp-workspace folders already there. A
    fixed workspace path keeps it to one folder; don't delete it.
16. **Ids.**
    - Merged catalog plugin names are `team-test:review` and `team-test:docs`; registrations
      (`registrar.current`) are keyed by those names.
    - Tree node ids are `plugin:team-test:review` and `item:team-test:review/skills/security-check`
      (also `.../skills/code-review`, `.../rules/style.mdc`, `.../commands/review-pr.md`, `.../agents/reviewer.md`,
      `.../mcp/lint`, `.../mcp/tickets`), plus `repo:<key>`, `changes:<key>` and `change:<key>|<path>`.
    - A fully selected plugin is registered from the clone (`<storage>/.cursor/plugins/repos/<base>-<hash>/review`).
      A partial one is registered from `<storage>/.cursor/plugins/filtered/<name>-<hash>/review`.
17. **How the extension reports.**
    - **When an error is shown:** a sync error is shown when `userInitiated || !s.errorShown` (l. 570). `offline` is
      shown when `userInitiated || (!hadClone && !s.errorShown)` (l. 561).
    - **Repository check:** after a settings change the check result is shown only when `vscode.window.state.focused`
      (l. 383). Scenarios must therefore use **Sync now** (`teamPlugins.syncNow`, user-initiated) to get a message
      reliably.
    - **Error message format:** `Team plugins (<label>): <message>`, with buttons from `ACTIONS` (`Open terminal`,
      `Sync now`, `Show log`, `Open settings`, `Push to a branch`, `Try again`); `Show log` is always added last.
    - **Status bar while syncing:** `$(sync~spin) Team plugins`.
    - **After a push:** `Pushed <7 hex> to <branch>: the team gets it at their next sync.`
    - **After a clone:** `Team plugins: <name> cloned. Pick your plugins in the Team Plugins view.` with `Open view`.
    - `askCommitMessage` is an input box whose prompt starts with `Commit message for your changes to`.
    - `teamPlugins.commitAndPush` takes `{ repo: <key> }` (as `ACTIONS.retryPush` does); with one repository
      `pickRepo` asks nothing.

## Design

### A. `lib/sync.js`: `idleMs` option for `syncManaged`

- `syncManaged({ ..., idleMs = NETWORK_IDLE_MS })` passes `idleMs` to `syncLocked`, which uses it in place of
  `NETWORK_IDLE_MS` for the clone (l. 420) and the fetch (l. 501), and passes it to `switchInPlace`, which uses it at
  l. 372 and l. 400. The `checkRemote` call in `syncLocked` (l. 462) also gets `idleMs`.
- Callers that don't pass it behave exactly as today.
- Update the comment above `NETWORK_IDLE_MS` to say it is the default.

### B. Layer 1: `test/remote-helpers.js`, `test/fake-ssh.js`, `test/remote.test.js`

**`test/fake-ssh.js`** is a standalone node script. `argv[2]` is the mode; the rest are ssh's arguments.

- If the environment variable `FAKE_SSH_PID_FILE` is set, write `String(process.pid)` to that file first.
- `unknown`: write `Host key verification failed.\n` to stderr, exit 255.
- `changed`: write the changed-key banner and exit 255. It is the `CHANGED_KEY` text of `test/remoteErrors.test.js`
  (the `@@@` lines, `WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!`,
  `Host key for example.test has changed and you have requested strict checking.`,
  `Host key verification failed.`), one line each.
- `auth`: write `git@example.test: Permission denied (publickey).\n` to stderr, exit 255.
- `silent`: write nothing and never exit (`setInterval(() => {}, 1 << 30)`).
- Any other mode: write `fake-ssh: unknown mode <mode>\n`, exit 2.

**`test/remote-helpers.js`** (not a `*.test.js`, so the runner doesn't run it):

- `fakeSshCommand(mode)` returns `ELECTRON_RUN_AS_NODE=1 "<execPath>" "<fake-ssh.js>" <mode>`, where `<execPath>` is
  `process.execPath` and both paths use forward slashes (`p.split(path.sep).join('/')`).
- `isolateGit(dir)`:
  - Sets `process.env.GIT_CONFIG_NOSYSTEM = '1'`.
  - Sets `process.env.GIT_CONFIG_GLOBAL` to `<dir>/gitconfig`, a file holding
    `[user]\n\tname = test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n`.
  - Sets `process.env.HOME` and `process.env.USERPROFILE` to `dir`, so a real ssh, if one ever runs, would never read
    the user's `known_hosts`.
  - Call it once at the top of `remote.test.js`; each test file runs in its own process under `node --test`.
- `withConfig(run, pairs)` wraps a `makeGit` runner: `(args, ...rest) => run([...pairs.flatMap((p) => ['-c', p]), ...args], ...rest)`.
- `startGitServer({ root, user = 'u', pass = 'p', readOnly = false })` returns a promise of `{ url(name), close() }`:
  - It listens on `127.0.0.1` port 0. `url('team.git')` is `http://127.0.0.1:<port>/team.git`.
  - Wrong or missing `Authorization: Basic` → answer `401` with `WWW-Authenticate: Basic realm="test"`.
  - Otherwise spawn `git http-backend` (`windowsHide: true`) with `{ ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: decodeURIComponent(pathname), QUERY_STRING, REQUEST_METHOD, CONTENT_TYPE, REMOTE_ADDR: '127.0.0.1' }`,
    plus `REMOTE_USER: user` unless `readOnly`.
  - Also pass `HTTP_CONTENT_ENCODING` and `GIT_PROTOCOL` when the request has `content-encoding` or `git-protocol`.
  - Pipe the request into the CGI's stdin. Buffer stdout until `\r\n\r\n`, parse the header lines (`Status: 403 ...`
    gives the status, default 200), then stream the rest. End the response when stdout ends.
  - Ignore the CGI's stderr (it prints for example `Service not enabled: 'receive-pack'`).
  - `close()` closes the server and resolves when it is closed.
- `credentialHelper(user, pass)` returns `credential.helper=!f() { echo username=<user>; echo password=<pass>; }; f`.
- `waitGone(pid, ms = 5000)` polls `process.kill(pid, 0)` every 100 ms until it throws `ESRCH`. It resolves `true`, or
  `false` after `ms`.
- `makeServedRepo(root, name = 'team.git')` creates a bare repository `<root>/<name>` with branch `main` and one commit
  (`a.txt`), using `helpers.git`/`commitAll` on local paths only, and returns its path.

**`test/remote.test.js`**: each test gets its own temp dir (`tmpDir`, removed with `rmDir` in `t.after`). Every git
runs through `makeGit('git')`, wrapped with `withConfig`; there is no `spawnSync` against the server. Skip the whole
file when `gitAvailable()` is false (as the other git tests do). The cases are listed under **Tests**.

### C. `extension.js`: the `ui` seam and the test hook

**`ui` seam**

- Add, near the top (after the constants):

  ```js
  // Every dialog goes through `ui`: in Test mode (scripts/live-test.js) it is replaced by a recorder that never
  // blocks; otherwise it is vscode.window's own.
  const realUi = {
    showInformationMessage: (...a) => vscode.window.showInformationMessage(...a),
    showWarningMessage: (...a) => vscode.window.showWarningMessage(...a),
    showErrorMessage: (...a) => vscode.window.showErrorMessage(...a),
    showQuickPick: (...a) => vscode.window.showQuickPick(...a),
    showInputBox: (...a) => vscode.window.showInputBox(...a),
    showOpenDialog: (...a) => vscode.window.showOpenDialog(...a),
    showWorkspaceFolderPick: (...a) => vscode.window.showWorkspaceFolderPick(...a),
  };
  let ui = realUi;
  ```

- Replace every `vscode.window.show(InformationMessage|WarningMessage|ErrorMessage|QuickPick|InputBox|OpenDialog|WorkspaceFolderPick)(`
  with `ui.show…(`. There are 70 of them; a mechanical replace is fine. Also change l. 504 `vscode.window[kind](` to `ui[kind](`.
- `showTextDocument`, `withProgress`, `createTerminal`, `createOutputChannel`, `createStatusBarItem` and
  `createTreeView` stay on `vscode.window`.
- Check: afterwards, `grep -nE "vscode\.window\.(show(Information|Warning|Error)Message|showQuickPick|showInputBox|showOpenDialog|showWorkspaceFolderPick)|vscode\.window\[" extension.js`
  must print only the 7 lines of `realUi`.

**Test recorder** (installed only in Test mode, at the very start of `activate`, before anything can show a dialog):

- `calls` is an array of recorded calls, capped at 1000. `responder` is a function, by default `() => undefined`.
- `testUi[name] = async (...args) => { ... }` for each of the 7 names:
  - **Messages** (`show*Message`): `message = args[0]`. `options` is `args[1]` when it is a non-null object without a
    `title` property (`{ modal, detail }`). `buttons` are the remaining args, mapped to strings
    (`typeof b === 'string' ? b : b.title`). Record
    `{ kind: name, message, modal: !!(options && options.modal), detail: options && options.detail, buttons }`.
  - **`showQuickPick(items, options)`:** `await items` (it may be a Thenable). Record
    `{ kind, placeHolder: options && options.placeHolder, items: items.map(i => typeof i === 'string' ? i : i.label) }`
    and keep the real items on a non-enumerable field (or pass them to the responder only).
  - **`showInputBox(options)`:** record `{ kind, prompt, placeHolder, value }` from options.
  - **`showOpenDialog(options)` / `showWorkspaceFolderPick(options)`:** record `{ kind, title, openLabel }`.
  - Call `answer = await responder(record, args)`. For the quick pick, the responder gets the resolved items as
    `args[0]` and returns one of them (or a label string, mapped back to the item with that label). For messages, map
    a returned title back to the button object when the buttons were objects.
  - Set `record.answer` to a printable form of the answer (string, label, or `null`), push the record, and return the
    answer.
  - A responder that throws: record `answer: null` with `error: err.message`, and return `undefined`.

**`idle({ timeoutMs = 30000 } = {})`:** the hook's settle loop.

- Loop: remember `q = queue` and `c = checkboxChain`, `await Promise.all([q, c])`, then compute
  `busy = knownSources === null || debounceTimer || copyDebounce || copyRetryTimer || [...repoStates.values()].some((s) => s.syncing) || q !== queue || c !== checkboxChain`.
- When not busy for 300 ms in a row (measured across iterations; any busy pass resets it), resolve.
- Otherwise sleep 50 ms and go on. After `timeoutMs`, throw `Error('extension not idle after <s> s')`.
- `offlineTimer`, the update `timer` and `keepAliveTimer` are ignored.

**Checkbox path:** factor the body of the `onDidChangeCheckboxState` listener (l. 2714–2720) into
`queueCheckboxChange(e)`, which chains on `checkboxChain` and returns the chained promise. The listener calls it, and
so does the hook.

**`log`:** in Test mode, also push the line (without the timestamp) into `testLog`, capped at 5000 lines (drop the
oldest).

**Test hook:** at the end of `activate`, `if (testMode) return testHook(context);`. `testMode` is
`context.extensionMode === vscode.ExtensionMode.Test`, computed first thing in `activate`; the recorder is installed
right then.

- `testHook` returns a plain object with only these members:
  - `calls()`: a copy of the recorded calls. `clearCalls()` empties them.
  - `respond(fn)`: sets the responder (`fn` or the default when `fn` is falsy).
  - `idle(opts)`: see above.
  - `tree()`: walks `treeProvider.getChildren()` recursively (node `children`) and converts each node with
    `treeProvider.getTreeItem(node)` into
    `{ id, label, description, icon, checked, contextValue, children: [...] }`.
    - `icon` is `item.iconPath && item.iconPath.id`, or `null`.
    - `checked` is `true` / `false` from `item.checkboxState`, which is either a number or `{ state }`
      (`TreeItemCheckboxState.Checked` → `true`), or `null` without a checkbox.
    - `label` is `item.label` as a string.
  - `check(id, checked)`: finds the node with that `id` in the same walk (throws `no tree node <id>` when missing) and
    returns
    `queueCheckboxChange({ items: [[node, checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked]] })`.
  - `registrations()`: `Object.fromEntries(registrar ? registrar.current : [])`.
  - `decoration(key)`: `projectDecorations.provideFileDecoration(itemUri(key))` as
    `{ badge, tooltip, color: color && color.id }`, or `null`.
  - `states()`: `[...repoStates].map(([key, s]) => ({ key, syncing: s.syncing, result: s.lastResult && { kind: s.lastResult.kind, reason: s.lastResult.reason || null, message: s.lastResult.message || '' }, changes: s.changes }))`.
  - `status()`: `{ text: statusItem.text, tooltip: String(statusItem.tooltip || '') }`.
  - `logLines()`: a copy of `testLog`.
  - `storage`: the global storage path. `logUri`: `context.logUri.fsPath`.
- Nothing else is exported. Outside Test mode `activate` returns `undefined`, as today.

### D. Layer 2: `scripts/live-test.js`

Usage: `node scripts/live-test.js [scenario ...] [--timeout <seconds>]`, or the same with Cursor's runtime. With no
scenario names it runs every `test/live/*.live.js`, sorted; a name is a file name without `.live.js`.

**Cursor executable:** `process.env.CURSOR_EXE` if set. Otherwise `process.execPath` when its base name is
`Cursor.exe` / `cursor` (case-insensitive), which is the case when run with Cursor's runtime. Otherwise, on win32,
`%LOCALAPPDATA%\Programs\cursor\Cursor.exe` if it exists. Otherwise exit 2 with
`live-test: Cursor not found: set CURSOR_EXE to the Cursor executable`.

**Root:** `path.join(os.tmpdir(), 'tp-live')`. It must stay short (fact 6); refuse to run when it doesn't resolve
inside `os.tmpdir()`. Layout:

```
<root>/ud, <root>/ext          profile, wiped before each scenario
<root>/repos                   test repositories, wiped before each scenario
<root>/ws                      the workspace folder: same path every time (fact 15), emptied before each scenario
<root>/gitconfig               test identity (user test / test@example.com, commit.gpgsign false), rewritten each run
<root>/out/<scenario>/         result.json, cursor.log, data.json; logs/ copied on failure. Whole out/ wiped at start
```

**Each scenario file** `test/live/<name>.live.js` exports `{ timeoutSec?, setup(ctx), run(t) }`:

- `setup` runs in the outer process (no `vscode`). `ctx` holds `root`, `repos` (the repos dir), `ws`, `repoRoot` (this
  repository), `makeTestRepo` (from `scripts/make-test-repo.js`), `fakeSshCommand` (from `test/remote-helpers.js`)
  and `url(p)` (forward slashes).
- `setup` returns `{ settings, workspaceSettings?, env?, data? }`.
- `run` runs inside Cursor (see E). The file must not `require('vscode')` at top level: `run` receives it as `t.vscode`.

**Per scenario, in order:**

1. Wipe and recreate `ud/User`, `ext`, `repos` and `ws` (with `sync.removeTree`). Create `out/<name>`.
2. `const s = await setup(ctx)`.
3. Write `ud/User/settings.json` as `JSON.stringify({ ...s.settings }, null, 2)`. If `s.workspaceSettings` is set,
   write `ws/.vscode/settings.json`. Write `out/<name>/data.json` as `JSON.stringify(s.data || {})`.
4. Spawn Cursor with the arguments of fact 6: `--extensionDevelopmentPath=<repoRoot>`,
   `--extensionTestsPath=<repoRoot>/test/live/runner.js`, the workspace `<root>/ws` last, and every path as a native
   path.
   - `env = { ...process.env, ...s.env, GIT_CONFIG_GLOBAL: <root>/gitconfig, TEAM_PLUGINS_LIVE_SCENARIO: <abs .live.js>, TEAM_PLUGINS_LIVE_RESULT: <out>/result.json, TEAM_PLUGINS_LIVE_DATA: <out>/data.json }`,
     then **delete `env.ELECTRON_RUN_AS_NODE`** (otherwise Cursor.exe starts as node).
   - stdout and stderr go to `out/<name>/cursor.log`. Use `detached: process.platform !== 'win32'`.
5. Wait for exit, or for `(scenario.timeoutSec || --timeout || 90)` seconds. On timeout, kill the tree (`taskkill /pid
   <pid> /T /F` on win32, `process.kill(-pid, 'SIGKILL')` elsewhere) and wait for the exit.
6. Read `result.json`:
   - If it is missing: fail with `no result (Cursor exited with code <c>; see <out>/cursor.log)`, or
     `timed out after <s> s` when killed.
   - If `ok` is false or killed: fail with the result's `error` (first line), the last step
     (`last step: <steps[steps.length-1]>`), and `timed out after <s> s` when killed.
7. On failure, copy the newest `ud/logs/<session>` folder to `out/<name>/logs` (`fs.cpSync`, recursive).
8. Print one line: `PASS <name> (<s> s)` or `FAIL <name> (<s> s): <reason>`, followed by `  details: <out>/<name>`
   on failure.

At the end print `<passed>/<total> scenarios passed`, and exit 1 if any scenario failed, otherwise 0. The script never
touches the user's Cursor profile and never installs anything.

### E. `test/live/runner.js` (loaded by Cursor through `--extensionTestsPath`)

`exports.run = async () => { ... }` **always resolves** (fact 6: the result comes from the file):

- `result = { ok: false, error: null, steps: [], calls: [], log: [] }` and `save()` writes it to
  `process.env.TEAM_PLUGINS_LIVE_RESULT`. Save after each step so a killed run still shows its last step.
- `hook = await vscode.extensions.getExtension('mathieugun.cursor-team-plugins').activate()`. When it is falsy, set
  `error = 'no test hook: the extension did not start in Test mode'`.
- `scenario = require(process.env.TEAM_PLUGINS_LIVE_SCENARIO)`, and `data` is the parsed
  `TEAM_PLUGINS_LIVE_DATA`.
- Run `await scenario.run(t)` under an overall limit of `(scenario.timeoutSec || 90) * 1000 - 10000` ms (a
  `Promise.race` with a timer that rejects `scenario still running after <s> s`). Then set `ok: true`.
- Catch: set `error` to `err.stack || String(err)`.
- Finally: `calls = hook.calls()` and `log = hook.logLines().slice(-300)` when the hook exists; then `save()`.

**`t` (the scenario's context):**

- `t.vscode`, `t.assert` (`require('node:assert/strict')`), `t.hook`, `t.data`.
- `t.step(text)`: pushes `text` to `result.steps` and saves.
- `t.waitFor(fn, what, timeoutMs = 20000)`: calls `await fn()` every 200 ms until the value is truthy, and returns it.
  After `timeoutMs` it throws `Error('timed out waiting for ' + what)`. Errors thrown by `fn` are kept and retried; the
  last one is appended to the timeout message.
- `t.idle()`: `hook.idle()`.
- `t.find(id)`: the node with that id in `hook.tree()`, or `undefined`.
- `t.sessionDir()`: `path.resolve(hook.logUri, '..', '..', '..')`.
- `t.pluginsLog()`: the concatenated text of every file named `Cursor Plugins.log` under `t.sessionDir()`, or `''`.
- `t.mcpLogs()`: the names of the files of `t.sessionDir()/window1` that start with `mcp-server-plugin-`.
- `t.git(args, cwd)`: async `execFile('git', args, { cwd, windowsHide: true })`, resolving
  `{ code, stdout: stdout.trim(), stderr }`.
- `t.messages(kind)`: `hook.calls().filter((c) => !kind || c.kind === kind)`.
- `t.noSpinner()`: asserts that `hook.status().text` does not contain `~spin`.

### F. The four first scenarios (`test/live/*.live.js`)

Shared setup for `startup`, `selection` and `contribute`:

- `const url = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'))`.
- `settings`: `{ 'teamPlugins.repositories': [url], 'teamPlugins.enabled': ['team-test:review'] }`.
- `data`: `{ bare: url }`.

**`startup.live.js`**

1. `t.waitFor(() => hook.registrations()['team-test:review'], 'review registered', 60000)`. Then `await t.idle()`.
2. The path ends with `${path.sep}review` and contains `${path.sep}repos${path.sep}`. `docs` is not registered.
3. The tree:
   - `t.find('plugin:team-test:review').checked === true` and `t.find('plugin:team-test:docs').checked === false`.
   - The root has exactly one node whose id starts with `repo:`, and its label is `team-test`.
4. `t.waitFor(() => /Registered extension plugin: review from .*[\\/]repos[\\/]/.test(t.pluginsLog()), 'Cursor registered review')`.
5. `t.waitFor(() => ['-lint.workbench.log', '-tickets.workbench.log'].every((s) => t.mcpLogs().some((n) => n.endsWith(s))), 'MCP servers lint and tickets')`.
6. Messages:
   - Some `showInformationMessage` call matches `/^Team plugins: team-test cloned\./` and has buttons `['Open view']`.
   - There is no `showErrorMessage` call.
7. `t.noSpinner()`.

**`selection.live.js`**

1. Wait for `review` to be registered, then `idle`.
2. `await hook.check('plugin:team-test:docs', true)`. Wait for `registrations()['team-test:docs']` and for
   `/Registered extension plugin: docs from /` in the plugin log.
3. `await hook.check('item:team-test:review/skills/security-check', false)`, then wait until
   `registrations()['team-test:review']` contains `${path.sep}filtered${path.sep}`. Call that path `copy`.
4. In the copy, `skills/code-review/SKILL.md` exists and `skills/security-check` does not.
5. `t.find('plugin:team-test:review')` has `checked === false` and `icon === 'pie-chart'`.
6. `vscode.workspace.getConfiguration('teamPlugins').get('excluded')` includes
   `'team-test:review/skills/security-check'`.
7. Wait for the plugin log to contain `Registered extension plugin: review from ` followed by the copy path.
   Compare without case on win32: both lowercased.

**`contribute.live.js`**

1. Wait for `review` to be registered, then `idle`. `clone = path.dirname(registrations()['team-test:review'])`, and
   `key` is the `key` of the single entry of `hook.states()`.
2. Append `\nEdited by the live test.\n` to `<clone>/review/skills/code-review/SKILL.md`.
3. `t.waitFor(() => t.find('changes:' + key), 'Local changes node')`. Its children include a node whose label
   contains `SKILL.md`.
4. `hook.respond((c) => (c.kind === 'showInputBox' && /^Commit message for your changes to/.test(c.prompt) ? 'Live test commit' : undefined))`.
5. `await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: key })`.
6. Wait for a `showInformationMessage` call matching `/^Pushed [0-9a-f]{7} to main: /`.
7. `(await t.git(['--git-dir', t.data.bare, 'log', '-1', '--format=%s', 'main'])).stdout === 'Live test commit'`.
8. Wait until `t.find('changes:' + key)` is undefined, then `t.noSpinner()`.

**`remote-errors.live.js`** (timeoutSec 120)

- Setup:
  - `settings`: `{ 'teamPlugins.repositories': [ctx.url(path.join(ctx.repos, 'missing.git'))] }`. That path doesn't
    exist.
  - `env`: `{ GIT_SSH_COMMAND: ctx.fakeSshCommand('unknown'), GIT_SSH_VARIANT: 'ssh' }`.
  - `data`: `{}`.
- Run (`err(re)` is the list of `showErrorMessage` calls whose message matches `re`):
  1. Wait for `err(/^Team plugins \(missing\): repository .*missing\.git not found/)` to be non-empty, with 60000 ms.
     Its buttons deep-equal `['Open settings', 'Show log']`.
  2. `await idle()`, then set `teamPlugins.repositories` to `['http://127.0.0.1:1/team.git']` (Global). `await idle()`.
     Run `teamPlugins.syncNow`.
     - Wait for `err(/^Team plugins \(team\): cannot reach 127\.0\.0\.1/)`, with 30000 ms. Its buttons deep-equal
       `['Sync now', 'Show log']`.
     - `await idle()`. `hook.status().text` starts with `$(debug-disconnect)` and `t.noSpinner()` holds.
  3. `hook.respond((c) => (c.kind === 'showErrorMessage' && /host key of example\.test/.test(c.message) && !answered ? ((answered = true), 'Sync now') : undefined))`.
     Set `teamPlugins.repositories` to `['git@example.test:team/plugins.git']`, `await idle()`, then run
     `teamPlugins.syncNow`.
     - Wait for `err(/SSH does not know the host key of example\.test/).length >= 2`, with 30000 ms. The second one
       comes from the scripted **Sync now**.
     - Their buttons deep-equal `['Open terminal', 'Sync now', 'Show log']`.
  4. `await idle()`. `hook.registrations()` is `{}`, and `t.noSpinner()` holds.

  The label of a repository that is not cloned is the last part of its URL without `.git`: `missing`, `team`,
  `plugins`. If the implementer finds another label in the run, it reports it instead of loosening the regex beyond
  the label.

## Impact

- **`syncManaged` callers** (`extension.js` `syncRepo`, `test/sync.test.js`): don't pass `idleMs`, so they keep the
  default. No change.
- **The 70 dialog call sites and `notifyAfterSync`'s `ask`:** `ui` has the same signatures and returns the same
  Thenables, so the chained `.then(...)` calls keep working. No behaviour change outside Test mode.
- **`activate`'s early return for the old extension (`warnOldExtension`):** it still returns `undefined`; the hook is
  only returned at the end. In Test mode the recorder is installed before that early return, which is harmless.
- **`onDidChangeCheckboxState` listener:** behaviour unchanged; it now calls `queueCheckboxChange`.
- **`log`:** unchanged outside Test mode.
- **`scripts/test.js`:** picks up `remote.test.js` automatically, and doesn't run `remote-helpers.js`, `fake-ssh.js`
  or `test/live/*` (none ends in `.test.js`). No change.
- **`scripts/package.js`:** packages only `package.json`, `extension.js`, `README.md`, `LICENSE.txt`, `lib/` and
  `resources/`, so the new files are not in the VSIX. No change. `test/package.test.js` is unaffected.
- **CI (`.github/workflows/release.yml`, ubuntu, node 22):** runs `remote.test.js`. It needs `git http-backend`
  (part of Ubuntu's git package) and `sh`. No workflow change. Linux was not measured: see **Not handled**.

## Not handled

Layer 3 (real clicks through `--remote-debugging-port`) is request 11, written separately; don't touch it. These go
to `requests/ideas.md` under **Smaller follow-ups**, one bullet each (see **Keep in step**):

- Isolated runs in a Remote-SSH window (not probed).
- Hiding Cursor's sign-in screen during runs.
- Running `live-test.js` on Linux or macOS (not checked: the Cursor path and the kill are written for both, but
  never run).

What stays manual, in `test/manual-remote-checks.md`:

- Real ssh binaries: Git's bundled ssh failing fast on an unknown host key and on a passphrase; Windows OpenSSH
  waiting silently for 120 s, with no `ssh.exe` left behind.
- Git Credential Manager: "Cannot prompt because user interactivity has been disabled", and no window opening.
- A protected branch on a real server (its own wording).
- The look: icons, colours, the selected-row colour quirk.

## Tests

### `test/remote.test.js` (new)

Every case runs through the real lib functions with `run = withConfig(makeGit('git'), [...])`. SSH cases add
`'ssh.variant=ssh'` and `'core.sshCommand=' + fakeSshCommand(mode)`. HTTP cases start one server per test with
`makeServedRepo` and close it in `t.after`.

1. **SSH unknown host key:** `checkRemote({ run, cwd: dir, repoUrl: 'git@example.test:team/plugins.git' })` →
   `kind 'error'`, `reason 'hostKeyUnknown'`, `actions ['terminal','retry']`, and `message` contains `example.test`.
2. **SSH changed host key:** `checkRemote` → `reason 'hostKeyChanged'`, `actions ['showLog']`.
3. **SSH login refused:** `checkRemote` → `reason 'sshAuth'`, `actions ['terminal','retry']`.
4. **SSH silent:**
   - Set `process.env.FAKE_SSH_PID_FILE` to `<dir>/pid` (restore it in `t.after`).
   - `checkRemote({ ..., idleMs: 1500 })` → `reason 'timeout'`, and `message` contains `for 2 s` (1500 ms rounds to
     2 s).
   - The pid file exists, and `await waitGone(pid)` is `true`.
5. **SSH silent during the first clone:**
   - `syncManaged({ run, managedRepo: <dir>/repos/m, repoUrl: 'git@example.test:team/plugins.git', branch: 'main', lockFile: <dir>/l.lock, stateFile: <dir>/s.json, idleMs: 1500 })`
     → `reason 'timeout'`.
   - `fs.readdirSync(<dir>/repos)` has no entry starting with `m.tmp-`, `<dir>/repos/m` doesn't exist, and
     `<dir>/l.lock` doesn't exist.
   - The pid is gone (`waitGone`).
   - Use `branch: 'main'` so `syncLocked` goes straight to the clone.
6. **HTTP without credentials:** no helper. `checkRemote(url('team.git'))` → `reason 'credentials'`,
   `actions ['terminal','retry']`.
7. **HTTP refused credentials:** `credentialHelper('u', 'wrong')` → `reason 'authFailed'`.
8. **HTTP wrong URL:** right credentials, `url('missing.git')` → `reason 'notFound'`,
   `actions ['repositories','showLog']`.
9. **HTTP wrong branch:**
   - `checkRemote({ ..., branch: 'nope' })` → `reason 'branchNotFound'`.
   - `syncManaged({ ..., branch: 'nope' })` → `reason 'branchNotFound'`, and no clone is left (`<managedRepo>` doesn't
     exist).
10. **Offline:** `checkRemote({ repoUrl: 'http://127.0.0.1:1/team.git' })` → `kind 'offline'`,
    `reason 'unreachable'`, `actions ['retry']`.
11. **HTTP valid repository:**
    - `checkRemote` → `{ kind: 'reachable', defaultBranch: 'main', empty: false }`.
    - `syncManaged` with `branch: ''` → `kind 'cloned'`.
    - Then push a new commit to the served bare repository through a second working clone made over HTTP (async git
      only: `run(['clone', url, work])`, commit with `run([...IDENTITY..., 'commit', ...])`, `run(['push', 'origin', 'HEAD:main'])`).
    - A second `syncManaged` → `kind 'updated'`, `commits 1`.
12. **HTTP push refused by a hook:**
    - Install a `pre-receive` hook in the served repository that prints `error: main is protected` to stderr and
      exits 1 (as `contribute.test.js` writes its hook, with `chmod 0o755`).
    - Clone with `syncManaged` and change a file in the clone. `commitAndPush({ run, repo, message: 'x', lockFile, stateFile, repoUrl })`
      → `kind 'error'`, `reason 'pushRejected'`, and `message` contains `main is protected`.
    - Then `pushToBranch({ ..., branch: 'live/x' })` → `kind 'pushedBranch'`.
    - Check the field names and result kinds against `test/contribute.test.js` l. 132–165 and follow them.
13. **HTTP push denied (read-only server):** `startGitServer({ readOnly: true })`, clone, change a file,
    `commitAndPush` → `reason 'denied'`, and `actions` deep-equal `['pushToBranch','showLog']`.

Expected time: about 15 s on Windows (offline about 4 s, timeouts about 2 s each). Existing tests and fixtures are not
changed.

### Layer 2

The four scenarios of F. They are run by `scripts/live-test.js`, not by `scripts/test.js`.

## Keep in step

- **`AGENTS.md`:**
  - **Layout:** under `scripts/`, add `live-test.js` (isolated-Cursor scenario runner, one launch per scenario, root
    `%TEMP%\tp-live`). Under `test/`, add `remote.test.js` with `remote-helpers.js` and `fake-ssh.js` (remote cases
    against a fake ssh and a `git http-backend` server, git isolated from the user's config), and
    `live/` (`runner.js`, the scenarios `*.live.js`, which need Cursor's extension host and are not run by
    `scripts/test.js`). Replace the sentence about `manual-remote-checks.md` with its new, shorter role.
  - **Commands:** add `node scripts/live-test.js [scenario ...]` and the Cursor-runtime form
    `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js`.
  - **"Why the code is shaped this way":** add these bullets:
    - Every dialog goes through `ui`. A test runner gets its own `vscode` object, so it can't patch the extension's
      `vscode.window` (probe, Cursor 3.31). In Test mode (`context.extensionMode`, only under
      `--extensionTestsPath`) `ui` is a recorder that never blocks, and `activate` returns the test hook. Outside
      Test mode it returns nothing.
    - The isolated instance exits 0 even when the runner fails, so the result is a file. Settings written during a
      run persist in the profile, so the script rewrites them.
    - In `remote.test.js` the HTTP server runs in the test process, so a synchronous git against it deadlocks.
  - **Rules:** change "Never run `cursor --install-extension` or launch Cursor from an agent unless the user asks." to
    "Never run `cursor --install-extension` or launch the user's own Cursor from an agent unless the user asks;
    `scripts/live-test.js` (isolated profile under the temp folder, nothing installed) may be run without asking."
- **`docs/development.md`:** add a section **Tests** after **Building and releasing**. It describes:
  - the unit tests;
  - `remote.test.js` and what it stands in for;
  - `live-test.js`: what a scenario is, the root layout, `out/<scenario>`, how to add a scenario, the hook's members
    in one line each, and that it writes only `~/.cursor/projects/<slug of %TEMP%\tp-live\ws>` outside the temp
    folder;
  - what stays manual (`test/manual-remote-checks.md`).
- **`test/manual-remote-checks.md`:** rewrite it to keep only what tests can't cover.
  - Intro: the cases below need a real server and the real ssh/credential manager. Everything else is covered by
    `test/remote.test.js` (git level) and `scripts/live-test.js` (messages and buttons). Use
    `teamPlugins.repositories`, never `teamPlugins.repoUrl` (gone since 0.5).
  - Keep these cases, adapted to `teamPlugins.repositories`:
    - 1 (unknown host key, with Git's bundled ssh: fails fast);
    - 3 (passphrase: fails fast, no prompt);
    - 4 (HTTPS without stored credentials: the GCM message, no window);
    - 10 (protected branch on a real server);
    - 11 (Windows OpenSSH: silent, 120 s, no `ssh.exe` left).
  - Drop 2, 5, 6, 7, 8 and 9, and say in one line that the tests cover them.
- **`.claude/implement.md`:**
  - **Live test:** start with "Run `scripts/live-test.js` first (pre-approved: isolated profile, nothing installed).
    A request that changes behaviour adds or updates a scenario in `test/live/`; the install in the user's Cursor is
    asked only for what the scenarios can't show (the look, Remote-SSH)."
  - **Don't:** change it to match the new rule in `AGENTS.md`.
  - **Facts for plans:** add facts 2, 4, 9, 13 and 15 of this plan, one line each, with "(probe, Cursor 3.31,
    2026-11-25)".
- **`requests/ideas.md`:** add the three bullets of **Not handled** under **Smaller follow-ups**.
- **`README.md`:** no change (nothing changes for users). **`package.json`:** no change (no version bump).

## Commands

- Unit tests (from the repository root, Git Bash):
  `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js`
- Syntax check: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js`, and the
  same for `scripts/live-test.js`, `test/live/runner.js` and each `test/live/*.live.js`.
- Seam check: the `grep -nE` of C must print only the 7 `realUi` lines.
- Live run (allowed without asking, see **Don't**):
  `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js`. Expect
  `4/4 scenarios passed`; one scenario alone: `... scripts/live-test.js startup`.

## Don't

- No commit. Don't edit `requests/10-live-tests.md` or this plan. Report any change outside the files listed here
  (`lib/sync.js`, `extension.js`, `scripts/live-test.js`, `test/remote.test.js`, `test/remote-helpers.js`,
  `test/fake-ssh.js`, `test/live/*`, `AGENTS.md`, `docs/development.md`, `test/manual-remote-checks.md`,
  `.claude/implement.md`, `requests/ideas.md`).
- No dependency, no TypeScript, no bundler. Nothing under `lib/` or `scripts/` requires `vscode`; `test/live/runner.js`
  and the scenario `run` functions get it from Cursor.
- You may run `scripts/live-test.js`: it is the isolated instance and is approved for this request. Never run
  `cursor --install-extension`, never launch Cursor with the user's own profile, and never touch
  `%APPDATA%\Cursor\User\settings.json`.
- Never set or change the user's global git config. The tests isolate git through environment variables only.
- Don't use `fs.rmSync` on git folders: use `sync.removeTree` / `helpers.rmDir`.
- Don't use synchronous git against the test HTTP server (fact 4).
- Don't change the behaviour of `extension.js` outside Test mode, beyond the mechanical `ui.` replacement and the
  `queueCheckboxChange` factoring.
- If a scenario fails for a reason that looks like a wrong fact in this plan (another label, another message, another
  log path), stop and report it with the scenario's `out/<name>` details, rather than loosening the assertion.

## Changes after review

- **Dialog calls:** there were 81, not 70. 11 of them are written as `vscode.window` with `.show…(` on the next line,
  which the single-line grep of C misses. One of them was `showRemoteError`, so its message wasn't recorded in the
  first live run. All of them now go through `ui`; the check is a multiline search (`vscode\.window\s*\.\s*show`).
- **Permission wording not applied:** the auto-mode classifier refused the implementer's edits that pre-approve
  `scripts/live-test.js` (the `AGENTS.md` **Rules** line, and the **Live test** opener and **Don't** of
  `.claude/implement.md`). After the maintainer explicitly asked, they were applied in review, as worded in
  **Keep in step**.
- **`live-test.js` wipes:** it wipes the whole `<root>/ud`, not only `ud/User`, so the newest `logs/<session>` is
  always the current run's.
- **`testIdle`:** it races its timeout against every wait, so a stuck queue can't hang past `timeoutMs`.
- **`pre-receive` hook in `remote.test.js`:** it refuses only `refs/heads/main` (as in `contribute.test.js`), so
  **Push to a branch** goes through.
