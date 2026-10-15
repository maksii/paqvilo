import { decodeXml, portalField } from "./importer.mjs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { renderFormLabel } from './form-labels.mjs';
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
import { webFormSession, sessionRecord, previousSessionRecord, formText, webFormSessionOwner, advancedFormAccess, appendRedirectRecordId, nativeFormSubmissionContext, formCreateAllowed } from "./form-service.mjs";
import { formErrorPanel, createAccessDeniedForm } from "./form-error-presentation.mjs";
import { deniedPageRoute } from "./redirects.mjs";
import { approximateFormSchema, approximateAdvancedFormSchema } from "./form-schema-fallback.mjs";
import { hasPlatformBundles, bootstrapVariant } from "./platform-manifest.mjs";
import { portalLanguage } from "./portal-languages.mjs";
import { clientPortalObjectRuntime } from "./portal-client-object.mjs";
import { parseDateValue } from "./dataverse-values.mjs";
import { nativeFormActions, NATIVE_STATE_ACTIONS, nativeActionStateValues } from './native-form-actions.mjs';
import { missingLiquidComponent, observedChartMarkup, observedSearchUnavailable } from './liquid-service-observations.mjs';
import { compactNativeControlId as compactId, nativeFormControlIds, nativeFormPostbackDescriptor } from './native-postback.mjs';
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
// The basic form control registers its custom client-validation hook, also ahead of a create denial.
const ENTITY_FORM_CLIENT_VALIDATE = `<script type="text/javascript">function entityFormClientValidate() { // Custom client side validation. Method is called by the submit button's onclick event.\n// Must return true or false. Returning false will prevent the form from submitting.\nreturn true; }</script>`;

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

export function nativeControlKind(field) {
  const type = String(field.dataverseType ?? "").toLowerCase();
  if (field.richText) return "richtext";
  if (field.type === "lookup" || /^(lookup|customer|owner)$/.test(type)) return "lookup";
  if (type === "multiselectpicklist") return "multiselect";
  if (type === "file" || type === "image") return type;
  if (/^(state|status)$/.test(type)) return type;
  if (type === "picklist" || (field.options?.length && !/^(bit|boolean)$/.test(type) && field.type !== "boolean")) return "picklist";
  if (/^(bit|boolean)$/.test(type) || field.type === "boolean" || field.type === "checkbox") return "boolean";
  if (type === "datetime" || ["date", "datetime-local"].includes(field.type)) return "datetime";
  if (/^(int|integer|bigint)$/.test(type)) return "integer";
  if (type === "decimal") return "decimal";
  if (/^(float|double)$/.test(type)) return "double";
  if (type === "money") return "money";
  if (/^(memo|ntext)$/.test(type) || field.type === "textarea" || String(field.format ?? "").toLowerCase() === "textarea") return "textarea";
  if (field.type === "number") return "integer";
  if (field.type === "email" || String(field.format ?? "").toLowerCase() === "email") return "email";
  return "text";
}

/** Native numeric range messages use the column's exported decimal precision. */
export function nativeRangeMessage(field) {
  const control = nativeControlKind(field);
  const precision = Number.isInteger(field.precision) && field.precision >= 0 && field.precision <= 100 ? field.precision : null;
  const bound = (value) => value == null ? "" : precision != null && control !== "integer" ? Number(value).toFixed(precision) : String(value);
  return `${field.label ?? field.name} must have a value between ${bound(field.minimum ?? field.minValue)} and ${bound(field.maximum ?? field.maxValue)}.`;
}

/** The exported Dataverse format takes precedence over the generic input type. */
export function nativeDateOnly(field) {
  const format = String(field.format ?? "").toLowerCase();
  return !/^(datetime|dateandtime)$/.test(format) &&
    (/dateonly/i.test(field.dateTimeBehavior ?? field.behavior ?? format) || /^(date|dateonly)$/.test(format) || field.type === "date" || String(field.dataverseType).toLowerCase() === "datetime");
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
export async function resolveFormRecord({ kind, definition, schema, metadata, context, readProvider, store, identity, modal, session }) {
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
    // A regular expression validator renders no marker text.
    .map((validator) => `<span id="${attr(validator.id)}" style="${validator.display === "Dynamic" || validator.display === "None" ? "display:none;" : "visibility:hidden;"}"${readonly ? ' readonly="readonly"' : ""}>${validator.id.startsWith("RegularExpressionValidator") ? "" : "*"}</span>`)
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
  const format = {
    email: ["EmailFormatValidator", `${label} must be a valid email address.`],
    integer: ["IntegerValidator", `${label} must be a valid integer value.`],
    decimal: ["FloatValidator", `${label} must be a valid decimal value.`],
    double: ["FloatValidator", `${label} must be a valid floating-point value.`],
    datetime: ["DateFormatValidator", `${label} must have a valid date format.`],
  }[field.control];
  const formatValidator = format && {
    id: `${format[0]}${id}`,
    controltovalidate: id,
    errormessage: summaryLink(id, field.validationMessage || format[1], linksEnabled),
    evaluationfunction: "CustomValidatorEvaluateIsValid",
  };
  // The e-mail format validator precedes the maximum length validator.
  if (formatValidator && field.control === "email") validators.push(formatValidator);
  if (field.maxLength && ["text", "email", "textarea"].includes(field.control))
    // Like the hosted control, these CustomValidators run on the server. They
    // deliberately have no clientvalidationfunction: a format error posts back.
    validators.push({
      id: `MaximumLengthValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, `${label} exceeds the maximum length of ${field.maxLength} characters.`, linksEnabled),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
    });
  if (formatValidator && field.control !== "email") validators.push(formatValidator);
  if (["integer", "decimal", "double", "money"].includes(field.control) && (field.minimum != null || field.maximum != null))
    validators.push({
      id: `RangeValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.rangeMessage || nativeRangeMessage(field), linksEnabled),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
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

/** Bootstrap 3 / Bootstrap 5 tokens of the native control markup (site setting Site/BootstrapV5Enabled). */
const BOOTSTRAP_MARKUP = {
  BootstrapV3: { v5: false, srOnly: "sr-only", toggle: "data-toggle", dismiss: "data-dismiss", backdrop: "data-backdrop", right: "pull-right", left: "pull-left", info: "info" },
  BootstrapV5: { v5: true, srOnly: "visually-hidden", toggle: "data-bs-toggle", dismiss: "data-bs-dismiss", backdrop: "data-bs-backdrop", right: "float-end", left: "float-start", info: "table-info" },
};
export const bootstrapMarkup = (settings) => BOOTSTRAP_MARKUP[bootstrapVariant(settings)];
// Bootstrap 5 grid messages carry no inline display style, and the error text has two details spans.
const gridMessages = (bs = BOOTSTRAP_MARKUP.BootstrapV3) =>
  bs.v5 ? LOOKUP_GRID_MESSAGES.replace(/ style="display:none"/g, "").replace('<span class="details"></span>', '<span class="details"></span><span class="details"></span>') : LOOKUP_GRID_MESSAGES;
const LOOKUP_GRID_MESSAGES = `<div aria-label="There are no records to display." aria-live="polite" class="view-empty message" role="status" tabindex="-1" style="display:none"><div class="alert alert-block alert-warning">There are no records to display.</div></div><div class="view-access-denied message" role="presentation" tabindex="0" style="display:none"><div class="alert alert-block alert-danger">You don't have permissions to view these records.</div></div><div class="view-error message" role="presentation" tabindex="0" style="display:none"><div class="alert alert-block alert-danger">Error completing request.<span class="details"></span></div></div><div class="view-loading message text-center" role="presentation" tabindex="0" style="display:none"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div>`;
const PAGINATION = '<div class="view-pagination" data-current-page="1" data-pages="1" data-pagesize=""></div>';
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const SUCCESS_PANEL_V5 = "message alert success alert alert-success";
/** The Bootstrap 5 message panel's close button: a WebForms postback button that dismisses the alert. */
function messageCloseButton(buttonPrefix, bs) {
  const name = `${buttonPrefix}btnCloseMessage`;
  return `<input type="submit" name="${attr(name)}" value="x" onclick="${attr(`javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(${json(name)}, "", true, "", "", false, false))`)}" id="btnCloseMessage" class="btn-close" ${bs.dismiss}="alert" aria-label="close" style="border-style: none">`;
}
// The platform's duration choices, in minutes.
const DURATION_MINUTES = [1, 5, 15, 30, 45, ...Array.from({ length: 15 }, (_, index) => 60 + index * 30), 1440, 2880, 4320];
const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;
const durationLabel = (minutes) => (minutes < 60 ? plural(minutes, "minute") : minutes < 1440 ? plural(minutes / 60, "hour") : plural(minutes / 1440, "day"));
/** Option lists of whole-number formats: duration (fixed minutes) and language (the site's languages). */
function integerFormatChoices(field, portal) {
  const format = String(field.format ?? "").toLowerCase();
  if (format === "duration") return DURATION_MINUTES.map((minutes) => ({ value: minutes, label: durationLabel(minutes) }));
  if (format !== "language") return null;
  const names = new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" });
  const lcids = [...new Set((portal.websiteLanguages ?? []).map((language) => language.lcid).filter(Boolean))];
  return lcids.map((lcid) => ({ lcid, code: portalLanguage({ lcid })?.code })).filter((language) => language.code).map(({ lcid, code }) => ({ value: lcid, label: names.of(code) }));
}
// Dataverse column types the portal form does not render (an empty cell).
const UNSUPPORTED_FORM_TYPES = /^bigint$/i;
// ASP.NET omits the value attribute of an input whose value is empty.
const valueAttr = (value) => (String(value ?? "") === "" ? "" : ` value="${attr(value)}"`);
// The error dialog a Bootstrap 5 lookup grid nests after its pagination: its title and label are
// the raw icon markup.
const gridErrorModal = (bs) => {
  const title = "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> Error";
  return nativeModal({ bs, className: "modal-error", title, label: title, body: "<p>We're sorry, an error has occurred.</p>", footer: `<button aria-label="Close" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="Close" type="button">Close</button>` }).replace(` title="${attr(plainText(title))}"`, ` title="${attr(title)}"`);
};

function nativeModal({ className, title, body, footer = "", size = "", label, bs = BOOTSTRAP_MARKUP.BootstrapV3, headingLabel = false }) {
  // headingLabel: the Bootstrap 5 lookup dialog labels its heading instead of the section.
  const labelAttr = ` aria-label="${attr(label ?? plainText(title))}"`;
  return `<section aria-hidden="true"${headingLabel ? "" : labelAttr} class="modal fade ${className}" ${bs.backdrop}="static" role="dialog" tabindex="-1"><div class="${size ? size + " " : ""}modal-dialog"><div class="modal-content"><div class="modal-header"><h1${headingLabel ? labelAttr : ""} class="modal-title" title="${attr(plainText(title))}">${title}</h1><button aria-label="Close" class="form-close" ${bs.dismiss}="modal" style="position: absolute; top: 3%;" tabindex="0" title="Close" type="button"><span aria-hidden="true">×</span><span class="${bs.srOnly}">Close</span></button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}</div></div></section>`;
}
function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}
const formModalBody = (page) => `<div class="form-loading"><span class="fa fa-spinner fa-spin fa-4x" aria-hidden="true"></span></div><iframe data-page="${attr(page)}" src="about:blank"></iframe>`;

/** Native grid modals (create/edit/details forms, delete, error, workflow, (de)activate). */
function gridModals(page, settings = {}, language = {}, bs = BOOTSTRAP_MARKUP.BootstrapV3) {
  const dialog = (name, fallback) => formText(settings?.[name]?.Title, fallback, language);
  return [
    nativeModal({ bs, className: "modal-form modal-form-insert", title: dialog("CreateFormDialog", "<span class='fa fa-pencil-square-o' aria-hidden='true'></span> Create"), body: formModalBody(page), size: "modal-lg", label: "Create" }),
    nativeModal({ bs, className: "modal-form modal-form-edit", title: dialog("EditFormDialog", "<span class='fa fa-edit'></span> Edit"), body: formModalBody(page), size: "modal-lg", label: "Edit" }),
    nativeModal({ bs, className: "modal-form modal-form-details", title: dialog("DetailsFormDialog", "<span class='fa fa-info-circle' aria-hidden='true'></span> View details"), body: formModalBody(page), size: "modal-lg" }),
    nativeModal({ bs, className: "modal-delete", title: dialog("DeleteDialog", "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete"), body: escape(formText(settings?.DeleteDialog?.Confirmation, "Are you sure you want to delete this record?", language)), footer: `<button aria-label="Delete" class="primary btn btn-primary" tabindex="0" title="Delete" type="button">${escape(localizedText(settings?.DeleteDialog?.PrimaryButtonText, "Delete"))}</button><button aria-label="Cancel" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="Cancel" type="button">${escape(localizedText(settings?.DeleteDialog?.CloseButtonText, "Cancel"))}</button>`, label: "Delete" }),
    nativeModal({ bs, className: "modal-error", title: "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> Error", body: "<p>We're sorry, an error has occurred.</p>", footer: `<button aria-label="Close" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="Close" type="button">Close</button>` }),
    nativeModal({ bs, className: "modal-run-workflow", title: "Run workflow", body: "Are you sure you want to run this workflow?", footer: `<button class="primary btn btn-primary" type="button">Run workflow</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
    nativeModal({ bs, className: "modal-deactivate", title: "Deactivate", body: "Are you sure you want to deactivate this record?", footer: `<button class="primary btn btn-primary" type="button">Deactivate</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
    nativeModal({ bs, className: "modal-activate", title: "Activate", body: "Are you sure you want to activate this record?", footer: `<button class="primary btn btn-primary" type="button">Activate</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
    nativeModal({ bs, className: "modal-disassociate", title: "Disassociate", body: "Are you sure you want to remove this association?", footer: `<button class="primary btn btn-primary" type="button">Remove</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
  ].join("");
}

/*
 * Bootstrap 5 list modals (entity_list template): plain div dialogs whose class, size and
 * title class slots come from the list's dialog settings (CssClass, Size, TitleCssClass).
 */
const MODAL_SIZES = { 1: "modal-lg", 2: "modal-sm" };
function listModalV5({ className, dialog = {}, title, body = "", footer = "", language = {}, labelledBy = "", label = "" }) {
  const css = formText(dialog?.CssClass, "", language);
  const titleCss = formText(dialog?.TitleCssClass, "", language);
  const dismiss = formText(dialog?.DismissButtonSrText, "Close", language);
  const heading = dialog?.Title ? escape(formText(dialog.Title, "", language)) : title;
  return `<div aria-hidden="true" class="modal fade ${className} ${attr(css)}" role="dialog" tabindex="-1"${label ? ` aria-label="${attr(label)}"` : ""}${labelledBy ? ` aria-labelledby="${attr(labelledBy)}"` : ""}><div class="modal-dialog ${MODAL_SIZES[Number(dialog?.Size)] ?? ""}"><div class="modal-content"><div class="modal-header"><h4${labelledBy ? ` id="${attr(labelledBy)}"` : ""} class="modal-title ${attr(titleCss)}">${heading}</h4><button class="btn-close" data-bs-dismiss="modal" type="button"><span aria-hidden="true">&times;</span><span class="visually-hidden">${escape(dismiss)}</span></button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}</div></div></div>`;
}
function gridModalsV5(page, settings = {}, language = {}, listId = "") {
  const formBody = (dialog, hidden = false) => `<div class="form-loading">${escape(formText(dialog?.LoadingMessage, "", language))}</div><iframe${hidden ? ' aria-hidden="true"' : ""} data-page="${attr(page)}" src="about:blank"></iframe>`;
  const confirm = (name, primary, cancel = "Cancel") =>
    `<button class="primary btn btn-primary " type="button">${escape(formText(settings?.[name]?.PrimaryButtonText, primary, language))}</button><button class="cancel btn btn-default " data-bs-dismiss="modal" type="button">${escape(formText(settings?.[name]?.CloseButtonText, cancel, language))}</button>`;
  const deleteAction = (settings.ItemActions ?? []).find((action) => action?.Type === "CrmEntityFormView-DeleteAction");
  const resolve = `<div class="row mb-3"><label class="required col-form-label col-md-3"></label><div class="col-md-9"><input aria-required="true" class="resolution-input required form-control" type="text" aria-label=""></div></div><div class="row mb-3"><label class="required col-form-label col-md-3"></label><div class="col-md-9"><textarea aria-required="true" class="resolution-description-input required form-control" cols="20" rows="6" aria-label=""></textarea></div></div>`;
  return [
    listModalV5({ className: "modal-form modal-form-insert", dialog: settings.CreateFormDialog, title: "<span class='fa fa-edit' aria-hidden='true'></span> Create", body: formBody(settings.CreateFormDialog), language }),
    listModalV5({ className: "modal-form modal-form-edit", dialog: settings.EditFormDialog, title: "<span class='fa fa-edit' aria-hidden='true'></span> Edit", body: formBody(settings.EditFormDialog), language }),
    listModalV5({ className: "modal-form modal-form-details", dialog: settings.DetailsFormDialog, title: "<span class='fa fa-info-circle' aria-hidden='true'></span> View details", body: formBody(settings.DetailsFormDialog, true), language, labelledBy: `modalTitleID_${listId}` }),
    listModalV5({ className: "modal-delete", dialog: settings.DeleteDialog, title: "<span class='fa fa-trash-can' aria-hidden='true'></span> Delete", body: escape(formText(deleteAction?.Confirmation ?? settings.DeleteDialog?.Confirmation, "", language)), footer: confirm("DeleteDialog", "Delete"), language, label: "Delete" }),
    listModalV5({ className: "modal-error", dialog: settings.ErrorDialog, title: "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> Error", footer: `<button class="cancel btn btn-default " data-bs-dismiss="modal" type="button">Close</button>`, language }),
    listModalV5({ className: "modal-form modal-form-createrecord", dialog: settings.CreateRelatedRecordDialog, title: "<span class='fa fa-plus-circle' aria-hidden='true'></span> Create related record", body: formBody(settings.CreateRelatedRecordDialog), language }),
    listModalV5({ className: "modal-run-workflow", title: " Run workflow", body: escape("<p>Are you sure you want to run this workflow?</p>"), footer: confirm("WorkflowDialog", "Run workflow"), language }),
    listModalV5({ className: "modal-deactivate", title: " Deactivate", footer: confirm("DeactivateDialog", "Deactivate"), language }),
    listModalV5({ className: "modal-activate", title: " Activate", footer: confirm("ActivateDialog", "Activate"), language }),
    `<div aria-hidden="true" aria-label="Resolve case" class="modal fade modal-resolvecase  " data-backdrop="static" role="dialog" tabindex="-1"><div class="modal-dialog  "><div class="modal-content"><div class="modal-header"><h4 class="modal-title "> Resolve case</h4><button class="form-close" data-bs-dismiss="modal" tabindex="0" type="button"><span aria-hidden="true">&times;</span><span class="visually-hidden">Close</span></button></div><div class="modal-body">${resolve}</div><div class="modal-footer"><button tabindex="0" class="primary btn btn-success " type="button">Resolve</button><button tabindex="0" class="cancel btn btn-default " data-bs-dismiss="modal" type="button">Cancel</button></div></div></div></div>`,
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
  const v5 = bootstrapMarkup(options.portal.settings).v5;
  if (model.createPage && v5) {
    // Bootstrap 5: the list's create page is the grid's InsertActionLink, beside any configured create action.
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.createPage);
    if (target) model.insertActionLink = { Type: 3, Enabled: true, Target: 2, Label: model.createLabel, Tooltip: "Create", URL: { PathWithQueryString: target.url, Path: target.url }, QueryStringIdParameterName: model.idParameter, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" };
  } else if (model.createPage && !actions.some((action) => action.Type === 3)) {
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.createPage);
    if (target)
      actions.push({ position: "view", Type: 3, Enabled: true, Target: 1, Label: model.createLabel, Tooltip: model.createLabel, URL: { PathWithQueryString: target.url, Path: target.url }, FilterCriteriaId: "00000000-0000-0000-0000-000000000000", ActionIndex: 0 });
  }
  const layouts = gridLayouts(model, { secureBase: { t: "list", w: websiteId, list: model.list.id }, websiteId, metadata: options.metadata, actions, language });
  const settings = model.settings ?? {};
  const identity = context.user ?? context.identity;
  const authenticated = Boolean(identity?.contactId ?? identity?.id);
  const bs = bootstrapMarkup(options.portal.settings);
  const grid = bs.v5 ? listGridV5({ model, settings, layouts, websiteId, identity, authenticated, page, language }) : `<div class="entity-grid entitylist${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-grid-data.json/${websiteId}" data-grid-class="${attr(settings.GridCssClass ?? "table-striped")}" data-select-mode="None" data-selected-view="${attr(model.views[0].id)}" data-view-layouts="${base64Json(layouts)}" data-user-isauthenticated="${authenticated}" data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}" data-mobile-view-enabled="true"><div class="view-grid"></div><div class="view-empty message">${model.emptyText ? model.emptyText : '<div class="alert alert-block alert-warning">There are no records to display.</div>'}</div><div class="view-access-denied message"><div class="alert alert-block alert-danger">You don't have permissions to view these records.</div></div><div class="view-error message"><div class="alert alert-block alert-danger">Error completing request.<span class="details"></span></div></div><div class="view-loading message text-center"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div>${PAGINATION}${gridModals(page, settings, language)}</div>`;
  const filter = model.filter?.enabled ? await renderListFilter(model, context, options) : "";
  const body = filter ? (model.filter.vertical ? `<div class="row"><div class="col-md-3 filter-vertical">${filter}</div><div class="col-md-9">${grid}</div></div>` : filter + grid) : grid;
  const js = model.list.js && (options.renderLiquid ? await options.renderLiquid(model.list.js, context) : model.list.js);
  // A list attached to a legacy ASPX page is the static EntityListControl of the WebForms master.
  const pageControl = options.args?.pp_page_control === true || options.args?.pp_page_control === "true";
  return `<div${pageControl ? ' id="EntityListControl"' : ""} class="entitylist">${body}${js ? `<script type="text/javascript">${js}</script>` : ""}</div>`;
}

/** Bootstrap 5 server markup of a list grid: the messages and dialogs the client fills. */
function listGridV5({ model, settings, layouts, websiteId, identity, authenticated, page, language }) {
  const attributes = [
    ["class", `entity-grid entitylist ${settings.CssClass ?? ""}`],
    // An instance id the platform derives from the render time.
    ["data-id", `${Date.now()}.${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`],
    ["data-column-width-style", Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"],
    ["data-defer-loading", "false"],
    ["data-enable-actions", "true"],
    ["data-get-url", `/_services/entity-grid-data.json/${websiteId}`],
    ["data-get-ai-insights-url", `/_services/entity-grid-ai-summary.json/${websiteId}`],
    ["data-update-url", `/_services/entity-grid-update-entity/${websiteId}`],
    ["data-grid-class", settings.GridCssClass ?? ""],
    ["data-select-mode", "None"],
    ["data-selected-view", model.views[0].id],
    ["data-view-layouts", base64Json(layouts)],
    ["data-user-isauthenticated", String(authenticated)],
    ["data-user-parent-account-name", identity?.parentcustomerid?.name ?? ""],
    ["data-mobile-view-enabled", "false"],
    ["data-ai-insights-enabled", "false"],
    ["data-enable-streaming", "true"],
    ["data-ai-insights-expanded", "true"],
    ["data-is-nl-search-enabled", "false"],
    ["data-ai-insights-position", "top"],
    ["data-nl-search-filter", ""],
  ].map(([name, value]) => ` ${name}="${attr(value)}"`).join("");
  const messages = `<div class="view-grid"></div><div class="view-empty message">There are no records to display.</div><div class="view-empty-maker message">To see records displayed here, choose preview.</div><div class="view-access-denied message"><div class="alert alert-block alert-danger">You don&#39;t have permissions to view these records.</div></div><div class="view-error message"><div class="alert alert-block alert-danger">Error completing request. <span class='details'></span></div></div><div class="view-loading message text-center"><span class='fa fa-spinner fa-spin' aria-hidden='true'></span> Loading...</div>${PAGINATION}`;
  return `<div${attributes}>${messages}${gridModalsV5(page, settings, language, model.list.id)}</div>`;
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
    // Dropdown groups (lookup or choice options) render one select box.
    else if (group.selectionMode === "Dropdown") {
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
  if (!list) {
    missingLiquidComponent('entitylist', options);
    return { context: {}, html: "" };
  }
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
    if (!view) return missingLiquidComponent('entityview', options) ? null : { context: { entityview: null } };
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
  if (kind === 'chart') {
    const markup = observedChartMarkup(options.args, context, options);
    if (markup !== null) return markup;
  }
  if (name == null || name === "") return "";
  if (kind === "entitylist") return renderEntityList(name, context, options);
  if (kind === 'searchindex') observedSearchUnavailable(options);
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
    managedControls: capturedManagedControls = {},
    richTextCompatibility = false,
    renderLiquid,
    metadata,
    modal = false,
  } = options;
  let managedControls = capturedManagedControls;
  const bs = bootstrapMarkup(portal.settings);
  // Labels and messages in the request's website language (context.__language).
  const formLanguage = requestLanguage(context, portal);
  // Number formats follow the request's website language (en-US when it is unknown).
  const languageCode = portalLanguage({ lcid: formLanguage.lcid ?? formLanguage.defaultLcid })?.code ?? "en-US";
  const decimalSeparator = new Intl.NumberFormat(languageCode).formatToParts(1.1).find((part) => part.type === "decimal")?.value ?? ".";
  const formLabel = (value, fallback = "") => formText(value, fallback, formLanguage);
  const pageControl = options.args?.pp_page_control === true || options.args?.pp_page_control === "true";
  const definition = (kind === "webform" ? portal.advancedForms : portal.forms)?.find(
    (item) => item.name === name || canonicalId(item.id) === canonicalId(name),
  );
  let schema = schemas[name] ?? schemas[definition?.id];
  if (!schema && kind === "entityform" && definition) schema = approximateFormSchema({ definition, portal, metadata, diagnostic: options.diagnostic });
  if (kind === "webform" && definition) schema = approximateAdvancedFormSchema({ definition, portal, metadata, schema, diagnostic: options.diagnostic });
  if (!schema && !definition) {
    missingLiquidComponent(kind, options);
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
      if (canonicalId(stepId) === canonicalId(schema.initialStepId)) throw componentError(`Advanced form '${definition?.name ?? name}' has no mapped declared initial step '${stepId}'`, 501, 'ADVANCEDFORM_STEP_UNRESOLVED');
      selected =
        schema.steps.find((step) => canonicalId(step.stepId) === canonicalId(schema.initialStepId) && step.type !== "redirect" && step.type !== "condition") ??
        schema.steps.find((step) => step.type !== "redirect" && step.type !== "condition");
      if (!selected) throw componentError(`Advanced form '${definition?.name ?? name}' has no renderable step in the selected metadata or export`, 501, "ADVANCEDFORM_STEP_UNRESOLVED");
      options.diagnostic?.({ code: "ADVANCEDFORM_STEP_UNRESOLVED", severity: "warning", component: "webform", form: definition?.name ?? name, step: stepId ?? null, rendered: selected.stepId, message: `Advanced form step '${stepId}' of '${definition?.name ?? name}' is absent from the selected metadata and the export; the step '${selected.stepId}' is rendered instead.` });
    }
    if (selected.type === 'condition' && canonicalId(selected.stepId) === canonicalId(schema.initialStepId)) throw componentError(`Advanced form '${definition?.name ?? name}' cannot start with a Condition step`, 501, 'ADVANCEDFORM_INITIAL_CONDITION');
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
  const ids = nativeFormControlIds(kind, definition?.id ?? name, { modal, pageControl });

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
  if (kind === "entityform" && mode === FORM_MODE.insert && !formCreateAllowed(store, schema.entity, identity))
    // Still a basic form control: the page keeps its WebForms server form (live permission-denied captures).
    return ENTITY_FORM_CLIENT_VALIDATE + createAccessDeniedForm({ ids, formName: schema.formName ?? schema.title ?? name, snippet: portal.snippets?.["EntitySecurity/Record/CreateAccessDeniedMessage"] }).replace(/^<div id="[^"]*"/, "$& data-pp-native-form");
  const postback = options.nativePostbackState?.kind === kind && options.nativePostbackState?.formId === definition?.id ? options.nativePostbackState : null;
  // Posted values re-render; an unchanged lookup keeps its record value, which carries the display name.
  if (postback?.values) record = { ...record, ...Object.fromEntries(Object.entries(postback.values).filter(([key, value]) => !(record?.[key] && typeof record[key] === "object" && canonicalId(scalarValue(record[key])) === canonicalId(value)))) };
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
    // Column create/update validity applies to the mode rendered; a read-only rendering (a
    // read-only form or an inactive record) marks no column read-only by it.
    const immutable = mode === FORM_MODE.insert ? field.validForCreate === false : mode === FORM_MODE.edit ? field.validForUpdate === false : false;
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
  // A column placed on the form more than once renders only its first cell (see layout below).
  const byName = new Map();
  for (const field of fields) if (!byName.has(field.name)) byName.set(field.name, field);
  if (richTextCompatibility) {
    managedControls = {...managedControls};
    for (const field of fields) if(field.richText?.name)delete managedControls[field.richText.name];
  }
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
      // An explicit schema default, else the column's exported default (AppDefaultValue).
      if (!field.ignoreDefault && (field.default ?? field.defaultValue) !== undefined) return field.default ?? field.defaultValue;
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
  const currencySymbol = async (currency) => {
    const currencyId = canonicalId(scalarValue(currency));
    if (!currencyId) return "";
    try {
      return (await readProvider.get("transactioncurrency", currencyId, identity))?.currencysymbol ?? "";
    } catch {
      return "";
    }
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
    const emptyOption = (selected) => `<option${selected ? ' selected="selected"' : ""} value=""${postback && mode === FORM_MODE.insert ? "" : ' label="Select" aria-label="Select"'}></option>`;
    const css = field.cssClass ? ` ${attr(field.cssClass)}` : " ";
    const required = field.required && !disabled ? ' aria-required="true"' : "";
    switch (field.control) {
      case "lookup": {
        const name = current?.name ?? "";
        const idValue = canonicalId(scalar);
        const logical = current?.logical_name ?? (idValue && field.targets?.length === 1 ? field.targets[0] : "");
        if (field.hidden)
          return `<input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(idValue)}><input name="${nameAttr(field, "_name")}" type="hidden" id="${attr(field.id)}_name"${valueAttr(name)}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical)}>`;
        if (field.lookupStyle === "dropdown") {
          const choices = field.choices.some((choice) => choice.id === idValue) || !idValue ? field.choices : [{ id: idValue, entity: logical, label: name }, ...field.choices];
          const polymorphic = field.targets?.length > 1;
          const onChange = polymorphic ? "document.getElementById(this.id + '_entityname').value=this.selectedOptions[0]?.dataset.entity || '';setIsDirty(this.id);" : 'setIsDirty(this.id);';
          // Bootstrap 5 marks every dropdown lookup option as a dropdown item.
          const item = bs.v5 ? ' class="dropdown-item"' : "";
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="lookup form-control${css}" onchange="${attr(onChange)}"${field.required ? ' required=""' : ""}${disabled ? ' disabled="disabled" aria-disabled="true"' : ""}${formReadonly}>${emptyOption(false).replace("<option", `<option${item}`)}${choices.map((choice) => `<option value="${attr(choice.id)}"${item}${polymorphic ? ` data-entity="${attr(choice.entity)}"` : ''}${choice.id === idValue ? ' selected="selected"' : ""}>${escape(choice.label)}</option>`).join("")}</select><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical || (field.targets?.length === 1 ? field.targets[0] : ""))}>`;
        }
        if (disabled)
          return `<div><input name="${nameAttr(field, "_name")}" type="text"${valueAttr(name)} id="${attr(field.id)}_name" class="text form-control lookup form-control${bs.v5 && formLevel ? "" : "  readonly"}" readonly="${readOnly ? "readonly" : ""}" aria-readonly="true" aria-labelledby="${attr(field.id)}_label" aria-label="${attr(field.label)}" tabindex="0"><input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(idValue)}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical)}></div>`;
        const lookupBase = { kind: "lookup", views: [], settings: {}, pageSize: Number(portal.settings?.["Portal/Lookup/Modal/Grid/PageSize"]) || 10, search: { enabled: true, placeholder: "Search", tooltip: "To search on partial text, use the asterisk (*) wildcard character. " } };
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
              // A Bootstrap 5 lookup dialog's configuration carries the empty GUID as its id.
              configuration: { ...viewConfiguration(viewModel, view, { actions: [], websiteId, language: formLanguage }), ...(bs.v5 ? { Id: EMPTY_GUID } : {}) },
              secure: { t: "lookup", w: websiteId, kind, form: definition?.id, step: schema.stepId ?? null, field: field.name, view: view.id },
              selectColumn: true,
            });
          });
        } catch (error) {
          if (!/LOOKUP_TARGET_UNRESOLVED|LookupNotBound|FormNotFound|FormSchemaRequired/.test(error.code ?? "")) throw error;
        }
        // The Bootstrap 5 selection column labels its check with visually-hidden text.
        if (bs.v5) for (const layout of layouts) for (const column of layout.Columns ?? []) if (column.Type === 1 && typeof column.Name === "string") column.Name = column.Name.replace("sr-only", "visually-hidden");
        const createForm = field.createFormId && portal.forms?.some((form) => canonicalId(form.id) === field.createFormId) ? field.createFormId : "";
        // Bootstrap 5 drops the input-group-btn wrapper, the search-count announcer and the
        // hidden message styles, and nests the grid's error dialog; Bootstrap 3 keeps its markup.
        const buttons = `<button type="button" class="btn btn-default clearlookupfield" title="${attr(field.label)} Clear lookup field" aria-label="${attr(field.label)} Clear lookup field"${idValue ? "" : ' style="display: none;"'}><span class="${bs.srOnly}">Clear lookup field</span><span class="fa fa-times" aria-hidden="true"></span></button><button type="button" class="btn btn-default launchentitylookup" ${bs.toggle}="tooltip" title="${attr(field.label)} Launch lookup modal" aria-label="${attr(field.label)} Launch lookup modal"><span class="${bs.srOnly}">Launch lookup modal</span><span class="fa fa-search" aria-hidden="true"></span></button>`;
        const authenticated = Boolean(identity?.contactId ?? identity?.id);
        const gridAttributes = bs.v5
          ? `data-mobile-view-enabled="false" data-select-mode="Single" data-selected-view="${attr(layouts[0]?.Configuration?.Id ?? "")}" data-toggle-filter-text="Toggle filter" data-user-isauthenticated="${authenticated}" data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}"`
          : `data-mobile-view-enabled="true" data-select-mode="Single" data-selected-view="${attr(layouts[0]?.Id ?? "")}" data-toggle-filter-text="Toggle filter" data-user-isauthenticated="${authenticated}"`;
        const gridChildren = bs.v5
          ? `<div class="view-grid"></div>${gridMessages(bs)}${PAGINATION}${gridErrorModal(bs)}`
          : `<div role="alert" aria-live="assertive" aria-atomic="true" aria-relevant="additions text" id="SearchCountText${attr(field.id)}" class="sr-only"></div><div class="view-grid"></div>${LOOKUP_GRID_MESSAGES}${PAGINATION}`;
        return `<div class="input-group"${bs.v5 ? "" : ' role="none"'}><input name="${nameAttr(field, "_name")}" type="text"${valueAttr(name)} id="${attr(field.id)}_name" class="text form-control lookup form-control${css}" readonly="" aria-readonly="true" aria-labelledby="${attr(field.id)}_label" aria-label="${attr(field.label)}"><input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(idValue)}${required}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical)}>${bs.v5 ? buttons : `<div class="input-group-btn">${buttons}</div>`}</div><div id="${attr(field.id)}_lookupmodal" class="lookup-modal"><div class="entity-lookup" data-languagecode="1033" data-lookup-datafieldname="${attr(field.id)}" data-lookup-reference_entityformid="${attr(createForm)}" data-url="/_services/entity-lookup-grid-data.json/${websiteId}">${nativeModal({
          bs,
          headingLabel: bs.v5,
          className: "modal-lookup",
          title: "Lookup records",
          label: "Lookup records Dialog",
          size: "modal-lg",
          body: `<div aria-hidden="true" class="modal-error message"${bs.v5 ? "" : ' style="display:none"'}><div class="alert alert-block alert-danger"><p>We're sorry, an error has occurred.</p></div></div><div class="entity-grid" data-allow-filter-off="false" data-apply-related-record-filter="false" data-column-width-style="Percent" data-defer-loading="true" data-enable-actions="false" data-filter-attribute-name="" data-filter-entity-name="" data-filter-relationship-name="" data-get-url="/_services/entity-lookup-grid-data.json/${websiteId}" data-grid-class="" ${gridAttributes} data-view-layouts="${base64Json(layouts)}">${gridChildren}</div>`,
          footer: `${createForm ? `<button type="button" class="btn btn-default ${bs.left} new-value" title="New">New</button>` : ""}<button aria-label="Select" class="primary btn btn-primary" tabindex="0" title="Select" type="button">Select</button><button aria-label="Cancel" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="Cancel" type="button">Cancel</button><button class="btn btn-default ${bs.right} remove-value" title="Remove value" type="button">Remove value</button>`,
        })}${createForm ? nativeModal({ bs, className: "modal-form modal-form-insert modal-lookup-create-form", title: "<span class='fa fa-pencil-square-o' aria-hidden='true'></span> Create", body: formModalBody(`/_portal/modal-form-template-path/${websiteId}`), size: "modal-lg", label: "Create" }) : ""}</div></div>`;
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
        // A read-only form disables the ASP.NET list and box controls: aspNetDisabled wrappers.
        if (classId === RADIO_CLASS)
          return `<span id="${attr(field.id)}" class="${formLevel ? "aspNetDisabled " : ""}boolean-radio${css}" onchange="setIsDirty(this.id);"${field.required ? ' data-required="true"' : ""}${formLevel ? ' disabled="disabled"' : ""}${formReadonly}>${[0, 1].map((bit) => { const radio = `<input id="${attr(field.id)}_${bit}" type="radio" name="${nameAttr(field)}" value="${bit}"${scalar != null && !field.ignoreDefault && bool === Boolean(bit) ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><label for="${attr(field.id)}_${bit}"><span class='${bs.srOnly}'>${escape(field.label)} </span>${escape(label(bit))}</label>`; return formLevel ? `<span class="aspNetDisabled">${radio}</span>` : radio; }).join("")}</span>`;
        return `<span class="${formLevel ? "aspNetDisabled " : ""}checkbox${css}"${formReadonly}><input id="${attr(field.id)}" type="checkbox" name="${nameAttr(field)}"${bs.v5 ? ` aria-label="${attr(field.label)}"` : ""}${bool ? ' checked="checked"' : ""} onclick="setIsDirty(this.id);"${disabled ? ' disabled="disabled"' : ""}></span>`;
      }
      case "picklist": {
        const options = optionsFor(field);
        const selected = scalar == null || scalar === "" ? null : Number(scalar);
        if (field.controlStyle === 100000000 || field.controlStyle === 100000001)
          return `<span id="${attr(field.id)}" class="picklist ${field.controlStyle === 100000000 ? "vertical" : "horizontal"}${css}" role="presentation" onchange="setIsDirty(this.id);"${field.required ? ' data-required="true"' : ""}>${options.map((option, index) => `<input id="${attr(field.id)}_${index}" type="radio" name="${nameAttr(field)}" value="${attr(option.value)}"${Number(option.value) === selected ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><label for="${attr(field.id)}_${index}"><span class='${bs.srOnly}'>${escape(field.label)} </span>${escape(option.label ?? option.value)}</label>`).join(field.controlStyle === 100000000 ? "<br>" : "")}</span>`;
        // PicklistControlTemplate: every option follows an empty "Select" option; a required
        // dropdown carries required="" (the platform app bundle removes it on load).
        const picklistOptions = `${emptyOption(selected == null)}${options.map((option) => `<option${Number(option.value) === selected ? ' selected="selected"' : ""} value="${attr(option.value)}">${escape(option.label ?? option.value)}</option>`).join("")}`;
        // Bootstrap 5 option sets are form-select boxes.
        const selectClass = bs.v5 ? "form-control form-select picklist" : "form-control picklist";
        if (fieldLevel)
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${readOnly ? "aspNetDisabled " : ""}readonly ${selectClass}${css}" onchange="setIsDirty(this.id);" disabled="disabled" aria-disabled="true"${formReadonly}>${picklistOptions}</select><input type="hidden" name="${nameAttr(field, "_Value")}" id="${attr(field.id)}_Value" value="${attr(selected ?? "")}">`;
        if (formLevel)
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="aspNetDisabled ${selectClass}${css}" onchange="setIsDirty(this.id);" disabled="disabled"${formReadonly}>${picklistOptions}</select>`;
        return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${selectClass}${css}" onchange="setIsDirty(this.id);"${field.required ? ' required=""' : ""}>${picklistOptions}</select>`;
      }
      case "state":
      case "status": {
        const option = scalar == null || scalar === "" ? null : (field.options ?? []).find((candidate) => Number(candidate.value) === Number(scalar));
        // The state and status spans carry their values in hidden EntityState/EntityStatus inputs.
        const hiddenValue = bs.v5 ? `<input name="${nameAttr(field, field.control === "state" ? "_EntityState" : "_EntityStatus")}" type="hidden" id="${attr(field.id)}${field.control === "state" ? "_EntityState" : "_EntityStatus"}"${valueAttr(scalar)}>` : "";
        return `<span id="${attr(field.id)}" class="${field.control}${css}">${escape(current?.label ?? option?.label ?? scalar ?? "")}</span>${hiddenValue}`;
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
        // Solution columns use Format=DateAndTime while their generic input
        // type is still "date". The exported format determines the picker.
        const dateOnly = nativeDateOnly(field);
        const format = datePickerFormat(portal.settings?.[dateOnly ? "DateTime/DateFormat" : "DateTime/DateTimeFormat"], dateOnly);
        const behavior = field.dateTimeBehavior ?? field.behavior ?? (dateOnly ? "DateOnly" : "UserLocal");
        const parsed = scalar ? parseDateValue(scalar) : null;
        const iso = parsed ? new Date(parsed.ms).toISOString().replace(/\.\d{3}Z$/, '.0000000' + (behavior === 'UserLocal' ? 'Z' : '')) : scalar ? String(scalar) : "";
        // crmentityformview-datetime.js: a read-only picker keeps its visible box without the
        // input group, the placeholder or the (hidden) calendar button, whose title and label
        // are the Datetimepicker_Datepicker_Label resource.
        return `<input name="${nameAttr(field)}" type="text" id="${attr(field.id)}" class="datetime form-control${css}" data-ui="datetimepicker" data-type="${dateOnly ? "date" : "datetime"}" data-attribute="${attr(field.id)}" data-behavior="${attr(behavior)}"${valueAttr(iso)} style="display: none;"${disabled ? ' readonly="readonly"' : ""}${field.required && !disabled ? ' required=""' : ""} data-sim-date-value><div class="${disabled ? "datetimepicker" : "input-append input-group datetimepicker"}" role="none" data-sim-date-target="${attr(field.id)}" data-sim-date-only="${dateOnly}"><input type="text" data-date-format="${attr(format)}" aria-describedby="${attr(field.id)}_description" id="${attr(field.id)}_datepicker_description" aria-labelledby="${attr(field.id)}_label" onchange="setIsDirty(this.id);" class="form-control input-text-box${disabled ? " readonly" : ""}"${disabled ? ' readonly="readonly"' : ` placeholder="${attr(format)}"`}${field.required && !disabled ? " required" : ""}><span class="input-group-addon${bs.v5 ? " btn" : ""}" tabindex="0" role="button" title="Choose a date"${bs.v5 ? "" : ' aria-label="Choose a date"'}${disabled ? ' style="display: none;"' : ""}><span data-date-icon="icon-calendar fa fa-calendar" data-time-icon="icon-time fa fa-clock${bs.v5 ? "" : "-o"}" class="icon-calendar fa fa-calendar iconBorder"></span></span></div>`;
      }
      case "richtext":
        return richTextInput(field, current, { portal, managedControls, nameAttr });
      case "file":
      case "image":
        return fileColumnInput(field, { id, entity: schema.entity, record, scalar, nameAttr });
      case "textarea":
        // MemoControlTemplate: rows = rowspan * 3 - 2; a maximum length adds the platform's
        // LimitInput/LimitPaste handlers (crmentityformview.js).
        // A one-row cell keeps the two-row (4 line) memo box.
        return `<textarea name="${nameAttr(field)}" rows="${Math.max(Number(field.rowspan) || 2, 2) * 3 - 2}" cols="20"${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ""} id="${attr(field.id)}" class="textarea form-control${css}${fieldLevel ? " readonly" : ""}" onchange="setIsDirty(this.id);"${disabled ? ' readonly="readonly"' : ""}${required}${field.required && !disabled ? ` title="${attr(field.requiredMessage || `${field.label} is a required field.`)}"` : ""} aria-label="${attr(field.label)}"${field.maxLength ? ' onkeydown="javascript:return LimitInput(this, event);" oninput="javascript:return LimitInput(this, event);" onpaste="javascript:return LimitPaste(this, event);"' : ""}>${escape(scalar ?? "")}</textarea>`;
      case "integer":
      case "decimal":
      case "double":
      case "money": {
        const precision = Number(field.precision);
        const displayed = field.control !== "integer" && scalar != null && scalar !== "" && Number.isFinite(Number(scalar)) && field.precision != null && Number.isInteger(precision) && precision >= 0 && precision <= 10
          ? Number(scalar).toFixed(precision)
          : scalar ?? "";
        // Whole numbers formatted as a duration or a language are option lists (blank first).
        const choices = field.control === "integer" ? integerFormatChoices(field, portal) : null;
        if (choices) {
          const selected = scalar == null || scalar === "" ? null : String(scalar);
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${formLevel ? "aspNetDisabled " : ""}integer form-control${css}${fieldLevel ? " readonly" : ""}" onchange="setIsDirty(this.id);"${disabled ? ' disabled="disabled"' : ""}${formReadonly}><option${selected == null ? ' selected="selected"' : ""} value="" label=" "></option>${choices.map((choice) => `<option${String(choice.value) === selected ? ' selected="selected"' : ""} value="${attr(choice.value)}">${escape(choice.label)}</option>`).join("")}</select>`;
        }
        const control = `<input name="${nameAttr(field)}" type="text"${valueAttr(displayed)} id="${attr(field.id)}" class="text ${field.control} form-control${css}${fieldLevel ? " readonly" : ""}"${field.control === "double" ? ` data-numberdecimalseparator="${attr(decimalSeparator)}"` : ""} onchange="setIsDirty(this.id);"${disabled ? ' readonly="readonly"' : ""}${field.required && !disabled ? ' required=""' : ""}>`;
        if (field.control !== "money") return control;
        // A money box shows the record currency's symbol as an input-group addon; without a
        // currency it is a plain wrapper.
        const symbol = await currencySymbol(record?.transactioncurrencyid);
        return symbol ? `<div class="input-group"><span class="${bs.v5 ? "input-group-text" : "input-group-addon"}">${escape(symbol)}</span>${control}</div>` : `<div>${control}</div>`;
      }
      default:
        if (field.hidden && field.control !== "lookup")
          return `<input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(scalar)}>`;
        {
          // String text boxes: e-mail format adds type="email" and the launchEmail handler,
          // phone format the platform placeholder, a maximum length the LengthError keypress
          // check, and a required editable box the required-field title and its label.
          const email = field.control === "email";
          const format = String(field.format ?? "").toLowerCase();
          const phone = format === "phone";
          // Url and ticker symbol formats are url boxes with their launch and change handlers;
          // e-mail, url and ticker boxes are underlined.
          const url = format === "url";
          const ticker = format === "tickersymbol";
          const type = email ? "email" : url || ticker ? "url" : "text";
          const launch = email ? "launchEmail" : url ? "launchUrl" : ticker ? "launchTickerSymbolUrl" : "";
          const change = `setIsDirty(this.id);${url ? `validateUrlInput(this,${Number(field.maxLength) || 0});` : ticker ? "uppercaseTickerSymbol(this);" : ""}`;
          // Bootstrap 5 keeps the required-field attributes of a box a read-only form disables.
          const requiredText = field.required && !(bs.v5 ? fieldLevel : disabled) ? ` aria-required="true" title="${attr(field.requiredMessage || `${field.label} is a required field.`)}" aria-label="${attr(field.label)}"` : "";
          return `<input name="${nameAttr(field)}" type="${type}"${valueAttr(scalar)}${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ""} id="${attr(field.id)}" class="${ticker ? "tickersymbol " : ""}text form-control${css}${fieldLevel ? " readonly" : ""}"${launch ? ` ondblclick="${launch}(this.value);"` : ""} onchange="${change}"${phone ? ' placeholder="Provide a telephone number"' : ""}${disabled ? ' readonly="readonly"' : ""}${requiredText}${field.maxLength ? ' onkeypress="javascript:return LengthError(this, event);"' : ""}${launch ? ' style="text-decoration:underline;"' : ""}>`;
        }
    }
  };

  const renderedFields = new Set();
  const input = async (field) => {
    if (byName.has(field.name)) renderedFields.add(field.name);
    const original = await nativeInput(field);
    // The portal's attribute metadata explicitly enables the desktop PCF from
    // FormXml. Model-driven defaults alone do not activate a portal component.
    if (field.controlStyle !== 756150001 || field.richText || field.hidden) return original;
    const component = field.codeComponent;
    const unsupported = message => {
      options.diagnostic?.({ code: 'PCF_NATIVE_BINDING_UNSUPPORTED', form: definition?.id, field: field.name, sourceFile: component?.sourceFile, message });
      return `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>${original}`;
    };
    if (!component) {
      options.diagnostic?.({ code: 'PCF_NATIVE_BINDING_UNSUPPORTED', form: definition?.id, field: field.name, message: `Code component metadata for ${field.label} has no exported desktop FormXml binding; the native control is rendered.` });
      return original;
    }
    if (!options.codeComponent) return unsupported(`The enabled code component for ${field.label} requires its solution control sources.`);
    if (component.boundAttributes.length !== 1 || component.boundAttributes[0] !== field.name) return unsupported(`Code component ${component.name} must bind only to its native form field ${field.name}.`);
    const args = { disabled: field.readOnly };
    const properties = [], propertyTypes = {};
    for (const [name, parameter] of Object.entries(component.parameters)) {
      if (parameter.kind === 'static') args[name] = parameter.value;
      else if (parameter.kind === 'binding' && parameter.column === field.name) {
        const current = value(field);
        args[name] = field.control === 'lookup'
          ? current ? [{ id: canonicalId(scalarValue(current)), entityType: current.logical_name ?? field.targets?.[0], name: current.name ?? '' }] : []
          : field.control === 'multiselect' ? (Array.isArray(current) ? current.map(scalarValue) : String(scalarValue(current) ?? '').split(',').filter(Boolean)) : scalarValue(current);
        properties.push(name);
        if (parameter.type) propertyTypes[name] = parameter.type;
      } else return unsupported(`Code component ${component.name} has an unresolved or unsupported native property binding: ${name}.`);
    }
    const attributes = Object.fromEntries(Object.entries({
      DisplayName: field.label, LogicalName: field.name,
      RequiredLevel: field.required ? 2 : ({ none: 0, systemrequired: 1, applicationrequired: 2, required: 2, recommended: 3 })[String(field.requiredLevel ?? '').toLowerCase()],
      MaxLength: field.maxLength, MinValue: field.minimum, MaxValue: field.maximum, Precision: field.precision,
      PrecisionSource: field.precisionSource,
      Behavior: ({ UserLocal: 1, DateOnly: 2, TimeZoneIndependent: 3 })[field.dateTimeBehavior],
      Format: field.format, Targets: field.targets, IsSecured: field.isSecured,
      Options: field.options?.map(option => ({ Label: option.label, Value: option.value })),
      DefaultValue: field.defaultValue,
    }).filter(([, item]) => item !== undefined));
    const host = await options.codeComponent({ name: component.name, args, nativeBinding: { id: field.id, control: field.control, properties, propertyTypes, attributes } });
    // Original inputs retain validators, names and the native form postback.
    // The client hides them after a successful mount and reveals them on failure.
    return `<div data-pcf-native-field="${attr(field.id)}"><div data-pcf-native-input>${original}</div>${host}</div>`;
  };

  // Subgrids, quick views and notes cells.
  const extraControls = new Map();
  const subgridLabel = label => options.config?.observed?.subgridLabelMarkup === 'encoded' ? escape(label) : renderFormLabel(label);
  const cells = formCells(schema);
  for (const cell of cells.filter((candidate) => ["quickform", "subgrid", "notes", "webresource"].includes(candidate.type))) {
    if (cell.type === "webresource") {
      // WebResourceControl: an iframe on /_webresource/{name}, labelled by the cell.
      const label = cell.showLabel === false ? "" : `<label for="${attr(cell.id)}" class="field-label">${renderFormLabel(cell.label ?? cell.id)}</label>`;
      extraControls.set(cell.id, `<div class="${bs.info}">${label}</div><div class="control"><iframe id="${attr(cell.id)}" src="/_webresource/${attr(String(cell.url ?? "").replace(/^\/+/, ""))}" width="100%" height="100%" frameborder="${cell.border ? 1 : 0}" scrolling="${attr(cell.scrolling ?? "auto")}"></iframe></div>`);
      continue;
    }
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
      const src = relatedId ? `${path}?entityid=${encodeURIComponent(relatedId)}&entityname=${encodeURIComponent(cell.entity)}&entityprimarykeyname=${encodeURIComponent(target.idColumn)}&formname=${encodeURIComponent(formName)}&controlid=${encodeURIComponent(cell.id)}${bs.v5 ? `&isprofilepage=false&lang=${encodeURIComponent(languageCode)}` : ""}` : "about:blank";
      // The Bootstrap 5 quick view cell is labelled and its frame carries only the platform's data attributes.
      extraControls.set(cell.id, bs.v5
        ? `<div class="${bs.info}">${cell.label ? `<label for="${attr(cell.id)}" class="field-label">${renderFormLabel(cell.label)}</label>` : ""}</div><div class="control"><iframe src="${attr(src)}" id="${attr(cell.id)}" tabindex="0" class="quickform" data-path="${attr(path)}" data-controlid="${attr(cell.id)}" data-formname="${attr(formName)}" data-lookup-element="${attr(cell.lookup)}" role="presentation"></iframe></div>`
        : `<div class="info"></div><div class="control"><iframe src="${attr(src)}" id="${attr(cell.id)}" tabindex="0" class="quickform" data-path="${attr(path)}" data-controlid="${attr(cell.id)}" data-formname="${attr(formName)}" data-lookup-element="${attr(cell.lookup)}" data-entityname="${attr(cell.entity)}" data-entityprimarykeyname="${attr(target.idColumn)}" role="presentation" scrolling="no" title="${attr(cell.label ?? cell.id)}"></iframe></div>`);
      continue;
    }
    if (cell.type === "notes") {
      const row = metadataFor(metadataRows, 100000005, () => true);
      const settings = { ...cell.settings, ...settingsJson(fieldOf(row, "notes_settings")) };
      const target = { objectid: { id, logical_name: schema.entity } };
      for (const [flag, operation] of [["CreateEnabled", "create"], ["EditEnabled", "update"], ["DeleteEnabled", "delete"]]) {
        if (!store.allowed("annotation", operation, target, identity)) settings[flag] = false;
      }
      extraControls.set(cell.id, renderNotesControl({ record, id, entity: schema.entity, websiteId, settings, label: cell.showLabel === false ? null : cell.label, language: formLanguage, bs }));
      continue;
    }
    const label = cell.label ?? cell.id;
    if (!id) {
      // Native subgrids bind to an existing record and render nothing in Insert mode.
      extraControls.set(cell.id, `<h3 class="${bs.info} form-subgrid-heading"><label for="${attr(cell.id)}" class="field-label">${subgridLabel(label)}</label></h3><div class="control"></div>`);
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
        bs,
        className: "modal-associate",
        title: formLabel(model.settings?.LookupDialog?.Title, "Associate"),
        size: "modal-lg",
        body: `<div class="modal-error message" aria-hidden="true"${bs.v5 ? "" : ' style="display:none"'}><div class="alert alert-block alert-danger">We're sorry, an error has occurred.</div></div><div class="entity-grid associate-lookup" data-get-url="/_services/entity-subgrid-data.json/${websiteId}" data-defer-loading="true" data-enable-actions="false" data-select-mode="Multiple" data-column-width-style="Percent" data-grid-class="" data-selected-view="${attr(associateLayouts[0]?.Id ?? "")}" data-view-layouts="${base64Json(associateLayouts)}"><div class="view-grid"></div>${gridMessages(bs)}${PAGINATION}</div><div class="panel panel-default content-panel"><div class="panel-heading"><h4>Selected records</h4></div><div class="panel-body selected-records"></div></div>`,
        footer: `<button class="primary btn btn-primary" type="button">${escape(formLabel(model.settings?.LookupDialog?.PrimaryButtonText, "Add"))}</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>`,
      })}</div>`;
    }
    const settings = model.settings ?? {};
    extraControls.set(
      cell.id,
      `<h3 class="${bs.info} form-subgrid-heading"><label for="${attr(cell.id)}" class="field-label">${subgridLabel(label)}</label></h3><div class="control">${codeComponentNotice}<div id="${attr(cell.id)}" class="subgrid"><div class="entity-grid subgrid${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-subgrid-data.json/${websiteId}" data-grid-class="table-striped${settings.GridCssClass && settings.GridCssClass !== "table-striped" ? " " + attr(settings.GridCssClass) : ""}" data-mobile-view-enabled="${!bs.v5}" data-ref-entity="${attr(schema.entity)}" data-ref-id="${attr(canonicalId(id))}" data-ref-rel="${attr(model.relationship.schemaName ?? cell.relationship)}" data-select-mode="None" data-selected-view="${attr(layouts[0]?.Id ?? "")}" data-update-url="/_services/entity-grid-update-entity/${websiteId}" data-user-isauthenticated="${Boolean(identity?.contactId ?? identity?.id)}"${bs.v5 ? ` data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}"` : ""} data-view-layouts="${base64Json(layouts)}"><div class="view-grid"></div>${gridMessages(bs)}${PAGINATION}${gridModals(`/_portal/modal-form-template-path/${websiteId}`, settings, formLanguage, bs)}${associateHtml}</div></div></div>`,
    );
  }
  const cellControl = async (cell) => {
    if (extraControls.has(cell.id)) return extraControls.get(cell.id);
    const resolved = byName.get(cell.name) ?? cell;
    if (resolved.ownerHidden) return "";
    const fieldValidatorsList = fieldValidators(resolved, { linksEnabled, readOnly });
    validators.push(...fieldValidatorsList);
    const labelFor = (resolved.control === "lookup" && resolved.lookupStyle !== "dropdown") || ["file", "image"].includes(resolved.control) || resolved.control === "boolean" && canonicalId(resolved.controlClassId) === RADIO_CLASS || resolved.control === "picklist" && [100000000, 100000001].includes(resolved.controlStyle) || /^(state|status)$/.test(resolved.control)
      ? ""
      : ` for="${attr(resolved.control === "datetime" ? `${resolved.id}_datepicker_description` : resolved.id)}"`;
    const description = resolved.description?.text ? resolved.description : null;
    const descriptionHtml = (position) => (description && description.position === position ? `<div class="description${position === 100000000 ? " above" : position === 100000001 ? " below" : ""}${resolved.cssClass ? " " + attr(resolved.cssClass) : ""}">${description.text}</div>` : "");
    const labelHtml = resolved.showLabel === false ? "" : `<label${labelFor} id="${attr(resolved.id)}_label" class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${renderFormLabel(resolved.label)}</label>`;
    // CellTemplate: a field-level read-only cell has no validator container; a read-only form
    // keeps its validators (marked read-only). The app bundle then makes the containers of
    // read-only lookups and option sets focusable (lib/platform-app-compat.js).
    const fieldLevelReadOnly = resolved.fieldReadOnly ?? resolved.readOnly;
    // Bootstrap 5 marks a required column required even when it is read-only.
    return `${descriptionHtml(100000002)}<div class="${bs.info}${resolved.required && (bs.v5 || !resolved.readOnly) ? " required" : ""}">${labelHtml}${fieldLevelReadOnly ? "" : `<div class="validators">${validatorMarkup(fieldValidatorsList, { readonly: readOnly })}</div>`}</div>${descriptionHtml(100000000)}<div class="control" data-logical-name="${attr(resolved.name)}">${await input(resolved)}</div>${descriptionHtml(100000001)}`;
  };
  const cellClass = (cell) => {
    if (cell.type === "quickform") return "crmquickform-cell";
    if (cell.type === "subgrid") return "subgrid-cell";
    if (cell.type === "notes") return "notes-cell";
    if (cell.type === "webresource") return "web-resource-cell";
    const field = byName.get(cell.name);
    if (!field) return "";
    switch (field.control) {
      case "file":
      case "image":
        return "";
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
  const placed = new Set();
  if (schema.layout) {
    // CrmEntityFormView reports columns placed more than once (outside hidden sections).
    const seen = new Set();
    const repeated = [];
    for (const tab of schema.layout)
      for (const column of tab.columns)
        for (const section of column.sections.filter((candidate) => !candidate.hidden))
          for (const cell of section.rows.flat())
            if (cell.name && byName.has(cell.name)) {
              if (seen.has(cell.name) && !repeated.includes(cell.name)) repeated.push(cell.name);
              seen.add(cell.name);
            }
    // Listed in the order the columns first appear.
    repeated.sort((a, b) => [...seen].indexOf(a) - [...seen].indexOf(b));
    if (repeated.length) layoutHtml += `<div class="alert alert-danger alert-block">${escape(repeated.join(", "))} field is present multiple times on this form. Only first field will be rendered in the UI</div>`;
    for (const tab of schema.layout) {
      const tabRow = tabMetadata(tab.name);
      const tabLabel = formLabel(fieldOf(tabRow, "label"), tab.label ?? "");
      let tabHtml = tab.showLabel ? `<h2 class="tab-title">${escape(tabLabel)}</h2>` : "";
      tabHtml += `<div${tab.name ? ` data-name="${attr(tab.name)}"` : ""} class="tab clearfix${fieldOf(tabRow, "cssclass") ? " " + attr(fieldOf(tabRow, "cssclass")) : ""}">`;
      for (const column of tab.columns) {
        tabHtml += `<div class="tab-column"${column.width ? ` style="width:${attr(column.width)};"` : ""}><div>`;
        for (const section of column.sections) {
          // A hidden section leaves an empty fieldset.
          if (section.hidden) {
            tabHtml += "<fieldset></fieldset>";
            continue;
          }
          const sectionRow = sectionMetadata(section.name);
          const sectionLabel = formLabel(fieldOf(sectionRow, "label"), section.label ?? "");
          const widths = section.columnWidths ?? [100];
          tabHtml += `<fieldset${sectionLabel ? ` aria-label="${attr(plainText(sectionLabel))}"` : ""}>${section.showLabel ? `<legend class="section-title"><h3>${renderFormLabel(sectionLabel)}</h3></legend>` : ""}<table role="presentation"${section.name ? ` data-name="${attr(section.name)}"` : ""} class="section${fieldOf(sectionRow, "cssclass") ? " " + attr(fieldOf(sectionRow, "cssclass")) : ""}"><colgroup>${widths.map((width) => `<col style="width:${width}%;">`).join("")}<col></colgroup><tbody>`;
          for (const row of section.rows) {
            tabHtml += "<tr>";
            for (const cell of row) {
              const field = byName.get(cell.name);
              // A hidden cell and the repeated cells of a column already on the form render
              // nothing; spacers, the hidden owner and unsupported (Int64) columns an empty cell.
              if (cell.hidden) continue;
              if (cell.name && field) {
                if (placed.has(cell.name)) continue;
                placed.add(cell.name);
              }
              if (cell.spacer || field?.ownerHidden || (field && UNSUPPORTED_FORM_TYPES.test(String(field.dataverseType ?? "")))) {
                tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell"></td>`;
                continue;
              }
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
  const configuredActions = nativeFormActions(componentMetadata);
  const submitAction = configuredActions.find((action) => action.Type === "SubmitAction");
  const submitEnabled = !configuredActions.length || Boolean(submitAction);
  const busy = formLabel(fieldOf(componentMetadata, "submitbuttonbusytext"), "") || formLabel(submitAction?.ButtonBusyLabel, "") || "Processing...";
  const hook = kind === "webform" ? "webFormClientValidate" : "entityFormClientValidate";
  const group = fieldOf(componentMetadata, "validationgroup") ?? "";
  const onclick = (buttonName) =>
    `javascript:if(typeof ${hook} === 'function'){if(${hook}()){if(typeof Page_ClientValidate === 'function'){if(Page_ClientValidate('${group}')){clearIsDirty();disableButtons();this.value = '${busy}';}}else{clearIsDirty();disableButtons();this.value = '${busy}';}}else{return false;}}else{if(typeof Page_ClientValidate === 'function'){if(Page_ClientValidate('${group}')){clearIsDirty();disableButtons();this.value = '${busy}';}}else{clearIsDirty();disableButtons();this.value = '${busy}';}};WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions("${buttonName}", "", true, "${group}", "", false, true))`;
  let actionsHtml = "";
  let defaultButton = "";
  const renderedActions = [];
  if (kind === "webform") {
    const step = schema.metadata ?? {};
    const nextStep = schema.nextStepId ? (advancedSteps ?? schemas[definition?.id]?.steps ?? []).find((candidate) => canonicalId(candidate.stepId) === canonicalId(schema.nextStepId)) : null;
    const terminal = !nextStep || nextStep.type === "redirect";
    const nextLabel = terminal ? formLabel(fieldOf(step, "submitbuttontext"), "Submit") : formLabel(fieldOf(step, "nextbuttontext"), "Next");
    const previousAllowed = stepIndex > 0 && fieldOf(step, "movepreviouspermitted") !== false;
    defaultButton = "NextButton";
    const previous = previousAllowed ? `<div role="group" class="btn-group entity-action-button"><input type="button" name="${attr(ids.buttons)}PreviousButton" value="${attr(formLabel(fieldOf(step, "previousbuttontext"), "Previous"))}" onclick="javascript:__doPostBack('${attr(ids.buttons)}PreviousButton','')" id="PreviousButton" class="${attr(fieldOf(step, "previousbuttoncssclass") || "btn btn-default button previous previous-btn")}"></div>` : "";
    const next = readOnly && terminal ? "" : `<div role="group" class="btn-group entity-action-button"><input type="button" name="${attr(ids.buttons)}NextButton" value="${attr(nextLabel)}" onclick="${attr(onclick(ids.buttons + "NextButton"))}" id="NextButton" class="${attr(terminal ? fieldOf(step, "submitbuttoncssclass") || "btn btn-primary button next submit-btn" : fieldOf(step, "nextbuttoncssclass") || "btn btn-primary button next submit-btn")}"></div>`;
    if (previous) renderedActions.push({ button: "PreviousButton", action: "previous" });
    if (next) renderedActions.push({ button: "NextButton", action: "submit" });
    actionsHtml = previous || next ? `<div class="actions"><div class="col-sm-6 clearfix">${previous}${next}</div></div>` : "";
  } else if (!readOnly && submitEnabled) {
    const button = mode === FORM_MODE.insert ? "InsertButton" : "UpdateButton";
    renderedActions.push({ button, action: "submit" });
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
  if (kind === 'entityform' && id) {
    const buttons = [];
    for (const [index, action] of configuredActions.entries()) {
      const entry = Object.entries(NATIVE_STATE_ACTIONS).find(([, value]) => value.type === action.Type);
      if (!entry) {
        if (action.Type !== 'SubmitAction') options.diagnostic?.({ code: 'FORM_ACTION_UNSUPPORTED', severity: 'warning', component: 'entityform', form: definition?.name ?? name, action: action.Type, message: `Native form action '${action.Type}' is unsupported.` });
        continue;
      }
      const [operation, descriptor] = entry;
      if (Number(scalarValue(record?.statecode)) === descriptor.state) continue;
      if (store.allowed && !store.allowed(mapping.logicalName, 'update', record, identity)) continue;
      if (action.FilterCriteria || !nativeActionStateValues(schema.entity, operation, { metadata, store, schema })) {
        options.diagnostic?.({ code: 'FORM_ACTION_UNRESOLVED', severity: 'warning', component: 'entityform', form: definition?.name ?? name, action: action.Type, message: `Native form action '${action.Type}' requires resolved state/status metadata and supported filter criteria.` });
        continue;
      }
      const label = formLabel(action.ButtonLabel, descriptor.label), confirmation = formLabel(action.Confirmation, '');
      const handler = `${confirmation ? `if(!window.confirm(${json(confirmation)}))return false;` : ''}__doPostBack(${json(ids.buttons + descriptor.button)},'')`;
      renderedActions.push({ button: descriptor.button, action: operation, actionIndex: index });
      buttons.push(`<input type="button" name="${attr(ids.buttons + descriptor.button)}" id="${descriptor.button}" value="${attr(label)}" title="${attr(formLabel(action.ButtonTooltip, label))}" class="${attr(action.ButtonCssClass || 'btn btn-primary button')}" data-pp-action-index="${index}" onclick="${attr(handler)}">`);
    }
    if (buttons.length) actionsHtml += `<div class="actions native-record-actions">${buttons.join('')}</div>`;
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
    // Bootstrap 5 success panels carry the platform's close button (named like the form buttons).
    ...(bs.v5 ? { messagePanel: { className: SUCCESS_PANEL_V5, closeButton: messageCloseButton(ids.buttons, bs) } } : {}),
    ...((options.observed ?? portal.observed)?.nativeFormTransport === 'postback' ? { transport: 'postback' } : {}),
    fields: fields
      .filter((field) => !field.ownerHidden && !field.readOnly && !["state", "status", "file", "image"].includes(field.control))
      .map((field) => ({ name: field.name, id: field.id, control: controlForSubmit(field), readOnly: false, bindings: field.bindings })),
  };
  const summaryId = `ValidationSummary${ids.view}`;
  const summaryHeader = "<h2 class='validation-header'><span role='presentation' class='fa fa-info-circle'></span> The form could not be submitted for the following reasons:</h2>";
  const layoutConfig = {
    EntityName: schema.entity,
    // The Bootstrap 5 platform renders the empty GUID as the layout id.
    Id: bs.v5 ? EMPTY_GUID : definition?.id ?? null,
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
  const entityFormClass = readOnly ? "form-readonly entity-form" : postback && mode === FORM_MODE.insert ? "entity-form entity-form" : "entity-form";
  // An editable basic form carries the platform's off-screen honeypot box. The platform names it with a
  // per-render token; the local token is derived from the form and record so renders stay repeatable.
  const trap = createHash("sha256").update(`${definition?.id ?? name}:${id ?? ""}`).digest("hex").slice(0, 8);
  const honeypot = kind === "entityform" && !readOnly ? `<div class="frm-g-${trap}" style="position:absolute;left:-9999px;top:-9999px;opacity:0;height:0;overflow:hidden;" aria-hidden="true"><label for="frm_pref_${trap}">Leave this field blank</label><input name="${attr(ids.names)}frm_pref_${trap}" type="text" id="frm_pref_${trap}" tabindex="-1" autocomplete="off"></div>` : "";
  let formHtml = `<div id="${attr(ids.panel)}" class="${panelClass}" data-form-name="${attr(schema.formName ?? schema.title ?? name)}"${defaultButton ? ` onkeypress="javascript:return WebForm_FireDefaultButton(event, '${defaultButton}')"` : ""} role="form" aria-label="${kind === "webform" ? "Multistep Form" : "Basic Form"}"><div id="${attr(ids.view)}" class="${entityFormClass}"${readOnly ? ' readonly="readonly"' : ""}>${hidden("EntityName", schema.entity)}${hidden("EntityID", id ? canonicalId(id) : "")}${hidden("EntityState", scalarValue(record?.statecode) ?? "")}${hidden("EntityStatus", scalarValue(record?.statuscode) ?? "")}<span id="${attr(ids.view)}_EntityLayoutConfig" data-form-layout="${attr(JSON.stringify(layoutConfig))}"></span><div id="${attr(summaryId)}" class="${attr(fieldOf(componentMetadata, "validationsummarycssclass") || "validation-summary alert alert-error alert-danger alert-block")}" role="alert" style="${postback?.validationErrors ? "" : "display:none;"}"${readOnly ? ' readonly="readonly"' : ""}>${postback?.validationErrors ? summaryHeader + "<ul>" + postback.validationErrors.map(item => `<li><a href="#${attr(item.field)}_label">${escape(item.message)}</a></li>`).join("") + "</ul>" : ""}</div>${layoutHtml}${attachHtml}${honeypot}</div>${actionsHtml}</div>`;
  if (postback?.outcome?.type === 'message') {
    const message = bs.v5
      ? `<div id="MessagePanel" class="${SUCCESS_PANEL_V5}" role="alert">${messageCloseButton(ids.buttons, bs)}<span id="MessageLabel">${postback.outcome.message}</span></div>`
      : `<div id="MessagePanel" class="message alert alert-info success alert alert-success success alert alert-success" role="alert"><span id="MessageLabel">${postback.outcome.message}</span></div>`;
    formHtml = message + (postback.outcome.hideForm !== false ? "" : formHtml);
  }
  if (postback?.outcome?.type === 'error')
    formHtml = formErrorPanel(postback.outcome, { v5: bs.v5, closeButton: bs.v5 ? messageCloseButton(ids.buttons, bs) : "" }) + formHtml;
  const progressTop = progress && progress.position !== "bottom" ? progress.html : "";
  const progressBottom = progress && progress.position === "bottom" ? progress.html : "";
  // Native order: validation runtime and default hook before the control, custom
  // JavaScript first inside the control, validator expandos after the markup.
  const runtime = `<script src="${NATIVE_FORMS_SCRIPT}"></script>${kind === "webform" ? "" : ENTITY_FORM_CLIENT_VALIDATE}`;
  if (options.onNativePostbackDescriptor) {
    const writable = fields.filter((field) => renderedFields.has(field.name) && !field.readOnly && !field.ownerHidden && !field.disabled && !["file", "image"].includes(field.control));
    const descriptor = nativeFormPostbackDescriptor({ kind, formId: definition?.id ?? name, fields: writable, actions: renderedActions, modal, pageControl });
    Object.freeze(descriptor.ids);
    for (const field of descriptor.fields) Object.freeze(field);
    for (const action of descriptor.actions) Object.freeze(action);
    Object.freeze(descriptor.fields);
    Object.freeze(descriptor.actions);
    Object.freeze(descriptor);
    const resolved = nativeFormSubmissionContext({ kind, formId: definition?.id ?? name, entity: schema.entity, mode, recordId: id ? canonicalId(id) : null, stepId: schema.stepId ?? null, sessionId: session?.id ?? null, recordQueryName: queryName });
    // The callback is an internal request collector. Its return value cannot change HTML,
    // and only the service-resolved context accompanies the successful-control names.
    await options.onNativePostbackDescriptor(Object.freeze({ descriptor, context: resolved }));
  }
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

function renderNotesControl({ record, id, entity, websiteId, settings, label, language = {}, bs = BOOTSTRAP_MARKUP.BootstrapV3 }) {
  const info = `<div class="${bs.info}">${label === null ? "" : `<label for="notescontrol">${escape(label ?? "Notes")}</label>`}</div>`;
  if (!id) return `${info}<div class="control"><div id="notescontrol"></div></div>`;
  const page = (name, fallback) => formText(settings?.[name], fallback, language);
  const addEnabled = settings.CreateEnabled !== false;
  if (bs.v5) return `${info}<div class="control"><div id="notescontrol">${notesControlV5({ record, id, entity, websiteId, settings, page, addEnabled, bs })}</div></div>`;
  return `${info}<div class="control"><div id="notescontrol"><div class="col-md-8 entity-notes" data-url-get="/_services/entity-notes/${websiteId}" data-url-add="/_services/entity-form-addnote/${websiteId}" data-url-edit="/_services/entity-form-updatenote/${websiteId}" data-url-delete="/_services/entity-form-deletenote/${websiteId}" data-url-get-attachments="" data-add-enabled="${addEnabled ? "True" : "False"}" data-edit-enabled="${settings.EditEnabled === true ? "True" : "False"}" data-delete-enabled="${settings.DeleteEnabled === true ? "True" : "False"}" data-use-scrolling-pagination="False" data-hide-field-label="False" data-orders='[{"Attribute":"createdon","Alias":null,"Direction":null}]' data-target="${attr(JSON.stringify({ Id: canonicalId(id), LogicalName: entity, Name: record?.name ?? null }))}" data-pagesize="${Number(settings.PageSize) || 10}"><div class="notes-empty message"><div class="alert alert-block alert-info">${escape(page("EmptyMessage", "There are no notes to display."))}</div></div><div class="notes-access-denied message"><div class="alert alert-block alert-danger">You don't have permissions to view these notes.</div></div><div class="notes-error message"><div class="alert alert-block alert-danger">An error occurred while loading notes.<span class="details"></span></div></div><div class="notes-loading message text-center"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div><div class="notes" tabindex="0"></div><div class="note-actions row"><div class="col-sm-3">${addEnabled ? `<a class="btn btn-default addnote" href="#">${escape(page("AddNoteButtonLabel", "Add a note"))}</a>` : ""}</div><div class="notes-pagination col-sm-9" data-pages="1" data-pagesize="${Number(settings.PageSize) || 10}" data-current-page="1"></div></div>${nativeModal({ bs, className: "modal-addnote", title: "Add a note", body: `<div class="addnote form-horizontal"><div class="form-group"><label id="note_label" class="col-sm-3 control-label required" for="note-text">Note</label><div class="col-sm-9"><textarea id="note-text" name="text" class="form-control" cols="20" rows="6"></textarea></div></div><div class="form-group"><label class="col-sm-3 control-label" for="note-file">Attach a file</label><div class="col-sm-9 form-control-static"><input id="note-file" name="file" type="file"></div></div></div>`, footer: `<button class="primary btn btn-primary" type="button">Add Note</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` })}${nativeModal({ bs, className: "modal-editnote", title: "Edit note", body: `<div class="editnote form-horizontal"><div class="form-group"><label class="col-sm-3 control-label required" for="note-edit-text">Note</label><div class="col-sm-9"><textarea id="note-edit-text" name="text" class="form-control" cols="20" rows="6"></textarea></div></div><div class="form-group"><label class="col-sm-3 control-label" for="note-edit-file">Attach a file</label><div class="col-sm-9 form-control-static"><input id="note-edit-file" name="file" type="file"></div></div></div>`, footer: `<button class="primary btn btn-primary" type="button">Update Note</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` })}${nativeModal({ bs, className: "modal-delete modal-deletenote", title: "Delete note", body: "Are you sure you want to delete this note?", footer: `<button class="primary btn btn-primary" type="button">Delete</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` })}</div></div></div>`;
}

/**
 * Bootstrap 5 notes control (the platform's timeline-less notes list): plain status messages,
 * the list title, and add/edit/delete dialogs with the platform's fixed labels. The platform's
 * data-attachmentsettings is an encrypted value and is not reproduced.
 */
function notesControlV5({ id, entity, websiteId, settings, page, addEnabled, bs }) {
  const pageSize = Number(settings.PageSize) || 10;
  const orders = (settings.ListOrders?.length ? settings.ListOrders : [{ Attribute: "createdon", Direction: "Descending" }]).map((order) => ({
    Attribute: order.Attribute,
    Alias: order.Alias ?? null,
    Direction: /^desc/i.test(String(order.Direction)) || Number(order.Direction) === 1 ? 1 : 0,
  }));
  const regarding = { Id: canonicalId(id), LogicalName: entity, Name: null, KeyAttributes: [], RowVersion: null };
  // The dialogs carry the regarding record as indented JSON with CRLF line breaks.
  const dialogTarget = JSON.stringify({ LogicalName: entity, Id: canonicalId(id) }, null, 2).replace(/\n/g, "\r\n");
  const message = (className, name, fallback) => `<div class="${className}" role="presentation" tabindex="0">${escape(page(name, fallback))}</div>`;
  const loading = escape(page("LoadingMessage", "Loading..."));
  const button = (label, primary = false) => `<button aria-label="${attr(label)}" class="${primary ? "primary btn btn-primary" : "cancel btn btn-default"}"${primary ? "" : ` ${bs.dismiss}="modal"`} tabindex="0" title="${attr(label)}" type="button">${escape(label)}</button>`;
  const noteRow = (labelHtml, textarea) => `<div class="row mb-3">${labelHtml}<div class="col-md-9"><textarea aria-label="Note" class="form-control" cols="20"${textarea} name="text" rows="9" tabindex="0"></textarea></div></div>`;
  const fileRow = (wrapper, accept) => `<div class="row mb-3"><label aria-label="Attach a file" class="col-form-label fw-bold col-md-3">Attach a file</label><div class="col-md-9"${wrapper}><div class="form-control-plaintext"><input${accept} aria-label="Choose File" name="file" tabindex="0" type="file"></div></div></div>`;
  const deleteTitle = "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete note";
  return `<div class="col-lg-8 entity-notes" data-add-accept-types="*" data-add-enabled="${addEnabled ? "True" : "False"}" data-bs-target="${attr(JSON.stringify(regarding))}" data-delete-enabled="${settings.DeleteEnabled === true ? "True" : "False"}" data-edit-enabled="${settings.EditEnabled === true ? "True" : "False"}" data-hide-field-label="False" data-is-timeline="False" data-orders="${attr(JSON.stringify(orders))}" data-pagesize="${pageSize}" data-rte-enabled="False" data-url-add="/_services/entity-form-addnote/${websiteId}" data-url-delete="/_services/entity-form-deletenote/${websiteId}" data-url-edit="/_services/entity-form-updatenote/${websiteId}" data-url-get="/_services/entity-notes/${websiteId}" data-url-get-attachments="" data-url-get-attachments-count="" data-use-scrolling-pagination="False" disable-validation="false">${page("ListTitle", "") ? `<div class="col-md-12 page-header mr-0"><h3>${escape(page("ListTitle", ""))}</h3></div>` : ""}${message("notes-empty message", "EmptyMessage", "There are no notes to display.")}${message("notes-access-denied message", "AccessDeniedMessage", "You don't have permissions to view these notes.")}${message("notes-error message", "ErrorMessage", "An error occurred while loading notes.")}<div class="notes-loading message text-center" role="presentation" tabindex="0">${loading}</div><div class="notes"></div><div class="notes-loading-more message text-center">${loading}</div><div class="note-actions row"><div class="col-md-3">${addEnabled ? `<a class="addnote btn btn-default" href="#" role="button">${escape(page("AddNoteButtonLabel", "Add a note"))}</a>` : ""}</div><div class="notes-pagination col-md-9" data-current-page="1" data-pages="1" data-pagesize="${pageSize}"></div></div>${nativeModal({
    bs,
    className: "modal-addnote",
    title: "Add note",
    body: `<div class="  addnote" data-bs-target="${attr(dialogTarget)}" data-url="/_services/entity-form-addnote/${websiteId}">${noteRow('<label class="col-form-label fw-bold col-md-3" id="note_label_add">Note</label>', ' maxlength="100000"')}${fileRow("", ' accept="*"')}</div>`,
    footer: `${button(" Add note", true)}${button("Cancel")}`,
  })}${nativeModal({
    bs,
    className: "modal-editnote",
    title: "Edit note",
    body: `<div class="  editnote" data-bs-target="${attr(dialogTarget)}" data-url="/_services/entity-form-updatenote/${websiteId}">${noteRow('<label class="required col-form-label fw-bold col-md-3" id="note_label_edit">Note</label>', "")}${fileRow(' tabindex="0"', "")}</div>`,
    footer: `${button("Update note", true)}${button("Cancel")}`,
  })}${nativeModal({ bs, className: "modal-delete modal-deletenote", title: deleteTitle, label: deleteTitle, body: "<p>Are you sure you want to delete this note?</p>", footer: `${button("Delete", true)}${button("Cancel")}` }).replace(` title="${attr(plainText(deleteTitle))}"`, ` title="${attr(deleteTitle)}"`)}</div>`;
}

// The platform file and image controls' upload size argument (KB) as the live controls render it.
const FILE_CONTROL_MAX_KB = 1048576;
/**
 * File and image column controls: before the record exists a notice; afterwards the platform's
 * hidden file input, choose/delete buttons and the hidden state inputs the upload script fills.
 * The platform names the file input after a generated control index; the column id is used here.
 */
function fileColumnInput(field, { id, entity, record, scalar, nameAttr }) {
  const fieldId = field.id;
  const image = field.control === "image";
  const hiddenNames = image ? ["", "_image_size", "_image_change", "_record_id"] : ["_filename", "_filetype", "_record_id", "_file_id", "_file_change", "_file_size"];
  const fileName = record?.[`${field.name}_name`] ?? "";
  const values = { _record_id: id ? canonicalId(id) : "", _filename: fileName, _file_id: !image && scalar ? canonicalId(scalar) : "" };
  const hidden = hiddenNames.map((suffix) => `<input type="hidden" name="${nameAttr(field, `hidden${suffix}`)}" id="${attr(fieldId)}hidden${suffix}"${valueAttr(values[suffix])}>`).join("");
  const validator = image ? "" : `<span id="FileValidator${attr(fieldId)}hidden_filename" style="display:none;"></span>`;
  if (!id) return `<div><div>${escape(image ? "This record hasn't been created yet. To enable image upload, create this record" : "This record hasn't been created yet. To enable file upload, create this record.")}</div></div>${hidden}${validator}`;
  const trash = "<span class='fa fa-trash iconforimage'></span>Delete";
  if (image)
    return `<div><input name="${nameAttr(field, "_input_file")}" type="file" accept="image/*" id="${attr(fieldId)}" aria-label="${attr(field.name)}" style="display:none" onchange="imageLoad(this, '1', '${FILE_CONTROL_MAX_KB}');"><div><button id="${attr(fieldId)}_input_image" type="button" class="btn btn-default btn-for-image-input btn-for-inputofimage" onclick="chooseImage(this, '${attr(fieldId)}');">Choose File</button><div class="gap-between-vertical-element break-image-name">No file selected</div></div></div><div><div class="image-inline" style="display:none"><a target="_blank"><img src="" height="144px" width="144px" class="image-render" alt="${attr(field.label)}"></a></div><div><button type="button" class="buttonfordeleteimage btn btn-default btnforimage" onclick="deleteImage(this, '${attr(fieldId)}');" style="display:none">${trash}</button></div></div>${hidden}`;
  const download = fileName ? `/File/download.aspx?Entity=${encodeURIComponent(entity ?? "")}&Attribute=${encodeURIComponent(field.name)}&Id=${canonicalId(id)}` : "";
  return `${validator}<div class="file-control-container"><div class="container-file-input"><div><input type="file" name="${nameAttr(field, "_input_file")}" id="${attr(fieldId)}_input_file" aria-label="${attr(field.label)}" onchange="fileLoad(this, '${attr(fieldId)}', '${FILE_CONTROL_MAX_KB}', '1');" style="display:none"><button id="${attr(fieldId)}" type="button" class="btn btn-default btn-for-file-input " onclick="chooseFile(this, '${attr(fieldId)}');" aria-labelledby="Choose File" aria-label="Choose File for ${attr(field.label)}">${fileName ? "Change File" : "Choose File"}</button></div></div><div class="container-filelink-delete file-link-and-delete"><div class="break-file-name file-name-container">${fileName ? `<a href="${attr(download)}"><span id="${attr(fieldId)}_file_name">${escape(fileName)}</span></a><div style="display:none">No file selected</div>` : "<div>No file selected</div>"}</div>${fileName ? `<div><button id="${attr(fieldId)}_delete_button" type="button" class="btn btn-default btn-for-delete btn-without-border" onclick="deleteFile(this, '${attr(fieldId)}');">${trash}</button></div>` : ""}</div></div>${hidden}`;
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
    .map((field) => `<tr><td colspan="1" rowspan="1" class="clearfix cell text form-control-cell"><div class="info"><label for="${attr(field.name)}" id="${attr(field.name)}_label" class="field-label">${renderFormLabel(field.label ?? field.name)}</label></div><div class="control" data-logical-name="${attr(field.name)}"><input type="text" id="${attr(field.name)}" readonly="readonly" class="text form-control readonly" value="${attr(display(record[field.name]))}"></div></td><td class="cell zero-cell"></td></tr>`)
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
