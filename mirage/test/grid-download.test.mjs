// @test-kind contract: the local runtime's grid download paging, bounds and file contract, as the designed CSV service behaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { model, parentId } from './fixtures/subgrid.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { readSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { createMappedTables, createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';

// The child table's typed columns: an exact decimal, a whole number, a floating point, a currency, a date-time,
// a Two Options flag, a choice, and text that looks numeric or formula-like.
const TYPED_COLUMNS = ['amount', 'count', 'rate', 'cost', 'when', 'flag', 'status', 'reference', 'memo'];
// The metadata AttributeType the grid's layout sends back for each typed column (the type of the view's column).
const TYPED_ATTRIBUTE_TYPES = { amount: 3, count: 5, rate: 4, cost: 8, when: 2, flag: 0, status: 11 };
const EXACT_AMOUNT = { $type: 'DataverseNumeric', numericType: 'Decimal', value: '12345678901234567.891' };
const typedChild = (index, values) => ({
  childkey: `c4000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  parentlookup: parentId,
  name: `Typed child ${index}`,
  ...values,
});

// Adds the typed columns to the subgrid's view and gives the pending child and three more children typed values.
function addTypedColumns(state, schemas) {
  const grid = schemas.parent.layout[0].columns[0].sections[0].rows[0][1];
  grid.fields.push(...TYPED_COLUMNS.map((name) => ({ name })));
  grid.fetchXml = `<fetch><entity name="child">${['childkey', 'name', ...TYPED_COLUMNS].map((name) => `<attribute name="${name}"/>`).join('')}</entity></fetch>`;
  Object.assign(state.tables.child[0], {
    amount: EXACT_AMOUNT,
    count: 7,
    rate: 1.5,
    cost: 99.5,
    when: '2026-01-02T15:04:05Z',
    flag: true,
    status: 2,
    reference: '0042',
    memo: '=SUM(1,2)',
  });
  state.tables.child.push(
    typedChild(1, { count: -3, rate: 0.25, memo: '+1', flag: false }),
    typedChild(2, { count: 0, memo: '-1', reference: '1e3' }),
    typedChild(3, { memo: '@x', status: 1 }),
  );
}

// The child table as the exported solution declares it: each column with its Dataverse attribute type.
const SOLUTION_TYPES = {
  rate: 'float',
  amount: 'decimal',
  count: 'int',
  big: 'bigint',
  cost: 'money',
  when: 'datetime',
  flag: 'bit',
  status: 'picklist',
  reference: 'nvarchar',
  memo: 'memo',
};

// The solution's files: a manifest and the child entity, whose attributes carry the types above.
function solutionFiles() {
  const attributes = Object.entries(SOLUTION_TYPES)
    .map(
      ([name, type]) =>
        `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type></attribute>`,
    )
    .join('');
  return {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedChild</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/child/Entity.xml': `<Entity><Name>child</Name><EntityInfo><entity Name="child"><LocalizedNames><LocalizedName description="Child" languagecode="1033"/></LocalizedNames><EntitySetName>children</EntitySetName><PrimaryIdAttribute>childkey</PrimaryIdAttribute><PrimaryNameAttribute>name</PrimaryNameAttribute><attributes><attribute PhysicalName="childkey"><Name>childkey</Name><LogicalName>childkey</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="name"><Name>name</Name><LogicalName>name</LogicalName><Type>nvarchar</Type></attribute>${attributes}</attributes></entity></EntityInfo></Entity>`,
  };
}

// The solution-declared view also shows the bigint column, which the typed columns do not include.
function addSolutionColumns(state, schemas) {
  const grid = schemas.parent.layout[0].columns[0].sections[0].rows[0][1];
  grid.fields.push({ name: 'big' });
  grid.fetchXml = grid.fetchXml.replace('</entity>', '<attribute name="big"/></entity>');
  state.tables.child[0].big = 42;
}

// The child table as a mapping declares it, without any solution: each column with its Dataverse attribute type.
const MAPPED_TYPES = {
  rate: 'double',
  amount: 'decimal',
  count: 'int',
  big: 'bigint',
  cost: 'money',
  when: 'datetime',
  flag: 'bit',
  status: 'picklist',
  memo: 'memo',
  parentlookup: 'lookup',
};

// Adds the bigint column and the parent lookup to the view, unless it is already there, and declares the child's
// column types through its mapping.
function addMappedColumns(state, schemas, types) {
  const grid = schemas.parent.layout[0].columns[0].sections[0].rows[0][1];
  const added = ['big', 'parentlookup'].filter((name) => !grid.fields.some((field) => field.name === name));
  grid.fields.push(...added.map((name) => ({ name })));
  grid.fetchXml = grid.fetchXml.replace(
    '</entity>',
    `${added.map((name) => `<attribute name="${name}"/>`).join('')}</entity>`,
  );
  state.tables.child[0].big = 42;
  state.mappings.child.fields = Object.fromEntries(
    Object.entries(types).map(([name, dataverseType]) => [name, { dataverseType }]),
  );
}

// Downloads take page 1 of up to Grid/Download/MaximumResults records (default 5000),
// whatever page and pageSize the request carries.
async function downloadFixture(t, { rows, maximumResults, anonymousReadable, typed, solution, mapped } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'grid-download-'));
  const { state, settings, schemas } = model();
  for (let index = 0; index < rows; index++)
    state.tables.child.push({
      childkey: `c0000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      parentlookup: parentId,
      name: `Download child ${String(index).padStart(5, '0')}`,
      status: 2,
    });
  if (typed) addTypedColumns(state, schemas);
  if (solution) addSolutionColumns(state, schemas);
  if (mapped) addMappedColumns(state, schemas, mapped);
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Test',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml':
      'adx_pagetemplateid: template\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Parent" %}',
    'Parent.basicform.yml': 'adx_entityformid: parent\nadx_name: Parent\nadx_entityname: parent\nadx_mode: 100000001',
    'Notify.basicform.yml': 'adx_entityformid: notify\nadx_name: Notify\nadx_entityname: child\nadx_mode: 100000001',
    'Parent.basicform.basicformmetadata.yml': `adx_entityform: parent\nadx_subgrid_name: Children\nadx_subgrid_settings: ${JSON.stringify(JSON.stringify(settings))}`,
    'Add.webpage.yml':
      'adx_webpageid: add\nadx_name: Add\nadx_partialurl: add\nadx_parentpageid: home\nadx_pagetemplateid: template',
    ...(solution ? solutionFiles() : {}),
    ...(maximumResults
      ? {
          'sitesetting.yml': `- adx_sitesettingid: s1\n  adx_name: Grid/Download/MaximumResults\n  adx_value: "${maximumResults}"`,
        }
      : {}),
  };
  // A read grant of the child table with no web role, which anonymous visitors hold too.
  if (anonymousReadable)
    state.permissions.push({ id: 'child-read', entity: 'child', scope: 'global', operations: ['read'] });
  for (const [name, contents] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await fs.writeFile(path.join(directory, name), contents);
  }
  const app = await createSimulator({
    sourceDir: directory,
    ...(solution ? { solutionRoots: [path.join(directory, 'solution')] } : {}),
    stateFile: path.join(directory, 'state.json'),
    initial: state,
    watch: false,
  });
  t.after(async () => {
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const session = signInHeaders(app, 'editor', { roles: ['Editor'] });
  const html = await (await fetch(`${app.url}/?id=${parentId}`, { headers: session })).text();
  const start = html.indexOf('class="entity-grid subgrid');
  const layouts = JSON.parse(
    Buffer.from(/data-view-layouts="([^"]*)"/.exec(html.slice(start))[1], 'base64').toString('utf8'),
  );
  // Starts an export as the given headers' identity (the signed-in persona by default) and returns its key.
  const post = async (body, headers = session) => {
    const response = await fetch(`${app.url}/_services/download-as-csv/site`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...headers },
      body: JSON.stringify({
        base64SecureConfiguration: layouts[0].Base64SecureConfiguration,
        columns: [{ LogicalName: 'name', Name: 'Child name', Type: 0 }],
        viewName: 'Children',
        ...body,
      }),
    });
    assert.equal(response.status, 200);
    const { sessionKey } = await response.json();
    return sessionKey;
  };
  const fetchExport = (key, headers = session) =>
    fetch(`${app.url}/_services/download-as-csv/site?key=${encodeURIComponent(key)}`, { headers });
  const download = async (body) => {
    const file = await fetchExport(await post(body));
    return Buffer.from(await file.arrayBuffer())
      .subarray(3)
      .toString('utf8')
      .split('\r\n')
      .slice(1);
  };
  return {
    app,
    download,
    fetchExport,
    post,
    session,
    secure: layouts[0].Base64SecureConfiguration,
    columns: layouts[0].Columns,
  };
}

// The grid's own columns, with the metadata type of each typed column as the grid's layout sends it.
function typedColumns(columns) {
  return columns.map((column) =>
    column.LogicalName in TYPED_ATTRIBUTE_TYPES
      ? { ...column, Metadata: { ...column.Metadata, AttributeType: TYPED_ATTRIBUTE_TYPES[column.LogicalName] } }
      : column,
  );
}

// The lines of a CSV download response, without its byte order mark.
async function csvLines(response) {
  return Buffer.from(await response.arrayBuffer())
    .subarray(3)
    .toString('utf8')
    .split('\r\n');
}

test("a list download ignores the request's paging and returns up to 5000 records by default", async (t) => {
  const { download } = await downloadFixture(t, { rows: 120 });
  // A grid page shows 50 records at most; the download has every record of the view (the
  // 120 added rows and the fixture's two children of the parent).
  const lines = await download({ page: 3, pageSize: 10 });
  assert.equal(lines.length, 122);
  assert.ok(lines.includes('Download child 00119'));
  assert.ok(lines.includes('Pending child') && lines.includes('Accepted child'));
  assert.ok(!lines.includes('Foreign child'));
});

test('Grid/Download/MaximumResults bounds a download, including beyond one 5000-record fetch page', async (t) => {
  const bounded = await downloadFixture(t, { rows: 120, maximumResults: 60 });
  assert.equal((await bounded.download({ page: 1, pageSize: 50 })).length, 60);
  const paged = await downloadFixture(t, { rows: 5003, maximumResults: 5002 });
  const lines = await paged.download({});
  assert.equal(lines.length, 5002);
  assert.equal(new Set(lines).size, 5002);
});

// @test-kind security: two exports started in the same second are distinct, and each serves only its own rows.
test('two exports of one view in the same second get distinct keys, and each serves its own columns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12) });
  const { post, fetchExport } = await downloadFixture(t);
  const first = await post({ columns: [{ LogicalName: 'name', Name: 'First label', Type: 0 }] });
  const second = await post({ columns: [{ LogicalName: 'name', Name: 'Second label', Type: 0 }] });
  assert.notEqual(first, second);
  assert.equal((await csvLines(await fetchExport(first)))[0], 'First label');
  assert.equal((await csvLines(await fetchExport(second)))[0], 'Second label');
});

// @test-kind security: an export is served only to the identity that started it; other identities get 204 and it stays unused.
test('an export answers 204 to another persona or to no session, and stays available to its owner', async (t) => {
  const { app, post, fetchExport } = await downloadFixture(t);
  const key = await post({});
  const stranger = signInHeaders(app, 'stranger-contact', { roles: ['Editor'] });
  assert.equal((await fetchExport(key, stranger)).status, 204);
  assert.equal((await fetchExport(key, {})).status, 204);
  assert.ok((await csvLines(await fetchExport(key))).includes('Pending child'));
});

// @test-kind security: a key in the UTC-second form is not an export key.
test('a predictable key in the UTC-second form answers 204', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1, 12) });
  const { post, fetchExport } = await downloadFixture(t);
  await post({});
  const predicted = `${new Date().toISOString().slice(0, 19)}|Children.csv`;
  assert.equal((await fetchExport(predicted)).status, 204);
});

// @test-kind security: an export of one runtime is unknown to another runtime in the same process.
test('an export of one runtime is unknown to another runtime in the same process', async (t) => {
  const origin = await downloadFixture(t);
  const other = await downloadFixture(t);
  const key = await origin.post({});
  assert.equal((await other.fetchExport(key)).status, 204);
  assert.equal((await origin.fetchExport(key)).status, 200);
});

// @test-kind contract: an Excel download is a workbook of the view's rows, not CSV text under a workbook name.
test('an Excel download answers an .xlsx workbook of the view rows', async (t) => {
  const { app, session, secure, fetchExport } = await downloadFixture(t, { rows: 2 });
  const response = await fetch(`${app.url}/_services/download-as-excel/site`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...session },
    body: JSON.stringify({
      base64SecureConfiguration: secure,
      columns: [{ LogicalName: 'name', Name: 'Child name', Type: 0 }],
      viewName: 'Children',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-sim-download-format'), null);
  const { sessionKey } = await response.json();
  const file = await fetchExport(sessionKey);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(
    file.headers.get('content-disposition'),
    'attachment; filename="Children.xlsx"; filename*=UTF-8\'\'Children.xlsx',
  );
  const entries = readSolutionAssetEntries(Buffer.from(await file.arrayBuffer()));
  const sheet = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml').data.toString('utf8');
  assert.ok(sheet.includes('<t xml:space="preserve">Child name</t>'));
  assert.ok(sheet.includes('<t xml:space="preserve">Download child 00001</t>'));
  assert.equal((await fetchExport(sessionKey)).status, 204);
});

// @test-kind security: an export an anonymous visitor starts is fetched once by the visitor cookie that started it; another visitor gets 204 and does not consume it.
test('an export an anonymous visitor starts is fetched once by its own visitor cookie', async (t) => {
  const { app, secure, fetchExport } = await downloadFixture(t, { anonymousReadable: true });
  // The first page GET of an anonymous browser starts its visitor session; the cookie it sets is the browser's identity.
  const visitorCookie = async () => {
    const response = await fetch(`${app.url}/`);
    await response.text();
    return response.headers.get('set-cookie').split(';')[0];
  };
  const first = await visitorCookie();
  const second = await visitorCookie();
  const started = await fetch(`${app.url}/_services/download-as-csv/site`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, cookie: first },
    body: JSON.stringify({
      base64SecureConfiguration: secure,
      columns: [{ LogicalName: 'name', Name: 'Child name', Type: 0 }],
      viewName: 'Children',
    }),
  });
  assert.equal(started.status, 200);
  const { sessionKey } = await started.json();
  assert.equal((await fetchExport(sessionKey, { cookie: second })).status, 204);
  assert.equal((await fetchExport(sessionKey, { cookie: first })).status, 200);
  assert.equal((await fetchExport(sessionKey, { cookie: first })).status, 204);
});

// The CSV bytes of a download of the typed columns: the byte order mark, CRLF lines, and text for every column.
// @test-kind contract: the CSV export keeps its exact bytes; the column types of an Excel export never reach it.
test('a CSV download keeps its exact bytes whatever the column metadata types are', async (t) => {
  const { post, fetchExport, columns } = await downloadFixture(t, { typed: true });
  const key = await post({ columns: typedColumns(columns) });
  const text = Buffer.from(await (await fetchExport(key)).arrayBuffer()).toString('utf8');
  assert.equal(
    text,
    [
      '\uFEFFChild name,amount,count,rate,cost,when,flag,status,reference,memo',
      'Typed child 1,,-3,0.25,,,No,,,+1',
      'Typed child 2,,0,,,,,,1e3,-1',
      `Typed child 3,,,,,,,1,,'@x`,
      `Pending child,12345678901234567.891,7,1.50,99.50,2026-01-02T15:04:05Z,Yes,2,0042,"'=SUM(1,2)"`,
      'Accepted child,,,,,,,1,,',
    ].join('\r\n'),
  );
});

// Starts an Excel export of the given columns and returns the first sheet's cells: reference -> { type, value }.
async function excelCells(app, session, secure, columns) {
  const started = await fetch(`${app.url}/_services/download-as-excel/site`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...session },
    body: JSON.stringify({ base64SecureConfiguration: secure, columns, viewName: 'Children' }),
  });
  assert.equal(started.status, 200);
  const { sessionKey } = await started.json();
  const file = await fetch(`${app.url}/_services/download-as-excel/site?key=${encodeURIComponent(sessionKey)}`, {
    headers: session,
  });
  const sheet = readSolutionAssetEntries(Buffer.from(await file.arrayBuffer()))
    .find((entry) => entry.name === 'xl/worksheets/sheet1.xml')
    .data.toString('utf8');
  return new Map(
    [...sheet.matchAll(/<c r="([A-Z]+\d+)"( t="inlineStr")?>(.*?)<\/c>/g)].map(([, reference, inline, body]) => [
      reference,
      inline
        ? { type: 'inlineStr', value: /<t xml:space="preserve">([^<]*)<\/t>/.exec(body)[1] }
        : { type: 'n', value: /<v>([^<]*)<\/v>/.exec(body)[1] },
    ]),
  );
}

// The cell of a named export row (its name is in column A) in the given column.
function namedCell(cells, name, column) {
  const row = [...cells].find(([reference, cell]) => /^A\d+$/.test(reference) && cell.value === name)?.[0].slice(1);
  assert.ok(row, `the export has a row named ${name}`);
  return cells.get(`${column}${row}`);
}

// @test-kind contract: an Excel export writes whole number, decimal, floating point and currency columns as numeric
// cells, keeping exact digits.
test('Excel numeric columns are numeric cells with exact digits, and other columns are text', async (t) => {
  const { app, session, secure, columns } = await downloadFixture(t, { typed: true });
  const cells = await excelCells(app, session, secure, typedColumns(columns));
  const header = ['Child name', 'amount', 'count', 'rate', 'cost', 'when', 'flag', 'status', 'reference', 'memo'];
  assert.deepEqual(
    header.map((_, index) => cells.get(`${String.fromCharCode(65 + index)}1`)?.value),
    header,
  );
  // The exact decimal has 20 significant digits: a binary float would round it.
  assert.deepEqual(namedCell(cells, 'Pending child', 'B'), { type: 'n', value: '12345678901234567.891' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'C'), { type: 'n', value: '7' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'D'), { type: 'n', value: '1.5' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'E'), { type: 'n', value: '99.5' });
  assert.deepEqual(namedCell(cells, 'Typed child 1', 'C'), { type: 'n', value: '-3' });
  assert.deepEqual(namedCell(cells, 'Typed child 1', 'D'), { type: 'n', value: '0.25' });
  assert.deepEqual(namedCell(cells, 'Typed child 2', 'C'), { type: 'n', value: '0' });
  // An empty numeric value writes no cell.
  assert.equal(namedCell(cells, 'Accepted child', 'B'), undefined);
  assert.equal(namedCell(cells, 'Accepted child', 'E'), undefined);
  // A date-time, a Two Options and a choice column write their display text.
  assert.deepEqual(namedCell(cells, 'Pending child', 'F'), { type: 'inlineStr', value: '2026-01-02T15:04:05Z' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'G'), { type: 'inlineStr', value: 'Yes' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'H'), { type: 'inlineStr', value: '2' });
});

// @test-kind contract: text cells of an Excel export stay text, whether they look numeric or formula-like.
test('Excel text cells stay inline text, whether they look numeric or formula-like', async (t) => {
  const { app, session, secure, columns } = await downloadFixture(t, { typed: true });
  const cells = await excelCells(app, session, secure, typedColumns(columns));
  assert.deepEqual(namedCell(cells, 'Pending child', 'I'), { type: 'inlineStr', value: '0042' });
  assert.deepEqual(namedCell(cells, 'Typed child 2', 'I'), { type: 'inlineStr', value: '1e3' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'J'), { type: 'inlineStr', value: '=SUM(1,2)' });
  assert.deepEqual(namedCell(cells, 'Typed child 1', 'J'), { type: 'inlineStr', value: '+1' });
  assert.deepEqual(namedCell(cells, 'Typed child 2', 'J'), { type: 'inlineStr', value: '-1' });
  assert.deepEqual(namedCell(cells, 'Typed child 3', 'J'), { type: 'inlineStr', value: '@x' });
});

// @test-kind contract: a column the exported solution declares with a numeric Dataverse type carries that type in the list layout, and its Excel cell is numeric.
test('solution-declared numeric columns carry their Dataverse attribute types in the layout and write numeric cells', async (t) => {
  const { app, session, secure, columns } = await downloadFixture(t, { typed: true, solution: true });
  const attributeTypes = Object.fromEntries(
    columns.filter((column) => column.Metadata).map((column) => [column.LogicalName, column.Metadata.AttributeType]),
  );
  assert.deepEqual(
    { rate: attributeTypes.rate, amount: attributeTypes.amount, count: attributeTypes.count },
    { rate: 4, amount: 3, count: 5 },
  );
  assert.deepEqual({ big: attributeTypes.big, cost: attributeTypes.cost }, { big: 18, cost: 8 });
  const cells = await excelCells(app, session, secure, columns);
  assert.deepEqual(namedCell(cells, 'Pending child', 'B'), { type: 'n', value: '12345678901234567.891' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'C'), { type: 'n', value: '7' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'D'), { type: 'n', value: '1.5' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'E'), { type: 'n', value: '99.5' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'K'), { type: 'n', value: '42' });
});

// @test-kind contract: the metadata of a table only a mapping declares is one object across ordinary record writes, and a mapping type change rebuilds it once.
test('the metadata of a mapping-only table is rebuilt only when a mapping changes', () => {
  const overlay = createSolutionMetadataOverlay();
  const mapped = createMappedTables();
  const base = { lcid: 1033, entities: {}, forms: [], views: [], modelDrivenApps: [] };
  const state = {
    mappings: {
      child: {
        entitySet: 'children',
        idColumn: 'childkey',
        fields: { amount: { dataverseType: 'decimal' }, count: { dataverseType: 'int' } },
      },
    },
    tables: { child: [{ childkey: 'c0', amount: 1, count: 1 }] },
    dataverse: { metadataLog: [] },
  };
  const view = () => mapped(overlay(base, state), state);
  const first = view();
  assert.equal(first.entities.child.fields.amount.dataverseType, 'decimal');
  let rebuilds = 0;
  for (let index = 1; index <= 100; index++) {
    state.tables.child.push({ childkey: `c${index}`, amount: index, count: index });
    state.tables.child[0].count = index;
    if (view() !== first) rebuilds++;
  }
  assert.equal(rebuilds, 0);
  state.mappings.child.fields.amount = { dataverseType: 'int' };
  state.dataverse.metadataLog.push({ seq: 1 });
  const changed = view();
  assert.notEqual(changed, first);
  assert.equal(view(), changed);
  assert.equal(changed.entities.child.fields.amount.dataverseType, 'int');
});

test('the metadata of a mapping-only table follows a field added or retyped in place without a metadata log entry', () => {
  const mapped = createMappedTables();
  const metadata = { lcid: 1033, entities: {} };
  const state = {
    mappings: { t: { fields: { v: { dataverseType: 'decimal' } } } },
    dataverse: { metadataLog: [] },
  };
  const first = mapped(metadata, state);
  assert.equal(mapped(metadata, state), first);
  state.mappings.t.fields.w = { dataverseType: 'int' };
  const added = mapped(metadata, state);
  assert.equal(added.entities.t.fields.w.dataverseType, 'int');
  state.mappings.t.fields.w.dataverseType = 'bigint';
  const retyped = mapped(metadata, state);
  assert.equal(retyped.entities.t.fields.w.dataverseType, 'bigint');
  assert.equal(mapped(metadata, state), retyped);
});

test('the mapped-table memo sees a replaced field that keeps its type and a changed label', () => {
  const mapped = createMappedTables();
  const metadata = { lcid: 1033, entities: {} };
  const state = {
    mappings: { t: { fields: { x: { dataverseType: 'int', label: 'Before' } } } },
    dataverse: { metadataLog: [] },
  };
  const first = mapped(metadata, state);
  assert.equal(first.entities.t.fields.x.label, 'Before');
  state.mappings.t.fields.x = { ...state.mappings.t.fields.x, label: 'Renamed' };
  const renamed = mapped(metadata, state);
  assert.equal(renamed.entities.t.fields.x.label, 'Renamed');
  assert.notEqual(renamed, first);
  state.mappings.t.fields.x.label = 'Again';
  const again = mapped(metadata, state);
  assert.equal(again.entities.t.fields.x.label, 'Again');
  assert.equal(mapped(metadata, state), again);
  state.mappings.t.fields.x.targets = ['x_other'];
  const targeted = mapped(metadata, state);
  assert.deepEqual(targeted.entities.t.fields.x.targets, ['x_other']);
  assert.notEqual(targeted, again);
  assert.equal(mapped(metadata, state), targeted);
});

test('with a revision source the mapped-table memo compares no fields while the revision is unchanged', () => {
  let reads = 0;
  let rev = 'r1';
  const counted = (target) =>
    new Proxy(target, {
      ownKeys(object) {
        reads += 1;
        return Reflect.ownKeys(object);
      },
      get(object, key, receiver) {
        reads += 1;
        return Reflect.get(object, key, receiver);
      },
    });
  const metadata = { lcid: 1033, entities: {} };
  const state = {
    mappings: { t: { fields: counted({ x: { dataverseType: 'int', label: 'Before' } }) } },
    dataverse: { metadataLog: [] },
  };
  const mapped = createMappedTables({ revision: () => rev });
  const first = mapped(metadata, state);
  reads = 0;
  for (let index = 0; index < 50; index++) assert.equal(mapped(metadata, state), first);
  assert.equal(reads, 0, 'an unchanged revision reads no mapping field');
  rev = 'r2';
  state.mappings.t.fields.x.label = 'Renamed';
  assert.equal(mapped(metadata, state).entities.t.fields.x.label, 'Renamed');
  const unrevisioned = createMappedTables({ revision: () => null });
  const before = unrevisioned(metadata, state);
  state.mappings.t.fields.x.label = 'Unrevisioned';
  const after = unrevisioned(metadata, state);
  assert.equal(after.entities.t.fields.x.label, 'Unrevisioned');
  assert.notEqual(after, before);
});

// @test-kind contract: a mapping-only table keeps the label its mapping field declares.
test('a mapping-only table keeps the label of its mapping field and falls back to the column name', () => {
  const metadata = createMappedTables()(
    { lcid: 1033, entities: {} },
    { mappings: { t: { fields: { v: { label: 'Value', dataverseType: 'memo' }, w: { dataverseType: 'int' } } } } },
  );
  assert.equal(metadata.entities.t.fields.v.label, 'Value');
  assert.equal(metadata.entities.t.fields.w.label, 'w');
});

// @test-kind contract: a column the solution declares keeps the solution's attribute type over a mapping that declares another type, and a column only the mapping declares takes the mapping's type.
test('a table that a solution and a mapping both declare keeps the solution column types over the mapping', async (t) => {
  const { columns } = await downloadFixture(t, {
    typed: true,
    solution: true,
    mapped: { ...MAPPED_TYPES, cost: 'decimal' },
  });
  const attributeTypes = Object.fromEntries(
    columns.filter((column) => column.Metadata).map((column) => [column.LogicalName, column.Metadata.AttributeType]),
  );
  assert.equal(attributeTypes.cost, 8);
  assert.equal(attributeTypes.parentlookup, 6);
});

// @test-kind contract: a table a mapping declares without a solution carries each column's Dataverse attribute type in the list layout, and its Excel cells are numeric where the type is numeric.
test('mapping-declared columns of a table without a solution carry their Dataverse attribute types in the layout and write numeric cells', async (t) => {
  const { app, session, secure, columns } = await downloadFixture(t, { typed: true, mapped: MAPPED_TYPES });
  const attributeTypes = Object.fromEntries(
    columns.filter((column) => column.Metadata).map((column) => [column.LogicalName, column.Metadata.AttributeType]),
  );
  assert.deepEqual(
    { rate: attributeTypes.rate, amount: attributeTypes.amount, count: attributeTypes.count },
    { rate: 4, amount: 3, count: 5 },
  );
  assert.deepEqual({ big: attributeTypes.big, cost: attributeTypes.cost }, { big: 18, cost: 8 });
  assert.deepEqual(
    {
      when: attributeTypes.when,
      flag: attributeTypes.flag,
      status: attributeTypes.status,
      memo: attributeTypes.memo,
      parentlookup: attributeTypes.parentlookup,
    },
    { when: 2, flag: 0, status: 11, memo: 7, parentlookup: 6 },
  );
  const cells = await excelCells(app, session, secure, columns);
  assert.deepEqual(namedCell(cells, 'Pending child', 'B'), { type: 'n', value: '12345678901234567.891' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'C'), { type: 'n', value: '7' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'D'), { type: 'n', value: '1.5' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'E'), { type: 'n', value: '99.5' });
  assert.deepEqual(namedCell(cells, 'Pending child', 'K'), { type: 'n', value: '42' });
});
