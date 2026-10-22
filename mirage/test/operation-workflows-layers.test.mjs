import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importOperationWorkflows } from '../lib/exported-operations.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const FLOW = '77777777-7777-4777-8777-777777777781';
// A lower-case workflows folder: exported Solutions differ in folder case, and ZIP entry names are case-sensitive.
const files = {
  'Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedOperationLayers</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'workflows/Invented-flow.json': '{"properties":{"definition":{"actions":{}}}}',
  'workflows/Invented-flow.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="Invented flow" StateCode="1" />`,
};

test('operation workflows are read from a lower-case Workflows folder in a directory and in a Solution ZIP layer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'operation-layers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'solution'), zip = path.join(root, 'solution.zip');
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  await fs.writeFile(zip, writeSolutionAssetEntries(Object.entries(files).map(([name, text]) => ({ name, data: Buffer.from(text) }))));
  for (const layer of [{ dir }, { dir: zip, type: 'zip' }]) {
    const workflows = await importOperationWorkflows([layer]);
    const flow = workflows.get(FLOW);
    assert.ok(flow, layer.type ?? 'directory');
    assert.equal(flow.name, 'Invented flow');
    assert.equal(flow.active, true);
    assert.deepEqual(flow.definition, { properties: { definition: { actions: {} } } });
    assert.equal(flow.file, path.join(layer.dir, 'workflows', 'Invented-flow.json'));
  }
});
