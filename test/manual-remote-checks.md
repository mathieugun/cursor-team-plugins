# Manual checks: a remote team repository

Tests can't cover SSH host keys, passphrases and the credential manager, so check them by hand before a release that
changes the remote code. Use a throw-away repository on a real server (GitHub, GitLab, Azure DevOps) and a Cursor window
with a clean `teamPlugins.repoUrl`. Each case: setup, action, expected result, the fix, the result after **Sync now**,
how to restore. In a message the buttons are listed after the text; the log is **Output > Team Plugins**.

Run the commands in Git Bash. `<host>` and `<url>` are the server and the repository URL.

## 1. Unknown host key

- Setup: back up `~/.ssh/known_hosts` (`cp ~/.ssh/known_hosts ~/.ssh/known_hosts.bak`), then `ssh-keygen -R <host>`.
- Action: set `teamPlugins.repoUrl` to the SSH URL of the repository.
- Expected: within a second or two, a message "SSH does not know the host key of <host> yet (first connection)" with
  **Open terminal**, **Sync now** and **Show log**. No hang, no spinner left in the status bar.
- Fix: **Open terminal** (runs `git ls-remote -- <url> HEAD`), compare the fingerprint with the server's published one,
  answer yes.
- After **Sync now**: the clone runs, "repository cloned".
- Restore: `cp ~/.ssh/known_hosts.bak ~/.ssh/known_hosts` (or keep the new entry).

## 2. Changed host key

- Setup: back up `known_hosts`, then replace the line of `<host>` with another key (for example a freshly generated one:
  `ssh-keygen -t ed25519 -f /tmp/fake -N ""`, then put `<host> <contents of /tmp/fake.pub>` in place of the line).
- Action: **Sync now**.
- Expected: "the SSH host key of <host> has changed ..." with **Show log** only, no **Open terminal** and no **Sync
  now**. The key is never accepted automatically; nothing is synced.
- Fix: none in the extension (ask the admin; `ssh-keygen -R <host>` then case 1).
- Restore: put the backup back.

## 3. Key with a passphrase (not supported)

- Setup: add a passphrase to the key the server accepts: `ssh-keygen -p -f <key>`.
- Action: **Sync now**.
- Expected: "SSH could not log in to <host>: no key, a key the server doesn't accept, or a key with a passphrase (not
  supported yet ...)" with **Open terminal** and **Sync now**. It fails in a second: no prompt window, no hang.
- Fix: remove the passphrase (`ssh-keygen -p -f <key>`, empty new passphrase). An agent started in a terminal does not
  help: Cursor doesn't see its `SSH_AUTH_SOCK`.
- After **Sync now**: updates.
- Restore: nothing.

## 4. HTTPS without stored credentials

- Setup: erase the stored credentials: `printf 'protocol=https\nhost=<host>\n\n' | git credential-manager erase`.
- Action: set an HTTPS `teamPlugins.repoUrl`, or **Sync now**.
- Expected: "git has no stored credentials for <host> and can't ask for them in the background ..." with **Open
  terminal** and **Sync now**. No Git Credential Manager window opens, not even a hidden one (check the taskbar).
- Fix: **Open terminal**, sign in when the credential manager asks.
- After **Sync now**: updates.
- Restore: nothing.

## 5. Refused credentials

- Setup: store a wrong token: `printf 'protocol=https\nhost=<host>\nusername=x\npassword=wrong\n\n' | git credential approve`.
- Action: **Sync now**.
- Expected: "<host> refused your credentials (wrong password, or an expired or revoked token) ..." with **Open
  terminal** and **Sync now**.
- Fix: `printf 'protocol=https\nhost=<host>\n\n' | git credential reject`, then **Open terminal** and sign in.
- After **Sync now**: updates.
- Restore: nothing.

## 6. Server unreachable

- Setup: a clone exists. Turn the network (or the VPN) off.
- Action: wait for a timed update (set `teamPlugins.updateIntervalMinutes` to 5), then press **Sync now**.
- Expected: the timed update is quiet (a line "update skipped: cannot reach <host> ..." in the log, no notification);
  the status bar shows the plug-off icon; the plugins still work. **Sync now** shows "cannot reach <host> ..." with
  **Sync now**. With no clone yet, the first sync shows the message once.
- Fix: turn the network back on.
- After the next retry (5 minutes) or **Sync now**: the icon returns to normal and the clone updates.
- Restore: the interval setting.

## 7. Wrong URL

- Action: set `teamPlugins.repoUrl` to a URL of a repository that doesn't exist (right host, wrong path).
- Expected: at once, "repository <url> not found, or you have no access to it ..." with **Set repository URL** and
  **Show log**; the clone is not started.
- Restore: set the right URL.

## 8. Wrong branch

- Action: set `teamPlugins.branch` to a branch that doesn't exist.
- Expected: at once, "branch <name> not found on <url> ..." with **Open settings**.
- Restore: empty the setting.

## 9. Valid URL

- Action: set `teamPlugins.repoUrl` to a valid URL of a large enough repository.
- Expected: an information message "<url> is reachable. Cloning it in the background." before the clone finishes, then
  "repository cloned".

## 10. Push to a protected branch

- Setup: protect `main` of the throw-away repository (no direct push).
- Action: change a team skill, **Commit and push**.
- Expected: "the server refused the push to main (...): a protected branch or a server rule ..." with **Push to a
  branch** and **Show log**.
- Fix: **Push to a branch**: the branch is pushed, the managed clone is back on the team version.
- Restore: unprotect `main`; delete the pushed branch.

## 11. Optional: Windows OpenSSH

- Setup: back up the setting (`git config --global core.sshCommand`), then
  `git config --global core.sshCommand C:/Windows/System32/OpenSSH/ssh.exe`, and an unknown host (case 1 setup).
- Action: **Sync now**.
- Expected: no output; after 2 minutes, "no answer from <host> for 120 s, so git was stopped ..." with **Open terminal**
  and **Sync now**. No `ssh.exe` is left in Task Manager.
- Restore: `git config --global --unset core.sshCommand` (or the backed up value).
