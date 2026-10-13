import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

/** Flush a private write-ahead journal before a native mutation. Replacement
 * never truncates the previous recoverable journal; retries affect disk only. */
export async function savePrivateJson(file,value,{exclusive=false}={}) {
  const target=path.resolve(file),contents=JSON.stringify(value,null,2)+'\n';
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=exclusive?target:`${target}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle=await fs.open(temporary,'wx',0o600);
    await handle.writeFile(contents,'utf8');await handle.sync();await handle.close();handle=null;
    if(exclusive)return;
    for(let attempt=0;;attempt++) {
      try{await fs.rename(temporary,target);return;}
      catch(error){if(!['EPERM','EBUSY','EACCES'].includes(error.code)||attempt>=9)throw error;await delay(Math.min(500,25*2**attempt));}
    }
  } catch(error) {
    await handle?.close().catch(()=>{});
    if(!exclusive)await fs.unlink(temporary).catch(()=>{});
    throw error;
  }
}
