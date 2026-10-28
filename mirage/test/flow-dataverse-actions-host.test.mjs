// Through a running host: a flow's Dataverse connector PerformUnboundAction and PerformBoundAction run a pack
// custom API inside the run's change slot (the run owns it, so the handler joins its transaction instead of waiting on
// it), as the flow profile's systemuser with an execute grant naming the message.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const UNBOUND = '77777777-7777-4777-8777-0000000000d1',
  BOUND = '77777777-7777-4777-8777-0000000000d2';
const USER = '77777777-7777-4777-8777-0000000000d3',
  WIDGET = '77777777-7777-4777-8777-0000000000d4',
  NOBODY = '77777777-7777-4777-8777-0000000000d5';
const DV = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';
const button = { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } };
const flowFiles = (id, name, action) => ({
  [`Workflows/${name}.json`]: JSON.stringify({
    properties: {
      definition: {
        triggers: button,
        actions: {
          Act: {
            type: 'OpenApiConnection',
            runAfter: {},
            inputs: { host: { apiId: DV, operationId: action.operationId }, parameters: action.parameters },
          },
          Reply: {
            type: 'Response',
            runAfter: { Act: ['Succeeded', 'Failed'] },
            inputs: { statusCode: 200, body: { status: "@actions('Act')['status']", outputs: "@outputs('Act')" } },
          },
        },
      },
    },
  }),
  [`Workflows/${name}.json.data.xml`]: `<Workflow WorkflowId="{${id}}" Name="${name}" Category="5" OnDemand="1" StateCode="1" JsonFileName="/Workflows/${name}.json" />`,
});
const customApi = (name, bound) => ({
  [`customapis/${name}/customapi.xml`]: `<customapi uniquename="${name}"><bindingtype>${bound ? 1 : 0}</bindingtype>${bound ? '<boundentitylogicalname>x_widget</boundentitylogicalname>' : ''}<isfunction>0</isfunction><name>${name}</name></customapi>`,
  [`customapis/${name}/customapirequestparameters/${name}.Text/customapirequestparameter.xml`]: `<customapirequestparameter uniquename="Text"><name>${name}.Text</name><type>10</type><isoptional>0</isoptional></customapirequestparameter>`,
  [`customapis/${name}/customapiresponseproperties/${name}.Result/customapiresponseproperty.xml`]: `<customapiresponseproperty uniquename="Result"><name>${name}.Result</name><type>10</type></customapiresponseproperty>`,
});
const files = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedFlowActions</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  ...customApi('x_Echo', false),
  ...customApi('x_Close', true),
  ...flowFiles(UNBOUND, 'Unbound', {
    operationId: 'PerformUnboundAction',
    parameters: { actionName: 'x_Echo', 'item/Text': 'hi' },
  }),
  ...flowFiles(BOUND, 'Bound', {
    operationId: 'PerformBoundAction',
    parameters: { entityName: 'x_widgets', recordId: WIDGET, actionName: 'x_Close', 'item/Text': 'bye' },
  }),
};

async function host(t, profile) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'flow-dv-actions-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (dir, entries) => {
    for (const [name, text] of Object.entries(entries)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await fs.writeFile(path.join(dir, name), text);
    }
  };
  await write(path.join(root, 'solution'), files);
  await write(path.join(root, 'portal'), {
    'website.yml': 'adx_websiteid: 77777777-7777-4777-8777-0000000000d6\nadx_name: Invented actions',
  });
  const pack = {
    id: 'fx-flow-actions',
    name: 'Invented',
    description: 'Invented',
    matches: () => true,
    presets: () => ({}),
    flowIdentities: { [UNBOUND]: profile, [BOUND]: profile },
    customApis: {
      x_Echo: async (ctx) => ({ outputs: { Result: 'echo:' + ctx.inputs.Text } }),
      x_Close: async (ctx) => ({ outputs: { Result: 'close:' + ctx.inputs.Text } }),
    },
  };
  const sim = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    packs: [pack],
    initial: {
      version: 1,
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
      tables: {
        x_widget: [{ x_widgetid: WIDGET, x_name: 'Invented widget' }],
        systemuser: [
          { systemuserid: USER, fullname: 'Invented flow owner', domainname: 'owner@example.test', isdisabled: false },
        ],
      },
      mappings: {
        x_widget: { entitySet: 'x_widgets', idColumn: 'x_widgetid', fields: { x_name: { type: 'string' } } },
      },
    },
  });
  ownedFixture(t).add(() => sim.close());
  const call = async (method, suffix, payload) => {
    const response = await fetch(sim.url + '/_sim/api' + suffix, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify(payload),
    });
    return { status: response.status, body: await response.json() };
  };
  for (const id of [UNBOUND, BOUND])
    assert.equal(
      (await call('PATCH', '/operations/' + encodeURIComponent('cloud-flow:' + id), { mode: 'exported' })).status,
      200,
    );
  return { run: (processId) => call('POST', '/flow-runs', { processId }) };
}

const owner = (grants) => ({ userId: USER, evidence: 'Invented flow owner', grants });

test(
  'PerformUnboundAction and PerformBoundAction run a pack custom API inside the flow run and answer its response',
  { timeout: 30000 },
  async (t) => {
    const { run } = await host(
      t,
      owner([
        { entity: 'x_widget', operations: ['read'] },
        { message: 'x_Echo', operations: ['execute'] },
        { message: 'x_Close', operations: ['execute'] },
      ]),
    );
    const unbound = await run(UNBOUND);
    assert.equal(unbound.status, 201, JSON.stringify(unbound.body));
    assert.deepEqual(unbound.body.response.body, {
      status: 'Succeeded',
      outputs: { statusCode: 200, body: { Result: 'echo:hi' } },
    });
    const bound = await run(BOUND);
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    assert.deepEqual(bound.body.response.body, {
      status: 'Succeeded',
      outputs: { statusCode: 200, body: { Result: 'close:bye' } },
    });
  },
);

test(
  'without an execute grant, or with a profile user that is no systemuser, the action fails 403 and never runs as SYSTEM',
  { timeout: 30000 },
  async (t) => {
    const { run } = await host(t, owner([{ entity: 'x_widget', operations: ['read'] }]));
    const denied = await run(UNBOUND);
    assert.equal(denied.body.response.body.status, 'Failed');
    assert.equal(denied.body.response.body.outputs.error.code, 'LocalBackendPermissionDenied');
    const { run: runAsNobody } = await host(t, {
      userId: NOBODY,
      evidence: 'Invented',
      grants: [{ message: 'x_Echo', operations: ['execute'] }],
    });
    const nobody = await runAsNobody(UNBOUND);
    assert.equal(nobody.body.response.body.outputs.error.code, 'LocalBackendIdentityRequired');
  },
);
