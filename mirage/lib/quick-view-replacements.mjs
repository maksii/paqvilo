import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sameSendReceipt } from './intentional-abort.mjs';

const quickPath = /^\/_portal\/quickform-template-path\/[0-9a-f-]{36}\/?$/i;
const compatPath = '/xrm-adx/js/crmentityformview.js';
const identityKeys = ['entityid', 'entityname', 'formname', 'controlid'];
const primaryKey = 'entityprimarykeyname';

export function localQuickViewUrl(value, origin) {
  try {
    const url = new URL(value, origin);
    return url.origin === origin && quickPath.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}

/** Identify the script executing the bound startup refresh. Lookup changes have a different stack. */
export function quickViewRefreshCaller(initiator, origin) {
  const calls = initiator?.stack?.callFrames;
  if (initiator?.type !== 'script' || !calls) return null;
  const compat = origin + compatPath;
  // Mirage's local-origin wrapper can appear above the compatibility call that sets the frame URL.
  const start = calls.findIndex((call) => call.functionName === 'refreshQuickView' && call.url === compat);
  if (start < 0) return null;
  const scriptId = calls[start].scriptId;
  const startup = ['refreshQuickViews', 'refreshBound'].every((name, index) => {
    const call = calls[start + index + 1];
    return call?.functionName === name && call.url === compat && call.scriptId === scriptId;
  });
  return startup ? scriptId : null;
}

/** Attribute startup frames to the executable compatibility asset installed with the runner. */
export function observeQuickViewCompatibility(cdp, origin) {
  const scripts = new Map();
  let ready;
  cdp.on('Debugger.scriptParsed', (script) => {
    if (
      script.url === origin + compatPath &&
      script.embedderName === script.url &&
      !script.hasSourceURL &&
      !script.isLiveEdit &&
      script.startLine === 0 &&
      script.startColumn === 0 &&
      script.executionContextAuxData?.isDefault
    )
      scripts.set(script.scriptId, script.hash);
  });
  return {
    consider(url) {
      if (url !== origin + compatPath) return;
      ready ??= Promise.all([
        cdp.send('Debugger.enable'),
        readFile(new URL('./crmentityformview-compat.js', import.meta.url)),
      ])
        .then(([, bytes]) => createHash('sha256').update(bytes).digest('hex'))
        .catch(() => null);
    },
    async verify(rows) {
      const digest = await ready;
      if (!digest) return;
      for (const row of rows) if (scripts.get(row.quickViewScriptId) === digest) row.quickViewRefresh = digest;
    },
  };
}

function bindings(url, withProfile) {
  const params = url.searchParams;
  const names = withProfile ? [...identityKeys, primaryKey, 'isprofilepage', 'lang'] : [...identityKeys, primaryKey];
  if (params.size !== names.length || names.some((name) => params.getAll(name).length !== 1)) return null;
  if (identityKeys.some((name) => !params.get(name))) return null;
  if (withProfile && (params.get('isprofilepage') !== 'false' || !params.get('lang'))) return null;
  return params;
}

function sameBinding(initial, replacement, origin) {
  const url = localQuickViewUrl(replacement.path, origin);
  if (url?.pathname !== initial.pathname) return false;
  const withProfile = initial.searchParams.has('isprofilepage');
  const before = bindings(initial, withProfile);
  const after = bindings(url, false);
  // Bootstrap 5 leaves the primary key name empty when the client rebuilds the URL.
  return (
    before &&
    after &&
    identityKeys.every((name) => before.get(name) === after.get(name)) &&
    ((withProfile && !after.get(primaryKey)) || before.get(primaryKey) === after.get(primaryKey))
  );
}

export function observedQuickViewDocument(request, rows) {
  const matching = [...rows].filter(
    (row) =>
      row.path === request.path &&
      row.method === request.method &&
      row.type === 'Document' &&
      (!request.cdpFrameId || row.frameId === request.cdpFrameId) &&
      sameSendReceipt(request.startedTicks, row.observedTicks),
  );
  if (matching.length === 1) return matching[0];
  // Bootstrap 3 may reissue the browser's exact URL after an encoded space in the markup
  // becomes literal in the iframe attribute. Bind repeated URLs by the response/send the two clients saw.
  const sameResponse = matching.filter(
    (row) =>
      row.status === request.status &&
      (request.serverTraceId
        ? row.serverTraceId === request.serverTraceId
        : request.status === undefined ||
          (request.responseStartTime > 0 && Math.abs(row.responseStartTime - request.responseStartTime) <= 1)),
  );
  return sameResponse.length === 1 ? sameResponse[0] : null;
}

function predecessorOf(request, rows) {
  const row = observedQuickViewDocument(request, rows);
  if (!row) return null;
  if (row.redirected || row.quickViewRefresh || !row.frameId || !row.loaderId || row.finishedTimestamp !== undefined)
    return null;
  if (row.failure && row.failure !== 'net::ERR_ABORTED') return null;
  if (row.status !== undefined && (row.status !== 200 || row.mimeType !== 'text/html')) return null;
  if (
    rows.some(
      (prior) =>
        prior.type === 'Document' && prior.frameId === row.frameId && prior.startedTimestamp < row.startedTimestamp,
    )
  )
    return null;
  return row;
}

function completedReplacement(before, rows) {
  const next = rows.find(
    (row) =>
      row.type === 'Document' && row.frameId === before.frameId && row.startedTimestamp > before.startedTimestamp,
  );
  if (
    !next?.quickViewRefresh ||
    next.method !== 'GET' ||
    next.redirected ||
    !next.loaderId ||
    next.loaderId === before.loaderId ||
    next.status !== 200 ||
    next.mimeType !== 'text/html' ||
    next.failure ||
    next.playwrightFailure ||
    !Number.isFinite(next.finishedTimestamp) ||
    next.finishedTimestamp < next.startedTimestamp
  )
    return null;
  return next;
}

function replacementCommit(before, next, request, rows, events) {
  const frameEvents = events.filter(
    (event) => event.frameId === before.frameId && event.observedTicks >= before.observedTicks,
  );
  const navigation = frameEvents.find((event) => event.event === 'frameRequestedNavigation');
  if (
    navigation?.reason !== 'scriptInitiated' ||
    navigation.path !== next.path ||
    navigation.observedTicks > next.observedTicks
  )
    return null;
  const commit = frameEvents.find(
    (event) => event.event === 'frameNavigated' && event.observedTicks >= navigation.observedTicks,
  );
  if (commit?.loaderId !== next.loaderId || !commit.parentFrameId || commit.observedTicks < next.observedTicks)
    return null;
  if (
    frameEvents.some(
      (event) =>
        event.observedTicks <= commit.observedTicks &&
        (event.event === 'frameDetached' || (event.event === 'frameRequestedNavigation' && event !== navigation)),
    ) ||
    rows.some(
      (row) =>
        row !== before &&
        row !== next &&
        row.type === 'Document' &&
        row.frameId === before.frameId &&
        row.observedTicks >= navigation.observedTicks &&
        row.observedTicks <= commit.observedTicks,
    )
  )
    return null;
  const priorCommits = frameEvents.filter(
    (event) => event.event === 'frameNavigated' && event.observedTicks < navigation.observedTicks,
  );
  if (!priorCommits.length) return sameSendReceipt(request.endedTicks, navigation.observedTicks) ? commit : null;
  const [predecessorCommit] = priorCommits;
  // A committed document can stream until the successor commits. Correlate its abort with that
  // transition, since CDP can omit loadingFailed for the committed predecessor.
  const protocolAgrees =
    before.failure === undefined ||
    (before.failedTimestamp >= next.startedTimestamp &&
      sameSendReceipt(before.failedObservedTicks, commit.observedTicks));
  return priorCommits.length === 1 &&
    predecessorCommit.loaderId === before.loaderId &&
    predecessorCommit.parentFrameId === commit.parentFrameId &&
    before.status === 200 &&
    request.endedTicks >= next.observedTicks &&
    protocolAgrees &&
    sameSendReceipt(request.endedTicks, commit.observedTicks)
    ? commit
    : null;
}

/** Retain the failure and give its verdict an exact same-frame replacement proof. */
export function reconcileQuickViewReplacement(failure, { request, rows, events, origin }) {
  if (
    failure.method !== 'GET' ||
    failure.errorText !== 'net::ERR_ABORTED' ||
    (failure.status !== undefined && failure.status !== 200) ||
    request?.type !== 'document' ||
    request.finished !== false
  )
    return null;
  const initial = localQuickViewUrl(request.path, origin);
  if (!initial) return null;
  const before = predecessorOf(request, rows);
  if (!before) return null;
  const next = completedReplacement(before, rows);
  if (!next || !sameBinding(initial, next, origin)) return null;
  const commit = replacementCommit(before, next, request, rows, events);
  if (!commit) return null;
  return {
    classification: 'bound-quick-view-replaced',
    requestKey: failure.requestKey,
    path: initial.pathname,
    frameId: commit.frameId,
    parentFrameId: commit.parentFrameId,
    entity: initial.searchParams.get('entityname'),
    record: initial.searchParams.get('entityid'),
    form: initial.searchParams.get('formname'),
    control: initial.searchParams.get('controlid'),
    requestId: before.requestId,
    loaderId: before.loaderId,
    status: before.status ?? failure.status ?? null,
    replacement: {
      requestId: next.requestId,
      loaderId: next.loaderId,
      status: next.status,
      committedAt: commit.observedAt,
      compatibilitySha256: next.quickViewRefresh,
    },
  };
}
