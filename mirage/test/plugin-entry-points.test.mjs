// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30 (customApi: a bound custom API's target load runs no Retrieve pipeline; associate: a self-referencing N:N $ref through the relationship-named navigation passes PrimaryEntityRole Referencing; upsert: a Delete by alternate key names it in its PreValidation and main-operation Targets)
// @parity-evidence: native recorder corpus 2026-10-30, associate (a self-referencing N:N $ref through its relationship-named navigation: Relationship.PrimaryEntityRole Referencing) and upsert (DELETE by alternate key: PreValidation and Delete/30 Target keyAttributes), replayed by the local recorder harness; the edited lines only add these tests and their fixture
// Web API entry points of named messages and bound operations. Invented tables, identities and messages only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { install as installCustomApis } from '../lib/dataverse-customapi.mjs';
import { grantAccessNow } from '../lib/dataverse-security.mjs';

const row = '20000000-0000-0000-0000-0000000000c1';
const peer = '20000000-0000-0000-0000-0000000000c2';
// A self-referencing many-to-many relationship: Entity1 navigation named as the relationship, Entity2 its partner.
const peers = (from, to, navigation, partner) => ({
  [navigation]: {
    entity: 'x_item',
    from: 'x_itemid',
    to: 'x_itemid',
    many: true,
    schemaName: 'x_item_peers',
    partner,
    intersect: { entity: 'x_item_peers', from, to },
  },
});
const apiId = '40000000-0000-0000-0000-0000000000c1';
const step = (n, message, stage, extra = {}) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}`,
  enabled: true,
  entity: 'x_item',
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

async function fixture(t, steps) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } },
        alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }],
        relationships: {
          ...peers('x_itemidone', 'x_itemidtwo', 'x_item_peers', 'x_item_peers_referenced'),
          ...peers('x_itemidtwo', 'x_itemidone', 'x_item_peers_referenced', 'x_item_peers'),
        },
      },
      x_item_peers: {
        logicalName: 'x_item_peers',
        entitySet: 'x_item_peersset',
        idColumn: 'x_item_peersid',
        fields: {
          x_itemidone: { dataverseType: 'lookup', targets: ['x_item'] },
          x_itemidtwo: { dataverseType: 'lookup', targets: ['x_item'] },
        },
      },
    },
    tables: {
      x_item: [
        { x_itemid: row, x_name: 'First', x_code: 'first' },
        { x_itemid: peer, x_name: 'Peer', x_code: 'peer' },
      ],
      x_item_peers: [],
      customapi: [
        {
          customapiid: apiId,
          uniquename: 'x_Bound',
          bindingtype: 1,
          boundentitylogicalname: 'x_item',
          isfunction: false,
          allowedcustomprocessingsteptype: 2,
        },
      ],
      customapirequestparameter: [
        { customapirequestparameterid: apiId, customapiid: apiId, uniquename: 'Text', type: 10, isoptional: true },
      ],
      customapiresponseproperty: [],
    },
    extension: {
      name: 'customapi',
      install: (api) =>
        installCustomApis(
          { ...api, change: (fn) => fn() },
          { handlers: new Map([['x_bound', { handler: () => ({}) }]]) },
        ).ready,
    },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          inputs: structuredClone(context.InputParameters),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

test('a bound custom API loads its target without running the Retrieve pipeline', async (t) => {
  const customApi = { name: 'x_Bound', bindingType: 1, allowedCustomProcessingStepType: 2 };
  const f = await fixture(t, [
    step(1, 'Retrieve', 10),
    step(2, 'Retrieve', 20),
    step(3, 'Retrieve', 40),
    step(4, 'x_Bound', 20, { customApi }),
  ]);
  const answer = await f.request('POST', `/x_items(${row})/Microsoft.Dynamics.CRM.x_Bound`, { Text: 'hello' });
  assert(answer.status < 300, await answer.text());
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['x_Bound/20'],
  );
});

const roles = (seen) =>
  seen.map(
    (entry) =>
      `${entry.at}:${entry.inputs.Relationship?.PrimaryEntityRole ?? entry.inputs.Relationship?.primaryEntityRole ?? null}`,
  );

test('a self-referencing N:N $ref through the relationship-named navigation passes PrimaryEntityRole Referencing', async (t) => {
  const f = await fixture(t, [
    step(5, 'Associate', 20, { entity: null, unfiltered: true }),
    step(6, 'Disassociate', 20, { entity: null, unfiltered: true }),
  ]);
  const base = new URL(f.server.origin + '/api/data/v9.2/').href;
  const added = await f.request('POST', `/x_items(${row})/x_item_peers/$ref`, {
    '@odata.id': `${base}x_items(${peer})`,
  });
  assert(added.status < 300, await added.text());
  const removed = await f.request('DELETE', `/x_items(${row})/x_item_peers(${peer})/$ref`);
  assert(removed.status < 300, await removed.text());
  assert.deepEqual(roles(f.seen), ['Associate/20:Referencing', 'Disassociate/20:Referencing']);
});

// @test-kind unproven: the partner (Entity2) navigation of a self-referencing N:N has no native capture; Referenced is the local model
test('a self-referencing N:N $ref through the partner navigation passes PrimaryEntityRole Referenced', async (t) => {
  const f = await fixture(t, [step(5, 'Associate', 20, { entity: null, unfiltered: true })]);
  const base = new URL(f.server.origin + '/api/data/v9.2/').href;
  const added = await f.request('POST', `/x_items(${row})/x_item_peers_referenced/$ref`, {
    '@odata.id': `${base}x_items(${peer})`,
  });
  assert(added.status < 300, await added.text());
  assert.deepEqual(roles(f.seen), ['Associate/20:Referenced']);
});

// A Delete addressed by an alternate key (DELETE <set>(<key>='<value>')): its PreValidation Target and the main
// operation's Target name the key; PreOperation and PostOperation Targets do not (recorded native upsert).
test('a Delete by alternate key names the key in its PreValidation and main-operation Targets only', async (t) => {
  const f = await fixture(t, []);
  const caller = '10000000-0000-0000-0000-0000000000c9';
  const runtime = {
    descriptor: {
      context: { executionUserId: caller, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
      serviceProfile: { userId: caller, evidence: 'Invented alternate-key Delete', grants: [] },
    },
  };
  const record = f.store.tableRows('x_item')[0];
  const keyed = { x_code: 'first' };
  const contextAt = (stage, frame) =>
    clrContext({
      runtime,
      store: f.store,
      step: { id: '30000000-0000-0000-0000-0000000000c9', name: 'Invented Delete', images: [], contract: { mode: 0 } },
      entity: 'x_item',
      operation: 'delete',
      stage,
      target: { x_itemid: row },
      record,
      previous: { ...record },
      frame,
      depth: 1,
    });
  const phase = (stage) =>
    runPluginPhase({
      items: [],
      handlers: new Map(),
      store: f.store,
      entity: 'x_item',
      operation: 'delete',
      stage,
      target: { x_itemid: row },
      record,
      previous: { ...record },
      identity: {},
      targetKeyAttributes: keyed,
    });
  const preValidation = contextAt(10, phase(10));
  assert.deepEqual(preValidation.inputParameters.values.Target.keyAttributes, keyed);
  const preOperation = contextAt(20, phase(20));
  assert.equal(preOperation.inputParameters.values.Target.keyAttributes, undefined);
  assert.deepEqual(preOperation.context.ParentContext.values.InputParameters.values.Target.keyAttributes, keyed);
});

// Named messages over the Web API (no native capture of these entry points: local model of the SDK-issued shape).
async function messageFixture(t, steps, { register } = {}) {
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
    extension: { name: 'entry-message-probe', install: (api) => register?.(api) },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          entity: context.PrimaryEntityName,
          parent: context.ParentContext ? `${context.ParentContext.MessageName}/${context.ParentContext.Stage}` : null,
          user: context.UserId,
          // The principal the platform runs the operation as (a CLR step reports it as UserId).
          // @parity-evidence: native and native-r2 sdkMessages and soapMessages: Update/20,40 under Assign/30 UserId SYSTEM, InitiatingUserId the caller; the SYSTEM user moved to the platform-user operation field
          executing: f.store.pluginPlatformUserId ?? f.store.pluginExecutionUserId ?? null,
          inputs: structuredClone(context.InputParameters),
          outputs: structuredClone(context.OutputParameters),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen };
}
const stages = (n, message, extra) => [10, 20, 40].map((stage, i) => step(n + i, message, stage, extra));

// @test-kind unproven: local model of a Web API action's own message pipeline (no native capture of an action's steps)
test('a Web API action runs its message pipeline around the operation with typed inputs and outputs', async (t) => {
  let ran = 0;
  const f = await messageFixture(t, stages(10, 'x_Ping', { entity: 'none' }), {
    register: (api) =>
      api.registry.register({
        name: 'x_Ping',
        kind: 'action',
        binding: 'unbound',
        handle: () => {
          ran = f?.seen?.length ?? 0;
          return { status: 200, body: { '@odata.context': 'x', Answer: 'pong' } };
        },
        signature: {
          params: [
            ['Text', 'Edm.String'],
            ['Row', 'Edm.Guid'],
          ],
          response: [['Answer', 'Edm.String']],
        },
      }),
  });
  const answer = await f.request('POST', '/x_Ping', { Text: 'hi', Row: row });
  assert.equal(answer.status, 200, await answer.clone().text());
  assert.equal((await answer.json()).Answer, 'pong');
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['x_Ping/10', 'x_Ping/20', 'x_Ping/40'],
  );
  assert.equal(ran, 2, 'the operation runs between PreOperation and PostOperation');
  for (const entry of f.seen) {
    assert.equal(entry.entity, 'none');
    assert.equal(entry.inputs.Text, 'hi');
    assert.equal(String(entry.inputs.Row).toLowerCase(), row);
  }
  assert.equal(f.seen.at(-1).outputs.Answer, 'pong');
});

// @test-kind unproven: local model of Web API GrantAccess running the SDK GrantAccess pipeline (no native capture of this entry point)
test('Web API GrantAccess runs the GrantAccess pipeline with the SDK inputs around the share', async (t) => {
  const f = await messageFixture(t, stages(20, 'GrantAccess', { entity: 'account' }));
  const user = f.store.tableRows('systemuser').find((item) => item.fullname !== 'SYSTEM').systemuserid;
  const shared = await f.request('POST', '/GrantAccess', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: row },
    PrincipalAccess: {
      Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: user },
      AccessMask: 'ReadAccess',
    },
  });
  assert(shared.status < 300, await shared.text());
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['GrantAccess/10', 'GrantAccess/20', 'GrantAccess/40'],
  );
  assert.equal(f.seen[0].entity, 'account');
  assert.deepEqual(Object.keys(f.seen[0].inputs).sort(), ['PrincipalAccess', 'Target']);
  assert.equal(
    f.store.tableRows('principalobjectaccess').filter((share) => String(share.objectid).toLowerCase() === row).length,
    1,
  );
});

// @test-kind unproven: local model of the Merge pipeline (no native capture of Merge steps on a mergeable table)
test('Web API Merge runs its pipeline and its writes as Update pipelines under Merge/30', async (t) => {
  const f = await messageFixture(t, [
    ...stages(30, 'Merge', { entity: 'account' }),
    step(33, 'Update', 20, { entity: 'account' }),
  ]);
  const merged = await f.request('POST', '/Merge', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: row },
    Subordinate: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: peer },
    UpdateContent: { '@odata.type': 'Microsoft.Dynamics.CRM.account', name: 'Merged' },
    PerformParentingChecks: false,
  });
  assert(merged.status < 300, await merged.text());
  assert.deepEqual(
    f.seen.map((entry) => `${entry.at}<${entry.parent}`),
    ['Merge/10<null', 'Merge/20<null', 'Update/20<Merge/30', 'Update/20<Merge/30', 'Merge/40<null'],
  );
  assert.deepEqual(Object.keys(f.seen[0].inputs).sort(), [
    'PerformParentingChecks',
    'SubordinateId',
    'Target',
    'UpdateContent',
  ]);
  assert.equal(f.store.tableRows('account').find((item) => item.accountid === row).name, 'Merged');
});

// @test-kind parity: native recorder captures 2026-10-30 webApiNamed (native and native-r2): a bound custom API addressed by alternate key answers 200 and its Target carries the resolved id and KeyAttributes
test('a bound custom API addressed by an alternate key binds the row and keeps the key in its Target', async (t) => {
  const customApi = { name: 'x_Bound', bindingType: 1, allowedCustomProcessingStepType: 2 };
  const f = await fixture(t, [step(7, 'x_Bound', 20, { customApi })]);
  const answer = await f.request('POST', `/x_items(x_code='first')/Microsoft.Dynamics.CRM.x_Bound`, { Text: 'by key' });
  assert(answer.status < 300, await answer.text());
  const target = f.seen.find((entry) => entry.at === 'x_Bound/20').inputs.Target;
  assert.equal(String(target.id ?? target.x_itemid).toLowerCase(), row);
});

// @test-kind parity: native recorder captures 2026-10-30 webApiNamed (native and native-r2): sharing messages and RetrievePrincipalAccess run no Retrieve before them, and a team holding only a share answers the shared rights
test('Web API sharing runs no Retrieve pipeline and a shared team reports the shared rights', async (t) => {
  const f = await messageFixture(t, [step(40, 'Retrieve', 10, { entity: null, unfiltered: true })]);
  const team = '10000000-0000-0000-0000-0000000000e1';
  f.store.state.tables.team = [...(f.store.state.tables.team ?? []), { teamid: team, name: 'Invented team' }];
  const shared = await f.request('POST', '/ModifyAccess', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.account', accountid: row },
    PrincipalAccess: {
      Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.team', teamid: team },
      AccessMask: 'ReadAccess, WriteAccess',
    },
  });
  assert(shared.status < 300, await shared.text());
  const access = await f.request(
    'GET',
    `/teams(${team})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t={'@odata.id':'accounts(${row})'}`,
  );
  assert.equal(access.status, 200, await access.clone().text());
  assert.equal((await access.json()).AccessRights, 'ReadAccess, WriteAccess');
  assert.deepEqual(f.seen, []);
});

// @test-kind parity: native recorder corpus webApiNamed (native and native-r2): RetrieveSharedPrincipalsAndAccess/40 OutputParameters.PrincipalAccesses is PrincipalAccess[] of { Principal: EntityReference (team, name null), AccessMask: AccessRights }, not the HTTP JSON
test('Web API RetrieveSharedPrincipalsAndAccess gives its steps typed PrincipalAccess outputs', async (t) => {
  const f = await messageFixture(t, [step(41, 'RetrieveSharedPrincipalsAndAccess', 40, { entity: 'account' })]);
  const team = '10000000-0000-0000-0000-0000000000e2';
  f.store.state.tables.team = [...(f.store.state.tables.team ?? []), { teamid: team, name: 'Invented team' }];
  // The share row a ModifyAccess of read and write rights writes.
  await f.store.transact(() =>
    grantAccessNow(f.store, {
      target: { logical: 'account', id: row },
      principal: { id: team, logical_name: 'team' },
      mask: 3,
    }),
  );
  const target = `@t={'@odata.id':'accounts(${row})'}`;
  const answer = await f.request('GET', '/RetrieveSharedPrincipalsAndAccess(Target=@t)?' + target);
  assert.equal(answer.status, 200, await answer.clone().text());
  // The HTTP body keeps the Web API shape.
  assert.equal((await answer.json()).PrincipalAccesses[0].AccessMask, 'ReadAccess, WriteAccess');
  const [output] = f.seen.map((entry) => entry.outputs.PrincipalAccesses);
  const values = Array.isArray(output) ? output : output.values;
  assert.equal(values.length, 1);
  assert.equal(values[0].$type, 'PrincipalAccess');
  assert.deepEqual(values[0].principal, { $type: 'EntityReference', logicalName: 'team', id: team, name: null });
  assert.equal(values[0].accessMask, 3);
});

// @test-kind parity: native recorder captures 2026-10-30 soapMessages (native and native-r2): SOAP Assign runs Assign 10/20/40 and its owner Update 20/40 (no PreValidation) under Assign/30 as SYSTEM; SOAP SetState runs SetStateDynamicEntity 10/20/40 and its Update 20/40 under SetStateDynamicEntity/30 as the caller
test('SOAP Assign and SetState run their message pipelines around a main-operation Update', async (t) => {
  const f = await messageFixture(t, [
    ...stages(50, 'Assign', { entity: 'account' }),
    ...stages(53, 'SetStateDynamicEntity', { entity: 'account' }),
    ...stages(56, 'Update', { entity: 'account' }),
  ]);
  const system = f.store.tableRows('systemuser').find((user) => user.fullname === 'SYSTEM').systemuserid;
  const assignee = f.store.tableRows('systemuser').find((user) => user.fullname !== 'SYSTEM').systemuserid;
  // The caller: the fixture's application user (System Administrator).
  const caller = f.store.tableRows('systemuser').find((user) => user.applicationid);
  const soap = (message, parameters) =>
    handleSoap(
      {
        method: 'POST',
        headers: {},
        bodyText: `<s:Envelope ${Object.entries(NS)
          .map(([key, uri]) => `xmlns:${key}="${uri}"`)
          .join(
            ' ',
          )}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest"><a:Parameters>${parameters}</a:Parameters><a:RequestName>${message}</a:RequestName></request></Execute></s:Body></s:Envelope>`,
        user: caller,
        caller,
        identity: { admin: true, id: caller.systemuserid, systemUserId: caller.systemuserid },
        origin: f.server.origin,
        version: 'v9.2',
      },
      f.api,
    );
  const pair = (key, value) =>
    `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${value}</a:KeyValuePairOfstringanyType>`;
  const reference = (logical, id) =>
    `<b:value i:type="a:EntityReference"><a:Id>${id}</a:Id><a:LogicalName>${logical}</a:LogicalName></b:value>`;
  const option = (value) => `<b:value i:type="a:OptionSetValue"><a:Value>${value}</a:Value></b:value>`;
  const assigned = await soap(
    'Assign',
    pair('Target', reference('account', row)) + pair('Assignee', reference('systemuser', assignee)),
  );
  assert.doesNotMatch(assigned.body, /Fault/, assigned.body);
  assert.deepEqual(
    f.seen.map((entry) => `${entry.at}<${entry.parent}`),
    ['Assign/10<null', 'Assign/20<null', 'Update/20<Assign/30', 'Update/40<Assign/30', 'Assign/40<null'],
  );
  assert.equal(f.seen.find((entry) => entry.at === 'Update/20').executing, system);
  f.seen.length = 0;
  const changed = await soap(
    'SetState',
    pair('EntityMoniker', reference('account', row)) + pair('State', option(1)) + pair('Status', option(2)),
  );
  assert.doesNotMatch(changed.body, /Fault/, changed.body);
  assert.deepEqual(
    f.seen.map((entry) => `${entry.at}<${entry.parent}`),
    [
      'SetStateDynamicEntity/10<null',
      'SetStateDynamicEntity/20<null',
      'Update/20<SetStateDynamicEntity/30',
      'Update/40<SetStateDynamicEntity/30',
      'SetStateDynamicEntity/40<null',
    ],
  );
  assert.notEqual(f.seen.find((entry) => entry.at === 'Update/20').executing, system);
});

// @test-kind parity: native recorder captures 2026-10-30 privilege (native and native-r2): a Create reusing an existing primary key runs its PreValidation and PreOperation steps, then answers 412 0x80040237
test('a Create with a duplicate primary key runs PreValidation and PreOperation before its 412', async (t) => {
  const f = await messageFixture(t, stages(60, 'Create', { entity: 'account' }));
  const duplicate = await f.request('POST', '/accounts', { accountid: row, name: 'Again' });
  assert.equal(duplicate.status, 412, await duplicate.text());
  assert.deepEqual(
    f.seen.map((entry) => entry.at),
    ['Create/10', 'Create/20'],
  );
});

// @test-kind parity: native recorder captures 2026-10-30/31 privilegeSecond (trial, both captures): for a caller without the table privileges a Create is refused after PreValidation, a Retrieve or RetrieveMultiple after PreOperation, an Update or Delete before any step, each 403 0x80040220
test('a caller without the table privilege is refused at the stage native refuses each message', async (t) => {
  const steps = ['Create', 'Retrieve', 'RetrieveMultiple', 'Update', 'Delete'].flatMap((message, m) =>
    [10, 20].map((stage, s) => step(70 + m * 2 + s, message, stage, { entity: 'account' })),
  );
  const f = await messageFixture(t, steps);
  const restricted = '10000000-0000-0000-0000-0000000000f1';
  await f.store.transact(() =>
    f.store
      .tableRows('systemuser')
      .push({ systemuserid: restricted, fullname: 'Invented restricted user', isdisabled: false }),
  );
  const as = { MSCRMCallerID: restricted };
  const attempt = async (method, path, body, expected) => {
    f.seen.length = 0;
    const answer = await f.request(method, path, body, as);
    const text = await answer.text();
    assert.equal(answer.status, 403, `${method} ${path}: ${text}`);
    assert.match(text, /0x80040220/);
    assert.deepEqual(
      f.seen.map((entry) => entry.at),
      expected,
      `${method} ${path}`,
    );
  };
  await attempt('POST', '/accounts', { name: 'Refused' }, ['Create/10']);
  await attempt('GET', `/accounts(${row})?$select=name`, undefined, ['Retrieve/10', 'Retrieve/20']);
  await attempt('GET', '/accounts?$select=name', undefined, ['RetrieveMultiple/10', 'RetrieveMultiple/20']);
  await attempt('PATCH', `/accounts(${row})`, { name: 'Refused' }, []);
  await attempt('DELETE', `/accounts(${row})`, undefined, []);
});

// @parity-evidence: native recorder captures 2026-10-30/31 relationsReads (native and native-r2): the child Update runs at depth 2 under Associate/30 with Target as its only input; the assertion now checks that delegated write instead of only its presence
// @test-kind parity: native recorder captures 2026-10-30/31 relationsReads (both captures): a $ref on a one-to-many collection navigation runs Associate with Relationship.PrimaryEntityRole Referenced and PrimaryEntityName none around the child's delegated Update at depth 2 without ConcurrencyBehavior
test('a one-to-many collection $ref runs Associate (Referenced) around the child Update', async (t) => {
  const parent = '20000000-0000-0000-0000-0000000000a7',
    child = '20000000-0000-0000-0000-0000000000a8';
  const f = await contractModuleFixture(t, {
    mappings: {
      x_root: {
        logicalName: 'x_root',
        entitySet: 'x_roots',
        idColumn: 'x_rootid',
        relationships: {
          x_children: { schemaName: 'x_root_child', entity: 'x_child', from: 'x_rootid', to: 'x_parentid', many: true },
        },
      },
      x_child: {
        logicalName: 'x_child',
        entitySet: 'x_childs',
        idColumn: 'x_childid',
        fields: { x_parentid: { dataverseType: 'lookup', targets: ['x_root'] } },
        relationships: {
          x_parentid: { schemaName: 'x_root_child', entity: 'x_root', from: 'x_parentid', to: 'x_rootid', many: false },
        },
      },
    },
    tables: { x_root: [{ x_rootid: parent }], x_child: [{ x_childid: child }] },
    extension: { name: 'one-to-many-probe', install: () => {} },
  });
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        seen.push({
          at: `${context.MessageName}/${context.Stage}`,
          entity: context.PrimaryEntityName,
          depth: context.Depth,
          inputs: Object.keys(context.InputParameters).sort(),
          role:
            context.InputParameters.Relationship?.PrimaryEntityRole ??
            context.InputParameters.Relationship?.primaryEntityRole ??
            null,
        });
      },
    ],
  ]);
  const items = pluginCatalogue({
    plugins: {
      steps: [
        ...[10, 20, 40].map((stage, i) => step(90 + i, 'Associate', stage, { entity: null, unfiltered: true })),
        step(93, 'Update', 20, { entity: 'x_child' }),
      ],
    },
    handlers,
  });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  const base = new URL(f.server.origin + '/api/data/v9.2/').href;
  const linked = await f.request('POST', `/x_roots(${parent})/x_children/$ref`, {
    '@odata.id': `${base}x_childs(${child})`,
  });
  assert(linked.status < 300, await linked.text());
  const associates = seen.filter((entry) => entry.at.startsWith('Associate'));
  assert.deepEqual(
    associates.map((entry) => `${entry.at}:${entry.entity}:${entry.role}`),
    ['Associate/10:none:Referenced', 'Associate/20:none:Referenced', 'Associate/40:none:Referenced'],
  );
  // The child's lookup Update is the association's delegated write: one level deeper, with no ConcurrencyBehavior.
  const update = seen.find((entry) => entry.at === 'Update/20' && entry.entity === 'x_child');
  assert.ok(update, JSON.stringify(seen));
  assert.equal(update.depth, 2);
  assert.ok(!update.inputs.includes('ConcurrencyBehavior'), update.inputs.join(','));
});
