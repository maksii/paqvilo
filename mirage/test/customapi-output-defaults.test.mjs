// @test-kind unproven: local model of sparse custom API outputs through PostOperation and per-transport defaults; no cited native recording
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { install } from '../lib/dataverse-customapi.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { pluginInvocationParent } from '../lib/plugin-execution-lifetime.mjs';
import { closeClrHostPool, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { decodePairs, envelope, parseEnvelope } from '../lib/dataverse-soap-xml.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { drainFixture, ownedFixture } from '../testing/owned-fixture.mjs';

const id = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const name = 'invented_OutputDefaults';
const fields = [
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
const authored = {
  Flag: false,
  Stamp: { $type: 'DateTime', value: '2026-10-19T00:00:00Z' },
  Amount: { $type: 'Decimal', value: '0' },
  Row: { $type: 'Entity', logicalName: 'widget', id: id(1), attributes: { title: 'Authored' } },
  Rows: { $type: 'EntityCollection', entities: [], moreRecords: false, totalRecordCount: -1 },
  Reference: { $type: 'EntityReference', logicalName: 'widget', id: id(1) },
  Ratio: { $type: 'Double', value: '0' },
  Count: 0,
  Cost: { $type: 'Money', value: '0' },
  Choice: { $type: 'OptionSetValue', value: 0 },
  Text: '',
  Strings: { $type: 'PrimitiveArray', elementType: 'String', values: ['Retained', null, ''] },
  Key: { $type: 'Guid', value: '00000000-0000-0000-0000-000000000000' },
};

for (const original of [false, true])
  for (const isFunction of [false, true])
    test(
      `${original ? 'original CLR' : 'JavaScript'} ${isFunction ? 'function' : 'action'} outputs stay sparse through PostOperation and default at their own transport boundary`,
      { skip: original && CLR_SKIP },
      async (t) => {
        let mainDescriptor, root;
        const ownedRuntimes = [];
        if (original) {
          root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-output-defaults-'));
          ownedFixture(t).add(() =>
            drainFixture(
              ownedRuntimes.map((runtime) => async () => {
                const result = await closeClrHostPool({ runtime });
                assert.equal(result.allAbsenceVerified, true);
              }),
            ),
          );
          ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
          const sdk = clrSdk(),
            source = path.join(root, 'Outputs.cs'),
            assembly = path.join(root, 'Outputs.dll');
          await fs.writeFile(
            source,
            `using System;using Microsoft.Xrm.Sdk;namespace Invented {
public sealed class Main:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.OutputParameters.Count!=0)throw new Exception("Main outputs were defaulted early");var v=c.OutputParameters;bool authored=c.InputParameters["Mode"] as string=="Authored";v["Reply"]=authored?"Authored":"Unset";v["Extra"]=new Money(5.25m);if(c.InputParameters["Mode"] as string=="Null"){foreach(var key in new[]{"${fields.join('","')}"})v[key]=null;return;}if(!authored)return;v["Flag"]=false;v["Stamp"]=new DateTime(2026,10,19,0,0,0,DateTimeKind.Utc);v["Amount"]=0m;var row=new Entity("widget",new Guid("${id(1)}"));row["title"]="Authored";v["Row"]=row;v["Rows"]=new EntityCollection();v["Reference"]=new EntityReference("widget",row.Id);v["Ratio"]=0d;v["Count"]=0;v["Cost"]=new Money(0m);v["Choice"]=new OptionSetValue(0);v["Text"]="";v["Strings"]=new string[]{"Retained",null,""};v["Key"]=Guid.Empty;}}
public sealed class Post:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var v=c.OutputParameters;bool authored=c.InputParameters["Mode"] as string=="Authored";bool all=authored||c.InputParameters["Mode"] as string=="Null";if(v.Count!=(all?15:2)||!(v["Extra"] is Money)||((Money)v["Extra"]).Value!=5.25m)throw new Exception("Post output defaults or extra types changed");foreach(var key in new[]{"${fields.join('","')}"})if(v.Contains(key)!=all)throw new Exception("Unset output appeared before final response: "+key);if(c.InputParameters["Mode"] as string=="Post"){v["Count"]=7;v["Strings"]=new string[]{"Post"};v.Remove("Reply");}}}
public sealed class Caller:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var service=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var answer=service.Execute(new OrganizationRequest("${name}"));foreach(var key in new[]{"${fields.join('","')}"})if(!answer.Results.Contains(key)||answer.Results[key]!=null)throw new Exception("Final SDK output was not null: "+key);if(((Money)answer.Results["Extra"]).Value!=5.25m)throw new Exception("Final SDK extra lost");((Entity)c.InputParameters["Target"])["title"]="Original caller observed final nulls";}}}`,
          );
          compileClr(source, assembly, { references: [sdk] });
          mainDescriptor = {
            trust: 'execute-local-assembly',
            root,
            assembly: path.basename(assembly),
            typeName: 'Invented.Main',
            sdkRoot: path.dirname(sdk),
            sdkAssembly: path.basename(sdk),
            cacheRoot: path.join(root, 'cache'),
            persistentHost: true,
            serviceProfile: { userId: id(1), evidence: 'Invented output main', grants: [] },
            context: {
              executionUserId: id(1),
              initiatingUserId: id(1),
              organizationId: id(1),
              businessUnitId: id(1),
              mainOperationStepId: id(2),
              mainOperationStepEvidence: 'Invented output main identity',
            },
          };
        }
        let store;
        const f = await contractModuleFixture(t, {
          mappings: {
            widget: { entitySet: 'widgets', idColumn: 'widgetid', fields: { title: { dataverseType: 'nvarchar' } } },
          },
          tables: {
            customapi: [
              {
                customapiid: id(1),
                uniquename: name,
                bindingtype: 0,
                isfunction: isFunction,
                allowedcustomprocessingsteptype: 2,
                ...(original ? { plugintypeid: id(1) } : {}),
              },
            ],
            customapirequestparameter: [
              {
                customapirequestparameterid: id(1),
                customapiid: id(1),
                uniquename: 'Mode',
                type: 10,
                isoptional: true,
              },
            ],
            customapiresponseproperty: [
              ...fields.map((uniquename, type) => ({
                customapiresponsepropertyid: id(type + 10),
                customapiid: id(1),
                uniquename,
                type,
                ...([3, 5].includes(type) ? { logicalentityname: 'widget' } : {}),
              })),
              { customapiresponsepropertyid: id(30), customapiid: id(1), uniquename: 'Reply', type: 10 },
            ],
            ...(original
              ? {
                  plugintype: [{ plugintypeid: id(1), typename: 'Invented.Main', pluginassemblyid: id(1) }],
                  pluginassembly: [{ pluginassemblyid: id(1), name: 'Outputs' }],
                }
              : {}),
          },
          extension: {
            name: 'customapi',
            async install(api) {
              store = api.store;
              await install(api, {
                pluginRuntimes: mainDescriptor ? new Map([[id(1), mainDescriptor]]) : new Map(),
                ...(original
                  ? {
                      prepareRuntime: async (...args) => {
                        const runtime = await prepareClrRuntime(...args);
                        ownedRuntimes.push(runtime);
                        return runtime;
                      },
                    }
                  : {}),
                handlers: original
                  ? new Map()
                  : new Map([
                      [
                        name.toLowerCase(),
                        {
                          handler(ctx) {
                            assert.deepEqual(
                              pluginInvocationParent(store).values.OutputParameters.values,
                              {},
                              'MainOperation starts with no output defaults',
                            );
                            return {
                              outputs: {
                                Reply: ctx.inputs.Mode === 'Authored' ? 'Authored' : 'Unset',
                                Extra: { $type: 'Money', value: '5.25' },
                                ...(ctx.inputs.Mode === 'Authored'
                                  ? authored
                                  : ctx.inputs.Mode === 'Null'
                                    ? Object.fromEntries(fields.map((key) => [key, null]))
                                    : {}),
                              },
                            };
                          },
                        },
                      ],
                    ]),
              }).ready;
            },
          },
        });
        const actor = store.tableRows('systemuser').find((row) => row.applicationid);
        const profile = {
          userId: actor.systemuserid,
          evidence: 'Invented output caller',
          grants: [{ message: name, operations: ['execute'] }],
        };
        const service = localOrganizationService(store, profile);
        let postCalls = 0;
        const step = {
          id: id(40),
          enabled: true,
          entity: null,
          message: name,
          stage: 40,
          mode: 0,
          rank: 1,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName: 'Invented.Post',
          assemblyId: id(1),
          customApi: { name, bindingType: 0, allowedCustomProcessingStepType: 2, isFunction },
        };
        const postRuntime = original ? await prepareClrRuntime({ ...mainDescriptor, typeName: 'Invented.Post' }) : null;
        if (postRuntime) ownedRuntimes.push(postRuntime);
        await attachClrSteps(t, {
          store,
          steps: [step],
          runtime: postRuntime,
          handlers: new Map([
            [
              'Invented.Post',
              ({ context }) => {
                postCalls++;
                const expected = ['Authored', 'Null'].includes(context.InputParameters.Mode)
                  ? [...fields, 'Extra', 'Reply']
                  : ['Extra', 'Reply'];
                assert.deepEqual(
                  Object.keys(context.OutputParameters).sort(),
                  expected.sort(),
                  'PostOperation sees only authored output keys',
                );
                assert.equal(context.OutputParameters.Extra, 5.25);
                if (context.InputParameters.Mode === 'Post') {
                  context.OutputParameters.Count = 7;
                  context.OutputParameters.Strings = ['Post'];
                  delete context.OutputParameters.Reply;
                }
              },
            ],
          ]),
        });
        const sdk = async (Mode) =>
          store.transact(() =>
            service.executeMessageSync(name, null, { $type: 'ParameterCollection', values: Mode ? { Mode } : {} }),
          );
        const httpCall = (Mode) =>
          isFunction
            ? f.request('GET', `/${name}(${Mode ? "Mode='" + Mode + "'" : ''})`)
            : f.request('POST', '/' + name, Mode ? { Mode } : {});
        const http = await f.json(await httpCall(), 200);
        for (const key of fields) assert.deepEqual(http[key], ['Rows', 'Strings'].includes(key) ? [] : null, key);
        assert.equal(http.Reply, 'Unset');
        assert.equal(Object.hasOwn(http, 'Extra'), false, 'HTTP keeps declared response shape');
        const plain = await sdk();
        for (const key of fields) {
          assert.equal(Object.hasOwn(plain.outputs.values, key), true);
          assert.equal(plain.outputs.values[key], null, key);
        }
        assert.deepEqual(plain.outputs.values.Extra, { $type: 'Money', value: '5.25' });
        const edited = await sdk('Authored');
        for (const key of fields) assert.notEqual(edited.outputs.values[key], null, key);
        assert.equal(edited.outputs.values.Flag, false);
        assert.equal(edited.outputs.values.Count, 0);
        assert.equal(edited.outputs.values.Key.value, '00000000-0000-0000-0000-000000000000');
        assert.deepEqual(edited.outputs.values.Strings.values, ['Retained', null, '']);
        const authoredHttp = await f.json(await httpCall('Authored'), 200);
        for (const key of ['Amount', 'Ratio', 'Count', 'Cost', 'Choice']) assert.equal(authoredHttp[key], 0, key);
        assert.equal(authoredHttp.Flag, false);
        // @test-kind parity: Both fresh native cohorts return declared DateTime HTTP outputs as UTC text without an all-zero fraction, for minimum and authored dates.
        // @parity-evidence: webapi-native-customapi-datetime.json binds14 native responses and both CSDL/plan/run hashes; only calendar values and schema names are parameters. SDK OutputParameters are asserted separately above.
        await t.test('native HTTP DateTime zero-fraction presentation', async () => {
          const bytes = await fs.readFile(new URL('./fixtures/webapi-native-customapi-datetime.json', import.meta.url));
          assert.equal(
            createHash('sha256').update(bytes).digest('hex'),
            '004a6c0c0035402ef7ab1778a046f6b73b0eda8581b8c458623d878b2acf0e6e',
          );
          const proof = JSON.parse(bytes);
          assert.equal(proof.nativeType, 'Edm.DateTimeOffset');
          assert.equal(proof.captures.length, 2);
          assert.equal(proof.responseRule.zeroFraction, 'omitted');
          assert.equal(authoredHttp.Stamp, '2026-10-19T00:00:00Z');
        });
        assert.equal(authoredHttp.Row.title, 'Authored');
        assert.deepEqual(authoredHttp.Rows, []);
        assert.equal(authoredHttp.Reference.id, id(1));
        assert.equal(authoredHttp.Text, '');
        assert.deepEqual(authoredHttp.Strings, ['Retained', null, '']);
        assert.equal(authoredHttp.Key, '00000000-0000-0000-0000-000000000000');
        const explicitNulls = await sdk('Null');
        for (const key of fields) assert.equal(explicitNulls.outputs.values[key], null, key);
        const postEdited = await sdk('Post');
        assert.equal(postEdited.outputs.values.Count, 7);
        assert.deepEqual(postEdited.outputs.values.Strings.values, ['Post']);
        assert.equal(
          postEdited.outputs.values.Reply,
          null,
          'a removed declared output is filled only at the final response',
        );
        const soapBody = (Mode) =>
          envelope(
            `<svc:Execute><svc:request i:type="a:OrganizationRequest"><a:Parameters>${Mode ? `<a:KeyValuePairOfstringanyType><b:key>Mode</b:key><b:value i:type="c:string">${Mode}</b:value></a:KeyValuePairOfstringanyType>` : ''}</a:Parameters><a:RequestName>${name}</a:RequestName></svc:request></svc:Execute>`,
          );
        for (const Mode of [undefined, 'Authored']) {
          const reply = await handleSoap(
            {
              method: 'POST',
              headers: {},
              bodyText: soapBody(Mode),
              user: actor,
              caller: actor,
              identity: { admin: true, id: actor.systemuserid },
              origin: f.server.origin,
            },
            f.api,
          );
          assert.equal(reply.status, 200, reply.body);
          const parsed = parseEnvelope(reply.body).request.children.find((node) => node.name === 'ExecuteResult');
          const values = decodePairs(parsed.children.find((node) => node.name === 'Results'));
          for (const key of fields) assert.equal(values.has(key), true, key);
          if (!Mode) for (const key of fields) assert.equal(values.get(key), null, key);
          else assert.deepEqual(values.get('Strings').values, ['Retained', null, '']);
          assert.equal(values.get('Extra').type, 'Money');
        }
        if (original) {
          const callerRuntime = await prepareClrRuntime({
            ...mainDescriptor,
            typeName: 'Invented.Caller',
            serviceProfile: profile,
            context: { ...mainDescriptor.context, executionUserId: profile.userId, initiatingUserId: profile.userId },
          });
          ownedRuntimes.push(callerRuntime);
          await attachClrSteps(t, {
            store,
            runtime: callerRuntime,
            steps: [
              {
                ...step,
                id: id(41),
                entity: 'widget',
                message: 'Create',
                stage: 20,
                typeName: 'Invented.Caller',
                customApi: undefined,
              },
            ],
          });
          assert.equal(
            (await store.create('widget', {}, { admin: true })).title,
            'Original caller observed final nulls',
          );
        } else assert.equal(postCalls, 8);
      },
    );

// @test-kind contract: SDK typed outputs retain roundtrip data; declared HTTP DateTime presentation is qualified separately below.
test('DateTime HTTP output presentation is separate from input ticks and SDK roundtrip data', async (t) => {
  const operation = 'invented_DateReply',
    operationId = id(80);
  const f = await contractModuleFixture(t, {
    tables: {
      customapi: [
        {
          customapiid: operationId,
          uniquename: operation,
          bindingtype: 0,
          isfunction: false,
          allowedcustomprocessingsteptype: 0,
        },
      ],
      customapirequestparameter: [
        {
          customapirequestparameterid: id(81),
          customapiid: operationId,
          uniquename: 'Stamp',
          type: 1,
          isoptional: true,
        },
      ],
      customapiresponseproperty: [
        { customapiresponsepropertyid: id(82), customapiid: operationId, uniquename: 'Reply', type: 1 },
        { customapiresponsepropertyid: id(83), customapiid: operationId, uniquename: 'InputRoundtrip', type: 10 },
      ],
    },
    extension: {
      name: 'customapi',
      install: (api) =>
        install(api, {
          handlers: new Map([
            [
              operation.toLowerCase(),
              { handler: (ctx) => ({ outputs: { Reply: ctx.inputs.Stamp, InputRoundtrip: ctx.inputs.Stamp } }) },
            ],
          ]),
        }).ready,
    },
  });
  // @test-kind parity: A default CLR DateTime roundtrip exposed through a declared HTTP response is UTC minimum without an all-zero fraction.
  // @parity-evidence: The protected native DateTime capsule binds the exact minimum UTC response in both native1071 cohorts; SDK default input spelling is retained separately below.
  await t.test('native minimum DateTime HTTP output', async () => {
    const bytes = await fs.readFile(new URL('./fixtures/webapi-native-customapi-datetime.json', import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '004a6c0c0035402ef7ab1778a046f6b73b0eda8581b8c458623d878b2acf0e6e',
    );
    const result = await f.json(await f.request('POST', '/' + operation, {}), 200);
    assert.equal(result.Reply, JSON.parse(bytes).minimumHttpText);
  });
  // @test-kind parity: Native input roundtrip strings preserve seven-digit UTC ticks, while declared DateTime HTTP outputs omit fractions.
  // @parity-evidence: dataverse-native-datetime-precision.json binds two fresh three-case native rounds, actual CLR source/DLL/MVID, CSDL property types and all-eight cleanup. The fixed CLR output is returned simultaneously as String and DateTime, establishing the output boundary without rounding inputs.
  await t.test('native DateTime HTTP fractions are omitted without rounding input or string output', async () => {
    const bytes = await fs.readFile(new URL('./fixtures/dataverse-native-datetime-precision.json', import.meta.url));
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '5ae319a732cdf9534a3f3da37ad4d72239a17a3270e9d9d3f1f4bad67f07f82b',
    );
    const proof = JSON.parse(bytes);
    assert.deepEqual(proof.expected, {
      inputUtcTicksRetained: true,
      dateTimeOutputFractionalDigits: 0,
      stringOutputTicksRetained: true,
    });
    for (const raw of ['2026-10-19T00:00:00.1234567Z', '2026-10-19T00:00:00.1200000Z']) {
      const result = await f.json(await f.request('POST', '/' + operation, { Stamp: raw }), 200);
      assert.equal(result.Reply, raw.replace(/\.\d+(?=Z$)/, ''));
      assert.equal(result.InputRoundtrip, raw);
    }
  });
  const actor = f.store.tableRows('systemuser').find((row) => row.applicationid);
  const service = localOrganizationService(f.store, {
    userId: actor.systemuserid,
    evidence: 'Invented DateTime typed-output contract',
    grants: [{ message: operation, operations: ['execute'] }],
  });
  const sdk = await f.store.transact(() =>
    service.executeMessageSync(operation, null, { $type: 'ParameterCollection', values: {} }),
  );
  assert.equal(sdk.outputs.values.Reply.$type, 'DateTime');
  assert.equal(sdk.outputs.values.Reply.value, '0001-01-01T00:00:00.0000000');
});
