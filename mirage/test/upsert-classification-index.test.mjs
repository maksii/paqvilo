// @test-kind contract: UpsertMultiple preserves Paqvilo handler results and observable store/target hooks when choosing its lookup strategy.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createPrincipals, ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { organizationPrincipalContext } from '../lib/dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { seed as seedStandardTables } from '../lib/dataverse-standard.mjs';

// Exact DataStore prototype admits the optimization; a subclass is the unchanged linear reference.
class LinearStore extends DataStore {}
const fixtures = new Set();
afterEach(() => {
  for (const f of fixtures) f.close();
  fixtures.clear();
});
const ORIGIN = 'http://127.0.0.1:5555';
const OID = '77777777-7777-4777-8777-777777777701';
const SETTINGS = {
  organizationId: '77777777-7777-4777-8777-777777777700',
  tenantId: 'tenant-test',
  uniqueName: 'inventedtest',
  friendlyName: 'Invented Test',
  version: '9.2.25041.00000',
  users: [{ objectId: OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};
const gid = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const requestTargets = (count = 64) =>
  Array.from({ length: count }, (_, i) => ({
    '@odata.id': `x_items(x_code='K${i}')`,
    x_name: `changed-${i}`,
  }));
async function fixture(klass, collation = 'CI_AI', count = 64) {
  const state = emptyState();
  state.settings.collation = collation;
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    alternateKeys: [{ name: 'x_item_code', attributes: ['x_code'] }],
    fields: { x_code: { dataverseType: 'nvarchar' }, x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = Array.from({ length: count }, (_, i) => ({
    x_itemid: gid(i + 1),
    x_code: `K${i}`,
    x_name: `old-${i}`,
  }));
  let nextId = Math.max(1000, count);
  const store = new klass({
    state,
    clock: { now: () => Date.parse('2026-01-01T00:00:00.000Z') },
    ids: { uuid: () => gid(++nextId) },
  });
  await store.transact(() => seedStandardTables(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const user = principals.byObjectId(OID),
    context = organizationPrincipalContext(store, user);
  const hooks = createRecordHooks();
  const handlers = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    hooks,
    metadataFields: () => undefined,
    changes: createChangeLog(store),
  });
  async function send(targets) {
    const url = new URL('/api/data/v9.2/x_items/Microsoft.Dynamics.CRM.UpsertMultiple', ORIGIN);
    return handlers.handle({
      method: 'POST',
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: 'v9.2',
      prefer: parsePrefer(),
      headers: {},
      body: { Targets: targets },
      user,
      caller: user,
      identity: context.identity,
      requestId: 'invented',
    });
  }
  const f = { store, send, hooks, close: () => handlers.close() };
  fixtures.add(f);
  return f;
}
const summary = (f) =>
  f.store.state.tables.x_item.map((row) => ({ id: row.x_itemid, code: row.x_code, name: row.x_name }));
async function outcome(f, targets) {
  let result;
  try {
    result = await f.send(targets);
  } catch (error) {
    return { error };
  }
  // Assertion/inspection failures must not be mistaken for a handler rejection.
  return { status: result.status, body: result.body ?? null, rows: summary(f) };
}
async function compare(configure, { collation = 'CI_AI', targets = requestTargets, count = 64 } = {}) {
  const a = await fixture(DataStore, collation, count),
    b = await fixture(LinearStore, collation, count);
  const traceA = [],
    traceB = [],
    sentinel = new Error('intentional hook error');
  const inputA = targets(),
    inputB = targets();
  configure?.(a, inputA, traceA, sentinel);
  configure?.(b, inputB, traceB, sentinel);
  const first = await outcome(a, inputA),
    second = await outcome(b, inputB);
  assert.deepEqual(first, second);
  assert.deepEqual(traceA, traceB);
  return { a, b, first, traceA, sentinel };
}
function success(result) {
  assert.equal(result.first.error, undefined);
  assert.equal(result.first.status, 204);
}
function dataError(result, { code, message, details }) {
  const error = result.first.error;
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'DataError');
  assert.equal(error.status, 400);
  assert.equal(error.statusCode, 400);
  assert.equal(error.code, code);
  assert.equal(error.message, message);
  assert.deepEqual(error.details, details);
}

for (const collation of ['CI_AI', 'CI_AS']) {
  test(`ordinary existing and new keys retain final records (${collation})`, async () => {
    const result = await compare(null, {
      collation,
      targets: () => {
        const ts = requestTargets();
        for (let i = 48; i < ts.length; i++)
          ts[i] = { '@odata.id': `x_items(x_code='NEW${i}')`, x_code: `NEW${i}`, x_name: `new-${i}` };
        return ts;
      },
    });
    success(result);
    assert.equal(result.first.rows.length, 80);
    for (let i = 0; i < 64; i++) {
      assert.deepEqual(result.first.rows[i], {
        id: gid(i + 1),
        code: `K${i}`,
        name: i < 48 ? `changed-${i}` : `old-${i}`,
      });
    }
    assert.deepEqual(
      result.first.rows.slice(64).map(({ code, name }) => ({ code, name })),
      Array.from({ length: 16 }, (_, i) => ({ code: `NEW${i + 48}`, name: `new-${i + 48}` })),
    );
  });
}

test('duplicate targets retain the same early error', async () => {
  const result = await compare(null, {
    targets: () => {
      const ts = requestTargets();
      ts[1]['@odata.id'] = ts[0]['@odata.id'];
      return ts;
    },
  });
  dataError(result, {
    code: 'InvalidRequest',
    message: 'Duplicate key in Targets.',
    details: { innerCode: '0x80040203' },
  });
  assert.ok(
    summary(result.a).every((row, i) => row.name === `old-${i}`),
    'classification error writes no targets',
  );
});

test('getter during target spread can mutate the later lookup row without changing observations', async () => {
  const result = await compare((f, targets, trace) => {
    targets[1].x_code = 'K1';
    Object.defineProperty(targets[0], 'x_name', {
      enumerable: true,
      get() {
        trace.push('target spread');
        f.store.state.tables.x_item[1].x_code = 'CHANGED';
        return 'changed-0';
      },
    });
  });
  success(result);
  // Original code reads it in classification spread and in the UpsertMultiple SDK input projection.
  assert.deepEqual(result.traceA, ['target spread', 'target spread']);
  assert.equal(result.first.rows.length, 65);
  assert.deepEqual(result.first.rows[1], { id: gid(2), code: 'CHANGED', name: 'old-1' });
  assert.equal(result.first.rows.find((row) => row.code === 'K1')?.name, 'changed-1');
});

test('a stored key getter retains its calls and thrown sentinel identity', async () => {
  const result = await compare((f, _targets, trace, sentinel) => {
    Object.defineProperty(f.store.state.tables.x_item[0], 'x_code', {
      configurable: true,
      enumerable: true,
      get() {
        trace.push('row-key');
        throw sentinel;
      },
    });
  });
  assert.strictEqual(result.first.error, result.sentinel);
  assert.deepEqual(result.traceA, ['row-key']);
});

for (const name of ['findByKey', 'querySettings', 'fieldDefinition', 'resolveMapping']) {
  test(`overridden ${name} retains call order and mutation visibility`, async () => {
    const result = await compare((f, targets, trace) => {
      targets[1].x_code = 'K1';
      const original = f.store[name];
      let count = 0;
      f.store[name] = function (...args) {
        trace.push(name);
        if (++count === 2) this.state.tables.x_item[1].x_code = 'MUTATED';
        return original.apply(this, args);
      };
    });
    success(result);
    assert.equal(result.first.rows.length, 65);
    assert.deepEqual(result.first.rows[1], { id: gid(2), code: 'MUTATED', name: 'old-1' });
    assert.equal(result.first.rows.find((row) => row.code === 'K1')?.name, 'changed-1');
    assert.ok(result.traceA.length > 1);
  });
}

test('a proxied target has no additional guard traps', async () => {
  const result = await compare((_f, targets, trace) => {
    targets[0] = new Proxy(targets[0], {
      get(t, p, receiver) {
        trace.push(`get:${String(p)}`);
        return Reflect.get(t, p, receiver);
      },
      ownKeys(t) {
        trace.push('ownKeys');
        return Reflect.ownKeys(t);
      },
      getOwnPropertyDescriptor(t, p) {
        trace.push(`descriptor:${String(p)}`);
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
    });
  });
  success(result);
  assert.ok(result.traceA.length > 0);
});

test('a revoked target proxy has the same error', async () => {
  const result = await compare((_f, targets) => {
    const p = Proxy.revocable(targets[0], {});
    p.revoke();
    targets[0] = p.proxy;
  });
  assert.ok(result.first.error instanceof TypeError);
  assert.match(result.first.error.message, /revoked/);
});

test('stored array find shadow retains the original scan TypeError', async () => {
  const result = await compare((f) => {
    Object.defineProperty(f.store.state.tables.x_item, 'find', { value: undefined, configurable: true });
  });
  assert.ok(result.first.error instanceof TypeError);
  assert.match(result.first.error.message, /rows\.find is not a function/);
  assert.ok(summary(result.a).every((row, i) => row.name === `old-${i}`));
});

test('target array entries shadow retains its exact thrown sentinel', async () => {
  const result = await compare((_f, targets, trace, sentinel) => {
    Object.defineProperty(targets, 'entries', {
      configurable: true,
      value() {
        trace.push('target-entries');
        throw sentinel;
      },
    });
  });
  assert.strictEqual(result.first.error, result.sentinel);
  assert.deepEqual(result.traceA, ['target-entries']);
});

test('non-coercible metadata does not replace an earlier undeclared-key error', async () => {
  const result = await compare(
    (f) => {
      f.store.state.mappings.x_item.fields.x_code.dataverseType = Object.create(null);
    },
    {
      targets: () => {
        const ts = requestTargets();
        ts[0]['@odata.id'] = "x_items(unknown='v')";
        return ts;
      },
    },
  );
  dataError(result, {
    code: 'InvalidKey',
    message:
      "The key in the request URI is not valid for resource 'Microsoft.Dynamics.CRM.x_item'. Ensure that the names and number of key properties match the declared or alternate key properties for the resource 'Microsoft.Dynamics.CRM.x_item'.",
    details: { httpStatus: 400, innerCode: '0x80060888', route: true },
  });
  assert.ok(summary(result.a).every((row, i) => row.name === `old-${i}`));
});

test('Unicode GUID-shaped keys use existing nontransactional lookup behavior', async () => {
  const plain = 'aaaaaaaa-0000-4000-8000-000000000001',
    accent = 'áaaaaaaa-0000-4000-8000-000000000001';
  const result = await compare((f, targets) => {
    f.store.state.tables.x_item[0].x_code = plain;
    targets[0]['@odata.id'] = `x_items(x_code='${accent}')`;
  });
  success(result);
  assert.equal(result.first.rows.find((row) => row.code === plain)?.name, 'changed-0');
});

test('between requests direct edits and same-length replacement remain visible', async () => {
  const a = await fixture(DataStore),
    b = await fixture(LinearStore);
  const first = await outcome(a, requestTargets());
  assert.equal(first.status, 204);
  assert.deepEqual(first, await outcome(b, requestTargets()));
  for (const f of [a, b]) {
    const rows = f.store.state.tables.x_item;
    rows[0].x_code = 'DIRECT';
    rows[1] = { ...rows[1], x_code: 'REPLACED' };
  }
  const input = () => {
    const ts = requestTargets();
    ts[0]['@odata.id'] = "x_items(x_code='DIRECT')";
    ts[1]['@odata.id'] = "x_items(x_code='REPLACED')";
    return ts;
  };
  const second = await outcome(a, input());
  assert.equal(second.status, 204);
  assert.deepEqual(second, await outcome(b, input()));
  assert.deepEqual(second.rows.slice(0, 2), [
    { id: gid(1), code: 'DIRECT', name: 'changed-0' },
    { id: gid(2), code: 'REPLACED', name: 'changed-1' },
  ]);
});

test('duplicate stored keys select the first row before the write hook', async () => {
  const result = await compare(
    (f, _targets, trace, sentinel) => {
      f.store.state.tables.x_item[1].x_code = 'K0';
      f.hooks.add('beforeWrite', (_c, _mapping, info) => {
        assert.equal(info.operation, 'update');
        trace.push(info.existing.x_itemid);
        // Stop before the unchanged uniqueness rule rejects the deliberately duplicate state.
        throw sentinel;
      });
    },
    { targets: () => requestTargets().filter((_target, i) => i !== 1) },
  );
  assert.strictEqual(result.first.error, result.sentinel);
  assert.deepEqual(result.traceA, [gid(1)]);
  assert.ok(summary(result.a).every((row, i) => row.name === `old-${i}`));
});

for (const accessor of ['collation', 'dataverseType']) {
  test(`recursive ${accessor} accessor adds no speculative eligibility reads`, async () => {
    const result = await compare((f, _targets, trace) => {
      const object = accessor === 'collation' ? f.store.state.settings : f.store.state.mappings.x_item.fields.x_code;
      const value = accessor === 'collation' ? 'CI_AI' : 'nvarchar';
      Object.defineProperty(object, accessor, {
        configurable: true,
        enumerable: true,
        get() {
          trace.push(accessor);
          return value;
        },
      });
    });
    success(result);
    assert.ok(result.traceA.length > 0);
    assert.ok(result.traceA.every((entry) => entry === accessor));
    assert.equal(result.first.rows[0].name, 'changed-0');
  });
}

test('proxied stored rows add no guard traps', async () => {
  const result = await compare((f, targets, trace, sentinel) => {
    const rows = f.store.state.tables.x_item;
    rows[0] = new Proxy(rows[0], {
      get(t, p, receiver) {
        trace.push(`get:${String(p)}`);
        return Reflect.get(t, p, receiver);
      },
      getOwnPropertyDescriptor(t, p) {
        trace.push(`descriptor:${String(p)}`);
        return Reflect.getOwnPropertyDescriptor(t, p);
      },
      ownKeys(t) {
        trace.push('ownKeys');
        return Reflect.ownKeys(t);
      },
    });
    let reads = 0;
    Object.defineProperty(targets[0], 'x_name', {
      enumerable: true,
      get() {
        if (++reads === 2) throw sentinel;
        return 'changed-0';
      },
    });
  });
  // Stop at SDK-input projection after every classification lookup, before write
  // transaction cloning, which need not support an arbitrary user Proxy in state.
  assert.strictEqual(result.first.error, result.sentinel);
  assert.ok(result.traceA.includes('get:x_code'));
});

test('ASCII GUID alternate key retains same handler result', async () => {
  const guid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const result = await compare((f, targets) => {
    f.store.state.tables.x_item[0].x_code = guid;
    targets[0]['@odata.id'] = `x_items(x_code='{${guid.toUpperCase()}}')`;
  });
  success(result);
  assert.equal(result.first.rows[0].name, 'changed-0');
});

test('prototype provider accessor changes retain lookup observations', async () => {
  const a = await fixture(DataStore),
    b = await fixture(LinearStore);
  const before = Object.getOwnPropertyDescriptor(DataStore.prototype, 'virtualTables');
  let trace = [];
  try {
    Object.defineProperty(DataStore.prototype, 'virtualTables', {
      configurable: true,
      get() {
        trace.push('provider-get');
        return undefined;
      },
    });
    const first = await outcome(a, requestTargets());
    const ta = trace;
    trace = [];
    const second = await outcome(b, requestTargets());
    assert.equal(first.status, 204);
    assert.deepEqual(first, second);
    assert.deepEqual(ta, trace);
    assert.ok(ta.includes('provider-get'));
  } finally {
    if (before) Object.defineProperty(DataStore.prototype, 'virtualTables', before);
    else delete DataStore.prototype.virtualTables;
  }
});

test('changed proxy prototype parent preserves original trap observations', async () => {
  const a = await fixture(DataStore),
    b = await fixture(LinearStore);
  const before = Object.getPrototypeOf(DataStore.prototype);
  let trace = [];
  const parent = new Proxy(before, {
    get(t, p, receiver) {
      trace.push(`parent:${String(p)}`);
      return Reflect.get(t, p, receiver);
    },
  });
  try {
    Object.setPrototypeOf(DataStore.prototype, parent);
    const first = await outcome(a, requestTargets());
    const ta = trace;
    trace = [];
    const second = await outcome(b, requestTargets());
    assert.equal(first.status, 204);
    assert.deepEqual(first, second);
    assert.deepEqual(ta, trace);
    assert.ok(ta.includes('parent:virtualTables'));
  } finally {
    Object.setPrototypeOf(DataStore.prototype, before);
  }
});

test('reentrant lookup from target getter and subsequent request preserve state', async () => {
  const result = await compare((f, targets, trace) => {
    Object.defineProperty(targets[0], 'x_name', {
      enumerable: true,
      get() {
        trace.push(f.store.findByKey(f.store.resolveMapping('x_item'), "x_code='K1'")?.x_itemid);
        return 'changed-0';
      },
    });
  });
  success(result);
  assert.deepEqual(result.traceA, [gid(2), gid(2)]);
  const a = await outcome(result.a, requestTargets()),
    b = await outcome(result.b, requestTargets());
  assert.equal(a.status, 204);
  assert.deepEqual(a, b);
});

test('classification throw does not leave lookup state in the next request', async () => {
  const a = await fixture(DataStore),
    b = await fixture(LinearStore),
    sentinel = new Error('classification sentinel');
  const originals = [a, b].map((f) => {
    const row = f.store.state.tables.x_item[0],
      original = Object.getOwnPropertyDescriptor(row, 'x_code');
    Object.defineProperty(row, 'x_code', {
      configurable: true,
      enumerable: true,
      get() {
        throw sentinel;
      },
    });
    return { row, original };
  });
  const first = await outcome(a, requestTargets()),
    second = await outcome(b, requestTargets());
  assert.strictEqual(first.error, sentinel);
  assert.strictEqual(second.error, sentinel);
  assert.deepEqual(first, second);
  for (const { row, original } of originals) Object.defineProperty(row, 'x_code', original);
  const next = await outcome(a, requestTargets());
  assert.equal(next.status, 204);
  assert.deepEqual(next, await outcome(b, requestTargets()));
});

// Larger real-handler batches; separate per-case coverage must establish admission.
const ACTIVE_COUNT = 512;
const NEW_COUNT = 64;
const EXISTING_COUNT = ACTIVE_COUNT - NEW_COUNT;
for (const collation of ['CI_AI', 'CI_AS']) {
  test(`active-scope mixed keys and case folding preserve the handler contract (${collation})`, async () => {
    const result = await compare(null, {
      count: ACTIVE_COUNT,
      collation,
      targets: () => {
        const ts = requestTargets(ACTIVE_COUNT);
        for (let i = 0; i < EXISTING_COUNT; i++) ts[i]['@odata.id'] = `x_items(x_code='k${i}')`;
        for (let i = EXISTING_COUNT; i < ts.length; i++)
          ts[i] = { '@odata.id': `x_items(x_code='NEW${i}')`, x_code: `NEW${i}`, x_name: `new-${i}` };
        return ts;
      },
    });
    success(result);
    assert.equal(result.first.rows.length, ACTIVE_COUNT + NEW_COUNT);
    for (let i = 0; i < ACTIVE_COUNT; i++)
      assert.deepEqual(result.first.rows[i], {
        id: gid(i + 1),
        code: `K${i}`,
        name: i < EXISTING_COUNT ? `changed-${i}` : `old-${i}`,
      });
    assert.deepEqual(
      result.first.rows.slice(ACTIVE_COUNT).map(({ code, name }) => ({ code, name })),
      Array.from({ length: NEW_COUNT }, (_, i) => ({
        code: `NEW${i + EXISTING_COUNT}`,
        name: `new-${i + EXISTING_COUNT}`,
      })),
    );
  });
}

test('active-scope duplicate stored keys select the original first row before the hook', async () => {
  const result = await compare(
    (f, _targets, trace, sentinel) => {
      f.store.state.tables.x_item[1].x_code = 'K0';
      f.hooks.add('beforeWrite', (_c, _mapping, info) => {
        assert.equal(info.operation, 'update');
        trace.push(info.existing.x_itemid);
        throw sentinel;
      });
    },
    { count: ACTIVE_COUNT, targets: () => requestTargets(ACTIVE_COUNT).filter((_target, i) => i !== 1) },
  );
  assert.strictEqual(result.first.error, result.sentinel);
  assert.deepEqual(result.traceA, [gid(1)]);
  assert.ok(summary(result.a).every((row, i) => row.name === `old-${i}`));
});

test('active-scope decorated ASCII GUID key keeps the original handler result', async () => {
  const guid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const result = await compare(
    (f, targets) => {
      f.store.state.tables.x_item[0].x_code = guid;
      targets[0]['@odata.id'] = `x_items(x_code='{${guid.toUpperCase()}}')`;
    },
    { count: ACTIVE_COUNT, targets: () => requestTargets(ACTIVE_COUNT) },
  );
  success(result);
  assert.deepEqual(result.first.rows[0], { id: gid(1), code: guid, name: 'changed-0' });
  assert.equal(result.first.rows.length, ACTIVE_COUNT);
});

for (const [label, separator] of [
  ['LS', '\u2028'],
  ['PS', '\u2029'],
]) {
  test(`non-ASCII ${label} key uses the original handler fallback`, async () => {
    const key = `K0${separator}`;
    const result = await compare(
      (f, targets) => {
        f.store.state.tables.x_item[0].x_code = key;
        targets[0]['@odata.id'] = `x_items(x_code='${key}')`;
      },
      { count: ACTIVE_COUNT, targets: () => requestTargets(ACTIVE_COUNT) },
    );
    success(result);
    assert.equal(result.first.rows.length, ACTIVE_COUNT);
    assert.deepEqual(result.first.rows[0], { id: gid(1), code: key, name: 'changed-0' });
    assert.ok(result.first.rows.every((row, i) => row.name === `changed-${i}`));
    assert.deepEqual(result.traceA, []);
  });
}
