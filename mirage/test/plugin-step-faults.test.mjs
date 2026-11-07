// @test-kind parity: native dataverse-recorder faults.json: a plug-in's ordinary exception during Update PreOperation answered 400 0x80040224 with the authored message
// Invented schema and step-id handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue, pluginHandlers, runPluginPhase } from '../lib/exported-plugins.mjs';
import { recordPluginTrace } from '../lib/plugin-trace.mjs';

const STEP = '60000000-0000-4000-8000-000000000001';
// Native traceFaults/traceExceptionOnly: a fault row's exceptiondetails is the OrganizationServiceFault line, then seven
// platform frames, from SandboxFabricGrpcClient.ExecutePluginInternal to SandboxFabricPluginTraceInterceptor.Intercept.
function assertNativeFault(text, message) {
  const head = `System.ServiceModel.FaultException\`1[Microsoft.Xrm.Sdk.OrganizationServiceFault]: ${message}`;
  assert.ok(
    text.startsWith(head + '\r\nat Microsoft.Xrm.RemotePlugin.Grpc.SandboxFabricGrpcClient.ExecutePluginInternal('),
    text,
  );
  assert.ok(
    text.endsWith(
      '\r\nat Microsoft.Xrm.RemotePlugin.Client.Interceptors.SandboxFabricPluginTraceInterceptor.Intercept(IInvocation invocation, IExecutionContext context, SandboxFabricCallTracker sandboxFabricCallTracker) +0x1f',
    ),
  );
  assert.equal(text.split('\r\nat ').length, 8);
}

function storeWith(handler) {
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: '60000000-0000-4000-8000-000000000002', x_name: 'before' }];
  const store = new DataStore({ state }),
    handlers = pluginHandlers([{ id: 'invented', pluginSteps: { [STEP]: handler } }]),
    items = pluginCatalogue({
      plugins: {
        steps: [
          {
            id: STEP,
            enabled: true,
            name: 'Invented Update pre',
            entity: 'x_item',
            message: 'Update',
            stage: 20,
            mode: 0,
            rank: 1,
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
            typeName: 'Invented.UpdatePre',
            assemblyId: 'invented',
          },
        ],
      },
      handlers,
    });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  return store;
}

test('an ordinary exception from a step handler is the unhandled plug-in fault with its message', async () => {
  const store = storeWith(() => {
    throw new Error('ordinary');
  });
  await assert.rejects(
    store.update('x_item', '60000000-0000-4000-8000-000000000002', { x_name: 'after' }, { admin: true }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.innerCode, '0x80040224');
      assert.equal(error.message, 'ordinary');
      return true;
    },
  );
  assert.equal(store.tableRows('x_item')[0].x_name, 'before');
});

// @test-kind contract: a step-id handler declares an InvalidPluginExecutionException the way a custom API handler does ({ pluginFault }); Learn: 0x80040265 IsvAborted
test('a step handler fault marked InvalidPluginExecutionException keeps 0x80040265', async () => {
  const store = storeWith(() => {
    throw { pluginFault: 'InvalidPluginExecutionException', message: 'declared refusal' };
  });
  await assert.rejects(
    store.update('x_item', '60000000-0000-4000-8000-000000000002', { x_name: 'after' }, { admin: true }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.details?.innerCode, '0x80040265');
      assert.equal(error.message, 'declared refusal');
      return true;
    },
  );
});

// A store with plug-in trace logging at the given setting (2 keeps every execution) and the plugintracelog mapping.
function traceStore(setting = 2) {
  const state = emptyState();
  state.mappings.plugintracelog = {
    logicalName: 'plugintracelog',
    entitySet: 'plugintracelogs',
    idColumn: 'plugintracelogid',
  };
  state.tables.plugintracelog = [];
  state.tables.organization = [
    { organizationid: '60000000-0000-4000-8000-000000000009', plugintracelogsetting: setting },
  ];
  return new DataStore({ state });
}

// @test-kind parity: native and native-r2 traceFaults: messageblock joins Trace calls with CRLF and keeps the last 10240 characters; a fault row names the OrganizationServiceFault with the platform frame suffix
// @parity-evidence: native/native-r2 traceFaults Update row (length 10240, 10215 x + CRLF + last line); traceFaults/traceExceptionOnly exceptiondetails suffix identical in all fault rows
test('a plug-in trace row keeps the last 10240 characters and names the fault it surfaced as', () => {
  const store = traceStore();
  recordPluginTrace(store, {
    typeName: 'Invented.Trace',
    stepId: STEP,
    messageName: 'Update',
    entity: 'x_item',
    depth: 1,
    traces: ['head line', 'x'.repeat(12_000), 'tail throw'],
    started: performance.now(),
    startedAt: new Date(0).toISOString(),
    error: Object.assign(new Error('Invented coded fault'), { details: { innerCode: '0x80040265' } }),
  });
  const [row] = store.tableRows('plugintracelog');
  assert.equal(row.messageblock.length, 10240);
  assert.ok(row.messageblock.startsWith('x'));
  assert.ok(row.messageblock.endsWith('\r\ntail throw'));
  assertNativeFault(row.exceptiondetails, 'Invented coded fault');
});

// @test-kind parity: native and native-r2 traceFaults: messageblock joins Trace calls with CRLF, keeps an LF inside one call; a success row's exceptiondetails is empty and it carries the context identities
// @parity-evidence: native/native-r2 traceFaults Update row (CRLF join of separate Trace calls); traceFaults success rows exceptiondetails ''
test('a plug-in trace row joins its Trace calls with CRLF and records the identities it was given', () => {
  const store = traceStore();
  const write = (over) =>
    recordPluginTrace(store, {
      typeName: 'Invented.Trace',
      stepId: STEP,
      messageName: 'Update',
      entity: 'x_item',
      depth: 1,
      traces: ['line one', 'line two'],
      started: performance.now(),
      startedAt: new Date(0).toISOString(),
      ...over,
    });
  write({});
  write({
    traces: ['first\nsecond'],
    correlationId: 'invented-correlation',
    requestId: 'invented-request',
    configuration: 'invented unsecure',
    secureConfiguration: 'invented secure',
  });
  const [plain, given] = store.tableRows('plugintracelog');
  assert.equal(plain.messageblock, 'line one\r\nline two');
  assert.equal(plain.exceptiondetails, '');
  assert.equal(plain.configuration, null);
  assert.equal(plain.secureconfiguration, null);
  assert.equal(plain.requestid, null);
  assert.equal(given.messageblock, 'first\nsecond');
  assert.equal(given.correlationid, 'invented-correlation');
  assert.equal(given.requestid, 'invented-request');
  assert.equal(given.configuration, 'invented unsecure');
  assert.equal(given.secureconfiguration, 'invented secure');
  assert.equal(given.performanceconstructorduration, 0);
});

// @test-kind parity: native and native-r2 traceFaults traces[]: typename assembly-qualified, configuration = step configuration, requestid = context RequestId, performanceconstructorduration 0
// @parity-evidence: native and native-r2 traceFaults traces[]: typename assembly-qualified, configuration = step configuration, requestid = context RequestId, performanceconstructorduration 0
test('a step trace row names the assembly-qualified type and carries the step configuration and the context request', async () => {
  const TYPE = 'Invented.Plugins.Trace';
  const ASSEMBLY = '70000000-0000-4000-8000-000000000003';
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_item = [{ x_itemid: '60000000-0000-4000-8000-000000000002', x_name: 'before' }];
  state.tables.pluginassembly = [
    {
      pluginassemblyid: ASSEMBLY,
      name: 'Invented.Plugins',
      version: '1.0.0.0',
      culture: 'neutral',
      publickeytoken: 'invented0token00',
    },
  ];
  state.tables.sdkmessageprocessingstep = [{ sdkmessageprocessingstepid: STEP, configuration: 'invented unsecure' }];
  state.mappings.plugintracelog = {
    logicalName: 'plugintracelog',
    entitySet: 'plugintracelogs',
    idColumn: 'plugintracelogid',
  };
  state.tables.plugintracelog = [];
  state.tables.organization = [{ organizationid: '60000000-0000-4000-8000-000000000009', plugintracelogsetting: 2 }];
  const store = new DataStore({ state });
  const seen = [];
  const handlers = pluginHandlers([
    {
      id: 'invented',
      pluginTypes: {
        [TYPE]: ({ context }) => {
          seen.push(context);
          context.trace('line one');
          context.trace('line two');
        },
      },
    },
  ]);
  const items = pluginCatalogue({
    plugins: {
      steps: [
        {
          id: STEP,
          enabled: true,
          name: 'Invented Update pre',
          entity: 'x_item',
          message: 'Update',
          stage: 20,
          mode: 0,
          rank: 1,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName: TYPE,
          assemblyId: ASSEMBLY,
        },
      ],
    },
    handlers,
  });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  await store.update('x_item', '60000000-0000-4000-8000-000000000002', { x_name: 'after' }, { admin: true });
  const [row] = store.tableRows('plugintracelog');
  assert.equal(seen.length, 1);
  assert.equal(
    row.typename,
    `${TYPE}, Invented.Plugins, Version=1.0.0.0, Culture=neutral, PublicKeyToken=invented0token00`,
  );
  assert.equal(row.messageblock, 'line one\r\nline two');
  assert.equal(row.configuration, 'invented unsecure');
  assert.equal(row.secureconfiguration, null);
  assert.equal(row.requestid, seen[0].RequestId);
  assert.equal(row.correlationid, seen[0].CorrelationId);
  assert.equal(row.performanceconstructorduration, 0);
});

// @test-kind parity: native traceExceptionOnly (r2, reproduced): with plugintracelogsetting 1 only the failing step's trace row is written
test('exception-only tracing keeps only the failing step trace row', () => {
  const state = emptyState();
  state.mappings.plugintracelog = {
    logicalName: 'plugintracelog',
    entitySet: 'plugintracelogs',
    idColumn: 'plugintracelogid',
  };
  state.tables.plugintracelog = [];
  state.tables.organization = [{ organizationid: '60000000-0000-4000-8000-000000000009', plugintracelogsetting: 1 }];
  const store = new DataStore({ state });
  const write = (error) =>
    recordPluginTrace(store, {
      typeName: 'Invented.Trace',
      stepId: STEP,
      messageName: 'Delete',
      entity: 'x_item',
      depth: 1,
      traces: ['Invented line'],
      started: performance.now(),
      startedAt: new Date(0).toISOString(),
      error,
    });
  write(null);
  write(Object.assign(new Error('Invented fault'), { details: { innerCode: '0x80040265' } }));
  // @parity-evidence: native/native-r2 traceFaults exceptiondetails suffix identical in all fault rows (the platform frames follow the fault message)
  const rows = store.tableRows('plugintracelog');
  assert.equal(rows.length, 1);
  assertNativeFault(rows[0].exceptiondetails, 'Invented fault');
});
