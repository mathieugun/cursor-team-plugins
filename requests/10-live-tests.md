# Request 10: automated live tests

Raised by the maintainer (2026-11-25), not from `ideas.md`. Plan: `10-live-tests.plan.md` (not written yet).

## Asked

Each change ends with a live test clicked through by hand: install the VSIX in the maintainer's Cursor, reload, follow
the agent's question cards, and before a release that changes the remote code, `test/manual-remote-checks.md`. Goal:
no hand step at all; failing that, as few as possible.

## Probe (2026-11-25, Cursor 3.31, Windows; Node 24.22, Electron 43.8.9 in Cursor's runtime)

An isolated Cursor instance runs an extension test entry with the extension loaded from the working tree:

```
Cursor.exe --user-data-dir=<root>/ud --extensions-dir=<root>/ext --extensionDevelopmentPath=<repo>
           --extensionTestsPath=<root>/runner/index.js --disable-workspace-trust --skip-welcome
           --skip-release-notes --new-window <root>/ws
```

with `<root>/ud/User/settings.json` setting `teamPlugins.repositories` (a `make-test-repo.js` repository) and
`teamPlugins.enabled`. Results:

- `vscode.cursor.plugins` (`addPlugin`, `removePlugin`) exists; the extension activates, clones, and Cursor logs
  `Registered extension plugin: review` / `docs` and `Plugins reload completed: 2 plugins loaded (2 extension, ...)`;
  the MCP servers `lint` and `tickets` get their `mcp-server-plugin-...` logs. 7 s from launch to exit; the window
  closes by itself when `run()` settles.
- Signed out: Cursor shows its sign-in screen, which blocks nothing (the run ended before anyone could act on it, and
  neither probe profile holds a sign-in).
- The process exits with code 0 even when `run()` rejects: the result must come from a file the runner writes.
- `<root>` must be short: under the scratchpad the clone failed on MAX_PATH (`fatal: cannot stat
  .../.git/hooks/fsmonitor-watchman.sample`); `%TEMP%\tp1` worked.
- Cursor's `Cursor Plugins.log` was under `exthost/anysphere.cursor-agent-exec` in the probe profile
  (`anysphere.cursor-agent-host` in the maintainer's profile): search `<root>/ud/logs` for it.
- Cursor adds its own keys to `settings.json` (`window.autoDetectColorScheme`, `cursor.composer.*`): harmless.
- The user's own Cursor, settings and extensions are untouched; nothing is installed.

Not probed yet: `--remote-debugging-port` with the isolated instance, an isolated run in a Remote-SSH window.

## Proposed layers

1. **Remote cases without Cursor** (replaces most of `test/manual-remote-checks.md`, runs in `scripts/test.js` and
   CI): real git against local stand-ins, with `HOME` and `GIT_CONFIG_GLOBAL` pointed at temporary files so the user's
   `known_hosts` and credentials are never touched. SSH cases (unknown or changed host key, passphrase, silent ssh):
   `core.sshCommand` set to a fake ssh script that prints the real ssh message or stays silent (the 120 s idle limit
   made a parameter so the test takes seconds; no child process left). HTTPS cases (no stored credentials, refused
   credentials, wrong URL, wrong branch): a node `http` server running `git http-backend` with basic auth. Offline:
   `127.0.0.1:1`. Protected branch: a `pre-receive` hook (as `contribute.test.js` does).
2. **Extension-host tests in an isolated Cursor** (`scripts/live-test.js`, the probe's command): scenarios written
   with `node:assert`, no dependency. Needs two seams in `extension.js`: every `vscode.window.show*Message`,
   `showQuickPick`, `showInputBox` goes through one `ui` object that a test replaces with scripted answers (and which
   records each message with its buttons); `activate` returns a test hook (tree snapshot with labels, icons and
   checkbox states, the checkbox handler, registrations, decorations). Checks on Cursor's side read its logs and
   `~/.cursor/projects/<workspace>/mcps/`.
3. **A few real clicks** through the Chrome DevTools Protocol (`--remote-debugging-port`, Node 24's built-in
   `WebSocket`): tick a tree checkbox, read a notification and click its button, open a context menu. 3 to 5 smoke
   scenarios only: the workbench DOM changes between Cursor versions.

Remote-SSH: layer 2 run against the maintainer's always-on Linux machine as the remote host (the probe-window command
of `.claude/implement.md`); no local SSH server or WSL.

## Expected to stay manual

- The look: icons, colours, the selected-row colour quirk (screenshots of the isolated instance can be attached to the
  run for a glance).
- One check against a real server with the real credential manager, before a release that changes the remote code.
- Several windows sharing one clone (separate profiles don't share global storage; the lock logic is covered by the
  `lib` tests).

## Open questions for the design review

- Scope: layers 1 and 2 in this request, layer 3 later?
- The test hook and the `ui` seam: always exported, or only when an environment variable is set?
- `AGENTS.md` says never to launch Cursor from an agent unless asked: does the isolated test instance (own profile, no
  install) become allowed for `scripts/live-test.js`?
- How a remote run names the SSH host (environment variable, argument).
- Can the sign-in screen be kept from showing during runs (a setting or flag)? Not blocking.
