# Plan 21: diagnostics never leak credentials or trust a remote archive

## Context

- Repo: cursor-team-plugins (plain JavaScript, CommonJS, no dependency). Request: `requests/21-diagnostics-hygiene.md`.
- Version: 0.8.7, unchanged (the bump is its own release commit).
- Files and functions involved:
  - `lib/remoteErrors.js`: new `redactUrls(text)` (exported). `remoteResult`/`describeRemote` (lines ~100-200) build
    messages that embed `url`.
  - `lib/sync.js`: `logged()` (line ~242) logs `git <args> -> <code>: <stderr>`; `syncManaged` (~203) returns and
    `writeState`s the result of `syncLocked`; `checkRemote` (~396); `discardLocalChanges` (~614); `localChanges`
    (~286) and `checkConflicts` (~336) throw messages with stderr. `syncLocked`'s messages embed `repoUrl` and
    `remote.stdout` (the origin URL, e.g. `the managed clone follows ${remote.stdout} ...`).
  - `lib/contribute.js`: `commitAndPush` (~51) and `pushToBranch` (~126) return results with messages built from
    stderr and `url`, and write the state file.
  - `lib/repos.js`: `withoutCredentials(url)` (~451), used by `projectRepoEntry` (~456), exported.
  - `extension.js`: `log(message)` (~134); `realUi` (~75) and `ui = makeTestUi()` in `activate` (~3806).
  - `scripts/live_check.py`: `fetch_remote` (~240) checks the tar members, then `tar.extractall(dest)`.
  - `.github/workflows/checks.yml`: the Ubuntu lint step.

## Measured facts (don't measure them again)

- The leak is real through the logged arguments: `syncLocked`'s clone runs
  `git clone --progress [--branch b] -- <repoUrl> <tmp>` through `logged`, so the URL as typed (with its
  `user:token@`) is written to the log; `checkRemote` runs `ls-remote --symref -- <repoUrl> HEAD`; `switchInPlace`
  runs `fetch ... -- <repoUrl> ...` and `remote set-url origin <repoUrl>`.
- git 2.47.0.windows.1 hides the userinfo in its own errors (2026-11-28, scratchpad):
  `git clone --progress -- https://user:secret@127.0.0.1:9/x.git c1` ->
  `fatal: unable to access 'https://127.0.0.1:9/x.git/': Failed to connect ...`; the same for `ls-remote` and for a
  `fetch` of an origin configured with that URL; `push` -> `error: failed to push some refs to 'https://127.0.0.1:9/x.git'`.
  Older gits are not hidden this way (not checked here): the tests fake stderr that contains the URL.
- Python on this machine is 3.10.11: `tarfile`'s `filter="data"` is not available (3.10.12+), `Path.is_relative_to`
  is (3.9+). CI's Ubuntu runner has `python3`.
- `test/repos.test.js` `projectRepoEntry` already expects `HTTP://tok@host/p` -> `HTTP://host/p` and
  `ssh://git@host/org/p.git`, `git@host:org/p.git` unchanged.
- `test/live/remote-errors.live.js` step "an unreachable server" sets `teamPlugins.repositories` to
  `['http://127.0.0.1:1/team.git']` and waits for `Team plugins (team): cannot reach 127.0.0.1`. The test hook has
  `logLines()` (Test-mode log lines) and `t.messages(kind)` (recorded dialogs, `{ message, buttons }`).

## Design

### `redactUrls(text)` in `lib/remoteErrors.js`

Returns `String(text)` (`''` for `null`/`undefined`) with the credentials of every URL removed:

- A URL is `<scheme>://<userinfo>@...`, with scheme `[a-z][a-z0-9+.-]*` (case-insensitive) and userinfo the longest
  run of characters other than whitespace, `/`, `?`, `#`, `'`, `"`, `<`, `>` followed by `@` (so it ends at the
  **last** `@` before the host: a raw `@` in a password is removed too). Regex:
  `/([a-z][a-z0-9+.-]*:\/\/)([^\s/?#'"<>]*)@/gi`.
- Scheme `ssh`, `git+ssh` or `ssh+git` (case-insensitive): keep the user name, remove `:password` if any
  (`ssh://git:pw@h/x` -> `ssh://git@h/x`; `ssh://git@h/x` unchanged).
- Any other scheme: remove the whole userinfo and its `@` (`https://user:secret@h/x` -> `https://h/x`,
  `https://ghp_tok@h/x` -> `https://h/x`).
- Text without `://` (a scp-style `git@host:path`, a local path) is unchanged.
- Comment it in one line: a token is often the user part of an HTTPS URL; an SSH user name is no secret and SSH needs it.

### Where it is applied

1. `lib/repos.js`: delete `withoutCredentials` and its export; `projectRepoEntry` uses `redactUrls` (require it from
   `./remoteErrors`). Behaviour change: `ssh://git:pw@host` loses `:pw` in the project settings.
2. `lib/sync.js` `logged()`: the logged line goes through `redactUrls` (the whole line: arguments and stderr). The
   returned `r` is unchanged (its stdout is parsed: `remote get-url` is compared to `repoUrl`).
3. Results returned by the lib: a small helper in `lib/sync.js`, `redacted(result)`, returns `result` with
   `message` replaced by `redactUrls(message)` when `message` is a string (a new object; other fields untouched),
   exported for `contribute.js`. Apply it to:
   - `syncManaged`: to the result of `syncLocked`/the catch, **before** `writeState` and the return.
   - `checkRemote`: every return.
   - `discardLocalChanges`: the result.
   - `commitAndPush`, `pushToBranch`: the returned result, before the state file is written (follow where each writes
     `writeState`; the state file must hold the redacted message).
   - The `Error`s thrown by `localChanges` and `checkConflicts`: `new Error(redactUrls(...))`.
4. `extension.js`, last safety net for what the user sees or pastes:
   - `log(message)`: `const text = redactUrls(message)` and use `text` for both `output.appendLine` and `testLog`.
   - `ui`: a function `redactingUi(base)` returning `{ ...base, showInformationMessage, showWarningMessage,
     showErrorMessage }` where each wraps the base one as `(text, ...rest) => base.X(redactUrls(text), ...rest)`.
     `let ui = redactingUi(realUi)` and in `activate` `ui = redactingUi(makeTestUi())` (so the recorder records the
     redacted text). Leave `showQuickPick`, `showInputBox`, `openExternal` alone.
   - Nothing else: the view and the settings keep the URL as the user typed it.

### `scripts/live_check.py`

- New function `safe_extract(archive, dest)` (module level, near `fetch_remote`): opens the tar, and for every member
  first checks, before extracting anything:
  - `(dest / m.name).resolve().is_relative_to(dest.resolve())`, and
  - `m.isreg() or m.isdir()`.
  A failing member raises `ValueError(f"unexpected entry in the remote archive: {m.name}")`; then `tar.extractall(dest)`.
- `fetch_remote` calls it and turns `ValueError` into `sys.exit(str(err))` (same output as today).
- New `scripts/live_check_test.py` (stdlib `unittest`, `import live_check` from its own folder: insert the script's
  folder in `sys.path`), each case in a `tempfile.TemporaryDirectory()`, building the archive in memory with
  `tarfile.TarInfo`:
  - a member `../<dest name>-other/x` (a sibling of dest whose name starts with dest's) -> `ValueError`, and the
    sibling folder does not exist afterwards;
  - an absolute member named `Path(tmp).anchor + "x"` (`/x` on POSIX, `C:\x` on Windows) -> `ValueError`;
  - a FIFO member (`TarInfo.type = tarfile.FIFOTYPE`) -> `ValueError`, nothing extracted (dest empty);
  - a character device member (`tarfile.CHRTYPE`) -> `ValueError`, dest empty;
  - a symlink member (`tarfile.SYMTYPE`, `linkname="x"`) -> `ValueError`;
  - a valid archive (a directory `a/` and a file `a/b.txt` with content) extracts, and `a/b.txt` holds the content.
  "Nothing extracted": put a valid regular file member **before** the bad one, and assert it is not on disk.
  Runs with `python scripts/live_check_test.py` (`unittest.main()`), exit 0 when green.
- CI: in `.github/workflows/checks.yml`, a step after the Biome lint, Ubuntu only, same `if` as the lint:
  `- name: Test live_check.py` / `run: python3 scripts/live_check_test.py`.

## Impact

- `remoteResult`/`describeRemote`: not changed; their messages are redacted at the public returns (3) and in the
  extension's notification net (4). `describeRemote` keeps embedding `url`.
- `projectRepoEntry` callers in `extension.js`: unchanged (same return shape).
- `readStateFile` in `extension.js` reads state files of other windows: they now hold redacted messages; older files
  are not rewritten (Not handled).
- The live scenario `remote-errors.live.js`: its regexes match the host only, unaffected by redaction.
- `pullRequestPage` reads push stderr (raw `r`, not the logged line): unaffected.

## Not handled

- Logs and state files written before this change.
- Credentials outside a URL (an `http.extraHeader`, a credential helper's output): not in our messages.
- Say both in `docs/development.md` (one line in the paragraph about the log, see Keep in step).

## Tests

All with `node:test`, in the existing files:

- `test/remoteErrors.test.js`, `redactUrls`:
  - `'git clone -- https://user:secret@host/o/r.git dir'` -> `'git clone -- https://host/o/r.git dir'`
  - `'HTTP://tok@host/p'` -> `'HTTP://host/p'`
  - `"fatal: unable to access 'https://u:p@h/x/': boom"` -> `"fatal: unable to access 'https://h/x/': boom"`
  - `'https://u:p@ss@h/x'` (raw `@` in the password) -> `'https://h/x'`
  - two URLs on one line: `'a https://u:s@h1/x b http://t@h2:8080/y'` -> `'a https://h1/x b http://h2:8080/y'`
  - `'ssh://git:pw@h/x'` -> `'ssh://git@h/x'`; `'git+ssh://u:pw@h/x'` -> `'git+ssh://u@h/x'`;
    `'ssh://git@h/x'` unchanged
  - `'git@host:org/p.git'`, `'C:\\repos\\x.git'`, `'file:///srv/x.git'`, `'https://host/x'`, `'mail me at a@b.c'`
    unchanged
  - `redactUrls(undefined)` and `redactUrls(null)` -> `''` (the function returns `''` for them, `String(x)` otherwise)
- `test/sync.test.js` (failing on `main`), a fake `run` that records nothing and answers by `args[0]`; the URL
  `https://user:secret@127.0.0.1:9/team.git`, stderr `fatal: unable to access 'https://user:secret@127.0.0.1:9/team.git/': Could not connect to server`
  (older git wording, so the test does not depend on git's own hiding), code 128; a `log` that collects lines; a temp
  `stateFile` and `lockFile` (follow the existing tests' temp folders):
  - **failing clone**: `syncManaged` with a `managedRepo` that does not exist -> every logged line, the result's
    `message` and the state file's text contain no `secret`; the logged clone line still contains
    `https://127.0.0.1:9/team.git`.
  - **fetch**: an existing managed clone (use the existing helpers to clone a local bare repository, then pass a
    `run` that delegates to the real one except it rewrites... simpler: a fake `run` whose `remote get-url origin`
    returns the secret URL on stdout, `rev-parse --abbrev-ref HEAD` returns `main`, and `fetch` returns code 0) ->
    the logged `fetch` line and anything returned contain no `secret`. If faking every step of `syncLocked` becomes
    long, test the fetch through `checkRemote` (`ls-remote` with the URL in its args, code 0, stdout
    `ref: refs/heads/main\tHEAD\n<sha>\tHEAD`) with `run = logged(fake, log)`: no `secret` in the log lines.
  - **failing fetch**: the same with `fetch` (or `ls-remote`) returning code 128 and the stderr above -> no `secret`
    in the log lines nor in the returned `message` (both the classified case `unreachable` above and an unclassified
    stderr such as `fatal: weird 'https://user:secret@127.0.0.1:9/team.git'`, which takes the fallback message).
  - **a message with the origin URL**: `syncManaged` where `remote get-url origin` answers the secret URL and the
    managed clone has local changes and a different URL -> the `has local changes` message contains no `secret`
    (if this needs a real clone, build it with the existing helpers and set its origin to the secret URL with
    `git remote set-url`; the sync then reports the mismatch before any network call).
  - `localChanges` with `status` failing with that stderr -> the thrown message has no `secret`.
- `test/contribute.test.js`: `pushToBranch` (or `commitAndPush`) on a real clone (existing helpers) whose `run` is the
  real one except `fetch`/`ls-remote`/`push` return code 128 and the stderr above -> no `secret` in the log lines, the
  result's `message`, nor the state file.
- `test/repos.test.js` `projectRepoEntry`: add `ssh://git:pw@host/org/p.git` -> `ssh://git@host/org/p.git`.
- Python: `scripts/live_check_test.py` as above.
- Live: in `test/live/remote-errors.live.js` step "an unreachable server", use
  `http://user:secret@127.0.0.1:1/team.git`; after the message, assert
  `!hook.logLines().some((l) => l.includes('secret'))` and
  `!t.messages('showErrorMessage').some((c) => c.message.includes('secret'))` (also `showInformationMessage`). Check
  the repository name is still `team` (the regex `Team plugins \(team\)` keeps passing).

## Keep in step

- `AGENTS.md`: in the Layout's `remoteErrors` entry add `redactUrls` (`classify`, `remoteHost`, `describeRemote`,
  `remoteResult`, `redactUrls`: ... and the credentials of URLs removed from the log and messages); in `repos` nothing
  (it never listed `withoutCredentials`); in `scripts/` mention `live_check_test.py` (stdlib unittest of
  `live_check.py`'s archive check, run by CI on Ubuntu: `python scripts/live_check_test.py`); in Commands add
  `python scripts/live_check_test.py`. In "Why the code is shaped this way" one bullet: the log (`logged`, `log()`),
  the lib's returned messages and the notifications go through `redactUrls`; the view and the settings keep the URL as
  typed; an SSH user name is kept.
- `docs/development.md`: where the log or `live_check.py` is described, one or two lines: credentials of URLs are
  removed from the log, messages and state files (not from older ones, nor credentials outside a URL);
  `live_check.py` refuses archive members outside the destination and anything but regular files and folders, tested
  by `scripts/live_check_test.py` in CI.
- `README.md`: one sentence where the log ("Show log", Team Plugins output) is mentioned: a token in a repository URL
  is hidden in the log and messages, so the log can be pasted in a bug report. If the README never mentions the log,
  add nothing.
- `scripts/package.js`: check `live_check_test.py` is not packaged (scripts are not, per AGENTS.md: confirm in
  `vsixEntries`).
- No version change.

## Commands

```
node --check extension.js
node scripts/test.js
python scripts/live_check_test.py
biome lint --error-on-warnings extension.js lib scripts test
node scripts/live-test.js remote-errors
```

## Hand checks

None: the unit tests cover every rule, and the live scenario `remote-errors` shows the extension's log and dialogs
without a token. Nothing visual changes.

## Don't

- No commit, no branch change.
- No change outside the listed files without reporting it; don't edit the request or this plan.
- Don't change git's stdout handling or the URL stored in settings, the view or git config.
- Don't add dependencies; Python stays stdlib-only; no new PowerShell.
- Never run `cursor --install-extension` or launch the user's own Cursor (`scripts/live-test.js` is allowed).
- Fix every Biome warning (an unused parameter is removed, or prefixed with `_`).

## Changes after review

Codex review (2026-11-28), all eight findings fixed:

- `redactUrls`: the user info may hold any character but whitespace, `/`, `?` and `#` (curl accepts `'`, `"`, `<`, `>`
  in a password); a scheme has two characters at least (`C://team@work/x` is a Windows path, left alone).
- `remoteHost` ends the user info at the last `@` (`https://user:part@secret@host.test/x` -> `host.test`).
- `baseName` redacts first: a URL without a path (`https://user:secret@host.test`) gave the name, the clone's folder
  and the state file `secret@host.test`.
- `redactingUi` also redacts the `detail` of a modal dialog's options.
- `safe_extract` also refuses an absolute name, a drive, any `..` part (tarfile creates parent folders from the name as
  written: `../new-sibling/../dest/x` resolved inside but created `new-sibling`), and on Windows a device name.
- Tests: the sync state-file check requires the file to exist; the contribute test no longer checks a state file that
  no failed operation writes.

Second Codex review (2026-11-28):

- `redactUrls`: the user info stops at ASCII whitespace only (a no-break space in a password is removed with it) and
  again at `<`, `>` (`<https://a>,b@c` is a link then an address); a scheme right after a `/` or a scheme character is
  part of a path, left alone.
- `redactingUi` moved to `lib/remoteErrors.js` and has a unit test (text and modal `detail`).
- `safe_extract` also refuses a member that would overwrite the archive (`fetch_remote` writes it inside the
  destination) and the superscript device names (`COM¹`).
- The sync test removes the state file before each failing fetch; CI runs the Python test on Windows too.
- Kept on purpose: a repository already followed through a URL with credentials and no path gets a new clone folder
  (and, without a marketplace name, new ids) once, since the old name held the token; written in docs/development.md.

Third Codex review (2026-11-28): one regex can't both catch every password character and never touch the text around
a URL, so the job is split in `lib/remoteErrors.js`:

- `withoutCredentials(url)` (anchored, one URL): the user info is everything up to the last `@` before the first `/`,
  `?` or `#`; nothing after the authority is touched. Used by the project settings writer, `baseName` and `remoteHost`
  (a no-break space or a raw `@` in a password can no longer end up in the host of a message).
- `redactUrls(text)` (free text): a URL may start anywhere (no lookbehind: `...https://u:p@h/x` and `see/https://...`
  are redacted), its user info runs to the last `@` before ASCII whitespace, `/`, `?` or `#` (angle brackets
  included again): it may remove more than the user info, never less.
- `safe_extract` refuses a `:` in a member name on Windows (an NTFS alternate data stream); the clone leak test
  removes the state file before its second failing clone.

Fourth Codex review (2026-11-28): both helpers accept more than two slashes after the scheme (`https:///user:pw@host`);
`withoutCredentials` and `remoteHost` accept git's `<transport>::` prefix (`https::https://user:pw@host`); the free-text
user info runs across spaces and stops only at a line break, `/`, `?` or `#` (a URL pasted with a space in its
password is logged before git refuses it); `remoteHost` stops the host at `?` and `#` (a query of a URL without a path
never reaches a message).

Fifth and last Codex review (2026-11-28): one slash after the scheme counts too (`https::https:/user:pw@host`), and a
`file:` URL is never changed (`file:///alice@work/x` is a path). Not reviewed again, at the user's request.
