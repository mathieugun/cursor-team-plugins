'use strict';

const path = require('path');

const PROJECT_LINES = {
  all: 'Enabled by this project (.vscode/settings.json)',
  some: 'Partly enabled by this project (.vscode/settings.json)',
};

function withProjectLine(text, state) {
  return state ? `${text}\n${PROJECT_LINES[state]}` : text;
}

function buildTree(catalog, eff, project) {
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
      contextValue: inProject ? 'plugin.project' : 'plugin',
      children: plugin.children.map((c) => {
        const childProject = e.fromProject.has(c.id) ? 'all' : null;
        return {
          id: `item:${c.id}`,
          key: c.id,
          kind: c.kind,
          label: c.name,
          description: c.kind,
          tooltip: withProjectLine(c.description || path.basename(c.file), childProject),
          checked: e.included.has(c.id),
          partial: false,
          checkboxTooltip: '',
          project: childProject,
          contextValue: childProject ? 'child.project' : 'child',
          file: c.file,
          children: [],
        };
      }),
    };
  });
}

// The group of local changes of the managed clone (null when there are none; a node without children and with the
// error when git could not read them, so a failure never looks like "no changes").
function buildChangesNode(changes) {
  if (changes && changes.error) {
    return {
      id: 'changes',
      kind: 'changes',
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
    id: 'changes',
    kind: 'changes',
    label: 'Local changes',
    description: parts.join(' · '),
    tooltip: 'Changes in the managed clone that the team does not have yet. Commit and push them to share them.',
    contextValue: 'changes',
    children: changes.files.map((f) => {
      const dir = path.posix.dirname(f.path);
      const node = {
        id: `change:${f.path}`,
        kind: 'change',
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
// conflicts: [{ plugin (name), rel, source, copy, holder }].
function buildConflictsNode(conflicts) {
  if (!conflicts || conflicts.length === 0) {
    return null;
  }
  return {
    id: 'conflicts',
    kind: 'conflicts',
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

module.exports = { buildTree, buildChangesNode, buildConflictsNode };
