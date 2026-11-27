# 18 — Check JavaScript with Biome

Catch basic JavaScript mistakes during development and on branch pushes. Today the release workflow runs tests when a version tag is pushed. A misspelled variable in a rarely used Cursor command can pass the syntax check and reach that point without executing. [Release workflow](../../.github/workflows/release.yml#L6)

## Proposal

- Pin the standalone Biome CLI to one version for local development and CI. It runs on Windows and Linux and fits the project's dependency-free CommonJS extension and VSIX packaging. Record the version and the local lint command in `docs/development.md`. [Standalone installation](https://biomejs.dev/installation/install-biome/)
- Run `biome lint` on `extension.js` and JavaScript under `lib/`, `scripts/` and `test/`, including the live scenarios. Start with correctness checks. Explicitly enable `noUndeclaredVariables`, which Biome leaves off by default, and include `noUnusedVariables`. Use read-only linting to keep formatting and automatic rewrites out of the rollout. [Undeclared variables](https://biomejs.dev/linter/rules/no-undeclared-variables/javascript/) · [Unused variables](https://biomejs.dev/linter/rules/no-unused-variables/javascript/)
- Run the same check alongside the existing test suite on branch pushes and before release packaging. Make an undeclared variable fail CI. Review the initial warnings and decide which additional rules should block a build.

ESLint with its recommended rules and Node/CommonJS configuration is a viable alternative if the team later wants custom rules or ESLint plugins. Its conventional project setup adds npm development tooling. The standalone Biome binary is the better fit for the current workflow. [ESLint setup](https://eslint.org/docs/latest/use/getting-started/)

## Trial on 0.8.6

At `545159c`, Biome 2.6.9 checked all 60 tracked JavaScript files. The trial ran only the two named rules. It found zero undeclared variables and two unused bindings, `fromRoot` in conflict resolution and `err` in the removal fallback. A wider correctness preset will need its own baseline. [Conflict resolver](../../lib/materialize.js#L513) · [Removal fallback](../../lib/sync.js#L12)

## Acceptance

- A maintainer can run the documented command from the repository root on Windows or Linux and get the same diagnostics as CI for the same revision.
- In a disposable checkout, an undeclared identifier in an extension command makes the check fail with the file, line and rule. Restoring the file returns the check to its agreed baseline.
- Branch pushes get feedback before tagging. A failing lint check prevents release packaging. Tests still run, and the published VSIX contains only the existing extension payload.
