// @test-kind contract: every Power Pages host write of the operations map (PATCH /_sim/api/config, reset, state import) is refused and applied like PATCH /_sim/api/operations/<key> (mirage/docs/operations.md, Activation).
// An "When an action is performed" flow activated through /config subscribes its trigger host and runs when the action
// commits; an unknown or unavailable override through /config is refused with the per-operation route's answer and
// stores nothing; a reset unsubscribes the host and an imported state that activates the flow subscribes it again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const DV = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';
const USER = '77777777-7777-4777-8777-0000000000f1',
  ECHO = '77777777-7777-4777-8777-0000000000f2',
  PERFORMED = '77777777-7777-4777-8777-0000000000f3',
  MISSING = '77777777-7777-4777-8777-0000000000f4';
const workflow = (id, name, triggers, actions) => ({
  [`Workflows/${name}.json`]: JSON.stringify({ properties: { definition: { triggers, actions } } }),
  [`Workflows/${name}.json.data.xml`]: `<Workflow WorkflowId="{${id}}" Name="${name}" Category="5" StateCode="1" JsonFileName="/Workflows/${name}.json" />`,
});
const connector = (operationId, parameters) => ({ host: { apiId: DV, operationId }, parameters });

async function simulator(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'config-operations-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedConfig</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/customapis/x_Echo/customapi.xml':
      '<customapi uniquename="x_Echo"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Echo</name></customapi>',
    ...Object.fromEntries(
      Object.entries({
        ...workflow(
          ECHO,
          'Echo',
          { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
          {
            Act: {
              type: 'OpenApiConnection',
              runAfter: {},
              inputs: connector('PerformUnboundAction', { actionName: 'x_Echo' }),
            },
          },
        ),
        ...workflow(
          PERFORMED,
          'Performed',
          {
            performed: {
              type: 'OpenApiConnectionWebhook',
              inputs: connector('BusinessEventsTrigger', { entityname: 'none', sdkmessagename: 'x_Echo' }),
            },
          },
          { Note: { type: 'Compose', runAfter: {}, inputs: 'performed' } },
        ),
      }).map(([name, text]) => ['solution/' + name, text]),
    ),
    'portal/website.yml': 'adx_websiteid: 77777777-7777-4777-8777-0000000000f5\nadx_name: Invented config',
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  const grants = [{ message: 'x_Echo', operations: ['execute'] }];
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    packs: [
      {
        id: 'fx-config-operations',
        name: 'Invented',
        description: 'Invented',
        matches: () => true,
        presets: () => ({}),
        flowIdentities: Object.fromEntries(
          [ECHO, PERFORMED].map((id) => [id, { userId: USER, evidence: 'Invented', grants }]),
        ),
        customApis: { x_Echo: async () => ({ outputs: {} }) },
      },
    ],
    initial: {
      version: 1,
      simulator: { mode: 'local', pageMode: 'local', identity: { roles: [] }, endpoints: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
      tables: { systemuser: [{ systemuserid: USER, fullname: 'Invented owner', isdisabled: false }] },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const api = async (method, suffix, body) => {
    const response = await fetch(sim.url + '/_sim/api' + suffix, {
      method,
      headers: { 'x-sim-csrf': sim.csrf, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const host = async () => (await api('GET', '/flow-triggers')).body.find((item) => item.processId === PERFORMED);
  return { sim, api, host };
}

const enabled = { mode: 'exported', activation: 'local-enabled' };

test('an operations map through /config subscribes the action trigger host and the committed action starts a run', async (t) => {
  const { sim, api, host } = await simulator(t);
  assert.equal((await host())?.state, 'inactive');
  const answer = await api('PATCH', '/config', {
    operations: { [`cloud-flow:${ECHO}`]: enabled, [`cloud-flow:${PERFORMED}`]: enabled },
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal((await host()).state, 'subscribed');
  assert.deepEqual(sim.store.state.simulator.operations[`cloud-flow:${PERFORMED}`], enabled);
  assert.equal((await api('POST', '/flow-runs', { processId: ECHO, input: {} })).status, 201);
  await sim.settle();
  const runs = (await api('GET', '/flow-runs')).body;
  const performed = (runs.items ?? runs).filter((run) => run.processId === PERFORMED);
  assert.deepEqual(
    performed.map((run) => [run.status, run.triggertype]),
    [['Succeeded', 'Automated']],
  );
});

test('an override the per-operation route refuses is refused through /config and stores nothing', async (t) => {
  const { sim, api, host } = await simulator(t);
  const unknown = await api('PATCH', '/config', { operations: { [`cloud-flow:${MISSING}`]: enabled } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.message, 'This operation is not in the current source exports.');
  const handler = await api('PATCH', '/config', { operations: { [`cloud-flow:${PERFORMED}`]: { mode: 'handler' } } });
  assert.equal(handler.status, 409);
  assert.equal(handler.body.error.message, 'No trusted project handler is registered for this operation.');
  const perOperation = await api('PATCH', `/operations/${encodeURIComponent(`cloud-flow:${PERFORMED}`)}`, {
    mode: 'handler',
  });
  assert.deepEqual(
    [perOperation.status, perOperation.body.error.message],
    [handler.status, handler.body.error.message],
  );
  assert.equal(sim.store.state.simulator.operations, undefined);
  assert.equal((await host()).state, 'inactive');
});

test('a reset drops the activation and an imported state restores it: the trigger host follows both', async (t) => {
  const { sim, api, host } = await simulator(t);
  assert.equal((await api('PATCH', '/config', { operations: { [`cloud-flow:${PERFORMED}`]: enabled } })).status, 200);
  const saved = structuredClone(sim.store.state);
  assert.equal((await host()).state, 'subscribed');
  assert.equal((await api('POST', '/reset')).status, 200);
  assert.equal((await host()).state, 'inactive');
  const imported = await api('POST', '/state/import', saved);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal((await host()).state, 'subscribed');
});
