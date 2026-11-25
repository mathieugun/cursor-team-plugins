# Request 11: real clicks in the isolated Cursor (live tests, layer 3)

Raised by the maintainer (2026-11-25), as the follow-up of request 10, not from `ideas.md`. Plan:
`11-real-clicks.plan.md` (not written yet). Depends on request 10: `scripts/live-test.js`, the scenario files
`test/live/*.live.js`, the Test-mode hook and the `ui` recorder.

## Asked

Request 10's scenarios drive the extension through its test hook: a checkbox is ticked by calling the checkbox handler,
and a notification is answered by the `ui` recorder. Nothing checks that the workbench actually shows those things, or
that a click on them reaches the extension. Add a few scenarios that click the real workbench, as a user would, through
the Chrome DevTools Protocol of the isolated instance. Goal: the remaining hand steps of a live test (look at the view,
click a checkbox, click a notification button, open a context menu) become automatic, except the look itself. For the
look, a screenshot of each step is attached to the run.

## Proposed smoke scenarios (3 to 5)

1. **Tick a checkbox in the Team Plugins view:** open the view (activity bar icon or `workbench.view.extension.teamPlugins`),
   click the checkbox of `docs`, and see `docs` registered (hook and Cursor's plugin log). Untick one skill of
   `review` and see the row's `pie-chart` icon.
2. **Click a notification button:** an error notification of a remote failure (for example the fake ssh's unknown host
   key from request 10) shows **Open terminal**, **Sync now** and **Show log**. Clicking **Sync now** runs a second
   sync; clicking **Show log** shows the Team Plugins output.
3. **Context menu:** right-click a plugin row, **Add to this project**. The workspace's `.vscode/settings.json` then
   lists the plugin, and the row carries the `P` badge.
4. **Status bar:** the `Team plugins: <n>` item is shown, and clicking it opens the view.
5. Optional: Explorer context menu, **Share with team** on a project skill (request 09).

## What is known

- The isolated instance runs and closes by itself (request 10, `scripts/live-test.js`). Node 24 in Cursor's runtime has
  a built-in `WebSocket` (enough for CDP without a dependency). The live tests don't run in CI.
- In Test mode the `ui` recorder replaces every dialog (request 10). A real-click scenario needs the real
  notifications, so the hook must let a scenario switch back to `vscode.window`'s dialogs, for example per scenario
  in the outer script's `setup` result, or a hook member.
- The workbench DOM changes between Cursor versions, which is why this layer stays small.

## Not probed yet (to check in step 1)

- `--remote-debugging-port` on the isolated instance:
  - Does Cursor 3.31 accept it?
  - Does `--remote-debugging-port=0` write `DevToolsActivePort` in the user-data-dir? (A fixed port could clash with
    another program.)
  - Which `/json/list` target is the workbench page?
- Real input:
  - Does `Input.dispatchMouseEvent` at an element's `getBoundingClientRect()` centre tick a tree checkbox, even when
    the window has no OS focus?
  - Is a context menu an HTML menu (`.monaco-menu`) that CDP can click, or a native Windows menu that it can't?
    Does `"window.menuStyle": "custom"` exist in Cursor 3.31 and make it an HTML menu?
- Selectors that are stable enough, all kept in one module so a Cursor update fails with one clear message naming the
  selector and the Cursor version:
  - a tree row by its `aria-label`, and its checkbox;
  - a notification toast and its buttons;
  - a context menu item by its label;
  - the status bar item by its `id`.
- `Page.captureScreenshot` from the outer script: a PNG per step in `out/<scenario>/`.
- Coordination: CDP is driven from the outer process (the extension host can't reach the renderer's DOM), while the
  checks read the hook inside Cursor. Options:
  - the runner and the outer script exchange small files under `out/<scenario>/` ("ready for click 1", "clicked");
  - the outer script also evaluates a command that the extension registers only in Test mode
    (`teamPlugins._testState`?) through the workbench.

## Expected to stay manual

- The look: colours and icons. The screenshots make it a glance, not a click-through.
- Remote-SSH windows (see `ideas.md`).
- A real server with the real credential manager (`test/manual-remote-checks.md`).

## Open questions for the design review

- Which scenarios: the five above, or fewer?
- Where the click scenarios live: in `test/live/` beside the hook scenarios (with a `clicks: true` flag that turns on
  CDP and the real dialogs), or in their own folder?
- Should screenshots be taken for every scenario, including request 10's, as the "look" check?
- How the runner and the outer CDP driver coordinate (files, or a Test-mode command).
- What a click scenario does when a selector is not found: fail, or skip with a warning naming the Cursor version
  (so a Cursor update doesn't block a release)?
