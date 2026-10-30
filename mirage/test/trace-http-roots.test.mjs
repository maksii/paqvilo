// @test-kind contract+security: Paqvilo's tracing and activity design (docs/design/tracing.md); redaction keeps secrets, tokens and keys out of traces
// HTTP root spans (docs/design/tracing.md): a Power Pages request opens an `http` root with the render, template and read
// spans under it; a portal Web API write nests a `webapi` span; browser follow-ups join the page's trace through the
// audit parent header; the audit entry links to its root span; the standalone host and the Dataverse API listener open
// roots of their own origin; the trace routes are listed and the `trace` SSE channel delivers frames.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable, finished } from 'node:stream';
import { createSimulator } from '../api.mjs';
import { AuditLog } from '../lib/audit-log.mjs';
import { sseClients, traceSessionKey } from '../lib/trace-hosts.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { createAzuriteStorage } from '../lib/storage-azurite.mjs';
import { createSharePointFixtureServer } from '../lib/sharepoint-contract.mjs';
import { startAzuriteFake, FAKE_ACCOUNT_KEY } from '../testing/azurite-fake.mjs';
import { drainFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { personaFixture } from './fixtures/persona-catalog.mjs';
import { endedTree as ended } from './support/trace-scenario.mjs';

const CLIENT = '99999999-9999-4999-8999-999999999981';
const portalFiles = {
  'website.yml': 'adx_websiteid: site\nadx_name: Invented tracing',
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
  'Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main',
  'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'Main.webtemplate.source.html': "<main>{% include 'Inner' %}</main>",
  'Inner.webtemplate.yml': 'adx_webtemplateid: inner\nadx_name: Inner',
  'Inner.webtemplate.source.html':
    '{% fetchxml rows %}<fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch>{% endfetchxml %}<p id="count">{{ rows.results.entities.size }}</p>',
  'NotFound.webpage.yml':
    'adx_webpageid: notfound\nadx_name: Page Not Found\nadx_partialurl: page-not-found\nadx_parentpageid: home\nadx_pagetemplateid: main',
  'sitemarker.yml': '- adx_sitemarkerid: m-404\n  adx_name: Page Not Found\n  adx_pageid: notfound',
  'Detail.webpage.yml':
    'adx_webpageid: detail\nadx_name: Detail\nadx_partialurl: detail\nadx_parentpageid: home\nadx_pagetemplateid: detail',
  'Detail.pagetemplate.yml': 'adx_pagetemplateid: detail\nadx_name: Detail\nadx_webtemplateid: detail',
  'Detail.webtemplate.yml': 'adx_webtemplateid: detail\nadx_name: Detail',
  'Detail.webtemplate.source.html':
    '{% assign one = entities.x_item[request.params.id] %}<p id="one">{{ one.x_name }}</p>',
  'sitesetting.yml':
    '- adx_sitesettingid: s1\n  adx_name: Webapi/x_item/enabled\n  adx_value: "true"\n- adx_sitesettingid: s2\n  adx_name: Webapi/x_item/fields\n  adx_value: x_name',
  'webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
};
const initial = () => ({
  version: 1,
  mappings: {
    x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name' },
    contact: { entitySet: 'contacts', idColumn: 'contactid' },
  },
  tables: {
    x_item: [
      { x_itemid: '11111111-1111-4111-8111-111111111111', x_name: 'First' },
      { x_itemid: '22222222-2222-4222-8222-222222222222', x_name: 'Second' },
    ],
    contact: [{ contactid: '44444444-4444-4444-8444-444444444444', fullname: 'Invented member', statecode: 0 }],
  },
  permissions: [],
  settings: { permissionMode: 'permissive' },
  simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
});

const closers = [],
  removers = [];
after(async () => {
  await drainFixture(closers);
  await drainFixture(removers);
});
async function directory(prefix) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), prefix));
  removers.push(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
let portalHost, standaloneHost;
const powerPages = () =>
  (portalHost ??= (async () => {
    const root = await directory('trace-roots-portal-');
    for (const [name, content] of Object.entries(portalFiles)) await fs.writeFile(path.join(root, name), content);
    const sim = await createSimulator({
      sourceDir: root,
      stateFile: path.join(root, 'state.json'),
      port: 0,
      watch: false,
      initial: initial(),
      trace: { level: 'full' },
    });
    closers.push(() => sim.close());
    return sim;
  })());
const standalone = () =>
  (standaloneHost ??= (async () => {
    const root = await directory('trace-roots-standalone-');
    const solution = path.join(root, 'solution', 'Other');
    await fs.mkdir(solution, { recursive: true });
    await fs.writeFile(
      path.join(solution, 'Solution.xml'),
      '<ImportExportXml><SolutionManifest><UniqueName>InventedTracing</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    );
    const sim = await createSimulator({
      runtime: { kind: 'dataverse-api' },
      solutionRoots: [path.join(root, 'solution')],
      projectRoot: root,
      port: 0,
      watch: false,
      simulation: { level: 'dry-run' },
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
      // An environment-variable secret whose variable is never set: resolving it is a refused (missing) secret span.
      secrets: { 'fx-vault/func-key': { variable: 'PAQVILO_TRACE_TEST_NEVER_SET' } },
    });
    closers.push(() => sim.close());
    return sim;
  })());

// Resolves with the first ended span matching the filters (the store's span-end event, or at once when it ended).
function endedSpan(trace, filters) {
  const find = () => trace.spans({ ...filters, order: 'asc' }).items.find((span) => span.status !== 'running');
  return new Promise((resolve) => {
    let off = () => {};
    const check = () => {
      const span = find();
      if (!span) return;
      off();
      resolve(span);
    };
    off = trace.subscribe((event) => {
      if (event.type === 'span-end') check();
    });
    check();
  });
}
// The `trace` frames of an SSE response, read from its body: next(predicate) resolves with the first later frame that
// matches, and the stream ending first fails the read; close() cancels the body (which closes the connection).
function traceFrames(response) {
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(predicate) {
      for (;;) {
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = /^event: trace\ndata: (.*)$/m.exec(raw)?.[1];
          const event = data ? JSON.parse(data) : null;
          if (event && predicate(event)) return event;
        }
        const { value, done } = await reader.read();
        assert.equal(done, false, 'the trace stream stays open');
        buffer += decoder.decode(value, { stream: true });
      }
    },
    close: () => reader.cancel().catch(() => {}),
  };
}
// Reads one trace through the stream: the page's trace id must be known and the trace ended in the store (its own
// trace-end event) before the frames are read, so every frame the reads wait for has already been written.
async function streamedTrace(sim, frames, response) {
  const traceId = response.headers.get('x-trace-id');
  assert.ok(traceId, 'the response names its trace');
  await ended(sim.trace, traceId);
  const started = await frames.next((event) => event.type === 'span-start' && event.span.traceId === traceId);
  const end = await frames.next((event) => event.type === 'trace-end' && event.span.traceId === traceId);
  return { started, end };
}
const simApi = (sim, method, suffix, payload) =>
  fetch(sim.url + '/_sim/api' + suffix, {
    method,
    headers: { 'x-sim-csrf': sim.csrf, ...(payload ? { 'content-type': 'application/json' } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });

test('Power Pages: a page GET is an http root with render, render-template and read spans; the audit entry links to it', async () => {
  const sim = await powerPages();
  const page = await fetch(sim.url + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<p id="count">2<\/p>/);
  const auditId = page.headers.get('x-sim-trace-id'),
    traceId = page.headers.get('x-trace-id'),
    spanId = page.headers.get('x-sim-span-id');
  assert.ok(auditId && traceId && spanId);
  assert.notEqual(auditId, spanId, 'X-Sim-Trace-Id keeps naming the audit entry');
  const tree = await ended(sim.trace, traceId);
  const byId = new Map(tree.spans.map((span) => [span.spanId, span]));
  const root = byId.get(spanId);
  assert.deepEqual(
    [root.kind, root.name, root.module, root.operation, root.parentSpanId, root.status],
    ['http', 'GET /', 'portal', 'get', null, 'ok'],
  );
  assert.deepEqual(root.origin, { host: 'power-pages', portal: 'Invented tracing', preset: null });
  assert.equal(root.actor.kind, 'anonymous');
  assert.deepEqual([root.attributes.kindHint, root.attributes.statusCode], ['page', 200]);
  const render = tree.spans.find((span) => span.kind === 'render');
  assert.equal(render.parentSpanId, root.spanId);
  const read = tree.spans.find((span) => span.kind === 'read');
  // A Liquid FetchXML read is a retrievemultiple whose source names it (D-R3-9); level full captures the rows read.
  assert.deepEqual(
    [read.entity, read.operation, read.attributes.rowCount, read.attributes.source, read.attributes.query],
    ['x_item', 'retrievemultiple', 2, 'liquid-fetchxml', 'fetchxml'],
  );
  assert.deepEqual(
    read.output.entities.map((row) => row.x_name),
    ['First', 'Second'],
  );
  // read → render-template (Inner) → render-template (Main) → render → http
  const chain = sim.trace.ancestry(read.spanId).map((span) => span.kind);
  assert.deepEqual(chain, ['http', 'render', 'render-template', 'render-template', 'read']);
  assert.match(byId.get(read.parentSpanId).name, /Inner/);
  assert.match(read.input, /<entity name="x_item">/, 'level full captures the query');
  assert.deepEqual(
    tree.spans.filter((span) => span.kind === 'store'),
    [],
    'the Liquid read span covers its store read',
  );
  const audit = await (await simApi(sim, 'GET', '/audit?pageSize=100')).json();
  const entry = audit.items.find((item) => item.id === auditId);
  assert.deepEqual([entry.traceId, entry.spanId], [traceId, spanId]);
  const fetchEntry = audit.items.find((item) => item.kind === 'liquid-fetchxml' && item.parentId === auditId);
  assert.equal(fetchEntry.traceId, traceId);
});

test('Power Pages: a /_api POST is http → webapi; follow-ups with the audit parent header join the page trace', async () => {
  const sim = await powerPages();
  const page = await fetch(sim.url + '/');
  await page.text();
  const auditId = page.headers.get('x-sim-trace-id'),
    traceId = page.headers.get('x-trace-id'),
    pageSpan = page.headers.get('x-sim-span-id');
  await ended(sim.trace, traceId);
  // The browser runtime forwards the page's audit id and its trace id.
  const created = await fetch(sim.url + '/_api/x_items', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      __requestverificationtoken: sim.csrf,
      'x-sim-parent-trace': auditId,
      'x-sim-trace-id': traceId,
    },
    body: JSON.stringify({ x_name: 'Third' }),
  });
  assert.equal(created.status, 204, await created.text());
  assert.equal(created.headers.get('x-trace-id'), traceId);
  const apiRoot = sim.trace.span(created.headers.get('x-sim-span-id'));
  assert.deepEqual([apiRoot.kind, apiRoot.parentSpanId, apiRoot.attributes.kindHint], ['http', pageSpan, 'api']);
  const webapi = await endedSpan(sim.trace, { traceId, kind: 'webapi' });
  assert.deepEqual(
    [webapi.parentSpanId, webapi.name, webapi.module, webapi.operation, webapi.entity, webapi.status],
    [apiRoot.spanId, 'POST x_items', 'webapi', 'create', 'x_item', 'ok'],
  );
  assert.equal(webapi.attributes.target, 'collection');
  assert.match(webapi.attributes.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(webapi.output, { status: 204, id: webapi.attributes.id });
  assert.deepEqual(webapi.input, { x_name: 'Third' }, 'level full captures the parsed body');
  // A legacy client sends only the audit id: the root still joins the page's trace under the page's root span.
  const legacy = await fetch(sim.url + '/_api/x_items?$select=x_name', { headers: { 'x-sim-parent-trace': auditId } });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('x-trace-id'), traceId);
  const read = await endedSpan(sim.trace, { traceId, kind: 'webapi', operation: 'retrievemultiple' });
  assert.equal(read.attributes.rowCount, 3);
  // A client that echoes the response headers back verbatim (X-Sim-Trace-Id is the audit id) joins under the page root,
  // as does one that echoes only X-Sim-Trace-Id; trace-store headers (span id and trace id) name the parent span itself.
  const parentOf = async (headers) => {
    const response = await fetch(sim.url + '/_api/x_items?$select=x_name', { headers });
    assert.equal(response.status, 200);
    await response.text();
    return [response.headers.get('x-trace-id'), sim.trace.span(response.headers.get('x-sim-span-id')).parentSpanId];
  };
  assert.deepEqual(await parentOf({ 'x-sim-trace-id': auditId, 'x-trace-id': traceId, 'x-sim-span-id': pageSpan }), [
    traceId,
    pageSpan,
  ]);
  assert.deepEqual(await parentOf({ 'x-sim-trace-id': auditId }), [traceId, pageSpan]);
  assert.deepEqual(await parentOf({ 'x-sim-parent-trace': apiRoot.spanId, 'x-trace-id': traceId }), [
    traceId,
    apiRoot.spanId,
  ]);
  // A request without trace headers is a new trace.
  const fresh = await fetch(sim.url + '/');
  await fresh.text();
  assert.notEqual(fresh.headers.get('x-trace-id'), traceId);
});

test('Power Pages: a Web API request refused before routing has no webapi span; its http root records the status and code', async () => {
  const sim = await powerPages();
  const post = (headers) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  const refusals = [
    [post({}), '/_api/x_items', 401, 'denied', 'MissingPortalRequestVerificationToken'],
    [post({ __requestverificationtoken: 'wrong' }), '/_api/x_items', 403, 'denied', 'HttpAntiForgeryException'],
    [{}, '/_api/x_unknowns', 400, 'error', 'UnknownEntitySet'],
    [{}, '/_api/x_items?$top=1&$top=2', 400, 'error', 'DuplicateQueryOption'],
  ];
  for (const [init, suffix, statusCode, status, code] of refusals) {
    const response = await fetch(sim.url + suffix, init);
    assert.equal(response.status, statusCode, suffix);
    await response.text();
    const tree = await ended(sim.trace, response.headers.get('x-trace-id'));
    assert.deepEqual(
      tree.spans.map((span) => [span.kind, span.status, span.attributes.statusCode, span.error?.code]),
      [['http', status, statusCode, code]],
      suffix,
    );
  }
});

test('Power Pages: status lists /trace, the trace routes answer and the trace SSE channel delivers frames', async () => {
  const sim = await powerPages();
  const status = await (await simApi(sim, 'GET', '/status')).json();
  assert.ok(status.routes.includes('/trace'), status.routes.join(','));
  assert.deepEqual(status.eventChannels, ['logs', 'trace']);
  const stream = await fetch(sim.url + '/_sim/events?channels=trace');
  assert.equal(stream.status, 200);
  const frames = traceFrames(stream);
  try {
    // The connected frame is written once the channel observes the store: every later span event reaches the stream.
    assert.equal((await frames.next((event) => event.type === 'connected')).status.level, 'full');
    const page = await fetch(sim.url + '/');
    assert.equal(page.status, 200);
    await page.text();
    const { started, end } = await streamedTrace(sim, frames, page);
    assert.equal(started.span.kind, 'http');
    assert.equal(end.trace.root.spanId, page.headers.get('x-sim-span-id'));
  } finally {
    await frames.close();
  }
  const listed = await (await simApi(sim, 'GET', '/trace?kind=render')).json();
  assert.ok(listed.items.length >= 1);
  // The dashboard map shows the trace layer with its level, linking to the trace view; its retention is activity.trace.
  const dashboard = await (await simApi(sim, 'GET', '/dashboard')).json();
  const layer = dashboard.nodes.find((node) => node.id === 'org:trace');
  const { retained, dropped } = sim.trace.status();
  assert.deepEqual(
    [
      layer.kind,
      layer.status,
      layer.link,
      layer.detail,
      dashboard.activity.trace.retained,
      dashboard.activity.trace.dropped,
    ],
    ['org', 'ready', '#activity', { level: 'full', persist: false, persistError: null }, retained, dropped],
  );
});

test('standalone: /_sim/events streams the trace channel with the Power Pages frames and refuses other channels', async () => {
  const sim = await standalone();
  const status = await (await simApi(sim, 'GET', '/status')).json();
  assert.deepEqual(status.eventChannels, ['trace']);
  const refused = await fetch(sim.url + '/_sim/events?channels=logs');
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'UnsupportedEventChannel');
  const stream = await fetch(sim.url + '/_sim/events?channels=trace');
  assert.deepEqual([stream.status, stream.headers.get('content-type')], [200, 'text/event-stream']);
  const frames = traceFrames(stream);
  try {
    assert.equal((await frames.next((event) => event.type === 'connected')).status.enabled, true);
    const home = await fetch(sim.url + '/', { redirect: 'manual' });
    assert.equal(home.status, 302);
    await home.arrayBuffer();
    const { started, end } = await streamedTrace(sim, frames, home);
    assert.deepEqual([started.span.kind, started.span.origin.host], ['http', 'standalone']);
    assert.equal(end.trace.root.spanId, home.headers.get('x-sim-span-id'));
  } finally {
    await frames.close();
  }
});

test('standalone and Dataverse API listener: http roots carry their origin host; the listener records the caller', async () => {
  const sim = await standalone();
  const status = await (await simApi(sim, 'GET', '/status')).json();
  assert.ok(status.routes.includes('/trace'));
  const home = await fetch(sim.url + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  const root = sim.trace.span(home.headers.get('x-sim-span-id'));
  assert.deepEqual(
    [root.kind, root.name, root.origin.host, root.attributes.routeFamily],
    ['http', 'GET /', 'standalone', 'root'],
  );
  await endedSpan(sim.trace, { traceId: root.traceId, kind: 'http' });
  // Administration traffic opens no span.
  assert.equal(sim.trace.spans({ search: '/_sim/api/status' }).total, 0);
  const { secret } = await (
    await simApi(sim, 'POST', '/dataverse/applications', {
      appId: CLIENT,
      displayName: 'Invented tracing client',
      roles: ['System Administrator'],
    })
  ).json();
  const token = await (
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    })
  ).json();
  const issued = await endedSpan(sim.trace, { host: 'dataverse-api', search: 'oauth2' });
  assert.deepEqual([issued.attributes.kind, issued.attributes.grant], ['sts', 'client_credentials']);
  assert.equal(JSON.stringify(issued).includes(secret), false, 'the client secret never reaches a span');
  const whoAmI = await fetch(sim.dataverse.origin + '/api/data/v9.2/WhoAmI', {
    headers: { authorization: `Bearer ${token.access_token}`, 'x-ms-client-request-id': 'invented-client-request' },
  });
  assert.equal(whoAmI.status, 200);
  const span = await endedSpan(sim.trace, { host: 'dataverse-api', search: 'WhoAmI' });
  assert.deepEqual(
    [span.kind, span.module, span.operation, span.status, span.parentSpanId],
    ['http', 'dataverse', 'get', 'ok', null],
  );
  assert.deepEqual(
    [span.attributes.kind, span.attributes.actorKind, span.attributes.appId, span.attributes.clientRequestId],
    ['data', 'app', CLIENT, 'invented-client-request'],
  );
  assert.match(span.attributes.actorId, /^[0-9a-f-]{36}$/);
  assert.deepEqual([span.actor.kind, span.actor.id], ['app', span.attributes.actorId], 'the root takes the caller');
  assert.equal(sim.trace.spans({ kind: 'http', actorKind: 'app', actorId: span.actor.id, search: 'WhoAmI' }).total, 1);
  assert.match(span.attributes.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(JSON.stringify(span).includes(token.access_token), false, 'the bearer token never reaches a span');
  // The listener's request ring names each request's trace (D-M-4).
  const { requests } = await (await simApi(sim, 'GET', '/dataverse/requests')).json();
  const ringed = requests.findLast((entry) => entry.path === '/api/data/v9.2/WhoAmI');
  assert.deepEqual([ringed.traceId, ringed.spanId], [span.traceId, span.spanId]);
  assert.equal(whoAmI.headers.get('x-trace-id'), ringed.traceId);
  const denied = await fetch(sim.dataverse.origin + '/api/data/v9.2/WhoAmI');
  assert.equal(denied.status, 401);
  const refused = sim.trace
    .spans({ host: 'dataverse-api', search: 'WhoAmI', status: 'denied' })
    .items.find((item) => item.attributes.statusCode === 401);
  assert.ok(refused ?? (await endedSpan(sim.trace, { host: 'dataverse-api', status: 'denied' })));
});

test('standalone: the runtime secret resolver records secret spans in the host trace store, never a value', async () => {
  const sim = await standalone();
  const answer = await sim.organization.api.secrets.resolve('https://fx-vault.vault.azure.net/secrets/func-key', {
    purpose: 'invented-trace-check',
  });
  assert.equal(answer.status, 'missing');
  const [span] = sim.trace.spans({ kind: 'secret' }).items;
  assert.deepEqual(
    [span.module, span.operation, span.status, span.attributes.key, span.attributes.purpose, span.error.code],
    ['secrets', 'resolve', 'error', 'fx-vault/func-key', 'invented-trace-check', 'SECRET_MISSING'],
  );
  assert.equal('output' in span, false, 'a secret span holds no value');
});

// A dry-run model-driven runtime over an invented solution, with the Dataverse listener on and TDS off.
async function modelDriven(prefix) {
  const root = await directory(prefix);
  const solution = path.join(root, 'solution', 'Other');
  await fs.mkdir(solution, { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedTracing</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  closers.push(() => sim.close());
  return sim;
}

test('model-driven: the in-process Web API transport nests its http span under the standalone request root', async () => {
  const sim = await modelDriven('trace-roots-model-');
  const response = await fetch(sim.url + '/_apps/api/webapi', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ method: 'GET', path: '/api/data/v9.2/WhoAmI' }),
  });
  assert.equal(response.status, 200);
  await response.text();
  const outer = sim.trace.span(response.headers.get('x-sim-span-id'));
  const inner = await endedSpan(sim.trace, { traceId: outer.traceId, host: 'dataverse-api' });
  assert.deepEqual([inner.kind, inner.parentSpanId, inner.attributes.actorKind], ['http', outer.spanId, 'staff']);
});

test('AuditLog.byId finds retained entries in constant time and forgets evicted and cleared ones', () => {
  const audit = new AuditLog({ limit: 2 });
  const first = audit.begin({ kind: 'page', path: '/', traceId: 'trace-a', spanId: 'span-a' });
  const second = audit.begin({ kind: 'page', path: '/' });
  assert.deepEqual([audit.byId(first.id).traceId, audit.byId(first.id).spanId], ['trace-a', 'span-a']);
  assert.deepEqual([audit.byId(second.id).traceId, audit.byId(second.id).spanId], [null, null]);
  audit.begin({ kind: 'page', path: '/' });
  assert.equal(audit.byId(first.id), null, 'the evicted entry is gone from the index');
  assert.equal(audit.byId(second.id).id, second.id);
  assert.equal(audit.list().items[0].traceId, null, 'list items carry the link fields');
  audit.clear();
  assert.equal(audit.byId(second.id), null);
  assert.equal(audit.byId(undefined), null);
});

// A Dataverse application token of the standalone listener (client credentials).
async function appToken(sim, appId) {
  const { secret } = await (
    await simApi(sim, 'POST', '/dataverse/applications', {
      appId,
      displayName: 'Invented tracing client',
      roles: ['System Administrator'],
    })
  ).json();
  const issued = await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: secret,
      scope: sim.dataverse.origin + '/.default',
    }),
  });
  return (await issued.json()).access_token;
}

test('Power Pages: the root session key is contact:<id> signed in, else visitor:<id> with a visitor cookie, else null', async () => {
  const sim = await powerPages();
  const visitorId = '33333333-3333-4333-8333-333333333333',
    contact = '44444444-4444-4444-8444-444444444444';
  const visitorCookie = `paqvilo-mirage-visitor-${new URL(sim.url).port}=${visitorId}`;
  const sessionOf = async (cookie) => {
    const response = await fetch(sim.url + '/_api/x_items?$select=x_name', cookie ? { headers: { cookie } } : {});
    assert.equal(response.status, 200);
    await response.text();
    return (await ended(sim.trace, response.headers.get('x-trace-id'))).root.session;
  };
  assert.deepEqual(await sessionOf(null), { visitorId: null, sessionKey: null });
  assert.deepEqual(await sessionOf(visitorCookie), { visitorId, sessionKey: `visitor:${visitorId}` });
  const signedIn = `${sim.signIn(contact).cookieHeader}; ${visitorCookie}`;
  assert.deepEqual(await sessionOf(signedIn), { visitorId, sessionKey: `contact:${contact}` });
  assert.equal(sim.trace.query({ sessionKey: `contact:${contact}` }).total, 1);
  assert.deepEqual(
    [traceSessionKey(null, null), traceSessionKey('c1', 'v1'), traceSessionKey(null, 'v1')],
    [null, 'contact:c1', 'visitor:v1'],
  );
});

test('Power Pages: follow-ups into a full trace keep its trace id (no span id, no new trace); malformed ids start a new trace', async () => {
  const sim = await powerPages();
  const settings = sim.trace.settings();
  sim.trace.configure({ spansPerTrace: 50 });
  try {
    const first = await fetch(sim.url + '/_api/x_items?$select=x_name');
    await first.text();
    const traceId = first.headers.get('x-trace-id');
    const join = { 'x-trace-id': traceId, 'x-sim-parent-trace': first.headers.get('x-sim-span-id') };
    const followUp = async () => {
      const response = await fetch(sim.url + '/_api/x_items?$select=x_name', { headers: join });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(response.headers.get('x-trace-id'), traceId, 'every follow-up names the trace');
      return response.headers.get('x-sim-span-id');
    };
    // Each recorded follow-up adds spans; the first one the full trace refuses answers with its trace id only.
    let refused = false;
    for (let call = 0; call < 50 && !refused; call++) refused = (await followUp()) === null;
    assert.ok(refused, 'the trace filled up');
    const before = (await ended(sim.trace, traceId)).trace;
    const retained = sim.trace.status().retained;
    assert.equal(await followUp(), null);
    const after = (await ended(sim.trace, traceId)).trace;
    assert.equal(after.spanCount, 50);
    assert.ok(after.droppedSpans > before.droppedSpans, 'the refused root and its children count as dropped');
    assert.equal(sim.trace.status().retained, retained, 'a refused request starts no orphan trace');
    // Only what fromHeaders accepts is honoured: route-name ids are not trace or span ids.
    const spoofed = await fetch(sim.url + '/', { headers: { 'x-trace-id': 'export', 'x-sim-parent-trace': 'clear' } });
    await spoofed.text();
    assert.match(spoofed.headers.get('x-trace-id'), /^[0-9a-f-]{36}$/);
    assert.equal(sim.trace.span(spoofed.headers.get('x-sim-span-id')).parentSpanId, null);
  } finally {
    sim.trace.configure(settings);
  }
});

test('standalone and Dataverse listener roots are anonymous until auth whatever parent the headers name; listener responses name their trace', async () => {
  const sim = await standalone();
  const token = await appToken(sim, '99999999-9999-4999-8999-999999999982');
  const whoAmI = await fetch(sim.dataverse.origin + '/api/data/v9.2/WhoAmI', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(whoAmI.status, 200);
  await whoAmI.text();
  const traceId = whoAmI.headers.get('x-trace-id'),
    spanId = whoAmI.headers.get('x-sim-span-id');
  assert.ok(traceId && spanId, 'the listener response names its trace and root span');
  const caller = await endedSpan(sim.trace, { traceId, host: 'dataverse-api' });
  assert.deepEqual([caller.spanId, caller.actor.kind], [spanId, 'app']);
  // A request that names the authenticated caller's span as its parent nests under it but never takes its actor.
  const join = { 'x-trace-id': traceId, 'x-sim-parent-trace': spanId };
  const home = await fetch(sim.url + '/', { redirect: 'manual', headers: join });
  await home.arrayBuffer();
  const root = sim.trace.span(home.headers.get('x-sim-span-id'));
  assert.deepEqual(
    [root.traceId, root.parentSpanId, root.origin.host, root.actor.kind, root.actor.id, root.session],
    [traceId, spanId, 'standalone', 'anonymous', null, { visitorId: null, sessionKey: null }],
  );
  const refused = await fetch(sim.dataverse.origin + '/api/data/v9.2/WhoAmI', {
    headers: { ...join, origin: 'http://invented-client.test' },
  });
  assert.equal(refused.status, 401);
  await refused.text();
  assert.equal(refused.headers.get('x-trace-id'), traceId);
  const anonymous = sim.trace.span(refused.headers.get('x-sim-span-id'));
  assert.deepEqual(
    [anonymous.parentSpanId, anonymous.actor.kind, anonymous.actor.id, anonymous.session.sessionKey],
    [spanId, 'anonymous', null, null],
  );
  // A cross-origin client can read both names.
  assert.match(refused.headers.get('access-control-expose-headers'), /X-Trace-Id, X-Sim-Span-Id/);
});

test('model-driven: a destroyed in-process Web API response ends the listener http span (499)', async () => {
  const sim = await modelDriven('trace-roots-destroy-');
  // An answer whose body and error both refuse to serialize: the handler's last resort is res.destroy().
  const poison = new Proxy(
    {},
    {
      get() {
        throw poison;
      },
      ownKeys() {
        throw poison;
      },
    },
  );
  sim.organization.api.addRoute(
    (pathname) => pathname === '/api/data/v9.2/x_destroyed',
    () => ({ status: 200, body: poison }),
    { anonymous: true },
  );
  const response = await fetch(sim.url + '/_apps/api/webapi', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ method: 'GET', path: '/api/data/v9.2/x_destroyed' }),
  });
  assert.notEqual(response.status, 200);
  await response.text();
  const outer = sim.trace.span(response.headers.get('x-sim-span-id'));
  const tree = await ended(sim.trace, outer.traceId);
  const inner = tree.spans.find((span) => span.origin.host === 'dataverse-api');
  assert.deepEqual(
    [inner.parentSpanId, inner.status, inner.attributes.statusCode, typeof inner.durationMs],
    [outer.spanId, 'error', 499, 'number'],
  );
});

test('a persona runtime records into its parent trace store and follows its run-time settings', async (t) => {
  const { app, call } = await personaFixture(t, { trace: { level: 'summary' } });
  const { response, value: persona } = await call('/personas/launch', 'POST', { personaKey: 'person-2' });
  assert.equal(response.status, 200, JSON.stringify(persona));
  assert.equal(persona.isolated, true);
  app.trace.configure({ level: 'full' });
  const page = await fetch(persona.url, { headers: { cookie: persona.cookieHeader } });
  await page.text();
  const traceId = page.headers.get('x-trace-id');
  assert.ok(traceId, 'the persona runtime traces its requests');
  const tree = await ended(app.trace, traceId);
  assert.deepEqual(
    [tree.root.kind, tree.root.origin.host, tree.root.session.sessionKey],
    ['http', 'power-pages', `contact:${persona.contactId}`],
  );
  const settings = await (await fetch(persona.origin + '/_sim/api/trace/settings')).json();
  assert.equal(settings.settings.level, 'full', 'one store: the parent change applies to the persona runtime');
});

test('SSE clients: a closed response never joins, a closing one leaves, a client that takes nothing past the stall limit while the loop is free is dropped', async () => {
  let clock = 0;
  const checks = [];
  const clients = sseClients({ now: () => clock, stallMs: 5000, defer: (fn) => checks.push(fn) });
  const accepting = () =>
    new Writable({
      write(chunk, encoding, done) {
        done();
      },
    });
  const closed = accepting();
  closed.destroy();
  assert.equal(clients.add(closed), false, 'a response that closed while the host awaited is never registered');
  const live = accepting(),
    leaving = accepting(),
    // highWaterMark 1 and a write that never completes: every write returns false.
    stalled = new Writable({ highWaterMark: 1, write() {} });
  for (const res of [live, leaving, stalled]) assert.equal(clients.add(res), true);
  leaving.destroy();
  await new Promise((resolve) => finished(leaving, () => resolve()));
  assert.deepEqual([...clients], [live, stalled], 'stream.finished removes a client that closes');
  clients.send('event: log\ndata: 1\n\n');
  clients.send('event: log\ndata: 2\n\n');
  clients.send('event: log\ndata: 3\n\n');
  clock = 5001;
  clients.send('event: log\ndata: 4\n\n');
  assert.equal(clients.size, 2, 'sending never drops a client, however long the burst');
  checks.splice(0).forEach((fn) => fn()); // the loop is free: the stalled reader took nothing past the limit
  assert.deepEqual([...clients], [live]);
  assert.equal(stalled.destroyed, true, 'the dropped client is destroyed');
  clients.end();
  assert.deepEqual([clients.size, live.writableEnded], [0, true]);
});

test('a memory-only runtime accepts persist but writes nothing and says why on the dashboard map', async () => {
  const sim = await standalone();
  const settings = sim.trace.settings();
  try {
    sim.trace.configure({ persist: true });
    const { persist } = sim.trace.status();
    assert.deepEqual([persist.enabled, persist.directory, persist.lastError], [true, null, 'NoStateDirectory']);
    const dashboard = await (await simApi(sim, 'GET', '/dashboard')).json();
    const layer = dashboard.nodes.find((node) => node.id === 'org:trace');
    assert.deepEqual([layer.detail.persist, layer.detail.persistError], [true, 'NoStateDirectory']);
    assert.deepEqual(Object.keys(dashboard.activity.trace), [
      'retained',
      'spans',
      'running',
      'dropped',
      'droppedSpans',
      'latestSequence',
    ]);
  } finally {
    sim.trace.configure(settings);
  }
});

test('Power Pages: an entity read is a retrieve naming its record; the root records the query with secret values hidden', async () => {
  const sim = await powerPages();
  const id = '11111111-1111-4111-8111-111111111111';
  const page = await fetch(`${sim.url}/detail/?id=${id}&code=invented-function-key`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<p id="one">First<\/p>/);
  const tree = await ended(sim.trace, page.headers.get('x-trace-id'));
  // Summary attributes name the query (secret-named values hidden); level full keeps the parameters as input.
  assert.equal(tree.root.attributes.query, `id=${id}&code=[redacted]`);
  assert.deepEqual(tree.root.input, { query: { id, code: '[redacted]' } });
  const read = tree.spans.find((span) => span.kind === 'read');
  assert.deepEqual(
    [read.operation, read.entity, read.recordId, read.attributes.source, read.attributes.rowCount],
    ['retrieve', 'x_item', id, 'entity-read', 1],
  );
  assert.equal(read.output.x_name, 'First', 'level full captures the row read');
  assert.equal(
    sim.trace.query({ recordId: id }).items[0]?.traceId,
    tree.trace.traceId,
    'the record id finds the trace',
  );
});

test('Power Pages: a request root captures its body and content type; an answered error names its code and message', async () => {
  const sim = await powerPages();
  const created = await fetch(sim.url + '/_api/x_items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', __requestverificationtoken: sim.csrf },
    body: JSON.stringify({ x_name: 'Body capture' }),
  });
  assert.equal(created.status, 204, await created.text());
  const tree = await ended(sim.trace, created.headers.get('x-trace-id'));
  assert.deepEqual(tree.root.input, { contentType: 'application/json', body: { x_name: 'Body capture' } });
  assert.deepEqual(
    [tree.root.attributes.contentType, tree.root.attributes.contentLength],
    ['application/json', JSON.stringify({ x_name: 'Body capture' }).length],
  );
  // The created row names the webapi span's record (D-R3-1).
  const webapi = tree.spans.find((span) => span.kind === 'webapi');
  assert.equal(webapi.recordId, webapi.attributes.id);
  // An error page the router answers itself (a page that does not exist) names the route's code on its root.
  const missing = await fetch(sim.url + '/no-such-page/');
  assert.equal(missing.status, 404);
  await missing.text();
  const notFound = (await ended(sim.trace, missing.headers.get('x-trace-id'))).root;
  assert.deepEqual([notFound.status, notFound.error?.status], ['error', 404]);
  assert.ok(notFound.error.code && notFound.error.code !== 'Http404', JSON.stringify(notFound.error));
  assert.match(notFound.error.message, /no-such-page|Page Not Found/);
});

test('Power Pages: an anonymous first page GET starts the visitor session, so every visitor has a visitor session key', async () => {
  const sim = await powerPages();
  const first = await fetch(sim.url + '/');
  await first.text();
  const cookie = first.headers.getSetCookie().find((line) => line.startsWith('paqvilo-mirage-visitor-'));
  assert.ok(cookie, 'the first anonymous page GET sets the visitor cookie');
  const pair = cookie.split(';')[0],
    visitorId = pair.split('=')[1];
  const firstRoot = (await ended(sim.trace, first.headers.get('x-trace-id'))).root;
  assert.deepEqual(firstRoot.session, { visitorId, sessionKey: `visitor:${visitorId}` });
  // The browser sends it back: the same visitor, no new cookie.
  const again = await fetch(sim.url + '/', { headers: { cookie: pair } });
  await again.text();
  assert.equal(
    again.headers.getSetCookie().some((line) => line.startsWith('paqvilo-mirage-visitor-')),
    false,
  );
  assert.equal((await ended(sim.trace, again.headers.get('x-trace-id'))).root.session.visitorId, visitorId);
  // Two anonymous browsers are two visitors.
  const other = await fetch(sim.url + '/');
  await other.text();
  const otherRoot = (await ended(sim.trace, other.headers.get('x-trace-id'))).root;
  assert.notEqual(otherRoot.session.visitorId, visitorId);
  assert.match(otherRoot.session.sessionKey, /^visitor:[0-9a-f-]{36}$/);
  // A signed-in member is named by the contact and gets no visitor cookie.
  const member = await fetch(sim.url + '/', {
    headers: { cookie: sim.signIn('44444444-4444-4444-8444-444444444444').cookieHeader },
  });
  await member.text();
  assert.equal(
    member.headers.getSetCookie().some((line) => line.startsWith('paqvilo-mirage-visitor-')),
    false,
  );
});

test('Power Pages: at level off a root parses no trace header and looks up no audit entry for it', async () => {
  const sim = await powerPages();
  const named = '55555555-5555-4555-8555-555555555555';
  const original = AuditLog.prototype.byId;
  const looked = [];
  AuditLog.prototype.byId = function (id) {
    looked.push(id);
    return original.call(this, id);
  };
  try {
    await sim.trace.configure({ level: 'off' });
    const off = await fetch(sim.url + '/_api/x_items?$select=x_name', { headers: { 'x-sim-trace-id': named } });
    assert.equal(off.status, 200);
    await off.text();
    assert.equal(off.headers.get('x-trace-id'), null);
    assert.equal(looked.includes(named), false, 'level off: the trace header names no audit lookup');
    await sim.trace.configure({ level: 'full' });
    const on = await fetch(sim.url + '/_api/x_items?$select=x_name', { headers: { 'x-sim-trace-id': named } });
    await on.text();
    assert.equal(looked.includes(named), true, 'with tracing on the header is looked up as an audit id');
    assert.notEqual(on.headers.get('x-trace-id'), named, 'an unknown audit id is never used as the trace id (D-M-4)');
  } finally {
    AuditLog.prototype.byId = original;
    await sim.trace.configure({ level: 'full' });
  }
});

test('Power Pages: a page path with a file suffix that reaches the Liquid renderer has its http root', async () => {
  const sim = await powerPages();
  const response = await fetch(sim.url + '/missing-report.json');
  await response.text();
  const traceId = response.headers.get('x-trace-id');
  assert.ok(traceId, 'the rendered answer names its trace');
  const tree = await ended(sim.trace, traceId);
  assert.deepEqual(
    [tree.root.kind, tree.root.name, tree.root.parentSpanId],
    ['http', 'GET /missing-report.json', null],
  );
  assert.equal(tree.spans.find((span) => span.kind === 'render')?.parentSpanId, tree.root.spanId);
  assert.equal(tree.root.attributes.statusCode, response.status);
});

test('Power Pages: a /_sim administration write is a sim root acting as the simulator; reads open none', async () => {
  const sim = await powerPages();
  const write = await fetch(sim.url + '/_sim/api/session/sign-out', {
    method: 'POST',
    headers: { 'x-sim-csrf': sim.csrf, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(write.status, 200, await write.text());
  const traceId = write.headers.get('x-trace-id');
  assert.ok(traceId, 'the administration write names its trace');
  const root = (await ended(sim.trace, traceId)).root;
  assert.deepEqual(
    [root.kind, root.module, root.origin.host, root.actor.kind, root.actor.name, root.attributes.routeFamily],
    ['http', 'sim', 'sim', 'system', 'simulator', '__sim'],
  );
  const read = await fetch(sim.url + '/_sim/api/status');
  await read.text();
  assert.equal(read.headers.get('x-trace-id'), null, 'an administration read opens no root');
});

test('Azurite Blob requests are http-out spans of the current trace without their bytes; a refused key names the Azure code', async (t) => {
  const traces = createTraceStore({ settings: { level: 'full' } });
  const fake = await startAzuriteFake();
  t.after(() => fake.close());
  const storage = (key = FAKE_ACCOUNT_KEY) =>
    createAzuriteStorage({
      id: 'fxblob',
      settings: { connectionString: 'env:FX_AZURITE', container: 'fx-trace' },
      env: { FX_AZURITE: `AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=${fake.blobEndpoint}` },
      traces: () => traces,
    });
  const bytes = 'invented blob bytes for the trace';
  const parent = traces.start({ kind: 'http', name: 'POST /upload' });
  await traces.run(parent, () => storage().put('docs/a.txt', Buffer.from(bytes), { contentType: 'text/plain' }));
  parent.end();
  const calls = traces.spans({ kind: 'http-out', module: 'storage', order: 'asc' }).items;
  assert.ok(calls.length >= 2, calls.map((span) => span.name).join(', '));
  for (const span of calls) {
    assert.deepEqual([span.parentSpanId, span.status, span.attributes.provider], [parent.spanId, 'ok', 'fxblob']);
    assert.deepEqual([Object.hasOwn(span, 'input'), Object.hasOwn(span, 'output')], [false, false], 'no blob bytes');
  }
  assert.ok(calls.some((span) => span.attributes.bytes === bytes.length && span.operation === 'put'));
  assert.equal(JSON.stringify(traces.export({})).includes(bytes), false);
  // The signed request still verifies with the forwarded trace headers: the blob is stored.
  assert.equal((await storage().head('docs/a.txt'))?.size, bytes.length);
  // A wrong account key is refused by the endpoint: the span names the status.
  const refused = traces.start({ kind: 'http', name: 'POST /refused' });
  await traces
    .run(refused, () =>
      storage(Buffer.from('fx-wrong-key-0000000000000000000').toString('base64')).put('docs/b.txt', Buffer.from('x')),
    )
    .catch(() => {});
  refused.end();
  const failed = traces.spans({ kind: 'http-out', parentSpanId: refused.spanId }).items;
  assert.ok(failed.length > 0);
  assert.deepEqual([failed[0].status, failed[0].error?.status], ['denied', 403]);
});

test('the SharePoint fixture server opens a root per request joined to its caller, naming the Graph error', async (t) => {
  const traces = createTraceStore({ settings: { level: 'summary' } });
  const fixture = await createSharePointFixtureServer({
    traces,
    fixtures: {
      sites: { 'site-a': { name: 'Invented site' } },
      drives: { 'drive-a': { siteId: 'site-a' } },
      items: [{ driveId: 'drive-a', path: 'x_case/notes.txt', content: 'hello', contentType: 'text/plain' }],
    },
  });
  t.after(() => fixture.close());
  const caller = traces.start({ kind: 'http-out', name: 'GET children' });
  const listed = await fetch(`${fixture.url}/v1.0/sites/site-a/drives/drive-a/root:/x_case:/children`, {
    headers: traces.headers(caller),
  });
  assert.equal(listed.status, 200);
  await listed.text();
  caller.end();
  const root = traces.span(listed.headers.get('x-sim-span-id'));
  assert.deepEqual(
    [root.kind, root.module, root.origin.host, root.parentSpanId, root.traceId, root.status],
    ['http', 'sharepoint', 'sharepoint', caller.spanId, caller.traceId, 'ok'],
  );
  const missing = await fetch(`${fixture.url}/v1.0/sites/site-a/drives/drive-a/root:/x_case/none:/children`);
  assert.equal(missing.status, 404);
  await missing.text();
  const refused = traces.span(missing.headers.get('x-sim-span-id'));
  assert.deepEqual([refused.parentSpanId, refused.status, refused.error?.code], [null, 'error', 'itemNotFound']);
});
