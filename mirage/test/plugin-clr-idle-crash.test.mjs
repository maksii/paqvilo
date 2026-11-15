// @test-kind compatibility: Microsoft Learn Web service error code 0x8004418d SandboxWorkerNotAvailable for a crashed sandbox worker process
// Invented C# plug-in. The pooled host is terminated while it is idle, as when a thread the plug-in left running kills it after
// Execute returned. The next step must run on a fresh host, never wait for its deadline as a timeout.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { prepareClrRuntime, closeClrHostPool, clrHostPoolStatus } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';

const user = '10000000-0000-4000-8000-000000000094';

test(
  'an idle pooled CLR host that died is replaced by a fresh host, never a deadline timeout',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-idle-crash-'));
    ownedFixture(t).add(async () => {
      await closeClrHostPool();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Idle.cs');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Idle:IPlugin{public void Execute(IServiceProvider p){}}}`,
    );
    compileClr(source, path.join(root, 'Idle.dll'), { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Idle.dll',
      typeName: 'Invented.Idle',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented idle grants', grants: [] },
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const store = new DataStore({
      state: {
        mappings: {
          x_item: { entitySet: 'x_items', idColumn: 'x_itemid', fields: { x_name: { dataverseType: 'nvarchar' } } },
        },
        tables: { x_item: [] },
      },
    });
    await attachClrSteps(t, {
      store,
      runtime: retypeClrRuntime(runtime, { persistentHost: true }),
      steps: [
        {
          id: '30000000-0000-4000-8000-000000000094',
          enabled: true,
          entity: 'x_item',
          message: 'Create',
          stage: 20,
          rank: 1,
          mode: 0,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName: 'Invented.Idle',
          assemblyId: 'invented',
        },
      ],
    });
    await store.create('x_item', { x_name: 'first' }, { admin: true });
    const [{ pid: deadPid, session: deadSession }] = clrHostPoolStatus();
    assert.ok(Number.isInteger(deadPid), 'the first step must leave a pooled host with a process id');
    process.kill(deadPid);
    // The pool reports the exit once the host has stopped; the loop ends only then, or when the test is cancelled.
    while (clrHostPoolStatus().some((host) => host.pid === deadPid)) {
      if (t.signal.aborted) throw new Error('the test was cancelled before the pooled host reported its exit');
      await new Promise(setImmediate);
    }
    const error = await store.create('x_item', { x_name: 'second' }, { admin: true }).then(
      () => null,
      (caught) => caught,
    );
    assert.notEqual(error?.code, 'LocalPluginTimeout', 'an idle host that died must not wait for the deadline');
    assert.equal(error, null, 'the second step must succeed on a fresh host');
    const fresh = clrHostPoolStatus();
    assert.equal(fresh.length, 1, 'one fresh pooled host');
    assert.notEqual(fresh[0].session, deadSession, 'the fresh host is a new pooled session');
  },
);
