# Team plugins

**Share your team's Cursor rules and skills from one git repository, always up to date, in every project.**

Your team has good rules and skills for Cursor's agent: a code-review checklist, the house style, how to write a
migration, how to release. Without a shared home, they end up copied from project to project, slowly drift apart, and
the improvement someone made last week never reaches the rest of the team.

Team plugins keeps them in one git repository and brings them into Cursor for everyone:

- **One source of truth.** The team's plugins live in a normal git repository. The extension clones it and registers
  the plugins in Cursor: the agent uses them in every chat, in every project.
- **Always current.** The repository is pulled in the background (every hour by default). A skill fixed by a teammate
  reaches you without you doing anything; start a new chat to use it.
- **Only what you need.** Tick whole plugins or single skills and rules in the **Team Plugins** view, so the agent's
  context holds only what is useful to you.
- **Per-project requirements.** A project can require plugins for everyone who opens it, through its committed
  `.vscode/settings.json`.
- **Improve skills where you use them.** Ask the agent to fix a team skill in the middle of your work; the change shows
  in the view and is one click away from being committed and pushed for the whole team.

## Install

### From Cursor's marketplace (recommended)

1. Open the Extensions view (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS).
2. Search for **Team plugins** (publisher `mathieugun`) and click **Install**.

Cursor keeps it up to date like any other extension. The extension is also listed on Open VSX:
https://open-vsx.org/extension/mathieugun/cursor-team-plugins

### From a VSIX file

1. Download `cursor-team-plugins-<version>.vsix` from the releases page:
   https://github.com/mathieugun/cursor-team-plugins/releases
2. Install it, either from the Extensions view (**...** menu > **Install from VSIX...**) or in a terminal:

   ```
   cursor --install-extension cursor-team-plugins-<version>.vsix
   ```

3. Reload the window.

Cursor never updates an extension installed from a VSIX: install the next version the same way, or install from the
marketplace to get updates automatically.

### Remote-SSH windows

In a window connected to a remote machine, Cursor's agent runs on that machine, and so must the extension. In the
Extensions view of the remote window, Team plugins shows **Install in SSH: \<host\>**: click it once per machine, then
reload the window. The team repository is cloned on the remote machine, with that machine's git credentials.

## Getting started

1. **Check that git can reach the team repository.** In a terminal, `git clone <team repository url>` must work
   without asking anything: the extension runs git in the background with your own credentials and never asks for a
   password (see "Repository access" below). Git 2.38 or later is needed.
2. **Point the extension at the repository.** Open the **Team Plugins** view in the activity bar and click **Set
   repository URL** (or set `teamPlugins.repoUrl`). The URL is checked at once, then the repository is cloned in the
   background.
3. **Pick your plugins.** Tick the plugins, skills or rules you want. They are available to the agent right away, in
   new chats.

If a plugin with the same name is already installed from another marketplace (for example the team repository imported
as a local marketplace), remove it: both would provide the same plugin.

## The team repository

A plugin repository as Cursor knows it. The extension finds the plugins in `.cursor-plugin/marketplace.json` at the
root (entries whose `source` is a folder of the repository), or, without that file, in every top-level folder holding a
`.cursor-plugin/plugin.json`.

```
team-plugins/
├── .cursor-plugin/marketplace.json     optional: lists the plugins and their folders
├── review/
│   ├── .cursor-plugin/plugin.json      { "name": "review", "description": "..." }
│   ├── skills/
│   │   ├── code-review/SKILL.md
│   │   └── security-check/SKILL.md
│   └── rules/style.mdc
└── docs/
    ├── .cursor-plugin/plugin.json
    └── skills/write-readme/SKILL.md
```

Skills (`skills/<folder>/SKILL.md`) and rules (`rules/*.mdc` or `rules/*.md`) can be picked one by one; the
`description` of their frontmatter is shown in the view. Anything else in a plugin (agents, commands, hooks,
`mcp.json`) always comes with its plugin.

## Choosing plugins

The view lists every plugin of the team repository with a checkbox, and its skills and rules below it (skills have a
sparkle icon, rules a scales icon). Click a skill or rule to open its file.

- Tick a plugin: all its skills and rules are enabled, including the ones added later.
- Tick single skills or rules: the plugin is enabled partially and only the ticked items reach the agent. Its box stays
  unticked (Cursor's checkboxes have no mixed state), its icon becomes a pie chart and the description shows `2/3`;
  tick the plugin to enable all of it.
- Untick one skill of a fully enabled plugin: it is left out, the rest stays enabled.

Your choice is stored in your user settings and applies to every project:

```json
{
  "teamPlugins.enabled": ["review", "docs/skills/write-readme"],
  "teamPlugins.excluded": ["review/skills/security-check"]
}
```

An item is the plugin `name` (from its `plugin.json`), `<name>/skills/<skill folder>` or `<name>/rules/<file name>`.

### Plugins a project needs

A project can require plugins for everyone who opens it. With the project's folder open, right-click an item in the view
and choose **Add to this project** (or **Remove from this project**), then commit `.vscode/settings.json`:

```json
{
  "teamPlugins.projectPlugins": ["review", "docs/skills/write-readme"]
}
```

The project's list is added to your own choice: a project never disables something you enabled. Items the project
enables are drawn in the project colour with a **P** badge; a plugin that the project enables only in part shows the
badge without the colour. Unticking an item the project enables switches it off and removes it from the project's list
too: commit `.vscode/settings.json` to share that. Each Cursor window shows its own project's plugins.

The colour is the theme colour `teamPlugins.projectItemForeground` (purple by default; change it with
`workbench.colorCustomizations`). Colour and badge follow the `explorer.decorations.colors` and
`explorer.decorations.badges` settings; the item's tooltip always says when the project enables it. Like coloured files
in the Explorer, a selected row shows the selection colour while the view has the focus: the colour comes back when you
select another row or click elsewhere, and the **P** badge stays visible meanwhile.

## Improving a team skill

Ask the agent to change a team skill, as you would any file. The edit always reaches the extension's clone of the team
repository.

The changes appear in a **Local changes** group at the top of the view; click a file to see the diff. To share them:

- **Commit and push** (the cloud icon in the view's title bar) asks for a message, commits every local change, rebases
  it on the team's latest commits and pushes it with your git credentials. Your teammates get it at their next sync.
- **Push to a branch** pushes your changes to a new branch instead (for a protected branch, or to open a pull request)
  and puts the clone back on the team version.
- **Discard local changes** throws them away, after a confirmation that lists what would be lost.

Updates never overwrite your changes: they are kept on top of the team's new commits. Only a real conflict, where a
teammate changed the same lines, pauses the updates until you push your changes to a branch or discard them.

For a partly enabled plugin, the agent edits a copy that holds only your selection, kept in step with the clone both
ways. If the same file changed on both sides (a team update and an edit of yours), nothing is overwritten: the file
shows in a **Conflicts** group at the top of the view; click it to compare, then choose **Keep repository version** or
**Keep copy version**.

A commit records your name and email from git's settings; if they were never set, the message gives the two
`git config --global` commands to run once.

### Working on the plugins in your own clone

If you maintain the team's plugins, set `teamPlugins.localRepoPath` (or run **Use a local clone**) to your own clone
of the repository. The extension then reads your clone live and never runs a git command that changes it: edit,
commit and push with your usual tools.

## Staying up to date

The repository is checked at startup, every `teamPlugins.updateIntervalMinutes` (60 by default, at least 5; `0` means
only at startup) and when you click **Sync now** (the sync icon of the view). After an update, **What changed** in the
notification lists the new commits. Start a new chat to use the new versions.

When the server can't be reached (offline, VPN down), the plugins already cloned keep working and the update is
retried a few minutes later.

## Repository access

The extension never opens a sign-in window and never waits for an answer, so git must reach the repository without
asking anything. Set this up once in a terminal (in a Remote-SSH window, a terminal of that window: it runs on the
remote machine).

- **HTTPS**: sign in once with `git ls-remote <url>`; your credential manager keeps the credentials. On Linux and
  macOS, set up a credential helper first (for example `gh auth setup-git` for GitHub).
- **SSH**: use a key without a passphrase for the team server (keys with a passphrase are not supported), and accept
  the server's host key once with `git ls-remote <url>`. On Windows, keep the ssh that comes with Git for Windows.

When access fails, the notification says why and offers **Open terminal**, which runs `git ls-remote` in a Cursor
terminal where git and SSH can ask their questions; then click **Sync now**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `teamPlugins.repoUrl` | | Git URL of the team repository (HTTPS, `git@host:path` or `ssh://`). |
| `teamPlugins.branch` | | Branch to follow; empty means the repository's default branch. |
| `teamPlugins.updateIntervalMinutes` | `60` | Minutes between update checks; `0`: only at startup and with Sync now. |
| `teamPlugins.enabled` | `[]` | Plugins, skills and rules enabled in every project (edited by the view). |
| `teamPlugins.excluded` | `[]` | Skills and rules left out of plugins listed in `enabled` (edited by the view). |
| `teamPlugins.projectPlugins` | `[]` | Plugins, skills or rules a project requires (workspace or folder settings). |
| `teamPlugins.localRepoPath` | | Your own clone of the team repository, used instead of the managed one. |

## Troubleshooting

- **Output > Team Plugins** shows every git command and every plugin registration. **Output > Cursor Plugins** is
  Cursor's own log (look for `Registered extension plugin: <name>`).
- The status bar item (`Team plugins: <count>`) shows how many plugins this window registered; its tooltip lists them
  with the last commit and the last sync. A warning icon means a paused update, a failed sync or a failed registration;
  a plug-off icon means the server couldn't be reached.
- "vscode.cursor.plugins is missing": this Cursor is too old for extension plugins; update Cursor.

| Message | What to do |
| --- | --- |
| SSH does not know the host key | Open terminal, check the fingerprint with the server's admin, answer yes, Sync now. |
| The SSH host key has changed | Don't accept it: ask the server's admin, then `ssh-keygen -R <host>` and connect again. |
| SSH could not log in | The server doesn't know your key, or the key has a passphrase. Open terminal to see why. |
| No stored credentials / credentials refused | Open terminal, sign in again, Sync now. |
| No access to, or repository not found | Check the repository URL (**Set repository URL**) and ask for access. |
| Branch not found | Check `teamPlugins.branch` (empty: the default branch). |
| No answer for 2 minutes | git was waiting for a question: Open terminal, answer it, Sync now. |
| The server refused the push | A protected branch or no write access: **Push to a branch**, then open a pull request. |

## Known limitations

- Keys with a passphrase are not supported for SSH; use a key without one for the team server.
- Only `skills/` and `rules/` can be picked one by one; plugins from GitHub or URL sources in `marketplace.json` are
  skipped.
- Conflicts are never merged by the extension: you choose to push your changes to a branch, or discard them.
- Commit and push includes every local change; there is no per-file choice.

## Contributing

Issues and pull requests are welcome: https://github.com/mathieugun/cursor-team-plugins

## License

MIT. Copyright (c) 2026 Mathieu Gunther. The full text is in `LICENSE.txt`, in the repository and in the installed
extension's folder.
