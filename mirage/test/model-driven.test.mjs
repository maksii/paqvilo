import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import nativeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { solutionApps, appCatalogue } from '../lib/model-driven/catalogue.mjs';
import { compileForm, parseAppDefinitions, parseSiteMap } from '../lib/model-driven/solution.mjs';
import { parseSolutionXml } from '../lib/solution-xml.mjs';
import { columnIcon } from '../lib/model-driven/icons.mjs';

// Read-only HTTP tests share one runtime; tests that write or restart start their own.
let shared;
const cleanup = [];

test('lazy table bodies retain provenance without reopening every root client resource', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-catalogue-resources-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'invented.js');
  await fs.writeFile(file, '// Invented client resource\n');
  const metadata = {
    entities: Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => ['x_item' + i, { fields: { x_name: { dataverseType: 'nvarchar' } } }]),
    ),
  };
  const mappings = Object.fromEntries(Object.keys(metadata.entities).map((name) => [name, { nameColumn: 'x_name' }]));
  const options = {
    metadata,
    mappings,
    providers: [],
    clientExtensions: { resources: [{ name: 'invented.js', sourceFile: file }] },
  };
  const eager = appCatalogue(options);
  const catalogue = appCatalogue({ ...options, lazy: true });
  assert.deepEqual(catalogue.provenanceRefs, eager.provenanceRefs);
  assert.ok(catalogue.provenanceRefs.some((ref) => ref.componentKey === 'resource:invented.js'));
  const open = nativeFs.openSync;
  let resourceReads = 0;
  try {
    nativeFs.openSync = (target, ...args) => {
      if (path.resolve(String(target)) === file) resourceReads++;
      return open(target, ...args);
    };
    for (const name of Object.keys(catalogue.tables)) assert.deepEqual(catalogue.tables[name], eager.tables[name]);
  } finally {
    nativeFs.openSync = open;
  }
  assert.equal(
    resourceReads,
    0,
    'Root resource references are computed once; table source references remain complete.',
  );
});
before(async () => {
  shared = await modelDrivenFixture({ after: (fn) => cleanup.push(fn) });
});
after(async () => {
  for (const fn of cleanup) await fn();
});
// Tests that only import edited Solution sources change a private copy of the shared fixture's Solution, without
// starting a runtime for it.
async function solutionCopy(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-solution-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solutionDir = path.join(root, 'solution');
  await fs.cp(shared.solutionDir, solutionDir, { recursive: true });
  return { solutionDir };
}

test('lazy table construction retains the full imported source, application, lookup and control contract', async () => {
  const scan = await scanSolutionSources([shared.solutionDir]);
  const imported = await importSolutionMetadata([shared.solutionDir], { scan });
  const options = {
    metadata: { ...imported, modelDrivenApps: solutionApps(scan) },
    mappings: {
      x_item: { idColumn: 'x_itemid', nameColumn: 'x_name' },
      x_related: { idColumn: 'x_relatedid', fields: { x_name: { type: 'text' } } },
    },
    settings: { timeZoneOffsetMinutes: 120 },
    clientExtensions: { trusted: true, resources: [], pcf: [] },
    canvasApps: ['x_invented_page'],
  };
  const eager = appCatalogue(options),
    lazy = appCatalogue({ ...options, lazy: true });
  assert.ok(eager.tables.x_item.provenanceRefs.length, 'The comparison includes imported source references');
  for (const name of Object.keys(eager.tables).reverse()) assert.deepEqual(lazy.tables[name], eager.tables[name], name);
  assert.deepEqual(JSON.parse(JSON.stringify(lazy)), JSON.parse(JSON.stringify(eager)));
});

test('the lazy table index does not normalize every unrelated field and control', () => {
  let reads = 0,
    relationshipReads = 0;
  const field = {
    dataverseType: 'nvarchar',
    get format() {
      reads++;
      return 'email';
    },
  };
  const mappings = Object.fromEntries(
    Array.from({ length: 64 }, (_, i) => [
      'x_wide' + i,
      {
        idColumn: 'x_id',
        nameColumn: 'x_name',
        fields: Object.fromEntries(Array.from({ length: 128 }, (_, j) => ['x_value' + j, field])),
        relationships: Object.fromEntries(
          Array.from({ length: 128 }, (_, j) => [
            'x_link' + j,
            {
              entity: 'x_target',
              get alias() {
                relationshipReads++;
                return 'Invented target';
              },
            },
          ]),
        ),
      },
    ]),
  );
  const lazy = appCatalogue({ mappings, lazy: true });
  assert.equal(Object.keys(lazy.tables).length, 64);
  assert.equal(reads, 0, 'Navigation headers do not prepare unrelated field controls');
  assert.equal(relationshipReads, 0, 'Navigation headers do not copy unrelated relationship bodies');
  const selected = lazy.tables.x_wide0;
  assert.equal(Object.keys(selected.fields).length, 130);
  assert.ok(reads > 0 && reads <= 128, `Only selected fields were prepared (${reads})`);
  assert.equal(selected.fields.x_value127.format, 'email');
  assert.equal(relationshipReads, 128, 'The selected table retains all relationship definitions');
  assert.equal(selected.relationships.x_link127.alias, 'Invented target');
});

test('source navigation admits bounded imported table-view pages and leaves remote or unknown destinations unavailable', () => {
  const areas = parseSiteMap(
    '<SiteMap><Area Id="work"><Group Id="planning"><SubArea Id="all" Entity="x_item"/><SubArea Id="upper" Url="/main.aspx?appid=77777777-7777-4777-8777-777777777777&amp;pagetype=entitylist&amp;etn=x_item&amp;viewid={upper-view}&amp;viewType=1039"/><SubArea Id="missing" Url="main.aspx?pagetype=entitylist&amp;etn=x_item&amp;viewid=missing-view"/><SubArea Id="remote" Url="https://example.invalid/main.aspx?pagetype=entitylist&amp;etn=x_item"/><SubArea Id="record" Url="/main.aspx?pagetype=entityrecord&amp;etn=x_item"/><SubArea Id="script" Url="javascript:alert(1)"/><SubArea Id="unmapped" Url="/main.aspx?pagetype=entitylist&amp;etn=x_absent"/></Group></Area></SiteMap>',
  );
  assert.equal(areas[0].groups[0].items[1].view, 'upper-view');
  const catalogue = appCatalogue({
    providers: [
      {
        tables: {
          x_item: {
            entity: 'x_item',
            idColumn: 'x_itemid',
            nameColumn: 'x_name',
            fields: { x_name: { type: 'text' } },
          },
        },
        apps: [{ id: 'x_example', name: 'Invented', navigation: areas }],
      },
    ],
    metadata: { views: [{ entity: 'x_item', id: 'upper-view', name: 'Upper items', queryType: 0 }] },
  });
  const entries = catalogue.apps[0].navigation[0].groups[0].items;
  assert.deepEqual(
    entries.map((item) => item.supported),
    [true, true, false, false, false, false, false],
  );
  assert.match(entries[2].reason, /view that is not imported/);
  assert.match(entries[6].reason, /no imported metadata/);
});

test('navigation resolves only known native application IDs without mistaking derived local IDs for native mismatches', () => {
  const ownerId = '77777777-7777-4777-8777-777777777777',
    otherId = '88888888-8888-4888-8888-888888888888';
  const navigation = parseSiteMap(
    `<SiteMap><Area Id="main"><Group Id="pages"><SubArea Id="own" Url="/main.aspx?appid=${ownerId}&amp;pagetype=entitylist&amp;etn=x_item"/><SubArea Id="other" Url="/main.aspx?appid=${otherId}&amp;pagetype=entitylist&amp;etn=x_item"/><SubArea Id="unknown" Url="/main.aspx?appid=99999999-9999-4999-8999-999999999999&amp;pagetype=entitylist&amp;etn=x_item"/><SubArea Id="inherited" Url="/main.aspx?pagetype=entitylist&amp;etn=constructor"/></Group></Area></SiteMap>`,
  );
  const tables = {
    x_item: { entity: 'x_item', idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { type: 'text' } } },
  };
  const catalogue = appCatalogue({
    providers: [
      {
        tables,
        apps: [
          { id: ownerId, idSource: 'exported', navigation },
          { id: otherId, idSource: 'exported', navigation: [] },
        ],
      },
    ],
  });
  const entries = catalogue.apps[0].navigation[0].groups[0].items;
  assert.equal(entries[0].targetApplicationId, ownerId);
  assert.equal(entries[1].targetApplicationId, otherId);
  assert.equal(entries[1].supported, true);
  assert.equal(entries[2].supported, false);
  assert.match(entries[2].reason, /application that is not imported/);
  assert.equal(entries[3].supported, false);
  const derived = appCatalogue({
    providers: [{ tables, apps: [{ id: 'derived-id', idSource: 'derived-local', navigation }] }],
  });
  const derivedPage = derived.apps[0].navigation[0].groups[0].items[0];
  assert.equal(derivedPage.supported, true);
  assert.equal(derivedPage.targetApplicationId, undefined);
});

test('source view destinations honor the target application view components before enabling navigation', () => {
  const page = (id, applicationId, entity, view) =>
    `<SubArea Id="${id}" Url="/main.aspx?appid=${applicationId}&amp;pagetype=entitylist&amp;etn=${entity}&amp;viewid=${view}"/>`;
  const navigation = parseSiteMap(
    `<SiteMap><Area Id="main"><Group Id="pages">${page('own-allowed', 'owner', 'x_item', 'allowed-view')}${page('own-excluded', 'owner', 'x_item', 'excluded-view')}${page('cross-allowed', 'target', 'x_item', 'excluded-view')}${page('cross-excluded', 'target', 'x_item', 'allowed-view')}${page('child', 'owner', 'x_child', 'child-view')}</Group></Area></SiteMap>`,
  );
  const definition = (entity) => ({
    entity,
    idColumn: `${entity}id`,
    nameColumn: 'x_name',
    fields: { x_name: { type: 'text' } },
  });
  const catalogue = appCatalogue({
    providers: [
      {
        tables: { x_item: definition('x_item'), x_child: definition('x_child') },
        apps: [
          { id: 'owner', idSource: 'exported', navigation, components: [{ type: 26, id: '{ALLOWED-VIEW}' }] },
          { id: 'target', idSource: 'exported', navigation: [], components: [{ type: 26, id: 'excluded-view' }] },
        ],
      },
    ],
    metadata: {
      views: [
        { entity: 'x_item', id: 'allowed-view', queryType: 0 },
        { entity: 'x_item', id: 'excluded-view', queryType: 0 },
        { entity: 'x_child', id: 'child-view', queryType: 0 },
      ],
    },
  });
  const entries = catalogue.apps[0].navigation[0].groups[0].items;
  assert.deepEqual(
    entries.map((item) => item.supported),
    [true, false, true, false, true],
  );
  assert.equal(entries[0].view, 'allowed-view');
  assert.equal(entries[2].view, 'excluded-view');
  assert.equal(entries[2].targetApplicationId, 'target');
  assert.match(entries[1].reason, /view that is not available to its imported application/);
});

test('column browser glyphs retain source Boolean, choice, lookup, money, file and image identities', () => {
  const types = [
    [{ type: 'boolean' }, 'booleanColumn'],
    [{ type: 'number', options: [] }, 'choiceColumn'],
    [{ type: 'number', dataverseType: 'int' }, 'numericColumn'],
    [{ type: 'number', dataverseType: 'money' }, 'moneyColumn'],
    [{ type: 'lookup', dataverseType: 'owner' }, 'person'],
    [{ type: 'lookup' }, 'lookupColumn'],
    [{ type: 'text', dataverseType: 'file' }, 'help'],
    [{ type: 'text', dataverseType: 'image' }, 'imageColumn'],
    [{ type: 'date' }, 'calendar'],
    [{ type: 'textarea' }, 'text'],
  ];
  for (const [field, expected] of types) assert.equal(columnIcon(field), expected);
});

test('application cards retain exported localized descriptions and icon identities', () => {
  const source = parseSolutionXml(
    '<AppModule><UniqueName>x_inventory</UniqueName><Descriptions><Description description="Invented inventory" languagecode="1033"/><Description description="Invented translated inventory" languagecode="1036"/></Descriptions><WebResourceId>{77777777-7777-4777-8777-777777777777}</WebResourceId></AppModule>',
  );
  const application = parseAppDefinitions(source, { lcid: 1036 }).apps[0];
  assert.equal(application.description, 'Invented translated inventory');
  assert.equal(application.descriptionLabels['1033'], 'Invented inventory');
  assert.equal(application.iconResourceId, '77777777-7777-4777-8777-777777777777');
});

test('exported collection-name tags localize table labels even when a provider already defines the table', async (t) => {
  const { solutionDir } = await solutionCopy(t);
  const entityFile = path.join(solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '<PrimaryIdAttribute>',
      '<LocalizedCollectionNames><LocalizedCollectionName description="Invented items" languagecode="1033"/><LocalizedCollectionName description="Translated invented items" languagecode="1036"/></LocalizedCollectionNames><PrimaryIdAttribute>',
    ),
  );
  const scan = await scanSolutionSources([solutionDir]),
    metadata = await importSolutionMetadata([solutionDir], { scan, lcid: 1036 });
  assert.equal(metadata.entities.x_item.collectionLabel, 'Translated invented items');
  const catalogue = appCatalogue({
    metadata,
    providers: [
      {
        tables: {
          x_item: {
            entity: 'x_item',
            label: 'Old provider plural',
            singular: 'Old provider singular',
            idColumn: 'x_itemid',
            nameColumn: 'x_name',
            fields: metadata.entities.x_item.fields,
          },
        },
      },
    ],
  });
  assert.equal(catalogue.tables.x_item.label, 'Translated invented items');
  assert.equal(catalogue.tables.x_item.singular, 'Item');
});

test('view ordering and add-column eligibility follow exported defaults and column facts', () => {
  const catalogue = appCatalogue({
    providers: [
      {
        tables: {
          x_sample: {
            entity: 'x_sample',
            label: 'Samples',
            singular: 'Sample',
            idColumn: 'x_sampleid',
            nameColumn: 'x_name',
            fields: {
              x_name: { type: 'text', columnMetadata: { displayMask: 'PrimaryName|ValidForGrid|ValidForForm' } },
              x_formonly: { type: 'text', columnMetadata: { displayMask: 'ValidForForm' } },
              x_logical: { type: 'text', columnMetadata: { isLogical: true, displayMask: 'ValidForGrid' } },
              x_unknown: { type: 'text' },
            },
          },
        },
      },
    ],
    metadata: {
      views: [
        { entity: 'x_sample', queryType: 0, id: 'alpha', name: 'Alpha' },
        { entity: 'x_sample', queryType: 0, id: 'zulu', name: 'Zulu', isDefault: true },
        { entity: 'x_sample', queryType: 0, id: 'beta', name: 'Beta' },
      ],
    },
  });
  assert.deepEqual(
    catalogue.tables.x_sample.views.map((view) => view.id),
    ['zulu', 'alpha', 'beta'],
  );
  assert.equal(catalogue.tables.x_sample.fields.x_name.validForGrid, true);
  assert.equal(catalogue.tables.x_sample.fields.x_formonly.validForGrid, false);
  assert.equal(catalogue.tables.x_sample.fields.x_logical.validForGrid, false);
  assert.equal(catalogue.tables.x_sample.fields.x_unknown.validForGrid, undefined);
});

test('form layout retains exported columns, hidden sections, row positions and spanning fields', () => {
  const form = compileForm(
    {
      id: 'layout',
      xml: '<form><tabs><tab name="general"><columns><column width="70%"><sections><section columns="11" showlabel="false"><rows><row><cell><control datafieldname="x_name"/></cell><cell><control datafieldname="x_quantity"/></cell></row><row><cell colspan="2" rowspan="5"><control datafieldname="x_notes"/></cell></row></rows></section></sections></column><column width="30%"><sections><section visible="false"><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>',
    },
    { x_name: {}, x_quantity: {}, x_notes: {} },
  );
  const tab = form.tabs[0];
  assert.deepEqual(tab.columnWidths, [70, 30]);
  assert.equal(tab.sections[0].showLabel, false);
  assert.equal(tab.sections[0].columns, 2);
  assert.deepEqual(
    tab.sections[0].fields.map(({ row, column, colspan }) => ({ row, column, colspan })),
    [
      { row: 0, column: 0, colspan: 1 },
      { row: 0, column: 1, colspan: 1 },
      { row: 1, column: 0, colspan: 2 },
    ],
  );
  assert.equal(tab.sections[1].column, 1);
  assert.equal(tab.sections[1].visible, false);
  assert.equal(tab.sections[0].fields[2].rowspan, 5);
  assert.equal(tab.sections[0].fields[0].rowspan, undefined);
});

test('legacy text class IDs do not override state choice metadata or source permissions', () => {
  const form = compileForm(
    {
      id: 'state-layout',
      xml: '<form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control datafieldname="x_state" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}"/></cell><cell><control datafieldname="x_state" classid="{3EF39988-22BB-4F0B-BBBE-64B5A3748AEE}"/></cell><cell><control datafieldname="x_name" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>',
    },
    { x_state: { dataverseType: 'state' }, x_name: { dataverseType: 'nvarchar' } },
  );
  const fields = form.tabs[0].sections[0].fields;
  assert.equal(fields[0].readOnlyText, undefined);
  assert.equal(fields[0].disabled, false);
  assert.equal(fields[1].readOnlyText, undefined);
  assert.equal(fields[1].disabled, false);
  assert.equal(fields[2].readOnlyText, undefined);
  assert.equal(fields[2].disabled, false);
});

test('source form matrices preserve spacer cells, row spans, labels and ordered two and three column groups', () => {
  const control = (name) => `<control datafieldname="${name}"/>`;
  const section = (rows) =>
    `<section columns="3" labelwidth="135" celllabelposition="Top" celllabelalignment="Right"><rows>${rows}</rows></section>`;
  const left = section(
    `<row><cell rowspan="2">${control('x_notes')}</cell><cell colspan="2">${control('x_name')}</cell></row><row><cell/> <cell showlabel="false">${control('x_quantity')}</cell></row><row><cell colspan="2"/> <cell visible="false">${control('x_hidden')}</cell></row>`,
  );
  const xml = `<form><tabs><tab name="two"><columns><column width="65%"><sections>${left}</sections></column><column width="35%"><sections><section showlabel="false"><rows><row><cell><control datafieldname="x_readonly" disabled="true"/></cell></row></rows></section></sections></column></columns></tab><tab name="three"><columns>${[34, 33, 33].map((width, index) => `<column width="${width}%"><sections><section><labels><label description="Group ${index}" languagecode="1033"/></labels><rows><row><cell>${control(`x_field${index}`)}</cell></row></rows></section></sections></column>`).join('')}</columns></tab></tabs></form>`;
  const fields = Object.fromEntries(
    ['x_notes', 'x_name', 'x_quantity', 'x_hidden', 'x_readonly', 'x_field0', 'x_field1', 'x_field2'].map((name) => [
      name,
      { type: 'text' },
    ]),
  );
  const form = compileForm({ id: 'matrix', xml }, fields);
  assert.deepEqual(
    form.tabs.map((tab) => tab.columnWidths),
    [
      [65, 35],
      [34, 33, 33],
    ],
  );
  const [matrix, right] = form.tabs[0].sections;
  assert.deepEqual(
    matrix.fields.map(({ name, spacer, row, column, colspan, rowspan }) => ({
      name,
      spacer,
      row,
      column,
      colspan,
      rowspan,
    })),
    [
      { name: 'x_notes', spacer: undefined, row: 0, column: 0, colspan: 1, rowspan: 2 },
      { name: 'x_name', spacer: undefined, row: 0, column: 1, colspan: 2, rowspan: undefined },
      { name: undefined, spacer: true, row: 1, column: 1, colspan: 1, rowspan: undefined },
      { name: 'x_quantity', spacer: undefined, row: 1, column: 2, colspan: 1, rowspan: undefined },
      { name: undefined, spacer: true, row: 2, column: 0, colspan: 2, rowspan: undefined },
      { name: 'x_hidden', spacer: undefined, row: 2, column: 2, colspan: 1, rowspan: undefined },
    ],
  );
  assert.equal(matrix.fields[3].showLabel, false);
  assert.equal(matrix.fields[5].visible, false);
  assert.equal(matrix.labelWidth, 135);
  assert.equal(matrix.labelPosition, 'top');
  assert.equal(matrix.labelAlignment, 'right');
  assert.equal(right.showLabel, false);
  assert.equal(right.fields[0].disabled, true);
  assert.deepEqual(
    form.tabs[1].sections.map((section) => [section.column, section.label, section.fields[0].name]),
    [
      [0, 'Group 0', 'x_field0'],
      [1, 'Group 1', 'x_field1'],
      [2, 'Group 2', 'x_field2'],
    ],
  );
  const occupied = compileForm(
    {
      id: 'occupied',
      xml: '<form><tabs><tab><columns><column><sections><section columns="1111"><rows><row><cell/><cell rowspan="2"><control datafieldname="x_notes"/></cell><cell colspan="2"/></row><row><cell colspan="2"><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>',
    },
    fields,
  );
  assert.equal(
    occupied.tabs[0].sections[0].fields.at(-1).column,
    2,
    'a spanned cell requires a contiguous free range after prior-row occupancy',
  );
});

test('model-driven app catalogue imports solution navigation, forms and views alongside the default management app', async () => {
  const { origin } = shared;
  const response = await fetch(origin + '/_apps/api');
  assert.equal(response.status, 200);
  const catalogue = await response.json();
  assert.equal(catalogue.defaultApp, 'power-pages-management');
  const app = catalogue.apps.find((app) => app.uniqueName === 'x_example');
  assert.ok(app);
  assert.equal(app.navigation[0].groups[0].items[0].entity, 'x_item');
  assert.equal(app.navigation[0].groups[0].items[1].supported, false);
  assert.equal(catalogue.tables.x_item.forms[0].source, 'solution');
  assert.equal(catalogue.tables.x_item.views[0].name, 'Stocked items');
  assert.equal(catalogue.tables.x_item.rows, undefined);
  const shell = await fetch(origin + '/main.aspx');
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /<title>Mirage Apps<\/title>[\s\S]*<strong>Mirage Apps<\/strong>/);
  assert.equal(catalogue.apps.find((app) => app.id === 'power-pages-management')?.name, 'Mirage Site Manager');
  assert.equal(
    catalogue.apps.find((app) => app.id === 'power-pages-management')?.uniqueName,
    'mspp_PowerPageManagement',
  );
  assert.match(shell.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('grid runs saved FetchXML with search, filters, columns, sorting and paging', async () => {
  const { origin } = shared;
  const list = async (query) => {
    const response = await fetch(
      origin + '/_apps/api/tables/x_item?query=' + encodeURIComponent(JSON.stringify(query)),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const first = await list({ pageSize: 1, sort: 'x_quantity', direction: 'desc' });
  assert.equal(first.rows[0].x_name, 'Silver');
  assert.equal(first.total, 2);
  assert.equal(first.more, true);
  const search = await list({
    search: 'opp',
    columns: ['x_name'],
    filters: [{ field: 'x_quantity', operator: 'lt', value: 5 }],
  });
  assert.equal(search.rows.length, 1);
  assert.equal(search.rows[0].x_name, 'Copper');
  const raw = await list({
    scope: 'table',
    columns: ['x_name'],
    filters: [{ field: 'x_quantity', operator: 'eq', value: 0 }],
  });
  assert.equal(raw.rows.length, 1);
  assert.equal(raw.rows[0].x_name, 'Empty', 'Client API table queries do not inherit saved-view filters.');
  const invalid = await fetch(
    origin +
      '/_apps/api/tables/x_item?query=' +
      encodeURIComponent(JSON.stringify({ filters: [{ field: 'unknown', operator: 'eq', value: 1 }] })),
  );
  assert.equal(invalid.status, 400);
});

test('native text filter operations match literal substrings and retain explicit LIKE patterns', async (t) => {
  const { origin, sim } = await modelDrivenFixture(t);
  for (const x_name of ['Literal %_[box]', 'Literal AAbox', 'Other %_[box]']) {
    const response = await fetch(origin + '/_apps/api/tables/x_item', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ x_name, x_quantity: 1 }),
    });
    assert.equal(response.status, 201);
  }
  const names = async (operator, value) => {
    const response = await fetch(
      origin +
        '/_apps/api/tables/x_item?query=' +
        encodeURIComponent(JSON.stringify({ filters: [{ field: 'x_name', operator, value }] })),
    );
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).rows.map((row) => row.x_name);
  };
  assert.deepEqual(await names('contains', '%_[box]'), ['Literal %_[box]', 'Other %_[box]']);
  assert.deepEqual(await names('not-contains', '%_[box]'), ['Copper', 'Literal AAbox', 'Silver']);
  assert.deepEqual(await names('begins-with', 'Literal %_['), ['Literal %_[box]']);
  assert.deepEqual(await names('ends-with', '%_[box]'), ['Literal %_[box]', 'Other %_[box]']);
  assert.deepEqual(await names('like', 'Literal %'), ['Literal %_[box]', 'Literal AAbox']);
  assert.deepEqual(await names('not-like', 'Literal %'), ['Copper', 'Other %_[box]', 'Silver']);
});

test('local CRUD requires CSRF, validates values and rejects stale writes', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const shell = await (await fetch(origin + '/main.aspx')).text(),
    csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const request = (method, suffix, values, etag) =>
    fetch(origin + '/_apps/api/tables/x_item' + suffix, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...(etag ? { 'if-match': etag } : {}) },
      ...(values ? { body: JSON.stringify(values) } : {}),
    });
  assert.equal((await fetch(origin + '/_apps/api/tables/x_item', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request('POST', '', { x_name: 'Bad', x_quantity: 'invalid' })).status, 400);
  const createdResponse = await request('POST', '', { x_name: 'Gold', x_quantity: 4 });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();
  const id = created.row.x_itemid;
  assert.equal((await request('PATCH', '/' + id, { x_quantity: 6 })).status, 428);
  const updated = await request('PATCH', '/' + id, { x_quantity: 6 }, created.etag);
  assert.equal(updated.status, 200);
  assert.equal((await request('PATCH', '/' + id, { x_quantity: 7 }, created.etag)).status, 412);
  const read = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(read.row.x_quantity, 6);
  assert.equal((await request('DELETE', '/' + id, null, read.etag)).status, 200);
});

test('management edits recompile the local portal, persist across restarts, and leave source files untouched', async (t) => {
  const fixture = await modelDrivenFixture(t),
    { origin, sourceDir } = fixture;
  const before = await fs.readFile(path.join(sourceDir, 'content-snippets/Welcome.contentsnippet.value.html'), 'utf8');
  const shell = await (await fetch(origin + '/main.aspx')).text(),
    csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const endpoint = '/_apps/api/tables/adx_contentsnippet/55555555-5555-4555-8555-555555555555';
  const current = await (await fetch(origin + endpoint)).json();
  assert.equal(current.row.adx_value, before);
  const response = await fetch(origin + endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, 'if-match': current.etag },
    body: JSON.stringify({ adx_value: 'Changed locally' }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(await (await fetch(origin + '/')).text(), /Changed locally/);
  assert.equal(
    await fs.readFile(path.join(sourceDir, 'content-snippets/Welcome.contentsnippet.value.html'), 'utf8'),
    before,
  );
  await fixture.sim.close();
  const restarted = await fixture.start();
  ownedFixture(t).add(() => restarted.close());
  assert.match(await (await fetch((restarted.origin ?? restarted.url) + '/')).text(), /Changed locally/);
});

test('management creates related customization records and auxiliary websites without replacing the source website', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const shell = await (await fetch(origin + '/main.aspx')).text(),
    csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const call = (method, entity, values, id, etag) =>
    fetch(origin + '/_apps/api/tables/' + entity + (id ? '/' + id : ''), {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, ...(etag ? { 'if-match': etag } : {}) },
      ...(values ? { body: JSON.stringify(values) } : {}),
    });
  const primary = '11111111-1111-4111-8111-111111111111';
  const related = await fetch(
    origin +
      '/_apps/api/tables/adx_sitesetting?query=' +
      encodeURIComponent(JSON.stringify({ filters: [{ field: 'adx_websiteid', operator: 'eq', value: primary }] })),
  );
  assert.equal((await related.json()).rows.length, 1, 'Source membership supplies the implicit website lookup.');
  const createdResponse = await call('POST', 'adx_sitesetting', {
    adx_name: 'Example/New',
    adx_value: 'Local value',
    adx_websiteid: primary,
  });
  assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
  const created = await createdResponse.json();
  assert.equal(
    (await call('DELETE', 'adx_sitesetting', null, created.row.adx_sitesettingid, created.etag)).status,
    200,
  );
  const secondaryResponse = await call('POST', 'adx_website', { adx_name: 'Secondary configuration' });
  assert.equal(secondaryResponse.status, 201, await secondaryResponse.clone().text());
  const secondary = await secondaryResponse.json();
  assert.equal((await (await fetch(origin + '/_apps/api/tables/adx_website')).json()).rows.length, 2);
  assert.match(await (await fetch(origin + '/')).text(), /Hello from the export/);
  assert.equal((await call('DELETE', 'adx_website', null, secondary.row.adx_websiteid, secondary.etag)).status, 200);
  const original = await (await fetch(origin + '/_apps/api/tables/adx_website/' + primary)).json();
  assert.equal((await call('DELETE', 'adx_website', null, primary, original.etag)).status, 501);
  const rejected = await call('PATCH', 'adx_website', { adx_name: '' }, primary, original.etag);
  assert.equal(rejected.status, 400);
});

test('app assets stay origin-confined and reject unknown resources, cross-origin writes and inherited table names', async () => {
  const { origin } = shared;
  assert.equal((await fetch(origin + '/_apps/assets/missing.mjs')).status, 404);
  assert.equal((await fetch(origin + '/_apps/api/tables/constructor')).status, 404);
  assert.equal(
    (
      await fetch(origin + '/_apps/api/tables/x_item', {
        method: 'POST',
        headers: { origin: 'https://example.invalid', 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
});

test('sparse customization overlays retain later source changes to untouched sibling fields', async (t) => {
  const fixture = await modelDrivenFixture(t),
    { origin, sourceDir } = fixture;
  const shell = await (await fetch(origin + '/main.aspx')).text(),
    csrf = /name="mirage-csrf" content="([^"]+)/.exec(shell)[1];
  const endpoint = '/_apps/api/tables/adx_sitesetting/66666666-6666-4666-8666-666666666666';
  const current = await (await fetch(origin + endpoint)).json();
  const response = await fetch(origin + endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf, 'if-match': current.etag },
    body: JSON.stringify({ adx_value: 'Local value', adx_name: current.row.adx_name }),
  });
  assert.equal(response.status, 200);
  await fixture.sim.close();
  await fs.writeFile(
    path.join(sourceDir, 'site-settings/Mode.sitesetting.yml'),
    'adx_sitesettingid: 66666666-6666-4666-8666-666666666666\nadx_name: Example/NewSourceName\nadx_value: New source value',
  );
  const restarted = await fixture.start();
  ownedFixture(t).add(() => restarted.close());
  const read = await (await fetch(restarted.url + endpoint)).json();
  assert.equal(read.row.adx_name, 'Example/NewSourceName');
  assert.equal(read.row.adx_value, 'Local value');
});

test('monolithic solution metadata imports app forms, views and navigation with no portal-form dependency', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-embedded-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'embedded.xml');
  await fs.writeFile(
    file,
    '<ImportExportXml><Entities><Entity><Name>x_embedded</Name><EntityInfo><entity Name="x_embedded"><attributes><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo><FormXml><forms type="main"><systemform><formid>{embedded-form}</formid><type>2</type><form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml><SavedQueries><savedquery><savedqueryid>{embedded-view}</savedqueryid><querytype>0</querytype><fetchxml><fetch><entity name="x_embedded"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="100"/></row></grid></layoutxml></savedquery></SavedQueries></Entity></Entities><AppModules><AppModule><UniqueName>x_embedded_app</UniqueName><AppModuleId>embedded-app</AppModuleId><SiteMap><Area Id="main"><Group Id="items"><SubArea Id="items" Entity="x_embedded"/></Group></Area></SiteMap></AppModule></AppModules></ImportExportXml>',
  );
  const scan = await scanSolutionSources([file]);
  const metadata = await importSolutionMetadata([file], { scan });
  assert.equal(metadata.forms[0].id, 'embedded-form');
  assert.equal(metadata.views[0].id, 'embedded-view');
  assert.equal(solutionApps(scan)[0].navigation[0].groups[0].items[0].entity, 'x_embedded');
  const catalogue = appCatalogue({
    portal: { website: {}, records: [], format: 'enhanced' },
    metadata: { ...metadata, modelDrivenApps: solutionApps(scan) },
    mappings: { x_embedded: { idColumn: 'x_embeddedid', nameColumn: 'x_name' } },
  });
  const app = catalogue.apps.find((app) => app.uniqueName === 'x_embedded_app');
  assert.equal(app.navigation[0].groups[0].items[0].title, 'X Embedded');
});

test('table default desktop grid pagination flows from source facts into the app catalogue without form PCF leakage', async (t) => {
  const { solutionDir } = await solutionCopy(t);
  const entityFile = path.join(solutionDir, 'Entities/x_item/Entity.xml'),
    original = await fs.readFile(entityFile, 'utf8');
  const config = (name, factor, value) =>
    `<customControl name="${name}" formFactor="${factor}"><parameters>${value === undefined ? '' : `<EnablePagination static="true" type="Enum">${value}</EnablePagination>`}</parameters></customControl>`;
  for (const [controls, expected] of [
    [config('Microsoft.PowerApps.PowerAppsOneGrid', 0, 'yes'), true],
    [config('Microsoft.PowerApps.PowerAppsOneGrid', 0, 'no'), false],
    [config('Microsoft.PowerApps.PowerAppsOneGrid', 0), false],
    [config('Microsoft.PowerApps.PowerAppsOneGrid', 1, 'yes'), undefined],
    [config('Invented.CustomGrid', 0, 'no'), undefined],
  ]) {
    await fs.writeFile(
      entityFile,
      original.replace(
        '</Entity>',
        `<CustomControlDefaultConfigs><CustomControlDefaultConfig><ControlDescriptionXML><controlDescriptions><controlDescription>${controls}</controlDescription></controlDescriptions></ControlDescriptionXML></CustomControlDefaultConfig></CustomControlDefaultConfigs><FormXml><customControl name="Microsoft.PowerApps.PowerAppsOneGrid" formFactor="0"><parameters><EnablePagination>no</EnablePagination></parameters></customControl></FormXml></Entity>`,
      ),
    );
    const scan = await scanSolutionSources([solutionDir]),
      metadata = await importSolutionMetadata([solutionDir], { scan });
    assert.equal(metadata.entities.x_item.grid?.pagination, expected);
    const catalogue = appCatalogue({
      metadata,
      providers: [
        {
          tables: {
            x_item: {
              entity: 'x_item',
              idColumn: 'x_itemid',
              nameColumn: 'x_name',
              fields: metadata.entities.x_item.fields,
            },
          },
        },
      ],
    });
    assert.equal(catalogue.tables.x_item.grid?.pagination, expected);
    assert.equal(metadata.entities.x_child.grid, undefined);
  }
});
