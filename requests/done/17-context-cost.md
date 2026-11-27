# 17: Context cost of the selection

From `requests/ideas.md` (smaller follow-ups):

> **Context cost of the selection.** Per plugin and in total: the size of always-applied rules, the number and length
> of skill descriptions. A rule's tooltip says how it applies (always, globs, agent-requested).

## Decisions (design review, 2026-11-27)

- The cost is an estimate in tokens (4 characters per token): Cursor builds the prompt on its server.
- What counts "in every chat": the body of always-applied rules (and of a skill with `alwaysApply: true`), and the
  descriptions of skills and of agent-requested rules, counted together as "descriptions". A rule for matching files
  is shown apart ("when it applies") and is not in the total.
- A skill with `disable-model-invocation: true` is left out of the count; its tooltip says so.
- A rule's tooltip says how it applies (always, matching files, when the agent asks, only when mentioned); a skill's
  tooltip says what it costs. An always-applied item's row reads `rule · always` (or `skill · always`).
- A plugin's tooltip gives its cost (of the ticked items; "If enabled, …" for an unticked plugin); an enabled plugin's
  row text also shows `~N tokens`.
- The total of the window's selection shows next to the view's title (`~1.2k tokens per chat`) and, with its
  breakdown, in the status bar tooltip.
- Not counted: MCP tool definitions, subagent descriptions, commands, the project's own rules and the user rules.
