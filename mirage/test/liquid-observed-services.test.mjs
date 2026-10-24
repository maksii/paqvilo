import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { observedChartMarkup } from '../lib/liquid-service-observations.mjs';

const WEBSITE = '10000000-0000-4000-8000-000000000001';
function fixture(observed, extra = {}) {
  const portal = {
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: { id: WEBSITE },
    pageTemplates: [],
    forms: [],
    advancedForms: [],
    lists: [],
    serverLogics: [],
    observed,
    ...extra.portal,
  };
  const engine = createPortalRenderer(portal, {
    ...extra,
    renderComponent: (kind, args, context) =>
      renderComponent(kind, args?.name ?? args?.id ?? args?.key ?? '', context, {
        portal,
        args,
        observed,
        metadata: { views: [] },
        ...extra.components,
      }),
  });
  return { engine, portal };
}
const observed = { liquidServiceTags: 'observed' };

test('missing named components keep the pinned behavior unless the site opts in', async () => {
  const { engine } = fixture();
  assert.equal(await engine.renderString("a{% webform name:'Missing' %}b"), 'ab');
  assert.equal(await engine.renderString("a{% entitylist result name:'Missing' %}body{% endentitylist %}b"), 'abodyb');
  assert.equal(await engine.renderString("a{% entityview result name:'Missing' %}body{% endentityview %}b"), 'abodyb');
  // searchindex runs portal search (lib/portal-search.mjs): without an indexed table it answers no results and a diagnostic.
  assert.equal(
    await engine.renderString(
      "{% searchindex result name:'Missing' %}{{ searchindex.approximate_total_hits }}|{{ searchindex.results.size }}{% endsearchindex %}",
    ),
    '0|0',
  );
  await assert.rejects(engine.renderString("{% chart id:'chart' viewid:'view' %}"), (error) => error.status === 501);
});

test('observed missing webform/list errors render inline and missing view suppresses only its block', async () => {
  const { engine } = fixture(observed);
  assert.equal(
    await engine.renderString("a{% webform name:'Missing' %}b"),
    'aLiquid error: Sequence contains no matching elementb',
  );
  assert.equal(
    await engine.renderString("a{% entitylist result name:'Missing' %}body{% endentitylist %}b"),
    'aLiquid error: Sequence contains no matching elementb',
  );
  assert.equal(await engine.renderString("a{% entityview result name:'Missing' %}body{% endentityview %}b"), 'ab');
  assert.equal(await engine.renderString("a{% entityform name:'Missing' %}b"), 'ab');
  assert.equal(await engine.renderString('a{% webform %}b'), 'ab');
});

test('observed unsupported search renders its bounded Liquid error and retains surrounding output', async () => {
  const { engine } = fixture(observed);
  assert.equal(
    await engine.renderString("a{% searchindex result name:'Missing' %}body{% endsearchindex %}b"),
    'aLiquid error: There were no exact matches. Make sure search is enabled for this environment.b',
  );
});

test('observed chart emits escaped source-derived placeholder markup and explicitly reports no chart execution', async () => {
  const diagnostics = [];
  const { engine } = fixture(observed, { components: { diagnostic: (entry) => diagnostics.push(entry) } });
  assert.equal(
    await engine.renderString("{% chart id:'chart' viewid:'view' %}", { __language: { code: 'fr-CA' } }),
    `<div class="crm-chart" data-chartid="chart" data-lang="fr-CA" data-serviceurl="/_services/visualizations/get-chart-builder?__portalScopeId__=${WEBSITE}" data-viewid="view"></div>`,
  );
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['LIQUID_CHART_MARKUP_ONLY'],
  );
  const escaped = observedChartMarkup(
    { id: '" onerror="bad()', viewid: '<bad>&' },
    { website: { selected_language: { code: 'es-MX' } } },
    { observed, portal: { website: { id: WEBSITE } } },
  );
  assert.match(escaped, /data-chartid="&quot; onerror=&quot;bad\(\)"/);
  assert.match(escaped, /data-viewid="&lt;bad&gt;&amp;"/);
  assert.equal(observedChartMarkup({ id: 'chart' }, {}, { observed, portal: { website: { id: WEBSITE } } }), null);
});

test('service observations do not rewrite existing provider authorization failures', async () => {
  const denied = Object.assign(new Error('Denied'), { status: 403, code: 'PermissionDenied' });
  const { engine } = fixture(observed, {
    components: {
      metadata: { views: [{ id: 'view', entity: 'sample', name: 'Existing' }] },
      store: {
        resolveMapping() {
          throw denied;
        },
      },
    },
  });
  await assert.rejects(
    engine.renderString("{% entityview name:'Existing' logical_name:'sample' %}body{% endentityview %}"),
    (error) => error.code === 'PermissionDenied',
  );
});

test('observed missing server logic is404, existing unhandled stays501, and adapters still win', async () => {
  const source =
    "{% serverlogic name:'Missing', operation:'probe', output:result %}{{ result.success }}|{{ result.status_code }}";
  assert.equal(await fixture().engine.renderString(source), 'false|501');
  assert.equal(await fixture(observed).engine.renderString(source), 'false|404');
  assert.equal(
    await fixture(observed, { portal: { serverLogics: [{ name: 'missing' }] } }).engine.renderString(source),
    'false|501',
  );
  assert.equal(
    await fixture(observed, { serverLogic: async () => ({ success: true, status_code: 200 }) }).engine.renderString(
      source,
    ),
    'true|200',
  );
});

test('observed service failures retain HTTP200 and server logic404 through the loopback renderer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liquid-service-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source =
    "A{% webform name:'Missing' %}|{% entitylist name:'Missing' %}hidden{% endentitylist %}|{% entityview name:'Missing' %}hidden{% endentityview %}|{% searchindex name:'Missing' %}hidden{% endsearchindex %}|{% chart id:'chart' viewid:'view' %}|{% serverlogic name:'Missing', operation:'probe', output:result %}{{ result.success }}:{{ result.status_code }}Z";
  const files = {
    'website.yml': `adx_websiteid: ${WEBSITE}\nadx_name: Fixture`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: layout',
    'Layout.pagetemplate.yml':
      'adx_pagetemplateid: layout\nadx_name: Layout\nadx_webtemplateid: source\nadx_usewebsiteheaderandfooter: false',
    'Source.webtemplate.yml': 'adx_webtemplateid: source\nadx_name: Source',
    'Source.webtemplate.source.html': source,
  };
  for (const [file, value] of Object.entries(files)) await fs.writeFile(path.join(root, file), value);
  for (const mode of ['dotliquid', 'observed']) {
    const app = await createSimulator({
      sourceDir: root,
      stateFile: path.join(root, mode + '-state.json'),
      watch: false,
      observed: { liquidServiceTags: mode, evidence: 'loopback/service-contract.json' },
    });
    try {
      const response = await fetch(app.url),
        body = await response.text();
      assert.equal(response.status, mode === 'observed' ? 200 : 501);
      if (mode === 'observed') {
        assert.match(
          body,
          /A(?:Liquid error: Sequence contains no matching element\|){2}\|Liquid error: There were no exact matches\./,
        );
        assert.match(body, /data-chartid="chart"[^>]*data-viewid="view"/);
        assert.match(body, /false:404Z$/);
      }
    } finally {
      await app.close();
    }
  }
});
