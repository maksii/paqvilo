// @test-kind unproven: local model of the platform shell chrome, anti-forgery holder, Datejs and bundles; no native capture in this file.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { signedInSimulatorPage } from './shared-browser.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const require = createRequire(import.meta.url);
const SITE = '7b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c2d';
const CONTACT = 'c2000000-0000-4000-8000-000000000001';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

test('code component server form preserves hosted nested-form parsing', async (t) => {
  const { page, app } = await portalFixture(t, {
    home: '<div data-pcf-schema="Invented.Component"></div><section><form data-first><input name="subject"></form></section><form data-second><input name="second"></form>',
  });
  await page.goto(app.url + '/');
  assert.equal(await page.locator('form#liquid_form').count(), 1);
  assert.equal(await page.locator('form[data-first]').count(), 0);
  assert.equal(await page.locator('input[name=subject]').count(), 1);
  assert.equal(await page.locator('form[data-second]').count(), 1);
});

// Synthetic portal: header with a dropdown menu, footer followed by an authored cookie
// banner, a plain page and a basic form page.
async function portalFixture(t, { settings = [], home = null, pairedBrowserTokens = false, signIn = true } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'platform-shell-browser-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const jquery = await fs.readFile(
    path.join(path.dirname(require.resolve('jquery/package.json')), 'dist', 'jquery.min.js'),
  );
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Shell\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: plain',
    'Form.webpage.yml':
      'adx_webpageid: form\nadx_name: Form\nadx_partialurl: form\nadx_parentpageid: home\nadx_pagetemplateid: form',
    'Plain.pagetemplate.yml':
      'adx_pagetemplateid: plain\nadx_webtemplateid: plaincontent\nadx_usewebsiteheaderandfooter: true',
    'FormPage.pagetemplate.yml':
      'adx_pagetemplateid: form\nadx_webtemplateid: formcontent\nadx_usewebsiteheaderandfooter: true',
    'Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
    'Header.webtemplate.source.html':
      '<script src="/jquery.min.js"></script><header><ul class="nav"><li class="dropdown"><a href="#" class="dropdown-toggle" data-toggle="dropdown" aria-haspopup="true" title="Services">Services</a><ul class="dropdown-menu"><li><a href="/">Home</a></li></ul></li></ul></header>',
    'Footer.webtemplate.yml': 'adx_webtemplateid: footer\nadx_name: Footer',
    'Footer.webtemplate.source.html':
      '<style>footer.site{position:absolute;top:0;left:0;right:0;height:80px;background:#fff}</style><footer class="site">Footer</footer><div id="cookie-consent-banner">Cookies</div>',
    'PlainContent.webtemplate.yml': 'adx_webtemplateid: plaincontent\nadx_name: Plain content',
    'PlainContent.webtemplate.source.html':
      "<p>Welcome</p><script>window.parseTimeDate = Date.parse('08/10/2026 12:34'); document.addEventListener('DOMContentLoaded', () => { window.parsedDate = Date.parse('08/10/2026 12:34'); }); window.$ = window.jQuery;</script>",
    'FormContent.webtemplate.yml': 'adx_webtemplateid: formcontent\nadx_name: Form content',
    'FormContent.webtemplate.source.html':
      '<div class="page-header"><h1>Contact us</h1></div>{% entityform name: "Contact" %}',
    'Contact.basicform.yml':
      'adx_entityformid: 2d000000-0000-4000-8000-000000000001\nadx_name: Contact\nadx_entityname: contact\nadx_mode: 100000000',
    'jquery.min.js.webfile.yml':
      'adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js',
  };
  if (home) files['PlainContent.webtemplate.source.html'] = home;
  if (pairedBrowserTokens) files['webrole.yml'] = '- adx_webroleid: member\n  adx_name: Member';
  if (settings.length)
    files['sitesetting.yml'] = settings
      .map(
        ([name, value], index) =>
          `- adx_sitesettingid: 5e200000-0000-4000-8000-00000000000${index}\n  adx_name: ${name}\n  adx_value: "${value}"`,
      )
      .join('\n');
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  await fs.writeFile(path.join(dir, 'jquery.min.js'), jquery);
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
    tables: { contact: [{ contactid: CONTACT, fullname: 'Grace' }] },
    permissions: [
      { id: 'contact', entity: 'contact', scope: 'global', roles: ['Member'], operations: ['read', 'create'] },
    ],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: CONTACT, contactId: CONTACT, roles: ['Member'] },
      ...(pairedBrowserTokens ? { contactRoles: [{ contactId: CONTACT, roleId: 'member' }] } : {}),
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Contact: {
          entity: 'contact',
          mode: 100000000,
          fields: [
            { name: 'fullname', label: 'Full name', required: true },
            { name: 'emailaddress1', label: 'Email' },
          ],
        },
      },
    },
  };
  const { app, page, errors } = await signedInSimulatorPage(t, browser, {
    dir,
    initial,
    contact: signIn ? CONTACT : null,
    ...(pairedBrowserTokens ? { identityProvider: { pairedBrowserTokens } } : {}),
  });
  const requests = [];
  page.on('request', (request) => requests.push(`${request.method()} ${request.url().replace(app.url, '')}`));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  return { app, page, errors, requests };
}

const postbackToken = (page) => page.evaluate(() => window.__portalSimulation?.postbackToken);
const isTokenFragment = (request) => /(?:\/_layout\/tokenhtml|\/Layout\/GetAntiForgeryToken)/i.test(request);
const isBindingCookie = (cookie) => cookie.name.includes('-request-binding-');

async function directNativeSubmit(page, name) {
  await page.locator('#fullname').fill(name);
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === 'POST' && new URL(item.url()).pathname === '/form/'),
    page.waitForEvent(
      'framenavigated',
      (frame) => frame === page.mainFrame() && new URL(frame.url()).pathname === '/form/',
    ),
    page.evaluate(() => {
      const form = document.getElementById('liquid_form');
      form.elements.namedItem('__EVENTTARGET').value = form.querySelector('#InsertButton').name;
      HTMLFormElement.prototype.submit.call(form);
    }),
  ]);
  await page.waitForLoadState('domcontentloaded');
  return response;
}

// @test-kind security+contract+observation: the Chromium session binds issued tokens to actual browser navigation and native ViewState; the anti-forgery cookie is Secure, HttpOnly and SameSite=Lax as hosted session F4 set it (paqvilo-developer hosted-f4 swap runs a and b).
test('paired Chromium token survives reload and the first native post follows portal sign-in', async (t) => {
  const { app, page } = await portalFixture(t, { pairedBrowserTokens: true, signIn: false });
  const fragment = (url) => isTokenFragment(url.pathname);
  let fragmentResponses = 0;
  page.on('response', (response) => {
    if (response.ok() && fragment(new URL(response.url()))) fragmentResponses++;
  });
  await page.route(fragment, (route) => route.abort('blockedbyclient'));
  await page.goto(app.url + '/signin?ReturnUrl=%2Fform%2F');
  const anonymous = await postbackToken(page);
  assert.ok(/^[0-9a-f]{64}$/.test(anonymous ?? '') && anonymous !== app.portalToken);
  await Promise.all([
    page.waitForURL(app.url + '/form/'),
    page.locator('button[name="contactId"][value="' + CONTACT + '"]').click(),
  ]);
  const current = await postbackToken(page);
  assert.ok(/^[0-9a-f]{64}$/.test(current ?? '') && current !== anonymous);
  const cookie = (await page.context().cookies(app.url)).find(isBindingCookie);
  assert.ok(cookie?.httpOnly && cookie.sameSite === 'Lax');
  await page.reload();
  assert.ok((await postbackToken(page)) === current);
  assert.equal(fragmentResponses, 0);

  const posted = await directNativeSubmit(page, 'Paired native submit');
  assert.equal(posted.status(), 200);
  const fields = new URLSearchParams(posted.request().postData());
  assert.equal(fields.has('__VIEWSTATE'), true);
  assert.equal(fields.has('__RequestVerificationToken'), false);
  assert.equal(
    app.store.tableRows('contact').some((row) => row.fullname === 'Paired native submit'),
    true,
  );
  assert.equal(fragmentResponses, 0);

  await page.unroute(fragment);
  await page.goto(app.url + '/form/');
  assert.ok((await postbackToken(page)) === current);
  const shell = await page.evaluate(
    () => new Promise((resolve, reject) => window.shell.getTokenDeferred().done(resolve).fail(reject)),
  );
  assert.ok(shell === current);
  assert.ok(fragmentResponses >= 1);
  const nativeCookie = (await page.context().cookies(app.url)).find(
    (item) => item.name === '__RequestVerificationToken',
  );
  assert.ok(nativeCookie?.secure && nativeCookie.httpOnly && nativeCookie.sameSite === 'Lax');
});

async function gateInitialDocuments(t, app) {
  const simulator = new URL(app.url);
  const gate = () => ({ received: Promise.withResolvers(), release: Promise.withResolvers(), seen: false });
  const gates = new Map([
    ['first', gate()],
    ['second', gate()],
  ]);
  let origin;
  // Hold each document response before Chromium processes either Set-Cookie header.
  // Forward Chromium's real Fetch Metadata to the simulator. Map only the two loopback listener origins.
  const proxy = createServer((req, res) => {
    const target = new URL(req.url, simulator);
    if (target.origin !== simulator.origin) return res.writeHead(400).end();
    const selected =
      req.method === 'GET' && target.pathname === '/form/' ? gates.get(target.searchParams.get('launch')) : null;
    const first = selected && !selected.seen;
    if (first) selected.seen = true;
    const headers = { ...req.headers, host: simulator.host };
    if (headers.origin === origin) headers.origin = simulator.origin;
    // The fixture owns the destination. Forward only the parsed origin-form request target.
    const upstream = httpRequest(
      simulator,
      { path: target.pathname + target.search, method: req.method, headers },
      async (reply) => {
        if (first) {
          selected.received.resolve({
            status: reply.statusCode,
            browser: Boolean(req.headers['sec-fetch-site']),
            hadBinding: Boolean(req.headers.cookie?.includes('-request-binding-')),
            hasNewBinding: (reply.headers['set-cookie'] ?? []).some((cookie) => cookie.includes('-request-binding-')),
          });
          await selected.release.promise;
        }
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (first) selected.received.reject(error);
      res.destroy(error);
    });
    req.pipe(upstream);
  });
  ownedFixture(t).add(
    () =>
      new Promise((resolve) => {
        proxy.close(resolve);
        proxy.closeAllConnections();
      }),
  );
  const started = once(proxy, 'listening');
  proxy.listen(0, '127.0.0.1');
  await started;
  origin = 'http://127.0.0.1:' + proxy.address().port;
  return { origin, first: gates.get('first'), second: gates.get('second') };
}

// @test-kind security+contract: simultaneous first documents stay paired to the same signed owner without issuing extra bindings afterward.
test('paired Chromium concurrent first loads keep both native postbacks valid', async (t) => {
  const { app, page } = await portalFixture(t, { pairedBrowserTokens: true, signIn: false });
  const context = page.context();
  const signIn = await context.request.post(app.adminOrigin + '/__sim/api/session/sign-in', {
    headers: { 'x-sim-csrf': app.csrf },
    data: { contactId: CONTACT },
  });
  assert.equal(signIn.status(), 200);
  const other = await context.newPage();
  const { origin, first, second } = await gateInitialDocuments(t, app);
  const confined = (route) =>
    [origin, app.url].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort();
  await page.unroute('**/*');
  await page.route('**/*', confined);
  await other.route('**/*', confined);
  const firstUrl = origin + '/form/?launch=first';
  const secondUrl = origin + '/form/?launch=second';
  const navigations = [page.goto(firstUrl), other.goto(secondUrl)];
  try {
    const responses = await Promise.all([first.received.promise, second.received.promise]);
    assert.deepEqual(responses, Array(2).fill({ status: 200, browser: true, hadBinding: false, hasNewBinding: true }));
    const bindings = async () => (await context.cookies(app.url)).filter(isBindingCookie);
    assert.equal((await bindings()).length, 0, 'both documents begin without a binding cookie');
    first.release.resolve();
    await navigations[0];
    assert.equal((await bindings()).length, 1);
    const firstToken = await postbackToken(page);
    second.release.resolve();
    await navigations[1];
    const current = await postbackToken(other);
    assert.ok(/^[0-9a-f]{64}$/.test(firstToken ?? '') && /^[0-9a-f]{64}$/.test(current ?? ''));
    assert.ok(firstToken !== current);
    assert.equal((await bindings()).length, 2);

    assert.equal((await directNativeSubmit(page, 'Early tab accepted')).status(), 200);
    assert.equal((await directNativeSubmit(other, 'Current tab accepted')).status(), 200);
    const later = await page.goto(firstUrl);
    assert.ok([firstToken, current].includes(await postbackToken(page)));
    assert.equal(
      (await later.headerValues('set-cookie')).some((value) => value.includes('-request-binding-')),
      false,
    );
    assert.equal((await bindings()).length, 2, 'a live binding prevents another issuance');
    const names = app.store.tableRows('contact').map((row) => row.fullname);
    assert.ok(names.includes('Early tab accepted') && names.includes('Current tab accepted'));
  } finally {
    first.release.resolve();
    second.release.resolve();
    await Promise.allSettled(navigations);
  }
});

test('platform chrome, lazy anti-forgery token, app-bundle accessibility and Datejs on a plain page', async (t) => {
  const { app, page, errors, requests } = await portalFixture(t);
  await page.goto(`${app.url}/`);
  // Default shell body order: offline bar (hidden by the platform styles), header, empty
  // anti-forgery holder, content, native-controls root, footer, then the authored banner.
  const order = await page.evaluate(() =>
    [...document.body.children]
      .map((element) => element.id || element.tagName.toLowerCase())
      .filter((name) => !['script', 'style', 'link'].includes(name)),
  );
  assert.deepEqual(order.slice(0, 3), ['offlineNotificationBar', 'header', 'antiforgerytoken']);
  assert.ok(order.indexOf('pp-native-controls-react-root') < order.indexOf('footer'));
  assert.ok(
    order.indexOf('footer') < order.indexOf('cookie-consent-banner'),
    'the footer adapter keeps the footer before the banner',
  );
  assert.equal(await page.locator('#offlineNotificationBar').isVisible(), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('footer.site')).position), 'static');
  assert.equal(await page.locator('#antiforgerytoken input').count(), 0);
  assert.equal(requests.filter((request) => /\.axd|\/_layout\/tokenhtml/.test(request)).length, 0);
  // The first token request fills the holder from its data-url once (cache-busted GET).
  const tokens = await page.evaluate(() =>
    Promise.all([0, 1].map(() => new Promise((resolve) => window.shell.getTokenDeferred().done(resolve)))),
  );
  // The browser's own paired token, the same for both callers and never the tool token.
  assert.equal(tokens[0], tokens[1]);
  assert.ok(tokens[0] && tokens[0] !== app.portalToken);
  assert.equal(
    await page.locator('#antiforgerytoken input[name="__RequestVerificationToken"]').getAttribute('value'),
    tokens[0],
  );
  assert.equal(requests.filter((request) => /^GET \/_layout\/tokenhtml\?_=\d+$/.test(request)).length, 1);
  // app.bundle accessibility block: dropdown toggles.
  const toggle = page.locator('li.dropdown > a.dropdown-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await toggle.getAttribute('aria-haspopup'), null);
  assert.equal(await toggle.getAttribute('aria-label'), 'Services');
  // postpreform equivalent at the platform position (after the footer): content scripts that
  // run while the page parses get the browser's Date.parse, ready handlers get Datejs.
  assert.deepEqual(
    await page.evaluate(() => [
      typeof window.parseTimeDate,
      window.parsedDate instanceof Date,
      window.parsedDate.getMonth(),
      typeof Date.today,
      typeof window.jQuery.blockUI,
    ]),
    ['number', true, 7, 'function', 'function'],
  );
  // The page links the platform bundles, not the local adapters.
  assert.equal(requests.filter((request) => request.includes('/__sim-static/')).length, 0);
  assert.ok(requests.includes('GET /resource/powerappsportal/dist/preform.moment_2_29_4.bundle-750b699ecd.js'));
  assert.ok(requests.includes('GET /resource/powerappsportal/dist/app.bundle-1e948af604.js'));
  await page.evaluate(() => window.jQuery.blockUI({ message: '<p>Working</p>', fadeIn: 0 }));
  assert.equal(await page.locator('body > div.blockUI.blockOverlay').count(), 1);
  assert.equal(await page.locator('body > div.blockUI.blockMsg.blockPage').innerText(), 'Working');
  await page.evaluate(() => window.jQuery.unblockUI({ fadeOut: 0 }));
  assert.equal(await page.locator('body > .blockUI').count(), 0);
  assert.deepEqual(errors, []);
});

test('basic form pages run inside the WebForms form with the platform form scripts', async (t) => {
  const { app, page, errors, requests } = await portalFixture(t);
  await page.goto(`${app.url}/form/?ref=1`);
  const form = page.locator('form#liquid_form');
  assert.equal(await form.getAttribute('action'), '/form/?ref=1');
  assert.equal(await form.getAttribute('onsubmit'), 'javascript:return WebForm_OnSubmit();');
  assert.deepEqual(
    await form.locator('div.aspNetHidden input').evaluateAll((inputs) => inputs.map((input) => input.name)),
    [
      '__EVENTTARGET',
      '__EVENTARGUMENT',
      '__VIEWSTATE',
      '__VIEWSTATEGENERATOR',
      '__VIEWSTATEENCRYPTED',
      '__EVENTVALIDATION',
    ],
  );
  for (const script of [
    '/js/jquery.blockUI.js',
    '/xrm-adx/js/webform.js',
    '/xrm-adx/js/radcaptcha.js',
    '/xrm-adx/js/crmentityformview.js',
  ])
    assert.ok(requests.includes(`GET ${script}`), script);
  assert.deepEqual(
    await page.evaluate(() => [
      typeof theForm,
      typeof window.radcaptcha.onClientLoad,
      typeof WebForm_DoPostBackWithOptions,
      typeof validateRequiredField,
      Array.isArray(document.getElementsByClassName('form-control')),
    ]),
    ['object', 'function', 'function', 'function', true],
  );
  // The platform's word-boundary getElementsByClassName (an Array, so page scripts can call
  // forEach) does not change jQuery class selection.
  const selection = await page.evaluate(() => ({
    method: document.getElementsByClassName('control').length,
    words: document.getElementsByClassName('control').some((element) => element.classList.contains('form-control')),
    native: document.querySelectorAll('.control').length,
    jquery: window.jQuery('.control').length,
    compound: window.jQuery('table .control').length === document.querySelectorAll('table .control').length,
    forEach: (() => {
      let count = 0;
      document.getElementsByClassName('form-control').forEach(() => count++);
      return count;
    })(),
  }));
  assert.ok(selection.words && selection.method > selection.native, JSON.stringify(selection));
  assert.equal(selection.jquery, selection.native);
  assert.equal(selection.compound, true);
  assert.ok(selection.forEach > 0);
  // Heading announcer and form label from the page heading.
  const announcer = page.locator('.page-header > div.sr-only[role="alert"][aria-roledescription="heading"]');
  assert.equal(await announcer.getAttribute('aria-label'), 'Contact us');
  assert.equal(await page.locator('.crmEntityFormView').getAttribute('aria-label'), 'Contact us');
  // A browser submission of the server form is a postback: no POST to the page, the page
  // re-renders at the form action.
  await page.locator('#fullname').fill('Grace Hopper');
  await page.evaluate(() => {
    const extra = document.createElement('input');
    extra.type = 'submit';
    extra.id = 'authored-submit';
    document.querySelector('form#liquid_form').appendChild(extra);
  });
  await Promise.all([page.waitForURL(`${app.url}/form/?ref=1`), page.locator('#authored-submit').click()]);
  assert.equal(requests.filter((request) => request.startsWith('POST /form/')).length, 0);
  assert.deepEqual(errors, []);
});

test('Site/BootstrapV5Enabled pages load the BootstrapV5 bundles, whose local equivalent runs the Bootstrap 5 data API', async (t) => {
  // Bootstrap 5 markup as the Example export uses it: data-bs-toggle, data-bs-target and data-bs-dismiss.
  const home =
    '<style>.modal{display:none}.dropdown-menu{display:none}.dropdown-menu.show{display:block}</style>' +
    '<div class="dropdown"><button type="button" class="dropdown-toggle" id="menu" data-bs-toggle="dropdown">Menu</button><ul class="dropdown-menu" id="menuItems"><li>Item</li></ul></div>' +
    '<button type="button" id="open" data-bs-toggle="modal" data-bs-target="#confirm">Cancel</button>' +
    '<div class="modal fade" id="confirm" tabindex="-1"><div class="modal-dialog"><p>Discard the draft?</p><button type="button" id="dismiss" data-bs-dismiss="modal">No</button></div></div>' +
    '<button type="button" id="collapseToggle" data-bs-toggle="collapse" data-bs-target="#details">Details</button><div id="details" hidden>More</div>';
  const { app, page, errors, requests } = await portalFixture(t, {
    settings: [['Site/BootstrapV5Enabled', 'true']],
    home,
  });
  await page.goto(`${app.url}/`);
  for (const bundle of [
    'preform.BootstrapV5.moment_2_29_4.bundle-e6db58f462.js',
    'bootstrap.BootstrapV5.bundle-be8391e97d.js',
    'postpreform.BootstrapV5.bundle-1e48131190.js',
    'app.BootstrapV5.bundle-4299f393fc.js',
    'font-awesome.BootstrapV5.bundle-2ce6efb497.css',
  ])
    assert.ok(requests.includes(`GET /resource/powerappsportal/dist/${bundle}`), bundle);
  assert.equal(requests.filter((request) => request.includes('/__sim-static/')).length, 0);
  await page.locator('#menu').click();
  assert.equal(await page.locator('#menuItems').isVisible(), true);
  assert.equal(await page.locator('#menu').getAttribute('aria-expanded'), 'true');
  await page.locator('#menu').click();
  assert.equal(await page.locator('#menuItems').isVisible(), false);
  await page.locator('#open').click();
  assert.equal(await page.locator('#confirm').isVisible(), true);
  await page.locator('#dismiss').click();
  assert.equal(await page.locator('#confirm').isVisible(), false);
  await page.locator('#collapseToggle').click();
  assert.equal(await page.locator('#details').isVisible(), true);
  assert.equal(await page.evaluate(() => typeof window.jQuery.fn.modal), 'function');
  assert.deepEqual(errors, []);
});
