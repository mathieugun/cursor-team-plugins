# cursor-team-plugins: developer notes

Cursor (VS Code) extension, version in `package.json` (0.2.0). Plain JavaScript, CommonJS, no npm dependency, no
build step. User documentation: `README.md`.

## Layout

- `extension.js`: the only file that requires `vscode` (activation, tree view, status bar, commands, timers,
  watchers). Not covered by the tests: check its syntax with the command below.
- `lib/`: pure logic, never requires `vscode`, tested with node: `catalog` (read the team repo), `selection`
  (selection model), `treeModel` (`buildTree`, `buildChangesNode`), `materialize` (`holderName`, `syncCopy`: partial
  plugin copies kept in sync both ways), `git`, `sync` (managed clone: `syncManaged`, `localChanges`, `checkConflicts`,
  `parseStatusZ`, `discardLocalChanges`), `contribute` (`commitAndPush`, `pushToBranch`, `defaultBranchName`),
  `cursorApi`, `registrar`.
- `scripts/`: `test.js` (test runner), `zip.js` + `package.js` (VSIX writer), `make_icon.py` (regenerates `resources/icon.png`: three stacked package boxes on a blue rounded square, drawn from no source image: `uv run --with pillow python scripts/make_icon.py`; not packaged). Nothing under `lib/` or `scripts/`
  may require `vscode`.
- `test/`: one test file per module (`*.test.js`, `node:test`), `helpers.js` for fixtures. Tests use only local bare
  git repositories, no network.

## Commands

With node on PATH: `node scripts/test.js`, `node scripts/package.js`. Without node, with Cursor's runtime (Git Bash,
from the repository root):

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
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
- Under Cursor's runtime on Windows `fs.copyFileSync` keeps the source file's modification time: `syncCopy` compares
  the copy's mtime with the last sync time in `.team-plugins-sync.json`, and a copy never gets a fresh mtime to rely on.
- `fs.rmSync` fails with EPERM on git's read-only files with Cursor's runtime on Windows: use `sync.removeTree`.

## Rules

- Never run `cursor --install-extension` or launch Cursor from an agent unless the user asks.
- Don't add dependencies, TypeScript or a bundler.
- Keep README (user and author documentation) in step with settings, commands and behaviour.
