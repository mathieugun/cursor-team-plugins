# Plan: authoring commands (New plugin, drafts, Move to a repository, New skill/rule/command/agent/MCP server)

## Context

- Repo: this repository (Cursor extension, plain CommonJS, no dependencies, no build). Read `AGENTS.md`
  first: its rules apply (no `vscode` under `lib/`, README for users, `docs/development.md` for internals).
- Request: `requests/done/08-authoring.md` (from the "Authoring and contribution" ideas, edited by the user):
  - A **New plugin** command to create a local plugin that can be pushed to the remote repo when it's ready.
  - A **New skill** command that scaffolds a skill (folder, `SKILL.md` with frontmatter) in a chosen plugin.
  - Similar commands for rules, agents, commands, MCP servers.
- Version: 0.6.0 -> **0.7.0**.
- Files and functions involved:
  - `lib/catalog.js`: `readCatalog` (plugin objects built near the end, `const plugin = {...}`), `serverTable`,
    `mcpServerNames` (exported), `isPlainObject`.
  - `lib/repos.js`: `listRepos` (line ~173), `baseName`, `normalizeUrl`, `safeFs`.
  - `lib/treeModel.js`: `buildTree(catalog, eff, project)`, `repoStatus(desc, state)`, `buildRepoNode(desc, state, children)`.
  - `lib/selection.js`: `effective`, `toggle` (used as is).
  - `lib/sync.js`: `withLockSync(lockFile, fn)` -> `{ kind: 'busy' }` | `{ kind: 'done', value }`; `removeTree(target)`.
  - `extension.js`: `paths()` (105), `rawRepos()` (137), `doApply()` (585), `syncRepo()` (329, local branch at 331),
    `updateStatus()` (1011), `PluginTree.getChildren` (1157), `onCheckboxChange` (1248: how the selection is written),
    `startWatchers()` (1435), `pickRepo` (1525), `registerCommands` (1620), `flushPartials` (945),
    `commitAndPushCommand` (1920), constants `BUSY_TEXT`, `ITEM_KINDS` (1092), `isActive`, `labelOf`, `isDirectory` (1467).
  - `package.json`: `version`, `contributes.commands`, `contributes.menus`.
  - New: `lib/authoring.js`, `test/authoring.test.js`.

## Measured facts (don't measure them again)

- Cursor's plugin name rule (agent host `resources/app/extensions/cursor-agent-host/dist/4846.js`):
  `h=/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/`, message "Name must be kebab-case (lowercase alphanumeric with hyphens and
  periods)". Skill names are folded by `e.trim().toLowerCase().replace(/\s+/g,"-").replace(/[^a-z0-9.-]/g,"")`.
  So one name rule for plugins, skills, rules, commands and agents: that regex, at most 64 characters.
- Cursor's runtime is node v24.22.1 (`ELECTRON_RUN_AS_NODE=1 Cursor.exe -e "console.log(process.version, typeof
  require('fs').cpSync)"` -> `v24.22.1 function`): `fs.cpSync` is available.
- `localChanges` runs `git status --porcelain=v1 -uall -z` (`lib/sync.js:270`): a new plugin folder in a managed clone
  shows file by file in Local changes; `rebase --autostash` leaves untracked files alone and `checkConflicts` compares
  them with the team's changes (`lib/sync.js:314`). Nothing to change there.
- Cursor reads a kind's declared paths instead of its default folder when `plugin.json` declares `agents`, `commands`,
  `rules`, `skills` or `mcpServers` (AGENTS.md, docs/development.md): a file scaffolded in the default folder would be
  ignored, so those kinds are refused.
- Cursor watches registered plugin folders (AGENTS.md): a new file in a registered plugin needs no re-registration; a
  new plugin needs `addPlugin`, which `doApply` does once the selection includes it.
- On Windows the **parent** of a registered plugin folder can't be deleted or renamed; the registered folder itself
  can (AGENTS.md). So the drafts folder is never deleted; a draft plugin folder can be.
- `scripts/package.js` packages every file of `lib/` (line 72): the new module is packaged with no change.
- `test/catalog.test.js` compares whole plugin objects in places: add new plugin fields only when non-empty (as
  `mcpFiles` is).

## Design

### Drafts

- Folder: `<storage>/.cursor/plugins/drafts` (`path.join(paths().pluginsRoot, 'drafts')`; add `draftsRoot` to the
  object `paths()` returns). A plain folder, no git. Created by the first **New plugin** into drafts, never deleted.
- `listRepos` gets a new optional argument `drafts` (a folder path, `''` = none; default `''`). When set, the first
  descriptor of the list is:
  `{ key: 'drafts', kind: 'drafts', source: drafts, url: '', branch: '', normalized: normalizeUrl(drafts, platform),
  dir: P.resolve(drafts), lockFile: P.join(storage, 'locks', 'drafts.lock'), stateFile: P.join(storage, 'state',
  'drafts.json'), duplicateOf: null }`. It is added before the locals and is never compared for duplicates with them
  (put it in `seen` all the same, so a local entry with the same path is `duplicateOf: 'drafts'`).
  Its name comes from `assignNames` as for the others: `baseName` of the path = `drafts`.
- `rawRepos()` passes `drafts: isDirectory(paths().draftsRoot) ? paths().draftsRoot : ''`.
- `syncRepo`: first line after `const s = ...`: `if (d.kind === 'drafts') { s.lastCheck = new Date(); return; }`.
- `repoStatus`: after the `syncing` rule and before the `local` rule: `desc.kind === 'drafts'` ->
  `{ text: 'only on this machine', icon: 'edit', problem: false }`.
- `buildRepoNode`: for `kind === 'drafts'` the first tooltip line is
  `Drafts: plugins you are writing, only on this machine. Move one to a repository to share it.` (instead of
  `Repository: ...`); `contextValue` is `repo.drafts` (`repo.managed` / `repo.local` unchanged).
- `buildTree(catalog, eff, project, { draft = false } = {})`: when `draft`, plugin nodes get `contextValue:
  'plugin.draft'` and item nodes `'child.draft'` (whatever the project state). Everything else unchanged.
- `PluginTree.getChildren`: pass `{ draft: d.kind === 'drafts' }` to `buildTree`; skip the drafts repository node when
  it has no plugin in `catalog` and no conflict (`copyConflicts` of that key). `updateStatus` skips it in the tooltip
  lines on the same condition. Write one helper `isEmptyDrafts(d)` used by both.
- Watching: `startWatchers` watches every `listConfigured()` dir, drafts included once it exists. Keep a module
  variable `draftsWatched` (boolean) set by `startWatchers` (true when the list it watched contained the drafts
  descriptor). At the end of `doApply` (before `refreshChanges`): if `descs.some((d) => d.kind === 'drafts') &&
  !draftsWatched` call `startWatchers()` (another window created the folder, or this one just did).
- Menus: `teamPlugins.removeRepository` only on `viewItem =~ /^repo\.(managed|local)$/` (was `/^repo\./`);
  `removeRepositoryCommand`'s `pickRepo` filter excludes `kind === 'drafts'`. `teamPlugins.addToProject` stays on
  `/^(plugin|child)$/`, so drafts items don't get it. `openRepo` keeps `/^repo\./` (opens the drafts folder).

### `lib/catalog.js`

- Each plugin gets `customPaths`: `['skills', 'rules', 'commands', 'agents', 'mcpServers'].filter((k) => manifest[k]
  !== undefined)`, set on the plugin object **only when non-empty** (like `mcpFiles`).
- Export `serverTable` too (used by `addMcpServer`).

### `lib/authoring.js` (new, pure, no `vscode`)

Requires `fs`, `path`, `{ readCatalog, mcpServerNames, serverTable }` from `./catalog`, `{ removeTree }` from `./sync`.
Errors are returned, never thrown, as `{ error: '<message>' }`. All files written with `\n` line endings, UTF-8.

```js
const NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RULE = 'Use lowercase letters, digits, hyphens and dots, starting and ending with a letter or digit (at most 64 characters).';
const SERVER_RULE = 'Use letters, digits, dots, hyphens and underscores, starting with a letter or digit (at most 64 characters).';
// kind -> { folder, label }: folder is plugin.json's key for that kind and (except mcp) the default folder
const KINDS = {
  skill: { folder: 'skills', label: 'skill' },
  rule: { folder: 'rules', label: 'rule' },
  command: { folder: 'commands', label: 'command' },
  agent: { folder: 'agents', label: 'agent' },
  mcp: { folder: 'mcpServers', label: 'MCP server' },
};
```

Functions (all exported, plus `KINDS`):

1. `nameError(name)` -> `''` when `name.length <= 64 && NAME.test(name)`, else `NAME_RULE`.
2. `serverNameError(name)` -> `''` when `name.length <= 64 && SERVER_NAME.test(name)`, else `SERVER_RULE`.
3. `yamlScalar(text)`: `t = String(text).trim()`; plain `t` when `/^[A-Za-z0-9][^:#]*$/.test(t)`, else
   `JSON.stringify(t)` (a JSON string is a valid YAML double-quoted scalar).
4. `title(name)`: `name.replace(/[-.]+/g, ' ')` with the first character upper-cased (`code-review` -> `Code review`).
5. `itemFile(kind, name, description)` -> `{ rel, text }` for `skill`, `rule`, `command`, `agent` (exact text, `D` =
   `yamlScalar(description)`):
   - skill: rel `skills/<name>/SKILL.md`, text
     `---\nname: <name>\ndescription: D\n---\n\n# <title(name)>\n\nDescribe when the agent should use this skill and the steps to follow.\n`
   - rule: rel `rules/<name>.mdc`, text `---\ndescription: D\nalwaysApply: false\n---\n\nWrite the rule here.\n`
   - command: rel `commands/<name>.md`, text `---\ndescription: D\n---\n\nWrite what the agent does when this command runs.\n`
   - agent: rel `agents/<name>.md`, text `---\nname: <name>\ndescription: D\n---\n\nDescribe the agent's role and how it works.\n`
6. `declaredPathsError(plugin, kind)` -> `''`, or when `(plugin.customPaths || []).includes(KINDS[kind].folder)`:
   `` `${plugin.name} sets the paths of its ${KINDS[kind].label}s in plugin.json: add the file there by hand.` ``
   (`plugin.name` is the merged id, e.g. `team-test:review`; fine as is).
7. `createItem(pluginDir, kind, name, description)` -> `{ file }` | `{ error }`. Order of checks:
   1. `nameError(name)` -> `{ error }`.
   2. Existing paths (relative to `pluginDir`, any one existing as file or folder -> `{ error: '<rel> already exists' }`,
      rel with `/`, the first existing one in this order):
      skill: `skills/<name>`; rule: `rules/<name>.mdc`, `rules/<name>.md`; command: `commands/<name>.md`, `.mdc`,
      `.markdown`, `.txt`; agent: `agents/<name>.md`, `.mdc`, `.markdown`.
   3. `mkdirSync(dirname, { recursive: true })`, `writeFileSync(file, text, { flag: 'wx' })`; return `{ file }`
      (absolute path).
8. `splitCommandLine(text)` -> array of strings, or `null` when a double quote is not closed. Loop over the characters:
   `"` toggles quoting (and marks that a token exists, so `""` gives an empty token); a whitespace character outside
   quotes ends the current token (if any); anything else is appended. Backslashes are plain characters.
9. `addMcpServer(pluginDir, name, entry)` -> `{ file }` | `{ error }`:
   1. `serverNameError(name)` -> `{ error }`.
   2. Target file: `mcp.json` if it exists, else `.mcp.json` if it exists, else `mcp.json` (created).
   3. Every existing file of the two: if it parses and `mcpServerNames(obj).includes(name)` ->
      `{ error: `${fileName} already has a server named ${name}` }`.
   4. Target exists: parse (`JSON.parse`, BOM stripped); failure -> `{ error: `${fileName}: ${err.message}` }`; not a
      plain object -> `{ error: `${fileName} is not a JSON object` }`. Missing: `obj = {}`.
   5. If `serverTable(obj)` or `mcpServerNames(obj).length === 0`: `obj.mcpServers = { ...(plain object
      obj.mcpServers or {}), [name]: entry }`; else (top-level form) `obj[name] = entry`.
   6. Write `JSON.stringify(obj, null, 2) + '\n'`; return `{ file }` (absolute).
10. `mcpEntry({ command, url })`: `url` -> `{ url }`; command line -> `parts = splitCommandLine(command)`,
    `{ command: parts[0] }` plus `args: parts.slice(1)` when there are any. (Caller validates first.)
11. `pluginLocation(repoDir)` -> `{ root, marketplace: null | { file, obj } }` | `{ error }`:
    - `file = <repoDir>/.cursor-plugin/marketplace.json` missing -> `{ root: repoDir, marketplace: null }`.
    - parse failure -> `{ error: `marketplace.json: ${err.message}` }`.
    - `obj.plugins === undefined` -> `{ root: repoDir, marketplace: null }` (plugins are found by the folder scan,
      which scans the repository root).
    - `Array.isArray(obj.plugins)` -> root = `path.join(repoDir, obj.metadata.pluginRoot)` when that is a non-empty
      string, else `repoDir`; `marketplace: { file, obj }`.
    - otherwise `{ error: 'marketplace.json: "plugins" is not an array' }`.
12. `placePlugin(repoDir, folder, name)` (internal helper used by 13 and 14) -> `{ dir, location }` | `{ error }`:
    location = `pluginLocation(repoDir)` (error -> return it); `dir = path.join(location.root, folder)`; exists ->
    `{ error: `${relative path with /} already exists` }`; `readCatalog(repoDir).plugins.some((p) => p.name === name)`
    or a marketplace entry with `name === name` -> `{ error: `a plugin named ${name} already exists in this repository` }`.
13. `createPlugin(repoDir, { name, description })` -> `{ dir }` | `{ error }`:
    `nameError(name)`; `placePlugin(repoDir, name, name)`; write `<dir>/.cursor-plugin/plugin.json` =
    `JSON.stringify({ name, ...(description ? { description } : {}), version: '0.1.0' }, null, 2) + '\n'`
    (description trimmed); then `addMarketplaceEntry(location, name, description)`.
14. `movePlugin(srcDir, pluginName, description, repoDir)` -> `{ dir, leftover? }` | `{ error }`:
    `folder = path.basename(srcDir)`; `placePlugin(repoDir, folder, pluginName)`; `fs.cpSync(srcDir, dir, { recursive:
    true, errorOnExist: true, force: false })` (on a throw: `removeTree(dir)` and `{ error: err.message }`);
    `addMarketplaceEntry(location, pluginName, description, folder)`; then `removeTree(srcDir)` in try/catch: a throw
    or a folder still there -> return `{ dir, leftover: srcDir }`; else `{ dir }`.
15. `addMarketplaceEntry(location, name, description, folder = name)` (internal): only when `location.marketplace`:
    push `{ name, source: `./${folder}`, ...(description ? { description } : {}) }` to `obj.plugins` and write the
    file `JSON.stringify(obj, null, 2) + '\n'`. When `marketplace` is null the file is not touched.
16. `renameIds(list, from, to)`: each id equal to `from` becomes `to`; each id starting with `` `${from}/` `` gets that
    prefix replaced by `` `${to}/` ``; others unchanged; result de-duplicated and sorted (`[...new Set(out)].sort()`).

### `extension.js`

Add `const authoring = require('./lib/authoring');`. All new commands follow the existing patterns.

- Helper `authoringTargets()`: `descs.filter((d) => isActive(d) && d.kind !== 'drafts' && fs.existsSync(d.dir))`
  (a managed clone that is not cloned yet is left out).
- Helper `enableNew(id)`: after `await apply()`, `const user = userSelection(); const eff =
  selection.effective(catalog, user, projectList());` find the owner plugin of `id` in `catalog`; if `id` is a plugin
  name and `eff.get(id).full`, or a child id already in `eff.get(plugin).included`, do nothing; else
  `next = selection.toggle(catalog, user, id, true)` and write `enabled` / `excluded` like `onCheckboxChange` (only the
  changed keys, `ConfigurationTarget.Global`). If `id` is not in the catalog (the apply didn't see it), log
  `new item not in the catalog yet: <id>` and do nothing.
- Helper `withRepoLock(d, fn)`: `sync.withLockSync(d.lockFile, fn)`; `busy` -> `showWarningMessage(BUSY_TEXT)` and
  return `null`; `done` -> return `value`. Run it inside `enqueue(...)` (writes never overlap an apply or a sync).

1. `teamPlugins.newPlugin` (`newPluginCommand(arg)`):
   - Target: when `arg` is a repository node (`arg.kind === 'repo'`), that descriptor (drafts included). Otherwise a
     quick pick (`placeHolder: 'Where to create the plugin'`): first `{ label: 'drafts', description: 'only on this
     machine: move it to a repository when it is ready' }`, then each `authoringTargets()` entry
     `{ label: labelOf(d), description: d.kind === 'managed' ? 'team repository: a local change until you commit and push it' : 'your own clone' }`.
   - Name: `showInputBox({ prompt: 'Plugin name', placeHolder: 'my-plugin', ignoreFocusOut: true, validateInput:
     (v) => authoring.nameError(v.trim()) || null })`. Description: `showInputBox({ prompt: 'Plugin description
     (optional)', ignoreFocusOut: true })`. Cancel at any step -> return.
   - In `enqueue`: for drafts, `fs.mkdirSync(paths().draftsRoot, { recursive: true })`; lock file = the drafts
     descriptor's, or `path.join(storage, 'locks', 'drafts.lock')` when it doesn't exist yet; run
     `authoring.createPlugin(dir, { name, description })` under the lock. `{ error }` -> `showErrorMessage(`Team
     plugins: ${error}`)`.
   - Success: repository name = the target's `labelOf(d)`, or `'drafts'`; `await enableNew(`${repo}:${name}`)`; open
     `<dir>/.cursor-plugin/plugin.json` with `showTextDocument`; then
     `showInformationMessage(`Created plugin ${name} in ${repo}. Add a skill, rule, command, agent or MCP server from its context menu.`, 'New skill')`;
     `'New skill'` -> `executeCommand('teamPlugins.newSkill', { kind: 'plugin', key: `${repo}:${name}` })`.
     Log `created plugin <repo>:<name> in <dir>`.
2. `teamPlugins.newSkill`, `newRule`, `newCommand`, `newAgent`, `newMcpServer` -> `newItemCommand(kind, node)`:
   - Plugin: `node && node.kind === 'plugin'` -> `catalog.plugins.find((p) => p.name === node.key)`; else a quick pick
     of every `catalog.plugins` entry (`label: p.name`, `description: p.description`, `placeHolder: `Plugin to add the
     ${KINDS[kind].label} to``); no plugin -> `showInformationMessage('No plugin to add it to: create one with New plugin.')`.
   - `authoring.declaredPathsError(plugin, kind)` -> `showErrorMessage(`Team plugins: ${message}`)`, return.
   - Repository: `descs.find((d) => d.key === plugin.repoKey)`; missing -> return.
   - Name input: prompt `` `${label} name` `` (first letter upper-case: `Skill name`, `Rule name`, `Command name`,
     `Agent name`, `MCP server name`), `validateInput`: kind `mcp` -> `serverNameError`, else `nameError`; then
     `` `${plugin.pluginName} already has a ${label} named ${v}` `` when `plugin.children.some((c) => c.kind === kind
     && c.name === v)`.
   - Non-MCP: description input, required: prompt `` `What the ${label} is for (shown to the agent and in the view)` ``,
     `validateInput: (v) => (v.trim() ? null : 'Enter a description')`.
   - MCP: quick pick `[{ label: 'Command', description: 'a program the agent starts (stdio)' }, { label: 'URL',
     description: 'a server already running (HTTP)' }]`; then Command -> input `prompt: 'Command line, for example: npx
     -y my-mcp-server'`, `validateInput`: `splitCommandLine(v)` null -> `'Close the double quote'`, empty array ->
     `'Enter a command'`; URL -> input `prompt: 'Server URL'`, `validateInput`: `/^https?:\/\/\S+$/i` else `'Enter an
     http:// or https:// URL'`. Entry: `authoring.mcpEntry({ command })` / `({ url })`.
   - In `enqueue` + `withRepoLock(repo, ...)`: `createItem(plugin.dir, kind, name, description.trim())` or
     `addMcpServer(plugin.dir, name, entry)`. `{ error }` -> `showErrorMessage(`Team plugins: ${error}`)`.
   - Success: id = MCP: `` `${plugin.name}/mcp/${name}` ``; else the `id` of the child of the re-read catalog whose
     `file` is the created file (`samePath`); `await enableNew(id)` (it runs `apply()` first, so find the id after
     it; simplest: `enableNew` takes a function `(catalog) => id`, or apply first then compute the id, then call a
     `enableNew` that doesn't apply again: implementer's choice, no double apply). Then
     `showTextDocument(vscode.Uri.file(file))`. Log `created <label> <id> in <file>`.
3. `teamPlugins.moveDraft` (`moveDraftCommand(node)`):
   - Draft plugin: `node && node.kind === 'plugin'` -> its catalog plugin (must have the drafts `repoKey`); else a quick
     pick of the catalog plugins whose descriptor is `kind === 'drafts'`; none ->
     `showInformationMessage('There is no draft plugin: create one with New plugin.')`.
   - Target: quick pick of `authoringTargets()` (`placeHolder: `Repository to move ${plugin.pluginName} to``, same
     descriptions as New plugin); none -> `showInformationMessage('Follow a repository or add your own clone first.')`.
   - Confirm: `showWarningMessage(`Move ${plugin.pluginName} to ${labelOf(target)}?`, { modal: true, detail }, 'Move')`
     with detail: managed -> `'The draft is deleted. In the managed clone the plugin is a local change: commit and push it to share it with the team.'`;
     local -> `'The draft is deleted. The plugin is copied into your clone: commit and push it with your own git tools.'`.
   - `await flushPartials()` first (a partial draft's copy may hold edits not yet carried back).
   - In `enqueue`: lock the target (`withRepoLock(target, ...)`) and inside it the drafts lock (`sync.withLockSync`;
     busy -> `BUSY_TEXT`); run `authoring.movePlugin(path of plugin.dir, plugin.pluginName, plugin.description, target.dir)`.
     `{ error }` -> error message, stop.
   - Success: rename the ids in the user's lists: for `enabled` and `excluded`, `authoring.renameIds(globalList, plugin.name,
     `${labelOf(target)}:${plugin.pluginName}`)` on the `stringList(cfg().get(key))` value; write only a changed list
     (`ConfigurationTarget.Global`). Then `await apply()`.
   - `leftover` -> `showWarningMessage(`Team plugins: ${plugin.pluginName} was copied but its draft could not be deleted: delete ${leftover} by hand.`)`.
   - Managed target: `showInformationMessage(`Moved ${plugin.pluginName} to ${labelOf(target)}: it is in the repository's Local changes. Commit and push to share it.`, 'Commit and push')`
     -> `executeCommand('teamPlugins.commitAndPush', { repo: target.key })`. Local target:
     `showInformationMessage(`Moved ${plugin.pluginName} to your clone ${target.dir}: commit and push it with your own git tools.`)`.
     Log `moved draft <name> to <repo> (<dir>)`.

### `package.json`

- `version`: `0.7.0`.
- `contributes.commands` (category `Team Plugins`, no icon unless given):
  `teamPlugins.newPlugin` "New plugin" (icon `$(new-folder)`), `teamPlugins.newSkill` "New skill",
  `teamPlugins.newRule` "New rule", `teamPlugins.newCommand` "New command", `teamPlugins.newAgent` "New agent",
  `teamPlugins.newMcpServer` "New MCP server", `teamPlugins.moveDraft` "Move to a repository".
- `menus.view/title`: `teamPlugins.newPlugin` when `view == teamPlugins.plugins`, group `1_author@1` (the overflow menu:
  the title bar keeps its five icons).
- `menus.view/item/context`:
  - `teamPlugins.newPlugin` when `view == teamPlugins.plugins && viewItem =~ /^repo\.(managed|local|drafts)$/`, group `2_author@1`.
  - `teamPlugins.moveDraft` when `view == teamPlugins.plugins && viewItem == plugin.draft`, group `1_draft@1`.
  - The five new-item commands when `view == teamPlugins.plugins && viewItem =~ /^plugin/`, groups `2_new@1` ..
    `2_new@5` in the order skill, rule, command, agent, MCP server.
  - `teamPlugins.removeRepository`: `when` becomes `view == teamPlugins.plugins && viewItem =~ /^repo\.(managed|local)$/`.
- `menus.commandPalette`: nothing new hidden (all seven work from the palette with a pick).

## Not handled (say so in the docs where noted)

- A `marketplace.json` or `mcp.json` that is edited is rewritten with `JSON.stringify(obj, null, 2)`: its formatting
  changes (README "Writing plugins" + docs/development.md known limits).
- Drafts are only on this machine (in a Remote-SSH window: on the remote machine), not backed up, not synced
  (README + known limitations).
- Kinds whose paths `plugin.json` declares get no scaffold (README, one sentence).
- No templates to choose from, no per-file commit (Commit and push still commits every change: README already says so).
- Another window shows a drafts folder created elsewhere at its next apply (any sync or settings change), not at once
  (docs/development.md).
- A draft can't be added to a project (no **Add to this project** on drafts items) (README).

## Tests

New `test/authoring.test.js` (`node:test`, `node:assert/strict`, helpers `tmpDir`, `rmDir`, `writeFile`, `makePlugin`
from `./helpers`; every temp dir removed in `t.after`):

1. `nameError`: `''` for `code-review`, `a`, `v1.2`, `x9`, a 64-character name of `a`; `NAME_RULE` for `Code`, `-a`,
   `a-`, `a_b`, `a b`, `''`, 65 `a`.
2. `serverNameError`: `''` for `lint`, `My_server-1`, `a.b`; the rule for `.x`, `a b`, `a/b`, `''`.
3. `yamlScalar`: `'Review a change.'` -> `'Review a change.'`; `'Fix: bugs'` -> `'"Fix: bugs"'`; `'#tag'` ->
   `'"#tag"'`; `'- item'` -> `'"- item"'`; `'say "hi"'` -> `'say "hi"'`; `'  padded  '` -> `'padded'`.
4. `itemFile`: the four exact texts of the Design for (`skill`, `code-review`, `Review a change.`), (`rule`, `style`,
   `House style.`), (`command`, `review-pr`, `Review the open pull request.`), (`agent`, `reviewer`, `Reviews a diff.`),
   and `skill` with description `Fix: bugs` -> line `description: "Fix: bugs"`.
5. `createItem` + catalog round trip: a temp repo with `makePlugin(root, 'p')`; create skill `code-review`, rule `style`,
   command `review-pr`, agent `reviewer` with descriptions; `readCatalog(root).plugins[0].children` lists ids
   `p/skills/code-review`, `p/rules/style.mdc`, `p/commands/review-pr.md`, `p/agents/reviewer.md` with their
   descriptions; creating skill `code-review` again -> `{ error: 'skills/code-review already exists' }`; with
   `rules/x.md` present, rule `x` -> `{ error: 'rules/x.md already exists' }`; command `y` with `commands/y.txt`
   present -> `{ error: 'commands/y.txt already exists' }`; name `Bad` -> `{ error: NAME_RULE }`, nothing written.
6. `splitCommandLine`: `'node server.js --port 3000'` -> `['node', 'server.js', '--port', '3000']`;
   `'"C:\\Program Files\\x.exe" a'` -> `['C:\\Program Files\\x.exe', 'a']`; `'  npx  -y pkg '` -> `['npx', '-y', 'pkg']`;
   `'a ""'` -> `['a', '']`; `'"open'` -> `null`; `''` -> `[]`.
7. `mcpEntry`: `{ command: 'npx -y srv' }` -> `{ command: 'npx', args: ['-y', 'srv'] }`; `{ command: 'srv' }` ->
   `{ command: 'srv' }`; `{ url: 'http://h/x' }` -> `{ url: 'http://h/x' }`.
8. `addMcpServer`:
   - no file -> `mcp.json` is exactly `{\n  "mcpServers": {\n    "lint": {\n      "url": "http://h/lint"\n    }\n  }\n}\n`.
   - existing `mcp.json` with `mcpServers` `{ a }` -> adds `b`, keeps `a`; `readCatalog` shows `p/mcp/a` and `p/mcp/b`.
   - only `.mcp.json` exists -> written there, no `mcp.json` created.
   - top-level form `{ "a": { "command": "x" } }` -> `b` added at the top level (no `mcpServers` key).
   - `{}` -> `mcpServers` created.
   - name already in `.mcp.json` while the target is `mcp.json` -> `{ error: '.mcp.json already has a server named a' }`.
   - invalid JSON in `mcp.json` -> error starting with `mcp.json: `, file unchanged.
   - name `a b` -> `{ error: SERVER_RULE }`.
9. `pluginLocation` / `createPlugin`:
   - marketplace listing plugins (copy of the fixture's shape: `{ name: 'team', plugins: [{ name: 'a', source: './a' }] }`
     + `makePlugin(root, 'a')`): `createPlugin(root, { name: 'tool', description: 'A tool.' })` -> `{ dir: <root>/tool }`;
     `tool/.cursor-plugin/plugin.json` is exactly
     `{\n  "name": "tool",\n  "description": "A tool.",\n  "version": "0.1.0"\n}\n`; marketplace `plugins` now ends
     with `{ name: 'tool', source: './tool', description: 'A tool.' }`; `readCatalog(root)` lists `a` and `tool`.
   - empty description -> plugin.json has no `description` key; marketplace entry has none either.
   - `metadata.pluginRoot: 'plugins'` -> folder `plugins/tool`, source `./tool`.
   - marketplace with only `{ "name": "team" }` -> folder created, marketplace.json byte-for-byte unchanged.
   - no marketplace.json -> folder created, no marketplace.json created.
   - folder `tool` already exists -> `{ error: 'tool already exists' }`.
   - folder `other` whose plugin.json name is `tool` -> `{ error: 'a plugin named tool already exists in this repository' }`.
   - invalid marketplace.json -> error starting with `marketplace.json: `, nothing created.
   - `plugins: {}` -> `{ error: 'marketplace.json: "plugins" is not an array' }`.
10. `movePlugin`: drafts root with `makePlugin(drafts, 'tool', { skills: ['s'] })`, target repo with a marketplace
    listing plugins: -> `{ dir: <target>/tool }` (no `leftover`), `tool/skills/s/SKILL.md` equal to the source's text,
    marketplace entry `{ name: 'tool', source: './tool', description }` added, `drafts/tool` gone, `drafts` still
    there. Target already has a `tool` folder -> error, source untouched.
11. `renameIds(['drafts:tool', 'drafts:tool/skills/a', 'drafts:toolbox', 'team:x'], 'drafts:tool', 'team:tool')` ->
    `['drafts:toolbox', 'team:tool', 'team:tool/skills/a', 'team:x']`.
12. `declaredPathsError`: plugin `{ name: 'r:p', customPaths: ['commands'] }`: `command` ->
    `'r:p sets the paths of its commands in plugin.json: add the file there by hand.'`; `skill` -> `''`; plugin
    without `customPaths` -> `''`; `mcp` with `customPaths: ['mcpServers']` -> `'r:p sets the paths of its MCP servers in plugin.json: add the file there by hand.'`.

Existing test files to extend:

- `test/catalog.test.js`: a plugin whose plugin.json has `"commands": "./cmds"` and `"skills": []` has
  `customPaths` `['skills', 'commands']`; a plugin without declared paths has no `customPaths` key.
- `test/repos.test.js` (`listRepos`): with `drafts: 'C:\\s\\.cursor\\plugins\\drafts'` (WIN), the first descriptor is
  `kind: 'drafts'`, `key: 'drafts'`, `dir` that path, `lockFile: 'C:\\s\\locks\\drafts.lock'`, `stateFile:
  'C:\\s\\state\\drafts.json'`, `url: ''`, `duplicateOf: null`, then the existing list unchanged; without `drafts` the
  existing assertions still hold (no drafts descriptor). `assignNames` gives it the name `drafts`.
- `test/treeModel.test.js`: `repoStatus` of a drafts descriptor -> `['only on this machine', 'edit', false]`, and
  `['updating…', 'sync~spin', false]` while syncing; `buildRepoNode` of it -> `contextValue 'repo.drafts'`, first
  tooltip line starts with `Drafts: `; `buildTree(..., { draft: true })` -> plugin `contextValue 'plugin.draft'`,
  children `'child.draft'`, and without the option unchanged (`plugin` / `child`).

## Keep in step

- `package.json`: version 0.7.0, commands and menus above.
- `README.md` (users; no relative links, `package.test.js` checks it):
  - Intro bullet list: add one bullet **Write new plugins and skills.** (New plugin, drafts until ready, scaffolds).
  - New section `## Writing plugins` after "Improving a team skill" (before "Staying up to date"):
    **New plugin** (title bar `...` menu or right-click a repository): drafts (only on this machine) or a repository
    (managed clone: a local change until Commit and push; your clone: new files); name rule; marketplace.json entry
    added when it lists its plugins; enabled in full. **Move to a repository** (right-click a draft plugin): copies it,
    deletes the draft, your selection follows; in a managed clone it is in Local changes, commit and push it. Drafts
    can't be added to a project. **New skill / rule / command / agent / MCP server** (right-click a plugin): what each
    writes (paths, frontmatter), enabled for you at once, opened in the editor; MCP: command line or URL into `mcp.json`
    (`.mcp.json` when only that exists); not offered for a kind whose paths `plugin.json` sets. One sentence: an edited
    `marketplace.json` or `mcp.json` is rewritten with two-space indentation.
  - "Known limitations": drafts are only on this machine and are not backed up; editing `marketplace.json` / `mcp.json`
    rewrites their formatting.
- `docs/development.md`:
  - "How it works": a paragraph on drafts (folder, `kind: 'drafts'`, key `drafts`, listed first when the folder exists,
    named `drafts` by `baseName`, no git and no sync, own lock, hidden in the view while empty, never deleted because it
    is the parent of registered plugin folders; another window starts watching it at its next apply) and on authoring
    (files written in the repository folder, never in a partial copy, under the repository's lock inside the operation
    queue; the new item is added to the selection when not already included; `customPaths` refuses declared kinds;
    `movePlugin` copies, adds the marketplace entry, deletes the draft, then the user's ids are renamed).
  - "Known limits (details)": formatting rewrite of `marketplace.json`/`mcp.json`; drafts not backed up; another window
    sees a new drafts folder at its next apply.
- `AGENTS.md`:
  - First line: version `0.7.0`.
  - Layout `lib/`: add `authoring` (`nameError`, `serverNameError`, `yamlScalar`, `itemFile`, `createItem`,
    `splitCommandLine`, `mcpEntry`, `addMcpServer`, `pluginLocation`, `createPlugin`, `movePlugin`, `renameIds`,
    `declaredPathsError`: scaffolds and drafts); `catalog` plugins carry `customPaths`; `listRepos` takes `drafts`.
  - "Why the code is shaped this way": one bullet: drafts (`<storage>/.cursor/plugins/drafts`, under `.cursor/plugins`
    so its skills are skills) are a repository of `kind: 'drafts'` listed first when the folder exists; the folder is
    never deleted (parent of registered plugin folders); authoring writes go to the repository folder under its lock,
    never to a partial copy (the copy follows through `syncCopy`).

## Commands

- Tests (Git Bash, repo root): `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js`
- Syntax of extension.js: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js`
- Packaging: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js` (writes
  `dist/cursor-team-plugins-0.7.0.vsix`).
- JSON check: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`

## Don't

- No commit. No change outside the files listed here without reporting it.
- Never run `cursor --install-extension` or launch Cursor windows.
- No dependency, no TypeScript, no bundler; nothing under `lib/` or `scripts/` requires `vscode`.
- Edit files with the Edit/Write tools, not with scripts.
- Don't change existing tests' expectations except where this plan says so; report any other test that fails.
- Don't delete the drafts folder anywhere (only a draft plugin's own folder, in `movePlugin`).
- Don't write into a partial copy (`filtered/...`): always `plugin.dir` (the repository's folder).
- Keep the README free of implementation details (paths under the storage are fine to name once; no function names).

## Changes after review

Filed after the release (0.7.0); the code is what counts where this plan differs.

- Implementer deviations kept: a drafts folder alone counts as "not configured" (`doRefresh`, `updateStatus`); a
  moved draft's entry is dropped from `partialCopies`; library write failures are returned as `{ error }`.
- Live test: the first move left the draft folder "delete pending" (Windows; Cursor still watched it as a registered
  plugin, gone at the next window reload). Fix: `Registrar.remove(name)` unregisters the draft before `movePlugin`,
  and an apply runs even when the move fails; `movePlugin` reports a draft still listed by `readdir` of its parent
  as `leftover` (new warning text: reload the Cursor windows, then delete it if still there); `exists()` in
  `lib/authoring.js` counts every error but ENOENT as "there". Tests: `Registrar remove ...` and a Windows-only
  `movePlugin reports a draft it could not remove`.
