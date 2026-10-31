// @test-kind parity: native recordings of single-record CLR context shapes: SharedVariables, stage-30 parent, async copies, Context4, Delete SYSTEM
// Context values a CLR plug-in sees, against the native shapes recorded for single-record operations: platform
// SharedVariables, the ObjectModel main-operation ParentContext, asynchronous copies, Context4 image collections,
// the Delete main operation's SYSTEM identity and the inputs of reads requested outside a plug-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import { runPluginPhase } from '../lib/exported-plugins.mjs';
import { stageImageSet } from '../lib/plugin-images.mjs';

const caller = '10000000-0000-0000-0000-000000000001',
  system = '10000000-0000-0000-0000-000000000002',
  id = '20000000-0000-0000-0000-000000000001',
  stepId = '30000000-0000-0000-0000-000000000001',
  empty = '00000000-0000-0000-0000-000000000000';

const fixture = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        gadget: { entitySet: 'gadgets', idColumn: 'gadgetid', nameColumn: 'title', ownership: 'UserOwned' },
        ledger: { entitySet: 'ledgers', idColumn: 'ledgerid', nameColumn: 'title', ownership: 'OrganizationOwned' },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        gadget: [{ gadgetid: id, title: 'Before', size: 3 }],
        ledger: [],
        systemuser: [
          { systemuserid: caller, fullname: 'Invented caller' },
          { systemuserid: system, fullname: 'SYSTEM' },
        ],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const runtime = {
  descriptor: {
    context: { executionUserId: caller, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
    serviceProfile: { userId: caller, evidence: 'Invented native context shapes', grants: [] },
  },
};
const step = (mode = 0, images = []) => ({ id: stepId, name: 'Invented step', images, contract: { mode } });
// Drives the frame bookkeeping of runPluginPhase (no registrations) through the given stages.
const phases = (store, operation, entity, stages, { target, record, previous, ...extra }) => {
  let frame;
  for (const stage of stages)
    frame = runPluginPhase({
      items: [],
      handlers: new Map(),
      store,
      entity,
      operation,
      stage,
      target,
      record,
      previous,
      identity: { dataverse: { acceptLanguage: 'uk-UA' } },
      ...extra,
    });
  return frame;
};

test('every pipeline collection starts with the platform SharedVariables and PreValidation keeps the main one', () => {
  const store = fixture(),
    target = { title: 'Requested' },
    record = { gadgetid: id, title: 'Requested', size: 3 },
    previous = { gadgetid: id, title: 'Before', size: 3 };
  let frame = phases(store, 'update', 'gadget', [10], { target, record, previous });
  assert.deepEqual(frame.sharedVariables.values, { IsAutoTransact: true, AcceptLang: 'uk-UA' });
  frame = phases(store, 'update', 'gadget', [20, 40], { target, record, previous });
  assert.deepEqual(frame.sharedVariables.values, { IsAutoTransact: true, AcceptLang: 'uk-UA' });
  // A user-owned table's main operation lists the table in the root collection after the write.
  assert.deepEqual(frame.mainSharedVariables.values, {
    IsAutoTransact: true,
    AcceptLang: 'uk-UA',
    ChangedEntityTypes: { gadget: 'Update' },
  });

  const ledger = { ledgerid: '20000000-0000-0000-0000-000000000009', title: 'Created' };
  frame = phases(store, 'create', 'ledger', [10, 20, 40], {
    target: { ...ledger },
    record: ledger,
    previous: null,
  });
  assert.deepEqual(frame.mainSharedVariables.values, {
    IsAutoTransact: true,
    AcceptLang: 'uk-UA',
    DefaultsAddedFlag: true,
  });
  // Association has no main-operation parent: its own PostOperation collection lists the intersect.
  const link = phases(store, 'associate', 'gadget', [10, 20, 40], {
    target: {},
    record: { gadgetid: id },
    previous: null,
    associationParameters: {},
    intersectEntity: 'gadget_peer',
  });
  assert.deepEqual(link.sharedVariables.values.ChangedEntityTypes, { gadget_peer: 'Update' });
  const read = phases(store, 'retrievemultiple', 'gadget', [10], { target: {}, record: {}, previous: null });
  assert.equal(read.sharedVariables.values.IsAutoTransact, false);
});

// @parity-evidence: no new proof; retag from the file's parity. native crud.json (both captures) shows Delete stage 10 with ConcurrencyBehavior and no FromSandbox (no SDK-issued Delete recorded); FromSandbox is recorded only for SDK Create (depth, faults, both captures)
// @test-kind unproven: FromSandbox on a Delete PreValidation is a local model; no native capture records an SDK-issued Delete; a native plug-in Delete on native and native-r2 would prove it
test('Delete carries ConcurrencyBehavior and a sandbox SDK request FromSandbox only in its PreValidation inputs', () => {
  const store = fixture(),
    record = { gadgetid: id, title: 'Before' },
    args = { target: {}, record, previous: { ...record }, sdkFromSandbox: true };
  let frame = phases(store, 'delete', 'gadget', [10], args);
  assert.deepEqual(Object.keys(frame.inputParameters.values).sort(), ['ConcurrencyBehavior', 'FromSandbox']);
  assert.deepEqual(Object.keys(frame.mainOperationInputs).sort(), ['ConcurrencyBehavior', 'FromSandbox']);
  frame = phases(store, 'delete', 'gadget', [20, 40], args);
  assert.deepEqual(frame.inputParameters.values, {});
});

test('PreOperation and PostOperation see the ObjectModel main operation with the PreValidation inputs', () => {
  const store = fixture(),
    target = { title: 'Requested' },
    record = { gadgetid: id, title: 'Requested', size: 3 },
    previous = { gadgetid: id, title: 'Before', size: 3 };
  const frame = phases(store, 'update', 'gadget', [10, 20, 40], { target, record, previous });
  // PostOperation runs inside the transaction (data.mjs sets it from PreOperation on); its ancestors report the same.
  store.pluginInTransaction = true;
  const answer = clrContext({
    runtime,
    store,
    step: step(),
    entity: 'gadget',
    operation: 'update',
    stage: 40,
    target,
    record,
    previous,
    frame,
    depth: 1,
  });
  store.pluginInTransaction = false;
  const parent = answer.context.ParentContext.values;
  assert.equal(parent.Stage, 30);
  assert.equal(parent.Mode, 0);
  assert.equal(parent.IsInTransaction, true);
  assert.equal(parent.MessageName, 'Update');
  assert.equal(parent.OwningExtension.name, 'ObjectModel Implementation');
  assert.equal(parent.ParentContext, null);
  assert.deepEqual(parent.InputParameters.values.Target.attributes, {
    title: 'Requested',
    gadgetid: { $type: 'Guid', value: id },
  });
  assert.equal(parent.InputParameters.values.ConcurrencyBehavior.$type, 'ConcurrencyBehavior');
  assert.deepEqual(parent.OutputParameters.values, {});
  assert.deepEqual(parent.SharedVariables.values.ChangedEntityTypes, { gadget: 'Update' });
  assert.equal(parent.RequestId.value, answer.context.RequestId.value);
  assert.equal(answer.context.OwningExtension.name, 'Invented step');
  // PreValidation keeps its caller's parent.
  const early = clrContext({
    runtime,
    store,
    step: step(),
    entity: 'gadget',
    operation: 'update',
    stage: 10,
    target,
    record,
    previous,
    frame: phases(store, 'update', 'gadget', [10], { target, record, previous }),
    depth: 1,
  });
  assert.equal(early.context.ParentContext, null);
});

test('an asynchronous job reports its own operation on every parent level and the primary-name image', () => {
  const store = fixture(),
    target = { title: 'Requested' },
    record = { gadgetid: id, title: 'Requested', size: 3 },
    previous = { gadgetid: id, title: 'Before', size: 3 };
  const frame = {
    ...phases(store, 'update', 'gadget', [10, 20, 40], { target, record, previous }),
    operationId: '40000000-0000-0000-0000-000000000001',
    createdOn: '2026-10-30T10:00:00.000Z',
    createdOnWire: { $type: 'DateTime', value: '2026-10-30T10:00:00.000' },
    asyncOperation: { id: '40000000-0000-0000-0000-000000000001', createdOn: '2026-10-30T10:00:00.000Z', depth: 1 },
  };
  const answer = clrContext({
    runtime,
    store,
    step: step(1),
    entity: 'gadget',
    operation: 'update',
    stage: 40,
    target,
    record,
    previous,
    frame,
    depth: 1,
  });
  assert.equal(answer.context.Mode, 1);
  assert.equal(answer.context.OwningExtension.name, null);
  assert.equal(answer.context.OperationId.value, '40000000-0000-0000-0000-000000000001');
  const parent = answer.context.ParentContext.values;
  assert.equal(parent.Mode, 1);
  assert.equal(parent.Stage, 30);
  assert.equal(parent.IsInTransaction, false);
  assert.deepEqual(parent.OwningExtension, { ...answer.context.OwningExtension });
  assert.equal(parent.OperationId.value, '40000000-0000-0000-0000-000000000001');
  assert.deepEqual(answer.postImages.AsynchronousStepPrimaryName.attributes, {
    title: 'Requested',
    gadgetid: { $type: 'Guid', value: id },
  });
  assert.deepEqual(Object.keys(answer.context.PostEntityImagesCollection.values[0].values), [
    'AsynchronousStepPrimaryName',
  ]);

  const removed = clrContext({
    runtime,
    store,
    step: step(1),
    entity: 'gadget',
    operation: 'delete',
    stage: 40,
    target: {},
    record: previous,
    previous,
    frame: {
      ...phases(store, 'delete', 'gadget', [10, 20, 40], { target: {}, record: previous, previous }),
      asyncOperation: frame.asyncOperation,
      operationId: frame.operationId,
    },
    depth: 1,
  });
  assert.deepEqual(removed.preImages.AsynchronousStepPrimaryName.attributes, {
    title: 'Before',
    gadgetid: { $type: 'Guid', value: id },
  });
  assert.deepEqual(removed.postImages, {});
});

test('a Delete main operation and its later stages execute as SYSTEM while PreValidation runs as the caller', () => {
  const store = fixture(),
    record = { gadgetid: id, title: 'Before' };
  const frame = phases(store, 'delete', 'gadget', [10, 20], { target: {}, record, previous: { ...record } });
  const at = (stage) =>
    clrContext({
      runtime,
      store,
      step: step(),
      entity: 'gadget',
      operation: 'delete',
      stage,
      target: {},
      record,
      previous: { ...record },
      frame,
      depth: 1,
    });
  assert.equal(at(10).context.UserId.value, caller);
  const later = at(20).context;
  assert.equal(later.UserId.value, system);
  assert.equal(later.InitiatingUserId.value, caller);
  assert.equal(later.ParentContext.values.UserId.value, system);
  assert.equal(later.ParentContext.values.InputParameters.values.Target.$type, 'EntityReference');
});

// @parity-evidence: native crud.json ev 1618-1621, 1600-1601, 1678-1679: the stage set fills in execution order (a step does not see later steps' images), so the set is the one runPluginPhase computed for this step (end to end in plugin-context4-images.test.mjs), not the union of the stage's registrations
test('Context4 collections hold the stage set the step sees while PreEntityImages stay the own step', () => {
  const store = fixture(),
    target = { title: 'Requested' },
    record = { gadgetid: id, title: 'Requested', size: 3 },
    previous = { gadgetid: id, title: 'Before', size: 3 };
  const frame = phases(store, 'update', 'gadget', [10, 20], { target, record, previous });
  frame.stageImages = {
    20: stageImageSet({
      stage: 20,
      steps: [{ images: [{ alias: 'other', type: 0, attributes: ['size'] }] }, { images: [{ alias: 'own', type: 0 }] }],
    }),
  };
  const answer = clrContext({
    runtime,
    store,
    step: step(0, [{ alias: 'own', type: 0 }]),
    entity: 'gadget',
    operation: 'update',
    stage: 20,
    target,
    record,
    previous,
    frame,
    depth: 1,
  });
  assert.deepEqual(Object.keys(answer.preImages), ['own']);
  assert.deepEqual(Object.keys(answer.context.PreEntityImagesCollection.values[0].values), ['other', 'own']);
  assert.deepEqual(answer.context.PreEntityImagesCollection.values[0].values.other.attributes, { size: 3 });
  assert.deepEqual(answer.context.PostEntityImagesCollection.values, []);
});

// @parity-evidence: no new proof; retag from the file's parity. native reads.json (both captures) shows an outside-plug-in RetrieveMultiple with an empty AppModuleId and IsAppModuleContext and IncludeAnnotations false; no capture shows a read issued from inside a plug-in (readNested.json has no depth 2+ RetrieveMultiple)
// @test-kind unproven: the nested-read input set (Query only) is a local model; a native read issued from inside a plug-in step on native and native-r2 would prove it
test('Create PreOperation collections carry the telemetry root and reads outside a plug-in carry client inputs', () => {
  const store = fixture(),
    ledger = { ledgerid: '20000000-0000-0000-0000-000000000009', title: 'Created' };
  const frame = phases(store, 'create', 'ledger', [10, 20], { target: { ...ledger }, record: ledger, previous: null });
  const created = clrContext({
    runtime,
    store,
    step: step(),
    entity: 'ledger',
    operation: 'create',
    stage: 20,
    target: { ...ledger },
    record: ledger,
    previous: null,
    frame,
    depth: 1,
  });
  const telemetry = JSON.parse(created.sharedVariables.values.telemetryrootcontext);
  assert.equal(telemetry.serviceRequestId, created.context.RequestId.value);
  assert.equal(telemetry.clientCorrelation.organizationId, caller);
  assert.equal(created.sharedVariables.values.DefaultsAddedFlag, true);

  const query = { $type: 'QueryExpression', entityName: 'gadget' };
  const read = (parentContext) => {
    store.pluginParentContext = parentContext;
    try {
      return clrContext({
        runtime,
        store,
        step: step(),
        entity: 'gadget',
        operation: 'retrievemultiple',
        stage: 20,
        target: {},
        record: {},
        previous: null,
        frame: { query },
        depth: 1,
      }).inputParameters.values;
    } finally {
      delete store.pluginParentContext;
    }
  };
  const outside = read(null);
  assert.deepEqual(outside.AppModuleId, { $type: 'Guid', value: empty });
  assert.equal(outside.IsAppModuleContext, false);
  assert.equal(outside.IncludeAnnotations, false);
  const nested = read({ $type: 'ExecutionContext', values: { Depth: 1, RequestId: { $type: 'Guid', value: id } } });
  assert.deepEqual(Object.keys(nested), ['Query']);
});
