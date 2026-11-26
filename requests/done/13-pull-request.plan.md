# Plan 13: open a pull request after Push to a branch

## Context

- Repository: cursor-team-plugins (Cursor extension, plain JavaScript, CommonJS, no dependency, no build).
- Request: `requests/13-pull-request.md`. Version 0.8.1 -> **0.8.2**.
- Branch: `request/13-pull-request` (already created; don't commit).
- Files and functions involved today:
  - `lib/contribute.js`: `pushToBranch` (line 122) pushes the local changes to a new branch, then resets the clone;
    it returns `{ kind: 'pushedBranch', branch, remote, head }` (line 186). Its push failure goes through
    `remoteResult(push, { url, branch, op: 'push' }, ...)` (line 169). `commitAndPush` (line 109) uses `op: 'push'`
    too, with `branch: up.branch`. `upstream(git, repo)` gives `{ remote, branch }` of the branch the clone follows.
  - `lib/remoteErrors.js`: `describeRemote` (`case 'pushRejected'` line 134, `case 'denied'` line 141) words a
    classified failure and lists action ids; `remoteResult` passes `op` through.
  - `extension.js`:
    - `realUi` (lines 60-68): every dialog goes through `ui`; `makeTestUi` (line 2868) records them in Test mode.
    - `ACTIONS` (lines 441-458): the buttons of a classified remote error (`pushToBranch`, `retryPush`, ...);
      `showRemoteError` (line 468) shows them (and always adds `Show log`).
    - `reportContribution` (line 2652): `case 'pushedBranch'` shows "Pushed your changes to branch ..." with
      **Copy merge commands**.
    - `pushToBranchCommand(arg)` (line 2772): picks the repository (`pickToContribute` -> `pickRepo` ->
      `repoFromArg`, which reads `arg.repo`), asks the branch name (input box, default `defaultBranchName`), the
      commit message when there are uncommitted files, runs `contribute.pushToBranch` and calls
      `reportContribution`.

## Measured facts (don't measure them again)

1. **Cursor's `vscode.env.openExternal` keeps a string exactly** (read in the Cursor 3.32 bundles, not run):
   - extension host (`out/vs/workbench/api/node/extensionHostProcess.js`): `openExternal(v,b){return T.openUri(v,...)}`
     and `openUri(e,t){let r;if(typeof e=="string"){r=e;try{e=C.parse(e)}...}...this._proxy.$openUri(e,r,t)}`;
   - workbench (`out/vs/workbench/workbench.desktop.main.js`): `$openUri(e,t,i){...t&&te.parse(t).toString()===n.toString()?r=t:r=n, this.openerService.open(r,...)}`
     and `_doOpenExternal(e,t){const i=typeof e=="string"?te.parse(e):e; ... typeof e=="string"&&i.toString()===n.toString()?r=e:r=encodeURI(n.toString(!0)); ...}`.
   - So a **string** argument reaches the browser unchanged; a `Uri` is re-encoded with `encodeURI(uri.toString(true))`,
     which decodes our `%26`, `%2B`, `%23` (a branch with `&`, `+` or `#` would break the query). **Pass the URL as a
     string** (`vscode.env.openExternal(url)`; the typings say `Uri`, the runtime takes a string; plain JS, no typings
     involved).
2. GitHub (docs, "Using query parameters to create a pull request"): `https://github.com/<owner>/<repo>/compare/<base>...<head>?quick_pull=1`
   "Opens the 'Open a pull request' page for the compared branches".
3. GitLab (GitLab's source, `app/services/merge_requests/get_urls_service.rb`, which builds the URL printed on push):
   `project_new_merge_request_url(project, merge_request: { source_branch: branch_name })`, i.e.
   `<project URL>/-/merge_requests/new?merge_request%5Bsource_branch%5D=<branch>`. `merge_request[target_branch]` is the
   same form's other field (by analogy, not found in a doc).
4. Azure DevOps (Microsoft docs): SSH URLs `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` ("previous URLs use
   `vs-ssh.visualstudio.com`"); HTTPS `https://<org>@dev.azure.com/<org>/<project>/_git/<repo>`, the
   `visualstudio.com` format "is still supported"; Azure DevOps Services prints a PR URL on push, Azure DevOps Server
   doesn't. The page `…/_git/<repo>/pullrequestcreate?sourceRef=<branch>&targetRef=<branch>` (short branch names) is
   **not confirmed by any doc**: built anyway (user's decision), flagged in `docs/development.md`.
5. A local bare repository's `pre-receive` hook output reaches the client's `git push --progress` stderr as `remote:`
   lines, padded with trailing spaces (checked, Git for Windows):
   ```
   remote: Create a pull request for team-plugins/x-1:        
   remote:      https://git.example.test/team/plugins/pull/new/team-plugins/x-1        
   To C:/.../b.git
    * [new branch]      HEAD -> team-plugins/x-1
   ```
   A hook that exits 1 on `refs/heads/main` gives `! [remote rejected] main -> main (pre-receive hook declined)`,
   classified `pushRejected` (existing tests: `test/contribute.test.js` "a push refused on main goes through Push to a
   branch", `test/remote.test.js` `protectMain`).
6. `lib/git.js` trims stderr; the push's stderr is available as `push.stderr` in `pushToBranch`.
7. `repoFromArg` reads `arg.repo`: `{ repo: d.key, openPullRequest: true }` picks the repository like today's
   `{ repo: d.key }`.
8. Project facts that apply: every dialog goes through `ui` (a live runner can't patch the extension's `vscode.window`);
   `extension.js` splits some dialog calls over two lines (count call sites with a multiline search); the README names
   files in plain text and links only `http(s)`/`mailto`.

## Design

### 1. `lib/pullRequest.js` (new, pure, never requires `vscode`)

Exports `pullRequestPage({ url, branch, target, pushOutput })` and `parseRemote(url)`.

`parseRemote(url)` -> `{ host, path }` or `null`:
- `^([a-z][a-z0-9+.-]*)://(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::\d+)?(?:/(.*))?$` (case-insensitive): the scheme must be
  `http`, `https`, `ssh` or `git` (else `null`, e.g. `file:`); host = group 2 lower-cased; path = group 3 or `''`.
- Else the scp-like form `^(?:[^@/\\]+@)?([^:/\\]+):(.*)$`, refused when the text contains `://` (`file:///srv/x`
  must not read as host `file`), starts with a Windows drive (`^[a-z]:[\\/]`, i) or the host is one character long;
  host lower-cased, path = group 2.
- Else `null` (local paths).
- Path: strip leading `/`s, then trailing `/`s, then one trailing `.git` (case-insensitive), then trailing `/`s again.
  `null` when the path is empty. Segments are kept as written (an Azure project with a space stays `My%20Project`).

`pullRequestPage({ url, branch, target, pushOutput })` -> `{ url, target }` or `null` (`target` is the target branch
when the page was built, `null` when it is the printed one):
- `enc = encodeURIComponent`; `encPath(b) = b.split('/').map(encodeURIComponent).join('/')`.
- With `r = parseRemote(url)` and `segs = r.path.split('/')`, in this order (a known host whose path doesn't have the
  shape falls through to the printed URL):
  1. `r.host === 'github.com'` and `segs.length === 2`:
     `https://github.com/${segs[0]}/${segs[1]}/compare/${encPath(target)}...${encPath(branch)}?quick_pull=1`
  2. `r.host === 'gitlab.com'` and `segs.length >= 2`:
     `https://gitlab.com/${r.path}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${enc(branch)}&merge_request%5Btarget_branch%5D=${enc(target)}`
  3. Azure DevOps, base URL then `${base}/pullrequestcreate?sourceRef=${enc(branch)}&targetRef=${enc(target)}`:
     - `dev.azure.com`, `segs.length === 4` and `segs[2] === '_git'`: base `https://dev.azure.com/${r.path}`;
     - `ssh.dev.azure.com`, `segs.length === 4` and `segs[0] === 'v3'`:
       base `https://dev.azure.com/${segs[1]}/${segs[2]}/_git/${segs[3]}`;
     - `vs-ssh.visualstudio.com`, `segs.length === 4` and `segs[0] === 'v3'`:
       base `https://${segs[1]}.visualstudio.com/${segs[2]}/_git/${segs[3]}`;
     - any other host ending in `.visualstudio.com`, `segs.length` 3 or 4 and `segs[segs.length - 2] === '_git'`:
       base `https://${r.host}/${r.path}` (keeps a `DefaultCollection/` prefix).
- Otherwise (no or unknown host, or a shape that didn't match), the printed URL: split `pushOutput` on `/\r?\n|\r/`;
  for each line matching `^remote:(.*)$`, take every `https?:\/\/[^\s'"<>]+` match, strip trailing `.,;:)` characters,
  and return the first that contains `branch` or `encodeURIComponent(branch)`: `{ url: thatUrl, target: null }`.
- Otherwise `null`.
- `branch` or `target` empty: `null`.

### 2. `lib/contribute.js`, `pushToBranch`

- Require `pullRequestPage` from `./pullRequest`.
- The branch push's failure uses `op: 'branch'` instead of `op: 'push'` (line 169; `commitAndPush` keeps `'push'`).
- On success, before the reset: `const pullRequest = pullRequestPage({ url: repoUrl, branch, target: up.branch,
  pushOutput: push.stderr });` (`repoUrl`, not the `url` fallback text).
- Return `{ kind: 'pushedBranch', branch, remote, head: pushed, target: up.branch, pullRequest }` (`pullRequest` is
  `{ url, target }` or `null`).

### 3. `lib/remoteErrors.js`, `describeRemote`

New `op` value `'branch'`: the push of a new branch (Push to a branch). Exact texts (`B`, `D`, `url` as today):
- `pushRejected`:
  - `op === 'branch'`: message
    `` `the server refused the new branch ${B}${D}: a server rule on branch names, or on who may create branches. Try another branch name, or ask the repository's admins.` ``,
    actions `['pushToBranch', 'showLog']`.
  - otherwise: message
    `` `the server refused the push to ${B}${D}: a protected branch or a server rule. Open a pull request instead: your changes go to a new branch, and the hosting service's page to propose them opens.` ``,
    actions `['pullRequest', 'showLog']`.
- `denied`:
  - `op === 'push'`: message
    `` `you have no write access to ${url}${D}. Open a pull request if you may create branches, or ask for write access.` ``,
    actions `['pullRequest', 'showLog']`.
  - `op === 'branch'`: message
    `` `you have no write access to ${url}${D}: the server refused a new branch too. Ask for write access (pull requests from a fork are not supported).` ``,
    actions `['showLog']`.
  - otherwise (read): unchanged.
- Update the comment of `describeRemote` to list the `op` values: `'read'`, `'push'` (push to the followed branch),
  `'branch'` (push of a new branch).

### 4. `extension.js`

- `realUi`: add `openExternal: (url) => vscode.env.openExternal(url)` with a comment: the URL is passed as a string
  so that Cursor opens it exactly (a `Uri` is re-encoded with `encodeURI(uri.toString(true))`, which breaks an
  encoded `&`, `+` or `#`).
- `makeTestUi`: add `openExternal: make('openExternal', (args) => ({ record: { url: args[0] } }))`.
- `ACTIONS`: add
  ```js
  pullRequest: {
    label: 'Open a pull request',
    run: (d) => vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: d.key, openPullRequest: true }),
  },
  ```
  (keep `pushToBranch`: conflicts and a refused new branch still use it).
- A helper next to `reportContribution`:
  ```js
  // Opens the hosting service's new pull request page of a pushed branch (result.pullRequest of pushToBranch).
  function openPullRequest(result) {
    return ui.openExternal(result.pullRequest.url);
  }
  ```
- `reportContribution(result, nothingText, d, { openPullRequest = false } = {})`, `case 'pushedBranch'`:
  - `merge` (the two commands) as today; `mergeText = `git fetch ${remote} && git merge ${remote}/${branch}``.
  - `page = result.pullRequest`; when `page`, log `` `pull request page for ${result.branch}: ${page.url}` ``.
  - `into = page && page.target ? ` into ${page.target}` : ''`.
  - When `openPullRequest && page`: call `openPullRequest(result)` first, then show
    `` `Pushed your changes to branch ${branch} and opened the page to propose them as a pull request${into}. The managed clone is back on the team version.` ``
    with buttons `'Open pull request'`, `'Copy merge commands'`.
  - Else when `page`:
    `` `Pushed your changes to branch ${branch}. The managed clone is back on the team version. Open a pull request to have them reviewed and merged${into}, or merge it in your own clone: ${mergeText}` ``
    with buttons `'Open pull request'`, `'Copy merge commands'`.
  - Else (no page):
    `` `Pushed your changes to branch ${branch}. The managed clone is back on the team version. Open a pull request from it on the hosting service, or merge it in your own clone: ${mergeText}` ``
    with button `'Copy merge commands'`.
  - Choice `'Open pull request'` -> `openPullRequest(result)`; `'Copy merge commands'` -> clipboard as today.
- `pushToBranchCommand(arg)`: `const wantsPage = !!(arg && arg.openPullRequest);` and pass
  `{ openPullRequest: wantsPage }` to `reportContribution`. Input box prompt becomes
  `'Branch to push your changes to (then open a pull request from it, or merge it from your own clone)'`.
- Nothing else calls `reportContribution` with a `pushedBranch` result (`commitAndPushCommand` gets `pushed`).

## Impact

- `remoteResult` callers in `lib/sync.js` (`op: 'read'`): unchanged.
- `commitAndPush` (`op: 'push'`): its `pushRejected` and `denied` results now carry `pullRequest` instead of
  `pushToBranch`; `showRemoteError` maps ids through `ACTIONS`, so the new entry is needed (done above).
- The conflict notifications (`notifyAfterSync` `case 'conflict'`, `reportContribution` `case 'conflict'`) keep
  **Push to a branch**: unchanged; the push-to-branch message they lead to now offers the page.
- `teamPlugins.pushToBranch` from the tree or the palette gets a tree node or nothing as `arg`: `arg.openPullRequest`
  is undefined there, so the page opens only on the button.
- `package.json` `contributes`: no new command, setting or menu.

## Not handled

- Pull requests from a fork (a user with no write access at all): the message says to ask for write access.
  README troubleshooting row and `docs/development.md` known limits.
- A page for a branch pushed earlier (after the notification closed): its URL stays in the log. Known limits.
- Hosts other than the three when the server prints no URL (Bitbucket Server, Azure DevOps Server, Gitea without the
  message): no page, the message says to open the pull request on the hosting service. A printed page targets the
  server's default branch, not necessarily the branch the clone follows. Known limits.
- An SSH host alias (`github.com-work` in `~/.ssh/config`) is an unknown host: printed URL only. Known limits.
- The Azure DevOps page form is not confirmed by Microsoft's docs. `docs/development.md`.

## Tests

### `test/pullRequest.test.js` (new, `node:test`, `assert`)

`parseRemote`:
- `https://github.com/o/r.git` -> `{ host: 'github.com', path: 'o/r' }`
- `https://user:tok@GitHub.com/o/r/` -> `{ host: 'github.com', path: 'o/r' }`
- `git@github.com:o/r.git` -> `{ host: 'github.com', path: 'o/r' }`
- `ssh://git@gitlab.com:2222/g/sub/p.git` -> `{ host: 'gitlab.com', path: 'g/sub/p' }`
- `C:\repos\team.git`, `C:/repos/team.git`, `/srv/team.git`, `file:///srv/team.git`, `../team` -> `null`

`pullRequestPage` (target `main` unless said):
- `https://github.com/o/r.git`, branch `team-plugins/ann-20261126-1200` ->
  `{ url: 'https://github.com/o/r/compare/main...team-plugins/ann-20261126-1200?quick_pull=1', target: 'main' }`
- `git@github.com:o/r.git`, branch `fix#1+a&b`, target `release/2` ->
  `https://github.com/o/r/compare/release/2...fix%231%2Ba%26b?quick_pull=1`
- `https://github.com/o/r/extra.git` (3 segments), no push output -> `null`
- `https://gitlab.com/g/sub/p.git`, branch `team-plugins/x` ->
  `https://gitlab.com/g/sub/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=team-plugins%2Fx&merge_request%5Btarget_branch%5D=main`
- `git@gitlab.com:g/p.git`, branch `b` -> `https://gitlab.com/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=b&merge_request%5Btarget_branch%5D=main`
- `https://org@dev.azure.com/org/My%20Project/_git/repo`, branch `team-plugins/x` ->
  `https://dev.azure.com/org/My%20Project/_git/repo/pullrequestcreate?sourceRef=team-plugins%2Fx&targetRef=main`
- `git@ssh.dev.azure.com:v3/org/proj/repo`, branch `b` -> `https://dev.azure.com/org/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main`
- `org@vs-ssh.visualstudio.com:v3/org/proj/repo`, branch `b` -> `https://org.visualstudio.com/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main`
- `https://org.visualstudio.com/DefaultCollection/proj/_git/repo`, branch `b` ->
  `https://org.visualstudio.com/DefaultCollection/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main`
- `https://org.visualstudio.com/proj/_git/repo`, branch `b` -> `https://org.visualstudio.com/proj/_git/repo/pullrequestcreate?sourceRef=b&targetRef=main`
- Printed (GitHub Enterprise), url `git@ghe.example.test:o/r.git`, branch `team-plugins/x`, push output (with `\r\n` and
  the trailing padding of fact 5):
  `"Enumerating objects: 3, done.\r\nremote: \r\nremote: Create a pull request for 'team-plugins/x' on GitHub by visiting:        \r\nremote:      https://ghe.example.test/o/r/pull/new/team-plugins/x        \r\nremote: \r\nTo ghe.example.test:o/r.git\r\n * [new branch]      HEAD -> team-plugins/x"`
  -> `{ url: 'https://ghe.example.test/o/r/pull/new/team-plugins/x', target: null }`
- Printed (self-hosted GitLab, encoded branch), url `https://git.example.test/g/p.git`, branch `team-plugins/x`, output
  `"remote: To create a merge request for team-plugins/x, visit:\nremote:   https://git.example.test/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=team-plugins%2Fx\n"`
  -> that URL, `target: null`.
- Printed URL that doesn't name the branch is ignored: output `"remote: See https://status.example.test for incidents.\n"`
  -> `null`.
- A URL outside a `remote:` line is ignored: output `"To https://git.example.test/g/p.git\n"` -> `null`.
- Trailing punctuation stripped: `"remote: visit https://h.example.test/pr/new/b."`, branch `b` -> `https://h.example.test/pr/new/b`.
- A local path with a printed URL (the live scenario's case): url `C:/x/team.git`, branch `live/pr`, output
  `"remote:      https://git.example.test/team/plugins/pull/new/live/pr        "` -> that URL, `target: null`.
- Empty `branch` -> `null`.

### `test/remoteErrors.test.js`

- Update the existing `rejected` assertions (around line 111-119): message
  `'the server refused the push to main (GitLab: You are not allowed to push code to protected branches on this project.): a protected branch or a server rule. Open a pull request instead: your changes go to a new branch, and the hosting service\'s page to propose them opens.'`,
  actions `['pullRequest', 'showLog']`; `DENIED_403` with `op: 'push'` -> `['pullRequest', 'showLog']`.
- New: `GITLAB_REJECTED` with `{ url: 'git@h:o/r.git', branch: 'team-plugins/x', op: 'branch' }` -> message
  `'the server refused the new branch team-plugins/x (GitLab: You are not allowed to push code to protected branches on this project.): a server rule on branch names, or on who may create branches. Try another branch name, or ask the repository\'s admins.'`,
  actions `['pushToBranch', 'showLog']`.
- New: `DENIED_403` with `op: 'branch'` -> actions `['showLog']`, message starts with
  `'you have no write access to https://github.com/o/r.git'` and contains
  `': the server refused a new branch too. Ask for write access (pull requests from a fork are not supported).'`.

### `test/contribute.test.js`

- "commitAndPush reports a rejected push" (line 132): `r.actions.includes('pullRequest')`.
- "a push refused on main goes through Push to a branch" (line 148): the hook also prints, for other refs, a
  PR line to stderr (as fact 5):
  `'#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/main ]; then echo "protected branch" >&2; exit 1; fi\n  echo "     https://git.example.test/o/r/pull/new/${ref#refs/heads/}" >&2\ndone\nexit 0\n'`;
  then assert `b.target === 'main'` and
  `assert.deepEqual(b.pullRequest, { url: 'https://git.example.test/o/r/pull/new/team-plugins/x', target: null })`.
- New: "pushToBranch reports a refused new branch": hook that refuses every ref
  (`'#!/bin/sh\necho "branch names must start with feature/" >&2\nexit 1\n'`), a change in the clone,
  `pushToBranch({ ...f.args, branch: 'team-plugins/y', message: 'mine' })` -> `kind 'error'`, `step 'push'`,
  `reason 'pushRejected'`, `actions` deep-equal `['pushToBranch', 'showLog']`, message includes
  `'the server refused the new branch team-plugins/y'`.
- A `pushToBranch` to a local path without a printed URL (e.g. "pushToBranch gets out of a conflict", line 208): add
  `assert.equal(r.pullRequest, null)`.

### `test/remote.test.js`

- "http: a push denied by a read-only server" (line 271): actions `['pullRequest', 'showLog']`. Add in the same test:
  `pushToBranch({ ..., branch: 'live/y' })` -> `reason 'denied'`, actions `['showLog']`.

### `test/live/pull-request.live.js` (new scenario)

Setup: `const url = ctx.makeTestRepo(path.join(ctx.repos, 'team.git'));` then write `hooks/pre-receive` in the bare
repository (`url` is a forward-slash path of the bare repo; check `make-test-repo.js` for what it returns and use the
bare folder) with mode `0o755`:
```sh
#!/bin/sh
while read old new ref; do
  if [ "$ref" = refs/heads/main ]; then echo "error: main is protected" >&2; exit 1; fi
  b=${ref#refs/heads/}
  echo "Create a pull request for $b:" >&2
  echo "     https://git.example.test/team/plugins/pull/new/$b" >&2
done
exit 0
```
Settings as `contribute.live.js` (`teamPlugins.repositories: [url]`, `teamPlugins.enabled: ['team-test:review']`),
`data: { bare }`.

Run (follow `contribute.live.js` and `remote-errors.live.js` for the helpers):
1. Wait for `team-test:review` to be registered, `t.idle()`, key from `hook.states()`.
2. Append a line to `review/skills/code-review/SKILL.md` in the clone; wait for the `changes:<key>` node.
3. `hook.respond`: input box `/^Commit message for your changes to/` -> `'Live PR commit'`; error message matching
   `/the server refused the push to main/` -> `'Open a pull request'`; input box `/^Branch to push your changes to/`
   -> `'live/pr'`; anything else `undefined`. Run `teamPlugins.commitAndPush` with `{ repo: key }`.
4. Assert the error message (`t.messages('showErrorMessage')`) has buttons `['Open a pull request', 'Show log']` and
   contains `(error: main is protected)`.
5. Wait for an `openExternal` record (`t.messages('openExternal')`) with url
   `https://git.example.test/team/plugins/pull/new/live/pr`, then for the information message starting with
   `Pushed your changes to branch live/pr and opened the page to propose them as a pull request.` (no "into", printed
   page) with buttons `['Open pull request', 'Copy merge commands']`.
6. `git --git-dir <bare> log -1 --format=%s live/pr` -> `Live PR commit`; `main` unchanged (its subject is not
   `Live PR commit`); the Local changes node goes away; the log (`hook.logLines()`) has
   `pull request page for live/pr: https://git.example.test/team/plugins/pull/new/live/pr`.
7. Second path: append again to the skill, wait for the changes node; respond: branch input -> `'live/pr2'`, commit
   message -> `'Second'`, information message `/^Pushed your changes to branch live\/pr2\. /` -> `'Open pull request'`.
   Run `teamPlugins.pushToBranch` with `{ repo: key }`. Assert that message's text contains
   `Open a pull request to have them reviewed and merged, or merge it in your own clone:` and its buttons are
   `['Open pull request', 'Copy merge commands']`; wait for an `openExternal` record with url ending `/pull/new/live/pr2`.
8. `t.noSpinner()`.

## Keep in step

- `package.json`: `version` `0.8.2`.
- `AGENTS.md`: version `0.8.2` in the first line; Layout: add `pullRequest` (`parseRemote`, `pullRequestPage`: the
  hosting service's new pull request page of a pushed branch) to the `lib/` list (after `contribute`), and in the
  "Why the code is shaped this way" list one bullet: `vscode.env.openExternal` is given the URL as a string (a `Uri` is
  re-encoded by Cursor with `encodeURI(uri.toString(true))`, which decodes `%26`/`%2B`/`%23` of a branch name; a string
  is opened as is: read in the Cursor 3.32 bundles), through `ui.openExternal`.
- `README.md`:
  - The **Push to a branch** bullet (line 205): "**Push to a branch** pushes your changes to a new branch instead (for a
    protected branch, or to have them reviewed) and puts the clone back on the team version. Its message offers **Open
    pull request**, which opens the hosting service's page to propose the branch as a pull request (GitHub, GitLab and
    Azure DevOps; other servers when they print that page's address on the push)."
  - Troubleshooting row (line 328): `| The server refused the push | A protected branch or no write access: **Open a
    pull request** pushes your changes to a new branch and opens the page to propose them. With no write access at all,
    ask for it (pull requests from a fork are not supported). |`
- `docs/development.md`:
  - "How it works": after the bullet on several windows sharing one clone (line ~133), a bullet: Push to a branch
    returns the page from `pullRequest.pullRequestPage`: built from the repository URL for `github.com`
    (`compare/<target>...<branch>?quick_pull=1`), `gitlab.com` (`-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…`)
    and Azure DevOps (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`, `vs-ssh.visualstudio.com`:
    `…/_git/<repo>/pullrequestcreate?sourceRef=…&targetRef=…`), with the followed branch as the target; otherwise the
    first `remote:` URL of the push output that names the branch (GitHub Enterprise, self-hosted GitLab, Bitbucket
    Cloud and Azure DevOps Services print one); the URL is logged. A refused Commit and push offers **Open a pull
    request** (Push to a branch, then the page opens at once).
  - "Known limits (details)": the "Not handled" items above, including: "The Azure DevOps page form
    (`pullrequestcreate?sourceRef=&targetRef=`) is not confirmed by Microsoft's docs (2026-11-26): check it on a real
    Azure DevOps repository."
- `requests/` files: not yours to edit.

## Commands

From the repository root, Git Bash, no node on PATH:
```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js pull-request contribute remote-errors
```
(The live runner is pre-approved: isolated profile under the temp folder, nothing installed.)

Hand check: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" -e "console.log(require('./lib/pullRequest').pullRequestPage({url:'git@github.com:o/r.git',branch:'a/b',target:'main'}))"`.

## Don't

- No commit; don't edit `requests/13-pull-request.md` or this plan.
- No change outside the files listed here without reporting it.
- Never run `cursor --install-extension` or launch the user's own Cursor; only `scripts/live-test.js`.
- No dependency, no TypeScript, no bundler; nothing under `lib/` or `scripts/` requires `vscode`.
- Never call `vscode.window.*` dialogs or `vscode.env.openExternal` directly from feature code: through `ui`.
- Don't pass a `vscode.Uri` to `openExternal` (fact 1).
- Don't change the wording of messages other than those listed.

## Changes after review

- Version 0.8.2 instead of 0.9.0 (user's decision).
- `test/remoteErrors.test.js` "a push refused by a GitHub ruleset quotes the server, not the progress" also expects the
  new `pushRejected` text (the plan missed it).
