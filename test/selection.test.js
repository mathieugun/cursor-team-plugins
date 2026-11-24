'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { effective, toggle, addToProject, removeFromProject, desiredRegistrations } = require('../lib/selection');

const child = (id, kind) => ({ id, kind, name: id.split('/').pop(), file: `/x/${id}`, description: '' });
const catalog = {
  plugins: [
    {
      name: 'P1',
      displayName: 'P1',
      version: '',
      description: '',
      dir: '/repo/P1',
      children: [child('P1/skills/s1', 'skill'), child('P1/skills/s2', 'skill'), child('P1/rules/r1.mdc', 'rule')],
    },
    { name: 'P2', displayName: 'P2', version: '', description: '', dir: '/repo/P2', children: [child('P2/skills/s3', 'skill')] },
    { name: 'P3', displayName: 'P3', version: '', description: '', dir: '/repo/P3', children: [] },
  ],
  warnings: [],
};
const S1 = 'P1/skills/s1';
const S2 = 'P1/skills/s2';
const R1 = 'P1/rules/r1.mdc';
const sorted = (set) => [...set].sort();

test('effective a: whole plugin', () => {
  const eff = effective(catalog, { enabled: ['P1'], excluded: [] }, []);
  assert.equal(eff.get('P1').active, true);
  assert.equal(eff.get('P1').full, true);
  assert.deepEqual(sorted(eff.get('P1').included), [R1, S1, S2].sort());
  assert.equal(eff.get('P2').active, false);
  assert.equal(eff.get('P3').active, false);
});

test('effective b: exclusion', () => {
  const eff = effective(catalog, { enabled: ['P1'], excluded: [S1] }, []);
  assert.equal(eff.get('P1').active, true);
  assert.equal(eff.get('P1').full, false);
  assert.deepEqual(sorted(eff.get('P1').included), [R1, S2]);
});

test('effective c: single skill', () => {
  const eff = effective(catalog, { enabled: [S1], excluded: [] }, []);
  assert.equal(eff.get('P1').active, true);
  assert.equal(eff.get('P1').full, false);
  assert.deepEqual(sorted(eff.get('P1').included), [S1]);
});

test('effective d: project plugin', () => {
  const eff = effective(catalog, { enabled: [], excluded: [] }, ['P2']);
  assert.equal(eff.get('P2').full, true);
  assert.deepEqual(sorted(eff.get('P2').fromProject), ['P2/skills/s3']);
});

test('effective e: project overrides exclusion', () => {
  const eff = effective(catalog, { enabled: ['P1'], excluded: [S1] }, [S1]);
  assert.equal(eff.get('P1').full, true);
  assert.deepEqual(sorted(eff.get('P1').fromProject), [S1]);
});

test('effective f: leaf plugin', () => {
  const a = effective(catalog, { enabled: ['P3'], excluded: [] }, []);
  assert.equal(a.get('P3').active, true);
  assert.equal(a.get('P3').full, true);
  const b = effective(catalog, { enabled: [], excluded: [] }, ['P3']);
  assert.equal(b.get('P3').active, true);
  assert.deepEqual(sorted(b.get('P3').fromProject), ['P3']);
});

test('effective g: unknown ids are ignored', () => {
  const eff = effective(catalog, { enabled: ['ghost', 'P1/skills/ghost'], excluded: [] }, []);
  for (const e of eff.values()) {
    assert.equal(e.active, false);
  }
});

test('effective h: everything excluded is inactive', () => {
  const eff = effective(catalog, { enabled: ['P1'], excluded: [S1, S2, R1] }, []);
  assert.equal(eff.get('P1').active, false);
});

test('toggle', () => {
  const t = (enabled, excluded, id, checked) => toggle(catalog, { enabled, excluded }, id, checked);
  assert.deepEqual(t([], [], 'P1', true), { enabled: ['P1'], excluded: [] });
  assert.deepEqual(t([S1], [R1], 'P1', true), { enabled: ['P1'], excluded: [] });
  assert.deepEqual(t(['P1', 'P2'], [S1], 'P1', false), { enabled: ['P2'], excluded: [] });
  assert.deepEqual(t(['P1'], [], S1, false), { enabled: ['P1'], excluded: [S1] });
  assert.deepEqual(t(['P1'], [S1, S2], R1, false), { enabled: [], excluded: [] });
  assert.deepEqual(t(['P1'], [S1], S1, true), { enabled: ['P1'], excluded: [] });
  let u = t([], [], S1, true);
  assert.deepEqual(u, { enabled: [S1], excluded: [] });
  u = toggle(catalog, u, S2, true);
  u = toggle(catalog, u, R1, true);
  assert.deepEqual(u, { enabled: ['P1'], excluded: [] });
  assert.deepEqual(t([S1], [], S1, false), { enabled: [], excluded: [] });
  u = t([], [], 'P3', true);
  assert.deepEqual(u, { enabled: ['P3'], excluded: [] });
  assert.deepEqual(toggle(catalog, u, 'P3', false), { enabled: [], excluded: [] });
  assert.deepEqual(t(['ghost'], [], 'P2', true), { enabled: ['P2', 'ghost'], excluded: [] });
});

test('project lists', () => {
  assert.deepEqual(addToProject(catalog, [S1, 'P2'], 'P1'), ['P1', 'P2']);
  assert.deepEqual(addToProject(catalog, ['P1'], S1), ['P1']);
  assert.deepEqual(removeFromProject(catalog, ['P1'], S1), [R1, S2]);
  assert.deepEqual(removeFromProject(catalog, ['P1', S1, 'P2'], 'P1'), ['P2']);
  assert.deepEqual(addToProject(catalog, [S1, S2], R1), ['P1']);
});

test('desiredRegistrations', () => {
  const user = { enabled: ['P1', 'P2'], excluded: [S1] };
  const eff = effective(catalog, user, []);
  const desired = desiredRegistrations(catalog, eff, (p, ids) => `/f/${p.name}:${ids.join(',')}`);
  assert.deepEqual([...desired], [
    ['P1', '/f/P1:P1/rules/r1.mdc,P1/skills/s2'],
    ['P2', '/repo/P2'],
  ]);
});

test('desiredRegistrations registers a renamed plugin from a copy even when it is full', () => {
  const renamed = { plugins: [{ ...catalog.plugins[1], folder: 'review-two' }, catalog.plugins[2]], warnings: [] };
  const eff = effective(renamed, { enabled: ['P2', 'P3'], excluded: [] }, []);
  const desired = desiredRegistrations(renamed, eff, (p, ids) => `/f/${p.folder || p.name}:${ids.join(',')}`);
  assert.deepEqual([...desired], [
    ['P2', '/f/review-two:P2/skills/s3'],
    ['P3', '/repo/P3'],
  ]);
  const same = { plugins: [catalog.plugins[1]], warnings: [] };
  const sameDesired = desiredRegistrations(same, effective(same, { enabled: ['P2'], excluded: [] }, []), () => 'copy');
  assert.deepEqual([...sameDesired], [['P2', '/repo/P2']]);
});
