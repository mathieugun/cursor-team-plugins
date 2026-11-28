# 22. Report operation failures

## Context

Request: [22-report-failures.md](22-report-failures.md). Workflow notes: `.claude/implement.md`.
Base: `main`, version 0.8.7. Version changes are made on `main` for a release.
The operation queue, command handlers and pre-push check live in `extension.js`. Plugin registration state lives in `lib/registrar.js`.

## Measured facts

- On the baseline registrar, a simulated removal rejection puts the same path in both `removed` and `errors`, deletes the key, and makes one removal attempt across two applies.
- `node --test test/registrar.test.js` on baseline code passed seven existing tests and failed both new regressions. The replacement registered after the failed removal, and direct removal resolved instead of rejecting.
- The Windows `main` suite passed with 434 tests and two platform skips when run outside the sandbox. In the sandbox Git for Windows could not create the MSYS objects needed by its child processes. Syntax and Biome also passed.
- Source inspection found that `createPluginFlow`, Move and Rename treat a falsy operation result as cancellation. Existing command-specific result objects already carry expected failures. Several timers and watchers submit work without awaiting its result.
- Both push commands check changed paths after selecting a repository with work. A test must fail the check after that selection. The existing live scenario records modal choices through the test UI.

## Design

- Return the queue operation's actual promise. Log rejected work and recover the queue through a separate promise. Registered commands that receive a rejection show one `Team plugins: <reason>` error through the existing UI. Dialog cancellation keeps its existing behavior. Move and Rename apply again if a thrown operation stopped after unregistering a plugin. Keep the existing user-facing result handling for expected errors.
- Remove a registrar entry and report it in `removed` after the API accepts its removal. A failure keeps the old entry, reports the error, and defers adding a replacement for the same name until the old path can be removed. Other names continue. Direct removal before Move or Rename rejects with the API reason.
- For either push, an exception from the pre-push check opens a modal warning, `The check before pushing failed: <reason>`, with `Push anyway` and the standard cancel action. A dismissal or cancellation stops before further push prompts. Problems found keep their existing list and `Open files` action.

## Impact

- `extension.js` operation queue, command registration, Move and Rename recovery, pre-push modal and Test mode hook if required.
- `lib/registrar.js` removal tracking, used by apply, Move and Rename.
- `test/registrar.test.js` and `test/live/checks.live.js` regression coverage.

## Tests

- Add the registrar regressions before implementation and run them on the baseline. A rejected removal stays tracked and is retried on the next apply. A replacement registers once the removal succeeds. Direct removal rejects and preserves the old entry.
- In isolated Cursor, trigger a rejection during New plugin, verify one reason-bearing error, then create a plugin successfully. Cancelling the dialog produces no error.
- In isolated Cursor, force changed-path collection to fail after repository selection. Cancel and verify no branch or commit prompt and no remote change. Select `Push anyway` and verify the regular push flow continues. Keep the existing clean and detected-problem paths covered by the relevant scenarios.

## Keep in step

- `README.md` explains how a failed pre-push check is handled.
- `docs/development.md` and `AGENTS.md` describe queue error propagation and registrar retry.
- `.claude/implement.md` records the isolated extension host's separate module instance for the pre-push test.

## Commands

- Baseline and final: `node --check extension.js`, `node scripts/test.js`, `biome lint --error-on-warnings extension.js lib scripts test`.
- Isolated Cursor: `node scripts/live-test.js checks rename contribute`.
- Before local merge: `python scripts/live_check.py test --host gnosis`.

## Don't

- Use the isolated Cursor runner. Any fault injection is limited to Test mode or the test process. Leave branch integration to the main agent.

## Changes after review

- Cursor 3.32.10 ran the push command with its normal path collector after the scenario replaced its own module export.
  The test now replaces the collector through the extension's Test mode hook and restores it after the assertions.

## Verification

- Registrar suite passed all nine tests. Extension syntax and Biome passed.
- Windows passed 436 tests with two platform skips. Linux passed 419 with 19 platform skips.
- Isolated Cursor 3.32.10 passed `checks`, `rename`, and `contribute`. The successful run removed inherited indexed
  Git configuration variables only from the test process environment. Cursor dropped an empty value on the first run,
  so Git could not parse the inherited config and stopped before plugin registration.
