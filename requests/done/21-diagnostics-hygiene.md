# 21. Diagnostics never leak credentials or trust a remote archive

Two findings of the 2026-11-27 review ([review](review.md)) are about the tools that help diagnose problems: the Team
Plugins log and the `live_check.py` helper.

## 1. Credentials in the Team Plugins log (P1)

`logged()` writes every git command's arguments and stderr to the log. An HTTPS URL with a token
(`https://user:token@host/...`) appears there on a clone or fetch, and git repeats it in some error messages. Users
paste that log into bug reports. The project settings writer already redacts the same kind of URL.
[Git logger](../lib/sync.js#L241) · [Settings redaction](../lib/repos.js#L451)

Expected: one redaction helper removes the user info of any URL in text, and every place that writes a URL or git
output to the log, a notification or an error message goes through it. The repository URL shown in the view and
the settings stay as the user typed them.

## 2. The archive check of `live_check.py` (P2)

Before extracting the archive fetched over SSH, the helper checks each member with
`str(target).startswith(str(dest))`, which accepts a sibling such as `<dest>-other/`. It also accepts every member type
other than links. [Archive extraction](../scripts/live_check.py#L248)

Expected: containment is checked by path components (`Path.is_relative_to`), and only regular files and directories are
accepted.

## Acceptance

- Tests first, failing on `main`: a clone, a fetch and a failing fetch with `https://user:secret@...` in a fake `run`
  produce no `secret` in anything logged or returned as a message.
- A small Python check builds an archive with a `../<dest>-other/x` member and one with a device or FIFO member: both are
  refused before anything is extracted.

## Decisions (2026-11-28)

- `redactUrls` keeps the user name of an `ssh://` (or `git+ssh://`, `ssh+git://`) URL and removes only its password;
  every other scheme loses its whole userinfo. The project settings writer uses the same helper.
- Applied in the git logger, the lib's returned messages (and the state files), and as a last net in the extension's
  log and notifications. The view and the settings keep the URL as typed.
- The archive check is tested by a stdlib `scripts/live_check_test.py`, run by CI on Ubuntu.
