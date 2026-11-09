// @test-kind contract: admitted FormXml controls inherit standard reference facts below explicit exported metadata, including when raw form parse results are reused from disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { SolutionFileCache } from '../lib/solution-cache.mjs';
import { settleFileTimes } from './support/file-times.mjs';

test('FormXml-only standard fields are enriched after a warm raw-form parse without overriding exports or admitting extra columns', async (t) => {
  settleFileTimes(t);
  const fixture = await profileFixture(t),
    root = fixture.solutionRoots[0];
  const directory = path.join(root, 'Entities/Account');
  await fs.mkdir(path.join(directory, 'FormXml/main'), { recursive: true });
  await fs.writeFile(
    path.join(directory, 'Entity.xml'),
    '<Entity><Name>account</Name><EntityInfo><entity><attributes><attribute><LogicalName>address1_city</LogicalName><Type>nvarchar</Type><MaxLength>17</MaxLength></attribute></attributes></entity></EntityInfo></Entity>',
  );
  const names = ['address1_composite', 'address1_county', 'address1_city', 'x_unknown'];
  const formFile = path.join(directory, 'FormXml/main/reference.xml');
  await fs.writeFile(
    formFile,
    '<systemform><formid>reference-form</formid><form><tabs><tab name="main"><columns><column><sections><section name="fields"><rows>' +
      names.map((name) => `<row><cell><control datafieldname="${name}"/></cell></row>`).join('') +
      '</rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Invented reference" languagecode="1033"/></LocalizedNames></systemform>',
  );
  const portal = {
    forms: [
      { id: 'create', name: 'Invented create', entityName: 'account', formName: 'Invented reference', metadata: {} },
    ],
    lists: [],
    advancedForms: [],
    records: [],
  };
  const file = path.join(fixture.root, '.paqvilo/form-cache.json');
  const first = await SolutionFileCache.open(file);
  const cold = await importSolutionMetadata(root, { portal, cache: first });
  await first.save();
  const reopened = await SolutionFileCache.open(file);
  assert.ok(
    reopened.entries.get(formFile).results['metadata-form@7:1033'].forms[0].xml.includes('address1_composite'),
    'the unchanged parser stores raw XML, not enriched field definitions',
  );
  const warm = await importSolutionMetadata(root, { portal, cache: reopened });
  assert.ok(reopened.stats.hits > 0, 'the restart consumes retained source parse results');
  for (const metadata of [cold, warm]) {
    assert.ok(metadata.componentSchemas.create, JSON.stringify(metadata.diagnostics));
    const fields = metadata.componentSchemas.create.fields;
    assert.deepEqual(
      fields.map((field) => field.name),
      names,
      'reference columns absent from FormXml stay absent',
    );
    assert.equal(fields[0].type, 'textarea');
    assert.equal(fields[0].validForCreate, false);
    assert.equal(fields[0].validForUpdate, false);
    assert.equal(fields[1].maxLength, 50);
    assert.equal(fields[2].maxLength, 17, 'explicit exported length overrides the reference length');
    assert.equal(fields[3].dataverseType, undefined, 'unknown custom columns are not assigned standard facts');
  }
  assert.deepEqual(warm.componentSchemas.create, cold.componentSchemas.create);
});
