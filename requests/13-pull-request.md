# 13. Open a pull request after Push to a branch

From `ideas.md` (top pick 2):

> **Open a pull request after Push to a branch.** Open the hosting service's "new pull request" page for the branch
> (GitHub, GitLab, Azure DevOps, from the remote URL), also offered when a push is refused. Skill changes then get a
> review, and users without write access are no longer stuck at "the server refused the push".

## Decisions (2026-11-26)

- The page is built from the repository URL for `github.com`, `gitlab.com` and Azure DevOps (`dev.azure.com`,
  `ssh.dev.azure.com`, `<org>.visualstudio.com`, `vs-ssh.visualstudio.com`), targeting the branch the clone follows.
  Any other host: the URL the server printed on the push (`remote:` lines), if any (it targets the server's default
  branch). Otherwise no page.
- After **Push to a branch**, the message offers **Open pull request** (when a page is known) and **Copy merge
  commands**; the page's URL is also logged.
- When **Commit and push** is refused (protected branch, no write access), its button is **Open a pull request**: it
  pushes to a new branch (the usual prompts), then opens the page at once.
- When **Push to a branch** itself is refused, the message no longer points back to Push to a branch: no write access
  says to ask for it (pull requests from a fork are not supported); a server rule says to try another branch name or
  ask the admins.
- The Azure DevOps page form (`pullrequestcreate?sourceRef=&targetRef=`) could not be confirmed from Microsoft's docs:
  included, and flagged as unverified in `docs/development.md`.
- Version 0.9.0.
