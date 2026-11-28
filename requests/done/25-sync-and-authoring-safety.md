# 25. Preserve local work during sync and constrain authoring writes

Follow-up to [request 19](done/19-no-silent-data-loss.md) and [request 20](done/20-safe-authoring-writes.md).
The review of `b14e794` reproduced the five issues below. Run the
[reproduction script](25-sync-and-authoring-safety.repro.py) from the repository root with
`python requests/done/25-sync-and-authoring-safety.repro.py`. It needs Python 3, Node and Git and uses disposable
local fixtures. Without `node` on `PATH` it falls back to Cursor's runtime (`ELECTRON_RUN_AS_NODE`). The junction
cases need permission to create links. The four case-only rename probes run on Windows only.
Each probe fails while its defect is present. Use `--help` for the individual case names.

Order of work, by real-world reach (assessed 2026-11-28): 2, 3, 4, then the cheap guards of 1 and 5.

## 1. Push cleanup can discard ignored files and staged edits (P3)

`pushToBranch` runs `git reset --keep @{u}` after the push. If the pushed commit deleted a tracked file and an editor
recreates it as an ignored file during the push, Git can overwrite it with the upstream version and report success.
It also clears an edit staged during the push when the working file was subsequently restored to its original contents.
[Cleanup](../lib/contribute.js#L179)

Reach. Git treats ignored files as expendable, but the ignored case needs a file that the pushed commit deletes, that
`.gitignore` lists, and that is recreated in the seconds between the commit and the reset. The staged case needs
something to run `git add` in the managed clone during the push: editors and agents only write files, and the staged
content survives as a blob. Both guards are cheap: before the reset, skip it when an ignored file is among the paths
that differ between `HEAD` and `@{u}`, or when `git diff --cached --quiet` reports a staged change.

Expected outcome. Preserve ignored files and staged changes saved after the pushed commit. If the cleanup cannot keep
them, leave the clone as it is and report that the push succeeded and the reset was skipped.

## 2. A case-only rename deletes the file on both sides (P1)

On Windows, `syncCopy` matches the paths of the repository, the copy and the record exactly, while the filesystem
does not tell `example.txt` from `Example.txt`. Any case-only rename then reads as one file deleted and another
created, and the sync deletes the file for good. No unreadable folder is needed. Three ways to hit it, each
reproduced (`case-rename-file`, `case-rename-folder`, `case-rename-source`):

- An agent or the user renames `assets/example.txt` to `assets/Example.txt` in the partial copy. The first sync
  copies `Example.txt` to the repository, where Windows writes it into the existing `example.txt`, then deletes
  `example.txt`, so the repository file is gone. The second sync sees the repository deletion and deletes the copy's
  file. Nothing is left on either side, and the clone shows the deletion as a local change that a push would publish.
- The same with the folder: `assets` renamed to `Assets` in the copy.
- A teammate's case-only rename reaches the clone through git (`example.txt` -> `Example.txt` in the repository):
  after two syncs the file is deleted from the clone.

The unreadable-folder variant found by the review (`unreadable-case`) is one more instance: after the copy folder
`assets` is renamed to `Assets`, an `EACCES` listing `Assets` reports it as unreadable, the comparison misses the
recorded `assets/example.txt`, and sync deletes the repository file. [Path comparison](../lib/materialize.js#L397) ·
[Folder comparison](../lib/materialize.js#L94)

Expected outcome. On a case-insensitive filesystem, paths of the repository, the copy and the record that differ only
in case are one file, everywhere `syncCopy` and `markCopySynced` compare them (the file loop, the record, skipped and
unreadable subtrees, excluded prefixes). A case-only rename never deletes content: either the new spelling is carried
to the other side, or both sides are kept as they are and the difference is reported. Keep both versions and the
recorded state below an unreadable folder until it can be read again. Preserve the distinction between differently
cased paths on case-sensitive filesystems.

## 3. An unreadable folder can erase an unresolved conflict from the record (P2)

An incomplete scan preserves the last synced hash below the unreadable folder but drops those paths from the
conflict list. After access returns, discarding clone changes before the next successful scan lets
`markCopySynced` treat the unresolved copy edit as already synced. The next sync overwrites it with the team version.
[Conflict record](../lib/materialize.js#L501) · [Discard uses the record](../extension.js#L1536)

Reach. It needs a pending conflict, a folder that is temporarily unreadable, and Discard afterwards. In the file loop
a skipped path never reaches `conflicts` ([skip](../lib/materialize.js#L413)), so the record is rewritten without it.

Expected outcome. Keep existing conflict entries below unreadable folders until a complete scan can evaluate them.
Discard must continue to preserve copy edits that never reached the clone.

## 4. Authoring can still write outside the repository through links (P2)

New plugin checks the plugin directory but updates `marketplace.json` through an unchecked path. With the
repository's `.cursor-plugin` directory linked outside the checkout, New plugin successfully rewrites the
external marketplace. A plugin's `commands` directory can likewise be linked outside the repository, where New
item successfully creates a command. [Marketplace write](../lib/authoring.js#L325) ·
[Item write](../lib/authoring.js#L139)

Reach. No hand-made link is needed: on Linux and macOS git checks out a committed symlink, so a team repository can
hold one. What gets written is limited (a template item file, or an entry added to a JSON marketplace), but it breaks
the containment rule of request 20.

Expected outcome. Apply the shared containment rule to the actual destinations of all authoring writes, including
marketplace updates and item files. Resolve ancestor links for paths that do not exist yet. Reject a destination
that leads outside the repository before the operation writes anything, and tell the user which path caused it.

## 5. MCP edits can collide with top-level JSONC keys (P3)

In a top-level MCP file with a server `lint` and a string-valued `notes`, adding a server named `notes` appends a
duplicate key and hides the original value. Renaming `lint` to `mcpServers` in a top-level file changes how the
catalog interprets the whole file. The resulting catalog can report `command` as its only server, instead of
the renamed server and its siblings. Both commands report success.
[Add](../lib/authoring.js#L217) · [Rename](../lib/rename.js#L186)

Reach. Only the top-level format (no `mcpServers` wrapper) is affected, with a non-server key of the same name or a
server named `mcpServers`. The simplest fix may be to decline those names (`mcpServers`, `$schema`, the metadata keys,
an existing top-level key) rather than edit around them.

Expected outcome. Preserve existing properties, other servers and comments. After a successful edit, the catalog
lists the added or renamed server under the requested name. If the edit cannot meet those conditions, decline
with a clear message and leave the file untouched.

## Acceptance

- Add regression tests that fail on `b14e794` for the ignored-file and staged-only push cases, the Windows case-only
  renames (file and folder in the copy, file in the repository, and the unreadable-folder variant), the
  unreadable-conflict and discard sequence, both linked authoring destinations, and both MCP collisions.
- The tests and the reproduction script pass with the fix. Existing sync, conflict resolution, push, authoring and
  JSONC tests continue to pass.
