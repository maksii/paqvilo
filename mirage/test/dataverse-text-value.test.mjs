import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { PNG } from 'pngjs';
import { encodeDataverseText } from '../lib/dataverse-text-value.mjs';
test('primitive text encoding respects explicit provider MIME types and header casing', () => {
  for (const name of ['content-type', 'Content-Type', 'CONTENT-TYPE']) {
    for (const type of ['application/octet-stream', 'Application/JSON; charset=utf-8', 'application/xml']) {
      const result = { status: 200, headers: { [name]: type }, body: 'provider bytes' };
      assert.equal(encodeDataverseText({ kind: 'value' }, result), result);
    }
    const result = { status: 200, headers: { [name]: 'Text/Plain; charset=UTF-8' }, body: 'value' };
    const encoded = encodeDataverseText({ kind: 'value' }, result);
    assert.equal(encoded.body, '\uFEFFvalue');
    assert.equal(encoded.headers, result.headers);
  }
  const existingBom = { status: 200, body: '\uFEFFliteral leading character' };
  assert.equal(
    encodeDataverseText({ kind: 'value' }, existingBom).body,
    '\uFEFF\uFEFFliteral leading character',
    'encoding BOM does not consume an authored leading character',
  );
});
const APP = '10000000-0000-4000-8000-000000000001',
  ID = '20000000-0000-4000-8000-000000000001',
  PART = '30000000-0000-4000-8000-000000000001';
const API = '/api/data/v9.2/',
  SECRET = 'PAQVILO_DATAVERSE_BOM_TEST_SECRET';
test('Dataverse primitive text and counts carry a BOM without changing JSON, nulls or binary streams', async (t) => {
  const previous = process.env[SECRET];
  process.env[SECRET] = 'invented-loopback-bom-secret';
  const state = emptyState();
  state.mappings.specimen = {
    logicalName: 'specimen',
    entitySet: 'specimens',
    idColumn: 'specimenid',
    nameColumn: 'name',
    fields: {
      name: { dataverseType: 'nvarchar' },
      memo: { dataverseType: 'ntext' },
      quantity: { dataverseType: 'int' },
      enabled: { dataverseType: 'bit' },
      amount: { dataverseType: 'decimal' },
      price: { dataverseType: 'money' },
      stamp: { dataverseType: 'datetime' },
      empty: { dataverseType: 'nvarchar' },
      attachment: { dataverseType: 'file', MaxSizeInKB: 64 },
      photo: { dataverseType: 'image', canStoreFullImage: true },
    },
    relationships: { parts: { entity: 'specimenpart', from: 'specimenid', to: 'specimenid', many: true } },
  };
  state.mappings.specimenpart = {
    logicalName: 'specimenpart',
    entitySet: 'specimenparts',
    idColumn: 'specimenpartid',
    nameColumn: 'name',
    fields: { name: { dataverseType: 'nvarchar' }, specimenid: { dataverseType: 'lookup' } },
  };
  state.tables.specimen = [
    {
      specimenid: ID,
      name: 'Unicode Ω 日本語 😀',
      memo: 'line one\r\nline two',
      quantity: 7,
      enabled: true,
      amount: 1.25,
      price: 2.5,
      stamp: '2020-01-15T12:34:56Z',
      empty: null,
    },
  ];
  state.tables.specimenpart = [{ specimenpartid: PART, name: 'Part', specimenid: ID }];
  const store = await new DataStore({ state }).init(),
    api = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: 'BOM fixture client',
            secretEnvironmentVariable: SECRET,
            roles: ['System Administrator'],
          },
        ],
      }),
      log: () => {},
    });
  t.after(async () => {
    await api.close();
    if (previous === undefined) delete process.env[SECRET];
    else process.env[SECRET] = previous;
  });
  const tokenResponse = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[SECRET],
      scope: `${api.origin}/.default`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  const request = (path, options = {}) =>
    fetch(api.origin + API + path, { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers } });
  const raw = async (path, expected) => {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from('\uFEFF' + expected), path);
  };
  for (const [column, value] of Object.entries({
    name: 'Unicode Ω 日本語 😀',
    memo: 'line one\r\nline two',
    quantity: '7',
    enabled: 'true',
    amount: '1.25',
    price: '2.5',
    stamp: '2020-01-15T12:34:56Z',
  }))
    await t.test(column, () => raw(`specimens(${ID})/${column}/$value`, value));
  await raw('specimens/$count', '1');
  await raw(`specimens(${ID})/parts/$count`, '1');
  await raw('activitypointers/$count', '0');
  const empty = await request(`specimens(${ID})/empty/$value`);
  assert.equal(empty.status, 204);
  assert.equal((await empty.arrayBuffer()).byteLength, 0);
  const json = await request(`specimens(${ID})/name`),
    jsonBytes = Buffer.from(await json.arrayBuffer());
  assert.notDeepEqual(jsonBytes.subarray(0, 3), Buffer.from([239, 187, 191]));
  assert.equal(JSON.parse(jsonBytes).value, 'Unicode Ω 日本語 😀');
  const file = Buffer.from('\uFEFFbinary file bytes');
  assert.equal(
    (
      await request(`specimens(${ID})/attachment`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/octet-stream', 'x-ms-file-name': 'owned.txt' },
        body: file,
      })
    ).status,
    204,
  );
  const download = await request(`specimens(${ID})/attachment/$value`);
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), file);
  const png = PNG.sync.write({ width: 1, height: 1, data: Buffer.from([25, 50, 75, 255]) });
  assert.equal(
    (
      await request(`specimens(${ID})`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ photo: png.toString('base64') }),
      })
    ).status,
    204,
  );
  for (const suffix of ['', '?size=full']) {
    const image = await request(`specimens(${ID})/photo/$value${suffix}`);
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  }
  const batch = await request('$batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requests: [
        { id: 'raw', method: 'GET', url: `${api.origin}${API}specimens(${ID})/quantity/$value` },
        { id: 'count', method: 'GET', url: `${api.origin}${API}specimens/$count` },
      ],
    }),
  });
  assert.equal(batch.status, 200);
  const batchBytes = Buffer.from(await batch.arrayBuffer());
  assert.ok(batchBytes.includes(Buffer.from('\r\n\r\n\uFEFF7\r\n')));
  assert.ok(batchBytes.includes(Buffer.from('\r\n\r\n\uFEFF1\r\n')));
  assert.equal((batchBytes.toString().match(/Content-Type: text\/plain/gi) ?? []).length, 2);
});
