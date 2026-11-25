# Brief 07: bugs from the second review

Bugs found by the second code review (2026-11-22, after 0.2.3). Fix them in one pass, with a test for each where the
logic is in `lib/`. Bugs that are only in `extension.js` get a manual check. Two nits from that review are left as
they are (see the end).

## 1. Building a new partial copy can silently revert a team update (medium)

When a partial copy is built for the first time (`syncCopy`, copy folder missing), each file is copied and then the
**source** is hashed for the record. If the source changes between the copy and the hash, the copy holds the old
content while the record says it holds the new one. The next sync sees "copy changed, source unchanged" and writes the
old content back into the clone: the team's update is reverted without notice, and the next **Commit and push**
reverts it for everyone (the class of bug brief 01 #2 fixed).

The window is short, but `doApply` builds missing copies on purpose while another window holds the lock
(`build(false)`), which is exactly when that window may be rebasing the clone. In local mode the user's own
`git pull` can do the same.

Expected: the record of a newly built copy holds the hash of what the copy actually contains, so a change of the
source during the build is carried to the copy at the next sync, never back to the source.

## 2. A URL switch interrupted after the checkout blocks every retry (low)

`switchInPlace` checks out the new branch (`checkout -B <target> refs/team-plugins/switch`) before it changes the
remote URL, the upstream and the other branches. If one of those later steps fails, the next sync still sees a URL
change and checks for local work with `rev-list --count --branches --not --remotes`. The branch now points at commits
of the new repository, which are under `refs/team-plugins/switch`, not under `refs/remotes`, so they count as
unpushed and the sync stops with "has local changes: push them to a branch or discard them first". The code comment
says a retry is always safe; it isn't.

Reproduced with git 2.47: after the fetch into `refs/team-plugins/switch` and the checkout, the count is 1 on a clean
tree.

Expected: a switch interrupted at any step is completed by the next sync, without a false "local changes" error.

## 3. Two windows can both hold the lock (low)

`acquireLock`: when `open('wx')` fails with EEXIST and the lock file has vanished by the time it is `stat`ed (its
holder just released it), the lock is treated as stale and **deleted**. A third window may have created a fresh lock
in between: that lock is deleted, and two windows then work on the managed clone at the same time.

Expected: a lock that vanished is simply tried again, never deleted. Two windows removing a truly stale lock (left by
a killed process) at the same moment can still race; that needs a different lock design and is out of scope.

## 4. Partial-copy syncs take no lock in local mode (low)

`withCopyLock` takes the lock only in managed mode. Windows with the same selection share a copy folder, so in local
mode two windows can sync it at the same time and overwrite each other's sync record. Nothing was found to be lost
(the worst case is a false conflict), but there is no reason to skip the lock: it lives in the extension's global
storage, not in the user's clone.

Expected: partial-copy syncs and conflict resolution hold the lock in every mode.

## 5. A failed `git status` reads as "no local changes" (low)

`localChanges` returns an empty file list when `git status` fails. **Commit and push** and **Push to a branch** then
say "Nothing to commit or push", and the Local changes group disappears, although git failed (a milder case of the
problem brief 01 #1 fixed).

Expected: a failing `git status` is reported as an error (with git's message) by the commands, and the view doesn't
claim there are no changes.

## 6. The diff view trusts its URI (low, hardening)

The `team-plugins-git:` content provider takes `repo` and `rev` from the URI query and runs `git show <rev>:<file>`.
A `rev` such as `--output=<path>` makes git write a file (checked with git 2.47), and `repo` can be any folder.
Opening such a URI requires a crafted link, so this is hardening.

Expected: the provider only serves `HEAD` of the managed clone, and nothing from the URI can become a git option.

## Left as they are (nits)

- Each sync of a window triggers one extra apply about a second later, when the window sees its own
  `sync-state.json` write. Wasted work only.
- The partial-copy hash cache (`hashCache`) never drops entries for files that no longer exist. Bounded by the number
  of plugin files.

## Done when

- Each `lib/` bug has a test that fails before the fix and passes after it; #4 and #6 (in `extension.js`) are checked
  by hand or by a test of the logic moved to `lib/`. Full suite green, `extension.js` syntax checked.
- README and AGENTS.md kept in step (the lock now covers partial copies in local mode too). Version bumped (0.2.4).
