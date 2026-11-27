'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  itemContext,
  splitGlobs,
  formatTokens,
  costOf,
  costLines,
  selectionCost,
  statusLines,
  viewDescription,
  itemLine,
} = require('../lib/context');
const { frontmatterField: fm } = require('../lib/catalog');
const { effective } = require('../lib/selection');

const ctx = (kind, text) => itemContext(kind, text, fm);
const rule = (text) => ctx('rule', text);
const skill = (text) => ctx('skill', text);

test('rules: always applied', () => {
  assert.deepEqual(rule('---\nalwaysApply: true\n---\nHello world\n'), { apply: 'always', chars: 11 });
  assert.deepEqual(rule('---\nalwaysApply: True\n---\nHello world\n'), { apply: 'always', chars: 11 });
  assert.deepEqual(rule('---\nalwaysApply: TRUE\n---\nHello world\n'), { apply: 'always', chars: 11 });
  assert.deepEqual(rule('---\nalwaysApply: true # on\n---\nHello world\n'), { apply: 'always', chars: 11 });
  for (const v of ['yes', '"true"', 'false']) {
    assert.deepEqual(rule(`---\nalwaysApply: ${v}\ndescription: d\n---\nHello world\n`), { apply: 'agent', chars: 1 }, v);
  }
  // always wins over globs and description
  assert.deepEqual(rule('---\ndescription: d\nglobs: "*.ts"\nalwaysApply: true\n---\nabcd\n'), { apply: 'always', chars: 4 });
});

test('rules: globs in every form Cursor reads', () => {
  assert.deepEqual(rule('---\nglobs: src/**/*.ts, *.tsx\n---\nabcdefgh\n'), {
    apply: 'globs',
    chars: 8,
    globs: ['src/**/*.ts', '*.tsx'],
  });
  assert.deepEqual(rule('---\nglobs: "*.ts"\n---\nx\n').globs, ['*.ts']);
  assert.deepEqual(rule('---\nglobs: ["*.ts", \'*.tsx\']\n---\nx\n').globs, ['*.ts', '*.tsx']);
  assert.deepEqual(rule('---\nglobs:\n  - "*.ts"\n  - src/** # c\n---\nx\n').globs, ['*.ts', 'src/**']);
  // a quoted item followed by a comment, and a quoted item holding " #"
  assert.deepEqual(rule('---\nglobs:\n  - "*.ts" # c\n  - "a #b"\n---\nx\n').globs, ['*.ts', 'a #b']);
  assert.deepEqual(rule('---\nglobs: "{a,b}/*.ts, c"\n---\nx\n').globs, ['{a,b}/*.ts', 'c']);
});

test('rules: description, manual and what is dropped', () => {
  assert.deepEqual(rule('---\nglobs:\ndescription: Use it\n---\nb\n'), { apply: 'agent', chars: 6 });
  assert.deepEqual(rule('---\nglobs: ""\n---\nb\n'), { apply: 'manual', chars: 0 });
  assert.deepEqual(rule(`---\ndescription: ${'x'.repeat(2000)}\n---\nb\n`), { apply: 'agent', chars: 1536 });
  assert.deepEqual(rule('Just text\n'), { apply: 'manual', chars: 0 });
  assert.deepEqual(rule('---\r\nalwaysApply: true\r\n---\r\nab\r\ncd\r\n'), { apply: 'always', chars: 5 });
  assert.equal(rule('---\ndescription: Use when: x\n---\nb\n'), null);
  assert.equal(rule('---\nalwaysApply: true\n'), null);
  assert.equal(ctx('command', '---\nalwaysApply: true\n---\nb\n'), null);
  assert.equal(ctx('agent', '---\nalwaysApply: true\n---\nb\n'), null);
});

test('skills', () => {
  assert.deepEqual(skill('---\nname: s\ndescription: Review code.\n---\n# S\n'), { apply: 'description', chars: 12 });
  assert.deepEqual(skill('---\nname: s\nalwaysApply: true\n---\nabcdefgh\n'), { apply: 'always', chars: 8 });
  assert.deepEqual(skill('---\nname: s\ndescription: d\ndisable-model-invocation: true\n---\nb\n'), { apply: 'hidden', chars: 0 });
  assert.deepEqual(
    skill('---\nname: s\ndescription: d\ndisable-model-invocation: true\nalwaysApply: true\n---\nabcd\n'),
    { apply: 'always', chars: 4 },
  );
  assert.deepEqual(skill('---\nname: s\n---\nb\n'), { apply: 'description', chars: 0 });
  assert.deepEqual(skill('---\nname: s\nglobs: "*.ts"\ndescription: d\n---\nb\n'), { apply: 'description', chars: 1 });
});

test('splitGlobs', () => {
  assert.deepEqual(splitGlobs('a, b'), ['a', 'b']);
  assert.deepEqual(splitGlobs(' , a ,'), ['a']);
  assert.deepEqual(splitGlobs('{a,b},c'), ['{a,b}', 'c']);
  assert.deepEqual(splitGlobs('{a,b'), ['{a', 'b']);
  assert.deepEqual(splitGlobs(''), []);
  assert.deepEqual(splitGlobs(null), []);
});

test('formatTokens', () => {
  const cases = [
    [0, '0'],
    [7, '7'],
    [99, '99'],
    [123, '120'],
    [995, '1k'],
    [1234, '1.2k'],
    [1960, '2k'],
    [9949, '9.9k'],
    [9950, '10k'],
    [12345, '12k'],
  ];
  for (const [n, s] of cases) {
    assert.equal(formatTokens(n), s, String(n));
  }
});

const child = (kind, name, apply, chars, extra) => ({
  id: `p/${kind}s/${name}`,
  kind,
  name,
  context: { apply, chars, ...extra },
});
const alwaysRule = child('rule', 'style', 'always', 42);
const skillA = child('skill', 'a', 'description', 60);
const skillB = child('skill', 'b', 'description', 59);
const globRule = child('rule', 'ts', 'globs', 39, { globs: ['*.ts'] });

test('costOf and costLines', () => {
  const c = costOf([alwaysRule, skillA, skillB]);
  assert.equal(c.known, true);
  assert.equal(c.total, 41);
  assert.deepEqual(costLines(c, 'In every chat'), ['In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)']);
  assert.deepEqual(costLines(costOf([alwaysRule, skillA, skillB, globRule]), 'In every chat'), [
    'In every chat: ~41 tokens (1 always-applied rule ~11, 2 descriptions ~30)',
    'For matching files: 1 rule (~10 tokens when it applies)',
  ]);
  assert.deepEqual(costLines(costOf([globRule, child('rule', 'js', 'globs', 39, { globs: ['*.js'] })]), 'In every chat'), [
    'In every chat: nothing',
    'For matching files: 2 rules (~20 tokens when they apply)',
  ]);
  assert.deepEqual(costLines(costOf([child('skill', 'x', 'always', 8), alwaysRule]), 'In every chat'), [
    'In every chat: ~13 tokens (2 always-applied items ~13)',
  ]);
  assert.deepEqual(costLines(costOf([child('rule', 'm', 'manual', 0), child('skill', 'h', 'hidden', 0)]), 'In every chat'), [
    'In every chat: nothing',
  ]);
  assert.deepEqual(costLines(costOf([{ id: 'p/commands/c.md', kind: 'command', name: 'c' }]), 'In every chat'), []);
  assert.deepEqual(costLines(costOf([skillA]), 'If enabled, in every chat'), ['If enabled, in every chat: ~15 tokens (1 description ~15)']);
  // rounded once per bucket
  const small = costOf([child('skill', 'x', 'description', 1), child('skill', 'y', 'description', 1), child('skill', 'z', 'description', 1)]);
  assert.equal(small.descriptions.tokens, 1);
  assert.equal(small.total, 1);
});

test('itemLine', () => {
  assert.equal(itemLine(alwaysRule), 'Applies always: the whole rule is in every chat (~11 tokens)');
  assert.equal(
    itemLine(child('rule', 'ts', 'globs', 39, { globs: ['src/**/*.ts', '*.tsx'] })),
    'Applies to files matching src/**/*.ts, *.tsx (~10 tokens when it does)',
  );
  assert.equal(
    itemLine(child('rule', 'r', 'agent', 34)),
    'Applies when the agent asks for it: its description is in every chat (~9 tokens)',
  );
  assert.equal(itemLine(child('rule', 'style', 'manual', 0)), 'Applies only when you mention it (@style)');
  assert.equal(
    itemLine(child('skill', 's', 'always', 8)),
    'Applies always (alwaysApply): the whole skill is in every chat (~2 tokens)',
  );
  assert.equal(itemLine(skillA), 'In every chat: its description (~15 tokens)');
  assert.equal(
    itemLine(child('skill', 'deploy', 'hidden', 0)),
    'Not offered to the agent (disable-model-invocation): only by /deploy',
  );
  assert.equal(itemLine({ id: 'p/commands/c.md', kind: 'command', name: 'c' }), '');
});

test('selectionCost, statusLines and viewDescription', () => {
  const catalog = {
    plugins: [
      {
        name: 'p',
        children: [alwaysRule, skillA, { id: 'p/commands/c.md', kind: 'command', name: 'c' }],
      },
      { name: 'q', children: [{ ...child('skill', 'w', 'description', 47), id: 'q/skills/w' }] },
    ],
    warnings: [],
  };
  const cost = selectionCost(catalog, effective(catalog, { enabled: ['p'] }, []));
  assert.equal(cost.total, 26);
  assert.equal(viewDescription(cost), '~26 tokens per chat');
  assert.deepEqual(statusLines(cost), ['In every chat: ~26 tokens (1 always-applied rule ~11, 1 description ~15)']);

  const none = selectionCost(catalog, effective(catalog, { enabled: [] }, []));
  assert.equal(viewDescription(none), '');
  assert.deepEqual(statusLines(none), []);

  const only = selectionCost(catalog, effective(catalog, { enabled: ['q/skills/w'] }, []));
  assert.equal(viewDescription(only), '~12 tokens per chat');
});
