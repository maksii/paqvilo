import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from 'paqvilo/mirage/lib/data.mjs';
import { createWebApiReplayClient } from '../portal-harness/mirage-webapi-replay.mjs';

test('owned Web API replay uses actual HTTP admission, formatting and fail-closed paths', async () => {
  const store = new DataStore({
    state: {
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid', fields: { widgetid: { type: 'guid' } } } },
      tables: { widget: [{ widgetid: '10000000-0000-0000-0000-000000000001' }] },
      permissions: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const client = await createWebApiReplayClient({
    store,
    identity: { contactId: '20000000-0000-0000-0000-000000000002', roles: [] },
    portal: { settings: { 'Webapi/widget/enabled': 'true', 'Webapi/widget/fields': 'widgetid' } },
  });
  try {
    const response = await client.request(
      '/_api/widgets?fetchXml=' +
        encodeURIComponent('<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>'),
    );
    assert.equal(response.status, 403);
    assert.equal(JSON.parse(response.body).error.code, '90040120');
    await assert.rejects(() => client.request('https://example.invalid/_api/widgets'), /relative/);
    await assert.rejects(() => client.request('/_api/../_sim/api/state'), /escaped|relative/);
  } finally {
    await client.close();
  }
  await assert.rejects(() => client.request('/_api/widgets'), /closed/);
});
