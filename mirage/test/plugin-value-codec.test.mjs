// @test-kind compatibility: Microsoft.Xrm.Sdk public type shapes (ConcurrencyBehavior, Entity, collections, messages) round-trip through the codec
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  pluginMessageParameters,
  pluginMessageValues,
  reconcilePluginMessageParameters,
} from '../lib/plugin-message-values.mjs';
import { pluginExecutionLifetime } from '../lib/plugin-execution-lifetime.mjs';
import { exactNumeric } from '../lib/exact-numeric.mjs';
import { pluginValueCases } from './fixtures/plugin-value-cases.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';
import { prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
const id = '11111111-1111-4111-8111-111111111111',
  other = '22222222-2222-4222-8222-222222222222';
function storeOf() {
  const state = emptyState();
  state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
  state.mappings.trigger = { entitySet: 'triggers', idColumn: 'triggerid' };
  state.tables.widget = [];
  state.tables.trigger = [];
  return new DataStore({ state });
}
const decode = (wire, store) => pluginMessageValues({ values: { Value: wire } }, store).Value;
test('ConcurrencyBehavior rejects undefined members and nonnumeric enum DTOs', () => {
  for (const value of [-1, 3, '0', null, true, 1.5]) {
    assert.throws(() => pluginMessageValues({ values: { Mode: { $type: 'ConcurrencyBehavior', value } } }), {
      code: 'LocalPluginSdkUnsupported',
    });
    if (value !== null)
      assert.throws(
        () =>
          pluginMessageParameters(undefined, [{ uniquename: 'Mode', type: 'ConcurrencyBehavior' }], { Mode: value }),
        {
          code: 'LocalPluginSdkUnsupported',
        },
      );
  }
});
test('new Entity attributes normalize internal exact numeric markers without field metadata', () => {
  const store = storeOf(),
    prior = { values: { Row: { $type: 'Entity', logicalName: 'widget', id, attributes: { title: 'Before' } } } },
    before = pluginMessageValues(prior, store),
    after = structuredClone(before);
  after.Row.cash = exactNumeric('9007199254740993.25', 'Money');
  after.Row.payload = { amount: exactNumeric('9007199254740993.25', 'Decimal') };
  const result = reconcilePluginMessageParameters(store, [], prior, before, after).values.Row;
  assert.deepEqual(result.attributes.cash, { $type: 'Money', value: '9007199254740993.25' });
  assert.deepEqual(result.attributes.payload, { amount: { $type: 'Decimal', value: '9007199254740993.25' } });
});
for (const [label, wire, modify] of pluginValueCases())
  test('recursive SDK value codec: ' + label, () => {
    const store = storeOf(),
      prior = { values: { Value: structuredClone(wire) } },
      before = pluginMessageValues(prior, store),
      after = structuredClone(before);
    after.Value = modify(after.Value);
    const output = reconcilePluginMessageParameters(store, [], prior, before, after).values.Value;
    assert.equal(output?.$type, wire.$type);
    assert.deepEqual(decode(output, store), after.Value);
    const nested = {
      values: {
        Item: {
          $type: 'Entity',
          logicalName: 'widget',
          id,
          attributes: { title: 'Before', payload: structuredClone(wire) },
        },
      },
    };
    const old = pluginMessageValues(nested, store),
      changed = structuredClone(old);
    changed.Item.title = 'After';
    assert.deepEqual(
      reconcilePluginMessageParameters(store, [], nested, old, changed).values.Item.attributes.payload,
      wire,
      'unrelated edits retain the complete native child',
    );
    changed.Item.payload = modify(changed.Item.payload);
    const result = reconcilePluginMessageParameters(store, [], nested, old, changed).values.Item.attributes.payload;
    assert.equal(result?.$type, wire.$type);
    assert.deepEqual(decode(result, store), changed.Item.payload);
  });
test('duplicate-ID tuples preserve occurrence metadata across reorder, modification and invocation facades', () => {
  const store = storeOf();
  for (const type of ['EntityCollection', 'SdkArray']) {
    const rows = ['First', 'Second'].map((title) => ({
      $type: 'Entity',
      logicalName: 'widget',
      id,
      attributes: { title },
      formattedValues: { title: title + ' label' },
      rowVersion: title === 'First' ? '11' : '12',
    }));
    const collection =
      type === 'EntityCollection'
        ? { $type: type, entities: rows }
        : { $type: type, elementType: 'Entity', values: rows };
    for (const facade of [false, true]) {
      const prior = { values: { Rows: collection } },
        before = pluginMessageValues(prior, store);
      const lifetime = pluginExecutionLifetime(store);
      const after = lifetime.run(() => ({ Rows: facade ? lifetime.exposed(before.Rows) : before.Rows }));
      after.Rows.reverse();
      after.Rows[0].title = 'Modified second';
      const snapshot = lifetime.snapshot(after);
      lifetime.close();
      const result = reconcilePluginMessageParameters(store, [], prior, pluginMessageValues(prior, store), snapshot)
        .values.Rows;
      const answer = result.entities ?? result.values;
      assert.deepEqual(
        answer.map((row) => [row.attributes.title, row.formattedValues.title, row.rowVersion]),
        [
          ['Modified second', 'Second label', '12'],
          ['First', 'First label', '11'],
        ],
      );
    }
    const before = pluginMessageValues({ values: { Rows: collection } }, store),
      after = structuredClone(before);
    after.Rows.reverse();
    const result = reconcilePluginMessageParameters(store, [], { values: { Rows: collection } }, before, after).values
      .Rows;
    assert.deepEqual(
      (result.entities ?? result.values).map((row) => row.formattedValues.title),
      ['Second label', 'First label'],
    );
    after.Rows[0].title = 'Ambiguous copied tuple';
    assert.throws(() => reconcilePluginMessageParameters(store, [], { values: { Rows: collection } }, before, after), {
      code: 'LocalPluginValueAmbiguous',
    });
  }
});
const specs = (name) => {
  if (name.startsWith('ConcurrencyBehavior/')) {
    const value = Number(name.split('/')[1]);
    return ['(ConcurrencyBehavior)' + value, '(ConcurrencyBehavior)v==(ConcurrencyBehavior)' + ((value + 1) % 3)];
  }
  const simple = {
    Guid: ['new Guid("' + id + '")', '(Guid)v==new Guid("' + other + '")'],
    DateTime: [
      'new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc)',
      '(DateTime)v==new DateTime(2026,10,2,0,0,0,DateTimeKind.Utc)',
    ],
    Money: ['new Money(9007199254740993.25m)', '((Money)v).Value==9007199254740994.25m'],
    Decimal: ['9007199254740993.25m', '(decimal)v==9007199254740994.25m'],
    Int64: ['9007199254740993L', '(long)v==9007199254740994L'],
    Double: ['1.5d', '(double)v==2.5d'],
    OptionSetValue: ['new OptionSetValue(1)', '((OptionSetValue)v).Value==2'],
    OptionSetValueCollection: [
      'new OptionSetValueCollection(new[]{new OptionSetValue(1)})',
      '((OptionSetValueCollection)v).Count==2&&((OptionSetValueCollection)v)[1].Value==2',
    ],
    EntityReference: [
      'Reference()',
      '((EntityReference)v).Name=="After"&&((EntityReference)v).RowVersion=="17"&&(string)((EntityReference)v).KeyAttributes["code"]=="Before"',
    ],
    Entity: [
      'Row()',
      '((Entity)v).GetAttributeValue<string>("title")=="After"&&((Entity)v).RowVersion=="18"&&((Entity)v).FormattedValues["title"]=="Original label"',
    ],
    EntityCollection: [
      'new EntityCollection(new[]{Row()}){MoreRecords=true,TotalRecordCount=2,PagingCookie="cookie"}',
      '((EntityCollection)v).Entities[0].GetAttributeValue<string>("title")=="After"&&((EntityCollection)v).MoreRecords&&((EntityCollection)v).TotalRecordCount==2',
    ],
    AliasedValue: [
      'new AliasedValue("widget","title","Before")',
      '((AliasedValue)v).EntityLogicalName=="widget"&&((AliasedValue)v).AttributeLogicalName=="title"&&(string)((AliasedValue)v).Value=="After"',
    ],
    AliasedColumnSet: [
      'new AliasedValue("widget","title",new ColumnSet("title"))',
      '((AliasedValue)v).EntityLogicalName=="widget"&&((AliasedValue)v).AttributeLogicalName=="title"&&((ColumnSet)((AliasedValue)v).Value).Columns.Contains("code")',
    ],
    Bytes: ['new byte[]{1,2}', 'Convert.ToBase64String((byte[])v)=="AwQ="'],
    EntityReferenceCollection: [
      'new EntityReferenceCollection(new[]{Reference()})',
      '((EntityReferenceCollection)v)[0].Name=="After"&&((EntityReferenceCollection)v)[0].RowVersion=="17"',
    ],
    Relationship: ['new Relationship("before")', '((Relationship)v).SchemaName=="after"'],
    ParameterCollection: [
      'new ParameterCollection{{"Label","Before"}}',
      '(string)((ParameterCollection)v)["Label"]=="After"',
    ],
    OrganizationRequest: [
      'new OrganizationRequest("x_Before"){RequestId=new Guid("10000000-0000-4000-8000-000000000097"),Parameters=new ParameterCollection{{"cash",new Money(4.25m)}}}',
      '((OrganizationRequest)v).RequestId==new Guid("10000000-0000-4000-8000-000000000097")&&((OrganizationRequest)v).RequestName=="x_After"&&((Money)((OrganizationRequest)v).Parameters["cash"]).Value==4.25m',
    ],
    ColumnSet: [
      'new ColumnSet("title")',
      '!((ColumnSet)v).AllColumns&&((ColumnSet)v).Columns.Contains("title")&&((ColumnSet)v).Columns.Contains("code")',
    ],
    FetchExpression: ['new FetchExpression("Before")', '((FetchExpression)v).Query=="After"'],
    QueryExpression: [
      'new QueryExpression("widget"){ColumnSet=new ColumnSet("title")}',
      '((QueryExpression)v).TopCount==2&&((QueryExpression)v).ColumnSet.Columns.Contains("title")',
    ],
    QueryByAttribute: ['ByAttribute()', '(string)((QueryByAttribute)v).Values[0]=="After"'],
    LinkEntity: [
      'new LinkEntity("widget","widget","widgetid","widgetid",JoinOperator.LeftOuter){EntityAlias="Before"}',
      '((LinkEntity)v).EntityAlias=="After"',
    ],
    EntityImageCollection: [
      'new EntityImageCollection{{"Before",Row()}}',
      '((EntityImageCollection)v)["Before"].GetAttributeValue<string>("title")=="After"',
    ],
    EntityImageCollectionArray: [
      'new[]{new EntityImageCollection{{"Before",Row()}}}',
      '((EntityImageCollection[])v)[0]["Before"].GetAttributeValue<string>("title")=="After"',
    ],
    GuidArray: ['new[]{new Guid("' + id + '")}', '((Guid[])v)[0]==new Guid("' + other + '")'],
    ExecutionContext: ['c.ParentContext', '(string)((IPluginExecutionContext)v).SharedVariables["Label"]=="After"'],
    BooleanManagedProperty: [
      'Managed()',
      '!((BooleanManagedProperty)v).Value&&!((BooleanManagedProperty)v).CanBeChanged&&((BooleanManagedProperty)v).ManagedPropertyLogicalName=="InventedPolicy"',
    ],
    OrganizationResponse: [
      'new OrganizationResponse{ResponseName="x_Before",Results=new ParameterCollection{{"cash",new Money(4.25m)}}}',
      '((OrganizationResponse)v).ResponseName=="x_After"&&((Money)((OrganizationResponse)v).Results["cash"]).Value==4.25m',
    ],
    TypedOrganizationRequest: [
      'new Microsoft.Xrm.Sdk.Messages.CreateRequest{RequestId=Guid.Empty,Target=Row()}',
      'v is Microsoft.Xrm.Sdk.Messages.CreateRequest&&((Microsoft.Xrm.Sdk.Messages.CreateRequest)v).RequestId==Guid.Empty&&((Microsoft.Xrm.Sdk.Messages.CreateRequest)v).Target.GetAttributeValue<string>("title")=="After"',
    ],
    TypedOrganizationResponse: [
      'new Microsoft.Xrm.Sdk.Messages.RetrieveResponse{Results=new ParameterCollection{{"Entity",Row()}}}',
      'v is Microsoft.Xrm.Sdk.Messages.RetrieveResponse&&((Microsoft.Xrm.Sdk.Messages.RetrieveResponse)v).Entity.GetAttributeValue<string>("title")=="After"',
    ],
    Dictionary: [
      'new Dictionary<string,object>{{"Label","Before"},{"cash",new Money(4.25m)}}',
      '(string)((Dictionary<string,object>)v)["Label"]=="After"&&((Money)((Dictionary<string,object>)v)["cash"]).Value==4.25m',
    ],
    DictionaryDiscriminator: [
      'new Dictionary<string,object>{{"$type","Money"},{"value","Before"},{"attributes",new Dictionary<string,object>{{"id","literal-id"},{"values",new[]{"literal-values"}}}},{"cash",new Money(4.25m)}}',
      '(string)((Dictionary<string,object>)v)["$type"]=="Money"&&(string)((Dictionary<string,object>)v)["value"]=="After"&&((Money)((Dictionary<string,object>)v)["cash"]).Value==4.25m&&(string)((Dictionary<string,object>)((Dictionary<string,object>)v)["attributes"])["id"]=="literal-id"&&((string[])((Dictionary<string,object>)((Dictionary<string,object>)v)["attributes"])["values"])[0]=="literal-values"',
    ],
    ObjectArrayDictionary: [
      'new object[]{new Dictionary<string,object>{{"$type","Money"},{"value","Before"}}}',
      '(string)((Dictionary<string,object>)((object[])v)[0])["$type"]=="Money"&&(string)((Dictionary<string,object>)((object[])v)[0])["value"]=="After"',
    ],
  };
  if (simple[name]) return simple[name];
  const [array, element] = name.split('/');
  if (array === 'PrimitiveArray') {
    const values = {
      String: ['string', '"Before"', '"After"'],
      Int32: ['int', '1', '2'],
      Boolean: ['bool', 'false', 'true'],
      Int64: ['long', '9007199254740993L', '9007199254740994L'],
      Decimal: ['decimal', '9007199254740993.25m', '9007199254740994.25m'],
      Double: ['double', '1.5d', '2.5d'],
      DateTime: [
        'DateTime',
        'new DateTime(2026,10,1,0,0,0,DateTimeKind.Utc)',
        'new DateTime(2026,10,2,0,0,0,DateTimeKind.Utc)',
      ],
    };
    const [type, old, value] = values[element];
    return ['new ' + type + '[]{' + old + '}', '((' + type + '[])v)[0]==' + value];
  }
  if (element === 'String[]') return ['new[]{new[]{"Before"}}', '((string[][])v)[0][0]=="After"'];
  if (element === 'Money') return ['new[]{new Money(4.25m)}', '((Money[])v)[0].Value==5.25m'];
  const [source, check] = simple[element];
  return [
    'new ' + element + '[]{' + source + '}',
    check.replaceAll('((' + element + ')v)', '((' + element + '[])v)[0]'),
  ];
};
test(
  'original CLR and modifying JavaScript preserve the finite SDK type matrix in both directions',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-sdk-type-matrix-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const cases = pluginValueCases();
    const sdk = clrSdk(),
      source = path.join(root, 'Matrix.cs'),
      assembly = path.join(root, 'Matrix.dll');
    const constructors = cases.map(([name], index) => 'values["K' + index + '"]=' + specs(name)[0] + ';').join('');
    const assertions = cases
      .map(
        ([name], index) =>
          '{object v=c.SharedVariables["K' +
          index +
          '"];if(!(' +
          specs(name)[1] +
          '))throw new Exception("Top ' +
          name +
          '");v=((Entity)c.SharedVariables["Nested"])["K' +
          index +
          '"];if(!(' +
          specs(name)[1] +
          '))throw new Exception("Nested ' +
          name +
          '");}',
      )
      .join('');
    await fs.writeFile(
      source,
      'using System;using System.Collections.Generic;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented{public sealed class Payload{}public sealed class Enumerable:System.Collections.IEnumerable{public System.Collections.IEnumerator GetEnumerator(){return new[]{1}.GetEnumerator();}}public sealed class Map:Dictionary<string,object>{}public sealed class CustomRequest:OrganizationRequest{public CustomRequest():base("Create"){}}public sealed class CustomResponse:OrganizationResponse{}public sealed class Outer:IPlugin{public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var child=new Entity("widget");var target=(Entity)c.InputParameters["Target"];if(target.Contains("invalid"))child["invalid"]=target["invalid"];((IOrganizationServiceFactory)p.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId).Create(child);}}public sealed class Matrix:IPlugin{static BooleanManagedProperty Managed(){var json=System.Text.Encoding.UTF8.GetBytes(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(new {Value=true,CanBeChanged=false,ManagedPropertyLogicalName="InventedPolicy"}));using(var stream=new System.IO.MemoryStream(json))return (BooleanManagedProperty)new System.Runtime.Serialization.Json.DataContractJsonSerializer(typeof(BooleanManagedProperty)).ReadObject(stream);}static Entity Row(){var e=new Entity("widget",new Guid("' +
        id +
        '")){RowVersion="18"};e["title"]="Before";e.FormattedValues["title"]="Original label";return e;}static EntityReference Reference(){var e=new EntityReference("widget",new Guid("' +
        id +
        '")){Name="Before",RowVersion="17"};e.KeyAttributes["code"]="Before";return e;}static QueryByAttribute ByAttribute(){var q=new QueryByAttribute("widget"){ColumnSet=new ColumnSet("title")};q.AddAttributeValue("title","Before");return q;}public void Execute(IServiceProvider p){var c=(IPluginExecutionContext)p.GetService(typeof(IPluginExecutionContext));var target=(Entity)c.InputParameters["Target"];if(target.Contains("invalid")){var invalid=(string)target["invalid"];c.SharedVariables["Unsupported"]=invalid=="payload"?(object)new Payload():invalid=="dictionary"?new Map():invalid=="request"?new CustomRequest():invalid=="response"?(object)new CustomResponse():invalid=="enum"?(object)(ConcurrencyBehavior)7:invalid=="arbitrary-enum"?(object)System.IO.FileAccess.Read:new Enumerable();return;}if(c.SharedVariables.Contains("Nested")){' +
        assertions +
        'return;}var values=new ParameterCollection();' +
        constructors +
        'var nested=Row();foreach(var entry in values){c.SharedVariables[entry.Key]=entry.Value;nested[entry.Key]=entry.Value;}c.SharedVariables["Nested"]=nested;}}}',
    );
    compileClr(source, assembly, {
      references: [sdk, 'System.Runtime.Serialization.dll', 'System.Web.Extensions.dll'],
    });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root,
      assembly: 'Matrix.dll',
      typeName: 'Invented.Matrix',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      // Semantic matrix failures must reach their codec assertion after nested
      // original SDK observer calls; intentional deadline cases live elsewhere.
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      serviceProfile: {
        userId: id,
        evidence: 'Invented finite SDK type matrix',
        grants: [{ entity: 'widget', operations: ['create'] }],
      },
      context: { executionUserId: id, initiatingUserId: id, organizationId: id, businessUnitId: id },
    });
    const store = storeOf();
    let changed = false,
      invalidEnumWire = false;
    const steps = [
      ['trigger', 20, 1, 'Invented.Outer'],
      ['widget', 40, 1, 'Invented.Matrix'],
      ['widget', 40, 2, 'Invented.Bridge'],
      ['widget', 40, 3, 'Invented.Matrix'],
    ].map(([entity, stage, rank, typeName], index) => ({
      id: '33333333-3333-4333-8333-33333333333' + index,
      enabled: true,
      entity,
      message: 'Create',
      stage,
      mode: 0,
      rank,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName,
      assemblyId: 'invented',
    }));
    await attachClrSteps(t, {
      store,
      steps,
      runtime: (step) =>
        step.typeName === 'Invented.Bridge'
          ? null
          : step.typeName === 'Invented.Outer'
            ? retypeClrRuntime(runtime, { typeName: step.typeName })
            : runtime,
      handlers: new Map([
        [
          'Invented.Bridge',
          ({ context }) => {
            changed = true;
            for (const [index, entry] of cases.entries()) {
              const modify = entry[2];
              context.SharedVariables['K' + index] = modify(context.SharedVariables['K' + index]);
              context.SharedVariables.Nested['K' + index] = modify(context.SharedVariables.Nested['K' + index]);
            }
            if (invalidEnumWire) context.SharedVariables.K0 = { $type: 'ConcurrencyBehavior', value: 7 };
          },
        ],
      ]),
    });
    await store.create('trigger', {}, { admin: true });
    assert.equal(changed, true);
    assert.equal(store.tableRows('trigger').length, 1);
    assert.equal(store.tableRows('widget').length, 1);
    invalidEnumWire = true;
    await assert.rejects(store.create('trigger', {}, { admin: true }), /Unsupported SDK ConcurrencyBehavior value/);
    assert.equal(store.tableRows('trigger').length, 1);
    assert.equal(store.tableRows('widget').length, 1);
    invalidEnumWire = false;
    for (const invalid of ['payload', 'dictionary', 'request', 'response', 'enumerable', 'enum', 'arbitrary-enum']) {
      await assert.rejects(store.create('trigger', { invalid }, { admin: true }), /Unsupported SDK/);
      assert.equal(store.tableRows('trigger').length, 1, 'unsupported classes roll back the parent');
      assert.equal(store.tableRows('widget').length, 1, 'unsupported classes roll back the child');
    }
  },
);
