'use strict';

// The estimated context cost of the selection: what Cursor puts in every chat from the team plugins (always-applied
// rules and skills whole, the descriptions of skills and of agent-requested rules). An estimate: Cursor builds the
// prompt on its server, so it is counted at 4 characters per token. Pure: never requires `vscode` or `catalog`
// (catalog requires this module).

const checks = require('./checks');

// Cursor cuts the description of a skill or of an agent-requested rule to this many characters.
const DESCRIPTION_MAX = 1536;

const tokens = (chars) => Math.ceil(chars / 4);

// 0..99 as is, then rounded to 2 significant digits (123 -> 120), 1k..9.9k with one decimal, 10k and more as whole k.
function formatTokens(n) {
  if (n < 100) {
    return String(n);
  }
  const r = Math.round(n / 10) * 10;
  if (r < 1000) {
    return String(r);
  }
  if (n < 9950) {
    return `${Math.round(n / 100) / 10}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

// Cursor's reading of a `globs` string: a comma separated list, the commas inside {...} kept; parts trimmed, empty ones
// dropped. With the braces left unbalanced, the rest after the last split is split on every comma.
function splitGlobs(s) {
  if (typeof s !== 'string') {
    return [];
  }
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
      }
    } else if (ch === ',' && depth === 0) {
      parts.push(s.slice(from, i));
      from = i + 1;
    }
  }
  const rest = s.slice(from);
  if (depth > 0) {
    parts.push(...rest.split(','));
  } else {
    parts.push(rest);
  }
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// A part that starts and ends with the same quote loses them.
function unquote(part) {
  const p = part.trim();
  if (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p[p.length - 1] === p[0]) {
    return p.slice(1, -1).trim();
  }
  return p;
}

// The glob patterns of a `globs` entry of checks.lintFrontmatter (lines: the frontmatter lines).
function globsOf(entry, lines, text, frontmatterField) {
  if (!entry) {
    return [];
  }
  if (entry.kind === 'plain' || entry.kind === 'quoted' || entry.kind === 'block') {
    return splitGlobs(frontmatterField(text, 'globs'));
  }
  if (entry.kind === 'flow') {
    const first = lines[entry.line];
    const raw = [first.slice(first.indexOf(':') + 1), ...lines.slice(entry.line + 1, entry.end)].join(' ').trim();
    if (!raw.startsWith('[')) {
      return [];
    }
    const close = raw.lastIndexOf(']');
    const inner = close > 0 ? raw.slice(1, close) : raw.slice(1);
    return splitGlobs(inner).map(unquote).filter((p) => p !== '');
  }
  if (entry.kind === 'nested') {
    const out = [];
    for (const l of lines.slice(entry.line + 1, entry.end)) {
      const m = /^\s*-[ \t]+(.*)$/.exec(l);
      if (!m) {
        continue;
      }
      let v = unquote(m[1]);
      if (v === m[1].trim()) {
        v = unquote(checks.stripComment(m[1])); // not quoted, or quoted and followed by a comment
      }
      if (v !== '') {
        out.push(v);
      }
    }
    return out;
  }
  return [];
}

// How a skill or a rule is put in the context, and what it costs in characters. null for another kind of item, and when
// the frontmatter is one Cursor drops or that we can't read (we say nothing then). frontmatterField(text, key): the
// catalog's reader of a frontmatter value (passed in because this module must not require the catalog).
//   rule:  { apply: 'always' | 'globs' | 'agent' | 'manual', chars, globs? }
//   skill: { apply: 'always' | 'description' | 'hidden', chars }
function itemContext(kind, text, frontmatterField) {
  if (kind !== 'skill' && kind !== 'rule') {
    return null;
  }
  const fm = checks.splitFrontmatter(text);
  const body = fm.body.trim();
  let keys = new Map();
  let lines = [];
  if (fm.frontmatter) {
    if (!fm.frontmatter.closed) {
      return null;
    }
    lines = fm.frontmatter.lines;
    const r = checks.lintFrontmatter(lines);
    if (r.error || r.unknown) {
      return null;
    }
    if (r.keys) {
      keys = r.keys;
    }
  }
  const isTrue = (key) => {
    const e = keys.get(key);
    return Boolean(e) && e.kind === 'plain' && /^(?:true|True|TRUE)$/.test(e.value.trim());
  };
  const description = frontmatterField(text, 'description');
  const descChars = Math.min(description.length, DESCRIPTION_MAX);
  if (kind === 'rule') {
    if (isTrue('alwaysApply')) {
      return { apply: 'always', chars: body.length };
    }
    const globs = globsOf(keys.get('globs'), lines, text, frontmatterField);
    if (globs.length > 0) {
      return { apply: 'globs', chars: body.length, globs };
    }
    return description !== '' ? { apply: 'agent', chars: descChars } : { apply: 'manual', chars: 0 };
  }
  if (isTrue('alwaysApply')) {
    return { apply: 'always', chars: body.length };
  }
  if (isTrue('disable-model-invocation')) {
    return { apply: 'hidden', chars: 0 };
  }
  return { apply: 'description', chars: descChars };
}

// The cost of a set of children (those with a `context` count). Each bucket is rounded to tokens once, not per item.
// total: always + descriptions (the rules for matching files are not in it).
function costOf(children) {
  const always = { count: 0, chars: 0, onlyRules: true };
  const descriptions = { count: 0, chars: 0 };
  const globbed = { count: 0, chars: 0 };
  let known = false;
  for (const c of children) {
    const x = c.context;
    if (!x) {
      continue;
    }
    known = true;
    if (x.apply === 'always') {
      always.count++;
      always.chars += x.chars;
      if (c.kind !== 'rule') {
        always.onlyRules = false;
      }
    } else if (x.apply === 'agent' || x.apply === 'description') {
      descriptions.count++;
      descriptions.chars += x.chars;
    } else if (x.apply === 'globs') {
      globbed.count++;
      globbed.chars += x.chars;
    }
  }
  const out = {
    known,
    always: { count: always.count, tokens: tokens(always.chars), onlyRules: always.onlyRules },
    descriptions: { count: descriptions.count, tokens: tokens(descriptions.chars) },
    globbed: { count: globbed.count, tokens: tokens(globbed.chars) },
  };
  out.total = out.always.tokens + out.descriptions.tokens;
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The tooltip lines of a cost: `<prefix>: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)`, then the rules for
// matching files. [] when the cost is not known.
function costLines(cost, prefix) {
  if (!cost.known) {
    return [];
  }
  let text = 'nothing';
  if (cost.always.count + cost.descriptions.count > 0) {
    const parts = [];
    if (cost.always.count > 0) {
      parts.push(`${plural(cost.always.count, `always-applied ${cost.always.onlyRules ? 'rule' : 'item'}`)} ~${formatTokens(cost.always.tokens)}`);
    }
    if (cost.descriptions.count > 0) {
      parts.push(`${plural(cost.descriptions.count, 'description')} ~${formatTokens(cost.descriptions.tokens)}`);
    }
    text = `~${formatTokens(cost.total)} tokens (${parts.join(', ')})`;
  }
  const lines = [`${prefix}: ${text}`];
  const g = cost.globbed;
  if (g.count > 0) {
    lines.push(
      `For matching files: ${plural(g.count, 'rule')} (~${formatTokens(g.tokens)} tokens when ${g.count === 1 ? 'it applies' : 'they apply'})`,
    );
  }
  return lines;
}

// The cost of the selected items of the active plugins. eff: selection.effective(catalog, user, project).
function selectionCost(catalog, eff) {
  const children = [];
  for (const plugin of catalog.plugins) {
    const e = eff.get(plugin.name);
    if (!e || !e.active) {
      continue;
    }
    children.push(...plugin.children.filter((c) => e.included.has(c.id)));
  }
  return costOf(children);
}

// The lines the status bar tooltip adds for the selection ([] when nothing counts).
function statusLines(cost) {
  return cost.always.count + cost.descriptions.count + cost.globbed.count > 0 ? costLines(cost, 'In every chat') : [];
}

// What the view's title shows next to it ('' when nothing counts).
function viewDescription(cost) {
  return cost.total > 0 ? `~${formatTokens(cost.total)} tokens per chat` : '';
}

// The tooltip line of one item ('' when it has no `context`: commands, agents, MCP servers).
function itemLine(child) {
  const x = child.context;
  if (!x) {
    return '';
  }
  const t = formatTokens(tokens(x.chars));
  if (child.kind === 'rule') {
    switch (x.apply) {
      case 'always':
        return `Applies always: the whole rule is in every chat (~${t} tokens)`;
      case 'globs':
        return `Applies to files matching ${x.globs.join(', ')} (~${t} tokens when it does)`;
      case 'agent':
        return `Applies when the agent asks for it: its description is in every chat (~${t} tokens)`;
      case 'manual':
        return `Applies only when you mention it (@${child.name})`;
      default:
        return '';
    }
  }
  if (child.kind === 'skill') {
    switch (x.apply) {
      case 'always':
        return `Applies always (alwaysApply): the whole skill is in every chat (~${t} tokens)`;
      case 'description':
        return `In every chat: its description (~${t} tokens)`;
      case 'hidden':
        return `Not offered to the agent (disable-model-invocation): only by /${child.name}`;
      default:
        return '';
    }
  }
  return '';
}

module.exports = {
  itemContext,
  splitGlobs,
  formatTokens,
  costOf,
  costLines,
  selectionCost,
  statusLines,
  viewDescription,
  itemLine,
};
