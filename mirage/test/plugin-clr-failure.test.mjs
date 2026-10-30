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

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function failureRuntime(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-clr-failure-'));
  t.after(async () => {
    await closeClrHostPool();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const sdk = clrSdk(),
    source = path.join(root, 'Failures.cs'),
    assembly = path.join(root, 'Failures.dll');
  await fs.writeFile(
    source,
    `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;using System.ServiceModel;namespace Invented {
public sealed class Plain:IPlugin {public void Execute(IServiceProvider p){throw new Exception("Invented ordinary failure");}}
public sealed class AuthoredUnsupported:IPlugin {public void Execute(IServiceProvider p){throw new NotSupportedException("Invented authored unsupported failure");}}
public sealed class Controlled:IPlugin {public void Execute(IServiceProvider p){throw new InvalidPluginExecutionException("Invented controlled failure");}}
public sealed class SdkFault:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId).Retrieve("secondary",new Guid("${id(99)}"),new ColumnSet("name"));}}
public sealed class AdapterFault:IPlugin {public void Execute(IServiceProvider p){p.GetService(typeof(IDisposable));}}
public sealed class OutputFault:IPlugin {public void Execute(IServiceProvider p){((IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext))).SharedVariables["opaque"]=new object();}}
public sealed class Wrapper:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);try{s.Create(new Entity("child"));throw new Exception("Nested failure was accepted");}catch(FaultException<OrganizationServiceFault> e){if(e.Detail.ErrorCode!=unchecked((int)0x80040224))throw;}((Entity)c.InputParameters["Target"])["caught"]=true;}}
}`,
  );
  compileClr(source, assembly, { references: [sdk, 'System.ServiceModel.dll'] });
  return prepareClrRuntime({
    trust: 'execute-local-assembly',
    root,
    assembly: 'Failures.dll',
    typeName: 'Invented.Plain',
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    serviceProfile: {
      userId: id(1),
      evidence: 'Invented exception-classification backend',
      grants: [
        { entity: 'child', operations: ['create'] },
        { entity: 'secondary', operations: ['read'] },
      ],
    },
    context: { initiatingUserId: id(1), organizationId: id(1), businessUnitId: id(1) },
  });
}
function fixture(operation = 'Create') {
  const before = operation === 'Update' ? [{ widgetid: id(2), name: 'Before' }] : [];
  const store = new DataStore({
    state: {
      mappings: Object.fromEntries(
        ['widget', 'child', 'secondary'].map((entity) => [
          entity,
          {
            logicalName: entity,
            entitySet: entity + 's',
            idColumn: entity + 'id',
            fields: { name: { dataverseType: 'nvarchar' }, caught: { dataverseType: 'bit' } },
          },
        ]),
      ),
      tables: { widget: structuredClone(before), child: [], secondary: [] },
      settings: { permissionMode: 'permissive' },
    },
  });
  const invoke = () =>
    operation === 'Create'
      ? store.create('widget', { name: 'Attempt' }, { admin: true, systemUserId: id(1) })
      : store.update('widget', id(2), { name: 'Attempt' }, { admin: true, systemUserId: id(1) });
  return { store, before, invoke };
}
const step = (stage, operation, typeName = 'Plain', entity = 'widget') => ({
  id: id(stage),
  name: 'Invented failure step',
  entity,
  message: operation,
  typeName: 'Invented.' + typeName,
  assemblyId: 'invented',
  enabled: true,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  images: [],
  filteringAttributes: [],
});
const errorOf = async (invoke) => {
  try {
    await invoke();
  } catch (error) {
    return error;
  }
  assert.fail('The original CLR plug-in must fail');
};

test(
  'ordinary CLR exceptions use the native unhandled code and authored message across CRUD stages and host modes',
  { skip: CLR_SKIP },
  async (t) => {
    const runtime = await failureRuntime(t);
    for (const persistentHost of [false, true])
      for (const operation of ['Create', 'Update'])
        for (const stage of [10, 20, 40]) {
          const f = fixture(operation),
            mounted = await attachClrSteps(t, {
              store: f.store,
              steps: [step(stage, operation)],
              runtime: retypeClrRuntime(runtime, { persistentHost }),
            });
          const failure = await errorOf(f.invoke),
            response = dataverseError(failure, {}),
            label = `${operation}${stage} ${persistentHost ? 'pooled' : 'isolated'}`;
          assert.equal(response.status, 400, label);
          assert.equal(response.body.error.code, '0x80040224', label);
          assert.equal(response.body.error.message, 'Invented ordinary failure', label);
          assert.equal(failure.details.sourceException.type, 'System.Exception');
          assert.equal(failure.details.sourceException.duringPluginExecute, true);
          assert.deepEqual(f.store.tableRows('widget'), f.before, label + ': no primary write survives');
          await mounted.backend.close();
        }
  },
);

test(
  'controlled plug-in exceptions, modeled SDK faults and local adapter failures keep their separate classification',
  { skip: CLR_SKIP },
  async (t) => {
    const runtime = await failureRuntime(t);
    for (const type of ['Controlled', 'AuthoredUnsupported', 'SdkFault', 'AdapterFault', 'OutputFault']) {
      const f = fixture(),
        mounted = await attachClrSteps(t, {
          store: f.store,
          steps: [step(20, 'Create', type)],
          runtime: retypeClrRuntime(runtime, { typeName: 'Invented.' + type }),
        });
      const error = await errorOf(f.invoke);
      if (type === 'Controlled') {
        assert.equal(error.details.innerCode, '0x80040265');
        assert.equal(error.message, 'Invented controlled failure');
        assert.equal(error.details.sourceException.type, 'Microsoft.Xrm.Sdk.InvalidPluginExecutionException');
      } else if (type === 'AuthoredUnsupported') {
        assert.equal(error.details.innerCode, '0x80040224');
        assert.equal(error.message, 'Invented authored unsupported failure');
        assert.equal(error.details.sourceException.type, 'System.NotSupportedException');
        assert.equal(error.details.sourceException.duringPluginExecute, true);
      } else if (type === 'SdkFault') {
        assert.equal(error.details.innerCode, '0x80040217');
        assert.match(error.details.sourceException.type, /^System.ServiceModel.FaultException/);
      } else {
        assert.equal(error.code, 'LocalPluginSdkUnsupported');
        assert.notEqual(error.details.innerCode, '0x80040224');
        assert.equal(error.details.sourceException.duringPluginExecute, type === 'AdapterFault');
      }
      assert.deepEqual(f.store.tableRows('widget'), []);
      await mounted.backend.close();
    }
  },
);

test(
  'a caught ordinary child-write exception still aborts its enclosing transaction',
  { skip: CLR_SKIP },
  async (t) => {
    const runtime = await failureRuntime(t);
    for (const persistentHost of [false, true]) {
      const f = fixture(),
        steps = [step(20, 'Create', 'Wrapper'), { ...step(10, 'Create', 'Plain', 'child'), id: id(50) }];
      const mounted = await attachClrSteps(t, {
        store: f.store,
        steps,
        runtime: (registration) =>
          retypeClrRuntime(runtime, {
            typeName: registration.typeName,
            persistentHost,
            // The outer budget includes its own half and one separately bounded child invocation.
            timeoutMs: registration.entity === 'child' ? ORDINARY_CLR_TIMEOUT_MS / 2 : ORDINARY_CLR_TIMEOUT_MS,
          }),
      });
      const failure = await errorOf(f.invoke);
      assert.equal(failure.details.innerCode, '0x8009000c');
      assert.deepEqual(f.store.tableRows('widget'), []);
      assert.deepEqual(f.store.tableRows('child'), []);
      await mounted.backend.close();
    }
  },
);
