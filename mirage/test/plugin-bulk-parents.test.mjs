// @test-kind parity: native recorder parity corpus bulk (Web API CreateMultiple/UpdateMultiple): per-record pipelines run inside the bulk operation under its stage context, with one request identity and bulk Targets metadata
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';

const user = '10000000-0000-0000-0000-000000000001';
const empty = '00000000-0000-0000-0000-000000000000';
const rows = ['20000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000012'];
const step = (message, stage, n, mode = 0) => ({
  id: `30000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  name: `${message} ${stage} ${mode}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Observer',
  assemblyId: 'invented',
});
async function fixture(t, steps, runtime) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_flag: { dataverseType: 'bit' } },
        recordDefaults: { x_flag: false },
      },
    },
    tables: { x_item: [] },
    extension: { name: 'bulk-parents-probe', install: () => {} },
  });
  const runtimes = new Map(steps.map((entry) => [entry.id, runtime]));
  const items = pluginCatalogue({
    plugins: { steps },
    runtimes,
    overrides: Object.fromEntries(steps.map((entry) => ['plugin-step:' + entry.id, { mode: 'clr' }])),
  });
  const backend = await createOrganizationBackend({
    store: f.store,
    items: () => items,
    runtimes,
    descriptors: new Map([...runtimes].map(([key, value]) => [key, value.descriptor])),
  });
  t.after(() => backend.close());
  return { ...f, backend };
}

test(
  'original CLR: a Web API CreateMultiple runs each Create under the CreateMultiple stage context',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-bulk-parents-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Parents.cs'),
      assembly = path.join(root, 'Parents.dll'),
      log = path.join(root, 'seen.txt');
    // One line per run: message/stage/mode, PrimaryEntityId, request ids, shared variable keys, Targets metadata and
    // the parent chain (message/stage/mode/row/input keys/owning step).
    await fs.writeFile(
      source,
      `using System;using System.IO;using System.Linq;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Observer:IPlugin{static string Keys(ParameterCollection p){return String.Join("+",p.Keys.OrderBy(k=>k));}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var chain="";for(var x=c.ParentContext;x!=null;x=x.ParentContext){string owner;try{owner=x.OwningExtension==null?"-":x.OwningExtension.Id.ToString();}catch(Exception){owner="?";}chain+=">"+x.MessageName+"/"+x.Stage+"/"+x.Mode+"/"+x.PrimaryEntityId+"/"+Keys(x.InputParameters)+"/"+owner;}var t=c.InputParameters.Contains("Targets")?(EntityCollection)c.InputParameters["Targets"]:null;File.AppendAllText(@"${log.replaceAll('"', '""')}",String.Join("|",new object[]{c.MessageName,c.Stage,c.Mode,c.PrimaryEntityId,c.RequestId,c.OperationId,c.CorrelationId,String.Join("+",c.SharedVariables.Keys.OrderBy(k=>k)),t==null?"-":t.EntityName+":"+t.TotalRecordCount+":"+(t.MinActiveRowVersion??"null"),chain,t==null?"-":String.Join("+",t.Entities[0].Attributes.Keys.OrderBy(k=>k))})+Environment.NewLine);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: path.basename(assembly),
      typeName: 'Invented.Observer',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: { userId: user, evidence: 'Invented bulk parent observer', grants: [] },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    });
    const steps = [
      ...[10, 20, 40].flatMap((stage, index) => [
        step('CreateMultiple', stage, 2 * index + 1),
        step('Create', stage, 2 * index + 2),
      ]),
      step('CreateMultiple', 40, 7, 1),
      step('Create', 40, 8, 1),
    ];
    const f = await fixture(t, steps, runtime);
    const response = await f.request('POST', '/x_items/Microsoft.Dynamics.CRM.CreateMultiple', {
      Targets: rows.map((row, index) => ({ x_itemid: row, x_name: `Bulk ${index}` })),
    });
    assert.equal(response.status, 200, await response.text());
    await f.backend.settle();
    const lines = (await fs.readFile(log, 'utf8'))
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const [message, stage, mode, primary, request, operation, correlation, shared, targets, chain, attributes] =
          line.split('|');
        return { message, stage, mode, primary, request, operation, correlation, shared, targets, chain, attributes };
      });
    const at = (message, stage, mode = '0') =>
      lines.filter((line) => line.message === message && line.stage === String(stage) && line.mode === mode);
    // One request identity for the bulk message and every record (native bulk: all events share RequestId/CorrelationId).
    assert.equal(new Set(lines.map((line) => line.request)).size, 1);
    assert.equal(new Set(lines.map((line) => line.correlation)).size, 1);
    assert.equal(new Set(lines.filter((line) => line.mode === '0').map((line) => line.operation)).size, 1);
    const bulkStep = (stage) =>
      steps.find((entry) => entry.message === 'CreateMultiple' && entry.stage === stage && entry.mode === 0).id;
    // Bulk steps: no parent at PreValidation, the CreateMultiple/30 main operation later; Targets metadata 0/null, then -1/"-1".
    assert.equal(at('CreateMultiple', 10)[0].chain, '');
    assert.equal(at('CreateMultiple', 10)[0].targets, 'x_item:0:null');
    for (const stage of [20, 40]) {
      assert.match(at('CreateMultiple', stage)[0].chain, new RegExp(`^>CreateMultiple/30/0/${empty}/Targets/`));
      assert.equal(at('CreateMultiple', stage)[0].targets, 'x_item:-1:-1');
    }
    assert.equal(at('CreateMultiple', 40, '1')[0].targets, 'x_item:-1:-1');
    // Targets as a single Create's: the named key and two-option defaults first, the state and stamps from PreOperation.
    const attributes = (stage) => at('CreateMultiple', stage)[0].attributes.split('+');
    assert.deepEqual(attributes(10), ['x_flag', 'x_itemid', 'x_name']);
    for (const name of ['createdon', 'modifiedon', 'statecode', 'statuscode', 'x_flag', 'x_itemid', 'x_name'])
      assert.ok(attributes(20).includes(name), name);
    assert.match(at('CreateMultiple', 40, '1')[0].chain, new RegExp(`^>CreateMultiple/30/1/${empty}/Targets/[^>]*$`));
    // Each Create runs under the CreateMultiple context of its stage (owned by that stage's bulk step).
    for (const stage of [10, 20, 40]) {
      const creates = at('Create', stage);
      assert.deepEqual(creates.map((line) => line.primary).sort(), rows);
      for (const line of creates)
        assert.equal(
          line.chain,
          stage === 10
            ? `>CreateMultiple/10/0/${empty}//${bulkStep(10)}`
            : `>CreateMultiple/${stage}/0/${empty}//${bulkStep(stage)}` + at('CreateMultiple', stage)[0].chain,
        );
    }
    // The platform variables belong to the bulk message's collections, DefaultsAddedFlag to each Create's own.
    for (const line of lines.filter((entry) => entry.mode === '0'))
      assert.equal(line.shared.split('+').includes('IsAutoTransact'), line.message === 'CreateMultiple', line.message);
    assert.ok(at('Create', 10).every((line) => line.shared.split('+').includes('DefaultsAddedFlag')));
    assert.ok(!at('CreateMultiple', 10)[0].shared.split('+').includes('DefaultsAddedFlag'));
    // A queued Create job sees that chain as its own operation (native: Create/40/m1 <- Create/40/m1 <- Create/30/m1).
    for (const line of at('Create', 40, '1'))
      assert.match(line.chain, new RegExp(`^>Create/40/1/${line.primary}/[^>]*>Create/30/1/${line.primary}/Targets/`));
  },
);
