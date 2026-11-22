'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('./lib/catalog');
const selection = require('./lib/selection');
const { buildTree, buildChangesNode, buildConflictsNode } = require('./lib/treeModel');
const { holderName, copyRootOf, syncCopy, markCopySynced, resolveConflict, gcFiltered } = require('./lib/materialize');
const { makeGit } = require('./lib/git');
const sync = require('./lib/sync');
const contribute = require('./lib/contribute');
const { pluginApi } = require('./lib/cursorApi');
const { Registrar } = require('./lib/registrar');

const SECTION = 'teamPlugins';
const VIEW_COMMAND = 'workbench.view.extension.teamPlugins';
const BUSY_TEXT = 'Another Cursor window is syncing the team plugins: try again in a moment.';
const UNEXPECTED = { kind: 'error', message: 'unexpected error: see the log' };
const COPY_RETRY_MS = 2000;
const COPY_RETRY_MAX = 30;
const LOCKED_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const OFFLINE_RETRY_MS = 5 * 60 * 1000;

let output;
let statusItem;
let treeProvider;
let treeView;
let registrar = null;
let api = null;
let catalog = { plugins: [], warnings: [] };
let lastResult = null; // result of the last sync (this window's or, from the state file, another window's)
let lastCheck = null;
let lastApplyErrors = 0;
let syncing = false;
let timer = null;
let offlineTimer = null;
let watchers = [];
let debounceTimer = null;
let queue = Promise.resolve();
let storage = '';
let errorShown = false;
let changes = null; // { files, ahead } of the managed clone, null outside managed mode
let partialCopies = new Map(); // plugin name -> { plugin, ids, holder, copyRoot, conflicts: [{ rel, source, copy }] }
let copyConflicts = []; // the conflicts of all partial copies, as given to buildConflictsNode
let copyWatcher = null;
let copyDebounce = null;
let copyRetryTimer = null;
let copyRetries = 0;
let checkboxChain = Promise.resolve();
const projectNoticeShown = new Set();
const conflictShown = new Set();
const conflictsNotified = new Set(); // `${holder}|${rel}` of the partial-copy conflicts already announced
const loggedWarnings = new Set();

function log(message) {
  if (output) {
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

// ---- paths and settings ------------------------------------------------------------------------------------------

function paths() {
  const pluginsRoot = path.join(storage, '.cursor', 'plugins');
  return {
    pluginsRoot,
    managedRepo: path.join(pluginsRoot, 'repo'),
    filteredRoot: path.join(pluginsRoot, 'filtered'),
    lockFile: path.join(storage, 'sync.lock'),
    stateFile: path.join(storage, 'sync-state.json'),
  };
}

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
}

function settings() {
  const c = cfg();
  return {
    repoUrl: String(c.get('repoUrl') || '').trim(),
    branch: String(c.get('branch') || '').trim(),
    localRepoPath: String(c.get('localRepoPath') || '').trim(),
    intervalMinutes: Number(c.get('updateIntervalMinutes')) || 0,
  };
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

// { mode: 'local' | 'managed' | 'unconfigured', repoDir }
function currentMode() {
  const s = settings();
  if (s.localRepoPath) {
    return { mode: 'local', repoDir: s.localRepoPath, ...s };
  }
  if (s.repoUrl) {
    return { mode: 'managed', repoDir: paths().managedRepo, ...s };
  }
  return { mode: 'unconfigured', repoDir: null, ...s };
}

function userSelection() {
  const c = cfg();
  return { enabled: stringList(c.get('enabled')), excluded: stringList(c.get('excluded')) };
}

function uniqSorted(list) {
  return [...new Set(list)].sort();
}

function projectList() {
  const all = [];
  const top = cfg().inspect('projectPlugins');
  all.push(...stringList(top && top.workspaceValue));
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const inspected = vscode.workspace.getConfiguration(SECTION, folder.uri).inspect('projectPlugins');
    all.push(...stringList(inspected && inspected.workspaceFolderValue));
  }
  return uniqSorted(all);
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

function refresh({ sync: doSync, userInitiated = false, check = false } = {}) {
  return enqueue(() => doRefresh(doSync, userInitiated, check));
}

async function doRefresh(doSync, userInitiated, check) {
  const m = currentMode();
  if (m.mode === 'unconfigured') {
    await vscode.commands.executeCommand('setContext', 'teamPlugins.state', 'unconfigured');
    lastResult = null;
    scheduleOfflineRetry();
    await doApply();
    return;
  }
  await vscode.commands.executeCommand('setContext', 'teamPlugins.state', 'ready');
  if (doSync) {
    const run = makeGit(gitPath());
    if (m.mode === 'managed') {
      const p = paths();
      const hadClone = fs.existsSync(path.join(p.managedRepo, '.git'));
      let checkFailed = false;
      syncing = true;
      updateStatus();
      try {
        if (check) {
          // a new URL or branch: say at once whether the server answers, before the (possibly long) clone or fetch
          const c = await sync.checkRemote({
            run,
            cwd: storage,
            repoUrl: m.repoUrl,
            branch: m.branch,
            idleMs: sync.CHECK_IDLE_MS,
          });
          if (c.kind !== 'reachable') {
            lastResult = c;
            checkFailed = true;
          } else if (vscode.window.state.focused) {
            vscode.window.showInformationMessage(
              `Team plugins: ${m.repoUrl} is reachable${c.empty ? ' (empty repository)' : ''}. ${
                hadClone ? 'Updating' : 'Cloning it'
              } in the background.`,
            );
          }
        }
        if (!checkFailed) {
          lastResult = await sync.syncManaged({
            run,
            managedRepo: p.managedRepo,
            repoUrl: m.repoUrl,
            branch: m.branch,
            lockFile: p.lockFile,
            stateFile: p.stateFile,
            log,
          });
        }
      } finally {
        syncing = false;
      }
      lastCheck = new Date();
      if (checkFailed) {
        // only the window the user is looking at answers a settings change
        if (vscode.window.state.focused) {
          notifyAfterSync(lastResult, { hadClone, userInitiated: true, run, repoDir: p.managedRepo });
        } else {
          log(`repository check failed: ${lastResult.message}`);
        }
      } else {
        if (lastResult.kind === 'busy') {
          readStateFile(); // another window is syncing: show what it recorded last; its next write re-applies here
        }
        if (lastResult.kind === 'cloned') {
          startWatchers(); // the clone watcher was created before the folder existed
        }
        notifyAfterSync(lastResult, { hadClone, userInitiated, run, repoDir: p.managedRepo });
        if (lastResult.kind === 'switched') {
          log(`managed clone now follows ${m.repoUrl} (${lastResult.branch})`);
        }
      }
      scheduleOfflineRetry();
    } else {
      lastResult = await sync.localStatus({ run, repoDir: m.repoDir });
      lastCheck = new Date();
      scheduleOfflineRetry();
    }
  }
  await doApply();
}

// The buttons of a classified remote error (lib/remoteErrors.js `actions`).
const ACTIONS = {
  terminal: { label: 'Open terminal', run: () => openGitTerminal() },
  retry: { label: 'Sync now', run: () => vscode.commands.executeCommand('teamPlugins.syncNow') },
  showLog: { label: 'Show log', run: () => output.show() },
  setUrl: { label: 'Set repository URL', run: () => vscode.commands.executeCommand('teamPlugins.setRepoUrl') },
  branchSetting: {
    label: 'Open settings',
    run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'teamPlugins.branch'),
  },
  pushToBranch: { label: 'Push to a branch', run: () => vscode.commands.executeCommand('teamPlugins.pushToBranch') },
  retryPush: { label: 'Try again', run: () => vscode.commands.executeCommand('teamPlugins.commitAndPush') },
};

function showRemoteError(result) {
  const ids = (result.actions || []).filter((id) => ACTIONS[id]);
  if (!ids.includes('showLog')) {
    ids.push('showLog');
  }
  vscode.window
    .showErrorMessage(`Team plugins: ${result.message}`, ...ids.map((id) => ACTIONS[id].label))
    .then((choice) => {
      const id = ids.find((i) => ACTIONS[i].label === choice);
      if (id) {
        return ACTIONS[id].run();
      }
      return undefined;
    });
}

// A terminal where git can ask what it can't ask in the background (SSH host key or passphrase, credential manager
// sign-in). No shell: git is the terminal's process, so the URL needs no quoting.
function openGitTerminal() {
  const url = settings().repoUrl;
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
  const m = currentMode();
  if (m.mode === 'managed' && m.intervalMinutes > 0 && lastResult && lastResult.kind === 'offline') {
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      timedSync(Math.max(5, m.intervalMinutes) * 60000);
    }, OFFLINE_RETRY_MS);
  }
}

function notifyAfterSync(result, { hadClone, userInitiated, run, repoDir }) {
  if (!['error', 'busy', 'offline'].includes(result.kind)) {
    errorShown = false; // a recovery re-arms the error notice
  }
  const ask = (kind, message, ...buttons) => vscode.window[kind](message, ...buttons);
  switch (result.kind) {
    case 'cloned':
      if (!hadClone) {
        ask(
          'showInformationMessage',
          'Team plugins: repository cloned. Pick your plugins in the Team Plugins view.',
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
        `Team plugins updated (${result.commits} new commit(s)). Start a new chat to use the changes.${
          result.kept > 0 ? ' Your local changes were kept.' : ''
        }`,
        'What changed',
      ).then(async (choice) => {
        if (choice === 'What changed') {
          const text = await sync.changesBetween({ run, repoDir, from: result.from, to: result.to });
          output.appendLine(text);
          output.show();
        }
      });
      break;
    case 'conflict': {
      const key = `conflict:${result.head}|${result.upstream || ''}|${result.files.join(',')}`;
      if (conflictShown.has(key)) {
        break;
      }
      conflictShown.add(key);
      const shown = result.files.slice(0, 3).join(', ');
      const more = result.files.length > 3 ? ` and ${result.files.length - 3} more` : '';
      ask(
        'showWarningMessage',
        `Team plugins: ${result.behind} new team commit(s) conflict with your changes in ${shown}${more}, so updates are paused. Push your changes to a branch to merge them in your own clone, or discard them.`,
        'Push to a branch',
        'Show changes',
        'Discard local changes',
      ).then((choice) => {
        if (choice === 'Push to a branch') {
          vscode.commands.executeCommand('teamPlugins.pushToBranch');
        } else if (choice === 'Show changes') {
          vscode.commands.executeCommand(VIEW_COMMAND);
        } else if (choice === 'Discard local changes') {
          vscode.commands.executeCommand('teamPlugins.discardLocalChanges');
        }
      });
      break;
    }
    case 'offline':
      // a server that doesn't answer is quiet when a clone exists: the plugins keep working and the next update retries
      if (userInitiated || (!hadClone && !errorShown)) {
        errorShown = true;
        showRemoteError(result);
      } else {
        log(`update skipped: ${result.message}`);
      }
      break;
    case 'error':
      if (userInitiated || !errorShown) {
        errorShown = true;
        showRemoteError(result);
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
  const m = currentMode();
  if (m.mode === 'unconfigured') {
    catalog = { plugins: [], warnings: [] };
  } else {
    catalog = readCatalog(m.repoDir);
    for (const w of catalog.warnings) {
      if (!loggedWarnings.has(w)) {
        loggedWarnings.add(w);
        log(`catalog warning: ${w}`);
      }
    }
  }
  const user = userSelection();
  const project = projectList();
  const eff = selection.effective(catalog, user, project);
  const { filteredRoot } = paths();
  const copies = new Map();
  const previous = partialCopies;
  let retry = '';
  const build = (synced) =>
    selection.desiredRegistrations(catalog, eff, (plugin, ids) => {
      const holder = path.join(filteredRoot, holderName(plugin, ids));
      const copyRoot = copyRootOf(plugin, holder);
      const keep = () => {
        const old = [...previous.values()].find((e) => e.holder === holder);
        copies.set(plugin.name, { plugin, ids, holder, copyRoot, conflicts: old ? old.conflicts : [] });
        return copyRoot;
      };
      if (!synced && fs.existsSync(copyRoot)) {
        retry = 'another window holds the sync lock';
        return keep();
      }
      try {
        const { actions, conflicts, skipped } = syncCopy(plugin, ids, holder);
        logCopyActions(plugin, actions);
        logSkipped(plugin, skipped);
        copies.set(plugin.name, { plugin, ids, holder, copyRoot, conflicts });
        return copyRoot;
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
  // a missing copy is still built when the lock is busy: building writes only under filtered/
  const locked = withCopyLock(() => build(true));
  const desired = locked.kind === 'busy' ? build(false) : locked.value;
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
  lastApplyErrors = 0;
  if (registrar) {
    const result = await registrar.apply(desired);
    lastApplyErrors = result.errors.length;
    const holders = filteredHolders(filteredRoot, [...desired.values()]);
    touchFiltered(holders);
    gcFiltered(filteredRoot, holders, FILTERED_MAX_AGE_MS);
  }
  await refreshChanges();
  updateStatus();
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

// Partial-copy syncs and conflict choices hold the sync lock in every mode: windows with the same selection share a
// copy (in managed mode they also write into the clone).
function withCopyLock(fn) {
  return sync.withLockSync(paths().lockFile, fn);
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

// Reads the local changes of the managed clone (shown as a group in the view; they enable Commit and push).
async function refreshChanges() {
  const m = currentMode();
  changes = null;
  if (m.mode === 'managed' && fs.existsSync(path.join(m.repoDir, '.git'))) {
    try {
      changes = await sync.localChanges({ run: makeGit(gitPath()), repo: m.repoDir });
    } catch (err) {
      changes = { files: [], ahead: 0, error: err.message };
      const key = `changes:${err.message}`;
      if (!loggedWarnings.has(key)) {
        loggedWarnings.add(key);
        log(`cannot read the local changes: ${err.message}`);
      }
    }
  }
  await vscode.commands.executeCommand('setContext', 'teamPlugins.hasChanges', hasChanges());
  treeProvider.refresh();
}

function hasChanges() {
  return !!changes && (changes.files.length > 0 || changes.ahead > 0);
}

// Reports a local-changes read failure (true) so a command never says "nothing to commit" when git failed.
function changesUnreadable() {
  if (changes && changes.error) {
    vscode.window.showErrorMessage(`Team plugins: cannot read the local changes: ${changes.error}`, 'Show log')
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
      list.push({ plugin: entry.plugin.name, rel: c.rel, source: c.source, copy: c.copy, holder: entry.holder });
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
    const node = buildConflictsNode([c]).children[0];
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
  const locked = withCopyLock(() => {
    for (const entry of partialCopies.values()) {
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
    }
  });
  if (locked.kind === 'busy') {
    retry = 'another window holds the sync lock';
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

// After the clone was reset to the team version (discard, push to a branch), the partial copies take the clone's side
// at the next apply: left as they are, their edits (newer than the last sync) would be copied back into the clone.
// They are updated in place (markCopySynced), not deleted: Windows refuses to delete a folder Cursor watches.
function resetPartialCopies() {
  for (const entry of partialCopies.values()) {
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
  copyWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(filteredRoot), '**/*'),
  );
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
  copyWatcher.onDidCreate(onFile);
  copyWatcher.onDidChange(onFile);
  copyWatcher.onDidDelete(onFile);
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
  const m = currentMode();
  const count = registrar ? registrar.current.size : 0;
  let text;
  if (syncing) {
    text = '$(sync~spin) Team';
  } else if (m.mode === 'unconfigured') {
    text = '$(plug) Team: not configured';
  } else if (!api) {
    text = '$(error) Team';
  } else if (
    (lastResult && ['conflict', 'error'].includes(lastResult.kind)) ||
    lastApplyErrors > 0 ||
    copyConflicts.length > 0 ||
    (changes && changes.error)
  ) {
    text = `$(warning) Team ${count}`;
  } else if (lastResult && lastResult.kind === 'offline') {
    text = `$(debug-disconnect) Team ${count}`; // after the warnings: being offline is the least of them
  } else {
    text = `$(plug) Team ${count}`;
  }
  statusItem.text = text;

  const lines = ['Team plugins'];
  if (m.mode !== 'unconfigured') {
    const source = m.mode === 'local' ? m.localRepoPath : m.repoUrl;
    lines.push(`Repository: ${source} (${m.branch || 'default branch'})`);
  }
  if (lastResult && lastResult.head) {
    lines.push(`Commit: ${String(lastResult.head).slice(0, 7)}`);
  }
  if (lastCheck) {
    lines.push(`Last check: ${lastCheck.toTimeString().slice(0, 5)}`);
  }
  if (!api) {
    lines.push('State: vscode.cursor.plugins is missing in this Cursor');
  } else if (lastResult) {
    lines.push(`State: ${lastResult.kind}${lastResult.message ? ` - ${lastResult.message}` : ''}`);
  }
  if (hasChanges()) {
    lines.push(`Local changes: ${changes.files.length} file(s), ${changes.ahead} unpushed commit(s)`);
  }
  if (changes && changes.error) {
    lines.push('Local changes: cannot be read (see the log)');
  }
  if (copyConflicts.length > 0) {
    lines.push(`Partial copy conflicts: ${copyConflicts.length} (see the Conflicts group)`);
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
const TREE_ICONS = { plugin: 'package', skill: 'sparkle', rule: 'law', error: 'warning', changes: 'git-commit', conflicts: 'warning', conflict: 'git-merge' };
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
    const m = currentMode();
    if (m.mode === 'unconfigured') {
      return [];
    }
    if (catalog.plugins.length === 0 && lastResult && ['error', 'offline'].includes(lastResult.kind)) {
      return [
        {
          id: 'sync-error',
          kind: 'error',
          label: `Sync failed: ${lastResult.message}`,
          description: '',
          tooltip: lastResult.message,
          contextValue: 'error',
          children: [],
        },
      ];
    }
    const project = projectList();
    const eff = selection.effective(catalog, userSelection(), project);
    return [buildConflictsNode(copyConflicts), buildChangesNode(changes)]
      .filter((n) => n)
      .concat(buildTree(catalog, eff, project));
  }

  getTreeItem(node) {
    let state = vscode.TreeItemCollapsibleState.None;
    if (node.children.length) {
      state =
        node.kind === 'changes' || node.kind === 'conflicts'
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
    }
    const item = new vscode.TreeItem(node.label, state);
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    if (node.kind === 'change') {
      item.iconPath = new vscode.ThemeIcon(CHANGE_ICONS[node.status] || 'diff-modified');
    } else if (node.kind === 'changes' && node.error) {
      item.iconPath = new vscode.ThemeIcon('warning');
      item.command = { command: 'teamPlugins.showLog', title: 'Show log' };
    } else if (TREE_ICONS[node.kind]) {
      item.iconPath = new vscode.ThemeIcon(TREE_ICONS[node.kind]);
    }
    if (node.kind === 'error') {
      item.command = { command: 'teamPlugins.showLog', title: 'Show log' };
    } else if (node.kind === 'change') {
      item.command = { command: 'teamPlugins.openChange', title: 'Open changes', arguments: [node] };
    } else if (node.kind === 'conflict') {
      item.command = { command: 'teamPlugins.openConflict', title: 'Compare', arguments: [node] };
    } else if (node.kind !== 'changes' && node.kind !== 'conflicts') {
      item.checkboxState = node.checked
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
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
  const project = projectList();
  const unchecked = [];
  for (const [node, state] of e.items) {
    if (node.kind !== 'plugin' && node.kind !== 'skill' && node.kind !== 'rule') {
      continue;
    }
    const checked = state === vscode.TreeItemCheckboxState.Checked;
    user = selection.toggle(catalog, user, node.key, checked);
    if (!checked) {
      unchecked.push(node);
    }
  }
  const eff = selection.effective(catalog, user, project);
  const config = cfg();
  for (const key of ['enabled', 'excluded']) {
    if (JSON.stringify(user[key]) !== JSON.stringify(before[key])) {
      await config.update(key, user[key], vscode.ConfigurationTarget.Global);
    }
  }
  treeProvider.refresh();
  for (const node of unchecked) {
    const owner = catalog.plugins.find((p) => p.name === node.key || p.children.some((c) => c.id === node.key));
    const info = owner && eff.get(owner.name);
    if (!info) {
      continue;
    }
    const stays =
      node.kind === 'plugin' ? info.projectPlugin || info.fromProject.size > 0 : info.fromProject.has(node.key);
    if (!stays || projectNoticeShown.has(node.key)) {
      continue;
    }
    projectNoticeShown.add(node.key);
    vscode.window
      .showInformationMessage(
        `"${node.label}" stays enabled: this project requires it (teamPlugins.projectPlugins in .vscode/settings.json).`,
        'Remove from project',
      )
      .then((choice) => {
        if (choice === 'Remove from project') {
          return removeFromProjectCommand(node);
        }
        return undefined;
      });
  }
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
  const list = stringList(inspected && inspected.workspaceFolderValue);
  await config.update(
    'projectPlugins',
    selection.addToProject(catalog, list, node.key),
    vscode.ConfigurationTarget.WorkspaceFolder,
  );
}

async function removeFromProjectCommand(node) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const config = vscode.workspace.getConfiguration(SECTION, folder.uri);
    const inspected = config.inspect('projectPlugins');
    if (inspected && Array.isArray(inspected.workspaceFolderValue)) {
      const list = stringList(inspected.workspaceFolderValue);
      const next = selection.removeFromProject(catalog, list, node.key);
      if (!same(list, next)) {
        await config.update('projectPlugins', next, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }
  const config = cfg();
  const inspected = config.inspect('projectPlugins');
  if (inspected && Array.isArray(inspected.workspaceValue)) {
    const list = stringList(inspected.workspaceValue);
    const next = selection.removeFromProject(catalog, list, node.key);
    if (!same(list, next)) {
      await config.update('projectPlugins', next, vscode.ConfigurationTarget.Workspace);
    }
  }
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
  const m = currentMode();
  if (m.mode !== 'managed' || m.intervalMinutes <= 0) {
    return;
  }
  const minutes = Math.max(5, m.intervalMinutes);
  timer = setInterval(() => timedSync(minutes * 60000), minutes * 60000);
}

// A timed sync is skipped when another window synced less than half an interval ago (one fetch per interval, not one
// per window); the other window's state write reaches this window through the sync-state.json watcher.
function timedSync(intervalMs) {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(paths().stateFile, 'utf8'));
  } catch {
    // none yet
  }
  if (sync.recentlySynced(state, intervalMs)) {
    log(`timed sync skipped: another window synced at ${state.at}`);
    return;
  }
  refresh({ sync: true });
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

function readStateFile() {
  try {
    const state = JSON.parse(fs.readFileSync(paths().stateFile, 'utf8'));
    if (state && state.kind && state.kind !== 'busy') {
      lastResult = state;
      lastCheck = state.at ? new Date(state.at) : lastCheck;
    }
  } catch {
    // no state yet
  }
}

function startWatchers() {
  stopWatchers();
  const m = currentMode();
  if (m.mode === 'managed') {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(storage), 'sync-state.json'),
    );
    const onState = () => {
      if (!syncing) {
        readStateFile();
        debouncedApply();
      }
    };
    w.onDidCreate(onState);
    w.onDidChange(onState);
    watchers.push(w);

    // an edit inside the managed clone (an agent's, another window's partial copy, a direct edit) reaches this window's
    // catalog, partial copies and Local changes
    const c = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(m.repoDir), '**/*'),
    );
    const onClone = (uri) => {
      if (isGitPath(uri.fsPath)) {
        return;
      }
      debouncedApply();
    };
    c.onDidCreate(onClone);
    c.onDidChange(onClone);
    c.onDidDelete(onClone);
    watchers.push(c);
  } else if (m.mode === 'local') {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(m.localRepoPath), '**/*'),
    );
    // .git changes (fetch, the editor's own git status) don't change plugin files
    const onFile = (uri) => {
      if (!isGitPath(uri.fsPath)) {
        debouncedApply();
      }
    };
    w.onDidCreate(onFile);
    w.onDidChange(onFile);
    w.onDidDelete(onFile);
    watchers.push(w);
  }
}

// ---- activation --------------------------------------------------------------------------------------------------

function registerCommands(context) {
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('teamPlugins.syncNow', () => refresh({ sync: true, userInitiated: true }));
  reg('teamPlugins.openRepo', async () => {
    const m = currentMode();
    if (m.mode === 'unconfigured') {
      vscode.window.showInformationMessage('No repository configured.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(m.repoDir), { forceNewWindow: true });
  });
  reg('teamPlugins.showLog', () => output.show());
  reg('teamPlugins.setRepoUrl', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Git URL of the team plugins repository',
      value: settings().repoUrl,
      ignoreFocusOut: true,
    });
    if (value !== undefined) {
      await cfg().update('repoUrl', value.trim(), vscode.ConfigurationTarget.Global);
    }
  });
  reg('teamPlugins.setLocalRepoPath', async () => {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
    if (picked && picked.length > 0) {
      await cfg().update('localRepoPath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
    }
  });
  reg('teamPlugins.addToProject', (node) => addToProjectCommand(node));
  reg('teamPlugins.removeFromProject', (node) => removeFromProjectCommand(node));
  reg('teamPlugins.openItem', (node) => {
    if (node && node.file) {
      return vscode.window.showTextDocument(vscode.Uri.file(node.file));
    }
    return undefined;
  });
  reg('teamPlugins.discardLocalChanges', async () => {
    if (currentMode().mode !== 'managed') {
      vscode.window.showInformationMessage('There is no managed clone: a local clone is never changed by this extension.');
      return;
    }
    await flushPartials();
    await refreshChanges();
    if (changesUnreadable()) {
      return;
    }
    if (!hasChanges()) {
      vscode.window.showInformationMessage('Nothing to discard.');
      return;
    }
    const listed = changes.files.slice(0, 10).map((f) => `${f.status} ${f.path}`);
    let detail = `These are deleted:\n${listed.join('\n')}`;
    if (changes.files.length > 10) {
      detail += `\n\u2026 and ${changes.files.length - 10} more`;
    }
    if (changes.ahead > 0) {
      detail += `\n${changes.ahead} unpushed commit(s)`;
    }
    const choice = await vscode.window.showWarningMessage(
      'Discard all local changes in the managed clone?',
      { modal: true, detail },
      'Discard',
    );
    if (choice !== 'Discard') {
      return;
    }
    const p = paths();
    let result;
    await enqueue(async () => {
      result = await sync.discardLocalChanges({
        run: makeGit(gitPath()),
        managedRepo: p.managedRepo,
        lockFile: p.lockFile,
        log,
      });
      if (result.ok) {
        resetPartialCopies();
      }
    });
    result = result || { ok: false, message: UNEXPECTED.message };
    log(`discard local changes: ${result.message}`);
    if (result.busy) {
      vscode.window.showWarningMessage(BUSY_TEXT);
    } else if (!result.ok) {
      vscode.window.showErrorMessage(`Team plugins: ${result.message}`);
    }
    await refresh({ sync: true, userInitiated: true });
  });
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
          if (currentMode().mode !== 'managed') {
            return '';
          }
          const args = sync.headFileArgs(request, paths().managedRepo);
          if (!args) {
            return '';
          }
          const r = await makeGit(gitPath())(args, paths().managedRepo, undefined, { trim: false });
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

function gitUri(repo, rev, file) {
  return vscode.Uri.from({
    scheme: GIT_SCHEME,
    path: `/${file}`,
    query: encodeURIComponent(JSON.stringify({ repo, rev, path: file })),
  });
}

async function openChangeCommand(node) {
  const m = currentMode();
  if (!node || !node.path || m.mode !== 'managed') {
    return;
  }
  const isNew = node.status === 'added' || node.status === 'untracked';
  const left = gitUri(m.repoDir, isNew ? '' : 'HEAD', node.from || node.path);
  const right =
    node.status === 'deleted' ? gitUri(m.repoDir, '', node.path) : vscode.Uri.file(path.join(m.repoDir, node.path));
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(node.path)} (team \u2194 yours)`);
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
      const locked = withCopyLock(() => resolveConflict(entry.plugin, entry.ids, entry.holder, node.rel, keep));
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

function askCommitMessage() {
  return vscode.window.showInputBox({
    prompt: 'Commit message for your changes to the team plugins',
    placeHolder: 'Update the review skill',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? null : 'Enter a commit message'),
  });
}

// Shows the outcome of commitAndPush / pushToBranch.
function reportContribution(result, nothingText) {
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
            vscode.commands.executeCommand('teamPlugins.pushToBranch');
          } else if (choice === 'Open repository folder') {
            vscode.commands.executeCommand('teamPlugins.openRepo');
          }
        });
      break;
    default:
      showRemoteError(result);
      break;
  }
}

async function commitAndPushCommand() {
  if (currentMode().mode !== 'managed') {
    vscode.window.showInformationMessage(NOT_MANAGED);
    return;
  }
  await flushPartials();
  await refreshChanges();
  if (changesUnreadable()) {
    return;
  }
  if (!hasChanges()) {
    vscode.window.showInformationMessage('Nothing to commit or push.');
    return;
  }
  let message = '';
  if (changes.files.length > 0) {
    const typed = await askCommitMessage();
    if (typed === undefined) {
      return;
    }
    message = typed.trim();
  } else {
    const choice = await vscode.window.showWarningMessage(
      `Push ${changes.ahead} unpushed commit(s) to the team?`,
      { modal: true },
      'Push',
    );
    if (choice !== 'Push') {
      return;
    }
  }
  const p = paths();
  const result =
    (await enqueue(() =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Team plugins: committing and pushing\u2026' },
        () =>
          contribute.commitAndPush({
            run: makeGit(gitPath()),
            repo: p.managedRepo,
            message,
            lockFile: p.lockFile,
            stateFile: p.stateFile,
            repoUrl: currentMode().repoUrl,
            log,
          }),
      ),
    )) || UNEXPECTED;
  reportContribution(result, 'Nothing to commit or push.');
  await refresh({ sync: false });
}

async function pushToBranchCommand() {
  if (currentMode().mode !== 'managed') {
    vscode.window.showInformationMessage(NOT_MANAGED);
    return;
  }
  await flushPartials();
  await refreshChanges();
  if (changesUnreadable()) {
    return;
  }
  if (!hasChanges()) {
    vscode.window.showInformationMessage('Nothing to push.');
    return;
  }
  const p = paths();
  const run = makeGit(gitPath());
  const name = await run(['config', 'user.name'], p.managedRepo);
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
    const typed = await askCommitMessage();
    if (typed === undefined) {
      return;
    }
    message = typed.trim();
  }
  const result =
    (await enqueue(() =>
      vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Team plugins: pushing to a branch\u2026' },
        async () => {
          const r = await contribute.pushToBranch({
            run,
            repo: p.managedRepo,
            message,
            branch: branch.trim(),
            lockFile: p.lockFile,
            stateFile: p.stateFile,
            repoUrl: currentMode().repoUrl,
            log,
          });
          if (r.kind === 'pushedBranch') {
            resetPartialCopies();
          }
          return r;
        },
      ),
    )) || UNEXPECTED;
  reportContribution(result, 'Nothing to push.');
  await refresh({ sync: true });
}

function activate(context) {
  storage = context.globalStorageUri.fsPath;
  fs.mkdirSync(storage, { recursive: true });

  output = vscode.window.createOutputChannel('Team Plugins');
  context.subscriptions.push(output);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem.command = VIEW_COMMAND;
  statusItem.text = '$(plug) Team';
  statusItem.show();
  context.subscriptions.push(statusItem);

  treeProvider = new PluginTree();
  treeView = vscode.window.createTreeView('teamPlugins.plugins', {
    treeDataProvider: treeProvider,
    manageCheckboxStateManually: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);
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
    statusItem.text = '$(error) Team';
    vscode.window.showErrorMessage(
      'Team plugins: this Cursor cannot register plugins from extensions (vscode.cursor.plugins is missing). Update Cursor.',
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('teamPlugins.repoUrl') || e.affectsConfiguration('teamPlugins.branch')) {
        startWatchers();
        startTimer();
        refresh({ sync: true, check: true });
      } else if (e.affectsConfiguration('teamPlugins.localRepoPath') || e.affectsConfiguration('git.path')) {
        startWatchers();
        startTimer();
        refresh({ sync: true });
      } else if (
        e.affectsConfiguration('teamPlugins.enabled') ||
        e.affectsConfiguration('teamPlugins.excluded') ||
        e.affectsConfiguration('teamPlugins.projectPlugins')
      ) {
        apply();
      } else if (e.affectsConfiguration('teamPlugins.updateIntervalMinutes')) {
        startTimer();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => apply()),
  );

  refresh({ sync: true });
  startTimer();
  startWatchers();
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
