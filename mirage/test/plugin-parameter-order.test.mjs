// @test-kind parity: native and native-r2 recorder corpora (crud, bulk, reads, relationsReads, associate, customApi, sdkMerge, sdkSurface): InputParameters and SharedVariables enumerate in the same order in both captures (request parameters, tag, FromSandbox, platform parameters; IsAutoTransact, AcceptLang, tag, DefaultsAddedFlag)
// The enumeration order of the parameter collections a CLR plug-in sees. Invented values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';

const user = '10000000-0000-0000-0000-000000000001',
  id = '20000000-0000-0000-0000-000000000001';
const keys = (values) => Object.keys(values).join(',');
const of = (list) => Object.fromEntries(list.split(',').map((key) => [key, `value of ${key}`]));
const storeOf = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        gadget: { entitySet: 'gadgets', idColumn: 'gadgetid', fields: { title: { dataverseType: 'nvarchar' } } },
      },
      tables: { gadget: [{ gadgetid: id, title: 'Kept' }] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const runtime = {
  descriptor: {
    context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    serviceProfile: { userId: user, evidence: 'Invented order', grants: [] },
  },
};
// The CLR context of a Create PreOperation step whose frame already holds the given inputs and shared variables.
const context = ({ operation = 'create', inputs = '', shared = '', requestTag, bridged = false } = {}) =>
  clrContext({
    runtime,
    store: storeOf(),
    step: { id: '30000000-0000-0000-0000-000000000001', images: [], contract: { mode: 0 } },
    entity: 'gadget',
    operation,
    stage: 20,
    target: { title: 'New' },
    record: { gadgetid: id, title: 'New' },
    previous: operation === 'update' ? { gadgetid: id, title: 'Kept' } : null,
    frame: {
      ...(requestTag ? { requestTag } : {}),
      ...(inputs ? { inputParameters: { $type: 'ParameterCollection', values: of(inputs) } } : {}),
      ...(shared ? { sharedVariables: { $type: 'ParameterCollection', values: of(shared) } } : {}),
    },
    depth: 1,
    bridged,
  });

test('input parameters enumerate as the native request fills them', () => {
  for (const [local, native] of [
    ['tag,Target', 'Target,tag'],
    ['tag,FromSandbox,Target', 'Target,tag,FromSandbox'],
    ['tag,ConcurrencyBehavior,Target', 'Target,tag,ConcurrencyBehavior'],
    ['tag,ConcurrencyBehavior,FromSandbox,Target', 'Target,tag,FromSandbox,ConcurrencyBehavior'],
    ['tag,Target,Relationship,RelatedEntities', 'Target,Relationship,RelatedEntities,tag'],
    ['tag,Text,Target', 'Text,Target,tag'],
    [
      'tag,Target,SubordinateId,UpdateContent,PerformParentingChecks',
      'Target,SubordinateId,PerformParentingChecks,tag,UpdateContent',
    ],
    ['tag,AppModuleId,IsAppModuleContext,Target', 'Target,tag,AppModuleId,IsAppModuleContext'],
    [
      'tag,IncludeAnnotations,ReturnNotifications,Target,ColumnSet,RelatedEntitiesQuery',
      'Target,ColumnSet,RelatedEntitiesQuery,tag,IncludeAnnotations,ReturnNotifications',
    ],
    // A plug-in's SDK Retrieve: the platform adds RelatedEntitiesQuery after the tag.
    ['tag,Target,ColumnSet,RelatedEntitiesQuery,FromSandbox', 'Target,ColumnSet,tag,FromSandbox,RelatedEntitiesQuery'],
    ['tag,Target,Assignee,FromSandbox', 'Target,Assignee,tag,FromSandbox'],
  ])
    assert.equal(keys(context({ inputs: local }).inputParameters.values), native, local);
});

test('shared variables start with the platform entries, the tag and DefaultsAddedFlag', () => {
  for (const [local, native] of [
    [
      'IsAutoTransact,AcceptLang,DefaultsAddedFlag,tag,telemetryrootcontext',
      'IsAutoTransact,AcceptLang,tag,DefaultsAddedFlag,telemetryrootcontext',
    ],
    ['AcceptLang,IsAutoTransact,tag', 'IsAutoTransact,AcceptLang,tag'],
    ['DefaultsAddedFlag,tag,telemetryrootcontext', 'tag,DefaultsAddedFlag,telemetryrootcontext'],
    [
      'IsAutoTransact,AcceptLang,tag,step.key,ChangedEntityTypes',
      'IsAutoTransact,AcceptLang,tag,step.key,ChangedEntityTypes',
    ],
  ])
    // A Create PreOperation context may add platform entries after these (telemetryrootcontext).
    assert(keys(context({ shared: local }).sharedVariables.values).startsWith(native), local);
});

test('a CLR Create context names its Target before the request tag; a bridged Update names Targets last', () => {
  assert.equal(keys(context({ requestTag: 'Invented tag' }).inputParameters.values), 'Target,tag');
  assert.match(
    keys(context({ operation: 'update', requestTag: 'Invented tag', bridged: true }).inputParameters.values),
    /^tag(,ConcurrencyBehavior)?,Targets$/,
  );
});
