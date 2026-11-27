import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { createEdgeAccess, edgeDiagnostics } from '../lib/edge-access.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const EVIDENCE = 'invented loopback fixture';
const admin = (sim, route) =>
  fetch(sim.url + route, { headers: { 'x-sim-csrf': sim.csrf } }).then((response) => response.json());
const edgeFindings = async (sim) =>
  (await admin(sim, '/__sim/api/diagnostics')).diagnostics
    .filter((entry) => entry.code.startsWith('PORTAL_EDGE_'))
    .map((entry) => [entry.code, entry.severity]);

async function host(t, observed, extraFiles = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'edge-access-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: 77777777-7777-4777-8777-777777777796\nadx_name: Invented edge fixture',
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: page',
    'Page.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: content',
    'Content.webtemplate.yml': 'adx_webtemplateid: content\nadx_name: Content',
    'Content.webtemplate.source.html': '<p>Invented page</p>',
    'sitesetting.yml': '- adx_sitesettingid: invented-0\n  adx_name: HTTP/X-Frame-Options\n  adx_value: "SAMEORIGIN"',
    ...extraFiles,
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(root, name), text);
  const sim = await createSimulator({
    sourceDir: root,
    watch: false,
    port: 0,
    observed: { ...observed, evidence: EVIDENCE },
  });
  ownedFixture(t).add(() => sim.close());
  return sim;
}

// A request as the local gate sees it: the loopback connection's address, method, headers and URL.
const request = (target, { method = 'GET', headers = {}, address = '127.0.0.1' } = {}) => ({
  req: { method, headers, socket: { remoteAddress: address } },
  url: new URL(target, 'http://127.0.0.1:8787'),
});
const gate = (firewall, { ipRestrictions, clock } = {}) => {
  const observed = observedConfig({
    ...(firewall ? { firewall } : {}),
    ...(ipRestrictions ? { ipRestrictions } : {}),
    evidence: EVIDENCE,
  });
  let time = 0;
  const access = createEdgeAccess({ observed: () => observed, now: clock ?? (() => time) });
  return {
    observed,
    advance: (ms) => (time += ms),
    check: (target, options) => {
      const { req, url } = request(target, options);
      return access.check(req, url);
    },
  };
};
const rule = (name, priority, action, conditions, extra = {}) => ({
  name,
  priority,
  enabledState: 'Enabled',
  action,
  ruleType: 'MatchRule',
  matchConditions: conditions,
  ...extra,
});
const uri = (operator, values, extra = {}) => ({ matchVariable: 'RequestUri', operator, values, ...extra });

// @test-kind observation: hosted session F5 (VERIFY-03e, summary-F5; captures http-paqvilo-f5std-ip-restricted-a1..a9 and b3..b6, two runs): with an allow list that does not hold the caller, every path (/ and /_services/about) answers 403 with the Azure "Web App - Unavailable" page, content-type text/html, x-ms-forbidden-ip naming the caller and no site header
test('a visitor outside the observed IP allow list gets the hosted 403 page on every path', async (t) => {
  const sim = await host(t, { ipRestrictions: ['203.0.113.7/32'] });
  for (const route of ['/', '/_services/about']) {
    const response = await fetch(new URL(route, sim.url), { redirect: 'manual' });
    assert.equal(response.status, 403, route);
    assert.equal(response.headers.get('content-type'), 'text/html');
    assert.equal(response.headers.get('x-ms-forbidden-ip'), '127.0.0.1');
    for (const site of ['x-frame-options', 'content-security-policy', 'set-cookie', 'access-control-allow-origin'])
      assert.equal(response.headers.get(site), null, `${route} ${site}`);
    const body = await response.text();
    assert.match(body, /<title>Web App - Unavailable<\/title>/);
    assert.match(body, /<h1 id="unavailable">Error 403 - Forbidden<\/h1>/);
  }
  // The administration is Mirage's own, not the site's: the edge never sees it.
  assert.equal((await fetch(new URL('/_sim/api/status', sim.url))).status, 200);
  assert.deepEqual(await edgeFindings(sim), [['PORTAL_EDGE_IP_RESTRICTION', 'warning']]);
});

// @test-kind observation+compatibility: hosted session F5 (captures http-paqvilo-f5std-ip-removed-*): with no allow list the site answers normally with its own headers; Learn "Restrict website access by IP address": only the listed addresses and ranges may reach the site
test('a visitor on the allow list, or a site without one, reaches the site', async (t) => {
  const listed = await host(t, { ipRestrictions: ['203.0.113.7/32', '127.0.0.0/8'] });
  const page = await fetch(listed.url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(page.headers.get('x-ms-forbidden-ip'), null);
  assert.deepEqual(await edgeFindings(listed), [['PORTAL_EDGE_IP_RESTRICTION', 'info']]);
  const open = await host(t, { ipRestrictions: [] });
  assert.equal((await fetch(open.url)).status, 200);
  // IPv6 and IPv4-mapped visitors are matched on their own family.
  const v6 = gate(null, { ipRestrictions: [{ ipAddress: '2001:db8::/32', type: 'IPv6' }, '::1'] });
  assert.equal(v6.check('/', { address: '::1' }).refusal, null);
  assert.equal(v6.check('/', { address: '2001:db8::5' }).refusal, null);
  assert.equal(v6.check('/', { address: '::ffff:127.0.0.1' }).refusal.code, 'PORTAL_EDGE_IP_FORBIDDEN');
});

// @test-kind unproven: only GET was captured under IP restriction (F5); the local edge refuses every method the same way, failing closed
test('the IP restriction refuses every method, HEAD without a body', async (t) => {
  const sim = await host(t, { ipRestrictions: ['203.0.113.7'] });
  const head = await fetch(sim.url, { method: 'HEAD' });
  assert.equal(head.status, 403);
  assert.equal(await head.text(), '');
  const post = await fetch(new URL('/_services/about', sim.url), { method: 'POST', body: 'a=1' });
  assert.equal(post.status, 403);
  assert.equal(post.headers.get('x-ms-forbidden-ip'), '127.0.0.1');
});

// @test-kind contract: observed.ipRestrictions and observed.firewall accept the shapes Lense readPowerPagesEdge reports and the Power Platform API takes, and refuse anything else
test('the observed edge settings are validated', () => {
  assert.deepEqual(
    observedConfig({ ipRestrictions: ['203.0.113.7', { ipAddress: '2001:DB8::/32' }], evidence: EVIDENCE })
      .ipRestrictions,
    { allowed: ['203.0.113.7/32', '2001:db8::/32'], withheld: 0 },
  );
  // The report's form, with rows the read withheld; the normalized form is accepted again unchanged.
  const reported = observedConfig({
    ipRestrictions: { allowed: ['203.0.113.7/32'], withheld: 2 },
    evidence: EVIDENCE,
  }).ipRestrictions;
  assert.deepEqual(reported, { allowed: ['203.0.113.7/32'], withheld: 2 });
  assert.deepEqual(observedConfig({ ipRestrictions: reported, evidence: EVIDENCE }).ipRestrictions, reported);
  for (const bad of [{ allowed: [], withheld: -1 }, { allowed: [], extra: 1 }, { withheld: 1 }])
    assert.throws(() => observedConfig({ ipRestrictions: bad, evidence: EVIDENCE }), /ipRestrictions/);
  for (const bad of [['203.0.113.300'], ['10.0.0.0/33'], ['host.example'], 'not a list'])
    assert.throws(() => observedConfig({ ipRestrictions: bad, evidence: EVIDENCE }), /ipRestrictions/);
  assert.throws(() => observedConfig({ ipRestrictions: ['127.0.0.1'] }), /evidence/);
  // Lense's report: names and values of withheld variables are null.
  const firewall = {
    customRules: [
      {
        name: 'HeaderRule',
        priority: 20,
        enabledState: 'Enabled',
        action: 'Block',
        ruleType: 'MatchRule',
        rateLimitThreshold: null,
        rateLimitDurationInMinutes: null,
        matchConditions: [
          {
            matchVariable: 'RequestHeader',
            operator: 'Equals',
            negateCondition: false,
            selector: null,
            transforms: [],
            valueCount: 1,
            values: null,
          },
        ],
      },
      rule('PathRule', 10, 'block', [{ matchVariable: 'RequestUri', operator: 'contains', matchValue: ['/x'] }]),
    ],
  };
  const parsed = observedConfig({ firewall, evidence: EVIDENCE }).firewall;
  assert.deepEqual(
    parsed.customRules.map((entry) => [entry.name, entry.action, entry.matchConditions[0].operator]),
    [
      ['PathRule', 'Block', 'Contains'],
      ['HeaderRule', 'Block', 'Equals'],
    ],
  );
  // The normalized form is accepted again unchanged.
  assert.deepEqual(observedConfig({ firewall: parsed, evidence: EVIDENCE }).firewall, parsed);
  const invalid = [
    { customRules: [rule('R', 1, 'Redirect', [uri('Equals', ['/'])])] },
    { customRules: [rule('R', 1, 'Block', [uri('RegEx', ['.*'])])] },
    { customRules: [rule('R', 1, 'Block', [{ matchVariable: 'RequestHeader', operator: 'Equals', values: ['a'] }])] },
    { customRules: [rule('R', 1, 'Block', [uri('Equals', ['/'], { transforms: ['Reverse'] })])] },
    { customRules: [rule('R', 1, 'Block', [uri('Equals', ['/'])], { ruleType: 'RateLimitRule' })] },
    { customRules: [rule('R', 1, 'Block', [uri('Equals', ['/'])]), rule('r', 2, 'Block', [uri('Equals', ['/'])])] },
    { mode: 'Audit', customRules: [] },
    { customRules: [rule('R', 1, 'Block', [])] },
  ];
  for (const value of invalid) assert.throws(() => observedConfig({ firewall: value, evidence: EVIDENCE }), /firewall/);
});

// @test-kind unproven: local model of Azure Front Door custom-rule evaluation (priority order, conditions joined with and, values with or, Allow stops evaluation, Log continues); hosted enforcement of a Power Pages custom rule was not observed (F5: the firewall never reached Created)
test('custom rules are evaluated in priority order before the site', () => {
  const edge = gate({
    mode: 'Prevention',
    customRules: [
      rule('BlockPrivate', 20, 'Block', [uri('StartsWith', ['/private'])]),
      rule('AllowPrivateReports', 10, 'Allow', [uri('StartsWith', ['/private/reports'])]),
      rule('LogSearch', 5, 'Log', [{ matchVariable: 'QueryString', operator: 'Contains', values: ['q='] }]),
      rule('BlockPut', 30, 'Block', [{ matchVariable: 'RequestMethod', operator: 'Equals', values: ['PUT'] }]),
      rule('BlockOthersFromRange', 40, 'Block', [
        { matchVariable: 'RemoteAddr', operator: 'Equals', values: ['127.0.0.0/8'], negateCondition: true },
      ]),
      rule('Off', 1, 'Block', [uri('Contains', ['/'])], { enabledState: 'Disabled' }),
    ],
  });
  assert.equal(edge.check('/').refusal, null);
  const blocked = edge.check('/private/area');
  assert.equal(blocked.refusal.status, 403);
  assert.equal(blocked.refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.deepEqual(blocked.events, [{ rule: 'BlockPrivate', action: 'Block', decided: true, enforced: true }]);
  assert.equal(edge.check('/private/reports/1').refusal, null);
  const logged = edge.check('/search?q=1');
  assert.equal(logged.refusal, null);
  assert.deepEqual(logged.events, [{ rule: 'LogSearch', action: 'Log', decided: true, enforced: false }]);
  assert.equal(edge.check('/', { method: 'PUT' }).refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.equal(edge.check('/', { address: '192.0.2.4' }).refusal.message.includes('BlockOthersFromRange'), true);
  // Detection mode logs a Block rule instead of enforcing it.
  const detection = gate({ mode: 'Detection', customRules: [rule('BlockAll', 1, 'Block', [uri('Contains', ['/'])])] });
  const detected = detection.check('/');
  assert.equal(detected.refusal, null);
  assert.deepEqual(detected.events, [{ rule: 'BlockAll', action: 'Block', decided: true, enforced: false }]);
});

// @test-kind unproven: local model of a rate-limit rule (requests of one client address in a window of rateLimitDurationInMinutes; Learn allows 1 to 5 minutes); hosted counting was not observed
test('a rate-limit rule blocks requests over its threshold until the window ends', () => {
  const edge = gate({
    mode: 'Prevention',
    customRules: [
      rule('Burst', 1, 'Block', [uri('StartsWith', ['/_api/'])], {
        ruleType: 'RateLimitRule',
        rateLimitThreshold: 2,
        rateLimitDurationInMinutes: 1,
      }),
    ],
  });
  assert.equal(edge.check('/_api/accounts').refusal, null);
  assert.equal(edge.check('/_api/accounts').refusal, null);
  assert.equal(edge.check('/').refusal, null);
  assert.equal(edge.check('/_api/accounts').refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  // Another client address has its own count.
  assert.equal(edge.check('/_api/accounts', { address: '127.0.0.2' }).refusal, null);
  edge.advance(60_000);
  assert.equal(edge.check('/_api/accounts').refusal, null);
});

// @test-kind unproven: where the local runtime cannot decide a condition (a country match, values the read withheld, a request body, a comparison that depends on letter case) the rule fails closed: a Block rule acts, an Allow rule does not; the hosted answer is not known
test('an undecidable rule fails closed and is reported', () => {
  const geo = {
    mode: 'Prevention',
    customRules: [
      rule('AllowCountry', 1, 'Allow', [{ matchVariable: 'RemoteAddr', operator: 'GeoMatch', values: ['ZZ'] }]),
    ],
  };
  const allow = gate({
    ...geo,
    customRules: [...geo.customRules, rule('BlockElse', 2, 'Block', [uri('StartsWith', ['/'])])],
  });
  const refused = allow.check('/');
  assert.equal(refused.refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.deepEqual(refused.events[0], {
    rule: 'AllowCountry',
    action: 'Allow',
    decided: false,
    enforced: false,
    reason: 'a country match needs the hosted geolocation of the address',
  });
  const withheld = gate({
    customRules: [rule('Header', 1, 'Block', [{ matchVariable: 'RequestHeader', operator: 'Equals', values: null }])],
  });
  assert.equal(withheld.check('/').refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.deepEqual(
    edgeDiagnostics(withheld.observed).map((entry) => entry.code),
    ['PORTAL_EDGE_FIREWALL_LOCAL_MODEL', 'PORTAL_EDGE_FIREWALL_MODE_UNRECORDED', 'PORTAL_EDGE_FIREWALL_RULE_UNDECIDED'],
  );
  const body = gate({
    mode: 'Prevention',
    customRules: [
      rule('Args', 1, 'Block', [{ matchVariable: 'PostArgs', selector: 'q', operator: 'Contains', values: ['x'] }]),
    ],
  });
  assert.equal(body.check('/').refusal, null, 'a request without a body has no arguments');
  const posted = body.check('/', { method: 'POST', headers: { 'content-length': '3' } });
  assert.equal(posted.refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.equal(posted.events[0].reason, 'the request body is not read before the site');
  const letterCase = gate({
    mode: 'Prevention',
    customRules: [rule('Admin', 1, 'Block', [uri('Contains', ['/admin'])])],
  });
  assert.equal(letterCase.check('/admin').events[0].decided, true);
  const folded = letterCase.check('/Admin');
  assert.equal(folded.refusal.code, 'PORTAL_EDGE_FIREWALL_BLOCKED');
  assert.equal(folded.events[0].reason, 'the result depends on letter case');
  assert.equal(letterCase.check('/home').refusal, null);
  // With a Lowercase transform the answer no longer depends on letter case.
  const lower = gate({
    mode: 'Prevention',
    customRules: [rule('Admin', 1, 'Block', [uri('Contains', ['/admin'], { transforms: ['Lowercase'] })])],
  });
  assert.equal(lower.check('/ADMIN').events[0].decided, true);
});

// @test-kind unproven: the hosted WAF block response was not observed; the local runtime answers 403 before the site, with no site header, and logs the rule
test('a blocking custom rule answers before the site in a running portal', async (t) => {
  const sim = await host(t, {
    firewall: {
      mode: 'Prevention',
      customRules: [rule('BlockAbout', 1, 'Block', [uri('StartsWith', ['/_services/about'])])],
    },
  });
  const blocked = await fetch(new URL('/_services/about', sim.url));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('x-frame-options'), null);
  assert.match(await blocked.text(), /The request is blocked/);
  const page = await fetch(sim.url);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  const { items } = await admin(sim, '/__sim/api/logs?type=request');
  assert.deepEqual(
    items.filter((line) => line.kind === 'edge').map((line) => [line.rule, line.action, line.enforced]),
    [['BlockAbout', 'Block', true]],
  );
});

// An authored layout a public site was observed sharing across origins (observed.corsPages, lib/page-cors.mjs).
const CORS_ORIGIN = 'https://identity.example.test';
const CORS_FILES = {
  'Shared.webpage.yml':
    'adx_webpageid: shared\nadx_name: Shared layout\nadx_partialurl: shared-layout\nadx_parentpageid: home\nadx_pagetemplateid: layout',
  'Layout.pagetemplate.yml':
    'adx_pagetemplateid: layout\nadx_name: Layout\nadx_webtemplateid: layout\nadx_usewebsiteheaderandfooter: false',
  'Layout.webtemplate.yml': 'adx_webtemplateid: layout\nadx_name: Layout',
  'Layout.webtemplate.source.html':
    '<!doctype html><html><head><title>Shared</title></head><body>Shared page</body></html>',
  'sitesetting.yml': `- adx_sitesettingid: invented-cors\n  adx_name: HTTP/Access-Control-Allow-Origin\n  adx_value: "${CORS_ORIGIN}"`,
};
const CORS_OBSERVED = { corsPages: ['/shared-layout/'], siteVisibility: 'public' };

// @test-kind security: the edge gate answers before every portal answer: a cross-origin read of an observed CORS page from its allowed origin is refused when the IP restriction excludes the visitor or a WAF Block rule matches, and the page is never sent
test('the edge refuses an allowed cross-origin read of a shared page before the page is answered', async (t) => {
  const read = (sim) => fetch(new URL('/shared-layout/', sim.url), { headers: { origin: CORS_ORIGIN } });
  // Precondition: without an edge control the allowed origin reads the page.
  const open = await host(t, CORS_OBSERVED, CORS_FILES);
  const shared = await read(open);
  assert.equal(shared.status, 200);
  assert.equal(shared.headers.get('access-control-allow-origin'), CORS_ORIGIN);
  assert.match(await shared.text(), /Shared page/);
  const restricted = await host(t, { ...CORS_OBSERVED, ipRestrictions: ['203.0.113.7/32'] }, CORS_FILES);
  const firewalled = await host(
    t,
    {
      ...CORS_OBSERVED,
      firewall: { mode: 'Prevention', customRules: [rule('BlockShared', 1, 'Block', [uri('Contains', ['shared'])])] },
    },
    CORS_FILES,
  );
  for (const [sim, header] of [
    [restricted, 'x-ms-forbidden-ip'],
    [firewalled, 'cache-control'],
  ]) {
    const refused = await read(sim);
    assert.equal(refused.status, 403);
    assert.ok(refused.headers.get(header));
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
    assert.doesNotMatch(await refused.text(), /Shared page/);
  }
});

// @test-kind security: portal-facing simulator routes (a native form post, the local sign-in page, the compat scripts portal pages load) pass the edge gate like any portal request; only the administration surface (/_sim/ console, its assets and the admin API) is outside it
test('portal-facing /__sim routes are refused at the edge; the administration is not', async (t) => {
  const submit = (sim) =>
    fetch(new URL('/__sim/forms/entityform/77777777-7777-4777-8777-777777777700/submit', sim.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fields: {} }),
    });
  // Without an edge control the post reaches the form route, which answers its own JSON refusal.
  const open = await host(t, { siteVisibility: 'public' });
  const reached = await submit(open);
  assert.match(reached.headers.get('content-type'), /json/);
  const methodRule = await host(t, {
    firewall: {
      mode: 'Prevention',
      customRules: [
        rule('BlockPost', 1, 'Block', [{ matchVariable: 'RequestMethod', operator: 'Equals', values: ['POST'] }]),
      ],
    },
  });
  const blocked = await submit(methodRule);
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /The request is blocked/);
  const restricted = await host(t, { ipRestrictions: ['203.0.113.7/32'] });
  const forbidden = await submit(restricted);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('x-ms-forbidden-ip'), '127.0.0.1');
  assert.match(await forbidden.text(), /Web App - Unavailable/);
  for (const route of ['/_sim/sign-in', '/__sim-static/vendor/jquery.min.js'])
    assert.equal((await fetch(new URL(route, restricted.url))).headers.get('x-ms-forbidden-ip'), '127.0.0.1', route);
  // The administration surface stays reachable: the console, its assets and the admin API.
  assert.equal((await fetch(new URL('/_sim/', restricted.url))).status, 200);
  assert.equal((await fetch(new URL('/__sim/api/status', restricted.url))).status, 200);
  assert.equal((await fetch(new URL('/_sim/', methodRule.url))).status, 200);
});
