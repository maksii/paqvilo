import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const secret =
  /(?:password|passwd|secret|token|authorization|cookie|credential|api[_-]?key|signature)/i;
const limitText = (value, limit = 12000) => String(value ?? "").slice(0, limit);

/** Keep query structure useful while excluding credential values and headers. */
export function auditText(value, limit = 12000) {
  return String(value ?? "")
    .replace(/Bearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(
      /((?:password|passwd|[\w-]*secret|[\w-]*token|authorization|cookie|credential|api[_-]?key|signature)["']?\s*(?:=|:|\beq\b)\s*)(?:"[^"]*"|'[^']*'|[^\s&<>;,]+)/gi,
      "$1[redacted]",
    )
    .replace(/<condition\b[^>]*(?:\/>|>[\s\S]*?<\/condition>)/gi, (tag) => {
      const attribute = /\battribute\s*=\s*(["'])(.*?)\1/i.exec(tag)?.[2];
      return secret.test(attribute ?? "")
        ? tag
            .replace(/\bvalue\s*=\s*(["'])(.*?)\1/gi, 'value="[redacted]"')
            .replace(/(<value>)[\s\S]*?(<\/value>)/gi, "$1[redacted]$2")
        : tag;
    })
    .slice(0, limit);
}

export function auditQuery(value) {
  if (value instanceof URLSearchParams)
    return Object.fromEntries(
      [...value].map(([key, item]) => [
        key,
        secret.test(key) ? "[redacted]" : auditText(item),
      ]),
    );
  if (typeof value === "string") return auditText(value);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        secret.test(key)
          ? "[redacted]"
          : typeof item === "string"
            ? auditText(item)
            : typeof item === "number" || typeof item === "boolean"
              ? item
              : "[structured value]",
      ]),
  );
}

const pathOnly = (value) => {
  try {
    return new URL(String(value ?? "/"), "http://local.invalid").pathname.slice(
      0,
      600,
    );
  } catch {
    return "/";
  }
};
const positive = (value, fallback, max) =>
  Math.min(max, Math.max(1, Number.parseInt(value, 10) || fallback));
export const AUDIT_KINDS = [
  "api",
  "liquid-fetchxml",
  "form",
  "page",
  "entity-read",
  "entity-query",
];
// Runtime services may add their own lowercase kinds (for example native form services).
const auditKind = (kind) =>
  AUDIT_KINDS.includes(kind) ||
  (typeof kind === "string" && /^[a-z][a-z0-9-]{1,39}$/.test(kind))
    ? kind
    : "api";
const statusMatches = (status, filter) => {
  const value = String(filter ?? "").trim().toLowerCase();
  if (!value) return true;
  if (value === "pending") return status === null;
  if (/^[1-5]xx$/.test(value))
    return Number.isInteger(status) && Math.floor(status / 100) === Number(value[0]);
  return String(status) === value;
};

/** In-memory, bounded trace ledger. It never retains HTTP headers or row bodies. */
export class AuditLog {
  constructor({ limit = 1000 } = {}) {
    this.limit = positive(limit, 1000, 10000);
    this.entries = [];
    this.sequence = 0;
    this.dropped = 0;
    this.listeners = new Set();
  }

  /** Observe completed entries (sanitized copies); returns an unsubscribe function. */
  subscribe(listener) {
    if (typeof listener !== "function")
      throw new TypeError("Audit listeners must be functions.");
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
  } = {}) {
    const started = performance.now();
    const id = randomUUID();
    const entry = {
      id,
      sequence: ++this.sequence,
      correlationId: correlationId || id,
      parentId: parentId ?? null,
      startedAt: new Date().toISOString(),
      kind: auditKind(kind),
      method: limitText(method || "GET", 12).toUpperCase(),
      path: pathOnly(path),
      provider: provider === "live" ? "live" : "local",
      entity: entity ? limitText(entity, 160) : null,
      identity: {
        contactId: limitText(identity?.contactId ?? identity?.id, 100) || null,
        roles: (identity?.roles ?? [])
          .map((role) => auditText(role, 200))
          .slice(0, 100),
      },
      query: auditQuery(query),
      status: null,
      rowCount: null,
      outcome: "pending",
      durationMs: null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
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
      } = {}) => {
        if (completed) return;
        completed = true;
        entry.durationMs =
          Math.round((performance.now() - started) * 100) / 100;
        entry.status = Number.isInteger(status) ? status : 500;
        if (Number.isInteger(rowCount) && rowCount >= 0)
          entry.rowCount = rowCount;
        if (actualProvider)
          entry.provider = actualProvider === "live" ? "live" : "local";
        if (actualEntity) entry.entity = limitText(actualEntity, 160);
        entry.outcome =
          entry.status === 401 || entry.status === 403
            ? "denied"
            : entry.status >= 400
              ? "error"
              : "success";
        if (error || simulatorCode || portalError?.code)
          entry.error = {
            code: auditText(
              error?.code ?? simulatorCode ?? portalError?.code ?? "SIMULATOR_ERROR",
              160,
            ),
            message: auditText(error?.message ?? (typeof error === "string" ? error : portalError?.message ?? ""), 2000),
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
    const get = (key) =>
      filters instanceof URLSearchParams ? filters.get(key) : filters[key];
    const kind = get("kind"),
      provider = get("provider"),
      outcome = get("outcome"),
      status = get("status"),
      method = String(get("method") ?? "").trim().toUpperCase(),
      correlationId = String(get("correlationId") ?? "").trim(),
      lower = (key) => String(get(key) ?? "").trim().toLowerCase(),
      search = lower("search"),
      pathFilter = lower("path"),
      entity = lower("entity");
    return this.entries
      .filter(
        (entry) =>
          (!kind || entry.kind === kind) &&
          (!provider || entry.provider === provider) &&
          (!outcome || entry.outcome === outcome) &&
          statusMatches(entry.status, status) &&
          (!method || entry.method === method) &&
          (!correlationId || entry.correlationId === correlationId) &&
          (!pathFilter || entry.path.toLowerCase().includes(pathFilter)) &&
          (!entity || String(entry.entity ?? "").toLowerCase() === entity) &&
          (!search || JSON.stringify(entry).toLowerCase().includes(search)),
      )
      .slice()
      .reverse();
  }

  list(filters = {}) {
    const get = (key) =>
      filters instanceof URLSearchParams ? filters.get(key) : filters[key];
    const rows = this.filtered(filters),
      pageSize = positive(get("pageSize"), 25, 100);
    const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
    const page = positive(get("page"), 1, pageCount);
    const summary = { success: 0, error: 0, denied: 0, pending: 0 };
    for (const row of this.entries) summary[row.outcome]++;
    return {
      items: structuredClone(
        rows.slice((page - 1) * pageSize, page * pageSize),
      ),
      total: rows.length,
      page,
      pageSize,
      pageCount,
      retained: this.entries.length,
      dropped: this.dropped,
      summary,
      kinds: [
        ...new Set([...AUDIT_KINDS, ...this.entries.map((entry) => entry.kind)]),
      ],
      latestSequence: this.sequence,
    };
  }

  export(filters = {}) {
    return {
      generatedAt: new Date().toISOString(),
      retained: this.entries.length,
      dropped: this.dropped,
      items: structuredClone(this.filtered(filters)),
    };
  }
  clear() {
    this.entries = [];
    this.dropped = 0;
    return this.list();
  }
}
