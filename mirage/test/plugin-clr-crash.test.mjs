// @test-kind compatibility: Microsoft Learn Web service error codes 0x8004418d SandboxWorkerNotAvailable for a crashed sandbox worker process
// Invented C# plug-in whose Execute calls Environment.FailFast, so the CLR host process exits before it answers. Run in the
// isolated host and in the pooled host (persistentHost), so both worker exit handlers are covered.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { dataverseError } from '../lib/dataverse-odata.mjs';
import { prepareClrRuntime, closeClrHostPool } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-4000-8000-000000000092';

test(
  'a crashed CLR sandbox worker answers 0x8004418d SandboxWorkerNotAvailable in the isolated and the pooled host',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-crash-'));
    t.after(async () => {
      await closeClrHostPool();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Crash.cs');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Crash:IPlugin{public void Execute(IServiceProvider p){Environment.FailFast("invented crash");}}}`,
    );
    compileClr(source, path.join(root, 'Crash.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Crash.dll',
      typeName: 'Invented.Crash',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: user, evidence: 'Invented crash grants', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const text = { dataverseType: 'nvarchar' };
    for (const [mode, overrides] of [
      ['isolated', {}],
      ['pooled', { persistentHost: true }],
    ]) {
      const store = new DataStore({
        state: {
          mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: text } } },
          tables: { x_item: [] },
        },
      });
      await attachClrSteps(t, {
        store,
        runtime: retypeClrRuntime(runtime, overrides),
        steps: [
          {
            id: '30000000-0000-4000-8000-000000000092',
            enabled: true,
            entity: 'x_item',
            message: 'Create',
            stage: 20,
            rank: 1,
            mode: 0,
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
            typeName: 'Invented.Crash',
            assemblyId: 'invented',
          },
        ],
      });
      const error = await store.create('x_item', { x_name: 'Crash' }, { admin: true }).then(
        () => null,
        (caught) => caught,
      );
      assert.ok(error, mode + ': the crashed host must fail the create');
      assert.equal(error.code, 'LocalPluginHostExited', mode);
      assert.equal(error.status, 400, mode);
      assert.equal(
        error.message,
        'The plug-in execution failed because the Sandbox Worker process crashed. This is typically due to an error in the plug-in code. Please refer to this document: https://go.microsoft.com/fwlink/?linkid=2189390',
        mode,
      );
      assert.equal(error.details.innerCode, '0x8004418d', mode);
      assert.equal(dataverseError(error, {}).body.error.code, '0x8004418d', mode);
      assert.deepEqual(store.tableRows('x_item'), [], mode + ': no primary write survives');
    }
  },
);
