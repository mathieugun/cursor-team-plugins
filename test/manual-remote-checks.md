# Manual checks: a remote team repository

Only the cases below need a real server and the real ssh or credential manager. Everything else is covered by
`test/remote.test.js` (git level: unknown and changed host key, refused login, silent ssh, missing credentials, refused
credentials, wrong URL and branch, offline, valid repository, protected and read-only pushes) and by
`scripts/live-test.js` (messages and buttons in an isolated Cursor). Check these by hand before a release that changes
the remote code, with a throw-away repository on a real server (GitHub, GitLab, Azure DevOps) and a Cursor window that
follows it through `teamPlugins.repositories` (never `teamPlugins.repoUrl`, gone since 0.5). Each case: setup, action,
expected result, the fix, the result after **Sync now**, how to restore. In a message the buttons are listed after the
text; the log is **Output > Team Plugins**.

Run the commands in Git Bash. `<host>` and `<url>` are the server and the repository URL.

## 1. Unknown host key (Git's bundled ssh)

- Setup: back up `~/.ssh/known_hosts` (`cp ~/.ssh/known_hosts ~/.ssh/known_hosts.bak`), then `ssh-keygen -R <host>`.
- Action: add the SSH URL of the repository to `teamPlugins.repositories`.
- Expected: within a second or two, a message "SSH does not know the host key of <host> yet (first connection)" with
  **Open terminal**, **Sync now** and **Show log**. No hang, no spinner left in the status bar.
- Fix: **Open terminal** (runs `git ls-remote -- <url> HEAD`), compare the fingerprint with the server's published one,
  answer yes.
- After **Sync now**: the clone runs, "cloned".
- Restore: `cp ~/.ssh/known_hosts.bak ~/.ssh/known_hosts` (or keep the new entry).

## 2. Key with a passphrase (not supported)

- Setup: add a passphrase to the key the server accepts: `ssh-keygen -p -f <key>`.
- Action: **Sync now**.
- Expected: "SSH could not log in to <host>: no key, a key the server doesn't accept, or a key with a passphrase (not
  supported yet ...)" with **Open terminal** and **Sync now**. It fails in a second: no prompt window, no hang.
- Fix: remove the passphrase (`ssh-keygen -p -f <key>`, empty new passphrase). An agent started in a terminal does not
  help: Cursor doesn't see its `SSH_AUTH_SOCK`.
- After **Sync now**: updates.
- Restore: nothing.

## 3. HTTPS without stored credentials (Git Credential Manager)

- Setup: erase the stored credentials: `printf 'protocol=https\nhost=<host>\n\n' | git credential-manager erase`.
- Action: add an HTTPS URL to `teamPlugins.repositories`, or **Sync now**.
- Expected: "git has no stored credentials for <host> and can't ask for them in the background ..." with **Open
  terminal** and **Sync now**. No Git Credential Manager window opens, not even a hidden one (check the taskbar); the
  log shows "Cannot prompt because user interactivity has been disabled".
- Fix: **Open terminal**, sign in when the credential manager asks.
- After **Sync now**: updates.
- Restore: nothing.

## 4. Push to a protected branch (a real server's wording)

- Setup: protect `main` of the throw-away repository (no direct push).
- Action: change a team skill, **Commit and push**.
- Expected: "the server refused the push to main (...): a protected branch or a server rule ..." with **Push to a
  branch** and **Show log**; the server's own words are in the parentheses.
- Fix: **Push to a branch**: the branch is pushed, the managed clone is back on the team version.
- Restore: unprotect `main`; delete the pushed branch.

## 5. Windows OpenSSH (silent)

- Setup: back up the setting (`git config --global core.sshCommand`), then
  `git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe`, and an unknown host (case 1 setup).
- Action: **Sync now**.
- Expected: no output; after 2 minutes, "no answer from <host> for 120 s, so git was stopped ..." with **Open terminal**
  and **Sync now**. No `ssh.exe` is left in Task Manager.
- Restore: `git config --global --unset core.sshCommand` (or the backed up value).
