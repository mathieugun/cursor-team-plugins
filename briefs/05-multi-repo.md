# Brief 05: plugins from several team repositories

Let a user follow several plugin repositories at once, for example one per team, and pick their own plugins, skills
and rules across all of them. Every repository has the layout the extension already reads (a `marketplace.json`, or
plugin folders with `.cursor-plugin/plugin.json`).

## Wanted behaviour

- **Configure N repositories.** Each is either managed (a URL and an optional branch, cloned by the extension) or
  local (a path to the user's own clone, for authors). The current single-repository settings keep working and are
  migrated.
- **One view for all of them.** The view groups plugins by repository, and each repository shows its own state (up to
  date, updating, conflict, error) and its own local changes. Selection, partial plugins and project plugins work
  across repositories, as they do today for one.
- **Independent repositories.** One repository failing (unreachable, conflict) doesn't block the others. Commit and
  push, Push to a branch and Discard act on one repository.
- **Stable names.** A plugin is identified by its repository and its name, the same on every machine, so a committed
  `projectPlugins` means the same thing for everyone. Two repositories may each have a plugin with the same name.
- **Missing repository in a project.** When a project requires a plugin from a repository the user doesn't follow,
  the user is told and offered to add it. A repository is never added without the user's confirmation.
- The status bar summarises every repository.

## Decisions for the analysis (from the first discussion)

- Where a repository's name comes from (proposed: the `name` of its `marketplace.json`, falling back to the URL's base
  name) and what happens when two repositories have the same name.
- How to register two plugins whose folders have the same name, since Cursor names a plugin after its folder (check
  in Cursor what happens today).
- How existing selections (`enabled`, `excluded`, `projectPlugins`) are migrated.
- Per-repository storage, lock and state, so that repositories sync independently and a clone is never deleted to
  switch URL or branch.

## Out of scope (follow-ups)

- A company index repository that lists the team repositories to subscribe to.
- Per-repository update intervals.

## Depends on

Brief 01 (data-loss bugs). Brief 02 #3 (switching URL or branch) is covered here if per-repository storage replaces
the reclone.

## Done when

Tests for the multi-repository catalog, selection, migration and naming. A live check with two local bare
repositories (user's OK). README rewritten for several repositories. Minor version bumped (0.3.0).
