# Request 08: authoring and contribution

Released in 0.7.0 (2026-11-25). Plan: `08-authoring.plan.md`.

## Asked

- A **New plugin** command to create a local plugin that can be pushed to the remote repository when it's ready.
- A **New skill** command that scaffolds a skill (folder, `SKILL.md` with frontmatter) in a chosen plugin.
- Similar commands for rules, agents, commands and MCP servers.

## Decided at the design review

- A private **drafts** area (in the extension's storage, only on this machine) holds plugins that are not ready;
  **Move to a repository** copies a draft into a followed repository or the user's own clone and deletes it. **New
  plugin** can also create a plugin directly in a repository (a local change of the managed clone until Commit and
  push).
- A newly created plugin or item is enabled for the user at once.
