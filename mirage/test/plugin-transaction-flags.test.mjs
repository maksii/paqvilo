// @test-kind parity: native recorder corpus customApi, customApiNested, webApiNamed, relationsReads, sdkMessages and batch (native and native-r2): IsInTransaction is false at a top-level PreValidation (custom API, SOAP Associate) and on the access reads, true from PreOperation on and inside a caller's transaction or a $batch changeset
// Invented tables, identities and messages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { install as installCustomApis } from '../lib/dataverse-customapi.mjs';

const row = '20000000-0000-4000-8000-0000000000f1',
  peer = '20000000-0000-4000-8000-0000000000f2',
  bound = '40000000-0000-4000-8000-0000000000f1',
  unbound = '40000000-0000-4000-8000-0000000000f2';
const step = (n, message, stage, extra = {}) => ({
  id: `30000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}`,
  enabled: true,
  entity: 'account',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
  ...extra,
});
const stages = (n, message, extra) => [10, 20, 40].map((stage, i) => step(n + i, message, stage, extra));
const api = (id, uniquename, bindingtype) => ({
  customapiid: id,
  uniquename,
  bindingtype,
  ...(bindingtype ? { boundentitylogicalname: 'account' } : {}),
  isfunction: false,
  allowedcustomprocessingsteptype: 2,
});

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    mappings: {
      account: {
        logicalName: 'account',
        entitySet: 'accounts',
        idColumn: 'accountid',
        ownership: 'UserOwned',
        fields: { name: { dataverseType: 'nvarchar' } },
        relationships: {
          x_account_peers: {
            entity: 'account',
            from: 'accountid',
            to: 'accountid',
            many: true,
            schemaName: 'x_account_peers',
            intersect: { entity: 'x_account_peers', from: 'accountidone', to: 'accountidtwo' },
          },
        },
      },
      x_account_peers: {
        logicalName: 'x_account_peers',
        entitySet: 'x_account_peersset',
        idColumn: 'x_account_peersid',
        fields: {
          accountidone: { dataverseType: 'lookup', targets: ['account'] },
          accountidtwo: { dataverseType: 'lookup', targets: ['account'] },
        },
      },
    },
    tables: {
      account: [
        { accountid: row, name: 'First' },
        { accountid: peer, name: 'Peer' },
      ],
      x_account_peers: [],
      customapi: [api(bound, 'x_Bound', 1), api(unbound, 'x_Unbound', 0)],
      customapirequestparameter: [],
      customapiresponseproperty: [],
    },
    extension: {
      name: 'customapi',
      install: (organization) =>
        installCustomApis(
          { ...organization, change: (fn) => fn() },
          {
            handlers: new Map([
              ['x_bound', { handler: () => ({}) }],
              ['x_unbound', { handler: () => ({}) }],
            ]),
          },
        ).ready,
    },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => void seen.push(`${context.MessageName}/${context.Stage}:${context.IsInTransaction}`),
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen };
}

test('a top-level custom API runs PreValidation outside its transaction and PreOperation/PostOperation inside', async (t) => {
  const f = await fixture(t, [
    ...stages(1, 'x_Bound', { customApi: { name: 'x_Bound', bindingType: 1, allowedCustomProcessingStepType: 2 } }),
    ...stages(4, 'x_Unbound', {
      entity: 'none',
      customApi: { name: 'x_Unbound', bindingType: 0, allowedCustomProcessingStepType: 2 },
    }),
  ]);
  const boundAnswer = await f.request('POST', `/accounts(${row})/Microsoft.Dynamics.CRM.x_Bound`, {});
  assert(boundAnswer.status < 300, await boundAnswer.text());
  const unboundAnswer = await f.request('POST', '/x_Unbound', {});
  assert(unboundAnswer.status < 300, await unboundAnswer.text());
  assert.deepEqual(f.seen, [
    'x_Bound/10:false',
    'x_Bound/20:true',
    'x_Bound/40:true',
    'x_Unbound/10:false',
    'x_Unbound/20:true',
    'x_Unbound/40:true',
  ]);
});

test('Web API access reads stay outside the transaction; sharing joins it from PreOperation on', async (t) => {
  const f = await fixture(t, [
    ...stages(10, 'GrantAccess'),
    ...stages(13, 'RetrievePrincipalAccess'),
    ...stages(16, 'RetrieveSharedPrincipalsAndAccess'),
  ]);
  const user = f.store.tableRows('systemuser').find((item) => item.fullname !== 'SYSTEM').systemuserid;
  const shared = await f.request('POST', '/GrantAccess', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: row },
    PrincipalAccess: {
      Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: user },
      AccessMask: 'ReadAccess',
    },
  });
  assert(shared.status < 300, await shared.text());
  const access = await f.request(
    'GET',
    `/systemusers(${user})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t={'@odata.id':'accounts(${row})'}`,
  );
  assert.equal(access.status, 200, await access.text());
  const sharing = await f.request(
    'GET',
    `/RetrieveSharedPrincipalsAndAccess(Target=@t)?@t={'@odata.id':'accounts(${row})'}`,
  );
  assert.equal(sharing.status, 200, await sharing.text());
  assert.deepEqual(f.seen, [
    'GrantAccess/10:false',
    'GrantAccess/20:true',
    'GrantAccess/40:true',
    'RetrievePrincipalAccess/10:false',
    'RetrievePrincipalAccess/20:false',
    'RetrievePrincipalAccess/40:false',
    'RetrieveSharedPrincipalsAndAccess/10:false',
    'RetrieveSharedPrincipalsAndAccess/20:false',
    'RetrieveSharedPrincipalsAndAccess/40:false',
  ]);
});

test('an access read a plug-in issues inside its transaction stays in it', async (t) => {
  const f = await fixture(t, stages(20, 'RetrievePrincipalAccess'));
  const caller = f.store.tableRows('systemuser').find((item) => item.applicationid).systemuserid;
  await f.store.transact(() =>
    f.store.withOperationContext(() => {
      f.store.pluginInTransaction = true;
      dispatchSdkCall({
        store: f.store,
        profile: {
          userId: caller,
          evidence: 'Invented in-transaction access read',
          grants: [{ entity: 'account', operations: ['read'] }],
        },
        message: {
          method: 'Execute',
          userId: caller,
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName: 'RetrievePrincipalAccess',
              parameters: {
                $type: 'ParameterCollection',
                values: {
                  Target: { $type: 'EntityReference', logicalName: 'account', id: row, name: null },
                  Principal: { $type: 'EntityReference', logicalName: 'systemuser', id: caller, name: null },
                },
              },
            },
          ],
        },
      });
    }),
  );
  assert.deepEqual(f.seen, [
    'RetrievePrincipalAccess/10:true',
    'RetrievePrincipalAccess/20:true',
    'RetrievePrincipalAccess/40:true',
  ]);
});

test('a SOAP Associate runs PreValidation outside its transaction', async (t) => {
  const f = await fixture(t, stages(30, 'Associate', { entity: null, unfiltered: true }));
  const caller = f.store.tableRows('systemuser').find((user) => user.applicationid);
  const reference = (id) =>
    `<a:EntityReference><a:Id>${id}</a:Id><a:LogicalName>account</a:LogicalName></a:EntityReference>`;
  const pair = (key, value) =>
    `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${value}</a:KeyValuePairOfstringanyType>`;
  const parameters =
    pair(
      'Target',
      `<b:value i:type="a:EntityReference"><a:Id>${row}</a:Id><a:LogicalName>account</a:LogicalName></b:value>`,
    ) +
    pair(
      'Relationship',
      '<b:value i:type="a:Relationship"><a:PrimaryEntityRole i:nil="true"/><a:SchemaName>x_account_peers</a:SchemaName></b:value>',
    ) +
    pair('RelatedEntities', `<b:value i:type="a:EntityReferenceCollection">${reference(peer)}</b:value>`);
  const answer = await handleSoap(
    {
      method: 'POST',
      headers: {},
      bodyText: `<s:Envelope ${Object.entries(NS)
        .map(([key, uri]) => `xmlns:${key}="${uri}"`)
        .join(
          ' ',
        )}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest"><a:Parameters>${parameters}</a:Parameters><a:RequestName>Associate</a:RequestName></request></Execute></s:Body></s:Envelope>`,
      user: caller,
      caller,
      identity: { admin: true, id: caller.systemuserid, systemUserId: caller.systemuserid },
      origin: f.server.origin,
      version: 'v9.2',
    },
    f.api,
  );
  assert.doesNotMatch(answer.body, /Fault/, answer.body);
  assert.deepEqual(f.seen, ['Associate/10:false', 'Associate/20:true', 'Associate/40:true']);
});

test('a $batch changeset member runs PreValidation inside the changeset transaction', async (t) => {
  const f = await fixture(t, stages(40, 'Create'));
  const answer = await f.request(
    'POST',
    '/$batch',
    {
      requests: [
        { id: '1', atomicityGroup: 'g', method: 'POST', url: 'accounts', body: { name: 'In changeset' } },
        { id: '2', method: 'POST', url: 'accounts', body: { name: 'Outside' } },
      ],
    },
    { accept: 'application/json' },
  );
  assert(answer.status < 300, await answer.text());
  assert.deepEqual(f.seen, [
    'Create/10:true',
    'Create/20:true',
    'Create/40:true',
    'Create/10:false',
    'Create/20:true',
    'Create/40:true',
  ]);
});
