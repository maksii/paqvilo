import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { createServiceFixtureRegistry } from '../lib/service-fixtures.mjs';
import { observedConfig } from '../lib/project-config.mjs';

// Mirrors the server's component host: the native tag has no name, so the name argument is empty.
function fixture(diagnostics, options = {}) {
  const portal = {
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: { id: '10000000-0000-4000-8000-000000000001' },
    pageTemplates: [],
    forms: [],
    advancedForms: [],
    lists: [],
    serverLogics: [],
  };
  return createPortalRenderer(portal, {
    renderComponent: (kind, args, context) =>
      renderComponent(kind, args?.name ?? args?.id ?? args?.key ?? '', context, {
        portal,
        args,
        metadata: { views: [] },
        ...options,
        diagnostic: (entry) => diagnostics.push(entry),
      }),
  });
}

const SOURCE =
  "{% powerbi path: 'https://app.powerbi.example.test/groups/g1/reports/r1?ctid=secret-tenant&rp=secret-token', authentication_type: 'AAD', roles: 'Viewer', tileid: 'tile-1', filter: 'Sales/Region' %}";

test('native powerbi tag renders a labelled placeholder with redacted query values and no request', async (t) => {
  const diagnostics = [];
  // A placeholder never reaches the network: any fetch from the renderer fails the test.
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('powerbi placeholder must not fetch');
  });
  const html = await fixture(diagnostics).renderString(`a${SOURCE}b`);
  assert.match(html, /^a<div class="paqvilo-powerbi-placeholder" data-mirage-component="powerbi" /);
  assert.match(
    html,
    /data-powerbi-path="https:\/\/app\.powerbi\.example\.test\/groups\/g1\/reports\/r1\?ctid=\[redacted\]&amp;rp=\[redacted\]"/,
  );
  assert.match(html, /data-powerbi-authentication-type="AAD"/);
  assert.match(html, /data-powerbi-roles="Viewer"/);
  assert.match(html, /data-powerbi-tileid="tile-1"/);
  assert.match(html, /data-powerbi-filter="Sales\/Region"/);
  assert.match(html, /Power BI report is not rendered locally\.<\/div>b$/);
  assert.doesNotMatch(html, /secret-/);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['LIQUID_POWERBI_PLACEHOLDER'],
  );
  assert.equal(diagnostics[0].component, 'powerbi');
});

test('site-observed empty Power BI output requires evidence and does not infer integration state', async () => {
  assert.throws(() => observedConfig({ powerBiOutput: 'empty' }), /evidence/);
  assert.throws(() => observedConfig({ powerBiOutput: 'enabled', evidence: 'invented capture' }), /powerBiOutput/);
  const diagnostics = [];
  const observed = observedConfig({ powerBiOutput: 'empty', evidence: 'invented capture of five native outputs' });
  for (const source of [SOURCE, '{% powerbi %}', "{% powerbi path: 'invalid' %}"]) {
    assert.equal(await fixture(diagnostics, { observed }).renderString(`before${source}after`), 'beforeafter');
  }
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    Array(3).fill('LIQUID_POWERBI_OBSERVED_EMPTY'),
  );
});

test('trusted Power BI fixtures receive evaluated arguments and override observed empty output', async () => {
  const calls = [];
  const serviceFixtures = createServiceFixtureRegistry({
    packs: [
      {
        id: 'invented-report',
        serviceFixtures: {
          powerBi: {
            embed: (input) => {
              calls.push(input);
              return { html: '<p id="invented-report">Local chart fixture</p>' };
            },
          },
        },
      },
    ],
  });
  const diagnostics = [];
  const html = await fixture(diagnostics, { serviceFixtures, observed: { powerBiOutput: 'empty' } }).renderString(
    "{% assign report = 'invented' %}{% powerbi path: report, roles: 'Viewer' %}",
  );
  assert.equal(html, '<p id="invented-report">Local chart fixture</p>');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { path: 'invented', roles: 'Viewer' });
  assert.deepEqual(diagnostics, []);
});

test('invalid fixture results are diagnosed or rejected without exposing fixture errors', async () => {
  const registry = (run) =>
    createServiceFixtureRegistry({ packs: [{ id: 'invented-report', serviceFixtures: { powerBi: { embed: run } } }] });
  const diagnostics = [];
  assert.match(
    await fixture(diagnostics, {
      serviceFixtures: registry(() => ({ error: { message: 'secret-query' } })),
    }).renderString(SOURCE),
    /paqvilo-powerbi-placeholder/,
  );
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['LIQUID_POWERBI_FIXTURE_UNAVAILABLE', 'LIQUID_POWERBI_PLACEHOLDER'],
  );
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-query/);
  for (const result of [{ html: 42 }, Promise.resolve({ html: 'late' })]) {
    await assert.rejects(
      renderComponent('powerbi', '', {}, { args: {}, serviceFixtures: registry(() => result) }),
      /synchronously return/,
    );
  }
});

test('powerbi placeholder redacts fragment values and relative paths', async () => {
  const fragment = await fixture([]).renderString("{% powerbi path: 'https://x/r#access_token=abc' %}");
  assert.match(fragment, /data-powerbi-path="https:\/\/x\/r#access_token=\[redacted\]"/);
  const relative = await fixture([]).renderString("{% powerbi path: 'groups/x?key=v&other=w' %}");
  assert.match(relative, /data-powerbi-path="groups\/x\?key=\[redacted\]&amp;other=\[redacted\]"/);
  assert.doesNotMatch(fragment + relative, /abc|=v\b|=w\b/);
});

test('a named powerbi tag renders the same placeholder as the native unnamed tag', async () => {
  const diagnostics = [];
  const html = await fixture(diagnostics).renderString(
    "{% powerbi name: 'Report', path: 'https://app.powerbi.example.test/reports/r1' %}",
  );
  assert.match(html, /class="paqvilo-powerbi-placeholder"/);
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['LIQUID_POWERBI_PLACEHOLDER'],
  );
});

test('powerbi placeholder escapes attribute values and omits absent inputs', async () => {
  const diagnostics = [];
  const html = await fixture(diagnostics).renderString(`{% powerbi path: 'x" onerror="bad()' %}`);
  assert.match(html, /data-powerbi-path="x&quot; onerror=&quot;bad\(\)"/);
  assert.doesNotMatch(html, /data-powerbi-roles|data-powerbi-tileid|data-powerbi-filter/);
  const bare = await fixture([]).renderString('{% powerbi %}');
  assert.equal(
    bare,
    '<div class="paqvilo-powerbi-placeholder" data-mirage-component="powerbi">Power BI report is not rendered locally.</div>',
  );
});
