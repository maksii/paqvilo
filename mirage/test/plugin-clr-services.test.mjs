// Native corpus (dataverse-recorder 'services'): the online sandbox hands a plug-in concrete service objects whose
// public SDK interfaces are ITracingService; IOrganizationServiceFactory with IClusterServiceFactory,
// IProxyTypesAssemblyProvider, IServiceEndpointNotificationService and IDisposable; and IOrganizationService with
// IClusterService. Reflection over the local host's objects sees the same interfaces. Invented schema and assembly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000081';

test(
  'CLR service objects implement the native public SDK interfaces and still reach the store',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-services-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Services.cs');
    await fs.writeFile(
      source,
      `using System;using System.Linq;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Shape:IPlugin{static string Of(object o){return string.Join(",",o.GetType().GetInterfaces().Select(i=>i.Name).OrderBy(n=>n,StringComparer.Ordinal));}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];var trace=(ITracingService)p.GetService(typeof(ITracingService));trace.Trace("shape {0}",c.Stage);var factory=(IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory));var service=factory.CreateOrganizationService(c.UserId);var note=new Entity("x_note");note["x_name"]="from plug-in";service.Create(note);t["x_trace"]=Of(trace);t["x_factory"]=Of(factory);t["x_service"]=Of(service);}}}`,
    );
    compileClr(source, path.join(root, 'Services.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Services.dll',
      typeName: 'Invented.Shape',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: {
        userId: user,
        evidence: 'Invented services grants',
        grants: [{ entity: 'x_note', operations: ['create'] }],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState(),
      text = { dataverseType: 'nvarchar' };
    state.mappings.x_item = {
      entitySet: 'x_items',
      idColumn: 'x_itemid',
      fields: { x_trace: text, x_factory: text, x_service: text },
    };
    state.mappings.x_note = { entitySet: 'x_notes', idColumn: 'x_noteid', fields: { x_name: text } };
    state.tables.x_item = [];
    state.tables.x_note = [];
    const store = new DataStore({ state });
    await attachClrSteps(t, {
      store,
      runtime,
      steps: [
        {
          id: '30000000-0000-4000-8000-000000000081',
          enabled: true,
          entity: 'x_item',
          message: 'Create',
          stage: 20,
          rank: 1,
          mode: 0,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName: 'Invented.Shape',
          assemblyId: 'invented',
        },
      ],
    });
    const row = await store.create('x_item', {}, { admin: true });
    assert.equal(row.x_trace, 'ITracingService');
    assert.equal(
      row.x_factory,
      'IClusterServiceFactory,IDisposable,IOrganizationServiceFactory,IProxyTypesAssemblyProvider,IServiceEndpointNotificationService',
    );
    assert.equal(row.x_service, 'IClusterService,IOrganizationService');
    assert.deepEqual(
      store.tableRows('x_note').map((note) => note.x_name),
      ['from plug-in'],
    );
  },
);
