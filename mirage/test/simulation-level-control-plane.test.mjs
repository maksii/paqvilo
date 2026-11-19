// @test-kind contract: the simulation-level control plane keeps flow activation, deployment-profile switches and preset applies private runtime state on the Power Pages host.
// At level `simulation` the control plane is private runtime state: flow activation (PATCH /_sim/api/operations/<key>),
// a deployment-profile switch and a preset apply work on the Power Pages host with a pack DATA file that owns only the
// business table. Workflow definitions keep their exported activation across state replacements, and a preset that
// replaces an organization table keeps the Solution's rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ITEM_ENTITY, startPackSimulator } from './support/simulation-pack-fixture.mjs';
import { SCENARIO_HANG_GUARD_MS } from '../../test/helpers/bounded-command.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000f1',
  PACK_API = '77777777-7777-4777-8777-0000000000f2';
const DEF = {
  properties: {
    definition: {
      triggers: { manual: { type: 'Request', kind: 'Button', inputs: {} } },
      actions: { Note: { type: 'Compose', runAfter: {}, inputs: 'ok' } },
    },
  },
};
const PACK = `const api = { customapiid: '${PACK_API}', uniquename: 'x_PackApi', name: 'x_PackApi', bindingtype: 0, isfunction: false };
const tables = rows => ({ x_item: rows, customapi: [api] });
export default { id: 'fx-control', name: 'Invented', description: 'Invented', matches: () => true,
  presets: () => ({ seed: { name: 'Seed', description: 'One item', load: () => ({ tables: tables([{ x_itemid: '77777777-7777-4777-8777-0000000000a1', x_name: 'one' }]) }) },
    busy: { name: 'Busy', description: 'Two items', load: () => ({ tables: tables([{ x_itemid: '77777777-7777-4777-8777-0000000000a1', x_name: 'one' }, { x_itemid: '77777777-7777-4777-8777-0000000000a2', x_name: 'two' }]) }) } }),
  dataFiles: [{ file: 'data.json', tables: { x_item: { path: ['items'], idColumn: 'x_itemid' } } }] };`;

// Hang guard only: a Power Pages host start with a flow activation, a profile switch and a preset apply, each a reload.
test(
  'flow activation, a deployment-profile switch and a preset apply work at level simulation on the Power Pages host',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const files = {
      'solution/Entities/x_item/Entity.xml': ITEM_ENTITY,
      'solution/customapis/x_Notify/customapi.xml':
        '<customapi uniquename="x_Notify"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Notify</name></customapi>',
      'solution/Workflows/manual.json': JSON.stringify(DEF),
      'solution/Workflows/manual.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented manual flow"><Category>5</Category><StateCode>1</StateCode></Workflow>`,
      'pack/data.json': JSON.stringify({ items: [] }),
      'pack/pack.mjs': PACK,
    };
    const { sim, fixture } = await startPackSimulator(t, files, {
      simulation: { level: 'simulation' },
      preset: 'seed',
      dataverse: { enabled: true, port: 0, tls: false, tds: { enabled: false } },
    });
    const call = async (method, suffix, payload) => {
      const response = await fetch(sim.url + '/_sim/api' + suffix, {
        method,
        headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return { status: response.status, body: await response.text() };
    };
    const definition = () =>
      sim.store.tableRows('workflow').find((row) => String(row.workflowid).toLowerCase() === FLOW);
    assert.equal(Number(definition().statecode), 1, 'the exported flow is activated');

    const activation = await call('PATCH', '/operations/' + encodeURIComponent(`cloud-flow:${FLOW}`), {
      mode: 'exported',
      activation: 'local-enabled',
    });
    assert.equal(activation.status, 200, activation.body);
    assert.equal(
      Number(definition().statecode),
      1,
      'a state replacement keeps the activated definition (no Draft source row over it)',
    );
    assert.ok(definition().workflowidunique, 'the definition keeps its seeded columns');

    const profile = await call('PUT', '/environment/profiles', { profile: 'test', enabled: {} });
    assert.equal(profile.status, 200, profile.body);
    assert.equal(sim.store.state.simulator.deploymentProfilePin?.profile, 'test');

    const preset = await call('POST', '/presets/busy/apply', {});
    assert.equal(preset.status, 200, preset.body);
    const apis = sim.store
      .tableRows('customapi')
      .map((row) => row.uniquename)
      .sort();
    assert.deepEqual(apis, ['x_Notify', 'x_PackApi'], 'the preset keeps the Solution custom API beside its own');
    assert.equal(
      JSON.parse(await fs.readFile(path.join(fixture.root, 'pack', 'data.json'), 'utf8')).items.length,
      2,
      'business rows go to the DATA file',
    );
    const state = JSON.parse(await fs.readFile(fixture.stateFile, 'utf8'));
    assert.equal(
      state.simulator.operations[`cloud-flow:${FLOW}`].activation,
      'local-enabled',
      'the activation choice is private runtime state',
    );
    assert.equal(state.simulator.deploymentProfilePin?.profile, 'test', 'the profile pin is private runtime state');
  },
);
