# Team plugins: development notes

Notes for people working on the extension: how it works inside, platform details and known limits that the README
leaves out. The code-level reasons ("why the code is shaped this way") and the test commands are in `AGENTS.md`.

## Building and releasing

- Build the VSIX: `node scripts/package.js` (writes `dist/cursor-team-plugins-<version>.vsix`; see `AGENTS.md` for
  running it with Cursor's runtime when node is not installed).
- Changes are made on a branch and merged into `main` when ready (see `AGENTS.md`). Release from `main`: bump
  `version` in `package.json`, commit, then push a tag `v<version>` (`git tag v<version>`,
  `git push origin main v<version>`). `.github/workflows/release.yml` checks that the tag matches the version, runs the
  tests, attaches the VSIX to a GitHub release and publishes it to Open VSX, which Cursor's marketplace mirrors (a new
  extension appeared there about 7 minutes after Open VSX listed it; new versions of existing extensions show up at
  once).
- Open VSX setup (done once): an open-vsx.org account signed in with GitHub, linked to an Eclipse Foundation account
  with the publisher agreement accepted; the namespace `mathieugun` (equal to `publisher` in `package.json`); an access
  token stored as the repository secret `OVSX_PAT`. Without the secret the workflow only makes the GitHub release.
- The README is the extension's details page in Cursor and on Open VSX: a change reaches users with the next release.

## Tests

- **Unit tests** (`scripts/test.js`, `test/*.test.js`): one file per module, `node:test`, only local bare git
  repositories, no network. CI runs them on a release tag.
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
    the recorder that replaces `ui`), `idle` (nothing in flight for 300 ms), `tree` (labels, icons, checkbox states),
    `check` (ticks or unticks a node like a click), `registrations`, `decoration`, `states` (per repository),
    `status` (status bar), `logLines`, `storage` and `logUri`.
- **By hand** (`test/manual-remote-checks.md`): what needs a real server or the real ssh and credential manager, and
  the look of the view (icons, colours).

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
  minute.
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
  and the `P` badge. Custom tree views apply `explorer.decorations.colors`/`badges` to them.
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
- An `mcp.json` or `.mcp.json` that is not valid JSON gives a catalog warning; its servers are not selectable and the
  file always comes with the plugin.
- With a local repository outside a `.cursor/plugins` folder, Cursor may list the skills among the rules; the agent
  still gets them.
- Enterprise teams whose admin turned off "Allow Local Plugin Imports": not tested whether it also blocks extension
  plugins.
- A conflict between a partial copy and the repository is not merged line by line: the user keeps one of the two
  versions. A real conflict with the team's commits is never merged by the extension.
- The commit includes every change of the managed clone (`git add -A`); there is no per-file choice.
- A clone of a local or network-share path that copies for more than 2 minutes without output is stopped.
- Switching a managed clone to an empty repository (no branch yet) is an error.
- A symlink or junction created inside a partial copy is left out of the sync (see the log), never followed.
- A frontmatter description written as a quoted string over several lines shows only as written on the first line.
- After the window that did the timed fetches closes, the next timed update in another window can be up to half an
  interval late.
- A plugin with the same name installed from a marketplace conflicts with the one this extension registers.
- A company index repository (one entry that lists the team repositories) and per-repository update intervals are not
  done: follow-ups.
- Following two branches of one repository is not possible: the second entry is `listed twice`.
- The clone of a repository removed from the list is not deleted (it stays in the extension's storage).
- Two URLs of one repository that differ only in the case of the path are two repositories (two clones).
- Renaming a repository (its `marketplace.json` `name`) changes every id of its plugins: users pick again, projects
  update their lists.
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
