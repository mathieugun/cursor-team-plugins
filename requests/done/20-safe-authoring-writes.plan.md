# Plan 20: Authoring and Rename write only inside the repository, and keep files valid

## Context

- Repository: cursor-team-plugins, branch `request/20-safe-authoring-writes` (from `request/19-no-silent-data-loss`).
  Request: `requests/20-safe-authoring-writes.md`. Version stays `0.8.6` (bumped at release only).
- Files and functions:
  - `lib/catalog.js`: `inside(root, dir)` (L101-104, not exported yet), `serverTable`, `mcpServerNames` (L135-161),
    the MCP file reader (L300-320, `checks.parseJsonc`), `module.exports`.
  - `lib/checks.js`: `parseJsonc` (L400-457).
  - `lib/authoring.js`: `yamlScalar` (L40-44), `itemFile` (L52-78), `exists`/`readJson` (L90-105), `addMcpServer`
    (L183-224), `pluginLocation` (L228-247), `placePlugin` (L250-264), `createPlugin` (L277-298), `movePlugin`
    (L302-333), `module.exports`.
  - `lib/rename.js`: `renameItem` MCP branch (L127-157 read, L191-198 write), `renamePlugin` (L225-314).
  - `lib/share.js`: `renameSkillName` (L132-158, writes `name: ${newName}` at L154).
  - New `lib/jsonc.js` (text edits of JSONC files).
  - `extension.js`: the two loops that rewrite `enabled`/`excluded` with `authoring.renameIds` and
    `config.update(key, next, vscode.ConfigurationTarget.Global)`: in `moveDraftCommand` (after
    `const to =\`${labelOf(target)}:${plugin.pluginName}\``) and in `renameCommand` (after
    `const to = \`${plugin.repo}:${result.id}\``). Find them by content (`authoring.renameIds`): line numbers moved
    with request 19.
  - Tests: `test/authoring.test.js`, `test/rename.test.js`, `test/share.test.js`, new `test/jsonc.test.js`.

## Measured facts (don't measure them again)

- Cursor's gray-matter (`$LOCALAPPDATA/Programs/cursor/resources/app/node_modules/gray-matter`, the parser Cursor
  uses for frontmatter) on `itemFile('skill', 'x', d)` of today (2026-11-28, Cursor 3.32): `2026-11-27` -> a `Date`,
  `true` and `True` -> boolean, `null` and `NULL` -> null, `123`, `1e3`, `0x1F` -> numbers; `yes`, `on`,
  `Checks code` -> strings; `.inf` is already quoted by today's rule. With the description read as a non-string,
  `checks.checkItemText('skill', text, file, catalog.frontmatterField)` returns
  `No description: the agent can't tell when to use this skill`. A `name:` of `true`, `null`, `123` or `2026-11-27`
  (all valid for `nameError`) is read as boolean, null, number and Date the same way.
- `catalog.frontmatterField` strips one pair of surrounding double or single quotes (L88-93), so a quoted value reads
  back as the text (no escape processing; the test values have no quote or backslash).
- `fs.realpathSync` resolves a junction (`fs.symlinkSync(target, link, 'junction')`) to its target on Windows, and
  `path.relative('C:/A/Repo', 'c:/a/repo/x')` is `x` (case-insensitive) with Cursor's runtime (2026-11-28).
- `scripts/test.js` runs every `test/*.test.js` (readdir filter) and `scripts/package.js` packages every file of `lib/`
  (`filesOf('lib')`): a new `lib/jsonc.js` and `test/jsonc.test.js` need no list change.
- A plugin with folder = repository root exists only through a `marketplace.json` entry with `source: "."` (or a
  `source.path` of `.`): the folder scan (catalog L429-434) only takes subfolders.
- `renamePlugin` computes `newDir = path.join(path.dirname(plugin.dir), newName)` (L238) and renames `plugin.dir`
  (L297): for `plugin.dir === repoDir` that moves the checkout (from the review; the failing test below shows it).
- `pluginLocation` joins `metadata.pluginRoot` unchecked (L243-244); `placePlugin` builds `dir` from it (L255).
- Baseline on this branch (request 19 committed, `1ace6a0`): 363 tests, 361 pass, 0 fail, 2 skipped (2026-11-28).
- From the project notes, not checked again: Cursor reads `mcp.json` as JSONC (comments, trailing commas, BOM);
  `plugin.json` and `marketplace.json` are strict JSON.

## Design

### 1. One containment check for plugin folders

`lib/catalog.js`: export `inside` (unchanged).

`lib/authoring.js`: new exported `pluginDirError(repoDir, dir)`: `''` when `dir` can be a plugin folder of the
repository, else why not:
1. `repoReal` = `fs.realpathSync(repoDir)`, falling back to `path.resolve(repoDir)` when it throws.
2. Resolve `dir`: start at `path.resolve(dir)`; while it does not `exists()` (the module's `exists`) and has a parent,
   move up and remember the names left behind; `real` = realpath of the deepest existing folder (fallback: its resolved
   path) joined with the remembered names.
3. `shown` = `path.relative(repoDir, path.resolve(dir))` with `/` separators.
4. `path.relative(repoReal, real) === ''` -> `'the plugin folder would be the repository root'`.
5. `!inside(repoReal, real)`: if `inside(path.resolve(repoDir), path.resolve(dir))` (inside before resolving links) ->
   `` `${shown} leads outside the repository through a link` ``, else `` `${shown} is outside the repository` ``.
6. Otherwise `''`.

`placePlugin(repoDir, folder, name)`: right after `dir` is computed, before the `exists(dir)` check:
`const bad = pluginDirError(repoDir, dir)`; when set, return
`{ error: \`${bad}${hint}\` }` with `hint` = `' (see metadata.pluginRoot in marketplace.json)'` when
`path.resolve(location.root) !== path.resolve(repoDir)`, else `''`. `createPlugin` and `movePlugin` both go through
`placePlugin` before any write, so Move never copies and never deletes the draft when this fails (no other change in
`movePlugin`).

`renamePlugin(plugin, newNameRaw, { repoDir, record })`, after `location` is read (L234-237) and before `newDir`:
- `same(a, b)`: realpath both (fallback `path.resolve`), lower-cased on win32 (like the existing `key` at L267).
- `same(plugin.dir, repoDir)` -> `{ error: \`${plugin.pluginName} is the repository's root folder (source "." in marketplace.json): renaming it would move the whole clone, and Cursor names a plugin after its folder, so it can't be renamed.\` }`
- else `same(plugin.dir, location.root)` -> `{ error: \`${plugin.pluginName} is the folder of metadata.pluginRoot in marketplace.json: renaming it would move every plugin below it, so it can't be renamed.\` }`
- then `newDir` as today, and `const bad = pluginDirError(repoDir, newDir); if (bad) return { error: bad };` before
  the `exists(newDir)` check.
Nothing is written before these checks (as today for the other checks).

### 2. MCP files are JSONC, read and edited as such

New `lib/jsonc.js` (pure, no `vscode`), three exports:

- `tokens(text)`: the tokens of a JSONC text, skipping a leading BOM, whitespace, `//` comments (to the end of the
  line) and `/* */` comments: `[{ type, start, end }]` (`end` exclusive), `type` one of `{ } [ ] : ,`, `'string'`
  (from `"` to the closing unescaped `"`, a `\` skips the next character, like `parseJsonc`) or `'value'` (a maximal
  run of characters that are not whitespace, not one of `{}[]:,"` and do not start a comment). Callers parse the text
  with `checks.parseJsonc` first, so `tokens` may assume valid JSONC.
- `renameKey(text, pathKeys, from, to)`: the text with every member key `from` of the object at `pathKeys` renamed
  to `to` (the key token replaced by `JSON.stringify(to)`; edits applied from the end so offsets hold). Throws
  `Error('no member <from>')` when there is none.
- `addMember(text, pathKeys, name, value)`: the text with the member `name: value` added at the end of the object at
  `pathKeys`.

`pathKeys` is `[]` (the top-level object) or `['mcpServers']`: the value of the **last** member `mcpServers` of the
top-level object (JSON's last-wins); throws `Error('"mcpServers" is not an object')` when that value's first token is
not `{`, and `Error('not an object')` when the text's first token is not `{`. A member key is a `'string'` token
directly inside the object (depth 1 within it) followed by a `:` token; its name is `JSON.parse` of the token text.

`addMember` layout, exactly (`o`/`c`: offsets of the object's `{` and its matching `}`; `nl` = `'\r\n'` when the text
contains `\r\n`, else `'\n'`; `indentOf(pos)` = the spaces and tabs at the start of the line holding `pos`;
`lineStart(pos)` = offset just after the previous `\n`, or 0):
- `last` = the last token strictly inside the object (before the `}` token); the object is empty when `last` is the
  object's own `{`.
- `ind` = `indentOf(first token after {)` when the object is not empty and that token is the first non-whitespace
  character of its line; else `indentOf(o) + '  '`.
- `pretty` = `` `${JSON.stringify(name)}: ${JSON.stringify(value, null, 2).replace(/\n/g, nl + ind)}` ``;
  `compact` = `` `${JSON.stringify(name)}:${JSON.stringify(value)}` ``.
- Comma: when the object is not empty and `last.type !== ','`, insert `,` at `last.end`.
- Then, by case (offsets taken before any insertion; apply the later insertion first):
  - **A**, `}` is the first non-whitespace character of its line (only spaces/tabs between `lineStart(c)` and `c`):
    insert `` `${ind}${pretty}${nl}` `` at `lineStart(c)`.
  - **B**, the object is empty and `text.slice(o + 1, c)` is only spaces/tabs (no comment, no newline): replace
    `text.slice(o, c + 1)` with `` `{${nl}${ind}${pretty}${nl}${indentOf(o)}}` ``.
  - **C**, otherwise (a compact object, or a comment inside an empty one-line object): insert `compact` at `c`.

Examples (they are test cases below): `{}` + `mcpServers`/`{ a: { command: 'x' } }` -> the same text as
`JSON.stringify(obj, null, 2)` without the final newline; `{"mcpServers":{"a":{"command":"x"}}}` + `b`/`{command:'y'}`
-> `{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}`.

`authoring.addMcpServer(pluginDir, name, entry)`:
- Every existing file (`mcp.json`, `.mcp.json`) is read with `checks.parseJsonc` (text read once, kept) for the
  duplicate-name check (a file that doesn't parse is skipped there, as today).
- The target file: when it exists, `parseJsonc` its text (a failure -> `{ error: \`${targetName}: ${err.message}\` }`
  as today; not a plain object -> `${targetName} is not a JSON object` as today). Then, with
  `useTable = serverTable(obj) || mcpServerNames(obj).length === 0`:
  - `useTable` and `obj` has an own key `mcpServers`: when `isPlainObject(obj.mcpServers)` ->
    `addMember(text, ['mcpServers'], name, entry)`; else `{ error: \`${targetName}: "mcpServers" is not an object\` }`
    (today it was silently replaced).
  - `useTable` and no `mcpServers` key -> `addMember(text, [], 'mcpServers', { [name]: entry })`.
  - else -> `addMember(text, [], name, entry)`.
  Write the returned text (a throw from `jsonc` -> `{ error: \`${targetName}: ${err.message}\` }`, nothing written).
- No target file: write `JSON.stringify({ mcpServers: { [name]: entry } }, null, 2) + '\n'` as today.

`rename.renameItem`, MCP branch: read each file's text once and parse it with `checks.parseJsonc` (instead of
`readJson`); a file that doesn't parse or isn't a plain object is still skipped (the catalog skipped it too). Write
`jsonc.renameKey(t.text, serverTable(t.obj) ? ['mcpServers'] : [], name, newName)` instead of the
`JSON.stringify(next ...)` (drop `renameKey` the local helper if nothing else uses it; it is also unused by plugins:
check). The undo stays (writes `t.text` back).

### 3. Generated YAML values read back as the same string

`yamlScalar(text)`: `t = String(text).trim()`; plain when `/^[A-Za-z][^:#\x00-\x1f]*$/.test(t)` and
`!/^(?:true|false|null|yes|no|on|off|y|n)$/i.test(t)`; otherwise `JSON.stringify(t)`. (Starting with a letter rules
out numbers, dates, `~`, `.inf` and every YAML indicator; the word list covers booleans and null of YAML 1.1 and 1.2,
quoting `yes`/`on` is harmless.) Update its comment.

Use it for the names too: `itemFile` writes `name: ${yamlScalar(name)}` (skill and agent), and `share.renameSkillName`
writes `name: ${yamlScalar(newName)}` (import `yamlScalar` from `./authoring`, which `share.js` already requires).

### 4. One settings migration for Move and Rename

`extension.js`: new function, placed before `moveDraftCommand`:

```js
// After the plugin or item `from` became `to` (ids with the repository name), the user's own lists follow it.
async function renameUserIds(from, to) {
  const config = cfg();
  for (const key of ['enabled', 'excluded']) {
    const current = stringList(config.get(key));
    const next = authoring.renameIds(current, from, to);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await config.update(key, next, vscode.ConfigurationTarget.Global);
    }
  }
}
```

`moveDraftCommand`: replace its loop (and its `const config = cfg();`) with `await renameUserIds(plugin.name, to);`.
`renameCommand`: replace its loop (and its `const config = cfg();`) with `await renameUserIds(from, to);`. Check that
`config` isn't used afterwards in either function.

## Impact

- `catalog.inside` export: no behaviour change in the catalog.
- `placePlugin` callers: `createPlugin`, `movePlugin` (both handled; error results already go to the user through
  `ui.showErrorMessage` in `extension.js`).
- `renamePlugin` callers: `renameCommand` (shows `result.error`): no change.
- `addMcpServer` caller (the Add MCP server command in `extension.js`): shows `result.error`; no change.
- `yamlScalar` callers: `itemFile` only (grep `yamlScalar`); `renameSkillName` callers: `share.renameSkill` /
  `shareItem` and `rename.renameItem`: a new name that needs quotes is now quoted; names that are plain today
  (start with a letter, not a YAML word) are written the same.
- `filterMcpJson` (generated partial-copy MCP files) still rewrites with `JSON.stringify`: unchanged (generated,
  repository -> copy only).
- Existing tests: `yamlScalar` test (L54-60) stays valid (`Review a change.`, `say "hi"` start with a letter);
  `addMcpServer` and the MCP `renameItem` tests compare parsed JSON or key order: they must pass unchanged. Report any
  existing test you had to change, with why.

## Not handled

- `filterMcpJson` drops comments in the generated copy (never written back).
- A JSONC file that `parseJsonc` rejects is refused by Add (as today) and skipped by Rename (as today).
- `frontmatterField` does not undo JSON escapes in a quoted value (`\"`): only a value with `"` or `\` that also needs
  quoting is affected; out of scope.
- A `marketplace.json` source other than the plugin's own folder (pre-existing catalog rule) is not re-checked here.
- Write the first two in `docs/development.md`'s limits list, one line each.

## Tests

Write the tests first and run them on the unchanged code: each one marked **(fails on main)** must fail there (on this
branch before your change). Report the failures you saw.

`test/jsonc.test.js` (new):
1. `tokens` of `'\uFEFF{ /* c */ "a" : [1, true], // x\n "b\\"": null }'` -> types
   `['{', 'string', ':', '[', 'value', ',', 'value', ']', ',', 'string', ':', 'value', '}']`, and the first string
   token's text (`text.slice(start, end)`) is `"a"`.
2. `addMember('{}', [], 'mcpServers', { a: { command: 'x' } })` ===
   `JSON.stringify({ mcpServers: { a: { command: 'x' } } }, null, 2)`.
3. `addMember('{"mcpServers":{"a":{"command":"x"}}}', ['mcpServers'], 'b', { command: 'y' })` ===
   `'{"mcpServers":{"a":{"command":"x"},"b":{"command":"y"}}}'`.
4. Comments and trailing commas kept (case A, trailing comma present): input
   ```
   {
     // team servers
     "mcpServers": {
       "a": { "command": "x" }, // main
     },
   }
   ```
   (with `\n`, two-space indents as shown) + `['mcpServers']`, `'b'`, `{ command: 'y' }` -> exactly
   ```
   {
     // team servers
     "mcpServers": {
       "a": { "command": "x" }, // main
       "b": {
         "command": "y"
       }
     },
   }
   ```
5. Comma inserted before a trailing comment: input
   `'{\n  "mcpServers": {\n    "a": { "command": "x" } // main\n  }\n}\n'` + `b`/`{ command: 'y' }` ->
   `'{\n  "mcpServers": {\n    "a": { "command": "x" }, // main\n    "b": {\n      "command": "y"\n    }\n  }\n}\n'`.
6. CRLF: input 5 with every `\n` replaced by `\r\n` -> expected 5 with every `\n` replaced by `\r\n`.
7. Empty one-line object with a comment (case C): `addMember('{ /* none */ }', [], 'a', 1)` ===
   `'{ /* none */ "a":1}'`.
8. Nested empty table (case B): `addMember('{\n  "mcpServers": {}\n}', ['mcpServers'], 'a', { url: 'u' })` ===
   `'{\n  "mcpServers": {\n    "a": {\n      "url": "u"\n    }\n  }\n}'`.
9. `renameKey` keeps everything else: input 4 renamed `a` -> `z` in `['mcpServers']` equals input 4 with `"a"`
   replaced by `"z"`; the top-level form: `renameKey('{"a":{"command":"x"},"b":{"url":"u"}}', [], 'b', 'z')` ===
   `'{"a":{"command":"x"},"z":{"url":"u"}}'`; a key inside a value is not touched:
   `renameKey('{"x":{"b":1},"b":2}', [], 'b', 'z')` === `'{"x":{"b":1},"z":2}'`; a missing member throws.
10. `addMember('{"mcpServers": []}', ['mcpServers'], 'a', 1)` throws `"mcpServers" is not an object`.

`test/authoring.test.js`:
11. **(fails on main)** `addMcpServer keeps comments and accepts a trailing comma`: a plugin whose `mcp.json` is input 4
    -> `addMcpServer(p, 'b', { command: 'y' })` returns `{ file }`; the file equals expected 4; `readCatalog(root)`
    lists `p/mcp/a` and `p/mcp/b`.
12. `addMcpServer refuses a "mcpServers" that is not an object`: `mcp.json` = `'{"mcpServers": null}'` ->
    `{ error: 'mcp.json: "mcpServers" is not an object' }`, file unchanged.
13. **(fails on main)** `a new item reads back its description, whatever it looks like`: for each kind of
    `['skill', 'rule', 'command', 'agent']` and each description of `['2026-11-27', 'true', 'null', '123', 'True',
    '1e3']`, `createItem(pluginDir, kind, \`n-${i}\`, d)` (unique names), read the file:
    `checkItemText(kind, text, file, frontmatterField)` deep-equals `[]` and `frontmatterField(text, 'description')`
    === `d`.
14. `yamlScalar` additions: `'2026-11-27'` -> `'"2026-11-27"'`, `'true'` -> `'"true"'`, `'No'` -> `'"No"'`,
    `'123abc'` -> `'"123abc"'`, `'Checks code'` -> `'Checks code'`, `'yes please'` -> `'yes please'`.
15. `itemFile('skill', '123', 'd').text` contains `'\nname: "123"\n'`; `itemFile('agent', 'true', 'd').text` contains
    `'\nname: "true"\n'`; `itemFile('skill', 'code-review', 'd').text` contains `'\nname: code-review\n'`.
16. `pluginDirError`: with `repo = <tmp>/repo` created: `pluginDirError(repo, path.join(repo, 'a'))` === `''`;
    `pluginDirError(repo, repo)` === `'the plugin folder would be the repository root'`;
    `pluginDirError(repo, path.join(repo, '..', 'x'))` === `'../x is outside the repository'`; a junction
    `repo/plugins` -> `<tmp>/outside` (helper like `junction` in `test/materialize.test.js`):
    `pluginDirError(repo, path.join(repo, 'plugins', 'new'))` === `'plugins/new leads outside the repository through a link'`.
17. **(fails on main)** `createPlugin refuses a pluginRoot outside the repository`: `repo = <tmp>/repo` with
    `.cursor-plugin/marketplace.json` = `{ name: 'team', metadata: { pluginRoot: '../outside' }, plugins: [] }`;
    `createPlugin(repo, { name: 'new' })` -> `{ error: '../outside/new is outside the repository (see metadata.pluginRoot in marketplace.json)' }`;
    `fs.existsSync(<tmp>/outside/new)` false; marketplace.json text unchanged.
18. **(fails on main)** `movePlugin keeps the draft when pluginRoot leads outside`: same repo; a draft folder
    `<tmp>/drafts/d` with `.cursor-plugin/plugin.json` and `skills/s/SKILL.md`; `movePlugin(draftDir, 'd', '', repo)`
    -> `{ error: '../outside/d is outside the repository (see metadata.pluginRoot in marketplace.json)' }`; the
    draft's two files still exist; `<tmp>/outside/d` does not exist.
19. **(fails on main)** `createPlugin refuses a pluginRoot that is a link to outside`: `repo/plugins` junction ->
    `<tmp>/outside`, `pluginRoot: 'plugins'` -> error
    `'plugins/new leads outside the repository through a link (see metadata.pluginRoot in marketplace.json)'`;
    `<tmp>/outside` stays empty.

`test/rename.test.js`:
20. **(fails on main)** `renamePlugin refuses the repository's root plugin and moves nothing`: `repo = <root>/repo`
    (a subfolder, so a wrong rename on main stays inside the test's temp folder) with
    `.cursor-plugin/marketplace.json` = `{ name: 'team', plugins: [{ name: 'whole', source: '.' }] }`,
    `.cursor-plugin/plugin.json` = `{ name: 'whole' }` and `skills/s/SKILL.md`;
    `renamePlugin({ dir: repo, pluginName: 'whole' }, 'other', { repoDir: repo, record: true })` -> `{ error }` equal to
    the root message of the design; `fs.readdirSync(<root>)` deep-equals `['repo']`; both files still in `repo`;
    marketplace.json text unchanged.
21. `renamePlugin refuses the pluginRoot folder`: marketplace `{ name: 'team', metadata: { pluginRoot: 'plugins' },
    plugins: [{ name: 'all', source: '.' }] }`, folder `repo/plugins` with `.cursor-plugin/plugin.json` ->
    `renamePlugin({ dir: <repo>/plugins, pluginName: 'all' }, 'x', { repoDir: repo, record: false })` -> the pluginRoot
    message of the design; `repo/plugins` still exists, `repo/x` does not.
22. **(fails on main)** `renameItem renames a server in a JSONC file and keeps its comments`: `review/mcp.json` = input 4
    of the jsonc tests -> `renameItem(itemOf(root, 'mcp', 'a'), 'z', { repoDir: root, record: false })` ->
    `{ id: 'review/mcp/z', file }`; the file equals input 4 with `"a"` replaced by `"z"`.

`test/share.test.js`:
23. `renameSkillName` writes a name that needs quotes quoted:
    `renameSkillName('---\nname: old\ndescription: d\n---\n', 'old', '123')` ===
    `'---\nname: "123"\ndescription: d\n---\n'`; a plain new name stays plain (existing tests).

## Keep in step

- `README.md`, the authoring section (New plugin / New item / Add MCP server / Rename; find it by "Add MCP server"
  and "Rename"): one sentence each where it fits: Add MCP server and Rename edit `mcp.json` in place, keeping its
  comments and layout; a plugin that is the repository's root folder (`source: "."`) can't be renamed; a description
  or name that YAML would read as something else (a date, `true`, a number) is written in quotes.
- `docs/development.md`, the authoring/rename internals (find by `movePlugin`, `renamePlugin` or "Rename"): the
  containment rule (`pluginDirError`, catalog's `inside`, links resolved through the deepest existing folder, never the
  repository root, checked before any write: New plugin, Move draft, Rename), the root/pluginRoot refusal and why
  (Cursor names a plugin after its folder; renaming the root moves the clone), `lib/jsonc.js` (tokens, `addMember`
  layout rule in two lines, `renameKey`), the `yamlScalar` rule. And the limits list: the two bullets of **Not
  handled**.
- `AGENTS.md`, Layout: add `jsonc` (`tokens`, `addMember`, `renameKey`: edits of JSONC files that keep comments and
  layout) to the `lib/` list; add `pluginDirError` to `authoring`'s list; add `inside` to `catalog`'s list. One "Why"
  bullet next to the `mcp.json is JSONC` one: "Add MCP server and Rename edit `mcp.json` as text (`lib/jsonc.js`), not
  `JSON.stringify` of the parsed object: a rewrite would drop the comments Cursor accepts there." One next to the
  `Rename` bullet: "A plugin folder built from repository data (`metadata.pluginRoot`, a rename) is checked with
  `authoring.pluginDirError` before any write; a plugin whose folder is the repository root or the `pluginRoot` folder
  is never renamed (it would move the clone or every plugin)."
- `.claude/implement.md`: not yours, don't edit.

## Commands

From the repository root (Git Bash), no node on PATH:

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
biome lint extension.js lib scripts test
```

One file: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --test test/jsonc.test.js`. (`biome` may be
missing from PATH: say so, don't install it.)

## Don't

- No commit, no branch change, no push.
- No change outside `lib/catalog.js`, `lib/authoring.js`, `lib/rename.js`, `lib/share.js`, `lib/jsonc.js`,
  `extension.js`, `test/authoring.test.js`, `test/rename.test.js`, `test/share.test.js`, `test/jsonc.test.js`,
  `README.md`, `docs/development.md`, `AGENTS.md` without reporting it. Don't edit the request or plan files or
  `.claude/implement.md`.
- Don't change `parseJsonc`, `filterMcpJson` or the catalog's reading rules.
- Don't run `cursor --install-extension`, don't launch the user's Cursor, don't run `scripts/live-test.js`.
- No dependency, no TypeScript; nothing under `lib/` requires `vscode`.
- A test marked **(fails on main)** that passes on the unchanged code: stop and report it before changing the code.
