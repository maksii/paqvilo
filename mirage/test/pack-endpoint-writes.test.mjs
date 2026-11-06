// @test-kind contract+security: opted-in pack handlers receive bounded, authenticated, local-only atomic CRUD with declared target authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sourceFixture } from './fixtures/source-site.mjs';
import { createSimulator, readStateFile } from '../api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { signInHeaders } from '../testing.mjs';

async function fixture(t, { enhanced = false } = {}) {
  let calls = 0,
    escaped;
  const pack = {
    id: 'invented-writes',
    name: 'Invented writes',
    description: 'Invented local transaction fixture',
    matches: () => true,
    presets: () => ({}),
    endpoints: [
      {
        id: 'unit',
        methods: ['POST'],
        pattern: /^\/__sim\/invented-unit$/g,
        writes: ({ body }) =>
          body.targets ?? [
            { entity: 'x_item', operation: body.remove ? 'delete' : 'update', id: body.id, ifMatch: body.ifMatch },
          ],
        handle: async ({ body, transaction }) => {
          calls++;
          const work = transaction(async (records) => {
            escaped = records;
            if (body.remove) {
              await records.remove('x_item', body.id);
              return { removed: body.id };
            }
            const row = await records.update('x_item', body.id, body.values ?? { x_name: body.name });
            if (body.undeclared) {
              try {
                await records.update('x_item', 'foreign', { x_name: 'Undeclared' });
              } catch {
                /* the unit must still roll back */
              }
            }
            if (body.child) await records.create('x_item', { x_name: 'Child', x_contact: 'visitor' });
            if (body.fail) throw new Error('Invented unit failure');
            if (body.largeResult) return { value: 'x'.repeat(1024 * 1024 + 1) };
            return { id: row.x_itemid, name: row.x_name };
          });
          return body.catchFailure ? work.catch(() => ({ caught: true })) : work;
        },
      },
      {
        id: 'read',
        methods: ['GET'],
        pattern: /^\/__sim\/invented-read$/,
        handle: ({ res, transaction, write }) =>
          res.end(JSON.stringify({ transaction: typeof transaction, write: typeof write })),
      },
    ],
  };
  const { root, sourceDir } = await sourceFixture(t, {
    prefix: 'paq-pack-writes-',
    files: {
      'website.yml': `adx_websiteid: invented\nadx_name: Invented\nadx_enhancedauthorization: ${enhanced ? 3 : 0}`,
      'writer.webrole.yml': 'adx_webroleid: 11111111-1111-4111-8111-111111111111\nadx_name: Writer',
    },
  });
  const options = {
    sourceDir,
    stateFile: path.join(root, 'state.json'),
    trace: { level: 'full' },
    watch: false,
    packs: [pack],
    initial: {
      mappings: {
        x_item: {
          entitySet: 'x_items',
          idColumn: 'x_itemid',
          fields: {
            x_name: { dataverseType: 'nvarchar' },
            x_contact: { dataverseType: 'nvarchar' },
            x_secret: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } },
          },
        },
        contact: { entitySet: 'contacts', idColumn: 'contactid' },
      },
      tables: {
        x_item: [
          { x_itemid: 'own', x_name: 'Before', x_contact: 'visitor', versionnumber: 1 },
          { x_itemid: 'foreign', x_name: 'Foreign', x_contact: 'other' },
        ],
        contact: [{ contactid: 'visitor' }, { contactid: 'other' }],
      },
      permissions: [
        {
          entity: 'x_item',
          roles: ['Writer'],
          scope: 'contact',
          field: 'x_contact',
          operations: ['read', 'create', 'update', 'delete'],
        },
      ],
      settings: { permissionMode: 'enforce' },
    },
  };
  let sim = await createSimulator(options);
  ownedFixture(t).add(() => sim.close());
  const headers = () => ({
    ...signInHeaders(sim, 'visitor', { roles: ['Writer'] }),
    'content-type': 'application/json',
    __RequestVerificationToken: sim.csrf,
  });
  const call = (body, overrides) =>
    fetch(sim.url + '/__sim/invented-unit', {
      method: 'POST',
      headers: { ...headers(), ...overrides },
      body: JSON.stringify(body),
    });
  return {
    get sim() {
      return sim;
    },
    call,
    calls: () => calls,
    escaped: () => escaped,
    restart: async () => {
      await sim.close();
      sim = await createSimulator(options);
    },
    persisted: () => readStateFile(options.stateFile),
  };
}

test('pack writes reject unverified and foreign targets before invoking the handler and GET has no write capability', async (t) => {
  const { sim, call, calls } = await fixture(t);
  assert.equal((await call({ id: 'own', name: 'Denied' }, { cookie: '' })).status, 401);
  assert.equal((await call({ id: 'own', name: 'Denied' }, { __RequestVerificationToken: 'wrong' })).status, 403);
  assert.equal((await call({ id: 'foreign', name: 'Denied' })).status, 403);
  assert.equal((await call({ id: 'own', name: 'Denied', ifMatch: 'W/"999"' })).status, 412);
  assert.equal(calls(), 0);
  assert.deepEqual(await (await fetch(sim.url + '/__sim/invented-read')).json(), {
    transaction: 'undefined',
    write: 'undefined',
  });
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Before');
});

test('pack units commit through the pipeline, roll back children and expire escaped capabilities', async (t) => {
  const { sim, call, escaped } = await fixture(t);
  const targets = [
    { entity: 'x_item', operation: 'update', id: 'own' },
    { entity: 'x_item', operation: 'create', values: { x_contact: 'visitor' } },
  ];
  const failed = await call({ id: 'own', name: 'Rollback', child: true, fail: true, targets });
  assert.equal(failed.status, 500);
  assert.equal(sim.store.tableRows('x_item').length, 2);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Before');
  const success = await call({ id: 'own', name: 'Committed', child: true, targets });
  assert.equal(success.status, 200, await success.clone().text());
  assert.equal(sim.store.tableRows('x_item').length, 3);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Committed');
  const oversized = await call({ id: 'own', name: 'Oversized rollback', largeResult: true });
  assert.equal(oversized.status, 413);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Committed');
  const undeclared = await call({ id: 'own', name: 'Caught target refusal', undeclared: true });
  assert.equal(undeclared.status, 403);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Committed');
  assert.ok(sim.store.tableRows('x_item')[0].modifiedon);
  assert.throws(() => escaped().update('x_item', 'own', { x_name: 'Late' }), /expired/);
  const caught = await call({ id: 'own', name: 'Caught rollback', fail: true, catchFailure: true });
  assert.equal(caught.status, 500);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Committed');
});

test('pack mutation providers, declaration bounds and payload limits fail before handler work', async (t) => {
  const { sim, call, calls } = await fixture(t);
  assert.equal((await call({ id: 'own', targets: [] })).status, 400);
  assert.equal(
    (
      await call({
        id: 'own',
        targets: Array.from({ length: 101 }, () => ({ entity: 'x_item', operation: 'update', id: 'own' })),
      })
    ).status,
    400,
  );
  assert.equal((await call({ id: 'own', name: 'x'.repeat(8 * 1024 * 1024) })).status, 413);
  await sim.store.transact(() => {
    sim.store.state.simulator.mode = 'live';
  });
  assert.equal((await call({ id: 'own', name: 'Denied live' })).status, 409);
  assert.equal(calls(), 0);
});

test('idempotency receipts serialize concurrent callers, reject changed bodies and isolate runtimes', async (t) => {
  const first = await fixture(t),
    second = await fixture(t);
  const body = { id: 'own', name: 'Once' },
    header = { 'idempotency-key': 'invented-key' };
  const replies = await Promise.all([first.call(body, header), first.call(body, header)]);
  assert.deepEqual(
    replies.map((response) => response.status),
    [200, 200],
  );
  assert.equal(first.calls(), 1);
  assert.equal((await first.call({ ...body, name: 'Different' }, header)).status, 409);
  assert.equal((await second.call(body, header)).status, 200);
  assert.equal(second.calls(), 1);
  assert.equal((await first.persisted()).tables.x_item[0].x_name, 'Once');
  await first.restart();
  assert.equal((await first.call(body, header)).status, 200);
  assert.equal(first.calls(), 1, 'persisted receipt suppresses handler work after restart');
});

test('duplicate deletes reauthorize the committed preimage and do not replay the handler after permission revocation', async (t) => {
  const app = await fixture(t),
    body = { id: 'own', remove: true },
    headers = { 'idempotency-key': 'delete-key' };
  for (let i = 0; i < 2; i++) {
    const reply = await app.call(body, headers);
    assert.equal(reply.status, 200, await reply.clone().text());
    assert.deepEqual(await reply.json(), { removed: 'own' });
  }
  assert.equal(app.calls(), 1);
  assert.equal(app.sim.store.tableRows('x_item').length, 1);
  await app.sim.store.transact(() => {
    app.sim.store.state.permissions = [];
  });
  assert.equal((await app.call(body, headers)).status, 403);
  assert.equal(app.calls(), 1);
});

test('enhanced visitor field security and pipeline trace attribution apply to pack CRUD', async (t) => {
  const { sim, call } = await fixture(t, { enhanced: true });
  const denied = await call({
    id: 'own',
    values: { x_name: 'Denied secured write', x_secret: 'Invented secured value' },
  });
  assert.equal(denied.status, 403, await denied.clone().text());
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Before');
  const allowed = await call({ id: 'own', name: 'Enhanced committed' });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  await sim.settle();
  const tree = sim.trace.tree(allowed.headers.get('x-trace-id'));
  assert.ok(tree.spans.some((span) => span.kind === 'http' && span.actor.id === 'visitor'));
  assert.ok(tree.spans.some((span) => span.entity === 'x_item' && span.operation === 'update'));
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Enhanced committed');
});
