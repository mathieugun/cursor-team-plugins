# Plan 19: sync and push never discard work they did not check

## Context

- Repository: cursor-team-plugins, branch `request/19-no-silent-data-loss`. Request: `requests/19-no-silent-data-loss.md`.
  Version stays `0.8.6` (bumped at release only).
- Files and functions:
  - `lib/materialize.js`: `listFiles` (L30-85), `syncCopy` (L290-494, `source()` L297-306, `isSkipped` L352,
    the decision loop L379-481), `resolveConflict` (L498-531), `markCopySynced` (L536-564), `module.exports` (L599).
  - `lib/contribute.js`: `pushToBranch` (L123-190), the post-push cleanup L175-188.
  - `extension.js`: `logSkipped` (L835-843), `resetPartialCopies` (L1523-1534, keep it: Discard still uses it at
    L3069), `resolveConflictCommand` (L3168-3211), `reportContribution` case `pushedBranch` (L3236-3270),
    `pushToBranchCommand` (L3439-3491, the `resetPartialCopies(d.key)` call at L3483-3485).
  - Tests: `test/materialize.test.js`, `test/contribute.test.js`.

## Measured facts (don't measure them again)

- Baseline: `scripts/test.js` with Cursor's runtime: 349 tests, 347 pass, 2 skipped, 0 fail (2026-11-28, on `main`
  at `266d9ae`).
- `git reset --keep @{u}` after a commit `work` (changed `a`, added `new`) on top of `@{u}` (probe in a scratch
  repository, Git for Windows, 2026-11-28):
  - clean worktree: exit 0, `a` back to the team content, `new` removed, `git status` empty.
  - `b` (not in the commit) edited and `later` created after the commit: exit 0, `a` reverted, `b` keeps its edit
    (` M b`), `later` stays (`?? later`).
  - a staged edit of `b`: exit 0, kept as an unstaged edit (` M b`).
  - `a` (in the commit) edited again after the commit: exit 128, stderr
    `error: Entry 'a' not uptodate. Cannot merge.` / `fatal: Could not reset index file to revision '@{u}'.`;
    HEAD still `work`, `a` keeps the new edit: nothing changed.
  - `new` (added by the commit) edited after the commit: exit 128, `error: Entry 'new' not uptodate. Cannot merge.`,
    nothing changed.
  - `new` deleted after the commit: exit 0 (the target state is "absent" anyway).
  - the commit deleted `u`, then `u` was created again untracked: exit 128,
    `error: Untracked working tree file 'u' would be overwritten by merge.`, nothing changed, `u` keeps its content.
- `clean -fd` is not needed after `reset --keep`: `commitAll` runs `git add -A` before the commit, so every untracked
  (not ignored) file of that moment is in the commit; an untracked file after the commit was created after it.
- The `markCopySynced` call after Push to a branch dates from 0.2.0 (commit `4950473`), when the copy sync compared
  mtimes with a v1 record (`files: [rel]`, no hashes). Since the v2 record (content hash per file), a file the push
  carried is equal to its record entry in the copy (`flushPartials` synced it before the commit), so the next `syncCopy`
  sees `c === b`, `s !== b` and takes the team version (`toCopy` / `deletedInCopy`) without `markCopySynced`. A copy
  edit made after the commit has `c !== b`: without `markCopySynced` it becomes `toSource` (clone file untouched by
  the push) or a conflict (clone file reset), never lost; with `markCopySynced` its hash becomes the base and the
  next sync overwrites it with the team version (reasoned from `syncCopy`'s decision table, L464-480; the tests below
  check it).
- `listFiles` returns an empty listing for a folder whose `readdirSync` throws (L36-40): the review reproduced a
  `deletedInSource` with a simulated `EACCES` (from the review, reproduced again by the failing tests below).
- `fs` is one shared module object: `t.mock.method(fs, 'readdirSync', ...)` in a test reaches `lib/materialize.js`'s
  calls (`test/authoring.test.js:303` mocks `fs.rmSync` the same way).
- From the project notes, not checked again: `extension.js` is not covered by the tests (check with
  `node --check`); the `ui` object (L60-80) wraps every dialog; `scripts/test.js` lists the test files explicitly.

## Design

### 1. A folder that can't be listed never decides a deletion

`listFiles(dir, { root })` returns `{ files, skipped, unreadable }`. `unreadable` is `[{ rel, code }]`: every folder
whose `readdirSync` throws, whatever the error, the start folder itself included (`rel: ''`), and a followed link
folder (its `rel` is the link's). `code` is `err.code || err.message`. The walk of that folder stops there (as today);
nothing else changes in `listFiles`.

`syncCopy`:
- `source()` adds the repository side's unreadable folders to its `skipped`, as
  `{ rel, reason: \`folder can't be read in the repository (${code})\`, unreadable: true }`, with the same
  `!excluded(s.rel)` filter as the links (no warning for unselected parts). The copy side's unreadable folders join
  `copyListed.skipped` as `{ rel, reason: \`folder can't be read in the partial copy (${code})\`, unreadable: true }`.
  Both go through the existing `skippedByRel` merge (first one per `rel` wins, repository first) and the sort.
- `isSkipped(rel)` also matches an entry whose `rel` is `''` (the whole plugin folder):
  `skipped.some((s) => s.rel === '' || rel === s.rel || rel.startsWith(\`${s.rel}/\`))`. Links never have `rel ''`.
- Nothing else changes: the existing `isSkipped` branch already leaves both sides untouched and keeps the record's
  entry. So a file below an unreadable folder on either side is never copied, deleted or rewritten, and its record
  entry stays; once the folder reads again, the next sync decides as usual.
- The first build (copy folder missing, L309-338) returns `listed.skipped`, which now holds the repository's unreadable
  folders too. No other change there.
- Consequence (wanted): a plugin folder missing in the repository (deleted by a sync while the catalog is still the old
  one) reads as `rel ''` unreadable (`ENOENT`): the copy is left as it is instead of being emptied.

`markCopySynced(holderDir)`: list the copy with `listFiles` (keep the whole result). After building `newBase` as today,
add back every entry of the old record that is below one of the copy's unreadable folders and not in `newBase`
(`u.rel === '' || rel === u.rel || rel.startsWith(\`${u.rel}/\`)`). Return value unchanged.

Update the comments above `listFiles` and `syncCopy` (one line each: unreadable folders are reported and nothing
below them is decided).

### 2. A conflict choice is applied only to the versions the user was shown

New export `conflictVersions(plugin, holderDir, rel)` in `lib/materialize.js`: `{ source, copy }`, each the sha1 (hex)
of that side's file (`hashFile`) or `null` when the file does not exist (`fs.existsSync`). Same `rel` validation as
`resolveConflict` (throw `invalid conflict file`). Paths: `path.join(plugin.dir, rel)` and
`path.join(copyRootOf(plugin, holderDir), rel)`.

`resolveConflict(plugin, includedIds, holderDir, rel, keep, shown)`: `shown` is required, `{ source, copy }` as
returned by `conflictVersions`. Order of checks:
1. `rel` invalid -> throw `invalid conflict file` (as today); `keep` invalid -> throw (as today); `shown` not an
   object with both keys `source` and `copy` (each a string or `null`) -> throw `the versions shown are missing`.
2. Record missing or not v2 -> throw `the partial copy has no sync record` (as today).
3. `rel` not in `m.conflicts` -> return `{ changed: true, rel }`, nothing written.
4. `conflictVersions(...)` now differs from `shown` on either side -> return `{ changed: true, rel }`, nothing written
   (the record is not rewritten either).
5. Otherwise as today; returns `{ action, rel }`.

`extension.js` `resolveConflictCommand(node, keep)`:
- Before the modal: find the entry (`[...partialCopies.values()].find((e) => e.holder === node.holder)`); none ->
  `log(\`conflict no longer tracked: ${node.rel}\`)` and return (as today, only earlier). Then
  `shown = conflictVersions(entry.plugin, entry.holder, node.rel)` in a `try`; on error
  `ui.showErrorMessage(\`Team plugins: ${err.message}\`)` and return.
- Then the modal as today. In the queued task: look the entry up again (as today), the cached-list check (as today),
  the lock, `resolveConflict(entry.plugin, entry.ids, entry.holder, node.rel, keep, shown)`.
- A `{ changed: true }` result: `ui.showWarningMessage(\`Team plugins: ${node.plugin}/${node.rel} changed since you
  chose (another window resolved it, or a side was edited again): nothing was replaced.\`)`, then `await syncPartials()`
  (it re-reads the conflicts and refreshes the view and status), and return. Otherwise as today.

### 3. Push to a branch keeps what was saved during the push

`lib/contribute.js` `pushToBranch`, after the successful push and `pullRequestPage`:
- `pushed = rev-parse HEAD` (as today), then `const reset = await git(['reset', '--keep', '@{u}'], repo)`. No
  `clean`.
- `reset.code === 0`: write the state `{ kind: 'upToDate', head }` (head = `rev-parse HEAD`) and return as today:
  `{ kind: 'pushedBranch', branch, remote, head: pushed, target: up.branch, pullRequest }`.
- Otherwise: do not write the state; `log(\`push to ${branch} done, managed clone left as it is: ${reset.stderr}\`)`
  and return the same object plus `resetSkipped: { files, message: reset.stderr }`, where `files` are the names
  captured from `reset.stderr` by `/^error: Entry '(.+)' not uptodate\. Cannot merge\.$/gm` and
  `/^error: Untracked working tree file '(.+)' would be overwritten by merge\.$/gm`, in the order of the stderr lines,
  without duplicates (`[]` when none match, for example a git in another language). The `kind: 'error', step: 'reset'`
  result goes away: the push succeeded, so a failed cleanup is never an error result.
- Update the comment above `pushToBranch`: the clone goes back to the team version keeping the changes saved after the
  commit; when one of them is on a file of the pushed commit, the clone is left as it is (`resetSkipped`).

`extension.js`:
- `pushToBranchCommand`: remove the `if (r.kind === 'pushedBranch') { resetPartialCopies(d.key); }` block (the
  queued function then just returns `r`; simplify it to `() => vscode.window.withProgress(..., () => contribute.pushToBranch({...}))`
  or keep the `async` body returning the call, either is fine). `resetPartialCopies` and its comment stay for Discard;
  change its comment's "(discard, push to a branch)" to "(discard)".
- `reportContribution`, case `pushedBranch`: compute
  - `const skipped = result.resetSkipped;`
  - `const what = skipped && skipped.files.length > 0 ? skipped.files.join(', ') : 'files';`
  - `const back = skipped ? \`The managed clone was left as it is because ${what} changed during the push: it still holds the pushed commit and those edits (push to a branch again, or discard them, when you are ready).\` : 'The managed clone is back on the team version.';`
  and use `${back}` in place of the sentence `The managed clone is back on the team version.` in the three texts. When
  `skipped`, show the message with `ui.showWarningMessage` instead of `ui.showInformationMessage` (same buttons, same
  `.then` handler).

## Impact

- `listFiles` has three callers, all in `lib/materialize.js` (`source()`, the copy listing in `syncCopy`,
  `markCopySynced`): all handled above. No other module uses it.
- `syncCopy`'s `skipped` entries reach `extension.js` `logSkipped` (L835) from `doApply`'s `syncOne` (L694) and
  `syncPartials` (L1479). `logSkipped` must also warn the user for `unreadable` entries:
  in its `if (!loggedWarnings.has(key))` branch, after the `log(...)`, when `s.unreadable`:
  `ui.showWarningMessage(\`Team plugins: ${s.rel ? \`${plugin.name}/${s.rel}\` : plugin.name}: ${s.reason}. Its files are not synced until it can be read again.\`)`.
  Change the log line's path the same way (`s.rel ? ... : plugin.name`) so `rel ''` doesn't print a trailing `/`.
  Update the comment above `logSkipped` ("links that are not followed, and folders that can't be read").
- `resolveConflict` has one caller (`resolveConflictCommand`) besides tests: handled. Its new required parameter
  changes the existing tests' calls (see Tests).
- `pushToBranch`'s result: `reportContribution` (handled) and the live scenario `test/live/pull-request.live.js`, which
  checks the buttons and the branch, not the "back on the team version" sentence: no change needed there. Nothing
  reads `step: 'reset'` (grep: only `lib/contribute.js:182`).
- `markCopySynced` after this change is called only by Discard (`resetPartialCopies` L3069): its behaviour for readable
  folders is unchanged.
- `commitAndPush` is unchanged (it never resets).

## Not handled

- A file (not a folder) that can't be read: `hashFile` throws, `syncCopy` throws, the callers log
  `cannot sync the partial copy of ...` as today.
- A copy edit made between Discard's confirmation and its reset (Discard means discard; `markCopySynced` stays there).
- An edit made while the `git reset --keep` command itself runs.
- The warning for an unreadable folder shows once per folder and reason per window (the `loggedWarnings` key), not
  again after it recovers and fails later.
- Write these in `docs/development.md` under the limits (the list that holds "A conflict between a partial copy and
  the repository is not merged line by line", ~L449): one bullet for the first two, one line each, plain.

## Tests

Write the new tests first and run them on the unchanged code: each one marked **(fails on main)** must fail there.
Report the failures you saw (test name and the assertion) in your report.

`test/materialize.test.js` (use `setupCopy`, `makeConflict`, `S`, `C`; a helper for the injected error):

```js
// readdirSync throws `code` for the folder `dir` (compared resolved, case-insensitive on Windows)
function unreadable(t, dir, code = 'EACCES') {
  const real = fs.readdirSync;
  const key = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  t.mock.method(fs, 'readdirSync', (p, ...rest) => {
    if (key(p) === key(dir)) {
      throw Object.assign(new Error(`${code}: cannot read ${p}`), { code });
    }
    return real.call(fs, p, ...rest);
  });
}
```

1. **(fails on main)** `an unreadable folder of the copy deletes nothing in the repository`: `setupCopy`; record
   `before = f.manifest().files`; `unreadable(t, f.cp('skills'))`; `r = syncCopy(...)` -> `r.actions` `[]`,
   `fs.existsSync(f.src(SKILL_A))` true, `r.skipped` contains
   `{ rel: 'skills', reason: "folder can't be read in the partial copy (EACCES)", unreadable: true }`,
   `f.manifest().files[SKILL_A] === before[SKILL_A]`. Then `t.mock.restoreAll()`; `syncCopy` again -> actions `[]`,
   conflicts `[]`, the record still has `SKILL_A` with the same hash.
2. **(fails on main)** `an unreadable folder of the repository deletes nothing in the copy`: same with
   `f.src('skills')` -> actions `[]`, `fs.existsSync(f.cp(SKILL_A))` true, skipped has
   `{ rel: 'skills', reason: "folder can't be read in the repository (EACCES)", unreadable: true }`; after restore,
   syncCopy -> actions `[]`.
3. **(fails on main)** `an unreadable copy folder keeps everything`: `unreadable(t, f.copyRoot)` -> actions `[]`, every
   path of `FOUR` still exists in the repository, `r.skipped` deep-equals
   `[{ rel: '', reason: "folder can't be read in the partial copy (EACCES)", unreadable: true }]`, record unchanged
   (`deepEqual(f.manifest().files, before)`).
4. **(fails on main)** `a plugin folder gone from the repository empties nothing`: `removeTree(f.plugin.dir)` ->
   `syncCopy` -> actions `[]`, every path of `FOUR` still exists in the copy, `r.skipped[0]` is
   `{ rel: '', reason: "folder can't be read in the repository (ENOENT)", unreadable: true }`.
5. An edit below an unreadable folder waits: `setupCopy`; write `f.cp(SKILL_A)` = `'agent'`;
   `unreadable(t, f.cp('skills'))`; syncCopy -> `S(f, SKILL_A)` unchanged (the original content); restore; syncCopy ->
   actions `[{ action: 'toSource', rel: SKILL_A }]`, `S(f, SKILL_A) === 'agent'`.
6. **(fails on main)** `markCopySynced keeps the record below an unreadable folder`: `setupCopy`; `before =
   f.manifest().files[SKILL_A]`; `unreadable(t, f.cp('skills'))`; `markCopySynced(f.holder)` -> true;
   `f.manifest().files[SKILL_A] === before`.
7. `conflictVersions`: `setupCopy`; `makeConflict(f)` -> `conflictVersions(f.plugin, f.holder, SKILL_A)` deep-equals
   `{ source: sha1('team'), copy: sha1('agent') }` (`crypto.createHash('sha1').update(x).digest('hex')`); after
   `fs.rmSync(f.cp(SKILL_A))` -> `copy: null`; `'../x'` throws.
8. **(fails on main)** `a stale conflict choice changes nothing` (the review's case): `makeConflict(f)`;
   `shown = conflictVersions(f.plugin, f.holder, SKILL_A)`; window A: `resolveConflict(..., SKILL_A, 'source', shown)`
   -> `{ action: 'toCopy', rel: SKILL_A }`; then `fs.writeFileSync(f.src(SKILL_A), 'newer')`; window B:
   `resolveConflict(..., SKILL_A, 'copy', shown)` -> `{ changed: true, rel: SKILL_A }`; `S(f, SKILL_A) === 'newer'`,
   `C(f, SKILL_A) === 'team'`.
9. **(fails on main)** `a side edited after the choice was offered changes nothing`: `makeConflict(f)`; `shown`; write
   `f.cp(SKILL_A)` = `'agent2'`; `resolveConflict(..., 'source', shown)` -> `{ changed: true, rel: SKILL_A }`;
   `C(f, SKILL_A) === 'agent2'`, `S(f, SKILL_A) === 'team'`, `f.manifest().conflicts` deep-equals `[SKILL_A]`.
10. `resolveConflict without the versions shown throws`: `makeConflict(f)`;
    `assert.throws(() => resolveConflict(f.plugin, f.ids, f.holder, SKILL_A, 'source'))`.
11. Existing tests `resolveConflict keeps the repository version`, `... keeps the copy version`, `... with the kept side
    deleted deletes the other`: pass `conflictVersions(f.plugin, f.holder, <rel>)` taken right before the call (reason:
    new required parameter); expectations unchanged. The two `assert.throws` lines there stay valid (they throw on
    `rel`/`keep` before `shown` is looked at; pass `shown` anyway).
12. `a copy edit made after a push to a branch is not lost` (the partial-copy side, no git needed): `setupCopy`;
    `fs.writeFileSync(f.cp('rules/x.mdc'), 'during push')` (not synced); simulate the reset of the clone by writing
    `f.src(SKILL_A)` = `'team version'` (a pushed file going back); without calling `markCopySynced`,
    `syncCopy` -> `C(f, SKILL_A) === 'team version'` (the pushed file takes the team version),
    `S(f, 'rules/x.mdc') === 'during push'` (the later edit reaches the clone), conflicts `[]`. This documents why
    `pushToBranchCommand` no longer calls `resetPartialCopies`.

`test/contribute.test.js` (use `setup`, `withLine`, `EIGHT`; skip without git like the other tests). A run that writes
into the clone right after the network push:

```js
// f.run, plus `after()` once the first successful `push` returns
function writeAfterPush(f, after) {
  let done = false;
  return async (args, cwd, timeoutMs, opts) => {
    const r = await f.run(args, cwd, timeoutMs, opts);
    if (!done && args[0] === 'push' && r.code === 0) {
      done = true;
      after();
    }
    return r;
  };
}
```

13. **(fails on main)** `pushToBranch keeps an edit and a new file saved during the push`: `writeFile(f.clone, 'f.md',
    withLine(1, 'mine'))`; `run = writeAfterPush(f, () => { writeFile(f.clone, 'g.md', 'later\n');
    writeFile(f.clone, 'new.md', 'new\n'); })`; `r = await pushToBranch({ ...f.args, run, message: 'mine', branch:
    'team-plugins/t3' })` -> `r.kind === 'pushedBranch'`, `r.resetSkipped === undefined`; clone `f.md` === `EIGHT`;
    `g.md` === `'later\n'`; `new.md` === `'new\n'`; `HEAD` equals `@{u}`; `git status --porcelain` lines, each
    trimmed, sorted, deep-equal `['?? new.md', 'M g.md']` (`helpers.git` trims its output, so the first line's leading
    space is gone: compare trimmed lines); the branch on the origin has `f.md` line 1 `mine` and no `new.md`
    (`git ls-tree --name-only team-plugins/t3` in the origin lists `f.md` and `g.md` only).
14. **(fails on main)** `pushToBranch leaves the clone as it is when a pushed file changed during the push`:
    `writeFile(f.clone, 'f.md', withLine(1, 'mine'))`; `run = writeAfterPush(f, () => writeFile(f.clone, 'f.md',
    withLine(1, 'again')))`; `r` -> `r.kind === 'pushedBranch'`, `r.resetSkipped.files` deep-equals `['f.md']`,
    `r.resetSkipped.message` includes `f.md`; clone `f.md` === `withLine(1, 'again')`; clone `HEAD` === `r.head`; the
    branch on the origin has line 1 `mine`.
15. **(fails on main)** `pushToBranch leaves the clone as it is when a new file would be overwritten`: `fs.rmSync(
    path.join(f.clone, 'g.md'))` (the commit deletes it); `run = writeAfterPush(f, () => writeFile(f.clone, 'g.md',
    'mine\n'))`; `r.resetSkipped.files` deep-equals `['g.md']`; clone `g.md` === `'mine\n'`.
16. The existing `pushToBranch gets out of a conflict` must pass unchanged (clean worktree after the push: same result
    as before, state `upToDate`).

## Keep in step

- `README.md`, the **Push to a branch** bullet (~L233): after "and puts the clone back on the team version" add
  "(edits saved during the push stay as local changes; if one changed a file of the pushed commit, the clone is left
  as it is and the message says so)". The partial-copy paragraph (~L249-252): append "A choice is applied only if
  neither version changed since you chose; otherwise nothing is replaced and you are told." and a sentence "A folder
  that can't be read is left alone on both sides, with a warning, until it can be read again."
- `docs/development.md`:
  - the copy/clone sync bullet (~L119-123): add "A folder whose listing fails (either side, any error, the plugin
    folder itself included: a plugin folder deleted while the catalog is still the old one) is reported and nothing
    below it is copied, deleted or rewritten; its record entries stay until a complete listing (`listFiles`'s
    `unreadable`)." and "A conflict is resolved only if it is still in the record and both sides still hash to what the
    dialog showed (`conflictVersions`, taken before the dialog; `resolveConflict` checks under the lock)."
  - the Push to a branch bullet (~L160): add first "Push to a branch commits, pushes, then runs `git reset --keep @{u}`:
    it undoes only what the pushed commit changed and keeps edits saved after the commit; it refuses (and changes
    nothing) when one of them is on a file of the pushed commit or a new file would be overwritten, and the result
    carries `resetSkipped`. The partial copies are not marked synced afterwards (only Discard does): a pushed file
    equals its record entry and takes the team version, a later copy edit becomes a local change or a conflict."
  - the limits list: the bullet from **Not handled**.
- `AGENTS.md`:
  - Layout, `materialize`: add `conflictVersions` to its function list.
  - Add one "Why" bullet after the `syncCopy decides by content` bullet: "`listFiles` reports folders it can't list
    (`unreadable`, any error, `rel ''` for the start folder): `syncCopy` and `markCopySynced` never decide anything below
    one (an incomplete listing read as 'deleted' would delete the other side)."
  - Add one "Why" bullet after the `git rebase --autostash` one: "Push to a branch cleans up with `git reset --keep
    @{u}`, not `reset --hard` + `clean`: editors and agents write to the clone during the push; `--keep` keeps those
    edits and refuses, touching nothing, when one is on a file of the pushed commit (probe, 2026-11-28)."
- `.claude/implement.md` is the main agent's: don't edit it.

## Commands

From the repository root (Git Bash), no node on PATH:

```
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" scripts/test.js
ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --check extension.js
biome lint extension.js lib scripts test
```

(`biome` may be missing from PATH: say so in your report, don't install it.) To run one file while working:
`ELECTRON_RUN_AS_NODE=1 "$LOCALAPPDATA/Programs/cursor/Cursor.exe" --test test/materialize.test.js`.

## Don't

- No commit, no branch change, no push.
- No change outside `lib/materialize.js`, `lib/contribute.js`, `extension.js`, `test/materialize.test.js`,
  `test/contribute.test.js`, `README.md`, `docs/development.md`, `AGENTS.md` without reporting it. Don't edit the
  request or plan files or `.claude/implement.md`.
- Don't run `cursor --install-extension`, don't launch the user's Cursor, don't run `scripts/live-test.js` (the main
  agent runs it).
- No dependency, no TypeScript. Nothing under `lib/` requires `vscode`.
- Don't change `commitAndPush`, `syncManaged` or Discard.
- A test of the list above that does not fail on the unchanged code: stop and report it before changing the code.
