import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {restrictToCurrentUser} from '../lib/flow-vault.mjs';

test('a private vault ACL removes explicit process-default grants as well as inheritance', {skip:process.platform!=='win32'}, async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vault-explicit-acl-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'empty key fixture.txt');
  await fs.writeFile(file,'');
  const tool=path.join(process.env.SystemRoot??'C:\\Windows','System32','icacls.exe');
  const grant=spawnSync(tool,[file,'/grant:r','*S-1-5-18:F','*S-1-5-32-544:F'],{encoding:'utf8',windowsHide:true});
  assert.equal(grant.status,0,grant.stderr);
  const restricted = restrictToCurrentUser(file);
  assert.match(restricted,/\\[^\\:]+:\(F\)$/,'the helper retains its current-user ACL entry result');
  const shown=spawnSync(tool,[file],{encoding:'utf8',windowsHide:true});
  assert.equal(shown.status,0,shown.stderr);
  const entries=shown.stdout.split(/\r?\n/).map(line=>line.replace(file,'').trim()).filter(line=>/:\(.*\)$/.test(line));
  assert.equal(entries.length,1,shown.stdout);
  assert.match(entries[0],/\\[^\\:]+:\(F\)$/);
  assert.equal((await fs.stat(file)).size,0,'no key bytes are needed to establish the final private ACL');
});
