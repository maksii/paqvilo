// @test-kind contract: Paqvilo JavaScript typed/legacy image views and Context4 alignment mirroring the native image projection
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginInvocationParent } from '../lib/plugin-execution-lifetime.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const second = '10000000-0000-4000-8000-000000000002';
const profile = {
  userId: id,
  evidence: 'Invented image observer',
  grants: [{ entity: 'widget', operations: ['create', 'update'] }],
  bulkTables: [
    {
      entity: 'widget',
      tableType: 'standard',
      evidence: 'Invented standard bulk availability',
      messages: ['CreateMultiple', 'UpdateMultiple'],
    },
  ],
};
const images = (stage, message) => [
  ...[...(message === 'Create' ? [] : [0]), ...(stage === 40 && message !== 'Delete' ? [1] : [])].flatMap((type) =>
    [
      ['Null', ['title']],
      ['Values', ['flag', 'number', 'empty']],
      ['All', []],
      ['Primary', ['widgetid']],
    ].map(([name, attributes]) => ({ type, alias: name + (type ? 'Post' : 'Pre'), attributes })),
  ),
];
function fixture() {
  const state = emptyState();
  state.mappings.widget = {
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'title',
    fields: {
      title: { dataverseType: 'nvarchar' },
      flag: { dataverseType: 'bit' },
      number: { dataverseType: 'int' },
      empty: { dataverseType: 'nvarchar' },
    },
  };
  state.tables.widget = [{ widgetid: id, title: null, flag: false, number: 0, empty: '' }];
  return new DataStore({ state });
}
const steps = (message, typeNames) =>
  (message === 'Create' ? [40] : message === 'Delete' ? [10, 20, 40] : [20, 40]).flatMap((stage) =>
    typeNames.map((typeName, index) => ({
      id: `20000000-0000-4000-8000-${String(stage * 10 + index).padStart(12, '0')}`,
      enabled: true,
      entity: 'widget',
      message,
      stage,
      rank: index + 1,
      mode: 0,
      supportedDeployment: 0,
      typeName,
      assemblyId: 'invented',
      filteringAttributes: [],
      images: images(stage, message),
    })),
  );

test('JavaScript typed and legacy image views omit nulls while retaining false, zero and empty strings', async (t) => {
  const store = fixture(),
    seen = [];
  await attachClrSteps(t, {
    store,
    steps: steps('Update', ['Invented.Legacy', 'Invented.Typed']),
    runtime: () => null,
    handlers: new Map([
      [
        'Invented.Legacy',
        ({ stage, preImage, postImage, target }) => {
          assert.deepEqual(preImage, {});
          if (stage === 40) assert.deepEqual(postImage, {});
          assert.equal(Object.hasOwn(target, 'title'), true, 'Target retains an explicit null');
          assert.equal(target.title, null);
          seen.push(stage);
        },
      ],
      [
        'Invented.Typed',
        ({ context }) => {
          for (const [suffix, collection] of [
            ['Pre', context.PreEntityImages],
            ...(context.Stage === 40 ? [['Post', context.PostEntityImages]] : []),
          ]) {
            assert.deepEqual(collection['Null' + suffix], {});
            assert.deepEqual(collection['Values' + suffix], { flag: false, number: 0, empty: '' });
            assert.equal(Object.hasOwn(collection['All' + suffix], 'title'), false);
            assert.equal(collection['Primary' + suffix].widgetid, id);
          }
        },
      ],
    ]),
  });
  await store.update('widget', id, { title: null }, { admin: true });
  assert.deepEqual(seen, [20, 40]);
  assert.equal(store.tableRows('widget')[0].title, null, 'the stored null is not changed by image projection');
});

// Context4 sets per target; none before PostOperation and no Create pre-image sets (native bulk.json ev 1373/1376/1379).
for (const message of ['CreateMultiple', 'UpdateMultiple'])
  test(`typed JavaScript ${message} image collections align every target, including unavailable image slots`, async (t) => {
    const store = fixture();
    store.state.tables.widget.push({ ...store.tableRows('widget')[0], widgetid: second, title: 'Present' });
    if (message === 'CreateMultiple') store.state.tables.widget = [];
    const seen = [];
    await attachClrSteps(t, {
      store,
      steps: steps(message, ['Invented.BulkModel']),
      runtime: () => null,
      handlers: new Map([
        [
          'Invented.BulkModel',
          ({ context, previousRecords }) => {
            const pre = context.PreEntityImagesCollection,
              post = context.PostEntityImagesCollection;
            assert.equal(pre.length, message === 'CreateMultiple' ? 0 : 2);
            assert.equal(post.length, context.Stage === 40 ? 2 : 0);
            if (message === 'CreateMultiple') assert.deepEqual(pre, []);
            else {
              assert.deepEqual(pre[0].NullPre, {});
              assert.deepEqual(pre[1].NullPre, { title: 'Present' });
              assert.equal(previousRecords[0].title, null, 'legacy previousRecords remain raw snapshots');
            }
            if (context.Stage !== 40) assert.deepEqual(post, []);
            else {
              assert.deepEqual(post[0].NullPost, {});
              assert.deepEqual(post[1].NullPost, { title: 'Present' });
              assert.equal(post[0].PrimaryPost.widgetid, id);
              assert.equal(post[1].PrimaryPost.widgetid, second);
            }
            seen.push(context.Stage);
          },
        ],
      ]),
    });
    localOrganizationService(store, profile).bulk(
      message.toLowerCase(),
      [id, second].map((value, index) => ({
        $type: 'Entity',
        logicalName: 'widget',
        id: value,
        attributes: { title: index ? 'Present' : null, flag: false, number: 0, empty: '' },
      })),
    );
    assert.deepEqual(seen, [20, 40]);
  });

// @test-kind parity: native bulk.json capture 2026-10-30, ev 1407 and 1446 (repeated at 1454/1459): asynchronous bulk-origin CreateMultiple and UpdateMultiple without registered images have no pre-image sets and one AsynchronousStepPrimaryName set per target
for (const message of ['CreateMultiple', 'UpdateMultiple'])
  test(`asynchronous ${message} Context4 images hold one primary-name set per target and no pre-image sets`, () => {
    const store = fixture();
    const rows = [store.tableRows('widget')[0], { ...store.tableRows('widget')[0], widgetid: second }];
    const step = { ...steps(message, ['Invented.AsyncImages'])[1], mode: 1, images: [] };
    const handlers = new Map([
      [
        'Invented.AsyncImages',
        ({ context }) => {
          assert.deepEqual(context.PreEntityImagesCollection, []);
          assert.deepEqual(
            context.PostEntityImagesCollection,
            [id, second].map((widgetid) => ({ AsynchronousStepPrimaryName: { widgetid } })),
          );
        },
      ],
    ]);
    runPluginPhase({
      store,
      items: pluginCatalogue({ plugins: { steps: [step] }, handlers }),
      handlers,
      entity: 'widget',
      operation: message.toLowerCase(),
      stage: 40,
      asyncExecution: true,
      bulkOrigin: true,
      record: { widgetid: '00000000-0000-0000-0000-000000000000', bulkIds: [id, second] },
      targets: rows.map((row) => ({
        $type: 'Entity',
        logicalName: 'widget',
        id: row.widgetid,
        attributes: { title: null },
      })),
      previousRecords: message === 'CreateMultiple' ? [] : rows,
      records: rows,
      identity: { admin: true },
    });
  });

// @test-kind parity: native qualification of selected-null and selected-primary-key images: null Attributes omitted, image Id retained
test(
  'original CLR scalar and Context4 bulk image Entities omit null Attributes and retain independent identities',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-image-values-')),
      backends = [];
    t.after(async () => {
      for (const backend of backends) await backend.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Images.cs'),
      assembly = path.join(root, 'Images.dll');
    // Native qualification separately covers selected-null and selected-PK images;
    // read-result implicit primary Attributes are not evidence for image columns.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Observe:IPlugin{
static void Check(EntityImageCollection images,string suffix){var empty=images["Null"+suffix];if(empty.Id!=new Guid("${id}")||empty.Attributes.Count!=0)throw new Exception("Null image lost identity or retained null");var values=images["Values"+suffix];if(values.Attributes.Count!=3||values.GetAttributeValue<bool>("flag")||values.GetAttributeValue<int>("number")!=0||values.GetAttributeValue<string>("empty")!="")throw new Exception("Falsy image data lost");var all=images["All"+suffix];if(all.Contains("title")||all.GetAttributeValue<Guid>("widgetid")!=empty.Id)throw new Exception("All-column image null or primary mismatch");var primary=images["Primary"+suffix];if(primary.Attributes.Count!=1||primary.GetAttributeValue<Guid>("widgetid")!=empty.Id)throw new Exception("Selected primary mismatch");}
public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));EntityImageCollection selected;string suffix;if(c.MessageName=="UpdateMultiple"){var b=(IPluginExecutionContext4)c;if(b.PreEntityImagesCollection.Length!=1)throw new Exception("Bulk alignment lost");Check(b.PreEntityImagesCollection[0],"Pre");if(c.Stage==40)Check(b.PostEntityImagesCollection[0],"Post");selected=b.PreEntityImagesCollection[0];suffix="Pre";}else{if(c.MessageName!="Create")Check(c.PreEntityImages,"Pre");if(c.Stage==40&&c.MessageName!="Delete")Check(c.PostEntityImages,"Post");if(c.MessageName!="Delete"){var target=(Entity)c.InputParameters["Target"];if(!target.Contains("title")||target["title"]!=null)throw new Exception("Authored Target null was removed");}selected=c.MessageName=="Create"?c.PostEntityImages:c.PreEntityImages;suffix=c.MessageName=="Create"?"Post":"Pre";}c.OutputParameters["ImageFingerprint"]=selected["Null"+suffix].Attributes.Count+":"+selected["Values"+suffix].Attributes.Count+":"+selected["All"+suffix].Contains("title").ToString().ToLowerInvariant()+":"+selected["Primary"+suffix].GetAttributeValue<Guid>("widgetid").ToString("D");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Images.dll',
      typeName: 'Invented.Observe',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: profile,
      context: { executionUserId: id, initiatingUserId: id, organizationId: id, businessUnitId: id },
    });
    for (const message of ['Update', 'UpdateMultiple', 'Create', 'Delete']) {
      const store = fixture();
      const { backend } = await attachClrSteps(t, {
        store,
        steps: steps(message, ['Invented.Observe', 'Invented.Compare']),
        runtime: (step) => (step.typeName === 'Invented.Observe' ? runtime : null),
        handlers: new Map([
          [
            'Invented.Compare',
            ({ context }) => {
              const collection =
                message === 'UpdateMultiple'
                  ? context.PreEntityImagesCollection[0]
                  : message === 'Create'
                    ? context.PostEntityImages
                    : context.PreEntityImages;
              const suffix = message === 'Create' ? 'Post' : 'Pre';
              const fingerprint = `${Object.keys(collection['Null' + suffix]).length}:${Object.keys(collection['Values' + suffix]).length}:${Object.hasOwn(collection['All' + suffix], 'title')}:${collection['Primary' + suffix].widgetid}`;
              assert.equal(
                context.OutputParameters.ImageFingerprint,
                fingerprint,
                'original CLR and typed JavaScript project the same image Attributes',
              );
            },
          ],
        ]),
      });
      backends.push(backend);
      if (message === 'Update') await store.update('widget', id, { title: null }, { admin: true });
      else if (message === 'Create') {
        const input = structuredClone(store.tableRows('widget')[0]);
        store.state.tables.widget = [];
        await store.create('widget', input, { admin: true });
      } else if (message === 'Delete') await store.remove('widget', id, { admin: true });
      else
        localOrganizationService(store, profile).bulk(message.toLowerCase(), [
          { $type: 'Entity', logicalName: 'widget', id, attributes: { title: null } },
        ]);
      if (message === 'Delete') assert.equal(store.tableRows('widget').length, 0);
      else assert.equal(store.tableRows('widget')[0].title, null);
    }
  },
);

// @test-kind parity: native pipelineEffects corpus: a nested Create PreOperation parent is its own Create main operation (stage 30)
// @parity-evidence: native bulk.json ev 1373/1376 and crud.json ev 1612: a PreOperation *Multiple context has no post-image set (PostEntityImagesCollection [])
test(
  'a nested original CLR child receives JavaScript entry image snapshots while the author retains its live Context4 edits',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-parent-images-')),
      backends = [];
    t.after(async () => {
      for (const backend of backends) await backend.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'ParentImages.cs'),
      assembly = path.join(root, 'ParentImages.dll');
    // Native (parity corpus pipelineEffects): a nested Create PreOperation's parent is its own Create main operation; the caller is one level up.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Child:IPlugin{
static void Check(EntityImageCollection images){var empty=images["NullPre"];if(empty.Id!=new Guid("${id}")||empty.Attributes.Count!=0)throw new Exception("Parent entry image snapshot lost");var key=images["PrimaryPre"];if(key.Id!=new Guid("${id}")||key.GetAttributeValue<Guid>("widgetid")!=new Guid("${id}"))throw new Exception("Parent entry image identity changed");if(images["AllPre"].Contains("title"))throw new Exception("Snapshot null returned");}
public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var parent=c.ParentContext;if(parent==null||parent.MessageName!="Create"||parent.Stage!=30)throw new Exception("Main operation parent missing");parent=parent.ParentContext;if(parent==null)throw new Exception("Parent missing");if(parent.MessageName=="UpdateMultiple"){var b=parent as IPluginExecutionContext4;if(b==null||b.PreEntityImagesCollection.Length!=1||b.PostEntityImagesCollection.Length!=(parent.Stage==40?1:0))throw new Exception("Parent Context4 image alignment lost");Check(b.PreEntityImagesCollection[0]);if(parent.Stage==40&&(b.PostEntityImagesCollection[0]["NullPost"].Attributes.Count!=0||b.PostEntityImagesCollection[0]["NullPost"].Id!=new Guid("${id}")))throw new Exception("Parent post image lost");}else Check(parent.PreEntityImages);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Child',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: id, evidence: 'Invented parent image observer', grants: [] },
      context: { executionUserId: id, initiatingUserId: id, organizationId: id, businessUnitId: id },
    });
    for (const message of ['Update', 'UpdateMultiple']) {
      const store = fixture();
      store.state.mappings.child = { entitySet: 'children', idColumn: 'childid' };
      store.state.tables.child = [];
      const childStep = {
        ...steps('Update', ['Invented.Child'])[0],
        id: '30000000-0000-4000-8000-000000000001',
        entity: 'child',
        message: 'Create',
        images: [],
      };
      const { backend } = await attachClrSteps(t, {
        store,
        steps: [...steps(message, ['Invented.Parent']), childStep],
        runtime: (step) => (step.entity === 'child' ? runtime : null),
        handlers: new Map([
          [
            'Invented.Parent',
            ({ context }) => {
              const current =
                message === 'UpdateMultiple' ? context.PreEntityImagesCollection[0] : context.PreEntityImages;
              current.NullPre.title = null;
              current.PrimaryPre.widgetid = second;
              const parent = pluginInvocationParent(store).values;
              const wire =
                message === 'UpdateMultiple'
                  ? parent.PreEntityImagesCollection.values[0].values
                  : parent.PreEntityImages.values;
              assert.equal(wire.PrimaryPre.id, id);
              assert.equal(wire.PrimaryPre.attributes.widgetid.value, second);
              assert.equal(wire.NullPre.attributes.title, null);
              localOrganizationService(store, {
                userId: id,
                evidence: 'Invented nested image call',
                grants: [{ entity: 'child', operations: ['create'] }],
              }).create('child', { title: 'Observed parent images' });
              assert.equal(current.PrimaryPre.widgetid, second);
              assert.equal(current.NullPre.title, null);
            },
          ],
        ]),
      });
      backends.push(backend);
      if (message === 'Update') await store.update('widget', id, { title: null }, { admin: true });
      else
        localOrganizationService(store, profile).bulk('updatemultiple', [
          { $type: 'Entity', logicalName: 'widget', id, attributes: { title: null } },
        ]);
      assert.equal(store.tableRows('child').length, 2);
      assert.equal(store.tableRows('widget')[0].widgetid, id, 'image edits cannot change the saved row identity');
      assert.equal(store.tableRows('widget')[0].title, null);
    }
  },
);
