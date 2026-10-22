import test from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../admin/ui-kit.mjs';
import { layoutTopology, renderTopology, renderDashboard, renderNodeDetail, isActive, isoTime, nodeKey, COLUMNS } from '../admin/dashboard-view.mjs';
import { HELP } from '../admin/help-content.mjs';

const ids = [
  'client:browser', 'client:staff', 'client:api', 'client:lense',
  'host:portal', 'host:model-driven', 'host:dataverse-api', 'host:tds', 'host:identity-provider', 'host:setup', 'host:admin', 'app:canvas', 'app:code', 'persona-runtime:fx-1',
  'org:store', 'org:security', 'org:plugins', 'org:workflows', 'org:flows', 'org:jobs', 'org:fx-rollup',
  'provider:storage', 'provider:storage-route:annotations', 'provider:messaging', 'provider:messaging-endpoint:fx-queue', 'provider:outbox', 'provider:connectors',
  'connection:fx-http', 'provider:secrets', 'provider:local-service:functions', 'provider:service-fixture:powerBi', 'provider:powerfx',
  'external:azurite', 'external:servicebus-emulator', 'external:functions', 'external:keyvault', 'bridge:live',
];
const statuses = ['listening', 'ready', 'declared', 'disabled', 'placeholder', 'missing', 'error'];
const nodes = ids.map((id, index) => ({ id, kind: id.split(':')[0], label: index === 3 ? '<script>alert(1)</script>' : `Invented ${id}`, status: statuses[index % statuses.length], level: 'contract', detail: { port: index === 4 ? 5501 : undefined, count: index }, link: '#services' }));
const edges = [
  { from: 'client:browser', to: 'host:portal', kind: 'http', status: 'listening', label: 'pages' },
  { from: 'client:api', to: 'host:dataverse-api', kind: 'http', status: 'listening' },
  { from: 'host:portal', to: 'org:store', kind: 'reads', status: 'ready' },
  { from: 'org:store', to: 'org:plugins', kind: 'process', status: 'ready' },
  { from: 'org:store', to: 'provider:storage', kind: 'storage', status: 'ready' },
  { from: 'org:plugins', to: 'provider:messaging', kind: 'bus', status: 'ready' },
  { from: 'provider:storage', to: 'external:azurite', kind: 'storage', status: 'declared' },
  { from: 'provider:messaging', to: 'org:jobs', kind: 'process', status: 'ready' },
];
const activity = { requests: { total: 4, recent: [{ at: '2026-01-01T10:00:01.000Z', method: 'GET', path: '/x?<b>', status: 200, ms: 3 }] }, dataverseRequests: { total: 1, recent: [] }, plugins: { executions: 2, failures: 0 },
  flows: { running: 0, succeeded: 1, failed: 0, waiting: 0 }, jobs: { pending: 0, scheduled: 0, running: 0, failures: 0, poisoned: 0 }, messages: { active: 1, locked: 0, scheduled: 0, deadLettered: 0 },
  outbox: { queued: 0, delivered: 0, failed: 0 }, webhooks: { delivered: 0, failed: 0, notContacted: 0 }, storage: { byProvider: [{ id: 'local', writes: 1, deletes: 0, bytesWritten: 10 }] }, diagnostics: { total: 2, byCode: { FX_CODE: 2 } } };
const payload = { runtime: { product: 'Mirage', kind: 'power-pages', simulationLevel: 'dry-run', clock: 'system', revision: 7, localOrigin: 'http://localhost:5501', stateFile: '.paqvilo/state.json' }, nodes, edges, activity };
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const noUnsafeMarkup = html => {
  assert.doesNotMatch(html, /\sstyle=/i);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  assert.doesNotMatch(html, /<script/i);
};

test('layoutTopology places nodes in kind columns without overlapping boxes', () => {
  assert.ok(nodes.length >= 30);
  const layout = layoutTopology(nodes, edges);
  assert.equal(layout.nodes.length, nodes.length);
  const columnOf = Object.fromEntries(layout.nodes.map(node => [node.id, node.column]));
  assert.deepEqual([columnOf['client:api'], columnOf['host:tds'], columnOf['app:code'], columnOf['org:fx-rollup'], columnOf['connection:fx-http'], columnOf['external:keyvault'], columnOf['bridge:live']], ['client', 'host', 'host', 'org', 'provider', 'external', 'external']);
  const x = Object.fromEntries(layout.columns.map(column => [column.id, column.x]));
  assert.deepEqual(layout.columns.map(column => column.id), COLUMNS);
  assert.ok(x.client < x.host && x.host < x.org && x.org < x.provider && x.provider < x.external);
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++)
    assert.equal(overlaps(layout.nodes[i], layout.nodes[j]), false, `${layout.nodes[i].id} overlaps ${layout.nodes[j].id}`);
  for (const node of layout.nodes) assert.ok(node.x + node.w <= layout.width && node.y + node.h <= layout.height);
  const hosts = layout.nodes.filter(node => node.column === 'host').map(node => node.id);
  assert.deepEqual(hosts.slice(0, 2), ['host:portal', 'host:model-driven']);
  assert.equal(layout.edges.length, edges.length);
  assert.match(layout.edges[0].path, /^M [\d.]+ [\d.]+ C /);
  assert.equal(layoutTopology(nodes, [{ from: 'client:browser', to: 'nowhere', kind: 'http' }]).edges.length, 0);
});

test('renderTopology emits one focusable node per node and one edge per edge, escaped', () => {
  const html = renderTopology(layoutTopology(nodes, edges));
  assert.match(html, /<svg role="img" aria-labelledby="dashboard-topology-title dashboard-topology-desc" viewBox="0 0 \d+ \d+"/);
  assert.match(html, /<title id="dashboard-topology-title">Running system map<\/title><desc id="dashboard-topology-desc">37 components and 8 connections/);
  assert.equal(html.match(/<g class="ui-node is-[a-z]+" id="dashboard-topology-node-[A-Za-z0-9_-]+" data-node="/g).length, nodes.length);
  // Stable, unique ids (RU2-04): the poll re-render restores focus by id.
  assert.match(html, /id="dashboard-topology-node-host_3aportal" data-node="host:portal"/);
  assert.equal(new Set(html.match(/id="dashboard-topology-node-[^"]+"/g)).size, nodes.length);
  assert.notEqual(nodeKey('a:b'), nodeKey('a-b'));
  assert.equal(html.match(/ data-edge="/g).length, edges.length);
  assert.equal(html.match(/tabindex="0" role="button"/g).length, nodes.length);
  assert.ok(html.indexOf('data-edge=') < html.indexOf('data-node='), 'edges are drawn before nodes');
  assert.match(html, /data-node="host:portal" tabindex="0" role="button" aria-label="Invented host:portal: placeholder"/);
  assert.match(html, /data-edge="client:browser→host:portal"/);
  assert.match(html, /aria-label="&lt;script&gt;alert\(1\)&lt;\/script&gt;: disabled"/);
  assert.match(html, /<ul class="ui-legend"/);
  noUnsafeMarkup(html);
});

test('isActive follows counter deltas per edge kind and target', () => {
  const previous = structuredClone(activity);
  const next = structuredClone(activity);
  next.plugins.executions = 3;
  assert.equal(isActive(edges[3], next, previous), true, 'process edge into org:plugins');
  assert.equal(isActive(edges[7], next, previous), false, 'org:jobs counters did not move');
  assert.equal(isActive(edges[0], next, previous), false);
  next.requests.total = 5;
  assert.equal(isActive(edges[0], next, previous), true);
  next.storage.byProvider[0].bytesWritten = 20;
  assert.equal(isActive(edges[4], next, previous), true);
  assert.equal(isActive({ ...edges[4], status: 'disabled' }, next, previous), false);
  assert.equal(isActive(edges[0], next, undefined), false);
  next.messages.active = 2;
  assert.equal(isActive(edges[5], next, previous), true);
});

test('renderDashboard live mode composes header, tiles, map, feed, blocking form and summary', () => {
  const previousActivity = { ...structuredClone(activity), requests: { total: 3, recent: [] } };
  const html = renderDashboard(payload, { mode: 'live', kit, help: HELP, previousActivity, docs: {} });
  noUnsafeMarkup(html);
  assert.match(html, /data-dashboard-mode="live"/);
  assert.match(html, /<dt>Origin<\/dt><dd><code>http:\/\/localhost:5501<\/code><\/dd>/);
  assert.match(html, /class="ui-tiles"/);
  assert.match(html, /Plug-in runs/);
  assert.match(html, /Storage writes/);
  assert.match(html, /0 deletes · 10 bytes written/);
  assert.match(html, /class="ui-edge is-listening is-active" data-edge="client:browser→host:portal"/);
  assert.match(html, /<table class="ui-table" data-table="dashboard-activity">/);
  assert.match(html, /<code>\/x\?&lt;b&gt;<\/code>/);
  assert.match(html, /<code>FX_CODE<\/code>/);
  assert.match(html, /<form id="dashboard-preflight"/);
  assert.match(html, /<input id="dashboard-preflight-requires" name="requires"[^>]*aria-describedby="dashboard-preflight-requires-help"/);
  assert.match(html, /id="dashboard-preflight-strict" name="strict" type="checkbox"/);
  assert.match(html, /<div id="dashboard-preflight-result"><\/div>/);
  assert.match(html, /<dt>State file<\/dt><dd><code>.paqvilo\/state.json<\/code><\/dd>/);
  assert.match(html, /Invented host:portal <code>5501<\/code>/);
  assert.match(html, /data-ui-section="dashboard-configuration"(?! open)/);
  assert.throws(() => renderDashboard(payload, {}), /options\.kit/);
});

test('renderDashboard planned mode hides tiles and activity and says how to see live status', () => {
  const planned = renderDashboard({ runtime: { kind: 'model-driven', simulationLevel: 'dry-run' }, nodes: nodes.map(node => ({ ...node, status: node.id === 'host:tds' ? 'disabled' : 'planned' })), edges }, { mode: 'planned', kit, help: HELP });
  noUnsafeMarkup(planned);
  assert.match(planned, /Planned from configuration; start the preview to see live status/);
  assert.doesNotMatch(planned, /class="ui-tiles"/);
  assert.doesNotMatch(planned, /is-active/);
  assert.doesNotMatch(planned, /<form/);
  assert.match(planned, /Planned system map/);
  assert.match(planned, /<dt>State file<\/dt><dd>not known until start<\/dd>/);
  assert.match(planned, /data-node="host:tds" tabindex="0" role="button" aria-label="Invented host:tds: disabled"/);
});

test('renderNodeDetail shows facts, status, a safe view link and a doc reference', () => {
  const docs = { storage: { href: 'https://example.test/blob/main/mirage/docs/storage-providers.md', path: 'mirage/docs/storage-providers.md', label: 'Storage Providers' } };
  const html = renderNodeDetail({ id: 'provider:storage', kind: 'provider', label: '<b>Storage</b>', status: 'ready', level: 'behaviour', detail: { providers: [{ id: 'local', writes: 3, deletes: 1, bytesWritten: 30 }], routes: ['annotations'] }, link: '#services?panel=storage' }, docs, { kit });
  noUnsafeMarkup(html);
  assert.match(html, /<section class="ui-drawer" id="dashboard-drawer" tabindex="-1" data-node-detail="provider:storage"/);
  assert.match(html, /&lt;b&gt;Storage&lt;\/b&gt;/);
  assert.match(html, /<a class="ui-button" href="#services\?panel=storage">Open services<\/a>/);
  assert.match(html, /&quot;writes&quot;:3,&quot;deletes&quot;:1,&quot;bytesWritten&quot;:30/);
  assert.match(html, /<dt>routes<\/dt><dd class="ui-mono"><code>\[&quot;annotations&quot;\]<\/code><\/dd>/);
  assert.match(html, /href="https:\/\/example.test\/blob\/main\/mirage\/docs\/storage-providers.md"/);
  assert.doesNotMatch(renderNodeDetail({ id: 'x', status: 'ready', link: 'javascript:alert(1)' }, {}, { kit }), /javascript:/);
});

test('renderDashboard accepts a standalone payload without a reload revision', () => {
  const standalone = { ...payload, runtime: { ...payload.runtime, revision: null }, activity: { ...structuredClone(activity), reloads: null, inFlight: 0 } };
  const html = renderDashboard(standalone, { mode: 'live', kit, help: HELP, previousActivity: activity, docs: {} });
  noUnsafeMarkup(html);
  assert.match(html, /<dt>Revision<\/dt><dd>not reported<\/dd>/);
});

test('configuration summary prints pack and layer ids and port meanings (RU2-05)', () => {
  const html = renderDashboard({ ...payload, configuration: { packs: [{ id: 'invented-pack', module: 'pack/invented.mjs' }, 'plain-pack'], solutionLayers: [{ solution: 'InventedCore', version: '1.0.0.0' }, 'layers/extra'],
    settingsKeys: ['dataverse'], ports: { portal: 0, dataverseApi: null, admin: 5501 } } }, { mode: 'live', kit, help: HELP, docs: {} });
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.match(html, /<dt>Data packs<\/dt><dd><code>invented-pack<\/code> <code>plain-pack<\/code><\/dd>/);
  assert.match(html, /<dt>Solution layers<\/dt><dd><code>InventedCore 1\.0\.0\.0<\/code> <code>layers\/extra<\/code><\/dd>/);
  assert.match(html, /portal free port · dataverseApi not used · admin <code>5501<\/code>/);
  assert.match(renderDashboard({ ...payload, configuration: {} }, { mode: 'live', kit, help: HELP, docs: {} }), /<dt>Data packs<\/dt><dd>not reported<\/dd>/);
});

test('activity times accept epoch milliseconds or ISO text and sort newest first (RU2-06)', () => {
  assert.equal(isoTime(Date.UTC(2026, 0, 1, 10, 0, 2)), '2026-01-01T10:00:02.000Z');
  assert.equal(isoTime('2026-01-01T10:00:01.000Z'), '2026-01-01T10:00:01.000Z');
  assert.equal(isoTime(String(Date.UTC(2026, 0, 1))), '2026-01-01T00:00:00.000Z');
  assert.equal(isoTime(null), null);
  assert.equal(isoTime('not a time'), null);
  const mixed = { ...structuredClone(activity), requests: { total: 2, recent: [{ at: Date.UTC(2026, 0, 1, 10, 0, 3), method: 'GET', path: '/newest', status: 200 }, { at: 99, method: 'GET', path: '/epoch-start', status: 200 }] },
    dataverseRequests: { total: 1, recent: [{ at: '2026-01-01T10:00:02.000Z', method: 'GET', path: '/api/data/v9.2/x_items', status: 200 }] } };
  const html = renderDashboard({ ...payload, activity: mixed }, { mode: 'live', kit, help: HELP, docs: {} });
  const order = [...html.matchAll(/<code>(\/newest|\/api\/data\/v9\.2\/x_items|\/epoch-start)<\/code>/g)].map(match => match[1]);
  assert.deepEqual(order, ['/newest', '/api/data/v9.2/x_items', '/epoch-start']);
  assert.match(html, /<td>10:00:03<\/td>/);
  assert.match(html, /<td>00:00:00<\/td>/);
});
