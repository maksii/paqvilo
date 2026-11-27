import { siteSetting } from './redirects.mjs';
import { normalizePortalPath } from './importer.mjs';

// Cross-origin reads of authored exported pages (Learn "Set up HTTP headers in Power Pages", the HTTP/Access-Control-*
// settings; the Azure AD B2C custom page layout recipe serves such a page to the B2C origin). Hosted sites that set
// these settings were observed answering their stock root without any Access-Control-* header, so Mirage answers CORS
// only for the authored pages a site lists in observed.corsPages, and only with a literal, credential-free document:
// the page renderer writes the toolkit's request tokens into a page, so a Liquid page is never shared across origins.

const lower = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const setting = (portal, name) => String(siteSetting(portal, `HTTP/Access-Control-${name}`) ?? '').trim();
const list = (value) =>
  String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
/** A serialized origin (scheme://host[:port]) and nothing else, or null. The opaque origin "null" is never one. */
function serializedOrigin(value) {
  const text = String(value ?? '').trim();
  if (!text || text === 'null' || /[\s,]/.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return url.origin === text.replace(/\/$/, '') ? url.origin : null;
}
// The methods this local profile serves: a literal document is read, never written.
const READ_METHODS = ['GET', 'HEAD'];

/**
 * The site's CORS policy from its HTTP/Access-Control-* settings, or { invalid } when it cannot be applied safely:
 * an origin that is not one serialized origin, "*" next to other origins, or "*" with Allow-Credentials true (Fetch
 * forbids a wildcard on a credentialed response; Learn's best practices say not to combine them).
 */
function corsPolicy(portal) {
  const originSetting = setting(portal, 'Allow-Origin');
  if (!originSetting) return { invalid: 'origin-unset' };
  const credentials = setting(portal, 'Allow-Credentials') === 'true';
  const entries = originSetting.split(/[\s,]+/).filter(Boolean);
  const wildcard = entries.includes('*');
  if (wildcard && entries.length > 1) return { invalid: 'origin-setting' };
  if (wildcard && credentials) return { invalid: 'wildcard-credentials' };
  const origins = wildcard ? '*' : entries.map(serializedOrigin);
  if (origins !== '*' && origins.some((origin) => !origin)) return { invalid: 'origin-setting' };
  const methods = setting(portal, 'Allow-Methods');
  const maxAge = setting(portal, 'Max-Age');
  return {
    origins,
    credentials,
    methods: methods ? list(methods).map((method) => method.toUpperCase()) : null,
    headers: list(setting(portal, 'Allow-Headers')).map(lower),
    expose: list(setting(portal, 'Expose-Headers')).filter((name) => /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)),
    maxAge: /^\d{1,9}$/.test(maxAge) ? maxAge : null,
  };
}

/**
 * The page an observed.corsPages path names, with its literal document, or { refusal }. It must be one exported,
 * non-root page whose page template renders a web template without the website header and footer (the B2C recipe),
 * and that web template source must contain no Liquid: Mirage does not render a page for another origin.
 */
function corsPageCandidate(portal, pathname) {
  const key = normalizePortalPath(pathname);
  if (key === '/') return { refusal: 'root' };
  const pages = (portal.pages ?? []).filter((page) => normalizePortalPath(page.url) === key);
  if (pages.length !== 1) return { refusal: pages.length ? 'ambiguous-page' : 'page-not-found' };
  const [page] = pages;
  const template = (portal.pageTemplates ?? []).find((entry) => entry.id && entry.id === page.pageTemplateId);
  if (!template?.webTemplateId || template.rewriteUrl) return { refusal: 'no-web-template' };
  if (template.useHeaderFooter) return { refusal: 'website-header-footer' };
  const source = portal.templates?.[template.webTemplateId]?.source;
  if (typeof source !== 'string' || !source.trim()) return { refusal: 'no-web-template' };
  if (/\{\{|\{%/.test(source)) return { refusal: 'liquid' };
  return { page, source };
}

/** Static diagnostics of observed.corsPages: the pages Mirage shares and the ones it refuses, with the reason. */
export function corsPageDiagnostics(portal) {
  const paths = portal.observed?.corsPages ?? [];
  if (!paths.length) return [];
  const policy = corsPolicy(portal);
  const refused = paths
    .map((path) => ({ path, refusal: policy.invalid ?? corsPageCandidate(portal, path).refusal }))
    .filter((entry) => entry.refusal);
  const diagnostics = [
    {
      code: 'PORTAL_HTTP_CORS_PAGES',
      severity: 'info',
      paths: paths.filter((path) => !refused.some((entry) => entry.path === path)),
      message:
        'The local portal answers cross-origin GET, HEAD and preflight requests of these authored pages with their literal web template source, as the site was observed to share them.',
    },
  ];
  if (refused.length)
    diagnostics.push({
      code: 'PORTAL_HTTP_CORS_PAGE_REFUSED',
      severity: 'warning',
      pages: refused,
      message: 'These observed CORS pages are not shared across origins locally; each entry names the reason.',
    });
  return diagnostics;
}

function requestedHeaders(value) {
  return list(value).map(lower);
}
function grantedOrigin(policy, origin) {
  if (policy.origins === '*') return '*';
  return policy.origins.includes(origin) ? origin : null;
}
function methodAllowed(policy, method) {
  if (!READ_METHODS.includes(method)) return false;
  return policy.methods ? policy.methods.includes(method) : true;
}

/** The conditions of corsDecision, in order: { policy, allowOrigin, candidate } or { refused }. */
function admission(req, url, path, { portal, live = false, privateAdmission = false, readable = () => false }) {
  if (live) return { refused: 'live-mode' };
  if (privateAdmission || portal.observed?.siteVisibility !== 'public') return { refused: 'site-not-public' };
  if (url.search) return { refused: 'query' };
  const origin = typeof req.headers.origin === 'string' ? serializedOrigin(req.headers.origin) : null;
  if (!origin) return { refused: 'origin' };
  const policy = corsPolicy(portal);
  if (policy.invalid) return { refused: policy.invalid };
  const allowOrigin = grantedOrigin(policy, origin);
  if (!allowOrigin) return { refused: 'origin-not-allowed' };
  if (req.headers.cookie || req.headers.authorization) return { refused: 'credentials-sent' };
  const candidate = corsPageCandidate(portal, path);
  if (candidate.refusal) return { refused: candidate.refusal };
  if (!readable(candidate.page)) return { refused: 'page-access' };
  return { policy, allowOrigin, candidate };
}

/**
 * The CORS answer of a cross-origin request (an Origin other than the portal's own), or a refusal reason. Only an
 * observed.corsPages path qualifies, on a site observed public that the runtime does not gate as private, in local
 * mode, for an exact allowed origin, without credentials (cookies or Authorization) and without a query string.
 * `readable(page)` is the anonymous page-access check of the current source.
 */
function corsDecision(req, context) {
  const { portal } = context;
  let url;
  try {
    url = new URL(req.url ?? '/', 'http://local.invalid'); // NOSONAR: reserved placeholder base for parsing a request target, not a transport
  } catch {
    return null;
  }
  const path = (portal.observed?.corsPages ?? []).find((entry) => lower(entry) === lower(url.pathname));
  if (!path) return null;
  const admitted = admission(req, url, path, context);
  if (admitted.refused) return { refused: admitted.refused, path };
  const { policy, allowOrigin, candidate } = admitted;
  const credentials = policy.credentials && allowOrigin !== '*';
  const common = {
    'access-control-allow-origin': allowOrigin,
    ...(credentials ? { 'access-control-allow-credentials': 'true' } : {}),
    'cache-control': 'no-store',
    'x-sim-route': 'exported-page-cors',
  };
  if (req.method === 'OPTIONS') return preflight(req, policy, common, path);
  if (!methodAllowed(policy, req.method)) return { refused: 'method', path };
  const body = Buffer.from(candidate.source, 'utf8');
  return {
    path,
    status: 200,
    headers: {
      ...common,
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(body.length),
      'x-content-type-options': 'nosniff',
      vary: 'Origin',
      ...(policy.expose.length ? { 'access-control-expose-headers': policy.expose.join(', ') } : {}),
    },
    body: req.method === 'HEAD' ? null : body,
  };
}

function preflight(req, policy, common, path) {
  const method = String(req.headers['access-control-request-method'] ?? '').trim();
  if (!method) return { refused: 'not-preflight', path };
  if (!methodAllowed(policy, method)) return { refused: 'method', path };
  // A public origin reading a loopback page asks for private or local network access: never granted.
  if (req.headers['access-control-request-private-network'] || req.headers['access-control-request-local-network'])
    return { refused: 'private-network', path };
  const asked = requestedHeaders(req.headers['access-control-request-headers']);
  const anyHeader = policy.headers.includes('*') && !policy.credentials;
  if (asked.some((name) => !anyHeader && !policy.headers.includes(name))) return { refused: 'headers', path };
  const methods = policy.methods ? READ_METHODS.filter((entry) => policy.methods.includes(entry)) : READ_METHODS;
  return {
    path,
    status: 204,
    headers: {
      ...common,
      'access-control-allow-methods': methods.join(', '),
      ...(asked.length ? { 'access-control-allow-headers': asked.join(', ') } : {}),
      ...(policy.maxAge ? { 'access-control-max-age': policy.maxAge } : {}),
      'content-length': '0',
      vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
    },
    body: null,
  };
}

/**
 * Answer a cross-origin request with corsDecision: true when it was answered. A refusal of an observed CORS page is
 * reported (diagnostic) and returns false, so the caller keeps its ordinary cross-origin refusal. The answer never
 * carries a cookie: a visitor cookie the request pipeline prepared is removed.
 */
export function answerPageCors(req, res, context) {
  const decision = corsDecision(req, context);
  if (!decision) return false;
  if (decision.refused) {
    context.diagnostic?.({
      code: 'PORTAL_HTTP_CORS_REFUSED',
      severity: 'warning',
      path: decision.path,
      reason: decision.refused,
      message: `A cross-origin ${req.method} request of an observed CORS page was refused (${decision.refused}).`,
    });
    return false;
  }
  res.removeHeader('set-cookie');
  res.writeHead(decision.status, decision.headers);
  res.end(decision.body ?? undefined);
  return true;
}
