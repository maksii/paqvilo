import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import { DataStore, emptyState } from '../lib/data.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test(
  'a committed original CLR async caller inherits its canonical tag after visible edits without leaking to another job',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-async-tag-'));
    let backend;
    t.after(async () => {
      await backend?.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'AsyncTag.cs'),
      assembly = path.join(root, 'AsyncTag.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;
namespace Invented {public sealed class AsyncTag:IPlugin {public void Execute(IServiceProvider p){
var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));
if(c.Mode!=1||c.IsInTransaction)throw new Exception("Expected an independent asynchronous context");
var mode=((Entity)c.InputParameters["Target"]).GetAttributeValue<string>("title");var tagged=mode.StartsWith("Tagged");
if(tagged){if(!c.SharedVariables.Contains("tag")||(string)c.SharedVariables["tag"]!="canonical")throw new Exception("Committed canonical tag missing");c.SharedVariables["tag"]="visible async edit";}
else if(c.SharedVariables.Contains("tag"))throw new Exception("Tag leaked into another job");
var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);
var child=new Entity("audit");child["title"]=tagged?(mode=="Tagged failure"?"Failed child":"Tagged child"):"Untagged child";s.Create(child);
if(tagged){var duplicate=new CreateRequest{Target=new Entity("audit")};duplicate.Parameters["tag"]="canonical";
try{s.Execute(duplicate);throw new Exception("Explicit inherited tag was accepted");}catch(ArgumentException e){if(e.HResult!=unchecked((int)0x80070057)||e.Message!="An item with the same key has already been added.")throw;}
if((string)c.SharedVariables["tag"]!="visible async edit")throw new Exception("The caller's in-flight visible edit was lost");}
if(mode=="Tagged failure")throw new InvalidPluginExecutionException("Invented async failure after child");
}}}`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const profile = {
      userId: id(1),
      evidence: 'Invented asynchronous canonical tag scope',
      grants: [{ entity: 'audit', operations: ['create'] }],
    };
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'AsyncTag.dll',
      typeName: 'Invented.AsyncTag',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      persistentHost: true,
      context: { initiatingUserId: id(1), organizationId: id(1), businessUnitId: id(1) },
    });
    const state = emptyState();
    for (const entity of ['widget', 'audit']) {
      state.mappings[entity] = { entitySet: entity + 's', idColumn: entity + 'id' };
      state.tables[entity] = [];
    }
    const store = new DataStore({ state }),
      scheduler = createScheduler({ clock: fixedClock(), manual: true });
    const observed = [],
      requests = new Map(),
      handlers = new Map([
        [
          'Invented.Child',
          ({ context, target }) => {
            const expected = target.title === 'Untagged child' ? undefined : 'canonical';
            assert.equal(context.SharedVariables.tag, expected);
            assert.equal(store.pluginSdkTag, expected);
            assert.equal(
              context.RequestId,
              context.ParentContext.RequestId,
              'the SDK child retains its executing async caller request',
            );
            assert.notEqual(
              context.RequestId,
              context.ParentContext.OperationId,
              'request identity is not the System Job identity',
            );
            const job = store.tableRows('asyncoperation').find((row) => row.statuscode === 20);
            assert.equal(context.ParentContext.OperationId, job.asyncoperationid);
            assert.equal(Date.parse(context.ParentContext.OperationCreatedOn + 'Z'), Date.parse(job.createdon));
            assert.equal(context.RequestId, requests.get(job.asyncoperationid));
            observed.push([target.title, context.SharedVariables.tag]);
          },
        ],
      ]);
    const steps = [
      { id: id(2), entity: 'widget', message: 'Create', stage: 40, mode: 1, typeName: 'Invented.AsyncTag' },
      { id: id(3), entity: 'audit', message: 'Create', stage: 20, mode: 0, typeName: 'Invented.Child' },
    ].map((step) => ({
      ...step,
      enabled: true,
      rank: 1,
      assemblyId: 'invented',
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
    }));
    const runtimes = new Map([[id(2), runtime]]),
      descriptors = new Map([[id(2), runtime.descriptor]]);
    const items = pluginCatalogue({
      plugins: { steps },
      handlers,
      runtimes,
      descriptors,
      overrides: { ['plugin-step:' + id(2)]: { mode: 'clr' } },
    });
    backend = await createOrganizationBackend({
      store,
      scheduler,
      items: () => items,
      handlers,
      runtimes,
      descriptors,
    });
    const captureRequest = (authoredId) => {
      const job = store.tableRows('asyncoperation').at(-1);
      const payload = JSON.parse(job.data);
      const frame = v8.deserialize(Buffer.from(payload.event, 'base64')).frame;
      assert.ok(frame.requestId);
      assert.equal(frame.suppliedRequestId, authoredId);
      assert.notEqual(frame.requestId, authoredId, 'authored transport metadata is separate from pipeline identity');
      assert.ok(![...requests.values()].includes(frame.requestId), 'a new root request owns a distinct identity');
      requests.set(job.asyncoperationid, frame.requestId);
      return frame;
    };
    await store.withOperationContext(
      () => {
        store.pluginSdkTag = 'canonical';
        store.pluginRequestId = id(99);
        return store.create('widget', { title: 'Tagged' }, { admin: true, systemUserId: id(1) });
      },
      { fresh: true },
    );
    assert.equal(store.pluginSdkTag, undefined);
    assert.equal(captureRequest(id(99)).requestTag, 'canonical');
    await scheduler.runDue();
    const taggedJob = store.tableRows('asyncoperation')[0];
    assert.equal(taggedJob.statuscode, 30, taggedJob.message);
    assert.equal(store.pluginSdkTag, undefined);
    await store.withOperationContext(
      () => {
        store.pluginSdkTag = 'canonical';
        store.pluginRequestId = id(98);
        return store.create('widget', { title: 'Tagged failure' }, { admin: true, systemUserId: id(1) });
      },
      { fresh: true },
    );
    captureRequest(id(98));
    await scheduler.runDue();
    assert.equal(store.tableRows('asyncoperation')[1].statuscode, 31);
    assert.match(store.tableRows('asyncoperation')[1].message, /Invented async failure after child/);
    assert.equal(store.pluginSdkTag, undefined);
    await store.create('widget', { title: 'Untagged' }, { admin: true, systemUserId: id(1) });
    captureRequest(undefined);
    await scheduler.runDue();
    assert.deepEqual(
      store.tableRows('asyncoperation').map((job) => job.statuscode),
      [30, 31, 30],
    );
    assert.equal(store.pluginSdkTag, undefined);
    assert.deepEqual(observed, [
      ['Tagged child', 'canonical'],
      ['Failed child', 'canonical'],
      ['Untagged child', undefined],
    ]);
    assert.equal(
      store.tableRows('audit').length,
      3,
      'the failed job keeps its completed child; refused duplicate requests have no effect',
    );
  },
);
