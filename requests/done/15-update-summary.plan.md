# Plan 15: update summary

## Context

- Repository: cursor-team-plugins (Cursor extension, plain CommonJS, no dependency, no build). Request:
  `requests/15-update-summary.md`. Version 0.8.3 -> **0.8.4**.
- Today an `updated` sync shows "Team plugins: <name> updated (N new commit(s)). Start a new chat to use the
  changes." with a **What changed** button that prints `git log --oneline from..to` into the output channel
  (`extension.js` `notifyAfterSync`, case `'updated'`, around lines 556-570; `lib/sync.js` `changesBetween`, around
  line 586). The view never says which items changed; item tooltips give only the description.
- Files and functions involved:
  - `lib/updates.js` (new): fingerprints, last changes, marks, seen records, notification text, ages; and the async
    git readers (they take `run`, like `lib/sync.js`).
  - `lib/treeModel.js`: `buildTree` (descriptions, tooltips, `mark` on nodes), `buildRepoNode` (counts), a new
    `itemDecoration`.
  - `lib/sync.js`: `headFileArgs` (line ~355) becomes `revFileArgs`; `changesBetween` is removed.
  - `extension.js`: `stateOf` (line ~128), `syncRepo` (~373), `notifyAfterSync` (~533), `doApply` (~638, calls
    `refreshChanges` at its end), `refreshChanges` (~851), decorations (`itemUri`, `updateProjectStates`,
    `projectDecorations`, ~1188-1230), `PluginTree.getChildren` / `getTreeItem` (~1250-1340), `startWatchers`
    (~1531), command registration (~2480-2600, `openItem` at ~2493, the `team-plugins-git` content provider at
    ~2577), `gitUri` (~2609), `testHook` (~3092), `activate` (`createTreeView`, ~3156).
  - `package.json`: version, `colors`, `commands`, `menus`.
  - Tests: `test/updates.test.js` (new), `test/treeModel.test.js`, `test/sync.test.js`, `test/live/updates.live.js`
    (new).
  - Docs: `README.md`, `docs/development.md`, `AGENTS.md`.

## Measured facts (don't measure them again)

- Cursor 3.32 is built on VS Code 1.147 (`resources/app/product.json`, `"vscodeVersion": "1.147.0"`).
- `vscode.changes` exists (extension host bundle: `new Me("vscode.changes","_workbench.changes",...)`). Its handler
  is `for (const [o, a, l] of n) s.push({ resource: revive(o), original: { resource: revive(a) }, modified: {
  resource: revive(l) } })`: each entry is `[labelUri, leftUri, rightUri]`, **both sides required**. For a missing
  side pass a `team-plugins-git:` URI with `rev: ''` (the content provider returns `''`). Call:
  `vscode.commands.executeCommand('vscode.changes', title, [[label, left, right], ...])`.
- `TreeView.badge` is wired in the extension host (`set badge(d){ ... isViewBadge(d) ? a.badge = { value:
  Math.floor(Math.abs(d.value)), tooltip: d.tooltip } : d === void 0 && (a.badge = void 0) }`). Whether Cursor shows it
  on its activity bar icon is a hand check.
- `FileDecoration.validate` accepts a badge of at most **2 characters** (code points): `'PN'` and `'PM'` are valid,
  `'P·N'` would throw.
- `git ls-tree -r -t -z HEAD` (git 2.47, test fixture): one record per `\0`, `<mode> SP <type> SP <oid> TAB <path>`;
  trees are listed too (`040000 tree 7b6c...\treview/skills/code-review`), so a skill folder's tree id is one lookup.
  Paths are raw UTF-8 with `-z`.
- `git log -z --max-count=1000 --no-renames --name-only --format=%x01%H%x00%an%x00%ae%x00%aI%x00%s HEAD` (fixture with
  commits by Alice and Bob, one path `review/rules/é x.mdc`): each record starts with `\x01`, then
  `hash\0name\0email\0iso-date\0subject\0`, then `\n` followed by the paths, each ending in `\0`. Split on `\x01`,
  drop the empty first piece, split each piece on `\0`: `[hash, name, email, date, subject, '\nfirst/path',
  'second/path', ..., '']`; strip the leading `\n` of the first path; drop empty strings. A subject of several lines
  without a blank line comes joined by spaces. Merge commits list no paths (default `--diff-merges=off`). Newest
  first.
- `git var GIT_AUTHOR_IDENT` prints `Name <email> 1795716034 +0100` and honours both config and the
  `GIT_AUTHOR_NAME/EMAIL` environment; with no identity it exits 128 ("Author identity unknown"). `git config
  user.email` misses the environment: use `git var`. On the maintainer's machine there is no global email (exit 128).
- From the project notes (not checked again): `lib/git.js` trims stdout unless `{ trim: false }`; a `seen/` folder
  outside `state/` needs its own watcher (the `state/*.json` watcher in `startWatchers` triggers a full apply); a
  tree item's file decoration colours its label only when it has a `resourceUri` (`team-plugins:/<key>`, already set
  on plugin and item rows); in a live scenario `t.find(id)` returns a snapshot without `kind`/`key`, so a command
  taking a node is called with `{ kind, key }` built by hand; the Test-mode `ui` records `showQuickPick` and lets
  `hook.respond` answer it with an item's label; dialogs go through `ui` only.
- Merged ids are `<repository name>:<local id>` (`mergeCatalogs`); a repository's own catalog (`catalogs.get(key)`,
  `readCatalog`) has local ids (`review/skills/code-review`, `review/mcp/lint`). `readCatalog(...).renamed` is an
  object of local ids; `repos.followRenames({ plugins, renamed: new Map(Object.entries(renamed)) }, localId)` follows
  them for local ids (no `:` in a local id, so `formerNames` never applies).

## Design

### Seen records

One file per repository: `<storage>/seen/<key>.json` (`key` = the repository's key, as for `state/<key>.json`):

```json
{ "version": 1, "items": { "review/skills/code-review": { "oid": "7b6c…", "commit": "b952…", "path": "review/skills/code-review", "kind": "skill", "name": "code-review" } } }
```

- `oid`: the item's fingerprint when last seen; `commit`: HEAD then (the diff's left side); `path`: the item's path
  relative to the repository root, `/` separators (skill: its folder; rule, command, agent: its file; MCP server: the
  MCP file it comes from); `kind` and `name` as in the catalog (so a removed item can still be listed and diffed).
- Read with `JSON.parse`; missing, unreadable, not an object or `version !== 1` -> `null` (treated as "never seen":
  baseline). Write only when the JSON text differs from what was read: `JSON.stringify(record, null, 2)` to
  `<file>.tmp`, then `fs.renameSync` (like `sync.writeState`); a write failure is logged once (`loggedWarnings`) and
  otherwise ignored.
- Watch `<storage>/seen/*.json` in `startWatchers` (create + change, like the `state/` watcher): on an event,
  `debouncedApply()`. Create the folder first (`fs.mkdirSync(..., { recursive: true })`).

### Fingerprints (`lib/updates.js`)

- `itemPath(item, repoDir)`: `path.relative(repoDir, item.kind === 'skill' ? path.dirname(item.file) : item.file)`
  with `\` replaced by `/`.
- `fingerprints(items, tree, mcpTexts)` -> `Map<localId, oid>`. `tree`: `Map<path, oid>` of `parseLsTree`;
  `mcpTexts`: `Map<path, text>` of the MCP files at the same revision. For a skill, rule, command, agent: `tree.get(
  itemPath)`; absent (not committed) -> no entry. For an MCP server: `serverEntry(mcpTexts.get(path), item.name)`;
  `undefined` -> no entry; else `'mcp:' + sha1(JSON.stringify(entry))` (hex, `crypto.createHash('sha1')`).
- `serverEntry(text, name)`: parse `text` (strip a BOM; invalid JSON or not a string -> `undefined`); return
  `(catalog.serverTable(obj) || obj)[name]` only when `catalog.mcpServerNames(obj).includes(name)`, else `undefined`.
- `serverText(text, name)`: `JSON.stringify({ [name]: entry }, null, 2) + '\n'`, or `''` when `serverEntry` is
  `undefined`.

### Last changes

- `parseLog(text)` -> `[{ hash, author, email, date, subject, files }]`, newest first (format above; `email`
  lower-cased; `date` the ISO string as printed).
- `lastChanges(paths, commits)`: `paths`: `Map<key, path>`; returns `Map<key, commit>` with, for each key, the first
  commit (newest) having a file equal to `path` or starting with `path + '/'`. No such commit -> no entry. Build it in
  one pass over the commits (stop early when every key is found).
- Keys used by the extension: every item's local id (its `itemPath`), every plugin's name (its folder,
  `itemPath`-style relative path of `plugin.dir`), and every removed record's id (its `path`).

### Marks

`computeMarks({ items, fps, record, last, self, head, renamed, plugins })` -> `{ marks, removed, record, changed }`:

- `items`: the repository's catalog children (all plugins, catalog order), `fps` their fingerprints, `record` the
  seen record or `null`, `last` the `lastChanges` map, `self` the user's email (lower-case, `''` when unknown),
  `head` the HEAD hash, `renamed`/`plugins` for `followRenames`.
- **Baseline** when `record` is `null`: the new record holds `{ oid, commit: head, path, kind, name }` for every
  item with a fingerprint; `marks` empty, `removed` empty, `changed: true`.
- Otherwise, start from a copy of `record.items`:
  1. Renames: each record id that is not an item id is followed with `followRenames`; when it reaches an item id
     that has no record, the record moves to that id (`changed`).
  2. For each item with a fingerprint, in order: same `oid` as its record -> nothing. Else, when `self !== ''` and
     `last.get(id)` exists with `email === self` -> its record becomes `{ oid, commit: head, path, kind, name }`
     (`changed`), no mark. Else `marks.set(id, record ? 'updated' : 'new')`.
  3. Each remaining record id that is not an item id: when `self !== ''` and its last change (`last.get(id)`, keyed
     by the record's `path`) has `email === self` -> deleted from the record (`changed`); else it is listed in
     `removed` as `{ id, path, kind, name, commit }` (in record key order).
  4. Items without a fingerprint (not committed) are left alone: no mark, record unchanged.
- `markSeen(record, id, entry)`: returns a copy where `items[id] = entry` (or deleted when `entry` is `null`, for a
  removed item). `entry` is `{ oid, commit: head, path, kind, name }`.
- A repository whose last sync result is `cloned` or `switched` is recomputed as a baseline once (set
  `s.updatesBaseline = true` in `syncRepo`; `refreshUpdates` uses it as `record = null` and clears it).

### Reading git (`lib/updates.js`, async, `run` as in `lib/sync.js`)

- `readGitData({ run, repoDir, items })` -> `null` when `git rev-parse HEAD` fails (no repository, empty repository),
  else `{ head, tree, mcpTexts, commits, self }`:
  - `head`: `rev-parse HEAD`.
  - `tree`: `parseLsTree` of `ls-tree -r -t -z HEAD` (`{ trim: false }`; a failure -> empty map).
  - `mcpTexts`: for each distinct `itemPath` of the MCP items, `show HEAD:<path>` (`{ trim: false }`); a failure ->
    no entry.
  - `commits`: `parseLog` of the log command above (`{ trim: false }`; a failure -> `[]`).
  - `self`: `parseIdent` of `var GIT_AUTHOR_IDENT` (the text between the last `<` and the following `>`,
    lower-cased; a failure or no `<...>` -> `''`).
- `rangeHashes({ run, repoDir, from, to })` -> `Set` of `rev-list <from>..<to>` (a failure -> empty set).
- `treeFiles({ run, repoDir, rev, dir })` -> sorted list of the file paths below `dir` at `rev`: `ls-tree -r -z
  --name-only <rev> -- <dir>/` (`{ trim: false }`); `rev === ''` or a failure -> `[]`.

### The extension's update pass

- `refreshUpdates()`, called in `doApply` right after `refreshChanges()` (before `updateStatus()`), for each entry of
  `descs` that is active (`isActive`), not syncing, and of kind `managed` or `local` (never `drafts`):
  1. `head` = `rev-parse HEAD`; when it equals the cached `s.updates.git.head`, reuse the cached git data, else
     `readGitData` (items = the repository's catalog children, `catalogs.get(d.key)`).
  2. Read the seen record, `computeMarks`, write the record when `changed`.
  3. Store `s.updates = { git, marks, removed, record, counts: { new, updated, removed } }` (null when `readGitData`
     returned null: no marks, no tooltips lines for that repository).
  4. If `s.updateNotice` is set (below), show the notification and clear it.
  A failure in one repository is logged once and leaves `s.updates = null`.
- Then set `treeView.badge`: total = sum of `new + updated + removed` over the repositories; `{ value: total, tooltip:
  `${total} new or updated team plugin item(s) since you last looked` }` when `total > 0`, else `undefined`.
- `notifyAfterSync`, case `'updated'`: no message any more; it sets `s.updateNotice = { from, to, commits, kept }`.
  The notification is shown by `refreshUpdates` once the marks are computed (the apply that follows every sync).

### The notification

- `noticeEntries({ marks, removed, last, range, items, enabled })` -> list of `{ id, verb, author, name }`:
  - every marked item whose `last` commit hash is in `range` (`rangeHashes(from, to)`), verb `added` for `new`,
    `updated` for `updated`; every `removed` entry whose last change is in `range`, verb `removed`;
  - order: marked items whose merged id is in `enabled` (the effective selection's included ids of the plugin) first,
    then the other marked items, both in catalog order; removed entries last;
  - `author`: the commit's author name.
- `noticeText(repoName, entries, { kept })`:
  - 1 entry: `p1`; 2: `p1 and p2`; 3 or more: `p1, p2 and N more` (N = count - 2); each `p` is `${author} ${verb}
    ${name}`.
  - Text: `Team plugins (${repoName}): ${list}. Start a new chat to use the changes.` plus ` Your local changes were
    kept.` when `kept > 0`. Button: `What changed` (runs `teamPlugins.whatChanged` with `{ repo: key }`).
- No entry: when every commit of `range` found in `git.commits` has `email === self` (and `self !== ''`), show
  nothing; else show `Team plugins: ${name} updated (${commits} new commit(s)). Start a new chat to use the
  changes.` (plus the kept sentence), **without** a button.
- Examples (tests): one entry -> `Team plugins (team-test): Alice updated code-review. Start a new chat to use the
  changes.`; four entries -> `Team plugins (team-test): Alice updated code-review, Bob added lint and 2 more. Start a
  new chat to use the changes.`

### Ages and dates (`lib/updates.js`)

- `ago(date, now)`: seconds `s = (now - date) / 1000`: `< 60` (or negative) -> `just now`; `< 3600` -> `N minute(s)
  ago`; `< 86400` -> `N hour(s) ago`; `< 30 days` -> `N day(s) ago`; `< 365 days` -> `N month(s) ago` (30-day
  months); else `N year(s) ago`. N is `Math.floor`; singular when N is 1 (`1 hour ago`, `2 hours ago`).
- `shortDate(date)`: local time `YYYY-MM-DD HH:MM` (local getters, zero-padded).
- `lastLine(commit, now)`: `Last changed by ${author}, ${ago} (${shortDate})`.

### The view

- `buildTree(catalog, eff, project, { draft, updates })`, `updates` optional: `{ marks: Map<mergedId, 'new' |
  'updated'>, last: Map<mergedId or merged plugin name, commit>, now: Date }` (the extension builds it from
  `s.updates` by prefixing `${repoName}:` to the local ids).
  - Item node: `mark` = the mark or `null`. `description`: `KIND_LABELS[kind]`, plus ` · new` / ` · updated` when
    marked. `tooltip`: the current text (description or file name, then the project line), then `lastLine` when
    `last` has the item, then `New since you last looked` / `Updated since you last looked` when marked (lines
    joined by `\n`).
  - Plugin node: its `description` parts get `${n} new` and `${m} updated` appended (after the version and the
    `x/y` part, only when > 0); its tooltip gets `lastLine` of the plugin when known (after the project line).
  - Without `updates`, nodes are exactly as today (plus `mark: null` on items).
- `buildRepoNode(desc, state, children, counts)`, `counts` optional `{ new, updated, removed }`: when their sum is
  > 0, `description` becomes `${status.text} · ` + the non-zero parts joined by ` · ` (`2 new`, `1 updated`, `1
  removed`), and the tooltip gets, before the `State:` line, `Since you last looked: 2 new, 1 updated, 1 removed
  (What changed)` (only the non-zero parts, joined by `, `).
- `itemDecoration(project, mark)` (pure, `lib/treeModel.js`) -> `null` or `{ badge, tooltip, color }`:
  - badge: `'P'` when `project` is `'all'` or `'some'`, then `'N'` for `new` / `'M'` for `updated` (so `P`, `N`, `M`,
    `PN`, `PM`);
  - tooltip: the parts `Enabled by this project` (all) / `Partly enabled by this project` (some), `New since you last
    looked` / `Updated since you last looked`, joined by ` · `;
  - color: `'teamPlugins.newItemForeground'` for new, `'teamPlugins.updatedItemForeground'` for updated, else
    `'teamPlugins.projectItemForeground'` when project is `'all'`, else `null`.
  `projectDecorations.provideFileDecoration` uses it (`new vscode.FileDecoration(badge, tooltip, color ? new
  vscode.ThemeColor(color) : undefined)`); `updateProjectStates` records `{ project, mark }` per item URI (plugin
  rows: `mark` is always `null`) and fires the emitter when the map changed. The test hook's `decoration(key)` keeps
  its shape.
- `package.json` `colors`: `teamPlugins.newItemForeground` ("Colour of the items added since you last looked, in the
  Team Plugins view.", all four defaults `gitDecoration.addedResourceForeground`) and
  `teamPlugins.updatedItemForeground` ("Colour of the items updated since you last looked, in the Team Plugins
  view.", all four defaults `gitDecoration.modifiedResourceForeground`).

### Commands

- `teamPlugins.whatChanged`, title `What changed`, category `Team Plugins`, icon `$(diff)`. Argument: a repository
  node, `{ repo: key }`, or nothing.
  - Nothing: the repositories with a total > 0; none -> `ui.showInformationMessage('Nothing new since you last
    looked.')`; one -> it; several -> `ui.showQuickPick` of their names (placeHolder `Which repository?`).
  - A repository with no marks: `ui.showInformationMessage(`Nothing new in ${name} since you last looked.`)`.
  - Exactly one entry (marked or removed): open its diff directly (below).
  - Else `ui.showQuickPick(items, { placeHolder: `${name}: ${total} change(s) since you last looked` })`; items:
    first `{ label: '$(check-all) Mark all as seen' }`, then each marked item `{ label: `$(${TREE_ICONS[kind]})
    ${name}`, description: `${plugin} · ${KIND_LABELS[kind]} · ${verb} by ${author}, ${ago}`, detail: subject }`
    (verb `added` / `updated`; without a known last commit: `${plugin} · ${kind label} · ${verb}` and no detail),
    then each removed entry with icon `trash` and verb `removed`. `${plugin}` is the local plugin name (local id up to
    the first `/`). Picking **Mark all as seen** writes a baseline record (as in **Baseline**, at the cached head) and
    re-applies; picking an item opens its diff.
- `teamPlugins.showChanges`, title `Show changes`, category `Team Plugins`. Argument: an item node (`{ kind, key }`,
  key = merged id). Marked -> its diff since last seen; not marked -> its last change: left = the parent of the last
  commit (`rev-parse <hash>^`; failure, a root commit -> `''`), right = `HEAD`, title `${name}: last change
  (${author}, ${ago})`; no last commit known -> `ui.showInformationMessage(`No commit of ${repoName} has changed
  ${name} yet.`)`.
- The diff of an item "since last seen": left rev = the record's `commit` for an updated or removed item, `''` for a
  new one; right rev = `HEAD`, `''` for a removed item. Title: `${name} (${author}, ${ago})` when the last commit is
  known, else `${name} (changes since you last looked)`.
  - MCP server: `vscode.diff` of `gitUri(dir, leftRev, path, name)` and `gitUri(dir, rightRev, path, name)` (the
    content provider serves `serverText`).
  - Rule, command, agent: `vscode.diff` of the file at both revs.
  - Skill: the files = union of `treeFiles(leftRev, path)` and `treeFiles(rightRev, path)`; one file ->
    `vscode.diff`; several -> `vscode.changes(title, files.map((f) => [label, gitUri(dir, leftRev, f), gitUri(dir,
    rightRev, f)]))`, where `label` is the right URI when the file exists at the right rev, else the left one; no
    file -> `vscode.diff` of the `SKILL.md` path anyway (both sides empty is fine).
  - After the diff command resolves, the item is marked seen: `markSeen(record, id, entry)` with its current
    fingerprint and the cached head (`null` for a removed item), written, then `debouncedApply()`.
- `openItem`: after `showTextDocument`, when the item is marked, mark it seen the same way.
- `gitUri(repo, rev, file, server)`: the query gets `server` when given.
- Content provider: the repository is any configured entry of kind `managed` or `local` whose `dir` matches
  (`samePath`), not only managed. `sync.revFileArgs(request, repoDir)` (renamed from `headFileArgs`) accepts `rev`
  matching `/^(HEAD|[0-9a-f]{40}|[0-9a-f]{64})$/` and returns `['show', `${rev}:${request.path}`]`, null otherwise
  (same repository and path checks as today). When `typeof request.server === 'string'`, return
  `updates.serverText(stdout, request.server)` instead of `stdout`.
- `package.json` menus:
  - `view/item/context`: `teamPlugins.whatChanged` when `view == teamPlugins.plugins && viewItem =~
    /^repo\.(managed|local)$/`, group `0_updates@1`; `teamPlugins.showChanges` when `view == teamPlugins.plugins &&
    viewItem =~ /^child(\.project)?$/`, group `0_updates@1`.
  - `commandPalette`: `teamPlugins.showChanges` with `"when": "false"` (it needs a node); `whatChanged` stays visible.
- `changesBetween` (`lib/sync.js`) is removed with its use in `extension.js` and its assertions in
  `test/sync.test.js` (lines ~86-87: the two lines, keep the rest of that test).

### Test hook

- `badge: () => (treeView.badge ? { value: treeView.badge.value, tooltip: treeView.badge.tooltip } : null)`.
- `updates: (key) => { const s = stateOf(key).updates; return s ? { counts: s.counts, marks: Object.fromEntries(s.marks),
  removed: s.removed.map((r) => r.id) } : null; }`.

## Impact

- `buildTree` callers: only `PluginTree.getChildren` (pass `updates` per repository). Existing `treeModel` tests keep
  passing: without `updates` item nodes only gain `mark: null` (update the `deepEqual` expectations in
  `test/treeModel.test.js` that compare whole item nodes, if any, by adding `mark: null`).
- `buildRepoNode` callers: `getChildren` (pass `s.updates && s.updates.counts`).
- `projectDecorations` / `updateProjectStates`: now also driven by marks; the test hook's `decoration` is unchanged
  in shape; the live scenario `selection.live.js` (or any other) that checks a project badge `P` must still pass.
- `notifyAfterSync` `'updated'`: the message moves to `refreshUpdates`; nothing else reads `changesBetween`.
- `headFileArgs` -> `revFileArgs`: its only caller is the content provider; `test/sync.test.js` (test at ~line 728)
  is updated: rename, `rev: 'HEAD~1'` and `--output=x` still `null`, a 40-hex rev now accepted (`['show',
  '<hash>:<path>']`), `'ABCDEF…'` upper case or 39 hex chars -> `null`. Reason: the provider now serves the version
  the user last saw.
- `startWatchers`: one more watcher (`seen/*.json`); `stopWatchers` disposes it with the others (it is in `watchers`).
- `doApply` runs a little more git per repository (`rev-parse HEAD` each time; the rest only when HEAD changed).

## Not handled

(README **Known limitations** gets the first and the last item; `docs/development.md` **Known limits (details)** all.)

- Two servers of one MCP file changed by different people: both are credited to whoever last changed the file.
- Content behind a symlinked skill folder (git stores the link, not its target).
- A rename (recorded in `marketplace.json`) moves the record, but the renamed item usually shows as updated.
- Items whose last change is older than the last 1000 commits have no "Last changed by" line.
- A version the user last saw that a force-push made unreachable (and git pruned): the diff's left side is empty.
- The notification shows only in the window that synced (as today); the marks show in every window.

## Tests

`test/updates.test.js` (new, `node:test`, `helpers.js` for git repositories):

- `parseLsTree`: the fixture lines above (with a non-ASCII path) -> map of path -> oid (trees included).
- `parseLog`: a text built with the format above (two commits, the first with two paths one of them non-ASCII, a merge
  with no path) -> 3 entries, newest first, emails lower-cased, `files` without the leading `\n`.
- `parseIdent`: `'Agent <A@X.org> 1795716034 +0100'` -> `'a@x.org'`; `''` -> `''`; `'no email'` -> `''`.
- `itemPath`: skill -> folder, rule -> file, Windows separators -> `/`.
- `serverEntry` / `serverText`: `mcpServers` form and top-level form; unknown name -> `undefined` / `''`; invalid
  JSON -> `undefined`.
- `fingerprints`: an item not in the tree has no entry; two MCP servers of one file: changing one server's entry
  changes only its fingerprint.
- `lastChanges`: `review/skills/code-review` matches `review/skills/code-review/SKILL.md` but not
  `review/skills/code-review-2/SKILL.md`; newest wins; unknown path -> no entry.
- `computeMarks`:
  - `record: null` -> no marks, every fingerprinted item recorded with `commit: head`, `changed: true`.
  - same oids -> no marks, `changed: false`.
  - one oid changed, last author Alice, self `me@x.org` -> `updated`; a new item -> `new`.
  - one oid changed by `me@x.org` (self) -> no mark, record advanced, `changed: true`; with `self: ''` -> `updated`.
  - a record whose item is gone, last change by Alice -> in `removed`; by self -> deleted from the record.
  - rename: record `review/skills/old`, `renamed: { 'review/skills/old': 'review/skills/new' }`, item
    `review/skills/new` with another oid -> record moved, mark `updated`; with the same oid -> no mark, `changed`.
  - an item without a fingerprint -> no mark, record untouched.
- `markSeen`: sets an entry; `null` deletes it; the input is not mutated.
- `noticeEntries` / `noticeText`: ordering (an enabled item after a non-enabled one in catalog order comes first;
  removed last); commits outside `range` left out; the 1, 2, 3 and 4-entry texts exactly; the kept sentence.
- `ago`: 0 s, 59 s -> `just now`; 60 s -> `1 minute ago`; 2 h -> `2 hours ago`; 1 day; 45 days -> `1 month ago`; 400
  days -> `1 year ago`; a future date -> `just now`. `shortDate(new Date(2026, 10, 24, 9, 5))` -> `2026-11-24 09:05`.
- `readGitData` on a real repository (`helpers.git`, `IDENTITY`; a second commit by `-c user.name=Alice -c
  user.email=alice@example.com`): `head` equals `rev-parse HEAD`, `tree` has the skill folder, `commits[0].author ===
  'Alice'`, `mcpTexts` holds the MCP file; on a folder that is not a repository -> `null`. `self` with `-c` can't be
  passed through `run`: check only that it is a string.
- `rangeHashes` and `treeFiles` on the same repository (`treeFiles` with `rev: ''` -> `[]`).

`test/treeModel.test.js`:

- `buildTree` with `updates`: marked item `description` `skill · updated` / `rule · new`, tooltip lines in order
  (description, project line when any, `Last changed by Alice, 2 hours ago (…)`, `Updated since you last looked`);
  plugin description `v1.0.0 · 1 new · 1 updated` (and with a partial selection `v1.0.0 · 1/3 · 1 updated`);
  without `updates` unchanged (`mark: null`).
- `buildRepoNode` with counts `{ new: 2, updated: 1, removed: 0 }` -> description `up to date · 2 new · 1 updated`,
  tooltip line `Since you last looked: 2 new, 1 updated (What changed)` just before `State:`; counts all 0 -> as
  today.
- `itemDecoration`: the six combinations (`null`/`all`/`some` x `null`/`new`/`updated`) -> badge, tooltip, color as
  in the design; `(null, null)` -> `null`.

`test/sync.test.js`: `revFileArgs` as in **Impact**; remove the `changesBetween` assertions.

`test/live/updates.live.js` (new scenario, `timeoutSec` 120):

- Setup: `ctx.makeTestRepo(path.join(ctx.repos, 'team.git'))`, settings `teamPlugins.repositories: [url]`,
  `teamPlugins.enabled: ['team-test:review']`; data `{ bare: url, work: path.join(ctx.repos, 'work') }`.
- Wait for `review` registered and idle. Check: `hook.badge() === null`; `t.find('item:team-test:review/skills/code-review').description
  === 'skill'`; `<hook.storage>/seen/<key>.json` exists.
- `t.git(['clone', bare, work])`; as Alice (`-c user.name=Alice -c user.email=alice@example.com -c
  commit.gpgsign=false`): append a line to `review/skills/code-review/SKILL.md`, add
  `review/skills/code-review/checklist.md`, add `docs/skills/new-skill/SKILL.md` (frontmatter with `description:
  New skill`), commit `Improve code-review`, push.
- `teamPlugins.syncNow`; wait for an information message equal to `Team plugins (team-test): Alice updated
  code-review and Alice added new-skill. Start a new chat to use the changes.` with button `What changed`.
- Check: code-review `description === 'skill · updated'`, its tooltip contains `Last changed by Alice, just now`;
  `item:team-test:docs/skills/new-skill` description `skill · new`; `hook.decoration('team-test:review/skills/code-review').badge
  === 'M'`; `hook.badge().value === 2`; the repo node's description contains `1 new · 1 updated`.
- `hook.respond` answers the quick pick with the label `$(${icon}) code-review` (icon from the recorded items, or
  match the recorded label that ends in `code-review`); run `teamPlugins.whatChanged` with `{ repo: key }`; check
  the recorded pick has `$(check-all) Mark all as seen` first and 3 items; wait for a tab whose label starts with
  `code-review (Alice, ` in `vscode.window.tabGroups.all`; then code-review's description is `skill` and
  `hook.badge().value === 1`.
- Run `teamPlugins.whatChanged` again: one entry left, so no pick is recorded and a tab `new-skill (Alice, ` opens;
  `hook.badge() === null` afterwards.
- `teamPlugins.showChanges` with `{ kind: 'skill', key: 'team-test:review/skills/code-review' }`: a tab labelled
  `code-review: last change (Alice, …)` opens.
- `t.noSpinner()`.

## Keep in step

- `package.json`: `version` `0.8.4`; the two colours, the two commands, the menus and `commandPalette` entry above.
- `README.md`:
  - **Staying up to date**: replace "After an update, **What changed** in the notification lists the new commits."
    with a short paragraph: after an update the notification names who changed what ("Alice updated code-review");
    the view marks the items added or updated since you last looked (`new` / `updated`, a coloured `N` / `M`, the
    counts on plugin and repository rows, a number on the view's icon); **What changed** (in the notification, on a
    repository's right-click menu, or in the command palette) lists them and opens each one's diff since the
    version you last saw; **Show changes** on an item does the same, or shows its last change; opening an item's
    diff or its file marks it seen, **Mark all as seen** clears a repository. Your own changes are never marked.
    Item and plugin tooltips say who last changed them, and when.
  - **Known limitations**: "An MCP server is credited to whoever last changed its plugin's MCP file." and "Who last
    changed an item is read from the last 1000 commits."
- `docs/development.md` **How it works**: a subsection `### Update summary` (after the walkthrough subsection or
  next to the sync description): the seen records and their watcher, fingerprints (tree/blob ids, MCP entry hash),
  the log pass cached per HEAD, `git var GIT_AUTHOR_IDENT` for "own", the baseline rules, the deferred notification
  (`updateNotice` shown by `refreshUpdates`), the content provider's revs and `server`, `vscode.changes` needing both
  sides, the 2-character decoration badge. **Known limits (details)**: the **Not handled** list.
- `AGENTS.md`: in **Layout**, add `updates` (`parseLsTree`, `parseLog`, `parseIdent`, `itemPath`, `serverEntry`,
  `serverText`, `fingerprints`, `lastChanges`, `computeMarks`, `markSeen`, `noticeEntries`, `noticeText`, `ago`,
  `shortDate`, `lastLine`, `readGitData`, `rangeHashes`, `treeFiles`: the update summary) to the `lib/` list, replace
  `headFileArgs` by `revFileArgs` in the `sync` entry, add `itemDecoration` to the `treeModel` entry, and add
  `updates.live.js` nowhere (the scenarios are not listed one by one). In **Why the code is shaped this way**, add:
  - "What the user has seen is `<storage>/seen/<key>.json` (outside `state/`, watched: marking an item seen applies in
    every window); marks compare fingerprints at HEAD (tree or blob ids, an MCP server's entry hash), so uncommitted
    edits never mark; the user's own changes (author email = `git var GIT_AUTHOR_IDENT`, which honours the
    environment unlike `git config user.email`) are recorded, not marked."
  - "`vscode.changes` takes `[label, left, right]` and both sides are required (an absent side is a
    `team-plugins-git:` URI with an empty rev); a `FileDecoration` badge is at most 2 characters (`PN`, `PM`)."
  - "The update notification is shown by `refreshUpdates` (after the apply that follows the sync), not by
    `notifyAfterSync`: it needs the marks."

## Commands

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js updates
```

(Git Bash, from the repository root.) The live run is done by the main agent at review; the implementer may run it.

## Hand checks

What the live scenario can't show: the look. Run in the user's Cursor, after the install.

Setup:
- `python scripts/live_check.py settings backup <scratchpad>/settings-15`.
- Build the fixture: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/make-test-repo.js
  <scratchpad>/team-plugins.git`; set `teamPlugins.repositories` to the path it prints and `teamPlugins.enabled` to
  `["team-test:review"]` in the user settings.
- `python scripts/live_check.py install`; the user reloads the window (`Developer: Reload Window`).
- Check with `python scripts/live_check.py status --since install --grep "team-test"` that the repository is cloned.

Steps:
1. The user opens the Team Plugins view. They should see `team-test` with its plugins and **no** `new` / `updated`
   marks, no number on the view's icon. Check: `<storage>/seen/<key>.json` exists (storage:
   `%APPDATA%\Cursor\User\globalStorage\mathieugun.cursor-team-plugins`).
2. Agent: clone the fixture to `<scratchpad>/work`, commit as Alice (`-c user.name=Alice -c
   user.email=alice@example.com`) an edit of `review/skills/code-review/SKILL.md`, a new
   `review/skills/code-review/checklist.md` and a new `docs/skills/new-skill/SKILL.md`; push. The user clicks
   **Sync now** (the view's sync icon). They should see the notification "Team plugins (team-test): Alice updated
   code-review and Alice added new-skill. Start a new chat to use the changes." with **What changed**; in the view,
   `code-review` reads `skill · updated` with an `M` badge in the modified colour, `new-skill` reads `skill · new`
   with an `N` badge in the added colour, the plugin rows show `1 updated` / `1 new`, the repository row `1 new · 1
   updated`, and the Team Plugins icon in the activity bar shows `2`. Hovering `code-review` shows "Last changed by
   Alice, … (date)" and "Updated since you last looked".
3. The user clicks **What changed** in the notification (or right-clicks the repository > `What changed`). They
   should see a list headed by `Mark all as seen`, with `code-review` (`review · skill · updated by Alice, …`,
   subject below) and `new-skill`. They pick `code-review`: one editor titled `code-review (Alice, …)` shows two
   files, `SKILL.md` (the added line) and `checklist.md` (all added), each readable on both sides. The mark on
   `code-review` goes, the icon shows `1`.
4. The user clicks `new-skill` in the view (opens its file): its mark goes, the icon number disappears.
5. The user right-clicks `style` (a rule) > `Show changes`: a diff titled `style: last change (test, …)` opens (left
   empty: the file was added by the fixture's first commit).
6. Optional: tick `code-review` into the project (`Add to this project`) and make another Alice commit to it: the
   badge reads `PM`.

Cleanup: `python scripts/live_check.py settings restore <scratchpad>/settings-15`; the user reloads the window.

## Don't

- No commit. Don't edit `requests/15-update-summary.md` or this plan. Report any change outside the listed files.
- Never run `cursor --install-extension` or launch the user's Cursor; `scripts/live-test.js` is allowed.
- No new dependency, no TypeScript, no bundler; nothing under `lib/` requires `vscode`.
- Every dialog goes through `ui` (never `vscode.window.show*` directly); count call sites with a multiline search
  (`vscode\.window\s*\.\s*show`).
- git output parsed with `-z` needs `{ trim: false }`.
- Don't change the `contextValue` of tree items (menus match them with regexes); the new menus use the existing
  values.
- Don't mark or record drafts; don't run any git in the drafts folder.
- Never write the seen file when its content didn't change (the watcher would re-apply in every window in a loop).

## Changes after review

- The content provider serves a local repository only when it is not listed twice (`!x.duplicateOf`), like a
  managed one (`isManaged`).
- **What changed** counts removed items too: a repository whose only changes are removed items lists them instead of
  saying "Nothing new".
- `refreshUpdates` leaves `s.updates` null when `ls-tree` gives an empty tree, so a failed read never writes an empty
  baseline (which would mark everything `new` at the next read).
- `computeMarks` takes items with their `path` already set (`updates.updateItems`); `noticeEntries`' `enabled` is a
  set of local ids; `noticeMessage` holds the notice decision. The test hook's tree snapshot carries the tooltip.
