'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCatalog, inside } = require('./lib/catalog');
const checks = require('./lib/checks');
const authoring = require('./lib/authoring');
const share = require('./lib/share');
const newRepo = require('./lib/newRepo');
const rename = require('./lib/rename');
const selection = require('./lib/selection');
const contextCost = require('./lib/context'); // not `context`: activate and others take a parameter of that name
const {
  buildTree,
  buildChangesNode,
  buildConflictsNode,
  repoStatus,
  buildRepoNode,
  buildMissingNodes,
  itemDecoration,
  KIND_LABELS,
} = require('./lib/treeModel');
const {
  holderName,
  copyRootOf,
  syncCopy,
  markCopySynced,
  resolveConflict,
  conflictVersions,
  gcFiltered,
} = require('./lib/materialize');
const { makeGit } = require('./lib/git');
const { redactUrls, redactingUi } = require('./lib/remoteErrors');
const { checkGit, gitCheckMessage, DOWNLOAD_URL } = require('./lib/gitCheck');
const sync = require('./lib/sync');
const updates = require('./lib/updates');
const contribute = require('./lib/contribute');
const { pluginApi } = require('./lib/cursorApi');
const { Registrar } = require('./lib/registrar');
const {
  normalizeUrl,
  baseName,
  repoName,
  originUrl,
  parseRepositories,
  parseLocalRepositories,
  parseProjectRepositories,
  migratedSettings,
  listRepos,
  assignNames,
  mergeCatalogs,
  normalizeIds,
  rememberNames,
  repoOfId,
  missingRepos,
  unlocatedRepos,
  projectRepoEntry,
  withProjectRepo,
  withoutProjectRepo,
} = require('./lib/repos');

const SECTION = 'teamPlugins';
const VIEW_COMMAND = 'workbench.view.extension.teamPlugins';
const WALKTHROUGH_ID = 'gettingStarted';
const BUSY_TEXT = 'Another Cursor window is syncing the team plugins: try again in a moment.';
const COPY_RETRY_MS = 2000;
const COPY_RETRY_MAX = 30;
const LOCKED_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const OFFLINE_RETRY_MS = 5 * 60 * 1000;
const OLD_EXTENSION_ID = 'mg.cursor-team-plugins'; // the publisher was `mg` up to 0.4.0

// Every dialog goes through `ui`: in Test mode (scripts/live-test.js) it is replaced by a recorder that never
// blocks; otherwise it is vscode.window's own.
const realUi = {
  showInformationMessage: (...a) => vscode.window.showInformationMessage(...a),
  showWarningMessage: (...a) => vscode.window.showWarningMessage(...a),
  showErrorMessage: (...a) => vscode.window.showErrorMessage(...a),
  showQuickPick: (...a) => vscode.window.showQuickPick(...a),
  showInputBox: (...a) => vscode.window.showInputBox(...a),
  showOpenDialog: (...a) => vscode.window.showOpenDialog(...a),
  showWorkspaceFolderPick: (...a) => vscode.window.showWorkspaceFolderPick(...a),
  // The URL is passed as a string so that Cursor opens it exactly: a Uri is re-encoded with
  // encodeURI(uri.toString(true)), which breaks an encoded &, + or # of a branch name.
  openExternal: (url) => vscode.env.openExternal(url),
};
// redactingUi: a notification never shows the credentials of a URL
let ui = redactingUi(realUi);
let testMode = false; // the extension runs under --extensionTestsPath (scripts/live-test.js)
const testLog = []; // Test mode: the lines of the log, without their timestamp
const testCalls = []; // Test mode: the dialogs shown, as recorded by the test `ui`
let testResponder = () => undefined;
let testChangedPaths = null;

let output;
let statusItem;
let treeProvider;
let treeView;
let registrar = null;
let api = null;
let catalog = { plugins: [], warnings: [] }; // the merged catalog of the repositories that are loaded
let descs = []; // assignNames(listRepos(...)) of the last apply: every configured repository
let catalogs = new Map(); // repo key -> readCatalog result (kept for repositories that are syncing)
// repo key -> { lastResult, lastCheck, syncing, changes, errorShown, updates, updateNotice, updatesBaseline }. lastResult
// is the last sync (this window's or, from the state file, another window's); changes: { files, ahead } of a managed
// clone, null for a local one; updates: the update summary (refreshUpdates), null when there is none; updateNotice:
// what a sync just fetched, waiting for the marks to be named; updatesBaseline: record everything as seen at the next
// refreshUpdates (a new clone, a branch switch).
const repoStates = new Map();
let missing = []; // repositories this project uses and the user doesn't follow (with where they are)
let unlocated = []; // names of repositories this project uses and its settings don't locate
const missingNotified = new Set(); // normalized urls already announced in this window
let knownSources = null; // Set of `${key}|${branch}` of the managed repositories, null until activation finished
let lastApplyErrors = 0;
let timer = null;
let offlineTimer = null;
let watchers = [];
let draftsWatched = false; // whether the last startWatchers call watched the drafts folder
let debounceTimer = null;
let queue = Promise.resolve();
let storage = '';
let lastGitCheck = null; // the result of the last Check git (Test mode reads it)
let partialCopies = new Map(); // plugin name -> { plugin, ids, holder, copyRoot, conflicts: [{ rel, source, copy }] }
let copyConflicts = []; // the conflicts of all partial copies, as given to buildConflictsNode
let diagnostics = null; // the DiagnosticCollection of the problems of lib/checks.js
let diagnosticsKey = ''; // what it holds, to replace it only when that changes
let copyWatcher = null;
let copyDebounce = null;
let copyRetryTimer = null;
let copyRetries = 0;
let checkboxChain = Promise.resolve();
const conflictShown = new Set();
const conflictsNotified = new Set(); // `${holder}|${rel}` of the partial-copy conflicts already announced
const loggedWarnings = new Set();

function log(message) {
  const text = redactUrls(message);
  if (output) {
    output.appendLine(`[${new Date().toISOString()}] ${text}`);
  }
  if (testMode) {
    testLog.push(text);
    if (testLog.length > 5000) {
      testLog.shift();
    }
  }
}

function stateOf(key) {
  let s = repoStates.get(key);
  if (!s) {
    s = {
      lastResult: null,
      lastCheck: null,
      syncing: false,
      changes: null,
      errorShown: false,
      updates: null,
      updateNotice: null,
      updatesBaseline: false,
    };
    repoStates.set(key, s);
  }
  return s;
}

// ---- paths and settings ------------------------------------------------------------------------------------------

function paths() {
  const pluginsRoot = path.join(storage, '.cursor', 'plugins');
  return { pluginsRoot, filteredRoot: path.join(pluginsRoot, 'filtered'), draftsRoot: path.join(pluginsRoot, 'drafts') };
}

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

function intervalMinutes() {
  return Number(cfg().get('updateIntervalMinutes')) || 0;
}

function gitPath() {
  const value = vscode.workspace.getConfiguration('git').get('path');
  if (typeof value === 'string' && value) {
    return value;
  }
  if (Array.isArray(value)) {
    const first = value.find((v) => typeof v === 'string' && v);
    if (first) {
      return first;
    }
  }
  return 'git';
}

// Every configured repository, before it has a name (the drafts folder when it exists, then locals, then managed).
function rawRepos() {
  const { pluginsRoot, draftsRoot } = paths();
  let config = '';
  try {
    config = fs.readFileSync(path.join(pluginsRoot, 'repo', '.git', 'config'), 'utf8');
  } catch {
    // no clone of 0.4
  }
  return listRepos({
    repositories: parseRepositories(cfg().get('repositories')),
    localRepositories: parseLocalRepositories(cfg().get('localRepositories')),
    drafts: isDirectory(draftsRoot) ? draftsRoot : '',
    pluginsRoot,
    storage,
    legacyOrigin: originUrl(config),
  });
}

function catalogNames(list) {
  const names = new Map();
  for (const d of list) {
    const c = catalogs.get(d.key);
    if (c) {
      names.set(d.key, c.name);
    }
  }
  return names;
}

// Every configured repository with its name (known from the last catalogs).
function listConfigured() {
  const list = rawRepos();
  return assignNames(list, catalogNames(list));
}

// A repository whose plugins are loaded (not listed twice, not replaced by another of the same name).
function isActive(d) {
  return !d.duplicateOf && !d.hiddenBy;
}

function isManaged(d) {
  return d.kind === 'managed' && !d.duplicateOf;
}

// The drafts folder with no plugin and no conflict in it: the view and the status tooltip leave it out.
function isEmptyDrafts(d) {
  return (
    d.kind === 'drafts' &&
    !catalog.plugins.some((p) => p.repoKey === d.key) &&
    !copyConflicts.some((c) => c.repo === d.key)
  );
}

// What the view and the messages call a repository (a repository listed twice has no name of its own).
function labelOf(d) {
  return d.name || baseName(d.source);
}

// VS Code's fsPath has a lower-case drive letter; Windows paths compare without case.
function samePath(a, b) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(a) === norm(b);
}

function managedSources() {
  return new Set(listConfigured().filter(isManaged).map((d) => `${d.key}|${d.branch}`));
}

function lockOf(repoKey) {
  const d = descs.find((x) => x.key === repoKey);
  return d ? d.lockFile : null;
}

function userSelection() {
  const c = cfg();
  return {
    enabled: normalizeIds(catalog, stringList(c.get('enabled'))),
    excluded: normalizeIds(catalog, stringList(c.get('excluded'))),
  };
}

// The ids the workspace and folder settings list (0.4 ids read as <repository>:<id>; never written back by themselves).
function projectList() {
  const all = [];
  const top = cfg().inspect('projectPlugins');
  all.push(...stringList(top && top.workspaceValue));
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const inspected = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect('projectPlugins');
    all.push(...stringList(inspected && inspected.workspaceFolderValue));
  }
  return normalizeIds(catalog, all);
}

// The repositories the project says it uses (workspace value and every folder's value of projectRepositories).
function projectRepositories() {
  const all = [];
  const top = cfg().inspect('projectRepositories');
  all.push(...parseProjectRepositories(top && top.workspaceValue));
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const inspected = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect('projectRepositories');
    all.push(...parseProjectRepositories(inspected && inspected.workspaceFolderValue));
  }
  return all;
}

// 0.4 settings: teamPlugins.repoUrl + branch and localRepoPath move to repositories and localRepositories (user level).
async function migrateSettings() {
  const c = cfg();
  const globalValue = (key) => {
    const inspected = c.inspect(key);
    return inspected ? inspected.globalValue : undefined;
  };
  const moved = migratedSettings({
    repoUrl: globalValue('repoUrl'),
    branch: globalValue('branch'),
    localRepoPath: globalValue('localRepoPath'),
    repositories: globalValue('repositories'),
    localRepositories: globalValue('localRepositories'),
  });
  const target = vscode.ConfigurationTarget.Global;
  if (moved.repositories) {
    try {
      await c.update('repositories', moved.repositories, target);
      await c.update('repoUrl', undefined, target);
      await c.update('branch', undefined, target);
      log('moved teamPlugins.repoUrl to teamPlugins.repositories');
    } catch (err) {
      log(`cannot move teamPlugins.repoUrl to teamPlugins.repositories: ${err.message}`);
    }
  }
  if (moved.localRepositories) {
    try {
      await c.update('localRepositories', moved.localRepositories, target);
      await c.update('localRepoPath', undefined, target);
      log('moved teamPlugins.localRepoPath to teamPlugins.localRepositories');
    } catch (err) {
      log(`cannot move teamPlugins.localRepoPath to teamPlugins.localRepositories: ${err.message}`);
    }
  }
}

// ---- serialised refresh / apply ----------------------------------------------------------------------------------

function enqueue(fn) {
  const operation = queue.then(() => fn());
  queue = operation.catch((err) => log(`error: ${err && err.stack ? err.stack : err}`));
  return operation;
}

function apply() {
  return enqueue(doApply);
}

// keys: the repositories to sync (null: all); check: the keys whose URL or branch is new (say at once whether the
// server answers).
function refresh({ sync: doSync, userInitiated = false, check = null, keys = null } = {}) {
  return enqueue(() => doRefresh(doSync, userInitiated, check, keys));
}

async function doRefresh(doSync, userInitiated, check, keys) {
  const list = listConfigured();
  if (list.every((d) => d.kind === 'drafts')) {
    // the drafts folder alone is no repository: the view still offers to add one
    await vscode.commands.executeCommand('setContext', 'teamPlugins.state', 'unconfigured');
    scheduleOfflineRetry();
    await doApply();
    return;
  }
  await vscode.commands.executeCommand('setContext', 'teamPlugins.state', 'ready');
  if (!doSync) {
    await doApply();
    return;
  }
  const run = makeGit(gitPath());
  const targets = list.filter((d) => !d.duplicateOf && (!keys || keys.has(d.key)));
  if (targets.length === 0) {
    await doApply();
    return;
  }
  // the repositories sync in parallel; each is applied as soon as its own sync ends (the applies never overlap)
  let chain = Promise.resolve();
  await Promise.all(
    targets.map(async (d) => {
      try {
        await syncRepo(d, run, { userInitiated, check: !!(check && check.has(d.key)) });
      } catch (err) {
        log(`error: sync of ${labelOf(d)}: ${err && err.stack ? err.stack : err}`);
      }
      chain = chain.then(() => doApply()).catch((err) => log(`error: ${err && err.stack ? err.stack : err}`));
      await chain;
    }),
  );
  scheduleOfflineRetry();
}

// Syncs one repository: a managed clone is cloned or updated, a local one is only looked at.
async function syncRepo(d, run, { userInitiated, check }) {
  const s = stateOf(d.key);
  if (d.kind === 'drafts') {
    s.lastCheck = new Date();
    return;
  }
  if (d.kind === 'local') {
    s.lastResult = await sync.localStatus({ run, repoDir: d.dir });
    s.lastCheck = new Date();
    return;
  }
  const hadClone = fs.existsSync(path.join(d.dir, '.git'));
  let checkFailed = false;
  s.syncing = true;
  updateStatus();
  treeProvider.refresh();
  try {
    if (check) {
      // a new URL or branch: say at once whether the server answers, before the (possibly long) clone or fetch
      const c = await sync.checkRemote({
        run,
        cwd: storage,
        repoUrl: d.url,
        branch: d.branch,
        idleMs: sync.CHECK_IDLE_MS,
      });
      if (c.kind !== 'reachable') {
        s.lastResult = c;
        checkFailed = true;
      } else if (vscode.window.state.focused) {
        ui.showInformationMessage(
          `Team plugins: ${d.url} is reachable${c.empty ? ' (empty repository)' : ''}. ${
            hadClone ? 'Updating' : 'Cloning'
          } it in the background.`,
        );
      }
    }
    if (!checkFailed) {
      s.lastResult = await sync.syncManaged({
        run,
        managedRepo: d.dir,
        repoUrl: d.url,
        branch: d.branch,
        lockFile: d.lockFile,
        stateFile: d.stateFile,
        log,
      });
    }
  } finally {
    s.syncing = false;
  }
  s.lastCheck = new Date();
  if (checkFailed) {
    // only the window the user is looking at answers a settings change
    if (vscode.window.state.focused) {
      notifyAfterSync(s.lastResult, d, { hadClone, userInitiated: true });
    } else {
      log(`repository check failed for ${d.url}: ${s.lastResult.message}`);
    }
  } else {
    if (s.lastResult.kind === 'busy') {
      readStateFile(d); // another window is syncing: show what it recorded last; its next write re-applies here
    }
    if (s.lastResult.kind === 'cloned') {
      startWatchers(); // the clone watcher was created before the folder existed
    }
    if (s.lastResult.kind === 'cloned' || s.lastResult.kind === 'switched') {
      s.updatesBaseline = true; // another clone or branch: nothing there is new to the user
    }
    notifyAfterSync(s.lastResult, d, { hadClone, userInitiated });
    if (s.lastResult.kind === 'switched') {
      log(`managed clone of ${labelOf(d)} now follows ${d.url} (${s.lastResult.branch})`);
    }
  }
}

// The buttons of a classified remote error (lib/remoteErrors.js `actions`); d: the repository.
const ACTIONS = {
  terminal: { label: 'Open terminal', run: (d) => openGitTerminal(d.url) },
  retry: { label: 'Sync now', run: () => vscode.commands.executeCommand('teamPlugins.syncNow') },
  showLog: { label: 'Show log', run: () => output.show() },
  repositories: {
    label: 'Open settings',
    run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'teamPlugins.repositories'),
  },
  pushToBranch: {
    label: 'Push to a branch',
    run: (d) => vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: d.key }),
  },
  pullRequest: {
    label: 'Open a pull request',
    run: (d) => vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: d.key, openPullRequest: true }),
  },
  retryPush: {
    label: 'Try again',
    run: (d) => vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: d.key }),
  },
};

// Failures that depend on the machine git runs on: in a remote window they are the remote machine's.
const MACHINE_REASONS = ['credentials', 'authFailed', 'sshAuth', 'hostKeyUnknown', 'hostKeyChanged'];

// In a remote window (Remote-SSH, WSL, dev container) the extension runs on the remote machine, with its git, clone
// and credentials: '' in a local window.
function remoteMachine() {
  return vscode.env.remoteName ? os.hostname() : '';
}

function showRemoteError(result, d) {
  const ids = (result.actions || []).filter((id) => ACTIONS[id]);
  if (!ids.includes('showLog')) {
    ids.push('showLog');
  }
  const machine = remoteMachine();
  const suffix =
    machine && MACHINE_REASONS.includes(result.reason)
      ? ` This window is connected to ${machine}: git runs there, with that machine's credentials and SSH keys.`
      : '';
  ui
    .showErrorMessage(`Team plugins (${labelOf(d)}): ${result.message}${suffix}`, ...ids.map((id) => ACTIONS[id].label))
    .then((choice) => {
      const id = ids.find((i) => ACTIONS[i].label === choice);
      if (id) {
        return ACTIONS[id].run(d);
      }
      return undefined;
    });
}

// A terminal where git can ask what it can't ask in the background (SSH host key or passphrase, credential manager
// sign-in). No shell: git is the terminal's process, so the URL needs no quoting.
function openGitTerminal(url) {
  if (!url) {
    return;
  }
  const term = vscode.window.createTerminal({
    name: 'Team plugins: git',
    shellPath: gitPath(),
    shellArgs: ['ls-remote', '--', url, 'HEAD'],
  });
  term.show();
}

// Retries an unreachable server after OFFLINE_RETRY_MS, whatever the update interval is.
function scheduleOfflineRetry() {
  if (offlineTimer) {
    clearTimeout(offlineTimer);
    offlineTimer = null;
  }
  const minutes = intervalMinutes();
  const offline = listConfigured().some((d) => {
    const r = isManaged(d) ? stateOf(d.key).lastResult : null;
    return !!r && r.kind === 'offline';
  });
  if (minutes > 0 && offline) {
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      timedSync(Math.max(5, minutes) * 60000);
    }, OFFLINE_RETRY_MS);
  }
}

function notifyAfterSync(result, d, { hadClone, userInitiated }) {
  const s = stateOf(d.key);
  if (!['error', 'busy', 'offline'].includes(result.kind)) {
    s.errorShown = false; // a recovery re-arms the error notice
  }
  const name = labelOf(d);
  const ask = (kind, message, ...buttons) => ui[kind](message, ...buttons);
  switch (result.kind) {
    case 'cloned':
      if (!hadClone) {
        // the catalog of this clone is not read yet: its marketplace name is what the view will show
        const clonedName = repoName(readCatalog(d.dir).name) || name;
        ask(
          'showInformationMessage',
          `Team plugins: ${clonedName} cloned. Pick your plugins in the Team Plugins view.`,
          'Open view',
        ).then((choice) => {
          if (choice === 'Open view') {
            vscode.commands.executeCommand(VIEW_COMMAND);
          }
        });
      }
      break;
    case 'updated':
      // refreshUpdates says who changed what, in the apply that follows: it needs the marks
      s.updateNotice = { from: result.from, to: result.to, commits: result.commits, kept: result.kept };
      break;
    case 'conflict': {
      const key = `${d.key}|conflict:${result.head}|${result.upstream || ''}|${result.files.join(',')}`;
      if (conflictShown.has(key)) {
        break;
      }
      conflictShown.add(key);
      const shown = result.files.slice(0, 3).join(', ');
      const more = result.files.length > 3 ? ` and ${result.files.length - 3} more` : '';
      ask(
        'showWarningMessage',
        `Team plugins: ${result.behind} new commit(s) of ${name} conflict with your changes in ${shown}${more}, so its updates are paused. Push your changes to a branch to merge them in your own clone, or discard them.`,
        'Push to a branch',
        'Show changes',
        'Discard local changes',
      ).then((choice) => {
        if (choice === 'Push to a branch') {
          vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: d.key });
        } else if (choice === 'Show changes') {
          vscode.commands.executeCommand(VIEW_COMMAND);
        } else if (choice === 'Discard local changes') {
          vscode.commands.executeCommand('teamPlugins.discardLocalChanges', { repo: d.key });
        }
      });
      break;
    }
    case 'offline':
      // a server that doesn't answer is quiet when a clone exists: the plugins keep working and the next update retries
      if (userInitiated || (!hadClone && !s.errorShown)) {
        s.errorShown = true;
        showRemoteError(result, d);
      } else {
        log(`update of ${name} skipped: ${result.message}`);
      }
      break;
    case 'error':
      if (userInitiated || !s.errorShown) {
        s.errorShown = true;
        showRemoteError(result, d);
      }
      break;
    default:
      break;
  }
}

// Filtered copies are shared by windows with the same selection; every window touches the copies it registered at each
// apply and every hour, and copies nobody touched for a week are removed.
const FILTERED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const KEEP_ALIVE_MS = 60 * 60 * 1000;
let keepAliveTimer = null;

// The folders directly under filteredRoot that hold the registered filtered copies (<name>-<hash>/<plugin folder>).
function filteredHolders(filteredRoot, registeredPaths) {
  return registeredPaths.filter((p) => p.startsWith(filteredRoot)).map((p) => path.dirname(p));
}

function touchFiltered(holders) {
  const now = new Date();
  for (const p of holders) {
    try {
      fs.utimesSync(p, now, now);
    } catch {
      // removed meanwhile: the next apply makes it again
    }
  }
}

async function doApply() {
  // read the catalog of every repository, except one that is syncing here: its folder is changing under git, so the
  // last catalog read stays in use until its sync ends
  const list = rawRepos();
  const keys = new Set(list.map((d) => d.key));
  for (const d of list) {
    if (d.duplicateOf || (stateOf(d.key).syncing && catalogs.has(d.key))) {
      continue;
    }
    catalogs.set(d.key, readCatalog(d.dir));
  }
  for (const key of [...catalogs.keys()]) {
    if (!keys.has(key)) {
      catalogs.delete(key);
    }
  }
  descs = assignNames(list, catalogNames(list));
  const formerNames = rememberRepoNames();
  descs = descs.map((d) => (formerNames[d.key] && formerNames[d.key].length > 0 ? { ...d, formerNames: formerNames[d.key] } : d));
  const active = descs.filter(isActive);
  catalog = mergeCatalogs(active.map((d) => ({ desc: d, catalog: catalogs.get(d.key) })));
  for (const w of catalog.warnings) {
    if (!loggedWarnings.has(w)) {
      loggedWarnings.add(w);
      log(`catalog warning: ${w}`);
    }
  }
  await migrateIds();
  const user = userSelection();
  const project = projectList();
  const eff = selection.effective(catalog, user, project);
  const { filteredRoot } = paths();
  const copies = new Map();
  const previous = partialCopies;
  let retry = '';
  const desired = selection.desiredRegistrations(catalog, eff, (plugin, ids) => {
    const d = active.find((x) => x.key === plugin.repoKey);
    const holder = path.join(filteredRoot, holderName(plugin, ids));
    const copyRoot = copyRootOf(plugin, holder);
    const keep = () => {
      const old = [...previous.values()].find((e) => e.holder === holder);
      copies.set(plugin.name, { plugin, ids, holder, copyRoot, conflicts: old ? old.conflicts : [] });
      return copyRoot;
    };
    const syncOne = () => {
      const { actions, conflicts, skipped, notes } = syncCopy(plugin, ids, holder);
      logCopyActions(plugin, actions);
      logSkipped(plugin, skipped);
      logNotes(plugin, notes);
      copies.set(plugin.name, { plugin, ids, holder, copyRoot, conflicts });
      return copyRoot;
    };
    try {
      const locked = sync.withLockSync(d.lockFile, syncOne);
      if (locked.kind === 'done') {
        return locked.value;
      }
      if (fs.existsSync(copyRoot)) {
        retry = 'another window holds the sync lock';
        return keep();
      }
      return syncOne(); // a missing copy is built without the lock: building writes only under filtered/
    } catch (err) {
      log(`cannot build the filtered copy of ${plugin.name}: ${err.message}`);
      if (!fs.existsSync(copyRoot)) {
        return null;
      }
      if (LOCKED_CODES.includes(err.code)) {
        retry = err.code;
      }
      return keep(); // an existing copy stays registered
    }
  });
  if (retry) {
    scheduleCopyRetry(retry);
  }
  warnDroppedConflicts(partialCopies, copies);
  partialCopies = copies;
  updateConflicts();
  updateDiagnostics();
  for (const [name, p] of [...desired]) {
    if (p === null) {
      desired.delete(name);
    }
  }
  checkProjectRepositories(project);
  lastApplyErrors = 0;
  if (registrar) {
    const result = await registrar.apply(desired);
    lastApplyErrors = result.errors.length;
    const keep = new Set([...desired.values(), ...registrar.current.values()]);
    const holders = filteredHolders(filteredRoot, [...keep]);
    touchFiltered(holders);
    gcFiltered(filteredRoot, holders, FILTERED_MAX_AGE_MS);
  }
  if (descs.some((d) => d.kind === 'drafts') && !draftsWatched) {
    startWatchers(); // the drafts folder was created (by this window or another one) after the watchers started
  }
  await refreshChanges();
  await refreshUpdates();
  updateStatus();
}

// The last names of the repositories this window follows (<storage>/repo-names.json, outside state/, which is
// watched), so a repository renamed through its marketplace.json keeps being found under its old name: records the
// names read now and returns { repository key: [former names] }.
function rememberRepoNames() {
  const file = path.join(storage, 'repo-names.json');
  let memory = {};
  try {
    memory = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // missing or damaged: starts again
  }
  const result = rememberNames(memory, descs, (d) => catalogs.has(d.key) && fs.existsSync(d.dir));
  if (result.changed) {
    try {
      fs.mkdirSync(storage, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(result.memory, null, 2));
    } catch (err) {
      log(`cannot write repo-names.json: ${err.message}`);
    }
  }
  for (const r of result.renamed) {
    log(`repository ${r.from} is now named ${r.to}: its old ids are read with the new name`);
  }
  const former = {};
  for (const [key, e] of Object.entries(result.memory)) {
    if (e && Array.isArray(e.former)) {
      former[key] = e.former.filter((f) => typeof f === 'string');
    }
  }
  return former;
}

// 0.4 ids in the user's lists (`review`, `review/skills/x`) become `<repository>:<id>`, once the catalog knows them,
// and ids of renamed repositories, plugins and items follow the renames.
async function migrateIds() {
  const c = cfg();
  for (const key of ['enabled', 'excluded']) {
    const raw = stringList(c.get(key));
    const next = normalizeIds(catalog, raw);
    if (next.join('\n') !== [...new Set(raw)].sort().join('\n')) {
      try {
        await c.update(key, next, vscode.ConfigurationTarget.Global);
        log(`teamPlugins.${key}: ids updated (0.4 ids, or renamed repositories, plugins or items)`);
      } catch (err) {
        log(`cannot move the ids of teamPlugins.${key}: ${err.message}`);
      }
    }
  }
}

// The repositories the project uses and the user doesn't follow: offered once per window, shown in the view.
function checkProjectRepositories(project) {
  const projRepos = projectRepositories();
  missing = missingRepos(projRepos, descs);
  unlocated = unlocatedRepos(project, projRepos, descs);
  for (const e of missing) {
    if (missingNotified.has(e.normalized)) {
      continue;
    }
    missingNotified.add(e.normalized);
    ui
      .showInformationMessage(
        `Team plugins: this project uses plugins from ${e.name || baseName(e.url)} (${e.url}), which you don't follow.`,
        'Add repository',
        'Not now',
      )
      .then((choice) => (choice === 'Add repository' ? addRepositoryEntry({ url: e.url, branch: e.branch }) : undefined))
      .then(undefined, (err) => log(`cannot add ${e.url}: ${err.message}`));
  }
  for (const name of unlocated) {
    const key = `unlocated:${name}`;
    if (!loggedWarnings.has(key)) {
      loggedWarnings.add(key);
      log(`this project uses repository ${name}, which you don't follow and its settings don't locate`);
    }
  }
}

function logCopyActions(plugin, actions) {
  for (const a of actions) {
    log(`synced ${plugin.name}/${a.rel}: ${a.action}`);
  }
}

// What a partial-copy sync left out (links that are not followed, and folders that can't be read), once per file and
// reason.
function logSkipped(plugin, skipped) {
  for (const s of skipped) {
    const key = `skip:${plugin.name}/${s.rel}:${s.reason}`;
    if (!loggedWarnings.has(key)) {
      loggedWarnings.add(key);
      const where = s.rel ? `${plugin.name}/${s.rel}` : plugin.name;
      log(`${where} left out of the partial copy: ${s.reason}`);
      if (s.unreadable) {
        ui.showWarningMessage(`Team plugins: ${where}: ${s.reason}. Its files are not synced until it can be read again.`);
      }
    }
  }
}

// The spelling differences a partial-copy sync did not carry (a file or folder named in another case on each side),
// once per file and reason.
function logNotes(plugin, notes) {
  for (const n of notes || []) {
    const key = `note:${plugin.name}/${n.rel}:${n.reason}`;
    if (!loggedWarnings.has(key)) {
      loggedWarnings.add(key);
      log(`${plugin.name}/${n.rel}: ${n.reason}`);
    }
  }
}

// A partial-copy sync that met a locked file or a busy lock is retried shortly, so a copy edit reaches the clone
// without another trigger.
function scheduleCopyRetry(reason) {
  if (copyRetryTimer) {
    return;
  }
  if (copyRetries >= COPY_RETRY_MAX) {
    log(`partial-copy sync still failing after ${COPY_RETRY_MAX} retries (${reason}): the next change retries it`);
    copyRetries = 0;
    return;
  }
  copyRetries++;
  copyRetryTimer = setTimeout(() => {
    copyRetryTimer = null;
    enqueue(syncPartials);
  }, COPY_RETRY_MS);
}

// Reads the local changes of every managed clone (shown as a group in each repository; they enable Commit and push).
async function refreshChanges() {
  const run = makeGit(gitPath());
  for (const d of descs) {
    const s = stateOf(d.key);
    if (s.syncing) {
      continue; // git is busy in that clone: the view keeps what it showed
    }
    s.changes = null;
    if (isManaged(d) && fs.existsSync(path.join(d.dir, '.git'))) {
      try {
        s.changes = await sync.localChanges({ run, repo: d.dir });
      } catch (err) {
        s.changes = { files: [], ahead: 0, error: err.message };
        const key = `changes:${d.key}:${err.message}`;
        if (!loggedWarnings.has(key)) {
          loggedWarnings.add(key);
          log(`cannot read the local changes of ${labelOf(d)}: ${err.message}`);
        }
      }
    }
  }
  await vscode.commands.executeCommand(
    'setContext',
    'teamPlugins.hasChanges',
    descs.some((d) => isManaged(d) && hasChanges(stateOf(d.key))),
  );
  treeProvider.refresh();
}

function hasChanges(state) {
  const changes = state && state.changes;
  return !!changes && (changes.files.length > 0 || changes.ahead > 0);
}

// Reports a local-changes read failure (true) so a command never says "nothing to commit" when git failed.
function changesUnreadable(state, d) {
  if (state.changes && state.changes.error) {
    ui
      .showErrorMessage(`Team plugins: cannot read the local changes of ${labelOf(d)}: ${state.changes.error}`, 'Show log')
      .then((choice) => (choice === 'Show log' ? output.show() : undefined));
    return true;
  }
  return false;
}

// ---- update summary ----------------------------------------------------------------------------------------------

// What the user has seen of a repository: <storage>/seen/<key>.json (outside state/, which is watched too, so that
// marking an item seen applies in every window).
function seenFile(d) {
  return path.join(storage, 'seen', `${d.key}.json`);
}

// A repository the update summary follows: its plugins are loaded and it is a clone (the drafts are not tracked).
function tracksUpdates(d) {
  return isActive(d) && (d.kind === 'managed' || d.kind === 'local');
}

function updateCounts(marks, removed) {
  const counts = { new: 0, updated: 0, removed: removed.length };
  for (const mark of marks.values()) {
    counts[mark]++;
  }
  return counts;
}

function countTotal(counts) {
  return counts.new + counts.updated + counts.removed;
}

function logOnce(key, message) {
  if (!loggedWarnings.has(key)) {
    loggedWarnings.add(key);
    log(message);
  }
}

// The marks of every followed repository (after refreshChanges, in every apply), the notification of a sync, and the
// number on the view's icon.
async function refreshUpdates() {
  const run = makeGit(gitPath());
  for (const d of descs) {
    const s = stateOf(d.key);
    if (!tracksUpdates(d) || s.syncing) {
      continue; // git is busy in that clone: the view keeps what it showed
    }
    try {
      await updateRepo(d, s, run);
    } catch (err) {
      s.updates = null;
      logOnce(`updates:${d.key}:${err.message}`, `cannot read the updates of ${labelOf(d)}: ${err.message}`);
    }
    if (s.updateNotice) {
      const notice = s.updateNotice;
      s.updateNotice = null;
      try {
        await showUpdateNotice(d, s, notice, run);
      } catch (err) {
        log(`cannot name the updates of ${labelOf(d)}: ${err.message}`);
      }
    }
  }
  updateBadge();
  treeProvider.refresh();
}

// Reads git at HEAD (once per HEAD), compares it with what the user has seen and stores the result in s.updates.
async function updateRepo(d, s, run) {
  const cat = catalogs.get(d.key);
  if (!cat) {
    return;
  }
  const items = updates.updateItems(cat.plugins, d.dir);
  let summary = null;
  await updates.updateSeen(seenFile(d), async (latest) => {
    const record = s.updatesBaseline ? null : latest;
    const head = await updates.readHead({ run, repoDir: d.dir });
    if (!head) {
      return undefined;
    }
    const mcpFiles = updates.mcpFilesOf([...items, ...Object.values(record?.items || {})]);
    const mcpKey = JSON.stringify(mcpFiles);
    const cached = s.updates && s.updates.git;
    const git =
      cached && cached.complete && cached.head === head && cached.mcpKey === mcpKey
        ? cached
        : await updates.readGitData({ run, repoDir: d.dir, head, mcpFiles });
    if (!git) {
      return undefined;
    }
    git.mcpKey = mcpKey;
    const fps = updates.fingerprints(items, git.tree, git.mcpTexts);
    const paths = new Map(items.map((i) => [i.id, i.path]));
    for (const p of cat.plugins) {
      paths.set(p.name, updates.pluginPath(p, d.dir));
    }
    for (const [id, entry] of Object.entries(record?.items || {})) {
      if (!paths.has(id) && entry && typeof entry.path === 'string') {
        paths.set(id, entry.path); // a removed item: its last change is the one that removed it
      }
    }
    const last = updates.lastChanges(paths, git.commits);
    const result = updates.computeMarks({
      items,
      fps,
      record,
      last,
      self: git.self,
      head: git.head,
      git,
      renamed: git.renamed,
      plugins: cat.plugins,
    });
    summary = {
      git,
      items,
      fps,
      last,
      marks: result.marks,
      removed: result.removed,
      record: result.record,
      counts: updateCounts(result.marks, result.removed),
    };
    return result.changed ? result.record : undefined;
  });
  s.updates = summary;
  if (summary) {
    s.updatesBaseline = false;
  }
}

// The ids (without the repository's name) of the items of d that the user's selection includes.
function enabledLocalIds(d) {
  const eff = selection.effective(catalog, userSelection(), projectList());
  const prefix = `${d.name}:`;
  const ids = new Set();
  for (const p of catalog.plugins.filter((x) => x.repoKey === d.key)) {
    const e = eff.get(p.name);
    for (const id of e ? e.included : []) {
      if (id.startsWith(prefix)) {
        ids.add(id.slice(prefix.length));
      }
    }
  }
  return ids;
}

// The notification of a sync that fetched commits: who changed which items (the enabled ones first). Commits that
// touch no item keep the plain message; commits that are all the user's own say nothing.
async function showUpdateNotice(d, s, notice, run) {
  const u = s.updates;
  const range = await updates.rangeHashes({ run, repoDir: d.dir, from: notice.from, to: notice.to });
  const entries = u
    ? updates.noticeEntries({ marks: u.marks, removed: u.removed, last: u.last, range, items: u.items, enabled: enabledLocalIds(d) })
    : [];
  const message = updates.noticeMessage({
    repoName: labelOf(d),
    entries,
    kept: notice.kept,
    count: notice.commits,
    range,
    commits: u ? u.git.commits : [],
    self: u ? u.git.self : '',
  });
  if (!message) {
    return;
  }
  ui
    .showInformationMessage(message.text, ...(message.button ? ['What changed'] : []))
    .then((choice) => (choice === 'What changed' ? vscode.commands.executeCommand('teamPlugins.whatChanged', { repo: d.key }) : undefined))
    .then(undefined, (err) => log(`cannot show what changed in ${labelOf(d)}: ${err.message}`));
}

// The number on the view's icon: the items new, updated or removed since the user last looked, in every repository.
function updateBadge() {
  if (!treeView) {
    return;
  }
  let total = 0;
  for (const d of descs) {
    const u = tracksUpdates(d) ? stateOf(d.key).updates : null;
    total += u ? countTotal(u.counts) : 0;
  }
  treeView.badge =
    total > 0 ? { value: total, tooltip: `${total} new or updated team plugin item(s) since you last looked` } : undefined;
}

// Acknowledge the entries from the displayed summary. Other windows refresh through the seen/ watcher.
async function markItemsSeen(d, u, entries) {
  const changes = entries.map((item) => ({
    id: item.id,
    previous: u.record.items[item.id],
    entry: item.verb === 'removed' ? null : updates.entryOf(item, u.fps.get(item.id), u.git.head),
  }));
  const run = makeGit(gitPath());
  try {
    await updates.updateSeen(seenFile(d), async (latest) => {
      const head = await updates.readHead({ run, repoDir: d.dir });
      return head === u.git.head ? updates.mergeSeen(latest, changes) : undefined;
    });
  } catch (err) {
    const message = `Cannot mark changes in ${labelOf(d)} as seen: ${err.message}`;
    log(message);
    ui.showErrorMessage(message);
    return;
  }
  await apply();
}

// An item node of the view ({ kind, key }, key = merged id): its repository, summary and item; null when the update
// summary does not know it.
function updateItemOf(node) {
  if (!node || typeof node.key !== 'string') {
    return null;
  }
  const repo = repoOfId(node.key);
  const d = descs.find((x) => tracksUpdates(x) && x.name === repo);
  const u = d && stateOf(d.key).updates;
  const id = node.key.slice(repo.length + 1);
  const item = u && u.items.find((i) => i.id === id);
  return item ? { d, u, item } : null;
}

function commitTitle(name, commit) {
  return commit ? `${name} (${commit.author}, ${updates.ago(commit.date, new Date())})` : `${name} (changes since you last looked)`;
}

// Opens the diff of an item between two revisions of its repository: one file as a diff, a skill with several files
// as a multi-file diff. item: { kind, name, path }; a revision of '' is an absent side.
async function openItemDiff(d, item, { leftRev, rightRev, leftItem = item, title }) {
  const side = (rev, location, file = location.path) =>
    gitUri(d.dir, rev, file, location.kind === 'mcp' ? location.name : undefined);
  if (item.kind !== 'skill') {
    await vscode.commands.executeCommand('vscode.diff', side(leftRev, leftItem), side(rightRev, item), title);
    return;
  }
  const run = makeGit(gitPath());
  const skillFiles = async (rev, dir) =>
    (await updates.treeFiles({ run, repoDir: d.dir, rev, dir })).map((file) => file.slice(dir.length + 1));
  const [before, after] = await Promise.all([skillFiles(leftRev, leftItem.path), skillFiles(rightRev, item.path)]);
  const left = (file) => side(leftRev, leftItem, `${leftItem.path}/${file}`);
  const right = (file) => side(rightRev, item, `${item.path}/${file}`);
  const files = [...new Set([...before, ...after])].sort();
  if (files.length <= 1) {
    const file = files[0] || 'SKILL.md';
    await vscode.commands.executeCommand('vscode.diff', left(file), right(file), title);
    return;
  }
  // vscode.changes takes [label, left, right] and needs both sides: an absent one is a document with an empty rev
  await vscode.commands.executeCommand(
    'vscode.changes',
    title,
    files.map((f) => [after.includes(f) ? right(f) : left(f), left(f), right(f)]),
  );
}

// The diff of a marked or removed item since the user last saw it; the item counts as seen once it is open.
async function openSeenDiff(d, u, entry) {
  const seen = entry.verb === 'new' ? undefined : u.record.items[entry.id];
  const leftItem = seen && { kind: seen.kind, path: seen.seenPath ?? seen.path, name: seen.seenName ?? seen.name };
  await openItemDiff(d, entry, {
    leftRev: seen?.commit || '',
    rightRev: entry.verb === 'removed' ? '' : u.git.head,
    leftItem,
    title: commitTitle(entry.name, u.last.get(entry.id)),
  });
  await markItemsSeen(d, u, [entry]);
}

// The marked and the removed items of a repository, in the order the view shows them.
function changedEntries(u) {
  const entries = [];
  for (const item of u.items) {
    if (u.marks.has(item.id)) {
      entries.push({ id: item.id, kind: item.kind, name: item.name, path: item.path, verb: u.marks.get(item.id) });
    }
  }
  for (const r of u.removed) {
    entries.push({ id: r.id, kind: r.kind, name: r.name, path: r.path, verb: 'removed' });
  }
  return entries;
}

const VERB_WORDS = { new: 'added', updated: 'updated', removed: 'removed' };

async function whatChangedCommand(arg) {
  const hasUpdates = (d) => {
    const u = tracksUpdates(d) ? stateOf(d.key).updates : null;
    return !!u && countTotal(u.counts) > 0;
  };
  let d = repoFromArg(arg);
  if (!d) {
    if (!listConfigured().some(hasUpdates)) {
      ui.showInformationMessage('Nothing new since you last looked.');
      return;
    }
    d = await pickRepo(undefined, { filter: hasUpdates, placeHolder: 'Which repository?' });
    if (!d) {
      return;
    }
  }
  const u = tracksUpdates(d) ? stateOf(d.key).updates : null;
  if (!u || countTotal(u.counts) === 0) {
    ui.showInformationMessage(`Nothing new in ${labelOf(d)} since you last looked.`);
    return;
  }
  const entries = changedEntries(u);
  if (entries.length === 1) {
    await openSeenDiff(d, u, entries[0]);
    return;
  }
  const MARK_ALL = '$(check-all) Mark all as seen';
  const now = new Date();
  const picks = entries.map((e) => {
    const commit = u.last.get(e.id);
    const plugin = e.id.split('/')[0];
    const what = `${plugin} · ${KIND_LABELS[e.kind] || e.kind}`;
    return {
      label: `$(${e.verb === 'removed' ? 'trash' : TREE_ICONS[e.kind]}) ${e.name}`,
      description: commit ? `${what} · ${VERB_WORDS[e.verb]} by ${commit.author}, ${updates.ago(commit.date, now)}` : `${what} · ${VERB_WORDS[e.verb]}`,
      detail: commit ? commit.subject : undefined,
      entry: e,
    };
  });
  const picked = await ui.showQuickPick([{ label: MARK_ALL }, ...picks], {
    placeHolder: `${labelOf(d)}: ${entries.length} change(s) since you last looked`,
  });
  if (!picked) {
    return;
  }
  if (picked.label === MARK_ALL) {
    await markItemsSeen(d, u, entries);
  } else if (picked.entry) {
    await openSeenDiff(d, u, picked.entry);
  }
}

// Show changes on an item: its diff since the user last saw it, or (not marked) its last change.
async function showChangesCommand(node) {
  const found = updateItemOf(node);
  if (!found) {
    return;
  }
  const { d, u, item } = found;
  if (u.marks.has(item.id)) {
    await openSeenDiff(d, u, { id: item.id, kind: item.kind, name: item.name, path: item.path, verb: u.marks.get(item.id) });
    return;
  }
  const commit = u.last.get(item.id);
  if (!commit) {
    ui.showInformationMessage(`No commit of ${labelOf(d)} has changed ${item.name} yet.`);
    return;
  }
  const parent = await makeGit(gitPath())(['rev-parse', `${commit.hash}^`], d.dir);
  await openItemDiff(d, item, {
    leftRev: parent.code === 0 ? parent.stdout : '',
    rightRev: u.git.head,
    title: `${item.name}: last change (${commit.author}, ${updates.ago(commit.date, new Date())})`,
  });
}

// A partial copy left behind (its plugin is now fully enabled, disabled or selected differently) is no longer synced:
// its unresolved conflict versions would only wait for the cleanup, so say where they are.
function warnDroppedConflicts(before, after) {
  const kept = new Set([...after.values()].map((e) => e.holder));
  for (const entry of before.values()) {
    const n = (entry.conflicts || []).length;
    if (n === 0 || kept.has(entry.holder)) {
      continue;
    }
    log(`partial copy of ${entry.plugin.name} dropped with ${n} unresolved conflict(s): ${entry.copyRoot}`);
    ui
      .showWarningMessage(
        `Team plugins: the partial copy of ${entry.plugin.name} is no longer used, with ${n} conflict(s) never resolved. Its versions of those files stay in its folder for a week.`,
        'Open files',
      )
      .then(async (choice) => {
        if (!choice) {
          return;
        }
        const files = entry.conflicts.map((c) => c.copy).filter((f) => fs.existsSync(f));
        if (files.length === 0) {
          ui.showInformationMessage(
            `The partial copy deleted these files: ${entry.conflicts.map((c) => c.rel).join(', ')}. Folder: ${entry.copyRoot}`,
          );
          return;
        }
        for (const f of files) {
          await vscode.window.showTextDocument(vscode.Uri.file(f), { preview: false });
        }
      })
      .then(undefined, (err) => log(`cannot open the dropped copy's files: ${err.message}`));
  }
}

// Publishes the problems of the catalogs (lib/checks.js) as diagnostics: on the file in the repository and, for a
// plugin that has a partial copy, on the same file in the copy (the one an agent edits). The collection is replaced only
// when its content changes.
function updateDiagnostics() {
  if (!diagnostics) {
    return;
  }
  const all = [];
  for (const cat of catalogs.values()) {
    all.push(...(cat.problems || []));
    for (const plugin of cat.plugins || []) {
      all.push(...(plugin.problems || []));
      for (const child of plugin.children || []) {
        all.push(...(child.problems || []));
      }
    }
  }
  const byFile = new Map();
  const add = (file, p) => {
    if (!byFile.has(file)) {
      byFile.set(file, []);
    }
    byFile.get(file).push(p);
  };
  for (const p of all) {
    if (p.file) {
      add(p.file, p);
    }
  }
  for (const { plugin, copyRoot } of partialCopies.values()) {
    for (const [file, list] of [...byFile]) {
      const rel = path.relative(plugin.dir, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        continue;
      }
      const mirror = path.join(copyRoot, rel);
      if (fs.existsSync(mirror)) {
        for (const p of list) {
          add(mirror, p);
        }
      }
    }
  }
  // a marker records the version of the file's open document when it is set, and Cursor's ReadLints drops a marker
  // older than the document: an edit of an open file sets the diagnostics again even when they read the same
  const norm = (f) => (process.platform === 'win32' ? path.resolve(f).toLowerCase() : path.resolve(f));
  const versions = new Map(vscode.workspace.textDocuments.map((doc) => [norm(doc.uri.fsPath), doc.version]));
  const key = JSON.stringify(
    [...byFile]
      .flatMap(([file, list]) =>
        list.map((p) => JSON.stringify([file, versions.get(norm(file)) || 0, p.line, p.severity, p.message])),
      )
      .sort(),
  );
  if (key === diagnosticsKey) {
    return;
  }
  diagnosticsKey = key;
  diagnostics.clear();
  diagnostics.set(
    [...byFile].map(([file, list]) => [
      vscode.Uri.file(file),
      list.map((p) => {
        const row = Math.max(p.line, 1) - 1;
        const d = new vscode.Diagnostic(
          new vscode.Range(row, 0, row, 10000),
          p.message,
          p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning,
        );
        d.source = 'Team plugins';
        return d;
      }),
    ]),
  );
}

// Rebuilds the list of partial-copy conflicts from partialCopies and announces the new ones. Returns whether the list
// changed.
function updateConflicts() {
  const before = copyConflicts.map((c) => `${c.holder}|${c.rel}`).join('\n');
  const list = [];
  for (const entry of partialCopies.values()) {
    for (const c of entry.conflicts || []) {
      list.push({
        plugin: entry.plugin.name,
        rel: c.rel,
        source: c.source,
        copy: c.copy,
        holder: entry.holder,
        repo: entry.plugin.repoKey,
      });
    }
  }
  list.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  copyConflicts = list;
  const keys = new Set(list.map((c) => `${c.holder}|${c.rel}`));
  for (const key of [...conflictsNotified]) {
    if (!keys.has(key)) {
      conflictsNotified.delete(key);
    }
  }
  const fresh = list.filter((c) => !conflictsNotified.has(`${c.holder}|${c.rel}`));
  for (const c of fresh) {
    conflictsNotified.add(`${c.holder}|${c.rel}`);
  }
  if (fresh.length === 1) {
    const c = fresh[0];
    const node = buildConflictsNode([c], c.repo).children[0];
    ui
      .showWarningMessage(
        `Team plugins: ${c.plugin}/${c.rel} was changed both in the repository and in a partial copy since the last sync. Both versions are kept until you choose one.`,
        'Compare',
        'Keep repository version',
        'Keep copy version',
      )
      .then((choice) => {
        if (choice === 'Compare') {
          return vscode.commands.executeCommand('teamPlugins.openConflict', node);
        }
        if (choice === 'Keep repository version') {
          return vscode.commands.executeCommand('teamPlugins.keepRepositoryVersion', node);
        }
        if (choice === 'Keep copy version') {
          return vscode.commands.executeCommand('teamPlugins.keepCopyVersion', node);
        }
        return undefined;
      });
  } else if (fresh.length > 1) {
    ui
      .showWarningMessage(
        `Team plugins: ${fresh.length} files were changed both in the repository and in a partial copy since the last sync. Both versions are kept until you choose one in the Conflicts group.`,
        'Show conflicts',
      )
      .then((choice) => (choice ? vscode.commands.executeCommand(VIEW_COMMAND) : undefined));
  }
  return before !== list.map((c) => `${c.holder}|${c.rel}`).join('\n');
}

// A change of a partial copy goes to the repository (and the other way); the view then shows it in Local changes.
function syncPartials() {
  let toSource = false;
  let retry = '';
  for (const entry of partialCopies.values()) {
    const lockFile = lockOf(entry.plugin.repoKey);
    if (!lockFile) {
      continue; // its repository is no longer configured
    }
    const locked = sync.withLockSync(lockFile, () => {
      try {
        const { actions, conflicts, skipped, notes } = syncCopy(entry.plugin, entry.ids, entry.holder);
        logCopyActions(entry.plugin, actions);
        logSkipped(entry.plugin, skipped);
        logNotes(entry.plugin, notes);
        entry.conflicts = conflicts;
        toSource =
          toSource ||
          actions.some((a) => a.action === 'toSource' || a.action === 'renamedInSource' || a.action === 'deletedInSource');
      } catch (err) {
        log(`cannot sync the partial copy of ${entry.plugin.name}: ${err.message}`);
        if (LOCKED_CODES.includes(err.code)) {
          retry = err.code;
        }
      }
    });
    if (locked.kind === 'busy') {
      retry = 'another window holds the sync lock';
    }
  }
  if (retry) {
    scheduleCopyRetry(retry);
  } else {
    copyRetries = 0;
  }
  const changed = updateConflicts();
  if (toSource) {
    return refreshChanges().then(updateStatus);
  }
  if (changed) {
    treeProvider.refresh();
    updateStatus();
  }
  return undefined;
}

// Copy edits still waiting for the watcher's debounce go to the repository first, so that a commit includes them.
async function flushPartials() {
  if (copyDebounce) {
    clearTimeout(copyDebounce);
    copyDebounce = null;
  }
  await enqueue(syncPartials);
}

// After a clone was reset to the team version (discard), the partial copies of its plugins take the
// clone's side at the next apply: left as they are, their edits (newer than the last sync) would be copied back into the
// clone. They are updated in place (markCopySynced), not deleted: Windows refuses to delete a folder Cursor watches.
function resetPartialCopies(repoKey) {
  for (const entry of partialCopies.values()) {
    if (entry.plugin.repoKey !== repoKey) {
      continue;
    }
    try {
      markCopySynced(entry.holder);
    } catch (err) {
      log(`cannot reset the partial copy of ${entry.plugin.name}: ${err.message}`);
    }
  }
}

function startCopyWatcher() {
  const { filteredRoot } = paths();
  fs.mkdirSync(filteredRoot, { recursive: true });
  const onFile = (uri) => {
    if (uri.fsPath.includes('.tmp-')) {
      return;
    }
    const inside = [...partialCopies.values()].some((e) => {
      const rel = path.relative(e.copyRoot, uri.fsPath);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
    if (!inside) {
      return;
    }
    if (copyDebounce) {
      clearTimeout(copyDebounce);
    }
    copyDebounce = setTimeout(() => {
      copyDebounce = null;
      enqueue(syncPartials);
    }, 500);
  };
  copyWatcher = watchTree(filteredRoot, onFile);
}

function stopCopyWatcher() {
  if (copyWatcher) {
    copyWatcher.dispose();
    copyWatcher = null;
  }
  if (copyDebounce) {
    clearTimeout(copyDebounce);
    copyDebounce = null;
  }
  if (copyRetryTimer) {
    clearTimeout(copyRetryTimer);
    copyRetryTimer = null;
  }
}

// ---- status bar --------------------------------------------------------------------------------------------------

function updateStatus() {
  if (!statusItem) {
    return;
  }
  const count = registrar ? registrar.current.size : 0;
  const states = descs.map((d) => [d, stateOf(d.key)]);
  let text;
  if (states.some(([, s]) => s.syncing)) {
    text = '$(sync~spin) Team plugins';
  } else if (descs.every((d) => d.kind === 'drafts')) {
    text = '$(plug) Team plugins: not configured';
  } else if (!api) {
    text = '$(error) Team plugins';
  } else if (
    states.some(([d, s]) => repoStatus(d, s).problem) ||
    lastApplyErrors > 0 ||
    copyConflicts.length > 0 ||
    states.some(([, s]) => s.changes && s.changes.error)
  ) {
    text = `$(warning) Team plugins: ${count}`;
  } else if (states.some(([d, s]) => isManaged(d) && s.lastResult && s.lastResult.kind === 'offline')) {
    text = `$(debug-disconnect) Team plugins: ${count}`; // after the warnings: being offline is the least of them
  } else {
    text = `$(plug) Team plugins: ${count}`;
  }
  statusItem.text = text;

  const lines = ['Team plugins'];
  if (remoteMachine()) {
    lines.push(`Machine: ${remoteMachine()} (remote window)`);
  }
  for (const [d, s] of states) {
    if (isEmptyDrafts(d)) {
      continue;
    }
    let line = `${labelOf(d)}: ${repoStatus(d, s).text}`;
    if (s.lastResult && s.lastResult.head) {
      line += ` · ${String(s.lastResult.head).slice(0, 7)}`;
    }
    if (hasChanges(s)) {
      line += ` · ${s.changes.files.length} file(s), ${s.changes.ahead} unpushed commit(s)`;
    } else if (s.changes && s.changes.error) {
      line += ' · local changes cannot be read';
    }
    if (s.lastCheck) {
      line += ` · last check ${s.lastCheck.toTimeString().slice(0, 5)}`;
    }
    lines.push(line);
  }
  if (!api) {
    lines.push('vscode.cursor.plugins is missing in this Cursor');
  }
  if (copyConflicts.length > 0) {
    lines.push(`Partial copy conflicts: ${copyConflicts.length} (see the Conflicts groups)`);
  }
  if (lastApplyErrors > 0) {
    lines.push(`Registration errors: ${lastApplyErrors} (see the log)`);
  }
  const cost = contextCost.selectionCost(catalog, selection.effective(catalog, userSelection(), projectList()));
  lines.push(...contextCost.statusLines(cost));
  if (registrar) {
    const { filteredRoot } = paths();
    const names = [...registrar.current].map(
      ([name, p]) => name + (p.startsWith(filteredRoot) ? ' (partial)' : ''),
    );
    lines.push(`Active: ${names.join(', ') || 'none'}`);
  }
  statusItem.tooltip = lines.join('\n');
  if (treeView) {
    treeView.description = contextCost.viewDescription(cost);
  }
}

// ---- tree --------------------------------------------------------------------------------------------------------

// Codicons per node kind (shown after the checkbox).
const TREE_ICONS = {
  plugin: 'package',
  skill: 'sparkle',
  rule: 'law',
  command: 'terminal',
  agent: 'robot',
  mcp: 'plug',
  error: 'warning',
  changes: 'git-commit',
  conflicts: 'warning',
  conflict: 'git-merge',
};
// The kinds of the selectable items below a plugin.
const ITEM_KINDS = ['skill', 'rule', 'command', 'agent', 'mcp'];

// Project items are marked by a file decoration (label colour + badge): plugin and item rows carry a
// team-plugins:/<key> resourceUri, which no other decoration provider touches.
const ITEM_SCHEME = 'team-plugins';
const decorationEmitter = new vscode.EventEmitter();
let projectStates = new Map(); // item uri -> { project: 'all' | 'some' | null, mark: 'new' | 'updated' | null }

function itemUri(key) {
  return vscode.Uri.from({ scheme: ITEM_SCHEME, path: `/${key}` });
}

// Records the project state and the mark of the plugin and item nodes; tells the decoration service only when it
// changed.
function updateProjectStates(nodes) {
  const next = new Map();
  for (const n of nodes.filter((x) => x.kind === 'plugin')) {
    for (const m of [n, ...n.children]) {
      if (m.project || m.mark) {
        next.set(itemUri(m.key).toString(), { project: m.project || null, mark: m.mark || null });
      }
    }
  }
  const flat = (map) => JSON.stringify([...map]);
  if (flat(next) !== flat(projectStates)) {
    projectStates = next;
    decorationEmitter.fire(undefined);
  }
}

const projectDecorations = {
  onDidChangeFileDecorations: decorationEmitter.event,
  provideFileDecoration(uri) {
    if (uri.scheme !== ITEM_SCHEME) {
      return undefined;
    }
    const state = projectStates.get(uri.toString());
    const decoration = state ? itemDecoration(state.project, state.mark) : null;
    if (!decoration) {
      return undefined;
    }
    return new vscode.FileDecoration(
      decoration.badge,
      decoration.tooltip,
      decoration.color ? new vscode.ThemeColor(decoration.color) : undefined,
    );
  },
};

const CHANGE_ICONS = {
  modified: 'diff-modified',
  added: 'diff-added',
  untracked: 'diff-added',
  deleted: 'diff-removed',
  renamed: 'diff-renamed',
};

class PluginTree {
  constructor() {
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }

  refresh() {
    this._emitter.fire();
  }

  getChildren(node) {
    if (node) {
      return node.children;
    }
    if (descs.length === 0) {
      updateProjectStates([]);
      return [];
    }
    const project = projectList();
    const eff = selection.effective(catalog, userSelection(), project);
    const pluginNodes = [];
    const repoNodes = descs.filter((d) => !isEmptyDrafts(d)).map((d) => {
      const s = stateOf(d.key);
      const children = [
        buildConflictsNode(
          copyConflicts.filter((c) => c.repo === d.key),
          d.key,
        ),
        buildChangesNode(s.changes, d.key),
      ].filter((n) => n);
      let plugins = [];
      const summary = isActive(d) && d.kind !== 'drafts' ? s.updates : null;
      if (isActive(d)) {
        // the summary has the repository's own ids; the merged catalog prefixes them with its name
        const prefix = `${d.name}:`;
        const upd = summary && {
          marks: new Map([...summary.marks].map(([id, mark]) => [prefix + id, mark])),
          last: new Map([...summary.last].map(([id, commit]) => [prefix + id, commit])),
          now: new Date(),
        };
        plugins = buildTree({ plugins: catalog.plugins.filter((p) => p.repoKey === d.key) }, eff, project, {
          draft: d.kind === 'drafts',
          updates: upd,
        });
        pluginNodes.push(...plugins);
        children.push(...plugins);
      }
      if (plugins.length === 0 && s.lastResult && ['error', 'offline'].includes(s.lastResult.kind)) {
        children.push({
          id: `sync-error:${d.key}`,
          kind: 'error',
          label: `Sync failed: ${s.lastResult.message}`,
          description: '',
          tooltip: s.lastResult.message,
          contextValue: 'error',
          children: [],
        });
      }
      return buildRepoNode(
        { ...d, name: labelOf(d) },
        s,
        children,
        summary ? summary.counts : undefined,
        isActive(d) ? (catalogs.get(d.key) || {}).problems : undefined,
      );
    });
    updateProjectStates(pluginNodes);
    return [...buildMissingNodes(missing, unlocated), ...repoNodes];
  }

  getTreeItem(node) {
    let state = vscode.TreeItemCollapsibleState.None;
    if (node.children.length) {
      state =
        node.kind === 'changes' || node.kind === 'conflicts' || node.kind === 'repo'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
    }
    const item = new vscode.TreeItem(node.label, state);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    if (node.kind === 'repo') {
      item.iconPath = new vscode.ThemeIcon(node.icon);
      return item;
    }
    if (node.kind === 'missing') {
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }
    if (node.kind === 'change') {
      item.iconPath = new vscode.ThemeIcon(CHANGE_ICONS[node.status] || 'diff-modified');
    } else if (node.kind === 'changes' && node.error) {
      item.iconPath = new vscode.ThemeIcon('warning');
      item.command = { command: 'teamPlugins.showLog', title: 'Show log' };
    } else if (node.problem) {
      const isError = node.problem === 'error';
      item.iconPath = new vscode.ThemeIcon(
        isError ? 'error' : 'warning',
        new vscode.ThemeColor(isError ? 'list.errorForeground' : 'list.warningForeground'),
      );
    } else if (TREE_ICONS[node.kind]) {
      item.iconPath = new vscode.ThemeIcon(node.kind === 'plugin' && node.partial ? 'pie-chart' : TREE_ICONS[node.kind]);
    }
    if (node.kind === 'error') {
      item.command = { command: 'teamPlugins.showLog', title: 'Show log' };
    } else if (node.kind === 'change') {
      item.command = { command: 'teamPlugins.openChange', title: 'Open changes', arguments: [node] };
    } else if (node.kind === 'conflict') {
      item.command = { command: 'teamPlugins.openConflict', title: 'Compare', arguments: [node] };
    } else if (node.kind !== 'changes' && node.kind !== 'conflicts') {
      item.resourceUri = itemUri(node.key);
      const checkState = node.checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      item.checkboxState = node.checkboxTooltip ? { state: checkState, tooltip: node.checkboxTooltip } : checkState;
      if (node.kind !== 'plugin') {
        item.command = { command: 'teamPlugins.openItem', title: 'Open file', arguments: [node] };
      }
    }
    return item;
  }

}

async function onCheckboxChange(e) {
  const before = userSelection();
  let user = before;
  const unchecked = [];
  for (const [node, state] of e.items) {
    if (node.kind !== 'plugin' && !ITEM_KINDS.includes(node.kind)) {
      continue;
    }
    const checked = state === vscode.TreeItemCheckboxState.Checked;
    user = selection.toggle(catalog, user, node.key, checked);
    if (!checked) {
      unchecked.push(node);
    }
  }
  const config = cfg();
  for (const key of ['enabled', 'excluded']) {
    if (JSON.stringify(user[key]) !== JSON.stringify(before[key])) {
      await config.update(key, user[key], vscode.ConfigurationTarget.Global);
    }
  }
  // unticking switches an item off, the project's requirement included (the user commits .vscode/settings.json)
  for (const node of unchecked) {
    await removeFromProjectCommand(node);
  }
  treeProvider.refresh();
}

// ---- project commands --------------------------------------------------------------------------------------------

async function addToProjectCommand(node) {
  const folders = vscode.workspace.workspaceFolders || [];
  if (folders.length === 0) {
    ui.showErrorMessage('Open a folder first: project plugins are saved in its .vscode/settings.json.');
    return;
  }
  let folder = folders[0];
  if (folders.length > 1) {
    folder = await ui.showWorkspaceFolderPick();
    if (!folder) {
      return;
    }
  }
  const config = vscode.workspace.getConfiguration(SECTION, folder.uri);
  const inspected = config.inspect('projectPlugins');
  const list = normalizeIds(catalog, stringList(inspected && inspected.workspaceFolderValue));
  await config.update(
    'projectPlugins',
    selection.addToProject(catalog, list, node.key),
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
  // say where the repository is, so a teammate who doesn't follow it can be offered to add it
  const d = descs.find((x) => isActive(x) && x.name === repoOfId(node.key));
  if (!d) {
    return;
  }
  let origin = '';
  if (d.kind === 'local') {
    try {
      origin = originUrl(fs.readFileSync(path.join(d.dir, '.git', 'config'), 'utf8'));
    } catch {
      // not a git clone
    }
  }
  const entry = projectRepoEntry(d, origin);
  if (!entry) {
    log(`cannot record where ${d.name} is: its clone has no origin URL`);
    return;
  }
  const current = config.inspect('projectRepositories');
  const before = current && current.workspaceFolderValue;
  const next = withProjectRepo(before, entry);
  if (JSON.stringify(next) !== JSON.stringify(before || [])) {
    await config.update('projectRepositories', next, vscode.ConfigurationTarget.WorkspaceFolder);
  }
}

async function removeFromProjectCommand(node) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const name = repoOfId(node.key);
  // one level (a folder's settings or the workspace's): its list, then its record of where the repository is
  const forLevel = async (config, valueKey, target) => {
    const inspected = config.inspect('projectPlugins');
    if (!inspected || !Array.isArray(inspected[valueKey])) {
      return;
    }
    const list = normalizeIds(catalog, stringList(inspected[valueKey]));
    const next = selection.removeFromProject(catalog, list, node.key);
    if (same(list, next)) {
      return; // this level never listed the item: its record of the repository is none of this command's business
    }
    await config.update('projectPlugins', next, target);
    const repoInspected = config.inspect('projectRepositories');
    if (repoInspected && Array.isArray(repoInspected[valueKey])) {
      const nextRepos = withoutProjectRepo(repoInspected[valueKey], name, next);
      if (!same(repoInspected[valueKey], nextRepos)) {
        await config.update('projectRepositories', nextRepos, target);
      }
    }
  };
  for (const folder of vscode.workspace.workspaceFolders || []) {
    await forLevel(
      vscode.workspace.getConfiguration(SECTION, folder.uri),
      'workspaceFolderValue',
      vscode.ConfigurationTarget.WorkspaceFolder,
    );
  }
  await forLevel(cfg(), 'workspaceValue', vscode.ConfigurationTarget.Workspace);
}

// ---- timer and watchers ------------------------------------------------------------------------------------------

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function startTimer() {
  stopTimer();
  const minutes = intervalMinutes();
  if (minutes <= 0 || !listConfigured().some(isManaged)) {
    return;
  }
  const every = Math.max(5, minutes);
  timer = setInterval(() => timedSync(every * 60000), every * 60000);
}

function readState(stateFile) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return null; // none yet
  }
}

// A timed sync leaves out a repository another window synced less than half an interval ago (one fetch per interval,
// not one per window); the other window's state write reaches this window through the state/ watcher.
function timedSync(intervalMs) {
  const keys = new Set(
    listConfigured()
      .filter(isManaged)
      .filter((d) => !sync.recentlySynced(readState(d.stateFile), intervalMs))
      .map((d) => d.key),
  );
  if (keys.size === 0) {
    log('timed sync skipped: other windows synced every repository recently');
    return;
  }
  refresh({ sync: true, keys });
}

function debouncedApply() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    apply();
  }, 1000);
}

// .git changes (fetch, the editor's own git status) don't change plugin files
function isGitPath(fsPath) {
  return /[\\/]\.git([\\/]|$)/.test(fsPath);
}

function stopWatchers() {
  for (const w of watchers) {
    w.dispose();
  }
  watchers = [];
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

function readStateFile(d) {
  const state = readState(d.stateFile);
  if (state && state.kind && state.kind !== 'busy') {
    const s = stateOf(d.key);
    s.lastResult = state;
    s.lastCheck = state.at ? new Date(state.at) : s.lastCheck;
  }
}

function startWatchers() {
  stopWatchers();
  const stateDir = path.join(storage, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(stateDir), '*.json'));
  const onState = (uri) => {
    const d = listConfigured().find((x) => samePath(x.stateFile, uri.fsPath));
    if (d && !stateOf(d.key).syncing) {
      readStateFile(d);
      debouncedApply();
    }
  };
  w.onDidCreate(onState);
  w.onDidChange(onState);
  watchers.push(w);

  // what the user has seen: another window marking items seen reaches this one
  const seenDir = path.join(storage, 'seen');
  fs.mkdirSync(seenDir, { recursive: true });
  const seenWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(seenDir), '*.json'));
  seenWatcher.onDidCreate(() => debouncedApply());
  seenWatcher.onDidChange(() => debouncedApply());
  watchers.push(seenWatcher);

  // an edit inside a clone (an agent's, another window's partial copy, a direct edit) reaches this window's catalog,
  // partial copies and Local changes
  const list = listConfigured();
  for (const d of list) {
    if (!d.duplicateOf) {
      watchers.push(watchTree(d.dir, onRepoFile));
    }
  }
  draftsWatched = list.some((d) => d.kind === 'drafts');
}

// .git changes (fetch, the editor's own git status) don't change plugin files
function onRepoFile(uri) {
  if (!isGitPath(uri.fsPath)) {
    debouncedApply();
  }
}

function isDirectory(fsPath) {
  try {
    return fs.statSync(fsPath).isDirectory();
  } catch {
    return false;
  }
}

// Watches every file below dir; returns { dispose }. On a Linux remote the recursive watcher watches a new folder but
// not the subfolders it already holds when it appears (a partial copy built aside and renamed into place, `mkdir -p`):
// a new folder restarts the watcher, which then watches the whole tree as it is.
function watchTree(dir, onFile) {
  let watcher = null;
  let restartTimer = null;
  const start = () => {
    watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '**/*'));
    watcher.onDidCreate((uri) => {
      if (!restartTimer && !isGitPath(uri.fsPath) && isDirectory(uri.fsPath)) {
        restartTimer = setTimeout(() => {
          restartTimer = null;
          if (watcher) {
            watcher.dispose();
            start();
          }
        }, 300);
      }
      onFile(uri);
    });
    watcher.onDidChange(onFile);
    watcher.onDidDelete(onFile);
  };
  start();
  return {
    dispose() {
      clearTimeout(restartTimer);
      restartTimer = null;
      if (watcher) {
        watcher.dispose();
        watcher = null;
      }
    },
  };
}

// ---- activation --------------------------------------------------------------------------------------------------

// The repository a command was invoked on: a repository node, one of its groups, a change or a conflict node, or an
// object { repo: key } (what the notifications pass).
function repoFromArg(arg) {
  if (!arg) {
    return undefined;
  }
  const key = arg.kind === 'repo' ? arg.key : arg.repo;
  return key ? listConfigured().find((d) => d.key === key) : undefined;
}

// The repository a command acts on: the one it was invoked on, else the only one that passes filter, else the user's
// pick; undefined when there is none (or the pick was cancelled).
async function pickRepo(arg, { filter = () => true, placeHolder } = {}) {
  const given = repoFromArg(arg);
  if (given) {
    return given;
  }
  const list = listConfigured().filter(filter);
  if (list.length === 0) {
    return undefined;
  }
  if (list.length === 1) {
    return list[0];
  }
  const picked = await ui.showQuickPick(
    list.map((d) => ({ label: labelOf(d), description: d.source, d })),
    { placeHolder },
  );
  return picked ? picked.d : undefined;
}

// A managed clone with local changes, or whose changes could not be read (the commands then say why).
function hasWork(d) {
  const s = stateOf(d.key);
  return isManaged(d) && (hasChanges(s) || !!(s.changes && s.changes.error));
}

// The user-level value of a list setting, kept as it is written.
function globalList(config, key) {
  const inspected = config.inspect(key);
  return Array.isArray(inspected && inspected.globalValue) ? [...inspected.globalValue] : [];
}

async function addRepositoryEntry({ url, branch }) {
  const config = cfg();
  const normalized = normalizeUrl(url);
  if (parseRepositories(config.get('repositories')).some((e) => normalizeUrl(e.url) === normalized)) {
    ui.showInformationMessage(`Team plugins: ${url} is already in teamPlugins.repositories.`);
    return;
  }
  const next = [...globalList(config, 'repositories'), branch ? { url, branch } : { url }];
  await config.update('repositories', next, vscode.ConfigurationTarget.Global);
}

async function addLocalRepositoryCommand() {
  const picked = await ui.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
  if (!picked || picked.length === 0) {
    return;
  }
  const folder = picked[0].fsPath;
  const config = cfg();
  const normalized = normalizeUrl(folder);
  if (parseLocalRepositories(config.get('localRepositories')).some((p) => normalizeUrl(p) === normalized)) {
    ui.showInformationMessage(`Team plugins: ${folder} is already in teamPlugins.localRepositories.`);
    return;
  }
  await config.update(
    'localRepositories',
    [...globalList(config, 'localRepositories'), folder],
    vscode.ConfigurationTarget.Global,
  );
}

async function removeRepositoryCommand(arg) {
  const d = await pickRepo(arg, { filter: (x) => x.kind !== 'drafts', placeHolder: 'Repository to stop following' });
  if (!d || d.kind === 'drafts') {
    return;
  }
  const detail =
    d.kind === 'managed'
      ? `Its plugins are unregistered. Its clone stays in ${d.dir}${hasChanges(stateOf(d.key)) ? ', with your local changes' : ''}.`
      : 'Its plugins are unregistered. Your clone is not touched.';
  const choice = await ui.showWarningMessage(`Stop following ${labelOf(d)}?`, { modal: true, detail }, 'Remove');
  if (choice !== 'Remove') {
    return;
  }
  const key = d.kind === 'managed' ? 'repositories' : 'localRepositories';
  const config = cfg();
  const list = globalList(config, key);
  const urlOf = (item) => (typeof item === 'string' ? item : item && typeof item.url === 'string' ? item.url : '');
  const matches = (item) => urlOf(item).trim() !== '' && normalizeUrl(urlOf(item)) === d.normalized;
  let next;
  if (d.duplicateOf) {
    // the entry that is listed twice: the later one goes, the first keeps following
    let last = -1;
    list.forEach((item, i) => {
      if (matches(item)) {
        last = i;
      }
    });
    next = list.filter((_item, i) => i !== last);
  } else {
    next = list.filter((item) => !matches(item));
  }
  await config.update(key, next, vscode.ConfigurationTarget.Global);
}

// ---- writing plugins: new plugin, new items, drafts ---------------------------------------------------------------

// The repositories a plugin can be written in: loaded, and on disk (a managed clone not cloned yet is left out).
function authoringTargets() {
  return descs.filter((d) => isActive(d) && d.kind !== 'drafts' && fs.existsSync(d.dir));
}

function targetPickItem(d) {
  return {
    label: labelOf(d),
    description: d.kind === 'managed' ? 'team repository: a local change until you commit and push it' : 'your own clone',
    d,
  };
}

// Runs fn under the repository's lock (call it inside enqueue); null, with a warning, when another window holds it.
function withRepoLock(d, fn) {
  const locked = sync.withLockSync(d.lockFile, fn);
  if (locked.kind === 'busy') {
    ui.showWarningMessage(BUSY_TEXT);
    return null;
  }
  return locked.value;
}

// Call inside enqueue: unregister before a synchronous write to a folder Cursor watches. Apply again if it throws.
async function withPluginUnregistered(name, fn) {
  if (!registrar || !registrar.current.has(name)) {
    return fn();
  }
  await registrar.remove(name);
  try {
    return fn();
  } catch (err) {
    await doApply().catch((applyErr) => log(`cannot restore registrations: ${applyErr.message}`));
    throw err;
  }
}

// Adds a plugin or item that was just written (and is in the catalog after an apply) to the user's selection, unless
// the selection already includes it.
async function enableNew(id) {
  const owner = catalog.plugins.find((p) => p.name === id || p.children.some((c) => c.id === id));
  if (!owner) {
    log(`new item not in the catalog yet: ${id}`);
    return;
  }
  const user = userSelection();
  const e = selection.effective(catalog, user, projectList()).get(owner.name);
  if (e && (owner.name === id ? e.full : e.included.has(id))) {
    return;
  }
  const next = selection.toggle(catalog, user, id, true);
  const config = cfg();
  for (const key of ['enabled', 'excluded']) {
    if (JSON.stringify(next[key]) !== JSON.stringify(user[key])) {
      await config.update(key, next[key], vscode.ConfigurationTarget.Global);
    }
  }
}

// Asks where and how to name a new plugin and creates it: { repo, pluginName, dir } (repo: the label, 'drafts' for the
// drafts), or null when cancelled, busy or failed.
async function createPluginFlow(arg) {
  let target = null; // a descriptor, or null for the drafts
  if (arg && arg.kind === 'repo') {
    const given = repoFromArg(arg);
    if (!given) {
      return null;
    }
    if (given.kind !== 'drafts') {
      target = authoringTargets().find((d) => d.key === given.key);
      if (!target) {
        ui.showInformationMessage(
          `Team plugins: ${labelOf(given)} is not available yet (not cloned, listed twice or replaced).`,
        );
        return null;
      }
    }
  } else {
    const picked = await ui.showQuickPick(
      [
        { label: 'drafts', description: 'only on this machine: move it to a repository when it is ready', d: null },
        ...authoringTargets().map(targetPickItem),
      ],
      { placeHolder: 'Where to create the plugin' },
    );
    if (!picked) {
      return null;
    }
    target = picked.d;
  }
  const name = await ui.showInputBox({
    prompt: 'Plugin name',
    placeHolder: 'my-plugin',
    ignoreFocusOut: true,
    validateInput: (v) => authoring.nameError(v.trim()) || null,
  });
  if (name === undefined) {
    return null;
  }
  const description = await ui.showInputBox({ prompt: 'Plugin description (optional)', ignoreFocusOut: true });
  if (description === undefined) {
    return null;
  }
  const { draftsRoot } = paths();
  const draftsDesc = descs.find((d) => d.kind === 'drafts');
  const lock = target ? target.lockFile : draftsDesc ? draftsDesc.lockFile : path.join(storage, 'locks', 'drafts.lock');
  const result = await enqueue(() => {
    if (!target) {
      fs.mkdirSync(draftsRoot, { recursive: true });
    }
    return withRepoLock({ lockFile: lock }, () =>
      authoring.createPlugin(target ? target.dir : draftsRoot, { name: name.trim(), description }),
    );
  });
  if (!result) {
    return null;
  }
  if (result.error) {
    ui.showErrorMessage(`Team plugins: ${result.error}`);
    return null;
  }
  const repo = target ? labelOf(target) : 'drafts';
  const pluginName = name.trim();
  log(`created plugin ${repo}:${pluginName} in ${result.dir}`);
  return { repo, pluginName, dir: result.dir };
}

async function newPluginCommand(arg) {
  const created = await createPluginFlow(arg);
  if (!created) {
    return;
  }
  const { repo, pluginName, dir } = created;
  await apply();
  await enableNew(`${repo}:${pluginName}`);
  await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, '.cursor-plugin', 'plugin.json')));
  ui
    .showInformationMessage(
      `Created plugin ${pluginName} in ${repo}. Add a skill, rule, command, agent or MCP server from its context menu.`,
      'New skill',
    )
    .then((choice) =>
      choice === 'New skill'
        ? vscode.commands.executeCommand('teamPlugins.newSkill', { kind: 'plugin', key: `${repo}:${pluginName}` })
        : undefined,
    )
    .then(undefined, (err) => log(`cannot offer a new skill: ${err.message}`));
}

async function newItemCommand(kind, node) {
  const K = authoring.KINDS[kind];
  let plugin;
  if (node && node.kind === 'plugin') {
    plugin = catalog.plugins.find((p) => p.name === node.key);
  } else {
    if (catalog.plugins.length === 0) {
      ui.showInformationMessage('No plugin to add it to: create one with New plugin.');
      return;
    }
    const picked = await ui.showQuickPick(
      catalog.plugins.map((p) => ({ label: p.name, description: p.description, p })),
      { placeHolder: `Plugin to add the ${K.label} to` },
    );
    plugin = picked ? picked.p : undefined;
  }
  if (!plugin) {
    return;
  }
  const declared = authoring.declaredPathsError(plugin, kind);
  if (declared) {
    ui.showErrorMessage(`Team plugins: ${declared}`);
    return;
  }
  const repo = descs.find((d) => d.key === plugin.repoKey);
  if (!repo) {
    return;
  }
  const name = await ui.showInputBox({
    prompt: `${K.label.charAt(0).toUpperCase()}${K.label.slice(1)} name`,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      const bad = kind === 'mcp' ? authoring.serverNameError(t) : authoring.nameError(t);
      if (bad) {
        return bad;
      }
      return plugin.children.some((c) => c.kind === kind && c.name === t)
        ? `${plugin.pluginName} already has a ${K.label} named ${t}`
        : null;
    },
  });
  if (name === undefined) {
    return;
  }
  let description = '';
  let entry = null;
  if (kind === 'mcp') {
    const how = await ui.showQuickPick(
      [
        { label: 'Command', description: 'a program the agent starts (stdio)' },
        { label: 'URL', description: 'a server already running (HTTP)' },
      ],
      { placeHolder: 'How the MCP server runs' },
    );
    if (!how) {
      return;
    }
    if (how.label === 'Command') {
      const command = await ui.showInputBox({
        prompt: 'Command line, for example: npx -y my-mcp-server',
        ignoreFocusOut: true,
        validateInput: (v) => {
          const parts = authoring.splitCommandLine(v);
          return parts === null ? 'Close the double quote' : parts.length === 0 ? 'Enter a command' : null;
        },
      });
      if (command === undefined) {
        return;
      }
      entry = authoring.mcpEntry({ command });
    } else {
      const url = await ui.showInputBox({
        prompt: 'Server URL',
        ignoreFocusOut: true,
        validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? null : 'Enter an http:// or https:// URL'),
      });
      if (url === undefined) {
        return;
      }
      entry = authoring.mcpEntry({ url: url.trim() });
    }
  } else {
    const typed = await ui.showInputBox({
      prompt: `What the ${K.label} is for (shown to the agent and in the view)`,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Enter a description'),
    });
    if (typed === undefined) {
      return;
    }
    description = typed.trim();
  }
  const itemName = name.trim();
  const result = await enqueue(() =>
    withRepoLock(repo, () =>
      kind === 'mcp'
        ? authoring.addMcpServer(plugin.dir, itemName, entry, repo.dir)
        : authoring.createItem(plugin.dir, kind, itemName, description, repo.dir),
    ),
  );
  if (!result) {
    return;
  }
  if (result.error) {
    ui.showErrorMessage(`Team plugins: ${result.error}`);
    return;
  }
  await apply();
  let id = null;
  if (kind === 'mcp') {
    id = `${plugin.name}/mcp/${itemName}`;
  } else {
    const fresh = catalog.plugins.find((p) => p.name === plugin.name);
    const child = fresh && fresh.children.find((c) => samePath(c.file, result.file));
    id = child ? child.id : null;
  }
  log(`created ${K.label} ${id || itemName} in ${result.file}`);
  if (id) {
    await enableNew(id);
  }
  await vscode.window.showTextDocument(vscode.Uri.file(result.file));
}

// After the plugin or item `from` became `to` (ids with the repository name), the user's own lists follow it.
async function renameUserIds(from, to) {
  const config = cfg();
  for (const key of ['enabled', 'excluded']) {
    const current = stringList(config.get(key));
    const next = authoring.renameIds(current, from, to);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await config.update(key, next, vscode.ConfigurationTarget.Global);
    }
  }
}

async function moveDraftCommand(node) {
  const isDraft = (p) => descs.some((d) => d.key === p.repoKey && d.kind === 'drafts');
  let plugin;
  if (node && node.kind === 'plugin') {
    plugin = catalog.plugins.find((p) => p.name === node.key);
    if (plugin && !isDraft(plugin)) {
      plugin = undefined;
    }
  } else {
    const drafts = catalog.plugins.filter(isDraft);
    if (drafts.length === 0) {
      ui.showInformationMessage('There is no draft plugin: create one with New plugin.');
      return;
    }
    const picked = await ui.showQuickPick(
      drafts.map((p) => ({ label: p.pluginName, description: p.description, p })),
      { placeHolder: 'Draft plugin to move' },
    );
    plugin = picked ? picked.p : undefined;
  }
  if (!plugin) {
    return;
  }
  const targets = authoringTargets();
  if (targets.length === 0) {
    ui.showInformationMessage('Follow a repository or add your own clone first.');
    return;
  }
  const picked = await ui.showQuickPick(targets.map(targetPickItem), {
    placeHolder: `Repository to move ${plugin.pluginName} to`,
  });
  if (!picked) {
    return;
  }
  const target = picked.d;
  const detail =
    target.kind === 'managed'
      ? 'The draft is deleted. In the managed clone the plugin is a local change: commit and push it to share it with the team.'
      : 'The draft is deleted. The plugin is copied into your clone: commit and push it with your own git tools.';
  const choice = await ui.showWarningMessage(
    `Move ${plugin.pluginName} to ${labelOf(target)}?`,
    { modal: true, detail },
    'Move',
  );
  if (choice !== 'Move') {
    return;
  }
  await flushPartials();
  const draftsDesc = descs.find((d) => d.key === plugin.repoKey);
  const result = await enqueue(() =>
    withPluginUnregistered(plugin.name, () =>
      withRepoLock(target, () => {
        const locked = sync.withLockSync(draftsDesc.lockFile, () =>
          authoring.movePlugin(plugin.dir, plugin.pluginName, plugin.description, target.dir),
        );
        if (locked.kind === 'busy') {
          ui.showWarningMessage(BUSY_TEXT);
          return null;
        }
        if (!locked.value.error) {
          partialCopies.delete(plugin.name); // its copy must not carry its files back into the deleted draft
        }
        return locked.value;
      }),
    ),
  );
  if (!result || result.error) {
    if (result) {
      ui.showErrorMessage(`Team plugins: ${result.error}`);
    }
    await apply(); // the draft was unregistered above
    return;
  }
  const to = `${labelOf(target)}:${plugin.pluginName}`;
  await renameUserIds(plugin.name, to);
  await apply();
  log(`moved draft ${plugin.pluginName} to ${labelOf(target)} (${result.dir})`);
  if (result.leftover) {
    ui.showWarningMessage(
      `Team plugins: ${plugin.pluginName} was copied, but its draft folder could not be removed yet: ${result.leftover}. Reload the Cursor windows, then delete it if it is still there.`,
    );
  }
  if (target.kind === 'managed') {
    ui
      .showInformationMessage(
        `Moved ${plugin.pluginName} to ${labelOf(target)}: it is in the repository's Local changes. Commit and push to share it.`,
        'Commit and push',
      )
      .then((c) =>
        c === 'Commit and push' ? vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: target.key }) : undefined,
      )
      .then(undefined, (err) => log(`cannot offer commit and push: ${err.message}`));
  } else {
    ui.showInformationMessage(
      `Moved ${plugin.pluginName} to your clone ${target.dir}: commit and push it with your own git tools.`,
    );
  }
}

// Renames a plugin or an item of the tree (right-click, or F2 on the selected row): the files, the plugin.json and
// marketplace.json names, the record of the rename in the repository, then the user's own lists.
async function renameCommand(node) {
  const usable = (n) => (n && (n.kind === 'plugin' || ITEM_KINDS.includes(n.kind)) ? n : null);
  const target = usable(node) || usable(treeView && treeView.selection[0]);
  if (!target) {
    return;
  }
  let plugin;
  let child = null;
  if (target.kind === 'plugin') {
    plugin = catalog.plugins.find((p) => p.name === target.key);
  } else {
    plugin = catalog.plugins.find((p) => p.children.some((c) => c.id === target.key));
    child = plugin ? plugin.children.find((c) => c.id === target.key) : null;
  }
  const repo = plugin ? descs.find((d) => d.key === plugin.repoKey) : null;
  if (!plugin || !repo || (target.kind !== 'plugin' && !child)) {
    return;
  }
  const label = child ? authoring.KINDS[child.kind].label : 'plugin';
  const oldName = child ? child.name : plugin.pluginName;
  const typed = await ui.showInputBox({
    prompt: `New name for the ${label} ${oldName}`,
    value: oldName,
    valueSelection: [0, oldName.length],
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (t === oldName) {
        return null;
      }
      const bad = child && child.kind === 'mcp' ? authoring.serverNameError(t) : authoring.nameError(t);
      if (bad) {
        return bad;
      }
      if (!child) {
        return catalog.plugins.some((p) => p.repoKey === plugin.repoKey && p.pluginName === t)
          ? `${labelOf(repo)} already has a plugin named ${t}`
          : null;
      }
      return plugin.children.some((c) => c.kind === child.kind && c.name === t)
        ? `${plugin.pluginName} already has a ${label} named ${t}`
        : null;
    },
  });
  if (typed === undefined || typed.trim() === oldName) {
    return;
  }
  const newName = typed.trim();
  const record = repo.kind !== 'drafts';
  await flushPartials();
  const result = await enqueue(() => {
    const renameLocked = () =>
      withRepoLock(repo, () => {
        const done = child
          ? rename.renameItem(
              { pluginDir: plugin.dir, pluginName: plugin.pluginName, kind: child.kind, name: child.name, file: child.file },
              newName,
              { repoDir: repo.dir, record },
            )
          : rename.renamePlugin({ dir: plugin.dir, pluginName: plugin.pluginName }, newName, { repoDir: repo.dir, record });
        if (!child && !done.error) {
          partialCopies.delete(plugin.name); // its copy must not carry its files back into the old folder
        }
        return done;
      });
    return child ? renameLocked() : withPluginUnregistered(plugin.name, renameLocked);
  });
  if (!result || result.error) {
    if (result) {
      ui.showErrorMessage(`Team plugins: ${result.error}`);
    }
    await apply(); // a plugin was unregistered above
    return;
  }
  const from = child ? child.id : plugin.name;
  const to = `${plugin.repo}:${result.id}`;
  await renameUserIds(from, to);
  await apply();
  log(`renamed ${label} ${from} to ${to}`);
  if (repo.kind === 'managed') {
    ui
      .showInformationMessage(
        `Renamed ${oldName} to ${newName} in ${labelOf(repo)}: it is in the repository's Local changes. Commit and push to share it.`,
        'Commit and push',
      )
      .then((c) =>
        c === 'Commit and push' ? vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: repo.key }) : undefined,
      )
      .then(undefined, (err) => log(`cannot offer commit and push: ${err.message}`));
  } else if (repo.kind === 'local') {
    ui.showInformationMessage(
      `Renamed ${oldName} to ${newName} in your clone ${repo.dir}: commit and push it with your own git tools.`,
    );
  }
}

// The items of the list without the ones that share a path with an earlier one.
function uniqueBySrc(list) {
  return list.filter((it, i) => list.findIndex((o) => samePath(o.src, it.src)) === i);
}

// The rules, skills, commands and agents to share: the Explorer's selection, or a pick among the project's and the
// user's. [] when there is none or the pick was cancelled (the user was told or chose so).
async function itemsToShare(uri, uris) {
  if (uri instanceof vscode.Uri) {
    const items = [];
    for (const u of Array.isArray(uris) && uris.length > 0 ? uris : [uri]) {
      const item = share.shareableItem(u.fsPath);
      if (item) {
        // SKILL.md was clicked: the folder is shared
        items.push({ ...item, uri: samePath(item.src, u.fsPath) ? u : vscode.Uri.joinPath(u, '..') });
      }
    }
    if (items.length === 0) {
      ui.showInformationMessage('Team plugins: only a rule, skill, command or agent of a .cursor folder can be shared.');
    }
    return uniqueBySrc(items);
  }
  const folders = vscode.workspace.workspaceFolders || [];
  const all = [];
  for (const folder of folders) {
    for (const item of share.projectItems(folder.uri.fsPath)) {
      all.push({
        ...item,
        uri: vscode.Uri.joinPath(folder.uri, ...item.rel.split('/')),
        where: folders.length > 1 ? `${folder.name}/${item.rel}` : item.rel,
      });
    }
  }
  for (const item of share.projectItems(os.homedir())) {
    if (item.kind !== 'rule') {
      all.push({ ...item, uri: vscode.Uri.file(item.src), where: `personal · ~/${item.rel}` });
    }
  }
  const items = uniqueBySrc(all);
  if (items.length === 0) {
    ui.showInformationMessage(
      "Team plugins: no rule, skill, command or agent found in this project's .cursor folder or in ~/.cursor.",
    );
    return [];
  }
  const editor = vscode.window.activeTextEditor;
  const active = editor ? share.shareableItem(editor.document.uri.fsPath) : null;
  const picked = await ui.showQuickPick(
    items.map((item) => ({
      label: item.name,
      description: `${authoring.KINDS[item.kind].label} · ${item.where}`,
      picked: Boolean(active) && samePath(active.src, item.src),
      item,
    })),
    { canPickMany: true, placeHolder: 'Rules, skills, commands and agents to share' },
  );
  return picked ? picked.map((p) => p.item) : [];
}

// Share with team: copies rules, skills, commands and agents of a .cursor folder into a plugin.
async function shareCommand(uri, uris) {
  const items = await itemsToShare(uri, uris);
  if (items.length === 0) {
    return;
  }
  const dest = await ui.showQuickPick(
    [
      { label: '$(add) New plugin...', newPlugin: true },
      ...catalog.plugins.map((p) => ({ label: p.name, description: p.description, p })),
    ],
    { placeHolder: `Plugin to copy ${items.length === 1 ? items[0].name : `${items.length} items`} to` },
  );
  if (!dest) {
    return;
  }
  let plugin = dest.p;
  let isNewPlugin = false;
  if (dest.newPlugin) {
    const created = await createPluginFlow(undefined);
    if (!created) {
      return;
    }
    await apply();
    plugin = catalog.plugins.find((p) => p.name === `${created.repo}:${created.pluginName}`);
    if (!plugin) {
      ui.showErrorMessage('Team plugins: the new plugin is not in the catalog yet: try again.');
      return;
    }
    isNewPlugin = true;
  }
  for (const kind of new Set(items.map((item) => item.kind))) {
    const declared = authoring.declaredPathsError(plugin, kind);
    if (declared) {
      ui.showErrorMessage(`Team plugins: ${declared}`);
      return;
    }
  }
  const repo = descs.find((d) => d.key === plugin.repoKey);
  if (!repo) {
    return;
  }
  const chosen = new Set(); // `${kind}:${name}` of the names taken by this share
  const names = [];
  for (const item of items) {
    const label = authoring.KINDS[item.kind].label;
    const taken = (n) => chosen.has(`${item.kind}:${n}`);
    const takenText = (n) => `another item you are sharing is named ${n}`;
    let name = item.name;
    const bad = share.shareNameError(plugin.dir, item.kind, name);
    if (bad || taken(name)) {
      const typed = await ui.showInputBox({
        prompt: `Name for the ${label} ${item.name} in ${plugin.pluginName}: ${bad || takenText(name)}`,
        value: share.suggestName(item.name),
        ignoreFocusOut: true,
        validateInput: (v) => {
          const t = v.trim();
          return share.shareNameError(plugin.dir, item.kind, t) || (taken(t) ? takenText(t) : null);
        },
      });
      if (typed === undefined) {
        return;
      }
      name = typed.trim();
    }
    chosen.add(`${item.kind}:${name}`);
    names.push(name);
  }
  const results = await enqueue(() =>
    withRepoLock(repo, () => items.map((item, i) => share.shareItem(item, plugin.dir, names[i], repo.dir))),
  );
  if (!results) {
    return;
  }
  const shared = []; // { item, name, result }
  results.forEach((result, i) => {
    if (result.error) {
      ui.showErrorMessage(`Team plugins: could not share ${items[i].name}: ${result.error}`);
    } else {
      shared.push({ item: items[i], name: names[i], result });
    }
  });
  if (shared.length === 0) {
    return;
  }
  await apply();
  const fresh = catalog.plugins.find((p) => p.name === plugin.name);
  const ids = [];
  for (const { item, name, result } of shared) {
    const child = fresh && fresh.children.find((c) => samePath(c.file, result.file));
    log(`shared ${item.src} as ${child ? child.id : name} in ${result.file}`);
    if (child) {
      ids.push(child.id);
    }
  }
  if (isNewPlugin) {
    await enableNew(plugin.name);
  } else {
    for (const id of ids) {
      await enableNew(id);
    }
  }
  const skipped = shared.flatMap(({ name, result }) => result.skipped.map((rel) => `${name}/${rel}`));
  if (skipped.length > 0) {
    ui.showWarningMessage(`Team plugins: links are not copied: ${skipped.join(', ')}`);
  }
  if (shared.length === 1) {
    await vscode.window.showTextDocument(vscode.Uri.file(shared[0].result.file));
  }
  const what =
    shared.length === 1
      ? `the ${authoring.KINDS[shared[0].item.kind].label} ${shared[0].name}`
      : `${shared.length} items`;
  const remote = Boolean(vscode.env.remoteName); // a remote window's file system has no trash
  const one = shared.length === 1;
  let removeLabel = one ? 'Move the original to the trash' : 'Move the originals to the trash';
  if (remote) {
    removeLabel = one ? 'Delete the original' : 'Delete the originals';
  }
  const buttons = [];
  let text;
  if (repo.kind === 'drafts') {
    text = `Copied ${what} to the draft plugin ${plugin.pluginName}. Move the plugin to a repository when it is ready.`;
  } else if (repo.kind === 'managed') {
    text = `Copied ${what} to ${plugin.name}: it is in the repository's Local changes. Commit and push to share it with the team.`;
    buttons.push('Commit and push');
  } else {
    text = `Copied ${what} to ${plugin.name} in your clone: commit and push it with your own git tools.`;
  }
  ui
    .showInformationMessage(text, ...buttons, removeLabel)
    .then(async (choice) => {
      if (choice === 'Commit and push') {
        await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: repo.key });
      } else if (choice === removeLabel) {
        await removeOriginals(shared, plugin.name, remote);
      }
    })
    .then(undefined, (err) => log(`cannot offer the closing choices of the share: ${err.message}`));
}

// Removes the originals of shared items: to the trash, or in a remote window (no trash there) deleted for good once the
// user confirmed it in a modal dialog.
async function removeOriginals(shared, pluginName, remote) {
  if (remote) {
    const paths = shared.map(({ item }) => item.src);
    const choice = await ui.showWarningMessage(
      shared.length === 1 ? `Delete ${paths[0]} for good?` : `Delete the ${paths.length} originals for good?`,
      {
        modal: true,
        detail: `This remote window has no trash: they can't be recovered. The copies in ${pluginName} stay.\n\n${paths.join('\n')}`,
      },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }
  }
  for (const { item } of shared) {
    try {
      await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: !remote });
      log(`${remote ? 'deleted' : 'moved to the trash'}: ${item.src}`);
    } catch (err) {
      const how = remote ? 'delete' : 'move';
      ui.showErrorMessage(
        `Team plugins: could not ${how} ${item.src}${remote ? '' : ' to the trash'}: ${err.message}`,
      );
    }
  }
}

// ---- Create team repository ---------------------------------------------------------------------------------------

const NEW_REPO_CANCELLED = 'Team plugins: nothing was written.';
const PREVIEW_FILE = 'new-team-repository-preview.md';
const STAGING_STALE_MS = 24 * 60 * 60 * 1000;
const STAGING_ALIVE_MS = 60 * 1000;
const PLUGIN_WAIT_MS = 120 * 1000;
const REGISTER_WAIT_MS = 30 * 1000;
const WAIT_STEP_MS = 500;

// Shows a message nobody waits for: a notification's promise ends only when it is closed.
function notify(show, ...args) {
  Promise.resolve(ui[show](...args)).then(undefined, (err) => log(`cannot show a message: ${err.message}`));
}

function cancelNewRepo() {
  notify('showInformationMessage', NEW_REPO_CANCELLED);
  return null;
}

function realPathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// `inside` that folds case where paths do (VS Code's fsPath has a lower-case drive letter on Windows).
function insideFolded(root, p) {
  const norm = (x) => (process.platform === 'win32' ? path.resolve(x).toLowerCase() : path.resolve(x));
  return inside(norm(root), norm(p));
}

// <storage>/new-repository/<time>-<pid> with repo/, merge/ and compare/; .alive is touched every minute so that another
// window can tell a run in progress from a leftover (those are removed after 24 hours).
function makeStaging() {
  const root = path.join(storage, 'new-repository');
  fs.mkdirSync(root, { recursive: true });
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      continue;
    }
    const dir = path.join(root, e.name);
    try {
      let touched;
      try {
        touched = fs.statSync(path.join(dir, '.alive')).mtimeMs;
      } catch {
        touched = fs.statSync(dir).mtimeMs;
      }
      if (Date.now() - touched > STAGING_STALE_MS) {
        sync.removeTree(dir);
      }
    } catch {
      // not ours to clean up now: the next run tries again
    }
  }
  const dir = path.join(root, `${Date.now()}-${process.pid}`);
  for (const name of ['repo', 'merge', 'compare']) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
  }
  const alive = path.join(dir, '.alive');
  fs.writeFileSync(alive, '');
  const timer = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(alive, now, now);
    } catch {
      // the folder is gone: nothing to keep alive
    }
  }, STAGING_ALIVE_MS);
  return { dir, stop: () => clearInterval(timer) };
}

// Closes the scratch tabs of a run: the text and diff tabs that show a file of the staging folder (unless unsaved) and
// the preview.
async function closeScratchTabs(staging) {
  try {
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((tab) => {
      if (tab.isDirty) {
        return false;
      }
      if (tab.label.includes(PREVIEW_FILE)) {
        return true;
      }
      const input = tab.input;
      let uris = [];
      if (input instanceof vscode.TabInputText) {
        uris = [input.uri];
      } else if (input instanceof vscode.TabInputTextDiff) {
        uris = [input.original, input.modified];
      }
      return uris.some((u) => u.scheme === READONLY_SCHEME || (u.scheme === 'file' && insideFolded(staging, u.fsPath)));
    });
    if (tabs.length > 0) {
      await vscode.window.tabGroups.close(tabs);
    }
  } catch (err) {
    log(`cannot close the scratch tabs: ${err.message}`);
  }
}

// The folders to scan: [{ label, root, uri, personal }] or null (cancelled or nothing picked).
async function pickNewRepoSources() {
  const folders = vscode.workspace.workspaceFolders || [];
  const items = [
    ...folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, picked: true, folder })),
    { label: '~/.cursor', description: 'your personal skills, commands, agents and MCP servers', picked: true, personal: true },
    { label: '$(folder-opened) Other folders...', description: 'project folders that are not open', picked: false, other: true },
  ];
  const picked = await ui.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    placeHolder: 'Where to look for rules, skills, commands, agents and MCP servers',
  });
  if (!picked || picked.length === 0) {
    return null;
  }
  const found = [];
  for (const p of picked) {
    if (p.folder) {
      found.push({ label: p.label, root: p.folder.uri.fsPath, uri: p.folder.uri, personal: false });
    } else if (p.personal) {
      found.push({ label: '~/.cursor', root: os.homedir(), uri: vscode.Uri.file(os.homedir()), personal: true });
    }
  }
  if (picked.some((p) => p.other)) {
    const dirs = await ui.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: true,
      openLabel: 'Scan',
      title: 'Project folders to scan',
    });
    for (const uri of dirs || []) {
      found.push({ label: path.basename(uri.fsPath), root: uri.fsPath, uri, personal: false });
    }
  }
  const sources = [];
  for (const s of found) {
    const real = realPathOr(s.root);
    if (!sources.some((o) => samePath(o.real, real))) {
      sources.push({ ...s, real });
    }
  }
  const counts = new Map();
  for (const s of sources) {
    const count = (counts.get(s.label) || 0) + 1;
    counts.set(s.label, count);
    if (count > 1) {
      s.label = `${s.label} (${count})`;
    }
  }
  return sources.length > 0 ? sources : null;
}

const capitalized = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function groupPickItem(group) {
  const n = group.references.length;
  const status = {
    single: group.copies[0].where,
    identical: `identical in ${group.copies.length} places`,
    variants: `${group.versions.length} versions: you pick one next`,
  }[group.status];
  const description =
    `${authoring.KINDS[group.kind].label} · ${status}` +
    (group.suspects.length > 0 ? ' · may contain a secret' : '') +
    (n > 0 ? ` · ${n} reference${n === 1 ? '' : 's'} may break` : '');
  return { label: group.name, description, picked: group.suspects.length === 0, group };
}

function versionDescription(group, version) {
  const copy = version[0];
  const age = updates.ago(copy.mtimeMs, Date.now());
  return group.kind === 'mcp' ? age : `${copy.lines} lines · ${age}`;
}

function writeScratch(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return vscode.Uri.file(file);
}

// A read-only view of a file for the compare and merge diffs: an original must never be edited by mistake there (hand
// check, request 26: an edit typed in the wrong pane never reached the merge). Served by the READONLY_SCHEME provider,
// only for the files registered here during a run.
const READONLY_SCHEME = 'team-plugins-readonly';
const readonlyFiles = new Set();

function readonlyUri(file) {
  const full = path.resolve(file);
  readonlyFiles.add(full);
  // the path keeps the file's name (tab title, language); the query says which file it is
  return vscode.Uri.from({ scheme: READONLY_SCHEME, path: `/${path.basename(full)}`, query: encodeURIComponent(full) });
}

// The file a skill's version holds at `rel` (read-only unless `editable`), or the empty scratch file.
function skillSide(staging, dir, rel, editable = false) {
  const file = path.join(dir, ...rel.split('/'));
  if (!fs.existsSync(file)) {
    return readonlyUri(path.join(staging, 'compare', 'empty'));
  }
  return editable ? vscode.Uri.file(file) : readonlyUri(file);
}

async function pickVersion(group, placeHolder, exclude) {
  const items = group.versions.map((v, i) => ({ label: v[0].where, version: i })).filter((i) => i.version !== exclude);
  const picked = await ui.showQuickPick(items, { placeHolder });
  return picked ? picked.version : undefined;
}

// Opens Cursor's diff editor for two versions of a group; false when the user backed out.
async function compareVersions(group, g, staging) {
  let a = 0;
  let b = 1;
  if (group.versions.length > 2) {
    a = await pickVersion(group, 'Left side of the diff');
    if (a === undefined) {
      return false;
    }
    b = await pickVersion(group, 'Right side of the diff', a);
    if (b === undefined) {
      return false;
    }
  }
  const left = group.versions[a][0];
  const right = group.versions[b][0];
  let leftUri;
  let rightUri;
  if (group.kind === 'mcp') {
    leftUri = readonlyUri(writeScratch(path.join(staging, 'compare', `${g}-${a}.json`), `${JSON.stringify(left.entry, null, 2)}\n`).fsPath);
    rightUri = readonlyUri(writeScratch(path.join(staging, 'compare', `${g}-${b}.json`), `${JSON.stringify(right.entry, null, 2)}\n`).fsPath);
  } else if (group.kind === 'skill') {
    const rels = newRepo.skillDiff(left.src, right.src);
    let rel = rels[0] || 'SKILL.md';
    if (rels.length > 1) {
      const picked = await ui.showQuickPick(
        rels.map((label) => ({ label })),
        { placeHolder: 'File of the skill to compare' },
      );
      if (!picked) {
        return false;
      }
      rel = picked.label;
    }
    leftUri = skillSide(staging, left.src, rel);
    rightUri = skillSide(staging, right.src, rel);
  } else {
    leftUri = readonlyUri(left.src);
    rightUri = readonlyUri(right.src);
  }
  await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${group.name}: ${left.where} ↔ ${right.where}`);
  // the choices come back only when the user asks: reopened at once, the pick would cover the top of the diff
  await ui.showInformationMessage(
    `Comparing the ${authoring.KINDS[group.kind].label} ${group.name}: ${left.where} ↔ ${right.where}. Back to the choices when you are done.`,
    'Back to the choices',
  );
  return true;
}

// Lets the user merge the versions of a group by hand in a scratch copy: a choice { kind: 'merged', ... }, or null
// when they went back.
async function mergeByHand(group, g, staging) {
  const start = await pickVersion(group, 'Version to start from');
  if (start === undefined) {
    return null;
  }
  const label = authoring.KINDS[group.kind].label;
  const dir = path.join(staging, 'merge', String(g));
  sync.removeTree(dir);
  fs.mkdirSync(dir, { recursive: true });
  const base = group.versions[start][0];
  let mergeFile;
  if (group.kind === 'skill') {
    fs.cpSync(fs.realpathSync(base.src), dir, { recursive: true, filter: (s) => !fs.lstatSync(s).isSymbolicLink() });
    mergeFile = path.join(dir, 'SKILL.md');
  } else if (group.kind === 'mcp') {
    mergeFile = path.join(dir, 'server.json');
    fs.writeFileSync(mergeFile, `${JSON.stringify(base.entry, null, 2)}\n`);
  } else {
    mergeFile = path.join(dir, `item${base.ext}`);
    fs.copyFileSync(base.src, mergeFile);
  }
  let tabs = 0;
  const placeholders = []; // empty files in the merge folder for what only another version has; dropped at Done if still empty
  for (let i = 0; i < group.versions.length; i++) {
    if (i === start) {
      continue;
    }
    const other = group.versions[i][0];
    const title = `${group.name}: ${other.where} ↔ your merge (edit this side)`;
    if (group.kind === 'skill') {
      for (const rel of newRepo.skillDiff(other.src, dir)) {
        if (tabs++ < 10) {
          const target = path.join(dir, ...rel.split('/'));
          if (!fs.existsSync(target)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, '');
            placeholders.push(target);
          }
          await vscode.commands.executeCommand(
            'vscode.diff',
            skillSide(staging, other.src, rel),
            skillSide(staging, dir, rel, true),
            `${title} (${rel})`,
          );
        }
      }
    } else if (group.kind === 'mcp') {
      const scratch = writeScratch(path.join(staging, 'compare', `${g}-${i}.json`), `${JSON.stringify(other.entry, null, 2)}\n`);
      await vscode.commands.executeCommand('vscode.diff', readonlyUri(scratch.fsPath), vscode.Uri.file(mergeFile), title);
    } else {
      await vscode.commands.executeCommand('vscode.diff', readonlyUri(other.src), vscode.Uri.file(mergeFile), title);
    }
  }
  // whether the merge still is the starting version (empty placeholders aside)
  const sameAsBase = () => {
    if (group.kind === 'skill') {
      const mine = newRepo
        .skillFiles(dir)
        .filter((f) => !(placeholders.includes(f.full) && fs.statSync(f.full).size === 0));
      const theirs = newRepo.skillFiles(base.src);
      return (
        mine.length === theirs.length &&
        mine.every((f, i) => f.rel === theirs[i].rel && fs.readFileSync(f.full).equals(fs.readFileSync(theirs[i].full)))
      );
    }
    if (group.kind === 'mcp') {
      try {
        return newRepo.canonicalJson(checks.parseJsonc(fs.readFileSync(mergeFile, 'utf8'))) === newRepo.canonicalJson(base.entry);
      } catch {
        return false;
      }
    }
    return fs.readFileSync(mergeFile).equals(fs.readFileSync(base.src));
  };
  for (;;) {
    const choice = await ui.showInformationMessage(
      `Merging the ${label} ${group.name}: edit the right side of the diff (${mergeFile}), save it, then press Done.`,
      'Done',
      'Back',
    );
    if (choice !== 'Done') {
      sync.removeTree(dir);
      return null;
    }
    const unsaved = vscode.workspace.textDocuments.find(
      (d) => d.isDirty && d.uri.scheme === 'file' && insideFolded(dir, d.uri.fsPath),
    );
    if (unsaved) {
      notify('showWarningMessage', `Team plugins: save ${unsaved.uri.fsPath} first.`);
      continue;
    }
    if (sameAsBase()) {
      const keep = await ui.showWarningMessage(
        `Team plugins: your merge of the ${label} ${group.name} is still the ${base.where} version. Use it as is?`,
        { modal: true, detail: `Edit the right side of the diff (your merge), save it, then press Done again.` },
        'Use it as is',
        'Back to editing',
      );
      if (keep !== 'Use it as is') {
        continue;
      }
    }
    if (group.kind === 'mcp') {
      let parsed = null;
      try {
        parsed = checks.parseJsonc(fs.readFileSync(mergeFile, 'utf8'));
      } catch {
        // reported below, without the parser's words (they quote the text)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        notify('showErrorMessage', 'Team plugins: the merged MCP server is not a valid JSON object.');
        continue;
      }
      const redacted = newRepo.redactServer(group.name, parsed);
      group.replaced.push(...redacted.replaced.map((r) => ({ where: 'your merge', field: r.where, variable: r.variable })));
      group.suspects.push(...redacted.suspects.map((text) => ({ where: 'your merge', text })));
      return { kind: 'merged', src: redacted.entry, replaced: redacted.replaced };
    }
    for (const p of placeholders) {
      try {
        if (fs.statSync(p).size === 0) {
          fs.unlinkSync(p); // not filled in: the merge doesn't take that file
        }
      } catch {
        // already gone
      }
    }
    for (const text of newRepo.itemSuspects({ kind: group.kind, src: group.kind === 'skill' ? dir : mergeFile })) {
      group.suspects.push({ where: 'your merge', text });
    }
    return {
      kind: 'merged',
      src: group.kind === 'skill' ? dir : mergeFile,
      ext: group.kind === 'skill' ? '' : base.ext,
      originalName: base.originalName,
    };
  }
}

// What to do with a group that has several versions: a choice, or undefined when the user cancelled the command.
async function decideVariant(group, g, staging, taken) {
  const label = authoring.KINDS[group.kind].label;
  const reserved = taken.get(group.kind);
  for (;;) {
    const names = newRepo.splitNames(group, reserved);
    const items = [
      ...group.versions.map((v, i) => ({
        label: `$(check) Use ${v[0].where}`,
        description: versionDescription(group, v),
        detail: v.length > 1 ? `same as ${v.slice(1).map((c) => c.where).join(', ')}` : undefined,
        version: i,
      })),
      { label: '$(diff) Compare...', compare: true },
      { label: '$(edit) Merge by hand...', merge: true },
      { label: '$(split) Keep each under its own name', description: names.join(', '), split: true },
      { label: '$(close) Leave out', out: true },
    ];
    const pick = await ui.showQuickPick(items, {
      ignoreFocusOut: true,
      placeHolder: `${capitalized(label)} ${group.name}: ${group.versions.length} versions. Which one goes in the team repository?`,
    });
    if (!pick) {
      return undefined;
    }
    if (pick.version !== undefined) {
      reserved.add(group.name);
      return { kind: 'use', version: pick.version };
    }
    if (pick.split) {
      for (const name of names) {
        reserved.add(name);
      }
      return { kind: 'split', names };
    }
    if (pick.out) {
      return { kind: 'out' };
    }
    if (pick.compare) {
      await compareVersions(group, g, staging);
    } else if (pick.merge) {
      const merged = await mergeByHand(group, g, staging);
      if (merged) {
        reserved.add(group.name);
        return merged;
      }
    }
  }
}

// The error message of a remote check or push with its buttons: 'change', 'again' (the terminal was opened) or 'stop'.
async function showNewRepoError(result, url, { change = false, retry = false } = {}) {
  const terminal = (result.actions || []).includes('terminal') ? [ACTIONS.terminal.label] : [];
  const buttons = [...(retry ? ['Try again'] : []), ...(change ? ['Change URL'] : []), ...terminal, 'Show log'];
  const choice = await ui.showErrorMessage(`Team plugins: ${result.message}`, ...buttons);
  if (choice === 'Try again') {
    return 'retry';
  }
  if (choice === 'Change URL') {
    return 'change';
  }
  if (choice === ACTIONS.terminal.label) {
    openGitTerminal(url);
    return 'again';
  }
  if (choice === 'Show log') {
    output.show();
  }
  return 'stop';
}

// Asks for the URL of the empty repository until one answers as empty: the URL, or null (cancelled, or stopped).
async function askNewRepoUrl(git) {
  let previous = '';
  const configured = () => parseRepositories(cfg().get('repositories')).map((e) => normalizeUrl(e.url));
  for (;;) {
    const typed = await ui.showInputBox({
      prompt: 'Git URL of an empty repository for the team (create it on your Git host first)',
      placeHolder: 'https://github.com/your-org/team-plugins.git',
      value: previous,
      ignoreFocusOut: true,
      validateInput: (v) =>
        newRepo.urlError(v) ||
        (configured().includes(normalizeUrl(newRepo.destination(v))) ? `${v.trim()} is already in teamPlugins.repositories` : null),
    });
    if (typed === undefined) {
      return { cancelled: true };
    }
    previous = typed.trim();
    const url = newRepo.destination(typed);
    for (;;) {
      const result = await newRepo.checkEmptyRemote({ run: git, cwd: storage, url, idleMs: sync.CHECK_IDLE_MS });
      if (result.kind === 'empty') {
        return { url };
      }
      const next = await showNewRepoError(result, url, { change: true });
      if (next === 'change') {
        break;
      }
      if (next === 'stop') {
        return { stopped: true };
      }
    }
  }
}

function countsText(items, servers) {
  const counts = [];
  for (const kind of ['skill', 'rule', 'command', 'agent']) {
    const k = items.filter((i) => i.kind === kind).length;
    if (k > 0) {
      counts.push(`${k} ${authoring.KINDS[kind].label}${k === 1 ? '' : 's'}`);
    }
  }
  if (servers.length > 0) {
    counts.push(`${servers.length} ${authoring.KINDS.mcp.label}${servers.length === 1 ? '' : 's'}`);
  }
  return counts.join(', ');
}

// The groups whose imported copy Cursor would drop: a file of it (or of its skill folder) has an error-level problem.
function droppedGroups(plan, pluginDir, problems) {
  const files = problems.filter((p) => p.severity === 'error' && p.file).map((p) => p.file);
  const dropped = new Set();
  const itemOf = new Map(plan.items.map((i) => [`${i.kind}:${i.name}`, i]));
  for (const entry of plan.imported) {
    const kind = entry.group.kind;
    if (kind === 'mcp') {
      if (files.some((f) => samePath(f, path.join(pluginDir, 'mcp.json')))) {
        dropped.add(entry.group.id);
      }
      continue;
    }
    const item = itemOf.get(`${kind}:${entry.name}`);
    const target = path.join(pluginDir, authoring.KINDS[kind].folder, kind === 'skill' ? entry.name : entry.name + item.ext);
    if (files.some((f) => (kind === 'skill' ? insideFolded(target, f) : samePath(f, target)))) {
      dropped.add(entry.group.id);
    }
  }
  return dropped;
}

// The lines of the confirmation dialog (those with a zero count are left out).
function confirmDetail({ pluginName, plan, skipped, problems, repoDir, branch, url }) {
  const lines = [];
  const total = plan.items.length + plan.servers.length;
  lines.push(`The plugin ${pluginName} with ${total} item${total === 1 ? '' : 's'}: ${countsText(plan.items, plan.servers)}.`);
  const replaced = plan.imported.flatMap((e) => e.variables);
  if (replaced.length > 0) {
    const variables = [...new Set(replaced)].join(', ');
    lines.push(`${replaced.length} secret value${replaced.length === 1 ? '' : 's'} replaced by environment variables: ${variables}.`);
  }
  const suspects = [...new Set(plan.imported.filter((e) => e.group.suspects.length > 0).map((e) => e.name))];
  if (suspects.length > 0) {
    lines.push(`${suspects.length} item${suspects.length === 1 ? '' : 's'} may contain a secret: ${suspects.join(', ')}.`);
  }
  const references = [...new Set(plan.imported.map((e) => e.group))].reduce((sum, g) => sum + g.references.length, 0);
  if (references > 0) {
    lines.push(`${references} reference${references === 1 ? '' : 's'} may break (see the preview).`);
  }
  if (skipped.length > 0) {
    lines.push(`Links left out of skills: ${skipped.join(', ')}.`);
  }
  if (problems.length > 0) {
    const errors = problems.filter((p) => p.severity === 'error').length;
    const first = problems.slice(0, 5).map((p) => {
      const rel = p.file ? path.relative(repoDir, p.file).split(path.sep).join('/') : '';
      return `${rel}:${p.line} ${p.message}`;
    });
    lines.push(
      `${problems.length} problem${problems.length === 1 ? '' : 's'} Cursor would report, ${errors} that make it drop an item: ${first.join('; ')}.`,
    );
  }
  lines.push(`The branch ${branch} is pushed to ${url}, then the repository is added to the ones you follow.`);
  return lines.join('\n');
}

// The Create team repository command. Returns the promise of the closing message (and of Replace the originals).
async function createTeamRepositoryCommand() {
  const run = makeGit(gitPath());
  const ready = await newRepo.gitReady({ run, cwd: storage });
  if (!ready.ok) {
    notify('showErrorMessage', `Team plugins: ${ready.message}`);
    return undefined;
  }
  const staging = makeStaging();
  let closing = null;
  try {
    closing = await createRepositoryFlow(staging.dir, sync.logged(run, log));
  } finally {
    staging.stop();
    await closeScratchTabs(staging.dir);
    readonlyFiles.clear();
    try {
      sync.removeTree(staging.dir);
    } catch (err) {
      log(`cannot remove ${staging.dir}: ${err.message}`);
    }
  }
  return closing ? closing() : undefined;
}

// Steps 3 to 18: asks, builds, pushes and follows the repository. Returns null (nothing more to do) or a function that
// shows the closing message once the staging folder is gone.
async function createRepositoryFlow(staging, git) {
  const sources = await pickNewRepoSources();
  if (!sources) {
    return cancelNewRepo();
  }
  const { groups, errors } = newRepo.scan(sources);
  for (const e of errors) {
    log(`not read: ${e.file}: ${e.message}`);
  }
  if (groups.length === 0) {
    notify(
      'showInformationMessage',
      `Team plugins: no rule, skill, command, agent or MCP server found in ${sources.map((s) => s.label).join(', ')}.` +
        (errors.length > 0 ? ` ${errors.length} file(s) could not be read: see the log.` : ''),
    );
    return null;
  }
  const previewFile = path.join(staging, PREVIEW_FILE);
  fs.writeFileSync(previewFile, newRepo.previewMarkdown({ sources, groups, errors }));
  try {
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(previewFile));
    log(`opened the preview ${previewFile}`);
  } catch (err) {
    log(`cannot open the preview ${previewFile}: ${err.message}`);
  }
  // the list waits until the preview has been read: open at once, it would cover the top of the preview
  const read = await ui.showInformationMessage(
    `Team plugins: read the preview of the new team repository (${groups.length} item${groups.length === 1 ? '' : 's'} found), then press Continue to pick what goes in.`,
    'Continue',
    'Cancel',
  );
  if (read !== 'Continue') {
    return cancelNewRepo();
  }
  const picked = await ui.showQuickPick(groups.map(groupPickItem), {
    canPickMany: true,
    ignoreFocusOut: true,
    placeHolder: 'What goes in the team repository (the preview lists the details)',
  });
  if (!picked || picked.length === 0) {
    return cancelNewRepo();
  }
  const ids = new Set(picked.map((p) => p.group.id));
  const chosen = groups.filter((g) => ids.has(g.id));

  const choices = new Map();
  const taken = new Map(Object.keys(authoring.KINDS).map((kind) => [kind, new Set()]));
  // every picked group's name is reserved before any decision, so a split never takes a name a later group uses
  for (const g of chosen) {
    taken.get(g.kind).add(g.name);
  }
  for (const g of chosen.filter((x) => x.status !== 'variants')) {
    choices.set(g.id, { kind: 'use', version: 0 });
  }
  for (const g of chosen.filter((x) => x.status === 'variants')) {
    const choice = await decideVariant(g, groups.indexOf(g), staging, taken);
    if (!choice) {
      return cancelNewRepo();
    }
    choices.set(g.id, choice);
  }
  const plan = newRepo.planImport(groups, choices);
  if (plan.items.length + plan.servers.length === 0) {
    return cancelNewRepo();
  }
  // the copied originals must still be what the preview showed: checked now, right before the build and right after it,
  // so what is published is what was previewed (the build reads the files again)
  const unchanged = () => {
    const changed = plan.imported.find((e) => e.copy && !newRepo.stillSame(e.copy));
    if (changed) {
      notify('showErrorMessage', `Team plugins: ${changed.copy.where} changed since the preview: run Create team repository again.`);
      return false;
    }
    return true;
  };
  if (!unchanged()) {
    return null;
  }

  const asked = await askNewRepoUrl(git);
  if (asked.cancelled) {
    return cancelNewRepo();
  }
  if (asked.stopped) {
    return null;
  }
  const url = asked.url;
  const pluginName = await ui.showInputBox({
    prompt: 'Name of the plugin that holds the imported items',
    value: share.suggestName(baseName(url)) || 'team',
    ignoreFocusOut: true,
    validateInput: (v) => authoring.nameError(v.trim()) || null,
  });
  if (pluginName === undefined) {
    return cancelNewRepo();
  }
  const name = pluginName.trim();
  const repoDir = path.join(staging, 'repo');
  if (!unchanged()) {
    return null;
  }
  const built = newRepo.buildRepository(repoDir, {
    marketplaceName: repoName(baseName(url)),
    pluginName: name,
    items: plan.items,
    servers: plan.servers,
  });
  if (built.errors.length > 0) {
    notify(
      'showErrorMessage',
      `Team plugins: could not write the new repository: ${built.errors.map((e) => `${e.name}: ${e.message}`).join('; ')}`,
    );
    return null;
  }
  if (!unchanged()) {
    return null;
  }
  const problems = checks.pushProblems({
    catalog: readCatalog(repoDir),
    repoDir,
    changed: built.files,
    readFile: (file) => {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    },
  });
  const dropped = droppedGroups(plan, built.pluginDir, problems);
  const branch = await newRepo.defaultBranch({ run: git, cwd: storage });
  const hasError = problems.some((p) => p.severity === 'error');
  const button = hasError ? 'Create and push anyway' : 'Create and push';
  const detail = confirmDetail({ pluginName: name, plan, skipped: built.skipped, problems, repoDir, branch, url });
  const confirmed = await ui.showWarningMessage(`Create the team repository at ${url}?`, { modal: true, detail }, button);
  if (confirmed !== button) {
    return cancelNewRepo();
  }

  const again = await newRepo.checkEmptyRemote({ run: git, cwd: storage, url, idleMs: sync.CHECK_IDLE_MS });
  if (again.kind !== 'empty') {
    await showNewRepoError(again, url);
    return null;
  }
  const progress = (fn) =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Team plugins: creating the team repository' },
      fn,
    );
  const committed = await progress(() => newRepo.initAndCommit({ run: git, dir: repoDir, branch, files: built.files }));
  if (!committed.head) {
    notify('showErrorMessage', `Team plugins: ${committed.message}`);
    return null;
  }
  let pushed = await progress(() => newRepo.pushNew({ run: git, dir: repoDir, url, branch }));
  while (pushed.kind !== 'pushed') {
    const next = await showNewRepoError(pushed, url, { retry: true });
    if (next === 'stop') {
      return null;
    }
    if (next === 'retry') {
      const state = await newRepo.remoteBranchState({ run: git, cwd: storage, url, branch, head: committed.head });
      if (state === 'pushed') {
        break;
      }
      if (state === 'other') {
        notify('showErrorMessage', `Team plugins: the branch ${branch} of ${url} now holds other commits: nothing more was pushed.`);
        return null;
      }
      pushed = state === 'absent' ? await progress(() => newRepo.pushNew({ run: git, dir: repoDir, url, branch })) : state;
    }
  }

  const check = await sync.checkRemote({ run: git, cwd: storage, repoUrl: url, idleMs: sync.CHECK_IDLE_MS });
  const entry = newRepo.repositoryEntry(url, branch, check);
  for (;;) {
    try {
      await addRepositoryEntry(entry);
      break;
    } catch (err) {
      const choice = await ui.showErrorMessage(
        `Team plugins: pushed ${url}, but could not add it to your repositories: ${err.message}`,
        'Try again',
      );
      if (choice !== 'Try again') {
        return null;
      }
    }
  }
  const count = plan.items.length + plan.servers.length;
  log(`created the team repository ${url} (${branch}) with ${count} items`);
  const text =
    `Team plugins: created ${url} with the plugin ${name} (${count} items). It is being cloned. Your originals are still in your projects: ` +
    "replace them with the plugin so the agent doesn't read each item twice, or keep them and tick the plugin later in the Team Plugins view.";
  return () =>
    ui.showInformationMessage(text, 'Replace the originals', 'Keep them').then((choice) =>
      choice === 'Replace the originals' ? replaceOriginals({ groups, choices, dropped, plan, url, pluginName: name, head: committed.head }) : undefined,
    );
}

function waitStep() {
  return new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
}

// The plugin of the new repository once it is cloned and holds every imported item (null after the wait).
async function waitForNewPlugin({ url, pluginName, plan }) {
  const wanted = [
    ...plan.items.map((i) => ({ kind: i.kind, name: i.name })),
    ...plan.servers.map((s) => ({ kind: 'mcp', name: s.name })),
  ];
  const end = Date.now() + PLUGIN_WAIT_MS;
  for (;;) {
    const d = listConfigured().find((x) => x.normalized === normalizeUrl(url));
    const plugin = d && catalog.plugins.find((p) => p.repoKey === d.key && p.pluginName === pluginName);
    if (plugin && wanted.every((w) => plugin.children.some((c) => c.kind === w.kind && c.name === w.name))) {
      return plugin;
    }
    if (Date.now() >= end) {
      return null;
    }
    await waitStep();
  }
}

async function waitForRegistration(name) {
  const end = Date.now() + REGISTER_WAIT_MS;
  while (!(registrar && registrar.current.has(name))) {
    if (Date.now() >= end) {
      return false;
    }
    await waitStep();
  }
  return true;
}

// Removes the servers of `originals` (scanned copies of one mcp.json) whose entry still has the fingerprint the scan
// read, in the same read that prepares the edit: backs the file up first, then replaces it atomically, keeping its
// mode. -> { removed: [original], left: [original], reason?, failed? } (failed: a write failed, the file is untouched).
function removeServersFromFile(file, originals, backupDir, number) {
  const none = (reason, failed = false) => ({ removed: [], left: originals, reason, failed });
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      return none('a link');
    }
    const text = fs.readFileSync(file, 'utf8');
    const same = originals.filter((o) => newRepo.serverKeyIn(text, o.serverName) === o.copy.originalKey);
    const left = originals.filter((o) => !same.includes(o));
    if (same.length === 0) {
      return none('changed since the preview');
    }
    const result = newRepo.removeServers(
      text,
      same.map((o) => o.serverName),
    );
    if (result.error) {
      return none(result.error);
    }
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, `${number}-mcp.json`);
    fs.writeFileSync(backup, text, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(`${backup}.source`, file, { flag: 'wx', mode: 0o600 });
    log(`backed up ${file} to ${backup}`);
    if (fs.readFileSync(file, 'utf8') !== text) {
      return none('changed while replacing');
    }
    const mode = fs.statSync(file).mode & 0o777;
    const temporary = `${file}.team-plugins-${process.pid}.tmp`;
    let created = false;
    try {
      fs.writeFileSync(temporary, result.text, { flag: 'wx', mode });
      created = true;
      fs.chmodSync(temporary, mode); // the umask may have narrowed or the platform ignored the mode
      fs.renameSync(temporary, file);
    } catch (err) {
      if (created) {
        try {
          fs.rmSync(temporary, { force: true });
        } catch {
          // nothing more to clean up
        }
      }
      return none(`could not write it: ${err.message}`, true);
    }
    return { removed: same, left };
  } catch (err) {
    return none(err.code || 'unreadable');
  }
}

// Replace the originals: after the new plugin is cloned and registered, moves the originals the user ticks to the trash
// and removes the imported MCP servers from their mcp.json (backed up first).
async function replaceOriginals({ groups, choices, dropped, plan, url, pluginName, head }) {
  const originals = newRepo.originalsOf(groups, choices, { dropped });
  for (const o of originals) {
    if (o.src) {
      o.uri = vscode.Uri.joinPath(o.source.uri, ...o.rel.split('/'));
    }
  }
  const items = [];
  let section = null;
  for (const original of originals) {
    if (original.sourceLabel !== section) {
      section = original.sourceLabel;
      items.push({ kind: vscode.QuickPickItemKind.Separator, label: section });
    }
    items.push({
      label: original.where,
      description: `${authoring.KINDS[original.kind].label} ${original.name}${original.reason ? ` · ${original.reason}` : ''}`,
      picked: original.picked,
      original,
    });
  }
  const picked = await ui.showQuickPick(items, {
    canPickMany: true,
    ignoreFocusOut: true,
    placeHolder: 'Originals to replace with the plugin (a project file tracked by git is a change to commit there)',
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const chosen = picked.map((p) => p.original);
  const remote = Boolean(vscode.env.remoteName);
  if (remote) {
    const list = chosen.map((o) => o.src || o.file).join('\n');
    const choice = await ui.showWarningMessage(
      `Delete the ${chosen.length} originals for good?`,
      { modal: true, detail: `This remote window has no trash: files can't be recovered. The plugin keeps its copies.\n\n${list}` },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }
  }
  const unsavedIn = (original) => {
    const target = original.src || original.file;
    return vscode.workspace.textDocuments.some(
      (d) => d.isDirty && (samePath(d.uri.fsPath, target) || (original.src && insideFolded(target, d.uri.fsPath))),
    );
  };
  // checked before anything is ticked, and again right before each original is touched
  const movable = (original) => {
    if (!newRepo.stillSame(original.copy) || unsavedIn(original)) {
      return false;
    }
    return inside(realPathOr(original.source.root), realPathOr(original.src || original.file));
  };
  if (!chosen.some(movable)) {
    notify(
      'showInformationMessage',
      'Team plugins: nothing was replaced: every original you ticked changed since the preview, has unsaved edits, or moved.',
    );
    return;
  }
  const plugin = await waitForNewPlugin({ url, pluginName, plan });
  if (!plugin) {
    notify(
      'showInformationMessage',
      `Team plugins: the new repository is not cloned yet, so nothing was replaced: tick ${pluginName} in the Team Plugins view once it shows, and remove the originals yourself.`,
    );
    return;
  }
  // the clone must hold the pushed commit, with the plugin folder as it was pushed
  const d = listConfigured().find((x) => x.normalized === normalizeUrl(url));
  const run = makeGit(gitPath());
  const folder = path.relative(d.dir, plugin.dir).split(path.sep).join('/');
  const ancestor = await run(['merge-base', '--is-ancestor', head, 'HEAD'], d.dir);
  const same = ancestor.code === 0 ? await run(['diff', '--quiet', head, 'HEAD', '--', folder], d.dir) : ancestor;
  if (same.code !== 0) {
    log(`replace the originals: the clone of ${url} does not hold ${head} with ${folder} unchanged (${same.stderr || 'differs'})`);
    notify(
      'showInformationMessage',
      `Team plugins: ${pluginName} changed in the repository since you pushed it, so nothing was replaced: check it, then remove the originals yourself.`,
    );
    return;
  }
  await enableNew(plugin.name);
  if (!(await waitForRegistration(plugin.name))) {
    notify('showErrorMessage', `Team plugins: ${plugin.name} was not registered, so nothing was replaced: see the log.`);
    return;
  }
  const left = [];
  let removed = 0;
  const variables = new Set();
  const byFile = new Map();
  for (const original of chosen) {
    if (!movable(original)) {
      left.push(original.where);
    } else if (original.src) {
      try {
        await vscode.workspace.fs.delete(original.uri, { recursive: true, useTrash: !remote });
        log(`${remote ? 'deleted' : 'moved to the trash'}: ${original.src}`);
        removed++;
      } catch (err) {
        const how = remote ? 'delete' : 'move';
        notify('showErrorMessage', `Team plugins: could not ${how} ${original.src}${remote ? '' : ' to the trash'}: ${err.message}`);
      }
    } else {
      if (!byFile.has(original.file)) {
        byFile.set(original.file, []);
      }
      byFile.get(original.file).push(original);
    }
  }
  const backupDir = path.join(storage, 'replaced-originals', `${Date.now()}-${process.pid}`);
  let backedUp = false;
  let number = 0;
  for (const [file, list] of byFile) {
    const result = removeServersFromFile(file, list, backupDir, ++number);
    removed += result.removed.length;
    if (result.removed.length > 0) {
      backedUp = true;
    }
    for (const o of result.removed) {
      o.replaced.forEach((v) => variables.add(v));
    }
    if (result.left.length > 0) {
      if (result.failed) {
        notify('showErrorMessage', `Team plugins: ${file}: ${result.reason}`);
      }
      log(`left ${result.left.map((o) => o.serverName).join(', ')} in ${file}: ${result.reason || 'changed since the preview'}`);
      left.push(...result.left.map((o) => o.where));
    }
  }
  let message = `Team plugins: replaced ${removed} original${removed === 1 ? '' : 's'} with the plugin ${plugin.name}.`;
  if (left.length > 0) {
    message += ` Left in place: ${left.join(', ')} (changed since the preview, unsaved edits, or moved).`;
  }
  if (variables.size > 0) {
    message += ` Set these environment variables, then restart Cursor: ${[...variables].join(', ')}.`;
  }
  if (backedUp) {
    message += ` The edited mcp.json files are backed up in ${backupDir}.`;
  }
  notify('showInformationMessage', message);
}

// The Check git command. `teamPlugins.gitReady` completes the walkthrough's first step: only this command sets it,
// never the activation (Cursor never completes a step whose context key is already true when it registers the
// walkthrough). Returns the promise of the message chain so that a scenario can wait for it.
async function checkGitCommand() {
  try {
    const gp = gitPath();
    // `storage` is not inside a repository, so `git config --get` reads the user's global and system values.
    const result = await checkGit({ run: makeGit(gp), cwd: storage });
    lastGitCheck = result;
    log(`git check: ${result.status}${result.version ? ' ' + result.version : ''}${result.error ? ': ' + result.error : ''}`);
    await vscode.commands.executeCommand('setContext', 'teamPlugins.gitReady', result.status === 'ok');
    const m = gitCheckMessage(result, { gitPath: gp, machine: remoteMachine() });
    const show = { info: 'showInformationMessage', warning: 'showWarningMessage', error: 'showErrorMessage' }[m.level];
    const buttons = m.actions.includes('downloadGit') ? ['Download git'] : [];
    return ui[show](`Team plugins: ${m.message}`, ...buttons).then((choice) =>
      choice === 'Download git' ? ui.openExternal(DOWNLOAD_URL) : undefined,
    );
  } catch (err) {
    log(`git check failed: ${err.stack || err.message}`);
    ui.showErrorMessage(`Team plugins: cannot run git: ${err.message}`);
    return undefined;
  }
}

function registerCommands(context) {
  const reg = (id, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args) => {
        try {
          return await fn(...args);
        } catch (err) {
          ui.showErrorMessage(`Team plugins: ${err?.message || String(err)}`);
          return undefined;
        }
      }),
    );

  reg('teamPlugins.syncNow', () => refresh({ sync: true, userInitiated: true }));
  reg('teamPlugins.openRepo', async (arg) => {
    if (listConfigured().length === 0) {
      ui.showInformationMessage('No repository configured.');
      return;
    }
    const d = await pickRepo(arg, { filter: (x) => !x.duplicateOf, placeHolder: 'Repository to open' });
    if (d) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(d.dir), { forceNewWindow: true });
    }
  });
  reg('teamPlugins.showLog', () => output.show());
  reg('teamPlugins.checkGit', checkGitCommand);
  reg('teamPlugins.getStarted', () =>
    vscode.commands.executeCommand(
      'workbench.action.openWalkthrough',
      {
        category: `${context.extension.id}#${WALKTHROUGH_ID}`,
        step: `${context.extension.id}#${WALKTHROUGH_ID}#checkGit`,
      },
      false,
    ),
  );
  reg('teamPlugins.addRepository', async () => {
    const value = await ui.showInputBox({
      prompt: 'Git URL of a team plugins repository',
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : 'Enter a Git URL'),
    });
    if (value !== undefined && value.trim()) {
      await addRepositoryEntry({ url: value.trim() });
    }
  });
  reg('teamPlugins.addLocalRepository', addLocalRepositoryCommand);
  reg('teamPlugins.removeRepository', removeRepositoryCommand);
  reg('teamPlugins.addProjectRepository', (node) =>
    node && node.url ? addRepositoryEntry({ url: node.url, branch: node.branch }) : undefined,
  );
  reg('teamPlugins.addToProject', (node) => addToProjectCommand(node));
  reg('teamPlugins.removeFromProject', (node) => removeFromProjectCommand(node));
  reg('teamPlugins.openItem', async (node) => {
    if (node && node.file) {
      const found = updateItemOf(node);
      // like the Explorer's single click: a preview that leaves the focus in the view, so F2 still renames the row
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(node.file), { preview: true, preserveFocus: true });
      if (found && found.u.marks.has(found.item.id)) {
        await markItemsSeen(found.d, found.u, [found.item]); // opening an item counts as seeing it
      }
      return editor;
    }
    return undefined;
  });
  reg('teamPlugins.whatChanged', whatChangedCommand);
  reg('teamPlugins.showChanges', showChangesCommand);
  reg('teamPlugins.discardLocalChanges', async (arg) => {
    if (!listConfigured().some(isManaged)) {
      ui.showInformationMessage(NO_CLONE);
      return;
    }
    await flushPartials();
    await refreshChanges();
    const d = await pickRepo(arg, { filter: hasWork, placeHolder: 'Repository whose local changes to discard' });
    if (!d) {
      ui.showInformationMessage('Nothing to discard.');
      return;
    }
    if (d.kind !== 'managed') {
      ui.showInformationMessage(NO_CLONE);
      return;
    }
    const s = stateOf(d.key);
    if (changesUnreadable(s, d)) {
      return;
    }
    if (!hasChanges(s)) {
      ui.showInformationMessage('Nothing to discard.');
      return;
    }
    const { changes } = s;
    const listed = changes.files.slice(0, 10).map((f) => `${f.status} ${f.path}`);
    let detail = `These are deleted:\n${listed.join('\n')}`;
    if (changes.files.length > 10) {
      detail += `\n… and ${changes.files.length - 10} more`;
    }
    if (changes.ahead > 0) {
      detail += `\n${changes.ahead} unpushed commit(s)`;
    }
    const choice = await ui.showWarningMessage(
      `Discard all local changes in the managed clone of ${labelOf(d)}?`,
      { modal: true, detail },
      'Discard',
    );
    if (choice !== 'Discard') {
      return;
    }
    const result = await enqueue(async () => {
      const discarded = await sync.discardLocalChanges({
        run: makeGit(gitPath()),
        managedRepo: d.dir,
        lockFile: d.lockFile,
        log,
      });
      if (discarded.ok) {
        resetPartialCopies(d.key);
      }
      return discarded;
    });
    log(`discard local changes of ${labelOf(d)}: ${result.message}`);
    if (result.busy) {
      ui.showWarningMessage(BUSY_TEXT);
    } else if (!result.ok) {
      ui.showErrorMessage(`Team plugins: ${result.message}`);
    }
    await refresh({ sync: true, userInitiated: true, keys: new Set([d.key]) });
  });
  reg('teamPlugins.newPlugin', newPluginCommand);
  reg('teamPlugins.newSkill', (node) => newItemCommand('skill', node));
  reg('teamPlugins.newRule', (node) => newItemCommand('rule', node));
  reg('teamPlugins.newCommand', (node) => newItemCommand('command', node));
  reg('teamPlugins.newAgent', (node) => newItemCommand('agent', node));
  reg('teamPlugins.newMcpServer', (node) => newItemCommand('mcp', node));
  reg('teamPlugins.moveDraft', moveDraftCommand);
  reg('teamPlugins.rename', renameCommand);
  reg('teamPlugins.shareWithTeam', shareCommand);
  reg('teamPlugins.createTeamRepository', createTeamRepositoryCommand);
  reg('teamPlugins.commitAndPush', commitAndPushCommand);
  reg('teamPlugins.pushToBranch', pushToBranchCommand);
  reg('teamPlugins.openChange', openChangeCommand);
  reg('teamPlugins.openConflict', openConflictCommand);
  reg('teamPlugins.keepRepositoryVersion', (node) => resolveConflictCommand(node, 'source'));
  reg('teamPlugins.keepCopyVersion', (node) => resolveConflictCommand(node, 'copy'));
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(READONLY_SCHEME, {
      provideTextDocumentContent(uri) {
        try {
          const file = path.resolve(decodeURIComponent(uri.query));
          // only a file that Create team repository showed in this window, never any path a URI names
          return readonlyFiles.has(file) ? fs.readFileSync(file, 'utf8') : '';
        } catch {
          return '';
        }
      },
    }),
  );
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      async provideTextDocumentContent(uri) {
        try {
          const request = JSON.parse(decodeURIComponent(uri.query));
          const d =
            request && typeof request.repo === 'string' && request.repo
              ? listConfigured().find((x) => (isManaged(x) || (x.kind === 'local' && !x.duplicateOf)) && samePath(x.dir, request.repo))
              : undefined;
          if (!d) {
            return '';
          }
          const args = sync.revFileArgs(request, d.dir);
          if (!args) {
            return '';
          }
          const r = await makeGit(gitPath())(args, d.dir, undefined, { trim: false });
          if (r.code !== 0) {
            return '';
          }
          // an MCP server's diff shows its entry alone, not the whole file
          return typeof request.server === 'string' ? updates.serverText(r.stdout, request.server) : r.stdout;
        } catch {
          return '';
        }
      },
    }),
  );
}

// ---- local changes: diff, commit and push ------------------------------------------------------------------------

const GIT_SCHEME = 'team-plugins-git';
const NOT_MANAGED = 'With a local clone, commit and push with your own git tools.';
const NO_CLONE = 'There is no managed clone: a local clone is never changed by this extension.';

// server: the name of an MCP server, when the document is that server's entry in the MCP file `file`.
function gitUri(repo, rev, file, server) {
  const request = server === undefined ? { repo, rev, path: file } : { repo, rev, path: file, server };
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${file}`,
    query: encodeURIComponent(JSON.stringify(request)),
  });
}

async function openChangeCommand(node) {
  const d = repoFromArg(node);
  if (!node || !node.path || !d || d.kind !== 'managed') {
    return;
  }
  const isNew = node.status === 'added' || node.status === 'untracked';
  const left = gitUri(d.dir, isNew ? '' : 'HEAD', node.from || node.path);
  const right = node.status === 'deleted' ? gitUri(d.dir, '', node.path) : vscode.Uri.file(path.join(d.dir, node.path));
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(node.path)} (team ↔ yours)`);
}

// ---- partial-copy conflicts --------------------------------------------------------------------------------------------

async function openConflictCommand(node) {
  if (!node || !node.rel) {
    return;
  }
  const side = (file) => (fs.existsSync(file) ? vscode.Uri.file(file) : gitUri('', '', node.rel));
  await vscode.commands.executeCommand(
    'vscode.diff',
    side(node.source),
    side(node.copy),
    `${path.basename(node.rel)} (repository ↔ partial copy)`,
  );
}

async function resolveConflictCommand(node, keep) {
  if (!node || !node.rel) {
    return;
  }
  const shownEntry = [...partialCopies.values()].find((e) => e.holder === node.holder);
  if (!shownEntry) {
    log(`conflict no longer tracked: ${node.rel}`);
    return;
  }
  // the versions the user is about to choose between: the choice is applied only if both are still these
  let shown;
  try {
    shown = conflictVersions(shownEntry.plugin, shownEntry.holder, node.rel);
  } catch (err) {
    ui.showErrorMessage(`Team plugins: ${err.message}`);
    return;
  }
  const [message, detail, button] =
    keep === 'source'
      ? [`Keep the repository version of ${node.plugin}/${node.rel}?`, "The partial copy's version is replaced.", 'Keep repository version']
      : [`Keep the partial copy version of ${node.plugin}/${node.rel}?`, "The repository's version is replaced.", 'Keep copy version'];
  const choice = await ui.showWarningMessage(message, { modal: true, detail }, button);
  if (choice !== button) {
    return;
  }
  await enqueue(async () => {
    try {
      const entry = [...partialCopies.values()].find((e) => e.holder === node.holder);
      if (!entry) {
        log(`conflict no longer tracked: ${node.rel}`);
        return;
      }
      if (!(entry.conflicts || []).some((c) => c.rel === node.rel)) {
        ui.showInformationMessage(`${node.plugin}/${node.rel} is no longer in conflict.`);
        return;
      }
      const lockFile = lockOf(entry.plugin.repoKey);
      if (!lockFile) {
        log(`conflict of a repository that is no longer configured: ${node.rel}`);
        return;
      }
      const locked = sync.withLockSync(lockFile, () =>
        resolveConflict(entry.plugin, entry.holder, node.rel, keep, shown),
      );
      if (locked.kind === 'busy') {
        ui.showWarningMessage(BUSY_TEXT);
        return;
      }
      const a = locked.value;
      if (a.changed) {
        ui.showWarningMessage(
          `Team plugins: ${node.plugin}/${node.rel} changed since you chose (another window resolved it, or a side was edited again): nothing was replaced.`,
        );
        await syncPartials();
        return;
      }
      logCopyActions(entry.plugin, [a]);
      entry.conflicts = (entry.conflicts || []).filter((c) => c.rel !== node.rel);
      updateConflicts();
      await refreshChanges();
      updateStatus();
    } catch (err) {
      ui.showErrorMessage(`Team plugins: ${err.message}`);
    }
  });
}

function askCommitMessage(d) {
  return ui.showInputBox({
    prompt: `Commit message for your changes to ${labelOf(d)}`,
    placeHolder: 'Update the review skill',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Enter a commit message'),
  });
}

// Opens the hosting service's new pull request page of a pushed branch (result.pullRequest of pushToBranch).
function openPullRequest(result) {
  return ui.openExternal(result.pullRequest.url);
}

// Shows the outcome of commitAndPush / pushToBranch on the repository d. openPullRequest: open the pull request page
// of a pushed branch at once (the user chose Open a pull request).
function reportContribution(result, nothingText, d, { openPullRequest: openPage = false } = {}) {
  switch (result.kind) {
    case 'pushed':
      ui.showInformationMessage(
        `Pushed ${String(result.head).slice(0, 7)} to ${result.branch}: the team gets it at their next sync.`,
      );
      break;
    case 'pushedBranch': {
      const { branch, remote } = result;
      const skipped = result.resetSkipped;
      const what = skipped && skipped.files.length > 0 ? skipped.files.join(', ') : 'files';
      const back = skipped
        ? `The managed clone was left as it is because ${what} changed during the push: it still holds the pushed commit and those edits (push to a branch again, or discard them, when you are ready).`
        : 'The managed clone is back on the team version.';
      const merge = `git fetch ${remote}\ngit merge ${remote}/${branch}`;
      const mergeText = `git fetch ${remote} && git merge ${remote}/${branch}`;
      const page = result.pullRequest;
      if (page) {
        log(`pull request page for ${branch}: ${page.url}`);
      }
      const into = page && page.target ? ` into ${page.target}` : '';
      let text;
      let buttons;
      if (openPage && page) {
        openPullRequest(result);
        text = `Pushed your changes to branch ${branch} and opened the page to propose them as a pull request${into}. ${back}`;
        buttons = ['Open pull request', 'Copy merge commands'];
      } else if (page) {
        text = `Pushed your changes to branch ${branch}. ${back} Open a pull request to have them reviewed and merged${into}, or merge it in your own clone: ${mergeText}`;
        buttons = ['Open pull request', 'Copy merge commands'];
      } else {
        text = `Pushed your changes to branch ${branch}. ${back} Open a pull request from it on the hosting service, or merge it in your own clone: ${mergeText}`;
        buttons = ['Copy merge commands'];
      }
      ui[skipped ? 'showWarningMessage' : 'showInformationMessage'](text, ...buttons).then((choice) => {
        if (choice === 'Open pull request') {
          return openPullRequest(result);
        }
        return choice === 'Copy merge commands' ? vscode.env.clipboard.writeText(merge) : undefined;
      });
      break;
    }
    case 'nothing':
      ui.showInformationMessage(nothingText);
      break;
    case 'busy':
      ui.showWarningMessage(BUSY_TEXT);
      break;
    case 'conflict':
      ui
        .showWarningMessage(
          `Your commit conflicts with team changes in ${result.files.join(', ')}. It is kept in the managed clone but not pushed.`,
          'Push to a branch',
          'Open repository folder',
        )
        .then((choice) => {
          if (choice === 'Push to a branch') {
            vscode.commands.executeCommand('teamPlugins.pushToBranch', { repo: d.key });
          } else if (choice === 'Open repository folder') {
            vscode.commands.executeCommand('teamPlugins.openRepo', { repo: d.key });
          }
        });
      break;
    default:
      showRemoteError(result, d);
      break;
  }
}

// The managed repository a commit or push is for: the one invoked on, the only one with changes, or the user's pick.
// Flushes the partial copies first, so that the changes include the edits still waiting for the watcher.
async function pickToContribute(arg, { placeHolder, nothingText }) {
  if (!listConfigured().some(isManaged)) {
    ui.showInformationMessage(NOT_MANAGED);
    return undefined;
  }
  await flushPartials();
  await refreshChanges();
  const d = await pickRepo(arg, { filter: hasWork, placeHolder });
  if (!d) {
    ui.showInformationMessage(nothingText);
    return undefined;
  }
  if (d.kind !== 'managed') {
    ui.showInformationMessage(NOT_MANAGED);
    return undefined;
  }
  const s = stateOf(d.key);
  if (changesUnreadable(s, d)) {
    return undefined;
  }
  if (!hasChanges(s)) {
    ui.showInformationMessage(nothingText);
    return undefined;
  }
  return d;
}

// The text of a small file, null when it is missing, a folder, over 1 MB or binary (a NUL in its first 8000 bytes).
function readSmallText(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) {
      return null;
    }
    const text = fs.readFileSync(file, 'utf8');
    return text.slice(0, 8000).includes('\0') ? null : text;
  } catch {
    return null;
  }
}

// Before a push: checks the plugins the push changes (lib/checks.js). Returns true to go on: no problem, or the user
// chose "Push anyway". "Open files" opens the files of the problems and stops.
async function confirmChecks(d) {
  let problems;
  try {
    const collectChangedPaths = testChangedPaths || sync.changedPaths;
    const changed = await collectChangedPaths({ run: makeGit(gitPath()), repo: d.dir });
    problems = checks.pushProblems({ catalog: readCatalog(d.dir), repoDir: d.dir, changed, readFile: readSmallText });
  } catch (err) {
    log(`check before pushing ${labelOf(d)}: ${err.message}`);
    const choice = await ui.showWarningMessage(
      `The check before pushing failed: ${err.message}`,
      { modal: true },
      'Push anyway',
    );
    return choice === 'Push anyway';
  }
  if (problems.length === 0) {
    return true;
  }
  log(`check before pushing ${labelOf(d)}: ${problems.length} problem(s)`);
  const shown = (p) => (p.file ? path.relative(d.dir, p.file).split(path.sep).join('/') : '(repository)');
  for (const p of problems) {
    log(`  ${shown(p)}${p.line > 0 ? `:${p.line}` : ''}: ${p.message}`);
  }
  const lines = problems.slice(0, 10).map((p) => `${shown(p)}${p.line > 0 ? `:${p.line}` : ''}: ${p.message}`);
  if (problems.length > 10) {
    lines.push(`and ${problems.length - 10} more`);
  }
  const choice = await ui.showWarningMessage(
    `${problems.length} problem(s) in your changes to ${labelOf(d)}: Cursor drops or misreads these files, for you and for every teammate who gets them.`,
    { modal: true, detail: lines.join('\n') },
    'Push anyway',
    'Open files',
  );
  if (choice === 'Push anyway') {
    return true;
  }
  if (choice === 'Open files') {
    const first = new Map();
    for (const p of problems) {
      if (p.file && !first.has(p.file) && fs.existsSync(p.file)) {
        first.set(p.file, p.line);
      }
    }
    for (const [file, line] of [...first].slice(0, 10)) {
      try {
        const row = Math.max(line, 1) - 1;
        await vscode.window.showTextDocument(vscode.Uri.file(file), {
          preview: false,
          selection: new vscode.Range(row, 0, row, 0),
        });
      } catch (err) {
        log(`cannot open ${file}: ${err.message}`);
      }
    }
  }
  return false;
}

async function commitAndPushCommand(arg) {
  const d = await pickToContribute(arg, {
    placeHolder: 'Repository to commit and push',
    nothingText: 'Nothing to commit or push.',
  });
  if (!d) {
    return;
  }
  if (!(await confirmChecks(d))) {
    return;
  }
  const { changes } = stateOf(d.key);
  let message = '';
  if (changes.files.length > 0) {
    const typed = await askCommitMessage(d);
    if (typed === undefined) {
      return;
    }
    message = typed.trim();
  } else {
    const choice = await ui.showWarningMessage(
      `Push ${changes.ahead} unpushed commit(s) of ${labelOf(d)} to the team?`,
      { modal: true },
      'Push',
    );
    if (choice !== 'Push') {
      return;
    }
  }
  const result = await enqueue(() =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Team plugins: committing and pushing…' },
      () =>
        contribute.commitAndPush({
          run: makeGit(gitPath()),
          repo: d.dir,
          message,
          lockFile: d.lockFile,
          stateFile: d.stateFile,
          repoUrl: d.url,
          log,
        }),
    ),
  );
  reportContribution(result, 'Nothing to commit or push.', d);
  await refresh({ sync: false });
}

async function pushToBranchCommand(arg) {
  const wantsPage = !!(arg && arg.openPullRequest);
  const d = await pickToContribute(arg, { placeHolder: 'Repository to push', nothingText: 'Nothing to push.' });
  if (!d) {
    return;
  }
  if (!(await confirmChecks(d))) {
    return;
  }
  const { changes } = stateOf(d.key);
  const run = makeGit(gitPath());
  const name = await run(['config', 'user.name'], d.dir);
  const branch = await ui.showInputBox({
    prompt: 'Branch to push your changes to (then open a pull request from it, or merge it from your own clone)',
    value: contribute.defaultBranchName(name.stdout, new Date()),
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Enter a branch name'),
  });
  if (branch === undefined) {
    return;
  }
  let message = '';
  if (changes.files.length > 0) {
    const typed = await askCommitMessage(d);
    if (typed === undefined) {
      return;
    }
    message = typed.trim();
  }
  const result = await enqueue(() =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Team plugins: pushing to a branch…' },
      () =>
        contribute.pushToBranch({
          run,
          repo: d.dir,
          message,
          branch: branch.trim(),
          lockFile: d.lockFile,
          stateFile: d.stateFile,
          repoUrl: d.url,
          log,
        }),
    ),
  );
  reportContribution(result, 'Nothing to push.', d, { openPullRequest: wantsPage });
  await refresh({ sync: true, keys: new Set([d.key]) });
}

// The extension of the old publisher declares the same commands and view and registers the same plugins: while it is
// installed this one stays inactive (whichever activates second fails on "command already exists") and asks to
// uninstall it (fire and forget). Returns true when the old extension is installed.
function warnOldExtension() {
  if (!vscode.extensions.getExtension(OLD_EXTENSION_ID)) {
    return false;
  }
  const text = `The old Team plugins extension (${OLD_EXTENSION_ID}) is still installed: both register the same plugins, so the new one stays inactive. Uninstall the old one, then reload the window.`;
  log(text);
  // The extensions view's search can't find it by id (it matches names and descriptions): uninstall it from here.
  ui.showWarningMessage(text, 'Uninstall it')
    .then(async (choice) => {
      if (choice !== 'Uninstall it') {
        return;
      }
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
      log(`uninstalled ${OLD_EXTENSION_ID}`);
      const reload = await ui.showInformationMessage(
        `${OLD_EXTENSION_ID} is uninstalled. Reload the window to finish.`,
        'Reload window',
      );
      if (reload === 'Reload window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    })
    .then(undefined, (err) => {
      log(`old extension uninstall error: ${err.message}`);
      ui.showErrorMessage(
        `Could not uninstall ${OLD_EXTENSION_ID}: ${err.message}. Uninstall "Team plugins" by mg from the Extensions view.`,
      );
    });
  return true;
}

// One checkbox click at a time: each reads the selection after the previous click's settings write.
function queueCheckboxChange(e) {
  checkboxChain = checkboxChain
    .then(() => onCheckboxChange(e))
    .catch((err) => log(`checkbox error: ${err.message}`));
  return checkboxChain;
}

// ---- Test mode (scripts/live-test.js) ---------------------------------------------------------------------------

// The `ui` of Test mode: records every dialog and answers it through the responder, never waiting for anyone.
function makeTestUi() {
  const push = (record) => {
    testCalls.push(record);
    if (testCalls.length > 1000) {
      testCalls.shift();
    }
  };
  const pickLabel = (item) => (typeof item === 'string' ? item : item && item.label);
  const printable = (answer) => {
    if (answer === undefined || answer === null) {
      return null;
    }
    return typeof answer === 'string' ? answer : JSON.stringify(answer);
  };
  // fn(args) -> { record, answer: (the responder's answer) => the value to return }
  const make = (name, prepare) => async (...args) => {
    const prepared = await prepare(args);
    const record = { kind: name, ...prepared.record };
    let answer;
    try {
      answer = await testResponder(record, prepared.args || args);
    } catch (err) {
      record.answer = null;
      record.error = err.message;
      push(record);
      return undefined;
    }
    const value = prepared.answer ? prepared.answer(answer) : answer;
    record.answer = printable(prepared.printable ? prepared.printable(value) : value);
    push(record);
    return value;
  };
  const message = (name) =>
    make(name, (args) => {
      const options = args[1] && typeof args[1] === 'object' && !('title' in args[1]) ? args[1] : null;
      const raw = args.slice(options ? 2 : 1);
      const titles = raw.map((b) => (typeof b === 'string' ? b : b.title));
      return {
        record: {
          message: args[0],
          modal: !!(options && options.modal),
          detail: options && options.detail,
          buttons: titles,
        },
        answer: (answer) => (typeof answer === 'string' ? raw.find((_b, i) => titles[i] === answer) || answer : answer),
        printable: (value) => (value && typeof value === 'object' ? value.title : value),
      };
    });
  return {
    showInformationMessage: message('showInformationMessage'),
    showWarningMessage: message('showWarningMessage'),
    showErrorMessage: message('showErrorMessage'),
    showQuickPick: make('showQuickPick', async (args) => {
      const items = [...(await args[0])];
      const options = args[1];
      return {
        record: { placeHolder: options && options.placeHolder, items: items.map(pickLabel) },
        args: [items, ...args.slice(1)],
        answer: (answer) => {
          const pick = (a) => (typeof a === 'string' ? items.find((i) => pickLabel(i) === a) || a : a);
          return Array.isArray(answer) ? answer.map(pick) : pick(answer);
        },
        printable: (value) => (Array.isArray(value) ? value.map(pickLabel).join(', ') : pickLabel(value)),
      };
    }),
    showInputBox: make('showInputBox', (args) => {
      const options = args[0] || {};
      return { record: { prompt: options.prompt, placeHolder: options.placeHolder, value: options.value } };
    }),
    showOpenDialog: make('showOpenDialog', (args) => {
      const options = args[0] || {};
      return { record: { title: options.title, openLabel: options.openLabel } };
    }),
    showWorkspaceFolderPick: make('showWorkspaceFolderPick', (args) => {
      const options = args[0] || {};
      return { record: { title: options.title, openLabel: options.openLabel } };
    }),
    openExternal: make('openExternal', (args) => ({ record: { url: args[0] } })),
  };
}

// Resolves when nothing of the extension is in flight for 300 ms: the serialised queue, the checkbox chain, the
// debounce timers and the syncs. The timed ones (offline retry, update timer, keep-alive) are ignored.
async function testIdle({ timeoutMs = 30000 } = {}) {
  let quietSince = null;
  let limit;
  const expired = new Promise((_resolve, reject) => {
    limit = setTimeout(() => reject(new Error(`extension not idle after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  try {
    for (;;) {
      const q = queue;
      const c = checkboxChain;
      await Promise.race([Promise.all([q, c]), expired]);
      const busy =
        knownSources === null ||
        debounceTimer ||
        copyDebounce ||
        copyRetryTimer ||
        [...repoStates.values()].some((s) => s.syncing) ||
        q !== queue ||
        c !== checkboxChain;
      if (busy) {
        quietSince = null;
      } else if (quietSince === null) {
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= 300) {
        return;
      }
      await Promise.race([new Promise((resolve) => setTimeout(resolve, 50)), expired]);
    }
  } finally {
    clearTimeout(limit);
  }
}

function testTree() {
  const snapshot = (nodes) =>
    nodes.map((node) => {
      const item = treeProvider.getTreeItem(node);
      const box = item.checkboxState;
      const state = box !== null && typeof box === 'object' ? box.state : box;
      return {
        id: item.id,
        label: String(item.label),
        description: item.description,
        tooltip: typeof item.tooltip === 'string' ? item.tooltip : '',
        icon: (item.iconPath && item.iconPath.id) || null,
        checked: box === undefined || box === null ? null : state === vscode.TreeItemCheckboxState.Checked,
        contextValue: item.contextValue,
        children: snapshot(node.children),
      };
    });
  return snapshot(treeProvider.getChildren());
}

function testFindNode(id) {
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.id === id) {
        return node;
      }
      const found = walk(node.children);
      if (found) {
        return found;
      }
    }
    return undefined;
  };
  return walk(treeProvider.getChildren());
}

// What activate returns in Test mode: the members a scenario (test/live/*.live.js) needs and nothing else.
function testHook(context) {
  return {
    calls: () => [...testCalls],
    clearCalls: () => {
      testCalls.length = 0;
    },
    respond: (fn) => {
      testResponder = fn || (() => undefined);
    },
    replaceChangedPaths: (fn) => {
      testChangedPaths = fn;
    },
    idle: (opts) => testIdle(opts),
    tree: () => testTree(),
    check: (id, checked) => {
      const node = testFindNode(id);
      if (!node) {
        throw new Error(`no tree node ${id}`);
      }
      const state = checked ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      return queueCheckboxChange({ items: [[node, state]] });
    },
    registrations: () => Object.fromEntries(registrar ? registrar.current : []),
    diagnostics: () => {
      const out = {};
      if (diagnostics) {
        diagnostics.forEach((uri, list) => {
          out[uri.fsPath] = list.map((d) => ({
            line: d.range.start.line + 1,
            severity: d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning',
            message: d.message,
          }));
        });
      }
      return out;
    },
    decoration: (key) => {
      const d = projectDecorations.provideFileDecoration(itemUri(key));
      return d ? { badge: d.badge, tooltip: d.tooltip, color: d.color && d.color.id } : null;
    },
    badge: () => (treeView.badge ? { value: treeView.badge.value, tooltip: treeView.badge.tooltip } : null),
    viewDescription: () => (treeView && treeView.description) || '',
    updates: (key) => {
      const s = stateOf(key).updates;
      return s ? { counts: s.counts, marks: Object.fromEntries(s.marks), removed: s.removed.map((r) => r.id) } : null;
    },
    states: () =>
      [...repoStates].map(([key, s]) => ({
        key,
        syncing: s.syncing,
        result: s.lastResult && {
          kind: s.lastResult.kind,
          reason: s.lastResult.reason || null,
          message: s.lastResult.message || '',
        },
        changes: s.changes,
      })),
    status: () => ({ text: statusItem.text, tooltip: String(statusItem.tooltip || '') }),
    logLines: () => [...testLog],
    gitCheck: () => lastGitCheck,
    storage,
    logUri: context.logUri.fsPath,
  };
}

function activate(context) {
  testMode = context.extensionMode === vscode.ExtensionMode.Test;
  if (testMode) {
    ui = redactingUi(makeTestUi());
  }
  storage = context.globalStorageUri.fsPath;
  fs.mkdirSync(storage, { recursive: true });

  output = vscode.window.createOutputChannel('Team Plugins');
  context.subscriptions.push(output);
  if (warnOldExtension()) {
    return;
  }

  statusItem = vscode.window.createStatusBarItem('teamPlugins.status', vscode.StatusBarAlignment.Left, 100);
  statusItem.name = 'Team plugins';
  statusItem.command = VIEW_COMMAND;
  statusItem.text = '$(plug) Team plugins';
  statusItem.show();
  context.subscriptions.push(statusItem);

  diagnostics = vscode.languages.createDiagnosticCollection('Team plugins');
  context.subscriptions.push(diagnostics);

  treeProvider = new PluginTree();
  treeView = vscode.window.createTreeView('teamPlugins.plugins', {
    treeDataProvider: treeProvider,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(projectDecorations), decorationEmitter);
  context.subscriptions.push(
    treeView.onDidChangeCheckboxState((e) => {
      queueCheckboxChange(e);
    }),
  );

  registerCommands(context);

  let cursorApi;
  try {
    cursorApi = vscode.cursor;
  } catch (err) {
    log(`vscode.cursor is not available: ${err.message}`);
  }
  api = pluginApi(cursorApi);
  if (api) {
    registrar = new Registrar(api, log);
    log(`plugin API: ${api.name}`);
  } else {
    log('vscode.cursor.plugins is missing: plugins cannot be registered');
    statusItem.text = '$(error) Team plugins';
    ui.showErrorMessage(
      'Team plugins: this Cursor cannot register plugins from extensions (vscode.cursor.plugins is missing). Update Cursor.',
    );
  }
  if (remoteMachine()) {
    log(`remote window (${vscode.env.remoteName}): running on ${remoteMachine()}, storage ${storage}`);
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (knownSources === null) {
        return; // activation is still moving the 0.4 settings: it ends with a full refresh
      }
      if (
        e.affectsConfiguration('teamPlugins.repositories') ||
        e.affectsConfiguration('teamPlugins.localRepositories') ||
        e.affectsConfiguration('git.path')
      ) {
        // a repository or branch that is new answers at once whether its server is reachable
        const now = managedSources();
        const check = new Set(
          listConfigured()
            .filter((d) => isManaged(d) && !knownSources.has(`${d.key}|${d.branch}`))
            .map((d) => d.key),
        );
        knownSources = now;
        startWatchers();
        startTimer();
        refresh({ sync: true, check });
      } else if (
        e.affectsConfiguration('teamPlugins.enabled') ||
        e.affectsConfiguration('teamPlugins.excluded') ||
        e.affectsConfiguration('teamPlugins.projectPlugins') ||
        e.affectsConfiguration('teamPlugins.projectRepositories')
      ) {
        apply();
      } else if (e.affectsConfiguration('teamPlugins.updateIntervalMinutes')) {
        startTimer();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => apply()),
  );

  migrateSettings()
    .catch((err) => log(`cannot move the settings of 0.4: ${err.message}`))
    .then(() => {
      knownSources = managedSources();
      refresh({ sync: true });
      startTimer();
      startWatchers();
    });
  if (registrar) {
    startCopyWatcher();
    keepAliveTimer = setInterval(
      () => touchFiltered(filteredHolders(paths().filteredRoot, [...registrar.current.values()])),
      KEEP_ALIVE_MS,
    );
  }
  if (testMode) {
    return testHook(context);
  }
  return undefined;
}

async function deactivate() {
  stopTimer();
  clearTimeout(offlineTimer);
  offlineTimer = null;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  stopWatchers();
  stopCopyWatcher();
  if (registrar) {
    await registrar.removeAll();
  }
}

module.exports = { activate, deactivate };
