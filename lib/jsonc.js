'use strict';

// Text edits of JSONC files (comments, trailing commas and a BOM are accepted, as in Cursor's mcp.json): the rest of
// the text is kept as it is, comments and layout included. The callers parse the text with checks.parseJsonc first,
// so these functions may assume valid JSONC. Pure: never requires vscode.

const PUNCTUATION = '{}[]:,';

// The tokens of the text: [{ type, start, end }] (end exclusive). type: one of { } [ ] : , or 'string' (a quoted
// string, key or value) or 'value' (a number, true, false or null). Whitespace, comments and a leading BOM are skipped.
function tokens(text) {
  const out = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') {
        i++;
      }
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
    } else if (PUNCTUATION.includes(c)) {
      out.push({ type: c, start: i, end: i + 1 });
      i++;
    } else if (c === '"') {
      const start = i;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\') {
          i++;
        }
        i++;
      }
      i++;
      out.push({ type: 'string', start, end: Math.min(i, n) });
    } else {
      const start = i;
      while (
        i < n &&
        !/\s/.test(text[i]) &&
        !PUNCTUATION.includes(text[i]) &&
        text[i] !== '"' &&
        !(text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*'))
      ) {
        i++;
      }
      out.push({ type: 'value', start, end: i });
    }
  }
  return out;
}

// The index of the token that closes the { or [ at index `open`.
function closing(toks, open) {
  let depth = 0;
  for (let i = open; i < toks.length; i++) {
    const t = toks[i].type;
    if (t === '{' || t === '[') {
      depth++;
    } else if (t === '}' || t === ']') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return toks.length - 1;
}

// The members of the object whose { is at index `open`: [{ name, keyIndex }].
function members(text, toks, open) {
  const close = closing(toks, open);
  const out = [];
  let depth = 0;
  for (let i = open + 1; i < close; i++) {
    const t = toks[i].type;
    if (t === '{' || t === '[') {
      depth++;
    } else if (t === '}' || t === ']') {
      depth--;
    } else if (depth === 0 && t === 'string' && toks[i + 1] && toks[i + 1].type === ':') {
      out.push({ name: JSON.parse(text.slice(toks[i].start, toks[i].end)), keyIndex: i });
    }
  }
  return out;
}

// { open, close }: the token indexes of the { and } of the object at pathKeys ([] or ['mcpServers']).
function findObject(text, toks, pathKeys) {
  if (toks.length === 0 || toks[0].type !== '{') {
    throw new Error('not an object');
  }
  let open = 0;
  for (const key of pathKeys) {
    const found = members(text, toks, open).filter((m) => m.name === key);
    if (found.length === 0) {
      throw new Error(`no member ${key}`);
    }
    const valueIndex = found[found.length - 1].keyIndex + 2; // the last one wins, as in JSON.parse
    if (!toks[valueIndex] || toks[valueIndex].type !== '{') {
      throw new Error(`"${key}" is not an object`);
    }
    open = valueIndex;
  }
  return { open, close: closing(toks, open) };
}

// The text with every member `from` of the object at pathKeys renamed to `to`.
function renameKey(text, pathKeys, from, to) {
  const toks = tokens(text);
  const { open } = findObject(text, toks, pathKeys);
  const found = members(text, toks, open).filter((m) => m.name === from);
  if (found.length === 0) {
    throw new Error(`no member ${from}`);
  }
  let out = text;
  for (const m of found.reverse()) {
    const t = toks[m.keyIndex];
    out = out.slice(0, t.start) + JSON.stringify(to) + out.slice(t.end);
  }
  return out;
}

// The text with the member `name: value` added at the end of the object at pathKeys: indented like the members already
// there, after a comma where one is missing, and kept compact in a compact object.
function addMember(text, pathKeys, name, value) {
  const toks = tokens(text);
  const { open, close } = findObject(text, toks, pathKeys);
  const o = toks[open].start;
  const c = toks[close].start;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = (pos) => (pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1);
  const indentOf = (pos) => /^[ \t]*/.exec(text.slice(lineStart(pos)))[0];
  const firstOnLine = (pos) => /^[ \t]*$/.test(text.slice(lineStart(pos), pos));
  const last = toks[close - 1];
  const empty = close - 1 === open;
  const ind = !empty && firstOnLine(toks[open + 1].start) ? indentOf(toks[open + 1].start) : `${indentOf(o)}  `;
  const pretty = `${JSON.stringify(name)}: ${JSON.stringify(value, null, 2).replace(/\n/g, nl + ind)}`;
  const compact = `${JSON.stringify(name)}:${JSON.stringify(value)}`;

  let out = text;
  if (firstOnLine(c)) {
    const at = lineStart(c);
    out = out.slice(0, at) + ind + pretty + nl + out.slice(at);
  } else if (empty && /^[ \t]*$/.test(text.slice(o + 1, c))) {
    out = `${out.slice(0, o)}{${nl}${ind}${pretty}${nl}${indentOf(o)}}${out.slice(c + 1)}`;
  } else {
    out = out.slice(0, c) + compact + out.slice(c);
  }
  if (!empty && last.type !== ',') {
    out = out.slice(0, last.end) + ',' + out.slice(last.end);
  }
  return out;
}

module.exports = { tokens, renameKey, addMember };
