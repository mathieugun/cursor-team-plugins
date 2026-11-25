# Brief 02: medium-severity bugs

Bugs from the 2026-11-22 code review that break a feature or make it unreliable, without destroying data directly.
Each needs a test where the logic lives in `lib/`. Bugs that are only in `extension.js` get a manual check.

## 1. Clearing the branch setting keeps the old branch

After `teamPlugins.branch` goes from `dev` back to empty (meaning "the default branch"), the managed clone stays on
`dev` and reports "up to date". Reproduced.

Expected: an empty setting follows the remote's default branch, and switching to it works like any other branch change.

## 2. Git operations that run without the lock, or at the same time

- **Discard local changes** resets and cleans the managed clone without taking the sync lock, so it can run in the
  middle of another window's update.
- **Commit and push** and **Push to a branch** run outside the window's operation queue: a partial-copy sync can write
  into the clone during their rebase or reset.
- Partial-copy syncs write into the clone without the lock, so they can collide with another window's sync.

Expected: an operation that changes the managed clone never overlaps with another one, in the same window or in
another window.

## 3. Changing the repository URL or branch probably fails on Windows

To switch, the extension deletes the managed clone and clones again. That clone still has plugins registered from it,
and Windows refuses to delete a folder Cursor watches. This was seen elsewhere in the project but not tested on this
path. Check it first.

Expected: switching the URL or branch works while plugins are registered, on Windows too.

## 4. A symlink or junction in a plugin breaks its partial copy

A plugin that contains a symlinked folder (for example a skill shared between plugins) can't be partly enabled:
building the copy throws EPERM. Reproduced with a junction.

Expected: a partly enabled plugin with symlinks works. The brief's analysis decides whether links are copied as their
content or left out with a warning in the log.

## 5. Fast checkbox clicks lose selections

Two checkbox clicks in a row: the second one can overwrite the first, because both read the settings before the
first write has finished.

Expected: every click is kept, however fast they come.

## 6. Long git operations and leftovers

- A first clone of a large repository, or one over a slow VPN, is killed after 120 s.
- A git process that was killed can leave `.git/index.lock` behind. Every later sync then fails until someone deletes
  the file by hand.
- A clone that failed to move into place (a common Windows antivirus or indexer issue) leaves `repo.tmp-*` folders
  that nothing ever removes.

Expected: clones get enough time to finish. A stale `index.lock` is recovered from safely, never while git really is
running. Leftover temporary folders are cleaned up.

## 7. A locked file drops a partial-copy sync

Seen in the 0.2.1 live test: a copy sync that runs while Cursor is saving the same file fails with `EBUSY` and is
dropped. Nothing is lost (the next sync settles it by content), but nothing retries it either, so a copy edit can stay
out of the clone until some other change triggers a sync.

Expected: a sync that hits a locked file is retried shortly after, and the edit reaches the clone without any other
trigger.

## Done when

- Each bug is fixed or, for #3, shown not to happen (with the evidence written in the brief's report).
- Tests for the `lib/` parts, full suite green, README kept in step, version bumped.

## Report

- **#3 happens.** Probe extension in Cursor 3.31 on Windows (2026-11-22), with a plugin registered from
  `<storage>/.cursor/plugins/<repo>/<plugin>` 5 s earlier:
  - delete `<repo>` (`removeTree`): EPERM; rename `<repo>`: EPERM
  - inside the registered folder: edit a file, delete a subfolder, delete the registered folder itself: ok
  - after `removePlugin`: delete `<repo>`: ok, immediately

  So the managed clone, the parent of registered plugin folders in every window, can't be deleted to reclone it.
  Fix: a URL or branch change switches the clone in place with git (fetch the branch into a temporary ref,
  `checkout -B`, then the remote URL and upstream), which only deletes or edits files inside it.
