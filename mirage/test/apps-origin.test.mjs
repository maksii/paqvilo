// @test-kind security: the apps listener and the portal's apps gate decide which browser-shaped requests reach the model-driven, canvas and code app paths, so the origin, token and redirect rules are safety guarantees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import {
  emptyLocalState,
  makeFixtureDirectory,
  send,
  startLocalSimulator,
  writeFixtureFiles,
} from './support/origin-requests.mjs';

const FILES = {
  'website.yml':
    'adx_name: Apps Site\nadx_websiteid: site\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<h1 id="title">{{ page.title }}</h1>',
  'web-templates/Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
  'web-templates/Header.webtemplate.source.html': '<header>Header</header>',
  'web-templates/Footer.webtemplate.yml': 'adx_webtemplateid: footer\nadx_name: Footer',
  'web-templates/Footer.webtemplate.source.html': '<footer>Footer</footer>',
};

async function fixture(t) {
  const dir = await makeFixtureDirectory(t, 'apps-origin-');
  await writeFixtureFiles(dir, FILES);
  return startLocalSimulator(t, dir, emptyLocalState());
}

const codeOf = (response) => response.json?.error?.code;
const WHOAMI = { method: 'GET', path: '/api/data/v9.2/WhoAmI' };
const navigation = { 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', 'sec-fetch-dest': 'document' };
const pageShaped = (origin) => ({ origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' });

test('a page-shaped write to an apps path on the portal listener is refused with AppsOriginRequired', async (t) => {
  const app = await fixture(t);
  const response = await send(app.url, {
    method: 'POST',
    target: '/_apps/api/webapi',
    headers: { ...pageShaped(app.url), 'x-sim-csrf': app.portalToken },
    body: WHOAMI,
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'AppsOriginRequired');
});

test('a navigation to an apps path on the portal listener redirects to the apps origin with the path', async (t) => {
  const app = await fixture(t);
  const response = await send(app.url, { target: '/main.aspx?appid=1', headers: navigation });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${app.appsOrigin}/main.aspx?appid=1`);
});

test('the apps listener refuses a request whose Origin is the portal with CrossOriginAppsRequest', async (t) => {
  const app = await fixture(t);
  const response = await send(app.appsOrigin, {
    method: 'POST',
    target: '/_apps/api/webapi',
    headers: { origin: app.url, 'sec-fetch-site': 'cross-site', 'x-sim-csrf': app.appsToken },
    body: WHOAMI,
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'CrossOriginAppsRequest');
});

test('a navigation to a path the apps listener does not serve redirects to the portal', async (t) => {
  const app = await fixture(t);
  const response = await send(app.appsOrigin, { target: '/?x=1', headers: navigation });
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, `${app.url}/?x=1`);
});

test('the apps listener accepts its own page-shaped write with the apps token and no staff cookie', async (t) => {
  const app = await fixture(t);
  const response = await send(app.appsOrigin, {
    method: 'POST',
    target: '/_apps/api/webapi',
    headers: { ...pageShaped(app.appsOrigin), 'x-sim-csrf': app.appsToken },
    body: WHOAMI,
  });
  assert.notEqual(response.status, 403, `status ${response.status}: ${response.text.slice(0, 120)}`);
});

test('the apps token is absent from the portal responses and present in the apps shell', async (t) => {
  const app = await fixture(t);
  assert.match(app.appsToken, /^[0-9a-f]{64}$/, 'the handle exposes a 256-bit apps token');
  const portalResponses = [
    await send(app.url, { target: '/', headers: navigation }),
    await send(app.url, { target: '/main.aspx', headers: navigation }),
    await send(app.url, { target: '/__sim/api/status' }),
    await send(app.url, { target: '/__sim/api/state?summary=1' }),
  ];
  for (const response of portalResponses)
    assert.equal(response.text.includes(app.appsToken), false, `portal ${response.status}`);
  const shell = await send(app.appsOrigin, { target: '/main.aspx', headers: navigation });
  assert.ok(shell.text.includes(app.appsToken), `apps shell status ${shell.status}`);
});

// @test-kind contract: a collection read on the apps listener names that listener's origin in its continuation and context.
test('a collection read on the apps listener names the apps origin in its continuation and context', async (t) => {
  const { sim } = await modelDrivenFixture(t);
  const headers = {
    ...pageShaped(sim.appsOrigin),
    referer: `${sim.appsOrigin}/main.aspx`,
    'x-sim-csrf': sim.appsToken,
    prefer: 'odata.maxpagesize=1',
  };
  const first = await send(sim.appsOrigin, { target: '/api/data/v9.2/x_items', headers });
  assert.equal(first.status, 200, first.text.slice(0, 160));
  const link = first.json['@odata.nextLink'];
  assert.ok(link?.startsWith(`${sim.appsOrigin}/api/data/v9.2/x_items`), `nextLink ${link}`);
  assert.ok(first.json['@odata.context'].startsWith(`${sim.appsOrigin}/`), first.json['@odata.context']);
  const next = new URL(link);
  const second = await send(sim.appsOrigin, { target: next.pathname + next.search, headers });
  assert.equal(second.status, 200, second.text.slice(0, 160));
  assert.equal(second.json.value.length, 1);
  assert.notEqual(second.json.value[0].x_itemid, first.json.value[0].x_itemid);
});

// @test-kind contract: the apps page's table read (the shell's Xrm.WebApi query) names the apps origin in its continuation.
test('a table query on the apps listener names the apps origin in its continuation', async (t) => {
  const { sim } = await modelDrivenFixture(t);
  const headers = {
    ...pageShaped(sim.appsOrigin),
    referer: `${sim.appsOrigin}/main.aspx`,
    'x-sim-csrf': sim.appsToken,
  };
  const tableRead = (options) =>
    send(sim.appsOrigin, {
      target:
        '/_apps/api/tables/x_item?query=' +
        encodeURIComponent(JSON.stringify({ scope: 'odata', options, pageSize: 1 })),
      headers,
    });
  const first = await tableRead('?$select=x_name&$orderby=x_name');
  assert.equal(first.status, 200, first.text.slice(0, 160));
  const link = first.json.nextLink;
  assert.ok(link?.startsWith(`${sim.appsOrigin}/api/data/v9.2/x_items`), `nextLink ${link}`);
  const second = await tableRead(new URL(link).search);
  assert.equal(second.status, 200, second.text.slice(0, 160));
  assert.equal(second.json.entities.length, 1);
  assert.notEqual(second.json.entities[0].x_itemid, first.json.entities[0].x_itemid);
});

// @test-kind contract: the apps page's Web API bridge answers a collection read with the apps origin in its continuation.
test('a collection read through the apps Web API bridge names the apps origin in its continuation', async (t) => {
  const { sim } = await modelDrivenFixture(t);
  const headers = {
    ...pageShaped(sim.appsOrigin),
    referer: `${sim.appsOrigin}/main.aspx`,
    'x-sim-csrf': sim.appsToken,
  };
  const bridge = (path) =>
    send(sim.appsOrigin, {
      method: 'POST',
      target: '/_apps/api/webapi',
      headers,
      body: { method: 'GET', path, headers: { prefer: 'odata.maxpagesize=1' } },
    });
  const first = await bridge('/api/data/v9.2/x_items');
  assert.equal(first.status, 200, first.text.slice(0, 160));
  const page = JSON.parse(first.json.body);
  const link = page['@odata.nextLink'];
  assert.ok(link?.startsWith(`${sim.appsOrigin}/api/data/v9.2/x_items`), `nextLink ${link}`);
  const next = new URL(link);
  const second = await bridge(next.pathname + next.search);
  assert.equal(second.status, 200, second.text.slice(0, 160));
  assert.equal(JSON.parse(second.json.body).value.length, 1);
});

// @test-kind contract: a header-less request on the portal listener keeps the portal origin, as the portal's own links do.
test('a header-less collection read through the portal listener keeps the portal origin in its continuation', async (t) => {
  const { sim } = await modelDrivenFixture(t);
  const response = await send(sim.url, {
    method: 'POST',
    target: '/_apps/api/webapi',
    headers: { 'x-sim-csrf': sim.csrf },
    body: { method: 'GET', path: '/api/data/v9.2/x_items', headers: { prefer: 'odata.maxpagesize=1' } },
  });
  assert.equal(response.status, 200, response.text.slice(0, 160));
  const body = JSON.parse(response.json.body);
  assert.ok(
    body['@odata.nextLink'].startsWith(`${sim.url}/api/data/v9.2/x_items`),
    `nextLink ${body['@odata.nextLink']}`,
  );
});

// @test-kind contract: an entity id returned to the apps listener names the apps origin, as the record's own links do.
test('a create through the apps Web API bridge names the apps origin in its entity id', async (t) => {
  const { sim } = await modelDrivenFixture(t);
  const response = await send(sim.appsOrigin, {
    method: 'POST',
    target: '/_apps/api/webapi',
    headers: { ...pageShaped(sim.appsOrigin), referer: `${sim.appsOrigin}/main.aspx`, 'x-sim-csrf': sim.appsToken },
    body: {
      method: 'POST',
      path: '/api/data/v9.2/x_items',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x_name: 'Created on the apps listener' }),
    },
  });
  assert.equal(response.status, 200, response.text.slice(0, 160));
  assert.equal(response.json.status, 204, response.text.slice(0, 200));
  const entityId = response.json.headers['odata-entityid'];
  assert.ok(entityId?.startsWith(`${sim.appsOrigin}/api/data/v9.2/x_items(`), `OData-EntityId ${entityId}`);
  assert.equal(response.json.headers.location, entityId);
});

test('a header-less write to an apps path on the portal listener is still served with the administration token', async (t) => {
  const app = await fixture(t);
  const response = await send(app.url, {
    method: 'POST',
    target: '/_apps/api/webapi',
    headers: { 'x-sim-csrf': app.csrf },
    body: WHOAMI,
  });
  assert.notEqual(response.status, 403, `status ${response.status}: ${response.text.slice(0, 120)}`);
});

test('the staff session with a trailing slash answers each listener and token as the form without it', async (t) => {
  const app = await fixture(t);
  const listeners = [
    [app.url, {}],
    [app.adminOrigin, pageShaped(app.adminOrigin)],
    [app.appsOrigin, pageShaped(app.appsOrigin)],
  ];
  for (const [origin, browser] of listeners) {
    for (const token of [app.csrf, app.portalToken, app.appsToken]) {
      const headers = { ...browser, 'x-sim-csrf': token };
      const plain = await send(origin, { method: 'DELETE', target: '/__sim/api/dataverse/session', headers });
      const slash = await send(origin, { method: 'DELETE', target: '/__sim/api/dataverse/session/', headers });
      assert.deepEqual(
        { status: slash.status, code: codeOf(slash) },
        { status: plain.status, code: codeOf(plain) },
        origin,
      );
    }
  }
});

test('a foreign Host on a path the apps listener does not serve is refused before any redirect', async (t) => {
  const app = await fixture(t);
  const response = await send(app.appsOrigin, {
    target: '/?x=1',
    headers: { ...navigation, host: 'evil.invalid' },
  });
  assert.equal(response.status, 403);
  assert.equal(codeOf(response), 'INVALID_REQUEST');
  assert.equal(response.json?.error?.message, 'Invalid Host header.');
  assert.equal(response.headers.location, undefined);
});
