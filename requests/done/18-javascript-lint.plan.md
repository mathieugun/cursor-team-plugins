# 18 — Check JavaScript with Biome

## Context

- Request: `requests/done/18-javascript-lint.md`. Workflow notes: `.claude/implement.md`.
- Extension version: 0.8.6 for this development-only change. The next release uses the usual version and tag process.
- Entry points: local lint invocation, GitHub Actions on branch and release-tag pushes, and the existing VSIX packager.

## Measured facts

- At `a52a4cb`, the standalone Windows Biome 2.6.9 binary checked 60 JavaScript files in a read-only trial of the
  recommended correctness preset. It found zero undeclared variables, two unused local bindings, and eight unused
  function parameters. Two of the parameter warnings are for unused trailing arguments. The others are for
  position-dependent parameters or an existing call signature. CommonJS and Node globals need no custom allowlist.
- A scratch `extension.js` with an undeclared identifier failed with exit 1 and printed the file, line, column,
  and `lint/correctness/noUndeclaredVariables`. The syntax was otherwise valid.
- GitHub's Biome 2.6.9 release lists the standalone assets `biome-win32-x64.exe` and `biome-linux-x64`. The latter's
  recorded SHA-256 is `5409e32eb17b47e0d1d9bbf213b749eba1f9c35d8b18fbd2ee55971157918a57`.
- The Windows baseline with Node 24.22.3 passed 345 of 346 tests outside the sandbox. The existing Windows-only draft
  removal test expected a `leftover` path. The sandbox additionally prevents Git for Windows' shell from starting.
  The package tests and `node --check extension.js` passed. The current packager lists 30 VSIX entries explicitly
  or via `lib/` and `resources/`.

## Design

- Add root `biome.json`. Select `extension.js` and JavaScript recursively under `lib/`, `scripts/` and `test/`,
  including `test/live/`. Set the overall rules preset to `none` and the correctness preset to `recommended`.
  Explicitly set `noUndeclaredVariables` and `noUnusedVariables` to errors and `noUnusedFunctionParameters` to a
  warning. Disable the formatter and assist.
- Use `biome lint extension.js lib scripts test` locally and in CI. Install the standalone 2.6.9 binary from the
  matching GitHub release on Windows or Linux. CI downloads the Linux x64 release asset to `RUNNER_TEMP`, verifies
  its SHA-256, and runs the binary. Warnings are shown and do not fail the job.
- Remove the unused `fromRoot` entry and its matching tuple values in `lib/materialize.js`. Drop the unused catch
  binding in `lib/sync.js`. Keep existing parameter warnings advisory so the rollout has no further source changes.
- Use `.github/workflows/checks.yml` on pushes to all branches and via `workflow_call`. Use the release workflow's
  existing Ubuntu runner, Node 22, and `node scripts/test.js`. Run lint even if tests fail, unless the job is
  cancelled, so a branch push gives both results. The checks need only read access to contents.
- Call the reusable checks from `.github/workflows/release.yml` on `v*` tag pushes. Make the release job depend on
  the result. Keep tag/version validation, packaging, GitHub release and Open VSX publishing under the release job,
  with contents write access granted to that job only.

## Impact

- The repository gains a lint configuration and a reusable CI workflow. Lint needs Biome only on a developer's
  machine and the CI runner. Settings, stored data, extension dependencies, the packager, and the VSIX file list
  are unchanged.
- Existing tests exercise the conflict resolver, removal, and packaging. A disposable copy exercises the lint
  failure and recovery through the same CLI command. No new Cursor scenario or manual test is needed for this
  tooling change.

## Tests

1. With clean source, the approved Biome preset reports the eight existing unused-parameter warnings and exits 0.
2. In a disposable copy, introduce an undeclared identifier in an extension command. `node --check extension.js`
   still succeeds. The lint command exits 1 and identifies `extension.js`, the exact line and the rule. Restore
   the copy and repeat lint to recover the baseline.
3. Compare the built VSIX entry names to the pre-change 30-entry payload and run the existing package tests.
4. Validate both GitHub Actions workflows and check that the release job requires the checks job to succeed.
5. Run the full Node test suite and compare any failures with the measured baseline.

## Keep in step

- `docs/development.md`: document the pinned standalone version, platform asset selection, local command,
  advisory warnings, branch checks, and the release gate.
- `AGENTS.md`: update the workflow and developer command references.
- Archive the request and plan under `requests/done/`, then fix the request link in `requests/review.md` and the
  code/workflow links in the archived request.

## Commands

- Baseline and final: `node --check extension.js`, `node scripts/test.js`.
- Final: `biome --version`, `biome lint extension.js lib scripts test`, `node --test test/package.test.js`,
  `node scripts/package.js <temporary VSIX path>`, `actionlint` if available, and `git diff --check`.

## Don't

- Skip npm installation, source-wide rewrites, and formatting in this rollout.
- Do not install the extension in the user's Cursor, publish a release, or create a tag.
- The implementer owns `biome.json`, the two workflows, the two source cleanup files, `docs/development.md` and
  `AGENTS.md`. The main agent owns the request, plan, review link, and Git operations.

## Verification

- Biome 2.6.9 checked all 60 JavaScript files and exited 0 with eight unused-parameter warnings. In a disposable
  copy, an undeclared name in `teamPlugins.syncNow` passed `node --check extension.js` and failed Biome with exit 1
  at `extension.js:2965:73` under `lint/correctness/noUndeclaredVariables`. Restoring the file returned lint to
  exit 0 with eight warnings.
- Actionlint 1.7.7 passed on both workflows. The Linux asset downloaded from the exact CI URL matched the pinned
  digest. The release job depends on the reusable checks job.
- The four package tests passed. Both VSIX builds contained the same 30 entries in the same order. After line
  ending normalization, only the two intended JavaScript modules differed in content.
- The full Windows suite outside the sandbox matched the baseline (345 passed, one existing Windows-only
  draft-removal test failed). The individual failing case passed using Cursor's embedded Node runtime.
- `node --check extension.js` and `git diff --check` passed. Review confirmed the version, documentation,
  original line endings, and planned file scope.
