// @test-kind parity: native recorder corpus runAsSecond (trial, two captures) and sdkSurface (dev, two captures): a caught SDK Create refused for a missing privilege still fails the operation with 0x8009000c, a caught Update refusal and a caught unknown-column Create (0x80041103) do not
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkFault } from '../lib/plugin-sdk-messages.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';

const LOG = '7a000000-0000-0000-0000-000000000001';
const EMPTY = '00000000-0000-0000-0000-000000000000';

// The PreOperation step of an x_item Create issues one SDK request as the given user, catches its fault, then creates a log row
// as SYSTEM. Answers the caught fault and the operation's outcome.
async function caught(t, request) {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.mappings.x_log = { entitySet: 'x_logs', idColumn: 'x_logid' };
  state.tables.x_item = [];
  state.tables.x_log = [{ x_logid: LOG, x_name: 'existing' }];
  const store = await new DataStore({ state }).init();
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: true,
      users: [
        {
          objectId: '7a000000-0000-0000-0000-0000000000a1',
          domainname: 'plain@invented.test',
          fullname: 'Invented plain',
          roles: [],
        },
      ],
    }),
    // The Solution declares x_log's columns: an undeclared one is unknown.
    schema: () => ({
      targets: {},
      optionSets: {},
      tables: {
        x_log: {
          logicalName: 'x_log',
          attributes: {
            x_logid: { name: 'x_logid', type: 'primarykey' },
            x_name: { name: 'x_name', type: 'nvarchar' },
          },
        },
      },
    }),
  });
  t.after(() => organization.close());
  const users = {
    system: store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid,
    plain: store.tableRows('systemuser').find((row) => row.fullname === 'Invented plain').systemuserid,
  };
  const profile = { userId: users.system, evidence: 'Invented catching step', grants: [] };
  const call = (userId, method, args) =>
    dispatchSdkCall({
      store,
      profile,
      sdkParentContext: { $type: 'ExecutionContext', values: { MessageName: 'Create', Stage: 20, Depth: 1 } },
      message: { method, userId, arguments: args },
    });
  let fault;
  store.setPluginPipeline(
    (context) => {
      if (context.stage !== 20) return;
      try {
        request(call, users);
      } catch (error) {
        fault = sdkFault(error);
      }
      call(null, 'Create', [{ $type: 'Entity', logicalName: 'x_log', id: EMPTY, attributes: { x_name: 'after' } }]);
    },
    (context) => context.entity === 'x_item' && context.operation === 'create',
  );
  let outcome = 'committed';
  try {
    await store.transact(() =>
      store.withOperationContext(() =>
        localOrganizationService(store, { ...profile, grants: [{ entity: 'x_item', operations: ['create'] }] }).create(
          'x_item',
          { x_name: 'trigger' },
        ),
      ),
    );
  } catch (error) {
    outcome = error.details?.innerCode ?? error.code;
  }
  return { fault, outcome, items: store.tableRows('x_item').length };
}
const log = (attributes, id = EMPTY) => ({ $type: 'Entity', logicalName: 'x_log', id, attributes });

test('a caught refused Create still fails the operation with 0x8009000c', async (t) => {
  const result = await caught(t, (call, users) => call(users.plain, 'Create', [log({ x_name: 'denied' })]));
  assert.equal(result.fault.errorCode, 0x80040220 | 0);
  assert.match(result.fault.message, /missing prvCreate/);
  assert.equal(result.outcome, '0x8009000c');
  assert.equal(result.items, 0);
});

test('a caught refused Update does not fail the operation', async (t) => {
  const result = await caught(t, (call, users) => call(users.plain, 'Update', [log({ x_name: 'denied' }, LOG)]));
  assert.equal(result.fault.errorCode, 0x80040220 | 0);
  assert.equal(result.outcome, 'committed');
  assert.equal(result.items, 1);
});

test('a caught Create with an unknown column faults 0x80041103 and does not fail the operation', async (t) => {
  const result = await caught(t, (call) => call(null, 'Create', [log({ x_name: 'unknown', x_doesnotexist: 'x' })]));
  assert.equal(result.fault.errorCode, 0x80041103 | 0);
  assert.equal(
    result.fault.message,
    "'x_log' entity doesn't contain attribute with Name = 'x_doesnotexist' and NameMapping = 'Logical' (look up attribute by name is case-sensitive).",
  );
  assert.equal(result.outcome, 'committed');
  assert.equal(result.items, 1);
});
