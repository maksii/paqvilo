import { decodeXml, portalField } from "./importer.mjs";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
import { systemFormSchemaFor } from "./solution-metadata.mjs";
import { hasPlatformBundles, bootstrapVariant } from "./platform-manifest.mjs";
import { portalLanguage } from "./portal-languages.mjs";
import { clientPortalObjectRuntime } from "./portal-client-object.mjs";
import { parseDateValue } from "./dataverse-values.mjs";
import { nativeFormActions } from './native-form-actions.mjs';
import { timeZoneChoices } from "./platform-time-zones.mjs";
import { missingLiquidComponent, observedChartMarkup, observedSearchUnavailable } from './liquid-service-observations.mjs';
import { compactNativeControlId as compactId, nativeFormControlIds, nativeFormPostbackDescriptor, nativeFormTransport, encodeNativeViewState } from './native-postback.mjs';
import { renderCalendarList } from "./list-views.mjs";
import { LiquidError } from "./liquid-engine.mjs";
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
    // The local postback verification token: native postbacks carry it without the token request
    // live never makes for a postback (lib/webforms-compat.js reads it before shell.getTokenDeferred).
    simulation.postbackToken=token;
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
/**
 * A native form control the platform cannot render aborts the server form's content: the
 * control's output stops at the failed cell (closing the section wrapper, column and tab; a
 * bottom progress indicator lands after the wrapper), the Liquid closing tags directly after the
 * control still appear, then the server form ends (live evidence: an inline web resource, a quick
 * view on a postback-rendered step, a control id clashing with a reference entity's read-only
 * form). lib/platform-manifest.mjs webFormsForm cuts the content after this marker.
 */
export const RENDER_ABORT_MARKER = "<!--paqvilo-mirage-render-aborted-->";
/** A form showing a captcha to the visitor (lib/platform-manifest.mjs registers its script resources). */
export const CAPTCHA_MARKER = "<!--pp-captcha-->";
const RADCAPTCHA_VERSION = "2026.2.708.462";
const CAPTCHA_ERROR = "<a href='#captcha' onclick='javascript:scrollToAndFocusCapatch();return false;'>Captcha is incorrect, please re-enter captcha.</a>";
/** The application root relative to a page path, as ASP.NET writes control URLs ("/a/b/" → "../../"). */
const applicationRoot = (pathname) => "../".repeat(Math.max(0, String(pathname).split("/").length - 2));
/**
 * The refreshable part of the Telerik RadCaptcha control (its update panel ctl01): the image, the
 * refresh link and the audio link of one challenge, named after the control's unique id
 * ("…$captcha"); the challenge guid is per render. Mirage serves a placeholder image and
 * silent audio and accepts no answer (native-form-submission.mjs rejects a captcha step).
 */
export function captchaChallenge(unique, pathname, guid = randomUUID(), selfClose = false) {
  const client = unique.replace(/\$/g, "_");
  const resource = (type) => `${applicationRoot(pathname)}Telerik.Web.UI.WebResource.axd?type=${type}&amp;isc=cust&amp;guid=${guid}`;
  return `<img id="${client}_CaptchaImageUP" alt="This&#32;is&#32;a&#32;CAPTCHA&#32;image,&#32;use&#32;shortcut&#32;Ctrl&#32;+&#32;Alt&#32;+&#32;P&#32;to&#32;play&#32;the&#32;alphabet&#32;audio&#32;for&#32;this&#32;image" src="${resource("rca")}" style="height:50px;width:180px;display:block;"${selfClose ? " /" : ""}><a id="${client}_CaptchaLinkButton" class="rcRefreshImage" title="Generate&#32;a&#32;new&#32;image" href="javascript:__doPostBack(&#39;${unique}$CaptchaLinkButton&#39;,&#39;&#39;)" style="display:block;">Generate a new image</a><a href="${resource("cah")}" id="${client}_CaptchaAudioCodeUP" title="Play&#32;the&#32;audio&#32;code" class="rcCaptchaAudioLink" style="display:block;">Play the audio code</a>`;
}
/** The RadCaptcha control after a form's honeypot box (live captcha forms); rcInvalid after a rejected answer. */
function captchaControl(unique, pathname, invalid = false) {
  const client = unique.replace(/\$/g, "_");
  return `<div class="tr"><div class="captcha-cell"><div id="${client}" class="RadCaptcha&#32;RadCaptcha_Default${invalid ? "&#32;rcInvalid" : ""}">\n\t\t\t\t<!-- ${RADCAPTCHA_VERSION} --><span id="${client}_ctl00" style="display:none;"></span><div id="${client}_SpamProtectorPanel">\n\t\t\t\t\t<div id="${client}_ctl01">\n\t\t\t\t\t\t${captchaChallenge(unique, pathname)}\n\t\t\t\t\t</div><p><input name="${unique}$CaptchaTextBox" type="text" maxlength="7" id="${client}_CaptchaTextBox"><label for="${client}_CaptchaTextBox" id="${client}_CaptchaTextBoxLabel">Enter the code from the image</label></p>\n\t\t\t\t</div><input id="${client}_ClientState" name="${client}_ClientState" type="hidden">\n\t\t\t</div></div></div>`;
}
/**
 * The ASP.NET AJAX delta answer of the captcha refresh postback (live: the platform's
 * radcaptcha.onClientLoad refreshes the challenge once the control loads). The page's hidden
 * fields travel back as posted (__VIEWSTATE keeps the anti-forgery key).
 */
export function captchaRefreshDelta(unique, pathname, posted = new URLSearchParams()) {
  const segment = (type, id, content) => `${content.length}|${type}|${id}|${content}|`;
  const panel = `${unique}$ctl01`;
  const announce = "$('a.rcRefreshImage').parent().append('<div class=\"alert sr-only\" role=\"alert\"  aria-label=\"The new image is ready\"><span aria-hidden=\"true\">The new image is ready</span></div>');$(document).keydown(function(event){if(event.altKey && event.ctrlKey &&event.key == 'p'){$('.RadCaptcha').find('audio').first()[0].play();}});";
  return segment("#", "", "4") + segment("updatePanel", panel.replace(/\$/g, "_"), captchaChallenge(unique, pathname, randomUUID(), true)) +
    segment("hiddenField", "__EVENTTARGET", "") + segment("hiddenField", "__EVENTARGUMENT", "") +
    ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__VIEWSTATEENCRYPTED", "__EVENTVALIDATION"].filter((name) => posted.has(name)).map((name) => segment("hiddenField", name, posted.get(name))).join("") +
    segment("asyncPostBackControlIDs", "", `${unique}$CaptchaLinkButton,`) + segment("postBackControlIDs", "", "") +
    segment("updatePanelIDs", "", `t${panel},`) + segment("childUpdatePanelIDs", "", "") + segment("panelsToRefreshIDs", "", `${panel},`) +
    segment("asyncPostBackTimeout", "", "90") + segment("formAction", "", pathname) + segment("scriptStartupBlock", "ScriptContentNoTags", announce);
}
// The basic form control registers its custom client-validation hook, also ahead of a create denial.
const ENTITY_FORM_CLIENT_VALIDATE = `<script type="text/javascript">function entityFormClientValidate() { // Custom client side validation. Method is called by the submit button's onclick event.\n// Must return true or false. Returning false will prevent the form from submitting.\nreturn true; }</script>`;

/** A __VIEWSTATE value with the anti-forgery key: Mirage's own payload gains k; any other becomes {v:1,k}. */
export function viewStateWithKey(value, key) {
  let state = null;
  if (String(value).startsWith("/wE")) {
    try { state = JSON.parse(Buffer.from(String(value).slice(3), "base64").toString("utf8")); } catch { state = null; }
  }
  return "/wE" + Buffer.from(JSON.stringify(state && typeof state === "object" && state.v === 1 ? { ...state, k: key } : { v: 1, k: key })).toString("base64");
}

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
  // The trace id travels in the x-sim-trace-id header and the runtime script only: a meta
  // element would shift every head child the platform renders (charset, viewport, links).
  const script = `<script data-paqvilo-mirage-runtime>${clientRuntime(token, revision, identity, traceId, pageSite(html))}</script>`;
  // The server form's __VIEWSTATE carries the visitor's anti-forgery key (k), as ASP.NET binds
  // ViewState to the visitor (ViewStateUserKey): WebForms postbacks then post the page's own
  // fields only (live bodies carry no __RequestVerificationToken; lib/native-postback.mjs
  // nativeViewStateKey, lib/webforms-compat.js).
  // Decode the attribute once: chained replacements would decode nested entities twice.
  if (token) html = html.replace(/(<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value=")([^"]*)(")/g, (_match, open, value, close) => `${open}${attr(viewStateWithKey(value.replace(/&(?:amp|quot);/g, entity => entity === '&amp;' ? '&' : '"'), token))}${close}`);
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
    .map((validator) => `<span id="${attr(validator.id)}"${validator.isvalid === "False" ? "" : ` style="${validator.display === "Dynamic" || validator.display === "None" ? "display:none;" : "visibility:hidden;"}"`}${readonly ? ' readonly="readonly"' : ""}>${validator.id.startsWith("RegularExpressionValidator") ? "" : "*"}</span>`)
    .join("");
}

// A lookup box focuses its visible name box (live required-field summary).
function summaryLink(fieldId, message, linksEnabled, focusId = fieldId) {
  if (!linksEnabled) return message;
  return `<a href='#${fieldId}_label' onclick='javascript:scrollToAndFocus("${fieldId}_label","${focusId}");return false;' referenceControlId=${fieldId}>${escape(message)} </a>`;
}

/** Native validators (ASP.NET ids, Page_Validators expandos) for one field. */
function fieldValidators(field, { linksEnabled }) {
  // CellTemplate instantiates validators unless the field itself is read-only; a read-only
  // form keeps them.
  if ((field.fieldReadOnly ?? field.readOnly) || field.hidden) return [];
  const validators = [];
  const label = field.label ?? field.name;
  const id = field.name;
  const focus = field.control === "lookup" && field.lookupStyle !== "dropdown" ? `${id}_name` : id;
  const checkbox = field.control === "boolean" && ![RADIO_CLASS, DROPDOWN_CLASS].includes(canonicalId(field.controlClassId));
  if (field.required && checkbox)
    // CheckboxValidator is server-side only: its client evaluation always passes.
    validators.push({
      id: `RequiredFieldValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.requiredMessage || `To continue, select the check box labeled "${label}".`, linksEnabled, focus),
      display: "Dynamic",
      evaluationfunction: "CustomValidatorEvaluateIsValid",
    });
  // The required validator follows the e-mail format validator and the number format and range
  // validators (live required-field form); for other boxes it comes first.
  const requiredLate = ["email", "integer", "decimal", "double", "money", "datetime"].includes(field.control);
  const required = field.required && !checkbox
    ? {
      id: `RequiredFieldValidator${id}`,
      controltovalidate: field.controlToValidate ?? id,
      errormessage: summaryLink(id, field.requiredMessage || `${label} is a required field.`, linksEnabled, focus),
      display: "Dynamic",
      evaluationfunction: "RequiredFieldValidatorEvaluateIsValid",
      initialvalue: "",
    }
    : null;
  if (required && !requiredLate) validators.push(required);
  if (field.pattern)
    validators.push({
      id: `RegularExpressionValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.patternMessage || `${label} is not valid.`, linksEnabled, focus),
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
    errormessage: summaryLink(id, field.validationMessage || format[1], linksEnabled, focus),
    evaluationfunction: "CustomValidatorEvaluateIsValid",
  };
  // The e-mail format validator precedes the maximum length validator.
  if (formatValidator && field.control === "email") validators.push(formatValidator);
  if (required && field.control === "email") validators.push(required);
  if (field.maxLength && ["text", "email", "textarea"].includes(field.control))
    // Like the hosted control, these CustomValidators run on the server. They
    // deliberately have no clientvalidationfunction: a format error posts back.
    validators.push({
      id: `MaximumLengthValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, `${label} exceeds the maximum length of ${field.maxLength} characters.`, linksEnabled, focus),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
    });
  if (formatValidator && field.control !== "email") validators.push(formatValidator);
  if (["integer", "decimal", "double", "money"].includes(field.control) && (field.minimum != null || field.maximum != null))
    validators.push({
      id: `RangeValidator${id}`,
      controltovalidate: id,
      errormessage: summaryLink(id, field.rangeMessage || nativeRangeMessage(field), linksEnabled, focus),
      evaluationfunction: "CustomValidatorEvaluateIsValid",
      minimumvalue: String(field.minimum ?? ""),
      maximumvalue: String(field.maximum ?? ""),
      type: field.control === "integer" ? "Integer" : "Double",
    });
  if (required && requiredLate && field.control !== "email") validators.push(required);
  return validators;
}

function validatorStartupScript(validators, summaryId, summaryHeader, group = "") {
  const lines = [];
  lines.push(`var Page_ValidationSummaries = (window.Page_ValidationSummaries || []).concat([document.getElementById(${json(summaryId)})]);`);
  lines.push(`var Page_Validators = (window.Page_Validators || []).concat([${validators.map((validator) => `document.getElementById(${json(validator.id)})`).join(", ")}].filter(Boolean));`);
  for (const validator of validators) {
    lines.push(`(function(){var v=document.getElementById(${json(validator.id)});if(!v)return;`);
    for (const [key, value] of Object.entries(validator)) if (key !== "id" && value !== undefined) lines.push(`v.${key}=${json(String(value))};`);
    // A form validation group scopes its validators and summary to its buttons (live ValidationGroup).
    if (group) lines.push(`v.validationGroup=${json(String(group))};`);
    lines.push("})();");
  }
  lines.push(`(function(){var s=document.getElementById(${json(summaryId)});if(s){s.headertext=${json(summaryHeader)};s.displaymode="BulletList";${group ? `s.validationGroup=${json(String(group))};` : ""}}})();`);
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
// A message configured in the grid metadata (EmptyMessage, AccessDeniedMessage, ErrorMessage,
// LoadingMessage) renders as the plain text of its wrapper; the defaults keep their alert markup.
function gridMessages(bs = BOOTSTRAP_MARKUP.BootstrapV3, settings = {}, language = {}) {
  const custom = (name) => formText(settings?.[name], "", language);
  const empty = custom("EmptyMessage"), denied = custom("AccessDeniedMessage"), error = custom("ErrorMessage"), loading = custom("LoadingMessage");
  const hidden = bs.v5 ? "" : ' style="display:none"';
  const details = bs.v5 ? '<span class="details"></span><span class="details"></span>' : '<span class="details"></span>';
  return `<div aria-label="${attr(empty || "There are no records to display.")}" aria-live="polite" class="view-empty message" role="status" tabindex="-1"${hidden}>${empty ? escape(empty) : '<div class="alert alert-block alert-warning">There are no records to display.</div>'}</div>` +
    `<div class="view-access-denied message" role="presentation" tabindex="0"${hidden}>${denied ? escape(denied) : `<div class="alert alert-block alert-danger">You don't have permissions to view these records.</div>`}</div>` +
    `<div class="view-error message" role="presentation" tabindex="0"${hidden}>${error ? escape(error) : `<div class="alert alert-block alert-danger">Error completing request.${details}</div>`}</div>` +
    `<div class="view-loading message text-center" role="presentation" tabindex="0"${hidden}>${loading ? escape(loading) : '<span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...'}</div>`;
}
const LOOKUP_GRID_MESSAGES = `<div aria-label="There are no records to display." aria-live="polite" class="view-empty message" role="status" tabindex="-1" style="display:none"><div class="alert alert-block alert-warning">There are no records to display.</div></div><div class="view-access-denied message" role="presentation" tabindex="0" style="display:none"><div class="alert alert-block alert-danger">You don't have permissions to view these records.</div></div><div class="view-error message" role="presentation" tabindex="0" style="display:none"><div class="alert alert-block alert-danger">Error completing request.<span class="details"></span></div></div><div class="view-loading message text-center" role="presentation" tabindex="0" style="display:none"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div>`;
const PAGINATION = '<div class="view-pagination" data-current-page="1" data-pages="1" data-pagesize=""></div>';
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";
const SUCCESS_PANEL_V5 = "message alert success alert alert-success";
/**
 * The Bootstrap 5 message panel's close button: a WebForms postback button that dismisses the
 * alert. It validates the default group, so ASP.NET writes its client validation call only when
 * the form's validators are in that group; a form with a validation group gets none (live).
 */
function messageCloseButton(buttonPrefix, bs, group = "") {
  const name = `${buttonPrefix}btnCloseMessage`;
  return `<input type="submit" name="${attr(name)}" value="x"${group ? "" : ` onclick="${attr(`javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(${json(name)}, "", true, "", "", false, false))`)}"`} id="btnCloseMessage" class="btn-close" ${bs.dismiss}="alert" aria-label="close" style="border-style: none">`;
}
// The platform's duration choices, in minutes.
const DURATION_MINUTES = [1, 5, 15, 30, 45, ...Array.from({ length: 15 }, (_, index) => 60 + index * 30), 1440, 2880, 4320];
const plural = (count, unit) => `${count} ${unit}${count === 1 ? "" : "s"}`;
const durationLabel = (minutes) => (minutes < 60 ? plural(minutes, "minute") : minutes < 1440 ? plural(minutes / 60, "hour") : plural(minutes / 1440, "day"));
/** Option lists of whole-number formats: duration (fixed minutes), time zone (platform definitions) and language (the site's languages). */
function integerFormatChoices(field, portal) {
  const format = String(field.format ?? "").toLowerCase();
  if (format === "timezone") return timeZoneChoices();
  if (format === "duration") return DURATION_MINUTES.map((minutes) => ({ value: minutes, label: durationLabel(minutes) }));
  if (format !== "language") return null;
  const names = new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" });
  const lcids = [...new Set((portal.websiteLanguages ?? []).map((language) => language.lcid).filter(Boolean))];
  return lcids.map((lcid) => ({ lcid, code: portalLanguage({ lcid })?.code })).filter((language) => language.code).map(({ lcid, code }) => ({ value: lcid, label: names.of(code) }));
}
// Dataverse column types the portal form does not render (an empty cell).
const UNSUPPORTED_FORM_TYPES = /^bigint$/i;
// HTML web resources (webresourcetype 1; the exported file name carries the extension).
const HTML_WEB_RESOURCE = /\.html?$/i;
// The platform's AttributeType names of those columns (the unsupported cell's message).
const UNSUPPORTED_TYPE_NAMES = { bigint: "BigInt" };
// After a failed control the platform closes the form view, panel and control wrappers and one
// element past the control (live truncated basic and multistep forms: four closing divs more
// than the section's own wrappers; the page's remaining closing tags follow the form's fields).
const TRUNCATED_CLOSE = "</div></div></div></div>";
// ASP.NET omits the value attribute of an input whose value is empty.
const valueAttr = (value) => (String(value ?? "") === "" ? "" : ` value="${attr(value)}"`);
function nativeModal({ className, title, body, footer = "", size = "", label, bs = BOOTSTRAP_MARKUP.BootstrapV3, headingLabel = false, dismissText = "Close", rawTitle = false, titleAttr = null }) {
  // headingLabel: the Bootstrap 5 lookup dialog labels its heading instead of the section.
  // rawTitle: the label and title attributes carry the title markup as is (details, error dialogs).
  const labelText = rawTitle ? title : label ?? plainText(title);
  const labelAttr = ` aria-label="${attr(labelText)}"`;
  return `<section aria-hidden="true"${headingLabel ? "" : labelAttr} class="modal fade ${className}" ${bs.backdrop}="static" role="dialog" tabindex="-1"><div class="${size ? size + " " : ""}modal-dialog"><div class="modal-content"><div class="modal-header"><h1${headingLabel ? labelAttr : ""} class="modal-title" title="${attr(titleAttr ?? (rawTitle ? title : plainText(title)))}">${title}</h1><button aria-label="Close" class="form-close" ${bs.dismiss}="modal" style="position: absolute; top: 3%;" tabindex="0" title="${attr(dismissText)}" type="button"><span aria-hidden="true">×</span><span class="${bs.srOnly}">${escape(dismissText)}</span></button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ""}</div></div></section>`;
}
// An attribute value whose line breaks are CRLF: the HTML parser folds raw CR LF into LF, so the
// platform's indented JSON attributes keep their CR as character references.
const crlfAttr = (value) => attr(value).replace(/\n/g, "&#13;&#10;");
function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .trim();
}
const formModalBody = (page) => `<div class="form-loading"><span class="fa fa-spinner fa-spin fa-4x" aria-hidden="true"></span></div><iframe data-page="${attr(page)}" src="about:blank"></iframe>`;

/**
 * The grid error modal: the platform default (icon title, kept raw in the label and title
 * attributes) or the configured ErrorDialog (plain title, its CssClass on the section, its
 * DismissButtonSrText on the close control and its CloseButtonText in the footer).
 */
function gridErrorModal(bs = BOOTSTRAP_MARKUP.BootstrapV3, dialog = null, language = {}) {
  const title = formText(dialog?.Title, "", language);
  const dismiss = formText(dialog?.DismissButtonSrText, "Close", language);
  const close = formText(dialog?.CloseButtonText, "Close", language);
  const css = formText(dialog?.CssClass, "", language);
  const defaultTitle = "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> Error";
  return nativeModal({ bs, className: `modal-error${css ? " " + attr(css) : ""}`, title: title ? escape(title) : defaultTitle, rawTitle: !title, dismissText: dismiss, body: "<p>We're sorry, an error has occurred.</p>", footer: `<button aria-label="Close" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="Close" type="button">${escape(close)}</button>` });
}

/** Native grid modals (create/edit/details forms, delete, error, workflow, (de)activate). */
function gridModals(page, settings = {}, language = {}, bs = BOOTSTRAP_MARKUP.BootstrapV3) {
  // A configured dialog (CreateFormDialog, EditFormDialog, DetailsFormDialog, DeleteDialog: live
  // subgrid markup) adds its CssClass to the section, sizes the dialog by Size (none, lg, sm),
  // shows its Title (the create and edit headings keep "Create"/"Edit" as their label and title
  // attribute), its LoadingMessage instead of the spinner and its DismissButtonSrText; the delete
  // dialog asks the delete action's confirmation with the dialog's button texts.
  const dialog = (name, fallback) => formText(settings?.[name]?.Title, fallback, language);
  const configured = (name) => settings?.[name] && typeof settings[name] === "object";
  const css = (name) => (configured(name) && settings[name].CssClass ? " " + attr(formText(settings[name].CssClass, "", language)) : "");
  const size = (name) => (configured(name) ? MODAL_SIZES[Number(settings[name].Size)] ?? "" : "modal-lg");
  const dismiss = (name) => formText(settings?.[name]?.DismissButtonSrText, "Close", language);
  const heading = (name, fallback) => (settings?.[name]?.Title ? escape(dialog(name, "")) : fallback);
  const body = (name) => (configured(name) ? `<div class="form-loading">${escape(formText(settings[name].LoadingMessage, "", language))}</div><iframe data-page="${attr(page)}" src="about:blank"></iframe>` : formModalBody(page));
  const detailsTitle = heading("DetailsFormDialog", "<span class='fa fa-info-circle' aria-hidden='true'></span> View details");
  const deleteAction = (settings?.ItemActions ?? []).find((action) => action?.Type === "CrmEntityFormView-DeleteAction");
  const primary = escape(localizedText(settings?.DeleteDialog?.PrimaryButtonText, "Delete"));
  const close = escape(localizedText(settings?.DeleteDialog?.CloseButtonText, "Cancel"));
  return [
    nativeModal({ bs, className: `modal-form modal-form-insert${css("CreateFormDialog")}`, title: heading("CreateFormDialog", "<span class='fa fa-pencil-square-o' aria-hidden='true'></span> Create"), body: body("CreateFormDialog"), size: size("CreateFormDialog"), label: "Create", titleAttr: "Create", dismissText: dismiss("CreateFormDialog") }),
    nativeModal({ bs, className: `modal-form modal-form-edit${css("EditFormDialog")}`, title: heading("EditFormDialog", "<span class='fa fa-edit'></span> Edit"), body: body("EditFormDialog"), size: size("EditFormDialog"), label: "Edit", titleAttr: "Edit", dismissText: dismiss("EditFormDialog") }),
    // The details dialog keeps its raw title markup in the label and title attributes.
    nativeModal({ bs, className: `modal-form modal-form-details${css("DetailsFormDialog")}`, title: detailsTitle, rawTitle: true, body: body("DetailsFormDialog"), size: size("DetailsFormDialog"), dismissText: dismiss("DetailsFormDialog") }),
    nativeModal({ bs, className: `modal-delete${css("DeleteDialog")}`, title: heading("DeleteDialog", "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete"), body: escape(formText(deleteAction?.Confirmation ?? settings?.DeleteDialog?.Confirmation, "Are you sure you want to delete this record?", language)), footer: `<button aria-label="${primary}" class="primary btn btn-primary" tabindex="0" title="${primary}" type="button">${primary}</button><button aria-label="${close}" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="${close}" type="button">${close}</button>`, label: configured("DeleteDialog") && settings.DeleteDialog.Title ? undefined : "Delete", dismissText: dismiss("DeleteDialog") }),
    gridErrorModal(bs, settings?.ErrorDialog, language),
    // Bootstrap 5 subgrids render no workflow, (de)activate or disassociate dialogs (live evidence).
    ...(bs.v5 ? [] : [
      nativeModal({ bs, className: "modal-run-workflow", title: "Run workflow", body: "Are you sure you want to run this workflow?", footer: `<button class="primary btn btn-primary" type="button">Run workflow</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
      nativeModal({ bs, className: "modal-deactivate", title: "Deactivate", body: "Are you sure you want to deactivate this record?", footer: `<button class="primary btn btn-primary" type="button">Deactivate</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
      nativeModal({ bs, className: "modal-activate", title: "Activate", body: "Are you sure you want to activate this record?", footer: `<button class="primary btn btn-primary" type="button">Activate</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
      nativeModal({ bs, className: "modal-disassociate", title: "Disassociate", body: "Are you sure you want to remove this association?", footer: `<button class="primary btn btn-primary" type="button">Remove</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` }),
    ]),
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
  // A list without grid settings renders the platform defaults: the loading spinner, the resolve
  // dialog's default field names; a configured dialog repeats the default button classes after
  // its own (live markup).
  const defaults = !Object.keys(settings).length;
  const formBody = (dialog, hidden = false) => `<div class="form-loading">${defaults ? '<span class="fa fa-spinner fa-spin fa-4x" aria-hidden="true"></span>' : escape(formText(dialog?.LoadingMessage, "", language))}</div><iframe${hidden ? ' aria-hidden="true"' : ""} data-page="${attr(page)}" src="about:blank"></iframe>`;
  const confirm = (name, primary, cancel = "Cancel") =>
    `<button class="primary btn btn-primary ${settings?.[name] ? "btn btn-primary" : ""}" type="button">${escape(formText(settings?.[name]?.PrimaryButtonText, primary, language))}</button><button class="cancel btn btn-default ${settings?.[name] ? "btn btn-default" : ""}" data-bs-dismiss="modal" type="button">${escape(formText(settings?.[name]?.CloseButtonText, cancel, language))}</button>`;
  const deleteAction = (settings.ItemActions ?? []).find((action) => action?.Type === "CrmEntityFormView-DeleteAction");
  const resolve = `<div class="row mb-3"><label class="required col-form-label col-md-3">${defaults ? "Resolution (required)" : ""}</label><div class="col-md-9"><input aria-required="true" class="resolution-input required form-control" type="text" aria-label="${defaults ? "Resolution (required)" : ""}"></div></div><div class="row mb-3"><label class="required col-form-label col-md-3">${defaults ? "Description of resolution" : ""}</label><div class="col-md-9"><textarea aria-required="true" class="resolution-description-input required form-control" cols="20" rows="6" aria-label="${defaults ? "Description of resolution" : ""}"></textarea></div></div>`;
  return [
    listModalV5({ className: "modal-form modal-form-insert", dialog: settings.CreateFormDialog, title: "<span class='fa fa-edit' aria-hidden='true'></span> Create", body: formBody(settings.CreateFormDialog), language }),
    listModalV5({ className: "modal-form modal-form-edit", dialog: settings.EditFormDialog, title: "<span class='fa fa-edit' aria-hidden='true'></span> Edit", body: formBody(settings.EditFormDialog), language }),
    listModalV5({ className: "modal-form modal-form-details", dialog: settings.DetailsFormDialog, title: "<span class='fa fa-info-circle' aria-hidden='true'></span> View details", body: formBody(settings.DetailsFormDialog, true), language, labelledBy: `modalTitleID_${listId}` }),
    listModalV5({ className: "modal-delete", dialog: settings.DeleteDialog, title: "<span class='fa fa-trash-can' aria-hidden='true'></span> Delete", body: escape(formText(deleteAction?.Confirmation ?? settings.DeleteDialog?.Confirmation, defaults ? "Are you sure you want to delete this record?" : "", language)), footer: confirm("DeleteDialog", "Delete"), language, label: "Delete" }),
    // A configured error dialog shows its own body and close text; its close button repeats the default classes (live).
    listModalV5({ className: "modal-error", dialog: settings.ErrorDialog, body: settings.ErrorDialog?.Body ? escape(formText(settings.ErrorDialog.Body, "", language)) : defaults ? "<p>We're sorry, an error has occurred.</p>" : "", title: "<span class='fa fa-exclamation-triangle' aria-hidden='true'></span> Error", footer: `<button class="cancel btn btn-default ${settings.ErrorDialog ? "btn btn-default" : ""}" data-bs-dismiss="modal" type="button">${escape(formText(settings.ErrorDialog?.CloseButtonText, "Close", language))}</button>`, language }),
    listModalV5({ className: "modal-form modal-form-createrecord", dialog: settings.CreateRelatedRecordDialog, title: "<span class='fa fa-plus-circle' aria-hidden='true'></span> Create related record", body: formBody(settings.CreateRelatedRecordDialog), language }),
    listModalV5({ className: "modal-run-workflow", title: " Run workflow", body: escape("<p>Are you sure you want to run this workflow?</p>"), footer: confirm("WorkflowDialog", "Run workflow"), language }),
    listModalV5({ className: "modal-deactivate", dialog: settings.DeactivateDialog, title: " Deactivate", body: defaults ? "<p>Are you sure you want to deactivate this record?</p>" : "", footer: confirm("DeactivateDialog", "Deactivate"), language }),
    listModalV5({ className: "modal-activate", dialog: settings.ActivateDialog, title: " Activate", body: defaults ? "<p>Are you sure you want to activate this record?</p>" : "", footer: confirm("ActivateDialog", "Activate"), language }),
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
/** A column's description (Dataverse attribute Description) in the request language, else the default or first. */
function columnDescription(field, language) {
  if (typeof field.description === "string") return field.description;
  const labels = field.columnMetadata?.descriptionLabels ?? {};
  return labels[String(language?.lcid)] ?? labels[String(language?.defaultLcid)] ?? labels["1033"] ?? Object.values(labels)[0] ?? "";
}

function requestLanguage(context, portal) {
  return {
    lcid: context?.__language?.lcid ?? null,
    defaultLcid: (portal?.websiteLanguages ?? []).find((language) => language.isDefault)?.lcid ?? null,
  };
}

/** The legacy list control of a map list with credentials (EntityListControl map template). */
function mapListControl(list, metadata, viewId) {
  const id = compactId(list.id);
  const prefix = `ctl00$ContentContainer$EntityListControl_${id}$ctl00$`;
  const text = (value) => `<span class="xrm-editable-text xrm-attribute"><span class="xrm-attribute-value">${escape(value)}</span></span>`;
  const units = Number(fieldOf(metadata, "map_distanceunits")) === 756150000 ? "km" : "miles";
  const distances = String(fieldOf(metadata, "map_distancevalues") ?? "5,10,25,50,100").split(",").map((value) => value.trim()).filter(Boolean);
  const coordinate = (name) => (Number(fieldOf(metadata, name)) || 0).toFixed(5);
  const host = [
    ["data-distance-units", units],
    ["data-longitude", coordinate("map_longitude")],
    ["data-latitude", coordinate("map_latitude")],
    ["data-pushpin-height", fieldOf(metadata, "map_pushpinheight") ?? ""],
    ["data-pushpin-width", fieldOf(metadata, "map_pushpinwidth") ?? ""],
    ["data-rest-url", fieldOf(metadata, "map_resturl") ?? ""],
    ["id", "entity-list-map"],
    ["data-zoom", fieldOf(metadata, "map_zoom") ?? ""],
    ["data-pushpin-url", fieldOf(metadata, "map_pushpinurl") ?? ""],
    ["data-infobox-offset-x", fieldOf(metadata, "map_infoboxoffsetx") ?? ""],
    ["data-entity-list-id", canonicalId(list.id)],
    ["data-search-url", "/EntityList/Map/Search/"],
    ["data-view-id", canonicalId(viewId ?? "")],
    ["data-infobox-offset-y", fieldOf(metadata, "map_infoboxoffsety") ?? ""],
    ["data-credentials", fieldOf(metadata, "map_credentials") ?? ""],
  ].map(([name, value]) => ` ${name}="${attr(String(value))}"`).join("");
  const options = distances.map((value) => `<option value="${attr(value)}">${escape(value)} ${units}</option>`).join("");
  const field = (label, target, name, extra = "") => `<div class="control-group row mb-3"><label class="col-form-label fw-bold col-md-2" for="${target}"><span>${text(label)}</span></label><div class="controls col-md-8"><input name="${prefix}${name}" type="text" id="${target}" class="form-control"></div>${extra}</div>`;
  const dialog = `<section id="entity-list-map-directions-dialog" class="modal" tabindex="-1" role="dialog" aria-labelledby="entity-list-map-directions-dialog-label" aria-hidden="true"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 id="entity-list-map-directions-dialog-label" class="modal-title h4"><span>${text("Get Directions")}</span></h1><button class="close" data-bs-dismiss="modal" aria-hidden="true" type="button">&times;</button></div><div class="modal-body  ">${field("From", "entity-list-map-directions-from", "ctl24", '<div class="col-md-2"><a id="entity-list-map-directions-reverse" class="btn btn-default" href="../../Pages/#"><span class="fa fa-refresh" aria-hidden="true"></span></a></div>')}${field("To", "entity-list-map-directions-to", "ctl30")}</div><div class="modal-footer"><input name="${prefix}ctl32" type="hidden" id="entity-list-map-directions-latitude"><input name="${prefix}ctl33" type="hidden" id="entity-list-map-directions-longitude"><button id="entity-list-map-directions-get" class="btn btn-primary"><span>${text("Get Directions")}</span></button></div></div></div></section>`;
  const provider = Number(fieldOf(metadata, "map_type") ?? 756150000) === 756150000 ? "bing" : "other";
  return `<!--pp-server-list--><!--pp-map-list:${provider}--><div id="EntityListControl_${id}"><div class="entitylist"><div class="row clearfix"><div id="entity-list-map-options" class="span12 col-lg-12 form-inline"><span id="entity-list-map-location_label"><span class="xrm-editable-text xrm-attribute"><span class="xrm-attribute-value">Search for location near</span></span></span><input name="${prefix}ctl02" type="text" id="entity-list-map-location" class="form-control" placeholder="address" aria-labelledby="entity-list-map-location_label"><span id="entity-list-map-distance_label"><span class="xrm-editable-text xrm-attribute"><span class="xrm-attribute-value">within </span></span></span><select name="${prefix}entity-list-map-distance" id="entity-list-map-distance" class="form-control form-select" title="Distance" aria-labelledby="entity-list-map-distance_label">${options}</select>&nbsp;<button id="entity-list-map-search" class="btn btn-primary"><span>${text("Search")}</span></button></div><div id="entity-list-map-container" class="span8 col-lg-8"><div${host}></div></div><div id="entity-list-map-locations" class="span4 col-lg-4"><div id="entity-list-map-error" class="alert alert-block alert-danger"><p></p></div><table class="table table-hover unstyled"><tbody></tbody></table></div><div id="entity-list-map-directions"></div></div>${dialog}</div></div>`;
}

/** Server markup of a native list grid (entity_list built-in template). */
async function renderListGrid(model, context, options) {
  const websiteId = canonicalId(options.portal.website?.id);
  // A map view (adx_map_enabled) without map credentials renders the legacy list control empty: no
  // grid and no data request (live map list captures; the export carries no map key).
  const listMetadata = model.list?.metadata ?? {};
  if (truthy(fieldOf(listMetadata, "map_enabled")) && !fieldOf(listMetadata, "map_credentials"))
    return `<!--pp-server-list--><div id="EntityListControl_${compactId(model.list.id)}"><div class="entitylist"></div></div>`;
  // With map credentials the legacy list control renders the map: the location search, the map
  // host carrying the list's map settings, the locations table and the directions dialog (live
  // Bing map list; the Esri and Google variants are unobserved with credentials).
  if (truthy(fieldOf(listMetadata, "map_enabled"))) return mapListControl(model.list, listMetadata, model.views[0]?.id);
  if (model.calendar)
    return renderCalendarList({ list: model.list, calendar: model.calendar, websiteId, viewId: model.views[0].id, variant: bootstrapVariant(options.portal.settings), culture: options.portal.websiteLanguages?.find((candidate) => candidate.isDefault)?.code ?? "en-US" });
  const language = requestLanguage(context, options.portal);
  const page = `/_portal/modal-form-template-path/${websiteId}`;
  const actions = actionLinks(model.settings, { portal: options.portal, requestUrl: context.request?.url ?? "http://localhost/", website: websiteId });
  if (model.detailsPage && !actions.some((action) => action.Type === 1)) {
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.detailsPage);
    if (target)
      model.detailsActionLink = { Type: 1, Enabled: true, Target: 1, Label: model.detailsLabel, Tooltip: model.detailsLabel, URL: { PathWithQueryString: target.url, Path: target.url }, QueryStringIdParameterName: model.idParameter, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" };
  }
  const v5 = bootstrapMarkup(options.portal.settings).v5;
  // A list attached to a legacy ASPX page is the static EntityListControl of the WebForms master.
  const pageControl = options.args?.pp_page_control === true || options.args?.pp_page_control === "true";
  // The Bootstrap 5 page control has no create page link (live layout: InsertActionLink disabled).
  if (v5 && pageControl) {
    /* no create link */
  } else if (model.createPage && v5) {
    // Bootstrap 5: the list's create page is the grid's InsertActionLink, beside any configured create action.
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.createPage);
    if (target) model.insertActionLink = { Type: 3, Enabled: true, Target: 2, Label: model.createLabel, Tooltip: "Create", URL: { PathWithQueryString: target.url, Path: target.url }, QueryStringIdParameterName: model.idParameter, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" };
  } else if (model.createPage && !actions.some((action) => action.Type === 3)) {
    const target = options.portal.pages.find((candidate) => canonicalId(candidate.id) === model.createPage);
    if (target)
      actions.push({ position: "view", Type: 3, Enabled: true, Target: 1, Label: model.createLabel, Tooltip: model.createLabel, URL: { PathWithQueryString: target.url, Path: target.url }, FilterCriteriaId: "00000000-0000-0000-0000-000000000000", ActionIndex: 0 });
  }
  const identity = context.user ?? context.identity;
  // Without the create privilege the create links stay in the layout, disabled (live: reader and
  // parent-scope lists), as the subgrids check it.
  const store = options.store;
  const canCreate = typeof store?.rules !== "function" || identity?.admin || store.state?.settings?.permissionMode === "permissive" || store.rules(model.entity, "create", identity ?? {}).length > 0;
  if (!canCreate) {
    if (model.insertActionLink) model.insertActionLink = { ...model.insertActionLink, Enabled: false };
    for (const action of actions) if (action.Type === 3) action.Enabled = false;
  }
  const layouts = gridLayouts(model, { secureBase: { t: "list", w: websiteId, list: model.list.id }, websiteId, metadata: options.metadata, actions, language });
  const settings = model.settings ?? {};
  const authenticated = Boolean(identity?.contactId ?? identity?.id);
  const bs = bootstrapMarkup(options.portal.settings);
  // Bootstrap 5 page control: the legacy grid markup (as subgrids), not the Bootstrap 5 list markup (live page/bound-entitylist).
  const pageControlGrid = () => `<div><div class="entity-grid entitylist${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-grid-data.json/${websiteId}" data-grid-class="${attr(settings.GridCssClass ?? "")}" data-mobile-view-enabled="false" data-select-mode="None" data-selected-view="${attr(model.views[0].id)}" data-update-url="/_services/entity-grid-update-entity/${websiteId}" data-user-isauthenticated="${authenticated}" data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}" data-view-layouts="${base64Json(layouts)}"><div class="view-grid"></div>${gridMessages(bs, settings, language)}${PAGINATION}${gridModals(page, settings, language, bs)}</div></div>`;
  const grid = bs.v5 && pageControl ? pageControlGrid() : bs.v5 ? listGridV5({ model, settings, layouts, websiteId, identity, authenticated, page, language }) : `<div class="entity-grid entitylist${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-grid-data.json/${websiteId}" data-grid-class="${attr(settings.GridCssClass ?? "table-striped")}" data-select-mode="None" data-selected-view="${attr(model.views[0].id)}" data-view-layouts="${base64Json(layouts)}" data-user-isauthenticated="${authenticated}" data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}" data-mobile-view-enabled="true"><div class="view-grid"></div><div class="view-empty message">${model.emptyText ? model.emptyText : '<div class="alert alert-block alert-warning">There are no records to display.</div>'}</div><div class="view-access-denied message"><div class="alert alert-block alert-danger">You don't have permissions to view these records.</div></div><div class="view-error message"><div class="alert alert-block alert-danger">Error completing request.<span class="details"></span></div></div><div class="view-loading message text-center"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div>${PAGINATION}${gridModals(page, settings, language)}</div>`;
  const filter = model.filter?.enabled ? await renderListFilter(model, context, options) : "";
  const body = filter ? (model.filter.vertical ? `<div class="row"><div class="${bs.v5 ? "col-lg-3" : "col-md-3"} filter-vertical">${filter}</div><div class="${bs.v5 ? "col-lg-9" : "col-md-9"}">${grid}</div></div>` : filter + grid) : grid;
  const js = model.list.js && (options.renderLiquid ? await options.renderLiquid(model.list.js, context) : model.list.js);
  const script = js ? `<script type="text/javascript">${js}</script>` : "";
  if (bs.v5 && pageControl) return `<div id="EntityListControl"><div class="entitylist">${body}${script}</div></div>`;
  return `<div${pageControl ? ' id="EntityListControl"' : ""} class="entitylist">${body}${script}</div>`;
}

/** Bootstrap 5 server markup of a list grid: the messages and dialogs the client fills. */
function listGridV5({ model, settings, layouts, websiteId, identity, authenticated, page, language }) {
  const attributes = [
    ["class", `entity-grid entitylist ${settings.CssClass ?? ""}`],
    // An instance id the platform derives from the render time.
    ["data-id", `${Date.now()}.${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`],
    ["data-column-width-style", settings.GridColumnWidthStyle == null ? "" : Number(settings.GridColumnWidthStyle) === 0 ? "Pixels" : "Percent"],
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
  // The list's own messages (settings EmptyMessage, AccessDeniedMessage, ErrorMessage,
  // LoadingMessage) replace the platform defaults as plain text (live list with grid settings).
  const custom = (key) => formText(settings?.[key], "", language);
  const message = (className, key, fallback) => `<div class="${className}">${custom(key) ? escape(custom(key)) : fallback}</div>`;
  const messages = `<div class="view-grid"></div>${message("view-empty message", "EmptyMessage", "There are no records to display.")}<div class="view-empty-maker message">To see records displayed here, choose preview.</div>${message("view-access-denied message", "AccessDeniedMessage", '<div class="alert alert-block alert-danger">You don&#39;t have permissions to view these records.</div>')}${message("view-error message", "ErrorMessage", "<div class=\"alert alert-block alert-danger\">Error completing request. <span class='details'></span></div>")}${message("view-loading message text-center", "LoadingMessage", "<span class='fa fa-spinner fa-spin' aria-hidden='true'></span> Loading...")}${PAGINATION}`;
  return `<div${attributes}>${messages}${gridModalsV5(page, settings, language, model.list.id)}</div>`;
}

const TEXT_FILTER_HINT = "To search on partial text, use the asterisk (*) wildcard character. ";
/** Metadata filter panel (entity_list_filter built-in template). */
async function renderListFilter(model, context, options) {
  const groups = metaFilterGroups(model.filter.definition);
  if (!groups.length) return "";
  const selected = new URLSearchParams(String(context.request?.params?.mf ?? ""));
  const bs = bootstrapMarkup(options.portal.settings);
  // Bootstrap 5: the option list items are presentational, text and option groups scroll in a box.
  const li = bs.v5 ? '<li class="entitylist-filter-option" role="presentation">' : '<li class="entitylist-filter-option">';
  const addon = bs.v5 ? "input-group-text" : "input-group-addon";
  const box = (markup) => (bs.v5 ? `<div class="entitylist-filter-option-group-box-overflow">${markup}</div>` : markup);
  const items = [];
  for (const group of groups) {
    const elementId = `${String(group.selectionMode ?? "").toLowerCase()}_${group.id}`;
    let markup = "";
    if (group.type === "textfilter")
      markup = box(`${li}<div class="input-group entitylist-filter-option-text"><span class="${addon}"><span class="fa fa-filter" aria-hidden="true"></span></span><input class="form-control${bs.v5 ? " has-tooltip" : ""}" type="text" name="${attr(group.id)}" value="${attr(selected.get(group.id) ?? "")}" id="${attr(group.id)}"${bs.v5 ? ` title="${TEXT_FILTER_HINT}"` : ""}></div></li>`);
    // Dropdown groups (lookup or choice options) render one select box.
    else if (group.selectionMode === "Dropdown") {
      const choices = await filterChoices(group, context, options, model);
      markup = `${li}<div class="input-group entitylist-filter-option-text"><span class="${addon}"><span class="fa fa-filter" aria-hidden="true"></span></span><select class="form-control${bs.v5 ? " form-select" : ""}" name="${attr(group.id)}" id="${attr(elementId)}"><option value="" label=" "></option>${choices.map((choice) => `<option value="${attr(choice.id)}" label="${attr(choice.label)}"${selected.getAll(group.id).includes(choice.id) ? " selected" : ""}>${escape(choice.label)}</option>`).join("")}</select></div></li>`;
    } else {
      const choices = await filterChoices(group, context, options, model);
      const type = group.selectionMode === "Single" ? "radio" : "checkbox";
      markup = box(choices
        .slice(0, 6)
        .map((choice) => `${li}<div class="${type}"><label><input type="${type}" name="${attr(group.id)}" value="${attr(choice.id)}"${selected.getAll(group.id).includes(choice.id) ? ' checked="checked" data-checked="true"' : ""} /> ${escape(choice.label)}</label></div></li>`)
        .join(""));
    }
    items.push(`<li class="entitylist-filter-option-group${bs.v5 ? " list-inline-item" : ""}"><label class="entitylist-filter-option-group-label h4" data-filter-id="${attr(group.id)}" for="${attr(["textfilter", "fetchfilter"].includes(group.type) ? group.id : elementId)}">${escape(group.label)}</label><ul class="list-unstyled" role="presentation"${bs.v5 ? "" : ' data-pagesize="6"'}>${markup}</ul></li>`);
  }
  // The Bootstrap 5 template leaves the panel's empty class slots as spaces.
  return `<div id="EntityList${attr(model.list.id)}" class="${bs.v5 ? "content-panel card      entitylist-filter" : "content-panel panel panel-default entitylist-filter"}"><div class="${bs.v5 ? "card-body" : "panel-body"}"><ul id="entitylist-filters" class="${model.filter.vertical ? " list-unstyled " : " list-inline "}">${items.join("")}</ul><div class="${bs.right}"><button class="btn btn-default btn-entitylist-filter-submit" data-serialized-query="mf" data-target="#EntityList${attr(model.list.id)}">${escape(model.filter.applyLabel)}</button></div></div></div>`;
}

async function filterChoices(group, context, options, model = null) {
  const node = group.node;
  const indexed = (conditions) => conditions.map((condition) => ({ id: String(condition["adx.id"] ?? ""), label: condition.uiname ?? condition["adx.uiname"] ?? String(condition.value ?? "") }));
  if (group.type === "rangeset") return indexed(node.filters ?? []);
  if (group.type === "dynamicpicklistset") {
    const attribute = node["adx.attribute"] ?? node.conditions?.[0]?.attribute;
    return (options?.metadata?.entities?.[model?.entity]?.fields?.[attribute]?.options ?? []).map((option) => ({ id: String(option.value), label: String(option.label ?? option.value) }));
  }
  if (group.kind === "link") {
    const condition = node.filters?.[0]?.conditions?.[0] ?? {};
    if (condition["adx.uiinputtype"] !== "dynamic") return indexed(node.filters?.[0]?.conditions ?? []);
    const viewId = condition["adx.view"];
    const labelColumn = condition["adx.labelcolumn"];
    const target = node.name;
    if (!options?.readProvider || !/^[a-z_][\w]*$/i.test(String(target ?? ""))) return [];
    const view = (options.metadata?.views ?? []).find((candidate) => candidate.id === canonicalId(viewId) && candidate.entity === canonicalId(target));
    const mapping = options.store.resolveMapping(target);
    const xml = view?.fetchXml ?? `<fetch><entity name="${attr(target)}"><attribute name="${attr(mapping.idColumn)}"/><attribute name="${attr(labelColumn || mapping.nameColumn || "name")}"/></entity></fetch>`;
    const rows = await readLookupView(contextualViewFetchXml(xml, context), options.readProvider, context.user ?? context.identity);
    return rows.map((row) => ({ id: canonicalId(row[mapping.idColumn]), label: String(row[labelColumn] ?? row[mapping.nameColumn ?? "name"] ?? row[mapping.idColumn] ?? "") })).filter((row) => row.id).map((row) => ({ ...row, id: `{${row.id}}` }));
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
    // The entity_list include of an absent list (deactivated lists are not loaded) renders the
    // platform's null-reference Liquid error (live evidence).
    if (options.args?.key != null && options.args?.id == null && options.args?.name == null) throw new LiquidError("Object reference not set to an instance of an object.");
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

/** The lookup field and value a form's Set Entity Reference query parameter supplies, or null. */
async function resolveEntityReference({ componentMetadata, mode, params, store, readProvider, identity }) {
  if (mode !== FORM_MODE.insert || !truthy(fieldOf(componentMetadata, "setentityreference"))) return null;
  // Basic forms name the query-string source 756150000, advanced form steps 100000000.
  if (![756150000, 100000000].includes(Number(fieldOf(componentMetadata, "referenceentitysourcetype") ?? 756150000))) return null;
  const parameter = fieldOf(componentMetadata, "referencequerystringname");
  const entity = canonicalId(fieldOf(componentMetadata, "referenceentitylogicalname"));
  const field = canonicalId(fieldOf(componentMetadata, "referencetargetlookupattributelogicalname"));
  const raw = parameter ? params[parameter] : null;
  if (!raw || !entity || !field || typeof readProvider?.get !== "function") return null;
  // The lookup is labelled as the reference target either way; only a primary-key parameter
  // fills it before the save (live evidence: an attribute-matched reference renders it empty).
  if (fieldOf(componentMetadata, "referencequerystringisprimarykey") === false) return { field, value: null };
  let row = null;
  try {
    row = await readProvider.get(entity, String(raw), identity);
  } catch {
    return null;
  }
  if (!row) return { field, value: null };
  const mapping = store.resolveMapping(entity);
  return { field, value: { id: canonicalId(row[mapping.idColumn]), logical_name: entity, name: String(row[mapping.nameColumn] ?? "") } };
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
  // A multistep step's reference entity read-only form (options.referenceForm) is rendered as a
  // synthetic read-only basic form with the step's control names.
  const definition = options.referenceForm?.definition ?? (kind === "webform" ? portal.advancedForms : portal.forms)?.find(
    (item) => item.name === name || canonicalId(item.id) === canonicalId(name),
  );
  let schema = schemas[name] ?? schemas[definition?.id];
  // A step's reference read-only form uses the systemform its table and form name select, as
  // an exported basic form would (the Main form, not a same-named card form; live multistep insert).
  // Its subgrids resolve through the basic form that uses the same systemform, when one exists.
  let schemaSourceId = null;
  if (!schema && options.referenceForm && definition) {
    const formName = definition.metadata?.adx_formname;
    const resolved = formName ? systemFormSchemaFor({ ...definition, formName }, metadata) : null;
    if (resolved) {
      schema = { ...resolved, metadata: undefined, mode: undefined };
      schemaSourceId = (portal.forms ?? []).find((form) => schemas[form.id]?.formId && schemas[form.id].formId === resolved.formId)?.id ?? null;
    }
  }
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
    // Every chained step, redirect and condition steps included (the numeric indicator's total).
    let chainedSteps = 0;
    let current = schema.steps.find((step) => canonicalId(step.stepId) === canonicalId(schema.initialStepId));
    while (current && !visited.has(current.stepId)) {
      visited.add(current.stepId);
      chainedSteps += 1;
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
      // Bootstrap 5 numeric indicator (live survey form): the indicator div itself carries the
      // repeated "progress-numeric <position>" class and the total counts every chained step,
      // less the last when IgnoreLastStep is set.
      const numericV5 = bs.v5 && type === 756150001;
      if (numericV5)
        indicator = ` Step <span class='number'>${stepIndex + 1}</span>Of <span class='number total'>${Math.max(chainedSteps - (ignoreLast ? 1 : 0), 0)}</span> `;
      else if (type === 756150001)
        indicator = `<div class="progress-numeric">Step <span class="number">${stepIndex + 1}</span> of <span class="number total">${counted.length}</span></div>`;
      else if (type === 756150002) {
        const percent = counted.length ? Math.round((Math.max(stepIndex, 0) / counted.length) * 100) : 0;
        // Bootstrap 5: the indicator column itself is the .progress box (live evidence, left position).
        // The visible percentage label precedes the bar only while it is empty (live: 0% on the start
        // step carries it, 33% on a later or resumed step does not).
        if (bs.v5) indicator = `${percent ? "" : `<span>${percent}%</span>`}<div aria-valuenow="${percent}" aria-valuemax="100" aria-label="progressbar" class="bar progress-bar${percent ? "" : " zero"}" aria-valuetext="${percent}%" tabindex="0" style="width: ${percent}%;" aria-valuemin="0" role="progressbar"><span aria-hidden="true">${percent}%</span></div>`;
        else indicator = `<div class="progress"><div class="bar progress-bar${percent ? "" : " zero"}" style="width: ${percent}%;" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}">${percent}%</div></div>`;
      } else
        indicator = `<ol class="progress list-group ${position}">${counted
          .map((step, index) =>
            index < stepIndex
              ? bs.v5
              ? `<li class="list-group-item text-muted list-group-item-success">${prepend ? `<span class="number">${index + 1}</span>` : ""}${title(step)}<span class="fa-solid fa-check" role="img" aria-label="Completed"></span></li>`
              : `<li class="list-group-item text-muted list-group-item-success complete">${prepend ? `<span class="number">${index + 1}</span>` : ""}${title(step)}<span class="glyphicon glyphicon-ok"></span></li>`
              : `<li class="list-group-item ${index === stepIndex ? "active" : "incomplete"}">${prepend ? `<span class="number">${index + 1}</span>` : ""}${title(step)}</li>`,
          )
          .join("")}</ol>`;
      // Bootstrap 5 side columns repeat their class list (live evidence); top/bottom Bootstrap 5 columns are unobserved.
      const v5Side = bs.v5 && (position === "left" || position === "right") ? ` col-md-3 col-lg-2${type === 756150002 ? ` progress ${position}` : ""}${position === "right" ? " div-right order-lg-1" : ""}` : null;
      const column = numericV5 ? ` class=" progress-numeric ${position} progress-numeric ${position}"` : v5Side ? ` class="${v5Side}${v5Side}"` : position === "left" ? ' class=" col-sm-3 col-md-2"' : position === "right" ? ' class=" col-sm-3 col-sm-push-9 col-md-2 col-md-push-10"' : "";
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
  const ids = options.referenceForm?.ids ?? nativeFormControlIds(kind, definition?.id ?? name, { modal, pageControl });

  // Record source.
  const source = options.referenceForm ? { mode: FORM_MODE.readOnly, id: options.referenceForm.id } : await resolveFormRecord({ kind, definition, schema, metadata, context, readProvider, store, identity, modal, session });
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
    // The denial renders inside the native form control (live permission captures, anonymous and
    // no-role personas): the panel, a read-only view holding the message in an editable-snippet
    // wrapper, and an empty actions row, within the page's WebForms form.
    const formName = kind === "webform" ? definition?.name ?? schema.formName ?? name : schema.formName ?? schema.title ?? name;
    const dateMarker = (schema.fields ?? []).some((field) => nativeControlKind(field) === "datetime") ? "<!--pp-date-controls-->" : "";
    // The layout's multi-select columns keep the hosted controls stylesheet in the head (lib/liquid.mjs).
    const multiSelectMarker = (schema.fields ?? []).some((field) => nativeControlKind(field) === "multiselect") ? "<!--MultiSelectPicklist.UpdMSPicklistControl-->" : "";
    return `<!--pp-native-form--><!--pp-native-form-denied-->${dateMarker}${multiSelectMarker}<div id="${attr(ids.wrapper)}">${await startupScript()}<div id="${attr(ids.panel)}" class="crmEntityFormView" data-form-name="${attr(formName)}"><div id="${attr(ids.view)}" class="form-readonly entity-form" readonly="readonly"><div><div class="xrm-editable-html xrm-attribute"><div class="xrm-attribute-value">${message}</div></div></div></div><div class="actions"></div></div></div>`;
  }
  // The control still renders inside the page's WebForms form (native marker); the Bootstrap 5
  // panel carries a close button without a postback handler (live evidence).
  if (notFound && kind === "webform") {
    // A multistep step without its source record sends the visitor to ?msg=source-invalid&stepid=<step>
    // (a 302), which renders the step's
    // not-found message alone: no close button, no step script (live evidence).
    if (!id && params.msg !== "source-invalid") {
      const target = new URL(context.request?.url ?? "http://localhost/");
      for (const key of ["msg", "stepid"]) target.searchParams.delete(key);
      target.searchParams.set("msg", "source-invalid");
      target.searchParams.set("stepid", canonicalId(schema.stepId));
      const location = target.pathname + target.search;
      // The page answers with this redirect (server.mjs componentRedirect); the script covers fragment renders.
      context.__diagnostics?.push({ code: "ADVANCEDFORM_SOURCE_INVALID", severity: "info", form: definition?.name ?? name, redirect: location, message: `Advanced form step '${schema.stepId}' has no source record; the platform redirects with msg=source-invalid.` });
      return `<script>location.replace(${json(location)});</script>`;
    }
    return `<!--pp-native-form--><div id="${attr(ids.wrapper)}"><div id="MessagePanel" class="message error alert alert-danger" role="alert"><span id="MessageLabel">${escape(notFound)}</span></div></div>`;
  }
  if (notFound)
    return bs.v5
      ? `<!--pp-native-form--><div id="${attr(ids.wrapper)}">${await startupScript()}<div id="MessagePanel" class="message alert error alert alert-danger"><input type="submit" name="${attr(ids.buttons)}btnCloseMessage" value="x" id="btnCloseMessage" class="btn-close" data-bs-dismiss="alert" aria-label="close" type="button" style="border-style: none"><span id="MessageLabel">${escape(notFound)}</span></div></div>`
      : `<!--pp-native-form--><div id="${attr(ids.wrapper)}">${await startupScript()}<div id="MessagePanel" class="message alert error alert alert-danger error alert alert-danger" role="alert"><span id="MessageLabel">${escape(notFound)}</span></div></div>`;
  if (kind === "entityform" && mode === FORM_MODE.insert && !formCreateAllowed(store, schema.entity, identity))
    // Still a basic form control: the page keeps its WebForms server form (live permission-denied captures).
    return ENTITY_FORM_CLIENT_VALIDATE + createAccessDeniedForm({ ids, formName: schema.formName ?? schema.title ?? name, snippet: portal.snippets?.["EntitySecurity/Record/CreateAccessDeniedMessage"] }).replace(/^<div id="[^"]*"/, "<!--pp-native-form-->$&");
  const postback = options.nativePostbackState?.kind === kind && options.nativePostbackState?.formId === definition?.id ? options.nativePostbackState : null;
  // Two postback renders exist on live. A form that sets an entity reference rebuilds its
  // controls as on a first load: a single view class, labelled blank list options, and blank
  // choice options unlabelled beside a value. Every other form restores its controls from
  // ViewState: a doubled view class, unlabelled blank list options, labelled blank choices
  // (live save, insert and error pages; the item-edit form 54fc… renders the first kind without
  // setting a reference, the open exception in reviews/phase4-K-reply.md Wave Q).
  const rebuiltPostback = Boolean(postback) && truthy(fieldOf(componentMetadata, "setentityreference"));
  const restoredPostback = Boolean(postback) && !rebuiltPostback;
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
      // The column display name (hosted controls name the column, not the form cell; live multi-select).
      columnLabel: tableFields[field.name]?.label ?? null,
      ownerHidden,
      // With tooltips enabled the column description titles the label and a lookup's name box (live).
      tooltip: truthy(fieldOf(componentMetadata, "tooltipenabled")) ? columnDescription(field, formLanguage) : "",
      // The owner column is read-only by the platform rather than by its cell: it keeps the
      // required markers and has no readonly class (live owner lookup).
      ownerLocked: field.name === "ownerid" && !field.readOnly && !immutable && !readOnly,
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
      // Survey control styles (constant sum, rank order, matrix, multiple choice, stack rank) group cells by name.
      groupName: String(fieldOf(row, "groupname") ?? ""),
      lookupStyle: style === 756150000 ? "dropdown" : field.lookupStyle,
      ignoreDefault: truthy(fieldOf(row, "ignoredefaultvalue")),
      randomize: truthy(fieldOf(row, "randomizeoptionsetvalues")),
      prepopulate: row && fieldOf(row, "prepopulatetype") != null ? prepopulateValue(row, identity, now) : undefined,
      description,
      createFormId: canonicalId(fieldOf(row, "entityformforcreate")),
      minimum: field.minimum ?? field.minValue,
      maximum: field.maximum ?? field.maxValue,
      // The Dataverse composite full name (the computed fullname column, valid for neither create
      // nor update): the platform's full name composite box, required and without a maximum
      // length; the platform composes it from the name parts (live contact forms).
      ...(field.name === "fullname" && field.validForCreate === false && field.validForUpdate === false ? { composite: "fullname", required: true, maxLength: undefined } : {}),
      // A computed composite address (<prefix>_composite, valid for neither create nor update): the
      // platform's address composite box and its parts container (live contact forms).
      ...(/^[a-z]+\d*_composite$/.test(field.name) && field.validForCreate === false && field.validForUpdate === false ? { composite: "address", maxLength: undefined } : {}),
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
  // Set Entity Reference metadata: the referenced record named by the query parameter fills the
  // target lookup of an insert form (lib/form-service.mjs relates it again on save). A multistep
  // step keeps its configured mode for this: an insert start step revisited after the session saved
  // its record (Previous) still shows the reference read-only form (live multistep-insert-fixed step2-back).
  const entityReference = await resolveEntityReference({ componentMetadata, mode: kind === "webform" ? Number(schema.mode ?? definition?.mode ?? FORM_MODE.insert) : mode, params, store, readProvider, identity });
  const value = (field) => {
    if (record && Object.hasOwn(record, field.name) && record[field.name] !== undefined && record[field.name] !== null && mode !== FORM_MODE.insert) return record[field.name];
    // An empty field of an existing record also shows its prepopulated value (live: item-edit
    // populated and inactive-record pages fill the current user's e-mail, the configured text
    // and today's date into empty columns).
    if (mode !== FORM_MODE.insert && field.prepopulate !== undefined && field.prepopulate !== null) return field.prepopulate;
    if (mode === FORM_MODE.insert) {
      if (entityReference && field.name === entityReference.field) return entityReference.value;
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
        // Without a DefaultViewId the choices come from the target's default lookup view (querytype 64; live:
        // its active-records filter leaves deactivated rows out of the dropdown).
        const view = field.lookupView?.entity === entity ? field.lookupView : (metadata?.views ?? []).find((candidate) => candidate.entity === entity && candidate.queryType === 64 && candidate.isDefault && candidate.fetchXml) ?? null;
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
  // The fields of a survey control group (adx_groupname with the same control style), in layout order.
  let layoutFields = null;
  const surveyGroup = (field) =>
    (layoutFields ??= formCells(schema).map((cell) => byName.get(cell.name)).filter(Boolean))
      .filter((other) => field.groupName && other.groupName === field.groupName && other.controlStyle === field.controlStyle);
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
    const emptyOption = (selected) => `<option${selected ? ' selected="selected"' : ""} value=""${restoredPostback ? "" : ' label="Select" aria-label="Select"'}></option>`;
    const css = field.cssClass ? ` ${attr(field.cssClass)}` : " ";
    const required = field.required && !disabled ? ' aria-required="true"' : "";
    switch (field.control) {
      case "lookup": {
        const name = current?.name ?? "";
        const idValue = canonicalId(scalar);
        let logical = current?.logical_name ?? (idValue && field.targets?.length === 1 ? field.targets[0] : "");
        if (field.hidden)
          return `<input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(idValue)}><input name="${nameAttr(field, "_name")}" type="hidden" id="${attr(field.id)}_name"${valueAttr(name)}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical)}>`;
        if (field.lookupStyle === "dropdown" && formLevel && idValue) {
          // A read-only form renders the disabled list with the current record only, plus the
          // ASP.NET value and selected-index fields (live reader page).
          const item = bs.v5 ? ' class="dropdown-item"' : "";
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" disabled="disabled" class="aspNetDisabled lookup form-control readonly" onchange="setIsDirty(this.id);" aria-disabled="true"${formReadonly}><option selected="selected" value="${attr(idValue)}"${item}>${escape(name)}</option></select><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical || (field.targets?.length === 1 ? field.targets[0] : ""))}><input type="hidden" name="${nameAttr(field, "_Value")}" id="${attr(field.id)}_Value" value="${attr(idValue)}"><input type="hidden" name="${nameAttr(field, "_SelectedIndex")}" id="${attr(field.id)}_SelectedIndex" value="0">`;
        }
        if (field.lookupStyle === "dropdown") {
          const choices = field.choices.some((choice) => choice.id === idValue) || !idValue ? field.choices : [{ id: idValue, entity: logical, label: name }, ...field.choices];
          const polymorphic = field.targets?.length > 1;
          const onChange = polymorphic ? "document.getElementById(this.id + '_entityname').value=this.selectedOptions[0]?.dataset.entity || '';setIsDirty(this.id);" : 'setIsDirty(this.id);';
          // Bootstrap 5 marks every dropdown lookup option as a dropdown item.
          const item = bs.v5 ? ' class="dropdown-item"' : "";
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="lookup form-control${css}" onchange="${attr(onChange)}"${field.required ? ' required=""' : ""}${disabled ? ' disabled="disabled" aria-disabled="true"' : ""}${formReadonly}>${`<option${item} value="" label="Select" aria-label="Select"></option>`}${choices.map((choice) => `<option value="${attr(choice.id)}"${item}${polymorphic ? ` data-entity="${attr(choice.entity)}"` : ''}${choice.id === idValue ? ' selected="selected"' : ""}>${escape(choice.label)}</option>`).join("")}</select><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical || (field.targets?.length === 1 ? field.targets[0] : ""))}>`;
        }
        if (disabled) {
          const locked = field.ownerLocked && field.required;
          return `<div><input name="${nameAttr(field, "_name")}" type="text"${valueAttr(name)} id="${attr(field.id)}_name"${field.tooltip ? ` title="${attr(field.tooltip)}"` : ""} class="text form-control lookup form-control${css}${(bs.v5 && formLevel) || field.ownerLocked ? "" : " readonly"}" readonly="${readOnly ? "readonly" : ""}" aria-readonly="true" aria-labelledby="${locked ? "" : attr(field.id) + "_label"}" aria-label="${attr(locked ? field.requiredMessage || `${field.label} is a required field.` : field.label)}" tabindex="0"><input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${locked ? ' aria-required="true" aria-invalid="true"' : ""}${valueAttr(idValue)}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical)}></div>`;
        }
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
        const buttons = `<button type="button" class="btn btn-default clearlookupfield" title="${attr(field.label)} Clear lookup field" aria-label="${attr(field.label)} Clear lookup field"><span class="${bs.srOnly}">Clear lookup field</span><span class="fa fa-times" aria-hidden="true"></span></button><button type="button" class="btn btn-default launchentitylookup" ${bs.toggle}="tooltip" title="${attr(field.label)} Launch lookup modal" aria-label="${attr(field.label)} Launch lookup modal"><span class="${bs.srOnly}">Launch lookup modal</span><span class="fa fa-search" aria-hidden="true"></span></button>`;
        const authenticated = Boolean(identity?.contactId ?? identity?.id);
        const gridAttributes = bs.v5
          ? `data-mobile-view-enabled="false" data-select-mode="Single" data-selected-view="${attr(layouts[0]?.Configuration?.Id ?? "")}" data-toggle-filter-text="Toggle filter" data-user-isauthenticated="${authenticated}" data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}"`
          : `data-mobile-view-enabled="true" data-select-mode="Single" data-selected-view="${attr(layouts[0]?.Id ?? "")}" data-toggle-filter-text="Toggle filter" data-user-isauthenticated="${authenticated}"`;
        const gridChildren = bs.v5
          ? `<div class="view-grid"></div>${gridMessages(bs)}${PAGINATION}${gridErrorModal(bs)}`
          : `<div role="alert" aria-live="assertive" aria-atomic="true" aria-relevant="additions text" id="SearchCountText${attr(field.id)}" class="sr-only"></div><div class="view-grid"></div>${LOOKUP_GRID_MESSAGES}${PAGINATION}`;
        // A required lookup is labelled by its required-field message and its value field is marked
        // invalid, empty or not (live: required-field insert form, referenced and edited lookups).
        const referenced = Boolean(field.required);
        // A referenced lookup posts no entity name (live evidence).
        if (entityReference?.field === field.name) logical = "";
        return `<div class="input-group"${bs.v5 ? "" : ' role="none"'}><input name="${nameAttr(field, "_name")}" type="text"${valueAttr(name)} id="${attr(field.id)}_name"${field.tooltip ? ` title="${attr(field.tooltip)}"` : ""} class="text form-control lookup form-control${css}" readonly="" aria-readonly="true" aria-labelledby="${referenced ? "" : attr(field.id) + "_label"}" aria-label="${attr(referenced ? field.requiredMessage || `${field.label} is a required field.` : field.label)}"><input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(idValue)}${required}${referenced ? ' aria-invalid="true"' : ""}><input name="${nameAttr(field, "_entityname")}" type="hidden" id="${attr(field.id)}_entityname"${valueAttr(logical)}>${bs.v5 ? buttons : `<div class="input-group-btn">${buttons}</div>`}</div><div id="${attr(field.id)}_lookupmodal" class="lookup-modal"><div class="entity-lookup" data-languagecode="1033" data-lookup-datafieldname="${attr(field.id)}" data-lookup-reference_entityformid="${attr(createForm)}" data-url="/_services/entity-lookup-grid-data.json/${websiteId}">${nativeModal({
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
        // A posted-back check box carries the browser's "on" (the postback values overlay the record).
        const bool = scalar === true || scalar === 1 || /^(true|1|on)$/i.test(String(scalar ?? ""));
        const options = field.options?.length ? field.options : [{ value: 0, label: "No" }, { value: 1, label: "Yes" }];
        const label = (bit) => options.find((option) => Number(option.value) === bit)?.label ?? (bit ? "Yes" : "No");
        const classId = canonicalId(field.controlClassId);
        // Multiple choice (adx_controlstyle 100000007): a check box of the group; the group's first
        // box carries the group validator (live response body).
        if (field.controlStyle === 100000007) {
          const group = attr(field.groupName);
          const first = surveyGroup(field)[0]?.name === field.name;
          return `<span class="${formLevel ? "aspNetDisabled " : ""}checkbox checkbox${css} ${group}"${formReadonly}><input id="${attr(field.id)}" type="checkbox" name="${nameAttr(field)}"${bool ? ' checked="checked"' : ""} onclick="setIsDirty(this.id);"${disabled ? ' disabled="disabled"' : ""}></span>${first ? `<span id="multipleChoiceValidator${group}" class="validator-text" style="display:none;"></span>` : ""}`;
        }
        if (classId === DROPDOWN_CLASS) {
          const blank = field.ignoreDefault && scalar == null;
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${readOnly ? "aspNetDisabled " : ""}form-control boolean-dropdown${css}" onchange="setIsDirty(this.id);"${fieldLevel ? ' disabled="disabled" aria-disabled="true"' : formLevel ? ' disabled="disabled"' : ""}${formReadonly}>${field.ignoreDefault ? `<option value=""${blank ? ' selected="selected"' : ""}></option>` : ""}<option${!blank && !bool ? ' selected="selected"' : ""} value="0">${escape(label(0))}</option><option${!blank && bool ? ' selected="selected"' : ""} value="1">${escape(label(1))}</option></select>`;
        }
        // A read-only form disables the ASP.NET list and box controls: aspNetDisabled wrappers.
        if (classId === RADIO_CLASS)
          return `<span id="${attr(field.id)}" class="${formLevel ? "aspNetDisabled " : ""}boolean-radio${css}" onchange="setIsDirty(this.id);"${field.required ? ' data-required="true" aria-invalid="true"' : ""}${formLevel ? ' disabled="disabled"' : ""}${formReadonly}>${[0, 1].map((bit) => { const radio = `<input id="${attr(field.id)}_${bit}" type="radio" name="${nameAttr(field)}" value="${bit}"${scalar != null && !field.ignoreDefault && bool === Boolean(bit) ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><label for="${attr(field.id)}_${bit}"><span class='${bs.srOnly}'>${escape(field.label)} </span>${escape(label(bit))}</label>`; return formLevel ? `<span class="aspNetDisabled">${radio}</span>` : radio; }).join("")}</span>`;
        return `<span class="${formLevel ? "aspNetDisabled " : ""}checkbox${css}"${formReadonly}><input id="${attr(field.id)}" type="checkbox" name="${nameAttr(field)}"${bs.v5 ? ` aria-label="${attr(field.label)}"` : ""}${bool ? ' checked="checked"' : ""} onclick="setIsDirty(this.id);"${disabled ? ' disabled="disabled"' : ""}></span>`;
      }
      case "picklist": {
        const options = optionsFor(field);
        const selected = scalar == null || scalar === "" ? null : Number(scalar);
        // Matrix (adx_controlstyle 100000006): one table row of labelled radio buttons, labels on
        // top, the options in reverse order (live response bodies of a local and a global choice).
        if (field.controlStyle === 100000006)
          return `<table id="${attr(field.id)}" class="picklist horizontal labels-top${css}" role="presentation" onchange="setIsDirty(this.id);"><tr>${[...options].reverse().map((option, index) => `<td><label for="${attr(field.id)}_${index}"><span class='${bs.srOnly}'>${escape(field.label)} </span>${escape(option.label ?? option.value)}</label><input id="${attr(field.id)}_${index}" type="radio" name="${nameAttr(field)}" value="${attr(option.value)}"${Number(option.value) === selected ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}></td>`).join("")}</tr></table>`;
        // A read-only form disables the radio list: the list and each option carry aspNetDisabled
        // (ASP.NET disabled RadioButtonList, live reader page).
        if ((field.controlStyle === 100000000 || field.controlStyle === 100000001) && formLevel)
          return `<span id="${attr(field.id)}" disabled="disabled" class="aspNetDisabled picklist ${field.controlStyle === 100000000 ? "vertical" : "horizontal"}${css}" role="presentation" onchange="setIsDirty(this.id);"${formReadonly}>${options.map((option, index) => `<span class="aspNetDisabled"><input id="${attr(field.id)}_${index}" type="radio" name="${nameAttr(field)}" value="${attr(option.value)}"${Number(option.value) === selected ? ' checked="checked"' : ""} disabled="disabled"><label for="${attr(field.id)}_${index}"><span class='${bs.srOnly}'>${escape(field.label)} </span>${escape(option.label ?? option.value)}</label></span>`).join(field.controlStyle === 100000000 ? "<br>" : "")}</span>`;
        if (field.controlStyle === 100000000 || field.controlStyle === 100000001)
          return `<span id="${attr(field.id)}" class="picklist ${field.controlStyle === 100000000 ? "vertical" : "horizontal"}${css}" role="presentation" onchange="setIsDirty(this.id);"${field.required ? ' data-required="true" aria-invalid="false" title="Please select an item in this list"' : ""}>${options.map((option, index) => `<input id="${attr(field.id)}_${index}" type="radio" name="${nameAttr(field)}" value="${attr(option.value)}"${Number(option.value) === selected ? ' checked="checked"' : ""}${disabled ? ' disabled="disabled"' : ""}><label for="${attr(field.id)}_${index}"><span class='${bs.srOnly}'>${escape(field.label)} </span>${escape(option.label ?? option.value)}</label>`).join(field.controlStyle === 100000000 ? "<br>" : "")}</span>`;
        // PicklistControlTemplate: every option follows an empty "Select" option; a required
        // dropdown carries required="" (the platform app bundle removes it on load).
        const picklistOptions = `${emptyOption(selected == null)}${options.map((option) => `<option${Number(option.value) === selected ? ' selected="selected"' : ""} value="${attr(option.value)}">${escape(option.label ?? option.value)}</option>`).join("")}`;
        // Bootstrap 5 option sets are form-select boxes.
        const selectClass = bs.v5 ? "form-control form-select picklist" : "form-control picklist";
        if (fieldLevel)
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${readOnly ? "aspNetDisabled " : ""}readonly ${selectClass}${css}" onchange="setIsDirty(this.id);" disabled="disabled" aria-disabled="true"${formReadonly}>${picklistOptions}</select><input type="hidden" name="${nameAttr(field, "_Value")}" id="${attr(field.id)}_Value" value="${attr(selected ?? "")}">`;
        if (formLevel)
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="aspNetDisabled ${selectClass}${css}" onchange="setIsDirty(this.id);" disabled="disabled"${formReadonly}>${picklistOptions}</select>`;
        return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${selectClass}${css}" onchange="setIsDirty(this.id);"${field.required ? ` required=""${bs.v5 ? ' aria-required="true" aria-invalid="false" title="Please select an item in this list"' : ""}` : ""}>${picklistOptions}</select>`;
      }
      case "state":
      case "status": {
        const option = scalar == null || scalar === "" ? null : (field.options ?? []).find((candidate) => Number(candidate.value) === Number(scalar));
        // The state and status spans carry their values in hidden EntityState/EntityStatus inputs.
        const hiddenValue = bs.v5 ? `<input name="${nameAttr(field, field.control === "state" ? "_EntityState" : "_EntityStatus")}" type="hidden" id="${attr(field.id)}${field.control === "state" ? "_EntityState" : "_EntityStatus"}"${valueAttr(scalar)}>` : "";
        return `<span id="${attr(field.id)}" class="${field.control}${css}">${escape(current?.label ?? option?.label ?? scalar ?? "")}</span>${hiddenValue}`;
      }
      case "multiselect":
        return multiSelectControl(field, { current, options: optionsFor(field), off: disabled || readOnly, formReadonly, nameAttr, hostKey: `${field.id}:${N}`, lcid: formLanguage?.lcid ?? formLanguage?.defaultLcid ?? 1033 });
      case "datetime": {
        // Solution columns use Format=DateAndTime while their generic input
        // type is still "date". The exported format determines the picker.
        const dateOnly = nativeDateOnly(field);
        const behavior = field.dateTimeBehavior ?? field.behavior ?? (dateOnly ? "DateOnly" : "UserLocal");
        const parsed = scalar ? parseDateValue(scalar) : null;
        const iso = parsed ? new Date(parsed.ms).toISOString().replace(/\.\d{3}Z$/, '.0000000' + (behavior === 'UserLocal' ? 'Z' : '')) : scalar ? String(scalar) : "";
        // crmentityformview-datetime.js: a read-only picker keeps its visible box without the
        // input group, the placeholder or the (hidden) calendar button, whose title and label
        // are the Datetimepicker_Datepicker_Label resource.
        // The server renders the bound text box alone (live response body); the platform's
        // crmentityformview-datetime.js builds the picker group, which the local date
        // controls runtime (date-controls.mjs) reproduces from the same attributes.
        return `<input name="${nameAttr(field)}" type="text" id="${attr(field.id)}" class="datetime form-control${css}" data-ui="datetimepicker" data-type="${dateOnly ? "date" : "datetime"}" data-attribute="${attr(field.id)}" data-behavior="${attr(behavior)}"${valueAttr(iso)}${disabled ? ' readonly="readonly"' : ""}${field.required && !disabled && bs.v5 ? ' required="" aria-invalid="true" onfocus="validateRequiredField(this.id);"' : ""}>`;
      }
      case "richtext":
        return richTextInput(field, current, { portal, managedControls, nameAttr });
      case "file":
      case "image":
        return fileColumnInput(field, { id, entity: schema.entity, record, scalar, nameAttr, readOnly, origin: requestOrigin(context) });
      case "textarea":
        if (field.composite === "address") {
          // The platform's address composite: the trigger box (its value the composed address) and
          // a hidden container with one box per address part, labelled by the platform's part
          // names, and its Done button (live read-only contact form).
          const prefix = field.name.replace(/_composite$/, "");
          const parts = [["line1", "Address line 1"], ["line2", "Address line 2"], ["line3", "Address line 3"], ["city", "City"], ["stateorprovince", "State/Province"], ["postalcode", "ZIP/Postal code"], ["country", "Country/Region"]];
          const contentId = randomUUID();
          const readonlyAttr = disabled ? ' readonly="readonly"' : "";
          const boxes = parts.map(([part, label]) => `<input name="${nameAttr(field, "_" + part)}" type="text" id="${attr(field.id)}_${part}" class=" content  text form-control"${valueAttr(scalarValue(record?.[`${prefix}_${part}`]))} aria-label="${label}" onchange="setIsDirty(this.id);"${readonlyAttr}>`).join("");
          return `<textarea name="${nameAttr(field)}" rows="4" cols="20" id="${attr(field.id)}" class="trigger text form-control${css} addressCompositeControl${disabled ? " readonly " : " "}" data-composite-control="" data-content-id="${contentId}" data-editable="${disabled ? "False" : "True"}" data-content-template="{${prefix}_composite_line1} {${prefix}_composite_line2} {${prefix}_composite_line3}{BREAK}{${prefix}_composite_city} {${prefix}_composite_stateorprovince} {${prefix}_composite_postalcode}{BREAK}{${prefix}_composite_country}"${readonlyAttr}>${escape(String(scalar ?? ""))}</textarea><div id="${contentId}" class="content d-none addressCompositeControlContainer">${boxes}<input id="popoverUpdateButton_${randomUUID()}" class="btn btn-primary w-100" role="button" aria-label="Done" readonly="true" value="Done"></div>`;
        }
        // MemoControlTemplate: rows = rowspan * 3 - 2; a maximum length adds the platform's
        // LimitInput/LimitPaste handlers (crmentityformview.js).
        // A one-row cell keeps the two-row (4 line) memo box.
        return `<textarea name="${nameAttr(field)}" rows="${Math.max(Number(field.rowspan) || 2, 2) * 3 - 2}" cols="20"${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ""} id="${attr(field.id)}" class="textarea form-control${css}${fieldLevel ? " readonly" : ""}" onchange="setIsDirty(this.id);"${field.required && (bs.v5 || !disabled) ? ` aria-required="true" title="${attr(field.requiredMessage || `${field.label} is a required field.`)}"` : ""} aria-label="${attr(field.label)}"${disabled ? ' readonly="readonly"' : ""}${field.maxLength ? ' onkeydown="javascript:return LimitInput(this, event);" oninput="javascript:return LimitInput(this, event);" onpaste="javascript:return LimitPaste(this, event);"' : ""}>${escape(scalar ?? "")}</textarea>`;
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
          // The blank choice keeps its label on postback renders too (live save pages; the item-edit form's postback, which drops it beside a value, is the open exception in Wave Q).
          return `<select name="${nameAttr(field)}" id="${attr(field.id)}" class="${formLevel ? "aspNetDisabled " : ""}integer form-control${css}${fieldLevel ? " readonly" : ""}" onchange="setIsDirty(this.id);"${field.required && !disabled ? ' required=""' : ""}${disabled ? ' disabled="disabled"' : ""}${formReadonly}><option${selected == null ? ' selected="selected"' : ""} value=""${rebuiltPostback && selected != null ? "" : ' label=" "'}></option>${choices.map((choice) => `<option${String(choice.value) === selected ? ' selected="selected"' : ""} value="${attr(choice.value)}">${escape(choice.label)}</option>`).join("")}</select>`;
        }
        // Rank order (100000004 no ties, 100000005 allow ties), stack rank (100000008) and constant
        // sum (100000003) whole-number boxes (live response bodies): narrow boxes classed by group.
        if (field.control === "integer" && [100000003, 100000004, 100000005, 100000008].includes(field.controlStyle)) {
          const group = attr(field.groupName);
          const readonlyAttr = disabled ? ' readonly="readonly"' : "";
          if (field.controlStyle !== 100000003)
            return `<input name="${nameAttr(field)}" type="text"${valueAttr(displayed)} id="${attr(field.id)}" class="form-control text integer${css} ${group}" onchange="setPrecision(this.id);setIsDirty(this.id);" style="width:30px;"${readonlyAttr}>${field.controlStyle === 100000004 ? `<span id="RankOrderTieValidator${attr(field.id)}" class="validator-text" style="visibility:hidden;">*</span>` : ""}`;
          // The group's last box carries the read-only total (0 until the client sums) and its validator.
          const last = surveyGroup(field).at(-1)?.name === field.name;
          return `<input name="${nameAttr(field)}" type="text"${valueAttr(displayed)} id="${attr(field.id)}" class="text integer ${group}${css}" onchange="setIsDirty(this.id);setPrecision(this.id);updateConstantSum('${group}');" style="width:30px;"${readonlyAttr}>${last ? `<input name="${attr(ids.names)}ConstantSumTotalValue${group}" type="text" value="0" id="ConstantSumTotalValue${group}" class="total" readonly="readonly" style="width:30px;"><span id="ConstantSumTotalValidator${group}" class="validator-text" style="visibility:hidden;">*</span>` : ""}`;
        }
        const control = `<input name="${nameAttr(field)}" type="text"${valueAttr(displayed)} id="${attr(field.id)}" class="text ${field.control} form-control${css}${fieldLevel ? " readonly" : ""}"${field.control === "double" ? ` data-numberdecimalseparator="${attr(decimalSeparator)}"` : ""} onchange="setIsDirty(this.id);"${disabled ? ' readonly="readonly"' : ""}${field.required && !disabled ? ` required="" aria-invalid="${field.control === "integer" ? "false" : "true"}"` : ""}>`;
        if (field.control !== "money") return control;
        // A money box shows the record currency's symbol as an input-group addon; without a
        // currency it is a plain wrapper.
        // Only a money box holding a value shows the symbol (live: an empty amount keeps the plain wrapper).
        const symbol = displayed !== "" && displayed != null ? await currencySymbol(record?.transactioncurrencyid) : "";
        return symbol ? `<div class="input-group"><span class="${bs.v5 ? "input-group-text" : "input-group-addon"}">${escape(symbol)}</span>${control}</div>` : `<div>${control}</div>`;
      }
      default:
        if (field.hidden && field.control !== "lookup")
          return `<input name="${nameAttr(field)}" type="hidden" id="${attr(field.id)}"${valueAttr(scalar)}>`;
        // The full name composite box (live read-only contact form and step): the platform's
        // composite trigger with a per-render content id; the client composes the name parts.
        if (field.composite === "fullname")
          return `<input name="${nameAttr(field)}" type="text"${valueAttr(scalar)} id="${attr(field.id)}" class="trigger text form-control${css} fullNameCompositeControl${disabled ? " readonly" : ""}" data-composite-control="" data-content-id="${randomUUID()}" data-editable="${disabled ? "False" : "True"}" data-content-template="{fullnamefirstname} {fullnamelastname}" onchange="setIsDirty(this.id);"${disabled ? ' readonly="readonly"' : ""}>`;
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
          // A multistep step's text box whose description shows below it carries the description as its
          // role description (live step markup; basic forms render none).
          const roleDescription = kind === "webform" && field.description?.text && field.description.position === 100000001 ? ` aria-roledescription="${attr(plainText(field.description.text))}"` : "";
          // A required URL box (url and ticker formats) is marked by required="" alone and a required
          // e-mail box by required="" with its title and label; other boxes by aria-required (live
          // required-field form). Bootstrap 5 keeps them on read-only boxes too (auto number).
          const requiredOn = field.required && (bs.v5 || !disabled);
          const requiredTitle = ` title="${attr(field.requiredMessage || `${field.label} is a required field.`)}" aria-label="${attr(field.label)}"`;
          const requiredText = !requiredOn ? "" : type === "url" ? ' required=""' : type === "email" ? ` required=""${requiredTitle}` : ` aria-required="true"${requiredTitle}`;
          return `<input name="${nameAttr(field)}" type="${type}"${valueAttr(scalar)}${field.maxLength ? ` maxlength="${Number(field.maxLength)}"` : ""} id="${attr(field.id)}" class="${ticker ? "tickersymbol " : ""}text form-control${css}${fieldLevel ? " readonly" : ""}"${launch ? ` ondblclick="${launch}(this.value);"` : ""} onchange="${change}"${phone ? ' placeholder="Provide a telephone number"' : ""}${disabled ? ' readonly="readonly"' : ""}${requiredText}${roleDescription}${field.maxLength ? ' onkeypress="javascript:return LengthError(this, event);"' : ""}${launch ? ' style="text-decoration:underline;"' : ""}>`;
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
          : field.control === 'multiselect' ? multiSelectValues(current) : scalarValue(current);
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
    if (cell.type === "webresource" && HTML_WEB_RESOURCE.test(String(cell.url ?? "")) && truthy(fieldOf(componentMetadata, "renderwebresourcesinline"))) {
      // Inline rendering embeds an HTML web resource's body content in the cell instead of the frame,
      // inside a literal element named by the cell that its label points at (live survey step1).
      const name = String(cell.url ?? "").replace(/^\/+/, "");
      let source = null;
      if (!name.includes("..")) for (const root of metadata?.roots ?? []) {
        source = await fs.readFile(`${root}/WebResources/${name}`, "utf8").catch(() => null);
        if (source != null) break;
      }
      const body = source == null ? "" : (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(source)?.[1] ?? source);
      const label = cell.showLabel === false ? "" : `<label for="${attr(cell.id)}" class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${renderFormLabel(cell.label ?? cell.id)}</label>`;
      extraControls.set(cell.id, `<div class="${bs.info}">${label}</div><div class="control"><literal id="${attr(cell.id)}">${body}</literal></div>`);
      continue;
    }
    if (cell.type === "webresource") {
      // WebResourceControl: an iframe on /_webresource/{name}, labelled by the cell.
      const label = cell.showLabel === false ? "" : `<label for="${attr(cell.id)}" class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${renderFormLabel(cell.label ?? cell.id)}</label>`;
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
        ? `<div class="${bs.info}">${cell.label ? `<label for="${attr(cell.id)}" class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${renderFormLabel(cell.label)}</label>` : ""}</div><div class="control"><iframe src="${attr(src)}" id="${attr(cell.id)}" tabindex="${relatedId ? 0 : -1}" class="quickform" data-path="${attr(path)}" data-controlid="${attr(cell.id)}" data-formname="${attr(formName)}" data-lookup-element="${attr(cell.lookup)}" role="presentation"></iframe></div>`
        : `<div class="info"></div><div class="control"><iframe src="${attr(src)}" id="${attr(cell.id)}" tabindex="0" class="quickform" data-path="${attr(path)}" data-controlid="${attr(cell.id)}" data-formname="${attr(formName)}" data-lookup-element="${attr(cell.lookup)}" data-entityname="${attr(cell.entity)}" data-entityprimarykeyname="${attr(target.idColumn)}" role="presentation" scrolling="no" title="${attr(cell.label ?? cell.id)}"></iframe></div>`);
      continue;
    }
    if (cell.type === "notes" && !id) {
      // Live: an Insert-mode notes cell is an empty plain cell (no record to annotate).
      extraControls.set(cell.id, "");
      continue;
    }
    if (cell.type === "notes") {
      const row = metadataFor(metadataRows, 100000005, () => true);
      const settings = { ...cell.settings, ...settingsJson(fieldOf(row, "notes_settings")) };
      const target = { objectid: { id, logical_name: schema.entity } };
      // A form whose notes allow adding carries its note attachment settings, even when the
      // visitor may not add (live: reader and parent-scope item-edit pages).
      if (settings.CreateEnabled === true) settings.attachmentToken = noteAttachmentToken(definition?.id ?? name, settings);
      for (const [flag, operation] of [["CreateEnabled", "create"], ["EditEnabled", "update"], ["DeleteEnabled", "delete"]]) {
        if (!store.allowed("annotation", operation, target, identity)) settings[flag] = false;
      }
      // Adding a note also appends it to the record: the visitor needs AppendTo on the record
      // (Power Pages note permissions; live reader page: add disabled, edit and delete kept).
      if (settings.CreateEnabled === true && record && typeof store.allowed === "function" && !store.allowed(schema.entity, "appendTo", record, identity)) settings.CreateEnabled = false;
      extraControls.set(cell.id, renderNotesControl({ record, id, entity: schema.entity, websiteId, settings, label: cell.showLabel === false ? null : cell.label, language: formLanguage, bs, rowspan: cell.rowspan }));
      continue;
    }
    const label = cell.label ?? cell.id;
    if (!id) {
      // Native subgrids bind to an existing record: Insert mode renders an empty plain cell (live).
      extraControls.set(cell.id, "");
      continue;
    }
    // A reference form whose systemform no basic form uses has no exported grid binding: its subgrid
    // cell stays empty rather than failing the page (unobserved; the fixture forms bind none).
    if (options.referenceForm && !schemaSourceId) {
      extraControls.set(cell.id, "");
      continue;
    }
    // A reference read-only form renders its subgrids with the platform defaults (no basic form settings).
    const model = { ...subgridModel({ portal, schemas, metadata, store, kind, formId: schemaSourceId ?? definition?.id ?? name, stepId: schema.stepId, gridId: cell.id }), ...(options.referenceForm ? { settings: {} } : {}) };
    const gridMetadata = metadataFor(metadataRows, 100000003, row => fieldOf(row, 'subgrid_name') === cell.id);
    let codeComponentNotice = '';
    if (Number(fieldOf(gridMetadata, 'controlstyle')) === 756150001) {
      const message = `Subgrid ${label} uses a configured dataset code component. Its hosted relationship binding is not implemented locally; the native related grid below is a fallback.`;
      options.diagnostic?.({ code: 'PCF_NATIVE_DATASET_UNSUPPORTED', severity: 'warning', component: kind, form: definition?.id, grid: cell.id, message });
      codeComponentNotice = `<div role="alert" data-mirage-component="codecomponent">${escape(message)}</div>`;
    }
    // A subgrid without a relationship (empty RelationshipName) lists its whole view and carries no
    // parent attributes (live Contact form ActionCards).
    const unbound = !String(cell.relationship ?? "").trim();
    if (!unbound && (!model.relationship || !model.relationship.many || canonicalId(model.relationship.entity) !== canonicalId(cell.entity)))
      throw componentError(`Subgrid ${cell.id} requires exported relationship ${cell.relationship}`, 501, "SUBGRID_RELATIONSHIP_REQUIRED");
    const actions = actionLinks(model.settings, { portal, requestUrl: context.request?.url ?? "http://localhost/", website: websiteId });
    for (const action of actions) action.Enabled = action.Enabled && (action.Type !== 3 || !store.allowed || store.allowed(cell.entity, "create", unbound ? {} : { [model.relationship.to]: id }, identity));
    const layouts = gridLayouts(model, { secureBase: { t: "subgrid", w: websiteId, kind, form: schemaSourceId ?? definition?.id ?? name, step: schema.stepId ?? null, grid: cell.id, parent: canonicalId(id) }, websiteId, metadata, actions, language: formLanguage });
    const associate = actions.find((action) => action.Type === 5);
    let associateHtml = "";
    if (associate) {
      const associateModelValue = associateModel({ portal, schemas, metadata, store, kind, formId: schemaSourceId ?? definition?.id ?? name, stepId: schema.stepId, gridId: cell.id });
      const associateLayouts = gridLayouts(associateModelValue, { secureBase: { t: "associate", w: websiteId, kind, form: definition?.id ?? name, step: schema.stepId ?? null, grid: cell.id, parent: canonicalId(id) }, websiteId, metadata, actions: [], selectColumn: bs.srOnly, language: formLanguage });
      const reverseSchema = model.relationship.schemaName ?? cell.relationship;
      // The associate dialog (LookupDialog metadata): its CssClass joins the wrapper and the
      // candidate grid, its Size picks the dialog width, its DefaultErrorMessage replaces the
      // alert, its SelectRecordsTitle heads the selected-records panel and its button texts and
      // classes extend the footer buttons (live evidence; defaults are the platform's).
      const dialog = model.settings?.LookupDialog ?? {};
      const dialogCss = formLabel(dialog.CssClass, "");
      const dialogClass = dialogCss ? " " + attr(dialogCss) : "";
      const dialogError = formLabel(dialog.DefaultErrorMessage, "");
      const selectTitle = formLabel(dialog.SelectRecordsTitle, "Selected records");
      const primaryText = formLabel(dialog.PrimaryButtonText, "Add"), closeText = formLabel(dialog.CloseButtonText, "Cancel");
      const primaryCss = formLabel(dialog.PrimaryButtonCssClass, ""), closeCss = formLabel(dialog.CloseButtonCssClass, "");
      const dismissText = formLabel(dialog.DismissButtonSrText, "Close");
      const size = dialog.Size == null ? "modal-lg" : MODAL_SIZES[Number(dialog.Size)] ?? "";
      const authenticated = Boolean(identity?.contactId ?? identity?.id);
      const parentAccount = bs.v5 ? ` data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}"` : "";
      const candidateGrid = `<div class="entity-grid associate-lookup${dialogClass}" data-column-width-style="Percent" data-defer-loading="true" data-enable-actions="false" data-get-url="/_services/entity-subgrid-data.json/${websiteId}" data-grid-class="" data-mobile-view-enabled="${!bs.v5}" data-select-mode="Multiple" data-selected-view="${attr(associateLayouts[0]?.Id ?? "")}" data-user-isauthenticated="${authenticated}"${parentAccount} data-view-layouts="${base64Json(associateLayouts)}"><div class="view-grid"></div>${gridMessages(bs)}${PAGINATION}${bs.v5 ? gridErrorModal(bs) : ""}</div>`;
      const selected = bs.v5
        ? `<div class="content-panel card portal-card-default"><div class="card-header"><h2>${escape(selectTitle)}</h2></div><div class="selected-records card-body"></div></div>`
        : `<div class="panel panel-default content-panel"><div class="panel-heading"><h4>${escape(selectTitle)}</h4></div><div class="panel-body selected-records"></div></div>`;
      const button = (label, primary, css) => {
        const base = primary ? "primary btn btn-primary" : "cancel btn btn-default";
        const dismiss = primary ? "" : ` ${bs.dismiss}="modal"`;
        return bs.v5
          ? `<button aria-label="${attr(label)}" class="${base}${css ? " " + attr(css) : ""}"${dismiss} tabindex="0" title="${attr(label)}" type="button">${escape(label)}</button>`
          : `<button class="${base}"${dismiss} type="button">${escape(label)}</button>`;
      };
      const errorMessage = dialogError ? escape(dialogError) : `<div class="alert alert-block alert-danger">We're sorry, an error has occurred.</div>`;
      associateHtml = `<div class="entity-associate associate-lookup${dialogClass}" data-url="/_services/entity-lookup-associate/${websiteId}" data-associate="${crlfAttr(JSON.stringify({ Target: { LogicalName: schema.entity, Id: canonicalId(id) }, Relationship: { SchemaName: reverseSchema } }, null, 2))}">${nativeModal({
        bs,
        className: "modal-associate",
        title: escape(formLabel(dialog.Title, "Associate")),
        size,
        dismissText,
        body: `<div class="modal-error message" aria-hidden="true"${bs.v5 ? "" : ' style="display:none"'}>${errorMessage}</div>${candidateGrid}${selected}`,
        footer: `${button(primaryText, true, primaryCss)}${button(closeText, false, closeCss)}`,
      })}</div>`;
    }
    const settings = model.settings ?? {};
    // The grid class keeps the platform default and appends the configured GridCssClass as is.
    extraControls.set(
      cell.id,
      `<h3 class="${bs.info} form-subgrid-heading">${cell.showLabel === false ? "" : `<label for="${attr(cell.id)}" class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${subgridLabel(label)}</label>`}</h3><div class="control">${codeComponentNotice}<div id="${attr(cell.id)}" class="subgrid"><div class="entity-grid subgrid${settings.CssClass ? " " + attr(settings.CssClass) : ""}" data-column-width-style="${Number(settings.GridColumnWidthStyle ?? 1) === 0 ? "Pixels" : "Percent"}" data-defer-loading="false" data-enable-actions="true" data-get-url="/_services/entity-subgrid-data.json/${websiteId}" data-grid-class="table-striped${settings.GridCssClass ? " " + attr(settings.GridCssClass) : ""}" data-mobile-view-enabled="${!bs.v5}"${unbound ? "" : ` data-ref-entity="${attr(schema.entity)}" data-ref-id="${attr(canonicalId(id))}" data-ref-rel="${attr(model.relationship.schemaName ?? cell.relationship)}"`} data-select-mode="None" data-selected-view="${attr(layouts[0]?.Id ?? "")}" data-update-url="/_services/entity-grid-update-entity/${websiteId}" data-user-isauthenticated="${Boolean(identity?.contactId ?? identity?.id)}"${bs.v5 ? ` data-user-parent-account-name="${attr(identity?.parentcustomerid?.name ?? "")}"` : ""} data-view-layouts="${base64Json(layouts)}"><div class="view-grid"></div>${gridMessages(bs, settings, formLanguage)}${PAGINATION}${gridModals(`/_portal/modal-form-template-path/${websiteId}`, settings, formLanguage, bs)}${associateHtml}</div></div></div>`,
    );
  }
  const cellControl = async (cell) => {
    if (extraControls.has(cell.id)) return extraControls.get(cell.id);
    const resolved = byName.get(cell.name) ?? cell;
    if (resolved.ownerHidden) return "";
    const fieldValidatorsList = fieldValidators(resolved, { linksEnabled, readOnly });
    // A server-side validation failure (postback) shows the failing validator and starts it
    // invalid (live: no style, isvalid = "False").
    for (const failure of postback?.validationErrors ?? []) {
      if (failure.field !== resolved.name) continue;
      const prefix = { FormFieldOutOfRange: "RangeValidator", FormFieldRequired: "RequiredFieldValidator", FormFieldTooLong: "MaximumLengthValidator" }[failure.code];
      const failed = prefix ? fieldValidatorsList.find((validator) => validator.id.startsWith(prefix)) : fieldValidatorsList.find((validator) => !/^(?:RangeValidator|RequiredFieldValidator|MaximumLengthValidator)/.test(validator.id));
      if (failed) failed.isvalid = "False";
    }
    validators.push(...fieldValidatorsList);
    const labelFor = (resolved.control === "lookup" && resolved.lookupStyle !== "dropdown") || ["file", "image"].includes(resolved.control) || resolved.control === "boolean" && canonicalId(resolved.controlClassId) === RADIO_CLASS || resolved.control === "picklist" && [100000000, 100000001, 100000006].includes(resolved.controlStyle) || /^(state|status)$/.test(resolved.control)
      ? ""
      : ` for="${attr(resolved.id)}"`;
    const description = resolved.description?.text ? resolved.description : null;
    const descriptionHtml = (position) => (description && description.position === position ? `<div class="description${position === 100000000 ? " above" : position === 100000001 ? " below" : ""}${resolved.cssClass ? " " + attr(resolved.cssClass) : ""}">${description.text}</div>` : "");
    const labelHtml = resolved.showLabel === false ? "" : `<label${labelFor} id="${attr(resolved.id)}_label"${resolved.tooltip ? ` title="${attr(resolved.tooltip)}"` : ""} class="field-label"${readOnly ? ' readonly="readonly"' : ""}>${renderFormLabel(resolved.label)}</label>`;
    // CellTemplate: a field-level read-only cell has no validator container; a read-only form
    // keeps its validators (marked read-only). The app bundle then makes the containers of
    // read-only lookups and option sets focusable (lib/platform-app-compat.js).
    const fieldLevelReadOnly = resolved.fieldReadOnly ?? resolved.readOnly;
    // Bootstrap 5 marks a required column required even when it is read-only.
    return `${descriptionHtml(100000002)}<div class="${bs.info}${resolved.required && (bs.v5 || !resolved.readOnly) ? " required" : ""}">${labelHtml}${fieldLevelReadOnly && !/^(?:file|image)$/.test(resolved.control) ? "" : `<div class="validators">${validatorMarkup(fieldValidatorsList, { readonly: readOnly })}</div>`}</div>${descriptionHtml(100000000)}<div class="control" data-logical-name="${attr(resolved.name)}">${await input(resolved)}</div>${descriptionHtml(100000001)}`;
  };
  const cellClass = (cell) => {
    if (cell.type === "quickform") return "crmquickform-cell";
    if (cell.type === "subgrid") return id ? "subgrid-cell" : "";
    if (cell.type === "notes") return id ? "notes-cell" : "";
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
        return field.controlStyle === 100000006 ? "picklist-matrix-cell" : "picklist-cell";
      case "multiselect":
        return "form-control-cell";
      case "boolean": {
        const classId = canonicalId(field.controlClassId);
        if (field.controlStyle === 100000007) return "checkbox-cell";
        return classId === DROPDOWN_CLASS ? "boolean-dropdown-cell" : classId === RADIO_CLASS ? "boolean-radio-cell" : "checkbox-cell";
      }
      case "datetime":
        return "datetime form-control-cell";
      case "textarea":
        return field.composite === "address" ? "text form-control-cell" : "textarea form-control-cell";
      case "integer":
      case "decimal":
      case "double":
      case "money":
        if (field.control === "integer" && (field.controlStyle === 100000004 || field.controlStyle === 100000005)) return "rank-order-cell";
        if (field.control === "integer" && field.controlStyle === 100000008) return "stack-rank-cell";
        if (field.control === "integer" && field.controlStyle === 100000003) return "constant-sum form-control-cell";
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
  // adx_referenceentityshowreadonlyform: the step renders the referenced record's read-only
  // form (its own view, ReadOnlyFormView_<table>) ahead of its form. A control of the step's form
  // whose id the read-only form already rendered fails the platform's control registry ("An entry
  // with the same key already exists."): live renders that control's label and validators block
  // with the error and stops the form there (evidence; the docs describe no such clash).
  let referenceHtml = "";
  let referenceControls = null;
  if (kind === "webform" && !options.referenceForm && truthy(fieldOf(componentMetadata, "referenceentityshowreadonlyform")) && entityReference?.value?.id) {
    const refEntity = entityReference.value.logical_name;
    const view = `ReadOnlyFormView_${refEntity}`;
    const formName = fieldOf(componentMetadata, "referenceentityreadonlyformname");
    const reference = await renderForm("entityform", view, context, {
      ...options, onNativePostbackDescriptor: undefined, nativePostbackState: undefined,
      referenceForm: { definition: { id: view, name: view, entityName: refEntity, mode: FORM_MODE.readOnly, metadata: { adx_entityname: refEntity, adx_formname: formName, adx_mode: FORM_MODE.readOnly } }, id: entityReference.value.id, ids: { wrapper: view, panel: view, view, names: `${ids.buttons}${view}$`, buttons: ids.buttons } },
    });
    referenceHtml = reference.html;
    referenceControls = reference.controls;
  }
  // Auto-generated steps (adx_autogeneratesteps): the platform renders one tab per page; Next and
  // Previous post the page back (the tab index and the earlier tabs' values travel in __VIEWSTATE).
  const autoSteps = kind === "entityform" && !readOnly && truthy(fieldOf(componentMetadata, "autogeneratesteps")) && schema.layout?.length > 1
    ? { tabs: schema.layout, index: Math.min(Math.max(Number(postback?.autoStep) || 0, 0), schema.layout.length - 1) }
    : null;
  // A control the platform cannot render stops the form at its cell: the cell's markup up to the
  // failure, the error alert, one closing tag, then the form's actions and the closers (live
  // evidence: a quick view on a postback-rendered step, an inline web resource, a clashing id).
  const TRUNCATED_ACTIONS = "\u0000actions\u0000";
  let truncated = false;
  const renderFailure = (cell, field) => {
    if (referenceControls?.has(cell.name) && field) return { message: "An entry with the same key already exists.", partial: "validators" };
    // Inline rendering needs an HTML web resource; any other type (an image) fails the form (live).
    if (cell.type === "webresource" && !HTML_WEB_RESOURCE.test(String(cell.url ?? "")) && truthy(fieldOf(componentMetadata, "renderwebresourcesinline"))) return { message: `Unable to find control with id '${cell.id}' that is associated with the Label ''.` };
    if (cell.type === "quickform" && autoSteps && postback && mode === FORM_MODE.insert) return { message: `Unable to find control with id '${cell.id}' that is associated with the Label ''.` };
    return null;
  };
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
    for (const tab of autoSteps ? [autoSteps.tabs[autoSteps.index]] : schema.layout) {
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
          // A visible section always names itself, an unlabelled one with an empty name (live Contact form).
          tabHtml += `<fieldset aria-label="${attr(plainText(sectionLabel))}">${section.showLabel ? `<legend class="section-title"><h3>${renderFormLabel(sectionLabel)}</h3></legend>` : ""}<table role="presentation"${section.name ? ` data-name="${attr(section.name)}"` : ""} class="section${fieldOf(sectionRow, "cssclass") ? " " + attr(fieldOf(sectionRow, "cssclass")) : ""}"><colgroup>${widths.map((width) => `<col style="width:${width}%;">`).join("")}<col></colgroup><tbody>`;
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
              if (field && !field.ownerHidden && !cell.spacer && UNSUPPORTED_FORM_TYPES.test(String(field.dataverseType ?? "")) && truthy(fieldOf(componentMetadata, "showunsupportedfields"))) {
                // With ShowUnsupportedFields the cell names the column, its label, type and format (live).
                const type = String(field.dataverseType ?? "");
                const message = `Unsupported: DataFieldName="${field.name}" Label="${field.label}", AttributeType="${UNSUPPORTED_TYPE_NAMES[type.toLowerCase()] ?? type}", Format="${field.format ?? ""}"`;
                tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell unsupported-cell"><div class="info"><label for="${attr(field.id)}" class="field-label">${escape(field.label)}</label><div class="validators"></div></div><div class="control" data-logical-name="${attr(field.name)}"><span id="${attr(field.id)}">${escape(message)}</span></div></td>`;
                continue;
              }
              if (cell.spacer || field?.ownerHidden || (field && UNSUPPORTED_FORM_TYPES.test(String(field.dataverseType ?? "")))) {
                tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell"></td>`;
                continue;
              }
              const hidden = cell.hidden || field?.ownerHidden || (field?.hidden && field?.control !== "lookup") || field?.hidden;
              const suffix = cellClass(cell);
              const failure = renderFailure(cell, field);
              if (failure) {
                const full = failure.partial === "validators" ? await cellControl(cell) : "";
                const cut = full.indexOf('<div class="validators">');
                const partial = cut >= 0 ? full.slice(0, cut + '<div class="validators">'.length) : `<div class="${bs.info}">`;
                tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell${suffix ? " " + suffix : ""}">${partial}<div class="alert alert-block alert-danger"><p class="text-danger"><span class="fa fa-exclamation-triangle" aria-hidden="true"></span> ${escape(failure.message)}</p></div> </div>${TRUNCATED_ACTIONS} </td></tr></tbody></table></fieldset></div>${progress?.position === "bottom" ? progress.html + "</div>" : ""}</div></div>${TRUNCATED_CLOSE}`;
                truncated = true;
                break;
              }
              tabHtml += `<td colspan="${cell.colspan ?? 1}" rowspan="${cell.rowspan ?? 1}" class="clearfix cell${suffix ? " " + suffix : ""}"${hidden ? ' style="display: none;"' : ""}>${await cellControl(cell)}</td>`;
            }
            if (truncated) break;
            tabHtml += '<td class="cell zero-cell"></td></tr>';
            // A constant sum group's hidden member count follows the row of its first member (live response body).
            for (const cell of row) {
              const field = byName.get(cell.name);
              if (field?.control !== "integer" || field.controlStyle !== 100000003 || !field.groupName) continue;
              const members = surveyGroup(field);
              if (members[0]?.name === field.name) tabHtml += `<input type="hidden" name="${attr(ids.names)}ConstantSumIndex${attr(field.groupName)}" id="ConstantSumIndex${attr(field.groupName)}" value="${members.length}">`;
            }
          }
          if (truncated) break;
          tabHtml += "</tbody></table></fieldset>";
        }
        if (truncated) break;
        tabHtml += "</div></div>";
      }
      if (!truncated) tabHtml += "</div>";
      layoutHtml += tabHtml;
      if (truncated) break;
    }
  } else
    for (const field of fields)
      layoutHtml += `<div class="form-group"${field.hidden ? ' style="display: none;"' : ""}>${await cellControl(field)}</div>`;

  // Attach file (adx_attachfile*): the platform's file upload control. Its files are saved as
  // annotations by the form service (JSON transport: data files; postback: multipart parts).
  let attachHtml = "";
  if (!readOnly && truthy(fieldOf(componentMetadata, "attachfile"))) {
    // Advanced form steps name the accepted types, multiple files and file count with their own
    // columns (adx_accept, adx_allowmultiplefiles, adx_maximumnooffiles; live multistep step).
    const mime = String(fieldOf(componentMetadata, "attachfileaccept") ?? fieldOf(componentMetadata, "accept") ?? "").trim();
    const extensions = String(fieldOf(componentMetadata, "attachfileacceptextensions") ?? "").trim();
    const requiredFile = truthy(fieldOf(componentMetadata, "attachfilerequired"));
    const multiple = truthy(fieldOf(componentMetadata, "attachfileallowmultiple") ?? fieldOf(componentMetadata, "allowmultiplefiles"));
    const label = formLabel(fieldOf(componentMetadata, "attachfilelabel"), "Attach a File");
    const maxKb = Number(fieldOf(componentMetadata, "attachfilemaxsize")) || 0;
    // The control counts five files when several are allowed (platform default) unless the step sets its count.
    // The record's existing note attachments use up the count (live: a revisited start step whose
    // record already carries one attachment offers 2 of 3).
    let attached = 0;
    if (id && readProvider?.fetchXml) {
      const xml = `<fetch><entity name="annotation"><all-attributes/><filter type="and"><condition attribute="objectid" operator="eq" value="${attr(canonicalId(id))}"/></filter></entity></fetch>`;
      const rows = await readProvider.fetchXml(xml, identity).then((result) => result.entities ?? result.value ?? [], () => []);
      attached = rows.filter((row) => row.filename || truthy(row.isdocument)).length;
    }
    const maxFiles = Math.max(0, (Number(fieldOf(componentMetadata, "maximumnooffiles")) || (multiple ? 5 : 1)) - attached);
    const sizeMb = maxKb ? Math.round((maxKb / 1024) * 10) / 10 : 0;
    const kinds = [mime ? mime.replace(/\/\*$/, "").replace(/^[^/]+\//, "") : "", extensions].filter(Boolean).join(", ");
    const hint = `You can upload a maximum of ${maxFiles} file${maxFiles === 1 ? "" : "s"}, ${maxFiles === 1 ? "" : "each "}up to ${sizeMb}MB.${kinds ? ` Supported files include ${kinds}.` : ""}`;
    const sizeMessage = formLabel(fieldOf(componentMetadata, "attachfilesizeerrormessage"), "");
    const typeMessage = formLabel(fieldOf(componentMetadata, "attachfiletypeerrormessage"), "");
    const name = (suffix) => `${attr(ids.names)}AttachFile${suffix}`;
    const hiddenField = (suffix, fieldValue) => `<input type="hidden" name="${name(suffix)}" id="AttachFile${suffix}"${valueAttr(fieldValue)}>`;
    const stagedFiles = postback?.stagedAttachments ?? [];
    const stagedFileInfo = stagedFiles.map(file => `<div class="custom-button"><div class="filename" tabindex="0">${escape(file.name)} (${Number(file.size)} bytes)</div></div>`).join("");
    const requiredAttr = requiredFile ? ' aria-required="true"' : "";
    const warning = (span, close) => `<div class="errordiv ${span === "retrySpanforgeneric" ? "generic" : "deletefail"} alert-danger" style="display:none;"><div class="retrygenericdiv"><img alt="retry" class="imagetag" onerror="javascript: var target = event.target; var img = document.createElement('img'); img.src = '/xrm-adx/icons/warning.png'; img.alt = 'retry'; target.insertAdjacentElement('afterend',img); target.remove();" src="/resource/powerappsportal/icons/warning.png" style="padding: 5px 5px 5px 12px"></div><span class="${span}" style="margin-left:27px;"></span><button aria-hidden="true" class="close" data-dismiss="modal" type="button" style="border:none; background:none;float:right;margin-left:auto" onclick="${close}();"><span aria-hidden="true">×</span><span class="sr-only">Close</span></button></div>`;
    const errorModal = (id, title, body, close) => `<div class="modal fade in errors" id="${id}"><div class="modal-dialog error-modal-dialog"><div class="modal-content" id="modal-content-new"><div class="error-modal-header modal-header" id="error-modal-header" style="display:block;"><h1 class="error-modal-title modal-title" id="error-modal-title">${title}<button aria-hidden="true" class="close" data-dismiss="modal" type="button" style="border:none; background:none;float:right" onclick="${close}();"><span aria-hidden="true">×</span><span class="sr-only">Close</span></button></h1></div><div class="modal-body ${body} modal-content-new" id="${body}"></div><div class="error-modal-footer modal-footer"><button type="button" class="btn btn-primary" data-dismiss="modal" onclick="${close}();">OK</button></div></div></div></div>`;
    // The upload instance id is an opaque platform token; a stable local value stands in.
    const instanceId = createHash("sha256").update(`attach\u0000${definition?.id ?? name}`).digest("base64");
    attachHtml = `${requiredFile ? '<span id="RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds" style="display:none;"></span>' : ""}<div class="tr"><div class="file-cell cell"><div class="${bs.info}${requiredFile ? " required" : ""}"><label for="AttachFile" id="NewAttachFileLabel">${escape(label)}</label>${escape(hint)}</div><div class="ContainerForFile"><div style="display:none;"><input type="file"${multiple ? ' multiple="multiple"' : ""} name="${name("")}" id="AttachFile" accept="${attr(`${mime},${extensions}`)}" onchange="chooseAttachment();"${sizeMessage ? ` data-file-size-error-message="${attr(sizeMessage)}"` : ""}${typeMessage ? ` data-file-type-error-message="${attr(typeMessage)}"` : ""}${requiredAttr}></div>${hiddenField("_HiddenField_Location", "CrmDocument")}${hiddenField("_HiddenField_FormID", canonicalId((kind === "webform" ? schema.stepId : null) ?? definition?.id ?? ""))}${hiddenField("_HiddenField_FormType", kind === "webform" ? "multistep" : "basic")}${hiddenField("_HiddenField_InstanceId", instanceId)}${hiddenField("_HiddenField_RegardingId", id ? canonicalId(id) : "")}${hiddenField("_HiddenField_MaxFile", String(maxFiles))}${hiddenField("_HiddenField_MaxFileSizeInKB", String(maxKb * 1024))}${hiddenField("_HiddenField_SupportedFileType", extensions)}${hiddenField("_HiddenField_SupportedMimeType", mime)}${hiddenField("_HiddenField_SupportedType", `${mime},${extensions}`)}<div class="buttonForFileUpload" aria-label="${attr(label)}"${requiredAttr}><button id="UploadButton" style="width: fit-content; gap: 6px; display:flex" type="button" class="btn btn-default btn-secondary"${requiredAttr} onclick="selectAttachment();"><div class="fa fa-arrow-up"></div> Upload</button><div class="errordiv alert-danger" style="display:none;"><span style="margin-left:27px;">One or More files could not be uploaded. Retry uploading the files.</span></div>${warning("retrySpanforgeneric", "genericcloseAlert")}${warning("retrySpanfordelete", "deletecloseAlert")}</div>${hiddenField("_HiddenField_AnnotationIds", stagedFiles.length ? JSON.stringify(stagedFiles.map(file => file.id)) : "")}<input type="hidden" name="${attr(ids.names)}CdnUrl" id="CdnUrl" value="/resource/powerappsportal"></div><div class="file-info" id="newdivforfileinfo" tabindex="0">${stagedFileInfo}</div></div></div>${errorModal("ModalToShowErrorForFileSize", "You’re over the file size limit", "file-size", "closeModalForFileSize")}${errorModal("ModalToShowErrorForFileLimit", "File upload limit reached", "file-limit", "closeModalForFileLimit")}${errorModal("ModalToShowErrorForFileType", "Unsupported file formats", "file-type", "closeModalForFileType")}`;
    if (requiredFile)
      validators.push({ id: "RequiredFieldValidatorAttachFile_HiddenField_AnnotationIds", controltovalidate: "AttachFile_HiddenField_AnnotationIds", errormessage: summaryLink("AttachFile", formLabel(fieldOf(componentMetadata, "attachfilerequirederrormessage"), `${label} is a required field.`), linksEnabled), display: "None", evaluationfunction: "RequiredFieldValidatorEvaluateIsValid", initialvalue: "" });
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
  // The configured Create related record action as the layout configuration describes it.
  let createRelatedLink = null;
  let defaultButton = "";
  const renderedActions = [];
  if (kind === "webform") {
    const step = schema.metadata ?? {};
    const nextStep = schema.nextStepId ? (advancedSteps ?? schemas[definition?.id]?.steps ?? []).find((candidate) => canonicalId(candidate.stepId) === canonicalId(schema.nextStepId)) : null;
    const terminal = !nextStep || nextStep.type === "redirect";
    const nextLabel = terminal ? formLabel(fieldOf(step, "submitbuttontext"), "Submit") : formLabel(fieldOf(step, "nextbuttontext"), "Next");
    const previousAllowed = stepIndex > 0 && fieldOf(step, "movepreviouspermitted") !== false;
    defaultButton = "NextButton";
    const previous = previousAllowed ? `<div role="group" class="btn-group entity-action-button"><input type="button" name="${attr(ids.buttons)}PreviousButton" value="${attr(formLabel(fieldOf(step, "previousbuttontext"), "Previous"))}" onclick="javascript:__doPostBack('${attr(ids.buttons)}PreviousButton','')" id="PreviousButton" class="${attr(fieldOf(step, "previousbuttoncssclass") || "btn btn-default button previous previous-btn")}" nonactionlinkbutton="true"></div>` : "";
    const next = readOnly && terminal ? "" : `<div role="group" class="btn-group entity-action-button"><input type="button" name="${attr(ids.buttons)}NextButton" value="${attr(nextLabel)}" onclick="${attr(onclick(ids.buttons + "NextButton"))}" id="NextButton" class="${attr(terminal ? fieldOf(step, "submitbuttoncssclass") || "btn btn-primary button next submit-btn" : fieldOf(step, "nextbuttoncssclass") || "btn btn-primary button next submit-btn")}" nonactionlinkbutton="true"></div>`;
    if (previous) renderedActions.push({ button: "PreviousButton", action: "previous" });
    if (next) renderedActions.push({ button: "NextButton", action: "submit" });
    actionsHtml = previous || next ? `<div class="actions"><div class="${bs.v5 ? "col-md-6" : "col-sm-6"} clearfix">${previous}${next}</div></div>` : "";
  } else if (autoSteps && autoSteps.index < autoSteps.tabs.length - 1) {
    // Live evidence: the Next step button renders inside the view (stepButtons); no default button.
    actionsHtml = '<div class="actions"></div>';
  } else {
    // Record action bar (entityform.js): configured Delete, Activate, Deactivate and Create
    // related record actions render as button.*-link elements beside the submit button, the
    // state pair always present with the inapplicable one hidden; their dialogs follow the
    // containers. Insert mode has no record and no record actions.
    const recordButtons = [];
    const recordDialogs = [];
    if (kind === "entityform" && id) {
      const formSettings = settingsJson(portalField(componentMetadata ?? {}, "settings") ?? "", "form settings") ?? {};
      const canUpdate = !store.allowed || store.allowed(mapping.logicalName, "update", record, identity);
      const canDelete = !store.allowed || store.allowed(mapping.logicalName, "delete", record, identity);
      const linkCss = (action) => attr(`${action.ButtonCssClass || "btn btn-default"} btn`);
      // Both state buttons render; the app bundle hides the one the record state rules out (live DOM).
      const stateButton = (action, type) => `<button class="${type}-link ${linkCss(action)}" data-url="/_services/action-${type}/${websiteId}" href="/_services/action-${type}/${websiteId}" type="button">${escape(formLabel(action.ButtonLabel, type === "activate" ? "Activate" : "Deactivate"))}</button>`;
      for (const action of configuredActions) {
        if (action.Type === "DeleteAction" && canDelete) {
          const dialog = formSettings.DeleteDialog ?? {};
          const text = (value, fallback) => formText(value, fallback, formLanguage);
          const title = escape(text(dialog.Title, "Delete"));
          const primary = escape(text(dialog.PrimaryButtonText, "Delete"));
          const close = escape(text(dialog.CloseButtonText, "Cancel"));
          recordButtons.push(`<button class="delete-link ${linkCss(action)}" data-url="/_services/entity-grid-delete/${websiteId}" href="/_services/entity-grid-delete/${websiteId}" type="button">${escape(formLabel(action.ButtonLabel, "Delete"))}</button>`);
          recordDialogs.push(nativeModal({
            bs,
            className: `modal-delete${dialog.CssClass ? " " + attr(text(dialog.CssClass, "")) : ""}`,
            size: MODAL_SIZES[Number(dialog.Size)] ?? "",
            title,
            dismissText: text(dialog.DismissButtonSrText, "Close"),
            body: escape(formLabel(action.Confirmation, "") || "Are you sure you want to delete this record?"),
            footer: `<button aria-label="${primary}" class="primary btn btn-primary${dialog.PrimaryButtonCssClass ? " " + attr(text(dialog.PrimaryButtonCssClass, "")) : ""}" tabindex="0" title="${primary}" type="button">${primary}</button><button aria-label="${close}" class="cancel btn btn-default${dialog.CloseButtonCssClass ? " " + attr(text(dialog.CloseButtonCssClass, "")) : ""}" ${bs.dismiss}="modal" tabindex="0" title="${close}" type="button">${close}</button>`,
          }));
        } else if (action.Type === "ActivateAction" && canUpdate) recordButtons.push(stateButton(action, "activate"));
        else if (action.Type === "DeactivateAction" && canUpdate) recordButtons.push(stateButton(action, "deactivate"));
        else if (action.Type === "CreateRelatedRecordAction") {
          // The platform stamps a fresh filter criteria id on the button and its dialog; the
          // dialog is the generic confirmation (live), posted to the button's (empty) URL.
          const criteria = randomUUID();
          createRelatedLink = {
            Modal: {},
            ...(action.EntityFormId ? { EntityForm: { Id: canonicalId(action.EntityFormId), LogicalName: "adx_entityform", KeyAttributes: [] } } : {}),
            Target: Number(action.TargetType ?? 0),
            Type: 29,
            Label: formLabel(action.ButtonLabel, ""),
            Tooltip: formLabel(action.ButtonTooltip, ""),
            Enabled: true,
            ButtonCssClass: action.ButtonCssClass ?? "",
            SuccessMessage: formLabel(action.SuccessMessage, ""),
            Confirmation: formLabel(action.Confirmation, ""),
            ShowModal: Number(action.ShowModal ?? 0),
            FilterCriteriaId: criteria,
          };
          recordButtons.push(`<button class="create-related-record-link ${linkCss(action)}" data-filtercriteriaid="${criteria}" data-url="" href="" type="button">${escape(formLabel(action.ButtonLabel, "Create related record"))}</button>`);
          const title = "<span class='fa fa-plus-circle' aria-hidden='true'></span> Create related record";
          // An action that opens its target form in a modal (EntityFormId, ShowModal) gets the form dialog
          // with an empty frame the client points at the target form (live response body).
          if (action.EntityFormId && Number(action.ShowModal) === 1)
            recordDialogs.push(nativeModal({ bs, className: "modal-form modal-form-createrecord", title, rawTitle: true, size: "modal-lg", body: formModalBody(`/_portal/modal-form-template-path/${websiteId}`) }).replace(' role="dialog"', ` data-filtercriteriaid="${criteria}" role="dialog"`));
          else recordDialogs.push(nativeModal({ bs, className: "modal-form-createrecord", title, rawTitle: true, body: "Create related record", footer: `<button aria-label="Ok" class="primary btn btn-primary btn-danger" tabindex="0" title="Ok" type="button">Ok</button><button aria-label="Cancel" class="cancel btn btn-default" ${bs.dismiss}="modal" tabindex="0" title="Cancel" type="button">Cancel</button>` }).replace(' role="dialog"', ` data-filtercriteriaid="${criteria}" role="dialog"`));
        } else if (!["SubmitAction", "DeleteAction", "ActivateAction", "DeactivateAction"].includes(action.Type))
          options.diagnostic?.({ code: 'FORM_ACTION_UNSUPPORTED', severity: 'warning', component: 'entityform', form: definition?.name ?? name, action: action.Type, message: `Native form action '${action.Type}' is unsupported.` });
      }
    }
    let submitButton = "";
    if (!readOnly && submitEnabled) {
      const button = mode === FORM_MODE.insert ? "InsertButton" : "UpdateButton";
      renderedActions.push({ button, action: "submit" });
      defaultButton = button;
      const label = formLabel(fieldOf(componentMetadata, "submitbuttontext"), "") || formLabel(submitAction?.ButtonLabel, "") || "Submit";
      // Without form actions a configured class sits between the platform's own classes (live).
      const custom = fieldOf(componentMetadata, "submitbuttoncssclass");
      const css = submitAction ? custom || (submitAction.ButtonCssClass ? `${submitAction.ButtonCssClass} submit-btn` : "btn btn-primary button submit-btn") : `submit-btn ${custom || "btn btn-primary"} form-action-container-left`;
      submitButton = `<input type="button" name="${attr(ids.buttons)}${button}" value="${attr(label)}" onclick="${attr(onclick(ids.buttons + button))}" id="${button}"${submitAction ? ` title="${attr(formLabel(submitAction.ButtonTooltip, label))}"` : ""} class="${attr(css)}">`;
    }
    const column = bs.v5 ? "col-md-6" : "col-sm-6";
    if (submitAction || recordButtons.length)
      actionsHtml = `<div class="row form-custom-actions"><div class="${column} clearfix"><div class="form-action-container-left">${submitButton}${recordButtons.join("")}</div></div><div class="${column} clearfix"><div class="form-action-container-right"></div></div>${recordDialogs.join("")}</div>`;
    // A read-only basic form keeps its (empty) actions container and has no default button.
    else actionsHtml = `<div class="actions">${submitButton}</div>`;
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
    ...(bs.v5 ? { messagePanel: { className: SUCCESS_PANEL_V5, closeButton: { name: `${ids.buttons}btnCloseMessage` } } } : {}),
    // A Power Pages export is a WebForms portal: native forms post the page back unless the
    // project selects the JSON transport (observed.nativeFormTransport: json).
    ...(nativeFormTransport(options.observed ?? portal.observed) === 'postback' ? { transport: 'postback' } : {}),
    // A page rendered by a postback (hosted controls render their postback markup: multiselect-compat.js).
    ...(postback ? { postback: true } : {}),
    fields: fields
      .filter((field) => !field.ownerHidden && !field.readOnly && !["state", "status", "file", "image"].includes(field.control))
      .map((field) => ({ name: field.name, id: field.id, control: controlForSubmit(field), readOnly: false, bindings: field.bindings })),
  };
  const summaryId = `ValidationSummary${ids.view}`;
  // The form's summary header text (adx_validationsummaryheadertext) replaces the platform default (live).
  const summaryHeader = `<h2 class='validation-header'><span role='presentation' class='fa fa-info-circle'></span> ${escape(formLabel(fieldOf(componentMetadata, "validationsummaryheadertext"), "") || "The form could not be submitted for the following reasons:")}</h2>`;
  const layoutConfig = {
    EntityName: schema.entity,
    // The Bootstrap 5 platform renders the empty GUID as the layout id.
    Id: bs.v5 ? EMPTY_GUID : definition?.id ?? null,
    SubmitActionLink: { Modal: {}, Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    PreviousActionLink: { Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    NextActionLink: { Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    CreateRelatedRecordActionLink: createRelatedLink ?? { Modal: {}, Type: 0, Enabled: false, ShowModal: 0, FilterCriteriaId: "00000000-0000-0000-0000-000000000000" },
    // The multistep control reports false whatever the step's setting (live evidence).
    EnableEntityPermissions: kind !== "webform" && fieldOf(componentMetadata, "entitypermissionsenabled") !== false,
    LanguageCode: 0,
    EnableActions: false,
    ShowActionButtonContainer: 0,
    AutoGenerateSteps: truthy(fieldOf(componentMetadata, "autogeneratesteps")),
  };
  // ASP.NET HiddenField: an empty value renders no value attribute (an insert form's EntityID).
  const hidden = (suffix, valueText) =>
    `<input type="hidden" name="${attr(ids.names.replace(/\$$/, ""))}$${attr(ids.view)}_${suffix}" id="${attr(ids.view)}_${suffix}"${String(valueText ?? "") !== "" ? ` value="${attr(valueText)}"` : ""}>`;
  const instructions = formLabel(fieldOf(componentMetadata, "instructions"), "");
  // Bootstrap 5 names the panel after the side it takes: right of a left indicator (live evidence).
  const panelClass = kind !== "webform" ? "crmEntityFormView"
    : bs.v5 ? { left: "crmEntityFormView right col-lg-10 order-1", right: "crmEntityFormView left col-lg-10" }[progress?.position] ?? "crmEntityFormView"
    : progress?.position === "left" ? "crmEntityFormView left" : progress?.position === "right" ? "crmEntityFormView right" : "crmEntityFormView";
  // A postback render (saved, failed or invalid) repeats the view's class, except on a form that
  // sets an entity reference (live: 25 postback captures; the item-edit form 54fc… is the one
  // unexplained exception, see reviews/phase4-K-reply.md Wave Q).
  const entityFormClass = readOnly ? "form-readonly entity-form" : restoredPostback ? "entity-form entity-form" : "entity-form";
  // Auto-generated steps: WebForms submit buttons after the tab (live: an empty __EVENTTARGET and
  // the button's own name=value pair); Previous skips validation. Previous markup is unobserved.
  let stepButtons = "";
  if (autoSteps) {
    const stepButton = (button, text, css, validate) => `<input type="submit" name="${attr(ids.names)}${button}" value="${attr(text)}" onclick="javascript:WebForm_DoPostBackWithOptions(new WebForm_PostBackOptions(&quot;${attr(ids.names)}${button}&quot;, &quot;&quot;, ${validate}, &quot;&quot;, &quot;&quot;, false, false))" id="${button}" class="${attr(css)} form-action-container-left">`;
    if (autoSteps.index > 0) {
      renderedActions.push({ button: "PreviousButton", action: "tab", actionIndex: autoSteps.index - 1, view: true });
      stepButtons += stepButton("PreviousButton", formLabel(fieldOf(componentMetadata, "previousbuttontext"), "Previous"), fieldOf(componentMetadata, "previousbuttoncssclass") || "btn btn-default", false);
    }
    if (autoSteps.index < autoSteps.tabs.length - 1) {
      renderedActions.push({ button: "NextButton", action: "tab", actionIndex: autoSteps.index + 1, view: true });
      stepButtons += stepButton("NextButton", formLabel(fieldOf(componentMetadata, "nextbuttontext"), "Next"), fieldOf(componentMetadata, "nextbuttoncssclass") || "btn btn-primary", true);
    }
  }
  // An editable basic or multistep form carries the platform's off-screen honeypot box. The platform names it with a
  // per-render token; the local token is derived from the form and record so renders stay repeatable.
  const trap = createHash("sha256").update(`${definition?.id ?? name}:${id ?? ""}`).digest("hex").slice(0, 8);
  // A captcha shown to this visitor (adx_captcharequired, and adx_showcaptchaforauthenticatedusers
  // for a signed-in one) registers the RadCaptcha script resources with the page's ScriptManager,
  // even when the form stops before the captcha renders (live multistep Groups step and the
  // captcha-for-everyone basic form); the control follows the honeypot box with its validator.
  const signedIn = Boolean(identity?.contactId ?? identity?.id);
  const captchaShown = truthy(fieldOf(componentMetadata, "captcharequired")) && (!signedIn || truthy(fieldOf(componentMetadata, "showcaptchaforauthenticatedusers")));
  const captchaInvalid = Boolean(postback?.validationErrors?.some((item) => item.field === "captcha"));
  const captchaHtml = captchaShown && !readOnly && !autoSteps ? captchaControl(`${ids.names}captcha`, new URL(context.request?.url ?? "http://localhost/").pathname, captchaInvalid) : "";
  if (captchaHtml) validators.push({ id: `${ids.names.replace(/\$/g, "_")}captcha_ctl00`, errormessage: CAPTCHA_ERROR, display: "None", ...(captchaInvalid ? { isvalid: "False" } : {}), evaluationfunction: "CustomValidatorEvaluateIsValid" });
  const honeypot = !readOnly && !autoSteps ? `<div class="frm-g-${trap}" style="position:absolute;left:-9999px;top:-9999px;opacity:0;height:0;overflow:hidden;" aria-hidden="true"><label for="frm_pref_${trap}">Leave this field blank</label><input name="${attr(ids.names)}frm_pref_${trap}" type="text" id="frm_pref_${trap}" tabindex="-1" autocomplete="off"></div>${captchaHtml}` : "";
  // The entity form view; a reference entity read-only view (options.referenceForm) renders the
  // live "read-only" class and an empty layout configuration, and is returned on its own.
  const viewHtml = `<div id="${attr(ids.view)}" class="${entityFormClass}${options.referenceForm ? options.referenceForm.className ?? " read-only" : ""}"${readOnly ? ' readonly="readonly"' : ""}>${hidden("EntityName", schema.entity)}${hidden("EntityID", id ? canonicalId(id) : "")}${hidden("EntityState", scalarValue(record?.statecode) ?? "")}${hidden("EntityStatus", scalarValue(record?.statuscode) ?? "")}<span id="${attr(ids.view)}_EntityLayoutConfig"${options.referenceForm ? "" : ` data-form-layout="${attr(JSON.stringify(layoutConfig))}"`}></span><div id="${attr(summaryId)}" class="${attr(fieldOf(componentMetadata, "validationsummarycssclass") || "validation-summary alert alert-error alert-danger alert-block")}" role="alert"${postback?.validationErrors ? "" : ' style="display:none;"'}${readOnly ? ' readonly="readonly"' : ""}>${postback?.validationErrors ? summaryHeader + "<ul>" + postback.validationErrors.map(item => `<li>${item.field === "captcha" ? `<a href='#captcha' onclick='javascript:scrollToAndFocusCapatch();return false;'>${escape(item.message)}</a>` : summaryLink(attr(item.field), item.message, linksEnabled)}</li>`).join("") + "</ul>" : ""}</div>${layoutHtml}${truncated ? "" : attachHtml + stepButtons + honeypot + "</div>"}`;
  if (options.referenceForm) return { html: viewHtml, controls: placed };
  // ActionButtonPlacement 0 puts a basic form's action row above the form view (live actions-above form).
  // Actions above the view leave the empty action container below it (live actions-above form).
  const EMPTY_ACTIONS = '<div class="actions"></div>';
  const actionsAbove = kind === "entityform" && !truncated && actionsHtml.startsWith('<div class="row form-custom-actions">') && Number(settingsJson(portalField(componentMetadata ?? {}, "settings") ?? "", "form settings")?.ActionButtonPlacement) === 0;
  let formHtml = `<div id="${attr(ids.panel)}" class="${panelClass}" data-form-name="${attr(kind === "webform" ? definition?.name ?? schema.formName ?? name : schema.formName ?? schema.title ?? name)}"${defaultButton ? ` onkeypress="javascript:return WebForm_FireDefaultButton(event, '${defaultButton}')"` : ""}>${actionsAbove ? actionsHtml : ""}${referenceHtml}${viewHtml}${truncated ? "" : (actionsAbove ? EMPTY_ACTIONS : actionsHtml) + "</div>"}`;
  if (truncated) formHtml = formHtml.replace(TRUNCATED_ACTIONS, () => actionsHtml);
  if (postback?.outcome?.type === 'message') {
    const message = bs.v5
      ? `<div id="MessagePanel" class="${SUCCESS_PANEL_V5}" role="alert">${messageCloseButton(ids.buttons, bs, group)}<span id="MessageLabel">${postback.outcome.message}</span></div>`
      : `<div id="MessagePanel" class="message alert alert-info success alert alert-success success alert alert-success" role="alert"><span id="MessageLabel">${postback.outcome.message}</span></div>`;
    formHtml = message + (postback.outcome.hideForm !== false ? "" : formHtml);
  }
  if (postback?.outcome?.type === 'error')
    formHtml = formErrorPanel(postback.outcome, { v5: bs.v5, closeButton: bs.v5 ? messageCloseButton(ids.buttons, bs, group) : "" }) + formHtml;
  const progressTop = progress && progress.position !== "bottom" ? progress.html : "";
  const progressBottom = progress && progress.position === "bottom" ? progress.html : "";
  // Native order: validation runtime and default hook before the control, custom
  // JavaScript first inside the control, validator expandos after the markup.
  const runtime = kind === "webform" ? "" : ENTITY_FORM_CLIENT_VALIDATE;
  if (options.onNativePostbackDescriptor) {
    const writable = fields.filter((field) => renderedFields.has(field.name) && !field.readOnly && !field.ownerHidden && !field.disabled && !["file", "image"].includes(field.control));
    const descriptor = nativeFormPostbackDescriptor({ kind, formId: definition?.id ?? name, fields: writable.map(field => ({ ...field, control: controlForSubmit(field) })), actions: renderedActions, modal, pageControl });
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
  // The auto-generated step state travels in __VIEWSTATE (lib/platform-manifest.mjs webFormsForm
  // moves the attribute into the hidden field): the tab index and the earlier tabs' posted values.
  const viewState = autoSteps ? ` data-pp-viewstate="${attr(encodeNativeViewState({ form: definition?.id ?? name, autoStep: autoSteps.index, values: Object.fromEntries(Object.entries(postback?.values ?? {}).filter(([, value]) => typeof value === "string")) }))}"` : "";
  // adx_savechangeswarningonclose: the multistep control's confirm-on-exit fields after the
  // instructions (live response body); webform.js prompts with the message on unload.
  const confirmOnExit = kind === "webform" && truthy(fieldOf(definition?.metadata ?? {}, "savechangeswarningonclose"))
    ? `<input type="hidden" name="${attr(ids.buttons)}confirmOnExit" id="confirmOnExit" value="true"><input type="hidden" name="${attr(ids.buttons)}confirmOnExitMessage" id="confirmOnExitMessage" value="${attr(formLabel(fieldOf(definition?.metadata ?? {}, "savechangeswarningmessage"), ""))}">`
    : "";
  return `${runtime}<!--pp-native-form-->${captchaShown ? CAPTCHA_MARKER : ""}<div id="${attr(ids.wrapper)}"${viewState}>${script ? `<span><script type="text/javascript">${script}</script></span>` : ""}<script type="application/json" data-paqvilo-mirage-form-config>${json(submitConfig)}</script>${kind === "webform" ? '<div class="row">' : ""}${progressTop}${instructions ? `<div class="instructions">${instructions}</div>` : ""}${confirmOnExit}${formHtml}${truncated ? "" : progressBottom}${kind === "webform" && !truncated ? "</div>" : ""}${validatorStartupScript(validators, summaryId, summaryHeader, group)}${richTextReady}${managedReady}${truncated ? RENDER_ABORT_MARKER : "</div>"}`;
}

function controlForSubmit(field) {
  switch (field.control) {
    case "lookup":
      return field.lookupStyle === "dropdown" ? "lookup" : "lookup";
    case "boolean": {
      const classId = canonicalId(field.controlClassId);
      if (field.controlStyle === 100000007) return 'checkbox';
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

// The platform posts the form's note attachment settings back with an added note as a
// server-encrypted blob (live data-attachmentsettings, different on every render). Mirage sends a
// stable, readable token of the same settings instead: base64 JSON marked as local.
const NOTE_ATTACHMENT_KEYS = ["DisplayAttachFile", "AcceptMimeTypes", "RestrictMimeTypes", "MaximumFileSize", "FileAttachmentLocation"];
function noteAttachmentToken(formId, settings) {
  return base64Json({ paqvilo: "mirage-note-attachment-settings", form: canonicalId(formId) || String(formId ?? ""), ...Object.fromEntries(NOTE_ATTACHMENT_KEYS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])) });
}

function renderNotesControl({ record, id, entity, websiteId, settings, label, language = {}, bs = BOOTSTRAP_MARKUP.BootstrapV3, rowspan }) {
  const info = `<div class="${bs.info}">${label === null ? "" : `<label for="notescontrol">${escape(label ?? "Notes")}</label>`}</div>`;
  if (!id) return `${info}<div class="control"><div id="notescontrol"></div></div>`;
  const page = (name, fallback) => formText(settings?.[name], fallback, language);
  // Notes are read-only without a Notes metadata record (live evidence: the timeline form).
  const addEnabled = settings.CreateEnabled === true;
  if (bs.v5) return `${info}<div class="control"><div id="notescontrol">${notesControlV5({ record, id, entity, websiteId, settings, page, addEnabled, bs, rowspan })}</div></div>`;
  return `${info}<div class="control"><div id="notescontrol"><div class="col-md-8 entity-notes" data-url-get="/_services/entity-notes/${websiteId}" data-url-add="/_services/entity-form-addnote/${websiteId}" data-url-edit="/_services/entity-form-updatenote/${websiteId}" data-url-delete="/_services/entity-form-deletenote/${websiteId}" data-url-get-attachments="" data-add-enabled="${addEnabled ? "True" : "False"}" data-edit-enabled="${settings.EditEnabled === true ? "True" : "False"}" data-delete-enabled="${settings.DeleteEnabled === true ? "True" : "False"}" data-use-scrolling-pagination="False" data-hide-field-label="False" data-orders='[{"Attribute":"createdon","Alias":null,"Direction":null}]' data-target="${attr(JSON.stringify({ Id: canonicalId(id), LogicalName: entity, Name: record?.name ?? null }))}" data-pagesize="${Number(settings.PageSize) || 10}"><div class="notes-empty message"><div class="alert alert-block alert-info">${escape(page("EmptyMessage", "There are no notes to display."))}</div></div><div class="notes-access-denied message"><div class="alert alert-block alert-danger">You don't have permissions to view these notes.</div></div><div class="notes-error message"><div class="alert alert-block alert-danger">An error occurred while loading notes.<span class="details"></span></div></div><div class="notes-loading message text-center"><span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...</div><div class="notes" tabindex="0"></div><div class="note-actions row"><div class="col-sm-3">${addEnabled ? `<a class="btn btn-default addnote" href="#">${escape(page("AddNoteButtonLabel", "Add a note"))}</a>` : ""}</div><div class="notes-pagination col-sm-9" data-pages="1" data-pagesize="${Number(settings.PageSize) || 10}" data-current-page="1"></div></div>${nativeModal({ bs, className: "modal-addnote", title: "Add a note", body: `<div class="addnote form-horizontal"><div class="form-group"><label id="note_label" class="col-sm-3 control-label required" for="note-text">Note</label><div class="col-sm-9"><textarea id="note-text" name="text" class="form-control" cols="20" rows="6"></textarea></div></div><div class="form-group"><label class="col-sm-3 control-label" for="note-file">Attach a file</label><div class="col-sm-9 form-control-static"><input id="note-file" name="file" type="file"></div></div></div>`, footer: `<button class="primary btn btn-primary" type="button">Add Note</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` })}${nativeModal({ bs, className: "modal-editnote", title: "Edit note", body: `<div class="editnote form-horizontal"><div class="form-group"><label class="col-sm-3 control-label required" for="note-edit-text">Note</label><div class="col-sm-9"><textarea id="note-edit-text" name="text" class="form-control" cols="20" rows="6"></textarea></div></div><div class="form-group"><label class="col-sm-3 control-label" for="note-edit-file">Attach a file</label><div class="col-sm-9 form-control-static"><input id="note-edit-file" name="file" type="file"></div></div></div>`, footer: `<button class="primary btn btn-primary" type="button">Update Note</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` })}${nativeModal({ bs, className: "modal-delete modal-deletenote", title: "Delete note", body: "Are you sure you want to delete this note?", footer: `<button class="primary btn btn-primary" type="button">Delete</button><button class="cancel btn btn-default" ${bs.dismiss}="modal" type="button">Cancel</button>` })}</div></div></div>`;
}

/**
 * Bootstrap 5 notes control (the platform's timeline-less notes list): plain status messages,
 * the list title, and add/edit/delete dialogs with the platform's fixed labels. The platform's
 * data-attachmentsettings is an encrypted value and is not reproduced.
 */
// The platform's notes list template (Handlebars), rendered into the control as a script element.
const notesTemplateV5 = ({ toolbar, privacyLabel }) => `<script id="notes-template" type="text/x-handlebars-template">{{#each Records}}<div class="note" data-attachmentfilename="{{AttachmentFileName}}" data-attachmentfilesize="{{AttachmentSizeDisplay}}" data-attachmentisimage="{{AttachmentIsImage}}" data-attachmenturl="{{AttachmentUrlWithTimeStamp}}" data-candelete="{{CanDelete}}" data-canedit="{{CanWrite}}" data-hasattachment="{{HasAttachment}}" data-id="{{Id}}" data-isprivate="{{IsPrivate}}" data-subject="{{Subject}}" data-unformattedtext="{{UnformattedText}}"><div class="row"><div class="col-md-3&#32;metadata"><div class="postedon" tabindex="0"><abbr class="timeago" data-datetime="{{CreatedOnDisplay}}" title="{{CreatedOnDisplay}}">{{CreatedOnDisplay}}</abbr></div>{{#if PostedByName}}<div class="createdby&#32;text-muted">{{PostedByName}}</div>{{/if}}{{#if IsPrivate}}<div class="label&#32;label-warning">${privacyLabel}</div>{{/if}}</div><div class="col-md-9&#32;content">${toolbar ? `{{#if DisplayToolbar}}<div class="toolbar&#32;dropdown&#32;float-end" style="z-index:&#32;1;&#32;position:&#32;relative;"><button aria-expanded="false" aria-label="action&#32;menu" class="btn&#32;btn-default&#32;btn-sm" data-bs-toggle="dropdown" href="#"><span class='fa fa-caret-down fa-fw' aria-hidden='true'></span></button><ul class="dropdown-menu" role="menu">{{#if CanWrite}}<li role="presentation"><a class="edit-link&#32;dropdown-item" href="#" role="menuitem" tabindex="-1"><span class='fa fa-edit fa-fw' aria-hidden='true'></span> Edit</a></li>{{/if}}{{#if CanDelete}}<li role="presentation"><a class="delete-link&#32;dropdown-item" href="#" role="menuitem" tabindex="-1"><span class='fa-solid fa-trash-can' aria-hidden='true'></span>Delete</a></li>{{/if}}</ul></div>{{/if}}` : ""}<div class="text" tabindex="1">{{{UnformattedText}}}</div>{{#if HasAttachment}}<div class="attachment&#32;alert&#32;alert-block&#32;clearfix">{{#if AttachmentIsImage}}<div class="img&#32;float-start"><a class="thumbnail" href="{{AttachmentUrlWithTimeStamp}}" target="_blank"><img alt="{{AttachmentFileName}}" class="img-thumbnail" src="{{AttachmentUrlWithTimeStamp}}"></img></a></div>{{/if}}<div class="link&#32;float-start"><span class='fa fa-file' aria-hidden='true'></span> <a href="{{AttachmentUrlWithTimeStamp}}" target="_blank">{{AttachmentFileName}} ({{AttachmentSizeDisplay}})</a></div></div>{{/if}}</div></div></div>{{/each}}</script>`;
// The Bootstrap 5 notes control pages as many notes as its form cell spans rows, whatever
// PageSize the metadata declares (live: 59 renders of a 6-row cell page 6 with PageSize 10; the
// platform Contact form's 23-row cell pages 23). Six when the cell carries no row span.
const NOTES_PAGE_SIZE_V5 = 6;
function notesControlV5({ id, entity, websiteId, settings, page, addEnabled, bs, rowspan }) {
  const pageSize = Number(rowspan) > 0 ? Number(rowspan) : NOTES_PAGE_SIZE_V5;
  // Configured list orders carry a direction; the default order has none.
  const orders = settings.ListOrders?.length
    ? settings.ListOrders.map((order) => ({ Attribute: order.Attribute, Alias: order.Alias ?? null, Direction: /^desc/i.test(String(order.Direction)) || Number(order.Direction) === 1 ? 1 : 0 }))
    : [{ Attribute: "createdon", Alias: null, Direction: null }];
  const regarding = { Id: canonicalId(id), LogicalName: entity, Name: null, KeyAttributes: [], RowVersion: null };
  // The dialogs carry the regarding record as indented JSON with CRLF line breaks.
  const dialogTarget = JSON.stringify({ LogicalName: entity, Id: canonicalId(id) }, null, 2);
  // A configured message renders as plain text; the platform defaults keep their alert markup.
  const message = (className, name, fallback) => `<div class="${className}" role="presentation" tabindex="0">${page(name, "") ? escape(page(name, "")) : fallback}</div>`;
  const loading = page("LoadingMessage", "") ? escape(page("LoadingMessage", "")) : '<span class="fa fa-spinner fa-spin" aria-hidden="true"></span> Loading...';
  const template = notesTemplateV5({ toolbar: settings.EditEnabled === true || settings.DeleteEnabled === true, privacyLabel: page("NotePrivacyLabel", "") ? escape(page("NotePrivacyLabel", "")) : "<span class='fa fa-eye-slash' aria-hidden='true'></span> Private" });
  const button = (label, primary = false) => `<button aria-label="${attr(label)}" class="${primary ? "primary btn btn-primary" : "cancel btn btn-default"}"${primary ? "" : ` ${bs.dismiss}="modal"`} tabindex="0" title="${attr(label)}" type="button">${escape(label)}</button>`;
  const noteRow = (labelHtml, textarea) => `<div class="row mb-3">${labelHtml}<div class="col-md-9"><textarea aria-label="Note" class="form-control" cols="20"${textarea} name="text" rows="9" tabindex="0"></textarea></div></div>`;
  const fileRow = (wrapper, accept) => `<div class="row mb-3"><label aria-label="Attach a file" class="col-form-label fw-bold col-md-3">Attach a file</label><div class="col-md-9"${wrapper}><div class="form-control-plaintext"><input${accept} aria-label="Choose File" name="file" tabindex="0" type="file"></div></div></div>`;
  const deleteTitle = "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete note";
  // Each dialog renders only when its operation is enabled (live evidence: none without metadata).
  const dialogs = [
    addEnabled ? nativeModal({
      bs,
      className: "modal-addnote",
      title: "Add note",
      body: `<div class="  addnote" data-bs-target="${crlfAttr(dialogTarget)}" data-url="/_services/entity-form-addnote/${websiteId}">${noteRow('<label class="col-form-label fw-bold col-md-3" id="note_label_add">Note</label>', ' maxlength="100000"')}${fileRow("", ' accept="*"')}</div>`,
      footer: `${button(" Add note", true)}${button("Cancel")}`,
    }) : "",
    settings.EditEnabled === true ? nativeModal({
      bs,
      className: "modal-editnote",
      title: "Edit note",
      body: `<div class="  editnote" data-bs-target="${crlfAttr(dialogTarget)}" data-url="/_services/entity-form-updatenote/${websiteId}">${noteRow('<label class="required col-form-label fw-bold col-md-3" id="note_label_edit">Note</label>', "")}${fileRow(' tabindex="0"', "")}</div>`,
      footer: `${button("Update note", true)}${button("Cancel")}`,
    }) : "",
    settings.DeleteEnabled === true ? nativeModal({ bs, className: "modal-delete modal-deletenote", title: deleteTitle, rawTitle: true, body: "<p>Are you sure you want to delete this note?</p>", footer: `${button("Delete", true)}${button("Cancel")}` }) : "",
  ].join("");
  // The accepted attachment types come with the configured add, even when this visitor may not add (live).
  return `<div class="col-lg-8 entity-notes"${settings.attachmentToken ? ' data-add-accept-types="*"' : ""} data-add-enabled="${addEnabled ? "True" : "False"}"${settings.attachmentToken ? ` data-attachmentsettings="${attr(settings.attachmentToken)}"` : ""} data-bs-target="${attr(JSON.stringify(regarding))}" data-delete-enabled="${settings.DeleteEnabled === true ? "True" : "False"}" data-edit-enabled="${settings.EditEnabled === true ? "True" : "False"}" data-hide-field-label="False" data-is-timeline="False" data-orders="${attr(JSON.stringify(orders))}" data-pagesize="${pageSize}" data-rte-enabled="False" data-url-add="/_services/entity-form-addnote/${websiteId}" data-url-delete="/_services/entity-form-deletenote/${websiteId}" data-url-edit="/_services/entity-form-updatenote/${websiteId}" data-url-get="/_services/entity-notes/${websiteId}" data-url-get-attachments="" data-url-get-attachments-count="" data-use-scrolling-pagination="False" disable-validation="false">${page("ListTitle", "") ? `<div class="col-md-12 page-header mr-0"><h3>${escape(page("ListTitle", ""))}</h3></div>` : ""}${template}${message("notes-empty message", "EmptyMessage", '<div class="alert alert-block alert-warning">There are no notes to display.</div>')}${message("notes-access-denied message", "AccessDeniedMessage", `<div class="alert alert-block alert-danger">You don't have permissions to view notes.</div>`)}${message("notes-error message", "ErrorMessage", '<div class="alert alert-block alert-danger">Error completing request. <span class="details"></span></div>')}<div class="notes-loading message text-center" role="presentation" tabindex="0">${loading}</div><div class="notes"></div><div class="notes-loading-more message text-center">${loading}</div><div class="note-actions row">${addEnabled ? `<div class="col-md-3"><a class="addnote btn btn-default" href="#" role="button">${escape(page("AddNoteButtonLabel", "Add a note"))}</a></div>` : ""}<div class="notes-pagination col-md-9" data-current-page="1" data-pages="1" data-pagesize="${pageSize}"></div></div>${dialogs}</div>`;
}

// The platform file and image controls' upload size argument (KB) as the live controls render it.
const FILE_CONTROL_MAX_KB = 1048576;
/**
 * File and image column controls: before the record exists a notice; afterwards the platform's
 * hidden file input, choose/delete buttons and the hidden state inputs the upload script fills.
 * The platform names the file input after a generated control index; the column id is used here.
 */
/**
 * MultiSelectPicklist column (MscrmControls.MultiSelectPicklist.UpdMSPicklistControl): the
 * PCF host markup and the control's own DOM as the hosted bundle leaves them on first load
 * (live evidence: empty insert, populated edit, read-only). The host id is a 32-hex token
 * (the platform's is a per-request GUID); the hosted bundle's instance counter is 1.
 * The hidden value is the platform's JSON array of the selected option metadata; label
 * MetadataIds are not exported, so they are null.
 */
/** Selected option values of a multi-select column: a record array, a comma list or the control's posted JSON array. */
function multiSelectValues(current) {
  if (Array.isArray(current)) return current.map((item) => String(scalarValue(item)));
  const text = String(scalarValue(current) ?? "").trim();
  if (text.startsWith("[")) {
    try { return JSON.parse(text).map((item) => String(item && typeof item === "object" ? item.Value : item)); } catch { return []; }
  }
  return text.split(",").map((part) => part.trim()).filter(Boolean);
}

function multiSelectControl(field, { current, options, off, formReadonly = "", nameAttr, hostKey, lcid }) {
  const id = field.id;
  const values = multiSelectValues(current);
  const label = field.label ?? field.name;
  const localized = (value) => ({ Label: value, LanguageCode: Number(lcid) || 1033, IsManaged: false, MetadataId: null, HasChanged: null });
  const optionMetadata = (option) => ({ Value: Number(option.value), Label: { LocalizedLabels: [localized(option.label)], UserLocalizedLabel: localized(option.label) }, Description: { LocalizedLabels: [], UserLocalizedLabel: null }, Color: null, IsManaged: false, ExternalValue: "", Tag: null, MetadataId: null, HasChanged: null, ParentValues: null });
  const selected = options.filter((option) => values.includes(String(option.value)));
  const controlName = "MscrmControls.MultiSelectPicklist.UpdMSPicklistControl";
  const manifest = {
    SubscribedFunctionalities: {}, DataConnectors: [], AuthConfigPropertiesGroups: [],
    Resources: [
      { Type: 3, Path: JSON.stringify({ Id: "ManifestTemplate", Data: { ConstructorName: controlName, CustomControlId: controlName, IsVirtual: false, Properties: { Resources: [], GroupDefinitions: null, DataSetDefinitions: {}, Properties: { value: { Required: true, Usage: 0, DefaultValue: "" } }, FeatureUsage: null }, Events: null, CommonEvents: null, DesignMap: null, PropertyDependencies: [] } }), ModifiedPath: "", LoadingOrder: 1, IsControlSpecific: false },
      { Type: 3, Path: JSON.stringify({ Id: "ManifestPropertyTypes", Data: { Properties: [{ Name: "value", Type: "MultiSelectOptionSet", ComplexType: "", IsPrimary: false, IsIncluded: false }, ...["X", "Y", "Width", "Height"].map((Name) => ({ Name, Type: "Number", ComplexType: "", IsPrimary: false, IsIncluded: true })), { Name: "Visible", Type: "Boolean", ComplexType: "", IsPrimary: false, IsIncluded: true }, { Name: "DisplayMode", Type: "DisplayMode", ComplexType: "", IsPrimary: false, IsIncluded: true }, { Name: "TabIndex", Type: "Number", ComplexType: "", IsPrimary: false, IsIncluded: true }, { Name: "Tooltip", Type: "String", ComplexType: "", IsPrimary: false, IsIncluded: true }] } }), ModifiedPath: "", LoadingOrder: 2, IsControlSpecific: false },
    ],
  };
  const controlContext = { UniqueId: `${id}_ControlView`, ControlId: id, GridDataControlId: null, ControlName: controlName, ControlProperties: { value_Options: options.map(optionMetadata), value_DefaultValue: null, value_DisplayName: field.columnLabel || label }, IsDisabled: off, PcfControlHiddenValueId: id, PcfDynamicProperyName: "value" };
  const host = `PcfControl_${createHash("sha256").update(`pcf\u0000${hostKey}`).digest("hex").slice(0, 32)}`;
  // The view is empty and the value carries the selected Values only in the server response; the
  // app bundle equivalent (multiselect-compat.js) builds the control's DOM, expands the value to
  // the option metadata and marks an editing host with a value dirty, as the hosted host does.
  // MakeControlsReadonly marks the container span of a read-only form.
  return `<div id="${attr(host)}"${off ? "" : ' onchange="setIsDirty(this.id);"'}><span id="${attr(id)}_Container" class="flexbox"${formReadonly}><span id="PcfControlConfig_${attr(id)}" data-pcf-control="${attr(JSON.stringify(manifest))}" pcf-controlcontext="${attr(JSON.stringify(controlContext))}"></span><div id="${attr(id)}_ControlView" class="flexbox"></div></span></div><input type="hidden" name="${nameAttr(field)}" id="${attr(id)}"${valueAttr(selected.length ? JSON.stringify(selected.map((option) => ({ Value: Number(option.value) }))) : "")}>`;
}

/** The origin of the rendered request (absolute platform links such as file downloads), else "". */
function requestOrigin(context) {
  try {
    return new URL(context?.request?.url ?? "").origin;
  } catch {
    return "";
  }
}

function fileColumnInput(field, { id, entity, record, scalar, nameAttr, readOnly = false, origin = "" }) {
  const fieldId = field.id;
  const image = field.control === "image";
  const hiddenNames = image ? ["", "_image_size", "_image_change", "_record_id"] : ["_filename", "_filetype", "_record_id", "_file_id", "_file_change", "_file_size"];
  const fileName = record?.[`${field.name}_name`] ?? "";
  const values = { _record_id: id ? canonicalId(id) : "", _filename: fileName, _file_id: !image && scalar ? canonicalId(scalar) : "" };
  const hidden = hiddenNames.map((suffix) => `<input type="hidden" name="${nameAttr(field, `hidden${suffix}`)}" id="${attr(fieldId)}hidden${suffix}"${valueAttr(values[suffix])}>`).join("");
  const validator = image ? "" : `<span id="FileValidator${attr(fieldId)}hidden_filename"${readOnly ? ' readonly="readonly"' : ""} style="display:none;"></span>`;
  // Read-only form: the choose/delete buttons are hidden, the empty text is "---", the file box is disabled.
  const none = readOnly ? "---" : "No file selected";
  const hide = readOnly ? ' style="display:none"' : "";
  if (!id) return `<div><div>${escape(image ? "This record hasn't been created yet. To enable image upload, create this record" : "This record hasn't been created yet. To enable file upload, create this record.")}</div></div>${hidden}${validator}`;
  const trash = "<span class='fa fa-trash iconforimage'></span>Delete";
  if (image)
    return `<div><input name="${nameAttr(field, "_input_file")}" type="file" accept="image/*" id="${attr(fieldId)}" aria-label="${attr(field.name)}" style="display:none" onchange="imageLoad(this, '1', '${FILE_CONTROL_MAX_KB}');"><div><button id="${attr(fieldId)}_input_image" type="button" class="btn btn-default btn-for-image-input btn-for-inputofimage" onclick="chooseImage(this, '${attr(fieldId)}');"${hide}>Choose File</button><div class="gap-between-vertical-element break-image-name">${none}</div></div></div><div><div class="image-inline" style="display:none"><a target="_blank"><img src="" height="144px" width="144px" class="image-render" alt="${attr(field.label)}"></a></div>${readOnly ? "" : `<div><button type="button" class="buttonfordeleteimage btn btn-default btnforimage" onclick="deleteImage(this, '${attr(fieldId)}');" style="display:none">${trash}</button></div>`}</div>${hidden}`;
  // The download link is absolute on the request origin (live response body).
  const download = fileName ? `${origin}/File/download.aspx?Entity=${encodeURIComponent(entity ?? "")}&Attribute=${encodeURIComponent(field.name)}&Id=${canonicalId(id)}` : "";
  return `${validator}<div class="file-control-container"><div${readOnly ? "" : ' class="container-file-input"'}><div><input type="file" name="${nameAttr(field, "_input_file")}"${readOnly ? ' disabled="disabled" class="aspNetDisabled"' : ""} id="${attr(fieldId)}_input_file" aria-label="${attr(field.label)}" onchange="fileLoad(this, '${attr(fieldId)}', '${FILE_CONTROL_MAX_KB}', '1');"${readOnly ? ' value=" " readonly="readonly"' : ""} style="display:none"><button id="${attr(fieldId)}" type="button" class="btn btn-default btn-for-file-input " onclick="chooseFile(this, '${attr(fieldId)}');" aria-labelledby="Choose File" aria-label="Choose File for ${attr(field.label)}"${hide}>${fileName ? "Change File" : "Choose File"}</button></div></div><div class="container-filelink-delete file-link-and-delete"><div class="break-file-name file-name-container">${fileName ? `<a href="${attr(download)}"><span id="${attr(fieldId)}_file_name">${escape(fileName)}</span></a><div style="display:none">${none}</div>` : `<div>${none}</div>`}</div>${fileName ? `<div><button id="${attr(fieldId)}_delete_button" type="button" class="btn btn-default btn-for-delete btn-without-border" onclick="deleteFile(this, '${attr(fieldId)}');"${hide}>${trash}</button></div>` : ""}</div></div>${hidden}`;
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
export async function renderQuickForm({ portal, schemas, store, readProvider, identity, params, metadata }) {
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
  // The platform renders the quick view as a read-only entity form view named by the control id
  // (ContentContainer_FormPanel > #<controlid>.form-readonly.entity-form.crmEntityFormView, live evidence).
  const view = String(quick.id);
  const { html } = await renderForm("entityform", view, { user: identity, identity, request: { params: {} } }, {
    portal, store, readProvider, metadata, schemas: { [view]: { entity, mode: FORM_MODE.readOnly, ...quick.schema } },
    referenceForm: {
      definition: { id: view, name: view, entityName: entity, mode: FORM_MODE.readOnly, metadata: { adx_entityname: entity, adx_mode: FORM_MODE.readOnly } },
      id: canonicalId(params.entityid),
      ids: { wrapper: view, panel: view, view, names: `ctl00$ContentContainer$${view}$`, buttons: "ctl00$ContentContainer$" },
      className: " crmEntityFormView",
    },
  });
  return `<div id="ContentContainer_FormPanel">${html}</div>`;
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
