import { requiredArgument } from './required-argument.mjs';
import { sameSendReceipt } from './intentional-abort.mjs';
const SCRIPT_OR_STYLE_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'text/css',
]);

export function recordCdpFailure(record, event, observedTicks = performance.now()) {
  if (!record || Object.hasOwn(record, 'failedObservedTicks')) return;
  Object.defineProperty(record, 'failedObservedTicks', { value: observedTicks });
  record.failure = event.errorText;
  record.failedTimestamp = event.timestamp;
  record.failedAt = Date.parse(record.startedAt) + (event.timestamp - record.startedTimestamp) * 1000;
}

// The start order of two CDP records: the browser's monotonic startedTimestamp when both carry it, so a wall clock stepped
// back (an NTP or WSL time resync) cannot reorder them; otherwise their wallTime startedAt.
const startOrder = (a, b) =>
  Number.isFinite(a.startedTimestamp) && Number.isFinite(b.startedTimestamp)
    ? a.startedTimestamp - b.startedTimestamp
    : Date.parse(a.startedAt) - Date.parse(b.startedAt);
// The latest started record; of equal starts the later recorded one (CDP records arrive in event order).
const latestStarted = (rows) =>
  rows.reduce((latest, row) => (!latest || startOrder(row, latest) >= 0 ? row : latest), undefined);
// Milliseconds from the runner's Playwright request event to a later runner reading of `row` (its receipt of a CDP send, a
// frame event): both on the runner's monotonic clock when both carry it, so a wall clock stepped between the two readings
// cannot move it; otherwise their wall readings.
const sinceRequest = (request, row, ticks, wall) =>
  Number.isFinite(request.startedTicks) && Number.isFinite(row[ticks])
    ? row[ticks] - request.startedTicks
    : Date.parse(row[wall]) - Date.parse(request.startedAt);

function replacementInRecreatedChild(cdpRecords, frameEvents, currentFrames, before, oldDocument, request) {
  if (!oldDocument || !currentFrames.length || currentFrames.some((row) => row.id === before.frameId)) return null;
  const frame =
    frameEvents.find(
      (row) => row.event === 'frameNavigated' && row.frameId === before.frameId && row.loaderId === before.loaderId,
    ) ??
    frameEvents.find(
      (row) =>
        row.event === 'frameAttached' &&
        row.frameId === before.frameId &&
        sinceRequest(request, row, 'observedTicks', 'observedAt') <= 1000,
    );
  if (!frame?.parentFrameId) return null;
  const parent = currentFrames.find((row) => row.id === frame.parentFrameId);
  const oldParent = latestStarted(
    cdpRecords.filter(
      (row) => row.type === 'Document' && row.frameId === frame.parentFrameId && startOrder(row, oldDocument) < 0,
    ),
  );
  const newParent =
    parent &&
    cdpRecords.find(
      (row) =>
        row.type === 'Document' &&
        row.frameId === parent.id &&
        row.loaderId === parent.loaderId &&
        row.loaderId !== oldParent?.loaderId &&
        startOrder(row, oldDocument) > 0 &&
        row.status >= 200 &&
        row.status < 300 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    );
  if (!oldParent || !newParent) return null;
  const children = recreatedChildDocuments(cdpRecords, oldDocument, before, currentFrames, parent, newParent);
  if (children.length !== 1) return null;
  const replacement = children[0];
  return {
    replacement,
    replacedChildFrame: {
      removedFrameId: before.frameId,
      parentFrameId: parent.id,
      parentOldLoaderId: oldParent.loaderId,
      parentNewLoaderId: newParent.loaderId,
      replacementFrameId: replacement.frameId,
      currentFrameTreeObserved: true,
    },
  };
}

function recreatedChildDocuments(cdpRecords, oldDocument, before, currentFrames, parent, newParent) {
  return cdpRecords.filter(
    (row) =>
      row.type === 'Document' &&
      row.path === oldDocument.path &&
      row.method === 'GET' &&
      row.frameId !== before.frameId &&
      currentFrames.some(
        (current) => current.id === row.frameId && current.parentId === parent.id && current.loaderId === row.loaderId,
      ) &&
      startOrder(row, newParent) > 0 &&
      row.status >= 200 &&
      row.status < 300 &&
      row.finishedTimestamp !== undefined &&
      !row.failure,
  );
}

function sameIdentity(row, expectedIdentity) {
  return (
    expectedIdentity &&
    row?.contactId === (expectedIdentity.contactId ?? expectedIdentity.id ?? null) &&
    JSON.stringify([...(row.roles ?? [])].sort()) === // NOSONAR: preserve default string coercion in identity comparison
      JSON.stringify([...(expectedIdentity.roles ?? [])].sort()) // NOSONAR: preserve default string coercion in identity comparison
  );
}

const serverStartGap = (row, request, start, sharedHostClock) =>
  sharedHostClock && Number.isFinite(row.startedHostMs) && Number.isFinite(request.startedHostMs)
    ? row.startedHostMs - request.startedHostMs
    : Date.parse(row.startedAt) - start;

function auditProof(audit, before, request, parsed, pairs, start, { expectedIdentity, parentTrace, sharedHostClock }) {
  return (audit?.items ?? []).filter(
    (row) =>
      // The audit id the browser received with the response headers names the row. Without it the server's and the runner's
      // start readings link the two: on the host's monotonic clock (audit-log.mjs hostMonotonicMs) when the runner proved,
      // for this export, that the server reads the same clock (sharedHostClock), so a wall clock step between them cannot
      // move the difference; else (another VM or time namespace, older audit data) on their wall clocks.
      (before.serverTraceId
        ? row.id === before.serverTraceId
        : Math.abs(serverStartGap(row, request, start, sharedHostClock)) < 1000) &&
      row.method === request.method &&
      row.path === parsed.pathname &&
      row.status >= 200 &&
      row.status < 300 &&
      row.outcome === 'success' &&
      Number.isFinite(row.durationMs) &&
      row.durationMs >= 0 &&
      sameIdentity(row.identity, expectedIdentity) &&
      (!parentTrace || row.parentId === parentTrace) &&
      row.query &&
      typeof row.query === 'object' &&
      !Array.isArray(row.query) &&
      Object.keys(row.query).length === pairs.length &&
      pairs.every(([name, value]) => row.query[name] === value),
  );
}

function withoutCacheBuster(value, origin, expectedOrigin) {
  let url;
  try {
    url = new URL(value, origin);
  } catch {
    return null;
  }
  const buster = url.searchParams.getAll('_');
  if (url.origin !== expectedOrigin || buster.length !== 1 || !/^\d+$/.test(buster[0])) return null;
  url.searchParams.delete('_');
  return url.pathname + url.search;
}

function sourceReplacement(cdpRecords, before) {
  const oldDocument = cdpRecords.find(
    (row) => row.type === 'Document' && row.loaderId === before.loaderId && row.frameId === before.frameId,
  );
  const laterDocument = (row) =>
    Number.isFinite(before.startedTimestamp)
      ? oldDocument && startOrder(row, oldDocument) > 0 && row.finishedTimestamp > before.startedTimestamp
      : startOrder(row, before) > 0;
  const replacement = latestStarted(
    cdpRecords.filter(
      (row) =>
        row.type === 'Document' &&
        row.frameId === before.frameId &&
        row.loaderId !== before.loaderId &&
        laterDocument(row) &&
        row.status >= 200 &&
        row.status < 300 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    ),
  );
  return { oldDocument, replacement };
}

function matchingPendingReads(cdpRecords, request) {
  return cdpRecords.filter(
    (row) =>
      row.path === request.path &&
      row.method === request.method &&
      row.finishedTimestamp === undefined &&
      // Two runner receipts of one send (intentional-abort.mjs sameSendReceipt); older records: 1 s of wall time. The row
      // may be an aborted or abandoned copy of the same read: only the receipt of this request's own send matches.
      (Number.isFinite(request.startedTicks) && Number.isFinite(row.observedTicks)
        ? sameSendReceipt(request.startedTicks, row.observedTicks)
        : Math.abs(Date.parse(row.startedAt) - Date.parse(request.startedAt)) < 1000),
  );
}

function hasFrameIdentity(before) {
  return Boolean(before.loaderId && before.frameId);
}

function staticResourceProof({ base, before, replacement, cdpRecords, origin, parsed, scriptLoad, scriptKey }) {
  if (scriptLoad && !scriptKey) {
    // A portal page read (not /_api/ or form traffic, excluded above) that the replacing
    // document issued again, identically, and completed: the abandoned copy belonged to a
    // document that no longer exists. Its own server completion is not claimed.
    const reissued = cdpRecords.filter(
      (row) =>
        row.path === before.path &&
        row.method === 'GET' &&
        ['XHR', 'Fetch'].includes(row.type) &&
        row.frameId === replacement.frameId &&
        row.loaderId === replacement.loaderId &&
        startOrder(row, replacement) > 0 &&
        row.status >= 200 &&
        row.status < 300 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    );
    if (reissued.length !== 1) return null;
    return {
      ...base,
      proof: 'same-read-reissued',
      resourceType: before.type,
      reissuedRequestId: reissued[0].requestId,
      status: reissued[0].status,
      olderServerCompletionObserved: false,
    };
  }
  const reloaded = cdpRecords.filter(
    (row) =>
      (scriptLoad
        ? withoutCacheBuster(row.path, origin, parsed.origin) === scriptKey &&
          SCRIPT_OR_STYLE_TYPES.has(String(row.mimeType ?? '').toLowerCase())
        : row.path === before.path) &&
      row.method === before.method &&
      row.type === before.type &&
      row.frameId === replacement.frameId &&
      row.loaderId === replacement.loaderId &&
      startOrder(row, replacement) > 0 &&
      row.status >= 200 &&
      row.status < 300 &&
      row.finishedTimestamp !== undefined &&
      !row.failure,
  );
  if (reloaded.length !== 1) return null;
  return {
    ...base,
    proof: 'same-resource-reloaded',
    resourceType: before.type,
    ...(scriptLoad ? { cacheBusterIgnored: '_', reloadedMimeType: reloaded[0].mimeType } : {}),
    reloadedRequestId: reloaded[0].requestId,
    status: reloaded[0].status,
    olderServerCompletionObserved: false,
  };
}

/** Reconcile missing browser final events without claiming response consumption. */
export function reconcileSupersededRead(
  request = requiredArgument('reconcileSupersededRead(request, options)', 'a recorded request'),
  {
    cdpRecords,
    audit,
    origin,
    identity,
    frameEvents = [],
    currentFrames = [],
    sharedHostClock = false,
  } = requiredArgument('reconcileSupersededRead(request, options)', 'an options object with cdpRecords'),
) {
  if (!['GET', 'HEAD'].includes(request.method) || request.completedAt || request.failure || request.stream)
    return null;
  let parsed;
  try {
    parsed = new URL(request.path, origin);
  } catch {
    return null;
  }
  if (parsed.origin !== new URL(origin).origin) return null;
  const pairs = [...parsed.searchParams];
  if (new Set(pairs.map(([name]) => name)).size !== pairs.length) return null;
  const start = Date.parse(request.startedAt);
  if (!Number.isFinite(start)) return null;
  const raw = matchingPendingReads(cdpRecords, request);
  if (raw.length !== 1 || raw[0].failure || raw[0].finishedTimestamp !== undefined) return null;
  const before = raw[0];
  if (!hasFrameIdentity(before)) return null;
  const source = sourceReplacement(cdpRecords, before);
  const { oldDocument } = source;
  let { replacement } = source;
  let replacedChildFrame;
  // A top-level source navigation destroys its child frames. Chromium can omit
  // their terminal Network events (and frameDetached), so require an independent
  // current frame-tree snapshot plus the completed replacement parent and the
  // same child document loaded again under that parent. Never retire a live frame.
  if (!replacement) {
    const childReplacement = replacementInRecreatedChild(
      cdpRecords,
      frameEvents,
      currentFrames,
      before,
      oldDocument,
      request,
    );
    if (childReplacement) {
      replacement = childReplacement.replacement;
      replacedChildFrame = childReplacement.replacedChildFrame;
    }
  }
  if (!replacement) return null;
  const base = {
    outcome: 'superseded',
    bySourceNavigation: true,
    browserFinalEventAbsent: true,
    browserResponseConsumptionObserved: false,
    method: request.method,
    path: request.path,
    requestId: before.requestId,
    oldLoaderId: before.loaderId,
    replacementLoaderId: replacement.loaderId,
    replacementDocument: replacement.path,
    ...(replacedChildFrame ? { replacedChildFrame } : {}),
  };
  const expectedIdentity = request.identity ?? identity;
  const parentTrace = request.parentTrace ?? before.parentTrace;
  const completed = auditProof(audit, before, request, parsed, pairs, start, {
    expectedIdentity,
    parentTrace,
    sharedHostClock,
  });
  if (completed.length === 1) {
    const proof = completed[0];
    return {
      ...base,
      proof: 'exact-server-audit',
      serverAuditId: proof.id,
      parentTrace: proof.parentId,
      correlationId: proof.correlationId,
      status: proof.status,
      durationMs: proof.durationMs,
    };
  }
  // Static resources have no audit span. A completed identical resource in the
  // replacement document proves reloading, not completion of the older read.
  // Resource type, not a filename extension, excludes API/fetch/form traffic.
  // jQuery's script loader ($.getScript, dataType "script") is an XHR with a numeric
  // "_" cache-buster: it qualifies only when the reloaded copy differs by that
  // parameter alone and the server answered that copy as a script or stylesheet.
  const scriptLoad = before.type === 'XHR';
  if (!isStaticResourceRead(before, request, parsed, scriptLoad)) return null;
  const scriptKey = scriptLoad ? withoutCacheBuster(before.path, origin, parsed.origin) : null;
  return staticResourceProof({ base, before, replacement, cdpRecords, origin, parsed, scriptLoad, scriptKey });
}

function isStaticResourceRead(before, request, parsed, scriptLoad) {
  return (
    (['Stylesheet', 'Script', 'Font', 'Image', 'Media'].includes(before.type) || scriptLoad) &&
    request.method === 'GET' &&
    !parsed.pathname.startsWith('/_api/') &&
    !parsed.pathname.startsWith('/__sim/forms/')
  );
}

/** Browser-generated HTTP console messages duplicate their observed HTTP failure.
 * Script console.error calls have arguments and are never covered by this rule. */
export function correlateNetworkConsole(message, failures) {
  if (message?.argumentCount !== 0 || !message.url) return null;
  const status = /^Failed to load resource: the server responded with a status of (\d{3}) \([^)]*\)$/.exec(
    message.text,
  )?.[1];
  if (!status) return null;
  const response = failures.find(
    (row) => row.kind === 'http' && row.url === message.url && row.status === Number(status),
  );
  return response
    ? {
        classification: 'duplicate-browser-http-diagnostic',
        console: message,
        response,
      }
    : null;
}
