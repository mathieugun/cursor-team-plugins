# 23. What changed: committed evidence only, and seen marks that survive two windows

Two findings of the 2026-11-27 review ([review](../review.md)) affect the update summary (request 15).

## 1. An uncommitted deletion shows as "removed" (P2)

`updateRepo` takes the item list from the catalog of the working tree, and the fingerprints from HEAD. `computeMarks`
skips an item that is not committed when looking for new or updated items, but reports as removed any recorded item
missing from the working list, without checking HEAD. Deleting a skill in a partial copy (the deletion reaches the
clone) is then announced as removed, credited to whoever last changed it. Marking it seen forgets its record, so
discarding the deletion brings the skill back marked "new". [Item collection](../../extension.js) ·
[Removal detection](../../lib/updates.js)

Expected: an item counts as removed only when it is absent from the HEAD tree. An item deleted only in the working tree
keeps its record and no mark.

## 2. Two windows lose each other's seen marks (P2)

Marking an item seen reads the record, changes one entry and writes the whole record. Two windows doing that at the
same time each overwrite the other's mark. Both also write through the same `<file>.tmp`, so one rename can publish the
other's half-written file. [Mark seen](../../extension.js) · [Record writer](../../lib/updates.js)

Expected: read, merge and write of a repository's seen record happen under one lock (the existing lock helpers), and
each write uses a temporary file of its own.

## Acceptance

- Tests first, failing on `main`: a recorded item deleted only in the working tree is not in `removed`; two writers
  marking different items both find their mark in the final record; two concurrent writes never leave a partial file.
- The notification and the badge show no removal after deleting a skill locally, and the skill is not "new" after the
  deletion is discarded (manual or live check).

## Result

Implemented and verified in [the plan](23-what-changed-correctness.plan.md). The isolated `updates` scenario verified
the notification, badge and restored item after a partial-copy deletion.
