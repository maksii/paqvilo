import fs from 'node:fs/promises';

const runtimePhases = new Set([
  'runtime-module-load',
  'runtime-module-ready',
  'context-configuration',
  'context-solution-import',
  'context-portal-import',
  'context-pack-binding',
  'context-ready',
  'configuration',
  'portal-import',
  'solution-import',
  'preset-library',
  'state-restore',
  'state-composition',
  'preset',
  'organization',
  'listener',
  'listener-ready',
]);

/** Read only bounded, explicitly typed progress records; never forward arbitrary child log content. */
export async function readStartupPhases(file, cursor) {
  if (cursor === undefined) cursor = { offset: 0, remainder: '' };
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(cursor.offset, size - 32768);
    const buffer = Buffer.alloc(Math.max(0, Math.min(32768, size - start)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = (
      (start === cursor.offset ? cursor.remainder : '') + buffer.subarray(0, bytesRead).toString('utf8')
    ).split('\n');
    const remainder = lines.pop().slice(-2048);
    if (start > cursor.offset) lines.shift();
    const events = [];
    for (const line of lines) {
      if (line.length > 1024 || !line.startsWith('{')) continue;
      try {
        const value = JSON.parse(line);
        if (
          value.type === 'runtime-startup' &&
          runtimePhases.has(value.phase) &&
          Number.isSafeInteger(value.elapsedMs) &&
          value.elapsedMs >= 0
        )
          events.push({ phase: value.phase, elapsedMs: value.elapsedMs });
      } catch {
        /* other log data is not a progress contract */
      }
    }
    return { events, cursor: { offset: start + bytesRead, remainder } };
  } finally {
    await handle.close();
  }
}

/** Startup diagnostics use stderr, leaving structured command results on stdout. */
export function startupProgress({
  structured = false,
  intervalMs = 5000,
  now = () => performance.now(),
  write = (line) => console.error(line),
} = {}) {
  const started = now();
  let phaseStarted = started,
    phase = 'configuration',
    detail = '',
    closed = false;
  const events = [];
  const emit = (status) => {
    const time = now();
    const event = {
      type: 'startup',
      status,
      phase,
      totalElapsedMs: Math.max(0, Math.round(time - started)),
      phaseElapsedMs: Math.max(0, Math.round(time - phaseStarted)),
      ...(detail ? { detail } : {}),
    };
    // Bound retained diagnostics during a long interactive session.
    if (events.length === 128) events.shift();
    events.push(event);
    if (structured) write(JSON.stringify(event));
    else {
      const detailText = detail ? ` · ${detail}` : '';
      const waitingMark = status === 'waiting' ? '…' : '';
      write(
        `startup     ${phase}${detailText} (${(event.totalElapsedMs / 1000).toFixed(1)}s total; ${(event.phaseElapsedMs / 1000).toFixed(1)}s phase)${waitingMark}`,
      );
    }
  };
  emit('started');
  const timer = setInterval(() => {
    if (!closed) emit('waiting');
  }, intervalMs);
  timer.unref?.();
  return {
    phase(name, description = '') {
      if (closed) return;
      phase = name;
      detail = description;
      phaseStarted = now();
      emit('started');
    },
    complete(description = '') {
      if (closed) return;
      detail = description;
      emit('complete');
      this.close();
    },
    fail(description = '') {
      if (closed) return;
      detail = description;
      emit('failed');
      this.close();
    },
    close() {
      clearInterval(timer);
      closed = true;
    },
    get events() {
      return [...events];
    },
    get elapsedMs() {
      return Math.max(0, now() - started);
    },
  };
}

/** Navigation completion is separate from application readiness; no arbitrary live-page readiness is inferred. */
function startTrackedRequest(state, request) {
  if (!['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch'].includes(request.resourceType())) return;
  let frame = null;
  try {
    frame = request.frame();
  } catch {
    /* Worker/unknown ownership remains pending until its terminal event. */
  }
  const order = ++state.sequence;
  state.requests.set(request, { frame, order });
  if (frame && request.isNavigationRequest?.()) state.navigations.set(frame, order);
  state.idleSince = Date.now();
}

function finishTrackedRequest(state, request) {
  if (state.requests.delete(request)) state.idleSince = Date.now();
}

function commitTrackedFrame(state, frame) {
  const boundary = state.navigations.get(frame);
  if (boundary === undefined) return;
  // A replaced document can lose terminal resource events during CDP interception.
  // Retain its new navigation and every request started afterward, including preloads.
  for (const [request, record] of state.requests)
    if (record.frame === frame && record.order < boundary) state.requests.delete(request);
  state.idleSince = Date.now();
}

function detachTrackedFrame(state, frame) {
  for (const [request, record] of state.requests) if (record.frame === frame) state.requests.delete(request);
  state.navigations.delete(frame);
  state.idleSince = Date.now();
}

async function waitForMirageApplication(page, progress, remaining, cancelledResult) {
  progress?.phase('application data', 'waiting for catalogue, staff identity and initial view');
  const readiness = page
    .waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.mirageAppState), null, {
      timeout: remaining(),
    })
    .then(() => 'application');
  if ((await Promise.race([cancelledResult, readiness])) === 'cancelled') return false;
  const state = await page.evaluate(() => ({
    state: document.documentElement.dataset.mirageAppState,
    message: document.querySelector('#notice')?.textContent,
  }));
  if (state.state === 'error')
    throw new Error(`Application failed to load: ${state.message || 'inspect the application diagnostics'}`);
  progress?.complete('application and initial view usable');
  return true;
}

async function waitForPageResources(page, progress, nativeModelDriven, deadline, timeout, tracking, cancelledResult) {
  progress?.phase(
    'page resources',
    nativeModelDriven
      ? 'waiting for document load; background resources and native application readiness remain unverified'
      : 'waiting for initial resources and data requests; application readiness is unverified',
  );
  const remaining = () => Math.max(1, deadline - Date.now());
  if (
    (await Promise.race([
      cancelledResult,
      page.waitForLoadState('load', { timeout: remaining() }).then(() => 'loaded'),
    ])) === 'cancelled'
  )
    return false;
  // Native model-driven apps continuously fetch data and start workers. Their resource streams are not a readiness protocol.
  while (!nativeModelDriven && (tracking.requests.size || Date.now() - tracking.idleSince < 100)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Initial page requests did not settle within ${timeout}ms; inspect pending requests and sign-in in the browser.`,
      );
    if (
      (await Promise.race([
        cancelledResult,
        new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining()))),
      ])) === 'cancelled'
    )
      return false;
  }
  progress?.complete(
    nativeModelDriven
      ? 'document loaded; background resources, sign-in and native application readiness remain unverified'
      : 'document and initial resources loaded; sign-in and application readiness remain unverified',
  );
  return true;
}

export async function waitForStartupPage(
  page,
  url,
  {
    progress,
    stopped = new Promise(() => {}),
    signal,
    modelDriven = false,
    nativeModelDriven = false,
    timeout = 120000,
  } = {},
) {
  let cancelled = false;
  const deadline = Date.now() + timeout;
  const tracking = { requests: new Map(), navigations: new Map(), idleSince: Date.now(), sequence: 0 };
  const started = (request) => startTrackedRequest(tracking, request);
  const finished = (request) => finishTrackedRequest(tracking, request);
  const committed = (frame) => commitTrackedFrame(tracking, frame);
  const detached = (frame) => detachTrackedFrame(tracking, frame);
  page.on('request', started);
  page.on('requestfinished', finished);
  page.on('requestfailed', finished);
  page.on('framenavigated', committed);
  page.on('framedetached', detached);
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = resolve;
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
  const cancelledResult = Promise.race([stopped, aborted]).then(() => {
    cancelled = true;
    return 'cancelled';
  });
  try {
    if (signal?.aborted) return false;
    progress?.phase('document navigation');
    const navigation = page.goto(url, { waitUntil: 'domcontentloaded', timeout }).then(() => 'document');
    if ((await Promise.race([cancelledResult, navigation])) === 'cancelled') return false;
    if (modelDriven && new URL(page.url()).pathname === '/main.aspx') {
      if (!(await waitForMirageApplication(page, progress, () => Math.max(1, deadline - Date.now()), cancelledResult)))
        return false;
    } else if (
      // Native targets complete document navigation without asserting application usability.
      !(await waitForPageResources(page, progress, nativeModelDriven, deadline, timeout, tracking, cancelledResult))
    ) {
      return false;
    }
    return !cancelled;
  } catch (error) {
    // Browser close can reject an in-flight Playwright wait before its context
    // close event resolves `stopped`; that user action still ends dev normally.
    if (cancelled || page.isClosed?.() || page.context?.()?.browser()?.isConnected() === false) return false;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    page.off('request', started);
    page.off('requestfinished', finished);
    page.off('requestfailed', finished);
    page.off('framenavigated', committed);
    page.off('framedetached', detached);
  }
}
