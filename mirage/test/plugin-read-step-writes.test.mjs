// @test-kind parity: native dev-environment recorder corpus (readNested): RetrieveMultiple and Retrieve steps write through the SDK on a Web API read, and a Retrieve step's write stays committed when the read then faults
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';

const ORIGIN = 'http://127.0.0.1';
const ITEM = '78000000-0000-0000-0000-000000000001';

test('a read step writes through the SDK on a Web API read and its write survives a later read fault', async (t) => {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.mappings.x_log = { entitySet: 'x_logs', idColumn: 'x_logid' };
  state.tables.x_item = [{ x_itemid: ITEM, x_name: 'read me' }];
  state.tables.x_log = [];
  const store = await new DataStore({ state }).init();
  const organization = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: true }) });
  t.after(() => organization.close());
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  const profile = { userId: system, evidence: 'Invented read observer', grants: [] };
  // Native readNested: the RetrieveMultiple and Retrieve PostOperation steps each create a row; the Retrieve step then throws.
  store.setPluginPipeline(
    (context) => {
      if (context.stage !== 40) return;
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Create',
          userId: null,
          arguments: [
            {
              $type: 'Entity',
              logicalName: 'x_log',
              id: '00000000-0000-0000-0000-000000000000',
              attributes: { x_name: context.operation },
            },
          ],
        },
      });
      if (context.operation === 'retrieve') throw new Error('Invented read fault');
    },
    (context) => context.entity === 'x_item' && ['retrieve', 'retrievemultiple'].includes(context.operation),
  );
  const read = (path) =>
    organization.api.records.handle({
      method: 'GET',
      route: parseDataverseRoute(path),
      url: new URL(ORIGIN + path),
      origin: ORIGIN,
      version: 'v9.2',
      prefer: parsePrefer(undefined),
      headers: {},
      user: store.tableRows('systemuser').find((row) => row.systemuserid === system),
      caller: null,
      identity: { admin: true },
    });
  const listed = await read('/api/data/v9.2/x_items');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['retrievemultiple'],
  );
  await assert.rejects(read(`/api/data/v9.2/x_items(${ITEM})`), /Invented read fault/);
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['retrievemultiple', 'retrieve'],
    'the Retrieve step write committed on its own before the read faulted',
  );
});
