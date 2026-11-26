// @test-kind security: cross-origin reads of authored pages are granted only to an exact allowed origin, without credentials, for observed pages with literal sources
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { answerPageCors, corsPageDiagnostics } from '../lib/page-cors.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// Invented origins on reserved names; the page is an authored layout without the website header and footer.
const ALLOWED = 'https://identity.example.test';
const OTHER = 'https://other.example.test';
const LAYOUT =
  '<!doctype html><html><head><title>Invented layout</title></head><body><div id="api"></div></body></html>';
const OBSERVED = {
  corsPages: ['/custom-layout/', '/liquid-layout/', '/shared-layout/'],
  siteVisibility: 'public',
  evidence: 'Invented observation of an authored page shared across origins',
};

function settingsYaml(settings) {
  return Object.entries(settings)
    .map(([name, value], index) =>
      [
        `- adx_sitesettingid: invented-cors-${index}`,
        `  adx_name: ${name}`,
        `  adx_value: ${JSON.stringify(value)}`,
      ].join('\n'),
    )
    .join('\n');
}

async function host(t, { settings = {}, observed = OBSERVED, options = {} } = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'page-cors-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: 77777777-7777-4777-8777-777777777794\nadx_name: Invented CORS fixture',
    'sitesetting.yml': settingsYaml({
      'HTTP/Access-Control-Allow-Origin': ALLOWED,
      'HTTP/Access-Control-Allow-Methods': 'GET, OPTIONS',
      ...settings,
    }),
    'web-pages/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: shared',
    'web-pages/Custom.webpage.yml':
      'adx_webpageid: custom\nadx_name: Custom layout\nadx_partialurl: custom-layout\nadx_parentpageid: home\nadx_pagetemplateid: layout',
    'web-pages/Liquid.webpage.yml':
      'adx_webpageid: liquid\nadx_name: Liquid layout\nadx_partialurl: liquid-layout\nadx_parentpageid: home\nadx_pagetemplateid: liquid',
    'web-pages/Shared.webpage.yml':
      'adx_webpageid: shared-page\nadx_name: Shared layout\nadx_partialurl: shared-layout\nadx_parentpageid: home\nadx_pagetemplateid: shared',
    'page-templates/Layout.pagetemplate.yml':
      'adx_pagetemplateid: layout\nadx_name: Layout\nadx_webtemplateid: layout\nadx_usewebsiteheaderandfooter: false',
    'page-templates/Liquid.pagetemplate.yml':
      'adx_pagetemplateid: liquid\nadx_name: Liquid\nadx_webtemplateid: liquid\nadx_usewebsiteheaderandfooter: false',
    'page-templates/Shared.pagetemplate.yml':
      'adx_pagetemplateid: shared\nadx_name: Shared\nadx_webtemplateid: layout\nadx_usewebsiteheaderandfooter: true',
    'web-templates/Layout.webtemplate.yml': 'adx_webtemplateid: layout\nadx_name: Layout',
    'web-templates/Layout.webtemplate.source.html': LAYOUT,
    'web-templates/Liquid.webtemplate.yml': 'adx_webtemplateid: liquid\nadx_name: Liquid',
    'web-templates/Liquid.webtemplate.source.html': '<div id="api">{{ page.title }}</div>',
  };
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
  const sim = await createSimulator({ sourceDir: root, watch: false, port: 0, observed, ...options });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

/** answerPageCors with a recording response: { status, headers, body } when answered, else { reason } reported. */
function answer(portal, { origin = ALLOWED, method = 'GET', url = '/custom-layout/', ...context } = {}) {
  const reported = [];
  const res = {
    removeHeader() {},
    writeHead(status, headers) {
      Object.assign(this, { status, headers });
    },
    end(body) {
      this.body = body;
    },
  };
  const answered = answerPageCors({ url, method, headers: { origin } }, res, {
    portal,
    readable: () => true,
    diagnostic: (entry) => reported.push(entry),
    ...context,
  });
  return answered ? res : { reason: reported[0]?.reason };
}

const accessControl = (response) =>
  [...response.headers.keys()].filter((name) => name.startsWith('access-control-')).sort((a, b) => (a < b ? -1 : 1));
const preflight = (sim, pathname, headers = {}) =>
  fetch(sim.url + pathname, {
    method: 'OPTIONS',
    headers: { origin: ALLOWED, 'access-control-request-method': 'GET', ...headers },
  });

test('an allowed origin reads the literal authored page: preflight then GET, without cookies or tokens', async (t) => {
  const sim = await host(t);
  const before = await preflight(sim, '/custom-layout/');
  assert.equal(before.status, 204);
  assert.equal(before.headers.get('access-control-allow-origin'), ALLOWED);
  assert.equal(before.headers.get('access-control-allow-methods'), 'GET');
  assert.equal(before.headers.get('access-control-allow-credentials'), null);
  assert.match(before.headers.get('vary'), /\bOrigin\b/);
  assert.equal(before.headers.get('set-cookie'), null);
  assert.equal(await before.text(), '');

  const page = await fetch(sim.url + '/custom-layout/', { headers: { origin: ALLOWED } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('access-control-allow-origin'), ALLOWED);
  assert.equal(page.headers.get('access-control-allow-credentials'), null);
  assert.equal(page.headers.get('vary'), 'Origin');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('set-cookie'), null);
  const html = await page.text();
  assert.equal(html, LAYOUT);
  assert.doesNotMatch(html, /__portalSimulation|RequestVerificationToken|<script/i);

  // The same page on its own origin keeps the ordinary rendered response without any Access-Control-* header.
  const own = await fetch(sim.url + '/custom-layout/');
  assert.equal(own.status, 200);
  assert.deepEqual(accessControl(own), []);
});

test('origins other than the allowed one are never reflected', async (t) => {
  const sim = await host(t);
  for (const origin of [OTHER, 'null', `${ALLOWED}, ${OTHER}`, `${ALLOWED}/path`, 'http://identity.example.test']) {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const response = await fetch(sim.url + '/custom-layout/', {
        method,
        headers: { origin, 'access-control-request-method': 'GET' },
      });
      assert.equal(response.status, 403, `${method} ${origin}`);
      assert.deepEqual(accessControl(response), [], `${method} ${origin}`);
    }
  }
});

test('the stock root, header-and-footer pages, Liquid pages and unlisted pages are never shared', async (t) => {
  // Consistent with the hosted root, which sent no Access-Control-* header with the settings applied.
  const sim = await host(t);
  for (const pathname of ['/', '/shared-layout/', '/liquid-layout/', '/custom-layout/?q=1', '/custom-layout']) {
    for (const response of [
      await fetch(sim.url + pathname, { headers: { origin: ALLOWED } }),
      await preflight(sim, pathname),
    ]) {
      assert.equal(response.status, 403, pathname);
      assert.deepEqual(accessControl(response), [], pathname);
    }
  }
});

test('preflights are refused for unlisted methods, unlisted headers and private network access', async (t) => {
  const sim = await host(t);
  for (const headers of [
    { 'access-control-request-method': 'POST' },
    { 'access-control-request-method': 'DELETE' },
    { 'access-control-request-method': 'HEAD' },
    { 'access-control-request-headers': 'x-invented' },
    { 'access-control-request-private-network': 'true' },
    { 'access-control-request-method': '' },
  ]) {
    const response = await preflight(sim, '/custom-layout/', headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual(accessControl(response), [], JSON.stringify(headers));
  }
  const head = await fetch(sim.url + '/custom-layout/', { method: 'HEAD', headers: { origin: ALLOWED } });
  assert.equal(head.status, 403, 'HEAD is not in Allow-Methods');
});

test('a wildcard origin is sent as "*" and never combined with credentials', async (t) => {
  const open = await host(t, { settings: { 'HTTP/Access-Control-Allow-Origin': '*' } });
  const response = await fetch(open.url + '/custom-layout/', { headers: { origin: OTHER } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);

  const credentialed = await host(t, {
    settings: { 'HTTP/Access-Control-Allow-Origin': '*', 'HTTP/Access-Control-Allow-Credentials': 'true' },
  });
  for (const refused of [
    await fetch(credentialed.url + '/custom-layout/', { headers: { origin: OTHER } }),
    await preflight(credentialed, '/custom-layout/'),
  ]) {
    assert.equal(refused.status, 403);
    assert.deepEqual(accessControl(refused), []);
  }
  const diagnostics = await (await fetch(credentialed.url + '/_sim/api/diagnostics')).json();
  const refusal = diagnostics.diagnostics.find((entry) => entry.code === 'PORTAL_HTTP_CORS_PAGE_REFUSED');
  assert.ok(refusal.pages.some((entry) => entry.refusal === 'wildcard-credentials'));
});

test('credentials are granted only to the exact origin, and a request that sends credentials is refused', async (t) => {
  const sim = await host(t, {
    settings: {
      'HTTP/Access-Control-Allow-Credentials': 'true',
      'HTTP/Access-Control-Allow-Headers': 'Content-Type',
      'HTTP/Access-Control-Max-Age': '600',
      'HTTP/Access-Control-Expose-Headers': 'X-Invented',
    },
  });
  const ok = await preflight(sim, '/custom-layout/', { 'access-control-request-headers': 'content-type' });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ALLOWED);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(ok.headers.get('access-control-allow-headers'), 'content-type');
  assert.equal(ok.headers.get('access-control-max-age'), '600');
  const page = await fetch(sim.url + '/custom-layout/', { headers: { origin: ALLOWED } });
  assert.equal(page.headers.get('access-control-expose-headers'), 'X-Invented');
  for (const credential of [{ cookie: 'invented=1' }, { authorization: 'Bearer invented' }]) {
    const refused = await fetch(sim.url + '/custom-layout/', { headers: { origin: ALLOWED, ...credential } });
    assert.equal(refused.status, 403);
    assert.deepEqual(accessControl(refused), []);
  }
});

test('without the observation, a private site or live mode, configured CORS settings grant nothing', async (t) => {
  const unobserved = await host(t, { observed: null });
  for (const response of [
    await fetch(unobserved.url + '/custom-layout/', { headers: { origin: ALLOWED } }),
    await preflight(unobserved, '/custom-layout/'),
  ]) {
    assert.equal(response.status, 403);
    assert.deepEqual(accessControl(response), []);
  }
  // The runtime seam the server calls, with a recording response: refusals answer nothing and are reported.
  const portal = {
    observed: { corsPages: ['/custom-layout/'], siteVisibility: 'public' },
    settings: { 'HTTP/Access-Control-Allow-Origin': ALLOWED },
    pages: [{ id: 'p', url: '/custom-layout/', pageTemplateId: 't' }],
    pageTemplates: [{ id: 't', webTemplateId: 'w', useHeaderFooter: false }],
    templates: { w: { source: LAYOUT } },
  };
  assert.deepEqual(answer(portal, { readable: () => true }).status, 200);
  assert.deepEqual(answer(portal, { readable: () => true, live: true }).reason, 'live-mode');
  assert.deepEqual(answer(portal, { readable: () => true, privateAdmission: true }).reason, 'site-not-public');
  assert.deepEqual(answer(portal, { readable: () => false }).reason, 'page-access');
  const privateSite = { ...portal, observed: { ...portal.observed, siteVisibility: 'private' } };
  assert.deepEqual(answer(privateSite, { readable: () => true }).reason, 'site-not-public');
});

test('origin settings are parsed strictly', () => {
  const site = (origin, extra = {}) => ({
    observed: { corsPages: ['/custom-layout/'], siteVisibility: 'public' },
    settings: { 'HTTP/Access-Control-Allow-Origin': origin, ...extra },
    pages: [{ id: 'p', url: '/custom-layout/', pageTemplateId: 't' }],
    pageTemplates: [{ id: 't', webTemplateId: 'w', useHeaderFooter: false }],
    templates: { w: { source: LAYOUT } },
  });
  for (const origin of [ALLOWED, OTHER])
    assert.equal(answer(site(`${ALLOWED}, ${OTHER}`), { origin }).headers['access-control-allow-origin'], origin);
  assert.equal(answer(site(`${ALLOWED}/`)).headers['access-control-allow-origin'], ALLOWED);
  const refusal = (portal) => corsPageDiagnostics(portal).find((entry) => entry.pages)?.pages[0].refusal;
  for (const invalid of [`${ALLOWED}/path`, 'identity.example.test', 'null', `*, ${ALLOWED}`, 'javascript:x']) {
    assert.equal(refusal(site(invalid)), 'origin-setting', invalid);
    assert.equal(answer(site(invalid)).reason, 'origin-setting', invalid);
  }
  assert.equal(refusal(site('*', { 'HTTP/Access-Control-Allow-Credentials': 'true' })), 'wildcard-credentials');
  assert.equal(refusal(site('')), 'origin-unset');
});

// @test-kind contract: observed.corsPages is a validated per-site observation that needs a public site and evidence
test('observed.corsPages requires evidence, a public site and canonical page paths', () => {
  assert.throws(() => observedConfig({ corsPages: ['/a/'], siteVisibility: 'public' }), /evidence/);
  assert.throws(() => observedConfig({ corsPages: ['/a/'], evidence: 'invented capture' }), /siteVisibility public/);
  assert.throws(
    () => observedConfig({ corsPages: ['/a/'], siteVisibility: 'private', evidence: 'invented capture' }),
    /siteVisibility public/,
  );
  for (const invalid of [[], ['/'], ['a/'], ['/a'], ['/a/../b/'], ['/a/?q=1'], ['/a/', '/A/'], [7]])
    assert.throws(
      () => observedConfig({ corsPages: invalid, siteVisibility: 'public', evidence: 'invented capture' }),
      /corsPages/,
      JSON.stringify(invalid),
    );
  assert.deepEqual(
    observedConfig({ corsPages: ['/a/b/'], siteVisibility: 'public', evidence: 'invented capture' }).corsPages,
    ['/a/b/'],
  );
});

// @test-kind contract: the diagnostics name the shared pages and the refused ones with their reason, without origins
test('diagnostics list the shared and refused observed CORS pages', async (t) => {
  const sim = await host(t);
  const { diagnostics } = await (await fetch(sim.url + '/_sim/api/diagnostics')).json();
  const http = diagnostics.filter((entry) => entry.code.startsWith('PORTAL_HTTP_CORS'));
  assert.deepEqual(
    http.map((entry) => entry.code),
    ['PORTAL_HTTP_CORS_PAGES', 'PORTAL_HTTP_CORS_PAGE_REFUSED'],
  );
  assert.deepEqual(http[0].paths, ['/custom-layout/']);
  assert.deepEqual(http[1].pages, [
    { path: '/liquid-layout/', refusal: 'liquid' },
    { path: '/shared-layout/', refusal: 'website-header-footer' },
  ]);
  assert.doesNotMatch(JSON.stringify(http), /example\.test/);
});
