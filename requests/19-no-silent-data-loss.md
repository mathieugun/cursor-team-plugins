# 19. Sync and push never discard work they did not check

Three P1 findings of the 2026-11-27 review ([review](review.md), data loss 1, 2 and 4) share one cause: a destructive
step (delete, overwrite, `reset --hard`, `clean`) acts on what the extension *believed* about the files, not on what is
there when it acts. The user sees success and the work is gone.

## 1. An unreadable folder reads as "deleted"

`listFiles` returns an empty listing for a folder whose `readdirSync` throws. `syncCopy` then sees the copy's files as
missing while the repository's are unchanged since the last sync, and deletes them from the repository
(`deletedInSource`). Reproduced in the review with a simulated `EACCES` after one successful sync. A failed listing on
the repository side propagates the other way. `markCopySynced` uses the same walker.
[Directory scan](../lib/materialize.js#L38) · [Deletion decision](../lib/materialize.js#L475) ·
[markCopySynced](../lib/materialize.js#L547)

Expected: no deletion is ever decided from an incomplete listing. A folder that can't be read (on either side) leaves
the files under it untouched, keeps their last known state in the sync record, and is reported (log and the plugin's
problems). The next complete scan resumes normally.

## 2. A stale conflict choice overwrites a newer edit

The conflict dialog checks the window's cached conflict list, then `resolveConflict` runs under the lock and checks only
the record's version. Another window may have resolved the conflict meanwhile, and the file may have been edited again
since: the pending choice overwrites that edit (reproduced in the review).
[Dialog](../extension.js#L3187) · [Resolver](../lib/materialize.js#L509)

Expected: under the lock, the resolver applies the choice only if the file is still in the record's conflicts and both
sides still hold the versions the user was shown (hashes taken when the dialog opened). Otherwise it changes nothing and
the user is told the conflict changed.

## 3. Push to a branch erases work saved during the push

After the commit, `pushToBranch` pushes, then runs `reset --hard @{u}` and `clean -fd`. An agent or editor writing to
the managed clone between the commit and the cleanup (the network push included) loses that edit or new file, and the
command reports success (reproduced in the review with real local git and a simulated push).
[Post-push cleanup](../lib/contribute.js#L177)

Expected: the cleanup removes only what the pushed commit holds. Work created after the commit stays in the clone as
local changes on top of the team version (or, if it can't be carried over, the clone is left as it is and the user is
told the push succeeded but the reset was skipped).

## Acceptance

- Each of the three reproductions is a test that fails on `main` before the fix (filesystem errors injected with
  `node:test`'s `mock.method`, a second "window" simulated by a second call, a write between push and cleanup through
  the fake `run`).
- With the fix, the same tests pass, and no file is deleted or overwritten in any of them.
- A listing failure, a changed conflict and a skipped reset each produce a message the user can see, not only a log
  line.
