// @test-kind security: page scripts never navigate to or request executable or external URLs taken from list configuration, service answers or rendered attributes: modern list actions, and the SharePoint document control's service URLs and file links
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { closeServer, sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });

const source = await fs.readFile(new URL('../lib/pages-client-api.js', import.meta.url), 'utf8');
const gridSource = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url), 'utf8');
const attribute = (value) =>
  String(value).replace(/[&"<>]/g, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]);
// The modern lists' configurations (GET /_services/portal/GetListViewConfiguration/<list>), by list id.
const configurations = new Map();
const WEBSITE = '77777777-7777-4777-8777-777777777701';
const GRID = `/_services/entity-grid-data.json/${WEBSITE}`;
// The configuration's routes are served as given: a hostile response names them verbatim.
function modern(
  link,
  { modalFormTemplateUrl = `/_portal/modal-form-template-path/${WEBSITE}`, getDataUrl = GRID } = {},
) {
  const id = `list-${configurations.size + 1}`;
  configurations.set(id, {
    layouts: [
      {
        Columns: [{ Type: 0, LogicalName: 'x_name', Name: 'Name' }],
        Configuration: { ItemActionLinks: [{ Enabled: true, Type: 1, Label: 'Open record', ...link }] },
      },
    ],
    getDataUrl,
    modalFormTemplateUrl,
  });
  return `<div data-pp-modern-list data-list-id="${attribute(id)}"><table><thead><tr></tr></thead><tbody></tbody></table><div data-pp-modern-list-more></div><dialog data-pp-modern-list-dialog><button data-pp-modern-list-close>Close</button><iframe></iframe></dialog><p class="message view-error" hidden>Error</p><p class="message view-empty" hidden>Empty</p></div>`;
}
// The SharePoint document control (sharepoint-documents.mjs sharePointControlMarkup) reduced to what its client reads.
const documents = (url) =>
  `<div id="antiforgerytoken"><input name="__RequestVerificationToken" type="hidden" value="fixture-token"></div><div class="subgrid sharepoint-grid" data-bs-target="${attribute(JSON.stringify({ Id: 'one', LogicalName: 'x_case' }))}" data-delete-enabled="False" data-pagesize="10" data-url-get="${attribute(url)}"><script id="sharepoint-template" type="text/x-handlebars-template"><div class="view-grid"><table><thead><tr><th>Name</th></tr></thead></table></div></script><div class="sharepoint-data"></div><div class="sharepoint-empty message" style="display: none;">Empty</div><div class="sharepoint-error message" style="display: none;">Error completing request.</div><div class="sharepoint-loading message">Loading...</div><div class="sharepoint-pagination"></div></div><script src="/grid.js" defer></script>`;
async function fixture(t) {
  const pages = new Map(),
    requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, method: request.method });
    if (url.pathname === '/client.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(source);
    if (url.pathname === '/grid.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(gridSource);
    if (url.pathname === '/_layout/tokenhtml') return response.end('<input value="fixture-token">');
    const configuration = /^\/_services\/portal\/GetListViewConfiguration\/(.+)$/.exec(url.pathname);
    if (configuration)
      return response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(configurations.get(configuration[1]) ?? {}));
    if (url.pathname === GRID)
      return response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          MoreRecords: false,
          Records: [{ Id: 'one', Attributes: [{ Name: 'x_name', DisplayValue: 'One' }] }],
        }),
      );
    if (url.pathname === '/_services/sharepoint-data.json/site')
      return response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          SharePointItems: [
            ['javascript:alert(1).txt', '/_apps/portal-documents/x_case/one/javascript%3Aalert(1).txt'],
            ['script.txt', 'javascript:window.injected=true'],
            ['data.txt', 'data:text/html,<script>parent.injected=true</script>'],
            ['elsewhere.txt', 'https://elsewhere.invalid/file.txt'],
            // Same origin before normalisation; its path /.//host normalises to the protocol-relative //host.
            ['dotted.txt', '/.//elsewhere.invalid/file.txt'],
            ['backslash.txt', '/./\\elsewhere.invalid/file.txt'],
          ].map(([Name, Url]) => ({ Id: Name, Name, IsFolder: false, IsParent: false, FolderPath: '', Url })),
          PageSize: 10,
          PageNumber: 1,
          PagingInfo: null,
          TotalCount: 6,
          AccessDenied: false,
          ConfigError: false,
        }),
      );
    response
      .writeHead(200, { 'content-type': 'text/html' })
      .end(
        pages.has(url.pathname)
          ? `<!doctype html><html><head><link rel="icon" href="data:,"><script src="/client.js" defer></script></head><body>${pages.get(url.pathname)}</body></html>`
          : '<!doctype html><title>Local target</title><p>Local target</p>',
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ownedFixture(t).add(() => closeServer(server));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chrome.browser.newContext(),
    errors = [],
    external = [];
  ownedFixture(t).add(() => context.close());
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  let index = 0;
  return {
    origin,
    requests,
    errors,
    external,
    async open(html) {
      const route = '/case/' + ++index;
      pages.set(route, html);
      const page = await context.newPage();
      await page.goto(origin + route);
      return page;
    },
  };
}

test('modern list actions reject executable and external URLs while preserving local page and modal actions', async (t) => {
  const app = await fixture(t);
  for (const target of [
    'javascript:javascript:window.injected=true',
    'data:text/html,<script>parent.injected=true</script>',
    'https://elsewhere.invalid/target',
    '//elsewhere.invalid/target',
  ]) {
    const page = await app.open(modern({ URL: { PathWithQueryString: target } }));
    const before = page.url();
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    assert.equal(page.url(), before);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.close();
  }
  const local = await app.open(modern({ URL: { PathWithQueryString: '/target?name=hello%20world' } }));
  await local.getByRole('button', { name: 'Open record', exact: true }).click();
  await local.waitForURL(
    (url) =>
      url.origin === app.origin &&
      url.pathname === '/target' &&
      url.searchParams.get('name') === 'hello world' &&
      url.searchParams.get('id') === 'one',
  );
  await local.close();
  // A configuration's modal form route outside the portal's modal form path opens nothing.
  for (const modalFormTemplateUrl of [
    `/_portal/modal-form-template-path/site/../../javascript:window.injected=true`,
    'javascript:window.injected=true',
    '//elsewhere.invalid/_portal/modal-form-template-path/site',
    'https://elsewhere.invalid/_portal/modal-form-template-path/site',
    '/elsewhere/modal',
  ]) {
    const page = await app.open(modern({ EntityForm: { Id: 'form-one' } }, { modalFormTemplateUrl }));
    await page.getByRole('button', { name: 'Open record', exact: true }).click();
    assert.equal(await page.locator('dialog[open]').count(), 0, modalFormTemplateUrl);
    assert.equal(await page.locator('iframe').getAttribute('src'), null, modalFormTemplateUrl);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.close();
  }
  const modal = await app.open(modern({ EntityForm: { Id: 'form-one' } }));
  await modal.getByRole('button', { name: 'Open record', exact: true }).click();
  await modal.locator('dialog[open]').waitFor();
  assert.equal(
    await modal.locator('iframe').getAttribute('src'),
    `${app.origin}/_portal/modal-form-template-path/${WEBSITE}?entityformid=form-one&id=one`,
  );
  assert.deepEqual(app.external, []);
  assert.deepEqual(app.errors, []);
});

test('a modern list posts its anti-forgery token only to a grid service of the portal', async (t) => {
  const app = await fixture(t);
  for (const getDataUrl of [
    'https://elsewhere.invalid/_services/entity-grid-data.json/site',
    '//elsewhere.invalid/_services/entity-grid-data.json/site',
    '/collect-token',
    '/_services/../collect-token',
    'javascript:window.injected=true',
  ]) {
    const before = app.requests.length;
    const page = await app.open(modern({ URL: { PathWithQueryString: '/target' } }, { getDataUrl }));
    await page.locator('.view-error:not([hidden])').waitFor();
    const posts = app.requests.slice(before).filter((request) => request.method === 'POST');
    assert.deepEqual(posts, [], getDataUrl);
    assert.equal(await page.locator('tbody tr').count(), 0, getDataUrl);
    await page.close();
  }
  assert.deepEqual(app.external, []);
  assert.deepEqual(app.errors, []);
});

test('the document control refuses service URLs outside the portal and keeps file links on the portal', async (t) => {
  const app = await fixture(t);
  for (const target of [
    'javascript:javascript:window.injected=true',
    'data:text/html,<script>parent.injected=true</script>',
    'https://elsewhere.invalid/documents',
    '/.//elsewhere.invalid/documents',
  ]) {
    const page = await app.open(documents(target));
    await page.locator('.sharepoint-error').waitFor();
    assert.equal(await page.locator('.sharepoint-data a').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.close();
  }
  assert.deepEqual(app.external, [], 'no request left the portal');
  const page = await app.open(documents('/_services/sharepoint-data.json/site'));
  const link = (name) => page.locator(`tr.sp-item[data-filename="${name}"] a.sharepoint-custom-icon`);
  await link('javascript:alert(1).txt').waitFor();
  for (const name of ['script.txt', 'data.txt', 'elsewhere.txt', 'dotted.txt', 'backslash.txt'])
    assert.equal(await link(name).getAttribute('href'), '#', name);
  assert.equal(
    await link('javascript:alert(1).txt').getAttribute('href'),
    '/_apps/portal-documents/x_case/one/javascript%3Aalert(1).txt',
  );
  await link('javascript:alert(1).txt').evaluate((anchor) => anchor.removeAttribute('target'));
  await link('javascript:alert(1).txt').click();
  await page.waitForURL(app.origin + '/_apps/portal-documents/x_case/one/javascript%3Aalert(1).txt');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.deepEqual(app.external, []);
  assert.deepEqual(app.errors, []);
});
