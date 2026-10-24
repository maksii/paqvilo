import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importSolutionData } from '../lib/solution-data.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const FLOW = '77777777-7777-4777-8777-777777777777';
const files = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedFingerprint</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'Entities/x_item/Entity.xml':
    '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute></attributes></entity></EntityInfo></Entity>',
  [`Workflows/Flow-${FLOW}.json.data.xml`]: `<Workflow WorkflowId="{${FLOW}}" Name="Invented flow"><StateCode>1</StateCode></Workflow>`,
  [`Workflows/Flow-${FLOW}.json`]: '{"properties":{"definition":{"actions":{"a":1}}}}',
  'WebResources/x_/script.js': 'console.log(1)',
  'Notes/readme.txt': 'not imported',
};

async function solution(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-fingerprint-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'InventedFingerprint');
  const write = async (name, text) => {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  };
  for (const [name, text] of Object.entries(files)) await write(name, text);
  const fingerprint = async () => {
    const data = (await importSolutionData([dir])).contentFingerprint;
    assert.equal((await importSolutionData([dir])).schema.contentFingerprint, data);
    return { data, metadata: (await importSolutionMetadata([dir])).contentFingerprint };
  };
  return { root, dir, write, fingerprint };
}

test('changing a flow definition or a web resource changes the content fingerprint; an unrelated file does not', async (t) => {
  const { write, fingerprint } = await solution(t);
  const original = await fingerprint();
  await write('Notes/readme.txt', 'still not imported');
  assert.deepEqual(await fingerprint(), original);
  await write(`Workflows/Flow-${FLOW}.json`, '{"properties":{"definition":{"actions":{"a":2}}}}');
  const flow = await fingerprint();
  assert.notEqual(flow.data, original.data);
  assert.notEqual(flow.metadata, original.metadata);
  await write('WebResources/x_/script.js', 'console.log(2)');
  const resource = await fingerprint();
  assert.notEqual(resource.data, flow.data);
  assert.notEqual(resource.metadata, flow.metadata);
});

test('side files keep the content fingerprint relocatable, and a ZIP layer covers them too', async (t) => {
  const { root, dir, fingerprint } = await solution(t);
  const original = await fingerprint();
  const moved = path.join(root, 'relocated');
  await fs.cp(dir, moved, { recursive: true });
  assert.equal((await importSolutionData([moved])).contentFingerprint, original.data);

  const zip = (name) =>
    writeSolutionAssetEntries(
      Object.entries({ ...files, 'WebResources/x_/script.js': name }).map(([entry, text]) => ({
        name: entry,
        data: Buffer.from(text),
      })),
    );
  const archive = path.join(root, 'InventedFingerprint.zip');
  await fs.writeFile(archive, zip('console.log(1)'));
  const before = (await importSolutionData([archive])).contentFingerprint;
  await fs.writeFile(archive, zip('console.log(3)'));
  assert.notEqual((await importSolutionData([archive])).contentFingerprint, before);
});
