'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { readCatalog } = require('./lib/catalog');
const authoring = require('./lib/authoring');
const share = require('./lib/share');
const selection = require('./lib/selection');
const {
  buildTree,
  buildChangesNode,
  buildConflictsNode,
  repoStatus,
  buildRepoNode,
  buildMissingNodes,
} = require('./lib/treeModel');
const { holderName, copyRootOf, syncCopy, markCopySynced, resolveConflict, gcFiltered } = require('./lib/materialize');
const { makeGit } = require('./lib/git');
const sync = require('./lib/sync');
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
  repoOfId,
  missingRepos,
  unlocatedRepos,
  projectRepoEntry,
  withProjectRepo,
  withoutProjectRepo,
} = require('./lib/repos');

const SECTION = 'teamPlugins';
const VIEW_COMMAND = 'workbench.view.extension.teamPlugins';
const BUSY_TEXT = 'Another Cursor window is syncing the team plugins: try again in a moment.';
const UNEXPECTED = { kind: 'error', message: 'unexpected error: see the log' };
const COPY_RETRY_MS = 2000;
const COPY_RETRY_MAX = 30;
const LOCKED_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const OFFLINE_RETRY_MS = 5 * 60 * 1000;
const OLD_EXTENSION_ID = 'mg.cursor-team-plugins'; // the publisher was `mg` up to 0.4.0

let output;
let statusItem;
let treeProvider;
let treeView;
let registrar = null;
let api = null;
let catalog = { plugins: [], warnings: [] }; // the merged catalog of the repositories that are loaded
let descs = []; // assignNames(listRepos(...)) of the last apply: every configured repository
let catalogs = new Map(); // repo key -> readCatalog result (kept for repositories that are syncing)
// repo key -> { lastResult, lastCheck, syncing, changes, errorShown }. lastResult is the last sync (this window's or,
// from the state file, another window's); changes: { files, ahead } of a managed clone, null for a local one.
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
let partialCopies = new Map(); // plugin name -> { plugin, ids, holder, copyRoot, conflicts: [{ rel, source, copy }] }
let copyConflicts = []; // the conflicts of all partial copies, as given to buildConflictsNode
let copyWatcher = null;
let copyDebounce = null;
let copyRetryTimer = null;
let copyRetries = 0;
let checkboxChain = Promise.resolve();
const conflictShown = new Set();
const conflictsNotified = new Set(); // `${holder}|${rel}` of the partial-copy conflicts already announced
const loggedWarnings = new Set();

function log(message) {
  if (output) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

function stateOf(key) {
  let s = repoStates.get(key);
  if (!s) {
    s = { lastResult: null, lastCheck: null, syncing: false, changes: null, errorShown: false };
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
  const run = async () => {
    try {
      return await fn();
    } catch (err) {
      log(`error: ${err && err.stack ? err.stack : err}`);
      return undefined;
    }
  };
  queue = queue.then(run, run);
  return queue;
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
        vscode.window.showInformationMessage(
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
      notifyAfterSync(s.lastResult, d, { hadClone, userInitiated: true, run });
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
    notifyAfterSync(s.lastResult, d, { hadClone, userInitiated, run });
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
  vscode.window
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

function notifyAfterSync(result, d, { hadClone, userInitiated, run }) {
  const s = stateOf(d.key);
  if (!['error', 'busy', 'offline'].includes(result.kind)) {
    s.errorShown = false; // a recovery re-arms the error notice
  }
  const name = labelOf(d);
  const ask = (kind, message, ...buttons) => vscode.window[kind](message, ...buttons);
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
      ask(
        'showInformationMessage',
        `Team plugins: ${name} updated (${result.commits} new commit(s)). Start a new chat to use the changes.${
          result.kept > 0 ? ' Your local changes were kept.' : ''
        }`,
        'What changed',
      ).then(async (choice) => {
        if (choice === 'What changed') {
          const text = await sync.changesBetween({ run, repoDir: d.dir, from: result.from, to: result.to });
          output.appendLine(`${name}:\n${text}`);
          output.show();
        }
      });
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
      const { actions, conflicts, skipped } = syncCopy(plugin, ids, holder);
      logCopyActions(plugin, actions);
      logSkipped(plugin, skipped);
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
    const holders = filteredHolders(filteredRoot, [...desired.values()]);
    touchFiltered(holders);
    gcFiltered(filteredRoot, holders, FILTERED_MAX_AGE_MS);
  }
  if (descs.some((d) => d.kind === 'drafts') && !draftsWatched) {
    startWatchers(); // the drafts folder was created (by this window or another one) after the watchers started
  }
  await refreshChanges();
  updateStatus();
}

// 0.4 ids in the user's lists (`review`, `review/skills/x`) become `<repository>:<id>`, once the catalog knows them.
async function migrateIds() {
  const c = cfg();
  for (const key of ['enabled', 'excluded']) {
    const raw = stringList(c.get(key));
    const next = normalizeIds(catalog, raw);
    if (next.join('\n') !== [...new Set(raw)].sort().join('\n')) {
      try {
        await c.update(key, next, vscode.ConfigurationTarget.Global);
        log(`teamPlugins.${key}: ids moved to <repository>:<plugin> ids`);
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
    vscode.window
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

// What a partial-copy sync left out (links that are not followed), once per file and reason.
function logSkipped(plugin, skipped) {
  for (const s of skipped) {
    const key = `skip:${plugin.name}/${s.rel}:${s.reason}`;
    if (!loggedWarnings.has(key)) {
      loggedWarnings.add(key);
      log(`${plugin.name}/${s.rel} left out of the partial copy: ${s.reason}`);
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
    vscode.window
      .showErrorMessage(`Team plugins: cannot read the local changes of ${labelOf(d)}: ${state.changes.error}`, 'Show log')
      .then((choice) => (choice === 'Show log' ? output.show() : undefined));
    return true;
  }
  return false;
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
    vscode.window
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
          vscode.window.showInformationMessage(
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
    vscode.window
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
    vscode.window
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
        const { actions, conflicts, skipped } = syncCopy(entry.plugin, entry.ids, entry.holder);
        logCopyActions(entry.plugin, actions);
        logSkipped(entry.plugin, skipped);
        entry.conflicts = conflicts;
        toSource = toSource || actions.some((a) => a.action === 'toSource' || a.action === 'deletedInSource');
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

// After a clone was reset to the team version (discard, push to a branch), the partial copies of its plugins take the
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
  if (registrar) {
    const { filteredRoot } = paths();
    const names = [...registrar.current].map(
      ([name, p]) => name + (p.startsWith(filteredRoot) ? ' (partial)' : ''),
    );
    lines.push(`Active: ${names.join(', ') || 'none'}`);
  }
  statusItem.tooltip = lines.join('\n');
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
let projectStates = new Map(); // item uri -> 'all' | 'some'

function itemUri(key) {
  return vscode.Uri.from({ scheme: ITEM_SCHEME, path: `/${key}` });
}

// Records the project state of the plugin and item nodes; tells the decoration service only when it changed.
function updateProjectStates(nodes) {
  const next = new Map();
  for (const n of nodes.filter((x) => x.kind === 'plugin')) {
    for (const m of [n, ...n.children]) {
      if (m.project) {
        next.set(itemUri(m.key).toString(), m.project);
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
    if (state === 'all') {
      const color = new vscode.ThemeColor('teamPlugins.projectItemForeground');
      return new vscode.FileDecoration('P', 'Enabled by this project', color);
    }
    if (state === 'some') {
      return new vscode.FileDecoration('P', 'Partly enabled by this project');
    }
    return undefined;
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
      if (isActive(d)) {
        plugins = buildTree({ plugins: catalog.plugins.filter((p) => p.repoKey === d.key) }, eff, project, {
          draft: d.kind === 'drafts',
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
      return buildRepoNode({ ...d, name: labelOf(d) }, s, children);
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
    vscode.window.showErrorMessage('Open a folder first: project plugins are saved in its .vscode/settings.json.');
    return;
  }
  let folder = folders[0];
  if (folders.length > 1) {
    folder = await vscode.window.showWorkspaceFolderPick();
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
  const picked = await vscode.window.showQuickPick(
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
    vscode.window.showInformationMessage(`Team plugins: ${url} is already in teamPlugins.repositories.`);
    return;
  }
  const next = [...globalList(config, 'repositories'), branch ? { url, branch } : { url }];
  await config.update('repositories', next, vscode.ConfigurationTarget.Global);
}

async function addLocalRepositoryCommand() {
  const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
  if (!picked || picked.length === 0) {
    return;
  }
  const folder = picked[0].fsPath;
  const config = cfg();
  const normalized = normalizeUrl(folder);
  if (parseLocalRepositories(config.get('localRepositories')).some((p) => normalizeUrl(p) === normalized)) {
    vscode.window.showInformationMessage(`Team plugins: ${folder} is already in teamPlugins.localRepositories.`);
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
  const choice = await vscode.window.showWarningMessage(`Stop following ${labelOf(d)}?`, { modal: true, detail }, 'Remove');
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
    next = list.filter((item, i) => i !== last);
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
    vscode.window.showWarningMessage(BUSY_TEXT);
    return null;
  }
  return locked.value;
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
        vscode.window.showInformationMessage(
          `Team plugins: ${labelOf(given)} is not available yet (not cloned, listed twice or replaced).`,
        );
        return null;
      }
    }
  } else {
    const picked = await vscode.window.showQuickPick(
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
  const name = await vscode.window.showInputBox({
    prompt: 'Plugin name',
    placeHolder: 'my-plugin',
    ignoreFocusOut: true,
    validateInput: (v) => authoring.nameError(v.trim()) || null,
  });
  if (name === undefined) {
    return null;
  }
  const description = await vscode.window.showInputBox({ prompt: 'Plugin description (optional)', ignoreFocusOut: true });
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
    vscode.window.showErrorMessage(`Team plugins: ${result.error}`);
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
  vscode.window
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
      vscode.window.showInformationMessage('No plugin to add it to: create one with New plugin.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
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
    vscode.window.showErrorMessage(`Team plugins: ${declared}`);
    return;
  }
  const repo = descs.find((d) => d.key === plugin.repoKey);
  if (!repo) {
    return;
  }
  const name = await vscode.window.showInputBox({
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
    const how = await vscode.window.showQuickPick(
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
      const command = await vscode.window.showInputBox({
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
      const url = await vscode.window.showInputBox({
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
    const typed = await vscode.window.showInputBox({
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
        ? authoring.addMcpServer(plugin.dir, itemName, entry)
        : authoring.createItem(plugin.dir, kind, itemName, description),
    ),
  );
  if (!result) {
    return;
  }
  if (result.error) {
    vscode.window.showErrorMessage(`Team plugins: ${result.error}`);
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
      vscode.window.showInformationMessage('There is no draft plugin: create one with New plugin.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
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
    vscode.window.showInformationMessage('Follow a repository or add your own clone first.');
    return;
  }
  const picked = await vscode.window.showQuickPick(targets.map(targetPickItem), {
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
  const choice = await vscode.window.showWarningMessage(
    `Move ${plugin.pluginName} to ${labelOf(target)}?`,
    { modal: true, detail },
    'Move',
  );
  if (choice !== 'Move') {
    return;
  }
  await flushPartials();
  const draftsDesc = descs.find((d) => d.key === plugin.repoKey);
  const result = await enqueue(async () => {
    // a registered folder that is deleted stays "delete pending" on Windows while Cursor watches it: unregister first
    // (the apply that follows registers again whatever is still wanted, the draft too if the move fails)
    if (registrar) {
      await registrar.remove(plugin.name);
    }
    return withRepoLock(target, () => {
      const locked = sync.withLockSync(draftsDesc.lockFile, () =>
        authoring.movePlugin(plugin.dir, plugin.pluginName, plugin.description, target.dir),
      );
      if (locked.kind === 'busy') {
        vscode.window.showWarningMessage(BUSY_TEXT);
        return null;
      }
      if (!locked.value.error) {
        partialCopies.delete(plugin.name); // its copy must not carry its files back into the deleted draft
      }
      return locked.value;
    });
  });
  if (!result || result.error) {
    if (result) {
      vscode.window.showErrorMessage(`Team plugins: ${result.error}`);
    }
    await apply(); // the draft was unregistered above
    return;
  }
  const to =`${labelOf(target)}:${plugin.pluginName}`;
  const config = cfg();
  for (const key of ['enabled', 'excluded']) {
    const current = stringList(config.get(key));
    const next = authoring.renameIds(current, plugin.name, to);
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      await config.update(key, next, vscode.ConfigurationTarget.Global);
    }
  }
  await apply();
  log(`moved draft ${plugin.pluginName} to ${labelOf(target)} (${result.dir})`);
  if (result.leftover) {
    vscode.window.showWarningMessage(
      `Team plugins: ${plugin.pluginName} was copied, but its draft folder could not be removed yet: ${result.leftover}. Reload the Cursor windows, then delete it if it is still there.`,
    );
  }
  if (target.kind === 'managed') {
    vscode.window
      .showInformationMessage(
        `Moved ${plugin.pluginName} to ${labelOf(target)}: it is in the repository's Local changes. Commit and push to share it.`,
        'Commit and push',
      )
      .then((c) =>
        c === 'Commit and push' ? vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: target.key }) : undefined,
      )
      .then(undefined, (err) => log(`cannot offer commit and push: ${err.message}`));
  } else {
    vscode.window.showInformationMessage(
      `Moved ${plugin.pluginName} to your clone ${target.dir}: commit and push it with your own git tools.`,
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
      vscode.window.showInformationMessage('Team plugins: only a rule, skill, command or agent of a .cursor folder can be shared.');
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
    vscode.window.showInformationMessage(
      "Team plugins: no rule, skill, command or agent found in this project's .cursor folder or in ~/.cursor.",
    );
    return [];
  }
  const editor = vscode.window.activeTextEditor;
  const active = editor ? share.shareableItem(editor.document.uri.fsPath) : null;
  const picked = await vscode.window.showQuickPick(
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
  const dest = await vscode.window.showQuickPick(
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
      vscode.window.showErrorMessage('Team plugins: the new plugin is not in the catalog yet: try again.');
      return;
    }
    isNewPlugin = true;
  }
  for (const kind of new Set(items.map((item) => item.kind))) {
    const declared = authoring.declaredPathsError(plugin, kind);
    if (declared) {
      vscode.window.showErrorMessage(`Team plugins: ${declared}`);
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
      const typed = await vscode.window.showInputBox({
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
    withRepoLock(repo, () => items.map((item, i) => share.shareItem(item, plugin.dir, names[i]))),
  );
  if (!results) {
    return;
  }
  const shared = []; // { item, name, result }
  results.forEach((result, i) => {
    if (result.error) {
      vscode.window.showErrorMessage(`Team plugins: could not share ${items[i].name}: ${result.error}`);
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
    vscode.window.showWarningMessage(`Team plugins: links are not copied: ${skipped.join(', ')}`);
  }
  if (shared.length === 1) {
    await vscode.window.showTextDocument(vscode.Uri.file(shared[0].result.file));
  }
  const what =
    shared.length === 1
      ? `the ${authoring.KINDS[shared[0].item.kind].label} ${shared[0].name}`
      : `${shared.length} items`;
  const trash = shared.length === 1 ? 'Move the original to the trash' : 'Move the originals to the trash';
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
  vscode.window
    .showInformationMessage(text, ...buttons, trash)
    .then(async (choice) => {
      if (choice === 'Commit and push') {
        await vscode.commands.executeCommand('teamPlugins.commitAndPush', { repo: repo.key });
      } else if (choice === trash) {
        for (const { item } of shared) {
          try {
            await vscode.workspace.fs.delete(item.uri, { recursive: true, useTrash: true });
          } catch (err) {
            vscode.window.showErrorMessage(`Team plugins: could not move ${item.src} to the trash: ${err.message}`);
          }
        }
      }
    })
    .then(undefined, (err) => log(`cannot offer the closing choices of the share: ${err.message}`));
}

function registerCommands(context) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('teamPlugins.syncNow', () => refresh({ sync: true, userInitiated: true }));
  reg('teamPlugins.openRepo', async (arg) => {
    if (listConfigured().length === 0) {
      vscode.window.showInformationMessage('No repository configured.');
      return;
    }
    const d = await pickRepo(arg, { filter: (x) => !x.duplicateOf, placeHolder: 'Repository to open' });
    if (d) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(d.dir), { forceNewWindow: true });
    }
  });
  reg('teamPlugins.showLog', () => output.show());
  reg('teamPlugins.addRepository', async () => {
    const value = await vscode.window.showInputBox({
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
  reg('teamPlugins.openItem', (node) => {
    if (node && node.file) {
      return vscode.window.showTextDocument(vscode.Uri.file(node.file));
    }
    return undefined;
  });
  reg('teamPlugins.discardLocalChanges', async (arg) => {
    if (!listConfigured().some(isManaged)) {
      vscode.window.showInformationMessage(NO_CLONE);
      return;
    }
    await flushPartials();
    await refreshChanges();
    const d = await pickRepo(arg, { filter: hasWork, placeHolder: 'Repository whose local changes to discard' });
    if (!d) {
      vscode.window.showInformationMessage('Nothing to discard.');
      return;
    }
    if (d.kind !== 'managed') {
      vscode.window.showInformationMessage(NO_CLONE);
      return;
    }
    const s = stateOf(d.key);
    if (changesUnreadable(s, d)) {
      return;
    }
    if (!hasChanges(s)) {
      vscode.window.showInformationMessage('Nothing to discard.');
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
    const choice = await vscode.window.showWarningMessage(
      `Discard all local changes in the managed clone of ${labelOf(d)}?`,
      { modal: true, detail },
      'Discard',
    );
    if (choice !== 'Discard') {
      return;
    }
    let result;
    await enqueue(async () => {
      result = await sync.discardLocalChanges({
        run: makeGit(gitPath()),
        managedRepo: d.dir,
        lockFile: d.lockFile,
        log,
      });
      if (result.ok) {
        resetPartialCopies(d.key);
      }
    });
    result = result || { ok: false, message: UNEXPECTED.message };
    log(`discard local changes of ${labelOf(d)}: ${result.message}`);
    if (result.busy) {
      vscode.window.showWarningMessage(BUSY_TEXT);
    } else if (!result.ok) {
      vscode.window.showErrorMessage(`Team plugins: ${result.message}`);
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
  reg('teamPlugins.shareWithTeam', shareCommand);
  reg('teamPlugins.commitAndPush', commitAndPushCommand);
  reg('teamPlugins.pushToBranch', pushToBranchCommand);
  reg('teamPlugins.openChange', openChangeCommand);
  reg('teamPlugins.openConflict', openConflictCommand);
  reg('teamPlugins.keepRepositoryVersion', (node) => resolveConflictCommand(node, 'source'));
  reg('teamPlugins.keepCopyVersion', (node) => resolveConflictCommand(node, 'copy'));
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      async provideTextDocumentContent(uri) {
        try {
          const request = JSON.parse(decodeURIComponent(uri.query));
          const d =
            request && typeof request.repo === 'string' && request.repo
              ? listConfigured().find((x) => isManaged(x) && samePath(x.dir, request.repo))
              : undefined;
          if (!d) {
            return '';
          }
          const args = sync.headFileArgs(request, d.dir);
          if (!args) {
            return '';
          }
          const r = await makeGit(gitPath())(args, d.dir, undefined, { trim: false });
          return r.code === 0 ? r.stdout : '';
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

function gitUri(repo, rev, file) {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${file}`,
    query: encodeURIComponent(JSON.stringify({ repo, rev, path: file })),
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
  const [message, detail, button] =
    keep === 'source'
      ? [`Keep the repository version of ${node.plugin}/${node.rel}?`, "The partial copy's version is replaced.", 'Keep repository version']
      : [`Keep the partial copy version of ${node.plugin}/${node.rel}?`, "The repository's version is replaced.", 'Keep copy version'];
  const choice = await vscode.window.showWarningMessage(message, { modal: true, detail }, button);
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
        vscode.window.showInformationMessage(`${node.plugin}/${node.rel} is no longer in conflict.`);
        return;
      }
      const lockFile = lockOf(entry.plugin.repoKey);
      if (!lockFile) {
        log(`conflict of a repository that is no longer configured: ${node.rel}`);
        return;
      }
      const locked = sync.withLockSync(lockFile, () => resolveConflict(entry.plugin, entry.ids, entry.holder, node.rel, keep));
      if (locked.kind === 'busy') {
        vscode.window.showWarningMessage(BUSY_TEXT);
        return;
      }
      const a = locked.value;
      logCopyActions(entry.plugin, [a]);
      entry.conflicts = (entry.conflicts || []).filter((c) => c.rel !== node.rel);
      updateConflicts();
      await refreshChanges();
      updateStatus();
    } catch (err) {
      vscode.window.showErrorMessage(`Team plugins: ${err.message}`);
    }
  });
}

function askCommitMessage(d) {
  return vscode.window.showInputBox({
    prompt: `Commit message for your changes to ${labelOf(d)}`,
    placeHolder: 'Update the review skill',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Enter a commit message'),
  });
}

// Shows the outcome of commitAndPush / pushToBranch on the repository d.
function reportContribution(result, nothingText, d) {
  switch (result.kind) {
    case 'pushed':
      vscode.window.showInformationMessage(
        `Pushed ${String(result.head).slice(0, 7)} to ${result.branch}: the team gets it at their next sync.`,
      );
      break;
    case 'pushedBranch': {
      const merge = `git fetch ${result.remote}\ngit merge ${result.remote}/${result.branch}`;
      vscode.window
        .showInformationMessage(
          `Pushed your changes to branch ${result.branch}. The managed clone is back on the team version. To merge, in your own clone: git fetch ${result.remote} && git merge ${result.remote}/${result.branch}`,
          'Copy merge commands',
        )
        .then((choice) => (choice === 'Copy merge commands' ? vscode.env.clipboard.writeText(merge) : undefined));
      break;
    }
    case 'nothing':
      vscode.window.showInformationMessage(nothingText);
      break;
    case 'busy':
      vscode.window.showWarningMessage(BUSY_TEXT);
      break;
    case 'conflict':
      vscode.window
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
    vscode.window.showInformationMessage(NOT_MANAGED);
    return undefined;
  }
  await flushPartials();
  await refreshChanges();
  const d = await pickRepo(arg, { filter: hasWork, placeHolder });
  if (!d) {
    vscode.window.showInformationMessage(nothingText);
    return undefined;
  }
  if (d.kind !== 'managed') {
    vscode.window.showInformationMessage(NOT_MANAGED);
    return undefined;
  }
  const s = stateOf(d.key);
  if (changesUnreadable(s, d)) {
    return undefined;
  }
  if (!hasChanges(s)) {
    vscode.window.showInformationMessage(nothingText);
    return undefined;
  }
  return d;
}

async function commitAndPushCommand(arg) {
  const d = await pickToContribute(arg, {
    placeHolder: 'Repository to commit and push',
    nothingText: 'Nothing to commit or push.',
  });
  if (!d) {
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
    const choice = await vscode.window.showWarningMessage(
      `Push ${changes.ahead} unpushed commit(s) of ${labelOf(d)} to the team?`,
      { modal: true },
      'Push',
    );
    if (choice !== 'Push') {
      return;
    }
  }
  const result =
    (await enqueue(() =>
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
    )) || UNEXPECTED;
  reportContribution(result, 'Nothing to commit or push.', d);
  await refresh({ sync: false });
}

async function pushToBranchCommand(arg) {
  const d = await pickToContribute(arg, { placeHolder: 'Repository to push', nothingText: 'Nothing to push.' });
  if (!d) {
    return;
  }
  const { changes } = stateOf(d.key);
  const run = makeGit(gitPath());
  const name = await run(['config', 'user.name'], d.dir);
  const branch = await vscode.window.showInputBox({
    prompt: 'Branch to push your changes to (merge it later from your own clone)',
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
  const result =
    (await enqueue(() =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Team plugins: pushing to a branch…' },
        async () => {
          const r = await contribute.pushToBranch({
            run,
            repo: d.dir,
            message,
            branch: branch.trim(),
            lockFile: d.lockFile,
            stateFile: d.stateFile,
            repoUrl: d.url,
            log,
          });
          if (r.kind === 'pushedBranch') {
            resetPartialCopies(d.key);
          }
          return r;
        },
      ),
    )) || UNEXPECTED;
  reportContribution(result, 'Nothing to push.', d);
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
  vscode.window
    .showWarningMessage(text, 'Uninstall it')
    .then(async (choice) => {
      if (choice !== 'Uninstall it') {
        return;
      }
      await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', OLD_EXTENSION_ID);
      log(`uninstalled ${OLD_EXTENSION_ID}`);
      const reload = await vscode.window.showInformationMessage(
        `${OLD_EXTENSION_ID} is uninstalled. Reload the window to finish.`,
        'Reload window',
      );
      if (reload === 'Reload window') {
        await vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    })
    .then(undefined, (err) => {
      log(`old extension uninstall error: ${err.message}`);
      vscode.window.showErrorMessage(
        `Could not uninstall ${OLD_EXTENSION_ID}: ${err.message}. Uninstall "Team plugins" by mg from the Extensions view.`,
      );
    });
  return true;
}

function activate(context) {
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
      // one click at a time: each reads the selection after the previous click's settings write
      checkboxChain = checkboxChain
        .then(() => onCheckboxChange(e))
        .catch((err) => log(`checkbox error: ${err.message}`));
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
    vscode.window.showErrorMessage(
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
