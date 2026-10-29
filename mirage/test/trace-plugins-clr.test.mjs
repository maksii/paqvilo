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
