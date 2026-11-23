# Team plugins: development notes

Notes for people working on the extension: how it works inside, platform details and known limits that the README
leaves out. The code-level reasons ("why the code is shaped this way") and the test commands are in `AGENTS.md`.

## Building and releasing

- Build the VSIX: `node scripts/package.js` (writes `dist/cursor-team-plugins-<version>.vsix`; see `AGENTS.md` for
  running it with Cursor's runtime when node is not installed).
- Release: bump `version` in `package.json`, commit, then push a tag `v<version>` (`git tag v<version>`,
  `git push origin main v<version>`). `.github/workflows/release.yml` checks that the tag matches the version, runs the
  tests, attaches the VSIX to a GitHub release and publishes it to Open VSX, which Cursor's marketplace mirrors (a new
  extension appeared there about 7 minutes after Open VSX listed it; new versions of existing extensions show up at
  once).
- Open VSX setup (done once): an open-vsx.org account signed in with GitHub, linked to an Eclipse Foundation account
  with the publisher agreement accepted; the namespace `mathieugun` (equal to `publisher` in `package.json`); an access
  token stored as the repository secret `OVSX_PAT`. Without the secret the workflow only makes the GitHub release.
- The README is the extension's details page in Cursor and on Open VSX: a change reaches users with the next release.

## How it works

- The managed clone lives in the extension's global storage, in `.cursor/plugins/repo`. The `.cursor/plugins` part of
  the path matters: Cursor lists a `SKILL.md` as a skill only below such a folder.
- For each selected plugin the extension calls `vscode.cursor.plugins.addPlugin({ path })` in every window, at startup
  and whenever the selection or the repository changes. Cursor does not persist these registrations.
- A fully selected plugin is registered from the clone itself, so Cursor sees `git pull` changes directly. A partial
  plugin is registered from a partial copy (`.cursor/plugins/filtered/<name>-<hash>/<plugin folder>`: the folder is
  named by the plugin and the selection, and Cursor names an extension plugin after its folder, so the copy keeps the
  same name) that holds only the selected skills and rules.
- The copy and the clone are kept in sync both ways, with a `.team-plugins-sync.json` record next to the copy (the
  content hash of each file at the last sync): a change on one side only, new files and deletions included, is carried
  to the other side; a file changed on both sides is a conflict that waits for the user's choice. A sync reads a file
  again only when its size or timestamps changed. A copy sync that meets a locked file is retried every 2 seconds for a
  minute.
- Symlinks and junctions in a plugin are copied as their content when they point inside the repository; one that points
  outside, is broken or loops is left out of the partial copy (see the log). A file an agent creates in a copy at the
  path of a skill or rule that is not selected is never copied to the repository (it stays in the copy, see the log).
- Windows with the same selection share a copy; every open window marks the copies it uses every hour, and copies no
  window used for a week are deleted. The copy's folder name is the plugin name with characters other than letters,
  digits, `.`, `_` and `-` replaced by `_` (the plugin's own folder name, which Cursor uses, is unchanged).
- Several windows share one clone: a lock file serialises every operation that changes it (sync, commit and push, push
  to a branch, discard, partial-copy syncs, which take the lock in local mode too since windows with the same selection
  share a copy), and the other windows notice the new state through `sync-state.json`. An edit in the managed clone
  (another window's partial copy, or by hand) reaches this window's partial copies and view within a second.
- Updates: the team's new commits are rebased under the local changes. Conflicts are found first with
  `git merge-tree --write-tree` (hence git 2.38). With several windows open, only one fetches per interval (a timed
  update is skipped when another window synced less than half an interval ago). The update interval has a floor of 5
  minutes.
- A URL or branch change switches the managed clone in place (an error if it has local changes). An empty branch
  setting follows the repository's default branch, resolved at each sync, also when the team changes it.
- git runs without prompts (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`); a network command is stopped (with the
  processes it started) only after 2 minutes without output, so a long first clone works while data arrives. A
  `.git/index.lock` older than a minute (left by a killed git) is removed before the next operation, and leftover
  `repo.tmp-*` folders of a failed clone at the next sync.
- An unreachable server (offline) is quiet while a clone exists, never counts as a sync, and is retried after 5
  minutes. A background sync error is shown once, and again only after a sync succeeded (Sync now always shows it).

## Remote windows (Remote-SSH)

- Cursor's agent runs on the remote machine, so the extension (`extensionKind: ["workspace"]`) runs there too and must
  be installed there.
- The managed clone and the partial copies are in the remote extension storage
  (`~/.cursor-server/data/User/globalStorage/mathieugun.cursor-team-plugins`). git runs on that machine (2.38 or later,
  on its PATH or `git.path` in the remote settings), with that machine's credentials and SSH keys.
- Settings: the repository URL, the branch, the update interval and the selection (`enabled`, `excluded`) are
  `application` settings, the same in local and remote windows. `teamPlugins.localRepoPath` is a `machine` setting: in
  a remote window it is a path on the remote machine (stored in its remote settings). A project's `projectPlugins` is
  read from the remote project's `.vscode/settings.json`.
- Each machine has its own clone: an agent's edit in a remote window lands in that machine's clone and shows in its
  Local changes; it is committed and pushed from a window on that machine. Several windows on the same remote machine
  share its clone, as local windows do.
- The status bar tooltip shows `Machine: <host> (remote window)`, and the error messages name the machine. In a remote
  window, **Output > Team Plugins** and Cursor's own plugin log are on the remote machine.

## Platform notes

- SSH: git's bundled ssh fails fast without a console (unknown host key, passphrase without agent). Windows' own
  OpenSSH and PuTTY's plink wait silently for a question the extension can't show: git is stopped after 2 minutes
  without output and the message suggests a terminal.
- SSH keys with a passphrase are not supported: the background git can't unlock them, and an agent started in a
  terminal (`ssh-agent`, `ssh-add`) is not visible to Cursor (`SSH_AUTH_SOCK` exists only in that terminal). Only
  Windows' agent service with `core.sshCommand` set to Windows' OpenSSH would work (not tested).
- On Linux and macOS (and on remote machines), git keeps HTTPS credentials only with a credential helper
  (`credential.helper store`, `gh auth setup-git`, ...).
- Forwarding local credentials or an SSH agent to the git of a remote machine is not supported (agent forwarding is not
  tested).
- WSL and dev containers are not tested; they should work the same way (install the extension on that side). A dev
  container rebuild loses the clone, which is cloned again at the next start.

## Known limits (details)

- Marketplace entries whose source is not a folder of the repository (GitHub or URL sources) are skipped.
- Custom component paths declared in `plugin.json` are not read: only `skills/` and `rules/` are selectable; anything
  else (agents, commands, hooks, mcp.json, assets) always comes with its plugin.
- With `localRepoPath` outside a `.cursor/plugins` folder, Cursor may list the skills among the rules; the agent still
  gets them.
- Enterprise teams whose admin turned off "Allow Local Plugin Imports": not tested whether it also blocks extension
  plugins.
- A conflict between a partial copy and the repository is not merged line by line: the user keeps one of the two
  versions. A real conflict with the team's commits is never merged by the extension.
- The commit includes every change of the managed clone (`git add -A`); there is no per-file choice.
- A clone of a local or network-share path that copies for more than 2 minutes without output is stopped.
- After a change of the repository URL, the tags and git objects of the previous repository stay in the managed clone
  (harmless).
- Switching the managed clone to an empty repository (no branch yet) is an error.
- A symlink or junction created inside a partial copy is left out of the sync (see the log), never followed.
- A frontmatter description written as a quoted string over several lines shows only as written on the first line.
- After the window that did the timed fetches closes, the next timed update in another window can be up to half an
  interval late.
- A plugin with the same name installed from a marketplace conflicts with the one this extension registers.
- The publisher was `mg` before the first public release: `extension.js` warns while `mg.cursor-team-plugins` is
  installed (both would register the same plugins); its storage is not migrated.
