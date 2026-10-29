// paqvilo mirage trace: reads the trace store of a running local runtime through /_sim/api/trace (sim-trace-routes.mjs).
// The runtime is --origin (loopback only) or the one connectRuntime discovers for --config/--site. watch follows the
// `trace` channel of /_sim/events (connectRuntime().trace.subscribe) and prints one line per ended span, or per ended
// trace with --trace-end, until Ctrl+C, --count lines or the runtime stopping. --json prints one envelope
// { schemaVersion: 1, ok, command, result } (watch: one per line); a failure is { ok: false, error: { code, message } }.
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolCommand } from './tool-options.mjs';
import { mirageToolHelp } from './tool-registry.mjs';
import { connectRuntime, runtimeOrigin } from './testing/runtime.mjs';

const ACTIONS = ['list', 'show', 'spans', 'stats', 'settings', 'clear', 'export', 'watch'];
// The span filters, which watch also applies to the frames it receives.
const SPAN_FILTERS = [
  'from',
  'to',
  'kind',
  'module',
  'operation',
  'entity',
  'status',
  'host',
  'actor-kind',
  'actor-id',
  'session-key',
  'visitor-id',
  'portal',
  'search',
  'trace-id',
  'parent-span-id',
  'depth',
  'min-duration-ms',
  'has-errors',
];
const PAGING = ['page', 'page-size', 'order', 'sort', 'bucket-ms'];
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
      if (name === 'persist') return [name, value === 'true' ? true : value === 'false' ? false : value];
      return [camel(name), /^\d+$/.test(value) ? Number(value) : value];
    }),
  );
}

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
  `${span.startedAt}  ${span.kind}  ${span.status}  ${ms(span.durationMs)}  ${span.name}${span.entity ? ` (${span.entity})` : ''}  trace ${span.traceId}`;
const traceLine = (trace) =>
  `${trace.startedAt}  ${trace.status}  ${ms(trace.durationMs)}  ${plural(trace.spanCount, 'span')}  ${trace.errorCount} errors  ${trace.root?.name ?? ''}  trace ${trace.traceId}`;
const figuresLine = (label, value, unit) =>
  `${label}: ${plural(value.count, unit)}, ${value.errors} errors, p50 ${figure(value.p50)}, p95 ${figure(value.p95)}, max ${figure(value.max)}.`;

function human(action, result) {
  if (action === 'list')
    return [
      ...table(result.items, [
        ['STARTED', (t) => t.startedAt],
        ['STATUS', (t) => t.status],
        ['DURATION', (t) => ms(t.durationMs)],
        ['SPANS', (t) => t.spanCount],
        ['ERRORS', (t) => t.errorCount],
        ['HOST', (t) => t.root?.origin?.host ?? ''],
        ['NAME', (t) => t.root?.name ?? ''],
        ['TRACE', (t) => t.traceId],
      ]),
      pageLine(result),
    ];
  if (action === 'spans')
    return [
      ...table(result.items, [
        ['STARTED', (s) => s.startedAt],
        ['KIND', (s) => s.kind],
        ['STATUS', (s) => s.status],
        ['DURATION', (s) => ms(s.durationMs)],
        ['ENTITY', (s) => s.entity ?? ''],
        ['NAME', (s) => s.name],
        ['SPAN', (s) => s.spanId],
      ]),
      pageLine(result),
    ];
  if (action === 'show') {
    const { trace } = result,
      lines = [
        `Trace ${trace.traceId}: ${trace.status}, ${ms(trace.durationMs)} (${ms(trace.totalDurationMs)} in all), ${trace.spanCount} spans, ${trace.errorCount} errors, ${trace.deniedCount} denied.`,
      ];
    const walk = (node, depth) => {
      lines.push(
        `${'  '.repeat(depth)}${node.name} [${node.kind}] ${node.status} ${ms(node.durationMs)}${node.entity ? ` ${node.entity}` : ''}${node.events.length ? ` (${plural(node.events.length, 'event')})` : ''}${node.async ? ' async' : ''}`,
      );
      if (node.error) lines.push(`${'  '.repeat(depth + 1)}${node.error.code}: ${node.error.message}`);
      for (const child of node.children) walk(child, depth + 1);
    };
    for (const node of result.children) walk(node, 0);
    return lines;
  }
  if (action === 'stats')
    return [
      `${result.count} spans from ${result.from ?? '—'} to ${result.to ?? '—'}.`,
      figuresLine('Overall', result.overall, 'span'),
      figuresLine('Roots', result.roots, 'trace'),
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
    return [
      ...Object.entries(settings).map(([key, value]) => `${key}: ${value}`),
      `Retained ${status.retained} traces, ${status.spans} spans (${status.running} running), about ${status.memoryBytes} bytes; ${status.dropped} traces and ${status.droppedSpans} spans dropped.`,
      `Persistence: ${status.persist.enabled ? `on, ${status.persist.directory ?? 'no state folder'}` : 'off'}${status.persist.lastError ? ` (${status.persist.lastError})` : ''}.`,
    ];
  }
  return [`Cleared every trace; ${result.retained} retained.`];
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
    const inTrace = (key, list) =>
      f[key] === undefined ||
      (trace ? list.some((value) => lower(value) === f[key].toLowerCase()) : equal(key, span[key]));
    const status =
      f.status === undefined ||
      (trace && ['error', 'denied'].includes(f.status.toLowerCase())
        ? trace[`${f.status.toLowerCase()}Count`] > 0
        : lower(trace ? trace.status : span.status) === f.status.toLowerCase());
    const errors = trace ? trace.errorCount > 0 : span.status === 'error';
    const duration = trace ? trace.totalDurationMs : span.durationMs;
    return (
      status &&
      inTrace('kind', trace ? Object.keys(trace.kinds ?? {}) : []) &&
      inTrace('module', trace?.modules ?? []) &&
      inTrace('entity', trace?.entities ?? []) &&
      equal('operation', span.operation) &&
      equal('host', span.origin?.host) &&
      equal('actorKind', span.actor?.kind) &&
      (f.actorId === undefined || (span.actor?.id != null && actorKey(span.actor.id) === actorKey(f.actorId))) &&
      (f.sessionKey === undefined || span.session?.sessionKey === f.sessionKey) &&
      (f.visitorId === undefined || span.session?.visitorId === f.visitorId) &&
      (f.portal === undefined || span.origin?.portal === f.portal) &&
      (f.traceId === undefined || span.traceId === f.traceId) &&
      (f.parentSpanId === undefined || span.parentSpanId === f.parentSpanId) &&
      (f.depth === undefined || span.depth === Number(f.depth)) &&
      (f.from === undefined || start >= time(f.from)) &&
      (f.to === undefined || start <= time(f.to)) &&
      (f.minDurationMs === undefined || (duration !== null && duration >= Number(f.minDurationMs))) &&
      (f.hasErrors === undefined || errors === ['true', '1'].includes(f.hasErrors)) &&
      (!search ||
        [span.name, span.entity, span.error?.code, span.error?.message, JSON.stringify(span.attributes ?? {})]
          .join('\n')
          .toLowerCase()
          .includes(search))
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
    console.log(
      json
        ? JSON.stringify({ schemaVersion: 1, ok: true, command: 'watch', result: event })
        : traceEnd
          ? traceLine(event.trace)
          : spanLine(event.span),
    );
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
    throw Object.assign(
      new Error(
        `Local runtime request failed (${response.status})${value?.error?.message ? `: ${value.error.message}` : ''}`,
      ),
      { status: response.status, code: value?.error?.code },
    );
  }
  for await (const chunk of response.body) if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
}

// The action and whether the arguments were accepted, for the failure envelope.
let command = null,
  accepted = false;
async function main(argv) {
  const { values, positionals } = parseToolCommand('trace', argv, { allowPositionals: true });
  if (values.help) return console.log(mirageToolHelp('trace').trim());
  const [action, ...rest] = positionals;
  if (!ACTIONS.includes(action)) throw usage();
  command = action;
  if (rest.length !== (action === 'show' ? 1 : 0))
    throw invalid(
      action === 'show' ? 'trace show needs exactly one TRACE_ID.' : `Unexpected argument: ${rest.join(' ')}`,
    );
  const filtered = FILTERS.filter((name) => values[name] !== undefined),
    change = settingsChange(values);
  const paging = action === 'watch' && filtered.find((name) => PAGING.includes(name));
  if (paging) throw invalid(`--${paging} applies to list, spans, stats and export, not watch.`);
  if (filtered.length && !['list', 'spans', 'stats', 'export', 'watch'].includes(action))
    throw invalid(`--${filtered[0]} filters list, spans, stats, export and watch only.`);
  if (change && action !== 'settings') throw invalid('Settings flags belong to trace settings.');
  if (values.count !== undefined && (action !== 'watch' || !/^[1-9]\d{0,8}$/.test(values.count)))
    throw invalid('--count must be a positive integer and applies to trace watch only.');
  if (values['trace-end'] && action !== 'watch') throw invalid('--trace-end applies to trace watch only.');
  for (const name of ['format', 'limit'])
    if (values[name] !== undefined && action !== 'export') throw invalid(`--${name} applies to trace export only.`);
  if (values.origin && (values.config || values.site)) throw invalid('Use --origin or --config/--site, not both.');
  if (values.origin)
    try {
      runtimeOrigin(values.origin);
    } catch (error) {
      throw invalid(error.message);
    }
  accepted = true;
  const client = await connectRuntime({ origin: values.origin, config: values.config, site: values.site });
  const filters = Object.fromEntries(filtered.map((name) => [camel(name), values[name]]));
  if (action === 'watch')
    return watch(client, {
      count: Number(values.count ?? 0),
      json: values.json,
      traceEnd: values['trace-end'],
      filters,
    });
  for (const name of ['format', 'limit']) if (values[name] !== undefined) filters[name] = values[name];
  if (action === 'export' && !values.json) return streamExport(client, filters);
  const request = async () => {
    if (action === 'list') return client.trace.query(filters);
    if (action === 'spans') return client.trace.spans(filters);
    if (action === 'stats') return client.trace.stats(filters);
    if (action === 'export') return client.trace.export(filters);
    if (action === 'clear') return client.trace.clear();
    if (action === 'settings') {
      const settings = change ? await client.trace.configure(change) : await client.trace.settings();
      return { settings, status: await client.trace.status() };
    }
    const tree = await client.trace.tree(rest[0]);
    if (!tree) throw Object.assign(new Error(`No retained trace has the id ${rest[0]}.`), { code: 'TraceNotFound' });
    return tree;
  };
  const result = await request();
  if (values.json) return console.log(JSON.stringify({ schemaVersion: 1, ok: true, command: action, result }));
  for (const line of human(action, result)) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    await main(args);
  } catch (error) {
    const message = error.message ?? String(error);
    // Codes the runtime or this command set (TraceNotFound, InvalidTraceFilter, RuntimeUnreachable, ...); node:util
    // parseArgs codes and other refusals before connecting are InvalidArguments.
    const code =
      typeof error.code === 'string' && !error.code.startsWith('ERR_')
        ? error.code
        : accepted
          ? 'MIRAGE_FAILED'
          : 'InvalidArguments';
    if (args.slice(0, args.includes('--') ? args.indexOf('--') : undefined).includes('--json'))
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: false,
          command,
          error: { code, message },
        }),
      );
    else console.error(message);
    process.exitCode = 1;
  }
}
