# 22. Failures are reported, never mistaken for success or cancellation

Three findings of the 2026-11-27 review ([review](review.md)) catch an error and then return the value that means
"nothing to do" or "fine". The project already has this rule for `git status` (a failure must never read as "no
changes", see `AGENTS.md`); these places don't follow it yet. (The directory walker has the same flaw and is fixed with
the data-loss cases in request 19.)

## 1. The operation queue turns errors into cancellations

`enqueue` logs an exception and resolves with `undefined`. New plugin, Move draft and Rename treat `undefined` as a
cancelled operation and return without a word: the user sees nothing, the error is only in the log.
[Queue](../extension.js#L333) · [New plugin](../extension.js#L2332) · [Move draft](../extension.js#L2560)

Expected: the queue keeps running for the next operations, but the caller of the failed one gets the failure and shows
it (one error message with the reason). A cancelled dialog stays silent.

## 2. A failed unregister is forgotten (P2)

When `removePlugin` throws, the registrar reports the path as both removed and failed and drops it from its map, so the
next apply never tries again: a plugin the user unticked stays active in that window.
[Registrar](../lib/registrar.js#L25)

Expected: a failed removal stays in the registrar's map and is retried at the next apply; `remove(name)` (used before
Move and Rename) reports its failure to the caller.

## 3. A failed pre-push check lets the push through (P2)

`confirmChecks` returns `true` (push) when collecting the changed paths or checking the catalog throws, the same value
as a clean check. [Pre-push check](../extension.js#L3338)

Expected: the user gets the same explicit choice as for problems found, with the error as the reason: "The check
before pushing failed: <reason>", **Push anyway** or cancel.

## Acceptance

- Registrar tests first, failing on `main`: a rejected removal is retried at the next `apply` and the plugin is
  registered as wanted once the API accepts it.
- `extension.js` is not covered by the unit tests: the queue and the pre-push check get a live scenario, or a manual
  check when the failure can't be triggered from a scenario.
