// @test-kind parity: native dev-environment recorder corpus (sdkSurface): a synchronous step that catches the 0x80040217 fault of an SDK Update on a missing row keeps its transaction, and the triggering operation succeeds
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkFault } from '../lib/plugin-sdk-messages.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const MISSING = '79000000-0000-0000-0000-000000000009';

test('a caught missing-row fault does not abort the step transaction', async (t) => {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.mappings.x_log = { entitySet: 'x_logs', idColumn: 'x_logid' };
  state.tables.x_item = [];
  state.tables.x_log = [];
  const store = await new DataStore({ state }).init();
  const organization = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: true }) });
  t.after(() => organization.close());
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  const profile = { userId: system, evidence: 'Invented fault-tolerant step', grants: [] };
  const call = (method, args) =>
    dispatchSdkCall({
      store,
      profile,
      // The call comes from inside a synchronous step (its execution context is the parent), as a CLR plug-in's does.
      sdkParentContext: { $type: 'ExecutionContext', values: { MessageName: 'Create', Stage: 20, Depth: 1 } },
      message: { method, userId: null, arguments: args },
    });
  let fault;
  store.setPluginPipeline(
    (context) => {
      if (context.stage !== 20) return;
      try {
        call('Update', [{ $type: 'Entity', logicalName: 'x_log', id: MISSING, attributes: { x_name: 'missing' } }]);
      } catch (error) {
        fault = sdkFault(error);
      }
      call('Create', [
        {
          $type: 'Entity',
          logicalName: 'x_log',
          id: '00000000-0000-0000-0000-000000000000',
          attributes: { x_name: 'after' },
        },
      ]);
    },
    (context) => context.entity === 'x_item' && context.operation === 'create',
  );
  await store.transact(() =>
    store.withOperationContext(() =>
      localOrganizationService(store, { ...profile, grants: [{ entity: 'x_item', operations: ['create'] }] }).create(
        'x_item',
        { x_name: 'trigger' },
      ),
    ),
  );
  assert.equal(fault.errorCode, 0x80040217 | 0);
  assert.equal(fault.message, `Entity 'x_log' With Id = ${MISSING} Does Not Exist`);
  assert.equal(store.tableRows('x_item').length, 1, 'the triggering Create committed');
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['after'],
  );
});
