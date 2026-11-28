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
- **Write new plugins and skills.** Create a plugin as a draft that stays on your machine until it is ready, then move
  it to a repository; scaffold a skill, rule, command, agent or MCP server in any plugin with one command, or share a
  rule or skill that started in a project.

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

**Team Plugins: Get started** (command palette, or **Get started** in the view's **...** menu) opens a walkthrough of
these steps; Cursor also opens it after the install.

1. **Check that git can reach the team repository.** In a terminal, `git clone <team repository url>` must work
   without asking anything: the extension runs git in the background with your own credentials and never asks for a
   password (see "Repository access" below). Git 2.38 or later is needed. **Team Plugins: Check git** says whether git
   is found and recent enough, and whether it knows your name and email (needed only to commit).
2. **Add the repository.** Open the **Team Plugins** view in the activity bar and click **Add repository** (the `+` of
   the view's title bar, or add the URL to `teamPlugins.repositories`). The URL is checked at once, then the repository
   is cloned in the background. You can add several repositories (see "Several repositories").
3. **Pick your plugins.** Tick the plugins or single items (skills, rules, commands, agents, MCP servers) you want.
   They are available to the agent right away, in new chats.

The walkthrough ticks a step when you do it (check git, add a repository, tick a plugin); if you were set up before,
use **Mark Done**.

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
its file in a preview tab (for an MCP server, its `mcp.json`); the view keeps the focus.

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

### Context cost

Everything the agent reads in every chat takes room in its context. The view estimates what your selection costs:

- Next to the view's title: `~41 tokens per chat`, the total of this window's selection (your choice and the project's
  together). The status bar tooltip gives the same total with its breakdown.
- An enabled plugin's row ends with its own `~41 tokens`. Its tooltip says where that comes from:
  `In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)`, then a `For matching files` line for the
  rules that apply only to some files. An unticked plugin's tooltip says what it would cost: `If enabled, in every
  chat: ...`. A partly enabled plugin counts only its ticked items.
- A rule's tooltip says how it applies: always, to files matching its globs, when the agent asks for it, or only when
  you mention it. A rule that applies always reads `rule · always` in the view.
- A skill's tooltip says what it costs in every chat: its description.

What counts in every chat: the text of always-applied rules (and of a skill with `alwaysApply: true`), and the
descriptions of skills and of agent-requested rules (Cursor cuts a description at 1536 characters). A rule that applies
to matching files is shown apart and is not in the total. A skill with `disable-model-invocation: true` is not offered to
the agent and does not count.

It is an estimate, at 4 characters per token: Cursor builds the prompt on its server.

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
- **Push to a branch** pushes your changes to a new branch instead (for a protected branch, or to have them reviewed)
  and puts the clone back on the team version (edits saved during the push stay as local changes; if one changed a
  file of the pushed commit, or a change was staged or an ignored file would be overwritten, the clone is left as it
  is and the message says so). Its message offers **Open pull request**, which opens the hosting service's page to
  propose the branch as a pull request (GitHub, GitLab and Azure DevOps; other servers when they print that page's
  address on the push).
- **Discard local changes** throws them away, after a confirmation that lists what would be lost.

Before pushing, the extension checks the plugins you changed for what Cursor silently drops or misreads: frontmatter
that isn't valid YAML, a skill or agent without a description, an agent with no instructions, two skills with one name,
JSON that doesn't parse in `marketplace.json`, `plugin.json` or `mcp.json`, conflict markers. If it finds any, it stops
and lists them: **Push anyway** pushes regardless, **Open files** opens them. The same problems show in the view (an
error or warning icon, `· problem` on the row, the message in the tooltip) and in the Problems panel, where Cursor's
agent can read them with its lint tool after its edits. The most common fix: put a value that contains `: ` (or starts with `*`, `[`, `@`...) in
quotes, e.g. `globs: "*.ts"`.

Updates never overwrite your changes: they are kept on top of the team's new commits. Only a real conflict, where a
teammate changed the same lines, pauses the updates until you push your changes to a branch or discard them.

For a partly enabled plugin, the agent edits a copy that holds only your selection, kept in step with the clone both
ways. If the same file changed on both sides (a team update and an edit of yours), nothing is overwritten: the file
shows in a **Conflicts** group of its repository; click it to compare, then choose **Keep repository version** or
**Keep copy version**. A choice is applied only if neither version changed since you chose; otherwise nothing is
replaced and you are told. A folder that can't be read is left alone on both sides, with a warning, until it can be
read again. Renaming a file or folder only in case (`readme.md` -> `README.md`) is carried to the other side, never
read as a deletion.

A commit records your name and email from git's settings; if they were never set, the message gives the two
`git config --global` commands to run once.

### Working on the plugins in your own clone

If you maintain the team's plugins, add your own clone of the repository to `teamPlugins.localRepositories` (or run
**Add a local clone**). The extension then reads your clone live and never runs a git command that changes it: edit,
commit and push with your usual tools. The clone replaces the repository you follow by URL that has the same name (the
`name` of its `marketplace.json`), so you keep working on your version of the plugins while the others follow the
team's.

## Writing plugins

- **New plugin** (the **...** menu of the view's title bar, or right-click a repository) asks where to create it, then
  for a name and a description. A name uses lowercase letters, digits, hyphens and dots, as Cursor requires. The plugin
  is enabled for you in full and its `plugin.json` opens in the editor.
  - **drafts** keeps the plugin only on this machine (in the extension's storage; in a Remote-SSH window, on the remote
    machine), in a **drafts** group that shows up once it holds a plugin. Nothing is pushed and nothing is backed up.
  - In a repository you follow, the new folder is a local change of its managed clone until you **Commit and push**
    it. In your own clone it is new files for your own git tools.
  - When the repository's `marketplace.json` lists its plugins, the new plugin is added to that list.
- **Move to a repository** (right-click a draft plugin) copies it to a repository you follow or to your own clone and
  deletes the draft. The ids in your selection follow the plugin. In a managed clone the plugin appears in **Local
  changes**: commit and push it to share it with the team. A draft can't be added to a project.
- **Rename** (right-click a plugin or an item, or select it in the view and press F2) renames:
  - a plugin: its folder, the `name` of its `plugin.json` and its entry in the repository's `marketplace.json`;
  - a skill: its folder and the `name` in its `SKILL.md`; a rule, command or agent: its file and its `name` when it has
    one; an MCP server: its key in `mcp.json` (and `.mcp.json`), edited in place so the file keeps its comments and
    layout.

  A plugin that is the repository's root folder (`source: "."` in `marketplace.json`) can't be renamed, nor can the
  folder of `metadata.pluginRoot`: Cursor names a plugin after its folder, and renaming either would move the clone or
  every plugin below it. Your selection follows. In a repository (not in the drafts) the rename is recorded in
  `marketplace.json` (a `renamed` list of old to new ids), so your teammates' choices and the projects' lists follow
  the new name at their next sync instead of silently losing the item. It is a local change like any other: in a
  managed clone it shows in **Local changes**, commit and push it to share it.
- **Share with team...** copies a rule, skill, command or agent that lives in a project's `.cursor` folder into a
  plugin. Right-click it in the Explorer (several at once; for a skill, its folder or its `SKILL.md`), or run the
  command from the command palette: it lists the project's items and your personal skills, commands and agents of
  `~/.cursor`.
  - Pick a plugin, or **New plugin...** to create one on the way.
  - A skill is copied with its whole folder (links inside it are left out and reported); a rule from a subfolder of
    `.cursor/rules` goes straight into the plugin's `rules`.
  - A name Cursor would refuse, or one the plugin already has, is asked for again.
  - The copy is enabled for you and is a local change like a new item (in a managed clone, in **Local changes**).
  - The original stays in the project: the closing message offers to move it to the trash, so the agent doesn't read
    it twice. A Remote-SSH window has no trash: there the button deletes the original for good, after you confirm it.
  - The palette lists only the `.cursor` folders at the root of each workspace folder; right-click works on any
    `.cursor` folder shown in the Explorer.
- **New skill**, **New rule**, **New command**, **New agent** and **New MCP server** (right-click a plugin, or the
  command palette) ask for a name and write the file in the plugin's folder, then enable it for you and open it:
  - a skill is `skills/<name>/SKILL.md`, a rule `rules/<name>.mdc`, a command `commands/<name>.md` and an agent
    `agents/<name>.md`, each with a frontmatter holding the description you typed and a body to fill in;
  - an MCP server is added to the plugin's `mcp.json` (to `.mcp.json` when that is the only one there is), from a
    command line or a URL; an existing file is edited in place, so its comments and layout stay. In an `mcp.json` that
    lists its servers at the top level (without `mcpServers`), the name `mcpServers`, the metadata keys (`author`,
    `owner`, `source`, `metadata`) and a key the file already has are refused (Rename too);
  - a name or description that YAML would read as something else (a date, `true`, a number) is written in quotes, so
    it reads back as you typed it.

  A kind whose paths the plugin's `plugin.json` sets gets no file: Cursor would ignore it, so add it there by hand.
- Nothing is ever written outside the repository: a destination that leads outside it (a `..` in
  `metadata.pluginRoot`, or a link to another folder or file) is refused before anything is written.

An edited `marketplace.json` or `mcp.json` is rewritten with two-space indentation.

## Staying up to date

The repositories are checked at startup, every `teamPlugins.updateIntervalMinutes` (60 by default, at least 5; `0`
means only at startup) and when you click **Sync now** (the sync icon of the view). Start a new chat to use the new
versions.

After an update, the notification says who changed what ("Alice updated code-review"). The view marks the items added
or updated since you last looked (`new` or `updated` after the item's kind, a coloured `N` or `M`), shows the counts on
the plugin and repository rows and a number on the view's icon. **What changed** (in the notification, on a
repository's right-click menu, or in the command palette) lists them and opens each one's diff against the version you
last saw; **Show changes** on an item does the same, or shows its last change when it has no mark. Opening an item's
diff or its file marks it seen, and **Mark all as seen** clears a repository. Your own changes are never marked. The
tooltip of an item or plugin says who last changed it, and when.

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
- A skill, rule, command or agent that is missing in Cursor: look at its row in the view; an error icon says why Cursor
  drops it (hover it for the message).
- "vscode.cursor.plugins is missing": this Cursor is too old for extension plugins; update Cursor.
- "git was not found": install git (2.38 or later) and restart Cursor, or set `git.path`; **Team Plugins: Check git**
  checks it again.

| Message | What to do |
| --- | --- |
| SSH does not know the host key | Open terminal, check the fingerprint with the server's admin, answer yes, Sync now. |
| The SSH host key has changed | Don't accept it: ask the server's admin, then `ssh-keygen -R <host>` and connect again. |
| SSH could not log in | The server doesn't know your key, or the key has a passphrase. Open terminal to see why. |
| No stored credentials / credentials refused | Open terminal, sign in again, Sync now. |
| No access to, or repository not found | Check its URL in `teamPlugins.repositories` and ask for access. |
| Branch not found | Check its `branch` in `teamPlugins.repositories` (none: the default branch). |
| No answer for 2 minutes | git was waiting for a question: Open terminal, answer it, Sync now. |
| The server refused the push | A protected branch or no write access: **Open a pull request** pushes your changes to a new branch and opens the page to propose them. With no write access at all, ask for it (pull requests from a fork are not supported). |

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
- Renaming a repository (the `name` of its `marketplace.json`) keeps the choices of the people who already follow it;
  someone who starts following it later has to add a project's items once more.
- A rename doesn't update references to the old name inside other files (a skill that names another, a rule that links
  a file).
- Two branches of one repository can't be followed at the same time.
- Two plugins in folders of the same name (in different repositories): the second is registered as
  `<folder>-<repository>`, and the agent knows it under that name.
- **Remove repository** keeps the clone in the extension's storage.
- Drafts are only on this machine and are not backed up: move a plugin to a repository to keep it safe.
- Writing a plugin rewrites the formatting of the `marketplace.json` or `mcp.json` it edits.
- Share with team copies only rules, skills, commands and agents (not the MCP servers of `.cursor/mcp.json`, nor
  `AGENTS.md`); links from the item to other project files are copied as they are and may break.
- An MCP server is credited to whoever last changed its plugin's MCP file.
- Who last changed an item is read from the last 1000 commits.
- The context cost counts only the team plugins' skills and rules: not the tool definitions of MCP servers, the
  descriptions of agents, commands, nor your project's own rules and skills and your user rules; the text Cursor adds
  around each description is not counted, and `globs` on a skill is ignored (the skill counts by its description).

## Contributing

Issues and pull requests are welcome: https://github.com/mathieugun/cursor-team-plugins

## License

MIT. Copyright (c) 2026 Mathieu Gunther. The full text is in `LICENSE.txt`, in the repository and in the installed
extension's folder.
