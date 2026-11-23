# Team plugins

A Cursor extension that keeps a team's Cursor plugins (rules and skills) in sync with the team's private git
repository, and registers in Cursor only the plugins, skills and rules that you, and the open project, selected.

It replaces importing the repository as a local marketplace: Cursor copies a local marketplace once and never updates
it, so every change to a team plugin needed a manual re-import. This extension pulls the repository on its own and
Cursor picks the changes up live.

## Install

In Cursor's Extensions view, search **Team plugins** (publisher `mathieugun`) and install it. Cursor updates it like
any other extension (its marketplace is Open VSX: https://open-vsx.org/extension/mathieugun/cursor-team-plugins).

Or download the VSIX from the GitHub releases (https://github.com/mathieugun/cursor-team-plugins/releases) and run
`cursor --install-extension cursor-team-plugins-<version>.vsix`, then reload the window. A VSIX install is pinned:
Cursor never updates it; install from the Extensions view to get updates.

Upgrading from 0.4.0 or earlier (publisher `mg`): uninstall the old **Team plugins** first (the new one warns while it
is installed: both would register the same plugins). Settings and selections are kept; the team repository is cloned
again into the new extension's storage.

The extension has no dependency.

## First setup

1. In Cursor, remove the old local marketplace import of the team repository (a plugin with the same name installed
   from a marketplace conflicts with the one this extension registers).
2. Make sure `git clone <team repository url>` works in a terminal: the extension uses your own git credentials
   (credential manager, credential helper or SSH key) and never asks for a password. Git 2.38 or later is needed: the
   extension finds conflicts with `git merge-tree --write-tree` before an update, and an older git makes every update
   fail with a message saying so.
3. Open the **Team Plugins** view (activity bar) and choose **Set repository URL**, or set
   `teamPlugins.repoUrl` in the settings. The URL is checked as soon as it is set (a message says that the server
   answers, or why it doesn't), then the repository is cloned in the background.

## Remote repository setup

The extension runs git in the background, where git can't ask you anything: it never opens a sign-in window and never
waits for a typed answer. So SSH and HTTPS must work without questions once, which you set up in a terminal.

**SSH** (`git@host:path` or `ssh://`):

- Use the ssh that comes with Git for Windows (the default). Windows' own OpenSSH and PuTTY's plink can wait silently
  for a question the extension can't show (see "Limits").
- Use a key without a passphrase for the team server (keys with a passphrase are not supported yet, see "Limits"),
  for example a key only for that server: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/id_ed25519_team`, and in
  `~/.ssh/config` a `Host <server>` entry with `IdentityFile ~/.ssh/id_ed25519_team` and `IdentitiesOnly yes`.
- The first connection to a server must accept its host key once: run `git ls-remote <url>` in a terminal, check the
  fingerprint it shows against the one the server's admin gives you, and answer yes.

**HTTPS**:

- Git Credential Manager keeps your credentials: sign in once in a terminal with `git ls-remote <url>`. The extension
  never opens a sign-in window, so a background sync never waits on a hidden one.
- On Linux and macOS (and on the remote machine of a remote window), git keeps credentials only with a credential
  helper: for example `git config --global credential.helper store` (a plain-text file readable only by you) or
  `gh auth setup-git`, then sign in once with `git ls-remote <url>` (a token as the password for GitHub).

When something is wrong, the message tells what to do. The **Open terminal** button runs
`git ls-remote -- <url> HEAD` in a Cursor terminal, where SSH and the credential manager can ask their questions; then
choose **Sync now**.

| Message | What to do |
| --- | --- |
| SSH does not know the host key (first connection) | Open terminal, check the fingerprint, answer yes, Sync now. |
| The SSH host key has changed | Don't accept it: ask the server's admin for the new fingerprint, then `ssh-keygen -R <host>` and connect again. Nothing is synced until then. |
| SSH could not log in | No key, a key the server doesn't know (add the public key on the server), or a key with a passphrase (not supported yet). Open a terminal to see what SSH says, then Sync now. |
| No stored credentials | Open terminal and sign in once, then Sync now. |
| The server refused your credentials | Wrong password, or an expired or revoked token: open a terminal and sign in again, then Sync now. |
| No access to, or repository not found | Check `teamPlugins.repoUrl` (**Set repository URL**) and ask for access. |
| Branch not found | Check `teamPlugins.branch` (empty: the repository's default branch). |
| Cannot reach the server | Offline, VPN down or DNS: nothing to do, the update is retried after 5 minutes. |
| No answer for 2 minutes | git was stopped, often because SSH waited for a question: Open terminal, answer it, Sync now. |
| The server refused the push | A protected branch or no write access: **Push to a branch**, then open a pull request. |

## Remote windows (Remote-SSH)

In a window connected to a remote machine, Cursor's agent runs on that machine, so the extension must run there too:
install it once per remote machine. In the Extensions view of the remote window, Team plugins shows **Install in SSH:
<host>**; click it and reload the window. Cursor updates it there like on your computer (when installed from the
Extensions view); with a VSIX, run `cursor --install-extension <file>.vsix --force` in a terminal of the remote window,
then reload the window.

What runs on the remote machine:

- The managed clone and the partial copies, in the extension's storage there
  (`~/.cursor-server/data/User/globalStorage/mathieugun.cursor-team-plugins`).
- git (2.38 or later, on that machine's PATH or `git.path` in the remote settings), with that machine's credentials
  and SSH keys: set them up in a terminal of the remote window (it opens on the remote machine), as in "Remote
  repository setup". The error messages name the machine.

Settings: the repository URL, the branch, the update interval and your selection (`enabled`, `excluded`) are user
settings, the same in local and remote windows. `teamPlugins.localRepoPath` is set per machine: in a remote window it
is a path on the remote machine (stored in its remote settings). A project's `projectPlugins` is read from the remote
project's `.vscode/settings.json`.

Each machine has its own clone: an agent's edit in a remote window lands in that machine's clone and shows in its
Local changes; commit and push it from a window on that machine. Other machines get it at their next sync. Several
windows on the same remote machine share its clone, as local windows do.

The status bar tooltip shows `Machine: <host> (remote window)`.

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

## Changing a team skill

Ask the agent to change a team skill, as you would any file. Where the edit lands depends on how the plugin is enabled:

- A fully enabled plugin is registered from the managed clone, so the agent edits the clone directly.
- A partly enabled plugin is registered from a partial copy. The extension keeps that copy and the clone in step both
  ways (a file changed, added or deleted on one side is carried to the other), so the edit always reaches the clone.
  If the same file changed on both sides since the last sync (a team update and an agent edit), nothing is overwritten:
  the file shows in a **Conflicts** group at the top of the view, click it to compare the two versions, then choose
  **Keep repository version** or **Keep copy version**.

The edits show up in the view, in a **Local changes** group at the top (the number of files and of unpushed commits is
next to its name). Click a file to see the diff, team version on the left and yours on the right. When git cannot read
the changes, the group says so (see the log) instead of looking empty.

**Commit and push** (the cloud icon in the view's title bar, or right-click **Local changes**) asks for a commit
message, commits every change of the managed clone, rebases it on the team's latest commits and pushes to the
branch the clone follows, with your own git credentials. The team gets the change at their next sync. When the server
refuses the push (a protected branch, no write access), the message offers **Push to a branch**. A commit records
your name and email from git's settings: on a computer where they were never set, the message gives the two
`git config --global` commands to run once.

Updates never throw your changes away: at each update your local changes (files and commits) are put back on top of
the team's commits. Only a real conflict, where the team changed the same lines as you did, pauses the updates. The
notification names the files and offers two ways out:

- **Push to a branch** commits and pushes your changes to a new branch (default `team-plugins/<name>-<date>`), puts the
  managed clone back on the team version and gives you the commands to merge the branch from your own clone
  (`git fetch origin`, `git merge origin/<branch>`).
- **Discard local changes** deletes them; the confirmation lists the files and commits that would be lost.

With a local clone (`teamPlugins.localRepoPath`), commit and push with your own git tools: the extension still copies
the edits made in partial copies into your clone.

## Updates

The managed clone is checked at startup, every `teamPlugins.updateIntervalMinutes` (default 60, minimum 5; 0 means
only at startup) and with **Sync now**. An unreachable server (offline, VPN down) is skipped quietly while a clone
exists: the plugins already cloned keep working, the log and the status bar icon show it, and the update is retried
after 5 minutes. **Sync now** reports it. The team's new commits are rebased under your local changes, which are
kept (the notification says so). With several windows open, only one fetches per interval (a timed update is skipped
when another window synced less than half an interval ago). After an update, start a new chat to use the changes.
**What changed** in the notification lists the new commits in the log.

Updates pause only on a real conflict (see "Changing a team skill"). **Discard local changes** (or the command "Discard
local changes in the managed clone") asks for a confirmation that lists the files and commits it deletes. If the
repository URL or branch setting changes, the managed clone switches to it in place (an error if it has local
changes). An empty branch setting follows the repository's default branch, also when the team changes it.

## Plugin authors

Set `teamPlugins.localRepoPath` (or **Use a local clone**) to your own clone of the team repository. The extension
then never runs a git command that changes it: edit, commit and push with git as usual. File changes in the clone are
picked up live, no sync is needed.

### Building and releasing

Build the VSIX with `node scripts/package.js` (see `AGENTS.md` for running without node). A release is: bump `version`
in `package.json`, commit, push a tag `v<version>` (`git tag v0.4.1`, `git push origin v0.4.1`). The GitHub workflow
`.github/workflows/release.yml` checks that the tag matches the version, runs the tests, attaches the VSIX to a GitHub
release and publishes it to Open VSX. One-time Open VSX setup: sign in to https://open-vsx.org with GitHub, link an
Eclipse Foundation account and accept the publisher agreement when asked, create an access token in the profile
settings, create the namespace `mathieugun` (`npx ovsx create-namespace mathieugun -p <token>`, or on the site), and
add the token as the repository secret `OVSX_PAT` (GitHub: Settings, Secrets and variables, Actions). Without the
secret the workflow only makes the GitHub release.

## How it works

- The managed clone lives in the extension's global storage, in `.cursor/plugins/repo`. The `.cursor/plugins` part of
  the path matters: Cursor lists a `SKILL.md` as a skill only below such a folder. In a remote window this is the
  remote machine's storage (see "Remote windows").
- For each selected plugin the extension calls `vscode.cursor.plugins.addPlugin({ path })` in every window, at
  startup and whenever the selection or the repository changes. Cursor does not persist these registrations.
- A fully selected plugin is registered from the clone itself, so Cursor sees `git pull` changes directly. A partial
  plugin is registered from a partial copy (`.cursor/plugins/filtered/<name>-<hash>/<plugin folder>`: the folder is
  named by the plugin and the selection, and Cursor names an extension plugin after its folder, so the copy keeps the
  same name) that holds only the selected skills and rules. The copy and the clone are kept in sync both ways, with a
  `.team-plugins-sync.json` record next to the copy (the content hash of each file at the last sync): a change on one side
  only, new files and deletions included, is carried to the other side; a file changed on both sides is a conflict that
  waits for your choice. A symlink or junction in a plugin is copied as its content when it points inside the
  repository; one that points outside, is broken or loops is left out of the partial copy (see the log). A file an
  agent creates in a copy at the path of a skill or rule that is not selected is never copied to the repository (it
  stays in the copy, see the log). A sync reads a file again only when its size or timestamps changed. A copy sync
  that meets a locked file is retried every 2 seconds for a minute. Windows with the same selection share a copy; every
  open window marks the copies it uses every hour, and copies no window used for a week are deleted. The copy's folder
  name is the plugin name with characters other than letters, digits, `.`, `_` and `-` replaced by `_` (the plugin's
  own folder name, which Cursor uses, is unchanged).
- Several windows share one clone: a lock file serialises every operation that changes it (sync, commit and push, push
  to a branch, discard, partial-copy syncs, which take the lock in local mode too since windows with the same selection
  share a copy), and the other windows notice the new state through `sync-state.json`. An edit in the managed clone
  (another window's partial copy, or by hand) reaches this window's partial copies and view within a second. git runs
  without prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`); a network command is stopped (with the processes
  it started) only after 2 minutes without output, so a long first clone works while data arrives. A
  `.git/index.lock` older than a minute (left by a killed git) is removed before the next operation, and leftover
  `repo.tmp-*` folders of a failed clone at the next sync.

## Troubleshooting

- **Output > Team Plugins** shows every git command and every registration.
- **Output > Cursor Plugins** is Cursor's own log: look for `Registered extension plugin: <name>`.
- The status bar item (`Team <count>`) shows how many plugins this window registered; its tooltip lists them, the last
  commit and the last sync state. A warning icon means a paused update, a failed sync or a failed registration; a
  plug-off icon means the last update couldn't reach the server (offline).
- In a remote window, **Output > Team Plugins** is the remote extension's log; Cursor's own plugin log is on the
  remote machine too.
- "vscode.cursor.plugins is missing": this Cursor is too old for extension plugins; update Cursor.
- A background sync error is shown once, and again only after a sync succeeded (Sync now always shows it).

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
- A VSIX installed by hand is never updated by Cursor (pinned): install from the Extensions view to get updates.
- Resolving a real conflict inside the extension: updates pause, the files are named, and you can push your changes to
  a branch (to merge in your own clone) or discard them; the extension never merges by itself.
- A conflict between a partial copy and the repository is not merged line by line: you keep one of the two versions.
- Commit and push needs the managed clone: with `localRepoPath`, use your own git tools (the extension still copies
  partial-copy edits into the local clone).
- The commit includes every change of the managed clone (`git add -A`); there is no per-file choice.
- Pushing needs write access with your git credentials; a push the server refuses (a protected branch, a server
  rule, no write access) is reported with its reason and offers **Push to a branch**.
- SSH keys with a passphrase are not supported yet: the background git can't unlock them, and an agent started in a
  terminal (`ssh-agent`, `ssh-add`) is not visible to Cursor (its address, `SSH_AUTH_SOCK`, exists only in that
  terminal). The login fails at once with a message. Use a key without a passphrase for the team server.
- plink and Windows' own OpenSSH can't be kept from waiting on a question (host key, passphrase): git is stopped after
  2 minutes without output and the message suggests a terminal. Git's bundled ssh doesn't wait: use it.
- A clone of a local or network-share path that copies for more than 2 minutes without output is stopped (unrealistic
  for a plugins repository).
- After a change of the repository URL, the tags and git objects of the previous repository stay in the managed clone
  (harmless).
- Switching the managed clone to an empty repository (no branch yet) is an error.
- A symlink or junction created inside a partial copy is left out of the sync (see the log), never followed.
- A frontmatter description written as a quoted string over several lines shows only as written on the first line.
- Forwarding your local credentials or SSH agent to the git of a remote machine is not supported (agent forwarding is
  not tested): set the credentials up on the remote machine.
- WSL and dev containers are not tested; they should work the same way (install the extension on that side). A dev
  container rebuild loses the clone, which is cloned again at the next start.
- The extension must be installed on each remote machine (the Extensions view updates it there too).
- After the window that did the timed fetches closes, the next timed update in another window can be up to half an
  interval late.

## License

MIT. Copyright (c) 2026 Mathieu Gunther. The full text is in `LICENSE.txt`, next to this README (in the repository and
in the installed extension's folder).
