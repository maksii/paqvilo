// Virtual table providers in an atomic group (dataverse-virtual-providers.mjs, Transactions). Provider plug-ins run in
// stage 30, the operation's core transaction stage. A provider with begin/commit/rollback is enlisted
// once per outermost transaction and rolled back with it whatever fails; a provider without the contract keeps its write and the
// rollback names the row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION, validateVirtualTableProviders } from '../lib/dataverse-virtual-providers.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';

const A = '77777777-7777-4777-8777-777777777771',
  B = '77777777-7777-4777-8777-777777777772';
const APP = '77777777-7777-4777-8777-777777777777';

async function setup(t, { transactional }) {
  const external = new Map([
    [A, { x_extid: A, x_name: 'Alpha' }],
    [B, { x_extid: B, x_name: 'Beta' }],
  ]);
  const calls = [],
    diagnostics = [];
  let undo = [];
  const provider = {
    retrieveMultiple: async () => [...external.values()].map((row) => ({ ...row })),
    update: (id, patch) => {
      calls.push(`update:${id}`);
      undo.push([id, { ...external.get(id) }]);
      Object.assign(external.get(id), patch);
      return { ...external.get(id) };
    },
  };
  if (transactional)
    Object.assign(provider, {
      begin: (ctx) => {
        calls.push(`begin:${ctx.operation}`);
        undo = [];
      },
      commit: () => {
        calls.push('commit');
        undo = [];
      },
      rollback: () => {
        calls.push('rollback');
        for (const [id, row] of undo.reverse()) external.set(id, row);
        undo = [];
      },
    });
  const variable = `PAQ_VIRTUAL_TRANSACTIONS_${process.pid}_${transactional ? 'T' : 'P'}`;
  process.env[variable] = 'invented-secret';
  const state = emptyState();
  state.mappings.x_ext = {
    logicalName: 'x_ext',
    entitySet: 'x_exts',
    idColumn: 'x_extid',
    nameColumn: 'x_name',
    isVirtual: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_ext = [...external.values()].map((row) => ({ ...row }));
  const store = await new DataStore({ state }).init();
  const installed = {
    ...EXTENSION,
    install: (api) =>
      EXTENSION.install(api, {
        virtualTableProviders: { x_ext: provider },
        diagnostic: (entry) => diagnostics.push(entry),
      }),
  };
  const server = await startDataverseApi({
    store,
    log: () => {},
    extensions: [...EXTENSIONS.filter((e) => e.name !== EXTENSION.name), installed],
    settings: dataverseSettings({
      enabled: true,
      tds: { enabled: false },
      applications: [
        { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
      ],
    }),
  });
  t.after(async () => {
    delete process.env[variable];
    await server.close();
  });
  const token = (
    await (
      await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: 'invented-secret',
          scope: `${server.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  await fetch(`${server.origin}/api/data/v9.2/x_exts`, { headers: { authorization: `Bearer ${token}` } });
  const changeset = async (parts) => {
    const part = (p, i) =>
      `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\nContent-ID: ${i + 1}\r\n\r\n${p.method} /api/data/v9.2${p.path} HTTP/1.1\r\nContent-Type: application/json\r\n${Object.entries(
        p.headers ?? {},
      )
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('')}\r\n${JSON.stringify(p.body)}\r\n`;
    const body = `--batch_x\r\nContent-Type: multipart/mixed;boundary=changeset_x\r\n\r\n${parts.map((p, i) => `--changeset_x\r\n${part(p, i)}`).join('')}--changeset_x--\r\n--batch_x--\r\n`;
    return (
      await fetch(`${server.origin}/api/data/v9.2/$batch`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/mixed;boundary=batch_x' },
        body,
      })
    ).status;
  };
  const local = (id) => store.state.tables.x_ext.find((row) => row.x_extid === id);
  return { external, calls, diagnostics, changeset, local };
}

// The second request is refused locally (a stale If-Match): no provider failure, yet the changeset's transaction rolls back.
const refusedSecond = [
  { method: 'PATCH', path: `/x_exts(${A})`, body: { x_name: 'A-new' } },
  { method: 'PATCH', path: `/x_exts(${B})`, headers: { 'If-Match': 'W/"999"' }, body: { x_name: 'B-new' } },
];

test('a transactional provider is enlisted once and rolled back when a later request of the changeset is refused', async (t) => {
  const { external, calls, diagnostics, changeset, local } = await setup(t, { transactional: true });
  assert.equal(await changeset(refusedSecond), 412);
  assert.deepEqual(calls, ['begin:transaction', `update:${A}`, 'rollback']);
  assert.equal(external.get(A).x_name, 'Alpha', 'the provider rolled its own write back');
  assert.equal(local(A).x_name, 'Alpha');
  assert.deepEqual(
    diagnostics.filter((d) => d.code === 'VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED'),
    [],
  );
});

test('a transactional provider commits once after the changeset commits', async (t) => {
  const { external, calls, changeset } = await setup(t, { transactional: true });
  assert.equal(
    await changeset([
      { method: 'PATCH', path: `/x_exts(${A})`, body: { x_name: 'A-ok' } },
      { method: 'PATCH', path: `/x_exts(${B})`, body: { x_name: 'B-ok' } },
    ]),
    200,
  );
  assert.deepEqual(calls, ['begin:transaction', `update:${A}`, `update:${B}`, 'commit']);
  assert.deepEqual([external.get(A).x_name, external.get(B).x_name], ['A-ok', 'B-ok']);
});

test('a provider without the contract keeps its write when a later request is refused, and the rollback names the row', async (t) => {
  const { external, calls, diagnostics, changeset, local } = await setup(t, { transactional: false });
  assert.equal(await changeset(refusedSecond), 412);
  assert.deepEqual(calls, [`update:${A}`]);
  assert.equal(external.get(A).x_name, 'A-new');
  assert.equal(local(A).x_name, 'Alpha');
  assert.deepEqual(
    diagnostics.filter((d) => d.code === 'VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED').map((d) => [d.id, d.operation]),
    [[A, 'update']],
  );
});

test('a transaction contract needs begin, commit and rollback together', () => {
  assert.throws(
    () => validateVirtualTableProviders({ x_ext: { update: () => null, begin: () => null } }),
    /needs begin, commit and rollback/,
  );
  assert.doesNotThrow(() =>
    validateVirtualTableProviders({
      x_ext: { update: () => null, begin: () => null, commit: () => null, rollback: () => null },
    }),
  );
});
