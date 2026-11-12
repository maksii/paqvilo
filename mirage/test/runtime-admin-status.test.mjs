// @test-kind contract: Paqvilo's own runtime administration router, its status answer and the order of its token gate
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntimeAdminRouter } from '../lib/runtime-admin.mjs';
import { createStaffSessionHandler } from '../lib/staff-session.mjs';
import { DataStore } from '../lib/data.mjs';

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

// @test-kind security: the staff-session route checks its own CSRF token, so the router lets it answer before the admin token gate
test('the staff-session route answers a write with its own token, and the admin token gate still rejects other writes', async () => {
  const answered = [];
  const json = (_res, status, value) => answered.push({ status, value });
  const router = createRuntimeAdminRouter({
    store: {},
    json,
    jsonObjectBody: async () => ({}),
    change: (fn) => fn(),
    csrf: () => 'admin-x',
    status: async () => ({ ready: true }),
    statusChunks: (value) => [JSON.stringify(value)],
    staffSession: async (req, res, url) => {
      if (url.pathname !== '/_sim/api/dataverse/session') return false;
      const allowed = req.headers['x-sim-csrf'] === 'apps-y';
      json(res, allowed ? 200 : 403, { allowed });
      return true;
    },
  });
  const served = await router(
    { method: 'POST', headers: { 'x-sim-csrf': 'apps-y' } },
    {},
    new URL('http://127.0.0.1/_sim/api/dataverse/session'),
  );
  assert.equal(served, true);
  assert.deepEqual(answered, [{ status: 200, value: { allowed: true } }]);
  await assert.rejects(
    router({ method: 'POST', headers: { 'x-sim-csrf': 'apps-y' } }, {}, new URL('http://127.0.0.1/_sim/api/config')),
    { status: 403 },
  );
  assert.equal(answered.length, 1);
});

// @test-kind security: the staff-session route checks its CSRF token before its method, so a caller without the token learns nothing about the allowed methods
test('the staff-session route refuses a PUT or PATCH without its token as the token error, and answers 405 only with it', async () => {
  const answered = [];
  const json = (_res, status, value) => answered.push({ status, value });
  const router = createRuntimeAdminRouter({
    store: {},
    json,
    jsonObjectBody: async () => ({}),
    change: (fn) => fn(),
    csrf: () => 'admin-x',
    staffSession: createStaffSessionHandler({ sessions: {}, csrf: () => 'apps-y', json, readBody: async () => ({}) }),
  });
  const url = new URL('http://127.0.0.1/_sim/api/dataverse/session');
  for (const method of ['PUT', 'PATCH']) {
    await assert.rejects(router({ method, headers: {} }, {}, url), {
      status: 403,
      code: 'INVALID_REQUEST',
      message: 'Missing simulator CSRF token.',
    });
    assert.equal(await router({ method, headers: { 'x-sim-csrf': 'apps-y' } }, {}, url), true);
  }
  assert.deepEqual(answered, [
    { status: 405, value: { error: { message: 'Method not allowed.', code: 'MethodNotAllowed' } } },
    { status: 405, value: { error: { message: 'Method not allowed.', code: 'MethodNotAllowed' } } },
  ]);
});

test('the records route answers UnknownEntity for names inherited from Object.prototype', async () => {
  const store = new DataStore({ state: { mappings: { item: { idColumn: 'itemid' } }, tables: { item: [] } } });
  const answered = [];
  const router = createRuntimeAdminRouter({
    store,
    json: (_res, status, value) => answered.push({ status, value }),
    jsonObjectBody: async () => ({}),
    change: (fn) => fn(),
    csrf: () => 'admin-x',
  });
  await assert.rejects(
    router({ method: 'GET', headers: {} }, {}, new URL('http://127.0.0.1/_sim/api/records/toString/x')),
    { status: 404, code: 'UnknownEntity' },
  );
  await assert.rejects(
    router(
      { method: 'POST', headers: { 'x-sim-csrf': 'admin-x' } },
      {},
      new URL('http://127.0.0.1/_sim/api/records/hasOwnProperty'),
    ),
    { status: 404, code: 'UnknownEntity' },
  );
  assert.deepEqual(answered, []);
});

// @test-kind security: the administration gate refuses any token that is not exact
test('the administration token gate accepts the exact token and refuses every variant as a wrong token', async () => {
  const router = createRuntimeAdminRouter({
    store: {},
    json: () => {},
    jsonObjectBody: async () => ({}),
    change: (fn) => fn(),
    csrf: () => 'admin-x',
    status: async () => ({ ready: true }),
    statusChunks: (value) => [JSON.stringify(value)],
  });
  const outcome = async (token) => {
    try {
      await router(
        { method: 'POST', headers: { 'x-sim-csrf': token } },
        {},
        new URL('http://127.0.0.1/_sim/api/config'),
      );
      return 'served';
    } catch (error) {
      return error.status;
    }
  };
  assert.notEqual(await outcome('admin-x'), 403);
  for (const token of ['admin-xy', 'admin-', 'admin-z', '', ['admin-x']])
    assert.equal(await outcome(token), 403, String(token));
});
