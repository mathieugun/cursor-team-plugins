# The team repository

A team repository is a git repository holding your team's Cursor plugins. Ask your team for its URL.

Click **Add repository** and paste the URL, in any of these forms:

- `https://example.com/org/team-plugins.git`
- `git@example.com:org/team-plugins.git`
- `ssh://git@example.com/org/team-plugins.git`

The URL is checked at once, then the repository is cloned in the background. It is checked for updates every hour
(`teamPlugins.updateIntervalMinutes`), and **Sync now** in the view checks at once.

To follow a branch other than the repository's default one, edit `teamPlugins.repositories` in your user settings:
`{ "url": "...", "branch": "next" }`. Follow one repository per team, or as many as you need.

**Plugin authors**: **Add a local clone** follows a clone you already have. Your edits are picked up live, and the
extension never runs a git command that changes it.
