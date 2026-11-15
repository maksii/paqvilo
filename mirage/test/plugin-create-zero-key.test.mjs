// @test-kind parity: repeated native qualification: empty primary attribute keeps an allocated Entity.Id in PreValidation, then faults 0x80040203
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { prepareClrRuntime, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const empty = '00000000-0000-0000-0000-000000000000',
  user = '10000000-0000-0000-0000-000000000001',
  replacement = '10000000-0000-0000-0000-000000000099';

test(
  'an authored empty Create primary attribute runs PreValidation with allocated identity then faults before main',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-zero-key-')),
      sdk = clrSdk(),
      source = path.join(root, 'Zero.cs'),
      assembly = path.join(root, 'Zero.dll');
    // Repeated native qualification distinguishes Entity.Id from the authored
    // empty primary Attribute, for unchanged, replaced and emptied Entity.Id.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;namespace Invented {
public sealed class Initial:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];
if(c.Stage!=10||c.PrimaryEntityId==Guid.Empty||t.Id!=c.PrimaryEntityId||(Guid)t["widgetid"]!=Guid.Empty)throw new Exception("Initial empty-key identity contract lost");
if(t.GetAttributeValue<bool>("reject10"))throw new InvalidPluginExecutionException("Custom PreValidation rejection");
var mode=t.GetAttributeValue<string>("mode");if(mode=="replace")t.Id=new Guid("${replacement}");else if(mode=="empty")t.Id=Guid.Empty;}}
public sealed class Witness:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];
var mode=t.GetAttributeValue<string>("mode");var expected=mode=="replace"?new Guid("${replacement}"):mode=="empty"?Guid.Empty:c.PrimaryEntityId;
if(c.Stage!=10||c.PrimaryEntityId==Guid.Empty||t.Id!=expected||(Guid)t["widgetid"]!=Guid.Empty)throw new Exception("Later empty-key identity contract lost");}}
public sealed class Caller:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var t=(Entity)c.InputParameters["Target"];var child=new Entity("widget");child["widgetid"]=Guid.Empty;child["mode"]=t["mode"];((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId).Create(child);}}
}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Zero.dll',
      typeName: 'Invented.Initial',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      // This semantic fixture launches fresh CLR processes, including nested
      // SDK observers. Use the established ordinary-fixture startup/execution
      // budget; the production default and dedicated timeout cases stay intact.
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: {
        userId: user,
        evidence: 'Invented authored empty primary attribute',
        grants: [{ entity: 'widget', operations: ['create'] }],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const f = await contractModuleFixture(t, {
      extension: { name: 'zero-key-fixture', install: () => {} },
      mappings: {
        widget: {
          entitySet: 'widgets',
          idColumn: 'widgetid',
          fields: { mode: { dataverseType: 'nvarchar' }, reject10: { dataverseType: 'bit' } },
          relationships: { child: { entity: 'widget', from: 'parentid', to: 'widgetid', many: false } },
        },
        trigger: { entitySet: 'triggers', idColumn: 'triggerid', fields: { mode: { dataverseType: 'nvarchar' } } },
      },
      tables: { widget: [], trigger: [] },
    });
    const observations = [],
      steps = [
        [10, 1, 'Invented.Initial'],
        [10, 2, 'Invented.Capture'],
        [10, 3, 'Invented.Witness'],
        [20, 1, 'Invented.Witness'],
        [40, 1, 'Invented.Witness'],
        [20, 1, 'Invented.Caller'],
      ].map(([stage, rank, typeName], index) => ({
        id: `30000000-0000-0000-0000-00000000000${index}`,
        enabled: true,
        entity: typeName === 'Invented.Caller' ? 'trigger' : 'widget',
        message: 'Create',
        stage,
        rank,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName,
        assemblyId: 'invented',
      }));
    await attachClrSteps(t, {
      store: f.store,
      steps,
      runtime: (step) =>
        step.typeName === 'Invented.Capture' ? null : retypeClrRuntime(runtime, { typeName: step.typeName }),
      handlers: new Map([
        [
          'Invented.Capture',
          ({ context }) => {
            observations.push({
              stage: context.Stage,
              primary: context.PrimaryEntityId,
              attribute: context.InputParameters.Target.widgetid,
            });
          },
        ],
      ]),
    });
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const profile = runtime.descriptor.serviceProfile;
    for (const mode of ['unchanged', 'replace', 'empty']) {
      observations.length = 0;
      const body = { widgetid: empty, mode };
      const error = await f.json(await f.request('POST', '/widgets', body), 400);
      assert.equal(error.error.code, '0x80040203', JSON.stringify(error));
      assert.equal(error.error.message, 'Expected non-empty Guid.');
      assert.equal(observations.length, 1);
      assert.deepEqual(
        observations.map(({ stage, attribute }) => ({ stage, attribute })),
        [{ stage: 10, attribute: empty }],
      );
      assert.notEqual(observations[0].primary, empty);
      assert.throws(
        () =>
          dispatchSdkCall({
            store: f.store,
            profile,
            message: {
              method: 'Create',
              userId: user,
              arguments: [
                {
                  $type: 'Entity',
                  logicalName: 'widget',
                  id: empty,
                  attributes: { widgetid: { $type: 'Guid', value: empty }, mode },
                },
              ],
            },
          }),
        (error) =>
          error.status === 400 &&
          error.details?.innerCode === '0x80040203' &&
          error.message === 'Expected non-empty Guid.',
      );
      const sdkError = await f.json(await f.request('POST', '/triggers', { mode }), 400);
      assert.equal(sdkError.error.code, '0x80040203', 'an uncaught original CLR SDK fault retains its native code');
      assert.equal(sdkError.error.message, 'Expected non-empty Guid.');
      assert.deepEqual(f.store.tableRows('widget'), []);
      assert.deepEqual(f.store.tableRows('trigger'), []);
    }
    observations.length = 0;
    const custom = await f.json(
      await f.request('POST', '/widgets', { widgetid: empty, mode: 'empty', reject10: true }),
      400,
    );
    assert.equal(custom.error.message, 'Custom PreValidation rejection');
    assert.equal(observations.length, 0, 'a PreValidation rejection wins over later key validation');
    const deep = await f.json(
      await f.request('POST', '/widgets', { widgetid: empty, mode: 'unchanged', child: { widgetid: replacement } }),
      400,
    );
    assert.equal(deep.error.code, '0x80040203');
    assert.deepEqual(f.store.tableRows('widget'), [], 'the key fault precedes nested Create');
  },
);
