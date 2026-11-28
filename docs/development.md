# Team plugins: development notes

Notes for people working on the extension: how it works inside, platform details and known limits that the README
leaves out. The code-level reasons ("why the code is shaped this way") and the test commands are in `AGENTS.md`.

## Building and releasing

- Build the VSIX: `node scripts/package.js` (writes `dist/cursor-team-plugins-<version>.vsix`; see `AGENTS.md` for
  running it with Cursor's runtime when node is not installed).
- Changes are made on a branch and merged into `main` when ready (see `AGENTS.md`). Release from `main`: bump
  `version` in `package.json`, commit, then push a tag `v<version>` (`git tag v<version>`,
  `git push origin main v<version>`). `.github/workflows/release.yml` requires the shared tests and lint to pass before
  it validates the tag and builds the VSIX. It attaches the VSIX to a GitHub release and publishes it to Open VSX,
  which Cursor's marketplace mirrors (a new extension appeared there about 7 minutes after Open VSX listed it;
  new versions of existing extensions show up at once).
- Open VSX setup (done once): an open-vsx.org account signed in with GitHub, linked to an Eclipse Foundation account
  with the publisher agreement accepted; the namespace `mathieugun` (equal to `publisher` in `package.json`); an access
  token stored as the repository secret `OVSX_PAT`. Without the secret the workflow only makes the GitHub release.
- The README is the extension's details page in Cursor and on Open VSX: a change reaches users with the next release.

## JavaScript lint

- Download standalone Biome 2.6.9. Use `biome-win32-x64.exe` on Windows x64 or `biome-linux-x64` on Linux x64.
  On another supported architecture, choose the matching asset. Rename it to `biome.exe` on Windows or `biome` on
  Linux. On Linux, run `chmod +x biome` in the directory containing the binary. Put that directory on `PATH` and
  check the version with `biome --version`. [Biome 2.6.9 release](https://github.com/biomejs/biome/releases/tag/%40biomejs%2Fbiome%402.6.9)
- Run `biome lint extension.js lib scripts test` from the repository root. This read-only check uses Biome's
  recommended correctness rules, with undeclared variables and unused bindings treated as errors. Warnings,
  including unused function parameters, are advisory.
- `.github/workflows/checks.yml` runs the same lint command on Ubuntu on every branch push and release tag. CI
  verifies the Linux binary's SHA-256 before running it. Lint still runs after a test failure unless the job is
  cancelled.

## Tests

- **Unit tests** (`scripts/test.js`, `test/*.test.js`): one file per module, `node:test`, only local bare git
  repositories, no network. CI runs them on Ubuntu and Windows with Node 22 on branch pushes and `v*` release tags.
- **`test/remote.test.js`** stands in for a real server, with real git: a fake ssh script (`test/fake-ssh.js`, set
  through `core.sshCommand`; it prints the real ssh messages for an unknown or changed host key and a refused login, or
  stays silent) and a node `http` server that runs `git http-backend` behind basic auth (`test/remote-helpers.js`). It
  covers the classified failures, the idle limit (`idleMs`, shortened to 1.5 s) and the process tree kill, a missing or
  refused credential, a wrong URL or branch, an offline server (`127.0.0.1:1`), a valid clone and update, and a push
  refused by a hook or by a read-only server. git is isolated from the user's configuration through environment
  variables (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, `HOME`), so Git Credential Manager and `known_hosts` are never
  used. The server runs in the test process: a synchronous git against it would deadlock, use only `makeGit`.
- **`scripts/live-test.js`** runs scenarios in an isolated Cursor instance (own profile and extensions folder, nothing
  installed, the user's profile untouched). A scenario is `test/live/<name>.live.js`, exporting `{ timeoutSec?,
  setup(ctx), run(t) }`: `setup` runs in the script's process (it builds repositories with `ctx.makeTestRepo` and
  returns the `settings` written to the profile, optional `workspaceSettings`, `env` and `data`) and `run` runs in
  Cursor's extension host, where `test/live/runner.js` gives it `t` (`vscode`, `assert`, `hook`, `data`, `step`,
  `waitFor`, `idle`, `find`, `git`, `messages`, `noSpinner`, and the readers of Cursor's own logs: `pluginsLog`,
  `mcpLogs`). The window closes when the runner finishes, and Cursor exits with code 0 even when it fails, so the
  runner writes `out/<scenario>/result.json`.
  - Root: `%TEMP%\tp-live` (short: under a long path git hits MAX_PATH). `ud` and `ext` (profile), `repos` and `ws` (the
    workspace folder, always the same path) are wiped before each scenario; `out/<scenario>/` holds `result.json`,
    `cursor.log`, `data.json` and, on failure, `logs/` (Cursor's newest session). `out/` is wiped at each start.
  - Outside the temp folder it writes only `~/.cursor/projects/<slug of %TEMP%\tp-live\ws>` (Cursor makes it for any
    workspace; leave it).
  - Usage: `scripts/live-test.js [scenario ...] [--timeout <seconds>]`; Cursor is `CURSOR_EXE`, else the runtime that
    runs the script, else the default Windows install.
  - To add a scenario: create `test/live/<name>.live.js` (it must not `require('vscode')`; `run` gets it as `t.vscode`).
    Answer dialogs with `t.hook.respond(fn)` and read what was shown with `t.messages(kind)`: use **Sync now**
    (`teamPlugins.syncNow`) to get an error message reliably (a sync that isn't user-initiated shows it once, and the
    check after a settings change only when the window has focus).
  - The hook (`activate`'s return value in Test mode only): `calls`, `clearCalls`, `respond` (the scripted answers of
    the recorder that replaces `ui`), `idle` (nothing in flight for 300 ms), `tree` (labels, descriptions, tooltips,
    icons, checkbox states), `check` (ticks or unticks a node like a click), `registrations`, `diagnostics` (the
    problems published to the Problems panel, by path), `decoration`, `badge` (the
    number on the view's icon), `updates` (a repository's counts, marks and removed items), `states` (per repository),
    `status` (status bar), `logLines`, `gitCheck` (the result of the last **Check git**), `storage` and `logUri`.
  - Scenario `walkthrough`: **Get started** opens the walkthrough tab (`Walkthrough: Team plugins`, run again until it
    shows: Cursor registers the walkthrough a few seconds after startup, and before that the command opens the generic
    Welcome tab), then **Check git** with the machine's git and with a `git.path` that doesn't exist. Step completion
    can't be tested live: with `--extensionTestsPath` Cursor keeps its storage in memory, so a scenario can't read
    the walkthrough's progress.
- **By hand** (`test/manual-remote-checks.md`): what needs a real server or the real ssh and credential manager, and
  the look of the view (icons, colours). `python scripts/live_check.py` helps there: `install` (package and install
  in the Cursor you use, or with `--host` on a Remote-SSH host), `status --since install` (installed files against
  the working tree, the Team Plugins log and Cursor's plugin registrations since the install, across reloads) and
  `settings backup|diff|restore <dir>` around a test that changes `teamPlugins.*` settings.

## How it works

- Every repository of `teamPlugins.repositories` has a managed clone in the extension's global storage, in
  `.cursor/plugins/repos/<key>` where the key is `<base>-<sha1:8>` (`<base>`: the last part of the URL, characters other
  than letters, digits, `.`, `_` and `-` replaced by `_`, at most 40; `<sha1:8>`: the first 8 hex digits of the SHA-1 of
  the normalised URL). The `.cursor/plugins` part of the path matters: Cursor lists a `SKILL.md` as a skill only below
  such a folder. The clone of 0.4 (`.cursor/plugins/repo`, key `repo`) is reused by the entry whose normalised URL
  equals the `origin` URL in its `.git/config` (git writes a Windows path there with doubled backslashes).
- URLs are compared after normalisation (`lib/repos.js` `normalizeUrl`): scheme, user, port and a final `.git` are
  dropped and the host is lower-cased, so `https://h/org/a.git` and `git@h:org/a` are one repository; a local path
  becomes `file:<resolved path>` (lower-cased on Windows). Two entries with the same normalised URL are one repository
  (the later one is `listed twice`, key `dup-<index>`, never cloned).
- Each repository has its own lock (`locks/<key>.lock`) and its own state file (`state/<key>.json`), so repositories
  sync in parallel and a long clone of one never blocks another. Local repositories have a lock too (the partial copies
  of their plugins are synced under it).
- The names: a repository is named by the `name` of its `marketplace.json`, else the last part of its URL. The catalogs
  of the repositories that are loaded are merged (`mergeCatalogs`) into one: a plugin is `<repository>:<plugin>`, its
  items `<repository>:<plugin>/skills/<folder>`, `/rules/<file>`, `/commands/<file>`, `/agents/<file>` and
  `/mcp/<server>`, so the selection code works on the merged catalog unchanged (a new kind is just more children). Of
  two repositories with the same name the first loads (locals come first, then the list's order) and the other is `hiddenBy` it. A 0.4 id (no `:`) is resolved to the first plugin that
  matches (`normalizeIds`): the user's lists are rewritten at the next apply, the project's lists only when the user
  adds or removes an item (a committed file is never rewritten by itself).
- For each selected plugin the extension calls `vscode.cursor.plugins.addPlugin({ path })` in every window, at startup
  and whenever the selection or a repository changes. Cursor does not persist these registrations.
- Cursor keys registrations by path but names a plugin after its folder (measured on Cursor 3.31.15: two plugins in
  folders of the same name, `a/same` and `b/same`, both load and both are named `same` for the agent). So no two
  registered plugins may have the same folder name: when a plugin's folder name is taken (compared without case) by an
  earlier plugin of the merged catalog, it gets the folder `<folder>-<repository>` (then `-2`, `-3`...) and is always
  registered from a partial copy under that name, even when fully selected.
- A fully selected plugin is registered from the clone itself, so Cursor sees `git pull` changes directly. A partial
  plugin is registered from a partial copy (`.cursor/plugins/filtered/<name>-<hash>/<plugin folder>`: the folder is
  named by the plugin and the selection, and Cursor names an extension plugin after its folder, so the copy keeps the
  same name) that holds only the selected items. The name hashed is `<repository>:<plugin>`, so the copies
  of 0.4 are built again under new holders once, at the upgrade.
- Syncs run in parallel, one per repository; an apply (catalog, partial copies, registrations) follows each one as soon
  as it ends, and applies never overlap. While a repository is syncing, applies keep using the catalog read before its
  sync (its folder is changing under git), and its local changes are not read.
- The copy and the clone are kept in sync both ways, with a `.team-plugins-sync.json` record next to the copy (the
  content hash of each file at the last sync): a change on one side only, new files and deletions included, is carried
  to the other side; a file changed on both sides is a conflict that waits for the user's choice. A sync reads a file
  again only when its size or timestamps changed. A copy sync that meets a locked file is retried every 2 seconds for a
  minute. A folder whose listing fails (either side, any error, the plugin folder itself included: a plugin folder
  deleted while the catalog is still the old one) is reported and nothing below it is copied, deleted or rewritten; its
  record entries stay until a complete listing (`listFiles`'s `unreadable`). A conflict is resolved only if it is still
  in the record and both sides still hash to what the dialog showed (`conflictVersions`, taken before the dialog;
  `resolveConflict` checks under the lock).
- Commands and agents are files below `commands/` and `agents/`: a left-out one is a file prefix of the copy, like a
  rule. MCP servers share a file (`.mcp.json`, `mcp.json`), so `readCatalog` records each plugin's `mcpFiles` (file
  name -> server names) and `mcpPlan` (in `lib/materialize.js`) tells what the selection does to each file: no server
  left out, the file is a normal two-way file; every server left out, the file is never copied (handled like an
  unselected rule); some left out, the copy holds a file generated by `filterMcpJson` (repository -> copy only, never
  a conflict). `syncCopy`'s filtered branch has three outcomes: the repository's file is gone (the copy's file is
  deleted when unchanged since the last write, else kept and reported), the copy's file is missing, equal to the
  generated content or equal to what was last written (the generated content is written, the record holds its hash),
  or the copy's file was edited (kept and reported: `MCP servers left out of the selection: an edit in the copy never
  reaches the repository`). `markCopySynced` needs nothing special: the next sync regenerates the file.
- What Cursor does with these (measured on Cursor 3.31, 2026-11-25, agent host `cursor-agent-host/dist/7361.js` and a
  live probe with a local repository): a registered extension plugin loads its skills, rules, commands, agents, MCP
  servers and hooks. When `plugin.json` declares `agents`, `commands`, `rules` or `skills` (any value), Cursor reads
  those paths instead of the default folder; otherwise commands are the files of `commands/` ending in `.md`, `.mdc`,
  `.markdown` or `.txt` and agents those of `agents/` ending in `.md`, `.mdc` or `.markdown`, both recursive. MCP
  servers come from `plugin.json`'s `mcpServers` (inline object, path or array), which override by name the servers of
  `.mcp.json` then `mcp.json` (the first file naming a server wins); a file's servers are its `mcpServers` object when
  it has at least one key, else its top-level entries that are objects with `command` or `url` (`author`, `owner`,
  `source`, `metadata` are metadata). A server that leaves the registered folder's file leaves Cursor's server list
  (the agent's tools) within a few seconds, without a re-registration; deleting the file or unregistering the plugin
  does the same for all its servers. Its process is stopped a fixed 30 s after it left the list (measured twice:
  30.0 s and 30.3 s). A server that keeps its name keeps running with its
  old configuration, even when its `args` change or the plugin is registered again from another folder (partial copy
  to clone): Cursor restarts it only at the next window reload. Checked live with 0.6.0: a partial selection runs
  only the selected servers, the copy's `mcp.json` follows a repository change at once, and ticking the whole plugin
  starts the server that was left out.
- Symlinks and junctions in a plugin are copied as their content when they point inside the repository; one that points
  outside, is broken or loops is left out of the partial copy (see the log). A file an agent creates in a copy at the
  path of a skill or rule that is not selected is never copied to the repository (it stays in the copy, see the log).
- Windows with the same selection share a copy; every open window marks the copies it uses every hour, and copies no
  window used for a week are deleted. The copy's folder name is the plugin name with characters other than letters,
  digits, `.`, `_` and `-` replaced by `_` (the plugin's own folder name, which Cursor uses, is unchanged).
- Several windows share one clone: a lock file serialises every operation that changes it (sync, commit and push, push
  to a branch, discard, partial-copy syncs, which take the lock in local mode too since windows with the same selection
  share a copy), and the other windows notice the new state through the files of `state/`. An edit in a managed clone
  (another window's partial copy, or by hand) reaches this window's partial copies and view within a second.
- Push to a branch commits, pushes, then runs `git reset --keep @{u}`: it undoes only what the pushed commit changed and
  keeps edits saved after the commit; it refuses (and changes nothing) when one of them is on a file of the pushed commit
  or a new file would be overwritten, and the result carries `resetSkipped`. The partial copies are not marked synced
  afterwards (only Discard does): a pushed file equals its record entry and takes the team version, a later copy edit
  becomes a local change or a conflict.
- Push to a branch returns the page from `pullRequest.pullRequestPage`: built from the repository URL for `github.com`
  (`compare/<target>...<branch>?quick_pull=1`), `gitlab.com`
  (`-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…`) and Azure DevOps
  (`dev.azure.com`, `ssh.dev.azure.com`, `*.visualstudio.com`, `vs-ssh.visualstudio.com`:
  `…/_git/<repo>/pullrequestcreate?sourceRef=…&targetRef=…`), with the followed branch as the target; otherwise the
  first `remote:` URL of the push output that names the branch (GitHub Enterprise, self-hosted GitLab, Bitbucket Cloud
  and Azure DevOps Services print one); the URL is logged. A refused Commit and push offers **Open a pull request**
  (Push to a branch, then the page opens at once).
- Updates: the team's new commits are rebased under the local changes. Conflicts are found first with
  `git merge-tree --write-tree` (hence git 2.38). With several windows open, only one fetches per interval (a timed
  update leaves out each repository that another window synced less than half an interval ago, by its state file).
  The update interval has a floor of 5 minutes.
- A branch change of an entry switches its managed clone in place (an error if it has local changes). A URL change is
  another repository: a new clone, and the old one stays in the storage. An entry without a branch follows the
  repository's default branch, resolved at each sync, also when the team changes it.
- Projects: **Add to this project** also writes the repository's `{ name, url, branch }` to the project's
  `teamPlugins.projectRepositories` (a local clone: the URL of its `origin`; none: only logged). A window whose project
  lists a repository the user doesn't follow (`missingRepos`, by normalised URL or by name) shows a notification once
  per window and a `missing` node in the view; ids whose repository the project doesn't locate are only logged
  (`unlocatedRepos`). Nothing is ever added without a click.
- git runs without prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`); a network command is stopped (with the
  processes it started) only after 2 minutes without output, so a long first clone works while data arrives. A
  `.git/index.lock` older than a minute (left by a killed git) is removed before the next operation, and leftover
  `<key>.tmp-*` folders of a failed clone at the next sync.
- An unreachable server (offline) is quiet while a clone exists, never counts as a sync, and is retried after 5
  minutes. A background sync error is shown once, and again only after a sync succeeded (Sync now always shows it).
- Drafts: `<storage>/.cursor/plugins/drafts` is a repository of `kind: 'drafts'` (key `drafts`, `listRepos`'s `drafts`
  argument), listed first when the folder exists and named `drafts` by `baseName`. It has no git and no sync
  (`syncRepo` only records the check), its own lock (`locks/drafts.lock`, taken by the partial-copy syncs and the
  authoring writes like any repository's) and a plain folder watcher. The view hides it while it holds no plugin and
  no conflict (`isEmptyDrafts`). It is never deleted: it is the parent of the registered plugin folders, and Windows
  refuses to delete or rename that parent; only a draft plugin's own folder is removed (`movePlugin`). Another window
  starts watching a folder created elsewhere at its next apply (`draftsWatched`, checked at the end of `doApply`), not
  at once.
- Authoring (`lib/authoring.js`): the files are written in the repository's folder (`plugin.dir`), never in a partial
  copy (the copy follows through `syncCopy`), under that repository's lock inside the operation queue. `createPlugin`
  and `movePlugin` add an entry to `marketplace.json` only when it has a `plugins` array (honouring
  `metadata.pluginRoot`), and refuse a folder or plugin name already taken. A new item is added to the selection
  (`enableNew`) only when it is not already included: a fully enabled plugin takes it by itself. A kind whose paths
  `plugin.json` declares (`customPaths` of the catalog's plugins) gets no scaffold: Cursor would ignore the default
  folder. **Move to a repository** first unregisters the draft in this window (`Registrar.remove`): on Windows a folder
  deleted while Cursor watches it as a registered plugin is only "delete pending" (still listed, `lstat` fails with
  EPERM) until that window unregisters it or reloads (seen live with 0.7.0 before this order). `movePlugin` then copies
  the folder (`fs.cpSync`), adds the marketplace entry and deletes the draft (a draft folder still listed afterwards,
  pending or not, is reported as `leftover`; another window that registered the draft lets go of it at its next apply,
  when the renamed ids reach it); the partial copy of the draft is dropped from `partialCopies` so that it
  can't carry files back into the deleted folder, and the ids of the user's `enabled` and `excluded` lists are
  renamed (`renameIds`) before the next apply. Names follow Cursor's own rule for plugin names
  (`/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/`, at most 64 characters), used for skills, rules, commands and agents too.
  A plugin folder built from repository data (`metadata.pluginRoot`, a new name) is checked by
  `authoring.pluginDirError` (catalog's `inside`, on real paths: a link is resolved through the deepest folder that
  exists, so a folder not created yet is checked too) before any write: it must be inside the repository and never the
  repository root. New plugin, Move to a repository (through `placePlugin`, so the draft is never copied nor deleted
  when it fails) and Rename (the new folder) all use it.
- MCP files and frontmatter values written by the extension: `mcp.json` is JSONC, so Add MCP server
  (`authoring.addMcpServer`) and Rename of a server (`renameItem`) edit its text with `lib/jsonc.js` instead of
  writing `JSON.stringify` of the parsed object, which would drop the comments. `tokens` reads the text (BOM, comments
  and strings skipped); `addMember` adds a member at the end of an object, indented like the members already there, with
  the comma added where missing (a compact object stays compact, a multi-line one gets the member on its own lines,
  line endings kept); `renameKey` replaces only the key tokens. The callers parse with `checks.parseJsonc` first.
  `yamlScalar` writes a value plain only when it starts with a letter, has no `:`, `#` or control character and is not a
  boolean or null word (`true`, `no`, `on`, `y`, ...), else as a JSON string: a date, a number or `true` would be read
  back as another type and the description would be lost. Names go through it too (`itemFile`, `renameSkillName`).
- Rename (`lib/rename.js`, `renameCommand`; F2 or right-click): `renamePlugin` refuses a plugin whose folder is the
  repository root (`source: "."`: renaming it would move the clone, and Cursor names the plugin after that folder, so
  renaming only the metadata would not change what Cursor shows) or the `metadata.pluginRoot` folder (it would move
  every plugin below it), before any write. Otherwise it renames the plugin folder (Cursor names a
  registered plugin after its folder), sets `plugin.json`'s `name` and the marketplace entry (found by its resolved
  source; the source is rewritten as `./<path from the plugin root>`); `renameItem` renames a skill folder or a rule,
  command or agent file (extension kept) and a `name:` frontmatter that equalled the old name (`renameSkillName`), or an
  MCP server key in place in every MCP file that has it. Every check comes before the first change and a failure
  puts back what was done. Measured in the isolated Cursor 3.32.4: a registered plugin folder and the items inside
  it can be renamed with `fs.renameSync`, registered or not, so there is no copy-and-delete; the plugin is still
  unregistered first (like **Move to a repository**) and its partial copy is dropped from `partialCopies`, and
  `flushPartials` runs before so pending copy edits reach the repository. The record is `"renamed": { "<old id>":
  "<new id>" }` in the repository's `marketplace.json` (created as just that key when the file is missing: with no
  `plugins` and no `name` it changes neither the repository's name nor how its plugins are found), ids without the
  repository name, written for managed and local clones, never for drafts (only this user's lists hold their ids).
  `recordRename` keeps the map flat (older entries pointing at the old id follow to the new one, the new id's own key
  is dropped, an entry that points to itself is dropped). Cursor's own `marketplace.json` reader ignores unknown keys
  (its zod schemas never call `.strict()`), so the key is safe in a repository also imported as a Cursor marketplace.
  `readCatalog` returns `renamed`; `mergeCatalogs` prefixes it with the repository name (a `Map`) and builds
  `formerNames`; `normalizeIds` runs every id through `followRenames`: an id that exists in the catalog is never
  redirected (a new skill may reuse an old name); else the repository's former name is replaced, then the records are
  followed (the exact id, else its plugin part, up to 10 steps, never twice through one id). The user's lists are
  rewritten by `migrateIds` at the next apply; a project's lists are only read through the records. A repository renamed
  through its `marketplace.json`'s `name` is detected by `rememberNames` against `<storage>/repo-names.json`
  (`{ "<key>": { name, former } }`, written by `doApply`; deliberately not under `state/`, whose watcher would apply
  again on every write): its old names are `desc.formerNames`.
- Share with team (`lib/share.js`, `shareCommand`): copies a project's (or `~/.cursor`'s) rule, skill, command or agent
  into a plugin. `shareKind` is the text test behind the Explorer menu's `when` regexes (`share.test.js` keeps the two in
  step). The Explorer passes `(clicked, selected)` to the command but evaluates the `when` on the clicked item only, so
  the command filters the selection itself (`shareableItem`). `resourcePath` is `uri.fsPath` for a `file:` URI
  (backslashes on Windows) and `uri.path` otherwise (Remote-SSH), hence `[\\/]` in the regexes. The copy goes to
  `plugin.dir` under the repository lock, like the other authoring writes. A skill is copied with `fs.cpSync` and a
  filter on `lstat` that leaves links out (reported); a skill folder that is itself a link is copied through
  `realpath`. A rule from a subfolder of `.cursor/rules` is flattened into the plugin's `rules` (plugins read rules only
  directly there). A renamed skill gets its frontmatter `name:` rewritten when it equalled the old folder name
  (`renameSkillName`). The original is moved to the trash (`useTrash`); in a remote window (`vscode.env.remoteName`
  set) the file system has no trash, so the button reads **Delete the original(s)** and deletes for good after a modal
  confirmation (`removeOriginals`).

### Walkthrough

- `contributes.walkthroughs` has one walkthrough, `gettingStarted` (`WALKTHROUGH_ID`), with three steps and their
  `completionEvents`: `checkGit` (`onContext:teamPlugins.gitReady`), `addRepository`
  (`onSettingChanged:teamPlugins.repositories` and `...localRepositories`) and `pickPlugins`
  (`onSettingChanged:teamPlugins.enabled`). No `onCommand:` event: it would tick Check git even when git is missing, and
  Add repository when the input is cancelled; and it fires only for a command that goes through the workbench (palette,
  menu, command link), not for `executeCommand` from the extension host.
- `teamPlugins.gitReady` is set only by **Check git** (`checkGitCommand`: true for a git 2.38 or later that runs), never
  at activation or on a settings change. A context key that already matches when Cursor registers the walkthrough
  never completes the step in that session: its `onContext` registration puts the event in `sessionEvents` and
  `progressByEvent` skips events already there (read in `workbench.desktop.main.js`, Cursor 3.32.4). Registration
  happens at startup and may wait up to 5 s, so it races with the `onStartupFinished` activation. As a result a step
  does not tick for someone who is already set up: **Mark Done** is there.
- **Get started** calls `workbench.action.openWalkthrough` with the object form `{ category:
  '<extensionId>#gettingStarted', step: '<extensionId>#gettingStarted#checkGit' }, false`: the string form of the
  category opens the generic Welcome page (a string with `#<stepId>` logs `Could not find category with ID`). Called
  in the first seconds after startup, before the walkthrough is registered, it opens the Welcome page too.
- The media pages are flat files in `resources/` (`walkthrough-git.md`, `-repository.md`, `-plugins.md`), because
  `scripts/package.js` packages `resources/` non-recursively. Their links are `https:` only (`package.test.js`).
- Cursor opens a walkthrough by itself only when the extension was installed in this session (not with a
  `skipWalkthrough` install context), the walkthrough id is seen for the first time, the window had the last focus and
  `workbench.welcomePage.walkthroughs.openOnInstall` is on. `updateAll` installs without `skipWalkthrough`, so an update
  probably counts as an install (read in the bundle, not probed). With `--extensionDevelopmentPath` nothing opens.
- Remote-SSH is not probed for the walkthrough: Check git runs on the remote machine, like every git command, and its
  message names that machine.

### Update summary

- What the user has seen is one file per repository, `<storage>/seen/<key>.json` (`{ version: 1, items: { <local id>: {
  oid, commit, path, kind, name } } }`): the item's fingerprint when last seen, HEAD then (the left side of its diff)
  and what it needs to list the item when it is gone. It lives outside `state/` and has its own watcher in
  `startWatchers` (`state/*.json` triggers a full apply too, but this one only needs the marks again): marking an item
  seen in one window applies in every window. `writeSeen` writes only when the JSON text differs from the file's, so
  the watcher never loops. A missing, damaged or other-version file is "never seen": a baseline.
- Fingerprints (`lib/updates.js`) are read at HEAD, so uncommitted edits never mark: the object id of a skill's folder,
  rule, command or agent file (one `git ls-tree -r -t -z HEAD` per HEAD), and for an MCP server the SHA-1 of its entry
  in the MCP file at HEAD (`git show HEAD:<file>`; two servers of a file change independently).
- The git pass is cached per HEAD (and per set of MCP files) in `s.updates.git`: the tree, the MCP files, the last 1000
  commits with their paths (`git log -z --name-only`, parsed by `parseLog`), and the user's email. A plain `rev-parse
  HEAD` runs at every apply. "Own" changes are those whose author email equals `git var GIT_AUTHOR_IDENT`'s: it honours
  the `GIT_AUTHOR_*` environment, unlike `git config user.email`; with no identity (exit 128) nothing is own.
- `computeMarks` compares fingerprints with the record. Baseline (no record, or a clone or a branch switch, flagged
  `updatesBaseline` by `syncRepo`): everything is recorded, nothing marked. Otherwise an item whose fingerprint
  differs is `updated`, one without a record is `new`, a record without an item is `removed` (listed with its stored
  path and kind), and a change whose last commit is the user's own is recorded instead of marked. A record id that a
  `renamed` entry of `marketplace.json` leads to an item moves to it. An item that is not committed is left alone.
- The sync's notification is not shown by `notifyAfterSync` any more: it only stores `s.updateNotice` (`from`, `to`,
  the commit count, the kept files). `refreshUpdates` shows it once the marks of the apply that follows are computed,
  naming the marked items whose last commit is in `from..to`, the enabled ones first (`noticeEntries`, `noticeText`).
  Commits that touch no item keep the old text, without a button; commits that are all the user's own show nothing.
  Only the window that synced shows it; the marks show in every window.
- **What changed** (`whatChangedCommand`) and **Show changes** (`showChangesCommand`) open diffs through
  `team-plugins-git:` documents. The content provider serves `git show <rev>:<path>` for `HEAD` or a full commit hash
  (`revFileArgs`; an empty rev is an absent side) of any managed or local repository, and, when the request has a
  `server`, only that server's entry (`serverText`). A skill with several files opens `vscode.changes(title, [[label,
  left, right], ...])`: the handler wants both sides of every entry, so an absent side is a `team-plugins-git:` URI
  with an empty rev (Cursor 3.32, VS Code 1.147). `vscode.diff` is used for a single file.
- Marks are file decorations too (`itemDecoration`): the badge holds at most two characters (`FileDecoration.validate`
  throws on more), so a project item with a mark reads `PN` or `PM`. The number on the view's icon is
  `TreeView.badge`, set after every `refreshUpdates`.

### Checks

- `lib/checks.js` (pure) finds what Cursor silently drops or misreads. A problem is `{ file, line, severity, message }`
  (`error`: dropped or ignored; `warning`: loaded but degraded). `readCatalog` computes them per file it reads: an item
  carries `problems` (frontmatter, description, agent body, conflict markers, same name as an earlier skill or rule), a
  plugin carries those of its `plugin.json` and MCP files, the catalog those of `marketplace.json` and of the warnings
  that are not about one loaded plugin. `warnings` keep their texts (they are logged).
- `pushProblems` (before **Commit and push** and **Push to a branch**, `confirmChecks` in `extension.js`) keeps the
  repository-level problems, those of the plugins that contain a path the push carries (`sync.changedPaths`: the status
  files, and the files of the unpushed commits) and, for a changed file outside any item, a conflict marker check. The
  modal offers **Push anyway** and **Open files**.
- `doApply` ends with `updateDiagnostics`: every problem with a file goes to one `DiagnosticCollection` ("Team plugins"),
  mirrored on the same file of a partial copy (the path an agent edits). The collection is replaced only when its content
  changed.
- Why our own YAML checker: Cursor reads each item with gray-matter 4.0.3 (js-yaml 3 `safeLoad`) inside a `try`, so a
  throw drops the item without a log line, and the checker needs no dependency. It is line based and was calibrated
  against Cursor's own gray-matter on 86 frontmatter texts (0 false positives; 1 known miss: a plain value with a ` #`
  comment followed by an indented `b: c` line). Facts measured on Cursor 3.32.4 (2026-11-26, the agent host's loader run
  on probe plugins):
  - A frontmatter gray-matter can't parse drops a skill, rule, command or agent. No frontmatter, an empty one, a missing,
    empty or non-string `description`, a folded `>` value, a BOM or CRLF load fine. A `---` that is never closed makes
    the whole file the frontmatter (dropped unless it holds only `key: value` lines). Tabs in indentation are valid
    (js-yaml 3), `yes` is a string, `12`, `2024-01-01`, `true` are not.
  - A skill without a description is listed to the agent by path only; skills of a plugin are de-duplicated by their
    normalised name (frontmatter `name`, else the folder), rules too; an agent with an empty body is dropped. A rule
    without `description`, `globs` or `alwaysApply` is manual only: not flagged (it can be intended).
  - `plugin.json` and `marketplace.json` are read with strict `JSON.parse` (a comment, a trailing comma or a BOM makes
    Cursor ignore the file); `mcp.json` and `.mcp.json` with jsonc-parser (comments and trailing commas are fine), so the
    catalog reads them as JSONC (`parseJsonc`).
  - Diagnostics: the agent's `ReadLints` tool takes absolute paths and reads the workbench's marker service without a
    workspace filter, so an extension's diagnostics of a file outside the workspace reach it (code reading of the
    Cursor 3.32.4 bundles; not yet seen live: the hand check of 0.8.5 confirmed the Problems panel, on the clone and
    the copy paths, but couldn't run the agent); only errors and warnings are returned, and for an open document markers older than its version
    are dropped. A marker records the open document's version when it is set, so `updateDiagnostics` (at every apply)
    compares the problems together with the open documents' versions and sets the collection again when either changed.

### Context cost

- `lib/context.js` (pure; requires `checks` only, because `catalog` requires it) estimates what the selection puts in
  every chat, at 4 characters per token. `itemContext` runs in `readCatalog` (`itemChild`) for each skill and rule and
  stores `context` on the child: `{ apply, chars, globs? }` with `apply` `always`, `globs`, `agent` or `manual` for a
  rule, `always`, `description` or `hidden` for a skill; it is `null` (no field) for a command, an agent, and a
  frontmatter Cursor drops or our checker can't read. It reads the frontmatter keys through `lintFrontmatter`, whose
  `keys` entries carry `end` (the 0-based line just after the value) so a `globs` list over several lines can be read.
- `costOf` sums a set of children into buckets (always-applied, descriptions, matching files) and rounds each bucket to
  tokens once; `costLines` writes the tooltip lines, `itemLine` an item's line, `selectionCost` the cost of the ticked
  items of the active plugins. `buildTree` shows a plugin's cost in its row and tooltip and an item's line in its
  tooltip; `updateStatus` (end of every `doApply`) adds the total to the status bar tooltip and sets the view's
  `description`.
- Facts measured on Cursor 3.32.4 (2026-11-27), read in the agent host bundle
  (`resources/app/extensions/cursor-agent-host/dist/4846.js`) and the YAML values run through Cursor's own gray-matter
  4.0.3:
  1. A plugin rule's type: `alwaysApply` the boolean `true` -> always; else a non-empty `globs` -> for matching files;
     else a non-empty string `description` -> the agent fetches it; else manual (only when mentioned).
  2. `alwaysApply` must be a boolean (`true`, `True`, `TRUE` are; `yes` and `"true"` are strings). `globs` is a string
     split on commas outside `{...}`, or an array of strings; anything else is ignored. `description` counts only as a
     string. The rule's content is the whole file text.
  3. Skills go through the same function: a skill with `alwaysApply: true` becomes an always-applied rule with its whole
     content and is left out of the skill list; every other skill is sent with its description and a
     `disableModelInvocation` flag (`disable-model-invocation: true`).
  4. Descriptions of skills and agent-requested rules are cut at 1536 characters.
  5. Cursor builds the prompt on its server: how a description is wrapped, whether a `disable-model-invocation` skill is
     listed and whether subagent descriptions are in every chat can't be seen, hence an estimate.
- Not counted: MCP tool definitions, subagent descriptions, commands, the project's own rules and skills, the user rules,
  `globs` on a skill, the paths a `plugin.json` declares for skills or rules (the default folders are read, as in the
  view), and a non-string `description` (read as text).

## Remote windows (Remote-SSH)

- Cursor's agent runs on the remote machine, so the extension (`extensionKind: ["workspace"]`) runs there too and must
  be installed there.
- The managed clone and the partial copies are in the remote extension storage
  (`~/.cursor-server/data/User/globalStorage/mathieugun.cursor-team-plugins`). git runs on that machine (2.38 or later,
  on its PATH or `git.path` in the remote settings), with that machine's credentials and SSH keys.
- Settings: the repositories (`repositories`, URLs and branches), the update interval and the selection (`enabled`,
  `excluded`) are `application` settings, the same in local and remote windows. `teamPlugins.localRepositories` is a
  `machine` setting: in a remote window it holds paths on the remote machine (stored in its remote settings). A
  project's `projectPlugins` and `projectRepositories` are read from the remote project's `.vscode/settings.json`.
- Each machine has its own clones: an agent's edit in a remote window lands in that machine's clone and shows in its
  Local changes; it is committed and pushed from a window on that machine. Several windows on the same remote machine
  share its clone, as local windows do.
- The status bar tooltip shows `Machine: <host> (remote window)`, and the error messages name the machine. In a remote
  window, **Output > Team Plugins** and Cursor's own plugin log are on the remote machine.

## Platform notes

- SSH: git's bundled ssh fails fast without a console (unknown host key, passphrase without agent). Windows' own
  OpenSSH and PuTTY's plink wait silently for a question the extension can't show: git is stopped after 2 minutes
  without output and the message suggests a terminal.
- SSH keys with a passphrase are not supported: the background git can't unlock them, and an agent started in a
  terminal (`ssh-agent`, `ssh-add`) is not visible to Cursor (`SSH_AUTH_SOCK` exists only in that terminal). Only
  Windows' agent service with `core.sshCommand` set to Windows' OpenSSH would work (not tested).
- On Linux and macOS (and on remote machines), git keeps HTTPS credentials only with a credential helper
  (`credential.helper store`, `gh auth setup-git`, ...).
- Forwarding local credentials or an SSH agent to the git of a remote machine is not supported (agent forwarding is not
  tested).
- WSL and dev containers are not tested; they should work the same way (install the extension on that side). A dev
  container rebuild loses the clone, which is cloned again at the next start.
- The view's checkboxes have two states (`TreeItemCheckboxState` is `Unchecked`/`Checked` in Cursor 3.31, VS Code
  1.128): a partly enabled plugin stays unticked, with a `pie-chart` icon and a checkbox tooltip giving the count.
- Project items are marked with a file decoration: plugin, skill and rule rows carry a `team-plugins:/<key>`
  `resourceUri`, and the extension's `FileDecorationProvider` returns the colour (`teamPlugins.projectItemForeground`)
  and the `P` badge (and the `N`/`M` marks of the update summary). Custom tree views apply
  `explorer.decorations.colors`/`badges` to them.
- A selected row loses the project colour while the view has the keyboard focus. Cursor's stylesheet has
  `.monaco-list:focus .selected .monaco-icon-label, ...:after { color: inherit !important }` (label and badge take the
  selection foreground) and `.customview-tree .monaco-list-row.selected ... .custom-view-tree-node-item-icon.codicon
  { color: currentColor !important }` (icons lose their colour on any selected row, so a coloured icon would not help).
  An extension can't override either. Checked by hand (Cursor 3.31): a row selected before **Add to this project**
  stays uncoloured; it turns purple when the focus moves to the editor or another row is selected, and loses the
  colour when clicked again. A right-click focuses a row without selecting it, so a row not selected beforehand turns
  purple at once (local and Remote-SSH windows alike). The decoration itself is updated at once.

## Known limits (details)

- Marketplace entries whose source is not a folder of the repository (GitHub or URL sources) are skipped.
- Custom component paths declared in `plugin.json` are not read. A kind whose paths it declares (`commands`, `agents`,
  `mcpServers`) is not selectable: its files always come with the plugin (Cursor then reads those paths instead of the
  default folder or files); custom paths for skills and rules stay unread as well.
- Commands and agents in subfolders of `commands/` or `agents/` are not selectable: they always come with the plugin
  (as nested rules).
- Hooks stay all or nothing, like anything else that is not a skill, rule, command, agent or MCP server (assets).
- An MCP file with some servers left out is generated in the partial copy (rewritten as `JSON.stringify(..., 2)`): it
  only goes from the repository to the copy. An edit or deletion made there never reaches the repository; an edited one
  is kept and reported in the log (and then no longer updated until removed), a deleted one is written again.
- An MCP file is read as JSONC like Cursor (comments, trailing commas), so the servers of such a file are selectable
  and a partial copy of it (generated) loses its comments. One that doesn't parse even so gives a warning and a
  problem; its servers are not selectable and the file always comes with the plugin.
- Checks: the YAML checker flags only the forms it knows (a plain value with `: `, a value starting with `*`, `[`, `@`,
  `` ` ``, `%`, `!`, text after a closing quote or bracket, a quote or bracket never closed, a duplicate key, bad
  indentation) and may miss rarer errors (a plain value with a ` #` comment followed by an indented `key: value` line,
  errors inside nested maps beyond a plain `key: value`). A rule without a description that is neither `alwaysApply`
  nor glob-attached and a command without a description are not flagged. A skill folder that differs from its `name`
  and relative links to missing files are not checked. Hooks, scripts and other assets get only the conflict marker
  check, and only in changed files at push time. `lib/authoring.js` (Add MCP server) and `lib/rename.js` still parse MCP
  files strictly: on a file with comments they fail as before (rewriting would drop the comments). Diagnostics and
  `ReadLints` were not probed in a Remote-SSH window. The problems of a repository that is not loaded (listed twice,
  hidden by name) are not shown or published.
- With a local repository outside a `.cursor/plugins` folder, Cursor may list the skills among the rules; the agent
  still gets them.
- Enterprise teams whose admin turned off "Allow Local Plugin Imports": not tested whether it also blocks extension
  plugins.
- A conflict between a partial copy and the repository is not merged line by line: the user keeps one of the two
  versions. A real conflict with the team's commits is never merged by the extension.
- A file (not a folder) that can't be read makes the partial-copy sync fail (`cannot sync the partial copy of ...` in
  the log). A copy edit made between Discard's confirmation and its reset is discarded with the rest, and an edit made
  while the `git reset --keep` of Push to a branch runs is not covered.
- The warning for an unreadable folder shows once per folder and reason per window, not again after it recovers and
  fails later.
- The commit includes every change of the managed clone (`git add -A`); there is no per-file choice.
- A clone of a local or network-share path that copies for more than 2 minutes without output is stopped.
- Switching a managed clone to an empty repository (no branch yet) is an error.
- The getting started walkthrough was not probed in a Remote-SSH window. A sync that fails because git can't be
  started doesn't point to **Check git**.
- A symlink or junction created inside a partial copy is left out of the sync (see the log), never followed.
- A frontmatter description written as a quoted string over several lines shows only as written on the first line.
- After the window that did the timed fetches closes, the next timed update in another window can be up to half an
  interval late.
- Update summary: two servers of one MCP file changed by different people are both credited to whoever last changed
  the file. Content behind a symlinked skill folder is not seen (git stores the link, not its target). A rename
  (recorded in `marketplace.json`) moves the record, but the renamed item usually shows as updated. An item whose last
  change is older than the last 1000 commits has no "Last changed by" line. A version that a force-push made
  unreachable (and git pruned) diffs against an empty left side. The notification shows only in the window that
  synced; the marks show in every window.
- A plugin with the same name installed from a marketplace conflicts with the one this extension registers.
- A company index repository (one entry that lists the team repositories) and per-repository update intervals are not
  done: follow-ups.
- Following two branches of one repository is not possible: the second entry is `listed twice`.
- The clone of a repository removed from the list is not deleted (it stays in the extension's storage).
- Two URLs of one repository that differ only in the case of the path are two repositories (two clones).
- Renaming a repository (its `marketplace.json` `name`) is followed through `repo-names.json` for the people who already
  follow it; someone who starts following it after the rename reads a project's old `<old name>:...` ids as unknown (the
  project's items are added again once). No command renames a repository: edit its `marketplace.json`.
- Rename: references to the old name inside other files (a skill naming another, a rule linking a file) are not
  updated. The records are never pruned (delete them by hand once every teammate has synced). A case-only rename of a
  folder named by hand (`Review` -> `review` on Windows) is refused as "already exists". The 0.4 bare ids of a renamed
  plugin are not followed. An editor open on a renamed file is not reopened on the new path. The F2 binding is not
  tested by the live scenarios (key presses can't be automated): without a tree element the command takes
  `treeView.selection[0]`.
- `filterMcpJson` drops the comments of the generated partial-copy MCP file (it is never written back to the
  repository).
- A JSONC `mcp.json` that `parseJsonc` rejects is refused by Add MCP server and skipped by Rename.
- Pull requests from a fork (a user with no write access at all) are not supported: the message says to ask for write
  access.
- The page of a branch pushed earlier (after the notification closed) is not offered again: its URL stays in the log.
- Hosts other than GitHub, GitLab and Azure DevOps get a page only when the server prints one on the push (Bitbucket
  Server, Azure DevOps Server and Gitea without the message get none: the message says to open the pull request on the
  hosting service). A printed page targets the server's default branch, not necessarily the branch the clone follows.
- An SSH host alias (`github.com-work` in `~/.ssh/config`) is an unknown host: only a printed URL is used.
- The Azure DevOps page form (`pullrequestcreate?sourceRef=&targetRef=`) is not confirmed by Microsoft's docs
  (2026-11-26): check it on a real Azure DevOps repository.
- Upgrade from 0.4: the clone of 0.4 (`.cursor/plugins/repo`) is reused by the entry whose URL equals its origin URL,
  with its local changes. A clone that 0.4 left half-switched (origin still the old URL) is not reused: the entry is
  cloned again under `repos/` and the old folder stays. The partial copies move to new holder folders once (the hash
  input now holds the repository name): an edit made in an old copy while no window was running is not carried over
  (the old copy stays a week).
- Writing a plugin rewrites the `marketplace.json` or `mcp.json` it edits with `JSON.stringify(obj, null, 2)`: their
  formatting (indentation, key layout) changes.
- Drafts are not backed up and not synced (on a Remote-SSH host they are on the remote machine). A draft has no
  **Add to this project** (a project can't require a plugin other people don't have). A drafts folder created by another
  window is shown by this one at its next apply (any sync or settings change), not at once.
- Share with team: a Remote-SSH window's file system has no trash (`vscode.workspace.fs.delete` with `useTrash` fails
  with "Unable to delete file ... via trash because provider does not support it", live test 0.8.0 on a Linux host),
  hence the confirmed permanent delete there. A personal `~/.cursor` item is addressed with `Uri.file` in a remote
  window: deleting it there was not tried live (a failure is shown, nothing else is deleted). The command palette lists only the `.cursor` folders at the root of each workspace folder and `~/.cursor` (its skills, commands
  and agents, no rules); the Explorer's right-click works on any `.cursor` folder.
- The publisher was `mg` before the first public release: `extension.js` warns while `mg.cursor-team-plugins` is
  installed (both would register the same plugins), stays inactive and offers to uninstall it; its storage is not
  migrated.
