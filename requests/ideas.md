# Ideas

Ideas not yet planned, reassessed on 2026-11-26 after the walkthrough (request 14), for adoption. Done since the
2026-11-22 review: Remote-SSH windows (request 04), several repositories (05), a reliable remote repository (06),
commands, agents and MCP servers selectable (0.6.0), authoring (08), share with team (09), rename (12), pull request
after Push to a branch (13), Getting started walkthrough (14). Each idea below becomes a numbered request when it's
picked.

## Top picks

Ranked for adoption. Two people must say yes before the walkthrough even starts: the **champion**, who creates and
fills the team repository, and each **teammate**, who installs the extension and must see why it's worth it. The
walkthrough assumes a team repository URL already exists. Request 26 covers having no repository yet (create one from
what you already have); the first pick below covers getting teammates in, and together they make a two-minute demo;
the second is the gate for an organisation-wide rollout. The update summary, which kept the value visible after day
one, is request 15; the check before pushing, which keeps an adopted repository healthy, is request 16.

1. **Invite link and presets.** **Copy invite link** gives a
   `cursor://mathieugun.cursor-team-plugins/add?url=…&preset=…` link (`registerUriHandler`): the champion posts it in
   the team chat, one click adds the repository and ticks the preset's plugins. `marketplace.json` declares named
   presets ("backend", "data") and file patterns per plugin (for example `**/*.py`): a new user picks a preset in one
   click, a matching project suggests the plugin. To probe first: that Cursor routes its `cursor://` scheme to an
   extension's URI handler, and what happens when the extension isn't installed yet.
2. **Review executable changes before they run.** When an update changes hooks, MCP servers or scripts, show the diff
   and ask before applying it. Today a team commit reaches everyone's agent with no check. Not a convincer for one
   developer, but what a lead or security team asks before rolling the extension out widely. Follow-up: pin a tag or
   commit, and roll back the last update.
3. **One repository for Cursor and Claude Code** (to check). Claude Code's plugin format
   (`.claude-plugin/marketplace.json`, skills, commands, agents, `.mcp.json`) is close to Cursor's: a repository that
   serves both lets a team using both tools adopt it as its one source of truth. Writing both manifests (when creating
   a repository or a plugin) looks cheap; syncing into Claude Code itself is out of scope. First check how far the two
   formats really match.

## Onboarding follow-ups

- **Set up this project for the team.** Let the maintainer pick the plugins a project needs and review a diff that
  adds the repository and selection to `.vscode/settings.json` and recommends the extension in
  `.vscode/extensions.json`. Commit the setup so teammates discover it when they open the project. Builds on
  **Add to this project**. Verify that Cursor surfaces the extension recommendation in a fresh profile.
- **Try it with a sample project.** Add a walkthrough option with a small bundled catalog and one sample task. Enable
  a shared review skill and see it used in a new chat without setting up a remote or getting repository access.
- **Show the contribution workflow in a short README animation.** Do this once **Create a team repository from what
  you already have** ships. Put the animation near the top of the extension README and verify it renders on the
  extension's details page. Briefly show the maintainer creating a team repository from existing rules or skills,
  then spend most of the animation on a teammate improving a shared skill in the chat where they found the problem.
  Show the diff under **Local changes**, then **Push to a branch** and the pull or merge request page. Use a teammate
  who can push a branch. [Cursor's Team Marketplace docs](https://cursor.com/docs/plugins#publish-a-skill-to-your-team)
  describe updating your own published skill, and teams with an imported Git repository can use their host's review
  workflow. The animation should show how Team Plugins takes a teammate from editing the shared skill in use to
  proposing the change for review.

## Personal plugin branches for Remote-SSH

Publish plugin work in progress from the local Cursor window and pick it up in an SSH window. Both windows already
read the same user setting for the repository and branch, but each machine has its own clone. A branch carries the
committed files between machines through the Git remote.

- Show the current branch and the team's default branch on the repository row. Offer **Switch branch** and
  **Create branch**. The picker also works for existing branches such as `stable` and `beta`. Make it clear that
  choosing a branch affects both local and SSH windows. If a clone has edits that prevent switching, keep them and
  report which machine could not switch.
- Add **Publish work in progress** to publish existing edits, including edits made directly by an agent and new
  untracked plugins, to a personal branch. Change the shared branch setting only after the push succeeds. Unlike the
  existing **Push to a branch** review flow, publication should leave the authoring clone following the personal
  branch. Later updates can use **Commit and push** and the existing sync. A plugin in **Drafts** needs to be moved
  into the repository before it can be published.
- When an authoring command writes to a managed repository on the team branch, offer to switch to or create a
  personal branch before continuing. Use the same prompt for creating plugins and items, renaming, sharing, and
  moving a draft into a repository.
- Keep the personal branch out of shared project settings when using **Add to this project**. Work pushed to a
  branch is visible to readers of its Git repository. Bring team updates into the personal branch with a Git merge.

Start with **Publish work in progress** and **Switch branch** so the workflow also covers edits made outside the
extension's commands. Add the authoring prompts afterward.

## Smaller follow-ups

- **Show hooks and scripts in the tree.** List the hooks Cursor would load under each plugin, with their event names
  and a way to open the configuration. Give the hook group one checkbox so a teammate can use a plugin's skills and
  rules with its hooks disabled. Keep that choice across syncs and apply it to both full and partial selections.
  Show bundled scripts under their skill or plugin as click-to-open rows without checkboxes. Scripts are files a
  skill or hook can call, so they follow the selection of the skill or plugin that ships them.
- **Author hooks and scripts from the tree.** On a plugin's right-click menu, offer **Add new hook** to choose an
  event and add a command to the plugin's hook configuration. Offer **Add new script** on both plugin and skill
  menus. Create the script in the selected plugin or skill and open it for editing.
- **MCP server readiness.** Show on an MCP server item what it needs and is missing: an environment variable it
  references (a token), its command not on PATH (`npx`, `uvx`, `docker`). Today such a server fails silently in Cursor.
- Search and filter in the view.
- **Pick the files to commit**: checkboxes in Local changes, so **Commit and push** leaves half-done edits out.
- Show in the view the `projectPlugins` entries that match nothing, instead of only in the log (the catalog warnings
  show in the view since request 16).
- Sync when the window gets focus again, if the last check is older than a few minutes.
- Isolated live runs in a Remote-SSH window (not probed).
- Hiding Cursor's sign-in screen during the isolated live runs.
- Running `scripts/live-test.js` on Linux or macOS (not checked: the Cursor path and the kill are written for both, but
  never run).
- **Refresh cost on a large catalog** (2026-11-27 review). Each apply rereads every catalog synchronously, and each
  skill or rule parses and lints its frontmatter three times (`frontmatterField`, `checkItemText`, `itemContext` in
  `catalog.itemChild`). Measure an apply on a catalog of a few hundred items first; reuse one parse result only if it
  shows.

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
