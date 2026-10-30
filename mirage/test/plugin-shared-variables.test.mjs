import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { user, existing, storeFixture } from './fixtures/plugin-widget-store.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('Explicit error bodies reject unsupported plugin mocks just as supported mocks do', async () => {
  for (const unsupported of [false, true]) {
    const store = storeFixture(),
      step = {
        id: '30000000-0000-0000-0000-000000000001',
        enabled: true,
        entity: 'widget',
        message: 'Create',
        stage: 10,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.SharedAudit',
        assemblyId: 'invented',
        ...(unsupported ? { impersonatingUserId: user } : {}),
      };
    const items = pluginCatalogue({
      plugins: { steps: [step] },
      overrides: {
        ['plugin-step:' + step.id]: { mode: 'mock', body: { error: { message: 'Configured ordinary rejection' } } },
      },
    });
    store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers: new Map() }));
    const before = store.snapshot();
    await assert.rejects(
      store.create('widgets', { title: 'Ordinary' }),
      (error) => error.code === 'PluginValidation' && error.message === 'Configured ordinary rejection',
    );
    assert.deepEqual(store.snapshot(), before);
  }
});

test(
  'Original DLL reads PreValidation variables through ParentContext across CRUD, ranks and nested SDK calls',
  { skip: CLR_SKIP },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-plugin-shared-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(directory, 'SharedAudit.cs'),
      assembly = path.join(directory, 'SharedAudit.dll');
    // Native (parity corpus crud, pipelineEffects): the PreValidation variables are read from the stage-30 main operation parent.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;
 namespace Invented {public sealed class SharedAudit:IPlugin {
  public void Execute(IServiceProvider services){
   var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));
   if(c.Stage==10){
    if(c.SharedVariables.Contains("pre")){if(((Money)c.SharedVariables["pre"]).Value!=19.25m)throw new InvalidPluginExecutionException("PreValidation rank lost shared values");}
    else {c.SharedVariables["pre"]=new Money(19.25m);c.SharedVariables["long"]=9007199254740993L;}
    return;
   }
   var parent=c.ParentContext;
   if(parent==null||parent.Stage!=30||parent.PrimaryEntityName!=c.PrimaryEntityName)throw new InvalidPluginExecutionException("Documented PreValidation parent is absent");
   if(((Money)parent.SharedVariables["pre"]).Value!=19.25m||(long)parent.SharedVariables["long"]!=9007199254740993L)throw new InvalidPluginExecutionException("Parent shared types or values differ");
   if(c.SharedVariables.Contains("pre")||c.SharedVariables.Contains("long"))throw new InvalidPluginExecutionException("PreValidation variables leaked into current collection");
   if(c.Depth!=parent.Depth||c.CorrelationId!=parent.CorrelationId)throw new InvalidPluginExecutionException("Same request depth/correlation changed");
   if(c.PrimaryEntityName=="child"&&(parent.ParentContext==null||parent.ParentContext.Stage!=20||parent.ParentContext.PrimaryEntityName!="widget"||c.Depth!=parent.ParentContext.Depth+1||c.CorrelationId!=parent.ParentContext.CorrelationId))throw new InvalidPluginExecutionException("Nested ancestor chain changed");
   if(c.Stage==20){
    c.SharedVariables["operation"]=c.MessageName;
    if(c.PrimaryEntityName=="widget"&&c.MessageName=="Create"){
     var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
     var child=new Entity("child");child["title"]="Nested ordinary child";service.Create(child);
    }
   }else if(c.Stage==40&&(string)c.SharedVariables["operation"]!=c.MessageName)throw new InvalidPluginExecutionException("PreOperation shared value did not survive PostOperation");
  }
 }}
 `,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root: directory,
      assembly: path.basename(assembly),
      typeName: 'Invented.SharedAudit',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(directory, 'cache'),
      serviceProfile: {
        userId: user,
        evidence: 'Invented documented SharedVariables contract',
        grants: [{ entity: 'child', operations: ['create', 'read'] }],
      },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const steps = [];
    let index = 0;
    for (const entity of ['widget', 'child'])
      for (const message of entity === 'widget' ? ['Create', 'Update', 'Delete'] : ['Create'])
        for (const [stage, rank] of [
          [10, 1],
          [10, 2],
          [20, 1],
          [40, 1],
        ])
          steps.push({
            id: '30000000-0000-0000-0000-' + String(++index).padStart(12, '0'),
            enabled: true,
            entity,
            message,
            stage,
            rank,
            mode: 0,
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
            typeName: 'Invented.SharedAudit',
            assemblyId: 'invented',
            assemblyName: 'SharedAudit',
          });
    const runtimes = new Map(steps.map((step) => [step.id, runtime])),
      overrides = Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      items = pluginCatalogue({ plugins: { steps }, runtimes, overrides }),
      notes = [];
    const store = storeFixture();
    store.setPluginPipeline((context) =>
      runPluginPhase({
        ...context,
        store,
        items,
        handlers: new Map(),
        runtimes,
        diagnostic: (note) => notes.push(note),
      }),
    );
    await store.create('widgets', { title: 'Ordinary root' });
    await store.update('widgets', existing, { title: 'Ordinary update' });
    await store.remove('widgets', existing);
    assert.equal(store.snapshot().tables.child.length, 1);
    assert.equal(store.snapshot().tables.widget.length, 1);
    assert.equal(notes.filter((note) => note.code === 'PLUGIN_STEP_CLR_EXECUTED').length, 16);
    const started = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED'),
      stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(started.length, 16);
    assert.equal(stopped.length, 16);
    assert.ok(stopped.every((note) => note.absenceVerified));
  },
);
