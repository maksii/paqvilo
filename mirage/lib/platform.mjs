import { decodeXml, portalField } from "./importer.mjs";
import fs from "node:fs/promises";
import {
  clientManagedControlsRuntime,
  validateManagedControlDefinition,
} from "./managed-controls.mjs";
import { clientLocalSelfOriginRuntime } from "./local-self-origin.mjs";
import {
  clientDateControlsRuntime,
  datePickerFormat,
} from "./date-controls.mjs";
import {
  buildLayout,
  actionLinks,
  listModel,
  subgridModel,
  lookupModel as nativeLookupModel,
  associateModel,
  localizedText,
  formCells,
  metaFilterGroups,
  executeGridQuery,
  settingsJson,
} from "./native-services.mjs";
import { webFormSession, sessionRecord, previousSessionRecord, formText, webFormSessionOwner, advancedFormAccess, appendRedirectRecordId } from "./form-service.mjs";
import { deniedPageRoute } from "./redirects.mjs";
import { approximateFormSchema, approximateAdvancedFormSchema } from "./form-schema-fallback.mjs";
import { hasPlatformBundles } from "./platform-manifest.mjs";
import { clientPortalObjectRuntime } from "./portal-client-object.mjs";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** Complete an exported lookup view without silently dropping later pages. */
export async function readLookupView(fetchXml, readProvider, identity) {
  const root = /<fetch\b([^>]*)>/i.exec(fetchXml);
  if (!root) throw new Error("Lookup view requires a FetchXML root.");
  const initialPage = Number(
    /\bpage\s*=\s*["'](\d+)["']/i.exec(root[1])?.[1] ?? 1,
  );
  const baseAttributes = root[1].replace(
    /\s+(?:page|paging-cookie)\s*=\s*(["'])[\s\S]*?\1/gi,
    "",
  );
  const rows = [],
    cookies = new Set();
  let xml = fetchXml;
  for (let page = initialPage; page < initialPage + 100; page++) {
    const result = await readProvider.fetchXml(xml, identity);
    rows.push(...(result.entities ?? result.value ?? []));
    if (rows.length > 100000)
      throw Object.assign(
        new Error("Lookup view exceeds the bounded 100,000-row limit."),
        { status: 501, code: "LOOKUP_VIEW_LIMIT" },
      );
    if (!result.more_records) return rows;
    const cookie = result.paging_cookie;
    if (
      !cookie ||
      cookies.has(cookie) ||
      !(result.entities ?? result.value)?.length
    )
      throw Object.assign(
        new Error(
          "Lookup view pagination did not provide a new usable paging cookie.",
        ),
        { status: 501, code: "LOOKUP_VIEW_PAGING_UNRESOLVED" },
      );
    cookies.add(cookie);
    xml = fetchXml.replace(
      root[0],
      `<fetch${baseAttributes} page="${page + 1}" paging-cookie="${escape(cookie)}">`,
    );
  }
  throw Object.assign(
    new Error("Lookup view exceeds the bounded 100-page limit."),
    { status: 501, code: "LOOKUP_VIEW_LIMIT" },
  );
}

/** Power Pages view controls substitute context-marked conditions at any depth. */
export function contextualViewFetchXml(xml, { user, identity, website } = {}) {
  const contact = user ?? identity;
  const ids = {
    contact: contact?.contactId ?? contact?.id,
    account:
      contact?.accountId ??
      contact?.parentcustomerid?.id ??
      contact?.parentcustomerid,
    adx_website: website?.id,
  };
  return xml.replace(/<condition\b[^>]*>/gi, (tag) => {
    const type = /\buitype\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2]?.toLowerCase();
    if (!(type in ids)) return tag;
    const value = escape(ids[type] || "00000000-0000-0000-0000-000000000000");
    return /\bvalue\s*=/i.test(tag)
      ? tag.replace(/\bvalue\s*=\s*(["'])(.*?)\1/i, `value="${value}"`)
      : tag.replace(/\/?\s*>$/, (end) => ` value="${value}"${end}`);
  });
}

/** Dataverse systemform XML can accompany the PAC export or be supplied in an admin schema. */
export function schemaFromFormXml(
  xml,
  { entity, title, fieldTypes = {}, lcid = 1033 } = {},
) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Form XML declarations are not supported");
  if (!/<form\b/i.test(xml) || !/<\/form>/i.test(xml))
    throw new Error("A complete systemform form XML document is required");
  const attributes = (markup) =>
    Object.fromEntries(
      [...markup.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [
        m[1],
        decodeXml(m[3]),
      ]),
    );
  const label = (body) => {
    const labels = [...body.matchAll(/<label\b([^>]*?)\/?\s*>/gi)].map((m) =>
      attributes(m[1]),
    );
    return (
      labels.find((l) => Number(l.languagecode) === Number(lcid)) ?? labels[0]
    )?.description;
  };
  const fields = [];
  for (const cell of xml.matchAll(/<cell\b([^>]*)>([\s\S]*?)<\/cell>/gi)) {
    const control = /<control\b([^>]*?)\/?\s*>/i.exec(cell[2]);
    if (!control) continue;
    const attrs = attributes(control[1]);
    const name = attrs.datafieldname;
    if (!name) continue;
    if (!/^[a-z][\w]*$/i.test(name))
      throw new Error(`Invalid form field ${name}`);
    const config =
      typeof fieldTypes[name] === "object"
        ? fieldTypes[name]
        : { type: fieldTypes[name] };
    fields.push({
      name,
      id: attrs.id ?? name,
      label: label(cell[2]) ?? name,
      type: config.type ?? "text",
      readOnly: attrs.disabled === "true",
      hidden: attributes(cell[1]).visible === "false",
      ...config,
    });
  }
  if (!fields.length) throw new Error("Form XML has no bound control fields");
  return { entity, title, fields, source: "systemform-xml" };
}

/** Client shims only for portal-owned APIs, leaving the export's scripts and markup intact. */
export function clientRuntime(token, revision, identity = {}, traceId = null, site = {}) {
  identity ??= {};
  const scriptJson = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
  return `(() => {
    const token = ${JSON.stringify(token)};
    const simulation=window.__portalSimulation ||= {};simulation.revision=${JSON.stringify(revision)};simulation.local=true;
    if(simulation.runtimeInstalled)return;simulation.runtimeInstalled=true;
    ${clientLocalSelfOriginRuntime()}
    ${clientDateControlsRuntime()}
    const parentTrace=${scriptJson(traceId)};
    if(parentTrace){
      const sameOrigin=value=>{try{return new URL(localSelfUrl(typeof value==='string'?value:value?.url||String(value)),location.href).origin===location.origin;}catch{return false;}};
      if(typeof window.fetch==='function'){const fetch=window.fetch;window.fetch=function(input,options){if(!sameOrigin(input))return fetch.call(this,input,options);const headers=new Headers(options?.headers??input?.headers);if(!headers.has('X-Sim-Parent-Trace'))headers.set('X-Sim-Parent-Trace',parentTrace);return fetch.call(this,input,{...options,headers});};}
      const xhr=window.XMLHttpRequest?.prototype;if(xhr){const open=xhr.open,set=xhr.setRequestHeader,send=xhr.send;xhr.open=function(method,url,...args){this.__ppSimSameOrigin=sameOrigin(url);this.__ppSimExplicitTrace=false;return open.call(this,method,url,...args);};xhr.setRequestHeader=function(name,value){if(String(name).toLowerCase()==='x-sim-parent-trace')this.__ppSimExplicitTrace=true;return set.call(this,name,value);};xhr.send=function(...args){if(this.__ppSimSameOrigin&&!this.__ppSimExplicitTrace)set.call(this,'X-Sim-Parent-Trace',parentTrace);return send.apply(this,args);};}
    }
    for (const prototype of [String.prototype, Array.prototype]) if (!prototype.contains) Object.defineProperty(prototype, 'contains', { value: function(value) { return this.includes(value); }, configurable: true, writable: true });
    // Native shell (postpreform.bundle antiforgerytoken): the platform renders
    // div#antiforgerytoken empty; the first caller fetches its data-url (GET, cache-busted,
    // three attempts), the holder receives the returned input and queued callers resolve.
    window.shell ||= {};
    const tokenInput=()=>document.querySelector('#antiforgerytoken input[name="__RequestVerificationToken"]');
    const pendingTokens=[];
    const deferredOf=()=>{
      const jq=typeof window.jQuery?.Deferred==='function'?window.jQuery:null;
      if(jq)return jq.Deferred();
      let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});
      const deferred={resolve:(...v)=>{resolve(v[0]);return deferred;},reject:(...v)=>{reject(v[0]);return deferred;},rejectWith:(_c,v)=>{reject(v?.[0]);return deferred;},promise:()=>{promise.done=fn=>{promise.then(fn);return promise;};promise.fail=fn=>{promise.catch(fn);return promise;};return promise;}};
      promise.catch(()=>{});return deferred;
    };
    const tokenRequest=(url,attempts)=>{
      const jq=typeof window.jQuery?.ajax==='function'?window.jQuery:null;
      const once=()=>jq?new Promise((resolve,reject)=>jq.ajax({type:'GET',url,cache:false}).done(resolve).fail((xhr)=>reject(xhr))):fetch(url+(url.includes('?')?'&':'?')+'_='+Date.now(),{credentials:'same-origin',cache:'no-store'}).then(r=>r.ok?r.text():Promise.reject({responseText:'HTTP '+r.status}));
      const run=left=>once().catch(error=>{console.log('AjaxRetry attempt :'+left);if(left-1>0)return run(left-1);throw error;});
      return run(attempts);
    };
    window.shell.getTokenDeferred = function () {
      const deferred=deferredOf();
      const holder=document.getElementById('antiforgerytoken');
      const value=tokenInput()?.value||(holder?'':token);
      if(value){deferred.resolve(value);return deferred.promise();}
      pendingTokens.push(deferred);
      if(pendingTokens.length===1)
        tokenRequest(holder.getAttribute('data-url')||'/_layout/tokenhtml',3).then(html=>{
          const target=document.getElementById('antiforgerytoken');if(target)target.innerHTML=html;
          const current=tokenInput()?.value;for(const queued of pendingTokens.splice(0))queued.resolve(current);
        },error=>{
          if(error?.responseText)console.log('GetAntiForgeryToken failedDetails: '+error.responseText);
          for(const queued of pendingTokens.splice(0))queued.reject();
        });
      return deferred.promise();
    };
    window.shell.refreshToken ||= function () {
      const url=document.getElementById('antiforgerytoken')?.getAttribute('data-url')||'/_layout/tokenhtml';
      return tokenRequest(url,3).then(html=>{
        for(const input of [...document.querySelectorAll('input[name="__RequestVerificationToken"]')]){const template=document.createElement('template');template.innerHTML=html;input.replaceWith(...template.content.childNodes);}
        return /value="([^"]+)"/.exec(html)?.[1];
      },error=>{if(error?.responseText)console.log('GetAntiForgeryToken failedDetails: '+error.responseText);});
    };
    window.shell.ajaxSafePost ||= function (options, form) {
      const jq=typeof window.jQuery?.Deferred==='function'?window.jQuery:null;const deferred=deferredOf();
      window.shell.getTokenDeferred().done(value=>{
        if(options.mimeType==='multipart/form-data'){if(!options.data)options.data=new FormData();options.data.append('__RequestVerificationToken',value);}
        else if(form&&jq)jq('<input>').attr('name','__RequestVerificationToken').attr('type','hidden').appendTo(form).val(value);
        else{options.headers||={};options.headers.__RequestVerificationToken=value;}
        if(form&&typeof form.ajaxSubmit==='function'){const complete=options.complete;options.complete=xhr=>window.validateLoginSession(null,null,xhr,complete);form.ajaxSubmit(options);return;}
        if(!jq){deferred.reject();return;}
        jq.ajax(options).done((data,status,xhr)=>window.validateLoginSession(data,status,xhr,deferred.resolve)).fail(deferred.reject);
      }).fail(function(){deferred.rejectWith(this,arguments);});
      return deferred.promise();
    };
    // Native: an AJAX response whose X-Responded-JSON reports 401/403 sends the browser to sign-in.
    window.redirectToLogin ||= function () { window.location.replace(window.location.origin+'/SignIn?returnUrl='+encodeURIComponent(window.location.href)); };
    window.validateLoginSession ||= function (data, status, xhr, callback) {
      let responded=null;try{responded=JSON.parse(xhr?.getResponseHeader?.('x-responded-json')??'null');}catch{responded=null;}
      if(responded?.status===401||responded?.status===403){window.redirectToLogin();return;}
      if(typeof callback==='function')callback(data,status,xhr);
    };
    window.portal ||= {};window.portal.IsRequestedFromMaker ||= function(){return false;};
    const installLegacyJQueryEvents=()=>{const jq=window.jQuery;if(!jq?.fn||jq.fn.load?.__ppSimLegacy)return;const load=jq.fn.load;const handler=function(first,...rest){return typeof first==='function'?this.on('load',first):load.apply(this,[first,...rest]);};handler.__ppSimLegacy=true;jq.fn.load=handler;};installLegacyJQueryEvents();document.addEventListener('load',installLegacyJQueryEvents,true);
    ${clientPortalObjectRuntime(identity, { ...site, traceId })}
    // One stream per portal tab. Parent navigation reloads its managed frames;
    // per-frame streams exhaust the browser's same-origin HTTP connection pool.
    if(window.parent===window){const connect=()=>{if(simulation.reloadStream&&simulation.reloadStream.readyState!==2)return;const events=simulation.reloadStream=new EventSource('/__sim/events');events.addEventListener('reload',()=>location.reload());};const close=()=>{simulation.reloadStream?.close();simulation.reloadStream=null;};window.addEventListener('pagehide',close);window.addEventListener('pageshow',connect);connect();}
  })();`;
}

/** Static native platform compatibility scripts served by lib/native-services.mjs. */
export const NATIVE_GRID_SCRIPT = "/__sim-static/native/entity-grid-compat.js";
export const NATIVE_FORMS_SCRIPT = "/__sim-static/native/webforms-compat.js";

/** The website id and language of a rendered platform page (its ResourceManager script). */
function pageSite(html) {
  const resources = /\/_portal\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/Resources\/ResourceManager\?lang=([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)/i.exec(html);
  const language = resources?.[2] ?? /<html\b[^>]*\blang=["']([^"']+)["']/i.exec(html)?.[1] ?? "";
  return { websiteId: resources?.[1] ?? "", language };
}

export function injectRuntime(
  html,
  token,
  revision,
  identity = {},
  traceId = null,
) {
  const script = `${traceId && !/<meta\b[^>]*\bname=["']sim-trace-id["']/i.test(html) ? `<meta name="sim-trace-id" content="${escape(traceId)}">` : ""}<script data-paqvilo-mirage-runtime>${clientRuntime(token, revision, identity, traceId, pageSite(html))}</script>`;
  // Native pages always carry the empty anti-forgery holder and its token URL.
  if (!/\bid=["']antiforgerytoken["']/i.test(html))
    html = html.replace(
      /<body\b[^>]*>/i,
      `$&<div id="antiforgerytoken" data-url="/_layout/tokenhtml"></div>`,
    );
  // The managed grid/lookup/notes runtime loads after the page content, like
  // the native app bundle, so authored ready handlers are registered first. Documents
  // with the platform bundles get it from the app bundle's local equivalent.
  const grid = `<script src="${NATIVE_GRID_SCRIPT}" data-paqvilo-mirage-native></script>`;
  if (!html.includes(NATIVE_GRID_SCRIPT) && !hasPlatformBundles(html))
    html = /<\/body>/i.test(html)
      ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${grid}$&`)
      : html + grid;
  return /<head\b[^<>]*>/i.test(html)
    ? html.replace(/<head\b[^<>]*>/i, "$&" + script)
    : script + html;
}

/** Use the observed managed CKEditor bytes, binding HTML as the native JSON input. */
export function clientRichTextRuntime(settings) {
  const data = JSON.stringify(settings).replace(/</g, "\\u003c");
  return `(async()=>{
    const settings=${data},base='/webresources/msdyn_/RichTextEditorControl/';
    const state=window.__portalSimulation ||= {};
    const loadJson=async url=>{const response=await fetch(url);if(!response.ok)throw new Error('Rich text configuration unavailable: '+url+' ('+response.status+')');return response.json();};
    const loadEditor=()=>state.richTextLibrary ||= new Promise((resolve,reject)=>{if(window.CKEDITOR){resolve(window.CKEDITOR);return;}window.CKEDITOR_BASEPATH=base+'libs/ckeditor_latest/';const script=document.createElement('script');script.src=CKEDITOR_BASEPATH+'ckeditor.js';script.onload=()=>resolve(window.CKEDITOR);script.onerror=()=>reject(new Error('The managed rich text editor dependency is unavailable.'));document.head.append(script);});
    const compatibilityEditor=async(id,input,container)=>{
      const textarea=document.getElementById(id+'_editor'),initial=textarea?.value||'';
      const toolbar=document.createElement('div');toolbar.className='sim-richtext-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','Compatibility editor formatting');
      const frame=document.createElement('iframe');frame.className='cke_wysiwyg_frame';frame.title='Compatibility rich text editor';frame.setAttribute('aria-label','Compatibility rich text editor');frame.style.cssText='width:100%;min-height:12rem;border:1px solid #8a8886;background:#fff';
      const badge=document.createElement('span');badge.className='sim-compatibility-badge';badge.textContent='Compatibility editor';
      const actions=[['Bold','bold'],['Italic','italic'],['Underline','underline'],['Bulleted list','insertUnorderedList'],['Numbered list','insertOrderedList']];
      for(const [label,command] of actions){const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-label',label);button.addEventListener('mousedown',event=>event.preventDefault());button.addEventListener('click',()=>{frame.contentDocument.execCommand(command,false,null);frame.contentWindow.focus();});toolbar.append(button);}
      container.replaceChildren(badge,toolbar,frame);container.dataset.simEditorMode='compatibility';
      const loaded=new Promise(resolve=>frame.addEventListener('load',resolve,{once:true}));
      frame.srcdoc='<!doctype html><html><head><meta charset="utf-8"><style>body{font:inherit;margin:8px;min-height:10rem;outline:none}body:focus{outline:none}</style></head><body contenteditable="true" role="textbox" aria-label="Rich text content" aria-multiline="true"></body></html>';
      await loaded;
      let content=initial;const body=()=>frame.contentDocument?.body;
      const listeners=new Map(),fire=(name,data={})=>{for(const callback of listeners.get(name)||[])callback({name,editor,...data});};
      const getData=()=>{const html=body()?.innerHTML??content;if(!html||/<(?:p|div|ul|ol|blockquote|h[1-6])\b/i.test(html))return html;return '<p>'+html+'</p>';};
      const sync=()=>{content=body()?.innerHTML??content;const encoded=JSON.stringify(getData());input.value=encoded;input.setAttribute('value',encoded);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));fire('change');};
      const editor={name:id+'_editor',config:{},on(name,callback){const rows=listeners.get(name)||[];rows.push(callback);listeners.set(name,rows);return editor;},fire(name,data){fire(name,data);return editor;},getData(){return getData();},setData(value,callback){content=String(value??'');const current=body();if(current)current.innerHTML=content;sync();if(callback)callback();return editor;},updateElement(){sync();return editor;},focus(){body()?.focus();return editor;},editable(){return frame.contentDocument.body;},destroy(){frame.remove();toolbar.remove();badge.remove();delete window.CKEDITOR.instances[editor.name];return editor;}};
      window.CKEDITOR ||= {instances:{},replace(){throw new Error('Native CKEditor is unavailable in compatibility mode.');}};
      window.CKEDITOR.instances ||= {};window.CKEDITOR.instances[editor.name]=editor;
      // Moving the frame (authored layout scripts do) reloads its document: restore the content and rebind.
      const bind=()=>{const current=body();if(!current||current.__ppSimBound)return;current.__ppSimBound=true;if(current.innerHTML!==content)current.innerHTML=content;current.addEventListener('input',sync);current.addEventListener('blur',sync);};
      frame.addEventListener('load',bind);bind();
      queueMicrotask(()=>{container.dataset.mounted='ready';container.dispatchEvent(new CustomEvent('sim:richtext-ready',{bubbles:true,detail:{field:id,mode:'compatibility'}}));fire('instanceReady');});
      console.info('Local rich text compatibility editor active for '+id+'; native CKEditor assets were not captured.');
    };
    for(const [id,configuration] of Object.entries(settings)){
      const input=document.getElementById(id),container=document.querySelector('[data-sim-richtext-editor][data-field="'+id+'"]');if(!input||!container||container.dataset.mounted)continue;container.dataset.mounted='loading';
      try{
        if(configuration.compatibility){await compatibilityEditor(id,input,container);continue;}
        const [editorLibrary,globalConfiguration,fieldConfiguration]=await Promise.all([loadEditor(),state.richTextGlobalConfiguration ||= loadJson(base+'RTEGlobalConfiguration.json'),configuration.configUrl?loadJson(configuration.configUrl):configuration.configuration]);
        editorLibrary.timestamp='';
        const config={...globalConfiguration.defaultSupportedProps,...fieldConfiguration.defaultSupportedProps,stylesSet:false,contentsCss:[base+'libs/ckeditor_latest/contents.css'],language:document.documentElement.lang?.split('-')[0]||'en',readOnly:container.dataset.readOnly==='true'};
        const editor=editorLibrary.replace(id+'_editor',config);
        const sync=()=>{const encoded=JSON.stringify(editor.getData());input.value=encoded;input.setAttribute('value',encoded);input.dispatchEvent(new Event('change',{bubbles:true}));};
        editor.on('change',sync);editor.on('instanceReady',()=>{container.dataset.mounted='ready';sync();container.dispatchEvent(new CustomEvent('sim:richtext-ready',{bubbles:true,detail:{field:id}}));});
      }catch(error){container.dataset.mounted='failed';const alert=container.querySelector('[data-sim-richtext-error]');alert.hidden=false;alert.textContent=error.message;console.error(error);}
    }
  })();`;
}

// ---------------------------------------------------------------------------
// Native component rendering (basic forms, advanced forms, lists, subgrids,
// lookups). Local markup contracts are described in
// docs/forms-lists-parity.md; behaviour is supplied by webforms-compat.js and
// entity-grid-compat.js against the services in native-services.mjs.

const canonicalId = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
// ASP.NET client ids: {guid:N}; schema-only names keep word characters only.
const compactId = (value) => canonicalId(value).replace(/-/g, "").replace(/[^A-Za-z0-9_]/g, "_");
const scalarValue = (value) =>
  value && typeof value === "object" ? (value.id ?? value.value) : value;
const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const attr = (value) => escape(value);
const fieldOf = (record, name) => portalField(record ?? {}, name);
const truthy = (value) => value === true || /^(true|1)$/i.test(String(value ?? ""));
const base64Json = (value) => Buffer.from(JSON.stringify(value)).toString("base64");

const CHECKBOX_CLASS = "b0c6723a-8503-4fd7-bb28-c8a06ac933c2";
const RADIO_CLASS = "67fac785-cd58-4f9f-abb3-4b7ddc6ed5ed";
const DROPDOWN_CLASS = "3ef39988-22bb-4f0b-bbbe-64b5a3748aee";
const FORM_MODE = { insert: 100000000, edit: 100000001, readOnly: 100000002 };

function componentError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function nativeControlKind(field) {
  const type = String(field.dataverseType ?? "").toLowerCase();
  if (field.richText) return "richtext";
  if (field.type === "lookup" || /^(lookup|customer|owner)$/.test(type)) return "lookup";
  if (type === "multiselectpicklist") return "multiselect";
  if (/^(state|status)$/.test(type)) return type;
  if (type === "picklist" || (field.options?.length && !/^(bit|boolean)$/.test(type) && field.type !== "boolean")) return "picklist";
  if (/^(bit|boolean)$/.test(type) || field.type === "boolean" || field.type === "checkbox") return "boolean";
  if (type === "datetime" || ["date", "datetime-local"].includes(field.type)) return "datetime";
  if (/^(int|integer|bigint)$/.test(type)) return "integer";
  if (type === "decimal") return "decimal";
  if (/^(float|double)$/.test(type)) return "double";
  if (type === "money") return "money";
  if (/^(memo|ntext)$/.test(type) || field.type === "textarea") return "textarea";
  if (field.type === "number") return "integer";
  if (field.type === "email" || String(field.format ?? "").toLowerCase() === "email") return "email";
  return "text";
}

/** Merge basic/advanced form metadata (adx_entityformmetadata / adx_webformmetadata). */
function formMetadataRows(portal, definition, stepId) {
  return (portal.records ?? []).filter(
    (row) =>
      ["basicformmetadata", "advancedformmetadata"].includes(row.kind) &&
      ((definition && canonicalId(fieldOf(row, "entityform")) === canonicalId(definition.id)) ||
        (stepId && canonicalId(fieldOf(row, "webformstep")) === canonicalId(stepId))),
  );
}

const metadataFor = (rows, type, predicate) =>
  rows.find((row) => Number(fieldOf(row, "type") ?? 100000000) === type && predicate(row));

function renderLiquidText(renderLiquid, context, value) {
  return renderLiquid ? renderLiquid(String(value ?? ""), context) : Promise.resolve(String(value ?? ""));
}

/** Locate the form record from the native record source settings. */
async function resolveFormRecord({ kind, definition, schema, metadata, context, readProvider, store, identity, modal, session }) {
  let mode = Number(schema.mode ?? definition?.mode ?? FORM_MODE.insert);
  const params = context.request?.params ?? {};
  const component = schema.metadata ?? definition?.metadata ?? {};
  if (schema.recordId) return { mode, id: schema.recordId };
  if (kind === "webform") {
    // A step already saved in this session is edited rather than inserted again.
    const own = sessionRecord(session, schema.stepId);
    if (own) return { mode: mode === FORM_MODE.insert ? FORM_MODE.edit : mode, id: own };
    if (mode === FORM_MODE.insert) return { mode, id: null };
    // WebForm.cs: a later step whose source is "Result From Previous Step" (or
    // that declares no source) edits the record saved by the previous step.
    const sourceType = Number(fieldOf(component, "entitysourcetype") ?? 100000003);
    if (sourceType === 100000003) {
      const sourceStep = fieldOf(component, "entitysourcestep");
      const previous = sourceStep ? sessionRecord(session, sourceStep) : previousSessionRecord(session, schema.stepId);
      return { mode, id: previous ?? params.id ?? null, queryName: "id" };
    }
  }
  if (mode === FORM_MODE.insert) return { mode, id: null };
  const sourceType = Number(fieldOf(component, "entitysourcetype") ?? (kind === "webform" ? 100000001 : 756150001));
  const queryName =
    fieldOf(component, kind === "webform" ? "primarykeyquerystringparametername" : "recordidquerystringparametername") ||
    fieldOf(component, "recordidquerystringparametername") ||
    "id";
  const contactId = identity?.contactId ?? identity?.id;
  if (sourceType === 756150002 || sourceType === 100000002) return { mode, id: contactId ?? null, sourceType };
  if (sourceType === 756150003 || sourceType === 100000004) {
    const relationship = fieldOf(component, "recordsourcerelationshipname");
    const contactMapping = store.resolveMapping("contact");
    const entry = Object.entries(contactMapping.relationships ?? {}).find(
      ([name, relation]) => name === relationship || relation.schemaName === relationship,
    );
    let id = null;
    if (entry && contactId) {
      const [, relation] = entry;
      if (relation.many === false) {
        const contact = await readProvider.get("contact", contactId, identity);
        id = scalarValue(contact?.[relation.from]) ?? null;
      } else {
        const result = await readProvider.query(relation.entity, { $filter: `${relation.to} eq ${contactId}`, $top: 1 }, identity);
        const target = store.resolveMapping(relation.entity);
        id = result.value?.[0]?.[target.idColumn] ?? null;
      }
    }
    if (!id && truthy(fieldOf(component, "recordsourceallowcreateonnull"))) return { mode: FORM_MODE.insert, id: null, createOnNull: true };
    return { mode, id, sourceType };
  }
  const id = params[queryName] ?? (modal ? params.id : undefined) ?? (kind === "webform" ? params.id : undefined);
  return { mode, id: id ?? null, queryName };
}

function validatorMarkup(validators, { readonly = false } = {}) {
  return validators
    .map((validator) => `<span id="${attr(validator.id)}" style="${validator.display === "Dynamic" || validator.display === "None" ? "display:none;" : "visibility:hidden;"}"${readonly ? ' readonly="readonly"' : ""}>*</span>`)
    .join("");
}

function summaryLink(fieldId, message, linksEnabled) {
  if (!linksEnabled) return message;
  return `<a href='#${fieldId}_label' onclick='javascript:scrollToAndFocus("${fieldId}_label","${fieldId}");return false;' referenceControlId=${fieldId}>${escape(message)} </a>`;
}

/** Native validators (ASP.NET ids, Page_Validators expandos) for one field. */
function fieldValidators(field, { linksEnabled }) {
  // CellTemplate instantiates validators unless the field itself is read-only; a read-only
  // form keeps them.
  if ((field.fieldReadOnly ?? field.readOnly) || field.hidden) return [];
  const validators = [];
  const label = field.label ?? field.name;
  const id = field.name;
  const checkbox = field.control === "boolean" && ![RADIO_CLASS, DROPDOWN_CLASS].includes(canonicalId(field.controlClassId));
  if (field.required && checkbox)
    // CheckboxValidator is server-side only: its client evaluation always passes.
    validators.push({
      id: `RequiredFieldValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.requiredMessage || `To continue, select the check box labeled "${label}".`, linksEnabled),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
    });
  else if (field.required)
    validators.push({
      id: `RequiredFieldValidator${id}`,
      controltovalidate: field.controlToValidate ?? id,
      errormessage: summaryLink(id, field.requiredMessage || `${label} is a required field.`, linksEnabled),
      display: "Dynamic",
      evaluationfunction: "RequiredFieldValidatorEvaluateIsValid",
      initialvalue: "",
    });
  if (field.pattern)
    validators.push({
      id: `RegularExpressionValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.patternMessage || `${label} is not valid.`, linksEnabled),
      display: "Dynamic",
      evaluationfunction: "RegularExpressionValidatorEvaluateIsValid",
      validationexpression: field.pattern,
    });
  if (field.maxLength && ["text", "email", "textarea"].includes(field.control))
    validators.push({
      id: `MaximumLengthValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, `${label} exceeds the maximum length of ${field.maxLength} characters.`, linksEnabled),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
    });
  const format = {
    email: ["EmailFormatValidator", `${label} must be a valid email address.`],
    integer: ["IntegerValidator", `${label} must be a valid integer value.`],
    decimal: ["FloatValidator", `${label} must be a valid decimal value.`],
    double: ["FloatValidator", `${label} must be a valid floating-point value.`],
    datetime: ["DateFormatValidator", `${label} must have a valid date format.`],
  }[field.control];
  if (format)
    validators.push({
      id: `${format[0]}${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.validationMessage || format[1], linksEnabled),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
    });
  if (["integer", "decimal", "double", "money"].includes(field.control) && (field.minimum != null || field.maximum != null))
    validators.push({
      id: `RangeValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.rangeMessage || `${label} must have a value between ${field.minimum} and ${field.maximum}.`, linksEnabled),
      evaluationfunction: "RangeValidatorEvaluateIsValid",
      minimumvalue: String(field.minimum ?? ""),
      maximumvalue: String(field.maximum ?? ""),
      type: field.control === "integer" ? "Integer" : "Double",
    });
  return validators;
}

function validatorStartupScript(validators, summaryId, summaryHeader) {
  const lines = [];
  lines.push(`var Page_ValidationSummaries = (window.Page_ValidationSummaries || []).concat([document.getElementById(${json(summaryId)})]);`);
  lines.push(`var Page_Validators = (window.Page_Validators || []).concat([${validators.map((validator) => `document.getElementById(${json(validator.id)})`).join(", ")}].filter(Boolean));`);
  for (const validator of validators) {
    lines.push(`(function(){var v=document.getElementById(${json(validator.id)});if(!v)return;`);
    for (const [key, value] of Object.entries(validator)) if (key !== "id" && value !== undefined) lines.push(`v.${key}=${json(String(value))};`);
    lines.push("})();");
  }
  lines.push(`(function(){var s=document.getElementById(${json(summaryId)});if(s){s.headertext=${json(summaryHeader)};s.displaymode="BulletList";}})();`);
  lines.push('if (typeof(ValidatorOnLoad) == "function") ValidatorOnLoad();');
  return `<script type="text/javascript">//<![CDATA[\n${lines.join("\n")}\n//]]></script>`;
}

const LOOKUP_GRID_MESSAGES = `<div aria-label="There are no records to display." aria-live="polite" class="view-empty message" role="status" tabindex="-1" style="display:none"><div class="alert alert-block alert-warning">There are no records to display.</div></div><div class="view-access-denied message" role="presentation" tabindex="0" style="display:none"><div class="alert alert-block alert-danger">You don't have permissions to view these records.</div></div><div class="view-error message" role="presentation" tabindex="0" style="display:none"><div class="alert alert-block alert-danger">Error completing request.<span class="details"></span></div></div><div class="view-loading message text-center" role="presentation" tabindex="0" style="display:none"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div>`;
const PAGINATION = '<div class="view-pagination" data-current-page="1" data-pages="1" data-pagesize=""></div>';

function nativeModal({ className, title, body, footer = "", size = "", label }) {
  return `<section aria-hidden="true" aria-label="${attr(label ?? plainText(title))}" class="modal fade ${className}" data-backdrop="static" role="dialog" tabindex="-1"><div class="${size ? size + " " : ""}modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title" title="${attr(plainText(title))}">${title}</h1><button aria-label="Close" class="form-close" data-dismiss="modal" style="position: absolute; top: 3%;" tabindex="0" title="Close" type="button"><span aria-hidden="true">×</span><span class="sr-only">Close</span></button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}</div></div></section>`;
}
function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}
const formModalBody = (page) => `<div class="form-loading"><span class="fa fa-spinner fa-spin fa-4x" aria-hidden="true"></span></div><iframe data-page="${attr(page)}" src="about:blank"></iframe>`;

/** Native grid modals (create/edit/details forms, delete, error, workflow, (de)activate). */
function gridModals(page, settings = {}, language = {}) {
  const dialog = (name, fallback) => formText(settings?.[name]?.Title, fallback, language);
  return [
    nativeModal({ className: "modal-form modal-form-insert", title: dialog("CreateFormDialog", "<span class='fa fa-pencil-square-o' aria-hidden='true'></span> Create"), body: formModalBody(page), size: "modal-lg", label: "Create" }),
    nativeModal({ className: "modal-form modal-form-edit", title: dialog("EditFormDialog", "<span class='fa fa-edit'></span> Edit"), body: formModalBody(page), size: "modal-lg", label: "Edit" }),
    nativeModal({ className: "modal-form modal-form-details", title: dialog("DetailsFormDialog", "<span class='fa fa-info-circle' aria-hidden='true'></span> View details"), body: formModalBody(page), size: "modal-lg" }),
    nativeModal({ className: "modal-delete", title: dialog("DeleteDialog", "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete"), body: escape(formText(settings?.DeleteDialog?.Confirmation, "Are you sure you want to delete this record?", language)), footer: `<button aria-label="Delete" class="primary btn btn-primary" tabindex="0" title="Delete" type="button">${escape(localizedText(settings?.DeleteDialog?.PrimaryButtonText, "Delete"))}</button><button aria-label="Cancel" class="cancel btn btn-default" data-dismiss="modal" tabindex="0" title="Cancel" type="button">${escape(localizedText(settings?.DeleteDialog?.CloseButtonText, "Cancel"))}</button>`, label: "Delete" }),
    nativeModal({ className: "modal-error", title: "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> Error", body: "<p>We're sorry, an error has occurred.</p>", footer: '<button aria-label="Close" class="cancel btn btn-default" data-dismiss="modal" tabindex="0" title="Close" type="button">Close</button>' }),
    nativeModal({ className: "modal-run-workflow", title: "Run workflow", body: "Are you sure you want to run this workflow?", footer: '<button class="primary btn btn-primary" type="button">Run workflow</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' }),
    nativeModal({ className: "modal-deactivate", title: "Deactivate", body: "Are you sure you want to deactivate this record?", footer: '<button class="primary btn btn-primary" type="button">Deactivate</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' }),
    nativeModal({ className: "modal-activate", title: "Activate", body: "Are you sure you want to activate this record?", footer: '<button class="primary btn btn-primary" type="button">Activate</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' }),
    nativeModal({ className: "modal-disassociate", title: "Disassociate", body: "Are you sure you want to remove this association?", footer: '<button class="primary btn btn-primary" type="button">Remove</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' }),
  ].join("");
}

/** Native ViewConfiguration subset consumed by the grid runtime. */
function viewConfiguration(model, view, { actions, websiteId, languageCode = 1033, language = {} }) {
  const link = (type) => actions.find((action) => action.Type === type) ?? null;
  const disabledLink = { Enabled: false, Type: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" };
  const settings = model.settings ?? {};
  return {
    EntityName: model.entity,
    PrimaryKeyName: model.idColumn,
    ViewName: view.name ?? null,
    ViewId: view.id,
    Id: view.id,
    PageSize: model.pageSize,
    ViewDisplayName: view.displayName ?? "",
    CssClass: settings.CssClass ?? "",
    GridCssClass: settings.GridCssClass ?? "table-striped",
    GridColumnWidthStyle: Number(settings.GridColumnWidthStyle ?? 1),
    LoadingMessage: formText(settings.LoadingMessage, "", language),
    ErrorMessage: formText(settings.ErrorMessage, "", language),
    AccessDeniedMessage: formText(settings.AccessDeniedMessage, "", language),
    EmptyListText: model.emptyText || null,
    ColumnOverrides: (settings.ColumnOverrides ?? []).map((column) => ({ AttributeLogicalName: column.AttributeLogicalName, DisplayName: formText(column.DisplayName, "", language), Width: column.Width ?? null })),
    EnableEntityPermissions: true,
    Search: {
      Enabled: Boolean(model.search?.enabled),
      SearchQueryStringParameterName: "query",
      PlaceholderText: model.search?.placeholder ?? "Search",
      TooltipText: model.search?.tooltip ?? "",
      ButtonLabel: "<span class='sr-only'>Search</span><span class='fa fa-search' aria-hidden='true'></span>",
    },
    FilterQueryStringParameterName: "filter",
    SortQueryStringParameterName: "sort",
    PageQueryStringParameterName: "page",
    FilterByUserOptionLabel: "My",
    FilterPortalUserAttributeName: model.userFilters?.portalUser ?? null,
    FilterAccountAttributeName: model.userFilters?.account ?? null,
    FilterWebsiteAttributeName: model.userFilters?.website ?? null,
    FilterSettings: { Enabled: Boolean(model.filter?.enabled), FilterQueryStringParameterName: "mf", Orientation: model.filter?.vertical ? 756150001 : 756150000 },
    DetailsActionLink: link(1) ?? model.detailsActionLink ?? disabledLink,
    InsertActionLink: model.insertActionLink ?? disabledLink,
    EditActionLink: link(2) ?? disabledLink,
    DeleteActionLink: link(4) ?? disabledLink,
    AssociateActionLink: link(5) ?? disabledLink,
    DisassociateActionLink: link(6) ?? disabledLink,
    DeactivateActionLink: link(17) ?? disabledLink,
    ActivateActionLink: link(18) ?? disabledLink,
    CreateRelatedRecordActionLinks: [],
    ViewActionLinks: actions.filter((action) => action.position === "view").map(stripAction),
    ItemActionLinks: actions.filter((action) => action.position === "item").map(stripAction),
    ActionColumnHeaderText: "<span class='sr-only'>Actions</span>",
    ActionLinksColumnWidth: 20,
    PortalName: null,
    LanguageCode: languageCode,
    WebsiteId: websiteId,
  };
}
const stripAction = ({ source, position, FilterCriteria, ...action }) => action;

function gridLayouts(model, { secureBase, websiteId, metadata, actions, selectColumn = false, language = {} }) {
  const actionColumn = actions.some((action) => action.position === "item");
  return model.views.map((view) =>
    buildLayout({
      view,
      entity: canonicalId(view.entity ?? model.entity),
      idColumn: model.idColumn,
      primaryName: model.primaryName,
      metadata,
      settings: model.settings,
      configuration: viewConfiguration(model, view, { actions, websiteId, language }),
      secure: { ...secureBase, view: view.id },
      selectColumn,
      actionColumn,
    }),
  );
}

/** The request's website language (context.__language) and the website default, for [{LCID, Value}] labels. */
function requestLanguage(context, portal) {
  return {
    lcid: context?.__language?.lcid ?? null,
    defaultLcid: (portal?.websiteLanguages ?? []).find((language) => language.isDefault)?.lcid ?? null,
  };
}

/** Server markup of a native list grid (entity_list built-in template). */
async function renderListGrid(model, context, options) {
  const websiteId = canonicalId(options.portal.website?.id);
  const language = requestLanguage(context, options.portal);
  const page = `/_portal/modal-form-template-path/${websiteId}`;
  const actions = actionLinks(model.settings, { portal: options.portal, requestUrl: context.request?.url ?? "http://localhost/", website: websiteId });
  if (model.detailsPage && !actions.some((action) => action.Type === 1)) {
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.detailsPage);
    if (target)
      model.detailsActionLink = { Type: 1, Enabled: true, Target: 1, Label: model.detailsLabel, Tooltip: model.detailsLabel, URL: { PathWithQueryString: target.url, Path: target.url }, QueryStringIdParameterName: model.idParameter, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" };
  }
  if (model.createPage && !actions.some((action) => action.Type === 3)) {
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.createPage);
    if (target)
      actions.push({ position: "view", Type: 3, Enabled: true, Target: 1, Label: model.createLabel, Tooltip: model.createLabel, URL: { PathWithQueryString: target.url, Path: target.url }, FilterCriteriaId: "00000000-0000-0000-0000-000000000000", ActionIndex: 0 });
  }
  const layouts = gridLayouts(model, { secureBase: { t: "list", w: websiteId, list: model.list.id }, websiteId, metadata: options.metadata, actions, language });
  const settings = model.settings ?? {};
  const identity = context.user ?? context.identity;
  const authenticated = Boolean(identity?.contactId ?? identity?.id);
  const grid = `<div class="entity-grid entitylist${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-grid-data.json/${websiteId}" data-grid-class="${attr(settings.GridCssClass ?? "table-striped")}" data-select-mode="None" data-selected-view="${attr(model.views[0].id)}" data-view-layouts="${base64Json(layouts)}" data-user-isauthenticated="${authenticated}" data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}" data-mobile-view-enabled="true"><div class="view-grid"></div><div class="view-empty message">${model.emptyText ? model.emptyText : '<div class="alert alert-block alert-warning">There are no records to display.</div>'}</div><div class="view-access-denied message"><div class="alert alert-block alert-danger">You don't have permissions to view these records.</div></div><div class="view-error message"><div class="alert alert-block alert-danger">Error completing request.<span class="details"></span></div></div><div class="view-loading message text-center"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div>${PAGINATION}${gridModals(page, settings, language)}</div>`;
  const filter = model.filter?.enabled ? await renderListFilter(model, context, options) : "";
  const body = filter ? (model.filter.vertical ? `<div class="row"><div class="col-md-3 filter-vertical">${filter}</div><div class="col-md-9">${grid}</div></div>` : filter + grid) : grid;
  const js = model.list.js && (options.renderLiquid ? await options.renderLiquid(model.list.js, context) : model.list.js);
  // A list attached to a legacy ASPX page is the static EntityListControl of the WebForms master.
  const pageControl = options.args?.pp_page_control === true || options.args?.pp_page_control === "true";
  return `<div${pageControl ? ' id="EntityListControl"' : ""} class="entitylist">${body}${js ? `<script type="text/javascript">${js}</script>` : ""}</div>`;
}

/** Metadata filter panel (entity_list_filter built-in template). */
async function renderListFilter(model, context, options) {
  const groups = metaFilterGroups(model.filter.definition);
  if (!groups.length) return "";
  const selected = new URLSearchParams(String(context.request?.params?.mf ?? ""));
  const items = [];
  for (const group of groups) {
    const elementId = `${String(group.selectionMode ?? "").toLowerCase()}_${group.id}`;
    let markup = "";
    if (group.type === "textfilter")
      markup = `<li class="entitylist-filter-option"><div class="input-group entitylist-filter-option-text"><span class="input-group-addon"><span class="fa fa-filter" aria-hidden="true"></span></span><input class="form-control" type="text" name="${attr(group.id)}" value="${attr(selected.get(group.id) ?? "")}" id="${attr(group.id)}" /></div></li>`;
    else if (group.kind === "link" && group.selectionMode === "Dropdown") {
      const choices = await filterChoices(group, context, options);
      markup = `<li class="entitylist-filter-option"><div class="input-group entitylist-filter-option-text"><span class="input-group-addon"><span class="fa fa-filter" aria-hidden="true"></span></span><select class="form-control" name="${attr(group.id)}" id="${attr(elementId)}"><option value="" label=" "></option>${choices.map((choice) => `<option value="${attr(choice.id)}" label="${attr(choice.label)}"${selected.getAll(group.id).includes(choice.id) ? " selected" : ""}>${escape(choice.label)}</option>`).join("")}</select></div></li>`;
    } else {
      const choices = await filterChoices(group, context, options);
      const type = group.selectionMode === "Single" ? "radio" : "checkbox";
      markup = choices
        .slice(0, 6)
        .map((choice) => `<li class="entitylist-filter-option"><div class="${type}"><label><input type="${type}" name="${attr(group.id)}" value="${attr(choice.id)}"${selected.getAll(group.id).includes(choice.id) ? ' checked="checked" data-checked="true"' : ""} /> ${escape(choice.label)}</label></div></li>`)
        .join("");
    }
    items.push(`<li class="entitylist-filter-option-group"><label class="entitylist-filter-option-group-label h4" data-filter-id="${attr(group.id)}" for="${attr(group.type === "textfilter" ? group.id : elementId)}">${escape(group.label)}</label><ul class="list-unstyled" role="presentation" data-pagesize="6">${markup}</ul></li>`);
  }
  return `<div id="EntityList${attr(model.list.id)}" class="content-panel panel panel-default entitylist-filter"><div class="panel-body"><ul id="entitylist-filters" class="${model.filter.vertical ? " list-unstyled " : " list-inline "}">${items.join("")}</ul><div class="pull-right"><button class="btn btn-default btn-entitylist-filter-submit" data-serialized-query="mf" data-target="#EntityList${attr(model.list.id)}">${escape(model.filter.applyLabel)}</button></div></div></div>`;
}

async function filterChoices(group, context, options) {
  const node = group.node;
  if (group.kind === "link") {
    const condition = node.filters?.[0]?.conditions?.[0] ?? {};
    const viewId = condition["adx.view"];
    const labelColumn = condition["adx.labelcolumn"];
    const target = node.name;
    if (!options?.readProvider || !/^[a-z_][\w]*$/i.test(String(target ?? ""))) return [];
    const view = (options.metadata?.views ?? []).find((candidate) => candidate.id === canonicalId(viewId) && candidate.entity === canonicalId(target));
    const mapping = options.store.resolveMapping(target);
    const xml = view?.fetchXml ?? `<fetch><entity name="${attr(target)}"><attribute name="${attr(mapping.idColumn)}"/><attribute name="${attr(labelColumn || mapping.nameColumn || "name")}"/></entity></fetch>`;
    const rows = await readLookupView(contextualViewFetchXml(xml, context), options.readProvider, context.user ?? context.identity);
    return rows.map((row) => ({ id: canonicalId(row[mapping.idColumn]), label: String(row[labelColumn] ?? row[mapping.nameColumn ?? "name"] ?? row[mapping.idColumn] ?? "") })).filter((row) => row.id);
  }
  return (node.conditions ?? []).map((condition) => ({ id: String(condition["adx.id"] ?? ""), label: condition.uiname ?? condition["adx.uiname"] ?? String(condition.value ?? "") }));
}

/** Liquid entitylist object (Power Pages Liquid reference, plus adx_* attributes). */
function entityListDrop(model, options, context) {
  const websiteId = canonicalId(options.portal.website?.id);
  const pageUrl = (id) => options.portal.pages.find((candidate) => canonicalId(candidate.id) === canonicalId(id))?.url ?? null;
  const fields = options.metadata?.entities?.[model.entity]?.fields ?? {};
  const actions = actionLinks(model.settings, { portal: options.portal, requestUrl: context.request?.url ?? "http://localhost/", website: websiteId });
  const layouts = gridLayouts(model, { secureBase: { t: "list", w: websiteId, list: model.list.id }, websiteId, metadata: options.metadata, actions, language: requestLanguage(context, options.portal) });
  return {
    ...model.list.metadata,
    id: model.list.id,
    name: model.list.name,
    logical_name: "adx_entitylist",
    create_enabled: Boolean(model.createPage) || actions.some((action) => action.Type === 3),
    create_label: model.createLabel,
    create_url: pageUrl(model.createPage),
    detail_enabled: Boolean(model.detailsPage),
    detail_id_parameter: model.idParameter,
    detail_label: model.detailsLabel,
    detail_url: pageUrl(model.detailsPage),
    empty_list_text: model.emptyText,
    enable_entity_permissions: true,
    entity_logical_name: model.entity,
    filter_account_attribute_name: model.userFilters.account,
    filter_apply_label: model.filter.applyLabel,
    filter_definition: model.filter.definition,
    filter_enabled: model.filter.enabled,
    is_filter_vertical: model.filter.vertical,
    filter_portal_user_attribute_name: model.userFilters.portalUser,
    filter_website_attribute_name: model.userFilters.website,
    get_data_url: `/_services/entity-grid-data.json/${websiteId}`,
    layouts: base64Json(layouts),
    modal_form_template_url: `/_portal/modal-form-template-path/${websiteId}`,
    page_size: model.pageSize,
    primary_key_name: model.idColumn,
    search_enabled: model.search.enabled,
    search_placeholder: model.search.placeholder,
    search_tooltip: model.search.tooltip,
    default_view_id: model.views[0]?.id,
    language_code: 1033,
    views: model.views.map((view, index) => {
      const layout = layouts[index];
      return {
        id: view.id,
        name: view.displayName || view.name,
        display_name: view.displayName || view.name,
        entity_logical_name: model.entity,
        primary_key_logical_name: model.idColumn,
        language_code: 1033,
        sort_expression: layout.SortExpression,
        columns: layout.Columns.filter((column) => column.Type === 0).map((column) => ({
          logical_name: column.LogicalName,
          name: column.Name,
          width: column.Width,
          attribute_type: fields[column.LogicalName]?.dataverseType ?? null,
          sort_disabled: column.SortDisabled,
          sort_enabled: !column.SortDisabled,
          sort_ascending: `${column.LogicalName} ASC`,
          sort_descending: `${column.LogicalName} DESC`,
        })),
      };
    }),
  };
}

function findList(portal, args, name) {
  const keys = [args?.id, args?.name, args?.key, name].filter((value) => value != null && value !== "");
  for (const key of keys) {
    const list = portal.lists?.find((candidate) => canonicalId(candidate.id) === canonicalId(key) || candidate.name === key || fieldOf(candidate.metadata, "key") === key);
    if (list) return list;
  }
  return null;
}

async function renderEntityList(name, context, options) {
  const list = findList(options.portal, options.args, name);
  if (!list) return { context: {}, html: "" };
  const model = listModel({ portal: options.portal, metadata: options.metadata, store: options.store, list, schemas: options.schemas });
  if (model.approximated)
    options.diagnostic?.({
      code: "SYSTEMVIEW_UNRESOLVED",
      severity: "warning",
      component: "entitylist",
      list: list.name,
      entity: model.entity,
      message: `List '${list.name}' uses a view that is absent from the configured solutions; the local grid shows the table's primary name column.`,
    });
  const drop = entityListDrop(model, options, context);
  // The built-in "entity_list" include ({% entitylist key:key %} with the
  // include's key variable) renders the native grid; an authored
  // {% entitylist %} block only exposes the entitylist object to its body.
  const key = options.args?.key;
  const pageControl = options.args?.pp_page_control === true || options.args?.pp_page_control === "true";
  const builtin = pageControl || (key != null && options.args?.id == null && options.args?.name == null && context.key != null && String(context.key) === String(key));
  let notice = '';
  if (builtin && truthy(fieldOf(list.metadata, 'iscodecomponent'))) {
    const message = `List ${list.name} uses a configured dataset code component. Its hosted list binding is not implemented locally; the native grid below is a fallback. Use an explicit exported view/table binding with a standard Liquid code component for local dataset development.`;
    options.diagnostic?.({ code: 'PCF_NATIVE_DATASET_UNSUPPORTED', severity: 'warning', component: 'entitylist', list: list.id, message });
    notice = `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
  }
  return { context: { entitylist: drop }, html: builtin ? notice + await renderListGrid(model, context, options) : "" };
}

async function renderEntityView(name, context, options) {
  const args = options.args ?? {};
  const parentList = context.entitylist?.id ? options.portal.lists?.find((candidate) => canonicalId(candidate.id) === canonicalId(context.entitylist.id)) : null;
  let model;
  if (parentList) model = listModel({ portal: options.portal, metadata: options.metadata, store: options.store, list: parentList, schemas: options.schemas });
  else {
    const views = options.metadata?.views ?? [];
    const view = views.find((candidate) => (args.id && candidate.id === canonicalId(args.id)) || ((args.logical_name || args.logicalname) && candidate.entity === canonicalId(args.logical_name || args.logicalname) && candidate.name === args.name));
    if (!view) return { context: { entityview: null } };
    const mapping = options.store.resolveMapping(view.entity);
    model = { kind: "view", entity: view.entity, idColumn: mapping.idColumn, primaryName: mapping.nameColumn, views: [view], settings: {}, pageSize: 10, search: { enabled: true }, userFilters: {}, filter: {} };
  }
  if (args.id) model = { ...model, views: model.views.filter((view) => view.id === canonicalId(args.id)).concat(model.views.filter((view) => view.id !== canonicalId(args.id))) };
  const pageSize = Number(args.page_size ?? args.pagesize ?? model.pageSize) || 10;
  const page = Math.max(1, Number(args.page ?? 1) || 1);
  const query = await executeGridQuery(
    { ...model, pageSize },
    {
      page,
      pageSize,
      allowLargePages: true,
      search: args.search ?? "",
      sortExpression: args.order ?? "",
      filter: args.filter ?? null,
      metaFilter: args.metafilter ?? null,
      viewId: model.views[0]?.id,
    },
    {
      portal: options.portal,
      store: options.store,
      readProvider: options.readProvider,
      identity: context.user ?? context.identity,
      metadata: options.metadata,
      config: options.config,
      secure: null,
    },
  );
  const total = query.accessDenied ? 0 : Math.max(query.itemCount, 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const layout = query.layout;
  return {
    context: {
      entityview: {
        id: query.view.id,
        name: query.view.name,
        entity_logical_name: model.entity,
        primary_key_logical_name: model.idColumn,
        language_code: 1033,
        sort_expression: args.order || layout.SortExpression,
        entity_permission_denied: Boolean(query.accessDenied),
        columns: layout.Columns.filter((column) => column.Type === 0).map((column) => ({ logical_name: column.LogicalName, name: column.Name, width: column.Width, sort_disabled: column.SortDisabled, sort_enabled: !column.SortDisabled, sort_ascending: `${column.LogicalName} ASC`, sort_descending: `${column.LogicalName} DESC`, attribute_type: column.Metadata?.AttributeTypeName?.Value ?? null })),
        records: query.rows ?? [],
        page,
        page_size: pageSize,
        pages: Array.from({ length: totalPages }, (_, index) => index + 1),
        total_pages: totalPages,
        total_records: total,
        first_page: totalPages ? 1 : null,
        last_page: totalPages || null,
        previous_page: page > 1 ? page - 1 : null,
        next_page: page < totalPages ? page + 1 : null,
      },
    },
  };
}

/** Explicit schemas make local forms editable even when Dataverse systemform XML is absent. */
export async function renderComponent(kind, name, context, options) {
  // {% entityview %} inside {% entitylist %} needs no arguments: it selects the list's default view.
  if (kind === "entityview") return renderEntityView(name, context, options);
  if (name == null || name === "") return "";
  if (kind === "entitylist") return renderEntityList(name, context, options);
  if (kind !== "entityform" && kind !== "webform")
    throw componentError(`Component ${kind} '${name}' is not implemented by the local runtime.`, 501, "COMPONENT_UNSUPPORTED");
  return renderForm(kind, name, context, options);
}

function prepopulateValue(row, identity, now) {
  const type = Number(fieldOf(row, "prepopulatetype"));
  if (type === 100000000) return fieldOf(row, "prepopulatevalue");
  if (type === 100000001) return now.toISOString();
  if (type === 100000002) {
    const attribute = fieldOf(row, "prepopulatefromattribute") || "contactid";
    if (attribute === "contactid") return identity?.contactId ?? identity?.id ? { id: identity.contactId ?? identity.id, logical_name: "contact", name: identity.fullname ?? identity.name ?? "" } : undefined;
    return identity?.[attribute];
  }
  return undefined;
}

async function renderForm(kind, name, context, options) {
  const {
    portal,
    store,
    readProvider = store,
    schemas = {},
    managedControls = {},
    richTextCompatibility = false,
    renderLiquid,
    metadata,
    modal = false,
  } = options;
  // Labels and messages in the request's website language (context.__language).
  const formLanguage = requestLanguage(context, portal);
  const formLabel = (value, fallback = "") => formText(value, fallback, formLanguage);
  const pageControl = options.args?.pp_page_control === true || options.args?.pp_page_control === "true";
  const definition = (kind === "webform" ? portal.advancedForms : portal.forms)?.find(
    (item) => item.name === name || canonicalId(item.id) === canonicalId(name),
  );
  let schema = schemas[name] ?? schemas[definition?.id];
  if (!schema && kind === "entityform" && definition) schema = approximateFormSchema({ definition, portal, metadata, diagnostic: options.diagnostic });
  if (kind === "webform" && definition) schema = approximateAdvancedFormSchema({ definition, portal, metadata, schema, diagnostic: options.diagnostic });
  if (!schema && !definition) {
    // The platform's entityform/webform tags render nothing for a name that resolves to no
    // active form record (legacy Liquid EntityForm tag), and a page whose attached form is
    // missing renders without it (legacy EntityForm control): an empty region, reported.
    options.diagnostic?.({
      code: "COMPONENT_NOT_EXPORTED",
      severity: "warning",
      component: kind,
      form: name,
      message: `${kind === "webform" ? "Advanced" : "Basic"} form '${name}' is not in the export; the platform renders nothing for a form that does not resolve to an active form record.`,
    });
    return "";
  }
  if (!schema)
    throw componentError(
      `Component ${kind} '${name}' requires a form/view schema. PAC portal exports do not contain Dataverse systemform layouts. Configure componentSchemas in the admin settings.`,
      501,
      "COMPONENT_SCHEMA_REQUIRED",
    );
  if (schema.formXml)
    schema = { ...schema, ...schemaFromFormXml(schema.formXml, { ...schema, entity: schema.entity ?? definition?.entityName }) };
  const identity = context.user ?? context.identity;
  const params = context.request?.params ?? {};
  let progress = "";
  let stepIndex = 0;
  let stepList = [];
  let advancedSteps = null;
  let session = null;
  if (kind === "webform" && schema.steps) {
    const startNew = truthy(fieldOf(definition?.metadata ?? {}, "startnewsessiononload"));
    // The runtime's sessions and the request's owner: the signed-in contact or browser visitor.
    const sessions = options.webFormSessions;
    const owner = options.webFormOwner ? options.webFormOwner() : webFormSessionOwner(identity);
    const access = await advancedFormAccess({
      definition: definition ?? { id: name, metadata: {} },
      identity,
      owner,
      sessions,
      initialStepId: schema.initialStepId,
      readRecord: (entity, id) => readProvider.get(entity, id, identity),
      language: formLanguage,
    });
    if (access?.signIn) {
      // Authentication Required: the page sends an anonymous visitor to sign in and back.
      const route = deniedPageRoute(portal, new URL(context.request?.url ?? "http://localhost/"), identity, { code: access.code });
      context.__diagnostics?.push({
        code: "ADVANCEDFORM_SIGN_IN_REQUIRED",
        severity: "info",
        form: definition?.name ?? name,
        redirect: route.location,
        message: `Advanced form '${definition?.name ?? name}' requires authentication; an anonymous visitor is sent to sign in.`,
      });
      return `<script>location.replace(${json(route.location)});</script>`;
    }
    if (access?.message) return `<div id="MessagePanel" class="message alert alert-info" role="alert"><span id="MessageLabel">${escape(access.message)}</span></div>`;
    session = access?.session ?? webFormSession({ webformId: definition?.id ?? name, owner, sessionId: params.sessionid, startNew, sessions });
    // Platform step URLs carry stepid (and sessionid); portal code builds links with them, so a
    // stepid parameter opens that step directly. Without one the session's step renders.
    const stepId = params.stepid ?? (!startNew ? session?.current : null) ?? schema.initialStepId;
    let selected = schema.steps.find((step) => canonicalId(step.stepId) === canonicalId(stepId));
    if (!selected) {
      selected =
        schema.steps.find((step) => canonicalId(step.stepId) === canonicalId(schema.initialStepId) && step.type !== "redirect" && step.type !== "condition") ??
        schema.steps.find((step) => step.type !== "redirect" && step.type !== "condition");
      if (!selected) throw componentError(`Advanced form '${definition?.name ?? name}' has no renderable step in the selected metadata or export`, 501, "ADVANCEDFORM_STEP_UNRESOLVED");
      options.diagnostic?.({ code: "ADVANCEDFORM_STEP_UNRESOLVED", severity: "warning", component: "webform", form: definition?.name ?? name, step: stepId ?? null, rendered: selected.stepId, message: `Advanced form step '${stepId}' of '${definition?.name ?? name}' is absent from the selected metadata and the export; the step '${selected.stepId}' is rendered instead.` });
    }
    const visited = new Set();
    let current = schema.steps.find((step) => canonicalId(step.stepId) === canonicalId(schema.initialStepId));
    while (current && !visited.has(current.stepId)) {
      visited.add(current.stepId);
      if (current.type !== "redirect" && current.type !== "condition") stepList.push(current);
      current = schema.steps.find((step) => canonicalId(step.stepId) === canonicalId(current.nextStepId));
    }
    stepIndex = stepList.findIndex((step) => step.stepId === selected.stepId);
    const form = definition?.metadata ?? {};
    if (truthy(fieldOf(form, "progressindicatorenabled"))) {
      const type = Number(fieldOf(form, "progressindicatortype") ?? 756150000);
      const position = { 756150001: "bottom", 756150002: "left", 756150003: "right" }[Number(fieldOf(form, "progressindicatorposition"))] ?? "top";
      const ignoreLast = truthy(fieldOf(form, "progressindicatorignorelaststep"));
      const counted = ignoreLast ? stepList.slice(0, -1) : stepList;
      const prepend = truthy(fieldOf(form, "progressindicatorprependstepnum"));
      const title = (step) => escape(formLabel(fieldOf(step.metadata ?? {}, "title"), fieldOf(step.metadata ?? {}, "name") ?? step.title ?? "Step"));
      let indicator;
      if (type === 756150001)
        indicator = `<div class="progress-numeric">Step <span class="number">${stepIndex + 1}</span> of <span class="number total">${counted.length}</span></div>`;
      else if (type === 756150002) {
        const percent = counted.length ? Math.round((Math.max(stepIndex, 0) / counted.length) * 100) : 0;
        indicator = `<div class="progress"><div class="bar progress-bar${percent ? "" : " zero"}" style="width: ${percent}%;" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">${percent}%</div></div>`;
      } else
        indicator = `<ol class="progress list-group ${position}">${counted
          .map((step, index) =>
            index < stepIndex
              ? `<li class="list-group-item text-muted list-group-item-success complete">${prepend ? `<span class="number">${index + 1}</span>` : ""}${title(step)}<span class="glyphicon glyphicon-ok"></span></li>`
              : `<li class="list-group-item ${index === stepIndex ? "active" : "incomplete"}">${prepend ? `<span class="number">${index + 1}</span>` : ""}${title(step)}</li>`,
          )
          .join("")}</ol>`;
      const column = position === "left" ? ' class=" col-sm-3 col-md-2"' : position === "right" ? ' class=" col-sm-3 col-sm-push-9 col-md-2 col-md-push-10"' : "";
      progress = { html: `<div id="${pageControl ? "WebFormControl" : `WebFormControl_${compactId(definition?.id ?? name)}`}_ProgressIndicator"${column}>${indicator}</div>`, position };
    }
    advancedSteps = schema.steps;
    schema = selected;
  }
  if (schema.type === "redirect") {
    const target = new URL(schema.redirectUrl, context.request?.url ?? "http://localhost/");
    if (schema.appendRecordId) {
      const id = params.id;
      if (!id) throw componentError("Redirect step requires the saved record identifier", 400, "ADVANCEDFORM_RECORD_REQUIRED");
      appendRedirectRecordId(target, schema.recordQueryName, id);
    }
    if (target.origin !== new URL(context.request?.url ?? "http://localhost/").origin)
      throw componentError("Advanced form redirect requires a local exported target", 501);
    return `<script>location.replace(${json(target.pathname + target.search + target.hash)});</script>`;
  }
  if (!schema.entity) throw componentError(`Component ${name} has no mapped table`, 501, "COMPONENT_ENTITY_REQUIRED");
  const mapping = store.resolveMapping(schema.entity);
  const componentMetadata = schema.metadata ?? definition?.metadata ?? {};
  const metadataRows = formMetadataRows(portal, kind === "webform" ? null : definition, schema.stepId);
  const websiteId = canonicalId(portal.website?.id);
  const N = compactId(definition?.id ?? name);
  // Controls attached to a legacy ASPX page are the static WebFormControl / EntityFormControl
  // of the WebForms master's EntityControls placeholder.
  const pageControlPrefix = "ctl00$ContentContainer$MainContent$EntityControls$";
  const ids =
    kind === "webform"
      ? pageControl
        ? { wrapper: "WebFormControl", panel: "WebFormPanel", view: "EntityFormView", names: `${pageControlPrefix}WebFormControl$EntityFormView$`, buttons: `${pageControlPrefix}WebFormControl$` }
        : { wrapper: `WebFormControl_${N}`, panel: "WebFormPanel", view: "EntityFormView", names: `ctl00$ContentContainer$WebFormControl_${N}$EntityFormView$`, buttons: `ctl00$ContentContainer$WebFormControl_${N}$` }
      : modal || pageControl
        ? { wrapper: "EntityFormControl", panel: "EntityFormPanel", view: "EntityFormControl_EntityFormView", names: `${pageControl ? pageControlPrefix : "ctl00$ContentContainer$MainContent$"}EntityFormControl$EntityFormControl_EntityFormView$`, buttons: `${pageControl ? pageControlPrefix : "ctl00$ContentContainer$MainContent$"}EntityFormControl$` }
        : { wrapper: `EntityFormControl_${N}`, panel: "EntityFormPanel", view: `EntityFormControl_${N}_EntityFormView`, names: `ctl00$ContentContainer$EntityFormControl_${N}$EntityFormControl_${N}_EntityFormView$`, buttons: `ctl00$ContentContainer$EntityFormControl_${N}$` };

  // Record source.
  const source = await resolveFormRecord({ kind, definition, schema, metadata, context, readProvider, store, identity, modal, session });
  let mode = source.mode;
  const id = mode === FORM_MODE.insert ? null : source.id;
  let record = {};
  let notFound = null;
  let accessDenied = false;
  if (mode !== FORM_MODE.insert) {
    if (!id) notFound = formLabel(fieldOf(componentMetadata, "recordnotfoundmessage"), "The record you are looking for couldn't be found.");
    else {
      try {
        record = (await readProvider.get(schema.entity, id, identity)) ?? null;
        if (!record) notFound = `Entity '${schema.entity}' With Id = ${canonicalId(id)} Does Not Exist`;
      } catch (error) {
        // A local table-permission denial is the native in-form message; a live
        // bridge failure stays an explicit page error rather than a form state.
        if (error.status !== 403 || error.code === "LIVE_BRIDGE") throw error;
        accessDenied = true;
        record = null;
      }
    }
  }
  // The legacy EntityForm and WebForm controls add the form's (or step's) startup script before
  // they read the record, so a form whose record is missing or unreadable still runs it,
  // ahead of the message.
  const startupScript = async () => {
    const source = schema.js ?? definition?.js;
    const rendered = source && (renderLiquid ? await renderLiquid(source, context) : source);
    return rendered ? `<span><script type="text/javascript">${rendered}</script></span>` : "";
  };
  if (accessDenied) {
    // crmentityformview: the EntitySecurity/Record/ReadAccessDeniedMessage
    // snippet, by default the Access_Denied_Error resource behind a lock icon.
    const snippet = portal.snippets?.["EntitySecurity/Record/ReadAccessDeniedMessage"];
    const message =
      typeof snippet === "string"
        ? renderLiquid
          ? await renderLiquid(snippet, context)
          : snippet
        : "<div class='alert alert-block alert-danger'><span class='fa fa-lock' aria-hidden='true'></span>You don't have the appropriate permissions.</div>";
    return `<div id="${attr(ids.wrapper)}">${await startupScript()}${message}</div>`;
  }
  if (notFound)
    return `<div id="${attr(ids.wrapper)}">${await startupScript()}<div id="MessagePanel" class="message alert error alert alert-danger error alert alert-danger" role="alert"><span id="MessageLabel">${escape(notFound)}</span></div></div>`;
  // Edit becomes read-only for inactive records or without write permission.
  if (mode === FORM_MODE.edit) {
    const state = scalarValue(record?.statecode);
    const writable = !store.allowed || store.allowed(mapping.logicalName, "update", record, identity);
    if ((state != null && Number(state) !== 0) || !writable) mode = FORM_MODE.readOnly;
  }
  const readOnly = mode === FORM_MODE.readOnly;
  const linksEnabled = fieldOf(componentMetadata, "validationsummarylinksenabled") !== false;
  const forceRequired = truthy(fieldOf(componentMetadata, "forceallfieldsrequired"));
  const recommendedRequired = truthy(fieldOf(componentMetadata, "recommendedfieldsrequired"));
  const now = new Date();
  // Labels follow the platform: metadata override, the form cell label, then the
  // column display name; the logical name is used only when the table metadata is absent.
  const tableFields = metadata?.entities?.[canonicalId(schema.entity)]?.fields ?? {};
  const fields = (schema.fields ?? []).map((field) => {
    const row = metadataFor(metadataRows, 100000000, (candidate) => fieldOf(candidate, "attributelogicalname") === field.name);
    const immutable = mode === FORM_MODE.insert ? field.validForCreate === false : field.validForUpdate === false;
    const control = nativeControlKind(field);
    const label = formLabel(fieldOf(row, "label"), field.label || tableFields[field.name]?.label || field.name);
    const ownerHidden = field.name === "ownerid" && fieldOf(componentMetadata, "showownerfields") !== true;
    const style = Number(fieldOf(row, "controlstyle"));
    const description = row && truthy(fieldOf(row, "adddescription"))
      ? { text: truthy(fieldOf(row, "useattributedescriptionproperty")) && !fieldOf(row, "description") ? field.description ?? "" : formLabel(fieldOf(row, "description"), ""), position: Number(fieldOf(row, "descriptionposition")) }
      : null;
    return {
      ...field,
      id: field.name,
      control,
      label,
      ownerHidden,
      hidden: field.hidden || ownerHidden,
      // Field-level read-only (the EntityForm cell Metadata.ReadOnly). A read-only form also
      // marks every control (MakeControlsReadonly) without this field-level markup.
      fieldReadOnly: Boolean(field.readOnly || immutable || /^(state|status)$/.test(control) || (field.name === "ownerid")),
      readOnly: Boolean(field.readOnly || immutable || readOnly || /^(state|status)$/.test(control) || (field.name === "ownerid")),
      required: Boolean(
        truthy(fieldOf(row, "fieldisrequired")) ||
          forceRequired ||
          field.required ||
          (recommendedRequired && /recommended/i.test(field.requiredLevel ?? "")),
      ),
      requiredMessage: formLabel(fieldOf(row, "requiredfieldvalidationerrormessage"), ""),
      pattern: fieldOf(row, "validationregularexpression") || field.pattern || null,
      patternMessage: formLabel(fieldOf(row, "validationregularexpressionerrormessage"), ""),
      validationMessage: formLabel(fieldOf(row, "validationerrormessage"), ""),
      rangeMessage: formLabel(fieldOf(row, "rangevalidationerrormessage"), ""),
      cssClass: fieldOf(row, "cssclass") ?? "",
      controlStyle: Number.isFinite(style) ? style : null,
      lookupStyle: style === 756150000 ? "dropdown" : field.lookupStyle,
      ignoreDefault: truthy(fieldOf(row, "ignoredefaultvalue")),
      randomize: truthy(fieldOf(row, "randomizeoptionsetvalues")),
      prepopulate: row && fieldOf(row, "prepopulatetype") != null ? prepopulateValue(row, identity, now) : undefined,
      description,
      createFormId: canonicalId(fieldOf(row, "entityformforcreate")),
      minimum: field.minimum ?? field.minValue,
      maximum: field.maximum ?? field.maxValue,
    };
  });
  const byName = new Map(fields.map((field) => [field.name, field]));
  // Native "reference entity" query parameters prefill the referencing lookup.
  const reference = mode === FORM_MODE.insert && params.refentity && params.refid && params.refrel ? { entity: params.refentity, id: params.refid, rel: params.refrel } : null;
  const value = (field) => {
    if (record && Object.hasOwn(record, field.name) && record[field.name] !== undefined && record[field.name] !== null && mode !== FORM_MODE.insert) return record[field.name];
    if (mode === FORM_MODE.insert) {
      if (field.prepopulate !== undefined) return field.prepopulate;
      if (reference && field.control === "lookup") {
        const candidates = Object.values(mapping.relationships ?? {}).filter((candidate) => candidate.many === false && candidate.from === field.name && candidate.entity === canonicalId(reference.entity));
        const relation = candidates.find((candidate) => candidate.schemaName === reference.rel) ?? (candidates.length === 1 && referenceField(fields, mapping, reference) === field.name ? candidates[0] : null);
        if (relation) return { id: canonicalId(reference.id), logical_name: relation.entity, name: "" };
      }
      if (!field.ignoreDefault && field.default !== undefined) return field.default;
    }
    return record?.[field.name] ?? null;
  };
  // Lookup choices for dropdown lookups and bindings for every lookup.
  for (const field of fields.filter((candidate) => candidate.control === "lookup")) {
    const targets = field.lookupTargets ?? [
      ...new Set(
        Object.values(mapping.relationships ?? {})
          .filter((relation) => relation.many === false && relation.from === field.name)
          .map((relation) => relation.entity),
      ),
    ];
    field.targets = targets;
    field.bindings = {};
    field.choices = [];
    // Read-only lookups display the form record's own value; they neither
    // bind nor query target tables the persona may not read.
    if (field.readOnly) continue;
    for (const entity of targets) {
      const relationship = Object.entries(mapping.relationships ?? {}).find(([, relation]) => relation.many === false && relation.from === field.name && relation.entity === entity);
      if (relationship) field.bindings[entity] = { navigation: relationship[0], entitySet: store.resolveMapping(entity).entitySet };
    }
    if (field.lookupStyle === "dropdown" && !field.hidden)
      for (const entity of targets) {
        const targetMapping = store.resolveMapping(entity);
        const view = field.lookupView?.entity === entity ? field.lookupView : null;
        let rows;
        try {
          rows = view?.fetchXml
            ? await readLookupView(contextualViewFetchXml(view.fetchXml, context), readProvider, identity)
            : (await readProvider.query(entity, { $top: 5000 }, identity)).value;
        } catch (error) {
          if (Number(error?.status ?? error?.statusCode) !== 403) throw error;
          // The platform renders the dropdown without choices for a table the user cannot read.
          rows = [];
          options.diagnostic?.({ code: "LOOKUP_CHOICES_DENIED", severity: "warning", component: kind, form: definition?.name ?? name, field: field.name, entity, message: `Dropdown lookup '${field.name}' renders without choices: the current identity cannot read table ${entity} (${error.message}).` });
        }
        for (const row of rows)
          field.choices.push({ id: canonicalId(row[targetMapping.idColumn]), entity, label: row[view?.fields?.[0]?.name] ?? row[targetMapping.nameColumn ?? "name"] ?? row.name ?? row[targetMapping.idColumn] });
      }
  }
  const validators = [];
  const nameAttr = (field, suffix = "") => attr(`${ids.names}${field.name}${suffix}`);
  const optionsFor = (field) => {
    const options = [...(field.options ?? [])];
    // adx_randomizeoptionsetvalues: native shuffles the options on each render.
    if (field.randomize)
      for (let index = options.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [options[index], options[swap]] = [options[swap], options[index]];
      }
    return options;
  };
  const nativeInput = async (field) => {
    const current = value(field);
    const scalar = scalarValue(current);
    const disabled = field.readOnly;
    // CrmEntityFormView.MakeControlsReadonly: a read-only form adds readonly="readonly" to every
    // web control and disables list controls, which ASP.NET renders with the aspNetDisabled
    // class. Field-level read-only keeps its own markup (class "readonly", aria-disabled).
    const fieldLevel = field.fieldReadOnly ?? field.readOnly;
    const formLevel = readOnly && !fieldLevel;
    const formReadonly = readOnly ? ' readonly="readonly"' : "";
    const emptyOption = (selected) => `<option${selected ? ' selected="selected"' : ""} value="" label="Select" aria-label="Select"></option>`;
    const css = field.cssClass ? ` ${attr(field.cssClass)}` : " ";
    const required = field.required && !disabled ? ' aria-required="true"' : "";
    switch (field.control) {
      case "lookup": {
        const name = current?.name ?? "";
        const logical = current?.logical_name ?? (field.targets?.length === 1 ? field.targets[0] : "");
        const idValue = canonicalId(scalar);
        if (field.hidden)
          return `<input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}" value="${attr(idValue)}"><input name="${nameAttr(field, "_name")}" type="hidden" id="${attr(field.id)}_name" value="${attr(name)}"><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname" value="${attr(logical)}">`;
        if (field.lookupStyle === "dropdown") {
          const choices = field.choices.some((choice) => choice.id === idValue) || !idValue ? field.choices : [{ id: idValue, entity: logical, label: name }, ...field.choices];
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="lookup form-control${css}" onchange="setIsDirty(this.id);"${field.required ? ' required=""' : ""}${disabled ? ' disabled="disabled" aria-disabled="true"' : ""}${formReadonly}>${emptyOption(false)}${choices.map((choice) => `<option value="${attr(choice.id)}"${choice.id === idValue ? ' selected="selected"' : ""}>${escape(choice.label)}</option>`).join("")}</select>`;
        }
        if (disabled)
          return `<div><input name="${nameAttr(field, "_name")}" type="text" value="${attr(name)}" id="${attr(field.id)}_name" class="text form-control lookup form-control  readonly" readonly="${readOnly ? "readonly" : ""}" aria-readonly="true" aria-labelledby="${attr(field.id)}_label" aria-label="${attr(field.label)}" tabindex="0"><input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}" value="${attr(idValue)}"><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname" value="${attr(logical)}"></div>`;
        const lookupBase = { kind: "lookup", views: [], settings: {}, pageSize: Number(portal.settings?.["Portal/Lookup/Modal/Grid/PageSize"]) || 10, search: { enabled: true, placeholder: "Search", tooltip: "To search on partial text, use the asterisk (*) wildcard character." } };
        let layouts = [];
        try {
          const model = nativeLookupModel({ portal, schemas, metadata, store, kind, formId: definition?.id, stepId: schema.stepId, field: field.name });
          layouts = model.views.map((view) => {
            const targetMapping = store.resolveMapping(view.entity);
            const viewModel = { ...lookupBase, entity: canonicalId(view.entity), idColumn: targetMapping.idColumn, primaryName: targetMapping.nameColumn ?? null, views: [view] };
            return buildLayout({
              view,
              entity: canonicalId(view.entity),
              idColumn: targetMapping.idColumn,
              primaryName: targetMapping.nameColumn ?? null,
              metadata,
              settings: {},
              configuration: viewConfiguration(viewModel, view, { actions: [], websiteId, language: formLanguage }),
              secure: { t: "lookup", w: websiteId, kind, form: definition?.id, step: schema.stepId ?? null, field: field.name, view: view.id },
              selectColumn: true,
            });
          });
        } catch (error) {
          if (!/LOOKUP_TARGET_UNRESOLVED|LookupNotBound|FormNotFound|FormSchemaRequired/.test(error.code ?? "")) throw error;
        }
        const createForm = field.createFormId && portal.forms?.some((form) => canonicalId(form.id) === field.createFormId) ? field.createFormId : "";
        return `<div class="input-group" role="none"><input name="${nameAttr(field, "_name")}" type="text" id="${attr(field.id)}_name" class="text form-control lookup form-control${css}" readonly="" aria-readonly="true" aria-labelledby="${attr(field.id)}_label" aria-label="${attr(field.label)}" value="${attr(name)}"><input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}" value="${attr(idValue)}"${required}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname" value="${attr(logical)}"><div class="input-group-btn"><button type="button" class="btn btn-default clearlookupfield" title="${attr(field.label)} Clear lookup field" aria-label="${attr(field.label)} Clear lookup field"${idValue ? "" : ' style="display: none;"'}><span class="sr-only">Clear lookup field</span><span class="fa fa-times" aria-hidden="true"></span></button><button type="button" class="btn btn-default launchentitylookup" data-toggle="tooltip" title="${attr(field.label)} Launch lookup modal" aria-label="${attr(field.label)} Launch lookup modal"><span class="sr-only">Launch lookup modal</span><span class="fa fa-search" aria-hidden="true"></span></button></div></div><div id="${attr(field.id)}_lookupmodal" class="lookup-modal"><div class="entity-lookup" data-languagecode="1033" data-lookup-datafieldname="${attr(field.id)}" data-lookup-reference_entityformid="${attr(createForm)}" data-url="/_services/entity-lookup-grid-data.json/${websiteId}">${nativeModal({
          className: "modal-lookup",
          title: "Lookup records",
          label: "Lookup records Dialog",
          size: "modal-lg",
          body: `<div aria-hidden="true" class="modal-error message" style="display:none"><div class="alert alert-block alert-danger"><p>We're sorry, an error has occurred.</p></div></div><div class="entity-grid" data-allow-filter-off="false" data-apply-related-record-filter="false" data-column-width-style="Percent" data-defer-loading="true" data-enable-actions="false" data-filter-attribute-name="" data-filter-entity-name="" data-filter-relationship-name="" data-get-url="/_services/entity-lookup-grid-data.json/${websiteId}" data-grid-class="" data-mobile-view-enabled="true" data-select-mode="Single" data-selected-view="${attr(layouts[0]?.Id ?? "")}" data-toggle-filter-text="Toggle filter" data-user-isauthenticated="${Boolean(identity?.contactId ?? identity?.id)}" data-view-layouts="${base64Json(layouts)}"><div role="alert" aria-live="assertive" aria-atomic="true" aria-relevant="additions text" id="SearchCountText${attr(field.id)}" class="sr-only"></div><div class="view-grid"></div>${LOOKUP_GRID_MESSAGES}${PAGINATION}</div>`,
          footer: `${createForm ? '<button type="button" class="btn btn-default pull-left new-value" title="New">New</button>' : ""}<button aria-label="Select" class="primary btn btn-primary" tabindex="0" title="Select" type="button">Select</button><button aria-label="Cancel" class="cancel btn btn-default" data-dismiss="modal" tabindex="0" title="Cancel" type="button">Cancel</button><button class="btn btn-default pull-right remove-value" title="Remove value" type="button">Remove value</button>`,
        })}${createForm ? nativeModal({ className: "modal-form modal-form-insert modal-lookup-create-form", title: "<span class='fa fa-pencil-square-o' aria-hidden='true'></span> Create", body: formModalBody(`/_portal/modal-form-template-path/${websiteId}`), size: "modal-lg", label: "Create" }) : ""}</div></div>`;
      }
      case "boolean": {
        const bool = scalar === true || scalar === 1 || /^(true|1)$/i.test(String(scalar ?? ""));
        const options = field.options?.length ? field.options : [{ value: 0, label: "No" }, { value: 1, label: "Yes" }];
        const label = (bit) => options.find((option) => Number(option.value) === bit)?.label ?? (bit ? "Yes" : "No");
        const classId = canonicalId(field.controlClassId);
        if (classId === DROPDOWN_CLASS) {
          const blank = field.ignoreDefault && scalar == null;
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${readOnly ? "aspNetDisabled " : ""}form-control boolean-dropdown${css}" onchange="setIsDirty(this.id);"${fieldLevel ? ' disabled="disabled" aria-disabled="true"' : formLevel ? ' disabled="disabled"' : ""}${formReadonly}>${field.ignoreDefault ? `<option value=""${blank ? ' selected="selected"' : ""}></option>` : ""}<option${!blank && !bool ? ' selected="selected"' : ""} value="0">${escape(label(0))}</option><option${!blank && bool ? ' selected="selected"' : ""} value="1">${escape(label(1))}</option></select>`;
        }
        if (classId === RADIO_CLASS)
          return `<span id="${attr(field.id)}" class="boolean-radio${css}" onchange="setIsDirty(this.id);"${field.required ? ' data-required="true"' : ""}>${[0, 1].map((bit) => `<input id="${attr(field.id)}_${bit}" type="radio" name="${nameAttr(field)}" value="${bit}"${scalar != null && !field.ignoreDefault && bool === Boolean(bit) ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><label for="${attr(field.id)}_${bit}"><span class='sr-only'>${escape(field.label)} </span>${escape(label(bit))}</label>`).join("")}</span>`;
        return `<span class="checkbox${css}"><input id="${attr(field.id)}" type="checkbox" name="${nameAttr(field)}"${bool ? ' checked="checked"' : ""} onclick="setIsDirty(this.id);"${disabled ? ' disabled="disabled"' : ""}></span>`;
      }
      case "picklist": {
        const options = optionsFor(field);
        const selected = scalar == null || scalar === "" ? null : Number(scalar);
        if (field.controlStyle === 100000000 || field.controlStyle === 100000001)
          return `<span id="${attr(field.id)}" class="picklist ${field.controlStyle === 100000000 ? "vertical" : "horizontal"}${css}" role="presentation" onchange="setIsDirty(this.id);"${field.required ? ' data-required="true"' : ""}>${options.map((option, index) => `<input id="${attr(field.id)}_${index}" type="radio" name="${nameAttr(field)}" value="${attr(option.value)}"${Number(option.value) === selected ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><label for="${attr(field.id)}_${index}"><span class='sr-only'>${escape(field.label)} </span>${escape(option.label ?? option.value)}</label>${field.controlStyle === 100000000 ? "<br>" : ""}`).join("")}</span>`;
        // PicklistControlTemplate: every option follows an empty "Select" option; a required
        // dropdown carries required="" (the platform app bundle removes it on load).
        const picklistOptions = `${emptyOption(selected == null)}${options.map((option) => `<option${Number(option.value) === selected ? ' selected="selected"' : ""} value="${attr(option.value)}">${escape(option.label ?? option.value)}</option>`).join("")}`;
        if (fieldLevel)
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${readOnly ? "aspNetDisabled " : ""}readonly form-control picklist${css}" onchange="setIsDirty(this.id);" disabled="disabled" aria-disabled="true"${formReadonly}>${picklistOptions}</select><input type="hidden" name="${nameAttr(field, "_Value")}" id="${attr(field.id)}_Value" value="${attr(selected ?? "")}">`;
        if (formLevel)
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="aspNetDisabled form-control picklist${css}" onchange="setIsDirty(this.id);" disabled="disabled"${formReadonly}>${picklistOptions}</select>`;
        return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="form-control picklist${css}" onchange="setIsDirty(this.id);"${field.required ? ' required=""' : ""}>${picklistOptions}</select>`;
      }
      case "state":
      case "status": {
        const option = (field.options ?? []).find((candidate) => Number(candidate.value) === Number(scalar));
        return `<span id="${attr(field.id)}" class="${field.control}${css}">${escape(current?.label ?? option?.label ?? scalar ?? "")}</span>`;
      }
      case "multiselect": {
        const values = String(Array.isArray(current) ? current.map(scalarValue).join(",") : scalar ?? "").split(",").filter(Boolean);
        const options = optionsFor(field);
        const optionsHtml = options
          .map((option, index) => `<li class="msos-option" role="option"><label name="${attr(field.id)}msos-label" class="msos-label" title="${attr(option.label)}"><input type="checkbox" id="${attr(field.id)}_item${index + 1}" class="msos-checkbox" name="character" tabindex="-1" aria-label="${attr(option.label)}" value="${attr(option.value)}"${values.includes(String(option.value)) ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><div class="msos-label-text msos-optionitem-text" aria-hidden="true">${escape(option.label)}</div></label></li>`)
          .join("");
        return `<div id="PcfControl_${attr(compactId(field.id + N).slice(0, 32))}" onchange="setIsDirty(this.id);"><span id="${attr(field.id)}_Container" class="flexbox"><div id="${attr(field.id)}_ControlView" class="flexbox"><div id="${attr(field.id)}_i" class="msos-container ${values.length ? "msos-some-selected" : "msos-none-selected"}" data-paqvilo-mirage-multiselect="${attr(field.id)}"><div class="msos-selecteditems-container" tabindex="0"><ul class="msos-selecteditems msos-current-selection-normal" tabindex="-1">${values.map((v) => `<li class="msos-selected-display-item" data-value="${attr(v)}">${escape(options.find((option) => String(option.value) === v)?.label ?? v)}</li>`).join("")}</ul></div><div class="msos-inner-container" role="combobox" aria-haspopup="true" aria-expanded="false" aria-label="${attr(field.label)}"><div class="msos-filter-container"><div class="msos-input-container"><input id="${attr(field.id)}_ledit" type="text" class="msos-input" placeholder="Search"${disabled ? ' disabled="disabled"' : ""}></div><div class="msos-caret-container"><button class="msos-caret-button" tabindex="-1" aria-label="Toggle menu" type="button"${disabled ? ' disabled="disabled"' : ""}><span class="msos-glyph"></span></button></div></div><div class="msos-selection-container" hidden><div class="msos-action-buttons"><label name="${attr(field.id)}msos-label" class="msos-label msos-selectall msos-option"><input type="checkbox" class="msos-checkbox" id="${attr(field.id)}_selectAll" tabindex="-1" aria-label="Select all"${disabled ? ' disabled="disabled"' : ""}><div class="msos-label-text" aria-hidden="true"><div class="msos-optionitem-text">Select all</div><div id="${attr(field.id)}msos-no-of-Items" class="msos-itemcount-text">${options.length} items</div></div></label></div><div id="${attr(field.id)}_no-results" class="msos-no-results msos-hidden">No results found</div><ul class="msos-selected-items msos-selection" role="listbox" tabindex="-1" aria-multiselectable="true" aria-labelledby="${attr(field.id)}msos-no-of-Items">${optionsHtml}</ul></div></div><select id="${attr(field.id)}_0" multiple="multiple" style="display: none;">${options.map((option) => `<option value="${attr(option.value)}"${values.includes(String(option.value)) ? " selected" : ""}>${escape(option.label)}</option>`).join("")}</select></div></div></span></div><input type="hidden" name="${nameAttr(field)}" id="${attr(field.id)}" value="${attr(values.join(","))}">`;
      }
      case "datetime": {
        const dateOnly = /dateonly/i.test(field.behavior ?? field.format ?? "") || field.type === "date" || String(field.dataverseType).toLowerCase() === "datetime" && field.format !== "datetime";
        const format = datePickerFormat(portal.settings?.[dateOnly ? "DateTime/DateFormat" : "DateTime/DateTimeFormat"], dateOnly);
        const behavior = field.dateTimeBehavior ?? field.behavior ?? (dateOnly ? "DateOnly" : "UserLocal");
        const iso = scalar ? String(scalar) : "";
        // crmentityformview-datetime.js: a read-only picker keeps its visible box without the
        // input group, the placeholder or the (hidden) calendar button, whose title and label
        // are the Datetimepicker_Datepicker_Label resource.
        return `<input name="${nameAttr(field)}" type="text" id="${attr(field.id)}" class="datetime form-control${css}" data-ui="datetimepicker" data-type="${dateOnly ? "date" : "datetime"}" data-attribute="${attr(field.id)}" data-behavior="${attr(behavior)}" value="${attr(iso)}" style="display: none;"${disabled ? ' readonly="readonly"' : ""}${field.required && !disabled ? ' required=""' : ""} data-sim-date-value><div class="${disabled ? "datetimepicker" : "input-append input-group datetimepicker"}" role="none" data-sim-date-target="${attr(field.id)}" data-sim-date-only="${dateOnly}"><input type="text" data-date-format="${attr(format)}" aria-describedby="${attr(field.id)}_description" id="${attr(field.id)}_datepicker_description" aria-labelledby="${attr(field.id)}_label" onchange="setIsDirty(this.id);" class="form-control input-text-box${disabled ? " readonly" : ""}"${disabled ? ' readonly="readonly"' : ` placeholder="${attr(format)}"`}${field.required && !disabled ? " required" : ""}><span class="input-group-addon" tabindex="0" role="button" title="Choose a date" aria-label="Choose a date"${disabled ? ' style="display: none;"' : ""}><span data-date-icon="icon-calendar fa fa-calendar" data-time-icon="icon-time fa fa-clock-o" class="icon-calendar fa fa-calendar iconBorder"></span></span></div>`;
      }
      case "richtext":
        return richTextInput(field, current, { portal, managedControls, nameAttr });
      case "textarea":
        // MemoControlTemplate: rows = rowspan * 3 - 2; a maximum length adds the platform's
        // LimitInput/LimitPaste handlers (crmentityformview.js).
        return `<textarea name="${nameAttr(field)}" rows="${(Number(field.rowspan) || 2) * 3 - 2}" cols="20"${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ""} id="${attr(field.id)}" class="textarea form-control${css}${fieldLevel ? " readonly" : ""}" onchange="setIsDirty(this.id);"${disabled ? ' readonly="readonly"' : ""}${required} aria-label="${attr(field.label)}"${field.maxLength ? ' onkeydown="javascript:return LimitInput(this, event);" oninput="javascript:return LimitInput(this, event);" onpaste="javascript:return LimitPaste(this, event);"' : ""}>${escape(scalar ?? "")}</textarea>`;
      case "integer":
      case "decimal":
      case "double":
      case "money": {
        const control = `<input name="${nameAttr(field)}" type="text" id="${attr(field.id)}" class="text ${field.control} form-control${css}${fieldLevel ? " readonly" : ""}" onchange="setIsDirty(this.id);" value="${attr(scalar ?? "")}"${disabled ? ' readonly="readonly"' : ""}${field.required && !disabled ? ' required=""' : ""}>`;
        return field.control === "money" ? `<div class="input-group">${control}</div>` : control;
      }
      default:
        if (field.hidden && field.control !== "lookup")
          return `<input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}" value="${attr(scalar ?? "")}">`;
        {
          // String text boxes: e-mail format adds type="email" and the launchEmail handler,
          // phone format the platform placeholder, a maximum length the LengthError keypress
          // check, and a required editable box the required-field title and its label.
          const email = field.control === "email";
          const phone = String(field.format ?? "").toLowerCase() === "phone";
          const requiredText = field.required && !disabled ? ` aria-required="true" title="${attr(field.requiredMessage || `${field.label} is a required field.`)}" aria-label="${attr(field.label)}"` : "";
          return `<input name="${nameAttr(field)}" type="${email ? "email" : "text"}"${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ""} id="${attr(field.id)}" class="text form-control${css}${fieldLevel ? " readonly" : ""}"${email ? ' ondblclick="launchEmail(this.value);"' : ""} onchange="setIsDirty(this.id);" value="${attr(scalar ?? "")}"${phone ? ' placeholder="Provide a telephone number"' : ""}${disabled ? ' readonly="readonly"' : ""}${requiredText}${field.pattern && !disabled ? ` pattern="${attr(field.pattern)}"` : ""}${field.maxLength ? ' onkeypress="javascript:return LengthError(this, event);"' : ""}>`;
        }
    }
  };

  const input = async (field) => {
    const original = await nativeInput(field);
    // The portal's attribute metadata explicitly enables the desktop PCF from
    // FormXml. Model-driven defaults alone do not activate a portal component.
    if (field.controlStyle !== 756150001 || field.richText || field.hidden) return original;
    const component = field.codeComponent;
    const unsupported = message => {
      options.diagnostic?.({ code: 'PCF_NATIVE_BINDING_UNSUPPORTED', form: definition?.id, field: field.name, sourceFile: component?.sourceFile, message });
      return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>${original}`;
    };
    if (!component || !options.codeComponent) return unsupported(`The enabled code component for ${field.label} requires its exported desktop FormXml binding and solution control sources.`);
    if (component.boundAttributes.length !== 1 || component.boundAttributes[0] !== field.name) return unsupported(`Code component ${component.name} must bind only to its native form field ${field.name}.`);
    const args = { disabled: field.readOnly };
    const properties = [];
    for (const [name, parameter] of Object.entries(component.parameters)) {
      if (parameter.kind === 'static') args[name] = parameter.value;
      else if (parameter.kind === 'binding' && parameter.column === field.name) {
        const current = value(field);
        args[name] = field.control === 'lookup'
          ? current ? [{ id: canonicalId(scalarValue(current)), entityType: current.logical_name ?? field.targets?.[0], name: current.name ?? '' }] : []
          : field.control === 'multiselect' ? (Array.isArray(current) ? current.map(scalarValue) : String(scalarValue(current) ?? '').split(',').filter(Boolean)) : scalarValue(current);
        properties.push(name);
      } else return unsupported(`Code component ${component.name} has an unresolved or unsupported native property binding: ${name}.`);
    }
    const host = await options.codeComponent({ name: component.name, args, nativeBinding: { id: field.id, control: field.control, properties } });
    // Original inputs retain validators, names and the native form postback.
    // The client hides them after a successful mount and reveals them on failure.
    return `<div data-pcf-native-field="${attr(field.id)}"><div data-pcf-native-input>${original}</div>${host}</div>`;
  };

  // Subgrids, quick views and notes cells.
  const extraControls = new Map();
  const cells = formCells(schema);
  for (const cell of cells.filter((candidate) => ["quickform", "subgrid", "notes"].includes(candidate.type))) {
    if (cell.type === "quickform") {
      if (!cell.schema) {
        extraControls.set(cell.id, `<div class="control"><div role="alert">Quick form ${escape(cell.id)} is absent in the selected solution sources.</div></div>`);
        continue;
      }
      const lookup = record?.[cell.lookup];
      const relatedId = canonicalId(scalarValue(lookup));
      const target = store.resolveMapping(cell.entity);
      const path = `/_portal/quickform-template-path/${websiteId}`;
      const formName = cell.schema.formName ?? cell.schema.title ?? cell.label ?? cell.id;
      const src = relatedId ? `${path}?entityid=${encodeURIComponent(relatedId)}&entityname=${encodeURIComponent(cell.entity)}&entityprimarykeyname=${encodeURIComponent(target.idColumn)}&formname=${encodeURIComponent(formName)}&controlid=${encodeURIComponent(cell.id)}` : "about:blank";
      extraControls.set(cell.id, `<div class="info"></div><div class="control"><iframe src="${attr(src)}" id="${attr(cell.id)}" tabindex="0" class="quickform" data-path="${attr(path)}" data-controlid="${attr(cell.id)}" data-formname="${attr(formName)}" data-lookup-element="${attr(cell.lookup)}" role="presentation" scrolling="no" style="max-height: 350px;" title="${attr(cell.label ?? cell.id)}"></iframe></div>`);
      continue;
    }
    if (cell.type === "notes") {
      const row = metadataFor(metadataRows, 100000005, () => true);
      const settings = { ...cell.settings, ...settingsJson(fieldOf(row, "notes_settings")) };
      const target = { objectid: { id, logical_name: schema.entity } };
      for (const [flag, operation] of [["CreateEnabled", "create"], ["EditEnabled", "update"], ["DeleteEnabled", "delete"]]) {
        if (!store.allowed("annotation", operation, target, identity)) settings[flag] = false;
      }
      extraControls.set(cell.id, renderNotesControl({ record, id, entity: schema.entity, websiteId, settings, label: cell.label, language: formLanguage }));
      continue;
    }
    const label = cell.label ?? cell.id;
    if (!id) {
      // Native subgrids bind to an existing record and render nothing in Insert mode.
      extraControls.set(cell.id, `<h3 class="info form-subgrid-heading"><label for="${attr(cell.id)}" class="field-label">${escape(label)}</label></h3><div class="control"></div>`);
      continue;
    }
    const model = subgridModel({ portal, schemas, metadata, store, kind, formId: definition?.id ?? name, stepId: schema.stepId, gridId: cell.id });
    const gridMetadata = metadataFor(metadataRows, 100000003, row => fieldOf(row, 'subgrid_name') === cell.id);
    let codeComponentNotice = '';
    if (Number(fieldOf(gridMetadata, 'controlstyle')) === 756150001) {
      const message = `Subgrid ${label} uses a configured dataset code component. Its hosted relationship binding is not implemented locally; the native related grid below is a fallback.`;
      options.diagnostic?.({ code: 'PCF_NATIVE_DATASET_UNSUPPORTED', severity: 'warning', component: kind, form: definition?.id, grid: cell.id, message });
      codeComponentNotice = `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
    }
    if (!model.relationship || !model.relationship.many || canonicalId(model.relationship.entity) !== canonicalId(cell.entity))
      throw componentError(`Subgrid ${cell.id} requires exported relationship ${cell.relationship}`, 501, "SUBGRID_RELATIONSHIP_REQUIRED");
    const actions = actionLinks(model.settings, { portal, requestUrl: context.request?.url ?? "http://localhost/", website: websiteId });
    for (const action of actions) action.Enabled = action.Enabled && (action.Type !== 3 || !store.allowed || store.allowed(cell.entity, "create", { [model.relationship.to]: id }, identity));
    const layouts = gridLayouts(model, { secureBase: { t: "subgrid", w: websiteId, kind, form: definition?.id ?? name, step: schema.stepId ?? null, grid: cell.id, parent: canonicalId(id) }, websiteId, metadata, actions, language: formLanguage });
    const associate = actions.find((action) => action.Type === 5);
    let associateHtml = "";
    if (associate) {
      const associateModelValue = associateModel({ portal, schemas, metadata, store, kind, formId: definition?.id ?? name, stepId: schema.stepId, gridId: cell.id });
      const associateLayouts = gridLayouts(associateModelValue, { secureBase: { t: "associate", w: websiteId, kind, form: definition?.id ?? name, step: schema.stepId ?? null, grid: cell.id, parent: canonicalId(id) }, websiteId, metadata, actions: [], selectColumn: true, language: formLanguage });
      const reverseSchema = model.relationship.schemaName ?? cell.relationship;
      associateHtml = `<div class="entity-associate associate-lookup" data-url="/_services/entity-lookup-associate/${websiteId}" data-associate="${attr(JSON.stringify({ Target: { LogicalName: schema.entity, Id: canonicalId(id) }, Relationship: { SchemaName: reverseSchema } }))}">${nativeModal({
        className: "modal-associate",
        title: formLabel(model.settings?.LookupDialog?.Title, "Associate"),
        size: "modal-lg",
        body: `<div class="modal-error message" aria-hidden="true" style="display:none"><div class="alert alert-block alert-danger">We're sorry, an error has occurred.</div></div><div class="entity-grid associate-lookup" data-get-url="/_services/entity-subgrid-data.json/${websiteId}" data-defer-loading="true" data-enable-actions="false" data-select-mode="Multiple" data-column-width-style="Percent" data-grid-class="" data-selected-view="${attr(associateLayouts[0]?.Id ?? "")}" data-view-layouts="${base64Json(associateLayouts)}"><div class="view-grid"></div>${LOOKUP_GRID_MESSAGES}${PAGINATION}</div><div class="panel panel-default content-panel"><div class="panel-heading"><h4>Selected records</h4></div><div class="panel-body selected-records"></div></div>`,
        footer: `<button class="primary btn btn-primary" type="button">${escape(formLabel(model.settings?.LookupDialog?.PrimaryButtonText, "Add"))}</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>`,
      })}</div>`;
    }
    const settings = model.settings ?? {};
    extraControls.set(
      cell.id,
      `<h3 class="info form-subgrid-heading"><label for="${attr(cell.id)}" class="field-label">${escape(label)}</label></h3><div class="control">${codeComponentNotice}<div id="${attr(cell.id)}" class="subgrid"><div class="entity-grid subgrid${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-subgrid-data.json/${websiteId}" data-grid-class="table-striped${settings.GridCssClass && settings.GridCssClass !== "table-striped" ? " " + attr(settings.GridCssClass) : ""}" data-mobile-view-enabled="true" data-ref-entity="${attr(schema.entity)}" data-ref-id="${attr(canonicalId(id))}" data-ref-rel="${attr(model.relationship.schemaName ?? cell.relationship)}" data-select-mode="None" data-selected-view="${attr(layouts[0]?.Id ?? "")}" data-update-url="/_services/entity-grid-update-entity/${websiteId}" data-user-isauthenticated="${Boolean(identity?.contactId ?? identity?.id)}" data-view-layouts="${base64Json(layouts)}"><div class="view-grid"></div>${LOOKUP_GRID_MESSAGES}${PAGINATION}${gridModals(`/_portal/modal-form-template-path/${websiteId}`, settings, formLanguage)}${associateHtml}</div></div></div>`,
    );
  }
  const cellControl = async (cell) => {
    if (extraControls.has(cell.id)) return extraControls.get(cell.id);
    const resolved = byName.get(cell.name) ?? cell;
    if (resolved.ownerHidden) return "";
    const fieldValidatorsList = fieldValidators(resolved, { linksEnabled, readOnly });
    validators.push(...fieldValidatorsList);
    const labelFor = (resolved.control === "lookup" && resolved.lookupStyle !== "dropdown") || resolved.control === "boolean" && canonicalId(resolved.controlClassId) === RADIO_CLASS || resolved.control === "picklist" && [100000000, 100000001].includes(resolved.controlStyle) || /^(state|status)$/.test(resolved.control)
      ? ""
      : ` for="${attr(resolved.control === "datetime" ? `${resolved.id}_datepicker_description` : resolved.id)}"`;
    const description = resolved.description?.text ? resolved.description : null;
    const descriptionHtml = (position) => (description && description.position === position ? `<div class="description${position === 100000000 ? " above" : position === 100000001 ? " below" : ""}${resolved.cssClass ? " " + attr(resolved.cssClass) : ""}">${description.text}</div>` : "");
    const labelHtml = resolved.showLabel === false ? "" : `<label${labelFor} id="${attr(resolved.id)}_label" class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${escape(resolved.label)}</label>`;
    // CellTemplate: a field-level read-only cell has no validator container; a read-only form
    // keeps its validators (marked read-only). The app bundle then makes the containers of
    // read-only lookups and option sets focusable (lib/platform-app-compat.js).
    const fieldLevelReadOnly = resolved.fieldReadOnly ?? resolved.readOnly;
    return `${descriptionHtml(100000002)}<div class="info${resolved.required && !resolved.readOnly ? " required" : ""}">${labelHtml}${fieldLevelReadOnly ? "" : `<div class="validators">${validatorMarkup(fieldValidatorsList, { readonly: readOnly })}</div>`}</div>${descriptionHtml(100000000)}<div class="control" data-logical-name="${attr(resolved.name)}">${await input(resolved)}</div>${descriptionHtml(100000001)}`;
  };
  const cellClass = (cell) => {
    if (cell.type === "quickform") return "crmquickform-cell";
    if (cell.type === "subgrid") return "subgrid-cell";
    if (cell.type === "notes") return "notes-cell";
    const field = byName.get(cell.name);
    if (!field) return "";
    switch (field.control) {
      case "lookup":
        return "lookup form-control-cell";
      case "picklist":
        return "picklist-cell";
      case "multiselect":
        return "form-control-cell";
      case "boolean": {
        const classId = canonicalId(field.controlClassId);
        return classId === DROPDOWN_CLASS ? "boolean-dropdown-cell" : classId === RADIO_CLASS ? "boolean-radio-cell" : "checkbox-cell";
      }
      case "datetime":
        return "datetime form-control-cell";
      case "textarea":
        return "textarea form-control-cell";
      case "integer":
      case "decimal":
      case "double":
      case "money":
        return `${field.control} form-control-cell`;
      case "state":
      case "status":
        return `${field.control}-cell`;
      case "richtext":
        return "form-control-cell";
      default:
        return "text form-control-cell";
    }
  };
  const sectionMetadata = (sectionName) => metadataFor(metadataRows, 100000001, (row) => fieldOf(row, "sectionname") === sectionName);
  const tabMetadata = (tabName) => metadataFor(metadataRows, 100000002, (row) => fieldOf(row, "tabname") === tabName);
  let layoutHtml = "";
  if (schema.layout) {
    for (const tab of schema.layout) {
      const tabRow = tabMetadata(tab.name);
      const tabLabel = formLabel(fieldOf(tabRow, "label"), tab.label ?? "");
      let tabHtml = tab.showLabel ? `<h2 class="tab-title">${escape(tabLabel)}</h2>` : "";
      tabHtml += `<div${tab.name ? ` data-name="${attr(tab.name)}"` : ""} class="tab clearfix${fieldOf(tabRow, "cssclass") ? " " + attr(fieldOf(tabRow, "cssclass")) : ""}">`;
      for (const column of tab.columns) {
        tabHtml += `<div class="tab-column"${column.width ? ` style="width:${attr(column.width)};"` : ""}><div>`;
        for (const section of column.sections) {
          const sectionRow = sectionMetadata(section.name);
          const sectionLabel = formLabel(fieldOf(sectionRow, "label"), section.label ?? "");
          const widths = section.columnWidths ?? [100];
          tabHtml += `<fieldset${sectionLabel ? ` aria-label="${attr(plainText(sectionLabel))}"` : ""}>${section.showLabel ? `<legend class="section-title"><h3>${sectionLabel}</h3></legend>` : ""}<table role="presentation"${section.name ? ` data-name="${attr(section.name)}"` : ""} class="section${fieldOf(sectionRow, "cssclass") ? " " + attr(fieldOf(sectionRow, "cssclass")) : ""}"><colgroup>${widths.map((width) => `<col style="width:${width}%;">`).join("")}<col></colgroup><tbody>`;
          for (const row of section.rows) {
            tabHtml += "<tr>";
            for (const cell of row) {
              if (cell.spacer) {
                tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell"></td>`;
                continue;
              }
              const field = byName.get(cell.name);
              const hidden = cell.hidden || field?.ownerHidden || (field?.hidden && field?.control !== "lookup") || field?.hidden;
              const suffix = cellClass(cell);
              tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell${suffix ? " " + suffix : ""}"${hidden ? ' style="display: none;"' : ""}>${await cellControl(cell)}</td>`;
            }
            tabHtml += '<td class="cell zero-cell"></td></tr>';
          }
          tabHtml += "</tbody></table></fieldset>";
        }
        tabHtml += "</div></div>";
      }
      tabHtml += "</div>";
      layoutHtml += tabHtml;
    }
  } else
    for (const field of fields)
      layoutHtml += `<div class="form-group"${field.hidden ? ' style="display: none;"' : ""}>${await cellControl(field)}</div>`;

  // Attach file (adx_attachfile*): saved as annotations by the form service.
  let attachHtml = "";
  if (!readOnly && truthy(fieldOf(componentMetadata, "attachfile"))) {
    const accept = [fieldOf(componentMetadata, "attachfileaccept"), fieldOf(componentMetadata, "attachfileacceptextensions")].filter(Boolean).join(",") || "*/*";
    const requiredFile = truthy(fieldOf(componentMetadata, "attachfilerequired"));
    const label = formLabel(fieldOf(componentMetadata, "attachfilelabel"), "Attach a File");
    attachHtml = `<div class="tr"><div class="cell file-cell"><div class="info${requiredFile ? " required" : ""}"><label for="AttachFile" id="AttachFileLabel">${escape(label)}</label></div><div class="control"><input type="file" name="${attr(ids.names)}AttachFile" id="AttachFile"${truthy(fieldOf(componentMetadata, "attachfileallowmultiple")) ? ' multiple="multiple"' : ""} accept="${attr(accept)}" data-pp-attach-file><span id="AttachFileAcceptValidatorAttachFile" style="display:none;"></span><span id="AttachFileSizeValidatorAttachFile" style="display:none;"></span>${requiredFile ? '<span id="RequiredFieldValidatorAttachFile" style="display:none;"></span>' : ""}</div></div></div>`;
    if (requiredFile)
      validators.push({ id: "RequiredFieldValidatorAttachFile", controltovalidate: "AttachFile", errormessage: summaryLink("AttachFile", formLabel(fieldOf(componentMetadata, "attachfilerequirederrormessage"), `${label} is a required field.`), linksEnabled), display: "None", evaluationfunction: "RequiredFieldValidatorEvaluateIsValid", initialvalue: "" });
  }

  // Scripts, rich text and managed controls.
  const originalScript = schema.js ?? definition?.js;
  const script = originalScript && (renderLiquid ? await renderLiquid(originalScript, context) : originalScript);
  const richTextReady = await richTextRuntime(fields, { portal, managedControls, richTextCompatibility });
  const nativeDefinitions = Object.fromEntries(fields.filter((field) => managedControls[field.richText?.name]).map((field) => [field.richText.name, managedControls[field.richText.name]]));
  const managedReady = Object.keys(nativeDefinitions).length ? `<script>${clientManagedControlsRuntime(nativeDefinitions)}</script>` : "";

  // Actions.
  const actionSettings = settingsJson(fieldOf(componentMetadata, "settings") ?? "", "form settings");
  const submitAction = (actionSettings.Actions ?? []).find((action) => action.Type === "SubmitAction");
  const busy = formLabel(fieldOf(componentMetadata, "submitbuttonbusytext"), "") || formLabel(submitAction?.ButtonBusyLabel, "") || "Processing...";
  const hook = kind === "webform" ? "webFormClientValidate" : "entityFormClientValidate";
  const group = fieldOf(componentMetadata, "validationgroup") ?? "";
  const onclick = (buttonName) =>
    `javascript:if(typeof ${hook} === 'function'){if(${hook}()){if(typeof Page_ClientValidate === 'function'){if(Page_ClientValidate('${group}')){clearIsDirty();disableButtons();this.value = '${busy}';}}else{clearIsDirty();disableButtons();this.value = '${busy}';}}else{return false;}}else{if(typeof Page_ClientValidate === 'function'){if(Page_ClientValidate('${group}')){clearIsDirty();disableButtons();this.value = '${busy}';}}else{clearIsDirty();disableButtons();this.value = '${busy}';}};WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("${buttonName}", "", true, "${group}", "", false, true))`;
  let actionsHtml = "";
  let defaultButton = "";
  if (kind === "webform") {
    const step = schema.metadata ?? {};
    const nextStep = schema.nextStepId ? (advancedSteps ?? schemas[definition?.id]?.steps ?? []).find((candidate) => canonicalId(candidate.stepId) === canonicalId(schema.nextStepId)) : null;
    const terminal = !nextStep || nextStep.type === "redirect";
    const nextLabel = terminal ? formLabel(fieldOf(step, "submitbuttontext"), "Submit") : formLabel(fieldOf(step, "nextbuttontext"), "Next");
    const previousAllowed = stepIndex > 0 && fieldOf(step, "movepreviouspermitted") !== false;
    defaultButton = "NextButton";
    const previous = previousAllowed ? `<div role="group" class="btn-group entity-action-button"><input type="button" name="${attr(ids.buttons)}PreviousButton" value="${attr(formLabel(fieldOf(step, "previousbuttontext"), "Previous"))}" onclick="javascript:__doPostBack('${attr(ids.buttons)}PreviousButton','')" id="PreviousButton" class="${attr(fieldOf(step, "previousbuttoncssclass") || "btn btn-default button previous previous-btn")}"></div>` : "";
    const next = readOnly && terminal ? "" : `<div role="group" class="btn-group entity-action-button"><input type="button" name="${attr(ids.buttons)}NextButton" value="${attr(nextLabel)}" onclick="${attr(onclick(ids.buttons + "NextButton"))}" id="NextButton" class="${attr(terminal ? fieldOf(step, "submitbuttoncssclass") || "btn btn-primary button next submit-btn" : fieldOf(step, "nextbuttoncssclass") || "btn btn-primary button next submit-btn")}"></div>`;
    actionsHtml = previous || next ? `<div class="actions"><div class="col-sm-6 clearfix">${previous}${next}</div></div>` : "";
  } else if (!readOnly) {
    const button = mode === FORM_MODE.insert ? "InsertButton" : "UpdateButton";
    defaultButton = button;
    const label = formLabel(fieldOf(componentMetadata, "submitbuttontext"), "") || formLabel(submitAction?.ButtonLabel, "") || "Submit";
    if (submitAction) {
      const css = fieldOf(componentMetadata, "submitbuttoncssclass") || submitAction.ButtonCssClass || "btn btn-primary button submit-btn";
      actionsHtml = `<div class="row form-custom-actions"><div class="col-sm-6 clearfix"><div class="form-action-container-left"><input type="button" name="${attr(ids.buttons)}${button}" value="${attr(label)}" onclick="${attr(onclick(ids.buttons + button))}" id="${button}" title="${attr(formLabel(submitAction.ButtonTooltip, label))}" class="${attr(css)}"></div></div><div class="col-sm-6 clearfix"><div class="form-action-container-right"></div></div></div>`;
    } else {
      const css = fieldOf(componentMetadata, "submitbuttoncssclass") || "submit-btn btn btn-primary form-action-container-left";
      actionsHtml = `<div class="actions"><input type="button" name="${attr(ids.buttons)}${button}" value="${attr(label)}" onclick="${attr(onclick(ids.buttons + button))}" id="${button}" class="${attr(css)}"></div>`;
    }
  } else {
    // A read-only basic form keeps its (empty) actions container and has no default button.
    actionsHtml = '<div class="actions"></div>';
  }

  // Hidden configuration consumed by the local postback runtime (scripts are
  // excluded from semantic DOM comparison).
  const queryName = source.queryName ?? "id";
  const submitConfig = {
    kind,
    formId: definition?.id ?? name,
    stepId: schema.stepId ?? null,
    submitUrl: `/__sim/forms/${kind}/${encodeURIComponent(definition?.id ?? name)}/submit`,
    operation: mode === FORM_MODE.insert ? "create" : "update",
    recordQueryName: queryName,
    summaryHeader: "The form could not be submitted for the following reasons:",
    fields: fields
      .filter((field) => !field.ownerHidden && !field.readOnly && !["state", "status"].includes(field.control))
      .map((field) => ({ name: field.name, id: field.id, control: controlForSubmit(field), readOnly: false, bindings: field.bindings })),
  };
  const summaryId = `ValidationSummary${ids.view}`;
  const summaryHeader = "<h2 class='validation-header'><span role='presentation' class='fa fa-info-circle'></span> The form could not be submitted for the following reasons:</h2>";
  const layoutConfig = {
    EntityName: schema.entity,
    Id: definition?.id ?? null,
    SubmitActionLink: { Modal: {}, Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    PreviousActionLink: { Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    NextActionLink: { Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    CreateRelatedRecordActionLink: { Modal: {}, Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    EnableEntityPermissions: fieldOf(componentMetadata, "entitypermissionsenabled") !== false,
    LanguageCode: 0,
    EnableActions: false,
    ShowActionButtonContainer: 0,
    AutoGenerateSteps: truthy(fieldOf(componentMetadata, "autogeneratesteps")),
  };
  // ASP.NET HiddenField: an empty value renders no value attribute (an insert form's EntityID).
  const hidden = (suffix, valueText) =>
    `<input type="hidden" name="${attr(ids.names.replace(/\$$/, ""))}$${attr(ids.view)}_${suffix}" id="${attr(ids.view)}_${suffix}"${String(valueText ?? "") !== "" ? ` value="${attr(valueText)}"` : ""}>`;
  const instructions = formLabel(fieldOf(componentMetadata, "instructions"), "");
  const panelClass = kind === "webform" && progress?.position === "left" ? "crmEntityFormView left" : kind === "webform" && progress?.position === "right" ? "crmEntityFormView right" : "crmEntityFormView";
  const entityFormClass = readOnly ? "form-readonly entity-form" : "entity-form";
  const formHtml = `<div id="${attr(ids.panel)}" class="${panelClass}" data-form-name="${attr(schema.formName ?? schema.title ?? name)}"${defaultButton ? ` onkeypress="javascript:return WebForm_FireDefaultButton(event, '${defaultButton}')"` : ""} role="form" aria-label="${kind === "webform" ? "Multistep Form" : "Basic Form"}"><div id="${attr(ids.view)}" class="${entityFormClass}"${readOnly ? ' readonly="readonly"' : ""}>${hidden("EntityName", schema.entity)}${hidden("EntityID", id ? canonicalId(id) : "")}${hidden("EntityState", scalarValue(record?.statecode) ?? "")}${hidden("EntityStatus", scalarValue(record?.statuscode) ?? "")}<span id="${attr(ids.view)}_EntityLayoutConfig" data-form-layout="${attr(JSON.stringify(layoutConfig))}"></span><div id="${attr(summaryId)}" class="${attr(fieldOf(componentMetadata, "validationsummarycssclass") || "validation-summary alert alert-error alert-danger alert-block")}" role="alert" style="display:none;"${readOnly ? ' readonly="readonly"' : ""}></div>${layoutHtml}${attachHtml}</div>${actionsHtml}</div>`;
  const progressTop = progress && progress.position !== "bottom" ? progress.html : "";
  const progressBottom = progress && progress.position === "bottom" ? progress.html : "";
  // Native order: validation runtime and default hook before the control, custom
  // JavaScript first inside the control, validator expandos after the markup.
  const runtime = `<script src="${NATIVE_FORMS_SCRIPT}"></script>${kind === "webform" ? "" : `<script type="text/javascript">function entityFormClientValidate() { // Custom client side validation. Method is called by the submit button's onclick event.\n// Must return true or false. Returning false will prevent the form from submitting.\nreturn true; }</script>`}`;
  return `${runtime}<div id="${attr(ids.wrapper)}" data-pp-native-form>${script ? `<span><script type="text/javascript">${script}</script></span>` : ""}<script type="application/json" data-paqvilo-mirage-form-config>${json(submitConfig)}</script>${progressTop}${instructions ? `<div class="instructions">${instructions}</div>` : ""}${formHtml}${progressBottom}${validatorStartupScript(validators, summaryId, summaryHeader)}${richTextReady}${managedReady}</div>`;
}

function controlForSubmit(field) {
  switch (field.control) {
    case "lookup":
      return field.lookupStyle === "dropdown" ? "lookup" : "lookup";
    case "boolean": {
      const classId = canonicalId(field.controlClassId);
      return classId === DROPDOWN_CLASS ? "boolean-dropdown" : classId === RADIO_CLASS ? "boolean-radio" : "checkbox";
    }
    case "picklist":
      return [100000000, 100000001].includes(field.controlStyle) ? "picklist-radio" : "picklist";
    case "integer":
    case "decimal":
    case "double":
    case "money":
      return "number";
    case "multiselect":
      return "multiselect";
    case "datetime":
      return "datetime";
    case "richtext":
      return "richtext";
    default:
      return "text";
  }
}

function renderNotesControl({ record, id, entity, websiteId, settings, label, language = {} }) {
  if (!id) return `<div class="info"><label for="notescontrol">${escape(label ?? "Notes")}</label></div><div class="control"><div id="notescontrol"></div></div>`;
  const page = (name, fallback) => formText(settings?.[name], fallback, language);
  const addEnabled = settings.CreateEnabled !== false;
  return `<div class="info"><label for="notescontrol">${escape(label ?? "Notes")}</label></div><div class="control"><div id="notescontrol"><div class="col-md-8 entity-notes" data-url-get="/_services/entity-notes/${websiteId}" data-url-add="/_services/entity-form-addnote/${websiteId}" data-url-edit="/_services/entity-form-updatenote/${websiteId}" data-url-delete="/_services/entity-form-deletenote/${websiteId}" data-url-get-attachments="" data-add-enabled="${addEnabled ? "True" : "False"}" data-edit-enabled="${settings.EditEnabled === true ? "True" : "False"}" data-delete-enabled="${settings.DeleteEnabled === true ? "True" : "False"}" data-use-scrolling-pagination="False" data-hide-field-label="False" data-orders='[{"Attribute":"createdon","Alias":null,"Direction":null}]' data-target="${attr(JSON.stringify({ Id: canonicalId(id), LogicalName: entity, Name: record?.name ?? null }))}" data-pagesize="${Number(settings.PageSize) || 10}"><div class="notes-empty message"><div class="alert alert-block alert-info">${escape(page("EmptyMessage", "There are no notes to display."))}</div></div><div class="notes-access-denied message"><div class="alert alert-block alert-danger">You don't have permissions to view these notes.</div></div><div class="notes-error message"><div class="alert alert-block alert-danger">An error occurred while loading notes.<span class="details"></span></div></div><div class="notes-loading message text-center"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div><div class="notes" tabindex="0"></div><div class="note-actions row"><div class="col-sm-3">${addEnabled ? `<a class="btn btn-default addnote" href="#">${escape(page("AddNoteButtonLabel", "Add a note"))}</a>` : ""}</div><div class="notes-pagination col-sm-9" data-pages="1" data-pagesize="${Number(settings.PageSize) || 10}" data-current-page="1"></div></div>${nativeModal({ className: "modal-addnote", title: "Add a note", body: `<div class="addnote form-horizontal"><div class="form-group"><label id="note_label" class="col-sm-3 control-label required" for="note-text">Note</label><div class="col-sm-9"><textarea id="note-text" name="text" class="form-control" cols="20" rows="6"></textarea></div></div><div class="form-group"><label class="col-sm-3 control-label" for="note-file">Attach a file</label><div class="col-sm-9 form-control-static"><input id="note-file" name="file" type="file"></div></div></div>`, footer: '<button class="primary btn btn-primary" type="button">Add Note</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' })}${nativeModal({ className: "modal-editnote", title: "Edit note", body: `<div class="editnote form-horizontal"><div class="form-group"><label class="col-sm-3 control-label required" for="note-edit-text">Note</label><div class="col-sm-9"><textarea id="note-edit-text" name="text" class="form-control" cols="20" rows="6"></textarea></div></div><div class="form-group"><label class="col-sm-3 control-label" for="note-edit-file">Attach a file</label><div class="col-sm-9 form-control-static"><input id="note-edit-file" name="file" type="file"></div></div></div>`, footer: '<button class="primary btn btn-primary" type="button">Update Note</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' })}${nativeModal({ className: "modal-delete modal-deletenote", title: "Delete note", body: "Are you sure you want to delete this note?", footer: '<button class="primary btn btn-primary" type="button">Delete</button><button class="cancel btn btn-default" data-dismiss="modal" type="button">Cancel</button>' })}</div></div></div>`;
}

function richTextInput(field, current, { portal, managedControls, nameAttr }) {
  const fieldId = field.id ?? field.name;
  const valueText = current == null ? "" : String(current);
  const attrs = `id="${attr(fieldId)}" name="${nameAttr(field)}"${field.required ? " required" : ""}${field.readOnly ? " readonly" : ""}`;
  const definition = managedControls[field.richText.name];
  if (definition) {
    validateManagedControlDefinition(definition, field.richText.name);
    const basename = field.richText.configUrl?.split("/").at(-1)?.toLowerCase();
    const resource = portal.webFiles?.find(
      (file) =>
        file.name?.toLowerCase() === basename ||
        portalField(file.metadata ?? {}, "filename", "").toLowerCase() === basename ||
        file.url?.split("/").at(-1)?.toLowerCase() === basename,
    );
    const controlContext = {
      UniqueId: fieldId + "_ControlView",
      ControlId: fieldId,
      GridDataControlId: null,
      ControlName: field.richText.name,
      ControlProperties: { configUrl: resource?.url ?? field.richText.configUrl ?? "", value: valueText },
      IsDisabled: !!field.readOnly,
      PcfControlHiddenValueId: fieldId,
      PcfDynamicProperyName: "value",
    };
    return `<div id="PcfControl_${attr(fieldId)}" data-sim-managed-control data-control-view="${attr(controlContext.UniqueId)}" data-field="${attr(fieldId)}"><span id="${attr(fieldId)}_Container" class="flexbox"><div id="${attr(controlContext.UniqueId)}" class="flexbox"></div></span><span id="PcfControlConfig_${attr(fieldId)}" data-pcf-control="${attr(JSON.stringify(definition.manifest))}" pcf-controlcontext="${attr(JSON.stringify(controlContext))}" hidden></span><input type="hidden" ${attrs} value="${attr(JSON.stringify(valueText))}" data-sim-richtext-value></div>`;
  }
  return `<input type="hidden" ${attrs} value="${attr(JSON.stringify(valueText))}" data-sim-richtext-value><div id="PcfControl_${attr(fieldId)}" data-sim-richtext-editor data-field="${attr(fieldId)}"${field.readOnly ? ' data-read-only="true"' : ""}><textarea id="${attr(fieldId)}_editor" aria-label="${attr(field.label ?? field.name)}">${escape(valueText)}</textarea><p role="alert" data-sim-richtext-error hidden></p></div>`;
}

async function richTextRuntime(fields, { portal, managedControls, richTextCompatibility }) {
  const settings = {};
  for (const field of fields.filter((candidate) => candidate.richText && !managedControls[candidate.richText.name])) {
    const configUrl = field.richText.configUrl;
    const basename = configUrl?.split("/").at(-1)?.toLowerCase();
    const resource = portal.webFiles?.find(
      (file) =>
        file.name?.toLowerCase() === basename ||
        portalField(file.metadata ?? {}, "filename", "").toLowerCase() === basename ||
        file.url?.split("/").at(-1)?.toLowerCase() === basename,
    );
    let configuration = {};
    if (resource) {
      try {
        configuration = JSON.parse(await fs.readFile(resource.file, "utf8"));
      } catch (error) {
        throw componentError(`Rich text configuration ${configUrl}: ${error.message}`, 501, "RICHTEXT_CONFIG_INVALID");
      }
    }
    // Fetch through the source URL so an explicitly captured, unchanged-source
    // JSON baseline applies consistently to native and adapter controls.
    settings[field.id ?? field.name] = {
      configuration: resource?.url ? {} : configuration,
      configUrl: resource?.url ?? (resource ? null : configUrl),
      compatibility: richTextCompatibility,
    };
  }
  return Object.keys(settings).length ? `<script>${clientRichTextRuntime(settings)}</script>` : "";
}

/** Native quick view form document (/_portal/quickform-template-path/{websiteId}). */
export async function renderQuickForm({ portal, schemas, store, readProvider, identity, params }) {
  const entity = canonicalId(params.entityname);
  const controlId = params.controlid;
  let quick = null;
  for (const schema of Object.values(schemas ?? {})) {
    for (const candidate of [schema, ...(schema?.steps ?? [])])
      for (const cell of formCells(candidate))
        if (cell.type === "quickform" && cell.schema && canonicalId(cell.entity) === entity && (!controlId || cell.id === controlId) && (!params.formname || [cell.schema.formName, cell.schema.title, cell.label].includes(params.formname))) quick = cell;
    if (quick) break;
  }
  if (!quick) throw componentError("The quick view form is not part of an exported form layout.", 404, "QUICKFORM_NOT_FOUND");
  const record = params.entityid ? await readProvider.get(entity, params.entityid, identity) : null;
  if (!record) throw componentError(`Entity '${entity}' With Id = ${canonicalId(params.entityid)} Does Not Exist`, 404, "QUICKFORM_RECORD_NOT_FOUND");
  const display = (value) => value?.name ?? value?.label ?? scalarValue(value) ?? "";
  const rows = (quick.schema.fields ?? [])
    .filter((field) => !field.hidden)
    .map((field) => `<tr><td colspan="1" rowspan="1" class="clearfix cell text form-control-cell"><div class="info"><label for="${attr(field.name)}" id="${attr(field.name)}_label" class="field-label">${escape(field.label ?? field.name)}</label></div><div class="control" data-logical-name="${attr(field.name)}"><input type="text" id="${attr(field.name)}" readonly="readonly" class="text form-control readonly" value="${attr(display(record[field.name]))}"></div></td><td class="cell zero-cell"></td></tr>`)
    .join("");
  return `<div id="QuickFormControl" class="crmEntityFormView readonly"><div class="form-readonly entity-form"><table role="presentation" class="section"><colgroup><col style="width:100%;"><col></colgroup><tbody>${rows}</tbody></table></div></div>`;
}

/** The single lookup that references the native refentity parent. */
function referenceField(fields, mapping, reference) {
  const matches = fields.filter(
    (field) =>
      field.control === "lookup" &&
      Object.values(mapping.relationships ?? {}).some((relation) => relation.many === false && relation.from === field.name && relation.entity === canonicalId(reference.entity)),
  );
  return matches.length === 1 ? matches[0].name : null;
}
