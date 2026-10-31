// Runner request contexts (plugin-async.mjs): an asynchronous step runs in a child of the request that wrote the row (the
// HTTP x-ms-correlation-request-id); its System Job row and plug-in trace log carry the CorrelationId of its execution context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import {
  pluginCatalogue,
  pluginHandlers,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesEntity,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { currentRequest } from '../lib/request-context.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const STEP = '5c0b0000-0000-4000-8000-000000000071';
const CORRELATION = '7a7a7a7a-0000-4000-8000-000000000071';
const step = {
  id: STEP,
  name: 'Invented asynchronous trace',
  entity: 'x_item',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  typeName: 'Invented.Plugins.Trace',
  typeId: '5c0b0000-0000-4000-8000-000000000072',
  assemblyId: '5c0b0000-0000-4000-8000-000000000073',
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
};

// @test-kind unproven: local model of the runner request context (currentRequest() of an asynchronous run); the job and trace correlationid follow the native-r2 asyncLoop and native traceFaults facts pinned in dataverse-plugin-jobs and plugin-step-faults
test('an asynchronous step runs in a child of the HTTP request, and its job and trace carry its context CorrelationId', async (t) => {
  const seen = [],
    contexts = [];
  const handlers = pluginHandlers([
    {
      id: 'invented',
      // A typed handler: its execution context reports the CorrelationId the asyncoperation row must carry.
      pluginTypes: {
        'Invented.Plugins.Trace': ({ context, trace }) => {
          seen.push(currentRequest());
          contexts.push(context.CorrelationId);
          trace('Invented async trace');
        },
      },
    },
  ]);
  const { store, request, json } = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [] },
    extension: { name: 'x-none', install() {} },
  });
  await store.transact(() => {
    store.tableRows('organization')[0].plugintracelogsetting = 2;
  });
  const items = () => pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: items(), handlers }),
    ({ entity, operation }) =>
      items().some(
        (item) =>
          item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation,
      ),
    (context) => pluginPhaseRequiresCheckpoint(items(), context),
  );
  const runner = createAsyncPluginRunner({ store, items, handlers, runtimes: new Map(), systemJobs: () => true });
  t.after(() => runner.close());

  await json(
    await request('POST', '/x_items', { x_name: 'Invented row' }, { 'x-ms-correlation-request-id': CORRELATION }),
    201,
  );
  await runner.drain();
  const [trace] = store.tableRows('plugintracelog');
  assert.equal(trace?.messageblock, 'Invented async trace');
  assert.equal(trace.mode, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].mode, 'async');
  assert.equal(seen[0].correlationId, CORRELATION);
  assert.equal(seen[0].parentId, CORRELATION);
  assert.equal(seen[0].inBatch, false);
  // The System Job row carries the CorrelationId its execution context reported.
  const [job] = store.tableRows('asyncoperation');
  assert.equal(contexts.length, 1);
  assert.equal(job.correlationid, contexts[0]);
  assert.equal(trace.correlationid, contexts[0]);
});
