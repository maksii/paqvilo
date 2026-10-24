import {randomUUID} from 'node:crypto';
import {runtimeOrigin} from './runtime.mjs';

const failure=(message,code,status)=>Object.assign(new Error(message),{code,...(status?{status}:{})});
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const publicSession=value=>Object.fromEntries(Object.entries(value??{}).filter(([key])=>!['cookie','csrf'].includes(key)));
function portalRoute(origin,route) {
 // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
 if(typeof route!=='string'||!route.startsWith('/')||route.startsWith('//')||/[\\\u0000-\u001f\u007f]/.test(route))throw failure('Portal request requires a site-relative path.','InvalidPortalRoute');
 const url=new URL(route,origin);let pathname;
 try{pathname=decodeURIComponent(url.pathname);}catch{throw failure('Portal path has invalid encoding.','InvalidPortalRoute');}
 // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
 if(url.origin!==origin||url.hash||/[\\\u0000-\u001f\u007f]/.test(pathname)||/^\/(?:_sim|__sim|_setup)(?:\/|$)/i.test(pathname))throw failure('Portal clients cannot request administration or external routes.','InvalidPortalRoute');
 return url.href;
}

/** A cookie-isolated HTTP visitor for an existing loopback Mirage runtime.
 * Membership roles remain source-derived unless explicitly overridden. The
 * private cookie is never returned in session descriptions or matrix reports.
 * This client never starts a runtime, changes the configured persona, or retries
 * a request whose mutation may already have committed. */
export async function createPortalSession({origin,contactId,roles,id=randomUUID(),fetchImpl=globalThis.fetch,timeoutMs=30000,signal}={}) {
 origin=runtimeOrigin(origin);
 if(typeof id!=='string'||!id||id.length>160||typeof fetchImpl!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw failure('Portal session requires a bounded identity label and timeout.','InvalidPortalSession');
 const cookies=new Map();let csrf='',active=0,changing=false,closed=false;
 const cookieHeader=url=>{const now=Date.now(),pathname=new URL(url).pathname;for(const [key,item]of cookies)if(item.expires!==null&&item.expires<=now)cookies.delete(key);return [...cookies.values()].filter(item=>pathname===item.path||pathname.startsWith(item.path.endsWith('/')?item.path:item.path+'/')).sort((a,b)=>b.path.length-a.path.length).map(item=>`${item.name}=${item.value}`).join('; ');};
 const acceptCookies=(response,url)=>{
  const returned=response.headers.getSetCookie?.()??[response.headers.get('set-cookie')].filter(Boolean),target=new URL(url);
  for(const entry of returned){const [pair,...attributes]=entry.split(';'),at=pair.indexOf('=');if(at<1||pair.length>16384)continue;const name=pair.slice(0,at).trim(),value=pair.slice(at+1).trim();if(!/^[!#$%&'*+.^_`|~\da-z-]+$/i.test(name))continue;
   const options=new Map(attributes.map(attribute=>{const index=attribute.indexOf('=');return index<0?[attribute.trim().toLowerCase(),'']:[attribute.slice(0,index).trim().toLowerCase(),attribute.slice(index+1).trim()];}));
   if(options.has('secure')||options.has('domain')&&options.get('domain').replace(/^\./,'').toLowerCase()!==target.hostname.toLowerCase())continue;
   const defaultPath=target.pathname.slice(0,target.pathname.lastIndexOf('/'))||'/',path=options.get('path')?.startsWith('/')?options.get('path'):defaultPath,key=name+'|'+path;
   const maxAge=options.has('max-age')&&/^-?\d+$/.test(options.get('max-age'))?Number(options.get('max-age')):null,expires=maxAge!==null?Date.now()+maxAge*1000:options.has('expires')?Date.parse(options.get('expires')):null;
   if(expires!==null&&expires<=Date.now()){cookies.delete(key);continue;}
   if(cookies.size>=64&&!cookies.has(key))throw failure('Portal visitor exceeded its cookie bound.','PortalCookieLimit');
   cookies.set(key,{name,value,path,expires:Number.isFinite(expires)?expires:null});
  }
 };
 const check=()=>{if(closed)throw failure('Portal session is closed.','PortalSessionClosed');};
 const transport=async(url,init={})=>{
  const headers=new Headers(init.headers),method=String(init.method??'GET').toUpperCase();
  if(!methods.has(method))throw failure('Unsupported portal request method.','InvalidPortalMethod');
  if(headers.has('cookie')||headers.has('authorization')||headers.has('x-sim-csrf')||headers.has('x-paqvilo-local-only'))throw failure('Session identity and local-only controls are owned by the client.','SessionHeaderOverride');
  const cookie=cookieHeader(url);if(cookie)headers.set('cookie',cookie);
  headers.set('x-paqvilo-local-only','true');
  const signals=[AbortSignal.timeout(timeoutMs),signal,init.signal].filter(Boolean);
  const response=await fetchImpl(url,{...init,method,headers,redirect:'manual',signal:AbortSignal.any(signals)});
  acceptCookies(response,url);
  return response;
 };
 const administration=async(route,{method='GET',body}={})=>{
  const headers={...(body!==undefined?{'content-type':'application/json'}:{}),...(method!=='GET'?{'x-sim-csrf':csrf}:{})};
  // Administration's CSRF header is internal, separate from arbitrary portal headers.
  const url=`${origin}/_sim/api${route}`,cookie=cookieHeader(url),response=await fetchImpl(url,{method,headers:{...headers,...(cookie?{cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),signal].filter(Boolean))});
  const value=await response.json();
  if(!response.ok)throw failure(`Local session control failed with HTTP ${response.status}.`,value?.error?.code??'PortalSessionControlFailed',response.status);
  acceptCookies(response,url);
  return value;
 };
 const change=async(fn)=>{check();if(active||changing)throw failure('Wait for this visitor\'s requests before changing its identity.','PortalSessionBusy',409);changing=true;try{return publicSession(await fn());}finally{changing=false;}};
 const state=await administration('/state?summary=1');
 if(state.config?.mode==='live'||state.config?.pageMode==='live')throw failure('Portal session automation requires a local Mirage runtime.','LocalRuntimeRequired',409);
 csrf=state.csrf;if(typeof csrf!=='string'||!csrf)throw failure('Local runtime did not provide session controls.','PortalSessionControlUnavailable');
 const client=Object.freeze({
  id,origin,
  session:()=>{check();if(changing)throw failure('This visitor\'s identity change is still pending.','PortalSessionBusy',409);
   active++;return administration('/session').then(publicSession).finally(()=>{active--;});},
  async witness({tables}={}) {
   check();if(changing)throw failure('This visitor\'s identity change is still pending.','PortalSessionBusy',409);
   active++;try{return await administration(`/verification-witness?tables=${encodeURIComponent(Array.isArray(tables)?tables.join(','):'')}`);}finally{active--;}
  },
  signIn:(nextContactId,{roles:nextRoles}={})=>change(()=>administration('/session/sign-in',{method:'POST',body:{contactId:nextContactId,...(nextRoles!==undefined?{roles:nextRoles}:{})}})),
  signOut:()=>change(()=>administration('/session/sign-out',{method:'POST',body:{}})),
  setRoles:nextRoles=>change(()=>administration('/session/roles',{method:'POST',body:{roles:nextRoles}})),
  async request(route,init={}) {
   check();if(changing)throw failure('This visitor\'s identity change is still pending.','PortalSessionBusy',409);
   const url=portalRoute(origin,route),method=String(init.method??'GET').toUpperCase();active++;
   try {
    const headers=new Headers(init.headers);
    if(!['GET','HEAD','OPTIONS'].includes(method)&&new URL(url).pathname.startsWith('/_api/')&&!headers.has('__requestverificationtoken'))headers.set('__RequestVerificationToken',csrf);
    return await transport(url,{...init,headers});
   }finally{active--;}
  },
  async json(route,{body,...init}={}) {
   const headers=new Headers(init.headers);if(body!==undefined)headers.set('content-type','application/json');
   const response=await client.request(route,{...init,headers,...(body!==undefined?{body:JSON.stringify(body)}:{})});
   return {status:response.status,traceId:response.headers.get('x-sim-trace-id'),body:response.status===204?null:await response.json()};
  },
  close(){check();if(active||changing)throw failure('Wait for this visitor\'s requests before closing it.','PortalSessionBusy',409);cookies.clear();csrf='';closed=true;},
  toJSON:()=>({id,origin}),
 });
 if(contactId!==undefined)await client.signIn(contactId,{roles});
 else if(roles!==undefined)throw failure('Role overrides require an explicit contact.','InvalidPortalSession');
 return client;
}
