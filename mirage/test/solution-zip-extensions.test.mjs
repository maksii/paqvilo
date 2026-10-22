import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { readSolutionWorkflows } from '../lib/dataverse-workflows.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { importSolutionData } from '../lib/solution-data.mjs';

const CLASSIC = '77777777-7777-4777-8777-777777777771';
const FLOW = '77777777-7777-4777-8777-777777777772';
const files = {
  'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedZipExtensions</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'customapis/x_Echo/customapi.xml': '<customapi uniquename="x_Echo"><bindingtype>0</bindingtype><isfunction>0</isfunction><name>x_Echo</name></customapi>',
  'customapis/x_Echo/customapirequestparameters/x_Echo.Text/customapirequestparameter.xml': '<customapirequestparameter uniquename="Text"><name>x_Echo.Text</name><type>10</type><isoptional>0</isoptional></customapirequestparameter>',
  'customapis/x_Echo/customapiresponseproperties/x_Echo.Result/customapiresponseproperty.xml': '<customapiresponseproperty uniquename="Result"><name>x_Echo.Result</name><type>10</type></customapiresponseproperty>',
  'duplicaterules/x_rule/duplicaterule.xml': '<duplicaterule uniquename="x_rule"><baseentityname>x_item</baseentityname><matchingentityname>x_item</matchingentityname><name>Invented item rule</name><duplicaterulecondition><baseattributename>x_code</baseattributename><matchingattributename>x_code</matchingattributename><operatorcode>0</operatorcode></duplicaterulecondition></duplicaterule>',
  'Workflows/Invented-classic.xaml': '<Activity />',
  'Workflows/Invented-classic.xaml.data.xml': `<Workflow WorkflowId="{${CLASSIC}}" Name="Invented classic" Category="0" OnDemand="1" PrimaryEntity="x_item" StateCode="1" XamlFileName="/Workflows/Invented-classic.xaml" />`,
  'Workflows/Invented-flow.json': '{"properties":{"definition":{"actions":{}}}}',
  'Workflows/Invented-flow.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented flow" Category="5" OnDemand="1" StateCode="Activated" JsonFileName="Invented-flow.json" />`,
};

async function writeTree(dir, entries) {
  for (const [name, text] of Object.entries(entries)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
}

async function inventory(t, layers) {
  const store = await new DataStore({ state: emptyState() }).init();
  const core = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: false }), extensions: await sourceOrganizationExtensions({ layers }) });
  t.after(() => core.close());
  const sorted = (logical, column) => (store.state.tables[logical] ?? []).map(row => row[column]).sort();
  return {
    customapi: sorted('customapi', 'uniquename'),
    customapirequestparameter: sorted('customapirequestparameter', 'name'),
    customapiresponseproperty: sorted('customapiresponseproperty', 'name'),
    duplicaterule: sorted('duplicaterule', 'name'),
    duplicaterulecondition: sorted('duplicaterulecondition', 'baseattributename'),
    workflow: sorted('workflow', 'name'),
  };
}

test('a Solution ZIP layer yields the same custom APIs, duplicate rules and workflows as its unpacked directory', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-zip-extensions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'InventedZipExtensions');
  await writeTree(dir, files);
  const zip = path.join(root, 'InventedZipExtensions.zip');
  await fs.writeFile(zip, writeSolutionAssetEntries(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) }))));

  const dirLayers = (await importSolutionData([dir])).layers;
  const zipLayers = (await importSolutionData([zip])).layers;
  assert.equal(zipLayers[0].type, 'zip');

  const facts = await readSolutionWorkflows(dirLayers);
  assert.deepEqual(facts.map(fact => [fact.id, fact.xaml, fact.clientdata]).sort(), [
    [CLASSIC, '<Activity />', null], [FLOW, null, files['Workflows/Invented-flow.json']]].sort());
  assert.deepEqual(await readSolutionWorkflows(zipLayers), facts);

  const expected = await inventory(t, dirLayers);
  assert.deepEqual(expected.customapi, ['x_Echo']);
  assert.deepEqual(expected.customapirequestparameter, ['x_Echo.Text']);
  assert.deepEqual(expected.customapiresponseproperty, ['x_Echo.Result']);
  assert.deepEqual(expected.duplicaterule, ['Invented item rule']);
  assert.deepEqual(expected.duplicaterulecondition, ['x_code']);
  assert.ok(expected.workflow.includes('Invented classic') && expected.workflow.includes('Invented flow'));
  assert.deepEqual(await inventory(t, zipLayers), expected);
});

test('a lower-case workflows folder is read', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-zip-extensions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeTree(root, Object.fromEntries(Object.entries(files)
    .filter(([name]) => name.startsWith('Workflows/')).map(([name, text]) => [name.replace('Workflows/', 'workflows/'), text])));
  const facts = await readSolutionWorkflows([{ dir: root, type: 'directory' }]);
  assert.deepEqual(facts.map(fact => fact.id).sort(), [CLASSIC, FLOW]);
  assert.equal(facts.find(fact => fact.id === FLOW).clientdata, files['Workflows/Invented-flow.json']);
});

test('an unreadable Solution ZIP layer reports a diagnostic instead of contributing nothing silently', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-zip-extensions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const zip = path.join(root, 'InventedBroken.zip');
  await fs.writeFile(zip, 'not a zip archive');
  const diagnostics = [];
  await sourceOrganizationExtensions({ layers: [{ dir: zip, type: 'zip' }], diagnostic: entry => diagnostics.push(entry) });
  assert.ok(diagnostics.length >= 1);
  assert.ok(diagnostics.every(entry => entry.code === 'SOLUTION_LAYER_COMPONENTS_UNREADABLE'));
});
