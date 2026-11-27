// @test-kind unproven: local model of the portal client API and injected runtime; no reproduced native capture cited.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { clientPortalObjectRuntime } from '../lib/portal-client-object.mjs';
import { clientRuntime, injectRuntime, PAGES_CLIENT_API_SCRIPT } from '../lib/platform.mjs';
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

/**
 * A modern list on a stub page with the given columns and layout configuration. The list reads its configuration from
 * GetListViewConfiguration (answered by listConfiguration below) and its rows from the configuration's data URL.
 */
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
  const element = new StubElement('div', { 'data-pp-modern-list': '', 'data-list-id': 'list' });
  window.listConfiguration = {
    layouts: [layout],
    defaultViewId: 'all',
    getDataUrl: `/_services/entity-grid-data.json/${SITE}`,
    modalFormTemplateUrl: `/_portal/modal-form-template-path/${SITE}`,
  };
  element.queries = { table, '[data-pp-modern-list-actions]': actions };
  element.querySelectorAll = (selector) => (selector === '.message' ? messages : []);
  window.document.createElement = (tag) => new StubElement(tag);
  window.document.querySelectorAll = (selector) => (selector === LIST_ROOT ? [element] : []);
  window.CSS = { escape: (value) => String(value) };
  return { body, messages, actions, element };
}

/** The stub page's list configuration answer, or null for another request. */
function listConfiguration(window, url) {
  if (!String(url).startsWith('/_services/portal/GetListViewConfiguration/')) return null;
  return new Response(JSON.stringify(window.listConfiguration), { headers: { 'content-type': 'application/json' } });
}

/** Answers the anti-forgery token request with a token and every other request with the JSON data. */
function jsonRoutes(window, requests, data) {
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    const configuration = listConfiguration(window, url);
    if (configuration) return configuration;
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

// @test-kind observation: hosted session F3 (paqvilo-developer hosted-f3 summary-F3.md API-05b, agent-probe captures of runs a and b, 2026-11-27): SendActivity reads /_services/agent/BotConfiguration; an empty configuration fails with the captured invalid-agent text, a listed agent posts /_services/auth/portalusertoken and requests its Direct Line token, and a failed connection fails with the captured Direct Line text
test('$pages.agent.SendActivity follows the hosted configuration, user token and Direct Line token requests', async () => {
  const { window, requests } = browser();
  let configuration = [];
  let token = { token: 'local-token', conversationId: 'c1' };
  window.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const path = new URL(String(url), window.location.origin).pathname;
    if (path === '/_layout/tokenhtml') return new Response('<input value="tok">');
    if (path === '/_services/agent/BotConfiguration') return new Response(JSON.stringify(configuration));
    if (path === '/_services/auth/portalusertoken') return new Response('header.payload.signature');
    if (path === '/powervirtualagents/botsbyschema/x_agent/directline/token')
      return token ? new Response(JSON.stringify(token)) : new Response('{}', { status: 404 });
    return new Response('{}', { status: 404 });
  };
  const { agent } = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const send = () => new Promise((resolve) => agent.SendActivity('x_agent', { text: 'Hello' }, resolve, resolve));
  const paths = () =>
    requests
      .filter((item) => !item.url.endsWith('/_layout/tokenhtml'))
      .map((item) => new URL(item.url, window.location.origin).pathname);

  const denied = await send();
  assert.equal(
    denied.message,
    'Invalid bot schema name or access denied. Please check the bot schema name and try again',
  );
  assert.deepEqual(paths(), ['/_services/agent/BotConfiguration'], 'no token is requested for an unlisted agent');

  configuration = [{ name: 'Invented agent', botSchemaName: 'x_agent', isVisible: true }];
  token = null;
  requests.length = 0;
  const failed = await send();
  assert.equal(failed.message, 'Something went wrong while creating direct line connection: Please try again');
  assert.deepEqual(paths(), [
    '/_services/agent/BotConfiguration',
    '/_services/auth/portalusertoken',
    '/powervirtualagents/botsbyschema/x_agent/directline/token',
  ]);
  const posted = requests.find((item) => item.url.endsWith('/portalusertoken'));
  assert.equal(posted.init.method, 'POST');
});

// @test-kind contract: the local Copilot stand-in is explicitly same-origin: a mocked Direct Line token's conversation receives the activity and its reply activities reach the callback
test('$pages.agent.SendActivity delivers explicit local mock responses and errors through callbacks', async () => {
  const { window, requests } = browser();
  const activities = [
    { type: 'message', text: 'A fixture reply' },
    { type: 'event', Id: 'one' },
  ];
  window.fetch = async (url, init) => {
    requests.push({ url, init });
    const path = new URL(String(url), window.location.origin).pathname;
    if (path === '/_layout/tokenhtml') return new Response('<input value="tok">');
    if (path === '/_services/agent/BotConfiguration')
      return new Response(JSON.stringify([{ botSchemaName: 'Available' }]));
    if (path === '/_services/auth/portalusertoken') return new Response('header.payload.signature');
    if (path === '/powervirtualagents/botsbyschema/Available/directline/token')
      return new Response(JSON.stringify({ token: 'local', conversationId: 'conversation-1' }));
    if (path === '/v3/directline/conversations/conversation-1/activities')
      return new Response(JSON.stringify(activities));
    return new Response('{}', { status: 404 });
  };
  const { agent } = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const received = [];
  await new Promise((resolve, reject) => {
    assert.equal(
      agent.SendActivity(
        'Available',
        { text: 'Hello' },
        (item) => {
          received.push(item);
          if (received.length === 2) resolve();
        },
        reject,
      ),
      undefined,
    );
  });
  assert.deepEqual(received, activities);
  const activity = requests.find((item) => String(item.url).endsWith('/activities'));
  assert.equal(activity.url, `${window.location.origin}/v3/directline/conversations/conversation-1/activities`);
  assert.deepEqual(
    [activity.init.method, activity.init.mode, activity.init.redirect],
    ['POST', 'same-origin', 'error'],
  );
  assert.equal(activity.init.headers['x-paqvilo-local-only'], 'true');
  assert.equal(activity.init.headers.__RequestVerificationToken, 'tok');
  assert.deepEqual(JSON.parse(activity.init.body), { text: 'Hello' });
  assert.ok(
    requests.every((item) => new URL(String(item.url), window.location.origin).origin === window.location.origin),
    'every request stays on the page origin',
  );

  const before = requests.length;
  const missing = await new Promise((resolve, reject) =>
    agent.SendActivity('Missing', { text: 'Hello' }, reject, resolve),
  );
  assert.equal(
    missing.message,
    'Invalid bot schema name or access denied. Please check the bot schema name and try again',
  );
  const invalid = await new Promise((resolve, reject) => agent.SendActivity('../Elsewhere', {}, reject, resolve));
  assert.equal(invalid.name, 'TypeError');
  assert.equal(
    requests.slice(before).filter((item) => !String(item.url).endsWith('/_layout/tokenhtml')).length,
    1,
    'a bad schema never starts a request',
  );
});

// @test-kind security: a Direct Line token answer cannot steer the activity off the conversation route or off the portal origin
test('$pages.agent.SendActivity refuses a conversation id that leaves its same-origin route', async () => {
  const { window, requests } = browser();
  let conversationId;
  window.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    const path = new URL(String(url), window.location.origin).pathname;
    if (path === '/_layout/tokenhtml') return new Response('<input value="tok">');
    if (path === '/_services/agent/BotConfiguration')
      return new Response(JSON.stringify([{ botSchemaName: 'x_agent' }]));
    if (path === '/_services/auth/portalusertoken') return new Response('header.payload.signature');
    if (path === '/powervirtualagents/botsbyschema/x_agent/directline/token')
      return new Response(JSON.stringify({ token: 'local', conversationId }));
    return new Response('[]');
  };
  const { agent } = await window.Microsoft.PowerPages.onPagesClientApiReady();
  for (conversationId of [
    '..',
    '../../_api/x_items',
    '//elsewhere.example/x',
    'https://elsewhere.example/',
    '.',
    'a/../../x',
    null,
  ]) {
    requests.length = 0;
    const error = await new Promise((resolve, reject) =>
      agent.SendActivity('x_agent', { text: 'Hi' }, reject, resolve),
    );
    assert.equal(error.message, 'Something went wrong while creating direct line connection: Please try again');
    assert.ok(
      requests.every((item) => !String(item.url).includes('/activities')),
      `no activity is posted for ${conversationId}`,
    );
    assert.ok(
      requests.every((item) => new URL(String(item.url), window.location.origin).origin === window.location.origin),
    );
  }
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

// @test-kind contract: the documented client download combines ordered 4 MiB partial responses into a typed Blob
test('webAPI downloads a large file in 4 MiB ranges and carries the file validator', async () => {
  const { window, requests } = browser();
  const chunk = new Uint8Array(4 * 1024 * 1024).fill(10);
  const tag = '"fixture-file-version"';
  window.Blob = Blob;
  window.fetch = async (url, init) => {
    requests.push({ url, init });
    const headers = { mimetype: 'application/pdf', etag: tag };
    if (requests.length === 1)
      return new Response(chunk, {
        status: 206,
        headers: { ...headers, 'content-range': `bytes 0-${chunk.length - 1}/${chunk.length + 1}` },
      });
    return new Response(new Uint8Array([42]), {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${chunk.length}-${chunk.length}/${chunk.length + 1}` },
    });
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const blob = await $pages.webAPI.downloadFileFromColumn('x_items', SITE, 'x_file');
  assert.deepEqual(
    requests.map(({ init }) => [init.headers.Range, init.headers['If-Match']]),
    [
      [`bytes=0-${chunk.length - 1}`, undefined],
      [`bytes=${chunk.length}-${2 * chunk.length - 1}`, tag],
    ],
  );
  assert.deepEqual([blob.size, blob.type], [chunk.length + 1, 'application/pdf']);
  const content = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(content.subarray(0, chunk.length), chunk);
  assert.equal(content.at(-1), 42);
});

// @test-kind contract: a whole-file fallback keeps the local client from combining unvalidated file versions
test('webAPI uses one whole response when an incomplete range has no validator', async () => {
  const { window, requests } = browser();
  window.Blob = Blob;
  window.fetch = async (url, init) => {
    requests.push({ url, init });
    if (requests.length === 1) return new Response('old', { status: 206, headers: { 'content-range': 'bytes 0-2/7' } });
    return new Response('replaced', { headers: { mimetype: 'text/plain' } });
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const blob = await $pages.webAPI.downloadFileFromColumn('x_items', SITE, 'x_file');
  assert.deepEqual(
    requests.map(({ init }) => [init.headers.Range, init.headers['If-Match']]),
    [
      ['bytes=0-4194303', undefined],
      [undefined, undefined],
    ],
  );
  assert.deepEqual([await blob.text(), blob.type], ['replaced', 'text/plain']);
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

// @test-kind contract: refreshing the paired portal token updates the shell holder used by subsequent local client requests
test('a shell refresh replaces the cached token for subsequent webAPI writes', async () => {
  const { window, requests } = browser({ withApi: false });
  let expected = 'first-token';
  let input = null;
  const holder = {
    getAttribute: () => '/_layout/tokenhtml',
    set innerHTML(html) {
      input = { value: /value="([^"]+)"/.exec(html)[1] };
    },
  };
  window.document.getElementById = (id) => (id === 'antiforgerytoken' ? holder : null);
  window.document.querySelector = (selector) =>
    selector === '#antiforgerytoken input[name="__RequestVerificationToken"]' ? input : null;
  const isToken = (url) => String(url).startsWith('/_layout/tokenhtml');
  window.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    if (isToken(url))
      return new Response(`<input name="__RequestVerificationToken" type="hidden" value="${expected}" />`);
    return init.headers.__RequestVerificationToken === expected
      ? new Response(null, { status: 204 })
      : Response.json({ error: { code: '90040107' } }, { status: 403 });
  };
  vm.runInNewContext(clientRuntime('first-token', 1), window);
  vm.runInNewContext(SOURCE, window);
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const write = (name) => $pages.webAPI.updateRecord('x_items', SITE, { x_name: name });
  await Promise.all([write('A'), write('B')]);
  assert.equal(requests.filter(({ url }) => isToken(url)).length, 1);
  assert.equal(input, null);

  expected = 'refreshed-token';
  assert.equal(await window.shell.refreshToken(), expected);
  await write('C');
  assert.equal(input.value, expected);
  assert.equal(requests.filter(({ url }) => isToken(url)).length, 2);
  assert.deepEqual(
    requests.filter(({ url }) => !isToken(url)).map(({ init }) => init.headers.__RequestVerificationToken),
    ['first-token', 'first-token', 'refreshed-token'],
  );
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
  const listRequests = requests.filter((request) => request.url === `/_services/entity-grid-data.json/${SITE}`);
  assert.equal(listRequests.length, 2, 'paging continues after the handler error');
});

// @test-kind contract: a failed list configuration is not kept: the next search asks for it again and loads the rows, and another failure shows the error view again.
test('a modern list asks again for a configuration that failed', async () => {
  const { window, requests } = browser();
  const { body, messages, element } = modernListPage(window, LIST_COLUMNS);
  const search = new StubElement('input');
  element.queries['[data-pp-modern-list-search]'] = search;
  let configurationAnswers = 0;
  window.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/_layout/tokenhtml')) return new Response('<input value="tok">');
    if (String(url).startsWith('/_services/portal/GetListViewConfiguration/'))
      return ++configurationAnswers === 2
        ? listConfiguration(window, url)
        : new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ MoreRecords: false, Records: [LIST_RECORD] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  const [list] = $pages.currentPage.lists.getAll();
  const errorShown = () => messages.find((message) => message.matches('.view-error')).hidden === false;
  const enter = async () => {
    search.value = '';
    for (const listener of search.listeners.get('keydown') ?? []) listener({ key: 'Enter', preventDefault() {} });
    await list.__loadMore();
  };
  await list.__loadMore();
  assert.equal(errorShown(), true);
  assert.equal(body.children.length, 0);
  await enter();
  assert.equal(configurationAnswers, 2);
  assert.equal(body.children.length, 1);
  assert.equal(errorShown(), false);
});

// @test-kind contract: a list response that cannot be read shows the list error view and is logged with console.error.
test('a list response that is not JSON shows the list error view and is logged', async () => {
  const { window, logs } = browser();
  window.fetch = async (url) =>
    listConfiguration(window, url) ??
    (String(url).endsWith('/_layout/tokenhtml') ? new Response('<input value="tok">') : new Response('not json'));
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
    const configuration = listConfiguration(window, url);
    if (configuration) return configuration;
    return new Response(JSON.stringify({ Records: [], MoreRecords: false }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const $pages = await window.Microsoft.PowerPages.onPagesClientApiReady();
  await flush();
  // The toolbar is drawn from the list's configuration, read before its first page.
  const [list] = $pages.currentPage.lists.getAll();
  await list.__loadMore();
  const control = actions.children[0];
  assert.equal(control?.textContent, 'Download');
  for (const listener of control.listeners.get('click') ?? []) listener({ stopPropagation() {} });
  await flush();
  const download = requests.find((request) => request.url.includes('/_services/download-as-csv/'));
  assert.ok(download, 'the download request is sent');
  assert.deepEqual(JSON.parse(download.init.body).columns, columns);
  assert.equal(JSON.parse(download.init.body).viewName, 'Active Items', 'the export is named for the current view');
  assert.equal(window.assigned, `/_services/download-as-csv/${SITE}?key=key-1`);
});
