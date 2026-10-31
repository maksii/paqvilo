// @test-kind unproven: local model of PostOperation read input propagation across ranks; no native capture cited
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-0000-0000-000000000001';
const first = '20000000-0000-0000-0000-000000000001';
const second = '20000000-0000-0000-0000-000000000002';

test(
  'CLR and typed JavaScript PostOperation read inputs propagate across ranks without repeating the main read',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-read-post-inputs-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'PostInputs.cs'),
      assembly = path.join(root, 'PostInputs.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public sealed class PostInputs:IPlugin {public void Execute(IServiceProvider p){
var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));bool writer=c.OwningExtension.Name=="writer";
if(c.MessageName=="Retrieve"){
 if(writer){c.InputParameters["Target"]=new EntityReference("widget",new Guid("${second}"));((ColumnSet)c.InputParameters["ColumnSet"]).AddColumn("note");}
 else {if(((EntityReference)c.InputParameters["Target"]).Id!=new Guid("${second}")||!((ColumnSet)c.InputParameters["ColumnSet"]).Columns.Contains("note")||!((ColumnSet)c.InputParameters["ColumnSet"]).Columns.Contains("extra"))throw new Exception("Post Retrieve inputs lost");var row=(Entity)c.OutputParameters["BusinessEntity"];if(row.Id!=new Guid("${first}")||row.Attributes.Contains("note")||row.Attributes.Contains("nullable")||!row.Attributes.Contains("widgetid"))throw new Exception("Post input changed main result");}
}else{
 var q=(FetchExpression)c.InputParameters["Query"];
 if(writer)q.Query=q.Query.Replace("<fetch","<fetch top='7'");
 else if(!q.Query.Contains("top='8'")||(((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).Entities.Count!=2||((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).TotalRecordCount!=2||((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).Entities[0].Attributes.Contains("nullable")||((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).Entities[1].Attributes.Contains("nullable")))throw new Exception("Post Query input lost or main result changed");
}
}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.PostInputs',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: {
        userId: user,
        evidence: 'Invented post input test',
        grants: [{ entity: 'widget', operations: ['read'] }],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [
      { widgetid: first, title: 'Original', note: 'Unselected', nullable: null },
      { widgetid: second, title: 'Other', note: 'Other note', nullable: null },
    ];
    const store = new DataStore({ state });
    const steps = ['Retrieve', 'RetrieveMultiple'].flatMap((message, index) =>
      [1, 2].map((rank) => ({
        id: `30000000-0000-0000-0000-0000000000${index}${rank}`,
        name: rank === 1 ? 'writer' : 'reader',
        enabled: true,
        entity: 'widget',
        message,
        stage: 40,
        rank: rank === 1 ? 1 : 3,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.PostInputs',
        assemblyId: 'invented',
      })),
    );
    const runtimes = new Map(steps.map((step) => [step.id, runtime]));
    const clrSteps = [...steps];
    const handlers = new Map([
      [
        'Invented.TypedRead',
        ({ context, operation }) => {
          if (operation === 'retrieve') {
            context.InputParameters.ColumnSet.columns.push('extra');
            context.OutputParameters.BusinessEntity.title = 'JS result';
          } else {
            context.InputParameters.Query.query = context.InputParameters.Query.query.replace("top='7'", "top='8'");
            context.OutputParameters.BusinessEntityCollection[0].title = 'JS collection';
          }
        },
      ],
    ]);
    for (const [index, message] of ['Retrieve', 'RetrieveMultiple'].entries())
      steps.push({
        ...steps[0],
        id: '30000000-0000-0000-0000-0000000001' + index + '0',
        typeName: 'Invented.TypedRead',
        message,
        rank: 2,
      });
    const items = pluginCatalogue({
      plugins: { steps },
      runtimes,
      handlers,
      overrides: Object.fromEntries(clrSteps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
    });
    const backend = await createOrganizationBackend({ store, items: () => items, runtimes, handlers });
    t.after(() => backend.close());
    const row = await store.readOperation(() =>
      store.get(
        'widget',
        first,
        { admin: true },
        { sdkColumns: { allColumns: false, columns: ['title', 'nullable'] } },
      ),
    );
    assert.deepEqual(row, { widgetid: first, title: 'JS result', nullable: null });
    assert.equal(store.tableRows('widget')[0].title, 'Original');
    const result = await store.readOperation(() =>
      store.fetchXml(
        '<fetch returntotalrecordcount="true"><entity name="widget"><attribute name="title"/><attribute name="nullable"/></entity></fetch>',
        { admin: true },
      ),
    );
    assert.equal(result.entities.length, 2);
    assert.equal(result.total_record_count, 2);
    assert.deepEqual(
      result.entities.map((row) => row.title),
      ['JS collection', 'Other'],
    );
  },
);
