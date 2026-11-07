// @test-kind unproven: the platform bounds a plug-in by its 2-minute limit and the 116.85 MB sandbox context rule (Learn), not by call counts or message sizes; these local runs have no native capture
// Invented C#, schema and identities. None of the former local ceilings (1000 SDK calls, 16384-character trace, 4 MiB
// protocol line or context) refuses a plug-in the platform runs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { clrContext, executeClrPlugin, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-4000-8000-000000000401',
  seed = '20000000-0000-4000-8000-000000000401';
const SOURCE = `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
namespace Invented{
public sealed class Ceilings:IPlugin{public void Execute(IServiceProvider p){
 var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];
 var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
 var mode=t.GetAttributeValue<string>("x_mode");
 if(mode=="calls"){var n=0;for(var i=0;i<1500;i++)if(s.Retrieve("x_note",new Guid("${seed}"),new ColumnSet("x_body")).Id!=Guid.Empty)n++;t["x_count"]=n;}
 if(mode=="trace")((ITracingService)p.GetService(typeof(ITracingService))).Trace(new string('t',20000));
 if(mode=="body"){var note=new Entity("x_note");note["x_body"]=new string('b',6*1024*1024);t["x_count"]=s.Create(note)==Guid.Empty?0:1;}
}}}`;

const root = fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-ceilings-'));
after(async () => fs.rm(await root, { recursive: true, force: true, maxRetries: 5 }));
let runtime;
async function ceilingStore(t) {
  runtime ??= (async () => {
    const directory = await root,
      sdk = clrSdk(),
      source = path.join(directory, 'Ceilings.cs');
    await fs.writeFile(source, SOURCE);
    compileClr(source, path.join(directory, 'Ceilings.dll'), { references: [sdk] });
    return prepareClrRuntime({
      trust: 'execute-local-assembly',
      root: directory,
      assembly: 'Ceilings.dll',
      typeName: 'Invented.Ceilings',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(directory, 'cache'),
      timeoutMs: 120_000,
      serviceProfile: {
        userId: user,
        evidence: 'Invented ceiling grants',
        grants: [{ entity: 'x_note', operations: ['create', 'read'] }],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
  })();
  const state = emptyState(),
    text = { dataverseType: 'nvarchar' };
  state.mappings.x_item = {
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    fields: { x_mode: text, x_body: text, x_count: { dataverseType: 'int' } },
  };
  state.mappings.x_note = { entitySet: 'x_notes', idColumn: 'x_noteid', fields: { x_body: text } };
  state.tables.x_item = [];
  state.tables.x_note = [{ x_noteid: seed, x_body: 'seed' }];
  const store = new DataStore({ state });
  await attachClrSteps(t, {
    store,
    runtime: await runtime,
    steps: [
      {
        id: '30000000-0000-4000-8000-000000000401',
        enabled: true,
        entity: 'x_item',
        message: 'Create',
        stage: 20,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.Ceilings',
        assemblyId: 'invented',
      },
    ],
  });
  return store;
}

test('1,500 SDK Retrieve calls in one Execute succeed', { skip: CLR_SKIP }, async (t) => {
  const store = await ceilingStore(t);
  const row = await store.create('x_item', { x_mode: 'calls' }, { admin: true });
  assert.equal(row.x_count, 1500);
});

test('a 20,000-character Trace succeeds and reaches the host diagnostics whole', { skip: CLR_SKIP }, async (t) => {
  const store = await ceilingStore(t),
    prepared = await runtime,
    traces = [];
  const answer = executeClrPlugin(
    prepared,
    clrContext({
      runtime: prepared,
      store,
      step: { id: '30000000-0000-4000-8000-000000000401', images: [] },
      entity: 'x_item',
      operation: 'create',
      stage: 20,
      target: { x_mode: 'trace' },
      record: { x_itemid: seed },
      frame: {},
      depth: 1,
    }),
    { store, diagnostic: (note) => note.code === 'PLUGIN_CLR_TRACE' && traces.push(note.message) },
  );
  assert.equal(answer.kind, 'result');
  assert.deepEqual(
    traces.map((message) => message.length),
    [20000],
  );
});

test('a plug-in Create carrying a 6 MB text value succeeds', { skip: CLR_SKIP }, async (t) => {
  const store = await ceilingStore(t);
  const row = await store.create('x_item', { x_mode: 'body' }, { admin: true });
  assert.equal(row.x_count, 1);
  assert.equal(store.tableRows('x_note').find((note) => note.x_noteid !== seed).x_body.length, 6 * 1024 * 1024);
});

// @test-kind compatibility: Learn Troubleshoot Dataverse plug-ins: a context above 116.85 MB fails "Message size exceeded when sending context to Sandbox" with -2147220970
test('a context above 116.85 MB fails with the sandbox message size fault', { skip: CLR_SKIP }, async (t) => {
  const store = await ceilingStore(t);
  await assert.rejects(
    store.create('x_item', { x_mode: 'none', x_body: 'x'.repeat(117 * 1024 * 1024) }, { admin: true }),
    (error) => {
      assert.equal(error.details?.innerCode, '0x80040216');
      assert.match(
        error.message,
        /^Message size exceeded when sending context to Sandbox\. Message size: \d+\.\d\d Mb$/,
      );
      return true;
    },
  );
  assert.deepEqual(store.tableRows('x_item'), []);
});
