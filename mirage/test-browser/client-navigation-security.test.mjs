import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { closeServer, sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });

const source = await fs.readFile(new URL('../lib/pages-client-api.js', import.meta.url), 'utf8');
const attribute = (value) =>
  String(value).replace(/[&"<>]/g, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]);
function modern(link, website = '77777777-7777-4777-8777-777777777701') {
  const layouts = Buffer.from(
    JSON.stringify([
      {
        Columns: [{ Type: 0, LogicalName: 'x_name', Name: 'Name' }],
        Configuration: { ItemActionLinks: [{ Enabled: true, Type: 1, Label: 'Open record', ...link }] },
      },
    ]),
  ).toString('base64');
  return `<div data-pp-modern-list data-view-layouts="${layouts}" data-website-id="${attribute(website)}" data-get-url="/grid"><table><thead><tr></tr></thead><tbody></tbody></table><div data-pp-modern-list-more></div><dialog data-pp-modern-list-dialog><button data-pp-modern-list-close>Close</button><iframe></iframe></dialog><p class="message view-error" hidden>Error</p><p class="message view-empty" hidden>Empty</p></div>`;
}
const documents = (url) =>
  `<div data-pp-documents data-documents-url="${attribute(url)}"><table><tbody></tbody></table><p class="message" hidden></p></div>`;
async function fixture(t) {
  const pages = new Map(),
    requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, method: request.method });
    if (url.pathname === '/client.js')
      return response.writeHead(200, { 'content-type': 'text/javascript' }).end(source);
    if (url.pathname === '/_layout/tokenhtml') return response.end('<input value="fixture-token">');
    if (url.pathname === '/grid')
      return response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          MoreRecords: false,
          Records: [{ Id: 'one', Attributes: [{ Name: 'x_name', DisplayValue: 'One' }] }],
        }),
      );
    if (url.pathname === '/_apps/portal-documents/x_case/one')
      return response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ documents: [{ name: 'javascript:alert(1).txt', size: 10 }], folders: [] }));
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
  const website = 'site/../../javascript:window.injected=true',
    modal = await app.open(modern({ EntityForm: { Id: 'form-one' } }, website));
  await modal.getByRole('button', { name: 'Open record', exact: true }).click();
  await modal.locator('dialog[open]').waitFor();
  assert.equal(
    await modal.locator('iframe').getAttribute('src'),
    app.origin + '/_portal/modal-form-template-path/' + encodeURIComponent(website) + '?entityformid=form-one&id=one',
  );
  assert.equal(await modal.evaluate(() => window.injected), undefined);
  assert.deepEqual(app.external, []);
  assert.deepEqual(app.errors, []);
});

test('document grid rejects unsafe service URLs and keeps hostile filenames in a local download path', async (t) => {
  const app = await fixture(t);
  for (const target of [
    'javascript:javascript:window.injected=true',
    'data:text/html,<script>parent.injected=true</script>',
    'https://elsewhere.invalid/documents',
  ]) {
    const page = await app.open(documents(target));
    await page.getByText('The document service URL must stay within this portal.', { exact: true }).waitFor();
    assert.equal(await page.locator('tbody a').count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.close();
  }
  const page = await app.open(documents('/_apps/portal-documents/x_case/one')),
    link = page.getByRole('link', { name: 'javascript:alert(1).txt', exact: true });
  await link.waitFor();
  assert.equal(
    await link.getAttribute('href'),
    app.origin + '/_apps/portal-documents/x_case/one/javascript%3Aalert(1).txt',
  );
  await link.click();
  await page.waitForURL(app.origin + '/_apps/portal-documents/x_case/one/javascript%3Aalert(1).txt');
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.deepEqual(app.external, []);
  assert.deepEqual(app.errors, []);
});
