// @test-kind parity+contract: native crud corpus: Pre/PostOperation parent is the stage-30 main operation (CLR observer); JS handler parent view is local
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';

test(
  'JavaScript CRUD PreValidation variables become the later parent collection while stages20 and40 share their own typed frame',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-js-prevalidation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const user = '10000000-0000-0000-0000-000000000001',
      sdk = clrSdk(),
      source = path.join(root, 'Parent.cs'),
      assembly = path.join(root, 'Parent.dll');
    // @parity-evidence: native dev-environment recorder corpus 2026-10-30: a Create without an authored key (upsert
    // scenario bare-PATCH creates; pipelineEffects nested SDK child create) has a Create/30 parent whose Target carries
    // the allocated primary-key attribute, although its PreValidation Target does not.
    // Native (parity corpus crud): the PreOperation/PostOperation parent is the stage-30 main operation inside the transaction, holding the PreValidation variables.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {public sealed class AssertParent:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var parent=c.ParentContext;if(parent==null||parent.Stage!=30||!parent.IsInTransaction||(string)parent.SharedVariables["Early"]!="second"||((Money)parent.SharedVariables["Cost"]).Value!=4.25m||c.SharedVariables.Contains("Early")||(string)c.SharedVariables["Current"]!=(c.Stage==20?"main":"post"))throw new Exception("PreValidation parent or later shared frame lost");var target=(Entity)parent.InputParameters["Target"];if(target.Id!=c.PrimaryEntityId||!target.Attributes.Contains("widgetid"))throw new Exception("PreValidation target identity/attributes lost");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.AssertParent',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: { userId: user, evidence: 'Invented JavaScript parent observer', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [];
    const store = new DataStore({ state });
    const steps = [
      [10, 1, 'Invented.Early'],
      [10, 2, 'Invented.Early'],
      [20, 1, 'Invented.Later'],
      [20, 2, 'Invented.AssertParent'],
      [40, 1, 'Invented.Later'],
      [40, 2, 'Invented.AssertParent'],
    ].map(([stage, rank, typeName], index) => ({
      id: `30000000-0000-0000-0000-00000000000${index}`,
      enabled: true,
      entity: 'widget',
      message: 'Create',
      stage,
      rank,
      typeName,
      mode: 0,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      assemblyId: 'invented',
    }));
    const seen = [];
    const handlers = new Map([
      [
        'Invented.Early',
        ({ context, step }) => {
          if (step.rank === 1) {
            context.SharedVariables.Early = 'first';
            context.SharedVariables.Cost = { $type: 'Money', value: '4.25' };
          } else {
            assert.equal(context.SharedVariables.Early, 'first');
            context.SharedVariables.Early = 'second';
          }
        },
      ],
      [
        'Invented.Later',
        ({ context }) => {
          seen.push(context.Stage);
          assert.equal(context.SharedVariables.Early, undefined);
          assert.equal(context.ParentContext.Stage, 10);
          assert.equal(context.ParentContext.SharedVariables.Early, 'second');
          if (context.Stage === 40) assert.equal(context.SharedVariables.Current, 'main');
          context.SharedVariables.Current = context.Stage === 20 ? 'main' : 'post';
        },
      ],
    ]);
    await attachClrSteps(t, {
      store,
      steps,
      handlers,
      runtime: (step) => (step.typeName === 'Invented.AssertParent' ? runtime : null),
    });
    await store.create('widget', { title: 'Before' }, { admin: true });
    assert.deepEqual(seen, [20, 40]);
    assert.equal(store.tableRows('widget')[0].title, 'Before');
  },
);
