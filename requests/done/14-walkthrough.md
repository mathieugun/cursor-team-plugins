# 14: Getting started walkthrough

**Getting started walkthrough** (`contributes.walkthroughs`): check git, add a repository, pick plugins.

## Decisions (design review, 2026-11-26)

- One walkthrough, three steps: **Check git**, **Add a team repository**, **Pick your plugins**, each with a short
  markdown page beside it.
- A new command **Team Plugins: Check git** runs `git --version` (with `git.path`, on the machine the extension runs
  on) and reads `user.name` / `user.email`: git missing, too old (before 2.38), or ready (with a hint when the name or
  email is missing). **Download git** opens https://git-scm.com/downloads.
- A new command **Team Plugins: Get started** opens the walkthrough; also in the view's `...` menu and in the empty
  view's welcome text.
- Steps tick themselves only from what the user does after startup (Cursor never ticks a step whose context key is
  already true when the walkthrough is registered): Check git finding a usable git, a change of
  `teamPlugins.repositories` / `teamPlugins.localRepositories`, a change of `teamPlugins.enabled`. Someone already set
  up sees unticked steps (Cursor's own **Mark Done**).
- Opening the walkthrough by itself is left to Cursor (after an install, when the window has focus).
- Version 0.8.3.
