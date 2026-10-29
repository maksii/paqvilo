// The /_sim/ Infrastructure dashboard against a fake JSON host: topology, node drawer,
// on-demand preflight, polling, the 503 "starting" state, 390 px layout, and the 404 fallback of an older host.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

const SHARED = new Set(['persona-search.mjs', 'persona-picker-view.mjs']);
const NODE_IDS = [
  'client:browser',
  'client:staff',
  'client:api',
  'host:portal',
  'host:model-driven',
  'host:dataverse-api',
  'host:tds',
  'host:identity-provider',
  'host:setup',
  'host:admin',
  'org:store',
  'org:plugins',
  'org:workflows',
  'org:flows',
  'org:jobs',
  'provider:storage',
  'provider:storage-route:x_files',
  'provider:messaging',
  'provider:outbox',
  'provider:connectors',
  'provider:secrets',
  'provider:local-service:fx-api',
  'external:azurite',
];
const nodes = NODE_IDS.map((id, index) => ({
  id,
  kind: id.split(':')[0],
  label: `Invented ${id.split(':').slice(1).join(' ')}`,
  status: ['listening', 'ready', 'declared', 'disabled', 'placeholder'][index % 5],
  detail: { port: index ? 0 : 5001 },
  ...(id === 'host:portal' ? { link: '#overview' } : {}),
}));
const edges = [
  { from: 'client:browser', to: 'host:portal', kind: 'http', status: 'listening', label: 'pages' },
  { from: 'host:portal', to: 'org:store', kind: 'reads', status: 'ready', label: 'data' },
  { from: 'org:store', to: 'provider:storage', kind: 'storage', status: 'ready', label: 'files' },
];
const activity = (total) => ({
  requests: {
    total,
    recent: [{ at: '2026-10-22T10:00:00.000Z', method: 'GET', path: '/invented/', status: 200, ms: 3 }],
  },
  dataverseRequests: { total: 0, recent: [] },
  plugins: { executions: 0, failures: 0 },
  flows: {},
  jobs: { pending: 0 },
  messages: { active: 0 },
  outbox: { queued: 0 },
  webhooks: {},
  storage: { byProvider: [] },
  diagnostics: { total: 0, byCode: {} },
});
const payload = (total) => ({
  generatedAt: new Date().toISOString(),
  runtime: {
    product: 'Mirage',
    kind: 'power-pages',
    simulationLevel: 'dry-run',
    clock: 'system',
    revision: 1,
    localOrigin: 'http://127.0.0.1:5001',
  },
  nodes,
  edges,
  activity: activity(total),
  docs: {},
  configuration: {
    packs: [{ id: 'invented-pack', module: 'pack/invented.mjs' }],
    solutionLayers: [],
    settingsKeys: ['dataverse'],
    ports: { portal: 5001 },
  },
});

async function host(t, { dashboard }) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    calls.push(url.pathname + url.search);
    try {
      if (url.pathname.startsWith('/__sim/api/')) {
        res.setHeader('content-type', 'application/json');
        const route = url.pathname.slice('/__sim/api'.length);
        if (route === '/state')
          return res.end(
            JSON.stringify({
              csrf: 'fixture-csrf',
              config: { mappings: [], plugins: [], endpoints: [], permissions: [], presets: [], identity: {} },
              data: {},
              status: { pages: [] },
              diagnostics: [],
            }),
          );
        if (route === '/personas') return res.end('{}');
        if (route === '/dashboard')
          return dashboard(res, calls.filter((call) => call === '/__sim/api/dashboard').length);
        if (route === '/preflight')
          return res.end(
            JSON.stringify({
              kind: 'paqvilo.mirage.preflight',
              scope: {
                requires: url.searchParams.getAll('requires'),
                strict: url.searchParams.get('strict') === 'true',
              },
              requirements: [
                {
                  id: 'table:x_item',
                  kind: 'table',
                  status: 'satisfied',
                  inScope: true,
                  blocking: false,
                  message: null,
                },
                {
                  id: 'cloud-flow:Invented approval',
                  kind: 'cloud-flow',
                  status: 'placeholder',
                  inScope: true,
                  blocking: true,
                  message: 'Registered at inventory.',
                },
              ],
              summary: { total: 2, satisfied: 1, placeholder: 1, blocking: 1 },
            }),
          );
        res.writeHead(404).end('{}');
        return;
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

async function open(t, origin, { clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  t.after(() => context.close());
  const page = await context.newPage();
  // The dashboard polls every 5 s; a fake page clock lets the test trigger each poll.
  if (clock) await page.clock.install();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/__sim/');
  return { page, errors };
}

test(
  'the dashboard lands first, renders every node, opens a node drawer, runs preflight, polls and fits 390 px',
  { timeout: 60_000 },
  async (t) => {
    // Requests 1-2 (route probe, first load) answer 503 starting; each later request reports its own count.
    const { origin, calls } = await host(t, {
      dashboard: (res, count) =>
        count <= 2
          ? res.writeHead(503).end(JSON.stringify({ status: 'starting' }))
          : res.end(JSON.stringify(payload(count))),
    });
    const { page, errors } = await open(t, origin, { clock: true });
    await page.getByRole('heading', { name: 'Infrastructure', exact: true }).waitFor();
    await page.getByText('The runtime is still starting.', { exact: false }).waitFor();
    assert.equal(
      await page.getByRole('link', { name: 'Infrastructure', exact: false }).getAttribute('aria-current'),
      'page',
    );

    await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
    await page.locator('[data-node]').first().waitFor();
    assert.equal(await page.locator('[data-node]').count(), nodes.length, 'one node per payload node');
    const requests = page.locator('.dm-kpi[data-kpi="requests"] .dm-kpi-value');
    assert.equal(await requests.innerText(), '3');

    // A node opens its drawer (click, then Escape closes it and returns focus; Enter reopens).
    await page.locator('[data-node="host:portal"]').click();
    const drawer = page.locator('#dashboard-node-detail .ui-drawer');
    await drawer.getByRole('heading', { name: 'Power Pages site', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.matches('.ui-drawer')),
      true,
      'focus moves to the drawer',
    );
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.node), 'host:portal');
    await page.keyboard.press('Enter');
    await drawer.getByRole('heading', { name: 'Power Pages site', exact: true }).waitFor();
    await drawer.getByRole('button', { name: 'Close details', exact: true }).click();
    await drawer.waitFor({ state: 'detached' });

    // Preflight runs on demand through GET /preflight and renders a kit table.
    await page.getByLabel(/Requirements/).fill('table:* cloud-flow:*');
    await page.getByLabel(/Strict/).check();
    await page.getByRole('button', { name: 'Run preflight', exact: true }).click();
    const results = page.locator('table[data-table="dashboard-preflight"] tbody tr');
    await results.nth(1).waitFor();
    assert.equal(await results.count(), 2);
    await page.getByText('2 requirements · 1 blocking (strict).', { exact: true }).waitFor();
    assert.ok(
      calls.some((call) => call === '/__sim/api/preflight?requires=table%3A*&requires=cloud-flow%3A*&strict=true'),
    );

    // The 5 s poll re-renders with the new activity; the preflight result stays.
    const polled = () => calls.filter((call) => call === '/__sim/api/dashboard').length;
    const nextPoll = async () => {
      const expected = String(polled() + 1);
      await page.clock.fastForward(5000);
      await page.waitForFunction(
        (expected) => document.querySelector('.dm-kpi[data-kpi="requests"] .dm-kpi-value')?.textContent === expected,
        expected,
      );
    };
    await nextPoll();
    assert.equal(await results.count(), 2);
    // Pack descriptors print their ids.
    assert.match(
      await page.locator('[data-ui-section="dashboard-configuration"]').textContent(),
      /Data packsinvented-pack/,
    );

    // A poll keeps keyboard focus and the open drawer element.
    await page.locator('[data-node="host:portal"]').click();
    await page.evaluate(() => {
      document.getElementById('dashboard-drawer').dataset.marker = 'kept';
    });
    await nextPoll();
    assert.deepEqual(
      await page.evaluate(() => [
        document.activeElement?.id,
        document.getElementById('dashboard-drawer')?.dataset.marker,
      ]),
      ['dashboard-drawer', 'kept'],
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.node), 'host:portal');
    await nextPoll();
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset.node),
      'host:portal',
      'a focused node keeps focus across a poll',
    );

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  },
);

test(
  'a host answering 404 for the dashboard hides Infrastructure and lands on the overview',
  { timeout: 60_000 },
  async (t) => {
    const { origin } = await host(t, { dashboard: (res) => res.writeHead(404).end('{}') });
    const { page, errors } = await open(t, origin);
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Infrastructure', exact: false }).count(), 0);
    await page.getByRole('link', { name: 'Data records', exact: true }).waitFor();
    assert.deepEqual(errors, []);
  },
);
