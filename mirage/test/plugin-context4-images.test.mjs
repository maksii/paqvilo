// @test-kind parity: native dev-environment recorder corpus 2026-10-30 (crud, bulk, ownerAndState, sdkMessages), reproduced over repeated requests in each capture: IPluginExecutionContext4 image sets fill in execution order across a request's lanes
// An original CLR observer logs the Context4 image collections every step sees, end to end through the pipeline
// (no hand-seeded frame): stage sets shared by a single-record request and its *Multiple lane, PostOperation seeded with
// the PreOperation images and PreBusinessEntity, asynchronous snapshots at their rank slot, the platform's primary-name
// image and bulk-origin per-target sets.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { dispatchSdkCall, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { primaryNameSide } from '../lib/plugin-images.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const uuid = (prefix, n) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const caller = uuid(1, 1),
  other = uuid(1, 2),
  system = uuid(1, 3),
  unitA = uuid(4, 1),
  unitB = uuid(4, 2),
  id = uuid(2, 1),
  second = uuid(2, 2);
const ASPN = 'AsynchronousStepPrimaryName',
  PBE = 'PreBusinessEntity';

// @parity-evidence: native recorder corpus crud, bulk, ownerAndState and sdkMessages (native and native-r2), as the file tag; only the observer scratch folder moves to a private mkdtemp directory (CodeQL js/insecure-temporary-file), no assertion changed
let prepared, root, log;
after(() => root && fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
// @parity-evidence: native imageAliasOrder (native and native-r2): AsynchronousStepPrimaryName attributes enumerate name then key; the observer also logs those attribute names (no existing assertion changed)
// @parity-evidence: native crud.json ev 1648/1653 (repeated at 1658, imagesOrder 7680/7686): an asynchronous single-origin *Multiple step's own AsynchronousStepPrimaryName names the target row; the observer now also logs that image's id (no existing assertion changed)
// One original assembly whose Observer logs, per execution: step id, message, stage, mode, the Context4 collections
// (sets joined by '/', aliases in collection order), its own image aliases, the main-operation parent's pre set, the
// PreBusinessEntity attributes and the owner of each own image.
async function observer() {
  prepared ??= (async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-context4-'));
    log = path.join(root, 'seen.txt');
    const source = path.join(root, 'Observer.cs');
    await fs.writeFile(
      source,
      `using System;using System.IO;using System.Linq;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Observer:IPlugin{
static string Keys(EntityImageCollection[] sets){return string.Join("/",sets.Select(s=>string.Join(",",s.Keys)));}
static string Owners(EntityImageCollection images){return string.Join(",",images.Select(i=>i.Key+":"+(i.Value.Contains("ownerid")?((EntityReference)i.Value["ownerid"]).Id.ToString():"-")));}
public void Execute(IServiceProvider p){var c=(IPluginExecutionContext4)p.GetService(typeof(IPluginExecutionContext));string parent;try{var pc=c.ParentContext as IPluginExecutionContext4;parent=pc==null?"none":pc.MessageName+"/"+pc.Stage+":"+Keys(pc.PreEntityImagesCollection);}catch(Exception){parent="unavailable";}
var business=c.PreEntityImagesCollection.FirstOrDefault(s=>s.Contains("${PBE}"));
File.AppendAllText(@"${log.replaceAll('"', '""')}",string.Join("|",c.OwningExtension.Id,c.MessageName,c.Stage,c.Mode,Keys(c.PreEntityImagesCollection),Keys(c.PostEntityImagesCollection),string.Join(",",c.PreEntityImages.Keys)+";"+string.Join(",",c.PostEntityImages.Keys),parent,business==null?"-":string.Join(",",business["${PBE}"].Attributes.Keys),Owners(c.PreEntityImages)+";"+Owners(c.PostEntityImages),c.PostEntityImages.Contains("${ASPN}")?c.PostEntityImages["${ASPN}"].Id.ToString():"-",c.PostEntityImages.Contains("${ASPN}")?string.Join(",",c.PostEntityImages["${ASPN}"].Attributes.Keys):"-")+Environment.NewLine);}}}`,
    );
    const sdk = clrSdk();
    compileClr(source, path.join(root, 'Observer.dll'), { references: [sdk] });
    return prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Observer.dll',
      typeName: 'Invented.Observer',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: caller, evidence: 'Invented Context4 observer', grants: [] },
      context: { initiatingUserId: caller, organizationId: caller, businessUnitId: unitA },
    });
  })();
  return prepared;
}
const profile = {
  userId: caller,
  evidence: 'Invented Context4 requests',
  grants: [{ entity: 'gadget', operations: ['read', 'create', 'update', 'delete'] }],
  bulkTables: [
    { entity: 'gadget', tableType: 'standard', evidence: 'Invented bulk table', messages: ['CreateMultiple'] },
  ],
};
function storeOf() {
  const state = emptyState();
  state.mappings.gadget = {
    entitySet: 'gadgets',
    idColumn: 'gadgetid',
    nameColumn: 'title',
    ownership: 'UserOwned',
    fields: {
      title: { dataverseType: 'nvarchar' },
      size: { dataverseType: 'int' },
      statecode: { dataverseType: 'state' },
      statuscode: { dataverseType: 'status' },
    },
  };
  state.tables.gadget = [{ gadgetid: id, title: 'Before', size: 3, statecode: 0, statuscode: 1 }];
  return new DataStore({ state, clock: fixedClock() });
}
const step = (n, message, stage, rank, { mode = 0, images = [] } = {}) => ({
  id: uuid(3, n),
  name: `Invented observer ${n}`,
  enabled: true,
  entity: 'gadget',
  message,
  stage,
  rank,
  mode,
  supportedDeployment: 0,
  assemblyId: 'invented',
  typeName: 'Invented.Observer',
  filteringAttributes: [],
  images,
});
// Runs `act` against a backend whose every registration is the observer; answers the logged executions by step number.
async function observe(t, steps, act, store = storeOf()) {
  const runtime = await observer();
  await fs.writeFile(log, '');
  const scheduler = createScheduler({ clock: store.clock, manual: true }),
    runtimes = new Map(steps.map((entry) => [entry.id, runtime])),
    descriptors = new Map(steps.map((entry) => [entry.id, runtime.descriptor])),
    items = pluginCatalogue({
      plugins: { steps },
      runtimes,
      descriptors,
      overrides: Object.fromEntries(steps.map((entry) => ['plugin-step:' + entry.id, { mode: 'clr' }])),
    });
  const backend = await createOrganizationBackend({ store, items: () => items, runtimes, descriptors, scheduler });
  t.after(() => backend.close());
  await act(store);
  await scheduler.runDue();
  await backend.asyncPluginRunner.drain();
  const seen = {};
  for (const line of (await fs.readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean)) {
    const [stepId, message, stage, mode, pre, post, own, parent, business, owners, named, nameAttributes] =
      line.split('|');
    const n = Number(stepId.slice(-12));
    (seen[n] ??= []).push({
      message,
      stage: Number(stage),
      mode: Number(mode),
      pre,
      post,
      own,
      parent,
      business,
      owners,
      named,
      nameAttributes,
    });
  }
  return seen;
}
const identity = { admin: true, systemUserId: caller };

test(
  'an Update request and its UpdateMultiple lane share stage sets filled in execution order, with asynchronous snapshots',
  { skip: CLR_SKIP },
  async (t) => {
    const seen = await observe(
      t,
      [
        step(1, 'Update', 10, 1, { images: [{ alias: 'early', type: 0 }] }),
        step(2, 'Update', 20, 1, { images: [{ alias: 'pre', type: 0, attributes: ['title'] }] }),
        step(3, 'Update', 20, 2),
        step(4, 'UpdateMultiple', 20, 3),
        step(5, 'Update', 40, 1, {
          mode: 1,
          images: [
            { alias: 'pre', type: 0 },
            { alias: 'post', type: 1 },
          ],
        }),
        step(6, 'Update', 40, 2),
        step(7, 'Update', 40, 3, { images: [{ alias: 'both', type: 2, attributes: ['title'] }] }),
        step(8, 'Update', 40, 4, { mode: 1 }),
        step(11, 'UpdateMultiple', 40, 4, { mode: 1 }),
        step(9, 'Update', 40, 5),
        step(10, 'UpdateMultiple', 40, 6),
      ],
      (store) => store.update('gadget', id, { title: 'After' }, identity),
    );
    // PreValidation and PreOperation start empty; an imageless step sees the images of the steps before it, also across
    // the single and multiple lanes (native crud ev 1607, 1611-1617, 1612; C40).
    assert.equal(seen[1][0].pre, 'early');
    assert.deepEqual([seen[3][0].pre, seen[3][0].post], ['pre', '']);
    assert.deepEqual([seen[4][0].pre, seen[4][0].post], ['pre', '']);
    // The main operation (stage 30) holds the PreValidation set plus PreBusinessEntity (native crud Update/30, ev 1610).
    assert.equal(seen[3][0].parent, `Update/30:early,${PBE}`);
    // PostOperation starts from the PreOperation set plus PreBusinessEntity; a step sees the asynchronous step queued
    // before it, with the primary-name image, but not the steps after it (native crud ev 1618-1622; C43).
    assert.deepEqual([seen[6][0].pre, seen[6][0].post], [`pre,${PBE}`, `post,${ASPN}`]);
    for (const n of [7, 9, 10])
      assert.deepEqual([seen[n][0].pre, seen[n][0].post], [`pre,${PBE},both`, `post,${ASPN},both`], `step ${n}`);
    // Asynchronous jobs carry the set as it stood when they were queued (native crud ev 1647 vs 1650; C42).
    assert.deepEqual([seen[5][0].mode, seen[5][0].pre, seen[5][0].post], [1, `pre,${PBE}`, `post,${ASPN}`]);
    assert.equal(seen[5][0].own, `pre;post,${ASPN}`);
    assert.deepEqual([seen[8][0].pre, seen[8][0].post], [`pre,${PBE},both`, `post,${ASPN},both`]);
    // The asynchronous UpdateMultiple lane shares the set and names its target row (native crud ev 1653).
    assert.deepEqual([seen[11][0].pre, seen[11][0].post], [`pre,${PBE},both`, `post,${ASPN},both`]);
    assert.deepEqual([seen[11][0].own, seen[11][0].named], [`;${ASPN}`, id]);
  },
);

test(
  'Delete puts the primary-name image first in its pre-image set and Create adds it when the first asynchronous step is queued',
  { skip: CLR_SKIP },
  async (t) => {
    const removed = await observe(
      t,
      [
        step(1, 'Delete', 40, 1, { images: [{ alias: 'pre', type: 0 }] }),
        step(2, 'Delete', 40, 2, { mode: 1 }),
        step(3, 'Delete', 40, 3),
      ],
      (store) => store.remove('gadget', id, identity),
    );
    // Native crud ev 1678/1679/1683: [AsynchronousStepPrimaryName, pre] in that order, nothing on the post side.
    for (const n of [1, 2, 3]) assert.deepEqual([removed[n][0].pre, removed[n][0].post], [`${ASPN},pre`, ''], `${n}`);
    assert.equal(removed[2][0].own, `${ASPN};`);
    const created = await observe(
      t,
      [
        step(1, 'Create', 40, 1, { images: [{ alias: 'post', type: 1 }] }),
        step(2, 'Create', 40, 2, { mode: 1 }),
        step(3, 'Create', 40, 3),
      ],
      (store) => store.create('gadget', { gadgetid: second, title: 'Created' }, identity),
    );
    // Native crud ev 1600, 1601, 1646.
    assert.deepEqual([created[1][0].pre, created[1][0].post], ['', 'post']);
    assert.deepEqual([created[3][0].pre, created[3][0].post], ['', `post,${ASPN}`]);
    assert.deepEqual([created[2][0].pre, created[2][0].post], ['', `post,${ASPN}`]);
  },
);

test(
  'a bulk-origin CreateMultiple has per-target sets only for platform images and its delegated asynchronous jobs have none',
  { skip: CLR_SKIP },
  async (t) => {
    const seen = await observe(
      t,
      [
        step(1, 'CreateMultiple', 20, 1),
        step(2, 'CreateMultiple', 40, 1, { mode: 1 }),
        step(3, 'CreateMultiple', 40, 2),
        step(4, 'Create', 40, 1, { mode: 1, images: [{ alias: 'post', type: 1 }] }),
      ],
      // A committed request queues its asynchronous jobs.
      (store) =>
        store.transact(() =>
          localOrganizationService(store, profile).bulk(
            'createmultiple',
            [uuid(2, 7), uuid(2, 8)].map((value, index) => ({
              $type: 'Entity',
              logicalName: 'gadget',
              id: value,
              attributes: { title: `Bulk ${index}` },
            })),
          ),
        ),
    );
    // Native bulk ev 1376 (PreOperation [] / []), 1379 and 1407 (one primary-name set per target).
    assert.deepEqual([seen[1][0].pre, seen[1][0].post], ['', '']);
    assert.deepEqual([seen[3][0].pre, seen[3][0].post], ['', `${ASPN}/${ASPN}`]);
    assert.deepEqual([seen[2][0].pre, seen[2][0].post], ['', `${ASPN}/${ASPN}`]);
    // Native bulk ev 1412/1441: a delegated record's asynchronous job keeps its own images, no Context4 set.
    assert.equal(seen[4].length, 2);
    for (const entry of seen[4]) assert.deepEqual([entry.pre, entry.post, entry.own], ['', '', `;post,${ASPN}`]);
  },
);

test(
  'SetStateDynamicEntity gets the primary-name image and a state-changing Update an empty PreBusinessEntity',
  { skip: CLR_SKIP },
  async (t) => {
    const seen = await observe(
      t,
      [
        step(1, 'SetStateDynamicEntity', 40, 1, { mode: 1 }),
        step(2, 'SetStateDynamicEntity', 40, 2),
        step(3, 'Update', 40, 1),
      ],
      (store) => store.update('gadget', id, { statecode: 1, statuscode: 2 }, identity),
    );
    // Native ownerAndState ev 1084/1117/1099, sdkMessages ev 1540: the post side holds the primary-name image.
    assert.deepEqual([seen[2][0].pre, seen[2][0].post], ['', ASPN]);
    assert.equal(seen[1][0].own, `;${ASPN}`);
    // Native ownerAndState ev 1085, sdkMessages ev 1536: PreBusinessEntity is present with no attributes.
    assert.deepEqual([seen[3][0].pre, seen[3][0].business], [PBE, '']);
  },
);

// An SDK Assign of the gadget to the second user, committed (its asynchronous jobs queue).
const assign = (store) => {
  store.state.tables.systemuser = [
    { systemuserid: caller, fullname: 'Invented caller' },
    { systemuserid: other, fullname: 'Invented assignee' },
    { systemuserid: system, fullname: 'SYSTEM' },
  ];
  return store.transact(() =>
    dispatchSdkCall({
      store,
      profile,
      message: {
        method: 'Execute',
        userId: caller,
        arguments: [
          {
            $type: 'OrganizationRequest',
            requestName: 'Assign',
            parameters: {
              $type: 'ParameterCollection',
              values: {
                Target: { $type: 'EntityReference', logicalName: 'gadget', id, name: null },
                Assignee: { $type: 'EntityReference', logicalName: 'systemuser', id: other, name: null },
              },
            },
          },
        ],
      },
    }),
  );
};

// @test-kind observation: native sdkMessages capture 2026-10-30 (Assign ev 1526: pre-side primary-name image), one capture
test('an SDK Assign gets the primary-name image on its pre-image side', { skip: CLR_SKIP }, async (t) => {
  const store = storeOf();
  const seen = await observe(t, [step(1, 'Assign', 40, 1, { mode: 1 }), step(2, 'Assign', 40, 2)], assign, store);
  assert.deepEqual([seen[2][0].pre, seen[2][0].post], [ASPN, '']);
  assert.equal(seen[1][0].own, `${ASPN};`);
});

// @test-kind compatibility: Microsoft Learn "Messages that support entity images" (Assign Target: pre and post images); no native runtime capture of an image-bearing Assign step
test('registered Assign images hold the row before and after the owner change', { skip: CLR_SKIP }, async (t) => {
  const store = storeOf();
  store.state.tables.gadget[0].ownerid = { id: caller, logical_name: 'systemuser' };
  const seen = await observe(
    t,
    [
      step(1, 'Assign', 40, 1, {
        images: [
          { alias: 'before', type: 0 },
          { alias: 'after', type: 1 },
        ],
      }),
    ],
    assign,
    store,
  );
  assert.equal(seen[1][0].owners, `before:${caller};after:${other}`);
});

// @test-kind observation: native crud, bulk, ownerAndState and sdkMessages captures 2026-10-30: PreBusinessEntity holds the pre-operation statecode unless the request changes it; the other columns it sometimes carries (crud: a text column) follow no rule the captures establish
test('PreBusinessEntity holds the statecode the request does not change', { skip: CLR_SKIP }, async (t) => {
  const seen = await observe(t, [step(1, 'Update', 40, 1)], (store) =>
    store.update('gadget', id, { size: 4 }, identity),
  );
  assert.equal(seen[1][0].business, 'statecode');
});

// @test-kind parity: native ownerAndState capture 2026-10-30 (Web API ownerid bind: Update/20 and /40 Targets add the new owner's owningbusinessunit, the saved row's modifiedonbehalfby is the caller) and sdkMessages (Assign's Update Target: owninguser, owningbusinessunit, modifiedonbehalfby = caller), each reproduced over its Update stages
test('an owner change adds the owner columns to the Update Target and saves the caller as modifiedonbehalfby', () => {
  const store = new DataStore({
    state: {
      ...emptyState(),
      mappings: {
        gadget: { entitySet: 'gadgets', idColumn: 'gadgetid', nameColumn: 'title', ownership: 'UserOwned' },
      },
      tables: {
        gadget: [
          {
            gadgetid: id,
            title: 'Before',
            ownerid: { id: caller, logical_name: 'systemuser' },
            owninguser: { id: caller, logical_name: 'systemuser' },
            owningbusinessunit: { id: unitA, logical_name: 'businessunit' },
            modifiedonbehalfby: null,
          },
        ],
      },
    },
  });
  const targets = [];
  store.setPluginPipeline(
    ({ operation, stage, target }) => {
      if (operation === 'update') targets.push([stage, structuredClone(target)]);
    },
    () => true,
  );
  // The Dataverse layer's system columns derive the owner trio from ownerid (dataverse-security.mjs systemColumns).
  const owner = {
    ownerid: { id: other, logical_name: 'systemuser' },
    owninguser: { id: other, logical_name: 'systemuser' },
    owningteam: null,
    owningbusinessunit: { id: unitB, logical_name: 'businessunit' },
    modifiedby: { id: caller, logical_name: 'systemuser' },
    modifiedonbehalfby: null,
  };
  store.updateRecord('gadget', id, { ownerid: owner.ownerid }, identity, { systemColumns: owner });
  const [, preValidation] = targets.find(([stage]) => stage === 10);
  assert.equal(Object.hasOwn(preValidation, 'owningbusinessunit'), false);
  for (const [stage, target] of targets.filter(([value]) => value !== 10)) {
    assert.deepEqual(target.owningbusinessunit, owner.owningbusinessunit, `stage ${stage}`);
    assert.equal(Object.hasOwn(target, 'owninguser'), false);
    assert.equal(target.modifiedonbehalfby, null);
  }
  assert.deepEqual(store.tableRows('gadget')[0].modifiedonbehalfby, owner.modifiedby);

  // The Assign main operation's Update (skipPreValidation, assignOwner): owning user and on-behalf caller in the Target.
  targets.length = 0;
  store.updateRecord('gadget', id, { ownerid: { id: caller, logical_name: 'systemuser' } }, identity, {
    skipPreValidation: true,
    assignOwner: true,
    systemColumns: {
      ...owner,
      ownerid: { id: caller, logical_name: 'systemuser' },
      owninguser: { id: caller, logical_name: 'systemuser' },
      owningbusinessunit: { id: unitA, logical_name: 'businessunit' },
    },
  });
  for (const [, target] of targets) {
    assert.deepEqual(target.owninguser, { id: caller, logical_name: 'systemuser' });
    assert.deepEqual(target.owningbusinessunit, { id: unitA, logical_name: 'businessunit' });
    assert.deepEqual(target.modifiedonbehalfby, owner.modifiedby);
  }
  // A write that does not maintain the owner columns gets none in its Target.
  targets.length = 0;
  store.updateRecord('gadget', id, { ownerid: { id: other, logical_name: 'systemuser' } }, identity);
  assert.ok(targets.every(([, target]) => !Object.hasOwn(target, 'owningbusinessunit')));
});

// @test-kind parity: native imageAliasOrder captures 2026-10-30/31 (native and native-r2, reproduced): a step's images enumerate in registration order (z, m), the stage set appends them after earlier entries, and AsynchronousStepPrimaryName lists the primary name before the key
test(
  'images keep their registration order and the primary-name image names before its key',
  { skip: CLR_SKIP },
  async (t) => {
    const seen = await observe(
      t,
      [
        step(1, 'Update', 40, 1, {
          images: [
            { alias: 'z', type: 0 },
            { alias: 'a', type: 1 },
            { alias: 'm', type: 0, attributes: ['title'] },
          ],
        }),
        step(2, 'Update', 40, 2, { mode: 1 }),
      ],
      (store) => store.update('gadget', id, { title: 'Ordered' }, identity),
    );
    assert.deepEqual([seen[1][0].own, seen[1][0].pre], ['z,m;a', `${PBE},z,m`]);
    assert.equal(seen[2][0].nameAttributes, 'title,gadgetid');
  },
);

// @test-kind parity: native recorder captures 2026-10-30/31 (native and native-r2): the primary-name image joins the pre side for Delete, DeleteMultiple and Assign (crud, sdkMessages, imagesOrder) and the post side for the other row messages, Merge included (mergeAccount); none for RetrieveMultiple, Associate, Disassociate, custom APIs
test('the primary-name image side follows the message', () => {
  for (const message of ['delete', 'deletemultiple', 'assign']) assert.equal(primaryNameSide(message), 'pre', message);
  for (const message of [
    'create',
    'update',
    'createmultiple',
    'updatemultiple',
    'setstatedynamicentity',
    'grantaccess',
    'retrieve',
    'merge',
  ])
    assert.equal(primaryNameSide(message), 'post', message);
  for (const message of ['retrievemultiple', 'associate', 'disassociate', 'new_inventedapi'])
    assert.equal(primaryNameSide(message), null, message);
});
