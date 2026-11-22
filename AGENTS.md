# cursor-team-plugins: developer notes

Cursor (VS Code) extension, version in `package.json` (0.2.3). Plain JavaScript, CommonJS, no npm dependency, no
build step. User documentation: `README.md`.

## Layout

- `extension.js`: the only file that requires `vscode` (activation, tree view, status bar, commands, timers,
  watchers). Not covered by the tests: check its syntax with the command below.
- `lib/`: pure logic, never requires `vscode`, tested with node: `catalog` (read the team repo), `selection`
  (selection model), `treeModel` (`buildTree`, `buildChangesNode`, `buildConflictsNode`), `materialize` (`holderName`,
  `copyRootOf`, `syncCopy`, `markCopySynced`, `resolveConflict`, `hashCache`: partial plugin copies kept in sync both
  ways), `git`, `sync` (managed clone: `syncManaged`, `localChanges`, `checkConflicts`, `gitVersionOf`, `parseStatusZ`,
  `discardLocalChanges`, `withLock`, `withLockSync`, `removeStaleIndexLock`, `removeLeftovers`, `recentlySynced`),
  `contribute` (`commitAndPush`, `pushToBranch`, `defaultBranchName`), `cursorApi`, `registrar`.
- `scripts/`: `test.js` (test runner), `zip.js` + `package.js` (VSIX writer), `make-test-repo.js` (bare test team
  repository for live tests, from `test/fixtures/team-repo`), `make_icon.py` (regenerates `resources/icon.png`: three stacked package boxes on a blue rounded square, drawn from no source image: `uv run --with pillow python scripts/make_icon.py`; not packaged). Nothing under `lib/` or `scripts/`
  may require `vscode`.
- `test/`: one test file per module (`*.test.js`, `node:test`), `helpers.js` for fixtures. Tests use only local bare
  git repositories, no network. `fixtures/team-repo/` is the test team repository (plugins `review`: skills
  `code-review`, `security-check`, rule `style.mdc`; `docs`: skill `write-readme`, with a folded description);
  `make-test-repo.test.js` checks its catalog, so change the two together.

## Commands

With node on PATH: `node scripts/test.js`, `node scripts/package.js`. Without node, with Cursor's runtime (Git Bash,
from the repository root):

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/make-test-repo.js <target.git>
```

The VSIX is written to `dist/cursor-team-plugins-<version>.vsix`. The runner passes explicit test files to
`--test`: with Cursor's runtime a directory argument fails.

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
  (missing binary, wrong `git.path`) has empty stdout, like a clean `status`.
- Windows refuses to delete or rename the parent of a registered plugin folder (EPERM, in every window that
  registered it); the registered folder itself can be deleted. So a URL or branch change switches the managed clone
  in place (`switchInPlace`: fetch the branch into `refs/team-plugins/switch`, `checkout -B`, then `set-url`, the
  upstream and the other branches; the URL changes last so a failed step is retried), never deletes it.
- An empty `teamPlugins.branch` is resolved at each sync with `git ls-remote --symref <url> HEAD` (`origin/HEAD` is
  only the default at clone time).
- Every operation that changes the managed clone holds the lock file: `withLock` (sync, commit and push, push to a
  branch, discard; the lock's mtime is refreshed every minute, so a 30-minute clone is never taken for a stale lock)
  and `withLockSync` (partial-copy syncs, conflict resolution). Within a window they also go through the operation
  queue (`enqueue`).
- Links (symlinks, junctions) in a plugin: `listFiles` follows them only inside the repository; a junction reads as
  `isSymbolicLink()`, never `isDirectory()`.
- `fs.rmSync` fails with EPERM on git's read-only files with Cursor's runtime on Windows: use `sync.removeTree`.
- Partial-copy hashes are cached per window (`hashCache`, by full path): the key holds size, mtime, ctime, birthtime and
  ino because a copy keeps the source's mtime and ctime on Windows; a file changed less than 2 s ago is never cached
  (two writes in one clock tick share their timestamps); the module's own writes and deletions drop their entry.
- A path of the copy under a skill or rule left out of the selection never reaches the clone: deleted from the copy when
  unchanged since the last sync, otherwise left there and reported.
- Tree ids are `plugin:<name>` and `item:<id>` (a plugin named `changes` would collide with a built-in node); the
  selection id is the node's `key`.
- `merge-tree --write-tree` needs git 2.38: `checkConflicts` checks `git version` first.
- Timed syncs are skipped when `sync-state.json` records another window's sync younger than half the interval
  (`recentlySynced`); every window touches its registered copies every hour so another window's 7-day cleanup never
  removes them.

## Rules

- Never run `cursor --install-extension` or launch Cursor from an agent unless the user asks.
- Don't add dependencies, TypeScript or a bundler.
- Keep README (user and author documentation) in step with settings, commands and behaviour.
