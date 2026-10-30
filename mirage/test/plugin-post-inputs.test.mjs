import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { exactNumeric } from '../lib/exact-numeric.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';

test(
  'post-operation CRUD and bulk inputs cross original CLR and JavaScript ranks without modifying committed rows',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-post-inputs-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const user = '10000000-0000-0000-0000-000000000001',
      sdk = clrSdk(),
      source = path.join(root, 'Inputs.cs'),
      assembly = path.join(root, 'Inputs.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Mutate:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=c.InputParameters.Contains("Targets")?((EntityCollection)c.InputParameters["Targets"]).Entities[0]:(Entity)c.InputParameters["Target"];target["title"]="Post CLR";target["postonly"]="Added at post";target.Attributes.Remove("removed");c.InputParameters["Extra"]=new Money(4.25m);c.SharedVariables["BigMoney"]=new Money(9007199254740993.25m);c.SharedVariables["BigDecimal"]=9007199254740993.25m;c.SharedVariables["BigInt"]=9007199254740993L;c.SharedVariables["Names"]=new[]{"Before"};c.SharedVariables["NestedNames"]=new[]{new[]{"Before"}};c.SharedVariables["LongValues"]=new[]{9007199254740993L,7L};c.SharedVariables["DecimalValues"]=new[]{9007199254740993.25m};c.SharedVariables["Choices"]=new OptionSetValueCollection(new[]{new OptionSetValue(1)});var reference=new EntityReference("widget","alternatecode","Before"){Name="Before",RowVersion="17"};reference.KeyAttributes["keyid"]=new Guid("${user}");c.SharedVariables["Reference"]=reference;var arrayReference=new EntityReference("widget","alternatecode","ArrayBefore"){Name="ArrayBefore",RowVersion="19"};arrayReference.KeyAttributes["keyid"]=new Guid("${user}");c.SharedVariables["References"]=new[]{arrayReference};c.OutputParameters["Custom"]=new Guid("${user}");}}public sealed class AssertInputs:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=c.InputParameters.Contains("Targets")?((EntityCollection)c.InputParameters["Targets"]).Entities[0]:(Entity)c.InputParameters["Target"];if(target.GetAttributeValue<string>("title")!="Post JS"||target.Contains("removed")||((Money)c.InputParameters["Extra"]).Value!=4.25m||(string)c.InputParameters["More"]!="Bridge"||(Guid)c.OutputParameters["Custom"]!=new Guid("${user}")||(string)c.OutputParameters["Note"]!="Output bridge"||((Money)c.SharedVariables["BigMoney"]).Value!=9007199254740994.25m||(decimal)c.SharedVariables["BigDecimal"]!=9007199254740994.25m||(long)c.SharedVariables["BigInt"]!=9007199254740994L||((string[])c.SharedVariables["Names"])[0]!="After"||((string[][])c.SharedVariables["NestedNames"])[0][0]!="After"||((EntityReference[])c.SharedVariables["References"])[0].Name!="ArrayAfter"||((EntityReference[])c.SharedVariables["References"])[0].RowVersion!="19"||(string)((EntityReference[])c.SharedVariables["References"])[0].KeyAttributes["alternatecode"]!="ArrayAfter"||(Guid)((EntityReference[])c.SharedVariables["References"])[0].KeyAttributes["keyid"]!=new Guid("10000000-0000-0000-0000-000000000002")||((long[])c.SharedVariables["LongValues"])[0]!=8L||((long[])c.SharedVariables["LongValues"])[1]!=9007199254740993L||((decimal[])c.SharedVariables["DecimalValues"])[0]!=9007199254740994.25m||((OptionSetValueCollection)c.SharedVariables["Choices"]).Count!=2||((OptionSetValueCollection)c.SharedVariables["Choices"])[1].Value!=2||((EntityReference)c.SharedVariables["Reference"]).Id!=Guid.Empty||((EntityReference)c.SharedVariables["Reference"]).RowVersion!="17"||((EntityReference)c.SharedVariables["Reference"]).Name!="After"||(string)((EntityReference)c.SharedVariables["Reference"]).KeyAttributes["alternatecode"]!="After"||(Guid)((EntityReference)c.SharedVariables["Reference"]).KeyAttributes["keyid"]!=new Guid("10000000-0000-0000-0000-000000000002"))throw new Exception("Post input or typed bridge lost");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Mutate',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented post input observers', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    for (const message of ['Create', 'Update', 'CreateMultiple', 'UpdateMultiple']) {
      const state = emptyState();
      state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
      state.tables.widget = [{ widgetid: user, title: 'Old', removed: 'Original' }];
      const store = new DataStore({ state });
      const steps = [1, 2, 3].map((rank) => ({
        id: `30000000-0000-0000-0000-00000000000${rank}`,
        enabled: true,
        entity: 'widget',
        message,
        stage: 40,
        mode: 0,
        rank,
        supportedDeployment: 0,
        filteringAttributes: rank === 3 && message.startsWith('Update') ? ['postonly'] : [],
        images: [],
        typeName: rank === 1 ? 'Invented.Mutate' : rank === 3 ? 'Invented.AssertInputs' : 'Invented.Bridge',
        assemblyId: 'invented',
      }));
      const last = retypeClrRuntime(runtime, { typeName: 'Invented.AssertInputs' });
      const runtimes = new Map([
          [steps[0].id, runtime],
          [steps[2].id, last],
        ]),
        descriptors = new Map([...runtimes].map(([id, value]) => [id, value.descriptor]));
      let seen = false;
      const handlers = new Map([
        [
          'Invented.Bridge',
          ({ context }) => {
            seen = true;
            const target = message.endsWith('Multiple')
              ? context.InputParameters.Targets[0].attributes
              : context.InputParameters.Target;
            assert.equal(target.title, 'Post CLR');
            assert.equal(Object.hasOwn(target, 'removed'), false);
            target.title = 'Post JS';
            context.InputParameters.More = 'Bridge';
            context.SharedVariables.BigMoney = exactNumeric('9007199254740994.25', 'Money');
            context.SharedVariables.BigDecimal = exactNumeric('9007199254740994.25', 'Decimal');
            context.SharedVariables.BigInt = exactNumeric('9007199254740994', 'Int64');
            context.SharedVariables.Names[0] = 'After';
            context.SharedVariables.NestedNames[0][0] = 'After';
            context.SharedVariables.References[0].name = 'ArrayAfter';
            context.SharedVariables.References[0].keyAttributes.alternatecode = 'ArrayAfter';
            context.SharedVariables.References[0].keyAttributes.keyid = '10000000-0000-0000-0000-000000000002';
            context.SharedVariables.LongValues.reverse();
            context.SharedVariables.LongValues[0] = 8;
            context.SharedVariables.DecimalValues[0] = exactNumeric('9007199254740994.25', 'Decimal');
            context.SharedVariables.Choices.push(2);
            context.SharedVariables.Reference.name = 'After';
            context.SharedVariables.Reference.keyAttributes.alternatecode = 'After';
            context.SharedVariables.Reference.keyAttributes.keyid = '10000000-0000-0000-0000-000000000002';
            context.OutputParameters.Note = 'Output bridge';
          },
        ],
      ]);
      const items = pluginCatalogue({
        plugins: { steps },
        handlers,
        runtimes,
        descriptors,
        overrides: Object.fromEntries([steps[0], steps[2]].map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      });
      const backend = await createOrganizationBackend({ store, items: () => items, handlers, runtimes, descriptors });
      const service = localOrganizationService(store, {
        userId: user,
        evidence: 'Invented post input caller',
        grants: [{ entity: 'widget', operations: ['read', 'create', 'update'] }],
        bulkTables: [
          {
            entity: 'widget',
            tableType: 'standard',
            evidence: 'Invented standard bulk fixture',
            messages: ['CreateMultiple', 'UpdateMultiple'],
          },
        ],
      });
      try {
        await store.transact(() => {
          if (message === 'Create') return service.create('widget', { title: 'Before', removed: 'Keep' });
          if (message === 'Update') return service.update('widget', user, { title: 'Before', removed: 'Keep' });
          return service.bulk(message.toLowerCase(), [
            {
              $type: 'Entity',
              logicalName: 'widget',
              id: message === 'UpdateMultiple' ? user : '00000000-0000-0000-0000-000000000000',
              attributes: { title: 'Before', removed: 'Keep' },
            },
          ]);
        });
        assert.equal(seen, true, message);
        const saved = message.startsWith('Create') ? store.tableRows('widget').at(-1) : store.tableRows('widget')[0];
        assert.equal(saved.title, 'Before', message);
        assert.equal(saved.removed, 'Keep', message);
        assert.equal(saved.postonly, undefined, message);
      } finally {
        await backend.close();
      }
    }
  },
);
