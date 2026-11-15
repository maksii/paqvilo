// @test-kind unproven: dataverse-plugins.md documents that a Delete's PreOperation and PostOperation run as SYSTEM, with no native replay case; this file checks that JavaScript handler and web hook contexts report the same identity as the CLR context
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { remoteExecutionContext } from '../lib/dataverse-webhooks.mjs';

const caller = '10000000-0000-0000-0000-000000000001',
  system = '10000000-0000-0000-0000-000000000002',
  widget = '20000000-0000-0000-0000-000000000001';
const identity = { id: caller, systemUserId: caller, admin: true };
const stepIdOf = (stage) => `30000000-0000-0000-0000-0000000000${stage}`;

const fixture = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid' },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        x_widget: [{ x_widgetid: widget, x_name: 'existing' }],
        systemuser: [
          { systemuserid: caller, fullname: 'Invented caller' },
          { systemuserid: system, fullname: 'SYSTEM' },
        ],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });

test('a Delete reports SYSTEM as UserId from PreOperation on, on JavaScript handlers and web hooks alike', async () => {
  const store = fixture();
  const stages = [10, 20, 40];
  const steps = stages.map((stage) => ({
    id: stepIdOf(stage),
    name: `Invented delete observer ${stage}`,
    entity: 'x_widget',
    message: 'Delete',
    enabled: true,
    stage,
    mode: 0,
    rank: 1,
    typeName: `Invented.DeleteObserver${stage}`,
    assemblyId: 'invented',
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
  }));
  const seen = [];
  const handlers = new Map(
    stages.map((stage) => [
      `Invented.DeleteObserver${stage}`,
      ({ context }) => {
        seen.push({ stage, user: context.UserId, initiating: context.InitiatingUserId });
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  await store.remove('x_widget', widget, identity);
  assert.deepEqual(seen, [
    { stage: 10, user: caller, initiating: caller },
    { stage: 20, user: system, initiating: caller },
    { stage: 40, user: system, initiating: caller },
  ]);

  for (const stage of [20, 40]) {
    const context = remoteExecutionContext(store, {
      item: { id: stepIdOf(stage), images: [] },
      entity: 'x_widget',
      operation: 'delete',
      stage,
      record: { x_widgetid: widget },
      identity,
      depth: 1,
    });
    assert.equal(context.UserId, system, `web hook at stage ${stage}`);
    assert.equal(context.InitiatingUserId, caller, `web hook at stage ${stage}`);
  }
});
