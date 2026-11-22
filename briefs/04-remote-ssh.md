# Brief 04: Remote-SSH windows

Make the extension work when Cursor is connected to a remote machine over SSH (a Remote-SSH window). This has never
been tested.

## Goal

In a window connected to a remote host, the user's team plugins are synced and registered as in a local window, and
the view, the status bar and the commands work. Open questions for the analysis, not for this brief:

- Which side the extension should run on (local UI or remote workspace), and whether `vscode.cursor.plugins` exists
  there.
- Where the managed clone and the partial copies live, and whether the agent (which edits files on the remote) can
  reach them.
- Whose git credentials are used, and how `projectPlugins` from the remote project's `.vscode/settings.json` is read.

## Out of scope

- SSH repository URLs and other remote-repository failures: brief 06.
- WSL and dev containers, unless the analysis shows they come almost for free (then list them as a follow-up).

## Done when

- A Remote-SSH window registers the selected plugins, and editing a team skill from that window reaches the clone
  and can be pushed. Checked live with the user's OK.
- README documents how to use the extension in a remote window. Version bumped.
