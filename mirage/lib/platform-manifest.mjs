import { createHash } from 'node:crypto';

/*
 * Native Power Pages platform resource manifest.
 *
 * The local page shell is composed from this manifest when no live shell capture exists;
 * a captured shell profile (lib/shell-capture.mjs) remains an optional override that
 * supplies the real platform bundle paths, which the asset cache then serves.
 *
 * The manifest defines local shell contracts for platform globals, chrome, forms
 * and bundles. Captured shell profiles can override deployment-specific bundle paths.
 * Modelled on the legacy ADX sources (MIT): LiquidServerControl.ServerForm (liquid_form wrapper and
 *   jquery.blockUI ScriptReference), EntityForm/WebForm (webform.js, radcaptcha.js) and
 *   CellTemplate/EnhancedTextBox (crmentityformview.js).
 */

/** Page kinds that select platform resources. */
export const PAGE_KINDS = Object.freeze({
  anonymous:
    'Anonymous visitor: platform chrome and bundles; the anti-forgery holder stays empty until a script requests a token.',
  authenticated: 'Signed-in visitor: as anonymous; the first Web API call fills the holder from /_layout/tokenhtml.',
  list: 'Page rendering {% entitylist %}: client-side grid from the platform app bundle, no WebForms wrapper.',
  'basic-form': 'Page rendering {% entityform %}: content inside form#liquid_form with the WebForms resources.',
  'multistep-form': 'Page rendering {% webform %}: as basic-form; the control is WebFormControl_<id>.',
  'code-component': 'Page rendering {% codecomponent %}: the code control requires the Liquid WebForms server form.',
  'modal-form':
    'Modal and quick view documents (/_portal/modal-form-template-path, quickform-template-path): the layout master without header or footer (site map state of the Page Not Found page, home page title), form#content_form.',
});

/**
 * Ordered platform resources per phase. `native` is the platform resource (hashed bundle names
 * vary by platform build); `local` is what the mirage serves without a capture.
 * `kinds` lists the page kinds that load the resource.
 */
const ALL = Object.keys(PAGE_KINDS);
const FORMS = ['basic-form', 'multistep-form', 'code-component', 'modal-form'];
export const PLATFORM_RESOURCES = Object.freeze([
  {
    id: 'resource-manager',
    phase: 'head',
    kinds: ALL,
    native: '/_portal/{websiteId}/Resources/ResourceManager?lang={language}',
    local: 'the same path (the strings that local scripts read)',
    provides: ['window.ResourceManager'],
  },
  {
    id: 'bootstrap-style',
    phase: 'head',
    kinds: ALL,
    native: "the Head/Bootstrap snippet, the site's bootstrap.min.css content style or /css/bootstrap.min.css",
    local: 'the same choice (lib/liquid.mjs contentStylesheets); /css/bootstrap.min.css needs a capture',
    provides: ['Bootstrap styles'],
  },
  {
    id: 'platform-styles',
    phase: 'head',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/{font-awesome,preform,privatemode,pwa-style,pcf-style}.bundle-<hash>.css',
    local:
      'the same paths (PLATFORM_BUNDLES): preform, icons and private-mode = toolkit-authored structural fallbacks; pwa-style provides offline visibility utilities; pcf-style remains an empty placeholder',
    provides: ['#offlineNotificationBar', '.displayNone'],
  },
  {
    id: 'offline-notification-bar',
    phase: 'body-start',
    kinds: ALL,
    native: 'div#offlineNotificationBar.displayNone',
    local: 'markup',
    provides: ['#offlineNotificationBar'],
  },
  {
    id: 'antiforgery-holder',
    phase: 'after-header',
    kinds: ALL,
    native: 'div#antiforgerytoken[data-url="/_layout/tokenhtml"] (empty)',
    local: 'markup',
    provides: ['#antiforgerytoken'],
  },
  {
    id: 'client-telemetry',
    phase: 'after-header',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/client-telemetry{,-wrapper}.bundle-<hash>.js',
    local: 'the same paths, empty placeholders (telemetry is not simulated)',
    provides: ['ClientLogWrapper'],
  },
  {
    id: 'preform',
    phase: 'after-header',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/preform.moment_2_29_4.bundle-<hash>.js',
    local:
      'the same path: jQuery 3.7.1 with native class-selection guard (native uses 3.6.2), moment, datetimepicker and the jQuery UI dialog, datepicker and tabs adapters',
    provides: ['jQuery 3.6.2', 'jQuery UI 1.13.2', 'moment 2.29.4', '$.fn.datetimepicker'],
  },
  {
    id: 'pcf',
    phase: 'after-header',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/pcf{-dependency,,-extended}.bundle-<hash>.js',
    local: 'the same paths, empty placeholders; configured managed controls use lib/managed-controls.mjs',
    provides: ['PCF host'],
  },
  {
    id: 'webforms',
    phase: 'form-start',
    kinds: FORMS,
    native: '/WebResource.axd, 3 x /ScriptResource.axd',
    local: 'the same paths with local d values (LOCAL_ASPNET_SCRIPTS): webforms-compat.js, Date.prototype.format',
    provides: ['WebForm_*', 'Page_ClientValidate', 'Validator*', '__doPostBack'],
  },
  {
    id: 'blockui',
    phase: 'form-start',
    kinds: FORMS,
    native: '/js/jquery.blockUI.js',
    local: '/js/jquery.blockUI.js',
    provides: ['$.blockUI', '$.unblockUI', '$.fn.block', '$.fn.unblock'],
  },
  {
    id: 'webform-script',
    phase: 'form-start',
    kinds: FORMS,
    native: '/xrm-adx/js/webform.js',
    local: '/xrm-adx/js/webform.js',
    provides: ['setIsDirty', 'isDirty', 'clearIsDirty', 'disableButtons', 'confirmExit'],
  },
  {
    id: 'radcaptcha',
    phase: 'form-start',
    kinds: FORMS,
    native: '/xrm-adx/js/radcaptcha.js',
    local: '/xrm-adx/js/radcaptcha.js',
    provides: ['radcaptcha'],
  },
  {
    id: 'crmentityformview',
    phase: 'form-start',
    kinds: FORMS,
    native: '/xrm-adx/js/crmentityformview.js',
    local: '/xrm-adx/js/crmentityformview.js',
    provides: ['scrollToAndFocus', 'setFocus', 'LimitInput', 'validateRequiredField'],
  },
  {
    id: 'crmentityformview-datetime',
    phase: 'form-start',
    kinds: FORMS,
    native: '/xrm-adx/js/crmentityformview-datetime.js (forms with date controls)',
    local: '/xrm-adx/js/crmentityformview-datetime.js',
    provides: ['date control initialisation'],
  },
  {
    id: 'native-controls-root',
    phase: 'after-content',
    kinds: ALL,
    native: 'pcf-loader bundle, div#pp-native-controls-react-root, controls host chunk',
    local: 'markup and empty placeholders at the bundle paths',
    provides: ['#pp-native-controls-react-root'],
  },
  {
    id: 'bootstrap',
    phase: 'after-footer',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/bootstrap[.BootstrapV5].bundle-<hash>.js',
    local: 'the same path: bootstrap-plugins-compat.js',
    provides: ['Bootstrap plugins and data API'],
  },
  {
    id: 'postpreform',
    phase: 'after-footer',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/postpreform[.BootstrapV5].bundle-<hash>.js',
    local:
      'the same path: the Datejs part of date-format-compat.js, jquery-blockui-compat.js; shell.* in the client runtime',
    provides: [
      'jQuery.timeago',
      'jQuery.timeago.settings.strings',
      'Date.parse (Datejs)',
      'Date.today',
      '$.blockUI',
      'shell.getTokenDeferred',
      'shell.ajaxSafePost',
      'shell.refreshToken',
      'validateLoginSession',
    ],
  },
  {
    id: 'app',
    phase: 'after-footer',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/app[.BootstrapV5].bundle-<hash>.js',
    local: 'the same path: platform-app-compat.js, entity-grid-compat.js, footer-spacing-compat.js',
    provides: [
      'entity grid, subgrid, lookup and notes runtime',
      'heading announcer',
      'dropdown accessibility',
      'portal.*',
    ],
  },
  {
    id: 'moment-locale',
    phase: 'after-footer',
    kinds: ALL,
    native: '/resource/powerappsportal/dist/default-1033.moment_2_29_4.bundle-<hash>.js',
    local: 'the same path: moment.locale(html lang)',
    provides: ['moment locale'],
  },
]);

const escapeAttribute = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/** Offline notification markup with platform images served from the local origin. */
export const OFFLINE_NOTIFICATION_BAR = `<div id="offlineNotificationBar" class="displayNone"> <img alt="web" class="col-3" id="web" onerror="javascript: var target = event.target; var img = document.createElement('img'); img.src = '/css/images/web.png'; img.alt = 'web'; img.id = 'web' ; target.insertAdjacentElement('afterend',img); target.remove();" src="/resource/powerappsportal/img/web.png"> <div id="message">You’re offline. This is a read only version of the page.</div> <div id="close" onclick="this.parentElement.style.display='none';"><img alt="close" class="col-3" onerror="javascript: var target = event.target; var img = document.createElement('img'); img.src = '/css/images/close.png'; img.alt = 'close'; img.id = '' ; target.insertAdjacentElement('afterend',img); target.remove();" src="/resource/powerappsportal/img/close.png"></div> </div>`;

/**
 * The platform's private-site banner (first body region of a site whose visibility is private).
 * Site visibility is not in the export: observed.siteVisibility "private" selects it.
 */
export const PRIVATE_MODE_BANNER = `<div id="privateModeText" class="private-mode-banner"> <div class="private-mode-text"> <img alt="lock" class="col-3" onerror="javascript: var target = event.target; var img = document.createElement('img'); img.src = '~/img/Lock.png'; img.alt = 'lock'; img.id = '' ; target.insertAdjacentElement('afterend',img); target.remove();" src="/resource/powerappsportal/img/Lock.png"> <b>This site is private:</b><span>Only specific people can view this site.</span> <u><a href="https://go.microsoft.com/fwlink/?linkid=2204617" target="_blank">Learn more</a></u> </div> </div>`;

/** The platform renders the holder empty; scripts fill it from data-url on first use. */
export const antiForgeryHolder = (url = '/_layout/tokenhtml') =>
  `<div id="antiforgerytoken" data-url="${escapeAttribute(url)}"></div>`;
const NATIVE_CONTROLS_ROOT = `<div id="pp-native-controls-react-root"></div>`;

/**
 * The platform layout's <body data-ckeditor-basepath> value (the platform's rich-text
 * designer library path). Modal form documents use this minimal shell.
 */
export const CKEDITOR_BASEPATH = '/js/BaseHtmlContentDesigner/Libs/msdyncrm_/libs/ckeditor/';

// The native form components leave a comment before their wrapper (lib/platform.mjs); the
// platform markup carries no attribute, and the runtime drops the comment on adoption.
const NATIVE_FORM_MARKER = /<!--pp-native-form-->/;
/** The marker a failed native form control leaves (lib/platform.mjs RENDER_ABORT_MARKER). */
const RENDER_ABORT_MARKER = '<!--paqvilo-mirage-render-aborted-->';
const MULTISTEP_MARKER = /\bid="WebFormControl_[0-9a-f]{32}"/i;
const LIST_MARKER = /\bclass="[^"]*\bentity-grid\b[^"]*\bentitylist\b|\bclass="[^"]*\bentitylist\b[^"]*\bentity-grid\b/;
const CODE_COMPONENT_MARKER = /\bdata-pcf-schema="/;
// A calendar list (lib/list-views.mjs renderCalendarList): a server control that runs inside the
// WebForms form, without form controls or event validation.
// A map list without map credentials (lib/platform.mjs renderListGrid) is the same kind of server
// list control: an empty EntityListControl inside the WebForms form.
const CALENDAR_LIST_MARKER = /<div class="entitylist" data-calendar-url="|<!--pp-server-list-->/;
const VALIDATOR_MARKER =
  /Page_Validators = \(window\.Page_Validators \|\| \[\]\)\.concat\(\[document\.getElementById\(/;
// The response markup of a date control is the bound box (data-ui="datetimepicker"); the picker group is built in the browser.
// A form denied by table permissions renders no controls but keeps its date script when its
// layout has date columns (lib/platform.mjs leaves the comment).
const DATE_CONTROL_MARKER = /\bdata-ui="datetimepicker"|<!--pp-date-controls-->/;
// A permission-denied form control (lib/platform.mjs): no validators or postback controls, so
// ASP.NET registers neither WebUIValidation.js nor event validation.
const DENIED_FORM_MARKER = /<!--pp-native-form-denied-->/;
// The attach-file control posts its files with the page, so its form is multipart.
const ATTACH_FILE_MARKER = /\bid="AttachFile"/;
// Stack rank cells (adx_controlstyle 100000008) load the platform's stack ranking plug-in.
const STACK_RANK_MARKER = /\bclass="clearfix cell stack-rank-cell"/;
/** A form showing a captcha to the visitor (lib/platform.mjs CAPTCHA_MARKER). */
const CAPTCHA_MARKER = /<!--pp-captcha-->/;
// The attach-file control and file/image columns make the server form multipart.
const MULTIPART_MARKER = /\bid="AttachFile"|_input_file"/;

/** Page kind of rendered page content (the Liquid output inside the layout). */
export function pageKind(content, { authenticated = false } = {}) {
  const html = String(content ?? '');
  if (NATIVE_FORM_MARKER.test(html)) return MULTISTEP_MARKER.test(html) ? 'multistep-form' : 'basic-form';
  if (CODE_COMPONENT_MARKER.test(html)) return 'code-component';
  if (CALENDAR_LIST_MARKER.test(html)) return 'calendar-list';
  if (LIST_MARKER.test(html)) return 'list';
  return authenticated ? 'authenticated' : 'anonymous';
}

const AXD_SCRIPT = /(?:^|\/)(?:WebResource|ScriptResource)\.axd(?:[?#]|$)/i;
const scriptPath = (entry) => (typeof entry === 'string' ? entry : (entry?.src ?? ''));
export const isAspNetScript = (entry) => AXD_SCRIPT.test(scriptPath(entry));

const opaque = (...parts) => createHash('sha256').update(parts.join('\u0000')).digest('base64');
const hidden = (name, value) => `<input type="hidden" name="${name}" id="${name}" value="${escapeAttribute(value)}" />`;

/**
 * The WebForms script resources of form pages at their native paths: WebResource.axd (WebForms.js)
 * and three ScriptResource.axd resources (WebUIValidation.js, MicrosoftAjax.js and
 * MicrosoftAjaxWebForms.js). The `d` value names the
 * local equivalent that lib/native-services.mjs serves:
 * - webforms-compat.js implements the postback, WebForm_* and validation surface;
 * - MicrosoftAjax contributes Date.prototype.format (the format part of date-format-compat.js);
 * - MicrosoftAjaxWebForms (the Sys.* page request manager) has no local equivalent.
 */
const LOCAL_ASPNET_SCRIPTS = Object.freeze(
  [
    { id: 'paqvilo-webforms', path: '/WebResource.axd?d=paqvilo-webforms&t=0', local: ['webforms-compat.js'] },
    {
      id: 'paqvilo-webuivalidation',
      path: '/ScriptResource.axd?d=paqvilo-webuivalidation&t=0',
      local: ['provided:webforms-compat.js'],
    },
    {
      id: 'paqvilo-microsoftajax',
      path: '/ScriptResource.axd?d=paqvilo-microsoftajax&t=0',
      local: ['date-format-compat.js#format'],
    },
    {
      id: 'paqvilo-microsoftajaxwebforms',
      path: '/ScriptResource.axd?d=paqvilo-microsoftajaxwebforms&t=0',
      local: [],
      reason: 'The ASP.NET AJAX page request manager (Sys.WebForms) is not simulated; local postbacks reload the page.',
    },
    // Registered by a form that shows a captcha (CAPTCHA_MARKER), after the form scripts.
    {
      id: 'paqvilo-telerik-support',
      path: '/ScriptResource.axd?d=paqvilo-telerik-support&t=0',
      local: ['provided:radcaptcha-compat.js'],
      captcha: true,
      contentType: 'text/javascript',
      reason:
        'The Telerik client feature detection the RadCaptcha control registers is not simulated; the captcha hooks are radcaptcha-compat.js.',
    },
    {
      id: 'paqvilo-radcaptcha',
      path: '/ScriptResource.axd?d=paqvilo-radcaptcha&t=0',
      local: ['provided:radcaptcha-compat.js'],
      captcha: true,
      contentType: 'text/javascript',
      reason:
        'The Telerik RadCaptcha client control: radcaptcha-compat.js stands in for it (audio player, load event, partial refresh postback).',
    },
  ].map((entry) => Object.freeze({ ...entry, kind: 'script' })),
);

/** The local WebForms script resource a WebResource.axd/ScriptResource.axd URL names, or null. */
export function localAspNetScript(url) {
  const parsed = url instanceof URL ? url : new URL(String(url ?? ''), 'http://local.invalid');
  const d = parsed.searchParams.get('d');
  return (
    LOCAL_ASPNET_SCRIPTS.find(
      (entry) => entry.id === d && entry.path.split('?')[0].toLowerCase() === parsed.pathname.toLowerCase(),
    ) ?? null
  );
}

/**
 * The ASP.NET server form of a native form page (LiquidServerControl.ServerForm): hidden state fields, the postback stub, the WebForms
 * script resources and the form scripts, then the page content. `aspNetScripts` are
 * captured AXD paths when a live shell capture provides them; otherwise the local
 * WebForms equivalents load at the native AXD paths (LOCAL_ASPNET_SCRIPTS).
 */
export function webFormsForm({
  id = 'liquid_form',
  action = '/',
  content = '',
  aspNetScripts = '',
  validators = VALIDATOR_MARKER.test(String(content ?? '')),
  dateControls = DATE_CONTROL_MARKER.test(String(content ?? '')),
  formControls = NATIVE_FORM_MARKER.test(String(content ?? '')),
  variant = 'BootstrapV3',
  extraScripts = '',
  eventValidation = true,
  formScriptPaths = null,
} = {}) {
  // A form component that keeps state across postbacks (auto-generated steps) supplies it as
  // data-pp-viewstate on its wrapper; the page's __VIEWSTATE carries it, as ASP.NET would.
  // A failed native form control aborts the server form's content (lib/platform.mjs
  // RENDER_ABORT_MARKER): only the closing tags directly after the control survive, written after
  // the form's closing fields, then the form ends; the layout outside the
  // form (the footer) is unaffected.
  const aborted = String(content ?? '').indexOf(RENDER_ABORT_MARKER);
  let trailing = '';
  if (aborted >= 0) {
    trailing = /^(?:\s*<\/[a-z][a-z0-9]*>)*/i.exec(content.slice(aborted + RENDER_ABORT_MARKER.length))?.[0] ?? '';
    content = content.slice(0, aborted);
  }
  const componentState = /\sdata-pp-viewstate="([^"]*)"/.exec(String(content ?? ''));
  if (componentState) content = String(content).replace(componentState[0], '');
  const viewState = componentState
    ? componentState[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    : `/wE${opaque('viewstate', action).replace(/=+$/, '')}`;
  const script = (src) => `<script src="${escapeAttribute(src)}" type="text/javascript"></script>`;
  const denied = DENIED_FORM_MARKER.test(String(content ?? ''));
  if (denied) eventValidation = false;
  // ASP.NET writes __EVENTVALIDATION only for registered input controls: a form control that
  // renders only a message (an insert form the visitor may not use) has none.
  if (!/<(?:select|textarea)\b|<input\b(?![^>]*\btype="hidden")/i.test(String(content ?? ''))) eventValidation = false;
  // WebUIValidation.js is registered by validators and form controls only: server forms holding a
  // list control or no control at all load three AXD scripts.
  const resources =
    aspNetScripts ||
    LOCAL_ASPNET_SCRIPTS.filter(
      (entry) =>
        !entry.captcha && ((!denied && (validators || formControls)) || entry.id !== 'paqvilo-webuivalidation'),
    )
      .map((entry) => script(entry.path))
      .join('\n');
  const captchaScripts =
    formControls && CAPTCHA_MARKER.test(String(content ?? ''))
      ? LOCAL_ASPNET_SCRIPTS.filter((entry) => entry.captcha)
          .map((entry) => script(entry.path))
          .join('\n') + '\n'
      : '';
  // The ScriptManager registers jquery.blockUI.js; basic and advanced form controls add
  // their form scripts (legacy WebForms.master, EntityForm, WebForm, CellTemplate).
  // A service document (the quick view) names its own form scripts (formScriptPaths).
  const mapList = /<!--pp-map-list:(\w+)-->/.exec(String(content ?? ''));
  const mapScripts = mapList
    ? [
        '/xrm-adx/js/json2.min.js',
        ...(mapList[1] === 'bing' ? ['https://www.bing.com/api/maps/mapcontrol'] : []),
        '/xrm-adx/js/entitylist-map.js',
      ]
    : [];
  const formScripts = formScriptPaths
    ? formScriptPaths.map(script).join('\n')
    : [
        '/js/jquery.blockUI.js',
        ...mapScripts,
        ...(formControls
          ? ['/xrm-adx/js/webform.js', '/xrm-adx/js/radcaptcha.js', '/xrm-adx/js/crmentityformview.js']
          : []),
        ...(formControls && STACK_RANK_MARKER.test(String(content ?? ''))
          ? ['/xrm-adx/js/jquery.stackranking.js']
          : []),
        ...(formControls && dateControls
          ? [`/xrm-adx/js/${variant === 'BootstrapV5' ? 'BootstrapV5/' : ''}crmentityformview-datetime.js`]
          : []),
        ...(formControls && ATTACH_FILE_MARKER.test(String(content ?? '')) ? ['/xrm-adx/js/fileuploadcontrol.js'] : []),
      ]
        .map(script)
        .join('\n');
  const onSubmit = validators
    ? `<script type="text/javascript">\n//<![CDATA[\nfunction WebForm_OnSubmit() {\nif (typeof(ValidatorOnSubmit) == "function" && ValidatorOnSubmit() == false) return false;\nreturn true;\n}\n//]]>\n</script>\n`
    : '';
  return (
    `<form method="post" action="${escapeAttribute(action)}"${validators ? ` onsubmit="javascript:return WebForm_OnSubmit();"` : ''} id="${escapeAttribute(id)}"${MULTIPART_MARKER.test(String(content ?? '')) ? ' enctype="multipart/form-data"' : ''}>\n` +
    `<div class="aspNetHidden">\n${hidden('__EVENTTARGET', '')}\n${hidden('__EVENTARGUMENT', '')}\n${hidden('__VIEWSTATE', viewState)}\n</div>\n\n` +
    `<script type="text/javascript">\n//<![CDATA[\nvar theForm = document.forms['${id}'];\nif (!theForm) {\n    theForm = document.${id};\n}\nfunction __doPostBack(eventTarget, eventArgument) {\n    if (!theForm.onsubmit || (theForm.onsubmit() != false)) {\n        theForm.__EVENTTARGET.value = eventTarget;\n        theForm.__EVENTARGUMENT.value = eventArgument;\n        theForm.submit();\n    }\n}\n//]]>\n</script>\n\n` +
    `${resources}\n${formScripts}\n${captchaScripts}${extraScripts ? extraScripts + '\n' : ''}${onSubmit}${content}` +
    // ASP.NET renders the generator and event validation fields at the end of the server form.
    `<div class="aspNetHidden">\n\n${hidden('__VIEWSTATEGENERATOR', createHash('sha256').update(`generator\u0000${id}`).digest('hex').slice(0, 8).toUpperCase())}\n${hidden('__VIEWSTATEENCRYPTED', '')}\n${eventValidation ? hidden('__EVENTVALIDATION', `/wE${opaque('validation', action).replace(/=+$/, '')}`) + '\n' : ''}</div>${trailing}</form>`
  );
}

/**
 * Native body regions for a Liquid layout page. Form pages wrap the content in the
 * WebForms form and carry the AXD scripts; other pages load no AXD script.
 */
export function nativePageRegions({
  content = '',
  action = '/',
  bodyScripts = [],
  renderScripts = (paths) => paths.map((src) => `<script src="${escapeAttribute(src)}"></script>`).join('\n'),
  authenticated = false,
  serverFormId = null,
  variant = 'BootstrapV3',
  formScripts = '',
} = {}) {
  const kind = pageKind(content, { authenticated });
  const scripts = Array.isArray(bodyScripts) ? bodyScripts : [];
  const aspNet = scripts.filter(isAspNetScript);
  const other = scripts.filter((entry) => !isAspNetScript(entry));
  // Liquid pages get the server form only for their form controls and calendar lists; legacy
  // ASPX page templates (rewrite URLs) always run inside the WebForms master's content_form.
  const calendar = kind === 'calendar-list';
  // A legacy ASPX page template's content_form (serverFormId) writes no __EVENTVALIDATION.
  const form =
    Boolean(serverFormId) ||
    kind === 'basic-form' ||
    kind === 'multistep-form' ||
    kind === 'code-component' ||
    calendar;
  return {
    kind,
    content: form
      ? webFormsForm({
          id: serverFormId ?? 'liquid_form',
          action,
          content,
          aspNetScripts: aspNet.length ? renderScripts(aspNet) : '',
          variant,
          extraScripts: formScripts,
          eventValidation: !serverFormId,
        })
      : content,
    bodyScripts: other.length ? renderScripts(other) : '',
  };
}

const GUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_VALIDATION_HOOKS =
  '<script type="text/javascript">\n\tfunction entityFormClientValidate() {\n\t\t// Custom client side validation. Method is called by the submit button\'s onclick event.\n\t\t// Must return true or false. Returning false will prevent the form from submitting.\n\t\treturn true;\n\t}\n\n\tfunction webFormClientValidate() {\n\t\t// Custom client side validation. Method is called by the next/submit button\'s onclick event.\n\t\t// Must return true or false. Returning false will prevent the form from submitting.\n\t\treturn true;\n\t}\n</script>';
const snippetDiv = (name) =>
  `{% if snippets[${JSON.stringify(name)}] %}<div>{{ snippets[${JSON.stringify(name)}] }}</div>{% endif %}`;

/**
 * Legacy ASPX page templates (adx_rewriteurl) render inside the WebForms master pages
 * (legacy MasterPortal WebForms.master / WebFormsContent.master, MIT): content_form, the
 * page heading (breadcrumbs, page header, notifications), the page copy and the page's
 * attached advanced form, basic form and list ("EntityControls", static client ids
 * WebFormControl, EntityFormControl, EntityListControl, preceded by the default
 * entityFormClientValidate / webFormClientValidate hooks). Page.aspx and Listing.aspx add
 * the WebFormsContent two-column layout with the sidebar; FullPage.aspx adds its page
 * metadata and child navigation; WebForm.aspx uses the master as is. Blank.aspx renders the
 * page copy without the server form. Returns null for templates without a rewrite URL or
 * with another legacy page (the caller keeps its own rendering).
 */
export function rewritePageLayout(page, pageTemplate) {
  const rewrite = String(pageTemplate?.rewriteUrl ?? '')
    .trim()
    .replace(/^~?\//, '')
    .toLowerCase();
  if (!rewrite) return null;
  if (rewrite === 'pages/blank.aspx') return { source: "{% include 'Page Copy' %}", serverFormId: null };
  const layout = {
    'pages/page.aspx': 'page',
    'pages/listing.aspx': 'listing',
    'pages/fullpage.aspx': 'fullpage',
    'pages/webform.aspx': 'webform',
    'pages/webformnovalidation.aspx': 'webform',
  }[rewrite];
  if (!layout) return null;
  const guid = (value) => (GUID_TEXT.test(String(value ?? '')) ? String(value).toLowerCase() : null);
  const advancedForm = guid(page?.advancedFormId);
  const basicForm = guid(page?.formId);
  const list = guid(page?.listId);
  const entityControls =
    DEFAULT_VALIDATION_HOOKS +
    (advancedForm ? `{% webform id: '${advancedForm}', pp_page_control: true %}` : '') +
    (basicForm ? `{% entityform id: '${basicForm}', pp_page_control: true %}` : '') +
    (list ? `{% entitylist id: '${list}', pp_page_control: true %}{% endentitylist %}` : '');
  const heading = `<div class="page-heading"><div class="container">{% include 'Breadcrumbs' %}<div class="page-header"><h1>{{ page.title | h }}</h1></div><div class="notifications"></div></div></div>`;
  const pageMetadata = `<div class="page-metadata clearfix">${snippetDiv('Social Share Widget Code Page Bottom')}</div>`;
  const placements =
    "{% assign poll_placement_name = 'Sidebar' %}{% mirage_poll_placement %}{% assign ad_placement_name = 'Sidebar Bottom' %}{% mirage_ad_placement %}";
  let main;
  if (layout === 'page' || layout === 'listing') {
    const contentBottom = layout === 'page' ? pageMetadata : "{% include 'Child Link List Group' %}";
    const sidebarTop = "{% include 'Child Link List Group' %}";
    main =
      `<div class="row"><div class="col-md-8">${snippetDiv('Social Share Widget Code Page Top')}{% include 'Page Copy' %}${entityControls}${contentBottom}</div>` +
      `<div class="col-md-4"><div class="sidebar">${sidebarTop}{% include 'Weblink List Group' weblink_set_name: 'Secondary Navigation' %}${placements}</div></div></div>`;
  } else if (layout === 'fullpage') {
    // FullPage.aspx: div#mainContent holds the page copy (one editable element with the
    // page-copy class) and the three entity control holders, empty when the page binds none;
    // the page metadata and child links follow it.
    const holders =
      DEFAULT_VALIDATION_HOOKS +
      (advancedForm
        ? `{% webform id: '${advancedForm}', pp_page_control: true %}`
        : '<div id="WebFormControl"></div>') +
      (basicForm
        ? `{% entityform id: '${basicForm}', pp_page_control: true %}`
        : '<div id="EntityFormControl"></div>') +
      (list ? `{% entitylist id: '${list}', pp_page_control: true %}{% endentitylist %}` : '');
    main = `<div id="mainContent">{% editable page 'adx_copy' type: 'html', liquid: true, class: 'page-copy' %}${holders}</div>${pageMetadata}{% include 'Child Link List Group' %}`;
    return {
      source: `${heading}<div class="container">${main}</div>`,
      serverFormId: 'content_form',
      contentRegion: true,
    };
  } else {
    main = `{% include 'Page Copy' %}${entityControls}`;
  }
  return { source: `${heading}<div class="container">${main}</div>`, serverFormId: 'content_form' };
}

// Platform bundle ordering used by the local shell, including modal form documents.
// The ResourceManager script and bundles retain their native URL structure.
// Sites whose Site/BootstrapV5Enabled setting is true load the BootstrapV5 builds of
// font-awesome, preform (css and moment), bootstrap, postpreform and app.
//
// The default hashes identify one platform build; they are not a deployed site baseline.
// A captured shell profile supplies the actual deployment-specific names.
//
// Locally each bundle is linked at the same path on the local origin. The asset cache serves
// captured bytes; otherwise lib/native-services.mjs serves the local equivalent named by
// `local`. An empty `local` means the bundle has no local equivalent: an empty file is
// served and a diagnostic is recorded. Bundles marked `capture: false` always use the local
// equivalent, even when the cache holds captured bytes (the shell capture's policy). Telemetry,
// the component framework and the controls host would reach hosted services that the local
// runtime does not simulate. The app bundle's local equivalent carries the grid runtime that
// lib/native-services.mjs is tested against.

/** The Bootstrap build of the platform bundles: Site/BootstrapV5Enabled = true selects BootstrapV5. */
export function bootstrapVariant(settings = {}) {
  const entry = Object.entries(settings ?? {}).find(
    ([name]) => String(name).toLowerCase() === 'site/bootstrapv5enabled',
  );
  const value = entry?.[1];
  return String(value && typeof value === 'object' ? (value.value ?? '') : (value ?? ''))
    .trim()
    .toLowerCase() === 'true'
    ? 'BootstrapV5'
    : 'BootstrapV3';
}

const PLATFORM_BUNDLE_ROOT = '/resource/powerappsportal/';
/** The platform's default Bootstrap stylesheet, linked when the site has no Head/Bootstrap snippet or bootstrap.min.css content style. */
export const PLATFORM_BOOTSTRAP_STYLESHEET = '<link rel="stylesheet" href="/css/bootstrap.min.css">';
const both = (name) => ({ BootstrapV3: name, BootstrapV5: name });
const PCF_REASON =
  "The hosted PCF bundle is not included locally. Mirage's standard-control adapter uses exported manifests and declared resources; React and platform-library dependencies require live verification.";
const TELEMETRY_REASON = 'Platform telemetry is hosted infrastructure that is not simulated.';
/**
 * The platform bundles. Fields:
 * - `slot`: where the bundle sits in the page.
 * - `names`: the bundle path under /resource/powerappsportal/, per Bootstrap build.
 * - `family`: matches any build of the bundle, so captured names can be recognised.
 * - `local`: the sources that make up the local equivalent; empty means none.
 * - `reason`: why there is no local equivalent.
 */
export const PLATFORM_BUNDLES = Object.freeze(
  [
    {
      id: 'font-awesome',
      kind: 'stylesheet',
      slot: 'head-start',
      names: {
        BootstrapV3: 'dist/font-awesome.bundle-3d8a58a48f.css',
        BootstrapV5: 'dist/font-awesome.BootstrapV5.bundle-2ce6efb497.css',
      },
      family: /^dist\/font-awesome(?:\.BootstrapV5)?\.bundle-[0-9a-f]+\.css$/i,
      local: ['platform-icons.css'],
      partial: true,
      reason:
        'Toolkit-authored structural symbols are used without a shell capture; captured platform fonts replace them.',
    },
    {
      id: 'preform-style',
      kind: 'stylesheet',
      slot: 'head-start',
      names: {
        BootstrapV3: 'dist/preform.bundle-b72a6ea21d.css',
        BootstrapV5: 'dist/preform.BootstrapV5.bundle-e3e84e09a3.css',
      },
      family: /^dist\/preform(?:\.BootstrapV5)?\.bundle-[0-9a-f]+\.css$/i,
      local: ['platform-chrome.css'],
    },
    {
      id: 'privatemode',
      kind: 'stylesheet',
      slot: 'head-start',
      names: both('dist/privatemode.bundle-049b12b66e.css'),
      family: /^dist\/privatemode\.bundle-[0-9a-f]+\.css$/i,
      local: ['platform-private-mode.css'],
      partial: true,
      reason: 'Toolkit-authored private-banner layout is used without a shell capture.',
    },
    {
      id: 'pwa-style',
      kind: 'stylesheet',
      slot: 'head-end',
      names: both('dist/pwa-style.bundle-55718a4c0d.css'),
      family: /^dist\/pwa-style\.bundle-[0-9a-f]+\.css$/i,
      local: ['platform-chrome-utilities.css'],
      partial: true,
      reason:
        'Offline-notification visibility is preserved locally; full progressive web app behavior requires captured platform assets and is unqualified.',
    },
    {
      id: 'pcf-style',
      kind: 'stylesheet',
      slot: 'body-open',
      names: both('dist/pcf-style.bundle-373a0f4982.css'),
      family: /^dist\/pcf-style\.bundle-[0-9a-f]+\.css$/i,
      local: [],
      reason: PCF_REASON,
    },
    {
      id: 'client-telemetry',
      kind: 'script',
      capture: false,
      slot: 'body-start',
      names: both('dist/client-telemetry.bundle-d490766e4f.js'),
      family: /^dist\/client-telemetry\.bundle-[0-9a-f]+\.js$/i,
      local: [],
      reason: TELEMETRY_REASON,
    },
    {
      id: 'client-telemetry-wrapper',
      kind: 'script',
      capture: false,
      slot: 'body-start',
      names: both('dist/client-telemetry-wrapper.bundle-633e70f51b.js'),
      family: /^dist\/client-telemetry-wrapper\.bundle-[0-9a-f]+\.js$/i,
      local: [],
      reason: TELEMETRY_REASON,
    },
    {
      id: 'preform',
      kind: 'script',
      slot: 'body-start',
      names: {
        BootstrapV3: 'dist/preform.moment_2_29_4.bundle-750b699ecd.js',
        BootstrapV5: 'dist/preform.BootstrapV5.moment_2_29_4.bundle-e6db58f462.js',
      },
      family: /^dist\/preform(?:\.BootstrapV5)?\.moment_[\d_]+\.bundle-[0-9a-f]+\.js$/i,
      local: [
        'jquery',
        'jquery-class-selection-compat.js',
        'moment',
        'datetimepicker-compat.js',
        'jqueryui-dialog-compat.js',
        'jqueryui-widgets-compat.js',
      ],
    },
    {
      id: 'pcf-dependency',
      kind: 'script',
      capture: false,
      slot: 'body-start',
      names: both('dist/pcf-dependency.bundle-805a1661b7.js'),
      family: /^dist\/pcf-dependency\.bundle-[0-9a-f]+\.js$/i,
      local: [],
      reason: PCF_REASON,
    },
    {
      id: 'pcf',
      kind: 'script',
      capture: false,
      slot: 'body-start',
      names: both('dist/pcf.bundle-60440c37cb.js'),
      family: /^dist\/pcf\.bundle-[0-9a-f]+\.js$/i,
      local: [],
      reason: PCF_REASON,
    },
    {
      id: 'pcf-extended',
      kind: 'script',
      capture: false,
      slot: 'body-start',
      names: both('dist/pcf-extended.bundle-b0e01b5622.js'),
      family: /^dist\/pcf-extended\.bundle-[0-9a-f]+\.js$/i,
      local: [],
      reason: PCF_REASON,
    },
    {
      id: 'pcf-loader',
      kind: 'script',
      capture: false,
      slot: 'after-content',
      names: both('dist/pcf-loader.bundle-f4a0e619b8.js'),
      family: /^dist\/pcf-loader\.bundle-[0-9a-f]+\.js$/i,
      local: [],
      reason: PCF_REASON,
    },
    {
      id: 'controls-host',
      kind: 'script',
      capture: false,
      slot: 'after-controls-root',
      defer: true,
      names: both('controls/host/main.3ee2491f78.chunk.js'),
      family: /^controls\/host\/main\.[0-9a-f]+\.chunk\.js$/i,
      local: [],
      reason: 'The native controls host is not simulated.',
    },
    {
      id: 'bootstrap',
      kind: 'script',
      slot: 'after-footer',
      names: {
        BootstrapV3: 'dist/bootstrap.bundle-105a4995b8.js',
        BootstrapV5: 'dist/bootstrap.BootstrapV5.bundle-be8391e97d.js',
      },
      family: /^dist\/bootstrap(?:\.BootstrapV5)?\.bundle-[0-9a-f]+\.js$/i,
      local: ['bootstrap-plugins-compat.js'],
    },
    {
      id: 'postpreform',
      kind: 'script',
      slot: 'after-footer',
      names: {
        BootstrapV3: 'dist/postpreform.bundle-4687dda8df.js',
        BootstrapV5: 'dist/postpreform.BootstrapV5.bundle-1e48131190.js',
      },
      family: /^dist\/postpreform(?:\.BootstrapV5)?\.bundle-[0-9a-f]+\.js$/i,
      local: ['date-format-compat.js#datejs', 'jquery-blockui-compat.js', 'jquery-timeago-compat.js'],
    },
    {
      id: 'app',
      kind: 'script',
      capture: false,
      slot: 'after-footer',
      names: { BootstrapV3: 'dist/app.bundle-1e948af604.js', BootstrapV5: 'dist/app.BootstrapV5.bundle-4299f393fc.js' },
      family: /^dist\/app(?:\.BootstrapV5)?\.bundle-[0-9a-f]+\.js$/i,
      local: ['platform-app-compat.js', 'entity-grid-compat.js', 'footer-spacing-compat.js', 'multiselect-compat.js'],
    },
    {
      id: 'moment-locale',
      kind: 'script',
      slot: 'after-footer',
      names: both('dist/default-1033.moment_2_29_4.bundle-eda4e638fd.js'),
      family: /^dist\/default-\d+\.moment_[\d_]+\.bundle-[0-9a-f]+\.js$/i,
      local: ['moment-locale'],
    },
    // The MultiSelectPicklist control stylesheet ends the head of a page whose form has a multi-select column.
    {
      id: 'msos-style',
      kind: 'stylesheet',
      slot: 'controls-style',
      names: both('1.4.772-master/controlsAssets/msos.4774A53.css'),
      family: /^[^/]+\/controlsAssets\/msos\.[0-9a-f]+\.css$/i,
      local: ['platform-msos.css'],
    },
  ].map((bundle) => Object.freeze(bundle)),
);

/** The bundle a /resource/powerappsportal/ path names (any build), or null. */
export function platformBundleFor(pathname) {
  const path = String(pathname ?? '').split(/[?#]/)[0];
  // The platform's onerror fallback loads a CDN bundle from the portal origin at /dist/<name>.
  const rest = path.toLowerCase().startsWith(PLATFORM_BUNDLE_ROOT)
    ? path.slice(PLATFORM_BUNDLE_ROOT.length)
    : /^\/dist\//i.test(path)
      ? path.slice(1)
      : null;
  if (rest === null) return null;
  return PLATFORM_BUNDLES.find((bundle) => bundle.family.test(rest)) ?? null;
}

const entryPath = (entry) => (typeof entry === 'string' ? entry : (entry?.src ?? entry?.href ?? ''));
const RESOURCE_MANAGER_PATH = /^\/_portal\/[^/]+\/Resources\/ResourceManager(?:[/?#]|$)/i;

/**
 * The platform shell of a layout or modal page: tag fragments per slot. Fields:
 * - `profile`: a captured shell profile. Its hashed bundle names replace the defaults,
 *   and `remaining` returns its other resources, list by list.
 * - `bootstrap`: the Bootstrap stylesheet markup (lib/liquid.mjs contentStylesheets).
 *   With a capture, the captured stylesheets that precede the first platform stylesheet
 *   are used instead.
 * - `controlsRoot`: false for modal form documents, which load the controls host scripts
 *   without the layout's native-controls root.
 */
export function platformShell({
  variant = 'BootstrapV3',
  profile = null,
  websiteId = '',
  languageCode = 'en-US',
  bootstrap = '',
  renderStyles = null,
  controlsRoot = true,
} = {}) {
  const lists = ['stylesheets', 'headScripts', 'beforeContentScripts', 'bodyScripts', 'afterFooterScripts'];
  const captured = new Map();
  const remaining = {};
  for (const list of lists) {
    remaining[list] = [];
    for (const entry of Array.isArray(profile?.[list]) ? profile[list] : []) {
      const path = entryPath(entry);
      const bundle = platformBundleFor(path);
      if (bundle) {
        if (!captured.has(bundle.id)) captured.set(bundle.id, path.split(/[?#]/)[0]);
      } else if (!RESOURCE_MANAGER_PATH.test(path)) remaining[list].push(entry);
    }
  }
  // With a capture, the stylesheets observed before the first platform stylesheet are the
  // Bootstrap slot; the rest are the site's content styles.
  let bootstrapMarkup = bootstrap ?? '';
  if (Array.isArray(profile?.stylesheets)) {
    const firstPlatform = profile.stylesheets.findIndex((entry) => platformBundleFor(entryPath(entry)));
    const lead = firstPlatform < 0 ? [] : profile.stylesheets.slice(0, firstPlatform);
    if (lead.length) {
      bootstrapMarkup = renderStyles
        ? renderStyles(lead)
        : lead.map((entry) => `<link rel="stylesheet" href="${escapeAttribute(entryPath(entry))}">`).join('');
      remaining.stylesheets = remaining.stylesheets.filter((entry) => !lead.includes(entry));
    }
  }
  const pathOf = (bundle) =>
    captured.get(bundle.id) ?? `${PLATFORM_BUNDLE_ROOT}${bundle.names[variant] ?? bundle.names.BootstrapV3}`;
  const tag = (bundle) => {
    const path = pathOf(bundle);
    if (bundle.kind === 'stylesheet')
      return `<link href="${escapeAttribute(path)}"${fallback(path, 'link')} rel="stylesheet">`;
    return bundle.defer
      ? `<script defer="defer" src="${escapeAttribute(path)}"></script>`
      : `<script${fallback(path, 'script')} src="${escapeAttribute(path)}" type="text/javascript"></script>`;
  };
  const slot = (name) =>
    PLATFORM_BUNDLES.filter((bundle) => bundle.slot === name)
      .map(tag)
      .join('');
  const site = String(websiteId ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  const resourceManager = site
    ? `<script src="/_portal/${escapeAttribute(site)}/Resources/ResourceManager?lang=${encodeURIComponent(languageCode)}"></script>`
    : '';
  return {
    variant,
    bundles: PLATFORM_BUNDLES.map((bundle) => ({
      id: bundle.id,
      kind: bundle.kind,
      slot: bundle.slot,
      path: pathOf(bundle),
      captured: captured.has(bundle.id),
    })),
    headStart: `${resourceManager}${bootstrapMarkup}${slot('head-start')}`,
    headEnd: slot('head-end'),
    controlsStyle: slot('controls-style'),
    bodyOpen: slot('body-open'),
    bodyStart: slot('body-start'),
    afterContent: `${slot('after-content')}${controlsRoot ? NATIVE_CONTROLS_ROOT : ''}${slot('after-controls-root')}`,
    afterFooter: slot('after-footer'),
    remaining,
  };
}

/**
 * The platform's onerror fallback of a CDN bundle under dist/: on a load error the same bundle
 * is inserted from the portal origin at /dist/<name> (served by lib/native-services.mjs).
 */
function fallback(path, element) {
  const match = /\/resource\/powerappsportal\/(dist\/[^?#'"]+)/i.exec(path);
  if (!match) return '';
  const [attribute, extra] =
    element === 'link' ? ['href', "link.rel = 'stylesheet';"] : ['src', "script.type = 'text/javascript';"];
  return ` onerror="${escapeAttribute(`javascript: var target = event.target; var ${element} = document.createElement('${element}'); ${element}.crossOrigin = target.crossOrigin; ${element}.${attribute} = '/${match[1]}'; ${extra} target.insertAdjacentElement('afterend',${element});`)}"`;
}

/** True when a document carries the platform bundles (the platform jQuery/moment provider). */
export const hasPlatformBundles = (html) =>
  /<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/resource\/powerappsportal\/dist\/preform(?:\.BootstrapV5)?\.moment_[\d_]+\.bundle-[0-9a-f]+\.js/i.test(
    String(html ?? ''),
  );
