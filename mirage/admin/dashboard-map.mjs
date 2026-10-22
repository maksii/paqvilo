// Infrastructure dashboard ("mission control") shared by `/_sim/#dashboard` (live, `GET /_sim/api/dashboard`) and
// `/_setup/#system` (planned, `status.topology`). Pure string builders: no DOM access and no imports. The page passes
// the UI kit (`import * as kit from './ui-kit.mjs'`) and, optionally, the icon set (`import * as icons from
// './dashboard-icons.mjs'`) in the options. Styles live in dashboard.css (`dm-` classes, `--dm-` tokens).
//
// The map is HTML cards in six horizontal layer bands with one SVG behind them for the connectors. Wide layouts
// (container ≥ 880 px) use a fixed five-column grid, so card centres are exact fractions of the width (SVG `x` in %)
// and rows have fixed pixel heights (SVG `y` in px): the connectors line up at any width without measuring the DOM.
// Narrow containers drop the connectors, wrap cards to three or two columns and show each card's connections as text.
// Hover or focus highlights a card's upstream and downstream path through CSS only (`:has()` + `dm-k<n>`/`dm-p<n>`).
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const e = value => String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char]);

export const STATUSES = Object.freeze(['listening', 'ready', 'declared', 'disabled', 'placeholder', 'missing', 'error', 'planned']);
const STATUS_TEXT = Object.freeze({ listening: 'Listening', ready: 'Ready', declared: 'Declared', disabled: 'Disabled', placeholder: 'Placeholder', missing: 'Missing', error: 'Error', planned: 'Planned', unknown: 'Unknown' });
const STATUS_MEANING = Object.freeze({
  listening: 'serving requests on loopback', ready: 'created and usable in this runtime', declared: 'configured but not created or probed here',
  disabled: 'turned off by configuration', placeholder: 'listed from source; answers a documented placeholder', missing: 'required but absent or unreachable',
  error: 'failed to start or answered an error', planned: 'from configuration only; no runtime is running',
});
const READY = new Set(['listening', 'ready']);
const BAD = new Set(['missing', 'error']);
const statusOf = status => (STATUSES.includes(status) ? status : 'unknown');

export const BANDS = Object.freeze([
  { id: 'people', title: 'People & clients', description: 'Who calls this runtime: portal visitors, makers and staff, integration apps and the Lense live connection.' },
  { id: 'experiences', title: 'Experiences', description: 'The apps people open: the Power Pages site, model-driven, canvas and code apps, and code components.' },
  { id: 'endpoints', title: 'Platform endpoints', description: 'Local listeners: the Dataverse Web API, TDS, sign-in and tokens, administration and project setup.' },
  { id: 'organization', title: 'Dataverse organization', description: 'The simulated environment, grouped by capability. Open a group to list its modules.' },
  { id: 'providers', title: 'Integration providers', description: 'Where side effects land: storage, queues, outbox, connectors, secrets, local services and fixtures.' },
  { id: 'externals', title: 'Declared externals', description: 'Services named in configuration that run outside Mirage; declared or probed, never contacted for data.' },
]);
const BAND_INDEX = Object.fromEntries(BANDS.map((band, index) => [band.id, index]));

// Capability groups of the organization and provider layers, in display order.
export const GROUPS = Object.freeze({
  tables: { band: 'organization', title: 'Tables & data', icon: 'table', family: 'dataverse' },
  security: { band: 'organization', title: 'Security', icon: 'shield', family: 'dataverse' },
  logic: { band: 'organization', title: 'Business logic', icon: 'logic', family: 'dataverse' },
  automate: { band: 'organization', title: 'Power Automate', icon: 'flow', family: 'automate' },
  background: { band: 'organization', title: 'Background work', icon: 'clock', family: 'dataverse' },
  messaging: { band: 'organization', title: 'Messaging & webhooks', icon: 'webhook', family: 'dataverse' },
  solutions: { band: 'organization', title: 'Solutions & sources', icon: 'layers', family: 'dataverse' },
  'org-other': { band: 'organization', title: 'Other organization modules', icon: 'unknown', family: 'neutral' },
  storage: { band: 'providers', title: 'Storage', icon: 'storage', family: 'azure' },
  queues: { band: 'providers', title: 'Queues & topics', icon: 'queue', family: 'azure' },
  outbox: { band: 'providers', title: 'Outbox', icon: 'mail', family: 'azure' },
  connectors: { band: 'providers', title: 'Connectors & connections', icon: 'plug', family: 'automate' },
  secrets: { band: 'providers', title: 'Secrets & Key Vault references', icon: 'vault', family: 'azure' },
  'local-services': { band: 'providers', title: 'Local services', icon: 'functions', family: 'azure' },
  fixtures: { band: 'providers', title: 'Service fixtures', icon: 'service', family: 'neutral' },
  'provider-other': { band: 'providers', title: 'Other providers', icon: 'unknown', family: 'neutral' },
});
const GROUP_ORDER = Object.keys(GROUPS);

// The ONE node id → product table. Row: [band, group | null, admin-facing name, icon, product family].
const P = (band, group, name, iconName, family) => Object.freeze({ band, group, name, icon: iconName, family });
const EXACT = Object.freeze({
  'client:browser': P('people', null, 'Portal visitors', 'visitor', 'pages'),
  'client:staff': P('people', null, 'Makers & staff', 'staff', 'apps'),
  'client:api': P('people', null, 'Integration clients', 'client', 'dataverse'),
  'client:lense': P('people', null, 'Lense workspace', 'lense', 'neutral'),
  'bridge:live': P('people', null, 'Lense live connection', 'link', 'neutral'),
  'host:portal': P('experiences', null, 'Power Pages site', 'globe', 'pages'),
  'host:model-driven': P('experiences', null, 'Model-driven apps', 'apps', 'apps'),
  'app:canvas': P('experiences', null, 'Canvas apps', 'canvas', 'apps'),
  'app:code': P('experiences', null, 'Code apps', 'code', 'apps'),
  'app:pcf': P('experiences', null, 'Code components (PCF)', 'component', 'apps'),
  'host:dataverse-api': P('endpoints', null, 'Dataverse Web API', 'api', 'dataverse'),
  'host:tds': P('endpoints', null, 'TDS endpoint (SQL)', 'sql', 'dataverse'),
  'host:identity-provider': P('endpoints', null, 'Identity & tokens', 'key', 'neutral'),
  'host:admin': P('endpoints', null, 'Administration', 'admin', 'neutral'),
  'host:setup': P('endpoints', null, 'Project setup', 'setup', 'neutral'),
  'provider:storage': P('providers', 'storage', 'Storage providers', 'storage', 'azure'),
  'provider:messaging': P('providers', 'queues', 'Message bus', 'bus', 'azure'),
  'provider:outbox': P('providers', 'outbox', 'Outbox', 'mail', 'azure'),
  'provider:connectors': P('providers', 'connectors', 'Connector runtime', 'plug', 'automate'),
  'provider:secrets': P('providers', 'secrets', 'Secret references', 'vault', 'azure'),
  'provider:powerfx': P('providers', 'fixtures', 'Power Fx engine', 'fx', 'apps'),
  'external:azurite': P('externals', null, 'Azurite storage emulator', 'cloud', 'azure'),
  'external:servicebus-emulator': P('externals', null, 'Service Bus emulator', 'bus', 'azure'),
  'external:functions': P('externals', null, 'Azure Functions Core Tools', 'functions', 'azure'),
  'external:keyvault': P('externals', null, 'Azure Key Vault', 'vault', 'azure'),
});
// Organization modules (`org:<name>`): [group, product name].
const ORG = Object.freeze({
  store: ['tables', 'Tables & rows'], 'dataverse-standard': ['tables', 'Create, read, update and delete'], 'dataverse-predefined': ['tables', 'System tables'],
  'dataverse-activitypointer': ['tables', 'Activities'], 'activity-messages': ['tables', 'Activity messages'], 'record-messages': ['tables', 'Record messages'],
  'dataverse-files': ['tables', 'File and image columns'], 'dataverse-storage-routing': ['tables', 'File storage routing'], 'sharepoint-documents': ['tables', 'SharePoint document locations'],
  'dataverse-elastic': ['tables', 'Elastic tables'], 'dataverse-search': ['tables', 'Dataverse search'], 'dataverse-virtual-providers': ['tables', 'Virtual tables'],
  'dataverse-data-messages': ['tables', 'Import, export and bulk data'], 'dataverse-misc-messages': ['tables', 'Other data messages'], 'dataverse-currency': ['tables', 'Currencies and exchange rates'],
  security: ['security', 'Security roles'], 'dataverse-fls': ['security', 'Field security and masking'], 'dataverse-audit': ['security', 'Auditing'],
  'dataverse-security-messages': ['security', 'Sharing and access messages'], 'dataverse-security-messages2': ['security', 'Teams and principal messages'],
  plugins: ['logic', 'Plug-in steps (JS/CLR)'], workflows: ['logic', 'Classic workflows'], customapi: ['logic', 'Custom APIs'], 'dataverse-business-rules': ['logic', 'Business rules'],
  'dataverse-calculated': ['logic', 'Calculated columns'], 'dataverse-formula': ['logic', 'Formula columns'], 'dataverse-rollup': ['logic', 'Rollup columns'],
  'dataverse-cascade': ['logic', 'Relationship cascades'], 'dataverse-hierarchy': ['logic', 'Hierarchies'], 'dataverse-state-transitions': ['logic', 'Status transitions'],
  'dataverse-duplicates': ['logic', 'Duplicate detection'], 'dataverse-bpf': ['logic', 'Business process flows'], 'dataverse-plugin-registration': ['logic', 'Plug-in registration'],
  'dataverse-workflows': ['logic', 'Workflow messages'], 'dataverse-addon-handlers': ['logic', 'Add-on message handlers'], 'dataverse-addon-ai': ['logic', 'AI Builder messages'],
  'dataverse-addon-pva': ['logic', 'Copilot Studio messages'], 'dataverse-addon-d365': ['logic', 'Dynamics 365 app messages'],
  flows: ['automate', 'Cloud flows'], 'dataverse-addon-flows': ['automate', 'Flow run messages'], 'flow-triggers': ['automate', 'Flow triggers (recurrence, HTTP, connectors)'], 'flow-runs': ['automate', 'Flow runs and waits'],
  jobs: ['background', 'Background jobs and scheduler'], 'dataverse-async': ['background', 'System jobs'], 'dataverse-addon-workqueues': ['background', 'Work queues'],
  'dataverse-calendar-messages': ['background', 'Calendars and scheduling'],
  'dataverse-webhooks': ['messaging', 'Webhooks'], 'dataverse-service-endpoints': ['messaging', 'Service endpoints'],
  'dataverse-solutions': ['solutions', 'Solutions and layers'], 'dataverse-plugin-registration-solution': ['solutions', 'Plug-in assemblies in solutions'],
  'dataverse-metadata-tables': ['solutions', 'Table metadata'], 'dataverse-metadata-relationships': ['solutions', 'Relationship metadata'],
  'dataverse-metadata-messages': ['solutions', 'Metadata messages'], 'dataverse-customization-messages': ['solutions', 'Customization messages'],
  'dataverse-org-messages': ['solutions', 'Organization settings'], 'dataverse-app-messages': ['solutions', 'App modules'], 'dataverse-addon-git': ['solutions', 'Source control (Git)'],
  'dataverse-addon-featurecontrol': ['solutions', 'Feature controls'],
});
const ROUTES = Object.freeze({ annotations: 'Note attachments', dataverseFiles: 'Dataverse file columns', portalWebFiles: 'Portal web files', sharepointDocuments: 'SharePoint documents' });
const FIXTURES = Object.freeze({ powerBi: 'Power BI', aiBuilder: 'AI Builder', copilot: 'Copilot', dynamics: 'Dynamics 365' });
const FIXTURE_ICONS = Object.freeze({ powerBi: 'chart', aiBuilder: 'sparkle', copilot: 'bot' });
const KIND_BANDS = Object.freeze({ client: 'people', bridge: 'people', 'persona-runtime': 'people', app: 'experiences', host: 'endpoints', org: 'organization', 'org-module': 'organization', identity: 'organization',
  provider: 'providers', connector: 'providers', connection: 'providers', external: 'externals' });
const textOf = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Admin-facing product for a node: { band, group, name, icon, family }. Unknown ids keep their label (never the raw id) and a neutral icon. */
export function PRODUCT_OF(id, kind, label) {
  const key = String(id ?? ''), name = textOf(label);
  if (EXACT[key]) return EXACT[key];
  const [prefix] = key.split(':'), rest = key.slice(prefix.length + 1);
  const family = (start, build) => key.startsWith(start) ? build(key.slice(start.length)) : null;
  return family('persona-runtime:', () => P('people', null, /^persona/i.test(name ?? '') ? name : `Persona session ${name ?? ''}`.trim(), 'persona', 'pages'))
    ?? family('provider:storage-route:', route => P('providers', 'storage', `${ROUTES[route] ?? name ?? 'Storage'} route`, 'storage', 'azure'))
    ?? family('provider:messaging-endpoint:', entity => P('providers', 'queues', `Queue ${name ?? entity}`, 'queue', 'azure'))
    ?? family('provider:local-service:', () => P('providers', 'local-services', `Local service ${name ?? ''}`.trim(), 'functions', 'azure'))
    ?? family('provider:service-fixture:', service => P('providers', 'fixtures', `${FIXTURES[service] ?? name ?? 'Service'} fixture`, FIXTURE_ICONS[service] ?? 'service', 'neutral'))
    ?? family('connection:', () => P('providers', 'connectors', `Connection ${name ?? ''}`.trim(), 'plug', 'automate'))
    ?? family('external:webhook:', host => P('externals', null, `Webhook ${name ?? host}`, 'webhook', 'azure'))
    ?? family('org:pack:', pack => P('organization', 'solutions', `Data pack ${pack}`, 'layers', 'dataverse'))
    ?? (prefix === 'org' && ORG[rest] ? P('organization', ORG[rest][0], ORG[rest][1], GROUPS[ORG[rest][0]].icon, GROUPS[ORG[rest][0]].family) : null)
    ?? (() => {
      const band = KIND_BANDS[prefix] ?? KIND_BANDS[kind] ?? 'providers';
      const group = band === 'organization' ? 'org-other' : band === 'providers' ? 'provider-other' : null;
      return P(band, group, name ?? 'Unnamed component', 'unknown', 'neutral');
    })();
}
// Display order inside a band or group: the table order above, then by name.
const ORDER = [...Object.keys(EXACT), 'persona-runtime:', 'org:store', 'org:security', 'org:plugins', 'org:workflows', 'org:flows', 'org:jobs', 'org:pack:', 'org:',
  'provider:storage-route:', 'provider:messaging-endpoint:', 'connection:', 'provider:local-service:', 'provider:service-fixture:', 'external:webhook:'];
const rank = id => {
  const exact = ORDER.indexOf(id);
  if (exact >= 0) return exact;
  const family = ORDER.findIndex(entry => entry.endsWith(':') && id.startsWith(entry));
  return family >= 0 ? family : ORDER.length;
};

/** A stable DOM id part for a node id: every character outside [A-Za-z0-9-] becomes `_<hex>`, so distinct ids stay distinct. */
export const nodeKey = id => String(id).replace(/[^A-Za-z0-9-]/g, char => `_${char.codePointAt(0).toString(16)}`);

// Wide-layout geometry. Vertical values are CSS pixels and must match dashboard.css; horizontal values are fractions of the canvas width.
export const GEOMETRY = Object.freeze({ columns: 5, top: 16, head: 60, padTop: 4, cardH: 104, rowGap: 14, padBottom: 24, gutter: 48, left: 0.02, right: 0.95 });
// ponytail: CSS highlight rules exist for card indexes 0..119 (dashboard.css); cards past that render without path highlighting.
export const HIGHLIGHT_LIMIT = 120;

const portOf = text => { try { return text ? Number(new URL(text).port) || null : null; } catch { return null; } };
const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const fmt = value => (typeof value === 'number' ? value.toLocaleString('en') : '—');

/** One or two short facts for a card ("12 tables · rev 4", "listening :51988"). Values only from the node's safe `detail`. */
export function factsOf(node) {
  const d = node.detail && typeof node.detail === 'object' ? node.detail : {}, id = String(node.id ?? ''), facts = [];
  const add = (condition, text) => { if (condition && facts.length < 2) facts.push(text); };
  const port = portOf(d.origin) ?? num(d.port);
  const sumValues = value => (value && typeof value === 'object' ? Object.values(value).reduce((total, item) => total + (num(item) ?? 0), 0) : 0);
  if (id === 'org:store') { add(num(d.tables) != null, plural(d.tables, 'table')); add(num(d.revision) != null, `revision ${d.revision}`); }
  else if (id === 'org:plugins') { add(num(d.steps) != null, plural(d.steps, 'step')); add(num(d.executions) != null, `${fmt(d.executions)} runs`); }
  else if (id === 'org:flows') { add(num(d.flows) != null, plural(d.flows, 'flow')); add(d.runs && typeof d.runs === 'object', `${fmt(sumValues(d.runs))} runs`); }
  else if (id === 'org:jobs') { add(num(d.pending) != null, `${fmt(d.pending)} pending`); add(num(d.running) != null && d.running > 0, `${fmt(d.running)} running`); }
  else if (id === 'org:workflows') add(num(d.definitions) != null, plural(d.definitions, 'definition'));
  else if (id === 'provider:storage') add(Array.isArray(d.providers), plural(d.providers?.length ?? 0, 'provider'));
  else if (id.startsWith('provider:storage-route:')) add(textOf(d.provider ?? d.target), `to ${d.provider ?? d.target}`);
  else if (id === 'provider:messaging') add(num(d.endpoints) != null, plural(d.endpoints, 'endpoint'));
  else if (id.startsWith('provider:messaging-endpoint:')) { add(num(d.active) != null, `${fmt(d.active)} active`); add(num(d.deadLettered) > 0, `${fmt(d.deadLettered)} dead-lettered`); }
  else if (id === 'provider:outbox') { add(num(d.queued) != null, `${fmt(d.queued)} queued`); add(num(d.delivered) != null, `${fmt(d.delivered)} delivered`); }
  else if (id === 'provider:connectors') add(Array.isArray(d.providers) || num(d.connections) != null, Array.isArray(d.providers) ? plural(d.providers.length, 'provider') : plural(d.connections, 'connection'));
  else if (id.startsWith('connection:')) add(textOf(d.provider), `provider ${d.provider}`);
  else if (id === 'provider:secrets') add(num(d.keys ?? d.references) != null, plural(d.keys ?? d.references, 'reference'));
  else if (id.startsWith('provider:local-service:')) { add(textOf(d.service ?? d.kind), String(d.service ?? d.kind)); add(d.required === true, 'required'); }
  else if (id.startsWith('provider:service-fixture:')) add(d.operations && typeof d.operations === 'object', plural(sumValues(d.operations), 'operation'));
  else if (id.startsWith('external:webhook:')) { add(typeof d.loopback === 'boolean', d.loopback ? 'loopback' : 'not contacted'); }
  else if (id === 'app:canvas' || id === 'app:code') add(num(d.apps ?? d.sources) != null, plural(d.apps ?? d.sources, 'app'));
  else if (id === 'app:pcf') add(num(d.controls) != null, plural(d.controls, 'control'));
  else if (id === 'host:portal') add(num(d.pages) != null, plural(d.pages, 'page'));
  else if (id === 'host:identity-provider') add(num(d.providers) != null && !port, plural(d.providers, 'provider'));
  else if (id === 'bridge:live') add(textOf(d.host), String(d.host));
  else if (id.startsWith('persona-runtime:')) { add(textOf(d.context), `context ${d.context}`); add(num(d.maxInstances) != null, `up to ${d.maxInstances} sessions`); }
  else if (id.startsWith('org:pack:')) add(textOf(d.module), `module ${String(d.module).split(/[\\/]/).pop()}`);
  else if (id.startsWith('org:') && num(d.operations) != null) add(true, plural(d.operations, 'operation'));
  add(port, `port ${port}`);
  add(textOf(d.path) && !port, String(d.path));
  if (!facts.length) for (const [key, value] of Object.entries(d)) add((typeof value === 'number' || (typeof value === 'string' && value.length <= 24)) && !/url|origin|secret|token/i.test(key), `${humanize(key)} ${value}`);
  return facts;
}
const humanize = key => String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ').toLowerCase();

const tallyStatus = list => {
  const counts = { total: list.length, ready: 0, bad: 0, placeholder: 0, disabled: 0, declared: 0, planned: 0 };
  for (const item of list) {
    const status = statusOf(item.status);
    if (READY.has(status)) counts.ready += 1; else if (BAD.has(status)) counts.bad += 1; else if (status in counts) counts[status] += 1;
  }
  return counts;
};
/** Health pill for a band or group: text and tone ("5 of 6 ready", "4 planned"). */
export function healthOf(list, planned = false) {
  const c = tallyStatus(list);
  if (!c.total) return { text: 'nothing configured', short: 'none', tone: 'neutral', counts: c };
  if (planned) return { text: [c.planned && `${c.planned} planned`, c.declared && `${c.declared} declared`, c.disabled && `${c.disabled} off`, c.bad && `${c.bad} missing`].filter(Boolean).join(' · ') || 'nothing planned', short: c.bad ? `${c.bad} missing` : `${c.planned} planned`, tone: c.bad ? 'bad' : 'info', counts: c };
  const extra = [c.bad && `${c.bad} need attention`, c.placeholder && `${c.placeholder} placeholder`].filter(Boolean);
  return { text: `${c.ready} of ${c.total} ready${extra.length ? ` · ${extra.join(' · ')}` : ''}`, short: c.bad ? plural(c.bad, 'issue') : `${c.ready}/${c.total} ready`, tone: c.bad ? 'bad' : c.placeholder ? 'warn' : c.ready === c.total ? 'ok' : 'info', counts: c };
}

/**
 * Six layer bands of cards plus routed connectors. A node is a card of its own, except in the organization and provider
 * layers, where nodes join a capability group card (a group of one is shown as the node itself). Edges between nodes on the
 * same card are internal and not drawn; parallel edges between two cards merge. Every edge is drawn top to bottom
 * (`reversed` marks an edge whose source sits below its target).
 */
export function layoutTopology(nodes = [], edges = [], { columns = GEOMETRY.columns } = {}) {
  const G = { ...GEOMETRY, columns };
  const list = (Array.isArray(nodes) ? nodes : []).filter(node => node && node.id != null);
  const seen = new Set(), placed = [];
  for (const node of list) {
    const id = String(node.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const product = PRODUCT_OF(id, node.kind, node.label);
    placed.push({ ...node, id, status: statusOf(node.status), product, band: product.band });
  }
  const byBand = new Map(BANDS.map(band => [band.id, []]));
  const sortNodes = items => items.sort((a, b) => rank(a.id) - rank(b.id) || a.product.name.localeCompare(b.product.name));
  for (const band of BANDS) {
    const members = sortNodes(placed.filter(node => node.band === band.id));
    const groups = new Map();
    for (const node of members) {
      if (!node.product.group) { byBand.get(band.id).push({ type: 'node', node, nodes: [node] }); continue; }
      if (!groups.has(node.product.group)) groups.set(node.product.group, []);
      groups.get(node.product.group).push(node);
    }
    for (const group of GROUP_ORDER.filter(key => groups.has(key))) {
      const items = groups.get(group);
      byBand.get(band.id).push(items.length === 1 ? { type: 'node', node: items[0], nodes: items, group } : { type: 'group', group, nodes: items });
    }
  }
  const cellW = (G.right - G.left) / G.columns;
  const bands = [], cards = [];
  let y = G.top;
  for (const [bandIndex, band] of BANDS.entries()) {
    const bandCards = byBand.get(band.id), rows = Math.max(1, Math.ceil(bandCards.length / G.columns));
    const h = G.head + G.padTop + rows * G.cardH + (rows - 1) * G.rowGap + G.padBottom;
    const entry = { ...band, index: bandIndex, y, h, rows, cards: [] };
    bandCards.forEach((card, position) => {
      const col = position % G.columns, row = Math.floor(position / G.columns);
      const top = y + G.head + G.padTop + row * (G.cardH + G.rowGap);
      const placedCard = { ...card, index: cards.length, band: band.id, bandIndex, col, row, lastRow: rows - 1,
        x: G.left + col * cellW, w: cellW, cx: G.left + (col + 0.5) * cellW, y: top, h: G.cardH };
      cards.push(placedCard); entry.cards.push(placedCard);
    });
    bands.push(entry);
    y += h + G.gutter;
  }
  const height = y - G.gutter + G.top;
  const cardOf = new Map(cards.flatMap(card => card.nodes.map(node => [node.id, card])));
  for (const card of cards) for (const node of card.nodes) node.card = card.index;

  // Display edges: merged per card pair, oriented top to bottom.
  const merged = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = cardOf.get(String(edge?.from)), to = cardOf.get(String(edge?.to));
    if (!from || !to || from === to) continue;
    const reversed = from.bandIndex > to.bandIndex;
    const [upper, lower] = reversed ? [to, from] : [from, to];
    const key = `${from.index}>${to.index}`;
    const item = merged.get(key) ?? { from: from.index, to: to.index, upper: upper.index, lower: lower.index, reversed, kind: edge.kind, status: statusOf(edge.status), labels: [], members: [], active: false };
    if (edge.label && !item.labels.includes(String(edge.label))) item.labels.push(String(edge.label));
    if (BAD.has(statusOf(edge.status))) item.status = statusOf(edge.status);
    item.members.push({ from: String(edge.from), to: String(edge.to), kind: edge.kind, status: statusOf(edge.status), label: edge.label ?? '' });
    item.active ||= Boolean(edge.active);
    merged.set(key, item);
  }
  const routed = placeLabels([...merged.values()].map((edge, index) => ({ ...edge, index, ...route(cards[edge.upper], cards[edge.lower], bands, G) })));
  // Upstream and downstream reach per card, for the CSS path highlight.
  const forward = new Map(cards.map(card => [card.index, []])), backward = new Map(cards.map(card => [card.index, []]));
  for (const edge of routed) { forward.get(edge.from).push(edge); backward.get(edge.to).push(edge); }
  const reach = (start, next, end) => {
    const found = new Set([start]), path = new Set(), queue = [start];
    while (queue.length) for (const edge of next.get(queue.shift())) { path.add(edge.index); if (!found.has(edge[end])) { found.add(edge[end]); queue.push(edge[end]); } }
    return { cards: found, edges: path };
  };
  for (const card of cards) {
    const down = reach(card.index, forward, 'to'), up = reach(card.index, backward, 'from');
    card.related = [...new Set([...down.cards, ...up.cards])].filter(index => index !== card.index);
    card.pathEdges = [...new Set([...down.edges, ...up.edges])];
    card.upstream = backward.get(card.index); card.downstream = forward.get(card.index);
  }
  return { columns: G.columns, geometry: G, height, bands, cards, edges: routed, nodes: placed };
}

/** Orthogonal connector points from the upper card to the lower card, through column gaps, gutter lanes and the right-hand trunk lanes. */
function route(upper, lower, bands, G) {
  const cellW = (G.right - G.left) / G.columns;
  const gapX = card => G.left + card.col * cellW;
  const bottom = card => card.y + card.h, half = G.rowGap / 2;
  const exit = (card, lane) => (card.row < card.lastRow
    ? [[card.cx, bottom(card)], [card.cx, bottom(card) + half], [gapX(card), bottom(card) + half], [gapX(card), lane]]
    : [[card.cx, bottom(card)], [card.cx, lane]]);
  const enter = (card, lane) => (card.row === 0
    ? [[card.cx, lane], [card.cx, card.y]]
    : [[gapX(card), lane], [gapX(card), card.y - half], [card.cx, card.y - half], [card.cx, card.y]]);
  const band = bands[upper.bandIndex];
  let points; const lanes = [];
  if (upper.bandIndex === lower.bandIndex) {
    const lane = band.y + band.h - 11; lanes.push(lane);
    points = [...exit(upper, lane), ...exit(lower, lane).reverse()];
  } else {
    const exitLane = band.y + band.h + 15; lanes.push(exitLane);
    if (lower.bandIndex === upper.bandIndex + 1) points = [...exit(upper, exitLane), ...enter(lower, exitLane)];
    else {
      const entryLane = bands[lower.bandIndex].y - 16, trunk = G.right + 0.012 + upper.bandIndex * 0.006; lanes.push(entryLane);
      points = [...exit(upper, exitLane), [trunk, exitLane], [trunk, entryLane], ...enter(lower, entryLane)];
    }
  }
  const clean = [];
  for (const point of points) {
    const last = clean.at(-1);
    if (last && Math.abs(last[0] - point[0]) < 1e-9 && Math.abs(last[1] - point[1]) < 1e-9) continue;
    const before = clean.at(-2);
    if (before && last && ((Math.abs(before[0] - last[0]) < 1e-9 && Math.abs(last[0] - point[0]) < 1e-9) || (before[1] === last[1] && last[1] === point[1]))) clean[clean.length - 1] = point;
    else clean.push(point);
  }
  const segments = clean.slice(1).map((point, index) => [clean[index], point]);
  const horizontal = segments.filter(([a, b]) => a[1] === b[1] && lanes.includes(a[1])).sort((a, b) => Math.abs(b[1][0] - b[0][0]) - Math.abs(a[1][0] - a[0][0]))[0];
  const labelAt = horizontal ? [(horizontal[0][0] + horizontal[1][0]) / 2, horizontal[0][1] - 5] : [clean[0][0] + 0.006, (clean[0][1] + clean.at(-1)[1]) / 2];
  return { points: clean, segments, labelAt };
}

// Label boxes never overlap: each label tries its lane point, then alternates below/above it, then slides along the lane.
// Widths are estimated for the narrowest wired canvas (880 px), so on wider canvases the real gaps only grow.
export const LABEL = Object.freeze({ canvas: 880, charWidth: 6.6, pad: 10, height: 13 });
function placeLabels(edges) {
  const boxes = [];
  const box = (x, y, text) => { const half = (text.length * LABEL.charWidth + LABEL.pad) / LABEL.canvas / 2; return { x1: x - half, x2: x + half, y1: y - LABEL.height + 2, y2: y + 3 }; };
  const free = candidate => boxes.every(other => candidate.x2 <= other.x1 || other.x2 <= candidate.x1 || candidate.y2 <= other.y1 || other.y2 <= candidate.y1);
  const offsets = [0, 18, -14, 32, -28];
  const slides = [0, 0.06, -0.06, 0.12, -0.12];
  for (const edge of [...edges].sort((a, b) => a.labelAt[1] - b.labelAt[1] || a.labelAt[0] - b.labelAt[0])) {
    const text = edge.labels.join(', ') || EDGE_KINDS[kindOf(edge.kind)];
    const [x, y] = edge.labelAt;
    let chosen = null;
    for (const slide of slides) { for (const dy of offsets) { const candidate = box(x + slide, y + dy, text); if (free(candidate)) { chosen = [x + slide, y + dy, candidate]; break; } } if (chosen) break; }
    chosen ??= [x, y, box(x, y, text)];
    boxes.push(chosen[2]);
    edge.labelAt = [chosen[0], chosen[1]];
    edge.labelBox = chosen[2];
  }
  return edges;
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

const EDGE_KINDS = Object.freeze({ http: 'HTTP request', reads: 'reads', bus: 'message bus', storage: 'storage', webhook: 'web hook', process: 'in-process' });
const kindOf = kind => (Object.hasOwn(EDGE_KINDS, kind) ? kind : 'http');
const pct = value => `${(value * 100).toFixed(3)}%`;
const iconFor = (icons, name) => (typeof icons?.icon === 'function' ? icons.icon(name) : '');
const glyph = (icons, name, family, label) => `<span class="dm-glyph dm-fam-${e(family)}">${iconFor(icons, name) || `<span class="dm-monogram" aria-hidden="true">${e(String(label ?? '?').trim().charAt(0).toUpperCase() || '?')}</span>`}</span>`;
const statusText = status => STATUS_TEXT[statusOf(status)];
const levelText = level => (textOf(level) ? String(level) : null);

const edgeLabel = edge => edge.labels.join(', ') || EDGE_KINDS[kindOf(edge.kind)];
const ownersOf = (edge, cards) => cards.filter(card => card.index < HIGHLIGHT_LIMIT && card.pathEdges.includes(edge.index)).map(card => ` dm-p${card.index}`).join('');
const wireLabel = (edge, cards) => `<text class="dm-wire-label${ownersOf(edge, cards)}" x="${pct(edge.labelAt[0])}" y="${edge.labelAt[1]}" text-anchor="middle">${e(edgeLabel(edge))}</text>`;
function wire(edge, cards, planned) {
  const kind = kindOf(edge.kind), from = cards[edge.from], to = cards[edge.to];
  const lines = edge.segments.map(([a, b], index) => {
    const first = index === 0, last = index === edge.segments.length - 1;
    const marker = edge.reversed ? (first ? ' marker-start="url(#dm-arrow)"' : '') : (last ? ' marker-end="url(#dm-arrow)"' : '');
    return `<line class="dm-seg" x1="${pct(a[0])}" y1="${a[1]}" x2="${pct(b[0])}" y2="${b[1]}"${marker}></line>`;
  }).join('');
  const inner = kind === 'process' ? edge.segments.map(([a, b]) => `<line class="dm-seg-inner" x1="${pct(a[0])}" y1="${a[1]}" x2="${pct(b[0])}" y2="${b[1]}"></line>`).join('') : '';
  const active = !planned && edge.active;
  const pulse = active ? edge.segments.map(([a, b]) => `<line class="dm-pulse" x1="${pct(a[0])}" y1="${a[1]}" x2="${pct(b[0])}" y2="${b[1]}"></line>`).join('') : '';
  const label = edgeLabel(edge), owners = ownersOf(edge, cards);
  const fromName = from.type === 'group' ? GROUPS[from.group].title : from.node.product.name, toName = to.type === 'group' ? GROUPS[to.group].title : to.node.product.name;
  return `<g class="dm-wire is-${kind} is-${e(statusOf(edge.status))}${active ? ' is-active' : ''}${owners}" data-edge="${e(edge.members[0].from)}→${e(edge.members[0].to)}" data-from-card="${edge.from}" data-to-card="${edge.to}">`
    + `<title>${e(`${fromName} → ${toName}: ${label} (${EDGE_KINDS[kind]})`)}</title>${lines}${inner}${pulse}</g>`;
}

const cardName = card => (card.type === 'group' ? GROUPS[card.group].title : card.node.product.name);
function connectionsText(card, layout) {
  const names = (list, end) => [...new Set(list.map(edge => `${cardName(layout.cards[edge[end]])}${edge.labels.length ? ` (${edge.labels.join(', ')})` : ''}`))];
  const from = names(card.upstream, 'from'), to = names(card.downstream, 'to');
  const parts = [from.length && `From ${from.join(', ')}`, to.length && `To ${to.join(', ')}`].filter(Boolean);
  return parts.length ? `${parts.join('. ')}.` : 'No connections.';
}
const highlightClasses = card => `${card.index < HIGHLIGHT_LIMIT ? ` dm-k${card.index}` : ''}${(card.related ?? []).filter(index => index < HIGHLIGHT_LIMIT).map(index => ` dm-p${index}`).join('')}`;

function nodeCard(card, layout, { id, icons, planned }) {
  const node = card.node, status = statusOf(node.status), product = node.product;
  const level = levelText(node.level), facts = factsOf(node);
  const factLine = [level, ...facts.slice(0, level ? 1 : 2)].filter(Boolean).join(' · ') || (planned ? 'from configuration' : ' ');
  return `<div class="dm-card dm-node is-${status}${highlightClasses(card)}${card.col >= layout.columns - 2 ? ' dm-end' : ''}" role="button" tabindex="0" data-node="${e(node.id)}" id="${e(id)}-node-${e(nodeKey(node.id))}"`
    + ` aria-label="${e(`${product.name}: ${statusText(status).toLowerCase()}`)}" title="${e(node.id)}">`
    + `<span class="dm-card-head">${glyph(icons, product.icon, status === 'disabled' ? 'off' : product.family, product.name)}`
    + `<span class="dm-status is-${status}"><span class="dm-dot" aria-hidden="true"></span>${e(statusText(status))}</span></span>`
    + `<span class="dm-name">${e(product.name)}</span><span class="dm-facts">${e(factLine)}</span>`
    + `<span class="dm-links">${e(connectionsText(card, layout))}</span></div>`;
}

const LEVEL_ORDER = ['behaviour', 'native-qualified', 'contract', 'inventory'];
/** Donut ring of status/level counts: segments as dash arrays on circles (no inline styles). */
function ring(segments, { size = 28, stroke = 4, className = 'dm-ring' } = {}) {
  const radius = (size - stroke) / 2, circumference = 2 * Math.PI * radius, total = segments.reduce((all, item) => all + item.value, 0) || 1;
  let offset = 0;
  const arcs = segments.filter(item => item.value > 0).map(item => {
    const length = (item.value / total) * circumference;
    const arc = `<circle class="dm-arc is-${e(item.tone)}" cx="${size / 2}" cy="${size / 2}" r="${radius.toFixed(2)}" fill="none" stroke-width="${stroke}" stroke-dasharray="${Math.max(0, length - 1.2).toFixed(2)} ${(circumference - Math.max(0, length - 1.2)).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"></circle>`;
    offset += length;
    return arc;
  }).join('');
  return `<svg class="${className}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true" focusable="false"><circle class="dm-arc-track" cx="${size / 2}" cy="${size / 2}" r="${radius.toFixed(2)}" fill="none" stroke-width="${stroke}"></circle>${arcs}</svg>`;
}
const groupSegments = nodes => {
  const by = tone => nodes.filter(tone).length;
  return [
    { tone: 'ok', value: by(node => READY.has(node.status) && ['behaviour', 'native-qualified'].includes(node.level)) },
    { tone: 'info', value: by(node => READY.has(node.status) && !['behaviour', 'native-qualified'].includes(node.level)) },
    { tone: 'planned', value: by(node => node.status === 'planned' || node.status === 'declared') },
    { tone: 'warn', value: by(node => node.status === 'placeholder') },
    { tone: 'off', value: by(node => node.status === 'disabled' || node.status === 'unknown') },
    { tone: 'bad', value: by(node => BAD.has(node.status)) },
  ];
};
function groupCard(card, layout, { id, icons, planned }) {
  const group = GROUPS[card.group], nodes = card.nodes, health = healthOf(nodes, planned);
  const levels = LEVEL_ORDER.map(level => [level, nodes.filter(node => node.level === level).length]).filter(([, count]) => count);
  const placeholders = nodes.filter(node => node.status === 'placeholder').length;
  const fact = (levels.length ? levels.map(([level, count]) => `${count} ${level}`) : [placeholders ? `${placeholders} placeholder` : plural(nodes.length, 'module')])
    .reduce((text, part) => (!text ? part : `${text} · ${part}`.length <= 22 ? `${text} · ${part}` : text), '');
  const summary = `${group.title}: ${plural(nodes.length, 'module')}, ${health.text}${levels.length ? ` (${levels.map(([level, count]) => `${count} ${level}`).join(', ')})` : ''}`;
  const members = nodes.map(node => {
    const status = statusOf(node.status), level = levelText(node.level);
    return `<li><div class="dm-member is-${status}" role="button" tabindex="0" data-node="${e(node.id)}" id="${e(id)}-node-${e(nodeKey(node.id))}" aria-label="${e(`${node.product.name}: ${statusText(status).toLowerCase()}`)}" title="${e(node.id)}">`
      + `<span class="dm-dot is-${status}" aria-hidden="true"></span><span class="dm-member-name">${e(node.product.name)}</span>`
      + `<span class="dm-member-state">${e([statusText(status), level].filter(Boolean).join(' · '))}</span></div></li>`;
  }).join('');
  return `<details class="dm-card dm-group dm-fam-${e(group.family)}${health.counts.bad ? ' is-error' : ''}${highlightClasses(card)}${card.col >= layout.columns - 2 ? ' dm-end' : ''}" data-ui-section="dashboard-group:${e(card.group)}" id="${e(id)}-group-${e(card.group)}">`
    + `<summary class="dm-group-face" id="${e(id)}-group-${e(card.group)}-summary" aria-label="${e(summary)}">`
    + `<span class="dm-card-head"><span class="dm-ringed dm-fam-${e(group.family)}">${ring(groupSegments(nodes), { size: 34, stroke: 3.5 })}${iconFor(icons, group.icon)}</span>`
    + `<span class="dm-status is-${health.tone}"><span class="dm-dot" aria-hidden="true"></span>${e(health.short)}</span></span>`
    + `<span class="dm-name">${e(group.title)}</span>`
    + `<span class="dm-facts">${e(fact)}</span><span class="dm-links">${e(connectionsText(card, layout))}</span><span class="dm-chevron" aria-hidden="true"></span></summary>`
    + `<div class="dm-pop" role="group" aria-label="${e(`${group.title} modules`)}"><p class="dm-pop-head">${e(group.title)} · ${e(plural(nodes.length, 'module'))}</p><ul class="dm-members">${members}</ul></div></details>`;
}

const EDGE_LEGEND = [['http', 'HTTP request'], ['process', 'in-process call'], ['bus', 'message bus'], ['storage', 'storage'], ['webhook', 'web hook'], ['reads', 'reads']];
function legend(planned) {
  const swatch = kind => `<svg class="dm-swatch" viewBox="0 0 28 8" width="28" height="8" aria-hidden="true" focusable="false"><g class="dm-wire is-${kind}"><line class="dm-seg" x1="1" y1="4" x2="27" y2="4"></line>${kind === 'process' ? '<line class="dm-seg-inner" x1="1" y1="4" x2="27" y2="4"></line>' : ''}</g></svg>`;
  const statuses = ['listening', 'ready', 'planned', 'declared', 'placeholder', 'disabled', 'missing', 'error'];
  return `<div class="dm-legend"><ul class="dm-legend-list" aria-label="Status legend">${statuses.map(status => `<li><span class="dm-dot is-${status}" aria-hidden="true"></span><strong>${STATUS_TEXT[status]}</strong> ${e(STATUS_MEANING[status])}</li>`).join('')}</ul>`
    + `<ul class="dm-legend-list dm-legend-edges" aria-label="Connection legend">${EDGE_LEGEND.map(([kind, text]) => `<li>${swatch(kind)}<strong>${e(text)}</strong></li>`).join('')}`
    + `${planned ? '' : `<li><svg class="dm-swatch" viewBox="0 0 28 8" width="28" height="8" aria-hidden="true" focusable="false"><g class="dm-wire is-http is-active"><line class="dm-seg" x1="1" y1="4" x2="27" y2="4"></line><line class="dm-pulse" x1="1" y1="4" x2="27" y2="4"></line></g></svg><strong>active</strong> counters moved since the previous refresh</li>`}</ul></div>`;
}

/** The layered map: bands of cards, the connector SVG (role="img" with a text summary), and the legend. */
export function renderTopology(layout, { mode = 'live', id = 'dashboard-topology', icons } = {}) {
  const planned = mode === 'planned';
  const total = layout.nodes.length, ready = layout.nodes.filter(node => READY.has(node.status)).length;
  const counts = STATUSES.map(status => [status, layout.nodes.filter(node => node.status === status).length]).filter(([, count]) => count);
  const summary = `${BANDS.length} layers, ${plural(total, 'component')}, ${planned ? `${counts.find(([status]) => status === 'planned')?.[1] ?? 0} planned` : `${ready} ready`}; ${plural(layout.edges.length, 'connection')}`
    + `${counts.length ? ` (${counts.map(([status, count]) => `${count} ${status}`).join(', ')})` : ''}.`;
  const markers = `<defs><marker id="dm-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="dm-arrow" d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>`;
  const wires = `<svg class="dm-wires" role="img" aria-labelledby="${e(id)}-title ${e(id)}-desc" width="100%" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">`
    + `<title id="${e(id)}-title">${planned ? 'Planned system map' : 'Running system map'}</title><desc id="${e(id)}-desc">${e(summary)}</desc>${markers}`
    + `<g class="dm-wire-layer">${layout.edges.map(edge => wire(edge, layout.cards, planned)).join('')}</g></svg>`;
  const bands = layout.bands.map((band, index) => {
    const members = band.cards.flatMap(card => card.nodes), health = healthOf(members, planned);
    const cards = band.cards.map(card => (card.type === 'group' ? groupCard(card, layout, { id, icons, planned }) : nodeCard(card, layout, { id, icons, planned }))).join('');
    return `<section class="dm-band dm-band-${band.id} dm-rows-${band.rows}" aria-labelledby="${e(id)}-band-${band.id}">`
      + `<header class="dm-band-head"><span class="dm-band-index" aria-hidden="true">${index + 1}</span><h3 id="${e(id)}-band-${band.id}">${e(band.title)}</h3>`
      + `<span class="dm-pill is-${health.tone}">${e(health.text)}</span><p class="dm-band-desc">${e(band.description)}</p></header>`
      + `<div class="dm-cards">${cards || `<p class="dm-band-empty">${planned ? 'Nothing in this layer is configured yet.' : 'Nothing in this layer is running.'}</p>`}</div></section>`;
  }).join('');
  return `<div class="dm-map" data-dashboard-mode="${planned ? 'planned' : 'live'}">${legend(planned)}`
    + `<div class="dm-frame"><div class="dm-canvas" data-columns="${layout.columns}">${wires}${bands}`
    + `<svg class="dm-wire-labels" width="100%" height="${layout.height}" aria-hidden="true" focusable="false">${layout.edges.map(edge => wireLabel(edge, layout.cards)).join('')}</svg></div></div></div>`;
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
  if (!kit?.table || !kit?.kv) throw new TypeError('dashboard-map needs options.kit: import * as kit from "./ui-kit.mjs" and pass it.');
  return kit;
};
const viewName = link => String(link).slice(1).split('?')[0];
// A detail value as readable text: primitives as-is, flat lists joined, flat maps as "key value" pairs; deeper values as compact JSON.
function factValue(kit, value) {
  if (value === null || value === undefined) return '<span class="dm-muted">none</span>';
  if (typeof value !== 'object') return kit.escapeHtml(typeof value === 'boolean' ? (value ? 'yes' : 'no') : value);
  if (Array.isArray(value) && value.every(item => item === null || typeof item !== 'object')) return value.length ? kit.escapeHtml(value.join(', ')) : '<span class="dm-muted">none</span>';
  if (!Array.isArray(value) && Object.values(value).every(item => item === null || typeof item !== 'object'))
    return Object.keys(value).length ? kit.escapeHtml(Object.entries(value).map(([key, item]) => `${humanize(key)} ${item === true ? 'yes' : item === false ? 'no' : item ?? 'none'}`).join(' · ')) : '<span class="dm-muted">none</span>';
  return `<code>${kit.escapeHtml(JSON.stringify(value))}</code>`;
}

/**
 * Drawer for one node: product name, status with its meaning, level, safe facts, connections (when `payload` is passed),
 * the owning view link and its reference doc. Keeps `#dashboard-drawer`, `.ui-drawer` and `[data-drawer-close]`.
 */
export function renderNodeDetail(node, docs, { kit, icons, payload } = {}) {
  needKit(kit);
  const id = `node-detail-${String(node.id).replace(/[^a-z0-9-]+/gi, '-')}`;
  const product = PRODUCT_OF(node.id, node.kind, node.label), status = statusOf(node.status);
  const facts = Object.entries(node.detail ?? {}).map(([label, value]) => [humanize(label).replace(/^./, char => char.toUpperCase()), factValue(kit, value)]);
  const link = typeof node.link === 'string' && /^#[a-z][a-z0-9-]*(?:\?[^\s"'<>]*)?$/i.test(node.link) ? node.link : null;
  const nameOf = target => { const item = (payload?.nodes ?? []).find(entry => String(entry.id) === target); return PRODUCT_OF(target, item?.kind, item?.label).name; };
  const edges = (payload?.edges ?? []).filter(edge => String(edge.from) === String(node.id) || String(edge.to) === String(node.id));
  const connections = edges.length ? `<h4 class="dm-drawer-sub">Connections</h4><ul class="dm-drawer-links">${edges.map(edge => {
    const outgoing = String(edge.from) === String(node.id);
    return `<li>${outgoing ? 'To' : 'From'} <strong>${e(nameOf(String(outgoing ? edge.to : edge.from)))}</strong> · ${e(edge.label || EDGE_KINDS[kindOf(edge.kind)])} <span class="dm-muted">(${e(EDGE_KINDS[kindOf(edge.kind)])}, ${e(statusOf(edge.status))})</span></li>`;
  }).join('')}</ul>` : '';
  return `<section class="ui-drawer dm-drawer" id="dashboard-drawer" tabindex="-1" data-node-detail="${e(node.id)}" aria-labelledby="${e(id)}"><div class="ui-drawer-head dm-drawer-head">`
    + `${glyph(icons, product.icon, product.family, product.name)}<h3 id="${e(id)}">${e(product.name)}</h3>`
    + `${kit.statusBadge(node.status)}${node.level ? ` ${kit.levelBadge(node.level)}` : ''}<button type="button" class="ui-button ui-small" data-drawer-close aria-label="Close details">Close</button></div>`
    + `<p class="dm-drawer-meaning">${e(`${statusText(status)}: ${STATUS_MEANING[status] ?? 'status not reported'}.`)}</p>`
    + `${kit.kv([...facts, ['Component id', `<code>${e(node.id)}</code>`], ...(node.kind ? [['Kind', e(node.kind)]] : [])])}${connections}`
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

const storageTotal = (activity, name) => (activity?.storage?.byProvider ?? []).reduce((total, item) => total + (Number(item[name]) || 0), 0);
const flowRuns = flows => ['running', 'succeeded', 'failed', 'cancelled', 'waiting'].reduce((total, key) => total + (num(flows?.[key]) ?? 0), 0);
// KPI tiles. counter: cumulative since start (the sparkline plots the change per refresh); gauge: a current level.
export const KPIS = Object.freeze([
  { key: 'requests', label: 'Requests', type: 'counter', value: a => num(a?.requests?.total), detail: a => (a?.requests ? `portal pages · ${fmt(a.requests.retained ?? a.requests.recent?.length ?? 0)} retained` : 'no portal on this runtime') },
  { key: 'webApi', label: 'Web API', type: 'counter', value: a => num(a?.dataverseRequests?.total), detail: a => `${fmt(a?.dataverseRequests?.other ?? 0)} other · ${fmt(a?.dataverseRequests?.failed ?? 0)} failed`, tone: a => (a?.dataverseRequests?.failed ? 'warn' : 'info') },
  { key: 'plugins', label: 'Plug-in runs', type: 'counter', value: a => num(a?.plugins?.executions), detail: a => `${fmt(a?.plugins?.failures ?? 0)} failed`, tone: a => (a?.plugins?.failures ? 'bad' : 'ok') },
  { key: 'flows', label: 'Flow runs', type: 'counter', value: a => (a?.flows ? flowRuns(a.flows) : null), detail: a => `${fmt(a?.flows?.failed ?? 0)} failed · ${fmt(a?.flows?.waiting ?? 0)} waiting`, tone: a => (a?.flows?.failed ? 'bad' : 'ok') },
  { key: 'jobs', label: 'Jobs pending', type: 'gauge', value: a => num(a?.jobs?.pending), detail: a => `${fmt(a?.jobs?.running ?? 0)} running · ${fmt(a?.jobs?.poisoned ?? 0)} poisoned`, tone: a => (a?.jobs?.poisoned ? 'bad' : 'neutral') },
  { key: 'messages', label: 'Messages', type: 'gauge', value: a => num(a?.messages?.active), detail: a => `${fmt(a?.messages?.deadLettered ?? 0)} dead-lettered · ${fmt(a?.messages?.entities ?? 0)} queues`, tone: a => (a?.messages?.deadLettered ? 'warn' : 'neutral') },
  { key: 'outbox', label: 'Outbox', type: 'gauge', value: a => num(a?.outbox?.queued), detail: a => `${fmt(a?.outbox?.delivered ?? 0)} captured · ${fmt(a?.outbox?.failed ?? 0)} failed`, tone: a => (a?.outbox?.failed ? 'warn' : 'neutral') },
  { key: 'storage', label: 'Storage writes', type: 'counter', value: a => (a?.storage?.byProvider ? storageTotal(a, 'writes') : null), detail: a => `${fmt(storageTotal(a, 'deletes'))} deletes · ${fmt(storageTotal(a, 'bytesWritten'))} bytes` },
]);

/** The activity series for sparklines: `history` (oldest first) plus the current activity, at most `points` long. */
export function activitySeries(history, activity, points = 12) {
  const past = (Array.isArray(history) ? history : []).filter(item => item && typeof item === 'object' && item !== activity);
  return [...past, ...(activity ? [activity] : [])].slice(-points);
}
/** Sparkline values for a KPI: per-refresh change for counters (first point dropped), raw values for gauges. */
export function sparkValues(kpi, series) {
  const values = series.map(item => kpi.value(item));
  if (kpi.type !== 'counter') return values.map(value => value ?? 0);
  return values.slice(1).map((value, index) => Math.max(0, (value ?? 0) - (values[index] ?? 0)));
}
export function sparkline(values, { width = 100, height = 26 } = {}) {
  if (values.length < 2) return `<svg class="dm-spark is-empty" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" focusable="false"><line class="dm-spark-base" x1="0" y1="${height - 1}" x2="${width}" y2="${height - 1}" vector-effect="non-scaling-stroke"></line></svg>`;
  const max = Math.max(...values), min = Math.min(0, ...values), span = max - min, flat = span === 0;
  const points = values.map((value, index) => [(index / (values.length - 1)) * width, flat ? height / 2 : height - 2 - ((value - min) / span) * (height - 4)]);
  const line = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<svg class="dm-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true" focusable="false">`
    + (flat ? '' : `<polygon class="dm-spark-area" points="0,${height} ${line} ${width},${height}"></polygon>`)
    + `<polyline class="dm-spark-line" points="${line}" fill="none" vector-effect="non-scaling-stroke"></polyline></svg>`;
}

function kpiTiles(activity, series, previous, icons) {
  const delta = (kpi) => {
    const now = kpi.value(activity), before = previous ? kpi.value(previous) : null;
    if (now == null || before == null) return '<span class="dm-delta is-flat"><span class="ui-sr-only">no earlier refresh to compare</span></span>';
    const change = now - before;
    const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
    const arrow = change > 0 ? 'arrowUp' : change < 0 ? 'arrowDown' : 'minus';
    return `<span class="dm-delta is-${direction}">${iconFor(icons, arrow) || (change > 0 ? '▲' : change < 0 ? '▼' : '–')}<span>${change === 0 ? 'no change' : `${change > 0 ? '+' : '−'}${fmt(Math.abs(change))}`}</span><span class="ui-sr-only"> since the previous refresh</span></span>`;
  };
  const tiles = KPIS.map(kpi => {
    const value = kpi.value(activity), values = sparkValues(kpi, series);
    const trend = values.length >= 2 ? `${kpi.type === 'counter' ? 'change per refresh' : 'level'}, last ${values.length} refreshes` : 'trend appears after two refreshes';
    return `<li class="dm-kpi is-${kpi.tone?.(activity) ?? 'info'}" data-kpi="${kpi.key}"><span class="dm-kpi-label">${e(kpi.label)}</span>`
      + `<span class="dm-kpi-row"><strong class="dm-kpi-value">${e(fmt(value))}</strong>${delta(kpi)}</span>`
      + `${sparkline(values)}<span class="dm-kpi-detail">${e(kpi.detail(activity))}</span><span class="dm-kpi-trend">${e(trend)}</span></li>`;
  });
  const codes = Object.entries(activity?.diagnostics?.byCode ?? {}).sort((a, b) => b[1] - a[1]);
  const diagnostics = num(activity?.diagnostics?.total) ?? 0;
  tiles.push(`<li class="dm-kpi dm-kpi-diagnostics is-${diagnostics ? 'warn' : 'ok'}" data-kpi="diagnostics"><span class="dm-kpi-label">Diagnostics</span>`
    + `<span class="dm-kpi-row"><strong class="dm-kpi-value">${e(fmt(diagnostics))}</strong></span>`
    + `<span class="dm-kpi-top">${codes.length ? `Top <code>${e(codes[0][0])}</code> ×${e(fmt(codes[0][1]))}` : 'No diagnostics recorded'}</span>`
    + `<span class="dm-kpi-detail">${codes.length > 1 ? `${e(plural(codes.length, 'code'))} in total` : 'see Render & diagnostics'}</span></li>`);
  return `<section class="dm-kpis" aria-labelledby="dashboard-kpi-title"><h2 id="dashboard-kpi-title" class="ui-sr-only">Activity since start</h2><ul class="dm-kpi-list">${tiles.join('')}</ul></section>`;
}

const KIND_NAMES = Object.freeze({ 'power-pages': 'Power Pages runtime', 'dataverse-api': 'Dataverse API runtime', 'model-driven': 'Model-driven runtime' });
function hero(payload, { planned, starting, preflight, now, icons }) {
  const runtime = payload.runtime ?? {}, nodes = (payload.nodes ?? []).map(node => ({ ...node, status: statusOf(node.status) }));
  const c = tallyStatus(nodes), total = c.total;
  const generated = Date.parse(payload.generatedAt ?? '');
  const ago = Number.isFinite(generated) && runtime.clock !== 'fixed' ? Math.round((now - generated) / 1000) : null;
  const fresh = ago == null || ago < 0 || ago > 3600 ? 'just now' : ago < 2 ? 'just now' : `${ago} s ago`;
  const state = starting ? '<span class="dm-live is-starting"><span class="dm-live-dot" aria-hidden="true"></span>Starting · waiting for the organization</span>'
    : planned ? '<span class="dm-live is-planned"><span class="dm-live-dot" aria-hidden="true"></span>Planned · not running</span>'
      : `<span class="dm-live"><span class="dm-live-dot" aria-hidden="true"></span>Live · refreshed ${e(fresh)}</span>`;
  const chip = (label, value) => (value == null || value === '' ? '' : `<li><span>${e(label)}</span><strong>${e(value)}</strong></li>`);
  const chips = `<ul class="dm-chips">${chip('Simulation', runtime.simulationLevel ?? (planned ? 'from configuration' : 'not reported'))}${planned ? '' : chip('Clock', runtime.clock)}`
    + `${planned || runtime.revision == null ? '' : chip('Revision', runtime.revision)}${chip('Deployment profile', runtime.deploymentProfile)}${runtime.reloading ? chip('Reload', 'in progress') : ''}</ul>`;
  const origin = !planned && runtime.localOrigin ? `<p class="dm-hero-meta"><span>Origin</span> <code>${e(runtime.localOrigin)}</code>${runtime.stateFile ? ` <span>State</span> <code>${e(runtime.stateFile)}</code>` : ''}</p>` : '';
  const segments = planned ? [{ tone: 'planned', value: c.planned + c.declared }, { tone: 'off', value: c.disabled }, { tone: 'bad', value: c.bad }]
    : [{ tone: 'ok', value: c.ready }, { tone: 'planned', value: c.declared + c.planned }, { tone: 'warn', value: c.placeholder }, { tone: 'off', value: c.disabled }, { tone: 'bad', value: c.bad }];
  const headline = planned ? `${c.planned + c.declared}` : `${c.ready}`;
  const blocking = preflight && typeof preflight === 'object' ? num(preflight.summary?.blocking ?? preflight.blocking) : null;
  const stat = (tone, value, text) => `<li class="is-${tone}"><span class="dm-dot is-${tone === 'bad' ? 'error' : tone === 'warn' ? 'placeholder' : tone === 'off' ? 'disabled' : tone === 'ok' ? 'ready' : 'planned'}" aria-hidden="true"></span><strong>${e(value)}</strong> ${e(text)}</li>`;
  const stats = `<ul class="dm-hero-stats">${planned ? stat('info', c.planned + c.declared, 'planned') : stat('ok', c.ready, 'ready')}${stat('warn', c.placeholder, c.placeholder === 1 ? 'placeholder' : 'placeholders')}`
    + `${stat('bad', c.bad, c.bad === 1 ? 'error or missing' : 'errors or missing')}${stat('off', c.disabled, 'disabled')}`
    + `<li class="is-${blocking ? 'bad' : blocking === 0 ? 'ok' : 'info'}"><span class="dm-dot is-${blocking ? 'error' : blocking === 0 ? 'ready' : 'declared'}" aria-hidden="true"></span><strong>${blocking == null ? '—' : e(blocking)}</strong> preflight blocking${blocking == null ? ' (run on demand)' : ''}</li></ul>`;
  const title = KIND_NAMES[runtime.kind] ?? (runtime.kind ? `${runtime.kind} runtime` : planned ? 'Planned runtime' : 'Mirage runtime');
  return `<section class="dm-hero${planned ? ' is-planned' : ''}${starting ? ' is-starting' : ''}" aria-labelledby="dashboard-hero-title">`
    + `<div class="dm-hero-main"><div class="dm-brand"><span class="dm-mark">${iconFor(icons, 'mark')}</span><div><p class="dm-eyebrow">${e(runtime.product ?? 'Mirage')} · local Power Platform runtime</p>`
    + `<h2 id="dashboard-hero-title">${e(title)}</h2></div></div>${state}${chips}${origin}</div>`
    + (starting ? '' : `<div class="dm-hero-health" role="group" aria-label="${e(`Health: ${headline} of ${total} components ${planned ? 'planned' : 'ready'}`)}">`
    + `<div class="dm-health-ring">${ring(segments, { size: 112, stroke: 11, className: 'dm-ring dm-ring-lg' })}<span class="dm-health-value"><strong>${e(headline)}</strong><span>of ${e(total)} ${planned ? 'planned' : 'ready'}</span></span></div>${stats}</div>`)
    + (planned ? '<p class="dm-ribbon">Planned from configuration — start the preview to see live status.</p>' : '')
    + (starting ? '<p class="dm-ribbon is-starting">The runtime is starting. Components appear once the organization is ready; this page keeps polling.</p>' : '')
    + '</section>';
}

/**
 * Compose the dashboard. `mode`: 'live' reads the D5 payload, 'planned' renders configuration only, 'starting' (or a
 * `{ status: 'starting' }` payload) shows the waiting state. `history`: earlier `activity` objects, oldest first (the
 * caller keeps the last 11 or more); sparklines use the last 12 points including the current one. `preflight`: the last
 * preflight report, for the blocking count in the header. `icons`: the dashboard-icons.mjs module.
 */
export function renderDashboard(payload = {}, { mode = 'live', docs, previousActivity, help, kit, pager, history = [], icons, preflight, now = Date.now() } = {}) {
  needKit(kit);
  const starting = mode === 'starting' || payload?.status === 'starting';
  const planned = mode === 'planned', runtime = payload.runtime ?? {}, activity = payload.activity ?? {};
  const series = activitySeries(history, planned || starting ? null : activity);
  const previous = previousActivity ?? series.at(-2) ?? null;
  const nodes = payload.nodes ?? [];
  const edges = (payload.edges ?? []).map(edge => ({ ...edge, active: !planned && isActive(edge, activity, previous) }));
  const docOf = path => kit.docLink(path, docs ?? payload.docs);
  const guideFor = key => help?.[key];
  const intro = guideFor('dashboard');
  const guide = intro ? kit.guide({ key: 'dashboard', intro: intro.intro, steps: intro.steps ?? [], example: intro.example, docs: intro.doc ? [docOf(intro.doc)] : [] }) : '';
  const head = hero(payload, { planned, starting, preflight, now, icons });
  const kpis = planned || starting ? '' : kpiTiles(activity, series, previous, icons);
  const layout = layoutTopology(nodes, edges);
  const map = `<section class="ui-dash-map dm-section" aria-labelledby="dashboard-map-title"><div class="dm-section-head"><h2 id="dashboard-map-title">System map</h2>`
    + `<p class="ui-help">Six layers from the people who call this runtime down to the services it declares. Hover or focus a card to trace what it depends on and what depends on it; select it (click, Enter or Space) for its facts and the view that manages it.</p></div>`
    + `${renderTopology(layout, { mode: planned ? 'planned' : 'live', icons })}<div id="dashboard-node-detail" class="ui-drawer-slot"></div></section>`;
  if (starting) return `<div class="ui-dashboard dm-dashboard" data-dashboard-mode="starting">${head}${guide}<section class="ui-dash-map dm-section" aria-labelledby="dashboard-map-title">`
    + `<div class="dm-section-head"><h2 id="dashboard-map-title">System map</h2><p class="ui-help">The six layers fill in as soon as the organization is ready.</p></div>`
    + `<ol class="dm-skeleton">${BANDS.map((band, index) => `<li><span class="dm-band-index dm-band-${band.id}" aria-hidden="true">${index + 1}</span><strong>${e(band.title)}</strong><span>${e(band.description)}</span></li>`).join('')}</ol>`
    + '<div id="dashboard-node-detail" class="ui-drawer-slot"></div></section></div>';
  const rows = planned ? [] : activityRows(activity);
  const result = kit.pageItems(rows, pager ?? {}, { text: item => `${item.source} ${item.method ?? ''} ${item.path ?? ''} ${item.status ?? ''} ${item.code ?? ''}` });
  const feed = `<section class="ui-dash-feed dm-section" aria-labelledby="dashboard-feed-title"><h2 id="dashboard-feed-title">What is happening</h2>`
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
  const ports = configuration.ports ?? Object.fromEntries(nodes.filter(node => node.detail?.port).map(node => [PRODUCT_OF(node.id, node.kind, node.label).name, node.detail.port]));
  // Packs arrive as `{ id, module }`, Solution layers as `{ solution, version }` or folder strings; print their ids.
  const label = item => (item && typeof item === 'object' ? [item.id ?? item.solution ?? item.name ?? item.module ?? item.path, item.version].filter(part => part != null && part !== '').join(' ') : item);
  const list = value => (Array.isArray(value) ? (value.length ? value.map(item => `<code>${e(label(item))}</code>`).join(' ') : 'none') : e(value ?? 'not reported'));
  const port = value => (value === 0 ? 'free port' : value == null ? 'not used' : `<code>${e(value)}</code>`);
  const summary = kit.section({ key: 'dashboard-configuration', title: 'Configuration summary', summary: runtime.kind ?? '', body: kit.kv([
    ['Runtime', e(runtime.kind ?? 'not reported')], ['Simulation level', e(runtime.simulationLevel ?? 'not reported')],
    ['State file', runtime.stateFile ? `<code>${e(runtime.stateFile)}</code>` : 'none (in memory)'],
    ['Data packs', list(configuration.packs)], ['Solution layers', list(configuration.solutionLayers)],
    ['Settings keys present', list(configuration.settingsKeys)],
    ['Ports', Object.keys(ports).length ? Object.entries(ports).map(([name, value]) => `${e(name)} ${port(value)}`).join(' · ') : 'not reported'],
  ]) });
  return `<div class="ui-dashboard dm-dashboard" data-dashboard-mode="${planned ? 'planned' : 'live'}">${head}${guide}${kpis}${map}${feed}${blocking}${summary}</div>`;
}
