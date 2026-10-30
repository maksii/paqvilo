// The Power Pages host's Activity reads (D-M-4, docs/design/tracing.md "Monitor"): the log stream history
// (GET /_sim/api/logs), render source resolution (GET /_sim/api/render-sources) and the activity export bundle
// (GET /_sim/api/activity/export?format=bundle). Refused input is an Error { status: 400, code, parameter } that the host
// answers as its error envelope.
import path from 'node:path';
import { sourceEditorTarget } from './portal-source-index.mjs';
import { exportedTraceIds, otlpSpan, writeChunk } from './sim-trace-routes.mjs';

const LOG_LIMIT = 500;
const LOG_LIMIT_MAX = 50_000;
const REFS_MAX = 100;
const LOG_TYPE = /^[a-z][a-z-]{0,39}$/;
const SOURCE_REF = /^[\w:.-]{1,256}$/;
// Query keys that shape an export without filtering what it matches.
const SHAPING = new Set(['format', 'traces', 'limit', 'page', 'pageSize', 'order', 'sort']);
const refused = (status, code, message, parameter) =>
  Object.assign(new Error(message), { status, code, ...(parameter ? { parameter } : {}) });
const integer = (query, key, min, max, code) => {
  const value = query.get(key);
  if (value === null || value === '') return null;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
    throw refused(400, code, `${key} must be an integer from ${min} to ${max}.`, key);
  return Number(value);
};

/**
 * One page of log lines (the lines array, oldest first) for query (URLSearchParams): `since` (exclusive sequence; then
 * the oldest `limit` lines after it, else the newest `limit`), `limit` (default 500), `type` (comma list) and `traceId`.
 * Returns { items, latestSequence, oldestSequence, retained, dropped, retain, more }.
 */
export function logPage(lines, query, { retain, latest, dropped }) {
  const since = integer(query, 'since', 0, Number.MAX_SAFE_INTEGER, 'InvalidLogFilter');
  const limit = integer(query, 'limit', 1, LOG_LIMIT_MAX, 'InvalidLogFilter') ?? LOG_LIMIT;
  const types = (query.get('type') ?? '')
    .split(',')
    .map((type) => type.trim())
    .filter(Boolean);
  const bad = types.find((type) => !LOG_TYPE.test(type));
  if (bad !== undefined)
    throw refused(400, 'InvalidLogFilter', `type names a log line type (got ${JSON.stringify(bad)}).`, 'type');
  const traceId = query.get('traceId')?.trim() || null;
  const matching = lines.filter(
    (line) =>
      (since === null || line.sequence > since) &&
      (!types.length || types.includes(line.type)) &&
      (!traceId || line.traceId === traceId),
  );
  return {
    items: since === null ? matching.slice(-limit) : matching.slice(0, limit),
    latestSequence: latest,
    oldestSequence: lines[0]?.sequence ?? null,
    retained: lines.length,
    dropped,
    retain,
    more: matching.length > limit,
  };
}

/**
 * The exported sources of render-template spans: refs (the `refs` query values, comma lists allowed, at most 100 ids)
 * looked up in a portal source index (portal-source-index.mjs). Returns { sourceDir, items: [{ id, path, file, line,
 * column, kind, name, recordId, field, languageId }], missing }: path is relative to the source folder; line and column
 * (1-based) are null when the file no longer holds the loaded text.
 */
export function resolveRenderSources(index, refs, sourceDir = null) {
  const ids = [
    ...new Set(
      refs
        .flatMap((value) => String(value).split(','))
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length || ids.length > REFS_MAX)
    throw refused(400, 'InvalidRenderSourceRefs', `refs must name 1 to ${REFS_MAX} source ids.`, 'refs');
  const bad = ids.find((id) => !SOURCE_REF.test(id));
  if (bad !== undefined)
    throw refused(
      400,
      'InvalidRenderSourceRefs',
      `refs holds an invalid source id (got ${JSON.stringify(bad)}).`,
      'refs',
    );
  const cache = new Map(),
    items = [],
    missing = [];
  for (const id of ids) {
    const source = index?.sources?.get(id);
    if (!source?.file) {
      missing.push(id);
      continue;
    }
    const root = source.sourceDir ?? sourceDir;
    const target = sourceEditorTarget(source, source.region, cache);
    items.push({
      id,
      path: (root ? path.relative(root, source.file) : path.basename(source.file)).split(path.sep).join('/'),
      file: target?.file ?? source.file,
      line: target?.line ?? null,
      column: target?.column ?? null,
      kind: source.kind ?? null,
      name: source.name || null,
      recordId: source.recordId ?? null,
      field: Array.isArray(source.fieldPath) ? source.fieldPath.join('.') : null,
      languageId: source.languageId ?? null,
    });
  }
  return { sourceDir, items, missing };
}

const instant = (value) => (/^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Date.parse(value));

/**
 * Streams one activity bundle (NDJSON, one document per line, each with `kind`) for query (URLSearchParams: any trace
 * filter, format=bundle, traces=ndjson|otlp, limit): bundle header, activities (`activity` per trace, or one `otlp`
 * document), then the `audit` entries, `log` lines and `finding`s whose traceId is a matched trace, the verification
 * `evidence` reference and an `end` document with the counts. When the filter names nothing but from/to, log lines and
 * findings without a traceId inside that range (startup, load) are included too. deps: { traces, audit, logs(),
 * diagnostics(), evidence() -> Promise<report|null>, runtime() }.
 */
export async function writeActivityBundle(res, query, deps) {
  if (query.get('format') !== 'bundle') throw refused(400, 'InvalidActivityExport', 'format must be bundle.', 'format');
  const traces = query.get('traces') || 'ndjson';
  if (!['ndjson', 'otlp'].includes(traces))
    throw refused(
      400,
      'InvalidActivityExport',
      `traces must be ndjson or otlp (got ${JSON.stringify(traces)}).`,
      'traces',
    );
  // The trace filters are checked (InvalidTraceFilter) before anything is written.
  const { ids, total } = exportedTraceIds(deps.traces, query);
  const matched = new Set(ids);
  const filterKeys = [...new Set(query.keys())].filter((key) => !SHAPING.has(key));
  const timeOnly = filterKeys.every((key) => key === 'from' || key === 'to');
  const from = query.get('from') ? instant(query.get('from')) : null,
    to = query.get('to') ? instant(query.get('to')) : null;
  const inRange = (time) => {
    if (from === null && to === null) return true;
    const at = Date.parse(time);
    return Number.isFinite(at) && (from === null || at >= from) && (to === null || at <= to);
  };
  // An item belongs to the bundle when its trace matched, or (time-only filter) it has no trace and falls in the range.
  const belongs = (item) => (item.traceId ? matched.has(item.traceId) : timeOnly && inRange(item.time));
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
    'content-disposition': 'attachment; filename="simulator-activity-bundle.ndjson"',
    'x-trace-export-matched': String(total),
  });
  const counts = { activities: 0, audit: 0, logs: 0, findings: 0, evidence: 0 };
  const line = (document) => writeChunk(res, `${JSON.stringify(document)}\n`);
  await line({
    kind: 'bundle',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    filters: Object.fromEntries(query),
    traces,
    runtime: deps.runtime(),
  });
  const otlp = [];
  for (const traceId of ids) {
    if (res.destroyed) return;
    const tree = deps.traces.tree(traceId);
    if (!tree) continue; // dropped since the query
    counts.activities++;
    if (traces === 'otlp') otlp.push(...tree.spans.map(otlpSpan));
    else await line({ kind: 'activity', trace: tree.trace, spans: tree.spans });
  }
  if (traces === 'otlp')
    await line({
      kind: 'otlp',
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: 'paqvilo-mirage' } }] },
          scopeSpans: [{ scope: { name: 'paqvilo.mirage.trace' }, spans: otlp }],
        },
      ],
    });
  for (const entry of deps.audit.entries.filter((item) => item.traceId && matched.has(item.traceId))) {
    if (res.destroyed) return;
    counts.audit++;
    await line({ kind: 'audit', entry });
  }
  for (const logLine of deps.logs().filter(belongs)) {
    if (res.destroyed) return;
    counts.logs++;
    await line({ kind: 'log', line: logLine });
  }
  for (const diagnostic of deps.diagnostics().filter(belongs)) {
    if (res.destroyed) return;
    counts.findings++;
    await line({ kind: 'finding', diagnostic });
  }
  const report = await deps.evidence();
  if (report) {
    counts.evidence++;
    await line({
      kind: 'evidence',
      path: report.path ?? null,
      time: report.time ?? null,
      passed: report.passed === true,
      verified: report.verified === true,
      stale: report.stale === true,
      differences: Array.isArray(report.differences) ? report.differences : [],
      artifactUrls: {
        live: '/__sim/evidence/live.png',
        local: '/__sim/evidence/local.png',
        difference: '/__sim/evidence/difference.png',
      },
    });
  }
  res.end(`${JSON.stringify({ kind: 'end', counts })}\n`);
}
