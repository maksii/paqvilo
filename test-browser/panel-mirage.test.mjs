// The dev panel in Mirage mode against a disposable loopback Mirage with a synthetic
// portal export and Solution root. No portal environment is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { OverlaySession } from '../lense/session.mjs';
import { attachSession } from '../lense/browser.mjs';
import { enablePanel } from '../lense/panel.mjs';
import { SITE } from '../test/fixture.mjs';
import { createSimulator } from '../mirage/server.mjs';

const PORTAL = {
  'website.yml': 'adx_websiteid: site\nadx_name: Panel fixture\nadx_headerwebtemplateid: header',
  'webrole.yml': '- adx_webroleid: member\n  adx_name: Member',
  'webpagerule.yml': '- adx_webpageaccesscontrolruleid: members-only\n  adx_name: Members only\n  adx_webpageid: secure\n  adx_right: 2\n  adx_scope: 1\n  adx_webpageaccesscontrolrule_webrole:\n  - member',
  'sitesetting.yml': '- adx_sitesettingid: setting-banner\n  adx_name: Feature/Banner\n  adx_value: on\n- adx_sitesettingid: setting-enabled\n  adx_name: Webapi/contact/enabled\n  adx_value: true',
  'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\nadx_entityformid: edit-contact',
  'web-pages/secure/Secure.webpage.yml': 'adx_webpageid: secure\nadx_name: Secure\nadx_partialurl: secure\nadx_parentpageid: home\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
  'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'web-templates/Main.webtemplate.source.html': '<h1 id="who">{{ user.fullname | default: "Anonymous" }}</h1>{% include \'Partial\' %}<p>{{ snippets[\'Greeting\'] }} {{ settings[\'Feature/Banner\'] }}</p>{% fetchxml rows %}<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>{% endfetchxml %}<p id="count">{{ rows.results.entities.size }}</p>',
  'web-templates/Partial.webtemplate.yml': 'adx_webtemplateid: partial\nadx_name: Partial',
  'web-templates/Partial.webtemplate.source.html': '<nav>Partial</nav>',
  'web-templates/Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
  'web-templates/Header.webtemplate.source.html': '<header>Header</header>',
  'content-snippets/Greeting.contentsnippet.yml': 'adx_contentsnippetid: greeting\nadx_name: Greeting',
  'content-snippets/Greeting.contentsnippet.value.html': 'Hello',
  'basic-forms/edit-contact/Edit-Contact.basicform.yml': 'adx_entityformid: edit-contact\nadx_name: Edit contact\nadx_entityname: contact\nadx_formname: Portal edit\nadx_mode: 100000001',
};
const SOLUTION = {
  'Entities/contact/Entity.xml': '<Entity>\n  <Name LocalizedName="Contact">contact</Name>\n  <EntityInfo>\n    <entity Name="contact">\n      <LocalizedNames>\n        <LocalizedName description="Contact" languagecode="1033" />\n      </LocalizedNames>\n      <attributes>\n        <attribute PhysicalName="FullName">\n          <Type>nvarchar</Type>\n          <Name>fullname</Name>\n          <LogicalName>fullname</LogicalName>\n          <RequiredLevel>required</RequiredLevel>\n          <MaxLength>160</MaxLength>\n          <displaynames>\n            <displayname description="Full name" languagecode="1033" />\n          </displaynames>\n        </attribute>\n      </attributes>\n    </entity>\n  </EntityInfo>\n</Entity>\n',
  'Entities/contact/FormXml/main/{edit-form}.xml': '<forms><systemform><formid>{edit-form}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="tab_1"><labels><label description="General" languagecode="1033"/></labels><columns><column width="100%"><sections><section name="general"><rows><row><cell><labels><label description="Name" languagecode="1033"/></labels><control id="fullname" datafieldname="fullname"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal edit" languagecode="1033"/></LocalizedNames></systemform></forms>',
};
const write = (root, files) => {
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

test('Mirage panel inspects permissions, templates, forms and Solution sources, signs this browser in and out, and switches permissions and scenario', { timeout: 180_000 }, async (t) => {
  // Native real paths (no 8.3 short names) are what the Mirage reports and the panel opens.
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-panel-mirage-')));
  const portalDir = path.join(work, 'portal');
  const solutionDir = path.join(work, 'solution');
  write(portalDir, PORTAL);
  write(solutionDir, SOLUTION);
  const app = await createSimulator({
    sourceDir: portalDir, stateFile: path.join(work, 'state', 'state.json'), watch: false, solutionRoots: [solutionDir],
    initial: {
      version: 1,
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
      tables: { contact: [{ contactid: 'alex', fullname: 'Alex Local' }] },
      permissions: [{ id: 'members-read', name: 'Members read contacts', entity: 'contact', roles: ['Member'], operations: ['read'], scope: 'global' }],
      plugins: [], presets: {}, settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', identity: { roles: [] }, contactRoles: [{ contactId: 'alex', roleId: 'member' }], live: {}, endpoints: [], scenarios: [{ id: 'anonymous-enforced', name: 'Anonymous and enforced', persona: null, permissionMode: 'enforce' }] },
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
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
  context.setDefaultTimeout(12_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: app.url });
  await context.route('**/*', async (route) => new URL(route.request().url()).origin === app.url ? route.fallback() : route.abort());
  const session = new OverlaySession({
    sourceDir: portalDir, origin: app.url, site: structuredClone(SITE), sourceMaps: false, siteName: 'fixture Mirage', envName: 'local', stateDir: work, browser: {},
    mirage: true, mirageSourceRoots: [portalDir, solutionDir],
  });
  detach = await attachSession(context, session);
  const opened = [];
  panel = enablePanel(context, session, { open: async (...args) => { opened.push(args); return null; } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const panelLocator = (selector) => page.locator(`#paqvilo-panel ${selector}`);
  // Optional review screenshots (PAQVILO_EVIDENCE_DIR); synthetic fixture data only.
  const evidence = async (name) => {
    if (!process.env.PAQVILO_EVIDENCE_DIR) return;
    fs.mkdirSync(process.env.PAQVILO_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: path.join(process.env.PAQVILO_EVIDENCE_DIR, `${name}.png`) });
  };
  const openTab = async (tab) => {
    await panelLocator('.pill').waitFor({ state: 'attached' });
    if (await panelLocator('.pill').isVisible()) await panelLocator('.pill').click();
    await panelLocator(`.tabs [data-act="tab"][data-v="${tab}"]`).click();
  };

  // A public page: anonymous access, its template chain, the Solution form and column sources.
  await page.goto(`${app.url}/`);
  await openTab('runtime');
  await panelLocator('.card').filter({ hasText: 'Current persona' }).getByText('allowed', { exact: true }).waitFor();
  await panelLocator('[data-group="runtime-chain"] .row').first().waitFor();
  const chain = await panelLocator('[data-group="runtime-chain"] .row .name > span:first-child').allInnerTexts();
  assert.deepEqual(chain.slice(0, 4), ['Main', 'Main', 'Partial', 'Greeting']);
  assert.ok(chain.includes('Website header') && chain.includes('Header'));
  const table = panelLocator('[data-group="runtime-tables"] .row').filter({ hasText: 'contact (Contact)' });
  await table.getByText('R×', { exact: true }).waitFor();
  assert.match(await table.locator('.sub').innerText(), /entity set contacts/);
  await panelLocator('[data-group="runtime-forms"] .row').filter({ hasText: 'Edit contact' }).getByText('basic form · edit · table contact', { exact: false }).waitFor();
  await evidence('panel-inspect-public-page');
  await panelLocator('[data-group="runtime-forms"] .row').filter({ hasText: 'Solution FormXml' }).locator('button.main').click();
  await settle();
  assert.equal(opened.at(-1)[1], path.join(solutionDir, 'Entities', 'contact', 'FormXml', 'main', '{edit-form}.xml'), 'a Solution FormXml opens through the panel');
  await panelLocator('[data-group="runtime-columns"] .row').filter({ hasText: 'contact.fullname' }).locator('button.main').click();
  await settle();
  assert.deepEqual(opened.at(-1).slice(1, 3), [path.join(solutionDir, 'Entities', 'contact', 'Entity.xml'), 12], 'a column opens at its Entity.xml attribute');
  await panelLocator('[data-group="runtime-settings"] .row').filter({ hasText: 'Feature/Banner' }).locator('button.main').click();
  await settle();
  assert.deepEqual(opened.at(-1).slice(1, 3), [path.join(portalDir, 'sitesetting.yml'), 1], 'a setting opens at its record in the shared YAML file');

  // Tweaks: this browser starts anonymous. Signing in as the member persona runs the portal's
  // sign-in in this page (the local sign-in page: this fixture has no external provider), which
  // sets the session cookie in this page's browser context and comes back as that contact.
  await openTab('tweaks');
  const sessionCard = panelLocator('.card').filter({ hasText: 'Browser session' });
  await sessionCard.getByText('Anonymous', { exact: true }).waitFor();
  // Local pages are not confined to loopback by default; the status card says so.
  await panelLocator('[data-policy="open"]').getByText('Not confined: pages carry only the headers their site settings define', { exact: true }).waitFor();
  const cookiesBefore = await context.cookies(app.url);
  await panelLocator('select[data-pick="persona"]').selectOption('alex');
  await panelLocator('[data-act="signin"]').getByText('Sign in as Alex Local', { exact: true }).waitFor();
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panelLocator('[data-act="signin"]').click()]);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();
  const sessionCookies = (await context.cookies(app.url)).filter((cookie) => !cookiesBefore.some((old) => old.name === cookie.name && old.value === cookie.value));
  assert.ok(sessionCookies.some((cookie) => cookie.httpOnly), 'an HttpOnly session cookie now lives in this page\'s browser context');
  assert.equal(app.state().config.identity.contactId ?? null, null, 'the Mirage default persona is unchanged');
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await other.goto(`${app.url}/`);
  assert.equal(await other.locator('#who').innerText(), 'Anonymous', 'another browser keeps its own (anonymous) session');
  await otherContext.close();
  await openTab('tweaks');
  await sessionCard.getByText('Alex Local', { exact: true }).waitFor();

  // The restricted page is now allowed; its rule is shown as applying to this persona.
  await page.goto(`${app.url}/secure/`);
  await openTab('runtime');
  await panelLocator('.card').filter({ hasText: 'Current persona' }).getByText('allowed', { exact: true }).waitFor();
  await panelLocator('.card').filter({ hasText: 'Local Mirage' }).getByText('Signed in as Alex Local', { exact: false }).waitFor();
  const rule = panelLocator('[data-group="runtime-access"] .row').filter({ hasText: 'Members only' });
  await rule.getByText('Restrict read · All content · Member', { exact: false }).waitFor();
  await rule.getByText('current persona', { exact: true }).waitFor();
  await evidence('panel-inspect-member-page');
  await panelLocator('[data-group="runtime-tables"] .row').filter({ hasText: 'contact (Contact)' }).getByText('R', { exact: true }).waitFor();
  await panelLocator('[data-act="copypage"]').first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${app.url}/secure/`);

  // _sim deep link: requests for this page open in the admin, which the panel leaves alone.
  const adminOpened = context.waitForEvent('page');
  await panelLocator('[data-act="sim"][data-hash^="audit?path="]').first().click();
  const admin = await adminOpened;
  await admin.getByRole('heading', { name: 'Request audit', exact: true }).waitFor();
  assert.equal(await admin.getByLabel('Filter audit by path', { exact: true }).inputValue(), '/secure/');
  await admin.waitForFunction(() => document.querySelector('tbody')?.textContent.includes('/secure/'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await admin.locator('#paqvilo-panel').count(), 0);
  await admin.close();

  // Permission enforcement and a saved scenario (after confirmation) apply through the Mirage.
  await openTab('tweaks');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panelLocator('[data-act="permissions"][data-v="permissive"]').click()]);
  assert.equal(app.state().config.permissionMode, 'permissive');
  await openTab('tweaks');
  await panelLocator('[data-act="ask"][data-kind="scenario"]').click();
  await panelLocator('.banner').getByText('Apply scenario "Anonymous and enforced"', { exact: false }).waitFor();
  await evidence('panel-tweaks-confirmation');
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), panelLocator('[data-act="confirm-yes"]').click()]);
  assert.equal(app.state().config.permissionMode, 'enforce');
  assert.equal(app.state().config.activeScenario.id, 'anonymous-enforced');
  // The scenario's anonymous persona also signed this browser out: the members page now
  // sends it to the local sign-in page.
  await page.waitForURL((url) => /\/signin$/i.test(url.pathname) && url.searchParams.get('ReturnUrl') === '/secure/');
  assert.equal((await (await context.request.get(`${app.url}/_sim/api/session`)).json()).signedIn, false);

  // On the local sign-in page, signing in continues to its ReturnUrl; signing out returns to anonymous.
  await page.goto(`${app.url}/secure/`);
  await page.waitForURL((url) => /\/signin$/i.test(url.pathname) && url.searchParams.get('ReturnUrl') === '/secure/');
  await openTab('tweaks');
  await panelLocator('select[data-pick="persona"]').selectOption('alex');
  await Promise.all([page.waitForURL((url) => url.pathname === '/secure/'), panelLocator('[data-act="signin"]').click()]);
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();
  await openTab('tweaks');
  await Promise.all([page.waitForURL((url) => /\/signin$/i.test(url.pathname)), panelLocator('[data-act="signout"]').click()]);
  await openTab('tweaks');
  await panelLocator('.card').filter({ hasText: 'Browser session' }).getByText('Anonymous', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('Mirage panel signs this browser in and out through the site\'s identity provider', { timeout: 120_000 }, async (t) => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-panel-idp-')));
  const portalDir = path.join(work, 'portal');
  // The site settings of a portal with OpenID Connect sign-in (synthetic provider values).
  const providerSettings = [
    ['idp-enabled', 'Authentication/Registration/ExternalLoginEnabled', 'true'],
    ['idp-authority', 'Authentication/OpenIdConnect/Local/Authority', 'https://idp.example.test/local/'],
    ['idp-client', 'Authentication/OpenIdConnect/Local/ClientId', 'local-client'],
    ['idp-caption', 'Authentication/OpenIdConnect/Local/Caption', 'Local IdP'],
    ['idp-logout', 'Authentication/OpenIdConnect/Local/ExternalLogoutEnabled', 'true'],
  ].map(([id, name, value]) => `- adx_sitesettingid: ${id}\n  adx_name: ${name}\n  adx_value: ${value}`).join('\n');
  write(portalDir, { ...PORTAL, 'sitesetting.yml': `${PORTAL['sitesetting.yml']}\n${providerSettings}` });
  const app = await createSimulator({
    sourceDir: portalDir, stateFile: path.join(work, 'state', 'state.json'), watch: false,
    initial: {
      version: 1,
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' } },
      tables: { contact: [{ contactid: 'alex', fullname: 'Alex Local' }] },
      permissions: [], plugins: [], presets: {}, settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', identity: { roles: [] }, contactRoles: [{ contactId: 'alex', roleId: 'member' }], live: {}, endpoints: [] },
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
  const idp = (await (await fetch(`${app.url}/_sim/api/session`)).json()).identityProvider;
  assert.equal(idp.available, true, idp.reason);
  const provider = idp.providers.find((item) => item.default) ?? idp.providers[0];
  const channel = process.env.PAQVILO_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chromium');
  browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1400, height: 1000 } });
  context.setDefaultTimeout(15_000);
  // Only the Mirage and its local identity provider (both on loopback) are reachable.
  await context.route('**/*', async (route) => [app.url, idp.origin].includes(new URL(route.request().url()).origin) ? route.fallback() : route.abort());
  const session = new OverlaySession({
    sourceDir: portalDir, origin: app.url, site: structuredClone(SITE), sourceMaps: false, siteName: 'fixture Mirage', envName: 'local', stateDir: work, browser: {},
    mirage: true, mirageSourceRoots: [portalDir],
  });
  detach = await attachSession(context, session);
  panel = enablePanel(context, session, { open: async () => null });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Every document request of the page, redirects included (the end-session hop is a redirect).
  const navigations = [];
  page.on('request', (request) => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations.push(request.url()); });
  const viaIdp = (route) => navigations.some((url) => new URL(url).origin === idp.origin && new URL(url).pathname.endsWith(route));
  const panelLocator = (selector) => page.locator(`#paqvilo-panel ${selector}`);
  const openTab = async (tab) => {
    await panelLocator('.pill').waitFor({ state: 'attached' });
    if (await panelLocator('.pill').isVisible()) await panelLocator('.pill').click();
    await panelLocator(`.tabs [data-act="tab"][data-v="${tab}"]`).click();
  };
  const browserSession = async () => (await (await context.request.get(`${app.url}/_sim/api/session`)).json());

  // The session card shows how the portal signs in: the provider, its callback and the local
  // identity provider's port.
  await page.goto(`${app.url}/`);
  await openTab('tweaks');
  const card = panelLocator('.card').filter({ hasText: 'Browser session' });
  await card.locator('[data-idp="external"]').getByText(`Signs in through ${provider.caption}${provider.type ? ` (${provider.type})` : ''} · callback ${provider.callbackPath} · local identity provider on port ${idp.port}`, { exact: true }).waitFor();

  // Sign in as: ExternalLogin with a login_hint, the local identity provider, its form_post to
  // the callback, then back to this page.
  await panelLocator('select[data-pick="persona"]').selectOption('alex');
  navigations.length = 0;
  await panelLocator('[data-act="signin"]').click();
  await page.locator('#who').getByText('Alex Local', { exact: true }).waitFor();
  assert.ok(viaIdp('/oauth2/authorize'), `the sign-in went through the local identity provider: ${navigations.join(' → ')}`);
  assert.equal(new URL(page.url()).pathname, '/');
  const signed = await browserSession();
  assert.deepEqual([signed.signedIn, signed.contactId], [true, 'alex']);
  assert.equal(app.state().config.identity.contactId ?? null, null, 'the Mirage default persona is unchanged');

  // A simulation override (set in _sim on top of the real sign-in) shows in the session card.
  const csrf = (await (await context.request.get(`${app.url}/_sim/api/status`)).json()).csrf;
  const override = await context.request.post(`${app.url}/_sim/api/session/roles`, { headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf }, data: JSON.stringify({ roles: ['Member'] }) });
  assert.equal(override.status(), 200, await override.text());
  await page.reload();
  await openTab('tweaks');
  await card.getByText('Simulation override', { exact: true }).waitFor();

  // Sign out: the portal's LogOff, the provider's end-session, then back to this page.
  navigations.length = 0;
  await panelLocator('[data-act="signout"]').click();
  await page.locator('#who').getByText('Anonymous', { exact: true }).waitFor();
  assert.ok(viaIdp('/oauth2/logout'), `the sign-out went through the provider's end-session: ${navigations.join(' → ')}`);
  assert.equal((await browserSession()).signedIn, false);
  assert.deepEqual(errors, []);
});
