import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { createServiceFixtureRegistry } from '../lib/service-fixtures.mjs';

// The server's component host passes the tag inputs; the native powerbi tag has no name.
function renderer(diagnostics, options = {}) {
  const site = { settings: {} };
  const host = (kind, args, context) =>
    renderComponent(kind, '', context, {
      ...options,
      portal: site,
      args,
      diagnostic: (entry) => diagnostics.push(entry),
    });
  return createPortalRenderer(site, { renderComponent: host });
}

// An invented Publish to web key; the URL shape is Power BI's public embed code URL.
const PUBLIC_REPORT = 'https://app.powerbi.com/view?r=inventedEmbedKey01&pageName=Overview';
const IFRAME =
  '<iframe class="powerbi" data-mirage-component="powerbi" title="Power BI report" src="https://app.powerbi.com/view?r=inventedEmbedKey01&amp;pageName=Overview" frameborder="0" allowfullscreen="true"></iframe>';

// @test-kind compatibility: Learn "Dataverse Liquid tags" powerbi: Anonymous (case-insensitive, the default authentication type) embeds a Publish to web report
test('an anonymous powerbi tag renders the Publish to web report as an iframe without a request', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('an anonymous embed is loaded by the browser, never by the renderer');
  });
  for (const type of [null, 'Anonymous', 'ANONYMOUS', ' anonymous ']) {
    const diagnostics = [];
    const auth = type === null ? '' : `, authentication_type: '${type}'`;
    const html = await renderer(diagnostics).renderString(`a{% powerbi path: '${PUBLIC_REPORT}'${auth} %}b`);
    assert.equal(html, `a${IFRAME}b`, String(type));
    assert.deepEqual(
      diagnostics.map((entry) => [entry.code, entry.severity]),
      [['LIQUID_POWERBI_ANONYMOUS_EMBED', 'info']],
    );
  }
});

// @test-kind compatibility: Learn "Dataverse Liquid tags" powerbi: an anonymous report does not support filtering; roles and tiles belong to secure embeds
test('an anonymous embed ignores filter, roles and tileid', async () => {
  const html = await renderer([]).renderString(
    `{% powerbi path: '${PUBLIC_REPORT}', filter: 'Table/Field eq 1', roles: 'Viewer', tileid: 'tile-1' %}`,
  );
  assert.equal(html, IFRAME);
});

// @test-kind security: only a Publish to web URL becomes a frame; a script, data, foreign or credentialed URL never does
test('an anonymous path that is not a Publish to web URL keeps the redacting placeholder', async () => {
  for (const path of [
    'javascript:alert(1)',
    'data:text/html,<p>x</p>',
    'http://app.powerbi.com/view?r=key',
    'https://app.powerbi.com.example.test/view?r=key',
    'https://example.test/view?r=key',
    'https://user:secret@app.powerbi.com/view?r=key',
    'https://app.powerbi.com:8443/view?r=key',
    'https://app.powerbi.com/reportEmbed?reportId=r1&autoAuth=true',
    'https://app.powerbi.com/view',
    'https://app.powerbi.com/view?r=',
    '/view?r=key',
  ]) {
    const diagnostics = [];
    const html = await renderer(diagnostics).renderString(`{% powerbi path: '${path}' %}`);
    assert.match(html, /^<div class="paqvilo-powerbi-placeholder" data-mirage-component="powerbi"/, path);
    assert.doesNotMatch(html, /<iframe/i, path);
    assert.doesNotMatch(html, /=key\b/, path);
    assert.deepEqual(
      diagnostics.map((entry) => entry.code),
      ['LIQUID_POWERBI_PLACEHOLDER'],
      path,
    );
  }
});

// @test-kind security: an embed URL with markup characters stays inside its quoted src attribute
test('the iframe src cannot break out of its attribute', async () => {
  const html = await renderer([]).renderString(
    `{% powerbi path: 'https://app.powerbi.com/view?r=k"><script>bad()</script>' %}`,
  );
  assert.match(
    html,
    /^<iframe class="powerbi" [^>]*src="https:\/\/app\.powerbi\.com\/view\?r=k[^"<>]*"[^>]*><\/iframe>$/,
  );
  assert.doesNotMatch(html, /<script/i);
});

// @test-kind contract: secure embeds (AAD, powerbiembedded) keep the placeholder; the diagnostic names the missing service principal
test('AAD and powerbiembedded reports keep the placeholder with a diagnostic that names the platform token', async () => {
  for (const type of ['AAD', 'aad', 'PowerBIEmbedded']) {
    const diagnostics = [];
    const html = await renderer(diagnostics).renderString(
      `{% powerbi authentication_type: '${type}', path: '${PUBLIC_REPORT}' %}`,
    );
    assert.match(html, /class="paqvilo-powerbi-placeholder"/, type);
    assert.doesNotMatch(html, /<iframe|inventedEmbedKey01/, type);
    assert.equal(diagnostics.length, 1, type);
    assert.equal(diagnostics[0].code, 'LIQUID_POWERBI_PLACEHOLDER');
    assert.equal(diagnostics[0].authenticationType, type.toLowerCase());
    assert.match(diagnostics[0].message, /service principal/);
    assert.match(diagnostics[0].message, /Lense/);
  }
});

// @test-kind contract: a site-observed empty output (integration off) and trusted fixtures keep their precedence over anonymous embeds
test('observed empty output and trusted fixtures take precedence over an anonymous embed', async () => {
  const diagnostics = [];
  const source = `{% powerbi path: '${PUBLIC_REPORT}' %}`;
  const empty = await renderer(diagnostics, { observed: { powerBiOutput: 'empty' } }).renderString(source);
  assert.equal(empty, '');
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['LIQUID_POWERBI_OBSERVED_EMPTY'],
  );
  const serviceFixtures = createServiceFixtureRegistry({
    packs: [
      {
        id: 'invented-report',
        serviceFixtures: { powerBi: { embed: () => ({ html: '<p id="invented-report">Local fixture</p>' }) } },
      },
    ],
  });
  assert.equal(
    await renderer([], { serviceFixtures }).renderString(source),
    '<p id="invented-report">Local fixture</p>',
  );
});

// @test-kind security: a user name or password inside a Power BI path never reaches the placeholder markup or its diagnostic
test('the placeholder redacts URL userinfo as well as query values', async () => {
  const sources = [
    "{% powerbi path: 'https://inventeduser:inventedpass@app.powerbi.com/view?r=inventedkey' %}",
    "{% powerbi authentication_type: 'AAD', path: 'https://inventeduser:inventedpass@app.powerbi.example.test/groups/g/reports/r?ctid=inventedtenant' %}",
    "{% powerbi path: 'https://inventeduser:p&x=inventedpass@app.powerbi.example.test/r' %}",
  ];
  for (const source of sources) {
    const diagnostics = [];
    const html = await renderer(diagnostics).renderString(source);
    assert.match(html, /^<div class="paqvilo-powerbi-placeholder"/, source);
    assert.match(html, /data-powerbi-path="https:\/\/\[redacted\]@app\.powerbi\./, source);
    assert.doesNotMatch(html + JSON.stringify(diagnostics), /invented(?:user|pass|key|tenant)/, source);
  }
});
