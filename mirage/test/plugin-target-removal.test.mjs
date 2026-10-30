import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-0000-0000-000000000001';
const id = '10000000-0000-0000-0000-000000000002';

test(
  'original CLR Target attribute removal withdraws proposed values and retains the latest saved Update values',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-target-removal-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Removal.cs'),
      assembly = path.join(root, 'Removal.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Removal:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];if(c.Depth>1)return;if(c.MessageName=="Update"&&target.Contains("nested")){var factory=(IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory));var service=factory.CreateOrganizationService(c.UserId);var saved=new Entity("widget",target.Id);saved["title"]="Saved during pre-operation";service.Update(saved);}target.Attributes.Remove("title");target.Attributes.Remove("note");target.Attributes.Remove("parentid");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Removal',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: {
        userId: user,
        evidence: 'Invented target removal test',
        grants: [{ entity: 'widget', operations: ['update'] }],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState();
    state.mappings.widget = {
      entitySet: 'widgets',
      idColumn: 'widgetid',
      recordDefaults: { note: 'Source default' },
      relationships: { parent: { from: 'parentid', to: 'widgetid', entity: 'widget', many: false } },
    };
    state.tables.widget = [
      { widgetid: id, title: 'Before', note: 'Saved note', parentid: { id, logical_name: 'widget' } },
    ];
    const store = new DataStore({ state });
    const bindingChecks = [],
      validateBindings = store.validateBindings.bind(store);
    store.validateBindings = (mapping, input, ...rest) => {
      bindingChecks.push({ ...input });
      return validateBindings(mapping, input, ...rest);
    };
    const steps = ['Create', 'Update'].map((message, index) => ({
      id: `${user.slice(0, -1)}${index + 3}`,
      enabled: true,
      entity: 'widget',
      message,
      stage: 20,
      mode: 0,
      rank: 1,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Removal',
      assemblyId: 'invented',
    }));
    await attachClrSteps(t, { store, steps, runtime });
    const service = localOrganizationService(store, {
      userId: user,
      evidence: 'Invented caller',
      grants: [{ entity: 'widget', operations: ['read', 'create', 'update'] }],
    });
    const created = await store.transact(() =>
      service.create('widget', {
        title: 'Discarded',
        note: 'Discarded note',
        kept: 'Retained',
        'parent@odata.bind': `/widgets(${id})`,
      }),
    );
    const createdRow = store.tableRows('widget').find((row) => row.widgetid === created.widgetid);
    assert.equal(createdRow.title, undefined);
    assert.equal(createdRow.note, 'Source default');
    assert.equal(createdRow.kept, 'Retained');
    assert.equal(createdRow.parentid, undefined);
    assert.equal(Object.hasOwn(bindingChecks.at(-1), 'parent@odata.bind'), false);
    assert.equal(Object.hasOwn(bindingChecks.at(-1), 'parentid'), false);
    await store.transact(() =>
      service.update('widget', id, {
        title: 'Discarded',
        note: 'Discarded note',
        kept: 'Retained',
        'parent@odata.bind': `/widgets(${created.widgetid})`,
      }),
    );
    assert.equal(store.tableRows('widget').find((row) => row.widgetid === id).title, 'Before');
    assert.equal(store.tableRows('widget').find((row) => row.widgetid === id).note, 'Saved note');
    assert.equal(store.tableRows('widget').find((row) => row.widgetid === id).parentid.id, id);
    assert.equal(Object.hasOwn(bindingChecks.at(-1), 'parent@odata.bind'), false);
    assert.equal(Object.hasOwn(bindingChecks.at(-1), 'parentid'), false);
    await store.transact(() => service.update('widget', id, { title: 'Discarded', nested: true }));
    assert.equal(store.tableRows('widget').find((row) => row.widgetid === id).title, 'Saved during pre-operation');
  },
);
