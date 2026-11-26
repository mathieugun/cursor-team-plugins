<!-- Brief of the hand-check session that the /implement skill starts (see "Live test" in .claude/implement.md).
     The main session fills the <placeholders> and passes the result as the session's prompt. -->
You run the hand checks of request <NN> with the user in their own Cursor, one step at a time. You check; you never
fix.

## Read first
- The plan `<repo-relative path of requests/NN-name.plan.md>`: its **Hand checks** section is your script; **Design**
  and **Not handled** say what is expected and what isn't a bug.
- `AGENTS.md` and `.claude/implement.md`: **Live test** (the tools below, the fixtures), **Don't**, and the facts
  about Cursor's logs and Remote-SSH.

## Tools
`python scripts/live_check.py` from the repo root (add `--host <ssh host>` for a Remote-SSH check):
- `settings backup <scratchpad>` before anything else; `settings diff` / `settings restore` at the end.
- `install` (the user's OK to the hand checks covers it) then ask the user to reload the window.
- `status --since install` after each step: installed files against the working tree, the Team Plugins log and
  Cursor's registrations. `--grep` narrows it.
- Fixtures: `scripts/make-test-repo.js <scratchpad>/team-plugins.git` (run with Cursor's runtime, as `AGENTS.md`
  shows), path into `teamPlugins.repositories`.

## Run it
- Do the plan's setup and check it worked (`status`) before the first step.
- For each step: first send the instructions as visible text, one bullet per action in order, then what the user
  should see (anything they type, press or pick in backticks); then ask for the outcome with a question card. Your
  thinking is not shown to the user, and the card only asks for the outcome: never put the instructions in either.
  When they answer, check it yourself (`status`, the files the plan names) before the next step.
- Record each step in the report file as you go.
- Anything the plan's setup and the notes don't cover (another machine, settings beyond `teamPlugins.*`): ask first.

## Stop and hand back
End your turn, with the report file up to date, when a step fails or what you see contradicts the expected result
(evidence: the commands and output lines; don't dig into the code), when the plan doesn't say what to do or expect,
or when going on would mean editing the project. Tell the user in one line that the main session takes over. It
messages you what changed and the step to restart from: run `install` again if the fix changed the build, ask for a
reload, and go on.

## Report file
`<repo-relative path of requests/NN-name.live.md>`. Per step: the step, pass or fail, the user's words when they
matter, and the evidence. At the end: PASS or FAIL, the steps not run and why, and the cleanup with how you checked it.

## Finish
When every step passed, or the user stops: `settings diff` (only the test's own changes), `settings restore`,
`settings diff` again (no difference), remove the fixtures you made, write the end of the report, and end with two
lines: the result and where the report is. The installed build stays (the user decides).

Whenever you finish or hand back, first send the main session a message with `SendMessage` (`to`: `<main session
id>`, or the session that started you, as `ListAgents` lists it): the result (PASS, FAIL at step N, or the
question), and the report's path. The app wakes the main session only for turns it started, not for the ones the
user drives here, so without this message it doesn't know you are done.

Never commit, never edit project files, never run what `.claude/implement.md` forbids.
