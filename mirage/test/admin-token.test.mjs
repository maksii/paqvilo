// @test-kind security: the administration token is a separate secret from the page token; page markup never carries it, and page tokens never authorize administration writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { personaFixture } from './fixtures/persona-catalog.mjs';
import { makeFixtureDirectory, startLocalSimulator, writeFixtureFiles } from './support/origin-requests.mjs';

const page = (id, name, partial, parent = 'home') =>
  [
    `adx_webpageid: ${id}`,
    `adx_name: ${name}`,
    `adx_partialurl: ${partial}`,
    ...(parent ? [`adx_parentpageid: ${parent}`] : []),
    'adx_pagetemplateid: main',
  ].join('\n');

const portalFiles = {
  'website.yml': 'adx_name: Token Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': page('home', 'Home', '/', null),
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<h1 id="title">{{ page.title }}</h1>',
  'webrole.yml': '- adx_webroleid: member\n  adx_name: Member',
  'sitesetting.yml': [
    '- adx_sitesettingid: s1\n  adx_name: Webapi/sample_item/enabled\n  adx_value: "true"',
    '- adx_sitesettingid: s2\n  adx_name: Webapi/sample_item/fields\n  adx_value: sample_name',
  ].join('\n'),
};

const initialState = () => ({
  version: 1,
  mappings: {
    contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    sample_item: { entitySet: 'sample_items', idColumn: 'sample_itemid', nameColumn: 'sample_name' },
  },
  tables: {
    contact: [{ contactid: 'alex', fullname: 'Alex Local', statecode: 0 }],
    sample_item: [{ sample_itemid: '11111111-1111-4111-8111-111111111111', sample_name: 'First' }],
  },
  permissions: [
    {
      id: 'items',
      entity: 'sample_item',
      roles: ['Member'],
      scope: 'global',
      operations: ['read', 'create'],
    },
  ],
  settings: { permissionMode: 'enforce' },
  simulator: {
    mode: 'local',
    pageMode: 'local',
    permissionSource: 'configured',
    contactRoles: [{ contactId: 'alex', roleId: 'member' }],
    live: { allowWrites: false },
    endpoints: [],
  },
});

async function simulator(t) {
  const dir = await makeFixtureDirectory(t, 'admin-token-');
  await writeFixtureFiles(dir, portalFiles);
  return startLocalSimulator(t, dir, initialState());
}

// The page token as the portal serves it: the value of the hidden input of /_layout/tokenhtml.
async function servedPageToken(app) {
  const html = await (await fetch(`${app.url}/_layout/tokenhtml`)).text();
  return /value="([0-9a-f]{64})"/.exec(html)?.[1] ?? null;
}

// A browser-shaped request: Fetch Metadata marks it as a same-origin page request.
const browser = (app, target, { cookie, headers = {}, ...init } = {}) =>
  fetch(app.url + target, {
    redirect: 'manual',
    ...init,
    headers: { 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}), ...headers },
  });

async function signedInCookie(app) {
  const response = await browser(app, '/SignIn', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ contactId: 'alex', ReturnUrl: '/' }),
  });
  return response.headers.get('set-cookie')?.split(';')[0] ?? null;
}

test('the page token from the portal markup is refused by administration writes', async (t) => {
  const app = await simulator(t);
  const pageToken = await servedPageToken(app);
  const before = await (await fetch(`${app.url}/_sim/api/trace/settings`)).json();
  const level = before.settings.level;
  const target = level === 'off' ? 'full' : 'off';
  const clear = await fetch(`${app.url}/_sim/api/trace/clear`, {
    method: 'POST',
    headers: { 'x-sim-csrf': pageToken },
  });
  assert.equal(clear.status, 403);
  const put = await fetch(`${app.url}/_sim/api/trace/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain', 'x-sim-csrf': pageToken },
    body: JSON.stringify({ level: target }),
  });
  assert.equal(put.status, 403);
  const after = await (await fetch(`${app.url}/_sim/api/trace/settings`)).json();
  assert.equal(after.settings.level, level);
});

test('the portal exposes its page token as portalToken, separate from the administration token', async (t) => {
  const app = await simulator(t);
  assert.equal(app.portalToken, await servedPageToken(app));
  assert.notEqual(app.portalToken, app.csrf);
});

test('a status request without a token reports the administration token', async (t) => {
  const app = await simulator(t);
  const status = await (await fetch(`${app.url}/_sim/api/status`)).json();
  assert.equal(status.csrf, app.csrf);
});

test('the portal pages, the sign-in page and the token markup never carry the administration token', async (t) => {
  const app = await simulator(t);
  for (const target of ['/', '/SignIn', '/_layout/tokenhtml']) {
    const response = await browser(app, target);
    const body = await response.text();
    assert.equal(body.includes(app.csrf), false, target);
    for (const value of response.headers.values()) assert.equal(value.includes(app.csrf), false, target);
  }
});

// @test-kind contract: the administration token is accepted in the page token's header on a signed-in portal write, as a superset.
test('the administration token as the page verification header authorizes a signed-in portal write', async (t) => {
  const app = await simulator(t);
  const cookie = await signedInCookie(app);
  const response = await browser(app, '/_api/sample_items', {
    cookie,
    method: 'POST',
    headers: { 'content-type': 'application/json', __requestverificationtoken: app.csrf },
    body: JSON.stringify({ sample_name: 'Second' }),
  });
  assert.ok(response.status >= 200 && response.status < 300, `status ${response.status}`);
});

// @test-kind contract: the administration token is accepted in the sign-in form body wherever the page token is.
test('the administration token in the sign-in form body is accepted by the sign-in post', async (t) => {
  const app = await simulator(t);
  const response = await browser(app, '/SignIn', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ contactId: 'alex', ReturnUrl: '/', __RequestVerificationToken: app.csrf }),
  });
  assert.equal(response.status, 302);
});

// @test-kind contract: the administration token is accepted in the persona sign-in form body wherever the page token is.
test('the administration token in the persona sign-in form body is accepted by the persona sign-in post', async (t) => {
  const { app } = await personaFixture(t);
  const response = await browser(app, '/_sim/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ personaKey: 'person-1', ReturnUrl: '/', __RequestVerificationToken: app.csrf }),
  });
  assert.equal(response.status, 302);
});

// @test-kind contract: the administration token in the apps header is normalized to the apps token, so the apps write is not refused on its token.
test('the administration token as the apps verification header is not refused by the apps token check', async (t) => {
  const app = await simulator(t);
  const response = await fetch(`${app.url}/_apps/api/webapi`, {
    method: 'POST',
    headers: { 'x-sim-csrf': app.csrf, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.notEqual(response.status, 403);
});

// @test-kind contract: the administration token is compared exactly on an administration write and each variant is refused as a wrong token.
test('the administration token is compared exactly on an administration write', async (t) => {
  const app = await simulator(t);
  const clear = async (token) => {
    const response = await fetch(`${app.url}/_sim/api/trace/clear`, {
      method: 'POST',
      headers: { 'x-sim-csrf': token },
    });
    return { status: response.status, body: await response.text() };
  };
  assert.equal((await clear(app.csrf)).status, 200);
  const wrong = await clear('wrong-token');
  assert.equal(wrong.status, 403);
  const last = app.csrf.at(-1);
  for (const token of [
    `${app.csrf}x`,
    app.csrf.slice(0, -1),
    `${app.csrf.slice(0, -1)}${last === 'a' ? 'b' : 'a'}`,
    '',
  ]) {
    assert.deepEqual(await clear(token), wrong, token);
  }
});
