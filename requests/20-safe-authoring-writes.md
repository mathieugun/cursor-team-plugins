# 20. Authoring and Rename write only inside the repository, and keep files valid

The authoring commands (New plugin, New item, Add MCP server, Move draft, Rename) build paths and file contents from
repository data and user input. The 2026-11-27 review ([review](review.md)) found that they trust both too much: they
can write outside the checkout, move the checkout itself, reject or skip valid files, and generate a file that fails
their own check.

## 1. Destinations outside the plugin's own folder

- **Rename of a root plugin moves the checkout (P1).** A `marketplace.json` entry with `source: "."` is the repository
  root. `renamePlugin` computes `dirname(root)/<new name>` and renames the whole checkout to a sibling folder
  (reproduced in the review). Cursor names a plugin after its folder, and a root plugin's folder is the clone folder,
  so renaming only the metadata would not rename what Cursor shows: recommended behaviour is to decline before any
  write, with a message that says why. [Destination](../lib/rename.js#L238) · [Directory move](../lib/rename.js#L297)
- **`metadata.pluginRoot` escapes the repository (P1).** `pluginLocation` joins it to the repository folder unchecked.
  New plugin can write outside the checkout, and Move draft can copy there and then delete the draft, although the
  catalog will reject that location. [Authoring destination](../lib/authoring.js#L244)

Expected: every destination built from repository data is checked with one shared containment helper (the catalog's
`inside` rule, links resolved) before the first write, and a plugin folder is never the repository root. Move draft
deletes the draft only after the destination passed that check and the copy succeeded.

## 2. Files the commands read or write differently from Cursor

- **MCP files are JSONC (P2).** The catalog reads `mcp.json` with `parseJsonc`, but Add MCP server rejects a file with a
  comment or trailing comma, and Rename silently skips one. Both should read it as the catalog does, and edit it
  without losing the comments, or decline with a clear message when that is not possible. [Catalog](../lib/catalog.js#L310) ·
  [Add](../lib/authoring.js#L205) · [Rename](../lib/rename.js#L140)
- **Generated YAML values (P3).** `yamlScalar` writes `2026-11-27`, `true`, `null` or `123` unquoted: YAML reads them
  as a date, a boolean, null or a number, and the new skill fails our own "No description" check. User text that YAML
  would read as anything but a string must be quoted. [YAML writer](../lib/authoring.js#L41)

## 3. One settings migration for Move and Rename

Move and Rename each carry the same loop that rewrites the `enabled` and `excluded` ids in the Global settings. Extract
it into one helper with the two callers. [Move](../extension.js#L2568) · [Rename](../extension.js#L2683)

## Acceptance

- Tests written first, failing on `main`: Rename of a `source: "."` plugin, New plugin and Move draft with
  `pluginRoot: "../outside"`, Add and Rename on an `mcp.json` with a comment and a trailing comma, and a skill created
  with the descriptions `2026-11-27`, `true` and `null`.
- With the fix: nothing is written outside the repository and the checkout never moves; the MCP edits keep the
  comments (or decline without writing); each generated item passes `checkItemText` with its description intact.
