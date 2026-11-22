'use strict';

class Registrar {
  constructor(api, log = () => {}) {
    this.api = api;
    this.log = log;
    this.current = new Map(); // plugin name -> registered path
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
        await this.api.remove(p);
        this.log(`unregistered ${name}: ${p}`);
      } catch (err) {
        errors.push({ path: p, message: err.message });
        this.log(`failed to unregister ${name}: ${err.message}`);
      }
      this.current.delete(name);
      removed.push(p);
    }
    for (const [name, p] of desired) {
      if (this.current.get(name) === p) {
        continue;
      }
      try {
        await this.api.add(p);
        this.current.set(name, p);
        added.push(p);
        this.log(`registered ${name}: ${p}`);
      } catch (err) {
        errors.push({ path: p, message: err.message });
        this.log(`failed to register ${name}: ${err.message}`);
      }
    }
    return { added, removed, errors };
  }

  async removeAll() {
    for (const [name, p] of [...this.current]) {
      try {
        await this.api.remove(p);
        this.log(`unregistered ${name}: ${p}`);
      } catch {
        // ignored
      }
    }
    this.current.clear();
  }
}

module.exports = { Registrar };
