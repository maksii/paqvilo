import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSimulator} from '../server.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

test('portal round trips preserve five date behaviors and per-request formatted timezone rules',async t=>{
  const source=await fs.mkdtemp(join(tmpdir(),'invented-date-behaviors-'));ownedFixture(t).remove(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(join(source,'website.yml'),'adx_name: Invented date site\nadx_websiteid: site\n');
  await fs.writeFile(join(source,'sitesetting.yml'),'- adx_name: Webapi/event/enabled\n  adx_value: true\n- adx_name: Webapi/event/fields\n  adx_value: local,localdate,independent,independentdate,calendar\n');
  const fields=Object.fromEntries([['local','UserLocal','DateAndTime'],['localdate',1,'DateOnly'],['independent','TimeZoneIndependent','DateAndTime'],['independentdate',3,'DateOnly'],['calendar',2,'DateOnly']].map(([key,behavior,format])=>[key,{type:'datetime',behavior,format}]));
  const rule={effectivedatetime:'1753-01-01T00:00:00Z',bias:-240,standardbias:0,daylightbias:-60,
    daylightyear:0,daylightmonth:3,daylightday:5,daylightdayofweek:0,daylighthour:3,daylightminute:0,daylightsecond:0,
    standardyear:0,standardmonth:10,standardday:5,standarddayofweek:0,standardhour:4,standardminute:0,standardsecond:0};
  const app=await createSimulator({sourceDir:source,port:0,watch:false,observed:{webApiDateParsing:'month-first',evidence:'Invented portal culture regression'},initial:{settings:{permissionMode:'permissive',formattedValueTimeZone:{evidence:'Invented zone rules',rules:[rule]}},mappings:{event:{entitySet:'events',idColumn:'eventid',fields}},tables:{event:[]}}});ownedFixture(t).add(()=>app.close());
  const headers={'content-type':'application/json',__RequestVerificationToken:app.csrf};
  const body={local:'7/7/2025 10:30',localdate:'2025-07-06T22:30:00Z',independent:'7/7/2025 10:30',independentdate:'2025-07-06T22:30:00Z',calendar:'2025-7-7'};
  const created=await fetch(app.url+'/_api/events',{method:'POST',headers,body:JSON.stringify(body)});assert.equal(created.status,204,await created.text());
  const url=app.url+`/_api/events(${created.headers.get('entityid')})`,read=await fetch(url).then(r=>r.json());
  assert.equal(read.local,'2025-07-07T10:30:00Z');assert.equal(read.independent,'2025-07-07T10:30:00Z');assert.equal(read.localdate,read.independentdate);assert.equal(read.calendar,'2025-07-07');
  const annotation='@OData.Community.Display.V1.FormattedValue';
  for(const [field,expected] of [['local','7/7/2025 3:30 PM'],['localdate','7/7/2025'],['independent','7/7/2025 10:30 AM'],['independentdate','7/6/2025'],['calendar','7/7/2025']])assert.equal(read[field+annotation],expected,field);
  const patched=await fetch(url,{method:'PATCH',headers,body:JSON.stringify({local:'1/7/2025 10:30:45.9999999'})});assert.equal(patched.status,204,await patched.text());
  const winter=await fetch(url).then(r=>r.json());assert.equal(winter.local,'2025-01-07T10:30:45Z');assert.equal(winter['local'+annotation],'1/7/2025 2:30 PM');
});

test('month-first range errors preserve submitted text and the configured native minimum-date message',async t=>{
  const source=await fs.mkdtemp(join(tmpdir(),'invented-date-boundaries-'));ownedFixture(t).remove(()=>fs.rm(source,{recursive:true,force:true}));
  await fs.writeFile(join(source,'website.yml'),'adx_name: Invented date site\nadx_websiteid: site\n');
  await fs.writeFile(join(source,'sitesetting.yml'),'- adx_name: Webapi/event/enabled\n  adx_value: true\n- adx_name: Webapi/event/fields\n  adx_value: date\n- adx_name: Webapi/error/innererror\n  adx_value: true\n');
  for (const invalidDate of ['invalid-format','crm-minimum']) {
    const app=await createSimulator({sourceDir:source,port:0,watch:false,observed:{webApiDateParsing:'month-first',webApiInvalidDate:invalidDate,evidence:'Synthetic date range regression'},initial:{settings:{permissionMode:'permissive'},mappings:{event:{entitySet:'events',idColumn:'eventid',fields:{date:{type:'datetime',behavior:3,format:'date'}}}},tables:{event:[]}}});ownedFixture(t).add(()=>app.close());
    const headers={'content-type':'application/json',__RequestVerificationToken:app.csrf};
    const good=await fetch(app.url+'/_api/events',{method:'POST',headers,body:JSON.stringify({date:'2/7/2025'})});assert.equal(good.status,204,await good.text());
    const rowUrl=app.url+`/_api/events(${good.headers.get('entityid')})`,before=await fetch(rowUrl).then(r=>r.json());
    assert.equal(before.date,'2025-02-07T00:00:00Z');assert.equal(before['date@OData.Community.Display.V1.FormattedValue'],'2/7/2025');
    for (const value of ['2/7/0000','2/7/0001','2/7/1752']) for (const method of ['POST','PATCH']) {
      const response=await fetch(method==='POST'?app.url+'/_api/events':rowUrl,{method,headers,body:JSON.stringify({date:value})});
      assert.equal(response.status,400);const body=await response.json(),message=body.error.innererror.message;
      assert.equal(body.error.innererror.code,'0x80040239');
      if(invalidDate==='invalid-format') assert.ok(message.includes(value),message);
      else {
        assert.match(message,/less than minumum value supported by CrmDateTime/);
        assert.ok(message.includes(value==='2/7/0000'?'Actual value: 01/01/0001':'Actual value: 02/07/'+value.slice(-4)));
      }
      assert.deepEqual(await fetch(rowUrl).then(r=>r.json()),before);
    }
    const records=await fetch(app.url+'/_api/events?$select=date').then(r=>r.json());assert.equal(records.value.length,1);
  }
});
