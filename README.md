# Team plugins

**Share your team's Cursor rules, skills, commands, agents and MCP servers from git repositories, always up to date,
in every project.**

Your team has good rules and skills for Cursor's agent: a code-review checklist, the house style, how to write a
migration, how to release. Without a shared home, they end up copied from project to project, slowly drift apart, and
the improvement someone made last week never reaches the rest of the team.

Team plugins keeps them in git repositories, one per team, and brings them into Cursor for everyone:

- **One source of truth.** The team's plugins live in a normal git repository. The extension clones it and registers
  the plugins in Cursor: the agent uses them in every chat, in every project. Follow one repository per team: you can
  follow several.
- **Always current.** The repositories are pulled in the background (every hour by default). A skill fixed by a
  teammate reaches you without you doing anything; start a new chat to use it.
- **Only what you need.** Tick whole plugins or single skills, rules, commands, agents and MCP servers in the **Team
  Plugins** view, so the agent's context holds only what is useful to you.
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
reload the window. The team repositories are cloned on the remote machine, with that machine's git credentials.

## Getting started

1. **Check that git can reach the team repository.** In a terminal, `git clone <team repository url>` must work
   without asking anything: the extension runs git in the background with your own credentials and never asks for a
   password (see "Repository access" below). Git 2.38 or later is needed.
2. **Add the repository.** Open the **Team Plugins** view in the activity bar and click **Add repository** (the `+` of
   the view's title bar, or add the URL to `teamPlugins.repositories`). The URL is checked at once, then the repository
   is cloned in the background. You can add several repositories (see "Several repositories").
3. **Pick your plugins.** Tick the plugins or single items (skills, rules, commands, agents, MCP servers) you want.
   They are available to the agent right away, in new chats.

If a plugin with the same name is already installed from another marketplace (for example the team repository imported
as a local marketplace), remove it: both would provide the same plugin.

## The team repository

A plugin repository as Cursor knows it. The extension finds the plugins in `.cursor-plugin/marketplace.json` at the
root (entries whose `source` is a folder of the repository), or, without that file, in every top-level folder holding a
`.cursor-plugin/plugin.json`.

Give the repository a `name` in `marketplace.json`: it names the repository in the view and in every id
(`<repository>:<plugin>`). The file may hold only that `name`: the plugins are then found by folder. Without a name,
the last part of the URL is used (`team-plugins` for `https://example.com/org/team-plugins.git`).

```
team-plugins/
├── .cursor-plugin/marketplace.json     optional: { "name": "team-test", "plugins": [...] }
├── review/
│   ├── .cursor-plugin/plugin.json      { "name": "review", "description": "..." }
│   ├── skills/
│   │   ├── code-review/SKILL.md
│   │   └── security-check/SKILL.md
│   ├── rules/style.mdc
│   ├── commands/review-pr.md           a command
│   ├── agents/reviewer.md              an agent
│   └── mcp.json                        MCP servers: { "mcpServers": { "lint": {...}, "tickets": {...} } }
└── docs/
    ├── .cursor-plugin/plugin.json
    └── skills/write-readme/SKILL.md
```

Skills (`skills/<folder>/SKILL.md`), rules (`rules/*.mdc` or `rules/*.md`), commands (`commands/*.md`, `.mdc`,
`.markdown` or `.txt`), agents (`agents/*.md`, `.mdc` or `.markdown`) and MCP servers (each server of `mcp.json` or
`.mcp.json`) can be picked one by one; the `description` of their frontmatter is shown in the view (for an MCP server,
its command or URL). Hooks and anything else in a plugin always come with its plugin.

An MCP server you leave out is removed from the plugin's copy of `mcp.json`. Edit `mcp.json` in the team repository,
not in that copy: an edit in the copy is kept but never shared, and is reported in the log.

## Several repositories

Follow one repository per team, or as many as you need: click **Add repository** again, or list them in the user
setting `teamPlugins.repositories` (a URL, or `{ "url": "...", "branch": "..." }` for a branch other than the
repository's default one):

```json
{
  "teamPlugins.repositories": [
    "https://example.com/org/team-plugins.git",
    { "url": "git@example.com:org/other-team.git", "branch": "next" }
  ]
}
```

- The view groups the plugins by repository. Each repository row shows its state (up to date, updating, offline, an
  error...); its tooltip gives the URL, the folder of the clone, the last commit and the last check.
- A repository is told apart by its name (see above). With two repositories of the same name, the first one in the
  list wins; a local clone (see "Working on the plugins in your own clone") always wins over a repository you follow
  by URL. The other one shows `same name as ...: not loaded` (rename it in its `marketplace.json`) or `replaced by
  your local clone`. The same repository listed twice, even written two ways (`https://...` and `git@...`), is loaded
  once; the second entry shows `listed twice: not loaded`.
- Cursor names a plugin after its folder. When two repositories have a plugin in a folder of the same name, the
  second plugin is registered from a copy in a folder called `<folder>-<repository>`, so that both load.
- A repository that fails (no access, offline) never blocks the others: each one is synced on its own, and its row
  shows the error.
- **Remove repository** (right-click a repository) stops following it: its plugins are unregistered. Its clone stays on
  disk, and so do your local changes in it.

## Choosing plugins

The view lists every plugin of each repository with a checkbox, and its items below it (skills have a sparkle icon,
rules a scales icon, commands a terminal icon, agents a robot icon and MCP servers a plug icon). Click an item to open
its file (for an MCP server, its `mcp.json`).

- Tick a plugin: all its items are enabled, including the ones added later.
- Tick single items: the plugin is enabled partially and only the ticked items reach the agent. Its box stays
  unticked (Cursor's checkboxes have no mixed state), its icon becomes a pie chart and the description shows `2/3`;
  tick the plugin to enable all of it.
- Untick one item of a fully enabled plugin: it is left out, the rest stays enabled.

Your choice is stored in your user settings and applies to every project:

```json
{
  "teamPlugins.enabled": ["team-test:review", "team-test:docs/skills/write-readme"],
  "teamPlugins.excluded": ["team-test:review/skills/security-check"]
}
```

An item is `<repository>:<plugin>`, `<repository>:<plugin>/skills/<skill folder>`,
`<repository>:<plugin>/rules/<file name>`, `<repository>:<plugin>/commands/<file name>`,
`<repository>:<plugin>/agents/<file name>` or `<repository>:<plugin>/mcp/<server name>`: the repository is its
name (see "The team repository") and the plugin is the `name` from its `plugin.json`.

### Plugins a project needs

A project can require plugins for everyone who opens it. With the project's folder open, right-click an item in the view
and choose **Add to this project** (or **Remove from this project**), then commit `.vscode/settings.json`:

```json
{
  "teamPlugins.projectPlugins": ["team-test:review", "team-test:docs/skills/write-readme"],
  "teamPlugins.projectRepositories": [{ "name": "team-test", "url": "https://example.com/org/team-plugins.git" }]
}
```

**Add to this project** also records where the repository is (`teamPlugins.projectRepositories`, with the URL and
branch you follow it with; a user name or token in an HTTPS URL is left out). A teammate who does not
follow that repository yet is told: a notification and an entry at the top of the view say that the project uses
plugins from it, with an **Add repository** button. Nothing is added until they click it.

The project's list is added to your own choice: a project never disables something you enabled. Items the project
enables are drawn in the project colour with a **P** badge; a plugin that the project enables only in part shows the
badge without the colour. Unticking an item the project enables switches it off and removes it from the project's list
too: commit `.vscode/settings.json` to share that. Each Cursor window shows its own project's plugins.

Project lists written by 0.4 (ids without a repository, such as `review`) keep working: they are read as
`<repository>:<id>`.

The colour is the theme colour `teamPlugins.projectItemForeground` (purple by default; change it with
`workbench.colorCustomizations`). Colour and badge follow the `explorer.decorations.colors` and
`explorer.decorations.badges` settings; the item's tooltip always says when the project enables it. Like coloured files
in the Explorer, a selected row shows the selection colour while the view has the focus: the colour comes back when you
select another row or click elsewhere, and the **P** badge stays visible meanwhile.

## Improving a team skill

Ask the agent to change a team skill, as you would any file. The edit always reaches the extension's clone of the team
repository.

The changes appear in a **Local changes** group of the repository they belong to (each repository has its own); click
a file to see the diff. The commands below act on the repository you click; from the title bar or the command palette,
Cursor asks which one when several have changes. To share them:

- **Commit and push** (the cloud icon in the view's title bar, or the icon of the group) asks for a message, commits
  every local change of that repository, rebases it on the team's latest commits and pushes it with your git
  credentials. Your teammates get it at their next sync.
- **Push to a branch** pushes your changes to a new branch instead (for a protected branch, or to open a pull request)
  and puts the clone back on the team version.
- **Discard local changes** throws them away, after a confirmation that lists what would be lost.

Updates never overwrite your changes: they are kept on top of the team's new commits. Only a real conflict, where a
teammate changed the same lines, pauses the updates until you push your changes to a branch or discard them.

For a partly enabled plugin, the agent edits a copy that holds only your selection, kept in step with the clone both
ways. If the same file changed on both sides (a team update and an edit of yours), nothing is overwritten: the file
shows in a **Conflicts** group of its repository; click it to compare, then choose **Keep repository version** or
**Keep copy version**.

A commit records your name and email from git's settings; if they were never set, the message gives the two
`git config --global` commands to run once.

### Working on the plugins in your own clone

If you maintain the team's plugins, add your own clone of the repository to `teamPlugins.localRepositories` (or run
**Add a local clone**). The extension then reads your clone live and never runs a git command that changes it: edit,
commit and push with your usual tools. The clone replaces the repository you follow by URL that has the same name (the
`name` of its `marketplace.json`), so you keep working on your version of the plugins while the others follow the
team's.

## Staying up to date

The repositories are checked at startup, every `teamPlugins.updateIntervalMinutes` (60 by default, at least 5; `0`
means only at startup) and when you click **Sync now** (the sync icon of the view). After an update, **What changed**
in the notification lists the new commits. Start a new chat to use the new versions.

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
| `teamPlugins.repositories` | `[]` | The repositories to follow: Git URLs (HTTPS, `git@host:path` or `ssh://`) or `{ "url", "branch" }` objects (no branch: the default branch). |
| `teamPlugins.localRepositories` | `[]` | Your own clones of plugin repositories; each replaces the followed repository of the same name. |
| `teamPlugins.updateIntervalMinutes` | `60` | Minutes between update checks; `0`: only at startup and with Sync now. |
| `teamPlugins.enabled` | `[]` | Plugins and single items (`<repository>:<plugin>...`) enabled in every project (edited by the view). |
| `teamPlugins.excluded` | `[]` | Items (skills, rules, commands, agents, MCP servers) left out of plugins listed in `enabled` (edited by the view). |
| `teamPlugins.projectPlugins` | `[]` | Plugins or single items a project requires (workspace or folder settings). |
| `teamPlugins.projectRepositories` | `[]` | Where a project's repositories are, so a teammate can add them (written by Add to this project). |

## Troubleshooting

- **Output > Team Plugins** shows every git command and every plugin registration. **Output > Cursor Plugins** is
  Cursor's own log (look for `Registered extension plugin: <name>`).
- The status bar item (`Team plugins: <count>`) shows how many plugins this window registered; its tooltip has one line
  per repository (state, last commit, last check) and lists the registered plugins. A warning icon means a paused
  update, a failed sync, a repository that is not loaded or a failed registration; a plug-off icon means a server
  couldn't be reached.
- "vscode.cursor.plugins is missing": this Cursor is too old for extension plugins; update Cursor.

| Message | What to do |
| --- | --- |
| SSH does not know the host key | Open terminal, check the fingerprint with the server's admin, answer yes, Sync now. |
| The SSH host key has changed | Don't accept it: ask the server's admin, then `ssh-keygen -R <host>` and connect again. |
| SSH could not log in | The server doesn't know your key, or the key has a passphrase. Open terminal to see why. |
| No stored credentials / credentials refused | Open terminal, sign in again, Sync now. |
| No access to, or repository not found | Check its URL in `teamPlugins.repositories` and ask for access. |
| Branch not found | Check its `branch` in `teamPlugins.repositories` (none: the default branch). |
| No answer for 2 minutes | git was waiting for a question: Open terminal, answer it, Sync now. |
| The server refused the push | A protected branch or no write access: **Push to a branch**, then open a pull request. |

## Upgrading from 0.4

- Your settings move on their own: `teamPlugins.repoUrl` and `teamPlugins.branch` become an entry of
  `teamPlugins.repositories`, and `teamPlugins.localRepoPath` an entry of `teamPlugins.localRepositories`.
- The clone of 0.4 is reused for the entry with the same URL, local changes included.
- Your selections (`enabled`, `excluded`) are rewritten to ids with the repository name (`review` becomes
  `<repository>:review`) once the repository is read.
- A project's `projectPlugins` written by 0.4 keeps working; it is rewritten the next time you add or remove an item of
  the project.
- The partial copies of partly enabled plugins are built again in new folders, once.

## Known limitations

- Keys with a passphrase are not supported for SSH; use a key without one for the team server.
- Hooks, and commands or agents in subfolders, always come with their plugin; so do the commands, agents or MCP
  servers of a plugin whose `plugin.json` sets their paths. Plugins from GitHub or URL sources in `marketplace.json` are
  skipped.
- Conflicts are never merged by the extension: you choose to push your changes to a branch, or discard them.
- Commit and push includes every local change; there is no per-file choice.
- Renaming a repository (the `name` of its `marketplace.json`) changes the ids of all its plugins: you pick them again,
  and the projects' lists are updated.
- Two branches of one repository can't be followed at the same time.
- Two plugins in folders of the same name (in different repositories): the second is registered as
  `<folder>-<repository>`, and the agent knows it under that name.
- **Remove repository** keeps the clone in the extension's storage.

## Contributing

Issues and pull requests are welcome: https://github.com/mathieugun/cursor-team-plugins

## License

MIT. Copyright (c) 2026 Mathieu Gunther. The full text is in `LICENSE.txt`, in the repository and in the installed
extension's folder.
