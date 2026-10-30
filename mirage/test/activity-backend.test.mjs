// The Activity backend (D-M-4, docs/design/tracing.md "Monitor"): the audit <-> trace link both ways, X-Sim-Trace-Id as
// an audit id only, findings and request rings that name their trace, render sources, the trace channel's server-side
// event filter, and the activity export bundle.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { codeAppsWorkbenchHtml } from '../lib/code-apps-workbench.mjs';
import { drainFixture } from '../testing/owned-fixture.mjs';
import { monitorPortal, monitorState, startMonitorRuntime } from './support/monitor-runtime.mjs';
import { endedTree, runTraceScenario } from './support/trace-scenario.mjs';

const UNKNOWN = '0badc0de-0000-4000-8000-000000000001';
const closers = [];
after(() => drainFixture(closers));
let host;
const runtime = () =>
  (host ??= startMonitorRuntime(closers, {
    prefix: 'activity-backend-',
    files: monitorPortal({
      name: 'Invented activity',
      source: "<main>{% include 'Inner' %}</main>",
      extra: {
        'Inner.webtemplate.yml': 'adx_webtemplateid: inner\nadx_name: Inner',
        'Inner.webtemplate.source.html':
          '\n{% fetchxml rows %}<fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch>{% endfetchxml %}<p id="count">{{ rows.results.entities.size }}</p>',
      },
    }),
    state: monitorState({ rows: [{ x_itemid: '11111111-1111-4111-8111-111111111111', x_name: 'First' }] }),
  }));
// One page GET, ended: { response, auditId, traceId, tree }.
async function page(sim, pathname = '/', headers = {}) {
  const response = await fetch(sim.url + pathname, { headers });
  await response.text();
  const traceId = response.headers.get('x-trace-id');
  return {
    response,
    auditId: response.headers.get('x-sim-trace-id'),
    traceId,
    tree: await endedTree(sim.trace, traceId),
  };
}

test('an audited request and its trace name each other; a Liquid read entry names its own read span', async () => {
  const { sim, client } = await runtime();
  const { auditId, traceId, tree } = await page(sim);
  assert.equal(tree.root.attributes.auditId, auditId, 'the root span names its audit entry');
  assert.equal(tree.trace.auditId, auditId, 'the trace summary exposes it');
  assert.deepEqual(
    (await client.trace.query({ auditId })).items.map((item) => item.traceId),
    [traceId],
    '/trace?auditId= finds the trace',
  );
  const entries = (await client.audit({ traceId, pageSize: 100 })).items;
  const pageEntry = entries.find((entry) => entry.id === auditId);
  assert.deepEqual([pageEntry.traceId, pageEntry.spanId], [traceId, tree.root.spanId]);
  const readEntry = entries.find((entry) => entry.kind === 'liquid-fetchxml');
  const read = tree.spans.find((span) => span.kind === 'read');
  assert.equal(readEntry.spanId, read.spanId, 'the read entry names its own read span, not the page root');
  assert.equal(read.attributes.auditId, readEntry.id, 'the read span names its entry');
  assert.deepEqual(
    (await client.trace.spans({ auditId: readEntry.id })).items.map((span) => span.spanId),
    [read.spanId],
  );
  assert.deepEqual(
    (await client.trace.query({ auditId: readEntry.id })).items.map((item) => item.traceId),
    [traceId],
    "a read's audit id finds its page trace",
  );
  assert.ok(
    entries.every((entry) => entry.traceId === traceId),
    'the audit traceId filter keeps one trace',
  );
  // DV-N4-2: the entity set name and the logical name find the same audit entries and spans.
  const api = await fetch(sim.url + '/_api/x_items?$select=x_name');
  await api.text();
  await endedTree(sim.trace, api.headers.get('x-trace-id'));
  const ids = (items) => items.map((item) => item.id ?? item.spanId).sort();
  const bySet = (await client.audit({ entity: 'x_items', pageSize: 100 })).items;
  assert.ok(bySet.some((entry) => entry.kind === 'api') && bySet.some((entry) => entry.kind === 'liquid-fetchxml'));
  assert.deepEqual(ids(bySet), ids((await client.audit({ entity: 'x_item', pageSize: 100 })).items));
  assert.deepEqual(ids((await client.audit({ table: 'X_ITEMS', pageSize: 100 })).items), ids(bySet));
  const spansBySet = (await client.trace.spans({ entity: 'x_items', pageSize: 200 })).items;
  assert.ok(spansBySet.length > 0 && spansBySet.every((span) => span.entity === 'x_item'));
  assert.deepEqual(ids(spansBySet), ids((await client.trace.spans({ table: 'x_item', pageSize: 200 })).items));
  // One call joins the audit entries of several activities (connectRuntime().audit takes the list as an array).
  const second = await page(sim, '/no-such-joined-page');
  const joined = (await client.audit({ traceId: [traceId, second.traceId], pageSize: 100 })).items;
  assert.deepEqual([...new Set(joined.map((entry) => entry.traceId))].sort(), [traceId, second.traceId].sort());
  const tooMany = await fetch(
    `${sim.url}/_sim/api/audit?traceId=${Array.from({ length: 201 }, (_, index) => `t${index}`).join(',')}`,
  );
  assert.equal(tooMany.status, 400);
  assert.equal((await tooMany.json()).error.code, 'InvalidAuditFilter');
  // result= filters activities by their result server-side (the totals count it); status= keeps matching any step.
  const failed = await client.trace.query({ result: 'error,denied', pageSize: 200 });
  assert.ok(failed.items.some((item) => item.traceId === second.traceId));
  assert.ok(failed.items.every((item) => ['error', 'denied'].includes(item.status)));
  assert.equal(failed.total, failed.items.length);
  assert.ok((await client.trace.query({ result: 'ok', pageSize: 200 })).items.some((item) => item.traceId === traceId));
  const refusedResult = await fetch(`${sim.url}/_sim/api/trace?result=broken`);
  assert.deepEqual([refusedResult.status, (await refusedResult.json()).error.parameter], [400, 'result']);
});

test('audit entries name the browser session: visitorId and sessionKey, filtered with the id prefix rule', async () => {
  const { sim, client } = await runtime();
  // The first anonymous page GET starts the visitor session; the browser sends its cookie from then on.
  const first = await fetch(sim.url + '/');
  await first.text();
  const cookie = first.headers.getSetCookie().find((line) => line.startsWith('paqvilo-mirage-visitor-'));
  assert.ok(cookie, 'an anonymous page GET starts a visitor session');
  const visit = await page(sim, '/', { cookie: cookie.split(';', 1)[0] });
  const visitorId = visit.tree.root.session.visitorId;
  assert.ok(visitorId);
  const entries = (await client.audit({ traceId: visit.traceId, pageSize: 100 })).items;
  assert.ok(entries.length >= 2, 'the page and its Liquid read');
  for (const entry of entries)
    assert.deepEqual([entry.visitorId, entry.sessionKey], [visitorId, `visitor:${visitorId}`], entry.kind);
  const byPrefix = (await client.audit({ sessionKey: `visitor:${visitorId.slice(0, 8)}`, pageSize: 100 })).items;
  assert.ok(byPrefix.some((entry) => entry.id === visit.auditId));
  assert.ok((await client.audit({ visitorId, pageSize: 100 })).items.some((entry) => entry.id === visit.auditId));
  assert.equal((await client.audit({ visitorId: visitorId.slice(0, 7), pageSize: 100 })).total, 0);
});

test('X-Sim-Trace-Id is an audit id: it joins the audited root; an unknown one is never a trace id', async () => {
  const { sim } = await runtime();
  const first = await page(sim);
  // The Web API call echoes only X-Sim-Trace-Id: it joins under the page root.
  const echoed = await fetch(sim.url + '/_api/x_items?$select=x_name', {
    headers: { 'x-sim-trace-id': first.auditId },
  });
  await echoed.text();
  const joined = await endedTree(sim.trace, echoed.headers.get('x-trace-id'));
  assert.equal(joined.trace.traceId, first.traceId);
  const api = joined.spans.find((span) => span.spanId === echoed.headers.get('x-sim-span-id'));
  assert.equal(api.parentSpanId, first.tree.root.spanId);
  // A UUID that names no audit entry starts a new trace with an id of its own.
  const unknown = await fetch(sim.url + '/_api/x_items?$select=x_name', { headers: { 'x-sim-trace-id': UNKNOWN } });
  await unknown.text();
  const fresh = unknown.headers.get('x-trace-id');
  assert.notEqual(fresh, UNKNOWN);
  assert.equal((await endedTree(sim.trace, fresh)).root.parentSpanId, null);
});

test('a request-time finding and the portal request ring name their trace; a load finding names none', async () => {
  const { sim, client } = await runtime();
  const missing = await page(sim, '/no-such-page');
  assert.equal(missing.response.status, 404);
  const { diagnostics, requests } = await client.diagnostics({ traceId: missing.traceId });
  const finding = diagnostics.find((item) => item.code === 'UNMAPPED_RESOURCE');
  assert.ok(finding, JSON.stringify(diagnostics));
  assert.equal(finding.traceId, missing.traceId);
  assert.ok(finding.spanId, 'the finding names the span it was raised in');
  assert.deepEqual(
    requests.map((item) => [item.path, item.traceId]),
    [['/no-such-page', missing.traceId]],
  );
  const all = (await client.diagnostics()).diagnostics;
  assert.ok(
    all.some((item) => !('traceId' in item)),
    'load and source findings carry no trace',
  );
  const dashboard = await (await fetch(sim.url + '/_sim/api/dashboard')).json();
  assert.ok(dashboard.activity.requests.recent.some((item) => item.traceId === missing.traceId));
});

test('runtime links name the Monitor addresses directly: #home, #activity, never #overview, #trace or #audit', async () => {
  const { sim } = await runtime();
  const { nodes } = await (await fetch(sim.url + '/_sim/api/dashboard')).json();
  const link = (id) => nodes.find((node) => node.id === id)?.link;
  assert.equal(link('host:portal'), '#home');
  assert.equal(link('org:trace'), '#activity');
  const old = nodes.filter((node) =>
    /^#(?:overview|trace|audit|logs|evidence|dashboard)(?:[?/]|$)/.test(node.link ?? ''),
  );
  assert.deepEqual(old, []);
  const workbench = codeAppsWorkbenchHtml();
  assert.match(workbench, /<a href="\/_sim\/#activity\?host=code-app">Activity<\/a>/);
  assert.equal(workbench.includes('#audit'), false);
});

test('step, trigger, connector and action findings carry a name, their table and a sentence beside their ids', async () => {
  // The end-to-end scenario: an order create runs an async plug-in step, a row-triggered flow with connector actions.
  const run = await runTraceScenario({ level: 'summary' });
  closers.unshift(() => run.close());
  const { diagnostics } = await (await fetch(run.sim.url + '/_sim/api/diagnostics')).json();
  const first = (code) => diagnostics.find((item) => item.code === code);
  const facts = (code) => {
    const finding = first(code);
    assert.ok(finding, `${code} in ${[...new Set(diagnostics.map((item) => item.code))].join(', ')}`);
    return finding;
  };
  const step = facts('PLUGIN_ASYNC_COMPLETED');
  assert.deepEqual([step.name, step.entity], ['Order async follow-up', 'x_order']);
  assert.ok(step.stepId, 'the ids stay');
  assert.match(step.message, /^Order async follow-up completed on x_order/);
  const trigger = facts('FLOW_TRIGGER_COMPLETED');
  assert.deepEqual([trigger.name, trigger.entity], ['When an order is created', 'x_order']);
  assert.ok(trigger.operationKey);
  const connector = facts('CONNECTOR_INVOKE');
  assert.ok(connector.name && connector.message && connector.connectorId, JSON.stringify(connector));
  const action = facts('FLOW_ACTION');
  assert.ok(action.name && action.message && action.action === action.name, JSON.stringify(action));
});

test('render sources resolve a render-template sourceRefId to its exported file and line', async () => {
  const { sim, client } = await runtime();
  const { tree } = await page(sim);
  const inner = tree.spans.find((span) => span.kind === 'render-template' && /inner/i.test(span.name));
  assert.ok(inner?.attributes.sourceRefId, tree.spans.map((span) => span.name).join(', '));
  const response = await fetch(
    `${sim.url}/_sim/api/render-sources?refs=${inner.attributes.sourceRefId},not-a-known-ref`,
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.missing, ['not-a-known-ref']);
  const [item] = body.items;
  assert.deepEqual(
    [item.id, item.path, item.line, item.kind, item.name],
    [inner.attributes.sourceRefId, 'Inner.webtemplate.source.html', 1, 'webtemplate', 'Inner'],
  );
  assert.equal(path.resolve(item.file), path.resolve(await fs.realpath(path.join(body.sourceDir, item.path))));
  const refused = await fetch(`${sim.url}/_sim/api/render-sources`);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'InvalidRenderSourceRefs');
  assert.ok((await client.status()).routes.includes('/render-sources'));
});

// Reads `event: trace` frames from an SSE response until stop(frames) is true.
async function frames(response, stop) {
  const seen = [];
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = /^event: trace\ndata: (.*)$/m.exec(frame);
      if (data) seen.push(JSON.parse(data[1]));
    }
    if (stop(seen)) break;
  }
  return seen;
}

test('simulator.trace.subscribe takes the same events and traceId as connectRuntime().trace.subscribe', async () => {
  const { sim } = await runtime();
  const seen = [];
  // The request names its trace (X-Trace-Id), so the listener is attached before any of its frames exist.
  const traceId = '5ab5c41b-0000-4000-8000-000000000001';
  const stop = sim.trace.subscribe((event) => seen.push([event.type, event.span.traceId, 'input' in event.span]), {
    events: ['span-end', 'trace-end'],
    traceId,
    payloads: false,
  });
  const response = await fetch(sim.url + '/', { headers: { 'x-trace-id': traceId } });
  await response.text();
  assert.equal(response.headers.get('x-trace-id'), traceId);
  await endedTree(sim.trace, traceId);
  // Another request while the listener is attached: none of its frames reach it.
  const other = await page(sim);
  stop();
  assert.ok(seen.length > 0);
  assert.ok(seen.every(([type, id, input]) => type !== 'span-start' && id === traceId && input === false));
  assert.ok(seen.some(([type]) => type === 'trace-end'));
  assert.ok(!seen.some(([, id]) => id === other.traceId));
});

test('the trace channel filters frames in the store: events=trace-end sends trace ends only', async () => {
  const { sim } = await runtime();
  const controller = new AbortController();
  const response = await fetch(`${sim.url}/_sim/events?channels=trace&events=trace-end`, { signal: controller.signal });
  let connected;
  const read = frames(response, (seen) => {
    if (seen.length === 1 && !connected) connected = seen[0];
    return seen.some((frame) => frame.type === 'trace-end');
  });
  // The page is requested once the stream is connected (the connected frame is written on attach).
  const ready = (async () => {
    while (!connected) await new Promise((resolve) => setImmediate(resolve));
    await page(sim);
  })();
  const seen = await read;
  controller.abort();
  await ready;
  assert.deepEqual(connected.events, ['trace-end']);
  assert.deepEqual(
    [...new Set(seen.slice(1).map((frame) => frame.type))],
    ['trace-end'],
    'no span-start or span-end frame reaches this client',
  );
  assert.ok('auditId' in seen.at(-1).trace, 'trace-end frames carry the summary with auditId');
  const invalid = await frames(await fetch(`${sim.url}/_sim/events?channels=trace&events=span-done`), () => false);
  assert.deepEqual(
    invalid.map((frame) => [frame.type, frame.error?.parameter]),
    [['error', 'events']],
  );
});

test('the activity export bundle holds the activity, its audit entries, log lines and findings, and the runtime', async () => {
  const { sim, client } = await runtime();
  const missing = await page(sim, '/bundle-missing');
  const documents = await client.exportBundle({ traceId: missing.traceId });
  const kinds = documents.map((document) => document.kind);
  assert.equal(kinds[0], 'bundle');
  assert.equal(kinds.at(-1), 'end');
  const [header] = documents;
  assert.equal(header.schemaVersion, 1);
  assert.equal(header.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(header.filters, { traceId: missing.traceId, format: 'bundle' });
  assert.equal(header.runtime.host, 'power-pages');
  assert.ok(header.runtime.sourceFingerprint && Number.isInteger(header.runtime.revision));
  const activities = documents.filter((document) => document.kind === 'activity');
  assert.deepEqual(
    activities.map((document) => document.trace.traceId),
    [missing.traceId],
  );
  const audit = documents.filter((document) => document.kind === 'audit');
  assert.deepEqual(
    audit.map((document) => document.entry.id),
    [missing.auditId],
  );
  const logs = documents.filter((document) => document.kind === 'log');
  assert.ok(logs.length > 0 && logs.every((document) => document.line.traceId === missing.traceId));
  const findings = documents.filter((document) => document.kind === 'finding');
  assert.ok(findings.some((document) => document.diagnostic.code === 'UNMAPPED_RESOURCE'));
  assert.ok(!logs.some((document) => document.line.type === 'startup'), 'a trace filter keeps uncorrelated lines out');
  assert.deepEqual(documents.at(-1).counts, {
    activities: 1,
    audit: 1,
    logs: logs.length,
    findings: findings.length,
    evidence: 0,
  });
  // A time-only filter also takes the uncorrelated startup lines of the range; traces=otlp writes one OTLP document.
  const otlp = await client.exportBundle({ from: 0, traces: 'otlp' });
  assert.ok(otlp.some((document) => document.kind === 'log' && document.line.type === 'startup'));
  const [resource] = otlp.find((document) => document.kind === 'otlp').resourceSpans;
  assert.ok(resource.scopeSpans[0].spans.length > 0);
  assert.equal(otlp.filter((document) => document.kind === 'activity').length, 0);
  const refused = await fetch(`${sim.url}/_sim/api/activity/export?traceId=${missing.traceId}`);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, 'InvalidActivityExport');
  const badFilter = await fetch(`${sim.url}/_sim/api/activity/export?format=bundle&status=nope`);
  assert.equal((await badFilter.json()).error.code, 'InvalidTraceFilter');
});
