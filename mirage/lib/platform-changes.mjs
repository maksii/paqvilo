/*
 * Source-level detection of Power Pages platform changes that the local runtime doesn't model,
 * or that change what an exported setting does.
 * Each finding is one portal diagnostic (bootstrap-report, inspect and the panel list them). A finding the
 * local runtime does not run carries `requirement: { id, status, level }`, which the source graph turns into a
 * preflight requirement row (strict preflight blocks on it):
 *
 * - ENHANCED_AUTHORIZATION: the site record's enhancedauthorization is 1 (Migration in
 *   progress), 2 (Migration Failed) or 3 (Enabled) (Learn, powerpagesite table reference).
 *   With enhanced authorization Dataverse evaluates permissions for a system user mapped to the
 *   contact, through security roles mapped to the web roles, and Dataverse column security
 *   profiles replace the Web API column permissions (security/unify-pages-security-with-
 *   dataverse). The local runtime runs that model for 3 (portal-authorization.mjs); states 1 and 2 keep the standard
 *   model, as the hosted site did (session F1). The requirement row is satisfied with a fidelity note.
 * - LIST_ODATA_FEED_REMOVED: lists with their OData feed enabled. Learn (important changes and
 *   deprecations, "List OData feed"): "The OData feeds list feature will be removed by June 2026".
 * - TABLE_PERMISSIONS_ALWAYS_ENFORCED: lists, basic forms and advanced form steps with Enable
 *   Table Permissions off. Learn (same page): "Starting June 2026, websites will have table
 *   permissions enforced for all forms and lists, regardless of the Enable Table Permissions
 *   setting." The local runtime enforces them on every form and list as well.
 * - MODERN_LIST_LOCAL_MARKUP (info, contract): entity_list includes with isModern 'true', the form in
 *   which the design studio's Modern list toggle appears in exported page copy. Modern lists are the
 *   default for new sites (Learn, add-list). The page holds the hosted pages-native-container and pages-grid and the
 *   local modern list adapter (platform.mjs renderModernList, lib/pages-client-api.js) reads the hosted configuration
 *   and data routes; it draws its own grid in the container, because the hosted page loads Microsoft's data_grid
 *   control from content.powerapps.com, which is not served locally (hosted-f2 summary-F2 LIST-01d). A map, calendar
 *   or dataset code component list included as modern renders the modern grid of its view, as hosted (summary-F2
 *   LIST-01d and LIST-01f).
 * - MODERN_LIST_FEATURES_UNSERVED (warning, requirement portal:modern-list/<list>): a served modern list whose
 *   settings configure other action types (modernListUnservedActions); those actions are absent locally.
 * - WEBAPI_WEBROLE_HOSTED_EXPOSURE (warning): Webapi/mspp_webrole/enabled is on. A hosted site answered
 *   /_api/mspp_webroles with the web roles of every site in the environment and with columns outside the
 *   Webapi/mspp_webrole/fields list (session F1, summary-F1.md AUTH-03c); the local runtime serves this export's roles and
 *   the listed columns only, so the live answer discloses more than the local one.
 * - CMS_CONTENT_EDITOR_REMOVED (info, contract): pages and web templates whose authored Liquid uses the front-side
 *   content editor's output: an {% editable %} tag or an `.editable` member check (a web link set's, say). Learn
 *   (important changes and deprecations, "Portal content editor"): deprecated from June 2022, "This feature will be
 *   removed by June 2026". Each page or template is listed once. The local runtime renders these as before (the editable
 *   wrappers and the authorized editor's branches); what the hosted runtime emits for them after the removal is not
 *   captured, so the rendered output is unchanged. Built-in templates (page_copy, snippet, ...) are not counted.
 */
import { gridItemActions } from './grid-item-actions.mjs';

const field = (record, name, fallback = null) =>
  record?.[`adx_${name}`] ?? record?.[`mspp_${name}`] ?? record?.[name] ?? fallback;
const on = (value) => value === true || value === 1 || /^(?:true|1)$/i.test(String(value ?? ''));
const off = (value) => value === false || value === 0 || /^(?:false|0)$/i.test(String(value ?? ''));
const LISTED = 20;
const listed = (items) =>
  items.length > LISTED ? [...items.slice(0, LISTED), `... ${items.length - LISTED} more`] : items;

// The list action types the local modern list serves through the classic grid engine (native-services.mjs actionLinks).
const MODERN_LIST_ACTIONS = new Set([
  'CrmEntityFormView-DetailsAction',
  'CrmEntityFormView-EditAction',
  'CrmEntityFormView-CreateAction',
  'CrmEntityFormView-DeleteAction',
  'CrmEntityFormView-DownloadAction',
  // A workflow action draws nothing on a hosted list either (hosted-f2 summary-F2 LIST-01d).
  'CrmEntityFormView-WorkflowAction',
  'WorkflowAction',
]);
/** The configured list action types the local modern list does not serve (associate, workflow, activate, ...). */
export function modernListUnservedActions(list) {
  let settings = field(list?.metadata, 'settings', null);
  if (typeof settings === 'string')
    try {
      settings = JSON.parse(settings);
    } catch {
      settings = null;
    }
  return [
    ...new Set(
      [...(settings?.ViewActions ?? []), ...gridItemActions(settings)]
        .map((action) => action?.Type)
        .filter((type) => type && !MODERN_LIST_ACTIONS.has(type)),
    ),
  ];
}

export const ENHANCED_AUTHORIZATION_STATES = Object.freeze({
  1: 'Migration in progress',
  2: 'Migration Failed',
  3: 'Enabled',
});
/** The enhancedauthorization value that runs the enhanced model; 1 and 2 keep the standard model (hosted session F1). */
export const ENHANCED_AUTHORIZATION_ENABLED = 3;
const ENHANCED_AUTHORIZATION_FIDELITY =
  'the privilege depth (16, record filter) and the record filter of each table permission scope follow the security roles a hosted site generated (session F1); the generated role names (PowerPages_<hash>) are not reproduced, and a portal read reaches the records its scope selects (portal-authorization.mjs).';
const MIGRATION_FIDELITY =
  'states 1 and 2 keep the standard model, as a hosted site did during a migration and with 2 written directly (session F1); Custom Access grants nothing until the state is 3.';
const MODERN_LIST = /\{%-?\s*include\s+['"]entity_list['"][^%]*?\bisModern\s*:\s*['"]?true\b[^%]*-?%\}/gi;
// The tag name of a Liquid markup and the editor's member check within it.
const TAG_NAME = /^\{%-?\s*(\w+)/;
const EDITABLE_MEMBER = /[\w\])]\.editable\b/gi;

/** The `{{ ... }}` outputs and `{% ... %}` tags of a source, in order (an unclosed one ends the scan). */
function* liquidMarkups(text) {
  let index = text.indexOf('{');
  while (index >= 0 && index < text.length - 1) {
    const close = { '{': '}}', '%': '%}' }[text[index + 1]];
    const end = close ? text.indexOf(close, index + 2) : index;
    if (end < 0) return;
    if (close) yield [text.slice(index, end + 2)];
    index = text.indexOf('{', close ? end + 2 : index + 1);
  }
}

/** The content editor uses of one Liquid source: { tags, checks } counts. Comment and raw blocks are never parsed. */
function contentEditorUses(text) {
  const uses = { tags: 0, checks: 0 };
  let comments = 0;
  let raw = false;
  for (const [markup] of liquidMarkups(String(text ?? ''))) {
    const tag = TAG_NAME.exec(markup)?.[1]?.toLowerCase();
    if (raw) raw = tag !== 'endraw';
    else if (tag === 'comment') comments++;
    else if (tag === 'endcomment') comments = Math.max(0, comments - 1);
    else if (!comments) {
      raw = tag === 'raw';
      if (tag === 'editable') uses.tags++;
      uses.checks += markup.match(EDITABLE_MEMBER)?.length ?? 0;
    }
  }
  return uses;
}

/** CMS_CONTENT_EDITOR_REMOVED for the pages (with their translations) and web templates that use the editor, or null. */
function contentEditorDiagnostic(pages, templates) {
  const owners = new Map();
  const add = (owner, text) => {
    const uses = contentEditorUses(text);
    if (!uses.tags && !uses.checks) return;
    const total = owners.get(owner) ?? { tags: 0, checks: 0 };
    owners.set(owner, { tags: total.tags + uses.tags, checks: total.checks + uses.checks });
  };
  for (const page of pages) {
    const owner = `page ${page.url ?? page.name}`;
    add(owner, page.html);
    for (const translation of Object.values(page.translations ?? {})) add(owner, translation?.html);
  }
  for (const template of new Set(Object.values(templates ?? {})))
    if (template && typeof template === 'object') add(`web template ${template.name}`, template.source);
  if (!owners.size) return null;
  const items = [...owners].map(([owner, { tags, checks }]) => {
    const uses = [tags && `${tags} editable tag(s)`, checks && `${checks} .editable check(s)`].filter(Boolean);
    return `${owner}: ${uses.join(', ')}`;
  });
  return {
    code: 'CMS_CONTENT_EDITOR_REMOVED',
    severity: 'info',
    level: 'contract',
    count: owners.size,
    items: listed(items),
    message: `${owners.size} page(s) and web template(s) use the front-side content editor's output ({% editable %} tags or .editable checks). The portal content editor is deprecated, with its removal documented for June 2026 (Learn, important changes and deprecations); edit content in the design studio instead. The local runtime renders these as before; what the hosted runtime emits for them after the removal is not captured.`,
  };
}

/** ENHANCED_AUTHORIZATION for a site record in a documented non-zero state, or null. */
function authorizationDiagnostic(website) {
  const authorization = Number(field(website, 'enhancedauthorization', 0));
  if (!ENHANCED_AUTHORIZATION_STATES[authorization]) return null;
  const enabled = authorization === ENHANCED_AUTHORIZATION_ENABLED;
  const fidelity = enabled ? ENHANCED_AUTHORIZATION_FIDELITY : MIGRATION_FIDELITY;
  const state = `The site record's enhanced authorization is ${authorization} (${ENHANCED_AUTHORIZATION_STATES[authorization]}).`;
  return {
    code: 'ENHANCED_AUTHORIZATION',
    value: authorization,
    state: ENHANCED_AUTHORIZATION_STATES[authorization],
    model: enabled ? 'enhanced' : 'standard',
    // The local runtime runs the model the state selects (portal-authorization.mjs), so the row is satisfied; the
    // fidelity note names what the local model does not reproduce.
    requirement: { id: 'portal:enhanced-authorization', status: 'satisfied', level: 'behaviour' },
    fidelity,
    message: enabled
      ? `${state} The local runtime runs the enhanced model: each visitor runs as its mapped Dataverse user, a table permission holds only through the privilege of the security role mapped to its web role, and Dataverse column security profiles replace the Web API column permissions. Fidelity: ${fidelity}`
      : `${state} A hosted site keeps the standard model in this state, and so does the local runtime: table permissions are evaluated as the site's application user and Custom Access grants nothing. Fidelity: ${fidelity}`,
  };
}

/** WEBAPI_WEBROLE_HOSTED_EXPOSURE when the export enables the Web API for mspp_webrole, or null. */
function webRoleExposureDiagnostic(settings) {
  const setting = Object.entries(settings ?? {}).find(([name]) => name.toLowerCase() === 'webapi/mspp_webrole/enabled');
  if (!setting || !on(setting[1])) return null;
  return {
    code: 'WEBAPI_WEBROLE_HOSTED_EXPOSURE',
    severity: 'warning',
    setting: setting[0],
    message:
      "Webapi/mspp_webrole/enabled is on. A hosted Power Pages site answers /_api/mspp_webroles with the web roles of every site in the Dataverse environment and with columns outside the Webapi/mspp_webrole/fields list (observed, hosted session F1); the local runtime returns this site's web roles with the listed columns only. Grant mspp_webrole access only where every site's role names may be disclosed.",
  };
}

/** Diagnostics for the platform changes a portal export shows (see the header comment). */
/**
 * Calls `visit(owner, include, list)` for every entity_list include with isModern 'true' in the page copies, their
 * translations and the web templates; `list` is the list the include names, or undefined.
 */
function forEachModernInclude({ lists = [], pages = [], templates = {} }, visit) {
  const keyOf = (include) => /\bkey\s*:\s*['"]([^'"]+)['"]/i.exec(include)?.[1] ?? null;
  const listOf = (key) =>
    lists.find(
      (list) =>
        list.name === key ||
        String(list.id ?? '')
          .replace(/[{}]/g, '')
          .toLowerCase() === String(key).replace(/[{}]/g, '').toLowerCase() ||
        field(list.metadata, 'key') === key,
    );
  const scan = (owner, text) => {
    for (const match of String(text ?? '').matchAll(MODERN_LIST)) visit(owner, match[0], listOf(keyOf(match[0])));
  };
  for (const page of pages) {
    scan(`page ${page.url ?? page.name}`, page.html);
    for (const translation of Object.values(page.translations ?? {}))
      scan(`page ${page.url ?? page.name}`, translation?.html);
  }
  // The template map holds each template under its id and its name.
  for (const template of new Set(Object.values(templates ?? {})))
    if (template && typeof template === 'object') scan(`web template ${template.name}`, template.source);
}

/** The ids (lower case, no braces) of the lists the sources include as modern lists. */
export function modernListIds(sources) {
  const ids = new Set();
  forEachModernInclude(sources, (_owner, _include, list) => {
    if (list) ids.add(canonical(list.id));
  });
  return ids;
}

export function platformChangeDiagnostics({
  website = {},
  lists = [],
  forms = [],
  records = [],
  pages = [],
  templates = {},
  settings = {},
} = {}) {
  const diagnostics = [];
  const authorization = authorizationDiagnostic(website);
  if (authorization) diagnostics.push(authorization);
  const webRoles = webRoleExposureDiagnostic(settings);
  if (webRoles) diagnostics.push(webRoles);
  const feeds = lists.filter((list) => on(field(list.metadata, 'odata_enabled', false)));
  if (feeds.length)
    diagnostics.push({
      code: 'LIST_ODATA_FEED_REMOVED',
      count: feeds.length,
      items: listed(feeds.map((list) => `${list.name} (/_odata/${field(list.metadata, 'odata_entitysetname', '')})`)),
      message: `${feeds.length} list(s) enable an OData feed. List OData feeds are deprecated, with their removal documented for June 2026 (Learn, important changes and deprecations), and the local runtime answers /_odata with the Page Not Found page unless observed.listODataFeeds is "served": migrate their callers to the Web API.`,
    });
  const unsecured = [
    ...lists.filter((list) => off(field(list.metadata, 'entitypermissionsenabled'))).map((list) => `list ${list.name}`),
    ...forms
      .filter((form) => off(field(form.metadata, 'entitypermissionsenabled')))
      .map((form) => `basic form ${form.name}`),
    ...records
      .filter((record) => record.kind === 'advancedformstep' && off(field(record, 'entitypermissionsenabled')))
      .map((record) => `advanced form step ${field(record, 'name', record.id)}`),
  ];
  if (unsecured.length)
    diagnostics.push({
      code: 'TABLE_PERMISSIONS_ALWAYS_ENFORCED',
      count: unsecured.length,
      items: listed(unsecured),
      message: `${unsecured.length} list(s) and form(s) turn Enable Table Permissions off. Power Pages enforces table permissions on every form and list regardless of that setting from June 2026 (Learn, important changes and deprecations), and so does the local runtime: these components need table permissions for their users.`,
    });
  const found = new Set(),
    unserved = new Map();
  forEachModernInclude({ lists, pages, templates }, (owner, include, list) => {
    found.add(`${owner}: ${include.slice(0, 120)}`);
    if (list && modernListUnservedActions(list).length) unserved.set(list.name, { list, owner });
  });
  const modern = [...found];
  if (modern.length)
    diagnostics.push({
      code: 'MODERN_LIST_LOCAL_MARKUP',
      severity: 'info',
      level: 'contract',
      count: modern.length,
      items: listed(modern),
      message: `${modern.length} list include(s) ask for the modern list (isModern 'true'). The page holds the hosted pages-native-container and pages-grid, and the local modern list adapter reads GetListViewConfiguration and the entity-grid-data pages as the hosted grid does, with infinite scroll, views, search, metadata filters, sorting, the details, edit, create, delete and download actions and the $pages list API through the classic grid engine. The hosted page draws the grid with Microsoft's data_grid control from content.powerapps.com, which is not served locally, so the grid's own markup and styling are local.`,
    });
  for (const [name, { list, owner }] of unserved)
    diagnostics.push({
      code: 'MODERN_LIST_FEATURES_UNSERVED',
      severity: 'warning',
      level: 'contract',
      requirement: { id: `portal:modern-list/${name}`, status: 'unsupported', level: 'contract' },
      list: name,
      items: modernListUnservedActions(list),
      message: `Modern list '${name}' (${owner}) configures action(s) the local modern list does not serve: ${modernListUnservedActions(list).join(', ')}. They are absent from the local list.`,
    });
  const editor = contentEditorDiagnostic(pages, templates);
  if (editor) diagnostics.push(editor);
  return diagnostics;
}

const canonical = (value) =>
  String(value && typeof value === 'object' ? (value.id ?? value.value ?? '') : (value ?? ''))
    .replace(/[{}]/g, '')
    .toLowerCase();
// Web role to account associations: the standard N:N adx_webrole_account (adx_webroleid,
// accountid) and the enhanced powerpagecomponent_mspp_webrole_account (powerpagecomponentid,
// accountid; Learn, powerpagecomponent and account table references).
const ACCOUNT_ROLE_TABLES = [
  ['adx_webrole_account', 'adx_webroleid'],
  ['powerpagecomponent_mspp_webrole_account', 'powerpagecomponentid'],
];

/**
 * Web role ids associated with an account in local data. The 2017 Adxstudio portal source
 * (MIT, CrmContactAccountRoleProvider) gave a contact the active web roles of its active parent
 * customer account; a hosted Power Pages site does not (session F1: the account-linked role was absent
 * from Liquid user.roles and its Global read granted nothing, checked 13 and 48 minutes after the
 * association and after a fresh sign-in), so the local personas don't apply these roles either and
 * lib/permissions.mjs reports them (PERSONA_ACCOUNT_ROLES_NOT_APPLIED).
 */
export function accountWebRoleIds(state, accountId) {
  const account = canonical(accountId);
  if (!account) return [];
  const ids = new Set();
  for (const [table, roleColumn] of ACCOUNT_ROLE_TABLES)
    for (const row of state?.tables?.[table] ?? [])
      if (canonical(row.accountid) === account && canonical(row[roleColumn])) ids.add(canonical(row[roleColumn]));
  return [...ids];
}
