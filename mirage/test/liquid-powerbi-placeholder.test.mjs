import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { renderComponent } from '../lib/platform.mjs';

// Mirrors the server's component host: the native tag has no name, so the name argument is empty.
function fixture(diagnostics) {
  const portal = { templates: {}, snippets: {}, settings: {}, pages: [], webFiles: [], records: [], weblinks: {}, sitemarkers: {}, website: { id: '10000000-0000-4000-8000-000000000001' }, pageTemplates: [], forms: [], advancedForms: [], lists: [], serverLogics: [] };
  return createPortalRenderer(portal, {
    renderComponent: (kind, args, context) => renderComponent(kind, args?.name ?? args?.id ?? args?.key ?? '', context, { portal, args, metadata: { views: [] }, diagnostic: entry => diagnostics.push(entry) }),
  });
}

const SOURCE = "{% powerbi path: 'https://app.powerbi.example.test/groups/g1/reports/r1?ctid=secret-tenant&rp=secret-token', authentication_type: 'AAD', roles: 'Viewer', tileid: 'tile-1', filter: 'Sales/Region' %}";

test('native powerbi tag renders a labelled placeholder with redacted query values and no request', async t => {
  const diagnostics = [];
  // A placeholder never reaches the network: any fetch from the renderer fails the test.
  t.mock.method(globalThis, 'fetch', () => { throw new Error('powerbi placeholder must not fetch'); });
  const html = await fixture(diagnostics).renderString(`a${SOURCE}b`);
  assert.match(html, /^a<div class="paqvilo-powerbi-placeholder" data-mirage-component="powerbi" /);
  assert.match(html, /data-powerbi-path="https:\/\/app\.powerbi\.example\.test\/groups\/g1\/reports\/r1\?ctid=\[redacted\]&amp;rp=\[redacted\]"/);
  assert.match(html, /data-powerbi-authentication-type="AAD"/);
  assert.match(html, /data-powerbi-roles="Viewer"/);
  assert.match(html, /data-powerbi-tileid="tile-1"/);
  assert.match(html, /data-powerbi-filter="Sales\/Region"/);
  assert.match(html, /Power BI report is not rendered locally\.<\/div>b$/);
  assert.doesNotMatch(html, /secret-/);
  assert.deepEqual(diagnostics.map(entry => entry.code), ['LIQUID_POWERBI_PLACEHOLDER']);
  assert.equal(diagnostics[0].component, 'powerbi');
});

test('powerbi placeholder redacts fragment values and relative paths', async () => {
  const fragment = await fixture([]).renderString("{% powerbi path: 'https://x/r#access_token=abc' %}");
  assert.match(fragment, /data-powerbi-path="https:\/\/x\/r#access_token=\[redacted\]"/);
  const relative = await fixture([]).renderString("{% powerbi path: 'groups/x?key=v&other=w' %}");
  assert.match(relative, /data-powerbi-path="groups\/x\?key=\[redacted\]&amp;other=\[redacted\]"/);
  assert.doesNotMatch(fragment + relative, /abc|=v\b|=w\b/);
});

test('named powerbi tag no longer fails with COMPONENT_UNSUPPORTED', async () => {
  const diagnostics = [];
  const html = await fixture(diagnostics).renderString("{% powerbi name: 'Report', path: 'https://app.powerbi.example.test/reports/r1' %}");
  assert.match(html, /class="paqvilo-powerbi-placeholder"/);
  assert.deepEqual(diagnostics.map(entry => entry.code), ['LIQUID_POWERBI_PLACEHOLDER']);
});

test('powerbi placeholder escapes attribute values and omits absent inputs', async () => {
  const diagnostics = [];
  const html = await fixture(diagnostics).renderString(`{% powerbi path: 'x" onerror="bad()' %}`);
  assert.match(html, /data-powerbi-path="x&quot; onerror=&quot;bad\(\)"/);
  assert.doesNotMatch(html, /data-powerbi-roles|data-powerbi-tileid|data-powerbi-filter/);
  const bare = await fixture([]).renderString('{% powerbi %}');
  assert.equal(bare, '<div class="paqvilo-powerbi-placeholder" data-mirage-component="powerbi">Power BI report is not rendered locally.</div>');
});
