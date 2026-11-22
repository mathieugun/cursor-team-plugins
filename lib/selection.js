'use strict';

function uniqSorted(list) {
  return [...new Set(list)].sort();
}

function childIds(plugin) {
  return plugin.children.map((c) => c.id);
}

function effective(catalog, user, project) {
  const enabled = new Set(user.enabled || []);
  const excluded = new Set(user.excluded || []);
  const proj = new Set(project || []);
  const result = new Map();
  for (const plugin of catalog.plugins) {
    const ids = childIds(plugin);
    const name = plugin.name;
    const projectPlugin = proj.has(name);
    if (ids.length === 0) {
      const active = enabled.has(name) || projectPlugin;
      result.set(name, {
        active,
        full: active,
        included: new Set(),
        fromProject: projectPlugin ? new Set([name]) : new Set(),
        projectPlugin,
      });
      continue;
    }
    const u = enabled.has(name) ? ids.filter((i) => !excluded.has(i)) : ids.filter((i) => enabled.has(i));
    const r = projectPlugin ? ids : ids.filter((i) => proj.has(i));
    const included = new Set([...u, ...r]);
    const active = included.size > 0;
    result.set(name, {
      active,
      full: active && included.size === ids.length,
      included,
      fromProject: new Set(r),
      projectPlugin,
    });
  }
  return result;
}

function findOwner(catalog, id) {
  for (const plugin of catalog.plugins) {
    if (plugin.name === id) {
      return { plugin, child: null };
    }
    if (plugin.children.some((c) => c.id === id)) {
      return { plugin, child: id };
    }
  }
  return null;
}

function toggle(catalog, user, id, checked) {
  const enabled = new Set(user.enabled || []);
  const excluded = new Set(user.excluded || []);
  const owner = findOwner(catalog, id);
  if (owner) {
    const { plugin, child } = owner;
    const P = plugin.name;
    const ids = childIds(plugin);
    if (child === null) {
      for (const i of ids) {
        enabled.delete(i);
        excluded.delete(i);
      }
      if (checked) {
        enabled.add(P);
      } else {
        enabled.delete(P);
      }
    } else if (enabled.has(P)) {
      if (checked) {
        excluded.delete(child);
      } else {
        excluded.add(child);
      }
    } else if (checked) {
      enabled.add(child);
    } else {
      enabled.delete(child);
    }
    if (ids.length > 0) {
      if (enabled.has(P) && ids.every((i) => excluded.has(i))) {
        enabled.delete(P);
        for (const i of ids) {
          enabled.delete(i);
          excluded.delete(i);
        }
      } else if (!enabled.has(P) && ids.every((i) => enabled.has(i))) {
        for (const i of ids) {
          enabled.delete(i);
        }
        enabled.add(P);
      }
    }
  }
  return { enabled: uniqSorted(enabled), excluded: uniqSorted(excluded) };
}

function addToProject(catalog, list, id) {
  const set = new Set(list || []);
  const owner = findOwner(catalog, id);
  if (!owner) {
    set.add(id);
    return uniqSorted(set);
  }
  const { plugin, child } = owner;
  const ids = childIds(plugin);
  if (child === null) {
    set.add(plugin.name);
    for (const i of ids) {
      set.delete(i);
    }
  } else if (!set.has(plugin.name)) {
    set.add(child);
    if (ids.every((i) => set.has(i))) {
      for (const i of ids) {
        set.delete(i);
      }
      set.add(plugin.name);
    }
  }
  return uniqSorted(set);
}

function removeFromProject(catalog, list, id) {
  const set = new Set(list || []);
  const owner = findOwner(catalog, id);
  if (!owner) {
    set.delete(id);
    return uniqSorted(set);
  }
  const { plugin, child } = owner;
  const ids = childIds(plugin);
  if (child === null) {
    set.delete(plugin.name);
    for (const i of ids) {
      set.delete(i);
    }
  } else if (set.has(plugin.name)) {
    set.delete(plugin.name);
    for (const i of ids) {
      if (i !== child) {
        set.add(i);
      }
    }
  } else {
    set.delete(child);
  }
  return uniqSorted(set);
}

function desiredRegistrations(catalog, eff, filteredPathFor) {
  const desired = new Map();
  for (const plugin of catalog.plugins) {
    const e = eff.get(plugin.name);
    if (!e || !e.active) {
      continue;
    }
    desired.set(plugin.name, e.full ? plugin.dir : filteredPathFor(plugin, [...e.included].sort()));
  }
  return desired;
}

module.exports = { effective, toggle, addToProject, removeFromProject, desiredRegistrations };
