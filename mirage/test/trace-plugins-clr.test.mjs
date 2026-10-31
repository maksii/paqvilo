// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of a compiled CLR plug-in (docs/design/tracing.md): the plugin-step span has module clr, each SDK RPC is an
// sdk-call span under it with the Dataverse operation it drives nested under that, and ITracingService lines are
// trace events on the step. Invented C# and schemas; skips like the other CLR tests without the Windows .NET Framework
// compiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const USER = '77777777-7777-4777-8777-0000000000c1';
const STEP = '30000000-0000-4000-8000-0000000000c1';
const profile = {
  userId: USER,
  evidence: 'invented test grants',
  grants: [
    { entity: 'x_item', operations: ['create', 'read', 'update'] },
    { entity: 'x_note', operations: ['create', 'read'] },
  ],
};
const mapping = (logical) => ({
  logicalName: logical,
  entitySet: `${logical}s`,
  idColumn: `${logical}id`,
  nameColumn: 'x_name',
  fields: { x_name: { dataverseType: 'nvarchar' } },
});
const SOURCE = `using System;using Microsoft.Xrm.Sdk;
namespace Invented {public sealed class NoteWriter:IPlugin{public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var trace=(ITracingService)services.GetService(typeof(ITracingService));var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);trace.Trace("Invented CLR line {0}",c.Stage);var note=new Entity("x_note");note["x_name"]="Written by CLR";service.Create(note);}}}`;

test(
  'a CLR step nests plugin-step (module clr), sdk-call and the dataverse write; trace lines are events',
  { skip: CLR_SKIP },
  async (t) => {
    const sdkAssembly = clrSdk(),
      root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-trace-clr-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'NoteWriter.cs'), SOURCE);
    compileClr(path.join(root, 'NoteWriter.cs'), path.join(root, 'NoteWriter.dll'), {
      references: [sdkAssembly, 'System.Runtime.Serialization.dll', 'System.ServiceModel.dll'],
    });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'NoteWriter.dll',
      typeName: 'Invented.NoteWriter',
      sdkRoot: path.dirname(sdkAssembly),
      sdkAssembly: path.basename(sdkAssembly),
      cacheRoot: path.join(root, '.paqvilo/cache'),
      serviceProfile: profile,
      context: {
        initiatingUserId: USER,
        organizationId: '50000000-0000-4000-8000-0000000000c1',
        businessUnitId: '60000000-0000-4000-8000-0000000000c1',
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });

    const state = emptyState();
    state.mappings.x_item = mapping('x_item');
    state.mappings.x_note = mapping('x_note');
    state.tables.x_item = [];
    state.tables.x_note = [];
    const store = await new DataStore({ state }).init();
    const organization = await createOrganizationRuntime({
      store,
      settings: dataverseSettings({ enabled: true }),
      extensions: [...EXTENSIONS],
    });
    t.after(() => organization.close());
    store.traces = createTraceStore({ settings: { level: 'summary' } });
    const traces = store.traces;
    const step = {
      id: STEP,
      name: 'Invented CLR note writer',
      entity: 'x_item',
      message: 'Create',
      enabled: true,
      stage: 40,
      rank: 1,
      mode: 0,
      typeName: 'Invented.NoteWriter',
      assemblyId: 'invented-clr',
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
    };
    const runtimes = new Map([[STEP, runtime]]),
      handlers = new Map(),
      items = pluginCatalogue({
        plugins: { steps: [step] },
        handlers,
        runtimes,
        overrides: { ['plugin-step:' + STEP]: { mode: 'clr' } },
      });
    store.setPluginPipeline(
      (context) => runPluginPhase({ ...context, store, runtimes, handlers, items }),
      ({ entity }) => entity === 'x_item',
    );

    const request = traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
    await traces.run(request, () => localOrganizationService(store, profile).create('x_item', { x_name: 'Root' }));
    request.end();
    assert.equal(store.state.tables.x_note.length, 1, 'the CLR step wrote its note');

    const { spans } = traces.tree(request.traceId);
    const children = (span) => spans.filter((candidate) => candidate.parentSpanId === span.spanId);
    const [run] = spans.filter((span) => span.kind === 'plugin-step');
    assert.deepEqual([run.name, run.module, run.status], ['Invented CLR note writer', 'clr', 'ok']);
    assert.deepEqual(
      run.events.filter((event) => event.type === 'trace').map((event) => event.message),
      ['Invented CLR line 40'],
      'ITracingService lines are trace events on the step',
    );
    const calls = children(run).filter((span) => span.kind === 'sdk-call');
    assert.deepEqual(
      calls.map((span) => [span.name, span.module, span.entity]),
      [['Create', 'clr', 'x_note']],
    );
    assert.deepEqual(
      children(calls[0]).map((span) => [span.kind, span.name]),
      [['dataverse', 'Create x_note']],
      'the SDK RPC drives one Dataverse operation nested under it',
    );
  },
);

const CONTEXT_SOURCE = `using System;using Microsoft.Xrm.Sdk;
namespace Invented {public sealed class Context:IPlugin{public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];if(c.Stage==20){if(target.GetAttributeValue<string>("x_name")=="Boom")throw new InvalidPluginExecutionException("Invented CLR refused Boom");c.SharedVariables["marker"]="clr-shared";}}}}`;

test(
  'a CLR step span carries the host bridge images by alias and filter, parameters, shared variables, context and fault identity',
  { skip: CLR_SKIP },
  async (t) => {
    const sdkAssembly = clrSdk(),
      root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-trace-clr-'));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, 'Context.cs'), CONTEXT_SOURCE);
    compileClr(path.join(root, 'Context.cs'), path.join(root, 'Context.dll'), {
      references: [sdkAssembly, 'System.Runtime.Serialization.dll', 'System.ServiceModel.dll'],
    });
    const UNIT = '60000000-0000-4000-8000-0000000000c2';
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Context.dll',
      typeName: 'Invented.Context',
      sdkRoot: path.dirname(sdkAssembly),
      sdkAssembly: path.basename(sdkAssembly),
      cacheRoot: path.join(root, '.paqvilo/cache'),
      serviceProfile: profile,
      context: {
        initiatingUserId: USER,
        organizationId: '50000000-0000-4000-8000-0000000000c2',
        businessUnitId: UNIT,
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const state = emptyState();
    state.mappings.x_item = {
      ...mapping('x_item'),
      fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } },
    };
    state.tables.x_item = [];
    const store = await new DataStore({ state }).init();
    const organization = await createOrganizationRuntime({
      store,
      settings: dataverseSettings({ enabled: true }),
      extensions: [...EXTENSIONS],
    });
    t.after(() => organization.close());
    const PRE = '30000000-0000-4000-8000-0000000000c2',
      POST = '30000000-0000-4000-8000-0000000000c3';
    const step = (id, stage, image) => ({
      id,
      name: `Invented CLR context ${stage}`,
      entity: 'x_item',
      message: 'Update',
      enabled: true,
      stage,
      rank: 1,
      mode: 0,
      typeName: 'Invented.Context',
      assemblyId: 'invented-clr',
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [image],
    });
    const steps = [
      step(PRE, 20, { type: 0, alias: 'before', name: 'before', attributes: ['x_name'] }),
      step(POST, 40, { type: 1, alias: 'after', name: 'after', attributes: ['x_code'] }),
    ];
    const runtimes = new Map([
        [PRE, runtime],
        [POST, runtime],
      ]),
      handlers = new Map(),
      items = pluginCatalogue({
        plugins: { steps },
        handlers,
        runtimes,
        overrides: { ['plugin-step:' + PRE]: { mode: 'clr' }, ['plugin-step:' + POST]: { mode: 'clr' } },
      });
    store.setPluginPipeline(
      (context) => runPluginPhase({ ...context, store, runtimes, handlers, items }),
      ({ entity }) => entity === 'x_item',
    );
    const service = localOrganizationService(store, profile);
    const { x_itemid: id } = await service.create('x_item', { x_name: 'Old', x_code: 'A-1' });
    store.traces = createTraceStore({ settings: { level: 'full' } });
    const traces = store.traces;

    const request = traces.start({ kind: 'http', name: 'PATCH /invented', module: 'portal' });
    await traces.run(request, () => service.update('x_item', id, { x_name: 'New', x_code: 'B-2' }));
    request.end();
    const { spans } = traces.tree(request.traceId);
    const [pre, post] = [PRE, POST].map((stepId) => spans.find((span) => span.attributes.stepId === stepId));
    assert.deepEqual([pre.recordId, post.recordId], [id, id]);
    assert.equal(pre.input.preImages.before.x_name, 'Old');
    assert.equal('x_code' in pre.input.preImages.before, false, 'the registered attribute filter applies');
    assert.deepEqual(pre.input.postImages, {});
    assert.equal(pre.input.target.x_name, 'New');
    assert.equal(pre.input.inputParameters.Target.$type, 'Entity');
    // The platform's own Update entries (exported-plugins.mjs platformSharedVariables) precede the step's variable.
    const platform = { IsAutoTransact: true, AcceptLang: '' };
    assert.deepEqual(pre.input.sharedVariables, platform);
    assert.deepEqual(
      {
        messageName: pre.input.context.messageName,
        stage: pre.input.context.stage,
        mode: pre.input.context.mode,
        depth: pre.input.context.depth,
        initiatingUserId: pre.input.context.initiatingUserId,
        businessUnitId: pre.input.context.businessUnitId,
        isolationMode: pre.input.context.isolationMode,
      },
      {
        messageName: 'Update',
        stage: 20,
        mode: 0,
        depth: 1,
        initiatingUserId: USER,
        businessUnitId: UNIT,
        isolationMode: 2,
      },
    );
    assert.match(pre.input.context.correlationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(pre.output.sharedVariables, { ...platform, marker: 'clr-shared' });
    assert.equal(post.input.postImages.after.x_code, 'B-2');
    assert.equal('x_name' in post.input.postImages.after, false);
    // The Context4 sets the steps saw: the PreOperation image, then (PostOperation) that image, the platform's
    // PreBusinessEntity and the step's own post image.
    assert.deepEqual(pre.input.preImagesCollection.map(Object.keys), [['before']]);
    assert.deepEqual(post.input.preImagesCollection.map(Object.keys), [['before', 'PreBusinessEntity']]);
    assert.deepEqual(post.input.postImagesCollection, [post.input.postImages]);
    assert.deepEqual(
      post.input.sharedVariables,
      { ...platform, marker: 'clr-shared' },
      'the PreOperation variable reached PostOperation',
    );
    assert.equal(post.input.context.correlationId, pre.input.context.correlationId);

    const failing = traces.start({ kind: 'http', name: 'PATCH /invented', module: 'portal' });
    assert.throws(
      () => traces.run(failing, () => service.update('x_item', id, { x_name: 'Boom' })),
      /Invented CLR refused Boom/,
    );
    failing.end();
    const refused = traces.tree(failing.traceId).spans.find((span) => span.kind === 'plugin-step');
    assert.equal(refused.status, 'error');
    assert.deepEqual(refused.error, {
      type: 'InvalidPluginExecutionException',
      code: '0x80040265',
      status: 'Failed',
      message: 'Invented CLR refused Boom',
      pluginType: 'Invented.Context',
      step: PRE,
      stage: 20,
      depth: 1,
    });
  },
);
