import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { complexPerformanceFixture } from './complex-performance-fixture.mjs';
import { scanSolutionSources, buildSolutionSchema } from '../lib/solution-schema.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';

test('minimum-size complex fixtures retain one valid record in every table', async (t) => {
  const fixture = await complexPerformanceFixture({ tables: 4, records: 4, formsPerTable: 1 });
  t.after(() => fixture.cleanup());
  const body = fixture.pack.presets()['invented-scale'].createOwned();
  assert.deepEqual(
    Object.values(body.tables).map((rows) => rows.length),
    [1, 1, 1, 1],
  );
  for (const [name, rows] of Object.entries(body.tables))
    assert.match(rows[0][name + 'id'], /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
  assert.equal(body.tables.x_scale0[0].x_link199, body.tables.x_scale0[0].x_scale0id);
});

test('complex qualification exports real wide relational metadata and populated dense rows in at least half its tables', async (t) => {
  const fixture = await complexPerformanceFixture({ tables: 4, records: 80, formsPerTable: 2, roots: 3 });
  t.after(() => fixture.cleanup());
  const scan = await scanSolutionSources(fixture.solutionRoots);
  const schema = buildSolutionSchema(scan);
  const metadata = await importSolutionMetadata(fixture.solutionRoots, { scan, schema });
  for (let i = 0; i < 2; i++) {
    const name = 'x_scale' + i;
    assert.ok(Object.keys(schema.tables[name].attributes).length >= 257);
    const relationships = Object.values(schema.relationships).filter(
      (item) => item.referencingEntity === name && /^x_link\d+$/.test(item.referencingAttribute),
    );
    assert.equal(relationships.length, 200);
    for (let link = 0; link < 200; link++)
      assert.deepEqual(metadata.entities[name].fields['x_link' + link].targets, ['x_scale' + ((i + link + 1) % 4)]);
  }
  const body = fixture.pack.presets()['invented-scale'].createOwned();
  assert.deepEqual(
    Object.values(body.tables).map((rows) => rows.length),
    [32, 32, 8, 8],
  );
  assert.equal(Object.keys(body.tables.x_scale0[0]).length, 257);
  assert.equal(body.tables.x_scale0[0].x_link0, body.tables.x_scale1[0].x_scale1id);
  assert.equal(typeof body.tables.x_scale0[0].x_quantity, 'number');
  assert.equal(typeof body.tables.x_scale0[0].x_enabled, 'boolean');
  assert.match(body.tables.x_scale0[0].x_value2, /日本語/);
  assert.equal(JSON.parse(body.tables.x_scale0[0].x_json).nested.value, 0);
  assert.equal(metadata.forms.length, 8);
  assert.equal(metadata.views.length, 16);
  assert.ok(metadata.forms.every((form) => form.xml.includes('ScaleClient.load')));
  let files = 0,
    xmlFiles = 0,
    bytes = 0;
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        files++;
        bytes += (await fs.stat(file)).size;
        if (file.endsWith('.xml')) xmlFiles++;
      }
    }
  };
  await visit(fixture.sourceDir);
  for (const root of fixture.solutionRoots) await visit(root);
  assert.deepEqual(
    { files, xmlFiles, bytes },
    { files: fixture.inventory.files, xmlFiles: fixture.inventory.xmlFiles, bytes: fixture.inventory.sourceBytes },
  );
});
