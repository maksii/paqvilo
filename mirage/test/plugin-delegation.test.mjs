// @test-kind unproven: delegated UpdateMultiple ParentContext (single Update, stage 30, same depth) is a local model; no native capture cited
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
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const caller = '10000000-0000-0000-0000-000000000001';
const runAs = '10000000-0000-0000-0000-000000000002';
const recordId = '10000000-0000-0000-0000-000000000003';
// Native recorder corpus crud: an UpdateMultiple step of a single Update reports that Update's PrimaryEntityId and has the
// Update/30 main operation the single Update steps see as its parent (same principal, depth and transaction).
test(
  'an implicit UpdateMultiple CLR step has its original single Update core parent at the same depth',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-delegated-parent-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Delegated.cs'),
      assembly = path.join(root, 'Delegated.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class Delegated:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var parent=c.ParentContext;if(c.MessageName!="UpdateMultiple"||c.Depth!=1||c.PrimaryEntityId!=new Guid("${recordId}")||c.UserId!=new Guid("${runAs}")||parent==null||parent.MessageName!="Update"||parent.Stage!=30||parent.Depth!=c.Depth||parent.PrimaryEntityId!=new Guid("${recordId}")||parent.UserId!=c.UserId||!parent.IsInTransaction)throw new Exception("Delegated core context lost");var target=(Entity)parent.InputParameters["Target"];if(target.Id!=new Guid("${recordId}")||target.GetAttributeValue<string>("title")!="After")throw new Exception("Original single target lost");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Delegated',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: runAs, evidence: 'Invented delegated step identity', grants: [] },
      context: { executionUserId: runAs, initiatingUserId: caller, organizationId: caller, businessUnitId: caller },
    });
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [{ widgetid: recordId, title: 'Before' }];
    const store = new DataStore({ state });
    const step = {
      id: runAs,
      enabled: true,
      entity: 'widget',
      message: 'UpdateMultiple',
      stage: 20,
      mode: 0,
      rank: 1,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Delegated',
      assemblyId: 'invented',
    };
    const runtimes = new Map([[step.id, runtime]]),
      descriptors = new Map([[step.id, runtime.descriptor]]);
    const items = pluginCatalogue({
      plugins: { steps: [step] },
      runtimes,
      descriptors,
      overrides: { ['plugin-step:' + step.id]: { mode: 'clr' } },
    });
    const backend = await createOrganizationBackend({ store, items: () => items, runtimes, descriptors });
    t.after(() => backend.close());
    const profile = {
      userId: caller,
      evidence: 'Invented single-update caller',
      grants: [{ entity: 'widget', operations: ['read', 'update'] }],
    };
    await store.transact(() => localOrganizationService(store, profile).update('widget', recordId, { title: 'After' }));
    assert.equal(store.tableRows('widget')[0].title, 'After');
  },
);
