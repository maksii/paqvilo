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

// Start-up page waits end on observed progress. Both limits are hang guards: a page that keeps making progress is
// never failed by the silence guard, and the total cap is the last resort. A message names the guard that fired.
export const STARTUP_PAGE_SILENCE_MS = 120_000;
export const STARTUP_PAGE_CAP_MS = 600_000;

/** The start-up page wait takes its silence guard from `--startup-timeout` when the option is given. */
export function startupWaitOptions(args, options) {
  return { ...options, silenceMs: args['startup-timeout'] === undefined ? undefined : Number(args['startup-timeout']) };
}

/** Only the host of a pending request may appear in a message: paths and query values stay out of it. */
function requestHost(request) {
  try {
    return new URL(request.url()).host || 'unknown';
  } catch {
    /* A request without a parseable URL is summarised as unknown. */
    return 'unknown';
  }
}

function pendingSummary(requests) {
  const count = requests.size;
  const hosts = [...new Set([...requests.values()].map((record) => record.host))].toSorted((a, b) =>
    a.localeCompare(b, 'en'),
  );
  const where = hosts.length ? ` on ${hosts.slice(0, 5).join(', ')}` : '';
  return `${count} pending request${count === 1 ? '' : 's'}${where}`;
}

/** Resolves after `ms`, or as soon as `cancelled` settles; the timer is cleared on either path. */
function pauseUnlessCancelled(ms, cancelled) {
  let timer;
  const elapsed = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([cancelled, elapsed]).finally(() => clearTimeout(timer));
}

// A Playwright timeout on a start-up step is the total cap ending the wait, so the error names the step and the time.
function capStepError(error, { step, capMs, capAt, requests }) {
  if (error?.name !== 'TimeoutError') return error;
  const waited = Date.now() - (capAt - capMs);
  return new Error(
    `Initial page ${step} did not finish: the ${capMs} ms cap guard ended the wait after ${waited} ms with ${pendingSummary(requests)}. This is a hang guard, not a limit on a page that keeps making progress; inspect pending requests and sign-in in the browser.`,
  );
}

/** Throws the guard that fired: silence with requests pending first, then the total cap. */
function throwSettleGuard({ requests, silentSince, settleStarted, silenceMs, capMs, capAt }) {
  const now = Date.now();
  if (requests.size && now - silentSince >= silenceMs)
    throw new Error(
      `Initial page requests made no progress for ${now - silentSince} ms: the ${silenceMs} ms silence guard ended the wait with ${pendingSummary(requests)}. This is a hang guard, not a limit on a page that keeps making progress; inspect pending requests and sign-in in the browser.`,
    );
  if (now >= capAt)
    throw new Error(
      `Initial page requests did not settle: the ${capMs} ms cap guard ended the wait after ${now - settleStarted} ms with ${pendingSummary(requests)}. This is a hang guard, not a limit on a page that keeps making progress; inspect pending requests and sign-in in the browser.`,
    );
}

// A guard that is not a finite positive duration would never fire, or would end the wait at once.
function requirePositiveMs(ms, name) {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${name} must be a positive number of milliseconds.`);
}

/** Navigation completion is separate from application readiness; no arbitrary live-page readiness is inferred. */
/* NOSONAR: preserve request lifecycle and cancellation await boundaries */ export async function waitForStartupPage(
  page,
  url,
  {
    progress,
    stopped = new Promise(() => {}),
    signal,
    modelDriven = false,
    nativeModelDriven = false,
    timeout,
    silenceMs = STARTUP_PAGE_SILENCE_MS,
    capMs = timeout ?? STARTUP_PAGE_CAP_MS,
  } = {},
) {
  requirePositiveMs(silenceMs, 'silenceMs');
  requirePositiveMs(capMs, 'capMs');
  let cancelled = false;
  const capAt = Date.now() + capMs,
    requests = new Map(),
    navigations = new Map();
  let idleSince = Date.now(),
    progressAt = idleSince,
    sequence = 0;
  const started = (request) => {
    progressAt = Date.now();
    if (!['document', 'script', 'stylesheet', 'image', 'font', 'xhr', 'fetch'].includes(request.resourceType())) return;
    let frame = null;
    try {
      frame = request.frame();
    } catch {
      /* Worker/unknown ownership remains pending until its terminal event. */
    }
    const order = ++sequence;
    requests.set(request, { frame, order, host: requestHost(request) });
    if (frame && request.isNavigationRequest?.()) navigations.set(frame, order);
    idleSince = Date.now();
  };
  const finished = (request) => {
    progressAt = Date.now();
    if (requests.delete(request)) idleSince = Date.now();
  };
  const committed = (frame) => {
    const boundary = navigations.get(frame);
    if (boundary === undefined) return;
    // A replaced document can lose terminal resource events during CDP interception.
    // Retain its new navigation and every request started afterward, including preloads.
    for (const [request, record] of requests)
      if (record.frame === frame && record.order < boundary) requests.delete(request);
    idleSince = Date.now();
  };
  const detached = (frame) => {
    for (const [request, record] of requests) if (record.frame === frame) requests.delete(request);
    navigations.delete(frame);
    idleSince = Date.now();
  };
  const remaining = () => Math.max(1, capAt - Date.now());
  const stepFailed = (step) => (error) => {
    throw capStepError(error, { step, capMs, capAt, requests });
  };
  // Closing the browser is the user's stop at any step; the context's close event is the signal for it.
  const context = page.context?.();
  let contextClosed = false;
  const onContextClose = () => {
    contextClosed = true;
  };
  context?.on?.('close', onContextClose);
  const browserGone = () => contextClosed || context?.browser?.()?.isConnected?.() === false;
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
    const navigation = page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() })
      .then(() => 'document', stepFailed('navigation'));
    if ((await Promise.race([cancelledResult, navigation])) === 'cancelled') return false;
    if (modelDriven && new URL(page.url()).pathname === '/main.aspx') {
      progress?.phase('application data', 'waiting for catalogue, staff identity and initial view');
      const readiness = page
        .waitForFunction(() => ['ready', 'error'].includes(document.documentElement.dataset.mirageAppState), null, {
          timeout: remaining(),
        })
        .then(() => 'application', stepFailed('application readiness'));
      if ((await Promise.race([cancelledResult, readiness])) === 'cancelled') return false;
      const state = await page.evaluate(() => ({
        state: document.documentElement.dataset.mirageAppState,
        message: document.querySelector('#notice')?.textContent,
      }));
      if (state.state === 'error')
        throw new Error(`Application failed to load: ${state.message || 'inspect the application diagnostics'}`);
      progress?.complete('application and initial view usable');
    } else {
      progress?.phase(
        'page resources',
        nativeModelDriven
          ? 'waiting for document load; background resources and native application readiness remain unverified'
          : 'waiting for initial resources and data requests; application readiness is unverified',
      );
      if (
        (await Promise.race([
          cancelledResult,
          page.waitForLoadState('load', { timeout: remaining() }).then(() => 'loaded', stepFailed('load')),
        ])) === 'cancelled'
      )
        return false;
      // Native model-driven apps continuously fetch data and start workers. Their
      // resource streams are not a readiness protocol (and CDP can omit worker
      // terminal events). Only Mirage exposes the explicit app-state contract.
      // A native target completes document navigation without asserting usability.
      const settleStarted = Date.now();
      while (!nativeModelDriven && (requests.size || Date.now() - idleSince < 100)) {
        // A closed page is a stop: the caller reports it and the command ends normally.
        if (page.isClosed?.()) return false;
        throwSettleGuard({
          requests,
          silentSince: Math.max(progressAt, settleStarted),
          settleStarted,
          silenceMs,
          capMs,
          capAt,
        });
        if ((await pauseUnlessCancelled(Math.min(50, capAt - Date.now()), cancelledResult)) === 'cancelled')
          return false;
      }
      progress?.complete(
        nativeModelDriven
          ? 'document loaded; background resources, sign-in and native application readiness remain unverified'
          : 'document and initial resources loaded; sign-in and application readiness remain unverified',
      );
    }
    return !cancelled;
  } catch (error) {
    // A browser or page close rejects an in-flight Playwright wait, and the page can report closed before its context
    // reports its own close. Either is the user's stop.
    if (cancelled || browserGone() || page.isClosed?.()) return false;
    throw error;
  } finally {
    context?.off?.('close', onContextClose);
    signal?.removeEventListener('abort', onAbort);
    page.off('request', started);
    page.off('requestfinished', finished);
    page.off('requestfailed', finished);
    page.off('framenavigated', committed);
    page.off('framedetached', detached);
  }
}
