// dashboard-map.mjs: layer layout, product mapping, connectors, highlight classes, KPI sparklines and safe markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as kit from '../admin/ui-kit.mjs';
import * as icons from '../admin/dashboard-icons.mjs';
import {
  layoutTopology,
  renderTopology,
  renderDashboard,
  renderNodeDetail,
  isActive,
  PRODUCT_OF,
  BANDS,
  GEOMETRY,
  HIGHLIGHT_LIMIT,
  KPIS,
  activitySeries,
  sparkValues,
  sparkline,
  factsOf,
  healthOf,
  gutterOf,
} from '../admin/dashboard-map.mjs';

const statuses = ['listening', 'ready', 'declared', 'disabled', 'placeholder', 'missing', 'error'];
const node = (id, index = 0, extra = {}) => ({
  id,
  kind: id.split(':')[0],
  label: `Invented ${index}`,
  status: statuses[index % statuses.length],
  detail: { count: index },
  link: '#services',
  ...extra,
});
function large() {
  const ids = [
    'client:browser',
    'client:staff',
    'client:api',
    'bridge:live',
    'host:portal',
    'host:model-driven',
    'app:canvas',
    'app:code',
    'app:pcf',
    'host:dataverse-api',
    'host:tds',
    'host:identity-provider',
    'host:admin',
    'host:setup',
    'org:store',
    'org:plugins',
    'org:flows',
    'org:jobs',
    'org:workflows',
    'org:dataverse-fls',
    'org:dataverse-rollup',
    'org:dataverse-addon-ai',
    'org:pack:fx-pack',
    'org:fx-unknown-module',
    'provider:storage',
    'provider:storage-route:annotations',
    'provider:messaging',
    'provider:messaging-endpoint:x-queue',
    'provider:outbox',
    'provider:connectors',
    'provider:secrets',
    'provider:powerfx',
    'provider:service-fixture:powerBi',
    'external:azurite',
    'external:servicebus-emulator',
    'external:keyvault',
  ];
  for (let i = 1; ids.length < 60; i++)
    ids.push(
      i % 3 === 0
        ? `persona-runtime:fx-${i}`
        : i % 3 === 1
          ? `external:webhook:hook${i}.example.test`
          : `connection:fx-conn-${i}`,
    );
  const nodes = ids.map((id, index) => node(id, index));
  const edges = [
    { from: 'client:browser', to: 'host:portal', kind: 'http', status: 'listening', label: 'pages' },
    { from: 'client:api', to: 'host:dataverse-api', kind: 'http', status: 'listening', label: 'Web API' },
    { from: 'host:portal', to: 'org:store', kind: 'process', status: 'ready', label: 'records' },
    { from: 'host:dataverse-api', to: 'org:store', kind: 'process', status: 'ready', label: 'records' },
    { from: 'org:store', to: 'org:plugins', kind: 'process', status: 'ready', label: 'pipeline' },
    { from: 'org:store', to: 'provider:storage', kind: 'storage', status: 'ready', label: 'files' },
    {
      from: 'provider:storage',
      to: 'provider:storage-route:annotations',
      kind: 'storage',
      status: 'ready',
      label: 'local',
    },
    { from: 'org:plugins', to: 'provider:messaging', kind: 'bus', status: 'ready', label: 'service endpoints' },
    {
      from: 'org:plugins',
      to: 'external:webhook:hook1.example.test',
      kind: 'webhook',
      status: 'declared',
      label: 'not contacted',
    },
    {
      from: 'provider:storage',
      to: 'external:azurite',
      kind: 'storage',
      status: 'declared',
      label: 'Blob REST (Shared Key)',
    },
    { from: 'host:portal', to: 'persona-runtime:fx-3', kind: 'process', status: 'listening', label: 'persona' },
    { from: 'org:store', to: 'fx:nowhere', kind: 'http', status: 'ready', label: 'dangling' },
  ];
  return { nodes, edges };
}
const activity = (step) => ({
  requests: { total: 10 + step * 3, recent: [] },
  dataverseRequests: { total: step * step, other: 1, failed: 0, recent: [] },
  plugins: { executions: step, failures: 0 },
  flows: { running: 0, succeeded: step, failed: 0, waiting: 0 },
  jobs: { pending: step % 3, running: 0, poisoned: 0 },
  messages: { active: step % 4, deadLettered: 0, entities: 1 },
  outbox: { queued: 0, delivered: step, failed: 0 },
  storage: { byProvider: [{ id: 'local', writes: step, deletes: 0, bytesWritten: step * 10 }] },
  diagnostics: { total: 2, byCode: { FX_CODE: 2 } },
});
const visibleText = (html) =>
  html
    .replace(/<title[\s\S]*?<\/title>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
const noUnsafeMarkup = (html) => {
  // Attribute names only: escaped hostile text inside quoted values or text may contain "onerror=" as plain characters.
  const tags = html.replace(/"[^"]*"/g, '""');
  assert.doesNotMatch(tags, /<[^>]*\sstyle=/i);
  assert.doesNotMatch(tags, /<[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /="javascript:/i);
};

test('layout puts every node in exactly one band and cards never overlap (60 nodes)', () => {
  const { nodes, edges } = large();
  assert.equal(nodes.length, 60);
  const layout = layoutTopology(nodes, edges);
  assert.equal(layout.bands.length, BANDS.length);
  const placed = layout.cards.flatMap((card) => card.nodes.map((item) => item.id));
  assert.deepEqual([...placed].sort(), nodes.map((item) => item.id).sort(), 'each node on exactly one card');
  for (const card of layout.cards)
    assert.ok(
      card.nodes.every((item) => item.band === card.band),
      'a card sits in its nodes band',
    );
  for (const item of layout.nodes)
    assert.ok(
      BANDS.some((band) => band.id === item.band),
      item.id,
    );
  const rect = (card) => ({ x: card.x, y: card.y, w: card.w, h: card.h });
  for (const [i, a] of layout.cards.entries())
    for (const b of layout.cards.slice(i + 1)) {
      const [p, q] = [rect(a), rect(b)];
      assert.ok(
        !(p.x < q.x + q.w - 1e-9 && q.x < p.x + p.w - 1e-9 && p.y < q.y + q.h && q.y < p.y + p.h),
        `cards ${a.index} and ${b.index} overlap`,
      );
    }
  // Bands stack top to bottom with the CSS geometry: each gutter is as high as the lanes its connectors need.
  for (const [index, band] of layout.bands.entries()) {
    assert.equal(
      band.h,
      GEOMETRY.padTop + band.rows * GEOMETRY.cardH + (band.rows - 1) * GEOMETRY.rowGap + GEOMETRY.padBottom,
    );
    if (index) assert.equal(band.y, layout.bands[index - 1].y + layout.bands[index - 1].h + gutterOf(band.gap));
  }
  // Grouped layers: organization modules and storage routes join capability cards.
  const org = layout.bands.find((band) => band.id === 'organization');
  assert.ok(
    org.cards.some(
      (card) => card.type === 'group' && card.group === 'logic' && card.nodes.some((item) => item.id === 'org:plugins'),
    ),
  );
  assert.ok(layout.cards.some((card) => card.type === 'group' && card.group === 'storage' && card.nodes.length === 2));
});

test('every drawn edge references existing cards; internal and dangling edges are dropped; upward edges are reversed', () => {
  const { nodes, edges } = large();
  const layout = layoutTopology(nodes, edges);
  assert.ok(layout.edges.length > 0);
  for (const edge of layout.edges) {
    assert.ok(layout.cards[edge.from] && layout.cards[edge.to], 'both ends exist');
    assert.ok(
      edge.members.every(
        (member) => nodes.some((item) => item.id === member.from) && nodes.some((item) => item.id === member.to),
      ),
    );
    assert.ok(edge.segments.length >= 1);
    for (const [a, b] of edge.segments) assert.ok(a[0] === b[0] || a[1] === b[1], 'orthogonal segments');
  }
  assert.ok(
    !layout.edges.some((edge) => edge.members.some((member) => member.to === 'fx:nowhere')),
    'dangling edge dropped',
  );
  assert.ok(
    !layout.edges.some((edge) => edge.members.some((member) => member.to === 'provider:storage-route:annotations')),
    'edge inside one group card is internal',
  );
  const persona = layout.edges.find((edge) => edge.members.some((member) => member.to === 'persona-runtime:fx-3'));
  assert.equal(persona.reversed, true, 'portal → persona session points up');
});

// Connectors as drawn: every segment of an edge, with the part hidden under its own end cards cut off.
const visibleSegments = (layout, edge) => {
  const ends = [layout.cards[edge.from], layout.cards[edge.to]];
  const inside = ([x, y], card) =>
    x > card.x + 1e-9 && x < card.x + card.w - 1e-9 && y > card.y + 1e-9 && y < card.y + card.h - 1e-9;
  return edge.segments.filter(([a, b]) => !ends.some((card) => inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], card)));
};
test('connectors never cross a card and never share a line with another connector', () => {
  const { nodes, edges } = large();
  const crowded = [
    ...edges,
    ...['provider:outbox', 'provider:connectors', 'provider:secrets', 'provider:powerfx'].map((to) => ({
      from: 'org:store',
      to,
      kind: 'process',
      status: 'ready',
      label: 'records',
    })),
    { from: 'org:flows', to: 'org:jobs', kind: 'process', status: 'ready', label: 'triggers' },
    { from: 'org:plugins', to: 'org:flows', kind: 'process', status: 'ready', label: 'post-commit' },
    { from: 'org:store', to: 'org:dataverse-solutions', kind: 'process', status: 'ready', label: 'pipeline' },
    { from: 'client:browser', to: 'org:store', kind: 'http', status: 'ready', label: 'far' },
    { from: 'org:flows', to: 'provider:connectors', kind: 'process', status: 'ready', label: 'actions' },
    { from: 'org:jobs', to: 'provider:outbox', kind: 'bus', status: 'ready', label: 'service endpoints' },
  ];
  const layout = layoutTopology(nodes, crowded);
  // A card is a box with its 12 px CSS margin inside its cell; at the narrowest wired card area (696 px) that is 0.0172 of the width.
  const margin = 12 / 696;
  for (const edge of layout.edges)
    for (const [a, b] of visibleSegments(layout, edge))
      for (const card of layout.cards) {
        if (card.index === edge.from || card.index === edge.to) continue;
        const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])],
          [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        const crosses = x1 < card.x + card.w - margin && x2 > card.x + margin && y1 < card.y + card.h && y2 > card.y;
        assert.ok(!crosses, `edge ${edge.members[0].from}→${edge.members[0].to} crosses card ${cardTitle(card)}`);
      }
  // Two connectors never run along the same line, except where they leave or enter the same card.
  const all = layout.edges.flatMap((edge) => visibleSegments(layout, edge).map((segment) => ({ edge, segment })));
  for (const [i, p] of all.entries())
    for (const q of all.slice(i + 1)) {
      if (p.edge === q.edge || p.edge.from === q.edge.from || p.edge.to === q.edge.to) continue;
      const [[a, b], [c, d]] = [p.segment, q.segment];
      const vertical =
        a[0] === b[0] &&
        c[0] === d[0] &&
        Math.abs(a[0] - c[0]) < 1e-9 &&
        Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1])) - Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) > 1;
      const horizontal =
        a[1] === b[1] &&
        c[1] === d[1] &&
        Math.abs(a[1] - c[1]) < 1e-9 &&
        Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) - Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) >
          1e-6;
      assert.ok(
        !vertical && !horizontal,
        `edges ${p.edge.members[0].from}→${p.edge.members[0].to} and ${q.edge.members[0].from}→${q.edge.members[0].to} share a line`,
      );
    }
  // Neighbours in one band join directly; an arrowhead always ends on a card edge or in a column gap.
  const pair = (from, to) =>
    layout.edges.find((edge) => edge.members.some((member) => member.from === from && member.to === to));
  assert.equal(pair('org:plugins', 'org:flows').segments.length, 2, 'logic → automate: one short arrow across the gap');
  assert.equal(pair('org:plugins', 'org:flows').arrowSegment, 0);
  assert.equal(pair('org:plugins', 'org:flows').labelAt, null, 'a connector inside a row carries no label on the map');
});
const cardTitle = (card) => (card.type === 'group' ? card.group : card.node.id);

test('switched-off connections are listed on their card, not drawn; one card fans out on a single bus lane', () => {
  const { nodes, edges } = large();
  const extra = [
    { from: 'client:staff', to: 'app:code', kind: 'http', status: 'disabled', label: 'staff session' },
    ...['org:plugins', 'org:flows', 'org:jobs', 'org:dataverse-fls'].map((to) => ({
      from: 'host:dataverse-api',
      to,
      kind: 'process',
      status: 'ready',
      label: 'Web API message',
    })),
  ];
  const layout = layoutTopology(nodes, [...edges, ...extra]);
  assert.ok(
    !layout.edges.some((edge) => edge.members.every((member) => member.status === 'disabled')),
    'no switched-off connection is drawn',
  );
  assert.match(renderTopology(layout), /<b>Switched off<\/b> would connect to Code apps\./);
  const api = layout.cards.find((card) => card.node?.id === 'host:dataverse-api');
  const bus = layout.edges.filter((edge) => edge.from === api.index && edge.plan.type === 'next');
  assert.ok(bus.length >= 3, 'the Web API reaches several organization cards');
  assert.equal(new Set(bus.map((edge) => edge.plan.lane)).size, 1, 'they leave the Web API on one bus lane');
});

test('connector labels never overlap, even when many edges share a lane', () => {
  const { nodes, edges } = large();
  // Several edges from the organization band onto the same exit lane.
  const crowded = [
    ...edges,
    ...['provider:outbox', 'provider:connectors', 'provider:secrets', 'provider:powerfx'].map((to) => ({
      from: 'org:store',
      to,
      kind: 'process',
      status: 'ready',
      label: 'email and messages',
    })),
    { from: 'org:flows', to: 'provider:connectors', kind: 'process', status: 'ready', label: 'actions' },
    { from: 'org:jobs', to: 'provider:outbox', kind: 'bus', status: 'ready', label: 'service endpoints' },
  ];
  const layout = layoutTopology(nodes, crowded);
  const boxes = layout.edges.map((edge) => edge.labelBox).filter(Boolean);
  for (const [i, p] of boxes.entries())
    for (const q of boxes.slice(i + 1))
      assert.ok(!(p.x1 < q.x2 && q.x1 < p.x2 && p.y1 < q.y2 && q.y1 < p.y2), 'two label boxes overlap');
});

test('product mapping: admin labels, unknown ids keep their label, raw ids never visible', () => {
  assert.equal(PRODUCT_OF('org:dataverse-addon-ai', 'org-module', 'dataverse-addon-ai').name, 'AI Builder messages');
  assert.equal(PRODUCT_OF('provider:messaging-endpoint:x-queue', 'provider', 'x-queue').name, 'Queue x-queue');
  assert.equal(
    PRODUCT_OF('external:webhook:hooks.example.test', 'external', 'hooks.example.test').name,
    'Webhook hooks.example.test',
  );
  assert.equal(
    PRODUCT_OF('provider:storage-route:annotations', 'provider', 'annotations').name,
    'Note attachments route',
  );
  assert.deepEqual(PRODUCT_OF('fx:gizmo', 'gizmo', 'Invented gizmo'), {
    band: 'providers',
    group: 'provider-other',
    name: 'Invented gizmo',
    icon: 'unknown',
    family: 'neutral',
  });
  assert.equal(PRODUCT_OF('fx:gizmo', 'gizmo', '').name, 'Unnamed component');
  assert.equal(PRODUCT_OF('org:fx-new-module', 'org-module', 'fx-new-module').group, 'org-other');
  const { nodes, edges } = large();
  const html = renderTopology(layoutTopology(nodes, edges), { icons });
  const text = visibleText(html);
  for (const item of nodes) assert.ok(!text.includes(item.id), `raw id ${item.id} is not visible text`);
  assert.match(html, /title="org:dataverse-addon-ai"/, 'the raw id stays in a title for troubleshooting');
  assert.equal(html.match(/ data-node="/g).length, nodes.length, 'one [data-node] per payload node');
  assert.equal(new Set(html.match(/ id="[^"]+"/g)).size, html.match(/ id="[^"]+"/g).length, 'element ids are unique');
});

test('markup is CSP-safe and escapes hostile labels and details', () => {
  const hostile = '<img src=x onerror=alert(1)>"\'&';
  const nodes = [
    node('client:browser', 1, { label: hostile }),
    node('fx:evil', 2, { label: hostile, detail: { note: hostile } }),
    node('org:store', 1),
  ];
  const payload = {
    runtime: { kind: hostile, localOrigin: hostile },
    nodes,
    edges: [{ from: 'client:browser', to: 'fx:evil', kind: hostile, status: hostile, label: hostile }],
    activity: activity(2),
    configuration: { packs: [{ id: hostile }] },
  };
  const html = renderDashboard(payload, { kit, icons, history: [activity(1)] });
  noUnsafeMarkup(html);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;&quot;&#39;&amp;/);
  const drawer = renderNodeDetail(nodes[1], {}, { kit, icons, payload });
  noUnsafeMarkup(drawer);
  assert.doesNotMatch(drawer, /<img/);
  assert.match(
    drawer,
    /<section class="ui-drawer dm-drawer" id="dashboard-drawer" tabindex="-1" data-node-detail="fx:evil"/,
  );
  assert.match(drawer, /data-drawer-close/);
  assert.match(drawer, /Connections/);
  assert.throws(() => renderDashboard(payload, {}), /needs options\.kit/);
});

test('live dashboard: hero, KPIs, layered map with accessible summary, drawer slot and preflight ids', () => {
  const { nodes, edges } = large();
  const html = renderDashboard(
    {
      generatedAt: '2026-10-22T09:30:00.000Z',
      runtime: {
        kind: 'power-pages',
        simulationLevel: 'behaviour',
        clock: 'system',
        revision: 3,
        localOrigin: 'http://localhost:5501',
      },
      nodes,
      edges,
      activity: activity(5),
    },
    {
      kit,
      icons,
      history: [activity(3), activity(4)],
      now: Date.parse('2026-10-22T09:30:03.000Z'),
      preflight: { summary: { blocking: 2 } },
    },
  );
  noUnsafeMarkup(html);
  assert.match(html, /data-dashboard-mode="live"/);
  assert.match(html, /Live · refreshed 3 s ago/);
  assert.match(html, /<strong>2<\/strong> preflight blocking/);
  assert.match(
    html,
    /<svg class="dm-wires" role="img" aria-labelledby="dashboard-topology-title dashboard-topology-desc"/,
  );
  assert.match(html, /<desc id="dashboard-topology-desc">6 layers, 60 components, \d+ ready; \d+ connections/);
  for (const band of BANDS)
    assert.match(html, new RegExp(`<h3 id="dashboard-topology-band-${band.id}">${kit.escapeHtml(band.title)}</h3>`));
  assert.match(html, /aria-label="Power Pages site: [a-z]+"/);
  assert.match(
    html,
    /data-ui-section="dashboard-group:logic"/,
    'group open state survives re-renders through data-ui-section',
  );
  assert.match(
    html,
    /<summary class="dm-group-face" id="dashboard-topology-group-logic-summary"/,
    'a stable id lets the page restore focus on a group after a poll',
  );
  for (const id of [
    'dashboard-node-detail',
    'dashboard-preflight',
    'dashboard-preflight-result',
    'dashboard-preflight-requires',
  ])
    assert.match(html, new RegExp(`id="${id}"`));
  assert.equal(html.match(/class="dm-kpi /g).length, KPIS.length + 1, 'eight KPI tiles plus diagnostics');
  assert.match(html, /Top <code>FX_CODE<\/code> ×2/);
});

test('highlight classes: each card knows its key and its direct connections only', () => {
  const { nodes, edges } = large();
  const layout = layoutTopology(nodes, edges);
  const html = renderTopology(layout);
  const api = layout.cards.find((card) => card.node?.id === 'host:dataverse-api');
  const store = layout.cards.find((card) => card.nodes.some((item) => item.id === 'org:store'));
  const client = layout.cards.find((card) => card.node?.id === 'client:api');
  assert.ok(
    api.related.includes(store.index) && api.related.includes(client.index),
    'direct upstream and downstream cards',
  );
  // Only direct connections light up: a card two hops away (behind the store) does not.
  const twoHops = layout.edges
    .filter((edge) => edge.from === store.index)
    .map((edge) => edge.to)
    .filter(
      (index) =>
        !layout.edges.some(
          (edge) => (edge.from === api.index && edge.to === index) || (edge.to === api.index && edge.from === index),
        ),
    );
  for (const index of twoHops)
    assert.ok(!api.related.includes(index), `card ${index} behind the store is not highlighted for the Web API`);
  assert.match(
    html,
    new RegExp(`class="dm-card dm-node is-[a-z]+ dm-k${api.index}[^"]*"[^>]*data-node="host:dataverse-api"`),
  );
  assert.match(
    html,
    new RegExp(`class="dm-wire is-http[^"]* dm-p${api.index}[^"]*" data-edge="client:api→host:dataverse-api"`),
  );
  assert.match(html, new RegExp(`class="dm-card dm-node[^"]* dm-p${api.index}[ "][^>]*data-node="client:api"`));
  assert.ok(layout.cards.length <= HIGHLIGHT_LIMIT);
  const css = fs.readFileSync(new URL('../admin/dashboard.css', import.meta.url), 'utf8');
  assert.equal(
    css.match(/\.dm-canvas:has\(\.dm-k\d+:hover, \.dm-k\d+:focus-within\) \.dm-p\d+ \{ --dm-on: 1; \}/g).length,
    HIGHLIGHT_LIMIT,
    'one CSS rule per highlight index',
  );
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.dm-pulse \{ animation: none/);
});

test('active edges pulse only in live mode when their counters moved', () => {
  const edge = { from: 'client:browser', to: 'host:portal', kind: 'http', status: 'listening' };
  assert.equal(isActive(edge, activity(2), activity(1)), true);
  assert.equal(isActive(edge, activity(1), activity(1)), false);
  assert.equal(isActive({ ...edge, status: 'disabled' }, activity(2), activity(1)), false);
  const payload = { nodes: [node('client:browser', 1), node('host:portal', 1)], edges: [edge], activity: activity(2) };
  assert.match(
    renderDashboard(payload, { kit, previousActivity: activity(1) }),
    /class="dm-wire is-http is-listening is-active[^"]*"[\s\S]*class="dm-pulse"/,
  );
  assert.doesNotMatch(
    renderDashboard(payload, { kit, mode: 'planned', previousActivity: activity(1) }),
    /is-active dm|class="dm-pulse" x1/,
  );
});

test('sparklines work with empty and full history; counters plot the change per refresh', () => {
  assert.deepEqual(activitySeries([], activity(1)).length, 1);
  const full = Array.from({ length: 20 }, (_, step) => activity(step));
  const series = activitySeries(full, activity(20));
  assert.equal(series.length, 12, 'last 12 points including the current one');
  assert.equal(series.at(-1).plugins.executions, 20);
  const requests = KPIS.find((kpi) => kpi.key === 'requests');
  assert.deepEqual(sparkValues(requests, series), Array(11).fill(3));
  const jobs = KPIS.find((kpi) => kpi.key === 'jobs');
  assert.deepEqual(sparkValues(jobs, series).length, 12);
  assert.match(sparkline([]), /class="dm-spark is-empty"/);
  assert.match(sparkline([1, 4, 2]), /<polyline class="dm-spark-line" points="0.0,[\d.]+ 50.0,[\d.]+ 100.0,[\d.]+"/);
  const empty = renderDashboard({ nodes: [], edges: [], activity: activity(1) }, { kit });
  assert.match(empty, /trend appears after two refreshes/);
  assert.match(empty, /no earlier refresh to compare/);
  const moving = renderDashboard({ nodes: [], edges: [], activity: activity(20) }, { kit, history: full });
  assert.match(moving, /change per refresh, last 11 refreshes/);
  assert.match(moving, /class="dm-delta is-up"/);
});

test('planned and starting modes', () => {
  const planned = renderDashboard(
    {
      runtime: { kind: 'power-pages' },
      nodes: [node('host:portal', 0, { status: 'planned' }), node('host:tds', 0, { status: 'disabled' })],
      edges: [],
    },
    { kit, mode: 'planned' },
  );
  noUnsafeMarkup(planned);
  assert.match(planned, /data-dashboard-mode="planned"/);
  assert.match(planned, /Planned from configuration — start the preview to see live status\./);
  assert.match(planned, /<title id="dashboard-topology-title">Planned system map<\/title>/);
  assert.match(planned, /aria-label="TDS endpoint \(SQL\): disabled"/);
  assert.doesNotMatch(planned, /dm-kpi|id="dashboard-preflight"/);
  assert.match(planned, /<span class="dm-pill is-info">1 planned<\/span>/);
  assert.match(planned, /<span class="dm-pill is-info">1 off<\/span>/);
  for (const starting of [
    renderDashboard({ status: 'starting' }, { kit }),
    renderDashboard({}, { kit, mode: 'starting' }),
  ]) {
    noUnsafeMarkup(starting);
    assert.match(starting, /data-dashboard-mode="starting"/);
    assert.match(starting, /The runtime is starting/);
    assert.match(starting, /id="dashboard-node-detail"/);
    assert.equal(starting.match(/class="dm-band-index/g).length, BANDS.length);
  }
});

test('card facts and health pills read like an admin console', () => {
  assert.deepEqual(factsOf({ id: 'org:store', detail: { tables: 12, revision: 4 } }), ['12 tables', 'revision 4']);
  assert.deepEqual(
    factsOf({ id: 'host:dataverse-api', status: 'listening', detail: { origin: 'http://localhost:51988' } }),
    ['port 51988'],
  );
  assert.deepEqual(factsOf({ id: 'provider:storage-route:annotations', detail: { provider: 'local' } }), ['to local']);
  assert.deepEqual(healthOf([{ status: 'ready' }, { status: 'listening' }, { status: 'placeholder' }]), {
    text: '2 of 3 ready · 1 placeholder',
    short: '2/3 ready',
    tone: 'warn',
    counts: { total: 3, ready: 2, bad: 0, placeholder: 1, disabled: 0, declared: 0, planned: 0 },
  });
  assert.equal(healthOf([{ status: 'missing' }]).short, '1 issue');
});

test('the wide map stylesheet matches GEOMETRY, so connectors meet the cards', () => {
  // The SVG connectors are computed from GEOMETRY; the cards are laid out by dashboard.css. Any drift leaves arrows short of their cards.
  const css = fs
    .readFileSync(new URL('../admin/dashboard.css', import.meta.url), 'utf8')
    .split('/* ---------- Narrow containers')[0];
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    if (start < 0) assert.fail(`no rule ${selector}`);
    return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  };
  const value = (selector, property) =>
    rule(selector)
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${property}:`))
      ?.slice(property.length + 1)
      .trim();
  const px = (selector, property) => Number.parseFloat(value(selector, property));
  const box = (selector, property) => value(selector, property).split(/\s+/);
  assert.equal(px('.dm-canvas', 'gap'), 0);
  assert.equal(px('.dm-canvas', '--dm-label'), GEOMETRY.label);
  assert.deepEqual(box('.dm-canvas', 'padding'), [`${GEOMETRY.top}px`, '0']);
  for (let lanes = 2; lanes <= GEOMETRY.maxLanes; lanes++)
    assert.equal(px(`.dm-gap-${lanes}`, 'margin-top'), gutterOf(lanes), `gutter of ${lanes} lanes`);
  assert.equal(px('.dm-gap-0, .dm-gap-1', 'margin-top'), gutterOf(1));
  assert.match(
    rule('.dm-wires, .dm-wire-labels'),
    /left: var\(--dm-label\);[\s\S]*width: calc\(100% - var\(--dm-label\)\)/,
    'connectors cover the card area only',
  );
  assert.match(rule('.dm-band'), /grid-template-columns: var\(--dm-label\) minmax\(0, 1fr\)/);
  assert.doesNotMatch(rule('.dm-band'), /margin: /, 'a band keeps the margin-top of its gutter class');
  assert.equal(px('.dm-cards', 'grid-auto-rows'), GEOMETRY.cardH);
  assert.equal(px('.dm-cards', 'row-gap'), GEOMETRY.rowGap);
  assert.deepEqual(box('.dm-cards', 'padding'), [
    `${GEOMETRY.padTop}px`,
    `${Math.round((1 - GEOMETRY.right) * 100)}%`,
    `${GEOMETRY.padBottom}px`,
    `${Math.round(GEOMETRY.left * 100)}%`,
  ]);
  assert.match(rule('.dm-card'), new RegExp(`height: ${GEOMETRY.cardH}px`));
});
