// @test-kind parity: native dataverse-recorder depth corpus: a nested PostOperation Create chain reached Depth 10 and committed
// Native corpus (dataverse-recorder depth): a PostOperation Create step that creates another row of its table from
// each level reached Depth 10 and the request answered 204, so nested CLR execution passes the documented
// on-premises cap of 8. Invented schema and assembly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000071';
const LEVELS = 10;

for (const persistentHost of [false, true])
  test(
    `a ${persistentHost ? 'pooled' : 'isolated'} CLR Create chain nests to Depth ${LEVELS} and commits`,
    { skip: CLR_SKIP },
    async (t) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-depth-'));
      t.after(async () => {
        closeClrHostPool();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
      });
      const sdk = clrSdk(),
        source = path.join(root, 'Chain.cs');
      await fs.writeFile(
        source,
        `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Chain:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];if(t.GetAttributeValue<int>("level")!=c.Depth)throw new InvalidPluginExecutionException("Depth "+c.Depth+" for level "+t.GetAttributeValue<int>("level"));if(c.Depth>=${LEVELS})return;var next=new Entity("x_link");next["level"]=c.Depth+1;((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId).Create(next);}}}`,
      );
      compileClr(source, path.join(root, 'Chain.dll'), { references: [sdk] });
      const runtime = await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: 'Chain.dll',
        typeName: 'Invented.Chain',
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, 'cache'),
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS * LEVELS,
        persistentHost,
        serviceProfile: {
          userId: user,
          evidence: 'Invented chain grants',
          grants: [{ entity: 'x_link', operations: ['create', 'read'] }],
        },
        context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
      });
      const state = emptyState();
      state.mappings.x_link = {
        entitySet: 'x_links',
        idColumn: 'x_linkid',
        fields: { level: { dataverseType: 'int' } },
      };
      state.tables.x_link = [];
      const store = new DataStore({ state });
      await attachClrSteps(t, {
        store,
        runtime,
        steps: [
          {
            id: '30000000-0000-4000-8000-000000000071',
            enabled: true,
            entity: 'x_link',
            message: 'Create',
            stage: 40,
            rank: 1,
            mode: 0,
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
            typeName: 'Invented.Chain',
            assemblyId: 'invented',
          },
        ],
      });
      await store.create('x_link', { level: 1 }, { admin: true });
      assert.deepEqual(
        store
          .tableRows('x_link')
          .map((row) => row.level)
          .sort((a, b) => a - b),
        Array.from({ length: LEVELS }, (_, i) => i + 1),
      );
    },
  );

// An invocation's deadline covers its nested SDK calls, so a deep chain needs more than ten seconds. A descriptor may
// ask for up to the native 2-minute plug-in limit (Learn: Analyze plug-in performance); the run below outlasts the
// former ten-second ceiling by itself.
// @test-kind compatibility: Learn Analyze plug-in performance: the 2-minute plug-in limit covers nested SDK calls
test(
  'a CLR invocation may run longer than ten seconds when its descriptor allows it',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-deadline-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Slow.cs');
    await fs.writeFile(
      source,
      `using System;using System.Threading;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Slow:IPlugin{public void Execute(IServiceProvider p){Thread.Sleep(10500);var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));((Entity)c.InputParameters["Target"])["level"]=1;}}}`,
    );
    compileClr(source, path.join(root, 'Slow.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Slow.dll',
      typeName: 'Invented.Slow',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: 60_000,
      serviceProfile: { userId: user, evidence: 'Invented slow step', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState();
    state.mappings.x_link = { entitySet: 'x_links', idColumn: 'x_linkid', fields: { level: { dataverseType: 'int' } } };
    state.tables.x_link = [];
    const store = new DataStore({ state });
    await attachClrSteps(t, {
      store,
      runtime,
      steps: [
        {
          id: '30000000-0000-4000-8000-000000000072',
          enabled: true,
          entity: 'x_link',
          message: 'Create',
          stage: 20,
          rank: 1,
          mode: 0,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName: 'Invented.Slow',
          assemblyId: 'invented',
        },
      ],
    });
    const row = await store.create('x_link', {}, { admin: true });
    assert.equal(row.level, 1);
  },
);
