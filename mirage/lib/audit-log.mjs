import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const secret =
  /(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|signature|pwd|accountkey|sharedaccesskey(?!name)|primarykey|secondarykey|subscription[_-]?key|functions?[_-]?key)/i;
// URL query parameters that carry a credential on their own (Azure Functions keys, SAS signatures, OAuth codes,
// invitation codes). One alternation feeds the key test and the free-text pattern, so the two cannot drift.
const queryCredentialNames = 'code|sig|invitation(?:code)?';
const queryCredential = new RegExp(`^(?:${queryCredentialNames})$`, 'i');
// The separator before a query credential is ?, & or an encoded or HTML-escaped & (%26, &amp;, &#38;).
const queryCredentialValue = new RegExp(
  String.raw`((?:[?&]|%26|&amp;|&#38;)(?:${queryCredentialNames})=)[^&#\s"'<>]*`,
  'gi',
);
const secretQueryKey = (key) => secret.test(key) || queryCredential.test(key);
// One name=value pair of a query string, redacted by the same key test as the URLSearchParams form.
const redactQueryPair = (pair) => {
  const equals = pair.indexOf('=');
  const name = equals < 0 ? '' : pair.slice(0, equals);
  return name && secretQueryKey(name.replace(/^\?/, '')) ? `${name}=[redacted]` : pair;
};
const limitText = (value, limit = 12000) => String(value ?? '').slice(0, limit);

// The variable-length prefix of secret/token names is scanned backwards only after a
// complete key/value match. This keeps malformed long identifiers linear. A quoted value without its closing quote
// runs to the end of the text. A key or value quoted as an HTML entity (&quot; or &#34;) is matched like a quoted one.
const secretAssignment =
  /((password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|signature|pwd|accountkey|sharedaccesskey|primarykey|secondarykey|subscription[_-]?key|functions?[_-]?key)(?:["']|&quot;|&#34;)?\s*(?:=|:|\beq\b)\s*)(?:"[^"]*"|'[^']*'|"[^"]*|'[^']*|&quot;[\s\S]*?(?:&quot;|$)|&#34;[\s\S]*?(?:&#34;|$)|[^\s&<>;,]+)/gi; // NOSONAR: preserve the exact grammar and captured values

function redactSecretAssignments(text) {
  let cursor = 0;
  let result = '';
  for (const match of text.matchAll(secretAssignment)) {
    let start = match.index;
    if (/^(?:secret|token)$/i.test(match[2])) {
      while (start > cursor && /[\w-]/.test(text[start - 1])) start--;
    }
    result += text.slice(cursor, start) + text.slice(start, match.index) + match[1] + '[redacted]';
    cursor = match.index + match[0].length;
  }
  return result + text.slice(cursor);
}

const CONDITION_OPEN = /<condition(?!\w)/gi;
const CONDITION_CLOSE = /<\/condition>/gi;
const CONDITION_CLOSE_TEXT = '</condition>';
const CONDITION_CLOSE_LENGTH = CONDITION_CLOSE_TEXT.length;
const VALUE_CLOSE = /<\/value>/gi;

// Index of the first match of a global pattern at or after from, or -1.
const indexFrom = (pattern, text, from) => {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index : -1;
};

// Wraps a search whose start positions never decrease: a result ahead of the start is reused, and -1 is final.
const cachedSearch = (search) => {
  let found = null;
  return (from) => {
    if (found === -1) return -1;
    if (found === null || found < from) found = search(from);
    return found;
  };
};

const conditionAttribute = (tag) => /\battribute\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
const secretCondition = (tag) => secret.test(conditionAttribute(tag) ?? '');

// A secret value of a condition's text: a <value> element, or a value="…" / value='…' attribute.
const SECRET_VALUE = /<value>|\bvalue\s*=\s*(["'])/gi;
const nextSecretValue = (body, from) => {
  SECRET_VALUE.lastIndex = from;
  return SECRET_VALUE.exec(body);
};

// One secret value found by match: its replacement and the index where the text resumes. A closed element keeps its
// closing tag; an attribute is written whole; a value without its closing mark runs to the end of the body.
function secretValueEnd(body, match) {
  const start = match.index + match[0].length;
  if (match[1] === undefined) {
    const close = indexFrom(VALUE_CLOSE, body, start);
    return { replacement: `${match[0]}[redacted]`, resume: close < 0 ? body.length : close };
  }
  const close = body.indexOf(match[1], start);
  if (close < 0) return { replacement: 'value="[redacted]', resume: body.length };
  return { replacement: 'value="[redacted]"', resume: close + 1 };
}

// Redacts every secret value in a condition's text, closed or not: one pass, the search resumes after each value.
function redactSecretValues(body) {
  let result = '';
  let cursor = 0;
  for (let match = nextSecretValue(body, 0); match; match = nextSecretValue(body, cursor)) {
    const { replacement, resume } = secretValueEnd(body, match);
    result += body.slice(cursor, match.index) + replacement;
    cursor = resume;
  }
  return result + body.slice(cursor);
}

const redactCondition = (tag) => {
  if (!secretCondition(tag)) return tag;
  const tail = tag.endsWith(CONDITION_CLOSE_TEXT) ? CONDITION_CLOSE_TEXT : '';
  return redactSecretValues(tag.slice(0, tag.length - tail.length)) + tail;
};

// The end of the tag whose ">" is at gt: the first "</condition>" after it, else the end of a self-closing "/>", else -1.
const conditionEnd = (text, gt, nextClose) => {
  const close = nextClose(gt + 1);
  if (close >= 0) return close + CONDITION_CLOSE_LENGTH;
  return text[gt - 1] === '/' ? gt + 1 : -1;
};

// An unclosed condition at open runs to the next condition tag, or to the end of the text: when its tag (up to gt, or
// to the scope's end without a ">") names a secret attribute, all of its secret values are redacted. Else null.
const redactUnclosedCondition = (text, open, gt, stop) => {
  const head = text.slice(open, gt < 0 ? stop : Math.min(gt + 1, stop));
  return secretCondition(head) ? redactSecretValues(text.slice(open, stop)) : null;
};

// One pass over the condition tags. Each search is cached and each unclosed scope ends at the next condition tag, so the
// scopes never overlap and a run of unclosed tags costs one pass over the text.
function redactConditions(text) {
  const nextGt = cachedSearch((from) => text.indexOf('>', from));
  const nextClose = cachedSearch((from) => indexFrom(CONDITION_CLOSE, text, from));
  let result = '';
  let cursor = 0;
  let open = indexFrom(CONDITION_OPEN, text, 0);
  while (open >= 0) {
    const gt = nextGt(open);
    const end = gt < 0 ? -1 : conditionEnd(text, gt, nextClose);
    if (end >= 0) {
      result += text.slice(cursor, open) + redactCondition(text.slice(open, end));
      cursor = end;
      open = indexFrom(CONDITION_OPEN, text, end);
      continue;
    }
    const next = indexFrom(CONDITION_OPEN, text, open + 1);
    const stop = next < 0 ? text.length : next;
    const redacted = redactUnclosedCondition(text, open, gt, stop);
    if (redacted !== null) {
      result += text.slice(cursor, open) + redacted;
      cursor = stop;
    }
    open = next;
  }
  return result + text.slice(cursor);
}

function redactText(text) {
  const prefix = text
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/\bSharedAccessSignature\s+[^\s"'<>]+/gi, 'SharedAccessSignature [redacted]')
    // A Basic credential is base64: a token holding a digit, + or / or ending in = (so "Basic plan" stays readable).
    .replace(/\bBasic\s+(?=[a-z0-9+/]*[0-9+/=])[a-z0-9+/]{4,}={0,2}/gi, 'Basic [redacted]')
    .replace(/\bDigest\s+[\w-]+=[^\r\n<>]*/gi, 'Digest [redacted]')
    .replace(queryCredentialValue, '$1[redacted]');
  return redactConditions(redactSecretAssignments(prefix));
}

/** Keep query structure useful while excluding credential values and headers. */
export function auditText(value, limit = 12000) {
  return redactText(String(value ?? '')).slice(0, limit);
}

/* NOSONAR: mixed return values are part of the contract */ export function auditQuery(value) {
  if (value instanceof URLSearchParams)
    return Object.fromEntries(
      [...value].map(([key, item]) => [key, secretQueryKey(key) ? '[redacted]' : auditText(item)]),
    );
  if (typeof value === 'string') return auditText(value).split('&').map(redactQueryPair).join('&');
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [key, secretQueryKey(key) ? '[redacted]' : auditStructuredItem(item)]),
  );
}

/* NOSONAR: mixed return values are part of the contract */ function auditStructuredItem(item) {
  if (typeof item === 'string') return auditText(item);
  if (typeof item === 'number' || typeof item === 'boolean') return item;
  return '[structured value]';
}

// An id filter of at least 8 hexadecimal characters (after an optional kind: prefix, as in visitor:ad87d220) also
// matches every id it begins (DV-N4-3); an ambiguous prefix matches all of them. The trace store re-exports it.
const ID_PREFIX = /^(?:[a-z]+:)?[0-9a-f]{8}[0-9a-f-]*$/i;
/** True when actual equals wanted, or wanted is an id prefix (8+ hex characters) that actual begins with. */
export const idMatches = (actual, wanted) =>
  actual === wanted || (actual != null && ID_PREFIX.test(wanted) && String(actual).startsWith(wanted));

const pathOnly = (value) => {
  try {
    return new URL(String(value ?? '/'), 'http://local.invalid').pathname.slice(0, 600); // NOSONAR: reserved or loopback placeholder host, not a real transport
  } catch {
    return '/';
  }
};
const positive = (value, fallback, max) => Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
// The trace ids one traceId filter may list (a page of Activities joins its audit entries in one call).
const MAX_TRACE_IDS = 200;
const AUDIT_KINDS = new Set(['api', 'liquid-fetchxml', 'form', 'page', 'entity-read', 'entity-query']);
// Runtime services may add their own lowercase kinds (for example native form services).
const auditKind = (kind) =>
  AUDIT_KINDS.has(kind) || (typeof kind === 'string' && /^[a-z][a-z0-9-]{1,39}$/.test(kind)) ? kind : 'api';
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
      status: /** @type {number | null} */ (null),
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
      } = {}) => /* NOSONAR: single-pass routine, splitting it would change shared state */ {
        if (completed) return;
        completed = true;
        entry.durationMs = Math.round((performance.now() - started) * 100) / 100;
        if (Number.isFinite(saveMs) && saveMs >= 0) entry.saveMs = Math.round(saveMs * 100) / 100;
        if (['checkpoint', 'journal'].includes(saveMode)) entry.saveMode = saveMode;
        entry.status = Number.isInteger(status) ? status : 500;
        if (Number.isInteger(rowCount) && rowCount >= 0) entry.rowCount = rowCount;
        if (actualProvider) entry.provider = actualProvider === 'live' ? 'live' : 'local';
        if (actualEntity) entry.entity = limitText(actualEntity, 160);
        if (entry.status === 401 || entry.status === 403) entry.outcome = 'denied';
        else entry.outcome = entry.status >= 400 ? 'error' : 'success';
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
    const filter = {
      kind,
      provider,
      outcome,
      status,
      method,
      correlationId,
      traceIds,
      visitorId,
      sessionKey,
      contactId,
      afterSequence,
      throughSequence,
      pathFilter,
      entities,
      search,
    };
    return this.entries
      .filter((entry) => matchesAuditEntry(entry, filter))
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

function matchesAuditEntry(entry, filter) {
  const {
    kind,
    provider,
    outcome,
    status,
    method,
    correlationId,
    traceIds,
    visitorId,
    sessionKey,
    contactId,
    afterSequence,
    throughSequence,
    pathFilter,
    entities,
    search,
  } = filter;
  return (
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
    (!search || JSON.stringify(entry).toLowerCase().includes(search))
  );
}
