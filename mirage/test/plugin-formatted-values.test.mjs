// @test-kind parity: dataverse-recorder native corpus 2026-10-30 (crud, bulk, pipelineEffects, upsert): Entity.FormattedValues of CLR Targets and images
// FormattedValues a CLR plug-in sees on its Targets and entity images, against the native recordings: which
// attributes carry one at which stage and message, and the text of each column type.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPluginPhase, pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const caller = '10000000-0000-0000-0000-000000000001',
  id = '20000000-0000-0000-0000-000000000001',
  currency = '40000000-0000-0000-0000-000000000001',
  stepId = '30000000-0000-0000-0000-000000000001';
const colours = [
  { value: 1, label: 'Red' },
  { value: 2, label: 'Blue' },
];
const fields = {
  title: { dataverseType: 'nvarchar' },
  flag: { dataverseType: 'bit' },
  hue: { dataverseType: 'picklist', options: colours },
  hues: { dataverseType: 'multiselectpicklist', options: colours },
  amount: { dataverseType: 'money', precision: 4 },
  amount_base: { dataverseType: 'money', precision: 4 },
  exchangerate: { dataverseType: 'decimal', precision: 12 },
  ratio: { dataverseType: 'decimal', precision: 4 },
  share: { dataverseType: 'double', precision: 5 },
  count: { dataverseType: 'int' },
  rank: { dataverseType: 'int' },
  seen: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' },
  day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
  slot: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
  statecode: { dataverseType: 'state', options: [{ value: 0, label: 'Active' }] },
  transactioncurrencyid: { dataverseType: 'lookup', targets: ['transactioncurrency'] },
  createdby: { dataverseType: 'lookup', targets: ['systemuser'] },
};
const row = {
  gadgetid: id,
  title: 'Kept',
  flag: false,
  hue: 1,
  hues: '1,2',
  amount: 3.5,
  ratio: 1.5,
  share: 2.25,
  count: 7,
  seen: '2026-10-30T14:55:48Z',
  day: '2026-10-30',
  slot: '2026-10-30T10:00:00Z',
  statecode: 0,
  transactioncurrencyid: currency,
  createdby: caller,
};
const fixture = (usersettings = []) =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        gadget: { entitySet: 'gadgets', idColumn: 'gadgetid', nameColumn: 'title', ownership: 'UserOwned', fields },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid', nameColumn: 'fullname' },
        transactioncurrency: {
          entitySet: 'transactioncurrencies',
          idColumn: 'transactioncurrencyid',
          nameColumn: 'currencyname',
        },
      },
      tables: {
        gadget: [{ ...row, amount_base: 3.5, exchangerate: 1 }],
        systemuser: [{ systemuserid: caller, fullname: 'Invented caller' }],
        transactioncurrency: [{ transactioncurrencyid: currency, currencyname: 'Invented euro', currencysymbol: '€' }],
        usersettings,
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const runtime = {
  descriptor: {
    context: { executionUserId: caller, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
    serviceProfile: { userId: caller, evidence: 'Invented formatted values', grants: [] },
  },
};
const step = (images = []) => ({ id: stepId, name: 'Invented step', images, contract: { mode: 0 } });
const context = (store, operation, stage, frame, { target, record, previous, images }) =>
  clrContext({
    runtime,
    store,
    step: step(images),
    entity: 'gadget',
    operation,
    stage,
    target,
    record,
    previous,
    frame,
    depth: 1,
  });
const phases = (store, operation, stages, { target, record, previous, ...extra }) => {
  let frame;
  for (const stage of stages)
    frame = runPluginPhase({
      items: [],
      handlers: new Map(),
      store,
      entity: 'gadget',
      operation,
      stage,
      target,
      record,
      previous,
      identity: {},
      ...extra,
    });
  return frame;
};

test('entity images format every typed value: labels, names, money, numbers and ISO dates', () => {
  const store = fixture(),
    previous = { ...store.tableRows('gadget')[0] },
    record = { ...previous, title: 'Changed' },
    target = { title: 'Changed' };
  const frame = phases(store, 'update', [10, 20, 40], { target, record, previous });
  const answer = context(store, 'update', 40, frame, {
    target,
    record,
    previous,
    images: [
      { alias: 'pre', type: 0 },
      { alias: 'post', type: 1 },
    ],
  });
  const expected = {
    flag: 'No',
    hue: 'Red',
    // A retrieved choices value lists its labels between separators (native crud pre/post images: "; Red; Blue; ").
    hues: '; Red; Blue; ',
    amount: '€3.5000',
    amount_base: '€3.5000',
    exchangerate: '1.000000000000',
    ratio: '1.5000',
    share: '2.25000',
    count: '7',
    seen: '2026-10-30T14:55:48+00:00',
    day: '2026-10-30T00:00:00',
    slot: '2026-10-30T10:00:00',
    statecode: 'Active',
    transactioncurrencyid: 'Invented euro',
    createdby: 'Invented caller',
  };
  assert.deepEqual(answer.preImages.pre.formattedValues, expected);
  assert.deepEqual(answer.postImages.post.formattedValues, expected);
});

test('a Create Target carries formatted values from PreOperation on, for the attributes prepared before it', () => {
  const store = fixture(),
    target = { ...row, gadgetid: '20000000-0000-0000-0000-000000000002' },
    record = { ...target };
  store.state.tables.gadget = [];
  const early = context(store, 'create', 10, phases(store, 'create', [10], { target, record, previous: null }), {
    target,
    record,
    previous: null,
  });
  // Native PreValidation Targets carry none.
  assert.equal(early.inputParameters.values.Target.formattedValues, undefined);
  const frame = phases(store, 'create', [10, 20], { target, record, previous: null });
  const prepared = {
    flag: 'No',
    hue: 'Red',
    // A Target's choices list their labels without the outer separators (native Create Targets: "Red; Blue").
    hues: 'Red; Blue',
    amount: '€3.5000',
    ratio: '1.5000',
    share: '2.25000',
    count: '7',
    seen: '2026-10-30T14:55:48+00:00',
    day: '2026-10-30T00:00:00',
    slot: '2026-10-30T10:00:00',
    statecode: 'Active',
  };
  // Target references are unnamed and carry none (native: transactioncurrencyid, createdby, ownerid).
  assert.deepEqual(
    context(store, 'create', 20, frame, { target, record, previous: null }).inputParameters.values.Target
      .formattedValues,
    prepared,
  );
  // A PreOperation plug-in's new attribute and the core operation's currency values carry none at PostOperation
  // (native pipelineEffects: pqwp_integer set at stage 20; crud: exchangerate and pqwp_money_base).
  Object.assign(target, { rank: 42, exchangerate: 1, amount_base: 3.5 });
  Object.assign(record, { rank: 42, exchangerate: 1, amount_base: 3.5 });
  phases(store, 'create', [40], { target, record, previous: null });
  assert.deepEqual(
    context(store, 'create', 40, frame, { target, record, previous: null }).inputParameters.values.Target
      .formattedValues,
    prepared,
  );
});

test('an Update Target carries formatted values only when the request entered as a multiple message', () => {
  const store = fixture(),
    previous = { ...store.tableRows('gadget')[0] },
    target = { flag: true, seen: '2026-10-31T09:00:00Z' },
    record = { ...previous, ...target };
  // Native: a Web API PATCH (Update inside Upsert) has none at any stage.
  const single = phases(store, 'update', [10, 20], { target, record, previous });
  for (const stage of [20, 40])
    assert.equal(
      context(store, 'update', stage, single, { target, record, previous }).inputParameters.values.Target
        .formattedValues,
      undefined,
    );
  // Native bulk: the Update of each UpdateMultiple target carries them from PreOperation on.
  const bulk = phases(store, 'update', [10, 20], { target, record, previous, bulkOrigin: true });
  assert.deepEqual(
    context(store, 'update', 20, bulk, { target, record, previous }).inputParameters.values.Target.formattedValues,
    { flag: 'Yes', seen: '2026-10-31T09:00:00+00:00' },
  );
});

// @test-kind unproven: the native corpus has one UTC application user; following usersettings.timezonecode is assumed
test('a user-local date is shown in the calling user’s time zone with its offset', () => {
  const store = fixture([{ systemuserid: caller, timezonecode: 4 }]),
    previous = { ...store.tableRows('gadget')[0] },
    record = { ...previous },
    target = { title: 'Changed' };
  const frame = phases(store, 'update', [10, 20], { target, record, previous });
  const answer = context(store, 'update', 20, frame, {
    target,
    record,
    previous,
    images: [{ alias: 'pre', type: 0, attributes: ['seen', 'day'] }],
  });
  // Pacific Standard Time (code 4) observes daylight time on 2026-10-30; a date-only value has no offset.
  assert.deepEqual(answer.preImages.pre.formattedValues, {
    seen: '2026-10-30T07:55:48-07:00',
    day: '2026-10-30T00:00:00',
  });
});

// @test-kind parity+contract: native crud Create Target/post image FormattedValues (money "₴3.5000", "No") read by an original DLL; UTF-8 host protocol is Paqvilo's own
test(
  'an original DLL reads the formatted values, and non-ASCII text crosses the CLR host intact',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-formatted-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Formatted.cs'),
      assembly = path.join(root, 'Formatted.dll');
    // The non-ASCII texts are C# \u escapes, so the source file stays ASCII.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;
namespace Invented {public sealed class Formatted:IPlugin {static void Expect(Entity e,string key,string text){string actual;if(!e.FormattedValues.TryGetValue(key,out actual)||actual!=text)throw new InvalidPluginExecutionException(key+" formatted as "+(actual??"<none>"));}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];
Expect(target,"amount","\\u20ac3.5000");Expect(target,"flag","No");
if(c.Stage==20)target["title"]="\\u041a\\u0438\\u0457\\u0432";
else{var after=c.PostEntityImages["after"];Expect(after,"amount","\\u20ac3.5000");if(after.FormattedValues.ContainsKey("title"))throw new InvalidPluginExecutionException("text formatted");}}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: path.basename(assembly),
        typeName: 'Invented.Formatted',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        context: { initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
        serviceProfile: { userId: caller, evidence: 'Invented formatted values', grants: [] },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      }),
      steps = [20, 40].map((stage, i) => ({
        id: '30000000-0000-0000-0000-' + String(i + 2).padStart(12, '0'),
        name: 'Formatted ' + stage,
        enabled: true,
        typeName: runtime.descriptor.typeName,
        assemblyId: 'invented-formatted',
        entity: 'gadget',
        message: 'Create',
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: stage === 40 ? [{ alias: 'after', name: 'after', type: 1, attributes: ['amount', 'title'] }] : [],
      })),
      runtimes = new Map(steps.map((s) => [s.id, runtime])),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((s) => ['plugin-step:' + s.id, { mode: 'clr' }])),
      }),
      store = fixture();
    store.state.tables.gadget = [];
    store.setPluginPipeline((ctx) => runPluginPhase({ ...ctx, store, items, runtimes }));
    const created = await store.create(
      'gadget',
      { gadgetid: id, title: 'Plain', flag: false, amount: 3.5, transactioncurrencyid: currency },
      { admin: true },
    );
    assert.equal(created.title, 'Київ');
  },
);

// @test-kind parity: native and native-r2 nullSemantics Create 20/40/async and CreateMultiple Targets FormattedValues pqwp_money/pqwp_choice/pqwp_dateonly null, no entry for null text/integer/boolean (3753, 6899)
test('a Create Target lists null money, choice and date values with a null formatted value only', () => {
  const store = fixture(),
    target = {
      gadgetid: '20000000-0000-0000-0000-000000000003',
      amount: null,
      hue: null,
      day: null,
      title: null,
      count: null,
      flag: null,
    },
    record = { ...target };
  store.state.tables.gadget = [];
  const frame = phases(store, 'create', [10, 20, 40], { target, record, previous: null });
  const nulls = { amount: null, hue: null, day: null };
  assert.deepEqual(
    context(store, 'create', 20, frame, { target, record, previous: null }).inputParameters.values.Target
      .formattedValues,
    nulls,
  );
  assert.deepEqual(
    context(store, 'create', 40, frame, { target, record, previous: null }).inputParameters.values.Target
      .formattedValues,
    nulls,
  );
  // Native PreValidation (stage 10) Targets carry no FormattedValues.
  assert.equal(
    context(store, 'create', 10, frame, { target, record, previous: null }).inputParameters.values.Target
      .formattedValues,
    undefined,
  );
});

// @test-kind parity: native and native-r2 nullSemantics Create 20/40/async and CreateMultiple Targets FormattedValues pqwp_money/pqwp_choice/pqwp_dateonly null, no entry for null text/integer/boolean (3753, 6899)
test('an Update Target lists no null formatted values, as native single Updates', () => {
  const store = fixture(),
    previous = { ...store.tableRows('gadget')[0] },
    target = { amount: null, hue: null, day: null, title: null, count: null, flag: null },
    record = { ...previous, ...target };
  const frame = phases(store, 'update', [10, 20], { target, record, previous });
  assert.equal(
    context(store, 'update', 20, frame, { target, record, previous }).inputParameters.values.Target.formattedValues,
    undefined,
  );
});

// @test-kind parity: native and native-r2 nullSemantics Create 20/40/async and CreateMultiple Targets FormattedValues pqwp_money/pqwp_choice/pqwp_dateonly null, no entry for null text/integer/boolean (3753, 6899)
test(
  'an original DLL reads a null money or choice formatted value as null, and a null text as unlisted',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-null-formatted-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'NullFormatted.cs'),
      assembly = path.join(root, 'NullFormatted.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;
namespace Invented {public sealed class NullFormatted:IPlugin {
static void ExpectNull(Entity e,string key){string actual;if(!e.FormattedValues.TryGetValue(key,out actual)||actual!=null)throw new InvalidPluginExecutionException(key+" formatted as "+(actual??"<none>"));}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];
ExpectNull(target,"amount");ExpectNull(target,"hue");
if(target.FormattedValues.ContainsKey("title"))throw new InvalidPluginExecutionException("text formatted");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: path.basename(assembly),
        typeName: 'Invented.NullFormatted',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        context: { initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
        serviceProfile: { userId: caller, evidence: 'Invented formatted values', grants: [] },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      }),
      step = {
        id: '30000000-0000-0000-0000-000000000009',
        name: 'Null formatted 20',
        enabled: true,
        typeName: runtime.descriptor.typeName,
        assemblyId: 'invented-null-formatted',
        entity: 'gadget',
        message: 'Create',
        stage: 20,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
      },
      items = pluginCatalogue({
        plugins: { steps: [step] },
        runtimes: new Map([[step.id, runtime]]),
        overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
      }),
      store = fixture();
    store.state.tables.gadget = [];
    store.setPluginPipeline((ctx) => runPluginPhase({ ...ctx, store, items, runtimes: new Map([[step.id, runtime]]) }));
    const created = await store.create(
      'gadget',
      { gadgetid: id, title: null, flag: false, amount: null, hue: null, transactioncurrencyid: currency },
      { admin: true },
    );
    assert.equal(created.gadgetid, id);
  },
);
