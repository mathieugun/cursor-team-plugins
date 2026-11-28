# Fix the conflict check for untracked files

## Context

`extension.js` calls `syncManaged` in `lib/sync.js`. After fetching, a sync that is behind upstream calls
`checkConflicts` before rebasing. Project workflow notes are in `.claude/implement.md`. This fix targets the working
tree at version 0.9.1. The project bumps the version separately at release.

## Measured facts

The two new cases in `test/sync.test.js` failed on the original code with Git 2.47 on Windows. A single upstream path
beginning with a space gave an `error` instead of `conflict`. With exit 128 and empty stdout injected for the upstream
path query, a sync with a non-overlapping untracked file returned `updated` instead of `error`. The injection controls
only the diff result. Both tests use real Git for fetching and inspecting the clone.

## Design and impact

In `checkConflicts`, pass `{ trim: false }` as the fourth argument to the existing diff call. On nonzero exit, throw the
same redacted `git diff failed: …` error used by `changedPaths` before parsing stdout. `syncManaged` already reports
such errors and the rebase is skipped. Successful output is still split on NUL and compared to the untracked paths.
There is no migration or configuration change.

## Tests

- `test/sync.test.js` already contains the two regression cases. The failure should leave HEAD and the untracked file
  intact. The leading-space case should return the full filename and keep its local content.
- Extend `test/live/updates.live.js` at the end of the scenario. Add matching untracked and upstream files at the
  repository root with a leading space, sync from Cursor, and assert the repository reports a conflict and the local
  file contents are preserved.

## Keep in step

In `docs/development.md`, document the untracked path comparison and that an error in the path query stops the update.
The README already describes updates preserving local changes. There are no settings, command, fixture or version edits.

## Commands

- Baseline and final Windows and Linux suites with `python scripts/live_check.py test --host gnosis`.
- Focused regression command `node --test --test-name-pattern='leading space|upstream path diff' test/sync.test.js`.
- `node --check extension.js`, `python scripts/live_check_test.py`, and `biome lint --error-on-warnings extension.js lib scripts test`.
- `node scripts/live-test.js updates` uses an isolated Cursor profile. The automated cases cover the changed behavior.

## Don't

Keep the existing diff range, rename handling and rebase behavior. Use local test remotes. Do not install the extension
or run the user's Cursor profile. Git commits and request files are owned by the main agent.

## Verification

- The baseline failed only the two new cases on Windows and Linux. After the fix, Windows passed 495 tests with 2
  skips and Linux passed 478 with 19 skips. The focused rerun passed both cases.
- Extension syntax, Biome lint, the 12 Python tests, and `git diff --check` passed.
- The isolated `updates` scenario passed. The first launch inherited an incomplete Git configuration and failed
  before cloning. Setting `GIT_CONFIG_COUNT=0` for the retry allowed Cursor to run the scenario through the conflict.
