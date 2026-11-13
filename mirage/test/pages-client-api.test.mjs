// @test-kind unproven: local model of the portal client API and injected runtime; no reproduced native capture cited.
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

/** A stub element with the members the modern list and the document grid use; queries answer from `queries`. */
class StubElement {
  constructor(tag, attributes = {}) {
    this.tag = tag;
    this.attributes = { ...attributes };
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.queries = {};
    this.listeners = new Map();
    this.parent = null;
    this.hidden = false;
    this.textContent = '';
    this.content = { textContent: '' };
    this.classList = { add() {}, remove() {} };
  }
  get innerHTML() {
    return this.content.textContent;
  }
  set innerHTML(value) {
    this.content.textContent = value;
  }
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  hasAttribute(name) {
    return name in this.attributes;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  removeAttribute(name) {
    delete this.attributes[name];
  }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  querySelector(selector) {
    return this.queries[selector] ?? null;
  }
  querySelectorAll() {
    return [];
  }
  matches() {
    return false;
  }
  adopt(nodes) {
    for (const node of nodes) if (node instanceof StubElement) node.parent = this;
    return nodes;
  }
  append(...nodes) {
    this.children.push(...this.adopt(nodes));
  }
  prepend(...nodes) {
    this.children.unshift(...this.adopt(nodes));
  }
  replaceChildren(...nodes) {
    this.children = this.adopt(nodes);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
}

const LIST_ROOT = '[data-pp-modern-list], .entity-grid.entitylist';
const LIST_MESSAGES = ['none', 'view-empty', 'view-error', 'view-access-denied'];

/** A modern list on a stub page with the given columns and layout configuration; its rows come from the list's data URL. */
function modernListPage(window, columns, configuration = {}) {
  const messages = LIST_MESSAGES.map((name) =>
    Object.assign(new StubElement('div'), { matches: (selector) => selector === `.${name}` }),
  );
  const head = new StubElement('tr');
  const body = new StubElement('tbody');
  const table = new StubElement('table');
  table.queries = { 'thead tr': head, tbody: body };
  const layout = {
    Id: 'all',
    ViewName: 'Active Items',
    Columns: columns,
    Configuration: configuration,
    SortExpression: '',
  };
  const actions = new StubElement('span');
  const element = new StubElement('div', {
    'data-pp-modern-list': '',
    'data-view-layouts': Buffer.from(JSON.stringify([layout])).toString('base64'),
    'data-get-url': '/_services/entity-grid-data/list',
  });
  element.queries = { table, '[data-pp-modern-list-actions]': actions };
  element.querySelectorAll = (selector) => (selector === '.message' ? messages : []);
  window.document.createElement = (tag) => new StubElement(tag);
  window.document.querySelectorAll = (selector) => (selector === LIST_ROOT ? [element] : []);
  window.CSS = { escape: (value) => String(value) };
  return { body, messages, actions };
}

/** Answers the anti-forgery token request with a token and every other request with the JSON data. */
function jsonRoutes(window, requests, data) {
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
}

test('onPagesClientApiReady settles: the callback and the await form both receive $pages', async () => {
  const { window } = browser();
  let called = null;
  const awaited = await window.Microsoft.PowerPages.onPagesClientApiReady((api) => {
    called = api;
  });
  assert.equal(called, awaited);
  assert.equal(typeof awaited.currentPage.lists.getAll, 'function');
  assert.equal(await window.Microsoft.PowerPages.onPagesClientApiReady(), awaited);
  assert.equal(awaited.__paqvilo.version, 1);
  assert.equal(window.Microsoft.Dynamic365.Portal.isClientApiEnabled, 'True');
});

test('the deprecated Dynamic365 alias still resolves and warns once', async () => {
  const { window, logs } = browser();
  const portal = window.Microsoft.Dynamic365.Portal;
  await portal.onPagesClientApiReady();
  await portal.onPagesClientApiReady();
  assert.equal(logs.warn.filter((line) => /deprecated/.test(line)).length, 1);
});

test('without the client API script readiness rejects with a named error instead of hanging', async () => {
  const { window, logs } = browser({ withApi: false });
  await assert.rejects(
    window.Microsoft.PowerPages.onPagesClientApiReady(() => assert.fail('no callback')),
    {
      name: 'PagesClientApiUnsupported',
    },
  );
  assert.equal(window.Microsoft.Dynamic365.Portal.isClientApiEnabled, 'False');
  assert.equal(logs.error.length, 1);
});

test('unsupported members throw PagesClientApiUnsupported with the member name and log once', async () => {
  const { window, logs } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
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
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
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
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
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
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
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
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
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
    /<script data-paqvilo-mirage-runtime>[\s\S]*(?:window|globalThis)\.__paqviloPages = \$pages[\s\S]*?<\/script><title>/,
  );
  assert.doesNotMatch(bundled, /__sim-static/);
});

// @test-kind contract: a token response that is not 2xx or carries no token is a failed request, not a token to reuse.
test('a failed anti-forgery token fetch rejects, is not reused, and the next request fetches a token again', async () => {
  const { window, requests } = browser();
  let tokenCalls = 0;
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) {
      tokenCalls += 1;
      return tokenCalls === 1
        ? new Response('<h1>Server Error</h1>', { status: 500 })
        : new Response('<input value="tok">');
    }
    return new Response('{}', { status: init.headers.__RequestVerificationToken ? 200 : 403 });
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  await assert.rejects($pages.ajax.request({ url: '/_api/serverlogics/echo', body: {} }), {
    name: 'AjaxError',
    status: 500,
  });
  const second = await $pages.ajax.request({ url: '/_api/serverlogics/echo', body: {} });
  assert.equal(second.status, 200);
  assert.equal(tokenCalls, 2);
  const sent = requests
    .filter((request) => request.url.includes('/serverlogics/echo'))
    .map((request) => request.init.headers.__RequestVerificationToken);
  assert.deepEqual(sent, ['tok']);
});

// @test-kind contract: Learn client-api/ajax rejects with an AjaxError of status 0 when the network fails, also for the token.
test('a network failure of the token fetch rejects with AjaxError status 0, and an abort during it is a CanceledError', async () => {
  const { window, requests } = browser();
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) throw new TypeError('Failed to fetch');
    return new Response('{}');
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  await assert.rejects(
    $pages.ajax.request({ url: '/_api/serverlogics/echo' }),
    (error) => error.name === 'AjaxError' && error.status === 0,
  );

  const controller = new AbortController();
  controller.abort();
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    return new Response('<input value="tok">');
  };
  await assert.rejects($pages.ajax.request({ url: '/_api/serverlogics/echo', signal: controller.signal }), {
    name: 'CanceledError',
  });
  const tokenFetch = requests.filter((request) => request.url.endsWith('/_layout/tokenhtml')).at(-1);
  assert.equal(tokenFetch.init.signal, undefined, 'the shared token fetch carries no caller signal');
});

/** Token responses whose body read is answered by readBody(attempt); every other request answers with `{}`. */
function tokenBodies(window, requests, readBody) {
  const counts = { tokenFetches: 0 };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (!String(url).endsWith('/_layout/tokenhtml')) return new Response('{}');
    counts.tokenFetches += 1;
    const attempt = counts.tokenFetches;
    return { ok: true, status: 200, headers: { get: () => null }, text: () => readBody(attempt) };
  };
  return counts;
}

// @test-kind contract: Learn client-api/ajax: an abort that lands while the token body is read is a CanceledError, as during the fetch.
test('an abort while the anti-forgery token body is read is a CanceledError, and the next request fetches a token again', async () => {
  const { window, requests } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const controller = new AbortController();
  const counts = tokenBodies(window, requests, async (attempt) => {
    if (attempt > 1) return '<input value="tok">';
    controller.abort();
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects($pages.ajax.request({ url: '/_api/serverlogics/echo', signal: controller.signal }), {
    name: 'CanceledError',
  });
  const second = await $pages.ajax.request({ url: '/_api/serverlogics/echo' });
  assert.equal(second.status, 200);
  assert.equal(counts.tokenFetches, 2);
});

// @test-kind contract: Learn client-api/ajax rejects with an AjaxError of status 0 when reading the token body fails.
test('a network failure while the anti-forgery token body is read is an AjaxError status 0, and the next request fetches a token again', async () => {
  const { window, requests } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const counts = tokenBodies(window, requests, async (attempt) => {
    if (attempt > 1) return '<input value="tok">';
    throw new TypeError('network');
  });
  await assert.rejects(
    $pages.ajax.request({ url: '/_api/serverlogics/echo' }),
    (error) => error.name === 'AjaxError' && error.status === 0,
  );
  const second = await $pages.ajax.request({ url: '/_api/serverlogics/echo' });
  assert.equal(second.status, 200);
  assert.equal(counts.tokenFetches, 2);
});

/** A response whose body delivers a first chunk, then fails with the error passed to fail(). */
function partialBody() {
  let stream;
  const body = new ReadableStream({
    start(controller) {
      stream = controller;
      controller.enqueue(new TextEncoder().encode('{"a":'));
    },
  });
  return { body, fail: (error) => stream.error(error) };
}

// @test-kind contract: Learn client-api/ajax: an abort that lands while the response is read is a CanceledError.
test('an abort while a response body is read rejects with CanceledError, and other body errors are not renamed', async () => {
  const { window } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const controller = new AbortController();
  let partial = partialBody();
  window.fetch = async (url) => {
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    controller.abort();
    partial.fail(new DOMException('The operation was aborted.', 'AbortError'));
    return new Response(partial.body, { status: 200 });
  };
  await assert.rejects($pages.ajax.request({ url: '/_api/serverlogics/slow', signal: controller.signal }), {
    name: 'CanceledError',
  });

  partial = partialBody();
  window.fetch = async (url) => {
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    partial.fail(new TypeError('network down'));
    return new Response(partial.body, { status: 200 });
  };
  await assert.rejects($pages.ajax.request({ url: '/_api/serverlogics/broken' }), {
    name: 'TypeError',
    message: 'network down',
  });
});

// @test-kind contract: Learn client-api/dataverse: a file download cancelled by the abort is a CanceledError too.
test('an abort while a file column download is read rejects with CanceledError', async () => {
  const { window } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const partial = partialBody();
  window.fetch = async (url) => {
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    partial.fail(new DOMException('The operation was aborted.', 'AbortError'));
    return new Response(partial.body, { status: 200 });
  };
  await assert.rejects($pages.webAPI.downloadFileFromColumn('x_items', SITE, 'x_file'), { name: 'CanceledError' });
});

// @test-kind compatibility: Learn client-api/lists IRow.getValue returns a raw string, number, Boolean, valid date or numeric option value.
test('row.getValue returns a Date for a grid date value and keeps option set and Boolean values', async () => {
  const { window, requests } = browser();
  modernListPage(window, [{ Type: 0, LogicalName: 'createdon', Name: 'Created', SortDisabled: true }]);
  jsonRoutes(window, requests, {
    MoreRecords: false,
    Records: [
      {
        Id: SITE,
        Attributes: [
          { Name: 'createdon', Value: '/Date(1767225600000)/', DisplayValue: '1/1/2026' },
          { Name: 'modifiedon', Value: '/Date(1767225600000+0100)/', DisplayValue: '' },
          { Name: 'broken', Value: '/Date(99999999999999999999)/', DisplayValue: '' },
          { Name: 'statuscode', Value: { Value: 6 }, DisplayValue: 'Active' },
          { Name: 'donotemail', Value: true, DisplayValue: 'Yes' },
        ],
      },
    ],
  });
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const [list] = $pages.currentPage.lists.getAll();
  await list.__loadMore();
  const [row] = list.rows;
  const created = row.getValue('createdon');
  // The VM has its own Date constructor, so the check is by class name rather than instanceof.
  assert.equal(Object.prototype.toString.call(created), '[object Date]');
  assert.equal(created.getTime(), 1767225600000);
  assert.notEqual(row.getValue('createdon'), created, 'each call returns a fresh Date');
  assert.equal(row.getValue('modifiedon').getTime(), 1767225600000);
  assert.equal(row.getValue('broken'), null);
  assert.equal(row.getValue('statuscode'), 6);
  assert.equal(row.getValue('donotemail'), true);
});

const LIST_RECORD = { Id: SITE, Attributes: [{ Name: 'name', Value: 'Ada', DisplayValue: 'Ada' }] };
const LIST_COLUMNS = [{ Type: 0, LogicalName: 'name', Name: 'Name', SortDisabled: true }];

// @test-kind contract: a throwing loaded handler is the page's error: the rows, paging and the other handlers stay, and it is reported.
test('a throwing loaded handler keeps the rows, paging and the other handlers, and is reported', async () => {
  const { window, requests } = browser();
  const reported = [];
  window.queueMicrotask = (task) => reported.push(task);
  const { body, messages } = modernListPage(window, LIST_COLUMNS);
  jsonRoutes(window, requests, { MoreRecords: true, Records: [LIST_RECORD] });
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const [list] = $pages.currentPage.lists.getAll();
  const seen = [];
  list.on('loaded', () => {
    throw new Error('handler failed');
  });
  list.on('loaded', ({ rows }) => seen.push(rows.length));
  await list.__loadMore();
  assert.deepEqual(seen, [1]);
  assert.equal(body.children.length, 1);
  assert.equal(messages.find((message) => message.matches('.view-error')).hidden, true);
  assert.equal(reported.length, 1);
  assert.throws(() => reported[0](), { message: 'handler failed' });
  await list.__loadMore();
  const listRequests = requests.filter((request) => request.url === '/_services/entity-grid-data/list');
  assert.equal(listRequests.length, 2, 'paging continues after the handler error');
});

// @test-kind contract: a list response that cannot be read shows the list error view and is logged with console.error.
test('a list response that is not JSON shows the list error view and is logged', async () => {
  const { window, logs } = browser();
  window.fetch = async (url) =>
    String(url).endsWith('/_layout/tokenhtml') ? new Response('<input value="tok">') : new Response('not json');
  const { messages } = modernListPage(window, LIST_COLUMNS);
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const [list] = $pages.currentPage.lists.getAll();
  await list.__loadMore();
  assert.equal(messages.find((message) => message.matches('.view-error')).hidden, false);
  assert.ok(
    logs.error.some((line) => line.includes('SyntaxError')),
    'the failure is logged',
  );
});

// The stub page has no I/O: after a click or an answered fetch it only runs promise continuations, and its one timer
// is the zero-delay readiness timer (pages-client-api.js). Node runs every pending continuation and every earlier
// zero-delay timer before a later zero-delay timer, so one flush is an exact barrier and never an allowance of time.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const GRID_CONTROL_MARKERS = ['ppDocumentsUpload', 'ppDocumentsNewFolder', 'ppDocumentsPath'];

/** A document grid on a stub page; the page's readiness timer starts its first load. */
function documentGridPage(window) {
  const body = new StubElement('tbody');
  const status = new StubElement('p');
  const grid = new StubElement('section', {
    'data-pp-documents': '',
    'data-documents-url': '/_apps/portal-documents/site',
  });
  grid.queries = { tbody: body, '.message': status };
  grid.querySelectorAll = () =>
    grid.children.filter((child) => GRID_CONTROL_MARKERS.some((name) => child.dataset?.[name] !== undefined));
  window.document.createElement = (tag) => new StubElement(tag);
  window.document.querySelectorAll = (selector) => (selector === '[data-pp-documents]' ? [grid] : []);
  window.URLSearchParams = URLSearchParams;
  return { grid, body, status };
}

/** Each fetch waits in the returned list until the test answers it, so the test sets the order of the responses. */
function answerLater(window) {
  const pending = [];
  window.fetch = (url) =>
    new Promise((resolve, reject) =>
      pending.push({
        url: String(url),
        respond: (data) => resolve({ ok: true, status: 200, json: async () => data }),
        fail: (error) => reject(error),
      }),
    );
  return pending;
}

const folderLink = (body, name) =>
  body.children.map((row) => row.children[0].children[0]).find((link) => link.dataset.ppDocumentsFolder === name);
const folderNames = (body) => body.children.map((row) => row.children[0].children[0].dataset.ppDocumentsFolder);
const breadcrumbs = (grid) => grid.children.filter((child) => child.dataset?.ppDocumentsPath !== undefined);
const press = (element) => {
  for (const listener of element.listeners.get('click') ?? []) listener({});
};

// @test-kind contract: overlapping folder opens: the latest open renders alone, once, with one breadcrumb.
test('overlapping folder opens render only the latest folder, once, with one breadcrumb', async () => {
  const { window } = browser();
  const pending = answerLater(window);
  const { grid, body } = documentGridPage(window);
  await flush();
  pending[0].respond({ folders: [{ name: 'Alpha' }, { name: 'Beta' }], documents: [] });
  await flush();
  press(folderLink(body, 'Alpha'));
  press(folderLink(body, 'Beta'));
  assert.equal(pending.length, 3);
  pending[2].respond({ folders: [{ name: 'Gamma' }], documents: [] });
  await flush();
  pending[1].respond({ folders: [{ name: 'Delta' }], documents: [] });
  await flush();
  assert.deepEqual(folderNames(body), ['Gamma']);
  assert.equal(breadcrumbs(grid).length, 1);
  assert.equal(breadcrumbs(grid)[0].children.at(-1).textContent, 'Beta');
});

// @test-kind contract: a failed folder open reports the failure in the status line instead of an unhandled rejection.
test('a failed folder open reports the error in the status line', async () => {
  const { window } = browser();
  const pending = answerLater(window);
  const { body, status } = documentGridPage(window);
  await flush();
  pending[0].respond({ folders: [{ name: 'Alpha' }], documents: [] });
  await flush();
  press(folderLink(body, 'Alpha'));
  pending[1].fail(new TypeError('Failed to fetch'));
  await flush();
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'Error completing request.');
});

// @test-kind contract: a folder open superseded by a newer open that then fails leaves the newest folder, its status and aria-busy alone.
test('a superseded folder open that fails does not overwrite the status line or the newest folder', async () => {
  const { window } = browser();
  const pending = answerLater(window);
  const { grid, body, status } = documentGridPage(window);
  await flush();
  pending[0].respond({ folders: [{ name: 'Alpha' }, { name: 'Beta' }], documents: [] });
  await flush();
  press(folderLink(body, 'Alpha'));
  press(folderLink(body, 'Beta'));
  pending[2].respond({ folders: [{ name: 'Gamma' }], documents: [] });
  await flush();
  pending[1].fail(new TypeError('Failed to fetch'));
  await flush();
  assert.deepEqual(folderNames(body), ['Gamma']);
  assert.equal(status.textContent, '');
  assert.equal(grid.getAttribute('aria-busy'), null);
});

// @test-kind contract: a folder open whose fetch fails removes aria-busy, so the grid is not left busy.
test('a failed folder open removes aria-busy from the grid', async () => {
  const { window } = browser();
  const pending = answerLater(window);
  const { grid, body } = documentGridPage(window);
  await flush();
  pending[0].respond({ folders: [{ name: 'Alpha' }], documents: [] });
  await flush();
  press(folderLink(body, 'Alpha'));
  assert.equal(grid.getAttribute('aria-busy'), 'true');
  pending[1].fail(new TypeError('Failed to fetch'));
  await flush();
  assert.equal(grid.getAttribute('aria-busy'), null);
});

// @test-kind contract: a failed upload reports the error in the status line and re-enables the input, with no unhandled rejection.
test('a failed upload reports the error in the status line and re-enables the input without an unhandled rejection', async () => {
  const { window, requests } = browser();
  const listing = { documents: [], folders: [], canUpload: true, canDelete: false };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    if (init.method === 'POST') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(listing));
  };
  const { grid, status } = documentGridPage(window);
  await flush();
  const input = grid.children.find((child) => child.dataset?.ppDocumentsUpload !== undefined);
  input.files = [{ name: 'report.txt', type: 'text/plain' }];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    // The DOM discards the listener's promise, so the test does too: a rejection left unhandled reaches onUnhandled.
    for (const listener of input.listeners.get('change') ?? []) void listener({});
    await flush();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
  assert.equal(status.textContent, 'Error completing request.');
  assert.equal(input.disabled, false);
});

// @test-kind contract: the shared in-flight token request keeps concurrent callers to one anti-forgery fetch.
test('concurrent requests share one in-flight anti-forgery token request', async () => {
  const { window, requests } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  await Promise.all([
    $pages.ajax.request({ url: '/_api/serverlogics/echo' }),
    $pages.ajax.request({ url: '/_api/serverlogics/echo' }),
  ]);
  assert.equal(requests.filter((request) => request.url.endsWith('/_layout/tokenhtml')).length, 1);
});

/** Token requests wait for one gate, which the test opens; a token request whose signal aborts rejects as an abort. */
function gatedTokenFetch(window, requests) {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const counts = { tokenFetches: 0 };
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (!String(url).endsWith('/_layout/tokenhtml')) return new Response('{}');
    counts.tokenFetches += 1;
    await new Promise((resolve, reject) => {
      init.signal?.addEventListener(
        'abort',
        () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        {
          once: true,
        },
      );
      gate.then(resolve);
    });
    return new Response('<input value="tok">');
  };
  return { counts, open: () => open() };
}

// @test-kind contract: the shared anti-forgery token is not tied to one caller: an abort of the first waiter rejects only that caller.
test('an abort of one caller waiting for the shared token rejects only that caller', async () => {
  const { window, requests } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const { counts, open } = gatedTokenFetch(window, requests);
  const controller = new AbortController();
  const first = $pages.ajax.request({ url: '/_api/serverlogics/echo', signal: controller.signal });
  const second = $pages.ajax.request({ url: '/_api/serverlogics/echo' });
  await flush();
  controller.abort();
  await assert.rejects(first, { name: 'CanceledError' });
  open();
  const response = await second;
  assert.equal(response.status, 200);
  assert.equal(counts.tokenFetches, 1);
  const echo = requests.filter((request) => request.url.includes('/_api/serverlogics/echo'));
  assert.equal(echo.length, 1, 'only the second caller sends its request');
  assert.equal(echo[0].init.headers.__RequestVerificationToken, 'tok');
});

// @test-kind contract: when every caller waiting for the shared token aborts, the token still arrives and serves the next request, with no unhandled rejection.
test('the shared token is cached when every caller waiting for it has aborted', async () => {
  const { window, requests } = browser();
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const { counts, open } = gatedTokenFetch(window, requests);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const controllers = [new AbortController(), new AbortController()];
    const waiting = controllers.map((controller) =>
      $pages.ajax.request({ url: '/_api/serverlogics/echo', signal: controller.signal }),
    );
    const outcomes = Promise.allSettled(waiting);
    await flush();
    for (const controller of controllers) controller.abort();
    for (const outcome of await outcomes) assert.equal(outcome.reason?.name, 'CanceledError');
    open();
    await flush();
    const later = await $pages.ajax.request({ url: '/_api/serverlogics/echo' });
    assert.equal(later.status, 200);
    assert.equal(counts.tokenFetches, 1, 'the token that arrives after the aborts is reused');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  await flush();
  assert.deepEqual(unhandled, []);
});

// @test-kind contract: a modern list's CSV download posts the columns of its current view, as the classic grid's download does.
test('the modern list CSV download posts the columns of the current view', async () => {
  const { window, requests } = browser();
  const columns = [
    { Type: 0, LogicalName: 'createdon', Name: 'Created', SortDisabled: true, Width: 100 },
    { Type: 0, LogicalName: 'name', Name: 'Name', SortDisabled: false, Width: 120 },
  ];
  const { actions } = modernListPage(window, columns, {
    ViewActionLinks: [{ position: 'view', Type: 8, Enabled: true, Label: 'Download' }],
  });
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    if (String(url).includes('/_services/download-as-csv/'))
      return new Response(JSON.stringify({ sessionKey: 'key-1' }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ Records: [], MoreRecords: false }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  await flush();
  $pages.currentPage.lists.getAll();
  const control = actions.children[0];
  assert.equal(control?.textContent, 'Download');
  for (const listener of control.listeners.get('click') ?? []) listener({ stopPropagation() {} });
  await flush();
  const download = requests.find((request) => request.url.includes('/_services/download-as-csv/'));
  assert.ok(download, 'the download request is sent');
  assert.deepEqual(JSON.parse(download.init.body).columns, columns);
  assert.equal(JSON.parse(download.init.body).viewName, 'Active Items', 'the export is named for the current view');
  assert.equal(window.assigned, '/_services/download-as-csv/?key=key-1');
});
