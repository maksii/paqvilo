import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAdminRouter } from '../lib/runtime-admin.mjs';

test('the status route encodes chunks from the resolved value of an asynchronous status provider', async () => {
  const encoded = [];
  let answered;
  const router = createRuntimeAdminRouter({
    store: {},
    json: (_res, status, value, _headers, options) => {
      answered = { status, value, chunks: options?.chunks };
    },
    jsonObjectBody: async () => ({}),
    change: (fn) => fn(),
    csrf: () => 'invented-token',
    status: async () => ({ ready: true, site: 'Invented' }),
    statusChunks: (value) => {
      encoded.push(value);
      return [JSON.stringify(value)];
    },
  });
  const served = await router({ method: 'GET', headers: {} }, {}, new URL('http://127.0.0.1/_sim/api/status'));
  assert.equal(served, true);
  assert.deepEqual(encoded, [{ ready: true, site: 'Invented' }]);
  assert.deepEqual(answered, {
    status: 200,
    value: { ready: true, site: 'Invented' },
    chunks: ['{"ready":true,"site":"Invented"}'],
  });
});
