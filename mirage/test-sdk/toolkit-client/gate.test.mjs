// SDK verification gate: the toolkit's own Dataverse client and data loader against the simulated Dataverse API.
// Opt-in (`npm run test:sdk`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startGate } from '../harness.mjs';
import { connectedClient } from '../../../lense/dataverse/client.mjs';
import { planData, applyData, compareData, runDataQueries } from '../../../lense/dataverse/data.mjs';

const TIMEOUT = 60_000;
const ids = {
  w1: '00000000-0000-0000-0000-000000000001',
  w2: '00000000-0000-0000-0000-000000000002',
  g1: '00000000-0000-0000-0000-0000000000a1',
};

const catalogue = () => ({
  schemaVersion: 1,
  datasetId: 'sdk-gate',
  version: 'v1',
  clock: '2026-10-19T09:00:00Z',
  tables: [
    { name: 'widget', entitySet: 'widgets', primaryId: 'widgetid', keys: [['code']] },
    { name: 'gadget', entitySet: 'gadgets', primaryId: 'gadgetid', keys: [] },
  ],
  records: [
    { key: 'w1', id: ids.w1, table: 'widget', fields: { name: 'Alpha', price: 9.5, quantity: 3, category: 1, code: 'A-1' } },
    { key: 'w2', id: ids.w2, table: 'widget', fields: { name: 'Beta', price: 12.25, quantity: 0, category: 2, code: 'B-2' } },
    { key: 'g1', id: ids.g1, table: 'gadget', fields: { name: 'Sprocket' }, refs: { widgetid: 'w1' }, deferredRefs: ['widgetid'] },
  ],
  associations: [],
  queries: [{
    id: 'widgets-by-name',
    table: 'widget',
    fetchXml: '<fetch><entity name="widget"><attribute name="name"/><attribute name="quantity"/><order attribute="name"/></entity></fetch>',
    columns: ['name', 'quantity'],
    expected: [{ name: 'Alpha', quantity: 3 }, { name: 'Beta', quantity: 0 }],
  }],
});

// Starts a fresh simulator per test and builds the toolkit client exactly as a saved connection would.
async function openGate(t) {
  const gate = await startGate();
  t.after(() => gate.close());
  t.after(() => { delete process.env.GATE_SECRET; });
  const connection = {
    schemaVersion: 1,
    environmentUrl: gate.origin,
    tenantId: gate.tenantId,
    clientId: gate.clientId,
    credentialSource: 'environment',
    secretEnvironmentVariable: 'GATE_SECRET',
    authorityHost: gate.origin,
  };
  process.env.GATE_SECRET = gate.clientSecret;
  const client = connectedClient(connection, { allowLoopback: true });
  return { gate, connection, client };
}

test('client verifies the organisation through WhoAmI and never sends credentials in request records', { timeout: TIMEOUT }, async t => {
  const { gate, client } = await openGate(t);
  const identity = await client.verify(gate.organizationId);
  assert.equal(identity.environmentUrl, gate.origin);
  assert.equal(identity.organisationId, gate.organizationId);
  assert.equal(typeof identity.applicationUserId, 'string');
  assert.equal(typeof identity.businessUnitId, 'string');

  const requests = gate.requests();
  assert.ok(requests.some(r => r.method === 'GET' && r.path.endsWith('/WhoAmI')), 'WhoAmI call is recorded');
  assert.ok(requests.every(r => !('authorization' in r)), 'no request record carries an authorization property');
});

test('metadata reads expose the fields the loader needs for widget and gadget', { timeout: TIMEOUT }, async t => {
  const { client } = await openGate(t);
  const widget = await client.get(`EntityDefinitions(LogicalName='widget')?$select=LogicalName,EntitySetName,PrimaryIdAttribute`);
  assert.equal(widget.LogicalName, 'widget');
  assert.equal(widget.EntitySetName, 'widgets');
  assert.equal(widget.PrimaryIdAttribute, 'widgetid');

  const keys = await client.list(`EntityDefinitions(LogicalName='widget')/Keys`);
  assert.ok(keys.some(k => JSON.stringify(k.KeyAttributes) === '["code"]' && k.EntityKeyIndexStatus === 'Active'), 'active alternate key on code');

  const lookups = await client.list(`EntityDefinitions(LogicalName='gadget')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`);
  const widgetLookup = lookups.find(r => r.ReferencingAttribute === 'widgetid');
  assert.ok(widgetLookup, 'gadget.widgetid lookup is declared');
  assert.equal(widgetLookup.ReferencedEntity, 'widget');
  assert.equal(typeof widgetLookup.ReferencingEntityNavigationPropertyName, 'string');
  assert.ok(widgetLookup.ReferencingEntityNavigationPropertyName.length > 0, 'navigation property is non-empty for deferred bind');
});

test('plan, apply, compare and query run end to end, and a rerun is idempotent', { timeout: TIMEOUT }, async t => {
  const { gate, client } = await openGate(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-gate-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = catalogue();

  const plan = await planData(input, { client });
  assert.equal(plan.summary.create, 3);
  assert.equal(plan.summary.drift, 0);

  const applied = await applyData(input, { client, expectedOrganisationId: gate.organizationId, journalFile: path.join(dir, 'journal.json') });
  assert.equal(applied.state, 'Created');

  const creates = gate.requests().filter(r => r.method === 'PATCH');
  assert.ok(creates.some(r => r.path.endsWith(`/widgets(${ids.w1})`)), 'widget w1 PATCHed by stable GUID');
  assert.ok(creates.some(r => r.path.endsWith(`/widgets(${ids.w2})`)), 'widget w2 PATCHed by stable GUID');

  const comparison = await compareData(input, { client });
  assert.equal(comparison.passed, true);
  assert.deepEqual(comparison.records, []);
  assert.deepEqual(comparison.associations, []);

  const queries = await runDataQueries(input, { client });
  assert.equal(queries.passed, true);
  assert.equal(queries.results.length, 1);
  assert.equal(queries.results[0].status, 'Passed');

  const before = gate.requests().length;
  const rerun = await applyData(input, { client, expectedOrganisationId: gate.organizationId, journalFile: path.join(dir, 'journal-rerun.json') });
  assert.equal(rerun.state, 'Created');
  const mutations = gate.requests().slice(before).filter(r => r.method !== 'GET');
  assert.deepEqual(mutations, [], 'second apply sends no mutations');
});

test('a missing row is a 404 and a wrong client secret fails token acquisition with 401', { timeout: TIMEOUT }, async t => {
  const { connection, client } = await openGate(t);
  await assert.rejects(client.get('widgets(00000000-0000-0000-0000-000000000009)'), error => error.status === 404);

  process.env.GATE_BAD_SECRET = 'not-the-gate-secret';
  t.after(() => { delete process.env.GATE_BAD_SECRET; });
  const wrong = connectedClient({ ...connection, secretEnvironmentVariable: 'GATE_BAD_SECRET' }, { allowLoopback: true });
  // Token acquisition errors carry the HTTP status only in the message (no .status property).
  await assert.rejects(wrong.verify(), /HTTP 401/);
});
