// `#activity` view module: everything the runtime did, in one workspace (D-M-1..D-M-3). One activity is one trace
// (a request, a job, a flow run); a step is a span; a finding is a diagnostic; a log line is a log stream entry. The
// filter bar IS the address: `#activity?range=&result=&who=&table=&recordId=&host=&q=&live=` (plus the "More filters"
// keys and the audit keys the old `#audit` links carry), and `#activity/<traceId>[/<spanId>]` opens an activity beside
// the list. `#activity` alone is the unfiltered list; nothing sticks that the address does not say.
// Reads: GET /trace (summaries; `result` filters by the activity's own result), /trace/stats, /trace/settings,
// /trace/id/<id>, /trace/span/<id>, /trace/spans?parentSpanId=, /audit (facts merged into rows by `traceId`; the whole
// list when tracing is off or an audit-only filter is set), /logs, /diagnostics, /render-sources; writes PUT
// /trace/settings and POST /trace/clear through ctx.request. Export is a plain link to the streamed GET
// /activity/export (bundle) or /trace/export. Live follows `/__sim/events?channels=trace&events=trace-end`, the open
// activity's own spans (`&traceId=`) and, on the Log stream tab, `channels=logs`. A tab exists only when the host serves
// its route or channel (`status.routes` / `status.eventChannels`). Each part is fetched only when the address changed
// what it shows (a key per part), and an answer is kept only while it still matches (a generation per part).
import * as kit from './ui-kit.mjs';
import { HELP } from './help-content.mjs';
import { viewCommon } from './view-common.mjs';

const ID = 'activity';
const LABEL = 'Activity';
const API = '/__sim/api';
const FILTER_FORM = 'activity-filters';
const SETTINGS_FORM = 'activity-settings-form';
const { e, failure, failed, json, fieldHelp, helpEntry, panel, pending } = viewCommon({
  id: ID,
  label: LABEL,
  kit,
  help: HELP,
});

// ---- The address
/** The filter bar (D-M-3), in the order of the bar. */
const BAR = Object.freeze(['result', 'who', 'table', 'recordId', 'host', 'q']);
/** "More filters": the trace store's other filters. */
const MORE = Object.freeze([
  'kind',
  'module',
  'operation',
  'status',
  'hasErrors',
  'from',
  'to',
  'minDurationMs',
  'session',
  'portal',
  'auditId',
]);
/** Facts only the request audit keeps (the keys `#audit` links carry): set, the Activities list reads the audit. */
const AUDIT_ONLY = Object.freeze(['path', 'provider', 'auditKind', 'httpStatus']);
/** Every filter key of the address. */
export const FILTERS = Object.freeze([...BAR, ...MORE, ...AUDIT_ONLY]);
const LABELS = {
  range: 'Time',
  result: 'Result',
  who: 'Who',
  table: 'Table',
  recordId: 'Record id',
  host: 'Host',
  q: 'Search',
  kind: 'Step kind',
  module: 'Module',
  operation: 'Operation',
  status: 'Step result',
  hasErrors: 'Failed steps',
  from: 'From',
  to: 'To',
  minDurationMs: 'Minimum duration (ms)',
  session: 'Session',
  portal: 'Portal',
  auditId: 'Audit id',
  path: 'Path',
  provider: 'Provider',
  auditKind: 'Audit kind',
  httpStatus: 'HTTP status',
  type: 'Log type',
};
/** The store's parameter names (a refused filter names one) and the address key each belongs to. */
const STORE_NAMES = {
  entity: 'table',
  search: 'q',
  sessionKey: 'session',
  actorKind: 'who',
  actorId: 'who',
  visitorId: 'who',
};
// Older keys (`#trace` links, the trace CLI and docs) and the one they become.
const ALIASES = { entity: 'table', search: 'q', sessionKey: 'session' };
const RANGES = Object.freeze({ '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000, all: null });
const RANGE_LABELS = { '5m': 'Last 5 minutes', '15m': 'Last 15 minutes', '1h': 'Last hour', '24h': 'Last 24 hours' };
/** Result (D-M-2) of an activity or a step, and what it means: the result filter, the badges and the legend. */
const RESULT_MEANINGS = Object.freeze({
  ok: 'ended without an error',
  error: 'ended with an exception, a fault or an HTTP error answer',
  denied: 'refused by a permission decision or answered 401 / 403',
  running: 'not ended yet; an activity is running while any of its steps runs',
  cancelled: 'stopped before it finished, such as a cancelled flow run or action',
});
const RESULTS = Object.keys(RESULT_MEANINGS);
const RESULT_TONES = { ok: 'ok', error: 'bad', denied: 'warn', running: 'info', cancelled: 'neutral' };
/** The request audit's outcome in Result words (D-M-2): success is ok, pending is running. */
const OUTCOME_RESULT = { success: 'ok', pending: 'running', error: 'error', denied: 'denied' };
const RESULT_OUTCOME = { ok: 'success', running: 'pending', error: 'error', denied: 'denied' };
/** The span kinds of the trace store (trace-store.mjs SPAN_KINDS); the runtime refuses any other kind filter. */
const KINDS = Object.freeze([
  'http',
  'webapi',
  'dataverse',
  'function',
  'action',
  'batch',
  'part',
  'changeset',
  'bulk',
  'store',
  'permission',
  'plugin-stage',
  'plugin-step',
  'sdk-call',
  'custom-api',
  'secret',
  'http-out',
  'webhook',
  'job',
  'workflow',
  'server-logic',
  'flow-run',
  'flow-action',
  'connector',
  'render',
  'render-template',
  'read',
  'native-service',
  'form',
  'canvas',
  'internal',
]);
/** What a step kind is called in a sentence (the Why line). */
const KIND_WORDS = {
  http: 'request',
  webapi: 'Web API call',
  dataverse: 'Dataverse operation',
  permission: 'permission check',
  'plugin-stage': 'plug-in stage',
  'plugin-step': 'plug-in step',
  'sdk-call': 'SDK call',
  'custom-api': 'custom API',
  secret: 'secret read',
  'http-out': 'outbound call',
  'flow-run': 'flow run',
  'flow-action': 'flow action',
  connector: 'connector call',
  'render-template': 'template',
  'server-logic': 'server logic',
  'native-service': 'native service',
};
/** Every module, in the order of the `ui-series-<index>` colours (ui-kit.css): one distinct colour each. */
export const MODULES = Object.freeze([
  'portal',
  'webapi',
  'dataverse',
  'security',
  'plugins',
  'clr',
  'flows',
  'connectors',
  'liquid',
  'jobs',
  'secrets',
  'webhooks',
  'native',
  'customapi',
]);
/** The origin hosts a root span names (docs/design/tracing.md, origin.host). */
const HOSTS = [
  'power-pages',
  'standalone',
  'model-driven',
  'canvas',
  'code-app',
  'dataverse-api',
  'tds',
  'soap',
  'job',
  'sim',
];
const ACTOR_KINDS = ['anonymous', 'contact', 'staff', 'app', 'system', 'flow', 'plugin'];
const AUDIT_KINDS = ['api', 'page', 'form', 'liquid-fetchxml', 'entity-read', 'entity-query'];
const LOG_TYPES = ['startup', 'request', 'liquid', 'data', 'plugin', 'diagnostic', 'reload'];
const LEVELS = ['off', 'summary', 'full'];
/** The tabs of the workspace: id, label, what the host must serve (null: always), the filter keys that apply. */
const TABS = Object.freeze([
  ['activities', 'Activities'],
  ['log', 'Log stream'],
  ['findings', 'Findings'],
  ['pages', 'Pages & render'],
  ['stats', 'Stats'],
]);
const TAB_IDS = TABS.map(([id]) => id);
const TRACE_KEYS = ['range', ...BAR, ...MORE];
const APPLIES = {
  activities: ['range', ...FILTERS],
  log: ['range', 'q', 'type'],
  findings: ['range', 'q'],
  pages: ['q'],
  stats: TRACE_KEYS,
};
const DETAIL_TABS = Object.freeze([
  ['steps', 'Steps'],
  ['log', 'Log & findings'],
  ['rendered', 'Rendered'],
  ['request', 'Request'],
  ['json', 'JSON'],
]);
const BREAKDOWNS = [
  ['kind', 'Kind', 'byKind'],
  ['module', 'Module', 'byModule'],
  ['entity', 'Table', 'byEntity'],
  ['operation', 'Operation', 'byOperation'],
  ['actor', 'Who', 'byActor'],
];
const SORTS = { start: 'Time', duration: 'Duration', spans: 'Steps', errors: 'Errors' };
// Short names in the menu; the (i) beside Export says what each holds.
const EXPORT_FORMATS = [
  ['bundle', 'Bundle'],
  ['bundle-otlp', 'Bundle (OTLP)'],
  ['ndjson', 'Activities NDJSON'],
  ['json', 'Activities JSON'],
  ['otlp', 'Activities OTLP'],
];
/** Span attributes holding the id of something another `_sim` view shows: a link there instead of plain text. */
const VIEW_LINKS = Object.freeze({
  runId: ['flow run', 'Flows & jobs', (id) => `#flows?${new URLSearchParams({ run: id })}`],
  jobId: ['system job', 'Data records', (id) => `#records?${new URLSearchParams({ entity: 'asyncoperation', id })}`],
  stepId: [
    'plug-in step',
    'Backend operations',
    (id) => `#operations?${new URLSearchParams({ key: `plugin-step:${id}` })}`,
  ],
});
/** Retention limits the settings change (mirage.trace; trace-settings.mjs validates the same ranges). */
const LIMITS = Object.freeze([
  ['traces', 'Retained activities', 10, 10_000],
  ['spansPerTrace', 'Steps per activity', 50, 20_000],
  ['payloadBytes', 'Payload bytes', 256, 1_048_576],
]);
/** Waterfall and tree indent stop here; deeper steps show their depth as a badge. */
const MAX_INDENT = 12;
/** Live reloads at most once per this many milliseconds (trailing). */
export const LIVE_INTERVAL_MS = 1000;
/** Log lines a page keeps (history plus Live); the oldest beyond it leave the page, not the server. */
const LOG_KEEP = 1000;
const LOG_HISTORY = 500;

// The search text of a span as the trace store builds it (trace-store.mjs searchText, D-R3-15), so Find steps keeps the
// steps the list's Search filter matched: metadata, attributes and events (at most 4 KB), then the captured input and
// output JSON (at most 8 KB; level full only). Built once per span object.
const SEARCH_META = 4096;
const SEARCH_PAYLOAD = 8192;
const searchTexts = new WeakMap();
function spanSearchText(span) {
  let text = searchTexts.get(span);
  if (text !== undefined) return text;
  const parts = [
    span.name,
    span.kind,
    span.module,
    span.operation,
    span.entity,
    span.recordId,
    span.actor?.name,
    span.actor?.id,
    span.error?.code,
    span.error?.message,
    JSON.stringify(span.attributes),
  ];
  let size = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
  for (const event of span.events ?? []) {
    if (size > SEARCH_META) break;
    const attributes = event.attributes ? JSON.stringify(event.attributes) : '';
    parts.push(event.type, event.message, attributes);
    size += (event.type?.length ?? 0) + (event.message?.length ?? 0) + attributes.length;
  }
  text = parts
    .filter((part) => part)
    .join('\n')
    .slice(0, SEARCH_META);
  const payload = [span.input, span.output]
    .filter((value) => value !== undefined)
    .map((value) => JSON.stringify(value))
    .join('\n');
  if (payload) text += `\n${payload.slice(0, SEARCH_PAYLOAD)}`;
  text = text.toLowerCase();
  searchTexts.set(span, text);
  return text;
}

const blankFilters = () => Object.fromEntries(FILTERS.map((name) => [name, '']));
const defaultSort = () => ({ by: 'start', order: 'desc' });
const stateOf = (ctx) => {
  const d = (ctx.data[ID] ??= {});
  d.filters ??= blankFilters();
  d.range ??= 'all';
  d.tab ??= 'activities';
  d.detail ??= 'steps';
  d.stepsAs ??= 'waterfall';
  d.breakdown ??= 'kind';
  d.sort ??= defaultSort();
  d.type ??= '';
  d.picked ??= [];
  d.spanSearch ??= '';
  d.exportFormat ??= 'bundle';
  d.generations ??= {};
  d.keys ??= {};
  d.forced ??= new Set();
  d.queued ??= new Set();
  d.liveParts ??= new Set();
  d.linked ??= {};
  d.lines ??= new Map();
  return d;
};
const short = (id) => String(id ?? '').slice(0, 8);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** A request failure kept as data, with the error code and the filter a 400 InvalidTraceFilter names. */
const failureOf = (error) => {
  const answer = error?.details?.error;
  return {
    ...failure(error),
    ...(typeof answer?.code === 'string' ? { code: answer.code } : {}),
    ...(typeof answer?.parameter === 'string' ? { parameter: answer.parameter } : {}),
  };
};
/** The list or stats answer that refused a filter (400 Invalid…Filter), or null. */
const refusedFilter = (d) =>
  [d.list, d.stats, d.logs].find((part) => part?.error && part.status === 400 && /Filter$/.test(part.code ?? '')) ??
  null;
/** A duration in ms, s, m s or h m. */
export const duration = (ms) => {
  if (ms === null || ms === undefined) return 'running';
  const value = Number(ms);
  if (value >= 3_600_000) {
    const minutes = Math.round(value / 60_000);
    return `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
  }
  if (value >= 60_000) {
    const seconds = Math.round(value / 1000);
    return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
  }
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value < 10 ? value.toFixed(2) : value.toFixed(1)} ms`;
};
const signed = (ms) => `${ms > 0 ? '+' : ms < 0 ? '−' : '±'}${duration(Math.abs(ms))}`;
/** The one time format of Monitor: local HH:MM:SS.mmm, the date and UTC on hover (ui-kit.mjs `time`). */
const when = (iso) => kit.time(iso);
const resultBadge = (result) => kit.badge(result ?? 'unknown', RESULT_TONES[result] ?? 'neutral');
/** The HTTP status as a secondary badge (D-M-2); none without a status. */
const httpBadge = (status) =>
  Number.isInteger(Number(status)) && status !== null && status !== ''
    ? ` ${kit.badge(`HTTP ${status}`, Number(status) >= 500 ? 'bad' : Number(status) >= 400 ? 'warn' : 'neutral')}`
    : '';
const errorBadges = (summary, none = '0') =>
  [
    summary.errorCount ? kit.badge(plural(summary.errorCount, 'error'), 'bad') : '',
    summary.deniedCount ? kit.badge(`${summary.deniedCount} denied`, 'warn') : '',
  ]
    .filter(Boolean)
    .map((badge) => ` ${badge}`)
    .join('') || none;
/**
 * Who (D-M-2): the actor and the session in one phrase, `Ada Member · contact:e2e00000`, `Visitor accb980f`,
 * `Anonymous`, `Staff Ann · staff:5c1e0000`; an app, plug-in, flow or system caller by its kind and name.
 */
export function whoText(actor, session) {
  const key = session?.sessionKey ?? '';
  const visitor = session?.visitorId ?? (key.startsWith('visitor:') ? key.slice(8) : null);
  const kind = actor?.kind ?? (visitor ? 'anonymous' : null);
  if (!kind) return '—';
  if (kind === 'anonymous') return visitor ? `Visitor ${short(visitor)}` : 'Anonymous';
  const name = actor.name && String(actor.name).toLowerCase() !== kind ? actor.name : null;
  const id = actor.id ? `${kind}:${short(actor.id)}` : kind;
  return name ? `${name} · ${id}` : id;
}
/** The `who` filter value that selects this actor and session, or null. */
const whoValue = (actor, session) => {
  const key = session?.sessionKey ?? '';
  const visitor = session?.visitorId ?? (key.startsWith('visitor:') ? key.slice(8) : null);
  if ((!actor || actor.kind === 'anonymous') && visitor) return `visitor:${visitor}`;
  if (!actor?.kind) return null;
  return actor.id ? `${actor.kind}:${actor.id}` : actor.kind;
};
/** The trace filters a `who` value names: anonymous, visitor:<id>, <kind>:<id>, or a bare id (any caller kind). */
export function whoFilters(value) {
  const text = String(value ?? '').trim();
  if (!text) return {};
  if (text.toLowerCase() === 'anonymous') return { actorKind: 'anonymous' };
  const at = text.indexOf(':');
  const kind = at > 0 ? text.slice(0, at).toLowerCase() : '';
  const id = at > 0 ? text.slice(at + 1).trim() : text;
  if (kind === 'visitor') return { visitorId: id };
  if (ACTOR_KINDS.includes(kind)) return id ? { actorKind: kind, actorId: id } : { actorKind: kind };
  return { actorId: text };
}
/** The contact id a `who` value names (the request audit filters by contact only), or ''. */
const whoContact = (value) => {
  const filters = whoFilters(value);
  return !filters.actorKind || filters.actorKind === 'contact' ? (filters.actorId ?? '') : '';
};
/** Colour class of a module: one distinct colour per known module, neutral grey for any other. */
const series = (module) => (MODULES.includes(module) ? `ui-series-${MODULES.indexOf(module)}` : 'ui-series-other');
const sorted = (nodes) => [...(nodes ?? [])].sort((a, b) => a.sequence - b.sequence);
const focus = (id) => globalThis.document?.getElementById(id)?.focus();
const errorText = (error) =>
  [error?.code, error?.message].filter((part) => part !== null && part !== undefined && part !== '').join(': ') ||
  'no error message';
/** A route of the portal (`/order/`), never a `/_sim` admin route or another origin. */
const pageRoute = (value) =>
  typeof value === 'string' && /^\/(?!\/)/.test(value) && !/^\/_{1,2}sim(?:\/|$)/.test(value) ? value : null;
/** The path of an http root name (`GET /order/?id=1` -> `/order/`). */
const rootPath = (name) =>
  pageRoute(
    String(name ?? '')
      .split(' ')[1]
      ?.split('?')[0] ?? '',
  );

// ---- Address <-> state
const resultList = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
/** The trace-store query of the current state; a range preset becomes `from` relative to `now`. */
export function traceQuery(d, now = Date.now()) {
  const f = d.filters ?? {};
  const query = new URLSearchParams();
  const set = (name, value) => value && query.set(name, value);
  set('result', f.result);
  for (const [name, value] of Object.entries(whoFilters(f.who))) set(name, value);
  set('entity', f.table);
  set('recordId', f.recordId);
  set('host', f.host);
  set('search', f.q);
  for (const name of ['kind', 'module', 'operation', 'status', 'hasErrors', 'from', 'to', 'minDurationMs', 'portal'])
    set(name, f[name]);
  set('sessionKey', f.session);
  set('auditId', f.auditId);
  if (RANGES[d.range] && !query.has('from')) query.set('from', new Date(now - RANGES[d.range]).toISOString());
  return query;
}
/** The request-audit query of the current state (the audit-backed list): audit keys and the bar keys it knows. */
export function auditQuery(d) {
  const f = d.filters ?? {};
  const query = new URLSearchParams();
  const set = (name, value) => value && query.set(name, value);
  set('path', f.path);
  set('provider', f.provider);
  set('kind', f.auditKind);
  set('status', f.httpStatus);
  set('entity', f.table);
  set('search', f.q);
  set('contactId', whoContact(f.who));
  // A visitor (who=visitor:<id>) or a session is the browser session the audit entry names.
  const visitor = whoFilters(f.who).visitorId;
  set('sessionKey', f.session || (visitor ? `visitor:${visitor}` : ''));
  set('correlationId', f.auditId);
  const results = resultList(f.result);
  if (results.length === 1) set('outcome', RESULT_OUTCOME[results[0]] ?? results[0]);
  return query;
}
/** The same trace filters over the equal-length window just before the current one; null without a start time. */
export function previousWindow(d, now = Date.now()) {
  const query = traceQuery(d, now);
  const from = Date.parse(query.get('from') ?? '');
  const to = query.has('to') ? Date.parse(query.get('to')) : now;
  if (!Number.isFinite(from) || !Number.isFinite(to) || !(to > from)) return null;
  const length = to - from;
  query.set('from', new Date(from - length).toISOString());
  query.set('to', new Date(from - 1).toISOString());
  return { query, length };
}
const sortQuery = (d, query) => {
  if (d.sort.by !== 'start' || d.sort.order !== 'desc') {
    query.set('sort', d.sort.by);
    query.set('order', d.sort.order);
  }
  return query;
};
/**
 * The address of a state: `activity[/<traceId>[/<spanId>]][?filters, range, tab, live, …]`. `over` replaces parts of
 * `d` (a link to another activity, span, tab or filter keeps the rest of the address).
 */
export function hashOf(d, over = {}) {
  const s = { ...d, ...over, filters: { ...d.filters, ...over.filters } };
  const params = new URLSearchParams();
  if (s.range && s.range !== 'all' && s.range !== 'custom') params.set('range', s.range);
  for (const name of FILTERS) if (s.filters[name]) params.set(name, s.filters[name]);
  if (s.tab && s.tab !== 'activities') params.set('tab', s.tab);
  if (s.type) params.set('type', s.type);
  // The display name of the Who filter (a label only, never sent to the runtime): a link from another view names it.
  if (s.filters.who && s.whoName) params.set('whoName', s.whoName);
  if (s.live) params.set('live', '1');
  if (s.reads) params.set('reads', '1');
  if (s.sort) sortQuery(s, params);
  if (s.traceId) {
    if (s.detail && s.detail !== 'steps') params.set('detail', s.detail);
    if (s.stepsAs === 'tree') params.set('steps', 'tree');
    if (s.spanSearch) params.set('spanSearch', s.spanSearch);
    if (s.errorsOnly) params.set('errorsOnly', 'true');
  }
  if (s.compare) params.set('compare', s.compare.join(','));
  const path = s.traceId
    ? `/${encodeURIComponent(s.traceId)}${s.spanId ? `/${encodeURIComponent(s.spanId)}` : ''}`
    : '';
  return `activity${path}${params.size ? `?${params}` : ''}`;
}
const hrefOf = (d, over) => `#${hashOf(d, over)}`;
/**
 * A `who` value in D-M-2 words: the name of a caller the page shows (list rows, the open activity), else its kind and
 * short id (`contact:e2e00000`, `Visitor accb980f`); the full value stays in the address.
 */
function whoLabel(d, value) {
  const people = [...(d.list?.items ?? []).map((item) => item.root), ...(d.tree?.spans ?? [])].filter(Boolean);
  const known = people.find((item) => whoValue(item.actor, item.session) === value);
  if (known) return whoText(known.actor, known.session);
  const filters0 = whoFilters(value);
  if (d.whoName)
    return `${d.whoName} · ${filters0.actorKind ? `${filters0.actorKind}:${short(filters0.actorId)}` : short(filters0.actorId ?? filters0.visitorId)}`;
  const filters = whoFilters(value);
  if (filters.visitorId) return `Visitor ${short(filters.visitorId)}`;
  if (filters.actorKind && filters.actorId) return `${filters.actorKind}:${short(filters.actorId)}`;
  return filters.actorKind ?? short(filters.actorId);
}
/** A link to an activity (and step) that keeps the current filters, tab and Live. */
const openHref = (d, traceId, spanId = null, more = {}) =>
  hrefOf(d, { traceId, spanId, detail: 'steps', spanSearch: '', errorsOnly: false, compare: null, ...more });
/** A pivot: these filters only (the range and tab stay), no open activity. */
const pivotHref = (d, filters, whoName = null) =>
  hrefOf(d, { filters: { ...blankFilters(), ...filters }, whoName, traceId: null, spanId: null, compare: null });
const syncHash = (d) => globalThis.history?.replaceState?.(null, '', `#${hashOf(d)}`);
/** `[a, b]` of a `compare=<id1>,<id2>` value; null unless it names two different ids. */
const compareOf = (value) => {
  const ids = String(value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length === 2 && ids[0] !== ids[1] ? ids : null;
};
/** Filters from an address: current keys first, older keys (`entity`, `search`, `sessionKey`, actor and visitor) after. */
function filtersOf(params) {
  const filters = Object.fromEntries(FILTERS.map((name) => [name, params.get(name)?.trim() ?? '']));
  for (const [old, name] of Object.entries(ALIASES))
    if (!filters[name] && params.get(old)) filters[name] = params.get(old);
  if (!filters.who) {
    const kind = params.get('actorKind'),
      actor = params.get('actorId'),
      visitor = params.get('visitorId');
    filters.who = visitor ? `visitor:${visitor}` : kind ? (actor ? `${kind}:${actor}` : kind) : (actor ?? '');
  }
  return filters;
}

// ---- What the host serves
/** True when the host serves the /_sim/api route `route` (status.routes), else whether a Power Pages host does. */
function served(ctx, route) {
  const state = ctx.state?.() ?? {};
  const routes = state.status?.routes ?? state.routes;
  if (Array.isArray(routes))
    return routes.some((item) => {
      const path = String(item).replace(/^\/_{1,2}sim\/api/, '');
      return route === path || route.startsWith(`${path}/`) || route.startsWith(`${path}?`);
    });
  return ctx.capabilities?.()?.powerPages !== false;
}
/** true / false when the host publishes its event channels; null when it does not say. */
const channelServed = (ctx, channel) => {
  const channels = ctx.eventChannels?.();
  return Array.isArray(channels) ? channels.includes(channel) : null;
};
const auditServed = (ctx) => served(ctx, '/audit');
const logServed = (ctx) => channelServed(ctx, 'logs') ?? served(ctx, '/logs');
/** The tabs this host serves, in order. */
export function tabsFor(ctx) {
  return TABS.filter(
    ([id]) =>
      (id !== 'log' || logServed(ctx)) &&
      (id !== 'findings' || served(ctx, '/diagnostics')) &&
      (id !== 'pages' || served(ctx, '/render-sources')),
  );
}
const tabOf = (ctx, d) => (tabsFor(ctx).some(([id]) => id === d.tab) ? d.tab : 'activities');
/** Tracing is off: no new activity is recorded (the settings say so). */
const tracingOff = (d) => d.settings?.settings?.level === 'off';
/** The Activities list reads the request audit: tracing is off, or a filter only the audit knows is set. */
const auditMode = (ctx, d) => auditServed(ctx) && (tracingOff(d) || AUDIT_ONLY.some((name) => d.filters[name]));

// ---- Loading: each part is fetched when the key of what it shows changed, or when forced (Refresh, Live).
const listKey = (ctx, d) =>
  `${auditMode(ctx, d) ? 'audit' : 'trace'}|${new URLSearchParams(Object.entries(d.filters))}|${d.range}|${d.sort.by}|${d.sort.order}|${d.reads ? 1 : 0}`;
/** The parts the current state shows, each with the key its answer must match. */
function wanted(ctx, d) {
  const parts = new Map([['settings', 'settings']]);
  const tab = tabOf(ctx, d);
  const pager = ctx.pager('activity-list');
  if (tab === 'activities') parts.set('list', `${listKey(ctx, d)}|${pager.page}|${pager.size}`);
  if (tab === 'stats') {
    parts.set('stats', `${traceQuery(d, 0)}|${d.range}`);
    parts.set('previous', `${traceQuery(d, 0)}|${d.range}`);
  }
  if (tab === 'log') parts.set('logs', `logs|${d.type}`);
  if (served(ctx, '/diagnostics')) parts.set('findings', 'findings');
  if (tab === 'pages') parts.set('pages', 'pages');
  if (d.traceId) {
    parts.set('tree', d.traceId);
    if (d.detail === 'log') parts.set('detailLog', d.traceId);
    if (d.detail === 'request' && auditServed(ctx)) parts.set('request', d.traceId);
    if (d.detail === 'rendered' && served(ctx, '/render-sources') && d.tree?.trace?.traceId === d.traceId)
      parts.set('sources', d.traceId);
  }
  if (d.compare) parts.set('compare', d.compare.join(','));
  if (d.sourcesFor && d.pages?.byRoute) parts.set('pageSources', d.sourcesFor);
  return parts;
}
async function reload(ctx, parts = []) {
  const d = stateOf(ctx);
  for (const part of parts) d.forced.add(part);
  d.queued.add('*');
  if (d.reloading) return d.reloading;
  d.reloading = (async () => {
    while (d.queued.size) {
      d.queued.clear();
      await view.load(ctx);
      ctx.render?.();
    }
  })().finally(() => {
    d.reloading = null;
  });
  return d.reloading;
}
const get = (ctx, path) => ctx.request(path).catch(failureOf);
/** The audit entries of `traceIds` (one request, ids as a comma list), grouped by trace id. */
async function auditOf(ctx, items) {
  if (!items.length || !auditServed(ctx)) return null;
  const traceId = items.map((item) => item.traceId).join(',');
  const answer = await get(ctx, `/audit?${new URLSearchParams({ traceId, pageSize: '100' })}`);
  if (answer.error) return null;
  const byTrace = {};
  for (const entry of answer.items ?? []) (byTrace[entry.traceId] ??= []).push(entry);
  for (const entries of Object.values(byTrace)) entries.sort((a, b) => a.sequence - b.sequence);
  return byTrace;
}
async function fetchList(ctx, d, now) {
  const pager = ctx.pager('activity-list');
  const paging = { page: String(pager.page || 1), pageSize: String(pager.size || kit.PAGE_SIZES[0]) };
  if (auditMode(ctx, d)) {
    const query = new URLSearchParams({ ...paging, ...Object.fromEntries(auditQuery(d)) });
    const answer = await get(ctx, `/audit?${query}`);
    return answer.error
      ? { mode: 'audit', ...answer }
      : { mode: 'audit', ...answer, items: auditRows(d, answer.items) };
  }
  const query = sortQuery(d, traceQuery(d, now));
  for (const [name, value] of Object.entries(paging)) query.set(name, value);
  const answer = await get(ctx, `/trace?${query}`);
  if (answer.error || !Array.isArray(answer.items)) return { mode: 'trace', ...answer };
  return { mode: 'trace', ...answer, audit: await auditOf(ctx, answer.items) };
}
/** The audit page as rows: more than one result, or a time range, narrow the page the audit answered. */
function auditRows(d, items = []) {
  const results = resultList(d.filters.result);
  const from = Date.parse(traceQuery(d).get('from') ?? '');
  const to = Date.parse(d.filters.to ?? '');
  // ponytail: the audit route filters one outcome and no time; other results and the range narrow this page only.
  return items.filter(
    (entry) =>
      (results.length < 2 || results.includes(OUTCOME_RESULT[entry.outcome])) &&
      (!Number.isFinite(from) || Date.parse(entry.startedAt) >= from) &&
      (!Number.isFinite(to) || Date.parse(entry.startedAt) <= to),
  );
}
/** The newest activity of each portal route (traces with a render step), for Pages & render. */
async function fetchPages(ctx) {
  const answer = await get(ctx, `/trace?${new URLSearchParams({ kind: 'render', pageSize: '200' })}`);
  if (answer.error) return answer;
  const byRoute = {};
  for (const item of answer.items ?? []) {
    const route = rootPath(item.root?.name);
    if (route && !byRoute[route]) byRoute[route] = item;
  }
  return { byRoute };
}
/** The render-template steps of a tree with a source reference, and their sources from /render-sources. */
async function fetchSources(ctx, tree) {
  const refs = [
    ...new Set(
      (tree?.spans ?? [])
        .map((span) => span.attributes?.sourceRefId)
        .filter((ref) => typeof ref === 'string' && ref)
        .slice(0, 100),
    ),
  ];
  if (!refs.length) return { items: [], missing: [] };
  return get(ctx, `/render-sources?${new URLSearchParams({ refs: refs.join(',') })}`);
}
const FETCHERS = {
  settings: (ctx) => get(ctx, '/trace/settings'),
  list: (ctx, d, now) => fetchList(ctx, d, now),
  stats: (ctx, d, now) => {
    const query = traceQuery(d, now);
    return get(ctx, `/trace/stats${query.size ? `?${query}` : ''}`);
  },
  previous: async (ctx, d, now) => {
    const previous = previousWindow(d, now);
    return previous
      ? { ...(await get(ctx, `/trace/stats?${previous.query}`)), length: previous.length }
      : { none: true };
  },
  logs: (ctx, d) =>
    get(ctx, `/logs?${new URLSearchParams({ limit: String(LOG_HISTORY), ...(d.type ? { type: d.type } : {}) })}`),
  findings: (ctx) => get(ctx, '/diagnostics'),
  pages: (ctx) => fetchPages(ctx),
  tree: (ctx, d) => get(ctx, `/trace/id/${encodeURIComponent(d.traceId)}`),
  detailLog: async (ctx, d) => {
    const traceId = d.traceId;
    const [logs, findings] = await Promise.all([
      logServed(ctx) ? get(ctx, `/logs?${new URLSearchParams({ traceId, limit: String(LOG_HISTORY) })}`) : null,
      served(ctx, '/diagnostics') ? get(ctx, `/diagnostics?${new URLSearchParams({ traceId })}`) : null,
    ]);
    return { logs, findings };
  },
  request: (ctx, d) => get(ctx, `/audit?${new URLSearchParams({ traceId: d.traceId, pageSize: '100' })}`),
  sources: (ctx, d) => fetchSources(ctx, d.tree),
  compare: async (ctx, d) =>
    Object.fromEntries(
      await Promise.all(d.compare.map(async (id) => [id, await get(ctx, `/trace/id/${encodeURIComponent(id)}`)])),
    ),
  pageSources: async (ctx, d) => {
    const item = d.pages?.byRoute?.[d.sourcesFor];
    if (!item) return { route: d.sourcesFor, items: [], missing: [] };
    const tree = await get(ctx, `/trace/id/${encodeURIComponent(item.traceId)}`);
    if (tree.error) return { route: d.sourcesFor, ...tree };
    return { route: d.sourcesFor, traceId: item.traceId, spans: tree.spans, ...(await fetchSources(ctx, tree)) };
  },
};
// Where each part's answer is kept in the view state.
const SLOTS = { compare: 'compared', pageSources: 'pageSourcesAnswer' };

// ---- Live: the trace channel (ended activities; the open activity's steps) and the log channel.
const streams = {};
/** Queue `parts` for one trailing reload at most every LIVE_INTERVAL_MS. */
function schedule(ctx, d, parts) {
  for (const part of parts) d.liveParts.add(part);
  if (d.liveTimer) return;
  d.liveTimer = setTimeout(() => {
    d.liveTimer = null;
    const next = [...d.liveParts];
    d.liveParts.clear();
    if (d.live) reload(ctx, next);
  }, LIVE_INTERVAL_MS);
}
const frameOf = (event) => {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
};
/** Opens (or keeps) the stream `name` at `url`; a stream at another url is closed first. */
function open(ctx, d, name, url, listen) {
  if (streams[name]?.url === url) return;
  close(name);
  if (typeof globalThis.EventSource !== 'function') return;
  const stream = new globalThis.EventSource(url);
  streams[name] = { url, stream };
  d.liveStatus = 'Connecting…';
  stream.addEventListener('open', () => {
    d.liveStatus = 'Streaming';
    ctx.render?.();
  });
  stream.addEventListener('error', () => {
    // An HTTP error answer (404 on a host without the stream) closes the stream for good; a dropped one reconnects.
    if (stream.readyState === globalThis.EventSource.CLOSED) return refused(ctx, d, name, url);
    d.liveStatus = 'Reconnecting…';
    ctx.render?.();
  });
  listen(stream);
}
function close(name) {
  streams[name]?.stream.close();
  delete streams[name];
}
/** The streams the state needs: Live on, the trace channel served; the log channel on the Log stream tab. */
function follow(ctx, d) {
  if (!d.live || channelServed(ctx, 'trace') === false) {
    for (const name of Object.keys(streams)) close(name);
    return;
  }
  const tab = tabOf(ctx, d);
  open(ctx, d, 'trace', '/__sim/events?channels=trace&events=trace-end', (stream) =>
    stream.addEventListener('trace', (event) => {
      const frame = frameOf(event);
      if (frame?.type !== 'trace-end') return;
      const parts = { activities: ['list'], stats: ['stats'], pages: ['pages'] }[tabOf(ctx, d)] ?? [];
      if (frame.trace?.traceId && frame.trace.traceId === d.traceId) parts.push('tree');
      schedule(ctx, d, parts);
    }),
  );
  if (d.traceId && d.tree?.trace?.status === 'running')
    open(
      ctx,
      d,
      'steps',
      `/__sim/events?channels=trace&events=span-end&traceId=${encodeURIComponent(d.traceId)}`,
      (s) =>
        s.addEventListener('trace', (event) => {
          const frame = frameOf(event);
          if (frame?.type === 'span-end' && frame.span?.traceId === d.traceId) schedule(ctx, d, ['tree']);
        }),
    );
  else close('steps');
  // With tracing off no activity ends, so the list (the request audit then) follows the log channel's request lines.
  const auditLive = tab === 'activities' && auditMode(ctx, d);
  if ((tab === 'log' || auditLive) && logServed(ctx))
    open(ctx, d, 'log', '/__sim/events?channels=logs', (stream) =>
      stream.addEventListener('log', (event) => {
        const line = frameOf(event);
        if (!line || line.type === 'connected' || !Number.isFinite(line.sequence)) return;
        keepLines(d, [line]);
        const audited = AUDITED_LINES.includes(line.type) && tabOf(ctx, d) === 'activities' && auditMode(ctx, d);
        schedule(ctx, d, audited ? ['list'] : []);
      }),
    );
  else close('log');
}
/** The log line types that carry a finished request audit entry. */
const AUDITED_LINES = ['request', 'liquid', 'data'];
/** What Live is doing: streaming, or why the list cannot follow (tracing off on a host without the log channel). */
function liveText(ctx, d) {
  if (tracingOff(d) && tabOf(ctx, d) === 'activities')
    return logServed(ctx)
      ? `Following the request audit · ${d.liveStatus ?? 'Connecting…'}`
      : 'Live needs tracing on (⚙ Settings)';
  return d.liveStatus ?? 'Connecting…';
}
/** Keeps log lines by sequence (no duplicates between history and the stream), the newest LOG_KEEP. */
function keepLines(d, lines) {
  for (const line of lines) if (Number.isFinite(line?.sequence)) d.lines.set(line.sequence, line);
  if (d.lines.size > LOG_KEEP)
    for (const sequence of [...d.lines.keys()].sort((a, b) => a - b).slice(0, d.lines.size - LOG_KEEP))
      d.lines.delete(sequence);
}
function stopLive(d) {
  for (const name of Object.keys(streams)) close(name);
  if (!d) return;
  d.liveStatus = 'Off';
  clearTimeout(d.liveTimer);
  d.liveTimer = null;
  d.liveParts?.clear();
}
/** Live turns off with a notice: a host that does not say which channels it streams is asked once (404 or not). */
async function refused(ctx, d, name, url) {
  if (streams[name]?.url !== url) return;
  stopLive(d);
  d.live = false;
  syncHash(d);
  let status = null;
  if (channelServed(ctx, name === 'log' ? 'logs' : 'trace') === null)
    try {
      const response = await fetch(url, { cache: 'no-store', headers: { accept: 'text/event-stream' } });
      status = response.status;
      response.body?.cancel().catch(() => {});
    } catch {
      // Unreachable host: the notice below says the stream closed.
    }
  d.liveRefused =
    status === 404
      ? `This host does not serve the live stream (${url.replace('/__sim/', '/_sim/')}). Refresh to see new activity.`
      : `The live stream closed${status && status !== 200 ? ` (HTTP ${status})` : ''}. Select Live to connect again, or refresh.`;
  ctx.render?.();
}

// ---- Filter bar
/**
 * One filter field with its label and help: in the bar an (i) beside the label (the bar stays one row), in More
 * filters a visible note. Either way the control is described by `<id>-help` (help-content `activity.filters`).
 */
function field(ctx, id, name, control, { tip = false, key = 'activity.filters' } = {}) {
  const text = helpEntry(ctx, key).fields?.[name] ?? '';
  const described = text ? ` aria-describedby="${id}-help"` : '';
  const help = text && tip ? kit.info({ id: `${id}-help`, label: `About ${LABELS[name]}`, text }) : '';
  return (
    `<div><label for="${id}">${e(LABELS[name])}</label>${help}${control(described)}` +
    `${text && !tip ? kit.fieldHelp(id, text) : ''}</div>`
  );
}
function select(ctx, id, name, options, value, { attrs = '', ...help } = {}) {
  if (value && !options.some(([option]) => String(value) === option))
    options = [...options, [String(value), `${value} (not a listed value)`]];
  const choices = options
    .map(
      ([option, text]) =>
        `<option value="${e(option)}"${String(value) === option ? ' selected' : ''}>${e(text)}</option>`,
    )
    .join('');
  return field(
    ctx,
    id,
    name,
    (described) => `<select id="${id}" name="${name}" data-activity-select${described}${attrs}>${choices}</select>`,
    help,
  );
}
const anyOf = (label, values) => [['', label], ...values.map((value) => [value, value])];
function input(ctx, id, name, value, { type = 'text', extra = '', ...help } = {}) {
  return field(
    ctx,
    id,
    name,
    (described) => `<input id="${id}" name="${name}" type="${type}" value="${e(value)}"${described}${extra}>`,
    help,
  );
}
/** `datetime-local` value (local wall time, seconds) of an ISO time; empty for anything else. */
const localInput = (iso) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 19) : '';
};
const FAILED = 'error,denied';
/**
 * The open tab's one-click filter, a chip like any filter that a second click clears: Errors & denied (the Result
 * filter) where Result applies, Startup (the log type) on the Log stream.
 */
const SEARCH_LABELS = {
  activities: 'Search activities',
  log: 'Search log lines',
  findings: 'Search findings',
  pages: 'Search pages',
  stats: 'Search steps',
};
/**
 * The open tab's quick text filter, inline in the toolbar row (D-M-11): the `q=` filter of the address, part of the
 * Filters form (`form=`), applied with Enter or when it is left; the drawer holds every other filter.
 */
function searchBox(tab, d) {
  const label = SEARCH_LABELS[tab] ?? 'Search';
  return `<input type="search" id="activity-q" name="q" form="${FILTER_FORM}" class="ui-activity-search" data-activity-search value="${e(d.filters.q)}" aria-label="${e(label)}" aria-keyshortcuts="/" placeholder="${e(label)}…">`;
}
function quickFilter(tab, d) {
  if (tab === 'log')
    return `<button type="button" class="ui-button ui-small" id="activity-startup" data-activity-action="startup" aria-pressed="${d.type === 'startup'}" aria-label="Startup lines only"><span class="ui-wide">Startup</span><span class="ui-narrow" aria-hidden="true">⏻</span></button>`;
  return APPLIES[tab]?.includes('result')
    ? `<button type="button" class="ui-button ui-small" id="activity-errors" data-activity-action="errors" aria-pressed="${d.filters.result === FAILED}" aria-label="Errors and denied only"><span class="ui-wide">Errors &amp; denied</span><span class="ui-narrow" aria-hidden="true">⚠</span></button>`
    : '';
}
const RESULT_CHOICES = [['', 'Any result'], [FAILED, 'error or denied'], ...RESULTS.map((result) => [result, result])];
function filterBar(ctx, d) {
  const f = d.filters;
  const more = [...MORE, ...AUDIT_ONLY].filter((name) => f[name]).length;
  const tip = { tip: true };
  const ranges = [
    ...Object.entries(RANGE_LABELS),
    ['all', 'All retained'],
    ...(d.range === 'custom' ? [['custom', 'Custom (from / to)']] : []),
  ];
  const bar =
    select(ctx, 'activity-range', 'range', ranges, d.range, tip) +
    select(ctx, 'activity-result', 'result', RESULT_CHOICES, f.result, tip) +
    input(ctx, 'activity-who', 'who', f.who, { extra: ' placeholder="contact:…, visitor:…"', ...tip }) +
    input(ctx, 'activity-table', 'table', f.table, { extra: ' placeholder="Table logical name"', ...tip }) +
    input(ctx, 'activity-record', 'recordId', f.recordId, tip) +
    select(ctx, 'activity-host', 'host', anyOf('Any host', HOSTS), f.host, tip) +
    // The Log stream's type is a filter like the others (it applies to that tab only; its chip says so elsewhere).
    (logServed(ctx)
      ? select(ctx, 'activity-log-type', 'type', anyOf('Every type', LOG_TYPES), d.type, {
          tip: true,
          key: 'activity.log',
        })
      : '');
  const moreFields =
    select(ctx, 'activity-kind', 'kind', anyOf('Any step kind', KINDS), f.kind) +
    select(ctx, 'activity-module', 'module', anyOf('Any module', MODULES), f.module) +
    input(ctx, 'activity-operation', 'operation', f.operation) +
    select(ctx, 'activity-status', 'status', anyOf('Any step result', RESULTS), f.status) +
    select(
      ctx,
      'activity-has-errors',
      'hasErrors',
      [
        ['', 'With or without failed steps'],
        ['true', 'Only with a failed step'],
        ['false', 'Only without a failed step'],
      ],
      f.hasErrors,
    ) +
    input(ctx, 'activity-from', 'from', localInput(f.from), { type: 'datetime-local', extra: ' step="1"' }) +
    input(ctx, 'activity-to', 'to', localInput(f.to), { type: 'datetime-local', extra: ' step="1"' }) +
    input(ctx, 'activity-min-duration', 'minDurationMs', f.minDurationMs, {
      type: 'number',
      extra: ' min="0" step="any"',
    }) +
    input(ctx, 'activity-session', 'session', f.session) +
    input(ctx, 'activity-portal', 'portal', f.portal) +
    input(ctx, 'activity-audit-id', 'auditId', f.auditId) +
    input(ctx, 'activity-path', 'path', f.path) +
    select(ctx, 'activity-provider', 'provider', anyOf('Any provider', ['local', 'live']), f.provider) +
    select(ctx, 'activity-audit-kind', 'auditKind', anyOf('Any audit kind', AUDIT_KINDS), f.auditKind) +
    select(
      ctx,
      'activity-http-status',
      'httpStatus',
      anyOf('Any HTTP status', ['2xx', '3xx', '4xx', '5xx', 'pending']),
      f.httpStatus,
    );
  // More filters opens on request, or when one of its filters was refused (the banner names it).
  const refused = refusedFilter(d)?.parameter;
  const moreOpen = d.more || more > 0 || [...MORE, ...AUDIT_ONLY].includes(STORE_NAMES[refused] ?? refused);
  const toggle = `<button type="button" class="ui-link-button" id="activity-more" data-activity-action="more" aria-expanded="${moreOpen}" aria-controls="activity-more-filters">More filters${more ? ` (${more})` : ''}</button>`;
  // A choice applies at once, a text field when it changes or on Enter; Apply (the drawer's footer) submits the form.
  return (
    `<form id="${FILTER_FORM}" class="ui-form ui-activity-filters" data-activity-filters role="search" aria-label="Activity filters">` +
    `<div class="ui-activity-fields">${bar}</div>${toggle}` +
    (moreOpen
      ? `<div class="ui-activity-more" id="activity-more-filters" data-ui-section="activity:more"><div class="ui-activity-fields">${moreFields}</div></div>`
      : '') +
    '</form>'
  );
}
/** The filter drawer (kit.filterDrawer): the form, then Apply and Clear all. */
const DRAWER = 'activity-filter-drawer';
function drawerOf(ctx, d) {
  return kit.filterDrawer({
    id: DRAWER,
    title: 'Filters',
    body: filterBar(ctx, d),
    footer:
      `<button type="submit" form="${FILTER_FORM}" id="activity-apply" class="ui-button ui-primary ui-small">Apply</button> ` +
      '<button type="button" class="ui-button ui-small" id="activity-clear-drawer" data-activity-action="clear-filters">Clear all</button>',
  });
}
/** The number of active filters: the Filters button shows it. */
const activeFilters = (d) =>
  FILTERS.filter((name) => d.filters[name]).length + (RANGES[d.range] ? 1 : 0) + (d.type ? 1 : 0);
/** The banner of a filter the runtime refused: which filter, why, and a way to remove it. */
function invalidFilter(d) {
  const refused = refusedFilter(d);
  if (!refused) return '';
  const store = STORE_NAMES;
  const name = store[refused.parameter] ?? refused.parameter ?? '';
  const known = FILTERS.includes(name);
  const label = known ? `${LABELS[name]} (${name})` : name || 'a';
  return (
    kit.notice(
      `The ${label} filter${known && d.filters[name] ? ` value "${d.filters[name]}"` : ''} is not valid: ${refused.error} Nothing is listed until you change or remove it.`,
      'bad',
    ) +
    (known
      ? `<p><button type="button" class="ui-button ui-small" id="activity-unfilter-invalid" data-activity-unfilter="${e(name)}">Remove the ${e(LABELS[name])} filter</button></p>`
      : '')
  );
}
const tabLabel = (id) => TABS.find(([tab]) => tab === id)?.[1] ?? id;
/** The active filters as removable chips; one that does not apply to the open tab is dimmed and says so. */
function chips(ctx, d) {
  const tab = tabOf(ctx, d);
  const items = FILTERS.filter((name) => d.filters[name]).map((name) => [
    name,
    `${LABELS[name]}: ${name === 'from' || name === 'to' ? kit.clock(d.filters[name]) || d.filters[name] : name === 'who' ? whoLabel(d, d.filters.who) : d.filters[name]}`,
  ]);
  if (RANGES[d.range]) items.unshift(['range', RANGE_LABELS[d.range]]);
  if (d.type) items.push(['type', `${LABELS.type}: ${d.type}`]);
  if (!items.length) return '';
  return (
    `<div class="ui-chips" role="group" aria-label="Active filters">${items
      .map(([name, text]) => {
        const applies = APPLIES[tab].includes(name);
        const note = applies ? '' : ` (does not apply to ${tabLabel(tab)})`;
        return `<button type="button" class="ui-chip${applies ? '' : ' is-dimmed'}" id="activity-chip-${e(name)}" data-activity-unfilter="${e(name)}" aria-label="Remove filter ${e(text)}${e(note)}"${applies ? '' : ` title="Does not apply to ${e(tabLabel(tab))}"`}>${e(text)} <span aria-hidden="true">×</span></button>`;
      })
      .join('')}` +
    '<button type="button" class="ui-button ui-small" id="activity-clear-all" data-activity-action="clear-filters">Clear all</button></div>'
  );
}
/** The line under the bar: the zone, named once, and what the list holds. */
function summaryText(ctx, d) {
  const parts = [`Times local (${kit.utcOffset()})`];
  const list = tabOf(ctx, d) === 'activities' ? d.list : null;
  if (list?.mode === 'trace' && Array.isArray(list.items)) {
    parts.push(plural(list.total, 'activity').replace('activitys', 'activities'));
    const roots = d.stats?.roots;
    if (roots?.p95 !== null && roots?.p95 !== undefined) parts.push(`p95 ${duration(roots.p95)}`);
  } else if (list?.mode === 'audit' && Array.isArray(list.items)) parts.push(`${list.total} audit entries`);
  return parts.join(' · ');
}

// ---- Activities
/** A column the runtime sorts by (kit.dataTable renders the header button, ▲/▼ and aria-sort). */
const sortColumn = (d, by, column) => ({ ...column, label: SORTS[by], sortKey: by });
/** The list's place in the bottom controls: the view's own actions, then the zone and count summary. */
const footOf = (ctx, d, actions) => `${actions}<span class="ui-page-summary">${e(summaryText(ctx, d))}</span>`;
/** Every result with its meaning: the (i) of the Result column (D-M-6: no permanent legend under the list). */
const RESULT_HELP = RESULTS.map((result) => `${result}: ${RESULT_MEANINGS[result]}.`).join(' ');
/** The audit facts of an activity: provider, rows returned, the portal error code (from its root audit entry). */
function auditFacts(entries, auditId) {
  const root = entries?.find((entry) => entry.id === auditId) ?? entries?.find((entry) => !entry.parentId);
  if (!root) return { root: null, reads: entries ?? [] };
  return { root, reads: (entries ?? []).filter((entry) => entry !== root) };
}
const factsText = (root, reads) =>
  [
    root?.provider,
    Number.isInteger(root?.rowCount) ? plural(root.rowCount, 'row') : null,
    reads.length ? plural(reads.length, 'read') : null,
    root?.error?.portalCode ? `portal ${root.error.portalCode}` : null,
  ].filter(Boolean);
/** The error of a row: the first failed step's code and message, else the audit error (a 500 always shows a code). */
const rowError = (item, root) => {
  const error = item.firstError ?? root?.error ?? null;
  if (!error) return '';
  const code = error.code ?? root?.error?.code;
  const text = `${item.firstError?.name ? `${item.firstError.name}: ` : ''}${errorText({ ...error, code })}`;
  return `<span class="ui-help ui-trace-error" title="${e(text)}">${e(text)}</span>`;
};
/**
 * Who of an audit entry (D-M-2): the contact by kind and short id, a visitor by its id when the entry names one, else
 * Anonymous; a contact or visitor is a link that filters by exactly that caller.
 */
function auditWho(d, entry) {
  const contact = entry.identity?.contactId;
  const visitor =
    entry.visitorId ?? (String(entry.sessionKey ?? '').startsWith('visitor:') ? entry.sessionKey.slice(8) : null);
  if (contact) return whoLink(d, { kind: 'contact', id: contact, name: entry.identity?.name ?? null }, null);
  if (visitor) return whoLink(d, { kind: 'anonymous' }, { visitorId: visitor });
  return 'Anonymous';
}
/**
 * The bottom controls of a tab's list (D-M-7/D-M-8): its own controls, the tab's (i) and the zone/summary on the left,
 * the count, rows per page and pager on the right (only when the list pages).
 */
function bottomBar(ctx, d, tab, controls, pager) {
  return (
    `<div class="ui-activity-listbar"><div class="ui-toolbar">${controls}${tabHelp(ctx, tab)}<span class="ui-page-summary">${e(summaryText(ctx, d))}</span></div>` +
    `${pager ? kit.tableTools(pager.key, pager.page, { searchable: false }) : ''}</div>`
  );
}
/** A field's help behind an (i), describing the control whose aria-describedby names `id`. */
function tip(ctx, id, key, name, label) {
  const text = helpEntry(ctx, key).fields?.[name] ?? '';
  return text ? kit.info({ id, label, text }) : '';
}
/** A tab's help behind an (i) (the list starts at once under the tabs). */
function tabHelp(ctx, tab) {
  const entry = helpEntry(ctx, `${ID}.${tab}`);
  const docs = entry.doc ? [kit.docLink(entry.doc, ctx.docs?.() ?? {})] : [];
  return entry.intro
    ? kit.info({ id: `help-activity-${tab}`, label: `About ${tabLabel(tab)}`, text: entry.intro, docs })
    : '';
}
/** Who (D-M-2) as a link that filters by exactly this caller; the full id is its title. */
function whoLink(d, actor, session) {
  const text = whoText(actor, session);
  const value = whoValue(actor, session);
  return value
    ? `<a class="ui-activity-who" href="${e(pivotHref(d, { who: value }, actor?.name ?? null))}" title="${e(`Only activities of ${value}`)}">${e(text)}</a>`
    : e(text);
}
function emptyGuide(ctx, d) {
  const portal = ctx.capabilities?.()?.powerPages !== false ? (ctx.links?.()?.powerPages ?? '/') : null;
  // Startup findings: those raised outside any activity (no traceId), the ones a person has not caused yet.
  const findings = Array.isArray(d.findings?.diagnostics)
    ? d.findings.diagnostics.filter((item) => !item.traceId).length
    : null;
  const steps = [
    portal
      ? `<li><a href="${e(portal)}" target="_blank" rel="noopener">Open the portal ↗</a></li>`
      : '<li>Call this runtime’s Web API or open one of its apps.</li>',
    served(ctx, '/personas') ? '<li><a href="#access">Sign in as a test person ↗</a></li>' : '',
    `<li>Activity appears here${d.live ? ' live' : ': select Live to follow it, or Refresh'}.</li>`,
  ].join('');
  return (
    `<div class="ui-empty-guide" data-table-empty="activity-list"><p><strong>Nothing recorded yet.</strong>${tabHelp(ctx, 'activities')}</p><ol>${steps}</ol>` +
    (findings !== null
      ? `<p>Startup findings (${e(findings)}) are under <a href="${e(hrefOf(d, { tab: 'findings', traceId: null, spanId: null }))}">Findings</a>.</p>`
      : '') +
    '</div>'
  );
}
const filtered = (d) => FILTERS.some((name) => d.filters[name]) || Boolean(RANGES[d.range]);
function activitiesPanel(ctx, d) {
  if (refusedFilter(d)) return '<p class="ui-help">No activity is listed while a filter is not valid.</p>';
  const list = d.list;
  if (!list) return '<p role="status" class="ui-help">Loading activities…</p>';
  if (list.error)
    return kit.notice(
      `${list.mode === 'audit' ? 'The request audit' : 'Activities'} could not be read: ${failed(list)}`,
      'warn',
    );
  if (list.mode === 'audit') return auditList(ctx, d, list);
  if (!list.total && !filtered(d)) return emptyGuide(ctx, d);
  // Compare carries its own (i) right after it; the tab's (i) follows Show reads, so no two bare (i) sit side by side.
  const pickTools =
    `<span class="ui-activity-compare"><button type="button" class="ui-button ui-small" id="activity-compare" data-activity-action="compare" aria-describedby="activity-pick-help"${d.picked.length === 2 ? '' : ' disabled'}>Compare ${d.picked.length === 2 ? 'the 2 ticked activities' : 'ticked activities'}</button>${tip(ctx, 'activity-pick-help', 'activity.activities', 'pick', 'About Compare')}</span>` +
    `<button type="button" class="ui-button ui-small" id="activity-reads" data-activity-action="reads" aria-pressed="${Boolean(d.reads)}">${d.reads ? 'Hide reads' : 'Show reads'}</button>` +
    tabHelp(ctx, 'activities');
  const caption =
    d.sort.by === 'start' && d.sort.order === 'desc'
      ? 'Activities, newest first'
      : `Activities by ${SORTS[d.sort.by].toLowerCase()}, ${d.sort.order === 'asc' ? 'ascending' : 'descending'}`;
  const rows = [];
  for (const item of list.items) {
    const facts = auditFacts(list.audit?.[item.traceId], item.auditId);
    rows.push({ ...item, facts });
    if (d.reads) for (const read of facts.reads) rows.push({ read, traceId: item.traceId });
  }
  const paging = { total: list.total, pages: list.pageCount, page: list.page, size: list.pageSize, search: '' };
  // The table starts right under the toolbar (D-M-7); its tools, count and pager follow it.
  return kit.dataTable({
    id: 'activity-list',
    caption,
    items: rows,
    result: { ...paging, items: rows },
    sort: { key: d.sort.by, order: d.sort.order },
    footActions: footOf(ctx, d, pickTools),
    // One line; an id or table filter says how it matches (the runtime takes 8+ character id prefixes and set names).
    emptyText:
      d.filters.who || d.filters.session || d.filters.recordId || d.filters.table
        ? 'No activity matches. Ids match by a prefix of 8 or more characters, tables by logical or entity set name; select Who in a row to filter by exactly that caller.'
        : 'No activity matches these filters. Clear a filter, or widen the time range.',
    rowAttrs: (item) =>
      item.read
        ? { class: 'is-read' }
        : { 'data-activity-row': item.traceId, class: item.traceId === d.traceId ? 'is-selected' : undefined },
    columns: [
      sortColumn(d, 'start', { render: (item) => (item.read ? '' : when(item.startedAt)) }),
      {
        label: 'Result',
        info: RESULT_HELP,
        render: (item) =>
          item.read
            ? resultBadge(OUTCOME_RESULT[item.read.outcome] ?? item.read.outcome)
            : `${resultBadge(item.status)}${httpBadge(item.root?.attributes?.statusCode ?? item.facts.root?.status)}`,
      },
      {
        label: 'Activity',
        render: (item) => {
          if (item.read)
            return (
              `<a class="ui-activity-read" href="${e(openHref(d, item.traceId, item.read.spanId))}">${kit.badge(item.read.kind, 'neutral')} ${e(item.read.entity ?? item.read.path ?? '')}</a>` +
              `<span class="ui-help ui-trace-origin">${e(factsText(item.read, []).join(' · ') || '—')}</span>`
            );
          const name = item.root?.name ?? item.traceId;
          return (
            `<button type="button" class="ui-link-button ui-trace-root" id="activity-open-${e(item.traceId)}" data-activity-open="${e(item.traceId)}" aria-keyshortcuts="ArrowUp ArrowDown" title="${e(name)}" aria-label="Open activity ${e(name)}">${kit.badge(item.root?.kind ?? '—', 'info')} <span class="ui-trace-name">${e(name)}</span></button>` +
            `<span class="ui-help ui-trace-origin">${whoLink(d, item.root?.actor, item.root?.session)}${item.root?.origin?.host ? ` · ${e(item.root.origin.host)}` : ''}</span>` +
            rowError(item, item.facts.root)
          );
        },
      },
      sortColumn(d, 'duration', {
        className: 'ui-trace-extra',
        render: (item) =>
          item.read
            ? e(duration(item.read.durationMs))
            : `${e(duration(item.durationMs))}${item.totalDurationMs !== item.durationMs ? `<span class="ui-help ui-trace-origin">total ${e(duration(item.totalDurationMs))}</span>` : ''}`,
      }),
      sortColumn(d, 'spans', {
        className: 'ui-trace-extra',
        render: (item) =>
          item.read
            ? ''
            : `${e(item.spanCount ?? 0)}${item.droppedSpans ? ` ${kit.badge(`+${item.droppedSpans} refused`, 'warn')}` : ''}`,
      }),
      sortColumn(d, 'errors', {
        className: 'ui-trace-extra',
        render: (item) =>
          item.read
            ? item.read.error
              ? `<span class="ui-help ui-trace-error">${e(errorText(item.read.error))}</span>`
              : ''
            : errorBadges(item, ''),
      }),
      {
        label: 'Audit',
        className: 'ui-trace-extra',
        render: (item) => (item.read ? '' : e(factsText(item.facts.root, item.facts.reads).join(' · ') || '—')),
      },
      {
        label: 'Compare',
        className: 'ui-trace-extra',
        render: (item) =>
          item.read
            ? ''
            : `<input type="checkbox" id="activity-pick-${e(item.traceId)}" data-activity-pick="${e(item.traceId)}"${d.picked.includes(item.traceId) ? ' checked' : ''} aria-label="Compare activity ${e(item.root?.name ?? item.traceId)}" aria-describedby="activity-pick-help">`,
      },
    ].filter((column) => column.label !== 'Audit' || auditServed(ctx)),
  });
}
/** The request audit as the list (tracing off, or an audit-only filter): one row per entry, each to its activity. */
function auditList(ctx, d, list) {
  const why = tracingOff(d)
    ? kit.notice('Tracing is off: showing the request audit only; turn it on in ⚙ Settings to see steps.', 'warn')
    : kit.notice(
        `Listing request audit entries: ${AUDIT_ONLY.filter((name) => d.filters[name])
          .map((name) => LABELS[name])
          .join(
            ', ',
          )} ${AUDIT_ONLY.filter((name) => d.filters[name]).length === 1 ? 'is a fact' : 'are facts'} only the audit keeps.`,
        'info',
      );
  const paging = { total: list.total, pages: list.pageCount, page: list.page, size: list.pageSize, search: '' };
  return (
    why +
    kit.dataTable({
      id: 'activity-list',
      caption: 'Request audit entries, newest first',
      items: list.items,
      result: { ...paging, items: list.items },
      footActions: footOf(
        ctx,
        d,
        `${tabHelp(ctx, 'activities')}<span class="ui-help" title="The audit keeps the newest entries; older ones are dropped beyond its limit.">${e(list.retained ?? 0)} kept · ${e(list.dropped ?? 0)} dropped</span>`,
      ),
      emptyText: 'No audit entry matches these filters.',
      rowAttrs: (entry) => ({ class: entry.traceId && entry.traceId === d.traceId ? 'is-selected' : undefined }),
      columns: [
        { label: 'Time', render: (entry) => when(entry.startedAt) },
        {
          label: 'Result',
          info: RESULT_HELP,
          render: (entry) => `${resultBadge(OUTCOME_RESULT[entry.outcome] ?? entry.outcome)}${httpBadge(entry.status)}`,
        },
        {
          label: 'Request',
          render: (entry) =>
            `${kit.badge(entry.kind, 'neutral')} ${
              entry.traceId
                ? `<a href="${e(openHref(d, entry.traceId, entry.spanId))}" id="activity-audit-${e(entry.id)}">${e(`${entry.method} ${entry.path}`)}</a>`
                : `<span title="Recorded while tracing was off: no steps">${e(`${entry.method} ${entry.path}`)}</span>`
            }<span class="ui-help ui-trace-origin">${auditWho(d, entry)}${entry.entity ? ` · ${e(entry.entity)}` : ''}</span>` +
            (entry.error ? `<span class="ui-help ui-trace-error">${e(errorText(entry.error))}</span>` : ''),
        },
        { label: 'Duration', className: 'ui-trace-extra', render: (entry) => e(duration(entry.durationMs)) },
        {
          label: 'Audit',
          className: 'ui-trace-extra',
          render: (entry) => e(factsText(entry, []).join(' · ') || '—'),
        },
      ],
    })
  );
}

// ---- Steps: waterfall, tree and the step drawer
/** Depth-first span order of a tree (children in sequence order). */
const walk = (nodes, out = []) => {
  for (const node of sorted(nodes)) {
    out.push(node);
    walk(node.children, out);
  }
  return out;
};
/** The steps the step search and errors-only toggle keep: matches plus their ancestors; null when neither is set. */
export function spanFilter(tree, { spanSearch = '', errorsOnly = false } = {}) {
  const query = String(spanSearch).trim().toLowerCase();
  if (!query && !errorsOnly) return null;
  const spans = tree.spans ?? [];
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const matched = new Set(),
    shown = new Set();
  for (const span of spans) {
    if (errorsOnly && span.status !== 'error' && span.status !== 'denied') continue;
    if (query && !spanSearchText(span).includes(query)) continue;
    matched.add(span.spanId);
    for (let item = span; item && !shown.has(item.spanId); item = byId.get(item.parentSpanId)) shown.add(item.spanId);
  }
  return { matched, shown };
}
const depthBadge = (depth) => (depth > MAX_INDENT ? ` ${kit.badge(`d${depth}`, 'neutral')}` : '');
function waterfall(d, tree, filter) {
  const all = walk(tree.children);
  const starts = new Map(all.map((span) => [span.spanId, Date.parse(span.startedAt)]));
  const origin = Math.min(...starts.values());
  const total = Math.max(
    0.01,
    tree.trace?.totalDurationMs ?? 0,
    ...all.map((span) => starts.get(span.spanId) - origin + (span.durationMs ?? 0)),
  );
  const spans = filter ? all.filter((span) => filter.shown.has(span.spanId)) : all;
  const modules = [...new Set(all.map((span) => span.module ?? 'other'))];
  const rows = spans
    .map((span) => {
      const offset = (starts.get(span.spanId) - origin) / total;
      const width = span.durationMs === null ? 1 - offset : span.durationMs / total;
      const marks = (span.events ?? []).map((event) => offset + event.offsetMs / total);
      const classes = [
        series(span.module),
        span.status === 'error' ? 'is-error' : '',
        span.status === 'denied' ? 'is-denied' : '',
        span.status === 'cancelled' ? 'is-cancelled' : '',
        span.async ? 'is-async' : '',
        span.durationMs === null ? 'is-running' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const selected = span.spanId === d.spanId;
      const context = filter && !filter.matched.has(span.spanId);
      return (
        `<li class="data-line ui-waterfall-row ui-depth-${Math.min(span.depth ?? 0, MAX_INDENT)}${selected ? ' is-selected' : ''}${context ? ' is-context' : ''}">` +
        `<button type="button" class="ui-waterfall-label" id="activity-span-${e(span.spanId)}" data-activity-span="${e(span.spanId)}" aria-pressed="${selected}" aria-label="Step ${e(span.name)}, ${e(span.kind)}, ${e(duration(span.durationMs))}, ${e(span.status)}">` +
        `${kit.badge(span.kind, 'neutral')} <span class="ui-waterfall-name" title="${e(span.name)}">${e(span.name)}</span>${span.entity ? ` <code>${e(span.entity)}</code>` : ''}${depthBadge(span.depth ?? 0)}${span.async ? ` ${kit.badge('async', 'info')}` : ''}</button>` +
        kit.bar({
          offset,
          width,
          className: classes,
          marks,
          label: `starts at ${duration(starts.get(span.spanId) - origin)}, lasts ${duration(span.durationMs)}`,
        }) +
        `<span class="ui-waterfall-duration">${e(duration(span.durationMs))} ${span.status === 'ok' ? '' : resultBadge(span.status)}</span></li>`
      );
    })
    .join('');
  const legend = modules
    .map(
      (module) =>
        `<li class="data-line"><svg class="ui-swatch" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><rect class="${series(module)}" width="10" height="10" rx="2"></rect></svg>${e(module)}</li>`,
    )
    .join('');
  return (
    `<div class="ui-waterfall-scale"><span>0 ms</span><span>${e(duration(total))}</span></div>` +
    (rows
      ? `<ol class="ui-waterfall" aria-label="Steps in start order">${rows}</ol>`
      : '<p class="ui-help">No step matches the search.</p>') +
    `<ul class="ui-waterfall-legend" aria-label="Colour by module">${legend}<li class="data-line">${kit.badge('async', 'info')} starts a job segment</li><li class="data-line">ticks: events</li></ul>`
  );
}
function treeNode(node, d, filter) {
  const selected = node.spanId === d.spanId;
  const depth = node.depth ?? 0;
  const events = node.events?.length ?? 0;
  const head =
    `<span class="ui-tree-head">${kit.badge(node.kind, 'neutral')} <button type="button" class="ui-tree-span" id="activity-span-${e(node.spanId)}" data-activity-span="${e(node.spanId)}" aria-pressed="${selected}" title="${e(node.name)}">${e(node.name)}</button>` +
    `${node.entity ? ` <code>${e(node.entity)}</code>` : ''}${depthBadge(depth)} <span class="ui-tree-facts">${e(duration(node.durationMs))} · ${resultBadge(node.status)}${events ? ` · ${e(plural(events, 'event'))}` : ''}${node.async ? ` · ${kit.badge('async', 'info')}` : ''}</span></span>`;
  const children = sorted(node.children).filter((child) => !filter || filter.shown.has(child.spanId));
  const classes = [selected ? 'is-selected' : '', filter && !filter.matched.has(node.spanId) ? 'is-context' : '']
    .filter(Boolean)
    .join(' ');
  return children.length
    ? `<li class="data-line${classes ? ` ${classes}` : ''}"><details open data-ui-section="activity:node:${e(node.spanId)}"><summary>${head}</summary><ul role="group"${depth >= MAX_INDENT ? ' class="is-flat"' : ''}>${children.map((child) => treeNode(child, d, filter)).join('')}</ul></details></li>`
    : `<li class="data-line ui-tree-leaf${classes ? ` ${classes}` : ''}">${head}</li>`;
}
/** A captured payload, or why the step has none: its own capture level, a sealed flow run, or nothing passed. */
function payload(title, value, span) {
  if (value !== undefined)
    return [
      title,
      `<details class="ui-payload"><summary>Show</summary><pre class="ui-example">${e(JSON.stringify(value, null, 2))}</pre></details>`,
    ];
  const what = title.toLowerCase();
  const [state, reason] =
    span.level === 'summary'
      ? [
          'not captured (level summary)',
          `This step was recorded at level summary, which keeps attributes and events only. Choose full under ⚙ Settings and run the request again to capture the ${what}.`,
        ]
      : span.level === 'full'
        ? span.attributes?.secure
          ? [
              'not captured (sealed flow run)',
              'This step belongs to a sealed flow run (a Secret parameter or secure inputs or outputs), so no payload of the run is recorded.',
            ]
          : ['none', `This step was recorded at level full and its operation passed no ${what} to the trace.`]
        : ['not captured', 'This step does not say at which level it was recorded.'];
  return [title, `${e(state)}${kit.info({ label: `Why no ${what}`, text: reason })}`];
}
/** A titled card of the detail pane (D-M-6: every block a card with a heading). */
const card = (title, body, id = '') =>
  `<section class="ui-activity-card"${id ? ` id="${id}"` : ''}><h4>${e(title)}</h4>${body}</section>`;
// Span lookup by id per tree, built once per tree answer.
const indexes = new WeakMap();
const byIdOf = (tree) => {
  let index = indexes.get(tree);
  if (!index) indexes.set(tree, (index = new Map((tree.spans ?? []).map((item) => [item.spanId, item]))));
  return index;
};
/**
 * The span an id names: from the open trace, else a span read for the drawer (d.linked), else null. A span that failed
 * carries its own `error` object; only a failed read (`failureOf`: no spanId, `error` a message) is not a span (DV-Y8-1).
 */
const targetOf = (d, tree, spanId) => {
  const found = byIdOf(tree).get(spanId) ?? d.linked?.[spanId];
  return found?.spanId === spanId ? found : null;
};
/** Kind and name of a span, or its short id when it is not retained. */
const spanLabel = (span, spanId) =>
  span ? `${kit.badge(span.kind ?? '—', 'neutral')} ${e(span.name)}` : `step <code>${e(short(spanId))}</code>`;
/** The spans from the trace root down to `span` (the store's ancestry within the open trace). */
function ancestry(tree, span) {
  const byId = byIdOf(tree),
    chain = [];
  for (let item = span; item && !chain.includes(item); item = byId.get(item.parentSpanId)) chain.unshift(item);
  return chain;
}
/** The nearest http ancestor of a span other than itself. */
function parentRequest(tree, span) {
  const byId = byIdOf(tree);
  for (let parent = byId.get(span.parentSpanId); parent; parent = byId.get(parent.parentSpanId))
    if (parent.kind === 'http') return parent;
  return null;
}
/** An attribute value; an id another view shows (flow run, system job, plug-in step) links there. */
function attributeValue(name, value) {
  const view = Object.hasOwn(VIEW_LINKS, name) && typeof value === 'string' && value ? VIEW_LINKS[name] : null;
  return view
    ? `<a href="${e(view[2](value))}" aria-label="Open ${e(view[0])} ${e(value)} in ${e(view[1])}"><code>${e(value)}</code></a>`
    : `<code>${json(value, 400)}</code>`;
}
/** Reads the spans the open step's parent and links name outside the open activity. Resolves true when it read any. */
async function loadTargets(ctx, d) {
  const span = d.tree?.spans ? byIdOf(d.tree).get(d.spanId) : null;
  if (!span) return false;
  const byId = byIdOf(d.tree);
  const ids = [...new Set([span.parentSpanId, ...(span.links ?? []).map((link) => link.spanId)])].filter(
    (id) => id && !byId.has(id) && !Object.hasOwn(d.linked, id),
  );
  if (!ids.length) return false;
  for (const id of ids) d.linked[id] = null;
  const found = await Promise.all(ids.map((id) => get(ctx, `/trace/span/${encodeURIComponent(id)}`)));
  ids.forEach((id, index) => (d.linked[id] = found[index]));
  return true;
}
function drawer(ctx, d, tree) {
  const span = byIdOf(tree).get(d.spanId);
  if (!span) return d.spanId ? kit.notice(`Step ${d.spanId} is not part of this activity.`, 'warn') : '';
  const attributes = Object.entries(span.attributes ?? {});
  const request = parentRequest(tree, span);
  const chain = ancestry(tree, span);
  const parent = span.parentSpanId ? targetOf(d, tree, span.parentSpanId) : null;
  const who = whoValue(span.actor, span.session);
  const pivots = [
    span.session?.sessionKey && ['Same session', pivotHref(d, { session: span.session.sessionKey })],
    who && ['Same who', pivotHref(d, { who })],
    span.entity && ['Same table', pivotHref(d, { table: span.entity })],
    span.recordId && ['Same record', pivotHref(d, { table: span.entity ?? '', recordId: span.recordId })],
    request && ['Parent request', openHref(d, tree.trace.traceId, request.spanId)],
  ].filter(Boolean);
  const children =
    d.children?.spanId === span.spanId
      ? d.children.error
        ? kit.notice(`Child activities could not be read: ${failed(d.children)}`, 'warn')
        : d.children.traceIds.length
          ? `<ul>${d.children.traceIds.map((id) => `<li><a href="${e(openHref(d, id))}">Activity <code>${e(short(id))}</code></a></li>`).join('')}</ul>`
          : '<p class="ui-help">No other activity has a step under this one.</p>'
      : '';
  const events = kit.table({
    key: 'activity-events',
    caption: `Events of ${span.name}`,
    items: span.events ?? [],
    emptyText: 'This step recorded no event.',
    columns: [
      { label: 'Offset', render: (item) => e(duration(item.offsetMs)) },
      {
        label: 'Type',
        render: (item) =>
          kit.badge(
            item.type,
            item.attributes?.result === 'deny' || item.attributes?.result === 'rejected' ? 'warn' : 'neutral',
          ),
      },
      { label: 'Message', render: (item) => e(item.message ?? '') },
      {
        label: 'Attributes',
        render: (item) => (item.attributes ? `<code>${json(item.attributes, 240)}</code>` : ''),
      },
    ],
  });
  const climb = [
    span.parentSpanId &&
      `<a class="ui-button ui-small" id="activity-span-parent" href="${e(openHref(d, parent?.traceId ?? span.traceId, span.parentSpanId))}" aria-label="Parent step: ${e(parent ? `${parent.kind} ${parent.name}` : short(span.parentSpanId))}">Parent</a>`,
    chain.length > 2 &&
      `<a class="ui-button ui-small" id="activity-span-root" href="${e(openHref(d, chain[0].traceId, chain[0].spanId))}" aria-label="Root step: ${e(`${chain[0].kind} ${chain[0].name}`)}">Root</a>`,
  ]
    .filter(Boolean)
    .join('');
  const path = `<nav class="ui-crumbs" aria-label="Step path"><ol>${chain
    .map((item) =>
      item === span
        ? `<li aria-current="location">${spanLabel(item)}</li>`
        : `<li><a href="${e(openHref(d, item.traceId, item.spanId))}">${spanLabel(item)}</a></li>`,
    )
    .join('')}</ol></nav>`;
  const links = (span.links ?? []).map((link) => {
    const target = link.spanId ? targetOf(d, tree, link.spanId) : null;
    const gone = link.spanId && d.linked[link.spanId]?.status === 404 ? ' (no longer retained)' : '';
    return `<li class="data-line">${e(link.relation)}: <a href="${e(openHref(d, link.traceId, link.spanId ?? null))}">${link.spanId ? spanLabel(target, link.spanId) : 'the activity'}</a> in activity <code>${e(short(link.traceId))}</code>${e(gone)}</li>`;
  });
  return (
    `<section class="ui-drawer" id="activity-span-drawer" tabindex="-1" aria-labelledby="activity-span-title"><div class="ui-drawer-head"><h3 id="activity-span-title">${e(span.name)}</h3>` +
    `${resultBadge(span.status)}${climb}<button type="button" class="ui-button ui-small" data-activity-copy="span">Copy step id</button><button type="button" class="ui-button ui-small" id="activity-close-span" data-activity-action="close-span" aria-keyshortcuts="Escape">Close step</button></div>` +
    path +
    kit.kv([
      ['Step', `<code>${e(span.spanId)}</code>`],
      [
        'Parent',
        span.parentSpanId
          ? `<a href="${e(openHref(d, parent?.traceId ?? span.traceId, span.parentSpanId))}">${spanLabel(parent, span.parentSpanId)}</a>`
          : 'none (root)',
      ],
      ['Kind / module', `${e(span.kind)} · ${e(span.module ?? '—')}`],
      ['Operation', e(span.operation ?? '—')],
      ['Table / record', `${e(span.entity ?? '—')}${span.recordId ? ` · <code>${e(span.recordId)}</code>` : ''}`],
      ['Started', when(span.startedAt)],
      ['Duration', e(duration(span.durationMs))],
      ['Depth', `${e(span.depth)}${span.async ? ` ${kit.badge('async segment', 'info')}` : ''}`],
      [
        'Who',
        e(
          `${whoText(span.actor, span.session)}${span.actor?.roles?.length ? ` (${span.actor.roles.join(', ')})` : ''}`,
        ),
      ],
      ['Session', `<code>${e(span.session?.sessionKey ?? '—')}</code>`],
      ['Origin', e([span.origin?.host, span.origin?.portal, span.origin?.preset].filter(Boolean).join(' · ') || '—')],
      ['Captured at', e(span.level ? `level ${span.level}` : '—')],
    ]) +
    (span.error ? kit.notice(errorText(span.error), span.status === 'denied' ? 'warn' : 'bad') : '') +
    card(
      'Attributes',
      attributes.length
        ? kit.kv(attributes.map(([name, value]) => [name, attributeValue(name, value), { mono: true }]))
        : '<p class="ui-empty">No attribute.</p>',
    ) +
    card('Events', events) +
    card('Payloads', kit.kv([payload('Input', span.input, span), payload('Output', span.output, span)])) +
    (links.length ? card('Links', `<ul>${links.join('')}</ul>`) : '') +
    card(
      'Related',
      `<p class="ui-drawer-actions">${pivots.map(([text, href]) => `<a class="ui-button ui-small" href="${e(href)}">${e(text)}</a>`).join(' ')} ` +
        `<button type="button" class="ui-button ui-small" data-activity-children="${e(span.spanId)}">Child activities</button></p>${children}`,
    ) +
    '</section>'
  );
}
function spanTools(ctx, d, tree, filter) {
  const total = tree.spans?.length ?? 0;
  const as = (id, text) =>
    `<button type="button" class="ui-button ui-small" id="activity-steps-${id}" data-activity-steps-as="${id}" aria-pressed="${d.stepsAs === id}">${text}</button>`;
  return (
    `<div class="ui-span-tools"><div role="group" aria-label="Show steps as">${as('waterfall', 'Waterfall')}${as('tree', 'Tree')}</div>` +
    `<div><label for="activity-span-search">Find steps</label>${tip(ctx, 'activity-span-search-help', 'activity.detail', 'spanSearch', 'About Find steps')}<input type="search" id="activity-span-search" data-activity-span-search value="${e(d.spanSearch)}" aria-describedby="activity-span-search-help"></div>` +
    `<div class="ui-check"><input type="checkbox" id="activity-errors-only" data-activity-errors-only${d.errorsOnly ? ' checked' : ''} aria-describedby="activity-errors-only-help"><label for="activity-errors-only">Only errors and denials</label>${tip(ctx, 'activity-errors-only-help', 'activity.detail', 'errorsOnly', 'About Only errors and denials')}</div>` +
    `<p class="ui-help" role="status">${filter ? `${e(filter.matched.size)} of ${e(plural(total, 'step'))} match` : `${e(plural(total, 'step'))}`}${detailHelp(ctx, 'steps', 'Steps')}</p></div>`
  );
}
/** A detail tab's help behind an (i). */
/** The active tab's (i) on the tab strip's row, after the tabs (activity.css lays the row out), not on a line of its own. */
function tabsWithHelp(html, help) {
  return help
    ? html.replace(
        '</div><div class="ui-tabpanel"',
        `</div><span class="ui-activity-tabhelp">${help}</span><div class="ui-tabpanel"`,
      )
    : html;
}
function detailHelp(ctx, tab, label) {
  const entry = helpEntry(ctx, `${ID}.detail-${tab}`);
  const docs = entry.doc ? [kit.docLink(entry.doc, ctx.docs?.() ?? {})] : [];
  return entry.intro
    ? kit.info({ id: `help-activity-detail-${tab}`, label: `About ${label}`, text: entry.intro, docs })
    : '';
}
function stepsPanel(ctx, d, tree) {
  const filter = spanFilter(tree, d);
  const body =
    d.stepsAs === 'tree'
      ? `<ul class="ui-tree" aria-label="Step tree">${sorted(tree.children)
          .filter((node) => !filter || filter.shown.has(node.spanId))
          .map((node) => treeNode(node, d, filter))
          .join('')}</ul>${filter && !filter.shown.size ? '<p class="ui-help">No step matches the search.</p>' : ''}`
      : waterfall(d, tree, filter);
  return spanTools(ctx, d, tree, filter) + body + drawer(ctx, d, tree);
}

// ---- The Why line: the first step that failed or was denied, and its message, before anything else.
/**
 * `{ tone, text, spanId }` for an activity tree: the first step that ended error or denied (the store's firstError),
 * else the deepest failed step, else how it ended.
 */
export function whyOf(tree) {
  const summary = tree?.trace ?? {};
  const spans = tree?.spans ?? [];
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  if (summary.status === 'running')
    return { tone: 'info', text: `Still running: ${plural(spans.length, 'step')} so far.`, spanId: null };
  const failedSpans = spans.filter((span) => span.status === 'error' || span.status === 'denied');
  const first =
    byId.get(summary.firstError?.spanId) ??
    [...failedSpans].sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0) || a.sequence - b.sequence)[0];
  if (!first) {
    const status = tree?.root?.attributes?.statusCode;
    return {
      tone: 'ok',
      text: `Ended ${summary.status ?? 'ok'}${status ? ` with HTTP ${status}` : ''} in ${duration(summary.durationMs)}; no step failed.`,
      spanId: null,
    };
  }
  const error = first.error ?? (summary.firstError?.spanId === first.spanId ? summary.firstError : null);
  const denial = (first.events ?? []).find((event) => event.attributes?.result === 'deny');
  const message = error ? errorText(error) : (denial?.message ?? 'no message was recorded');
  const what = `${KIND_WORDS[first.kind] ?? first.kind} “${first.name}”`;
  return {
    tone: first.status === 'denied' ? 'warn' : 'bad',
    text: `${what} ${first.status === 'denied' ? 'was denied' : 'failed'}: ${message}`,
    spanId: first.spanId,
  };
}
function whyLine(d, tree) {
  const why = whyOf(tree);
  const link = why.spanId
    ? ` <a href="${e(openHref(d, tree.trace.traceId, why.spanId))}" id="activity-why-step">Show this step</a>`
    : '';
  return `<p class="ui-notice ui-tone-${why.tone} ui-activity-why" id="activity-why"><strong>Why:</strong> ${e(why.text)}${link}</p>`;
}

// ---- Log & findings, Rendered, Request of the open activity
/** One log line as plain words. */
function lineText(line) {
  const item = line.entry;
  if (item)
    return `${item.method} ${item.path} → ${item.status ?? 'pending'}${item.entity ? ` · ${item.entity}` : ''}${Number.isInteger(item.rowCount) ? ` · ${plural(item.rowCount, 'row')}` : ''} · ${duration(item.durationMs)}${item.error ? ` · ${errorText(item.error)}${item.error.portalCode ? ` (portal ${item.error.portalCode})` : ''}` : ''}`;
  if (line.type === 'plugin')
    return `Plugin rule ${line.rule ?? (line.plugins ?? []).join(', ')} on ${line.operation} ${line.entity}: ${line.result ?? line.outcome}${line.changes?.length ? ` · changed ${line.changes.join(', ')}` : ''}${line.error ? ` · ${line.error.code ? `${line.error.code}: ` : ''}${line.error.message}` : ''}`;
  if (line.type === 'diagnostic')
    return `${line.diagnostic?.code || 'Finding'}: ${line.diagnostic?.message || ''}${line.diagnostic?.path ? ` · ${line.diagnostic.path}` : ''}`;
  if (line.type === 'startup')
    return `${line.phase ?? 'startup'}: ${line.message ?? ''}${Number.isFinite(line.elapsedMs) ? ` · ${duration(line.elapsedMs)}` : ''}`;
  if (line.type === 'reload') return line.message || `Runtime revision ${line.revision}`;
  return line.message ?? JSON.stringify(line);
}
const LEVEL_TONES = { error: 'bad', warning: 'warn', info: 'neutral' };
function logLines(d, lines, { openLinks = true } = {}) {
  if (!lines.length) return '';
  return `<ol class="ui-log-lines">${lines
    .map((line) => {
      const link =
        openLinks && line.traceId
          ? ` <a class="ui-button ui-small" href="${e(openHref(d, line.traceId, line.spanId ?? null))}" aria-label="Open the activity of log line ${e(line.sequence)}">Open activity →</a>`
          : '';
      return `<li class="data-line ui-log-line ui-level-${e(line.level ?? 'info')}">${when(line.time)} ${kit.badge(line.type, LEVEL_TONES[line.level] ?? 'neutral')} <span class="ui-log-text">${e(lineText(line))}</span>${link}</li>`;
    })
    .join('')}</ol>`;
}
function findingItems(d, items, { openLinks = true } = {}) {
  return `<ul class="ui-finding-list">${items
    .map((item) => {
      const where = item.path || item.page || item.file;
      const route = pageRoute(item.path);
      const cause = item.traceId
        ? openLinks
          ? `<a class="ui-button ui-small" href="${e(openHref(d, item.traceId, item.spanId ?? null))}">Open activity →</a>`
          : ''
        : '<span class="ui-help">startup / outside any request</span>';
      return (
        `<li class="data-line ui-finding">${item.time ? `${when(item.time)} ` : ''}${item.severity ? kit.badge(item.severity, LEVEL_TONES[item.severity] ?? 'neutral') : ''} ${e(findingText(item) || JSON.stringify(item))}` +
        (where ? `<span class="ui-help ui-finding-where">${e(where)}</span>` : '') +
        `<span class="ui-drawer-actions">${cause}${route ? ` <a class="ui-button ui-small" href="${e(route)}" target="_blank" rel="noopener">Open page ↗</a>` : ''}</span></li>`
      );
    })
    .join('')}</ul>`;
}
function detailLogPanel(ctx, d) {
  const answer = d.detailLog;
  if (!answer) return '<p role="status" class="ui-help">Loading the log lines and findings of this activity…</p>';
  const parts = [];
  if (answer.logs?.error) parts.push(kit.notice(`Log lines could not be read: ${failed(answer.logs)}`, 'warn'));
  else if (answer.logs) {
    // Finding lines are listed once, under Findings below.
    const lines = [...(answer.logs.items ?? [])]
      .filter((line) => line.type !== 'diagnostic')
      .sort((a, b) => a.sequence - b.sequence);
    parts.push(
      `<h4>Log lines (${e(lines.length)})</h4>` +
        (lines.length
          ? logLines(d, lines, { openLinks: false })
          : '<p class="ui-help">No log line names this activity (the log keeps the newest lines only).</p>'),
    );
  } else parts.push('<p class="ui-help">This host keeps no log stream; the steps hold what was recorded.</p>');
  if (answer.findings?.error) parts.push(kit.notice(`Findings could not be read: ${failed(answer.findings)}`, 'warn'));
  else if (answer.findings) {
    const items = answer.findings.diagnostics ?? [];
    parts.push(
      `<h4>Findings (${e(items.length)})</h4>` +
        (items.length
          ? findingItems(d, items, { openLinks: false })
          : '<p class="ui-help">No finding was raised during this activity.</p>'),
    );
  }
  return parts.join('');
}
/** Render and template steps with their sources (path:line from /render-sources). */
function renderedRows(d, spans, sources) {
  const bySource = new Map((sources?.items ?? []).map((item) => [item.id, item]));
  const rendered = (spans ?? []).filter((span) => ['render', 'render-template', 'read'].includes(span.kind));
  return kit.table({
    key: 'activity-rendered',
    caption: 'Render and template steps with their sources',
    items: rendered,
    emptyText: 'This activity rendered no page or template.',
    columns: [
      {
        label: 'Step',
        render: (span) =>
          `<a href="${e(openHref(d, span.traceId, span.spanId))}">${kit.badge(span.kind, 'neutral')} ${e(span.name)}</a>`,
      },
      {
        label: 'Source',
        render: (span) => {
          const ref = span.attributes?.sourceRefId;
          // Without a reference the step says where it came from: a built-in template, or one the export lacks.
          if (!ref) {
            const origin = { 'built-in': 'Built-in template', missing: 'Not in the export' }[
              span.attributes?.sourceOrigin
            ];
            if (origin) return `<span class="ui-help">${origin}</span>`;
            return span.attributes?.callSite ? `<code>${e(span.attributes.callSite)}</code>` : '—';
          }
          const source = bySource.get(ref);
          if (source)
            return `<code class="ui-source" title="${e(source.file ?? source.path)}">${e(source.path)}${source.line ? `:${e(source.line)}` : ''}</code> <span class="ui-help">${e([source.kind, source.name].filter(Boolean).join(' · '))}</span>`;
          return sources && !sources.error ? '<span class="ui-help">source not found (changed since load)</span>' : '…';
        },
      },
      { label: 'Duration', render: (span) => e(duration(span.durationMs)) },
      { label: 'Result', render: (span) => resultBadge(span.status) },
    ],
  });
}
/** The saved rendering evidence of a route, or ''. */
function evidenceOf(ctx, route) {
  const state = ctx.state?.() ?? {};
  const evidence = state.evidence ?? state.status?.evidence ?? null;
  return evidence?.path && evidence.path === route ? evidence : null;
}
const evidenceBadge = (evidence) =>
  evidence.stale === true
    ? kit.badge('stale evidence', 'warn')
    : evidence.verified === true || evidence.passed === true
      ? kit.badge('evidence passed', 'ok')
      : kit.badge('unverified', 'warn');
function renderedPanel(ctx, d, tree) {
  const sources = d.sources;
  // The route the page rendered (its render step), else the request path: evidence is saved per rendered route.
  const render = (tree.spans ?? []).find((span) => span.kind === 'render');
  const route = pageRoute(String(render?.name ?? '').replace(/^render /, '')) ?? rootPath(tree.root?.name);
  const evidence = route ? evidenceOf(ctx, route) : null;
  return (
    (sources?.error ? kit.notice(`Template sources could not be resolved: ${failed(sources)}`, 'warn') : '') +
    renderedRows(d, tree.spans, sources) +
    (evidence
      ? `<p class="ui-help">Rendering evidence for <code>${e(route)}</code>: ${evidenceBadge(evidence)} <a href="${e(hrefOf(d, { tab: 'pages' }))}">Pages & render</a></p>`
      : route
        ? `<p class="ui-help">No rendering evidence was saved for <code>${e(route)}</code>.</p>`
        : '')
  );
}
function requestPanel(ctx, d, tree) {
  const root = tree.root ?? {};
  const body = card(
    'Bodies',
    kit.kv([payload('Request body', root.input, root), payload('Answer body', root.output, root)]),
  );
  const attributes = Object.entries(root.attributes ?? {});
  const facts = attributes.length
    ? kit.kv(attributes.map(([name, value]) => [name, attributeValue(name, value), { mono: true }]))
    : '<p class="ui-help">The root step recorded no attribute.</p>';
  if (!auditServed(ctx))
    return `<p class="ui-help">No request audit on this host: the root step’s facts.</p>${card('Root step', facts)}${body}`;
  const answer = d.request;
  if (!answer) return '<p role="status" class="ui-help">Loading the audit entry…</p>';
  if (answer.error) return kit.notice(`The audit entry could not be read: ${failed(answer)}`, 'warn') + facts + body;
  const { root: entry, reads } = auditFacts(answer.items, tree.trace?.auditId);
  if (!entry)
    return `<p class="ui-help" title="Jobs, flows and admin requests are not audited, and the audit keeps the newest entries only.">No audit entry names this activity.</p>${card('Root step', facts)}${body}`;
  // The error as the audit has it; a code the audit lacks (a 500 answered without one) comes from the failed step.
  const failedStep = tree.trace?.firstError;
  const error =
    entry.error || failedStep
      ? {
          ...failedStep,
          ...entry.error,
          code: entry.error?.code || failedStep?.code,
          message: entry.error?.message || failedStep?.message,
        }
      : null;
  const readsTable = kit.table({
    key: 'activity-reads',
    caption: 'Reads this request made',
    items: reads,
    emptyText: 'This request made no Liquid or data read.',
    columns: [
      {
        label: 'Read',
        render: (read) =>
          `<a href="${e(openHref(d, read.traceId ?? tree.trace.traceId, read.spanId ?? null))}">${kit.badge(read.kind, 'neutral')} ${e(read.entity ?? read.path)}</a>`,
      },
      { label: 'Rows', render: (read) => e(read.rowCount ?? '—') },
      { label: 'Duration', render: (read) => e(duration(read.durationMs)) },
      { label: 'Result', render: (read) => resultBadge(OUTCOME_RESULT[read.outcome] ?? read.outcome) },
    ],
  });
  return (
    card(
      'Audit entry',
      kit.kv([
        ['Request', `${kit.badge(entry.kind, 'neutral')} <code>${e(`${entry.method} ${entry.path}`)}</code>`],
        ['Result', `${resultBadge(OUTCOME_RESULT[entry.outcome] ?? entry.outcome)}${httpBadge(entry.status)}`],
        ['Who', root.actor || root.session ? whoLink(d, root.actor, root.session) : auditWho(d, entry)],
        ['Roles', e((entry.identity?.roles ?? []).join(', ') || '—')],
        ['Provider', e(entry.provider ?? '—')],
        ['Table', e(entry.entity ?? '—')],
        ['Rows', e(entry.rowCount ?? '—')],
        ['Started', when(entry.startedAt)],
        [
          'Duration',
          `${e(duration(entry.durationMs))}${Number.isFinite(entry.saveMs) ? ` · save ${e(duration(entry.saveMs))} (${e(entry.saveMode ?? '—')})` : ''}`,
        ],
        ['Error', error ? e(`${errorText(error)}${error.portalCode ? ` · portal ${error.portalCode}` : ''}`) : '—'],
        ['Query', entry.query && Object.keys(entry.query).length ? `<code>${json(entry.query, 600)}</code>` : '—'],
        ['Audit id', `<code>${e(entry.id)}</code> · sequence ${e(entry.sequence)}`],
        ['Preset', e(entry.activeConfigurationPreset?.id ?? '—')],
      ]),
    ) +
    card('Reads', readsTable) +
    card('Root step', facts) +
    body
  );
}
/** Related: other activities of the same session, who and record; the flow run and job this activity touched. */
function related(d, tree) {
  const root = tree.root ?? {};
  const spans = tree.spans ?? [];
  const who = whoValue(root.actor, root.session);
  const record = spans.find((span) => span.recordId);
  const run = spans.find((span) => typeof span.attributes?.runId === 'string')?.attributes.runId;
  const job = spans.find((span) => typeof span.attributes?.jobId === 'string')?.attributes.jobId;
  const links = [
    root.session?.sessionKey && ['Same session', pivotHref(d, { session: root.session.sessionKey })],
    who && ['Same who', pivotHref(d, { who })],
    record && ['Same record', pivotHref(d, { table: record.entity ?? '', recordId: record.recordId })],
    run && ['Flow run ↗', VIEW_LINKS.runId[2](run)],
    job && ['Job ↗', VIEW_LINKS.jobId[2](job)],
  ].filter(Boolean);
  return links.length
    ? `<p class="ui-drawer-actions ui-activity-related"><span class="ui-help">Related:</span> ${links.map(([text, href]) => `<a class="ui-button ui-small" href="${e(href)}">${e(text)}</a>`).join(' ')}</p>`
    : '';
}
const exportHref = (params) => `${API}/trace/export?${new URLSearchParams(params)}`;
function copyFallback(ctx, d) {
  if (!d.copied) return '';
  return (
    `<div class="ui-copy-fallback"><label for="activity-copy-fallback">${e(d.copied.label)}</label>` +
    `<textarea id="activity-copy-fallback" readonly rows="2" aria-describedby="activity-copy-fallback-help">${e(d.copied.text)}</textarea>` +
    `${fieldHelp(ctx, 'activity-copy-fallback', 'activity.detail', 'copyFallback')} <button type="button" class="ui-button ui-small" data-activity-action="copy-done">Done</button></div>`
  );
}
const detailTabs = (ctx, d, tree) => {
  const count = (items) => (Array.isArray(items) ? ` (${items.length})` : '');
  const rendered = (tree.spans ?? []).filter((span) => ['render', 'render-template', 'read'].includes(span.kind));
  const logs = d.detailLog;
  const logCount =
    logs && !logs.logs?.error && !logs.findings?.error
      ? ` (${(logs.logs?.items?.length ?? 0) + (logs.findings?.diagnostics?.length ?? 0)})`
      : '';
  return DETAIL_TABS.filter(([id]) => id !== 'log' || logServed(ctx) || served(ctx, '/diagnostics')).map(
    ([id, label]) => ({
      id,
      label: id === 'log' ? `${label}${logCount}` : id === 'rendered' ? `${label}${count(rendered)}` : label,
    }),
  );
};
function detailPanel(ctx, d) {
  const tree = d.tree;
  const title = (text) => `<h3 id="activity-detail-title" tabindex="-1">${text}</h3>`;
  if (!tree)
    return `${title(`Activity <code>${e(short(d.traceId))}</code>`)}<p role="status" class="ui-help">Loading activity ${e(d.traceId)}…</p>`;
  if (tree.error)
    return (
      title(`Activity <code>${e(short(d.traceId))}</code>`) +
      kit.notice(
        tree.status === 404
          ? `No retained activity has the id ${d.traceId} (it never existed or was dropped as the oldest beyond the limit).`
          : `Activity ${d.traceId} could not be read: ${failed(tree)}`,
        'warn',
      ) +
      '<p><button type="button" class="ui-button ui-small" data-activity-action="close-trace">Close activity</button></p>'
    );
  const summary = tree.trace ?? {},
    root = tree.root ?? {};
  const head =
    `<div class="ui-drawer-head">${title(e(root.name ?? summary.traceId))}${resultBadge(summary.status)}${httpBadge(root.attributes?.statusCode)}` +
    `<span class="ui-help">${e(duration(summary.durationMs))} · ${e(whoText(root.actor, root.session))}</span>` +
    '<button type="button" class="ui-button ui-small" data-activity-copy="id">Copy id</button>' +
    '<button type="button" class="ui-button ui-small" data-activity-copy="link">Copy link</button>' +
    '<button type="button" class="ui-button ui-small" id="activity-close-trace" data-activity-action="close-trace" aria-keyshortcuts="Escape">Close</button></div>';
  const facts = kit.kv([
    ['Activity', `<code>${e(summary.traceId)}</code>`],
    ['Started', when(summary.startedAt)],
    ['Duration', `${e(duration(summary.durationMs))} root · ${e(duration(summary.totalDurationMs))} total`],
    [
      'Steps',
      `${e(summary.spanCount)}${errorBadges(summary, '')}${summary.droppedSpans ? ` · ${e(summary.droppedSpans)} refused beyond the per-activity limit` : ''}`,
    ],
    ['Origin', e([root.origin?.host, root.origin?.portal, root.origin?.preset].filter(Boolean).join(' · ') || '—')],
    ['Tables', e((summary.entities ?? []).join(', ') || '—')],
  ]);
  const items = detailTabs(ctx, d, tree);
  const tab = items.some(({ id }) => id === d.detail) ? d.detail : 'steps';
  const body =
    tab === 'log'
      ? detailLogPanel(ctx, d)
      : tab === 'rendered'
        ? renderedPanel(ctx, d, tree)
        : tab === 'request'
          ? requestPanel(ctx, d, tree)
          : tab === 'json'
            ? `<p class="ui-drawer-actions"><a class="ui-button ui-small" href="${e(exportHref({ traceId: summary.traceId, format: 'json' }))}" download>Download activity</a> ` +
              `<button type="button" class="ui-button ui-small" data-activity-copy="json">Copy JSON</button></p>` +
              `<pre class="ui-example ui-json" tabindex="0" aria-label="Activity ${e(short(summary.traceId))} as JSON">${e(JSON.stringify(tree, null, 2))}</pre>`
            : stepsPanel(ctx, d, tree);
  return (
    head +
    whyLine(d, tree) +
    copyFallback(ctx, d) +
    card('Facts', facts + related(d, tree)) +
    tabsWithHelp(
      kit.tabs({ key: 'activity-detail', label: 'Activity detail', items, selected: tab, panelHtml: body }),
      // Steps keeps its help behind an (i) in its tool row, so the waterfall starts right under the tabs.
      tab === 'steps' ? '' : detailHelp(ctx, tab, items.find(({ id }) => id === tab)?.label ?? tab),
    )
  );
}

// ---- Compare two activities
/** Span path keys of a tree (kind and name from the root; a `#n` suffix for the n-th repeat): key -> node. */
function pathKeys(tree) {
  const keys = new Map();
  const visit = (nodes, prefix) => {
    const seen = new Map();
    for (const node of sorted(nodes)) {
      const base = `${prefix}/${node.kind} ${node.name}`;
      const repeat = (seen.get(base) ?? 0) + 1;
      seen.set(base, repeat);
      const key = repeat > 1 ? `${base}#${repeat}` : base;
      keys.set(key, node);
      visit(node.children, key);
    }
  };
  visit(tree?.children ?? [], '');
  return keys;
}
/** Matched step pairs (with the duration delta of B against A) and the steps only one side has. */
export function compareTrees(a, b) {
  const left = pathKeys(a),
    right = pathKeys(b);
  const matched = [...right]
    .filter(([key]) => left.has(key))
    .map(([key, node]) => {
      const before = left.get(key);
      return {
        key,
        a: before,
        b: node,
        delta:
          before.durationMs === null || node.durationMs === null || before.durationMs === undefined
            ? null
            : node.durationMs - before.durationMs,
      };
    });
  return {
    left,
    right,
    matched,
    added: [...right].filter(([key]) => !left.has(key)).map(([key, node]) => ({ key, node })),
    missing: [...left].filter(([key]) => !right.has(key)).map(([key, node]) => ({ key, node })),
  };
}
function compareNode(node, prefix, other, side, seen) {
  const base = `${prefix}/${node.kind} ${node.name}`;
  const repeat = (seen.get(base) ?? 0) + 1;
  seen.set(base, repeat);
  const key = repeat > 1 ? `${base}#${repeat}` : base;
  const match = other.get(key);
  const depth = node.depth ?? 0;
  const mark = !match
    ? kit.badge(side === 'a' ? 'only in A' : 'only in B', 'info')
    : side === 'b' && node.durationMs !== null && match.durationMs !== null
      ? kit.badge(
          signed(node.durationMs - match.durationMs),
          node.durationMs > match.durationMs ? 'warn' : node.durationMs < match.durationMs ? 'ok' : 'neutral',
        )
      : '';
  const childSeen = new Map();
  const children = sorted(node.children)
    .map((child) => compareNode(child, key, other, side, childSeen))
    .join('');
  return (
    `<li class="data-line${children ? '' : ' ui-tree-leaf'}"><span class="ui-tree-head">${kit.badge(node.kind, 'neutral')} <span class="ui-tree-name" title="${e(node.name)}">${e(node.name)}</span>${depthBadge(depth)} ` +
    `<span class="ui-tree-facts">${e(duration(node.durationMs))}${mark ? ` ${mark}` : ''}</span></span>` +
    (children ? `<ul role="group"${depth >= MAX_INDENT ? ' class="is-flat"' : ''}>${children}</ul>` : '') +
    '</li>'
  );
}
function comparePanel(ctx, d) {
  const [idA, idB] = d.compare;
  const closer =
    '<p><button type="button" class="ui-button ui-small" id="activity-close-compare" data-activity-action="close-compare">Close comparison</button></p>';
  const a = d.compared?.[idA],
    b = d.compared?.[idB];
  if (!a || !b) return `<p role="status" class="ui-help">Loading activities ${e(short(idA))} and ${e(short(idB))}…</p>`;
  const broken = [
    [idA, a],
    [idB, b],
  ].filter(([, tree]) => tree.error);
  if (broken.length)
    return (
      broken
        .map(([id, tree]) =>
          kit.notice(
            tree.status === 404
              ? `No retained activity has the id ${id} (it never existed or was dropped as the oldest beyond the limit).`
              : `Activity ${id} could not be read: ${failed(tree)}`,
            'warn',
          ),
        )
        .join('') + closer
    );
  const result = compareTrees(a, b);
  const rootDelta =
    a.trace?.durationMs === null || b.trace?.durationMs === null || a.trace?.durationMs === undefined
      ? null
      : b.trace.durationMs - a.trace.durationMs;
  const names = (items) =>
    items.length
      ? `${e(items.length)}: ${items
          .slice(0, 10)
          .map(({ node }) => `<code>${e(`${node.kind} ${node.name}`)}</code>`)
          .join(', ')}${items.length > 10 ? ` +${e(items.length - 10)}` : ''}`
      : '0';
  const facts = kit.kv([
    [
      'Activities',
      `A <a href="${e(openHref(d, idA))}"><code>${e(short(idA))}</code></a> ${e(a.root?.name ?? '')} · B <a href="${e(openHref(d, idB))}"><code>${e(short(idB))}</code></a> ${e(b.root?.name ?? '')}`,
    ],
    [
      'Root duration',
      `${e(duration(a.trace?.durationMs))} → ${e(duration(b.trace?.durationMs))}${rootDelta === null ? '' : ` (${e(signed(rootDelta))})`}`,
    ],
    ['Steps', `${e(a.trace?.spanCount ?? a.spans?.length ?? 0)} → ${e(b.trace?.spanCount ?? b.spans?.length ?? 0)}`],
    ['Matching steps', e(result.matched.length)],
    ['Only in B (added)', names(result.added)],
    ['Only in A (missing from B)', names(result.missing)],
  ]);
  const changes = kit.table({
    key: 'activity-compare',
    caption: 'Matching steps, largest duration change first',
    items: result.matched
      .filter((item) => item.delta !== null)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 20),
    emptyText: 'No matching step has ended in both activities.',
    columns: [
      { label: 'Step', render: (item) => `${kit.badge(item.b.kind, 'neutral')} ${e(item.b.name)}` },
      { label: 'A', render: (item) => e(duration(item.a.durationMs)) },
      { label: 'B', render: (item) => e(duration(item.b.durationMs)) },
      {
        label: 'Change',
        render: (item) => kit.badge(signed(item.delta), item.delta > 0 ? 'warn' : item.delta < 0 ? 'ok' : 'neutral'),
      },
    ],
  });
  const side = (tree, id, which) => {
    const seen = new Map();
    return (
      `<section aria-labelledby="activity-compare-${which}"><h4 id="activity-compare-${which}">${which.toUpperCase()} · <code>${e(short(id))}</code></h4>` +
      `<ul class="ui-tree" aria-label="Step tree of activity ${which.toUpperCase()}">${sorted(tree.children)
        .map((node) => compareNode(node, '', which === 'a' ? result.right : result.left, which, seen))
        .join('')}</ul></section>`
    );
  };
  return facts + changes + `<div class="ui-compare">${side(a, idA, 'a')}${side(b, idB, 'b')}</div>` + closer;
}

// ---- Log stream, Findings, Pages & render, Stats
/** Log lines of the page that the bar keeps (range, search, type), newest first. */
function streamLines(d) {
  const from = Date.parse(traceQuery(d).get('from') ?? '');
  const to = Date.parse(d.filters.to ?? '');
  const q = d.filters.q.toLowerCase();
  const types = d.type ? d.type.split(',') : null;
  return [...d.lines.values()]
    .filter(
      (line) =>
        (!types || types.includes(line.type)) &&
        (!Number.isFinite(from) || Date.parse(line.time) >= from) &&
        (!Number.isFinite(to) || Date.parse(line.time) <= to) &&
        (!q || JSON.stringify(line).toLowerCase().includes(q)),
    )
    .sort((a, b) => b.sequence - a.sequence);
}
function logPanel(ctx, d) {
  const answer = d.logs;
  if (answer?.error && !refusedFilter(d))
    return kit.notice(`The log stream could not be read: ${failed(answer)}`, 'warn');
  if (!answer) return '<p role="status" class="ui-help">Loading log lines…</p>';
  const all = streamLines(d);
  const findings = all.filter((line) => line.type === 'diagnostic');
  const folded = !d.showFindings && d.type !== 'diagnostic';
  const lines = folded ? all.filter((line) => line.type !== 'diagnostic') : all;
  const pager = ctx.pager('activity-log');
  // A log reads in longer pages than a table: 50 lines unless the reader chose another size.
  if (!d.logPaged) pager.size = d.logPaged = kit.PAGE_SIZES.at(-1);
  const columns = [
    { label: 'Time', sortKey: 'time', sortValue: (line) => line.sequence, render: (line) => when(line.time) },
    {
      label: 'Type',
      sortKey: 'type',
      render: (line) => kit.badge(line.type, LEVEL_TONES[line.level] ?? 'neutral'),
    },
    {
      label: 'Line',
      sortKey: 'line',
      sortValue: (line) => lineText(line),
      render: (line) => `<span class="ui-log-text">${e(lineText(line))}</span>`,
    },
    {
      label: 'Activity',
      className: 'ui-actions',
      render: (line) =>
        line.traceId
          ? `<a class="ui-button ui-small" href="${e(openHref(d, line.traceId, line.spanId ?? null))}" aria-label="Open the activity of log line ${e(line.sequence)}">Open activity →</a>`
          : '',
    },
  ];
  const order = sortedBy(ctx, 'activity-log', lines, columns, { key: 'time', order: 'desc' });
  const page = kit.pageItems(order.items, pager, { searchable: false });
  const toggle = findings.length
    ? `<button type="button" class="ui-button ui-small" id="activity-show-findings" data-activity-action="show-findings" aria-pressed="${!folded}">${folded ? `+${e(findings.length)} findings` : 'Fold findings'}</button>`
    : '';
  const status = `<span class="ui-help" role="status">${e(
    `${plural(d.lines.size, 'line')} · server keeps ${answer.retain ?? answer.retained ?? '—'}${answer.dropped ? ` · ${answer.dropped} dropped` : ''}`,
  )}</span>`;
  // The lines start right under the toolbar; the type is a filter (the drawer), the rest sits under the lines.
  return kit.dataTable({
    id: 'activity-log',
    caption: 'Log lines, newest first',
    items: page.items,
    result: page,
    emptyText: d.lines.size
      ? 'No log line matches these filters.'
      : 'No log line yet. Open a portal page; startup lines appear after a restart.',
    footActions: footOf(ctx, d, toggle + status + tabHelp(ctx, 'log')),
    rowAttrs: (line) => ({ class: `ui-log-row ui-level-${line.level ?? 'info'}` }),
    sort: order.sort,
    columns,
  });
}
/**
 * A client-side list sorted like the shared tables (the shell toggles `ctx.pager(id).sort` from the header buttons;
 * `fallback` is the order before any choice). Returns the sort shown in the header and the sorted items.
 */
function sortedBy(ctx, id, items, columns, fallback) {
  const sort = ctx.pager(id).sort ?? fallback;
  return { sort, items: kit.sortItems(items, columns, sort) };
}
const FINDING_META = new Set(['code', 'severity', 'level', 'time', 'traceId', 'spanId', 'path', 'message']);
// A finding's human names, best first: what ran (step, flow, action), then the table and the route.
const FINDING_NAMES = [
  'name',
  'displayName',
  'stepName',
  'flowName',
  'workflowName',
  'action',
  'entity',
  'table',
  'route',
];
const GUID = /^\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i;
/** An id, key, file or path field: shown only when the finding names nothing. */
const idLike = (key, value) =>
  /(?:id|key|file|path)$/i.test(key) || GUID.test(String(value)) || /[\\/]/.test(String(value));
/** A display name an export file carries (Workflows/When-an-order-is-created-<guid>.json); null for a bare id. */
function fileName(file) {
  const base = String(file ?? '')
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, '')
    .replace(/-?\{?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\}?$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  return base && /[a-z]/i.test(base) ? base : null;
}
/**
 * What a finding says: its message (or description, detail, error message); else its human name (step, flow or action
 * name, table, route, or the name in its export file) with up to two short plain fields; ids and paths only when it names
 * nothing (PLUGIN_ASYNC_COMPLETED, FLOW_TRIGGER_COMPLETED and FLOW_ACTION carry fields, not a message).
 */
function findingText(item) {
  const said = item.message ?? item.description ?? item.detail ?? item.summary ?? item.error?.message;
  if (said) return String(said);
  const plain = Object.entries(item).filter(
    ([key, value]) => !FINDING_META.has(key) && value !== null && value !== '' && typeof value !== 'object',
  );
  const named = FINDING_NAMES.find((key) => item[key] && !GUID.test(String(item[key])));
  const name = named ? String(item[named]) : fileName(item.sourceFile ?? item.file);
  const fields = plain
    .filter(([key, value]) => key !== named && !idLike(key, value) && String(value).length <= 60)
    .slice(0, 2)
    .map(([key, value]) => `${key} ${value}`);
  const ids = name
    ? []
    : plain
        .filter(([key, value]) => idLike(key, value))
        .slice(0, 1)
        .map(([key, value]) => `${key} ${value}`);
  return [name, ...fields, ...ids].filter(Boolean).join(' · ');
}
/** A finding group's summary: its first text (and path), and how many other texts the group holds. */
function firstMessage(group) {
  const texts = [...new Set(group.map(findingText).filter(Boolean))];
  const first = group.find((item) => findingText(item)) ?? group[0];
  const others = texts.length - 1;
  return `${findingText(first)}${first.path ? ` · ${first.path}` : ''}${others > 0 ? ` · +${plural(others, 'other message')}` : ''}`;
}
function findingsPanel(ctx, d) {
  const answer = d.findings;
  if (!answer) return '<p role="status" class="ui-help">Loading findings…</p>';
  if (answer.error) return kit.notice(`Findings could not be read: ${failed(answer)}`, 'warn');
  const from = Date.parse(traceQuery(d).get('from') ?? '');
  const to = Date.parse(d.filters.to ?? '');
  const q = d.filters.q.toLowerCase();
  const items = (answer.diagnostics ?? []).filter(
    (item) =>
      (!Number.isFinite(from) || !item.time || Date.parse(item.time) >= from) &&
      (!Number.isFinite(to) || !item.time || Date.parse(item.time) <= to) &&
      (!q || JSON.stringify(item).toLowerCase().includes(q)),
  );
  if (!items.length)
    return `<p class="ui-help">${answer.diagnostics?.length ? 'No finding matches these filters.' : 'No finding: nothing was observed at startup or during a request.'}</p>`;
  const groups = new Map();
  for (const item of items) {
    const key = item.code || item.type || item.severity || 'Observation';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const counts = `<span class="ui-help">${e(plural(items.length, 'finding'))} in ${e(plural(ordered.length, 'code'))} · ${e(items.filter((item) => item.traceId).length)} during an activity</span>`;
  // One row per code: the code and count, then the first message; opening it lists every occurrence.
  const columns = [
    { label: 'Code', sortKey: 'code', sortValue: ([code]) => code, render: ([code]) => `<code>${e(code)}</code>` },
    {
      label: 'Count',
      sortKey: 'count',
      sortValue: ([, group]) => group.length,
      render: ([, group]) => {
        const bad = group.some((item) => /error|fail/i.test(item.severity ?? item.level ?? ''));
        return kit.badge(String(group.length), bad ? 'bad' : 'warn');
      },
    },
    {
      label: 'Findings',
      sortKey: 'message',
      sortValue: ([, group]) => firstMessage(group),
      render: ([code, group]) => {
        const page = kit.pageItems(group, ctx.pager(`activity-finding:${code}`), { searchable: false });
        return (
          `<details class="ui-finding-group" data-ui-section="activity:finding:${e(code)}"${ctx.open?.(`activity:finding:${code}`) ? ' open' : ''}>` +
          `<summary><span class="ui-finding-first">${e(firstMessage(group))}</span></summary>` +
          (page.total > page.size ? kit.tableFoot(`activity-finding:${code}`, page) : '') +
          findingItems(d, page.items) +
          '</details>'
        );
      },
    },
  ];
  const order = sortedBy(ctx, 'activity-findings', ordered, columns, { key: 'count', order: 'desc' });
  return kit.dataTable({
    id: 'activity-findings',
    caption: 'Findings by code',
    result: kit.pageItems(order.items, ctx.pager('activity-findings'), { searchable: false }),
    footActions: footOf(ctx, d, counts + tabHelp(ctx, 'findings')),
    rowAttrs: () => ({ class: 'ui-finding-row' }),
    sort: order.sort,
    columns,
  });
}
function pagesPanel(ctx, d) {
  const state = ctx.state?.() ?? {};
  const pages = (state.status?.pages ?? state.pages ?? []).map((page) => {
    const route = typeof page === 'string' ? page : (page.path ?? page.route ?? page.url ?? '/');
    return { name: typeof page === 'string' ? page : (page.name ?? page.title ?? route), route };
  });
  const q = d.filters.q.toLowerCase();
  const shown = pages.filter((page) => !q || `${page.name} ${page.route}`.toLowerCase().includes(q));
  const evidence = state.evidence ?? state.status?.evidence ?? {};
  const byRoute = d.pages?.byRoute ?? {};
  // Page, its last activity and the actions; on a phone the actions sit under the page (activity.css).
  const columns = [
    {
      label: 'Page',
      sortKey: 'name',
      render: (page) => `${e(page.name)}<span class="ui-help ui-trace-origin"><code>${e(page.route)}</code></span>`,
    },
    {
      label: 'Last activity',
      sortKey: 'last',
      sortValue: (page) => byRoute[page.route]?.startedAt ?? null,
      render: (page) => {
        const item = byRoute[page.route];
        const proof = evidence.path === page.route ? ` · ${evidenceBadge(evidence)}` : '';
        return item
          ? `<a href="${e(openHref(d, item.traceId))}">${when(item.startedAt)}</a> ${resultBadge(item.status)} ${e(duration(item.durationMs))}${proof}`
          : `<span class="ui-help">not opened yet</span>${proof}`;
      },
    },
    {
      label: 'Actions',
      className: 'ui-actions',
      render: (page) =>
        `${pageRoute(page.route) ? `<a class="ui-button ui-small" href="${e(page.route)}" target="_blank" rel="noopener">Open page ↗</a> ` : ''}` +
        (byRoute[page.route]
          ? `<button type="button" class="ui-button ui-small" id="activity-sources-${e(page.route)}" data-activity-sources="${e(page.route)}" aria-pressed="${d.sourcesFor === page.route}">Template sources</button>`
          : ''),
    },
  ];
  const order = sortedBy(ctx, 'activity-pages', shown, columns, { key: 'name', order: 'asc' });
  const listed = kit.pageItems(order.items, ctx.pager('activity-pages'), { searchable: false });
  const table = kit.dataTable({
    id: 'activity-pages',
    caption: 'Pages of the portal export with their last activity',
    result: listed,
    sort: order.sort,
    footActions: footOf(ctx, d, tabHelp(ctx, 'pages')),
    emptyText: pages.length ? 'No page matches the search.' : 'The runtime status lists no page of the portal export.',
    columns,
  });
  const answer = d.sourcesFor ? d.pageSourcesAnswer : null;
  const sources = d.sourcesFor
    ? `<section class="ui-activity-sources" id="activity-page-sources" tabindex="-1" aria-labelledby="activity-page-sources-title"><h3 id="activity-page-sources-title">Template sources of <code>${e(d.sourcesFor)}</code></h3>` +
      (!answer || answer.route !== d.sourcesFor
        ? '<p role="status" class="ui-help">Resolving template sources…</p>'
        : answer.error
          ? kit.notice(`Template sources could not be resolved: ${failed(answer)}`, 'warn')
          : renderedRows(d, answer.spans, answer)) +
      '</section>'
    : '';
  const urls = Object.entries(evidence.artifactUrls ?? {}).filter(
    ([, url]) => typeof url === 'string' && /^\/__sim\//.test(url) && !url.includes('\\'),
  );
  const evidenceBlock = evidence.path
    ? `<h3>Rendering evidence</h3>${kit.kv([
        ['Compared route', `<code>${e(evidence.path)}</code> ${evidenceBadge(evidence)}`],
        ['Captured', when(evidence.time)],
        ...(evidence.pixels
          ? [
              [
                'Different pixels',
                e(
                  `${evidence.pixels.different} / ${evidence.pixels.total} (${(Number(evidence.pixels.fraction || 0) * 100).toFixed(4)}%)`,
                ),
              ],
            ]
          : []),
      ])}${urls.map(([label, url]) => `<a class="ui-button ui-small" href="${e(url)}" target="_blank" rel="noopener">${e(label)} screenshot ↗</a>`).join(' ')}`
    : '<p class="ui-help">No rendering evidence is saved: run verify to compare a page with the live site.</p>';
  return (
    (d.pages?.error ? kit.notice(`Last activities could not be read: ${failed(d.pages)}`, 'warn') : '') +
    table +
    sources +
    evidenceBlock
  );
}
function timeline(d) {
  const buckets = Array.isArray(d.stats?.timeline) ? d.stats.timeline : [];
  if (!buckets.length) return '<p class="ui-help">No step matches, so there is no timeline.</p>';
  const width = 1000,
    height = 80,
    step = width / buckets.length,
    max = Math.max(1, ...buckets.map((bucket) => bucket.count));
  const gap = Math.min(2, step / 4);
  // One tab stop for the whole timeline (roving tabindex): the narrowed or last-focused bucket, else the first.
  const narrowed = buckets.findIndex((bucket) => bucket.bucketStart === d.filters.from);
  const current = Math.min(buckets.length - 1, d.bucketFocus ?? Math.max(0, narrowed));
  const bars = buckets
    .map((bucket, index) => {
      const x = (index * step + gap / 2).toFixed(2),
        w = Math.max(0.5, step - gap).toFixed(2);
      const h = ((bucket.count / max) * height).toFixed(2),
        eh = ((bucket.errors / max) * height).toFixed(2);
      const label = `${kit.clock(bucket.bucketStart)}: ${plural(bucket.count, 'step')}, ${plural(bucket.errors, 'error')}${bucket.p95 === null || bucket.p95 === undefined ? '' : `, p95 ${duration(bucket.p95)}`}. Narrow the time range to this bucket.`;
      return (
        `<g class="ui-histogram-bucket" role="button" id="activity-bucket-${index}" tabindex="${index === current ? 0 : -1}" data-activity-bucket="${e(bucket.bucketStart)}" data-bucket-index="${index}" aria-label="${e(label)}"><title>${e(label)}</title>` +
        `<rect class="ui-histogram-hit" x="${(index * step).toFixed(2)}" y="0" width="${step.toFixed(2)}" height="${height}"></rect>` +
        `<rect class="ui-histogram-count" x="${x}" y="${(height - h).toFixed(2)}" width="${w}" height="${h}"></rect>` +
        (bucket.errors
          ? `<rect class="ui-histogram-errors" x="${x}" y="${(height - eh).toFixed(2)}" width="${w}" height="${eh}"></rect>`
          : '') +
        '</g>'
      );
    })
    .join('');
  return (
    `<figure class="ui-histogram"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="group" aria-label="Steps per ${e(duration(d.stats.bucketMs))} bucket; arrow keys move between buckets">${bars}</svg>` +
    `<figcaption class="ui-histogram-axis"><span>${when(d.stats.from)}</span><span>${e(buckets.length)} buckets of ${e(duration(d.stats.bucketMs))} · errors in red</span><span>${when(d.stats.to)}</span></figcaption></figure>`
  );
}
function breakdown(ctx, d) {
  const [key, label, member] = BREAKDOWNS.find(([id]) => id === d.breakdown) ?? BREAKDOWNS[0];
  const rows = Object.entries(d.stats?.[member] ?? {}).map(([name, item]) => ({ name, ...item }));
  const columns = [
    { label, sortKey: 'name', render: (item) => `<code>${e(item.name)}</code>` },
    { label: 'Steps', sortKey: 'count', render: (item) => e(item.count) },
    { label: 'Errors', sortKey: 'errors', render: (item) => (item.errors ? kit.badge(item.errors, 'bad') : '0') },
    { label: 'p50', sortKey: 'p50', render: (item) => e(item.p50 === null ? '—' : duration(item.p50)) },
    { label: 'p95', sortKey: 'p95', render: (item) => e(item.p95 === null ? '—' : duration(item.p95)) },
    { label: 'Max', sortKey: 'max', render: (item) => e(item.max === null ? '—' : duration(item.max)) },
    {
      label: 'Filter',
      className: 'ui-actions',
      render: (item) =>
        `<button type="button" class="ui-button ui-small" data-activity-pivot="${e(key)}" data-value="${e(item.name)}" aria-label="Only ${e(label.toLowerCase())} ${e(item.name)}">Filter</button>`,
    },
  ];
  // Its column filters (the kit's drawer; the shell keeps them in ctx.pager(id).filters) narrow before sorting.
  const filters = ctx.pager('activity-breakdown').filters ?? {};
  const order = sortedBy(ctx, 'activity-breakdown', kit.filterItems(rows, columns, filters), columns, {
    key: 'count',
    order: 'desc',
  });
  const table = kit.dataTable({
    id: 'activity-breakdown',
    caption: `Steps by ${label.toLowerCase()}`,
    // The bottom bar like every Activity table: count, rows and pager (the zone stays named once, in Stats' own bar).
    result: kit.pageItems(order.items, ctx.pager('activity-breakdown'), { text: (item) => item.name }),
    // Its own search and Filters · n in its toolbar row (D-M-11): it is a table inside Stats, not the tab's main list.
    search: true,
    filters,
    sort: order.sort,
    emptyText: 'No step matches.',
    columns,
  });
  return kit.tabs({
    key: 'activity-breakdown',
    label: 'Break steps down by',
    items: BREAKDOWNS.map(([id, text]) => ({ id, label: text })),
    selected: key,
    panelHtml: table,
  });
}
/** Root p95 of the current window against the equal-length window before it. */
function trendTile(d) {
  const tile = { label: 'Root p95 vs before', value: '—' };
  if (!d.previous || d.previous.none) return { ...tile, detail: 'choose a time range to compare' };
  if (d.previous.error) return { ...tile, detail: `the previous window could not be read: ${failed(d.previous)}` };
  const now = d.stats?.roots?.p95,
    before = d.previous.roots?.p95;
  const span = d.previous.length ? ` ${duration(d.previous.length)}` : '';
  if (before === null || before === undefined) return { ...tile, detail: `no ended activity in the previous${span}` };
  if (now === null || now === undefined) return { ...tile, detail: `${duration(before)} in the previous${span}` };
  const change = before > 0 ? ((now - before) / before) * 100 : null;
  return {
    ...tile,
    value: change === null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.abs(change).toFixed(0)}%`,
    tone: change > 10 ? 'warn' : change < -10 ? 'ok' : 'neutral',
    detail: `${duration(now)} now · ${duration(before)} in the previous${span}`,
  };
}
/** One line per step reference of /trace/stats (slowest, errors): a link to the step, its duration and error. */
function spanReferences(d, items, emptyText) {
  if (!items.length) return `<p class="ui-help">${e(emptyText)}</p>`;
  return `<ol class="ui-span-refs">${items
    .map(
      (item) =>
        `<li class="data-line"><a href="${e(openHref(d, item.traceId, item.spanId))}">${kit.badge(item.kind ?? '—', 'neutral')} <span class="ui-span-ref-name">${e(item.name)}</span></a>` +
        ` <span class="ui-span-ref-meta">${e(duration(item.durationMs))}${item.entity ? ` · ${e(item.entity)}` : ''} · ${when(item.startedAt)}</span>` +
        (item.error ? `<span class="ui-span-ref-error">${e(errorText(item.error))}</span>` : '') +
        '</li>',
    )
    .join('')}</ol>`;
}
function statsPanel(ctx, d) {
  if (refusedFilter(d)) return '<p class="ui-help">No statistics while a filter is not valid.</p>';
  if (!d.stats) return '<p role="status" class="ui-help">Loading statistics…</p>';
  if (d.stats.error) return kit.notice(`Statistics could not be read: ${failed(d.stats)}`, 'warn');
  const stats = d.stats,
    kinds = stats.byKind ?? {},
    status = stats.byStatus ?? {};
  const overall = stats.overall ?? {},
    roots = stats.roots;
  const errors = overall.errors ?? 0,
    denied = status.denied?.count ?? 0;
  const percentiles = (figures) =>
    figures?.p50 === null || figures?.p50 === undefined ? '—' : `${duration(figures.p50)} / ${duration(figures.p95)}`;
  return (
    kit.tiles([
      { label: 'Activities', value: roots?.count ?? '—', detail: `${d.settings?.status?.retained ?? 0} retained` },
      { label: 'Steps', value: overall.count ?? 0, detail: `p50 / p95 ${percentiles(overall)}` },
      { label: 'Failed steps', value: errors, tone: errors ? 'bad' : 'neutral' },
      { label: 'Denied steps', value: denied, tone: denied ? 'warn' : 'neutral' },
      {
        label: 'Root p50 / p95',
        value: percentiles(roots),
        detail: roots?.max === null || roots?.max === undefined ? '—' : `max ${duration(roots.max)}`,
      },
      trendTile(d),
      // Counted over the kept, filtered activities (Health counts since start).
      {
        label: 'Plug-in step runs',
        value: kinds['plugin-step']?.count ?? 0,
        detail: 'in the kept, filtered activities',
      },
      { label: 'Flow runs', value: kinds['flow-run']?.count ?? 0 },
      { label: 'Connector calls', value: kinds.connector?.count ?? 0 },
    ]) +
    `<div class="ui-span-spotlight"><section aria-labelledby="activity-slowest-title"><h3 id="activity-slowest-title">Slowest steps</h3>${spanReferences(d, (stats.slowest ?? []).slice(0, 5), 'No step has ended.')}</section>` +
    `<section aria-labelledby="activity-errors-title"><h3 id="activity-errors-title">Latest errors</h3>${spanReferences(d, (stats.errors ?? []).slice(0, 5), 'No step ended in error.')}</section></div>` +
    `<h3>Timeline</h3>${timeline(d)}<h3>Breakdown</h3>${breakdown(ctx, d)}` +
    bottomBar(ctx, d, 'stats', '')
  );
}

// ---- Settings
const LEVEL_NOTES = {
  off: 'Nothing is recorded as steps. Each hook reads one setting and returns; the request audit keeps recording.',
  summary: 'Every step with names, timing, result, attributes and events. No request or response payload is captured.',
  full: 'Summary plus redacted inputs and outputs (bodies, queries, plug-in targets, flow actions). Each payload costs a deep copy and one JSON serialisation.',
};
function settingsPanel(ctx, d) {
  if (!d.settings || d.settings.error)
    return kit.notice(
      d.settings?.error
        ? `Tracing settings could not be read: ${failed(d.settings)}`
        : 'This host did not report tracing settings.',
      'warn',
    );
  const settings = d.settings.settings ?? {},
    status = d.settings.status ?? {},
    persist = status.persist ?? {};
  const levels = LEVELS.map(
    (level) =>
      `<div class="ui-check"><input type="radio" id="activity-level-${level}" name="level" value="${level}"${settings.level === level ? ' checked' : ''} aria-describedby="activity-level-${level}-help">` +
      `<label for="activity-level-${level}">${e(level)}</label></div>${kit.fieldHelp(`activity-level-${level}`, LEVEL_NOTES[level])}`,
  ).join('');
  return (
    `<form id="${SETTINGS_FORM}" class="ui-form" data-activity-settings><fieldset><legend>Tracing level</legend>${levels}</fieldset>` +
    `<div class="ui-check"><input type="checkbox" id="activity-persist" name="persist"${settings.persist ? ' checked' : ''} aria-describedby="activity-persist-help"><label for="activity-persist">Persist ended activities</label></div>` +
    `${fieldHelp(ctx, 'activity-persist', 'activity.settings', 'persist')}` +
    `<fieldset class="ui-limits"><legend>Retention limits</legend>${LIMITS.map(
      ([name, label, min, max]) =>
        `<div><label for="activity-limit-${name}">${e(label)}</label><input id="activity-limit-${name}" name="${name}" type="number" min="${min}" max="${max}" step="1" required value="${e(settings[name] ?? '')}" aria-describedby="activity-limit-${name}-help">` +
        `${fieldHelp(ctx, `activity-limit-${name}`, 'activity.settings', name)}</div>`,
    ).join('')}</fieldset>` +
    '<p><button type="submit" class="ui-button ui-primary ui-small">Save tracing settings</button> ' +
    '<button type="button" class="ui-button ui-small" data-activity-action="clear">Clear activities</button></p></form>' +
    '<h3>Store</h3>' +
    kit.kv([
      ['Activities kept', e(status.retained ?? 0)],
      ['Steps kept', `${e(status.spans ?? 0)} · ${e(status.running ?? 0)} running`],
      ['Dropped', `${e(status.dropped ?? 0)} activities · ${e(status.droppedSpans ?? 0)} steps`],
      ['Memory estimate', e(`${Math.round((status.memoryBytes ?? 0) / 1024)} KiB`)],
      ['Live listeners', e(status.listeners ?? 0)],
      [
        'Persistence',
        persist.enabled
          ? `<code>${e(persist.directory ?? '—')}</code> · ${e(persist.written ?? 0)} written · ${e(persist.failures ?? 0)} failed${persist.lastError ? ` · ${e(persist.lastError)}` : ''}`
          : `off${persist.lastError ? ` · ${e(persist.lastError)}` : ''}`,
      ],
    ])
  );
}

/** Puts `text` on the clipboard; when the browser refuses, shows it selected in a read-only field instead. */
async function copy(ctx, d, label, text) {
  try {
    await globalThis.navigator.clipboard.writeText(text);
    d.copied = null;
    ctx.notify(`${label} copied.`);
    ctx.render?.();
  } catch {
    d.copied = { label, text };
    ctx.render?.();
    const field = globalThis.document?.getElementById('activity-copy-fallback');
    field?.focus();
    field?.select?.();
  }
}
function copyAction(ctx, d, what) {
  if (what === 'link') {
    const where = globalThis.location;
    return copy(ctx, d, 'Link', `${where?.origin ?? ''}${where?.pathname ?? '/_sim/'}#${hashOf(d)}`);
  }
  if (what === 'span') return copy(ctx, d, 'Step id', d.spanId ?? '');
  if (what === 'json') return copy(ctx, d, 'Activity JSON', JSON.stringify(d.tree ?? null, null, 2));
  return copy(ctx, d, 'Activity id', d.traceId ?? '');
}
/** What Export downloads, behind an (i); a host without the bundle route gets the activity-only text. */
function exportHelp(ctx) {
  const fields = helpEntry(ctx, ID).fields ?? {};
  const text = served(ctx, '/activity') ? fields.exportFormat : fields.exportFormatActivities;
  return text ? kit.info({ id: 'activity-export-format-help', label: 'About Export', text }) : '';
}
/** "How this works" for the chrome's (i) after the breadcrumb: `activity.about`, else the view's own help. */
function aboutHelp(ctx) {
  const entry = helpEntry(ctx, `${ID}.about`).intro ? helpEntry(ctx, `${ID}.about`) : helpEntry(ctx, ID);
  if (!entry.intro) return null;
  return {
    text: entry.intro,
    steps: entry.steps ?? [],
    docs: entry.doc ? [kit.docLink(entry.doc, ctx.docs?.() ?? {})] : [],
  };
}
/** The workspace tabs as a tablist (kit.tabs markup and keys) whose panel is rendered on its own under the toolbar. */
const tabStrip = (items, selected) =>
  `<span class="ui-tablist ui-activity-tabstrip" role="tablist" aria-label="Activity workspace">${items
    .map(
      (item) =>
        `<button type="button" role="tab" class="ui-tab" id="activity-tabs-tab-${e(item.id)}" aria-selected="${item.id === selected}" aria-controls="activity-tabs-panel" tabindex="${item.id === selected ? 0 : -1}" data-tab="activity-tabs" data-tab-id="${e(item.id)}">${e(item.label)}</button>`,
    )
    .join('')}</span>`;
/** A tab the address names that this host does not serve: one line says so (an old #evidence link, say). */
function tabNote(ctx, d) {
  if (d.tab === tabOf(ctx, d)) return '';
  return `<p class="ui-help ui-activity-note">${e(tabLabel(d.tab))} is not available on this host; showing Activities.</p>`;
}
/** The export link of the current filters: the bundle (N1 /activity/export) or the activities alone. */
function exportLink(ctx, d) {
  const bundle = served(ctx, '/activity');
  const format = !bundle && d.exportFormat.startsWith('bundle') ? 'ndjson' : d.exportFormat;
  const query = sortQuery(d, traceQuery(d));
  if (format.startsWith('bundle')) {
    query.set('format', 'bundle');
    if (format === 'bundle-otlp') query.set('traces', 'otlp');
    return `${API}/activity/export?${query}`;
  }
  query.set('format', format);
  return `${API}/trace/export?${query}`;
}

// ---- Keyboard: `/` focuses search, Escape closes, ↑/↓ move between activities (also when focus is outside the view).
let keys = null;
function rowStep(event, from) {
  const rows = [...(globalThis.document?.querySelectorAll?.('[data-activity-open]') ?? [])];
  if (!rows.length) return false;
  const index = rows.indexOf(from);
  const next =
    index < 0 ? (event.key === 'ArrowDown' ? 0 : rows.length - 1) : index + (event.key === 'ArrowDown' ? 1 : -1);
  if (next < 0 || next >= rows.length) return true;
  event.preventDefault();
  rows[next].focus();
  return true;
}
const typing = (target) => Boolean(target?.closest?.('input, select, textarea, [contenteditable="true"]'));

export const view = {
  id: ID,
  label: LABEL,
  icon: '⋔',
  hosts: ['power-pages', 'standalone'],
  requires: ['/__sim/api/trace'],
  // Pages & render reads the page list and saved evidence from the workspace state: fetched fresh on entry.
  fresh: true,

  /** The address is the whole state: filters, range, tab, Live, the open activity (path segments) and its step. */
  route(ctx, params, segments = []) {
    const d = stateOf(ctx);
    const traceId = segments[0] || params.get('traceId') || null;
    const before = { list: listKey(ctx, d), traceId: d.traceId };
    d.filters = filtersOf(params);
    const range = params.get('range');
    d.range = Object.hasOwn(RANGES, range) ? range : d.filters.from || d.filters.to ? 'custom' : 'all';
    d.sort = {
      by: Object.hasOwn(SORTS, params.get('sort')) ? params.get('sort') : 'start',
      order: params.get('order') === 'asc' ? 'asc' : 'desc',
    };
    d.tab = TAB_IDS.includes(params.get('tab')) ? params.get('tab') : 'activities';
    d.type = params.get('type') ?? '';
    d.whoName = (d.filters.who && params.get('whoName')?.trim()) || null;
    d.reads = params.get('reads') === '1';
    d.live = ['1', 'true', 'on'].includes(params.get('live') ?? '');
    d.traceId = traceId;
    d.spanId = (traceId && (segments[1] || params.get('spanId'))) || null;
    d.detail = DETAIL_TABS.some(([id]) => id === params.get('detail')) ? params.get('detail') : 'steps';
    d.stepsAs = params.get('steps') === 'tree' ? 'tree' : 'waterfall';
    d.spanSearch = params.get('spanSearch') ?? '';
    d.errorsOnly = params.get('errorsOnly') === 'true';
    d.compare = compareOf(params.get('compare'));
    d.bucketFocus = null;
    if (listKey(ctx, d) !== before.list) ctx.pager('activity-list').page = 1;
    if (d.traceId !== before.traceId) {
      d.tree = null;
      d.children = null;
      d.copied = null;
      d.linked = {};
      d.detailLog = d.request = d.sources = null;
    }
    // The link names a step, an activity or a comparison: that lands in view once it rendered.
    if (d.spanId) ctx.reveal?.('#activity-span-drawer');
    else if (d.traceId) ctx.reveal?.('#activity-detail-title');
    else if (d.compare) ctx.reveal?.('[data-ui-section="activity:compare"]');
    // The controls show the address, not what was typed before.
    ctx.forgetDraft?.(FILTER_FORM);
  },

  /** Fetches the parts whose key changed, plus the forced ones; an answer is kept only while it still matches. */
  async load(ctx, force = []) {
    const d = stateOf(ctx);
    for (const part of force ?? []) d.forced.add(part);
    for (let pass = 0; pass < 3; pass++) {
      // The settings decide whether the list reads traces or the audit: they come first.
      if (!d.settings) {
        d.settings = await FETCHERS.settings(ctx, d);
        d.keys.settings = 'settings';
      }
      // A part is read when what it shows changed, when forced, or when its answer was dropped (an activity closed).
      const parts = [...wanted(ctx, d)].filter(
        ([part, key]) => d.forced.has(part) || d.keys[part] !== key || d[SLOTS[part] ?? part] == null,
      );
      if (!parts.length) break;
      // One clock reading per load: the range of the list, the stats and the window before it end at the same instant.
      const now = Date.now();
      const jobs = parts.map(([part, key]) => {
        d.forced.delete(part);
        const stamp = (d.generations[part] = (d.generations[part] ?? 0) + 1);
        return FETCHERS[part](ctx, d, now).then((value) => ({ part, key, stamp, value }));
      });
      for (const { part, key, stamp, value } of await Promise.all(jobs)) {
        // A newer load of this part started, or the address moved on: this answer is stale.
        if (stamp !== d.generations[part] || wanted(ctx, d).get(part) !== key) continue;
        const was = d.settings?.settings;
        if (part === 'settings') {
          if (was && ['level', 'persist', ...LIMITS.map(([n]) => n)].some((n) => was[n] !== value?.settings?.[n]))
            ctx.forgetDraft?.(SETTINGS_FORM);
        }
        if (part === 'list' && value && !value.error && value.page) ctx.pager('activity-list').page = value.page;
        if (part === 'logs' && Array.isArray(value?.items)) keepLines(d, value.items);
        d[SLOTS[part] ?? part] = value;
        // A page the store clamped (fewer pages than asked) is the page shown: no second read for it.
        d.keys[part] = part === 'list' ? wanted(ctx, d).get('list') : key;
      }
    }
    d.loaded = true;
    follow(ctx, d);
    if (d.spanId) await loadTargets(ctx, d);
  },

  leave(ctx) {
    const d = ctx?.data?.[ID];
    stopLive(d);
    if (keys) globalThis.document?.removeEventListener?.('keydown', keys);
    keys = null;
    if (d) {
      d.loaded = false;
      // Coming back reads everything again: the runtime moved on while the view was closed.
      d.keys = {};
      d.settings = null;
    }
  },

  render(ctx) {
    const d = stateOf(ctx);
    // The scroll position of the column this render replaces (mounted puts it back).
    const shown = globalThis.document?.querySelector?.('.ui-trace-side');
    d.sideScroll = shown ? { key: shown.dataset.traceSide, top: shown.scrollTop } : null;
    const level = d.settings?.settings?.level;
    const liveOff = channelServed(ctx, 'trace') === false;
    const tabs = tabsFor(ctx);
    const tab = tabOf(ctx, d);
    const toolbar =
      // Inside the chrome's toolbar row (kit.pageChrome): Live with its status, the tab's quick filter, Refresh, Export with
      // its (i) and Settings (⚙, named on hover and for screen readers), so the search and Filters fit the same row.
      '<span class="ui-activity-actions">' +
      `<button type="button" class="ui-button ui-small" id="activity-live"${liveOff ? ' disabled' : ''} data-activity-action="live" aria-pressed="${Boolean(d.live)}" aria-label="Live">${d.live ? '● <span class="ui-wide">Live: on</span><span class="ui-narrow">Live</span>' : '<span class="ui-wide">Live: off</span><span class="ui-narrow">Live</span>'}</button><span class="ui-help" role="status">${e(liveOff ? 'This host does not stream activity' : d.live ? liveText(ctx, d) : '')}</span>` +
      quickFilter(tab, d) +
      // On a phone the actions keep one row: their words give way to symbols (the accessible names stay).
      '<button type="button" class="ui-button ui-small" id="activity-refresh" data-activity-action="refresh" aria-label="Refresh"><span class="ui-wide">Refresh</span><span class="ui-narrow" aria-hidden="true">↻</span></button>' +
      `<select id="activity-export-format" data-activity-export-format aria-label="Export format" aria-describedby="activity-export-format-help">${EXPORT_FORMATS.filter(
        ([value]) => served(ctx, '/activity') || !value.startsWith('bundle'),
      )
        .map(
          ([value, text]) =>
            `<option value="${value}"${d.exportFormat === value ? ' selected' : ''}>${e(text)}</option>`,
        )
        .join('')}</select>` +
      `<a class="ui-button ui-small" id="activity-export" href="${e(exportLink(ctx, d))}" download aria-label="Export filtered"><span class="ui-wide">Export</span><span class="ui-narrow" aria-hidden="true">⇩</span></a>${exportHelp(ctx)}` +
      `<button type="button" class="ui-button ui-small" id="activity-settings" data-activity-action="settings" aria-label="Tracing settings" title="Tracing settings${level ? ` · level ${e(level)}` : ''}">⚙</button></span>`;
    const off =
      level === 'off' && !auditServed(ctx)
        ? kit.notice('Tracing is off and this host keeps no request audit: nothing new is recorded.', 'warn')
        : level === 'off' && tab !== 'activities'
          ? kit.notice('Tracing is off: only the request audit records new requests (Activities lists it).', 'warn')
          : '';
    const auditOnly = AUDIT_ONLY.filter((name) => d.filters[name]);
    const noAudit =
      auditOnly.length && !auditServed(ctx)
        ? kit.notice(
            `This host keeps no request audit, so ${auditOnly.map((name) => LABELS[name]).join(', ')} cannot filter its activities.`,
            'warn',
          )
        : '';
    const logNote = tabs.some(([id]) => id === 'log')
      ? ''
      : '<p class="ui-help ui-activity-note">No server log stream on this host.</p>';
    const body =
      tab === 'log'
        ? logPanel(ctx, d)
        : tab === 'findings'
          ? findingsPanel(ctx, d)
          : tab === 'pages'
            ? pagesPanel(ctx, d)
            : tab === 'stats'
              ? statsPanel(ctx, d)
              : activitiesPanel(ctx, d);
    const findingCount = Array.isArray(d.findings?.diagnostics) ? ` (${d.findings.diagnostics.length})` : '';
    const side =
      (d.compare
        ? panel(
            ctx,
            'compare',
            'Compare activities',
            `${short(d.compare[0])} · ${short(d.compare[1])}`,
            comparePanel(ctx, d),
            true,
          )
        : '') +
      (d.traceId
        ? `<section class="ui-activity-detail" data-ui-section="activity:detail" aria-labelledby="activity-detail-title">${detailPanel(ctx, d)}</section>`
        : '');
    // The tab strip sits in the chrome's toolbar row; its panel follows the toolbar directly (D-M-7).
    const strip = tabStrip(
      tabs.map(([id, label]) => ({ id, label: id === 'findings' ? `${label}${findingCount}` : label })),
      tab,
    );
    // On a phone the tabs are one select (the strip would wrap to two rows above the list).
    const tabPick = `<label class="ui-sr-only" for="activity-tab-select">Tab</label><select id="activity-tab-select" class="ui-activity-tabselect" data-activity-tab-select>${tabs
      .map(
        ([id, label]) =>
          `<option value="${e(id)}"${id === tab ? ' selected' : ''}>${e(id === 'findings' ? `${label}${findingCount}` : label)}</option>`,
      )
      .join('')}</select>`;
    const main =
      `<div class="ui-tabpanel ui-activity-panel" role="tabpanel" id="activity-tabs-panel" aria-labelledby="activity-tabs-tab-${e(tab)}">` +
      body +
      '</div>';
    return (
      kit.pageChrome({
        breadcrumb: { section: String(ctx.group?.() ?? 'Monitor'), page: LABEL },
        help: aboutHelp(ctx),
        actions: strip + tabPick + toolbar + searchBox(tab, d),
        filters: { count: activeFilters(d), drawerId: DRAWER },
        chips: chips(ctx, d),
      }) +
      drawerOf(ctx, d) +
      tabNote(ctx, d) +
      (d.liveRefused ? kit.notice(d.liveRefused, 'warn') : '') +
      off +
      noAudit +
      invalidFilter(d) +
      logNote +
      // At 1200 px and wider the open activity sits beside the list (ui-kit.css .ui-trace-layout).
      `<div class="ui-trace-layout${side ? ' has-detail' : ''}"><div class="ui-trace-main">${main}</div>${side ? `<div class="ui-trace-side" data-trace-side="${e(sideKey(d))}">${side}</div>` : ''}</div>` +
      panel(ctx, 'settings', 'Tracing settings', level ? `level ${level}` : 'unavailable', settingsPanel(ctx, d))
    );
  },

  /** The open activity's column scrolls on its own beside the list (1200 px and wider); every render replaces it, so its
   * scroll position, read in render() before the replacement, is put back here. The document-level keys are attached
   * once: `/` focuses the search, Escape closes, ↓ enters the list from anywhere outside a field. */
  mounted(ctx) {
    const d = stateOf(ctx);
    const side = globalThis.document?.querySelector?.('.ui-trace-side');
    if (side && d.sideScroll?.key === side.dataset.traceSide) side.scrollTop = d.sideScroll.top;
    if (keys || typeof globalThis.document?.addEventListener !== 'function') return;
    keys = (event) => {
      if (event.defaultPrevented || globalThis.document.getElementById('content')?.contains(event.target)) return;
      if (typing(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '/' || event.key === 'Escape' || event.key === 'ArrowDown' || event.key === 'ArrowUp')
        view.handle(ctx, {
          type: 'keydown',
          key: event.key,
          target: event.target,
          preventDefault: () => event.preventDefault(),
        });
    };
    globalThis.document.addEventListener('keydown', keys);
  },

  handle(ctx, event) {
    const d = stateOf(ctx);
    const target = (selector) => event.target?.closest?.(selector);
    /** The list state changed: page 1, the address, then what the open tab shows. */
    const apply = (keepForm = false) => {
      // A text field that applied on change keeps the form as typed (Enter submits it right after the change).
      if (!keepForm) ctx.forgetDraft?.(FILTER_FORM);
      ctx.pager('activity-list').page = 1;
      d.bucketFocus = null;
      syncHash(d);
      // The chips, the toggle count and the form show the new filters at once; the list follows when it loaded. A text
      // field that applied as focus left it renders with the list instead, so the click that moved focus still lands.
      if (!keepForm) ctx.render?.();
      reload(ctx);
      return true;
    };
    if (event.type === 'submit' && target('[data-activity-filters]')) {
      event.preventDefault();
      const fields = Object.fromEntries(
        [...new FormData(target('[data-activity-filters]'))].map(([name, value]) => [name, String(value).trim()]),
      );
      const previous = { ...d.filters };
      // Only the fields on screen: folded More filters keep their values (their chips show them).
      for (const name of FILTERS) if (Object.hasOwn(fields, name)) d.filters[name] = fields[name];
      if (Object.hasOwn(fields, 'type')) d.type = fields.type;
      // A time input shows whole seconds: an unchanged one keeps the exact time it shows (a timeline bucket).
      for (const name of ['from', 'to'])
        if (d.filters[name] && d.filters[name] === localInput(previous[name])) d.filters[name] = previous[name];
        else if (d.filters[name]) {
          const at = Date.parse(d.filters[name]);
          d.filters[name] = Number.isFinite(at) ? new Date(at).toISOString() : '';
        }
      d.range = d.filters.from || d.filters.to ? 'custom' : Object.hasOwn(RANGES, fields.range) ? fields.range : 'all';
      return apply();
    }
    // A text field applies when its value changed (leaving the field), like Enter.
    const text = event.type === 'change' ? target('[data-activity-filters] input[name], [data-activity-search]') : null;
    if (text && FILTERS.includes(text.name)) {
      const value = String(text.value ?? '').trim();
      const time = text.type === 'datetime-local';
      if (time && value === localInput(d.filters[text.name])) return true;
      const at = time && value ? Date.parse(value) : NaN;
      d.filters[text.name] = time ? (Number.isFinite(at) ? new Date(at).toISOString() : '') : value;
      if (time) d.range = d.filters.from || d.filters.to ? 'custom' : d.range === 'custom' ? 'all' : d.range;
      return apply(true);
    }
    // A choice in the bar applies at once; text fields apply with Enter or Apply.
    if (event.type === 'change' && target('[data-activity-filters] [data-activity-select]')) {
      const field = target('[data-activity-select]');
      if (field.name === 'range') {
        if (!Object.hasOwn(RANGES, field.value)) return true;
        d.range = field.value;
        d.filters.from = d.filters.to = '';
      } else if (field.name === 'type') d.type = field.value;
      else if (FILTERS.includes(field.name)) d.filters[field.name] = field.value;
      return apply();
    }
    if (event.type === 'change' && target('[data-activity-tab-select]'))
      return selectTab(ctx, d, 'activity-tabs', target('[data-activity-tab-select]').value);
    if (event.type === 'change' && target('[data-table-size="activity-list"]')) {
      const pager = ctx.pager('activity-list');
      pager.size = Number(target('[data-table-size="activity-list"]').value);
      pager.page = 1;
      reload(ctx);
      return true;
    }
    if (event.type === 'change' && target('[data-activity-export-format]')) {
      const format = target('[data-activity-export-format]').value;
      if (EXPORT_FORMATS.some(([value]) => value === format)) d.exportFormat = format;
      ctx.render?.();
      return true;
    }
    if (event.type === 'change' && target('[data-activity-pick]')) {
      const box = target('[data-activity-pick]'),
        id = box.dataset.activityPick;
      d.picked = d.picked.filter((item) => item !== id);
      // Ticking a third activity replaces the oldest tick.
      if (box.checked) d.picked = [...d.picked, id].slice(-2);
      ctx.render?.();
      return true;
    }
    if (event.type === 'change' && target('[data-activity-errors-only]')) {
      d.errorsOnly = Boolean(target('[data-activity-errors-only]').checked);
      syncHash(d);
      ctx.render?.();
      return true;
    }
    if (event.type === 'input' && target('[data-activity-span-search]')) {
      d.spanSearch = target('[data-activity-span-search]').value;
      syncHash(d);
      ctx.render?.();
      return true;
    }
    const form = event.type === 'submit' ? target('[data-activity-settings]') : null;
    if (form) {
      event.preventDefault();
      const fields = new FormData(form);
      const body = {
        level: String(fields.get('level') ?? d.settings?.settings?.level ?? 'summary'),
        persist: fields.get('persist') !== null,
      };
      for (const [name] of LIMITS) {
        const value = fields.get(name);
        if (value !== null && String(value).trim() !== '') body[name] = Number(value);
      }
      const before = d.settings?.settings ?? {};
      return pending(ctx, event.submitter ?? form.querySelector('[type=submit]'), async () => {
        d.settings = await ctx.request('/trace/settings', { method: 'PUT', body: JSON.stringify(body) });
        // The saved settings are the truth now: the radios and limits show them, not the input before the save.
        ctx.forgetDraft?.(SETTINGS_FORM);
        const saved = d.settings?.settings ?? body;
        const limits = LIMITS.some(([name]) => Object.hasOwn(body, name) && body[name] !== before[name])
          ? `; keeps ${saved.traces} activities, ${saved.spansPerTrace} steps per activity, ${saved.payloadBytes} payload bytes`
          : '';
        ctx.notify(`Tracing level ${saved.level ?? body.level}${body.persist ? ', persisted' : ''}${limits}.`);
        ctx.render?.();
        // Turning tracing on or off switches the list between activities and the audit; a smaller retention drops
        // the oldest activities at once.
        if (saved.level !== before.level || (before.traces !== undefined && saved.traces < before.traces))
          reload(ctx, ['list', 'stats']);
      });
    }
    if (event.type === 'keydown') {
      const tab = target('[role="tab"][data-tab]');
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const ids =
          tab.dataset.tab === 'activity-tabs'
            ? tabsFor(ctx).map(([id]) => id)
            : tab.dataset.tab === 'activity-detail'
              ? detailTabs(ctx, d, d.tree ?? {}).map(({ id }) => id)
              : BREAKDOWNS.map(([id]) => id);
        const next = step(ids.length, ids.indexOf(tab.dataset.tabId), event.key);
        return selectTab(ctx, d, tab.dataset.tab, ids[next]);
      }
      const bucket = target('[data-activity-bucket]');
      if (bucket && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        return narrow(ctx, d, bucket.dataset.activityBucket);
      }
      if (bucket && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        d.bucketFocus = step(d.stats?.timeline?.length ?? 1, Number(bucket.dataset.bucketIndex), event.key);
        ctx.render?.();
        focus(`activity-bucket-${d.bucketFocus}`);
        return true;
      }
      if (typing(event.target)) return false;
      if (event.key === '/') {
        event.preventDefault();
        // The search sits in the toolbar row (D-M-11).
        focus('activity-q');
        return true;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') return rowStep(event, target('[data-activity-open]'));
      if (event.key === 'Escape' && d.spanId) {
        event.preventDefault();
        return closeSpan(ctx, d);
      }
      if (event.key === 'Escape' && d.traceId) {
        event.preventDefault();
        return closeTrace(ctx, d);
      }
      return false;
    }
    if (event.type !== 'click') return false;
    // A compare tick is a checkbox inside a row: it toggles natively and never opens the row's activity.
    if (target('[data-activity-pick]')) return true;
    const action = target('[data-activity-action]')?.dataset.activityAction;
    if (action === 'refresh') {
      d.lines.clear();
      reload(ctx, [...wanted(ctx, d).keys()]);
      return true;
    }
    if (action === 'clear-filters') {
      d.filters = blankFilters();
      d.range = 'all';
      d.type = '';
      d.whoName = null;
      d.sort = defaultSort();
      apply();
      focus('activity-q');
      return true;
    }
    if (action === 'errors') {
      d.filters.result = d.filters.result === FAILED ? '' : FAILED;
      apply();
      focus('activity-errors');
      return true;
    }
    if (action === 'startup') {
      d.type = d.type === 'startup' ? '' : 'startup';
      apply();
      focus('activity-startup');
      return true;
    }
    if (action === 'more') {
      d.more = !d.more;
      ctx.render?.();
      focus(d.more ? 'activity-kind' : 'activity-more');
      return true;
    }
    if (action === 'settings') {
      ctx.reveal?.('[data-ui-section="activity:settings"]');
      ctx.render?.();
      return true;
    }
    if (action === 'live') {
      if (channelServed(ctx, 'trace') === false) return true;
      d.live = !d.live;
      d.liveRefused = null;
      syncHash(d);
      if (d.live) follow(ctx, d);
      else stopLive(d);
      ctx.render?.();
      return true;
    }
    if (action === 'reads') {
      d.reads = !d.reads;
      syncHash(d);
      ctx.render?.();
      return true;
    }
    if (action === 'show-findings') {
      d.showFindings = !d.showFindings;
      ctx.render?.();
      return true;
    }
    if (action === 'clear') {
      ctx.askConfirmation(
        'Clear activities?',
        'Remove every retained activity from this runtime. The request audit, log lines, findings and activity files already persisted stay.',
        async () => {
          await ctx.request('/trace/clear', { method: 'POST', body: '{}' });
          d.traceId = d.spanId = null;
          d.tree = null;
          d.compare = d.compared = null;
          d.picked = [];
          ctx.pager('activity-list').page = 1;
          syncHash(d);
          await reload(ctx, ['list', 'stats', 'pages', 'settings']);
          ctx.notify('Activities cleared.');
        },
        'Clear activities',
      );
      return true;
    }
    if (action === 'compare') {
      if (d.picked.length !== 2) return true;
      d.compare = [...d.picked];
      d.compared = null;
      syncHash(d);
      ctx.reveal?.('[data-ui-section="activity:compare"]');
      reload(ctx);
      ctx.render?.();
      return true;
    }
    if (action === 'close-compare') {
      d.compare = d.compared = null;
      syncHash(d);
      ctx.render?.();
      focus('activity-compare');
      return true;
    }
    if (action === 'copy-done') {
      d.copied = null;
      ctx.render?.();
      return true;
    }
    if (action === 'close-trace') return closeTrace(ctx, d);
    if (action === 'close-span') return closeSpan(ctx, d);
    const copyWhat = target('[data-activity-copy]')?.dataset.activityCopy;
    if (copyWhat) {
      copyAction(ctx, d, copyWhat);
      return true;
    }
    const tab = target('[role="tab"][data-tab]');
    if (tab) return selectTab(ctx, d, tab.dataset.tab, tab.dataset.tabId);
    const as = target('[data-activity-steps-as]');
    if (as) {
      d.stepsAs = as.dataset.activityStepsAs === 'tree' ? 'tree' : 'waterfall';
      syncHash(d);
      ctx.render?.();
      focus(`activity-steps-${d.stepsAs}`);
      return true;
    }
    const bucket = target('[data-activity-bucket]');
    if (bucket) return narrow(ctx, d, bucket.dataset.activityBucket);
    const pivot = target('[data-activity-pivot]');
    if (pivot) {
      const name = pivot.dataset.activityPivot,
        value = pivot.dataset.value;
      if (name === 'actor') d.filters.who = value;
      else if (name === 'entity') d.filters.table = value;
      else d.filters[name] = value;
      return apply();
    }
    const chip = target('[data-activity-unfilter]');
    if (chip) {
      const name = chip.dataset.activityUnfilter;
      if (name === 'range') d.range = 'all';
      else if (name === 'type') d.type = '';
      else if (FILTERS.includes(name)) d.filters[name] = '';
      if (!d.filters.who) d.whoName = null;
      if (d.range === 'custom' && !d.filters.from && !d.filters.to) d.range = 'all';
      apply();
      const next = FILTERS.find((filter) => d.filters[filter]) ?? (RANGES[d.range] ? 'range' : d.type ? 'type' : null);
      focus(next ? `activity-chip-${next}` : 'activity-q');
      return true;
    }
    // The list sorts on the runtime: the same column again reverses, another one starts newest/largest first.
    const sort = target('[data-table-sort="activity-list"]');
    if (sort) {
      const by = sort.dataset.sortKey;
      if (!Object.hasOwn(SORTS, by)) return true;
      d.sort = d.sort.by === by ? { by, order: d.sort.order === 'asc' ? 'desc' : 'asc' } : { by, order: 'desc' };
      ctx.pager('activity-list').page = 1;
      syncHash(d);
      reload(ctx);
      ctx.render?.();
      globalThis.document?.querySelector?.(`[data-table-sort="activity-list"][data-sort-key="${by}"]`)?.focus();
      return true;
    }
    const page = target('[data-table-page]');
    if (page) {
      const key = page.dataset.tablePage;
      ctx.pager(key).page += Number(page.dataset.delta);
      if (key === 'activity-list') reload(ctx);
      else ctx.render?.();
      return true;
    }
    const children = target('[data-activity-children]');
    if (children) {
      const spanId = children.dataset.activityChildren;
      return pending(ctx, children, async () => {
        const found = await ctx
          .request(`/trace/spans?${new URLSearchParams({ parentSpanId: spanId, pageSize: '200' })}`)
          .catch(failure);
        d.children = found.error
          ? { spanId, ...found }
          : {
              spanId,
              traceIds: [...new Set(found.items.map((item) => item.traceId))].filter((id) => id !== d.traceId),
            };
        ctx.render?.();
      });
    }
    const sources = target('[data-activity-sources]');
    if (sources) {
      const route = sources.dataset.activitySources;
      d.sourcesFor = d.sourcesFor === route ? null : route;
      if (d.sourcesFor) ctx.reveal?.('#activity-page-sources');
      reload(ctx);
      ctx.render?.();
      return true;
    }
    const span = target('[data-activity-span]');
    if (span) {
      d.spanId = span.dataset.activitySpan === d.spanId ? null : span.dataset.activitySpan;
      syncHash(d);
      // The landing is set before the render, so this render scrolls to and focuses the drawer.
      if (d.spanId) ctx.reveal?.('#activity-span-drawer');
      ctx.render?.();
      if (d.spanId) loadTargets(ctx, d).then((read) => read && ctx.render?.());
      return true;
    }
    const open = target('[data-activity-open]');
    if (open) {
      if (open.dataset.activityOpen !== d.traceId) {
        d.traceId = open.dataset.activityOpen;
        d.spanId = null;
        d.tree = null;
        d.children = null;
        d.copied = null;
        d.spanSearch = '';
        d.errorsOnly = false;
        d.linked = {};
        d.detailLog = d.request = d.sources = null;
      }
      syncHash(d);
      ctx.reveal?.('#activity-detail-title');
      reload(ctx);
      ctx.render?.();
      return true;
    }
    return false;
  },
};

/** What the side column shows: the open activity and the compared pair. */
const sideKey = (d) => `${d.traceId ?? ''}|${d.compare?.join(',') ?? ''}`;
/** Closes the step drawer; focus returns to the step's label. */
function closeSpan(ctx, d) {
  const id = d.spanId;
  d.spanId = null;
  syncHash(d);
  ctx.render?.();
  focus(`activity-span-${id}`);
  return true;
}
/** Closes the open activity; focus returns to its row. */
function closeTrace(ctx, d) {
  const id = d.traceId;
  d.traceId = d.spanId = null;
  d.tree = null;
  d.copied = null;
  syncHash(d);
  ctx.render?.();
  focus(`activity-open-${id}`);
  return true;
}
/** The next index of a roving set for an arrow, Home or End key (wrapping). */
function step(length, index, key) {
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return (index + (key === 'ArrowRight' ? 1 : -1) + length) % length;
}
function selectTab(ctx, d, key, id) {
  if (key === 'activity-tabs') {
    if (!TAB_IDS.includes(id)) return true;
    d.tab = id;
    syncHash(d);
    reload(ctx);
  } else if (key === 'activity-detail') {
    d.detail = DETAIL_TABS.some(([tab]) => tab === id) ? id : 'steps';
    syncHash(d);
    reload(ctx);
  } else if (BREAKDOWNS.some(([name]) => name === id)) d.breakdown = id;
  ctx.render?.();
  focus(`${key}-tab-${id}`);
  return true;
}
function narrow(ctx, d, bucketStart) {
  const start = Date.parse(bucketStart),
    size = Number(d.stats?.bucketMs);
  if (!Number.isFinite(start) || !(size > 0)) return true;
  d.filters.from = new Date(start).toISOString();
  d.filters.to = new Date(start + size - 1).toISOString();
  d.range = 'custom';
  d.traceId = d.spanId = null;
  d.tree = null;
  ctx.forgetDraft?.(FILTER_FORM);
  ctx.pager('activity-list').page = 1;
  syncHash(d);
  reload(ctx);
  return true;
}
