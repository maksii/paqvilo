import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {syncBuiltinESMExports} from 'node:module';
import {saveProtectedState,loadProtectedState} from '../lense/dataverse/index.mjs';
import {protectSecret} from '../lense/dataverse/connection.mjs';
test('protected JSON validates private location, bounded purpose and JSON without revealing values',async()=>{
 await assert.rejects(saveProtectedState(path.join(os.tmpdir(),'outside.json'),{password:'sample'},{purpose:'fixture'}),/ignored/);
 const file=path.join(os.tmpdir(),'.paqvilo','fixture.json');
 await assert.rejects(saveProtectedState(file,{password:'sample'},{purpose:'space invalid'}),/purpose/);
 await assert.rejects(saveProtectedState(file,{value:undefined},{purpose:'fixture'}),/plain acyclic JSON/);
 await assert.rejects(saveProtectedState(file,{value:Infinity},{purpose:'fixture'}),/plain acyclic JSON/);
 await assert.rejects(saveProtectedState(file,{value:'x'.repeat(300000)},{purpose:'fixture'}),/size bound/);
});
test('protected state has encrypted durable roundtrip, purpose binding and exclusive writes or explicit platform refusal',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'protected-json-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'.paqvilo','identity.json'),value={contacts:[{id:'fixture',password:'InventedCredentialMustNotAppearInFile',unicode:'Україна 漢字 🔐',multiline:'line one\nline two'}]},purpose='native-test-identity';
 if(process.platform!=='win32'){await assert.rejects(saveProtectedState(file,value,{purpose}),/Windows DPAPI/);await assert.rejects(fs.access(file),{code:'ENOENT'});return;}
 const metadata=await saveProtectedState(file,value,{purpose});assert.equal(metadata.protection,'Windows DPAPI CurrentUser');assert.equal(Object.hasOwn(metadata,'protectedValue'),false);
 const bytes=await fs.readFile(file,'utf8');assert.doesNotMatch(bytes,/InventedCredential|contacts|password/);assert.deepEqual(await loadProtectedState(file,{purpose}),value);
 await assert.rejects(saveProtectedState(file,{replacement:true},{purpose}),{code:'EEXIST'});assert.equal(await fs.readFile(file,'utf8'),bytes);
 await assert.rejects(loadProtectedState(file,{purpose:'wrong-purpose'}),/purpose/);
 const envelope=JSON.parse(bytes);envelope.purpose='wrong-purpose';await fs.writeFile(file,JSON.stringify(envelope));await assert.rejects(loadProtectedState(file,{purpose:'wrong-purpose'}),/inner purpose/);
 await saveProtectedState(file,{replacement:true},{purpose,exclusive:false});assert.deepEqual(await loadProtectedState(file,{purpose}),{replacement:true});
 const encrypted=await protectSecret('Invented malformed ciphertext fixture');
 const damaged=Buffer.from(encrypted,'base64');damaged[damaged.length-1]^=1;
 for(const ciphertext of ['not-base64',Buffer.from('not a DPAPI envelope').toString('base64'),damaged.toString('base64')])await assert.rejects(protectSecret(ciphertext,true),{message:'Windows credential encryption/decryption failed; no plaintext fallback.'});
});

test('DPAPI tolerates cold startup past 15 seconds, remains bounded, and withholds failed output',async t=>{
 const platform=Object.getOwnPropertyDescriptor(process,'platform');Object.defineProperty(process,'platform',{value:'win32'});t.after(()=>Object.defineProperty(process,'platform',platform));
 const children=[];const mock=t.mock.method(childProcess,'spawn',(executable,args,options)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.input='';
  child.stdin=new Writable({write(chunk,encoding,done){child.input+=chunk.toString();done();}});child.killed=false;child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('close',null));return true;};
  assert.equal(executable,'powershell.exe');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.deepEqual(options.stdio,['pipe','pipe','pipe']);assert.ok(!args.join(' ').includes('Invented private input'));
  children.push(child);return child;
 });syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});t.mock.timers.enable({apis:['setTimeout']});
 const delayed=protectSecret('Invented private input');t.mock.timers.tick(15_001);assert.equal(children[0].killed,false,'Cold process is still allowed to finish');assert.equal(children[0].input,'Invented private input');children[0].stdout.write('AQID');children[0].emit('close',0);assert.equal(await delayed,'AQID');
 const timeout=assert.rejects(protectSecret('Invented private input'),{message:'Windows credential encryption/decryption failed; no plaintext fallback.'});t.mock.timers.tick(60_000);await timeout;assert.equal(children[1].killed,true);
 for(const [code,stdout,stderr]of [[1,'Invented secret output','Invented error detail'],[0,'',''],[0,'Invented invalid ciphertext',''],[0,'AQID','Invented error detail']]){const failed=assert.rejects(protectSecret('Invented private input'),{message:'Windows credential encryption/decryption failed; no plaintext fallback.'});const child=children.at(-1);child.stdout.write(stdout);child.stderr.write(stderr);child.emit('close',code);await failed;}
});
