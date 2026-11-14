import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

// Admin family: /_sim (before the rewrite to /__sim), /__sim and /_setup, with any subpath.
const ADMIN_FAMILY = /^\/(?:_sim|__sim|_setup)(?:\/|$)/;

const SIM_PREFIX = /^\/_sim(?=\/|$)/;
const PORTAL_DOCUMENTS = /^\/_apps\/portal-documents(?:\/|$)/;
const EVENTS = /^\/__sim\/events$/;
const SIGN_IN = /^\/__sim\/sign-in$/;
const FORM_SUBMIT = /^\/__sim\/forms\/(?:entityform|webform)\/[^/]+\/submit$/;
const FRAME_READY = /^\/__sim\/frame-ready\/[^/]+$/;
const PERSONA_STATIC =
  /^\/__sim\/(?:persona-picker\.css|persona-picker\.mjs|persona-search\.mjs|persona-picker-view\.mjs)$/;
const PERSONAS = /^\/__sim\/api\/personas$/;
const FLOW_INVOKE = /^\/__sim\/api\/flow-triggers\/[^/]+\/triggers\/[^/]+\/paths\/invoke$/;
const SESSION_TICKET = /^\/__sim\/session-token\/[^/]+$/;
const PORTAL_PAGE_PATHS = [SIGN_IN, /^\/__sim\/forms\//, FRAME_READY, /^\/__sim\/session-token\//];
const LOG_CHANNELS = new Set(['logs', 'trace']);
const GET_OR_HEAD = new Set(['GET', 'HEAD']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const SAME_SITE = new Set(['same-origin', 'none']);
const TOKEN_HEADERS = ['x-sim-csrf', '__requestverificationtoken'];
const NO_PACK_ENDPOINTS = () => false;

const MESSAGES = {
  AdminOriginRequired: 'Open the administration on its own address.',
  AppsOriginRequired: 'Open the apps on their own address.',
  PortalOriginRequired: 'Use the portal address for this request.',
  CrossOriginAdminRequest: 'The administration accepts requests only from its own origin.',
  CrossSiteAdminRequest: 'The administration accepts requests only from its own site.',
  CrossOriginAppsRequest: 'The apps accept requests only from their own origin.',
  CrossSiteAppsRequest: 'The apps accept requests only from their own site.',
};

// Route entries are { methods: Set | null (any), test(pathname, url) }.
function pathRoute(methods, pattern) {
  return { methods, test: (pathname) => pattern.test(pathname) };
}

function eventChannelsAllowed(url) {
  const channels = url.searchParams.get('channels');
  if (channels === null) return true;
  return !channels.split(',').some((channel) => LOG_CHANNELS.has(channel.trim()));
}

export const STAFF_SESSION_ROUTE = Object.assign(/^\/__sim\/api\/dataverse\/session\/?$/, {
  methods: new Set(['GET', 'POST', 'DELETE']),
});

const FLOW_INVOKE_ROUTE = pathRoute(null, FLOW_INVOKE);

export const PORTAL_ROUTES = [
  { methods: GET_OR_HEAD, test: (pathname, url) => EVENTS.test(pathname) && eventChannelsAllowed(url) },
  pathRoute(new Set(['POST']), FORM_SUBMIT),
  pathRoute(new Set(['GET', 'HEAD', 'POST']), SIGN_IN),
  pathRoute(new Set(['GET', 'HEAD', 'POST']), FRAME_READY),
  pathRoute(GET_OR_HEAD, PERSONA_STATIC),
  pathRoute(GET_OR_HEAD, PERSONAS),
  FLOW_INVOKE_ROUTE,
  pathRoute(GET_OR_HEAD, SESSION_TICKET),
];

export const STANDALONE_ROUTES = [STAFF_SESSION_ROUTE, FLOW_INVOKE_ROUTE];

function canonicalPath(pathname) {
  return pathname.replace(SIM_PREFIX, '/__sim');
}

export function appsPath(pathname) {
  const path = canonicalPath(pathname);
  if (path === '/main.aspx' || path.startsWith('/api/data/v9.')) return true;
  if (path === '/_apps' || path.startsWith('/_apps/')) return !PORTAL_DOCUMENTS.test(path);
  return STAFF_SESSION_ROUTE.test(path);
}

export function browserRequest(req) {
  return req.headers['sec-fetch-site'] !== undefined || req.headers.origin !== undefined;
}

export function documentNavigation(req) {
  return GET_OR_HEAD.has(req.method) && req.headers['sec-fetch-mode'] === 'navigate';
}

// isPackEndpoint(pathname, method) answers true for a pack endpoint path; a missing callback means no pack endpoints.
// adminServes passes an undefined method, so the callback must answer for every method of that path.
export function adminServes(pathname, isPackEndpoint = NO_PACK_ENDPOINTS) {
  const path = canonicalPath(pathname);
  if (!ADMIN_FAMILY.test(path)) return false;
  if (PORTAL_PAGE_PATHS.some((pattern) => pattern.test(path))) return false;
  return !isPackEndpoint(path, undefined);
}

function refuse(status, code) {
  return { status, code, message: MESSAGES[code] };
}

// A Host header that is not the listener's own address: refused before any path or Origin is judged.
export function hostRefusal() {
  return { status: 403, code: 'INVALID_REQUEST', message: 'Invalid Host header.' };
}

// Location is built by concatenation so that a path such as //host/x stays a path on the listener's own host.
function redirect(origin, url, code) {
  return { ...refuse(302, code), location: `${origin}${url.pathname}${url.search}` };
}

function familyOf(pathname) {
  if (appsPath(pathname)) return 'apps';
  return ADMIN_FAMILY.test(pathname) ? 'admin' : null;
}

function routeAllows(req, url, route) {
  if (route.methods !== null && !route.methods.has(req.method)) return false;
  return route.test(canonicalPath(url.pathname), url);
}

function portalRefusal(req, url, family, { adminOrigin, appsOrigin }) {
  const code = family === 'apps' ? 'AppsOriginRequired' : 'AdminOriginRequired';
  if (!documentNavigation(req)) return refuse(403, code);
  return redirect(family === 'apps' ? appsOrigin : adminOrigin, url, code);
}

// isPackEndpoint(pathname, method) answers true for a pack endpoint path; a missing callback means no pack endpoints.
// The Host header is checked by the server, not here.
export function portalVerdict(
  req,
  url,
  { adminOrigin, appsOrigin = null, routes, isPackEndpoint = NO_PACK_ENDPOINTS },
) {
  if (!browserRequest(req)) return null;
  const family = familyOf(url.pathname);
  if (family === null) return null;
  if (family === 'apps' && appsOrigin === null) return null;
  const path = canonicalPath(url.pathname);
  if (routes.some((route) => routeAllows(req, url, route)) || isPackEndpoint(path, req.method)) return null;
  return portalRefusal(req, url, family, { adminOrigin, appsOrigin });
}

function listenerRefusal(req, origin, kind) {
  const requestOrigin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (requestOrigin !== undefined && requestOrigin !== origin) return refuse(403, `CrossOrigin${kind}Request`);
  if (site === undefined) return null;
  if (!SAME_SITE.has(site) && !documentNavigation(req)) return refuse(403, `CrossSite${kind}Request`);
  if (!SAFE_METHODS.has(req.method) && requestOrigin === undefined) return refuse(403, `CrossOrigin${kind}Request`);
  return null;
}

// serves is a boolean, or a function of the canonical pathname.
function servesPath(serves, pathname) {
  return typeof serves === 'function' ? serves(pathname) : Boolean(serves);
}

export function listenerVerdict(req, url, { origin, fallbackOrigin, serves, kind }) {
  const refused = listenerRefusal(req, origin, kind);
  if (refused !== null) return refused;
  if (servesPath(serves, canonicalPath(url.pathname))) return null;
  if (GET_OR_HEAD.has(req.method)) return redirect(fallbackOrigin, url, 'PortalOriginRequired');
  return refuse(404, 'PortalOriginRequired');
}

// Constant-time comparison; a value that is not a string, or an expected token that is empty or not a string, never matches.
export function sameToken(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const actual = Buffer.from(value);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

// Mutates req.headers. The admin token becomes the page token or the apps token, never reaching a page.
export function normalizeTokenHeaders(req, pathname, { adminToken, pageToken, appsToken }) {
  const path = canonicalPath(pathname);
  if (path.startsWith('/__sim/api/') && !STAFF_SESSION_ROUTE.test(path)) return;
  const replacement = appsPath(path) ? appsToken : pageToken;
  for (const name of TOKEN_HEADERS) {
    if (sameToken(req.headers[name], adminToken)) req.headers[name] = replacement;
  }
}

export function answerVerdict(res, verdict) {
  if (verdict.location !== undefined) {
    res.writeHead(verdict.status, { location: verdict.location, 'cache-control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(verdict.status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify({ error: { code: verdict.code, message: verdict.message } }));
}
