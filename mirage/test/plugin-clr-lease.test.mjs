// @test-kind security: pooled CLR host revokes service, factory, trace, context and provider handles when their invocation ends
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  prepareClrRuntime,
  executeClrPlugin,
  clrContext,
  closeClrHostPool,
  clrHostPoolStatus,
} from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
test(
  'pooled CLR service, factory, trace, context and provider handles expire with their invocation',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-lease-'));
    const sdk = clrSdk(),
      source = path.join(root, 'Lease.cs'),
      assembly = path.join(root, 'Lease.dll'),
      id = '11111111-1111-4111-8111-111111111111';
    await fs.writeFile(
      source,
      'using System;using System.Threading;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented{public sealed class Lease:IPlugin{static IOrganizationService oldService;static IOrganizationServiceFactory oldFactory;static ITracingService oldTrace;static IPluginExecutionContext oldContext;static IServiceProvider oldProvider;static ManualResetEvent gate=new ManualResetEvent(false),done=new ManualResetEvent(false);static int backgroundBlocked;static void Block(Action action,ref int count){try{action();}catch(NotSupportedException e){if(!e.Message.Contains("invocation"))throw;count++;}}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var factory=(IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory));var service=factory.CreateOrganizationService(c.UserId);if(oldService==null){oldService=service;oldFactory=factory;oldTrace=(ITracingService)p.GetService(typeof(ITracingService));oldContext=c;oldProvider=p;new Thread(()=>{gate.WaitOne();Block(()=>oldTrace.Trace("Expired background trace"),ref backgroundBlocked);Block(()=>oldService.Retrieve("secondary",new Guid("' +
        id +
        '"),new ColumnSet("title")),ref backgroundBlocked);done.Set();}){IsBackground=true}.Start();}else{int blocked=0;Block(()=>oldService.Retrieve("secondary",new Guid("' +
        id +
        '"),new ColumnSet("title")),ref blocked);Block(()=>oldFactory.CreateOrganizationService(c.UserId),ref blocked);Block(()=>oldTrace.Trace("Expired trace"),ref blocked);Block(()=>{var unused=oldContext.Stage;},ref blocked);Block(()=>oldProvider.GetService(typeof(ITracingService)),ref blocked);gate.Set();if(!done.WaitOne(3000))throw new Exception("Controlled background lease gate failed");target["blocked"]=blocked;target["backgroundBlocked"]=backgroundBlocked;}((ITracingService)p.GetService(typeof(ITracingService))).Trace("Current invocation");target["observed"]=service.Retrieve("secondary",new Guid("' +
        id +
        '"),new ColumnSet("title")).GetAttributeValue<string>("title");}}}',
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Lease.dll',
      typeName: 'Invented.Lease',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      persistentHost: true,
      serviceProfile: {
        userId: id,
        evidence: 'Invented pooled invocation leases',
        grants: [{ entity: 'secondary', operations: ['read'] }],
      },
      context: { initiatingUserId: id, organizationId: id, businessUnitId: id },
    });
    t.after(async () => {
      closeClrHostPool({ runtime });
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [];
    state.mappings.secondary = { entitySet: 'secondaries', idColumn: 'secondaryid' };
    state.tables.secondary = [{ secondaryid: id, title: 'First' }];
    const store = new DataStore({ state }),
      notes = [];
    const invoke = () =>
      executeClrPlugin(
        runtime,
        clrContext({
          runtime,
          store,
          step: { id, images: [] },
          entity: 'widget',
          operation: 'create',
          stage: 20,
          target: { title: 'Input' },
          record: { widgetid: id },
          frame: {},
          depth: 1,
        }),
        { store, diagnostic: (entry) => notes.push(entry) },
      );
    assert.equal(invoke().target.attributes.observed, 'First');
    const pid = clrHostPoolStatus()[0].pid;
    store.tableRows('secondary')[0].title = 'Second';
    const answer = invoke();
    assert.equal(answer.target.attributes.blocked, 5);
    assert.equal(answer.target.attributes.backgroundBlocked, 2);
    assert.equal(answer.target.attributes.observed, 'Second');
    assert.equal(clrHostPoolStatus()[0].pid, pid);
    assert.equal(notes.filter((entry) => entry.code === 'PLUGIN_CLR_TRACE' && /Expired/.test(entry.message)).length, 0);
  },
);
