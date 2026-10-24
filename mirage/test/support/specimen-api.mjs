import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../../lib/data.mjs';
import { dataverseSettings } from '../../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../../lib/dataverse-api.mjs';
export const APP = '10000000-0000-4000-8000-000000000001',
  ID = '20000000-0000-4000-8000-000000000001',
  PART = '30000000-0000-4000-8000-000000000001';
export const API = '/api/data/v9.2/',
  SECRET = 'PAQVILO_DATAVERSE_BOM_TEST_SECRET';

export async function specimenApi(t, { fields = {}, rows } = {}) {
  const previous = process.env[SECRET];
  process.env[SECRET] = 'invented-loopback-bom-secret';
  t.after(() => {
    if (previous === undefined) delete process.env[SECRET];
    else process.env[SECRET] = previous;
  });
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
  Object.assign(state.mappings.specimen.fields, structuredClone(fields));
  if (rows) state.tables.specimen = structuredClone(rows);
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

  return { store, api, request };
}
