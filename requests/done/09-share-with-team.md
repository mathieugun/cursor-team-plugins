# Request 09: share a project rule or skill with the team

Taken from `ideas.md` (top pick 1, 2026-11-25). Plan: `09-share-with-team.plan.md`.

## Asked

Team skills usually start as a `.cursor/rules/*.mdc` or `.cursor/skills/<name>/` in one project. A **Share with
team...** command (right-click in the Explorer) copies it into a plugin, a draft or a repository, as a new local change.
Today that path is manual.

## Decided at the design review

- Kinds: project rules, skills, commands and agents (`.cursor/rules/**`, `.cursor/skills/<name>/`,
  `.cursor/commands/*`, `.cursor/agents/*`). From the command palette the list also offers the personal ones of
  `~/.cursor` (skills, commands, agents), marked "personal".
- The destination is any loaded plugin (drafts included) or a new plugin (drafts or a repository, the **New plugin**
  flow). The copy is enabled for the user, like a new item.
- The original stays where it is; the final message offers to move it to the trash (never a permanent delete).
- After the Remote-SSH live test (a remote window has no trash): there the button deletes the original for good, after
  a modal confirmation.
- A name that breaks Cursor's rule or is taken in the plugin is asked for again, with a suggestion.
