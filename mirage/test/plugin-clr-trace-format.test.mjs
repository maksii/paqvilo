// @test-kind parity: native traceFaults Update/20 (both captures): a Trace with brace text and no arguments does not fault and later actions run
// Invented C# and schema. ITracingService.Trace with no format arguments sends its text unformatted: braces in it are
// not composite-format placeholders, so the plug-in does not fault and the next action of the step still runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000091';
const BRACES = 'json {"a":1} and {0} braces';

async function bracesStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-trace-format-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const sdk = clrSdk(),
    source = path.join(root, 'Braces.cs');
  await fs.writeFile(
    source,
    `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Braces:IPlugin{public void Execute(IServiceProvider p){var trace=(ITracingService)p.GetService(typeof(ITracingService));var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];trace.Trace("json {\\"a\\":1} and {0} braces");t["x_after"]="ran";}}}`,
  );
  compileClr(source, path.join(root, 'Braces.dll'), { references: [sdk] });
  const runtime = await prepareClrRuntime({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Braces.dll',
    typeName: 'Invented.Braces',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    serviceProfile: {
      userId: user,
      evidence: 'Invented braces grants',
      grants: [{ entity: 'x_item', operations: ['create'] }],
    },
    context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
  });
  const state = emptyState(),
    text = { dataverseType: 'nvarchar' };
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: text, x_after: text } };
  state.tables.x_item = [];
  const store = new DataStore({ state });
  await attachClrSteps(t, {
    store,
    runtime,
    steps: [
      {
        id: '30000000-0000-4000-8000-000000000091',
        enabled: true,
        entity: 'x_item',
        message: 'Create',
        stage: 20,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.Braces',
        assemblyId: 'invented',
      },
    ],
  });
  return store;
}

test(
  'a Trace with brace text and no arguments does not fault and the later action of the step runs',
  { skip: CLR_SKIP },
  async (t) => {
    const store = await bracesStore(t);
    const row = await store.create('x_item', { x_name: 'Braces' }, { admin: true });
    assert.equal(row.x_after, 'ran');
  },
);

// @test-kind unproven: verbatim no-argument trace text is not proven by native (cut from the 10240 tail)
test('a no-argument trace line keeps its brace text verbatim', { skip: CLR_SKIP }, async (t) => {
  const store = await bracesStore(t);
  store.traces = createTraceStore({ settings: { level: 'summary' } });
  const request = store.traces.start({ kind: 'http', name: 'POST /invented', module: 'portal' });
  await store.traces.run(request, () => store.create('x_item', { x_name: 'Braces' }, { admin: true }));
  request.end();
  const { spans } = store.traces.tree(request.traceId);
  const [run] = spans.filter((span) => span.kind === 'plugin-step');
  assert.deepEqual(
    run.events.filter((event) => event.type === 'trace').map((event) => event.message),
    [BRACES],
  );
});
