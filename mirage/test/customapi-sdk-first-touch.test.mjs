// @test-kind compatibility: Microsoft Learn "Create a custom API with code": a custom API created through the Web API is callable as an OrganizationRequest from a plug-in
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install } from '../lib/dataverse-customapi.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const apiId = '10000000-0000-4000-8000-0000000000c1';
const typeId = '10000000-0000-4000-8000-0000000000c2';
const rowId = '10000000-0000-4000-8000-0000000000c3';
const name = 'invented_FirstTouch';

async function compiled(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-customapi-first-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const sdk = clrSdk(),
    source = path.join(root, 'FirstTouch.cs'),
    assembly = path.join(root, 'FirstTouch.dll');
  await fs.writeFile(
    source,
    `using System;using System.ServiceModel;using Microsoft.Xrm.Sdk;namespace Invented{
public sealed class Main:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var text=(string)c.InputParameters["Text"];if(text=="fault")throw new InvalidPluginExecutionException(OperationStatus.Failed,-2147220970,"Invented coded fault");c.OutputParameters["Reply"]="main:"+text;}}
public sealed class Caller:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var request=new OrganizationRequest("${name}");request.Parameters["Text"]=target.GetAttributeValue<string>("title");if(c.Stage==40){try{s.Execute(request);}catch(FaultException<OrganizationServiceFault>){}return;}target["result"]=(string)s.Execute(request).Results["Reply"];}}}`,
  );
  compileClr(source, assembly, { references: [sdk, 'System.ServiceModel.dll'] });
  return (typeName, serviceProfile, context) => ({
    trust: 'execute-local-assembly',
    root,
    assembly: path.basename(assembly),
    typeName,
    sdkRoot: path.dirname(sdk),
    sdkAssembly: path.basename(sdk),
    cacheRoot: path.join(root, 'cache'),
    serviceProfile,
    context,
  });
}

// The CLR custom API is registered over the Web API after start (no install or refresh pass prepares it); a CLR
// Create/20 and Update/40 step on widget call it through SDK Execute.
async function runtimeRegistered(t) {
  const descriptor = await compiled(t);
  const context = {
    executionUserId: apiId,
    initiatingUserId: apiId,
    organizationId: apiId,
    businessUnitId: apiId,
    mainOperationStepId: '10000000-0000-4000-8000-0000000000c4',
    mainOperationStepEvidence: 'Invented main-operation identity',
  };
  const f = await contractModuleFixture(t, {
    mappings: {
      widget: {
        logicalName: 'widget',
        entitySet: 'widgets',
        idColumn: 'widgetid',
        fields: { title: { dataverseType: 'nvarchar' }, result: { dataverseType: 'nvarchar' } },
      },
    },
    tables: {
      widget: [{ widgetid: rowId, title: 'unchanged' }],
      plugintype: [{ plugintypeid: typeId, typename: 'Invented.Main', pluginassemblyid: typeId }],
      pluginassembly: [{ pluginassemblyid: typeId, name: 'FirstTouch' }],
    },
    extension: {
      name: 'customapi',
      install: (api) =>
        install(
          { ...api, change: (fn) => fn() },
          {
            pluginRuntimes: new Map([
              [
                apiId,
                descriptor(
                  'Invented.Main',
                  { userId: apiId, evidence: 'Invented main operation', grants: [] },
                  context,
                ),
              ],
            ]),
          },
        ).ready,
    },
  });
  const principal = {
    userId: f.store.tableRows('systemuser').find((row) => row.applicationid).systemuserid,
    evidence: 'Invented SDK caller',
    grants: [
      { entity: 'widget', operations: ['read', 'create', 'update'] },
      { message: name, operations: ['execute'] },
    ],
  };
  const caller = await prepareClrRuntime(
    descriptor('Invented.Caller', principal, {
      ...context,
      executionUserId: principal.userId,
      initiatingUserId: principal.userId,
    }),
  );
  const step = (id, message, stage) => ({
    id,
    enabled: true,
    entity: 'widget',
    message,
    stage,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    typeName: 'Invented.Caller',
    assemblyId: typeId,
    assemblyName: 'FirstTouch',
    filteringAttributes: [],
    images: [],
  });
  await attachClrSteps(t, {
    store: f.store,
    runtime: caller,
    steps: [
      step('30000000-0000-4000-8000-0000000000c1', 'Create', 20),
      step('30000000-0000-4000-8000-0000000000c2', 'Update', 40),
    ],
  });
  const created = await f.request('POST', '/customapis', {
    customapiid: apiId,
    uniquename: name,
    name,
    displayname: name,
    description: 'Invented runtime custom API',
    bindingtype: 0,
    isfunction: false,
    allowedcustomprocessingsteptype: 2,
    'PluginTypeId@odata.bind': `/plugintypes(${typeId})`,
    CustomAPIRequestParameters: [
      { uniquename: 'Text', name: 'Text', displayname: 'Text', description: 'x', type: 10, isoptional: true },
    ],
    CustomAPIResponseProperties: [
      { uniquename: 'Reply', name: 'Reply', displayname: 'Reply', description: 'x', type: 10 },
    ],
  });
  assert.equal(created.status, 201, await created.clone().text());
  return f;
}

// @test-kind parity: native catchCoded (native and native-r2) PATCH result: the Update/40 plug-in caught the coded fault of its first SDK Execute of the custom API; the request answered 400 0x8009000c and the row kept its value
test(
  'a caught coded fault of the first SDK Execute of a runtime-registered CLR custom API aborts the caller with 0x8009000c',
  { skip: CLR_SKIP },
  async (t) => {
    const f = await runtimeRegistered(t);
    const fault = await f.json(
      await f.request('PATCH', `/widgets(${rowId})`, { title: 'fault' }, { 'if-match': '*' }),
      400,
    );
    assert.equal(fault.error.code, '0x8009000c');
    assert.equal(
      fault.error.message,
      'ISV code reduced the open transaction count. Custom plug-ins should not catch exceptions from OrganizationService calls and continue processing.',
    );
    assert.equal(f.store.tableRows('widget').find((row) => row.widgetid === rowId).title, 'unchanged');
  },
);

test(
  'a runtime-registered CLR custom API answers its first SDK Execute from a plug-in',
  { skip: CLR_SKIP },
  async (t) => {
    const f = await runtimeRegistered(t);
    const answered = await f.json(await f.request('POST', '/widgets', { title: 'hello' }), 201);
    assert.equal(answered.result, 'main:hello');
  },
);
