# Plan 14: Getting started walkthrough

## Context

- Repository: this one (Cursor extension, plain CommonJS, no dependency, no build). Request: `requests/14-walkthrough.md`.
- Version: 0.8.2 -> **0.8.3** (`package.json` `version`).
- Branch: `request/14-walkthrough` (already checked out).
- Files involved:
  - `package.json` `contributes`: `commands`, `menus.view/title`, `viewsWelcome`; new `walkthroughs`.
  - `extension.js`: `gitPath()` (line ~153), `remoteMachine()` (~472), `realUi` / `ui` (~60), `registerCommands(context)`
    (~2423; `teamPlugins.addRepository` at ~2438 shows the style), `testHook(context)` (~3040), `log()`.
  - `lib/sync.js` `gitVersionOf(text)` (~294, exported): parses `git version 2.47.0.windows.1` to `[2, 47, 0]`.
  - `lib/git.js` `makeGit(gitPath)` returns `run(args, cwd, opts)` -> `{ code, stdout, stderr }` (stdout trimmed).
  - `scripts/package.js` `vsixEntries()`: packages `resources/` **non-recursively** (`filesOf('resources')`), and maps
    `.md` in `[Content_Types].xml`.
  - New: `lib/gitCheck.js`, `test/gitCheck.test.js`, `test/live/walkthrough.live.js`,
    `resources/walkthrough-git.md`, `resources/walkthrough-repository.md`, `resources/walkthrough-plugins.md`.

## Measured facts (don't measure them again)

All on Cursor 3.32.4 (VS Code API 1.147.0), Windows 11, 2026-11-26.

1. Cursor shows extension walkthroughs. `workbench.action.openWalkthrough` exists. Called with
   `{ category: '<extensionId>#<walkthroughId>', step: '<extensionId>#<walkthroughId>#<stepId>' }, false` it opens an
   editor tab labelled `Walkthrough: Team plugins` (`Walkthrough: <displayName>`). The string form
   `'<extensionId>#<walkthroughId>'` gave a tab labelled `Welcome`; a string with `#<stepId>` logs
   `Could not find category with ID` and opens the generic Welcome page. Use the object form. (isolated live-test probe)
2. `vscode.window.tabGroups.all[*].tabs[*].label` gives the tab label; `tab.input` of that tab is an opaque object (no
   keys). (probe)
3. Step completion (probe, storage `memento/gettingStartedService` read after the run):
   - `onContext:key` and `onContext:key == value` complete a step when the key changes to a matching value.
   - `onSettingChanged:<setting>` completes on a settings change (`getConfiguration().update`, Global).
   - `onCommand:<id>` completes only when the command goes through the workbench (palette, menu, command link,
     `runCommands`), not on a plain `vscode.commands.executeCommand` from the extension host.
   - **A context key already true when the walkthrough is registered never completes the step in that session**, even
     if it changes later: Cursor's `onContext` registration puts the event in `sessionEvents` when the expression
     already matches, and `progressByEvent` skips events already in `sessionEvents` (read in
     `resources/app/out/vs/workbench/workbench.desktop.main.js`; the probe's step set true before registration stayed
     not done). Registration happens at startup and may wait up to 5 s (an experiment-service race), so it races with
     `onStartupFinished` activation. Hence: **never set the walkthrough's context key at activation**.
4. With `--extensionTestsPath` (scripts/live-test.js) Cursor keeps storage in memory: a live scenario can't read step
   progress. (probe)
5. Cursor opens a walkthrough by itself only when the extension was installed in this session (not with a
   `skipWalkthrough` install context), the walkthrough id is seen for the first time, the window had the last focus and
   `workbench.welcomePage.walkthroughs.openOnInstall` is on. `updateAll` installs without `skipWalkthrough`, so an update
   probably counts as an install (read in the bundle, not probed). With `--extensionDevelopmentPath` nothing opens.
6. `makeGit('nogit-xyz')(['--version'], cwd)` -> `{ code: 1, stdout: '', stderr: 'spawn nogit-xyz ENOENT' }`.
   `makeGit('git')(['--version'])` -> `stdout: 'git version 2.47.0.windows.1'`. `git config user.name` outside a
   repository with no global name -> `{ code: 1, stdout: '', stderr: '' }` (this machine has no global identity).
7. From the project notes (not checked again): every dialog goes through `ui` (Test mode records them;
   `ui.openExternal` is recorded and never opens a browser); `t.hook.respond(fn)` answers dialogs in a live scenario;
   settings written in a run persist only for that run (the script rewrites them).

## Design

### `lib/gitCheck.js` (new, pure, never requires `vscode`)

```js
const { gitVersionOf } = require('./sync');
const MIN_VERSION = [2, 38];
const DOWNLOAD_URL = 'https://git-scm.com/downloads';
```

`async function checkGit({ run, cwd })` -> `{ status, version, name, email, error }`:

1. `v = await run(['--version'], cwd)`.
2. `v.code !== 0`: `status` is `'missing'` when `/\bENOENT\b/.test(v.stderr)`, else `'error'`; `error` = `v.stderr`
   trimmed (or `exit code <code>` when empty). Return with `version: ''`, `name: ''`, `email: ''` (no further call).
3. `ver = gitVersionOf(v.stdout)`; `null` -> `status: 'error'`, `error: 'unexpected output of git --version: <stdout>'`.
4. `version = ver.join('.')`. `status = ver[0] < 2 || (ver[0] === 2 && ver[1] < 38) ? 'old' : 'ok'`.
5. `name` / `email`: `run(['config', '--get', 'user.name'], cwd)` / `user.email`: the trimmed stdout when `code === 0`,
   else `''`. Both run for `ok` and `old`.
6. `error: ''` when not an error.

`function gitCheckMessage(result, { gitPath = 'git', machine = '' } = {})` -> `{ level, message, actions }`
(`level`: `'info' | 'warning' | 'error'`; `actions`: array of `'downloadGit'`). `where` = `machine ? \` on ${machine}\` : ''`.
`pathText` = `gitPath === 'git' ? 'git is not on PATH' : \`git.path is ${gitPath}\``. Messages, exactly:

| status | level | message | actions |
| --- | --- | --- | --- |
| `missing` | error | `git was not found${where} (${pathText}). Install git 2.38 or later, then restart Cursor.` | `['downloadGit']` |
| `error` | error | `cannot run git${where}: ${error}` | `[]` |
| `old` | warning | `git ${version}${where} is too old: 2.38 or later is needed to merge team updates with your local changes. Update git, then run Check git again.` | `['downloadGit']` |
| `ok` | info | `git ${version} is ready${where}.` then, when `!name \|\| !email`, a space and `To commit changes to a team repository, git also needs your name and email: git config --global user.name "Your Name" and git config --global user.email "you@example.com".` | `[]` |

Export `{ checkGit, gitCheckMessage, DOWNLOAD_URL, MIN_VERSION }`.

### `extension.js`

- `require('./lib/gitCheck')` next to the other `lib` requires.
- Module variable `let lastGitCheck = null;` (Test mode reads it).
- `async function checkGitCommand()`:
  1. `const gp = gitPath(); const result = await checkGit({ run: makeGit(gp), cwd: storage });` (`storage` exists and
     is not inside a repository, so `git config --get` reads the user's global/system values).
  2. `lastGitCheck = result;`
  3. `log(\`git check: ${result.status}${result.version ? ' ' + result.version : ''}${result.error ? ': ' + result.error : ''}\`)`.
  4. `await vscode.commands.executeCommand('setContext', 'teamPlugins.gitReady', result.status === 'ok');`
  5. `const m = gitCheckMessage(result, { gitPath: gp, machine: remoteMachine() });` show
     `\`Team plugins: ${m.message}\`` with `ui.showInformationMessage` / `showWarningMessage` / `showErrorMessage` per
     `m.level`, with the button `Download git` when `m.actions` includes `'downloadGit'`; on that choice
     `ui.openExternal(DOWNLOAD_URL)` (a string: see the `realUi.openExternal` comment). Don't `await` the message
     (follow the `.then(choice => ...)` style of `showRemoteError`) but **return** the promise of the whole chain so a
     scenario can wait for it: `return ui.show...(...).then(...)`.
  6. Wrap 1–5 in try/catch: on an unexpected throw, `log` it and `ui.showErrorMessage(\`Team plugins: cannot run git: ${err.message}\`)`.
- **Never set `teamPlugins.gitReady` anywhere else** (in particular not at activation, nor on a `git.path` change):
  see fact 3.
- In `registerCommands(context)`:
  - `reg('teamPlugins.checkGit', checkGitCommand);`
  - `reg('teamPlugins.getStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', { category: \`${context.extension.id}#gettingStarted\`, step: \`${context.extension.id}#gettingStarted#checkGit\` }, false));`
    Name the walkthrough id once as a constant `const WALKTHROUGH_ID = 'gettingStarted';` near `VIEW_COMMAND`.
- `testHook`: add `gitCheck: () => lastGitCheck,`.

### `package.json`

- `version`: `0.8.3`.
- `contributes.commands`, add after `teamPlugins.showLog`:
  - `{ "command": "teamPlugins.checkGit", "title": "Check git", "category": "Team Plugins" }`
  - `{ "command": "teamPlugins.getStarted", "title": "Get started", "category": "Team Plugins" }`
- `menus.view/title`, add: `{ "command": "teamPlugins.getStarted", "when": "view == teamPlugins.plugins", "group": "9_help@1" }`
  (the `...` overflow menu).
- `viewsWelcome` (the `unconfigured` entry): append `\nNew here? [Get started](command:teamPlugins.getStarted)` to
  `contents` (after the local clone link).
- New `contributes.walkthroughs` (after `viewsWelcome`), exactly:

```json
"walkthroughs": [
  {
    "id": "gettingStarted",
    "title": "Get started with Team plugins",
    "description": "Follow your team's plugin repositories and pick the rules, skills, commands, agents and MCP servers you need.",
    "steps": [
      {
        "id": "checkGit",
        "title": "Check git",
        "description": "Team plugins clones and updates the team repositories in the background, with your own git and its credentials: git 2.38 or later must reach the repository without asking anything.\n[Check git](command:teamPlugins.checkGit)",
        "media": { "markdown": "resources/walkthrough-git.md" },
        "completionEvents": ["onContext:teamPlugins.gitReady"]
      },
      {
        "id": "addRepository",
        "title": "Add a team repository",
        "description": "Paste the Git URL of your team's plugin repository: it is cloned in the background and checked for updates every hour. You can follow several.\n[Add repository](command:teamPlugins.addRepository)\nPlugin authors can follow their own clone instead: [Add a local clone](command:teamPlugins.addLocalRepository).",
        "media": { "markdown": "resources/walkthrough-repository.md" },
        "completionEvents": ["onSettingChanged:teamPlugins.repositories", "onSettingChanged:teamPlugins.localRepositories"]
      },
      {
        "id": "pickPlugins",
        "title": "Pick your plugins",
        "description": "Tick the plugins you want in the Team Plugins view: the agent uses them in every project, in new chats. Expand a plugin to pick single skills, rules, commands, agents or MCP servers.\n[Open the Team Plugins view](command:workbench.view.extension.teamPlugins)",
        "media": { "markdown": "resources/walkthrough-plugins.md" },
        "completionEvents": ["onSettingChanged:teamPlugins.enabled"]
      }
    ]
  }
]
```

### Markdown pages (new files, exactly this text)

The media files sit directly in `resources/` (packaging is not recursive). Links only `https:`.

`resources/walkthrough-git.md`:

```markdown
# Git and your credentials

Team plugins runs git in the background with your own credentials, on the machine the extension runs on (in a
Remote-SSH window, the remote machine). It never asks for a password: git must reach the team repository without
asking anything.

## Install git

Git 2.38 or later is needed.

- **Windows**: Git for Windows, from https://git-scm.com/downloads. Restart Cursor afterwards so that it finds git.
- **macOS**: `xcode-select --install`, or `brew install git`.
- **Linux**: your distribution's package, for example `sudo apt install git`.

If git is installed where Cursor doesn't look, set its path in the `git.path` setting.

## Sign in once

In a terminal, run `git ls-remote <team repository URL>` and answer its questions once:

- **HTTPS**: your credential manager keeps the credentials. On Linux and macOS, set up a credential helper first (for
  example `gh auth setup-git` for GitHub).
- **SSH**: use a key without a passphrase, and accept the server's host key.

## To contribute

To commit changes to a team repository, git also needs your name and email:

    git config --global user.name "Your Name"
    git config --global user.email "you@example.com"
```

`resources/walkthrough-repository.md`:

```markdown
# The team repository

A team repository is a git repository holding your team's Cursor plugins. Ask your team for its URL.

Click **Add repository** and paste the URL, in any of these forms:

- `https://example.com/org/team-plugins.git`
- `git@example.com:org/team-plugins.git`
- `ssh://git@example.com/org/team-plugins.git`

The URL is checked at once, then the repository is cloned in the background. It is checked for updates every hour
(`teamPlugins.updateIntervalMinutes`), and **Sync now** in the view checks at once.

To follow a branch other than the repository's default one, edit `teamPlugins.repositories` in your user settings:
`{ "url": "...", "branch": "next" }`. Follow one repository per team, or as many as you need.

**Plugin authors**: **Add a local clone** follows a clone you already have. Your edits are picked up live, and the
extension never runs a git command that changes it.
```

`resources/walkthrough-plugins.md`:

```markdown
# Picking plugins

The **Team Plugins** view lists the repositories you follow and their plugins.

- **Tick a plugin** to enable all of it in every project: the agent uses its rules, skills, commands, agents and MCP
  servers in new chats.
- **Expand a plugin** to pick single items. A plugin enabled in part stays unticked and shows a pie chart icon.
- **Right-click > Add to this project** to require a plugin for everyone who opens this project, then commit
  `.vscode/settings.json`. Items the project enables are drawn in purple, with a **P** badge.

The status bar item `Team plugins: <count>` shows how many plugins this window registered.

When a teammate improves a plugin, the update reaches you by itself: start a new chat to use it.
```

## Impact

- `viewsWelcome` gains a line: no code reads it.
- `teamPlugins.gitReady` is a new context key: nothing else reads it (only the walkthrough's `completionEvents`).
- `testHook` gains `gitCheck`: existing scenarios unaffected.
- `scripts/package.js`: unchanged (flat files in `resources/` are packaged already); `test/package.test.js` gains an
  assertion (below).
- `checkConflicts` in `lib/sync.js` keeps its own 2.38 check and message: leave it (it guards the merge itself).

## Not handled

- No tick for someone already set up (fact 3): README says steps tick from what you do and Cursor's **Mark Done** is
  there.
- Opening by itself is Cursor's (after an install; probably after an update too, fact 5): `docs/development.md`.
- A sync that fails because git can't be started doesn't point to Check git.
- Remote-SSH not probed: `docs/development.md` (Check git runs on the remote machine, like every git command).

## Tests

### `test/gitCheck.test.js` (new; `node:test`, fake `run` returning canned results, recording the args)

A fake: `const fake = (answers) => { const calls = []; return { calls, run: async (args) => { calls.push(args.join(' ')); return answers[args.join(' ')] || { code: 1, stdout: '', stderr: '' }; } }; };`

`checkGit`:
1. `--version` -> `{ code: 1, stderr: 'spawn nogit ENOENT' }` -> `{ status: 'missing', version: '', name: '', email: '', error: 'spawn nogit ENOENT' }`; calls = `['--version']` only.
2. `--version` -> `{ code: 128, stderr: 'fatal: bad config line 1' }` -> `status: 'error'`, `error: 'fatal: bad config line 1'`.
3. `--version` -> `{ code: 1, stderr: '' }` -> `status: 'error'`, `error: 'exit code 1'`.
4. `--version` -> `{ code: 0, stdout: 'hello' }` -> `status: 'error'`, `error: 'unexpected output of git --version: hello'`.
5. `--version` -> `git version 2.47.0.windows.1`, `config --get user.name` -> `{ code: 0, stdout: 'Ann' }`,
   `config --get user.email` -> `{ code: 0, stdout: 'ann@example.com' }` -> `{ status: 'ok', version: '2.47.0', name: 'Ann', email: 'ann@example.com', error: '' }`.
6. `git version 2.38.0` -> `ok`; `git version 2.37.9` -> `old`, version `2.37.9`; `git version 1.9.5` -> `old`;
   `git version 3.0.0` -> `ok`.
7. `ok` with both config calls exiting 1 -> `name: ''`, `email: ''`.

`gitCheckMessage` (exact strings):
8. missing, default options -> `{ level: 'error', message: 'git was not found (git is not on PATH). Install git 2.38 or later, then restart Cursor.', actions: ['downloadGit'] }`.
9. missing, `{ gitPath: 'C:\\tools\\git.exe', machine: 'devbox' }` -> message
   `git was not found on devbox (git.path is C:\tools\git.exe). Install git 2.38 or later, then restart Cursor.`
10. error `fatal: x` -> `{ level: 'error', message: 'cannot run git: fatal: x', actions: [] }`.
11. old `2.30.1` -> `{ level: 'warning', message: 'git 2.30.1 is too old: 2.38 or later is needed to merge team updates with your local changes. Update git, then run Check git again.', actions: ['downloadGit'] }`.
12. ok with name and email, machine `devbox` -> `{ level: 'info', message: 'git 2.47.0 is ready on devbox.', actions: [] }`.
13. ok with email `''` -> message `git 2.47.0 is ready. To commit changes to a team repository, git also needs your name and email: git config --global user.name "Your Name" and git config --global user.email "you@example.com".`
14. `DOWNLOAD_URL === 'https://git-scm.com/downloads'`.

### `test/package.test.js`

- In `buildVsix`, add `'extension/resources/walkthrough-git.md'`, `'extension/resources/walkthrough-repository.md'`,
  `'extension/resources/walkthrough-plugins.md'` to the expected names.
- New test `the walkthrough's files and commands exist`: read `package.json`; for every step of every walkthrough,
  `media.markdown` (or `media.image` when present) exists under the repository root; every `command:<id>` link in
  a step description (`/\(command:([\w.]+)\)/g`) is either a contributed command (`contributes.commands[].command`) or
  `workbench.view.extension.teamPlugins`; every link in the media markdown files (`/\]\(([^)\s]+)\)/g`) is `https:`.
  Also the `viewsWelcome` `command:` links are contributed commands.

### `test/live/walkthrough.live.js` (new scenario)

Follow `test/live/startup.live.js`'s shape. `setup()` returns `{ settings: {}, data: {} }` (no repository: the view is
`unconfigured`). `run(t)`:
1. step `open the walkthrough`: `await t.vscode.commands.executeCommand('teamPlugins.getStarted')`; then
   `t.waitFor` (10 s) a tab in `t.vscode.window.tabGroups.all` whose `label === 'Walkthrough: Team plugins'`.
2. step `check git`: `t.hook.clearCalls()`; `await t.vscode.commands.executeCommand('teamPlugins.checkGit')`;
   `t.waitFor(() => t.hook.gitCheck())`; assert `t.hook.gitCheck().status === 'ok'` (the machine's git is >= 2.38);
   one `showInformationMessage` call whose message matches `/^Team plugins: git \d+\.\d+\.\d+ is ready\./`, no buttons.
   Don't assert on the name/email sentence (depends on the machine).
3. step `missing git`: `t.hook.clearCalls()`; `t.hook.respond((r) => (r.kind === 'showErrorMessage' ? 'Download git' : undefined))`;
   `await t.vscode.workspace.getConfiguration('git').update('path', <a path that doesn't exist, e.g. path.join(os.tmpdir(), 'tp-no-git', 'git.exe')>, t.vscode.ConfigurationTarget.Global)`;
   run `teamPlugins.checkGit` again; assert `gitCheck().status === 'missing'`; one `showErrorMessage` whose message
   starts with `Team plugins: git was not found (git.path is ` and whose buttons are `['Download git']`; then
   `t.waitFor` an `openExternal` call with `url === 'https://git-scm.com/downloads'`.
4. Restore: `update('path', undefined, Global)`, `t.hook.respond(null)`; `t.idle()`; assert no other
   `showErrorMessage` than the one of step 3 (the `git.path` change triggers a refresh with no repository: nothing to
   report).

Existing tests and fixtures affected: none besides `test/package.test.js`.

## Keep in step

- `README.md`:
  - **Getting started**: open with one sentence: `**Team Plugins: Get started** (command palette, or **Get started**
    in the view's **...** menu) opens a walkthrough of these steps; Cursor also opens it after the install.` Step 1
    gains: `**Team Plugins: Check git** says whether git is found and recent enough, and whether it knows your name and
    email (needed only to commit).` Keep the three steps as they are otherwise. Add after the list: `The walkthrough
    ticks a step when you do it (check git, add a repository, tick a plugin); if you were set up before, use **Mark
    Done**.`
  - **Troubleshooting**: a bullet `"git was not found": install git (2.38 or later) and restart Cursor, or set
    git.path; **Team Plugins: Check git** checks it again.` (plain text, no relative link).
  - No command link and no relative link (the `package.test.js` README check).
- `docs/development.md`:
  - **How it works**: a short subsection `Walkthrough`: id `gettingStarted`, the three steps and their
    `completionEvents`, why the context key `teamPlugins.gitReady` is set only by **Check git** (fact 3, with its
    source), that `Get started` uses the object form of `workbench.action.openWalkthrough` (fact 1), the media files
    flat in `resources/` because packaging isn't recursive, and the auto-open rule (fact 5, "read in the bundle, not
    probed" for updates).
  - **Tests**: the hook gains `gitCheck`; scenario `walkthrough`; live scenarios can't read walkthrough progress (fact 4).
  - **Known limits (details)**: Remote-SSH not probed for the walkthrough.
- `AGENTS.md`:
  - Layout: add `gitCheck` (`checkGit`, `gitCheckMessage`: the Check git command's check and message) to the `lib/`
    list.
  - "Why the code is shaped this way": one bullet: walkthrough steps tick only from a change after registration
    (Cursor puts an already-matching `onContext` in `sessionEvents` and never progresses it), so
    `teamPlugins.gitReady` is set only by Check git and the other steps tick on `onSettingChanged`; `onCommand` of an
    extension's own command fires only through the workbench.
- `package.json` version `0.8.3`.

## Commands

From the repository root (Git Bash), no node on PATH:

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js walkthrough startup
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
```

Then check `dist/cursor-team-plugins-0.8.3.vsix` holds the three `resources/walkthrough-*.md`.

## Don't

- No commit. Don't edit `requests/14-walkthrough.md` or this plan.
- No change outside the files listed here without reporting it.
- Never run `cursor --install-extension` or launch the user's own Cursor; `scripts/live-test.js` is allowed.
- Don't set `teamPlugins.gitReady` at activation or on a configuration change.
- Don't add `onCommand:` completion events (they would tick Check git even when git is missing, and Add repository when
  cancelled).
- Count or check `vscode.window.show*` call sites with a multiline search (`vscode\.window\s*\.\s*show`), never a
  single-line grep; new dialogs go through `ui`, not `vscode.window`.
- No relative links in README.md; no new dependency.

## Changes after review

- Live scenario step 1 runs **Get started** again (inside `t.waitFor`, 30 s) until the `Walkthrough: Team plugins` tab
  shows: right after startup Cursor hasn't registered the walkthrough yet and the command opens the generic Welcome
  tab. The extension's command is unchanged; the behaviour is noted in `AGENTS.md` and `docs/development.md`.
- `AGENTS.md` line 3 carries the version (0.8.3).
