# 24. Test the cleanup fallback, and merge only after the branch's CI passes

Follow-up of the Ubuntu failure on `main` after `fix/windows-ci` (CI run of 89d5e1f, 2026-11-27). Depends on
`fix/windows-ci-follow-up` (1b8b285) being merged first.

## 1. No test covers `removeTree`'s fallback

When `fs.rmSync` fails, `removeTree` makes the tree writable and tries again. Until 1b8b285 it ran `chmod 0o666` on
every entry, directories included. On Linux that removed the execute bit, so nothing inside could be read or deleted.
A failed cleanup on a Remote-SSH host would have left a tree nobody could enter. `chmod` also followed links and could
change a file outside the tree. Windows ignores the execute bit, so the bug surfaced only by accident, through the
mocked EPERM of a `movePlugin` test on the new Ubuntu job. [removeTree](../lib/sync.js#L9)

Expected: `sync.test.js` covers the fallback directly.

- A tree whose first `rmSync` fails (mocked once) is removed completely by the retry, read-only files included.
- During the retry, directories keep their execute bit (Linux only: Windows has no such bit).
- A link inside the tree to a file outside it leaves that file and its permissions unchanged (skipped where the test
  can't create a link, as other link tests do).

Each case must fail against the code before 1b8b285, so the test would have caught the bug.

## 2. Merge a branch only after its own CI passes

`fix/windows-ci` was merged and `main` was pushed without the branch ever being pushed, so `main` was the first place
CI ran, and it went red. The checks run on every branch push (request 18) for exactly this.

Expected: the branch workflow in `AGENTS.md` and the release notes in `docs/development.md` say: push the branch (with
the user's approval, as for any push), wait for the Checks run of that commit to pass on Ubuntu and Windows, then
merge into `main` and push `main`. A red branch run is fixed on the branch, not on `main`.

## Acceptance

- The three test cases pass on `main` after the merge, and each one fails on Linux when 1b8b285 is reverted locally.
- `AGENTS.md` and `docs/development.md` describe the push, wait for CI, then merge order in the same words.
