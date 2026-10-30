import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const secret = /(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|signature)/i;
// URL query parameters that carry a credential on their own (Azure Functions keys, SAS signatures, OAuth codes).
const queryCredential = /^(?:code|sig)$/i;
const secretQueryKey = (key) => secret.test(key) || queryCredential.test(key);
const limitText = (value, limit = 12000) => String(value ?? '').slice(0, limit);

/** Keep query structure useful while excluding credential values and headers. */
export function auditText(value, limit = 12000) {
  return (
    String(value ?? '')
      .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
      .replace(/\bSharedAccessSignature\s+[^\s"'<>]+/gi, 'SharedAccessSignature [redacted]')
      // A Basic credential is base64: a token holding a digit, + or / or ending in = (so "Basic plan" stays readable).
      .replace(/\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{4,}={0,2}/gi, 'Basic [redacted]')
      .replace(/\bDigest\s+[\w-]+=[^\r\n<>]*/gi, 'Digest [redacted]')
      .replace(/([?&](?:code|sig)=)[^&#\s"'<>]*/gi, '$1[redacted]')
      .replace(
        /((?:password|passwd|[\w-]*secret|[\w-]*token|authorization|cookie|credential|api[_-]?key|signature)["']?\s*(?:=|:|\beq\b)\s*)(?:"[^"]*"|'[^']*'|[^\s&<>;,]+)/gi,
        '$1[redacted]',
      )
      .replace(/<condition\b[^>]*(?:\/>|>[\s\S]*?<\/condition>)/gi, (tag) => {
        const attribute = /\battribute\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
        return secret.test(attribute ?? '')
          ? tag
              .replace(/\bvalue\s*=\s*(["'])(.*?)\1/gi, 'value="[redacted]"')
              .replace(/(<value>)[\s\S]*?(<\/value>)/gi, '$1[redacted]$2')
          : tag;
      })
      .slice(0, limit)
  );
}

export function auditQuery(value) {
  if (value instanceof URLSearchParams)
    return Object.fromEntries(
      [...value].map(([key, item]) => [key, secretQueryKey(key) ? '[redacted]' : auditText(item)]),
    );
  if (typeof value === 'string') return auditText(value);
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        secretQueryKey(key)
          ? '[redacted]'
          : typeof item === 'string'
            ? auditText(item)
            : typeof item === 'number' || typeof item === 'boolean'
              ? item
              : '[structured value]',
      ]),
  );
}

// An id filter of at least 8 hexadecimal characters (after an optional kind: prefix, as in visitor:ad87d220) also
// matches every id it begins (DV-N4-3); an ambiguous prefix matches all of them. The trace store re-exports it.
const ID_PREFIX = /^(?:[a-z]+:)?[0-9a-f]{8}[0-9a-f-]*$/i;
/** True when actual equals wanted, or wanted is an id prefix (8+ hex characters) that actual begins with. */
export const idMatches = (actual, wanted) =>
  actual === wanted || (actual != null && ID_PREFIX.test(wanted) && String(actual).startsWith(wanted));

const pathOnly = (value) => {
  try {
    return new URL(String(value ?? '/'), 'http://local.invalid').pathname.slice(0, 600);
  } catch {
    return '/';
  }
};
const positive = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
// The trace ids one traceId filter may list (a page of Activities joins its audit entries in one call).
const MAX_TRACE_IDS = 200;
const AUDIT_KINDS = ['api', 'liquid-fetchxml', 'form', 'page', 'entity-read', 'entity-query'];
// Runtime services may add their own lowercase kinds (for example native form services).
const auditKind = (kind) =>
  AUDIT_KINDS.includes(kind) || (typeof kind === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(kind)) ? kind : 'api';
const statusMatches = (status, filter) => {
  const value = String(filter ?? '')
    .trim()
    .toLowerCase();
  if (!value) return true;
  if (value === 'pending') return status === null;
  if (/^[1-5]xx$/.test(value)) return Number.isInteger(status) && Math.floor(status / 100) === Number(value[0]);
  return String(status) === value;
};

/** In-memory, bounded trace ledger. It never retains HTTP headers or row bodies. */
export class AuditLog {
  // entityNames(name) -> the lowercase names (logical, entity set) the entity filter stands for; the host sets it.
  constructor({ limit = 1000, entityNames = null } = {}) {
    this.limit = positive(limit, 1000, 10000);
    this.entityNames = entityNames;
    this.entries = [];
    this.index = new Map(); // id -> retained entry, kept in sync with eviction and clear
    this.sequence = 0;
    this.dropped = 0;
    this.listeners = new Set();
  }

  /** The retained entry with this id (the live record, not a copy), or null. */
  byId(id) {
    return (typeof id === 'string' && this.index.get(id)) || null;
  }

  /** Observe completed entries (sanitized copies); returns an unsubscribe function. */
  subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('Audit listeners must be functions.');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  begin({
    kind,
    method,
    path,
    provider,
    identity,
    entity,
    query,
    correlationId,
    parentId,
    traceId,
    spanId,
    activeConfigurationPreset,
    visitorId,
    sessionKey,
  } = {}) {
    const started = performance.now();
    const id = randomUUID();
    const entry = {
      id,
      sequence: ++this.sequence,
      correlationId: correlationId || id,
      parentId: parentId ?? null,
      // The trace-store root span of this request (docs/design/tracing.md), so the audit view links to the trace.
      traceId: traceId ? limitText(traceId, 128) : null,
      spanId: spanId ? limitText(spanId, 128) : null,
      ...(activeConfigurationPreset
        ? {
            activeConfigurationPreset: {
              id: limitText(activeConfigurationPreset.id, 80),
              source: limitText(activeConfigurationPreset.source, 160),
              digest: limitText(activeConfigurationPreset.digest, 64),
            },
          }
        : {}),
      startedAt: new Date().toISOString(),
      kind: auditKind(kind),
      method: limitText(method || 'GET', 12).toUpperCase(),
      path: pathOnly(path),
      provider: provider === 'live' ? 'live' : 'local',
      entity: entity ? limitText(entity, 160) : null,
      identity: {
        contactId: limitText(identity?.contactId ?? identity?.id, 100) || null,
        roles: (identity?.roles ?? []).map((role) => auditText(role, 200)).slice(0, 100),
      },
      // The browser session (D-M-2 Who): the anonymous visitor cookie id, and contact:<id> or visitor:<id> (else null).
      visitorId: visitorId ? limitText(visitorId, 100) : null,
      sessionKey: sessionKey ? limitText(sessionKey, 140) : null,
      query: auditQuery(query),
      status: null,
      rowCount: null,
      outcome: 'pending',
      durationMs: null,
    };
    this.entries.push(entry);
    this.index.set(id, entry);
    if (this.entries.length > this.limit) {
      for (const evicted of this.entries.splice(0, this.entries.length - this.limit)) this.index.delete(evicted.id);
      this.dropped++;
    }
    let completed = false;
    return {
      id,
      correlationId: entry.correlationId,
      finish: ({
        status = 200,
        rowCount,
        error,
        portalError,
        simulatorCode,
        provider: actualProvider,
        entity: actualEntity,
        saveMs,
        saveMode,
      } = {}) => {
        if (completed) return;
        completed = true;
        entry.durationMs = Math.round((performance.now() - started) * 100) / 100;
        if (Number.isFinite(saveMs) && saveMs >= 0) entry.saveMs = Math.round(saveMs * 100) / 100;
        if (['checkpoint', 'journal'].includes(saveMode)) entry.saveMode = saveMode;
        entry.status = Number.isInteger(status) ? status : 500;
        if (Number.isInteger(rowCount) && rowCount >= 0) entry.rowCount = rowCount;
        if (actualProvider) entry.provider = actualProvider === 'live' ? 'live' : 'local';
        if (actualEntity) entry.entity = limitText(actualEntity, 160);
        entry.outcome =
          entry.status === 401 || entry.status === 403 ? 'denied' : entry.status >= 400 ? 'error' : 'success';
        if (error || simulatorCode || portalError?.code)
          entry.error = {
            code: auditText(error?.code ?? simulatorCode ?? portalError?.code ?? 'SIMULATOR_ERROR', 160),
            message: auditText(
              error?.message ?? (typeof error === 'string' ? error : (portalError?.message ?? '')),
              2000,
            ),
          };
        // A documented portal envelope code (for example 90040102) differs from the simulator code.
        if (entry.error && portalError?.code && String(portalError.code) !== entry.error.code)
          entry.error.portalCode = auditText(portalError.code, 160);
        for (const listener of this.listeners) {
          try {
            listener(structuredClone(entry));
          } catch {
            /* an observer failure never affects request handling */
          }
        }
      },
    };
  }

  filtered(filters = {}) {
    const get = (key) => (filters instanceof URLSearchParams ? filters.get(key) : filters[key]);
    const kind = get('kind'),
      provider = get('provider'),
      outcome = get('outcome'),
      status = get('status'),
      method = String(get('method') ?? '')
        .trim()
        .toUpperCase(),
      correlationId = String(get('correlationId') ?? '').trim(),
      traceIds = new Set(
        String(get('traceId') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      ),
      visitorId = String(get('visitorId') ?? '').trim(),
      sessionKey = String(get('sessionKey') ?? '').trim(),
      contactId = String(get('contactId') ?? '')
        .trim()
        .replace(/[{}]/g, '')
        .toLowerCase(),
      lower = (key) =>
        String(get(key) ?? '')
          .trim()
          .toLowerCase(),
      search = lower('search'),
      pathFilter = lower('path'),
      entityValue = lower('entity') || lower('table');
    // A Web API entry names the entity set (x_items), a Liquid read the logical name (x_item): either finds both.
    let entities = null;
    if (entityValue) {
      let names = [entityValue];
      try {
        names = this.entityNames?.(entityValue) ?? names;
      } catch {
        /* an unresolvable name filters as itself */
      }
      entities = new Set(names.map((name) => String(name).toLowerCase()));
    }
    const sequenceBound = (key) => {
      const value = get(key);
      if (value === undefined || value === null || value === '') return null;
      if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)))
        throw Object.assign(new RangeError(`${key} must be a nonnegative safe integer.`), {
          status: 400,
          code: 'InvalidAuditSequence',
        });
      return Number(value);
    };
    if (traceIds.size > MAX_TRACE_IDS)
      throw Object.assign(new RangeError(`traceId names at most ${MAX_TRACE_IDS} trace ids.`), {
        status: 400,
        code: 'InvalidAuditFilter',
        parameter: 'traceId',
      });
    const afterSequence = sequenceBound('afterSequence'),
      throughSequence = sequenceBound('throughSequence');
    return this.entries
      .filter(
        (entry) =>
          (!kind || entry.kind === kind) &&
          (!provider || entry.provider === provider) &&
          (!outcome || entry.outcome === outcome) &&
          statusMatches(entry.status, status) &&
          (!method || entry.method === method) &&
          (!correlationId || entry.correlationId === correlationId) &&
          (!traceIds.size || traceIds.has(entry.traceId)) &&
          (!visitorId || idMatches(entry.visitorId ?? null, visitorId)) &&
          (!sessionKey || idMatches(entry.sessionKey ?? null, sessionKey)) &&
          (!contactId ||
            String(entry.identity.contactId ?? '')
              .replace(/[{}]/g, '')
              .toLowerCase() === contactId) &&
          (afterSequence === null || entry.sequence > afterSequence) &&
          (throughSequence === null || entry.sequence <= throughSequence) &&
          (!pathFilter || entry.path.toLowerCase().includes(pathFilter)) &&
          (!entities || entities.has(String(entry.entity ?? '').toLowerCase())) &&
          (!search || JSON.stringify(entry).toLowerCase().includes(search)),
      )
      .slice()
      .reverse();
  }

  list(filters = {}) {
    const get = (key) => (filters instanceof URLSearchParams ? filters.get(key) : filters[key]);
    const rows = this.filtered(filters),
      pageSize = positive(get('pageSize'), 25, 100);
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = positive(get('page'), 1, pageCount);
    const summary = { success: 0, error: 0, denied: 0, pending: 0 };
    for (const row of this.entries) summary[row.outcome]++;
    return {
      items: structuredClone(rows.slice((page - 1) * pageSize, page * pageSize)),
      total: rows.length,
      page,
      pageSize,
      pageCount,
      retained: this.entries.length,
      dropped: this.dropped,
      summary,
      kinds: [...new Set([...AUDIT_KINDS, ...this.entries.map((entry) => entry.kind)])],
      latestSequence: this.sequence,
      oldestSequence: this.entries[0]?.sequence ?? null,
    };
  }

  export(filters = {}) {
    return {
      generatedAt: new Date().toISOString(),
      retained: this.entries.length,
      dropped: this.dropped,
      latestSequence: this.sequence,
      oldestSequence: this.entries[0]?.sequence ?? null,
      items: structuredClone(this.filtered(filters)),
    };
  }
  clear() {
    this.entries = [];
    this.index.clear();
    this.dropped = 0;
    return this.list();
  }
}
