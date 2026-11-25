# Ideas

Ideas not yet planned, reassessed on 2026-11-25 after 0.7.0. Done since the 2026-11-22 review: Remote-SSH windows
(request 04), several repositories (05), a reliable remote repository (06), commands, agents and MCP servers
selectable (0.6.0), authoring (08). Each idea below becomes a numbered request when it's picked.

## Top picks

Ranked. The first makes contributing easier, which is what keeps a team repository alive; the second is what an
organisation asks for before rolling the extension out widely. (Share a project rule or skill with the team: picked as
request 09; rename a plugin or an item: picked as request 12; open a pull request after Push to a branch: picked as
request 13.)

1. **Checks while editing and before pushing.** Diagnostics in the Problems panel for the files of the clones and
   drafts: frontmatter missing or not valid YAML, empty `description`, a skill folder that doesn't match its `name`,
   invalid `mcp.json`, a relative link to a missing file, conflict markers. **Commit and push** runs the same checks
   first. The agent edits these files: catch its mistakes while it edits, not after the push. With it, pick the files
   to commit (checkboxes in Local changes).
2. **Review executable changes before they run.** When an update changes hooks, MCP servers or scripts, show the diff
   and ask before applying it. Today a team commit reaches everyone's agent with no check. Follow-up: pin a tag or
   commit, and roll back the last update.
3. **Update summary.** After a sync, mark new and changed items in the view (remembering what the user has seen); **What
   changed** opens a diff per item with its author and date, instead of a list of commits in the log. The item's
   tooltip says who last changed it, and when.

## Smaller follow-ups

- **MCP server readiness.** Show on an MCP server item what it needs and is missing: an environment variable it
  references (a token), its command not on PATH (`npx`, `uvx`, `docker`). Today such a server fails silently in Cursor.
- **Context cost of the selection.** Per plugin and in total: the size of always-applied rules, the number and length
  of skill descriptions. A rule's tooltip says how it applies (always, globs, agent-requested).
- **Presets and project suggestions.** `marketplace.json` declares named presets ("backend", "data") and file patterns
  per plugin (for example `**/*.py`): a new user picks a preset in one click, a matching project suggests the plugin.
- **Getting started walkthrough** (`contributes.walkthroughs`): check git, add a repository, pick plugins.
- **Switch branch** on a repository row: the `{ url, branch }` entry already gives per-user channels (stable, beta);
  only the command is missing.
- Search and filter in the view.
- Show in the view the catalog warnings and the `projectPlugins` entries that match nothing, instead of only in the
  log.
- Sync when the window gets focus again, if the last check is older than a few minutes.
- Isolated live runs in a Remote-SSH window (not probed).
- Hiding Cursor's sign-in screen during the isolated live runs.
- Running `scripts/live-test.js` on Linux or macOS (not checked: the Cursor path and the kill are written for both, but
  never run).

## Parked

- A company index repository that lists the team repositories: only worth it beyond a handful of teams; presets and
  `projectRepositories` cover discovery meanwhile.
- A commit message proposed from the list of changed files: small value.
- Preview a skill before enabling it: clicking an item already opens its file.
- Usage statistics (which skills the agent actually uses): Cursor exposes no API for it.
- Real clicks in the isolated Cursor (live tests, layer 3; was request 11): scenarios that click the workbench
  through the Chrome DevTools Protocol (a tree checkbox, a notification button, a context menu, the status bar item)
  and attach a screenshot of each step. Blocked: Cursor's release build refuses `--remote-debugging-port`,
  `--remote-debugging-pipe` and `--inspect*` and exits (probe, Cursor 3.32.4, 2026-11-25). Considered and set aside:
  workbench commands from the extension host (no checkbox, context menu or status bar click, no screenshots) and
  Windows UI Automation (Windows only, a driver outside the repository's plain JavaScript, brittle). Revisit if Cursor
  allows the switch again.

## Dropped

- Self-update from a VSIX carried by the team repository: publishing to Open VSX gives auto-update, local and remote.
- One window runs the update timer for all windows: `recentlySynced` (0.2.3) already skips redundant syncs; one timer
  instead of one per window gains little.
