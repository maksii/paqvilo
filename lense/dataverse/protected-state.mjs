import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {protectSecret} from './connection.mjs';

const limit=256*1024;
function target(file,purpose) {
 if(typeof file!=='string'||!path.resolve(file).split(path.sep).includes('.paqvilo'))throw new Error('Protected state must use an ignored .paqvilo path.');
 if(typeof purpose!=='string'||!/^[a-z\d][a-z\d_.-]{0,127}$/i.test(purpose))throw new Error('Protected state requires a bounded purpose label.');
 return path.resolve(file);
}
function plaintext(value,purpose) {
 const seen=new Set();
 const visit=(item,depth)=>{
  if(depth>32)throw new Error('Protected state exceeds its JSON depth bound.');
  if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return;
  if(typeof item!=='object'||seen.has(item)||!Array.isArray(item)&&![Object.prototype,null].includes(Object.getPrototypeOf(item)))throw new Error('Protected state must contain plain acyclic JSON values.');
  seen.add(item);for(const child of Object.values(item))visit(child,depth+1);seen.delete(item);
 };
 visit(value,0);const text=JSON.stringify({kind:'PaqviloProtectedState',schemaVersion:1,purpose,value});
 if(Buffer.byteLength(text)>limit)throw new Error('Protected state exceeds its plaintext size bound.');
 return text;
}
/** Encrypt caller-owned JSON with the Windows user's DPAPI key. No plaintext
 * file or fallback is created. Save before an external operation consumes the
 * generated credential; exclusive mode prevents accidental credential rotation. */
export async function saveProtectedState(file,value,{purpose,exclusive=true}={}) {
 file=target(file,purpose);if(typeof exclusive!=='boolean')throw new Error('Protected state exclusive must be Boolean.');
 const text=plaintext(value,purpose),protectedValue=await protectSecret(text),createdAt=new Date().toISOString();
 const metadata={kind:'PaqviloProtectedState',schemaVersion:1,purpose,protection:'Windows DPAPI CurrentUser',createdAt};
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temporary=`${file}.${randomUUID()}.tmp`;let handle;
 try {
  handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(JSON.stringify({...metadata,protectedValue})+'\n');await handle.sync();await handle.close();handle=null;
  if(exclusive)await fs.link(temporary,file);
  else for(let attempt=0;;attempt++){try{await fs.rename(temporary,file);break;}catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=9)throw error;await delay(Math.min(500,25*2**attempt));}}
 }finally{await handle?.close();await fs.unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return {...metadata,file};
}
/** Decrypt into memory only. Purpose is checked inside the authenticated DPAPI
 * payload as well as public metadata; never log the returned caller-owned value. */
export async function loadProtectedState(file,{purpose}={}) {
 file=target(file,purpose);const handle=await fs.open(file,'r');let record;
 try {
  const stat=await handle.stat();if(!stat.isFile()||stat.size>limit*3)throw new Error('Protected state must be a bounded regular file.');
  const chunks=[];let size=0;
  for(;;){const buffer=Buffer.alloc(Math.min(65536,limit*3-size+1)),{bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>limit*3)throw new Error('Protected state changed beyond its size bound.');chunks.push(buffer.subarray(0,bytesRead));}
  const bytes=Buffer.concat(chunks,size);
  try{record=JSON.parse(bytes.toString('utf8'));}catch{throw new Error('Protected state envelope is invalid.');}
 }finally{await handle.close();}
 if(record.kind!=='PaqviloProtectedState'||record.schemaVersion!==1||record.purpose!==purpose||record.protection!=='Windows DPAPI CurrentUser'||typeof record.protectedValue!=='string'||!record.protectedValue)throw new Error('Protected state purpose or envelope does not match.');
 let payload;try{payload=JSON.parse(await protectSecret(record.protectedValue,true));}catch{throw new Error('Protected state could not be decrypted; no plaintext fallback.');}
 if(payload.kind!=='PaqviloProtectedState'||payload.schemaVersion!==1||payload.purpose!==purpose||!Object.hasOwn(payload,'value'))throw new Error('Protected state inner purpose does not match.');
 plaintext(payload.value,purpose);return payload.value;
}
