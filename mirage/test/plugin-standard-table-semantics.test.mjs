// @test-kind parity: native and native-r2 mergeAccount (account Create/10 Target defaults 2737/7368, Create/20 FormattedValues 7371, Merge images without isprivate, rows and reads holding address1_addressid and address2_addressid)
// Standard table semantics a plug-in sees on account writes: create defaults, catalogue labels, readable image columns
// and the platform's customer address ids. Invented rows and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { recordToSdkEntity } from '../lib/plugin-clr.mjs';
import { pipelineFormattedValues } from '../lib/plugin-formatted-values.mjs';

const step = (n, message, stage) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  enabled: true,
  entity: 'account',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.AccountRecorder',
  assemblyId: 'invented',
});

async function fixture(t) {
  const f = await contractModuleFixture(t, {
    mappings: {
      account: {
        logicalName: 'account',
        entitySet: 'accounts',
        idColumn: 'accountid',
        ownership: 'UserOwned',
        fields: { name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { account: [] },
    extension: { name: 'standard-table-probe', install: () => {} },
  });
  const seen = [];
  const steps = [10, 20, 40].map((stage, i) => step(i + 1, 'Create', stage));
  const handlers = new Map([
    [
      steps[0].typeName,
      ({ context }) => {
        seen.push({ stage: context.Stage, target: structuredClone(context.InputParameters.Target ?? null) });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen };
}

test('an account Create shows its choice and two-option defaults from PreValidation, its state from PreOperation', async (t) => {
  const f = await fixture(t);
  const created = await f.request('POST', '/accounts', { name: 'Invented account' });
  assert(created.status < 300, await created.text());
  const at = (stage) => f.seen.find((entry) => entry.stage === stage).target;
  for (const name of ['preferredcontactmethodcode', 'territorycode', 'customersizecode', 'donotemail', 'followemail'])
    assert(Object.hasOwn(at(10), name), `Create/10 Target carries ${name}`);
  assert.equal(at(10).preferredcontactmethodcode, 1);
  assert(!Object.hasOwn(at(10), 'statecode'));
  assert.equal(at(20).statecode, 0);
});

test('account values are labelled from the standard catalogue; an image omits the unreadable isprivate', async (t) => {
  const f = await fixture(t);
  const row = {
    accountid: '20000000-0000-0000-0000-0000000000d1',
    statecode: 0,
    statuscode: 1,
    territorycode: 1,
    preferredcontactmethodcode: 1,
    donotemail: false,
    donotsendmm: false,
    followemail: true,
    isprivate: false,
  };
  const target = recordToSdkEntity(f.store, 'account', row, { allColumns: true, target: true });
  assert.deepEqual(pipelineFormattedValues(f.store, 'account', target), {
    statecode: 'Active',
    statuscode: 'Active',
    territorycode: 'Default Value',
    preferredcontactmethodcode: 'Any',
    donotemail: 'Allow',
    donotsendmm: 'Send',
    followemail: 'Allow',
    isprivate: 'No',
  });
  const image = recordToSdkEntity(f.store, 'account', row, { allColumns: true, image: true });
  assert(!Object.hasOwn(image.attributes, 'isprivate'));
  assert(Object.hasOwn(target.attributes, 'isprivate'), 'a Target keeps isprivate');
});

test('an account Create stamps two customer address ids on the row, not on its Create Targets', async (t) => {
  const f = await fixture(t);
  const created = await f.request('POST', '/accounts', { name: 'Addressed account' });
  assert(created.status < 300, await created.text());
  const id = f.store.tableRows('account')[0].accountid;
  const read = await f.request('GET', `/accounts(${id})?$select=address1_addressid,address2_addressid`);
  assert.equal(read.status, 200, await read.clone().text());
  const body = await read.json();
  assert.match(body.address1_addressid, /^[0-9a-f-]{36}$/);
  assert.match(body.address2_addressid, /^[0-9a-f-]{36}$/);
  assert.notEqual(body.address1_addressid, body.address2_addressid);
  for (const entry of f.seen) assert(!Object.hasOwn(entry.target, 'address1_addressid'), `Create/${entry.stage}`);
  const addresses = f.store.tableRows('customeraddress');
  assert.deepEqual(
    addresses.map((address) => [address.addressnumber, address.customeraddressid, address.parentid.id]),
    [
      [1, body.address1_addressid, id],
      [2, body.address2_addressid, id],
    ],
  );
});
