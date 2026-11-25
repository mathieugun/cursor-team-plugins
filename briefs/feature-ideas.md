# Feature ideas

Ideas from the 2026-11-22 review, not yet planned. Remote-SSH windows (brief 04), several repositories (brief 05) and a reliable remote repository (brief 06) already
have briefs. Each idea below becomes a brief when it's picked.

## Top picks

1. **Review executable changes before they run.** When an update changes hooks, MCP servers or scripts, show the diff
   and ask before applying it. Today a team commit reaches everyone's agent with no check.
2. **Open a pull request instead of pushing to main.** After **Push to a branch**, or when a push is refused by branch
   protection, open the hosting service's page that creates a pull request (GitHub, GitLab, Azure DevOps). Skill
   changes then get a review.
3. **"New in the team repo".** Remember which plugins and skills the user has seen, and mark new ones (a badge on the
   view, a "new" label on the items).
4. **Team presets and recommended plugins.** The repository declares recommended plugins and named presets
   ("backend", "data"). A new user gets a sensible selection in one click.
5. **Pick files to commit, and check before pushing.** Checkboxes in Local changes, plus checks before pushing:
   frontmatter present, name and description valid, no conflict markers.

## Selection and discovery

- Make commands, agents and MCP servers selectable, not only skills and rules.
- Search and filter in the view.
- Project suggestions: a plugin declares file patterns (for example `**/*.py`), and the extension suggests it when a
  matching project is opened.
- Show in the view the catalog warnings and the `projectPlugins` entries that match nothing, instead of only in the log.
- Preview a skill (frontmatter and body) before enabling it.

## Updates and versions

- Pin a tag or commit, and roll back the last update if it broke something.
- Channels: stable and beta branches, chosen per user.
- Sync when the window gets focus again, if the last check is older than a few minutes.
- One window runs the update timer for all windows. Mostly done in 0.2.3: a timed sync is skipped when another
  window synced less than half an interval ago (`recentlySynced`); what's left is one timer instead of one per window.
- **What changed** opens a real diff of the update, per plugin, instead of a list of commits in the log.

## Authoring and contribution

- Who last changed a skill, and when, in its tooltip.
- A commit message proposed from the list of changed files.

## Organisation

- A company index repository that lists the team repositories, so users subscribe to teams from the view (follow-up
  to brief 05).
- Self-update: the team repository carries the VSIX, and the extension offers to install a newer one.
