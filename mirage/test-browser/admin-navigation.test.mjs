import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

test(
  'admin paginates large tables, lazily inspects details and never requests the audit',
  { timeout: 60000 },
  async (t) => {
    const mappings = Array.from({ length: 85 }, (_, i) => ({
      id: `entity${i}`,
      logicalName: `entity${i}`,
      entitySet: `entities${i}`,
      idColumn: `entity${i}id`,
    }));
    const workspace = {
      csrf: 'fixture-csrf',
      config: {
        mappings,
        plugins: [],
        endpoints: [],
        permissions: [],
        presets: [],
        identity: {},
      },
      data: {
        entity0: Array.from({ length: 81 }, (_, i) => ({
          entity0id: `row${i}`,
          name: `Record ${i}`,
        })),
      },
      status: {
        pages: [],
        permissionModel: {
          tree: Array.from({ length: 100 }, (_, i) => ({
            id: `grant${i}`,
            name: `Grant ${i}`,
            entity: 'entity0',
            enabled: true,
            scope: 'global',
            operations: ['read'],
            roles: ['Reader'],
          })),
        },
      },
      diagnostics: [],
    };
    const calls = [];
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        calls.push(url.pathname + url.search);
        if (url.pathname.startsWith('/__sim/api')) {
          res.setHeader('content-type', 'application/json');
          if (url.pathname.endsWith('/personas')) return res.end(JSON.stringify({}));
          if (url.pathname.endsWith('/state')) return res.end(JSON.stringify(workspace));
          if (url.pathname.endsWith('/records/contact'))
            return res.end(
              JSON.stringify({
                items: [],
                total: 0,
                page: 1,
                pageSize: 100,
                pageCount: 1,
              }),
            );
          res.writeHead(404).end('{}');
          return;
        }
        const file = url.pathname === '/__sim/' ? 'index.html' : url.pathname.split('/').at(-1);
        res.setHeader(
          'content-type',
          file.endsWith('.mjs') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html',
        );
        res.end(
          await fs.readFile(
            new URL(
              `../${['persona-search.mjs', 'persona-picker-view.mjs'].includes(file) ? 'lib' : 'admin'}/${file}`,
              import.meta.url,
            ),
          ),
        );
      } catch (error) {
        res.writeHead(500).end(JSON.stringify({ error: error.message }));
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
    t.after(async () => {
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const page = await browser.newPage();
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    await page.goto(origin + '/__sim/#mappings');
    await page.getByRole('heading', { name: 'Entity mappings', exact: true }).waitFor();
    assert.equal(await page.locator('table[data-table="mappings"] tbody tr').count(), 10);
    assert.ok(!calls.some((path) => path.includes('/audit')));
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.equal(
      await page.locator('table[data-table="mappings"] tbody tr').first().innerText(),
      'entity10\tentities10\tentity10id\tEditDelete',
    );
    await page.getByRole('searchbox', { name: 'Search mappings', exact: true }).fill('entity84');
    assert.equal(await page.locator('table[data-table="mappings"] tbody tr').count(), 1);
    assert.match(await page.locator('table[data-table="mappings"] tbody').innerText(), /entity84/);
    workspace.status.richTextConfigurations = [
      {
        version: 1,
        kind: 'rich-text-json',
        url: '/rte.js',
        sourceFile: 'rte.webfile.js',
        sourceSha256: 'a'.repeat(64),
        sha256: 'b'.repeat(64),
        cachePath: '/__sim-static/richtext-config/fixture.json',
        observedPath: '/_webresource/rte.js',
        origin: 'https://portal.example.test',
        capturedAt: '2026-10-07T10:00:00Z',
        status: 'eligible',
      },
    ];
    await page.locator('#refresh').click();
    // Baselines are collapsed sections; open the rich-text one.
    await page.locator('[data-disclosure="rich-text-baselines"] > summary').click();
    await page.getByRole('heading', { name: 'Versioned rich-text JSON baselines' }).waitFor();
    assert.equal(await page.getByText('a'.repeat(64), { exact: false }).count(), 0);
    await page.getByText('Inspect versioned provenance', { exact: true }).click();
    await page.getByText('a'.repeat(64), { exact: false }).waitFor();
    workspace.status.richTextConfigurations[0].status = 'stale';
    await page.locator('#refresh').click();
    await page.getByText('Local source wins', { exact: true }).waitFor();
    await page.getByRole('link', { name: 'Data records', exact: false }).click();
    await page.getByRole('heading', { name: 'Data records', exact: true }).waitFor();
    assert.equal(await page.locator('table[data-table="records"] tbody tr').count(), 20);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.match(await page.locator('table[data-table="records"] tbody').innerText(), /Record 20/);
    await page.getByRole('link', { name: 'Identity & permissions', exact: false }).click();
    await page
      .getByRole('heading', {
        name: 'Effective permission hierarchy',
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator('table[data-table="grant tree"] tbody tr').count(), 10);
    assert.equal(await page.locator('#identity-form').count(), 0);
    assert.equal(await page.locator('[data-disclosure="raw-permissions"]').getAttribute('open'), null);
    await page.getByText('Advanced: configured identity (sign-in default and scripts)', { exact: true }).click();
    await page.locator('#identity-form').waitFor();
    await page.getByText('Advanced: configured identity (sign-in default and scripts)', { exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(failures, []);
  },
);
