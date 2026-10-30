import { makeTemporaryDirectory, ownedFixture } from '../mirage/testing/owned-fixture.mjs';

import test, { before, after } from 'node:test';
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

// These cases exercise the All settings view of /_setup/ (Quick setup is the default for a new browser).
const allSettings = (page) =>
  page.context().addInitScript(() => {
    try {
      localStorage.setItem('paqvilo-setup-view', 'all');
    } catch {
      /* no storage */
    }
  });

const root = fileURLToPath(new URL('../', import.meta.url));
let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('All settings saves Mirage sourceMaps at site and project scope independently of Lense source maps', async (t) => {
  for (const kind of ['catalogue', 'project'])
    await t.test(kind, async (t) => {
      const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-source-maps-'));
      const file = path.join(directory, kind === 'catalogue' ? 'paqvilo.config.yml' : 'mirage.project.yml');
      await fs.writeFile(
        file,
        YAML.stringify(
          kind === 'catalogue'
            ? {
                sourceMaps: true,
                sites: { invented: { mirage: { runtime: { kind: 'model-driven' }, sourceMaps: false } } },
              }
            : {
                version: 2,
                runtime: { kind: 'model-driven' },
                solutions: [],
                sourceMaps: false,
              },
        ),
      );
      const owner = ownedFixture(t);
      owner.remove(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
      const server = await startSetupServer({
        directory,
        ...(kind === 'project' ? { project: file } : {}),
        processEnv: {},
      });
      owner.add(() => server.close());
      const context = await browser.newContext();
      owner.add(() => context.close());
      const page = await context.newPage();
      await allSettings(page);
      await page.goto(server.url + '#settings');
      const form = page.locator('form[data-form=setting][data-key=sourceMaps]');
      await form.waitFor({ state: 'attached' });
      assert.equal(await form.count(), 1, 'the Mirage scope has one generic editor');
      assert.equal(await form.locator('[name=value]').inputValue(), 'false');
      assert.equal(await page.locator('#settings-source-maps').count(), kind === 'catalogue' ? 1 : 0);
      if (kind === 'catalogue') assert.equal(await page.locator('#settings-source-maps').isChecked(), true);
      await page.locator('#settings summary').filter({ hasText: 'More settings' }).click();
      await form.locator('[name=value]').selectOption('true');
      const saved = page.waitForResponse(
        (response) => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST',
      );
      await form.getByRole('button', { name: 'Save setting sourceMaps', exact: true }).click();
      const response = await saved;
      assert.equal(response.ok(), true, await response.text());
      const request = response.request().postDataJSON();
      assert.deepEqual(request.operations, [
        {
          op: 'set',
          path: kind === 'catalogue' ? ['sites', 'invented', 'mirage', 'sourceMaps'] : ['sourceMaps'],
          value: true,
        },
      ]);
      await page
        .locator('#notice')
        .filter({ hasText: /^Saved\./ })
        .waitFor();
      const document = YAML.parse(await fs.readFile(file, 'utf8'));
      assert.equal(kind === 'catalogue' ? document.sites.invented.mirage.sourceMaps : document.sourceMaps, true);
      if (kind === 'catalogue') assert.equal(document.sourceMaps, true, 'the root Lense policy is unchanged');
      await page.reload();
      assert.equal(
        await form.locator('[name=value]').inputValue(),
        'true',
        'the saved Mirage setting survives a fresh page load',
      );
    });
});

// One loopback origin serving /_setup/ (mounted as Mirage mounts it) and stub /_sim/ answers, so the page runs in live mode.
async function journeyServer(directory) {
  const fake = { live: false, requests: 0, preflight: [] };
  const handler = await createSetupHandler({
    directory,
    processEnv: {},
    runtime: { product: 'Mirage', sourceDir: path.join(directory, 'portal-export') },
  });
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    handler(req, res)
      .then((handled) => {
        if (handled) return;
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname === '/_sim/api/status')
          return json(res, 200, {
            presets: [{ id: 'invented-starter', name: 'Invented starter' }],
            modelDrivenApps: [
              { id: '00000000-0000-4000-8000-0000000000aa', uniqueName: 'x_invented', name: 'Invented app' },
            ],
          });
        if (url.pathname === '/_sim/api/packs')
          return json(res, 200, {
            packs: [
              {
                id: 'invented',
                matched: true,
                diagnostics: [],
                personaCatalog: { groups: 1, personas: 2, contexts: 0, scenarios: 1 },
              },
            ],
            failed: [],
            library: [],
          });
        if (url.pathname === '/_sim/api/preflight') {
          fake.preflight.push(url.search);
          return json(res, 200, {
            kind: 'paqvilo.mirage.preflight',
            summary: { total: 1, satisfied: 0, blocking: 1 },
            requirements: [
              {
                id: 'table:x_item',
                kind: 'table',
                status: 'missing',
                blocking: true,
                message: 'Invented requirement is not satisfied.',
              },
            ],
          });
        }
        if (url.pathname === '/_sim/api/dashboard') {
          if (!fake.live) return json(res, 503, { error: { message: 'Not started.' } });
          fake.requests++;
          return json(res, 200, {
            generatedAt: new Date().toISOString(),
            runtime: {
              product: 'Mirage',
              kind: 'power-pages',
              simulationLevel: 'simulation',
              clock: 'system',
              revision: 1,
              localOrigin: 'http://127.0.0.1',
            },
            nodes: [
              { id: 'client:browser', kind: 'client', label: 'Browser', status: 'ready' },
              {
                id: 'host:portal',
                kind: 'host',
                label: 'Invented portal',
                status: 'listening',
                detail: { port: 8787 },
                link: '#overview',
              },
              { id: 'org:store', kind: 'org', label: 'Data store', status: 'ready' },
            ],
            edges: [
              { from: 'client:browser', to: 'host:portal', kind: 'http', status: 'ready', label: 'HTTP' },
              { from: 'host:portal', to: 'org:store', kind: 'reads', status: 'ready', label: 'Reads' },
            ],
            activity: {
              requests: {
                total: fake.requests,
                recent: [{ at: new Date().toISOString(), method: 'GET', path: '/invented', status: 200, ms: 3 }],
              },
              diagnostics: { total: 0, byCode: {} },
            },
          });
        }
        json(res, 404, { error: { message: 'Unknown fixture route.' } });
      })
      .catch(() => {
        if (!res.headersSent) json(res, 500, { error: { message: 'Fixture failed.' } });
      });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/_setup/`,
    fake,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

async function saved(page, click) {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().endsWith('/_setup/api/config') && response.request().method() === 'POST',
    ),
    click(),
  ]);
  assert.equal(response.ok(), true, await response.text());
  await page
    .locator('#notice')
    .filter({ hasText: /^Saved\./ })
    .waitFor();
}
// One owned context and page on the setup server, with every setting shown and page errors collected.
async function openSetup(t, directory, server, viewport) {
  const context = await browser.newContext();
  ownedFixture(t).add(async () => {
    await context.close();
  });
  ownedFixture(t).add(async () => {
    await server.close();
  });
  ownedFixture(t).remove(async () => {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await allSettings(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { page, errors };
}
const stageLink = (page, name) => page.getByRole('navigation', { name: 'Setup stages' }).getByRole('link', { name });

test(
  'setup journey: template, stage rail, packs, setting editor, restart command and planned-to-live system map',
  { timeout: 120000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-journey-'));
    const server = await journeyServer(directory);
    const { page, errors } = await openSetup(t, directory, server, { width: 1280, height: 900 });
    const file = path.join(directory, 'paqvilo.config.yml'),
      read = async () => YAML.parse(await fs.readFile(file, 'utf8'));

    // Create from a template: the placeholder findings are explained as next steps, not errors.
    await page.goto(server.url);
    await page.locator('details[data-section-key=templates] > summary').click();
    const template = page.locator('form[data-form=template]');
    await template.getByLabel(/Power Pages portal/).check();
    await template.locator('#template-target').fill('invented-portal');
    await saved(page, () => template.getByRole('button', { name: 'Create from example' }).click());
    assert.equal((await read()).sites['invented-portal'].environments.dev, 'https://invented-portal.example.test');
    const overview = page.locator('#overview');
    assert.match(await overview.innerText(), /They are not errors/);
    assert.ok(
      (await overview
        .locator('.findings li')
        .filter({ hasText: 'still has an example address' })
        .filter({ hasText: 'next step' })
        .count()) >= 1,
    );
    assert.match(await stageLink(page, /^Exported files/).innerText(), /next step/);
    assert.match(
      await stageLink(page, /^Live environments/).innerText(),
      /optional/,
      'an example live address only matters to Lense',
    );
    assert.equal(await page.locator('#portals').evaluate((node) => node.open), true, 'the next stage opens');
    assert.equal(await page.locator('#providers').evaluate((node) => node.open), false, 'other stages stay collapsed');

    // Restart command of the running preview, and runtime presets offered as suggestions.
    assert.match(
      await page.locator('#restart-command').innerText(),
      /^npx paqvilo mirage dev --config .*paqvilo\.config\.yml --site invented-portal$/,
    );
    assert.equal(await page.locator('#preset-options option[value="invented-starter"]').count(), 1);
    assert.equal(await page.locator('#app-options option[value="00000000-0000-4000-8000-0000000000aa"]').count(), 1);

    // Live environments and sample data are forms of their own; the rail follows each save.
    await fs.cp(path.join(root, 'examples/project/portal'), path.join(directory, 'portal-export'), { recursive: true });
    await stageLink(page, /^Live environments/).click();
    const environments = page.locator('form[data-form=environments][data-site=invented-portal]');
    await environments.locator('[name=env-url]').fill('http://127.0.0.1:8787');
    await saved(page, () => environments.getByRole('button', { name: 'Save', exact: true }).click());
    await stageLink(page, /^Sample data/).click();
    const data = page.locator('form[data-form=data][data-site=invented-portal]');
    await data.locator('[name=packs]').fill('invented | ./pack/pack.mjs');
    assert.equal(
      await data.locator('select[name=preset] option[value="invented-starter"]').count(),
      1,
      'running preview data sets are offered as a list',
    );
    await saved(page, () => data.getByRole('button', { name: 'Save', exact: true }).click());
    const sitesAfter = (await read()).sites['invented-portal'];
    assert.deepEqual(sitesAfter.mirage.dataPacks, [{ id: 'invented', module: './pack/pack.mjs' }]);
    assert.equal(sitesAfter.environments.dev.url, 'http://127.0.0.1:8787');
    assert.match(await stageLink(page, /^Exported files/).innerText(), /done/);
    assert.match(await stageLink(page, /^Live environments/).innerText(), /done/);
    assert.match(
      await stageLink(page, /^Sample data/).innerText(),
      /next step/,
      'the missing pack module is the next step',
    );
    assert.match(await page.locator('#data-invented-portal').innerText(), /pack\.mjs[\s\S]*file missing/);

    // A service the person runs themselves is a row of a guided form: a name, what it is, its address and a path to check.
    await stageLink(page, /^Outside services/).click();
    const services = page.locator('form[data-form=services][data-site=invented-portal]');
    await services.getByRole('button', { name: 'Add a service' }).click();
    await services.locator('[name=svc-id]').fill('invented-api');
    await services.locator('[name=svc-address]').fill('http://127.0.0.1:7071');
    await services.locator('[name=svc-probe]').fill('/health');
    await saved(page, () => services.getByRole('button', { name: 'Save', exact: true }).click());
    assert.deepEqual((await read()).sites['invented-portal'].mirage.localServices, {
      'invented-api': { kind: 'http', baseUrl: 'http://127.0.0.1:7071', probe: '/health' },
    });
    assert.equal(
      await page.locator('#providers').evaluate((node) => node.open),
      true,
      'the edited section stays open after the save',
    );
    // The other keys of the stage stay in the setting editor; an unset one is empty, its example sits in the (i).
    await page.locator('#providers summary').filter({ hasText: 'More settings · Outside services' }).click();
    assert.equal(
      await page.locator('form[data-form=setting][data-key=localServices]').count(),
      0,
      'local services have a form of their own',
    );
    const unset = page.locator(
      'form[data-form=setting][data-key=connectorScripts][data-site=invented-portal] [name=value]',
    );
    assert.equal(await unset.count(), 1);
    assert.equal(await unset.inputValue(), '');
    assert.match(await unset.getAttribute('placeholder'), /^Not set/);

    // The system map shows the plan from the settings file until a preview runs, then the same live map as the simulator's
    // Infrastructure view, so setup and the simulator never show different states.
    await page
      .getByRole('navigation', { name: 'Setup navigation' })
      .getByRole('link', { name: 'Your system at a glance' })
      .click();
    const system = page.locator('#system');
    await system.locator('.ui-dashboard[data-dashboard-mode=planned]').waitFor();
    assert.ok((await system.locator('[data-node]').count()) > 0);
    server.fake.live = true;
    await system.locator('.ui-dashboard[data-dashboard-mode=live]').waitFor();
    await system.locator('[data-node="host:portal"]').click();
    // The drawer names the product of the clicked node; the node's own label stays a fact.
    await system
      .locator('.ui-drawer[data-node-detail="host:portal"] h3')
      .filter({ hasText: 'Power Pages site' })
      .waitFor();
    const verify = page.locator('#guidance');
    await stageLink(page, /^Start & check/).click();
    assert.match(
      await verify.getByRole('link', { name: /Check what the project needs/ }).getAttribute('href'),
      /\/_sim\/#capabilities$/,
    );
    assert.match(
      await verify.getByRole('link', { name: /Open the live system map/ }).getAttribute('href'),
      /\/_sim\/#health$/,
    );

    // Narrow screens keep every opened section inside the viewport.
    if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
      await fs.mkdir(path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS), { recursive: true });
      await page.screenshot({
        path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-journey-desktop.png'),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    // Every disclosure open, including the setting examples whose rows hold visually hidden labels.
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('details')) node.open = true;
    });
    if (process.env.PAQVILO_SETUP_SCREENSHOTS) {
      await page.screenshot({
        path: path.resolve(process.env.PAQVILO_SETUP_SCREENSHOTS, 'setup-journey-mobile.png'),
        fullPage: true,
      });
    }
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .filter((node) => node.getBoundingClientRect().right > innerWidth + 1)
        .map((node) => `${node.tagName}.${node.className}`)
        .slice(0, 8),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      overflow.join(', '),
    );
    assert.deepEqual(errors, []);
  },
);

test(
  'identity and persona forms write only changed keys and leave declared users and app registrations alone',
  { timeout: 60000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-identity-'));
    const file = path.join(directory, 'paqvilo.config.yml'),
      read = async () => YAML.parse(await fs.readFile(file, 'utf8'));
    const application = {
      appId: '00000000-0000-4000-8000-000000000001',
      displayName: 'Invented client',
      secretEnvironmentVariable: 'INVENTED_CLIENT_SECRET',
    };
    await fs.writeFile(
      file,
      YAML.stringify({
        sourceRoot: '.',
        defaultSite: 'invented',
        sites: {
          invented: {
            source: '.',
            defaultEnv: 'local',
            environments: { local: 'http://127.0.0.1:8787' },
            mirage: {
              port: 0,
              runtime: { kind: 'power-pages' },
              simulation: { level: 'dry-run' },
              dataverse: { enabled: true, port: 0, applications: [application] },
            },
          },
        },
      }),
    );
    const server = await startSetupServer({ directory, processEnv: {} });
    const { page, errors } = await openSetup(t, directory, server);
    await page.goto(server.url + '#identity');
    await page.locator('#identity summary').filter({ hasText: 'secure address and tenant' }).click();
    const identity = page.locator('form[data-form=identity][data-site=invented]');
    // Users and app registrations are managed in the simulator; the form names how many the settings file declares.
    assert.match(await identity.innerText(), /declares 0 users and 1 app registration/);
    await identity.locator('[name=tenantId]').fill('11111111-1111-4111-8111-111111111111');
    await saved(page, () => identity.getByRole('button', { name: 'Save identity & API' }).click());
    const dataverse = (await read()).sites.invented.mirage.dataverse;
    assert.equal(dataverse.tenantId, '11111111-1111-4111-8111-111111111111');
    assert.deepEqual(
      dataverse.applications,
      [application],
      'declared app registrations are never touched by this form',
    );
    assert.match(await page.locator('#identity').innerText(), /Manage Web API users and app registrations/);

    await page.locator('#personas > summary').click();
    // One website: its form is open already.
    {
      const node = page.locator('#personas details[data-section-key="personas-invented"]');
      if ((await node.getAttribute('open')) === null) await node.locator('summary').click();
    }
    const personas = page.locator('form[data-form=personas][data-site=invented]');
    await personas.locator('[name=maxInstances]').fill('2');
    await saved(page, () => personas.getByRole('button', { name: 'Save', exact: true }).click());
    assert.deepEqual((await read()).sites.invented.mirage.personaContexts, { maxInstances: 2 });
    assert.equal((await read()).sites.invented.mirage.identityProvider, undefined, 'untouched fields stay absent');

    // Secret-bearing keys of the setting editor carry the references-only note.
    await page.locator('#providers > summary').click();
    await page.locator('#providers summary').filter({ hasText: 'More settings' }).click();
    const secrets = page.locator('#providers tr').filter({ has: page.locator('form[data-key=secrets]') });
    assert.match(await secrets.innerText(), /references only/);
    assert.deepEqual(errors, []);
  },
);

test(
  'setting rows show current values, references only for secrets, and Settings reflect the file',
  { timeout: 60000 },
  async (t) => {
    const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-values-'));
    const file = path.join(directory, 'paqvilo.config.yml'),
      projectFile = path.join(directory, 'alpha.project.yml');
    const secrets = { 'invented-vault/api-key': { source: 'environment', variable: 'INVENTED_PRIVATE_VARIABLE' } };
    await fs.writeFile(projectFile, 'version: 2\nportals: []\n');
    await fs.writeFile(
      file,
      YAML.stringify({
        sourceRoot: '.',
        defaultSite: 'invented',
        includeCaution: true,
        sourceMaps: true,
        editor: 'code',
        defaults: { mirage: { simulation: { level: 'dry-run' } } },
        sites: {
          invented: {
            webFiles: { enabled: true },
            mirage: {
              port: 0,
              runtime: { kind: 'dataverse-api' },
              dataverse: { enabled: true },
              secrets,
              project: './alpha.project.yml',
            },
          },
        },
      }),
    );
    const server = await startSetupServer({ directory, processEnv: {} });
    const { page, errors } = await openSetup(t, directory, server);
    await page.goto(server.url + '#settings');
    assert.equal(await page.locator('#settings-include-caution').isChecked(), true, 'includeCaution reflects the file');
    await page.locator('#settings summary').filter({ hasText: 'Browser profile' }).click();
    assert.equal(await page.locator('#settings-source-maps').isChecked(), true);
    assert.equal(await page.locator('#settings-editor').inputValue(), 'code');
    const before = await fs.readFile(file, 'utf8');
    await page.locator('form[data-form=settings]').getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#notice').filter({ hasText: 'Nothing to save' }).waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), before, 'an unchanged Settings form writes nothing');

    // A mapping row shows its current value; submitting it unchanged writes nothing.
    await page.locator('#runtime-configuration > summary').click();
    await page.locator('#runtime-configuration summary').filter({ hasText: 'More settings · What to run' }).click();
    const defaults = page.locator('form[data-form=setting][data-key=defaults]');
    // Shown as the YAML it is typed in.
    assert.equal(await defaults.locator('[name=value]').inputValue(), 'mirage:\n  simulation:\n    level: dry-run');
    await defaults.getByRole('button', { name: 'Save setting defaults' }).click();
    await page.locator('#notice').filter({ hasText: 'Nothing to save: defaults is unchanged' }).waitFor();
    assert.equal(await fs.readFile(file, 'utf8'), before);

    // Secret references are names and kinds only; the verbatim YAML editor is the one place showing the document.
    await page.locator('#providers > summary').click();
    await page.locator('#providers summary').filter({ hasText: 'More settings' }).click();
    const row = page.locator('#providers tr').filter({ hasText: 'invented-vault/api-key' });
    assert.match(await row.innerText(), /invented-vault\/api-key · environment variable[\s\S]*references only/i);
    assert.equal(
      await page.locator('form[data-key=secrets][data-site=invented]').count(),
      0,
      'no replace or delete control for references',
    );
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll('#content *:not(textarea)')].some((node) =>
          [...node.childNodes].some(
            (child) => child.nodeType === 3 && child.textContent.includes('INVENTED_PRIVATE_VARIABLE'),
          ),
        ),
      ),
      false,
    );

    // A linked-project finding opens that document in the Settings file section.
    await page
      .locator('#overview .findings li')
      .filter({ hasText: 'portal source is required' })
      .getByRole('link', { name: 'Review' })
      .click();
    assert.equal(await page.locator('#advanced').evaluate((node) => node.open), true);
    assert.equal(await page.locator('#yaml-layer').inputValue(), 'project:invented');
    assert.match(await page.locator('#advanced textarea.yaml').inputValue(), /portals: \[\]/);
    assert.deepEqual(errors, []);
  },
);
