// @test-kind contract: Owned offline Dataverse, Solution and model-driven quality rules describe selected source evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempDirSync } from './fixture.mjs';
import { analyzeDataverse, dataverseRules } from '../lense/analysis/dataverse-rules.mjs';
import { analyzeProject } from '../lense/analysis/index.mjs';

const CLI_HANG_GUARD_MS = 170_000; // hang guard only: a blocked synchronous child cannot be ended by the test runner

const entry = (file, text, rootId = 'invented') => ({ file, relativeFile: file, rootId, text });
const xml = (text, file = 'Other/Solution.xml', rootId) => entry(file, text, rootId);
const json = (value, file = 'app-spec.json', rootId) => entry(file, JSON.stringify(value), rootId);
function inspect(entries) {
  const findings = [];
  const coverage = analyzeDataverse(entries, (ruleId, source, field, offset) =>
    findings.push({ ruleId, file: source.file, field, offset }),
  );
  return { findings, ids: findings.map((item) => item.ruleId), coverage };
}
const definition = (body) =>
  xml(
    `<environmentvariabledefinition schemaname="invented_setting">${body}</environmentvariabledefinition>`,
    'environmentvariabledefinitions/invented_setting/environmentvariabledefinition.xml',
  );
const pluginStep = (body) =>
  xml(`<SdkMessageProcessingStep>${body}</SdkMessageProcessingStep>`, 'sdkmessageprocessingsteps/invented.xml');
const entityXml = (body) =>
  xml(`<Entity><Name>invented_table</Name>${body}</Entity>`, 'Entities/invented_table/Entity.xml');

test('rule catalogue is unique and contains a fixed remediation and primary reference for every rule', () => {
  assert.equal(new Set(dataverseRules.map((rule) => rule.id)).size, dataverseRules.length);
  assert.ok(dataverseRules.length >= 24);
  for (const rule of dataverseRules) {
    assert.ok(['error', 'warning', 'hint'].includes(rule.severity));
    assert.ok(
      rule.message &&
        rule.remediation &&
        rule.references.every((reference) => reference.startsWith('https://learn.microsoft.com/')),
    );
  }
});

test('explicit invalid solution versions fail while zero and signed-int maximum components are valid', () => {
  for (const version of ['1.0', '1.2.3.-1', '1.2.3.2147483648', '1.2.3.1e2'])
    assert.deepEqual(inspect([xml(`<SolutionManifest><Version>${version}</Version></SolutionManifest>`)]).ids, [
      'DV-SOLUTION-001',
    ]);
  assert.deepEqual(inspect([xml('<SolutionManifest><Version>0.0.0.2147483647</Version></SolutionManifest>')]).ids, []);
});

test('export-declared dependencies and duplicate exact component identities are review findings', () => {
  const result = inspect([
    xml(`<SolutionManifest><MissingDependencies><MissingDependency><Required type="1" schemaName="invented_dependency" /></MissingDependency></MissingDependencies>
    <RootComponents><RootComponent type="1" schemaName="invented_table" /><RootComponent type="1" schemaName="INVENTED_TABLE" /></RootComponents></SolutionManifest>`),
  ]);
  assert.deepEqual(new Set(result.ids), new Set(['DV-SOLUTION-002', 'DV-SOLUTION-003']));
  assert.equal(result.coverage.complete, true);
});

test('an omitted manifest component identity or version is not invented as invalid', () => {
  assert.deepEqual(
    inspect([
      xml(
        '<SolutionManifest><RootComponents><RootComponent type="1"/><RootComponent type="1"/></RootComponents></SolutionManifest>',
      ),
    ]).ids,
    [],
  );
});

test('required environment values resolve only within their selected source root', () => {
  const required = definition('<type>100000000</type><isrequired>1</isrequired>');
  const values = json(
    { EnvironmentVariables: [{ SchemaName: 'invented_setting', Value: 'ready' }] },
    'deployment-settings.json',
  );
  assert.deepEqual(inspect([required]).ids, ['DV-ENV-002']);
  assert.deepEqual(inspect([required, values]).ids, []);
  assert.deepEqual(inspect([required, { ...values, rootId: 'other' }]).ids, ['DV-ENV-002']);
});

test('environment JSON values are validated without interpreting dynamic references', () => {
  assert.deepEqual(inspect([definition('<type>100000003</type><defaultvalue>broken</defaultvalue>')]).ids, [
    'DV-ENV-003',
  ]);
  assert.deepEqual(inspect([definition('<type>100000003</type><defaultvalue>{"ready":true}</defaultvalue>')]).ids, []);
  assert.deepEqual(inspect([definition('<type>100000003</type><defaultvalue>${ENV_VALUE}</defaultvalue>')]).ids, []);
});

test('ambiguous current values do not cause an arbitrary JSON or required-value conclusion', () => {
  const values = json(
    {
      EnvironmentVariables: [
        { SchemaName: 'invented_setting', Value: 'broken' },
        { SchemaName: 'invented_setting', Value: '{}' },
      ],
    },
    'deployment-settings.json',
  );
  assert.deepEqual(inspect([definition('<type>100000003</type><isrequired>1</isrequired>'), values]).ids, [
    'DV-ENV-004',
  ]);
});

test('current-value JSON arrays and conventional wrapper objects join their definition by folder identity', () => {
  const valueFile = 'environmentvariabledefinitions/invented_setting/environmentvariablevalues.json';
  for (const value of [
    [{ value: 'broken' }],
    { environmentvariablevalues: { environmentvariablevalue: [{ value: 'broken' }] } },
  ])
    assert.deepEqual(inspect([definition('<type>100000003</type>'), json(value, valueFile)]).ids, ['DV-ENV-003']);
});

test('literal secret defaults warn, but client IDs and Key Vault references do not become secret findings', () => {
  assert.deepEqual(
    inspect([definition('<type>100000005</type><defaultvalue>invented-secret-value</defaultvalue>')]).ids,
    ['DV-ENV-001'],
  );
  const vault =
    '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/group/providers/Microsoft.KeyVault/vaults/vault/secrets/item';
  assert.deepEqual(inspect([definition(`<type>100000005</type><defaultvalue>${vault}</defaultvalue>`)]).ids, []);
  assert.deepEqual(
    inspect([
      json({
        environmentVariables: [{ schemaName: 'invented_clientid', type: 'string', defaultValue: 'invented-id' }],
      }),
    ]).ids,
    [],
  );
});

test('a literal secret taken from a selected current value is reported on the file that holds it', () => {
  const secretDefinition = xml(
    '<environmentvariabledefinition schemaname="invented_secret"><type>100000000</type></environmentvariabledefinition>',
    'environmentvariabledefinitions/invented_secret/environmentvariabledefinition.xml',
  );
  const settings = json(
    { EnvironmentVariables: [{ SchemaName: 'invented_secret', Value: 'invented-literal' }], ConnectionReferences: [] },
    'deploymentSettings.json',
  );
  const result = inspect([secretDefinition, settings]);
  assert.deepEqual(
    result.findings.filter((finding) => finding.ruleId === 'DV-ENV-001').map((finding) => finding.file),
    ['deploymentSettings.json'],
  );
});

test('connection IDs stay target-owned hints without asserting the target is missing', () => {
  const result = inspect([
    json(
      { ConnectionReferences: [{ LogicalName: 'invented_connection', ConnectionId: 'private-binding' }] },
      'deployment-settings.json',
    ),
  ]);
  assert.deepEqual(result.ids, ['DV-CONNECTION-001']);
});

test('Update plug-in filtering, async stages and image availability have separate rules', () => {
  const result = inspect([
    pluginStep(
      '<SdkMessageId Name="Update"/><Stage>20</Stage><Mode>1</Mode><SdkMessageProcessingStepImages><SdkMessageProcessingStepImage><ImageType>1</ImageType></SdkMessageProcessingStepImage></SdkMessageProcessingStepImages>',
    ),
  ]);
  assert.deepEqual(new Set(result.ids), new Set(['DV-PLUGIN-001', 'DV-PLUGIN-002', 'DV-PLUGIN-003', 'DV-PLUGIN-004']));
});

test('disabled registrations and selective valid PostOperation images are not warned', () => {
  assert.deepEqual(
    inspect([
      pluginStep('<SdkMessageName>Update</SdkMessageName><StateCode>1</StateCode><Stage>20</Stage><Mode>1</Mode>'),
    ]).ids,
    [],
  );
  assert.deepEqual(
    inspect([
      pluginStep(
        '<SdkMessageName>Update</SdkMessageName><FilteringAttributes>invented_name</FilteringAttributes><Stage>40</Stage><Mode>1</Mode><SdkMessageProcessingStepImages><SdkMessageProcessingStepImage><ImageType>2</ImageType><Attributes>invented_name</Attributes></SdkMessageProcessingStepImage></SdkMessageProcessingStepImages>',
      ),
    ]).ids,
    [],
  );
});

test('Create has no pre-image and Delete has no post-image', () => {
  for (const [message, image] of [
    ['Create', 0],
    ['Delete', 1],
  ]) {
    const result = inspect([
      pluginStep(
        `<SdkMessageName>${message}</SdkMessageName><Stage>40</Stage><SdkMessageProcessingStepImages><SdkMessageProcessingStepImage><ImageType>${image}</ImageType><Attributes>invented_name</Attributes></SdkMessageProcessingStepImage></SdkMessageProcessingStepImages>`,
      ),
    ]);
    assert.deepEqual(result.ids, ['DV-PLUGIN-004']);
  }
});

test('exported plug-in steps name their message from the well-known SdkMessageId', () => {
  const create = '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8';
  const update = '20bebb1b-ea3e-db11-86a7-000a3a5473e8';
  const deleteId = 'a1bdbb1b-ea3e-db11-86a7-000a3a5473e8';
  const unknown = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  const image = (type) =>
    `<SdkMessageProcessingStepImages><SdkMessageProcessingStepImage><ImageType>${type}</ImageType><Attributes>invented_name</Attributes></SdkMessageProcessingStepImage></SdkMessageProcessingStepImages>`;
  const step = (messageId, body = '') =>
    pluginStep(`<SdkMessageId>${messageId}</SdkMessageId><Stage>40</Stage><Mode>0</Mode>${body}`);
  assert.deepEqual(inspect([step(update)]).ids, ['DV-PLUGIN-001']);
  assert.deepEqual(inspect([step(create, image(0))]).ids, ['DV-PLUGIN-004']);
  assert.deepEqual(inspect([step(deleteId, image(1))]).ids, ['DV-PLUGIN-004']);
  assert.deepEqual(inspect([step(update, '<FilteringAttributes>invented_name</FilteringAttributes>')]).ids, []);
  assert.deepEqual(inspect([step(unknown, image(0))]).ids, []);
  assert.deepEqual(
    inspect([pluginStep(`<SdkMessageName>Create</SdkMessageName><SdkMessageId>${update}</SdkMessageId>${image(0)}`)])
      .ids,
    ['DV-PLUGIN-004'],
  );
});

test('form library binding uses declared resource identity and respects root isolation', () => {
  const form = xml(
    '<systemform><form><events><event><Handlers><Handler libraryName="invented_script.js" functionName="Handlers.load" enabled="true"/></Handlers></event></events></form></systemform>',
    'Entities/invented_table/FormXml/main/invented.xml',
  );
  const resource = xml(
    '<WebResource><Name>invented_script.js</Name></WebResource>',
    'WebResources/invented_script.xml',
  );
  assert.deepEqual(inspect([form]).ids, ['DV-MODEL-001']);
  assert.deepEqual(inspect([form, resource]).ids, []);
  assert.deepEqual(inspect([form, { ...resource, rootId: 'other' }]).ids, ['DV-MODEL-001']);
});

test('unpacked form files take their table from the Entities folder for column checks', () => {
  const table = entityXml(
    '<EntityInfo><entity Name="invented_table"><attributes><attribute PhysicalName="a"><LogicalName>a</LogicalName></attribute></attributes></entity></EntityInfo>',
  );
  const form = (column) =>
    xml(
      `<forms><systemform><form><control datafieldname="${column}"/></form></systemform></forms>`,
      'Entities/invented_table/FormXml/main/invented.xml',
    );
  const missing = inspect([table, form('b')]);
  assert.deepEqual(missing.ids, ['DV-MODEL-003']);
  assert.equal(missing.findings[0].file, 'Entities/invented_table/FormXml/main/invented.xml');
  assert.deepEqual(inspect([table, form('a')]).ids, []);
});

test('standard table forms report only columns neither the sources nor the standard table reference declare', () => {
  const controls = (columns) => columns.map((column) => `<control datafieldname="${column}"/>`).join('');
  const attributes =
    '<EntityInfo><entity Name="account"><attributes><attribute PhysicalName="new_custom"><LogicalName>new_custom</LogicalName></attribute></attributes></entity></EntityInfo>';
  const accountEntity = xml(`<Entity><Name>account</Name>${attributes}</Entity>`, 'Entities/account/Entity.xml');
  const unpacked = (columns) =>
    xml(
      `<forms><systemform><form>${controls(columns)}</form></systemform></forms>`,
      'Entities/account/FormXml/main/invented.xml',
    );
  const embedded = (columns) =>
    xml(
      `<Entity><Name>account</Name>${attributes}<FormXml><forms><systemform><form>${controls(columns)}</form></systemform></forms></FormXml></Entity>`,
      'Entities/account/Entity.xml',
    );
  assert.deepEqual(inspect([accountEntity, unpacked(['telephone1', 'new_custom'])]).ids, []);
  assert.deepEqual(inspect([accountEntity, unpacked(['telephone1', 'new_doesnotexist'])]).ids, ['DV-MODEL-003']);
  assert.deepEqual(inspect([embedded(['telephone1', 'new_custom'])]).ids, []);
  assert.deepEqual(inspect([embedded(['telephone1', 'new_doesnotexist'])]).ids, ['DV-MODEL-003']);
  const customTable = entityXml(
    '<EntityInfo><entity Name="invented_table"><attributes><attribute PhysicalName="a"><LogicalName>a</LogicalName></attribute></attributes></entity></EntityInfo>',
  );
  const customForm = xml(
    `<forms><systemform><form>${controls(['b'])}</form></systemform></forms>`,
    'Entities/invented_table/FormXml/main/invented.xml',
  );
  assert.deepEqual(inspect([customTable, customForm]).ids, ['DV-MODEL-003']);
  const unknownForm = xml(
    `<forms><systemform><form>${controls(['new_doesnotexist'])}</form></systemform></forms>`,
    'Entities/invented_unknown/FormXml/main/invented.xml',
  );
  assert.deepEqual(inspect([unknownForm]).ids, []);
  const savedQuery = (column) =>
    xml(
      `<savedquery><fetchxml><fetch><entity name="account"><attribute name="${column}"/></entity></fetch></fetchxml></savedquery>`,
      'Entities/account/SavedQueries/invented.xml',
    );
  assert.deepEqual(inspect([accountEntity, savedQuery('telephone1')]).ids, []);
  assert.deepEqual(inspect([accountEntity, savedQuery('new_doesnotexist')]).ids, ['DV-MODEL-004']);
});

test('duplicate handlers are compared within an event and preserve different parameters and disabled handlers', () => {
  const handlers = '<Handler libraryName="invented_script.js" functionName="Handlers.load" parameters="one"/>';
  const resource = xml(
    '<WebResource><Name>invented_script.js</Name></WebResource>',
    'WebResources/invented_script.xml',
  );
  const result = inspect([
    xml(
      `<systemform><form><events><event><Handlers>${handlers}${handlers}<Handler libraryName="invented_script.js" functionName="Handlers.load" parameters="two"/><Handler libraryName="invented_script.js" functionName="Handlers.load" parameters="one" enabled="false"/></Handlers></event></events></form></systemform>`,
      'Entities/invented_table/FormXml/main/invented.xml',
    ),
    resource,
  ]);
  assert.deepEqual(result.ids, ['DV-MODEL-002']);
});

test('form columns and relationship targets outside partial metadata remain hints', () => {
  const entity = entityXml(
    '<EntityInfo><entity Name="invented_table"><attributes><attribute PhysicalName="invented_name"><LogicalName>invented_name</LogicalName></attribute></attributes></entity></EntityInfo><FormXml><forms><systemform><form><control datafieldname="invented_missing"/></form></systemform></forms></FormXml>',
  );
  const relation = xml(
    '<EntityRelationship Name="invented_relation"><ReferencedEntityName>invented_missing</ReferencedEntityName><ReferencingEntityName>invented_table</ReferencingEntityName></EntityRelationship>',
    'EntityRelationships/invented_relation.xml',
  );
  const result = inspect([entity, relation]);
  assert.deepEqual(new Set(result.ids), new Set(['DV-MODEL-003', 'DV-SCHEMA-003']));
  assert.ok(
    result.findings.every((finding) => dataverseRules.find((rule) => rule.id === finding.ruleId).severity === 'hint'),
  );
});

test('reversed explicit bounds and duplicate option identities are invalid, translated labels are valid', () => {
  const result = inspect([
    entityXml(
      '<EntityInfo><entity Name="invented_table"><attributes><attribute><MinValue>3</MinValue><MaxValue>2</MaxValue></attribute></attributes></entity></EntityInfo>',
    ),
    xml(
      '<optionset Name="invented_choice"><options><option value="1"><labels><label languagecode="1033" description="First"/><label languagecode="1036" description="Premier"/></labels></option><option value="1"/></options></optionset>',
      'OptionSets/invented.xml',
    ),
  ]);
  assert.deepEqual(new Set(result.ids), new Set(['DV-SCHEMA-001', 'DV-SCHEMA-002']));
  assert.deepEqual(
    inspect([
      xml(
        '<optionset Name="invented_choice"><options><option value="1"/><option value="2"/></options></optionset>',
        'OptionSets/invented.xml',
      ),
    ]).ids,
    [],
  );
});

test('direct and embedded saved FetchXML all-attributes projections are inspected', () => {
  for (const fetch of [
    '<fetchxml><fetch><entity name="invented_table"><all-attributes/></entity></fetch></fetchxml>',
    '<fetchxml><![CDATA[<fetch><entity name="invented_table"><all-attributes/></entity></fetch>]]></fetchxml>',
  ])
    assert.deepEqual(
      inspect([xml(`<savedquery>${fetch}</savedquery>`, 'Entities/invented_table/SavedQueries/invented.xml')]).ids,
      ['DV-QUERY-001'],
    );
});

test('malformed embedded queries are incomplete rather than silently clean', () => {
  const result = inspect([
    xml(
      '<savedquery><fetchxml><![CDATA[<fetch><entity>]]></fetchxml></savedquery>',
      'Entities/invented_table/SavedQueries/invented.xml',
    ),
  ]);
  assert.deepEqual(result.ids, ['DV-SOURCE-001']);
  assert.equal(result.coverage.complete, false);
});

test('modern Git YAML schema, choices and form bindings use the same checks without asserting exact offsets', () => {
  const result = inspect([
    entry(
      'Entities/invented_table/Attributes/invented_number.yml',
      "attribute:\n  '@PhysicalName': invented_number\n  LogicalName: invented_number\n  MinValue: 5\n  MaxValue: 2\n",
    ),
    entry(
      'OptionSets/invented_choice.yml',
      "optionset:\n  '@Name': invented_choice\n  options:\n    option:\n      - '@value': 1\n      - '@value': 1\n",
    ),
  ]);
  assert.deepEqual(new Set(result.ids), new Set(['DV-SCHEMA-001', 'DV-SCHEMA-002']));
  assert.equal(result.coverage.complete, true);
});

test('Dataverse literal OData options apply across raw HTTP, mobile scripts and model-driven Xrm calls', () => {
  const result = inspect([
    entry(
      'queries/invented.http',
      'GET https://example.invalid/api/data/v9.2/invented_tables?$filter=statecode%20eq%200&$skip=20',
    ),
    entry(
      'app/screen.tsx',
      'const url = "/api/data/v9.2/invented_tables?$select=invented_name@OData.Community.Display.V1.FormattedValue";',
    ),
    entry(
      'WebResources/invented.js',
      'Xrm.WebApi.retrieveMultipleRecords("invented_table", "?$filter=statecode eq 0");',
    ),
  ]);
  assert.deepEqual(new Set(result.ids), new Set(['DV-QUERY-002', 'DV-QUERY-003', 'DV-QUERY-004']));
  assert.equal(result.coverage.literalQueries, 3);
});

test('valid cursor paging and a top result cap are distinct, dynamic builders and comments are excluded', () => {
  const result = inspect([
    entry(
      'app/queries.ts',
      `
    const first = '/api/data/v9.2/invented_tables?$select=invented_name&$top=5';
    const next = '/api/data/v9.2/invented_tables?$skiptoken=opaque';
    const bad = '/api/data/v9.2/invented_tables?$top=5&$skiptoken=opaque';
    // const comment = '/api/data/v9.2/invented_tables?$skip=5';
    /* const comment = '/api/data/v9.2/invented_tables?$search=text'; */
    const dynamic = \`/api/data/v9.2/invented_tables?\${query}\`;
  `,
    ),
  ]);
  assert.deepEqual(result.ids, ['DV-QUERY-005']);
  assert.equal(result.coverage.literalQueries, 3);
});

test('unrelated URLs, FetchXML query options and dedicated Dataverse search are not confused with collection OData', () => {
  assert.deepEqual(
    inspect([
      entry(
        'app/queries.js',
        `
    const config = 'https://example.invalid/api/data/v9.2/';
    const unrelated = '/api/other/invented_tables?$skip=5';
    const fetch = '/api/data/v9.2/invented_tables?fetchXml=encoded';
    const search = '/api/search/v2.0/query?skip=5';
  `,
      ),
    ]).ids,
    [],
  );
});

// @test-kind security: Bounded metadata analysis rejects aliases, external entities and excessive nesting without source disclosure.
test('malformed metadata, YAML aliases and extreme depth stay redacted and incomplete', () => {
  const canary = 'invented-private-canary';
  const result = inspect([
    xml(`<!DOCTYPE entity SYSTEM "https://example.invalid/${canary}"><Entity/>`, 'Entities/invented/Entity.xml'),
    entry('Entities/invented/Attributes/alias.yml', 'attribute: &a\n  LogicalName: invented_name\ncopy: *a\n'),
    xml('<Entity>'.repeat(140) + '</Entity>'.repeat(140), 'Entities/invented/deep.xml'),
    entry('environmentvariabledefinitions/invented/value.json', `{"value":"${canary}"`),
  ]);
  assert.equal(result.coverage.complete, false);
  assert.equal(result.ids.length, 4);
  assert.ok(!JSON.stringify(result).includes(canary));
});

// @test-kind security: Findings and coverage may expose locations but never environment values, secret references or private query parameters.
test('source values never appear in Dataverse diagnostics or returned coverage', () => {
  const canary = 'invented-private-canary';
  const result = inspect([
    json({ environmentVariables: [{ schemaName: 'invented_secret', type: 'secret', defaultValue: canary }] }),
    entry('app/query.js', `const query='/api/data/v9.2/invented_tables?$skip=2&private=${canary}';`),
  ]);
  assert.ok(result.ids.includes('DV-ENV-001'));
  assert.ok(!JSON.stringify(result).includes(canary));
  assert.deepEqual(
    result.coverage.domains.map((domain) => domain.domain),
    ['dataverse', 'model-driven', 'alm'],
  );
});

// @test-kind security: Hostile repeated metadata identities and dense literals must terminate within bounded analysis budgets.
test('large repeated identities and dense query literals stop at explicit structural budgets', () => {
  const module = new URL('../lense/analysis/dataverse-rules.mjs', import.meta.url).href;
  const script = `const { analyzeDataverse } = await import(${JSON.stringify(module)});
    const text = '<Entity><Name>' + 'x'.repeat(150000) + '</Name>' + '<attribute PhysicalName="x"/>'.repeat(13000) + '</Entity>';
    const result = analyzeDataverse([
      { file:'Entities/invented/Entity.xml', text },
      { file:'app/queries.js', text:'"?";'.repeat(120000) },
    ], () => {});
    if (result.complete || result.skipped.length !== 2) process.exitCode = 1;`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: CLI_HANG_GUARD_MS,
  });
  assert.equal(result.status, 0, 'bounded metadata/query analysis must complete without an unbounded repeated scan');
});

test('a folder of plain scripts without Dataverse queries leaves the Dataverse domain not detected', (t) => {
  const root = tempDirSync('paq-dataverse-plain-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'plain.js'),
    'export const total = [1, 2].reduce((sum, value) => sum + value, 0);\n',
  );
  const domain = analyzeProject(root, { failOn: 'none' }).coverage.domains.find((item) => item.domain === 'dataverse');
  assert.equal(domain.status, 'not-detected');
});

test('a JSON file with many short strings and no Dataverse URL keeps the report complete', () => {
  const values = Array.from({ length: 150000 }, (_, index) => `s${index}`);
  const result = inspect([entry('app/translations.json', JSON.stringify(values))]);
  assert.deepEqual(result.ids, []);
  assert.equal(result.coverage.complete, true);
  assert.deepEqual(result.coverage.skipped, []);
});

test('a FetchXML table reference is not mistaken for declared table metadata', () => {
  const query = xml(
    '<savedquery><fetchxml><fetch><entity name="invented_missing"><attribute name="invented_name"/></entity></fetch></fetchxml></savedquery>',
    'Entities/invented_other/SavedQueries/invented.xml',
  );
  const relation = xml(
    '<EntityRelationship><ReferencedEntityName>invented_missing</ReferencedEntityName></EntityRelationship>',
    'EntityRelationships/invented.xml',
  );
  assert.deepEqual(inspect([query, relation]).ids, ['DV-SCHEMA-003']);
});

test('upstream-style App Spec metadata receives owned schema, relationship, form and view checks', () => {
  const result = inspect([
    json({
      solution: { version: '1.2.3.4' },
      entities: [
        {
          schemaName: 'invented_table',
          primaryAttribute: { schemaName: 'invented_name' },
          columns: [
            { schemaName: 'invented_number', type: 'WholeNumber', minValue: 4, maxValue: 2 },
            {
              schemaName: 'invented_choice',
              type: 'Choice',
              options: [
                { value: 1, label: 'First' },
                { value: 1, label: 'Second' },
              ],
            },
          ],
        },
      ],
      relationships: [{ type: 'OneToMany', referenced: 'invented_missing', referencing: 'invented_table' }],
      forms: [
        {
          entity: 'invented_table',
          tabs: [{ sections: [{ fields: ['invented_unknown'] }] }],
          events: [{ event: 'onload', library: 'invented_script.js', function: 'Handlers.load' }],
        },
      ],
      views: [{ entity: 'invented_table', columns: ['invented_unknown'] }],
    }),
  ]);
  assert.deepEqual(
    new Set(result.ids),
    new Set(['DV-SCHEMA-001', 'DV-SCHEMA-002', 'DV-SCHEMA-003', 'DV-MODEL-001', 'DV-MODEL-003', 'DV-MODEL-004']),
  );
  assert.equal(result.coverage.domains.find((domain) => domain.domain === 'model-driven').recognized, 1);
});

test('App Spec declared resources, valid numeric bounds and translated choice labels are preserved', () => {
  const result = inspect([
    json({
      entities: [
        {
          schemaName: 'invented_table',
          primaryAttribute: { schemaName: 'invented_name' },
          columns: [{ schemaName: 'invented_count', minValue: 0, maxValue: 2 }],
        },
      ],
      globalChoices: [
        {
          name: 'invented_choice',
          options: [
            { value: -1, label: { 1033: 'First', 1036: 'Premier' } },
            { value: 2, label: 'Second' },
          ],
        },
      ],
      webResources: [{ name: 'invented_script.js', contentPath: 'scripts/invented.js' }],
      forms: [
        {
          entity: 'invented_table',
          events: [{ event: 'onload', library: 'invented_script.js', function: 'Handlers.load' }],
          tabs: [{ columns: [{ sections: [{ fields: ['invented_name', { name: 'invented_count' }] }] }] }],
        },
      ],
      views: [{ entity: 'invented_table', columns: ['invented_name'] }],
    }),
  ]);
  assert.deepEqual(result.ids, []);
});

test('malformed App Spec collections are incomplete rather than silently omitted', () => {
  const result = inspect([json({ entities: {} })]);
  assert.deepEqual(result.ids, ['DV-SOURCE-001']);
  assert.equal(result.coverage.complete, false);
});

test('Custom API binding and implementation are separate source conclusions', () => {
  const invalid = inspect([
    xml('<CustomAPI><BindingType>1</BindingType></CustomAPI>', 'CustomAPIs/invented/customapi.xml'),
  ]);
  assert.deepEqual(new Set(invalid.ids), new Set(['DV-API-001', 'DV-API-002']));
  const valid = xml(
    '<CustomAPI><BindingType>1</BindingType><BoundEntityLogicalName>invented_table</BoundEntityLogicalName><PluginTypeId Id="00000000-0000-0000-0000-000000000001"/></CustomAPI>',
    'CustomAPIs/invented/customapi.xml',
  );
  assert.deepEqual(inspect([valid]).ids, []);
  assert.deepEqual(
    new Set(inspect([json({ customApis: [{ uniqueName: 'invented_api', binding: 'entity' }] })]).ids),
    new Set(['DV-API-001', 'DV-API-002']),
  );
});

test('query columns use the linked table metadata instead of the primary table', () => {
  const first = entityXml(
    '<EntityInfo><entity Name="invented_table"><attributes><attribute><LogicalName>invented_name</LogicalName></attribute></attributes></entity></EntityInfo>',
  );
  const linked = xml(
    '<Entity><Name>invented_linked</Name><EntityInfo><entity Name="invented_linked"><attributes><attribute><LogicalName>invented_other</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
    'Entities/invented_linked/Entity.xml',
  );
  const query = xml(
    '<savedquery><fetchxml><fetch><entity name="invented_table"><attribute name="invented_name"/><link-entity name="invented_linked"><attribute name="invented_other"/></link-entity></entity></fetch></fetchxml></savedquery>',
    'Entities/invented_table/SavedQueries/invented.xml',
  );
  assert.deepEqual(inspect([first, linked, query]).ids, []);
});

test('single current-value records use the environment folder identity without a leading slash', () => {
  const result = inspect([
    definition('<type>100000003</type>'),
    json({ value: 'broken' }, 'environmentvariabledefinitions/invented_setting/environmentvariablevalue.json'),
  ]);
  assert.deepEqual(result.ids, ['DV-ENV-003']);
});

// @test-kind security: Repeated references to one large current value must not multiply JSON parsing by definition count.
test('shared large current values are parsed at most once per analysis', () => {
  const value = JSON.stringify('invented-private-canary'.repeat(10000));
  const definitions =
    '<environmentvariabledefinition schemaname="invented_setting"><type>100000003</type></environmentvariabledefinition>'.repeat(
      200,
    );
  const values = `<environmentvariablevalue schemaname="invented_setting"><value><![CDATA[${value}]]></value></environmentvariablevalue>`;
  const original = JSON.parse;
  let parses = 0;
  JSON.parse = function (text, ...rest) {
    if (text === value) parses++;
    return original.call(this, text, ...rest);
  };
  try {
    const result = inspect([xml(`<ImportExportXml>${definitions}${values}</ImportExportXml>`)]);
    assert.deepEqual(result.ids, []);
    assert.ok(parses <= 1, 'shared typed values must not be reparsed for every repeated declaration');
  } finally {
    JSON.parse = original;
  }
});

const unpackedWithStandardFiles = () => [
  xml('<SolutionManifest><Version>1.0.0.0</Version></SolutionManifest>'),
  xml('<Entity><Name>inv_widget</Name></Entity>', 'Entities/inv_widget/Entity.xml'),
  xml('<RibbonDiffXml><CustomActions /></RibbonDiffXml>', 'Entities/inv_widget/RibbonDiff.xml'),
  entry('Entities/inv_widget/Formulas/inv_widget-FormulaDefinitions.yaml', 'inv_total: =1 + 1'),
  entry('WebResources/inv_/strings.json', '{"greeting":"hi"}'),
];

test('ribbon definitions, formula definitions and web resource content are recognized without rules', () => {
  const result = inspect(unpackedWithStandardFiles());
  const [dataverse] = result.coverage.domains;
  assert.equal(result.coverage.complete, true);
  assert.equal(dataverse.complete, true);
  assert.ok(!dataverse.skipped.some((skip) => skip.reason === 'unsupported-dataverse-metadata'));
  assert.ok(
    dataverse.limitations.includes(
      'Recognized without rules: formula definitions, ribbon definition, web resource content.',
    ),
  );
});

test('unknown Entities metadata beside the standard unpacked files is still skipped and incomplete', () => {
  const result = inspect([...unpackedWithStandardFiles(), xml('<SomethingElse />', 'Entities/inv_widget/Unknown.xml')]);
  const [dataverse] = result.coverage.domains;
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(dataverse.skipped, [
    { file: 'Entities/inv_widget/Unknown.xml', reason: 'unsupported-dataverse-metadata' },
  ]);
});

const customApiFiles = () => [
  xml(
    '<customapi><uniquename>inv_Ping</uniquename><bindingtype>0</bindingtype><plugintypeid>22222222-2222-4222-8222-222222222222</plugintypeid></customapi>',
    'customapis/inv_Ping/customapi.xml',
  ),
  xml(
    '<customapirequestparameter><uniquename>inv_Text</uniquename></customapirequestparameter>',
    'customapis/inv_Ping/customapirequestparameters/inv_Text/customapirequestparameter.xml',
  ),
  xml(
    '<customapiresponseproperty><uniquename>inv_Answer</uniquename></customapiresponseproperty>',
    'customapis/inv_Ping/customapiresponseproperties/inv_Answer/customapiresponseproperty.xml',
  ),
  xml(
    '<visualization><name>inv_chart</name></visualization>',
    'Entities/inv_widget/Visualizations/{11111111-1111-4111-8111-111111111111}.xml',
  ),
];

test('Custom API request parameters, response properties and chart definitions are recognized without rules', () => {
  const result = inspect(customApiFiles());
  const [dataverse] = result.coverage.domains;
  assert.equal(result.coverage.complete, true);
  assert.equal(dataverse.complete, true);
  assert.ok(!dataverse.skipped.some((skip) => skip.reason === 'unsupported-dataverse-metadata'));
  assert.ok(
    dataverse.limitations.includes(
      'Recognized without rules: chart definition, custom API request parameter, custom API response property.',
    ),
  );
});

test('unknown files under customapis stay skipped and incomplete beside recognized Custom API files', () => {
  const result = inspect([...customApiFiles(), xml('<SomethingElse />', 'customapis/inv_Ping/Unknown.xml')]);
  const [dataverse] = result.coverage.domains;
  assert.equal(result.coverage.complete, false);
  assert.deepEqual(dataverse.skipped, [
    { file: 'customapis/inv_Ping/Unknown.xml', reason: 'unsupported-dataverse-metadata' },
  ]);
});

test('a Dataverse XML finding points at the child element its field names, else at the owning element', (t) => {
  const root = tempDirSync('paq-dataverse-location-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'sdkmessageprocessingsteps'));
  fs.writeFileSync(
    path.join(root, 'sdkmessageprocessingsteps', 'step.xml'),
    [
      '<?xml version="1.0"?>',
      '<SdkMessageProcessingStep>',
      '  <Stage>20</Stage>',
      '  <Mode>1</Mode>',
      '  <SdkMessageName>Update</SdkMessageName>',
      '</SdkMessageProcessingStep>',
      '',
    ].join('\n'),
  );
  const findings = analyzeProject(root, { failOn: 'none' }).findings;
  const stage = findings.find(({ ruleId }) => ruleId === 'DV-PLUGIN-003');
  const filtering = findings.find(({ ruleId }) => ruleId === 'DV-PLUGIN-001');
  assert.deepEqual([stage.line, stage.column, stage.field], [3, 3, 'stage']);
  assert.deepEqual([filtering.line, filtering.column], [2, 1]);
});
