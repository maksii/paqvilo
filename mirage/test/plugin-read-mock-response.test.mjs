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

test(
  'Mock and handler read results reach direct and named original SDK callers without a CLR read observer',
  { skip: CLR_SKIP },
  async (t) => {
    const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-sdk-read-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(dir, 'ReadCaller.cs'),
      assembly = path.join(dir, 'ReadCaller.dll');
    await fs.writeFile(
      source,
      'using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;using Microsoft.Xrm.Sdk.Messages;namespace Invented {public sealed class ReadCaller:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var target=(Entity)c.InputParameters["Target"];var mode=(string)target["title"];var columns=new ColumnSet("title");if(mode.StartsWith("single")){var entity=mode.EndsWith("named")?((RetrieveResponse)service.Execute(new RetrieveRequest {Target=new EntityReference("widget",new Guid("20000000-0000-0000-0000-000000000001")),ColumnSet=columns})).Entity:service.Retrieve("widget",new Guid("20000000-0000-0000-0000-000000000001"),columns);if(entity.GetAttributeValue<string>("title")!="Configured single"||entity.FormattedValues["title"]!="Exact formatting")throw new InvalidPluginExecutionException("Single result handoff lost");}else{var query=new QueryExpression("widget"){ColumnSet=columns};var result=mode.EndsWith("named")?((RetrieveMultipleResponse)service.Execute(new RetrieveMultipleRequest {Query=query})).EntityCollection:service.RetrieveMultiple(query);if(result.EntityName!="widget"||result.MinActiveRowVersion!="12345678901234567890"||!result.TotalRecordCountLimitExceeded||result.Entities.Count!=1||result.Entities[0].GetAttributeValue<string>("title")!="Configured collection")throw new InvalidPluginExecutionException("Collection result metadata lost");}target["note"]="Exact original SDK result received";}}}',
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root: dir,
      assembly: path.basename(assembly),
      typeName: 'Invented.ReadCaller',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(dir, 'cache'),
      serviceProfile: {
        userId: user,
        evidence: 'Invented direct and named SDK read output handoff',
        grants: [{ entity: 'widget', operations: ['read'] }],
      },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const base = {
        enabled: true,
        entity: 'widget',
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.ReadCaller',
        assemblyId: 'invented',
        assemblyName: 'ReadCaller',
      },
      steps = [
        { ...base, id: '30000000-0000-0000-0000-000000000001', message: 'Create', stage: 20 },
        { ...base, id: '30000000-0000-0000-0000-000000000002', message: 'Retrieve', stage: 40 },
        { ...base, id: '30000000-0000-0000-0000-000000000003', message: 'RetrieveMultiple', stage: 40 },
      ],
      runtimes = new Map([[steps[0].id, runtime]]);
    const entity = (title) => ({
        $type: 'Entity',
        logicalName: 'widget',
        id: existing,
        attributes: { title },
        formattedValues: { title: 'Exact formatting' },
      }),
      collection = {
        $type: 'EntityCollection',
        entities: [entity('Configured collection')],
        moreRecords: false,
        totalRecordCount: -1,
        pagingCookie: null,
        entityName: 'widget',
        minActiveRowVersion: '12345678901234567890',
        totalRecordCountLimitExceeded: true,
      };
    for (const adapter of ['mock', 'handler'])
      for (const caller of ['single-direct', 'single-named', 'multiple-direct', 'multiple-named']) {
        const store = storeFixture(),
          notes = [],
          handlers =
            adapter === 'handler'
              ? new Map([
                  [steps[1].id, () => ({ entityResult: entity('Configured single') })],
                  [steps[2].id, () => ({ collection })],
                ])
              : new Map(),
          overrides = {
            ['plugin-step:' + steps[0].id]: { mode: 'clr' },
            ['plugin-step:' + steps[1].id]: { mode: adapter, body: { entityResult: entity('Configured single') } },
            ['plugin-step:' + steps[2].id]: { mode: adapter, body: { collection } },
          },
          items = pluginCatalogue({ plugins: { steps }, runtimes, handlers, overrides });
        store.setPluginPipeline((context) =>
          runPluginPhase({ ...context, store, items, handlers, runtimes, diagnostic: (n) => notes.push(n) }),
        );
        await store.create('widgets', { title: caller });
        assert.equal(store.snapshot().tables.widget[1].note, 'Exact original SDK result received');
        assert.equal(store.snapshot().tables.widget[0].title, 'Existing');
        const hosts = notes.filter((n) => n.code === 'PLUGIN_CLR_HOST_STOPPED');
        assert.equal(hosts.length, 1);
        assert.ok(hosts.every((n) => n.absenceVerified));
      }
  },
);
test('Ordinary reads keep projections when no CLR, handler or mock read observer executes', () => {
  for (const mode of ['empty', 'disabled', 'placeholder']) {
    const store = storeFixture(),
      steps =
        mode === 'empty'
          ? []
          : [
              {
                id: '30000000-0000-0000-0000-000000000002',
                enabled: true,
                entity: 'widget',
                message: 'RetrieveMultiple',
                stage: 40,
                rank: 1,
                mode: 0,
                supportedDeployment: 0,
                filteringAttributes: [],
                images: [],
                typeName: 'Invented.None',
                assemblyId: 'invented',
              },
            ],
      items = pluginCatalogue({
        plugins: { steps },
        overrides: mode === 'disabled' ? { ['plugin-step:' + steps[0].id]: { mode: 'disabled' } } : {},
      });
    store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers: new Map() }));
    const result = store.query('widgets', { $select: 'title' }, { admin: true });
    assert.deepEqual(result.value, [{ title: 'Existing' }]);
    assert.equal(store.snapshot().tables.widget[0].widgetid, existing);
  }
});
