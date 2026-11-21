// @test-kind contract: the baseline fixture generators and live reset produce the designed rows, forms and request bodies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FORMS, extras, BANNER_HTML } from '../baseline/generate.mjs';

test('the baseline bigint fixture preserves its exact value through JSON', async () => {
  const data = await import('../baseline/data.mjs');
  const row = data.records().rows.find((record) => record.fields.pqvd_bigint != null);
  assert.equal(JSON.parse(JSON.stringify(row)).fields.pqvd_bigint, '9007199254740993');
});

test('the live reset sends the bigint column as an exact JSON number, the form Dataverse accepts for Edm.Int64', async () => {
  const data = await import('../baseline/data.mjs');
  const bodies = [];
  const client = {
    list: async () => [],
    optional: async () => null,
    request: async (relative, { method, body }) => {
      if (method === 'PATCH') bodies.push(JSON.stringify(body));
      return { data: null };
    },
    url: (relative) => relative,
    token: async () => 'invented',
    fetch: async () => new Response(null, { status: 204 }),
  };
  await data.resetLive(client, { apply: true, tester: data.TESTER_CONTACT });
  const sent = bodies.filter((body) => body.includes('pqvd_bigint'));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /"pqvd_bigint":9007199254740993[,}]/);
});

// A live environment holding exactly the fixture: each row read back with its lookups as `_field_value`.
async function convergedClient() {
  const data = await import('../baseline/data.mjs');
  const { rows, resolved } = data.records(data.TESTER_CONTACT);
  const live = new Map();
  for (const row of rows) {
    const record = { ...row.fields };
    for (const [field, key] of Object.entries(row.refs)) record[`_${field}_value`] = key ? resolved[key].id : null;
    if (row.table === data.ITEM) record._transactioncurrencyid_value = data.CURRENCY;
    const set = data.TABLES.find((table) => table.name === row.table).entitySet;
    live.set(`${set}(${row.id})`, record);
  }
  const brief = Buffer.from('Baseline fixture attachment.\nThis file is invented test data.\n', 'utf8');
  const writes = [];
  const client = {
    live,
    writes,
    list: async () => [],
    optional: async (relative) => structuredClone(live.get(relative.split('?')[0]) ?? null),
    request: async (relative, { method, body }) => {
      writes.push({ method, relative, body });
      return { data: null };
    },
    url: (relative) => relative,
    token: async () => 'invented',
    fetch: async (url, { method = 'GET' } = {}) => {
      if (method !== 'GET') writes.push({ method, relative: url });
      return method === 'GET'
        ? new Response(brief, { headers: { 'x-ms-file-name': 'baseline-brief.txt' } })
        : new Response(null, { status: 204 });
    },
  };
  return { data, client };
}

test('the live reset plan of a converged environment has nothing to do, and apply writes nothing', async () => {
  const { data, client } = await convergedClient();
  // Live text can come back with CRLF line ends and GUIDs in upper case; neither is a difference.
  const item1 = client.live.get(`${data.ITEM}s(${data.ids.item1})`);
  item1.pqvd_textarea = 'line one\r\nline two';
  item1._pqvd_contactid_value = data.TESTER_CONTACT.toUpperCase();
  for (const apply of [false, true]) {
    const summary = await data.resetLive(client, { apply, tester: data.TESTER_CONTACT });
    assert.deepEqual(
      [summary.changes, summary.unchanged, summary.files, summary.deleted],
      [[], data.records().rows.length, [], []],
    );
  }
  assert.deepEqual(client.writes, []);
});

test('the live reset plan names the differing fields and apply writes only those', async () => {
  const { data, client } = await convergedClient();
  const items = `${data.ITEM}s`;
  Object.assign(client.live.get(`${items}(${data.ids.item2})`), { pqvd_wholenumber: 8, _pqvd_parentid_value: null });
  client.live.get(`${items}(${data.ids.item3})`).statecode = 0;
  client.live.delete(`${items}(${data.ids.item4})`);
  const plan = await data.resetLive(client, { tester: data.TESTER_CONTACT });
  assert.deepEqual(
    plan.changes.map((change) => [change.key, change.fields.length > 3 ? 'all' : change.fields]),
    [
      ['item2', ['pqvd_wholenumber', '_pqvd_parentid_value']],
      ['item3', ['statecode']],
      ['item4', 'all'],
    ],
  );
  assert.equal(plan.unchanged, data.records().rows.length - 3);
  assert.deepEqual(client.writes, []);
  await data.resetLive(client, { apply: true, tester: data.TESTER_CONTACT });
  assert.deepEqual(client.writes.slice(0, 2), [
    {
      method: 'PATCH',
      relative: `${items}(${data.ids.item2})`,
      body: { pqvd_wholenumber: 7, 'pqvd_parentid@odata.bind': `/${data.PARENT}s(${data.ids.parent1})` },
    },
    { method: 'PATCH', relative: `${items}(${data.ids.item3})`, body: { statecode: 1, statuscode: 2 } },
  ]);
  assert.equal(client.writes.length, 4, 'the missing item4 is written whole: fields, then its state');
  assert.equal(client.writes[2].relative, `${items}(${data.ids.item4})`);
  assert.equal(Object.keys(client.writes[2].body).length, 9, 'six columns, two lookups and the currency');
});

test('provisioning verifies the maker-portal rollup: pending, defined as declared, or defined otherwise', async () => {
  const { ensureExtraColumn } = await import('../baseline/provision.mjs');
  const column = {
    table: 'pqvd_baselineparent',
    name: 'pqvd_rollup',
    kind: 'rollup',
    manual: true,
    related: 'pqvd_baselineitem',
    lookup: 'pqvd_parentid',
  };
  const declared =
    '<Activity><mxswa:GetEntityProperty Attribute="pqvd_baselineitemid" Entity="pqvd_baselineitem"/><Aggregate Function="Count"/><LinkEntity Relationship="pqvd_baselineparent_baselineitem" Attribute="pqvd_parentid"/></Activity>';
  const action = async (exists, xaml) => {
    const journal = [];
    const writes = [];
    const client = {
      list: async () => (exists ? [{ LogicalName: column.name, MetadataId: 'invented' }] : []),
      get: async () => ({ FormulaDefinition: xaml }),
      request: async (...args) => writes.push(args),
    };
    await ensureExtraColumn(client, column, { apply: true, solution: 'Invented', journal });
    assert.deepEqual(writes, [], 'a maker-portal column is verified, never written');
    return journal[0].action;
  };
  assert.equal(await action(false), 'manual-step-pending');
  assert.equal(await action(true, declared), 'exists');
  assert.equal(await action(true, declared.replaceAll('pqvd_parentid', 'pqvd_anyid')), 'manual-step-mismatch');
  assert.equal(await action(true, null), 'manual-step-mismatch');
});

test('the baseline data catalogue declares only manifest keys and leaves the per-site tester unchecked', async () => {
  const { catalogue, records } = await import('../baseline/data.mjs');
  const { validateCatalogue } = await import('paqvilo/dataverse');
  const manifest = JSON.parse(await fs.readFile(new URL('../baseline/dataverse/manifest.json', import.meta.url)));
  const data = validateCatalogue(catalogue());
  for (const table of data.tables) {
    const declared = manifest.tables.find((t) => t.name === table.name);
    if (!declared || declared.existing) continue;
    const keys = (declared.keys ?? []).map((key) => JSON.stringify(key.columns));
    for (const key of table.keys) assert.ok(keys.includes(JSON.stringify(key)), `${table.name} key ${key}`);
  }
  const testerLinks = records().rows.flatMap((row) =>
    Object.entries(row.refs).flatMap(([field, key]) => (key === 'tester' ? [[row.key, field]] : [])),
  );
  assert.ok(testerLinks.length > 0, 'the fixture links rows to the tester');
  for (const [key, field] of testerLinks)
    assert.ok(!(field in data.records.find((record) => record.key === key).refs), `${key}.${field} left unchecked`);
});

test('provisioning diagnostics report failed requests but not reads that find nothing', async (t) => {
  const { installFetchDiagnostics } = await import('../baseline/provision.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-diag-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const printed = [];
  t.mock.method(console, 'error', (line) => printed.push(line));
  const client = { fetch: async (_url, init) => new Response('{}', { status: init?.status ?? 404 }) };
  installFetchDiagnostics(client, dir);
  await client.fetch('https://invented.example/api/data/v9.2/savedqueries(1)');
  assert.deepEqual(printed, [], 'an absence probe is not an error');
  await client.fetch('https://invented.example/api/data/v9.2/savedqueries', { method: 'POST', status: 400 });
  await client.fetch('https://invented.example/api/data/v9.2/savedqueries(1)', { method: 'DELETE', status: 404 });
  assert.deepEqual(
    printed.map((line) => JSON.parse(line).apiError),
    [400, 404],
  );
});

test('item main form places each column once outside hidden sections and tabs', () => {
  const xml = FORMS.find((form) => form.file === 'item-main').build();
  // Hidden tabs and sections are not rendered, so the platform does not count them; strip them before counting.
  const visible = xml
    .replace(/<tab [^>]*visible="false"[\s\S]*?<\/tab>/g, '')
    .replace(/<section [^>]*visible="false"[\s\S]*?<\/section>/g, '');
  const fields = [...visible.matchAll(/<control id="([^"]+)" classid="[^"]+" datafieldname="([^"]+)"/g)]
    .filter(([, id]) => !id.startsWith('quickview_'))
    .map(([, , field]) => field);
  assert.deepEqual(
    fields.filter((field, index) => fields.indexOf(field) !== index),
    [],
  );
  assert.match(xml, /<Url>pqvd_baseline_banner\.html<\/Url>/);
});

test('form web resource is a static HTML document so it renders inline as well as framed', () => {
  const spec = extras().webResource;
  assert.deepEqual(
    [spec.name, spec.type, spec.retire],
    ['pqvd_baseline_banner.html', 1, ['pqvd_baseline_icon.png', 'pqvd_baseline_icon.svg']],
  );
  assert.equal(Buffer.from(spec.content, 'base64').toString('utf8'), BANNER_HTML);
  assert.match(BANNER_HTML, /^<!DOCTYPE html>[\s\S]*<h2 class="baseline-banner">/);
  assert.doesNotMatch(BANNER_HTML, /<script|on[a-z]+=/i);
});

test('stepped insert form keeps the Related tab without the quick view, which needs a saved record', () => {
  const build = (file) => FORMS.find((form) => form.file === file).build();
  assert.match(build('item-main'), /id="quickview_parent"/);
  const steps = build('item-steps');
  assert.doesNotMatch(steps, /quickview_parent/);
  assert.match(steps, /<tab name="related"[\s\S]*id="subgrid_children"[\s\S]*<\/tab>/);
  assert.equal(FORMS.find((form) => form.file === 'item-steps').name, 'Baseline Item Steps');
});

test('contact- and account-filtered item lists show at least four rows whose code order differs from name order', async () => {
  const data = await import('../baseline/data.mjs');
  const items = data.records().rows.filter((row) => row.table === data.ITEM);
  const check = (rows) => {
    const codes = rows.map((row) => row.fields.pqvd_code);
    assert.ok(new Set(codes).size >= 4, codes.join());
    const byName = [...rows]
      .sort((a, b) => a.fields.pqvd_name.localeCompare(b.fields.pqvd_name, 'en'))
      .map((row) => row.fields.pqvd_code);
    assert.notDeepEqual(byName, [...codes].sort());
  };
  check(items.filter((row) => row.refs.pqvd_contactid === 'tester')); // item-list-mine: all states (All Baseline Items view)
  check(items.filter((row) => row.refs.pqvd_accountid === 'account' && row.fields.statecode === 0)); // item-list-options: active view, account filter
});

test('fixed insert multistep shows a parent reference form whose control ids the item create form does not repeat', () => {
  const ids = (file) =>
    [
      ...FORMS.find((form) => form.file === file)
        .build()
        .matchAll(/<control id="([^"]+)"/g),
    ].map((match) => match[1]);
  const create = ids('item-lookup-create');
  assert.ok(ids('parent-main').some((id) => create.includes(id))); // the observed failure stays in multistep-insert
  assert.deepEqual(
    ids('parent-reference').filter((id) => create.includes(id)),
    [],
  );
  assert.equal(FORMS.find((form) => form.file === 'parent-reference').name, 'Baseline Parent Reference');
});

test('the manifest alone declares the fixture tables as whole solution roots, so provisioning has one source', async () => {
  const fs = await import('node:fs/promises');
  const { validateManifest } = await import('paqvilo/lense/dataverse/manifest.mjs');
  const read = async (file) => JSON.parse(await fs.readFile(new URL(`../baseline/dataverse/${file}`, import.meta.url)));
  const manifest = validateManifest(await read('manifest.json'));
  assert.deepEqual(
    manifest.tables.filter((t) => t.includeAllSubcomponents).map((t) => t.name),
    ['pqvd_baselineparent', 'pqvd_baselineitem', 'pqvd_baselinechild'],
  );
  assert.equal((await read('extras.json')).includeAllSubcomponents, undefined, 'extras must not re-scope the roots');
});
