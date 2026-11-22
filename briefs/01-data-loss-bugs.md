# Brief 01: data-loss bugs

Three bugs from the 2026-11-22 code review can destroy work: a user's unpushed edits, or a team change.
Fix all three, with a regression test for each.

## 1. A failing git command deletes the managed clone

When git can't run (a wrong `git.path`, git missing from PATH, a timeout), the sync can mistake the failure for "the
repository URL changed and the clone is clean". It then deletes the managed clone and its uncommitted or unpushed
edits, and recloning fails too.

Reproduced: `syncManaged` with `makeGit('git-not-there')` on a clone that holds an edit returns `error`, and the clone
folder is gone.

Expected: a git failure is reported as an error and leaves the clone untouched. The clone is deleted and cloned again
only when git ran successfully and confirmed both a real URL or branch change and that there are no local changes.

## 2. Partial-copy sync silently reverts team updates

A partly enabled plugin is a copy kept in step with the clone both ways. When the team changes a file (the sync pulls
it) and the agent edits the same file in the copy before the next copy sync, the copy wins. The team's change is
overwritten in the clone without any notice, and the next **Commit and push** reverts it for the whole team. The
same thing happens in local mode after a `git checkout` or `git pull`. Deciding which side is newer from mtimes alone
is also fragile (clock granularity, mtimes copied with the file).

Reproduced: change the source and the copy of the same file, run `syncCopy`: the action is `toSource`, and the
team's text is gone from the source.

Expected: no version is lost silently. A file changed on one side only is carried over as today. A file changed on
both sides since the last sync is a conflict: neither version is discarded, and the user is told which file it is
and where each version is.

## 3. The copy's sync record is not written atomically

`.team-plugins-sync.json` (the record of a copy's last sync) is written in place. A crash during the write, or another window
reading it at that moment (windows with the same selection share a copy), sees an invalid file. That copy is then
treated as having no record and is deleted and rebuilt, along with any edits not yet carried to the clone.

Expected: a reader always sees either the old record or the new one, never a partial file. An unreadable record never
causes unsynced edits to be deleted.

## Done when

- Each bug has a test that fails before the fix and passes after it. The full suite passes.
- README "How it works" and "Limits" describe the new conflict behaviour of partial copies.
- Version bumped (0.2.1).
