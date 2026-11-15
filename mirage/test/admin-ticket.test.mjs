// @test-kind security: the single-use sign-in ticket that carries the administration console into the portal is a sign-in credential, so its minting, single use, expiry, binding, refusals and trace exclusions are safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { authCookieName } from '../lib/auth-session.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { LOCAL_PROVIDER, simulator } from './support/external-sign-in.mjs';

const LOCAL_ONLY = [['Authentication/Registration/LocalLoginEnabled', 'true']];
const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'document' };
const TICKET_URL = /\/__sim\/session-token\/([A-Za-z0-9_-]{43})$/;
const TRACE_ENDPOINTS = [
  '/__sim/api/logs',
  '/__sim/api/audit/export',
  '/__sim/api/trace/export',
  '/__sim/api/dashboard',
];

async function fixture(t, settings = LOCAL_ONLY, options = {}) {
  const clock = fixedClock(Date.parse('2026-11-12T09:00:00.000Z'));
  const { app, idp } = await simulator(t, settings, undefined, { clock, ...options });
  return { app, clock, idp };
}

// Raw requests keep the exact Sec-Fetch-* and Origin headers a case names; fetch adds or drops some of them.
function send(url, { method = 'GET', headers = {}, body = undefined } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: target.hostname, port: target.port, method, path: target.pathname + target.search, headers },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

const pairOf = (line) => line.split(';')[0];
const setCookieNamed = (response, name) => response.headers['set-cookie']?.find((line) => line.startsWith(`${name}=`));
const bindingName = (app) => `paqvilo-mirage-ticket-${new URL(app.url).port}`;
const sessionName = (app) => authCookieName(new URL(app.url).port);

function mint(app, body, { origin = app.adminOrigin, headers = {} } = {}) {
  return send(`${origin}/__sim/api/session/portal-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf, ...headers },
    body: JSON.stringify(body),
  });
}

async function mintTicket(app, body) {
  const response = await mint(app, body);
  assert.equal(response.status, 200, response.text);
  const ticket = TICKET_URL.exec(JSON.parse(response.text).url)[1];
  return { response, ticket, binding: pairOf(setCookieNamed(response, bindingName(app))) };
}

const consume = (app, ticket, { cookie = null, headers = NAVIGATION } = {}) =>
  send(`${app.url}/__sim/session-token/${ticket}`, { headers: { ...headers, ...(cookie ? { cookie } : {}) } });

function assertTicketInvalid(response) {
  assert.equal(response.status, 403, response.text);
  assert.equal(JSON.parse(response.text).error.code, 'TicketInvalid');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
}

async function signedInSession(app) {
  const { ticket, binding } = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  const response = await consume(app, ticket, { cookie: binding });
  assert.equal(response.status, 302, response.text);
  return pairOf(setCookieNamed(response, sessionName(app)));
}

test('a sign-in ticket is minted for the portal address with a binding cookie that only the portal path receives', async (t) => {
  const { app, clock } = await fixture(t);
  const response = await mint(app, { action: 'sign-in', contactId: 'alex' });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.text);
  assert.match(body.url, TICKET_URL);
  assert.equal(body.url.startsWith(`${app.url}/__sim/session-token/`), true);
  assert.equal(body.expiresAt, clock.now() + 60_000);
  const cookie = setCookieNamed(response, bindingName(app));
  assert.match(
    cookie,
    new RegExp(
      `^${bindingName(app)}=[A-Za-z0-9_-]{43}; Path=/__sim/session-token; HttpOnly; SameSite=Strict; Max-Age=60$`,
    ),
  );
});

test('a ticket consumed as a navigation with its binding cookie signs the browser in and redirects to the administration', async (t) => {
  const { app } = await fixture(t);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  const response = await consume(app, ticket, { cookie: binding });
  assert.equal(response.status, 302, response.text);
  assert.equal(response.headers.location, `${app.adminOrigin}/_sim/#access`);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const cleared = setCookieNamed(response, bindingName(app));
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Path=\/__sim\/session-token/);
  const session = pairOf(setCookieNamed(response, sessionName(app)));
  const who = await send(`${app.adminOrigin}/__sim/api/session`, { headers: { cookie: session } });
  assert.equal(JSON.parse(who.text).contactId, 'alex');
});

test('a consumed ticket is refused on reuse with the uniform TicketInvalid answer', async (t) => {
  const { app } = await fixture(t);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  assert.equal((await consume(app, ticket, { cookie: binding })).status, 302);
  assertTicketInvalid(await consume(app, ticket, { cookie: binding }));
});

test('a ticket is refused after its sixty seconds on the store clock', async (t) => {
  const { app, clock } = await fixture(t);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  clock.advance(60_001);
  assertTicketInvalid(await consume(app, ticket, { cookie: binding }));
});

test('a consume without the binding cookie is refused and burns the ticket', async (t) => {
  const { app } = await fixture(t);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  assertTicketInvalid(await consume(app, ticket));
  assertTicketInvalid(await consume(app, ticket, { cookie: binding }));
});

test('a consume that is not a navigation is refused without consuming the ticket', async (t) => {
  const { app } = await fixture(t);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  const script = { 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' };
  assertTicketInvalid(await consume(app, ticket, { cookie: binding, headers: script }));
  const response = await consume(app, ticket, { cookie: binding });
  assert.equal(response.status, 302, response.text);
  assert.equal(response.headers.location, `${app.adminOrigin}/_sim/#access`);
});

test('a mint with the page token is refused', async (t) => {
  const { app } = await fixture(t);
  const response = await mint(
    app,
    { action: 'sign-in', contactId: 'alex' },
    { headers: { 'x-sim-csrf': app.portalToken } },
  );
  assert.equal(response.status, 403, response.text);
});

test('a browser-shaped mint from the portal listener is refused', async (t) => {
  const { app } = await fixture(t);
  const response = await mint(
    app,
    { action: 'sign-in', contactId: 'alex' },
    {
      origin: app.url,
      headers: { origin: app.url, 'sec-fetch-site': 'same-origin' },
    },
  );
  assert.equal(response.status, 403, response.text);
});

test('a sign-in ticket for an inactive contact is refused with 404', async (t) => {
  const { app } = await fixture(t);
  const response = await mint(app, { action: 'sign-in', contactId: 'carol' });
  assert.equal(response.status, 404, response.text);
  assert.equal(JSON.parse(response.text).error.code, 'PERSONA_CONTACT_UNAVAILABLE');
});

test('a ticket with a malformed return fragment is refused with 400', async (t) => {
  const { app } = await fixture(t);
  const response = await mint(app, { action: 'sign-in', contactId: 'alex', returnHash: '#<access>' });
  assert.equal(response.status, 400, response.text);
  assert.equal(JSON.parse(response.text).error.code, 'InvalidTicketRequest');
});

test('a ticket naming a provider the site does not have is refused with 400', async (t) => {
  const { app } = await fixture(t, LOCAL_PROVIDER);
  const response = await mint(app, { action: 'sign-in', contactId: 'alex', provider: 'no-such-provider' });
  assert.equal(response.status, 400, response.text);
  assert.equal(JSON.parse(response.text).error.code, 'InvalidTicketRequest');
});

test('a local ticket is refused with 409 while local sign-in is off and providers exist', async (t) => {
  const { app } = await fixture(t, LOCAL_PROVIDER);
  const response = await mint(app, { action: 'sign-in', contactId: 'alex', provider: null });
  assert.equal(response.status, 409, response.text);
  assert.equal(JSON.parse(response.text).error.code, 'LocalSignInDisabled');
});

test('a sign-in ticket for an external provider redirects to the identity provider with the contact as login hint', async (t) => {
  const { app, idp } = await fixture(t, LOCAL_PROVIDER);
  const { ticket, binding } = await mintTicket(app, {
    action: 'sign-in',
    contactId: 'alex',
    provider: idp.providers[0].id,
  });
  const response = await consume(app, ticket, { cookie: binding });
  assert.equal(response.status, 302, response.text);
  const authorize = new URL(response.headers.location);
  assert.equal(authorize.origin + authorize.pathname, `${idp.origin}/oidc-local/oauth2/authorize`);
  assert.equal(authorize.searchParams.get('login_hint'), 'alex');
  assert.match(setCookieNamed(response, sessionName(app)), /Path=\/; HttpOnly; SameSite=Lax/);
  assert.match(setCookieNamed(response, bindingName(app)), /Max-Age=0/);
});

test('a sign-out ticket while signed in ends the session through the portal log-off', async (t) => {
  const { app } = await fixture(t);
  const session = await signedInSession(app);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-out' });
  const response = await consume(app, ticket, { cookie: `${binding}; ${session}` });
  assert.equal(response.status, 302, response.text);
  assert.equal(response.headers.location, '/Account/Login/LogOff?returnUrl=%2F_sim%2F%23access');
});

test('a sign-out ticket while anonymous redirects to the administration', async (t) => {
  const { app } = await fixture(t);
  const { ticket, binding } = await mintTicket(app, { action: 'sign-out' });
  const response = await consume(app, ticket, { cookie: binding });
  assert.equal(response.status, 302, response.text);
  assert.equal(response.headers.location, `${app.adminOrigin}/_sim/#access`);
});

test('the ticket value and its binding never reach the logs, exports, dashboard or diagnostics at trace level full', async (t) => {
  const { app } = await fixture(t, LOCAL_ONLY, { trace: { level: 'full' } });
  const first = await mintTicket(app, { action: 'sign-in', contactId: 'alex' });
  assert.equal((await consume(app, first.ticket, { cookie: first.binding })).status, 302);
  const second = await mintTicket(app, { action: 'sign-out' });
  await consume(app, second.ticket, { cookie: second.binding });
  assertTicketInvalid(await consume(app, second.ticket, { cookie: second.binding }));
  const secrets = [first, second].flatMap((item) => [item.ticket, pairOf(item.binding).split('=')[1]]);
  for (const path of [...TRACE_ENDPOINTS, '/__sim/api/diagnostics']) {
    const response = await send(`${app.adminOrigin}${path}`, { headers: { 'x-sim-csrf': app.csrf } });
    assert.equal(response.status, 200, `${path}: ${response.text}`);
    for (const secret of secrets) assert.equal(response.text.includes(secret), false, path);
  }
});
