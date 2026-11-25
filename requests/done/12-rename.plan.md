# Plan 12: rename a plugin or an item

## Context

- Repository: cursor-team-plugins (Cursor extension, plain JavaScript, CommonJS, no dependency). Request:
  `requests/12-rename.md`. Branch `request/12-rename` (already created). Version 0.8.0 -> **0.8.1**.
- Files and functions involved:
  - `lib/authoring.js`: `KINDS`, `nameError`, `serverNameError`, `clashError`, `pluginLocation`, `renameIds` (l. 340),
    the private `exists`, `readJson`, `isPlainObject` (export what the new module needs: `exists`, `readJson`).
  - `lib/share.js`: `renameSkillName(text, oldName, newName)` (l. 132): rewrites the frontmatter `name:` when it equals
    `oldName`; reused for every kind.
  - `lib/catalog.js`: `readCatalog` (l. 294) reads `marketplace.json`; `mcpServerNames`, `serverTable`.
  - `lib/repos.js`: `assignNames` (l. 239), `mergeCatalogs` (l. 262), `normalizeIds` (l. 300).
  - `extension.js`: `userSelection` (l. 236), `projectList` (l. 245), `doApply` (l. 626), `migrateIds` (l. 724),
    `newItemCommand` (l. 1808, the input-box pattern to follow), `moveDraftCommand` (l. 1932, the unregister / lock /
    `renameIds` / Commit-and-push pattern to follow), command registration (`reg(...)`, l. 2372-2378), `treeView`
    (created l. 2936).
  - `package.json`: `contributes.commands`, `menus`, a new `keybindings`, `version`.
  - New: `lib/rename.js`, `test/rename.test.js`, `test/live/rename.live.js`.

## Measured facts (don't measure them again)

1. **A registered plugin folder and the items inside it can be renamed in place** with `fs.renameSync`, while the
   plugin is registered and after it is unregistered: a throwaway scenario in the isolated Cursor (`scripts/live-test.js`,
   Cursor 3.32.4, 2026-11-25) renamed `<clone>/review/skills/code-review` and back, `<clone>/review/rules/style.mdc`
   and back, the registered `<clone>/review` itself while registered and back, and again after unticking it:
   every call returned `ok`, and `readdir` of the clone then listed `review-renamed`. So no copy-and-delete fallback.
   The plugin is still unregistered first (the request asks it; it is what Move does).
2. **Cursor's own `marketplace.json` reader ignores unknown keys**: its zod schemas in
   `$LOCALAPPDATA/Programs/cursor/resources/app/extensions/cursor-agent-host/dist/4846.js` never call `.strict()` on
   the marketplace or plugin objects (`grep -c "\.strict()"` gives 1, on a JSON-schema definition). A `renamed` key
   breaks nothing for a repository that is also imported as a Cursor marketplace.
3. A command run from a keybinding in a custom tree view is not guaranteed to receive the tree element: the command
   falls back to `treeView.selection[0]` (not probed: key presses can't be automated, see request 11 in `ideas.md`).
4. Ids: plugin `<repo>:<plugin name>`; skill `<repo>:<plugin>/skills/<folder>`; rule `<repo>:<plugin>/rules/<file
   with extension>`; command `.../commands/<file>`; agent `.../agents/<file>`; MCP server `.../mcp/<name>`
   (`catalog.readChildren`, `repos.mergeCatalogs`). The plugin name is `plugin.json`'s `name`, else the marketplace
   entry's `name`, else the folder name.
5. From the project notes, not checked again: the parent of a registered folder can't be renamed on Windows (so the
   plugin folder is renamed, never the clone or a `filtered/` holder); a partial copy syncs both ways, so pending copy
   edits are flushed first (`flushPartials`) and a renamed plugin's copy is dropped from `partialCopies`; the state
   files `state/<key>.json` are watched (any write there triggers an apply in every window): don't store anything new
   in them.
6. `scripts/test.js` picks up every `test/*.test.js` by itself; `scripts/package.js` packages all of `lib/`.

## Design

### Rules of a rename (`lib/rename.js`)

Pure module, never requires `vscode`. Errors are returned as `{ error }`, never thrown (like `authoring.js`). Every
check happens before the first file changes; a failure after the first change reverts what was done (best effort:
move back, restore the texts read before) and returns `{ error }`.

`renameItem(item, newName, { repoDir, record })` -> `{ id, file }` or `{ error }`
- `item`: `{ pluginDir, pluginName, kind, name, file }` (`kind`: `skill|rule|command|agent|mcp`; `name`: the catalog
  name; `file`: the catalog file: `SKILL.md` for a skill, the item file, or an MCP file). `newName` is trimmed.
- Name check: `serverNameError` for `mcp`, else `nameError`. `newName === name` -> `{ error: 'That is already its name.' }`.
- Old and new local ids (no repository part) and paths:
  - skill: `from = path.dirname(file)`, old folder `path.basename(from)`; `to = <pluginDir>/skills/<newName>`;
    ids `<pluginName>/skills/<old folder>` -> `<pluginName>/skills/<newName>`.
  - rule, command, agent: `base = path.basename(file)`, `ext = path.extname(base)` (kept); `to = <dirname(file)>/<newName><ext>`;
    ids `<pluginName>/<KINDS[kind].folder>/<base>` -> `<pluginName>/<folder>/<newName><ext>`.
  - mcp: ids `<pluginName>/mcp/<name>` -> `<pluginName>/mcp/<newName>`.
- Clash: skill, rule, command, agent: `clashError(pluginDir, kind, newName)` (all extensions: `rules/x.md` blocks
  renaming a rule to `x`). mcp: for each of `.mcp.json`, `mcp.json` that exists and parses to a plain object, if
  `mcpServerNames(obj)` has `newName` -> `` `${fileName} already has a server named ${newName}` ``. A file that doesn't
  parse is skipped (the catalog skipped it too). No file has the old name -> `` `no MCP file of ${pluginName} has a server named ${name}` ``.
- Change:
  - skill: `fs.renameSync(from, to)`, then in `<to>/SKILL.md` apply `renameSkillName(text, oldFolder, newName)`
    (writes only when the text changed).
  - rule, command, agent: `fs.renameSync(file, to)`, then `renameSkillName(text, name, newName)` on `to`.
  - mcp: in every parseable file whose `mcpServerNames` has `name`: rename the key **in place** (rebuild the object,
    same key order) in `serverTable(obj)` when there is one (`obj.mcpServers = renamed table`), else at the top level;
    write `JSON.stringify(obj, null, 2) + '\n'`.
- `record` true: then write the record (below). Result `file`: `<to>/SKILL.md` for a skill, `to` for a rule, command
  or agent, the first MCP file changed for mcp.

`renamePlugin(plugin, newName, { repoDir, record })` -> `{ id, dir }` or `{ error }`
- `plugin`: `{ dir, pluginName }`. Name check `nameError`; `newName === pluginName` -> same error as above.
- `location = pluginLocation(repoDir)` (error passed through). `newDir = path.join(path.dirname(plugin.dir), newName)`:
  the folder always becomes the new name (Cursor names a registered plugin after its folder).
- Refused: `exists(newDir)` -> `` `${relative(repoDir, newDir) with '/'} already exists` ``; a plugin of
  `readCatalog(repoDir)` or a marketplace entry named `newName` -> `` `a plugin named ${newName} already exists in this repository` ``.
- `plugin.json` (`<dir>/.cursor-plugin/plugin.json`), when it exists: parsed first (error
  `` `plugin.json: ${err.message}` `` or `plugin.json is not a JSON object`); `name` set to `newName` (an existing key
  keeps its place; a missing one is put first: `{ name: newName, ...manifest }`), written to the moved folder.
- `marketplace.json`, when `location.marketplace` is set (it lists the plugins): the entry whose source resolves to
  `plugin.dir` (resolve like `readCatalog`: a string `source` or `source.path` against `location.root`; compare with
  `path.resolve`, lower-cased on Windows). None -> `` `marketplace.json has no entry for ${basename(plugin.dir)}` ``.
  The entry gets `name: newName` and its source `./<posix relative(location.root, newDir)>` (in `source.path` when the
  source is an object).
- Change: `fs.renameSync(plugin.dir, newDir)`, write `plugin.json`, then write `marketplace.json` once (entry and
  record together) when either changed. Result `{ id: newName, dir: newDir }`.

The record (`record` true: managed and local clones; false for drafts, whose ids only this user's lists hold)
- File `<repoDir>/.cursor-plugin/marketplace.json`, created (with its folder) as `{ "renamed": { ... } }` when missing:
  a file with no `plugins` and no `name` changes neither the repository's name nor how its plugins are found. An
  existing file that doesn't parse, isn't an object, or whose `renamed` isn't a plain object -> error before any
  change (`` `marketplace.json: ${err.message}` ``, `marketplace.json is not a JSON object`,
  `marketplace.json: "renamed" is not an object`).
- `recordRename(renamed, oldId, newId)` (exported, pure, returns a new object), ids local:
  1. copy every entry except the key `newId` (that id is live again);
  2. a value equal to `oldId` becomes `newId`; a value starting with `oldId + '/'` becomes `newId + rest`;
  3. drop an entry whose value now equals its key (a rename back);
  4. set `oldId -> newId`.
  The map stays flat: no chain to follow in the normal case.
- Written with `JSON.stringify(obj, null, 2) + '\n'` (the known reformatting limitation applies).

### Reading ids through the records (`lib/catalog.js`, `lib/repos.js`)

- `readCatalog` returns `renamed` (always, `{}` by default): the `renamed` of `marketplace.json` when it is a plain
  object, keeping only entries whose key and value are non-empty strings and differ. Read whether or not the file has
  `plugins`. Present but not a plain object -> warning `marketplace.json: "renamed" is not an object`.
- `mergeCatalogs(entries)` also returns:
  - `renamed`: a `Map` `<repo>:<old id>` -> `<repo>:<new id>` from each entry's `catalog.renamed` (`desc.name` prefix).
  - `formerNames`: a `Map` `<old repository name>` -> `desc.name`, from each entry's `desc.formerNames` (array, may be
    missing), skipping a name that is the `desc.name` of any entry and a name already mapped (first entry wins).
- `normalizeIds(catalog, list)`: after the existing 0.4 step, each id goes through `followRenames(catalog, id)`
  (exported), then the result is de-duplicated and sorted as today. Missing `catalog.renamed` / `formerNames` (catalogs
  built by hand in tests) count as empty.
- `followRenames(catalog, id)`, exactly:
  1. `known(x)`: some plugin has `name === x` or a child with `id === x`. `known(id)` -> return `id` (an existing
     plugin or item is never redirected, so a new skill that reuses an old name works).
  2. `cur = id`; repository part `repo = repoOfId(cur)`: when `formerNames` has `repo`, `cur = formerNames.get(repo) +
     cur.slice(repo.length)`.
  3. Up to 10 times: stop when `known(cur)`; `next = renamed.get(cur)`; else, when `cur` has a `/`, `p = cur` up to
     its first `/` and `next = renamed.get(p) + cur.slice(p.length)` when `renamed.has(p)`; stop when there is no
     `next` or `next` was already seen; `cur = next`.
  4. Return `cur` (the last id reached, even if not known: harmless in a list).

### Repository renames detected by the extension

- `lib/repos.js` gets `rememberNames(memory, descs, readable)` -> `{ memory, changed, renamed }`, pure:
  - `memory`: the parsed `<storage>/repo-names.json`, `{ "<key>": { "name": "...", "former": ["..."] } }` (anything
    else reads as `{}`; an entry without a string `name` is ignored).
  - For each desc with `kind` `managed` or `local`, no `duplicateOf`, no `hiddenBy`, and `readable(d)` true: no entry ->
    `{ name: d.name, former: [] }` (changed); entry with another name -> `former = unique([...former, old name])`
    without `d.name`, `name = d.name` (changed, and `{ key, from, to }` pushed to `renamed`). Other entries kept as they
    are. Returns a new object; the input is not mutated.
- `extension.js` `doApply`, right after `descs = assignNames(...)`: read `repo-names.json` (missing or bad -> `{}`),
  `rememberNames(memory, descs, (d) => catalogs.has(d.key) && fs.existsSync(d.dir))` (a clone not made yet still has its
  URL's name: never recorded), write the file when `changed` (`JSON.stringify(memory, null, 2)`, inside try/catch,
  failure logged), log each rename `repository <from> is now named <to>: its old ids are read with the new name`, then
  set `formerNames` on each desc from `memory[d.key].former` before `mergeCatalogs`. The file is **not** under
  `state/` (the state watcher would fire on every write).
- `migrateIds` already rewrites the user's `enabled`/`excluded` whenever `normalizeIds` changes them: it now also covers
  renames. Its log line becomes `teamPlugins.${key}: ids updated (0.4 ids, or renamed repositories, plugins or items)`.
  Projects' lists keep being read through `normalizeIds` and written only by **Add to this project** / **Remove from
  this project** (which already normalize first).

### The command (`extension.js`, `package.json`)

- `package.json`:
  - command `{ "command": "teamPlugins.rename", "title": "Rename", "category": "Team Plugins" }` (after `moveDraft`);
  - `view/item/context`: `{ "command": "teamPlugins.rename", "when": "view == teamPlugins.plugins && viewItem =~ /^(plugin|child)/", "group": "3_edit@1" }`;
  - `commandPalette`: `{ "command": "teamPlugins.rename", "when": "false" }`;
  - new `contributes.keybindings`: `[{ "command": "teamPlugins.rename", "key": "f2", "when": "focusedView == teamPlugins.plugins && !inputFocus" }]`;
  - `version` `0.8.1`.
- `renameCommand(node)`, registered as `reg('teamPlugins.rename', renameCommand)` next to `moveDraft`:
  1. `target = node || (treeView && treeView.selection[0])`. Only `target.kind === 'plugin'` or an item kind
     (`skill`, `rule`, `command`, `agent`, `mcp`) goes on; anything else returns silently (F2 on a repository row).
  2. Plugin: `catalog.plugins.find((p) => p.name === target.key)`. Item: the plugin with a child of `id === target.key`,
     and that child. `repo = descs.find((d) => d.key === plugin.repoKey)`. Any missing -> return.
  3. `label` = `plugin`, or `authoring.KINDS[child.kind].label`; `oldName` = `plugin.pluginName` or `child.name`.
     `ui.showInputBox({ prompt: \`New name for the ${label} ${oldName}\`, value: oldName, valueSelection: [0, oldName.length],
     ignoreFocusOut: true, validateInput })`; `validateInput(v)`: `t = v.trim()`; `t === oldName` -> `null`; the name
     rule (`serverNameError` for mcp, else `nameError`); plugin: another plugin of the same repository
     (`p.repoKey === plugin.repoKey && p.pluginName === t`) -> `` `${labelOf(repo)} already has a plugin named ${t}` ``;
     item: `plugin.children.some((c) => c.kind === child.kind && c.name === t)` ->
     `` `${plugin.pluginName} already has a ${label} named ${t}` ``; else `null`.
  4. Cancelled, or the trimmed name equals `oldName` -> return.
  5. `await flushPartials()`. Then `result = await enqueue(async () => { ... })`: for a plugin, `await
     registrar.remove(plugin.name)` first (when `registrar`); then `withRepoLock(repo, () => ...)` calls
     `rename.renamePlugin({ dir: plugin.dir, pluginName: plugin.pluginName }, t, { repoDir: repo.dir, record })` or
     `rename.renameItem({ pluginDir: plugin.dir, pluginName: plugin.pluginName, kind: child.kind, name: child.name,
     file: child.file }, t, { repoDir: repo.dir, record })`, `record = repo.kind !== 'drafts'`; for a plugin with no
     error, `partialCopies.delete(plugin.name)` inside the lock (its copy must not sync back into the old folder).
  6. `null` (busy, already warned) or `{ error }` (shown as `` `Team plugins: ${error}` ``): `await apply()` (a plugin
     was unregistered) and return.
  7. `from` = `plugin.name` or `child.id`; `to = \`${plugin.repo}:${result.id}\``. Rewrite `enabled` and `excluded`
     with `authoring.renameIds(current, from, to)` exactly as `moveDraftCommand` does, then `await apply()` and
     `log(\`renamed ${label} ${from} to ${to}\`)`.
  8. Message: managed -> `` `Renamed ${oldName} to ${t} in ${labelOf(repo)}: it is in the repository's Local changes. Commit and push to share it.` ``
     with the **Commit and push** button wired like `moveDraftCommand`; local ->
     `` `Renamed ${oldName} to ${t} in your clone ${repo.dir}: commit and push it with your own git tools.` ``;
     drafts -> no message (the view shows it).

## Impact

- `normalizeIds` callers (`userSelection`, `projectList`, `migrateIds`, `addToProjectCommand`,
  `removeFromProjectCommand`): no change; they all get renames for free. `migrateIds` only changes its log text.
- `mergeCatalogs` callers (`doApply`, tests): the new `renamed` / `formerNames` fields are extra; nothing else reads
  them. `selection.js` and `treeModel.js` are untouched.
- `readCatalog` callers (`authoring.placePlugin`, `doApply`, `make-test-repo.test.js`, catalog tests): a new `renamed`
  field only; check `make-test-repo.test.js` and `catalog.test.js` still pass (no deep equality on whole catalogs).
- `listConfigured()` (used by the status bar and commands outside `doApply`) builds descs without `formerNames`: fine,
  only `mergeCatalogs` reads them.
- `authoring.js`: export `exists` and `readJson` (no behaviour change).

## Not handled (say so in `docs/development.md` Known limits; the first two also in the README limitations)

- References to the old name inside other files (a skill naming another, a rule linking a file) are not updated.
- Someone who starts following a repository only after it was renamed reads a project's old `<old name>:...` ids as
  unknown (re-add them to the project once).
- Records are never pruned (they can be deleted by hand once every teammate has synced).
- A case-only rename of a folder named by hand (`Review` -> `review` on Windows) is refused as "already exists".
- 0.4 bare ids of a renamed plugin are not followed.
- An editor open on a renamed file is not reopened on the new path.
- No command renames a repository: edit the `name` of its `marketplace.json`.

## Tests

`test/rename.test.js` (new; use `helpers.tmpDir`, `makePlugin`, `writeFile`):
- `recordRename`: `({}, 'a', 'b')` -> `{ a: 'b' }`; `({ a: 'b' }, 'b', 'c')` -> `{ a: 'c', b: 'c' }`;
  `({ a: 'b' }, 'b', 'a')` -> `{ b: 'a' }` (a->a dropped); `({ 'p/skills/x': 'p/skills/y' }, 'p', 'q')` ->
  `{ 'p/skills/x': 'q/skills/y', p: 'q' }`; `({ c: 'd' }, 'x', 'c')` -> `{ x: 'c' }` (key `c` live again); input not mutated.
- `renameItem` skill in a repository with a marketplace listing the plugin: folder renamed, `name:` rewritten,
  other `SKILL.md` text unchanged, result `{ id: 'review/skills/new', file: <.../skills/new/SKILL.md> }`,
  `renamed` = `{ 'review/skills/old': 'review/skills/new' }`, plugin entry untouched.
- skill whose frontmatter `name` differs from the folder: `name:` left as it was.
- rule `style.mdc` -> `styling`: file `rules/styling.mdc`, id `review/rules/styling.mdc`; a `rules/styling.md`
  already there -> `{ error: 'rules/styling.md already exists' }` and nothing changed.
- command `x.txt` -> `y`: `commands/y.txt`; agent with `name: x` -> `name: y`; command without a `name:` -> text
  unchanged.
- bad name (`Bad Name`) -> `{ error: NAME_RULE }`; MCP bad name -> `{ error: SERVER_RULE }`; same name -> error.
- mcp in the `mcpServers` form with servers `a`, `b`, `c`: rename `b` -> `z` keeps order `a, z, c` and `b`'s entry;
  top-level form likewise; a server present in both `.mcp.json` and `mcp.json` is renamed in both; `newName` taken in
  either file -> error naming that file, no file changed.
- `record: false`: no `marketplace.json` created. Repository without `marketplace.json` and `record: true`: file
  created as exactly `{ "renamed": { ... } }`, and `readCatalog(repo)` still finds the plugins by folder scan with
  `name === ''`.
- `marketplace.json` that doesn't parse, with `record: true` -> error and the item not renamed.
- `renamePlugin` with a marketplace (entry `{ name: 'review', source: './review', description }`): folder `audit`, `plugin.json` `name: 'audit'` (other keys and
  their order kept), entry `{ name: 'audit', source: './audit', description }`, `renamed` `{ review: 'audit' }`,
  result `{ id: 'audit', dir }`; `readCatalog` lists `audit` with its skills.
- `renamePlugin` with `metadata.pluginRoot`: source written relative to the plugin root.
- `renamePlugin` whose `plugin.json` has no `name`: `name` added first.
- `renamePlugin` folder scan (no marketplace) and `record: false`: folder and `plugin.json` only, no marketplace file.
- `renamePlugin` to a name another plugin has, or to an existing folder -> error, nothing changed.

`test/catalog.test.js`: `readCatalog` returns `renamed` filtered (non-string, empty and self entries dropped), `{}`
when absent, a warning when it is not an object, read also when the file has no `plugins`.

`test/repos.test.js`:
- `mergeCatalogs` prefixes `renamed` with the repository name and builds `formerNames`, skipping a former name that is
  a loaded repository's name.
- `followRenames` / `normalizeIds`: with repository `team` (plugins `review` with skill `new`, `audit`) and
  `renamed` `{ 'team:review/skills/old': 'team:review/skills/new', 'team:docs': 'team:audit' }`:
  `team:review/skills/old` -> `team:review/skills/new`; `team:docs` -> `team:audit`; `team:docs/skills/w` ->
  `team:audit/skills/w`; an existing id equal to a record key is kept (add a key `team:review` -> `team:x`: `team:review`
  stays); a cycle (`team:a` -> `team:b`, `team:b` -> `team:a`, neither known) ends; unknown repository ids unchanged;
  `formerNames` `old` -> `team`: `old:review` -> `team:review`, `old:docs/skills/w` -> `team:audit/skills/w`; the
  result is de-duplicated and sorted (`['team:docs', 'team:audit']` -> `['team:audit']`).
- `rememberNames`: first sight records names, `changed: true`; same names -> `changed: false`, same object content;
  a new name -> `former` holds the old one and `renamed` lists it; renamed back (`a` -> `b` -> `a`) -> `former: ['b']`;
  duplicate, hidden, drafts and `readable` false descs ignored; other keys kept; input not mutated; garbage memory
  (`null`, an array) reads as `{}`.

`test/live/rename.live.js` (new scenario; follow `contribute.live.js`; `timeoutSec: 150`):
- setup: the team repository, `repositories: [url]`, `enabled: ['team-test:review', 'team-test:docs/skills/write-readme']`.
- wait for `team-test:review` registered; note the clone (`path.dirname(registered)`).
- rename the skill: `hook.respond` answers the input box whose prompt is `New name for the skill code-review` with
  `review-code`; `executeCommand('teamPlugins.rename', t.find('item:team-test:review/skills/code-review'))`. Check
  `review/skills/review-code/SKILL.md` exists with `name: review-code`, the old folder is gone, `marketplace.json`'s
  `renamed` has `review/skills/code-review -> review/skills/review-code`, the tree has the new item node, the
  information message starts with `Renamed code-review to review-code in team-test`, and `changes:<key>` appears.
- rename the plugin `docs` -> `guides` (input box `New name for the plugin docs`): `enabled` now holds
  `team-test:guides/skills/write-readme`; `hook.registrations()['team-test:guides']` ends with `guides`; the Cursor
  Plugins log has `Registered extension plugin: guides from`; `marketplace.json` entry `{ name: 'guides', source:
  './guides' }` and `renamed.docs === 'guides'`; `guides/.cursor-plugin/plugin.json` `name` is `guides`.
- a teammate's old id: update `teamPlugins.excluded` (Global) to `['team-test:review/skills/code-review']`; wait until
  it reads `['team-test:review/skills/review-code']`.
- repository rename: rewrite the clone's `marketplace.json` with `name: 'team-renamed'` (keep the rest); wait until
  `enabled` holds `team-renamed:review` and `team-renamed:guides/skills/write-readme`, and
  `<hook.storage>/repo-names.json` has `former` `['team-test']` for the repository's key.

## Keep in step

- `README.md`, **Writing plugins**: a **Rename** bullet after **Move to a repository**: right-click a plugin or an
  item, or select it and press F2; what is renamed (plugin: folder, `plugin.json` name, marketplace entry; skill:
  folder and its `name`; rule, command, agent: file and its `name` when there is one; MCP server: its key); in a
  repository the change is recorded in `marketplace.json` (`renamed`) so teammates' choices and projects' lists follow
  the new name at their next sync; a local change to commit like any other. **Known limitations**: replace the
  "Renaming a repository ..." line with: renaming a repository (its `marketplace.json` `name`) keeps the choices of
  people who already follow it; someone who starts following it later re-adds a project's items once. Add: a rename
  doesn't update references to the old name in other files.
- `docs/development.md`: **How it works**, a Rename paragraph after the authoring one (record format and flattening,
  `followRenames` order, existing ids never redirected, `repo-names.json` and why it is not under `state/`, plugin
  unregistered first and its partial copy dropped, `flushPartials` first, rename in place measured on a registered
  folder). **Known limits (details)**: replace the repository-rename line; add the Not handled list.
- `AGENTS.md`: version `0.8.1`; layout: `rename` (`renamePlugin`, `renameItem`, `recordRename`) and, in `repos`,
  `followRenames`, `rememberNames`; `catalog`'s `renamed`; in **Why the code is shaped this way**, one bullet: a
  registered plugin folder can be renamed in place (probe, Cursor 3.32.4) but is unregistered first; `renamed` in
  `marketplace.json` is safe because Cursor's marketplace schema ignores unknown keys; existing ids never redirected;
  repository names remembered in `repo-names.json` outside `state/`.
- `package.json`: command, menu, keybinding, palette entry, version `0.8.1`.

## Commands

From the repository root, Git Bash:

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js rename
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
```

A failed live scenario writes its steps and log to `%TEMP%\tp-live\out\<scenario>\result.json`.

## Don't

- No commit. Don't edit `requests/12-rename.md` or this plan.
- No change outside the listed files without reporting it.
- Never run `cursor --install-extension` or launch the user's own Cursor; `scripts/live-test.js` is allowed.
- No dependency, no TypeScript, no bundler. Nothing under `lib/` requires `vscode`.
- Don't store anything in `state/<key>.json` (watched).
- Count dialog call sites with a multiline search (`vscode\.window\s*\.\s*show`) if you need to: every new dialog goes
  through `ui`, never `vscode.window` directly.

## Changes after review

- `renameCommand` falls back to `treeView.selection[0]` whenever its argument is not a plugin or item node (not only
  when it is missing).
- `test/live/rename.live.js` calls the command with `{ kind, key }` (`t.find` returns a snapshot without them), and has
  one more step: renaming `review` while it is registered from a partial copy (its excluded skill) registers `audit`
  from a new copy, the excluded id follows, and the old `review` folder does not come back in the clone.
- Hand check in Cursor 3.32.4: clicking an item opened its file and moved the focus to the editor, so F2 reached the
  editor ("renaming is not supported here"). `teamPlugins.openItem` now opens a preview that keeps the focus in the
  view (`{ preview: true, preserveFocus: true }`, like the Explorer's single click); F2 then renamed the item (checked by
  hand). `renameCommand` uses the module's `ITEM_KINDS` instead of its own copy.
