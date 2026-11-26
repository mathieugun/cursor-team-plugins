# Plan 16: check before pushing

## Context

- Repository: cursor-team-plugins (Cursor extension, plain CommonJS, no dependency, no build). Request:
  `requests/16-check-before-push.md`. Branch `request/16-check-before-push`. Version 0.8.4 -> **0.8.5**.
- Files and functions involved (lines as of the branch start):
  - `lib/catalog.js`: `readJson` (10), `frontmatterDescription` (49), `readChildren` (209), `describe` (296),
    `readCatalog` (304), `filterMcpJson` (162).
  - `lib/repos.js`: `mergeCatalogs` (267): copies plugins with `...p` and children with `{ ...c, id }`.
  - `lib/treeModel.js`: `buildTree` (25), `buildRepoNode` (240).
  - `lib/sync.js`: `localChanges` (282), `parseStatusZ`.
  - `lib/updates.js`: `serverEntry` (78).
  - `extension.js`: `doApply` (644; `partialCopies = copies` at 721), `PluginTree.getChildren` (1647) and
    `getTreeItem` (1700; icons at 1713-1730), `TREE_ICONS` (1568), `pickToContribute` (3197), `commitAndPushCommand`
    (3224), `pushToBranchCommand` (3270), `makeTestUi` (3366), `testTree` (3484), `testHook` (3520), `activate` (3568).
  - New: `lib/checks.js`, `test/checks.test.js`, `test/live/checks.live.js`.

## Measured facts (don't measure them again)

All on Cursor 3.32.4, 2026-11-26.

1. **Cursor drops an item whose frontmatter gray-matter can't parse, silently.** For an extension-registered plugin
   (`addPlugin`), the agent host's loader (`_loadExtensionPluginContent` -> module 72467 `Y_`) re-reads every skill,
   rule, command and agent with gray-matter (bundled module 70890: gray-matter 4.0.3, js-yaml 3 `safeLoad`) inside
   `try { ... } catch { return null }`: a throw drops the item, no log line. Evidence: the real loader run on probe
   plugins with Cursor's runtime (hypothesis tester, scratch probe). Cases: `description: Use when: the user asks` ->
   dropped; `---` not closed followed by a markdown body -> dropped; `---` not closed with only `key: value` lines ->
   loaded; no frontmatter, empty `---`/`---`, empty file -> loaded, name = folder (file stem), no description;
   `description:` empty, missing, or not a string (`123`, `[a, b]`) -> loaded with no description; folded `>` ->
   loaded with the folded text; BOM, CRLF -> fine.
2. **What each kind needs** (same run):
   - skill: the agent's catalog lists `<agent_skill fullPath=...>description</agent_skill>`: without a description the
     agent sees only a path. Skills of one plugin are de-duplicated by normalised name (frontmatter `name`, else the
     folder; lowercase, spaces -> `-`, characters outside `a-z0-9.-` removed), the first in listing order wins, the
     others vanish. A folder that differs from `name` is never checked by Cursor.
   - rule: broken YAML drops it (also `globs: *.ts` unquoted: `*` starts a YAML alias). No frontmatter or no
     description is harmless with `alwaysApply: true` or `globs`; otherwise the rule is manual only (can be intended:
     not flagged). Rules are de-duplicated by name too (`a.md` and `a.mdc` of one plugin collide).
   - command: frontmatter optional, description optional; broken YAML drops it.
   - agent: frontmatter optional; description used as the subagent's description (`description ?? ""`); broken YAML
     drops it; **an empty body drops it**.
3. **JSON**: `.cursor-plugin/plugin.json` and `.cursor-plugin/marketplace.json` are read with strict `JSON.parse`: a
   comment, a trailing comma or a **BOM** makes Cursor ignore the file (for `plugin.json`: its `displayName` and its
   declared paths are lost). `mcp.json`/`.mcp.json` are read with jsonc-parser: comments and trailing commas are fine
   (even a truncated file still yielded its servers). Our catalog strips a BOM from all three and reads `mcp.json`
   strictly (a file with comments shows no servers today).
4. **gray-matter splitting** (read in `node_modules/gray-matter/index.js` of Cursor's install, same code as module
   70890): a BOM is stripped; frontmatter only when the text starts with `---` and the 4th character is not `-`; the
   rest of the first line is a language name (ignored here); the block ends at the first `\n---` (so the first later
   line that **starts with** `---`, even `---   ` or `----`); no such line -> the whole rest is the block and the
   content is empty; a block that is empty once comment lines (`^\s*#...`) are removed is not parsed (data `{}`).
5. **Calibration of the checker** (`lintFrontmatter` below) against Cursor's gray-matter on 86 frontmatter texts
   (scratch script `cmp.js`, run with `ELECTRON_RUN_AS_NODE=1 Cursor.exe`): 0 false positives, 1 known miss (a
   plain value with a ` #` comment followed by an indented `b: c` line). js-yaml 3 accepts tabs in indentation (so
   tabs are not flagged) and reads `description: 2024-01-01` as a date, `12`/`12:30` as numbers.
6. **The agent reads extension diagnostics of files outside the workspace (code reading, to confirm by hand).** The
   `ReadLints` tool (`paths?: string[]`, "relative paths in the workspace or absolute paths") runs the workbench's
   `VscodeDiagnosticsExecutor`: an absolute path goes to `URI.file` as is; it reads `markerService.read({ resource })`
   with no owner and no workspace filter (only `.cursorignore`/admin blocks); the file must exist on disk. Only
   ERROR and WARNING severities are returned. An extension `DiagnosticCollection` reaches the same marker service
   (owner = collection name). For a file open in an editor, markers older than the document version are dropped after
   a wait of up to 6 s: diagnostics must be set again after each change (we do it at every apply). Nothing attaches
   lints to an edit result: the system prompt tells the agent "After substantive edits, use the ReadLints tool to
   check recently edited files". Without `paths`, ReadLints returns nothing.
7. From the project notes, not checked again: Cursor watches registered folders; partial copies sync both ways through
   `syncCopy`; every dialog goes through `ui` (Test mode records it, `hook.respond` answers it); a tree item opened
   from a command uses `preserveFocus: true`; on Windows git has no global identity on the maintainer's machine (a hand
   commit needs an identity in the managed clone's `.git/config`, with the user's OK).

## Design

### Problems

A problem is `{ file, line, severity, message }`: `file` absolute path (or `''` when none), `line` 1-based (`0` when
none), `severity` `'error'` (Cursor drops or ignores something) or `'warning'` (loaded but degraded), `message` the
text users see (one sentence, no trailing period). Every check below is "by value": all of them stop a push.

### New module `lib/checks.js` (pure, no `vscode`)

Exports: `splitFrontmatter`, `lintFrontmatter`, `checkItemText`, `conflictMarkerLine`, `parseJsonc`, `checkJsonText`,
`skillKey`, `pushProblems`, `KIND_WORDS`.

1. `splitFrontmatter(text)` and `lintFrontmatter(lines)`: copy the reference code of the appendix as is (it is the
   calibrated version; keep its messages word for word), with these two changes: `checkNested`'s `let body` becomes
   `const body`; the record stored in `keys` is `{ kind, line: i, value }` where `value` is `stripComment(v)` for a
   plain value and `''` otherwise (drop `col` and `end`). Results: `{ error: { line, detail } }` (`line` 0-based in the
   block), `{ keys }`, `{ notMapping: true }`, `{ empty: true }`, `{ unknown: true }`.
2. `KIND_WORDS = { skill: 'skill', rule: 'rule', command: 'command', agent: 'agent' }`.
3. `conflictMarkerLine(text)`: the 1-based line of the first line matching `/^<{7}(?: |$)/` when a later line matches
   `/^>{7}(?: |$)/`; else 0. (`=======` alone is a markdown heading underline: never enough.)
4. `checkItemText(kind, text, file, frontmatterField)` -> problems of one skill, rule, command or agent file, in this
   order (all that apply; a frontmatter error stops the description and body checks). `frontmatterField(text, key)`
   is passed in by the caller (`lib/catalog.js` passes its own) because `checks.js` must not require `catalog.js`:
   - Conflict markers: `conflictMarkerLine(text)` > 0 -> error at that line:
     `Conflict markers (<<<<<<< ... >>>>>>>) are left from a merge`.
   - `splitFrontmatter(text)`; with a frontmatter, `r = lintFrontmatter(fm.lines)`:
     - `r.error` and `fm.closed`: error at line `r.error.line + 2`:
       `Frontmatter is not valid YAML, so Cursor drops this <kind>: <detail>`.
     - `r.error` and not `fm.closed`: error at line 1:
       `The frontmatter has no closing "---" line, so Cursor reads the whole file as frontmatter and drops this <kind>`.
   - Only `skill` and `agent`, when there was no frontmatter error: the description is missing when there is no
     frontmatter, or `r` is `empty`/`notMapping`, or `r.keys` has no `description`, or its `kind` is not `plain`,
     `quoted` or `block`, or (kind `plain` and `TYPED.test(value)`), or
     `frontmatterField(text, 'description').trim() === ''`. `r.unknown` -> no description check. Missing -> warning at
     the line of the `description` key + 2 when the key exists, else line 1:
     `No description: the agent can't tell when to use this <kind>`.
     `TYPED` (values js-yaml 3 does not read as a string):
     ```
     /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0o?[0-7_]+|(?:0|[1-9][0-9_]*)(?::[0-5]?[0-9])*|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|\.(?:inf|Inf|INF))|\.(?:nan|NaN|NAN)|\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)?)$/
     ```
   - Only `agent`, when there was no frontmatter error: `body.trim() === ''` (the body of `splitFrontmatter`; an
     unclosed frontmatter has an empty body) -> error at line 1:
     `No instructions after the frontmatter, so Cursor drops this agent`.
   - Every problem gets `file`.
5. `parseJsonc(text)`: strips a BOM, then blanks out `//` line comments, `/* */` block comments and a comma followed
   only by whitespace or comments before `]` or `}`, all outside strings (a string starts at `"` and ends at the next
   unescaped `"`), replacing each removed character by a space (newlines kept) so positions stay; then `JSON.parse`.
   Throws what `JSON.parse` throws.
6. `checkJsonText(text, file, { what, jsonc })` -> `[]` or one error problem. `what` is the sentence end that says what
   Cursor loses (given by the caller, below).
   - Not `jsonc` and `text.charCodeAt(0) === 0xfeff`: error at line 1:
     `<name> starts with a byte order mark (BOM), so Cursor ignores it<what>: save it as UTF-8 without BOM`.
   - Parse (`JSON.parse` for strict, `parseJsonc` for jsonc; strict parses the text as is, BOM included, only after the
     BOM test above) fails: error at the line of the position when the message holds `position <n>` (count the `\n`
     in `text.slice(0, n)` + 1), else line 1: `<name> is not valid JSON, so Cursor ignores it<what>: <err.message>`
     for strict, `<name> is not valid JSON, so Cursor may not load its MCP servers: <err.message>` for jsonc
     (`what` unused).
   - `<name>` is `path.basename(file)`.
7. `skillKey(name)`: `String(name).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.-]/g, '')`.
8. `pushProblems({ catalog, repoDir, changed, readFile })` -> sorted problems a push must stop on:
   - `catalog`: a raw `readCatalog` result of that repository; `changed`: repo-relative POSIX paths (see
     `sync.changedPaths`); `readFile(abs)` -> text or `null` (injected for tests; the extension passes a reader that
     returns `null` for a missing file, a directory, a file over 1 MB or one with a NUL byte in its first 8000 bytes).
   - All `catalog.problems` (repository level), always.
   - Each plugin whose folder contains a changed path (`rel(plugin.dir)` = repo-relative POSIX folder; changed path `p`
     with `p === dir || p.startsWith(dir + '/')`; a plugin at the repository root, dir `''`, contains everything):
     its `problems` and each child's `problems`.
   - Each changed path not already covered by a problem's file: `readFile(path.join(repoDir, p))`; when text and
     `conflictMarkerLine(text)` > 0: the conflict-marker error of `checkItemText` for that file.
   - De-duplicated by `file|line|message`, sorted by file, then line.

### Catalog (`lib/catalog.js`)

- `frontmatterDescription(text)` becomes `frontmatterField(text, key)` (same code, the regex built from `key`, which
  is a plain word: escape nothing else); `frontmatterDescription = (text) => frontmatterField(text, 'description')`
  stays exported (callers unchanged). Export `frontmatterField` too.
- `readChildren`: each skill, rule, command and agent file is read **once** (`readText(file)`: text or `''` on error);
  `description = frontmatterField(text, 'description')` (as `describe` did; remove `describe`), and
  `problems = checks.checkItemText(kind, text, file, frontmatterField)`; the child gets `problems` only when non-empty.
- Duplicate names, after the children are listed: for skills, key = `skillKey(frontmatterField(text, 'name') ||
  folder)`; for rules, key = `skillKey(frontmatterField(text, 'name') || stem)` (stem = file name without `.mdc`/`.md`).
  The first in our order (the existing sorted order) keeps; each later one with an equal key gets an error at line 1:
  `Same name as <first's name for display: folder for a skill, file name for a rule> ("<key>"), so Cursor loads only one of them`.
  Skills and rules are compared within their own kind only.
- MCP files: read with `checks.parseJsonc` instead of `readJson`. On failure the warning stays (same text) and the
  plugin gets `checkJsonText(text, file, { jsonc: true })`'s problem: `readChildren` returns
  `{ children, mcpFiles, warnings, problems }` and `readCatalog` puts these `problems` on the plugin, with the
  `plugin.json` ones first.
- `plugin.json`: read the text; `checkJsonText(text, manifestFile, { what: ' (its name, display name and declared
  folders)' })`; any problem goes to the plugin's `problems` (the plugin object is built later: collect them in a local
  array). The manifest is still read as today (BOM stripped) so the view keeps working; the warning text is unchanged.
- `marketplace.json`: `checkJsonText(text, marketplaceFile, { what: ' (the plugin list and the repository name)' })`
  goes to the catalog's `problems`. The existing parse (BOM stripped) is unchanged.
- Catalog-level `problems` (new field of the result, always an array): besides the JSON problem, each existing
  warning that is not about one loaded plugin becomes a problem too, with the same text: `repository folder not
  found` (file `''`, line 0, error), `marketplace.json: "renamed" is not an object` (marketplace file, line 0,
  warning), `marketplace.json: "plugins" is not an array` (marketplace file, line 0, error), the three `plugin "<label>":
  ...` source warnings (marketplace file, line 0, error), `duplicate plugin name ...: skipped` (that plugin's
  `plugin.json` when it exists, else its folder, line 0, error). The parse-failure warning of `marketplace.json` is
  already covered by the JSON problem: don't add it twice. `warnings` keep their current texts (they are logged).
- `filterMcpJson`: parse with `checks.parseJsonc` (a file with comments is filtered; its comments are lost in the
  generated copy, which is written with `JSON.stringify` as today).
- `require('./checks')` at the top of `catalog.js`; `checks.js` never requires `catalog.js`.

### Other readers

- `lib/updates.js` `serverEntry`: parse with `checks.parseJsonc` (an MCP server of a file with comments gets a
  fingerprint and a diff like the others).
- `lib/authoring.js` and `lib/rename.js` keep strict JSON for the MCP files they rewrite (see Not handled).

### Changed paths (`lib/sync.js`)

`changedPaths({ run, repo })` -> repo-relative POSIX paths of what a push would carry: `localChanges` files (each
`path`, and `from` for a rename), plus, when `ahead > 0`, `git -c core.quotePath=false diff --name-only -z @{u}...HEAD`
(`{ trim: false }`, split on `\0`, empty entries dropped). A failing diff adds nothing. De-duplicated, sorted. Throws
like `localChanges` when `git status` fails.

### Before pushing (`extension.js`)

New `async function confirmChecks(d)` -> `true` to go on:

```
const changed = await sync.changedPaths({ run: makeGit(gitPath()), repo: d.dir })   // on throw: log it, return true
const problems = checks.pushProblems({ catalog: readCatalog(d.dir), repoDir: d.dir, changed, readFile: readSmallText })
if (problems.length === 0) return true
log(`check before pushing ${labelOf(d)}: ${problems.length} problem(s)`) and one log line per problem
```

Modal warning: `ui.showWarningMessage(text, { modal: true, detail }, 'Push anyway', 'Open files')` with
- `text`: `<n> problem(s) in your changes to <labelOf(d)>: Cursor drops or misreads these files, for you and for every teammate who gets them.`
- `detail`: one line per problem, the first 10: `<repo-relative POSIX path>[:<line>]: <message>` (the path is
  `(repository)` when `file` is `''`; `:<line>` only when `line > 0`), then `and <k> more` when there are more.
- `Push anyway` -> `true`. `Open files` -> open each distinct `file` of the problems (first 10, existing files only)
  with `vscode.window.showTextDocument(uri, { preview: false })`, the cursor on the problem's line, then `false`.
  Anything else (Escape) -> `false`.

Called in `commitAndPushCommand` right after `pickToContribute` returns `d` (before the message or the "Push N unpushed
commits" prompt), and in `pushToBranchCommand` right after `pickToContribute` (before the branch name). `false` ->
return without anything else. `readSmallText(abs)`: `null` unless `fs.statSync(abs).isFile()`, size <= 1 MB and no
`\0` in the first 8000 characters; else the UTF-8 text.

### View (`lib/treeModel.js`, `extension.js`)

- `buildTree`: item node gets `problems: c.problems || []`; plugin node gets `problems: plugin.problems || []` and
  `itemProblems` (sum of its children's problem counts). `problem` on both nodes: `'error'` if any of their own
  problems (for a plugin: own and children's) is an error, else `'warning'` if any, else `null`.
  - Item description: `<kind label>[ · <mark>]` then ` · problem` (one) or ` · <n> problems`.
  - Plugin description: the existing parts, then `<n> problem(s)` as a part (`1 problem`, `2 problems`), n = own +
    items'.
  - Tooltip: one line per own problem, appended after the existing lines: `Problem (line <n>): <message>` (`Problem:
    <message>` when `line` is 0); for a plugin also `<k> item(s) with problems` when `k > 0`.
- `buildRepoNode(desc, state, children, counts, problems)`: new optional last argument (repository-level problems):
  description gets ` · 1 problem` / ` · <n> problems` after the existing text; tooltip gets the same `Problem...` lines before
  `State:`. The icon is unchanged (it shows the sync state).
- `getTreeItem`: a node with `problem` (plugin or item) gets `new vscode.ThemeIcon(node.problem === 'error' ? 'error' :
  'warning', new vscode.ThemeColor(node.problem === 'error' ? 'list.errorForeground' : 'list.warningForeground'))`
  instead of its kind icon or the partial `pie-chart`.
- `getChildren`: passes `(catalogs.get(d.key) || {}).problems` to `buildRepoNode` (only when the repository is active,
  like its plugins).
- The `catalog warning:` log lines stay as they are.

### Diagnostics (`extension.js`)

- `activate`: `diagnostics = vscode.languages.createDiagnosticCollection('Team plugins')`, pushed to
  `context.subscriptions` (module-level `let diagnostics = null`).
- `updateDiagnostics()` at the end of `doApply`, right after `partialCopies = copies` and `updateConflicts()`:
  - Collect every problem with a `file` from every catalog in `catalogs` (repository, plugin and item problems).
  - For each, a `vscode.Diagnostic(new vscode.Range(line - 1, 0, line - 1, 10000), message, severity)` (`line` 0 ->
    line 1; `severity` Error or Warning), `source = 'Team plugins'`, grouped by file.
  - Mirror: for each entry of `partialCopies` (`{ plugin, copyRoot }`), each grouped file inside `plugin.dir`
    (`path.relative` not starting with `..`) whose mirror `path.join(copyRoot, rel)` exists gets the same diagnostics.
  - Replace the whole collection only when the content changed (compare a JSON of `[file, line, severity, message]`
    sorted): `diagnostics.clear()` then `diagnostics.set([...map].map(([f, list]) => [vscode.Uri.file(f), list]))`.
    Keep the last JSON in a module variable. Compare content only: an unchanged set keeps its markers.
- `testHook`: add `diagnostics: () => Object.fromEntries` of the collection: `{ [fsPath]: [{ line (1-based),
  severity: 'error' | 'warning', message }] }` (iterate `diagnostics.forEach`).

### Output wording, in one place

| Where | Text |
| --- | --- |
| item, conflict | `Conflict markers (<<<<<<< ... >>>>>>>) are left from a merge` |
| item, YAML | `Frontmatter is not valid YAML, so Cursor drops this <kind>: <detail>` |
| item, unclosed | `The frontmatter has no closing "---" line, so Cursor reads the whole file as frontmatter and drops this <kind>` |
| skill/agent | `No description: the agent can't tell when to use this <kind>` |
| agent | `No instructions after the frontmatter, so Cursor drops this agent` |
| duplicate | `Same name as <other> ("<key>"), so Cursor loads only one of them` |
| plugin.json | `plugin.json is not valid JSON, so Cursor ignores it (its name, display name and declared folders): <err>` / BOM form |
| marketplace.json | `marketplace.json is not valid JSON, so Cursor ignores it (the plugin list and the repository name): <err>` / BOM form |
| mcp file | `mcp.json is not valid JSON, so Cursor may not load its MCP servers: <err>` |
| push modal | see "Before pushing" |

## Impact

- `readCatalog` callers (find them with `grep -n "readCatalog(" lib extension.js`): the new `problems` fields are
  additive and `warnings` keep their texts, so callers need no change. Tests that `deepEqual` a whole catalog, plugin
  or child (`catalog.test.js`, others) get the new fields added (`problems: []` on the catalog; plugin and child
  `problems` exist only when non-empty, so fixtures without problems are unchanged there).
- `mergeCatalogs`: plugins and children keep `problems` through the spreads; nothing to change. Its `warnings` are
  unchanged.
- `materialize.syncCopy` (via `filterMcpJson`): a JSONC `mcp.json` with servers left out is now filtered (before:
  copied unchanged). Selection: servers of a JSONC file become selectable (before: the file always came with the
  plugin) - say so in the docs.
- `updates.serverEntry`: JSONC files now give server fingerprints. The servers of an MCP file with comments, which
  had no items before, show as `new` once after the upgrade (`computeMarks` marks an item without a record). Accepted
  (rare); no doc change.
- `treeModel.buildTree` node objects get new fields `problems`, `itemProblems`, `problem`: `treeModel.test.js`
  `deepEqual`s of whole nodes must add them (`problems: []`, `problem: null`, and `itemProblems: 0` on plugins).
- `buildRepoNode` new argument: one caller (`getChildren`).
- `testTree` (live hook) already reports the icon id: `'warning'`/`'error'` shows there.
- `commitAndPushCommand`/`pushToBranchCommand`: one extra modal when problems exist; the conflict path's "Push to a
  branch" button goes through `pushToBranchCommand` and checks again (intended).
- Existing live scenario `contribute.live.js`: the fixture has no problem, so no modal: unchanged.

## Not handled

- YAML errors the checker doesn't know (it flags only the forms of the appendix; e.g. a plain value with a ` #`
  comment then an indented `key: value` line, errors inside nested maps beyond a plain `key: value` with `: `).
  docs/development.md (Known limits).
- A rule without description that is neither `alwaysApply` nor glob-attached (manual only: can be intended); a
  command without description. Not flagged.
- A skill folder that differs from its `name`; relative links to missing files. Not checked (README: no mention needed;
  docs/development.md Known limits: one line).
- Hooks, scripts and other assets: only conflict markers, and only in changed files at push time.
- `lib/authoring.js` (Add MCP server) and `lib/rename.js` still parse MCP files strictly: on a file with comments they
  fail as before (rewriting would drop the comments). docs/development.md.
- Remote-SSH: diagnostics and `ReadLints` not probed there. docs/development.md.
- Problems of a repository that is not loaded (listed twice, hidden by name) are not shown or published.

## Tests

`node scripts/test.js` lists every `test/*.test.js` by itself: a new file needs no registration.

### `test/checks.test.js` (new)

`lintFrontmatter(lines)` through `splitFrontmatter`: for each case below, the text is
`---\n<frontmatter>\n---\nBody text.\n` unless written in full; expected `error` (with the detail where given) or not.
Verdicts are gray-matter's (Cursor 3.32.4):

| frontmatter | expected |
| --- | --- |
| `name: x\ndescription: Use when: the user asks` | error line 1, detail `the value of "description" contains ": " or ends with ":": put the value in quotes` |
| `description: see http://x.y/z and a:b` | ok |
| `description: fix #12 now` | ok |
| `description: *important* thing` | error, detail starts `the value of "description" starts with "*"` |
| `description: &x thing` | ok |
| `description: @user thing` | error |
| ``description: `code` thing`` | error |
| `description: [WIP] does x` | error, detail `text after the closing ] in the value of "description": put the whole value in quotes` |
| `description: {x} does x` | error |
| `description: "a" b` | error |
| `description: "abc` | error, detail `the quote that opens the value of "description" is never closed` |
| `description: 'it''s ok'` | ok |
| `description: 'it's bad'` | error |
| `metadata:\n\tkey: v` | ok (tabs are not flagged) |
| `description: a\ndescription: b` | error line 1, detail `"description" appears twice` |
| `description: |\nabc` | error line 1, detail starts `this line is not a "key: value" line` |
| `description: - x` | error |
| `description: %x` | error |
| `description: !x thing` | error |
| `description: ? x` | ok |
| `globs: *.py` | error, detail starts `the value of "globs" starts with "*"` |
| `globs: src/**, test/**` | ok |
| `description: a\n  b: c\nname: x` | error line 1 |
| `metadata:\n  a: 1\n  b: x: y` | error line 2, detail mentions `"b"` |
| `metadata:\n  notes: |\n    Use when: x\n  b: 1` | ok |
| `items:\n  - a: b\n  - c: d` | ok |
| `tools: [a, b\nname: x` | error, detail `the [ that opens the value of "tools" is never closed` |
| `tools: [a,\n  b]\nname: x` | ok |
| `description: ends with colon:` | error |
| `description: : x` | error |
| `name: x\n  description: y` | error line 1 |
| `  name: x\n  description: y` | ok |
| `just text` | `notMapping` |
| `just text: and more\nsecond line` | error line 1 |
| `tools:\n- a\n- b\nname: x` | ok |
| `description: >\n  a\n  b\nname: x` | ok |
| `description: >\n  a\n b\nname: x` | error line 2 |
| `description: "line one\n  line two"` | ok |
| `description: "a\nname: b` | error |
| `a: &x 1\nb: *x` | ok |
| `b: *x\na: &x 1` | error |
| `"a: b": c` | ok |
| `"a": 1\na: 2` | error |
| `description: it's fine` | ok |
| `description: say "hi" now` | ok |
| `description: "a" # c` | ok |
| `tools: [a, b] # c` | ok |
| `a: {b: c} d` | error |
| `? a\n: b` | `unknown` |
| `description: a | b > c` | ok |
| `description: 100% sure` | ok |
| `description: C# helper` | ok |
| `homepage: https://x.y/z` | ok |
| `argument-hint: [file] [mode]` (with a `description: y` line before) | error line 1, detail `text after the closing ] in the value of "argument-hint": put the whole value in quotes` |
| `allowed-tools: Bash(git status:*), Read` | ok |
| `description:\nname: x` | ok |
| `description: |\nname: x` | ok |
| `# just a comment` | `empty` |
| (full text) `---\n---\nbody` | `empty` |

`splitFrontmatter`:
- `'\ufeff---\na: 1\n---\nx'` -> closed, lines `['a: 1']`, body `'x'`.
- `'---\r\na: 1\r\n---\r\nx'` -> closed, lines `['a: 1']`.
- `'----\nname: a\n----\nx'` -> no frontmatter.
- `'---\nname: a\n---   \nbody'` -> closed, body `'body'`.
- `'---\nname: x\ndescription: y\n'` -> not closed, body `''`.
- `'# Title\n'` -> no frontmatter, body `'# Title\n'`.

`checkItemText(kind, text, '/r/f.md', frontmatterField)` (with `frontmatterField` from `lib/catalog.js`):
- skill, `---\nname: a\ndescription: Use when: x\n---\nBody` -> one error, line 3, message
  `Frontmatter is not valid YAML, so Cursor drops this skill: the value of "description" contains ": " or ends with ":": put the value in quotes`, file `/r/f.md`.
- rule, `---\nglobs: *.ts\n---\nBody` -> one error, line 2.
- command, `---\ndescription: y\nargument-hint: [file] [mode]\n---\nBody` -> one error, line 3.
- skill, `---\nname: a\ndescription: y\n\n# Title\n\nSome text.\n` (unclosed) -> one error, line 1, the unclosed text.
- skill, `---\nname: a\ndescription: y\n` (unclosed, keys only) -> no problem.
- skill, `# Just a body\n` -> one warning, line 1, `No description: the agent can't tell when to use this skill`.
- skill, `---\nname: a\ndescription:\n---\nBody` -> warning, line 3.
- skill, `---\nname: a\ndescription: ""\n---\nBody` -> warning.
- skill, `---\nname: a\ndescription: 12\n---\nBody` -> warning; same for `2024-01-01`, `true`, `null`, `[a, b]`.
- skill, `---\nname: a\ndescription: yes\n---\nBody` -> no problem (`yes` is a string in js-yaml 3).
- skill, folded fixture text (`docs/skills/write-readme/SKILL.md`) -> no problem.
- rule, `# Just a body\n` -> no problem; command, `Do it.\n` -> no problem.
- agent, `---\nname: r\ndescription: Reviews.\n---\n\n` -> one error, `No instructions after the frontmatter, so Cursor drops this agent`.
- agent, `---\nname: r\n---\nReview it.\n` -> one warning (no description).
- any kind with `<<<<<<< HEAD\na\n=======\nb\n>>>>>>> x\n` in the body -> a conflict error at that line (plus whatever
  else applies).

`conflictMarkerLine`: `'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> branch\n'` -> 2; `'Title\n=======\n'` -> 0;
`'<<<<<<< HEAD\nno end\n'` -> 0; `'<<<<<<<\nx\n>>>>>>>\n'` -> 1.

`parseJsonc`: `'{ // c\n "a": [1, 2,], /* d */ "b": {"c": 1,}, }'` -> `{ a: [1, 2], b: { c: 1 } }`;
`'{"u": "http://x//y", "s": "a,}"}'` -> unchanged strings; `'\ufeff{"a":1}'` -> `{ a: 1 }`; `"{'a': 1}"` throws.

`checkJsonText`:
- strict, `'\ufeff{"name":"x"}'`, file `/r/.cursor-plugin/plugin.json`, what ` (w)` -> error line 1,
  `plugin.json starts with a byte order mark (BOM), so Cursor ignores it (w): save it as UTF-8 without BOM`.
- strict, `'{\n  "name": "x",\n}'` -> error, message starts `plugin.json is not valid JSON, so Cursor ignores it (w): `,
  line 3 when the runtime's message has `position` (assert `line >= 1`; assert 3 only if `/position \d+/` matches).
- strict, `'{"name": "x"} // c'` -> error.
- jsonc, `'{ // c\n "mcpServers": {"a": {"url": "u"},}, }'` -> `[]`.
- jsonc, `"{'mcpServers': {}}"`, file `/r/p/mcp.json` -> error, message starts
  `mcp.json is not valid JSON, so Cursor may not load its MCP servers: `.

`pushProblems` (build a catalog with `readCatalog` on a temp repository made with `helpers.js` fixtures, or a literal
object with `plugins: [{ dir, problems, children: [{ problems }] }]` and `problems`):
- a changed path in plugin `review` -> review's own and children's problems, not `docs`'s.
- repository-level problems are always included, even with only a `docs` change.
- a changed `scripts/x.sh` (outside any plugin) whose `readFile` text has conflict markers -> one conflict error for it.
- a changed item file that already has a conflict problem from the catalog -> reported once.
- `readFile` returning `null` -> nothing for that path.
- sorted by file then line.

### `test/catalog.test.js`

- A skill with broken YAML: listed as today (the view still shows it), with `problems` of one error; its description
  as `frontmatterField` reads it.
- Two skills `a-first` and `b-second` both with `name: dup` -> `b-second` gets the duplicate error naming `a-first`,
  `a-first` has none. A skill folder `dup` without `name` next to `a-first` (`name: dup`): `dup` gets the error
  (sorted order: `a-first`, `dup`).
- Rules `a.md` and `a.mdc` -> `a.mdc` (second in sorted order) gets the duplicate error.
- `mcp.json` with `//` comments and a trailing comma -> its servers are children (kind `mcp`), no warning, no problem.
- `mcp.json` with `{'a': 1}` -> warning as today, plugin `problems` has the mcp error.
- `plugin.json` starting with a BOM -> plugin `problems` has the BOM error; `displayName` still read (unchanged
  behaviour).
- `marketplace.json` with a trailing comma -> `problems` has the marketplace JSON error (line > 0 or 1), `warnings`
  still has the parse warning, plugins found by the folder scan as today.
- `marketplace.json` naming a missing folder -> `problems` has `plugin "x": folder not found: ...` (error, line 0).
- The fixture repository (`test/fixtures/team-repo`) -> no problem anywhere (`problems` empty, no child `problems`).
- `filterMcpJson` of a JSONC text with servers `a`, `b`, removing `a` -> JSON with only `b`.

### `test/treeModel.test.js`

- Item with one error problem -> `problem: 'error'`, description ends ` · problem`, tooltip has `Problem (line 3): ...`.
- Item with two warnings -> ` · 2 problems`, `problem: 'warning'`.
- Plugin with one own warning and one item error -> description part `2 problems`, `problem: 'error'`, tooltip has the
  own `Problem...` line and `1 item(s) with problems`.
- `buildRepoNode` with one problem -> description ends ` · 1 problem`; with two -> ` · 2 problems`; tooltip has the
  `Problem...` lines just before the `State:` line.
- Update the existing whole-node expectations for the new fields.

### `test/sync.test.js`

- `changedPaths`: an uncommitted edit, an untracked file, a rename (both paths), and a committed-but-unpushed file ->
  all listed once, sorted. No upstream -> only the status paths.

### `test/updates.test.js`

- `serverEntry` of a JSONC text returns the entry.

### `test/live/checks.live.js` (new scenario)

Setup like `contribute.live.js` (`team.git`, `teamPlugins.enabled: ['team-test:review']`), timeout 120 s. Steps:
1. Wait for review registered; `t.idle()`; the clone is `path.dirname(registered)`.
2. Rewrite `review/skills/code-review/SKILL.md` with `description: Use when: reviewing a change` (unquoted). Wait for
   node `item:team-test:review/skills/code-review` with icon `error` and description ending ` · problem`; plugin node
   `plugin:team-test:review` description contains `1 problem`.
3. `hook.diagnostics()` has the SKILL.md path with one `error` at line 3 whose message starts
   `Frontmatter is not valid YAML, so Cursor drops this skill`.
4. Commit and push, answering the modal with `undefined` (cancel): the recorded `showWarningMessage` is modal, its
   message starts `1 problem(s) in your changes to`, buttons `['Push anyway', 'Open files']`, detail contains
   `review/skills/code-review/SKILL.md:3: `; no commit-message input box was shown; the bare's `main` log is unchanged.
5. Commit and push again, answering `Push anyway` and the commit message: wait for `Pushed ... to main`.
6. Partial copy: untick `item:team-test:review/skills/security-check` (`hook.check`); wait for the registration of
   review to move under `filtered`; `hook.diagnostics()` then also has the copy's `skills/code-review/SKILL.md` path
   (under the registered folder) with the same message.
7. Fix the file in the clone (quote the value); wait for the item icon to be `sparkle` again and `hook.diagnostics()`
   to be empty.

## Keep in step

- `package.json`: `version` 0.8.5. No new setting or command.
- `README.md`:
  - "Improving a team skill": after the Commit and push / Push to a branch bullets, a paragraph: before pushing, the
    extension checks the plugins you changed for what Cursor silently drops or misreads (frontmatter that isn't valid
    YAML, a skill or agent without a description, an agent with no instructions, two skills with one name, JSON that
    doesn't parse in `marketplace.json`, `plugin.json` or `mcp.json`, conflict markers) and stops with the list;
    **Push anyway** pushes regardless, **Open files** opens them. The same problems show in the view (an error or
    warning icon, `· problem` on the row, the message in the tooltip) and in the Problems panel, where the agent sees
    them too after its edits. Give the most common fix in one line: put a value with `: ` (or starting with `*`, `[`,
    `@`...) in quotes, e.g. `globs: "*.ts"`.
  - "Troubleshooting": one bullet: a skill, rule, command or agent missing in Cursor -> look at its row in the view
    (an error icon says why Cursor drops it).
- `docs/development.md`:
  - "How it works": a short section **Checks** (where problems come from: `lib/checks.js`, computed in `readCatalog`
    per file read; `pushProblems` at push; diagnostics refreshed at every apply and mirrored on partial copies; why our
    own YAML checker: calibrated against Cursor's gray-matter 4.0.3 / js-yaml 3 on 86 texts, no false positive, the
    measured facts 1-6 condensed with their sources and date).
  - "Known limits (details)": replace the line "An `mcp.json` or `.mcp.json` that is not valid JSON gives a catalog
    warning; its servers are not selectable and the file always comes with the plugin." by: an MCP file is read as
    JSONC like Cursor (comments, trailing commas); one that doesn't parse even so gives a warning and a problem, its
    servers are not selectable and the file always comes with the plugin; a partial copy of a JSONC file loses its
    comments (generated). Add the Not handled items (YAML forms not checked, authoring/rename strict on MCP files,
    Remote-SSH diagnostics not probed, folder/name and links not checked).
- `AGENTS.md`:
  - Layout: add `checks` to the `lib/` list (`splitFrontmatter`, `lintFrontmatter`, `checkItemText`,
    `conflictMarkerLine`, `parseJsonc`, `checkJsonText`, `skillKey`, `pushProblems`: problems Cursor would drop or
    misread), `catalog` now also has `frontmatterField` and `problems` on catalog, plugins and items; `sync` has
    `changedPaths`.
  - "Why the code is shaped this way": three bullets: (1) Cursor drops a skill, rule, command or agent whose
    frontmatter gray-matter can't parse, silently, and keeps one with no frontmatter or description; our checker is
    calibrated against gray-matter 4.0.3 / js-yaml 3 (tabs not flagged, `yes` is a string) and must never flag valid
    YAML; (2) `plugin.json` and `marketplace.json` are strict JSON in Cursor (a BOM makes it ignore them), `mcp.json`
    is JSONC; (3) the agent's `ReadLints` reads extension diagnostics of any file by absolute path (only errors and
    warnings, stale markers dropped for open documents): diagnostics are set again at every apply and mirrored on the
    partial-copy file, which is the path the agent edits.
- `test/live/` scenario as above.

## Commands

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js checks contribute
```

(The live scenarios are run by the main session, not the implementer, unless it is asked to.)

## Hand checks

For a reader who hasn't seen this conversation. What the automated scenario can't show: the look of the rows, the
Problems panel, and whether Cursor's agent reads our diagnostics (`ReadLints`) and fixes its own mistake.

Setup (main session or hand-check session, from the repository root):
1. `python scripts/live_check.py settings backup <scratch>/settings-backup` (refuses to overwrite an earlier backup).
2. `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/make-test-repo.js <scratch>/team-plugins.git`;
   set `teamPlugins.repositories` to `[ "<printed path>" ]` and `teamPlugins.enabled` to `["team-test:review"]` in the
   user's settings (with the user's OK).
3. `python scripts/live_check.py install` (with the user's OK), then the user reloads the window (`Developer: Reload
   Window`). `python scripts/live_check.py status --since install` shows 0.8.5 installed, files matching the working
   tree, `review` registered.
4. With the user's OK, set an identity in the managed clone only: `git -C <clone> config user.name "Hand Check"` and
   `git -C <clone> config user.email hand@example.com` (the clone path is in the repository row's tooltip, `Folder:`).

Steps:
1. **Clean repository.** The user opens the Team plugins view. They should see no error or warning icon on `review`,
   `docs` or their items. Check: `status` shows no `catalog warning` line.
2. **Agent breaks a skill.** The user asks Cursor's agent (Agent mode, any model): `In the team skill at <clone>/review/skills/code-review/SKILL.md, change the description to: Use when: reviewing a diff before a commit` (no quotes, no mention of lints).
   They should see: the `code-review` row turn to a red error icon with `skill · problem`, the tooltip saying
   `Problem (line 3): Frontmatter is not valid YAML, so Cursor drops this skill: ...`; `review` showing `1 problem`;
   the Problems panel (`Ctrl+Shift+M`) listing the SKILL.md error under source `Team plugins`. Observe (not pass/fail):
   whether the agent calls ReadLints by itself and quotes the value. Check: `status --grep "catalog|check"`.
3. **Agent reads the diagnostic.** If the agent did not fix it on its own, the user asks: `Call ReadLints with paths ["<clone>/review/skills/code-review/SKILL.md"] and quote the result.` They should see the result
   list the `Frontmatter is not valid YAML` error. This settles measured fact 6. Then the user restores the broken
   value by hand if the agent fixed it (step 4 needs the problem).
4. **Push stops.** The user clicks **Commit and push** on the repository row. They should see a modal: `1 problem(s) in
   your changes to team-test: ...`, the detail line `review/skills/code-review/SKILL.md:3: Frontmatter is not valid
   YAML, ...`, buttons **Push anyway** and **Open files**. The user clicks **Open files**: the SKILL.md opens with the
   cursor on line 3, nothing is pushed (`git --git-dir <scratch>/team-plugins.git log -1 --format=%s main` unchanged).
5. **Partial copy.** The user unticks `security-check`. Then they ask the agent to edit `code-review` again (same
   prompt as step 2 but with a different text, e.g. `Use when: checking a change`). Check with `status` which path
   was registered (`filtered/...`). They should see the Problems panel list the error on the copy's path too (two
   entries, one per path). Observe whether the agent's ReadLints on the copy path returns it.
6. **Fix and push.** The user (or the agent) quotes the value. The icon goes back to the skill icon and the Problems
   panel entries disappear. **Commit and push** then asks for a commit message with no modal and pushes (`Pushed ...
   to main`).

Cleanup:
1. `python scripts/live_check.py settings restore <scratch>/settings-backup`, then the main session runs
   `python scripts/live_check.py settings diff <scratch>/settings-backup`: no difference.
2. Leave the clone identity (it is in the extension's storage clone of the scratch repository, not the user's config).

## Don't

- No commit; no change outside the files listed here without reporting it (the request and plan files are not yours
  to edit).
- No dependency (no js-yaml, no jsonc-parser): the checker is our own code.
- Never install the extension or launch the user's Cursor; don't run `scripts/live-test.js` unless asked.
- Don't change the messages of the appendix's `lintFrontmatter` or the wording table: they are user-visible and
  tested.
- Don't make `checks.js` require `catalog.js` (circular).
- `extension.js` calls split over two lines (`vscode.window` then `.showWarningMessage(` on the next line): search
  them with a multiline pattern.
- Never weaken an existing test's expectation; whole-node `deepEqual`s get the new fields added, nothing removed.

## Changes after review

- `updateDiagnostics`: the comparison key also holds the version of each problem file's open document, so an edit of
  an open file (same problems) sets the collection again; a marker keeps the version it was set with and `ReadLints`
  drops a marker older than the document (measured fact 6). AGENTS.md and docs/development.md say so.
- `changedPaths`: the diff of unpushed commits runs with `--no-renames`, so a committed rename lists both paths like
  an uncommitted one (the push deletes the old path); the `sync.test.js` expectation lists `b.md` again.
- Hand checks (2026-11-26): steps 1, 2, 4, 5, 6 passed (the edits made by the hand-check session, not Cursor's
  agent); step 3 not run (no Cursor usage left), so measured fact 6 stays code reading: README, AGENTS.md and
  docs/development.md say so, and `ideas.md` keeps the check as a follow-up. Hand step 4's button is the view title's
  cloud icon or the Local changes row, not the repository row.

## Appendix: reference code of `splitFrontmatter` and `lintFrontmatter`

Calibrated against Cursor's gray-matter (see measured fact 5). Copy into `lib/checks.js` with the two changes named in
the Design (`const body`; the `keys` record `{ kind, line: i, value }`).

```js
const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s\-?:,[\]{}#&*!|>'"%@`][^\n]*?|-[^\s][^\n]*?)[ \t]*:(?:[ \t]+|$)(.*)$/;

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

function isBlankOrComment(line) {
  return /^[ \t]*(#.*)?$/.test(line);
}

// Cuts a plain scalar's comment: from the first '#' that follows a space or a tab.
function stripComment(text) {
  const m = /[ \t]#/.exec(text);
  return (m ? text.slice(0, m.index) : text).trimEnd();
}

const COLON = (key) => `the value of "${key}" contains ": " or ends with ":": put the value in quotes`;

const hasColonSpace = (t) => /:([ \t]|$)/.test(t);

// Scans a quoted scalar from lines[i] at column col (the opening quote). Returns { endLine, rest } or null (unclosed).
function scanQuoted(lines, i, col) {
  const q = lines[i][col];
  let pos = col + 1;
  for (let l = i; l < lines.length; l++) {
    const s = lines[l];
    for (let c = l === i ? pos : 0; c < s.length; c++) {
      if (q === '"' && s[c] === '\\') {
        c++;
        continue;
      }
      if (s[c] === q) {
        if (q === "'" && s[c + 1] === "'") {
          c++;
          continue;
        }
        return { endLine: l, rest: s.slice(c + 1) };
      }
    }
  }
  return null;
}

// Scans a flow collection ([ or {) from lines[i] at column col. Returns { endLine, rest } or null (unclosed).
function scanFlow(lines, i, col) {
  let depth = 0;
  let quote = null;
  for (let l = i; l < lines.length; l++) {
    const s = lines[l];
    for (let c = l === i ? col : 0; c < s.length; c++) {
      const ch = s[c];
      if (quote) {
        if (quote === '"' && ch === '\\') {
          c++;
        } else if (ch === quote) {
          if (quote === "'" && s[c + 1] === "'") {
            c++;
          } else {
            quote = null;
          }
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#' && (c === 0 || /[ \t]/.test(s[c - 1]))) {
        break; // comment to the end of the line
      } else if (ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          return { endLine: l, rest: s.slice(c + 1) };
        }
      }
    }
  }
  return null;
}

const restOk = (rest) => /^[ \t]*(#.*)?$/.test(rest);

// lines: the frontmatter block (no delimiters, no \r). Returns { error: { line, detail } } (line 0-based in the
// block) | { keys: Map key -> record } | { notMapping: true } | { empty: true } | { unknown: true }
function lintFrontmatter(lines) {
  const content = lines.map((l, i) => i).filter((i) => !isBlankOrComment(lines[i]));
  if (content.length === 0) {
    return { empty: true };
  }
  const first = content[0];
  const base = indentOf(lines[first]);
  if (!KEY_RE.test(lines[first].slice(base)) || /^\?([ \t]|$)/.test(lines[first].slice(base))) {
    return /^\?([ \t]|$)/.test(lines[first].slice(base)) ? { unknown: true } : { notMapping: true };
  }
  const keys = new Map();
  const anchors = new Set();
  const err = (line, detail) => ({ error: { line, detail } });
  let i = first;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind !== base) {
      return err(i, 'bad indentation');
    }
    const body = line.slice(base);
    if (/^\?([ \t]|$)/.test(body)) {
      return { unknown: true };
    }
    const m = KEY_RE.exec(body);
    if (!m) {
      return err(i, 'this line is not a "key: value" line (indent it to continue the value above)');
    }
    let key = m[1];
    if (key[0] === '"' || key[0] === "'") {
      key = key.slice(1, -1);
    }
    if (keys.has(key)) {
      return err(i, `"${key}" appears twice`);
    }
    let v = m[2];
    const valueCol = line.length - v.length;
    let kind = 'plain';
    // anchors and tags before the value
    for (;;) {
      const a = /^&(\S+)[ \t]*/.exec(v);
      if (a) {
        anchors.add(a[1]);
        v = v.slice(a[0].length);
        continue;
      }
      const t = /^!!\S*[ \t]*/.exec(v);
      if (t) {
        v = v.slice(t[0].length);
        continue;
      }
      break;
    }
    const col = line.length - v.length;
    let next = i + 1;
    if (v === '' || v[0] === '#') {
      kind = 'nested';
      // the nested block: deeper lines, or '- ' entries at the base indent
      while (next < lines.length) {
        const l = lines[next];
        if (isBlankOrComment(l)) {
          next++;
          continue;
        }
        const n = indentOf(l);
        if (n > base || (n === base && /^-([ \t]|$)/.test(l.slice(base)))) {
          next++;
          continue;
        }
        break;
      }
      // simple nested 'key: plain' lines with ': ' in the plain value
      const nestedErr = checkNested(lines, i + 1, next, base);
      if (nestedErr) {
        return nestedErr;
      }
    } else if (v[0] === '|' || v[0] === '>') {
      if (!/^[|>][1-9+-]{0,2}[ \t]*(#.*)?$/.test(v)) {
        return { unknown: true };
      }
      kind = 'block';
      let blockIndent = -1;
      while (next < lines.length) {
        const l = lines[next];
        if (l.trim() === '') {
          next++;
          continue;
        }
        const n = indentOf(l);
        if (n <= base) {
          break;
        }
        if (blockIndent < 0) {
          blockIndent = n;
        } else if (n < blockIndent) {
          return err(next, `bad indentation in the value of "${key}"`);
        }
        next++;
      }
    } else if (v[0] === '"' || v[0] === "'") {
      kind = 'quoted';
      const s = scanQuoted(lines, i, col);
      if (!s) {
        return err(i, `the quote that opens the value of "${key}" is never closed`);
      }
      if (!restOk(s.rest)) {
        return err(s.endLine, `text after the closing quote in the value of "${key}": put the whole value in quotes`);
      }
      next = s.endLine + 1;
    } else if (v[0] === '[' || v[0] === '{') {
      kind = 'flow';
      const s = scanFlow(lines, i, col);
      if (!s) {
        return err(i, `the ${v[0]} that opens the value of "${key}" is never closed`);
      }
      if (!restOk(s.rest)) {
        return err(s.endLine, `text after the closing ${v[0] === '[' ? ']' : '}'} in the value of "${key}": put the whole value in quotes`);
      }
      next = s.endLine + 1;
    } else if (v[0] === '*') {
      const name = /^\*([^\s,[\]{}]+)/.exec(v);
      if (!name || !anchors.has(name[1])) {
        return err(i, `the value of "${key}" starts with "*", which YAML reads as a reference: put the value in quotes`);
      }
      kind = 'alias';
    } else if (v[0] === '!') {
      return err(i, `the value of "${key}" starts with "!": put the value in quotes`);
    } else if (v[0] === '@' || v[0] === '`' || v[0] === '%') {
      return err(i, `the value of "${key}" starts with "${v[0]}": put the value in quotes`);
    } else if (/^-([ \t]|$)/.test(v) || /^:([ \t]|$)/.test(v)) {
      return err(i, `the value of "${key}" starts with "${v[0]} ": put the value in quotes`);
    } else {
      if (hasColonSpace(stripComment(v))) {
        return err(i, COLON(key));
      }
      // continuation lines of a plain scalar
      let ended = /[ \t]#/.test(v);
      while (next < lines.length) {
        const l = lines[next];
        if (l.trim() === '') {
          next++;
          continue;
        }
        if (indentOf(l) <= base) {
          break;
        }
        if (/^[ \t]*#/.test(l)) {
          ended = true;
        }
        if (!ended && hasColonSpace(stripComment(l.trim()))) {
          return err(next, COLON(key));
        }
        if (/[ \t]#/.test(l)) {
          ended = true;
        }
        next++;
      }
    }
    keys.set(key, { kind, line: i, col: valueCol, end: next });
    i = next;
  }
  return { keys };
}

// Nested lines from..to (exclusive) under a key at indent base: flags a 'key: plain' line whose plain value contains
// ': ', skipping the deeper lines of a nested block scalar, quoted or flow value (not checked).
function checkNested(lines, from, to, base) {
  let skipDeeperThan = -1;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) {
      continue;
    }
    const n = indentOf(l);
    if (skipDeeperThan >= 0) {
      if (n > skipDeeperThan) {
        continue;
      }
      skipDeeperThan = -1;
    }
    let body = l.slice(n);
    if (/^-([ \t]|$)/.test(body)) {
      continue; // a sequence entry: not checked
    }
    const m = KEY_RE.exec(body);
    if (!m) {
      continue;
    }
    const v = m[2];
    if (v === '' || v[0] === '#') {
      continue;
    }
    if (/^[|>"'[{]/.test(v)) {
      skipDeeperThan = n;
      continue;
    }
    if (/^[&*!@`%]/.test(v)) {
      continue;
    }
    if (hasColonSpace(stripComment(v))) {
      return { error: { line: i, detail: COLON(m[1].replace(/^["']|["']$/g, '')) } };
    }
  }
  return null;
}

// Splits a file the way gray-matter does. { frontmatter: null | { lines, closed }, body }
function splitFrontmatter(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) {
    t = t.slice(1);
  }
  t = t.replace(/\r\n?/g, '\n');
  if (!t.startsWith('---') || t[3] === '-') {
    return { frontmatter: null, body: t };
  }
  const lines = t.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      return { frontmatter: { lines: lines.slice(1, i), closed: true }, body: lines.slice(i + 1).join('\n') };
    }
  }
  return { frontmatter: { lines: lines.slice(1), closed: false }, body: '' };
}
```
