'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { readCatalog } = require('./lib/catalog');
const selection = require('./lib/selection');
const { buildTree } = require('./lib/treeModel');
const { filteredDirName, materialize, gcFiltered } = require('./lib/materialize');
const { makeGit } = require('./lib/git');
const sync = require('./lib/sync');
const { pluginApi } = require('./lib/cursorApi');
const { Registrar } = require('./lib/registrar');

const SECTION = 'teamPlugins';
const VIEW_COMMAND = 'workbench.view.extension.teamPlugins';

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
let watchers = [];
let debounceTimer = null;
let queue = Promise.resolve();
let storage = '';
let errorShown = false;
const projectNoticeShown = new Set();
const dirtyShown = new Set();
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

function refresh({ sync: doSync, userInitiated = false } = {}) {
  return enqueue(() => doRefresh(doSync, userInitiated));
}

async function doRefresh(doSync, userInitiated) {
  const m = currentMode();
  if (m.mode === 'unconfigured') {
    await vscode.commands.executeCommand('setContext', 'teamPlugins.state', 'unconfigured');
    lastResult = null;
    await doApply();
    return;
  }
  await vscode.commands.executeCommand('setContext', 'teamPlugins.state', 'ready');
  if (doSync) {
    const run = makeGit(gitPath());
    if (m.mode === 'managed') {
      const p = paths();
      const hadClone = fs.existsSync(path.join(p.managedRepo, '.git'));
      syncing = true;
      updateStatus();
      try {
        lastResult = await sync.syncManaged({
          run,
          managedRepo: p.managedRepo,
          repoUrl: m.repoUrl,
          branch: m.branch,
          lockFile: p.lockFile,
          stateFile: p.stateFile,
          log,
        });
      } finally {
        syncing = false;
      }
      lastCheck = new Date();
      if (lastResult.kind === 'busy') {
        readStateFile(); // another window is syncing: show what it recorded last; its next write re-applies here
      }
      notifyAfterSync(lastResult, { hadClone, userInitiated, run, repoDir: p.managedRepo });
    } else {
      lastResult = await sync.localStatus({ run, repoDir: m.repoDir });
      lastCheck = new Date();
    }
  }
  await doApply();
}

function notifyAfterSync(result, { hadClone, userInitiated, run, repoDir }) {
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
        `Team plugins updated (${result.commits} new commit(s)). Start a new chat to use the changes.`,
        'What changed',
      ).then(async (choice) => {
        if (choice === 'What changed') {
          const text = await sync.changesBetween({ run, repoDir, from: result.from, to: result.to });
          output.appendLine(text);
          output.show();
        }
      });
      break;
    case 'dirty':
    case 'diverged': {
      const key = `${result.kind}:${result.head}`;
      if (dirtyShown.has(key)) {
        break;
      }
      dirtyShown.add(key);
      const message =
        result.kind === 'dirty'
          ? `Team plugins: the managed clone has local changes, so updates are paused (${result.behind} commit(s) behind).`
          : 'Team plugins: the managed clone has local commits, so updates are paused.';
      ask('showWarningMessage', message, 'Discard local changes', 'Show log').then((choice) => {
        if (choice === 'Discard local changes') {
          vscode.commands.executeCommand('teamPlugins.discardLocalChanges');
        } else if (choice === 'Show log') {
          output.show();
        }
      });
      break;
    }
    case 'error':
      if (userInitiated || !errorShown) {
        errorShown = true;
        ask('showErrorMessage', `Team plugins: ${result.message}`, 'Show log').then((choice) => {
          if (choice === 'Show log') {
            output.show();
          }
        });
      }
      break;
    default:
      break;
  }
}

// Filtered copies are shared by windows with the same selection; each window touches the ones it registered at each
// apply, and copies nobody touched for a week are removed.
const FILTERED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  const desired = selection.desiredRegistrations(catalog, eff, (plugin, ids) => {
    try {
      return materialize(plugin, ids, path.join(filteredRoot, filteredDirName(plugin, ids)));
    } catch (err) {
      log(`cannot build the filtered copy of ${plugin.name}: ${err.message}`);
      return null;
    }
  });
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
  treeProvider.refresh();
  updateStatus();
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
    (lastResult && ['dirty', 'diverged', 'error'].includes(lastResult.kind)) ||
    lastApplyErrors > 0
  ) {
    text = `$(warning) Team ${count}`;
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
const TREE_ICONS = { plugin: 'package', skill: 'sparkle', rule: 'law', error: 'warning' };

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
    if (catalog.plugins.length === 0 && lastResult && lastResult.kind === 'error') {
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
    return buildTree(catalog, eff, project);
  }

  getTreeItem(node) {
    const item = new vscode.TreeItem(
      node.label,
      node.children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue = node.contextValue;
    if (TREE_ICONS[node.kind]) {
      item.iconPath = new vscode.ThemeIcon(TREE_ICONS[node.kind]);
    }
    if (node.kind === 'error') {
      item.command = { command: 'teamPlugins.showLog', title: 'Show log' };
    } else {
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
    if (node.kind === 'error') {
      continue;
    }
    const checked = state === vscode.TreeItemCheckboxState.Checked;
    user = selection.toggle(catalog, user, node.id, checked);
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
    const owner = catalog.plugins.find((p) => p.name === node.id || p.children.some((c) => c.id === node.id));
    const info = owner && eff.get(owner.name);
    if (!info) {
      continue;
    }
    const stays =
      node.kind === 'plugin' ? info.projectPlugin || info.fromProject.size > 0 : info.fromProject.has(node.id);
    if (!stays || projectNoticeShown.has(node.id)) {
      continue;
    }
    projectNoticeShown.add(node.id);
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
    selection.addToProject(catalog, list, node.id),
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
      const next = selection.removeFromProject(catalog, list, node.id);
      if (!same(list, next)) {
        await config.update('projectPlugins', next, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
  }
  const config = cfg();
  const inspected = config.inspect('projectPlugins');
  if (inspected && Array.isArray(inspected.workspaceValue)) {
    const list = stringList(inspected.workspaceValue);
    const next = selection.removeFromProject(catalog, list, node.id);
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
  timer = setInterval(() => refresh({ sync: true }), minutes * 60000);
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
  } else if (m.mode === 'local') {
    const w = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(m.localRepoPath), '**/*'),
    );
    // .git changes (fetch, the editor's own git status) don't change plugin files
    const onFile = (uri) => {
      if (!/[\\/]\.git([\\/]|$)/.test(uri.fsPath)) {
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
    const choice = await vscode.window.showWarningMessage(
      'Discard all local changes in the managed clone? Edits made there are deleted.',
      { modal: true },
      'Discard',
    );
    if (choice !== 'Discard') {
      return;
    }
    const result = await sync.discardLocalChanges({ run: makeGit(gitPath()), managedRepo: paths().managedRepo });
    log(`discard local changes: ${result.message}`);
    if (!result.ok) {
      vscode.window.showErrorMessage(`Team plugins: ${result.message}`);
    }
    await refresh({ sync: true, userInitiated: true });
  });
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
      onCheckboxChange(e).catch((err) => log(`checkbox error: ${err.message}`));
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
      if (
        e.affectsConfiguration('teamPlugins.repoUrl') ||
        e.affectsConfiguration('teamPlugins.branch') ||
        e.affectsConfiguration('teamPlugins.localRepoPath') ||
        e.affectsConfiguration('git.path')
      ) {
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
}

async function deactivate() {
  stopTimer();
  stopWatchers();
  if (registrar) {
    await registrar.removeAll();
  }
}

module.exports = { activate, deactivate };
