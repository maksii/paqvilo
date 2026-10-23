import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { createSetupHandler, startSetupServer } from '../lense/setup/server.mjs';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// One loopback origin serving /_setup/ (mounted as Mirage mounts it) and invented /_sim/ answers, so the page runs in live mode.
async function journeyServer(directory) {
  const fake = { live: false, requests: 0, preflight: [] };
  const handler = await createSetupHandler({ directory, processEnv: {}, runtime: { product: 'Mirage', sourceDir: path.join(directory, 'portal-export') } });
  const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    handler(req, res).then(handled => {
      if (handled) return;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/_sim/api/status') return json(res, 200, { presets: [{ id: 'invented-starter', name: 'Invented starter' }], modelDrivenApps: [{ id: '00000000-0000-4000-8000-0000000000aa', uniqueName: 'x_invented', name: 'Invented app' }] });
      if (url.pathname === '/_sim/api/packs') return json(res, 200, { packs: [{ id: 'invented', matched: true, diagnostics: [], personaCatalog: { groups: 1, personas: 2, contexts: 0, scenarios: 1 } }], failed: [], library: [] });
      if (url.pathname === '/_sim/api/preflight') {
        fake.preflight.push(url.search);
        return json(res, 200, { kind: 'paqvilo.mirage.preflight', summary: { total: 1, satisfied: 0, blocking: 1 }, requirements: [{ id: 'table:x_item', kind: 'table', status: 'missing', blocking: true, message: 'Invented requirement is not satisfied.' }] });
      }
      if (url.pathname === '/_sim/api/dashboard') {
        if (!fake.live) return json(res, 503, { error: { message: 'Not started.' } });
        fake.requests++;
        return json(res, 200, {
          generatedAt: new Date().toISOString(),
          runtime: { product: 'Mirage', kind: 'power-pages', simulationLevel: 'simulation', clock: 'system', revision: 1, localOrigin: 'http://127.0.0.1' },
          nodes: [
            { id: 'client:browser', kind: 'client', label: 'Browser', status: 'ready' },
            { id: 'host:portal', kind: 'host', label: 'Invented portal', status: 'listening', detail: { port: 8787 }, link: '#overview' },
            { id: 'org:store', kind: 'org', label: 'Data store', status: 'ready' },
          ],
          edges: [{ from: 'client:browser', to: 'host:portal', kind: 'http', status: 'ready', label: 'HTTP' }, { from: 'host:portal', to: 'org:store', kind: 'reads', status: 'ready', label: 'Reads' }],
          activity: { requests: { total: fake.requests, recent: [{ at: new Date().toISOString(), method: 'GET', path: '/invented', status: 200, ms: 3 }] }, diagnostics: { total: 0, byCode: {} } },
        });
      }
      json(res, 404, { error: { message: 'Unknown fixture route.' } });
    }).catch(() => { if (!res.headersSent) json(res, 500, { error: { message: 'Fixture failed.' } }); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/_setup/`, fake, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}

async function saved(page, click) {
  const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST'), click()]);
  assert.equal(response.ok(), true, await response.text());
  await page.locator('#notice').filter({ hasText: /^Saved\./ }).waitFor();
}
const stageLink = (page, name) => page.getByRole('navigation', { name: 'Setup stages' }).getByRole('link', { name });

test('setup journey: template, stage rail, packs, setting editor, restart command and planned-to-live system map', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-setup-journey-'));
  const server = await journeyServer(directory);
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(async () => { await browser.close(); });
  ownedFixture(t).add(async () => { await server.close(); });
  ownedFixture(t).remove(async () => { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const file = path.join(directory, 'paqvilo.config.yml'), read = async () => YAML.parse(await fs.readFile(file, 'utf8'));

  // Create from a template: the placeholder findings are explained as next steps, not errors.
  await page.goto(server.url);
  const template = page.locator('form[data-form=template]');
  await template.getByLabel(/Power Pages portal/).check();
  await template.locator('#template-target').fill('invented-portal');
  await saved(page, () => template.getByRole('button', { name: 'Create from template' }).click());
  assert.equal((await read()).sites['invented-portal'].environments.dev, 'https://invented-portal.example.test');
  const overview = page.locator('#overview');
  assert.match(await overview.innerText(), /They are not errors/);
  assert.ok(await overview.locator('.findings li').filter({ hasText: 'replace the placeholder' }).filter({ hasText: 'next step' }).count() >= 1);
  assert.match(await stageLink(page, /^Sources/).innerText(), /next step/);
  assert.match(await stageLink(page, /^Environments/).innerText(), /to do/);
  assert.equal(await page.locator('#portals').evaluate(node => node.open), true, 'the next stage opens');
  assert.equal(await page.locator('#providers').evaluate(node => node.open), false, 'other stages stay collapsed');

  // Restart command of the running preview, and runtime presets offered as suggestions.
  assert.match(await page.locator('#restart-command').innerText(), /^npx paqvilo mirage dev --config .*paqvilo\.config\.yml --site invented-portal$/);
  assert.equal(await page.locator('#preset-options option[value="invented-starter"]').count(), 1);
  assert.equal(await page.locator('#app-options option[value="00000000-0000-4000-8000-0000000000aa"]').count(), 1);

  // A Power Pages site form registers packs and fixes sources and environments; the rail follows the save.
  await fs.cp(path.join(root, 'examples/project/portal'), path.join(directory, 'portal-export'), { recursive: true });
  await page.locator('#portal-invented-portal summary').first().click();
  const site = page.locator('form[data-form=site][data-site=invented-portal]');
  await site.locator('[name=env-url]').fill('http://127.0.0.1:8787');
  await site.locator('[name=site-packs]').fill('invented | ./pack/pack.mjs');
  assert.equal(await site.locator('[name=preset]').getAttribute('list'), 'preset-options');
  await saved(page, () => site.getByRole('button', { name: 'Save portal' }).click());
  const sitesAfter = (await read()).sites['invented-portal'];
  assert.deepEqual(sitesAfter.mirage.dataPacks, [{ id: 'invented', module: './pack/pack.mjs' }]);
  assert.equal(sitesAfter.environments.dev.url, 'http://127.0.0.1:8787');
  assert.match(await stageLink(page, /^Sources/).innerText(), /done/);
  assert.match(await stageLink(page, /^Environments/).innerText(), /done/);
  assert.match(await stageLink(page, /^Data packs/).innerText(), /next step/, 'the missing pack module is the next step');
  await stageLink(page, /^Data packs/).click();
  const packs = page.locator('#packs table[data-table=packs]');
  assert.match(await packs.innerText(), /invented[\s\S]*missing[\s\S]*matched/);

  // The setting editor saves a key without a dedicated form through a YAML snippet, to the layer in its badge.
  await stageLink(page, /^Providers & services/).click();
  await page.locator('#providers summary').filter({ hasText: 'Setting editor · Providers & services' }).click();
  const setting = page.locator('form[data-form=setting][data-key=localServices][data-site=invented-portal]');
  await setting.locator('[name=value]').fill('invented-api:\n  kind: http\n  baseUrl: http://127.0.0.1:7071\n  probe: /health\n');
  await saved(page, () => setting.getByRole('button', { name: 'Save setting localServices' }).click());
  assert.equal((await read()).sites['invented-portal'].mirage.localServices['invented-api'].kind, 'http');
  assert.equal(await page.locator('#providers').evaluate(node => node.open), true, 'the edited section stays open after the save');

  // The system map renders the planned topology and switches to live mode when the runtime answers.
  await page.getByRole('navigation', { name: 'Setup navigation' }).getByRole('link', { name: 'System map' }).click();
  const system = page.locator('#system');
  await system.locator('.ui-dashboard[data-dashboard-mode=planned]').waitFor();
  assert.ok(await system.locator('[data-node]').count() > 0);
  server.fake.live = true;
  await system.locator('.ui-dashboard[data-dashboard-mode=live]').waitFor({ timeout: 15_000 });
  assert.equal(await system.locator('[data-node]').count(), 3);
  await system.locator('[data-node="host:portal"]').click();
  // The drawer names the product of the clicked node; the node's own label stays a fact.
  await system.locator('.ui-drawer[data-node-detail="host:portal"] h3').filter({ hasText: 'Power Pages site' }).waitFor();
  assert.equal(await system.locator('.ui-drawer a.ui-button').getAttribute('href'), '/_sim/#overview');
  await system.locator('#dashboard-preflight-requires').fill('table:x_item');
  await system.getByRole('button', { name: 'Run preflight' }).click();
  await system.locator('table[data-table=preflight]').filter({ hasText: 'table:x_item' }).waitFor();
  assert.deepEqual(server.fake.preflight, ['?requires=table%3Ax_item']);

  // Narrow screens keep every opened section inside the viewport.
  if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
    await fs.mkdir(path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS), { recursive: true });
    await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-journey-desktop.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  // Every disclosure open, including the setting examples whose rows hold visually hidden labels (RU3-12).
  await page.evaluate(() => { for (const node of document.querySelectorAll('details')) node.open = true; });
  if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
    await page.screenshot({ path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-journey-mobile.png'), fullPage: true });
  }
  const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => `${node.tagName}.${node.className}`).slice(0, 8));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, overflow.join(', '));
  assert.deepEqual(errors, []);
});

test('identity and persona forms write only changed keys and refuse secret values', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-setup-identity-'));
  const file = path.join(directory, 'paqvilo.config.yml'), read = async () => YAML.parse(await fs.readFile(file, 'utf8'));
  const application = { appId: '00000000-0000-4000-8000-000000000001', displayName: 'Invented client', secretEnvironmentVariable: 'INVENTED_CLIENT_SECRET' };
  await fs.writeFile(file, YAML.stringify({ sourceRoot: '.', defaultSite: 'invented', sites: { invented: { mirage: { port: 0, runtime: { kind: 'dataverse-api' }, simulation: { level: 'dry-run' }, dataverse: { enabled: true, port: 0, applications: [application] } } } } }));
  const server = await startSetupServer({ directory, processEnv: {} });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(async () => { await browser.close(); });
  ownedFixture(t).add(async () => { await server.close(); });
  ownedFixture(t).remove(async () => { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '#identity');
  await page.locator('#identity summary').filter({ hasText: 'TLS, tenant, registrations and users' }).click();
  const identity = page.locator('form[data-form=identity][data-site=invented]');
  assert.equal(await identity.locator('[name=applications]').inputValue(), '00000000-0000-4000-8000-000000000001 | Invented client | INVENTED_CLIENT_SECRET');
  await identity.locator('[name=users]').fill('invented.user@example.test | Invented User');
  await saved(page, () => identity.getByRole('button', { name: 'Save identity & API' }).click());
  const dataverse = (await read()).sites.invented.mirage.dataverse;
  assert.deepEqual(dataverse.users, [{ domainname: 'invented.user@example.test', fullname: 'Invented User' }]);
  assert.deepEqual(dataverse.applications, [application], 'unchanged registrations are not rewritten');
  const before = await fs.readFile(file, 'utf8');
  await identity.locator('[name=applications]').fill('00000000-0000-4000-8000-000000000001 | Invented client | s3cr3t value!');
  await identity.getByRole('button', { name: 'Save identity & API' }).click();
  await page.locator('#notice[role=alert]').filter({ hasText: 'never holds the secret' }).waitFor();
  assert.equal(await fs.readFile(file, 'utf8'), before);

  await page.locator('#personas > summary').click();
  await page.locator('#personas summary').filter({ hasText: 'persona contexts and local sign-in' }).click();
  const personas = page.locator('form[data-form=personas][data-site=invented]');
  await personas.locator('[name=maxInstances]').fill('2');
  await saved(page, () => personas.getByRole('button', { name: 'Save personas' }).click());
  assert.deepEqual((await read()).sites.invented.mirage.personaContexts, { maxInstances: 2 });
  assert.equal((await read()).sites.invented.mirage.identityProvider, undefined, 'untouched fields stay absent');

  // Secret-bearing keys of the setting editor carry the references-only note.
  await page.locator('#providers > summary').click();
  await page.locator('#providers summary').filter({ hasText: 'Setting editor' }).click();
  const secrets = page.locator('#providers tr').filter({ has: page.locator('form[data-key=secrets]') });
  assert.match(await secrets.innerText(), /references only/);
  assert.deepEqual(errors, []);
});

test('setting rows show current values, references only for secrets, and Settings reflect the file', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-setup-values-'));
  const file = path.join(directory, 'paqvilo.config.yml'), projectFile = path.join(directory, 'alpha.project.yml');
  const secrets = { 'invented-vault/api-key': { source: 'environment', variable: 'INVENTED_PRIVATE_VARIABLE' } };
  await fs.writeFile(projectFile, 'version: 2\nportals: []\n');
  await fs.writeFile(file, YAML.stringify({ sourceRoot: '.', defaultSite: 'invented', includeCaution: true, sourceMaps: true, editor: 'code', defaults: { mirage: { simulation: { level: 'dry-run' } } },
    sites: { invented: { webFiles: { enabled: true }, mirage: { port: 0, runtime: { kind: 'dataverse-api' }, dataverse: { enabled: true }, secrets, project: './alpha.project.yml' } } } }));
  const server = await startSetupServer({ directory, processEnv: {} });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  ownedFixture(t).add(async () => { await browser.close(); });
  ownedFixture(t).add(async () => { await server.close(); });
  ownedFixture(t).remove(async () => { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url + '#settings');
  assert.equal(await page.locator('#settings-include-caution').isChecked(), true, 'includeCaution reflects the file');
  await page.locator('#settings summary').filter({ hasText: 'Browser profile' }).click();
  assert.equal(await page.locator('#settings-source-maps').isChecked(), true);
  assert.equal(await page.locator('#settings-editor').inputValue(), 'code');
  const before = await fs.readFile(file, 'utf8');
  await page.locator('form[data-form=settings]').getByRole('button', { name: 'Save defaults' }).click();
  await page.locator('#notice').filter({ hasText: 'Nothing to save' }).waitFor();
  assert.equal(await fs.readFile(file, 'utf8'), before, 'an unchanged Settings form writes nothing');

  // A mapping row shows its current value; submitting it unchanged writes nothing.
  await page.locator('#runtime-configuration > summary').click();
  await page.locator('#runtime-configuration summary').filter({ hasText: 'Setting editor · Runtime surface' }).click();
  const defaults = page.locator('form[data-form=setting][data-key=defaults]');
  assert.deepEqual(JSON.parse(await defaults.locator('[name=value]').inputValue()), { mirage: { simulation: { level: 'dry-run' } } });
  await defaults.getByRole('button', { name: 'Save setting defaults' }).click();
  await page.locator('#notice').filter({ hasText: 'Nothing to save: defaults is unchanged' }).waitFor();
  assert.equal(await fs.readFile(file, 'utf8'), before);

  // Secret references are names and kinds only; the verbatim YAML editor is the one place showing the document.
  await page.locator('#providers > summary').click();
  await page.locator('#providers summary').filter({ hasText: 'Setting editor' }).click();
  const row = page.locator('#providers tr').filter({ hasText: 'invented-vault/api-key' });
  assert.match(await row.innerText(), /invented-vault\/api-key · environment variable[\s\S]*references only/i);
  assert.equal(await page.locator('form[data-key=secrets][data-site=invented]').count(), 0, 'no replace or delete control for references');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#content *:not(textarea)')].some(node => [...node.childNodes].some(child => child.nodeType === 3 && child.textContent.includes('INVENTED_PRIVATE_VARIABLE')))), false);

  // A linked-project finding opens that document in Configuration & rules.
  await page.locator('#overview .findings li').filter({ hasText: 'portal source is required' }).getByRole('link', { name: 'Review' }).click();
  assert.equal(await page.locator('#advanced').evaluate(node => node.open), true);
  assert.equal(await page.locator('#yaml-layer').inputValue(), 'project:invented');
  assert.match(await page.locator('#advanced textarea.yaml').inputValue(), /portals: \[\]/);
  assert.deepEqual(errors, []);
});
