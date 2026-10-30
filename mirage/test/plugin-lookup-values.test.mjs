// @test-kind compatibility: Learn SDK lookup columns are EntityReference values; polymorphic inference unqualified; nativeQualified false
import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DataStore } from '../lib/data.mjs';
import { prepareClrRuntime, recordToSdkEntity } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const user = '10000000-0000-0000-0000-000000000001',
  id = '20000000-0000-0000-0000-000000000001',
  parent = '20000000-0000-0000-0000-000000000002',
  child = '20000000-0000-0000-0000-000000000003';
const fields = {
  parentid: { dataverseType: 'lookup', targets: ['widget'] },
  title: { dataverseType: 'string' },
  empty: { dataverseType: 'lookup', targets: ['widget'] },
};
const state = () => ({
  version: 1,
  mappings: {
    widget: {
      entitySet: 'widgets',
      idColumn: 'widgetid',
      fields,
      relationships: {
        parent: {
          schemaName: 'widget_parent',
          entity: 'widget',
          from: 'parentid',
          to: 'widgetid',
          many: false,
          partner: 'children',
        },
        children: {
          schemaName: 'widget_parent',
          entity: 'widget',
          from: 'widgetid',
          to: 'parentid',
          many: true,
          partner: 'parent',
        },
      },
    },
  },
  tables: {
    widget: [
      { widgetid: parent, title: 'Parent' },
      { widgetid: child, title: 'Child', parentid: null, empty: null },
    ],
  },
  plugins: [],
  settings: { permissionMode: 'permissive' },
});
test('Monomorphic source-declared lookup GUIDs retain SDK EntityReference; ambiguous target and invalid GUID are explicit', () => {
  const store = new DataStore({ state: state() }),
    convert = (value) => recordToSdkEntity(store, 'widget', { widgetid: id, parentid: value }).attributes.parentid;
  assert.deepEqual(convert(parent.toUpperCase()), {
    $type: 'EntityReference',
    logicalName: 'widget',
    id: parent,
    name: null,
  });
  assert.equal(convert(null), null);
  assert.deepEqual(convert({ id: parent, logical_name: 'widget', name: 'Parent' }), {
    $type: 'EntityReference',
    logicalName: 'widget',
    id: parent,
    name: 'Parent',
  });
  assert.deepEqual(recordToSdkEntity(store, 'widget', { widgetid: id, title: parent }).attributes.title, parent);
  store.state.mappings.widget.fields.parentid.targets = undefined;
  assert.deepEqual(convert(parent), {
    $type: 'EntityReference',
    logicalName: 'widget',
    id: parent,
    name: null,
  });
  const sourceParent = store.state.mappings.widget.relationships.parent;
  delete store.state.mappings.widget.relationships.parent;
  try {
    assert.throws(() => convert(parent), /one exact source-declared target/);
  } finally {
    store.state.mappings.widget.relationships.parent = sourceParent;
  }
  for (const targets of [[], ['widget', 'other'], ['invalid name']]) {
    store.state.mappings.widget.fields.parentid.targets = targets;
    assert.throws(() => convert(parent), /one exact source-declared target/);
  }
  store.state.mappings.widget.fields.parentid.targets = ['widget'];
  assert.throws(() => convert('invalid-guid'), /one exact source-declared target/);
});
test(
  'Actual original DLL casts raw lookup GUID Target/postimage/SDK Retrieve and source self-association bind/clear',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-lookup-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'LookupValues.cs'),
      assembly = path.join(root, 'LookupValues.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class LookupValues:IPlugin {static void Check(Entity e){var r=e.GetAttributeValue<EntityReference>("parentid");if(r==null||r.Id!=new Guid("${parent}")||r.LogicalName!="widget"||e.GetAttributeValue<EntityReference>("empty")!=null)throw new Exception("Source lookup type lost");}public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));Check((Entity)c.InputParameters["Target"]);var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);if(c.Stage==20){var relationship=new Relationship("widget_parent"){PrimaryEntityRole=EntityRole.Referencing};var references=new EntityReferenceCollection{new EntityReference("widget",new Guid("${parent}"))};var added=(AssociateResponse)s.Execute(new AssociateRequest{Target=new EntityReference("widget",new Guid("${child}")),Relationship=relationship,RelatedEntities=references});Check(s.Retrieve("widget",new Guid("${child}"),new ColumnSet("parentid","empty")));var gone=(DisassociateResponse)s.Execute(new DisassociateRequest{Target=new EntityReference("widget",new Guid("${child}")),Relationship=relationship,RelatedEntities=references});if(s.Retrieve("widget",new Guid("${child}"),new ColumnSet("parentid")).GetAttributeValue<EntityReference>("parentid")!=null)throw new Exception("Source lookup clear lost");}else{Check(c.PostEntityImages["after"]);Check(s.Retrieve("widget",c.PrimaryEntityId,new ColumnSet("parentid","empty")));}((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original lookup casts stage {0}",c.Stage);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: path.basename(assembly),
        typeName: 'Invented.LookupValues',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        context: {
          initiatingUserId: user,
          organizationId: '50000000-0000-0000-0000-000000000001',
          businessUnitId: '60000000-0000-0000-0000-000000000001',
        },
        serviceProfile: {
          userId: user,
          evidence: 'Invented source monomorphic self-lookup/relationship',
          grants: [{ entity: 'widget', operations: ['read', 'associate', 'disassociate', 'update'] }],
        },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      }),
      steps = [20, 40].map((stage, i) => ({
        id: '30000000-0000-0000-0000-' + String(i + 1).padStart(12, '0'),
        name: 'Original lookup ' + stage,
        enabled: true,
        typeName: runtime.descriptor.typeName,
        assemblyId: 'invented-lookup',
        entity: 'widget',
        message: 'Create',
        stage,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: stage === 40 ? [{ alias: 'after', name: 'after', type: 1, attributes: ['parentid', 'empty'] }] : [],
      })),
      runtimes = new Map(steps.map((s) => [s.id, runtime])),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((s) => ['plugin-step:' + s.id, { mode: 'clr' }])),
      }),
      store = new DataStore({ state: state(), file: path.join(root, 'state.json') }),
      notes = [];
    store.setPluginPipeline(
      (ctx) => runPluginPhase({ ...ctx, store, items, runtimes, diagnostic: (n) => notes.push(n) }),
      (ctx) => ctx.entity === 'widget' && ctx.operation === 'create',
    );
    const row = await store.create(
      'widget',
      { widgetid: id, parentid: parent, empty: null, title: 'Own caller' },
      { admin: true },
    );
    assert.deepEqual(row.parentid, { id: parent, logical_name: 'widget' });
    assert.equal(store.get('widget', child, { admin: true }).parentid, null);
    assert.equal(notes.filter((n) => n.code === 'PLUGIN_CLR_TRACE').length, 2);
    const stopped = notes.filter((n) => n.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(stopped.length, 2);
    assert.ok(stopped.every((n) => n.absenceVerified));
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (p) =>
        createHash('sha256')
          .update(await fs.readFile(p))
          .digest('hex');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.lookup-values.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: stopped.length, allAbsenceVerified: true },
            assertions: [
              'Source monomorphic raw GUID Target/postimage/SDK Retrieve cast to EntityReference',
              'Original named SDK AssociateResponse/DisassociateResponse casts and source self1:N bind then clear',
              'Null lookup remains null; native and polymorphic inference unqualified',
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
