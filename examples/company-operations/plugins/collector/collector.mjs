import http from 'node:http';
import{createPublicKey,verify}from'node:crypto';
import{guid,claimsValid,validateEnvelope}from'./protocol.mjs';
const required=(name)=>{const v=process.env[name];if(!v)throw new Error(`Missing ${name}`);return v;};
const tenant=required('CO_COLLECTOR_TENANT');const audience=required('CO_COLLECTOR_AUDIENCE');const storage=new URL(required('CO_COLLECTOR_BLOB_URL'));const container=required('CO_COLLECTOR_CONTAINER');
if(!guid.test(tenant)||storage.protocol!=='https:'||!storage.hostname.endsWith('.blob.core.windows.net')||!/^[a-z0-9-]{3,63}$/.test(container))throw new Error('Invalid collector configuration.');
const issuer=`https://login.microsoftonline.com/${tenant}/v2.0`;let keys;let keyExpiry=0;
async function authorize(header){
 const m=/^Bearer ([A-Za-z0-9_.-]+)$/.exec(header??'');if(!m)throw new Error('AuthenticationRequired');const parts=m[1].split('.');if(parts.length!==3)throw new Error('InvalidToken');const head=JSON.parse(Buffer.from(parts[0],'base64url'));const claims=JSON.parse(Buffer.from(parts[1],'base64url'));const now=Date.now()/1000;
 if(head.alg!=='RS256'||typeof head.kid!=='string'||!claimsValid(claims,{issuer,audience,tenant,now}))throw new Error('InvalidToken');
 if(!keys||Date.now()>keyExpiry){const r=await fetch(`https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw new Error('KeyDiscoveryUnavailable');keys=(await r.json()).keys;keyExpiry=Date.now()+3600000;}
 const jwk=keys.find(k=>k.kid===head.kid&&k.kty==='RSA');if(!jwk||!verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw new Error('InvalidToken');
 return claims.oid;
}
export async function identityToken(resource){const endpoint=new URL(required('IDENTITY_ENDPOINT'));endpoint.searchParams.set('resource',resource);endpoint.searchParams.set('api-version','2019-08-01');const r=await fetch(endpoint,{headers:{'X-IDENTITY-HEADER':required('IDENTITY_HEADER')},signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('ManagedIdentityUnavailable');return(await r.json()).access_token;}
export async function blobRequest(path,options={}){return fetch(new URL(`${container}/${path}`,storage),{...options,headers:{'x-ms-version':'2023-11-03','x-ms-date':new Date().toUTCString(),Authorization:`Bearer ${await identityToken('https://storage.azure.com/')}`,...options.headers},signal:AbortSignal.timeout(3000)});}
function reply(response,status,value){response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(value));}
const server=http.createServer(async(request,response)=>{
 if(request.method!=='POST'||request.url!=='/capture'){reply(response,404,{error:'NotFound'});return;}
 try{const writer=await authorize(request.headers.authorization);let bytes=0;const chunks=[];for await(const chunk of request){bytes+=chunk.length;if(bytes>2300000)throw new Error('PayloadTooLarge');chunks.push(chunk);}const envelope=JSON.parse(Buffer.concat(chunks));const {hash}=validateEnvelope(envelope);const body=JSON.stringify({...envelope,collectorTime:new Date().toISOString(),collectorWriterObjectId:writer});const path=`events/${envelope.operationId}/${envelope.eventKey}.json`;const persisted=await blobRequest(path,{method:'PUT',headers:{'Content-Type':'application/json','x-ms-blob-type':'BlockBlob','If-None-Match':'*'},body});if([409,412].includes(persisted.status)){const old=await blobRequest(path);if(!old.ok||(await old.json()).payloadHash!==hash){reply(response,409,{error:'EventConflict'});return;}}else if(!persisted.ok)throw new Error('StorageUnavailable');reply(response,202,{accepted:true,durable:true,receiptId:`${envelope.operationId}/${envelope.eventKey}`,payloadHash:hash});
 }catch(error){const category=['AuthenticationRequired','InvalidToken','InvalidEnvelope','InvalidCapture','PayloadTooLarge','HashMismatch'].includes(error.message)?error.message:'CollectorUnavailable';reply(response,['AuthenticationRequired','InvalidToken'].includes(category)?401:category==='CollectorUnavailable'?503:400,{error:category});}
});
if(process.argv[1]&&new URL(import.meta.url).pathname.toLowerCase().endsWith(process.argv[1].replace(/\\/g,'/').toLowerCase()))server.listen(Number(process.env.PORT??8080),'0.0.0.0');
export{server};
