// @test-kind security: the portal listener refuses browser-shaped requests to the administration family and redirects its navigations, so these refusals, redirects, the allow-list and the header-less compatibility are safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { publicPersonaContext, publicPersonaReport } from '../lib/persona-catalog.mjs';
import { personaFixture } from './fixtures/persona-catalog.mjs';
import {
  emptyLocalState,
  makeFixtureDirectory,
  send,
  startLocalSimulator,
  writeFixtureFiles,
} from './support/origin-requests.mjs';

// A modal form page with one basic form renders the frame-ordering blocker, so the test can take a real id from its markup.
const MODAL_FILES = {
  'website.yml':
    'adx_name: Gate Site\nadx_websiteid: site\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<h1 id="title">{{ page.title }}</h1>',
  'web-templates/Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
  'web-templates/Header.webtemplate.source.html': '<header>Header</header>',
  'web-templates/Footer.webtemplate.yml': 'adx_webtemplateid: footer\nadx_name: Footer',
  'web-templates/Footer.webtemplate.source.html': '<footer>Footer</footer>',
  'basic-forms/Modal.basicform.yml':
    'adx_entityformid: modal-edit\nadx_name: Modal edit\nadx_entityname: contact\nadx_mode: 100000001',
};

async function fixture(t, files = {}) {
  const dir = await makeFixtureDirectory(t, 'admin-origin-gate-');
  await writeFixtureFiles(dir, files);
  return startLocalSimulator(t, dir, emptyLocalState());
}

// An event stream never ends, so the probe reads the status and headers and then closes the connection.
function probe(origin, { target, headers = {} }) {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: url.hostname, port: url.port, method: 'GET', path: target, headers },
      (response) => {
        resolve({ status: response.statusCode, headers: response.headers });
        request.destroy();
      },
    );
    request.on('error', reject);
    request.end();
  });
}

const codeOf = (response) => response.json?.error?.code;
const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' };
const jsonOf = async (url, init = {}) => (await fetch(url, init)).json();

// A page of the portal sends Sec-Fetch-Site: same-origin, and a write also sends its Origin and the admin token from the console.
function pageShaped(app, method) {
  const headers = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-sim-csrf': app.csrf };
  if (method !== 'GET' && method !== 'HEAD') headers.origin = app.url;
  return headers;
}

// Each row is refused on the portal listener with AdminOriginRequired and has no effect.
const REFUSED = [
  ['GET', '/__sim/api/status'],
  ['GET', '/__sim/api/state?summary=1'],
  ['POST', '/__sim/api/trace/clear'],
  ['PUT', '/__sim/api/trace/settings', { level: 'basic' }],
  ['PATCH', '/__sim/api/config', { permissionMode: 'permissive' }],
  ['PATCH', '/__sim/api/operations/operation-1', { mode: 'clr' }],
  ['POST', '/__sim/api/session/sign-in', { contactId: 'alex' }],
  ['POST', '/__sim/api/session/portal-ticket', { action: 'sign-in', contactId: 'alex' }],
  ['POST', '/__sim/api/personas/select', { contactId: 'alex' }],
  ['PUT', '/__sim/api/environment/variables/variable-1', { value: 'value-1' }],
  ['DELETE', '/__sim/api/messages/message-1'],
  ['POST', '/__sim/api/flow-runs', {}],
  ['GET', '/__sim/api/records/contact'],
  ['GET', '/__sim/api/dataverse'],
  ['GET', '/_sim/events?channels=logs'],
  ['GET', '/_setup/api/status'],
  ['POST', '/_setup/api/config', {}],
  ['POST', '/__sim/api/shutdown', {}],
];

// The effect of refused requests: the trace settings, the configuration and the operation modes must not change.
async function effectSnapshot(app) {
  return {
    trace: await jsonOf(`${app.url}/__sim/api/trace/settings`),
    config: await jsonOf(`${app.url}/__sim/api/config`),
    operations: await jsonOf(`${app.url}/__sim/api/operations`),
  };
}

test('page-shaped requests to every listed administration route are refused on the portal listener and change nothing', async (t) => {
  const app = await fixture(t);
  const before = await effectSnapshot(app);
  for (const [method, target, body] of REFUSED) {
    const label = `${method} ${target}`;
    const response = await send(app.url, { method, target, headers: pageShaped(app, method), body });
    assert.equal(response.status, 403, label);
    assert.equal(codeOf(response), 'AdminOriginRequired', label);
  }
  assert.deepEqual(await effectSnapshot(app), before, 'the refused requests changed no state');
  assert.equal((await send(app.url, { target: '/__sim/api/status' })).status, 200, 'the runtime still answers');
});

test('a browser-shaped cross-port write from the administration origin to an administration path is refused by the portal listener', async (t) => {
  const app = await fixture(t);
  const response = await send(app.url, {
    method: 'POST',
    target: '/__sim/api/trace/clear',
    headers: { origin: app.adminOrigin, 'sec-fetch-site': 'same-site', 'x-sim-csrf': app.csrf },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'AdminOriginRequired');
});

test('page navigations to the administration family redirect to the administration origin with the path and query', async (t) => {
  const app = await fixture(t);
  for (const target of ['/_sim/?x=1', '/_setup/', '/__sim/api/status?summary=1']) {
    const response = await send(app.url, { target, headers: navigation });
    assert.equal(response.status, 302, target);
    assert.equal(response.headers.location, `${app.adminOrigin}${target}`, target);
  }
});

test('the allow-list is served to page-shaped requests on the portal listener', async (t) => {
  const app = await fixture(t);
  const token = { __requestverificationtoken: app.portalToken };
  const rows = [
    ['POST', '/__sim/forms/entityform/abc-123/submit', {}],
    ['GET', '/__sim/sign-in'],
    ['POST', '/__sim/sign-in', {}],
    ['GET', '/__sim/frame-ready/frame-1'],
    ['GET', '/__sim/persona-picker.css'],
    ['GET', '/__sim/persona-picker.mjs'],
    ['GET', '/__sim/persona-search.mjs'],
    ['GET', '/__sim/persona-picker-view.mjs'],
    ['GET', '/__sim/api/personas'],
    ['POST', '/__sim/api/flow-triggers/flow-1/triggers/manual/paths/invoke', {}],
    ['GET', '/__sim/api/dataverse/session'],
  ];
  for (const [method, target, body] of rows) {
    const headers = { ...pageShaped(app, method), ...token };
    const response = await send(app.url, { method, target, headers, body });
    assert.notEqual(codeOf(response), 'AdminOriginRequired', `${method} ${target}`);
  }
  assert.equal((await send(app.url, { target: '/__sim/api/personas', headers: pageShaped(app, 'GET') })).status, 200);
  const signIn = await send(app.url, { target: '/__sim/sign-in', headers: pageShaped(app, 'GET') });
  assert.equal(signIn.status, 400, 'the sign-in page is served and asks for its persona');
  assert.match(signIn.text, /The persona parameter is required/);
  const events = await probe(app.url, { target: '/__sim/events', headers: pageShaped(app, 'GET') });
  assert.equal(events.status, 200);
  assert.match(events.headers['content-type'] ?? '', /text\/event-stream/);
});

test('a header-less request to the portal listener is served in full, with the portal csrf in status and state', async (t) => {
  const app = await fixture(t);
  const status = await jsonOf(`${app.url}/__sim/api/status`);
  assert.equal(status.csrf, app.csrf);
  const state = await jsonOf(`${app.url}/__sim/api/state?summary=1`);
  assert.equal(state.csrf, app.csrf);
  const write = await fetch(`${app.url}/__sim/api/trace/clear`, {
    method: 'POST',
    headers: { 'x-sim-csrf': app.csrf },
  });
  assert.equal(write.status, 200);
});

test('the administration URLs name the administration origin', async (t) => {
  const app = await fixture(t);
  assert.ok(app.adminUrl.startsWith(app.adminOrigin), app.adminUrl);
  assert.equal(app.setupUrl, `${app.adminOrigin}/_setup/`);
  const status = await jsonOf(`${app.url}/__sim/api/status`);
  assert.equal(status.adminUrl, `${app.adminOrigin}/_sim/`);
});

test('a rendered page releases its frame-ordering blocker with a page-shaped POST that the portal listener does not refuse', async (t) => {
  const app = await fixture(t, MODAL_FILES);
  const rendered = await send(app.url, {
    target: '/_portal/modal-form-template-path/site?entityformid=modal-edit&id=one',
    headers: navigation,
  });
  assert.equal(rendered.status, 200);
  const route = /src="(\/__sim\/frame-ready\/[^"]+)"/.exec(rendered.text)?.[1];
  assert.ok(route, 'the rendered page carries a frame-ready blocker');
  const release = await send(app.url, {
    method: 'POST',
    target: `${route}?reason=dom-ready`,
    headers: { origin: app.url, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
  });
  assert.notEqual(codeOf(release), 'AdminOriginRequired', 'the gate serves the page release');
  assert.equal(release.status, 204, 'the frame-readiness route releases the pending blocker');
});

const PLAIN_PERSONA = 'person-1';
const CONTEXT_PERSONA = 'person-2';
const BROWSER_PAGE = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

// A form post with the exact headers a case names; fetch cannot send Origin or Sec-Fetch-* headers.
function postForm(origin, target, headers, fields) {
  const url = new URL(origin);
  const payload = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'POST',
        path: target,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(payload),
          ...headers,
        },
      },
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
    request.end(payload);
  });
}

const runtimesOf = async (call) => (await call('/personas')).value.runtimes.items;

test('a browser-shaped portal sign-in for a context persona is refused before a runtime opens or a preset applies', async (t) => {
  const { app, call } = await personaFixture(t);
  const before = await runtimesOf(call);
  const response = await postForm(
    app.url,
    '/__sim/sign-in',
    { origin: app.url, ...BROWSER_PAGE },
    {
      personaKey: CONTEXT_PERSONA,
      ReturnUrl: '/',
      __RequestVerificationToken: app.portalToken,
    },
  );
  assert.equal(response.status, 403);
  assert.match(response.text, /Open the administration on its own address\./);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.deepEqual(await runtimesOf(call), before);
});

test('a browser-shaped portal sign-in form for a context persona is refused the same way', async (t) => {
  const { app, call } = await personaFixture(t);
  const before = await runtimesOf(call);
  const response = await postForm(
    app.url,
    '/SignIn',
    { origin: app.url, ...BROWSER_PAGE },
    {
      personaKey: CONTEXT_PERSONA,
      ReturnUrl: '/',
      __RequestVerificationToken: app.portalToken,
    },
  );
  assert.equal(response.status, 403);
  assert.match(response.text, /Open the administration on its own address\./);
  assert.deepEqual(await runtimesOf(call), before);
});

test('a browser-shaped portal sign-in for a plain persona still signs the browser in', async (t) => {
  const { app } = await personaFixture(t);
  const response = await postForm(
    app.url,
    '/__sim/sign-in',
    { origin: app.url, ...BROWSER_PAGE },
    {
      personaKey: PLAIN_PERSONA,
      ReturnUrl: '/',
      __RequestVerificationToken: app.portalToken,
    },
  );
  assert.equal(response.status, 302);
  assert.ok(response.headers['set-cookie']?.length > 0);
});

test('a programmatic portal sign-in for a context persona still opens its runtime', async (t) => {
  const { app, call } = await personaFixture(t);
  const before = await runtimesOf(call);
  const response = await postForm(
    app.url,
    '/__sim/sign-in',
    {},
    {
      personaKey: CONTEXT_PERSONA,
      ReturnUrl: '/',
      __RequestVerificationToken: app.portalToken,
    },
  );
  assert.equal(response.status, 302);
  assert.notEqual(new URL(response.headers.location).origin, app.url);
  assert.equal((await runtimesOf(call)).length, before.length + 1);
});

test('the picker data marks a context persona as needing the administration without its definition', async (t) => {
  const { app } = await personaFixture(t);
  const picker = await send(app.url, { target: '/__sim/api/personas', headers: pageShaped(app, 'GET') });
  assert.equal(picker.status, 200);
  const byKey = new Map(picker.json.personas.map((persona) => [persona.key, persona]));
  assert.equal(byKey.get(CONTEXT_PERSONA).needsAdministration, true);
  assert.equal(byKey.get(PLAIN_PERSONA).needsAdministration, false);
  assert.doesNotMatch(
    JSON.stringify(byKey.get(CONTEXT_PERSONA)),
    /environmentVariables|deploymentProfile|portalOverrides|Context variable/,
  );
});

test('the portal sign-in page links a context persona to the administration and submits a plain persona', async (t) => {
  const { app } = await personaFixture(t);
  const page = await send(app.url, {
    target: '/SignIn',
    headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none' },
  });
  assert.equal(page.status, 200);
  assert.ok(
    page.text.includes(`href="${app.adminOrigin}/_sim/#access?contact=${CONTEXT_PERSONA}"`),
    'administration link',
  );
  assert.ok(page.text.includes('Open context in the administration'));
  assert.equal(page.text.includes(`name="personaKey" value="${CONTEXT_PERSONA}"`), false);
  assert.ok(page.text.includes(`name="personaKey" value="${PLAIN_PERSONA}"`));
});

// Values that a portal page must never receive: the review context's variable, snippet and setting values.
const MARKERS = {
  variable: 'marker-variable-value-4d1',
  snippet: 'marker-snippet-value-4d1',
  setting: 'marker-setting-value-4d1',
};

// The fixture's review context, with a marker value in its variable, its snippet and its setting.
async function markedContextFixture(t) {
  const fixture = await personaFixture(t);
  const digest = (await fixture.call('/personas')).value.catalogDigest;
  const catalog = structuredClone(fixture.initial.personaCatalog);
  const [context] = catalog.contexts;
  context.environmentVariables = { sample_Url: MARKERS.variable };
  context.portalOverrides = { snippets: { Greeting: MARKERS.snippet }, settings: { 'Feature/Flag': MARKERS.setting } };
  const { response } = await fixture.call('/persona-catalog', 'PUT', { expectedDigest: digest, catalog });
  assert.equal(response.status, 200);
  return fixture;
}

// The review context as the resolved, the effective and the state catalogue of a personas payload each list it.
function reviewContexts(payload) {
  const lists = [payload.contexts, payload.catalog?.contexts, payload.stateCatalog?.contexts];
  assert.ok(lists.every(Array.isArray), 'each of the three catalogues lists its contexts');
  return lists.map((list) => list.find((context) => context.id === 'review'));
}

test('a browser-shaped persona catalogue on the portal listener keeps each context name and drops its values', async (t) => {
  const { app } = await markedContextFixture(t);
  const picker = await send(app.url, { target: '/__sim/api/personas', headers: pageShaped(app, 'GET') });
  assert.equal(picker.status, 200);
  const reviews = reviewContexts(picker.json);
  assert.ok(reviews.every(Boolean), 'the review context is listed in every catalogue');
  for (const context of reviews) {
    assert.deepEqual(context.environmentVariables, { sample_Url: null });
    assert.deepEqual(context.portalOverrides, { snippets: { Greeting: null }, settings: { 'Feature/Flag': null } });
    assert.deepEqual(context.deploymentProfile, { profile: 'test' });
    assert.equal(context.browser, undefined, 'the browser definition is not sent');
  }
  for (const marker of Object.values(MARKERS)) assert.equal(picker.text.includes(marker), false, marker);
});

test('a header-less persona catalogue on the portal listener keeps the context values', async (t) => {
  const { app } = await markedContextFixture(t);
  const plain = await send(app.url, { target: '/__sim/api/personas' });
  assert.equal(plain.status, 200);
  for (const marker of Object.values(MARKERS)) assert.ok(plain.text.includes(marker), marker);
});

test('the administration serves the persona catalogue with its context values to a browser-shaped request', async (t) => {
  const { app } = await markedContextFixture(t);
  const admin = await send(app.adminOrigin, {
    target: '/__sim/api/personas',
    headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'x-sim-csrf': app.csrf },
  });
  assert.equal(admin.status, 200);
  for (const marker of Object.values(MARKERS)) assert.ok(admin.text.includes(marker), marker);
});

test('publicPersonaContext keeps the picker fields and key names, nulls every value and does not mutate its input', () => {
  const context = {
    id: 'review',
    label: 'Review',
    description: 'Desc',
    startPath: '/review',
    order: 3,
    deploymentProfile: { profile: 'test', enabled: { pages: true } },
    environmentVariables: { sample_Url: 'secret-a' },
    portalOverrides: { snippets: { Greeting: 'secret-b' }, settings: { 'Feature/Flag': 'secret-c' } },
    preset: 'preset-1',
    browser: { locale: 'fr-FR' },
    extensions: { note: 'secret-d' },
  };
  assert.deepEqual(publicPersonaContext(context), {
    id: 'review',
    label: 'Review',
    description: 'Desc',
    startPath: '/review',
    deploymentProfile: { profile: 'test' },
    environmentVariables: { sample_Url: null },
    portalOverrides: { snippets: { Greeting: null }, settings: { 'Feature/Flag': null } },
  });
  assert.equal(context.environmentVariables.sample_Url, 'secret-a');
});

test('publicPersonaContext keeps absent fields absent and reports a profile-less deployment as a null profile', () => {
  assert.deepEqual(publicPersonaContext({ id: 'plain', label: 'Plain' }), { id: 'plain', label: 'Plain' });
  assert.deepEqual(
    publicPersonaContext({
      id: 'plain',
      label: 'Plain',
      deploymentProfile: { enabled: { pages: true } },
      portalOverrides: { settings: { A: 'x' } },
    }),
    { id: 'plain', label: 'Plain', deploymentProfile: { profile: null }, portalOverrides: { settings: { A: null } } },
  );
});

test('publicPersonaReport reduces each runtime item to its id and label and does not mutate its input', () => {
  const report = {
    runtimes: { items: [{ id: 'r1', label: 'x', browser: { locale: 'fr-FR' }, origin: 'http://127.0.0.1:1' }] },
  };
  const reduced = publicPersonaReport(report);
  assert.deepEqual(reduced.runtimes.items, [{ id: 'r1', label: 'x' }]);
  assert.deepEqual(report.runtimes.items, [
    { id: 'r1', label: 'x', browser: { locale: 'fr-FR' }, origin: 'http://127.0.0.1:1' },
  ]);
});
