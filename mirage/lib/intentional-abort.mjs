/** Observe authored XHR cancellation without changing its return value or timing. */
export function observeReadAborts() {
  const records = new WeakMap();
  const prototype = XMLHttpRequest.prototype;
  const open = prototype.open,
    send = prototype.send,
    abort = prototype.abort;
  prototype.open = function (method, url, ...args) {
    let parsed;
    try {
      parsed = new URL(String(url), location.href);
    } catch {}
    records.set(this, {
      method: String(method).toUpperCase(),
      url: parsed?.href,
    });
    return open.call(this, method, url, ...args);
  };
  prototype.send = function (...args) {
    const record = records.get(this);
    if (record) record.sentAt = Date.now();
    return send.apply(this, args);
  };
  prototype.abort = function (...args) {
    const record = records.get(this);
    if (
      record?.url &&
      ["GET", "HEAD"].includes(record.method) &&
      this.readyState > 0 &&
      this.readyState < 4 &&
      new URL(record.url).origin === location.origin
    ) {
      const observation = {
        ...record,
        at: Date.now(),
        readyState: this.readyState,
        stack: new Error("Authored XHR abort").stack,
      };
      window.__simObserveReadAbort?.(observation).catch(() => {});
    }
    return abort.apply(this, args);
  };
}

/** A portal page answers its slash-less path with a redirect to the trailing-slash
 * page, and the browser records the redirected read under its final path. */
const comparablePath = (value) => String(value ?? "").replace(/\/(?=\?|$)/, "");

/**
 * How far the runner's record of a request (its Node-side Playwright event) may trail the
 * browser's send (CDP requestWillBeSent wallTime). The in-process runtime delays that event:
 * across 1328 XHR/fetch requests of saved acceptance evidence (batches 9-11) the lag was
 * 19 ms median, 395 ms p90, 1567 ms p99 and 1625 ms at most. The event never precedes the
 * send beyond clock granularity. The bound keeps about three times the observed maximum; a
 * read stays unbound when two aborted copies fall inside it.
 */
export const REQUEST_EVENT_LAG = Object.freeze({ beforeMs: 100, afterMs: 5000 });

/** Cancellation is expected only with an observed caller and completed replacement. */
export function reconcileIntentionalReadAbort(
  failure,
  { resources, cdpRecords, sourceAborts, origin },
) {
  if (
    failure.kind !== "network" ||
    failure.errorText !== "net::ERR_ABORTED" ||
    !["GET", "HEAD"].includes(failure.method)
  )
    return null;
  const url = new URL(failure.url, origin);
  if (url.origin !== origin || url.pathname.startsWith("/__sim/")) return null;
  const resource = resources.find(
    (row) => String(row.order) === failure.requestKey,
  );
  if (!resource || resource.type !== "xhr" || resource.finished !== false)
    return null;
  const fullPath = comparablePath(url.pathname + url.search);
  const cancelled = cdpRecords.filter(
    (row) =>
      comparablePath(row.path) === fullPath &&
      row.method === failure.method &&
      row.failure === "net::ERR_ABORTED" &&
      resource.started - Date.parse(row.startedAt) >= -REQUEST_EVENT_LAG.beforeMs &&
      resource.started - Date.parse(row.startedAt) <= REQUEST_EVENT_LAG.afterMs,
  );
  if (cancelled.length !== 1) return null;
  const before = cancelled[0];
  // Network-service cancellation can be delivered after the replacement response,
  // especially with request interception. Match the observed send and actual abort;
  // require terminal-event ordering rather than an arbitrary delivery-time cutoff.
  const observed = sourceAborts.filter(
    (row) =>
      row.url === url.href &&
      row.method === failure.method &&
      row.readyState > 0 &&
      row.readyState < 4 &&
      Math.abs(row.sentAt - Date.parse(before.startedAt)) < 1000 &&
      row.at >= row.sentAt &&
      Number.isFinite(before.failedAt) &&
      before.failedAt >= row.at - 2,
  );
  if (observed.length !== 1) return null;
  const authored = observed[0];
  const scripts = [...String(authored.stack).matchAll(/https?:\/\/[^\s)]+/g)]
    .map((match) => {
      try {
        const value = new URL(match[0].replace(/:\d+(?::\d+)?$/, ""));
        return value.origin === origin ? value.pathname : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const loadedScripts = scripts.filter((script) =>
    cdpRecords.some(
      (row) =>
        row.path === script &&
        row.type === "Script" &&
        Date.parse(row.startedAt) <= authored.at &&
        row.status === 200 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    ),
  );
  if (!loadedScripts.length) return null;
  // Authored reload or polling code (for example DataTables ajax.reload) aborts
  // the read in flight and issues the same read again; later polls may follow, so
  // the earliest completed read after the abort is its replacement.
  const replacements = cdpRecords.filter(
    (row) =>
      comparablePath(row.path) === comparablePath(before.path) &&
      row.method === before.method &&
      row.frameId === before.frameId &&
      row.loaderId === before.loaderId &&
      row.requestId !== before.requestId &&
      Date.parse(row.startedAt) >= authored.at &&
      row.status >= 200 &&
      row.status < 300 &&
      row.finishedTimestamp !== undefined &&
      !row.failure,
  ).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (!replacements.length) return null;
  // Two equally early candidates cannot identify the replacement.
  if (replacements.length > 1 && Date.parse(replacements[1].startedAt) === Date.parse(replacements[0].startedAt)) return null;
  const replacement = replacements.slice(0, 1);
  return {
    classification: "source-cancelled-read",
    requestKey: failure.requestKey,
    requestId: before.requestId,
    url: url.href,
    method: failure.method,
    browserFailure: failure.errorText,
    abort: authored,
    sourceScripts: [...new Set(loadedScripts)],
    replacementRequestId: replacement[0].requestId,
    replacementStatus: replacement[0].status,
    browserResponseConsumptionObserved: false,
  };
}
