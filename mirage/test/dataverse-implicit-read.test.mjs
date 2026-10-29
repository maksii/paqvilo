// Organization reads use the same inferred OData definitions as metadata.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const ID = '11111111-1111-4111-8111-111111111111';
const EMPTY = '22222222-2222-4222-8222-222222222222';
const IMAGE = '33333333-3333-4333-8333-333333333333';
const SECRET = 'PAQ_IMPLICIT_READ_TEST_SECRET';
const BASE = '/api/data/v9.2';

describe('implicit OData read companions', () => {
  let api, store, token, previousSecret;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(api.origin + BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const selected = (id, columns) => `/x_components(${id})?$select=${columns.join(',')}`;
  before(async () => {
    previousSecret = process.env[SECRET];
    process.env[SECRET] = 'invented-test-secret';
    const state = emptyState();
    state.mappings.x_component = {
      entitySet: 'x_components',
      idColumn: 'x_componentid',
      nameColumn: 'x_name',
      fields: {
        x_name: { dataverseType: 'nvarchar' },
        x_money: { dataverseType: 'money' },
        x_file: { dataverseType: 'file' },
        x_image: { dataverseType: 'image' },
        x_choice: { dataverseType: 'picklist' },
        x_date: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
        x_timestamp: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' },
        statuscode: { dataverseType: 'status', options: [{ value: 1, label: 'Local draft', state: 0 }] },
      },
    };
    state.tables.x_component = [
      {
        x_componentid: ID,
        x_name: 'Stored companions',
        statuscode: 1,
        importsequencenumber: 7,
        overriddencreatedon: '2020-01-15T10:30:00Z',
        timezoneruleversionnumber: 9,
        utcconversiontimezonecode: 85,
        x_money: 12.5,
        x_money_base: 12.5,
        exchangerate: 1,
        x_file_name: 'Invented.txt',
        x_imageid: IMAGE,
        x_image_url: '/local/image',
        x_image_timestamp: 42,
        x_choicename: 'Metadata-only name',
      },
      { x_componentid: EMPTY, x_name: 'No companion values' },
    ];
    state.mappings.x_virtual = {
      entitySet: 'x_virtuals',
      idColumn: 'x_virtualid',
      nameColumn: 'x_name',
      tableType: 'Virtual',
      fields: { x_name: { dataverseType: 'nvarchar' }, x_date: { dataverseType: 'datetime' } },
    };
    state.tables.x_virtual = [{ x_virtualid: ID, x_name: 'Declared virtual row', x_date: '2026-10-20T10:30:00Z' }];
    store = await new DataStore({ state }).init();
    // The virtual table has no provider: it declares the local fallback, so its seeded row is read locally (without the
    // declaration a providerless virtual table answers 501 VirtualProviderMissing).
    const extensions = EXTENSIONS.map((entry) =>
      entry.name !== 'dataverse-virtual-providers'
        ? entry
        : {
            ...entry,
            install: (target, options) =>
              entry.install(target, { ...options, virtualTables: { x_virtual: { fallback: 'local' } } }),
          },
    );
    api = await startDataverseApi({
      store,
      log: () => {},
      extensions,
      schema: () => ({
        tables: {
          x_component: {
            logicalName: 'x_component',
            primaryIdAttribute: 'x_componentid',
            primaryNameAttribute: 'x_name',
            // A selected Solution may omit system columns whose observed formatting facts are held by the mapping.
            attributes: Object.fromEntries(
              Object.entries(state.mappings.x_component.fields)
                .filter(([name]) => name !== 'statuscode')
                .map(([name, field]) => [
                  name,
                  { name, type: field.dataverseType, dateTimeBehavior: field.dateTimeBehavior },
                ]),
            ),
          },
        },
        targets: {},
        relationships: {},
        optionSets: {},
      }),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: 'Invented companion reader',
            secretEnvironmentVariable: SECRET,
            roles: ['System Administrator'],
          },
        ],
      }),
    });
    const issued = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP,
        client_secret: process.env[SECRET],
        scope: `${api.origin}/.default`,
      }),
    });
    assert.equal(issued.status, 200);
    token = (await issued.json()).access_token;
  });
  after(async () => {
    await api?.close();
    if (previousSecret === undefined) delete process.env[SECRET];
    else process.env[SECRET] = previousSecret;
  });

  it('selects stored system, file, image and money companions without changing storage', async () => {
    const columns = [
      'importsequencenumber',
      'overriddencreatedon',
      'timezoneruleversionnumber',
      'utcconversiontimezonecode',
      'x_money_base',
      'exchangerate',
      'x_file_name',
      'x_imageid',
      'x_image_url',
      'x_image_timestamp',
    ];
    const before = structuredClone(store.state.tables.x_component);
    const response = await request('GET', selected(ID, columns));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    for (const name of columns) assert.notEqual(response.body[name], undefined, name);
    assert.equal(response.body.importsequencenumber, 7);
    assert.match(response.body.overriddencreatedon, /^2020-01-15T10:30:00/);
    assert.equal(response.body.timezoneruleversionnumber, 9);
    assert.equal(response.body.utcconversiontimezonecode, 85);
    assert.equal(response.body.x_money_base, 12.5);
    assert.equal(response.body.x_file_name, 'Invented.txt');
    assert.equal(response.body.x_imageid, IMAGE);
    assert.equal(response.body.x_image_url, '/local/image');
    assert.equal(response.body.x_image_timestamp, 42);
    const property = await request('GET', `/x_components(${ID})/x_file_name`);
    assert.equal(property.status, 200);
    assert.equal(property.body.value, 'Invented.txt');
    assert.deepEqual(store.state.tables.x_component, before);
  });

  it('projects known but unset companions as null and rejects unknown and non-OData names', async () => {
    const columns = [
      'importsequencenumber',
      'overriddencreatedon',
      'timezoneruleversionnumber',
      'utcconversiontimezonecode',
      'x_money_base',
      '_transactioncurrencyid_value',
      'exchangerate',
      'x_file_name',
      'x_imageid',
      'x_image_url',
      'x_image_timestamp',
    ];
    const response = await request('GET', selected(EMPTY, columns));
    assert.equal(response.status, 200);
    for (const name of columns) assert.equal(response.body[name], null, name);
    assert.equal((await request('GET', selected(ID, ['x_choicename']))).status, 400);
    assert.equal((await request('GET', selected(ID, ['x_nonexistent']))).status, 400);
    const full = await request('GET', `/x_components(${ID})`);
    assert.equal(Object.hasOwn(full.body, 'x_choicename'), false);
    assert.equal((await request('GET', `/x_components(${EMPTY})/x_file_name`)).status, 204);
  });

  it('admits companion collection projections, filters and order while write admission stays unchanged', async () => {
    const response = await request(
      'GET',
      '/x_components?$select=x_file_name,x_image_timestamp&$filter=x_image_timestamp%20gt%201&$orderby=x_file_name',
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.value.length, 1);
    assert.equal(response.body.value[0].x_file_name, 'Invented.txt');
    const before = structuredClone(store.state.tables.x_component);
    assert.equal((await request('PATCH', `/x_components(${ID})`, { x_image_timestamp: 99 })).status, 400);
    assert.equal(
      (await request('PUT', `/x_components(${ID})/x_file_name`, { value: 'Cannot write a read companion' })).status,
      400,
    );
    assert.deepEqual(store.state.tables.x_component, before);
  });

  it('projects the established DateOnly stamp and base-currency companions without persisting derived values', async () => {
    const response = await request(
      'POST',
      '/x_components',
      { x_name: 'Derived read values', x_money: 6.25, x_date: '2026-10-20' },
      { prefer: 'return=representation' },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = response.body.x_componentid;
    const stored = structuredClone(store.state.tables.x_component.find((row) => row.x_componentid === id));
    const read = await request(
      'GET',
      selected(id, ['timezoneruleversionnumber', 'x_money_base', 'exchangerate']),
      undefined,
      { prefer: 'odata.include-annotations="*"' },
    );
    assert.equal(read.status, 200);
    assert.equal(read.body.timezoneruleversionnumber, 4);
    assert.equal(read.body['timezoneruleversionnumber@OData.Community.Display.V1.FormattedValue'], '4');
    assert.equal(read.body.x_money_base, 6.25);
    assert.equal(read.body.exchangerate, 1);
    assert.deepEqual(
      store.state.tables.x_component.find((row) => row.x_componentid === id),
      stored,
    );
  });

  it("uses a virtual table's declared schema without synthesizing ordinary-table system properties", async () => {
    const read = await request('GET', `/x_virtuals(${ID})`);
    assert.equal(read.status, 200);
    assert.equal(read.body.x_name, 'Declared virtual row');
    for (const name of [
      'createdon',
      'statecode',
      'statuscode',
      'versionnumber',
      'importsequencenumber',
      'timezoneruleversionnumber',
    ])
      assert.equal(Object.hasOwn(read.body, name), false, name);
    assert.equal((await request('GET', `/x_virtuals(${ID})?$select=importsequencenumber`)).status, 400);
  });

  it('preserves observed status option labels when a selected Solution omits that system field', async () => {
    const read = await request('GET', selected(ID, ['statuscode']), undefined, {
      prefer: 'odata.include-annotations="*"',
    });
    assert.equal(read.status, 200);
    assert.equal(read.body.statuscode, 1);
    assert.equal(read.body['statuscode@OData.Community.Display.V1.FormattedValue'], 'Local draft');
  });

  it('does not infer a time-zone stamp from implicit audit dates on a text-only record', async () => {
    const headers = { prefer: 'return=representation,odata.include-annotations="*"' };
    const created = await request('POST', '/x_components', { x_name: 'Text with audit timestamps' }, headers);
    assert.equal(created.status, 201);
    const annotation = 'timezoneruleversionnumber@OData.Community.Display.V1.FormattedValue';
    assert.ok(created.body.createdon);
    assert.ok(created.body.modifiedon);
    assert.equal(created.body.timezoneruleversionnumber, null);
    assert.equal(Object.hasOwn(created.body, annotation), false);
    const id = created.body.x_componentid;
    const single = await request('GET', `/x_components(${id})`, undefined, { prefer: 'odata.include-annotations="*"' });
    assert.equal(single.body.timezoneruleversionnumber, null);
    assert.equal(Object.hasOwn(single.body, annotation), false);
    const selectedStamp = await request('GET', selected(id, ['timezoneruleversionnumber']), undefined, {
      prefer: 'odata.include-annotations="*"',
    });
    assert.equal(selectedStamp.body.timezoneruleversionnumber, null);
    const dated = await request(
      'POST',
      '/x_components',
      { x_name: 'Explicit user-local date', x_timestamp: '2026-10-20T10:30:00Z' },
      headers,
    );
    assert.equal(dated.status, 201);
    assert.equal(dated.body.timezoneruleversionnumber, 4);
    assert.equal(dated.body[annotation], '4');
    assert.equal(
      store.state.tables.x_component.find((row) => row.x_componentid === id).timezoneruleversionnumber,
      undefined,
      'inference changes no stored values',
    );
  });
});
