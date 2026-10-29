// The four view modules (services, flows, packs, capabilities) inside the real /_sim/ app (index.html + app.mjs) against
// a stateful fake JSON host: data renders on first entry without a manual refresh, actions show their effect,
// deep links, doc links from GET /status, the published route list instead of probes, load errors with their
// status, and visible help on every control.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { docsLinks } from '../lib/docs-links.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createTraceRoutes } from '../lib/sim-trace-routes.mjs';

const SHARED = new Set(['persona-search.mjs', 'persona-picker-view.mjs']);
const docs = docsLinks('0.9.4', 'https://git.example.test/invented/paqvilo');
// The host shape of `status.routes`: mounted /_sim/api route prefixes (organization-host.mjs simApiRoutes).
const POWER_PAGES_ROUTES = [
  '/dashboard',
  '/flow-runs',
  '/flow-waits',
  '/messages',
  '/outbox',
  '/packs',
  '/platform-settings',
  '/page-resources',
  '/personas',
  '/scenarios',
  '/status',
  '/state',
  '/environment',
];
const dashboard = () => ({
  generatedAt: new Date().toISOString(),
  runtime: { product: 'Mirage', kind: 'power-pages', simulationLevel: 'dry-run' },
  nodes: [
    {
      id: 'provider:storage',
      kind: 'provider',
      label: 'Storage',
      status: 'ready',
      detail: {
        providers: [{ id: 'local', kind: 'local', level: 'behaviour', ready: true, routes: ['dataverseFiles'] }],
      },
    },
    {
      id: 'provider:storage-route:dataverseFiles',
      kind: 'provider',
      label: 'dataverseFiles',
      status: 'ready',
      detail: { provider: 'local' },
    },
    {
      id: 'provider:messaging',
      kind: 'provider',
      label: 'Message bus',
      status: 'ready',
      level: 'behaviour',
      detail: { id: 'local' },
    },
  ],
  edges: [],
  activity: {
    messages: { active: 2 },
    jobs: { pending: 0 },
    webhooks: {},
    storage: { byProvider: [{ id: 'local', writes: 3, deletes: 0, bytesWritten: 12 }] },
  },
  configuration: { packs: [{ id: 'fx-pack', module: 'pack/fx-pack.mjs' }], solutionLayers: [], settingsKeys: [] },
});
const packs = {
  packs: [
    {
      id: 'fx-pack',
      name: 'Invented pack',
      module: 'pack/fx-pack.mjs',
      registration: { source: 'project' },
      matched: true,
      matchReason: 'matches({ portal }) returned true',
      exports: { serverLogics: 2 },
      presets: [{ id: 'fx-empty', name: 'Empty' }],
      configurationPresets: 0,
      personas: 0,
      personaCatalog: {},
      dataFiles: [{ file: 'data/fx.json', tables: ['x_item'], writable: true }],
      diagnostics: [],
    },
  ],
  failed: [],
  library: [{ id: 'fx-empty', name: 'Empty', pack: 'fx-pack', source: 'builtin' }],
};

async function host(t, { state, status, failPacks = 0, traces, events = true }) {
  const calls = [];
  // The real trace routes over a real store; the SSE trace channel streams its events as the host does.
  const traceRoutes = traces && createTraceRoutes({ traces, csrf: () => state.csrf });
  const live = {
    active: 2,
    waits: [{ id: 'fx-approval', kind: 'approval', runId: 'run-1', processId: 'p1', overdue: false }],
    runStatus: 'Waiting',
    failPacks,
  };
  const run = (id) => ({
    id,
    processId: 'p1',
    status: id === 'run-1' ? live.runStatus : 'Succeeded',
    starttime: '2026-10-22T09:00:00Z',
    journal: { Invented_step: { status: 'Succeeded', outputs: { ok: true } } },
  });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    try {
      if (traceRoutes && (await traceRoutes(req, res, url))) return;
      if (traces && events && url.pathname === '/__sim/events' && url.searchParams.get('channels') === 'trace') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
        res.write(': connected\n\n');
        const unsubscribe = traces.subscribe((event) => res.write(`event: trace\ndata: ${JSON.stringify(event)}\n\n`));
        req.on('close', unsubscribe);
        return;
      }
      if (url.pathname.startsWith('/__sim/api/')) {
        for await (const chunk of req) void chunk;
        res.setHeader('content-type', 'application/json');
        const route = url.pathname.slice('/__sim/api'.length),
          send = (body, code = 200) => res.writeHead(code).end(JSON.stringify(body));
        if (route === '/state') return send(state);
        if (route === '/status') return status ? send(status) : send({ error: 'Not found' }, 404);
        if (route === '/personas') return send({});
        if (route === '/dashboard') return send(dashboard());
        if (route === '/messages' && req.method === 'GET')
          return send({
            configured: true,
            entities: [
              { entity: 'fx-orders', stats: { active: live.active, locked: 0, scheduled: 0, deadLettered: 0 } },
            ],
            endpoints: {},
          });
        if (route === '/messages/fx-orders' && req.method === 'DELETE') {
          const purged = live.active;
          live.active = 0;
          return send({ entity: 'fx-orders', purged });
        }
        if (route === '/outbox') return send({ configured: true, entries: [] });
        if (route === '/environment') return send({ environmentVariables: { definitions: [] } });
        if (route === '/flow-waits') return send(live.waits);
        if (route === '/flow-waits/fx-approval' && req.method === 'POST') {
          live.waits = [];
          live.runStatus = 'Running';
          return send({ runId: 'run-1', waitId: 'fx-approval', scheduled: true, outcome: 'Approve' }, 202);
        }
        if (route === '/flow-runs') return send([run('run-1'), run('run-2')].map(({ journal, ...summary }) => summary));
        if (route.startsWith('/flow-runs/')) return send(run(decodeURIComponent(route.slice('/flow-runs/'.length))));
        if (route === '/packs')
          return live.failPacks-- > 0 ? send({ error: 'Invented pack registry failure.' }, 500) : send(packs);
        return send({ error: 'Not found' }, 404);
      }
      const name = url.pathname === '/__sim/' ? 'index.html' : url.pathname.split('/').at(-1);
      if (name !== 'index.html' && !/^[a-z0-9-]+\.(?:mjs|css)$/.test(name)) return res.writeHead(404).end();
      res.setHeader(
        'content-type',
        name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html',
      );
      res.end(await fs.readFile(new URL(`../${SHARED.has(name) ? 'lib' : 'admin'}/${name}`, import.meta.url)));
    } catch (error) {
      if (!res.headersSent) res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

async function open(t, origin, hash) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/__sim/${hash}`);
  await page.locator('#navigation a').first().waitFor();
  return { page, errors };
}
const nav = (page, name) => page.locator('#navigation').getByRole('link', { name, exact: true }).click();
// Every visible form control except the kit's pager tools has visible help tied by aria-describedby.
const undescribed = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#content input, #content select, #content textarea')]
      .filter(
        (node) =>
          node.type !== 'hidden' &&
          !node.closest('[hidden]') &&
          !node.matches('[data-table-search], [data-table-size], [data-filter-target]'),
      )
      .filter(
        (node) =>
          !(node.getAttribute('aria-describedby') ?? '')
            .split(/\s+/)
            .some((id) => document.getElementById(id)?.textContent.trim()),
      )
      .map((node) => node.id || node.name || node.outerHTML.slice(0, 60)),
  );

test(
  'module views render their data on first entry, act through the real app and link their docs',
  { timeout: 60_000 },
  async (t) => {
    // /state carries no docs: the app reads them, and the published route list, from GET /status once.
    const { origin, calls } = await host(t, {
      state: {
        csrf: 'fixture-csrf',
        config: {
          mappings: [],
          plugins: [],
          endpoints: [],
          permissions: [],
          presets: [],
          identity: {},
          platformSettings: [],
        },
        data: {},
        status: { pages: [], scenarios: [] },
        diagnostics: [],
      },
      status: { docs, routes: POWER_PAGES_ROUTES },
    });
    const { page, errors } = await open(t, origin, '');
    await page.getByRole('heading', { name: 'Infrastructure', exact: true }).waitFor();
    // The published list decides for /_sim/api routes: Platform rules shown, audit hidden, nothing probed.
    await page.locator('#navigation').getByRole('link', { name: 'Platform rules', exact: true }).waitFor();
    assert.equal(
      await page.locator('#navigation').getByRole('link', { name: 'Request audit', exact: true }).count(),
      0,
    );

    // Providers & services: the first entry already shows the dashboard's storage provider (no manual refresh).
    await nav(page, 'Providers & services');
    await page.locator('table[data-table="svc-storage-providers"] tbody tr').first().waitFor();
    assert.equal(await page.locator('table[data-table="svc-storage-providers"] tbody tr').count(), 1);
    assert.equal(
      await page.locator('[data-ui-section="services:storage"] .ui-section-summary').innerText(),
      '1 providers · 1 routes',
    );
    assert.equal(
      await page.locator('[data-ui-section="services:messaging"] .ui-section-summary').innerText(),
      '1 entities',
    );
    assert.ok((await page.locator('#content a.ui-doc').count()) > 0, 'doc links come from GET /status');
    assert.deepEqual(await undescribed(page), []);

    // Deep link to the messaging panel, then purge: the entity row shows the purged state after the refresh.
    await page.evaluate(() => {
      location.hash = 'services?panel=messaging';
    });
    await page.waitForFunction(() => document.querySelector('[data-ui-section="services:messaging"]')?.open === true);
    await page.getByRole('button', { name: 'Purge fx-orders' }).click();
    await page.locator('#confirm').getByRole('button', { name: 'Purge', exact: true }).click();
    await page.getByText('Purged 2 messages from fx-orders.').waitFor();
    await page.waitForFunction(
      () => document.querySelector('table[data-table="svc-entities"] tbody tr td:nth-child(2)')?.textContent === '0',
    );
    assert.ok(calls.includes('DELETE /__sim/api/messages/fx-orders'));

    // Flows & jobs: the waiting approval is there on first entry; answering it removes it and the run moves on.
    await nav(page, 'Flows & jobs');
    await page.locator('table[data-table="flow-runs"] tbody tr').nth(1).waitFor();
    assert.equal(await page.locator('[data-ui-section="flows:waits"] .ui-section-summary').innerText(), '1 waiting');
    await page.locator('[data-ui-section="flows:waits"] > summary').click();
    assert.equal(await page.locator('table[data-table="flow-waits"] tbody tr').count(), 1);
    await page.getByRole('button', { name: 'Answer wait fx-approval' }).click();
    await page.getByLabel('Responder').fill('reviewer@example.test');
    assert.deepEqual(await undescribed(page), []);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText('No run is waiting.').waitFor();
    assert.equal(await page.locator('[data-ui-section="flows:waits"] .ui-section-summary').innerText(), '0 waiting');
    await page.locator('table[data-table="flow-runs"] tbody tr').first().getByText('Running').waitFor();
    assert.ok(calls.includes('POST /__sim/api/flow-waits/fx-approval'));

    // Run details show the run that was clicked, with its journal.
    await page.getByRole('button', { name: 'Details of run run-1' }).click();
    await page.getByRole('heading', { name: 'Run run-1' }).waitFor();
    await page.locator('dl.ui-kv').getByText('p1', { exact: true }).waitFor();
    // A run deep link loads that run.
    await page.evaluate(() => {
      location.hash = 'flows?run=run-2';
    });
    await page.getByRole('heading', { name: 'Run run-2' }).waitFor();

    // Data packs: the registered pack is listed on first entry and its details expand.
    await nav(page, 'Data packs');
    await page.locator('table[data-table="packs-registered"] tbody tr').first().waitFor();
    await page.getByRole('button', { name: 'Details of pack fx-pack' }).click();
    await page.locator('table[data-table="packs-fx-pack-exports"]').getByText('serverLogics').waitFor();

    // Capabilities & preflight renders with help on its level filter.
    await nav(page, 'Capabilities & preflight');
    await page.getByRole('heading', { name: 'Capabilities & preflight', exact: true }).waitFor();
    assert.deepEqual(await undescribed(page), []);

    assert.equal(
      calls.filter((call) => call === 'GET /__sim/api/status').length,
      1,
      'GET /status is read once per session',
    );
    assert.ok(
      !calls.some((call) => /^GET \/__sim\/api\/(?:audit|diagnostics|portal-settings|experiments)$/.test(call)),
      'no probe request: the published list answers',
    );
    assert.deepEqual(errors, []);
  },
);

test(
  'a failed module load shows its error with the status; standalone hosts get Platform rules from their routes',
  { timeout: 60_000 },
  async (t) => {
    const setting = {
      key: 'MaxUploadFileSize',
      description: 'Invented upload limit in bytes.',
      type: 'integer',
      min: 1,
      max: 100,
      value: 10,
      sourceValue: 10,
      origin: 'Default',
      access: 'Admin center',
      coverage: 'Enforced',
    };
    const { origin, calls } = await host(t, {
      state: {
        csrf: 'fixture-csrf',
        capabilities: { powerPages: false },
        config: { platformSettings: [setting] },
        data: {},
        docs,
        status: { routes: ['/dashboard', '/packs', '/platform-settings', '/state', '/status'] },
      },
      failPacks: 1,
    });
    const { page, errors } = await open(t, origin, '#packs');
    await page.getByText('Data packs could not be loaded: Invented pack registry failure. (HTTP 500).').waitFor();
    assert.equal(
      await page.getByText('No data pack is registered.', { exact: false }).count(),
      0,
      'no empty state is claimed for a failed load',
    );
    await page.locator('#refresh').click();
    await page.locator('table[data-table="packs-registered"] tbody tr').first().waitFor();
    assert.equal(await page.getByText('could not be loaded', { exact: false }).count(), 0);

    await nav(page, 'Platform rules');
    await page.getByRole('heading', { name: 'Platform rules', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('heading', { name: 'Configuration presets' }).count(),
      0,
      'presets need /experiments, which a standalone host does not serve',
    );
    assert.equal(
      await page.locator('#platform-MaxUploadFileSize').getAttribute('aria-describedby'),
      'platform-MaxUploadFileSize-help',
    );
    assert.equal(await page.locator('#platform-MaxUploadFileSize-help').innerText(), 'Invented upload limit in bytes.');
    assert.deepEqual(await undescribed(page), []);
    assert.ok(!calls.includes('GET /__sim/api/status'), '/state already carried docs');
    assert.ok(
      !calls.some((call) => /\/__sim\/(?:api\/(?:audit|flow-runs|diagnostics|environment)|events)$/.test(call)),
      'no probe requests',
    );
    assert.deepEqual(errors, []);
  },
);

test(
  'every sidebar link lands at the top of a view headed by its label; step and panel links land on their panel',
  { timeout: 120_000 },
  async (t) => {
    const { origin } = await host(t, {
      state: {
        csrf: 'fixture-csrf',
        config: {
          mappings: [],
          plugins: [],
          endpoints: [],
          permissions: [],
          presets: [],
          scenarios: [],
          identity: {},
          platformSettings: [],
        },
        data: {},
        status: { pages: [], scenarios: [] },
        diagnostics: [],
      },
      status: { docs, routes: POWER_PAGES_ROUTES },
    });
    const { page, errors } = await open(t, origin, '#overview');
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    // The label is the link's text node after its aria-hidden icon; the group is the summary of its sidebar group.
    const links = await page.locator('#navigation a').evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.lastChild.textContent.trim(),
        group: node.closest('details').querySelector('summary').textContent.trim(),
      })),
    );
    assert.ok(links.length >= 15, `${links.length} sidebar links`);
    for (const { label, group } of links) {
      // Start from the bottom of the previous view, so a landing that keeps the old scroll position fails.
      await page.evaluate(() => {
        document.querySelector('#content').style.minHeight = '4000px';
        window.scrollTo(0, 3000);
      });
      await nav(page, label);
      await page.waitForFunction(
        (name) =>
          document.querySelector('#content h1')?.textContent === name && document.activeElement?.id === 'view-title',
        label,
      );
      assert.equal(await page.evaluate(() => window.scrollY), 0, `${label} opens at its top`);
      assert.equal(await page.locator('#breadcrumb').innerText(), label);
      assert.equal(await page.locator('#breadcrumb-group').innerText(), group);
      assert.equal(await page.locator('#content .eyebrow').first().innerText(), group.toUpperCase());
      assert.equal(await page.title(), `${label} · Paqvilo simulator workspace`);
    }

    // A step link names the panel that does the step: it opens, scrolls to, focuses and outlines that panel.
    await nav(page, 'Scenarios');
    await page.getByRole('heading', { name: 'Scenarios', exact: true }).waitFor();
    await page.locator('[data-steps="scenarios"]').getByRole('link', { name: 'Reset when you are done' }).click();
    await page.waitForFunction(() => document.querySelector('[data-panel="reset"]')?.classList.contains('is-landed'));
    assert.ok(
      await page.evaluate(() => {
        const panel = document.querySelector('[data-panel="reset"]'),
          box = panel.getBoundingClientRect();
        return panel.contains(document.activeElement) && box.top >= 0 && box.top < innerHeight;
      }),
    );
    // A deep link to a collapsed module panel opens and lands on it, and the outline goes away again after the
    // product's 2.5 s timer (admin/app.mjs land), which a fake clock advances instead of the test waiting it out.
    await page.clock.install();
    await page.evaluate(() => {
      location.hash = 'services?panel=outbox';
    });
    await page.waitForFunction(() => {
      const panel = document.querySelector('[data-ui-section="services:outbox"]');
      return panel?.open && panel.classList.contains('is-landed') && panel.contains(document.activeElement);
    });
    assert.equal(await page.locator('.is-landed').count(), 1, 'the outline stays until its timer runs');
    await page.clock.runFor(2500);
    await page.waitForFunction(() => !document.querySelector('.is-landed'));
    assert.deepEqual(errors, []);
  },
);

/** A portal page GET and a portal Web API create, recorded the way the host hooks record them. */
function recordTraffic(traces, name = 'POST /_api/x_items') {
  const origin = { host: 'power-pages', portal: 'fx-portal', preset: null };
  const session = { visitorId: 'visitor-1', sessionKey: 'visitor-1' };
  const page = traces.start({
    kind: 'http',
    name: 'GET /fx-page',
    module: 'portal',
    operation: 'get',
    actor: { kind: 'anonymous', id: null, name: null },
    session,
    origin,
    traceId: null,
    parentSpanId: null,
  });
  traces.run(page, () =>
    traces.wrap({ kind: 'render', name: '/fx-page', module: 'liquid', operation: 'render' }, () => {}),
  );
  page.end({ attributes: { statusCode: 200 } });
  const api = traces.start({
    kind: 'http',
    name,
    module: 'portal',
    operation: 'post',
    actor: { kind: 'contact', id: 'fx-contact', name: 'Invented Contact' },
    session,
    origin,
    traceId: null,
    parentSpanId: null,
  });
  traces.run(api, () =>
    traces.wrap({ kind: 'webapi', name: 'POST x_items', module: 'webapi', operation: 'create', entity: 'x_item' }, () =>
      traces.wrap(
        { kind: 'dataverse', name: 'Create x_item', module: 'dataverse', operation: 'create', entity: 'x_item' },
        (span) => {
          span.event('permission', { attributes: { table: 'x_item', operation: 'create', result: 'allow' } });
          span.set({ recordId: 'fx-item-1' });
        },
      ),
    ),
  );
  api.end({ attributes: { statusCode: 201 } });
  return api;
}

test(
  'the trace view lists recorded traffic, opens a waterfall, tree and span, filters, saves settings and follows Live',
  { timeout: 60_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    const api = recordTraffic(traces);
    const { origin, calls } = await host(t, {
      state: {
        csrf: 'fixture-csrf',
        config: {
          mappings: [],
          plugins: [],
          endpoints: [],
          permissions: [],
          presets: [],
          identity: {},
          platformSettings: [],
        },
        data: {},
        status: { pages: [], scenarios: [] },
        diagnostics: [],
      },
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace'] },
      traces,
    });
    const { page, errors } = await open(t, origin, '#overview');
    await nav(page, 'Traces');
    await page.getByRole('heading', { name: 'Traces', exact: true }).waitFor();
    const rows = page.locator('table[data-table="trace-list"] tbody tr');
    await rows.nth(1).waitFor();
    assert.equal(await rows.count(), 2);
    assert.equal(await page.locator('#breadcrumb-group').innerText(), 'Monitor');
    assert.deepEqual(await undescribed(page), []);

    // A row opens the trace: the waterfall has one row per span; a span opens its drawer.
    await rows.filter({ hasText: 'POST /_api/x_items' }).click();
    const waterfall = page.locator('ol.ui-waterfall > li');
    await waterfall.nth(2).waitFor();
    assert.equal(await waterfall.count(), 3);
    assert.match(await page.evaluate(() => location.hash), new RegExp(`^#trace\\?traceId=${api.traceId}$`));
    await page.getByRole('button', { name: /^Span Create x_item/ }).click();
    await page.getByRole('heading', { name: 'Create x_item', level: 3 }).waitFor();
    await page.locator('#trace-span-drawer').getByText('permission', { exact: true }).waitFor();
    assert.match(await page.evaluate(() => location.hash), /&spanId=/);
    // The tree tab by keyboard: the details expand and collapse natively.
    await page.getByRole('tab', { name: 'Waterfall' }).focus();
    await page.keyboard.press('ArrowRight');
    await page.locator('ul.ui-tree').waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Tree' }).getAttribute('aria-selected'), 'true');
    const webapi = page.locator('ul.ui-tree details').nth(1);
    await webapi.locator(':scope > summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await webapi.evaluate((node) => node.open), false);

    // A deep link (as the audit Trace link writes it) opens the trace with the span selected.
    const root = traces.tree(api.traceId).root;
    await page.evaluate(
      ([traceId, spanId]) => {
        location.hash = `trace?traceId=${traceId}&spanId=${spanId}`;
      },
      [api.traceId, root.spanId],
    );
    await page.getByRole('heading', { name: 'POST /_api/x_items', level: 3 }).waitFor();

    // Filters: one kind narrows the list and lands in the address.
    await page.getByLabel('Span kind').selectOption('render');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.waitForFunction(() => document.querySelectorAll('table[data-table="trace-list"] tbody tr').length === 1);
    await rows.first().getByText('GET /fx-page').waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#trace?kind=render');
    assert.ok(calls.includes('GET /__sim/api/trace?kind=render&page=1&pageSize=10'));

    // Settings: level full is saved with PUT and applies to the store at once.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-ui-section="trace:settings"]')?.open === true);
    await page.getByLabel('full', { exact: true }).check();
    assert.deepEqual(await undescribed(page), []);
    await page.getByRole('button', { name: 'Save trace settings' }).click();
    await page.getByText('Tracing level full.').waitFor();
    assert.equal(traces.settings().level, 'full');
    assert.ok(calls.includes('PUT /__sim/api/trace/settings'));

    // Live: once the stream is open, a newly ended trace appears without a refresh.
    await page.getByRole('button', { name: 'Reset filters' }).click();
    await page.waitForFunction(() => document.querySelectorAll('table[data-table="trace-list"] tbody tr').length === 2);
    await page.getByRole('button', { name: 'Live: off' }).click();
    await page.locator('.ui-toolbar').getByText('Streaming').waitFor();
    recordTraffic(traces, 'POST /_api/x_others');
    await rows.filter({ hasText: 'POST /_api/x_others' }).waitFor();

    // Clear asks first, then empties the list.
    await page.getByRole('button', { name: 'Clear traces' }).click();
    await page.locator('#confirm').getByRole('button', { name: 'Clear traces', exact: true }).click();
    await page.getByText('No trace matches.', { exact: false }).waitFor();
    assert.equal(traces.status().retained, 0);
    assert.deepEqual(errors, []);
  },
);

test(
  'trace Live on a standalone host without the trace stream turns off with a notice',
  { timeout: 60_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    const { origin, calls } = await host(t, {
      state: {
        csrf: 'fixture-csrf',
        capabilities: { powerPages: false },
        config: { platformSettings: [] },
        data: {},
        docs,
        status: { routes: ['/dashboard', '/state', '/status', '/trace'] },
      },
      traces,
      events: false,
    });
    const { page, errors } = await open(t, origin, '#trace');
    await page.getByRole('heading', { name: 'Traces', exact: true }).waitFor();
    // Root percentiles come from the same stats answer: no second depth=0 read.
    await page
      .locator('.ui-tile', { hasText: 'Root p50 / p95' })
      .getByText(/ms \/ /)
      .waitFor();
    assert.ok(calls.some((call) => call.startsWith('GET /__sim/api/trace/stats')));
    assert.equal(
      calls.some((call) => call.includes('depth=0')),
      false,
    );
    await page.getByRole('button', { name: 'Live: off' }).click();
    await page.getByText('This host does not serve the live trace stream', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Live: off' }).waitFor();
    assert.ok(calls.includes('GET /__sim/events?channels=trace'));
    assert.deepEqual(errors, []);
  },
);

const TRACE_STATE = {
  csrf: 'fixture-csrf',
  config: {
    mappings: [],
    plugins: [],
    endpoints: [],
    permissions: [],
    presets: [],
    identity: {},
    platformSettings: [],
  },
  data: {},
  status: { pages: [], scenarios: [] },
  diagnostics: [],
};
const listCalls = (calls) => calls.filter((call) => call.startsWith('GET /__sim/api/trace?'));

test(
  'trace view: Reset and deep links replace typed filters, columns sort, two traces compare, spans are searchable and export follows the format',
  { timeout: 90_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    recordTraffic(traces, 'POST /_api/x_items');
    const { origin, calls } = await host(t, {
      state: structuredClone(TRACE_STATE),
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace'], eventChannels: ['logs', 'trace'] },
      traces,
    });
    const { page, errors } = await open(t, origin, '#trace');
    const rows = page.locator('table[data-table="trace-list"] tbody tr');
    await rows.nth(3).waitFor();
    // A host that lists the logs channel keeps Live logs in the sidebar (F29).
    await page.locator('#navigation').getByRole('link', { name: 'Live logs', exact: true }).waitFor();

    // R2C-1: a typed but unapplied filter and an applied one are both gone after Reset; the next Apply sends none.
    await page.getByLabel('Span kind').selectOption('webapi');
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await page.waitForFunction(() => location.hash === '#trace?kind=webapi');
    await page.getByLabel('Table', { exact: true }).fill('account');
    const listed = (query) => page.waitForResponse((response) => response.url().endsWith(`/__sim/api/trace?${query}`));
    await Promise.all([listed('page=1&pageSize=10'), page.getByRole('button', { name: 'Reset filters' }).click()]);
    await rows.nth(3).waitFor();
    await page.waitForFunction(
      () =>
        document.querySelector('#trace-kind')?.value === '' && document.querySelector('#trace-entity')?.value === '',
    );
    const before = listCalls(calls).length;
    await page.getByRole('button', { name: 'Apply filters' }).focus();
    await Promise.all([listed('page=1&pageSize=10'), page.keyboard.press('Enter')]);
    assert.equal(await page.evaluate(() => location.hash), '#trace');
    assert.deepEqual(listCalls(calls).slice(before), ['GET /__sim/api/trace?page=1&pageSize=10']);
    // R2C-8: the keyboard user stays on Apply after the re-render.
    await page.waitForFunction(() => document.activeElement?.id === 'trace-apply');
    // A deep link replaces a typed value too.
    await page.getByLabel('Table', { exact: true }).fill('account');
    await page.evaluate(() => {
      location.hash = 'trace?kind=http';
    });
    await page.waitForFunction(
      () =>
        document.querySelector('#trace-kind')?.value === 'http' &&
        document.querySelector('#trace-entity')?.value === '',
    );
    await page.getByRole('button', { name: 'Remove filter Span kind: http' }).click();
    await page.waitForFunction(() => location.hash === '#trace');
    await rows.nth(3).waitFor();

    // Sorting by span count: descending first, then ascending on the second click; focus stays on the heading.
    // The click updates the hash at once but renders only when the sorted list arrives, and the newest trace
    // (a POST) already leads the default order: the heading's aria-sort is the signal that the sorted list rendered.
    const sortedBySpans = (order) =>
      page.waitForFunction(
        (value) => document.querySelector('th:has(#trace-sort-spans)')?.getAttribute('aria-sort') === value,
        order,
      );
    await page.locator('#trace-sort-spans').click();
    await sortedBySpans('descending');
    assert.equal(await page.evaluate(() => location.hash), '#trace?sort=spans&order=desc');
    assert.ok((await rows.first().innerText()).includes('POST /_api/x_items'));
    await page.locator('#trace-sort-spans').click();
    await sortedBySpans('ascending');
    assert.equal(await page.evaluate(() => location.hash), '#trace?sort=spans&order=asc');
    assert.ok((await rows.first().innerText()).includes('GET /fx-page'));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'trace-sort-spans');
    assert.ok(calls.includes('GET /__sim/api/trace?sort=spans&order=asc&page=1&pageSize=10'));

    // Compare the two POST traces: every span matches, so the summary counts three matching spans.
    const posts = rows.filter({ hasText: 'POST /_api/x_items' });
    await posts.nth(0).getByRole('checkbox').check();
    await posts.nth(1).getByRole('checkbox').check();
    assert.deepEqual(await undescribed(page), []);
    await page.getByRole('button', { name: 'Compare the 2 ticked traces' }).click();
    const compare = page.locator('[data-ui-section="trace:compare"]');
    await compare.locator('.ui-compare ul.ui-tree').nth(1).waitFor();
    assert.match(await page.evaluate(() => location.hash), /&compare=[^&]+%2C[^&]+$/);
    assert.equal(await compare.locator('dt:text-is("Matching spans") + dd').innerText(), '3');
    assert.equal(await compare.locator('.ui-compare .ui-badge', { hasText: /^only in/ }).count(), 0);
    assert.equal(await compare.locator('dt:text-is("Only in B (added)") + dd').innerText(), '0');
    await compare.getByRole('button', { name: 'Close comparison' }).click();
    await compare.waitFor({ state: 'detached' });

    // Span search inside a trace: the matching span and its parent stay, the rest is hidden; typing keeps focus.
    await posts
      .first()
      .getByRole('button', { name: /^Open trace/ })
      .click();
    const waterfall = page.locator('ol.ui-waterfall > li');
    await waterfall.nth(2).waitFor();
    await page.getByLabel('Find spans').pressSequentially('webapi');
    await page.waitForFunction(() => document.querySelectorAll('ol.ui-waterfall > li').length === 2);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'trace-span-search');
    assert.equal(await page.getByLabel('Find spans').inputValue(), 'webapi');
    await page.locator('.ui-span-tools').getByText('1 of 3 spans match').waitFor();
    assert.match(await page.evaluate(() => location.hash), /&spanSearch=webapi/);
    assert.equal(await page.locator('ol.ui-waterfall > li.is-context').count(), 1);
    assert.deepEqual(await undescribed(page), []);

    // Export: NDJSON by default (one trace per line), JSON once chosen; both stream from the export route.
    const download = async () => {
      const [file] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', { name: 'Export filtered traces' }).click(),
      ]);
      return fs.readFile(await file.path(), 'utf8');
    };
    const lines = (await download()).trim().split('\n');
    assert.equal(lines.length, 4);
    assert.ok(lines.every((line) => JSON.parse(line).trace.traceId));
    await page.getByLabel('Export as').selectOption('json');
    await page.waitForFunction(() => document.querySelector('#trace-export')?.href.includes('format=json'));
    const exported = JSON.parse(await download());
    assert.equal(exported.traces.length, 4);
    assert.ok(calls.some((call) => call.startsWith('GET /__sim/api/trace/export?') && call.includes('format=json')));
    assert.deepEqual(errors, []);
  },
);

test(
  'trace settings show the level saved elsewhere, not the radio clicked before (R2C-1)',
  { timeout: 60_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    const { origin } = await host(t, {
      state: structuredClone(TRACE_STATE),
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace'], eventChannels: ['logs', 'trace'] },
      traces,
    });
    const { page, errors } = await open(t, origin, '#trace?panel=settings');
    await page.waitForFunction(() => document.querySelector('[data-ui-section="trace:settings"]')?.open === true);
    await page.getByLabel('full', { exact: true }).check();
    // The level changes through the API (another tab, the CLI), then the view refreshes.
    traces.configure({ level: 'off' });
    await page.getByRole('button', { name: 'Refresh traces' }).click();
    await page.getByText('Tracing is off: new requests are not recorded.', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('off', { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel('full', { exact: true }).isChecked(), false);
    assert.deepEqual(errors, []);
  },
);

test(
  'a standalone host that lists the trace channel follows Live and hides Live logs (F29, F31)',
  { timeout: 60_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    const { origin, calls } = await host(t, {
      state: {
        csrf: 'fixture-csrf',
        capabilities: { powerPages: false },
        config: { platformSettings: [] },
        data: {},
        docs,
        status: { routes: ['/dashboard', '/state', '/status', '/trace'], eventChannels: ['trace'] },
      },
      traces,
    });
    const { page, errors } = await open(t, origin, '#trace');
    const rows = page.locator('table[data-table="trace-list"] tbody tr');
    await rows.nth(1).waitFor();
    assert.equal(await page.locator('#navigation').getByRole('link', { name: 'Live logs', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Live: off' }).click();
    await page.locator('.ui-toolbar').getByText('Streaming').waitFor();
    recordTraffic(traces, 'POST /_api/x_standalone');
    await rows.filter({ hasText: 'POST /_api/x_standalone' }).waitFor();
    assert.equal(
      calls.some((call) => call.startsWith('GET /__sim/events?channels=logs')),
      false,
    );
    assert.deepEqual(errors, []);
  },
);
