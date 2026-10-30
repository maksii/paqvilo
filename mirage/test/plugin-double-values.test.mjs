import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DataStore } from '../lib/data.mjs';
import { prepareClrRuntime, recordToSdkEntity, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkValueToRecord } from '../lib/local-organization-service.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const user = '10000000-0000-0000-0000-000000000001',
  id = '20000000-0000-0000-0000-000000000001',
  rowid = '20000000-0000-0000-0000-000000000002';
const fields = {
  fraction: { dataverseType: 'double' },
  integral: { dataverseType: 'float' },
  negative: { dataverseType: 'double' },
  empty: { dataverseType: 'double' },
};
const state = () => ({
  version: 1,
  mappings: {
    widget: { entitySet: 'widgets', idColumn: 'widgetid', fields },
    reading: { entitySet: 'readings', idColumn: 'readingid', fields },
  },
  tables: { widget: [], reading: [{ readingid: rowid, fraction: 0.1, integral: 2, negative: -0.5, empty: null }] },
  plugins: [],
  settings: { permissionMode: 'permissive' },
});
const profile = {
  userId: user,
  evidence: 'Invented declared IEEE Double SDK columns',
  grants: [
    { entity: 'widget', operations: ['read'] },
    { entity: 'reading', operations: ['read', 'update'] },
  ],
};
test('Declared Double/Float source values retain SDK type including integral values and reject nonfinite shapes', () => {
  const store = new DataStore({ state: state() }),
    convert = (v) => recordToSdkEntity(store, 'widget', { widgetid: id, fraction: v }).attributes.fraction;
  for (const v of [0, 2, -2, 0.1, -0.5, 1e-100, '2', '0.1'])
    assert.deepEqual(convert(v), { $type: 'Double', value: String(Number(v)) });
  assert.equal(convert(null), null);
  for (const v of [NaN, Infinity, -Infinity, true, '', [], {}, 'NaN', 'Infinity', '1e999'])
    assert.throws(() => convert(v), /finite numeric/);
  assert.equal(sdkValueToRecord({ $type: 'Double', value: '2' }), 2);
  assert.equal(sdkValueToRecord({ $type: 'Double', value: '0.1' }), 0.1);
  for (const v of [Infinity, NaN, true, 'Infinity', 'NaN', '1e999', {}])
    assert.throws(() => sdkValueToRecord({ $type: 'Double', value: v }), /finite numeric/);
  assert.deepEqual(recordToSdkEntity(store, 'widget', { widgetid: id, integral: 2 }).attributes.integral, {
    $type: 'Double',
    value: '2',
  });
  const query =
      '<fetch aggregate="true"><entity name="reading"><attribute name="fraction" aggregate="sum" alias="total"/></entity></fetch>',
    collection = dispatchSdkCall({
      store,
      profile,
      message: { method: 'RetrieveMultiple', arguments: [{ $type: 'FetchExpression', query }], userId: user },
    });
  assert.deepEqual(collection.entities[0].attributes.total.value, { $type: 'Double', value: '0.1' });
});
test(
  'Actual original DLL casts Double Targets/images/SDK reads and preserves integral shared/output values and SDK writes',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-double-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'DoubleValues.cs'),
      assembly = path.join(root, 'DoubleValues.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;using Microsoft.Xrm.Sdk.Messages;
namespace Invented {public sealed class DoubleValues:IPlugin {static void Check(Entity e,double integral,bool authoredNull=false){if(!(e["fraction"] is Double)||e.GetAttributeValue<double>("fraction")!=0.1d||!(e["integral"] is Double)||e.GetAttributeValue<double>("integral")!=integral||!(e["negative"] is Double)||e.GetAttributeValue<double>("negative")!=-0.5d)throw new Exception("Declared Double SDK type lost");if(authoredNull?(!e.Contains("empty")||e["empty"]!=null):e.Contains("empty"))throw new Exception("Authored null versus read/image omission lost");}
public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];Check(target,c.Stage==40?3d:2d,true);var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
if(c.Stage==20){c.SharedVariables["integralDouble"]=2d;c.OutputParameters["customDouble"]=2d;Check(s.Retrieve("reading",new Guid("${rowid}"),new ColumnSet("fraction","integral","negative","empty")),2d);target["integral"]=3d;var update=new Entity("reading",new Guid("${rowid}"));update["integral"]=3d;s.Update(update);Check(s.Retrieve("reading",update.Id,new ColumnSet("fraction","integral","negative","empty")),3d);var a=s.RetrieveMultiple(new FetchExpression("<fetch aggregate='true'><entity name='reading'><attribute name='fraction' aggregate='sum' alias='total'/></entity></fetch>"));if(!(((AliasedValue)a.Entities[0]["total"]).Value is Double)||(double)((AliasedValue)a.Entities[0]["total"]).Value!=0.1d)throw new Exception("Aggregate Double lost");}
if(c.Stage==40){if(!(c.SharedVariables["integralDouble"] is Double)||(double)c.SharedVariables["integralDouble"]!=2d||!(c.OutputParameters["customDouble"] is Double))throw new Exception("Integral Double ranked context lost");Check(c.PostEntityImages["after"],3d);Check(s.Retrieve("widget",c.PrimaryEntityId,new ColumnSet("fraction","integral","negative","empty")),3d);c.OutputParameters["customDouble"]=3d;}((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original declared Double stage {0}",c.Stage);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: path.basename(assembly),
        typeName: 'Invented.DoubleValues',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        context: {
          initiatingUserId: user,
          organizationId: '50000000-0000-0000-0000-000000000001',
          businessUnitId: '60000000-0000-0000-0000-000000000001',
        },
        serviceProfile: profile,
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      }),
      steps = [20, 40].map((stage, i) => ({
        id: '30000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'),
        name: 'Declared double ' + stage,
        enabled: true,
        typeName: runtime.descriptor.typeName,
        assemblyId: 'invented-double',
        entity: 'widget',
        message: 'Create',
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: stage === 40 ? [{ alias: 'after', name: 'after', type: 1, attributes: Object.keys(fields) }] : [],
      })),
      runtimes = new Map(steps.map((s) => [s.id, runtime])),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((s) => ['plugin-step:' + s.id, { mode: 'clr' }])),
      }),
      store = new DataStore({ state: state(), file: path.join(root, 'state.json') }),
      notes = [];
    store.setPluginPipeline((ctx) =>
      runPluginPhase({ ...ctx, store, items, runtimes, diagnostic: (n) => notes.push(n) }),
    );
    const row = await store.create(
      'widget',
      { widgetid: id, fraction: 0.1, integral: 2, negative: -0.5, empty: null },
      { admin: true },
    );
    assert.equal(row.integral, 3);
    assert.equal(store.get('reading', rowid, { admin: true }).integral, 3);
    const stops = notes.filter((n) => n.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(stops.length, 2);
    assert.ok(stops.every((n) => n.absenceVerified));
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (p) =>
        createHash('sha256')
          .update(await fs.readFile(p))
          .digest('hex');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.double-values.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: stops.length, allAbsenceVerified: true },
            assertions: [
              'Source-declared fractional/integral/negative Double Target, SDK Retrieve, aggregate AliasedValue and post image',
              'Authored Target null retained; native SDK read and image Attributes omit null',
              'Integral Double SharedVariables and custom Outputs survive ranked original CLR context',
              'Original SDK Update and Target mutation retain Double type on readback',
            ],
            nativeQualified: false,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    }
  },
);
