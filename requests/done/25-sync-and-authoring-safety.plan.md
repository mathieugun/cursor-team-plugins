# Plan 25: preserve local work during sync and constrain authoring writes

## Context

- Repository: this one. Request: `requests/25-sync-and-authoring-safety.md`. Repro script:
  `requests/25-sync-and-authoring-safety.repro.py` (11 cases, all fail before the fix).
- Version: `package.json` 0.8.6, unchanged (bumped at release).
- Branch `request/25-sync-and-authoring-safety-claude` (already checked out). Never commit.
- Files and functions involved:
  - `lib/materialize.js`: `listFiles` (l.34), `belowFolder` (l.94), `excludedPrefixes` (l.139), `readManifest` (l.200),
    `syncCopy` (l.300-512), `resolveConflict` (l.533), `markCopySynced` (l.580).
  - `lib/contribute.js`: `pushToBranch` (l.124-198), the reset at l.179.
  - `lib/authoring.js`: `createItem` (l.126), `addMcpServer` (l.187), `pluginLocation` (l.243), `pluginDirError`
    (l.275), `placePlugin` (l.297), `addMarketplaceEntry` (l.319).
  - `lib/rename.js`: `readForRecord` (l.55), `renameItem` (l.104), `renamePlugin` (l.218).
  - `lib/share.js`: `shareItem` (l.171).
  - `extension.js`: `logCopyActions`/`logSkipped` (l.836-856), `syncPartials` (l.1482), New item (l.2474-2479),
    Share (l.2847).

Order of work: item 2, 3, 4, then 5 and 1.

## Measured facts (don't measure them again)

- All 11 repro cases fail on the branch before the change (`python requests/25-sync-and-authoring-safety.repro.py`:
  `FAIL push-ignored`, `FAIL push-staged`, `FAIL unreadable-case`, `FAIL case-rename-file` ... `FAIL mcp-rename`).
- On this Windows (NTFS) volume, `fs.statSync('Assets', { bigint: true })` and `fs.statSync('ASSETS', { bigint: true })`
  return the same `dev` and `ino` (`ino equal true true`); `fs.statSync('nope')` throws `ENOENT`. So comparing the stat
  of a path with the stat of its case-swapped spelling tells a case-insensitive folder.
- `git ls-files --others --ignored --exclude-standard --directory -z` lists an ignored file (`ign.txt`) and an ignored
  folder as `d/` (with the trailing slash).
- Windows git has `core.ignorecase=true`: after renaming `Example.txt` to `example.txt` in the work tree,
  `git status --porcelain` prints nothing. A case-only rename is invisible to git there.
- From Codex (not checked again): `fs.renameSync` through an intermediate name performs a case-only rename of a file or
  folder on Windows. On Windows, renaming `a` straight to `A` may be a no-op or fail: always go through an intermediate
  name.
- From AGENTS.md: a registered plugin folder's files and subfolders can be renamed (only its parent is locked);
  `listFiles` reports folders it can't list in `unreadable`; tests simulate unreadable folders by mocking
  `fs.readdirSync` (`unreadable(t, dir)` in `test/materialize.test.js` l.310).
- Junctions are made with `fs.symlinkSync(target, link, 'junction')` (on Linux the type is ignored: a symlink), as
  `test/authoring.test.js` l.373 does.

## Design

### Item 2: case-insensitive comparison in the partial-copy sync

New in `lib/materialize.js`:

```js
// Is the folder `dir` on a case-insensitive filesystem? Compares its stat with the stat of the same path whose last
// part that has a cased letter is spelled with every letter's case swapped: the same file (dev and ino, bigint) is
// case-insensitive, ENOENT or another file is case-sensitive. Cached by resolved path. When `dir` can't be stat'ed or
// no part of it has a cased letter: process.platform is 'win32' or 'darwin' (not cached).
function caseInsensitive(dir)
```

- A part has a cased letter when `part.toLowerCase() !== part.toUpperCase()`. Swap every character: lower -> upper,
  else upper -> lower. Walk the parts of `path.resolve(dir)` from the last one up; never the drive root (`D:\`).
- Cache: a module-level `Map` (`caseCache`, not exported). Export `caseInsensitive`.

Fold: `const lower = (rel) => rel.toLowerCase();`. Inside `syncCopy`, after the first-build block (the copy exists):

```js
const insensitiveSource = caseInsensitive(plugin.dir);
const insensitiveCopy = caseInsensitive(copyRoot);
const fold = insensitiveSource || insensitiveCopy;   // paths that differ only in case are one file
const carry = insensitiveSource && insensitiveCopy;  // a spelling may be carried by a rename
const keyOf = fold ? lower : (rel) => rel;
```

Everything that compares rels in the main part of `syncCopy` compares `keyOf(rel)`:

1. **Side maps.** `src` and `copy` become `Map(key -> { rel, full })` built from the listings. When two listed rels of
   one side have the same key (possible only on a case-sensitive side while `fold` is on), the key goes to `dupKeys`
   and one `skipped` entry is added per rel: `{ rel, reason: 'another file has the same name in another case: left out' }`.
   A dup key is handled like a skipped path (rule 5): nothing touched, record entries kept.
2. **Record.** `baseOf` becomes `Map(key -> { rel, hash })` built from the v2 `m.files` (or the v1 migration / the
   no-record branch, which keep their current logic, then go through the same map). Two record entries with one key:
   keep the first rel in sorted order with hash `''` (unknown) unless both hashes are equal, and `rel: null` so it never
   decides a spelling direction (rule 4). `oldConflictKeys = new Set(m.conflicts.map(keyOf))` (empty without a v2 record).
3. **Excluded prefixes** are compared folded: `excluded(rel)` is
   `prefixes.some((x) => keyOf(rel) === keyOf(x) || keyOf(rel).startsWith(`${keyOf(x)}/`))`. `keyOf` must be a `let`
   that starts as the identity (first build, where source() also runs) and is set after the first-build block.
   `plan.filtered` is looked up through `filteredByKey = new Map([...plan.filtered.keys()].map((n) => [keyOf(n), n]))`.
4. **Skipped entries** are deduplicated by `keyOf(s.rel)` (keep the first, as today), and `isSkipped(key)` is
   `skipped.some((s) => belowFolder(key, keyOf(s.rel))) || dupKeys.has(key)`.
5. **Spelling pass (before the content loop).** Only when `carry` is true. For every key where both `src` and `copy`
   have it, the rels differ, and the key is not excluded, not skipped, not filtered:
   - `b = baseOf.get(key)`; if `b && b.rel === s.rel`: the copy was renamed -> `alignSpelling(plugin.dir, c.rel)`,
     action `{ action: 'renamedInSource', rel: c.rel }`.
   - else if `b && b.rel === c.rel`: the source was renamed -> `alignSpelling(copyRoot, s.rel)`, action
     `{ action: 'renamedInCopy', rel: s.rel }`.
   - else: nothing is renamed; a note (rule 7).
   - `alignSpelling` throws on failure: catch it, push a note
     `{ rel: c.rel, reason: `spelled ${s.rel} in the repository: the rename to match failed (${err.code || err.message})` }`,
     and go on.
   - If at least one rename succeeded, list both sides again (`source()`, `listFiles(copyRoot)`) and rebuild `src`,
     `copy`, `skipped`, `dupKeys` exactly as the first time (wrap steps 1 and 4 in a function called twice).
   When `carry` is false and the rels differ (fold on, one side case-sensitive): a note, nothing renamed.
6. **Content loop** over the sorted union of the keys of `src`, `copy` and `baseOf`, same decisions as today on the
   hashes `s`, `c`, `b` (`b = baseOf.get(key)?.hash`). For a key:
   - display rel `rel = s?.rel ?? c?.rel ?? b.rel` (the source spelling first).
   - write paths: `sPath = path.join(plugin.dir, s ? s.rel : c ? c.rel : rel)`,
     `cPath = path.join(copyRoot, c ? c.rel : s ? s.rel : rel)`. A new file is written in the other side's spelling.
   - `setBase(recordRel, hash)` records under: the source spelling when the source file exists after the action, else
     the copy spelling when the copy file exists, else nothing (no hash). In practice: `toCopy` -> `s.rel`; `toSource`
     with a copy file -> `s ? s.rel : c.rel`; equal -> `s.rel` (or `c.rel`).
   - excluded branch: as today with `cFile = c?.full`, base `baseOf.get(key)?.hash`, display `c.rel`.
   - skipped branch (`isSkipped(key)`): keep `b` as `newBase[b.rel] = b.hash` when the record has the key, and when
     `oldConflictKeys.has(key)` push the stored conflict spelling (the `m.conflicts` entry whose `keyOf` is `key`) to
     `keptConflicts` (item 3).
   - filtered branch: as today, the rel is the repository name `filteredByKey.get(key)`; the copy file is `c?.full`,
     writes go to `path.join(copyRoot, c ? c.rel : name)`. No spelling handling.
7. **Notes.** A new result field `notes: [{ rel, reason }]` (sorted by rel), for spelling differences that were not
   carried. Reason, exactly: `spelled ${s.rel} in the repository and ${c.rel} in the partial copy: rename one of them so
   both match`. Content is still synced (the files are one file).
8. **Record write.** `conflictRels = [...conflicts.map((x) => x.rel), ...keptConflicts]`, sorted; the `unchanged`
   check compares that list. Returned `conflicts` are only the ones found now (kept ones are record-only).

`alignSpelling(root, wantRel)` (new, not exported): makes the on-disk spelling of the existing path `wantRel` below
`root` equal `wantRel`, part by part from the top. For part `i`: `dir = path.join(root, ...parts.slice(0, i))`;
`fs.readdirSync(dir)`; the entries whose `toLowerCase()` equals `parts[i].toLowerCase()`: none or more than one ->
throw `Error('cannot find ' + parts.slice(0, i + 1).join('/'))`; one and equal to `parts[i]` -> next part; else
`renameCase(path.join(dir, actual), path.join(dir, parts[i]))`. `renameCase(from, to)`: `mid = `${from}.team-plugins-case-${process.pid}-${crypto.randomBytes(4).toString('hex')}``;
`fs.renameSync(from, mid)`; then `fs.renameSync(mid, to)`, and if that throws, try `fs.renameSync(mid, from)` (ignore
its error) and rethrow the first error. After a rename of a file call `forget()` on both paths (the hash cache).

`resolveConflict` (fold through `caseInsensitive(copyRoot)`; `keyOf` as above): the conflict is found when
`m.conflicts.some((x) => keyOf(x) === keyOf(rel))`; the new `files` drops every key whose `keyOf` equals `keyOf(rel)`
before setting `files[rel]` (when kept) ; the new conflicts drop every entry whose `keyOf` equals `keyOf(rel)`.
`checkConflictRel` and `conflictVersions` unchanged (the filesystem resolves any spelling).

`markCopySynced` (fold through `caseInsensitive(copy folder)`): `conflictKeys = new Set(conflicts.map(keyOf))`;
`oldByKey = Map(keyOf(rel) -> rel)` of `old`. For each listed file: if its key is in `conflictKeys`, keep the old entry
found through `oldByKey` under **the old spelling** (`newBase[oldRel] = old[oldRel]`); else `newBase[rel] = hash`. The
"conflict not listed" loop and the unreadable loop compare by key (an old entry whose key is already in `newBase`'s keys
is not added again). Conflicts are written as stored.

`extension.js`: `syncPartials` reads `notes` and logs each once per window through `logSkipped`'s key scheme but with
the text `${where}: ${reason}` (new function `logNotes(plugin, notes)` next to `logSkipped`, no dialog). `toSource`
is also true for `renamedInSource`. `logCopyActions` already logs any action.

### Item 3: conflicts below an unreadable folder

Covered by rule 6 (`keptConflicts`) and the folded `markCopySynced`: a conflict whose key is below a skipped or
unreadable folder (or a dup key) stays in the record's `conflicts` until a complete scan judges it; its base stays.

### Item 4: authoring destinations

New in `lib/authoring.js`, exported:

```js
// '' when writing `target` stays inside the repository `repoDir`, else why not. Links are resolved through the deepest
// part of `target` that exists (the target itself when it exists), so a path not created yet is checked too; a link on
// the way that can't be resolved (broken) counts as leading outside.
function destinationError(repoDir, target)
```

- Walk up from `path.resolve(target)` while `!exists(probe)` (the module's `exists`, lstat-based) collecting the
  missing parts. At the existing `probe`: `fs.realpathSync(probe)`; if it throws -> return
  `${shown} leads outside the repository through a link` (a broken link). `real = path.join(realProbe, ...rest)`.
- `shown = path.relative(repoDir, path.resolve(target))` with `/` separators.
- `!inside(realOr(repoDir), real) && path.relative(realOr(repoDir), real) !== ''` -> if
  `inside(path.resolve(repoDir), path.resolve(target))` then `${shown} leads outside the repository through a link`, else
  `${shown} is outside the repository`. (`inside` of `lib/catalog.js` returns true for the root itself.)
- `pluginDirError` keeps its root check first, then returns `destinationError(repoDir, dir)`. Its messages stay
  identical (existing test l.378).

Applied before the first write of each authoring operation (an error is returned as `{ error }` and nothing is written):

| Operation | Paths checked |
| --- | --- |
| `createItem(pluginDir, kind, name, description, repoDir = pluginDir)` | the item file |
| `addMcpServer(pluginDir, name, entry, repoDir = pluginDir)` | the target MCP file |
| `placePlugin` (New plugin, Move to a repository) | `location.marketplace.file` when set, after the folder check |
| `readForRecord(repoDir)` (rename records) | the marketplace file |
| `renameItem` | MCP: every `mcpTargets[].full`; other kinds: `from` and `to` |
| `renamePlugin` | `manifestFile` (when it exists) and `location.marketplace.file` (when set), besides `newDir` |
| `shareItem(item, pluginDir, name, repoDir = pluginDir)` | `dest` |

For `renameItem`/`renamePlugin` the repository is the `repoDir` option; when it is missing (a caller without one),
use `pluginDir` / `plugin.dir`. `extension.js` passes `repo.dir` to `createItem`, `addMcpServer` (l.2477-2478) and
`shareItem` (l.2847; check that `repo` is in scope there, else use the repository object that call site already has).

### Item 5: MCP names in a top-level MCP file

New in `lib/authoring.js`, exported:

```js
// '' when `name` can be a new server key of the parsed MCP file `obj` (named `fileName` in messages), else why not.
// Only a file whose servers are at the top level (no non-empty `mcpServers` object) restricts names.
function topLevelNameError(fileName, obj, name)
```

Order of checks (return the first), only when `!serverTable(obj)`:
1. `name === 'mcpServers'` -> `"mcpServers" can't name a server in ${fileName}: its servers are at the top level, where that key would hold the whole server list`
2. `MCP_METADATA` (`author`, `owner`, `source`, `metadata`, compared lower-cased; export `MCP_METADATA` from
   `lib/catalog.js` if it is not exported) -> `${name} is a reserved key of ${fileName}: pick another name`
3. `Object.prototype.hasOwnProperty.call(obj, name)` -> `${fileName} already has a top-level "${name}": pick another name`

- `addMcpServer`: call it on the target file's object only when the new server goes to the top level (`!useTable`).
- `renameItem` (kind `mcp`): call it for every target `t` whose `serverTable(t.obj)` is null, after the existing
  "already has a server named" check, before any write.

### Item 1: push cleanup guards

In `pushToBranch`, after `const result = ...` and before the reset:

1. `staged = await git(['diff', '--cached', '--name-only', '-z'], repo, 0, { trim: false })`: non-zero exit -> skip
   the reset with `message: `cannot check the staged changes: ${stderr}``, files `[]`. Non-empty output -> skip with
   files = the NUL-separated names, `message: `changes were staged during the push: ${names.join(', ')}``.
2. `diff = await git(['diff', '--name-only', '-z', 'HEAD', '@{u}'], repo, 0, { trim: false })` and
   `ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], repo, 0, { trim: false })`:
   a non-zero exit of either -> skip with `cannot check the ignored files: ${stderr}`. A diff path `p` is hit when an
   ignored entry `e` equals `p`, or `e` ends with `/` and `p.startsWith(e)`. Hits -> skip with files = the hit paths,
   `message: `ignored files would be overwritten by the reset: ${names.join(', ')}``.
3. Skipping: `log(`push to ${branch} done, managed clone left as it is: ${message}`)` and
   `return { ...result, resetSkipped: { files, message } }` (same shape as today's refusal). Factor the skip into a
   small local helper used by the guards and the existing refusal branch.

`extension.js` needs no change: `reportContribution` already words `resetSkipped`.

### Repro script

- In `renameCase`'s comment, remove ", as Explorer does" (Codex only verified `fs.renameSync` through an intermediate
  name).
- In `caseRename`, check after **each** of the two syncs (not only after the second) that both files exist and read
  `baseline` (a small inner function called after each `f.sync()`).

## Impact

- `syncCopy`'s result gains `notes` and the actions `renamedInSource` / `renamedInCopy`: only `syncPartials` reads the
  result (`logCopyActions` logs any action; `toSource` must include `renamedInSource`). Tests that `deepEqual` a whole
  result object, if any, need `notes: []` (check `test/materialize.test.js`).
- Record keys may change spelling after a carried rename; `resolveConflict` and `markCopySynced` match by key, so stale
  rels from the view still resolve.
- `createItem`, `addMcpServer`, `shareItem` gain a trailing optional `repoDir`: existing calls (tests, `extension.js`)
  keep working; `extension.js` passes it.
- `pluginDirError` delegates to `destinationError`: same messages.
- `pushToBranch`: three more git calls before the reset; `test/contribute.test.js` cases that wrap `run` keep working.
  The `remote.test.js` cases use the real `pushToBranch`: they must still pass.
- `MCP_METADATA` export from `lib/catalog.js` (if needed): no other change.

## Not handled (write these in `docs/development.md`'s limits list)

- Case is compared with JavaScript's `toLowerCase`: equal to NTFS for ASCII names, approximate for some other
  characters (two names NTFS treats as one may still read as two).
- Windows git (`core.ignorecase`) does not record a case-only rename: a spelling carried into the clone is not pushed
  (the team keeps the old spelling).
- When only one side is case-insensitive (the repository and the copy on different filesystems), a spelling difference
  is reported in the log, never renamed. A side with two names that differ only in case leaves both out.
- A case rename where each side renamed a different part (folder on one side, file name on the other) is reported, not
  merged.

## Tests

Use the existing helpers (`setupCopy`, `unreadable`, `makeConflict`, `C`/`S` readers of `test/materialize.test.js`).
Case-only renames go through an intermediate name (a local `renameCase(from, to)` helper in the test file). The
case-insensitive tests run only when `caseInsensitive(f.root)` is true (else `t.skip('case-sensitive filesystem')`);
the case-sensitive test only when it is false (Linux CI runs it).

`test/materialize.test.js`, new cases (each "after each sync" means: assert after the first and after the second
`syncCopy`):

1. `caseInsensitive` is true for a temp folder on Windows, and false for a folder of a case-sensitive filesystem (run
   the half that applies: `process.platform === 'win32'` -> true; `linux` -> false).
2. Copy file renamed `rules/x.mdc` -> `rules/X.mdc` (the copy's spelling): after each sync both files exist with their
   original content; after the first, the repository file is spelled `X.mdc` (`fs.readdirSync(f.src('rules'))`
   includes `X.mdc`, not `x.mdc`), the action list holds `{ action: 'renamedInSource', rel: 'rules/X.mdc' }`, and the
   record's keys hold `rules/X.mdc` and not `rules/x.mdc`; the second sync has no action.
3. Copy folder renamed `rules` -> `Rules`: after each sync both sides keep `x.mdc` with its content; the repository
   folder is spelled `Rules` after the first.
4. Repository file renamed `rules/x.mdc` -> `rules/X.mdc` (a teammate's rename): after each sync both exist with their
   content; the copy is spelled `X.mdc` after the first (`renamedInCopy`).
5. Unreadable variant: copy folder `rules` renamed `Rules`, then `unreadable(t, f.cp('Rules'))`: the repository file
   and the copy file keep their content, `skipped` has `{ rel: 'Rules', unreadable: true, ... }`, the record still has
   `rules/x.mdc` with the same hash; after `t.mock.restoreAll()` a sync carries the spelling and deletes nothing.
6. Both sides renamed differently (copy `Rules/x.mdc`, repository `rules/X.mdc`, record `rules/x.mdc`): nothing is
   renamed, both files keep their content, `notes` has one entry whose reason is
   `spelled rules/X.mdc in the repository and Rules/x.mdc in the partial copy: rename one of them so both match`.
7. Content and spelling at once: copy renamed `rules/X.mdc` and edited: the repository file is spelled `X.mdc` and has
   the edit.
8. Case-sensitive only: the selected skill folder holds `skills/a/n.txt` (`'lower'`) and `skills/a/N.txt`
   (`'upper'`), written before `setupCopy`'s first sync: after each of two syncs both exist in the copy as two files
   with their own content, no `notes`, no `skipped`; an edit of `N.txt` in the copy reaches only `N.txt` in the
   repository.
9. Item 3: a conflict on `SKILL_A`, then a sync with `unreadable(t, f.src('skills'))`: the record's `conflicts` still
   holds `SKILL_A`; after `t.mock.restoreAll()`, the repository file set to a new team version and `markCopySynced`,
   a sync keeps the copy's edit and reports the conflict again. (Same as repro `unreadable-conflict`.)
10. Item 3 with case (Codex): a conflict on `rules/x.mdc`, copy folder renamed `Rules` (case only), a sync with the
    repository's `rules` unreadable, then the repository set to a team version, `markCopySynced`, a sync: the copy's
    edit is kept and the conflict is reported again.
11. Record keys changed (Codex): a conflict on `rules/x.mdc`; rewrite the record so its `files` and `conflicts` spell
    it `rules/X.mdc` (edit the JSON); `conflictVersions` + `resolveConflict(..., 'rules/x.mdc', 'source', shown)`
    resolves it (the action, the copy holds the repository version, the record has one entry for the key and no
    conflict). The same for `'copy'` in a second test.
12. Excluded prefix in another case: create `skills/B/SKILL.md` in the copy (skill `b` is not selected; the folder
    name differs only in case): it never reaches the repository (`excluded` matches folded), the repository's
    `skills/b/SKILL.md` keeps its content, and `skipped` reports it as `not in the selection: never copied to the
    repository`. (On Windows the copy's `skills` folder holds only `a`, so `skills/B` is a new folder.)

`test/contribute.test.js` (use `writeAfterPush`):

13. Ignored file: the clone deletes tracked `g.md` and adds `.gitignore` with `g.md` (both pushed in the commit);
    during the push `g.md` is written again (`'mine\n'`): `resetSkipped.files` is `['g.md']`, the message includes
    `ignored files would be overwritten`, `g.md` still reads `'mine\n'`, HEAD is the pushed commit.
14. Staged change: during the push, write `g.md` = `'staged\n'`, `git add g.md`, write `g.md` back to its committed
    content: `resetSkipped.files` is `['g.md']`, `git show :g.md` is `staged`, HEAD is the pushed commit.
15. Existing `pushToBranch keeps an edit and a new file saved during the push` still has no `resetSkipped`.

`test/authoring.test.js`:

16. `destinationError`: `''` for a new path inside; a junction `repo/commands` -> outside: `'commands/new.md leads
    outside the repository through a link'` for `repo/commands/new.md`; `'../x is outside the repository'`; a broken
    link `repo/gone` (junction to a folder then removed) -> `gone/x leads outside the repository through a link`
    (skip that half if the platform keeps no broken junction).
17. `createItem` with `commands` a junction outside (repoDir = the repository): `{ error: 'p/commands/new.md leads
    outside the repository through a link' }` (shown relative to repoDir) and nothing is created outside.
18. `addMcpServer` with `mcp.json` a file symlink outside (skip when `fs.symlinkSync` of a file fails with EPERM):
    error, outside file unchanged.
19. `createPlugin` with `.cursor-plugin` a junction to an outside folder holding `marketplace.json` `{"plugins":[]}`:
    error naming `.cursor-plugin/marketplace.json`, the outside file unchanged, no plugin folder created.
20. `movePlugin` with the same outside marketplace: error, the draft still exists.
21. `addMcpServer` top-level file `{ // keep this comment \n "lint": {...}, "notes": "keep me" }`: `notes` ->
    `{ error: 'mcp.json already has a top-level "notes": pick another name' }`, file unchanged; `mcpServers` -> the
    error of rule 1; `author` -> rule 2; a new name `other` still works and keeps the comment.
22. A table file (`{ "mcpServers": { "lint": {...} }, "notes": "x" }`): adding `notes` works (it goes in the table).

`test/rename.test.js`:

23. Rename server `lint` to `mcpServers` in a top-level file: the rule 1 error, file unchanged.
24. Rename `lint` to `notes` where `notes` is a top-level string: the rule 3 error, file unchanged.
25. `renameItem` of a command whose `commands` folder is a junction outside: error, nothing renamed outside.
26. A rename with `record` where `.cursor-plugin` is a junction outside: error, outside marketplace unchanged.

`test/share.test.js`:

27. `shareItem` into a plugin whose `rules` folder is a junction outside: error, nothing written outside.

Existing tests affected: `pluginDirError` (messages unchanged), every `syncCopy` test (must still pass; add
`notes: []` only where a test compares a whole result).

## Keep in step

- `docs/development.md`:
  - The partial-copy paragraph (l.126-135): add that on a case-insensitive filesystem (`caseInsensitive`: stat of a
    case-swapped spelling) paths that differ only in case are one file everywhere (file loop, record, skipped and
    unreadable folders, excluded prefixes, conflicts); a spelling difference is carried by a rename through an
    intermediate name in the direction the record tells (the side whose spelling differs from the record's was
    renamed), else logged; conflicts below an unreadable folder stay in the record until a complete scan.
  - The Push to a branch paragraph (l.171-175): before the reset, the clone is left as it is when a change is staged or
    when one of the paths the reset would change is an ignored file.
  - The authoring containment paragraph (l.223-228): `destinationError` checks every authoring destination (table of
    Item 4 in one sentence), `pluginDirError` uses it.
  - The MCP paragraph (l.230-): `topLevelNameError` and its three refusals.
  - Limits list (near l.484-515): the four lines of **Not handled**.
- `README.md`:
  - l.279-280 (New plugin): replace with: "Nothing is ever written outside the repository: a destination that leads
    outside it (a `..` in `metadata.pluginRoot`, or a link to another folder or file) is refused before anything is
    written." and move it to a line that applies to every writing command (keep it in the **Writing plugins** list,
    e.g. as the last bullet).
  - The **New MCP server** text (l.309-): one sentence: in an `mcp.json` that lists its servers at the top level
    (without `mcpServers`), the name `mcpServers`, the metadata keys and a key the file already has are refused (Rename
    too).
  - The partial-copy paragraph (l.250-256): "Renaming a file or folder only in case (`readme.md` -> `README.md`) is
    carried to the other side, never read as a deletion."
  - l.233-235 (Push to a branch): "...if one changed a file of the pushed commit, or a change was staged or an ignored
    file would be overwritten, the clone is left as it is..."
- `AGENTS.md`: the `materialize` line of **Layout** gains `caseInsensitive`; the `authoring` line gains
  `destinationError`, `topLevelNameError`. In **Why the code is shaped this way**, one bullet: "Windows git
  (`core.ignorecase`) ignores a case-only rename and NTFS resolves any spelling: `syncCopy` compares paths by
  `toLowerCase` when a side is case-insensitive (`caseInsensitive`, stat of a case-swapped spelling) and carries a
  spelling with a rename through an intermediate name (a direct `a` -> `A` rename is unreliable on Windows)."
- `.claude/implement.md`: nothing.
- `package.json`: nothing.

## Commands

```
node --check extension.js
node scripts/test.js
biome lint --error-on-warnings extension.js lib scripts test
python requests/done/25-sync-and-authoring-safety.repro.py
```

All must pass (the repro prints `PASS` for the 11 cases on Windows).

## Changes after review

- The content loop sorts keys by their displayed rel (case-sensitive), not by the lower-cased key, so existing tests
  keep their action order. Ambiguous record entries are `{ rel, hash, ambiguous }`. The keys of stored conflicts join
  the loop, so a conflict without a record hash survives below an unreadable folder.
- Test 1 compares `caseInsensitive` with what the folder does (a file written in one case found in the other) instead
  of expecting an answer per platform: a Windows folder can be case-sensitive. Tests 1 and 8 were run on Windows in a
  folder made case-sensitive with `fsutil.exe file setCaseSensitiveInfo` (`TEMP` pointed there): both pass.
- Test 16's broken-link half skips explicitly when the platform keeps no broken link.
- `logNotes` is also called in the apply's `syncOne`, beside `syncPartials`.
- Codex's review of the first version found six defects, fixed with a regression test each (all six fail on that
  version):
  - `caseInsensitive` probed the folder's own name, which tests its parent's rule: it now looks up an entry inside the
    folder in swapped case (the parent's probe only for an empty or unreadable folder, not cached).
  - With a case-insensitive repository and a case-sensitive copy, `conflictVersions` / `resolveConflict` joined one
    spelling onto both folders and saw the copy file as missing (Keep copy version deleted the repository file): each
    side is now found as spelled on that side (`findPath`, folded per part, exact spelling first).
  - In the same setup `markCopySynced` folded by the copy's rule only and marked a conflicting copy file synced: the
    record now holds `foldCase: true` when the sync folded, and `markCopySynced` and `resolveConflict` follow it.
  - The first build copied two source names that differ only in case into one copy file: it now leaves both out and
    reports them, as later syncs do.
  - Rename of a skill rewrote a `SKILL.md` that is a link to outside: `from/SKILL.md` is checked too.
  - The push guard missed an ignored folder at the path of a file the reset restores (`cache/` vs `cache`).
- Codex's second review (of `a48979f`) found four more cases; three are fixed with a regression test each (all fail on
  that version), and the user decided the fourth is out of scope:
  - `findPath` took the exact-spelling folder when a case-sensitive copy held both `assets/` and `Assets/`, missed the
    file under the other and read it as deleted (Keep copy version deleted the repository file): several matches now
    throw, so the conflict can't be resolved from the view instead of being guessed.
  - With a case-sensitive repository holding `skills/UP` and `skills/up` and a case-insensitive copy, the folded
    exclusion of `up` also matched the selected `UP` and deleted it from the copy: an excluded prefix that a selected
    one matches without case is compared by its exact spelling.
  - The push guard missed an ignored file above a path the reset restores (`cache` for `cache/item.txt`) and compared
    with case where git does not (`core.ignorecase`): both are handled.
  - Not handled (user's decision, 2026-11-28): a folder inside a repository or the storage whose case rule differs from
    its root's. It takes a deliberate per-folder setting on Windows; the assumption is written in
    `docs/development.md`'s limits.
- Codex's third review (of `ac47d0e`) found four cases; by the user's decision two are fixed with a regression test each
  (both fail on that version) and two are written down as limits, and the review rounds end there:
  - `findPath` read a copy folder it could not list as missing, so Keep copy version could delete the repository file:
    only `ENOENT`/`ENOTDIR` count as missing now, any other listing error throws.
  - The push guard folded only on `core.ignorecase`: it also folds when the clone's folder looks names up without case
    (`caseInsensitive`), so an overridden `core.ignorecase=false` no longer hides `Saved.txt` vs `saved.txt`.
  - Limits, not handled: a non-item folder named like an excluded item in another case is left out of the copy with
    it; a file and a folder whose names differ only in case make the first build fail (logged, nothing lost).
- Codex's fourth review (of `7459b14`) found one more case, from request 19 and fixed here with the user's OK:
  `conflictVersions` and `resolveConflict` used `fs.existsSync`, which reads an access-denied file as absent, so Keep
  copy version could delete the repository file. A side is absent only on `ENOENT`/`ENOTDIR` (any other error stops
  the choice), and `resolveConflict` copies or deletes from the versions it just checked. Regression test: "a conflict
  side that can not be read is never taken for a deletion" (fails on `7459b14`). The review rounds end here.
- Archived in `requests/done/`: the repro script finds the repository root as the nearest folder above it holding
  `package.json`, so it runs from there too.

## Don't

- No commit, no branch switch, no stash.
- Don't edit `requests/25-sync-and-authoring-safety.md` or this plan. The repro script edits listed above are yours.
- Never touch `D:/git/cursor-team-plugins-codex` or any path outside this repository except temp folders.
- No new dependency, no TypeScript, no bundler. Nothing under `lib/` requires `vscode`.
- Edit files with your edit tools, not scripts that rewrite them.
- Don't run `cursor --install-extension` or launch Cursor.
- Report any change outside the files listed here.
