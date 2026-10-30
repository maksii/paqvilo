// @test-kind parity: native dataverse-recorder faults.json: a plug-in's ordinary exception during Update PreOperation answered 400 0x80040224 with the authored message
// Invented schema and step-id handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue, pluginHandlers, runPluginPhase } from '../lib/exported-plugins.mjs';
import { recordPluginTrace } from '../lib/plugin-trace.mjs';

const STEP = '60000000-0000-4000-8000-000000000001';

function storeWith(handler) {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: '60000000-0000-4000-8000-000000000002', x_name: 'before' }];
  const store = new DataStore({ state }),
    handlers = pluginHandlers([{ id: 'invented', pluginSteps: { [STEP]: handler } }]),
    items = pluginCatalogue({
      plugins: {
        steps: [
          {
            id: STEP,
            enabled: true,
            name: 'Invented Update pre',
            entity: 'x_item',
            message: 'Update',
            stage: 20,
            mode: 0,
            rank: 1,
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
            typeName: 'Invented.UpdatePre',
            assemblyId: 'invented',
          },
        ],
      },
      handlers,
    });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  return store;
}

test('an ordinary exception from a step handler is the unhandled plug-in fault with its message', async () => {
  const store = storeWith(() => {
    throw new Error('ordinary');
  });
  await assert.rejects(
    store.update('x_item', '60000000-0000-4000-8000-000000000002', { x_name: 'after' }, { admin: true }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.innerCode, '0x80040224');
      assert.equal(error.message, 'ordinary');
      return true;
    },
  );
  assert.equal(store.tableRows('x_item')[0].x_name, 'before');
});

// @test-kind contract: a step-id handler declares an InvalidPluginExecutionException the way a custom API handler does ({ pluginFault }); Learn: 0x80040265 IsvAborted
test('a step handler fault marked InvalidPluginExecutionException keeps 0x80040265', async () => {
  const store = storeWith(() => {
    throw { pluginFault: 'InvalidPluginExecutionException', message: 'declared refusal' };
  });
  await assert.rejects(
    store.update('x_item', '60000000-0000-4000-8000-000000000002', { x_name: 'after' }, { admin: true }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.innerCode, '0x80040265');
      assert.equal(error.message, 'declared refusal');
      return true;
    },
  );
});

// @test-kind parity: native traceFaults (two captures): plugintracelog messageblock keeps the first 10240 characters, and a plug-in fault's exceptiondetails name the OrganizationServiceFault with the authored message
test('a plug-in trace row keeps 10240 characters and names the fault it surfaced as', () => {
  const state = emptyState();
  state.mappings.plugintracelog = {
    logicalName: 'plugintracelog',
    entitySet: 'plugintracelogs',
    idColumn: 'plugintracelogid',
  };
  state.tables.plugintracelog = [];
  state.tables.organization = [{ organizationid: '60000000-0000-4000-8000-000000000009', plugintracelogsetting: 2 }];
  const store = new DataStore({ state });
  recordPluginTrace(store, {
    typeName: 'Invented.Trace',
    stepId: STEP,
    messageName: 'Update',
    entity: 'x_item',
    depth: 1,
    traces: ['x'.repeat(12_000)],
    started: performance.now(),
    startedAt: new Date(0).toISOString(),
    error: Object.assign(new Error('Invented coded fault'), { details: { innerCode: '0x80040265' } }),
  });
  const [row] = store.tableRows('plugintracelog');
  assert.equal(row.messageblock.length, 10240);
  assert.equal(
    row.exceptiondetails,
    'System.ServiceModel.FaultException`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]: Invented coded fault',
  );
});
