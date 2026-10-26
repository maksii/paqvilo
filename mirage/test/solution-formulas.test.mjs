import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scanSolutionSources, buildSolutionSchema, tableFields } from '../lib/solution-schema.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { createSimulator } from '../api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { parseSolutionFormulaDocument, solutionFormulaResolver } from '../lib/solution-formulas.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const reference = '/Formulas/Fields.yaml';
const entity = (ref) =>
  `<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="x_code"><Name>x_code</Name><Type>nvarchar</Type></attribute><attribute PhysicalName="x_label"><Name>x_label</Name><Type>nvarchar</Type><SourceType>3</SourceType><FormulaDefinitionFileName>${ref}</FormulaDefinitionFileName></attribute></attributes></entity></EntityInfo></Entity>`;
const formula = 'x_label: =Concatenate(x_name, " / ", x_code)\n';
async function fixture(t, ref = reference, expression = formula) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-formula-source-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedFormula</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml': entity(ref),
    'Entities/x_item/Formulas/Fields.yaml': expression,
  };
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  return { root, file: await fs.realpath(path.join(root, 'Entities/x_item/Formulas/Fields.yaml')) };
}

test('referenced formula YAML contributes computed metadata, provenance and cached source edits', async (t) => {
  const { root, file } = await fixture(t);
  const first = await scanSolutionSources([root]);
  const before = buildSolutionSchema(first);
  assert.equal(before.tables.x_item.attributes.x_label.formulaDefinition, formula.slice(formula.indexOf('=')).trim());
  assert.ok(before.tables.x_item.attributes.x_label.sources.includes(file));
  assert.equal(
    tableFields(before, 'x_item').x_label.columnMetadata.formulaDefinition,
    '=Concatenate(x_name, " / ", x_code)',
  );
  assert.equal(tableFields(before, 'x_item').x_label.columnMetadata.formulaDefinitionSource, undefined);
  await fs.writeFile(file, 'x_label: =Concatenate(x_code, " / ", x_name)\n');
  const second = await scanSolutionSources([root], { cache: first.cache, previous: first });
  const after = buildSolutionSchema(second);
  assert.equal(after.tables.x_item.attributes.x_label.formulaDefinition, '=Concatenate(x_code, " / ", x_name)');
  assert.notEqual(after.fingerprint, before.fingerprint);
  assert.notEqual(after.contentFingerprint, before.contentFingerprint);
});

test('packaged solution root Formulas files resolve without extraction', async (t) => {
  const { root } = await fixture(t);
  const zip = path.join(root, 'formula.zip');
  await fs.writeFile(
    zip,
    writeSolutionAssetEntries([
      {
        name: 'customizations.xml',
        data: Buffer.from(`<ImportExportXml><Entities>${entity(reference)}</Entities></ImportExportXml>`),
      },
      { name: 'Formulas/Fields.yaml', data: Buffer.from(formula) },
    ]),
  );
  const schema = buildSolutionSchema(await scanSolutionSources([zip]));
  assert.equal(schema.tables.x_item.attributes.x_label.formulaDefinition, '=Concatenate(x_name, " / ", x_code)');
});

test('table-scoped formula documents cannot supply another table and inline formulas retain precedence', () => {
  const facts = {
    formulaDefinitions: parseSolutionFormulaDocument('x_label: =x_name', {
      entityDir: 'x_item',
      formulaFile: 'Fields.yaml',
    }),
  };
  const diagnostics = [],
    resolve = solutionFormulaResolver([{ file: '/owned/Entities/x_item/Formulas/Fields.yaml', facts }], diagnostics);
  const attribute = { name: 'x_label', formulaDefinitionFileName: reference };
  assert.equal(resolve('x_other', attribute, '/owned/Entities/x_other/Entity.xml').formulaDefinition, undefined);
  assert.equal(
    resolve('x_item', { ...attribute, formulaDefinition: '=x_code' }, '/owned/Entity.xml').formulaDefinition,
    '=x_code',
  );
  assert.ok(diagnostics.some((d) => d.code === 'SOLUTION_FORMULA_DEFINITION_MISSING'));
});

test('invalid formula paths, missing columns and malformed YAML stay unevaluated with diagnostics', async (t) => {
  for (const ref of [
    '/Formulas/../../outside.yaml',
    'C:/outside.yaml',
    '/outside.yaml',
    '/Formulas/sub/Fields.yaml',
    '/Formulas/..\\Fields.yaml',
    '//Formulas/Fields.yaml',
    '/Formulas/Fields\n.yaml',
  ]) {
    const { root } = await fixture(t, ref);
    const schema = buildSolutionSchema(await scanSolutionSources([root]));
    assert.equal(schema.tables.x_item.attributes.x_label.formulaDefinition, undefined, ref);
    assert.ok(
      schema.diagnostics.some((d) => d.code === 'SOLUTION_FORMULA_REFERENCE_INVALID'),
      ref,
    );
  }
  for (const text of [
    'x_label: [unfinished',
    '[x_label]',
    'x_label: { code: dynamic }',
    'x_label: true',
    'x_label: ""',
    'x_label: =x_name\nX_LABEL: =x_code',
  ]) {
    const { root } = await fixture(t, reference, text);
    const scan = await scanSolutionSources([root]);
    assert.ok(scan.diagnostics.some((d) => d.code === 'SOLUTION_FORMULA_INVALID'));
    assert.equal(buildSolutionSchema(scan).tables.x_item.attributes.x_label.formulaDefinition, undefined);
  }
  const { root } = await fixture(t, reference, 'x_other: =x_name');
  assert.ok(
    buildSolutionSchema(await scanSolutionSources([root])).diagnostics.some(
      (d) => d.code === 'SOLUTION_FORMULA_DEFINITION_MISSING',
    ),
  );
});

for (const location of ['entity', 'root'])
  test(
    `a running model-driven host recomputes source formula values after editing ${location} YAML`,
    { timeout: 25000 },
    async (t) => {
      const fixtureSource = await fixture(t),
        { root } = fixtureSource;
      let file = fixtureSource.file;
      if (location === 'root') {
        await fs.mkdir(path.join(root, 'Formulas'));
        file = path.join(root, 'Formulas/Fields.yaml');
        await fs.rename(fixtureSource.file, file);
      }
      const sim = await createSimulator({
        projectRoot: root,
        solutionRoots: [root],
        runtime: { kind: 'model-driven' },
        stateFile: path.join(root, '.paqvilo/state.json'),
        simulation: { level: 'dry-run' },
        watch: true,
        initial: { tables: { x_item: [{ x_itemid: ID, x_name: 'Invented', x_code: 'A' }] } },
      });
      ownedFixture(t).add(() => sim.close());
      const read = async () => {
        const response = await fetch(sim.url + '/_apps/api/tables/x_item/' + ID);
        assert.equal(response.status, 200);
        return (await response.json()).row.x_label;
      };
      assert.equal(await read(), 'Invented / A');
      // createSimulator resolves after the source watcher reported ready (standalone-runtime.mjs restartWatcher).
      await fs.writeFile(file, 'x_label: =Concatenate(x_code, " / ", x_name)\n');
      const deadline = Date.now() + 15000;
      while ((await read()) !== 'A / Invented' && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await read(), 'A / Invented');
    },
  );
