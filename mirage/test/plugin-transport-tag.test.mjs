import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { install as installCustomApis, prepareCustomApiRuntimes } from '../lib/dataverse-customapi.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { envelope, encodeValue } from '../lib/dataverse-soap-xml.mjs';
import { prepareClrRuntime, closeClrHostPool, dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pair = (key, value) =>
  `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${encodeValue('b:value', value)}</a:KeyValuePairOfstringanyType>`;
const request = (name, values = {}) =>
  envelope(
    `<svc:Execute><svc:request i:type="a:OrganizationRequest"><a:Parameters>${Object.entries(values)
      .map(([key, value]) => pair(key, value))
      .join('')}</a:Parameters><a:RequestName>${name}</a:RequestName></svc:request></svc:Execute>`,
  );
const text = (value) => ({ type: 'string', value });
const entity = (name) => ({
  type: 'Entity',
  logicalName: 'widget',
  id: '00000000-0000-0000-0000-000000000000',
  attributes: new Map([['name', text(name)]]),
});
const administrator = (f) =>
  f.store
    .tableRows('systemuser')
    .find((row) => f.api.principals.roles(row).some((role) => role.name === 'System Administrator'));
const soap = (f, name, values) => {
  const user = administrator(f);
  assert.ok(user);
  return handleSoap(
    {
      method: 'POST',
      headers: {},
      bodyText: request(name, values),
      origin: f.server.origin,
      user,
      caller: user,
      identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid },
    },
    f.api,
  );
};

test(
  'original CLR HTTP and SOAP reads, writes, custom APIs and SDK descendants receive isolated request tags',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-transport-tag-'));
    let backend;
    t.after(async () => {
      await backend?.close();
      await closeClrHostPool();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    });
    const sdk = clrSdk(),
      source = path.join(root, 'Tags.cs'),
      assembly = path.join(root, 'Tags.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented {
public sealed class Observe:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.MessageName=="RetrieveMultiple"){var q=c.InputParameters["Query"];if((q is QueryExpression&&((QueryExpression)q).ColumnSet!=null)||(q is QueryByAttribute&&((QueryByAttribute)q).ColumnSet!=null))throw new Exception("Nil query ColumnSet lost");foreach(var e in ((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).Entities)if(e.Attributes.Count!=1||!e.Contains("widgetid"))throw new Exception("Nil projection must contain only PK");return;}string tag=c.SharedVariables.Contains("tag")?(string)c.SharedVariables["tag"]:"<absent>";if(tag=="reject")throw new InvalidPluginExecutionException("Tag rejection");if(c.MessageName=="Retrieve"){((Entity)c.OutputParameters["BusinessEntity"])["note"]=tag;return;}if(c.Stage==10)c.SharedVariables["early"]=tag;if(c.Stage==20){if(tag!="<absent>"&&(string)c.ParentContext.SharedVariables["tag"]!=tag)throw new Exception("PreValidation tag lost");((Entity)c.InputParameters["Target"])["note"]=tag;if(tag=="nested"){var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);s.Create(new Entity("child"));}}}}
public sealed class Child:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(((string)c.SharedVariables["tag"]!="nested"&&(string)c.SharedVariables["tag"]!="mutate-main")||c.Depth!=2)throw new Exception("SDK descendant tag/depth lost");((Entity)c.InputParameters["Target"])["note"]=(string)c.SharedVariables["tag"];}}
public sealed class Main:IPlugin {public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));if(c.SharedVariables.Contains("tag")&&(string)c.SharedVariables["tag"]=="mutate-main"){c.SharedVariables["tag"]="visible-main";var s=((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);s.Create(new Entity("child"));}c.OutputParameters["Reply"]=c.SharedVariables.Contains("tag")?(string)c.SharedVariables["tag"]:"<absent>";}}
}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const descriptors = new Map(),
      mainName = 'invented_TagMain';
    const f = await contractModuleFixture(t, {
      mappings: Object.fromEntries(
        ['widget', 'child'].map((name) => [
          name,
          {
            logicalName: name,
            entitySet: name + 's',
            idColumn: name + 'id',
            fields: { name: { dataverseType: 'nvarchar' }, note: { dataverseType: 'nvarchar' } },
          },
        ]),
      ),
      tables: {
        widget: [],
        child: [],
        customapi: [{ customapiid: id(80), uniquename: mainName, bindingtype: 0, plugintypeid: id(81) }],
        customapiresponseproperty: [
          { customapiresponsepropertyid: id(82), customapiid: id(80), uniquename: 'Reply', type: 10 },
        ],
        plugintype: [{ plugintypeid: id(81), typename: 'Invented.Main', pluginassemblyid: id(83) }],
        pluginassembly: [{ pluginassemblyid: id(83), name: 'Tags' }],
      },
      extension: { name: 'dataverse-customapi', install: installCustomApis },
      options: { pluginRuntimes: descriptors },
    });
    const user = administrator(f).systemuserid;
    const descriptor = {
      trust: 'execute-local-assembly',
      root,
      assembly: 'Tags.dll',
      typeName: 'Invented.Observe',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      timeoutMs: 8000,
      serviceProfile: {
        userId: user,
        evidence: 'Invented transport tag source',
        grants: [
          { entity: 'child', operations: ['create'] },
          { entity: 'widget', operations: ['read'] },
        ],
      },
      context: { executionUserId: user, initiatingUserId: user, organizationId: user, businessUnitId: user },
    };
    const runtime = await prepareClrRuntime(descriptor);
    descriptors.set(id(80), {
      ...descriptor,
      typeName: 'Invented.Main',
      context: {
        ...descriptor.context,
        mainOperationStepId: id(84),
        mainOperationStepEvidence: 'Invented explicit custom API main identity',
      },
    });
    await prepareCustomApiRuntimes(f.api);
    const steps = [10, 20, 40].map((stage, index) => ({
      id: id(index + 1),
      entity: 'widget',
      message: 'Create',
      stage,
      typeName: 'Invented.Observe',
    }));
    steps.push(
      { id: id(12), entity: 'widget', message: 'RetrieveMultiple', stage: 40, typeName: 'Invented.Observe' },
      { id: id(10), entity: 'widget', message: 'Retrieve', stage: 40, typeName: 'Invented.Observe' },
      { id: id(11), entity: 'child', message: 'Create', stage: 20, typeName: 'Invented.Child' },
    );
    for (const step of steps)
      Object.assign(step, {
        enabled: true,
        rank: 1,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        assemblyId: 'invented',
      });
    ({ backend } = await attachClrSteps(t, {
      store: f.store,
      steps,
      runtime: (step) => ({
        ...runtime,
        descriptor: { ...runtime.descriptor, typeName: step.typeName },
        provenance: { ...runtime.provenance, typeName: step.typeName },
      }),
    }));
    const written = await f.json(await f.request('POST', '/widgets?tag=HTTP-write', { name: 'HTTP' }), 201);
    assert.equal(written.note, 'HTTP-write');
    const read = await f.json(await f.request('GET', `/widgets(${written.widgetid})?$select=note&tag=HTTP-read`), 200);
    assert.equal(read.note, 'HTTP-read');
    assert.equal(f.store.tableRows('widget')[0].note, 'HTTP-write');
    const created = await soap(f, 'Create', { Target: entity('SOAP'), tag: text('SOAP-write') });
    assert.equal(created.status, 200, created.body);
    const stored = f.store.tableRows('widget').find((row) => row.name === 'SOAP');
    assert.equal(stored.note, 'SOAP-write');
    const retrieved = await soap(f, 'Retrieve', {
      Target: { type: 'EntityReference', logicalName: 'widget', id: stored.widgetid },
      ColumnSet: { type: 'ColumnSet', allColumns: false, columns: ['note'] },
      tag: text('SOAP-read'),
    });
    assert.equal(retrieved.status, 200, retrieved.body);
    assert.match(retrieved.body, /SOAP-read/);
    assert.equal((await f.json(await f.request('POST', '/' + mainName + '?tag=HTTP-api', {}), 200)).Reply, 'HTTP-api');
    const main = await soap(f, mainName, { tag: text('SOAP-api') });
    assert.equal(main.status, 200, main.body);
    assert.match(main.body, /SOAP-api/);
    assert.equal((await f.request('POST', '/widgets?tag=reject', { name: 'Rejected' })).status, 400);
    assert.equal(
      f.store.tableRows('widget').some((row) => row.name === 'Rejected'),
      false,
    );
    const untagged = await f.json(await f.request('POST', '/widgets', { name: 'Untagged' }), 201);
    assert.equal(untagged.note, '<absent>');
    await f.json(await f.request('POST', '/widgets?tag=nested', { name: 'Nested' }), 201);
    assert.equal(f.store.tableRows('child')[0].note, 'nested');
    const mutatedMain = await f.json(await f.request('POST', '/' + mainName + '?tag=mutate-main', {}), 200);
    assert.equal(mutatedMain.Reply, 'visible-main');
    assert.equal(
      f.store.tableRows('child').at(-1).note,
      'mutate-main',
      'Canonical request tag must survive an original Custom API main SharedVariables edit',
    );
    for (const type of ['QueryExpression', 'QueryByAttribute']) {
      const query = {
        $type: type,
        entityName: 'widget',
        columnSet: null,
        ...(type === 'QueryExpression'
          ? { criteria: { operatorName: 'And', conditions: [] } }
          : { attributes: [], values: [] }),
      };
      const result = await f.store.readOperation(() =>
        dispatchSdkCall({
          store: f.store,
          profile: descriptor.serviceProfile,
          message: { method: 'RetrieveMultiple', userId: user, arguments: [query] },
        }),
      );
      assert.equal(result.entities.length, f.store.tableRows('widget').length);
      for (const row of result.entities) assert.deepEqual(Object.keys(row.attributes), ['widgetid']);
    }
    assert.equal(f.store.pluginSdkTag, undefined);
  },
);

test('concurrent HTTP and SOAP tags survive controlled awaits without leaking across failures or later requests', async (t) => {
  let releaseAll;
  t.after(() => releaseAll?.());
  const f = await contractModuleFixture(t, { extension: { name: 'invented-tag-gates', install: () => {} } });
  const waiting = new Map(),
    entered = new Map(),
    observed = [];
  const gate = new Promise((resolve) => {
    releaseAll = resolve;
  });
  for (const name of ['HTTP-A', 'HTTP-B', 'SOAP-A', 'SOAP-B'])
    waiting.set(name, new Promise((resolve) => entered.set(name, resolve)));
  f.api.registry.register({
    name: 'invented_TagGate',
    kind: 'action',
    binding: 'unbound',
    handle: async (context) => {
      const tag = f.store.pluginSdkTag;
      assert.equal(Object.hasOwn(context.body ?? {}, 'tag'), false);
      if (entered.has(tag)) {
        entered.get(tag)();
        await gate;
      }
      observed.push([tag, f.store.pluginSdkTag]);
      if (tag === 'HTTP-B' || tag === 'SOAP-B') throw new Error('Invented request rejection');
      return { status: 204 };
    },
  });
  const requests = [
    f.request('POST', '/invented_TagGate?tag=HTTP-A', {}),
    f.request('POST', '/invented_TagGate?tag=HTTP-B', {}),
    soap(f, 'invented_TagGate', { tag: text('SOAP-A') }),
    soap(f, 'invented_TagGate', { tag: text('SOAP-B') }),
  ];
  await Promise.race([
    Promise.all(waiting.values()),
    ...requests.map(async (request) => {
      const response = await request;
      throw new Error(`A request completed before all controlled gates entered (${response.status})`);
    }),
  ]);
  assert.equal(f.store.pluginSdkTag, undefined);
  releaseAll();
  const answers = await Promise.all(requests);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [204, 500, 200, 500],
  );
  assert.equal(observed.length, 4);
  assert.ok(observed.every(([before, after]) => before === after));
  assert.equal((await f.request('POST', '/invented_TagGate', {})).status, 204);
  assert.deepEqual(observed.at(-1), [undefined, undefined]);
  const beforeBatch = observed.length;
  const batch = await f.request('POST', '/$batch?tag=wrapper', {
    requests: [
      { id: '1', method: 'POST', url: 'invented_TagGate?tag=batch-member', body: {} },
      { id: '2', method: 'POST', url: 'invented_TagGate', body: {} },
    ],
  });
  assert.equal(batch.status, 200, await batch.text());
  assert.deepEqual(
    observed.slice(beforeBatch),
    [
      ['batch-member', 'batch-member'],
      [undefined, undefined],
    ],
    'Batch members own their tag; the wrapper tag must not bleed into untagged members',
  );
  assert.equal(f.store.pluginSdkTag, undefined);
});
