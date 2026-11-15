// @test-kind parity: native-r2 traceExceptionOnly and native traceFaults: a plug-in trace row's correlationid is the CorrelationId of the step's execution context
// @parity-evidence: native-r2 traceExceptionOnly traces[0] (Delete PreValidation fault, plugintracelogsetting 1) and native traceFaults traces[].correlationid = events CorrelationId
// Invented schema and assembly. The request runs under its own request-context correlation (an HTTP
// x-ms-correlation-request-id); the trace row must still carry the context CorrelationId, which the harness filters by.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createRequestContext, runWithRequest } from '../lib/request-context.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000091';
const REQUEST_CORRELATION = '10000000-0000-4000-8000-000000000092';
const step = (id, message, stage) => ({
  id,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Traced',
  assemblyId: 'invented',
});

test(
  'a CLR step trace row carries its context CorrelationId: a Delete PreValidation fault at setting 1, a success at setting 2',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-trace-correlation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Traced.cs');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Traced:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var trace=(ITracingService)p.GetService(typeof(ITracingService));trace.Trace("correlation "+c.CorrelationId.ToString());if(c.MessageName=="Delete")throw new InvalidPluginExecutionException("Invented traced fault");}}}`,
    );
    compileClr(source, path.join(root, 'Traced.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Traced.dll',
      typeName: 'Invented.Traced',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: user, evidence: 'Invented trace grants', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState();
    state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid', fields: {} };
    state.mappings.plugintracelog = {
      logicalName: 'plugintracelog',
      entitySet: 'plugintracelogs',
      idColumn: 'plugintracelogid',
    };
    state.tables.x_item = [{ x_itemid: '10000000-0000-4000-8000-000000000093' }];
    state.tables.plugintracelog = [];
    state.tables.organization = [{ organizationid: user, plugintracelogsetting: 1 }];
    const store = new DataStore({ state });
    await attachClrSteps(t, {
      store,
      runtime,
      steps: [
        step('30000000-0000-4000-8000-000000000091', 'Delete', 10),
        step('30000000-0000-4000-8000-000000000092', 'Create', 20),
      ],
    });
    const inRequest = (fn) => runWithRequest(createRequestContext({ correlationId: REQUEST_CORRELATION }), fn);
    const correlationOf = (row) => /correlation ([0-9a-f-]{36})/.exec(row.messageblock)?.[1];

    // Setting 1: the successful Create writes nothing; the failing Delete PreValidation writes one row.
    await inRequest(() => store.create('x_item', {}, { admin: true }));
    assert.equal(store.tableRows('plugintracelog').length, 0);
    await assert.rejects(
      inRequest(() => store.remove('x_item', '10000000-0000-4000-8000-000000000093', { admin: true })),
      /Invented traced fault/,
    );
    const [fault] = store.tableRows('plugintracelog');
    assert.equal(store.tableRows('plugintracelog').length, 1);
    assert.equal(fault.messagename, 'Delete');
    assert.ok(correlationOf(fault));
    assert.equal(fault.correlationid, correlationOf(fault));
    assert.notEqual(fault.correlationid, REQUEST_CORRELATION);

    // Setting 2: a successful step writes its row too, with its context CorrelationId.
    await store.transact(() => {
      store.tableRows('organization')[0].plugintracelogsetting = 2;
    });
    await inRequest(() => store.create('x_item', {}, { admin: true }));
    const success = store.tableRows('plugintracelog').find((row) => row.messagename === 'Create');
    assert.ok(success);
    assert.equal(success.exceptiondetails, '');
    assert.equal(success.correlationid, correlationOf(success));
    assert.notEqual(success.correlationid, REQUEST_CORRELATION);
  },
);
