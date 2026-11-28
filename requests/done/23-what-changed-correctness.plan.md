# 23. What changed uses committed evidence and preserves seen marks

## Context

The [request](23-what-changed-correctness.md) follows the workflow notes in `.claude/implement.md`.
The work started on `main` at version 0.8.7. Version changes are made on `main` for a release.
`updateRepo` and the What changed commands in `extension.js` use Git evidence and seen records from `lib/updates.js`.

## Measured facts

- The baseline `computeMarks` reports a missing working item as removed even if the seen record's commit is still HEAD. On Windows with Git 2.47, `git ls-tree -r -t --name-only HEAD` still lists the skill's `SKILL.md` after deleting it locally. When that deletion is committed and an asset remains, Git lists the folder and asset but no `SKILL.md`.
- With Node 24 on Windows, reading an empty seen record twice and writing it with a different acknowledgment from each snapshot left only the second mark. With the existing lock helper, the second writer received busy while the first held the lock. Retrying the full transaction preserved both marks.
- A test that paused a second write partway through the temporary file let the first writer publish invalid JSON. Both writers chose the same temporary name, and the second rename failed with `ENOENT`.
- `node --test test/updates.test.js` on baseline code passed 19 existing tests and failed all three new regressions. The summary reported items still present in HEAD as removed, the transactional writer was missing, and the atomic writer exposed a partial record.
- Source inspection found three ways to change the seen record: automatic baselines and own changes, individual acknowledgment, and Mark all as seen. They must share a lock. An acknowledgment may follow an asynchronous diff or pick list, so it must describe the snapshot that was shown.

## Design

- Use one resolved Git commit for the tree, committed file contents, and its history. Keep the current committed fingerprints for visible items. A missing working item is eligible for removal only when HEAD confirms its recorded item is missing there. Check the skill document inside a skill folder, the actual file for rules, commands and agents, and the named entry for MCP (including the other standard MCP filename in that directory). A tracked directory symlink can be treated conservatively when its document cannot be confirmed. Preserve the record for a local deletion, including when Git cannot supply the needed evidence.
- Move a seen record along a rename only with committed evidence of the new item and the disappearance of the old item. Use the committed rename map. Keep unrelated Git and tree display behavior where it is today.
- Serialize every read, compute or merge, and write for one repository's seen record with a dedicated lock through the existing sync lock helpers. Wait briefly and retry on contention. A failed write must leave the previous record and the acknowledgment pending. Keep the existing JSON schema and skip a write when its text is unchanged. Create each write's uniquely named temporary file in the destination directory, rename it into place, and clean it up on failure.
- Acknowledge the entries shown to the user. Mark all acknowledges the marked and removed entries from that view. Merge them into the latest locked record and leave unrelated entries intact. An acknowledgment from a stale view must not overwrite or delete a newer acknowledgment for that same item. Refresh the window after the write. The other windows keep using the seen-file watcher.

## Impact

- `extension.js` update cache, refresh, acknowledgment and diff call sites.
- `lib/updates.js` committed evidence, record merge and atomic persistence. Reuse `lib/sync.js` lock helpers.
- `test/updates.test.js` adds the regressions first. `test/live/updates.live.js` exercises the workflow in Cursor.

## Tests

- With Git fixture data at a stable HEAD, a deleted working item keeps its record. A committed removal is marked, including a skill that still has a tracked asset and an MCP entry deleted from a manifest that still exists. A local rename does not move a seen record. The existing new, updated, own-change and committed-rename cases keep passing.
- Run overlapping acknowledgments for different items with the first transaction paused while it holds the lock. Both entries must be in the final record. Exercise a stale acknowledgment against a more recent same-item record.
- Interleave two writes while one temporary file is being written. Any visible destination must contain one complete JSON record, both writes can finish, and temporary files are distinct and cleaned up.
- In isolated Cursor, delete a previously seen skill through a partial copy and wait for it to disappear in the clone. Check the removal count, notification calls and badge. Discard the deletion and verify the restored item has no mark. Keep the existing teammate-update and What changed coverage.

## Keep in step

- `README.md` describes committed changes in What changed.
- `docs/development.md` and `AGENTS.md` describe HEAD evidence, seen locking and atomic writes. The stored seen format stays at version 1.
- `.claude/implement.md` records the observed Git behavior when a skill folder keeps a tracked asset.
- `requests/review.md` links to the archived requests.

## Commands

- Run `node --check extension.js`, `node scripts/test.js`, and `biome lint --error-on-warnings extension.js lib scripts test` on the baseline and final code.
- Run `node scripts/live-test.js updates` in isolated Cursor.
- Run `python scripts/live_check.py test --host gnosis` before the local merge.

## Don't

- Use the isolated Cursor runner. Leave branch integration to the main agent.

## Changes after review

- A committed rename stores the current path and name. When the content changed, its seen fingerprint and commit
  still come from the earlier version. The current path lets a later refresh confirm the item is still at HEAD if
  it disappears from the working tree.
- Acknowledgments check the current HEAD under the lock. A window with an older snapshot refreshes so it can show
  the newer changes and preserve the latest seen record.

## Verification

- The updates suite passed all 26 tests. Extension syntax and Biome passed.
- With requests 22 and 23 together, Windows passed 443 tests with two platform skips. Linux passed 426 with
  19 platform skips.
- Isolated Cursor 3.32.10 passed `updates`, `checks`, `rename`, and `contribute` on the combined branches.
