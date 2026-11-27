import { createHash, randomBytes } from 'node:crypto';
import { siteSetting } from './redirects.mjs';
import path from 'node:path';
import { corsPageDiagnostics } from './page-cors.mjs';

const lower = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * The site's own Content-Security-Policy (HTTP/Content-Security-Policy), unless it is
 * empty or HTTP/Content-Security-Policy/Enabled or /InjectHeader is "false". A policy
 * whose only nonce source is Learn's placeholder 'nonce' ("Manage your site's Content
 * Security Policy": the platform generates a unique nonce for each page request) is a
 * template, reason "nonce": siteHeaders substitutes the response's nonce. Any other
 * nonce source (a fixed 'nonce-<value>', a malformed one) has no documented meaning
 * and keeps being omitted (reason "nonce-unsupported", PORTAL_HTTP_CSP_NONCE_UNSUPPORTED).
 */
export function sitePolicy(portal) {
  const configured = siteSetting(portal, 'HTTP/Content-Security-Policy');
  // The platform default applies only while the site has no such setting: Learn says to clear the value (not delete the
  // setting) to disable CSP, so an empty exported value stays "unset".
  const platformDefault = configured === undefined && portal.observed?.defaultContentSecurityPolicy === 'platform';
  const value = String((platformDefault ? PLATFORM_DEFAULT_POLICY : configured) ?? '').trim();
  if (!value) return { policy: null, reason: 'unset' };
  if (lower(siteSetting(portal, 'HTTP/Content-Security-Policy/Enabled')) === 'false')
    return { policy: null, reason: 'disabled' };
  if (lower(siteSetting(portal, 'HTTP/Content-Security-Policy/InjectHeader')) === 'false')
    return { policy: null, reason: 'not-injected' };
  const nonce = nonceKind(value);
  if (nonce === 'unsupported') return { policy: null, reason: 'nonce-unsupported' };
  if (nonce === 'placeholder') return { policy: value, reason: 'nonce' };
  return { policy: value, reason: 'site-setting' };
}
/**
 * The default policy of sites created after November 10, 2025 (Learn "Manage your site's Content Security Policy"), as
 * hosted sites without an HTTP/Content-Security-Policy setting send it (hosted sessions F5 and F3, two runs each),
 * before its 'nonce' placeholder is expanded (substituteScriptNonce). The export does not show it: a site observed
 * sending it records observed.defaultContentSecurityPolicy "platform".
 */
const PLATFORM_DEFAULT_POLICY =
  "script-src 'self' test.content.powerapps.com content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce'; style-src 'unsafe-inline' https:;";
// The fixed hash the platform adds after the nonce (hosted sessions F5 and F3).
const PLATFORM_SCRIPT_HASH = "'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM='";
/** HTTP/* settings handled separately or not sent by the loopback runtime. */
const SEPARATE = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options']);
// Strict-Transport-Security belongs to the HTTPS hosting front end (observed.strictTransportSecurity).
const NOT_ECHOED = /^strict-transport-security$/;
// The HTTP/Access-Control-* settings: hosted sites send each value verbatim as a fixed header on every response,
// whatever the Origin, method, route or status, without Vary: Origin (hosted session F5, two runs).
const CORS_SETTING = /^http\/(access-control-[a-z0-9][a-z0-9-]*)$/i;
const REPORT_ONLY_SETTING = 'HTTP/Content-Security-Policy-Report-Only';
// The documented placeholder source expression, as one whole token of a directive.
const NONCE_PLACEHOLDER = /(^|[\s;])'nonce'(?=[\s;]|$)/gi;
/** "placeholder" when every nonce source of a policy is Learn's 'nonce', "unsupported" for any other, else null. */
function nonceKind(value) {
  const tokens = String(value)
    .split(/[\s;]+/)
    .filter((token) => /^'nonce/i.test(token));
  if (!tokens.length) return null;
  return tokens.every((token) => token.toLowerCase() === "'nonce'") ? 'placeholder' : 'unsupported';
}

const configuredValue = (portal, name) => String(siteSetting(portal, name) ?? '').trim();
/** The report-only policy (HTTP/Content-Security-Policy-Report-Only) when it is sent: set and not an unsupported nonce. */
const reportOnlyPolicy = (portal) => {
  const value = configuredValue(portal, REPORT_ONLY_SETTING);
  return value && nonceKind(value) !== 'unsupported' ? value : null;
};

/** A fresh per-response nonce: 256 random bits, base64 (a CSP base64-value), as long as hosted nonces (session F5). */
export const cspNonce = () => randomBytes(32).toString('base64');

/**
 * True when a page response of the site sends a policy with the nonce placeholder
 * (HTTP/Content-Security-Policy or HTTP/Content-Security-Policy-Report-Only): the page
 * then needs one nonce (cspNonce) shared by its headers and its scripts.
 */
export function siteUsesScriptNonce(portal) {
  return sitePolicy(portal).reason === 'nonce' || nonceKind(reportOnlyPolicy(portal) ?? '') === 'placeholder';
}

// Directives that govern inline event handlers (script-src-attr, then script-src, then default-src).
const HANDLER_DIRECTIVE = /^\s*(?:script-src|script-src-attr|default-src)(?:\s|$)/i;
/**
 * The policy with each placeholder 'nonce' replaced by 'nonce-<nonce>'. In the enforced policy (`hosted`), the first
 * placeholder of a directive that governs scripts expands as hosted sites expand it, the platform default and a site's
 * own policy alike (hosted session F3; F5 for the default): " 'unsafe-eval' 'nonce-<nonce>' <the platform's fixed hash>
 * 'unsafe-hashes' 'inject-hashes'", where a rendered page's inline-handler hashes (`handlerHashes`, base64 SHA-256 of
 * handler attribute values) take the place of 'inject-hashes', each followed by a space, with one more space after
 * them; every other response keeps the literal 'inject-hashes'. In the report-only policy, whose hosted text is not
 * observed, the first placeholder of such a directive is followed by 'unsafe-hashes' and one 'sha256-<hash>' per hash.
 */
function substituteScriptNonce(policy, nonce, handlerHashes = null, { hosted = true } = {}) {
  const source = `'nonce-${nonce}'`;
  // `handlerHashes`: a rendered page's hashes, or their groups (render-provenance handlerHashGroups: the platform's,
  // then the page's); null for a response that is not a rendered page.
  const rendered = Array.isArray(handlerHashes);
  const list = rendered ? handlerHashes : [];
  const groups = (list.some(Array.isArray) ? list : [list])
    .map((group) => [...new Set(group)].map((hash) => `'sha256-${hash}'`))
    .filter((group) => group.length);
  const hashes = groups.flat();
  // Hosted sessions F5 and F3: on a rendered page the placeholder gives way to the page's hashes, each followed by a
  // space and each group by one more; every other response keeps the literal 'inject-hashes'. A rendered page without
  // handlers (no capture has one: hosted pages always carry the shell's) gets none, so no browser reads the placeholder
  // as an invalid source on a page.
  const injected = rendered
    ? groups.map((group) => group.map((hash) => hash + ' ').join('') + ' ').join('')
    : "'inject-hashes'";
  const expansion = ` 'unsafe-eval' ${source} ${PLATFORM_SCRIPT_HASH} 'unsafe-hashes' ${injected}`;
  return String(policy)
    .split(';')
    .map((directive) => {
      if (hosted) {
        let first = HANDLER_DIRECTIVE.test(directive);
        return directive.replace(NONCE_PLACEHOLDER, (_match, lead) => {
          const text = first ? expansion : source;
          first = false;
          return lead + text;
        });
      }
      let first = HANDLER_DIRECTIVE.test(directive) && hashes.length > 0;
      return directive.replace(NONCE_PLACEHOLDER, (_match, lead) => {
        const text = first ? [source, "'unsafe-hashes'", ...hashes].join(' ') : source;
        first = false;
        return lead + text;
      });
    })
    .join(';');
}

// The hosted site is served over HTTPS, so an https: scheme source admits the site's own origin there. The local runtime
// listens on http loopback, which https: does not match (CSP3 scheme-source matching only upgrades http: to https:).
const HTTPS_SCHEME_SOURCE = /(?:^|\s)https:(?=\s|$)/i;
const SELF_SOURCE = /(?:^|\s)'self'(?=\s|$)/i;
/** The directive names of a policy whose https: scheme source the loopback transport adds 'self' to. */
function loopbackTransportDirectives(policy) {
  return String(policy ?? '')
    .split(';')
    .filter((directive) => HTTPS_SCHEME_SOURCE.test(directive) && !SELF_SOURCE.test(directive))
    .map((directive) => directive.trim().split(/\s+/)[0].toLowerCase());
}
/**
 * The policy for a response of the http loopback listener: each directive with an https: scheme source and without
 * 'self' also gets 'self', the loopback origin that stands for the hosted https origin. Nothing else changes.
 */
function adaptLoopbackTransport(policy) {
  return String(policy)
    .split(';')
    .map((directive) => {
      if (!HTTPS_SCHEME_SOURCE.test(directive) || SELF_SOURCE.test(directive)) return directive;
      const sources = directive.trimEnd();
      return sources + " 'self'" + directive.slice(sources.length);
    })
    .join(';');
}

/**
 * True when a header value can be sent: tab, printable ASCII and Latin-1 octets only (the characters Node accepts in a
 * header value). A setting with any other character (a line break, a control character, "€") is not sent and is
 * reported (PORTAL_HTTP_HEADER_INVALID).
 */
const headerValueValid = (value) => /^[\t\x20-\x7e\x80-\xff]*$/.test(String(value));

/** Report source-declared policies whose hosted handling is outside local HTTP header simulation. */
export function siteHttpPolicyDiagnostics(portal) {
  const diagnostics = [];
  const invalid = Object.entries(portal.settings ?? {})
    .filter(([name]) => /^http\/[a-z0-9][a-z0-9-]*$/i.test(name))
    .filter(([name]) => configuredValue(portal, name) && !headerValueValid(configuredValue(portal, name)))
    .map(([name]) => name.toLowerCase())
    .sort(/* NOSONAR: preserve default string coercion */);
  if (invalid.length)
    diagnostics.push({
      code: 'PORTAL_HTTP_HEADER_INVALID',
      severity: 'warning',
      settings: [...new Set(invalid)],
      message:
        'These HTTP/* settings hold characters a header value cannot carry (line breaks, control characters or characters outside Latin-1): the local portal does not send them.',
    });
  const cors = Object.keys(portal.settings ?? {})
    .filter((name) => /^http\/access-control-[a-z0-9-]+$/i.test(name) && configuredValue(portal, name))
    .map((name) => name.toLowerCase())
    .sort(/* NOSONAR: preserve default string coercion */);
  if (cors.length && !portal.observed?.corsPages?.length)
    diagnostics.push({
      code: 'PORTAL_HTTP_CORS_LOOPBACK_BOUNDARY',
      severity: 'warning',
      settings: [...new Set(cors)],
      message:
        'The local portal sends the exported CORS settings as fixed response headers, as the platform does, but refuses every cross-origin request at its loopback origin boundary; observed.corsPages admits the authored pages a public site was observed sharing.',
    });
  const sent = Object.fromEntries(
    Object.keys(portal.settings ?? {})
      .filter((name) => CORS_SETTING.test(name))
      .map((name) => [CORS_SETTING.exec(name)[1].toLowerCase(), configuredValue(portal, name)]),
  );
  if (wildcardWithCredentials(sent))
    diagnostics.push({
      code: 'PORTAL_HTTP_CORS_WILDCARD_CREDENTIALS',
      severity: 'warning',
      settings: ['http/access-control-allow-credentials', 'http/access-control-allow-origin'],
      message:
        'HTTP/Access-Control-Allow-Origin "*" with HTTP/Access-Control-Allow-Credentials "true" is a combination the Fetch standard refuses: the local portal sends the origin without the credentials header.',
    });
  diagnostics.push(...corsPageDiagnostics(portal));
  if (configuredValue(portal, 'HTTP/Strict-Transport-Security'))
    diagnostics.push({
      code: 'PORTAL_HTTP_HSTS_UNSUPPORTED',
      severity: 'warning',
      settings: ['http/strict-transport-security'],
      message:
        'The local HTTP listener does not send the configured HSTS setting: the hosted HTTPS front end sets that header. Record the header a site sends as observed.strictTransportSecurity.',
    });
  if (sitePolicy(portal).reason === 'nonce' && siteSetting(portal, 'HTTP/Content-Security-Policy') === undefined)
    diagnostics.push({
      code: 'PORTAL_HTTP_CSP_PLATFORM_DEFAULT',
      severity: 'info',
      settings: ['http/content-security-policy'],
      message:
        'The site sets no HTTP/Content-Security-Policy and was observed with the platform default policy of sites created after November 10, 2025: the local portal sends that policy as hosted sites send it.',
    });
  const nonce = [];
  if (sitePolicy(portal).reason === 'nonce-unsupported') nonce.push('http/content-security-policy');
  if (nonceKind(configuredValue(portal, REPORT_ONLY_SETTING)) === 'unsupported')
    nonce.push(REPORT_ONLY_SETTING.toLowerCase());
  const adapted = [
    ['http/content-security-policy', sitePolicy(portal).policy],
    [REPORT_ONLY_SETTING.toLowerCase(), reportOnlyPolicy(portal)],
  ].filter(([, policy]) => loopbackTransportDirectives(policy).length);
  if (adapted.length)
    diagnostics.push({
      code: 'PORTAL_HTTP_CSP_LOOPBACK_TRANSPORT',
      severity: 'info',
      settings: adapted.map(([name]) => name),
      directives: [...new Set(adapted.flatMap(([, policy]) => loopbackTransportDirectives(policy)))],
      message:
        "The local portal is served over http loopback, which the policy's https: sources do not match: those directives also allow 'self' (the loopback origin) in local responses.",
    });
  if (nonce.length)
    diagnostics.push({
      code: 'PORTAL_HTTP_CSP_NONCE_UNSUPPORTED',
      severity: 'warning',
      settings: nonce,
      message:
        "The local portal omits the configured policy: its nonce source is not the documented 'nonce' placeholder.",
    });
  return diagnostics;
}

/**
 * Portal page and web file headers derived only from HTTP/* site settings, one header
 * each, as the platform sends them: every HTTP/<Header-Name> setting with a value
 * (X-Content-Type-Options, Referrer-Policy, Permissions-Policy, ...), X-Frame-Options
 * (default SAMEORIGIN), the site's Content-Security-Policy (sitePolicy) and
 * Content-Security-Policy-Report-Only. Nothing else: no CSP and no X-Content-Type-Options
 * unless the site defines them. Settings with a deeper name (HTTP/Content-Security-Policy/
 * Enabled, HTTP/SameSite/Default) are options, not headers. HTTP/Access-Control-* settings are sent verbatim
 * (corsSettingHeaders); the HTTP/Strict-Transport-Security setting is not sent. observed.strictTransportSecurity is sent on the http loopback
 * listener only; observed.defaultContentSecurityPolicy "platform" supplies the documented default policy
 * (sitePolicy). `confinement` (config.confinePortalPages) adds
 * the loopback confinement policy as a separate Content-Security-Policy header. `kind`
 * ("page" or "webFile") adds the headers the site's observed configuration records for
 * that response kind (portal.observed.headers), where no site setting already sets them.
 * A policy with the 'nonce' placeholder (sitePolicy reason "nonce", or the report-only one)
 * is sent only with `nonce`, the nonce the response gave its scripts, and `handlerHashes`
 * (substituteScriptNonce). A response that did not nonce its scripts (data, files, documents
 * the runtime composes outside the page layout) omits such a policy, as before nonces were
 * issued: a policy whose nonce no script carries would block every inline script locally. `freshNonce` marks a
 * response that runs none of the runtime's own composed scripts (a redirect, a file, a data or plain error response):
 * the platform default policy is then sent with a fresh nonce and its literal 'inject-hashes', as hosted sites send
 * it on every response.
 * `loopback` (default true: the runtime's listener is http loopback) adapts the site's policies to that transport
 * (adaptLoopbackTransport); the confinement policy is the runtime's own and is not adapted.
 */
export function siteHeaders(
  portal,
  { confinement = null, kind = null, nonce = null, handlerHashes = null, loopback = true, freshNonce = false } = {},
) {
  const headers = {};
  appendConfiguredHeaders(headers, portal);
  Object.assign(headers, corsSettingHeaders(portal));
  appendPolicyHeaders(headers, portal, confinement, { nonce, handlerHashes, loopback, freshNonce });
  // The observed HSTS header, only on the plain-http loopback listener: RFC 6797 section 8.1 makes a browser ignore the
  // header on a response that did not arrive over a secure transport, so it never pins localhost (HSTS is keyed by host,
  // not port, and would force every other local server of that host to HTTPS).
  const hsts = portal.observed?.strictTransportSecurity;
  if (hsts && loopback) headers['strict-transport-security'] = hsts;
  appendObservedHeaders(headers, portal, kind);
  return headers;
}

function appendConfiguredHeaders(headers, portal) {
  for (const [key, raw] of Object.entries(portal.settings ?? {})) {
    const match = /^http\/([a-z0-9][a-z0-9-]*)$/i.exec(key);
    if (!match) continue;
    const name = match[1].toLowerCase();
    // HTTP/Access-Control-* settings are added by corsSettingHeaders, with its wildcard-with-credentials guard.
    if (
      SEPARATE.has(name) ||
      NOT_ECHOED.test(name) ||
      name.startsWith('access-control-') ||
      Object.hasOwn(headers, name)
    )
      continue;
    const value = String((raw && typeof raw === 'object' ? raw.value : raw) ?? '').trim();
    if (value && headerValueValid(value)) headers[name] = value;
  }
}

/**
 * The HTTP/Access-Control-* settings as response headers, each value verbatim (trimmed, without line breaks): hosted
 * sites send them as fixed headers on every response, with no Origin check and no Vary: Origin (session F5).
 */
function corsSettingHeaders(portal) {
  const headers = {};
  for (const [key, raw] of Object.entries(portal?.settings ?? {})) {
    const name = CORS_SETTING.exec(key)?.[1]?.toLowerCase();
    if (!name || Object.hasOwn(headers, name)) continue;
    const value = String((raw && typeof raw === 'object' ? raw.value : raw) ?? '').trim();
    if (value && headerValueValid(value)) headers[name] = value;
  }
  // A wildcard origin is never sent with credentials (PORTAL_HTTP_CORS_WILDCARD_CREDENTIALS): the Fetch standard refuses
  // the pair and Learn's best practices say not to combine them. Hosted sites were not captured with it.
  if (wildcardWithCredentials(headers)) delete headers['access-control-allow-credentials'];
  return headers;
}
const wildcardWithCredentials = (headers) =>
  String(headers['access-control-allow-origin'] ?? '')
    .split(/[\s,]+/)
    .includes('*') && lower(headers['access-control-allow-credentials']) === 'true';

function appendPolicyHeaders(headers, portal, confinement, { nonce, handlerHashes, loopback, freshNonce }) {
  headers['x-frame-options'] = String(siteSetting(portal, 'HTTP/X-Frame-Options') ?? '').trim() || 'SAMEORIGIN';
  const transported = (policy) => (policy && loopback ? adaptLoopbackTransport(policy) : policy);
  const substituted = (policy, hosted) => {
    if (!policy || nonceKind(policy) !== 'placeholder') return transported(policy);
    if (nonce) return transported(substituteScriptNonce(policy, nonce, handlerHashes, { hosted }));
    // A response that runs no composed script gets the enforced nonce policy with a fresh nonce, as hosted sites send it
    // on every response (sessions F5 and F3); otherwise the policy is omitted, as described above.
    return freshNonce && hosted ? transported(substituteScriptNonce(policy, cspNonce())) : null;
  };
  const policies = [substituted(sitePolicy(portal).policy, true), confinement].filter(Boolean);
  if (policies.length) headers['content-security-policy'] = policies.length === 1 ? policies[0] : policies;
  const reportOnly = substituted(reportOnlyPolicy(portal), false);
  if (reportOnly) headers['content-security-policy-report-only'] = reportOnly;
}

function appendObservedHeaders(headers, portal, kind) {
  for (const [name, value] of Object.entries((kind && portal.observed?.headers?.[kind]) ?? {}))
    if (!Object.hasOwn(headers, name)) headers[name] = value;
}

/**
 * The anti-forgery token fragment (/_layout/tokenhtml) uses page caching and
 * the page's configured site headers (siteHeaders kind "page"). It runs no script: the platform default policy comes
 * with a fresh nonce, as hosted sites send it there (session F5).
 */
export function tokenHtmlHeaders(portal, { confinement = null } = {}) {
  return { ...PAGE_HEADERS, ...siteHeaders(portal, { confinement, kind: 'page', freshNonce: true }) };
}

/** HTML page responses: the platform sends no-cache, no-store, must-revalidate. */
export const PAGE_CACHE_CONTROL = 'no-cache, no-store, must-revalidate';
/**
 * Caching headers of portal page responses as observed online: the ASP.NET no-store
 * policy sends Pragma: no-cache and Expires: -1 with it; Vary: Accept-Encoding accompanies
 * every compressible portal response.
 */
export const PAGE_HEADERS = Object.freeze({
  'cache-control': PAGE_CACHE_CONTROL,
  pragma: 'no-cache',
  expires: '-1',
  vary: 'Accept-Encoding',
});

const httpDate = (time) => new Date(Math.floor(time / 1000) * 1000).toUTCString();
const STARTED = Date.now();
/**
 * Headers of the platform's own portal-origin resources (lib/native-services.mjs serves their
 * local equivalents), as observed online for each kind:
 * - "axd": WebResource.axd/ScriptResource.axd, application/x-javascript, public, one year
 *   (WebResource.axd's Vary: Accept-Encoding is inconsistent natively and is not sent).
 * - "resource-manager": the ResourceManager script, public for one day.
 * - "static": platform static files (/js/, /xrm-adx/js/) as IIS serves them: byte ranges, an
 *   IIS-style quoted ETag and Last-Modified; /js/ adds public,max-age=604800.
 * Last-Modified is the local equivalent file's modification time when the caller passes it
 * (modified, ms), else the runtime start (the platform's is its build or cache time); a recent
 * value makes browsers revalidate (a conditional request answered 304 by notModified).
 * X-Frame-Options comes from the site (siteHeaders).
 */
export function platformResourceHeaders(
  kind,
  { pathname = '', body = '', contentType = '', frameOptions = 'SAMEORIGIN', modified = null } = {},
) {
  const changed = Number.isFinite(modified) ? modified : STARTED;
  const now = Date.now();
  if (kind === 'axd')
    return {
      'content-type': 'application/x-javascript',
      'cache-control': 'public',
      expires: httpDate(now + 365 * 86400 * 1000),
      'last-modified': httpDate(changed),
      'x-frame-options': frameOptions,
    };
  if (kind === 'resource-manager')
    return {
      'content-type': contentType,
      'cache-control': 'public, max-age=86400',
      expires: httpDate(now + 86400 * 1000),
      'last-modified': httpDate(now),
      'x-frame-options': frameOptions,
    };
  return {
    'accept-ranges': 'bytes',
    ...(/^\/js\//i.test(pathname) ? { 'cache-control': 'public,max-age=604800' } : {}),
    'content-type': contentType,
    etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 13)}:0"`,
    'last-modified': httpDate(changed),
    vary: 'Accept-Encoding',
    'x-frame-options': frameOptions,
  };
}

/** RFC 5987 value-chars encoding (UTF-8 percent-encoding) of a header parameter such as filename*. */
export const rfc5987 = (value) =>
  encodeURIComponent(String(value)).replace(/['()*]/g, (c) => '%' + c.codePointAt(0).toString(16).toUpperCase());

/**
 * Content-Disposition carrying a file name safely (RFC 6266): a quoted ASCII fallback where
 * quote, backslash, controls and non-ASCII characters become "_", plus filename*=UTF-8'' with
 * the exact name, so quotes, semicolons and Unicode names round-trip and never break the header.
 * Organization file-column responses retain the legacy token form for names that
 * contain only HTTP token characters; every other name keeps the safe fallback.
 */
export function contentDisposition(disposition, name, { tokenFilename = false } = {}) {
  const value = String(name ?? 'download');
  if (tokenFilename && value.length && !/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(value))
    return `${disposition === 'attachment' ? 'attachment' : 'inline'}; filename=${value}`;
  const fallback = value.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${disposition === 'attachment' ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${rfc5987(value)}`;
}

/**
 * x-ms-file-name header value: the name itself when it is printable ASCII, otherwise its
 * UTF-8 percent-encoding.
 */
// Learn does not say how x-ms-file-name encodes non-ASCII names; percent-encoding is a guess.
export const fileNameHeader = (name) =>
  /^[\x20-\x7e]*$/.test(String(name ?? '')) ? String(name ?? '') : rfc5987(name);

/**
 * Content-Disposition of a web file record (adx_contentdisposition, Learn "Web File"
 * choices): 756150001 is attachment; 756150000 (the form default) or no value is inline.
 */
export function webFileDisposition(metadata = {}) {
  const value = metadata.adx_contentdisposition ?? metadata.mspp_contentdisposition ?? metadata.contentdisposition;
  return Number(value) === 756150001 ? 'attachment' : 'inline';
}

/**
 * Web file response headers as the platform sends them: content type with ";charset=utf-8" on
 * every type, Content-Disposition (the record's inline or attachment) with the RFC 5987
 * attachment file name, an unquoted base64 SHA-256 ETag of the body and Vary: Accept-Encoding,
 * without Last-Modified (observed online). Caching is the platform's by default: public,
 * max-age=3600 with Expires for anonymous and signed-in visitors alike (observed online;
 * Learn describes private caching for signed-in users).
 * settings.webFileCaching "revalidate" is the explicit opt-in to no-cache, so an edited
 * source is fetched again on every reload (still answered 304 while unchanged).
 */
export function webFileHeaders({
  body,
  contentType,
  fileName,
  caching = 'platform',
  disposition = 'inline',
  mimeCharset = 'utf8',
}) {
  const type = String(contentType || 'application/octet-stream');
  const headers = {
    'content-type': mimeCharset === 'source' || /;\s*charset=/i.test(type) ? type : `${type}; charset=utf-8`,
    'content-disposition': `${disposition === 'attachment' ? 'attachment' : 'inline'};filename*=UTF-8''${rfc5987(fileName)}`,
    etag: createHash('sha256').update(body).digest('base64'),
    'cache-control': caching === 'revalidate' ? 'no-cache' : 'public, max-age=3600',
    vary: 'Accept-Encoding',
  };
  if (caching !== 'revalidate') headers.expires = new Date(Date.now() + 3600 * 1000).toUTCString();
  return headers;
}

// The headers of a code site's build files as hosted sites serve them after pac pages upload-code-site (session F5,
// four runs): the type by extension (wasm and webmanifest as application/octet-stream), and public caching with an
// ETag or private caching without one.
const CODE_SITE_FILE_TYPES = {
  '.js': { type: 'application/javascript; charset=utf-8', cache: 'public', compress: true },
  '.css': { type: 'text/css; charset=utf-8', cache: 'public', compress: true },
  '.svg': { type: 'image/svg+xml', cache: 'public' },
  '.png': { type: 'image/png', cache: 'public' },
  '.ico': { type: 'image/x-icon', cache: 'public' },
  '.woff2': { type: 'application/font-woff2', cache: 'public' },
  '.json': { type: 'application/json', cache: 'private', compress: true },
  '.map': { type: 'text/plain', cache: 'private', compress: true },
  '.txt': { type: 'text/plain', cache: 'private', compress: true },
  '.wasm': { type: 'application/octet-stream', cache: 'private' },
  '.webmanifest': { type: 'application/octet-stream', cache: 'private' },
  '.html': { type: 'text/html; charset=utf-8', cache: 'document', compress: true },
};

/**
 * The response headers of a code site's build file, and whether its body is gzip-compressed for a client that accepts
 * it: { headers, compress }. Every file is inline with its RFC 5987 file name. An HTML file is a raw document with the
 * page caching headers; a request that spells the path in another case gets private caching without an ETag. A type
 * outside the captured table keeps the headers of other web files (webFileHeaders with `fallbackType`).
 * `caching: 'revalidate'` (settings.webFileCaching) is the explicit opt-in to no-cache with an ETag, as for other web
 * files.
 */
export function codeSiteFileHeaders({ body, fileName, caseVariant = false, caching = 'platform', fallbackType }) {
  const known = CODE_SITE_FILE_TYPES[path.extname(fileName).toLowerCase()];
  if (!known)
    return { headers: webFileHeaders({ body, contentType: fallbackType, fileName, caching }), compress: false };
  const headers = {
    'content-type': known.type,
    'content-disposition': `inline;filename*=UTF-8''${rfc5987(fileName)}`,
  };
  const etag = () => createHash('sha256').update(body).digest('base64');
  if (known.cache === 'document')
    Object.assign(headers, {
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
      expires: '-1',
    });
  else if (caching === 'revalidate') Object.assign(headers, { 'cache-control': 'no-cache', etag: etag() });
  else {
    const shared = known.cache === 'public' && !caseVariant;
    headers['cache-control'] = `${shared ? 'public' : 'private'}, max-age=3600`;
    headers.expires = new Date(Date.now() + 3600 * 1000).toUTCString();
    if (shared) headers.etag = etag();
  }
  if (known.compress) headers.vary = 'Accept-Encoding';
  return { headers, compress: Boolean(known.compress) };
}

/**
 * Conditional GET: If-None-Match (quoted or unquoted ETag, or *) decides when present;
 * otherwise If-Modified-Since at or after Last-Modified.
 */
export function notModified(requestHeaders, headers) {
  const match = requestHeaders['if-none-match'];
  if (match !== undefined)
    return String(match)
      .split(',')
      .map((tag) => tag.trim().replace(/^W\//, ''))
      .some((tag) => tag === '*' || tag === headers.etag || tag === `"${headers.etag}"`);
  const since = Date.parse(requestHeaders['if-modified-since'] ?? '');
  return Number.isFinite(since) && Date.parse(headers['last-modified']) <= since;
}

/**
 * The headers hosted sites send on every response (session F5: redirects, errors, the token fragment, the about page,
 * web files and pages) that a response of the local portal listener gets when it does not set them itself: the
 * HTTP/Access-Control-* settings verbatim (corsSettingHeaders), the observed HSTS header (http loopback only, as in
 * siteHeaders) and, on a redirect or a response that is not an HTML document, the platform default policy with a fresh
 * nonce and its literal 'inject-hashes'. An HTML document without a policy is one the runtime composed without deciding
 * its scripts' nonces: it keeps the omission that siteHeaders documents.
 */
export function everyResponseHeaders(portal, { status = 200, contentType = '', loopback = true } = {}) {
  const headers = corsSettingHeaders(portal);
  const hsts = portal.observed?.strictTransportSecurity;
  if (hsts && loopback) headers['strict-transport-security'] = hsts;
  const redirect = status >= 300 && status < 400;
  if ((redirect || !/^\s*text\/html\b/i.test(contentType)) && sitePolicy(portal).reason === 'nonce') {
    const policy = siteHeaders(portal, { freshNonce: true, loopback })['content-security-policy'];
    if (policy) headers['content-security-policy'] = policy;
  }
  return headers;
}
