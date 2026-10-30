import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { DataStore } from '../lib/data.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { fromBulkDeleteJson, toFetchXml } from '../lib/dataverse-soap-query.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

test(
  'installed SDK SOAP query facets are refused before the record provider runs; empty defaults remain accepted',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-soap-query-facets-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Writer.cs'),
      executable = path.join(root, 'Writer.exe');
    await fs.copyFile(sdk, path.join(root, 'Microsoft.Xrm.Sdk.dll'));
    await fs.writeFile(
      source,
      `using System;using System.Runtime.Serialization;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;
class Writer {
static void Set(object value,string name,object item){value.GetType().GetProperty(name).SetValue(value,item,null);}
static void Expression(ColumnSet set){var list=set.GetType().GetProperty("AttributeExpressions").GetValue(set,null);var type=list.GetType().GetGenericArguments()[0];var item=Activator.CreateInstance(type);Set(item,"AttributeName","title");Set(item,"Alias","Projected");list.GetType().GetMethod("Add").Invoke(list,new[]{item});}
static void Main(string[] args){string mode=args[0];var q=new QueryExpression("widget"){ColumnSet=new ColumnSet("title")};var r=new OrganizationRequest("RetrieveMultiple");r.Parameters["Query"]=q;
if(mode=="columns"||mode=="retrieve-columns")Expression(q.ColumnSet);
if(mode=="empty-columns"||mode=="empty-body")q.ColumnSet=new ColumnSet(false);
if(mode=="nil-columns"||mode=="retrieve-nil")q.ColumnSet=null;
if(mode=="byattribute"||mode=="byattribute-nil"){var by=new QueryByAttribute("widget"){ColumnSet=new ColumnSet("title")};by.Attributes.Add("title");by.Values.Add("kept");if(mode=="byattribute-nil")by.ColumnSet=null;r.Parameters["Query"]=by;}
if(mode=="link"||mode=="empty-link-columns")q.LinkEntities.Add(new LinkEntity("widget","widget","widgetid","widgetid",JoinOperator.Inner){Columns=mode=="link"?new ColumnSet("title"):new ColumnSet(false)});
if(mode=="force")Set(q,"ForceSeek","configured");
if(mode=="subquery")Set(q,"SubQueryExpression",new QueryExpression("widget"));
if(mode=="order"){var order=new OrderExpression("title",OrderType.Ascending);Set(order,"Alias","Projected");q.Orders.Add(order);}
if(mode=="link-force"||mode=="link-columns"){var link=new LinkEntity("widget","widget","widgetid","widgetid",JoinOperator.Inner){Columns=new ColumnSet("title")};if(mode=="link-force")Set(link,"ForceSeek","configured");else Expression(link.Columns);q.LinkEntities.Add(link);}
if(mode=="retrieve-columns"||mode=="retrieve-nil"){r=new OrganizationRequest("Retrieve");r.Parameters["Target"]=new EntityReference("widget",new Guid("11111111-1111-4111-8111-111111111111"));r.Parameters["ColumnSet"]=q.ColumnSet;}
if(mode=="request-id")r.RequestId=new Guid("11111111-1111-4111-8111-111111111111");
if(mode=="body"||mode=="empty-body")new DataContractSerializer(typeof(ColumnSet)).WriteObject(Console.OpenStandardOutput(),q.ColumnSet);else new DataContractSerializer(typeof(OrganizationRequest)).WriteObject(Console.OpenStandardOutput(),r);}}
`,
    );
    compileClr(source, executable, { target: 'exe', references: [sdk, 'System.Runtime.Serialization.dll'] });
    const store = new DataStore({
      state: { mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } }, tables: { widget: [] } },
    });
    let calls = 0;
    const observed = [];
    const api = {
      store,
      records: {
        handle: (context) => {
          calls++;
          observed.push(context.sdkQuery ?? { $type: 'Retrieve', columnSet: context.sdkColumns });
          return {
            status: 200,
            body: context.route.key
              ? { widgetid: '11111111-1111-4111-8111-111111111111', title: 'kept' }
              : { value: [] },
          };
        },
      },
    };
    for (const mode of [
      'columns',
      'retrieve-columns',
      'force',
      'subquery',
      'order',
      'link-force',
      'link-columns',
      'request-id',
      'retrieve-nil',
      'empty',
      'empty-columns',
      'byattribute',
      'link',
      'empty-link-columns',
      'body',
      'empty-body',
      'nil-columns',
      'byattribute-nil',
    ]) {
      const written = spawnSync(executable, [mode], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(written.status, 0, written.stderr);
      const request = written.stdout
        .trim()
        .replace(
          '<OrganizationRequest ',
          `<svc:request xmlns:svc="${NS.svc}" i:type="a:OrganizationRequest" xmlns:a="${NS.a}" `,
        )
        .replace('</OrganizationRequest>', '</svc:request>');
      const bodyOperation = mode === 'body' || mode === 'empty-body';
      const operation = bodyOperation
        ? `<Retrieve xmlns="${NS.svc}"><entityName>widget</entityName><id>11111111-1111-4111-8111-111111111111</id>${written.stdout.trim().replace('<ColumnSet ', `<svc:columnSet xmlns:svc="${NS.svc}" `).replace('</ColumnSet>', '</svc:columnSet>')}</Retrieve>`
        : `<Execute xmlns="${NS.svc}">${request}</Execute>`;
      const response = await handleSoap(
        {
          method: 'POST',
          headers: {},
          origin: 'http://127.0.0.1',
          user: {},
          caller: {},
          identity: { admin: true },
          bodyText: `<s:Envelope xmlns:s="${NS.s}"><s:Body>${operation}</s:Body></s:Envelope>`,
        },
        api,
      );
      if (
        [
          'empty',
          'empty-columns',
          'byattribute',
          'link',
          'empty-link-columns',
          'body',
          'empty-body',
          'nil-columns',
          'byattribute-nil',
        ].includes(mode)
      ) {
        assert.equal(response.status, 200, response.body);
        assert.equal(calls, observed.length);
        if (mode === 'nil-columns' || mode === 'byattribute-nil') assert.equal(observed.at(-1).columnSet, null);
        else
          assert.deepEqual(observed.at(-1).columnSet, {
            allColumns: false,
            columns: mode === 'empty-columns' || mode === 'empty-body' ? [] : ['title'],
          });
        assert.equal(
          observed.at(-1).$type,
          bodyOperation ? 'Retrieve' : mode.startsWith('byattribute') ? 'QueryByAttribute' : 'QueryExpression',
        );
        if (mode === 'link' || mode === 'empty-link-columns')
          assert.deepEqual(observed.at(-1).linkEntities[0].columns, {
            allColumns: false,
            columns: mode === 'link' ? ['title'] : [],
          });
      } else {
        assert.equal(response.status, 500, response.body);
        assert.match(
          response.body,
          mode === 'retrieve-nil' ? /nil SOAP Retrieve ColumnSet/ : /Unsupported configured SDK property/,
          mode,
        );
        assert.equal(calls, 0, `${mode} must not reach a record handler`);
      }
    }
    assert.equal(calls, 9);
  },
);

test('BulkDelete JSON uses the same configured-facet guards and preserves supported filter and order metadata', () => {
  for (const value of [
    { ForceSeek: 'configured' },
    { SubQueryExpression: {} },
    { ColumnSet: { AttributeExpressions: [{ AttributeName: 'title', Alias: 'Projected' }] } },
    { Orders: [{ AttributeName: 'title', Alias: 'Projected' }] },
    { LinkEntities: [{ ForceSeek: 'configured' }] },
    { LinkEntities: [{ Columns: { AttributeExpressions: [{ AttributeName: 'title' }] } }] },
    { LinkEntities: [{ Orders: [{ AttributeName: 'title', Alias: 'Projected' }] }] },
  ])
    assert.throws(() => fromBulkDeleteJson({ EntityName: 'widget', ...value }), {
      code: 'LocalPluginQueryUnsupported',
    });
  const query = fromBulkDeleteJson({
    EntityName: 'widget',
    ForceSeek: null,
    SubQueryExpression: null,
    ColumnSet: { AttributeExpressions: [] },
    Orders: [{ AttributeName: 'title', EntityName: 'related', OrderType: 1, Alias: '' }],
    Criteria: {
      FilterHint: 'union',
      IsQuickFindFilter: true,
      Conditions: [{ AttributeName: 'title', Operator: 'Equal', Values: ['kept'] }],
    },
  });
  const xml = toFetchXml(query, { primaryIdOf: () => 'widgetid' });
  assert.match(xml, /hint="union" isquickfindfields="true"/);
  assert.match(xml, /order attribute="title" entityname="related" descending="true"/);
});
