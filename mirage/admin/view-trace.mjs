// `#trace` view module: the runtime's causal traces. DOM-free at module scope; reads GET /__sim/api/trace (summaries,
// sortable), /trace/stats (KPIs from `overall` and `roots`, timeline, breakdowns; a second read over the previous
// equal-length window for the p95 trend), /trace/settings, /trace/<traceId> (the open trace, or the two compared ones)
// /trace/spans?parentSpanId= (child traces) and /trace/span/<id> (the name and kind of a link or parent target outside the
// open trace), and changes PUT /trace/settings (level, persistence, retention limits) and POST /trace/clear through
// ctx.request. Export is a plain link to the streamed GET /trace/export. Live follows the `trace` channel of
// /__sim/events on hosts whose status lists it in `eventChannels`. Every filter is a `#trace?name=value` deep link.
// Each load fetches only the parts a state change needs, and a part's answer is kept only when no newer load of that
// part started (a generation per part), so a slow Live reload never overwrites a newer deep link.
import * as kit from './ui-kit.mjs';
import { HELP } from './help-content.mjs';
import { viewCommon } from './view-common.mjs';

const ID = 'trace';
const LABEL = 'Traces';
const API = '/__sim/api';
const FILTER_FORM = 'trace-filters';
const SETTINGS_FORM = 'trace-settings-form';
const { e, failure, failed, json, fieldHelp, heading, panel, pending } = viewCommon({
  id: ID,
  label: LABEL,
  kit,
  help: HELP,
});

/** The store's query filters this view sets (docs/design/tracing.md, Filters). */
export const FILTERS = Object.freeze([
  'from',
  'to',
  'kind',
  'module',
  'operation',
  'entity',
  'recordId',
  'status',
  'host',
  'actorKind',
  'actorId',
  'sessionKey',
  'visitorId',
  'portal',
  'search',
  'minDurationMs',
  'hasErrors',
]);
const LABELS = {
  from: 'From',
  to: 'To',
  kind: 'Span kind',
  module: 'Module',
  operation: 'Operation',
  entity: 'Table',
  recordId: 'Record id',
  status: 'Span status',
  host: 'Host',
  actorKind: 'Actor kind',
  actorId: 'Actor id',
  sessionKey: 'Session key',
  visitorId: 'Visitor id',
  portal: 'Portal',
  search: 'Search',
  minDurationMs: 'Minimum duration (ms)',
  hasErrors: 'Errors',
};
const RANGES = Object.freeze({ '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '24h': 86_400_000, all: null });
const RANGE_LABELS = { '5m': 'Last 5 minutes', '15m': 'Last 15 minutes', '1h': 'Last hour', '24h': 'Last 24 hours' };
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
/** Every span status (trace-store.mjs SPAN_STATUSES) and what it means: the status filter and the legend. */
const STATUS_MEANINGS = Object.freeze({
  running: 'not ended yet; a trace is running while any of its spans runs',
  ok: 'ended without an error',
  error: 'ended with an exception, a fault or an HTTP error answer',
  denied: 'refused by a permission decision or answered 401 / 403',
  cancelled: 'stopped before it finished, such as a cancelled flow run or action',
});
const STATUSES = Object.keys(STATUS_MEANINGS);
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
const LEVELS = ['off', 'summary', 'full'];
const BREAKDOWNS = [
  ['kind', 'Kind', 'byKind'],
  ['module', 'Module', 'byModule'],
  ['entity', 'Table', 'byEntity'],
  ['operation', 'Operation', 'byOperation'],
  ['actor', 'Actor', 'byActor'],
];
const DETAIL_TABS = [
  ['waterfall', 'Waterfall'],
  ['tree', 'Tree'],
  ['json', 'JSON'],
];
const SORTS = { start: 'Started', duration: 'Duration', spans: 'Spans', errors: 'Errors' };
const EXPORT_FORMATS = [
  ['ndjson', 'NDJSON (one trace per line)'],
  ['json', 'JSON'],
  ['otlp', 'OTLP JSON'],
];
const STATUS_TONES = { ok: 'ok', error: 'bad', denied: 'warn', running: 'info', cancelled: 'neutral' };
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
  ['traces', 'Retained traces', 10, 10_000],
  ['spansPerTrace', 'Spans per trace', 50, 20_000],
  ['payloadBytes', 'Payload bytes', 256, 1_048_576],
]);
// The search text of a span as the trace store builds it (trace-store.mjs searchText, D-R3-15), so Find spans keeps the
// spans the list's Search filter matched: metadata, attributes and events (at most 4 KB), then the captured input and
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
/** Waterfall and tree indent stop here; deeper spans show their depth as a badge. */
const MAX_INDENT = 12;
/** Live reloads at most once per this many milliseconds (trailing). */
export const LIVE_INTERVAL_MS = 1000;
// The parts a load can fetch, and the ones a filter change needs.
const PARTS = Object.freeze(['list', 'stats', 'previous', 'settings', 'tree', 'compare']);
const LIST_PARTS = Object.freeze(['list', 'stats', 'previous']);
// Deep-link names that keep the list state (filters, range, sort) as it is.
const DETAIL_NAMES = ['traceId', 'spanId', 'panel', 'compare', 'spanSearch', 'errorsOnly'];

const blankFilters = () => Object.fromEntries(FILTERS.map((name) => [name, '']));
const defaultSort = () => ({ by: 'start', order: 'desc' });
const stateOf = (ctx) => {
  const d = (ctx.data[ID] ??= {});
  d.filters ??= blankFilters();
  d.range ??= 'all';
  d.tab ??= 'waterfall';
  d.breakdown ??= 'kind';
  d.sort ??= defaultSort();
  d.picked ??= [];
  d.spanSearch ??= '';
  d.exportFormat ??= 'ndjson';
  d.generations ??= {};
  d.queued ??= new Set();
  d.liveParts ??= new Set();
  d.linked ??= {};
  return d;
};
const short = (id) => String(id ?? '').slice(0, 8);
/** A request failure kept as data, with the error code and the filter a 400 InvalidTraceFilter names. */
const failureOf = (error) => {
  const answer = error?.details?.error;
  return {
    ...failure(error),
    ...(typeof answer?.code === 'string' ? { code: answer.code } : {}),
    ...(typeof answer?.parameter === 'string' ? { parameter: answer.parameter } : {}),
  };
};
/** The list or stats answer that refused a filter (400 InvalidTraceFilter), or null. */
const refusedFilter = (d) =>
  [d.list, d.stats].find((part) => part?.error && part.status === 400 && part.code === 'InvalidTraceFilter') ?? null;
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
const pad = (value, width = 2) => String(value).padStart(width, '0');
/** Local wall time `YYYY-MM-DD HH:MM:SS.mmm` of an ISO time; '' for anything else. */
export const localTime = (iso) => {
  const at = new Date(iso ?? NaN);
  if (!iso || Number.isNaN(at.getTime())) return '';
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
  );
};
/** The local UTC offset at `at`, as `UTC+02:00`. */
export const utcOffset = (at = new Date()) => {
  const minutes = -at.getTimezoneOffset();
  return `UTC${minutes < 0 ? '−' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
};
/** A `<time>` in local time; the ISO value stays in `datetime` and the tooltip. */
const when = (iso) => {
  const text = localTime(iso);
  return text ? `<time class="ui-mono" datetime="${e(iso)}" title="${e(iso)}">${e(text)}</time>` : '—';
};
const statusBadge = (status) => kit.badge(status ?? 'unknown', STATUS_TONES[status] ?? 'neutral');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
/** The status of a trace summary with its error and denied span counts. */
const traceStatus = (summary) => `${statusBadge(summary.status)}${errorBadges(summary, '')}`;
const errorBadges = (summary, none = '0') =>
  [
    summary.errorCount ? kit.badge(plural(summary.errorCount, 'error'), 'bad') : '',
    summary.deniedCount ? kit.badge(`${summary.deniedCount} denied`, 'warn') : '',
  ]
    .filter(Boolean)
    .map((badge) => ` ${badge}`)
    .join('') || none;
/** Actor kind and name; a name that only repeats the kind ("anonymous Anonymous") is left out. */
export const actorText = (actor) => {
  if (!actor) return '—';
  const kind = actor.kind ?? 'system';
  const name = actor.name && String(actor.name).toLowerCase() !== kind.toLowerCase() ? actor.name : null;
  return `${kind}${name ? ` ${name}` : actor.id ? ` ${short(actor.id)}` : ''}`;
};
/** A session as `contact a4300000` / `visitor 1f2e3d4c` from its key (`contact:<id>`, `visitor:<id>`) or visitor id. */
export const sessionText = (session) => {
  const key = session?.sessionKey;
  if (key) {
    const at = String(key).indexOf(':');
    return at > 0 ? `${key.slice(0, at)} ${short(key.slice(at + 1))}` : short(key);
  }
  return session?.visitorId ? `visitor ${short(session.visitorId)}` : '—';
};
/** Colour class of a module: one distinct colour per known module, neutral grey for any other. */
const series = (module) => (MODULES.includes(module) ? `ui-series-${MODULES.indexOf(module)}` : 'ui-series-other');
const hrefOf = (params) =>
  `#trace?${new URLSearchParams(Object.entries(params).filter(([, value]) => value !== null && value !== undefined && value !== ''))}`;
const sorted = (nodes) => [...(nodes ?? [])].sort((a, b) => a.sequence - b.sequence);
const focus = (id) => globalThis.document?.getElementById(id)?.focus();

/** The filter query of the current state; a range preset becomes `from` relative to `now`. */
export function filterQuery(d, now = Date.now()) {
  const query = new URLSearchParams(
    Object.entries(d.filters ?? {}).filter(([name, value]) => FILTERS.includes(name) && value),
  );
  if (RANGES[d.range] && !query.has('from')) query.set('from', new Date(now - RANGES[d.range]).toISOString());
  return query;
}
/** The same filters over the equal-length window just before the current one; null without a start time. */
export function previousWindow(d, now = Date.now()) {
  const query = filterQuery(d, now);
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
/** The deep link of the current state: raw filters, range, sort, open trace and span, span search, compared pair. */
export function hashOf(d) {
  const params = new URLSearchParams(Object.entries(d.filters ?? {}).filter(([, value]) => value));
  if (d.range && d.range !== 'all') params.set('range', d.range);
  if (d.sort) sortQuery(d, params);
  if (d.traceId) params.set('traceId', d.traceId);
  if (d.spanId) params.set('spanId', d.spanId);
  if (d.traceId && d.spanSearch) params.set('spanSearch', d.spanSearch);
  if (d.traceId && d.errorsOnly) params.set('errorsOnly', 'true');
  if (d.compare) params.set('compare', d.compare.join(','));
  return `trace${params.size ? `?${params}` : ''}`;
}
const syncHash = (d) => globalThis.history?.replaceState?.(null, '', `#${hashOf(d)}`);
const listKey = (d) => `${new URLSearchParams(Object.entries(d.filters))}|${d.range}|${d.sort.by}|${d.sort.order}`;
/** `[a, b]` of a `compare=<id1>,<id2>` value; null unless it names two different ids. */
const compareOf = (value) => {
  const ids = String(value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.length === 2 && ids[0] !== ids[1] ? ids : null;
};

// ---- Loading: one view loop at a time; parts asked for during a load are fetched once more after it.
async function reload(ctx, parts = PARTS) {
  const d = stateOf(ctx);
  for (const part of parts) d.queued.add(part);
  if (d.reloading) return d.reloading;
  d.reloading = (async () => {
    while (d.queued.size) {
      const next = [...d.queued];
      d.queued.clear();
      await view.load(ctx, next);
      ctx.render?.();
    }
  })().finally(() => {
    d.reloading = null;
  });
  return d.reloading;
}

// ---- Live: the `trace` SSE channel while this view is open and Live is on.
const STREAM = '/__sim/events?channels=trace';
let source = null;
/** true / false when the host publishes its event channels, null when it does not say (then a refusal tells). */
const liveServed = (ctx) => {
  const channels = ctx.eventChannels?.();
  return Array.isArray(channels) ? channels.includes('trace') : null;
};
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
function connect(ctx, d) {
  if (source || typeof globalThis.EventSource !== 'function' || liveServed(ctx) === false) return;
  d.liveStatus = 'Connecting…';
  d.liveRefused = null;
  const stream = (source = new globalThis.EventSource(STREAM));
  stream.addEventListener('open', () => {
    d.liveStatus = 'Streaming';
    ctx.render?.();
  });
  stream.addEventListener('error', () => {
    // An HTTP error answer (404 on a host without the stream) closes the stream for good; a dropped one reconnects.
    if (stream.readyState === globalThis.EventSource.CLOSED) return refused(ctx, d, stream);
    d.liveStatus = 'Reconnecting…';
    ctx.render?.();
  });
  stream.addEventListener('trace', (event) => {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    // An ended trace changes the list and the stats; a span of the open trace changes only its tree.
    if (frame?.type === 'trace-end') schedule(ctx, d, LIST_PARTS);
    else if (frame?.type === 'span-end' && d.traceId && frame.span?.traceId === d.traceId) schedule(ctx, d, ['tree']);
  });
}
function disconnect(d) {
  source?.close();
  source = null;
  if (!d) return;
  d.liveStatus = 'Off';
  clearTimeout(d.liveTimer);
  d.liveTimer = null;
  d.liveParts?.clear();
}
/** Live turns off with a notice. A host that publishes its channels is known to serve the stream; otherwise one plain
 * GET tells a host without the stream (404) from a stream that failed. */
async function refused(ctx, d, stream) {
  if (source !== stream) return;
  disconnect(d);
  d.live = false;
  let status = null;
  if (liveServed(ctx) === null)
    try {
      const response = await fetch(STREAM, { cache: 'no-store', headers: { accept: 'text/event-stream' } });
      status = response.status;
      response.body?.cancel().catch(() => {});
    } catch {
      // Unreachable host: the notice below says the stream closed.
    }
  d.liveRefused =
    status === 404
      ? 'This host does not serve the live trace stream (/_sim/events?channels=trace). Refresh traces to see new ones.'
      : `The live trace stream closed${status && status !== 200 ? ` (HTTP ${status})` : ''}. Select Live to connect again, or refresh traces.`;
  ctx.render?.();
}

// ---- Filters
function select(id, name, label, options, value, ctx, attrs = '', helpKey = 'trace.filters') {
  if (value && !options.some(([option]) => String(value) === option))
    options = [...options, [String(value), `${value} (not a valid value)`]];
  return (
    `<div><label for="${id}">${e(label)}</label><select id="${id}" name="${name}" aria-describedby="${id}-help"${attrs}>` +
    options
      .map(
        ([option, text]) =>
          `<option value="${e(option)}"${String(value) === option ? ' selected' : ''}>${e(text)}</option>`,
      )
      .join('') +
    `</select>${fieldHelp(ctx, id, helpKey, name)}</div>`
  );
}
const anyOf = (label, values) => [['', label], ...values.map((value) => [value, value])];
function input(id, name, value, ctx, type = 'text', extra = '') {
  return (
    `<div><label for="${id}">${e(LABELS[name])}</label><input id="${id}" name="${name}" type="${type}" value="${e(value)}" aria-describedby="${id}-help"${extra}>` +
    `${fieldHelp(ctx, id, 'trace.filters', name)}</div>`
  );
}
/** `datetime-local` value (local wall time, seconds) of an ISO time; empty for anything else. */
const localInput = (iso) => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at - new Date(at).getTimezoneOffset() * 60_000).toISOString().slice(0, 19) : '';
};
function filtersPanel(ctx, d) {
  const f = d.filters;
  const range = select(
    'trace-range',
    'range',
    'Time range',
    [
      ...Object.entries(RANGE_LABELS),
      ['all', 'All retained'],
      ...(d.range === 'custom' ? [['custom', 'Custom (from / to)']] : []),
    ],
    d.range,
    ctx,
    ' data-trace-range',
  );
  return (
    `<form id="${FILTER_FORM}" class="ui-form ui-filter-grid" data-trace-filters>${range}` +
    input('trace-from', 'from', localInput(f.from), ctx, 'datetime-local', ' step="1"') +
    input('trace-to', 'to', localInput(f.to), ctx, 'datetime-local', ' step="1"') +
    select('trace-kind', 'kind', LABELS.kind, anyOf('Any kind', KINDS), f.kind, ctx) +
    select('trace-module', 'module', LABELS.module, anyOf('Any module', MODULES), f.module, ctx) +
    input('trace-operation', 'operation', f.operation, ctx) +
    input('trace-entity', 'entity', f.entity, ctx) +
    input('trace-record', 'recordId', f.recordId, ctx) +
    select('trace-status', 'status', LABELS.status, anyOf('Any status', STATUSES), f.status, ctx) +
    select('trace-host', 'host', LABELS.host, anyOf('Any host', HOSTS), f.host, ctx) +
    select('trace-actor-kind', 'actorKind', LABELS.actorKind, anyOf('Any actor', ACTOR_KINDS), f.actorKind, ctx) +
    input('trace-actor-id', 'actorId', f.actorId, ctx) +
    input('trace-session', 'sessionKey', f.sessionKey, ctx) +
    input('trace-visitor', 'visitorId', f.visitorId, ctx) +
    input('trace-portal', 'portal', f.portal, ctx) +
    input('trace-search', 'search', f.search, ctx, 'search') +
    input('trace-min-duration', 'minDurationMs', f.minDurationMs, ctx, 'number', ' min="0" step="any"') +
    select(
      'trace-has-errors',
      'hasErrors',
      LABELS.hasErrors,
      [
        ['', 'With or without errors'],
        ['true', 'Only with errors'],
        ['false', 'Only without errors'],
      ],
      f.hasErrors,
      ctx,
    ) +
    '<p class="ui-filter-actions"><button type="submit" id="trace-apply" class="ui-button ui-primary ui-small">Apply filters</button> ' +
    '<button type="button" id="trace-reset" class="ui-button ui-small" data-trace-action="reset">Reset filters</button></p></form>'
  );
}
/** The banner of a filter the runtime refused (400 InvalidTraceFilter): which filter, why, and a way to remove it. */
function invalidFilter(d) {
  const refused = refusedFilter(d);
  if (!refused) return '';
  const name = refused.parameter ?? '';
  const known = FILTERS.includes(name);
  const label = known ? `${LABELS[name]} (${name})` : name || 'a';
  return (
    kit.notice(
      `The ${label} filter${known && d.filters[name] ? ` value "${d.filters[name]}"` : ''} is not valid: ${refused.error} No trace is listed until you change or remove it.`,
      'bad',
    ) +
    (known
      ? `<p><button type="button" class="ui-button ui-small" id="trace-unfilter-invalid" data-trace-unfilter="${e(name)}">Remove the ${e(LABELS[name])} filter</button></p>`
      : '')
  );
}
const activeCount = (d) => FILTERS.filter((name) => d.filters[name]).length + (RANGES[d.range] ? 1 : 0);
/** The active filters as removable chips. */
function chips(d) {
  const items = FILTERS.filter((name) => d.filters[name]).map((name) => [
    name,
    `${LABELS[name]}: ${name === 'from' || name === 'to' ? localTime(d.filters[name]) || d.filters[name] : d.filters[name]}`,
  ]);
  if (RANGES[d.range]) items.unshift(['range', RANGE_LABELS[d.range]]);
  if (!items.length) return '';
  return `<div class="ui-chips" role="group" aria-label="Active filters">${items
    .map(
      ([name, text]) =>
        `<button type="button" class="ui-chip" id="trace-chip-${e(name)}" data-trace-unfilter="${e(name)}" aria-label="Remove filter ${e(text)}">${e(text)} <span aria-hidden="true">×</span></button>`,
    )
    .join('')}</div>`;
}

// ---- Overview: KPI tiles, timeline, breakdown
function timeline(d) {
  const buckets = Array.isArray(d.stats?.timeline) ? d.stats.timeline : [];
  if (!buckets.length) return '<p class="ui-help">No span matches, so there is no timeline.</p>';
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
      const label = `${localTime(bucket.bucketStart)}: ${plural(bucket.count, 'span')}, ${plural(bucket.errors, 'error')}${bucket.p95 === null || bucket.p95 === undefined ? '' : `, p95 ${duration(bucket.p95)}`}. Narrow the time range to this bucket.`;
      return (
        `<g class="ui-histogram-bucket" role="button" id="trace-bucket-${index}" tabindex="${index === current ? 0 : -1}" data-trace-bucket="${e(bucket.bucketStart)}" data-bucket-index="${index}" aria-label="${e(label)}"><title>${e(label)}</title>` +
        `<rect class="ui-histogram-hit" x="${(index * step).toFixed(2)}" y="0" width="${step.toFixed(2)}" height="${height}"></rect>` +
        `<rect class="ui-histogram-count" x="${x}" y="${(height - h).toFixed(2)}" width="${w}" height="${h}"></rect>` +
        (bucket.errors
          ? `<rect class="ui-histogram-errors" x="${x}" y="${(height - eh).toFixed(2)}" width="${w}" height="${eh}"></rect>`
          : '') +
        '</g>'
      );
    })
    .join('');
  const offset = utcOffset(new Date(Date.parse(d.stats.from) || Date.now()));
  return (
    `<figure class="ui-histogram"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="group" aria-label="Spans per ${e(duration(d.stats.bucketMs))} bucket; arrow keys move between buckets">${bars}</svg>` +
    `<figcaption class="ui-histogram-axis"><span>${when(d.stats.from)}</span><span>${e(buckets.length)} buckets of ${e(duration(d.stats.bucketMs))} · errors in red · local time (${e(offset)})</span><span>${when(d.stats.to)}</span></figcaption></figure>`
  );
}
function breakdown(ctx, d) {
  const [key, label, member] = BREAKDOWNS.find(([id]) => id === d.breakdown) ?? BREAKDOWNS[0];
  const rows = Object.entries(d.stats?.[member] ?? {})
    .map(([name, item]) => ({ name, ...item }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const table = kit.table({
    key: 'trace-breakdown',
    caption: `Spans by ${label.toLowerCase()}`,
    items: rows,
    emptyText: 'No span matches.',
    columns: [
      { label, render: (item) => `<code>${e(item.name)}</code>` },
      { label: 'Spans', render: (item) => e(item.count) },
      { label: 'Errors', render: (item) => (item.errors ? kit.badge(item.errors, 'bad') : '0') },
      { label: 'p50', render: (item) => e(item.p50 === null ? '—' : duration(item.p50)) },
      { label: 'p95', render: (item) => e(item.p95 === null ? '—' : duration(item.p95)) },
      { label: 'Max', render: (item) => e(item.max === null ? '—' : duration(item.max)) },
      {
        label: 'Filter',
        render: (item) =>
          `<button type="button" class="ui-button ui-small" data-trace-pivot="${e(key)}" data-value="${e(item.name)}" aria-label="Only ${e(label.toLowerCase())} ${e(item.name)}">Filter</button>`,
      },
    ],
  });
  return kit.tabs({
    key: 'trace-breakdown',
    label: 'Break spans down by',
    items: BREAKDOWNS.map(([id, text]) => ({ id, label: text })),
    selected: key,
    panelHtml: table,
  });
}
/** Root p95 of the current window against the equal-length window before it. */
function trendTile(d) {
  const tile = { label: 'Root p95 vs before', value: '—' };
  if (!d.previous) return { ...tile, detail: 'choose a time range to compare' };
  if (d.previous.error) return { ...tile, detail: `the previous window could not be read: ${failed(d.previous)}` };
  const now = d.stats?.roots?.p95,
    before = d.previous.roots?.p95;
  const span = d.previousLength ? ` ${duration(d.previousLength)}` : '';
  if (before === null || before === undefined) return { ...tile, detail: `no ended root span in the previous${span}` };
  if (now === null || now === undefined) return { ...tile, detail: `${duration(before)} in the previous${span}` };
  const change = before > 0 ? ((now - before) / before) * 100 : null;
  return {
    ...tile,
    value: change === null ? '—' : `${change > 0 ? '+' : change < 0 ? '−' : '±'}${Math.abs(change).toFixed(0)}%`,
    tone: change > 10 ? 'warn' : change < -10 ? 'ok' : 'neutral',
    detail: `${duration(now)} now · ${duration(before)} in the previous${span}`,
  };
}
/** One line per span reference of /trace/stats (slowest, errors): a link to the span, its duration and error. */
function spanReferences(items, emptyText) {
  if (!items.length) return `<p class="ui-help">${e(emptyText)}</p>`;
  return `<ol class="ui-span-refs">${items
    .map(
      (item) =>
        `<li><a href="${e(hrefOf({ traceId: item.traceId, spanId: item.spanId }))}">${kit.badge(item.kind ?? '—', 'neutral')} <span class="ui-span-ref-name">${e(item.name)}</span></a>` +
        ` <span class="ui-help">${e(duration(item.durationMs))}${item.entity ? ` · ${e(item.entity)}` : ''} · ${when(item.startedAt)}</span>` +
        (item.error ? `<span class="ui-span-ref-error">${e(errorText(item.error))}</span>` : '') +
        '</li>',
    )
    .join('')}</ol>`;
}
const errorText = (error) =>
  [error?.code, error?.message].filter((part) => part !== null && part !== undefined && part !== '').join(': ') ||
  'no error message';
function overviewPanel(ctx, d) {
  if (refusedFilter(d)) return '<p class="ui-help">No statistics while a filter is not valid.</p>';
  if (d.stats?.error) return kit.notice(`Trace statistics could not be read: ${failed(d.stats)}`, 'warn');
  const stats = d.stats ?? {},
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
      {
        label: 'Traces',
        value: Array.isArray(d.list?.items) ? d.list.total : '—',
        detail: `${d.list?.retained ?? 0} retained`,
      },
      { label: 'Spans', value: overall.count ?? 0, detail: `p50 / p95 ${percentiles(overall)}` },
      { label: 'Errors', value: errors, tone: errors ? 'bad' : 'neutral' },
      { label: 'Denied', value: denied, tone: denied ? 'warn' : 'neutral' },
      {
        label: 'Root p50 / p95',
        value: percentiles(roots),
        detail: roots?.max === null || roots?.max === undefined ? '—' : `max ${duration(roots.max)}`,
      },
      trendTile(d),
      { label: 'Plug-in steps run', value: kinds['plugin-step']?.count ?? 0 },
      { label: 'Flows run', value: kinds['flow-run']?.count ?? 0 },
      { label: 'Connector calls', value: kinds.connector?.count ?? 0 },
    ]) +
    `<div class="ui-span-spotlight"><section aria-labelledby="trace-slowest-title"><h3 id="trace-slowest-title">Slowest spans</h3>${spanReferences((stats.slowest ?? []).slice(0, 5), 'No span has ended.')}</section>` +
    `<section aria-labelledby="trace-errors-title"><h3 id="trace-errors-title">Latest errors</h3>${spanReferences((stats.errors ?? []).slice(0, 5), 'No span ended in error.')}</section></div>` +
    `<h3>Timeline</h3>${timeline(d)}<h3>Breakdown</h3>${breakdown(ctx, d)}`
  );
}

// ---- Trace list
function sortColumn(d, by, column) {
  const active = d.sort.by === by;
  return {
    ...column,
    label: SORTS[by],
    sort: active ? (d.sort.order === 'asc' ? 'ascending' : 'descending') : 'none',
    head: `<button type="button" class="ui-sort" id="trace-sort-${by}" data-trace-sort="${by}">${e(SORTS[by])}${active ? `<span aria-hidden="true">${d.sort.order === 'asc' ? ' ▲' : ' ▼'}</span>` : ''}</button>`,
  };
}
/** Every span status with its meaning. */
const statusLegend = () =>
  `<ul class="ui-status-legend" aria-label="Span statuses">${STATUSES.map((status) => `<li>${statusBadge(status)} ${e(STATUS_MEANINGS[status])}</li>`).join('')}</ul>`;
function listPanel(ctx, d) {
  if (refusedFilter(d))
    return '<p class="ui-help">No trace is listed while a filter is not valid.</p>' + statusLegend();
  if (!d.list || d.list.error)
    return kit.notice(
      d.list?.error ? `Traces could not be read: ${failed(d.list)}` : 'This host did not report traces.',
      'warn',
    );
  const list = d.list;
  const kindText = (kinds) =>
    Object.entries(kinds ?? {})
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind} ${count}`);
  const caption =
    d.sort.by === 'start' && d.sort.order === 'desc'
      ? 'Traces, newest first'
      : `Traces by ${SORTS[d.sort.by].toLowerCase()}, ${d.sort.order === 'asc' ? 'ascending' : 'descending'}`;
  const pickTools =
    `<p class="ui-toolbar"><button type="button" class="ui-button ui-small" id="trace-compare" data-trace-action="compare"${d.picked.length === 2 ? '' : ' disabled'}>Compare ${d.picked.length === 2 ? 'the 2 ticked traces' : 'ticked traces'}</button>` +
    `${fieldHelp(ctx, 'trace-pick', 'trace.list', 'pick')}</p>`;
  return (
    pickTools +
    kit.table({
      key: 'trace-list',
      caption,
      searchable: false,
      result: {
        items: list.items,
        total: list.total,
        pages: list.pageCount,
        page: list.page,
        size: list.pageSize,
        search: '',
      },
      emptyText: 'No trace matches. Traces appear as this runtime answers requests and runs jobs.',
      rowAttrs: (item) => ({
        'data-trace-open': item.traceId,
        class: item.traceId === d.traceId ? 'is-selected' : undefined,
      }),
      columns: [
        sortColumn(d, 'start', { render: (item) => when(item.startedAt) }),
        { label: 'Status', render: (item) => statusBadge(item.status) },
        sortColumn(d, 'duration', {
          render: (item) =>
            `${e(duration(item.durationMs))}${item.totalDurationMs !== item.durationMs ? `<span class="ui-help ui-trace-origin">total ${e(duration(item.totalDurationMs))}</span>` : ''}`,
        }),
        {
          label: 'Root',
          render: (item) => {
            const name = item.root?.name ?? item.traceId;
            const origin = [
              item.root?.origin?.host ?? '—',
              actorText(item.root?.actor),
              sessionText(item.root?.session),
            ];
            return (
              `<button type="button" class="ui-link-button ui-trace-root" id="trace-open-${e(item.traceId)}" data-trace-open="${e(item.traceId)}" title="${e(name)}" aria-label="Open trace ${e(name)}">${kit.badge(item.root?.kind ?? '—', 'info')} <span class="ui-trace-name">${e(name)}</span></button>` +
              `<span class="ui-help ui-trace-origin" title="${e(item.root?.session?.sessionKey ?? '')}">${e(origin.join(' · '))}</span>`
            );
          },
        },
        sortColumn(d, 'spans', {
          className: 'ui-trace-extra',
          render: (item) => {
            const kinds = kindText(item.kinds);
            return (
              `<span title="${e(kinds.join(', '))}">${e(item.spanCount ?? 0)}</span>` +
              `${item.droppedSpans ? ` ${kit.badge(`+${item.droppedSpans} refused`, 'warn')}` : ''}` +
              `<span class="ui-help ui-trace-kinds" title="${e(kinds.join(', '))}">${e(kinds.slice(0, 3).join(' · '))}${kinds.length > 3 ? ` +${kinds.length - 3}` : ''}</span>`
            );
          },
        }),
        sortColumn(d, 'errors', {
          render: (item) =>
            errorBadges(item) +
            (item.firstError
              ? `<span class="ui-help ui-trace-error" title="${e(errorText(item.firstError))}">${e(`${item.firstError.name ? `${item.firstError.name}: ` : ''}${errorText(item.firstError)}`)}</span>`
              : ''),
        }),
        {
          label: 'Tables',
          className: 'ui-trace-extra',
          render: (item) =>
            e(
              (item.entities ?? []).slice(0, 3).join(', ') +
                ((item.entities ?? []).length > 3 ? ` +${item.entities.length - 3}` : '') || '—',
            ),
        },
        {
          label: 'Compare',
          render: (item) =>
            `<input type="checkbox" id="trace-pick-${e(item.traceId)}" data-trace-pick="${e(item.traceId)}"${d.picked.includes(item.traceId) ? ' checked' : ''} aria-label="Compare trace ${e(item.root?.name ?? item.traceId)}" aria-describedby="trace-pick-help">`,
        },
      ],
    }) +
    statusLegend()
  );
}

// ---- Trace detail: facts, waterfall, tree, JSON, span drawer
/** Depth-first span order of a tree (children in sequence order). */
const walk = (nodes, out = []) => {
  for (const node of sorted(nodes)) {
    out.push(node);
    walk(node.children, out);
  }
  return out;
};
/** The spans the span search and errors-only toggle keep: matches plus their ancestors; null when neither is set. */
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
        `<li class="ui-waterfall-row ui-depth-${Math.min(span.depth ?? 0, MAX_INDENT)}${selected ? ' is-selected' : ''}${context ? ' is-context' : ''}">` +
        `<button type="button" class="ui-waterfall-label" id="trace-span-${e(span.spanId)}" data-trace-span="${e(span.spanId)}" aria-pressed="${selected}" aria-label="Span ${e(span.name)}, ${e(span.kind)}, ${e(duration(span.durationMs))}, ${e(span.status)}">` +
        `${kit.badge(span.kind, 'neutral')} <span class="ui-waterfall-name" title="${e(span.name)}">${e(span.name)}</span>${span.entity ? ` <code>${e(span.entity)}</code>` : ''}${depthBadge(span.depth ?? 0)}${span.async ? ` ${kit.badge('async', 'info')}` : ''}</button>` +
        kit.bar({
          offset,
          width,
          className: classes,
          marks,
          label: `starts at ${duration(starts.get(span.spanId) - origin)}, lasts ${duration(span.durationMs)}`,
        }) +
        `<span class="ui-waterfall-duration">${e(duration(span.durationMs))} ${span.status === 'ok' ? '' : statusBadge(span.status)}</span></li>`
      );
    })
    .join('');
  const legend = modules
    .map(
      (module) =>
        `<li><svg class="ui-swatch" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><rect class="${series(module)}" width="10" height="10" rx="2"></rect></svg>${e(module)}</li>`,
    )
    .join('');
  return (
    `<div class="ui-waterfall-scale"><span>0 ms</span><span>${e(duration(total))}</span></div>` +
    (rows
      ? `<ol class="ui-waterfall" aria-label="Spans in start order">${rows}</ol>`
      : '<p class="ui-help">No span matches the search.</p>') +
    `<ul class="ui-waterfall-legend" aria-label="Colour by module">${legend}<li>${kit.badge('async', 'info')} starts a job segment</li><li>ticks: events</li></ul>`
  );
}
function treeNode(node, d, filter) {
  const selected = node.spanId === d.spanId;
  const depth = node.depth ?? 0;
  const events = node.events?.length ?? 0;
  const head =
    `<span class="ui-tree-head">${kit.badge(node.kind, 'neutral')} <button type="button" class="ui-tree-span" id="trace-span-${e(node.spanId)}" data-trace-span="${e(node.spanId)}" aria-pressed="${selected}" title="${e(node.name)}">${e(node.name)}</button>` +
    `${node.entity ? ` <code>${e(node.entity)}</code>` : ''}${depthBadge(depth)} <span class="ui-tree-facts">${e(duration(node.durationMs))} · ${statusBadge(node.status)}${events ? ` · ${e(plural(events, 'event'))}` : ''}${node.async ? ` · ${kit.badge('async', 'info')}` : ''}</span></span>`;
  const children = sorted(node.children).filter((child) => !filter || filter.shown.has(child.spanId));
  const classes = [selected ? 'is-selected' : '', filter && !filter.matched.has(node.spanId) ? 'is-context' : '']
    .filter(Boolean)
    .join(' ');
  return children.length
    ? `<li${classes ? ` class="${classes}"` : ''}><details open data-ui-section="trace:node:${e(node.spanId)}"><summary>${head}</summary><ul role="group"${depth >= MAX_INDENT ? ' class="is-flat"' : ''}>${children.map((child) => treeNode(child, d, filter)).join('')}</ul></details></li>`
    : `<li class="ui-tree-leaf${classes ? ` ${classes}` : ''}">${head}</li>`;
}
/** A captured payload, or why the span has none: its own capture level (recorded when it started), a sealed flow run,
 * or an operation that passed nothing. */
function payload(title, value, span) {
  if (value !== undefined)
    return `<details class="ui-payload"><summary>${e(title)}</summary><pre class="ui-example">${e(JSON.stringify(value, null, 2))}</pre></details>`;
  const what = title.toLowerCase();
  const reason =
    span.level === 'summary'
      ? `not captured: this span was recorded at level summary, which keeps attributes and events only. Choose full under Settings and run the request again to capture the ${what}.`
      : span.level === 'full'
        ? span.attributes?.secure
          ? 'not captured: this span belongs to a sealed flow run (a Secret parameter or secure inputs or outputs), so no payload of the run is recorded.'
          : `none: this span was recorded at level full and its operation passed no ${what} to the trace.`
        : 'not captured: this span does not say at which level it was recorded.';
  return `<p class="ui-help">${e(title)}: ${e(reason)}</p>`;
}
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
  span ? `${kit.badge(span.kind ?? '—', 'neutral')} ${e(span.name)}` : `span <code>${e(short(spanId))}</code>`;
const spanHref = (span) => hrefOf({ traceId: span.traceId, spanId: span.spanId });
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
/**
 * Reads the spans the open span's parent and links name outside the open trace, so the drawer shows their kind and name.
 * Resolves true when it read any.
 */
async function loadTargets(ctx, d) {
  const span = d.tree?.spans ? byIdOf(d.tree).get(d.spanId) : null;
  if (!span) return false;
  const byId = byIdOf(d.tree);
  const ids = [...new Set([span.parentSpanId, ...(span.links ?? []).map((link) => link.spanId)])].filter(
    (id) => id && !byId.has(id) && !Object.hasOwn(d.linked, id),
  );
  if (!ids.length) return false;
  for (const id of ids) d.linked[id] = null;
  const found = await Promise.all(
    ids.map((id) => ctx.request(`/trace/span/${encodeURIComponent(id)}`).catch(failureOf)),
  );
  ids.forEach((id, index) => (d.linked[id] = found[index]));
  return true;
}
function drawer(ctx, d, tree) {
  const span = byIdOf(tree).get(d.spanId);
  if (!span) return d.spanId ? kit.notice(`Span ${d.spanId} is not part of this trace.`, 'warn') : '';
  const attributes = Object.entries(span.attributes ?? {});
  const request = parentRequest(tree, span);
  const chain = ancestry(tree, span);
  const parent = span.parentSpanId ? targetOf(d, tree, span.parentSpanId) : null;
  const pivots = [
    span.session?.sessionKey && ['Same session', hrefOf({ sessionKey: span.session.sessionKey })],
    span.actor?.kind && ['Same actor', hrefOf({ actorKind: span.actor.kind, actorId: span.actor.id })],
    span.entity && ['Same table', hrefOf({ entity: span.entity })],
    span.recordId && ['Same record', hrefOf({ entity: span.entity, recordId: span.recordId })],
    request && ['Parent request', hrefOf({ traceId: tree.trace.traceId, spanId: request.spanId })],
  ].filter(Boolean);
  const children =
    d.children?.spanId === span.spanId
      ? d.children.error
        ? kit.notice(`Child traces could not be read: ${failed(d.children)}`, 'warn')
        : d.children.traceIds.length
          ? `<ul>${d.children.traceIds.map((id) => `<li><a href="${e(hrefOf({ traceId: id }))}">Trace <code>${e(short(id))}</code></a></li>`).join('')}</ul>`
          : '<p class="ui-help">No other trace has a span under this one.</p>'
      : '';
  const events = kit.table({
    key: 'trace-events',
    caption: `Events of ${span.name}`,
    items: span.events ?? [],
    emptyText: 'This span recorded no event.',
    columns: [
      { label: 'Offset', render: (item) => e(duration(item.offsetMs)) },
      {
        label: 'Type',
        render: (item) => kit.badge(item.type, item.attributes?.result === 'deny' ? 'warn' : 'neutral'),
      },
      { label: 'Message', render: (item) => e(item.message ?? '') },
      {
        label: 'Attributes',
        render: (item) => (item.attributes ? `<code>${json(item.attributes, 240)}` + '</code>' : ''),
      },
    ],
  });
  // One click up: the parent and the root, named; the path from the root lists every ancestor.
  const climb = [
    span.parentSpanId &&
      `<a class="ui-button ui-small" id="trace-span-parent" href="${e(hrefOf({ traceId: parent?.traceId ?? span.traceId, spanId: span.parentSpanId }))}" aria-label="Parent span: ${e(parent ? `${parent.kind} ${parent.name}` : short(span.parentSpanId))}">Parent</a>`,
    chain.length > 2 &&
      `<a class="ui-button ui-small" id="trace-span-root" href="${e(spanHref(chain[0]))}" aria-label="Root span: ${e(`${chain[0].kind} ${chain[0].name}`)}">Root</a>`,
  ]
    .filter(Boolean)
    .join('');
  const path = `<nav class="ui-crumbs" aria-label="Span path"><ol>${chain
    .map((item) =>
      item === span
        ? `<li aria-current="location">${spanLabel(item)}</li>`
        : `<li><a href="${e(spanHref(item))}">${spanLabel(item)}</a></li>`,
    )
    .join('')}</ol></nav>`;
  const links = (span.links ?? []).map((link) => {
    const target = link.spanId ? targetOf(d, tree, link.spanId) : null;
    const gone = link.spanId && d.linked[link.spanId]?.status === 404 ? ' (no longer retained)' : '';
    return `<li>${e(link.relation)}: <a href="${e(hrefOf({ traceId: link.traceId, spanId: link.spanId }))}">${link.spanId ? spanLabel(target, link.spanId) : 'the trace'}</a> in trace <code>${e(short(link.traceId))}</code>${e(gone)}</li>`;
  });
  return (
    `<section class="ui-drawer" id="trace-span-drawer" tabindex="-1" aria-labelledby="trace-span-title"><div class="ui-drawer-head"><h3 id="trace-span-title">${e(span.name)}</h3>` +
    `${statusBadge(span.status)}${climb}<button type="button" class="ui-button ui-small" data-trace-copy="span">Copy span id</button><button type="button" class="ui-button ui-small" id="trace-close-span" data-trace-action="close-span" aria-keyshortcuts="Escape">Close span</button></div>` +
    path +
    kit.kv([
      ['Span', `<code>${e(span.spanId)}</code>`],
      [
        'Parent',
        span.parentSpanId
          ? `<a href="${e(hrefOf({ traceId: parent?.traceId ?? span.traceId, spanId: span.parentSpanId }))}">${spanLabel(parent, span.parentSpanId)}</a>`
          : 'none (root)',
      ],
      ['Kind / module', `${e(span.kind)} · ${e(span.module ?? '—')}`],
      ['Operation', e(span.operation ?? '—')],
      ['Table / record', `${e(span.entity ?? '—')}${span.recordId ? ` · <code>${e(span.recordId)}</code>` : ''}`],
      ['Started', when(span.startedAt)],
      ['Duration', e(duration(span.durationMs))],
      ['Depth', `${e(span.depth)}${span.async ? ` ${kit.badge('async segment', 'info')}` : ''}`],
      ['Actor', e(`${actorText(span.actor)}${span.actor?.roles?.length ? ` (${span.actor.roles.join(', ')})` : ''}`)],
      ['Session', `<code>${e(span.session?.sessionKey ?? '—')}</code>`],
      ['Origin', e([span.origin?.host, span.origin?.portal, span.origin?.preset].filter(Boolean).join(' · ') || '—')],
      ['Captured at', e(span.level ? `level ${span.level}` : '—')],
    ]) +
    (span.error ? kit.notice(errorText(span.error), span.status === 'denied' ? 'warn' : 'bad') : '') +
    `<h4>Attributes</h4>${attributes.length ? kit.kv(attributes.map(([name, value]) => [name, attributeValue(name, value), { mono: true }])) : '<p class="ui-help">No attribute.</p>'}` +
    `<h4>Events</h4>${events}` +
    `<h4>Payloads</h4>${payload('Input', span.input, span)}${payload('Output', span.output, span)}` +
    (links.length ? `<h4>Links</h4><ul>${links.join('')}</ul>` : '') +
    `<h4>Related</h4><p class="ui-drawer-actions">${pivots.map(([text, href]) => `<a class="ui-button ui-small" href="${e(href)}">${e(text)}</a>`).join(' ')} ` +
    `<button type="button" class="ui-button ui-small" data-trace-children="${e(span.spanId)}">Child traces</button></p>${children}</section>`
  );
}
const exportHref = (params) => `${API}/trace/export?${new URLSearchParams(params)}`;
function copyFallback(ctx, d) {
  if (!d.copied) return '';
  return (
    `<div class="ui-copy-fallback"><label for="trace-copy-fallback">${e(d.copied.label)}</label>` +
    `<textarea id="trace-copy-fallback" readonly rows="2" aria-describedby="trace-copy-fallback-help">${e(d.copied.text)}</textarea>` +
    `${fieldHelp(ctx, 'trace-copy-fallback', 'trace.detail', 'copyFallback')} <button type="button" class="ui-button ui-small" data-trace-action="copy-done">Done</button></div>`
  );
}
function spanTools(ctx, d, tree, filter) {
  const total = tree.spans?.length ?? 0;
  return (
    `<div class="ui-span-tools"><div><label for="trace-span-search">Find spans</label><input type="search" id="trace-span-search" data-trace-span-search value="${e(d.spanSearch)}" aria-describedby="trace-span-search-help">` +
    `${fieldHelp(ctx, 'trace-span-search', 'trace.detail', 'spanSearch')}</div>` +
    `<div><div class="ui-check"><input type="checkbox" id="trace-errors-only" data-trace-errors-only${d.errorsOnly ? ' checked' : ''} aria-describedby="trace-errors-only-help"><label for="trace-errors-only">Only errors and denials</label></div>` +
    `${fieldHelp(ctx, 'trace-errors-only', 'trace.detail', 'errorsOnly')}</div>` +
    `<p class="ui-help" role="status">${filter ? `${e(filter.matched.size)} of ${e(plural(total, 'span'))} match` : `${e(plural(total, 'span'))}`}</p></div>`
  );
}
function detailPanel(ctx, d) {
  const tree = d.tree;
  const title = (id) => `<h3 id="trace-detail-title" tabindex="-1">Trace <code>${e(short(id))}</code></h3>`;
  if (!tree) return `${title(d.traceId)}<p role="status" class="ui-help">Loading trace ${e(d.traceId)}…</p>`;
  if (tree.error)
    return (
      title(d.traceId) +
      kit.notice(
        tree.status === 404
          ? `No retained trace has the id ${d.traceId} (it never existed or was dropped as the oldest beyond the limit).`
          : `Trace ${d.traceId} could not be read: ${failed(tree)}`,
        'warn',
      ) +
      '<p><button type="button" class="ui-button ui-small" data-trace-action="close-trace">Close trace</button></p>'
    );
  const summary = tree.trace ?? {},
    root = tree.root ?? {};
  const statusCode = root.attributes?.statusCode;
  const facts = kit.kv([
    ['Trace', `<code>${e(summary.traceId)}</code>`],
    ['Root', `${kit.badge(root.kind ?? '—', 'info')} ${e(root.name ?? '—')}`],
    ['Status', `${traceStatus(summary)}${statusCode ? ` · HTTP ${e(statusCode)}` : ''}`],
    ['Started', when(summary.startedAt)],
    ['Duration', `${e(duration(summary.durationMs))} root · ${e(duration(summary.totalDurationMs))} total`],
    [
      'Spans',
      `${e(summary.spanCount)}${summary.droppedSpans ? ` · ${e(summary.droppedSpans)} refused beyond the per-trace limit` : ''}`,
    ],
    ['Actor', e(actorText(root.actor))],
    ['Session', `<code>${e(root.session?.sessionKey ?? '—')}</code>`],
    ['Origin', e([root.origin?.host, root.origin?.portal, root.origin?.preset].filter(Boolean).join(' · ') || '—')],
    ['Tables', e((summary.entities ?? []).join(', ') || '—')],
  ]);
  const tab = DETAIL_TABS.some(([id]) => id === d.tab) ? d.tab : 'waterfall';
  const filter = tab === 'json' ? null : spanFilter(tree, d);
  const body =
    tab === 'json'
      ? `<p class="ui-drawer-actions"><a class="ui-button ui-small" href="${e(exportHref({ traceId: summary.traceId, format: 'json' }))}" download>Download trace</a> ` +
        `<button type="button" class="ui-button ui-small" data-trace-copy="json">Copy JSON</button></p>` +
        `<pre class="ui-example ui-json" tabindex="0" aria-label="Trace ${e(short(summary.traceId))} as JSON">${e(JSON.stringify(tree, null, 2))}</pre>`
      : spanTools(ctx, d, tree, filter) +
        (tab === 'tree'
          ? `<ul class="ui-tree" aria-label="Span tree">${sorted(tree.children)
              .filter((node) => !filter || filter.shown.has(node.spanId))
              .map((node) => treeNode(node, d, filter))
              .join(
                '',
              )}</ul>${filter && !filter.shown.size ? '<p class="ui-help">No span matches the search.</p>' : ''}`
          : waterfall(d, tree, filter));
  const help = HELP[`trace.${tab}`] ?? {};
  return (
    `<div class="ui-drawer-head">${title(d.traceId)}` +
    '<button type="button" class="ui-button ui-small" data-trace-copy="id">Copy id</button>' +
    '<button type="button" class="ui-button ui-small" data-trace-copy="link">Copy link</button>' +
    '<button type="button" class="ui-button ui-small" data-trace-action="close-trace">Close trace</button></div>' +
    copyFallback(ctx, d) +
    facts +
    kit.tabs({
      key: 'trace-detail',
      label: 'Trace layout',
      items: DETAIL_TABS.map(([id, label]) => ({ id, label })),
      selected: tab,
      panelHtml:
        kit.leadHelp({
          id: `help-trace-${tab}`,
          label: { waterfall: 'the waterfall', tree: 'the span tree', json: 'the trace JSON' }[tab],
          text: help.intro,
          doc: help.doc ? kit.docLink(help.doc, ctx.docs?.() ?? {}) : undefined,
        }) + body,
    }) +
    drawer(ctx, d, tree)
  );
}

// ---- Compare two traces
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
/** Matched span pairs (with the duration delta of B against A) and the spans only one side has. */
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
    `<li${children ? '' : ' class="ui-tree-leaf"'}><span class="ui-tree-head">${kit.badge(node.kind, 'neutral')} <span class="ui-tree-name" title="${e(node.name)}">${e(node.name)}</span>${depthBadge(depth)} ` +
    `<span class="ui-tree-facts">${e(duration(node.durationMs))}${mark ? ` ${mark}` : ''}</span></span>` +
    (children ? `<ul role="group"${depth >= MAX_INDENT ? ' class="is-flat"' : ''}>${children}</ul>` : '') +
    '</li>'
  );
}
function comparePanel(ctx, d) {
  const [idA, idB] = d.compare;
  const closer =
    '<p><button type="button" class="ui-button ui-small" id="trace-close-compare" data-trace-action="close-compare">Close comparison</button></p>';
  const a = d.compared?.[idA],
    b = d.compared?.[idB];
  if (!a || !b) return `<p role="status" class="ui-help">Loading traces ${e(short(idA))} and ${e(short(idB))}…</p>`;
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
              ? `No retained trace has the id ${id} (it never existed or was dropped as the oldest beyond the limit).`
              : `Trace ${id} could not be read: ${failed(tree)}`,
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
      'Traces',
      `A <a href="${e(hrefOf({ traceId: idA }))}"><code>${e(short(idA))}</code></a> ${e(a.root?.name ?? '')} · B <a href="${e(hrefOf({ traceId: idB }))}"><code>${e(short(idB))}</code></a> ${e(b.root?.name ?? '')}`,
    ],
    [
      'Root duration',
      `${e(duration(a.trace?.durationMs))} → ${e(duration(b.trace?.durationMs))}${rootDelta === null ? '' : ` (${e(signed(rootDelta))})`}`,
    ],
    ['Spans', `${e(a.trace?.spanCount ?? a.spans?.length ?? 0)} → ${e(b.trace?.spanCount ?? b.spans?.length ?? 0)}`],
    ['Matching spans', e(result.matched.length)],
    ['Only in B (added)', names(result.added)],
    ['Only in A (missing from B)', names(result.missing)],
  ]);
  const changes = kit.table({
    key: 'trace-compare',
    caption: 'Matching spans, largest duration change first',
    items: result.matched
      .filter((item) => item.delta !== null)
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
      .slice(0, 20),
    emptyText: 'No matching span has ended in both traces.',
    columns: [
      { label: 'Span', render: (item) => `${kit.badge(item.b.kind, 'neutral')} ${e(item.b.name)}` },
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
      `<section aria-labelledby="trace-compare-${which}"><h4 id="trace-compare-${which}">${which.toUpperCase()} · <code>${e(short(id))}</code></h4>` +
      `<ul class="ui-tree" aria-label="Span tree of trace ${which.toUpperCase()}">${sorted(tree.children)
        .map((node) => compareNode(node, '', which === 'a' ? result.right : result.left, which, seen))
        .join('')}</ul></section>`
    );
  };
  return facts + changes + `<div class="ui-compare">${side(a, idA, 'a')}${side(b, idB, 'b')}</div>` + closer;
}

// ---- Settings
const LEVEL_NOTES = {
  off: 'Nothing is recorded. Each hook reads one setting and returns; no span is kept.',
  summary: 'Every span with names, timing, status, attributes and events. No request or response payload is captured.',
  full: 'Summary plus redacted inputs and outputs (bodies, queries, plug-in targets, flow actions). Each payload costs a deep copy and one JSON serialisation.',
};
function settingsPanel(ctx, d) {
  if (!d.settings || d.settings.error)
    return kit.notice(
      d.settings?.error
        ? `Trace settings could not be read: ${failed(d.settings)}`
        : 'This host did not report trace settings.',
      'warn',
    );
  const settings = d.settings.settings ?? {},
    status = d.settings.status ?? {},
    persist = status.persist ?? {};
  const levels = LEVELS.map(
    (level) =>
      `<div class="ui-check"><input type="radio" id="trace-level-${level}" name="level" value="${level}"${settings.level === level ? ' checked' : ''} aria-describedby="trace-level-${level}-help">` +
      `<label for="trace-level-${level}">${e(level)}</label></div>${kit.fieldHelp(`trace-level-${level}`, LEVEL_NOTES[level])}`,
  ).join('');
  return (
    `<form id="${SETTINGS_FORM}" class="ui-form" data-trace-settings><fieldset><legend>Level</legend>${levels}</fieldset>` +
    `<div class="ui-check"><input type="checkbox" id="trace-persist" name="persist"${settings.persist ? ' checked' : ''} aria-describedby="trace-persist-help"><label for="trace-persist">Persist ended traces</label></div>` +
    `${fieldHelp(ctx, 'trace-persist', 'trace.settings', 'persist')}` +
    `<fieldset class="ui-limits"><legend>Retention limits</legend>${LIMITS.map(
      ([name, label, min, max]) =>
        `<div><label for="trace-limit-${name}">${e(label)}</label><input id="trace-limit-${name}" name="${name}" type="number" min="${min}" max="${max}" step="1" required value="${e(settings[name] ?? '')}" aria-describedby="trace-limit-${name}-help">` +
        `${fieldHelp(ctx, `trace-limit-${name}`, 'trace.settings', name)}</div>`,
    ).join('')}</fieldset>` +
    '<p><button type="submit" class="ui-button ui-primary ui-small">Save trace settings</button></p></form>' +
    '<h3>Store</h3>' +
    kit.kv([
      ['Traces kept', e(status.retained ?? 0)],
      ['Spans kept', `${e(status.spans ?? 0)} · ${e(status.running ?? 0)} running`],
      ['Dropped', `${e(status.dropped ?? 0)} traces · ${e(status.droppedSpans ?? 0)} spans`],
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
    const field = globalThis.document?.getElementById('trace-copy-fallback');
    field?.focus();
    field?.select?.();
  }
}
function copyAction(ctx, d, what) {
  const tree = d.tree;
  if (what === 'link') {
    const where = globalThis.location;
    return copy(ctx, d, 'Link', `${where?.origin ?? ''}${where?.pathname ?? '/_sim/'}#${hashOf(d)}`);
  }
  if (what === 'span') return copy(ctx, d, 'Span id', d.spanId ?? '');
  if (what === 'json') return copy(ctx, d, 'Trace JSON', JSON.stringify(tree ?? null, null, 2));
  return copy(ctx, d, 'Trace id', d.traceId ?? '');
}

export const view = {
  id: ID,
  label: LABEL,
  icon: '⋔',
  hosts: ['power-pages', 'standalone'],
  requires: ['/__sim/api/trace'],

  /** A deep link: list state (filters, range, sort; missing ones cleared) unless it only names detail state. */
  route(ctx, params) {
    const d = stateOf(ctx),
      names = [...params.keys()];
    // `#trace` alone is the default view: no filter, no open trace, as the address says.
    const bare = !names.length;
    const before = { list: listKey(d), traceId: d.traceId, compare: d.compare?.join(',') ?? null };
    if (bare || !names.every((name) => DETAIL_NAMES.includes(name))) {
      d.filters = Object.fromEntries(FILTERS.map((name) => [name, params.get(name) ?? '']));
      const range = params.get('range');
      d.range = Object.hasOwn(RANGES, range) ? range : d.filters.from || d.filters.to ? 'custom' : 'all';
      d.sort = {
        by: Object.hasOwn(SORTS, params.get('sort')) ? params.get('sort') : 'start',
        order: params.get('order') === 'asc' ? 'asc' : 'desc',
      };
      d.bucketFocus = null;
      ctx.pager('trace-list').page = 1;
    }
    if (bare || names.includes('traceId') || names.some((name) => FILTERS.includes(name))) {
      d.traceId = params.get('traceId') || null;
      d.spanId = (d.traceId && params.get('spanId')) || null;
      d.spanSearch = params.get('spanSearch') ?? '';
      d.errorsOnly = params.get('errorsOnly') === 'true';
      if (!names.includes('compare')) d.compare = null;
    }
    if (names.includes('compare')) d.compare = compareOf(params.get('compare'));
    if (d.traceId !== before.traceId) {
      d.tree = null;
      d.children = null;
      d.copied = null;
      d.linked = {};
    }
    // The link names a span, a trace or a comparison: that lands in view once it rendered (DV-C-3).
    if (d.spanId && names.includes('spanId')) ctx.reveal?.('#trace-span-drawer');
    else if (d.traceId && names.includes('traceId')) ctx.reveal?.('#trace-detail-title');
    else if (d.compare && names.includes('compare')) ctx.reveal?.('[data-ui-section="trace:compare"]');
    if ((d.compare?.join(',') ?? null) !== before.compare) d.compared = null;
    // After the first load, the next load fetches only what this link changed.
    if (d.loaded) {
      const need = new Set(d.need ?? []);
      if (listKey(d) !== before.list) for (const part of LIST_PARTS) need.add(part);
      if (d.traceId && !d.tree) need.add('tree');
      if (d.compare && !d.compared) need.add('compare');
      d.need = [...need];
    }
    // The controls show the linked state, not what was typed before.
    ctx.forgetDraft?.(FILTER_FORM);
  },

  /** Fetches `parts` (default: what the last deep link needs, else everything) and keeps each part's newest answer. */
  async load(ctx, parts) {
    const d = stateOf(ctx),
      pager = ctx.pager('trace-list');
    const want = new Set(parts ?? d.need ?? PARTS);
    d.need = null;
    const now = Date.now();
    const filters = filterQuery(d, now);
    const jobs = [];
    const get = (path) => ctx.request(path).catch(failureOf);
    const generation = (part) => (d.generations[part] = (d.generations[part] ?? 0) + 1);
    const fetchPart = (part, key, run) => {
      const stamp = generation(part);
      jobs.push(run().then((value) => ({ part, key, stamp, value })));
    };
    if (want.has('list')) {
      const query = sortQuery(d, new URLSearchParams(filters));
      query.set('page', String(pager.page || 1));
      query.set('pageSize', String(pager.size || kit.PAGE_SIZES[0]));
      fetchPart('list', null, () => get(`/trace?${query}`));
    }
    if (want.has('stats')) fetchPart('stats', null, () => get(`/trace/stats${filters.size ? `?${filters}` : ''}`));
    if (want.has('previous')) {
      const previous = previousWindow(d, now);
      if (previous) fetchPart('previous', previous.length, () => get(`/trace/stats?${previous.query}`));
      else {
        generation('previous');
        d.previous = null;
      }
    }
    if (want.has('settings')) fetchPart('settings', null, () => get('/trace/settings'));
    if (want.has('tree')) {
      const id = d.traceId;
      if (id) fetchPart('tree', id, () => get(`/trace/id/${encodeURIComponent(id)}`));
      else {
        generation('tree');
        d.tree = null;
      }
    }
    if (want.has('compare')) {
      const ids = d.compare ? [...d.compare] : null;
      if (ids)
        fetchPart('compare', ids.join(','), async () =>
          Object.fromEntries(
            await Promise.all(ids.map(async (id) => [id, await get(`/trace/id/${encodeURIComponent(id)}`)])),
          ),
        );
      else {
        generation('compare');
        d.compared = null;
      }
    }
    for (const { part, key, stamp, value } of await Promise.all(jobs)) {
      // A newer load of this part started (or the open trace changed): this answer is stale.
      if (stamp !== d.generations[part]) continue;
      if (part === 'tree' && key !== d.traceId) continue;
      if (part === 'compare' && key !== (d.compare?.join(',') ?? null)) continue;
      if (part === 'list') {
        if (value && !value.error && value.page) pager.page = value.page;
        d.list = value;
      } else if (part === 'stats') d.stats = value;
      else if (part === 'previous') {
        d.previous = value;
        d.previousLength = key;
      } else if (part === 'settings') {
        const was = d.settings?.settings;
        if (
          was &&
          ['level', 'persist', ...LIMITS.map(([name]) => name)].some((name) => was[name] !== value?.settings?.[name])
        )
          ctx.forgetDraft?.(SETTINGS_FORM);
        d.settings = value;
      } else if (part === 'tree') d.tree = value;
      else if (part === 'compare') d.compared = value;
    }
    d.loaded = true;
    if (d.live) connect(ctx, d);
    if (d.spanId) await loadTargets(ctx, d);
  },

  leave(ctx) {
    const d = ctx?.data?.[ID];
    disconnect(d);
    if (d) d.loaded = false;
  },

  render(ctx) {
    const d = stateOf(ctx);
    // The scroll position of the column this render replaces (mounted puts it back).
    const shown = globalThis.document?.querySelector?.('.ui-trace-side');
    d.sideScroll = shown ? { key: shown.dataset.traceSide, top: shown.scrollTop } : null;
    const level = d.settings?.settings?.level;
    const served = liveServed(ctx);
    const query = sortQuery(d, filterQuery(d));
    query.set('format', d.exportFormat);
    const toolbar =
      `<div class="ui-toolbar" role="toolbar" aria-label="Trace actions">` +
      `<button type="button" class="ui-button ui-small" id="trace-live"${served === false ? ' disabled' : ''} data-trace-action="live" aria-pressed="${Boolean(d.live)}">${d.live ? 'Live: on' : 'Live: off'}</button><span class="ui-help" role="status">${e(served === false ? 'This host does not stream traces' : d.live ? (d.liveStatus ?? 'Connecting…') : 'Not following')}</span>` +
      '<button type="button" class="ui-button ui-small" id="trace-refresh" data-trace-action="refresh">Refresh traces</button>' +
      `<label for="trace-export-format">Export as</label><select id="trace-export-format" data-trace-export-format aria-describedby="trace-export-format-help">${EXPORT_FORMATS.map(([value, text]) => `<option value="${value}"${d.exportFormat === value ? ' selected' : ''}>${e(text)}</option>`).join('')}</select>` +
      `<a class="ui-button ui-small" id="trace-export" href="${e(`${API}/trace/export?${query}`)}" download>Export filtered traces</a>` +
      '<button type="button" class="ui-button ui-small" data-trace-action="settings">Settings</button>' +
      '<button type="button" class="ui-button ui-small" data-trace-action="clear">Clear traces</button></div>' +
      fieldHelp(ctx, 'trace-export-format', 'trace', 'exportFormat');
    const off =
      level === 'off'
        ? kit.notice('Tracing is off: new requests are not recorded. Choose summary or full under Settings.', 'warn')
        : '';
    const count = activeCount(d);
    const side =
      (d.compare
        ? panel(
            ctx,
            'compare',
            'Compare traces',
            `${short(d.compare[0])} · ${short(d.compare[1])}`,
            comparePanel(ctx, d),
            true,
          )
        : '') + (d.traceId ? panel(ctx, 'detail', 'Trace detail', short(d.traceId), detailPanel(ctx, d), true) : '');
    const main =
      panel(
        ctx,
        'filters',
        'Filters',
        count ? `${count} active` : 'none',
        filtersPanel(ctx, d),
        Boolean(refusedFilter(d)),
      ) +
      panel(
        ctx,
        'list',
        'Traces',
        Array.isArray(d.list?.items) ? `${d.list.total} traces` : 'unavailable',
        listPanel(ctx, d),
        true,
      ) +
      panel(ctx, 'overview', 'Overview', `${d.stats?.count ?? 0} spans`, overviewPanel(ctx, d), true) +
      panel(ctx, 'settings', 'Settings', level ? `level ${level}` : 'unavailable', settingsPanel(ctx, d));
    return (
      heading(ctx) +
      toolbar +
      (d.liveRefused ? kit.notice(d.liveRefused, 'warn') : '') +
      off +
      chips(d) +
      invalidFilter(d) +
      // At 1200 px and wider the open trace sits beside the list (ui-kit.css .ui-trace-layout).
      `<div class="ui-trace-layout${side ? ' has-detail' : ''}"><div class="ui-trace-main">${main}</div>${side ? `<div class="ui-trace-side" data-trace-side="${e(sideKey(d))}">${side}</div>` : ''}</div>`
    );
  },

  /** The open trace's column scrolls on its own beside the list (1200 px and wider); every render replaces it, so its
   * scroll position, read in render() before the replacement, is put back here (a newly opened trace starts at its top). */
  mounted(ctx) {
    const d = stateOf(ctx);
    const side = globalThis.document?.querySelector?.('.ui-trace-side');
    if (side && d.sideScroll?.key === side.dataset.traceSide) side.scrollTop = d.sideScroll.top;
  },

  handle(ctx, event) {
    const d = stateOf(ctx);
    const target = (selector) => event.target?.closest?.(selector);
    /** The list state changed: page 1, the address, then the list and stats (the filter form's draft is replaced). */
    const apply = () => {
      ctx.forgetDraft?.(FILTER_FORM);
      ctx.pager('trace-list').page = 1;
      d.bucketFocus = null;
      syncHash(d);
      reload(ctx, LIST_PARTS);
      return true;
    };
    if (event.type === 'submit' && target('[data-trace-filters]')) {
      event.preventDefault();
      const fields = Object.fromEntries(
        [...new FormData(target('[data-trace-filters]'))].map(([name, value]) => [name, String(value).trim()]),
      );
      const previous = { ...d.filters };
      for (const name of FILTERS) d.filters[name] = fields[name] ?? '';
      // A time input shows whole seconds: an unchanged one keeps the exact time it shows (a timeline bucket).
      for (const name of ['from', 'to'])
        if (d.filters[name] && d.filters[name] === localInput(previous[name])) d.filters[name] = previous[name];
        else if (d.filters[name]) {
          const at = Date.parse(d.filters[name]);
          d.filters[name] = Number.isFinite(at) ? new Date(at).toISOString() : '';
        }
      d.range = d.filters.from || d.filters.to ? 'custom' : Object.hasOwn(RANGES, fields.range) ? fields.range : 'all';
      d.traceId = d.spanId = null;
      d.tree = null;
      return apply();
    }
    if (event.type === 'change' && target('[data-trace-range]')) {
      const range = target('[data-trace-range]').value;
      if (!Object.hasOwn(RANGES, range)) return true;
      d.range = range;
      d.filters.from = d.filters.to = '';
      return apply();
    }
    if (event.type === 'change' && target('[data-table-size="trace-list"]')) {
      const pager = ctx.pager('trace-list');
      pager.size = Number(target('[data-table-size="trace-list"]').value);
      pager.page = 1;
      reload(ctx, ['list']);
      return true;
    }
    if (event.type === 'change' && target('[data-trace-export-format]')) {
      const format = target('[data-trace-export-format]').value;
      if (EXPORT_FORMATS.some(([value]) => value === format)) d.exportFormat = format;
      ctx.render?.();
      return true;
    }
    if (event.type === 'change' && target('[data-trace-pick]')) {
      const box = target('[data-trace-pick]'),
        id = box.dataset.tracePick;
      d.picked = d.picked.filter((item) => item !== id);
      // Ticking a third trace replaces the oldest tick.
      if (box.checked) d.picked = [...d.picked, id].slice(-2);
      ctx.render?.();
      return true;
    }
    if (event.type === 'change' && target('[data-trace-errors-only]')) {
      d.errorsOnly = Boolean(target('[data-trace-errors-only]').checked);
      syncHash(d);
      ctx.render?.();
      return true;
    }
    if (event.type === 'input' && target('[data-trace-span-search]')) {
      d.spanSearch = target('[data-trace-span-search]').value;
      syncHash(d);
      ctx.render?.();
      return true;
    }
    const form = event.type === 'submit' ? target('[data-trace-settings]') : null;
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
      const retained = before.traces;
      return pending(ctx, event.submitter ?? form.querySelector('[type=submit]'), async () => {
        d.settings = await ctx.request('/trace/settings', { method: 'PUT', body: JSON.stringify(body) });
        // The saved settings are the truth now: the radios and limits show them, not the input before the save.
        ctx.forgetDraft?.(SETTINGS_FORM);
        const saved = d.settings?.settings ?? body;
        // The limits are named only when this save changed one.
        const limits = LIMITS.some(([name]) => Object.hasOwn(body, name) && body[name] !== before[name])
          ? `; keeps ${saved.traces} traces, ${saved.spansPerTrace} spans per trace, ${saved.payloadBytes} payload bytes`
          : '';
        ctx.notify(`Tracing level ${saved.level ?? body.level}${body.persist ? ', persisted' : ''}${limits}.`);
        ctx.render?.();
        // A smaller retention drops the oldest traces at once.
        if (retained !== undefined && saved.traces < retained) reload(ctx, LIST_PARTS);
      });
    }
    if (event.type === 'keydown') {
      const tab = target('[role="tab"][data-tab]');
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const ids = tab.dataset.tab === 'trace-detail' ? DETAIL_TABS.map(([id]) => id) : BREAKDOWNS.map(([id]) => id);
        const next = step(ids.length, ids.indexOf(tab.dataset.tabId), event.key);
        return selectTab(ctx, d, tab.dataset.tab, ids[next]);
      }
      const bucket = target('[data-trace-bucket]');
      if (bucket && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        return narrow(ctx, d, bucket.dataset.traceBucket);
      }
      if (bucket && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        d.bucketFocus = step(d.stats?.timeline?.length ?? 1, Number(bucket.dataset.bucketIndex), event.key);
        ctx.render?.();
        focus(`trace-bucket-${d.bucketFocus}`);
        return true;
      }
      if (event.key === 'Escape' && d.spanId && !target('input, select, textarea')) {
        event.preventDefault();
        return closeSpan(ctx, d);
      }
      return false;
    }
    if (event.type !== 'click') return false;
    // A compare tick is a checkbox inside a row: it toggles natively and never opens the row's trace.
    if (target('[data-trace-pick]')) return true;
    const action = target('[data-trace-action]')?.dataset.traceAction;
    if (action === 'refresh') {
      reload(ctx);
      return true;
    }
    if (action === 'reset') {
      d.filters = blankFilters();
      d.range = 'all';
      d.sort = defaultSort();
      return apply();
    }
    if (action === 'settings') {
      ctx.reveal?.('[data-ui-section="trace:settings"]');
      ctx.render?.();
      return true;
    }
    if (action === 'live') {
      if (liveServed(ctx) === false) return true;
      d.live = !d.live;
      if (d.live) connect(ctx, d);
      else disconnect(d);
      ctx.render?.();
      return true;
    }
    if (action === 'clear') {
      ctx.askConfirmation(
        'Clear traces?',
        'Remove every retained trace from this runtime. Trace files already persisted stay on disk.',
        async () => {
          await ctx.request('/trace/clear', { method: 'POST', body: '{}' });
          d.traceId = d.spanId = null;
          d.tree = null;
          d.compare = d.compared = null;
          d.picked = [];
          ctx.pager('trace-list').page = 1;
          syncHash(d);
          await reload(ctx, [...LIST_PARTS, 'settings']);
          ctx.notify('Traces cleared.');
        },
        'Clear traces',
      );
      return true;
    }
    if (action === 'compare') {
      if (d.picked.length !== 2) return true;
      d.compare = [...d.picked];
      d.compared = null;
      syncHash(d);
      ctx.reveal?.('[data-ui-section="trace:compare"]');
      reload(ctx, ['compare']);
      ctx.render?.();
      return true;
    }
    if (action === 'close-compare') {
      d.compare = d.compared = null;
      syncHash(d);
      ctx.render?.();
      focus('trace-compare');
      return true;
    }
    if (action === 'copy-done') {
      d.copied = null;
      ctx.render?.();
      return true;
    }
    if (action === 'close-trace') {
      const id = d.traceId;
      d.traceId = d.spanId = null;
      d.tree = null;
      d.copied = null;
      syncHash(d);
      ctx.render?.();
      focus(`trace-open-${id}`);
      return true;
    }
    if (action === 'close-span') return closeSpan(ctx, d);
    const copyWhat = target('[data-trace-copy]')?.dataset.traceCopy;
    if (copyWhat) {
      copyAction(ctx, d, copyWhat);
      return true;
    }
    const tab = target('[role="tab"][data-tab]');
    if (tab) return selectTab(ctx, d, tab.dataset.tab, tab.dataset.tabId);
    const bucket = target('[data-trace-bucket]');
    if (bucket) return narrow(ctx, d, bucket.dataset.traceBucket);
    const pivot = target('[data-trace-pivot]');
    if (pivot) {
      const name = pivot.dataset.tracePivot,
        value = pivot.dataset.value;
      if (name === 'actor') {
        const [kind, ...id] = value.split(':');
        d.filters.actorKind = kind;
        d.filters.actorId = id.join(':');
      } else d.filters[name] = value;
      return apply();
    }
    const chip = target('[data-trace-unfilter]');
    if (chip) {
      const name = chip.dataset.traceUnfilter;
      if (name === 'range') d.range = 'all';
      else if (FILTERS.includes(name)) d.filters[name] = '';
      if (d.range === 'custom' && !d.filters.from && !d.filters.to) d.range = 'all';
      apply();
      const next = FILTERS.find((filter) => d.filters[filter]) ?? (RANGES[d.range] ? 'range' : null);
      // The next chip; else Apply when the filter form is open, else Refresh (both survive the re-render by id).
      const formOpen = globalThis.document?.querySelector?.('[data-ui-section="trace:filters"]')?.open;
      focus(next ? `trace-chip-${next}` : formOpen ? 'trace-apply' : 'trace-refresh');
      return true;
    }
    const sort = target('[data-trace-sort]');
    if (sort) {
      const by = sort.dataset.traceSort;
      if (!Object.hasOwn(SORTS, by)) return true;
      d.sort = d.sort.by === by ? { by, order: d.sort.order === 'asc' ? 'desc' : 'asc' } : { by, order: 'desc' };
      ctx.pager('trace-list').page = 1;
      syncHash(d);
      reload(ctx, ['list']);
      return true;
    }
    const page = target('[data-table-page="trace-list"]');
    if (page) {
      ctx.pager('trace-list').page += Number(page.dataset.delta);
      reload(ctx, ['list']);
      return true;
    }
    const children = target('[data-trace-children]');
    if (children) {
      const spanId = children.dataset.traceChildren;
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
    const span = target('[data-trace-span]');
    if (span) {
      d.spanId = span.dataset.traceSpan === d.spanId ? null : span.dataset.traceSpan;
      syncHash(d);
      // The landing is set before the render, so this render scrolls to and focuses the drawer.
      if (d.spanId) ctx.reveal?.('#trace-span-drawer');
      ctx.render?.();
      if (d.spanId) loadTargets(ctx, d).then((read) => read && ctx.render?.());
      return true;
    }
    const open = target('[data-trace-open]');
    if (open) {
      if (open.dataset.traceOpen !== d.traceId) {
        d.traceId = open.dataset.traceOpen;
        d.spanId = null;
        d.tree = null;
        d.children = null;
        d.copied = null;
        d.spanSearch = '';
        d.errorsOnly = false;
        d.linked = {};
      }
      syncHash(d);
      ctx.reveal?.('#trace-detail-title');
      reload(ctx, ['tree']);
      ctx.render?.();
      return true;
    }
    return false;
  },
};

/** What the side column shows: the open trace and the compared pair. */
const sideKey = (d) => `${d.traceId ?? ''}|${d.compare?.join(',') ?? ''}`;
/** Closes the span drawer; focus returns to the span's label. */
function closeSpan(ctx, d) {
  const id = d.spanId;
  d.spanId = null;
  syncHash(d);
  ctx.render?.();
  focus(`trace-span-${id}`);
  return true;
}
/** The next index of a roving set for an arrow, Home or End key (wrapping). */
function step(length, index, key) {
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return (index + (key === 'ArrowRight' ? 1 : -1) + length) % length;
}
function selectTab(ctx, d, key, id) {
  if (key === 'trace-detail') d.tab = DETAIL_TABS.some(([tab]) => tab === id) ? id : 'waterfall';
  else if (BREAKDOWNS.some(([name]) => name === id)) d.breakdown = id;
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
  ctx.pager('trace-list').page = 1;
  syncHash(d);
  reload(ctx, LIST_PARTS);
  return true;
}
