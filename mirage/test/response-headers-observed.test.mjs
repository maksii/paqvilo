import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import {
  everyResponseHeaders,
  siteHeaders,
  sitePolicy,
  siteUsesScriptNonce,
  siteHttpPolicyDiagnostics,
  tokenHtmlHeaders,
} from '../lib/response-headers.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const HSTS = 'max-age=31536000; includeSubDomains';
// The default policy as hosted sites without a CSP setting send it (session F5): two spaces before 'unsafe-eval'.
const HOSTED_DEFAULT_PREFIX =
  "script-src 'self' test.content.powerapps.com content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn  'unsafe-eval' ";
const PLATFORM_HASH = "'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM='";
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const portal = (settings, observed) => ({ settings, ...(observed ? { observed } : {}) });

async function host(t, { settings = null, observed }) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'observed-headers-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: 77777777-7777-4777-8777-777777777795\nadx_name: Invented header fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: page',
    'Page.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: content',
    'Content.webtemplate.yml': 'adx_webtemplateid: content\nadx_name: Content',
    'Content.webtemplate.source.html': "<p>Invented page</p><script>window.authored = 'ran';</script>",
  };
  if (settings !== null)
    files['sitesetting.yml'] = Object.entries(settings)
      .map(([name, value], index) =>
        [`- adx_sitesettingid: invented-${index}`, `  adx_name: ${name}`, `  adx_value: ${JSON.stringify(value)}`].join(
          '\n',
        ),
      )
      .join('\n');
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const sim = await createSimulator({ sourceDir: root, watch: false, port: 0, observed });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

// @test-kind compatibility+security: RFC 6797 section 8.1 (a user agent ignores Strict-Transport-Security received over an insecure transport); the observed header is sent only on the http loopback listener
test('the observed HSTS header is sent on http loopback responses only', () => {
  const observed = { strictTransportSecurity: HSTS };
  assert.equal(siteHeaders(portal({}, observed))['strict-transport-security'], HSTS);
  assert.equal(siteHeaders(portal({}, observed), { kind: 'webFile' })['strict-transport-security'], HSTS);
  // A transport other than the http loopback listener (a TLS origin would pin the host for every port) gets no HSTS.
  assert.equal(siteHeaders(portal({}, observed), { loopback: false })['strict-transport-security'], undefined);
  // The exported setting is still not echoed: Learn says the hosted front end's HSTS cannot be modified.
  assert.equal(
    siteHeaders(portal({ 'HTTP/Strict-Transport-Security': 'max-age=1' }))['strict-transport-security'],
    undefined,
  );
  assert.equal(
    siteHeaders(portal({ 'HTTP/Strict-Transport-Security': 'max-age=1' }, observed))['strict-transport-security'],
    HSTS,
  );
});

// @test-kind contract: observed.strictTransportSecurity accepts only an RFC 6797 header value with evidence
test('observed.strictTransportSecurity is validated', () => {
  assert.throws(() => observedConfig({ strictTransportSecurity: HSTS }), /evidence/);
  for (const value of ['max-age=31536000', 'max-age="600"; preload', 'max-age=0', ' max-age=1;includeSubDomains '])
    assert.equal(
      observedConfig({ strictTransportSecurity: value, evidence: 'invented capture' }).strictTransportSecurity,
      value.trim(),
    );
  for (const value of [
    '',
    'includeSubDomains',
    'max-age=1; max-age=2',
    'max-age=abc',
    'max-age=1; includeSubDomains; includeSubDomains',
    'max-age=1\r\nSet-Cookie: x=1',
    'max-age=1; report-uri=x',
    42,
  ])
    assert.throws(
      () => observedConfig({ strictTransportSecurity: value, evidence: 'invented capture' }),
      /strictTransportSecurity/,
      String(value),
    );
});

// @test-kind security: the observed header reaches page responses of the http listener; nothing else of the policy changes
test('a page response carries the observed HSTS header over http', async (t) => {
  const sim = await host(t, { observed: { strictTransportSecurity: HSTS, evidence: 'Invented header capture' } });
  const response = await fetch(sim.url + '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('strict-transport-security'), HSTS);
  assert.equal(new URL(sim.url).protocol, 'http:');
});

// @test-kind compatibility+observation: Learn "Manage your site's Content Security Policy": sites created after November 10, 2025 get CSP by default; clearing the setting's value disables it. The header text is the one two fresh hosted sites sent in session F5 (two runs each, captures http-*-private-1b and http-*-csp-b), which differs from Learn's printed policy
test('the observed platform default policy applies only while the site has no CSP setting', () => {
  const observed = { defaultContentSecurityPolicy: 'platform' };
  // The policy before its 'nonce' expands (the hosted header text is asserted below).
  const PLATFORM_DEFAULT_POLICY =
    "script-src 'self' test.content.powerapps.com content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce'; style-src 'unsafe-inline' https:;";
  assert.deepEqual(sitePolicy(portal({}, observed)), { policy: PLATFORM_DEFAULT_POLICY, reason: 'nonce' });
  assert.equal(siteUsesScriptNonce(portal({}, observed)), true);
  assert.deepEqual(sitePolicy(portal({ 'HTTP/Content-Security-Policy': '' }, observed)), {
    policy: null,
    reason: 'unset',
  });
  assert.deepEqual(sitePolicy(portal({ 'HTTP/Content-Security-Policy': "default-src 'self'" }, observed)), {
    policy: "default-src 'self'",
    reason: 'site-setting',
  });
  assert.equal(sitePolicy(portal({ 'HTTP/Content-Security-Policy/Enabled': 'false' }, observed)).reason, 'disabled');
  assert.deepEqual(sitePolicy(portal({})), { policy: null, reason: 'unset' });
  assert.deepEqual(sitePolicy(portal({}, { defaultContentSecurityPolicy: 'none' })), { policy: null, reason: 'unset' });
  // Without handler hashes (a response that is not a rendered page) 'inject-hashes' stays as it is.
  const headers = siteHeaders(portal({}, observed), { kind: 'page', nonce: 'aW52ZW50ZWQ=' });
  assert.equal(
    headers['content-security-policy'],
    `${HOSTED_DEFAULT_PREFIX}'nonce-aW52ZW50ZWQ=' ${PLATFORM_HASH} 'unsafe-hashes' 'inject-hashes'; style-src 'unsafe-inline' https: 'self';`,
  );
  // A rendered page's handler hashes replace it, each followed by a space, then one more space before ";".
  assert.equal(
    siteHeaders(portal({}, observed), { nonce: 'aW52ZW50ZWQ=', handlerHashes: ['aA==', 'bB=='], loopback: false })[
      'content-security-policy'
    ],
    `${HOSTED_DEFAULT_PREFIX}'nonce-aW52ZW50ZWQ=' ${PLATFORM_HASH} 'unsafe-hashes' 'sha256-aA==' 'sha256-bB=='  ; style-src 'unsafe-inline' https:;`,
  );
  assert.deepEqual(
    siteHttpPolicyDiagnostics(portal({}, observed)).map((entry) => entry.code),
    ['PORTAL_HTTP_CSP_PLATFORM_DEFAULT', 'PORTAL_HTTP_CSP_LOOPBACK_TRANSPORT'],
  );
  assert.throws(() => observedConfig({ defaultContentSecurityPolicy: 'platform' }), /evidence/);
  assert.throws(
    () => observedConfig({ defaultContentSecurityPolicy: 'strict', evidence: 'invented capture' }),
    /defaultContentSecurityPolicy/,
  );
});

// @test-kind security+observation: under the platform default policy the authored inline script carries the response's nonce and every response has its own nonce; the header text, with the page's handler hashes in place of 'inject-hashes', is the one hosted session F5 sent on rendered pages (captures code-site-serve-a..d)
test('a site observed with the platform default policy sends it with a per-response nonce', async (t) => {
  const sim = await host(t, {
    observed: { defaultContentSecurityPolicy: 'platform', evidence: 'Invented header capture' },
  });
  const first = await fetch(sim.url + '/');
  const policy = first.headers.get('content-security-policy');
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, policy);
  // Handler hashes of the platform shell take the place of 'inject-hashes' (Learn: inline event handlers are secured by
  // hash generation).
  assert.match(
    policy,
    new RegExp(
      `^${escape(HOSTED_DEFAULT_PREFIX)}'nonce-[^']+' ${escape(PLATFORM_HASH)} 'unsafe-hashes'(?: 'sha256-[^']+')+  ; style-src 'unsafe-inline' https: 'self';$`,
    ),
  );
  assert.ok((await first.text()).includes(`<script nonce="${nonce}">window.authored = 'ran';`));
  const second = await fetch(sim.url + '/');
  assert.notEqual(/'nonce-([^']+)'/.exec(second.headers.get('content-security-policy'))?.[1], nonce);

  const cleared = await host(t, {
    settings: { 'HTTP/Content-Security-Policy': '' },
    observed: { defaultContentSecurityPolicy: 'platform', evidence: 'Invented header capture' },
  });
  assert.equal((await fetch(cleared.url + '/')).headers.get('content-security-policy'), null);
});

// @test-kind observation: hosted sessions F5 (two fresh sites, two runs each; captures http-*-private-1, http-*-private-1b, http-*-csp-b and code-site-serve-a..d) and F3 (a custom 'nonce' setting, run a, runs/a/csp-custom): redirects, error pages, the token fragment, the about page and web files carry the default policy with a fresh nonce and the literal 'inject-hashes', and HSTS max-age=31536000; includeSubDomains; preload
test('the platform default policy and the observed HSTS header reach every response kind', async (t) => {
  const observed = {
    defaultContentSecurityPolicy: 'platform',
    strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
  };
  const literal = new RegExp(
    `^${escape(HOSTED_DEFAULT_PREFIX)}'nonce-[A-Za-z0-9+/]{43}=' ${escape(PLATFORM_HASH)} 'unsafe-hashes' 'inject-hashes'; style-src 'unsafe-inline' https: 'self';$`,
  );
  const site = portal({}, observed);
  // A redirect and a response that is not an HTML document get it; an HTML document keeps the policy its writer chose.
  for (const [status, contentType] of [
    [302, ''],
    [301, 'text/html; charset=utf-8'],
    [404, 'application/json'],
    [200, 'application/javascript'],
  ]) {
    const headers = everyResponseHeaders(site, { status, contentType });
    assert.match(headers['content-security-policy'], literal, `${status} ${contentType}`);
    assert.equal(headers['strict-transport-security'], observed.strictTransportSecurity);
  }
  assert.equal(
    everyResponseHeaders(site, { status: 200, contentType: 'text/html' })['content-security-policy'],
    undefined,
  );
  const nonces = new Set(
    Array.from({ length: 3 }, () => /'nonce-([^']+)'/.exec(tokenHtmlHeaders(site)['content-security-policy'])[1]),
  );
  assert.equal(nonces.size, 3);
  assert.match(tokenHtmlHeaders(site)['content-security-policy'], literal);
  // A site's own nonce policy reaches them too, expanded the same way (hosted session F3, run a, runs/a/csp-custom).
  const own = portal(
    { 'HTTP/Content-Security-Policy': "script-src 'self' 'nonce' content.powerapps.com; object-src 'none'" },
    observed,
  );
  const custom = new RegExp(
    `^script-src 'self'  'unsafe-eval' 'nonce-[A-Za-z0-9+/]{43}=' ${escape(PLATFORM_HASH)} 'unsafe-hashes' 'inject-hashes' content\\.powerapps\\.com; object-src 'none'$`,
  );
  assert.match(everyResponseHeaders(own, { status: 302 })['content-security-policy'], custom);
  assert.match(tokenHtmlHeaders(own)['content-security-policy'], custom);
  assert.equal(
    everyResponseHeaders(own, { status: 200, contentType: 'text/html' })['content-security-policy'],
    undefined,
  );

  const sim = await host(t, { observed: { ...observed, evidence: 'Invented header capture' } });
  const token = await fetch(sim.url + '/_layout/tokenhtml');
  await token.text();
  assert.match(token.headers.get('content-security-policy'), literal);
  assert.equal(token.headers.get('strict-transport-security'), observed.strictTransportSecurity);
  const redirect = await fetch(sim.url + '/~/', { redirect: 'manual' });
  await redirect.text();
  assert.ok(redirect.status >= 300 && redirect.status < 400, String(redirect.status));
  assert.match(redirect.headers.get('content-security-policy'), literal);
  assert.equal(redirect.headers.get('strict-transport-security'), observed.strictTransportSecurity);
});

// @test-kind observation+security: hosted session F5 (captures cors-private-a, cors-private-b and http-*-cors-control): the six HTTP/Access-Control-* values are sent verbatim on every response whatever the Origin, method, route or status, without Vary: Origin, and a site without them sends none; the loopback origin boundary still refuses every cross-origin request without any site header
test('the CORS settings are fixed headers of every admitted response; cross-origin requests stay refused', async (t) => {
  const allowed = 'https://allowed.example.test';
  const settings = {
    'HTTP/Access-Control-Allow-Origin': allowed,
    'HTTP/Access-Control-Allow-Methods': 'GET,POST',
    'HTTP/Access-Control-Allow-Headers': 'x-invented-request',
    'HTTP/Access-Control-Allow-Credentials': 'true',
    'HTTP/Access-Control-Expose-Headers': 'x-invented-expose',
    'HTTP/Access-Control-Max-Age': '600',
  };
  const expected = Object.fromEntries(
    Object.entries(settings).map(([name, value]) => [name.slice('HTTP/'.length).toLowerCase(), value]),
  );
  const sim = await host(t, { settings, observed: null });
  const cors = (response) =>
    Object.fromEntries([...response.headers].filter(([name]) => name.startsWith('access-control-')));
  // OPTIONS is no preflight: the route answers it as any other method (the token fragment answers only GET).
  for (const [method, target, status] of [
    ['GET', '/', 200],
    ['HEAD', '/', 200],
    ['GET', '/no-such-page/', 404],
    ['GET', '/_layout/tokenhtml', 200],
    ['HEAD', '/_layout/tokenhtml', 404],
    ['POST', '/_layout/tokenhtml', 404],
    ['OPTIONS', '/_layout/tokenhtml', 404],
    ['GET', '/~/', 302],
  ]) {
    const response = await fetch(sim.url + target, { method, redirect: 'manual' });
    await response.arrayBuffer();
    assert.equal(response.status, status, `${method} ${target}`);
    assert.deepEqual(cors(response), expected, `${method} ${target} ${response.status}`);
    assert.doesNotMatch(response.headers.get('vary') ?? '', /origin/i, `${method} ${target}`);
  }
  // A same-origin request may name its own origin.
  const own = await fetch(sim.url + '/', { headers: { origin: new URL(sim.url).origin } });
  await own.text();
  assert.equal(own.headers.get('access-control-allow-origin'), allowed);
  // The allowed origin itself, a preflight and another origin: all refused at the boundary, with no CORS header.
  for (const [method, headers] of [
    ['GET', { origin: allowed }],
    ['OPTIONS', { origin: allowed, 'access-control-request-method': 'GET' }],
    ['GET', { origin: 'https://other.example.test' }],
  ]) {
    const refused = await fetch(sim.url + '/', { method, headers });
    await refused.arrayBuffer();
    assert.equal(refused.status, 403, `${method} ${headers.origin}`);
    assert.deepEqual(cors(refused), {});
  }
  const plain = await host(t, { observed: null });
  const response = await fetch(plain.url + '/');
  await response.text();
  assert.deepEqual(cors(response), {});
});

// @test-kind observation: hosted session F3 (two runs, captures runs/a/csp-base and runs/b/csp-base) listed a rendered page's handler hashes in two groups, the platform shell's and then the page's own (a template handler and a record-written one), each hash followed by a space and each group by one more; the header below is the captured text with its nonce replaced
test('handler hash groups are written as hosted pages write them', () => {
  const NONCE = 'aW52ZW50ZWQ=';
  const shell = [
    'CHeyxkbcsDKUzxZy31PlMBX/9yJzqTulsO86EmrxnGw=',
    'IYUyHDoWaaTG/u7mo4A3bVD5/fI1DWghTTr1stteBfs=',
    'pUcypIphN89NnepkeTTsgLac6afY3ziveZCHN8exmqA=',
    'rFIPWGr1IAOf/BC530dP5a5KVAuO20hs+rRcAyQBbBg=',
    'WqJ6Pb6f9BAHzP7ZOgf64OozQoz5dplou3lboXfG7n4=',
    'w1hqWQqwl8NnPwsaVYIgwHd4c4P7kVxR/ZZHMWoekhk=',
    'OplbuhVsZnmauI75H3fc0cAh/lgNpvVISAMULlHWou0=',
    'Vbw6lNMMo1pVxeHnt0+N1cw5Pz1neU2ssc9Mv+TSjYQ=',
    'jF+3D0cJnzpGrBZVS4cYGgIiscjA3w+nypCy6Xrunx8=',
    'JnE6BvxewHrhfwe4g3syQUiFzJEI5csOqK5s/NqBEaU=',
    'E9BtAYT6iWPEiV1NcpG3z6q4sVVSf9+KrvtbbtmIXXo=',
    'FqJE9sWp26XNmvBLewiptRb+QId/1scvWIfn135YthI=',
    'nl/JxyXksdmPQPaEWYTRfth4zCmVRP3LJql5TSh5vPQ=',
    'McHbvLRquLFbwQW/kxt+0vScSa6Mqn7IPc9IKcuRfPo=',
    'p+EoRX3LHZdX7/7xnxLYWeakctAnf+E7QHkAfWW77+k=',
    'pEvu5hGFqO3E3oCsUESNdz6+xCSIxrNxGIBmrdh8ICM=',
    'JZVTAmHr/JsXDAuxICqVoJB+ubCtQ3Ti0cX9S2kme1U=',
    '38D1/HE98yVLPbmgdwn68+Z+Q0ANbQ4arWNEdaKi8D0=',
    'SUIDOKSuFy4tj/CL6f42LWHhi0c6QqKlxxcLDwBYn/g=',
    'wuNtnp867jrNYu5fymBZDEkgXN2sybtPTQo3SZROC2Y=',
    '9Mln+8Jd32zS1gGhUMbCFX247FU54C+kZTEMQ4x0SYs=',
  ];
  const page = ['Sm+Vf1vWnC08pf6u3qIhns/vOHhqZhc8EhmtU6OD9sU=', 'MSZDXDvAgX6b48YllUw1jjXa9ewO9kR3MUicWggnBp4='];
  const captured = `script-src 'self' test.content.powerapps.com content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn  'unsafe-eval' 'nonce-${NONCE}' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'sha256-CHeyxkbcsDKUzxZy31PlMBX/9yJzqTulsO86EmrxnGw=' 'sha256-IYUyHDoWaaTG/u7mo4A3bVD5/fI1DWghTTr1stteBfs=' 'sha256-pUcypIphN89NnepkeTTsgLac6afY3ziveZCHN8exmqA=' 'sha256-rFIPWGr1IAOf/BC530dP5a5KVAuO20hs+rRcAyQBbBg=' 'sha256-WqJ6Pb6f9BAHzP7ZOgf64OozQoz5dplou3lboXfG7n4=' 'sha256-w1hqWQqwl8NnPwsaVYIgwHd4c4P7kVxR/ZZHMWoekhk=' 'sha256-OplbuhVsZnmauI75H3fc0cAh/lgNpvVISAMULlHWou0=' 'sha256-Vbw6lNMMo1pVxeHnt0+N1cw5Pz1neU2ssc9Mv+TSjYQ=' 'sha256-jF+3D0cJnzpGrBZVS4cYGgIiscjA3w+nypCy6Xrunx8=' 'sha256-JnE6BvxewHrhfwe4g3syQUiFzJEI5csOqK5s/NqBEaU=' 'sha256-E9BtAYT6iWPEiV1NcpG3z6q4sVVSf9+KrvtbbtmIXXo=' 'sha256-FqJE9sWp26XNmvBLewiptRb+QId/1scvWIfn135YthI=' 'sha256-nl/JxyXksdmPQPaEWYTRfth4zCmVRP3LJql5TSh5vPQ=' 'sha256-McHbvLRquLFbwQW/kxt+0vScSa6Mqn7IPc9IKcuRfPo=' 'sha256-p+EoRX3LHZdX7/7xnxLYWeakctAnf+E7QHkAfWW77+k=' 'sha256-pEvu5hGFqO3E3oCsUESNdz6+xCSIxrNxGIBmrdh8ICM=' 'sha256-JZVTAmHr/JsXDAuxICqVoJB+ubCtQ3Ti0cX9S2kme1U=' 'sha256-38D1/HE98yVLPbmgdwn68+Z+Q0ANbQ4arWNEdaKi8D0=' 'sha256-SUIDOKSuFy4tj/CL6f42LWHhi0c6QqKlxxcLDwBYn/g=' 'sha256-wuNtnp867jrNYu5fymBZDEkgXN2sybtPTQo3SZROC2Y=' 'sha256-9Mln+8Jd32zS1gGhUMbCFX247FU54C+kZTEMQ4x0SYs='  'sha256-Sm+Vf1vWnC08pf6u3qIhns/vOHhqZhc8EhmtU6OD9sU=' 'sha256-MSZDXDvAgX6b48YllUw1jjXa9ewO9kR3MUicWggnBp4='  ; style-src 'unsafe-inline' https:;`;
  const headers = siteHeaders(portal({}, { defaultContentSecurityPolicy: 'platform' }), {
    nonce: NONCE,
    handlerHashes: [shell, page],
    loopback: false,
  });
  assert.equal(headers['content-security-policy'], captured);
});

// @test-kind security: no HTTP/* setting can stop the runtime: a value a header cannot carry ("€", a control character) is not sent and is reported, and every response is still answered
test('an HTTP/* setting with characters a header cannot carry is dropped and reported', async (t) => {
  const settings = {
    'HTTP/Access-Control-Allow-Origin': 'https://€.example.test',
    'HTTP/Access-Control-Allow-Methods': 'GET\u0007',
    'HTTP/X-Invented-Header': 'caf\u00e9 ok',
  };
  const sent = everyResponseHeaders(portal(settings), { status: 302 });
  assert.deepEqual(
    Object.keys(sent).filter((name) => name.startsWith('access-control-')),
    [],
  );
  assert.equal(siteHeaders(portal(settings))['x-invented-header'], 'caf\u00e9 ok');
  assert.deepEqual(
    siteHttpPolicyDiagnostics(portal(settings)).find((entry) => entry.code === 'PORTAL_HTTP_HEADER_INVALID')?.settings,
    ['http/access-control-allow-methods', 'http/access-control-allow-origin'],
  );
  const sim = await host(t, { settings, observed: null });
  for (const target of ['/', '/~/', '/_layout/tokenhtml', '/no-such-page/']) {
    const response = await fetch(sim.url + target, { redirect: 'manual' });
    await response.arrayBuffer();
    assert.ok(response.status < 500, `${target} ${response.status}`);
    assert.equal(response.headers.get('access-control-allow-origin'), null, target);
  }
});

// @test-kind unproven: no capture has a rendered page without handlers (hosted pages always carry the shell's); hosted sessions F5 and F3 replaced 'inject-hashes' on every rendered page, so a rendered page with no handler hashes gets none and no browser reads the placeholder as an invalid source
test('a rendered page without handler hashes sends no inject-hashes placeholder', () => {
  const site = portal({ 'HTTP/Content-Security-Policy': "script-src 'self' 'nonce'" });
  const rendered = siteHeaders(site, { nonce: 'aW52ZW50ZWQ=', handlerHashes: [], loopback: false });
  assert.doesNotMatch(rendered['content-security-policy'], /inject-hashes/);
  assert.match(rendered['content-security-policy'], /'unsafe-hashes' $/);
  // A response that is not a rendered page keeps the literal placeholder (sessions F5 and F3).
  assert.match(
    siteHeaders(site, { nonce: 'aW52ZW50ZWQ=', loopback: false })['content-security-policy'],
    /'inject-hashes'$/,
  );
});
