// Infrastructure dashboard renderer shared by `/_sim/#dashboard` (live mode, `GET /_sim/api/dashboard`) and
// `/_setup/#system` (planned mode, `status.topology`). Pure string builders: no DOM access and no imports.
// The page passes the UI kit module as `options.kit` (`import * as kit from './ui-kit.mjs'`), so markup
// conventions (tables, pagers, badges) stay in one place while both hosts serve this file under their own prefix.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

export const COLUMNS = Object.freeze(['client', 'host', 'org', 'provider', 'external']);
export const COLUMN_TITLES = Object.freeze({ client: 'Clients', host: 'Hosts', org: 'Organization', provider: 'Providers', external: 'Declared externals' });
export const STATUSES = Object.freeze(['listening', 'ready', 'declared', 'disabled', 'placeholder', 'missing', 'error', 'planned']);
const STATUS_MEANING = Object.freeze({
  listening: 'serving requests on loopback', ready: 'created and usable in this runtime', declared: 'configured but not created or probed here',
  disabled: 'turned off by configuration', placeholder: 'listed from source; answers a documented placeholder', missing: 'required but absent or unreachable',
  error: 'failed to start or answered an error', planned: 'from configuration only; no runtime is running',
});
// Node id prefix (D5 scheme) → column; a node `kind` is the fallback for ids outside the scheme.
const PREFIX_COLUMNS = Object.freeze({ client: 'client', host: 'host', app: 'host', 'persona-runtime': 'host', org: 'org', provider: 'provider', connection: 'provider', external: 'external', bridge: 'external' });
const KIND_COLUMNS = Object.freeze({ client: 'client', host: 'host', app: 'host', 'persona-runtime': 'host', identity: 'org', org: 'org', 'org-module': 'org', provider: 'provider', connector: 'provider', connection: 'provider', external: 'external', bridge: 'external' });
// Order inside a column: exact ids first, then `prefix:` families, in this order; ties sort by label.
const PRIORITY = Object.freeze([
  'client:browser', 'client:staff', 'client:api', 'client:lense',
  'host:portal', 'host:model-driven', 'host:dataverse-api', 'host:tds', 'host:identity-provider', 'host:setup', 'host:admin', 'app:', 'persona-runtime:',
  'org:store', 'org:security', 'org:plugins', 'org:workflows', 'org:flows', 'org:jobs', 'org:',
  'provider:storage', 'provider:storage-route:', 'provider:messaging', 'provider:messaging-endpoint:', 'provider:outbox', 'provider:connectors', 'connection:',
  'provider:secrets', 'provider:local-service:', 'provider:service-fixture:', 'provider:powerfx',
  'external:azurite', 'external:servicebus-emulator', 'external:functions', 'external:keyvault', 'external:', 'bridge:live',
]);
export const NODE = Object.freeze({ width: 188, height: 56, rowGap: 14, columnGap: 76, pad: 24, header: 28 });

const columnOf = node => PREFIX_COLUMNS[String(node.id).split(':')[0]] ?? KIND_COLUMNS[node.kind] ?? 'provider';
const rank = id => {
  const exact = PRIORITY.indexOf(id);
  if (exact >= 0) return exact;
  const family = PRIORITY.findIndex(entry => entry.endsWith(':') && id.startsWith(entry));
  return family >= 0 ? family : PRIORITY.length;
};
const statusOf = status => (STATUSES.includes(status) ? status : 'unknown');

/** Position nodes in columns (client | host | org | provider | external) and route edges between card sides. */
export function layoutTopology(nodes = [], edges = [], { columns = COLUMNS } = {}) {
  const { width: w, height: h, rowGap, columnGap, pad, header } = NODE;
  const groups = new Map(columns.map(column => [column, []]));
  for (const node of nodes) groups.get(groups.has(columnOf(node)) ? columnOf(node) : columns.at(-1)).push(node);
  const used = columns.filter(column => groups.get(column).length);
  const placed = [];
  used.forEach((column, index) => {
    groups.get(column)
      .sort((a, b) => rank(String(a.id)) - rank(String(b.id)) || String(a.label ?? a.id).localeCompare(String(b.label ?? b.id)))
      .forEach((node, row) => placed.push({ ...node, column, x: pad + index * (w + columnGap), y: pad + header + row * (h + rowGap), w, h }));
  });
  const byId = new Map(placed.map(node => [node.id, node]));
  const routed = edges.filter(edge => byId.has(edge.from) && byId.has(edge.to)).map(edge => ({ ...edge, path: route(byId.get(edge.from), byId.get(edge.to)) }));
  const rows = Math.max(1, ...used.map(column => groups.get(column).length));
  const bulge = 48; // room for same-column loops on the right of the last column
  return {
    width: pad * 2 + Math.max(1, used.length) * w + Math.max(0, used.length - 1) * columnGap + bulge,
    height: pad * 2 + header + rows * h + (rows - 1) * rowGap,
    columns: used.map((column, index) => ({ id: column, title: COLUMN_TITLES[column] ?? column, x: pad + index * (w + columnGap) })),
    nodes: placed,
    edges: routed,
  };
}

function route(from, to) {
  const y1 = from.y + from.h / 2, y2 = to.y + to.h / 2;
  if (from.x === to.x) { // same column: loop out of the right side and back
    const x = from.x + from.w, out = x + 40;
    return `M ${x} ${y1} C ${out} ${y1}, ${out} ${y2}, ${x} ${y2}`;
  }
  const forward = to.x > from.x;
  const x1 = forward ? from.x + from.w : from.x, x2 = forward ? to.x : to.x + to.w, mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/** A stable DOM id part for a node id: every character outside [A-Za-z0-9-] becomes `_<hex>`, so distinct ids stay distinct. */
export const nodeKey = id => String(id).replace(/[^A-Za-z0-9-]/g, char => `_${char.codePointAt(0).toString(16)}`);
const clip = (text, max = 24) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Inline SVG (role="img") with one focusable `g[data-node]` (stable id `<id>-node-<nodeKey>`) per node and one `path[data-edge]` per edge, plus an HTML legend. */
export function renderTopology(layout, { mode = 'live', id = 'dashboard-topology' } = {}) {
  const planned = mode === 'planned';
  const counts = STATUSES.map(status => [status, layout.nodes.filter(node => statusOf(node.status) === status).length]).filter(([, count]) => count);
  const description = `${layout.nodes.length} components and ${layout.edges.length} connections${counts.length ? `: ${counts.map(([status, count]) => `${count} ${status}`).join(', ')}` : ''}.`;
  const columnTitles = layout.columns.map(column => `<text class="ui-topology-column" x="${column.x}" y="${NODE.pad + 12}">${e(column.title)}</text>`).join('');
  const edges = layout.edges.map(edge => {
    const active = !planned && edge.active ? ' is-active' : '';
    return `<path class="ui-edge is-${e(statusOf(edge.status))}${active}" data-edge="${e(edge.from)}→${e(edge.to)}" d="${edge.path}" fill="none" marker-end="url(#${e(id)}-arrow)"><title>${e(edge.label || edge.kind || '')}</title></path>`;
  }).join('');
  const nodes = layout.nodes.map(node => {
    const status = statusOf(node.status), label = String(node.label ?? node.id);
    return `<g class="ui-node is-${e(status)}" id="${e(id)}-node-${e(nodeKey(node.id))}" data-node="${e(node.id)}" tabindex="0" role="button" aria-label="${e(label)}: ${e(status)}" transform="translate(${node.x} ${node.y})">`
      + `<rect class="ui-node-card" width="${node.w}" height="${node.h}" rx="10" ry="10"></rect>`
      + `<circle class="ui-status-dot is-${e(status)}" cx="16" cy="${node.h / 2}" r="6"></circle>`
      + `<text class="ui-node-label" x="30" y="24">${e(clip(label))}</text>`
      + `<text class="ui-node-level" x="30" y="42">${e(clip(`${status}${node.level ? ` · ${node.level}` : ''}`, 28))}</text></g>`;
  }).join('');
  const legend = `<ul class="ui-legend" aria-label="Status legend">${STATUSES.map(status => `<li><span class="ui-status-dot is-${status}" aria-hidden="true"></span><strong>${status}</strong> ${e(STATUS_MEANING[status])}</li>`).join('')}`
    + `${planned ? '' : '<li><span class="ui-legend-edge" aria-hidden="true"></span><strong>moving line</strong> its counters changed since the previous refresh</li>'}</ul>`;
  return `<div class="ui-topology"><svg role="img" aria-labelledby="${e(id)}-title ${e(id)}-desc" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">`
    + `<title id="${e(id)}-title">${planned ? 'Planned system map' : 'Running system map'}</title><desc id="${e(id)}-desc">${e(description)}</desc>`
    + `<defs><marker id="${e(id)}-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="ui-edge-arrow" d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>`
    + `${columnTitles}<g class="ui-edges">${edges}</g><g class="ui-nodes">${nodes}</g></svg></div>${legend}`;
}

// Which activity counters move each edge kind (D7 counters):
// http/reads → requests.total, dataverseRequests.total; bus → messages.* and outbox.*; storage → storage.byProvider writes/deletes/bytesWritten;
// webhook → webhooks.*; process → plugins.executions/failures, flows.*, jobs.*. An edge into `org:plugins|flows|jobs` uses that counter only.
const sum = value => (value && typeof value === 'object' ? Object.values(value).reduce((total, item) => total + (typeof item === 'number' ? item : 0), 0) : Number(value) || 0);
const COUNTERS = Object.freeze({
  http: activity => [activity.requests?.total, activity.dataverseRequests?.total],
  reads: activity => [activity.requests?.total, activity.dataverseRequests?.total],
  bus: activity => [sum(activity.messages), activity.outbox?.queued, activity.outbox?.delivered, activity.outbox?.failed],
  storage: activity => (activity.storage?.byProvider ?? []).flatMap(item => [item.id, item.writes, item.deletes, item.bytesWritten]),
  webhook: activity => [sum(activity.webhooks)],
  process: activity => [activity.plugins?.executions, activity.plugins?.failures, sum(activity.flows), sum(activity.jobs)],
});
const TARGET_COUNTERS = Object.freeze({
  'org:plugins': activity => [activity.plugins?.executions, activity.plugins?.failures],
  'org:flows': activity => [sum(activity.flows)],
  'org:jobs': activity => [sum(activity.jobs)],
});

/** True when a counter related to the edge changed between two polls; never for disabled or missing edges. */
export function isActive(edge, activity, previousActivity) {
  if (!activity || !previousActivity || ['disabled', 'missing', 'planned'].includes(edge?.status)) return false;
  const read = TARGET_COUNTERS[edge.to] ?? COUNTERS[edge.kind];
  return Boolean(read) && JSON.stringify(read(activity)) !== JSON.stringify(read(previousActivity));
}

const DOC_FOR = Object.freeze([
  ['provider:storage', 'mirage/docs/storage-providers.md'], ['external:azurite', 'mirage/docs/storage-providers.md'],
  ['provider:messaging', 'mirage/docs/messaging-and-outbox.md'], ['provider:outbox', 'mirage/docs/messaging-and-outbox.md'], ['external:servicebus', 'mirage/docs/messaging-and-outbox.md'],
  ['provider:connectors', 'mirage/docs/operations.md'], ['connection:', 'mirage/docs/operations.md'], ['provider:local-service:', 'mirage/docs/operations.md'], ['external:functions', 'mirage/docs/operations.md'],
  ['provider:secrets', 'mirage/docs/deployment-profiles.md'], ['external:keyvault', 'mirage/docs/deployment-profiles.md'],
  ['provider:service-fixture:', 'mirage/docs/service-fixtures.md'], ['provider:powerfx', 'mirage/docs/canvas-apps.md'], ['app:canvas', 'mirage/docs/canvas-apps.md'], ['app:code', 'mirage/docs/code-apps.md'],
  ['host:dataverse-api', 'mirage/docs/dataverse-api.md'], ['host:tds', 'mirage/docs/dataverse-api.md'], ['client:api', 'mirage/docs/dataverse-api.md'],
  ['host:model-driven', 'mirage/docs/model-driven-apps.md'], ['client:staff', 'mirage/docs/model-driven-apps.md'],
  ['persona-runtime:', 'mirage/docs/persona-catalog.md'], ['host:identity-provider', 'mirage/docs/persona-catalog.md'],
  ['org:plugins', 'mirage/docs/dataverse-plugins.md'], ['org:flows', 'mirage/docs/operations.md'], ['org:jobs', 'mirage/docs/operations.md'],
  ['host:setup', 'docs/setup.md'], ['org:', 'mirage/docs/platform-stack.md'],
]);
const docPathFor = id => DOC_FOR.find(([prefix]) => id === prefix || id.startsWith(prefix))?.[1] ?? 'mirage/docs/sim-administration.md';
const needKit = kit => {
  if (!kit?.table || !kit?.kv) throw new TypeError('dashboard-view needs options.kit: import * as kit from "./ui-kit.mjs" and pass it.');
  return kit;
};
const factValue = (kit, value) => (value !== null && typeof value === 'object' ? `<code>${kit.escapeHtml(JSON.stringify(value))}</code>` : kit.escapeHtml(value));
const viewName = link => String(link).slice(1).split('?')[0];

/** Drawer for one node: status, level, safe facts, owning view link and its guide. */
export function renderNodeDetail(node, docs, { kit } = {}) {
  needKit(kit);
  const id = `node-detail-${String(node.id).replace(/[^a-z0-9-]+/gi, '-')}`;
  const facts = Object.entries(node.detail ?? {}).map(([label, value]) => [label, factValue(kit, value), { mono: typeof value !== 'string' }]);
  const link = typeof node.link === 'string' && /^#[a-z][a-z0-9-]*(?:\?[^\s"'<>]*)?$/i.test(node.link) ? node.link : null;
  return `<section class="ui-drawer" id="dashboard-drawer" tabindex="-1" data-node-detail="${e(node.id)}" aria-labelledby="${e(id)}"><div class="ui-drawer-head"><h3 id="${e(id)}">${e(node.label ?? node.id)}</h3>`
    + `${kit.statusBadge(node.status)}${node.level ? ` ${kit.levelBadge(node.level)}` : ''}<button type="button" class="ui-button ui-small" data-drawer-close aria-label="Close details">Close</button></div>`
    + `${kit.kv([['Component', `<code>${e(node.id)}</code>`], ...(node.kind ? [['Kind', e(node.kind)]] : []), ...facts])}`
    + (link ? `<p class="ui-drawer-actions"><a class="ui-button" href="${e(link)}">Open ${e(viewName(link))}</a></p>` : '')
    + kit.help({ text: 'Reference:', doc: kit.docLink(docPathFor(String(node.id)), docs) }) + '</section>';
}

/** `at` as an ISO string: hosts send epoch milliseconds or ISO text; anything unreadable becomes null. */
export const isoTime = at => {
  const time = at == null || at === '' ? NaN : new Date(typeof at === 'string' && /^\d+$/.test(at) ? Number(at) : at).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
const activityRows = activity => [
  ...(activity?.requests?.recent ?? []).map(item => ({ ...item, at: isoTime(item.at), source: 'Portal' })),
  ...(activity?.dataverseRequests?.recent ?? []).map(item => ({ ...item, at: isoTime(item.at), source: 'Dataverse' })),
].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
  .concat(Object.entries(activity?.diagnostics?.byCode ?? {}).map(([code, count]) => ({ source: 'Diagnostic', code, count })));

const number = value => (typeof value === 'number' ? value.toLocaleString('en') : '—');

/** Compose the dashboard. `mode: 'live'` reads the D5 payload; `'planned'` renders configuration only. */
export function renderDashboard(payload = {}, { mode = 'live', docs, previousActivity, help, kit, pager } = {}) {
  needKit(kit);
  const planned = mode === 'planned', runtime = payload.runtime ?? {}, activity = payload.activity ?? {};
  const nodes = payload.nodes ?? [];
  const edges = (payload.edges ?? []).map(edge => ({ ...edge, active: !planned && isActive(edge, activity, previousActivity) }));
  const docOf = path => kit.docLink(path, docs ?? payload.docs);
  const guideFor = key => help?.[key];
  const intro = guideFor('dashboard');
  const header = `<section class="ui-dash-header" data-dashboard-mode="${planned ? 'planned' : 'live'}">`
    + (intro ? kit.guide({ key: 'dashboard', intro: intro.intro, steps: intro.steps ?? [], example: intro.example, docs: intro.doc ? [docOf(intro.doc)] : [] }) : '')
    + (planned ? kit.notice('Planned from configuration; start the preview to see live status.', 'info') : '')
    + kit.kv([
      ['Product', e(runtime.product ?? 'Mirage')], ['Runtime', e(runtime.kind ?? 'not reported')], ['Simulation level', e(runtime.simulationLevel ?? 'not reported')],
      ...(planned ? [] : [['Clock', e(runtime.clock ?? 'not reported')], ['Origin', runtime.localOrigin ? `<code>${e(runtime.localOrigin)}</code>` : 'not reported'], ['Revision', e(runtime.revision ?? 'not reported')]]),
      ...(runtime.reloading ? [['Reload', kit.badge('reloading', 'warn')]] : []),
    ]) + '</section>';
  const storageTotal = name => (activity.storage?.byProvider ?? []).reduce((total, item) => total + (Number(item[name]) || 0), 0);
  const kpis = planned ? '' : kit.tiles([
    { label: 'Requests', value: number(activity.requests?.total), detail: 'portal and local pages', tone: 'info' },
    { label: 'Dataverse requests', value: number(activity.dataverseRequests?.total), detail: `Web API data requests · ${number(activity.dataverseRequests?.other)} other`, tone: 'info' },
    { label: 'Plug-in runs', value: number(activity.plugins?.executions), detail: `${number(activity.plugins?.failures)} failed`, tone: activity.plugins?.failures ? 'bad' : 'ok' },
    { label: 'Flow runs', value: number(sum(activity.flows)), detail: `${number(activity.flows?.failed)} failed · ${number(activity.flows?.waiting)} waiting`, tone: activity.flows?.failed ? 'bad' : 'ok' },
    { label: 'Jobs pending', value: number(activity.jobs?.pending), detail: `${number(activity.jobs?.poisoned)} poisoned`, tone: activity.jobs?.poisoned ? 'bad' : 'neutral' },
    { label: 'Messages', value: number(activity.messages?.active), detail: `${number(activity.messages?.deadLettered)} dead-lettered`, tone: activity.messages?.deadLettered ? 'warn' : 'neutral' },
    { label: 'Storage writes', value: number(storageTotal('writes')), detail: `${number(storageTotal('deletes'))} deletes · ${number(storageTotal('bytesWritten'))} bytes written`, tone: 'neutral' },
    { label: 'Outbox', value: number(activity.outbox?.queued), detail: `${number(activity.outbox?.delivered)} delivered (captured only)`, tone: 'neutral' },
    { label: 'Diagnostics', value: number(activity.diagnostics?.total), detail: 'see Render & diagnostics', tone: activity.diagnostics?.total ? 'warn' : 'ok' },
  ]);
  const layout = layoutTopology(nodes, edges);
  const map = `<section class="ui-dash-map" aria-labelledby="dashboard-map-title"><h2 id="dashboard-map-title">System map</h2>`
    + `<p class="ui-help">Select a component (click, Enter or Space) to see its facts and the view that manages it.</p>`
    + `${renderTopology(layout, { mode })}<div id="dashboard-node-detail" class="ui-drawer-slot"></div></section>`;
  const rows = planned ? [] : activityRows(activity);
  const result = kit.pageItems(rows, pager ?? {}, { text: item => `${item.source} ${item.method ?? ''} ${item.path ?? ''} ${item.status ?? ''} ${item.code ?? ''}` });
  const feed = `<section class="ui-dash-feed" aria-labelledby="dashboard-feed-title"><h2 id="dashboard-feed-title">What is happening</h2>`
    + (planned ? kit.notice('Activity appears once the preview runs.', 'neutral') : kit.table({
      key: 'dashboard-activity', result, caption: 'Recent requests and diagnostics', emptyText: 'No requests or diagnostics recorded yet. Open a page of the preview to see traffic.',
      columns: [
        { label: 'When', render: item => e(item.at ? String(item.at).slice(11, 19) : '—') },
        { label: 'Source', render: item => kit.badge(item.source, item.source === 'Diagnostic' ? 'warn' : 'info') },
        { label: 'What', render: item => (item.code ? `<code>${e(item.code)}</code>` : `${e(item.method)} <code>${e(item.path)}</code>`) },
        { label: 'Result', render: item => (item.code ? `${e(item.count)} recorded` : `${kit.badge(item.status ?? 'pending', item.status >= 400 ? 'bad' : 'ok')}${item.ms !== undefined ? ` ${e(item.ms)} ms` : ''}`) },
      ],
    })) + '</section>';
  const blockingBody = planned
    ? kit.notice('Preflight needs a running preview. From a terminal, run: paqvilo mirage preflight --config <file> --site <id> (or --project <file>).', 'neutral')
    : `<p class="ui-empty">Nothing is listed until you run preflight. It probes declared local services and rebuilds the source graph, so it runs on demand only.</p>`
      + `<form id="dashboard-preflight" class="ui-form"><label for="dashboard-preflight-requires">Requirements (ids or globs, separated by spaces)</label>`
      + `<input id="dashboard-preflight-requires" name="requires" type="text" placeholder="cloud-flow:* table:x_item" aria-describedby="dashboard-preflight-requires-help">`
      + `${kit.fieldHelp('dashboard-preflight-requires', 'Empty checks everything. * matches any characters and matching ignores case.')}`
      + `<label class="ui-check"><input id="dashboard-preflight-strict" name="strict" type="checkbox" aria-describedby="dashboard-preflight-strict-help"> Strict</label>`
      + `${kit.fieldHelp('dashboard-preflight-strict', 'Strict makes every unsatisfied requirement in scope blocking.')}`
      + `<button type="submit" class="ui-button ui-primary">Run preflight</button></form><div id="dashboard-preflight-result"></div>`;
  const blocking = kit.section({ key: 'dashboard-blocking', title: 'Blocking', summary: planned ? 'available while the preview runs' : 'run preflight on demand', open: !planned, body: blockingBody,
    help: guideFor('dashboard.blocking') ? { text: guideFor('dashboard.blocking').intro, doc: guideFor('dashboard.blocking').doc ? docOf(guideFor('dashboard.blocking').doc) : undefined } : undefined });
  const configuration = payload.configuration ?? {};
  const ports = configuration.ports ?? Object.fromEntries(nodes.filter(node => node.detail?.port).map(node => [node.label ?? node.id, node.detail.port]));
  // Packs arrive as `{ id, module }`, Solution layers as `{ solution, version }` or folder strings; print their ids.
  const label = item => (item && typeof item === 'object' ? [item.id ?? item.solution ?? item.name ?? item.module ?? item.path, item.version].filter(part => part != null && part !== '').join(' ') : item);
  const list = value => (Array.isArray(value) ? (value.length ? value.map(item => `<code>${e(label(item))}</code>`).join(' ') : 'none') : e(value ?? 'not reported'));
  const port = value => (value === 0 ? 'free port' : value == null ? 'not used' : `<code>${e(value)}</code>`);
  const summary = kit.section({ key: 'dashboard-configuration', title: 'Configuration summary', summary: runtime.kind ?? '', body: kit.kv([
    ['Runtime', e(runtime.kind ?? 'not reported')], ['Simulation level', e(runtime.simulationLevel ?? 'not reported')],
    ['State file', runtime.stateFile ? `<code>${e(runtime.stateFile)}</code>` : planned ? 'not known until start' : 'none (in memory)'],
    ['Data packs', list(configuration.packs)], ['Solution layers', list(configuration.solutionLayers)],
    ['Settings keys present', list(configuration.settingsKeys)],
    ['Ports', Object.keys(ports).length ? Object.entries(ports).map(([name, value]) => `${e(name)} ${port(value)}`).join(' · ') : 'not reported'],
  ]) });
  return `<div class="ui-dashboard" data-dashboard-mode="${planned ? 'planned' : 'live'}">${header}${kpis}${map}${feed}${blocking}${summary}</div>`;
}
