import { observeDocumentCommits } from './document-commits.mjs';
import { simulatorBackgroundRequest } from './simulator-background-requests.mjs';

const read = method => method === 'GET' || method === 'HEAD';
const safeUrl = value => {
  try { const url = new URL(value); return url.origin + url.pathname; }
  catch { return '<invalid URL>'; }
};

/** Observe a project-owned Chromium page without intercepting or altering requests.
 * Attach before navigation. Cancellation is classified only from lifecycle evidence
 * already observed when the failure occurs; later navigation never repairs a failure. */
export async function observePageLifecycle(page, { origin, maxRecords = 10000 } = {}) {
  if (!origin || !['http:', 'https:'].includes(new URL(origin).protocol)) throw new Error('A valid HTTP origin is required.');
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new Error('maxRecords must be a positive integer.');
  const documents = new WeakMap(), records = new Map(), listeners = [];
  let lastActivity = Date.now(), overflow = false, disposed = false, closed = false;
  const frameOf = request => { try { return request.frame(); } catch { return null; } };
  const on = (event, handler) => { page.on(event, handler); listeners.push([event, handler]); };
  const retire = (frame, token, reason) => {
    for (const [request, record] of records) {
      if (record.outcome !== 'pending' || frameOf(request) !== frame || token && record.documentToken !== token || reason === 'document-replaced' && record.type === 'document') continue;
      record.lifecycle = { reason, observedAt: new Date().toISOString() };
      record.outcome = record.status >= 400 ? 'http-failure' : read(record.method) ? 'superseded-read' : 'cancelled-write';
      record.browserCompletionObserved = false;
    }
    lastActivity = Date.now();
  };
  on('request', request => {
    if (records.size >= maxRecords) { overflow = true; return; }
    const record = {
      requestKey: String(records.size + 1), method: request.method(), url: safeUrl(request.url()),
      type: request.resourceType(), startedAt: new Date().toISOString(), outcome: 'pending',
      // Only exact owned read paths are excluded; writes to those paths still count.
      ownedBackground: read(request.method()) && simulatorBackgroundRequest(request.url(), origin),
    };
    Object.defineProperty(record, 'documentToken', { value: documents.get(frameOf(request)) });
    records.set(request, record);
    if (!record.ownedBackground) lastActivity = Date.now();
  });
  on('response', response => {
    const record = records.get(response.request());
    if (record) record.status = response.status();
  });
  on('requestfinished', request => {
    const record = records.get(request);
    if (!record) return;
    record.outcome = record.status >= 400 ? 'http-failure' : 'finished';
    record.browserCompletionObserved = true;
    record.endedAt = new Date().toISOString(); if (!record.ownedBackground) lastActivity = Date.now();
  });
  on('requestfailed', request => {
    const record = records.get(request);
    if (!record) return;
    record.error = request.failure()?.errorText ?? 'Unknown request failure';
    if (read(record.method) && record.error === 'net::ERR_ABORTED' && frameOf(request)?.isDetached())
      record.lifecycle ??= { reason: 'frame-detached', observedAt: new Date().toISOString(), detachedAtFailure: true };
    // A failed live read followed by an unrelated commit remains failed forever.
    // Only an abort after independently observed document removal is superseded.
    record.outcome = read(record.method) && record.lifecycle && record.error === 'net::ERR_ABORTED' && !(record.status >= 400)
      ? 'superseded-read' : 'network-failure';
    record.browserCompletionObserved = false;
    record.endedAt = new Date().toISOString(); if (!record.ownedBackground) lastActivity = Date.now();
  });
  on('framedetached', frame => retire(frame, null, 'frame-detached'));
  on('close', () => {
    closed = true;
    for (const record of records.values()) if (record.outcome === 'pending') {
      record.outcome = 'network-failure'; record.error = 'Page closed before request completed';
      record.browserCompletionObserved = false;
    }
  });
  let cdp, stopDocuments;
  const dispose = async () => {
    if (disposed) return; disposed = true;
    for (const [event, handler] of listeners) page.off(event, handler);
    stopDocuments?.();
    if (cdp) await cdp.detach().catch(() => {});
  };
  try {
    cdp = await page.context().newCDPSession(page);
    stopDocuments = await observeDocumentCommits(page, cdp, {
      document: (frame, token) => documents.set(frame, token),
      commit: (frame, token) => retire(frame, token, 'document-replaced'),
    });
  } catch (error) { await dispose(); throw error; }
  const snapshot = () => {
    const requests = [...records.values()].map(record => ({ ...record, ...(record.lifecycle ? { lifecycle: { ...record.lifecycle } } : {}) }));
    const portal = requests.filter(record => !record.ownedBackground);
    return {
      requests, overflow, disposed, closed,
      pendingRequests: portal.filter(record => record.outcome === 'pending'),
      supersededReads: portal.filter(record => record.outcome === 'superseded-read'),
      failures: portal.filter(record => ['http-failure', 'network-failure', 'cancelled-write'].includes(record.outcome)),
    };
  };
  const settle = async ({ timeout = 5000, quietMs = 100, pollMs = 25 } = {}) => {
    if (![timeout, quietMs, pollMs].every(Number.isFinite) || timeout < 0 || quietMs < 0 || pollMs <= 0) throw new Error('Settling requires nonnegative finite timeout/quietMs and positive pollMs.');
    const started = Date.now(), deadline = started + timeout;
    for (;;) {
      const state = snapshot(), now = Date.now();
      const settled = !state.overflow && !state.disposed && !state.pendingRequests.length && now - lastActivity >= quietMs;
      if (settled || now >= deadline || state.disposed) return { ...state, settled, passed: settled && !state.failures.length, waitedMs: now - started };
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, deadline - now)));
    }
  };
  return { snapshot, settle, dispose };
}

/** Observe existing and future pages in a project-owned Chromium context.
 * Await ready() after creating a page and before navigating it. */
export async function observeContextLifecycle(context, options) {
  const pages = new Map(), observers = new Map(), attaching = new Set(), errors = [];
  let disposed = false, revision = 0;
  const attach = page => {
    if (disposed || pages.has(page)) return;
    const pending = observePageLifecycle(page, options);
    pages.set(page, pending); attaching.add(pending); revision++;
    void pending.then(observer => { observers.set(page, observer); if (disposed) return observer.dispose(); }, error => errors.push(error)).finally(() => attaching.delete(pending));
  };
  context.on('page', attach);
  for (const page of context.pages()) attach(page);
  const ready = async () => {
    while (attaching.size) await Promise.all([...attaching]);
    if (errors.length) throw errors[0];
  };
  const dispose = async () => {
    if (disposed) return; disposed = true; context.off('page', attach);
    await Promise.allSettled([...pages.values()].map(async pending => (await pending).dispose()));
  };
  try { await ready(); } catch (error) { await dispose(); throw error; }
  return {
    ready,
    async settle({ timeout = 5000, quietMs = 100, pollMs = 25 } = {}) {
      if (![timeout, quietMs, pollMs].every(Number.isFinite) || timeout < 0 || quietMs < 0 || pollMs <= 0) throw new Error('Settling requires nonnegative finite timeout/quietMs and positive pollMs.');
      const started = Date.now(), deadline = started + timeout;
      const withinDeadline = async promise => {
        let timer;
        try {
          return await Promise.race([
            promise.then(value => ({ value })),
            new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, deadline - Date.now())); }),
          ]);
        } finally { clearTimeout(timer); }
      };
      const incomplete = async () => ({
        pages: await Promise.all([...observers.values()].map(observer => observer.settle({ timeout: 0, quietMs, pollMs }))),
        pendingAttachments: attaching.size, waitedMs: Date.now() - started, settled: false, passed: false,
      });
      for (;;) {
        if (disposed) return incomplete();
        // Attachment and page settling share one deadline. New pages created while
        // another page is settling must join this observation before it can pass.
        if ((await withinDeadline(ready())).timedOut) return incomplete();
        if (disposed) return incomplete();
        if (attaching.size) { if (Date.now() >= deadline) return incomplete(); continue; }
        const generation = revision;
        const result = await withinDeadline(Promise.all([...observers.values()].map(observer => observer.settle({ timeout: Math.max(0, deadline - Date.now()), quietMs, pollMs }))));
        if (result.timedOut) return incomplete();
        if (errors.length) throw errors[0];
        // A page can become busy again after its own settle completed while a
        // different page was still waiting. Never return those earlier snapshots.
        const current = await Promise.all([...observers.values()].map(observer => observer.settle({ timeout: 0, quietMs, pollMs })));
        if (generation === revision && !attaching.size && current.every(row => row.settled)) return {
          pages: current, pendingAttachments: 0, waitedMs: Date.now() - started,
          settled: !disposed, passed: !disposed && current.every(row => row.passed),
        };
        if (Date.now() >= deadline) return incomplete();
      }
    },
    dispose,
  };
}
