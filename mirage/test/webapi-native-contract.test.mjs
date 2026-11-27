// @test-kind contract: Local safety checks accompany the separately tagged, case-scoped native parity assertions below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSimulator } from '../server.mjs';
import { specimenApi, ID, PART } from './support/specimen-api.mjs';
import { captureWebApiInputContract } from '../testing/webapi-contract.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

// @test-kind observation: two full native rounds (2026-11-08) recorded in fixtures/webapi-native-input-errors.json as case ids, status, code and raw response hashes; the six invalid PATCH values are typed in mirage/testing/webapi-contract.mjs and the oracle request is not recorded, so this is not a replay case.
test('Dataverse rejects invalid HTTP primitives before an Upsert SDK existence observer', async (t) => {
  const inputBytes = fs.readFileSync(new URL('./fixtures/webapi-native-input-errors.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(inputBytes).digest('hex'),
    'f693fb977bf24aeb9b150d5110687fd9e24668164e395e15dccf3fbb5ed9b966',
  );
  assert.equal(
    createHash('sha256')
      .update(fs.readFileSync(new URL('../testing/webapi-contract.mjs', import.meta.url)))
      .digest('hex'),
    '8d30332b553e45f62de42e317e853d0753f98864c062ab688398415e9a378b3a',
  );
  const inputProof = JSON.parse(inputBytes);
  const { store, request } = await specimenApi(t, {
    fields: {
      ratio: { dataverseType: 'float', minValue: -1000, maxValue: 1000 },
      tags: {
        dataverseType: 'multiselectpicklist',
        options: [
          { value: 1, label: 'One' },
          { value: 2, label: 'Two' },
        ],
      },
    },
  });
  store.state.mappings.specimenpart.relationships = {
    specimen: { entity: 'specimen', from: 'specimenid', to: 'specimenid', many: false },
  };
  store.setPluginPipeline(() => {});
  const results = await captureWebApiInputContract({
    request,
    collection: 'specimens',
    recordId: ID,
    fields: { double: 'ratio', choices: 'tags' },
    binding: { collection: 'specimenparts', recordId: PART, navigation: 'specimen', targetCollection: 'specimens' },
  });
  assert.deepEqual(
    results,
    inputProof.cases.map(({ nativeBodySha256: _hashes, ...entry }) => entry),
  );
});

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const NAVIGATION = `/_api/accounts(${G(1)})/contact_customer_accounts`;
// Each table is a Web API entity set; the account navigation runs to contacts through parentcustomerid.
function navigationState(permissions) {
  const link = { id: G(1), logical_name: 'account', name: 'Contoso' };
  return {
    mappings: {
      account: {
        entitySet: 'accounts',
        idColumn: 'accountid',
        nameColumn: 'name',
        fields: { name: { dataverseType: 'nvarchar' } },
        relationships: {
          contact_customer_accounts: {
            entity: 'contact',
            from: 'accountid',
            to: 'parentcustomerid',
            many: true,
            schemaName: 'contact_customer_accounts',
          },
        },
      },
      contact: {
        entitySet: 'contacts',
        idColumn: 'contactid',
        nameColumn: 'fullname',
        fields: { fullname: { dataverseType: 'nvarchar' }, parentcustomerid: { dataverseType: 'lookup' } },
        relationships: {
          parentcustomerid: {
            entity: 'account',
            from: 'parentcustomerid',
            to: 'accountid',
            many: false,
            schemaName: 'contact_customer_accounts',
          },
        },
      },
    },
    tables: {
      account: [{ accountid: G(1), name: 'Contoso' }],
      contact: [
        { contactid: G(11), fullname: 'Ada', parentcustomerid: link },
        { contactid: G(12), fullname: 'Bob', parentcustomerid: link },
      ],
    },
    settings: { permissionMode: 'enforce' },
    permissions,
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identityScope: 'configured',
      identity: { id: G(11), contactId: G(11), roles: ['Writer'] },
      live: {},
      endpoints: [],
    },
  };
}
const NAVIGATION_SETTINGS = {
  'Webapi/account/enabled': 'true',
  'Webapi/account/fields': 'name,contact_customer_accounts',
  'Webapi/contact/enabled': 'true',
  'Webapi/contact/fields': 'fullname,parentcustomerid',
};
// Starts a simulator on the navigation state and answers a GET as { status, body } (body parsed when it is JSON).
async function navigationGet(t, permissions) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-navigation-count-'));
  ownedFixture(t).remove(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const settings = Object.entries(NAVIGATION_SETTINGS)
    .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${value}'`)
    .join('\n');
  fs.writeFileSync(path.join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Navigation count\n');
  fs.writeFileSync(path.join(directory, 'sitesetting.yml'), settings);
  const app = await createSimulator({
    sourceDir: directory,
    projectRoot: directory,
    initial: navigationState(permissions),
    watch: false,
  });
  ownedFixture(t).add(() => app.close());
  return async (route) => {
    const response = await fetch(app.url + route, { headers: { __RequestVerificationToken: app.csrf } });
    const text = await response.text();
    return { status: response.status, body: text };
  };
}

const NAVIGATION_COUNT_REFUSED = {
  status: 400,
  body: '{"error":{"code":"9004010A","message":"An unexpected error occurred while processing the request"}}',
};

// @test-kind security+observation: a navigation $count answers one constant refusal, 400 9004010A, whether or not the caller can read the related rows, so its status and body tell nothing about them (hosted session F1 follow-up 2026-11-27 (paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup navcount-*: collection-valued and single-valued, ordinary and provider-backed targets, Contact and Global scope))
test('a navigation $count answers 400 9004010A whether or not the navigation read is refused', async (t) => {
  const parentOnly = [
    { id: 'account-read', entity: 'account', scope: 'global', roles: ['Writer'], operations: ['read'] },
  ];
  const refusedGet = await navigationGet(t, parentOnly);
  assert.equal((await refusedGet(NAVIGATION)).status, 403);
  assert.deepEqual(await refusedGet(`${NAVIGATION}/$count`), NAVIGATION_COUNT_REFUSED);

  const selfScoped = [
    ...parentOnly,
    { id: 'contact-read', entity: 'contact', scope: 'self', roles: ['Writer'], operations: ['read'] },
  ];
  const visibleGet = await navigationGet(t, selfScoped);
  assert.deepEqual(await visibleGet(`${NAVIGATION}/$count`), NAVIGATION_COUNT_REFUSED);
});

// @test-kind observation: a navigation $count answers 400 9004010A with or without an authored $filter (hosted session F1 follow-up 2026-11-27 (paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup navcount-*: collection-valued and single-valued, ordinary and provider-backed targets, Contact and Global scope))
test('a navigation $count answers 400 9004010A with authored filters too', async (t) => {
  const get = await navigationGet(t, [
    { id: 'account-read', entity: 'account', scope: 'global', roles: ['Writer'], operations: ['read'] },
    { id: 'contact-read', entity: 'contact', scope: 'self', roles: ['Writer'], operations: ['read'] },
  ]);
  for (const name of ['Ada', 'Bob', 'Unmatched']) {
    const params = new URLSearchParams({ $filter: 'fullname eq @name', '@name': `'${name}'` });
    assert.deepEqual(await get(`${NAVIGATION}/$count?${params}`), NAVIGATION_COUNT_REFUSED);
  }
});

// @test-kind security+observation: a single-valued navigation's $count answers the same constant refusal whether or not the caller can read the related table, so a caller cannot tell the cardinality from it (hosted session F1 follow-up 2026-11-27 (paqvilo-developer hosted-f1 summary-F1, runs/a and runs/b nav-followup navcount-*: collection-valued and single-valued, ordinary and provider-backed targets, Contact and Global scope))
test('a single-valued navigation $count answers 400 9004010A whatever the caller can read', async (t) => {
  const SINGLE = `/_api/contacts(${G(11)})/parentcustomerid`;
  const contactOnly = [
    { id: 'contact-read', entity: 'contact', scope: 'self', roles: ['Writer'], operations: ['read'] },
  ];
  const refused = await navigationGet(t, contactOnly);
  assert.equal((await refused(SINGLE)).status, 403);
  assert.deepEqual(await refused(`${SINGLE}/$count`), NAVIGATION_COUNT_REFUSED);
  const readable = await navigationGet(t, [
    ...contactOnly,
    { id: 'account-read', entity: 'account', scope: 'global', roles: ['Writer'], operations: ['read'] },
  ]);
  assert.deepEqual(await readable(`${SINGLE}/$count`), NAVIGATION_COUNT_REFUSED);
});
