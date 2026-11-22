# Brief 06: a remote team repository, reliably

The extension can already follow a remote repository: `teamPlugins.repoUrl` takes any git URL (HTTPS, `git@host:…`,
`ssh://…`). The extension clones it into its own storage, keeps it updated and pushes to it, so no local clone is
needed. This mode is the default for team members (`localRepoPath` is for plugin authors). What's missing is
reliability: when git can't reach or authenticate to the server, the user gets an unclear error, or the extension
waits until a timeout.

## Failure cases to handle

For each case: no endless wait, a clear message that says what to do (with the command to run in a terminal where
that helps), and a retry that works once the user has fixed it.

- **Unknown SSH host key** (first connection to the server): SSH wants to ask "are you sure?" and can't.
- **Changed host key** (server reinstalled, or a real attack): never accepted automatically.
- **SSH key with a passphrase and no agent running**, or no key at all.
- **HTTPS without stored credentials**, and credential manager windows that pop up or stay hidden behind Cursor.
- **Authentication refused** (no access to the repository, expired token).
- **Server unreachable** (offline, VPN down, DNS): updates are skipped quietly and retried later. The plugins already
  cloned keep working.
- **Repository or branch not found** (wrong URL, renamed repository, deleted branch).
- **Push refused**: no write access, or a protected branch. Offer to push to a branch instead (see the pull request
  idea in `feature-ideas.md`).
- **Slow server or large repository**: a first clone that takes longer than the current time limit.

## Also

- **Check the URL** when it's set: say right away whether it's reachable, before the first clone runs in the
  background.
- **README**: a short setup section for SSH (agent, `known_hosts`) and HTTPS (credential manager), with the usual
  errors and their fixes.

## Out of scope

Remote-SSH windows (brief 04). Opening pull requests (a separate idea, made easier by this brief).

## Done when

Each failure case is covered by a test with local repositories where possible (a missing repository, a missing
branch, a refused push, an unreachable server). The SSH and credential cases are checked by hand with the user,
following a written checklist. Full suite green, README updated, version bumped.
