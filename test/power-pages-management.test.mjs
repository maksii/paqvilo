import test from 'node:test';
import assert from 'node:assert/strict';
import{readPowerPagesSites,readPowerPagesSite,setPowerPagesSiteVisibility}from'paqvilo/dataverse';
const id='10000000-0000-4000-8000-000000000001',record='20000000-0000-4000-8000-000000000001';
const row={id,websiteRecordId:record,websiteUrl:'https://demo.example.invalid',siteVisibility:'private',name:'Demo',type:'Trial',status:'OperationComplete',clientSecret:'WITHHELD',settings:{token:'WITHHELD'}};
test('Power Pages management uses explicit shell-free commands and projects only site metadata',async()=>{
 const calls=[],options={environment:'https://tenant.example.invalid',executable:'C:/CLI/pac.exe',run:async(program,args,settings)=>{calls.push({program,args,settings});return{stdout:'CLI banner\n'+JSON.stringify(args.includes('get-websites')?{value:[row]}:row),stderr:'WITHHELD'};}};
 const sites=await readPowerPagesSites(options);assert.equal(sites[0].websiteRecordId,record);assert.equal(sites[0].clientSecret,undefined);assert.equal(sites[0].settings,undefined);
 assert.equal((await readPowerPagesSite({...options,id})).id,id);
 const changed=await setPowerPagesSiteVisibility({...options,id,visibility:'public'});assert.equal(changed.commandCompleted,true);assert.equal(changed.readbackVerified,false);
 assert.deepEqual(calls[2].args,['power-pages','update-site-visibility','--environment','https://tenant.example.invalid','--id',id,'--site-visibility','public']);
 assert.ok(calls.every(call=>call.settings.shell===false&&call.settings.windowsHide===true&&call.settings.timeout<=120000));
});
test('Power Pages management rejects malformed targets and withholds transport/response output',async()=>{
 let called=false;const options={environment:'https://tenant.example.invalid',run:async()=>{called=true;return{stdout:JSON.stringify(row)};}};
 for(const value of['http://tenant.example.invalid','https://tenant.example.invalid/?token=x','https://user:pass@tenant.example.invalid','https://tenant.example.invalid/path'])await assert.rejects(readPowerPagesSites({...options,environment:value}),/explicit environment/);
 await assert.rejects(readPowerPagesSite({...options,id:id+' & command'}),/explicit management/);await assert.rejects(setPowerPagesSiteVisibility({...options,id,visibility:'public & command'}),/private\/public/);await assert.rejects(readPowerPagesSites({...options,executable:'pac.cmd'}),/without a command shell/);assert.equal(called,false);
 await assert.rejects(readPowerPagesSites({...options,run:async()=>{throw new Error('WITHHELD_SECRET');}}),error=>error.code==='POWER_PAGES_MANAGEMENT_FAILED'&&!error.message.includes('WITHHELD_SECRET'));
 await assert.rejects(readPowerPagesSites({...options,run:async()=>({exitCode:1,stderr:'HTTP 400 WITHHELD_SECRET'})}),error=>error.status===400&&error.exitCode===1&&!error.message.includes('WITHHELD_SECRET'));
 await assert.rejects(readPowerPagesSite({...options,id,run:async()=>({stdout:JSON.stringify({...row,id:record})})}),/different site/);
 await assert.rejects(readPowerPagesSites({...options,run:async()=>({stdout:'WITHHELD_SECRET'})}),error=>!error.message.includes('WITHHELD_SECRET'));
 await assert.rejects(readPowerPagesSites({...options,run:async()=>({stdout:JSON.stringify({value:[row,row]})})}),/repeats/);
 await assert.rejects(readPowerPagesSites({...options,run:async()=>({stdout:JSON.stringify({value:[{...row,name:{secret:'WITHHELD_SECRET'}}]})})}),/bounded scalar/);
});
