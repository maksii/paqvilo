// The dev panel in Mirage mode on an enhanced-data-model export (powerpagecomponents,
// test-browser/fixtures/enhanced). Synthetic data on a disposable loopback Mirage only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { createSimulator } from '../mirage/server.mjs';

const FIXTURE = fs.realpathSync.native(fileURLToPath(new URL('./fixtures/enhanced/', import.meta.url)));
const component = (id) => path.join(FIXTURE, 'powerpagecomponents', id, 'powerpagecomponent.xml');
const ID = {
  member: 'e1000000-0000-4000-8000-000000000111',
  partial: 'e1000000-0000-4000-8000-000000000082',
  greeting: 'e1000000-0000-4000-8000-000000000071',
  secure: 'e1000000-0000-4000-8000-000000000023',
  membersOnly: 'e1000000-0000-4000-8000-000000000201',
  secureLink: 'e1000000-0000-4000-8000-000000000051',
};
const lineOf = (file, text) => fs.readFileSync(file, 'utf8').split(/\r?\n/).findIndex((line) => line.includes(text)) + 1;

test('Mirage panel inspects an enhanced-data-model export and opens its component XML at the field', { timeout: 180_000 }, async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-panel-enhanced-')));
  const app = await createSimulator({
    sourceDir: FIXTURE,
    stateFile: path.join(work, 'state', 'state.json'),
    watch: false,
    initial: {
      version: 1,
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
      tables: { contact: [{ contactid: 'alex', firstname: 'Alex', lastname: 'Local', fullname: 'Alex Local' }] },
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'exported', identity: { roles: [] }, contactRoles: [{ contactId: 'alex', roleId: ID.member }], live: {}, endpoints: [] },
    },
  });
  let browser, panel, detach;
  t.after(async () => {
    await panel?.dispose();
    await detach?.();
    await browser?.close();
    await app.close();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  assert.equal(app.portal.format, 'enhanced');
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
  context.setDefaultTimeout(15_000);
  await context.route('**/*', async (route) => new URL(route.request().url()).origin === app.url ? route.fallback() : route.abort());
  const session = new OverlaySession({
    sourceDir: FIXTURE, origin: app.url, site: structuredClone(SITE), sourceMaps: false, siteName: 'enhanced Mirage', envName: 'local', stateDir: work, browser: {},
    mirage: true, mirageSourceRoots: [FIXTURE],
  });
  detach = await attachSession(context, session);
  const opened = [];
  panel = enablePanel(context, session, { open: async (...args) => { opened.push(args); return null; } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panelLocator = (selector) => page.locator(`#paqvilo-panel ${selector}`);
  const openTab = async (tab) => {
    await panelLocator('.pill').waitFor({ state: 'attached' });
    if (await panelLocator('.pill').isVisible()) await panelLocator('.pill').click();
    await panelLocator(`.tabs [data-act="tab"][data-v="${tab}"]`).click();
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
  const evidence = async (name) => {
    if (!process.env.PAQVILO_EVIDENCE_DIR) return;
    fs.mkdirSync(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, `${name}.png`) });
  };

  // The home page renders from components; Inspect shows its chain, values and table.
  await page.goto(`${app.url}/`);
  await page.locator('#greeting').getByText('Hello from the enhanced model', { exact: true }).waitFor();
  await openTab('runtime');
  await panelLocator('.card').filter({ hasText: 'Current persona' }).getByText('allowed', { exact: true }).waitFor();
  await panelLocator('[data-group="runtime-chain"] .row').first().waitFor();
  const chain = await panelLocator('[data-group="runtime-chain"] .row .name > span:first-child').allInnerTexts();
  assert.deepEqual(chain.slice(0, 4), ['Main', 'Main', 'Partial', 'Greeting']);
  await panelLocator('[data-group="runtime-snippets"] .row').filter({ hasText: 'Greeting' }).getByText('“Hello from the enhanced model”', { exact: true }).waitFor();
  await panelLocator('[data-group="runtime-settings"] .row').filter({ hasText: 'Feature/Banner' }).getByText('= on', { exact: true }).waitFor();
  await panelLocator('[data-group="runtime-tables"] .row').filter({ hasText: 'contact' }).first().waitFor();
  await evidence('panel-inspect-enhanced-home');

  // Sources are the component XML files, opened at the JSON field the row describes.
  await panelLocator('[data-group="runtime-chain"] .row').filter({ hasText: 'Partial' }).locator('button.main').click();
  await settle();
  assert.deepEqual(opened.at(-1).slice(1, 3), [component(ID.partial), lineOf(component(ID.partial), '"source":')]);
  await panelLocator('[data-group="runtime-snippets"] .row').filter({ hasText: 'Greeting' }).locator('button.main').click();
  await settle();
  assert.deepEqual(opened.at(-1).slice(1, 3), [component(ID.greeting), lineOf(component(ID.greeting), '"value":')]);

  // Signed in as the member, the restricted page is allowed by its enhanced access rule, and
  // its related web link and site marker (mspp_ field names) are listed with their sources.
  await openTab('tweaks');
  await panelLocator('select[data-pick="persona"]').selectOption('alex');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panelLocator('[data-act="signin"]').click()]);
  await page.goto(`${app.url}/secure/`);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();
  await openTab('runtime');
  await panelLocator('.card').filter({ hasText: 'Current persona' }).getByText('allowed', { exact: true }).waitFor();
  const rule = panelLocator('[data-group="runtime-access"] .row').filter({ hasText: 'Members only' });
  await rule.getByText('current persona', { exact: true }).waitFor();
  await rule.locator('button.main').click();
  await settle();
  assert.equal(opened.at(-1)[1], component(ID.membersOnly));
  const related = panelLocator('[data-group="runtime-related"]');
  await related.getByText('Secure link', { exact: true }).waitFor();
  await related.getByText('Secure area', { exact: true }).waitFor();
  await related.locator('.row').filter({ hasText: 'Secure link' }).locator('button.main').click();
  await settle();
  assert.equal(opened.at(-1)[1], component(ID.secureLink));
  await evidence('panel-inspect-enhanced-secure');
  assert.deepEqual(errors, []);
});
