import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {saveProtectedState,loadProtectedState} from '../lense/dataverse/index.mjs';
test('protected JSON validates private location, bounded purpose and JSON without revealing values',async()=>{
 await assert.rejects(saveProtectedState(path.join(os.tmpdir(),'outside.json'),{password:'sample'},{purpose:'fixture'}),/ignored/);
 const file=path.join(os.tmpdir(),'.paqvilo','fixture.json');
 await assert.rejects(saveProtectedState(file,{password:'sample'},{purpose:'space invalid'}),/purpose/);
 await assert.rejects(saveProtectedState(file,{value:undefined},{purpose:'fixture'}),/plain acyclic JSON/);
 await assert.rejects(saveProtectedState(file,{value:Infinity},{purpose:'fixture'}),/plain acyclic JSON/);
 await assert.rejects(saveProtectedState(file,{value:'x'.repeat(300000)},{purpose:'fixture'}),/size bound/);
});
test('protected state has encrypted durable roundtrip, purpose binding and exclusive writes or explicit platform refusal',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'protected-json-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'.paqvilo','identity.json'),value={contacts:[{id:'fixture',password:'InventedCredentialMustNotAppearInFile'}]},purpose='native-test-identity';
 if(process.platform!=='win32'){await assert.rejects(saveProtectedState(file,value,{purpose}),/Windows DPAPI/);await assert.rejects(fs.access(file),{code:'ENOENT'});return;}
 const metadata=await saveProtectedState(file,value,{purpose});assert.equal(metadata.protection,'Windows DPAPI CurrentUser');assert.equal(Object.hasOwn(metadata,'protectedValue'),false);
 const bytes=await fs.readFile(file,'utf8');assert.doesNotMatch(bytes,/InventedCredential|contacts|password/);assert.deepEqual(await loadProtectedState(file,{purpose}),value);
 await assert.rejects(saveProtectedState(file,{replacement:true},{purpose}),{code:'EEXIST'});assert.equal(await fs.readFile(file,'utf8'),bytes);
 await assert.rejects(loadProtectedState(file,{purpose:'wrong-purpose'}),/purpose/);
 const envelope=JSON.parse(bytes);envelope.purpose='wrong-purpose';await fs.writeFile(file,JSON.stringify(envelope));await assert.rejects(loadProtectedState(file,{purpose:'wrong-purpose'}),/inner purpose/);
 await saveProtectedState(file,{replacement:true},{purpose,exclusive:false});assert.deepEqual(await loadProtectedState(file,{purpose}),{replacement:true});
});
