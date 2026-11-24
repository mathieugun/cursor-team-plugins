# cursor-team-plugins: developer notes

Cursor (VS Code) extension, version in `package.json` (0.5.0). Plain JavaScript, CommonJS, no npm dependency, no
build step. User documentation: `README.md` (for Cursor users: what it does, install, usage; it shows
only the current version, with no history). Internals, platform notes, detailed limits and the release process:
`docs/development.md`.

## Layout

- `extension.js`: the only file that requires `vscode` (activation, tree view, status bar, commands, timers,
  watchers). Not covered by the tests: check its syntax with the command below.
- `lib/`: pure logic, never requires `vscode`, tested with node: `catalog` (read one repository: `name`, `plugins`),
  `repos` (the list of repositories: `normalizeUrl`, `listRepos`, `assignNames`, `mergeCatalogs`, `normalizeIds`,
  `originUrl`, `migratedSettings`, `missingRepos`, `unlocatedRepos`, `projectRepoEntry`, `withProjectRepo`,
  `withoutProjectRepo`), `selection` (selection model, on the merged catalog), `treeModel` (`buildTree`,
  `buildChangesNode`, `buildConflictsNode`, `repoStatus`, `buildRepoNode`, `buildMissingNodes`), `materialize`
  (`holderName`, `copyRootOf`, `syncCopy`, `markCopySynced`, `resolveConflict`, `hashCache`: partial plugin copies kept
  in sync both ways), `git`, `sync` (managed clone: `syncManaged`, `localChanges`, `checkConflicts`, `gitVersionOf`, `parseStatusZ`,
  `discardLocalChanges`, `withLock`, `withLockSync`, `removeStaleIndexLock`, `removeLeftovers`, `recentlySynced`,
  `headFileArgs`, `checkRemote`), `contribute` (`commitAndPush`, `pushToBranch`, `defaultBranchName`), `cursorApi`,
  `registrar`, `remoteErrors` (`classify`, `remoteHost`, `describeRemote`, `remoteResult`: classified git failures with
  a message and the actions to offer). `git` also has `cleanProgress`.
- `scripts/`: `test.js` (test runner), `zip.js` + `package.js` (VSIX writer), `make-test-repo.js` (bare test team
  repository for live tests, from `test/fixtures/team-repo`; `--name` gives a copy another repository name), `make_icon.py` (regenerates `resources/icon.png`: three stacked package boxes on a blue rounded square, drawn from no source image: `uv run --with pillow python scripts/make_icon.py`; not packaged). Nothing under `lib/` or `scripts/`
  may require `vscode`.
- `test/`: one test file per module (`*.test.js`, `node:test`), `helpers.js` for fixtures. Tests use only local bare
  git repositories, no network. `fixtures/team-repo/` is the test team repository (plugins `review`: skills
  `code-review`, `security-check`, rule `style.mdc`; `docs`: skill `write-readme`, with a folded description);
  `make-test-repo.test.js` checks its catalog, so change the two together. `manual-remote-checks.md` is the hand
  checklist for the SSH and credential cases that tests can't cover.
- `.github/workflows/release.yml`: on a `v*` tag, checks the tag against `package.json`, runs the tests, packages,
  makes a GitHub release with the VSIX and publishes it to Open VSX when the `OVSX_PAT` secret is set (`curl` to
  `https://open-vsx.org/api/-/publish?token=`; no npm).

## Commands

With node on PATH: `node scripts/test.js`, `node scripts/package.js`. Without node, with Cursor's runtime (Git Bash,
from the repository root):

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/make-test-repo.js <target.git> [--name <marketplace name>]
```

The VSIX is written to `dist/cursor-team-plugins-<version>.vsix`. The runner passes explicit test files to
`--test`: with Cursor's runtime a directory argument fails.

Release: bump `version`, commit, `git tag v<version>`, `git push origin v<version>`.

On a Linux machine with a Cursor server (a Remote-SSH host), the suite runs with the server's node:
`~/.cursor-server/bin/linux-x64/<commit>/node scripts/test.js`.

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
- Other `vscode.cursor.*` functions throw for a non-built-in extension: use nothing but `plugins`.
- The exit code of `git rebase --autostash` can't be trusted (a stash that conflicts when re-applied exits 0, with
  conflict markers left in the files): `sync.checkConflicts` runs first.
- `git merge-tree --write-tree --name-only @{u} <git stash create>` finds the real conflicts (committed or not)
  without touching the clone: exit 1 lists the files; `stash create` skips untracked files, which are compared with
  `diff --name-only HEAD...@{u}`.
- `git.js` trims stdout: calls that parse `status -z` or read `git show` content need `{ trim: false }` (the trim drops
  the first status column and the last newline).
- `syncCopy` decides by content, not mtimes (Cursor's runtime on Windows keeps the source's mtime on copy, and mtimes
  can't tell which side changed when both did): `.team-plugins-sync.json` v2 holds each file's sha1 at the last sync (`""` =
  unknown, after a lost or old-format record) and the files in conflict. A file changed on both sides is a conflict and
  neither side is touched until the user picks one (`resolveConflict`).
- On Windows `fs.renameSync` over a file another process has open fails with EPERM: `writeManifest` retries, and a lost
  manifest write is harmless (files already equal on both sides are settled by content).
- `syncLocked` switches the managed clone (URL or branch change) only after git confirmed it: a failed git command
  (missing binary, wrong `git.path`) has empty stdout, like a clean `status`. In the extension a URL change is another
  repository (the key hashes the URL), so only a branch change switches a clone.
- `localChanges` throws when `git status` fails (a failure must never read as "no changes"): the view shows a
  `changes.error` node and the commands report it.
- Windows refuses to delete or rename the parent of a registered plugin folder (EPERM, in every window that
  registered it); the registered folder itself can be deleted. So a URL or branch change switches the managed clone
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

## Rules

- Never run `cursor --install-extension` or launch Cursor from an agent unless the user asks.
- Don't add dependencies, TypeScript or a bundler.
- Keep README (user documentation) in step with settings, commands and behaviour; implementation details, platform
  quirks and limits that only matter to developers go to `docs/development.md`, not the README.
