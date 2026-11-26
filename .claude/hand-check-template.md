<!-- Template of the hand-check file (see "Live test" in .claude/implement.md). The main session copies it to
     requests/NN-<name>.live.md (not committed), fills it from the plan's Hand checks once everything under "Ready for
     you" is in place, opens it in the file pane and ends its turn. The same file then holds the results.
     Delete these comments and every <placeholder> line that doesn't apply. -->
# Hand checks: request <NN>, <title>

Build <version>, installed <time>. Settings backup: `<backup dir>`.

## How this works
- Run the tests in order, at your own pace. One bullet is one action; anything you type, press or pick is in
  backticks.
- 👁 is yours to check. 📋 I check from the logs and files when you are done: nothing to do.
- Write to me only when:
  - what you see differs from a 👁 line: say the test and the step;
  - a step is unclear;
  - you reach a **Ping me** line: send its text and wait for `go on`.
- After the last test, send `done`.

## Ready for you
- Repositories, already in your settings: `<name>` (<what it holds>), `<name>` (<what it holds>).
- Project folders: `<full path>` (<what its .vscode/settings.json sets>). Open one with `Ctrl+R` or
  `File > Open Folder`.
- First: in Cursor press `Ctrl+Shift+P`, run `Developer: Reload Window`.

## Test 1: <what it shows>
Window: <project folder, or "any">
1. <action>
2. <action>

Expected:
- 👁 <what the user sees>
- 📋 <log line, file or git state the session checks>

## Ping me: send `ready for test <N>`
<one line: what the session changes then, and why it can't be prepared in advance>

## Optional: needs Cursor usage (skip unless you have some)

## Test <N>: <what it shows>
In Cursor's chat panel (`Ctrl+L` in Cursor), not this Claude session:
1. <action>

Expected:
- 👁 <what the user sees>

---

## Results (filled by Claude)
Per test: pass, fail or not run; the user's words when they matter; the evidence (commands and output lines, files).

Result: PASS or FAIL. Tests not run and why (optional ones: unconfirmed).
Cleanup: `settings diff` before restore (only the test's changes), after restore (no difference); fixtures and project
folders removed.
