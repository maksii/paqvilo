import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { siteHeaders, sitePolicy, siteUsesScriptNonce, siteHttpPolicyDiagnostics } from '../lib/response-headers.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const HSTS = 'max-age=31536000; includeSubDomains';
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

// @test-kind compatibility: Learn "Manage your site's Content Security Policy": sites created after November 10, 2025 get CSP by default with the documented policy; clearing the setting's value disables it
test('the observed platform default policy applies only while the site has no CSP setting', () => {
  const observed = { defaultContentSecurityPolicy: 'platform' };
  // Learn's two directive lines, joined by one space.
  const PLATFORM_DEFAULT_POLICY =
    "script-src 'self' content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce'; style-src 'unsafe-inline' https:;";
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
  const headers = siteHeaders(portal({}, observed), { kind: 'page', nonce: 'aW52ZW50ZWQ=' });
  assert.equal(
    headers['content-security-policy'],
    "script-src 'self' content.powerapps.com content.powerapps.us content.appsplatform.us content.powerapps.cn 'nonce-aW52ZW50ZWQ='; style-src 'unsafe-inline' https: 'self';",
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

// @test-kind security: under the platform default policy the authored inline script carries the response's nonce
test('a site observed with the platform default policy sends it with a per-response nonce', async (t) => {
  const sim = await host(t, {
    observed: { defaultContentSecurityPolicy: 'platform', evidence: 'Invented header capture' },
  });
  const first = await fetch(sim.url + '/');
  const policy = first.headers.get('content-security-policy');
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, policy);
  // Handler hashes of the platform shell follow the nonce (Learn: inline event handlers are secured by hash generation).
  assert.match(
    policy,
    /^script-src 'self' content\.powerapps\.com content\.powerapps\.us content\.appsplatform\.us content\.powerapps\.cn 'nonce-[^']+'(?: '[^']+')*; style-src 'unsafe-inline' https: 'self';$/,
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
