// @test-kind contract: supplied stores retain state getter and nullish setter evaluation order during admin and solution writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataverseAdmin } from '../lib/dataverse-admin.mjs';
import { installSolutionMessages } from '../lib/dataverse-solution-messages.mjs';

const guid = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

test('managed identity write reads state once and preserves conditional setter and receiver', async () => {
  for (const mode of ['null', 'present', 'transform']) {
    const initial = mode === 'present' ? [] : null;
    const events = [],
      sentinel = new Error('extra state read');
    let active = false,
      reads = 0,
      value = initial,
      assigned;
    const array = initial ?? [];
    Object.defineProperty(array, 'push', {
      value(...args) {
        events.push('push');
        active = false;
        return Array.prototype.push.apply(this, args);
      },
    });
    const dataverse = { tenantId: guid };
    Object.defineProperty(dataverse, 'managedIdentities', {
      get() {
        if (active) events.push('get');
        return value;
      },
      set(v) {
        if (active) events.push('set');
        assigned = v;
        value = mode === 'transform' ? [] : v;
        if (active) Object.defineProperty(v, 'push', { value: array.push });
      },
    });
    const state = { dataverse, mappings: {}, tables: {} };
    let transactions = 0;
    const store = {
      get state() {
        if (active) {
          events.push('state');
          if (++reads > 1) throw sentinel;
        }
        return state;
      },
      tableRows: () => [],
      transact(fn) {
        if (++transactions === 1) return guid;
        active = true;
        return fn();
      },
    };
    let response,
      identityReads = 0;
    const admin = createDataverseAdmin({
      store,
      getDataverse: () => ({ organizationId: guid, tenantId: other }),
      dataverseConfig: {},
      managedIdentityList: () => (++identityReads === 1 ? [] : [{ clientId: guid, displayName: 'Invented' }]),
      json: (_res, status, body) => {
        response = { status, body };
      },
      jsonObjectBody: async () => ({ clientId: guid, principalId: other, displayName: 'Invented', roles: [] }),
      change: (fn) => fn(),
    });
    await admin({ method: 'POST' }, {}, '/dataverse/managed-identities');
    assert.equal(response.status, 201);
    assert.deepEqual(events, ['state', 'get', ...(initial === null ? ['set'] : []), 'push']);
    assert.equal((initial ?? assigned).length, 1);
    if (mode === 'transform') assert.equal(value.length, 0);
    assert.equal(state.tables.managedidentity[0].tenantid, other);
  }
});

test('solution export transaction preserves state and nullish assignment reads', async () => {
  for (const mode of ['missing', 'present', 'transform']) {
    const hasJobs = mode === 'present';
    const events = [],
      sentinel = new Error('extra state read');
    let active = false,
      reads = 0;
    let jobs = hasJobs ? {} : undefined,
      assigned;
    const dataverse = {};
    Object.defineProperty(dataverse, 'exportJobs', {
      get() {
        if (active) events.push('get-jobs');
        return jobs;
      },
      set(v) {
        if (active) events.push('set-jobs');
        assigned = v;
        jobs = mode === 'transform' ? {} : v;
      },
    });
    const state = { tables: { solution: [{ uniquename: 'invented', solutionid: guid, parentsolutionid: null }] } };
    Object.defineProperty(state, 'dataverse', {
      get() {
        if (active) events.push('get-dv');
        return dataverse;
      },
    });
    const store = {
      get state() {
        if (active) {
          events.push('state');
          if (++reads > 1) throw sentinel;
        }
        return state;
      },
      transact(fn) {
        active = true;
        try {
          return fn();
        } finally {
          active = false;
        }
      },
    };
    const operations = new Map();
    const api = {
      store,
      registry: {
        register(op) {
          operations.set(op.name, op);
        },
      },
      principals: { privileges: () => new Set(['prvExportCustomization']) },
      change: (fn) => fn(),
      systemJob: async (_info, work) => {
        await work();
        return guid;
      },
    };
    installSolutionMessages(api, { exportArchive: () => Buffer.from('invented') });
    const response = await operations.get('ExportSolutionAsync').handle({
      body: { SolutionName: 'invented' },
      caller: { systemuserid: guid },
      origin: 'http://127.0.0.1',
      version: '9.2',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(events, ['state', 'get-dv', 'get-jobs', ...(hasJobs ? [] : ['set-jobs'])]);
    assert.equal(Object.keys(hasJobs ? jobs : assigned).length, 1);
    if (mode === 'transform') assert.equal(Object.keys(jobs).length, 0);
  }
});
