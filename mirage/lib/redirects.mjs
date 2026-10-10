import { normalizePortalPath } from "./importer.mjs";

/**
 * Request routing for paths that no exported page or web file resolves, and for
 * pages the current persona may not read. Behaviour follows the platform pipeline
 * described in docs/platform-internals-reference.md sections 1.2-1.6. The local
 * adapter uses these rules, with exported settings and explicit observations:
 *   0. A website language code as the first segment is removed with a 302 (pages,
 *      MultiLanguage/DisplayLanguageCodeInURL not "true"); /{code}/signin is the
 *      sign-in route. The "Knowledge Article" site-marker page also answers its
 *      path without "/" and with {number}/{lang} segments, before redirects.
 *   1. adx_redirect: case-insensitive match of the app-relative path and query with
 *      the inbound URL (a partial inbound URL is relative to "~/"; a trailing "/" on
 *      either path is ignored); status = exported status code, default 302; target =
 *      URL, else web page, else site-marker page; the original query is not appended.
 *   2. Canonical slash: a page URL requested without its trailing "/" -> 301 to the
 *      page URL keeping the query (302 to path + "/" when the page is not readable).
 *   3. URL history (only with settings.urlHistoryRedirects = true): a historic page path -> 301 to the page's current URL.
 *   4. Otherwise the "Page Not Found" site-marker page with 404.
 * Shortcuts have no URL of their own and never resolve a request path.
 */

const lower = (value) => String(value ?? "").toLowerCase();
const appRelative = (pathname) => "~" + (pathname.startsWith("/") ? pathname : "/" + pathname);
const ensureSlash = (url) => (url.endsWith("/") ? url : url + "/");

const withoutSlash = (pathname) => (pathname.length > 2 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname);

/**
 * RFC 3986 escaping with upper-case hex, matching .NET Uri.EscapeDataString.
 * For example, /records/?id=one becomes %2Frecords%2F%3Fid%3Done.
 */
export function escapeDataString(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Site setting value by name (names are case-insensitive). */
export function siteSetting(portal, name) {
  const settings = portal.settings ?? {};
  const key = Object.hasOwn(settings, name) ? name : Object.keys(settings).find((item) => lower(item) === lower(name));
  const value = key === undefined ? undefined : settings[key];
  return value && typeof value === "object" ? value.value : value;
}

const LOGIN_PATH_SETTING = "Authentication/ApplicationCookie/LoginPath";
const sitePath = (value) => /^\/(?!\/)[^?#\s]*$/.test(value);

/**
 * The sign-in path and where it comes from: the exported
 * Authentication/ApplicationCookie/LoginPath setting; else the site's observed sign-in
 * path (applyObserved) with its evidence; else /signin, the documented default (Learn,
 * "Cookie authentication site settings"). Sites without the setting answer /signin or
 * /SignIn online, so that casing is an observation (docs/bootstrap-and-sources.md).
 */
export function signInPath(portal) {
  const configured = String(siteSetting(portal, LOGIN_PATH_SETTING) ?? "").trim();
  if (sitePath(configured)) return { path: configured, source: "site-setting" };
  const observed = portal.observed?.loginPath;
  if (observed && sitePath(observed)) return { path: observed, source: "observed", evidence: portal.observed.evidence ?? null };
  return { path: "/signin", source: "default" };
}

export const loginPath = (portal) => signInPath(portal).path;

/**
 * Attach a site's observed configuration (lib/project-config.mjs observedConfig) to an
 * imported portal as portal.observed. For loginPath an exported LoginPath setting wins
 * and a differing observation is reported.
 */
export function applyObserved(portal, observed) {
  if (!observed || !Object.keys(observed).some((key) => key !== "evidence")) return portal;
  portal.observed = { ...observed };
  if (!observed.loginPath) return portal;
  const configured = String(siteSetting(portal, LOGIN_PATH_SETTING) ?? "").trim();
  const diagnostic = !sitePath(configured)
    ? { code: "LOGIN_PATH_OBSERVED", loginPath: observed.loginPath, evidence: observed.evidence, message: `The export sets no ${LOGIN_PATH_SETTING}; the observed sign-in path ${observed.loginPath} is used (evidence: ${observed.evidence}).` }
    : configured !== observed.loginPath
      ? { code: "LOGIN_PATH_OBSERVED_IGNORED", loginPath: observed.loginPath, configured, evidence: observed.evidence, message: `The export sets ${LOGIN_PATH_SETTING} to ${configured}; the observed sign-in path ${observed.loginPath} (evidence: ${observed.evidence}) is not used.` }
      : null;
  if (diagnostic) (portal.diagnostics ??= []).push(diagnostic);
  return portal;
}

/**
 * The URL of an origin-form request target. A target that starts with "//" is a path whose
 * first segment is empty, never a network-path reference (new URL("//x/y", base) would
 * read "x" as the host).
 */
export function requestTargetUrl(target, base) {
  const value = String(target ?? "/");
  return value.startsWith("/") ? new URL(new URL(base).origin + value) : new URL(value, base);
}

/** Published website languages with a known URL code (default language first). */
const urlLanguages = (portal) =>
  (portal.websiteLanguages ?? [])
    .filter((language) => language.code && language.published !== false)
    .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)));

/**
 * A website language code as the first path segment (case-insensitive). Unless
 * MultiLanguage/DisplayLanguageCodeInURL is "true", GET and HEAD requests are
 * redirected (302, relative Location) to the path without the code, keeping the query;
 * other methods and display-code sites continue with the code removed. This includes
 * the sign-in path: /en-US/signin can redirect again to
 * /signin?ReturnUrl=... Unknown codes are ordinary segments.
 */
export function languageRoute(portal, url, method = "GET") {
  const match = /^\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const language = urlLanguages(portal).find((item) => lower(item.code) === lower(match[1]));
  if (!language) return null;
  const rest = match[2] || "/";
  const display = lower(siteSetting(portal, "MultiLanguage/DisplayLanguageCodeInURL")) === "true";
  if (!display && ["GET", "HEAD"].includes(method))
    return { kind: "redirect", status: 302, location: rest + url.search, source: "language", code: language.code };
  return { kind: "rewrite", pathname: rest, code: language.code };
}

/**
 * Site-marker application route: the "Knowledge Article" page also answers its path
 * without the trailing "/" and followed by {number} and {lang} segments (an MVC area
 * route: case-insensitive and matched before redirects). It takes precedence over
 * an exported redirect with the same path.
 */
export function siteMarkerRoute(portal, url) {
  const page = pageBySiteMarker(portal, "Knowledge Article");
  if (!page || page.url === "/") return null;
  const base = lower(page.url.replace(/\/$/, ""));
  const requested = lower(url.pathname.replace(/\/$/, ""));
  if (requested !== base && !requested.startsWith(base + "/")) return null;
  if (requested.slice(base.length).split("/").filter(Boolean).length > 2) return null;
  return { kind: "render", status: 200, page, source: "site-marker" };
}

function pageBySiteMarker(portal, name) {
  const marker = (portal.siteMarkers ?? []).find((item) => item.name === name);
  return marker ? (portal.pages ?? []).find((page) => page.id === marker.pageId) ?? null : null;
}

/** The exported pages that the platform renders for unknown and forbidden requests. */
export const servicePages = (portal) => ({
  notFound: pageBySiteMarker(portal, "Page Not Found"),
  accessDenied: pageBySiteMarker(portal, "Access Denied"),
  home: pageBySiteMarker(portal, "Home") ?? (portal.pages ?? []).find((page) => page.url === "/") ?? null,
  profile: pageBySiteMarker(portal, "Profile"),
});

const pageByUrl = (portal, url) => {
  const target = lower(ensureSlash(url));
  return (portal.pages ?? []).find((page) => lower(page.url) === target) ?? null;
};

function redirectMatch(portal, url) {
  const requested = lower(withoutSlash(appRelative(url.pathname)) + url.search);
  for (const redirect of portal.redirects ?? []) {
    const inbound = String(redirect.inboundUrl ?? "").trim();
    if (!inbound) continue;
    const relative = inbound.startsWith("~") ? inbound : inbound.startsWith("/") ? "~" + inbound : "~/" + inbound;
    const query = relative.indexOf("?");
    const candidate = lower(query < 0 ? withoutSlash(relative) : withoutSlash(relative.slice(0, query)) + relative.slice(query));
    if (candidate !== requested) continue;
    if (redirect.redirectUrl && redirect.redirectUrl === inbound) return null;
    const status = [301, 302].includes(redirect.statusCode) ? redirect.statusCode : redirect.statusCode ?? 302;
    const page = redirect.webPageId ? (portal.pages ?? []).find((item) => item.id === redirect.webPageId) : null;
    const marker = redirect.siteMarkerId ? (portal.siteMarkers ?? []).find((item) => item.id === redirect.siteMarkerId) : null;
    const markerPage = marker ? (portal.pages ?? []).find((item) => item.id === marker.pageId) : null;
    const location = redirect.redirectUrl || page?.url || markerPage?.url;
    if (!location) continue;
    return {
      kind: "redirect",
      status,
      location,
      source: "redirect",
      id: redirect.id,
      ...(redirect.active === false ? { inactive: true } : {}),
    };
  }
  return null;
}

function canonicalMatch(portal, url, readable) {
  if (url.pathname.endsWith("/")) return null;
  const page = pageByUrl(portal, url.pathname);
  if (!page) return null;
  if (readable && !readable(page))
    return { kind: "redirect", status: 302, location: url.pathname + "/" + url.search, source: "canonical", pageId: page.id };
  return { kind: "redirect", status: 301, location: page.url + url.search, source: "canonical", pageId: page.id };
}

function historyMatch(portal, url) {
  const history = new Map();
  for (const row of [...(portal.urlHistory ?? [])].sort((a, b) => String(b.changedDate ?? "").localeCompare(String(a.changedDate ?? ""))))
    if (row.path && row.webPageId && !history.has(lower(row.path))) history.set(lower(row.path), row);
  const pages = new Map((portal.pages ?? []).map((page) => [page.id, page]));
  const live = (path) => {
    const page = (portal.pages ?? []).find((item) => lower(appRelative(item.url)) === lower(path));
    return page ?? null;
  };
  const home = servicePages(portal).home;
  const find = (path, depth = 0) => {
    if (depth > 32) return null;
    const current = live(path);
    if (current) return { page: current, history: false };
    const row = history.get(lower(path));
    if (row && pages.has(row.webPageId)) return { page: pages.get(row.webPageId), history: true };
    const slash = path.lastIndexOf("/");
    if (slash < 0) return null;
    const before = path.slice(0, slash),
      after = path.slice(slash + 1);
    const parent = ["", "~", "/", "~/"].includes(before) ? (home ? { page: home, history: false } : null) : find(before, depth + 1);
    if (!parent) return null;
    const child = (portal.pages ?? []).find(
      (item) => item.parentId === parent.page.id && lower(item.url.replace(/\/$/, "").split("/").pop()) === lower(after),
    );
    if (child) return { page: child, history: parent.history };
    const rebuilt = appRelative(parent.page.url).replace(/\/?$/, "/") + after;
    if (lower(rebuilt) === lower(path) || lower(appRelative(parent.page.url).replace(/\/$/, "")) === lower(path)) return null;
    const next = find(rebuilt, depth + 1);
    return next ? { page: next.page, history: true } : null;
  };
  const match = find(appRelative(url.pathname));
  return match?.history
    ? { kind: "redirect", status: 301, location: match.page.url, source: "url-history", pageId: match.page.id }
    : null;
}

/**
 * Decide the response for a request that no exported page or web file resolves.
 * `readable(page)` reports whether the current persona may read a page.
 */
export function resolveUnmatchedRoute(portal, url, { readable, urlHistory = false } = {}) {
  const redirect = redirectMatch(portal, url) ?? canonicalMatch(portal, url, readable) ?? (urlHistory ? historyMatch(portal, url) : null);
  if (redirect) return redirect;
  const notFound = servicePages(portal).notFound;
  return notFound
    ? { kind: "render", status: 404, page: notFound, code: "PAGE_NOT_FOUND", message: `No exported page or asset maps to ${url.pathname}.` }
    : { kind: "error", status: 404, code: "UNMAPPED_RESOURCE", message: `No exported page or asset maps to ${url.pathname}.` };
}

/**
 * Outcome for a page or web file the persona may not read: anonymous visitors are
 * redirected (302) to the absolute <origin>/<language code>/signin?ReturnUrl=<path
 * and query, RFC 3986 escaped> with the "Access Denied" page as the response body; signed-in visitors receive the "Access Denied" site-marker page with 403
 * (else Page Not Found with 404).
 */
export function deniedPageRoute(portal, url, identity, access = {}, { origin = "" } = {}) {
  if (access.status === 404) {
    const notFound = servicePages(portal).notFound;
    return notFound
      ? { kind: "render", status: 404, page: notFound, code: access.code, message: access.diagnostics?.[0]?.message }
      : { kind: "error", status: 404, code: access.code, message: access.diagnostics?.[0]?.message ?? "Not found." };
  }
  const authenticated = Boolean(identity?.contactId ?? identity?.id);
  const { accessDenied, notFound } = servicePages(portal);
  if (!authenticated) {
    const code = portal.language?.code ?? urlLanguages(portal)[0]?.code;
    return {
      kind: "redirect",
      status: 302,
      location: `${origin}${code ? "/" + code : ""}${loginPath(portal)}?ReturnUrl=${escapeDataString(url.pathname + url.search)}`,
      source: "sign-in",
      code: access.code,
      ...(accessDenied ? { page: accessDenied } : {}),
    };
  }
  const message = access.diagnostics?.find((d) => d.code === access.code)?.message ?? `Page access denied (${access.code ?? "PAGE_ACCESS_DENIED"}).`;
  if (accessDenied) return { kind: "render", status: 403, page: accessDenied, code: access.code, message };
  if (notFound) return { kind: "render", status: 404, page: notFound, code: access.code, message };
  return { kind: "error", status: 403, code: access.code ?? "PAGE_ACCESS_DENIED", message: access.diagnostics?.[0]?.message ?? "Page access denied." };
}

/** Exported page that resolves a request path (page URLs end with "/"; case-insensitive). */
export function exportedPageFor(portal, pathname) {
  if (!pathname.endsWith("/")) return null;
  return pageByUrl(portal, pathname) ?? (normalizePortalPath(pathname) === "/" ? servicePages(portal).home : null);
}
