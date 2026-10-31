// @test-kind unproven: local model of custom API optional input defaults and HTTP required-parameter admission; native claims in code cite no recording
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { install } from '../lib/dataverse-customapi.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginInvocationParent } from '../lib/plugin-execution-lifetime.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const id = '10000000-0000-4000-8000-000000000001';
const parameter = '10000000-0000-4000-8000-000000000002';
const name = 'invented_Presence';
const parameterNames = [
  'Flag',
  'Stamp',
  'Amount',
  'Row',
  'Rows',
  'Reference',
  'Ratio',
  'Count',
  'Cost',
  'Choice',
  'Text',
  'Strings',
  'Key',
];
const inputDefaults = {
  Flag: false,
  Stamp: '0001-01-01T00:00:00.0000000',
  Amount: 0,
  Row: null,
  Rows: null,
  Reference: null,
  Ratio: 0,
  Count: 0,
  Cost: null,
  Choice: null,
  Text: null,
  Strings: null,
  Key: '00000000-0000-0000-0000-000000000000',
};

for (const original of [false, true])
  test(
    `${original ? 'original CLR' : 'JavaScript'} custom API preserves all thirteen optional input defaults and separate HTTP required admission`,
    { skip: original && CLR_SKIP },
    async (t) => {
      let descriptor, root, store;
      if (original) {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-optional-input-'));
        t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
        const sdk = clrSdk(),
          source = path.join(root, 'Optional.cs'),
          assembly = path.join(root, 'OriginalMain.dll');
        await fs.writeFile(
          source,
          `using System;using Microsoft.Xrm.Sdk;namespace Invented{public sealed class Optional:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));foreach(var key in new[]{"${parameterNames.join('","')}"})if(!c.InputParameters.Contains(key))throw new Exception("Optional input disappeared: "+key);var v=c.InputParameters;if(!(v["Flag"] is bool)||(bool)v["Flag"]||!(v["Amount"] is decimal)||(decimal)v["Amount"]!=0m||!(v["Ratio"] is double)||(double)v["Ratio"]!=0d||!(v["Count"] is int)||(int)v["Count"]!=0||!(v["Key"] is Guid)||(Guid)v["Key"]!=Guid.Empty)throw new Exception("Value type default lost");if(!(v["Stamp"] is DateTime)||(DateTime)v["Stamp"]!=DateTime.MinValue||((DateTime)v["Stamp"]).Kind!=DateTimeKind.Unspecified)throw new Exception("Input DateTime default kind lost");foreach(var key in new[]{"Row","Rows","Reference","Cost","Choice","Strings"})if(v[key]!=null)throw new Exception("Reference type default is not null: "+key);if(v.Contains("FromSandbox")&&(!(v["FromSandbox"] is bool)||!(bool)v["FromSandbox"]))throw new Exception("Sandbox provenance lost");var value=v["Text"];if(value!=null&&!(value is string))throw new Exception("Optional String has wrong type");c.OutputParameters["Answer"]=(v.Contains("FromSandbox")?"Sandbox:":"")+(value==null?"NULL":(string)value);}}
public sealed class Caller:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var response=s.Execute(new OrganizationRequest("${name}"));((Entity)c.InputParameters["Target"])["result"]=(string)response.Results["Answer"];}}}`,
        );
        compileClr(source, assembly, { references: [sdk] });
        descriptor = {
          trust: 'execute-local-assembly',
          root,
          assembly: path.basename(assembly),
          typeName: 'Invented.Optional',
          sdkRoot: path.dirname(sdk),
          sdkAssembly: path.basename(sdk),
          cacheRoot: path.join(root, 'cache'),
          serviceProfile: { userId: id, evidence: 'Invented optional parameter observer', grants: [] },
          context: {
            executionUserId: id,
            initiatingUserId: id,
            organizationId: id,
            businessUnitId: id,
            mainOperationStepId: parameter,
            mainOperationStepEvidence: 'Invented main-operation identity',
          },
        };
      }
      const seen = [];
      const f = await contractModuleFixture(t, {
        mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
        tables: {
          customapi: [
            {
              customapiid: id,
              uniquename: name,
              bindingtype: 0,
              isfunction: false,
              allowedcustomprocessingsteptype: 0,
              ...(original ? { plugintypeid: id } : {}),
            },
          ],
          customapirequestparameter: parameterNames.map((uniquename, type) => ({
            customapirequestparameterid:
              type === 10 ? parameter : '20000000-0000-4000-8000-' + String(type).padStart(12, '0'),
            customapiid: id,
            uniquename,
            type,
            isoptional: true,
            ...([3, 5].includes(type) ? { logicalentityname: 'widget' } : {}),
          })),
          customapiresponseproperty: [
            { customapiresponsepropertyid: id, customapiid: id, uniquename: 'Answer', type: 10 },
          ],
          ...(original
            ? {
                plugintype: [{ plugintypeid: id, typename: 'Invented.Optional', pluginassemblyid: id }],
                pluginassembly: [{ pluginassemblyid: id, name: 'OriginalMain' }],
              }
            : {}),
        },
        extension: {
          name: 'customapi',
          async install(api) {
            store = api.store;
            await install(
              { ...api, change: (fn) => fn() },
              {
                handlers: original
                  ? new Map()
                  : new Map([
                      [
                        name.toLowerCase(),
                        {
                          handler: (ctx) => {
                            const values = pluginInvocationParent(store).values.InputParameters.values;
                            assert.equal(Object.hasOwn(ctx.inputs, 'Text'), true);
                            assert.equal(Object.hasOwn(values, 'Text'), true);
                            assert.equal(values.Text, ctx.inputs.Text);
                            for (const key of parameterNames) {
                              assert.equal(Object.hasOwn(ctx.inputs, key), true);
                              if (key !== 'Text') assert.equal(ctx.inputs[key], inputDefaults[key]);
                            }
                            if (Object.hasOwn(values, 'FromSandbox')) assert.equal(values.FromSandbox, true);
                            seen.push(ctx.inputs.Text);
                            return { outputs: { Answer: ctx.inputs.Text === null ? 'NULL' : ctx.inputs.Text } };
                          },
                        },
                      ],
                    ]),
                pluginRuntimes: descriptor ? new Map([[id, descriptor]]) : new Map(),
              },
            ).ready;
          },
        },
      });
      const principal = {
        userId: f.store.tableRows('systemuser').find((row) => row.applicationid).systemuserid,
        evidence: 'Invented local message caller',
        grants: [{ message: name, operations: ['execute'] }],
      };
      const service = localOrganizationService(f.store, principal);
      const bodies = [{}, ...parameterNames.map((key) => ({ [key]: null })), { Text: 'Value' }];
      for (const body of bodies) {
        const expected = body.Text === 'Value' ? 'Value' : 'NULL';
        assert.equal((await f.json(await f.request('POST', '/' + name, body), 200)).Answer, expected);
      }
      for (const body of [{}, Object.fromEntries(parameterNames.map((key) => [key, null]))]) {
        const synchronous = await f.store.transact(() =>
          service.executeMessageSync(name, null, { $type: 'ParameterCollection', values: body }),
        );
        assert.equal(synchronous.body.Answer, 'NULL');
        const asynchronous = await f.store.transact(() =>
          f.api.records.executeMessageInternal({ principal, name, parameters: body }),
        );
        assert.equal(asynchronous.body.Answer, 'NULL');
      }
      const actor = f.store.tableRows('systemuser').find((row) => row.systemuserid === principal.userId);
      const declarations = Object.entries(NS)
        .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
        .join(' ');
      const soap = await handleSoap(
        {
          method: 'POST',
          headers: {},
          user: actor,
          caller: actor,
          identity: { id: actor.systemuserid, admin: true },
          origin: f.server.origin,
          version: 'v9.2',
          bodyText: `<s:Envelope ${declarations}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:OrganizationRequest"><a:Parameters/><a:RequestName>${name}</a:RequestName></request></Execute></s:Body></s:Envelope>`,
        },
        f.api,
      );
      assert.equal(soap.status, 200, soap.body);
      assert.match(soap.body, /NULL/);
      if (!original) {
        assert.equal(seen.length, bodies.length + 5);
        assert.equal(seen.filter((value) => value === 'Value').length, 1);
      } else {
        const caller = await prepareClrRuntime({
          ...descriptor,
          typeName: 'Invented.Caller',
          serviceProfile: principal,
          context: { ...descriptor.context, executionUserId: principal.userId, initiatingUserId: principal.userId },
        });
        await attachClrSteps(t, {
          store: f.store,
          runtime: caller,
          steps: [
            {
              id: '30000000-0000-4000-8000-000000000001',
              enabled: true,
              entity: 'widget',
              message: 'Create',
              stage: 20,
              rank: 1,
              mode: 0,
              supportedDeployment: 0,
              typeName: 'Invented.Caller',
              assemblyId: id,
              assemblyName: 'OriginalMain',
              filteringAttributes: [],
              images: [],
            },
          ],
        });
        const result = await f.store.create('widget', {}, { admin: true });
        assert.equal(
          result.result,
          'Sandbox:NULL',
          'an original CLR SDK caller retains defaults and FromSandbox provenance',
        );
      }
      await f.json(
        await f.request(
          'PATCH',
          `/customapirequestparameters(${parameter})`,
          { isoptional: false },
          { 'if-match': '*' },
        ),
        200,
      );
      for (const body of [{}, { Text: null }]) {
        const fault = await f.json(await f.request('POST', '/' + name, body), 400);
        assert.equal(fault.error.code, '0x80048d19');
        assert.match(
          fault.error.message,
          body.Text === null ? /does not allow null values/ : /missing parameters are: Text/,
        );
        assert.throws(
          () => service.executeMessageSync(name, null, { $type: 'ParameterCollection', values: body }),
          (error) => error.status === 400 && error.details.innerCode === '0x80040203',
          'HTTP reader qualification must not manufacture a native SDK fault code',
        );
      }
      const parameterRoute = `/customapirequestparameters(${parameter})`;
      const invalid = await f.json(
        await f.request('PATCH', parameterRoute, { type: 4, logicalentityname: 'widget' }, { 'if-match': '*' }),
        400,
      );
      assert.equal(invalid.error.code, '0x80040265');
      assert.equal(invalid.error.message, 'EntityLogicalName is valid only for Entity or EntityReference types');
      assert.equal(
        f.store.tableRows('customapirequestparameter').find((row) => row.customapirequestparameterid === parameter)
          .type,
        10,
        'invalid metadata patches are atomic',
      );
      await f.json(
        await f.request('PATCH', parameterRoute, { type: 5, logicalentityname: 'widget' }, { 'if-match': '*' }),
        200,
      );
      assert.equal(
        (await f.json(await f.request('PATCH', parameterRoute, { type: 4 }, { 'if-match': '*' }), 400)).error.code,
        '0x80040265',
      );
      await f.json(
        await f.request('PATCH', parameterRoute, { type: 4, logicalentityname: null }, { 'if-match': '*' }),
        200,
      );
      await f.json(
        await f.request('PATCH', parameterRoute, { type: 3, logicalentityname: 'widget' }, { 'if-match': '*' }),
        200,
      );
      const before = f.store.tableRows('customapirequestparameter').length;
      const create = await f.json(
        await f.request('POST', '/customapirequestparameters', {
          uniquename: 'Collection',
          name: 'Invented collection',
          type: 4,
          logicalentityname: 'widget',
          'CustomAPIId@odata.bind': `/customapis(${id})`,
        }),
        400,
      );
      assert.equal(create.error.code, '0x80040265');
      assert.equal(f.store.tableRows('customapirequestparameter').length, before);
      const parentCount = f.store.tableRows('customapi').length;
      const deep = await f.json(
        await f.request('POST', '/customapis', {
          uniquename: 'invented_InvalidCollection',
          name: 'Invented deep validation',
          description: 'Invented parameter type constraint',
          bindingtype: 0,
          isfunction: false,
          CustomAPIRequestParameters: [
            { uniquename: 'Collection', name: 'Invented collection', type: 4, logicalentityname: 'widget' },
          ],
        }),
        400,
      );
      assert.equal(deep.error.code, '0x80040265');
      assert.equal(
        f.store.tableRows('customapi').length,
        parentCount,
        'invalid deep parameters do not create the API parent',
      );
      assert.equal(f.store.tableRows('customapirequestparameter').length, before);
    },
  );
