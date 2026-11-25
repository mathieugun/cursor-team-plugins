# Request 12: rename a plugin or an item

Picked from `ideas.md` (top pick 2) on 2026-11-25. Plan: `12-rename.plan.md`.

## Asked

**Rename** (right-click) renames a plugin (folder, `plugin.json` `name`, `marketplace.json` entry; unregistered first,
as **Move to a repository** does), a skill (folder and frontmatter `name`), a rule, command or agent (file, and
frontmatter `name` when there is one) or an MCP server (its key in `mcp.json`), in a draft, a managed clone or a local
clone; the user's selection follows (`renameIds`). Done by hand today, a rename silently drops the item for every
teammate who picked it one by one or excluded it, and for every project that lists it: so the repository records it
(for example `"renamed": { "<old id>": "<new id>" }` in `marketplace.json`), each user's extension rewrites its lists
at the next sync, and projects' lists are read through it like 0.4 ids. The same record (`"formerNames"`) would lift
the limitation on renaming a repository. Completes authoring: create, move, rename.

Would F2 work? Better than adding another menu.

## Decided at the design review

- **F2** in the Team Plugins view, plus one **Rename** entry in the existing right-click menu of plugins and items
  (it shows "F2" next to it, which is how users discover the shortcut).
- The **Rename** command writes `"renamed": { "<old id>": "<new id>" }` (ids without the repository part) in the
  repository's `marketplace.json` (managed and local clones; drafts need no record). Ids are read through it
  everywhere (`normalizeIds`): users' lists are rewritten at the next apply, projects' lists only read through it. An
  id that exists in the catalog is never redirected.
- Renaming a **repository** (the `name` of its `marketplace.json`, by hand): no hand-written `formerNames`. The
  extension remembers the last name of each repository it follows (by URL) and, when it changes, rewrites the user's
  lists and reads projects' old ids through the former names. Not covered: someone who starts following the
  repository only after the rename and opens a project whose list still has the old ids.
- Version **0.8.1**, not 0.9.0.
