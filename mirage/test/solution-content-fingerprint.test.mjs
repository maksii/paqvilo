import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { importSolutionData, applySolutionData } from '../lib/solution-data.mjs';
import { emptyState } from '../lib/data.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import {
  solutionContentFingerprint,
  solutionContentPath,
  solutionLayerFiles,
} from '../lib/solution-content-fingerprint.mjs';

const xml = (name) =>
  `<ImportExportXml><Entities><Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute><LogicalName>sample_itemid</LogicalName><Type>primarykey</Type></attribute><attribute><LogicalName>${name}</LogicalName><Type>nvarchar</Type></attribute></attributes><EntitySetName>sample_items</EntitySetName></entity></EntityInfo></Entity></Entities></ImportExportXml>`;

test('legacy and source-free metadata omit an unavailable content fingerprint through JSON persistence', async () => {
  const metadata = await importSolutionData([]);
  delete metadata.contentFingerprint;
  const state = applySolutionData(emptyState(), metadata);
  assert.equal(Object.hasOwn(state.simulator.solutionData, 'contentFingerprint'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.simulator.solutionData)), state.simulator.solutionData);
});

test('public content fingerprints survive relocation while physical cache identities remain distinct', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-content-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const left = path.join(root, 'original'),
    right = path.join(root, 'relocated-and-renamed');
  await fs.mkdir(path.join(left, 'Other'), { recursive: true });
  await fs.writeFile(path.join(left, 'Other', 'Customizations.xml'), xml('name'));
  await fs.cp(left, right, { recursive: true });
  const a = await importSolutionData([left]),
    b = await importSolutionData([right]);
  assert.equal(a.contentFingerprint, b.contentFingerprint);
  assert.equal(a.schema.contentFingerprint, a.contentFingerprint);
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal(
    (await importSolutionMetadata([left])).contentFingerprint,
    (await importSolutionMetadata([right])).contentFingerprint,
  );
  await fs.writeFile(path.join(right, 'Other', 'Customizations.xml'), xml('changed'));
  assert.notEqual(a.contentFingerprint, (await importSolutionData([right])).contentFingerprint);
});

test('content identity uses relative filenames, logical layer identities and selected order across path separators', () => {
  const layer = (dir, name, hash) => ({
    dir,
    solution: { uniqueName: name, version: '1' },
    documents: [{ file: `${dir}/Entities/item/Entity.xml`, hash }],
  });
  const a = layer('C:\\old\\solution', 'core', 'a'),
    relocated = layer('/new/solution', 'core', 'a'),
    b = layer('/other', 'patch', 'b');
  assert.equal(solutionContentFingerprint([a]), solutionContentFingerprint([relocated]));
  assert.equal(solutionContentPath(a, 'C:\\old\\solution\\Entities\\item\\Entity.xml'), 'Entities/item/Entity.xml');
  assert.equal(
    solutionContentPath({ dir: '/old/export.zip' }, '/old/export.zip!/Entities/item/Entity.xml'),
    'Entities/item/Entity.xml',
  );
  assert.equal(
    solutionContentPath({ dir: '/checkout!/source' }, '/checkout!/source/Entities/item/Entity.xml'),
    'Entities/item/Entity.xml',
  );
  assert.equal(
    solutionContentPath(
      { dir: '/checkout!/source/export.zip' },
      '/checkout!/source/export.zip!/Entities/item/Entity.xml',
    ),
    'Entities/item/Entity.xml',
  );
  assert.equal(
    solutionContentPath({ dir: '/source' }, '/source/Entities/item!/Entity.xml'),
    'Entities/item!/Entity.xml',
  );
  assert.notEqual(solutionContentFingerprint([a, b]), solutionContentFingerprint([b, a]));
  assert.notEqual(
    solutionContentFingerprint([a]),
    solutionContentFingerprint([{ ...a, solution: { uniqueName: 'renamed' } }]),
  );
  assert.notEqual(
    solutionContentFingerprint([a]),
    solutionContentFingerprint([
      { ...a, documents: [{ ...a.documents[0], file: `${a.dir}/Entities/item/Renamed.xml` }] },
    ]),
  );
  assert.notEqual(
    solutionContentFingerprint([a, b]),
    solutionContentFingerprint([a, { ...b, documents: [{ ...b.documents[0], hash: 'a' }] }]),
  );
});

test('a ZIP layer listing never inflates entries outside the requested folders and is memoised per archive stamp', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fingerprint-zip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'invented.zip'),
    msappName = 'CanvasApps/x_app_DocumentUri.msapp';
  const write = async (flow) => {
    const zip = writeSolutionAssetEntries([
      { name: 'workflows/x_flow.json', data: Buffer.from(flow) },
      { name: msappName, data: randomBytes(5 * 1024 * 1024) },
    ]);
    // Corrupt the 5 MB .msapp payload: any inflate/CRC of it fails, so a successful listing proves it was skipped.
    zip[zip.indexOf(Buffer.from(msappName)) + msappName.length + 1024] ^= 0xff;
    await fs.writeFile(archive, zip);
  };
  await write('{"v":1}');
  const layer = { type: 'zip', dir: archive };
  const first = solutionLayerFiles(layer, /^workflows$/i);
  assert.deepEqual(
    first.map((file) => [file.name, file.read().toString()]),
    [['workflows/x_flow.json', '{"v":1}']],
  );
  assert.equal(solutionLayerFiles(layer, /^workflows$/i)[0], first[0]);
  assert.deepEqual(
    solutionLayerFiles(layer).map((file) => file.name),
    ['workflows/x_flow.json'],
  );
  assert.throws(() => solutionLayerFiles(layer, /^canvasapps$/i), /CRC/);
  await write('{"v":22}');
  assert.equal(
    solutionLayerFiles(layer, /^workflows$/i)[0]
      .read()
      .toString(),
    '{"v":22}',
  );
});
