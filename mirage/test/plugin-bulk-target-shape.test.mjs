// @test-kind parity: native and native-r2 bulk (CreateMultiple/UpdateMultiple Targets 10/20/40) and currency CreateMultiple/40: no versionnumber, null createdonbehalfby or owningteam, unnamed references without lookup FormattedValues, whole-second createdon, UpdateMultiple Targets carry the key
// Web API CreateMultiple/UpdateMultiple Target shapes as the plug-in steps see them, against the native bulk captures
// (native-r2 bulk 4774/4777/4783/4789). Invented table and identities only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const caller = '10000000-0000-0000-0000-000000000001';
const id = '20000000-0000-0000-0000-000000000001';
const wholeSecond = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const step = (message, stage, index) => ({
  id: `30000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: `Invented.${message}${stage}`,
  assemblyId: 'invented',
});
const stepsFor = (messages) =>
  messages.flatMap(([message, stages], messageIndex) =>
    stages.map((stage, stageIndex) => step(message, stage, messageIndex * 10 + stageIndex + 1)),
  );
const entities = (targets) => (Array.isArray(targets) ? targets : (targets?.entities ?? null));

// The JavaScript steps record what the bulk pipeline hands them and hand the grouped Targets back unchanged.
async function fixture(t, steps, { runtimes = new Map(), overrides = {} } = {}) {
  const f = await contractModuleFixture(t, {
    mappings: {
      systemuser: {
        logicalName: 'systemuser',
        entitySet: 'systemusers',
        idColumn: 'systemuserid',
        nameColumn: 'fullname',
        fields: { fullname: { dataverseType: 'nvarchar' } },
      },
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        ownership: 'UserOwned',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_keep: { dataverseType: 'nvarchar' },
          statecode: { dataverseType: 'state', options: [{ value: 0, label: 'Active' }] },
          statuscode: { dataverseType: 'status', options: [{ value: 1, label: 'Active' }] },
          x_flag: { dataverseType: 'bit' },
          x_when: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' },
        },
      },
    },
    tables: {
      systemuser: [{ systemuserid: caller, fullname: 'Invented caller' }],
      x_item: [{ x_itemid: id, x_name: 'Existing', x_keep: 'Keep' }],
    },
    extension: { name: 'bulk-target-shape-probe', install: () => {} },
  });
  const seen = [];
  const handlers = new Map(
    steps.map((s) => [
      s.typeName,
      (arg) => {
        seen.push({
          at: `${arg.operation}/${arg.stage}`,
          targets: arg.targets ?? null,
          target: arg.targets ? null : (arg.target ?? null),
        });
        if (arg.targets) return { targets: arg.targets };
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers, overrides, runtimes });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    handlers,
    runtimes,
    descriptors: new Map([...runtimes].map(([key, runtime]) => [key, runtime.descriptor])),
  });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

test('CreateMultiple Targets at 20 and 40 carry the platform stamps without versionnumber or empty on-behalf/team lookups, with whole-second times', async (t) => {
  const f = await fixture(
    t,
    stepsFor([
      ['CreateMultiple', [10, 20, 40]],
      ['Create', [10, 20, 40]],
    ]),
  );
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
    Targets: [{ x_name: 'One' }],
  });
  assert.equal(response.status, 200, await response.text());
  await f.backend.settle();
  // The row keeps its stored row version: the write derives it again after the Targets left it out.
  const row = f.store.tableRows('x_item').find((candidate) => candidate.x_name === 'One');
  assert.ok(row?.versionnumber != null, 'the created row keeps its versionnumber');
  const grouped = f.seen.filter((entry) => entry.at === 'createmultiple/20' || entry.at === 'createmultiple/40');
  assert.deepEqual(
    grouped.map((entry) => entry.at),
    ['createmultiple/20', 'createmultiple/40'],
  );
  for (const entry of grouped) {
    const [target] = entry.targets;
    assert.ok(target, `${entry.at} sees the created Target`);
    for (const name of ['versionnumber', 'createdonbehalfby', 'owningteam'])
      assert.equal(Object.hasOwn(target.attributes, name), false, `${entry.at} has no ${name}`);
    assert.match(target.attributes.createdon.value, wholeSecond, `${entry.at} createdon is whole seconds`);
    assert.match(target.attributes.modifiedon.value, wholeSecond, `${entry.at} modifiedon is whole seconds`);
  }
  // Native bulk stage-40 Targets name no lookup.
  const [after] = grouped[1].targets;
  for (const name of ['createdby', 'modifiedby', 'ownerid', 'owninguser'])
    assert.equal(after.attributes[name]?.name ?? null, null, `${name} is unnamed at 40`);
  // The per-record bridged Create Targets (the record's own Create/20 and Create/40) carry the same shape.
  const bridged = f.seen.filter((entry) => entry.at === 'create/20' || entry.at === 'create/40');
  assert.deepEqual(
    bridged.map((entry) => entry.at),
    ['create/20', 'create/40'],
  );
  for (const entry of bridged) {
    for (const name of ['versionnumber', 'createdonbehalfby', 'owningteam'])
      assert.equal(Object.hasOwn(entry.target, name), false, `${entry.at} has no ${name}`);
    assert.match(entry.target.createdon, wholeSecond, `${entry.at} createdon is whole seconds`);
  }
});

test(
  'a CLR CreateMultiple PostOperation Target names no lookup and keeps the state, status, boolean and date labels',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-bulk-target-shape-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'TargetShape.cs'),
      assembly = path.join(root, 'TargetShape.dll');
    // Native bulk stage 40: the lookup references are unnamed and carry no FormattedValues; the labels stay.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;
namespace Invented {
public sealed class Check40:IPlugin{public void Execute(IServiceProvider s){var c=(IPluginExecutionContext)s.GetService(typeof(IPluginExecutionContext));var e=((EntityCollection)c.InputParameters["Targets"]).Entities[0];
if(e.FormattedValues.Contains("createdby")||e.FormattedValues.Contains("ownerid"))throw new InvalidPluginExecutionException("Lookup FormattedValues at 40");
if(!e.FormattedValues.Contains("statecode")||e.FormattedValues["statecode"]!="Active")throw new InvalidPluginExecutionException("State label lost at 40");
var by=e.GetAttributeValue<EntityReference>("createdby");if(by==null||by.Name!=null)throw new InvalidPluginExecutionException("Lookup named at 40");
if(!e.FormattedValues.Contains("x_flag")||e.FormattedValues["x_flag"]!="Yes")throw new InvalidPluginExecutionException("Boolean label lost at 40");
if(!e.FormattedValues.Contains("x_when"))throw new InvalidPluginExecutionException("Date label lost at 40");
if(e.Contains("versionnumber")||e.Contains("createdonbehalfby")||e.Contains("owningteam"))throw new InvalidPluginExecutionException("Platform-only column at 40");}}
public sealed class Create10:IPlugin{public void Execute(IServiceProvider s){}}
public sealed class Create20:IPlugin{public void Execute(IServiceProvider s){}}
public sealed class Create40:IPlugin{public void Execute(IServiceProvider s){}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const base = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'TargetShape.dll',
      typeName: 'Invented.Check40',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: {
        userId: caller,
        evidence: 'Invented bulk Target shape',
        grants: [{ entity: 'x_item', operations: ['read'] }],
      },
      context: { initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
      timeoutMs: 30000,
    });
    // The per-record Create steps re-encode each record's Target between the grouped stages (plugin-bulk.mjs recordPhase).
    const steps = [
      { ...step('CreateMultiple', 40, 99), typeName: 'Invented.Check40', assemblyName: 'TargetShape' },
      ...stepsFor([['Create', [10, 20, 40]]]).map((s) => ({
        ...s,
        typeName: `Invented.Create${s.stage}`,
        assemblyName: 'TargetShape',
      })),
    ];
    const runtimes = new Map(steps.map((s) => [s.id, retypeClrRuntime(base, { typeName: s.typeName })]));
    const f = await fixture(t, steps, {
      runtimes,
      overrides: Object.fromEntries(steps.map((s) => [`plugin-step:${s.id}`, { mode: 'clr' }])),
    });
    const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
      Targets: [{ x_name: 'One', x_flag: true, x_when: '2026-10-30T14:55:48Z' }],
    });
    assert.equal(response.status, 200, await response.text());
  },
);

test('UpdateMultiple Targets and the bridged Update Targets carry the table primary key at 10, 20 and 40', async (t) => {
  const f = await fixture(
    t,
    stepsFor([
      ['UpdateMultiple', [10, 20, 40]],
      ['Update', [10, 40]],
    ]),
  );
  const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.UpdateMultiple', {
    Targets: [{ x_itemid: id, x_name: 'Changed' }],
  });
  assert.equal(response.status, 204, await response.text());
  await f.backend.settle();
  assert.equal(f.store.tableRows('x_item')[0].x_name, 'Changed');
  const grouped = f.seen.filter((entry) => entry.at.startsWith('updatemultiple/'));
  assert.deepEqual(
    grouped.map((entry) => entry.at),
    ['updatemultiple/10', 'updatemultiple/20', 'updatemultiple/40'],
  );
  for (const entry of grouped) {
    const [target] = entities(entry.targets);
    assert.equal(target.id, id, `${entry.at} names the record`);
    assert.equal(target.attributes.x_itemid?.value, id, `${entry.at} carries the primary key`);
  }
  const single = f.seen.filter((entry) => entry.at.startsWith('update/'));
  assert.deepEqual(
    single.map((entry) => entry.at),
    ['update/10', 'update/40'],
  );
  for (const entry of single) assert.equal(entry.target.x_itemid, id, `${entry.at} carries the primary key`);
});
