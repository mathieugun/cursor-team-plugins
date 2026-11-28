'use strict';

// Creating a team repository from the rules, skills, commands, agents and MCP servers of projects and
// ~/.cursor: scan, group, preview, build, push. Pure: never requires vscode.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { KINDS, nameError, serverNameError } = require('./authoring');
const { mcpServerNames, serverTable, inside } = require('./catalog');
const { parseJsonc } = require('./checks');
const { checkGit, gitCheckMessage } = require('./gitCheck');
const { commitAll, IDENTITY_MESSAGE } = require('./contribute');
const { removeMember } = require('./jsonc');
const { remoteResult } = require('./remoteErrors');
const share = require('./share');
const { redacted, NETWORK_IDLE_MS } = require('./sync');

const KIND_ORDER = ['skill', 'rule', 'command', 'agent', 'mcp'];

// ---- secrets ------------------------------------------------------------------------------------------------------

// The words that make Cursor's agent host treat a variable as a secret (plus two header words).
const SECRET_WORDS = new Set([
  'CREDENTIAL',
  'CREDENTIALS',
  'KEY',
  'PASSPHRASE',
  'PASSWORD',
  'SECRET',
  'TOKEN',
  'AUTHORIZATION',
  'APIKEY',
]);

// Whether a name holds one of the words, split as Cursor splits it (camelCase and non-alphanumerics become `_`).
function secretName(name) {
  return String(name)
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^a-z\d]+/gi, '_')
    .toUpperCase()
    .split('_')
    .filter(Boolean)
    .some((word) => SECRET_WORDS.has(word));
}

const TOKEN_SHAPE =
  /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{20,})/;
const REFERENCE = /\$\{[^}]*\}/g;
const SCHEME_WORD = /^(Bearer|Basic|Token)\s+/i;

function envVarName(text) {
  const name = String(text)
    .toUpperCase()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[A-Z]/.test(name) ? name : `MCP_${name}`;
}

// Whether a value holds something that is not a `${...}` reference (and, with `scheme`, not only a Bearer/Basic/Token
// word before references).
function literal(v, { scheme = false } = {}) {
  if (typeof v !== 'string') {
    return false;
  }
  // a reference with a non-empty default (`${X:-value}`) keeps its default as text: the default is a literal
  let rest = v.replace(REFERENCE, (m) => (/:-[^}]/.test(m) ? m : ''));
  if (scheme) {
    rest = rest.replace(SCHEME_WORD, '');
  }
  return rest.trim() !== '';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The strings of a value with their paths (`a.b`, `args[2]`).
function stringsOf(value, prefix = '', out = []) {
  if (typeof value === 'string') {
    out.push({ path: prefix, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => stringsOf(v, `${prefix}[${i}]`, out));
  } else if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      stringsOf(v, prefix ? `${prefix}.${k}` : k, out);
    }
  }
  return out;
}

// An MCP server entry without its secret values: -> { entry, replaced: [{ where, variable }], suspects: [string],
// hidden: [path] }. An `env` value or a header whose name holds a secret word and whose value is a literal becomes
// `${env:NAME}`; other suspected secrets are only reported (never with their value); `hidden` lists the fields whose
// value must never be shown. The input is untouched.
function redactServer(name, entry) {
  if (!isPlainObject(entry)) {
    return { entry, replaced: [], suspects: [], hidden: [] };
  }
  const hidden = new Set();
  const out = JSON.parse(JSON.stringify(entry));
  const replaced = [];
  const used = new Set();
  const variableFor = (base) => {
    let variable = base;
    for (let n = 2; used.has(variable); n++) {
      variable = `${base}_${n}`;
    }
    used.add(variable);
    return variable;
  };
  if (isPlainObject(out.env)) {
    for (const [k, value] of Object.entries(out.env)) {
      if (secretName(k) && literal(value)) {
        const variable = variableFor(envVarName(k));
        out.env[k] = `\${env:${variable}}`;
        replaced.push({ where: `env.${k}`, variable });
      }
    }
  }
  if (isPlainObject(out.headers)) {
    for (const [h, value] of Object.entries(out.headers)) {
      if (secretName(h) && literal(value, { scheme: true })) {
        const word = SCHEME_WORD.exec(value);
        const variable = variableFor(envVarName(word ? `${name}_TOKEN` : `${name}_${h}`));
        out.headers[h] = word ? `${word[1]} \${env:${variable}}` : `\${env:${variable}}`;
        replaced.push({ where: `headers.${h}`, variable });
      }
    }
  }
  const suspects = [];
  if (typeof out.url === 'string') {
    if (/^https?:\/\/[^/?#]*@/i.test(out.url)) {
      suspects.push('the URL holds credentials');
      hidden.add('url');
    }
    const q = out.url.indexOf('?');
    if (q >= 0) {
      for (const part of out.url.slice(q + 1).replace(/#.*$/, '').split('&')) {
        const eq = part.indexOf('=');
        const key = decoded(eq < 0 ? part : part.slice(0, eq));
        const value = decoded(eq < 0 ? '' : part.slice(eq + 1));
        if (secretName(key) && literal(value)) {
          suspects.push(`the URL parameter ${key} holds a value`);
          hidden.add('url');
        }
      }
    }
  }
  if (Array.isArray(out.args)) {
    out.args.forEach((arg, i) => {
      if (typeof arg !== 'string') {
        return;
      }
      const assigned = /^--?([^=\s]+)=([\s\S]*)$/.exec(arg);
      if (assigned) {
        if (secretName(assigned[1]) && literal(assigned[2])) {
          suspects.push(`args[${i}] sets ${assigned[1]}`);
          hidden.add(`args[${i}]`);
        }
        return;
      }
      const flag = /^--?([^=\s]+)$/.exec(arg);
      const next = out.args[i + 1];
      if (flag && secretName(flag[1]) && typeof next === 'string' && !next.startsWith('-') && literal(next)) {
        suspects.push(`args[${i + 1}] follows ${arg}`);
        hidden.add(`args[${i + 1}]`);
      }
    });
  }
  for (const s of stringsOf(out)) {
    if (TOKEN_SHAPE.test(s.text)) {
      suspects.push(`${s.path} looks like an access token`);
      hidden.add(s.path);
    }
  }
  return { entry: out, replaced, suspects: [...new Set(suspects)], hidden: [...hidden] };
}

// The 1-based numbers of the lines that look like an access token.
function textSuspects(text) {
  const out = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (TOKEN_SHAPE.test(line)) {
        out.push(i + 1);
      }
    });
  return out;
}

// ---- files and keys -----------------------------------------------------------------------------------------------

function normalizeText(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return t.replace(/\r\n/g, '\n');
}

function isText(buf) {
  return !buf.includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

// The bytes a file counts as: text with its BOM and CRLF normalised, anything else as it is.
function keyBytes(buf) {
  return isText(buf) ? Buffer.from(normalizeText(buf.toString('utf8')), 'utf8') : buf;
}

const byRel = (a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The regular files of a skill folder: [{ rel, full }], sorted by rel (links, to a file or a folder, are left out as
// Share leaves them out). Throws when a folder can't be listed: a partial listing must never become a key.
function skillFiles(dir) {
  const out = [];
  const walk = (folder, prefix) => {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, rel);
      } else if (stat.isFile()) {
        out.push({ rel, full });
      }
    }
  };
  walk(dir, '');
  return out.sort(byRel);
}

// The links of a skill folder (relative, with '/'): what Share leaves out.
function skillLinks(dir) {
  const out = [];
  const walk = (folder, prefix) => {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        out.push(rel);
      } else if (stat.isDirectory()) {
        walk(full, rel);
      }
    }
  };
  walk(dir, '');
  return out.sort();
}

// A hash of what an item holds (sha1 hex): a file's bytes (text normalised), or a skill's paths and bytes.
function contentKey(item) {
  const hash = crypto.createHash('sha1');
  if (item.kind === 'skill') {
    for (const f of skillFiles(item.src)) {
      hash.update(`${f.rel}\0`);
      hash.update(keyBytes(fs.readFileSync(f.full)));
      hash.update('\0');
    }
  } else {
    hash.update(keyBytes(fs.readFileSync(item.src)));
  }
  return hash.digest('hex');
}

function canonicalJson(v) {
  if (Array.isArray(v)) {
    return `[${v.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

// ---- names --------------------------------------------------------------------------------------------------------

function reservedName(n) {
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(n);
}

// The name an item is imported under: its own when Cursor accepts it, else the nearest valid one, else ''.
function importName(name) {
  let n = nameError(name) === '' ? name : share.suggestName(name);
  if (n && reservedName(n)) {
    n = `${n}-item`;
  }
  return n;
}

// ---- references ---------------------------------------------------------------------------------------------------

const TEXT_EXT = /\.(md|mdc|markdown|txt)$/i;
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const MENTION = /(?:^|[\s(])@([A-Za-z0-9_./\\-]*[./\\][A-Za-z0-9_./\\-]*[A-Za-z0-9_])/g;

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The text files of an item: [{ rel, full }] (rel: '' for a rule, command or agent file).
function textFilesOf(item) {
  if (item.kind === 'skill') {
    return skillFiles(item.src).filter((f) => TEXT_EXT.test(f.rel));
  }
  return [{ rel: '', full: item.src }];
}

function linkTarget(raw, file, root) {
  let t = raw;
  let base = path.dirname(file);
  if (t.startsWith('#')) {
    return null;
  }
  if (/^mdc:/i.test(t)) {
    t = t.slice(4);
    base = root;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[a-z]:[\\/]/i.test(t)) {
    return null;
  }
  t = decoded(t.replace(/[?#].*$/, ''));
  if (!t) {
    return null;
  }
  return path.isAbsolute(t) ? { resolved: t, why: 'absolute' } : { resolved: path.resolve(base, t), why: 'link' };
}

// The paths a rule, command, agent or skill points to that exist and are not part of the item: [{ file, line, target,
// resolved, why }]. why: 'link' (a Markdown link, `mdc:` ones from the project root), 'mention' (`@path`) or 'absolute'.
function itemReferences(item, root) {
  const own = realOr(item.src);
  const isPart = (p) => (item.kind === 'skill' ? inside(own, realOr(p)) : realOr(p) === own);
  const out = [];
  const seen = new Set();
  const add = (ref) => {
    const key = `${ref.file}|${ref.line}|${ref.target}`;
    if (!seen.has(key) && fs.existsSync(ref.resolved) && !isPart(ref.resolved)) {
      seen.add(key);
      out.push(ref);
    }
  };
  for (const f of textFilesOf(item)) {
    const lines = fs.readFileSync(f.full, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const m of text.matchAll(LINK)) {
        if (TOKEN_SHAPE.test(m[1])) {
          continue;
        }
        const t = linkTarget(m[1], f.full, root);
        if (t) {
          add({ file: f.full, line: i + 1, target: m[1], resolved: t.resolved, why: t.why });
        }
      }
      for (const m of text.matchAll(MENTION)) {
        if (TOKEN_SHAPE.test(m[1])) {
          continue;
        }
        const found = [path.resolve(root, m[1]), path.resolve(path.dirname(f.full), m[1])].find((p) => fs.existsSync(p));
        if (found) {
          add({ file: f.full, line: i + 1, target: m[1], resolved: found, why: 'mention' });
        }
      }
    });
  }
  return out;
}

// The paths an MCP server entry (redacted) uses: [{ where, value, why }]. why: 'workspaceFolder', 'absolute' or
// 'relative'. The fields of `hidden` (redactServer's) are never reported: their value may be a secret.
function serverReferences(entry, root, hidden = []) {
  if (!isPlainObject(entry)) {
    return [];
  }
  const fields = [];
  if (typeof entry.command === 'string') {
    fields.push({ where: 'command', text: entry.command });
  }
  if (Array.isArray(entry.args)) {
    entry.args.forEach((a, i) => typeof a === 'string' && fields.push({ where: `args[${i}]`, text: a }));
  }
  if (typeof entry.cwd === 'string') {
    fields.push({ where: 'cwd', text: entry.cwd });
  }
  if (isPlainObject(entry.env)) {
    for (const [k, v] of Object.entries(entry.env)) {
      if (typeof v === 'string') {
        fields.push({ where: `env.${k}`, text: v });
      }
    }
  }
  const out = [];
  for (const { where, text } of fields) {
    if (TOKEN_SHAPE.test(text) || hidden.includes(where)) {
      continue;
    }
    let why = '';
    if (/\$\{workspaceFolder(?::[^}]*)?\}/.test(text)) {
      why = 'workspaceFolder';
    } else if (path.isAbsolute(text) && fs.existsSync(text)) {
      why = 'absolute';
    } else if (/^\.\.?[\\/]/.test(text)) {
      why = 'relative';
    } else if (/[\\/]/.test(text) && !/^[a-z][a-z0-9+.-]*:/i.test(text) && fs.existsSync(path.resolve(root, text))) {
      why = 'relative';
    }
    if (why) {
      out.push({ where, value: text, why });
    }
  }
  return out;
}

// ---- scanning -----------------------------------------------------------------------------------------------------

function fileMtime(file) {
  return fs.statSync(file).mtimeMs;
}

const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$|\.env$/i;

// What in an item looks like a secret, never with its value: a line that looks like an access token in any text file of
// the item (every file of a skill, not only its Markdown: a skill's config or script is copied too), and a skill's
// environment file (`.env`, `.env.local`, `x.env`). item: { kind, src } (a skill's src is its folder).
function itemSuspects(item) {
  const out = [];
  const files = item.kind === 'skill' ? skillFiles(item.src) : [{ rel: path.basename(item.src), full: item.src }];
  for (const f of files) {
    if (item.kind === 'skill' && ENV_FILE.test(f.rel)) {
      out.push(`${f.rel} is an environment file`);
      continue;
    }
    const buf = fs.readFileSync(f.full);
    if (!isText(buf)) {
      continue;
    }
    for (const n of textSuspects(buf.toString('utf8'))) {
      out.push(`${f.rel} line ${n} looks like an access token`);
    }
  }
  return out;
}

// source: { label, root, personal }. -> { items, servers, errors }: the records of what its .cursor folder holds (see
// scan), and what could not be read ({ file, message }, never with a parser's text).
function scanSource(source) {
  const items = [];
  const servers = [];
  const errors = [];
  const label = source.personal ? '~' : source.label;
  for (const item of share.projectItems(source.root)) {
    if (source.personal && item.kind === 'rule') {
      continue;
    }
    try {
      const main = item.kind === 'skill' ? path.join(item.src, 'SKILL.md') : item.src;
      const text = fs.readFileSync(main, 'utf8');
      const key = contentKey(item);
      const where = `${label}/${item.rel}`;
      const lines = normalizeText(text).split('\n').length - (/\n$/.test(text) ? 1 : 0);
      const suspects = itemSuspects(item);
      const references = itemReferences(item, source.root).map((r) => {
        const inner = item.kind === 'skill' ? path.relative(item.src, r.file).split(path.sep).join('/') : '';
        return { ...r, where: inner ? `${where}/${inner}` : where };
      });
      items.push({
        ...item,
        source,
        originalName: item.name,
        name: importName(item.name) || item.kind,
        key,
        originalKey: key,
        main,
        lines,
        mtimeMs: fileMtime(main),
        where,
        suspects,
        references,
        links: item.kind === 'skill' ? skillLinks(item.src) : [],
      });
    } catch (err) {
      errors.push({ file: item.src, message: err.code || 'unreadable' });
    }
  }
  const file = path.join(source.root, '.cursor', 'mcp.json');
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    let obj = null;
    let mcpText = null;
    try {
      mcpText = fs.readFileSync(file, 'utf8');
    } catch (err) {
      errors.push({ file, message: err.code || 'unreadable' });
    }
    if (mcpText !== null) {
      try {
        obj = parseJsonc(mcpText);
      } catch {
        errors.push({ file, message: 'not valid JSONC' });
      }
    }
    if (obj !== null) {
      if (!isPlainObject(obj)) {
        errors.push({ file, message: 'not a JSON object' });
      } else {
        const table = serverTable(obj) || obj;
        const where = `${label}/.cursor/mcp.json`;
        const mtimeMs = fileMtime(file);
        for (const name of mcpServerNames(obj)) {
          if (serverNameError(name)) {
            errors.push({ file, message: `the server name ${name} can't be used in a plugin` });
          } else if (!isPlainObject(table[name])) {
            errors.push({ file, message: `the server ${name} is not an object` });
          } else {
            const original = table[name];
            const { entry, replaced, suspects, hidden } = redactServer(name, original);
            servers.push({
              kind: 'mcp',
              name,
              originalName: name,
              source,
              file,
              where,
              entry,
              replaced,
              suspects,
              references: serverReferences(entry, source.root, hidden),
              key: canonicalJson(entry),
              originalKey: sha1(canonicalJson(original)),
              mtimeMs,
            });
          }
        }
      }
    }
  }
  return { items, servers, errors };
}

// sources: [{ label, root, personal }]. -> { groups, errors }. A group is the copies of one name and kind:
// { id, kind, name, copies, versions (copies with the same content, first appearance order: [[copy, ...], ...]), status
// ('single', 'identical' or 'variants'), suspects [{ where, text }], references [{ where, ... }], replaced [{ where,
// field, variable }], renamed (the copies whose name changed) }. Groups: skills, rules, commands, agents, MCP servers.
function scan(sources) {
  const copies = [];
  const errors = [];
  sources.forEach((source, index) => {
    const found = scanSource(source);
    for (const c of [...found.items, ...found.servers]) {
      c.sourceIndex = index;
      copies.push(c);
    }
    errors.push(...found.errors);
  });
  const byId = new Map();
  for (const c of copies) {
    const id = `${c.kind}:${c.name}`;
    if (!byId.has(id)) {
      byId.set(id, { id, kind: c.kind, name: c.name, copies: [] });
    }
    byId.get(id).copies.push(c);
  }
  const groups = [...byId.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  for (const g of groups) {
    const versions = new Map();
    for (const c of g.copies) {
      if (!versions.has(c.key)) {
        versions.set(c.key, []);
      }
      versions.get(c.key).push(c);
    }
    g.versions = [...versions.values()];
    g.status = g.copies.length === 1 ? 'single' : g.versions.length === 1 ? 'identical' : 'variants';
    g.suspects = g.copies.flatMap((c) => c.suspects.map((text) => ({ where: c.where, text })));
    g.references = g.copies.flatMap((c) =>
      c.kind === 'mcp'
        ? c.references.map((r) => ({ where: c.where, field: r.where, value: r.value, why: r.why }))
        : c.references.map((r) => ({ where: r.where, line: r.line, target: r.target, why: r.why })),
    );
    g.replaced = g.copies.flatMap((c) => (c.replaced || []).map((r) => ({ where: c.where, field: r.where, variable: r.variable })));
    g.renamed = g.copies.filter((c) => c.originalName !== c.name);
  }
  return { groups, errors };
}

// The fingerprint of the server `name` in an mcp.json's text (the originalKey of a scanned server), or '' when it is
// not there or the text does not parse.
function serverKeyIn(text, name) {
  try {
    const obj = parseJsonc(text);
    if (!isPlainObject(obj) || !mcpServerNames(obj).includes(name)) {
      return '';
    }
    return sha1(canonicalJson((serverTable(obj) || obj)[name]));
  } catch {
    return '';
  }
}

// Whether the original of a copy still holds what the scan read.
function stillSame(copy) {
  try {
    if (copy.kind === 'mcp') {
      return serverKeyIn(fs.readFileSync(copy.file, 'utf8'), copy.originalName) === copy.originalKey;
    }
    return (
      contentKey(copy) === copy.originalKey &&
      (copy.kind !== 'skill' || JSON.stringify(skillLinks(copy.src)) === JSON.stringify(copy.links))
    );
  } catch {
    return false;
  }
}

// ---- preview ------------------------------------------------------------------------------------------------------

// The Markdown of the read-only preview (see the plan of request 26 for each line).
function previewMarkdown({ sources, groups, errors }) {
  const label = (g) => KINDS[g.kind].label;
  const blocks = [
    '# New team repository: preview',
    `Scanned: ${sources.map((s) => s.label).join(', ')}. Nothing is written until you confirm at the end.`,
  ];
  const section = (title, lines, intro) => {
    if (lines.length > 0) {
      blocks.push(`## ${title} (${lines.length})`);
      if (intro) {
        blocks.push(intro);
      }
      blocks.push(lines.join('\n'));
    }
  };
  section(
    'Ready to import',
    groups
      .filter((g) => g.status !== 'variants')
      .map((g) =>
        g.status === 'single'
          ? `- ${label(g)} \`${g.name}\`: ${g.copies[0].where}`
          : `- ${label(g)} \`${g.name}\`: identical in ${g.copies.map((c) => c.where).join(', ')} (${g.copies.length} copies, imported once)`,
      ),
  );
  section(
    'Variants that need a decision',
    groups
      .filter((g) => g.status === 'variants')
      .map((g) => {
        const versions = g.versions
          .map((v) => (g.kind === 'mcp' ? v[0].where : `${v[0].where} (${v[0].lines} lines)`))
          .join(', ');
        return `- ${label(g)} \`${g.name}\`: ${g.versions.length} versions: ${versions}`;
      }),
  );
  section(
    'May contain a secret',
    groups.flatMap((g) => g.suspects.map((s) => `- ${label(g)} \`${g.name}\` (${s.where}): ${s.text}`)),
    'Unticked in the next step: tick them only if you checked them.',
  );
  section(
    'Secrets replaced',
    groups.flatMap((g) =>
      g.replaced.map(
        (r) => `- ${label(g)} \`${g.name}\` (${r.where}): ${r.field} now reads the environment variable ${r.variable}.`,
      ),
    ),
  );
  section(
    'References that may break',
    groups.flatMap((g) =>
      g.references.map((r) => {
        if (g.kind !== 'mcp') {
          const head = `- ${label(g)} \`${g.name}\` (${r.where}:${r.line}): `;
          if (r.why === 'link') {
            return `${head}links to ${r.target}, which stays where it is.`;
          }
          if (r.why === 'mention') {
            return `${head}mentions ${r.target}, which stays where it is.`;
          }
          return `${head}points to ${r.target}, a path on this machine only.`;
        }
        const head = `- ${label(g)} \`${g.name}\` (${r.where}): `;
        if (r.why === 'workspaceFolder') {
          return `${head}${r.field} uses \${workspaceFolder}: every project needs that file.`;
        }
        if (r.why === 'relative') {
          return `${head}${r.field} is the relative path ${r.value}: in a plugin, write \${CURSOR_PLUGIN_ROOT}/${r.value.replace(/^\.[\\/]/, '')} for a file the plugin holds.`;
        }
        return `${head}${r.field} is the absolute path ${r.value}, a path on this machine only.`;
      }),
    ),
  );
  section(
    'Renamed for Cursor',
    groups.flatMap((g) => g.renamed.map((c) => `- ${label(g)} \`${c.originalName}\` (${c.where}) becomes \`${c.name}\`.`)),
    'Cursor accepts lowercase letters, digits, hyphens and dots.',
  );
  section(
    'Not read',
    (errors || []).map((e) => `- ${e.file}: ${e.message}`),
  );
  return `${blocks.join('\n\n')}\n`;
}

// The rels of the files of two skill folders that differ or exist on one side only. Empty merge placeholders count as absent.
function skillDiff(dirA, dirB, placeholders = new Set()) {
  const read = (dir, ignored) => new Map(skillFiles(dir)
    .filter((f) => !ignored?.has(f.full))
    .map((f) => [f.rel, keyBytes(fs.readFileSync(f.full))]));
  const a = read(dirA);
  const b = read(dirB, placeholders);
  const out = [];
  for (const rel of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(rel) || !b.has(rel) || !a.get(rel).equals(b.get(rel))) {
      out.push(rel);
    }
  }
  return out.sort();
}

function prepareSkillMergeFile(dir, rel) {
  const parts = rel.split('/');
  let file = dir;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat && !(i === parts.length - 1 ? stat.isFile() : stat.isDirectory())) {
      return { conflict: parts.slice(0, i + 1).join('/') };
    }
  }
  if (fs.existsSync(file)) {
    return { file };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  return { file, created: true };
}

// ---- names of the versions kept side by side ----------------------------------------------------------------------

// `stem-tail`, the stem cut so that the name stays within 64 characters.
function fit(stem, tail) {
  const cut = stem.slice(0, Math.max(64 - tail.length - 1, 0)).replace(/[^A-Za-z0-9]+$/, '');
  return `${cut}-${tail}`;
}

// The names of the versions of a group imported side by side, one per version, free in `taken` (a Set of the names of
// that kind) and valid; `taken` is not modified.
function splitNames(group, taken = new Set()) {
  const given = new Set();
  const bad = (n) =>
    taken.has(n) ||
    given.has(n) ||
    (group.kind === 'mcp' ? serverNameError(n) : nameError(n)) !== '' ||
    reservedName(n);
  const out = [];
  group.versions.forEach((version, i) => {
    const copy = version[0];
    let raw = copy.source.personal ? 'personal' : copy.source.label;
    if (copy.kind === 'rule' && copy.rel && copy.rel.startsWith('.cursor/rules/')) {
      const folders = copy.rel.slice('.cursor/rules/'.length).split('/').slice(0, -1);
      if (folders.length > 0) {
        raw += `-${folders.join('-')}`;
      }
    }
    let name = fit(group.name, share.suggestName(raw));
    if (bad(name)) {
      let found = '';
      for (let k = 2; k <= 999 && !found; k++) {
        const candidate = fit(name, String(k));
        if (!bad(candidate)) {
          found = candidate;
        }
      }
      name = found || `${group.kind}-${Date.now()}-${i}`;
    }
    given.add(name);
    out.push(name);
  });
  return out;
}

// ---- building -----------------------------------------------------------------------------------------------------

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function filesUnder(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (prefix === '' && e.name === '.git') {
        continue;
      }
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(path.join(dir, e.name), rel);
      } else {
        out.push(rel);
      }
    }
  };
  walk(root, '');
  return out.sort(byString);
}

// Writes the repository: marketplace.json, the plugin and its items. items: [{ kind, name, originalName, ext, src }];
// servers: [{ name, entry }]. -> { pluginDir, files, skipped, errors } (errors: [{ name, message }]).
function buildRepository(repoDir, { marketplaceName, pluginName, items, servers }) {
  const pluginDir = path.join(repoDir, pluginName);
  const errors = [];
  const skipped = [];
  writeJson(path.join(repoDir, '.cursor-plugin', 'marketplace.json'), {
    name: marketplaceName,
    plugins: [{ name: pluginName, source: `./${pluginName}` }],
  });
  writeJson(path.join(pluginDir, '.cursor-plugin', 'plugin.json'), { name: pluginName, version: '0.1.0' });
  for (const item of items) {
    const result = share.shareItem(
      { kind: item.kind, name: item.originalName, ext: item.ext, src: item.src },
      pluginDir,
      item.name,
      repoDir,
    );
    if (result.error) {
      errors.push({ name: item.name, message: result.error });
      continue;
    }
    if (item.kind !== 'skill' && item.name !== item.originalName) {
      const text = fs.readFileSync(result.file, 'utf8');
      const next = share.renameSkillName(text, item.originalName, item.name);
      if (next !== text) {
        fs.writeFileSync(result.file, next);
      }
    }
    skipped.push(...result.skipped.map((rel) => `${item.name}/${rel}`));
  }
  if (servers && servers.length > 0) {
    writeJson(path.join(pluginDir, 'mcp.json'), {
      mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.entry])),
    });
  }
  return { pluginDir, files: filesUnder(repoDir), skipped, errors };
}

// The variable of a replaced secret in a server kept under its own name (a split): named after that server, so two
// variants that need different accounts never share one variable.
function splitVariable(serverName, variable) {
  return envVarName(`${serverName}_${variable}`);
}

// The entry with every `${env:OLD}` of `renames` (Map OLD -> NEW) written `${env:NEW}`.
function renameVariables(value, renames) {
  if (typeof value === 'string') {
    return value.replace(/\$\{env:([A-Z][A-Z0-9_]*)\}/g, (m, v) => (renames.has(v) ? `\${env:${renames.get(v)}}` : m));
  }
  if (Array.isArray(value)) {
    return value.map((v) => renameVariables(v, renames));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renameVariables(v, renames)]));
  }
  return value;
}

// The variables a copy's replaced secrets read in the import: renamed after the server for a split.
function importedVariables(copy, choice, serverName) {
  const variables = (copy.replaced || []).map((r) => r.variable);
  return choice && choice.kind === 'split' ? variables.map((v) => splitVariable(serverName, v)) : variables;
}

// What the choices import: { items, servers, imported } for buildRepository. choices: Map group id -> { kind: 'use',
// version } | { kind: 'merged', src, ext, originalName? } | { kind: 'split', names } | { kind: 'out' }; a group with no
// choice is not imported.
function planImport(groups, choices) {
  const items = [];
  const servers = [];
  const imported = [];
  for (const group of groups) {
    const choice = choices.get(group.id);
    if (!choice || choice.kind === 'out') {
      continue;
    }
    const entries = [];
    if (choice.kind === 'use') {
      entries.push({ name: group.name, copy: group.versions[choice.version][0] });
    } else if (choice.kind === 'merged') {
      entries.push({ name: group.name, merged: choice });
    } else if (choice.kind === 'split') {
      group.versions.forEach((v, i) => entries.push({ name: choice.names[i], copy: v[0] }));
    }
    for (const e of entries) {
      if (group.kind === 'mcp') {
        let entry = e.copy ? e.copy.entry : e.merged.src;
        if (choice.kind === 'split') {
          const renames = new Map((e.copy.replaced || []).map((r) => [r.variable, splitVariable(e.name, r.variable)]));
          entry = renameVariables(entry, renames);
        }
        servers.push({ name: e.name, entry });
      } else {
        items.push({
          kind: group.kind,
          name: e.name,
          originalName: e.copy ? e.copy.originalName : e.merged.originalName || group.name,
          ext: e.copy ? e.copy.ext : e.merged.ext,
          src: e.copy ? e.copy.src : e.merged.src,
        });
      }
      // variables: what the imported server's replaced secrets read (renamed after the server for a split)
      const variables =
        group.kind !== 'mcp'
          ? []
          : e.copy
            ? importedVariables(e.copy, choice, e.name)
            : (e.merged.replaced || []).map((r) => r.variable);
      imported.push({ group, ...e, variables });
    }
  }
  return { items, servers, imported };
}

// ---- git ----------------------------------------------------------------------------------------------------------

// { ok: true } or { ok: false, message }: git runs, is recent enough and knows who the user is.
async function gitReady({ run, cwd }) {
  const check = await checkGit({ run, cwd });
  if (check.status !== 'ok') {
    return { ok: false, message: gitCheckMessage(check).message };
  }
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const r = await run(['var', ident], cwd);
    if (r.code !== 0) {
      return { ok: false, message: IDENTITY_MESSAGE };
    }
  }
  return { ok: true };
}

// The branch a new repository starts on: `init.defaultBranch` when git accepts it, else main.
async function defaultBranch({ run, cwd }) {
  const configured = await run(['config', '--get', 'init.defaultBranch'], cwd);
  const value = configured.code === 0 ? configured.stdout.trim() : '';
  if (value) {
    const valid = await run(['check-ref-format', '--branch', value], cwd);
    if (valid.code === 0) {
      return value;
    }
  }
  return 'main';
}

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = [/^[^\s/\\@:]+@[^\s/\\:]+:/, /^[A-Za-z0-9.-]{2,}:[^\\/]/];

function isLocalPath(t) {
  return !SCHEME_URL.test(t) && !SCP_LIKE.some((re) => re.test(t));
}

// '' when the text can be the URL of the new repository, else why not.
function urlError(text) {
  const t = String(text).trim();
  if (!t) {
    return 'Enter a Git URL';
  }
  if (t.startsWith('-')) {
    return "A Git URL can't start with -";
  }
  if (/^https?:\/\/[^/?#]*@/i.test(t)) {
    return 'Leave the user name and password out of the URL: git gets them from your credential manager.';
  }
  // any other URL with a password (an SSH user name alone stays allowed)
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#@]*:[^/?#@]*@/i.test(t)) {
    return 'Leave the password out of the URL: git gets it from your SSH agent or credential manager.';
  }
  if (/[?#]/.test(t)) {
    return 'A Git URL with ? or # is not supported here.';
  }
  if (isLocalPath(t) && !path.isAbsolute(t)) {
    return 'Give the absolute path of a local repository.';
  }
  return '';
}

// The URL to use: an absolute local path is written with path.resolve, anything else is kept.
function destination(text) {
  const t = String(text).trim();
  return isLocalPath(t) && path.isAbsolute(t) ? path.resolve(t) : t;
}

// { kind: 'empty' } when the remote has no ref, else the classified failure or a 'notEmpty' error.
async function checkEmptyRemote({ run, cwd, url, idleMs }) {
  const r = await run(['ls-remote', '--', url], cwd, 0, { idleMs });
  if (r.code !== 0) {
    return redacted(remoteResult(r, { url, op: 'read' }, `cannot reach ${url}: ${r.stderr}`));
  }
  if (r.stdout.trim() === '') {
    return { kind: 'empty' };
  }
  return redacted({
    kind: 'error',
    reason: 'notEmpty',
    message: `${url} already has commits: give the URL of an empty repository, or follow this one with Add repository.`,
  });
}

// Initialises the repository, commits the files and checks that git committed exactly `files` (a .gitignore of a copied
// skill could leave some out): { head } or an error result.
async function initAndCommit({ run, dir, branch, files }) {
  const init = await run(['init', '-q', '-b', branch], dir);
  if (init.code !== 0) {
    return { kind: 'error', message: `git init failed: ${init.stderr}` };
  }
  const failed = await commitAll(run, dir, 'Create the team repository');
  if (failed) {
    return failed;
  }
  const tree = await run(['ls-tree', '-r', '-z', '--name-only', 'HEAD'], dir, 0, { trim: false });
  if (tree.code !== 0) {
    return { kind: 'error', message: `git ls-tree failed: ${tree.stderr}` };
  }
  const committed = tree.stdout.split('\0').filter(Boolean).sort(byString);
  const wanted = [...files].sort(byString);
  const missing = wanted.filter((f) => !committed.includes(f));
  const extra = committed.filter((f) => !wanted.includes(f));
  if (missing.length > 0 || extra.length > 0) {
    const parts = [];
    if (missing.length > 0) {
      parts.push(`git left out ${missing.join(', ')} (a .gitignore in a copied skill?)`);
    }
    if (extra.length > 0) {
      parts.push(`git added ${extra.join(', ')}`);
    }
    return { kind: 'error', message: `${parts.join(' and ')}: nothing was pushed.` };
  }
  const head = await run(['rev-parse', 'HEAD'], dir);
  return { head: head.stdout.trim() };
}

// Pushes HEAD to the new branch of the empty remote: { kind: 'pushed' } or the classified failure.
async function pushNew({ run, dir, url, branch }) {
  const r = await run(['push', '--progress', url, `HEAD:refs/heads/${branch}`], dir, 0, { idleMs: NETWORK_IDLE_MS });
  if (r.code === 0) {
    return { kind: 'pushed' };
  }
  return redacted(remoteResult(r, { url, branch, op: 'push' }, `git push failed: ${r.stderr}`));
}

// What the remote holds at the branch: 'absent', 'pushed' (at `head`) or 'other'; or the classified failure.
async function remoteBranchState({ run, cwd, url, branch, head }) {
  const r = await run(['ls-remote', '--', url, `refs/heads/${branch}`], cwd, 0, { idleMs: NETWORK_IDLE_MS });
  if (r.code !== 0) {
    return redacted(remoteResult(r, { url, branch, op: 'read' }, `cannot reach ${url}: ${r.stderr}`));
  }
  const line = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/))
    .find((parts) => parts[1] === `refs/heads/${branch}`);
  if (!line) {
    return 'absent';
  }
  return line[0] === head ? 'pushed' : 'other';
}

// The entry of teamPlugins.repositories: no branch when the server's HEAD is the pushed branch.
function repositoryEntry(url, branch, check) {
  return check && check.kind === 'reachable' && check.defaultBranch === branch ? { url } : { url, branch };
}

// ---- originals ----------------------------------------------------------------------------------------------------

// The pushed commit must be present, with the plugin unchanged in both HEAD and the working tree Cursor loads.
async function checkReplacementPlugin({ run, dir, folder, head }) {
  const ancestor = await run(['merge-base', '--is-ancestor', head, 'HEAD'], dir);
  if (ancestor.code !== 0) {
    return ancestor;
  }
  const committed = await run(['diff', '--quiet', head, 'HEAD', '--', folder], dir);
  return committed.code === 0 ? run(['diff', '--quiet', 'HEAD', '--', folder], dir) : committed;
}

// The originals of what was imported, for Replace the originals: one per copy of each imported group, personal first,
// then by source, then by group. dropped: a Set of group ids Cursor would drop. -> [{ kind, name, where, sourceLabel,
// personal, src?, rel?, source?, file?, serverName?, replaced, copy, picked, reason }].
function originalsOf(groups, choices, { dropped = new Set() } = {}) {
  const out = [];
  groups.forEach((group, groupIndex) => {
    const choice = choices.get(group.id);
    if (!choice || choice.kind === 'out') {
      return;
    }
    const nameOf = (copy) => (choice.kind === 'split' ? choice.names[group.versions.findIndex((v) => v.includes(copy))] : group.name);
    group.versions.forEach((version, versionIndex) => {
      for (const copy of version) {
        let picked = true;
        let reason = '';
        if (choice.kind === 'use' && versionIndex !== choice.version) {
          picked = false;
          reason = 'another version was imported';
        } else if (choice.kind === 'merged') {
          picked = false;
          reason = 'merged by hand: check that your merge covers it';
        }
        const variables = importedVariables(copy, choice, nameOf(copy));
        if (dropped.has(group.id)) {
          picked = false;
          reason = 'Cursor would drop the imported copy';
        } else if (copy.links && copy.links.length > 0) {
          picked = false;
          reason = 'its links were not copied';
        } else if (variables.length > 0) {
          picked = false;
          reason = `holds your ${variables.join(', ')} value: set the environment variable first`;
        }
        const record = {
          kind: group.kind,
          name: nameOf(copy),
          where: copy.where,
          sourceLabel: copy.source.personal ? '~/.cursor' : copy.source.label,
          personal: Boolean(copy.source.personal),
          source: copy.source,
          replaced: variables,
          copy,
          picked,
          reason,
          order: [copy.source.personal ? 0 : 1, copy.sourceIndex || 0, groupIndex],
        };
        if (group.kind === 'mcp') {
          record.file = copy.file;
          record.serverName = copy.originalName;
        } else {
          record.src = copy.src;
          record.rel = copy.rel;
        }
        out.push(record);
      }
    });
  });
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.order[0] - b.r.order[0] || a.r.order[1] - b.r.order[1] || a.r.order[2] - b.r.order[2] || a.i - b.i)
    .map(({ r }) => {
      delete r.order;
      return r;
    });
}

// The text of an mcp.json without the servers `names`: { text } or { error }. The servers that stay must be exactly the
// ones that were there minus `names` (removing the last of `mcpServers` would turn the top-level entries into servers).
function removeServers(text, names) {
  let obj;
  try {
    obj = parseJsonc(text);
  } catch {
    return { error: 'not valid JSONC' };
  }
  if (!isPlainObject(obj)) {
    return { error: 'not a JSON object' };
  }
  const before = mcpServerNames(obj);
  const where = serverTable(obj) ? ['mcpServers'] : [];
  let next = text;
  try {
    for (const name of names) {
      next = removeMember(next, where, name);
    }
  } catch {
    return { error: 'not valid JSONC' };
  }
  let after;
  try {
    after = mcpServerNames(parseJsonc(next));
  } catch {
    return { error: 'removing them would change other servers' };
  }
  const expected = before.filter((n) => !names.includes(n)).sort(byString);
  if (JSON.stringify([...after].sort(byString)) !== JSON.stringify(expected)) {
    return { error: 'removing them would change other servers' };
  }
  return { text: next };
}

module.exports = {
  secretName,
  envVarName,
  redactServer,
  textSuspects,
  normalizeText,
  isText,
  skillFiles,
  skillLinks,
  contentKey,
  canonicalJson,
  reservedName,
  importName,
  itemReferences,
  serverReferences,
  scanSource,
  scan,
  stillSame,
  serverKeyIn,
  itemSuspects,
  splitVariable,
  previewMarkdown,
  skillDiff,
  prepareSkillMergeFile,
  splitNames,
  buildRepository,
  planImport,
  gitReady,
  defaultBranch,
  urlError,
  destination,
  checkEmptyRemote,
  initAndCommit,
  pushNew,
  remoteBranchState,
  repositoryEntry,
  checkReplacementPlugin,
  originalsOf,
  removeServers,
};
