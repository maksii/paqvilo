// Task 49: a modern flow of a YAML source-control repository (modernflows/) normalises into the same executable definition as
// the JSON client data: trigger, actions, expressions and connection references run end to end. Invented repository, pack
// connector and loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { importOperationWorkflows } from '../lib/exported-operations.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000f9';
const FLOW_YAML = `workflowid: ${FLOW}
name: Invented YAML flow
statecode: 1
clientdata:
  properties:
    connectionReferences:
      x_api:
        connection:
          connectionReferenceLogicalName: x_yamlref
    definition:
      triggers:
        manual:
          type: Request
          kind: Button
          inputs:
            schema:
              type: object
              properties:
                x_name:
                  type: string
      actions:
        Count:
          type: InitializeVariable
          runAfter: {}
          inputs:
            variables:
              - name: n
                type: integer
                value: 41
        Bump:
          type: IncrementVariable
          runAfter:
            Count: [Succeeded]
          inputs:
            name: n
            value: 1
        Lookup:
          type: OpenApiConnection
          runAfter:
            Bump: [Succeeded]
          inputs:
            host:
              apiId: /providers/Microsoft.PowerApps/apis/shared_fxyaml
              operationId: Greet
              connectionName: x_api
            parameters:
              name: "@triggerBody()?['x_name']"
        Reply:
          type: Response
          runAfter:
            Lookup: [Succeeded]
          inputs:
            statusCode: 200
            body:
              greeting: "@body('Lookup')?['text']"
              count: "@variables('n')"
              text: "Hello @{triggerBody()?['x_name']}"
`;

test('a YAML modern flow imports into the flow interpreter and runs end to end', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-modern-yaml-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solutions/InventedYaml/solution.yml': 'SolutionManifest:\n  UniqueName: InventedYaml\n  Version: 1.0.0.0\n',
    'solutions/InventedYaml/solutioncomponents.yml': ['modernflows/x_yamlflow', 'connectionreferences/x_yamlref', 'entities/x_item'].map(entry => `- Path: ${entry}\n`).join(''),
    'publishers/InventedPublisher/publisher.yml': 'Publisher:\n  UniqueName: inventedpublisher\n  CustomizationPrefix: x\n',
    'modernflows/x_yamlflow/x_yamlflow.yml': FLOW_YAML,
    'connectionreferences/x_yamlref/connectionreference.yml': 'connectionreferencelogicalname: x_yamlref\nconnectorid: /providers/Microsoft.PowerApps/apis/shared_fxyaml\n',
    'entities/x_item/entity.yml': 'Name: x_item\n',
  };
  for (const [name, text] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), text); }
  const scan = await scanSolutionSources([root]);
  const record = scan.inventory.find(item => item.component === 'modernflow');
  assert.deepEqual([record.name, record.level, record.reason], ['x_yamlflow', 'behaviour', 'MODERNFLOW_YAML_IMPORTED']);

  const workflows = await importOperationWorkflows(scan.layers);
  const workflow = workflows.get(FLOW);
  assert.ok(workflow, 'the modern flow is a workflow entry');
  assert.deepEqual([workflow.name, workflow.active, workflow.format], ['Invented YAML flow', true, 'yaml']);
  assert.deepEqual(workflow.definition.properties.connectionReferences, { x_api: { connection: { connectionReferenceLogicalName: 'x_yamlref' } } });

  // The connection reference binds a project connection served by an invented pack connector.
  const store = await new DataStore({ state: { ...emptyState(), tables: { connectionreference: [{ connectionreferencelogicalname: 'x_yamlref', connectionid: 'conn-yaml' }] } } }).init();
  const pack = { id: 'x-pack', connectors: { shared_fxyaml: { operations: { Greet: request => ({ statusCode: 200, body: { text: 'hi ' + request.parameters.name } }) } } } };
  const connectors = createConnectorRuntime({ store, packs: [pack], connections: { 'conn-yaml': { connector: 'shared_fxyaml', provider: 'pack:x-pack' } } });
  const [item] = operationCatalogue({ portal: {}, workflows, handlers: {}, overrides: {}, connectors });
  assert.equal(item.contract.supported, true, item.contract.errors?.join(' '));
  const answer = await executeFlowDefinition({ definition: workflow.definition.properties.definition, input: { x_name: 'invented' }, store, connectors,
    connectionReferences: workflow.definition.properties.connectionReferences });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.greeting, 'hi invented');
  assert.equal(String(answer.body.count.value ?? answer.body.count), '42');
  assert.equal(answer.body.text, 'Hello invented');
});

// RC4b-06: a modernflows/ file that does not parse (an unquoted @ expression is invalid YAML) is never skipped silently: its
// inventory record and the workflow import name MODERNFLOW_YAML_INVALID with the file and the parser's line.
test('a modernflows file that does not parse reports MODERNFLOW_YAML_INVALID with the file and line', async () => {
  const { inventoryEntry, mergeInventory } = await import('../lib/solution-inventory.mjs');
  const { modernFlowWorkflows } = await import('../lib/flow-yaml.mjs');
  const text = `workflowid: ${FLOW}\nclientdata:\n  properties:\n    definition:\n      triggers:\n        manual: { type: Request, kind: Button }\n      actions:\n        reply: { type: Response, inputs: { statusCode: 200, body: @add(1,2) } }\n`;
  const [record] = mergeInventory(inventoryEntry('modernflows/invented/flow.yml', { size: text.length, text, component: 'modernflow', componentName: 'invented' }));
  assert.equal(record.level, 'inventory');
  assert.deepEqual(record.diagnostics.map(d => [d.code, d.severity, d.file, d.line]), [['MODERNFLOW_YAML_INVALID', 'error', 'modernflows/invented/flow.yml', 8]]);
  assert.match(record.diagnostics[0].message, /modernflows\/invented\/flow\.yml line 8 does not parse/);
  const seen = [];
  const entries = modernFlowWorkflows([{ path: '/x/modernflows/invented/flow.yml', relative: 'modernflows/invented/flow.yml' }], () => text, { diagnostic: d => seen.push(d) });
  assert.equal(entries.size, 0);
  assert.deepEqual(seen.map(d => [d.code, d.file, d.line]), [['MODERNFLOW_YAML_INVALID', 'modernflows/invented/flow.yml', 8]]);
});
