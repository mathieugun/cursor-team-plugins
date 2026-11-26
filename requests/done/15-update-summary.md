# 15. Update summary

From `ideas.md` (top pick 3):

> **Update summary.** "Always current" is invisible value until it's shown. After a sync, mark new and changed items
> in the view (remembering what the user has seen); **What changed** opens a diff per item with its author and date,
> instead of a list of commits in the log. The item's tooltip says who last changed it, and when. A notification such
> as "Alice improved `code-review`" is what makes a teammate see the point, and keeps people contributing.

## Decisions (design review, 2026-11-26)

- Version 0.8.4 (not 0.9.0).
- What the user has seen is remembered per repository and item, in the extension's storage, shared by the user's
  windows and kept across restarts. An item is **new** when it has no record, **updated** when its content at HEAD
  differs from its record. The first time a repository is seen (and after a clone or a branch switch) everything is
  recorded without marks. Changes whose last commit is the user's own (git's author identity) are never marked.
  Uncommitted edits never count (HEAD only). Drafts are not tracked.
- The view: marked items read `<kind> · new` / `<kind> · updated` with an `N` / `M` decoration badge and colour;
  plugin and repository rows show the counts; the view's icon shows the total as a badge.
- Tooltips of items and plugins: "Last changed by <author>, <age> (<date>)", plus "New / Updated since you last
  looked" on a marked item.
- An item counts as seen when its diff is opened or its file is opened from the view; **Mark all as seen** clears a
  repository.
- **What changed** (repository row, the notification's button, the command palette) opens a pick list of the marked
  items (author, age, commit subject; removed items too), headed by **Mark all as seen**; picking one opens its diff
  since the version the user last saw, titled with the author and age. With one marked item its diff opens at once.
  **Show changes** on an item opens its diff since last seen, or its last change when it isn't marked.
- The notification names every changed item of the repository, the enabled ones first: "Team plugins (team): Alice
  updated code-review, Bob added lint and 2 more. Start a new chat to use the changes." Updates made only by the
  user show nothing; commits that touch no item keep today's message without a button. The log listing of commits
  goes.
- Not handled: two servers of one MCP file changed by different people (both credited to the file's last change);
  content behind a symlinked skill folder; a rename shows as updated; items older than the last 1000 commits have no
  "last changed" line; a version lost by a force-push diffs against an empty left side.
