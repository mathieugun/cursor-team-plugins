'use strict';

const path = require('path');
const { baseName } = require('./repos');

const PROJECT_LINES = {
  all: 'Enabled by this project (.vscode/settings.json)',
  some: 'Partly enabled by this project (.vscode/settings.json)',
};

// What a plugin's item row shows after its name.
const KIND_LABELS = { skill: 'skill', rule: 'rule', command: 'command', agent: 'agent', mcp: 'MCP server' };

function withProjectLine(text, state) {
  return state ? `${text}\n${PROJECT_LINES[state]}` : text;
}

// draft: the catalog is that of the drafts folder (its plugins and items get the `.draft` context values).
function buildTree(catalog, eff, project, { draft = false } = {}) {
  const proj = new Set(project || []);
  return catalog.plugins.map((plugin) => {
    const e = eff.get(plugin.name) || { active: false, full: false, included: new Set(), fromProject: new Set() };
    const inProject = proj.has(plugin.name) || plugin.children.some((c) => proj.has(c.id));
    const partial = plugin.children.length > 0 && e.active && !e.full;
    let projectState = null;
    if (e.fromProject.size > 0) {
      projectState = [...e.included].every((id) => e.fromProject.has(id)) ? 'all' : 'some';
    }
    const parts = [];
    if (plugin.version) {
      parts.push(`v${plugin.version}`);
    }
    if (partial) {
      parts.push(`${e.included.size}/${plugin.children.length}`);
    }
    return {
      id: `plugin:${plugin.name}`,
      key: plugin.name,
      kind: 'plugin',
      label: plugin.displayName,
      description: parts.join(' · '),
      tooltip: withProjectLine(plugin.description || plugin.name, projectState),
      checked: plugin.children.length > 0 ? e.full : e.active,
      partial,
      checkboxTooltip: partial
        ? `Partly enabled: ${e.included.size} of ${plugin.children.length} items. Tick to enable all.`
        : '',
      project: projectState,
      contextValue: draft ? 'plugin.draft' : inProject ? 'plugin.project' : 'plugin',
      children: plugin.children.map((c) => {
        const childProject = e.fromProject.has(c.id) ? 'all' : null;
        return {
          id: `item:${c.id}`,
          key: c.id,
          kind: c.kind,
          label: c.name,
          description: KIND_LABELS[c.kind] || c.kind,
          tooltip: withProjectLine(c.description || path.basename(c.file), childProject),
          checked: e.included.has(c.id),
          partial: false,
          checkboxTooltip: '',
          project: childProject,
          contextValue: draft ? 'child.draft' : childProject ? 'child.project' : 'child',
          file: c.file,
          children: [],
        };
      }),
    };
  });
}

// The group of local changes of a managed clone (null when there are none; a node without children and with the
// error when git could not read them, so a failure never looks like "no changes"). repoKey: the repository's key.
function buildChangesNode(changes, repoKey) {
  if (changes && changes.error) {
    return {
      id: `changes:${repoKey}`,
      kind: 'changes',
      repo: repoKey,
      label: 'Local changes',
      description: 'cannot be read: see the log',
      tooltip: changes.error,
      contextValue: 'changes.error',
      error: changes.error,
      children: [],
    };
  }
  if (!changes || (changes.files.length === 0 && changes.ahead === 0)) {
    return null;
  }
  const parts = [];
  if (changes.files.length > 0) {
    parts.push(`${changes.files.length} file(s)`);
  }
  if (changes.ahead > 0) {
    parts.push(`${changes.ahead} unpushed commit(s)`);
  }
  return {
    id: `changes:${repoKey}`,
    kind: 'changes',
    repo: repoKey,
    label: 'Local changes',
    description: parts.join(' · '),
    tooltip: 'Changes in the managed clone that the team does not have yet. Commit and push them to share them.',
    contextValue: 'changes',
    children: changes.files.map((f) => {
      const dir = path.posix.dirname(f.path);
      const node = {
        id: `change:${repoKey}|${f.path}`,
        kind: 'change',
        repo: repoKey,
        label: path.posix.basename(f.path),
        description: dir && dir !== '.' ? `${dir} · ${f.status}` : f.status,
        tooltip: f.path,
        contextValue: 'change',
        path: f.path,
        status: f.status,
        children: [],
      };
      if (f.from !== undefined) {
        // a rename: the diff compares the old path of HEAD with the new file
        node.from = f.from;
        node.tooltip = `${f.from} \u2192 ${f.path}`;
      }
      return node;
    }),
  };
}

// The group of partial-copy files changed both in the repository and in the copy (null when there are none).
// conflicts: [{ plugin (name), rel, source, copy, holder }]; repoKey: the repository's key.
function buildConflictsNode(conflicts, repoKey) {
  if (!conflicts || conflicts.length === 0) {
    return null;
  }
  return {
    id: `conflicts:${repoKey}`,
    kind: 'conflicts',
    repo: repoKey,
    label: 'Conflicts',
    description: `${conflicts.length} file(s)`,
    tooltip:
      'Files changed both in the repository and in a partial copy since the last sync. Both versions are kept until you choose one.',
    contextValue: 'conflicts',
    children: conflicts.map((c) => {
      const dir = path.posix.dirname(c.rel);
      return {
        id: `conflict:${c.holder}|${c.rel}`,
        kind: 'conflict',
        repo: repoKey,
        label: path.posix.basename(c.rel),
        description: dir && dir !== '.' ? `${c.plugin}/${dir}` : c.plugin,
        tooltip: `${c.plugin}/${c.rel}`,
        contextValue: 'conflict',
        plugin: c.plugin,
        rel: c.rel,
        source: c.source,
        copy: c.copy,
        holder: c.holder,
        children: [],
      };
    }),
  };
}

// The state line and icon of a repository. desc: an entry of repos.assignNames; state: { syncing, lastResult }.
// problem: true when the status bar should warn.
function repoStatus(desc, state) {
  const s = state || {};
  if (desc.duplicateOf) {
    return { text: 'listed twice: not loaded', icon: 'warning', problem: true };
  }
  if (desc.hiddenBy && desc.hiddenBy.reason === 'local') {
    return { text: 'replaced by your local clone', icon: 'circle-slash', problem: false };
  }
  if (desc.hiddenBy) {
    return { text: `same name as ${desc.hiddenBy.source}: not loaded`, icon: 'warning', problem: true };
  }
  if (s.syncing) {
    return { text: 'updating…', icon: 'sync~spin', problem: false };
  }
  if (desc.kind === 'drafts') {
    return { text: 'only on this machine', icon: 'edit', problem: false };
  }
  if (desc.kind === 'local') {
    return { text: 'local clone', icon: 'folder', problem: false };
  }
  const r = s.lastResult;
  if (!r) {
    return { text: 'not synced yet', icon: 'repo', problem: false };
  }
  switch (r.kind) {
    case 'conflict':
      return { text: 'updates paused: conflict', icon: 'warning', problem: true };
    case 'error':
      return { text: `error: ${r.message}`, icon: 'warning', problem: true };
    case 'offline':
      return { text: 'offline', icon: 'debug-disconnect', problem: false };
    case 'busy':
      return { text: 'another window is updating it', icon: 'sync', problem: false };
    default:
      return { text: 'up to date', icon: 'repo', problem: false };
  }
}

// The node of a repository: its state, then its groups and plugins as children.
function buildRepoNode(desc, state, children) {
  const s = state || {};
  const status = repoStatus(desc, s);
  const lines = [
    desc.kind === 'drafts'
      ? 'Drafts: plugins you are writing, only on this machine. Move one to a repository to share it.'
      : `Repository: ${desc.source}${desc.kind === 'managed' ? ` (${desc.branch || 'default branch'})` : ''}`,
  ];
  lines.push(`Folder: ${desc.dir}`);
  if (s.lastResult && s.lastResult.head) {
    lines.push(`Commit: ${String(s.lastResult.head).slice(0, 7)}`);
  }
  if (s.lastCheck) {
    lines.push(`Last check: ${new Date(s.lastCheck).toTimeString().slice(0, 5)}`);
  }
  lines.push(`State: ${status.text}`);
  return {
    id: `repo:${desc.key}`,
    kind: 'repo',
    key: desc.key,
    label: desc.name,
    description: status.text,
    icon: status.icon,
    tooltip: lines.join('\n'),
    contextValue: desc.kind === 'managed' ? 'repo.managed' : desc.kind === 'drafts' ? 'repo.drafts' : 'repo.local',
    children: children || [],
  };
}

// The nodes of the repositories a project needs but the user doesn't follow. missing: repos.missingRepos result;
// unlocated: names of repositories the project's settings don't locate.
function buildMissingNodes(missing, unlocated) {
  const nodes = (missing || []).map((e) => ({
    id: `missing:${e.normalized}`,
    kind: 'missing',
    label: e.name || baseName(e.url),
    description: 'needed by this project · not followed',
    tooltip: `${e.url}\nThis project uses plugins from this repository, which you don't follow.`,
    contextValue: 'missing',
    url: e.url,
    branch: e.branch,
    children: [],
  }));
  for (const name of unlocated || []) {
    nodes.push({
      id: `unlocated:${name}`,
      kind: 'missing',
      label: name,
      description: 'needed by this project · location unknown',
      tooltip: `This project uses plugins from repository ${name}, which you don't follow, and its settings don't say where it is (teamPlugins.projectRepositories).`,
      contextValue: 'missing.unknown',
      children: [],
    });
  }
  return nodes;
}

module.exports = {
  buildTree,
  buildChangesNode,
  buildConflictsNode,
  repoStatus,
  buildRepoNode,
  buildMissingNodes,
};
