# Plan 26: Create team repository

## Context

- Repository: cursor-team-plugins (plain JavaScript, CommonJS, no dependency, no build). Request:
  `requests/26-create-team-repository.md` (read it: it holds the user's decisions).
- Version: `package.json` 0.8.8, unchanged (the release bumps it later to 0.9.0).
- Branch: `request/26-create-team-repository` (already created; don't commit).
- What exists and is reused:
  - `lib/share.js`: `projectItems(root)` (skills, rules, commands, agents of `<root>/.cursor`, each
    `{ kind, name, ext, src, rel }`; folders it can't list are skipped silently), `shareItem(item, pluginDir, name,
    repoDir)` (copies one item, flattens a rule of a subfolder, leaves links of a skill out and reports them in
    `skipped`, renames a skill's frontmatter `name`; returns `{ file, skipped }` where `file` is the rule, command or
    agent file or the skill's `SKILL.md`, or `{ error }`), `suggestName(name)`, `renameSkillName(text, oldName,
    newName)` (rewrites the frontmatter `name:` line when it equals `oldName`; `lib/rename.js` uses it for every kind).
  - `lib/authoring.js`: `KINDS` (labels: skill, rule, command, agent, MCP server), `nameError`, `serverNameError`
    (letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 64), `exists`.
  - `lib/catalog.js`: `readCatalog`, `mcpServerNames` (a non-empty `mcpServers` object: all its keys; else the
    top-level keys whose value is an object with an own `command` or `url`), `serverTable`, `inside(root, dir)` (true
    for `dir` inside or equal to `root`), `MCP_METADATA`. A catalog child is `{ id, kind, name, file, ... }`.
  - `lib/checks.js`: `parseJsonc` (its error message quotes part of the input: never show it), `pushProblems({
    catalog, repoDir, changed, readFile })` (`{ file, line, severity, message }` list).
  - `lib/jsonc.js`: token-based JSONC edits that keep comments; `tokens` exported, `closing`, `members`, `findObject`
    private (the new `removeMember` lives in this file and uses them).
  - `lib/sync.js`: `checkRemote({ run, cwd, repoUrl, branch, idleMs })` -> `{ kind: 'reachable', defaultBranch, empty }`
    or a classified failure; `redacted(result)`; `logged(run, log)`; `removeTree`; `NETWORK_IDLE_MS`, `CHECK_IDLE_MS`.
  - `lib/remoteErrors.js`: `remoteResult(result, { url, branch, op }, fallbackMessage)` (op `'read'` or `'push'`).
  - `lib/contribute.js`: `commitAll(git, repo, message)` (line 20, not exported yet: export it).
  - `lib/gitCheck.js`: `checkGit({ run, cwd })`, `gitCheckMessage(result, { gitPath, machine })`.
  - `lib/repos.js`: `baseName(url)`, `repoName(raw)` (separators, `:` and spaces -> `-`), `normalizeUrl`,
    `parseRepositories`. A catalog plugin carries `pluginName` and `repoKey`; a repository descriptor carries `key` and
    `normalized`.
  - `lib/updates.js`: `ago(date, now)`; `lib/registrar.js`: `registrar.current` (Map plugin name -> registered path).
  - `lib/git.js`: `makeGit(gitPath)` -> `run(args, cwd, timeoutMs, { idleMs, trim })` returning `{ code, stdout,
    stderr }`. Tests that need a runner use `makeGit('git')`; `test/helpers.js`'s `git` (returns stdout, throws) is
    only for fixture setup and assertions.
  - `extension.js`: `realUi`/`ui` (75/88; every dialog goes through `ui`), `log` (136), `cfg` (174), `gitPath` (186),
    `samePath` (260), `enqueue` (344), `ACTIONS` (474), `remoteMachine` (501), `openGitTerminal` (527), `globalList`
    (2156), `addRepositoryEntry` (2161), `enableNew` (2266), `itemsToShare` (2716: how Share builds each original's
    URI from the workspace folder's URI), `shareCommand` (2769) and `removeOriginals` (2911) (the closest existing
    flows: copy their patterns, don't call them), `checkGitCommand` (2942), `registerCommands` (2963; the `reg(...)`
    list ends near 3104), `makeTestUi` (3575), `storage` (121, set at 3798), `catalog`, `descs`, `registrar`.
  - `package.json`: `teamPlugins.newPlugin` command (293), Share (334), `menus.view/title` (350-386), `viewsWelcome`
    (582), `walkthroughs` (589).
- New: `lib/newRepo.js` (pure, never requires `vscode`), `test/newRepo.test.js`, `resources/walkthrough-create.md`,
  `test/live/create-repo.live.js`.

## Measured facts (don't measure them again)

1. An empty repository answers `git ls-remote <url>` and `git ls-remote --symref <url> HEAD` with no output and exit
   0 (git 2.47, local bare repository; `-c protocol.version=2` and a `file://` URL: the same). No unborn HEAD is
   advertised, so the default branch of an empty remote is unknown before the first push.
2. After pushing `main` to a bare repository whose HEAD points to `trunk`, `git ls-remote --symref <url> HEAD` prints
   nothing (exit 0): HEAD is dangling. `syncManaged` without a branch would then clone a repository with no checkout.
   Hence the entry gets an explicit branch unless the server's HEAD is the pushed branch. `ls-remote <url> HEAD` alone
   also prints nothing for such a non-empty repository: emptiness is tested with `ls-remote` and no pattern.
3. Without any identity configured (`HOME` and `XDG_CONFIG_HOME` on an empty folder, `GIT_CONFIG_NOSYSTEM=1`),
   `git var GIT_AUTHOR_IDENT` exits 128 with `Author identity unknown`; with `GIT_AUTHOR_NAME`/`_EMAIL` and
   `GIT_COMMITTER_NAME`/`_EMAIL` in the environment, `git var GIT_COMMITTER_IDENT` exits 0. `makeGit` passes
   `process.env` to git (`lib/git.js:71`). The maintainer's machine has no global `user.name`.
4. Cursor's agent host (3.32, `extensions/cursor-agent-host/dist/4846.js`, read, not run): a plugin's MCP config
   replaces `${CURSOR_PLUGIN_ROOT}` (and `${CLAUDE_PLUGIN_ROOT}`) with the plugin folder; it collects `${env:NAME}`,
   `${NAME}` and `${NAME:-default}` references (`/\$\{(?:env:([A-Z][A-Z0-9_]*)|([A-Z][A-Z0-9_]*)(?::-([^}]*))?)\}/g`)
   into a per-plugin settings schema, and marks as secret the names whose words (camelCase and non-alphanumerics split
   to `_`, upper-cased) include CREDENTIAL, CREDENTIALS, KEY, PASSPHRASE, PASSWORD, SECRET or TOKEN.
   **Live probe** (isolated instance, signed out, Cursor 3.32.10, 2026-11-28, three runs): a server of an
   extension-registered plugin gets `${env:VAR}` and `${VAR}` replaced by the value from **Cursor's own process
   environment** (the one it was started with), in `args` and `env`; `${CURSOR_PLUGIN_ROOT}` becomes the registered
   plugin folder. VAR unset: `${env:VAR}` becomes `""` (the server still starts, with an empty value), `${VAR}` stays
   literal. Not tested: `url`, `headers`, `command`; a signed-in Cursor with a per-plugin settings value. So the
   messages say "reads it from the environment variable NAME" and tell the user to restart Cursor after setting it.
5. From the Codex review of this plan (read-only probes, not re-run): `parseJsonc` on invalid input throws a message
   quoting part of the input; `redactUrls` and `baseName` keep a URL's query (`?token=...`); `git check-ref-format
   --branch` rejects `HEAD`, `release/ends.` and `release/component.lock/next`.
6. From the notes, not checked again: Cursor does not read `~/.cursor/rules` (Share lists only skills, commands and
   agents of `~/.cursor`); a remote window's file system has no trash; on Windows `fs.rmSync` fails on git's
   read-only files (use `sync.removeTree`); Cursor reads a plugin's rules only directly in `rules/`;
   `scripts/package.js` packages `resources/` non-recursively; `package.test.js` lists the packaged files.
7. Live scenarios run in an isolated Cursor whose `os.homedir()` is the real user home, and the workspace folder
   `ctx.ws` is wiped before each scenario (`scripts/live-test.js:95`). A file moved to the trash there goes to the real
   recycle bin (accepted: a few test files).

## Design

### The flow (command `teamPlugins.createTeamRepository`, title `Create team repository...`)

Every dialog through `ui`. Cancel text (used below): `ui.showInformationMessage('Team plugins: nothing was
written.')`. Every exit after the staging folder exists removes it in a `finally` (after closing its scratch tabs, see
**Cleanup**), except where said.

1. **Git ready**: `newRepo.gitReady({ run, cwd: storage })`. Not ok: `ui.showErrorMessage('Team plugins: ' +
   message)`, stop.
2. **Staging**: `staging = path.join(storage, 'new-repository', `${Date.now()}-${process.pid}`)` with `repo/`,
   `merge/`, `compare/` and an `.alive` file inside; `.alive` is touched (`fs.utimesSync`) every 60 s by a
   `setInterval` cleared in the `finally`. Before creating it, every other folder in `<storage>/new-repository` whose
   `.alive` mtime (or, without `.alive`, the folder's mtime) is older than 24 hours is removed with `sync.removeTree`
   (errors ignored).
3. **Sources**: `ui.showQuickPick(items, { canPickMany: true, ignoreFocusOut: true, placeHolder: 'Where to look for
   rules, skills, commands, agents and MCP servers' })`. Items, in order:
   - each workspace folder: `{ label: folder.name, description: folder.uri.fsPath, picked: true }`;
   - `{ label: '~/.cursor', description: 'your personal skills, commands, agents and MCP servers', picked: true }`;
   - `{ label: '$(folder-opened) Other folders...', description: 'project folders that are not open', picked: false }`.
   Cancelled or nothing picked: stop. **Other folders...** picked: `ui.showOpenDialog({ canSelectFolders: true,
   canSelectFiles: false, canSelectMany: true, openLabel: 'Scan', title: 'Project folders to scan' })`; cancelled with
   nothing else picked: stop. A source is `{ label, root, uri, personal }`: a workspace folder's `uri` is
   `folder.uri` (as `itemsToShare` uses it), `~/.cursor`'s is `vscode.Uri.file(os.homedir())` with `personal: true`,
   an opened folder's is the dialog's URI (label: its base name). Drop a source whose real path
   (`fs.realpathSync(root)`, else `path.resolve(root)`) is `samePath` of an earlier one's. Two sources with one label:
   the later ones get ` (2)`, ` (3)`.
4. **Scan**: `newRepo.scan(sources)` -> `{ groups, errors }`. Every error is logged (`` `not read: ${file}: ${message}` ``).
   No group: `ui.showInformationMessage('Team plugins: no rule, skill, command, agent or MCP server found in ' +
   labels.join(', ') + '.' + (errors.length ? ` ${errors.length} file(s) could not be read: see the log.` : ''))`,
   stop.
5. **Preview**: write `newRepo.previewMarkdown({ sources, groups, errors })` to
   `<staging>/new-team-repository-preview.md`, then `vscode.commands.executeCommand('markdown.showPreview',
   vscode.Uri.file(file))` and log `` `opened the preview ${file}` `` (a failure is logged, not shown).
6. **What to import**: `ui.showQuickPick(groupItems, { canPickMany: true, ignoreFocusOut: true, placeHolder: 'What goes
   in the team repository (the preview lists the details)' })`, one item per group, in group order:
   `{ label: group.name, description, picked: group.suspects.length === 0, group }`. `description`:
   `` `${KINDS[kind].label} · ${status}` ``, plus `' · may contain a secret'` when it has suspects, plus
   `` ` · ${n} reference${n === 1 ? '' : 's'} may break` `` when it has references. `status`: single: the copy's
   `where`; identical: `identical in N places`; variants: `N versions: you pick one next`. Cancelled or empty: cancel
   text, stop.
7. **Decisions**, for each picked group whose status is `variants`, in order (the loop below). Escape on the main
   pick: cancel text, stop.
8. Nothing left after the decisions (all left out): cancel text, stop.
9. **Unchanged since the preview**: for each chosen copy that will be copied (Use: the version's first copy; Keep each
   under its own name: each version's first copy), `newRepo.stillSame(copy)`; one false:
   `ui.showErrorMessage(`Team plugins: ${where} changed since the preview: run Create team repository again.`)`, stop.
10. **URL**: `ui.showInputBox({ prompt: 'Git URL of an empty repository for the team (create it on your Git host
    first)', placeHolder: 'https://github.com/your-org/team-plugins.git', value: <the previous URL when asked again>,
    ignoreFocusOut: true, validateInput })`. `validateInput(v)`: `newRepo.urlError(v)` || (`normalizeUrl` equal to an
    entry of `teamPlugins.repositories` -> `` `${v.trim()} is already in teamPlugins.repositories` ``) || `null`.
    Cancelled: cancel text, stop. `url = newRepo.destination(v)` (an absolute path stays as it is, written with
    `path.resolve`). Then `newRepo.checkEmptyRemote({ run, cwd: storage, url, idleMs: sync.CHECK_IDLE_MS })`:
    - `{ kind: 'empty' }`: go on.
    - otherwise: `ui.showErrorMessage('Team plugins: ' + result.message, ...buttons)` with buttons `'Change URL'`,
      then `ACTIONS.terminal.label` when `result.actions` holds `'terminal'`, then `'Show log'`. `Change URL`: step 10
      again. The terminal button: `openGitTerminal(url)`, then the same error again. `Show log`: `output.show()`, stop.
      Dismissed: stop.
11. **Plugin name**: `ui.showInputBox({ prompt: 'Name of the plugin that holds the imported items', value:
    share.suggestName(baseName(url)) || 'team', ignoreFocusOut: true, validateInput: (v) => nameError(v.trim()) ||
    null })`. Cancelled: cancel text. The repository name (`marketplace.json` `name`) is
    `repoName(baseName(url))`.
12. **Build**: `newRepo.buildRepository(path.join(staging, 'repo'), { marketplaceName, pluginName, items, servers })`.
    `errors` not empty: `ui.showErrorMessage('Team plugins: could not write the new repository: ' +
    errors.map((e) => `${e.name}: ${e.message}`).join('; '))`, stop.
13. **Problems**: `readCatalog(repoDir)`, then `pushProblems({ catalog, repoDir, changed: files, readFile })`
    (`readFile`: UTF-8 text or `null`). A group whose built file (or a file inside its built skill folder) has an
    error-level problem is marked `dropped`.
14. **Branch**: `branch = await newRepo.defaultBranch({ run, cwd: storage })`.
15. **Confirm**: `ui.showWarningMessage('Create the team repository at ' + url + '?', { modal: true, detail },
    button)`, `button` = `'Create and push anyway'` when a problem is error-level, else `'Create and push'`; anything
    else: cancel text, stop. `detail`: these lines joined with `\n`, those with a zero count left out:
    - `` `The plugin ${pluginName} with ${n} items: ${counts}.` `` (`counts`: per kind in the order skill, rule, command,
      agent, MCP server, `` `${k} ${label}${k === 1 ? '' : 's'}` ``, joined `, `);
    - `` `${k} secret value${s} replaced by environment variables: ${variables}.` ``;
    - `` `${k} item${s} may contain a secret: ${names}.` `` (suspects of the imported groups, merges included);
    - `` `${k} reference${s} may break (see the preview).` ``;
    - `` `Links left out of skills: ${list}.` ``;
    - `` `${k} problem${s} Cursor would report, ${e} that make it drop an item: ${first five as "rel:line message"}.` ``;
    - `` `The branch ${branch} is pushed to ${url}, then the repository is added to the ones you follow.` `` (always).
16. **Still empty**: `checkEmptyRemote` again; anything but `empty`: the step 10 error message (without `Change URL`),
    stop.
17. **Commit and push**, inside `vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title:
    'Team plugins: creating the team repository' }, ...)`, git through `logged(run, log)`:
    - `newRepo.initAndCommit({ run, dir: repoDir, branch, files })` -> `{ head }` or an error result:
      `ui.showErrorMessage('Team plugins: ' + message)`, stop.
    - `newRepo.pushNew({ run, dir: repoDir, url, branch })`. Failure: `ui.showErrorMessage('Team plugins: ' +
      result.message, 'Try again', [terminal label when actions hold 'terminal'], 'Show log')`. `Try again`:
      `newRepo.remoteBranchState({ run, cwd: storage, url, branch, head })`: `'pushed'` -> go on as pushed;
      `'absent'` -> push again; `'other'` -> `ui.showErrorMessage(`Team plugins: the branch ${branch} of ${url} now
      holds other commits: nothing more was pushed.`)`, stop; an error result -> the same failure message again. The
      terminal button: `openGitTerminal(url)`, then the failure message again. `Show log`: `output.show()`, stop.
      Dismissed: stop.
18. **Follow it**: `check = await sync.checkRemote({ run, cwd: storage, repoUrl: url, idleMs: sync.CHECK_IDLE_MS })`;
    `entry = newRepo.repositoryEntry(url, branch, check)`; `await addRepositoryEntry(entry)` in a `try`. A throw:
    `ui.showErrorMessage(`Team plugins: pushed ${url}, but could not add it to your repositories: ${err.message}`,
    'Try again')`; `Try again` repeats only `addRepositoryEntry(entry)`; dismissed: stop (staging removed). Log
    `` `created the team repository ${url} (${branch}) with ${n} items` ``.
19. **Closing**: remove the staging folder, then `ui.showInformationMessage(text, 'Replace the originals', 'Keep
    them')`, `text` =
    `` `Team plugins: created ${url} with the plugin ${pluginName} (${n} items). It is being cloned. Your originals are still in your projects: replace them with the plugin so the agent doesn't read each item twice, or keep them and tick the plugin later in the Team Plugins view.` ``.
    The command returns this promise chained with `replaceOriginals(...)` when that button is picked (a scenario
    awaits the command).

**Cleanup** (in the `finally`, and before the staging folder is removed at step 19): close every tab whose input is a
`vscode.TabInputText` or `vscode.TabInputTextDiff` with a URI (original or modified) inside the staging folder and
that is not dirty, and every tab whose label contains `new-team-repository-preview.md`
(`vscode.window.tabGroups.close(tabs)`); failures are logged.

### Variant decision loop (step 7)

For a group with versions `v1..vn` (each a list of identical copies; `where` of a version = its first copy's `where`;
the group's index `g` in the group list):

`ui.showQuickPick(items, { ignoreFocusOut: true, placeHolder: `${Label} ${name}: ${n} versions. Which one goes in the
team repository?` })` (`Label`: kind label with a capital first letter). Items, in order:

- per version: `{ label: `$(check) Use ${where}`, description, detail, version: i }`. `description`: for an item
  `` `${lines} lines · ${ago(mtime, Date.now())}` `` (of the main file); for an MCP server `ago` of its `mcp.json`'s
  mtime. `detail`: when the version has several copies, `` `same as ${other wheres joined ', '}` ``.
- `{ label: '$(diff) Compare...', compare: true }`
- `{ label: '$(edit) Merge by hand...', merge: true }`
- `{ label: '$(split) Keep each under its own name', description: names.join(', '), split: true }`
- `{ label: '$(close) Leave out', out: true }`

Scratch paths never hold a name: `compare/<g>-<i>.json`, `compare/empty`, `merge/<g>/`.

- **Use**: `{ kind: 'use', version: i }`.
- **Compare**: 2 versions: left v1, right v2; more: `ui.showQuickPick(versions, { placeHolder: 'Left side of the
  diff' })` then the others with `'Right side of the diff'` (labels: `where`); cancelled: back to the main pick. The
  files: a rule, command or agent: the two files; a skill: `newRepo.skillDiff(a, b)`: one rel -> that file, several ->
  `ui.showQuickPick(rels, { placeHolder: 'File of the skill to compare' })` (cancelled: back to the main pick); a side
  that lacks the file is `compare/empty` (an empty file). An MCP server: each side's redacted entry written to
  `compare/<g>-<i>.json` (`JSON.stringify(entry, null, 2) + '\n'`). Then `vscode.commands.executeCommand('vscode.diff',
  left, right, `${name}: ${whereLeft} ↔ ${whereRight}`)`, back to the main pick.
- **Merge by hand**: `ui.showQuickPick(versions, { placeHolder: 'Version to start from' })` (cancelled: back). Copy the
  base into `merge/<g>/`: a skill's folder (`fs.cpSync`, recursive, links left out like `shareItem`), a file item as
  `item<ext>` (no name in the path), an MCP server as `server.json` (its redacted
  entry). Open a diff per other version: `vscode.diff(otherFile, mergeFile, `${name}: ${whereOther} ↔ your merge`)` (a
  skill: one diff per differing file of each other version, at most 10 tabs). Then
  `ui.showInformationMessage(`Merging the ${label} ${name}: edit the right side of the diff (${mergeFile}), save it, then press Done.`, 'Done', 'Back')`
  (`mergeFile`: the skill's `SKILL.md` in the merge folder, else the merge file; not modal).
  - `Done`: an open text document inside `merge/<g>/` that is dirty -> `ui.showWarningMessage('Team plugins: save ' +
    file + ' first.')` and the Done/Back message again. An MCP server's merge file must parse (`parseJsonc`) to a plain
    object, else `ui.showErrorMessage('Team plugins: the merged MCP server is not a valid JSON object.')` (no parser
    message) and the Done/Back message again. Then `{ kind: 'merged', src, ext }` (`src`: the folder or file; for MCP
    the parsed object, run through `redactServer` again, its `replaced` added to the group's). The merge is scanned
    like a copy (`textSuspects` of its text files, `redactServer`'s suspects for MCP): new suspects are added to the
    group's `suspects` with `where: 'your merge'`.
  - `Back` or dismissed: remove `merge/<g>/`, back to the main pick.
- **Keep each under its own name**: `{ kind: 'split', names }`.
- **Leave out**: `{ kind: 'out' }`.

The import names are reserved in one `taken` set per kind for the whole run: before the loop, the names of every
picked non-variant group; each decision adds its names (Use and Merge: `group.name`; split: its names).
`names` for the split item: `newRepo.splitNames(group, taken.get(kind))`, computed when the pick is shown.

### `lib/newRepo.js` (pure; errors as values)

Header comment: `// Creating a team repository from the rules, skills, commands, agents and MCP servers of projects and
// ~/.cursor: scan, group, preview, build, push. Pure: never requires vscode.`

1. `SECRET_WORDS = new Set(['CREDENTIAL', 'CREDENTIALS', 'KEY', 'PASSPHRASE', 'PASSWORD', 'SECRET', 'TOKEN',
   'AUTHORIZATION', 'APIKEY'])`. `secretName(name)`: split like Cursor (`.replace(/([a-z\d])([A-Z])/g, '$1_$2')
   .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/[^a-z\d]+/gi, '_').toUpperCase().split('_')`, empty parts
   dropped), true when a part is in the set.
2. `TOKEN_SHAPE = /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})/`.
3. `REFERENCE = /\$\{[^}]*\}/g`. `envVarName(text)`: upper-case, every run of `[^A-Za-z0-9]` -> `_`, leading and
   trailing `_` trimmed; prefixed with `MCP_` when it does not start with a letter.
4. `literal(v, { scheme = false } = {})`: `v` is a string; `rest = v.replace(REFERENCE, '')`; with `scheme`, a leading
   `/^(Bearer|Basic|Token)\s+/i` is removed from `rest` too; true when `rest.trim()` is not empty.
5. `redactServer(name, entry)` -> `{ entry, replaced: [{ where, variable }], suspects: [string] }`; `entry` a deep copy,
   input untouched. A non-object entry: returned as is, no findings. Variables already given in this entry are
   remembered: a variable name that would repeat gets `_2`, `_3` appended.
   - `env` (plain object): each key `k` with `secretName(k)` and `literal(value)` -> value `${env:<envVarName(k)>}`,
     `{ where: `env.${k}`, variable }`.
   - `headers` (plain object): each header `h` with `secretName(h)` and `literal(value, { scheme: true })`: when
     `/^(Bearer|Basic|Token)\s+/i` matches the value, variable `envVarName(`${name}_TOKEN`)` and value
     `` `${scheme word as written} ${'${env:'}${variable}}` ``; else variable `envVarName(`${name}_${h}`)` and value
     `${env:<variable>}`. `{ where: `headers.${h}`, variable }`.
   - Suspects, never holding the value: `url` (string) of an `http`/`https` URL with user info
     (`/^https?:\/\/[^/?#]*@/i`) -> `'the URL holds credentials'`; a query parameter (after `?`, split on `&`, name and
     value `decodeURIComponent`d, unchanged when that throws) with `secretName(name)` and `literal(value)` ->
     `` `the URL parameter ${name} holds a value` ``; in `args` (array): `--flag=value` or `-flag=value` with
     `secretName(flag)` and `literal(value)` -> `` `args[${i}] sets ${flag}` ``; an arg `--flag` or `-flag` with
     `secretName(flag)` followed by a literal arg not starting with `-` -> `` `args[${i + 1}] follows ${arg}` ``; any
     string anywhere in the redacted entry (recursively; path written `a.b`, `args[2]`) matching `TOKEN_SHAPE` ->
     `` `${path} looks like an access token` ``. No duplicate strings.
6. `textSuspects(text)` -> 1-based line numbers whose line matches `TOKEN_SHAPE`.
7. `normalizeText(text)`: BOM removed, `\r\n` -> `\n`. `isText(buf)`: no `0` byte and
   `Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)`.
8. `skillFiles(dir)` -> `[{ rel, full }]`, sorted by `rel` (`/`), regular files only, recursive, links (file or folder,
   `lstat`) left out like `shareItem`.
9. `contentKey(item)`: sha1 hex. A file's bytes count as `normalizeText(buf.toString('utf8'))` when `isText(buf)`, else
   the raw bytes. File item: that of its file. Skill: over `skillFiles`, each `` `${rel}\0` `` + the file's bytes as
   above + `\0`, in order.
10. `reservedName(n)`: `/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i`. `importName(name)`: `name` when `nameError(name)` is
    `''`, else `suggestName(name)`, else `''`; a result that is `reservedName` gets `-item` appended. (The caller uses
    the kind when `''`.)
11. `itemReferences(item, root)` -> `[{ file, line, target, resolved, why }]`. Text files: the file of a rule, command
    or agent; every `skillFiles` file of a skill whose extension is `.md`, `.mdc`, `.markdown` or `.txt`. Per line
    (1-based):
    - links: `/\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g`; a target starting with `#` is skipped; `mdc:<rest>`
      resolves `<rest>` from `root` (`why: 'link'`); other `scheme:` targets (`/^[a-z][a-z0-9+.-]*:/i`, not a Windows
      drive `/^[a-z]:[\\/]/i`) are skipped; `#...` and `?...` are cut, the rest `decodeURIComponent`d (unchanged when
      that throws); absolute (`path.isAbsolute`) -> as is, `why: 'absolute'`; else from the file's folder,
      `why: 'link'`.
    - mentions: `/(?:^|[\s(])@([A-Za-z0-9_./\\-]*[./\\][A-Za-z0-9_./\\-]*[A-Za-z0-9_])/g` -> from `root` first, then
      from the file's folder; the first that exists wins; `why: 'mention'`.
    - A target matching `TOKEN_SHAPE` is skipped. Kept when `resolved` exists and is not part of the item (a skill: not
      `inside` its real folder; a file item: not the file itself). Deduplicated by `file`, `line` and `target`.
12. `serverReferences(entry, root)` -> `[{ where, value, why }]`, on the redacted entry: strings of `command`,
    `args[i]`, `cwd` and `env.<k>`, skipping those matching `TOKEN_SHAPE`. `/\$\{workspaceFolder(?::[^}]*)?\}/` ->
    `'workspaceFolder'`; else absolute and existing -> `'absolute'`; else starting with `./` or `../` (either
    separator) -> `'relative'`; else containing `/` or `\`, not `scheme:`, and `fs.existsSync(path.resolve(root, s))`
    -> `'relative'`.
13. `scanSource(source)` -> `{ items, servers, errors }`:
    - items: `share.projectItems(source.root)`, rules dropped when `source.personal`. Each:
      `{ ...item, source, originalName: item.name, name: importName(item.name) || item.kind, key: contentKey(item),
      originalKey: <same as key>, main, lines, mtimeMs, where, suspects, references }`. `main`: the file, or the skill's
      `SKILL.md`; `lines`: `normalizeText(text).split('\n').length`, minus one when it ends with a newline; `where`:
      `~/${rel}` for personal, else `${source.label}/${rel}`; `suspects`: for every text file (as for references)
      `` `${relative file} line ${n} looks like an access token` `` (relative from the skill folder, else the file's
      base name); `references`: `itemReferences(item, source.root)`. An unreadable file: an `errors` entry `{ file,
      message: err.code || 'unreadable' }`, the item left out.
    - servers: `<root>/.cursor/mcp.json` when it exists. A parse failure -> error `'not valid JSONC'` (never the
      parser's message); not a plain object -> `'not a JSON object'`. Then for each `mcpServerNames(obj)` name: a name
      with a `serverNameError` -> error `` `the server name ${name} can't be used in a plugin` ``; an entry that is not a
      plain object -> error `` `the server ${name} is not an object` ``; else `{ kind: 'mcp', name, originalName: name,
      source, file, where, entry, replaced, suspects, references, key, originalKey, mtimeMs }` where `{ entry,
      replaced, suspects } = redactServer(name, original)`, `key = canonicalJson(entry)` (sorted keys, recursive),
      `originalKey = sha1(canonicalJson(original))` (never shown or logged), `references = serverReferences(entry,
      root)`, `where`: `~/.cursor/mcp.json` or `${label}/.cursor/mcp.json`. The original entry is not kept on the
      record.
14. `scan(sources)` -> `{ groups, errors }`: items then servers of every source, in source order. Group key
    `` `${kind}:${name}` ``; groups in order of first appearance, item groups before MCP groups (kind order skill,
    rule, command, agent, then mcp). Group: `{ id, kind, name, copies, versions, status, suspects, references,
    replaced, renamed }`; `versions`: copies grouped by `key` in first-appearance order; `status`: `'single'`,
    `'identical'` or `'variants'`; `suspects`, `references`, `replaced`: the union over copies, each entry with the
    copy's `where`; `renamed`: copies whose `originalName !== name`.
15. `stillSame(copy)`: an item: `contentKey` of its `src` equals `copy.originalKey` (a missing or unreadable file:
    false); an MCP server: its `file` parses, the server is still there and `sha1(canonicalJson(entry))` equals
    `copy.originalKey`.
16. `previewMarkdown({ sources, groups, errors })` -> text, exactly (sections with no entry left out; `L` = kind label;
    `N` = count):

    ```
    # New team repository: preview

    Scanned: <labels joined ', '>. Nothing is written until you confirm at the end.

    ## Ready to import (N)

    - L `name`: <where>
    - L `name`: identical in <where>, <where> (N copies, imported once)

    ## Variants that need a decision (N)

    - L `name`: N versions: <where> (<lines> lines), <where> (<lines> lines)

    ## May contain a secret (N)

    Unticked in the next step: tick them only if you checked them.

    - L `name` (<where>): <suspect>

    ## Secrets replaced (N)

    - MCP server `name` (<where>): <where in entry> now reads the environment variable VARIABLE.

    ## References that may break (N)

    - L `name` (<where>:<line>): links to <target>, which stays where it is.
    - L `name` (<where>:<line>): mentions <target>, which stays where it is.
    - L `name` (<where>:<line>): points to <target>, a path on this machine only.
    - MCP server `name` (<where>): <field> uses ${workspaceFolder}: every project needs that file.
    - MCP server `name` (<where>): <field> is the relative path <value>: in a plugin, write ${CURSOR_PLUGIN_ROOT}/<path> for a file the plugin holds.
    - MCP server `name` (<where>): <field> is the absolute path <value>, a path on this machine only.

    ## Renamed for Cursor (N)

    Cursor accepts lowercase letters, digits, hyphens and dots.

    - L `originalName` (<where>) becomes `name`.

    ## Not read (N)

    - <file>: <message>
    ```

    "Ready to import" holds single and identical groups (single: first line form, identical: second); "Variants" omits
    `(… lines)` for MCP. A blank line after each heading and after each list; the text ends with one newline. The
    `<where>` of a reference in a skill is the skill's `where` plus `/` and the file's path inside the skill.
17. `skillDiff(dirA, dirB)` -> sorted rels of `skillFiles` that differ (bytes counted as in `contentKey`) or exist on
    one side.
18. `splitNames(group, taken)`: for each version, `suffix` = `suggestName(raw)`, `raw` = `personal` for `~/.cursor`,
    else the source label, plus for a rule in a subfolder of `.cursor/rules` `-` and the subfolders after
    `.cursor/rules/` joined with `-`. Name = `fit(group.name, suffix)` where `fit(stem, tail)` cuts `stem` to
    `64 - tail.length - 1` characters, strips trailing non-alphanumerics, and returns `` `${stem}-${tail}` ``. When that
    is taken (in `taken` or given earlier in this call), fails `nameError`, or is `reservedName`: `fit(<that name>,
    String(k))` for `k = 2, 3, ...` up to 999; none free: `` `${group.kind}-${Date.now()}-${i}` ``. Returns the names
    in version order (does not modify `taken`).
19. `buildRepository(repoDir, { marketplaceName, pluginName, items, servers })` -> `{ pluginDir, files, skipped,
    errors }`. `items`: `[{ kind, name, originalName, ext, src }]`; `servers`: an array `[{ name, entry }]`.
    - `<repoDir>/.cursor-plugin/marketplace.json`: `{ name: marketplaceName, plugins: [{ name: pluginName, source:
      './' + pluginName }] }`, `JSON.stringify(obj, null, 2) + '\n'`.
    - `<repoDir>/<pluginName>/.cursor-plugin/plugin.json`: `{ name: pluginName, version: '0.1.0' }`, same format.
    - each item: `shareItem({ kind, name: originalName, ext, src }, pluginDir, name, repoDir)`; an error ->
      `{ name, message }` in `errors`, go on; for a rule, command or agent whose `name !== originalName`, the copied
      file goes through `renameSkillName(text, originalName, name)` (written only when changed); `skipped` gets
      `` `${name}/${rel}` `` per skipped link.
    - servers (when any): `<pluginDir>/mcp.json` = `JSON.stringify({ mcpServers }, null, 2) + '\n'` with `mcpServers`
      built by `Object.fromEntries` in the given order (names passed `serverNameError`, so no `__proto__`).
    - `files`: every file under `repoDir` after the build (a walk, `.git` excluded), relative with `/`, sorted.
20. `IDENTITY_MESSAGE`: moved from `commitAll` into an exported constant of `lib/contribute.js` (same text), used by
    both. `gitReady({ run, cwd })` -> `{ ok: true }` or `{ ok: false, message }`: `checkGit`; status other than
    `'ok'` -> `gitCheckMessage(result).message`. Then `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`
    (cwd `cwd`): a non-zero exit -> `IDENTITY_MESSAGE`.
21. `defaultBranch({ run, cwd })`: `git config --get init.defaultBranch`; when exit 0 and the trimmed value passes
    `git check-ref-format --branch <value>` (exit 0), that value; else `'main'`.
22. `urlError(text)`: trimmed; empty -> `'Enter a Git URL'`; starts with `-` -> `"A Git URL can't start with -"`;
    `/^https?:\/\/[^/?#]*@/i` -> `'Leave the user name and password out of the URL: git gets them from your credential
    manager.'`; contains `?` or `#` -> `'A Git URL with ? or # is not supported here.'`; a local path (not
    `/^[a-z][a-z0-9+.-]*:\/\//i`, not scp-like `/^[^\s/\\@:]+@[^\s/\\:]+:/` or `/^[A-Za-z0-9.-]{2,}:[^\\/]/`) that is
    not absolute (`path.isAbsolute`) -> `'Give the absolute path of a local repository.'`; else `''`.
    `destination(text)`: trimmed; a local absolute path -> `path.resolve(text)`; anything else as is.
23. `checkEmptyRemote({ run, cwd, url, idleMs })`: `run(['ls-remote', '--', url], cwd, 0, { idleMs })`. Non-zero:
    `redacted(remoteResult(r, { url, op: 'read' }, `cannot reach ${url}: ${r.stderr}`))`. Trimmed stdout empty:
    `{ kind: 'empty' }`. Else `redacted({ kind: 'error', reason: 'notEmpty', message: `${url} already has commits: give the URL of an empty repository, or follow this one with Add repository.` })`.
24. `initAndCommit({ run, dir, branch, files })`: `git init -q -b <branch>` (non-zero: `{ kind: 'error', message:
    `git init failed: ${stderr}` }`); `commitAll(run, dir, 'Create the team repository')` (an error result: returned);
    `git ls-tree -r -z --name-only HEAD` (`{ trim: false }`): the NUL-separated names, sorted, must equal `files`, else
    `{ kind: 'error', message: `git left out ${missing joined ', '} (a .gitignore in a copied skill?): nothing was pushed.` }`
    (and extra names, if any, listed the same way as `git added ...`). Success: `{ head: <git rev-parse HEAD> }`.
25. `pushNew({ run, dir, url, branch })`: `run(['push', '--progress', url, `HEAD:refs/heads/${branch}`], dir, 0,
    { idleMs: NETWORK_IDLE_MS })`. Exit 0: `{ kind: 'pushed' }`. Else `redacted(remoteResult(r, { url, branch, op:
    'push' }, `git push failed: ${r.stderr}`))`.
26. `remoteBranchState({ run, cwd, url, branch, head })`: `ls-remote -- <url> refs/heads/<branch>`; non-zero: the
    classified failure as in `checkEmptyRemote`; no line -> `'absent'`; a line whose hash is `head` -> `'pushed'`;
    else `'other'`.
27. `repositoryEntry(url, branch, check)`: `{ url }` when `check.kind === 'reachable' && check.defaultBranch ===
    branch`, else `{ url, branch }`.
28. `originalsOf(groups, choices, { dropped })` -> `[{ kind, name, where, sourceLabel, personal, uri?, src?, file?,
    serverName?, replaced, copy, picked, reason }]`, one per copy of each imported group (left out or unticked: none):
    - Use of a single or identical group, and Use of a variant for the copies of the chosen version: `picked: true`.
    - Use of a variant, copies of the other versions: `picked: false`, `reason: 'another version was imported'`.
    - Merge: every copy `picked: false`, `reason: 'merged by hand: check that your merge covers it'`.
    - Split: every copy `picked: true`.
    - Then, whatever the above: a skill copy whose import skipped links -> `picked: false`, `reason: 'its links were
      not copied'`; a group in `dropped` -> `picked: false`, `reason: 'Cursor would drop the imported copy'`; an MCP
      copy with `replaced` variables -> `picked: false`, `reason: `holds your ${variables} value: set the environment
      variable first``. The first reason that applies is kept, in this order: dropped, links, replaced, then the choice.
    - Files and folders: `src` and `uri` (the extension fills `uri` from the source: `vscode.Uri.joinPath(source.uri,
      ...rel.split('/'))`; the pure function carries `source` and `rel`). MCP: `file` (its `mcp.json`), `serverName`,
      `replaced`. Ordered: personal first, then by source order, then group order.
29. `removeServers(text, names)` -> `{ text }` or `{ error }`: parse (`parseJsonc`; failure -> `{ error: 'not valid
    JSONC' }`); the table is decided once: `['mcpServers']` when `serverTable(obj)`, else `[]`; apply
    `jsonc.removeMember(text, path, name)` for each name; parse the result: the effective servers
    (`mcpServerNames`) must equal the old ones minus `names` (as sets), else `{ error: 'removing them would change
    other servers' }`.

### `lib/jsonc.js`: `removeMember(text, pathKeys, name)`

The text without every member `name` of the object at `pathKeys` (`[]` or `['mcpServers']`; duplicate keys: all
removed). For each member, the removed span is:

- from the key token's start to the value's end;
- then, when a comma follows the value: the comma, and after it the spaces and any comments up to the end of that line
  **only when** the next token starts on a later line (a comment on the same line as the next member belongs to the
  next member and stays);
- when no comma follows (the last member): the comma before the key (if any) instead, and the comments between that
  comma and the key stay;
- then, when the member started its own line, the whitespace from the end of the previous line to the key, so no blank
  line is left.

Not found: the text unchanged. Same "may assume valid JSONC" contract as `addMember`. Exported.

### Replace the originals (`replaceOriginals` in `extension.js`)

1. `originals = newRepo.originalsOf(groups, choices, { dropped })`, each with its `uri`. Quick pick, `canPickMany:
   true`, `ignoreFocusOut: true`, `placeHolder: 'Originals to replace with the plugin (a project file tracked by git is
   a change to commit there)'`: a separator item (`kind: vscode.QuickPickItemKind.Separator`, label the source label,
   `~/.cursor` for personal) before each source's entries; an entry: `{ label: where, description: `${KINDS[kind].label}
   ${name}` + (reason ? ` · ${reason}` : ''), picked, original }`. Cancelled or empty: stop (nothing touched, the
   plugin stays unticked).
2. **Wait for the plugin**: the descriptor `d` of the new repository (the configured repository whose `normalized` is
   `normalizeUrl(url)`), then `plugin = catalog.plugins.find((p) => p.repoKey === d.key && p.pluginName ===
   pluginName)` whose `children` hold every imported item (same `kind` and `name`; for MCP the server names); checked
   every 500 ms, at most 120 s. Not there: `ui.showInformationMessage(`Team plugins: the new repository is not cloned
   yet, so nothing was replaced: tick ${pluginName} in the Team Plugins view once it shows, and remove the originals
   yourself.`)`, stop. Then `enableNew(plugin.name)` and wait (every 500 ms, at most 30 s) until
   `registrar.current.has(plugin.name)`; not registered: `ui.showErrorMessage(`Team plugins: ${plugin.name} was not
   registered, so nothing was replaced: see the log.`)`, stop.
3. Remote window (`vscode.env.remoteName`): one modal confirmation as in `removeOriginals` (text
   `` `Delete the ${n} originals for good?` ``, detail `` `This remote window has no trash: files can't be recovered. The plugin keeps its copies.\n\n${list}` ``,
   button `Delete`); anything else: stop.
4. Before touching each original: skip it (reported in the final message) when `newRepo.stillSame(original.copy)` is
   false, when an open text document is dirty and its path is the original's file or inside its folder, or when the
   original's real path is no longer inside its source's real root (`inside`).
5. Files and folders: `vscode.workspace.fs.delete(original.uri, { recursive: true, useTrash: !remote })`, logged like
   `removeOriginals`; a failure: `ui.showErrorMessage(`Team plugins: could not ${how} ${src}${remote ? '' : ' to the
   trash'}: ${message}`)` as there.
6. MCP servers, per `mcp.json`: `fs.lstatSync(file).isSymbolicLink()` -> skipped (`'a link'`); read the text;
   `newRepo.removeServers(text, picked names)`; an error -> skipped with that reason. Backup:
   `dir = <storage>/replaced-originals/<Date.now()>-<process.pid>` (`mkdirSync`, recursive), `<n>-mcp.json` written
   with `{ flag: 'wx', mode: 0o600 }` holding the text, `<n>-mcp.json.source` holding the file's path (same options);
   log `` `backed up ${file} to ${backup}` ``. Re-read the file: not equal to `text` -> skipped (`'changed while
   replacing'`). Write the new text to `<file>.team-plugins-<pid>.tmp` (`wx`) next to it and `fs.renameSync` it over the
   file; a failure: remove the temporary file, an error message, the file untouched.
7. `ui.showInformationMessage(`Team plugins: replaced ${k} originals with the plugin ${plugin.name}.` + extras)` (`k`:
   successful removals only), extras: `` ` Left in place: ${list} (changed since the preview, unsaved edits, or moved).` ``;
   `` ` Set these environment variables, then restart Cursor: ${variables}.` `` when a removed server had replaced
   variables; `` ` The edited mcp.json files are backed up in ${dir}.` `` when one was edited.

### package.json

- Command: `{ "command": "teamPlugins.createTeamRepository", "title": "Create team repository...", "category": "Team
  Plugins" }`, after `teamPlugins.newPlugin`'s entry.
- `menus.view/title`: `{ "command": "teamPlugins.createTeamRepository", "when": "view == teamPlugins.plugins",
  "group": "1_author@0" }`.
- `viewsWelcome` contents: after the local-clone line, `No team repository yet? [Create one from your rules and
  skills](command:teamPlugins.createTeamRepository)` (its own line), before `New here? ...`.
- Walkthrough step, between `checkGit` and `addRepository`:
  `{ "id": "createRepository", "title": "No team repository yet?", "description": "Turn the rules, skills, commands,
  agents and MCP servers you already have in your projects into a team repository: a preview first, then you pick
  what goes in and push it to an empty Git repository.\n[Create team repository](command:teamPlugins.createTeamRepository)\nAlready
  have one? Go to the next step.", "media": { "markdown": "resources/walkthrough-create.md" }, "completionEvents":
  ["onSettingChanged:teamPlugins.repositories"] }`.
- `resources/walkthrough-create.md`: a short page in the style of `walkthrough-repository.md`: what is scanned, the
  preview, identical copies and variants, secrets replaced by environment variables, the empty repository to create
  first, Replace the originals. Links `https:` only.

## Impact

- `lib/contribute.js`: export `commitAll` and `IDENTITY_MESSAGE` (used by `commitAll` itself). No behaviour change;
  the existing identity test (`test/contribute.test.js:516`) keeps passing.
- `extension.js`: new command and `replaceOriginals`; no existing flow changes. `addRepositoryEntry` already triggers
  the sync and the clone through the settings change.
- `test/package.test.js`: the packaged-files list gains `extension/resources/walkthrough-create.md`; the walkthrough
  test checks every step's command links and media exist.
- `test/live/walkthrough.live.js`: opens the walkthrough at `checkGit`; must still pass.
- README Getting started and the walkthrough description in `docs/development.md` (three steps -> four).

## Not handled (say so in the README's Known limitations or the feature's section)

- `.cursor` folders below a project's root, `.cursorrules`, `.claude/` folders and `AGENTS.md`; other windows' projects
  (only the open workspace folders, `~/.cursor` and folders picked by hand); folders `projectItems` can't list
  (skipped silently, as in Share).
- Drafts as a source; more than one plugin per new repository; creating the remote repository itself; hooks and other
  files of a project's `.cursor` folder.
- References are a heuristic (links, `mdc:` links, `@` mentions, paths in MCP entries): reported, never rewritten.
- The staging folder holds copies of the scanned files while the command runs (deleted at the end, leftovers after
  24 hours); the `mcp.json` backups hold the whole files, other servers' values included.
- Git's own stderr in the log is redacted as everywhere else (URL credentials only).

## Tests

Create `test/newRepo.test.js` (`node:test`; temp folders from `test/helpers.js`; git runners from
`makeGit('git')`, with an `env` wrapper where a case needs one; bare repositories set up with `helpers.git`; no network).
Cases:

1. `secretName`: `GITHUB_TOKEN`, `apiKey`, `ApiKey`, `api-key`, `APIKEY`, `Authorization`, `DB_PASSWORD` -> true;
   `KEYBOARD`, `MONKEY`, `PATH`, `HOME`, `TOKENIZER_MODE` -> false.
2. `envVarName`: `'github-token'` -> `'GITHUB_TOKEN'`; `'9lives'` -> `'MCP_9LIVES'`; `'my server_Authorization'` ->
   `'MY_SERVER_AUTHORIZATION'`.
3. `redactServer('gh', { command: 'npx', env: { GITHUB_TOKEN: 'ghp_abc', LOG_LEVEL: 'debug', API_KEY: '${env:X}',
   DB_PASSWORD: 'p-${env:X}' } })` -> `GITHUB_TOKEN: '${env:GITHUB_TOKEN}'`, `LOG_LEVEL` unchanged, `API_KEY`
   unchanged, `DB_PASSWORD: '${env:DB_PASSWORD}'`; `replaced` has the two; no suspects; the input unchanged.
4. Headers: `redactServer('docs', { url: 'https://x/mcp', headers: { Authorization: 'Bearer abc123', 'X-Trace': '1' } })`
   -> `Authorization: 'Bearer ${env:DOCS_TOKEN}'`; `'Bearer ${env:T}'` unchanged; for server `a`, `{ headers:
   { 'X-Api-Key': 'k' } }` -> `'${env:A_X_API_KEY}'`; two headers `Authorization: 'Bearer x'` and `Proxy-Authorization:
   'Bearer y'` -> variables `A_TOKEN` and `A_TOKEN_2`.
5. Suspects: url `https://u:p@h/x` and `https://tok@h/x` -> `'the URL holds credentials'`; url
   `https://h/x?to%6Ben=abc&q=1` -> `'the URL parameter token holds a value'`; args `['--api-key=abc']` -> `'args[0]
   sets api-key'`; args `['--token', 'abc']` -> `'args[1] follows --token'`; args `['--token', '${env:T}']` -> none;
   args `['run', 'ghp_' + 'a'.repeat(36)]` and `['x_ghp_' + 'a'.repeat(36)]` -> `'args[1] looks like an access token'`
   / `'args[0] ...'`; no suspect string contains `abc`, `tok` or the token.
6. `textSuspects('a\nkey: AKIAABCDEFGHIJKLMNOP\n')` -> `[2]`.
7. `contentKey`: two rules equal but for CRLF and a BOM -> equal; two skills equal but for an extra `notes.md` ->
   different; two skills whose `logo.png` differ in invalid-UTF-8 bytes (`0xff 0x01` vs `0xfe 0x01`) -> different; a
   skill holding a link (`t.skip` when `fs.symlinkSync` throws EPERM) -> the key of the same skill without it.
8. `importName`: `'style'` -> `'style'`; `'My_Rule'` -> `'my-rule'`; `'___'` -> `''`; `'con'` -> `'con-item'`.
9. `itemReferences`: project `p` with `src/x.ts`, rule `.cursor/rules/a.mdc` holding
   `See [x](mdc:src/x.ts) and [y](../../src/x.ts#L3), [web](https://e.com), [top](#a), @src/x.ts, mail a@b.com,
   [gone](mdc:src/none.ts)` -> three references (`link` `mdc:src/x.ts`, `link` `../../src/x.ts#L3`, `mention`
   `src/x.ts`), each `resolved` = `p/src/x.ts`; a skill whose `SKILL.md` links `[r](reference.md)` with
   `reference.md` in the skill -> none.
10. `serverReferences`: `{ command: 'node', args: ['${workspaceFolder}/tools/s.js'] }` -> `[{ where: 'args[0]', why:
    'workspaceFolder' }]`; `['./server.js']` -> `relative`; `['tools/s.js']` with `p/tools/s.js` -> `relative`, without
    -> none; `['https://x/y']` -> none; an existing absolute path -> `absolute`; `['ghp_' + 'a'.repeat(36)]` -> none.
11. `scanSource`: project with skill `s1`, rules `a.md`, `sub/b.mdc`, command `run.md`, agent `helper.md`, and
    `.cursor/mcp.json` with a `// comment`, a trailing comma and servers `lint`, `gh` (env token) -> 5 items, 2 servers,
    `gh`'s `entry.env.GITHUB_TOKEN === '${env:GITHUB_TOKEN}'` and no field holding the token; the same folder as
    `personal` -> no rule items; `mcp.json` `[1]` -> error `'not a JSON object'`; `{ "mcpServers": { "x": 1, "ok":
    { "command": "a" } } }` -> error `the server x is not an object`, server `ok`; `{ "x": 1 }` -> no server, no error;
    `{ "mcpServers": { "../e": { "command": "a" } } }` -> error `the server name ../e can't be used in a plugin`; invalid
    text `{ "a": ghp_...` -> error `'not valid JSONC'` exactly.
12. `scan` with sources `api` and `web`: skill `code-review` equal in both (CRLF in one) -> `identical`, 2 copies, 1
    version; rule `db` different -> `variants`, versions in source order; rule `style` only in `api` -> `single`; MCP
    `lint` equal -> `identical`; two `gh` entries differing only in the literal `GITHUB_TOKEN` -> `identical`; group
    order skills, rules, commands, agents, MCP; `Style.mdc` in `web` and `style.md` in `api` -> one group `rule:style`
    with `renamed` holding the `Style` copy.
13. `previewMarkdown` for case 12 (plus one reference and one error): the exact expected text, written out in the test;
    the token value appears nowhere in it.
14. `splitNames`: versions from `api/.cursor/rules/backend/db.mdc` and `web/.cursor/rules/db.mdc` ->
    `['db-api-backend', 'db-web']`; with `taken` holding `db-web` -> `['db-api-backend', 'db-web-2']`; a 64-character
    name with sources `personal` and `web` -> two different names, each 64 characters at most and passing `nameError`;
    a group `con` from source `con` -> no name equal to a reserved one.
15. `buildRepository`: files `.cursor-plugin/marketplace.json`, `team/.cursor-plugin/plugin.json`,
    `team/agents/helper-web.md`, `team/mcp.json`, `team/rules/db-api.mdc`, `team/skills/code-review/SKILL.md`,
    `team/skills/code-review/notes.md` (sorted); marketplace `{ name: 'new-team', plugins: [{ name: 'team', source:
    './team' }] }`; the agent copied as `helper-web` has `name: helper-web` when the original said `name: helper`, an
    agent without `name` is left as is; `mcp.json` holds the redacted entries; a skill with a link reports it in
    `skipped`.
16. `readCatalog` on the built repository: plugin `team` with every item, no catalog problem.
17. `stillSame`: a rule unchanged -> true; edited -> false; deleted -> false; a skill with a new file -> false; an MCP
    server whose literal token changed (same redacted entry) -> false; removed from the file -> false.
18. `urlError`: `''`, `'-x'`, `'https://u:p@h/x.git'`, `'https://tok@h/x.git'`, `'https://h/x.git?token=a'`,
    `'relative/path'` -> their messages; `'https://h/o/x.git'`, `'git@h:o/x.git'`, `'ssh://git@h/o/x.git'`, an absolute
    path (`path.resolve('x')`) -> `''`. `destination` of an absolute path with a trailing separator -> `path.resolve`d.
19. `checkEmptyRemote`: a fresh bare repository -> `{ kind: 'empty' }`; one with a commit -> `reason: 'notEmpty'`; a
    missing path -> not `'empty'`, message naming the path.
20. `initAndCommit` + `pushNew` into a bare repository created with `git init --bare -b trunk`, identity from the env
    wrapper: `{ head }` returned; the bare repository has `refs/heads/main` (branch `'main'`) at `head`; `checkRemote`
    gives `defaultBranch: ''` -> `repositoryEntry` -> `{ url, branch: 'main' }`; with a bare repository `-b main` ->
    `{ url }`. A built repository holding a skill whose `.gitignore` ignores `notes.md` -> `initAndCommit` returns the
    `git left out ...notes.md...` error.
21. `remoteBranchState`: after the push -> `'pushed'` with `head`; another hash -> `'other'`; a fresh bare ->
    `'absent'`.
22. `gitReady` with `HOME`, `XDG_CONFIG_HOME` on an empty folder, `GIT_CONFIG_NOSYSTEM=1` and no identity variables ->
    `ok: false`, `IDENTITY_MESSAGE`; with the identity variables -> `ok: true`.
23. `defaultBranch`: a `run` stub answering `trunk` (and exit 0 for check-ref-format) -> `'trunk'`; config exit 1 ->
    `'main'`; check-ref-format exit 1 -> `'main'`.
24. `originalsOf`: `code-review` identical (2 copies, use) -> both picked; `db` variants, Use version A -> A's copy
    picked, B's not picked with `'another version was imported'`; `db` merged -> both unpicked; `api` split -> all
    picked; `style` out -> absent; MCP `gh` with `GITHUB_TOKEN` replaced -> unpicked with its reason; a group in
    `dropped` -> unpicked `'Cursor would drop the imported copy'`; personal copies first.
25. `removeServers`: nested table with `a`, `b`, remove `b` -> `{ text }` keeping `a`; top-level servers (no
    `mcpServers`) remove one -> `{ text }`; `{ "mcpServers": { "a": {...} }, "b": { "command": "x" } }` remove `a` ->
    `{ error: 'removing them would change other servers' }` (top-level `b` would become active); invalid text ->
    `{ error: 'not valid JSONC' }`.

In `test/jsonc.test.js`, `removeMember`:

26. `{\n  "mcpServers": {\n    "a": { "command": "x" },\n    "b": { "command": "y" }\n  }\n}\n` remove `b` ->
    `{\n  "mcpServers": {\n    "a": { "command": "x" }\n  }\n}\n`; remove `a` -> only `b`, no leading comma.
27. Comments: `// keep` on the line above `a` stays when `b` is removed; `"b": {}, // old` (b not last, comment after
    its comma, next member on the next line) -> the comment goes with `b`; `{"a":1, /* documents b */ "b":2}` remove
    `a` -> `{/* documents b */ "b":2}` (spacing as the rule gives; assert the comment and `"b":2` remain and it
    parses); a trailing comma after the last member stays valid JSONC.
28. CRLF kept; compact `{"a":1,"b":2}` remove `a` -> `{"b":2}`; remove the only member -> parses to an empty object;
    duplicate keys `{"a":1,"a":2,"b":3}` remove `a` -> `{"b":3}`; a missing name -> unchanged; path `[]`.

`test/contribute.test.js`: the identity case (line 516) asserts the message equals `IDENTITY_MESSAGE`.

`test/package.test.js`: packaged files include `extension/resources/walkthrough-create.md`.

Live scenario `test/live/create-repo.live.js` (`timeoutSec: 180`):

- setup: in `ctx.ws`: `.cursor/rules/style.mdc`, `.cursor/rules/db.mdc` (text A), `.cursor/skills/code-review/SKILL.md`,
  `.cursor/mcp.json` with servers `github` (`env.GITHUB_TOKEN` = `'ghp_' + 'x'.repeat(36)`) and `lint`
  (`command: 'node'`); a second project `ctx.repos/other` with `.cursor/rules/db.mdc` (text B),
  `.cursor/skills/code-review/SKILL.md` (same text, CRLF), `.cursor/rules/api.mdc` holding `[t](mdc:src/x.ts)` and
  `src/x.ts`; an empty bare repository `ctx.repos/new-team.git` created with `git init --bare -b trunk`. Settings:
  `teamPlugins.repositories: []`.
- run: set `process.env.GIT_AUTHOR_NAME/EMAIL` and `GIT_COMMITTER_NAME/EMAIL` (restore them in a `finally`). Expected
  branch: the machine's `git config --get init.defaultBranch` when `git check-ref-format --branch` accepts it, else
  `main` (computed in the scenario with `child_process.execFileSync`). Expected entry: `{ url }` when the expected
  branch is `trunk`, else `{ url, branch }`.
  Responder answers: the sources pick -> the workspace folder's label and `Other folders...` (never `~/.cursor`); the
  open dialog -> `[vscode.Uri.file(other)]`; what to import -> every item (assert first that every item is `picked`
  and that `api`'s description ends with `1 reference may break`); the `db` decision: first `$(diff) Compare...`
  (then a tab whose label starts with `db:` exists in `vscode.window.tabGroups`), then `$(edit) Merge by hand...`,
  `Version to start from` -> the first version; the Done/Back message -> write `MERGED\n` into the path read from the
  message (`/\((.+)\), save it/`), then `Done`; URL -> the bare path; plugin name -> `shared`; the confirmation ->
  `Create and push`; the closing message -> before answering, assert a tab whose label contains
  `new-team-repository-preview.md` was open at the what-to-import pick (record it in that answer), then `Replace the
  originals`; the originals pick -> the entries whose `picked` is true.
- asserts: the command resolves; the bare repository's `refs/heads/<expected branch>` holds
  `.cursor-plugin/marketplace.json` (`name: 'new-team'`), `shared/rules/style.mdc`, `shared/rules/db.mdc` = `MERGED\n`,
  `shared/rules/api.mdc`, `shared/skills/code-review/SKILL.md` and `shared/mcp.json` containing `${env:GITHUB_TOKEN}`
  and no `ghp_` (read with `git show`); `teamPlugins.repositories` is `[expected entry]`; `new-team:shared` is
  registered and in `teamPlugins.enabled`; in `ctx.ws`: `style.mdc` and the skill are gone (Use of identical/single),
  `db.mdc` is still there (merged: unpicked), `lint` is gone from `.cursor/mcp.json` and `github` stays (replaced
  secret: unpicked), the file parses; the other project's files are untouched; `<storage>/new-repository` holds no
  folder; one `<n>-mcp.json` backup under `<storage>/replaced-originals`; the log holds no `ghp_`.
- a second run, cancelled at the what-to-import pick (answer `undefined`): `Team plugins: nothing was written.` is shown
  and `<storage>/new-repository` holds no folder.

## Keep in step

- `README.md`:
  - Getting started: the walkthrough's new step "No team repository yet?" naming **Create team repository** (four
    steps; keep the numbering consistent).
  - A new section `## Creating a team repository` after `## The team repository`: what is scanned (the open folders'
    root `.cursor`, `~/.cursor` without rules, folders picked by hand), the preview (identical copies imported once,
    variants, secrets, references, renamed items), the choices (use, compare, merge by hand, keep each under its own
    name, leave out), the URL rules (an empty repository created first; no user name or password in the URL; an
    absolute path for a local repository), the branch pushed (`init.defaultBranch`, else `main`), the repository added
    to `teamPlugins.repositories`, secrets replaced by `${env:NAME}` (Cursor reads the variable from the environment it was started with: set it, then restart Cursor; unset, the server gets an empty value) and other
    suspected secrets unticked, `Create and push anyway` when Cursor would drop an item, and **Replace the
    originals** (only originals the repository fully represents start ticked, with the reasons for the others; it
    waits for the clone and the plugin's registration; trash, or in a remote window deleted for good after a
    confirmation; MCP servers removed from `mcp.json`, the file backed up in the extension's storage; originals
    changed since the preview or with unsaved edits are left in place; a project file tracked by git is a change to
    commit in that project).
  - Known limitations: the Not handled list, in user words.
- `docs/development.md`:
  - Walkthrough: four steps, the new `createRepository` step and its completion event; the media pages list gains
    `walkthrough-create.md`.
  - A new `### Create team repository` under How it works: the staging folder and `.alive`, the fingerprints checked
    before the build and before each removal, the measured facts 1-3 and 5, the secret rules and fact 4 with its live probe,
    the reference heuristic, scratch names by index, the `mcp.json` edit (table decided once,
    re-parse check, backup `wx`/0600, temporary file and rename), the ls-tree check before the push, the push retry
    reconciliation, why no webview (decision of request 26).
- `AGENTS.md`: Layout: `newRepo` in the `lib/` list (`scan`, `previewMarkdown`, `redactServer`, `stillSame`,
  `buildRepository`, `checkEmptyRemote`, `initAndCommit`, `pushNew`, `remoteBranchState`, `repositoryEntry`,
  `originalsOf`, `removeServers`, `urlError`: creating a team repository from existing items); `jsonc` gains
  `removeMember`; `contribute` gains `commitAll`, `IDENTITY_MESSAGE`. "Why the code is shaped this way": an empty
  remote has no default branch before the first push and a dangling HEAD afterwards when the server's HEAD names
  another branch, so the new entry names its branch unless `checkRemote` reports the pushed branch as the default;
  Replace the originals removes nothing before the new plugin is cloned and registered, and only what the repository
  represents starts ticked.
- `package.json`: command, menu, welcome line, walkthrough step (Design). No version change.
- `resources/walkthrough-create.md` (new).

## Commands

```
node --check extension.js
node scripts/test.js
node --test test/newRepo.test.js test/jsonc.test.js test/contribute.test.js
biome lint --error-on-warnings extension.js lib scripts test
node scripts/live-test.js create-repo walkthrough
node scripts/package.js
```

## Hand checks

Setup (done by the helper before the user starts): the build installed in the user's Cursor (with the user's OK),
`python scripts/live_check.py settings backup <scratchpad>/settings-backup`; two project folders
`<scratchpad>/proj-api` and `<scratchpad>/proj-web`, each with a `.cursor` folder: rule `db.mdc` different in each,
skill `code-review` identical in both (CRLF in one), rule `style.mdc` only in `proj-api` linking
`[template](mdc:src/template.ts)` with `src/template.ts` present, `proj-web/.cursor/mcp.json` with server `github`
whose `env.GITHUB_TOKEN` is `ghp_` followed by 36 `x`; both folders are git repositories with their files committed
(`git -c user.name=t -c user.email=t@x commit`); a workspace file `<scratchpad>/two.code-workspace` opening both; two
empty bare repositories `<scratchpad>/new-team.git` and `<scratchpad>/new-team-2.git` (`git init --bare -b main`).
When `git config --global user.name` or `user.email` is empty, the helper stops and reports it (the command would stop
at its first step); the user decides whether to set one; the helper never sets it.

**Test 1. Preview and compare**
1. Open `<scratchpad>/two.code-workspace` (`File > Open Workspace from File...`).
2. Run `Team Plugins: Create team repository...` from the command palette (`Ctrl+Shift+P`).
3. Untick `~/.cursor`, keep `proj-api` and `proj-web`, press `Enter`.
4. Look at the preview that opens.
5. In the list of what goes in, press `Enter` without changing anything.
6. In the `db` pick, choose `$(diff) Compare...`.

Expected:
- 👁 The preview shows `code-review` as identical in 2 places, `db` with 2 versions, `github` under Secrets replaced
  (`env.GITHUB_TOKEN now reads the environment variable GITHUB_TOKEN`), and `style` under References that may break.
- 👁 The preview never shows the token's value.
- 👁 A diff editor opens with the two `db.mdc` versions side by side, then the `db` pick shows again.

**Test 2. Merge by hand, push and follow**
1. In the `db` pick, choose `$(edit) Merge by hand...`, then the `proj-api` version.
2. In the right side of the diff, add a line `merged by hand`, press `Ctrl+S`.
3. Press `Done` in the notification.
4. Enter the URL `<scratchpad>/new-team.git` (`Enter`), keep the plugin name `new-team` (`Enter`).
5. Read the confirmation, press `Create and push`.
6. In the closing message, press `Keep them`.

Expected:
- 👁 The confirmation names the plugin, its item counts, one secret value replaced and one reference that may break.
- 👁 The diff and preview tabs of the run are closed.
- 📋 `new-team.git` has a `main` branch with `new-team/rules/db.mdc` holding `merged by hand` and `new-team/mcp.json`
  holding `${env:GITHUB_TOKEN}` and no `ghp_`.
- 📋 `teamPlugins.repositories` holds `{ "url": "<scratchpad>/new-team.git" }` (HEAD is `main`).
- 👁 The Team Plugins view shows the repository `new-team` with the plugin `new-team`, unticked.

**Test 3. Replace the originals**
1. Run `Team Plugins: Create team repository...` again (`Ctrl+Shift+P`).
2. Untick `~/.cursor`, `Enter`; `Enter` for the items; `$(check) Use proj-api/.cursor/rules/db.mdc` for `db`; the URL
   `<scratchpad>/new-team-2.git`; plugin name `team-two`; `Create and push`.
3. In the closing message press `Replace the originals`.
4. Look at the list, then press `Enter` without changing anything.

Expected:
- 👁 The list groups the originals under `proj-api` and `proj-web`; `proj-web/.cursor/rules/db.mdc` is unticked with
  "another version was imported", and `github` is unticked with "holds your GITHUB_TOKEN value: set the environment
  variable first".
- 📋 After a few seconds, `teamPlugins.enabled` holds `new-team-2:team-two` and the log shows it registered before any
  original was moved to the trash.
- 📋 The ticked files are gone from the folders (in the recycle bin); `proj-web/.cursor/rules/db.mdc` and
  `proj-web/.cursor/mcp.json`'s `github` are still there.
- 👁 `git status` in `proj-api` (a terminal) lists the removed files as deleted.

Cleanup: `python scripts/live_check.py settings diff`, then `settings restore`, then `settings diff` (no difference);
remove the scratchpad folders and bare repositories; the test files in the recycle bin may stay.

## Don't

- No commit. No change outside the files listed here without reporting it; `requests/26-*.md` and this plan are not
  yours to edit.
- Don't run `cursor --install-extension` or launch the user's Cursor; `node scripts/live-test.js` is allowed.
- No new dependency, TypeScript, bundler or webview.
- No secret value (a replaced value, a suspect, a parser message quoting the input) in the log, a message or the
  preview. The staging folder may hold copies of source content and is deleted at the end; the backups hold the
  edited `mcp.json` files whole.
- No name from the scanned files in a scratch path (index only).
- `fs.rmSync` on a tree that may hold git files: use `sync.removeTree`.
- `extension.js` dialog calls go through `ui`, never `vscode.window.show*` directly (a multiline search for
  `vscode\.window\s*\.\s*show` must find no new call).
- Fix every Biome warning before you stop (the `Stop` hook runs the lint).

## Changes after review

- 2026-11-28, Codex review of the first draft (17 findings): Replace preselects only represented originals and waits
  for the clone and registration; fingerprints checked before the build and before each removal; atomic `mcp.json`
  edit with a `wx` backup; scratch paths by index and server names checked; no parser message or token in the
  preview; URL rules; redaction refinements; `removeMember` comment ownership and the re-parse check; bounded
  `splitNames` with reserved Windows names; byte hashing and the ls-tree check; branch validated by git; empty check
  repeated after the confirmation; push retry reconciliation; "pushed but not added" path; source URIs and `.alive`;
  `Create and push anyway`; hand checks without `~/.cursor`.
- 2026-11-28, implementation review (mine): every picked group's name is reserved before any decision (a split could
  take a name a later group then used). Implementer deviations kept: the live scenario's other-project assertion (then
  replaced below), the preview tab polled for up to 5 s, skill links recorded at scan time (`skillLinks`), MCP split
  names checked with `serverNameError`.
- 2026-11-28, Codex review of the implementation (findings 1-13): `stillSame` also right before and right after the
  build; each original checked again right before it is touched, and the `mcp.json` edit removes only servers whose
  fingerprint matches in the same read (`serverKeyIn`), counting only those; every text file of a skill scanned for
  token shapes and a skill's `.env` file a suspect (`itemSuspects`, also on a merge); `redactServer` returns `hidden`
  fields, never shown as references; a reference default (`${X:-value}`) counts as a literal; a split MCP server's
  replaced variables renamed after it (`splitVariable`, `planImport`'s `variables`, Replace's reasons); the edited
  `mcp.json` keeps its mode and only a temporary file this run created is removed; skill merge placeholders inside the
  merge folder for files only another version has, dropped at Done when still empty; Replace order: confirmation and an
  eligibility check before ticking, then the clone checked for the pushed commit with the plugin folder unchanged
  (`merge-base --is-ancestor`, `diff --quiet`); any URL with a password refused; the live scenario keeps the other
  project byte for byte; README and walkthrough page say header interpolation is not checked. Not done: a
  registration-failure test and a merge edited through the real diff editor (the Test mode `ui` can't drive them).
- 2026-11-28, hand checks: the quick picks covered the preview and the Compare diff (`ignoreFocusOut`): the import list
  now waits for a **Continue** notification, and the variant pick comes back after Compare only on **Back to the
  choices** (Test 1b, confirmed). Test 2's merge line never reached the pushed `db.mdc` (managed clone: one commit with
  the proj-api text); the user typed in a right side, not sure which tab, and a Compare tab whose sides were the real
  originals was still open. The compare and merge diffs now show the originals as read-only `team-plugins-readonly:`
  documents, the merge tab is titled "your merge (edit this side)", Done on an unchanged merge warns, and the scenario
  now edits the merge through the editor buffer and saves it (the merged text reaches the repository), checks the
  diff sides' schemes and the warning, and the scratch-tab cleanup closes the read-only tabs. Hand re-check Test 2b
  (2026-11-28): passed; read-only Compare and merge left side, the unchanged-merge warning, and `merged by hand` in the
  pushed `db.mdc` with both projects' files unchanged.

## Unlikely corner cases (noted, not acted on)

From the Codex review of the implementation (2026-11-28); left as they are for now:

- Staging cleanup: a run would have to stay open while its extension host is suspended for more than 24 hours, and
  another window would have to start a creation meanwhile and purge its staging folder.
- `splitNames` fallback: one variant would have to exhaust all 998 numbered candidates before the timestamp fallback
  skips the normal collision check.
- Commit check: a local git filter or hook would have to change approved file bytes while keeping every path, for the
  name-only `ls-tree` check to miss it.
