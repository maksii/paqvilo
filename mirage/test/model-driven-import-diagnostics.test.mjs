import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importModelDrivenResources, clientExtensionCatalogue } from '../lib/model-driven-resources.mjs';
import { modelDrivenSettings } from '../lib/model-driven-settings.mjs';

const descriptor = (name, file) =>
  `<WebResource><Name>${name}</Name><WebResourceType>3</WebResourceType><FileName>${file}</FileName></WebResource>`;

// An unpacked Solution with a PCF control whose manifest cannot be parsed, and a declared WebResource that is missing.
async function brokenSolution(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-diagnostics-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'InventedSolution');
  const files = {
    'Controls/Broken/ControlManifest.xml.data.xml': '<CustomControl><Name>fx.Broken</Name></CustomControl>',
    'Controls/Broken/ControlManifest.xml': '<manifest><control',
    'WebResources/x_missing.js.data.xml': descriptor('x_/missing.js', 'WebResources/x_missing.js'),
  };
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(solution, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data);
  }
  return { root, solution };
}

test('broken PCF manifest diagnostics name Solution-relative files and reach the diagnostic callback', async (t) => {
  const { root, solution } = await brokenSolution(t);
  const delivered = [];
  const imported = await importModelDrivenResources([{ type: 'directory', dir: solution }], {
    diagnostic: (entry) => delivered.push(entry),
  });

  assert.deepEqual(
    imported.diagnostics.map((entry) => [entry.code, entry.file]),
    [
      ['MODEL_WEBRESOURCE_UNRESOLVED', undefined],
      ['PCF_IMPORT_FAILED', 'InventedSolution/Controls/Broken/ControlManifest.xml'],
    ],
  );
  assert.deepEqual(delivered, imported.diagnostics);

  // No absolute local path (drive letter, root or the temporary directory) survives in any diagnostic.
  const text = JSON.stringify(imported.diagnostics);
  for (const local of [root, solution]) assert.equal(text.includes(JSON.stringify(local).slice(1, -1)), false, text);
  for (const entry of imported.diagnostics)
    for (const key of ['file', 'source'])
      if (entry[key] !== undefined) assert.doesNotMatch(entry[key], /^(?:[a-z]:|[\\/])/i);

  // The catalogue exposes the same diagnostics that were delivered.
  assert.deepEqual(clientExtensionCatalogue(imported, modelDrivenSettings()).diagnostics, imported.diagnostics);
});

test('diagnostic callback is optional and a clean Solution delivers nothing', async (t) => {
  const { solution } = await brokenSolution(t);
  const result = await importModelDrivenResources([{ type: 'directory', dir: solution }]);
  assert.equal(result.diagnostics.length, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-diagnostics-clean-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const delivered = [];
  const clean = await importModelDrivenResources([{ type: 'directory', dir: root }], {
    diagnostic: (entry) => delivered.push(entry),
  });
  assert.deepEqual(clean.diagnostics, []);
  assert.deepEqual(delivered, []);
});
