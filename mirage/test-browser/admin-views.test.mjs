// The shell (navigation, old-address redirects, Home, Health links, links into Activity) and the four view modules
// (services, flows, packs, capabilities) inside the real /_sim/ app (index.html + app.mjs) against
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
import { measureView } from './readability.mjs';

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
    requests: { total: 3, recent: [] },
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

// `answers`: route → JSON body (or a function returning one) answered before the fixed routes.
async function host(t, { state, status, failPacks = 0, traces, events = true, dataverse, answers = {} }) {
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
    // The run's flow-run step in the trace store (flow-runs.mjs traceOf): the row links into Activity.
    ...(id === 'run-1' ? { traceId: 'fx-trace-1', traceSpanId: 'fx-span-1' } : {}),
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
        if (Object.hasOwn(answers, route) && req.method === 'GET')
          return send(typeof answers[route] === 'function' ? answers[route]() : answers[route]);
        if (route === '/state') return send(state);
        if (route === '/status') return status ? send(status) : send({ error: 'Not found' }, 404);
        if (route === '/personas') return send({});
        if (route === '/dashboard') return send(dashboard());
        if (route === '/dataverse')
          return send(
            dataverse ?? { enabled: true, applications: [], users: [], roles: [], grantTypes: [], workflows: [] },
          );
        if (route === '/dataverse/requests') return send({ requests: [{ status: 200 }, { status: 500 }] });
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
/** Links, buttons and fields whose box leaves the viewport or the table frame that holds them. */
const clippedControls = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#content a, #content button, #content input, #content select')]
      .filter((node) => node.offsetParent && !node.closest('.ui-info-pop'))
      .filter((node) => {
        const box = node.getBoundingClientRect(),
          frame = node.closest('.ui-table-wrap, .table-wrap')?.getBoundingClientRect();
        return box.right > (frame ? frame.right + 1 : innerWidth + 1);
      })
      .map((node) => node.textContent.trim() || node.id),
  );
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
    await page.getByRole('heading', { name: 'Health', exact: true }).waitFor();
    // The published list decides for /_sim/api routes: Platform rules shown, nothing probed.
    await page.locator('#navigation').getByRole('link', { name: 'Platform rules', exact: true }).waitFor();
    // Navigation groups (D-M-1): Workspace › Home, Monitor › Health (and Activity where the host serves traces).
    const groups = await page
      .locator('#navigation details')
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector('summary').textContent.trim(),
          [...node.querySelectorAll('a')].map((link) => link.lastChild.textContent.trim()),
        ]),
      );
    assert.deepEqual(groups.slice(0, 2), [
      ['Workspace', ['Home']],
      ['Monitor', ['Health']],
    ]);
    for (const gone of ['Overview', 'Infrastructure', 'Live logs', 'Request audit', 'Traces', 'Render & diagnostics'])
      assert.equal(await page.locator('#navigation').getByRole('link', { name: gone, exact: true }).count(), 0, gone);

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
    // Results read as in Activity (D-M-2): the platform status follows only when it says more (DV-N4-16).
    const resultOf = (index) =>
      page
        .locator('table[data-table="flow-runs"] tbody tr')
        .nth(index)
        .locator('td:nth-child(2)')
        .innerText()
        .then((text) => text.replace(/\s+/g, ' ').trim());
    assert.equal(await resultOf(0), 'running waiting');
    assert.equal(await resultOf(1), 'ok');
    assert.equal(await page.getByRole('columnheader', { name: 'Result' }).count(), 1);
    assert.equal(await page.locator('[data-ui-section="flows:waits"] .ui-section-summary').innerText(), '1 waiting');
    await page.locator('[data-ui-section="flows:waits"] > summary').click();
    assert.equal(await page.locator('table[data-table="flow-waits"] tbody tr').count(), 1);
    await page.getByRole('button', { name: 'Answer wait fx-approval' }).click();
    await page.getByLabel('Responder').fill('reviewer@example.test');
    assert.deepEqual(await undescribed(page), []);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText('No run is waiting.').waitFor();
    assert.equal(await page.locator('[data-ui-section="flows:waits"] .ui-section-summary').innerText(), '0 waiting');
    await page.waitForFunction(
      () =>
        document.querySelector('table[data-table="flow-runs"] tbody tr td:nth-child(2)')?.textContent.trim() ===
        'running',
    );
    assert.ok(calls.includes('POST /__sim/api/flow-waits/fx-approval'));

    // Run rows name the flow, show local times (date and UTC on hover) and link the run's step in Activity.
    const first = page.locator('table[data-table="flow-runs"] tbody tr').first();
    assert.equal(
      await first.getByRole('link', { name: 'Activity of run run-1' }).getAttribute('href'),
      '#activity/fx-trace-1/fx-span-1',
    );
    const started = first.locator('time');
    assert.match(await started.first().innerText(), /^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.match(
      await started.first().getAttribute('title'),
      /^2026-10-2[12] \d{2}:\d{2}:00\.000 UTC[+−]\d{2}:\d{2} · 2026-10-22T09:00:00\.000Z$/,
    );
    assert.equal(await started.first().getAttribute('datetime'), '2026-10-22T09:00:00.000Z');
    // The zone is named once, in the (i) of the Started column.
    assert.match(
      await page
        .locator('table[data-table="flow-runs"] th', { hasText: 'Started' })
        .locator('.ui-info-text')
        .textContent(),
      /^Times are local \(UTC[+−]\d{2}:\d{2}\); hover a time for its date and UTC\.$/,
    );
    // M2 §7 defect 1: nothing in the run table is cut off at the right edge.
    assert.deepEqual(await clippedControls(page), []);
    // D-M-7: the filters live in a drawer opened from the toolbar; applying closes it and shows the filter as a chip.
    const toggle = page.locator('[data-filter-toggle="flows-filters"]');
    assert.equal(await page.locator('#flows-filters').isVisible(), false);
    await toggle.click();
    await page.locator('#flows-filters').waitFor();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'flow-process');
    await page.locator('#flow-status').selectOption('Succeeded');
    await page.locator('#flows-filters').getByRole('button', { name: 'Apply filters' }).click();
    await page.getByRole('button', { name: 'Remove filter Result: ok · succeeded' }).waitFor();
    assert.equal(await page.locator('#flows-filters').isVisible(), false);
    assert.equal(await toggle.textContent(), 'Filters · 1');
    assert.ok(calls.includes('GET /__sim/api/flow-runs?status=Succeeded'));
    await page.getByRole('button', { name: 'Remove filter Result: ok · succeeded' }).click();
    await page.waitForFunction(
      () => document.querySelector('[data-filter-toggle="flows-filters"]')?.textContent === 'Filters',
    );
    // Escape closes an open drawer and gives focus back to its toggle.
    await toggle.click();
    await page.locator('#flows-filters').waitFor();
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('#flows-filters')?.hidden === true);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.filterToggle), 'flows-filters');
    // Run details show the run that was clicked, with its journal.
    await page.getByRole('button', { name: 'Details of run run-1' }).click();
    await page.getByRole('heading', { name: 'Run of p1 run-1' }).waitFor();
    await page.locator('dl.ui-kv code').getByText('p1', { exact: true }).waitFor();
    // A run deep link loads that run.
    await page.evaluate(() => {
      location.hash = 'flows?run=run-2';
    });
    await page.getByRole('heading', { name: 'Run of p1 run-2' }).waitFor();

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
    // #overview is an old address: it is replaced in place by #home (no extra history entry).
    const { page, errors } = await open(t, origin, '#overview');
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => location.hash), '#home');
    // The label is the link's text node after its aria-hidden icon; the group is the summary of its sidebar group.
    const links = await page.locator('#navigation a').evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.lastChild.textContent.trim(),
        group: node.closest('details').querySelector('summary').textContent.trim(),
      })),
    );
    assert.ok(links.length >= 15, `${links.length} sidebar links`);
    // The first link is Home, where the page already is: start elsewhere so every link changes the view.
    await nav(page, 'Data records');
    await page.getByRole('heading', { name: 'Data records', exact: true }).waitFor();
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
      // D-M-7: no title block; the breadcrumb names the page in the accent colour and the H1 stays for focus only.
      assert.equal(await page.locator('#content .eyebrow').count(), 0, `${label} has no eyebrow`);
      assert.equal(
        await page.locator('#view-title').evaluate((node) => node.getBoundingClientRect().height <= 1),
        true,
      );
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

/** A portal Web API create with its plug-in step, recorded the way the host hooks record them. */
function recordTraffic(traces) {
  const api = traces.start({
    kind: 'http',
    name: 'POST /_api/x_items',
    module: 'portal',
    operation: 'post',
    actor: { kind: 'contact', id: 'fx-contact', name: 'Invented Contact' },
    session: { visitorId: 'visitor-1', sessionKey: 'contact:fx-contact' },
    origin: { host: 'power-pages', portal: 'fx-portal', preset: null },
    traceId: null,
    parentSpanId: null,
  });
  traces.run(api, () =>
    traces.wrap(
      { kind: 'dataverse', name: 'Create x_item', module: 'dataverse', operation: 'create', entity: 'x_item' },
      (span) => span.set({ recordId: 'fx-item-1' }),
    ),
  );
  api.end({ attributes: { statusCode: 201 } });
  return api;
}

// A Power Pages host that serves traces: Activity is in the sidebar, the places that change things link into it.
const MONITOR_STATE = {
  csrf: 'fixture-csrf',
  config: {
    mappings: [],
    plugins: [],
    endpoints: [],
    permissions: [],
    presets: [],
    identity: {},
    platformSettings: [],
    operations: [
      { key: 'plugin-step:fx-step', kind: 'plugin-step', id: 'fx-step', name: 'Invented.Step', mode: 'placeholder' },
      {
        key: 'cloud-flow:fx-flow',
        kind: 'cloud-flow',
        id: '{FX-FLOW}',
        processId: '{FX-FLOW}',
        name: 'Invented flow',
        mode: 'exported',
      },
      { key: 'server-logic:fx-logic', kind: 'server-logic', name: 'fx-logic', mode: 'placeholder' },
    ],
  },
  data: {
    x_item: [{ x_itemid: 'fx-item-1', x_name: 'Invented item' }],
    // A scenario-sized table list (more than ten tables shows the table filter, which once wrapped the toolbar).
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`zz_table_${index + 1}`, []])),
    contact: [{ contactid: 'fx-contact', fullname: 'Invented Contact' }],
  },
  status: { pages: [{ name: 'Home', path: '/' }], scenarios: [], tableCounts: { x_item: 1, contact: 1 } },
  diagnostics: [{ code: 'FX_FINDING', message: 'Invented finding.' }],
};

test(
  'old addresses land on the view that replaced them, with filters in the Activity vocabulary (Lense deep links)',
  { timeout: 90_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    const api = recordTraffic(traces),
      root = traces.tree(api.traceId).root;
    const { origin } = await host(t, {
      state: structuredClone(MONITOR_STATE),
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace'], eventChannels: ['logs', 'trace'] },
      traces,
    });
    const { page, errors } = await open(t, origin, '#home');
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
    const groups = await page
      .locator('#navigation details')
      .evaluateAll((nodes) =>
        nodes.slice(0, 2).map((node) => [...node.querySelectorAll('a')].map((link) => link.getAttribute('href'))),
      );
    assert.deepEqual(groups, [['#home'], ['#health', '#activity']]);
    const land = async (from, to, heading) => {
      const before = await page.evaluate(() => history.length);
      await page.evaluate((hash) => {
        location.hash = hash;
      }, from);
      await page.waitForFunction((hash) => location.hash === hash, to);
      await page.waitForFunction((name) => document.querySelector('#content h1')?.textContent === name, heading);
      // The old address is replaced in place: Back does not return to it.
      assert.equal(await page.evaluate(() => history.length), before + 1, from);
    };
    // Lense "Requests for this page" and "Diagnostics" (lense/panel-ui.mjs) and every other old Monitor address.
    await land('audit?path=%2Forder%2F', '#activity?path=%2Forder%2F', 'Activity');
    assert.equal(await page.locator('#breadcrumb-group').innerText(), 'Monitor');
    // It lands filtered: the path is a removable filter chip on the Activities tab.
    await page.getByRole('button', { name: 'Remove filter Path: /order/' }).waitFor();
    assert.equal(await page.locator('#activity-tabs-tab-activities').getAttribute('aria-selected'), 'true');
    await land('evidence', '#activity?tab=pages', 'Activity');
    await page.waitForFunction(
      () => document.querySelector('#activity-tabs-tab-pages')?.getAttribute('aria-selected') === 'true',
    );
    await land(
      'audit?outcome=success&entity=x_item&search=Ada&status=4xx&kind=api&correlationId=fx-audit&provider=live&panel=list',
      '#activity?result=ok&table=x_item&q=Ada&httpStatus=4xx&auditKind=api&auditId=fx-audit&provider=live',
      'Activity',
    );
    await land('logs?type=plugin', '#activity?tab=log&type=plugin', 'Activity');
    await land(
      `trace?traceId=${api.traceId}&spanId=${root.spanId}&kind=http`,
      `#activity/${api.traceId}/${root.spanId}?kind=http`,
      'Activity',
    );
    await land('trace?hasErrors=true', '#activity?hasErrors=true', 'Activity');
    await land('dashboard?panel=blocking', '#health?panel=dashboard-blocking', 'Health');
    await page.waitForFunction(() => document.querySelector('[data-ui-section="dashboard-blocking"]')?.open === true);
    await land('overview', '#home', 'Home');
    assert.deepEqual(errors, []);
  },
);

test(
  'Home guides the first run, Health counters and the places that change things link into Activity',
  { timeout: 90_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    const { origin } = await host(t, {
      state: structuredClone(MONITOR_STATE),
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace'], eventChannels: ['logs', 'trace'] },
      traces,
    });
    const { page, errors } = await open(t, origin, '#home');
    // Home: the checklist states what is done from what the runtime reports; runtime facts are in Runtime state.
    // Every row has a state from a fact (DV-N4-14): 3 portal requests since start mean the portal was opened; the
    // last step is done once this browser opened Activity. The counter counts the rows.
    const steps = () =>
      page
        .locator('[data-panel="checklist"] li .row-title')
        .evaluateAll((items) => items.map((item) => item.textContent.trim().replace(/\s+/g, ' ')));
    const counter = () => page.locator('[data-panel="checklist"] .panel-heading .badge').innerText();
    await page
      .locator('[data-panel="checklist"]')
      .getByText('3 portal requests since start', { exact: false })
      .waitFor();
    assert.deepEqual(await steps(), [
      'Done Portal sources loaded 1 page in the export',
      'Done Records to work with 2 records · 14 tables',
      'Done Open the portal 3 portal requests since start',
      'To do Sign in as a test person Not signed in',
      'To do See what happened 1 finding to review',
    ]);
    assert.equal(await counter(), '3 of 5 done');
    await nav(page, 'Activity');
    await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor();
    await nav(page, 'Home');
    await page.waitForFunction(
      () => document.querySelector('[data-panel="checklist"] .panel-heading .badge')?.textContent === '4 of 5 done',
    );
    assert.equal((await steps()).at(-1), 'Done See what happened 1 finding to review');
    await page.locator('[data-panel="checklist"]').getByRole('link', { name: 'Findings →' }).waitFor();
    await page.locator('[data-panel="sign-in"] dt', { hasText: 'Sign-in route' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Runtime & persistence' }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Workspace configuration' }).count(), 0);
    assert.deepEqual(await undescribed(page), []);
    await nav(page, 'Runtime state');
    await page.getByRole('heading', { name: 'Workspace configuration' }).waitFor();

    // Health: each counter opens the matching activity; the request feed is gone.
    await nav(page, 'Health');
    await page.locator('[data-kpi="plugins"] .dm-kpi-link').click();
    await page.waitForFunction(() => location.hash === '#activity?kind=plugin-step');
    await nav(page, 'Health');
    await page.locator('[data-kpi="diagnostics"] .dm-kpi-link').waitFor();
    assert.equal(await page.locator('[data-kpi="webApi"] .dm-kpi-label').innerText(), 'Dataverse Web API');
    assert.equal(await page.getByText('What is happening').count(), 0);
    assert.equal(
      await page.locator('[data-kpi="diagnostics"] .dm-kpi-link').getAttribute('href'),
      '#activity?tab=findings',
    );

    // Backend operations: each row opens its recent activity (plug-in steps and flows by their actor).
    await nav(page, 'Backend operations');
    await page.locator('[data-operation-row]').first().waitFor();
    const hrefs = Object.fromEntries(
      await page
        .locator('[data-operation-row]')
        .evaluateAll((rows) =>
          rows.map((row) => [
            row.dataset.operationRow,
            row.querySelector('a[href^="#activity"]')?.getAttribute('href'),
          ]),
        ),
    );
    assert.deepEqual(hrefs, {
      'plugin-step:fx-step': '#activity?kind=plugin-step&actorKind=plugin&actorId=fx-step&whoName=Invented.Step',
      'cloud-flow:fx-flow': '#activity?kind=flow-run&actorKind=flow&actorId=fx-flow&whoName=Invented+flow',
      'server-logic:fx-logic': '#activity?kind=server-logic&q=fx-logic',
    });
    assert.deepEqual(await clippedControls(page), []);
    // At phone width the table fits its frame: headings (with their (i) help) and cells wrap, actions stack.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => innerWidth === 390);
    assert.deepEqual(
      await page.evaluate(() => {
        const frame = document.querySelector('table[data-table="operations"]').closest('.ui-table-wrap');
        return [frame.scrollWidth <= frame.clientWidth, document.documentElement.scrollWidth <= innerWidth];
      }),
      [true, true],
    );
    assert.deepEqual(await clippedControls(page), []);
    await page.setViewportSize({ width: 1280, height: 900 });

    // Organization identity & API: the request ring is a count with links into Activity, not a fifth request list.
    await nav(page, 'Organization identity & API');
    await page
      .locator('[data-panel="dv-requests"]')
      .getByText('2 requests on the Dataverse origin (newest 500)', { exact: false })
      .waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Activity of the Dataverse API →' }).getAttribute('href'),
      '#activity?host=dataverse-api',
    );
    assert.equal(
      await page.getByRole('link', { name: 'Failed requests →' }).getAttribute('href'),
      '#activity?host=dataverse-api&result=error,denied',
    );
    assert.equal(await page.locator('table[data-table="dv-requests"]').count(), 0);

    // Portal identity & permissions: the selected persona opens what that person did.
    await nav(page, 'Portal identity & permissions');
    assert.equal(
      await page.getByRole('link', { name: 'Activity of Invented Contact →' }).getAttribute('href'),
      '#activity?who=fx-contact',
    );

    // Data records: a record opens the activity on it.
    await page.evaluate(() => {
      location.hash = 'records?entity=x_item';
    });
    await page
      .getByRole('link', { name: 'Activity of record fx-item-1' })
      .and(page.locator('[href="#activity?table=x_item&recordId=fx-item-1"]'))
      .waitFor();
    assert.deepEqual(await clippedControls(page), []);
    assert.deepEqual(errors, []);
  },
);

test(
  'at phone width the navigation collapses behind Menu and every view starts on the first screen',
  { timeout: 60_000 },
  async (t) => {
    const { origin } = await host(t, {
      state: structuredClone(MONITOR_STATE),
      status: { docs, routes: POWER_PAGES_ROUTES },
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    t.after(() => context.close());
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/__sim/#home`);
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor();
    const firstScreen = () =>
      page.evaluate(() => {
        const box = document.querySelector('#view-title').getBoundingClientRect();
        return box.top >= 0 && box.bottom <= innerHeight;
      });
    const menu = page.getByRole('button', { name: 'Menu' });
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#navigation').isVisible(), false);
    assert.equal(await firstScreen(), true, 'Home starts on the first screen');
    await menu.click();
    assert.equal(await menu.getAttribute('aria-expanded'), 'true');
    await page.locator('#navigation').getByRole('link', { name: 'Health', exact: true }).click();
    await page.getByRole('heading', { name: 'Health', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('#nav-toggle').getAttribute('aria-expanded') === 'false');
    assert.equal(await page.locator('#navigation').isVisible(), false, 'choosing a view closes the menu');
    assert.equal(await firstScreen(), true, 'Health starts on the first screen');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  },
);

// D-M-6 / D-M-7: every view starts with its content, keeps its prose behind (i) icons and fits the window.
const LIST_VIEWS = new Set(['flows', 'records', 'operations']);
test(
  'every view: content at the top, at most 280 characters of prose, list rows right under the toolbar, no sideways scroll',
  { timeout: 240_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    // Scenario-sized values (DV-N4c-2): a record with six long columns and long column names and platform settings with long texts.
    const state = structuredClone(MONITOR_STATE);
    // Data records opens on contact here.
    state.data.contact = [
      {
        contactid: '73887d67-7fb7-55b4-9677-0b591a803c0f',
        fullname: 'Invented contact with a long name',
        x_defaultvalue: 'https://inventedvault.example.test/secrets/x',
        x_environmentvariableschemaname: 'x_invented_long_schema_name_of_it',
        x_environmentvariabledisplayname: 'Invented display name of the item',
        x_environmentvariablesecretstore: 100000005,
      },
    ];
    state.config.platformSettings = ['QueryLinkEntityLimit', 'MaxUploadFileSize', 'BlockedAttachments'].map((key) => ({
      key,
      description:
        'Invented organization-wide support-managed budget. Raising it here simulates an approved support change for this runtime only.',
      access: 'Microsoft support request',
      coverage: 'FetchXML and SDK QueryExpression joins and attachment writes',
      origin: 'Default / not configured',
      type: 'integer',
      min: 1,
      max: 99_999_999,
      value: 5_242_880,
      sourceValue: 5_242_880,
    }));
    const { origin } = await host(t, {
      state,
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace'], eventChannels: ['logs', 'trace'] },
      traces,
    });
    const { page, errors } = await open(t, origin, '#home');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const views = await page
      .locator('#navigation a')
      .evaluateAll((links) =>
        links.map((link) => [link.getAttribute('href').slice(1), link.lastChild.textContent.trim()]),
      );
    assert.ok(views.length >= 18, `${views.length} views`);
    const failures = [];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1000 });
      for (const [id, label] of views) {
        await page.evaluate((hash) => {
          location.hash = hash;
        }, id);
        await page.waitForFunction(
          (name) =>
            document.querySelector('#view-title')?.textContent === name &&
            !document.querySelector('#content [role="status"]')?.textContent.startsWith('Loading') &&
            document.querySelector('#activity-feedback')?.hidden !== false,
          label,
        );
        const m = await page.evaluate(measureView);
        if (m.scrollX) failures.push(`${id} @${width}: scrolls sideways`);
        if (m.infoPairs.length) failures.push(`${id} @${width}: two (i) side by side: ${m.infoPairs.join(', ')}`);
        // DV-N4c-2: at 1440 every table fits its frame, row actions included (a phone scrolls inside the frame).
        if (width === 1440 && m.frames.length)
          failures.push(`${id}: table frame scrolls sideways: ${m.frames.join(', ')}`);
        // DV-N4b-9: on a phone the content starts within the first quarter of the screen (Activity's own phone
        // layout is measured by activity-e2e, which owns that view).
        if (width !== 1440) {
          if (id !== 'activity' && (m.firstY === null || m.firstY > 844 * 0.25))
            failures.push(`${id} @390: first content (${m.first}) at y=${m.firstY} (limit ${844 * 0.25})`);
          continue;
        }
        if (m.firstY === null || m.firstY > 250) failures.push(`${id}: first content at y=${m.firstY} (limit 250)`);
        if (m.prose > 280) failures.push(`${id}: ${m.prose} characters of prose (limit 280): ${m.parts.join(' | ')}`);
        if (LIST_VIEWS.has(id) && (m.firstRowY === null || m.firstRowY > 180))
          failures.push(`${id}: first data row at y=${m.firstRowY} (limit 180)`);
      }
    }
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  },
);

// D-M-8: every converted table is the shared table: its headers sort (aria-sort) and ↑/↓ move between rows.
test(
  'the shared table sorts by a header click on every converted view and moves between rows with the arrow keys',
  { timeout: 180_000 },
  async (t) => {
    const state = structuredClone(MONITOR_STATE);
    Object.assign(state.config, {
      mappings: [
        { logicalName: 'x_beta', entitySet: 'x_betas', idColumn: 'x_betaid' },
        { logicalName: 'x_alpha', entitySet: 'x_alphas', idColumn: 'x_alphaid' },
      ],
      endpoints: [
        { id: 'e2', path: '/beta', method: 'GET', mode: 'local', status: 200 },
        { id: 'e1', path: '/alpha', method: 'POST', mode: 'live', status: 201 },
      ],
      plugins: [
        { id: 'p2', name: 'Zeta rule', entity: 'x_item', operations: ['create'], enabled: true },
        { id: 'p1', name: 'Alpha rule', entity: 'contact', operations: ['update'], enabled: false },
      ],
      scenarios: [
        { id: 's2', name: 'Second scenario', permissionMode: 'enforce' },
        { id: 's1', name: 'First scenario', permissionMode: 'permissive' },
      ],
      platformSettings: [
        { key: 'ZetaLimit', description: 'Invented zeta.', type: 'integer', min: 1, max: 9, value: 2, sourceValue: 2 },
        {
          key: 'AlphaLimit',
          description: 'Invented alpha.',
          type: 'integer',
          min: 1,
          max: 9,
          value: 1,
          sourceValue: 1,
        },
      ],
      portalSettings: [
        { id: 'b', name: 'Beta/setting', value: '2', sourceValue: '2' },
        { id: 'a', name: 'Alpha/setting', value: '1', sourceValue: '1' },
      ],
    });
    state.data.x_item = [
      { x_itemid: 'fx-item-2', x_name: 'Zulu item' },
      { x_itemid: 'fx-item-1', x_name: 'Alpha item' },
    ];
    const { origin } = await host(t, {
      state,
      status: {
        docs,
        routes: [...POWER_PAGES_ROUTES, '/platform-settings', '/trace'],
        eventChannels: ['logs', 'trace'],
      },
      traces: createTraceStore({ settings: { level: 'summary' } }),
      dataverse: {
        enabled: true,
        applications: [
          { appId: 'app-b', displayName: 'Zeta app', allowedGrants: ['client_credentials'] },
          { appId: 'app-a', displayName: 'Alpha app', allowedGrants: ['client_credentials'] },
        ],
        users: [],
        roles: [],
        grantTypes: ['client_credentials'],
        workflows: [],
      },
    });
    const { page, errors } = await open(t, origin, '#home');
    await page.setViewportSize({ width: 1440, height: 1000 });
    // [hash, table, sort key, first column text ascending]
    const cases = [
      ['records?entity=x_item', 'records', 'x_name', ['Alpha item', 'Zulu item'], 1],
      ['mappings', 'mappings', 'logicalName', ['x_alpha', 'x_beta']],
      ['endpoints', 'endpoints', 'path', ['/alpha', '/beta']],
      ['plugins', 'plugins', 'name', ['Alpha rule', 'Zeta rule']],
      ['scenarios', 'scenarios', 'name', ['First scenario', 'Second scenario']],
      ['platform', 'platform-settings', 'key', ['AlphaLimit', 'ZetaLimit']],
      ['portal', 'portal-settings', 'name', ['Alpha/setting', 'Beta/setting']],
      ['dataverse', 'dv-applications', 'displayName', ['Alpha app', 'Zeta app']],
      ['operations', 'operations', 'name', ['fx-logic', 'Invented flow', 'Invented.Step']],
    ];
    for (const [hash, table, key, ascending, column = 0] of cases) {
      await page.evaluate((target) => {
        location.hash = target;
      }, hash);
      const header = page.locator(`[data-table-sort="${table}"][data-sort-key="${key}"]`);
      await header.waitFor();
      const firstColumn = () =>
        page
          .locator(`table[data-table="${table}"] tbody tr`)
          .evaluateAll((rows, index) => rows.map((row) => row.cells[index]?.textContent.trim()), column);
      const sorted = (order) =>
        page.waitForFunction(
          ([name, sortKey, value]) =>
            document
              .querySelector(`[data-table-sort="${name}"][data-sort-key="${sortKey}"]`)
              ?.closest('th')
              ?.getAttribute('aria-sort') === value,
          [table, key, order],
        );
      await header.click();
      await sorted('ascending');
      const up = await firstColumn();
      assert.deepEqual(
        up.map((text) => ascending.find((value) => text.startsWith(value))),
        ascending,
        `${table} ascending`,
      );
      await page.locator(`[data-table-sort="${table}"][data-sort-key="${key}"]`).click();
      await sorted('descending');
      const down = await firstColumn();
      assert.deepEqual(
        down.map((text) => ascending.find((value) => text.startsWith(value))),
        [...ascending].reverse(),
        `${table} descending`,
      );
      // The shared look: the bottom controls bar holds the count.
      assert.match(
        await page
          .locator(`.ui-data-table:has(table[data-table="${table}"]) .ui-table-foot .ui-table-count`)
          .innerText(),
        new RegExp(`^${ascending.length} results`),
      );
    }
    // Keyboard: ↓ moves from a row's Edit to the next row's Edit, ↑ back.
    await page.evaluate(() => {
      location.hash = 'mappings';
    });
    const edits = page.locator('table[data-table="mappings"] tbody tr [data-edit]');
    await edits.nth(1).waitFor();
    await edits.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await edits.nth(1).evaluate((node) => node === document.activeElement), true);
    await page.keyboard.press('ArrowUp');
    assert.equal(await edits.nth(0).evaluate((node) => node === document.activeElement), true);
    assert.deepEqual(errors, []);
  },
);

// DV-N4c-1: every shared table on every view sorts by each data column: header buttons with aria-sort, ascending
// then descending order of what the column shows. Fixtures give the module tables (packs, services, flows,
// capabilities, environment variables) two rows or more.
test(
  'every shared table has its search, its filters and the bottom bar, and with two rows or more sorts by any data column',
  { timeout: 240_000 },
  async (t) => {
    const state = structuredClone(MONITOR_STATE);
    state.capabilityReport = {
      modules: [
        { name: 'fx-zeta', kind: 'operation', level: 'inventory', operations: [] },
        { name: 'fx-alpha', kind: 'organization-module', level: 'behaviour', source: 'fx', operations: [{}, {}] },
      ],
      missing: [],
      unsupported: [
        { id: 'fx-zeta', level: 'inventory', reason: 'Placeholder' },
        { id: 'fx-beta', level: 'contract', reason: 'Mock' },
      ],
    };
    const base = dashboard();
    base.nodes.push(
      {
        id: 'provider:connectors',
        kind: 'provider',
        label: 'Connector runtime',
        status: 'ready',
        detail: {
          providers: [
            { id: 'fx-zulu', kind: 'mock', level: 'contract', ready: true },
            { id: 'fx-alpha', kind: 'local', level: 'behaviour', ready: true },
          ],
        },
      },
      {
        id: 'org:plugins',
        kind: 'org',
        label: 'Business logic',
        status: 'ready',
        detail: {
          webhooks: [
            { name: 'Zeta hook', host: '127.0.0.1' },
            { name: 'Alpha hook', host: 'localhost' },
          ],
        },
      },
    );
    base.activity.asyncOperations = { byState: { Waiting: 1, Succeeded: 12, Failed: 3 } };
    const packsBody = structuredClone(packs);
    packsBody.packs.push({ ...structuredClone(packs.packs[0]), id: 'fx-alpha-pack', name: 'Alpha pack' });
    packsBody.library.push({ id: 'fx-alpha', name: 'Alpha preset', pack: 'fx-alpha-pack', source: 'pack' });
    const { origin } = await host(t, {
      state,
      status: { docs, routes: POWER_PAGES_ROUTES },
      answers: {
        '/dashboard': () => ({ ...base, generatedAt: new Date().toISOString() }),
        '/packs': packsBody,
        '/messages': {
          configured: true,
          entities: [
            { entity: 'fx-zulu', stats: { active: 2, locked: 0, scheduled: 0, deadLettered: 0 } },
            { entity: 'fx-alpha', stats: { active: 10, locked: 1, scheduled: 0, deadLettered: 0 } },
          ],
          endpoints: {},
        },
        '/environment': {
          environmentVariables: {
            available: true,
            definitions: [
              { schemaname: 'x_zeta', displayname: 'Zeta', type: 'String', defaultvalue: 'z' },
              { schemaname: 'x_alpha', displayname: 'Alpha', type: 'String', defaultvalue: 'a' },
            ],
          },
        },
      },
    });
    const { page, errors } = await open(t, origin, '#home');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const views = await page
      .locator('#navigation a')
      .evaluateAll((links) =>
        links.map((link) => [link.getAttribute('href').slice(1), link.lastChild.textContent.trim()]),
      );
    const checked = new Set(),
      audited = new Set(),
      failures = [];
    // Every view, Activity included (activity-e2e runs the same rules on each of its tabs).
    for (const [id, label] of views) {
      await page.evaluate((hash) => {
        location.hash = hash;
      }, id);
      await page.waitForFunction(
        (name) =>
          document.querySelector('#view-title')?.textContent === name &&
          !document.querySelector('#content [role="status"]')?.textContent.startsWith('Loading'),
        label,
      );
      // Tables with two data rows or more, and their data columns (not the row-action column); closed sections open.
      await page.evaluate(() => {
        for (const section of document.querySelectorAll('#content details')) section.open = true;
      });
      // D-M-11 table parity, per table (empty ones included): a search box in its toolbar row, "Filters" when more
      // than one column filters, and the bottom bar with the count, rows per page and Previous/Next. The page's main
      // list (Data records, Flows runs, Backend operations, the Activity tab lists) takes its search and Filters from the
      // page toolbar row; Data records pages
      // on the runtime, where its toolbar search covers every column, so it has no column filters.
      const parity = await page.evaluate(() => {
        const chrome = document.querySelector('#content .ui-page-chrome');
        return [...document.querySelectorAll('#content .ui-data-table')]
          .filter((wrap) => wrap.checkVisibility())
          .map((wrap) => {
            const id = wrap.dataset.dataTable,
              main = [
                'records',
                'flow-runs',
                'operations',
                'activity-list',
                'activity-log',
                'activity-findings',
                'activity-pages',
              ].includes(id);
            const bar = wrap.querySelector(':scope > .ui-table-bar'),
              foot = wrap.querySelector(':scope > .ui-table-foot');
            const problems = [];
            if (!bar?.querySelector('[data-table-search]') && !(main && chrome?.querySelector('input[type="search"]')))
              problems.push('no search box');
            if (
              id !== 'records' &&
              wrap.querySelectorAll('thead .ui-sort').length > 1 &&
              !bar?.querySelector('[data-filter-toggle]') &&
              !(main && chrome?.querySelector('[data-filter-toggle]'))
            )
              problems.push('no Filters');
            if (!foot?.querySelector('.ui-table-count')) problems.push('no count');
            if (!foot?.querySelector('[data-table-size]')) problems.push('no rows per page');
            if (foot?.querySelectorAll('[data-table-page]').length !== 2) problems.push('no Previous/Next');
            return [id, problems];
          });
      });
      for (const [table, problems] of parity) {
        audited.add(table);
        if (problems.length) failures.push(`${id} › ${table}: ${problems.join(', ')}`);
      }
      const tables = await page.evaluate(() =>
        [...document.querySelectorAll('#content .ui-data-table')]
          .filter((wrap) => wrap.checkVisibility() && wrap.querySelectorAll('tbody tr').length > 1)
          .map((wrap) => ({
            id: wrap.dataset.dataTable,
            columns: [...wrap.querySelectorAll('thead th')].map((th, index) => ({
              index,
              label: th.textContent.trim(),
              sortable: Boolean(th.querySelector('.ui-sort')),
              key: th.querySelector('.ui-sort')?.dataset.sortKey ?? null,
              actions: th.textContent.trim() === 'Actions' || /actions/.test(th.className),
            })),
          })),
      );
      for (const table of tables) {
        checked.add(table.id);
        for (const column of table.columns)
          if (
            !column.sortable &&
            !column.actions &&
            column.label &&
            !/^(Provenance|Instance override)/.test(column.label)
          )
            failures.push(`${id} › ${table.id}: "${column.label}" does not sort`);
        // A column sorted by what it shows (a key of its own may sort by a value it does not show: aria-sort only).
        const column =
          table.columns.find((item) => item.key?.startsWith('col-')) ?? table.columns.find((item) => item.sortable);
        if (!column) continue;
        const header = page.locator(`[data-data-table="${table.id}"] thead th`).nth(column.index);
        const shown = () =>
          page
            .locator(`[data-data-table="${table.id}"] tbody tr`)
            .evaluateAll(
              (rows, index) => rows.map((row) => row.cells[index]?.innerText.replace(/\s+/g, ' ').trim() ?? ''),
              column.index,
            );
        const inOrder = (values, order) =>
          values.every(
            (value, index) =>
              !index ||
              (order === 'ascending' ? 1 : -1) * values[index - 1].localeCompare(value, undefined, { numeric: true }) <=
                0,
          );
        for (const order of ['ascending', 'descending']) {
          await header.locator('.ui-sort').click();
          await page.waitForFunction(
            ([name, index, value]) =>
              document.querySelectorAll(`[data-data-table="${name}"] thead th`)[index]?.getAttribute('aria-sort') ===
              value,
            [table.id, column.index, order],
          );
          const values = await shown();
          if (column.key.startsWith('col-') && !inOrder(values, order))
            failures.push(`${id} › ${table.id} ${order}: ${values.join(' | ')}`);
        }
      }
    }
    // The tables DV-N4c-1 named that this fixture fills were among the checked ones.
    for (const name of [
      'packs-registered',
      'packs-library',
      'svc-connector-providers',
      'svc-entities',
      'flow-async',
      'flow-webhooks',
      'cap-modules',
      'cap-unsupported',
      'environment-variables',
    ])
      if (!checked.has(name)) failures.push(`${name} was not shown with two rows`);
    assert.ok(audited.size >= 25, `${audited.size} tables audited`);
    // A column filter applies from its drawer, shows a chip, and the chip removes it.
    await page.evaluate(() => {
      location.hash = 'packs';
    });
    const registered = page.locator('table[data-table="packs-registered"] tbody tr');
    await registered.nth(1).waitFor();
    await page.locator('[data-data-table="packs-registered"] [data-filter-toggle]').click();
    await page.getByRole('searchbox', { name: 'Name', exact: true }).fill('Alpha');
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    await page.waitForFunction(
      () => document.querySelectorAll('table[data-table="packs-registered"] tbody tr').length === 1,
    );
    assert.match(await registered.first().innerText(), /Alpha pack/);
    assert.match(
      await page.locator('[data-data-table="packs-registered"] [data-filter-toggle]').innerText(),
      /^Filters · 1$/,
    );
    await page.getByRole('button', { name: 'Remove filter Name: Alpha', exact: true }).click();
    await registered.nth(1).waitFor();
    assert.deepEqual(failures, []);
    assert.deepEqual(errors, []);
  },
);

// DV-N4c-3/4/5: on Health the banner's Errors counts failed activities (the rows its link lists), Expand draws each
// tile's stats-route timeline since start (a gauge says why it has none, Findings graphs /diagnostics), and every
// (i) sits on the line of what it explains.
test(
  'Health: Errors counts failed activities, Expand graphs timelines since start, each (i) beside its label',
  { timeout: 90_000 },
  async (t) => {
    const traces = createTraceStore({ settings: { level: 'summary' } });
    recordTraffic(traces);
    // One failed activity with three failed plug-in steps: four failed steps, one failed activity.
    const failed = traces.start({
      kind: 'http',
      name: 'POST /_api/x_items',
      module: 'portal',
      operation: 'post',
      actor: { kind: 'contact', id: 'fx-contact', name: 'Invented Contact' },
      origin: { host: 'power-pages', portal: 'fx-portal', preset: null },
      traceId: null,
      parentSpanId: null,
    });
    traces.run(failed, () => {
      for (const name of ['Invented.Step one', 'Invented.Step two', 'Invented.Step three'])
        traces.start({ kind: 'plugin-step', name, module: 'plugins', operation: 'create', entity: 'x_item' }).end({
          status: 'error',
          error: new Error('Invented step failure.'),
        });
    });
    failed.end({ status: 'error', error: new Error('Invented failure.'), attributes: { statusCode: 500 } });
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const { origin, calls } = await host(t, {
      state: structuredClone(MONITOR_STATE),
      status: { docs, routes: [...POWER_PAGES_ROUTES, '/trace', '/diagnostics'], eventChannels: ['logs', 'trace'] },
      traces,
      answers: {
        '/dashboard': () => {
          const body = dashboard();
          return { ...body, runtime: { ...body.runtime, startedAt } };
        },
        '/diagnostics': {
          diagnostics: [
            { code: 'FX_EARLY', count: 3, time: startedAt },
            { code: 'FX_LATE', count: 1, time: new Date().toISOString() },
          ],
        },
      },
    });
    const { page, errors } = await open(t, origin, '#health');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const strip = page.locator('.dm-strip a[href="#activity?result=error"] strong');
    await strip.waitFor();
    assert.equal(await strip.innerText(), '1', 'one failed activity, not four failed steps');
    assert.equal(
      (await traces.stats()).overall.errors,
      4,
      'the store holds four failed steps, so the banner number is the activity count',
    );

    await page.locator('[data-dashboard-expand]').click();
    const trend = (key) => page.locator(`[data-kpi="${key}"] .dm-kpi-trend`);
    await page.waitForFunction(() =>
      /requests per \d+ s since start/.test(
        document.querySelector('[data-kpi="requests"] .dm-kpi-trend')?.textContent ?? '',
      ),
    );
    assert.ok(calls.some((call) => call.startsWith('GET /__sim/api/trace/stats?host=power-pages&depth=0&from=')));
    assert.ok(calls.some((call) => call.startsWith('GET /__sim/api/trace/stats?kind=plugin-step&from=')));
    // A real timeline: the requests of this test are in the last bucket, the earlier ones are empty.
    const heights = await page.locator('[data-kpi="requests"] .dm-spark-line').evaluate((line) =>
      line
        .getAttribute('points')
        .split(' ')
        .map((point) => Number(point.split(',')[1])),
    );
    assert.ok(heights.length > 10, `${heights.length} buckets`);
    assert.ok(new Set(heights).size > 1, 'the line rises where the requests are');
    assert.match(await trend('plugins').innerText(), /runs per \d+ s since start/);
    assert.match(await trend('jobs').innerText(), /^No timeline: a current level/);
    assert.equal(await page.locator('[data-kpi="jobs"] .dm-spark').count(), 0);
    assert.match(await trend('diagnostics').innerText(), /findings per \d+ s since start/);
    assert.equal(await page.locator('[data-kpi="diagnostics"] .dm-spark').count(), 1);

    // Each (i) on the line of its label: the preflight fields and every band count.
    const sameLine = (selector) =>
      page.evaluate((query) => {
        return [...document.querySelectorAll(query)].map((info) => {
          const owner = info.previousElementSibling ?? info.parentElement;
          const a = info.getBoundingClientRect(),
            b = owner.getBoundingClientRect();
          return a.top < b.bottom && a.bottom > b.top;
        });
      }, selector);
    assert.deepEqual(await sameLine('#dashboard-preflight .ui-field-info'), [true, true]);
    const bands = await sameLine('.dm-band-health > .ui-info');
    assert.ok(bands.length > 0 && bands.every(Boolean), `band (i) beside the count: ${bands}`);
    assert.deepEqual(errors, []);
  },
);

// DV-N4d-1: a group's (i) sits in its legend (Portal identity's web-role memberships, Live connection's confinement
// exceptions) and the group keeps its title as its name; on a phone a panel title keeps its (i) while its button wraps
// (Entity mappings).
test(
  'a fieldset (i) sits beside its legend, and a phone panel title keeps its (i) beside it',
  { timeout: 90_000 },
  async (t) => {
    const state = structuredClone(MONITOR_STATE);
    state.status.webRoles = [
      { id: 'fx-role-1', name: 'Invented role' },
      { id: 'fx-role-2', name: 'Invented reviewers' },
    ];
    const { origin } = await host(t, { state, status: { docs, routes: POWER_PAGES_ROUTES } });
    const { page, errors } = await open(t, origin, '#home');
    // The (i) and the title share a line: their boxes overlap vertically.
    const beside = (title, info) =>
      page.evaluate(
        ([titleQuery, infoQuery]) => {
          const a = document.querySelector(titleQuery)?.getBoundingClientRect(),
            b = document.querySelector(infoQuery)?.getBoundingClientRect();
          return Boolean(a && b && b.top < a.bottom && b.bottom > a.top && b.left >= a.right - 1);
        },
        [title, info],
      );
    for (const [hash, fieldset, name] of [
      ['access', '#persona-roles', 'Contact web-role memberships'],
      ['connection', '#confinement-options', 'Exceptions while confined'],
    ]) {
      await page.evaluate((target) => {
        location.hash = target;
      }, hash);
      await page.locator(`${fieldset} legend .ui-info`).waitFor();
      assert.equal(
        await beside(`${fieldset} legend .ui-legend-text`, `${fieldset} legend .ui-info-button`),
        true,
        `${name}: (i) beside the legend`,
      );
      assert.equal(await page.locator(fieldset).getAttribute('role'), null);
      assert.equal(await page.getByRole('group', { name, exact: true }).count(), 1, `${name} keeps its name`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      location.hash = 'mappings';
    });
    const heading = page.getByRole('heading', { name: 'Form & view schema overrides', exact: true });
    await heading.waitFor();
    const panel = '.panel:has(> .panel-heading [data-add="componentSchemas"])';
    assert.equal(
      await beside(`${panel} h2`, `${panel} h2 + :is(.ui-help-inline, .ui-note) .ui-info-button`),
      true,
      'title and (i) on one line',
    );
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  },
);
