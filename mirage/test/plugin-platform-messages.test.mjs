// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30 (sdkMessages, sdkMerge, ownerAndState, bulk and associate scenarios), reproduced by the local recorder replay
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { clrContext, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { assertPluginMessageAdmission, pluginMessageHasPipeline } from '../lib/plugin-message-admission.mjs';
import { pluginStepMatchesEntity, pluginUnsupported, runPluginPhase } from '../lib/exported-plugins.mjs';

// Invented organization: one widget row, a second user, a team and the SYSTEM user.
const caller = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002',
  system = '10000000-0000-4000-8000-000000000003',
  team = '10000000-0000-4000-8000-000000000004',
  id = '20000000-0000-4000-8000-000000000001';
const profile = {
  userId: caller,
  evidence: 'Invented platform message proof',
  grants: [{ entity: 'widget', operations: ['read', 'update'] }],
};
const storeOf = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid', fields: { title: { type: 'string' } } },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
        team: { entitySet: 'teams', idColumn: 'teamid' },
      },
      tables: {
        widget: [{ widgetid: id, title: 'Before', statecode: 0, statuscode: 1 }],
        systemuser: [
          { systemuserid: caller, fullname: 'Invented caller' },
          { systemuserid: other, fullname: 'Invented assignee' },
          { systemuserid: system, fullname: 'SYSTEM' },
        ],
        team: [{ teamid: team, name: 'Invented team' }],
        principalobjectaccess: [],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const ref = (logicalName, value) => ({ $type: 'EntityReference', logicalName, id: value, name: null });
const request = (requestName, values) => ({
  $type: 'OrganizationRequest',
  requestName,
  parameters: { $type: 'ParameterCollection', values },
});
const execute = (store, requestName, values) =>
  dispatchSdkCall({
    store,
    profile,
    sdkFromSandbox: true,
    message: { method: 'Execute', userId: caller, arguments: [request(requestName, values)] },
  });
// A pipeline that records every phase: message, stage, inputs and what the operation runs under.
function recording(store, messages) {
  const seen = [];
  store.setPluginPipeline(
    (context) => {
      const main = store.pluginMainOperation?.context?.values;
      seen.push({
        message: context.customApi?.name ?? context.operation,
        stage: context.stage,
        inputs: Object.keys(context.messageParameters?.inputParameters?.values ?? {}),
        outputs: structuredClone(context.messageParameters?.outputParameters?.values ?? {}),
        concurrencyBehavior: context.concurrencyBehavior,
        under: main ? `${main.MessageName}/${main.Stage}/d${main.Depth}` : null,
        // @parity-evidence: native and native-r2 sdkMessages and soapMessages: Update/20,40 under Assign/30 UserId SYSTEM, InitiatingUserId the caller; the SYSTEM user moved to the platform-user operation field
        executionUser: store.pluginPlatformUserId ?? store.pluginExecutionUserId,
      });
    },
    (context) => messages.includes(context.operation),
  );
  return seen;
}
const order = (seen) => seen.map((entry) => `${entry.message}/${entry.stage}`);

test('SDK Assign runs its own pipeline around an owner Update that has no PreValidation or ConcurrencyBehavior', () => {
  const store = storeOf(),
    seen = recording(store, ['assign', 'update', 'setstatedynamicentity']);
  const response = execute(store, 'Assign', { Target: ref('widget', id), Assignee: ref('systemuser', other) });
  assert.deepEqual(response, { $type: 'OrganizationResponse', responseName: 'Assign', custom: true, results: {} });
  // Recorded native order: Assign 10, 20, its Update 20 and 40 (no Update 10), Assign 40.
  assert.deepEqual(order(seen), ['Assign/10', 'Assign/20', 'update/20', 'update/40', 'Assign/40']);
  assert.deepEqual(seen[0].inputs, ['Target', 'Assignee', 'FromSandbox']);
  const inner = seen.filter((entry) => entry.message === 'update');
  assert.ok(inner.every((entry) => entry.concurrencyBehavior === null && entry.under === 'Assign/30/d1'));
  // The main operation's Update runs as the organization's SYSTEM user.
  assert.ok(inner.every((entry) => entry.executionUser === system));
  assert.equal(store.pluginMainOperation ?? null, null);
  assert.equal(store.tableRows('widget')[0].ownerid.id, other);
});

// Invented application caller: the application id and Azure AD object id of the caller's row, and the organization.
const callerApp = '30000000-0000-4000-8000-000000000001',
  callerObject = '50000000-0000-4000-8000-000000000001',
  org = '60000000-0000-4000-8000-000000000001',
  unit = '60000000-0000-4000-8000-000000000002',
  empty = '00000000-0000-0000-0000-000000000000';
// An application user as the caller: its row carries the application id and its Azure AD object id.
const applicationCallerStore = () => {
  const store = storeOf(),
    row = store.tableRows('systemuser').find((user) => user.systemuserid === caller);
  Object.assign(row, { applicationid: callerApp, azureactivedirectoryobjectid: callerObject });
  return store;
};
// The CLR context of each Update phase, built the way a CLR step's entry builds it (plugin-clr.mjs clrContext).
function updateContexts(store) {
  const byStage = new Map();
  store.setPluginPipeline(
    (phase) => {
      const frame = runPluginPhase({ ...phase, store, items: [], handlers: new Map() });
      frame.callerIdentity ??= phase.identity;
      const { context } = clrContext({
        runtime: ownerRuntime,
        store,
        step: { id: 'invented-owner-update', images: [], contract: { mode: 0 } },
        entity: phase.entity,
        operation: phase.operation,
        stage: phase.stage,
        target: phase.target,
        record: phase.record,
        previous: phase.previous,
        frame,
        depth: 1,
      });
      byStage.set(phase.stage, context);
    },
    (context) => context.operation === 'update',
  );
  return byStage;
}
const ownerRuntime = {
  descriptor: {
    context: { executionUserId: caller, initiatingUserId: caller, organizationId: org, businessUnitId: unit },
    serviceProfile: { userId: caller, evidence: 'Invented owner Update probe', grants: [] },
  },
};

// @test-kind parity: native recorder corpus sdkMessages and soapMessages (native and native-r2): Assign's owner Update/20,40 run as SYSTEM (UserId) while InitiatingUserId and AuthenticatedUserId stay the caller, IsApplicationUser and InitiatingUserApplicationId follow the caller application
test('the owner Update of an SDK Assign runs as SYSTEM while an application caller still initiates it', () => {
  const store = applicationCallerStore(),
    byStage = updateContexts(store);
  const response = execute(store, 'Assign', { Target: ref('widget', id), Assignee: ref('systemuser', other) });
  assert.equal(response.responseName, 'Assign');
  for (const stage of [20, 40]) {
    const context = byStage.get(stage);
    assert.equal(context.UserId.value, system);
    assert.equal(context.InitiatingUserId.value, caller);
    assert.equal(context.AuthenticatedUserId.value, caller);
    assert.equal(context.IsApplicationUser, true);
    assert.equal(context.InitiatingUserApplicationId.value, callerApp);
    assert.equal(context.UserAzureActiveDirectoryObjectId.value, empty);
    assert.equal(context.InitiatingUserAzureActiveDirectoryObjectId.value, callerObject);
    assert.equal(context.ParentContext.values.UserId.value, system);
    assert.equal(context.ParentContext.values.InitiatingUserId.value, caller);
  }
  // A SetState's delegated Update runs entirely as the caller.
  byStage.clear();
  execute(store, 'SetState', {
    EntityMoniker: ref('widget', id),
    State: { $type: 'OptionSetValue', value: 1 },
    Status: { $type: 'OptionSetValue', value: 2 },
  });
  assert.equal(byStage.get(20).UserId.value, caller);
  assert.equal(byStage.get(20).InitiatingUserId.value, caller);
});

test('SDK SetState runs as SetStateDynamicEntity with IsValid and no nested state message', () => {
  const store = storeOf(),
    seen = recording(store, ['setstate', 'setstatedynamicentity', 'update']);
  const response = execute(store, 'SetState', {
    EntityMoniker: ref('widget', id),
    State: { $type: 'OptionSetValue', value: 1 },
    Status: { $type: 'OptionSetValue', value: 2 },
  });
  assert.deepEqual(response.results, {});
  assert.equal(response.responseName, 'SetState');
  assert.deepEqual(order(seen), [
    'SetStateDynamicEntity/10',
    'SetStateDynamicEntity/20',
    'update/20',
    'update/40',
    'SetStateDynamicEntity/40',
  ]);
  assert.deepEqual(seen.at(-1).outputs, { IsValid: true });
  assert.deepEqual(seen[0].inputs, ['EntityMoniker', 'State', 'Status', 'FromSandbox']);
  assert.deepEqual([store.tableRows('widget')[0].statecode, store.tableRows('widget')[0].statuscode], [1, 2]);
});

// @parity-evidence: no new proof; retag from the file's parity. native ownerAndState (both captures) shows a PATCH statecode's SetStateDynamicEntity at depth 2 under an Upsert/30 frame, and sdkMessages (both) shows SetState under an Update at stage 40; no capture of a plain Update that sets statecode
// @test-kind unproven: local model of a plain Update that sets statecode (no Web API Upsert frame); native-r2 needs an SDK Update that sets statecode, recorded without the Upsert frame, to prove the one-level-deeper order
test('an Update that sets statecode runs SetStateDynamicEntity inside its main operation, one level deeper', () => {
  const store = storeOf(),
    seen = recording(store, ['update', 'setstatedynamicentity']);
  store.updateRecord('widget', id, { statecode: 1, statuscode: 2 }, { admin: true });
  assert.deepEqual(order(seen), [
    'update/10',
    'update/20',
    'SetStateDynamicEntity/10',
    'SetStateDynamicEntity/20',
    'SetStateDynamicEntity/40',
    'update/40',
  ]);
  assert.deepEqual(seen.at(-2).outputs, { IsValid: true });
  seen.length = 0;
  // Without statecode in the request only the Update pipeline runs (native PATCH ownerid).
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true });
  assert.deepEqual(order(seen), ['update/10', 'update/20', 'update/40']);
});

// @test-kind parity+security: native dev-environment plug-in recorder corpus 2026-10-30, sdkMessages scenario: a team's shared mask is its RetrievePrincipalAccess answer; the explicit backend grants still decide
test('SDK sharing messages change principalobjectaccess and answer typed access rights', () => {
  const store = storeOf(),
    seen = recording(store, [
      'grantaccess',
      'modifyaccess',
      'revokeaccess',
      'retrieveprincipalaccess',
      'retrievesharedprincipalsandaccess',
    ]);
  const access = (mask) => ({ $type: 'PrincipalAccess', principal: ref('team', team), accessMask: mask });
  execute(store, 'GrantAccess', { Target: ref('widget', id), PrincipalAccess: access(1) });
  execute(store, 'ModifyAccess', { Target: ref('widget', id), PrincipalAccess: access(3) });
  assert.equal(store.tableRows('principalobjectaccess')[0].accessrightsmask, 3);
  const rights = execute(store, 'RetrievePrincipalAccess', { Target: ref('widget', id), Principal: ref('team', team) });
  assert.deepEqual(rights.results, { AccessRights: { $type: 'AccessRights', value: 3 } });
  const shared = execute(store, 'RetrieveSharedPrincipalsAndAccess', { Target: ref('widget', id) });
  assert.deepEqual(shared.results.PrincipalAccesses, {
    $type: 'SdkArray',
    elementType: 'PrincipalAccess',
    values: [{ $type: 'PrincipalAccess', principal: ref('team', team), accessMask: 3 }],
  });
  execute(store, 'RevokeAccess', { Target: ref('widget', id), Revokee: ref('team', team) });
  assert.equal(store.tableRows('principalobjectaccess').length, 0);
  assert.deepEqual(
    order(seen).filter((entry) => entry.endsWith('/40')),
    [
      'GrantAccess/40',
      'ModifyAccess/40',
      'RetrievePrincipalAccess/40',
      'RetrieveSharedPrincipalsAndAccess/40',
      'RevokeAccess/40',
    ],
  );
  assert.deepEqual(seen.find((entry) => entry.message === 'RetrievePrincipalAccess' && entry.stage === 40).outputs, {
    AccessRights: { $type: 'AccessRights', value: 3 },
  });
  // The explicit backend grants still decide: no update grant, no share.
  assert.throws(
    () =>
      dispatchSdkCall({
        store,
        profile: { ...profile, grants: [{ entity: 'widget', operations: ['read'] }] },
        message: {
          method: 'Execute',
          userId: caller,
          arguments: [request('GrantAccess', { Target: ref('widget', id), PrincipalAccess: access(1) })],
        },
      }),
    (error) => error.code === 'LocalBackendPermissionDenied',
  );
  assert.equal(store.tableRows('principalobjectaccess').length, 0);
});

test('SDK Merge refuses a table without a Merge filter with the native fault', () => {
  const store = storeOf();
  assert.throws(
    () =>
      execute(store, 'Merge', {
        Target: ref('widget', id),
        SubordinateId: { $type: 'Guid', value: '00000000-0000-0000-0000-000000000001' },
        UpdateContent: {
          $type: 'Entity',
          logicalName: 'widget',
          id: '00000000-0000-0000-0000-000000000000',
          attributes: {},
        },
        PerformParentingChecks: false,
      }),
    (error) =>
      error.details?.innerCode === '0x80040800' &&
      error.message ===
        "The 'Merge' method does not support entities of type 'widget'. MessageProcessorCache returned MessageProcessor.Empty. ",
  );
});

test('named message steps are executable, global ones match every table and never-executed messages never refuse', () => {
  const step = (message, extra = {}) => ({
    id: '30000000-0000-4000-8000-000000000001',
    message,
    entity: null,
    unfiltered: true,
    messageFilterId: null,
    enabled: true,
    mode: 0,
    stage: 20,
    rank: 1,
    supportedDeployment: 0,
    images: [],
    typeName: 'Invented.Step',
    assemblyId: 'invented',
    ...extra,
  });
  for (const message of [
    'Assign',
    'SetStateDynamicEntity',
    'GrantAccess',
    'RetrievePrincipalAccess',
    'DeleteMultiple',
  ]) {
    assert.equal(pluginMessageHasPipeline(step(message)), true, message);
    assert.equal(pluginUnsupported(step(message)), null, message);
    assert.equal(pluginUnsupported(step(message, { mode: 1, stage: 40 })), null, message);
    assert.equal(pluginStepMatchesEntity(step(message), 'widget'), true, message);
  }
  // Recorded native corpus: registered Upsert, UpsertMultiple and SetState steps never execute; they never refuse.
  for (const message of ['Upsert', 'UpsertMultiple', 'SetState']) {
    const store = { pluginPipeline: { steps: () => [{ ...step(message), mode: 'clr', entity: 'widget' }] } };
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, message, {}, 'widget'));
  }
});

// @test-kind contract: Paqvilo refuses a chosen step on a named message whose local entry point has no pipeline (501) instead of skipping it
// @parity-evidence: native recorder corpus 2026-10-30 soapMessages (two captures): SOAP Assign runs the Assign pipeline, so the local refusal moves out of the file's parity tag
// Native runs this pipeline (recorder corpus 2026-10-30, soapMessages: SOAP Assign runs Assign 10/20/40 with the
// delegated Update 20/40 under Assign stage 30), so this refusal is a local limitation, not platform behaviour.
test('a chosen step on a named message without a local pipeline refuses', () => {
  const store = {
    pluginPipeline: {
      steps: () => [
        {
          id: '30000000-0000-4000-8000-000000000001',
          message: 'Assign',
          entity: 'widget',
          unfiltered: true,
          messageFilterId: null,
          enabled: true,
          mode: 'clr',
          stage: 20,
          rank: 1,
          supportedDeployment: 0,
          images: [],
          typeName: 'Invented.Step',
          assemblyId: 'invented',
        },
      ],
    },
  };
  assert.throws(
    () => assertPluginMessageAdmission(store, 'Assign', {}, 'widget'),
    /plug-in pipeline is not implemented/,
  );
});

async function bulkFixture(t, steps, seen) {
  const { contractModuleFixture } = await import('./contract-module-fixture.mjs');
  const { createOrganizationBackend } = await import('../lib/organization-backend.mjs');
  const { pluginCatalogue } = await import('../lib/exported-plugins.mjs');
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: id, x_name: 'Existing' }] },
    extension: { name: 'platform-message-probe', install: () => {} },
  });
  const handlers = new Map(
    steps.map((step) => [step.id, (c) => void seen.push(`${step.message}/${step.stage}/${c.targets?.length ?? 1}`)]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return f;
}
const bulkStep = (message, stage, n) => ({
  id: `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Probe',
  assemblyId: 'invented',
});

test('HTTP DeleteMultiple on a standard table runs PreValidation, then refuses natively without deleting', async (t) => {
  const seen = [];
  const f = await bulkFixture(
    t,
    [
      bulkStep('DeleteMultiple', 10, 1),
      bulkStep('Delete', 10, 2),
      bulkStep('DeleteMultiple', 20, 3),
      bulkStep('Delete', 20, 4),
    ],
    seen,
  );
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.DeleteMultiple', {
    Targets: [{ '@odata.type': 'Microsoft.Dynamics.CRM.x_item', x_itemid: id }],
  });
  const body = await response.json();
  assert.equal(response.status, 405);
  assert.equal(body.error.code, '0x8004023b');
  assert.equal(body.error.message, 'DeleteMultiple has not yet been implemented');
  assert.deepEqual(seen, ['DeleteMultiple/10/1', 'Delete/10/1']);
  assert.equal(f.store.tableRows('x_item').length, 1);
});

test('HTTP UpsertMultiple keyed by the primary column creates new records, then updates existing ones', async (t) => {
  const seen = [],
    fresh = '20000000-0000-4000-8000-000000000002';
  const f = await bulkFixture(
    t,
    [bulkStep('CreateMultiple', 20, 1), bulkStep('UpdateMultiple', 20, 2), bulkStep('UpsertMultiple', 20, 3)],
    seen,
  );
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpsertMultiple', {
    Targets: [id, fresh].map((key) => ({
      '@odata.type': 'Microsoft.Dynamics.CRM.x_item',
      x_itemid: key,
      x_name: 'Upserted',
    })),
  });
  assert.equal(response.status, 204, await response.text());
  // Registered UpsertMultiple steps never execute natively.
  assert.deepEqual(seen, ['CreateMultiple/20/1', 'UpdateMultiple/20/1']);
  assert.deepEqual(
    f.store.tableRows('x_item').map((row) => row.x_name),
    ['Upserted', 'Upserted'],
  );
});

test('HTTP many-to-many association reads the intersect pair before its Associate pipeline', async (t) => {
  const { contractModuleFixture } = await import('./contract-module-fixture.mjs');
  const { createOrganizationBackend } = await import('../lib/organization-backend.mjs');
  const { pluginCatalogue } = await import('../lib/exported-plugins.mjs');
  const root = '20000000-0000-4000-8000-000000000011',
    tag = '20000000-0000-4000-8000-000000000012';
  const f = await contractModuleFixture(t, {
    mappings: {
      root: {
        entitySet: 'roots',
        idColumn: 'rootid',
        relationships: {
          tags: {
            schemaName: 'root_tag',
            entity: 'tag',
            from: 'rootid',
            to: 'tagid',
            many: true,
            intersect: { entity: 'edge', from: 'rootid', to: 'tagid' },
          },
        },
      },
      tag: { entitySet: 'tags', idColumn: 'tagid' },
      edge: {
        entitySet: 'edges',
        idColumn: 'edgeid',
        intersect: true,
        fields: { rootid: { dataverseType: 'uniqueidentifier' }, tagid: { dataverseType: 'uniqueidentifier' } },
      },
    },
    tables: { root: [{ rootid: root }], tag: [{ tagid: tag }], edge: [] },
    extension: { name: 'association-read-probe', install: () => {} },
  });
  const seen = [];
  const steps = ['RetrieveMultiple', 'Associate'].map((message, index) => ({
    ...bulkStep(message, 20, index + 1),
    entity: null,
    unfiltered: true,
    messageFilterId: null,
  }));
  const handlers = new Map(
    steps.map((step) => [step.id, (c) => void seen.push(`${step.message}:${c.entity}:${c.query?.$type ?? ''}`)]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  const response = await f.request('POST', `/roots(${root})/tags/$ref`, {
    '@odata.id': `${f.server.origin}/api/data/v9.2/tags(${tag})`,
  });
  assert.equal(response.status, 204, await response.text());
  assert.deepEqual(seen, ['RetrieveMultiple:edge:FetchExpression', 'Associate:root:']);
});

// @test-kind compatibility: Web API lookup property _<name>_value maps to the logical attribute <name> (Microsoft Learn Web API lookup properties)
test('a read observer receives Web API lookup properties as their logical attribute names', async () => {
  const { odataToSdkQuery } = await import('../lib/plugin-query.mjs');
  const query = odataToSdkQuery('widget', { $select: '_ownerid_value,title', $filter: `_ownerid_value eq ${caller}` });
  assert.deepEqual(query.columnSet.columns, ['ownerid', 'title']);
  assert.equal(query.criteria.conditions[0].attributeName, 'ownerid');
});

// A user-owned invented table; the registered steps record the stage, the message and the AcceptLang they see.
async function sharedFixture(t, steps, seen) {
  const { contractModuleFixture } = await import('./contract-module-fixture.mjs');
  const { createOrganizationBackend } = await import('../lib/organization-backend.mjs');
  const { pluginCatalogue } = await import('../lib/exported-plugins.mjs');
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        ownership: 'UserOwned',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: id, x_name: 'Existing' }] },
    extension: { name: 'accept-language-probe', install: () => {} },
  });
  const handlers = new Map([
    [
      'Invented.Probe',
      ({ context }) =>
        void seen.push({ at: `${context.MessageName}/${context.Stage}`, lang: context.SharedVariables?.AcceptLang }),
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return f;
}

// @test-kind parity: native recorder corpus webApiNamed and soapMessages (two captures each): AcceptLang at stages 10/20/40 is the request Accept-Language; SDK-issued messages report ''
test('a Web API GrantAccess reports the request Accept-Language at every stage, an SDK-issued Assign reports none', async (t) => {
  const seen = [];
  const f = await sharedFixture(
    t,
    [10, 20, 40].flatMap((stage) => [bulkStep('GrantAccess', stage, stage), bulkStep('Assign', stage, stage + 100)]),
    seen,
  );
  const user = f.store.tableRows('systemuser').find((item) => item.fullname !== 'SYSTEM').systemuserid;
  const granted = await f.request(
    'POST',
    '/GrantAccess',
    {
      Target: { '@odata.type': 'Microsoft.Dynamics.CRM.x_item', x_itemid: id },
      PrincipalAccess: {
        Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: user },
        AccessMask: 'ReadAccess',
      },
    },
    { 'accept-language': 'x-test' },
  );
  assert.ok(granted.status < 300, await granted.text());
  assert.deepEqual(
    seen.map((entry) => entry.at),
    ['GrantAccess/10', 'GrantAccess/20', 'GrantAccess/40'],
  );
  assert.ok(
    seen.every((entry) => entry.lang === 'x-test'),
    JSON.stringify(seen),
  );
  seen.length = 0;
  const caller = f.store.tableRows('systemuser').find((item) => item.applicationid).systemuserid;
  dispatchSdkCall({
    store: f.store,
    profile: { ...profile, userId: caller, grants: [{ entity: 'x_item', operations: ['read', 'update'] }] },
    sdkFromSandbox: true,
    message: {
      method: 'Execute',
      userId: caller,
      arguments: [request('Assign', { Target: ref('x_item', id), Assignee: ref('systemuser', user) })],
    },
  });
  assert.deepEqual(
    seen.map((entry) => entry.at),
    ['Assign/10', 'Assign/20', 'Assign/40'],
  );
  assert.ok(
    seen.every((entry) => entry.lang === ''),
    JSON.stringify(seen),
  );
});

// @test-kind parity: native recorder corpus webApiNamed and soapMessages (two captures each): AcceptLang at stages 10/20/40 is the request Accept-Language; SDK-issued messages report ''
test('a SOAP Assign reports the request Accept-Language at every stage', async (t) => {
  const { handleSoap } = await import('../lib/dataverse-soap.mjs');
  const { NS } = await import('../lib/dataverse-soap-xml.mjs');
  const seen = [];
  const steps = [10, 20, 40].map((stage) => bulkStep('Assign', stage, stage));
  const f = await sharedFixture(t, steps, seen);
  const caller = f.store.tableRows('systemuser').find((item) => item.applicationid);
  const assignee = f.store.tableRows('systemuser').find((item) => item.fullname !== 'SYSTEM').systemuserid;
  const pair = (key, value) =>
    `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${value}</a:KeyValuePairOfstringanyType>`;
  const reference = (logical, value) =>
    `<b:value i:type="a:EntityReference"><a:Id>${value}</a:Id><a:LogicalName>${logical}</a:LogicalName></b:value>`;
  const parameters = pair('Target', reference('x_item', id)) + pair('Assignee', reference('systemuser', assignee));
  const xmlns = Object.entries(NS)
    .map(([key, uri]) => `xmlns:${key}="${uri}"`)
    .join(' ');
  const bodyText = `<s:Envelope ${xmlns}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest"><a:Parameters>${parameters}</a:Parameters><a:RequestName>Assign</a:RequestName></request></Execute></s:Body></s:Envelope>`;
  const response = await handleSoap(
    {
      method: 'POST',
      headers: {},
      bodyText,
      user: caller,
      caller,
      // The router's identity carries the request Accept-Language (organizationPrincipalContext, dataverse.acceptLanguage).
      identity: {
        admin: true,
        id: caller.systemuserid,
        systemUserId: caller.systemuserid,
        dataverse: { acceptLanguage: 'x-test' },
      },
      origin: f.server.origin,
      version: 'v9.2',
    },
    f.api,
  );
  assert.doesNotMatch(response.body, /Fault/, response.body);
  assert.deepEqual(
    seen.map((entry) => entry.at),
    ['Assign/10', 'Assign/20', 'Assign/40'],
  );
  assert.ok(
    seen.every((entry) => entry.lang === 'x-test'),
    JSON.stringify(seen),
  );
});
