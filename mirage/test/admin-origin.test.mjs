// @test-kind security: the admin and apps listener gate decides which browser-shaped requests reach the administration and the apps, so its verdicts are safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PORTAL_ROUTES,
  STAFF_SESSION_ROUTE,
  STANDALONE_ROUTES,
  adminServes,
  answerVerdict,
  appsPath,
  browserRequest,
  documentNavigation,
  listenerVerdict,
  normalizeTokenHeaders,
  portalVerdict,
  sameToken,
} from '../lib/admin-origin.mjs';

const PORTAL = 'http://127.0.0.1:8080';
const ADMIN = 'http://127.0.0.1:8081';
const APPS = 'http://127.0.0.1:8082';
const SAME = { 'sec-fetch-site': 'same-origin' };
const NAVIGATE = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' };
const NAVIGATE_SAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
const CORS_SAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };
const NO_PACK = () => false;

const TOKENS = { adminToken: 'admin-token-0001', pageToken: 'page-token-0002', appsToken: 'apps-token-0003' };

const PORTAL_OPTIONS = {
  adminOrigin: ADMIN,
  appsOrigin: APPS,
  routes: [...PORTAL_ROUTES, STAFF_SESSION_ROUTE],
  isPackEndpoint: NO_PACK,
};

// Allow-listed rows of section 3, each served to a same-origin browser (the session ticket needs a navigation).
const ALLOW_LIST = [
  ['GET', '/__sim/events', ''],
  ['HEAD', '/__sim/events', '?channels=reload'],
  ['POST', '/__sim/forms/entityform/abc-123/submit', ''],
  ['POST', '/__sim/forms/webform/abc-123/submit', ''],
  ['GET', '/__sim/sign-in', ''],
  ['HEAD', '/__sim/sign-in', ''],
  ['POST', '/__sim/sign-in', ''],
  ['GET', '/__sim/frame-ready/frame-1', ''],
  ['POST', '/__sim/frame-ready/frame-1', '?reason=dom-ready'],
  ['GET', '/__sim/persona-picker.css', ''],
  ['GET', '/__sim/persona-picker.mjs', ''],
  ['GET', '/__sim/persona-search.mjs', ''],
  ['GET', '/__sim/persona-picker-view.mjs', ''],
  ['GET', '/__sim/api/personas', ''],
  ['POST', '/__sim/api/flow-triggers/flow-1/triggers/manual/paths/invoke', ''],
  ['GET', '/__sim/api/dataverse/session', ''],
  ['POST', '/__sim/api/dataverse/session', ''],
  ['DELETE', '/__sim/api/dataverse/session', ''],
];

function request(method, headers = {}) {
  return { method, headers };
}

function portalRequest(method, headers = {}) {
  return request(method, { host: '127.0.0.1:8080', ...headers });
}

function at(path, search = '') {
  return new URL(`http://127.0.0.1:1${path}${search}`);
}

function portalAt(req, path, search = '', options = PORTAL_OPTIONS) {
  return portalVerdict(req, at(path, search), options);
}

function adminListener(serves = true) {
  return { origin: ADMIN, fallbackOrigin: PORTAL, serves, kind: 'Admin' };
}

function appsListener(serves = true) {
  return { origin: APPS, fallbackOrigin: PORTAL, serves, kind: 'Apps' };
}

function refusal(verdict) {
  return verdict === null ? null : { status: verdict.status, code: verdict.code };
}

function fakeResponse() {
  const res = {};
  res.writeHead = (status, headers) => {
    res.status = status;
    res.headers = headers;
  };
  res.end = (body) => {
    res.body = body;
  };
  return res;
}

function normalized(pathname, headerName, value) {
  const req = request('GET', { [headerName]: value });
  normalizeTokenHeaders(req, pathname, TOKENS);
  return req.headers[headerName];
}

test('the admin family is /_sim, /__sim and /_setup with any subpath, matched case-sensitively without decoding', () => {
  for (const path of ['/_sim', '/_sim/x', '/__sim', '/__sim/api/status', '/_setup', '/_setup/x']) {
    assert.equal(adminServes(path), true, path);
  }
  for (const path of ['/__sim-static/x', '/%5Fsim/api/status', '/_SIM/', '/_setupx']) {
    assert.equal(adminServes(path), false, path);
  }
});

test('the browser-shape and navigation predicates read the Fetch metadata headers', () => {
  assert.equal(browserRequest(request('GET', { 'sec-fetch-site': 'none' })), true);
  assert.equal(browserRequest(request('POST', { origin: PORTAL })), true);
  assert.equal(browserRequest(request('GET', { 'sec-fetch-mode': 'cors' })), false);
  assert.equal(documentNavigation(request('GET', NAVIGATE)), true);
  assert.equal(documentNavigation(request('HEAD', NAVIGATE)), true);
  assert.equal(documentNavigation(request('POST', NAVIGATE)), false);
  assert.equal(documentNavigation(request('GET', { 'sec-fetch-mode': 'cors' })), false);
});

test('appsPath covers the apps paths and excludes the portal documents', () => {
  for (const path of [
    '/main.aspx',
    '/_apps',
    '/_apps/x/y',
    '/api/data/v9.2/accounts',
    '/__sim/api/dataverse/session',
  ]) {
    assert.equal(appsPath(path), true, path);
  }
  assert.equal(appsPath('/_sim/api/dataverse/session'), true);
  for (const path of ['/_apps/portal-documents/x', '/_apps/portal-documents', '/__sim/api/config', '/_api/x']) {
    assert.equal(appsPath(path), false, path);
  }
});

test('the staff session route is a route entry whose test accepts the pathname', () => {
  assert.equal(STAFF_SESSION_ROUTE.test('/__sim/api/dataverse/session'), true);
  assert.equal(STAFF_SESSION_ROUTE.test('/__sim/api/dataverse/session/x'), false);
  assert.deepEqual([...STAFF_SESSION_ROUTE.methods].sort(), ['DELETE', 'GET', 'POST']);
});

test('the staff session route accepts exactly one optional trailing slash and nothing wider', () => {
  assert.equal(STAFF_SESSION_ROUTE.test('/__sim/api/dataverse/session/'), true);
  assert.equal(STAFF_SESSION_ROUTE.test('/__sim/api/dataverse/session//'), false);
  assert.equal(appsPath('/__sim/api/dataverse/session/'), true);
  assert.equal(appsPath('/_sim/api/dataverse/session/'), true);
  assert.equal(appsPath('/__sim/api/dataverse/session//'), false);
});

test('normalizeTokenHeaders sends the admin token to the apps token on the staff session with a trailing slash', () => {
  assert.equal(normalized('/__sim/api/dataverse/session/', 'x-sim-csrf', TOKENS.adminToken), TOKENS.appsToken);
  assert.equal(
    normalized('/_sim/api/dataverse/session/', '__requestverificationtoken', TOKENS.adminToken),
    TOKENS.appsToken,
  );
  assert.equal(normalized('/__sim/api/dataverse/session//', 'x-sim-csrf', TOKENS.adminToken), TOKENS.adminToken);
});

test('adminServes excludes the portal pages and pack endpoints from the admin listener', () => {
  assert.equal(adminServes('/__sim/api/status', NO_PACK), true);
  assert.equal(adminServes('/_sim/api/status', NO_PACK), true);
  assert.equal(adminServes('/_setup/x', NO_PACK), true);
  for (const path of [
    '/__sim/sign-in',
    '/__sim/forms/webform/1/submit',
    '/__sim/frame-ready/f',
    '/__sim/session-token/t',
  ]) {
    assert.equal(adminServes(path, NO_PACK), false, path);
  }
  assert.equal(
    adminServes('/__sim/api/packs/ping', (pathname) => pathname === '/__sim/api/packs/ping'),
    false,
  );
  assert.equal(adminServes('/__sim-static/x', NO_PACK), false);
});

test('portal: a mismatched Host header alone produces no verdict from this module', () => {
  const evil = { host: 'evil.example' };
  assert.equal(portalAt(request('GET', evil), '/__sim/api/status'), null);
  assert.equal(portalAt(request('GET', { ...evil, ...SAME }), '/portal/home'), null);
  assert.equal(portalAt(request('GET', { ...evil, ...SAME }), '/__sim/events'), null);
});

test('portal: programmatic requests to the administration and apps are served', () => {
  assert.equal(portalAt(portalRequest('GET'), '/__sim/api/status'), null);
  assert.equal(portalAt(portalRequest('POST'), '/_apps/api/x'), null);
});

test('portal: a path outside both families is served to a browser', () => {
  assert.equal(portalAt(portalRequest('GET', NAVIGATE), '/portal/home'), null);
  assert.equal(portalAt(portalRequest('GET', SAME), '/portal/home'), null);
  assert.equal(portalAt(portalRequest('GET', SAME), '/__sim-static/x'), null);
  assert.equal(portalAt(portalRequest('GET', SAME), '/%5Fsim/api/status'), null);
  assert.equal(portalAt(portalRequest('GET', SAME), '/_SIM/'), null);
});

test('portal: a browser-shaped non-navigation request to the administration is refused', () => {
  assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/__sim/api/status')), {
    status: 403,
    code: 'AdminOriginRequired',
  });
  assert.deepEqual(refusal(portalAt(portalRequest('POST', SAME), '/__sim/api/personas')), {
    status: 403,
    code: 'AdminOriginRequired',
  });
});

test('portal: the pre-rewrite /_sim prefix is treated as the administration', () => {
  assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/_sim/api/status')), {
    status: 403,
    code: 'AdminOriginRequired',
  });
});

test('portal: a navigation to the administration redirects to the admin origin with path and query', () => {
  const verdict = portalAt(portalRequest('GET', NAVIGATE), '/__sim/', '?tab=flows');
  assert.equal(verdict.status, 302);
  assert.equal(verdict.code, 'AdminOriginRequired');
  assert.equal(verdict.location, `${ADMIN}/__sim/?tab=flows`);
});

test('portal: a browser-shaped non-navigation request to an apps path is refused', () => {
  assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/_apps/x')), {
    status: 403,
    code: 'AppsOriginRequired',
  });
});

test('portal: a navigation to an apps path redirects to the apps origin with path and query', () => {
  const verdict = portalAt(portalRequest('GET', NAVIGATE), '/main.aspx', '?id=1');
  assert.equal(verdict.status, 302);
  assert.equal(verdict.code, 'AppsOriginRequired');
  assert.equal(verdict.location, `${APPS}/main.aspx?id=1`);
});

test('portal: apps paths are served to browsers when no apps origin is configured', () => {
  const options = { ...PORTAL_OPTIONS, appsOrigin: null };
  assert.equal(portalAt(portalRequest('GET', NAVIGATE), '/main.aspx', '', options), null);
  assert.equal(portalAt(portalRequest('GET', SAME), '/_apps/x', '', options), null);
});

test('portal: each allow-listed route is served to a same-origin browser', () => {
  for (const [method, path, search] of ALLOW_LIST) {
    assert.equal(portalAt(portalRequest(method, SAME), path, search), null, `${method} ${path}${search}`);
  }
});

test('portal: the session ticket route is served to a navigation and to a cors request, whose refusal the route itself gives', () => {
  assert.equal(portalAt(portalRequest('GET', CORS_SAME), '/__sim/session-token/x'), null);
  assert.equal(portalAt(portalRequest('GET', NAVIGATE_SAME), '/__sim/session-token/x'), null);
});

test('portal: the event stream is refused when its channels include logs or trace', () => {
  for (const search of ['?channels=logs', '?channels=reload,trace', '?channels=reload, logs']) {
    assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/__sim/events', search)), {
      status: 403,
      code: 'AdminOriginRequired',
    });
  }
});

test('portal: writes that are not allow-listed stay refused to a browser', () => {
  assert.deepEqual(refusal(portalAt(portalRequest('POST', SAME), '/__sim/api/personas')), {
    status: 403,
    code: 'AdminOriginRequired',
  });
});

test('portal: the staff session is an apps path on a portal without the route allow-list', () => {
  const options = { ...PORTAL_OPTIONS, routes: PORTAL_ROUTES };
  assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/__sim/api/dataverse/session', '', options)), {
    status: 403,
    code: 'AppsOriginRequired',
  });
});

test('portal: the standalone routes allow only the staff session and the flow invoke', () => {
  const options = { ...PORTAL_OPTIONS, appsOrigin: null, routes: STANDALONE_ROUTES };
  assert.equal(portalAt(portalRequest('GET', SAME), '/__sim/api/dataverse/session', '', options), null);
  const invoke = '/__sim/api/flow-triggers/flow-1/triggers/manual/paths/invoke';
  assert.equal(portalAt(portalRequest('POST', SAME), invoke, '', options), null);
  assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/__sim/sign-in', '', options)), {
    status: 403,
    code: 'AdminOriginRequired',
  });
});

test('portal: a pack endpoint accepted by the callback is served to a same-origin browser', () => {
  const options = {
    ...PORTAL_OPTIONS,
    isPackEndpoint: (pathname, method) => pathname === '/__sim/api/packs/ping' && method === 'POST',
  };
  assert.equal(portalAt(portalRequest('POST', SAME), '/__sim/api/packs/ping', '', options), null);
  assert.deepEqual(refusal(portalAt(portalRequest('GET', SAME), '/__sim/api/packs/ping', '', options)), {
    status: 403,
    code: 'AdminOriginRequired',
  });
});

test('admin listener: a foreign Origin is refused', () => {
  const req = request('GET', { origin: PORTAL, ...SAME });
  assert.deepEqual(refusal(listenerVerdict(req, at('/__sim/api/status'), adminListener())), {
    status: 403,
    code: 'CrossOriginAdminRequest',
  });
});

test('apps listener: a foreign Origin is refused', () => {
  const req = request('GET', { origin: PORTAL, ...SAME });
  assert.deepEqual(refusal(listenerVerdict(req, at('/main.aspx'), appsListener())), {
    status: 403,
    code: 'CrossOriginAppsRequest',
  });
});

test('admin listener: a cross-site non-navigation request is refused', () => {
  const req = request('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' });
  assert.deepEqual(refusal(listenerVerdict(req, at('/__sim/api/status'), adminListener())), {
    status: 403,
    code: 'CrossSiteAdminRequest',
  });
});

test('apps listener: a cross-site non-navigation request is refused', () => {
  const req = request('GET', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' });
  assert.deepEqual(refusal(listenerVerdict(req, at('/main.aspx'), appsListener())), {
    status: 403,
    code: 'CrossSiteAppsRequest',
  });
});

test('admin listener: a navigation to a served document from any site is served', () => {
  assert.equal(listenerVerdict(request('GET', NAVIGATE), at('/__sim/'), adminListener()), null);
});

test('admin listener: a same-site POST without an Origin header is refused', () => {
  const req = request('POST', SAME);
  assert.deepEqual(refusal(listenerVerdict(req, at('/__sim/api/status'), adminListener())), {
    status: 403,
    code: 'CrossOriginAdminRequest',
  });
});

test('admin listener: a same-origin write with the listener Origin is served', () => {
  const req = request('POST', { origin: ADMIN, ...SAME });
  assert.equal(listenerVerdict(req, at('/__sim/api/status'), adminListener()), null);
});

test('admin listener: a programmatic request to a served path is served', () => {
  assert.equal(listenerVerdict(request('POST'), at('/__sim/api/x'), adminListener()), null);
});

test('admin listener: a GET for a path it does not serve redirects to the portal with path and query', () => {
  const verdict = listenerVerdict(request('GET', SAME), at('/__sim/sign-in', '?x=1'), adminListener(false));
  assert.equal(verdict.status, 302);
  assert.equal(verdict.code, 'PortalOriginRequired');
  assert.equal(verdict.location, `${PORTAL}/__sim/sign-in?x=1`);
});

test('apps listener: a HEAD for a path it does not serve redirects to the portal', () => {
  const verdict = listenerVerdict(request('HEAD', SAME), at('/__sim/forms/webform/1/submit'), appsListener(false));
  assert.equal(verdict.status, 302);
  assert.equal(verdict.location, `${PORTAL}/__sim/forms/webform/1/submit`);
});

test('admin listener: a non-GET request for a path it does not serve is answered 404', () => {
  assert.deepEqual(refusal(listenerVerdict(request('POST'), at('/__sim/sign-in'), adminListener(false))), {
    status: 404,
    code: 'PortalOriginRequired',
  });
  const sameOrigin = request('POST', { origin: ADMIN, ...SAME });
  assert.deepEqual(refusal(listenerVerdict(sameOrigin, at('/__sim/sign-in'), adminListener(false))), {
    status: 404,
    code: 'PortalOriginRequired',
  });
});

test('admin listener: a path outside the admin family redirects to the portal without the admin serving it', () => {
  const served = adminServes('/__sim-static/x', NO_PACK);
  const verdict = listenerVerdict(request('GET', SAME), at('/__sim-static/x'), adminListener(served));
  assert.equal(verdict.location, `${PORTAL}/__sim-static/x`);
});

test('admin listener: a redirect keeps a path that starts with two slashes on the portal host', () => {
  const url = new URL('http://127.0.0.1:1/');
  url.pathname = '//evil.example/x';
  const verdict = listenerVerdict(request('GET', SAME), url, adminListener(false));
  assert.equal(verdict.location, `${PORTAL}//evil.example/x`);
});

test('normalizeTokenHeaders sends the admin token to the page token outside the apps and api paths', () => {
  assert.equal(normalized('/_api/x', 'x-sim-csrf', TOKENS.adminToken), TOKENS.pageToken);
  assert.equal(normalized('/_api/x', '__requestverificationtoken', TOKENS.adminToken), TOKENS.pageToken);
});

test('normalizeTokenHeaders sends the admin token to the apps token on apps paths and the staff session', () => {
  assert.equal(normalized('/_apps/api/webapi', 'x-sim-csrf', TOKENS.adminToken), TOKENS.appsToken);
  assert.equal(normalized('/__sim/api/dataverse/session', 'x-sim-csrf', TOKENS.adminToken), TOKENS.appsToken);
  assert.equal(normalized('/_sim/api/dataverse/session', 'x-sim-csrf', TOKENS.adminToken), TOKENS.appsToken);
});

test('normalizeTokenHeaders leaves the admin token unchanged on administration api paths', () => {
  assert.equal(normalized('/__sim/api/config', 'x-sim-csrf', TOKENS.adminToken), TOKENS.adminToken);
  assert.equal(normalized('/_sim/api/config', 'x-sim-csrf', TOKENS.adminToken), TOKENS.adminToken);
});

test('normalizeTokenHeaders leaves a value that is not the admin token unchanged', () => {
  assert.equal(normalized('/_api/x', 'x-sim-csrf', TOKENS.pageToken), TOKENS.pageToken);
  assert.equal(normalized('/_api/x', 'x-sim-csrf', 'other-token-0009'), 'other-token-0009');
});

test('sameToken matches only a non-empty string expected token equal to the value', () => {
  assert.equal(sameToken(TOKENS.adminToken, TOKENS.adminToken), true);
  assert.equal(sameToken('', ''), false);
  assert.equal(sameToken('', undefined), false);
  assert.equal(sameToken(TOKENS.adminToken, ''), false);
  assert.equal(sameToken(TOKENS.adminToken, undefined), false);
  assert.equal(sameToken([TOKENS.adminToken], TOKENS.adminToken), false);
});

test('normalizeTokenHeaders leaves a value of another length unchanged', () => {
  assert.equal(normalized('/_api/x', 'x-sim-csrf', 'admin-token'), 'admin-token');
  assert.equal(normalized('/_api/x', 'x-sim-csrf', 'admin-token-0001-extra'), 'admin-token-0001-extra');
});

test('answerVerdict writes a location verdict as a redirect with no body', () => {
  const res = fakeResponse();
  answerVerdict(res, { status: 302, code: 'PortalOriginRequired', message: 'x', location: `${PORTAL}/x` });
  assert.equal(res.status, 302);
  assert.deepEqual(res.headers, { location: `${PORTAL}/x`, 'cache-control': 'no-store' });
  assert.equal(res.body, undefined);
});

test('answerVerdict writes any other verdict as a JSON error with hardening headers', () => {
  const res = fakeResponse();
  answerVerdict(res, { status: 403, code: 'InvalidHost', message: 'Invalid Host header.' });
  assert.equal(res.status, 403);
  assert.deepEqual(res.headers, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  assert.deepEqual(JSON.parse(res.body), { error: { code: 'InvalidHost', message: 'Invalid Host header.' } });
});

test('listener: serves receives the canonical pathname and its answer decides', () => {
  const seen = [];
  const serves = (pathname) => {
    seen.push(pathname);
    return pathname === '/__sim/api/status';
  };
  assert.equal(listenerVerdict(request('GET', SAME), at('/_sim/api/status'), adminListener(serves)), null);
  assert.equal(listenerVerdict(request('GET', SAME), at('/_sim/x'), adminListener(serves)).status, 302);
  assert.deepEqual(seen, ['/__sim/api/status', '/__sim/x']);
});

test('apps listener: serves can combine the apps path and the staff session route tested with one argument', () => {
  const serves = (pathname) => appsPath(pathname) || STAFF_SESSION_ROUTE.test(pathname);
  assert.equal(listenerVerdict(request('GET', SAME), at('/__sim/api/dataverse/session'), appsListener(serves)), null);
  assert.equal(listenerVerdict(request('GET', SAME), at('/main.aspx'), appsListener(serves)), null);
  assert.equal(listenerVerdict(request('GET', SAME), at('/__sim/api/config'), appsListener(serves)).status, 302);
});

test('adminServes calls the pack callback with the canonical path and an undefined method', () => {
  const calls = [];
  const isPackEndpoint = (...args) => {
    calls.push(args);
    return false;
  };
  assert.equal(adminServes('/_sim/api/status', isPackEndpoint), true);
  assert.deepEqual(calls, [['/__sim/api/status', undefined]]);
});

test('portalVerdict calls the pack callback with the canonical path and the request method', () => {
  const calls = [];
  const isPackEndpoint = (...args) => {
    calls.push(args);
    return false;
  };
  portalAt(portalRequest('POST', SAME), '/_sim/api/packs/ping', '', { ...PORTAL_OPTIONS, isPackEndpoint });
  assert.deepEqual(calls, [['/__sim/api/packs/ping', 'POST']]);
});

test('a missing pack callback means no pack endpoints in either verdict', () => {
  const options = { adminOrigin: ADMIN, appsOrigin: APPS, routes: PORTAL_ROUTES };
  assert.deepEqual(refusal(portalAt(portalRequest('POST', SAME), '/__sim/api/packs/ping', '', options)), {
    status: 403,
    code: 'AdminOriginRequired',
  });
  assert.equal(adminServes('/__sim/api/packs/ping'), true);
});
