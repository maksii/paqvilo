// @test-kind unproven: local model of the merged single/multiple pipeline (rank order, duplicates, parents, async grouping); Learn documents only the merge
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { prepareClrRuntime, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const user = '10000000-0000-0000-0000-000000000001';
const id = '20000000-0000-0000-0000-000000000001';
const empty = '00000000-0000-0000-0000-000000000000';
const step = (message, stage = 20, rank = 1, index = 1) => ({
  id: `30000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.BulkGuard',
  assemblyId: 'invented',
});
async function fixture(t, steps, handlers = new Map(), overrides = {}, runtimes = new Map()) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_keep: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: id, x_name: 'Existing', x_keep: 'Keep' }] },
    extension: { name: 'bulk-http-probe', install: () => {} },
  });
  const items = pluginCatalogue({ plugins: { steps }, handlers, overrides, runtimes });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    handlers,
    runtimes,
    descriptors: new Map([...runtimes].map(([key, runtime]) => [key, runtime.descriptor])),
  });
  t.after(() => backend.close());
  return { ...f, items, backend };
}

// @test-kind compatibility: Learn CreateMultiple/UpdateMultiple Web API actions: grouped plug-in handling and atomic rollback on a refusal
test('HTTP bulk requests execute grouped handlers, persist their patches and roll back a grouped refusal', async (t) => {
  const create = step('CreateMultiple'),
    update = step('UpdateMultiple', 20, 1, 2),
    post = step('CreateMultiple', 40, 1, 3);
  let rejectPost = false;
  const seen = [],
    handlers = new Map([
      [
        create.id,
        (c) => {
          seen.push(['create', c.targets.length]);
          return {
            targets: c.targets.map((target) => ({
              ...target,
              attributes: { ...target.attributes, x_name: 'Normalized' },
            })),
          };
        },
      ],
      [
        update.id,
        (c) => {
          seen.push(['update', c.previousRecords[0].x_name]);
          c.reject('Grouped update refused');
        },
      ],
      [
        post.id,
        (c) => {
          if (rejectPost) c.reject('Grouped post refused');
        },
      ],
    ]);
  const f = await fixture(t, [create, update, post], handlers);
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    Targets: [{ x_name: 'One' }, { x_name: 'Two' }],
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).Ids.length, 2);
  assert.deepEqual(seen, [['create', 2]]);
  assert.deepEqual(
    f.store
      .tableRows('x_item')
      .slice(1)
      .map((row) => row.x_name),
    ['Normalized', 'Normalized'],
  );
  const failed = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
    Targets: [{ x_itemid: id, x_name: 'Changed' }],
  });
  assert.equal(failed.status, 400);
  assert.equal(f.store.tableRows('x_item')[0].x_name, 'Existing');
  rejectPost = true;
  const count = f.store.tableRows('x_item').length;
  assert.equal(
    (
      await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
        Targets: [{ x_name: 'Rolled back' }],
      })
    ).status,
    400,
  );
  assert.equal(f.store.tableRows('x_item').length, count);
});

test(
  'ranked CLR single steps retain PreValidation state and final synchronous state reaches one async run per bulk target',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-bulk-phases-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Phases.cs'),
      assembly = path.join(root, 'Phases.dll');
    // Native recorder corpus bulk: a record's PreOperation step sees the CreateMultiple/20 context (the bulk step's
    // stage-20 collection) as its parent, not the record's own PreValidation collection.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;
namespace Invented {
public sealed class Seed:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));c.SharedVariables["ranked"]="kept";}}
public sealed class Check:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["ranked"]!="kept")throw new Exception("Ranked PreValidation state lost");}}
public sealed class Pre:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));if(c.ParentContext.MessageName!="CreateMultiple"||c.ParentContext.Stage!=20||(string)c.ParentContext.SharedVariables["bulk"]!="kept")throw new Exception("Bulk stage parent state lost");c.SharedVariables["pre"]="kept";}}
public sealed class Post:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["pre"]!="kept")throw new Exception("PreOperation state lost");c.SharedVariables["post"]="kept";}}
public sealed class Async:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));if((string)c.SharedVariables["post"]!="kept")throw new Exception("Final synchronous state lost");var svc=((IOrganizationServiceFactory)s.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var row=new Entity("x_item",c.PrimaryEntityId);row["x_keep"]="Async exact frame";svc.Update(row);}}
public sealed class BulkPre:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));c.SharedVariables["bulk"]="kept";}}
public sealed class BulkAsync:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext4)s.GetService(typeof(IPluginExecutionContext));if(c.Mode!=1||c.IsInTransaction||(string)c.SharedVariables["bulk"]!="kept")throw new Exception("Grouped async frame lost");var targets=(EntityCollection)c.InputParameters["Targets"];if(targets.Entities.Count!=2||((Guid[])c.OutputParameters["Ids"]).Length!=2||c.PreEntityImagesCollection.Length!=0||c.PostEntityImagesCollection.Length!=2)throw new Exception("Grouped Context4 alignment lost");for(int i=0;i<2;i++){if(c.PostEntityImagesCollection[i]["after"].GetAttributeValue<string>("x_name")!=(i==0?"A":"B"))throw new Exception("Grouped post image lost");}}}
}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const base = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Phases.dll',
      typeName: 'Invented.Seed',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: {
        userId: user,
        evidence: 'Invented merged bulk async contract',
        grants: [{ entity: 'x_item', operations: ['read', 'update'] }],
      },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: 30000,
    });
    const specs = [
      ['Seed', 10, 1, 0],
      ['Check', 10, 2, 0],
      ['Pre', 20, 1, 0],
      ['Post', 40, 1, 0],
      ['Async', 40, 2, 1],
      ['BulkPre', 20, 1, 0, 'CreateMultiple'],
      ['BulkAsync', 40, 2, 1, 'CreateMultiple'],
    ];
    const steps = specs.map(([name, stage, rank, mode, message = 'Create'], i) => ({
      ...step(message, stage, rank, i + 1),
      typeName: `Invented.${name}`,
      assemblyName: 'Phases',
      mode,
      ...(name === 'BulkAsync' ? { images: [{ name: 'after', alias: 'after', type: 1, attributes: ['x_name'] }] } : {}),
    }));
    const runtimes = new Map(steps.map((s) => [s.id, retypeClrRuntime(base, { typeName: s.typeName })]));
    const f = await fixture(
      t,
      steps,
      new Map(),
      Object.fromEntries(steps.map((s) => [`plugin-step:${s.id}`, { mode: 'clr' }])),
      runtimes,
    );
    const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
      Targets: [{ x_itemid: 'ABCDEF00-0000-0000-0000-000000000003', x_name: 'A' }, { x_name: 'B' }],
    });
    assert.equal(response.status, 200, await response.text());
    await f.backend.settle();
    const rows = f.store.tableRows('x_item').filter((row) => ['A', 'B'].includes(row.x_name));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.x_keep === 'Async exact frame'));
    const jobs = f.store.tableRows('asyncoperation').filter((row) => row.messagename === 'Create');
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((row) => row.statuscode === 30));
    const grouped = f.store.tableRows('asyncoperation').filter((row) => row.messagename === 'CreateMultiple');
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].statuscode, 30, grouped[0].message);
  },
);

test('bulk runs multiple-message ranks before single-message ranks in each stage and never executes singles twice', async (t) => {
  const steps = [
    step('Create', 10, 2, 1),
    step('CreateMultiple', 10, 1, 2),
    step('Create', 20, 1, 3),
    step('CreateMultiple', 20, 2, 4),
    step('CreateMultiple', 40, 1, 5),
    step('Create', 40, 2, 6),
  ];
  const seen = [],
    handlers = new Map(
      steps.map((s) => [
        s.id,
        (c) => {
          seen.push(`${c.stage}:${c.operation}:${c.target?.x_name ?? c.targets.length}`);
          if (c.operation === 'create' && c.stage === 20) return { target: { x_keep: 'From single' } };
          if (c.operation === 'createmultiple' && c.stage === 20)
            assert.ok(c.targets.every((target) => target.attributes.x_keep === undefined));
          if (c.operation === 'create' && c.stage === 40) assert.equal(c.record.x_keep, 'From single');
        },
      ]),
    );
  const f = await fixture(t, steps, handlers);
  assert.equal(
    (
      await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
        Targets: [{ x_name: 'A' }, { x_name: 'B' }],
      })
    ).status,
    200,
  );
  assert.deepEqual(seen, [
    '10:createmultiple:2',
    '10:create:A',
    '10:create:B',
    '20:createmultiple:2',
    '20:create:A',
    '20:create:B',
    '40:createmultiple:2',
    '40:create:A',
    '40:create:B',
  ]);
});

// @test-kind contract: Paqvilo local disabled/placeholder step choices must not block SDK bulk calls
test('disabled and placeholder single steps do not prevent an SDK bulk call', async (t) => {
  for (const mode of ['disabled', 'placeholder']) {
    await t.test(mode, async (t) => {
      const single = step('Create'),
        bulk = step('CreateMultiple', 20, 1, 2);
      let called = 0;
      const f = await fixture(
        t,
        [single, bulk],
        new Map([
          [
            bulk.id,
            () => {
              called++;
            },
          ],
        ]),
        mode === 'disabled' ? { [`plugin-step:${single.id}`]: { mode } } : {},
      );
      const service = localOrganizationService(f.store, {
        userId: user,
        evidence: 'Invented bulk capability',
        grants: [{ entity: 'x_item', operations: ['read', 'create'] }],
        bulkTables: [
          {
            entity: 'x_item',
            tableType: 'standard',
            evidence: 'Invented table capability',
            messages: ['CreateMultiple'],
          },
        ],
      });
      const result = await f.store.transact(() =>
        service.bulk('createmultiple', [
          { $type: 'Entity', logicalName: 'x_item', id: empty, attributes: { x_name: 'Allowed' } },
        ]),
      );
      assert.equal(result.ids.length, 1);
      assert.equal(called, 1);
    });
  }
});

// @test-kind compatibility: Learn step registration: SupportedDeployment offline-only steps never run on the server pipeline
test('offline-only client registrations remain inventoried and do not execute or queue on the online pipeline', async (t) => {
  const registrations = [
    step('Create', 20, 1, 1),
    step('CreateMultiple', 20, 1, 2),
    step('RetrieveMultiple', 20, 1, 3),
    { ...step('Create', 40, 1, 4), mode: 1 },
    { ...step('CreateMultiple', 40, 1, 5), mode: 1 },
  ].map((registration) => ({ ...registration, supportedDeployment: 1, messageAvailability: 2, filterAvailability: 1 }));
  let calls = 0;
  const f = await fixture(
    t,
    registrations,
    new Map(
      registrations.map((registration) => [
        registration.id,
        () => {
          calls++;
          throw Error('An offline-only step executed online');
        },
      ]),
    ),
  );
  assert.equal(f.items.length, 5);
  assert(f.items.every((item) => /offline/i.test(item.unsupported)));
  assert.equal(f.store.pluginPipelineActive({ entity: 'x_item', operation: 'create' }), false);
  assert.equal((await f.request('POST', '/x_items', { x_name: 'Online single' })).status, 201);
  assert.equal(
    (
      await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
        Targets: [{ x_name: 'Online group' }],
      })
    ).status,
    200,
  );
  assert.equal((await f.request('GET', "/x_items?$filter=contains(x_name,'Online')")).status, 200);
  await f.backend.settle();
  assert.equal(calls, 0);
  assert.equal(f.store.tableRows('asyncoperation').length, 0);
});

// @test-kind compatibility: Learn bypass custom logic: BypassBusinessLogicExecutionStepIds skips selected steps for scalar, bulk and async
test('selective step bypass reaches scalar and grouped writes plus committed async jobs on HTTP and SDK', async (t) => {
  const registrations = [
    step('Create', 20, 1, 1),
    step('CreateMultiple', 20, 1, 2),
    { ...step('Create', 40, 1, 3), mode: 1 },
    { ...step('CreateMultiple', 40, 1, 4), mode: 1 },
  ];
  const asyncCounts = [];
  const handlers = new Map(
    registrations.map((registration) => [
      registration.id,
      (context) => {
        if (registration.id === registrations[3].id) asyncCounts.push(context.targets.length);
        else context.reject('Selected step should have been bypassed');
      },
    ]),
  );
  const f = await fixture(t, registrations, handlers);
  const ids = registrations
    .slice(0, 3)
    .map((registration) => registration.id)
    .join(',');
  assert.equal((await f.request('POST', '/x_items', { x_name: 'No bypass' })).status, 400);
  assert.equal(
    (
      await f.request(
        'POST',
        '/x_items',
        { x_name: 'Scalar bypass' },
        { 'MSCRM.BypassBusinessLogicExecutionStepIds': ids },
      )
    ).status,
    201,
  );
  await f.backend.settle();
  assert.equal(
    (
      await f.request(
        'POST',
        '/x_items/Microsoft.Dynamics.CRM.CreateMultiple',
        { Targets: [{ x_name: 'Bulk A' }, { x_name: 'Bulk B' }] },
        { 'MSCRM.BypassBusinessLogicExecutionStepIds': ids },
      )
    ).status,
    200,
  );
  await f.backend.settle();
  await f.store.transact(() =>
    dispatchSdkCall({
      store: f.store,
      profile: {
        userId: user,
        evidence: 'Invented selective bypass profile',
        privileges: ['prvBypassCustomBusinessLogic'],
        grants: [{ entity: 'x_item', operations: ['create'] }],
        bulkTables: [
          {
            entity: 'x_item',
            tableType: 'standard',
            evidence: 'Invented source capability',
            messages: ['CreateMultiple'],
          },
        ],
      },
      message: {
        method: 'Execute',
        userId: user,
        arguments: [
          {
            $type: 'OrganizationRequest',
            requestName: 'CreateMultiple',
            parameters: {
              $type: 'ParameterCollection',
              values: {
                Targets: {
                  $type: 'EntityCollection',
                  entities: [
                    { $type: 'Entity', logicalName: 'x_item', id: empty, attributes: { x_name: 'SDK bypass' } },
                  ],
                },
                BypassBusinessLogicExecutionStepIds: ids,
              },
            },
          },
        ],
      },
    }),
  );
  await f.backend.settle();
  assert.deepEqual(asyncCounts, [1, 2, 1]);
  assert.equal(f.store.tableRows('asyncoperation').length, 3);
  assert(
    f.store.tableRows('asyncoperation').every((job) => job.statuscode === 30 && job.messagename === 'CreateMultiple'),
  );
});

// @test-kind compatibility+contract: Learn bypass leaves Microsoft/system logic running; ownership comes from Paqvilo evidenced bypassOwnership
test('evidenced Microsoft/system source steps survive global and selected bypass without duplicated bulk execution', async (t) => {
  const registrations = [
    {
      ...step('Create', 20, 1, 1),
      bypassOwnership: { kind: 'microsoft', evidence: 'Invented source publisher evidence' },
    },
    {
      ...step('CreateMultiple', 20, 1, 2),
      bypassOwnership: { kind: 'system', evidence: 'Invented system registration evidence' },
    },
    {
      ...step('Create', 20, 2, 3),
      bypassOwnership: { kind: 'custom', evidence: 'Invented custom extension evidence' },
    },
    {
      ...step('Create', 40, 1, 4),
      mode: 1,
      bypassOwnership: { kind: 'microsoft', evidence: 'Invented source publisher evidence' },
    },
    {
      ...step('CreateMultiple', 40, 1, 5),
      mode: 1,
      bypassOwnership: { kind: 'microsoft', evidence: 'Invented source publisher evidence' },
    },
    {
      ...step('Create', 40, 2, 6),
      mode: 1,
      bypassOwnership: { kind: 'custom', evidence: 'Invented custom extension evidence' },
    },
  ];
  const counts = { scalar: 0, group: 0, asyncScalar: 0, asyncGroup: 0 };
  const handlers = new Map(
    registrations.map((registration, index) => [
      registration.id,
      (context) => {
        if (index === 0) {
          counts.scalar++;
          return { target: { x_name: 'Protected scalar' } };
        }
        if (index === 1) {
          counts.group++;
          return {
            targets: context.targets.map((target) => ({
              ...target,
              attributes: { ...target.attributes, x_keep: 'Protected group' },
            })),
          };
        }
        if (index === 3) {
          counts.asyncScalar++;
          return;
        }
        if (index === 4) {
          counts.asyncGroup++;
          return;
        }
        context.reject('Custom step should have been bypassed');
      },
    ]),
  );
  const f = await fixture(t, registrations, handlers);
  const global = { 'MSCRM.BypassBusinessLogicExecution': 'CustomSync,CustomAsync' };
  assert.equal((await f.request('POST', '/x_items', { x_name: 'Scalar' }, global)).status, 201);
  await f.backend.settle();
  assert.equal(
    (
      await f.request(
        'POST',
        '/x_items/Microsoft.Dynamics.CRM.CreateMultiple',
        { Targets: [{ x_name: 'A' }, { x_name: 'B' }] },
        global,
      )
    ).status,
    200,
  );
  await f.backend.settle();
  const selective = {
    'MSCRM.BypassBusinessLogicExecution': 'CustomAsync',
    'MSCRM.BypassBusinessLogicExecutionStepIds': registrations
      .slice(0, 3)
      .map((registration) => registration.id)
      .join(','),
  };
  assert.equal((await f.request('POST', '/x_items', { x_name: 'Selective' }, selective)).status, 201);
  await f.backend.settle();
  assert.deepEqual(counts, { scalar: 4, group: 3, asyncScalar: 4, asyncGroup: 3 });
  assert(
    f.store
      .tableRows('x_item')
      .slice(1)
      .every((row) => row.x_name === 'Protected scalar' && row.x_keep === 'Protected group'),
  );
  assert.equal(f.store.tableRows('asyncoperation').length, 7);
  assert(f.store.tableRows('asyncoperation').every((job) => job.statuscode === 30));
  const sole = {
    ...step('Create', 20),
    bypassOwnership: { kind: 'microsoft', evidence: 'Invented sole protected registration' },
  };
  const one = await fixture(t, [sole], new Map([[sole.id, (context) => context.reject('Protected step still ran')]]));
  assert.equal(
    one.store.pluginPipelineActive({ entity: 'x_item', operation: 'create', bypassStepIds: [sole.id] }),
    true,
  );
  assert.equal(
    (
      await one.request(
        'POST',
        '/x_items',
        { x_name: 'Protected' },
        { 'MSCRM.BypassBusinessLogicExecutionStepIds': sole.id },
      )
    ).status,
    400,
  );
});

test('merged PostOperation Target changes reach later steps and async snapshots without altering saved rows', async (t) => {
  for (const bulk of [false, true])
    await t.test(bulk ? 'bulk-origin' : 'single-origin', async (t) => {
      const group = { ...step('CreateMultiple', 40, 10, 1), typeName: 'Invented.GroupPost' };
      const scalar = { ...step('Create', 40, 20, 2), typeName: 'Invented.ScalarPost' };
      const async = { ...step('CreateMultiple', 40, 30, 3), typeName: 'Invented.AsyncPost', mode: 1 };
      const captured = [];
      const handlers = new Map([
        [
          group.typeName,
          (context) => ({
            targets: context.targets.map((target) => ({
              ...target,
              attributes: { ...target.attributes, x_keep: 'Grouped context' },
            })),
          }),
        ],
        [
          scalar.typeName,
          (context) => {
            assert.equal(context.target.x_keep, 'Grouped context');
            return { target: { x_name: 'Scalar context' } };
          },
        ],
        [
          async.typeName,
          (context) => {
            const target = context.context.InputParameters.Targets[0];
            captured.push([target.attributes?.x_name ?? target.x_name, target.attributes?.x_keep ?? target.x_keep]);
          },
        ],
      ]);
      const f = await fixture(t, [group, scalar, async], handlers);
      const authored = {
        x_itemid: '20000000-0000-0000-0000-000000000099',
        x_name: 'Saved original',
        x_keep: 'Saved keep',
      };
      const response = bulk
        ? await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', { Targets: [authored] })
        : await f.request('POST', '/x_items', authored);
      assert(response.status < 300, await response.text());
      await f.backend.settle();
      const saved = f.store.tableRows('x_item').find((row) => row.x_itemid === authored.x_itemid);
      assert.equal(saved.x_name, 'Saved original');
      assert.equal(saved.x_keep, 'Saved keep');
      // Native recorder corpus pipelineEffects/crud: a single Create's queued CreateMultiple job is the Create job under
      // its own name, so it sees the Target PostOperation started with, without the PostOperation context edits.
      assert.deepEqual(captured, [bulk ? ['Scalar context', 'Grouped context'] : ['Saved original', 'Saved keep']]);
    });
});

// @test-kind contract: Paqvilo record afterWrite hook ordering relative to grouped PostOperation
test('HTTP and SDK bulk record afterWrite hooks run after grouped PostOperation', async (t) => {
  const post = step('CreateMultiple', 40),
    seen = [];
  const f = await fixture(
    t,
    [post],
    new Map([
      [
        post.id,
        () => {
          seen.push('plugin-post');
        },
      ],
    ]),
  );
  f.api.recordHooks.add('afterWrite', (_c, mapping) => {
    if (mapping.logicalName === 'x_item') seen.push('record-after');
  });
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    Targets: [{ x_name: 'HTTP A' }, { x_name: 'HTTP B' }],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, ['plugin-post', 'record-after', 'record-after']);
  seen.length = 0;
  const service = localOrganizationService(f.store, {
    userId: user,
    evidence: 'Invented bulk hook order',
    grants: [{ entity: 'x_item', operations: ['read', 'create'] }],
    bulkTables: [
      { entity: 'x_item', tableType: 'standard', evidence: 'Invented table capability', messages: ['CreateMultiple'] },
    ],
  });
  await f.store.transact(() =>
    service.bulk('createmultiple', [
      { $type: 'Entity', logicalName: 'x_item', id: empty, attributes: { x_name: 'SDK' } },
    ]),
  );
  assert.deepEqual(seen, ['plugin-post', 'record-after']);
});

test('UpdateMultiple preserves grouped duplicate targets, persists the first and applies single-step filters per current target', async (t) => {
  const bulk = { ...step('UpdateMultiple', 20, 30), filteringAttributes: ['x_name'] };
  const single = { ...step('Update', 20, 10, 2), filteringAttributes: ['x_name'] };
  const seen = [];
  const f = await fixture(
    t,
    [bulk, single],
    new Map([
      [
        bulk.id,
        (c) => {
          seen.push(['bulk', c.targets.length]);
          return {
            targets: c.targets.map((target) => ({
              ...target,
              attributes: { ...target.attributes, x_keep: 'Grouped' },
            })),
          };
        },
      ],
      [
        single.id,
        (c) => {
          seen.push(['single', c.target.x_name]);
          assert.equal(c.target.x_keep, 'Grouped');
          return { target: { x_name: 'Single normalized' } };
        },
      ],
    ]),
  );
  const other = await f.request('POST', '/x_items', { x_name: 'Other', x_keep: 'Keep' });
  const otherId = (await other.json()).x_itemid;
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
    Targets: [
      { x_itemid: id, x_name: 'First' },
      { x_itemid: id, x_name: 'Duplicate ignored' },
      { x_itemid: otherId, x_keep: 'Submitted keep' },
    ],
  });
  assert.equal(response.status, 204);
  assert.deepEqual(seen, [
    ['bulk', 3],
    ['single', 'First'],
    ['single', 'Duplicate ignored'],
  ]);
  assert.equal(f.store.tableRows('x_item').find((row) => row.x_itemid === id).x_name, 'Single normalized');
  assert.equal(f.store.tableRows('x_item').find((row) => row.x_itemid === otherId).x_name, 'Other');
});

test('HTTP and SDK duplicate UpdateMultiple keep two targets and aligned snapshots at every stage and in one async job', async (t) => {
  for (const transport of ['http', 'sdk'])
    await t.test(transport, async (t) => {
      const registrations = [10, 20, 40].map((stage, index) => step('UpdateMultiple', stage, 1, index + 1));
      const async = { ...step('UpdateMultiple', 40, 1, 4), mode: 1 };
      registrations.push(async);
      registrations.push(...[10, 20, 40].map((stage, index) => step('Update', stage, 1, index + 5)), {
        ...step('Update', 40, 1, 8),
        mode: 1,
      });
      const seen = [];
      const singleSeen = [];
      const handlers = new Map(
        registrations.map((registration) => [
          registration.id,
          (context) => {
            if (registration.message === 'Update') {
              singleSeen.push([registration.mode === 1 ? 'async' : context.stage, context.target.x_name]);
              return;
            }
            seen.push([
              registration.mode === 1 ? 'async' : context.stage,
              context.targets.length,
              context.previousRecords.length,
              context.records.length,
            ]);
            assert.equal(context.targets[1].attributes.x_name, 'Ignored duplicate');
            if (context.stage === 40)
              assert.deepEqual(
                context.records.map((row) => row.x_name),
                ['First', 'First'],
              );
          },
        ]),
      );
      const f = await fixture(t, registrations, handlers);
      const mutations = [];
      f.store.addMutationObserver((event) => mutations.push(event.operation));
      if (transport === 'http')
        assert.equal(
          (
            await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
              Targets: [
                { x_itemid: id, x_name: 'First' },
                { x_itemid: id, x_name: 'Ignored duplicate' },
              ],
            })
          ).status,
          204,
        );
      else {
        const service = localOrganizationService(f.store, {
          userId: user,
          evidence: 'Invented duplicate bulk source',
          grants: [{ entity: 'x_item', operations: ['read', 'update'] }],
          bulkTables: [
            {
              entity: 'x_item',
              tableType: 'standard',
              evidence: 'Invented source message availability',
              messages: ['UpdateMultiple'],
            },
          ],
        });
        await f.store.transact(() =>
          service.bulk(
            'updatemultiple',
            ['First', 'Ignored duplicate'].map((name) => ({
              $type: 'Entity',
              logicalName: 'x_item',
              id,
              attributes: { x_name: name },
            })),
          ),
        );
      }
      await f.backend.settle();
      assert.deepEqual(seen, [
        [10, 2, 2, 0],
        [20, 2, 2, 0],
        [40, 2, 2, 2],
        ['async', 2, 2, 2],
      ]);
      assert.deepEqual(mutations, ['update']);
      assert.equal(f.store.tableRows('x_item')[0].x_name, 'First');
      assert.deepEqual(
        singleSeen,
        [10, 20, 40, 'async'].flatMap((stage) => [
          [stage, 'First'],
          [stage, 'Ignored duplicate'],
        ]),
      );
      assert.equal(f.store.tableRows('asyncoperation').length, 3);
    });
});

test('columns added by earlier merged steps admit later filtered steps in the same operation', async (t) => {
  for (const lane of ['bulk-to-single', 'single-to-bulk-post'])
    await t.test(lane, async (t) => {
      const producer = step(lane === 'bulk-to-single' ? 'UpdateMultiple' : 'Update', 20);
      const guard = {
        ...step(lane === 'bulk-to-single' ? 'Update' : 'UpdateMultiple', lane === 'bulk-to-single' ? 20 : 40, 2, 2),
        filteringAttributes: ['x_keep'],
      };
      const f = await fixture(
        t,
        [producer, guard],
        new Map([
          [
            producer.id,
            (c) =>
              c.operation === 'updatemultiple'
                ? {
                    targets: c.targets.map((target) => ({
                      ...target,
                      attributes: { ...target.attributes, x_keep: 'Added' },
                    })),
                  }
                : { target: { x_keep: 'Added' } },
          ],
          [guard.id, (c) => c.reject('Dynamically admitted')],
        ]),
      );
      const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
        Targets: [{ x_itemid: id, x_name: 'Changed' }],
      });
      assert.equal(response.status, 400, lane);
      assert.match((await response.json()).error.message, /Dynamically admitted/);
      assert.equal(f.store.tableRows('x_item')[0].x_name, 'Existing');
    });
});

test('each merged stage visits bulk ranks, then every single rank for target A before target B', async (t) => {
  const steps = [];
  for (const stage of [10, 20, 40])
    for (const message of ['CreateMultiple', 'Create'])
      for (const rank of [10, 30]) steps.push(step(message, stage, rank, steps.length + 1));
  const seen = [];
  const f = await fixture(
    t,
    steps,
    new Map(
      steps.map((s) => [
        s.id,
        (c) => {
          seen.push(`${c.stage}/${c.operation}/${c.step.rank}/${c.target?.x_name ?? 'bulk'}`);
        },
      ]),
    ),
  );
  assert.equal(
    (
      await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
        Targets: [{ x_name: 'A' }, { x_name: 'B' }],
      })
    ).status,
    200,
  );
  assert.deepEqual(
    seen,
    [10, 20, 40].flatMap((stage) => [
      `${stage}/createmultiple/10/bulk`,
      `${stage}/createmultiple/30/bulk`,
      `${stage}/create/10/A`,
      `${stage}/create/30/A`,
      `${stage}/create/10/B`,
      `${stage}/create/30/B`,
    ]),
  );
});

test('asynchronous bulk steps receive one durable grouped snapshot and CustomAsync bypass queues none', async (t) => {
  const create = { ...step('CreateMultiple', 40), mode: 1 };
  const update = { ...step('UpdateMultiple', 40, 1, 2), mode: 1, filteringAttributes: ['x_name'] };
  const seen = [],
    mutations = [];
  const f = await fixture(
    t,
    [create, update],
    new Map(
      [create, update].map((s) => [
        s.id,
        (c) => {
          seen.push({
            operation: c.operation,
            count: c.targets.length,
            previous: c.previousRecords.map((row) => row?.x_name ?? null),
            records: c.records.map((row) => row.x_name),
          });
        },
      ]),
    ),
  );
  const removeObserver = f.store.addMutationObserver((event) => mutations.push(event.operation), {
    matches: (event) => event.entity === 'x_item',
  });
  t.after(removeObserver);
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    Targets: [{ x_name: 'A' }, { x_name: 'B' }],
  });
  assert.equal(response.status, 200);
  const ids = (await response.json()).Ids;
  await f.backend.settle();
  assert.deepEqual(seen, [{ operation: 'createmultiple', count: 2, previous: [null, null], records: ['A', 'B'] }]);
  assert.deepEqual(mutations, ['create', 'create']);
  assert.equal(
    f.store.tableRows('asyncoperation').filter((row) => row.messagename === 'CreateMultiple' && row.statuscode === 30)
      .length,
    1,
  );
  assert.equal(
    (
      await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
        Targets: ids.map((value, i) => ({ x_itemid: value, x_name: `Changed${i}` })),
      })
    ).status,
    204,
  );
  await f.backend.settle();
  assert.deepEqual(seen[1], {
    operation: 'updatemultiple',
    count: 2,
    previous: ['A', 'B'],
    records: ['Changed0', 'Changed1'],
  });
  const count = f.store.tableRows('asyncoperation').length;
  assert.equal(
    (
      await f.request(
        'POST',
        '/x_items/Microsoft.Dynamics.CRM.CreateMultiple',
        { Targets: [{ x_name: 'Bypassed' }] },
        { 'MSCRM.BypassBusinessLogicExecution': 'CustomAsync' },
      )
    ).status,
    200,
  );
  await f.backend.settle();
  assert.equal(seen.length, 2);
  assert.equal(f.store.tableRows('asyncoperation').length, count);
});

test('single Create and Update enter matching multiple-message steps with one target', async (t) => {
  const create = step('CreateMultiple'),
    update = step('UpdateMultiple', 20, 1, 2);
  const seen = [];
  const f = await fixture(
    t,
    [create, update],
    new Map([
      [
        create.id,
        (c) => {
          seen.push([c.operation, c.targets.length]);
          return {
            targets: c.targets.map((target) => ({
              ...target,
              attributes: { ...target.attributes, x_name: 'Grouped single' },
            })),
          };
        },
      ],
      [
        update.id,
        (c) => {
          seen.push([c.operation, c.targets.length]);
          c.reject('Grouped update blocks a single request');
        },
      ],
    ]),
  );
  const response = await f.request('POST', '/x_items', { x_name: 'Original' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).x_name, 'Grouped single');
  assert.equal((await f.request('PATCH', `/x_items(${id})`, { x_name: 'Refused' })).status, 400);
  assert.equal(f.store.tableRows('x_item')[0].x_name, 'Existing');
  assert.deepEqual(seen, [
    ['createmultiple', 1],
    ['updatemultiple', 1],
  ]);
});

test('single-origin Create and Update merge single and multiple registrations by rank inside each stage', async (t) => {
  for (const operation of ['Create', 'Update'])
    await t.test(operation, async (t) => {
      const registrations = [];
      for (const stage of [10, 20, 40])
        for (const [message, rank] of [
          [operation, 10],
          [operation + 'Multiple', 20],
          [operation, 30],
          [operation + 'Multiple', 40],
        ])
          registrations.push(step(message, stage, rank, registrations.length + 1));
      const seen = [];
      const handlers = new Map(
        registrations.map((registration) => [
          registration.id,
          (context) => {
            seen.push(`${context.stage}:${context.operation}:${context.step.rank}`);
          },
        ]),
      );
      const f = await fixture(t, registrations, handlers);
      assert.equal(
        (
          await f.request(
            operation === 'Create' ? 'POST' : 'PATCH',
            operation === 'Create' ? '/x_items' : `/x_items(${id})`,
            { x_name: 'Single origin' },
          )
        ).status,
        operation === 'Create' ? 201 : 200,
      );
      assert.deepEqual(
        seen,
        [10, 20, 40].flatMap((stage) => [
          `${stage}:${operation.toLowerCase()}:10`,
          `${stage}:${operation.toLowerCase()}multiple:20`,
          `${stage}:${operation.toLowerCase()}:30`,
          `${stage}:${operation.toLowerCase()}multiple:40`,
        ]),
      );
    });
});

test('provided-ID implicit CreateMultiple preserves authored identity and shares the single Create parent view', async (t) => {
  const provided = '20000000-0000-0000-0000-000000000099';
  const registrations = [10, 20, 40].map((stage, index) => step('CreateMultiple', stage, 1, index + 1));
  const singles = [10, 20, 40].map((stage, index) => ({
    ...step('Create', stage, 1, index + 4),
    typeName: 'Invented.SingleSibling',
  }));
  const seen = [],
    siblings = [];
  const f = await fixture(
    t,
    [...registrations, ...singles],
    new Map([
      [
        registrations[0].typeName,
        ({ context }) => {
          seen.push(context);
        },
      ],
      [
        'Invented.SingleSibling',
        ({ context }) => {
          siblings.push(context);
        },
      ],
    ]),
  );
  assert.equal((await f.request('POST', '/x_items', { x_itemid: provided, x_name: 'Provided identity' })).status, 201);
  assert.deepEqual(
    seen.map((context) => context.Stage),
    [10, 20, 40],
  );
  for (const context of seen) {
    // Native recorder corpus crud: CreateMultiple steps of a single Create report its PrimaryEntityId at 10, 20 and 40.
    assert.equal(context.PrimaryEntityId, provided);
    assert.equal(context.InputParameters.Targets[0].id, provided);
    const primary = context.InputParameters.Targets[0].attributes.x_itemid;
    assert.equal(primary?.value ?? primary, provided);
  }
  // Native recorder corpus crud: the Create step at equal rank runs first, and both see one parent (none at PreValidation).
  assert.deepEqual(
    siblings.map((context) => context.Stage),
    [10, 20, 40],
  );
  for (const [index, context] of seen.entries()) {
    const sibling = siblings[index];
    if (context.Stage === 10) assert.equal(context.ParentContext ?? null, null);
    assert.deepEqual(context.ParentContext, sibling.ParentContext);
    assert.equal(sibling.PrimaryEntityId, context.PrimaryEntityId);
  }
});

test(
  'original CLR implicit multiple messages follow actual scalar rank order, phase boundaries and current typed Target identity',
  { skip: CLR_SKIP },
  async (t) => {
    // The Observer runs on the single message's own frame (native recorder corpus crud/depth), so a parent binding is
    // checked only when no scalar step re-pointed Target.Id (that parent view is the single Update's own).
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-mixed-create-identity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Identity.cs'),
      assembly = path.join(root, 'Identity.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Noop:IPlugin {public void Execute(IServiceProvider p){}}public sealed class Mutate:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"]).Id=new Guid("20000000-0000-0000-0000-000000000098");c.SharedVariables["Mutated"]=true;}}public sealed class Observer:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var ts=(EntityCollection)c.InputParameters["Targets"];if(ts.Entities.Count!=1)throw new Exception("Wrong collection count");var target=ts.Entities[0];bool supplied=target.GetAttributeValue<string>("x_keep")!="generated";if(target.Id==Guid.Empty)throw new Exception("Missing allocated target identity");bool has=target.Contains("x_itemid");if(has!=(supplied||c.Stage!=10))throw new Exception("Wrong primary attribute at "+c.Stage);if(has&&(Guid)target["x_itemid"]!=(supplied?new Guid("20000000-0000-0000-0000-000000000099"):target.Id))throw new Exception("Wrong primary attribute value");if(c.MessageName=="UpdateMultiple"&&c.ParentContext!=null&&!c.SharedVariables.Contains("Mutated")&&!c.ParentContext.SharedVariables.Contains("Mutated")){var pt=(Entity)c.ParentContext.InputParameters["Target"];if(pt.Id!=new Guid("20000000-0000-0000-0000-000000000099")||pt.GetAttributeValue<Guid>("x_itemid")!=pt.Id)throw new Exception("Mutable child identity changed parent binding");}c.SharedVariables["ObservedIdentityStage"]=c.Stage;c.SharedVariables["ObservedIdentityPrimary"]=c.PrimaryEntityId.ToString();c.SharedVariables["ObservedIdentityTarget"]=target.Id.ToString();}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Observer',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented mixed identity observer', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const createCases = [
      ...[10, 20, 40].flatMap((stage) => [5, 30].map((rank) => ({ scalar: [{ stage, rank }], supplied: true }))),
      ...[false, true].flatMap((supplied) => [
        { scalar: [], supplied },
        { scalar: [10, 20, 40].map((stage) => ({ stage, rank: 5 })), supplied },
      ]),
      { scalar: [{ stage: 10, rank: 10 }], supplied: true, mutate: true },
    ];
    const cases = [
      ...createCases.map((scenario) => ({ ...scenario, message: 'Create' })),
      ...createCases.slice(0, 6).map((scenario) => ({ ...scenario, message: 'Update' })),
      ...[10, 20].map((stage) => ({
        message: 'Update',
        scalar: [{ stage, rank: 10 }],
        supplied: true,
        mutate: true,
        seedReplacement: true,
      })),
      {
        message: 'Update',
        scalar: [{ stage: 10, rank: 10 }],
        supplied: true,
        mutate: true,
      },
    ];
    for (const scenario of cases) {
      const { supplied } = scenario;
      const message = scenario.message;
      const registrations = [10, 20, 40].flatMap((stage, index) => [
        { ...step(message + 'Multiple', stage, 20, index + 1), typeName: 'Invented.Observer' },
        { ...step(message + 'Multiple', stage, 21, index + 10), typeName: 'Invented.Snapshot' },
      ]);
      registrations.push(
        { ...step(message + 'Multiple', 40, 40, 4), typeName: 'Invented.Observer' },
        { ...step(message + 'Multiple', 40, 41, 14), typeName: 'Invented.Snapshot' },
        ...scenario.scalar.map(({ stage, rank }, index) => ({
          ...step(message, stage, rank, index + 20),
          typeName: scenario.mutate ? 'Invented.Mutate' : 'Invented.Noop',
        })),
      );
      const seen = [],
        handlers = new Map([
          [
            'Invented.Snapshot',
            ({ context }) => {
              assert.equal(context.SharedVariables.ObservedIdentityStage, context.Stage);
              assert.equal(context.SharedVariables.ObservedIdentityPrimary, context.PrimaryEntityId);
              seen.push({
                stage: context.Stage,
                primary: context.PrimaryEntityId,
                target: context.InputParameters.Targets[0],
                observedTarget: context.SharedVariables.ObservedIdentityTarget,
              });
            },
          ],
        ]);
      const runtimes = new Map(
        registrations
          .filter((entry) => entry.typeName !== 'Invented.Snapshot')
          .map((entry) => [
            entry.id,
            entry.typeName !== 'Invented.Observer' ? retypeClrRuntime(runtime, { typeName: entry.typeName }) : runtime,
          ]),
      );
      const overrides = Object.fromEntries(
        [...runtimes.keys()].map((entry) => ['plugin-step:' + entry, { mode: 'clr' }]),
      );
      const f = await fixture(t, registrations, handlers, overrides, runtimes);
      const provided = '20000000-0000-0000-0000-000000000099';
      if (message === 'Update')
        assert.equal(
          (await f.request('POST', '/x_items', { x_itemid: provided, x_name: 'Seeded update' })).status,
          201,
        );
      if (scenario.seedReplacement)
        assert.equal(
          (
            await f.request('POST', '/x_items', {
              x_itemid: '20000000-0000-0000-0000-000000000098',
              x_name: 'Replacement seed unchanged',
            })
          ).status,
          201,
        );
      const response = await f.request(
        message === 'Create' ? 'POST' : 'PATCH',
        message === 'Create' ? '/x_items' : `/x_items(${provided})`,
        {
          x_name: 'Ranked identity',
          x_keep: supplied ? 'provided' : 'generated',
          ...(supplied && message === 'Create' ? { x_itemid: provided } : {}),
        },
      );
      const body = await response.json();
      assert.equal(response.status, message === 'Create' ? 201 : 200, JSON.stringify(body));
      assert.deepEqual(
        seen.map((entry) => entry.stage),
        [10, 20, 40, 40],
      );
      // Targets[0] is the single Target as it stands: a scalar step's re-pointed Target.Id reaches the multiple steps
      // after it, until the single message binds its Target to the row again (Create at PreOperation, Update at
      // PostOperation).
      const mutatedAt = (stage) =>
        scenario.mutate &&
        (stage === scenario.scalar[0].stage ||
          (message === 'Update' && scenario.scalar[0].stage === 10 && stage === 20));
      assert.equal(
        seen.every(
          (entry) =>
            entry.target.id === (mutatedAt(entry.stage) ? '20000000-0000-0000-0000-000000000098' : body.x_itemid) &&
            entry.observedTarget === entry.target.id,
        ),
        true,
      );
      if (message === 'Update' && scenario.mutate) {
        assert.equal(body.x_itemid, provided);
        const replacement = f.store
          .tableRows('x_item')
          .find((row) => row.x_itemid === '20000000-0000-0000-0000-000000000098');
        assert.equal(replacement?.x_name, scenario.seedReplacement ? 'Replacement seed unchanged' : undefined);
      }
      assert.equal(
        // Native recorder corpus crud/depth: every implicit multiple step reports the single message's PrimaryEntityId.
        seen.every((entry) => entry.primary === body.x_itemid),
        true,
      );
    }
  },
);

test(
  'original CLR UpdateMultiple inputs preserve HTTP preconditions and immediate CLR SDK provenance',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-wrapper-update-inputs-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Inputs.cs'),
      assembly = path.join(root, 'Inputs.dll');
    const provided = '20000000-0000-0000-0000-000000000099';
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Driver:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(((Entity)c.InputParameters["Target"]).GetAttributeValue<string>("x_name")!="Drive CLR")return;var f=(IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory));var s=f.CreateOrganizationService(c.UserId);var row=new Entity("x_item",new Guid("${provided}"));row["x_name"]="SDK CLR";s.Update(row);}}public sealed class Inputs:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var ts=(EntityCollection)c.InputParameters["Targets"];if(ts.Entities.Count!=1)throw new Exception("Wrong Targets count");var row=ts.Entities[0];if(row.Id!=new Guid("${provided}")||row.GetAttributeValue<Guid>("x_itemid")!=row.Id)throw new Exception("Update wrapper lost PK projection");string name=row.GetAttributeValue<string>("x_name");bool sandbox=name=="SDK CLR"&&c.Stage==10;object behavior=c.InputParameters["ConcurrencyBehavior"];if(!(behavior is ConcurrencyBehavior)||(ConcurrencyBehavior)behavior!=(name=="ETag"?ConcurrencyBehavior.IfRowVersionMatches:ConcurrencyBehavior.Default))throw new Exception("Wrong typed concurrency behavior");if(c.InputParameters.Contains("FromSandbox")!=sandbox||(sandbox&&(!(c.InputParameters["FromSandbox"] is bool)||!(bool)c.InputParameters["FromSandbox"])))throw new Exception("Wrong immediate sandbox provenance");var parent=c.ParentContext;if(c.Stage==10){if(name=="Default"&&(parent==null||parent.MessageName!="Upsert"||parent.Stage!=30||parent.PrimaryEntityId!=Guid.Empty))throw new Exception("Wrong default PATCH parent");if((name=="Star"||name=="ETag")&&parent!=null)throw new Exception("Unexpected conditional PATCH parent");if(name=="SDK CLR"&&(parent==null||parent.MessageName!="Create"||parent.Stage!=20||parent.PrimaryEntityId==Guid.Empty))throw new Exception("Original SDK caller parent lost");}else if(parent==null||parent.MessageName!="Update"||parent.Stage!=30||parent.PrimaryEntityId!=row.Id)throw new Exception("Wrong Update core parent");if(c.Stage==10&&name=="Default"){if(!parent.InputParameters.Contains("ReturnRowVersion")||parent.InputParameters["ReturnRowVersion"]!=null||String.Join(",",parent.InputParameters.Keys)!="Target,ReturnRowVersion")throw new Exception("Wrong nullable Upsert return-version parameter");}if(c.Stage!=10||name=="Default"){var pt=(Entity)parent.InputParameters["Target"];if(pt.Id!=row.Id||pt.GetAttributeValue<Guid>("x_itemid")!=row.Id||pt.Attributes.Count!=2||!pt.Contains("x_name"))throw new Exception("Wrong core parent Target projection");}if(c.Stage!=10){object pb=parent.InputParameters["ConcurrencyBehavior"];if(!(pb is ConcurrencyBehavior)||(ConcurrencyBehavior)pb!=(ConcurrencyBehavior)behavior)throw new Exception("Wrong typed core parent concurrency");bool from=name=="SDK CLR";if(parent.InputParameters.Contains("FromSandbox")!=from||(from&&(!(parent.InputParameters["FromSandbox"] is bool)||!(bool)parent.InputParameters["FromSandbox"])))throw new Exception("Wrong core parent sandbox provenance");string expected=from?"Target,ConcurrencyBehavior,FromSandbox":"Target,ConcurrencyBehavior";if(String.Join(",",parent.InputParameters.Keys)!=expected)throw new Exception("Wrong core parent parameter shape");}c.SharedVariables["ObservedInputStage"]=c.Stage;c.SharedVariables["ObservedInputKeys"]=String.Join(",",c.InputParameters.Keys);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const profile = {
      userId: user,
      evidence: 'Invented wrapper SDK driver',
      grants: [{ entity: 'x_item', operations: ['read', 'update'] }],
    };
    const observerStages = [10, 20, 40],
      childInvocationBudgetMs = 2000;
    // The Driver waits for three separately bounded child CLR observers. Its
    // inclusive budget includes its own work and all three child invocations.
    const callerInvocationBudgetMs = childInvocationBudgetMs * (observerStages.length + 1);
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Inputs',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      timeoutMs: childInvocationBudgetMs,
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    for (const kind of ['Default', 'Star', 'ETag', 'SDK CLR', 'SDK JS']) {
      const registrations = observerStages.flatMap((stage, index) => [
        { ...step('UpdateMultiple', stage, 20, index + 1), typeName: 'Invented.Inputs' },
        { ...step('UpdateMultiple', stage, 21, index + 10), typeName: 'Invented.InputSnapshot' },
      ]);
      if (kind.startsWith('SDK'))
        registrations.push({
          ...step('Create', 20, 1, 20),
          typeName: kind === 'SDK CLR' ? 'Invented.Driver' : 'Invented.JSDriver',
        });
      const seen = [],
        handlers = new Map([
          [
            'Invented.InputSnapshot',
            ({ context }) => {
              assert.equal(context.SharedVariables.ObservedInputStage, context.Stage);
              // The single Update's inputs with Target as the trailing Targets (native recorder corpus crud/depth key order);
              // the single Update's own FromSandbox/ConcurrencyBehavior order is local (no native SDK Update/10 capture).
              const keys =
                context.Stage === 10 && kind === 'SDK CLR'
                  ? 'ConcurrencyBehavior,FromSandbox,Targets'
                  : 'ConcurrencyBehavior,Targets';
              assert.equal(context.SharedVariables.ObservedInputKeys, keys);
              seen.push({ stage: context.Stage, parent: context.ParentContext });
            },
          ],
        ]);
      let f;
      handlers.set('Invented.JSDriver', ({ context }) => {
        if (context.InputParameters.Target.x_name === 'Drive JS')
          localOrganizationService(f.store, profile).update('x_item', provided, { x_name: 'SDK JS' });
      });
      const runtimes = new Map(
        registrations
          .filter((entry) => ['Invented.Inputs', 'Invented.Driver'].includes(entry.typeName))
          .map((entry) => [
            entry.id,
            entry.typeName === 'Invented.Driver'
              ? retypeClrRuntime(runtime, { typeName: entry.typeName, timeoutMs: callerInvocationBudgetMs })
              : runtime,
          ]),
      );
      f = await fixture(
        t,
        registrations,
        handlers,
        Object.fromEntries([...runtimes.keys()].map((entry) => ['plugin-step:' + entry, { mode: 'clr' }])),
        runtimes,
      );
      assert.equal((await f.request('POST', '/x_items', { x_itemid: provided, x_name: 'Seed' })).status, 201);
      let response;
      if (kind.startsWith('SDK'))
        response = await f.request('POST', '/x_items', { x_name: kind === 'SDK CLR' ? 'Drive CLR' : 'Drive JS' });
      else {
        const headers = {};
        if (kind === 'Star') headers['If-Match'] = '*';
        if (kind === 'ETag') {
          const current = await f.request('GET', `/x_items(${provided})`);
          headers['If-Match'] = current.headers.get('etag');
          assert.ok(headers['If-Match']);
        }
        response = await f.request('PATCH', `/x_items(${provided})`, { x_name: kind }, headers);
      }
      assert.equal(response.status, kind.startsWith('SDK') ? 201 : 200, JSON.stringify(await response.json()));
      assert.deepEqual(
        seen.map((entry) => entry.stage),
        [10, 20, 40],
      );
      assert.equal(f.store.tableRows('x_item').find((row) => row.x_itemid === provided).x_name, kind);
    }
  },
);

// Native recorder corpus crud/depth: CreateMultiple steps of a single Create report the Create's PrimaryEntityId at every
// stage, whether or not a Create step ran before them.
test('implicit CreateMultiple steps report the single Create primary identity whatever scalar steps were skipped', async (t) => {
  for (const scenario of [
    { mode: 'disabled' },
    { mode: 'placeholder' },
    { mode: 'placeholder', deployment: 3 },
    { deployment: 1 },
    { enabled: false },
    { bypass: true },
  ]) {
    const scalar = {
      ...step('Create', 10, 5, 20),
      typeName: 'Invented.SkippedScalar',
      enabled: scenario.enabled ?? true,
      supportedDeployment: scenario.deployment ?? 0,
    };
    const multiple = [10, 20, 40].map((stage, index) => ({
      ...step('CreateMultiple', stage, 20, index + 1),
      typeName: 'Invented.SkippedObserver',
    }));
    const seen = [],
      handlers = new Map([
        [
          'Invented.SkippedObserver',
          ({ context }) => {
            seen.push(context.PrimaryEntityId);
          },
        ],
      ]);
    if (scenario.mode !== 'placeholder')
      handlers.set(scalar.typeName, () => assert.fail('The scalar adapter must be skipped'));
    const f = await fixture(
      t,
      [...multiple, scalar],
      handlers,
      scenario.mode ? { ['plugin-step:' + scalar.id]: { mode: scenario.mode } } : {},
    );
    const row = await f.store.transact(() =>
      f.store.createRecordAsync(
        'x_item',
        { x_name: 'Skipped scalar' },
        { admin: true },
        scenario.bypass ? { bypassStepIds: [scalar.id] } : {},
      ),
    );
    assert.deepEqual(seen, [row.x_itemid, row.x_itemid, row.x_itemid], JSON.stringify(scenario));
  }
});

test('an unchanged authored empty key reaches the Create validation boundary through its implicit multiple wrapper', async (t) => {
  const registrations = [
    { ...step('CreateMultiple', 10), typeName: 'Invented.EmptyObserver' },
    { ...step('Create', 20, 1, 2), typeName: 'Invented.EmptyNoop' },
  ];
  let observed = 0;
  const f = await fixture(
    t,
    registrations,
    new Map([
      [
        registrations[0].typeName,
        ({ context }) => {
          observed++;
          // The single Create's own view (native recorder corpus crud: CreateMultiple shares PrimaryEntityId and Target).
          assert.notEqual(context.InputParameters.Targets[0].id, empty);
          assert.equal(context.PrimaryEntityId, context.InputParameters.Targets[0].id);
          const primary = context.InputParameters.Targets[0].attributes.x_itemid;
          assert.equal(primary?.value ?? primary, empty);
        },
      ],
      [registrations[1].typeName, () => assert.fail('The unchanged empty primary must fail before PreOperation')],
    ]),
  );
  const response = await f.request('POST', '/x_items', { x_itemid: empty, x_name: 'Invalid empty key' });
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error.code, '0x80040203');
  assert.equal(observed, 1);
  assert.equal(f.store.tableRows('x_item').length, 1);
});

// Native recorder corpus crud: UpdateMultiple/10/20/40 of a single PATCH report the Update's PrimaryEntityId, depth,
// request and parent (the CLR view is plugin-delegation.test.mjs; this is the handler view of the same frame).
test('single-origin UpdateMultiple shares the single Update identity, depth and parent view', async (t) => {
  const registration = step('UpdateMultiple'),
    sibling = { ...step('Update', 20, 1, 2), typeName: 'Invented.UpdateSibling' };
  const captured = {};
  const f = await fixture(
    t,
    [registration, sibling],
    new Map([
      [
        registration.typeName,
        ({ context }) => {
          captured.multiple = context;
        },
      ],
      [
        sibling.typeName,
        ({ context }) => {
          captured.single = context;
        },
      ],
    ]),
  );
  assert.equal((await f.request('PATCH', `/x_items(${id})`, { x_name: 'Updated' })).status, 200);
  const { multiple, single } = captured;
  assert.equal(multiple.MessageName, 'UpdateMultiple');
  assert.equal(single.MessageName, 'Update');
  assert.equal(multiple.PrimaryEntityId, id);
  assert.equal(multiple.Depth, 1);
  for (const field of ['PrimaryEntityId', 'Depth', 'RequestId', 'CorrelationId', 'OperationId', 'ParentContext'])
    assert.deepEqual(multiple[field], single[field], field);
  assert.equal(multiple.InputParameters.Targets[0].id, id);
  assert.equal(multiple.InputParameters.Targets[0].attributes.x_name, single.InputParameters.Target.x_name);
});

// @test-kind compatibility: Learn event pipeline: a synchronous plug-in failure rolls back the whole transaction for single and grouped writes
test('single and grouped writes give trusted multiple-message handlers the full rollback checkpoint', async (t) => {
  const registration = step('CreateMultiple');
  let store;
  const f = await fixture(
    t,
    [registration],
    new Map([
      [
        registration.id,
        (c) => {
          store.state.tables.x_item[0].x_name = 'Uncommitted unrelated mutation';
          c.reject('Single write refused by grouped handler');
        },
      ],
    ]),
  );
  store = f.store;
  assert.equal((await f.request('POST', '/x_items', { x_name: 'Refused' })).status, 400);
  assert.equal(store.tableRows('x_item').length, 1);
  assert.equal(store.tableRows('x_item')[0].x_name, 'Existing');
  assert.equal(
    (
      await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
        Targets: [{ x_name: 'Refused bulk' }],
      })
    ).status,
    400,
  );
  assert.equal(store.tableRows('x_item').length, 1);
  assert.equal(store.tableRows('x_item')[0].x_name, 'Existing');
});

test('a single request stages one multiple-message async job without reporting a bulk row mutation', async (t) => {
  const async = { ...step('CreateMultiple', 40), mode: 1 },
    seen = [];
  const f = await fixture(
    t,
    [async],
    new Map([
      [
        async.id,
        (c) => {
          seen.push([c.operation, c.targets.length, c.records[0].x_name]);
        },
      ],
    ]),
  );
  assert.equal((await f.request('POST', '/x_items', { x_name: 'One target' })).status, 201);
  await f.backend.settle();
  assert.deepEqual(seen, [['createmultiple', 1, 'One target']]);
  assert.equal(
    f.store.tableRows('asyncoperation').filter((row) => row.messagename === 'CreateMultiple' && row.statuscode === 30)
      .length,
    1,
  );
});

test(
  'HTTP CreateMultiple returns final CLR output Ids independently of stored row identity',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-bulk-output-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Output.cs'),
      assembly = path.join(root, 'Output.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Output:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));c.OutputParameters["Ids"]=new Guid[]{new Guid("${id}")};}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Output.dll',
      typeName: 'Invented.Output',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented bulk output replacement', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: 30000,
    });
    const post = { ...step('CreateMultiple', 40), typeName: 'Invented.Output', assemblyName: 'Output' };
    const f = await fixture(
      t,
      [post],
      new Map(),
      { [`plugin-step:${post.id}`]: { mode: 'clr' } },
      new Map([[post.id, runtime]]),
    );
    const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
      Targets: [{ x_name: 'Actual row' }],
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).Ids, [id]);
    assert.notEqual(f.store.tableRows('x_item').find((row) => row.x_name === 'Actual row').x_itemid, id);
  },
);
