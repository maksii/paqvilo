// Where each request of a portal page comes from: the ledger of one document and the platform rules behind it.
// The ledger holds addresses, methods, types, statuses and how each was answered; never query values, fragments,
// credentials, cookies, headers or bodies (urls pass through redactUrl, the agent API's own sanitiser).
import { redactUrl } from './agent-server.mjs';

/** Every class a ledger entry can have. */
export const REQUEST_CLASSES = Object.freeze([
  'local',
  'document',
  'export',
  'portal-data',
  'platform-asset',
  'external',
  'unidentified',
]);

/** The host of the Power Pages runtime CDN. */
export const PLATFORM_CDN_ORIGIN = 'https://content.powerapps.com';

/**
 * Same-origin platform endpoints and assets, in evaluation order (first match wins). Each rule names the Mirage module
 * that models the endpoint, so the table follows what Mirage itself serves instead of guesses. `path` is tested
 * against the pathname without its website-language segment; `cdn` rules also match the CDN origin.
 */
export const REQUEST_RULES = Object.freeze(
  [
    // mirage/lib/server-logic.mjs SERVER_LOGIC_PATH (/_api/serverlogics/<name>)
    { class: 'portal-data', platform: 'server-logic', path: /^\/_api\/serverlogics\/[^/]+\/?$/i },
    // mirage/server.mjs cloud-flow pipeline (/_api/cloudflow/v1.0/trigger/<guid>)
    { class: 'portal-data', platform: 'cloud-flow', path: /^\/_api\/cloudflow\//i },
    // mirage/server.mjs fileApi (/_api/file/InitializeFileUpload|UploadFileBlock/note)
    { class: 'portal-data', platform: 'file-upload', path: /^\/_api\/file\//i },
    // mirage/server.mjs api() for every /_api/ path (lib/webapi-handler.mjs)
    { class: 'portal-data', platform: 'web-api', path: /^\/_api(?:\/|$)/i },
    // mirage/lib/odata-feeds.mjs (/_odata, /_odata/<feed>)
    { class: 'portal-data', platform: 'odata', path: /^\/_odata(?:\/|$)/i },
    // mirage/lib/auth-token.mjs (/_services/auth/token, /_services/auth/publickey)
    { class: 'portal-data', platform: 'auth-token', path: /^\/_services\/auth(?:\/|$)/i },
    // mirage/lib/native-services.mjs ad and poll services (/_services/ads|polls/<site>/...)
    { class: 'portal-data', platform: 'ads-polls', path: /^\/_services\/(?:ads|polls)\//i },
    // mirage/lib/native-services.mjs SERVICE (/_services/<service>/<website id>: grids, notes, lookups, search)
    { class: 'portal-data', platform: 'portal-service', path: /^\/_services\//i },
    // mirage/server.mjs /_layout/tokenhtml (lib/response-headers.mjs tokenHtmlHeaders)
    { class: 'portal-data', platform: 'anti-forgery-token', path: /^\/_layout\/tokenhtml\/?$/i },
    // mirage/server.mjs scoped Layout/GetAntiForgeryToken (/_portal/<site>/Layout/GetAntiForgeryToken)
    {
      class: 'portal-data',
      platform: 'anti-forgery-token',
      path: /^\/_portal\/[^/]+\/Layout\/GetAntiForgeryToken\/?$/i,
    },
    // mirage/lib/native-services.mjs RESOURCE_MANAGER (/_portal/<site>/Resources/ResourceManager)
    { class: 'portal-data', platform: 'resource-manager', path: /^\/_portal\/[^/]+\/Resources\/ResourceManager\/?$/i },
    // mirage/server.mjs modal and quick view documents (/_portal/modal-form-template-path, quickform-template-path)
    {
      class: 'portal-data',
      platform: 'form-dialog',
      path: /^\/_portal\/(?:modal-form-template-path|quickform-template-path)(?:\/|$)/i,
    },
    // mirage/lib/native-services.mjs note attachments (/_entity/annotation/<id>[/...])
    { class: 'portal-data', platform: 'note-attachment', path: /^\/_entity\/annotation\//i },
    // mirage/server.mjs Power Pages document control (/_apps/portal-documents, lib/sharepoint-documents.mjs)
    { class: 'portal-data', platform: 'portal-documents', path: /^\/_apps\/portal-documents(?:\/|$)/i },
    // mirage/lib/auth-session.mjs SIGN_OUT_PATH (/Account/Login/LogOff)
    { class: 'portal-data', platform: 'sign-out', path: /^\/account\/login\/logoff\/?$/i },
    // mirage/lib/sign-in-flow.mjs ACCOUNT_PATH (external sign-in, callback, invitation redemption)
    {
      class: 'portal-data',
      platform: 'external-sign-in',
      path: /^\/account\/login\/(?:externallogin|externallogincallback|redeeminvitation)\/?$/i,
    },
    // mirage/lib/auth-session.mjs SIGN_IN_PATHS (/SignIn, /Account/Login[/Login|/ExternalLogin|/Register])
    {
      class: 'portal-data',
      platform: 'sign-in',
      path: /^\/(?:signin|account\/login(?:\/(?:login|externallogin|register))?)\/?$/i,
    },
    // mirage/server.mjs /Register, the invitation redemption page (rewritten to /Account/Login/RedeemInvitation)
    { class: 'portal-data', platform: 'registration', path: /^\/register\/?$/i },
    // mirage/lib/platform-manifest.mjs PLATFORM_BUNDLE_ROOT and lib/native-services.mjs: the runtime bundles, images
    // and fonts under /resource/powerappsportal/ on the CDN and on the portal origin
    { class: 'platform-asset', platform: 'bundle', path: /^\/resource\/powerappsportal\//i, cdn: true },
    // mirage/lib/platform-manifest.mjs platformBundleFor: the onerror fallback /dist/<bundle> on the portal origin
    { class: 'platform-asset', platform: 'bundle', path: /^\/dist\/[^/]+\.bundle[-.][\w.-]+$/i },
    // mirage/lib/asset-cache.mjs isAspNetResourcePath and lib/platform-manifest.mjs LOCAL_ASPNET_SCRIPTS
    { class: 'platform-asset', platform: 'aspnet-resource', path: /^\/(?:WebResource|ScriptResource)\.axd$/i },
    // mirage/server.mjs and lib/native-services.mjs platform static files (/xrm-adx/js, /xrm-adx/icons)
    { class: 'platform-asset', platform: 'xrm-adx', path: /^\/xrm-adx\//i },
    // mirage/server.mjs /areas/<area>/... static files and lib/native-services.mjs entity list calendar assets
    { class: 'platform-asset', platform: 'areas', path: /^\/areas\/.+\.[a-z0-9]+$/i },
    // mirage/server.mjs glyphicons fonts (/fonts/glyphicons-halflings-regular.*)
    {
      class: 'platform-asset',
      platform: 'glyphicons',
      path: /^\/fonts\/glyphicons-halflings-regular\.(?:eot|svg|ttf|woff2?)$/i,
    },
    // mirage/lib/platform-manifest.mjs blockui (/js/jquery.blockUI.js)
    { class: 'platform-asset', platform: 'blockui', path: /^\/js\/jquery\.blockUI\.js$/i },
    // mirage/server.mjs static asset classification: code component and solution web resources
    { class: 'platform-asset', platform: 'web-resource', path: /^\/(?:_pcfwebresource|webresources|_webresource)\//i },
  ].map((rule) => Object.freeze(rule)),
);

/** The name of a /resource/powerappsportal/ asset without its build hash: dist/app.bundle-1a2b3c.js is app.bundle.js. */
export function platformAssetName(pathname) {
  const rest = String(pathname ?? '')
    .replace(/^\/resource\/powerappsportal\//i, '')
    .replace(/^\/?dist\//i, '');
  return rest.replace(/[-.][0-9a-f]{6,}(?=\.[a-z0-9]+$)/i, '') || null;
}

/** The platform rule an address matches, as {class, platform}, or null. `pathname` has no language segment. */
export function platformRule(url, origin, pathname = url.pathname) {
  const cdn = url.origin === PLATFORM_CDN_ORIGIN;
  if (url.origin !== origin && !cdn) return null;
  for (const rule of REQUEST_RULES) {
    if (cdn && !rule.cdn) continue;
    if (!rule.path.test(cdn ? url.pathname : pathname)) continue;
    const platform = rule.platform === 'bundle' ? (platformAssetName(url.pathname) ?? 'bundle') : rule.platform;
    return { class: rule.class, platform };
  }
  return null;
}

/**
 * The ledger address of a request: sanitised as agent events are (no credentials, fragment or query values); an
 * `external` request keeps its origin only.
 */
export function ledgerUrl(value, { external = false } = {}) {
  if (!external) return redactUrl(value);
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol) ? url.origin : '[non-HTTP URL]';
  } catch {
    return '[invalid URL]';
  }
}

const LEDGER_LIMIT = 1000;
// Distinct addresses beyond the entry limit are still counted, up to this many.
const OVERFLOW_LIMIT = 20_000;
const STATIC_TYPES = new Set(['script', 'stylesheet', 'image', 'font', 'media']);
// `control`: the code component a /_pcfwebresource/ address belongs to (lense/pcf-resources.mjs).
const PUBLIC_FIELDS = [
  'url',
  'method',
  'type',
  'status',
  'class',
  'rel',
  'kind',
  'control',
  'platform',
  'reason',
  'note',
];
const ROUTED_FIELDS = ['class', 'rel', 'kind', 'control', 'platform', 'reason', 'note', 'sources', 'matched'];

/** Why a same-origin request that maps to nothing is unidentified, from what the portal answered. */
function unidentifiedReason(entry) {
  if (entry.reason && entry.reason !== 'pending') return entry.reason;
  if (entry.status === 404) return 'not-found';
  if (entry.failed && !entry.routed) return 'failed';
  // Reported by the browser and not answered yet; a request only interception saw has no status to read.
  if (entry.status == null && !entry.failed) return entry.seen ? 'pending' : 'unmapped';
  if (entry.status >= 200 && entry.status < 400 && STATIC_TYPES.has(entry.type)) return 'not-in-export';
  return 'unmapped';
}

/**
 * Every request of one document and how it was answered. Repeats of one address merge into `count`; a request that
 * interception answered and the browser reported is counted once (the larger of the two counts).
 */
export class RequestLedger {
  constructor({ limit = LEDGER_LIMIT } = {}) {
    this.limit = limit;
    this.generation = 0;
    this.reset();
  }

  /** Starts the ledger of a new document. */
  reset() {
    this.generation++;
    this.entries = new Map();
    this.overflow = new Map();
    this.uncounted = 0;
  }

  #entry(key, fields) {
    let entry = this.entries.get(key);
    if (entry) return entry;
    if (this.entries.size >= this.limit) {
      entry = this.overflow.get(key);
      if (entry) return entry;
      if (this.overflow.size >= OVERFLOW_LIMIT) return null;
      entry = { seen: 0, routed: 0, class: fields.class ?? 'unidentified' };
      this.overflow.set(key, entry);
      return entry;
    }
    entry = { url: fields.url, method: fields.method, seen: 0, routed: 0 };
    this.entries.set(key, entry);
    return entry;
  }

  /** What interception decided for a request: authoritative for its class and source. */
  route(fields) {
    const entry = this.#entry(ledgerKey(fields), fields);
    if (!entry) {
      this.uncounted++;
      return undefined;
    }
    entry.routed++;
    entry.provisional = false;
    for (const name of [...ROUTED_FIELDS, 'status']) if (fields[name] !== undefined) entry[name] = fields[name];
    // The browser's own resource type is more specific than the protocol's (a worker script is "other" there).
    if (fields.type && (entry.type === undefined || (entry.type === 'other' && !entry.seen))) entry.type = fields.type;
    // The latest answer of interception decides; fields it does not name no longer apply.
    if (entry.url !== undefined) for (const name of ROUTED_FIELDS) if (fields[name] === undefined) delete entry[name];
    entry.class ??= 'unidentified';
    return entry;
  }

  /** A request the browser reported, with the class its address alone gives until interception says more. */
  observe(fields) {
    const entry = this.#entry(ledgerKey(fields), fields);
    if (!entry) {
      this.uncounted++;
      return undefined;
    }
    entry.seen++;
    if (fields.type && fields.type !== 'other') entry.type = fields.type;
    else entry.type ??= fields.type;
    if (entry.class === undefined || entry.provisional) {
      for (const name of ['class', 'rel', 'kind', 'control', 'platform', 'reason'])
        if (fields[name] !== undefined) entry[name] = fields[name];
      entry.provisional = true;
    }
    return entry;
  }

  /** The browser's answer for an observed request: its status, or that it failed. */
  answer(fields, { status, failed = false } = {}) {
    const entry = this.entries.get(ledgerKey(fields)) ?? this.overflow.get(ledgerKey(fields));
    if (!entry) return;
    if (Number.isInteger(status)) entry.status = status;
    if (failed) entry.failed = true;
  }

  /** `{ total, truncated, counts, items }` with at most `limit` items; counts cover every recorded request. */
  summary({ limit = this.limit } = {}) {
    const counts = Object.fromEntries(REQUEST_CLASSES.map((name) => [name, 0]));
    let total = this.uncounted;
    const items = [];
    for (const entry of this.entries.values()) {
      const item = publicItem(entry);
      counts[item.class] += item.count;
      total += item.count;
      if (items.length < limit) items.push(item);
    }
    for (const entry of this.overflow.values()) {
      const count = Math.max(entry.seen, entry.routed, 1);
      counts[entry.class] = (counts[entry.class] ?? 0) + count;
      total += count;
    }
    return {
      total,
      truncated: this.overflow.size > 0 || this.uncounted > 0 || this.entries.size > items.length,
      ...(this.uncounted ? { uncounted: this.uncounted } : {}),
      counts,
      items,
    };
  }
}

function ledgerKey({ method, type, url, class: kind }) {
  // Requests to another origin keep their origin and type only.
  return kind === 'external' ? `${method} ${type} ${url}` : `${method} ${url}`;
}

function publicItem(entry) {
  const item = {};
  for (const name of PUBLIC_FIELDS) if (entry[name] !== undefined && entry[name] !== null) item[name] = entry[name];
  item.class ??= 'unidentified';
  // Reported by the browser and not answered yet: interception may still decide it.
  if (entry.provisional && entry.status == null && !entry.failed && entry.reason === 'not-intercepted')
    item.reason = 'pending';
  else if (item.class === 'unidentified') item.reason = unidentifiedReason(entry);
  if (item.status === undefined) item.status = entry.failed ? 'failed' : null;
  if (entry.sources) item.sources = entry.sources;
  if (entry.matched) item.matched = entry.matched;
  item.count = Math.max(entry.seen, entry.routed, 1);
  return item;
}
