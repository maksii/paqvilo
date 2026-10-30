// @test-kind parity: native recorder parity corpus (crud, depth, async, faults, pipelineEffects, upsert): a single Create/Update/Delete runs its paired *Multiple steps inside its own pipeline, requested message first at equal rank
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-0000-0000-000000000001';
const id = '20000000-0000-0000-0000-000000000001';
const empty = '00000000-0000-0000-0000-000000000000';
// Step ids ending low sort first: every equal-rank pair gives the multiple step the lower id, so only the
// requested-message-first rule can put the single step before it.
const step = (message, stage, rank, n, extra = {}) => ({
  id: `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  name: `${message} ${stage} ${rank} #${n}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Observer',
  assemblyId: 'invented',
  ...extra,
});
async function fixture(t, steps, handlers, { runtimes = new Map(), overrides = {} } = {}) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_note: { dataverseType: 'nvarchar' } },
      },
      x_parent: {
        logicalName: 'x_parent',
        entitySet: 'x_parents',
        idColumn: 'x_parentid',
        nameColumn: 'x_label',
        fields: { x_label: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [{ x_itemid: id, x_name: 'Existing' }], x_parent: [] },
    extension: { name: 'single-multiple-probe', install: () => {} },
  });
  const items = pluginCatalogue({ plugins: { steps }, handlers, runtimes, overrides });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    handlers,
    runtimes,
    descriptors: new Map([...runtimes].map(([key, runtime]) => [key, runtime.descriptor])),
  });
  t.after(() => backend.close());
  return { ...f, backend };
}
// Handler contexts carry a trace function: keep their data only.
const copy = (context) => JSON.parse(JSON.stringify(context));

test('equal-rank single and multiple steps run the requested message first, multiple first for a bulk request', async (t) => {
  // Native crud/faults: Create(1) > CreateMultiple(1) > Create(2) at stages 10, 20 and 40; bulk.json reverses the pair.
  const steps = [10, 20, 40].flatMap((stage, index) => [
    step('CreateMultiple', stage, 1, 3 * index + 1),
    step('Create', stage, 1, 3 * index + 2),
    step('Create', stage, 2, 3 * index + 3),
  ]);
  const seen = [];
  const f = await fixture(
    t,
    steps,
    new Map([
      [
        'Invented.Observer',
        ({ context, step: registration }) => {
          seen.push(`${context.MessageName}/${context.Stage}/${registration.rank}`);
        },
      ],
    ]),
  );
  assert.equal((await f.request('POST', '/x_items', { x_name: 'Single' })).status, 201);
  assert.deepEqual(
    seen,
    [10, 20, 40].flatMap((stage) => [`Create/${stage}/1`, `CreateMultiple/${stage}/1`, `Create/${stage}/2`]),
  );
  seen.length = 0;
  const bulk = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    Targets: [{ x_name: 'Bulk' }],
  });
  assert.equal(bulk.status, 200);
  assert.deepEqual(
    seen,
    [10, 20, 40].flatMap((stage) => [`CreateMultiple/${stage}/1`, `Create/${stage}/1`, `Create/${stage}/2`]),
  );
});

test('a throwing single PreOperation step stops the equal-rank multiple step after it', async (t) => {
  // Native faults: the throwing 'Update pre' ran and UpdateMultiple pre did not.
  const steps = [step('UpdateMultiple', 20, 1, 1), step('Update', 20, 1, 2, { typeName: 'Invented.Thrower' })];
  const seen = [];
  const f = await fixture(
    t,
    steps,
    new Map([
      ['Invented.Observer', ({ context }) => void seen.push(context.MessageName)],
      [
        'Invented.Thrower',
        ({ context }) => {
          seen.push(context.MessageName);
          throw new Error('Invented refusal');
        },
      ],
    ]),
  );
  assert.equal((await f.request('PATCH', `/x_items(${id})`, { x_name: 'Refused' })).status, 400);
  assert.deepEqual(seen, ['Update']);
});

test('the multiple steps of a single Create share its identity, shared variables, outputs and current Target', async (t) => {
  // Native crud/depth/pipelineEffects: CreateMultiple and Create report one PrimaryEntityId, RequestId and parent at
  // 10/20/40; one SharedVariables bag per phase (PreValidation, then Pre/PostOperation); the Create's id output (no Ids);
  // Targets[0] is the Create Target with the single steps' edits.
  const steps = [10, 20, 40].flatMap((stage, index) => [
    step('CreateMultiple', stage, 1, 2 * index + 1),
    step('Create', stage, 1, 2 * index + 2, { typeName: 'Invented.Editor' }),
  ]);
  const multiple = [],
    single = [];
  const f = await fixture(
    t,
    steps,
    new Map([
      [
        'Invented.Editor',
        ({ context }) => {
          single.push(copy(context));
          context.SharedVariables[`from${context.Stage}`] = 'single';
          if (context.Stage !== 40) context.InputParameters.Target.x_note = `edited at ${context.Stage}`;
          else context.OutputParameters.custom = 'single output';
        },
      ],
      ['Invented.Observer', ({ context }) => void multiple.push(copy(context))],
    ]),
  );
  // The request names its key, as the native crud POST does.
  const created = '20000000-0000-0000-0000-000000000002';
  assert.equal((await f.request('POST', '/x_items', { x_itemid: created, x_name: 'Shared' })).status, 201);
  assert.deepEqual(
    multiple.map((context) => [context.MessageName, context.Stage]),
    [
      ['CreateMultiple', 10],
      ['CreateMultiple', 20],
      ['CreateMultiple', 40],
    ],
  );
  for (const [index, context] of multiple.entries()) {
    const sibling = single[index];
    assert.equal(context.PrimaryEntityId, created);
    for (const field of ['PrimaryEntityId', 'RequestId', 'CorrelationId', 'OperationId', 'Depth', 'ParentContext'])
      assert.deepEqual(context[field], sibling[field], `${context.Stage} ${field}`);
    assert.equal(context.SharedVariables[`from${context.Stage}`], 'single');
    const [target] = context.InputParameters.Targets;
    assert.equal(target.id, created);
    if (context.Stage !== 40) assert.equal(target.attributes.x_note, `edited at ${context.Stage}`);
  }
  // PreOperation and PostOperation share their bag; PreValidation's is the main operation's (the stage 20 parent).
  assert.equal(multiple[2].SharedVariables.from20, 'single');
  assert.equal(multiple[1].SharedVariables.from10, undefined);
  assert.equal(multiple[2].OutputParameters.id, created);
  assert.equal(Object.hasOwn(multiple[2].OutputParameters, 'Ids'), false);
  assert.equal(multiple[2].OutputParameters.custom, 'single output');
});

test('a single Delete runs DeleteMultiple steps at every stage with a one-reference Targets', async (t) => {
  // Native crud/async/upsert: Delete > DeleteMultiple at 10/20/40; DeleteMultiple/10 inputs Targets + ConcurrencyBehavior,
  // 20/40 Targets only, parent Delete/30; the queued DeleteMultiple job names no row.
  const steps = [
    ...[10, 20, 40].flatMap((stage, index) => [
      step('DeleteMultiple', stage, 1, 2 * index + 1),
      step('Delete', stage, 1, 2 * index + 2),
    ]),
    step('DeleteMultiple', 40, 1, 7, { mode: 1 }),
  ];
  const seen = [];
  const f = await fixture(t, steps, new Map([['Invented.Observer', ({ context }) => void seen.push(copy(context))]]));
  assert.equal((await f.request('DELETE', `/x_items(${id})`)).status, 204);
  await f.backend.settle();
  assert.deepEqual(
    seen.map((context) => `${context.MessageName}/${context.Stage}/${context.Mode}`),
    [
      'Delete/10/0',
      'DeleteMultiple/10/0',
      'Delete/20/0',
      'DeleteMultiple/20/0',
      'Delete/40/0',
      'DeleteMultiple/40/0',
      'DeleteMultiple/40/1',
    ],
  );
  for (const context of seen.filter((entry) => entry.MessageName === 'DeleteMultiple')) {
    assert.deepEqual(
      context.InputParameters.Targets.map((reference) => [reference.$type, reference.logicalName, reference.id]),
      [['EntityReference', 'x_item', id]],
    );
    assert.equal(Object.hasOwn(context.InputParameters, 'Target'), false);
    assert.equal(Object.hasOwn(context.InputParameters, 'ConcurrencyBehavior'), context.Stage === 10);
    assert.equal(context.PrimaryEntityId, context.Mode === 1 ? empty : id);
  }
  const rows = f.store.tableRows('asyncoperation').filter((row) => row.messagename === 'DeleteMultiple');
  assert.deepEqual(
    rows.map((row) => row.statuscode),
    [30],
  );
});

test(
  'original CLR: a single Create runs its queued CreateMultiple job and its SDK-issued multiple steps on the Create frame',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-single-multiple-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Bridge.cs'),
      assembly = path.join(root, 'Bridge.dll'),
      log = path.join(root, 'seen.txt');
    // Observer logs one line per run: message/stage/mode, ids, input keys and the parent chain. Driver creates an x_item
    // from a plug-in (the SDK request is FromSandbox).
    await fs.writeFile(
      source,
      `using System;using System.IO;using System.Linq;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Observer:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var chain="";for(var x=c.ParentContext;x!=null;x=x.ParentContext)chain+=">"+x.MessageName+"/"+x.Stage+"/"+x.Mode+"/"+x.PrimaryEntityId+"/"+x.RequestId+"/"+String.Join("+",x.InputParameters.Keys.OrderBy(k=>k));var t=c.InputParameters.Contains("Targets")?(EntityCollection)c.InputParameters["Targets"]:null;File.AppendAllText(@"${log.replaceAll('"', '""')}",String.Join("|",new object[]{c.MessageName,c.Stage,c.Mode,c.Depth,c.PrimaryEntityId,c.RequestId,c.CorrelationId,String.Join("+",c.InputParameters.Keys.OrderBy(k=>k)),c.InputParameters.Contains("FromSandbox")?c.InputParameters["FromSandbox"]:"-",t==null?"-":t.EntityName+":"+t.TotalRecordCount+":"+(t.MinActiveRowVersion??"null")+":"+t.Entities.Count+":"+t.Entities[0].Id,String.Join("+",c.OutputParameters.Keys.OrderBy(k=>k)),chain})+Environment.NewLine);}}public sealed class Driver:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var row=new Entity("x_item");row["x_name"]="From sandbox";s.Create(row);}}}`,
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
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: {
        userId: user,
        evidence: 'Invented single/multiple observer',
        grants: [{ entity: 'x_item', operations: ['read', 'create'] }],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const steps = [
      step('CreateMultiple', 10, 1, 1),
      step('CreateMultiple', 20, 1, 2),
      step('CreateMultiple', 40, 1, 3),
      step('CreateMultiple', 40, 1, 4, { mode: 1 }),
      step('Create', 40, 1, 5),
      step('Create', 20, 1, 6, { entity: 'x_parent', typeName: 'Invented.Driver' }),
    ];
    const runtimes = new Map(
      steps.map((entry) => [
        entry.id,
        entry.typeName === 'Invented.Driver' ? retypeClrRuntime(runtime, { typeName: 'Invented.Driver' }) : runtime,
      ]),
    );
    const f = await fixture(t, steps, new Map(), {
      runtimes,
      overrides: Object.fromEntries(steps.map((entry) => ['plugin-step:' + entry.id, { mode: 'clr' }])),
    });
    const created = '20000000-0000-0000-0000-000000000003';
    const response = await f.request('POST', '/x_items', { x_itemid: created, x_name: 'Top level' });
    assert.equal(response.status, 201, await response.text());
    assert.equal((await f.request('POST', '/x_parents', { x_label: 'Drives an SDK Create' })).status, 201);
    await f.backend.settle();
    const lines = (await fs.readFile(log, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split('|'));
    const [message, stage, mode, depth, primary, request, correlation, inputs, fromSandbox, targets, outputs, chain] = [
      ...Array(12).keys(),
    ];
    const top = lines.filter((line) => line[primary] === created);
    assert.deepEqual(
      top.map((line) => `${line[message]}/${line[stage]}/${line[mode]}`),
      ['CreateMultiple/10/0', 'CreateMultiple/20/0', 'Create/40/0', 'CreateMultiple/40/0', 'CreateMultiple/40/1'],
    );
    // One request identity for the Create, its multiple steps and its queued job (native crud event 1648).
    assert.equal(new Set(top.map((line) => line[request])).size, 1);
    assert.equal(new Set(top.map((line) => line[correlation])).size, 1);
    for (const line of top.filter((entry) => entry[message] === 'CreateMultiple')) {
      assert.equal(line[targets], `x_item:0:null:1:${created}`);
      assert.equal(line[outputs], line[stage] === '40' ? 'id' : '');
    }
    const asyncJob = top.at(-1);
    assert.equal(asyncJob[chain], `>CreateMultiple/30/1/${created}/${asyncJob[request]}/Target`);
    assert.equal(top[1][chain], `>Create/30/0/${created}/${top[1][request]}/Target`);
    // An SDK Create from a plug-in: CreateMultiple/10 carries FromSandbox; PreOperation's parent is that Create/30.
    const nested = lines.filter((line) => line[depth] === '2' && line[mode] === '0');
    assert.deepEqual(
      nested.map((line) => `${line[message]}/${line[stage]}`),
      ['CreateMultiple/10', 'CreateMultiple/20', 'Create/40', 'CreateMultiple/40'],
    );
    assert.equal(nested[0][fromSandbox], 'True');
    assert.equal(nested[0][inputs], 'FromSandbox+Targets');
    assert.match(
      nested[1][chain],
      new RegExp(`^>Create/30/0/${nested[1][primary]}/[^/]+/FromSandbox\\+Target>Create/20/0/`),
    );
  },
);
