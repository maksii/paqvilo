// paqvilo mirage trace: reads the trace store of a running local runtime through /_sim/api/trace (sim-trace-routes.mjs).
// The runtime is --origin (loopback only), the one discovered for --project FILE, or the one connectRuntime discovers for
// --config/--site. show takes a full trace id, a unique id prefix or --latest. watch follows the
// `trace` channel of /_sim/events (connectRuntime().trace.subscribe) and prints one line per ended span, or per ended
// trace with --trace-end, until Ctrl+C, --count lines or the runtime stopping. flush waits until the runtime wrote its
// queued persisted lines and SSE frames. --json prints one envelope { schemaVersion: 1, ok, command, result } (watch: one
// per line); a failure is { ok: false, error: { code, message, parameter? } }. A filter or setting the runtime (or the
// same check before connecting) refuses prints `<code>: <message>` and exits 2; any other failure exits 1.
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolCommand } from './tool-options.mjs';
import { mirageToolHelp } from './tool-registry.mjs';
import { connectRuntime, runtimeOrigin } from './testing/runtime.mjs';
import { checkTraceFilters, idMatches, searchText, traceFailed } from './lib/trace-store.mjs';

const ACTIONS = new Set(['list', 'show', 'spans', 'stats', 'settings', 'clear', 'flush', 'export', 'watch']);
// The span filters, which watch also applies to the frames it receives.
const SPAN_FILTERS = [
  'from',
  'to',
  'kind',
  'module',
  'operation',
  'entity',
  'record-id',
  'status',
  'host',
  'actor-kind',
  'actor-id',
  'session-key',
  'visitor-id',
  'portal',
  'audit-id',
  'result',
  'search',
  'trace-id',
  'parent-span-id',
  'depth',
  'min-duration-ms',
  'has-errors',
];
const PAGING = new Set(['page', 'page-size', 'order', 'sort', 'bucket-ms']);
const FILTERS = [...SPAN_FILTERS, ...PAGING];
const SETTINGS = ['level', 'persist', 'traces', 'spans-per-trace', 'payload-bytes'];
const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
const invalid = (message) => Object.assign(new Error(message), { code: 'InvalidArguments' });
const usage = () => invalid(mirageToolHelp('trace').trim());

// The partial settings change named by the flags (the runtime validates it), or null.
function settingsChange(values) {
  const named = SETTINGS.filter((name) => values[name] !== undefined);
  if (!named.length) return null;
  return Object.fromEntries(
    named.map((name) => {
      const value = values[name];
      if (name === 'level') return [name, value];
      if (name === 'persist') {
        if (value === 'true') return [name, true];
        if (value === 'false') return [name, false];
        return [name, value];
      }
      return [camel(name), /^\d+$/.test(value) ? Number(value) : value];
    }),
  );
}

// list and spans print local time (YYYY-MM-DD HH:MM:SS.mmm) with the zone named once in the STARTED header, as the _sim
// Monitor does (DV-N4-18); --utc prints the ISO UTC instant instead. ponytail: one offset (now's) for the header, so a
// list spanning a daylight-saving change shows the rows of the other side in local time under the current offset.
const pad = (value, width = 2) => String(value).padStart(width, '0');
const zoneLabel = (date = new Date()) => {
  const offset = -date.getTimezoneOffset();
  return `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};
const localTime = (iso) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? '');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
};
const startedColumn = (utc, pick) =>
  utc ? ['STARTED (UTC)', pick] : [`STARTED (${zoneLabel()})`, (row) => localTime(pick(row))];
const ms = (value) => (value === null || value === undefined ? 'running' : `${value} ms`);
const figure = (value) => (value === null || value === undefined ? '—' : `${value} ms`);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
function table(rows, columns) {
  const widths = columns.map(([title, cell]) => Math.max(title.length, ...rows.map((row) => String(cell(row)).length)));
  const line = (cells) =>
    cells
      .map((cell, index) => String(cell).padEnd(widths[index]))
      .join('  ')
      .trimEnd();
  return [line(columns.map(([title]) => title)), ...rows.map((row) => line(columns.map(([, cell]) => cell(row))))];
}
const pageLine = (page) =>
  `Page ${page.page} of ${page.pageCount}; ${page.total} matching, ${page.retained} retained, ${page.dropped} dropped.`;
const spanLine = (span) =>
  `${span.startedAt}  ${span.kind}  ${span.status}  ${ms(span.durationMs)}  ${span.name}${span.entity ? ' (' + span.entity + ')' : ''}  trace ${span.traceId}`;
const traceLine = (trace) =>
  `${trace.startedAt}  ${trace.status}  ${ms(trace.durationMs)}  ${plural(trace.spanCount, 'span')}  ${plural(trace.errorCount, 'error')}  ${trace.root?.name ?? ''}  trace ${trace.traceId}`;
const statusLines = (status) => {
  const persistence = () => (status.persist.enabled ? 'on, ' + (status.persist.directory ?? 'no state folder') : 'off');
  return [
    `Retained ${plural(status.retained, 'trace')}, ${plural(status.spans, 'span')} (${status.running} running), about ${status.memoryBytes} bytes; ${plural(status.dropped, 'trace')} and ${plural(status.droppedSpans, 'span')} dropped.`,
    `Persistence: ${persistence()}${status.persist.lastError ? ' (' + status.persist.lastError + ')' : ''}; ${plural(status.persist.written, 'line')} written, ${status.persist.failures} failed.`,
  ];
};
// An actor as `kind`, `kind:name` or `kind:id`.
const actorText = (actor) => {
  if (!actor) return '';
  const kind = actor.kind;
  if (actor.name || actor.id) return kind + ':' + (actor.name || actor.id);
  return kind + '';
};
// failed (roots only) is the count of failed activities, appended after the max figure.
const figuresLine = (label, value, unit, failed = null) =>
  `${label}: ${plural(value.count, unit)}, ${plural(value.errors, 'error')}, p50 ${figure(value.p50)}, p95 ${figure(value.p95)}, max ${figure(value.max)}${failed === null ? '' : `, ${failed} failed`}.`;

function humanTrace(result) {
  const { trace } = result,
    lines = [
      `Trace ${trace.traceId}: ${trace.status}, ${ms(trace.durationMs)} (${ms(trace.totalDurationMs)} in all), ${plural(trace.spanCount, 'span')}, ${plural(trace.errorCount, 'error')}, ${trace.deniedCount} denied.`,
    ];
  const walk = (node, depth) => {
    const entity = () => (node.entity ? ' ' + node.entity : '');
    const events = () => (node.events.length ? ' (' + plural(node.events.length, 'event') + ')' : '');
    lines.push(
      `${'  '.repeat(depth)}${node.name} [${node.kind}] ${node.status} ${ms(node.durationMs)}${entity()}${events()}${node.async ? ' async' : ''}`,
    );
    if (node.error) lines.push(`${'  '.repeat(depth + 1)}${node.error.code}: ${node.error.message}`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of result.children) walk(node, 0);
  return lines;
}

function human(action, result, { utc = false } = {}) {
  // DURATION is the root's; TOTAL (what --sort duration sorts by) runs from the first span start to the last span end.
  if (action === 'list')
    return [
      ...table(result.items, [
        startedColumn(utc, (t) => t.startedAt),
        ['STATUS', (t) => (traceFailed(t) && t.status === 'ok' ? 'ok (failed steps)' : t.status)],
        ['DURATION', (t) => ms(t.durationMs)],
        ['TOTAL', (t) => ms(t.totalDurationMs)],
        ['SPANS', (t) => t.spanCount],
        ['ERRORS', (t) => t.errorCount],
        ['DENIED', (t) => t.deniedCount],
        ['HOST', (t) => t.root?.origin?.host ?? ''],
        ['ACTOR', (t) => actorText(t.root?.actor)],
        ['SESSION', (t) => t.root?.session?.sessionKey ?? ''],
        ['NAME', (t) => t.root?.name ?? ''],
        ['TRACE', (t) => t.traceId],
      ]),
      pageLine(result),
    ];
  if (action === 'flush')
    return ['Flushed every queued persisted line and trace stream frame.', ...statusLines(result)];
  if (action === 'spans')
    return [
      ...table(result.items, [
        startedColumn(utc, (s) => s.startedAt),
        ['KIND', (s) => s.kind],
        ['STATUS', (s) => s.status],
        ['DURATION', (s) => ms(s.durationMs)],
        ['ENTITY', (s) => s.entity ?? ''],
        ['RECORD', (s) => s.recordId ?? ''],
        ['ACTOR', (s) => actorText(s.actor)],
        ['NAME', (s) => s.name],
        ['SPAN', (s) => s.spanId],
      ]),
      pageLine(result),
    ];
  if (action === 'show') return humanTrace(result);
  if (action === 'stats')
    return [
      `${plural(result.count, 'span')} from ${result.from ?? '—'} to ${result.to ?? '—'}.`,
      figuresLine('Overall', result.overall, 'span'),
      figuresLine('Roots', result.roots, 'trace', result.roots.failed),
      ...table(Object.entries(result.byKind), [
        ['KIND', ([key]) => key],
        ['COUNT', ([, value]) => value.count],
        ['ERRORS', ([, value]) => value.errors],
        ['P50', ([, value]) => figure(value.p50)],
        ['P95', ([, value]) => figure(value.p95)],
        ['MAX', ([, value]) => figure(value.max)],
      ]),
      ...(result.slowest.length ? ['Slowest:', ...result.slowest.map((span) => `  ${spanLine(span)}`)] : []),
    ];
  if (action === 'settings') {
    const { settings, status } = result;
    return [...Object.entries(settings).map(([key, value]) => `${key}: ${value}`), ...statusLines(status)];
  }
  return [`Cleared every trace; ${result.retained} retained.`];
}

function traceValueMatches(key, actual, values, trace, span, lower, equal) {
  return (
    values[key] === undefined ||
    (trace ? actual.some((value) => lower(value) === values[key].toLowerCase()) : equal(key, span[key]))
  );
}

function frameStatusMatches(filters, span, trace, lower) {
  if (filters.status === undefined) return true;
  if (trace && ['error', 'denied'].includes(filters.status.toLowerCase()))
    return trace[`${filters.status.toLowerCase()}Count`] > 0;
  return lower(trace ? trace.status : span.status) === filters.status.toLowerCase();
}

function frameIdentityMatches(filters, span, equal, actorKey) {
  return (
    (filters.recordId === undefined ||
      (span.recordId != null && idMatches(actorKey(span.recordId), actorKey(filters.recordId).trim()))) &&
    equal('host', span.origin?.host) &&
    equal('actorKind', span.actor?.kind) &&
    (filters.actorId === undefined ||
      (span.actor?.id != null && idMatches(actorKey(span.actor.id), actorKey(filters.actorId)))) &&
    (filters.sessionKey === undefined || idMatches(span.session?.sessionKey ?? null, filters.sessionKey)) &&
    (filters.visitorId === undefined || idMatches(span.session?.visitorId ?? null, filters.visitorId)) &&
    (filters.portal === undefined || span.origin?.portal === filters.portal) &&
    (filters.auditId === undefined || span.attributes?.auditId === filters.auditId)
  );
}

function frameResultMatches(filters, span, trace, lower) {
  return (
    (filters.result === undefined ||
      filters.result
        .toLowerCase()
        .split(',')
        .map((value) => value.trim())
        .includes(lower(trace ? trace.status : span.status))) &&
    (filters.traceId === undefined || span.traceId === filters.traceId) &&
    (filters.parentSpanId === undefined || span.parentSpanId === filters.parentSpanId) &&
    (filters.depth === undefined || span.depth === Number(filters.depth))
  );
}

function frameRangeMatches(filters, start, duration, errors, time) {
  return (
    (filters.from === undefined || start >= time(filters.from)) &&
    (filters.to === undefined || start <= time(filters.to)) &&
    (filters.minDurationMs === undefined || (duration !== null && duration >= Number(filters.minDurationMs))) &&
    (filters.hasErrors === undefined || errors === ['true', '1'].includes(filters.hasErrors))
  );
}

// watch applies the span filters itself, like the list routes: on span-end frames to the span, on trace-end frames to
// the trace (kind, module and entity: any span of it; status error/denied: any span; the rest: the root span).
function frameFilter(filters) {
  const lower = (value) => (value === null || value === undefined ? null : String(value).toLowerCase());
  const actorKey = (value) => String(value).replace(/[{}]/g, '').toLowerCase();
  const time = (value) => (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value));
  const f = Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value).trim()]));
  const equal = (key, actual) => f[key] === undefined || lower(actual) === f[key].toLowerCase();
  return ({ span, trace }) => {
    const start = Date.parse(span.startedAt);
    const search = f.search?.toLowerCase();
    const status = frameStatusMatches(f, span, trace, lower);
    // A browser probe's 404 root span is an expected answer, not a failed step.
    const errors = trace
      ? traceFailed(trace)
      : ['error', 'denied'].includes(span.status) &&
        !(span.attributes?.browserProbe === true && span.attributes?.statusCode === 404);
    const duration = trace ? trace.totalDurationMs : span.durationMs;
    return (
      status &&
      traceValueMatches('kind', trace ? Object.keys(trace.kinds ?? {}) : [], f, trace, span, lower, equal) &&
      traceValueMatches('module', trace?.modules ?? [], f, trace, span, lower, equal) &&
      traceValueMatches('entity', trace?.entities ?? [], f, trace, span, lower, equal) &&
      equal('operation', span.operation) &&
      frameIdentityMatches(f, span, equal, actorKey) &&
      frameResultMatches(f, span, trace, lower) &&
      frameRangeMatches(f, start, duration, errors, time) &&
      (!search || searchText(span).includes(search))
    );
  };
}

// Follows the trace channel; resolves after `count` printed lines, or when the stream ends (Ctrl+C or the runtime
// stopping: one `stream ended` line on stderr).
async function watch(client, { count, json, traceEnd, filters }) {
  // The runtime validates the filters exactly as for list (InvalidTraceFilter) before the stream opens.
  if (Object.keys(filters).length) await client.trace.spans({ ...filters, pageSize: 1 });
  const matches = frameFilter(filters),
    type = traceEnd ? 'trace-end' : 'span-end';
  let printed = 0;
  const unsubscribe = client.trace.subscribe((event) => {
    if (event.type !== type || (count && printed >= count) || !matches(event)) return;
    let line;
    if (json) line = JSON.stringify({ schemaVersion: 1, ok: true, command: 'watch', result: event });
    else if (traceEnd) line = traceLine(event.trace);
    else line = spanLine(event.span);
    console.log(line);
    if (count && ++printed >= count) unsubscribe();
  });
  process.once('SIGINT', unsubscribe);
  try {
    await unsubscribe.closed;
  } finally {
    process.off('SIGINT', unsubscribe);
  }
  if (!count || printed < count) console.error('stream ended');
}

// export without --json: the route's bytes as they arrive, in the chosen format.
async function streamExport(client, filters) {
  const response = await fetch(`${client.origin}/_sim/api/trace/export?${new URLSearchParams(filters)}`, {
    redirect: 'error',
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw Object.assign(new Error(`Local runtime request failed (${response.status})`), {
      status: response.status,
      code: value?.error?.code,
      response: value,
    });
  }
  for await (const chunk of response.body) if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
}

// The action and whether the arguments were accepted, for the failure envelope.
let command = null,
  accepted = false;

const SHOW_USAGE =
  'trace show needs one TRACE_ID (or a unique prefix of at least 8 characters of the id), or --latest.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX = /^[0-9a-f]{8}[0-9a-f-]*$/i;

// show takes exactly one of a trace id (a full UUID or a prefix of one) and --latest.
function validateTracePositionals(action, rest, latest) {
  if (action !== 'show') {
    if (rest.length) throw invalid(`Unexpected argument: ${rest.join(' ')}`);
    return;
  }
  const [id] = rest;
  if (rest.length > 1 || Boolean(id) === Boolean(latest)) throw invalid(SHOW_USAGE);
  if (id && !UUID.test(id) && !PREFIX.test(id)) throw invalid(SHOW_USAGE);
}

function validateTraceFilters(action, filtered, change, latest) {
  const paging = filtered.find((name) => PAGING.has(name));
  if (paging && action === 'watch') throw invalid(`--${paging} applies to list, spans, stats and export, not watch.`);
  if (paging && action === 'show') throw invalid(`--${paging} does not apply to trace show.`);
  const filterable = ['list', 'spans', 'stats', 'export', 'watch'].includes(action) || (action === 'show' && latest);
  if (filtered.length && !filterable)
    throw invalid(`--${filtered[0]} filters list, spans, stats, export and watch only.`);
  if (change && action !== 'settings') throw invalid('Settings flags belong to trace settings.');
}

function validateTraceOptions(action, values) {
  if (values.count !== undefined && (action !== 'watch' || !/^[1-9]\d{0,8}$/.test(values.count)))
    throw invalid('--count must be a positive integer and applies to trace watch only.');
  if (values['trace-end'] && action !== 'watch') throw invalid('--trace-end applies to trace watch only.');
  if (values.latest && action !== 'show') throw invalid('--latest applies to trace show only.');
  if (values.utc && !['list', 'spans'].includes(action)) throw invalid('--utc applies to trace list and spans only.');
  for (const name of ['format', 'limit'])
    if (values[name] !== undefined && action !== 'export') throw invalid(`--${name} applies to trace export only.`);
  if ([values.origin, values.config || values.site, values.project].filter(Boolean).length > 1)
    throw invalid('Use one of --origin, --config/--site or --project.');
  if (values.origin)
    try {
      runtimeOrigin(values.origin);
    } catch (error) {
      throw invalid(error.message);
    }
}

function createTraceFilters(filtered, values) {
  const filters = Object.fromEntries(filtered.map((name) => [camel(name), values[name]]));
  // The store's own check (InvalidTraceFilter naming the parameter), before connecting; the runtime checks again.
  checkTraceFilters(filters);
  return filters;
}

async function traceRequest(client, action, rest, filters, change) {
  if (action === 'list') return client.trace.query(filters);
  if (action === 'spans') return client.trace.spans(filters);
  if (action === 'stats') return client.trace.stats(filters);
  if (action === 'export') return client.trace.export(filters);
  if (action === 'clear') return client.trace.clear();
  if (action === 'flush') return client.trace.flush();
  if (action === 'settings') {
    const settings = change ? await client.trace.configure(change) : await client.trace.settings();
    return { settings, status: await client.trace.status() };
  }
  return showTree(client, rest[0], filters);
}

// The tree of a full trace id, or of the newest trace matching a unique id prefix or the filters (--latest).
async function showTree(client, id, filters) {
  const treeOf = async (traceId) => {
    const tree = await client.trace.tree(traceId);
    if (!tree) throw Object.assign(new Error(`No retained trace has the id ${traceId}.`), { code: 'TraceNotFound' });
    return tree;
  };
  if (id && UUID.test(id)) return treeOf(id);
  const page = await client.trace.query({ ...filters, ...(id ? { traceId: id } : {}), pageSize: 2 });
  if (id && page.total > 1)
    throw Object.assign(new Error(`${id} begins ${page.total} retained trace ids; give more characters.`), {
      code: 'AmbiguousTraceId',
    });
  const [newest] = page.items;
  if (!newest)
    throw Object.assign(
      new Error(id ? `No retained trace has the id ${id}.` : 'No retained trace matches the filters.'),
      { code: 'TraceNotFound' },
    );
  return treeOf(newest.traceId);
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ async function main(argv) {
  const { values, positionals } = parseToolCommand('trace', argv, { allowPositionals: true });
  if (values.help) return console.log(mirageToolHelp('trace').trim());
  const [action, ...rest] = positionals;
  if (!ACTIONS.has(action)) throw usage();
  command = action;
  validateTracePositionals(action, rest, values.latest);
  const filtered = FILTERS.filter((name) => values[name] !== undefined),
    change = settingsChange(values);
  validateTraceFilters(action, filtered, change, values.latest);
  validateTraceOptions(action, values);
  const filters = createTraceFilters(filtered, values);
  accepted = true;
  const client = await connectRuntime({
    origin: values.origin,
    config: values.config,
    site: values.site,
    project: values.project,
  });
  if (action === 'watch')
    return watch(client, {
      count: Number(values.count ?? 0),
      json: values.json,
      traceEnd: values['trace-end'],
      filters,
    });
  for (const name of ['format', 'limit']) if (values[name] !== undefined) filters[name] = values[name];
  // --format bundle: the activity export bundle (connectRuntime().exportBundle), one NDJSON document per line.
  if (action === 'export' && filters.format === 'bundle') {
    const { format: _format, ...bundleFilters } = filters; // NOSONAR: binding is excluded from the rest object or is a placeholder
    const documents = await client.exportBundle(bundleFilters);
    if (values.json)
      return console.log(JSON.stringify({ schemaVersion: 1, ok: true, command: action, result: documents }));
    for (const document of documents) console.log(JSON.stringify(document));
    return;
  }
  if (action === 'export' && !values.json) return streamExport(client, filters);
  const result = await traceRequest(client, action, rest, filters, change);
  if (values.json) return console.log(JSON.stringify({ schemaVersion: 1, ok: true, command: action, result }));
  for (const line of human(action, result, { utc: values.utc })) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    await main(args);
  } catch (error) {
    // The runtime's own { code, message, parameter } when it answered with an error envelope; else the error itself.
    const envelope = error.response?.error && typeof error.response.error === 'object' ? error.response.error : null;
    // Codes the runtime or this command set (TraceNotFound, InvalidTraceFilter, RuntimeUnreachable, ...); node:util
    // parseArgs codes and other refusals before connecting are InvalidArguments.
    let code;
    if (typeof error.code === 'string' && !error.code.startsWith('ERR_')) code = error.code;
    else if (accepted) code = 'MIRAGE_FAILED';
    else code = 'InvalidArguments';
    const message = envelope?.message ?? error.message ?? String(error);
    const parameter = envelope?.parameter ?? error.parameter;
    // A refused filter or setting (the runtime's 400, or the same check before connecting) is a usage error.
    const refused = error.status === 400 || error.code === 'InvalidTraceFilter';
    if (args.slice(0, args.includes('--') ? args.indexOf('--') : undefined).includes('--json'))
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          command,
          error: { code, message, ...(parameter ? { parameter } : {}) },
        }),
      );
    else console.error(envelope || refused ? `${code}: ${message}` : message);
    process.exitCode = refused ? 2 : 1;
  }
}
