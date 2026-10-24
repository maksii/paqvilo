import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
const APP = '10000000-0000-4000-8000-000000000001',
  ID = '20000000-0000-4000-8000-000000000001',
  PART = '30000000-0000-4000-8000-000000000001';
const API = '/api/data/v9.2/',
  SECRET = 'PAQVILO_DATAVERSE_BOM_TEST_SECRET';
test('Dataverse HTTP structured reader errors retain causes without touching internal SDK/portal formatting', async (t) => {
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

  const beforeRow = JSON.stringify(store.state.tables.specimen[0]);
  for (const body of ['null', '[]']) {
    const unknown = await request('absent_records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(unknown.status, 404, 'unknown entity stays ahead of root payload diagnostics');
    const unauthenticated = await fetch(api.origin + API + 'specimens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    assert.equal(unauthenticated.status, 401, 'authentication stays ahead of payload diagnostics');
  }

  for (const field of ['name', 'quantity', 'enabled', 'amount', 'price', 'stamp'])
    for (const value of [[], {}])
      for (const method of ['POST', 'PATCH'])
        await t.test(method + ' ' + field + ' ' + (Array.isArray(value) ? 'array' : 'object'), async () => {
          const response = await request(method === 'POST' ? 'specimens' : 'specimens(' + ID + ')', {
            method,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [field]: value }),
          });
          assert.equal(response.status, 400);
          const error = (await response.json()).error;
          assert.equal(error.code, '0x80048d19');
          assert.ok(error.message.includes(method === 'POST' ? "Entity :'specimens'" : "Entity :''"));
          assert.ok(error.message.includes(Array.isArray(value) ? "'StartArray'" : "'StartObject'"));
          assert.ok(error.message.includes("'PrimitiveValue' node was expected"));
          if (!Array.isArray(value)) assert.ok(error.message.includes("property named '" + field + "'"));
          assert.equal(error.message.includes('   at '), false);
        });
  for (const body of ['null', '[]'])
    for (const method of ['POST', 'PATCH']) {
      const response = await request(method === 'POST' ? 'specimens' : 'specimens(' + ID + ')', {
        method,
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 400);
      const error = (await response.json()).error;
      assert.equal(error.code, '0x80048d19');
      assert.ok(error.message.includes("'EndOfInput'"));
      assert.ok(error.message.includes("'StartObject' node was expected"));
    }
  const lexeme = '1.2345678901234567890123456789';
  const exact = await request('specimens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"quantity":' + lexeme + '}',
  });
  assert.equal(exact.status, 400);
  assert.ok((await exact.json()).error.message.includes(lexeme), 'raw numeric literal preserved');
  const mapping = store.state.mappings.specimen;
  assert.throws(
    () => store.coerceRecord(mapping, { quantity: [] }, { dataverseWebApi: true }),
    (error) => error.message.includes('Cannot convert') && !error.message.includes('StartArray'),
  );
  assert.throws(
    () => store.coerceRecord(mapping, { quantity: {} }, { coerce: true }),
    (error) => error.message.includes('Cannot convert') && !error.message.includes('StartObject'),
  );
  assert.equal(store.state.tables.specimen.length, 1);
  assert.equal(JSON.stringify(store.state.tables.specimen[0]), beforeRow);
});
