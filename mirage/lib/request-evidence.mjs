const SCRIPT_OR_STYLE_TYPES = new Set([
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'text/css',
]);

function replacementInRecreatedChild(cdpRecords, frameEvents, currentFrames, before, oldDocument, start) {
  if (!oldDocument || !currentFrames.length || currentFrames.some((row) => row.id === before.frameId)) return null;
  const frame =
    frameEvents.find(
      (row) => row.event === 'frameNavigated' && row.frameId === before.frameId && row.loaderId === before.loaderId,
    ) ??
    frameEvents.find(
      (row) =>
        row.event === 'frameAttached' && row.frameId === before.frameId && Date.parse(row.observedAt) <= start + 1000,
    );
  if (!frame?.parentFrameId) return null;
  const parent = currentFrames.find((row) => row.id === frame.parentFrameId);
  const oldParent = cdpRecords
    .filter(
      (row) =>
        row.type === 'Document' &&
        row.frameId === frame.parentFrameId &&
        Date.parse(row.startedAt) < Date.parse(oldDocument.startedAt),
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  const newParent =
    parent &&
    cdpRecords.find(
      (row) =>
        row.type === 'Document' &&
        row.frameId === parent.id &&
        row.loaderId === parent.loaderId &&
        row.loaderId !== oldParent?.loaderId &&
        Date.parse(row.startedAt) > Date.parse(oldDocument.startedAt) &&
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
      Date.parse(row.startedAt) > Date.parse(newParent.startedAt) &&
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
    JSON.stringify([...(row.roles ?? [])].sort((a, b) => Number(a > b) - Number(a < b))) ===
      JSON.stringify([...(expectedIdentity.roles ?? [])].sort((a, b) => Number(a > b) - Number(a < b)))
  );
}

function auditProof(audit, before, request, parsed, pairs, start, { expectedIdentity, parentTrace }) {
  return (audit?.items ?? []).filter(
    (row) =>
      (!before.serverTraceId || row.id === before.serverTraceId) &&
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
      pairs.every(([name, value]) => row.query[name] === value) &&
      Math.abs(Date.parse(row.startedAt) - start) < 1000,
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
      ? oldDocument &&
        Date.parse(row.startedAt) > Date.parse(oldDocument.startedAt) &&
        row.finishedTimestamp > before.startedTimestamp
      : Date.parse(row.startedAt) > Date.parse(before.startedAt);
  const replacement = cdpRecords
    .filter(
      (row) =>
        row.type === 'Document' &&
        row.frameId === before.frameId &&
        row.loaderId !== before.loaderId &&
        laterDocument(row) &&
        row.status >= 200 &&
        row.status < 300 &&
        row.finishedTimestamp !== undefined &&
        !row.failure,
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  return { oldDocument, replacement };
}

function matchingPendingReads(cdpRecords, request, start) {
  return cdpRecords.filter(
    (row) =>
      row.path === request.path &&
      row.method === request.method &&
      row.finishedTimestamp === undefined &&
      Math.abs(Date.parse(row.startedAt) - start) < 1000,
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
        Date.parse(row.startedAt) > Date.parse(replacement.startedAt) &&
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
      Date.parse(row.startedAt) > Date.parse(replacement.startedAt) &&
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
  request,
  { cdpRecords, audit, origin, identity, frameEvents = [], currentFrames = [] },
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
  const raw = matchingPendingReads(cdpRecords, request, start);
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
      start,
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
  const completed = auditProof(audit, before, request, parsed, pairs, start, { expectedIdentity, parentTrace });
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
