// Alternate-key upsert precedence (dataverse-records.mjs upsertNow): when the record exists the server removes the body
// values for the key columns the URL addresses (the key cannot change through the key that addresses it); when it does not,
// the body's key values are used even when they differ from the URL and only missing ones are copied from the URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const A = '77777777-7777-4777-8777-7777777777c1';

async function start(t) {
  const secret = `PAQVILO_UPSERT_KEYS_${process.pid}`;
  process.env[secret] = 'invented-secret';
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } },
    alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }],
  };
  state.tables.x_item = [{ x_itemid: A, x_name: 'Alpha', x_code: 'A1' }];
  const store = await new DataStore({ state }).init();
  const server = await startDataverseApi({
    store,
    extensions: EXTENSIONS,
    log: () => {},
    settings: dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP, displayName: 'Invented app', secretEnvironmentVariable: secret, roles: ['System Administrator'] },
      ],
    }),
  });
  t.after(async () => {
    delete process.env[secret];
    await server.close();
  });
  const token = (
    await (
      await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: 'invented-secret',
          scope: `${server.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  const patch = async (path, body) =>
    (
      await fetch(`${server.origin}/api/data/v9.2${path}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).status;
  return { rows: () => store.state.tables.x_item.map((row) => `${row.x_name}:${row.x_code}`), patch };
}

test('an upsert that updates ignores body values for the key columns the URL addresses', async (t) => {
  const { rows, patch } = await start(t);
  assert.equal(await patch("/x_items(x_code='A1')", { x_code: 'Z9', x_name: 'Alpha 2' }), 204);
  assert.deepEqual(rows(), ['Alpha 2:A1']);
});

test("an upsert that creates keeps the body's key values and copies only missing ones from the URL", async (t) => {
  const { rows, patch } = await start(t);
  assert.equal(await patch("/x_items(x_code='N1')", { x_code: 'B2', x_name: 'Beta' }), 204);
  assert.equal(await patch("/x_items(x_code='N3')", { x_name: 'Gamma' }), 204);
  assert.deepEqual(rows(), ['Alpha:A1', 'Beta:B2', 'Gamma:N3']);
});
