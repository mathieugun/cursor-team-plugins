# Team plugins

A Cursor extension that keeps a team's Cursor plugins (rules and skills) in sync with the team's private git
repository, and registers in Cursor only the plugins, skills and rules that you, and the open project, selected.

It replaces importing the repository as a local marketplace: Cursor copies a local marketplace once and never updates
it, so every change to a team plugin needed a manual re-import. This extension pulls the repository on its own and
Cursor picks the changes up live.

## Install

Build the VSIX (see `AGENTS.md`) or take it from the team, then:

```
cursor --install-extension dist/cursor-team-plugins-0.1.0.vsix
```

and reload the Cursor window. The extension has no dependency.

## First setup

1. In Cursor, remove the old local marketplace import of the team repository (a plugin with the same name installed
   from a marketplace conflicts with the one this extension registers).
2. Make sure `git clone <team repository url>` works in a terminal: the extension uses your own git credentials
   (credential manager or SSH agent) and never asks for a password.
3. Open the **Team Plugins** view (activity bar) and choose **Set repository URL**, or set
   `teamPlugins.repoUrl` in the settings. The repository is cloned in the background.

## Picking plugins

The view lists every plugin of the team repository with a checkbox, and its skills and rules below it. Skills have a
sparkle icon and the word `skill` next to their name, rules a scales icon and `rule`. Click a skill or rule to open
its file.

- Tick a plugin: all its skills and rules are enabled, including the ones added later.
- Tick single skills or rules: the plugin is enabled partially (the description shows `2/3`). Only the ticked skills
  and rules are given to Cursor.
- Untick one skill of a fully enabled plugin: it is left out; the rest stays enabled.

Your choice is stored in the user settings (it is the same in every project):

```json
{
  "teamPlugins.enabled": ["plugin-a", "plugin-b/skills/review", "plugin-b/rules/style.mdc"],
  "teamPlugins.excluded": ["plugin-a/skills/old-skill"]
}
```

An item id is the plugin `name` (from its `plugin.json`), `name/skills/<skill folder>` or `name/rules/<file name>`.
`excluded` only applies to plugins listed in `enabled`.

## Plugins for a project

A project can require plugins for everyone who opens it. Commit this in the project's `.vscode/settings.json`:

```json
{
  "teamPlugins.projectPlugins": ["plugin-a", "plugin-b/skills/review"]
}
```

Right-click an item in the view and choose **Add to this project** (or **Remove from this project**) to edit that
list. The project's list is added to your own choice (union): a project never disables something you enabled, and you
cannot untick what the project requires (the view tells you and offers to remove it from the project). Only workspace
and folder settings are read for this list, not the user settings.

Registrations are per Cursor window, so each window shows its own project's plugins.

## Updates

The managed clone is checked at startup, every `teamPlugins.updateIntervalMinutes` (default 60, minimum 5; 0 means
only at startup) and with **Sync now**. Updates are fast-forward only. After an update, start a new chat to use the
changes. **What changed** in the notification lists the new commits in the log.

If the managed clone has local changes or local commits, updates are paused and a warning offers **Discard local
changes** (or run the command "Discard local changes in the managed clone"). If the repository URL or branch setting
changes, the managed clone is cloned again.

## Plugin authors

Set `teamPlugins.localRepoPath` (or **Use a local clone**) to your own clone of the team repository. The extension
then never runs a git command that changes it: edit, commit and push with git as usual. File changes in the clone are
picked up live, no sync is needed.

## How it works

- The managed clone lives in the extension's global storage, in `.cursor/plugins/repo`. The `.cursor/plugins` part of
  the path matters: Cursor lists a `SKILL.md` as a skill only below such a folder.
- For each selected plugin the extension calls `vscode.cursor.plugins.addPlugin({ path })` in every window, at
  startup and whenever the selection or the repository changes. Cursor does not persist these registrations.
- A fully selected plugin is registered from the clone itself, so Cursor sees `git pull` changes directly. A partial
  plugin is registered from a filtered copy (`.cursor/plugins/filtered/<name>-<hash>/<plugin folder>`: Cursor names
  an extension plugin after its folder, so the copy keeps the same name) that holds only the selected
  skills and rules. Windows with the same selection share a copy; copies no window used for a week are deleted.
- Several windows share one clone: a lock file serialises the git commands, and the other windows notice the new
  state through `sync-state.json`.

## Troubleshooting

- **Output > Team Plugins** shows every git command and every registration.
- **Output > Cursor Plugins** is Cursor's own log: look for `Registered extension plugin: <name>`.
- The status bar item (`Team <count>`) shows how many plugins this window registered; its tooltip lists them, the last
  commit and the last sync state. A warning icon means a paused update, a failed sync or a failed registration.
- "vscode.cursor.plugins is missing": this Cursor is too old for extension plugins; update Cursor.

## Limits

- Team marketplace entries whose source is not a folder of the repository (GitHub or URL sources) are skipped.
- Custom component paths declared in `plugin.json` are not read: only `skills/` and `rules/` are selectable; anything
  else (agents, commands, hooks, mcp.json, assets) always comes with its plugin.
- With `localRepoPath` outside a `.cursor/plugins` folder, Cursor may list the skills among the rules; the agent
  still gets them.
- Enterprise teams whose admin turned off "Allow Local Plugin Imports": not tested whether it also blocks extension
  plugins.
- A plugin with the same name installed from a marketplace (for example the old local marketplace import) conflicts:
  remove that import first.
- The extension does not update itself: install the new VSIX by hand (`cursor --install-extension <file>`).

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Mathieu Gunther.
