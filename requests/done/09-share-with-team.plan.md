# Plan 09: Share with team

## Context

- Repository: cursor-team-plugins (Cursor extension, plain CommonJS, no dependency, no build). Read `AGENTS.md` first.
- Request: `requests/09-share-with-team.md`.
- Version: 0.7.0 -> **0.8.0** (`package.json` `version`).
- Branch: `request/09-share-with-team` (already checked out). Do not commit.
- What exists and is reused:
  - `lib/authoring.js`: `KINDS` (kind -> `{ folder, label }`), `EXISTING` (kind -> files that clash, not exported),
    `nameError`, `createItem` (lines ~128-148; its clash loop is what becomes `clashError`), `declaredPathsError`.
  - `lib/sync.js`: `removeTree`.
  - `extension.js`:
    - `authoringTargets`, `targetPickItem`, `withRepoLock`, `enableNew` (lines 1649-1692);
    - `newPluginCommand` (1694-1771, split in two below);
    - `newItemCommand` (1773-1895): the model for the plugin pick, `declaredPathsError`, the lock, the apply, finding
      the child by `samePath`, `enableNew`, `showTextDocument`;
    - `moveDraftCommand` (1897-2004): the model for the closing messages and the **Commit and push** button
      (`executeCommand('teamPlugins.commitAndPush', { repo: target.key })`);
    - `registerCommands` (2006-): the `reg('teamPlugins.newPlugin', ...)` lines are at ~2106;
    - helpers: `log` (90), `labelOf` (193), `samePath` (198), `enqueue` (282), `apply`, `catalog`, `descs`,
      `BUSY_TEXT` (47).
  - `package.json`: `contributes.commands` (the authoring commands end at `teamPlugins.moveDraft`, ~line 294),
    `contributes.menus` (`view/title`, `view/item/context`, `commandPalette`).

## Measured facts (don't measure them again)

1. **`resourcePath` in a `when` clause** is `uri.fsPath` for a `file:` URI (backslashes on Windows), else `uri.path`
   (forward slashes, Remote-SSH). Source: Cursor 3.31 `workbench.desktop.main.js`:
   `uriToPath(e){return e.scheme===Re.file?e.fsPath:e.path}` and `this._pathKey.set(e?this.uriToPath(e):null)`. So
   every path regex accepts both separators: `[\\/]`.
2. **The when-clause lexer** scans a `/regex/` literal and knows escapes and character classes: `/` inside `[...]`
   does not end it. Source: same file, `_regex(){... s===Ht.Slash&&!n ... OpenSquareBracket?n=!0:...Backslash?i=!0
   ...CloseSquareBracket&&(n=!1)}`. The extension already uses `=~` in its menus.
3. **What an Explorer context command receives:** `(clickedUri, selectedUris)`. The menu is shown with
   `menuActionOptions:{arg:s,shouldForwardArgs:!0}` (`s` = the clicked resource). Its context is
   `n.map(o=>o.resource)`, all the selected resources, when the clicked one is part of the selection, else
   `[clicked]`. The context keys (and so the `when`) are set for the clicked element only (`this.setContextKeys(t)`).
   So the other selected URIs may not be shareable: filter them.
4. **The exact `when` string below** was parsed from JSON under Cursor's runtime, and its two regexes were tested:
   - matched: `d:\p\.cursor\skills\code-review` (folder), `/home/u/p/.cursor/skills/x` (folder),
     `d:\p\.cursor\rules\a.mdc`, `d:\p\.cursor\rules\sub\a.md`, `/p/.cursor/skills/x/SKILL.md`,
     `/p/.cursor/commands/c.markdown`;
   - not matched: `d:\p\.cursor\skills\x\scripts` (folder), `/p/.cursor/rules/a.txt`,
     `/p/.cursor/skills/x/scripts/a.md`, `/p/.cursor/agents/a.txt`,
     `/s/.cursor/plugins/repos/r/review/skills/x/SKILL.md`, `/p/x.cursor/rules/a.mdc`.
5. **Copying under Cursor's runtime** (node 24.22.1, Windows), all three tested:
   - `fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false, filter })`, with a filter returning
     `!fs.lstatSync(s).isSymbolicLink()`, skips a junction and a file symlink and copies the rest (`SKILL.md`,
     `scripts/a.py`). The filter is called with the absolute source path of each entry.
   - `cpSync` onto existing files with `errorOnExist: true, force: false` throws `ERR_FS_CP_EEXIST`.
   - `fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL)` onto an existing file throws `EEXIST`.
6. From the notes, not checked again: a junction reads as `isSymbolicLink()`; `removeTree` instead of `fs.rmSync`
   (EPERM on read-only files); plugin rules are read only directly in `rules/` (`readChildren` in `lib/catalog.js`),
   so a rule from a subfolder must be flattened.
7. Not checked: `vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true })` in a Remote-SSH window (the
   remote file system may not offer a trash). The design reports the failure and never falls back to a permanent
   delete.

## Design

### New module `lib/share.js` (pure, never requires `vscode`)

Header comment: `// Sharing a project's (or the user's ~/.cursor) rule, skill, command or agent: copying it into a plugin.
Pure: never requires vscode. Errors are returned as { error: '<message>' }, never thrown.`

Requires `fs`, `path`, `{ KINDS, nameError, clashError }` from `./authoring`, `{ removeTree }` from `./sync`.

An **item** is `{ kind, name, ext, src }`. Fields:
- `kind`: `'skill' | 'rule' | 'command' | 'agent'`.
- `name`: the file name without its extension, or the skill's folder name.
- `ext`: `'.mdc'`, `'.md'` and so on, the file's own extension; `''` for a skill.
- `src`: the absolute path of the file, or of the skill **folder**.

`projectItems` adds `rel`, the path from the scanned root with `/`, for example `.cursor/rules/backend/db.mdc` or
`.cursor/skills/code-review`.

1. `shareKind(p)`: pure string test, no file system access. It returns an item or `null`. Let `s = p.replace(/\\/g, '/')`.
   Test in this order:
   - skill: `/\/\.cursor\/skills\/([^/]+)(\/SKILL\.md)?$/`. Returns `{ kind: 'skill', name: m[1], ext: '', src }`,
     where `src` is `p` itself without the trailing `SKILL.md` part when group 2 matched (`path.dirname(p)`).
   - rule: `/\/\.cursor\/rules\/(?:.+\/)?([^/]+)(\.mdc|\.md)$/` -> `{ kind: 'rule', name: m[1], ext: m[2], src: p }`.
   - command: `/\/\.cursor\/commands\/([^/]+)(\.md|\.mdc|\.markdown|\.txt)$/`.
   - agent: `/\/\.cursor\/agents\/([^/]+)(\.md|\.mdc|\.markdown)$/`.

   These are the same paths as the menu's `when` regexes (the test below checks they agree).
2. `shareableItem(p)`: `shareKind(p)`, then a check on disk, else `null`:
   - a skill needs `path.join(src, 'SKILL.md')` to be a file (`fs.statSync(...).isFile()`, links followed);
   - the other kinds need `src` to be a file.
3. `projectItems(root)`: the items under `<root>/.cursor`, each with `rel`. Missing folders give nothing.
   - rules: every file ending in `.mdc` or `.md` under `.cursor/rules`, recursively. Recurse only into entries where
     `dirent.isDirectory()`: a link to a folder is not followed. A file entry counts when it is `isFile()`, or a
     symbolic link to a file (as `filesWithExt` does in `lib/catalog.js`).
   - skills: each entry of `.cursor/skills` that is a folder, or a link to one (`fs.statSync(...).isDirectory()`), and
     that holds a `SKILL.md` file.
   - commands: the files directly in `.cursor/commands` matching the command extensions.
   - agents: the files directly in `.cursor/agents` matching the agent extensions.

   Build each item with `shareKind(fullPath)` so the rules stay in one place. Order: skills, rules, commands,
   agents, each sorted by `rel` (plain `<` comparison, like `byName` in `lib/catalog.js`).
4. `suggestName(name)`: a name that passes `nameError`, or `''`:
   `name.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64).replace(/[^a-z0-9]+$/, '')`.
5. `shareNameError(pluginDir, kind, name)`: `nameError(name) || clashError(pluginDir, kind, name)`. `''` when the
   name is fine.
6. `shareItem(item, pluginDir, name)`: copies the item into the plugin folder as `name`. Returns `{ file, skipped }`
   or `{ error }`:
   - `file` is the absolute path of the copied rule, command or agent file, or of the copied skill's `SKILL.md`;
   - `skipped` is the list of links left out of a skill, as paths relative to the skill folder with `/` (`[]` for the
     other kinds).

   Steps:
   1. `const bad = shareNameError(pluginDir, item.kind, name)`: return `{ error: bad }` when it is set.
   2. A skill:
      - `dest = path.join(pluginDir, 'skills', name)`;
      - `from = fs.realpathSync(item.src)`, so a skill folder that is itself a link is copied, not skipped;
      - `fs.mkdirSync(path.dirname(dest), { recursive: true })`;
      - `fs.cpSync(from, dest, { recursive: true, errorOnExist: true, force: false, filter })`. The filter pushes
        `path.relative(from, s).split(path.sep).join('/')` into `skipped` and returns `false` when
        `fs.lstatSync(s).isSymbolicLink()`, else returns `true`;
      - on any error: `removeTree(dest)` (inside its own try/catch), then return `{ error: err.message }`;
      - `file = path.join(dest, 'SKILL.md')`; then, when `name !== item.name`, call
        `renameSkill(file, item.name, name)` (below).
   3. Other kinds:
      - `dest = path.join(pluginDir, KINDS[item.kind].folder, name + item.ext)`;
      - `mkdirSync` its folder (`recursive`);
      - `fs.copyFileSync(item.src, dest, fs.constants.COPYFILE_EXCL)`;
      - on error return `{ error: err.message }`;
      - `file = dest`, `skipped = []`.
7. `renameSkill(file, oldName, newName)` (internal, exported for the test as `renameSkillName(text, oldName,
   newName)`, the pure text part; the file wrapper reads, transforms and writes only when the text changed):
   - Only inside a frontmatter: the text, after an optional BOM, starts with `---\n` or `---\r\n`; it ends at the next
     line that is exactly `---`, with an optional `\r`.
   - Take the first line of the frontmatter matching `/^name:[ \t]*(.*?)[ \t]*\r?$/`. Its value with matching outer
     quotes (`"…"` or `'…'`) removed must equal `oldName`.
   - Then that line becomes `name: <newName>`, keeping its `\r` if it had one.
   - Anything else (no frontmatter, no `name:` line, another value): the text is returned unchanged.
   - BOM and every other byte are kept.

### `lib/authoring.js`

Add and export `clashError(pluginDir, kind, name)`: the first of `EXISTING[kind](name)` that `exists`, as
`` `${rel} already exists` ``, else `''`. `createItem` uses it in place of its loop, with the same messages, so its
tests don't change.

### `extension.js`

1. **Split `newPluginCommand`.**
   - `async function createPluginFlow(arg)`: lines 1695-1756 as they are (pick the destination, name, description,
     `createPlugin` under the lock, the error message, the `log` line). It returns `{ repo, pluginName, dir }` (`repo`
     is the label, `'drafts'` for the drafts) or `null` when cancelled, busy or failed.
   - `newPluginCommand(arg)`: `const created = await createPluginFlow(arg); if (!created) return;`, then the rest as
     today (`apply`, `enableNew`, open `plugin.json`, the message with **New skill**). Behaviour unchanged.
2. **`async function shareCommand(uri, uris)`**, registered as `reg('teamPlugins.shareWithTeam', shareCommand)` after
   `teamPlugins.moveDraft`. Each item gets a `uri` field in the extension, used for the trash only.

   **a. Items.**
   - When `uri` is a `vscode.Uri` (Explorer):
     - take `Array.isArray(uris) && uris.length > 0 ? uris : [uri]`;
     - keep `share.shareableItem(u.fsPath)` of each;
     - the item's `uri` is `u`, or `vscode.Uri.joinPath(u, '..')` when `item.src` is not `u.fsPath` (`SKILL.md` was
       clicked: the folder is shared);
     - drop duplicates by `samePath(src)` (a skill's folder and its `SKILL.md` both selected).
     - None left: `showInformationMessage('Team plugins: only a rule, skill, command or agent of a .cursor folder can be shared.')`,
       return.
   - Otherwise (command palette):
     - list `share.projectItems(folder.uri.fsPath)` for each `vscode.workspace.workspaceFolders` entry, with
       `uri = vscode.Uri.joinPath(folder.uri, ...item.rel.split('/'))`;
     - then `share.projectItems(os.homedir())`, keeping only the skill, command and agent items (no rules), marked
       personal, with `uri = vscode.Uri.file(item.src)`;
     - drop duplicates by `samePath(src)`, first one wins (a workspace folder may be the home folder);
     - none: `showInformationMessage("Team plugins: no rule, skill, command or agent found in this project's .cursor folder or in ~/.cursor.")`,
       return.
     - The quick pick (`canPickMany: true`, `placeHolder: 'Rules, skills, commands and agents to share'`) has one
       entry per item: `label` = `item.name`, `description` = `` `${KINDS[kind].label} · ${where}` ``. `where` is:
       - `item.rel` for a project item, prefixed with `<folder name>/` when there are several workspace folders;
       - `` `personal · ~/${item.rel}` `` for a personal item.

       `picked: true` on the entry whose `src` equals `share.shareableItem(activeEditorPath)` of the active text
       editor's file, if any (`samePath`). Nothing picked or cancelled: return.

   **b. Destination.**
   - A quick pick: first `{ label: '$(add) New plugin...', newPlugin: true }`, then
     `catalog.plugins.map((p) => ({ label: p.name, description: p.description, p }))`;
   - `placeHolder`: `` `Plugin to copy ${items.length === 1 ? items[0].name : `${items.length} items`} to` ``;
   - cancelled: return.
   - **New plugin...**:
     - `const created = await createPluginFlow(undefined)` (null: return);
     - `await apply()`;
     - `plugin = catalog.plugins.find((p) => p.name === `${created.repo}:${created.pluginName}`)`;
     - not found: `showErrorMessage('Team plugins: the new plugin is not in the catalog yet: try again.')`, return;
     - `isNewPlugin = true`.

   **c. Checks before any copy.**
   - For each distinct kind of the items: `authoring.declaredPathsError(plugin, kind)`. The first one set:
     `showErrorMessage(`Team plugins: ${err}`)`, return.
   - `repo = descs.find((d) => d.key === plugin.repoKey)`: return when missing.

   **d. Names.**
   - Go through the items in order, with a `Set` `chosen` of `` `${kind}:${name}` ``.
   - The name is `item.name` when `share.shareNameError(plugin.dir, kind, item.name)` is `''` and
     `chosen` doesn't have it.
   - Otherwise ask with `showInputBox`:
     - `prompt`: `` `Name for the ${label} ${item.name} in ${plugin.pluginName}: ${reason}` ``, where `reason` is the
       error, or `` `another item you are sharing is named ${item.name}` ``;
     - `value: share.suggestName(item.name)`, `ignoreFocusOut: true`;
     - `validateInput`: on the trimmed text, `share.shareNameError(...)`, or
       `` `another item you are sharing is named ${t}` `` when `chosen` has it, or `null`.
   - Cancelled: return, nothing is copied.
   - Add each name to `chosen`.

   **e. Copy.**
   - `const results = await enqueue(() => withRepoLock(repo, () => items.map((item, i) => share.shareItem(item, plugin.dir, names[i]))))`.
   - `null` (busy): return.
   - For each `{ error }`: `` showErrorMessage(`Team plugins: could not share ${item.name}: ${error}`) ``.
   - The others are the **shared** list. Empty: return.

   **f. After.**
   - `await apply()`. Find each shared child in `catalog.plugins.find((p) => p.name === plugin.name)` by
     `samePath(c.file, result.file)`.
   - Log ``log(`shared ${item.src} as ${id || names[i]} in ${result.file}`)``.
   - Enable: `isNewPlugin` -> `await enableNew(plugin.name)` once (the whole plugin); else `await enableNew(id)` for
     each found id.
   - Skipped links (all shared skills together, as `` `${name}/${rel}` ``):
     ``showWarningMessage(`Team plugins: links are not copied: ${list.join(', ')}`)``.
   - One shared item: `await vscode.window.showTextDocument(vscode.Uri.file(result.file))`.
   - The closing message: `showInformationMessage(text, ...buttons)`, not awaited, `.then(handler).then(undefined,
     (err) => log(...))`, as in `moveDraftCommand`.
     - `what` is `` `the ${label} ${name}` `` for one item, `` `${n} items` `` for more.
     - `drafts`: `` `Copied ${what} to the draft plugin ${plugin.pluginName}. Move the plugin to a repository when it is ready.` ``
     - `managed`: `` `Copied ${what} to ${plugin.name}: it is in the repository's Local changes. Commit and push to share it with the team.` ``,
       first button `'Commit and push'` (runs `teamPlugins.commitAndPush` with `{ repo: repo.key }`).
     - `local`: `` `Copied ${what} to ${plugin.name} in your clone: commit and push it with your own git tools.` ``
     - Last button in every case: `'Move the original to the trash'` (one item) or `'Move the originals to the trash'`.
       For each shared item it runs `await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: true })`.
       On failure: `` showErrorMessage(`Team plugins: could not move ${item.src} to the trash: ${err.message}`) ``.
       Never delete without the trash.
3. Requires: add `const share = require('./lib/share');` next to `authoring`, and `os` if `extension.js` doesn't
   require it yet.

### `package.json`

- `version`: `0.8.0`.
- Command, after `teamPlugins.moveDraft`:
  `{ "command": "teamPlugins.shareWithTeam", "title": "Share with team...", "category": "Team Plugins" }`.
- New menu `"explorer/context"` (a key of `menus`, next to `view/item/context`), one entry with
  `"group": "7_teamPlugins@1"` and exactly this `when` (JSON text, as tested):

  ```json
  "when": "explorerResourceIsFolder && resourcePath =~ /[\\\\/]\\.cursor[\\\\/]skills[\\\\/][^\\\\/]+$/ || !explorerResourceIsFolder && resourcePath =~ /[\\\\/]\\.cursor[\\\\/](rules[\\\\/](.+[\\\\/])?[^\\\\/]+\\.mdc?|skills[\\\\/][^\\\\/]+[\\\\/]SKILL\\.md|commands[\\\\/][^\\\\/]+\\.(md|mdc|markdown|txt)|agents[\\\\/][^\\\\/]+\\.(md|mdc|markdown))$/"
  ```

- The command stays in the command palette (no `commandPalette` entry).

## Impact

- `createItem` (authoring): uses `clashError`, same messages. `test/authoring.test.js` `createItem` cases must still
  pass unchanged.
- `newPluginCommand`: split only, same behaviour (New plugin from the view title, from a repository row, and the
  **New skill** offer).
- `enableNew`, `withRepoLock`, `apply`, `catalog`, `descs`: called, not changed.
- Partial copies: the files are written in `plugin.dir` (the repository folder) under its lock, as `createItem` does;
  `syncCopy` carries them to a copy. Nothing else to change.
- `scripts/test.js` picks up `test/share.test.js` by itself (all `*.test.js`).
- `scripts/package.js`: check that it packages every file of `lib/` (it should; report if `lib/share.js` is missing
  from the VSIX).

## Not handled (say so where listed)

- `.cursor/mcp.json` servers (they often hold tokens) and `AGENTS.md`/`CLAUDE.md`: README **Known limitations**.
- Relative links from the item to other project files are copied as they are and may break: README **Known
  limitations**.
- Links inside a skill are skipped (reported at the time): README, in the Share bullet.
- The palette lists only the `.cursor` folders at the root of each workspace folder, plus `~/.cursor` (skills,
  commands, agents). Right-click works on any `.cursor` folder in the Explorer: README Share bullet.
- Moving to the trash in a Remote-SSH window is not verified. If it fails, the error is shown and nothing is deleted:
  `docs/development.md` **Known limits (details)**.

## Tests

### New `test/share.test.js` (`node:test`, `assert/strict`, helpers `tmpDir`, `rmDir`, `writeFile`, `makePlugin`;
a `fixture(t)` like `test/authoring.test.js`)

1. `shareKind`, with `String.raw` for the Windows paths:
   - `String.raw\`d:\p\.cursor\rules\style.mdc\`` -> `{ kind: 'rule', name: 'style', ext: '.mdc', src: <same> }`
   - `'/p/.cursor/rules/backend/db.md'` -> rule `db`, `.md`
   - `'/p/.cursor/skills/code-review'` -> skill `code-review`, `ext: ''`, `src` the same path
   - `'/p/.cursor/skills/code-review/SKILL.md'` -> skill `code-review`, `src: path.dirname(...)`
   - `'/p/.cursor/commands/review-pr.markdown'` -> command `review-pr`, `.markdown`
   - `'/p/.cursor/agents/reviewer.md'` -> agent `reviewer`
   - `null` for:
     - `'/p/.cursor/rules/a.txt'`
     - `'/p/.cursor/agents/a.txt'`
     - `'/p/.cursor/skills/x/scripts/a.md'`
     - `'/p/.cursor/skills'`
     - `'/s/.cursor/plugins/repos/r/review/skills/x/SKILL.md'`
     - `'/p/x.cursor/rules/a.mdc'`
     - `'/p/.cursor/commands/sub/c.md'`
2. **The menu agrees with `shareKind`.**
   - Read `package.json` and take the `explorer/context` entry of `teamPlugins.shareWithTeam`.
   - Extract its two regexes with `/=~ \/(\S+)\/(?=\s|$)/g` (first: folders, second: files).
   - For each sample `[isFolder, path, shareable]`, `(isFolder ? re0 : re1).test(path) === shareable`.
   - For each shareable sample, `shareKind(path)` is not null. For each file sample that is not shareable,
     `shareKind` is `null`.
   - Samples: the paths of measured fact 4 with their expected results.
3. `shareableItem`: in a fixture:
   - `.cursor/skills/a/SKILL.md` -> item for the folder `.cursor/skills/a`;
   - `.cursor/skills/b/` without `SKILL.md` -> `null`;
   - a folder named `.cursor/rules/x.mdc` -> `null`;
   - a missing rule file -> `null`.
4. `projectItems`. Fixture `.cursor` holds:
   - `rules/b.mdc`, `rules/a.md`, `rules/sub/c.mdc`, `rules/notes.txt`;
   - `skills/s1/SKILL.md`, `skills/s2/README.md` (no `SKILL.md`);
   - `commands/run.md`;
   - `agents/helper.md`.

   Expected `rel` list, in order: `.cursor/skills/s1`, `.cursor/rules/a.md`, `.cursor/rules/b.mdc`,
   `.cursor/rules/sub/c.mdc`, `.cursor/commands/run.md`, `.cursor/agents/helper.md`. Kinds and names match. A root
   without `.cursor` -> `[]`.
5. `suggestName`:
   - `'My_Rule'` -> `'my-rule'`
   - `'Code Review!'` -> `'code-review'`
   - `'--x--'` -> `'x'`
   - `'___'` -> `''`
   - `'a..b'` -> `'a..b'`
   - `'x'.repeat(70)` -> 64 `x`
   - each non-empty result passes `nameError`.
6. `shareNameError`:
   - `'Bad'` -> `NAME_RULE`;
   - an existing `rules/style.md` in the plugin makes the rule name `style` give `'rules/style.md already exists'`;
   - a free name -> `''`.
7. `shareItem`, rule and command:
   - `makePlugin(root, 'p')`; copy `.cursor/rules/sub/style.mdc` (with a frontmatter description) as `style`;
   - `file` is `p/rules/style.mdc`, content identical, `skipped` `[]`;
   - `readCatalog(root).plugins[0].children` has `p/rules/style.mdc` with that description;
   - the source still exists;
   - a second copy -> `{ error: 'rules/style.mdc already exists' }`;
   - a command `.txt` keeps its extension (`commands/run.txt`).
8. `shareItem`, skill with files and a link:
   - The source is `.cursor/skills/code-review/` with `SKILL.md` and `scripts/check.py`.
   - On Windows, add a junction `scripts/linked` to an outside folder, made with
     `spawnSync('cmd.exe', ['/c', 'mklink', '/J', link, target])` (skip that part when it fails or off Windows); else
     `fs.symlinkSync(target, link, 'dir')`.
   - Expected: `SKILL.md` and `scripts/check.py` copied; `skipped` `['scripts/linked']`; no `linked` in the
     destination.
9. `shareItem`, renamed skill: `SKILL.md` text `---\r\nname: "My_Skill"\r\ndescription: d\r\n---\r\nbody\r\n` in folder
   `My_Skill`, shared as `my-skill`. The copy's text is `---\r\nname: my-skill\r\ndescription: d\r\n---\r\nbody\r\n`.
   Folder `skills/my-skill`.
10. `renameSkillName`, text only:
    - name equal, plain -> replaced;
    - name different (`name: other`) -> unchanged;
    - no frontmatter (`name: x` on the first line, no `---`) -> unchanged;
    - `name:` only after the closing `---` -> unchanged;
    - a BOM before `---` -> kept, and the name is replaced.
11. `shareItem`, name errors: `'Bad'` -> `{ error: NAME_RULE }` and nothing written.

### Existing tests

`test/authoring.test.js` stays as it is; add one `clashError` case there:
- `''` for a free name;
- `'skills/x already exists'` after `createItem(dir, 'skill', 'x', 'd')`.

## Keep in step

- `README.md`:
  - The intro bullet **Write new plugins and skills** (line ~23): add "or share a rule or skill that started in a
    project".
  - Section **Writing plugins**: a new bullet after **Move to a repository**: **Share with team...**. It covers:
    - right-click a rule, skill (its folder or `SKILL.md`), command or agent in a project's `.cursor` folder in the
      Explorer (several at once), or run it from the command palette, which lists the project's items and your personal
      `~/.cursor` skills, commands and agents;
    - pick a plugin or **New plugin...**;
    - a skill is copied with its whole folder (links are left out); a rule from a subfolder of `.cursor/rules` goes
      straight into the plugin's `rules`;
    - a name Cursor would refuse, or one the plugin already has, is asked for again;
    - the copy is enabled for you and becomes a local change like a new item (managed clone: **Local changes**);
    - the original stays in the project: the closing message offers to move it to the trash, so the agent doesn't read
      it twice.
  - **Known limitations**: one bullet: Share with team copies only rules, skills, commands and agents (not MCP servers
    of `.cursor/mcp.json`, nor `AGENTS.md`); links from the item to other project files are copied as they are.
  - No version history in the README.
- `docs/development.md`:
  - **How it works**, after the Authoring bullet: a **Share with team** bullet. It covers:
    - `lib/share.js` (`shareKind` = the menu's `when` regexes, which a test keeps in step);
    - the Explorer passes `(clicked, selected)` and the `when` only sees the clicked item, so the command filters the
      selection;
    - `resourcePath` is `fsPath` for `file:` and `uri.path` remotely, hence `[\\/]`;
    - the copy goes to `plugin.dir` under the repository lock;
    - links in a skill are skipped (`cpSync` filter on `lstat`); a skill folder that is itself a link is copied
      through `realpath`;
    - a renamed skill gets its frontmatter `name:` rewritten when it equalled the old folder name;
    - trash only (`useTrash`).
  - **Known limits (details)**: trash in a Remote-SSH window not verified; the palette scans only the workspace
    folders' root `.cursor` and `~/.cursor` (skills, commands, agents).
- `AGENTS.md`, **Layout**:
  - add `share` to the `lib/` list: `share` (`shareKind`, `shareableItem`, `projectItems`, `suggestName`,
    `shareNameError`, `shareItem`, `renameSkillName`: copying a project item into a plugin);
  - add `clashError` to the `authoring` list.

  **Why the code is shaped this way**: one bullet. An Explorer context command gets `(clickedUri, selectedUris)` and
  its `when` is evaluated on the clicked item only; `resourcePath` is `fsPath` for `file:` (backslashes on Windows),
  `uri.path` otherwise; `share.shareKind` and the menu's regexes must match (`share.test.js`).
- `package.json`: version, command, menu (above).

## Commands

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
```

(Git Bash, from the repository root.) After packaging, check that `dist/cursor-team-plugins-0.8.0.vsix` exists.

## Don't

- No commit, no branch change.
- Don't edit `requests/09-share-with-team.md` or this plan.
- Don't change files outside those listed without reporting it.
- Never run `cursor --install-extension` and never launch Cursor windows. Running `Cursor.exe` with
  `ELECTRON_RUN_AS_NODE=1` for the commands above is fine.
- No dependency, no TypeScript, no bundler. Nothing under `lib/` requires `vscode`.
- Use `removeTree` (from `lib/sync.js`), never `fs.rmSync`, in the code and the tests.
- Don't delete anything without the trash in the extension; never a permanent delete of the user's original.
- Edit files with the editing tools, not with scripts that rewrite them.

## Changes after review

- Review: a stray whitespace change in `registerCommands` (`const reg =(`) was undone.
- Remote-SSH live test (Linux host): `vscode.workspace.fs.delete(uri, { useTrash: true })` fails in a remote window
  ("Unable to delete file 'vscode-remote://...' via trash because provider does not support it"; nothing deleted).
  Decided with the user: when `vscode.env.remoteName` is set, the last button reads `Delete the original` /
  `Delete the originals` and `removeOriginals` asks with a modal warning (`Delete <path> for good?` /
  `Delete the <n> originals for good?`, detail: no trash in this remote window, the copies in the plugin stay, then
  the paths), button `Delete`, then deletes with `useTrash: false`. Local windows keep the trash. The rule "never a
  permanent delete" of the Don't list no longer holds for remote windows.
