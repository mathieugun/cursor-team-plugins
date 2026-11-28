# 28. Show hooks and scripts in the tree

## Context

Request `requests/done/28-show-hooks-and-scripts.md`. Workflow notes `.claude/implement.md`. The working version is
0.9.2. The release process bumps the version separately. Entry points are catalog reads, checkbox changes,
registration and copy sync on apply, and file opening from the tree.

## Measured facts

- Cursor 3.32.10's installed `cursor-agent-host/dist/4846.js` calls the same hook loader for an extension registration
  as for an installed plugin. It reads `hooks/hooks.json`, a relative file/directory named by a manifest, or an
  inline manifest object. Manifest candidates in loader order are `.cursor-plugin/plugin.json`,
  `.claude-plugin/plugin.json`, and `plugin.json`. An explicit inline object replaces disk discovery. JSON parsing
  is strict. `9115.js` detects native and Claude-compatible formats and validates the resulting events.
- A direct Node 24 call to the bundled loader (`72467.Y_`) verified all four sources, an empty inline override,
  native rejection of an unknown event and missing version, and Claude `SessionStart` conversion. An earlier
  manifest with only `name` lets Cursor consider later candidates. An earlier one with `displayName` takes
  precedence. The probe read configurations without executing them.
- The existing `selection.effective` includes all children of a fully selected plugin, includes an individual
  child only when selected, and combines project and personal choices. `materialize.syncCopy` handles excluded
  files plus generated one-way config files. `mergeCatalogs` qualifies selectable IDs with the repository name.
- Baseline lint and extension syntax check passed. The Windows sandbox run failed on junction and Git tests.
  The unchanged `main` checkout passed outside the sandbox with 495 passes and 2 skips.

## Design

- Discover the plugin's loadable hook configuration and collect the nonempty effective event names. Use one
  `Hooks` item with ID `<plugin>/hooks` and unselectable event rows. Clicking the group or an event opens the
  defining configuration using the existing file preview. Show one event row per event. Show no group for a
  configuration that contributes no hooks. Read native and compatible configs Cursor accepts, and constrain
  discovery to paths within the plugin.
- Apply the current full, partial, and project selection rules to the group. Existing full selections include
  it. Existing partial selections of other items leave it off. Selecting Hooks alone can register a plugin.
  Keep hook event and script rows out of the selection and project menus. Give Hooks the existing project
  menu actions and file opening, with no item rename action. A plugin rename keeps the hook selection through
  the existing ID mapping.
- An excluded Hooks item uses a filtered copy. Keep the default hook config out of that copy. For manifest
  declarations, generate an inline empty hook configuration in the copy wherever a recognized manifest
  declares hooks. Keep the other manifest fields and custom hook file contents. Generated copies of
  manifests are one-way and may be regenerated to keep hooks disabled. Keep the original configuration
  available in the tree. Scripts continue to follow their owning plugin or skill. Use a distinct filtered
  holder for an excluded Hooks item so upgrades cannot reuse a copy that previously contained live hooks.
  Keep an explicit exclusion effective through a temporary absence of the hook configuration.
- List files recursively in conventional plugin and skill `scripts/` folders, with paths relative to the
  folder. Keep filesystem discovery within the plugin and skip links that escape it. Clicking a file opens
  the repository version in the existing preview. The existing skill folder and plugin copy behavior
  carries those files into the registration.

## Impact

Update catalog discovery, tree presentation and checkbox handling, filtered copy assembly, and any item-kind
consumers requiring an explicit branch. Use existing `enabled`, `excluded`, and `projectPlugins` settings.
Include unit tests and an isolated Cursor scenario. No extension dependencies or new commands.
The update summary keeps its existing set of tracked item kinds. Inline hook configs can share a file with
other plugin metadata, so a whole-file fingerprint would report unrelated edits as hook updates.

## Tests

- Discover default, alternate file/directory and inline hook configurations, validate native and compatible
  event names, reject malformed settings and escaping paths, and list nested scripts under the right owner.
- Assert tree hook groups are selectable, their event and script rows are openable without checkboxes, and
  personal/project selections and plugin renames preserve the expected choice.
- Build full and partial registrations, exclude hooks from default and manifest configurations across sync,
  and keep selected skill and plugin scripts. Verify generated files cannot flow back to the source.
- Isolated Cursor scenario starts with an enabled plugin, opens the definition and a script, unticks Hooks,
  checks the registered copy and stored exclusion, syncs, then re-enables Hooks and checks registration.

## Keep in step

- `README.md`, `docs/development.md`, `AGENTS.md`: describe selection, storage conventions and copy filtering.
- `.claude/implement.md`: record verified Cursor-specific hook discovery facts.
- `package.json`: reflect action availability and settings descriptions where relevant. Keep version 0.9.2.
- `requests/ideas.md`: remove the promoted idea.

## Commands

- `node --check extension.js`
- `node scripts/test.js`
- `biome lint --error-on-warnings extension.js lib scripts test`
- `node scripts/live-test.js hooks-and-scripts` (isolated Cursor)
- Before merging, `python scripts/live_check.py test --host gnosis`.

## Hand checks

Use the isolated scenario for functional verification. If the isolated run cannot verify visual details,
report those details as unverified. No install in the user's Cursor has been authorized.

## Changes after review

- Keep a selected hook configuration when it shares a path with an omitted skill or when it also contains
  omitted MCP servers. Only the selected hook config file survives an omitted skill folder.
- Suppress candidate configs in partial copies even when they do not produce a tree row. This includes a
  hook file symlink that Cursor rejects in the original plugin but that a copier could turn into a regular file.
- The isolated fixture follows `main` explicitly after its first refresh failed at Git's default-branch lookup.
  The launcher clears an inherited `GIT_CONFIG_COUNT` that otherwise reaches Cursor without its values.

## Verification

- The cross-platform run passed with 503 passes and 2 skips on Windows and 486 passes and 19 skips on Linux.
  The first helper run passed on Linux and failed nine existing Git tests on Windows. A direct Windows run
  passed, and the final helper run set `GIT_CONFIG_COUNT=0` for both test processes.
- Focused hooks, selection and tree model tests passed. Extension syntax, Biome lint, the 12 Python tests and
  `git diff --check` passed.
- The isolated `hooks-and-scripts` and `selection` scenarios passed. Calling the installed Cursor 3.32.10 loader
  on the scenario's resulting directories showed `sessionEnd` in the original and zero events in the filtered
  copy after syncing the new hook path. Cursor found one skill and one rule in both directories.

## Don't

Do not run hooks, add hook or script authoring commands, change the real Cursor profile, or push. The main
agent owns the request, plan and Git operations. The implementer owns the affected code, tests and docs.
