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
import { settleFileTimes } from './support/file-times.mjs';
import { SolutionFileCache } from '../lib/solution-cache.mjs';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

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
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-content-'));
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
  // The reuse assertions below concern files written moments ago.
  settleFileTimes(t);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'fingerprint-zip-'));
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

test('side-file hashes persist across restarts and changed, added or removed side files change the fingerprint', async (t) => {
  const settled = settleFileTimes(t);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'fingerprint-side-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution'),
    cacheFile = path.join(root, '.paqvilo', 'solution-cache.json'),
    script = path.join(solution, 'WebResources', 'x_', 'script.js'),
    added = path.join(solution, 'Workflows', 'x_flow.json'),
    archive = path.join(root, 'invented.zip');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(path.join(solution, 'Other', 'Customizations.xml'), xml('name'));
  await fs.writeFile(script, 'invented();');
  await fs.writeFile(
    archive,
    writeSolutionAssetEntries([{ name: 'workflows/x_flow.json', data: Buffer.from('{"invented":1}') }]),
  );
  const zip = { type: 'zip', dir: archive, solution: { uniqueName: 'archive' } };
  // One restart: a fresh cache object over the persisted file; the side hashes it supplies, then a save.
  const restart = async (edit = () => {}) => {
    const cache = await SolutionFileCache.open(cacheFile);
    const scan = await scanSolutionSources([solution], { cache });
    edit(cache);
    const layers = [...scan.layers, zip];
    const value = solutionContentFingerprint(layers, { cache });
    await cache.save();
    return { value, uncached: solutionContentFingerprint(layers) };
  };
  const first = await restart();
  assert.equal(first.value, first.uncached);
  assert.equal((await restart()).value, first.value);
  // A stored hash for an unchanged stamp is used as is: an unchanged side file is stat'ed, never read.
  const tampered = await restart((cache) => {
    cache.entries.get(script).hash = 'invented stored hash';
  });
  assert.notEqual(tampered.value, first.value);
  assert.equal(tampered.uncached, first.value);
  const listing = await restart((cache) => {
    cache.entries.get(archive).results['side-files@1'] = [['workflows/x_flow.json', 'invented stored hash']];
  });
  assert.notEqual(listing.value, first.value, 'An unchanged archive reuses its stored side-file listing');
  // The tampered entries were saved: restore real hashes by changing the files' stamps.
  settled.restore();
  await fs.writeFile(script, 'invented(); // edited');
  const changed = await restart();
  assert.equal(changed.value, changed.uncached);
  assert.notEqual(changed.value, first.value, 'A changed side file changes the fingerprint');
  await fs.writeFile(script, 'invented();');
  await fs.writeFile(
    archive,
    writeSolutionAssetEntries([{ name: 'workflows/x_flow.json', data: Buffer.from('{"invented":1}') }]),
  );
  const restored = await restart();
  assert.equal(restored.value, first.value);
  await fs.mkdir(path.dirname(added), { recursive: true });
  await fs.writeFile(added, '{}');
  const grown = await restart();
  assert.equal(grown.value, grown.uncached);
  assert.notEqual(grown.value, first.value, 'An added side file changes the fingerprint');
  await fs.rm(added);
  assert.equal((await restart()).value, first.value, 'A removed side file restores the fingerprint');
});
