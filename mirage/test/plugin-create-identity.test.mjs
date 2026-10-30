import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';

test(
  'original CLR Create and Update retain native identity mutations, generated attributes and stable saved keys',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-create-identity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const user = '10000000-0000-0000-0000-000000000001',
      sdk = clrSdk(),
      source = path.join(root, 'Identity.cs'),
      assembly = path.join(root, 'Identity.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class PreKey:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];if(t.GetAttributeValue<bool>("mutate10"))t.Id=Guid.Parse(t.GetAttributeValue<string>("replacewith"));}}public sealed class RejectFinal:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(((Entity)c.InputParameters["Target"]).GetAttributeValue<bool>("reject"))throw new InvalidPluginExecutionException("Rejected effective identity after main");}}public sealed class ChangeIdentity:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];if(t.GetAttributeValue<bool>("mutate"))t.Id=new Guid("10000000-0000-0000-0000-000000000098");}}public sealed class Identity:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var expected=target.GetAttributeValue<bool>("mutate10")&&c.Stage==10?Guid.Parse(target.GetAttributeValue<string>("replacewith")):target.GetAttributeValue<bool>("mutate")&&c.Stage!=10&&!(c.MessageName=="Update"&&c.Stage==40)?new Guid("10000000-0000-0000-0000-000000000098"):c.PrimaryEntityId;if(c.PrimaryEntityId==Guid.Empty||target.Id!=expected||target.Id==Guid.Empty&&c.Stage!=10)throw new Exception("Message identity missing: "+c.MessageName+":"+c.Stage+":"+target.Id+":"+expected+":"+c.PrimaryEntityId+":"+target.GetAttributeValue<bool>("mutate10"));bool key=target.Contains("widgetid");bool supplied=target.GetAttributeValue<bool>("supplied");if(key!=(supplied||c.Stage!=10))throw new Exception("Wrong primary-key attribute stage");if(key&&(Guid)target["widgetid"]!=c.PrimaryEntityId)throw new Exception("Primary key differs from original identity");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Identity',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented identity observer', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [];
    const store = new DataStore({ state });
    const steps = [10, 20, 40].map((stage, index) => ({
      id: `30000000-0000-0000-0000-00000000000${index}`,
      enabled: true,
      entity: 'widget',
      message: 'Create',
      stage,
      mode: 0,
      rank: 3,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Identity',
      assemblyId: 'invented',
    }));
    steps.push({
      ...steps[1],
      id: '30000000-0000-0000-0000-000000000099',
      rank: 1,
      typeName: 'Invented.ChangeIdentity',
    });
    steps.push({ ...steps[1], id: '30000000-0000-0000-0000-000000000097', rank: 2, typeName: 'Invented.Bridge' });
    steps.push(
      ...steps.map((step, index) => ({
        ...step,
        id: `40000000-0000-0000-0000-00000000000${index}`,
        message: 'Update',
      })),
    );
    steps.push(
      { ...steps[0], id: '50000000-0000-0000-0000-000000000001', rank: 1, typeName: 'Invented.PreKey' },
      { ...steps[0], id: '50000000-0000-0000-0000-000000000002', rank: 2, typeName: 'Invented.Bridge' },
      { ...steps[2], id: '50000000-0000-0000-0000-000000000003', rank: 4, typeName: 'Invented.RejectFinal' },
      { ...steps[1], id: '50000000-0000-0000-0000-000000000004', rank: 4, typeName: 'Invented.Collision' },
      { ...steps[2], id: '50000000-0000-0000-0000-000000000005', rank: 2, typeName: 'Invented.Bridge' },
    );
    const variants = new Map(
      ['Invented.ChangeIdentity', 'Invented.PreKey', 'Invented.RejectFinal'].map((typeName) => [
        typeName,
        retypeClrRuntime(runtime, { typeName }),
      ]),
    );
    const snapshots = [];
    await attachClrSteps(t, {
      store,
      steps,
      runtime: (step) =>
        ['Invented.Bridge', 'Invented.Collision'].includes(step.typeName)
          ? null
          : (variants.get(step.typeName) ?? runtime),
      handlers: new Map([
        [
          'Invented.Bridge',
          ({ context }) => {
            if (context.InputParameters.Target.mutate10)
              snapshots.push({
                stage: context.Stage,
                primary: context.PrimaryEntityId,
                id: context.InputParameters.Target.widgetid,
              });
          },
        ],
        [
          'Invented.Collision',
          ({ context }) => {
            if (!context.InputParameters.Target.nestedcollision) return;
            localOrganizationService(store, {
              userId: user,
              evidence: 'Invented nested identity collision',
              grants: [{ entity: 'widget', operations: ['create'] }],
            }).create('widget', {
              widgetid: context.InputParameters.Target.widgetid,
              supplied: true,
              title: 'Nested competing row',
            });
          },
        ],
      ]),
    });
    await store.create('widget', { title: 'Generated' }, { admin: true });
    await store.create('widget', { widgetid: user, supplied: true }, { admin: true });
    assert.equal(store.tableRows('widget').length, 2);
    const original = '10000000-0000-0000-0000-000000000099';
    await store.create('widget', { widgetid: original, supplied: true, mutate: true }, { admin: true });
    assert.ok(store.tableRows('widget').some((row) => row.widgetid === original));
    assert.ok(!store.tableRows('widget').some((row) => row.widgetid === '10000000-0000-0000-0000-000000000098'));
    const replacement = '10000000-0000-0000-0000-000000000098';
    await store.create(
      'widget',
      { widgetid: replacement, supplied: true, title: 'Replacement row unchanged' },
      { admin: true },
    );
    await store.update(
      'widget',
      original,
      { widgetid: original, supplied: true, mutate: true, title: 'Original row updated' },
      { admin: true },
    );
    assert.equal(store.tableRows('widget').find((row) => row.widgetid === original).title, 'Original row updated');
    assert.equal(
      store.tableRows('widget').find((row) => row.widgetid === replacement).title,
      'Replacement row unchanged',
    );
    // Repeated native qualification establishes this stage10-to20 transition
    // independently of any implicit multiple-message registration behavior.
    const chosen = '10000000-0000-0000-0000-000000000095';
    const adopted = await store.create('widget', { mutate10: true, replacewith: chosen }, { admin: true });
    assert.equal(adopted.widgetid, chosen);
    const provided = '10000000-0000-0000-0000-000000000094',
      ignored = '10000000-0000-0000-0000-000000000093';
    const retained = await store.create(
      'widget',
      { widgetid: provided, supplied: true, mutate10: true, replacewith: ignored },
      { admin: true },
    );
    assert.equal(retained.widgetid, provided);
    assert.ok(!store.tableRows('widget').some((row) => row.widgetid === ignored));
    const empty = '00000000-0000-0000-0000-000000000000';
    snapshots.length = 0;
    const regenerated = await store.create('widget', { mutate10: true, replacewith: empty }, { admin: true });
    assert.notEqual(regenerated.widgetid, empty);
    assert.notEqual(regenerated.widgetid, snapshots[0].primary, 'an empty pre10 Id requests a fresh allocation');
    assert.equal(snapshots[0].stage, 10);
    assert.equal(snapshots[0].id, undefined, 'the generated primary attribute stays absent in stage10');
    assert.deepEqual(
      snapshots.slice(1),
      [20, 40].map((stage) => ({ stage, primary: regenerated.widgetid, id: regenerated.widgetid })),
    );
    assert.ok(!store.tableRows('widget').some((row) => row.widgetid === snapshots[0].primary));
    const suppliedEmpty = '10000000-0000-0000-0000-000000000090';
    assert.equal(
      (
        await store.create(
          'widget',
          { widgetid: suppliedEmpty, supplied: true, mutate10: true, replacewith: empty },
          { admin: true },
        )
      ).widgetid,
      suppliedEmpty,
    );
    const before = structuredClone(store.tableRows('widget'));
    await assert.rejects(store.create('widget', { mutate10: true, replacewith: chosen }, { admin: true }), {
      code: 'DuplicateRecord',
    });
    await assert.rejects(
      store.create('widget', { mutate10: true, replacewith: ignored, nestedcollision: true }, { admin: true }),
      { code: 'DuplicateRecord' },
    );
    await assert.rejects(
      store.create('widget', { mutate10: true, replacewith: ignored, reject: true }, { admin: true }),
      /Rejected effective identity after main/,
    );
    await assert.rejects(
      store.create('widget', { mutate10: true, replacewith: empty, reject: true }, { admin: true }),
      /Rejected effective identity after main/,
    );
    const originalIds = store.ids;
    const originalPipeline = store.pluginPipeline;
    let allocations = 0;
    let pipelineDepth = 0;
    // Request/correlation GUIDs belong to the pipeline, independently of the
    // two main-operation identity allocations this collision case controls.
    store.pluginPipeline = Object.assign((context) => {
      pipelineDepth++;
      try {
        return originalPipeline(context);
      } finally {
        pipelineDepth--;
      }
    }, originalPipeline);
    store.ids = { uuid: () => (pipelineDepth ? originalIds.uuid() : ++allocations === 1 ? ignored : chosen) };
    try {
      await assert.rejects(store.create('widget', { mutate10: true, replacewith: empty }, { admin: true }), {
        code: 'DuplicateRecord',
      });
      assert.equal(allocations, 2);
    } finally {
      store.ids = originalIds;
      store.pluginPipeline = originalPipeline;
    }
    assert.deepEqual(
      store.tableRows('widget'),
      before,
      'collisions and a failed main pipeline preserve every existing row',
    );
    store.state.settings.permissionMode = 'enforce';
    store.state.permissions = [
      { entity: 'widget', operations: ['create'], roles: ['Writer'], scope: 'contact', field: 'widgetid' },
    ];
    const allowed = '10000000-0000-0000-0000-000000000091',
      visitor = { roles: ['Writer'], contactId: allowed };
    await assert.rejects(
      store.create('widget', { mutate10: true, replacewith: ignored }, visitor),
      (error) => error.status === 403,
    );
    await assert.rejects(
      store.create('widget', { mutate10: true, replacewith: empty }, visitor),
      (error) => error.status === 403,
    );
    assert.deepEqual(store.tableRows('widget'), before, 'a denied effective key creates no row');
    assert.equal((await store.create('widget', { mutate10: true, replacewith: allowed }, visitor)).widgetid, allowed);
  },
);
