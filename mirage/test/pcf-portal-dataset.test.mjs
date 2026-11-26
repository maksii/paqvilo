// @test-kind contract: Paqvilo's Power Pages dataset PCF binding (columns, types, transports, diagnostics) built from exported metadata with invented fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';
import { applyPcfGridFilter, pcfGridUpdate } from '../lib/pcf-grid-query.mjs';
import { parseFetchTree, protectConfiguration, serializeFetchTree } from '../lib/native-services.mjs';
import { pcfSettings } from '../lib/pcf-sources.mjs';
import { createSimulator } from '../server.mjs';
import { rowsDatasetControl, writeFixtureFiles } from './support/pcf-fixture-files.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const viewId = 'd0000000-0000-4000-8000-000000000002';

async function catalogWith(t, dataset) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-dataset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const control = path.join(dir, 'Controls', 'tst_Synthetic.Grid');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml'),
    `<manifest><control namespace="Synthetic" constructor="Grid" control-type="standard">${dataset}<resources><code path="bundle.js"/></resources></control></manifest>`,
  );
  await fs.writeFile(
    path.join(control, 'ControlManifest.xml.data.xml'),
    '<CustomControl><Name>tst_Synthetic.Grid</Name></CustomControl>',
  );
  await fs.writeFile(path.join(control, 'bundle.js'), 'ComponentFramework.registerControl("Synthetic.Grid",class{});');
  return importCodeComponents([{ dir }]);
}

/** The mount specification the rendered code component hands to the client host. */
function mountSpec(html) {
  const start = html.indexOf('__paqviloPcf.mount(') + '__paqviloPcf.mount('.length;
  return JSON.parse(html.slice(start, html.indexOf(', document.currentScript', start)));
}

const field = (dataverseType, extra = {}) => ({ label: extra.label, dataverseType, ...extra });
const metadata = (view) => ({
  entities: {
    tst_row: {
      label: 'Row',
      primaryNameAttribute: 'tst_title',
      fields: {
        tst_rowid: field('primarykey'),
        tst_title: field('nvarchar', { label: 'Title' }),
        tst_mail: field('nvarchar', { format: 'email' }),
        tst_site: field('nvarchar', { format: 'url' }),
        tst_notes: field('memo'),
        tst_text: field('ntext'),
        tst_flag: field('bit'),
        tst_ratio: field('float'),
        tst_double: field('double'),
        tst_number: field('decimal'),
        tst_amount: field('money'),
        tst_count: field('int'),
        tst_minutes: field('int', { format: 'duration' }),
        tst_day: field('datetime', { format: 'date' }),
        tst_day_local: field('datetime', { format: 'date', dateTimeBehavior: 'UserLocal' }),
        tst_when: field('datetime', { format: 'datetime' }),
        tst_choice: field('picklist'),
        statecode: field('state'),
        tst_choices: field('multiselectpicklist'),
        tst_parentid: field('lookup', { targets: ['tst_parent'] }),
        tst_customer: field('customer', { targets: ['account', 'contact'] }),
        ownerid: field('owner'),
        tst_parties: field('partylist'),
        tst_file: field('file'),
        tst_image: field('image'),
      },
    },
    tst_parent: {
      label: 'Parent',
      primaryNameAttribute: 'tst_label',
      fields: { tst_parentid: field('primarykey'), tst_label: field('nvarchar', { label: 'Label' }) },
    },
    tst_unmapped: { fields: { tst_unmappedid: field('primarykey') } },
  },
  views: [view],
});
const mappings = {
  tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' },
  tst_parent: { entitySet: 'tst_parents', idColumn: 'tst_parentid' },
};
const nativeDataset = {
  entity: 'tst_row',
  viewId,
  kind: 'list',
  pageSize: 3,
  service: '/s',
  update: '/u',
  secure: 'x',
};
const typeView = (names) => ({
  id: viewId,
  name: 'Rows',
  entity: 'tst_row',
  fields: names.map((name) => ({ name })),
  fetchXml: '<fetch><entity name="tst_row"><attribute name="tst_title"/></entity></fetch>',
});
const typesOf = async (t, names, extraFields = {}) => {
  const catalog = await catalogWith(t, '<data-set name="rows"/>');
  const exported = metadata(typeView(names));
  Object.assign(exported.entities.tst_row.fields, extraFields);
  const spec = mountSpec(
    renderCodeComponent({
      name: 'tst_Synthetic.Grid',
      portal: {},
      catalog,
      metadata: exported,
      mappings,
      nativeDataset,
    }),
  );
  return Object.fromEntries(spec.datasets[0].columns.map((column) => [column.name, column.dataType]));
};

// @test-kind observation: column dataType per attribute type on a Power Pages list and subgrid, live capture paqvilo-developer pcf-parity summary-C (Columns, r2 list-ny)
test('dataset columns report the captured dataType of each attribute type', async (t) => {
  assert.deepEqual(
    await typesOf(t, [
      'tst_title',
      'tst_mail',
      'tst_notes',
      'tst_text',
      'tst_count',
      'tst_number',
      'tst_ratio',
      'tst_double',
      'tst_amount',
      'tst_flag',
      'tst_choice',
      'statecode',
      'tst_choices',
      'tst_day',
      'tst_day_local',
      'tst_when',
      'tst_parentid',
      'tst_customer',
    ]),
    {
      tst_title: 'SingleLine.Text',
      tst_mail: 'SingleLine.Email',
      tst_notes: 'SingleLine.Text',
      tst_text: 'SingleLine.Text',
      tst_count: 'Whole.None',
      tst_number: 'Decimal',
      tst_ratio: 'Decimal',
      tst_double: 'Decimal',
      tst_amount: 'Money',
      tst_flag: 'TwoOptions',
      tst_choice: 'OptionSet',
      statecode: 'OptionSet',
      tst_choices: 'multiselectpicklist',
      tst_day: 'DateAndTime.DateOnly',
      tst_day_local: 'DateAndTime.DateOnly',
      tst_when: 'DateAndTime.DateAndTime',
      tst_parentid: 'lookup',
      tst_customer: 'customer',
    },
  );
});

// @test-kind observation: owner, lookup, text formats, whole-number formats, file, image, rich text and party list column dataTypes on a Power Pages list, live captures paqvilo-developer pcf-parity summary-F section 7 (runs fa and fb, views-list-ny and activity-list-ny, 2026-11-26) replayed on an invented table
test('owner, text-format, whole-number-format, file, image, rich text and party list columns report the captured dataType', async (t) => {
  assert.deepEqual(
    await typesOf(
      t,
      [
        'ownerid',
        'modifiedby',
        'tst_site',
        'tst_phone',
        'tst_ticker',
        'tst_area',
        'tst_minutes',
        'tst_zone',
        'tst_lang',
        'tst_file',
        'tst_image',
        'tst_rich',
        'tst_parties',
      ],
      {
        modifiedby: field('lookup', { targets: ['systemuser'] }),
        tst_phone: field('nvarchar', { format: 'phone' }),
        tst_ticker: field('nvarchar', { format: 'tickersymbol' }),
        tst_area: field('nvarchar', { format: 'textarea' }),
        tst_zone: field('int', { format: 'timezone' }),
        tst_lang: field('int', { format: 'language' }),
        tst_rich: field('memo', { format: 'richtext' }),
      },
    ),
    {
      ownerid: 'owner',
      modifiedby: 'lookup',
      tst_site: 'SingleLine.URL',
      tst_phone: 'SingleLine.Phone',
      tst_ticker: 'SingleLine.Ticker',
      tst_area: 'SingleLine.TextArea',
      tst_minutes: 'Whole.None',
      tst_zone: 'Whole.None',
      tst_lang: 'Whole.None',
      tst_file: 'SingleLine.Text',
      tst_image: 'SingleLine.Text',
      tst_rich: 'SingleLine.Text',
      tst_parties: 'partylist',
    },
  );
});

// @test-kind observation: list/subgrid column shape, property-set column and initial sorting, live capture paqvilo-developer pcf-parity summary-C (Columns, Sorting; r2 list-ny, r1 subgrid-actions-ny)
test('a list dataset binds its first view with the captured column shape, property-set column and primary-name sorting', async (t) => {
  const catalog = await catalogWith(
    t,
    '<data-set name="rows"><property-set name="primaryColumn" display-name-key="Primary column" of-type="SingleLine.Text" usage="bound" required="false"/></data-set>',
  );
  const diagnostics = [];
  const view = {
    id: viewId,
    name: 'Rows',
    entity: 'tst_row',
    fields: [
      { name: 'tst_title', width: 200 },
      { name: 'tst_flag', width: 50, sortDisabled: true },
      { name: 'p.tst_label', width: 100 },
      { name: 'tst_missing' },
      { name: 'constructor' },
    ],
    fetchXml:
      '<fetch><entity name="tst_row"><attribute name="tst_title"/><order attribute="tst_flag" descending="true"/><link-entity name="tst_parent" from="tst_parentid" to="tst_parentid" alias="p"><attribute name="tst_label"/></link-entity></entity></fetch>',
  };
  const html = renderCodeComponent({
    name: 'tst_Synthetic.Grid',
    portal: {},
    catalog,
    metadata: metadata(view),
    mappings,
    nativeDataset,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  const [binding] = mountSpec(html).datasets;
  assert.deepEqual(
    binding.columns.map(({ attributes, ...column }) => column),
    [
      {
        name: null,
        displayName: 'primaryColumn',
        dataType: 'SingleLine.Text',
        alias: 'primaryColumn',
        order: -1,
        visualSizeFactor: 1,
      },
      {
        name: 'tst_title',
        displayName: 'Title',
        dataType: 'SingleLine.Text',
        alias: 'tst_title',
        order: 1,
        visualSizeFactor: 1,
      },
      {
        name: 'tst_flag',
        displayName: 'tst_flag',
        dataType: 'TwoOptions',
        alias: 'tst_flag',
        order: 2,
        visualSizeFactor: 1,
      },
      {
        name: 'p.tst_label',
        displayName: 'Label (Parent)',
        dataType: 'SingleLine.Text',
        alias: 'p.tst_label',
        order: 3,
        visualSizeFactor: 1,
      },
    ],
  );
  // View columns carry their AttributeMetadata; the linked column describes the linked table's attribute.
  assert.equal(binding.columns[1].attributes.LogicalName, 'tst_title');
  assert.equal(binding.columns[1].attributes.EntityLogicalName, 'tst_row');
  assert.equal(binding.columns[3].attributes.EntityLogicalName, 'tst_parent');
  assert.equal(binding.columns[0].attributes, undefined);
  // Both hosts sort by the primary name column first, whatever the view orders by.
  assert.deepEqual(binding.sorting, [{ name: 'tst_title', sortDirection: 0 }]);
  assert.deepEqual(
    [binding.transport, binding.kind, binding.service, binding.update, binding.secure, binding.pageSize],
    ['grid', 'list', '/s', '/u', 'x', 3],
  );
  assert.deepEqual(
    diagnostics.filter((entry) => entry.code === 'PCF_DATASET_COLUMN_SKIPPED').map((entry) => entry.column),
    ['tst_missing', 'constructor'],
  );
});

// @test-kind observation: a control with two data sets on a list binds the default (first) one and hands the other no rows, live capture paqvilo-developer pcf-parity summary-C (Two views, two data sets; r2 item-list-ny)
test('a list binds its first data set and leaves the others without a view, with prefixed notifications', async (t) => {
  const catalog = await catalogWith(t, '<data-set name="first"/><data-set name="second"/>');
  const [first, second] = mountSpec(
    renderCodeComponent({
      name: 'tst_Synthetic.Grid',
      portal: {},
      catalog,
      metadata: metadata(typeView(['tst_title'])),
      mappings,
      nativeDataset,
    }),
  ).datasets;
  assert.equal(first.transport, 'grid');
  assert.equal(first.prefix, undefined);
  assert.deepEqual(second, {
    name: 'second',
    transport: 'empty',
    columns: [],
    sorting: [],
    entity: 'tst_row',
    service: '/s',
    secure: 'x',
    pageSize: 3,
    prefix: 'second_',
  });
});

// @test-kind observation: the Liquid tag binds no data set and drops a view argument, live capture paqvilo-developer pcf-parity summary-C (Liquid; r2 lq-dataset-ny, lq-dataset-view-ny)
test('a Liquid-bound dataset is unbound by default: no view, the property-set column only and an info diagnostic', async (t) => {
  const catalog = await catalogWith(
    t,
    '<data-set name="rows"><property-set name="primaryColumn" of-type="SingleLine.Text" usage="bound"/></data-set>',
  );
  const diagnostics = [];
  const render = (extra) =>
    mountSpec(
      renderCodeComponent({
        name: 'tst_Synthetic.Grid',
        args: { rows: viewId },
        portal: {},
        catalog,
        metadata: metadata(typeView(['tst_title'])),
        mappings,
        diagnostic: (entry) => diagnostics.push(entry),
        ...extra,
      }),
    ).datasets[0];
  assert.deepEqual(render(), {
    name: 'rows',
    transport: 'none',
    columns: [
      {
        name: null,
        displayName: 'primaryColumn',
        dataType: 'SingleLine.Text',
        alias: 'primaryColumn',
        order: -1,
        visualSizeFactor: 1,
      },
    ],
    sorting: [],
    propertySets: [{ name: 'primaryColumn', 'of-type': 'SingleLine.Text', usage: 'bound' }],
  });
  assert.deepEqual(
    diagnostics.map((entry) => [entry.code, entry.severity]),
    [['PCF_LIQUID_DATASET_UNBOUND', 'info']],
  );
});

test('the local pcf.liquidDatasetBinding "view" setting binds the Liquid tag argument and says it is local-only', async (t) => {
  const catalog = await catalogWith(t, '<data-set name="rows"/>');
  const diagnostics = [];
  const local = mountSpec(
    renderCodeComponent({
      name: 'tst_Synthetic.Grid',
      args: { rows: viewId },
      portal: {},
      catalog,
      metadata: metadata(typeView(['tst_title'])),
      mappings,
      liquidDatasetBinding: 'view',
      diagnostic: (entry) => diagnostics.push(entry),
    }),
  ).datasets[0];
  assert.equal(local.transport, 'webapi');
  assert.equal(local.viewId, viewId);
  assert.match(local.fetchXml, /<attribute name="tst_title"\/>/);
  assert.equal(diagnostics.at(-1).code, 'PCF_LIQUID_DATASET_LOCAL');
});

test('the pcf setting accepts liquidDatasetBinding "none" or "view" and refuses any other value', () => {
  assert.deepEqual(pcfSettings({ liquidDatasetBinding: 'view' }), { sources: [], liquidDatasetBinding: 'view' });
  assert.deepEqual(pcfSettings({ liquidDatasetBinding: 'none' }), { sources: [], liquidDatasetBinding: 'none' });
  assert.deepEqual(pcfSettings({}), { sources: [] });
  for (const value of ['View', 'table', true, null])
    assert.throws(
      () => pcfSettings({ liquidDatasetBinding: value }),
      /^Error: pcf\.liquidDatasetBinding must be "none" or "view"$/,
    );
});

test('manifest property-sets are imported with their data-set', async (t) => {
  const catalog = await catalogWith(
    t,
    '<data-set name="rows" display-name-key="Rows"><property-set name="title" display-name-key="Title" of-type="SingleLine.Text" usage="bound" required="true"/><property-set name="due" of-type-group="dates" usage="bound" required="false"/></data-set>',
  );
  const control = catalog.controls.get('tst_Synthetic.Grid');
  assert.deepEqual(control.datasets, [
    {
      name: 'rows',
      'display-name-key': 'Rows',
      propertySets: [
        { name: 'title', 'display-name-key': 'Title', 'of-type': 'SingleLine.Text', usage: 'bound', required: 'true' },
        { name: 'due', 'of-type-group': 'dates', usage: 'bound', required: 'false' },
      ],
    },
  ]);
  // property-set declarations are dataset columns, not control properties.
  assert.deepEqual(control.properties, []);
});

const treeOf = (inner = '') =>
  parseFetchTree(
    `<fetch><entity name="tst_row"><attribute name="tst_title"/><order attribute="tst_title"/><link-entity name="tst_parent" from="tst_parentid" to="tst_parentid" alias="p"><order attribute="tst_label"/></link-entity>${inner}</entity></fetch>`,
  );
const gridContext = (extra = {}) => ({
  parse: parseFetchTree,
  fields: (table) => metadata({}).entities[table]?.fields,
  readable: () => true,
  invalid: () => {
    throw Object.assign(new Error('Invalid_Request'), { status: 400 });
  },
  ...extra,
});

// @test-kind observation: the dataset filter travels as the captured pcfFilter FetchXML string, live capture paqvilo-developer pcf-parity summary-C2 (Q-090, capture m1 list-bodies)
test('a dataset pcfFilter joins the view FetchXML; an empty one adds nothing', () => {
  const fetch = treeOf();
  applyPcfGridFilter(
    fetch,
    '<filter type="or"><condition attribute="tst_title" operator="like" value="&#37;A&#37;" /><condition entityname="p" attribute="tst_label" operator="in"><value>One</value><value>Two</value></condition><condition attribute="tst_flag" operator="null"/></filter>',
    gridContext(),
  );
  assert.equal(
    serializeFetchTree(fetch),
    '<fetch><entity name="tst_row"><attribute name="tst_title"/><order attribute="tst_title"/><link-entity name="tst_parent" from="tst_parentid" to="tst_parentid" alias="p"><order attribute="tst_label"/></link-entity><filter type="or"><condition attribute="tst_title" operator="like" value="%A%"/><condition entityname="p" attribute="tst_label" operator="in"><value>One</value><value>Two</value></condition><condition attribute="tst_flag" operator="null"/></filter></entity></fetch>',
  );
  for (const empty of ['', null, undefined]) {
    const untouched = treeOf();
    applyPcfGridFilter(untouched, empty, gridContext());
    assert.equal(serializeFetchTree(untouched), serializeFetchTree(treeOf()));
  }
});

// @test-kind security: a dataset filter names only exported columns of the view's table and link aliases and never a column the visitor reads masked
test('a dataset pcfFilter refuses unexported, injected and masked parts', () => {
  const refused = (filter, extra) =>
    assert.throws(() => applyPcfGridFilter(treeOf(), filter, gridContext(extra)), /Invalid_Request/, String(filter));
  refused(42);
  refused('<link-entity name="tst_parent" from="tst_parentid" to="tst_parentid"/>');
  refused('<filter><link-entity name="tst_parent" from="tst_parentid" to="tst_parentid"/></filter>');
  refused('<filter><condition attribute="tst_missing" operator="eq" value="a"/></filter>');
  refused('<filter><condition attribute="constructor" operator="eq" value="a"/></filter>');
  refused('<filter><condition entityname="z" attribute="tst_label" operator="eq" value="a"/></filter>');
  refused('<filter><condition attribute="tst_title" operator="eq" value="a"/></filter>', {
    masked: (table, column) => table === 'tst_row' && column === 'tst_title',
  });
  // An exported column the view does not show can filter, as on Power Pages (Q-097), unless it is masked.
  applyPcfGridFilter(
    treeOf(),
    '<filter><condition attribute="tst_count" operator="eq" value="1"/></filter>',
    gridContext(),
  );
  refused('<filter><condition attribute="tst_count" operator="eq" value="1"/></filter>', {
    masked: (table, column) => column === 'tst_count',
  });
  refused('<filter><condition entityname="p" attribute="tst_parentid" operator="not-null"/></filter>', {
    masked: (table) => table === 'tst_parent',
  });
});

// @test-kind security: a dataset filter keeps to filter, condition and value elements with their own attributes and at most 16 levels
test('a dataset grid filter refuses foreign attributes and more than 16 nested levels', () => {
  const nested = (levels) =>
    '<filter>'.repeat(levels) +
    '<condition attribute="tst_title" operator="eq" value="a"/>' +
    '</filter>'.repeat(levels);
  applyPcfGridFilter(treeOf(), nested(16), gridContext());
  for (const filter of [
    nested(17),
    '<filter hint="x"><condition attribute="tst_title" operator="eq" value="a"/></filter>',
    '<filter><condition attribute="tst_title" operator="eq" value="a" valueof="tst_notes"/></filter>',
    '<filter><condition attribute="tst_title" operator="in"><value uiname="x">a</value></condition></filter>',
  ])
    assert.throws(() => applyPcfGridFilter(treeOf(), filter, gridContext()), /Invalid_Request/, filter);
});

// @test-kind security: a dataset record save writes only the bound view's plain layout columns, never system, state, ownership or reference columns
test('a dataset grid update decodes the captured body for the bound view layout columns only', () => {
  const fields = {
    ...metadata({}).entities.tst_row.fields,
    tst_locked: field('nvarchar', { validForUpdate: false }),
    tst_base: field('money', { attributeOf: 'tst_amount' }),
    createdon: field('datetime'),
    versionnumber: field('bigint'),
  };
  const columns = new Set([
    'tst_title',
    'tst_count',
    'tst_locked',
    'tst_base',
    'tst_parentid',
    'ownerid',
    'statecode',
    'createdon',
    'versionnumber',
    'tst_rowid',
  ]);
  const context = { entity: 'tst_row', fields, columns, idColumn: 'tst_rowid', invalid: gridContext().invalid };
  const id = 'D0000000-0000-4000-8000-000000000001';
  const body = (changes, extra = {}) => ({
    Id: id,
    EntityName: 'tst_row',
    Attributes: Object.entries(changes).map(([Name, Value]) => ({ Name, Value })),
    ...extra,
  });
  assert.deepEqual(pcfGridUpdate(body({ tst_title: '"dataset write"', tst_count: '7' }, { Id: `{${id}}` }), context), {
    id: id.toLowerCase(),
    values: { tst_title: 'dataset write', tst_count: 7 },
  });
  for (const changes of [
    {},
    { tst_rowid: '"x"' },
    { tst_locked: '"x"' },
    { tst_base: '1' },
    { tst_parentid: '"d0000000-0000-4000-8000-000000000009"' },
    { ownerid: '"d0000000-0000-4000-8000-000000000009"' },
    { statecode: '1' },
    { createdon: '"2020-01-01"' },
    { versionnumber: '1' },
    // An exported column outside the bound view layout.
    { tst_flag: 'true' },
    { tst_missing: '"x"' },
    { constructor: '"x"' },
    { tst_title: 'not json' },
    { tst_title: '{"a":1}' },
    { tst_title: 1 },
    { tst_title: JSON.stringify('x'.repeat(70000)) },
  ])
    assert.throws(() => pcfGridUpdate(body(changes), context), /Invalid_Request/, JSON.stringify(changes).slice(0, 80));
  assert.throws(() => pcfGridUpdate(body({ tst_title: '"x"' }, { Id: 'nope' }), context), /Invalid_Request/);
  assert.throws(
    () => pcfGridUpdate(body({ tst_title: '"x"' }, { EntityName: 'tst_parent' }), context),
    /Invalid_Request/,
  );
  assert.throws(
    () =>
      pcfGridUpdate(
        body(
          {},
          {
            Attributes: [
              { Name: 'tst_title', Value: '"a"' },
              { Name: 'tst_title', Value: '"b"' },
            ],
          },
        ),
        context,
      ),
    /Invalid_Request/,
  );
});

// @test-kind security: a dataset save never writes calculated, rollup or formula columns and keeps numbers inside the column's range (the export's, else the Dataverse default of the type)
test('a dataset grid update refuses computed columns and numbers outside the column range', () => {
  const fields = {
    tst_calc: field('nvarchar', { columnMetadata: { sourceType: 1 } }),
    tst_rollup: field('int', { sourceType: 2 }),
    tst_formula: field('nvarchar', { columnMetadata: { sourceType: 3 } }),
    tst_power: field('decimal', { columnMetadata: { formulaDefinition: 'Decimal(1)' } }),
    tst_count: field('int'),
    tst_big: field('bigint'),
    tst_ratio: field('float'),
    tst_amount: field('money'),
    tst_bounded: field('int', { minValue: 0, maxValue: 10 }),
  };
  const context = {
    entity: 'tst_row',
    fields,
    columns: new Set(Object.keys(fields)),
    idColumn: 'tst_rowid',
    invalid: gridContext().invalid,
  };
  const save = (Name, Value) =>
    pcfGridUpdate(
      { Id: 'd0000000-0000-4000-8000-000000000001', EntityName: 'tst_row', Attributes: [{ Name, Value }] },
      context,
    ).values[Name];
  for (const [name, value] of [
    ['tst_calc', '"x"'],
    ['tst_rollup', '1'],
    ['tst_formula', '"x"'],
    ['tst_power', '1'],
    ['tst_count', '1e308'],
    ['tst_count', '2147483648'],
    ['tst_count', '"12"'],
    ['tst_big', '1e300'],
    ['tst_ratio', '100000000001'],
    ['tst_amount', '1e308'],
    ['tst_bounded', '11'],
    ['tst_bounded', '-1'],
  ])
    assert.throws(() => save(name, value), /Invalid_Request/, name + ' ' + value);
  assert.deepEqual(
    [
      save('tst_count', '2147483647'),
      save('tst_ratio', '-1.5'),
      save('tst_amount', '1234.56'),
      save('tst_bounded', '10'),
    ],
    [2147483647, -1.5, 1234.56, 10],
  );
  assert.equal(save('tst_count', 'null'), null);
});

const updateView = 'b0000000-0000-4000-8000-000000000011';
const quickFindView = 'b0000000-0000-4000-8000-000000000012';
const updateRow = (index) => 'd8000000-0000-4000-8000-' + String(index).padStart(12, '0');
const updateColumn = (name, type, extra = '') =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type>${extra}</attribute>`;

/**
 * A list "All rows" hosting tst_Synthetic.Rows over a view that shows tst_title, tst_notes (MaxLength 20) and the
 * system columns statecode, ownerid and createdon, and lists no row titled Hidden. Returns the simulator, the signed
 * dataset configuration and update URL from the rendered page, and a `save(body, headers)` helper.
 */
async function updateSimulator(t, { operations = ['read', 'update'], listView = updateView, map = false } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-dataset-update-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const layout = (names) => names.map((name) => `<cell name="${name}" width="100"/>`).join('');
  const viewXml = (id, queryType, names) =>
    `<savedquery><savedqueryid>${id}</savedqueryid><querytype>${queryType}</querytype><LocalizedNames><LocalizedName description="View ${queryType}" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="tst_row">${names.map((name) => `<attribute name="${name}"/>`).join('')}<attribute name="tst_rowid"/><filter><condition attribute="tst_title" operator="ne" value="Hidden"/></filter></entity></fetch></fetchxml><layoutxml><grid><row>${layout(names)}</row></grid></layoutxml></savedquery>`;
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Dataset site',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': "{% include 'entity_list' key:'All rows' %}",
    'portal/Rows.list.yml': `adx_entitylistid: rows\nadx_name: All rows\nadx_entityname: tst_row\nadx_view: ${listView}\nadx_iscodecomponent: true${map ? '\nadx_map_enabled: true' : ''}`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity><attributes>${updateColumn('tst_rowid', 'primarykey')}${updateColumn('tst_title', 'nvarchar', '<MaxLength>100</MaxLength>')}${updateColumn('tst_notes', 'nvarchar', '<MaxLength>20</MaxLength>')}${updateColumn('tst_secret', 'nvarchar')}${updateColumn('statecode', 'state')}${updateColumn('ownerid', 'owner')}${updateColumn('createdon', 'datetime')}</attributes></entity></EntityInfo><CustomControlDefaultConfigs><CustomControlDefaultConfig><CustomControlDefaultConfigXml><customControl name="tst_Synthetic.Rows" formFactor="0"/></CustomControlDefaultConfigXml></CustomControlDefaultConfig></CustomControlDefaultConfigs></Entity>`,
    [`solution/Entities/tst_row/SavedQueries/${updateView}.xml`]: viewXml(updateView, 0, [
      'tst_title',
      'tst_notes',
      'statecode',
      'ownerid',
      'createdon',
    ]),
    [`solution/Entities/tst_row/SavedQueries/${quickFindView}.xml`]: viewXml(quickFindView, 4, ['tst_title']),
    ...rowsDatasetControl("ComponentFramework.registerControl('Synthetic.Rows',class{});"),
  };
  await writeFixtureFiles(root, files);
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    watch: false,
    initial: {
      tables: {
        tst_row: [
          { tst_rowid: updateRow(1), tst_title: 'Listed', tst_notes: 'before', tst_secret: 'secret', statecode: 0 },
          { tst_rowid: updateRow(2), tst_title: 'Hidden', tst_notes: 'before' },
        ],
      },
      mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } },
      permissions: [{ id: 'rows', entity: 'tst_row', scope: 'global', operations }],
      settings: { permissionMode: 'enforce' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const html = await (await fetch(app.url + '/')).text();
  const [binding] = html.includes('__paqviloPcf.mount(') ? mountSpec(html).datasets : [{}];
  const post = (url, body, headers = { __RequestVerificationToken: app.csrf }) =>
    fetch(app.url + url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  const rowOf = (index) => app.store.snapshot().tables.tst_row.find((row) => row.tst_rowid === updateRow(index));
  return {
    app,
    html,
    binding,
    rowOf,
    post,
    // The captured save body (summary-C2) plus Mirage's signed list configuration.
    save: ({ id = updateRow(1), changes = {}, ...rest }, headers) =>
      post(
        binding.update,
        {
          Id: id,
          EntityName: 'tst_row',
          Attributes: Object.entries(changes).map(([Name, Value]) => ({ Name, Value })),
          base64SecureConfiguration: binding.secure,
          ...rest,
        },
        headers,
      ),
  };
}

// @test-kind security: the dataset save route writes a listed record's plain view column for a visitor with the update grant and refuses everything else without a state change
test('the dataset grid update route refuses missing grants, tokens and scopes, foreign columns, unlisted records and over-length values', async (t) => {
  const grid = await updateSimulator(t);
  const before = JSON.stringify(grid.app.store.snapshot().tables.tst_row);
  const refusals = [
    ['missing CSRF token', grid.save({ changes: { tst_notes: '"x"' } }, {}), 403],
    [
      'non-dataset list token',
      grid.save({
        base64SecureConfiguration: protectConfiguration({ t: 'list', w: 'site', list: 'rows', view: updateView }),
        changes: { tst_notes: '"x"' },
      }),
      403,
    ],
    [
      'subgrid token',
      grid.save({
        base64SecureConfiguration: protectConfiguration({ t: 'subgrid', w: 'site', view: updateView, pcf: true }),
        changes: { tst_notes: '"x"' },
      }),
      403,
    ],
    ['column outside the view', grid.save({ changes: { tst_secret: '"x"' } }), 400],
    ['statecode', grid.save({ changes: { statecode: '1' } }), 400],
    ['ownerid', grid.save({ changes: { ownerid: '"d8000000-0000-4000-8000-000000000009"' } }), 400],
    ['createdon', grid.save({ changes: { createdon: '"2020-01-01T00:00:00Z"' } }), 400],
    ['record not on the list', grid.save({ id: updateRow(2), changes: { tst_notes: '"x"' } }), 403],
    ['over-length value', grid.save({ changes: { tst_notes: JSON.stringify('x'.repeat(21)) } }), 400],
  ];
  for (const [label, response, status] of refusals) assert.equal((await response).status, status, label);
  assert.equal(JSON.stringify(grid.app.store.snapshot().tables.tst_row), before, 'no refusal changed a row');
  // Without the update grant the same save is refused.
  const readOnly = await updateSimulator(t, { operations: ['read'] });
  assert.equal((await readOnly.save({ changes: { tst_notes: '"x"' } })).status, 403);
  assert.equal(readOnly.rowOf(1).tst_notes, 'before');
  // The listed record's view column is written.
  const saved = await grid.save({ changes: { tst_notes: '"dataset write"' } });
  assert.equal(saved.status, 200);
  // The save answers the serialized Entity of the update (summary-C2, Q-090).
  const entity = await saved.json();
  assert.deepEqual(
    [entity.LogicalName, entity.Id, entity.Attributes, entity.EntityState],
    [
      'tst_row',
      updateRow(1),
      [
        { Key: 'tst_notes', Value: 'dataset write' },
        { Key: 'tst_rowid', Value: updateRow(1) },
      ],
      0,
    ],
  );
  assert.equal(grid.rowOf(1).tst_notes, 'dataset write');
});

// @test-kind security: large pages are a server-side option, never taken from a grid request body
test('a grid data request cannot ask for large pages', async (t) => {
  const grid = await updateSimulator(t);
  const response = await grid.post(grid.binding.service, {
    base64SecureConfiguration: grid.binding.secure,
    page: 1,
    pageSize: 300,
    allowLargePages: true,
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).PageSize, 10);
});

// @test-kind security: fractional or huge paging numbers are whole, bounded numbers, never a server failure
test('a grid data request floors fractional page sizes and bounds the page number', async (t) => {
  const grid = await updateSimulator(t);
  for (const [page, pageSize, expected] of [
    [1.5, 1.5, [1, 1]],
    [1e300, 5, [1000000, 5]],
    [-3, 2.9, [1, 2]],
  ]) {
    const response = await grid.post(grid.binding.service, {
      base64SecureConfiguration: grid.binding.secure,
      page,
      pageSize,
    });
    assert.equal(response.status, 200, String(page));
    const data = await response.json();
    assert.deepEqual([data.PageNumber, data.PageSize], expected, String(page));
  }
});

// @test-kind observation: a dataset filter on an existing table column the view does not show answers 200 with the matching rows, live capture paqvilo-developer pcf-parity summary-C2 (Q-097, capture f2 filter-offview)
test('a dataset grid filter on a readable column outside the view returns its matching rows', async (t) => {
  const grid = await updateSimulator(t);
  const filter = (column) =>
    grid.post(grid.binding.service, {
      base64SecureConfiguration: grid.binding.secure,
      page: 1,
      pcfFilter: '<filter><condition attribute="' + column + '" operator="like" value="s&#37;"/></filter>',
    });
  const offView = await filter('tst_secret');
  assert.equal(offView.status, 200);
  assert.deepEqual(
    (await offView.json()).Records.map((record) => record.Id),
    [updateRow(1)],
  );
  const none = await (await filter('tst_notes')).json();
  assert.deepEqual(none.Records, []);
});

// @test-kind observation: a Quick Find view as the list view answers 500 from the grid service, live capture paqvilo-developer pcf-parity summary-C (Q-052, r2 qf-list-ny network)
test('a dataset grid over a Quick Find list view answers 500', async (t) => {
  const grid = await updateSimulator(t, { listView: quickFindView });
  const response = await grid.post(grid.binding.service, { base64SecureConfiguration: grid.binding.secure, page: 1 });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    InternalServerError: 500,
    Message: 'The dataset view is a Quick Find view.',
  });
});

// @test-kind observation: a dataset grid query failure answers the platform's 500 body, live capture paqvilo-developer pcf-parity summary-C2 (Q-091/Q-096, capture m1 list-bodies)
test('a dataset grid filter value the column cannot take answers the captured 500 body', async (t) => {
  const grid = await updateSimulator(t);
  const response = await grid.post(grid.binding.service, {
    base64SecureConfiguration: grid.binding.secure,
    page: 1,
    pcfFilter: '<filter type="and"><condition attribute="createdon" operator="on" value="970840000"/></filter>',
  });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['InternalServerError', 'Message']);
  assert.equal(body.InternalServerError, 500);
  assert.equal(typeof body.Message, 'string');
  // A column the table does not have answers the captured 500 body and message (Q-091).
  const missing = await grid.post(grid.binding.service, {
    base64SecureConfiguration: grid.binding.secure,
    page: 1,
    pcfFilter: '<filter><condition attribute="tst_missing" operator="eq" value="a"/></filter>',
  });
  assert.equal(missing.status, 500);
  assert.deepEqual(await missing.json(), {
    InternalServerError: 500,
    Message:
      "'tst_row' entity doesn't contain attribute with Name = 'tst_missing' and NameMapping = 'Logical' (look up attribute by name is case-sensitive)",
  });
  // Mirage's own refusal of a malformed filter keeps its answer.
  const malformed = await grid.post(grid.binding.service, {
    base64SecureConfiguration: grid.binding.secure,
    page: 1,
    pcfFilter: '<filter><link-entity name="tst_row" from="tst_rowid" to="tst_rowid"/></filter>',
  });
  assert.equal(malformed.status, 400);
});

// @test-kind contract: a list whose configuration the dataset host does not serve keeps the native grid with a diagnostic
test('a code-component list the dataset host cannot bind keeps the native grid with PCF_NATIVE_DATASET_UNSUPPORTED', async (t) => {
  const grid = await updateSimulator(t, { map: true });
  assert.doesNotMatch(grid.html, /data-pcf-schema/);
  assert.match(grid.html, /uses a configured dataset code component/);
  assert.ok(grid.app.state().diagnostics.some((entry) => entry.code === 'PCF_NATIVE_DATASET_UNSUPPORTED'));
  const missing = await updateSimulator(t, { listView: 'b0000000-0000-4000-8000-000000000099' });
  assert.doesNotMatch(missing.html, /data-pcf-schema/);
  assert.ok(missing.app.state().diagnostics.some((entry) => entry.code === 'PCF_NATIVE_DATASET_UNSUPPORTED'));
});

const simulatorView = 'b0000000-0000-4000-8000-000000000001';
const column = (name, type) =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type></attribute>`;
const sitesetting = (entries) =>
  entries
    .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: ${value}`)
    .join('\n');

/**
 * A simulator whose home page binds the tst_Synthetic.Rows dataset control in Liquid or as the code component of the
 * native list "All rows"; the view, its layout and the Web API site settings vary per test. Returns the page HTML.
 */
async function datasetSimulator(t, { list = false, fetchXml, layout, settings, pcf }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-dataset-webapi-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const grid = list
    ? '<CustomControlDefaultConfigs><CustomControlDefaultConfig><CustomControlDefaultConfigXml><customControl name="tst_Synthetic.Rows" formFactor="0"/></CustomControlDefaultConfigXml></CustomControlDefaultConfig></CustomControlDefaultConfigs>'
    : '';
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Dataset site',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': list
      ? "{% include 'entity_list' key:'All rows' %}"
      : `{% codecomponent name:tst_Synthetic.Rows records:'${simulatorView}' %}`,
    'portal/Rows.list.yml': `adx_entitylistid: rows\nadx_name: All rows\nadx_entityname: tst_row\nadx_view: ${simulatorView}\nadx_iscodecomponent: true`,
    'portal/sitesetting.yml': sitesetting(settings),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity><attributes>${column('tst_rowid', 'primarykey')}${column('tst_title', 'nvarchar')}${column('tst_secret', 'nvarchar')}${column('tst_parentid', 'lookup')}</attributes></entity></EntityInfo>${grid}</Entity>`,
    'solution/Entities/tst_parent/Entity.xml': `<Entity><Name>tst_parent</Name><EntityInfo><entity><attributes>${column('tst_parentid', 'primarykey')}${column('tst_label', 'nvarchar')}${column('tst_hidden', 'nvarchar')}</attributes></entity></EntityInfo></Entity>`,
    [`solution/Entities/tst_row/SavedQueries/${simulatorView}.xml`]: `<savedquery><savedqueryid>${simulatorView}</savedqueryid><LocalizedNames><LocalizedName description="Fixture rows" languagecode="1033"/></LocalizedNames><fetchxml>${fetchXml}</fetchxml><layoutxml><grid><row>${layout}</row></grid></layoutxml></savedquery>`,
    ...rowsDatasetControl("ComponentFramework.registerControl('Synthetic.Rows',class{});"),
  };
  await writeFixtureFiles(root, files);
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    watch: false,
    ...(pcf ? { pcf } : {}),
    initial: {
      tables: { tst_row: [{ tst_rowid: 'd0000000-0000-4000-8000-000000000001', tst_title: 'Row' }] },
      mappings: {
        tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' },
        tst_parent: { entitySet: 'tst_parents', idColumn: 'tst_parentid', nameColumn: 'tst_label' },
      },
      settings: { permissionMode: 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const html = await (await fetch(app.url + '/')).text();
  const diagnostics = app.state().diagnostics;
  return { html, diagnostics, webApi: diagnostics.filter((item) => item.code === 'PCF_DATASET_WEBAPI_REQUIRED') };
}

const rowFields = ['Webapi/tst_row/fields', 'tst_rowid,tst_title,tst_parentid'];
const rowEnabled = ['Webapi/tst_row/enabled', 'true'];
const linkedFetch = (inner = '<attribute name="tst_label"/>') =>
  `<fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/><link-entity name="tst_parent" from="tst_parentid" to="tst_parentid" alias="p" link-type="outer">${inner}</link-entity></entity></fetch>`;

// @test-kind observation: list rows travel through entity-grid-data.json, not the Web API, live capture paqvilo-developer pcf-parity summary-C (Data transport; r2 list-ny network)
test('a native list dataset reads through the grid service whatever its Web API site settings', async (t) => {
  const { html, diagnostics, webApi } = await datasetSimulator(t, {
    list: true,
    fetchXml: linkedFetch(),
    layout: '<cell name="tst_title" width="200"/><cell name="p.tst_label" width="100"/>',
    settings: [rowFields],
  });
  assert.match(html, /data-pcf-schema="tst_Synthetic\.Rows"/);
  const [binding] = mountSpec(html).datasets;
  assert.equal(binding.transport, 'grid');
  assert.match(binding.service, /^\/_services\/entity-grid-data\.json\/[^/]+$/);
  assert.match(binding.update, /^\/_services\/entity-grid-update-entity\/[^/]+$/);
  assert.deepEqual(webApi, []);
  assert.ok(!diagnostics.some((item) => item.code === 'PCF_NATIVE_DATASET_UNSUPPORTED'));
});

// @test-kind contract: the local Liquid binding (pcf.liquidDatasetBinding "view") reads through the portal Web API and diagnoses its site settings
test('the local Liquid binding names missing Web API site settings and describes only columns the Web API serves', async (t) => {
  const pcf = { liquidDatasetBinding: 'view' };
  const disabled = await datasetSimulator(t, {
    pcf,
    fetchXml:
      '<fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/></entity></fetch>',
    layout: '<cell name="tst_title" width="200"/>',
    settings: [rowFields],
  });
  // The Liquid tag still renders the component (its query fails in the browser) and records the missing setting.
  assert.match(disabled.html, /data-pcf-schema="tst_Synthetic\.Rows"/);
  assert.equal(disabled.webApi[0]?.entity, 'tst_row');
  assert.match(disabled.webApi[0].message, /Webapi\/tst_row\/enabled = true/);
  const secret = await datasetSimulator(t, {
    pcf,
    fetchXml:
      '<fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/><attribute name="tst_secret"/></entity></fetch>',
    layout: '<cell name="tst_title" width="200"/><cell name="tst_secret" width="100"/>',
    settings: [rowEnabled, rowFields],
  });
  assert.match(secret.webApi[0]?.message ?? '', /Webapi\/tst_row\/fields listing tst_secret/);
  // Link tables are described only with the columns their Web API settings list (the primary key always).
  const linked = await datasetSimulator(t, {
    pcf,
    fetchXml: linkedFetch(),
    layout: '<cell name="tst_title" width="200"/><cell name="p.tst_label" width="100"/>',
    settings: [
      rowEnabled,
      rowFields,
      ['Webapi/tst_parent/enabled', 'true'],
      ['Webapi/tst_parent/fields', 'tst_parentid,tst_label'],
    ],
  });
  assert.deepEqual(linked.webApi, []);
  const [binding] = mountSpec(linked.html).datasets;
  assert.deepEqual(Object.keys(binding.tables.tst_parent.fields).sort(), ['tst_label', 'tst_parentid']);
  // The default Liquid tag binds nothing and needs no site setting.
  const unbound = await datasetSimulator(t, {
    fetchXml: linkedFetch(),
    layout: '<cell name="tst_title" width="200"/>',
    settings: [],
  });
  assert.deepEqual(unbound.webApi, []);
  assert.equal(mountSpec(unbound.html).datasets[0].transport, 'none');
  assert.ok(unbound.diagnostics.some((item) => item.code === 'PCF_LIQUID_DATASET_UNBOUND'));
});
