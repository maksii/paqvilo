import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { fixedClock, createScheduler } from '../lib/runtime-clock.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture(operation, multipleFirst) {
  const state = emptyState();
  state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
  state.tables.widget = operation === 'Update' ? [{ widgetid: id(1), title: 'Before' }] : [];
  const clock = fixedClock(),
    store = new DataStore({ state, clock });
  const steps = [operation, operation + 'Multiple'].flatMap((message, lane) =>
    [10, 20, 40].map((stage) => ({
      id: id(stage + lane * 100),
      name: 'Invented merged operation metadata',
      typeName: 'Invented.Observer',
      assemblyId: 'invented',
      enabled: true,
      entity: 'widget',
      message,
      stage,
      rank: (multipleFirst ? 1 - lane : lane) + 1,
      mode: 0,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
    })),
  );
  return {
    store,
    clock,
    steps,
    invoke: () =>
      operation === 'Create'
        ? store.create('widget', { title: 'Changed' }, { admin: true })
        : store.update('widget', id(1), { title: 'Changed' }, { admin: true }),
  };
}
function assertContexts(seen, operation, multipleFirst) {
  const ordered = multipleFirst ? [operation + 'Multiple', operation] : [operation, operation + 'Multiple'];
  assert.deepEqual(
    seen.map((context) => [context.message, context.stage]),
    [10, 20, 40].flatMap((stage) => ordered.map((message) => [message, stage])),
  );
  for (const field of ['request', 'operation', 'correlation', 'created']) {
    assert.ok(seen.every((context) => context[field] != null));
    assert.equal(new Set(seen.map((context) => context[field])).size, 1, field + ' belongs to one merged request');
  }
  assert.equal(seen[0].operation, seen[0].request);
  for (const context of seen.filter((context) => context.parentRequest != null)) {
    assert.equal(context.parentRequest, context.request);
    assert.equal(context.parentOperation, context.operation);
    assert.equal(context.parentCreated, context.created);
  }
}

test('typed scalar-first and multiple-first lanes share operation metadata while retaining their own inputs and variables', async (t) => {
  for (const operation of ['Create', 'Update'])
    for (const multipleFirst of [false, true])
      await t.test(operation + (multipleFirst ? ' multiple-first' : ' scalar-first'), async (t) => {
        const f = fixture(operation, multipleFirst),
          seen = [],
          handlers = new Map([
            [
              'Invented.Observer',
              ({ context }) => {
                const multiple = context.MessageName.endsWith('Multiple');
                assert.equal(Object.hasOwn(context.InputParameters, 'Target'), !multiple);
                assert.equal(Object.hasOwn(context.InputParameters, 'Targets'), multiple);
                assert.ok(context.SharedVariables.lane == null || context.SharedVariables.lane === context.MessageName);
                context.SharedVariables.lane = context.MessageName;
                seen.push({
                  message: context.MessageName,
                  stage: context.Stage,
                  request: context.RequestId,
                  operation: context.OperationId,
                  correlation: context.CorrelationId,
                  created: context.OperationCreatedOn,
                  parentRequest: context.ParentContext?.RequestId,
                  parentOperation: context.ParentContext?.OperationId,
                  parentCreated: context.ParentContext?.OperationCreatedOn,
                });
                f.clock.advance(10);
              },
            ],
          ]);
        const items = pluginCatalogue({ plugins: { steps: f.steps }, handlers }),
          backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
        t.after(async () => {
          await backend.close();
          f.store.close();
        });
        await f.invoke();
        assertContexts(seen, operation, multipleFirst);
        assert.equal(f.store.tableRows('widget')[0].title, 'Changed');
      });
});

test('synchronous multiple-only metadata reaches queued scalar steps without exposing the multiple message collections', async (t) => {
  for (const operation of ['Create', 'Update'])
    await t.test(operation, async (t) => {
      const f = fixture(operation, false),
        scheduler = createScheduler({ clock: f.clock, manual: true }),
        observed = [];
      const handlers = new Map([
        [
          'Invented.Observer',
          ({ context }) => {
            observed.push(context);
            if (context.Mode === 0) context.SharedVariables.multipleOnly = 'Private multiple lane variable';
          },
        ],
      ]);
      const steps = f.steps
        .filter(
          (step) =>
            (step.message.endsWith('Multiple') && step.stage === 20) ||
            (!step.message.endsWith('Multiple') && step.stage === 40),
        )
        .map((step) => ({ ...step, mode: step.message.endsWith('Multiple') ? 0 : 1 }));
      const items = pluginCatalogue({ plugins: { steps }, handlers }),
        backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers, scheduler });
      t.after(async () => {
        await backend.close();
        f.store.close();
      });
      await f.store.withOperationContext(
        () => {
          f.store.pluginSdkTag = 'Merged canonical request tag';
          f.store.pluginRequestId = id(99);
          return f.invoke();
        },
        { fresh: true },
      );
      const job = f.store.tableRows('asyncoperation')[0];
      f.clock.advance(15_000);
      await scheduler.runDue();
      await backend.asyncPluginRunner.drain();
      assert.equal(observed.length, 2);
      const [multiple, single] = observed;
      assert.equal(multiple.MessageName, operation + 'Multiple');
      assert.equal(single.MessageName, operation);
      assert.equal(single.Mode, 1);
      assert.equal(single.RequestId, multiple.RequestId);
      assert.notEqual(single.RequestId, id(99));
      assert.equal(job.requestid, multiple.RequestId);
      assert.equal(single.CorrelationId, multiple.CorrelationId);
      assert.equal(single.OperationId, job.asyncoperationid);
      assert.notEqual(single.OperationId, multiple.OperationId);
      assert.equal(single.OperationCreatedOn, job.createdon.replace(/Z$/, ''));
      assert.equal(single.SharedVariables.tag, 'Merged canonical request tag');
      assert.equal(Object.hasOwn(single.SharedVariables, 'multipleOnly'), false);
      assert.equal(Object.hasOwn(single.InputParameters, 'Target'), true);
      assert.equal(Object.hasOwn(single.InputParameters, 'Targets'), false);
      assert.equal(f.store.tableRows('asyncoperation')[0].statuscode, 30);
      assert.equal(f.store.pluginSdkTag, undefined);
    });
});

test(
  'original CLR merged lanes preserve the first executed descriptor timestamp and the same known child-parent identities',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-merged-operation-')),
      sdk = clrSdk(),
      source = path.join(root, 'Observer.cs'),
      assembly = path.join(root, 'Observer.dll'),
      log = path.join(root, 'contexts.txt');
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    await fs.writeFile(
      source,
      `using System;using System.IO;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Observer:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var parent=c.ParentContext;var multiple=c.MessageName.EndsWith("Multiple");if(c.InputParameters.Contains("Target")==multiple||c.InputParameters.Contains("Targets")!=multiple)throw new Exception("Merged input lanes were mixed");if(c.SharedVariables.Contains("lane")&&(string)c.SharedVariables["lane"]!=c.MessageName)throw new Exception("Merged variables were mixed");c.SharedVariables["lane"]=c.MessageName;File.AppendAllText(@"${log.replaceAll('"', '""')}",String.Join("|",new[]{c.MessageName,c.Stage.ToString(),c.RequestId.ToString(),c.OperationId.ToString(),c.CorrelationId.ToString(),c.OperationCreatedOn.ToString("O"),c.OperationCreatedOn.Kind.ToString(),parent==null?"":parent.RequestId.ToString(),parent==null?"":parent.OperationId.ToString(),parent==null?"":parent.OperationCreatedOn.ToString("O")})+"\\n");}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Observer.dll',
      typeName: 'Invented.Observer',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: id(2), evidence: 'Invented merged metadata observer', grants: [] },
      context: { initiatingUserId: id(2), organizationId: id(2), businessUnitId: id(2) },
    });
    for (const operation of ['Create', 'Update'])
      for (const multipleFirst of [false, true])
        await t.test(operation + (multipleFirst ? ' multiple-first' : ' scalar-first'), async (t) => {
          const f = fixture(operation, multipleFirst);
          const mounted = await attachClrSteps(t, {
            store: f.store,
            steps: f.steps,
            runtime: (step) =>
              retypeClrRuntime(runtime, {
                context: {
                  ...runtime.descriptor.context,
                  operationCreatedOn: step.message.endsWith('Multiple')
                    ? '2001-02-03T04:05:06.1234567Z'
                    : '2002-03-04T05:06:07.2345678Z',
                  operationCreatedOnEvidence: 'Invented first applicable descriptor timestamp',
                },
              }),
          });
          t.after(() => f.store.close());
          await fs.writeFile(log, '');
          await f.invoke();
          const seen = (await fs.readFile(log, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => {
              const [
                message,
                stage,
                request,
                operation,
                correlation,
                created,
                kind,
                parentRequest,
                parentOperation,
                parentCreated,
              ] = line.split('|');
              assert.equal(kind, 'Unspecified');
              return {
                message,
                stage: Number(stage),
                request,
                operation,
                correlation,
                created,
                ...(parentRequest ? { parentRequest, parentOperation, parentCreated } : {}),
              };
            });
          assertContexts(seen, operation, multipleFirst);
          assert.equal(seen[0].created, multipleFirst ? '2001-02-03T04:05:06.1234567' : '2002-03-04T05:06:07.2345678');
          assert.equal(f.store.tableRows('widget')[0].title, 'Changed');
          await mounted.backend.close();
        });
  },
);
