// @test-kind parity: native recorder corpus webApiNamed, soapMessages and mergeAccount (native and native-r2): a named message no plug-in issued owns the request's changes in its PostOperation SharedVariables (sync and asynchronous): sharing lists principalobjectaccess then the table with POADistributionChanged 10760, Merge principalobjectaccess and the table with 1; PreValidation, PreOperation and access reads list none
// Invented tables, identities and messages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';

const row = '20000000-0000-4000-8000-0000000000e1',
  peer = '20000000-0000-4000-8000-0000000000e2';
const step = (n, message, stage, mode = 0) => ({
  id: `30000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}`,
  enabled: true,
  entity: 'account',
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
});
const stages = (n, message) => [
  step(n, message, 10),
  step(n + 1, message, 20),
  step(n + 2, message, 40),
  step(n + 3, message, 40, 1),
];

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    mappings: {
      account: {
        logicalName: 'account',
        entitySet: 'accounts',
        idColumn: 'accountid',
        ownership: 'UserOwned',
        fields: { name: { dataverseType: 'nvarchar' }, statecode: { dataverseType: 'state' } },
      },
    },
    tables: {
      account: [
        { accountid: row, name: 'Kept' },
        { accountid: peer, name: 'Merged away' },
      ],
    },
    extension: { name: 'request-root-probe', install: () => {} },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        const shared = context.SharedVariables ?? {};
        seen.push(
          `${context.MessageName}/${context.Stage}/${context.Mode}` +
            (shared.ChangedEntityTypes ? ':' + Object.keys(shared.ChangedEntityTypes).join(',') : '') +
            (shared.POADistributionChanged === undefined ? '' : ':P' + shared.POADistributionChanged),
        );
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

test('a Web API sharing message lists principalobjectaccess, the table and POADistributionChanged at PostOperation', async (t) => {
  const f = await fixture(t, [...stages(1, 'GrantAccess'), ...stages(5, 'RetrievePrincipalAccess')]);
  const user = f.store.tableRows('systemuser').find((item) => item.fullname !== 'SYSTEM').systemuserid;
  const shared = await f.request('POST', '/GrantAccess', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: row },
    PrincipalAccess: {
      Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: user },
      AccessMask: 'ReadAccess',
    },
  });
  assert(shared.status < 300, await shared.text());
  await f.backend.settle();
  const access = await f.request(
    'GET',
    `/systemusers(${user})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t={'@odata.id':'accounts(${row})'}`,
  );
  assert.equal(access.status, 200, await access.text());
  await f.backend.settle();
  assert.deepEqual(f.seen, [
    'GrantAccess/10/0',
    'GrantAccess/20/0',
    'GrantAccess/40/0:principalobjectaccess,account:P10760',
    'GrantAccess/40/1:principalobjectaccess,account:P10760',
    'RetrievePrincipalAccess/10/0',
    'RetrievePrincipalAccess/20/0',
    'RetrievePrincipalAccess/40/0',
    'RetrievePrincipalAccess/40/1',
  ]);
});

test('a SOAP Assign lists its owner Update table at PostOperation', async (t) => {
  const f = await fixture(t, stages(10, 'Assign'));
  const assignee = f.store.tableRows('systemuser').find((user) => user.fullname !== 'SYSTEM').systemuserid;
  const caller = f.store.tableRows('systemuser').find((user) => user.applicationid);
  const pair = (key, value) =>
    `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${value}</a:KeyValuePairOfstringanyType>`;
  const reference = (logical, id) =>
    `<b:value i:type="a:EntityReference"><a:Id>${id}</a:Id><a:LogicalName>${logical}</a:LogicalName></b:value>`;
  const parameters = pair('Target', reference('account', row)) + pair('Assignee', reference('systemuser', assignee));
  const answer = await handleSoap(
    {
      method: 'POST',
      headers: {},
      bodyText: `<s:Envelope ${Object.entries(NS)
        .map(([key, uri]) => `xmlns:${key}="${uri}"`)
        .join(
          ' ',
        )}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest"><a:Parameters>${parameters}</a:Parameters><a:RequestName>Assign</a:RequestName></request></Execute></s:Body></s:Envelope>`,
      user: caller,
      caller,
      identity: { admin: true, id: caller.systemuserid, systemUserId: caller.systemuserid },
      origin: f.server.origin,
      version: 'v9.2',
    },
    f.api,
  );
  assert.doesNotMatch(answer.body, /Fault/, answer.body);
  await f.backend.settle();
  assert.deepEqual(f.seen, ['Assign/10/0', 'Assign/20/0', 'Assign/40/0:account', 'Assign/40/1:account']);
});

test('a Web API Merge lists principalobjectaccess and the table with POADistributionChanged 1', async (t) => {
  const f = await fixture(t, stages(20, 'Merge'));
  const merged = await f.request('POST', '/Merge', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: row },
    Subordinate: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: peer },
    UpdateContent: { '@odata.type': 'Microsoft.Dynamics.CRM.account', name: 'Merged' },
    PerformParentingChecks: false,
  });
  assert(merged.status < 300, await merged.text());
  await f.backend.settle();
  assert.deepEqual(f.seen, [
    'Merge/10/0',
    'Merge/20/0',
    'Merge/40/0:principalobjectaccess,account:P1',
    'Merge/40/1:principalobjectaccess,account:P1',
  ]);
});
