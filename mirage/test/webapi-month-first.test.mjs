import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSimulator} from '../server.mjs';
import {portalMonthFirstDate,parseDateValue} from '../lib/dataverse-values.mjs';
import {observedConfig} from '../lib/project-config.mjs';

test('month-first conversion validates calendar and clock without relaxing the ISO parser',()=>{
  assert.equal(portalMonthFirstDate('2/7/2025'),'2025-02-07');
  assert.equal(portalMonthFirstDate('10/14/2026'),'2026-10-14');
  assert.equal(portalMonthFirstDate('2/7/2025 10:30'),'2025-02-07T10:30:00Z');
  assert.equal(portalMonthFirstDate('2/7/2025 12:30 AM'),'2025-02-07T00:30:00Z');
  for(const value of ['14/10/2026','2/29/2025','2/7/2025 24:00','2/7/2025 10:60','2/7/2025 0:00 PM','2025-02-07'])assert.equal(portalMonthFirstDate(value),null,value);
  assert.equal(parseDateValue('2/7/2025'),null);
  assert.throws(()=>observedConfig({webApiDateParsing:'month-first'}),/evidence/);
});

for(const enabled of [false,true])test(`portal Web API conversion is evidenced and opt-in (${enabled})`,async t=>{
  const root=await fs.mkdtemp(join(tmpdir(),'mirage-month-first-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(join(root,'website.yml'),'adx_name: Synthetic date site\nadx_websiteid: site\n');
  await fs.writeFile(join(root,'sitesetting.yml'),'- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: date,instant,name\n');
  const app=await createSimulator({sourceDir:root,watch:false,observed:enabled?{webApiDateParsing:'month-first',evidence:'Synthetic opt-in boundary regression'}:{},initial:{settings:{permissionMode:'permissive'},mappings:{item:{entitySet:'items',idColumn:'itemid',fields:{date:{type:'datetime',behavior:'dateonly'},instant:{type:'datetime'},name:{type:'string'}}}},tables:{item:[]}}});t.after(()=>app.close());
  const csrf=(await fetch(app.url+'/__sim/api/state?summary=1').then(r=>r.json())).csrf;
  const headers={'content-type':'application/json',__RequestVerificationToken:csrf};
  for(const [value,expected]of [['2/7/2025','2025-02-07'],['10/14/2026','2026-10-14'],['2025-02-07','2025-02-07']]){
    const response=await fetch(app.url+'/_api/items',{method:'POST',headers,body:JSON.stringify({date:value,name:value})});
    assert.equal(response.status,enabled||value.includes('-')?204:400,await response.text());
    if(response.ok){const id=response.headers.get('entityid');const read=await fetch(app.url+`/_api/items(${id})`).then(r=>r.json());assert.equal(read.date,expected);assert.equal(read.name,value);
      if(enabled){const patch=await fetch(app.url+`/_api/items(${id})`,{method:'PATCH',headers,body:JSON.stringify({instant:'2/7/2025 10:30'})});assert.equal(patch.status,204,await patch.text());assert.match((await fetch(app.url+`/_api/items(${id})`).then(r=>r.json())).instant,/^2025-02-07T10:30:00/);}}
  }
  const before=app.store.snapshot();const invalid=await fetch(app.url+'/_api/items',{method:'POST',headers,body:JSON.stringify({date:'14/10/2026'})});assert.equal(invalid.status,400);assert.deepEqual(app.store.snapshot(),before);
});
