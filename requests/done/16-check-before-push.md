# 16. Check before pushing

Cursor fails silently on a broken team file (a skill never fires, a server vanishes), and a push hands that file to
every teammate; the agent wrote most of these edits and the author rarely reads them closely. **Commit and push** and
**Push to a branch** check the changed plugins first and stop with the list and a "Push anyway" button. The checks, by
value: JSON that doesn't parse in `marketplace.json`, `plugin.json` or `mcp.json` (drops a whole plugin or all its
servers; `catalog` already finds it but only logs it), conflict markers, a skill, rule, command or agent whose
frontmatter is missing or not valid YAML, an empty `description` (the agent picks a skill by it). The same results show
in the view, on the plugin or item row, which replaces showing the catalog warnings only in the log. Diagnostics in the
Problems panel while editing only if the agent sees them on files outside the workspace (the clones are under the
global storage): then it fixes its own mistakes before the push. To probe first: what Cursor does with a skill whose
frontmatter is broken (skipped, or loaded without a description), and whether the agent reads diagnostics of a file
outside the workspace. Left out: a skill folder that doesn't match its `name` (unless the probe shows Cursor cares),
relative links to missing files (little harm, needs a markdown link parser).

(Top pick 4 of `ideas.md`, 2026-11-26.)

## Decisions (2026-11-26)

- Probes (Cursor 3.32.4): an item whose frontmatter gray-matter can't parse is dropped silently; a missing frontmatter
  or an empty description keeps it (a skill or agent then has no description). `plugin.json` and `marketplace.json`
  are strict JSON (a BOM, a comment or a trailing comma makes Cursor ignore them); `mcp.json` is JSONC. The agent's
  `ReadLints` tool reads an extension's diagnostics of any file, outside the workspace too (code reading, confirmed by
  hand check).
- Every problem stops the push (errors and warnings), with **Push anyway**.
- Diagnostics: yes, on the clone file and on its partial-copy file; the agent's view of them is confirmed by a hand
  check.
- Extras: a BOM in `plugin.json`/`marketplace.json`, two skills (or rules) of one plugin with the same name, an agent
  with an empty body, and the catalog reads `mcp.json` as JSONC like Cursor.
- Frontmatter YAML is checked by our own line-based checker (no dependency), calibrated against Cursor's gray-matter;
  it never flags valid YAML in the forms it knows and may miss rarer errors.
- A skill folder that doesn't match its `name`: not checked (Cursor doesn't care). Links to missing files: not checked.
- Version 0.8.5.
