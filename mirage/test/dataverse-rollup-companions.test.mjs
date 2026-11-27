// @test-kind unproven: local model of rollup companion columns beyond the single live capture; each test that the capture proves carries its own observation tag.
// Rollup columns from a Solution export (lib/dataverse-rollup.mjs withRollupCompanions, lib/solution-formulas.mjs): the
// platform companions <column>_date and <column>_state, the FormulaDefinition read from the exported XAML file and the
// enum names of the attribute Format in the Web API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSimulator } from '../api.mjs';
import { buildSolutionSchema, scanSolutionSources } from '../lib/solution-schema.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const EVIDENCE = JSON.parse(
  readFileSync(new URL('./fixtures/dataverse-native-rollup-companions.json', import.meta.url), 'utf8'),
);
const APP_ID = '22222222-2222-4222-8222-222222222222';
const SECRET_VARIABLE = 'MIRAGE_ROLLUP_COMPANIONS_TEST_SECRET';
const PARENT = '11111111-1111-4111-8111-111111111111';
// The exported XAML as the export writes it: the platform's stored text without its declaration, one element per line.
const NATIVE_FORMULA = EVIDENCE.pqvd_rollup.body.FormulaDefinition;
const EXPORTED_FORMULA = NATIVE_FORMULA.replace(/^<\?xml[^>]*\?>/, '').replaceAll('><', '>\n  <') + '\n';

const attribute = (name, type, extra = '') =>
  `<attribute PhysicalName="${name}"><Type>${type}</Type><Name>${name}</Name><LogicalName>${name}</LogicalName>${extra}</attribute>`;
const label = (text) => `<displaynames><displayname description="${text}" languagecode="1033" /></displaynames>`;
const entityXml = (reference) =>
  '<Entity><Name>x_parent</Name><EntityInfo><entity Name="x_parent"><EntitySetName>x_parents</EntitySetName>' +
  '<PrimaryIdAttribute>x_parentid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes>' +
  attribute('x_parentid', 'primarykey') +
  attribute(
    'x_name',
    'nvarchar',
    '<DisplayMask>PrimaryName|ValidForAdvancedFind|ValidForForm|ValidForGrid</DisplayMask>',
  ) +
  attribute(
    'x_total',
    'int',
    '<ValidForCreateApi>0</ValidForCreateApi><ValidForUpdateApi>0</ValidForUpdateApi><ValidForReadApi>1</ValidForReadApi>' +
      '<IsCustomField>1</IsCustomField><MinValue>-2147483648</MinValue><MaxValue>2147483647</MaxValue><Format></Format>' +
      `<SourceType>2</SourceType>${label('Total')}<FormulaDefinitionFileName>${reference}</FormulaDefinitionFileName>`,
  ) +
  ['none', 'duration', 'timezone', 'language', 'locale']
    .map((format) => attribute(`x_${format}`, 'int', `<Format>${format}</Format><SourceType>0</SourceType>`))
    .join('') +
  '</attributes></entity></EntityInfo></Entity>';

async function solution(t, { reference = '/Formulas/x_parent-x_total.xaml', outside = false } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-rollup-companions-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedRollup</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_parent/Entity.xml': entityXml(reference),
    'solution/Entities/x_parent/Formulas/x_parent-x_total.xaml': EXPORTED_FORMULA,
    // A parent row without companion values, as a data pack or a row older than the column holds it.
    'pack.mjs': `export default { id: 'rollup', name: 'Rollup', description: 'One invented parent row', matches: () => true, presets: () => ({ rollup: { name: 'Rollup', mappings: { x_parent: { entitySet: 'x_parents', idColumn: 'x_parentid' } }, tables: { x_parent: [{ x_parentid: '${PARENT}', x_name: 'Invented parent' }] }, permissions: [] } }) };\n`,
  };
  if (outside) files['outside.xaml'] = EXPORTED_FORMULA;
  for (const [relative, body] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
  }
  return root;
}

async function webApi(t, root) {
  process.env[SECRET_VARIABLE] = 'invented-rollup-secret';
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [path.join(root, 'solution')],
    dataPacks: [{ id: 'rollup', module: pathToFileURL(path.join(root, 'pack.mjs')).href }],
    preset: 'rollup',
    port: 0,
    watch: false,
    dataverse: {
      enabled: true,
      port: 0,
      tds: { enabled: false },
      applications: [
        {
          appId: APP_ID,
          displayName: 'Rollup test',
          secretEnvironmentVariable: SECRET_VARIABLE,
          roles: ['System Administrator'],
        },
      ],
    },
  });
  ownedFixture(t).add(() => sim.close());
  const info = await (
    await fetch(new URL(sim.url).origin + '/_sim/api/dataverse', { headers: { 'x-sim-csrf': sim.csrf } })
  ).json();
  const token = await (
    await fetch(`${info.authority}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VARIABLE],
        scope: `${info.origin}/.default`,
      }),
    })
  ).json();
  return async (route, init = {}) => {
    const response = await fetch(`${info.origin}/api/data/v9.2/${route}`, {
      ...init,
      headers: { accept: 'application/json', authorization: `Bearer ${token.access_token}`, ...init.headers },
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

const ATTRIBUTES = "EntityDefinitions(LogicalName='x_parent')/Attributes";
// The facts of a captured attribute body that do not name the captured table or column.
const FACTS = [
  '@odata.type',
  'AttributeType',
  'AttributeOf',
  'SourceType',
  'Format',
  'ImeMode',
  'MinValue',
  'MaxValue',
  'FormulaDefinition',
  'IsValidForCreate',
  'IsValidForUpdate',
  'IsValidForRead',
  'CanBeSecuredForRead',
  'CanBeSecuredForCreate',
  'CanBeSecuredForUpdate',
];
const factsOf = (body) => ({
  ...Object.fromEntries(FACTS.filter((key) => Object.hasOwn(body, key)).map((key) => [key, body[key]])),
  ...(body.DateTimeBehavior ? { DateTimeBehavior: body.DateTimeBehavior.Value } : {}),
  DisplayName: body.DisplayName?.UserLocalizedLabel?.Label,
  Description: body.Description?.UserLocalizedLabel?.Label,
});
// The captured column is pqvd_rollup ("Rollup"); the invented one is x_total ("Total").
const invented = (facts) =>
  JSON.parse(
    JSON.stringify(facts).replaceAll('rollup field Rollup', 'rollup field Total').replaceAll('"Rollup (', '"Total ('),
  );

// @test-kind observation: one read-only live capture (2026-11-18) in fixtures/dataverse-native-rollup-companions.json (raw sha256 4d3c3d04...) records the _date and _state companions of the exported rollup column; the invented export is typed in this test, so it is not a replay case.
test('an exported rollup column brings its _date and _state companions with the platform metadata', async (t) => {
  const call = await webApi(t, await solution(t));
  for (const suffix of ['date', 'state']) {
    const response = await call(`${ATTRIBUTES}(LogicalName='x_total_${suffix}')`);
    assert.equal(response.status, 200, suffix);
    const expected = factsOf(EVIDENCE[`pqvd_rollup_${suffix}`].body);
    const actual = factsOf(response.body);
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])),
      invented(expected),
      suffix,
    );
    assert.equal(response.body.SchemaName, `x_total_${suffix === 'date' ? 'Date' : 'State'}`);
  }
});

// @test-kind observation: the read-only live capture (2026-11-18) in fixtures/dataverse-native-rollup-companions.json (raw sha256 4d3c3d04...) records SourceType and Format "None" of the typed rollup read; the hosted import round trip of 2026-11-26 (workbench hosted-f6 import-roundtrip-1795722792122, every imported rollup and calculated column equal to its exported Formulas file) supersedes the 2026-11-18 FormulaDefinition text, which a designer save stored with a declaration; the invented export is typed here, so it is not a replay case.
test('the rollup FormulaDefinition is the exported XAML file as an import stores it, and Format is named', async (t) => {
  const call = await webApi(t, await solution(t));
  const typed = await call(
    `${ATTRIBUTES}(LogicalName='x_total')/Microsoft.Dynamics.CRM.IntegerAttributeMetadata?$select=FormulaDefinition,SourceType,Format`,
  );
  assert.equal(typed.status, 200);
  const native = EVIDENCE.pqvd_rollup_typed.body;
  assert.deepEqual(
    { FormulaDefinition: typed.body.FormulaDefinition, SourceType: typed.body.SourceType, Format: typed.body.Format },
    { FormulaDefinition: EXPORTED_FORMULA, SourceType: native.SourceType, Format: native.Format },
  );
});

// @test-kind observation: one read-only live capture (2026-11-18) in fixtures/dataverse-native-rollup-companions.json (raw sha256 4d3c3d04...) reads a never-calculated parent row without $select: the rollup and both companions are present and null; the invented row is typed here, so it is not a replay case.
test('a row without companion values reads the rollup and both companions as null', async (t) => {
  const call = await webApi(t, await solution(t));
  const row = await call(`x_parents(${PARENT})`);
  assert.equal(row.status, 200);
  const native = EVIDENCE.row.body;
  assert.deepEqual(
    {
      x_total: row.body.x_total,
      x_total_date: row.body.x_total_date,
      x_total_state: row.body.x_total_state,
    },
    { x_total: native.pqvd_rollup, x_total_date: native.pqvd_rollup_date, x_total_state: native.pqvd_rollup_state },
  );
});

// @test-kind observation: hosted runs run-derived-A/B 2026-11-26 (paqvilo-developer hosted-f6 summary-F6 DATA-04c): on create every rollup column is Calculated (_state 1) with _date at the creation time and the value of no children (a Count reads 0)
test('the companions are listed, selectable and stamped Calculated with the empty value on a Mirage create', async (t) => {
  const call = await webApi(t, await solution(t));
  const list = await call(`${ATTRIBUTES}?$select=LogicalName`);
  const names = list.body.value.map((a) => a.LogicalName);
  for (const name of ['x_total', 'x_total_date', 'x_total_state']) assert.ok(names.includes(name), name);
  const selected = await call(`x_parents(${PARENT})?$select=x_total_state,x_total_date`);
  assert.equal(selected.status, 200);
  assert.deepEqual([selected.body.x_total_state, selected.body.x_total_date], [null, null]);
  const created = await call('x_parents', {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ x_name: 'Created parent' }),
  });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.x_total_state, created.body.x_total], [1, 0]);
  assert.equal(created.body.x_total_date, created.body.createdon, 'the date is the creation time');
});

// @test-kind compatibility: IntegerAttributeMetadata.Format is the IntegerFormat enum (None, Duration, TimeZone, Language, Locale) in the Web API CSDL, and OData JSON writes an enum value as its member name.
test('every integer Format is written as its IntegerFormat member name', async (t) => {
  const call = await webApi(t, await solution(t));
  for (const [format, name] of Object.entries({
    none: 'None',
    duration: 'Duration',
    timezone: 'TimeZone',
    language: 'Language',
    locale: 'Locale',
  })) {
    const response = await call(`${ATTRIBUTES}(LogicalName='x_${format}')?$select=Format`);
    assert.equal(response.body.Format, name, format);
  }
});

// @test-kind security: a FormulaDefinitionFileName that leaves the table Formulas directory is refused before any file is read.
test('a formula reference that escapes the solution root is refused without reading the file', async (t) => {
  for (const reference of ['/Formulas/../../outside.xaml', '../outside.xaml', 'C:/outside.xaml']) {
    const root = await solution(t, { reference, outside: true });
    const schema = buildSolutionSchema(await scanSolutionSources([path.join(root, 'solution')]));
    assert.equal(schema.tables.x_parent.attributes.x_total.formulaDefinition, undefined, reference);
    assert.ok(
      schema.diagnostics.some((d) => d.code === 'SOLUTION_FORMULA_REFERENCE_INVALID'),
      reference,
    );
  }
});
