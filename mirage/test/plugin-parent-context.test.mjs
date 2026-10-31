// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30 (crud, upsert, sdkMessages, ownerAndState, bulk, faults, depth, customApi): ParentContext levels a CLR step can reach
// Every ParentContext level a CLR step reads, against the native recorder corpus: no level leaves a property
// unavailable, ancestors report the observing context's IsInTransaction and InitiatingUserAgent, an impersonating
// step's main operation runs as its user, named messages are the direct parent of the record operations they
// delegate, a PATCH statecode's SetStateDynamicEntity shares the Update's request, and the ObjectModel step id is
// per message and table. The recording pipeline stands in for a CLR step: it builds the real CLR context of each
// phase and, where a scenario needs it, issues the plug-in's SDK request with that context as its entry snapshot.
// Invented schema and identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import {
  clrContext,
  dispatchSdkCall,
  enterPluginExecution,
  leavePluginExecution,
  pluginExecutionDepth,
} from '../lib/plugin-clr.mjs';
import { runPluginPhase } from '../lib/exported-plugins.mjs';
import { singleMultiplePipeline } from '../lib/plugin-single-multiple.mjs';
import { clrSdkEntryContext, observedParentChain, selectSdkEntryParent } from '../lib/plugin-sdk-parent.mjs';
import { refuseDeleteMultiple } from '../lib/plugin-platform-messages.mjs';

const caller = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000002',
  system = '10000000-0000-4000-8000-000000000003',
  unit = '10000000-0000-4000-8000-000000000004',
  org = '10000000-0000-4000-8000-000000000005',
  callerObject = '50000000-0000-4000-8000-000000000001',
  otherObject = '50000000-0000-4000-8000-000000000002',
  id = '20000000-0000-4000-8000-000000000001',
  stepId = '30000000-0000-4000-8000-000000000001';

const storeOf = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid', nameColumn: 'title', ownership: 'UserOwned' },
        ledger: { entitySet: 'ledgers', idColumn: 'ledgerid', nameColumn: 'title', ownership: 'OrganizationOwned' },
        gizmo: { entitySet: 'gizmos', idColumn: 'gizmoid', nameColumn: 'title', ownership: 'UserOwned' },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        widget: [{ widgetid: id, title: 'Before', statecode: 0, statuscode: 1, level: 0 }],
        ledger: [],
        gizmo: [],
        systemuser: [
          { systemuserid: caller, fullname: 'Invented caller', azureactivedirectoryobjectid: callerObject },
          { systemuserid: other, fullname: 'Invented other', azureactivedirectoryobjectid: otherObject },
          { systemuserid: system, fullname: 'SYSTEM' },
        ],
        principalobjectaccess: [],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const runtime = {
  descriptor: {
    context: { executionUserId: caller, initiatingUserId: caller, organizationId: org, businessUnitId: unit },
    serviceProfile: { userId: caller, evidence: 'Invented parent-context probe', grants: [] },
  },
};
const profile = {
  userId: caller,
  evidence: 'Invented parent-context probe',
  grants: [
    { entity: 'widget', operations: ['create', 'read', 'update'] },
    { entity: 'ledger', operations: ['create', 'read', 'update'] },
    { entity: 'gizmo', operations: ['create', 'read', 'update'] },
  ],
};
const step = ({ mode = 0, impersonatingUserId } = {}) => ({
  id: stepId,
  name: 'Invented probe',
  images: [],
  contract: { mode },
  ...(impersonatingUserId ? { impersonatingUserId } : {}),
});
// The CLR context of every phase that `want` selects; `act(answer, phase)` runs as the probe step's body.
// multiple: registrations whose multiple message runs for each single one (organization-backend.mjs bridging).
// items: registrations the real phase matches (asynchronous ones only queue, they never execute here).
function probe(store, want, { act, stepOf = () => step(), multiple, items = [] } = {}) {
  const seen = [],
    snapshots = new WeakMap();
  const pipeline = (phase) => {
    const frame = runPluginPhase({ ...phase, store, items, handlers: new Map() });
    // @parity-evidence: native recorder corpus crud/depth/faults (two captures): a single Create/Update/Delete runs its paired multiple message's steps on the same frame (audit C26a); only this probe helper changes, no assertion
    // A single Create/Update/Delete also runs its multiple message's steps on its own frame (plugin-single-multiple.mjs).
    const labels = [
      `${phase.customApi?.name ?? phase.operation}/${phase.stage}`,
      ...(multiple && phase.bridgedMessage ? [`${phase.bridgedMessage}/${phase.stage}`] : []),
    ];
    for (const label of labels) {
      if (!want(label, phase)) continue;
      const bridged = label !== labels[0];
      if (phase.stage !== 10 && snapshots.has(phase.record)) frame.preValidationContext = snapshots.get(phase.record);
      frame.callerIdentity ??= phase.identity;
      // A multiple message step reads its Targets and images from the frame (exported-plugins.mjs).
      if (phase.targets)
        Object.assign(frame, {
          targets: phase.targets,
          previousRecords: phase.previousRecords,
          records: phase.records,
        });
      const answer = clrContext({
        runtime,
        store,
        step: stepOf(label),
        entity: phase.entity,
        operation: phase.operation,
        stage: phase.stage,
        target: phase.target,
        record: phase.record,
        previous: phase.previous,
        frame,
        depth: pluginExecutionDepth() + 1,
        bridged,
      });
      seen.push({
        label,
        context: answer.context,
        inputs: answer.inputParameters.values,
        shared: answer.sharedVariables,
      });
      // A record PreValidation step's context becomes the main operation's parent snapshot (exported-plugins.mjs).
      if (!bridged && phase.stage === 10 && ['create', 'update', 'delete'].includes(phase.operation))
        snapshots.set(phase.record, {
          $type: 'ExecutionContext',
          values: {
            ...structuredClone(answer.context),
            InputParameters: structuredClone(answer.inputParameters),
            OutputParameters: structuredClone(answer.outputParameters),
            SharedVariables: structuredClone(answer.sharedVariables),
          },
        });
      enterPluginExecution();
      try {
        act?.(answer, label);
      } finally {
        leavePluginExecution();
      }
    }
    return frame;
  };
  store.setPluginPipeline(multiple ? singleMultiplePipeline(pipeline) : pipeline);
  return seen;
}
// The plug-in's SDK request, with the server's entry snapshot of the calling step as its parent.
const sdk = (store, answer, method, args) =>
  dispatchSdkCall({
    store,
    profile,
    sdkFromSandbox: true,
    sdkParentContext: selectSdkEntryParent(clrSdkEntryContext(answer), answer.sdkFrameworkSource),
    message: { method, userId: caller, arguments: args },
  });
const ref = (logicalName, value) => ({ $type: 'EntityReference', logicalName, id: value, name: null });
const executeRequest = (requestName, values) => [
  { $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } },
];
const chain = (context) => {
  const levels = [];
  for (let level = context; level; level = level.ParentContext?.values) levels.push(level);
  return levels;
};
const label = (level) => `${level.MessageName}/${level.Stage}/d${level.Depth}`;
// Every property the CLR host reads from a context (plugin-clr-host.cs LocalContext).
const CONTEXT_PROPERTIES = [
  'Mode',
  'IsolationMode',
  'Depth',
  'MessageName',
  'PrimaryEntityName',
  'RequestId',
  'SecondaryEntityName',
  'InputParameters',
  'OutputParameters',
  'SharedVariables',
  'UserId',
  'InitiatingUserId',
  'BusinessUnitId',
  'OrganizationId',
  'OrganizationName',
  'PrimaryEntityId',
  'PreEntityImages',
  'PostEntityImages',
  'OwningExtension',
  'CorrelationId',
  'IsExecutingOffline',
  'IsOfflinePlayback',
  'IsInTransaction',
  'OperationId',
  'OperationCreatedOn',
  'Stage',
  'ParentContext',
  'UserAzureActiveDirectoryObjectId',
  'InitiatingUserAzureActiveDirectoryObjectId',
  'InitiatingUserApplicationId',
  'PortalsContactId',
  'IsPortalsClientCall',
  'AuthenticatedUserId',
  'PreEntityImagesCollection',
  'PostEntityImagesCollection',
  'InitiatingUserAgent',
  'EnvironmentId',
  'TenantId',
  'IsApplicationUser',
];
// The step's own context carries its parameter collections beside it (answer.inputParameters ...).
const assertComplete = (context, where) => {
  for (const property of CONTEXT_PROPERTIES.filter((name) => !/Parameters$|SharedVariables|Images$/.test(name)))
    assert.ok(Object.hasOwn(context, property), `${where} lacks ${property}`);
  for (const level of chain(context).slice(1))
    for (const property of CONTEXT_PROPERTIES)
      assert.ok(Object.hasOwn(level, property), `${where}: ${label(level)} lacks ${property}`);
};

// Native crud/upsert/bulk/sdkMessages: no ParentContext property is ever unavailable; stage-30 frames are owned by
// "ObjectModel Implementation" and carry empty Context4 image collections.
test('every synthetic main-operation parent carries every context property', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['update/10', 'update/20', 'update/40', 'Assign/20'].includes(at), {
    act: (answer, at) => {
      if (at === 'update/40' && answer.context.Depth === 1)
        sdk(
          store,
          answer,
          'Execute',
          executeRequest('Assign', { Target: ref('widget', id), Assignee: ref('systemuser', other) }),
        );
    },
  });
  // A bare Web API PATCH: Update under its Upsert main operation.
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true }, { preValidationSourceOperation: 'upsert' });
  for (const { label: at, context } of seen) assertComplete(context, at);
  const bare = seen.find((entry) => entry.label === 'update/20').context;
  const upsert = bare.ParentContext.values.ParentContext.values;
  assert.equal(upsert.MessageName, 'Upsert');
  assert.equal(upsert.OwningExtension.name, 'ObjectModel Implementation');
  assert.deepEqual(upsert.PreEntityImagesCollection, { $type: 'EntityImageCollectionArray', values: [] });
  assert.deepEqual(upsert.BusinessUnitId, { $type: 'Guid', value: unit });
  // The SDK Assign's owner Update sees the Assign main operation.
  const assigned = seen.find((entry) => entry.label === 'update/20' && entry.context.Depth === 2).context;
  const assign = assigned.ParentContext.values;
  assert.equal(assign.MessageName, 'Assign');
  assert.equal(assign.OwningExtension.name, 'ObjectModel Implementation');
  assert.deepEqual(assign.OrganizationId, { $type: 'Guid', value: org });
});

const refuseDelete = (store) =>
  refuseDeleteMultiple(store, {
    mapping: store.resolveMapping('widget'),
    rows: store.tableRows('widget'),
    identity: { admin: true },
    options: { pluginAcceptLanguage: '*' },
  });

// Native bulk: DeleteMultiple on a standard table runs the per-record Delete PreValidation under DeleteMultiple/10.
test('the DeleteMultiple refusal parent of a per-record Delete is complete', () => {
  const store = storeOf();
  const seen = probe(store, (at) => at === 'delete/10');
  assert.throws(
    () => refuseDelete(store),
    (error) => error.code === 'NotImplemented',
  );
  assert.equal(seen.length, 1);
  for (const { label: at, context } of seen) assertComplete(context, at);
  assert.equal(seen[0].context.ParentContext.values.MessageName, 'DeleteMultiple');
});

// Native crud/faults/upsert: in every synchronous event each ancestor's IsInTransaction equals the observing context's
// (855 samples, no exception); e.g. faults Create/20/d2 < Create/30/d2 < Create/10/d1 all in the transaction.
test('ancestors report the observing context IsInTransaction', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['update/10', 'update/20', 'create/10', 'create/20'].includes(at), {
    act: (answer, at) => {
      if (at === 'create/10' && answer.context.Depth === 1)
        sdk(store, answer, 'Create', [{ $type: 'Entity', logicalName: 'ledger', attributes: { title: 'Nested' } }]);
    },
  });
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true }, { preValidationSourceOperation: 'upsert' });
  const early = seen.find((entry) => entry.label === 'update/10').context,
    late = seen.find((entry) => entry.label === 'update/20').context;
  assert.deepEqual(
    chain(early).map((level) => level.IsInTransaction),
    [false, false],
  );
  assert.deepEqual(
    chain(late).map((level) => level.IsInTransaction),
    [true, true, true],
  );
  store.createRecord('widget', { title: 'Root' }, { admin: true });
  const nested = seen.find((entry) => entry.label === 'create/20' && entry.context.Depth === 2).context;
  assert.deepEqual(chain(nested).map(label), ['Create/20/d2', 'Create/30/d2', 'Create/10/d1']);
  assert.deepEqual(
    chain(nested).map((level) => level.IsInTransaction),
    [true, true, true],
  );
});

// Native crud "Probe: Update 40 impersonated": UserId and AAD object id of the step and its Update/30 parent are the
// impersonated user's, the Upsert/30 grandparent stays the caller; a sibling without impersonation sees the caller.
test('an impersonating step sees its main operation run as its user', () => {
  const store = storeOf();
  let impersonate = true;
  const seen = probe(store, (at) => ['update/10', 'update/40'].includes(at), {
    stepOf: (at) => step({ impersonatingUserId: impersonate && at === 'update/40' ? other : undefined }),
  });
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true }, { preValidationSourceOperation: 'upsert' });
  impersonate = false;
  store.updateRecord('widget', id, { title: 'Again' }, { admin: true }, { preValidationSourceOperation: 'upsert' });
  const identities = (context) =>
    chain(context).map((level) => [level.UserId.value, level.UserAzureActiveDirectoryObjectId.value]);
  const late = seen.filter((entry) => entry.label === 'update/40');
  assert.deepEqual(identities(late[0].context), [
    [other, otherObject],
    [other, otherObject],
    [caller, callerObject],
  ]);
  assert.deepEqual(identities(late[1].context), [
    [caller, callerObject],
    [caller, callerObject],
    [caller, callerObject],
  ]);
});

// Native sdkMessages: "Update/20/d2 < Assign/30/d2 < Update/40/d1 < Update/30/d1" (no Update/30 between the owner
// Update and Assign), likewise under SetStateDynamicEntity/30.
test('a named message main operation is the direct parent of the Update it delegates', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['update/20', 'update/40'].includes(at), {
    act: (answer, at) => {
      if (at !== 'update/40' || answer.context.Depth !== 1) return;
      sdk(
        store,
        answer,
        'Execute',
        executeRequest('Assign', { Target: ref('widget', id), Assignee: ref('systemuser', other) }),
      );
      sdk(
        store,
        answer,
        'Execute',
        executeRequest('SetState', {
          EntityMoniker: ref('widget', id),
          State: { $type: 'OptionSetValue', value: 1 },
          Status: { $type: 'OptionSetValue', value: 2 },
        }),
      );
    },
  });
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true });
  const nested = seen.filter((entry) => entry.context.Depth === 2).map((entry) => chain(entry.context).map(label));
  assert.deepEqual(nested, [
    ['Update/20/d2', 'Assign/30/d2', 'Update/40/d1', 'Update/30/d1'],
    ['Update/40/d2', 'Assign/30/d2', 'Update/40/d1', 'Update/30/d1'],
    ['Update/20/d2', 'SetStateDynamicEntity/30/d2', 'Update/40/d1', 'Update/30/d1'],
    ['Update/40/d2', 'SetStateDynamicEntity/30/d2', 'Update/40/d1', 'Update/30/d1'],
  ]);
  // Assign's owner Update runs as SYSTEM and its Assign/30 parent reports that user; the caller stays above it.
  const users = seen
    .filter((entry) => entry.context.Depth === 2)
    .map((entry) => chain(entry.context).map((level) => level.UserId.value));
  assert.deepEqual(users, [
    [system, system, caller, caller],
    [system, system, caller, caller],
    [caller, caller, caller, caller],
    [caller, caller, caller, caller],
  ]);
});

// Native ownerAndState: a PATCH statecode runs SetStateDynamicEntity at d2 under an Upsert/30 frame at d2 that shares
// the Update's RequestId and OperationId; its asynchronous copy's parent is SetStateDynamicEntity/30 (Mode 1).
test('a PATCH statecode SetStateDynamicEntity joins the Update request under its Upsert frame', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['update/20', 'SetStateDynamicEntity/10', 'SetStateDynamicEntity/40'].includes(at));
  store.updateRecord(
    'widget',
    id,
    { statecode: 1, statuscode: 2 },
    { admin: true },
    { preValidationSourceOperation: 'upsert' },
  );
  const update = seen.find((entry) => entry.label === 'update/20').context;
  for (const at of ['SetStateDynamicEntity/10', 'SetStateDynamicEntity/40']) {
    const state = seen.find((entry) => entry.label === at).context;
    // @parity-evidence: native recorder corpus upsert (native and native-r2): the SetStateDynamicEntity chain under its Upsert frame; the expected label is the same string written without a no-op replace (CodeQL js/identity-replacement), no assertion changed
    assert.deepEqual(chain(state).map(label), [`${at}/d2`, 'Upsert/30/d2']);
    assert.equal(state.RequestId.value, update.RequestId.value);
    assert.equal(state.OperationId.value, update.OperationId.value);
    assert.equal(state.ParentContext.values.RequestId.value, update.RequestId.value);
  }
});

// Native bulk: the per-record Delete PreValidation under the DeleteMultiple refusal has only Target, no SharedVariables
// and DeleteMultiple's RequestId and OperationId.
test('the DeleteMultiple refusal runs each Delete PreValidation inside the DeleteMultiple request', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['DeleteMultiple/10', 'delete/10'].includes(at));
  assert.throws(
    () => refuseDelete(store),
    (error) => error.code === 'NotImplemented',
  );
  const bulk = seen.find((entry) => entry.label === 'DeleteMultiple/10').context,
    single = seen.find((entry) => entry.label === 'delete/10');
  assert.deepEqual(Object.keys(single.inputs), ['Target']);
  assert.deepEqual(single.shared.values, {});
  assert.equal(seen.find((entry) => entry.label === 'DeleteMultiple/10').shared.values.IsAutoTransact, true);
  assert.equal(single.context.RequestId.value, bulk.RequestId.value);
  assert.equal(single.context.OperationId.value, bulk.OperationId.value);
});

// Native depth (two captures, eight depths, stages 10/20/40): an SDK request from a step at Depth 2 or deeper keeps the
// depth-1 step as ParentContext: Create/10/dN < Create/40/d1 < Create/30/d1 for N 3..10.
// @test-kind parity: native depth captures r1 and r2 (dataverse-recorder depth, native-r2 depth) reproduce the chain
// @parity-evidence: native-r2 depth repeats Create/10/dN < Create/40/d1 < Create/30/d1 and CreateMultiple/20/d3 < Create/30/d3 < Create/40/d1 (second capture, N7)
test('an SDK request from a nested step keeps the depth-1 step as its parent', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['create/10', 'create/40'].includes(at), {
    act: (answer, at) => {
      if (at === 'create/40' && answer.context.Depth < 4)
        sdk(store, answer, 'Create', [
          { $type: 'Entity', logicalName: 'widget', attributes: { title: 'Level ' + (answer.context.Depth + 1) } },
        ]);
    },
  });
  store.createRecord('widget', { title: 'Level 1' }, { admin: true });
  const early = seen.filter((entry) => entry.label === 'create/10').map((entry) => chain(entry.context).map(label));
  assert.deepEqual(early, [
    ['Create/10/d1'],
    ['Create/10/d2', 'Create/40/d1', 'Create/30/d1'],
    ['Create/10/d3', 'Create/40/d1', 'Create/30/d1'],
    ['Create/10/d4', 'Create/40/d1', 'Create/30/d1'],
  ]);
  assert.equal(store.tableRows('widget').length, 5);
});

// Native depth: a CreateMultiple step running for a nested Create sees that Create's main operation at its own depth
// (CreateMultiple/20/d3 < Create/30/d3 < Create/40/d1 < Create/30/d1).
// @test-kind parity: native depth captures r1 and r2 (dataverse-recorder depth, native-r2 depth) reproduce the chain
// @parity-evidence: native-r2 depth repeats Create/10/dN < Create/40/d1 < Create/30/d1 and CreateMultiple/20/d3 < Create/30/d3 < Create/40/d1 (second capture, N7)
test('a multiple step of a nested Create sees its main operation at the nested depth', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['create/40', 'createmultiple/20'].includes(at), {
    multiple: [
      { id: stepId, enabled: true, entity: 'widget', message: 'CreateMultiple', stage: 20, contract: { mode: 0 } },
      {
        id: '30000000-0000-4000-8000-000000000002',
        enabled: true,
        entity: 'widget',
        message: 'Create',
        stage: 40,
        contract: { mode: 0 },
      },
    ],
    act: (answer, at) => {
      if (at === 'create/40' && answer.context.Depth < 3)
        sdk(store, answer, 'Create', [{ $type: 'Entity', logicalName: 'widget', attributes: { title: 'Nested' } }]);
    },
  });
  store.createRecord('widget', { title: 'Level 1' }, { admin: true });
  const multiple = seen
    .filter((entry) => entry.label === 'createmultiple/20')
    .map((entry) => chain(entry.context).map(label));
  assert.deepEqual(multiple.at(-1), ['CreateMultiple/20/d3', 'Create/30/d3', 'Create/40/d1', 'Create/30/d1']);
});

// Native depth/faults/sdkMessages/customApi: a request a plug-in issues through its IOrganizationService reports ''
// as InitiatingUserAgent on its context and every ancestor (also the d1 ones); the HTTP request reports its agent.
test('a plug-in request reports no user agent on its context and ancestors', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['update/10', 'update/40', 'create/20'].includes(at), {
    act: (answer, at) => {
      if (at === 'update/40')
        sdk(store, answer, 'Create', [{ $type: 'Entity', logicalName: 'ledger', attributes: { title: 'Nested' } }]);
    },
  });
  store.updateRecord(
    'widget',
    id,
    { title: 'Renamed' },
    { systemUserId: caller, dataverse: { callerId: caller, userAgent: 'invented-agent/1' } },
    { preValidationSourceOperation: 'upsert' },
  );
  const agents = (at) =>
    chain(seen.find((entry) => entry.label === at).context).map((level) => level.InitiatingUserAgent);
  assert.deepEqual(agents('update/40'), ['invented-agent/1', 'invented-agent/1', 'invented-agent/1']);
  assert.deepEqual(agents('create/20'), ['', '', '', '', '']);
});

// Native depth/faults/pipelineEffects: the ObjectModel Implementation step id differs per table for one message and is
// stable across requests on one table (Create on two tables, recorded ids per message and table).
test('the ObjectModel main-operation step id is per message and table', () => {
  const store = storeOf();
  const seen = probe(store, (at) => at === 'create/20');
  store.createRecord('widget', { title: 'One' }, { admin: true });
  store.createRecord('widget', { title: 'Two' }, { admin: true });
  store.createRecord('ledger', { title: 'Three' }, { admin: true });
  const ids = seen.map((entry) => entry.context.ParentContext.values.OwningExtension.id);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
  assert.ok(
    seen.every((entry) => entry.context.ParentContext.values.OwningExtension.name === 'ObjectModel Implementation'),
  );
});

const rootOf = (context) => chain(context).at(-1).SharedVariables.values;
const access = (mask) => ({ $type: 'PrincipalAccess', principal: ref('systemuser', other), accessMask: mask });

// Native sdkMessages: after GrantAccess's main operation the request's root collection (Update/30/d1) lists
// principalobjectaccess and POADistributionChanged 10760, seen from GrantAccess/40 and every later context; the access
// reads run with IsAutoTransact false.
test('sharing messages mark the request root and access reads are not auto-transacted', () => {
  const store = storeOf();
  const traced = /^(update\/40|GrantAccess|RetrievePrincipalAccess|RetrieveSharedPrincipalsAndAccess)/;
  const seen = probe(store, (at) => traced.test(at), {
    act: (answer, at) => {
      if (at !== 'update/40' || answer.context.Depth !== 1) return;
      const run = (name, values) => sdk(store, answer, 'Execute', executeRequest(name, values));
      run('GrantAccess', { Target: ref('widget', id), PrincipalAccess: access(1) });
      run('RetrievePrincipalAccess', { Target: ref('widget', id), Principal: ref('systemuser', other) });
      run('RetrieveSharedPrincipalsAndAccess', { Target: ref('widget', id) });
    },
  });
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true });
  const at = (name) => seen.find((entry) => entry.label === name);
  assert.deepEqual(rootOf(at('GrantAccess/20').context).ChangedEntityTypes, { widget: 'Update' });
  assert.equal(rootOf(at('GrantAccess/20').context).POADistributionChanged, undefined);
  for (const name of ['GrantAccess/40', 'RetrievePrincipalAccess/10', 'RetrieveSharedPrincipalsAndAccess/40']) {
    assert.deepEqual(rootOf(at(name).context).ChangedEntityTypes, {
      widget: 'Update',
      principalobjectaccess: 'Update',
    });
    assert.equal(rootOf(at(name).context).POADistributionChanged, 10760);
  }
  for (const name of [
    'RetrievePrincipalAccess/10',
    'RetrievePrincipalAccess/40',
    'RetrieveSharedPrincipalsAndAccess/20',
  ])
    assert.equal(at(name).shared.values.IsAutoTransact, false);
  assert.equal(at('GrantAccess/20').shared.values.IsAutoTransact, true);
});

// Native upsert/crud/bulk: ChangedEntityTypes appears only on the root ancestor (no other ancestor or own collection of
// a parented context carries it): an upsert-created row's Create/30 has none, its Upsert/30 root lists the table.
test('only the request root lists the changed tables', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['create/10', 'create/40'].includes(at));
  const created = '20000000-0000-4000-8000-000000000009';
  store.createRecord(
    'widget',
    { widgetid: created, title: 'Upserted' },
    { admin: true },
    { preValidationSourceOperation: 'upsert' },
  );
  const late = seen.find((entry) => entry.label === 'create/40').context;
  assert.deepEqual(chain(late).map(label), ['Create/40/d1', 'Create/30/d1', 'Upsert/30/d1']);
  assert.equal(late.ParentContext.values.SharedVariables.values.ChangedEntityTypes, undefined);
  assert.deepEqual(rootOf(late).ChangedEntityTypes, { widget: 'Update' });
});

// Local model: a nested plug-in request's write of another user-owned table is listed in the caller's root; native
// captures show the root live (principalobjectaccess) but have no nested write of a second user-owned table.
// @test-kind unproven: no native capture of a nested write to a second user-owned table
test('a nested plug-in write lists its table in the caller root', () => {
  const store = storeOf();
  let written = false;
  const seen = probe(store, (at) => at === 'update/40', {
    act: (answer) => {
      if (written || answer.context.Depth !== 1) return;
      written = true;
      sdk(store, answer, 'Create', [{ $type: 'Entity', logicalName: 'gizmo', attributes: { title: 'Nested' } }]);
    },
  });
  store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true });
  assert.deepEqual(rootOf(seen[0].context).ChangedEntityTypes, { widget: 'Update' });
  // A later step of the same operation sees the nested write in the live root.
  const answer = clrContext({
    runtime,
    store,
    step: step(),
    entity: 'widget',
    operation: 'update',
    stage: 40,
    target: { title: 'Renamed' },
    record: store.tableRows('widget')[0],
    previous: store.tableRows('widget')[0],
    frame: { ...structuredClone(store.pluginFrames.get(store.tableRows('widget')[0]) ?? {}) },
    depth: 1,
  });
  assert.deepEqual(rootOf(answer.context).ChangedEntityTypes, { widget: 'Update', gizmo: 'Update' });
});

// Native bulk/sdkMessages/crud: a Web API CreateMultiple (or UpsertMultiple) request's collections have no
// DefaultsAddedFlag; CreateMultiple steps running for a single Create, and a plug-in's CreateMultiple, have it.
test('a Web API CreateMultiple carries no DefaultsAddedFlag', () => {
  const store = storeOf();
  const createMultiple = (bulkOrigin) =>
    runPluginPhase({
      items: [],
      handlers: new Map(),
      store,
      entity: 'widget',
      operation: 'createmultiple',
      stage: 10,
      target: {},
      record: { bulkIds: [] },
      previous: null,
      identity: { dataverse: { acceptLanguage: '*' } },
      bulkOrigin,
    });
  assert.deepEqual(createMultiple(true).sharedVariables.values, { IsAutoTransact: true, AcceptLang: '*' });
  assert.deepEqual(createMultiple(false).sharedVariables.values, {
    IsAutoTransact: true,
    AcceptLang: '*',
    DefaultsAddedFlag: true,
  });
});

// Native: no stage-30 ancestor in any scenario carries the Create telemetry root (all 89 ancestor samples that carry
// it are stage 25 or 40).
test('a stage-30 ancestor never carries the Create telemetry root', () => {
  const level = (stage, shared, parent = null) => ({
    $type: 'ExecutionContext',
    values: {
      MessageName: 'Create',
      PrimaryEntityName: 'widget',
      Stage: stage,
      SharedVariables: { $type: 'ParameterCollection', values: shared },
      ParentContext: parent,
    },
  });
  const observed = observedParentChain(
    level(40, { telemetryrootcontext: '{}', kept: 1 }, level(30, { telemetryrootcontext: '{}', kept: 2 })),
    { Mode: 0, IsInTransaction: true, InitiatingUserAgent: '', UserId: { $type: 'Guid', value: caller } },
    () => callerObject,
  );
  assert.deepEqual(observed.values.SharedVariables.values, { telemetryrootcontext: '{}', kept: 1 });
  assert.deepEqual(observed.values.ParentContext.values.SharedVariables.values, { kept: 2 });
});

// Native faults (two captures): after a Create PreValidation step's own SDK request, the Depth-1 Create's PreOperation
// and PostOperation collection reports AcceptLang '' while its main-operation collection keeps the caller's.
// @test-kind parity: native faults captures r1 and r2 both show Create/20 and Create/40 at Depth 1 with AcceptLang ''
// @parity-evidence: native-r2 faults reproduces AcceptLang '' on the Depth-1 Create/20 and Create/40 collections after the PreValidation step's SDK request, '*' on Create/30
test('a PreValidation SDK request leaves the later stages of its operation without Accept-Language', () => {
  const store = storeOf();
  const seen = probe(store, (at) => ['create/10', 'create/20'].includes(at), {
    act: (answer, at) => {
      if (at === 'create/10' && answer.context.Depth === 1)
        sdk(store, answer, 'Create', [{ $type: 'Entity', logicalName: 'ledger', attributes: { title: 'Nested' } }]);
    },
  });
  store.createRecord('widget', { title: 'Root' }, { admin: true }, { pluginAcceptLanguage: '*' });
  const late = seen.find((entry) => entry.label === 'create/20' && entry.context.Depth === 1);
  assert.equal(late.shared.values.AcceptLang, '');
  assert.equal(late.context.ParentContext.values.SharedVariables.values.AcceptLang, '*');
  // Without an SDK request the caller's language stays.
  const quiet = storeOf(),
    plain = probe(quiet, (at) => at === 'create/20');
  quiet.createRecord('widget', { title: 'Root' }, { admin: true }, { pluginAcceptLanguage: '*' });
  assert.equal(plain[0].shared.values.AcceptLang, '*');
});

// Native crud/faults/depth/upsert (r1 and r2): with asynchronous steps registered, the request root lists
// fileattachment 'Create' after the written table; native-r2 crudNoAsync, with every asynchronous step disabled, lists
// only the table. An organization-owned table's root lists only the attachment (depth: {fileattachment: Create}).
test('queued asynchronous work adds the job attachment to the request root', () => {
  const asyncStep = (entity, message) => ({
    id: '30000000-0000-4000-8000-0000000000a' + (message === 'Update' ? '1' : '2'),
    enabled: true,
    entity,
    message,
    stage: 40,
    mode: 'clr',
    contract: { mode: 1 },
    filteringAttributes: [],
    images: [],
  });
  const rootAt = (items, run) => {
    const store = storeOf();
    const seen = probe(store, (at) => at.endsWith('/40'), { items });
    run(store);
    return rootOf(seen.at(-1).context).ChangedEntityTypes;
  };
  const update = (store) =>
    store.updateRecord('widget', id, { title: 'Renamed' }, { admin: true }, { preValidationSourceOperation: 'upsert' });
  assert.deepEqual(rootAt([asyncStep('widget', 'Update')], update), { widget: 'Update', fileattachment: 'Create' });
  assert.deepEqual(rootAt([], update), { widget: 'Update' });
  assert.deepEqual(rootAt([{ ...asyncStep('widget', 'Update'), enabled: false }], update), { widget: 'Update' });
  assert.deepEqual(
    rootAt([asyncStep('ledger', 'Create')], (store) => store.createRecord('ledger', { title: 'Org' }, { admin: true })),
    { fileattachment: 'Create' },
  );
});

// @test-kind parity: native bypassHeaders (native and native-r2) 'bypass async' ev 4-6: under the CustomAsync bypass the Create root lists only the written table, without the fileattachment the other requests (ev 11, 12, 18, 19) add
test('a CustomAsync bypass adds no job attachment to the request root', () => {
  const store = storeOf();
  const seen = probe(store, (at) => at.endsWith('/40'), {
    items: [
      {
        id: '30000000-0000-4000-8000-0000000000a3',
        enabled: true,
        entity: 'widget',
        message: 'Update',
        stage: 40,
        mode: 'clr',
        contract: { mode: 1 },
        filteringAttributes: [],
        images: [],
      },
    ],
  });
  store.updateRecord(
    'widget',
    id,
    { title: 'Renamed' },
    { admin: true },
    { preValidationSourceOperation: 'upsert', bypassCustomAsync: true },
  );
  assert.deepEqual(rootOf(seen.at(-1).context).ChangedEntityTypes, { widget: 'Update' });
});
