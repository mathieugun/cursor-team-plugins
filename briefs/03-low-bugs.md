# Brief 03: low-severity bugs and corner cases

Smaller defects from the 2026-11-22 code review. Each is minor alone. Fix them in one pass, with a test wherever the
logic is in `lib/`.

1. **An excluded skill can be overwritten through a copy.** If the agent creates, in a partial copy, a file at the
   path of a skill or rule left out of the selection, it overwrites that file in the team clone. Reproduced. A copy
   must never write to the excluded parts of the plugin.
2. **Tree id collisions.** A plugin named `changes` or `sync-error` has the same tree id as a built-in node, and the
   view fails to render.
3. **Plugin names used as file names.** A plugin `name` with characters that are invalid in a path (`:`, `/`, `\`, …)
   breaks its partial copy, or could point outside the storage folder.
4. **Diff of a renamed file.** In Local changes, the diff of a renamed file compares against the new path in the team
   version (which doesn't exist) instead of the old one, so the whole file shows as added.
5. **Errors silent after the first one.** After the first background sync error has been shown, later errors are
   never shown again until the window reloads, even after a recovery.
6. **Conflict notice not repeated.** When new team commits add conflicts with your changes, no new notice appears
   unless your own HEAD changed.
7. **Multi-line descriptions.** A YAML block description in a skill's or rule's frontmatter (`description: >` or `|`)
   shows as `>` or `|` in the tooltip.
8. **Git version requirement.** Conflict detection needs git 2.38 or later (`merge-tree --write-tree`). With older git,
   every update that brings team commits fails, and the message doesn't explain why. Check the version, report it
   clearly, and document it in the README.
9. **Copy sync cost.** Every partial-copy sync reads every file of every partly enabled plugin in full. This is heavy
   for plugins that ship many or large files (for example an MCP server with its `node_modules`).
10. **One fetch per window.** Every open window runs its own update timer, so N windows fetch N times per interval.
11. **Copies of other windows go stale.** In managed mode, a change in the clone (from another window's copy, or a
    direct edit) doesn't refresh this window's partial copies or catalog until its next sync.
12. **A long-lived window can lose its copy.** A window that doesn't refresh for 7 days (interval 0, local mode) can
    have its partial copy deleted by another window's cleanup while the copy is still registered.

## Done when

All items fixed, or deliberately left out with the reason in README "Limits". Tests for the `lib/` parts, full
suite green, version bumped.
