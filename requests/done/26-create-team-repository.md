# 26. Create a team repository from what you already have

Taken from `ideas.md` (top pick 1), 2026-11-28.

A **Create team repository** command, and a walkthrough branch "I don't have a team repository yet". It scans the open
projects (and the user-level folders) for `.cursor/rules`, skills, commands, agents and `mcp.json`, groups them into a
plugin, writes `.cursor-plugin/marketplace.json`, runs `git init`, pushes to an empty remote the user gives, and adds
the repository. Start with a read-only preview that shows identical copies that can be consolidated, variants that need
a decision, and references to project-local files that may break when moved. Show the differences and let the user
choose a version or merge the copies before importing. Builds on Share with team (09, one item at a time today) and
drafts (08).

## Decisions (2026-11-28)

- UI: a read-only Markdown preview, then quick picks (one per variant), Cursor's diff editor to compare, and a scratch
  copy edited in a diff editor to merge by hand. No webview.
- MCP secrets: an `env` value or header whose name holds a secret word and that holds a literal value is always replaced
  with `${env:NAME}`. Other suspected secrets (a password in a URL, a secret-named query parameter or flag, a known
  token shape, also in item texts) leave the item unticked in the list of what to import.
- After the push the closing message offers **Replace the originals** (a ticked list of the imported originals,
  grouped by source: files and folders go to the trash, MCP servers are removed from their `mcp.json` with a backup in
  the extension's storage, then the new plugin is ticked) or **Keep them** (the plugin stays unticked).
- Walkthrough: a new step "No team repository yet?" before "Add a team repository".
- One plugin per new repository. The version is unchanged (released later as 0.9.0).
