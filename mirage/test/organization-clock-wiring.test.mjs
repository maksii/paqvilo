import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { organizationPrincipalContext } from '../lib/dataverse-principal-context.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { remoteExecutionContext } from '../lib/dataverse-webhooks.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';

const START = Date.parse('2026-05-04T09:30:00.000Z');
const ADMIN = '77777777-7777-4777-8777-000000000010';

async function organization(t) {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    ownership: 'UserOwned',
    dataverseMetadata: { IsAuditEnabled: true },
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const clock = fixedClock(START),
    ids = sequentialIds('77777777-7777-4777-8777-777777777777');
  const core = await createOrganizationRuntime({
    store,
    clock,
    ids,
    settings: dataverseSettings({
      enabled: false,
      auditing: true,
      users: [
        {
          objectId: ADMIN,
          domainname: 'admin@example.test',
          fullname: 'Invented Administrator',
          roles: ['System Administrator'],
        },
      ],
    }),
    extensions: await sourceOrganizationExtensions(),
  });
  t.after(() => core.close());
  const principal = organizationPrincipalContext(store, core.principals.byObjectId(ADMIN));
  const webApi = (method, suffix, body) => {
    const url = new URL(`http://organization.example.test/api/data/v9.2/${suffix}`);
    return core.records.handle({
      method,
      url,
      origin: url.origin,
      version: 'v9.2',
      route: parseDataverseRoute(url.pathname),
      prefer: parsePrefer('return=representation'),
      headers: {},
      body,
      requestId: ids.uuid(),
      ...principal,
    });
  };
  return { store, core, clock, ids, webApi };
}

test('the organization clock and ids reach the store, the API and the scheduler', async (t) => {
  const { store, core, clock, ids } = await organization(t);
  assert.equal(store.clock, clock);
  assert.equal(store.ids, ids);
  assert.equal(core.api.clock(), START);
  assert.equal(core.api.ids, ids);
  assert.equal(core.api.scheduler, store.scheduler);
  const manual = createScheduler({ clock, manual: true });
  const other = await new DataStore({ state: emptyState() }).init();
  const second = await createOrganizationRuntime({
    store: other,
    scheduler: manual,
    settings: dataverseSettings({ enabled: false }),
    extensions: [],
  });
  t.after(() => second.close());
  assert.equal(second.api.scheduler, manual);
  assert.equal(other.scheduler, manual);
});

test('Web API create and update stamp createdon and modifiedon from the fixed clock', async (t) => {
  const { store, clock, webApi } = await organization(t);
  const created = await webApi('POST', 'x_items', { x_name: 'Invented clocked row' });
  assert.equal(created.status, 201);
  const id = created.body.x_itemid;
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);
  let row = store.tableRows('x_item').find((item) => item.x_itemid === id);
  assert.equal(row.createdon, '2026-05-04T09:30:00Z');
  assert.equal(row.modifiedon, '2026-05-04T09:30:00Z');
  clock.advance(90_000);
  const updated = await webApi('PATCH', `x_items(${id})`, { x_name: 'Invented clocked row, renamed' });
  assert.equal(updated.status, 200);
  row = store.tableRows('x_item').find((item) => item.x_itemid === id);
  assert.equal(row.createdon, '2026-05-04T09:30:00Z');
  assert.equal(row.modifiedon, '2026-05-04T09:31:30Z');
});

test('audit rows and web hook payloads take their time and ids from the organization sources', async (t) => {
  const { store, core, clock, webApi } = await organization(t);
  clock.advance(5_000);
  const created = await webApi('POST', 'x_items', { x_name: 'Invented audited row' });
  await store.flushCommittedEvents();
  await core.read(() => {});
  const audit = store.tableRows('audit').find((row) => row.objectid?.id === created.body.x_itemid);
  assert.ok(audit, 'the create is audited');
  assert.equal(new Date(audit.createdon).getTime(), START + 5_000);
  assert.match(audit.auditid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);
  clock.advance(1_000);
  const row = store.tableRows('x_item').find((item) => item.x_itemid === created.body.x_itemid);
  const payload = remoteExecutionContext(store, {
    item: { id: '77777777-7777-4777-8777-000000000020', contract: { mode: 1 }, images: [] },
    entity: 'x_item',
    operation: 'create',
    stage: 40,
    target: { x_name: row.x_name },
    record: row,
    previous: null,
    identity: {},
    depth: 1,
    correlationId: '77777777-7777-4777-8777-000000000021',
    asyncExecution: true,
  });
  assert.equal(payload.OperationCreatedOn, `/Date(${START + 6_000})/`);
  assert.match(payload.OperationId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-/);
});
