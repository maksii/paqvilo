// @test-kind parity: two native authorized collection requests prove a missing savedQuery response including its status, code and message template.
// @parity-evidence: dataverse-root-savedquery-native.json binds exact plan and run hashes, request hashes and raw response hashes from both captures; only the request GUID is substituted in the message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';

const APP = '22222222-2222-4222-8222-222222222222';
const VIEW = 'bbbbbbbb-0000-4000-8000-000000000001';
const MISSING = 'bbbbbbbb-0000-4000-8000-0000000000ff';
const secretName = 'PAQVILO_ROOT_SAVEDQUERY_SECRET';
const bytes = readFileSync(new URL('./fixtures/dataverse-root-savedquery-native.json', import.meta.url));
const evidence = JSON.parse(bytes);
async function setup(t) {
  process.env[secretName] = 'test-only-secret';
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' }, rank: { dataverseType: 'int' } },
    relationships: {},
  };
  state.tables.widget = [
    { widgetid: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'keep', rank: 2 },
    { widgetid: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'omit', rank: 0 },
  ];
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP,
        displayName: 'Invented test app',
        secretEnvironmentVariable: secretName,
        roles: ['System Administrator'],
      },
    ],
  });
  const schema = () => ({
    views: [
      {
        id: VIEW,
        entity: 'widget',
        fetchXml:
          '<fetch><entity name="widget"><attribute name="name"/><filter><condition attribute="rank" operator="gt" value="0"/></filter></entity></fetch>',
      },
    ],
  });
  const api = await startDataverseApi({ store, settings, schema, log: () => {} });
  t.after(async () => {
    await api.close();
    delete process.env[secretName];
  });
  const tokenResponse = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: 'test-only-secret',
      scope: `${api.origin}/.default`,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const { access_token: token } = await tokenResponse.json();
  return (path) =>
    fetch(`${api.origin}/api/data/v9.2/${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'odata-version': '4.0',
        'odata-maxversion': '4.0',
      },
    });
}
test('wired collection returns the native missing savedQuery error', async (t) => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '7ca4e0414769ca0e4053016cef20e3f443f0a143b2199d72e4b24491b5757c7a',
  );
  assert.equal(evidence.captures.length, 2);
  assert.notEqual(evidence.captures[0].runSha256, evidence.captures[1].runSha256);
  assert.deepEqual(
    evidence.captures.map(({ status, code, messageTemplate }) => ({ status, code, messageTemplate })),
    Array(2).fill({
      status: 404,
      code: '0x80040217',
      messageTemplate: "Entity 'savedquery' With Id = {id} Does Not Exist",
    }),
  );
  const send = await setup(t);
  const response = await send(`widgets?savedQuery=${MISSING}`);
  const body = await response.json();
  assert.equal(response.status, evidence.captures[0].status);
  assert.equal(body.error.code, evidence.captures[0].code);
  assert.equal(body.error.message, evidence.captures[0].messageTemplate.replace('{id}', MISSING));
});
// @test-kind contract: an invented Solution view must be resolved by the default API extension and evaluated through FetchXML.
test('wired API executes a Solution view without a stored savedquery row', async (t) => {
  const send = await setup(t);
  const response = await send(`widgets?savedQuery=${VIEW}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(
    body.value.map((row) => row.name),
    ['keep'],
  );
});
