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
 *   dataverse). The local runtime runs that model (portal-authorization.mjs); the requirement row is satisfied with a
 *   fidelity note.
 * - LIST_ODATA_FEED_REMOVED: lists with their OData feed enabled. Learn (important changes and
 *   deprecations, "List OData feed"): "The OData feeds list feature will be removed by June 2026".
 * - TABLE_PERMISSIONS_ALWAYS_ENFORCED: lists, basic forms and advanced form steps with Enable
 *   Table Permissions off. Learn (same page): "Starting June 2026, websites will have table
 *   permissions enforced for all forms and lists, regardless of the Enable Table Permissions
 *   setting." The local runtime enforces them on every form and list as well.
 * - MODERN_LIST_LOCAL_MARKUP (info, contract): entity_list includes with isModern 'true', the form in
 *   which the design studio's Modern list toggle appears in exported page copy. Modern lists are the
 *   default for new sites (Learn, add-list). The local modern list adapter (platform.mjs
 *   renderModernList, lib/pages-client-api.js) serves their data, infinite scroll, views, search, metadata
 *   filters, sorting, the details/edit/create/delete/download actions and the $pages list API through the classic
 *   grid engine; its markup is local because the platform's modern list markup is not documented.
 * - MODERN_LIST_RENDERED_CLASSIC (warning): a modern include whose list the adapter cannot serve (map,
 *   calendar or dataset code component lists, modernListFallback): the local runtime renders the classic list for it.
 * - MODERN_LIST_FEATURES_UNSERVED (warning, requirement portal:modern-list/<list>): a served modern list whose
 *   settings configure other action types (modernListUnservedActions); those actions are absent locally.
 */
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
]);
/** Why a modern include of `list` renders the classic list instead (one rule for preflight and the renderer), or null. */
export function modernListFallback(list) {
  const metadata = list?.metadata;
  return on(field(metadata, 'map_enabled', false))
    ? 'map lists'
    : on(field(metadata, 'calendar_enabled', false))
      ? 'calendar lists'
      : on(field(metadata, 'iscodecomponent', false))
        ? 'dataset code component lists'
        : null;
}
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
      [...(settings?.ViewActions ?? []), ...(settings?.ItemActions ?? [])]
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
export const ENHANCED_AUTHORIZATION_FIDELITY =
  'the privilege depth each table permission scope maps to and the model states 1 and 2 serve are not documented; the records a grant reaches are those its scope selects (portal-authorization.mjs).';
const MODERN_LIST = /\{%-?\s*include\s+['"]entity_list['"][^%]*?\bisModern\s*:\s*['"]?true\b[^%]*-?%\}/gi;

/** Diagnostics for the platform changes a portal export shows (see the header comment). */
export function platformChangeDiagnostics({
  website = {},
  lists = [],
  forms = [],
  records = [],
  pages = [],
  templates = {},
} = {}) {
  const diagnostics = [];
  const authorization = Number(field(website, 'enhancedauthorization', 0));
  if (ENHANCED_AUTHORIZATION_STATES[authorization])
    diagnostics.push({
      code: 'ENHANCED_AUTHORIZATION',
      value: authorization,
      state: ENHANCED_AUTHORIZATION_STATES[authorization],
      // The local runtime runs the enhanced model (portal-authorization.mjs), so the row is satisfied; the fidelity note names
      // the undocumented web role to privilege depth mapping.
      requirement: { id: 'portal:enhanced-authorization', status: 'satisfied', level: 'behaviour' },
      fidelity: ENHANCED_AUTHORIZATION_FIDELITY,
      message: `The site record's enhanced authorization is ${authorization} (${ENHANCED_AUTHORIZATION_STATES[authorization]}). The local runtime runs the enhanced model: each visitor runs as its mapped Dataverse user, a table permission holds only through the privilege of the security role mapped to its web role, and Dataverse column security profiles replace the Web API column permissions. Fidelity: ${ENHANCED_AUTHORIZATION_FIDELITY}`,
    });
  const feeds = lists.filter((list) => on(field(list.metadata, 'odata_enabled', false)));
  if (feeds.length)
    diagnostics.push({
      code: 'LIST_ODATA_FEED_REMOVED',
      count: feeds.length,
      items: listed(feeds.map((list) => `${list.name} (/_odata/${field(list.metadata, 'odata_entitysetname', '')})`)),
      message: `${feeds.length} list(s) enable an OData feed. Power Pages removed list OData feeds by June 2026 (Learn, important changes and deprecations); migrate their callers to the Web API.`,
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
      message: `${unsecured.length} list(s) and form(s) turn Enable Table Permissions off. Since June 2026 Power Pages enforces table permissions on every form and list regardless of that setting (Learn, important changes and deprecations), and so does the local runtime: these components need table permissions for their users.`,
    });
  const found = new Set(),
    classic = new Set(),
    unserved = new Map();
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
    for (const match of String(text ?? '').matchAll(MODERN_LIST)) {
      const list = listOf(keyOf(match[0]));
      (list && modernListFallback(list) ? classic : found).add(`${owner}: ${match[0].slice(0, 120)}`);
      if (list && !modernListFallback(list) && modernListUnservedActions(list).length)
        unserved.set(list.name, { list, owner });
    }
  };
  for (const page of pages) {
    scan(`page ${page.url ?? page.name}`, page.html);
    for (const translation of Object.values(page.translations ?? {}))
      scan(`page ${page.url ?? page.name}`, translation?.html);
  }
  // The template map holds each template under its id and its name.
  for (const template of new Set(Object.values(templates ?? {})))
    if (template && typeof template === 'object') scan(`web template ${template.name}`, template.source);
  const modern = [...found],
    fallback = [...classic];
  if (modern.length)
    diagnostics.push({
      code: 'MODERN_LIST_LOCAL_MARKUP',
      severity: 'info',
      level: 'contract',
      count: modern.length,
      items: listed(modern),
      message: `${modern.length} list include(s) ask for the modern list (isModern 'true'). The local modern list adapter serves their secured data with infinite scroll, views, search, metadata filters, sorting, the details, edit, create, delete and download actions and the $pages list API through the classic grid engine; the markup and styling are local, because the platform's modern list markup is not documented.`,
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
  if (fallback.length)
    diagnostics.push({
      code: 'MODERN_LIST_RENDERED_CLASSIC',
      severity: 'warning',
      level: 'contract',
      requirement: { id: 'portal:modern-list', status: 'unsupported', level: 'contract' },
      count: fallback.length,
      items: listed(fallback),
      message: `${fallback.length} modern list include(s) name a map, calendar or dataset code component list, which the local modern list adapter does not serve; the local runtime renders the classic list for them, so layout, paging (infinite scroll) and styling differ from the live site.`,
    });
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
 * customer account; whether Power Pages still does isn't documented, so the local personas don't
 * apply these roles and lib/permissions.mjs reports them (PERSONA_ACCOUNT_ROLES_NOT_APPLIED).
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
