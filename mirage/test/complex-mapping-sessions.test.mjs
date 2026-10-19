import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { createPortalSession, connectRuntime } from '../testing.mjs';

test('membership visitors and persona reports use the explicit contact key with nonstandard entity-set and lookup mappings',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'complex-session-mappings-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  for(const [file,body]of Object.entries({
    'website.yml':'adx_websiteid: site\nadx_name: Mapping fixture',
    'webrole.yml':'- adx_webroleid: reader\n  adx_name: Reader',
    'sitesetting.yml':'- adx_sitesettingid: enabled\n  adx_name: Webapi/sample_ledger/enabled\n  adx_value: "true"\n- adx_sitesettingid: fields\n  adx_name: Webapi/sample_ledger/fields\n  adx_value: entry_key,title,owner_ref,sequence',
  }))await fs.writeFile(path.join(directory,file),body);
  const initial={mappings:{contact:{entitySet:'local_people',idColumn:'visitor_key',nameColumn:'fullname'},sample_ledger:{entitySet:'unusual_ledgers',idColumn:'entry_key',nameColumn:'title',relationships:{owner_person:{entity:'contact',from:'owner_ref',to:'visitor_key',many:false}}}},tables:{contact:[{visitor_key:'alpha',fullname:'Alpha'},{visitor_key:'beta',fullname:'Beta'}],sample_ledger:[{entry_key:'one',title:'Alpha entry',sequence:1,owner_ref:{id:'alpha',logical_name:'contact'}},{entry_key:'two',title:'Beta entry',sequence:2,owner_ref:{id:'beta',logical_name:'contact'}}]},permissions:[{id:'own',entity:'sample_ledger',scope:'contact',field:'owner_ref',roles:['Reader'],operations:['read']}],settings:{permissionMode:'enforce'},simulator:{mode:'local',pageMode:'local',permissionSource:'configured',identity:{roles:[]},contactRoles:[{contactId:'alpha',roleId:'reader'},{contactId:'beta',roleId:'reader'}],endpoints:[]}};
  const app=await createSimulator({sourceDir:directory,stateFile:path.join(directory,'state.json'),initial,port:0,watch:false});t.after(()=>app.close());
  const alpha=await createPortalSession({origin:app.url,contactId:'alpha'}),beta=await createPortalSession({origin:app.url,contactId:'beta'});t.after(()=>{alpha.close();beta.close();});
  assert.equal((await alpha.session()).contactId,'alpha');
  assert.equal((await beta.session()).contactId,'beta');
  const route='/_api/unusual_ledgers?$select=entry_key,title&$orderby=sequence asc&$count=true';
  assert.deepEqual((await alpha.json(route)).body.value.map(row=>row.entry_key),['one']);
  assert.deepEqual((await beta.json(route)).body.value.map(row=>row.entry_key),['two']);
  const runtime=await connectRuntime({origin:app.url}),report=await runtime.personas();
  assert.deepEqual(report.contacts.map(contact=>contact.contactId).sort(),['alpha','beta']);
  assert.ok(report.contacts.every(contact=>contact.active&&contact.roles.includes('Reader')));
  await alpha.signOut();
  assert.equal((await alpha.json(route)).status,403);
  assert.equal((await beta.json(route)).status,200,'another visitor stays signed in');
  assert.deepEqual(app.store.state.simulator.identity,initial.simulator.identity);
});
