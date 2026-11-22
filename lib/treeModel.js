'use strict';

const path = require('path');

function buildTree(catalog, eff, project) {
  const proj = new Set(project || []);
  return catalog.plugins.map((plugin) => {
    const e = eff.get(plugin.name) || { active: false, full: false, included: new Set(), fromProject: new Set() };
    const inProject = proj.has(plugin.name) || plugin.children.some((c) => proj.has(c.id));
    const parts = [];
    if (plugin.version) {
      parts.push(`v${plugin.version}`);
    }
    if (plugin.children.length > 0 && e.active && !e.full) {
      parts.push(`${e.included.size}/${plugin.children.length}`);
    }
    if (inProject) {
      parts.push('project');
    }
    return {
      id: plugin.name,
      kind: 'plugin',
      label: plugin.displayName,
      description: parts.join(' · '),
      tooltip: plugin.description || plugin.name,
      checked: plugin.children.length > 0 ? e.full : e.active,
      contextValue: inProject ? 'plugin.project' : 'plugin',
      children: plugin.children.map((c) => {
        const fromProject = e.fromProject.has(c.id);
        return {
          id: c.id,
          kind: c.kind,
          label: c.name,
          description: fromProject ? `${c.kind} · project` : c.kind,
          tooltip: c.description || path.basename(c.file),
          checked: e.included.has(c.id),
          contextValue: fromProject ? 'child.project' : 'child',
          file: c.file,
          children: [],
        };
      }),
    };
  });
}

module.exports = { buildTree };
