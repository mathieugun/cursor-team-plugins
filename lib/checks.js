'use strict';

// Problems Cursor would drop or misread in a team repository: frontmatter that gray-matter (js-yaml 3) can't parse, a
// skill or agent without a description, JSON that doesn't parse, conflict markers. Pure: never requires `vscode` or
// `catalog` (catalog requires this module).
//
// A problem is { file, line, severity, message }: file an absolute path ('' when none), line 1-based (0 when none),
// severity 'error' (Cursor drops or ignores something) or 'warning' (loaded but degraded).

const path = require('path');

const KIND_WORDS = { skill: 'skill', rule: 'rule', command: 'command', agent: 'agent' };

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s\-?:,[\]{}#&*!|>'"%@`][^\n]*?|-[^\s][^\n]*?)[ \t]*:(?:[ \t]+|$)(.*)$/;

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

function isBlankOrComment(line) {
  return /^[ \t]*(#.*)?$/.test(line);
}

// Cuts a plain scalar's comment: from the first '#' that follows a space or a tab.
function stripComment(text) {
  const m = /[ \t]#/.exec(text);
  return (m ? text.slice(0, m.index) : text).trimEnd();
}

const COLON = (key) => `the value of "${key}" contains ": " or ends with ":": put the value in quotes`;

const hasColonSpace = (t) => /:([ \t]|$)/.test(t);

// Scans a quoted scalar from lines[i] at column col (the opening quote). Returns { endLine, rest } or null (unclosed).
function scanQuoted(lines, i, col) {
  const q = lines[i][col];
  const pos = col + 1;
  for (let l = i; l < lines.length; l++) {
    const s = lines[l];
    for (let c = l === i ? pos : 0; c < s.length; c++) {
      if (q === '"' && s[c] === '\\') {
        c++;
        continue;
      }
      if (s[c] === q) {
        if (q === "'" && s[c + 1] === "'") {
          c++;
          continue;
        }
        return { endLine: l, rest: s.slice(c + 1) };
      }
    }
  }
  return null;
}

// Scans a flow collection ([ or {) from lines[i] at column col. Returns { endLine, rest } or null (unclosed).
function scanFlow(lines, i, col) {
  let depth = 0;
  let quote = null;
  for (let l = i; l < lines.length; l++) {
    const s = lines[l];
    for (let c = l === i ? col : 0; c < s.length; c++) {
      const ch = s[c];
      if (quote) {
        if (quote === '"' && ch === '\\') {
          c++;
        } else if (ch === quote) {
          if (quote === "'" && s[c + 1] === "'") {
            c++;
          } else {
            quote = null;
          }
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '#' && (c === 0 || /[ \t]/.test(s[c - 1]))) {
        break; // comment to the end of the line
      } else if (ch === '[' || ch === '{') {
        depth++;
      } else if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          return { endLine: l, rest: s.slice(c + 1) };
        }
      }
    }
  }
  return null;
}

const restOk = (rest) => /^[ \t]*(#.*)?$/.test(rest);

// lines: the frontmatter block (no delimiters, no \r). Returns { error: { line, detail } } (line 0-based in the
// block) | { keys: Map key -> { kind, line, end (the line after its value), value } } | { notMapping: true } |
// { empty: true } | { unknown: true }
function lintFrontmatter(lines) {
  const content = lines.map((l, i) => i).filter((i) => !isBlankOrComment(lines[i]));
  if (content.length === 0) {
    return { empty: true };
  }
  const first = content[0];
  const base = indentOf(lines[first]);
  if (!KEY_RE.test(lines[first].slice(base)) || /^\?([ \t]|$)/.test(lines[first].slice(base))) {
    return /^\?([ \t]|$)/.test(lines[first].slice(base)) ? { unknown: true } : { notMapping: true };
  }
  const keys = new Map();
  const anchors = new Set();
  const err = (line, detail) => ({ error: { line, detail } });
  let i = first;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind !== base) {
      return err(i, 'bad indentation');
    }
    const body = line.slice(base);
    if (/^\?([ \t]|$)/.test(body)) {
      return { unknown: true };
    }
    const m = KEY_RE.exec(body);
    if (!m) {
      return err(i, 'this line is not a "key: value" line (indent it to continue the value above)');
    }
    let key = m[1];
    if (key[0] === '"' || key[0] === "'") {
      key = key.slice(1, -1);
    }
    if (keys.has(key)) {
      return err(i, `"${key}" appears twice`);
    }
    let v = m[2];
    let kind = 'plain';
    // anchors and tags before the value
    for (;;) {
      const a = /^&(\S+)[ \t]*/.exec(v);
      if (a) {
        anchors.add(a[1]);
        v = v.slice(a[0].length);
        continue;
      }
      const t = /^!!\S*[ \t]*/.exec(v);
      if (t) {
        v = v.slice(t[0].length);
        continue;
      }
      break;
    }
    const col = line.length - v.length;
    let next = i + 1;
    if (v === '' || v[0] === '#') {
      kind = 'nested';
      // the nested block: deeper lines, or '- ' entries at the base indent
      while (next < lines.length) {
        const l = lines[next];
        if (isBlankOrComment(l)) {
          next++;
          continue;
        }
        const n = indentOf(l);
        if (n > base || (n === base && /^-([ \t]|$)/.test(l.slice(base)))) {
          next++;
          continue;
        }
        break;
      }
      // simple nested 'key: plain' lines with ': ' in the plain value
      const nestedErr = checkNested(lines, i + 1, next, base);
      if (nestedErr) {
        return nestedErr;
      }
    } else if (v[0] === '|' || v[0] === '>') {
      if (!/^[|>][1-9+-]{0,2}[ \t]*(#.*)?$/.test(v)) {
        return { unknown: true };
      }
      kind = 'block';
      let blockIndent = -1;
      while (next < lines.length) {
        const l = lines[next];
        if (l.trim() === '') {
          next++;
          continue;
        }
        const n = indentOf(l);
        if (n <= base) {
          break;
        }
        if (blockIndent < 0) {
          blockIndent = n;
        } else if (n < blockIndent) {
          return err(next, `bad indentation in the value of "${key}"`);
        }
        next++;
      }
    } else if (v[0] === '"' || v[0] === "'") {
      kind = 'quoted';
      const s = scanQuoted(lines, i, col);
      if (!s) {
        return err(i, `the quote that opens the value of "${key}" is never closed`);
      }
      if (!restOk(s.rest)) {
        return err(s.endLine, `text after the closing quote in the value of "${key}": put the whole value in quotes`);
      }
      next = s.endLine + 1;
    } else if (v[0] === '[' || v[0] === '{') {
      kind = 'flow';
      const s = scanFlow(lines, i, col);
      if (!s) {
        return err(i, `the ${v[0]} that opens the value of "${key}" is never closed`);
      }
      if (!restOk(s.rest)) {
        return err(s.endLine, `text after the closing ${v[0] === '[' ? ']' : '}'} in the value of "${key}": put the whole value in quotes`);
      }
      next = s.endLine + 1;
    } else if (v[0] === '*') {
      const name = /^\*([^\s,[\]{}]+)/.exec(v);
      if (!name || !anchors.has(name[1])) {
        return err(i, `the value of "${key}" starts with "*", which YAML reads as a reference: put the value in quotes`);
      }
      kind = 'alias';
    } else if (v[0] === '!') {
      return err(i, `the value of "${key}" starts with "!": put the value in quotes`);
    } else if (v[0] === '@' || v[0] === '`' || v[0] === '%') {
      return err(i, `the value of "${key}" starts with "${v[0]}": put the value in quotes`);
    } else if (/^-([ \t]|$)/.test(v) || /^:([ \t]|$)/.test(v)) {
      return err(i, `the value of "${key}" starts with "${v[0]} ": put the value in quotes`);
    } else {
      if (hasColonSpace(stripComment(v))) {
        return err(i, COLON(key));
      }
      // continuation lines of a plain scalar
      let ended = /[ \t]#/.test(v);
      while (next < lines.length) {
        const l = lines[next];
        if (l.trim() === '') {
          next++;
          continue;
        }
        if (indentOf(l) <= base) {
          break;
        }
        if (/^[ \t]*#/.test(l)) {
          ended = true;
        }
        if (!ended && hasColonSpace(stripComment(l.trim()))) {
          return err(next, COLON(key));
        }
        if (/[ \t]#/.test(l)) {
          ended = true;
        }
        next++;
      }
    }
    keys.set(key, { kind, line: i, end: next, value: kind === 'plain' ? stripComment(v) : '' });
    i = next;
  }
  return { keys };
}

// Nested lines from..to (exclusive) under a key at indent base: flags a 'key: plain' line whose plain value contains
// ': ', skipping the deeper lines of a nested block scalar, quoted or flow value (not checked).
function checkNested(lines, from, to, base) {
  let skipDeeperThan = -1;
  for (let i = from; i < to; i++) {
    const l = lines[i];
    if (isBlankOrComment(l)) {
      continue;
    }
    const n = indentOf(l);
    if (skipDeeperThan >= 0) {
      if (n > skipDeeperThan) {
        continue;
      }
      skipDeeperThan = -1;
    }
    const body = l.slice(n);
    if (/^-([ \t]|$)/.test(body)) {
      continue; // a sequence entry: not checked
    }
    const m = KEY_RE.exec(body);
    if (!m) {
      continue;
    }
    const v = m[2];
    if (v === '' || v[0] === '#') {
      continue;
    }
    if (/^[|>"'[{]/.test(v)) {
      skipDeeperThan = n;
      continue;
    }
    if (/^[&*!@`%]/.test(v)) {
      continue;
    }
    if (hasColonSpace(stripComment(v))) {
      return { error: { line: i, detail: COLON(m[1].replace(/^["']|["']$/g, '')) } };
    }
  }
  return null;
}

// Splits a file the way gray-matter does. { frontmatter: null | { lines, closed }, body }
function splitFrontmatter(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) {
    t = t.slice(1);
  }
  t = t.replace(/\r\n?/g, '\n');
  if (!t.startsWith('---') || t[3] === '-') {
    return { frontmatter: null, body: t };
  }
  const lines = t.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].startsWith('---')) {
      return { frontmatter: { lines: lines.slice(1, i), closed: true }, body: lines.slice(i + 1).join('\n') };
    }
  }
  return { frontmatter: { lines: lines.slice(1), closed: false }, body: '' };
}

// The 1-based line of the first '<<<<<<<' line when a '>>>>>>>' line follows it, else 0.
function conflictMarkerLine(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const start = lines.findIndex((l) => /^<{7}(?: |$)/.test(l));
  if (start < 0) {
    return 0;
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (/^>{7}(?: |$)/.test(lines[i])) {
      return start + 1;
    }
  }
  return 0;
}

const CONFLICT_MESSAGE = 'Conflict markers (<<<<<<< ... >>>>>>>) are left from a merge';

// Values js-yaml 3 does not read as a string.
const TYPED =
  /^(?:~|null|Null|NULL|true|True|TRUE|false|False|FALSE|[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0o?[0-7_]+|(?:0|[1-9][0-9_]*)(?::[0-5]?[0-9])*|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|\.(?:inf|Inf|INF))|\.(?:nan|NaN|NAN)|\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::\d\d)?))?)?)$/;

// The problems of one skill, rule, command or agent file. frontmatterField(text, key): the catalog's reader of a
// frontmatter value (passed in because this module must not require the catalog).
function checkItemText(kind, text, file, frontmatterField) {
  const word = KIND_WORDS[kind] || kind;
  const out = [];
  const add = (line, severity, message) => out.push({ file, line, severity, message });
  const marker = conflictMarkerLine(text);
  if (marker > 0) {
    add(marker, 'error', CONFLICT_MESSAGE);
  }
  const fm = splitFrontmatter(text);
  let r = null;
  let broken = false;
  if (fm.frontmatter) {
    r = lintFrontmatter(fm.frontmatter.lines);
    if (r.error && fm.frontmatter.closed) {
      add(r.error.line + 2, 'error', `Frontmatter is not valid YAML, so Cursor drops this ${word}: ${r.error.detail}`);
      broken = true;
    } else if (r.error) {
      add(
        1,
        'error',
        `The frontmatter has no closing "---" line, so Cursor reads the whole file as frontmatter and drops this ${word}`,
      );
      broken = true;
    }
  }
  if (broken) {
    return out;
  }
  if ((kind === 'skill' || kind === 'agent') && !(r && r.unknown)) {
    const d = r && r.keys ? r.keys.get('description') : null;
    const missing =
      !r ||
      r.empty ||
      r.notMapping ||
      !d ||
      !['plain', 'quoted', 'block'].includes(d.kind) ||
      (d.kind === 'plain' && TYPED.test(d.value)) ||
      frontmatterField(text, 'description').trim() === '';
    if (missing) {
      add(d ? d.line + 2 : 1, 'warning', `No description: the agent can't tell when to use this ${word}`);
    }
  }
  if (kind === 'agent' && fm.body.trim() === '') {
    add(1, 'error', 'No instructions after the frontmatter, so Cursor drops this agent');
  }
  return out;
}

// JSON as Cursor's jsonc-parser reads it: a BOM, // and /* */ comments and trailing commas are accepted. Comments and
// the commas are blanked out (newlines kept) before JSON.parse; throws what JSON.parse throws.
function parseJsonc(text) {
  let t = String(text);
  if (t.charCodeAt(0) === 0xfeff) {
    t = t.slice(1);
  }
  const out = t.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') {
        out[k] = ' ';
      }
    }
  };
  const n = t.length;
  let lastComma = -1; // a comma outside strings with only whitespace and comments since
  let i = 0;
  while (i < n) {
    const c = t[i];
    if (c === '"') {
      lastComma = -1;
      i++;
      while (i < n && t[i] !== '"') {
        if (t[i] === '\\') {
          i++;
        }
        i++;
      }
      i++;
    } else if (c === '/' && t[i + 1] === '/') {
      let end = i;
      while (end < n && t[end] !== '\n' && t[end] !== '\r') {
        end++;
      }
      blank(i, end);
      i = end;
    } else if (c === '/' && t[i + 1] === '*') {
      const close = t.indexOf('*/', i + 2);
      const end = close < 0 ? n : close + 2;
      blank(i, end);
      i = end;
    } else if (c === ',') {
      lastComma = i;
      i++;
    } else if (c === ']' || c === '}') {
      if (lastComma >= 0) {
        out[lastComma] = ' ';
      }
      lastComma = -1;
      i++;
    } else {
      if (!/\s/.test(c)) {
        lastComma = -1;
      }
      i++;
    }
  }
  return JSON.parse(out.join(''));
}

// [] or one error problem. what: what Cursor loses with a strict JSON file that doesn't load (the sentence end).
function checkJsonText(text, file, { what = '', jsonc = false } = {}) {
  const name = path.basename(file);
  const problem = (line, message) => [{ file, line, severity: 'error', message }];
  if (!jsonc && text.charCodeAt(0) === 0xfeff) {
    return problem(1, `${name} starts with a byte order mark (BOM), so Cursor ignores it${what}: save it as UTF-8 without BOM`);
  }
  try {
    if (jsonc) {
      parseJsonc(text);
    } else {
      JSON.parse(text);
    }
  } catch (err) {
    const m = /position (\d+)/.exec(err.message);
    const line = m ? text.slice(0, Number(m[1])).split('\n').length : 1;
    return problem(
      line,
      jsonc
        ? `${name} is not valid JSON, so Cursor may not load its MCP servers: ${err.message}`
        : `${name} is not valid JSON, so Cursor ignores it${what}: ${err.message}`,
    );
  }
  return [];
}

// What Cursor reads as the name of a skill or rule when it de-duplicates them.
function skillKey(name) {
  return String(name).trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.-]/g, '');
}

const toPosix = (p) => p.split(path.sep).join('/');

// The problems a push must stop on. catalog: a raw readCatalog result of the repository; changed: repo-relative POSIX
// paths of what the push carries; readFile(abs): text or null.
function pushProblems({ catalog, repoDir, changed, readFile }) {
  const out = [...((catalog && catalog.problems) || [])];
  const root = path.resolve(repoDir);
  for (const plugin of (catalog && catalog.plugins) || []) {
    const dir = toPosix(path.relative(root, plugin.dir));
    const touched = (changed || []).some((p) => dir === '' || p === dir || p.startsWith(dir + '/'));
    if (!touched) {
      continue;
    }
    out.push(...(plugin.problems || []));
    for (const child of plugin.children || []) {
      out.push(...(child.problems || []));
    }
  }
  const covered = new Set(out.filter((p) => p.file).map((p) => path.resolve(p.file)));
  for (const p of changed || []) {
    const abs = path.join(root, p);
    if (covered.has(path.resolve(abs))) {
      continue;
    }
    const text = readFile(abs);
    if (typeof text !== 'string') {
      continue;
    }
    const line = conflictMarkerLine(text);
    if (line > 0) {
      out.push({ file: abs, line, severity: 'error', message: CONFLICT_MESSAGE });
    }
  }
  const seen = new Set();
  return out
    .filter((p) => {
      const key = `${p.file}|${p.line}|${p.message}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

module.exports = {
  splitFrontmatter,
  lintFrontmatter,
  stripComment,
  checkItemText,
  conflictMarkerLine,
  parseJsonc,
  checkJsonText,
  skillKey,
  pushProblems,
  KIND_WORDS,
};
