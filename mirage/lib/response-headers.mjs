import { createHash } from "node:crypto";
import { siteSetting } from "./redirects.mjs";

const lower = (value) => String(value ?? "").trim().toLowerCase();

/**
 * The site's own Content-Security-Policy (HTTP/Content-Security-Policy), unless it is
 * empty, HTTP/Content-Security-Policy/Enabled or /InjectHeader is "false", or it uses
 * a 'nonce' source: per-request nonce injection into rendered scripts is not
 * simulated, so such a policy would block every inline script locally.
 */
export function sitePolicy(portal) {
  const value = String(siteSetting(portal, "HTTP/Content-Security-Policy") ?? "").trim();
  if (!value) return { policy: null, reason: "unset" };
  if (lower(siteSetting(portal, "HTTP/Content-Security-Policy/Enabled")) === "false") return { policy: null, reason: "disabled" };
  if (lower(siteSetting(portal, "HTTP/Content-Security-Policy/InjectHeader")) === "false") return { policy: null, reason: "not-injected" };
  if (/'nonce/i.test(value)) return { policy: null, reason: "nonce" };
  return { policy: value, reason: "site-setting" };
}
/** HTTP/* settings handled separately or not sent by the loopback runtime. */
const SEPARATE = new Set(["content-security-policy", "content-security-policy-report-only", "x-frame-options"]);
// Access-Control-* answer cross-origin requests and are not echoed on loopback;
// Strict-Transport-Security belongs to the HTTPS hosting front end.
const NOT_ECHOED = /^(?:access-control-.*|strict-transport-security)$/;

/**
 * Portal page and web file headers derived only from HTTP/* site settings, one header
 * each, as the platform sends them: every HTTP/<Header-Name> setting with a value
 * (X-Content-Type-Options, Referrer-Policy, Permissions-Policy, ...), X-Frame-Options
 * (default SAMEORIGIN), the site's Content-Security-Policy (sitePolicy) and
 * Content-Security-Policy-Report-Only. Nothing else: no CSP and no X-Content-Type-Options
 * unless the site defines them. Settings with a deeper name (HTTP/Content-Security-Policy/
 * Enabled, HTTP/SameSite/Default) are options, not headers; Access-Control-* and
 * Strict-Transport-Security are not sent. `confinement` (config.confinePortalPages) adds
 * the loopback confinement policy as a separate Content-Security-Policy header. `kind`
 * ("page" or "webFile") adds the headers the site's observed configuration records for
 * that response kind (portal.observed.headers), where no site setting already sets them.
 */
export function siteHeaders(portal, { confinement = null, kind = null } = {}) {
  const headers = {};
  for (const [key, raw] of Object.entries(portal.settings ?? {})) {
    const match = /^http\/([a-z0-9][a-z0-9-]*)$/i.exec(key);
    if (!match) continue;
    const name = match[1].toLowerCase();
    if (SEPARATE.has(name) || NOT_ECHOED.test(name) || Object.hasOwn(headers, name)) continue;
    const value = String((raw && typeof raw === "object" ? raw.value : raw) ?? "").trim();
    if (value && !/[\r\n]/.test(value)) headers[name] = value;
  }
  headers["x-frame-options"] = String(siteSetting(portal, "HTTP/X-Frame-Options") ?? "").trim() || "SAMEORIGIN";
  const policies = [sitePolicy(portal).policy, confinement].filter(Boolean);
  if (policies.length) headers["content-security-policy"] = policies.length === 1 ? policies[0] : policies;
  const reportOnly = String(siteSetting(portal, "HTTP/Content-Security-Policy-Report-Only") ?? "").trim();
  if (reportOnly && !/'nonce/i.test(reportOnly)) headers["content-security-policy-report-only"] = reportOnly;
  for (const [name, value] of Object.entries((kind && portal.observed?.headers?.[kind]) ?? {}))
    if (!Object.hasOwn(headers, name)) headers[name] = value;
  return headers;
}

/**
 * The anti-forgery token fragment (/_layout/tokenhtml) uses page caching and
 * the page's configured site headers (siteHeaders kind "page").
 */
export function tokenHtmlHeaders(portal, { confinement = null } = {}) {
  return { "cache-control": PAGE_CACHE_CONTROL, ...siteHeaders(portal, { confinement, kind: "page" }) };
}

/** HTML page responses: the platform sends no-cache, no-store, must-revalidate. */
export const PAGE_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

const rfc5987 = (value) => encodeURIComponent(String(value)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * Content-Disposition of a web file record (adx_contentdisposition, Learn "Web File"
 * choices): 756150001 is attachment; 756150000 (the form default) or no value is inline.
 */
export function webFileDisposition(metadata = {}) {
  const value = metadata.adx_contentdisposition ?? metadata.mspp_contentdisposition ?? metadata.contentdisposition;
  return Number(value) === 756150001 ? "attachment" : "inline";
}

/**
 * Web file response headers as the platform sends them: content type with ";charset=utf-8" on
 * every type, Content-Disposition (the record's inline or attachment) with the RFC 5987
 * attachment file name, an unquoted base64 SHA-256 ETag of the body and Last-Modified.
 * Caching is the platform's by default: public (anonymous) or private (signed in)
 * max-age=3600 with Expires (Learn: static files are public, max-age one hour).
 * settings.webFileCaching "revalidate" is the explicit opt-in to no-cache, so an edited
 * source is fetched again on every reload (still answered 304 while unchanged).
 */
export function webFileHeaders({ body, contentType, fileName, modified, signedIn = false, caching = "platform", disposition = "inline" }) {
  const type = String(contentType || "application/octet-stream");
  const headers = {
    "content-type": /;\s*charset=/i.test(type) ? type : `${type}; charset=utf-8`,
    "content-disposition": `${disposition === "attachment" ? "attachment" : "inline"};filename*=UTF-8''${rfc5987(fileName)}`,
    etag: createHash("sha256").update(body).digest("base64"),
    "last-modified": new Date(Math.floor(new Date(modified ?? Date.now()).getTime() / 1000) * 1000).toUTCString(),
    "cache-control": caching === "revalidate" ? "no-cache" : `${signedIn ? "private" : "public"}, max-age=3600`,
  };
  if (caching !== "revalidate") headers.expires = new Date(Date.now() + 3600 * 1000).toUTCString();
  return headers;
}

/**
 * Conditional GET: If-None-Match (quoted or unquoted ETag, or *) decides when present;
 * otherwise If-Modified-Since at or after Last-Modified.
 */
export function notModified(requestHeaders, headers) {
  const match = requestHeaders["if-none-match"];
  if (match !== undefined)
    return String(match)
      .split(",")
      .map((tag) => tag.trim().replace(/^W\//, ""))
      .some((tag) => tag === "*" || tag === headers.etag || tag === `"${headers.etag}"`);
  const since = Date.parse(requestHeaders["if-modified-since"] ?? "");
  return Number.isFinite(since) && Date.parse(headers["last-modified"]) <= since;
}
