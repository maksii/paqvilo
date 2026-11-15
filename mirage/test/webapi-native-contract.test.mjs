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

// @test-kind security: a navigation count reads the related table, so it is refused where the navigation read is refused, and counts only the rows a self-scope read shows
test('a navigation $count answers 403 where the navigation read is refused, and counts only visible rows', async (t) => {
  const parentOnly = [
    { id: 'account-read', entity: 'account', scope: 'global', roles: ['Writer'], operations: ['read'] },
  ];
  const refusedGet = await navigationGet(t, parentOnly);
  const refusedCount = await refusedGet(`${NAVIGATION}/$count`);
  assert.equal((await refusedGet(NAVIGATION)).status, 403);
  assert.equal(refusedCount.status, 403);
  assert.equal(JSON.parse(refusedCount.body).error.code, '90040120');

  const selfScoped = [
    ...parentOnly,
    { id: 'contact-read', entity: 'contact', scope: 'self', roles: ['Writer'], operations: ['read'] },
  ];
  const visibleGet = await navigationGet(t, selfScoped);
  const visibleCount = await visibleGet(`${NAVIGATION}/$count`);
  assert.equal(visibleCount.status, 200);
  assert.equal(visibleCount.body, '1');
});

// @test-kind security: a single-valued navigation's $count is refused as its GET is, so a caller who cannot read the related table cannot tell the cardinality from the status
test('a single-valued navigation $count answers the refusal its GET answers, not a 404', async (t) => {
  const SINGLE = `/_api/contacts(${G(11)})/parentcustomerid`;
  const contactOnly = [
    { id: 'contact-read', entity: 'contact', scope: 'self', roles: ['Writer'], operations: ['read'] },
  ];
  const refused = await navigationGet(t, contactOnly);
  const get = await refused(SINGLE);
  const count = await refused(`${SINGLE}/$count`);
  assert.equal(get.status, 403);
  assert.equal(count.status, get.status);
  assert.equal(JSON.parse(count.body).error.code, JSON.parse(get.body).error.code);
});
