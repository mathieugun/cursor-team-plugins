'use strict';

const fs = require('fs');

function resolvedPath(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

class Registrar {
  constructor(api, log = () => {}) {
    this.api = api;
    this.log = log;
    this.current = new Map(); // plugin name -> registered path
    this.resolvedPaths = new Map(); // plugin name -> physical path at registration time
  }

  async apply(desired) {
    const added = [];
    const removed = [];
    const errors = [];
    for (const [name, p] of [...this.current]) {
      if (desired.get(name) === p) {
        continue;
      }
      try {
        await this.remove(name);
        removed.push(p);
      } catch (err) {
        errors.push({ path: p, message: err.message });
      }
    }
    // Cursor owns one registration per physical path, even when the catalog key or path spelling changes.
    const registeredPaths = new Set([...this.current.values(), ...this.resolvedPaths.values()]);
    for (const [name, p] of desired) {
      if (this.current.has(name) || registeredPaths.has(p)) {
        continue;
      }
      const physical = resolvedPath(p);
      if (registeredPaths.has(physical)) {
        continue;
      }
      try {
        await this.api.add(p);
        this.current.set(name, p);
        this.resolvedPaths.set(name, physical);
        registeredPaths.add(p);
        registeredPaths.add(physical);
        added.push(p);
        this.log(`registered ${name}: ${p}`);
      } catch (err) {
        errors.push({ path: p, message: err.message });
        this.log(`failed to register ${name}: ${err.message}`);
      }
    }
    return { added, removed, errors };
  }

  // Unregisters one plugin now (before its folder is deleted: a folder Cursor watches stays "delete pending" on
  // Windows until it is unregistered); the next apply registers again whatever is still wanted.
  async remove(name) {
    const p = this.current.get(name);
    if (p === undefined) {
      return;
    }
    try {
      await this.api.remove(this.resolvedPaths.get(name) ?? p);
    } catch (err) {
      this.log(`failed to unregister ${name}: ${err.message}`);
      throw err;
    }
    this.current.delete(name);
    this.resolvedPaths.delete(name);
    this.log(`unregistered ${name}: ${p}`);
  }

  async removeAll() {
    for (const [name, p] of [...this.current]) {
      try {
        await this.api.remove(this.resolvedPaths.get(name) ?? p);
        this.log(`unregistered ${name}: ${p}`);
      } catch {
        // ignored
      }
    }
    this.current.clear();
    this.resolvedPaths.clear();
  }
}

module.exports = { Registrar };
