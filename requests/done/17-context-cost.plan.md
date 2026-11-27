# Plan 17: Context cost of the selection

## Context

- Repository: this one (`cursor-team-plugins`), branch `request/17-context-cost`. Request: `requests/17-context-cost.md`.
- Version: stays `0.8.5` in `package.json` (bumped at release, not by a request).
- Files and functions involved:
  - `lib/catalog.js`: `itemChild` (line 211) reads each skill, rule, command and agent file once; `readChildren`
    calls it. The new per-item measure is computed there.
  - `lib/checks.js`: `splitFrontmatter` (line 308), `lintFrontmatter` (line 98; its result `keys` gains `end`),
    `stripComment` (line 25).
  - `lib/treeModel.js`: `buildTree` (line 40): plugin row `parts` (line ~50-56) and `tooltip` (line 57), item `lines`
    (line 104) and item `description` (line ~120).
  - `extension.js`: `updateStatus` (line 1577, status bar tooltip, `Active:` line at 1640), `treeView` (line 87,
    created at 3772), `testHook` (`badge` at 3723, `status` at 3739).
  - New: `lib/context.js`, `test/context.test.js`, `test/live/context.live.js`.

## Measured facts (don't measure them again)

All read in Cursor 3.32.4's agent host bundle
`$LOCALAPPDATA/Programs/cursor/resources/app/extensions/cursor-agent-host/dist/4846.js` (2026-11-27), YAML values also
run through Cursor's own gray-matter (`resources/app/node_modules/gray-matter`, 4.0.3).

1. A plugin rule's type is decided by one function (`To`), in this order: `alwaysApply` is the boolean `true` ->
   `global`; else `globs` gives a non-empty list -> `fileGlobbed`; else `description` is a non-empty string ->
   `agentFetched`; else `manuallyAttached`.
2. The plugin rule (and skill) parser (`J`): `alwaysApply: !0===data.alwaysApply` (strict boolean); `globs: Y(data.globs)`
   where `Y` takes a string split on commas that are not inside `{...}` (each part trimmed, empty parts dropped), or an
   array of strings (trimmed, empty dropped); anything else -> undefined; `description` only when it is a string;
   `content` is the whole file text.
3. gray-matter (run): `alwaysApply: true`, `True`, `TRUE` -> boolean `true`; `yes` -> `"yes"`, `"true"` -> `"true"`
   (strings: not always). `globs: src/**/*.ts, *.tsx` -> one string; `globs: "*.ts"` -> string; `globs: ["*.ts", "*.tsx"]`
   and a block list (`globs:` then `  - "*.ts"`, `  - src/**`) -> arrays; `globs:` -> null; `globs: ""` -> `""`.
4. Skills go through the same type function (`Fo(plugins, p => p.skills)` maps every skill with `To`): a skill with
   `alwaysApply: true` becomes a `global` rule with its whole content, and is skipped from the agent skill list
   (`if(!0===c.alwaysApply)continue`). Every other skill is sent with its description and a `disableModelInvocation`
   flag (`disable-model-invocation: true` in its frontmatter).
5. Descriptions of skills and of agent-requested rules are cut to 1536 characters before they are sent
   (`xs(e) = Ti(e, 1536)`).
6. The prompt is built on Cursor's server: how a listed description is wrapped, whether a `disableModelInvocation`
   skill is listed, and whether subagent descriptions are in every chat can't be seen. Hence an estimate.
7. The test fixture (`test/fixtures/team-repo`), measured: skill descriptions `code-review` 60 characters (15 tokens at
   4 per token, rounded up), `security-check` 59 (15), `docs`'s `write-readme` 47 (12; folded description); rule
   `style.mdc`: `description: Team code style for the live test.` (34 characters, 9 tokens), `alwaysApply: false`, body
   `Prefer small functions and explicit names.` (42 characters, 11 tokens). The working tree has CRLF line ends (git
   autocrlf): `splitFrontmatter` normalises them, so the body is measured with `\n`.
8. The live test hook's `tree()` snapshot already holds each node's `description` and `tooltip`; `status()` holds the
   status bar tooltip.

Project facts that apply: `lib/` never requires `vscode`; `extension.js` is not covered by the unit tests (check its
syntax); the README names files in plain text (no relative links).

## Design

### Measure: `lib/context.js` (new, pure)

Requires `./checks` only (not `./catalog`: catalog requires context).

`itemContext(kind, text, frontmatterField)` -> `null` or `{ apply, chars, globs }` (`globs` only when `apply` is
`'globs'`). `frontmatterField` is the catalog's reader, passed in (same pattern as `checks.checkItemText`).

- Only `kind` `'skill'` and `'rule'`; any other kind -> `null`.
- `fm = checks.splitFrontmatter(text)`. `body = fm.body.trim()`.
  - `fm.frontmatter === null` -> keys = empty.
  - `fm.frontmatter.closed === false` -> `null`.
  - `r = checks.lintFrontmatter(fm.frontmatter.lines)`: `r.error` or `r.unknown` -> `null` (Cursor drops it, or we
    can't tell: say nothing); `r.empty` or `r.notMapping` -> keys = empty; else keys = `r.keys`.
- `isTrue(key)`: the entry exists, its `kind` is `'plain'` and `entry.value.trim()` matches `/^(?:true|True|TRUE)$/`.
- `globs` = `globsOf(...)` (below) of the `globs` entry; `[]` when there is none.
- `description` = `frontmatterField(text, 'description')`.
- `DESCRIPTION_MAX = 1536`; `descChars = Math.min(description.length, DESCRIPTION_MAX)`.
- Rule: `isTrue('alwaysApply')` -> `{ apply: 'always', chars: body.length }`; else `globs.length > 0` ->
  `{ apply: 'globs', chars: body.length, globs }`; else `description !== ''` -> `{ apply: 'agent', chars: descChars }`;
  else `{ apply: 'manual', chars: 0 }`.
- Skill: `isTrue('alwaysApply')` -> `{ apply: 'always', chars: body.length }`; else
  `isTrue('disable-model-invocation')` -> `{ apply: 'hidden', chars: 0 }`; else
  `{ apply: 'description', chars: descChars }` (an empty description counts, with 0 characters).

`globsOf(entry, lines, text, frontmatterField)` (internal; `lines` = the frontmatter lines):
- `'plain'`, `'quoted'`, `'block'`: `splitGlobs(frontmatterField(text, 'globs'))`.
- `'flow'`: `raw` = the text after the first `:` on `lines[entry.line]`, joined with a space to
  `lines.slice(entry.line + 1, entry.end)`, trimmed. If it starts with `[`: take the part between the `[` and the
  last `]`, `splitGlobs` it, unquote each part (a part that starts and ends with the same `"` or `'` loses them), trim,
  drop empty parts. A `{` mapping -> `[]`.
- `'nested'`: each line of `lines.slice(entry.line + 1, entry.end)` matching `/^\s*-[ \t]+(.*)$/`: its value, unquoted
  as above, else (plain) passed through `stripComment` (reimplement: cut from the first `#` that follows a space or a
  tab) and trimmed; empty values dropped. No `- ` line (a nested mapping) -> `[]`.
- anything else (`'alias'`) -> `[]`.

`splitGlobs(s)` (exported): Cursor's `Y` for a string: split on `,` when not inside `{...}` (a depth counter: `{` +1,
`}` -1 when > 0); each part trimmed, empty parts dropped. When the braces are left unbalanced at the end, the
remainder after the last split is split on every `,` instead (as `Y` does). Non-string -> `[]`.

`checks.lintFrontmatter`: every `keys` entry gains `end`, the 0-based line index just after its value (the `next` the
loop already computes: `keys.set(key, { kind, line: i, end: next, value: ... })`). Nothing else changes in checks.

`lib/catalog.js` `itemChild`: after the description, `const context = itemContext(kind, text, frontmatterField)`;
set `child.context = context` only when it is not `null` (commands and agents never get the field).

### Tokens

- `tokens(chars) = Math.ceil(chars / 4)`.
- `formatTokens(n)` (exported):
  - `n < 100` -> `String(n)`;
  - else `r = Math.round(n / 10) * 10`; `r < 1000` -> `String(r)`;
  - else `n < 9950` -> `(Math.round(n / 100) / 10)` as a string (so `1` not `1.0`) + `'k'`;
  - else `Math.round(n / 1000) + 'k'`.
  - Examples: 0 -> `0`, 7 -> `7`, 99 -> `99`, 123 -> `120`, 995 -> `1k`, 1234 -> `1.2k`, 1960 -> `2k`, 9949 -> `9.9k`,
    9950 -> `10k`, 12345 -> `12k`.

### Cost of a set of items

`costOf(children)` (exported) -> `{ known, always: { count, tokens, onlyRules }, descriptions: { count, tokens },
globbed: { count, tokens }, total }`:
- `known`: at least one child has a `context`.
- Per child with a `context`: `'always'` -> always (count +1, chars +, `onlyRules` false when the child's kind is not
  `'rule'`); `'agent'` or `'description'` -> descriptions; `'globs'` -> globbed; `'manual'`, `'hidden'` -> nothing.
- Each bucket's `tokens = tokens(sum of its chars)` (rounded once per bucket, not per item). `onlyRules` starts true.
- `total = always.tokens + descriptions.tokens` (the glob rules are not in it).

`costLines(cost, prefix)` (exported) -> array of tooltip lines:
- `!cost.known` -> `[]`.
- First line: `${prefix}: ${text}` where `text` is:
  - `nothing` when `always.count + descriptions.count === 0`;
  - else `~${formatTokens(total)} tokens (${parts.join(', ')})`, parts in this order, each only when its count > 0:
    `${n} always-applied ${onlyRules ? 'rule' : 'item'}${n === 1 ? '' : 's'} ~${formatTokens(always.tokens)}` and
    `${n} description${n === 1 ? '' : 's'} ~${formatTokens(descriptions.tokens)}`.
- Then, when `globbed.count > 0`: `For matching files: ${n} rule${s} (~${formatTokens(globbed.tokens)} tokens when
  ${n === 1 ? 'it applies' : 'they apply'})`.

`selectionCost(catalog, eff)` (exported): `costOf` of every child of every plugin of `catalog.plugins` whose id is in
`eff.get(plugin.name).included` (plugins without an entry, or not active, add nothing).

`statusLines(cost)` (exported): `cost.always.count + cost.descriptions.count + cost.globbed.count > 0` ?
`costLines(cost, 'In every chat')` : `[]`.

`viewDescription(cost)` (exported): `cost.total > 0 ? \`~${formatTokens(cost.total)} tokens per chat\` : ''`.

`itemLine(child)` (exported) -> one tooltip line, or `''` when the child has no `context`. `t = formatTokens(tokens(chars))`:
- rule `'always'`: `Applies always: the whole rule is in every chat (~${t} tokens)`
- rule `'globs'`: `Applies to files matching ${globs.join(', ')} (~${t} tokens when it does)`
- rule `'agent'`: `Applies when the agent asks for it: its description is in every chat (~${t} tokens)`
- rule `'manual'`: `Applies only when you mention it (@${child.name})`
- skill `'always'`: `Applies always (alwaysApply): the whole skill is in every chat (~${t} tokens)`
- skill `'description'`: `In every chat: its description (~${t} tokens)`
- skill `'hidden'`: `Not offered to the agent (disable-model-invocation): only by /${child.name}`

### Tree (`lib/treeModel.js` `buildTree`)

- Plugin: `counted = e.active ? plugin.children.filter((c) => e.included.has(c.id)) : plugin.children`;
  `cost = costOf(counted)`; `known = plugin.children.some((c) => c.context)`.
  - Row text: when `e.active && cost.total > 0`, push `~${formatTokens(cost.total)} tokens` into `parts` right after
    the `n/m` part (before the `new`/`updated` marks and the problem count). Example: `v0.1.0 · ~41 tokens`,
    `v0.1.0 · 2/5 · ~30 tokens · 1 new`.
  - Tooltip: when `known`, append `costLines(cost, e.active ? 'In every chat' : 'If enabled, in every chat')` right
    after the description/project line (before the last-change line and the problems). When `known` but `counted`
    holds no item with a context (a partial plugin with only a command ticked), `costOf` gives `known: false`: then
    use `costLines({ ...cost, known: true }, prefix)`, which reads `In every chat: nothing`.
- Item: the `itemLine(c)` line goes right after the description/project line (before the last-change line, the mark
  and the problems), only when not `''`.
- Item row text: `KIND_LABELS[kind]` + (`c.context && c.context.apply === 'always'` ? ` · always` : '') + the mark +
  the problem part, as today otherwise. Example: `rule · always`, `rule · always · new`.

### Total (`extension.js`)

- `updateStatus`: `const cost = context.selectionCost(catalog, selection.effective(catalog, userSelection(),
  projectList()))`. Push `...context.statusLines(cost)` into `lines` just before the `Active:` line (inside the
  tooltip, after the registration-error line). Then `if (treeView) treeView.description = context.viewDescription(cost)`.
  `updateStatus` already runs at the end of every `doApply` (selection, project and catalog changes all apply).
- `testHook`: add `viewDescription: () => (treeView && treeView.description) || ''` next to `badge`.
- Require `./lib/context` at the top with the other `lib` requires.

### Wording users see (exact)

- Item tooltip lines: as listed under `itemLine`.
- Plugin tooltip and status tooltip: `In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)`,
  `If enabled, in every chat: ~12 tokens (1 description ~12)`, `In every chat: nothing`,
  `For matching files: 1 rule (~10 tokens when it applies)`.
- Plugin row: `· ~41 tokens`. View title description: `~41 tokens per chat`.

## Impact

- `checks.lintFrontmatter`'s `keys` entries gain `end`: its only caller in `lib/` is `checkItemText` (reads `kind`,
  `line`, `value`): no change. `test/checks.test.js` lines 110-111 compare an entry with `deepEqual`: update them
  (below).
- Catalog children gain `context` (skills and rules): `mergeCatalogs` copies children with a spread (keeps it);
  `selection`, `materialize`, `updates`, `share`, `rename` read other fields: no change. Diagnostics compare problems
  only.
- `buildTree` tooltips: existing tests build children without `context`, so their tooltips and row texts stay as they
  are (no `known` plugin, no item line). Check `test/treeModel.test.js` still passes unchanged.
- `updateStatus` gets a new line in the tooltip: `remote-errors.live.js` and the runner check only `status().text`.
- `test/make-test-repo.test.js`: fixture unchanged.

## Not handled

Written in the README's "Known limitations" (one bullet) and in `docs/development.md`:
- MCP servers' tool definitions (known only once the server runs), subagent descriptions and commands: not counted.
- The project's own `.cursor/rules` and skills, and the user rules: not counted (only the team plugins).
- The text Cursor's server wraps around each description, and the exact tokenizer: an estimate at 4 characters per
  token.
- `globs` on a skill (Cursor also files it as a rule for matching files): the skill counts by its description.
- A plugin whose `plugin.json` declares paths for skills or rules: the count uses the default `skills/` and `rules/`
  folders, as the view does.
- A non-string `description` (`description: 123`): read as text (Cursor would treat the rule as manual).

## Tests

Command: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js` (the runner picks up the
new `test/context.test.js` by itself).

### `test/context.test.js` (new)

`fm = require('../lib/catalog').frontmatterField`. `ctx(kind, text) = itemContext(kind, text, fm)`.

Rules:
- `---\nalwaysApply: true\n---\nHello world\n` -> `{ apply: 'always', chars: 11 }`.
- same with `True` and `TRUE` -> `always`; with `yes`, `"true"`, `false` (and a `description: d`) -> `agent`, chars 1.
- `alwaysApply: true # on` (comment) -> `always`.
- always wins: `description: d\nglobs: "*.ts"\nalwaysApply: true` + body `abcd` -> `{ apply: 'always', chars: 4 }`.
- `globs: src/**/*.ts, *.tsx` + body `abcdefgh` -> `{ apply: 'globs', chars: 8, globs: ['src/**/*.ts', '*.tsx'] }`.
- `globs: "*.ts"` -> globs `['*.ts']`.
- `globs: ["*.ts", '*.tsx']` -> `['*.ts', '*.tsx']`.
- `globs:\n  - "*.ts"\n  - src/** # c\n` -> `['*.ts', 'src/**']`.
- `globs: "{a,b}/*.ts, c"` -> `['{a,b}/*.ts', 'c']`.
- `globs:` (empty) with `description: Use it` -> `{ apply: 'agent', chars: 6 }`; `globs: ""` with no description ->
  `{ apply: 'manual', chars: 0 }`.
- `description: ` + 2000 `x` -> `{ apply: 'agent', chars: 1536 }`.
- no frontmatter at all (`Just text\n`) -> `{ apply: 'manual', chars: 0 }`.
- CRLF: `---\r\nalwaysApply: true\r\n---\r\nab\r\ncd\r\n` -> `{ apply: 'always', chars: 5 }` (`ab\ncd`).
- broken frontmatter (`---\ndescription: Use when: x\n---\nb\n`) -> `null`; unclosed (`---\nalwaysApply: true\n`) ->
  `null`.
- kind `'command'` and `'agent'` -> `null`.

Skills:
- `---\nname: s\ndescription: Review code.\n---\n# S\n` -> `{ apply: 'description', chars: 12 }`.
- `alwaysApply: true` + body `abcdefgh` -> `{ apply: 'always', chars: 8 }`.
- `disable-model-invocation: true` + description -> `{ apply: 'hidden', chars: 0 }`; with `alwaysApply: true` too ->
  `always`.
- no description -> `{ apply: 'description', chars: 0 }`.
- a skill with `globs: "*.ts"` and `description: d` -> `{ apply: 'description', chars: 1 }`.

`splitGlobs`: `'a, b'` -> `['a', 'b']`; `' , a ,'` -> `['a']`; `'{a,b},c'` -> `['{a,b}', 'c']`; `'{a,b'` ->
`['{a', 'b']`; `''` -> `[]`; `null` -> `[]`.

`formatTokens`: the ten examples of the design.

`costOf` / `costLines` (children built by hand: `{ id, kind, name, context }`):
- rule always 42 chars, two skills 60 and 59 chars -> `costLines(c, 'In every chat')` equals
  `['In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)']`.
- add a glob rule of 39 chars -> second line `For matching files: 1 rule (~10 tokens when it applies)`; two glob rules
  (39 + 39) -> `For matching files: 2 rules (~20 tokens when they apply)`.
- an always skill plus an always rule -> `2 always-applied items ~...`.
- only a manual rule and a hidden skill -> `['In every chat: nothing']`.
- children without `context` only (a command) -> `[]`.
- `If enabled, in every chat` prefix carried as given.
- descriptions 1 + 1 + 1 chars -> descriptions tokens 1 (rounded once per bucket), not 3.

`itemLine`: each of the seven lines with a hand-built child; a child without `context` -> `''`. Exact texts:
`Applies to files matching src/**/*.ts, *.tsx (~10 tokens when it does)` (39 chars),
`Applies only when you mention it (@style)` (name `style`),
`Not offered to the agent (disable-model-invocation): only by /deploy` (name `deploy`).

`selectionCost`, `statusLines`, `viewDescription`: a catalog with plugin `p` (always rule 42 chars, skill 60 chars,
command) and plugin `q` (skill 47 chars); `eff` built with `selection.effective(catalog, { enabled: ['p'] }, [])` ->
total `11 + 15 = 26`, `viewDescription` `~26 tokens per chat`, `statusLines` one line
`In every chat: ~26 tokens (1 always-applied rule ~11, 1 description ~15)`. With `{ enabled: [] }` -> `viewDescription`
`''`, `statusLines` `[]`. With only `q`'s skill: `~12 tokens per chat`.

### `test/checks.test.js`

Lines 110-111: expected `{ kind: 'plain', line: 0, end: 1, value: 'x' }` and `{ kind: 'quoted', line: 1, end: 2,
value: '' }`. Add: `keys.get('tools').end === 4` and `keys.get('more').end === 6` for the same text
(`tools:\n  - a` spans lines 2-3, `more: >\n  b` lines 4-5).

### `test/catalog.test.js`

One case on a repository written to a temp folder (follow the existing helpers of that file): plugin `p` with
`rules/always.mdc` (`---\nalwaysApply: true\n---\nabcd\n`), `rules/ts.mdc` (`---\nglobs: "*.ts"\n---\nx\n`),
`skills/s/SKILL.md` (`---\nname: s\ndescription: Review code.\n---\nBody\n`) and `commands/c.md`: the children's
`context` are `{ apply: 'always', chars: 4 }`, `{ apply: 'globs', chars: 1, globs: ['*.ts'] }`,
`{ apply: 'description', chars: 12 }`, and the command has no `context` property.

### `test/treeModel.test.js`

Add cases (children with `context` built by hand):
- full plugin (always rule 42, skills 60 and 59, version `1.0`), enabled: row text `v1.0 · ~41 tokens`; tooltip has
  `In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)` right after the description line; the rule
  row text `rule · always`, its tooltip second line `Applies always: the whole rule is in every chat (~11 tokens)`;
  a skill's tooltip second line `In every chat: its description (~15 tokens)`.
- same plugin not enabled: row text `v1.0` (no tokens); tooltip has
  `If enabled, in every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)`.
- partial: only one skill (60) ticked: row text `v1.0 · 1/3 · ~15 tokens`; tooltip
  `In every chat: ~15 tokens (1 description ~15)`.
- partial with only a command ticked (plugin with a skill and a command): tooltip has `In every chat: nothing`, row
  text without tokens.
- with an `updates` mark on the rule: rule row text `rule · always · new`; the tooltip lines in order: description,
  `Applies always: …`, `New since you last looked`.
- children without `context`: tooltips and row texts as before (the existing tests cover it; don't change them).

### `test/live/context.live.js` (new scenario)

Pattern of `test/live/checks.live.js`. `setup`: `ctx.makeTestRepo(path.join(ctx.repos, 'team.git'))`, settings
`teamPlugins.repositories: [url]`, `teamPlugins.enabled: ['team-test:review']`. `run`:
1. Wait for `review` registered, `t.idle()`.
2. `t.find('plugin:team-test:review')`: `description` includes `~39 tokens`, `tooltip` includes
   `In every chat: ~39 tokens (3 descriptions ~39)`. Rule `item:team-test:review/rules/style.mdc`: `description` is
   `rule`, `tooltip` includes `Applies when the agent asks for it: its description is in every chat (~9 tokens)`.
   Skill `item:team-test:review/skills/code-review`: `tooltip` includes `In every chat: its description (~15 tokens)`.
   `plugin:team-test:docs`: `tooltip` includes `If enabled, in every chat: ~12 tokens (1 description ~12)`.
   `hook.viewDescription()` is `~39 tokens per chat`; `hook.status().tooltip` includes
   `In every chat: ~39 tokens (3 descriptions ~39)`.
3. Write the clone's `review/rules/style.mdc` (folder: `path.dirname(registrations['team-test:review'])`) as
   `---\ndescription: Team code style for the live test.\nalwaysApply: true\n---\nPrefer small functions and explicit names.\n`;
   wait until the rule row's `description` is `rule · always`; then its tooltip includes
   `Applies always: the whole rule is in every chat (~11 tokens)`, the plugin tooltip includes
   `In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)`, `hook.viewDescription()` is
   `~41 tokens per chat`.
4. `hook.check('plugin:team-test:review', false)`; wait until `hook.viewDescription()` is `''`; then the status tooltip
   doesn't include `In every chat`, the plugin row `description` doesn't include `tokens`, its tooltip includes
   `If enabled, in every chat: ~41 tokens`.
5. `t.noSpinner()`.

## Keep in step

- `README.md`, "Choosing plugins": a short subsection "### Context cost" after the list of tick rules (before
  "Plugins a project needs"): what the view shows (the title's `~N tokens per chat` for this window's selection,
  user and project together; an enabled plugin's `~N tokens`; the plugin tooltip's breakdown and `If enabled, …`; the
  rule tooltip's four ways to apply; `rule · always`); what counts in every chat (always-applied rules and skills
  whole, descriptions of skills and agent-requested rules, cut at 1536 characters; rules for matching files apart; a
  skill with `disable-model-invocation: true` not counted); that it is an estimate (4 characters per token). In
  "Known limitations": one bullet with the "Not handled" list in short.
- `docs/development.md`, "How it works": a "### Context cost" section after "### Checks": `lib/context.js`
  (`itemContext` in `readCatalog`, `costOf`, the tree and `updateStatus`), and the measured facts 1-6 with their
  source (Cursor 3.32.4 agent host bundle, gray-matter run, 2026-11-27); the `end` of `lintFrontmatter` keys.
- `AGENTS.md`, Layout: add `context` (`itemContext`, `splitGlobs`, `formatTokens`, `costOf`, `costLines`,
  `selectionCost`, `statusLines`, `viewDescription`, `itemLine`: the context cost estimate) to the `lib/` list; in
  "Why the code is shaped this way", one bullet: a rule's type is decided in Cursor's agent host in the order
  alwaysApply (boolean true) > globs > description > manual, skills too (an `alwaysApply` skill is a whole-text
  rule), descriptions cut at 1536 characters; the prompt is built server side, so the cost is an estimate.
- `package.json`: no change (no new setting or command; version unchanged).

## Commands

- Tests: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js`
- Syntax: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js`
- Package: `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/package.js`
- Live (main session, not the implementer): `ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/live-test.js context`

## Hand checks

Only what the live scenario can't show: the look of the view title, the row texts and the tooltips. Setup (the
helper): `python scripts/live_check.py install`, `python scripts/live_check.py settings backup <scratchpad>/settings-backup`;
`scripts/make-test-repo.js <scratchpad>/team-plugins.git`; in a clone of it (with a git identity in the clone's
`.git/config`) change `review/rules/style.mdc` to `alwaysApply: true` (keep its description and body), add
`review/rules/typescript.mdc` = `---\nglobs: src/**/*.ts, *.tsx\n---\nUse strict TypeScript types; avoid any.\n` and
`review/rules/manual.mdc` = `---\nalwaysApply: false\n---\nMention this rule to use it.\n`, commit, push to the bare
repository; user settings `teamPlugins.repositories: ["<bare path>"]`, `teamPlugins.enabled: ["team-test:review"]`.

### Test 1: the totals and the plugin rows
Window: any.
1. Press `Ctrl+Shift+P`, run `Developer: Reload Window`.
2. Open the Team Plugins view (its icon in the activity bar).
3. Hover the `Review (test)` row.
4. Hover the `Docs (test)` row.

Expected:
- 👁 Next to the view's title: `~41 tokens per chat`.
- 👁 `Review (test)` row text ends with `~41 tokens`.
- 👁 Its tooltip has `In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)` and
  `For matching files: 1 rule (~10 tokens when it applies)`.
- 👁 `Docs (test)` row text has no tokens; its tooltip has `If enabled, in every chat: ~12 tokens (1 description ~12)`.
- 📋 `live_check.py status --since install`: the installed files match the working tree, no error line.

### Test 2: rules and skills
1. Expand `Review (test)`.
2. Hover `style`, then `typescript`, then `manual`, then `code-review`.

Expected:
- 👁 The `style` row reads `rule · always`; the others `rule` and `skill`.
- 👁 `style`: `Applies always: the whole rule is in every chat (~11 tokens)`.
- 👁 `typescript`: `Applies to files matching src/**/*.ts, *.tsx (~10 tokens when it does)`.
- 👁 `manual`: `Applies only when you mention it (@manual)`.
- 👁 `code-review`: `In every chat: its description (~15 tokens)`.

### Test 3: the status bar and unticking
1. Hover the `Team plugins` item of the status bar.
2. Untick `Review (test)`.
3. Hover the status bar item again.
4. Tick `write-readme` under `Docs (test)`.

Expected:
- 👁 First hover: a line `In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)` above `Active:`,
  then `For matching files: 1 rule (~10 tokens when it applies)`.
- 👁 After unticking: the title shows nothing after it, the `Review (test)` row has no tokens, the status tooltip has
  no `In every chat` line.
- 👁 After ticking `write-readme`: the title shows `~12 tokens per chat`, the `Docs (test)` row reads
  `v0.1.0 · ~12 tokens`.
- 📋 `settings diff`: `teamPlugins.enabled` holds `team-test:docs/skills/write-readme` (or `team-test:docs`).

Cleanup: `settings diff` (only the test's changes), `settings restore`, `settings diff` (no difference), the bare
repository and the clone removed. The installed build stays.

## Changes after review

- `extension.js` requires the module as `contextCost` (`activate`, `registerCommands` and `testHook` take a parameter
  named `context`).
- `checks.stripComment` is exported and used by `lib/context.js` instead of a copy.
- A block-list glob that is quoted and followed by a comment (`- "*.ts" # c`) loses its quotes; tested in
  `test/context.test.js` with `- "a #b"` (a quoted `#` kept).

## Don't

- No commit. No change outside the files listed here without reporting it; `requests/` files are not yours to edit.
- Never run `cursor --install-extension` or launch the user's Cursor; don't run `scripts/live-test.js` (the main session
  does).
- No dependency, no TypeScript, no bundler; nothing under `lib/` may require `vscode`.
- Don't require `./catalog` from `lib/context.js` (catalog requires context: a cycle).
- Don't change existing tests other than `test/checks.test.js` lines 110-111; if another one fails, stop and report.
- README: no relative links to files (plain text names; `package.test.js` checks it).
- Edit with the Edit/Write tools, not scripts that rewrite files.
