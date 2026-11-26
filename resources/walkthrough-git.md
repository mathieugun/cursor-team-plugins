# Git and your credentials

Team plugins runs git in the background with your own credentials, on the machine the extension runs on (in a
Remote-SSH window, the remote machine). It never asks for a password: git must reach the team repository without
asking anything.

## Install git

Git 2.38 or later is needed.

- **Windows**: Git for Windows, from https://git-scm.com/downloads. Restart Cursor afterwards so that it finds git.
- **macOS**: `xcode-select --install`, or `brew install git`.
- **Linux**: your distribution's package, for example `sudo apt install git`.

If git is installed where Cursor doesn't look, set its path in the `git.path` setting.

## Sign in once

In a terminal, run `git ls-remote <team repository URL>` and answer its questions once:

- **HTTPS**: your credential manager keeps the credentials. On Linux and macOS, set up a credential helper first (for
  example `gh auth setup-git` for GitHub).
- **SSH**: use a key without a passphrase, and accept the server's host key.

## To contribute

To commit changes to a team repository, git also needs your name and email:

    git config --global user.name "Your Name"
    git config --global user.email "you@example.com"
