import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { ADMIN_CSP } from '../lib/runtime-admin.mjs';
import { closeServer } from './shared-browser.mjs';

// The four view modules run in a minimal harness page (app.mjs wiring is separate): the harness builds the ctx,
// renders a module into #content, delegates click/submit/change/input to handle(), keeps section open state from
// `toggle` events and confirms through a <dialog>. Modules, the kit and the help content are served from disk.
const HARNESS = `
import { HELP } from '/__sim/help-content.mjs';
import { escapeHtml } from '/__sim/ui-kit.mjs';
import { view as services } from '/__sim/view-services.mjs';
import { view as flows } from '/__sim/view-flows.mjs';
import { view as capabilities } from '/__sim/view-capabilities.mjs';
import { view as packs } from '/__sim/view-packs.mjs';
const views = { services, flows, capabilities, packs };
const content = document.getElementById('content'), dialog = document.getElementById('confirm');
const data = {}, open = new Set(), pagers = {};
let state = {}, current = services, confirmAction = null;
async function request(path, options = {}) {
  const write = options.method && options.method !== 'GET';
  const response = await fetch('/__sim/api' + path, { ...options, headers: { 'content-type': 'application/json', ...(write ? { 'x-sim-csrf': state.csrf } : {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? response.statusText);
  return body;
}
const ctx = {
  request, data, help: HELP, escape: escapeHtml,
  state: () => state, session: () => ({}), capabilities: () => state.capabilities ?? {}, docs: () => state.docs ?? {}, links: () => ({}),
  pager: key => (pagers[key] ??= { page: 1, size: 10, search: '' }), open: key => open.has(key), toggle: key => (open.has(key) ? open.delete(key) : open.add(key)),
  async refresh() { await current.load(ctx); content.innerHTML = current.render(ctx); },
  notify(message, error) { const box = document.getElementById('notification'); box.textContent = message; box.dataset.error = error ? 'true' : 'false'; },
  setButtonPending(button, pending) { if (button) button.disabled = pending; return true; },
  askConfirmation(title, message, action, label) {
    document.getElementById('confirm-title').textContent = title; document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-submit').textContent = label; confirmAction = action; dialog.showModal();
  },
};
document.getElementById('confirm-form').addEventListener('submit', async event => { event.preventDefault(); await confirmAction(); dialog.close(); });
document.getElementById('confirm-cancel').addEventListener('click', () => dialog.close());
for (const type of ['click', 'submit', 'change', 'input']) content.addEventListener(type, event => current.handle(ctx, event));
content.addEventListener('toggle', event => { const key = event.target.dataset?.uiSection; if (key) (event.target.open ? open.add(key) : open.delete(key)); }, true);
async function route() { current = views[location.hash.slice(1).split('?')[0]] ?? services; await ctx.refresh(); document.body.dataset.ready = current.id; }
window.addEventListener('hashchange', route);
state = await request('/state');
await route();
`;
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>View harness</title>
<link rel="stylesheet" href="/__sim/ui-kit.css"><link rel="stylesheet" href="/__sim/shell.css"><link rel="stylesheet" href="/__sim/style.css"><script type="module" src="/harness.mjs"></script></head>
<body><main id="content"></main><p id="notification" role="status"></p>
<dialog id="confirm"><form id="confirm-form"><h2 id="confirm-title"></h2><p id="confirm-message"></p><button type="button" id="confirm-cancel">Cancel</button><button type="submit" id="confirm-submit">Confirm</button></form></dialog></body></html>`;

const dashboard = {
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
      id: 'provider:messaging',
      kind: 'provider',
      label: 'Message bus',
      status: 'ready',
      level: 'behaviour',
      detail: { id: 'local' },
    },
    {
      id: 'provider:local-service:fx-functions',
      kind: 'provider',
      label: 'fx-functions',
      status: 'declared',
      detail: { service: 'http', required: true },
    },
    {
      id: 'org:plugins',
      kind: 'org',
      label: 'Plug-in steps',
      status: 'ready',
      detail: { webhooks: [{ name: 'Invented hook', host: 'hooks.example.test', loopback: false }] },
    },
  ],
  activity: { messages: { active: 2 }, jobs: { pending: 0 }, webhooks: { delivered: 0, failed: 0, notContacted: 1 } },
};
const report = {
  summary: { total: 2, satisfied: 1, missing: 1, blocking: 1 },
  requirements: [
    { id: 'local-service:fx-functions', kind: 'local-service', status: 'satisfied', inScope: true, blocking: false },
    {
      id: 'local-service:fx-queue',
      kind: 'local-service',
      status: 'missing',
      inScope: true,
      blocking: true,
      message: 'Invented service did not answer.',
    },
  ],
};
const packs = {
  packs: [
    {
      id: 'fx-pack',
      name: 'Invented pack',
      module: 'pack/fx-pack.mjs',
      registration: { source: 'project', setupLink: '/_setup/#packs' },
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
  setupLink: '/_setup/#packs',
};
const routes = {
  '/state': {
    csrf: 'fixture-csrf',
    capabilities: { powerPages: true },
    capabilityReport: {
      modules: [{ name: 'fx-module', kind: 'organization-module', level: 'behaviour', operations: [] }],
      missing: [],
      unsupported: [],
    },
    inventory: { total: 0, components: {} },
    status: { scenarios: [{ id: 'fx-scenario', name: 'Invented scenario' }] },
    docs: {},
  },
  '/dashboard': dashboard,
  '/messages': {
    configured: true,
    entities: [{ entity: 'fx-orders', stats: { active: 2, locked: 0, scheduled: 0, deadLettered: 0 } }],
    endpoints: { 'fx-endpoint': 'local/fx-orders' },
  },
  '/outbox': { configured: true, entries: [] },
  '/flow-waits': [{ id: 'fx-approval', kind: 'approval', runId: 'run-1', processId: 'p1', overdue: false }],
  '/flow-runs': [{ id: 'run-1', processId: 'p1', status: 'Waiting', starttime: '2026-10-22T09:00:00Z' }],
  '/environment': { environmentVariables: { definitions: [] } },
  '/preflight': report,
  '/packs': packs,
};

test(
  'admin service views peek and purge, answer approvals, run preflight and expand pack details',
  { timeout: 60000 },
  async (t) => {
    const calls = [];
    // A notification can precede the asynchronous reload. Hold that reload so the check
    // exercises the pending UI state rather than depending on a fast loopback response.
    let releasePurgeRefresh;
    const purgeRefresh = new Promise((resolve) => {
      releasePurgeRefresh = resolve;
    });
    t.after(() => releasePurgeRefresh());
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost');
      try {
        if (url.pathname.startsWith('/__sim/api/')) {
          const route = url.pathname.slice('/__sim/api'.length);
          let body = '';
          for await (const chunk of req) body += chunk;
          calls.push({
            method: req.method,
            path: route,
            search: url.search,
            csrf: req.headers['x-sim-csrf'] ?? null,
            body: body ? JSON.parse(body) : null,
          });
          res.setHeader('content-type', 'application/json');
          if (req.method === 'DELETE' && route === '/messages/fx-orders')
            return res.end(JSON.stringify({ entity: 'fx-orders', purged: 2 }));
          if (req.method === 'POST' && route === '/flow-waits/fx-approval') {
            res.statusCode = 202;
            return res.end(
              JSON.stringify({
                runId: 'run-1',
                waitId: 'fx-approval',
                kind: 'approval',
                scheduled: true,
                outcome: 'Approve',
              }),
            );
          }
          if (route === '/messages' && url.searchParams.get('entity'))
            return res.end(
              JSON.stringify({
                entity: 'fx-orders',
                messages: [
                  {
                    messageId: 'fx-message-1',
                    sequenceNumber: 1,
                    state: 'active',
                    deliveryCount: 0,
                    body: { invented: true },
                  },
                ],
              }),
            );
          if (!Object.hasOwn(routes, route)) {
            res.statusCode = 404;
            return res.end(JSON.stringify({ error: { message: 'Not found' } }));
          }
          if (route === '/messages' && calls.some((call) => call.method === 'DELETE')) await purgeRefresh;
          return res.end(JSON.stringify(routes[route]));
        }
        if (url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': ADMIN_CSP });
          return res.end(PAGE);
        }
        if (url.pathname === '/harness.mjs') {
          res.writeHead(200, { 'content-type': 'text/javascript' });
          return res.end(HARNESS);
        }
        const asset = /^\/__sim\/([a-z0-9-]+)\.(mjs|css)$/.exec(url.pathname);
        if (asset) {
          const file = await fs.readFile(new URL(`../admin/${asset[1]}.${asset[2]}`, import.meta.url));
          res.writeHead(200, { 'content-type': asset[2] === 'css' ? 'text/css' : 'text/javascript' });
          return res.end(file);
        }
        res.statusCode = 404;
        res.end();
      } catch (error) {
        res.statusCode = 500;
        res.end(error.message);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => closeServer(server));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(() => browser.close());
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const noOverflow = async () =>
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        'no horizontal overflow at 390 px',
      );

    // Providers & services: peek, then purge through the confirmation dialog with the CSRF header; probe a local service.
    await page.goto(`${origin}/#services`);
    await page.waitForSelector('body[data-ready=services]');
    await page.getByRole('heading', { name: 'Providers & services' }).waitFor();
    await page.locator('[data-ui-section="services:messaging"] > summary').click();
    await page.getByRole('button', { name: 'Peek fx-orders' }).click();
    await page.locator('table[data-table="svc-peek"]').getByText('fx-message-1').waitFor();
    await page.getByRole('button', { name: 'Purge fx-orders' }).click();
    await page.getByRole('dialog').getByRole('heading', { name: 'Purge fx-orders?' }).waitFor();
    await page.getByRole('dialog').getByRole('button', { name: 'Purge' }).click();
    await page.locator('#notification').getByText('Purged 2 messages from fx-orders.').waitFor();
    const purge = calls.find((call) => call.method === 'DELETE');
    assert.deepEqual([purge.path, purge.csrf], ['/messages/fx-orders', 'fixture-csrf']);
    assert.equal(
      await page.locator('table[data-table="svc-peek"]').count(),
      1,
      'the pending refresh retains its old view',
    );
    releasePurgeRefresh();
    await page.locator('table[data-table="svc-peek"]').waitFor({ state: 'detached' });
    await page.locator('[data-ui-section="services:local-services"] > summary').click();
    await page.getByRole('button', { name: 'Probe fx-functions now' }).click();
    await page.locator('table[data-table="svc-local-services"]').getByText('satisfied').waitFor();
    assert.ok(
      calls.some((call) => call.path === '/preflight' && call.search === '?requires=local-service%3Afx-functions'),
    );
    await noOverflow();

    // Flows & jobs: answer the approval.
    await page.goto(`${origin}/#flows`);
    await page.waitForSelector('body[data-ready=flows]');
    await page.locator('[data-ui-section="flows:waits"] > summary').click();
    await page.getByRole('button', { name: 'Answer wait fx-approval' }).click();
    await page.getByLabel('Responder').fill('reviewer@example.test');
    await page.getByLabel('Comments').fill('Invented comment');
    await page.getByRole('button', { name: 'Approve' }).click();
    await page.locator('#notification').getByText('Run run-1 is scheduled to resume (Approve).').waitFor();
    const answer = calls.find((call) => call.method === 'POST');
    assert.deepEqual(
      [answer.path, answer.csrf, answer.body],
      [
        '/flow-waits/fx-approval',
        'fixture-csrf',
        { outcome: 'Approve', responder: 'reviewer@example.test', comments: 'Invented comment' },
      ],
    );
    await noOverflow();

    // Capabilities & preflight: run a strict preflight and read the grouped result.
    await page.goto(`${origin}/#capabilities`);
    await page.waitForSelector('body[data-ready=capabilities]');
    await page.locator('[data-ui-section="capabilities:preflight"] > summary').click();
    await page.getByLabel('Requirements').fill('local-service:*');
    await page.getByLabel('Strict').check();
    await page.getByRole('button', { name: 'Run preflight' }).click();
    await page
      .locator('table[data-table="cap-result-missing"]')
      .getByText('Invented service did not answer.')
      .waitFor();
    assert.equal(
      await page.locator('.ui-tile').filter({ hasText: 'Blocking' }).locator('.ui-tile-value').textContent(),
      '1',
    );
    assert.ok(
      calls.some((call) => call.path === '/preflight' && call.search === '?requires=local-service%3A*&strict=true'),
    );
    await page.getByRole('button', { name: /Preflight this scenario: Invented scenario/ }).click();
    await page.getByText('Scenario fx-scenario: saved scenarios carry no requirement list').waitFor();
    await noOverflow();

    // Data packs: expand the details of one pack.
    await page.goto(`${origin}/#packs`);
    await page.waitForSelector('body[data-ready=packs]');
    await page.getByRole('button', { name: 'Details of pack fx-pack' }).click();
    await page.locator('table[data-table="packs-fx-pack-exports"]').getByText('serverLogics').waitFor();
    await page.locator('table[data-table="packs-fx-pack-data"]').getByText('writable', { exact: true }).waitFor();
    // The setup link sits in the collapsed "Add or change a pack" panel.
    assert.equal(await page.locator('[data-ui-section="packs:lifecycle"] a').getAttribute('href'), '/_setup/#packs');
    await noOverflow();

    assert.deepEqual(errors, []);
  },
);
