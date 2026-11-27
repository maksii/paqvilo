// @test-kind security: a nonce Content-Security-Policy authorizes only scripts the exported source or the platform wrote; data-written script markup never receives the response's nonce or a handler hash
// Script nonces of the documented 'nonce' placeholder (Learn "Manage your site's Content Security Policy"): the header
// substitution (lib/response-headers.mjs), the per-element decisions over render provenance (lib/render-provenance.mjs)
// and the served page (mirage/server.mjs). Every portal, source and record here is invented.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'parse5';
import {
  startNoncePortal,
  nonceFragmentOf as fragmentOf,
  NONCE_MODAL_PATH,
  NONCE_QUICK_VIEW_PATH,
} from './fixtures/script-nonce-portal.mjs';
import {
  siteHeaders,
  sitePolicy,
  siteUsesScriptNonce,
  siteHttpPolicyDiagnostics,
  cspNonce,
} from '../lib/response-headers.mjs';
import {
  applyScriptNonces,
  nonceInjectedScripts,
  scriptNoncePendingAttribute,
  scriptNonceInjectedAttribute,
  finalizePortalProvenance,
} from '../lib/render-provenance.mjs';
import { injectRuntime } from '../lib/platform.mjs';
import { injectRuntimeDependencies, injectRuntimeCompatibility } from '../lib/source-dependencies.mjs';
import { injectLocalHead } from '../lib/local-overrides.mjs';
import { createFrameReadiness } from '../lib/frame-readiness.mjs';

const portal = (settings) => ({ settings });
const NONCE = 'aW52ZW50ZWQtbm9uY2U=';
const hash = (value) => createHash('sha256').update(value, 'utf8').digest('base64');

/** The script elements of a document: { nonce, text, attributes } in document order, template contents included. */
function scripts(html) {
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName === 'script')
        found.push({
          nonce: child.attrs.find((attr) => attr.name === 'nonce')?.value ?? null,
          text: (child.childNodes ?? []).map((text) => text.value ?? '').join(''),
          attributes: child.attrs.map((attr) => attr.name),
        });
      walk(child);
      if (child.content) walk(child.content);
    }
  };
  walk(parse(html));
  return found;
}

const decide = (parts) => {
  const { fragment, index } = fragmentOf(parts);
  return applyScriptNonces({ fragment, index, nonce: NONCE, pending: 'data-paqvilo-nonce-pending-test' });
};

// @test-kind compatibility+observation: Learn "Manage your site's Content Security Policy": 'nonce' in the HTTP/Content-Security-Policy and HTTP/Content-Security-Policy-Report-Only site settings is replaced by a unique per-request nonce; both settings may be used together. The enforced expansion is the one hosted session F3 sent for a custom 'nonce' setting (run a, captures runs/a/csp-custom), the nonce length the one hosted session F5 sent (256 bits; captures http-*-private-1b)
test('the documented nonce placeholder becomes the response nonce in the enforced and report-only policies', () => {
  const site = portal({
    'HTTP/Content-Security-Policy':
      "script-src 'self' content.powerapps.com 'nonce'; style-src 'unsafe-inline' https:;",
    'HTTP/Content-Security-Policy-Report-Only': "script-src 'NONCE' 'strict-dynamic'",
  });
  assert.equal(sitePolicy(site).reason, 'nonce');
  assert.equal(siteUsesScriptNonce(site), true);
  // The site's policy as the hosted HTTPS site sends it (the loopback transport adaptation is tested separately).
  const headers = siteHeaders(site, { nonce: NONCE, kind: 'page', loopback: false });
  assert.equal(
    headers['content-security-policy'],
    `script-src 'self' content.powerapps.com  'unsafe-eval' 'nonce-${NONCE}' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'inject-hashes'; style-src 'unsafe-inline' https:;`,
  );
  // The report-only policy, whose hosted text is not observed, gets the nonce alone.
  assert.equal(headers['content-security-policy-report-only'], `script-src 'nonce-${NONCE}' 'strict-dynamic'`);
  assert.deepEqual(
    siteHttpPolicyDiagnostics(site).map((entry) => entry.code),
    ['PORTAL_HTTP_CSP_LOOPBACK_TRANSPORT'],
  );
  // Two calls of the generator never repeat; the value is a CSP base64-value of 256 bits, as long as hosted nonces.
  const [first, second] = [cspNonce(), cspNonce()];
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9+/]{43}=$/);
});

// @test-kind security+observation: a policy whose nonce no script carries is never sent on a document whose scripts were not decided: such responses keep the earlier omission, and policies without a nonce source are unchanged; the enforced expansion is the one hosted session F3 sent for a custom 'nonce' setting (run a, captures runs/a/csp-custom)
test('a nonce policy is sent only with the nonce its scripts carry; other policies are unchanged', () => {
  const site = portal({
    'HTTP/Content-Security-Policy': "script-src 'self' 'nonce'",
    'HTTP/Content-Security-Policy-Report-Only': "script-src 'nonce'",
    'HTTP/X-Content-Type-Options': 'nosniff',
  });
  assert.deepEqual(siteHeaders(site), { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN' });
  assert.deepEqual(
    siteHeaders(site, { confinement: "connect-src 'self'" })['content-security-policy'],
    "connect-src 'self'",
  );
  assert.deepEqual(siteHeaders(site, { nonce: NONCE, confinement: "connect-src 'self'" })['content-security-policy'], [
    `script-src 'self'  'unsafe-eval' 'nonce-${NONCE}' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'inject-hashes'`,
    "connect-src 'self'",
  ]);
  const plain = portal({ 'HTTP/Content-Security-Policy': "default-src 'self'" });
  assert.equal(siteUsesScriptNonce(plain), false);
  assert.deepEqual(siteHeaders(plain, { nonce: NONCE }), siteHeaders(plain));
  assert.equal(siteHeaders(plain)['content-security-policy'], "default-src 'self'");
});

// @test-kind security: a nonce source other than the documented placeholder (a fixed value, a malformed source) keeps its earlier treatment: the policy is omitted and reported
test('fixed or malformed nonce sources are still omitted with PORTAL_HTTP_CSP_NONCE_UNSUPPORTED', () => {
  for (const value of [
    "script-src 'nonce-fixed'",
    "script-src 'nonce' 'nonce-fixed'",
    "script-src 'nonce-",
    "script-src 'nonce",
  ]) {
    const site = portal({ 'HTTP/Content-Security-Policy': value, 'HTTP/Content-Security-Policy-Report-Only': value });
    assert.equal(sitePolicy(site).reason, 'nonce-unsupported', value);
    assert.equal(siteUsesScriptNonce(site), false, value);
    const headers = siteHeaders(site, { nonce: NONCE });
    assert.equal(headers['content-security-policy'], undefined, value);
    assert.equal(headers['content-security-policy-report-only'], undefined, value);
    assert.deepEqual(
      siteHttpPolicyDiagnostics(site).map((entry) => [entry.code, entry.settings]),
      [
        [
          'PORTAL_HTTP_CSP_NONCE_UNSUPPORTED',
          ['http/content-security-policy', 'http/content-security-policy-report-only'],
        ],
      ],
      value,
    );
  }
  // Text that only contains the word is no source expression.
  assert.equal(sitePolicy(portal({ 'HTTP/Content-Security-Policy': 'report-uri /nonce' })).reason, 'site-setting');
});

// @test-kind observation+unproven: hosted session F3 (run a, captures runs/a/csp-custom) expanded a custom 'nonce' in script-src with the page's handler hashes after 'unsafe-hashes', each followed by a space and one more space after them; a placeholder in another directive getting the nonce alone is a local model
test('handler hashes join only the directives that govern inline event handlers', () => {
  // The site's policy as the hosted HTTPS site sends it, with the response's nonce and handler hashes.
  const substituted = (policy, handlerHashes) =>
    siteHeaders(portal({ 'HTTP/Content-Security-Policy': policy }), { nonce: NONCE, handlerHashes, loopback: false })[
      'content-security-policy'
    ];
  const policy = "default-src 'self'; script-src 'self' 'nonce'; style-src 'nonce' 'unsafe-inline'";
  assert.equal(
    substituted(policy, ['h1', 'h2', 'h1']),
    `default-src 'self'; script-src 'self'  'unsafe-eval' 'nonce-${NONCE}' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'sha256-h1' 'sha256-h2'  ; style-src 'nonce-${NONCE}' 'unsafe-inline'`,
  );
  assert.equal(
    substituted("script-src 'nonce'"),
    `script-src  'unsafe-eval' 'nonce-${NONCE}' 'sha256-YpBM7xPJQJfSSthwTVGpeXpUbzvd1XmAqvdlDUvm/QM=' 'unsafe-hashes' 'inject-hashes'`,
  );
});

test('exported source scripts and platform scripts get the nonce; data-written script markup does not', () => {
  const result = decide([
    '<script>window.authored = 1;</script><script type="module">import \'./x.js\';</script>',
    { platform: '<script>window.platform = 1;</script>' },
    { platform: '<script src="/platform.js"></script>' },
    '<div>',
    { data: "<script>window.injected = 1;</script><script src='https://data.example.test/x.js'></script>" },
    '</div>',
    { raw: '<script>window.unaccounted = 1;</script>' },
    '<script src="https://cdn.example.test/authored.js"></script>',
  ]);
  assert.deepEqual(
    scripts(result.html).map((script) => [script.text || script.attributes.join(' '), script.nonce]),
    [
      ['window.authored = 1;', NONCE],
      ["import './x.js';", NONCE],
      ['window.platform = 1;', NONCE],
      [`nonce src`, NONCE],
      ['window.injected = 1;', null],
      ['data-paqvilo-nonce-pending-test src', null],
      ['window.unaccounted = 1;', null],
      ['data-paqvilo-nonce-pending-test src', null],
    ],
  );
  assert.equal(result.scriptPolicy.nonced, 4);
  // The authored external script is the policy's to allow (its host in script-src); it is not reported.
  assert.equal(result.scriptPolicy.external, 1);
  assert.deepEqual(
    result.scriptPolicy.withheld.map((entry) => entry.reason),
    ['unaccounted', 'unaccounted', 'unaccounted'],
  );
});

// @test-kind observation+security: hosted session F3 (two runs, captures runs/a/csp-base, runs/b/csp-base and runs/a/csp-custom) gave the nonce to every script element of a rendered page (template, record field, snippet, built string and an authored external script) and hashed a handler a record wrote; only observed.scriptNonceScope "every-script" does so locally, and without it the same markup keeps the fail-closed decisions
test('observed every-script scope nonces every script element and hashes every handler, data-written ones included', () => {
  const parts = [
    '<script>window.authored = 1;</script>',
    '<div>',
    { data: '<script>window.injected = 1;</script><img src="x" onerror="window.dataHandler = 1">' },
    '</div>',
    { raw: '<script>window.unaccounted = 1;</script>' },
    '<script src="https://cdn.example.test/authored.js"></script>',
  ];
  const { fragment, index } = fragmentOf(parts);
  const pending = 'data-paqvilo-nonce-pending-test';
  const every = applyScriptNonces({ fragment, index, nonce: NONCE, pending, everyScript: true });
  assert.deepEqual(
    scripts(every.html).map((script) => script.nonce),
    [NONCE, NONCE, NONCE, NONCE],
  );
  assert.deepEqual(every.scriptPolicy.withheld, []);
  assert.deepEqual(every.scriptPolicy.handlerHashes, [hash('window.dataHandler = 1')]);
  // The default: the same markup keeps the proved decisions.
  const proven = decide(parts);
  assert.deepEqual(
    scripts(proven.html).map((script) => script.nonce),
    [NONCE, null, null, null],
  );
  assert.deepEqual(proven.scriptPolicy.handlerHashes, []);
});

// @test-kind contract: observed.scriptNonceScope is a per-site choice that needs evidence; the default is the fail-closed "proven"
test('observed.scriptNonceScope accepts proven or every-script with evidence', async () => {
  const { observedConfig } = await import('../lib/project-config.mjs');
  assert.equal(
    observedConfig({ scriptNonceScope: 'every-script', evidence: 'invented capture' }).scriptNonceScope,
    'every-script',
  );
  assert.throws(() => observedConfig({ scriptNonceScope: 'every-script' }), /evidence/);
  assert.throws(() => observedConfig({ scriptNonceScope: 'all', evidence: 'invented capture' }), /scriptNonceScope/);
});

// @test-kind security: source debugging (the sourceURL comment Mirage adds to an authored inline script) changes no nonce decision: a page copy's authored script keeps the nonce through the editable tag and the page proxy, and a script a Liquid string builds stays without it
test('source-debugged page copy scripts keep their nonce decisions through the editable tag', async (t) => {
  const { default: fsp } = await import('node:fs/promises');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const { importPortal } = await import('../lib/importer.mjs');
  const { createPortalRenderer } = await import('../lib/liquid.mjs');
  const { runWithSourceDebugging } = await import('../lib/source-debug.mjs');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'paqvilo-debug-copy-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_websiteid: invented-site\nadx_name: Invented debug site',
    'web-pages/home/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: page',
    'web-pages/home/Home.webpage.copy.html':
      "<script>window.authored = 'ran';</script>" +
      "{% assign built = '<scr' | append: 'ipt>window.built = 1;</scr' | append: 'ipt>' %}{{ built }}",
    'page-templates/Page.pagetemplate.yml':
      'adx_pagetemplateid: page\nadx_webtemplateid: page\nadx_usewebsiteheaderandfooter: false',
    'web-templates/Page.webtemplate.yml': 'adx_webtemplateid: page\nadx_name: Page',
    'web-templates/Page.webtemplate.source.html':
      "<div>{% editable page 'adx_copy' type: 'html', liquid: true %}</div><div>{% editable page 'adx_copy' type: 'html', liquid: false %}</div>",
  };
  for (const [relative, text] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fsp.writeFile(path.join(root, relative), text);
  }
  const renderer = createPortalRenderer(await importPortal(root));
  const decisions = async (debug) =>
    runWithSourceDebugging(debug, async () => {
      const rendered = await renderer.renderPage('/', {});
      const { html, scriptPolicy } = renderer.scriptNoncesFor(rendered, { nonce: NONCE, pending: 'data-pending' });
      return {
        debugged: html.includes('//# sourceURL='),
        scripts: scripts(html).map((script) => [script.text.split('\n')[0], script.nonce]),
        withheld: scriptPolicy.withheld.map((entry) => entry.reason),
      };
    });
  const plain = await decisions(false);
  const debugged = await decisions(true);
  assert.equal(plain.debugged, false);
  assert.equal(debugged.debugged, true);
  // The Liquid copy: the authored script keeps the nonce, the built one does not; the literal copy writes the
  // assign tag as text, so only its authored script is a script element.
  const expected = [
    ["window.authored = 'ran';", NONCE],
    ['window.built = 1;', null],
    ["window.authored = 'ran';", NONCE],
  ];
  assert.deepEqual(plain.scripts, expected);
  assert.deepEqual(debugged.scripts, expected);
  assert.deepEqual(debugged.withheld, plain.withheld);
});

// @test-kind observation: hosted session F3 (two runs, captures runs/a/csp-base and runs/b/csp-base) listed the platform shell's handler hashes first and the page's own after them, as two groups
test("handler hashes are grouped by writer: the platform's, then the page's", () => {
  const result = decide([
    { platform: '<img src="x" onerror="window.platformHandler = 1">' },
    '<button onclick="window.authoredHandler = 1">x</button>',
    { platform: '<img src="y" onerror="window.secondPlatform = 1">' },
  ]);
  assert.deepEqual(result.scriptPolicy.handlerHashGroups, [
    [hash('window.platformHandler = 1'), hash('window.secondPlatform = 1')],
    [hash('window.authoredHandler = 1')],
  ]);
  assert.deepEqual(result.scriptPolicy.handlerHashes, result.scriptPolicy.handlerHashGroups.flat());
});

test('a value inside an authored script cannot close it and open a nonced one', () => {
  const result = decide(['<script>var name = "', { data: '";</script><script>window.injected = 1;//' }, '";</script>']);
  const found = scripts(result.html);
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((script) => script.nonce),
    [null, null],
  );
  assert.deepEqual(
    result.scriptPolicy.withheld.map((entry) => entry.reason),
    ['end-tag', 'unaccounted'],
  );
  // The same interpolation that stays a value keeps the authored script's nonce (Learn: Liquid-rendered inline scripts).
  const kept = decide(['<script>var name = "', { data: 'Alex' }, '";</script>']);
  assert.deepEqual(
    scripts(kept.html).map((script) => script.nonce),
    [NONCE],
  );
});

test('script tags with Liquid inside them, data-only tags and built-in template regions are not proved', () => {
  const result = decide([
    '<script data-id="',
    { data: '42' },
    '">window.tagged = 1;</script>',
    { platform: '<script>window.builtin = 1;</script>', kind: 'builtin-template' },
    { platform: '<script>window.layout = 1;</script>', kind: 'page-template' },
    '<script type="application/json">',
    { data: '{"a":1}' },
    '</script>',
    { data: '<script type="text/x-template">{{x}}</script>' },
  ]);
  assert.deepEqual(
    scripts(result.html).map((script) => script.nonce),
    [null, null, null, NONCE, null],
  );
  // A data block never runs: it is not reported.
  assert.equal(result.scriptPolicy.withheld.length, 3);
});

test('an authored nonce attribute is replaced, and a template script is decided like any other', () => {
  const result = decide([
    '<script nonce="authored-value">window.a = 1;</script><template><script>window.b = 1;</script></template>',
  ]);
  const found = scripts(result.html);
  assert.deepEqual(
    found.map((script) => script.nonce),
    [NONCE, NONCE],
  );
  assert.doesNotMatch(result.html, /authored-value/);
});

test('inline event handlers are hashed only on start tags the source or the platform wrote', () => {
  const result = decide([
    '<button onclick="window.authored()">A</button>',
    { platform: '<input type="checkbox" onchange="window.platform()">' },
    { data: '<img src="x.png" onerror="window.injected()">' },
    { platform: '<a onclick="window.builtin()">x</a>', kind: 'builtin-template' },
  ]);
  assert.deepEqual(
    result.scriptPolicy.handlerHashes.sort(),
    [hash('window.authored()'), hash('window.platform()')].sort(),
  );
  assert.deepEqual(
    result.scriptPolicy.withheld.map((entry) => [entry.kind, entry.attribute]),
    [
      ['handler', 'onerror'],
      ['handler', 'onclick'],
    ],
  );
  // Handler hashes and the nonce are the only additions: the markup is otherwise untouched.
  assert.equal(
    result.html,
    fragmentOf([
      '<button onclick="window.authored()">A</button>',
      { platform: '<input type="checkbox" onchange="window.platform()">' },
      { data: '<img src="x.png" onerror="window.injected()">' },
      { platform: '<a onclick="window.builtin()">x</a>', kind: 'builtin-template' },
    ]).fragment.text,
  );
});

test('only the scripts the toolkit marks when it adds them after rendering get the nonce; decided ones keep their decision', () => {
  const pending = scriptNoncePendingAttribute(),
    injected = scriptNonceInjectedAttribute();
  assert.notEqual(pending, scriptNoncePendingAttribute());
  assert.notEqual(injected, scriptNonceInjectedAttribute());
  const { fragment, index } = fragmentOf([
    '<!doctype html><html><head></head><body><script>window.authored = 1;</script>',
    { data: '<script>window.injected = 1;</script>' },
    // Data cannot carry a marker in advance: a guessed name is not the response's.
    { data: '<script data-paqvilo-nonce-pending-0123>window.guessed = 1;</script>' },
    { data: '<script data-paqvilo-nonce-injected-0123>window.guessedInjected = 1;</script>' },
    '</body></html>',
  ]);
  const decided = applyScriptNonces({ fragment, index, nonce: NONCE, pending });
  const added = decided.html
    .replace('<head>', `<head><script ${injected} data-paqvilo-mirage-runtime>window.runtime = 1;</script>`)
    .replace(
      '</body>',
      `<script ${injected} src="/__sim-static/native/entity-grid-compat.js"></script><script>window.unmarked = 1;</script></body>`,
    );
  const html = nonceInjectedScripts(added, { nonce: NONCE, pending, injected });
  assert.ok(!html.includes(pending));
  assert.ok(!html.includes(injected));
  assert.deepEqual(
    scripts(html).map((script) => [script.text || 'external', script.nonce]),
    [
      ['window.runtime = 1;', NONCE],
      ['window.authored = 1;', NONCE],
      ['window.injected = 1;', null],
      ['window.guessed = 1;', null],
      ['window.guessedInjected = 1;', null],
      ['external', NONCE],
      // Fail closed: a script added after the decisions without the response's marker gets no nonce.
      ['window.unmarked = 1;', null],
    ],
  );
  // Without the injected marker nothing added afterwards gets the nonce.
  assert.deepEqual(
    scripts(nonceInjectedScripts(added, { nonce: NONCE, pending })).map((script) => script.nonce),
    [null, NONCE, null, null, null, null, null],
  );
});

// Data start tags in which the browser reads text inserted before the `>` as the value of the last attribute.
const OPEN_VALUE_SCRIPTS = [
  '<script x=>window.injected = 1;</script>',
  '<script x =>window.injected = 1;</script>',
  '<script\nx=\n>window.injected = 1;</script>',
  "<script a='' y=>window.injected = 1;</script>",
  '<script x=/>window.injected = 1;</script>',
  '<SCRIPT x=>window.injected = 1;</SCRIPT>',
];

/** The script elements of `html` with every attribute: { text, nonce, attrs: { name: value } }. */
function scriptAttributes(html) {
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName === 'script')
        found.push({
          nonce: child.attrs.find((attr) => attr.name === 'nonce')?.value ?? null,
          text: (child.childNodes ?? []).map((text) => text.value ?? '').join(''),
          attrs: Object.fromEntries(child.attrs.map((attr) => [attr.name, attr.value])),
        });
      walk(child);
      if (child.content) walk(child.content);
    }
  };
  walk(parse(html));
  return found;
}

for (const markup of OPEN_VALUE_SCRIPTS)
  test(`a data script whose start tag ends in an open attribute value stays without the nonce: ${JSON.stringify(markup)}`, () => {
    const pending = scriptNoncePendingAttribute(),
      injected = scriptNonceInjectedAttribute();
    const { fragment, index } = fragmentOf([
      '<!doctype html><html><head></head><body><div>',
      { data: markup },
      '</div><script async=>window.authored = 1;</script></body></html>',
    ]);
    const decided = applyScriptNonces({ fragment, index, nonce: NONCE, pending });
    // The pending marker is an attribute of its own, never the value of the data's attribute.
    const [data, authored] = scriptAttributes(decided.html);
    assert.equal(data.nonce, null);
    assert.equal(data.attrs[pending], '');
    assert.ok(Object.values(data.attrs).every((value) => !value.includes('data-paqvilo')));
    // The trusted script's own empty attribute value is untouched; its nonce is an attribute of its own.
    assert.deepEqual(authored.attrs, { nonce: NONCE, async: '' });
    const html = nonceInjectedScripts(decided.html, { nonce: NONCE, pending, injected });
    assert.deepEqual(
      scripts(html).map((script) => [script.text, script.nonce]),
      [
        ['window.injected = 1;', null],
        ['window.authored = 1;', NONCE],
      ],
    );
    assert.doesNotMatch(html, /data-paqvilo-nonce-/);
    assert.deepEqual(
      decided.scriptPolicy.withheld.map((entry) => entry.reason),
      ['unaccounted'],
    );
  });

test('render provenance stamps and script proof ids are attributes of their own on start tags with open values', () => {
  const { fragment, index } = fragmentOf([
    '<!doctype html><html><head></head><body><div x=>A</div><script y=>window.a = 1;</script></body></html>',
  ]);
  const proved = finalizePortalProvenance({ fragment, index, scriptNonce: { nonce: NONCE, pending: 'data-p' } });
  const tree = parse(proved.html);
  const body = tree.childNodes
    .find((node) => node.tagName === 'html')
    .childNodes.find((node) => node.tagName === 'body');
  const [div, script] = body.childNodes;
  const attrs = (node) => Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]));
  assert.equal(attrs(div).x, '');
  assert.ok(attrs(div)['data-paqvilo-source'], proved.html);
  assert.equal(attrs(script).y, '');
  assert.equal(attrs(script).nonce, NONCE);
  assert.ok(attrs(script)['data-paqvilo-script'], proved.html);
  assert.equal(proved.provenance.scriptProofs.length, 1);
});

test('a script element outside the HTML namespace keeps the nonce only when its writer wrote all of its content', () => {
  // A record opens an SVG context before an authored script: its content is then read as markup, where the escaped
  // value's character references decode (| escape and | json both leave `&` as it is).
  for (const value of ['&quot;;window.injected = 1;//', '"&quot;;window.injected = 1;//"']) {
    const result = decide(['<div>', { data: '</div><svg>' }, '<script>window.x = "', { data: value }, '";</script>']);
    assert.deepEqual(
      scripts(result.html).map((script) => script.nonce),
      [null],
      value,
    );
    assert.deepEqual(
      result.scriptPolicy.withheld.map((entry) => entry.reason),
      ['foreign-content'],
    );
  }
  // The same interpolation in the HTML namespace is raw text: the authored script keeps its nonce.
  assert.deepEqual(
    scripts(decide(['<script>window.x = "', { data: '&quot;;x' }, '";</script>']).html).map((script) => script.nonce),
    [NONCE],
  );
  // An SVG script whose content is all exported source keeps it; an SVG external script is the policy's to allow.
  const literal = decide([
    '<svg><script>window.svg = 1;</script><script href="https://cdn.example.test/x.js"></script></svg>',
  ]);
  assert.deepEqual(
    scripts(literal.html).map((script) => script.nonce),
    [NONCE, null],
  );
  assert.equal(literal.scriptPolicy.external, 1);
  // Markup inside an SVG script (an element child) is never proved.
  assert.deepEqual(
    scripts(decide(['<svg><script>window.a = 1;<b>x</b></script></svg>']).html).map((script) => script.nonce),
    [null],
  );
});

// Contexts a record can open inside select content: parse5 ignores the <svg> there, Chromium 158 inserts it, so the
// authored script after it is an SVG script in the browser (mirage/test-browser/script-nonce.test.mjs compares both).
const SELECT_OPENERS = [
  '</div><select><svg>',
  '</div><select><option><svg>',
  '</div><select><optgroup><svg>',
  '</div><table><select><svg>',
  '</div><select><button><svg>',
  '</div><select><datalist><svg>',
  '</div><select><math>',
];

test('a script inside select content keeps the nonce only when its writer wrote all of its content', () => {
  for (const opener of SELECT_OPENERS) {
    const result = decide(['<div>', { data: opener }, '<script>window.x = "', { data: '&quot;;x' }, '";</script>']);
    // parse5 still reads the script in the HTML namespace; the decision does not rely on it.
    assert.deepEqual(
      scripts(result.html).map((script) => script.nonce),
      [null],
      opener,
    );
    assert.deepEqual(
      result.scriptPolicy.withheld.map((entry) => entry.reason),
      ['foreign-content'],
      opener,
    );
  }
  // An authored script inside an authored select keeps the nonce when all of its content is exported source; an
  // external one there may be an SVG script that loads href, so it is the policy's to allow.
  const literal = decide([
    '<select><option>A</option><script>window.inSelect = 1;</script><script href="https://cdn.example.test/x.js"></script></select>',
  ]);
  assert.deepEqual(
    scripts(literal.html).map((script) => script.nonce),
    [NONCE, null],
  );
  assert.equal(literal.scriptPolicy.external, 1);
  // A platform script inside select content keeps it when the platform wrote all of its content.
  assert.deepEqual(
    scripts(decide([{ platform: '<select><script>window.platform = 1;</script></select>' }]).html).map(
      (script) => script.nonce,
    ),
    [NONCE],
  );
  // Outside select content the same interpolation is raw text: | escape output (`&amp;`, `&lt;`) cannot end the string.
  assert.deepEqual(
    scripts(
      decide([
        '<div>',
        { data: 'Smith &amp; Sons &lt;b&gt;' },
        '</div><script>window.x = "',
        { data: '&quot;;x' },
        '";</script>',
      ]).html,
    ).map((script) => script.nonce),
    [NONCE],
  );
});

test('a handler the parser merges onto a source <html> or <body> tag from a later tag gets no hash', () => {
  const parts = [
    '<!doctype html><html lang="en"><head></head><body class="page" onload="window.authored()">',
    {
      data: '<body onload="window.ignored()" onclick="window.injected()"><html onclick="window.injectedRoot()">',
    },
    '<p>text</p></body></html>',
  ];
  const result = decide(parts);
  // parse5 keeps the first onload and adds the record's other attributes to the document's html and body elements.
  const tree = parse(result.html);
  const html = tree.childNodes.find((node) => node.tagName === 'html');
  const body = html.childNodes.find((node) => node.tagName === 'body');
  assert.deepEqual(
    [html, body].map((node) => node.attrs.map((attr) => `${attr.name}=${attr.value}`)),
    [
      ['lang=en', 'onclick=window.injectedRoot()'],
      ['class=page', 'onload=window.authored()', 'onclick=window.injected()'],
    ],
  );
  assert.deepEqual(result.scriptPolicy.handlerHashes, [hash('window.authored()')]);
  assert.deepEqual(
    result.scriptPolicy.withheld.map((entry) => [entry.kind, entry.attribute, entry.reason]),
    [
      ['handler', 'onclick', 'merged'],
      ['handler', 'onclick', 'merged'],
    ],
  );
  assert.equal(result.html, fragmentOf(parts).fragment.text);
});

/**
 * The characters `run` copies through String.prototype.slice (the edit passes build their output from slices of the
 * text): a count, not a time, so it is the same on every host.
 */
function copiedCharacters(run) {
  const slice = String.prototype.slice;
  let copied = 0;
  String.prototype.slice = function (...args) {
    const piece = slice.apply(this, args);
    copied += piece.length;
    return piece;
  };
  try {
    return { result: run(), copied };
  } finally {
    String.prototype.slice = slice;
  }
}

test('the nonce and provenance passes copy each character a bounded number of times, whatever the number of scripts', () => {
  const pending = scriptNoncePendingAttribute(),
    injected = scriptNonceInjectedAttribute();
  const documentOf = (count) =>
    fragmentOf([
      '<!doctype html><html><head></head><body>',
      { data: '<p>filler filler</p><script x=>d</script>'.repeat(count) },
      '<script>a</script></body></html>',
    ]);
  const passes = {
    decide: ({ fragment, index }) => applyScriptNonces({ fragment, index, nonce: NONCE, pending }).html,
    inject: ({ fragment, index }) =>
      nonceInjectedScripts(applyScriptNonces({ fragment, index, nonce: NONCE, pending }).html, {
        nonce: NONCE,
        pending,
        injected,
      }),
    provenance: ({ fragment, index }) =>
      finalizePortalProvenance({ fragment, index, scriptNonce: { nonce: NONCE, pending } }).html,
  };
  for (const [name, pass] of Object.entries(passes)) {
    const small = copiedCharacters(() => pass(documentOf(1000))),
      large = copiedCharacters(() => pass(documentOf(4000)));
    // Four times the scripts copy about four times the characters; one copy of the text per edit would be sixteen.
    assert.ok(large.copied < small.copied * 6, `${name}: ${small.copied} -> ${large.copied}`);
    // Every decision and marker lands on its own script.
    const found = scripts(large.result);
    assert.equal(found.length, 4001, name);
    assert.deepEqual(
      found.filter((script) => script.nonce === NONCE).map((script) => script.text),
      ['a'],
      name,
    );
    if (name === 'inject') assert.doesNotMatch(large.result, /data-paqvilo-nonce-pending-/, name);
  }
});

// Record markup that looks like a document tag inside an attribute value, in a document without that real tag.
const DOCUMENT_TAG_DATA = '<div title="<head><body></body><script>window.injected = 1;</script>"></div>';

test("the toolkit's injectors insert at the document's real head and body tags, never at the same text in a value", () => {
  const injected = scriptNonceInjectedAttribute();
  const valueOf = (html) => {
    const found = [];
    const walk = (node) => {
      if (node.tagName === 'div' && node.attrs.some((attr) => attr.name === 'title'))
        found.push(node.attrs.find((attr) => attr.name === 'title').value);
      for (const child of node.childNodes ?? []) walk(child);
    };
    walk(parse(html));
    return found;
  };
  const title = '<head><body></body><script>window.injected = 1;</script>';
  const assertInert = (html, label) => {
    assert.deepEqual(valueOf(html), [title], `${label}: ${html.slice(0, 600)}`);
    assert.ok(!scripts(html).some((script) => script.text.includes('window.injected')), label);
  };
  const document = `<p>Intro</p>${DOCUMENT_TAG_DATA}<footer>F</footer>`;
  const frames = createFrameReadiness();
  try {
    for (const [label, html] of [
      ['runtime', injectRuntime(document, 'token', 'r1', {}, null, null, { injectedScripts: injected })],
      ['dependencies', injectRuntimeDependencies(document, { jquery: true }, [], { injectedScripts: injected })],
      [
        'compatibility',
        injectRuntimeCompatibility(document, { footerSpacing: true }, [], { injectedScripts: injected }),
      ],
      [
        'local head',
        injectLocalHead(document, { assets: [{ kind: 'scripts', url: '/_sim-local/head/0.js' }] }, null, {
          injectedScripts: injected,
        }),
      ],
      ['frame readiness', frames.decorate(document, { injectedScripts: injected })],
    ])
      assertInert(html, label);
  } finally {
    frames.close();
  }
  // A jQuery include inside a value is not the anchor of the compatibility adapters: the real include is.
  const jquery = '<script src="/js/jquery-3.7.1.min.js"></script>';
  const included = `<!doctype html><html><head>${jquery}</head><body><div title='${jquery}'></div></body></html>`;
  const adapted = injectRuntimeCompatibility(included, { bootstrapPlugins: true }, [], { injectedScripts: injected });
  assert.equal(
    adapted,
    included.replace(
      `${jquery}</head>`,
      `${jquery}<script ${injected} src="/__sim-static/vendor/bootstrap-plugins-compat.js"></script></head>`,
    ),
  );
});

test("the injectors' places in a normal document are unchanged, and every script they add carries the response's marker", () => {
  const injected = scriptNonceInjectedAttribute();
  const document = '<!doctype html><html><head><title>T</title></head><body><p>A</p><footer>F</footer></body></html>';
  let html = injectRuntimeDependencies(document, { jquery: true }, [], { injectedScripts: injected });
  assert.equal(
    html,
    document.replace('<head>', `<head><script ${injected} src="/__sim-static/vendor/jquery.min.js"></script>`),
  );
  html = injectRuntimeCompatibility(html, { footerSpacing: true }, [], { injectedScripts: injected });
  assert.ok(
    html.endsWith(
      `<footer>F</footer><script ${injected} src="/__sim-static/vendor/footer-spacing-compat.js"></script></body></html>`,
    ),
    html,
  );
  html = injectLocalHead(html, { assets: [{ kind: 'scripts', url: '/_sim-local/head/0.js' }] }, null, {
    injectedScripts: injected,
  });
  assert.ok(
    html.includes(`<head><script ${injected} data-sim-local-only="head" src="/_sim-local/head/0.js"></script>`),
    html,
  );
  html = injectRuntime(html, 'token', 'r1', {}, null, null, { injectedScripts: injected });
  assert.match(
    html,
    /^<!doctype html><html><head><script data-paqvilo-nonce-injected-[0-9a-f]{24} data-paqvilo-mirage-runtime>/,
  );
  assert.ok(html.includes('<body><div id="antiforgerytoken" data-url="/_layout/tokenhtml"></div><p>A</p>'), html);
  const added = scriptAttributes(html);
  assert.ok(added.length >= 5);
  assert.deepEqual(
    added.filter((script) => !Object.hasOwn(script.attrs, injected)).map((script) => script.text.slice(0, 40)),
    [],
  );
  const nonced = nonceInjectedScripts(html, { nonce: NONCE, pending: 'data-p', injected });
  assert.deepEqual(
    scripts(nonced).filter((script) => script.nonce !== NONCE),
    [],
  );
  assert.ok(!nonced.includes(injected));
  // A document without a head gets the runtime first, as before; one without a body gets no anti-forgery holder.
  assert.match(injectRuntime('<p>x</p>', 'token', 'r1'), /^<script data-paqvilo-mirage-runtime>/);
  assert.ok(!injectRuntime('<p>x</p>', 'token', 'r1').includes('<div id="antiforgerytoken"'));
  // Without a nonce policy nothing is marked; a marker that is not the response's form is refused.
  assert.doesNotMatch(injectRuntime(document, 'token', 'r1'), /data-paqvilo-nonce/);
  assert.throws(() => injectRuntime(document, 'token', 'r1', {}, null, null, { injectedScripts: 'onload' }), TypeError);
});

test('render provenance and nonces are decided in one pass with the same result', () => {
  const { fragment, index } = fragmentOf([
    '<!doctype html><html><head></head><body><script>window.authored = 1;</script>',
    { data: '<script>window.injected = 1;</script>' },
    '</body></html>',
  ]);
  const proved = finalizePortalProvenance({ fragment, index, scriptNonce: { nonce: NONCE, pending: 'data-p' } });
  assert.deepEqual(
    scripts(proved.html).map((script) => script.nonce),
    [NONCE, null],
  );
  assert.equal(proved.scriptPolicy.nonced, 1);
  assert.ok(!JSON.stringify(proved.provenance).includes(NONCE), 'the published proof never carries the nonce');
  // The script proof of the authored script still matches its text.
  assert.equal(proved.provenance.scriptProofs.length, 1);
  const plain = finalizePortalProvenance({ fragment, index });
  assert.equal(plain.scriptPolicy, undefined);
  assert.ok(!plain.html.includes('nonce='));
});

// ---- The served page
let served;
after(async () => (await served)?.close());
const servedPortal = () => (served ??= startNoncePortal({ reportOnly: "script-src 'nonce'; report-uri /csp-report" }));

const pageNonce = (headers, name = 'content-security-policy') => /'nonce-([^']+)'/.exec(headers.get(name) ?? '')?.[1];

for (const dest of [null, 'document'])
  test(`a served page (${dest ? 'browser navigation with render proof' : 'plain request'}): one fresh nonce for its headers and its proved scripts`, async () => {
    const { sim } = await servedPortal();
    const request = () => fetch(sim.url + '/', { headers: dest ? { 'sec-fetch-dest': dest } : {} });
    const [first, second] = [await request(), await request()];
    const html = await first.text();
    await second.text();
    assert.equal(first.status, 200, html.slice(0, 400));
    const nonce = pageNonce(first.headers);
    assert.ok(nonce, first.headers.get('content-security-policy'));
    assert.equal(pageNonce(first.headers, 'content-security-policy-report-only'), nonce);
    assert.notEqual(pageNonce(second.headers), nonce, 'every response has its own nonce');
    const found = scripts(html);
    const byText = (needle) => found.filter((script) => script.text.includes(needle));
    for (const needle of [
      "window.authored = 'ran'",
      "window.snippet = 'ran'",
      "window.pageScript = 'ran'",
      'window.interpolated',
    ])
      assert.deepEqual(
        byText(needle).map((script) => script.nonce),
        [nonce],
        needle,
      );
    assert.deepEqual(
      byText("window.injected = 'ran'").map((script) => script.nonce),
      [null],
    );
    // The toolkit's runtime (window.__portalSimulation, the pages client API) is platform-equivalent: it gets the nonce.
    const runtime = found.find((script) => script.attributes.includes('data-paqvilo-mirage-runtime'));
    assert.equal(runtime?.nonce, nonce);
    // No script carries a nonce other than the response's, and no pending marker reaches the browser.
    assert.deepEqual([...new Set(found.map((script) => script.nonce).filter(Boolean))], [nonce]);
    assert.doesNotMatch(html, /data-paqvilo-nonce-(?:pending|injected)-/);
    // The authored handler is hashed; the handler the record wrote is not.
    const policy = first.headers.get('content-security-policy');
    assert.ok(policy.includes(`'sha256-${hash("window.clicked = 'ran'")}'`), policy);
    assert.ok(!policy.includes(hash("window.dataHandler = 'ran'")), policy);
  });

// @test-kind observation: hosted session F3 (two runs, captures runs/a/csp-base and runs/b/csp-base) nonced the scripts and hashed the handlers a record wrote on a served page; a site observed with scriptNonceScope "every-script" is served the same way and reports nothing withheld
test('a served page of a site observed with every-script scope nonces the record-written script and hashes its handler', async (t) => {
  const portal = await startNoncePortal({
    observed: { scriptNonceScope: 'every-script', evidence: 'Invented nonce capture' },
  });
  t.after(() => portal.close());
  const response = await fetch(portal.sim.url + '/', { headers: { 'sec-fetch-dest': 'document' } });
  const html = await response.text();
  const nonce = pageNonce(response.headers);
  assert.ok(nonce);
  assert.deepEqual(
    scripts(html)
      .filter((script) => script.text.includes("window.injected = 'ran'"))
      .map((script) => script.nonce),
    [nonce],
  );
  assert.ok(response.headers.get('content-security-policy').includes(`'sha256-${hash("window.dataHandler = 'ran'")}'`));
  const { diagnostics } = await (
    await fetch(portal.sim.url + '/_sim/api/diagnostics', { headers: { 'x-sim-csrf': portal.sim.csrf } })
  ).json();
  assert.deepEqual(
    diagnostics.filter((entry) => entry.code === 'PORTAL_CSP_NONCE_WITHHELD'),
    [],
  );
});

// Record names a security review tried against the served page: none of their scripts may carry the response's nonce.
const SERVED_PAYLOADS = [
  "<script>window.injected='plain'</script>",
  "<script x=>window.injected='empty-unquoted-value'</script>",
  "<script x =>window.injected='empty-value-space'</script>",
  "<SCRIPT>window.injected='upper'</SCRIPT>",
  "<script/x>window.injected='slash'</script>",
  "<script x=a/>window.injected='slashval'</script>",
  "<script x=/>window.injected='slashonly'</script>",
  "<svg><script>window.injected='svg'</script></svg>",
  "<template><script>window.injected='tpl'</script></template>",
  "<!--<script>window.injected='comment'</script>-->",
  "<svg><![CDATA[</svg><script>window.injected='cdata'</script>]]></svg>",
  '<script nonce="abc">window.injected=\'nonceattr\'</script>',
  "<script data-paqvilo-nonce-pending-0000>window.injected='fakemarker'</script>",
  "<script data-paqvilo-nonce-injected-000000000000000000000000>window.injected='fakeinjected'</script>",
  "</script><script>window.injected='split'</script><script>",
  "<script>window.injected='unterminated'",
  '<math><mtext><table><mglyph><style><img src=x onerror="window.injected=\'mxss\'">',
  '<noscript><p title="</noscript><script>window.injected=\'noscript\'</script>">',
  "<script\nx=\n>window.injected='newline-empty'</script>",
  "<script x='' y=>window.injected='second-empty'</script>",
  '<iframe srcdoc="<script>window.injected=\'srcdoc\'</script>"></iframe>',
  '<div title="<head><script>window.injected=\'head\'</script>"></div>',
  '<div title="<body></body><script>window.injected=\'body\'</script>"></div>',
];

/** Serves each case on its own nonce portal, `limit` at a time; returns [{ variant, target, dest, html, headers }]. */
async function servedCases(cases, targets, limit = 4) {
  const answers = [];
  const queue = [...cases];
  const worker = async () => {
    while (queue.length) {
      const variant = queue.shift();
      const portalCase = await startNoncePortal(variant);
      try {
        for (const target of targets)
          for (const dest of [null, 'document']) {
            const response = await fetch(portalCase.sim.url + target, {
              headers: dest ? { 'sec-fetch-dest': dest } : {},
            });
            answers.push({
              variant,
              target,
              dest,
              status: response.status,
              headers: response.headers,
              html: await response.text(),
            });
          }
      } finally {
        await portalCase.close();
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return answers;
}

/**
 * The record's scripts (by their text or attributes) that carry the response's nonce, and whether one of the response's
 * markers leaked (the record's guessed marker, all zeros, is the record's text).
 */
const servedFindings = ({ html, headers }) => {
  const nonce = pageNonce(headers);
  return {
    nonce: Boolean(nonce),
    nonced: scriptAttributes(html)
      .filter((script) => script.nonce === nonce && /injected/.test(script.text + JSON.stringify(script.attrs)))
      .map((script) => script.text.slice(0, 60)),
    markerLeak: /data-paqvilo-nonce-(?:pending|injected)-(?!0{24})[0-9a-f]{24}/.test(html),
  };
};

test('no record markup from the review payloads gets the nonce on the page, the modal form or the quick view', async () => {
  const answers = await servedCases(
    SERVED_PAYLOADS.map((name) => ({ name })),
    ['/', NONCE_MODAL_PATH, NONCE_QUICK_VIEW_PATH],
  );
  assert.equal(answers.length, SERVED_PAYLOADS.length * 6);
  for (const answer of answers)
    assert.deepEqual(
      { status: answer.status, ...servedFindings(answer) },
      { status: 200, nonce: true, nonced: [], markerLeak: false },
      `${JSON.stringify(answer.variant.name)} ${answer.target} ${answer.dest}`,
    );
});

test("a page without its own head keeps record markup that holds <head> or <body> inert; the runtime's scripts keep the nonce", async () => {
  const answers = await servedCases(
    SERVED_PAYLOADS.slice(-2).map((name) => ({ name, headerAndFooter: false })),
    ['/'],
  );
  for (const answer of answers) {
    const label = `${JSON.stringify(answer.variant.name)} ${answer.dest}`;
    assert.deepEqual(
      { status: answer.status, ...servedFindings(answer) },
      { status: 200, nonce: true, nonced: [], markerLeak: false },
      label,
    );
    // The record's value stays one attribute value: no script of the record is live, and no runtime text lands in it.
    assert.ok(!scripts(answer.html).some((script) => script.text.includes('window.injected')), label);
    const runtime = scriptAttributes(answer.html).find((script) => 'data-paqvilo-mirage-runtime' in script.attrs);
    assert.equal(runtime?.nonce, pageNonce(answer.headers), label);
  }
});

test('an authored script that an SVG context from a record reaches keeps no nonce, with | escape or | json', async () => {
  const answers = await servedCases(
    ['{{ c.x_name | escape }}', '{{ c.x_name | json }}'].map((interpolated) => ({
      // | escape writes the quote as &quot;, | json leaves &quot; as it is: inside an SVG script both decode to `"`.
      name: '</div><svg>"&quot;;window.injected=1;//',
      interpolated,
    })),
    ['/'],
    2,
  );
  for (const answer of answers) {
    const label = `${answer.variant.interpolated} ${answer.dest}`;
    const nonce = pageNonce(answer.headers);
    assert.ok(nonce, label);
    const interpolated = scriptAttributes(answer.html).filter((script) => script.text.includes('window.interpolated'));
    assert.equal(interpolated.length, 1, label);
    assert.equal(interpolated[0].nonce, null, label);
    assert.ok(
      scriptAttributes(answer.html).some(
        (script) => script.text.includes("window.authored = 'ran'") && script.nonce === nonce,
      ),
      label,
    );
  }
});

test('an authored script after select content from a record keeps no nonce on the page', async () => {
  const answers = await servedCases(
    SELECT_OPENERS.map((opener) => ({
      name: `${opener}";window.injected=1;//`,
      interpolated: '{{ c.x_name | escape }}',
    })),
    ['/'],
  );
  assert.equal(answers.length, SELECT_OPENERS.length * 2);
  for (const answer of answers) {
    const label = `${answer.variant.name} ${answer.dest}`;
    const nonce = pageNonce(answer.headers);
    assert.ok(nonce, label);
    const interpolated = scriptAttributes(answer.html).filter((script) => script.text.includes('window.interpolated'));
    assert.deepEqual(
      interpolated.map((script) => script.nonce),
      [null],
      label,
    );
    assert.ok(
      scriptAttributes(answer.html).some(
        (script) => script.text.includes("window.authored = 'ran'") && script.nonce === nonce,
      ),
      label,
    );
  }
});

test('a handler a record merges onto the page html or body element is not hashed into the served policy', async () => {
  const handlers = ["window.injected = 'body'", "window.injected = 'html'"];
  const answers = await servedCases(
    [true, false].flatMap((headerAndFooter) => [
      { name: `<body onload="${handlers[0]}">`, headerAndFooter },
      { name: `<html onclick="${handlers[1]}">`, headerAndFooter },
    ]),
    ['/'],
  );
  assert.equal(answers.length, 8);
  for (const answer of answers) {
    const label = `${answer.variant.name} ${answer.variant.headerAndFooter} ${answer.dest}`;
    const policy = answer.headers.get('content-security-policy');
    assert.ok(pageNonce(answer.headers), label);
    // The record's handler is on the document's html or body element, without its hash in the policy.
    const root = parse(answer.html).childNodes.find((node) => node.tagName === 'html');
    const elements = [root, root.childNodes.find((node) => node.tagName === 'body')];
    assert.ok(
      elements.some((node) => node.attrs.some((attr) => handlers.includes(attr.value))),
      label,
    );
    for (const handler of handlers) assert.ok(!policy.includes(hash(handler)), `${label} ${policy}`);
    // The authored handler keeps its hash.
    assert.ok(policy.includes(`'sha256-${hash("window.clicked = 'ran'")}'`), `${label} ${policy}`);
  }
});

// @test-kind security+observation: the served page withholds the nonce from data-written markup and reports it; a response without scripts carries the policy with a nonce no script has, as hosted session F3 sent it on the token fragment (run a, captures runs/a/csp-custom)
test('the served page reports the script markup it withholds the nonce from, and data responses omit the nonce policy', async () => {
  const { sim } = await servedPortal();
  await (await fetch(sim.url + '/')).text();
  const { diagnostics } = await (
    await fetch(sim.url + '/_sim/api/diagnostics', { headers: { 'x-sim-csrf': sim.csrf } })
  ).json();
  const withheld = diagnostics.filter((entry) => entry.code === 'PORTAL_CSP_NONCE_WITHHELD');
  assert.deepEqual(
    withheld.map((entry) => [entry.path, entry.scripts, entry.handlers]),
    [['/', 1, 1]],
  );
  assert.doesNotMatch(JSON.stringify(withheld), /window\.|dataHandler|'ran'/);
  // The anti-forgery fragment has no scripts. It carries the site's nonce policy with a fresh nonce and the literal
  // 'inject-hashes', as hosted session F3 sent it there (run a, captures runs/a/csp-custom); the report-only policy,
  // whose hosted text is not observed, keeps its omission.
  const token = await fetch(sim.url + '/_layout/tokenhtml');
  await token.text();
  assert.equal(token.status, 200);
  assert.equal(token.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(
    token.headers.get('content-security-policy'),
    /'nonce-[^']+' 'sha256-[^']+' 'unsafe-hashes' 'inject-hashes'/,
  );
  assert.equal(token.headers.get('content-security-policy-report-only'), null);
});

test('the platform sign-in page in the site shell nonces every script it serves', async () => {
  const { sim } = await servedPortal();
  for (const dest of [null, 'document']) {
    const response = await fetch(sim.url + '/SignIn', { headers: dest ? { 'sec-fetch-dest': dest } : {} });
    const html = await response.text();
    assert.equal(response.status, 200, html.slice(0, 400));
    const nonce = pageNonce(response.headers);
    assert.ok(nonce, response.headers.get('content-security-policy'));
    const found = scripts(html);
    assert.ok(found.length > 0);
    assert.deepEqual(
      found.filter((script) => script.nonce !== nonce),
      [],
    );
    assert.doesNotMatch(html, /data-paqvilo-nonce-pending-/);
  }
});

// @test-kind contract: Paqvilo's loopback transport adaptation: the hosted site is HTTPS, the local listener http loopback, which an https: scheme source does not match (CSP Level 3 scheme-source matching); each directive with https: and without 'self' also gets 'self' in local responses, reported once by an info diagnostic
test('https: scheme sources of the site policies also admit the loopback origin; nothing else changes', () => {
  // The site's policy as the loopback listener sends it.
  const adaptLoopbackTransport = (policy) =>
    siteHeaders(portal({ 'HTTP/Content-Security-Policy': policy }))['content-security-policy'];
  assert.equal(
    adaptLoopbackTransport(
      "default-src 'none'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: 'self'",
    ),
    "default-src 'none'; style-src 'unsafe-inline' https: 'self'; img-src https: data: 'self'; font-src https: 'self'",
  );
  // A host source is not the scheme source.
  assert.equal(adaptLoopbackTransport('img-src https://cdn.example.test'), 'img-src https://cdn.example.test');
  const site = portal({
    'HTTP/Content-Security-Policy': 'img-src https:',
    'HTTP/Content-Security-Policy-Report-Only': "style-src https: 'nonce'",
  });
  const headers = siteHeaders(site, { nonce: NONCE, confinement: "img-src 'self' data:" });
  // The confinement policy is the runtime's own: it is not adapted.
  assert.deepEqual(headers['content-security-policy'], ["img-src https: 'self'", "img-src 'self' data:"]);
  assert.equal(headers['content-security-policy-report-only'], `style-src https: 'nonce-${NONCE}' 'self'`);
  assert.equal(siteHeaders(site, { loopback: false })['content-security-policy'], 'img-src https:');
  const [diagnostic] = siteHttpPolicyDiagnostics(site);
  assert.deepEqual(
    [diagnostic.code, diagnostic.severity, diagnostic.settings, diagnostic.directives],
    [
      'PORTAL_HTTP_CSP_LOOPBACK_TRANSPORT',
      'info',
      ['http/content-security-policy', 'http/content-security-policy-report-only'],
      ['img-src', 'style-src'],
    ],
  );
  assert.deepEqual(siteHttpPolicyDiagnostics(portal({ 'HTTP/Content-Security-Policy': "img-src 'self' https:" })), []);
});

test('a document whose provenance binds every unowned tag is decided on what its builder proved', () => {
  // The builder bound its own script; the record's markup reached the document as plain text, which the document's
  // blanket platform pass then binds like any other unowned tag.
  const builder = fragmentOf([
    { platform: '<!doctype html><html><head><script>window.builder = 1;</script></head><body>' },
    { raw: '<script>window.record = 1;</script>' },
    { platform: '</body></html>' },
  ]);
  const blanket = fragmentOf([
    { platform: '<!doctype html><html><head><script>window.builder = 1;</script></head><body>' },
    { platform: '<script>window.record = 1;</script>' },
    { platform: '</body></html>' },
  ]);
  assert.equal(builder.fragment.text, blanket.fragment.text);
  const proved = finalizePortalProvenance({
    fragment: blanket.fragment,
    index: blanket.index,
    scriptNonce: { nonce: NONCE, pending: 'data-p', trust: builder.fragment },
  });
  assert.deepEqual(
    scripts(proved.html).map((script) => [script.text, script.nonce]),
    [
      ['window.builder = 1;', NONCE],
      ['window.record = 1;', null],
    ],
  );
  // A trust fragment of another text proves nothing.
  const other = finalizePortalProvenance({
    fragment: blanket.fragment,
    index: blanket.index,
    scriptNonce: { nonce: NONCE, pending: 'data-p', trust: { text: 'other', intervals: [] } },
  });
  assert.deepEqual(
    scripts(other.html).map((script) => script.nonce),
    [null, null],
  );
});

for (const [name, target] of [
  ['modal form', NONCE_MODAL_PATH],
  ['quick view', NONCE_QUICK_VIEW_PATH],
])
  test(`the ${name} document carries the nonce policy and nonces the scripts its builder and the runtime write`, async () => {
    const { sim } = await servedPortal();
    const nonces = [];
    for (const dest of [null, 'iframe']) {
      const response = await fetch(sim.url + target, { headers: dest ? { 'sec-fetch-dest': dest } : {} });
      const html = await response.text();
      assert.equal(response.status, 200, html.slice(0, 400));
      const nonce = pageNonce(response.headers);
      assert.ok(nonce, `${dest}: ${response.headers.get('content-security-policy')}`);
      assert.equal(pageNonce(response.headers, 'content-security-policy-report-only'), nonce);
      nonces.push(nonce);
      const found = scripts(html);
      // The platform shell and bundles, the server form's scripts, the exported Head/Bottom snippet, the local
      // runtime and the frame readiness script all carry it; nothing is left without it.
      assert.ok(found.length > 10, String(found.length));
      assert.deepEqual(
        found.filter((script) => script.nonce !== nonce).map((script) => script.text.slice(0, 60)),
        [],
      );
      assert.deepEqual(
        found.filter((script) => script.text.includes("window.headBottom = 'ran'")).map((script) => script.nonce),
        [nonce],
      );
      // The runtime's own scripts added by the document's final statement: frame readiness (both), the runtime (modal).
      assert.ok(found.some((script) => script.attributes.includes('data-paqvilo-frame-ready')));
      if (name === 'modal form')
        assert.ok(found.some((script) => script.attributes.includes('data-paqvilo-mirage-runtime')));
      assert.doesNotMatch(html, /data-paqvilo-nonce-pending-/);
      if (dest) assert.ok(response.headers.get('x-paqvilo-provenance'), 'a framed document still publishes its proof');
    }
    assert.notEqual(nonces[0], nonces[1]);
  });

test('the search page carries the nonce policy; it proves no script', async () => {
  const { sim } = await servedPortal();
  const response = await fetch(sim.url + '/search/?q=invented');
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 400));
  assert.equal(response.headers.get('x-sim-route'), 'portal-search-local');
  assert.ok(pageNonce(response.headers));
  assert.deepEqual(scripts(html), []);
});

test('a custom error page carries the nonce policy and withholds the nonce from the error snippet it cannot prove', async () => {
  const portalError = await startNoncePortal({
    files: {
      'Generic-Error.contentsnippet.yml':
        'adx_contentsnippetid: generic-error\nadx_name: Portal Generic Error\nadx_type: 756150001',
      'Generic-Error.contentsnippet.value.html': "<h1>Invented error</h1><script>window.errorSnippet = 'ran';</script>",
    },
    observed: {
      requestValidation: 'aspnet-query',
      pageErrorPresentation: 'generic-error',
      evidence: 'Invented error presentation fixture',
    },
  });
  try {
    const { sim } = portalError;
    for (const dest of [null, 'document']) {
      const response = await fetch(sim.url + '/?q=%3Cb', { headers: dest ? { 'sec-fetch-dest': dest } : {} });
      const html = await response.text();
      assert.equal(response.status, 500, html.slice(0, 400));
      assert.match(html, /Invented error/);
      const nonce = pageNonce(response.headers);
      assert.ok(nonce, response.headers.get('content-security-policy'));
      // The snippet's script and the error page's DevTools server log script (hosted session F3: it has no nonce
      // either) are both unproved.
      assert.deepEqual(
        scripts(html).map((script) => [
          /updateDevToolRuntime/.test(script.text) ? 'devtools-log' : script.text,
          script.nonce,
        ]),
        [
          ['devtools-log', null],
          ["window.errorSnippet = 'ran';", null],
        ],
      );
      assert.doesNotMatch(html, /data-paqvilo-nonce-pending-/);
    }
    const { diagnostics } = await (
      await fetch(sim.url + '/_sim/api/diagnostics', { headers: { 'x-sim-csrf': sim.csrf } })
    ).json();
    // Both scripts above are withheld: the snippet's and the server log's.
    assert.deepEqual(
      diagnostics
        .filter((entry) => entry.code === 'PORTAL_CSP_NONCE_WITHHELD')
        .map((entry) => [entry.path, entry.scripts]),
      [['/', 2]],
    );
  } finally {
    await portalError.close();
  }
});
