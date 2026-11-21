/** Observe authored XHR cancellation without changing its return value or timing. */
export function observeReadAborts() {
  const records = new WeakMap();
  const prototype = XMLHttpRequest.prototype;
  const open = prototype.open,
    send = prototype.send,
    abort = prototype.abort;
  // The document's monotonic clock: unlike Date.now() it does not step with the wall clock.
  const ticks = performance.now.bind(performance);
  prototype.open = function (method, url, ...args) {
    let parsed;
    try {
      parsed = new URL(String(url), location.href);
    } catch {
      /* A malformed URL is retained as unknown cancellation context. */
    }
    records.set(this, {
      method: String(method).toUpperCase(),
      url: parsed?.href,
    });
    return open.call(this, method, url, ...args);
  };
  prototype.send = function (...args) {
    const record = records.get(this);
    if (!record) return send.apply(this, args);
    record.sentAt = Date.now();
    // The browser records the request's start inside send(): these two readings bracket it.
    record.sendStartTicks = ticks();
    try {
      return send.apply(this, args);
    } finally {
      record.sendEndTicks = ticks();
    }
  };
  prototype.abort = function (...args) {
    const record = records.get(this);
    if (
      record?.url &&
      ['GET', 'HEAD'].includes(record.method) &&
      this.readyState > 0 &&
      this.readyState < 4 &&
      new URL(record.url).origin === location.origin
    ) {
      const observation = {
        ...record,
        at: Date.now(),
        abortTicks: ticks(),
        readyState: this.readyState,
        stack: new Error('Authored XHR abort').stack,
      };
      globalThis.__simObserveReadAbort?.(observation).catch(() => {});
    }
    return abort.apply(this, args);
  };
}

/** A portal page answers its slash-less path with a redirect to the trailing-slash
 * page, and the browser records the redirected read under its final path. */
const comparablePath = (value) => String(value ?? '').replace(/\/(?=\?|$)/, '');
// The start order of two CDP records: the browser's monotonic startedTimestamp when both carry it, so a wall clock stepped
// back (an NTP or WSL time resync) cannot reorder them; otherwise their wallTime startedAt.
const startOrder = (a, b) =>
  Number.isFinite(a.startedTimestamp) && Number.isFinite(b.startedTimestamp)
    ? a.startedTimestamp - b.startedTimestamp
    : Date.parse(a.startedAt) - Date.parse(b.startedAt);
// Milliseconds from the aborted read's start to another reading of the browser (a record's start, the read's failure): on
// the browser's monotonic clock when both carry it, so a wall clock stepped between the two cannot move it; else wallTime.
const sinceStart = (before, timestamp, wall) =>
  Number.isFinite(timestamp) && Number.isFinite(before.startedTimestamp)
    ? (timestamp - before.startedTimestamp) * 1000
    : wall - Date.parse(before.startedAt);
// Milliseconds from the aborted read's start to the page's abort() on the page's monotonic clock: the browser starts the read
// inside send(), which `bracket` (sendStartTicks before it, sendEndTicks after it) bounds from below or above. Without the
// page's ticks: its wall reading against the read's wallTime.
const abortSinceStart = (abort, before, bracket) =>
  Number.isFinite(abort.abortTicks) && Number.isFinite(abort[bracket])
    ? abort.abortTicks - abort[bracket]
    : abort.at - Date.parse(before.startedAt);
/**
 * How far the runner's record of a request (its Node-side Playwright event) may trail the
 * browser's send (CDP requestWillBeSent wallTime). The in-process runtime delays that event:
 * the measured lag was 19 ms median, 395 ms p90, 1567 ms p99 and 1625 ms at most. The event
 * never precedes the send beyond clock granularity. The bound keeps about three times the
 * observed maximum; a read stays unbound when two aborted copies fall inside it.
 */
export const REQUEST_EVENT_LAG = Object.freeze({ beforeMs: 100, afterMs: 5000 });

/**
 * How far apart the runner's two receipts of one CDP send may lie: its Playwright request event and its own CDP session's
 * requestWillBeSent, both on the runner's monotonic clock (which a wall clock step cannot move). Both arrive through the
 * same connection, so the delivery delay that REQUEST_EVENT_LAG bounds is shared and cancels out. Measured in Edge: idle
 * -0.59 to -0.01 ms over 200 requests, bursts of 10 (x500) -2.11 to -0.12 ms, with CPU burners -2.72 to +0.35 ms. The
 * bound keeps about a hundred times that spread; a copy of the same read sent further apart is another send.
 */
const RECEIPT_SKEW_MS = 250;
/** Whether the runner's request event and its receipt of a CDP send can be receipts of the same send. */
export const sameSendReceipt = (requestTicks, receiptTicks) => Math.abs(requestTicks - receiptTicks) <= RECEIPT_SKEW_MS;

// The runner's request record against a CDP send: its receipt of the send when both carry ticks, else (older records) its
// wall reading against the send's wallTime, which includes the delivery lag REQUEST_EVENT_LAG bounds.
const recordedAfterSend = (resource, row) => {
  if (Number.isFinite(resource.startedTicks) && Number.isFinite(row.observedTicks))
    return sameSendReceipt(resource.startedTicks, row.observedTicks);
  const lag = resource.started - Date.parse(row.startedAt);
  return lag >= -REQUEST_EVENT_LAG.beforeMs && lag <= REQUEST_EVENT_LAG.afterMs;
};

/**
 * The proofs whose browser record (requestId) neither another proof of `proofs` nor an id in `claimed` names: one record
 * proves at most one failure, and two failures bound to the same record (one of them is another request whose own record
 * this session did not see) prove neither.
 */
export function oneProofPerRecord(proofs, claimed = new Set()) {
  const counts = new Map();
  for (const proof of proofs) counts.set(proof.requestId, (counts.get(proof.requestId) ?? 0) + 1);
  return proofs.filter((proof) => counts.get(proof.requestId) === 1 && !claimed.has(proof.requestId));
}

/** Cancellation is expected only with an observed caller and completed replacement. */
export function reconcileIntentionalReadAbort(failure, { resources, cdpRecords, sourceAborts, origin }) {
  if (
    failure.kind !== 'network' ||
    failure.errorText !== 'net::ERR_ABORTED' ||
    !['GET', 'HEAD'].includes(failure.method)
  )
    return null;
  const url = new URL(failure.url, origin);
  if (url.origin !== origin || url.pathname.startsWith('/__sim/')) return null;
  const resource = resources.find((row) => String(row.order) === failure.requestKey);
  if (resource?.type !== 'xhr' || resource.finished !== false) return null;
  const fullPath = comparablePath(url.pathname + url.search);
  const cancelled = cdpRecords.filter(
    (row) =>
      comparablePath(row.path) === fullPath &&
      row.method === failure.method &&
      row.failure === 'net::ERR_ABORTED' &&
      recordedAfterSend(resource, row),
  );
  if (cancelled.length !== 1) return null;
  const before = cancelled[0];
  // Network-service cancellation can be delivered after the replacement response,
  // especially with request interception. Match the observed send and actual abort;
  // require terminal-event ordering rather than an arbitrary delivery-time cutoff.
  // The page's sentAt and the browser's startedAt are the only wall readings compared across processes here: both are taken
  // inside one synchronous send() call (about 0.1 ms apart in Edge), so a clock step can only flip that check by landing
  // inside the call. Every later page reading is measured from that send on the page's monotonic clock, the browser's from
  // that start on its own.
  const observed = sourceAborts.filter(
    (row) =>
      row.url === url.href &&
      row.method === failure.method &&
      row.readyState > 0 &&
      row.readyState < 4 &&
      Math.abs(row.sentAt - Date.parse(before.startedAt)) < 1000 &&
      (Number.isFinite(row.abortTicks) && Number.isFinite(row.sendStartTicks)
        ? row.abortTicks >= row.sendStartTicks
        : row.at >= row.sentAt) &&
      sinceStart(before, before.failedTimestamp, before.failedAt) >= abortSinceStart(row, before, 'sendStartTicks') - 2,
  );
  if (observed.length !== 1) return null;
  const authored = observed[0];
  const scripts = [...String(authored.stack).matchAll(/https?:\/\/[^\s)]+/g)]
    .map((match) => {
      try {
        const value = new URL(match[0].replace(/:\d+(?::\d+)?$/, ''));
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
        row.type === 'Script' &&
        sinceStart(before, row.startedTimestamp, Date.parse(row.startedAt)) <=
          abortSinceStart(authored, before, 'sendEndTicks') &&
        row.status === 200 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    ),
  );
  if (!loadedScripts.length) return null;
  // Authored reload or polling code (for example DataTables ajax.reload) aborts
  // the read in flight and issues the same read again; later polls may follow, so
  // the earliest completed read after the abort is its replacement.
  const replacements = cdpRecords
    .filter(
      (row) =>
        comparablePath(row.path) === comparablePath(before.path) &&
        row.method === before.method &&
        row.frameId === before.frameId &&
        row.loaderId === before.loaderId &&
        row.requestId !== before.requestId &&
        sinceStart(before, row.startedTimestamp, Date.parse(row.startedAt)) >=
          abortSinceStart(authored, before, 'sendEndTicks') &&
        row.status >= 200 &&
        row.status < 300 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    )
    .sort(startOrder);
  if (!replacements.length) return null;
  // Two equally early candidates cannot identify the replacement.
  if (replacements.length > 1 && startOrder(replacements[1], replacements[0]) === 0) return null;
  const replacement = replacements.slice(0, 1);
  return {
    classification: 'source-cancelled-read',
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
