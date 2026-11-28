# cursor-team-plugins: developer notes

Cursor (VS Code) extension, version in `package.json` (0.8.7). Plain JavaScript, CommonJS, no npm dependency, no
build step. User documentation: `README.md` (for Cursor users: what it does, install, usage; it shows
only the current version, with no history). Internals, platform notes, detailed limits and the release process:
`docs/development.md`.

## Layout

- `extension.js`: the only file that requires `vscode` (activation, tree view, status bar, commands, timers,
  watchers). Not covered by the tests: check its syntax with the command below.
- `lib/`: pure logic, never requires `vscode`, tested with node: `catalog` (read one repository: `name`, `plugins`,
  `renamed` (the `renamed` record of `marketplace.json`), `mcpServerNames`, `filterMcpJson`, `frontmatterField`, `inside`;
  `problems` on the catalog, its plugins and its items (see `checks`); its plugins carry `customPaths`, the kinds
  `plugin.json` declares), `checks` (`splitFrontmatter`, `lintFrontmatter`, `checkItemText`, `conflictMarkerLine`,
  `parseJsonc`, `checkJsonText`, `skillKey`, `pushProblems`: problems Cursor would drop or misread, shown in the view, as
  diagnostics and before a push), `repos` (the list of repositories: `normalizeUrl`, `listRepos`
  (takes the `drafts` folder), `assignNames`, `mergeCatalogs`, `normalizeIds`, `followRenames`, `rememberNames`,
  `originUrl`, `migratedSettings`, `missingRepos`, `unlocatedRepos`, `projectRepoEntry`,
  `withProjectRepo`, `withoutProjectRepo`), `selection` (selection model, on the merged catalog), `treeModel` (`buildTree`,
  `buildChangesNode`, `buildConflictsNode`, `repoStatus`, `buildRepoNode`, `buildMissingNodes`, `itemDecoration`), `materialize`
  (`holderName`, `copyRootOf`, `syncCopy`, `markCopySynced`, `resolveConflict`, `conflictVersions`, `hashCache`, `caseInsensitive`: partial plugin copies kept
  in sync both ways), `git`, `sync` (managed clone: `syncManaged`, `localChanges`, `checkConflicts`, `gitVersionOf`, `parseStatusZ`,
  `discardLocalChanges`, `changedPaths`, `withLock`, `withLockSync`, `removeStaleIndexLock`, `removeLeftovers`, `recentlySynced`,
  `revFileArgs`, `checkRemote`), `updates` (`parseLsTree`, `parseLog`, `parseIdent`, `itemPath`, `pluginPath`, `updateItems`, `serverEntry`,
  `serverText`, `fingerprints`, `lastChanges`, `baselineRecord`, `computeMarks`, `markSeen`, `readSeen`, `writeSeen`,
  `noticeEntries`, `noticeText`, `noticeMessage`, `ago`, `shortDate`, `lastLine`, `readGitData`, `rangeHashes`,
  `treeFiles`: the update summary), `contribute` (`commitAndPush`, `pushToBranch`, `defaultBranchName`), `pullRequest` (`parseRemote`,
  `pullRequestPage`: the hosting service's new pull request page of a pushed branch), `cursorApi`,
  `registrar`, `remoteErrors` (`classify`, `remoteHost`, `describeRemote`, `remoteResult`: classified git failures with
  a message and the actions to offer), `authoring` (scaffolds and drafts: `nameError`, `serverNameError`, `yamlScalar`,
  `itemFile`, `createItem`, `splitCommandLine`, `mcpEntry`, `addMcpServer`, `topLevelNameError`, `pluginLocation`,
  `destinationError`, `pluginDirError`, `createPlugin`, `movePlugin`, `renameIds`, `declaredPathsError`, `clashError`), `jsonc` (`tokens`, `addMember`,
  `renameKey`: edits of JSONC files that keep comments and layout), `share` (`shareKind`, `shareableItem`, `projectItems`,
  `suggestName`, `shareNameError`, `shareItem`, `renameSkillName`: copying a project item into a plugin), `rename`
  (`renamePlugin`, `renameItem`, `recordRename`: renaming a plugin or an item and recording it in `marketplace.json`),
  `gitCheck` (`checkGit`, `gitCheckMessage`: the Check git command's check and message), `context` (`itemContext`,
  `splitGlobs`, `formatTokens`, `costOf`, `costLines`, `selectionCost`, `statusLines`, `viewDescription`, `itemLine`: the
  context cost estimate). `git` also has `cleanProgress`.
- `scripts/`: `test.js` (test runner), `zip.js` + `package.js` (VSIX writer), `make-test-repo.js` (bare test team
  repository for live tests, from `test/fixtures/team-repo`; `--name` gives a copy another repository name),
  `live-test.js` (isolated-Cursor scenario runner, one launch per scenario, root `%TEMP%\tp-live`), `live_check.py`
  (hand live tests in the user's Cursor: logs since an install or reload, installed files against the working tree,
  install, settings backup and restore; local or over SSH; `test`: the suite here and on a Linux host at once, before
  a merge; stdlib Python, not packaged), `make_icon.py` (regenerates `resources/icon.png`: three stacked package boxes on a blue rounded square, drawn from no source image: `uv run --with pillow python scripts/make_icon.py`; not packaged). Nothing under `lib/` or `scripts/`
  may require `vscode`.
- `test/`: one test file per module (`*.test.js`, `node:test`), `helpers.js` for fixtures. Tests use only local bare
  git repositories, no network. `fixtures/team-repo/` is the test team repository (plugins `review`: skills
  `code-review`, `security-check`, rule `style.mdc`, command `review-pr`, agent `reviewer` and `mcp.json` with servers
  `lint` and `tickets`; `docs`: skill `write-readme`, with a folded description);
  `make-test-repo.test.js` checks its catalog, so change the two together. `remote.test.js` with `remote-helpers.js`
  and `fake-ssh.js` runs the remote cases against a fake ssh and a `git http-backend` server, with git isolated from the
  user's config. `live/` (`runner.js`, the scenarios `*.live.js`) needs Cursor's extension host and is not run by
  `scripts/test.js`. `manual-remote-checks.md` is the short hand checklist for what these can't cover (the real ssh and
  credential manager, a protected branch on a real server).
- `biome.json`: read-only JavaScript correctness checks for `extension.js`, `lib/`, `scripts/` and `test/`.
- `.githooks/pre-commit`: Python, the same Biome lint as CI before each commit (LF line endings: `.gitattributes`).
- `.claude/settings.json` and `.claude/hooks/lint.py`: Claude Code `Stop` and `SubagentStop` hooks that run the
  pre-commit hook, so an agent fixes the lint before it finishes (not `PostToolUse`: half-written code would be flagged).
- `.github/workflows/checks.yml`: runs tests on Ubuntu and Windows and lint on Ubuntu on all branch pushes and when
  called by the release workflow.
- `.github/workflows/release.yml`: on a `v*` tag, requires the shared checks to pass, checks the tag against
  `package.json`, builds the VSIX, makes a GitHub release and publishes to Open VSX when the `OVSX_PAT` secret is set
  (`curl` to `https://open-vsx.org/api/-/publish?token=`).
- `requests/`: requests being worked on (`NN-<name>.md`) with their plans (`NN-<name>.plan.md`), finished ones in
  `done/`, ideas not picked yet in `ideas.md` (the `/implement` skill's layout; not packaged).

## Commands

The pre-commit hook (`.githooks/pre-commit`, enabled once per clone with `git config core.hooksPath .githooks`) and
CI run `biome lint --error-on-warnings extension.js lib scripts test` with standalone Biome 2.6.9 on `PATH` (see
`docs/development.md`): a warning fails it.

Node 24 is on `PATH` (24.22.1, the version inside Cursor 3.31's runtime; CI uses 24). From the repository root:

```
node --check extension.js
node scripts/test.js
node scripts/package.js
node scripts/make-test-repo.js <target.git> [--name <marketplace name>]
node scripts/live-test.js [scenario ...]
```

`live-test.js` runs the scenarios of `test/live/` in an isolated Cursor instance.

The VSIX is written to `dist/cursor-team-plugins-<version>.vsix`. The runner passes explicit test files to
`--test`: with Cursor's runtime (a Cursor server's node) a directory argument fails.

Branches: work on a branch (`request/<NN>-<name>` for a numbered request, `fix/<name>` for anything else), never
directly on `main`. Everything a change needs is written on its branch and lands in its commit: the request, its plan,
the `ideas.md` entry it takes, and the lines of the docs, `AGENTS.md` and `.claude/implement.md` it changes. A branch
holds one commit when it is merged: fold follow-up fixes and doc edits into it (`git commit --amend`, or
`git reset --soft <base>` and commit again) while the branch is unpushed. Exception: a change with no code that
belongs to no feature (a review, a batch of new requests, an idea, a project rule) is one commit directly on `main`.
Never rewrite a pushed commit.
When it is ready, merge it into `main` locally (`git merge --no-ff`): one maintainer, so no pull request.
Before the merge, the suite passes on Windows and on Linux: `python scripts/live_check.py test --host <ssh host>` runs
it on this machine and on a Linux host at once, on the working tree, and fails if either run fails; the lint runs in
the pre-commit hook. The branch is not pushed: CI on `main` only confirms. When CI fails where both runs passed, find
out why the environments differ before changing anything on `main`.
Get the user's explicit approval before any push, including a release push. Delete the branch after the push succeeds.

Release (from `main`, after the merge): bump `version`, commit, `git tag v<version>`, `git push origin main v<version>`.
The release workflow runs on the tag, so a tag is only ever made on `main`.

On a Linux machine with a Cursor server (a Remote-SSH host), the suite runs with the server's node:
`~/.cursor-server/bin/linux-x64/<commit>/node scripts/test.js` (`live_check.py test` sends the working tree with LF
line endings, as CI checks it out, and uses the newest server's node, else `node` on `PATH`).

## Why the code is shaped this way (Cursor 3.31)

- `vscode.cursor.plugins` has only `addPlugin` and `removePlugin`, both taking `{ path }` (a plain string makes
  `removePlugin` throw); `registerPath` of Cursor's docs does not exist. One call registers one plugin root, named
  after its **folder** (not `plugin.json`'s `name`): filtered copies keep the plugin's folder name
  (`filtered/<name>-<hash>/<folder>`; the hash is of the plugin name and the selection only, so the path survives
  file changes and an agent editing the copy keeps writing to a registered folder).
- Cursor watches registered plugin folders: a `git pull` or an edit inside one needs no re-registration.
- Registrations are per window and not persisted: register at every activation, which also makes the per-project
  selection per window.
- A `SKILL.md` is a skill only below a `.cursor/plugins` path: the managed clone and the filtered copies live under
  the extension's global storage in `.cursor/plugins`.
- Cursor reads a plugin's MCP servers from `.mcp.json` then `mcp.json` (first file wins per name; `plugin.json`'s
  `mcpServers` overrides) and drops a server as soon as it leaves the registered folder's file (probe, Cursor 3.31): a
  partial copy holds a generated MCP file without the servers left out; it only goes repository -> copy (`syncCopy`'s
  filtered branch); a kind whose paths `plugin.json` declares is not selectable (Cursor reads those paths instead of
  the default folder).
- Other `vscode.cursor.*` functions throw for a non-built-in extension: use nothing but `plugins`.
- The exit code of `git rebase --autostash` can't be trusted (a stash that conflicts when re-applied exits 0, with
  conflict markers left in the files): `sync.checkConflicts` runs first.
- Push to a branch cleans up with `git reset --keep @{u}`, not `reset --hard` + `clean`: editors and agents write to the
  clone during the push; `--keep` keeps those edits and refuses, touching nothing, when one is on a file of the pushed
  commit (probe, 2026-11-28).
- `git merge-tree --write-tree --name-only @{u} <git stash create>` finds the real conflicts (committed or not)
  without touching the clone: exit 1 lists the files; `stash create` skips untracked files, which are compared with
  `diff --name-only HEAD...@{u}`.
- `git.js` trims stdout: calls that parse `status -z` or read `git show` content need `{ trim: false }` (the trim drops
  the first status column and the last newline).
- `syncCopy` decides by content, not mtimes (Cursor's runtime on Windows keeps the source's mtime on copy, and mtimes
  can't tell which side changed when both did): `.team-plugins-sync.json` v2 holds each file's sha1 at the last sync (`""` =
  unknown, after a lost or old-format record) and the files in conflict. A file changed on both sides is a conflict and
  neither side is touched until the user picks one (`resolveConflict`).
- `listFiles` reports folders it can't list (`unreadable`, any error, `rel ''` for the start folder): `syncCopy` and
  `markCopySynced` never decide anything below one (an incomplete listing read as 'deleted' would delete the other side).
- On Windows `fs.renameSync` over a file another process has open fails with EPERM: `writeManifest` retries, and a lost
  manifest write is harmless (files already equal on both sides are settled by content).
- `syncLocked` switches the managed clone (URL or branch change) only after git confirmed it: a failed git command
  (missing binary, wrong `git.path`) has empty stdout, like a clean `status`. In the extension a URL change is another
  repository (the key hashes the URL), so only a branch change switches a clone.
- `localChanges` throws when `git status` fails (a failure must never read as "no changes"): the view shows a
  `changes.error` node and the commands report it.
- Windows git (`core.ignorecase`) ignores a case-only rename and NTFS resolves any spelling: `syncCopy` compares paths by
  `toLowerCase` when a side is case-insensitive and carries a spelling with a rename through an intermediate name (a
  direct `a` -> `A` rename is unreliable on Windows). Case sensitivity is per folder on Windows (`fsutil file
  setCaseSensitiveInfo`): `caseInsensitive` probes a name inside the folder (swapping the folder's own name tests its
  parent), and the record's `foldCase` keeps Discard and conflict resolution comparing as the sync did.
- Windows refuses to delete or rename the parent of a registered plugin folder (EPERM, in every window that
  registered it); the registered folder itself can be deleted, but while a window has it registered it is only "delete
  pending" (still listed by `readdir`, `lstat` fails with EPERM, gone at that window's reload): unregister it first
  (`Registrar.remove`, as **Move to a repository** does). So a URL or branch change switches the managed clone
  in place (`switchInPlace`: fetch the branch into `refs/team-plugins/switch`, `checkout -B`, then `set-url`, the
  upstream and the other branches; the URL changes last so a failed step is retried), never deletes it.
- An entry of `teamPlugins.repositories` without a branch is resolved at each sync with
  `git ls-remote --symref <url> HEAD` (`origin/HEAD` is only the default at clone time).
- Every operation that changes a managed clone holds that repository's lock file (`locks/<key>.lock`): `withLock`
  (sync, commit and push, push to a branch, discard; the lock's mtime is refreshed every minute, so a 30-minute clone
  is never taken for a stale lock) and `withLockSync` (partial-copy syncs, conflict resolution; in every mode, local mode included: windows with the
  same selection share a copy). Within a window they also go through the operation queue (`enqueue`).
- `acquireLock` never deletes a lock that vanished between `open` and `stat` (it may be another window's fresh one): it
  tries again; only a lock older than 10 minutes is removed.
- The README is the extension's details page, which opens only `http`, `https` and `mailto` links (`command` only for
  built-in extensions): a relative link to a file does nothing, so the README names files in plain text
  (`package.test.js` checks it).
- Links (symlinks, junctions) in a plugin: `listFiles` follows them only inside the repository; a junction reads as
  `isSymbolicLink()`, never `isDirectory()`.
- `fs.rmSync` fails with EPERM on git's read-only files with Cursor's runtime on Windows: use `sync.removeTree`.
- Partial-copy hashes are cached per window (`hashCache`, by full path): the key holds size, mtime, ctime, birthtime and
  ino because a copy keeps the source's mtime and ctime on Windows; a file changed less than 2 s ago is never cached
  (two writes in one clock tick share their timestamps); the module's own writes and deletions drop their entry.
- A path of the copy under a skill or rule left out of the selection never reaches the clone: deleted from the copy when
  unchanged since the last sync, otherwise left there and reported.
- Two plugins registered with the same folder name both load, and both are named after that folder (Cursor 3.31.15,
  probe with two extension plugins `a/same` and `b/same`): so `mergeCatalogs` gives a plugin whose folder name is taken
  the folder `<folder>-<repository>` (`plugin.folder`), and `desiredRegistrations` always registers it from a copy
  (`copyRootOf`/`syncCopy` use `plugin.folder`).
- Every repository has its own storage, lock and state: `.cursor/plugins/repos/<base>-<sha1:8>` (the key is a hash of
  `normalizeUrl`, so `https://h/o/a.git` and `git@h:o/a` are one repository), `locks/<key>.lock`, `state/<key>.json`;
  the 0.4 clone `.cursor/plugins/repo` keeps the key `repo` while its origin URL (`originUrl` of `.git/config`, where
  git doubles the backslashes of a Windows path) equals the entry's. Local repositories have a lock too.
- Ids are `<repository>:<id>` through the merged catalog (the repository name is the `name` of `marketplace.json`, else
  the last part of the URL; of two repositories with one name the first, locals first, loads). `normalizeIds` reads a
  0.4 id as `<repository>:<id>`: the user's lists are rewritten in `doApply`, a project's lists never by themselves.
- `doRefresh` syncs the repositories in parallel and runs `doApply` after each one; while a repository is syncing
  (`repoStates` `syncing`), `doApply` keeps the catalog read before that sync (its folder is changing under git) and
  skips its local changes.
- Tree ids are `repo:<key>`, `plugin:<repo>:<plugin>` and `item:<repo>:<id>`, `changes:<key>`, `conflicts:<key>`,
  `missing:<normalized url>` (a plugin named `changes` would collide with a built-in node); the selection id is the
  node's `key`.
- Tree checkboxes have only two states (no mixed state in Cursor 3.31): a partial plugin is unticked and shows a
  `pie-chart` icon. Project items are coloured through a `FileDecorationProvider` on a `team-plugins:/<key>`
  `resourceUri` (the label's colour can't be set any other way); unticking an item removes it from the project lists
  too (`removeFromProjectCommand`). A selected row in the focused view shows no colour (Cursor's
  `.monaco-list:focus .selected .monaco-icon-label { color: inherit !important }`; details in `docs/development.md`):
  not a refresh bug.
- `merge-tree --write-tree` needs git 2.38: `checkConflicts` checks `git version` first.
- git runs non-interactive: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never` (GCM 2.6 then fails with "Cannot prompt
  because user interactivity has been disabled" instead of opening a window), stdin closed.
- SSH keys with a passphrase are not supported (checked by hand): an agent started in a terminal sets `SSH_AUTH_SOCK`
  only there, so Cursor's git never sees it; only Windows' agent service with `core.sshCommand` set to Windows'
  OpenSSH would work.
- Git's bundled ssh fails fast without a console (unknown host: `Host key verification failed.`; passphrase without
  agent: `Permission denied (publickey).`); Windows' own OpenSSH and plink wait silently: network commands have no total
  limit but stop after 2 minutes without output (`--progress` keeps a transfer talking), and the stop kills the process
  tree (`taskkill /T /F`: killing git alone leaves ssh running).
- `vscode.env.openExternal` is given the URL as a string, through `ui.openExternal`: Cursor re-encodes a `Uri` with
  `encodeURI(uri.toString(true))`, which decodes the `%26`/`%2B`/`%23` of a branch name; a string is opened as is (read
  in the Cursor 3.32 bundles; checked by hand: `source=team-plugins%2Fa%2Bb%26c` reached the browser unchanged).
- A deleted upstream branch: `fetch --prune` succeeds, then `HEAD...@{u}` fails with "no such branch": check
  `refs/remotes/origin/<branch>`.
- `offline` (server unreachable) is quiet when a clone exists, never counts as a sync for `recentlySynced`, retried after
  5 minutes.
- Timed syncs leave out each repository whose `state/<key>.json` records another window's sync younger than half the
  interval (`recentlySynced`); every window touches its registered copies every hour so another window's 7-day
  cleanup never removes them.
- In a Remote-SSH window the agent host and its plugin registry run in the remote extension host: the extension is
  `extensionKind: ["workspace"]` and must be installed on the remote. From the UI side `addPlugin` reaches the remote
  agent host with a local path and fails (ENOENT). On the remote, `globalStorageUri` is under
  `~/.cursor-server/data/User/globalStorage`, and watchers outside the workspace work.
- In a remote window `application`-scope settings come from (and are written to) the local user settings,
  `machine`-scope ones from the remote settings: `localRepositories` is `machine` (paths), the rest `application`
  (`repositories` included); `git.path` is `machine`.
- git runs through `spawn`, not `execFile` (which ignores `detached`): on Linux/macOS git gets its own process group
  and a stop kills the group; killing git alone leaves `git-remote-http`/`ssh` holding the stderr pipe and the command
  never ends.
- On a Linux remote (Cursor 3.31 server) a recursive `createFileSystemWatcher` outside the workspace watches a new folder
  but not the subfolders it already holds when it appears (`mkdir -p a/b`: files in `b` are never reported; a partial
  copy is built aside and renamed into place, so none of it was watched). `watchTree` restarts the watcher on every new
  folder (outside `.git`); a restarted watcher covers the whole tree as it is then.
- Linux git says `repository '<path>' does not exist` for a missing local path (Windows git: `does not appear to be a
  git repository`).
- Cursor's extension gallery (`marketplace.cursorapi.com`) mirrors Open VSX live: publishing there is how the extension
  auto-updates (local and remote). The Open VSX namespace must equal `publisher` (`mathieugun`).
- A VSIX install is pinned (`installGivenVersion`): Cursor never auto-updates it.
- The publisher was `mg` up to 0.4.0: while `mg.cursor-team-plugins` is installed, `activate` stops right after
  creating the output channel and offers to uninstall it (`workbench.extensions.uninstallExtension`). Both declare the
  same command ids, so whichever activates second throws `command 'teamPlugins.syncNow' already exists` (seen on a
  Remote-SSH host, where the old one activated first). The extensions view's search matches names and descriptions,
  so `@installed mg.cursor-team-plugins` finds nothing.
- Drafts (`<storage>/.cursor/plugins/drafts`, under `.cursor/plugins` so its skills are skills) are a repository of
  `kind: 'drafts'` listed first when the folder exists, which never counts as a configured repository (`unconfigured`
  state, status text); the folder is never deleted (it is the parent of registered
  plugin folders, which Windows can't delete or rename); authoring writes go to the repository's folder under its lock,
  never to a partial copy (the copy follows through `syncCopy`).
- A registered plugin folder (and the items inside it) can be renamed in place with `fs.renameSync` (probe, Cursor
  3.32.4), but **Rename** unregisters the plugin first like Move does. `"renamed"` in `marketplace.json` is safe in a
  repository also imported as a Cursor marketplace: Cursor's schema ignores unknown keys. An id that exists in the
  catalog is never redirected (`followRenames`). Repository names are remembered in `<storage>/repo-names.json`, outside
  `state/` (watched: a write there applies in every window).
- A plugin folder built from repository data (`metadata.pluginRoot`, a rename) is checked with
  `authoring.pluginDirError` before any write; a plugin whose folder is the repository root or the `pluginRoot` folder
  is never renamed (it would move the clone or every plugin).
- An Explorer context command gets `(clickedUri, selectedUris)` and its `when` is evaluated on the clicked item only;
  `resourcePath` is `fsPath` for `file:` (backslashes on Windows), `uri.path` otherwise: `share.shareKind` and the
  menu's regexes must match (`share.test.js` checks it).
- A Remote-SSH window's file system has no trash (`workspace.fs.delete` with `useTrash` fails: "provider does not
  support it"): `removeOriginals` deletes for good there, only after a modal confirmation (`vscode.env.remoteName`).
- Every dialog goes through `ui`. A test runner gets its own `vscode` object, so it can't patch the extension's
  `vscode.window` (probe, Cursor 3.31). In Test mode (`context.extensionMode`, only under `--extensionTestsPath`) `ui`
  is a recorder that never blocks, and `activate` returns the test hook. Outside Test mode it returns nothing.
- The isolated instance exits 0 even when the runner fails, so the result is a file. Settings written during a run
  persist in the profile, so the script rewrites them.
- In `remote.test.js` the HTTP server runs in the test process, so a synchronous git against it deadlocks.
- Walkthrough steps tick only from a change after Cursor registered the walkthrough (it puts an already-matching
  `onContext` in `sessionEvents` and never progresses it): `teamPlugins.gitReady` is set only by Check git, never at
  activation, and the other steps tick on `onSettingChanged`. `onCommand` of an extension's own command fires only
  through the workbench, so it is not used. Right after startup `Get started` opens the generic Welcome page until
  Cursor has registered the walkthrough (a few seconds).
- What the user has seen is `<storage>/seen/<key>.json` (outside `state/`, watched: marking an item seen applies in
  every window); marks compare fingerprints at HEAD (tree or blob ids, an MCP server's entry hash), so uncommitted
  edits never mark; the user's own changes (author email = `git var GIT_AUTHOR_IDENT`, which honours the
  environment unlike `git config user.email`) are recorded, not marked.
- `vscode.changes` takes `[label, left, right]` and both sides are required (an absent side is a
  `team-plugins-git:` URI with an empty rev); a `FileDecoration` badge is at most 2 characters (`PN`, `PM`).
- Cursor drops a skill, rule, command or agent whose frontmatter gray-matter can't parse, silently (no log line), and
  keeps one with no frontmatter or no description (an agent with an empty body is dropped too). Our own YAML checker
  (`lintFrontmatter`) is calibrated against gray-matter 4.0.3 / js-yaml 3 (tabs are not flagged, `yes` is a string) and
  must never flag valid YAML: when in doubt it says nothing.
- `plugin.json` and `marketplace.json` are strict JSON in Cursor (a BOM makes it ignore them); `mcp.json` is JSONC
  (comments, trailing commas): `parseJsonc` reads it, `checkJsonText` reports what Cursor would ignore.
- Add MCP server and Rename edit `mcp.json` as text (`lib/jsonc.js`), not `JSON.stringify` of the parsed object: a
  rewrite would drop the comments Cursor accepts there.
- The agent's `ReadLints` tool reads an extension's diagnostics of any file by absolute path (code reading, not seen
  live yet; only errors and warnings;
  markers older than an open document's version are dropped): `updateDiagnostics` runs at every apply, sets the
  collection again when the problems or an open document's version changed, and mirrors them on the partial-copy file,
  which is the path the agent edits.
- The update notification is shown by `refreshUpdates` (after the apply that follows the sync), not by
  `notifyAfterSync`: it needs the marks.
- A rule's type is decided in Cursor's agent host in the order `alwaysApply` (boolean `true`) > `globs` > `description` >
  manual, skills too (an `alwaysApply` skill is a whole-text rule), and descriptions are cut at 1536 characters; the
  prompt is built server side, so the context cost (`lib/context.js`) is an estimate.

## Rules

- Treat pasted reviews and findings as context. Wait for the user to request changes before acting on them.
- If testing, CI, or other work uncovers a bug outside the requested scope, report it and get the user's explicit
  approval before fixing it. This applies even when the bug blocks verification.
- Never run `cursor --install-extension` or launch the user's own Cursor from an agent unless the user asks;
  `scripts/live-test.js` (isolated profile under the temp folder, nothing installed) may be run without asking.
- Don't add dependencies, TypeScript or a bundler.
- Keep README (user documentation) in step with settings, commands and behaviour; implementation details, platform
  quirks and limits that only matter to developers go to `docs/development.md`, not the README.
