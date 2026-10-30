import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CLR_SKIP, clrSdk } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test(
  'Installed SDK query paging codec preserves constructor, omitted, null and populated states',
  { skip: CLR_SKIP },
  async (t) => {
    const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-query-paging-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(dir, 'PagingProbe.cs'),
      exe = path.join(dir, 'PagingProbe.exe');
    await fs.copyFile(sdk, path.join(dir, 'Microsoft.Xrm.Sdk.dll'));
    await fs.writeFile(
      source,
      `using System;using System.Collections.Generic;using System.Reflection;using System.Web.Script.Serialization;using Microsoft.Xrm.Sdk.Query;
namespace Invented {public static class PagingProbe {
static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
static object Call(string name,params object[] args){try{return typeof(PaqviloPluginHost).GetMethod(name,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args);}catch(TargetInvocationException e){throw e.InnerException;}}
static object Encode(object query){return Call("Encode",query,0);}
static object Decode(string json){return Call("Decode",Json.DeserializeObject(json));}
static void Check(bool ok,string message){if(!ok)throw new Exception(message);}
static void Page(PagingInfo actual,PagingInfo expected){Check((actual==null)==(expected==null),"Paging null state changed");if(expected!=null)Check(actual.Count==expected.Count&&actual.PageNumber==expected.PageNumber&&actual.PagingCookie==expected.PagingCookie&&actual.ReturnTotalRecordCount==expected.ReturnTotalRecordCount,"Paging values changed");}
static void RoundTrip(QueryBase query){var encoded=Json.Serialize(Encode(query));var result=(QueryBase)Decode(encoded);if(query is QueryByAttribute){var a=(QueryByAttribute)query;var b=(QueryByAttribute)result;Page(b.PageInfo,a.PageInfo);Check(b.EntityName=="widget"&&b.ColumnSet.Columns[0]=="title"&&b.Attributes[0]=="title"&&(string)b.Values[0]=="Selected"&&b.Orders[0].AttributeName=="title"&&b.TopCount==3,"QueryByAttribute authored query changed");}else{var a=(QueryExpression)query;var b=(QueryExpression)result;Page(b.PageInfo,a.PageInfo);Check(b.EntityName=="widget"&&b.ColumnSet.Columns[0]=="title"&&(string)b.Criteria.Conditions[0].Values[0]=="Selected"&&b.Orders[0].AttributeName=="title"&&b.TopCount==3,"QueryExpression authored query changed");}}
static QueryByAttribute By(){var q=new QueryByAttribute("widget"){ColumnSet=new ColumnSet("title"),TopCount=3};q.AddAttributeValue("title","Selected");q.AddOrder("title",OrderType.Descending);return q;}
static QueryExpression Expression(){var q=new QueryExpression("widget"){ColumnSet=new ColumnSet("title"),TopCount=3};q.Criteria.AddCondition("title",ConditionOperator.Equal,"Selected");q.AddOrder("title",OrderType.Descending);return q;}
public static void Main(){var cases=new List<string>();var originalBy=By();Check(originalBy.PageInfo==null,"Installed SDK QueryByAttribute constructor no longer has null paging");RoundTrip(originalBy);cases.Add("QueryByAttribute-constructor");var originalExpression=Expression();Check(originalExpression.PageInfo!=null,"Installed SDK QueryExpression constructor paging absent");RoundTrip(originalExpression);cases.Add("QueryExpression-constructor");
foreach(var kind in new[]{"QueryByAttribute","QueryExpression"}){var omitted=(QueryBase)Decode("{\\"$type\\":\\""+kind+"\\",\\"entityName\\":\\"widget\\"}");var absentPage=kind=="QueryByAttribute"?((QueryByAttribute)omitted).PageInfo:((QueryExpression)omitted).PageInfo;Page(absentPage,kind=="QueryByAttribute"?new QueryByAttribute("widget").PageInfo:new QueryExpression("widget").PageInfo);cases.Add(kind+"-omitted");var explicitNull=(QueryBase)Decode("{\\"$type\\":\\""+kind+"\\",\\"entityName\\":\\"widget\\",\\"pageInfo\\":null}");Page(kind=="QueryByAttribute"?((QueryByAttribute)explicitNull).PageInfo:((QueryExpression)explicitNull).PageInfo,null);cases.Add(kind+"-wire-null");}
foreach(var populated in new[]{false,true}){var page=populated?new PagingInfo{Count=2,PageNumber=4,PagingCookie="<cookie page='3' />"}:null;var by=By();by.PageInfo=page;RoundTrip(by);cases.Add("QueryByAttribute-original-"+(populated?"populated":"null"));var expression=Expression();expression.PageInfo=page;RoundTrip(expression);cases.Add("QueryExpression-original-"+(populated?"populated":"null"));}
var counted=By();counted.PageInfo=new PagingInfo{ReturnTotalRecordCount=true};RoundTrip(counted);cases.Add("QueryByAttribute-count-flag-retained");var countedExpression=Expression();countedExpression.PageInfo.ReturnTotalRecordCount=true;RoundTrip(countedExpression);cases.Add("QueryExpression-count-flag-retained");Console.WriteLine(Json.Serialize(cases));}
}}`,
    );
    const host = fileURLToPath(new URL('../lib/plugin-clr-host.cs', import.meta.url));
    // An executable over two sources with /main, which compileClr (one library source) does not build.
    const csc = path.join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    await promisify(execFile)(
      csc,
      [
        '/nologo',
        '/target:exe',
        '/main:Invented.PagingProbe',
        '/out:' + exe,
        '/reference:' + sdk,
        '/reference:System.Web.Extensions.dll',
        '/reference:System.Runtime.Serialization.dll',
        '/reference:System.ServiceModel.dll',
        host,
        source,
      ],
      { encoding: 'utf8', windowsHide: true, signal: t.signal },
    );
    // A non-zero exit rejects with the probe's stdout and stderr; the test's own deadline bounds a hung probe.
    const result = await promisify(execFile)(exe, [], { encoding: 'utf8', windowsHide: true, signal: t.signal });
    assert.deepEqual(JSON.parse(result.stdout), [
      'QueryByAttribute-constructor',
      'QueryExpression-constructor',
      'QueryByAttribute-omitted',
      'QueryByAttribute-wire-null',
      'QueryExpression-omitted',
      'QueryExpression-wire-null',
      'QueryByAttribute-original-null',
      'QueryExpression-original-null',
      'QueryByAttribute-original-populated',
      'QueryExpression-original-populated',
      'QueryByAttribute-count-flag-retained',
      'QueryExpression-count-flag-retained',
    ]);
  },
);
