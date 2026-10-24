import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { clientPortalObjectRuntime } from '../lib/portal-client-object.mjs';
import { injectRuntime, PAGES_CLIENT_API_SCRIPT } from '../lib/platform.mjs';
import { platformShell } from '../lib/platform-manifest.mjs';

const SOURCE = await fs.readFile(new URL('../lib/pages-client-api.js', import.meta.url), 'utf8');
const SITE = '77777777-7777-4777-8777-777777777777';

/** A minimal parsed document: no lists, the portal object runtime first, then the client API script. */
function browser({ withApi = true, requests = [] } = {}) {
  const logs = { error: [], warn: [] };
  const window = {
    console: {
      error: (message) => logs.error.push(String(message)),
      warn: (message) => logs.warn.push(String(message)),
      log() {},
    },
    document: {
      readyState: 'complete',
      documentElement: { lang: 'en-US' },
      addEventListener() {},
      querySelectorAll: () => [],
    },
    location: {
      href: 'http://127.0.0.1:9/page/',
      origin: 'http://127.0.0.1:9',
      pathname: '/page/',
      search: '',
      assign(url) {
        window.assigned = url;
      },
    },
    async fetch(url, init = {}) {
      requests.push({ url: String(url), init });
      if (String(url).endsWith('/_layout/tokenhtml'))
        return new Response('<input name="__RequestVerificationToken" type="hidden" value="tok" />');
      if (String(url).includes('/_api/x_items/$count')) return new Response('3');
      if (String(url).includes('/_api/x_items('))
        return new Response(JSON.stringify({ x_name: 'One' }), { headers: { 'content-type': 'application/json' } });
      if (String(url).includes('/_api/x_items') && init.method === 'POST')
        return new Response(null, {
          status: 204,
          headers: { 'OData-EntityId': `http://127.0.0.1:9/_api/x_items(${SITE})` },
        });
      if (String(url).includes('/_api/serverlogics/fail'))
        return new Response(JSON.stringify({ error: 'no' }), { status: 403, headers: { 'x-ms-request-id': 'req-1' } });
      return new Response(JSON.stringify({ ok: true }));
    },
    setTimeout,
    queueMicrotask,
    URL,
    Response,
    TextDecoder,
    atob,
    Promise,
    Proxy,
    Error,
    TypeError,
    Object,
    Array,
    JSON,
    Number,
    String,
    Uint8Array,
  };
  window.window = window;
  vm.runInNewContext(clientPortalObjectRuntime({}, { websiteId: SITE, language: 'en-US' }), window);
  if (withApi) vm.runInNewContext(SOURCE, window);
  return { window, logs, requests };
}

const within = (promise, ms = 500) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('still pending')), ms))]);

test('onPagesClientApiReady settles: the callback and the await form both receive $pages', async () => {
  const { window } = browser();
  let called = null;
  const awaited = await within(
    window.Microsoft.PowerPages.onPagesClientApiReady((api) => {
      called = api;
    }),
  );
  assert.equal(called, awaited);
  assert.equal(typeof awaited.currentPage.lists.getAll, 'function');
  assert.equal(await within(window.Microsoft.PowerPages.onPagesClientApiReady()), awaited);
  assert.equal(awaited.__paqvilo.version, 1);
  assert.equal(window.Microsoft.Dynamic365.Portal.isClientApiEnabled, 'True');
});

test('the deprecated Dynamic365 alias still resolves and warns once', async () => {
  const { window, logs } = browser();
  const portal = window.Microsoft.Dynamic365.Portal;
  await within(portal.onPagesClientApiReady());
  await within(portal.onPagesClientApiReady());
  assert.equal(logs.warn.filter((line) => /deprecated/.test(line)).length, 1);
});

test('without the client API script readiness rejects with a named error instead of hanging', async () => {
  const { window, logs } = browser({ withApi: false });
  await assert.rejects(within(window.Microsoft.PowerPages.onPagesClientApiReady(() => assert.fail('no callback'))), {
    name: 'PagesClientApiUnsupported',
  });
  assert.equal(window.Microsoft.Dynamic365.Portal.isClientApiEnabled, 'False');
  assert.equal(logs.error.length, 1);
});

test('unsupported members throw PagesClientApiUnsupported with the member name and log once', async () => {
  const { window, logs } = browser();
  const $pages = await within(window.Microsoft.PowerPages.onPagesClientApiReady());
  for (const [call, member] of [
    [() => $pages.agents.sendActivity('x'), 'agents.sendActivity'],
    [() => $pages.agents.startConversation(), 'agents.startConversation'],
  ])
    assert.throws(
      call,
      (error) =>
        error.name === 'PagesClientApiUnsupported' && error.member === member && error.message.includes(member),
    );
  assert.throws(() => $pages.agents.sendActivity('y'), { name: 'PagesClientApiUnsupported' });
  assert.equal(logs.error.filter((line) => line.includes('agents.sendActivity')).length, 1);
  // Forms, file columns and languages.setActive are served.
  assert.deepEqual([...$pages.currentPage.forms.getAll()], []);
  assert.equal($pages.currentPage.forms.getFormByName('x'), undefined);
});

test('languages.setActive switches the language like the language picker: /<code> before the path', async () => {
  const { window } = browser();
  const $pages = await within(window.Microsoft.PowerPages.onPagesClientApiReady());
  assert.throws(() => $pages.languages.setActive('fr-FR'), TypeError, 'a language the site does not have');
  assert.equal(window.assigned, undefined, 'a refused code does not navigate');
  window.Microsoft.Dynamic365.Portal.activeLanguages = ['en-US', 'fr-FR', 'de-DE'];
  $pages.languages.setActive('fr-FR');
  assert.equal(window.assigned, '/fr-FR/page/');
  window.location.pathname = '/en-US/page/';
  window.location.search = '?id=1';
  $pages.languages.setActive('de-DE');
  assert.equal(window.assigned, '/de-DE/page/?id=1', 'the active language segment is replaced');
  assert.throws(() => $pages.languages.setActive('../x'), TypeError);
});

test('webAPI file-column methods call the portal Web API file routes', async () => {
  const { window, requests } = browser();
  window.Blob = Blob;
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    if (String(url).includes('/$value'))
      return new Response(new Blob(['bytes']), {
        headers: { 'content-type': 'application/octet-stream', mimetype: 'text/plain' },
      });
    if (String(url).includes('x_denied'))
      return new Response(JSON.stringify({ error: { code: '90040120' } }), { status: 403 });
    return new Response(null, { status: 204 });
  };
  const $pages = await within(window.Microsoft.PowerPages.onPagesClientApiReady());
  await $pages.webAPI.uploadFileToColumn(
    'x_items',
    SITE,
    'x_file',
    new File(['hello'], 'résumé.txt', { type: 'text/plain' }),
  );
  const upload = requests.find((request) => request.init.method === 'PATCH');
  assert.equal(upload.url, `/_api/x_items(${SITE})/x_file?x-ms-file-name=r%C3%A9sum%C3%A9.txt`);
  assert.equal(upload.init.headers.__RequestVerificationToken, 'tok');
  const blob = await $pages.webAPI.downloadFileFromColumn('x_items', SITE, 'x_file');
  assert.deepEqual(
    [await blob.text(), blob.type],
    ['bytes', 'text/plain'],
    'the Blob is typed from the mimetype header',
  );
  assert.ok(requests.some((request) => request.url === `/_api/x_items(${SITE})/x_file/$value?size=full`));
  await $pages.webAPI.downloadFileFromColumn('x_items', SITE, 'x_image', { size: 'thumbnail' });
  assert.ok(requests.some((request) => request.url.endsWith('/x_image/$value?size=thumbnail')));
  await assert.rejects(
    $pages.webAPI.uploadFileToColumn('x_denied', SITE, 'x_file', new Blob(['x'])),
    (error) => error.name === 'AjaxError' && error.status === 403,
  );
  await assert.rejects($pages.webAPI.uploadFileToColumn('x_items', SITE, 'x_file', 'not a file'), TypeError);
});

test('lists, languages, user, ajax and webAPI work over the local services', async () => {
  const { window, requests } = browser();
  const $pages = await within(window.Microsoft.PowerPages.onPagesClientApiReady());
  assert.deepEqual([...$pages.currentPage.lists.getAll()], []);
  assert.equal($pages.currentPage.lists.getListById('list_#1'), undefined);
  assert.deepEqual([...$pages.languages.getAll()], ['en-US']);
  assert.equal($pages.languages.getActive(), 'en-US');
  $pages.user.signIn();
  assert.equal(window.assigned, '/SignIn?returnUrl=%2Fpage%2F');

  const response = await $pages.ajax.request({
    url: '/_api/serverlogics/echo',
    params: { city: 'Oslo' },
    body: { a: 1 },
    headers: { 'x-requested-with': 'override' },
  });
  assert.deepEqual([response.status, response.ok, response.data.ok], [200, true, true]);
  const sent = requests.find((request) => request.url.includes('/serverlogics/echo'));
  assert.equal(sent.url, 'http://127.0.0.1:9/_api/serverlogics/echo?city=Oslo');
  assert.equal(sent.init.method, 'POST');
  assert.equal(sent.init.headers.__RequestVerificationToken, 'tok');
  assert.equal(sent.init.headers['x-requested-with'], 'XMLHttpRequest');
  await assert.rejects(
    $pages.ajax.request({ url: '/_api/serverlogics/fail' }),
    (error) =>
      error.name === 'AjaxError' && error.status === 403 && error.body.error === 'no' && error.requestId === 'req-1',
  );
  const controller = new AbortController();
  controller.abort();
  window.fetch = async (url, init) => {
    if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return new Response('<input value="tok">');
  };
  await assert.rejects($pages.ajax.request({ url: '/_api/serverlogics/slow', signal: controller.signal }), {
    name: 'CanceledError',
  });
});

test('webAPI record methods call the local portal Web API', async () => {
  const { window, requests } = browser();
  const $pages = await within(window.Microsoft.PowerPages.onPagesClientApiReady());
  assert.equal(await $pages.webAPI.createRecord('x_items', { x_name: 'One' }), SITE);
  assert.deepEqual({ ...(await $pages.webAPI.retrieveRecord('x_items', SITE, '$select=x_name')) }, { x_name: 'One' });
  assert.equal(await $pages.webAPI.getRecordCount('x_items'), 3);
  await $pages.webAPI.associateRecord('x_items', SITE, 'x_children', 'x_others', SITE);
  const associate = requests.find((request) => request.url.endsWith('/x_children/$ref'));
  assert.equal(JSON.parse(associate.init.body)['@odata.id'], `http://127.0.0.1:9/_api/x_others(${SITE})`);
  assert.ok(requests.some((request) => request.url.endsWith(`/_api/x_items(${SITE})?$select=x_name`)));
});

test('injected pages load the client API right after the runtime; a page with the platform bundles runs it inline', () => {
  const html = injectRuntime(
    '<html><head><title>x</title></head><body><script>authored()</script></body></html>',
    'tok',
    1,
    {},
  );
  assert.match(
    html,
    new RegExp(
      `<script data-paqvilo-mirage-runtime>[\\s\\S]*?</script><script src="${PAGES_CLIENT_API_SCRIPT}" data-paqvilo-mirage-runtime></script><title>`,
    ),
  );
  const bundled = injectRuntime(
    `<html><head><title>x</title><script src="${platformShell({}).bundles.find((bundle) => /preform.*moment.*\.js$/.test(bundle.path)).path}"></script></head><body></body></html>`,
    'tok',
    1,
    {},
  );
  assert.match(
    bundled,
    /<script data-paqvilo-mirage-runtime>[\s\S]*window\.__paqviloPages = \$pages[\s\S]*?<\/script><title>/,
  );
  assert.doesNotMatch(bundled, /__sim-static/);
});
