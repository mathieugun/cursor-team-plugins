'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = 'hooks/hooks.json';
const MANIFEST_FILES = ['.cursor-plugin/plugin.json', '.claude-plugin/plugin.json', 'plugin.json'];
const MAX_CONFIG_BYTES = 10 * 1024 * 1024;
const EVENTS = new Set([
  'beforeShellExecution', 'beforeMCPExecution', 'afterShellExecution', 'afterMCPExecution', 'beforeReadFile',
  'afterFileEdit', 'beforeTabFileRead', 'afterTabFileEdit', 'stop', 'beforeSubmitPrompt', 'afterAgentResponse',
  'afterAgentThought', 'sessionStart', 'sessionEnd', 'preCompact', 'subagentStart', 'subagentStop', 'preToolUse',
  'postToolUse', 'postToolUseFailure', 'workspaceOpen',
]);
const CLAUDE_EVENTS = new Map([
  ['PreToolUse', 'preToolUse'], ['PostToolUse', 'postToolUse'], ['UserPromptSubmit', 'beforeSubmitPrompt'],
  ['Stop', 'stop'], ['SubagentStop', 'subagentStop'], ['SessionStart', 'sessionStart'], ['SessionEnd', 'sessionEnd'],
  ['PreCompact', 'preCompact'],
]);

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string';
const optional = (value, valid) => value === undefined || valid(value);
const nonblank = (value) => string(value) && value.trim() !== '';
const positiveInteger = (value) => Number.isInteger(value) && value > 0;
const validTimeout = (value) => typeof value === 'number' && value > 0;

function validMatcher(value) {
  if (!string(value)) {
    return false;
  }
  if (value === '*') {
    return true;
  }
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function validHook(hook) {
  if (!object(hook)) {
    return false;
  }
  const validBody = hook.type === 'prompt'
    ? nonblank(hook.prompt) && optional(hook.model, nonblank)
    : optional(hook.type, (type) => type === 'command') && string(hook.command);
  return validBody && optional(hook.matcher, validMatcher) && optional(hook.timeout, validTimeout)
    && optional(hook.loop_limit, (value) => value === null || positiveInteger(value))
    && optional(hook.failClosed, (value) => typeof value === 'boolean');
}

// Cursor converts the nested format before validating it. Only the event names are needed here.
function claudeEvents(table) {
  const events = [];
  for (const [source, groups] of Object.entries(table)) {
    const event = CLAUDE_EVENTS.get(source);
    if (!event || !Array.isArray(groups)) {
      continue;
    }
    let found = false;
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) {
        return [];
      }
      if ((event === 'preToolUse' || event === 'postToolUse') && group.matcher && group.matcher !== '*') {
        if (!string(group.matcher)) {
          return [];
        }
        // Cursor drops unsupported tools and maps tool names before checking the resulting regex.
        const matcher = group.matcher.split('|').map((tool) => tool.trim()).filter((tool) => tool !== 'Glob')
          .map((tool) => {
            const parts = tool.split('__');
            if (parts[0] === 'mcp' && parts.length >= 3) {
              return `MCP:${parts.slice(2).join('__')}`;
            }
            return tool;
          }).join('|');
        if (matcher === '') {
          continue;
        }
        if (!validMatcher(matcher)) {
          return [];
        }
      }
      for (const hook of group.hooks) {
        if (!object(hook)) {
          return [];
        }
        const hasBody = hook.type === 'prompt' ? Boolean(hook.prompt)
          : Boolean(hook.command) && (hook.args == null || (Array.isArray(hook.args) && hook.args.every(string)));
        if (!hasBody) {
          continue;
        }
        if (!(hook.type === 'prompt' ? nonblank(hook.prompt) : string(hook.command)) || !optional(hook.timeout, validTimeout)) {
          return [];
        }
        found = true;
      }
    }
    if (found) {
      events.push(event);
    }
  }
  return events;
}

function eventNames(config) {
  if (!object(config) || !object(config.hooks)) {
    return [];
  }
  // The first recognizable entry determines which of the two formats Cursor validates.
  for (const entries of Object.values(config.hooks)) {
    const first = Array.isArray(entries) && entries[0];
    if (!object(first)) {
      continue;
    }
    if (Array.isArray(first.hooks)) {
      return claudeEvents(config.hooks).sort();
    }
    if ('command' in first || 'prompt' in first || 'type' in first) {
      const table = Object.entries(config.hooks);
      if (!positiveInteger(config.version) || !table.every(([event, hooks]) =>
        EVENTS.has(event) && Array.isArray(hooks) && hooks.every(validHook))) {
        return [];
      }
      return table.filter(([, hooks]) => hooks.length > 0).map(([event]) => event).sort();
    }
  }
  return [];
}

function within(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function readConfig(dir, file) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isFile() && stat.size <= MAX_CONFIG_BYTES && within(fs.realpathSync(dir), fs.realpathSync(file))) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch {
    // Cursor skips missing files and rejects unreadable or invalid JSON.
  }
  return undefined;
}

const componentPaths = (value) => string(value) || (Array.isArray(value) && value.every(string));
const mcpPaths = (value) => string(value) || object(value) || (Array.isArray(value) && value.every((v) => string(v) || object(v)));

function manifestOptions(dir) {
  for (const rel of MANIFEST_FILES) {
    const file = path.join(dir, rel);
    const manifest = readConfig(dir, file);
    // Cursor continues looking after a manifest that only names the plugin or supplies release metadata.
    if (!object(manifest) || !string(manifest.name) || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(manifest.name)
      || !optional(manifest.hooks, (value) => string(value) || object(value))) {
      continue;
    }
    const paths = ['skills', 'rules', 'commands', 'agents'].map((key) => manifest[key]);
    if (!paths.every((value) => optional(value, componentPaths)) || !optional(manifest.mcpServers, mcpPaths)
      || ![manifest.displayName, manifest.description, manifest.logo].every((value) => optional(value, string))) {
      continue;
    }
    if (manifest.hooks !== undefined || paths.some((value) => value !== undefined) || manifest.mcpServers !== undefined
      || manifest.displayName !== undefined || manifest.description !== undefined || string(manifest.author?.name)
      || object(manifest.variables) || Array.isArray(manifest.capabilities)
      || (manifest.logo && readLogo(dir, manifest.logo))) {
      return { file, hooks: manifest.hooks };
    }
  }
  return {};
}

function readLogo(dir, logo) {
  const rel = logo.trim();
  if (path.isAbsolute(rel) || rel.includes('://')) {
    return false;
  }
  try {
    const file = fs.realpathSync(path.join(dir, rel));
    const stat = fs.statSync(file);
    return within(fs.realpathSync(dir), file) && stat.isFile() && stat.size <= MAX_CONFIG_BYTES;
  } catch {
    return false;
  }
}

function readHooks(dir) {
  const manifest = manifestOptions(dir);
  let file = path.join(dir, DEFAULT_FILE);
  if (object(manifest.hooks)) {
    return { file: manifest.file, events: eventNames(manifest.hooks), candidate: true };
  }
  if (string(manifest.hooks)) {
    const rel = manifest.hooks.replace(/^\.\//, '');
    if (rel.includes('..') || rel.includes('://') || path.isAbsolute(rel) || path.win32.parse(rel).root) {
      return { file: manifest.file, events: [], candidate: true };
    }
    file = rel.endsWith('.json') ? path.join(dir, rel) : path.join(dir, rel, 'hooks.json');
  }
  const stat = (target) => {
    try {
      return fs.lstatSync(target, { throwIfNoEntry: false });
    } catch {
      return undefined;
    }
  };
  // A copy can dereference a link that Cursor would not load directly.
  const candidate = manifest.hooks !== undefined || Boolean(stat(file))
    || MANIFEST_FILES.some((rel) => stat(path.join(dir, rel))?.isSymbolicLink());
  return { file, events: eventNames(readConfig(dir, file)), candidate };
}

function withoutHooks(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!object(obj) || !(string(obj.hooks) || object(obj.hooks))) {
    return null;
  }
  return `${JSON.stringify({ ...obj, hooks: {} }, null, 2)}\n`;
}

module.exports = { DEFAULT_FILE, MANIFEST_FILES, readHooks, withoutHooks };
