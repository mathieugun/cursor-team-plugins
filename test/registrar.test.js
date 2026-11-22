'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pluginApi } = require('../lib/cursorApi');
const { Registrar } = require('../lib/registrar');

test('pluginApi addPlugin / removePlugin', async () => {
  const calls = [];
  const api = pluginApi({
    plugins: {
      addPlugin: async (a) => calls.push(['addPlugin', a]),
      removePlugin: async (a) => calls.push(['removePlugin', a]),
    },
  });
  assert.equal(api.name, 'addPlugin');
  await api.add('/p');
  await api.remove('/p');
  assert.deepEqual(calls, [['addPlugin', { path: '/p' }], ['removePlugin', { path: '/p' }]]);
});

test('pluginApi registerPath fallback', async () => {
  const calls = [];
  const api = pluginApi({
    plugins: { registerPath: (p) => calls.push(['reg', p]), unregisterPath: (p) => calls.push(['unreg', p]) },
  });
  assert.equal(api.name, 'registerPath');
  await api.add('/p');
  await api.remove('/p');
  assert.deepEqual(calls, [['reg', '/p'], ['unreg', '/p']]);
});

test('pluginApi without functions', () => {
  assert.equal(pluginApi({ plugins: {} }), null);
  assert.equal(pluginApi(undefined), null);
});

test('pluginApi: a synchronous throw becomes a rejection', async () => {
  const api = pluginApi({
    plugins: {
      addPlugin: () => {
        throw new Error('boom');
      },
      removePlugin: () => {},
    },
  });
  await assert.rejects(() => api.add('/p'), /boom/);
});

function fakeApi(calls, failFor = []) {
  return {
    add: async (p) => {
      calls.push(`add ${p}`);
      if (failFor.includes(p)) {
        throw new Error(`cannot add ${p}`);
      }
    },
    remove: async (p) => {
      calls.push(`remove ${p}`);
    },
  };
}

test('Registrar apply diffs against what is registered', async () => {
  const calls = [];
  const reg = new Registrar(fakeApi(calls));
  let r = await reg.apply(new Map([['a', '/p/a'], ['b', '/p/b']]));
  assert.deepEqual(calls, ['add /p/a', 'add /p/b']);
  assert.deepEqual(r.added, ['/p/a', '/p/b']);

  calls.length = 0;
  r = await reg.apply(new Map([['a', '/p/a2']]));
  assert.deepEqual(calls, ['remove /p/a', 'remove /p/b', 'add /p/a2']);

  calls.length = 0;
  r = await reg.apply(new Map([['a', '/p/a2']]));
  assert.deepEqual(calls, []);
  assert.deepEqual(r, { added: [], removed: [], errors: [] });
});

test('Registrar keeps going after a failed add; removeAll clears', async () => {
  const calls = [];
  const reg = new Registrar(fakeApi(calls, ['/p/c']));
  const r = await reg.apply(new Map([['c', '/p/c'], ['d', '/p/d']]));
  assert.deepEqual(r.errors, [{ path: '/p/c', message: 'cannot add /p/c' }]);
  assert.ok(!reg.current.has('c'));
  assert.equal(reg.current.get('d'), '/p/d');
  calls.length = 0;
  await reg.removeAll();
  assert.deepEqual(calls, ['remove /p/d']);
  assert.equal(reg.current.size, 0);
});
