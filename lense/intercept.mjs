// Request interception on the DevTools protocol. Each paused request is answered by this module,
// including handler failures, without relying on another network event to complete the route.
import { refreshUrl } from './navigation.mjs';
const RESOURCE_TYPES = { XHR: 'xhr', Fetch: 'fetch', Document: 'document', Stylesheet: 'stylesheet', Script: 'script', Image: 'image', Font: 'font', Media: 'media' };

// set by the browser or recomputed for the body that is actually sent
const NOT_FORWARDED = new Set(['cookie', 'host', 'content-length', 'connection']);
const NOT_REPLAYED = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
const STALE_AFTER_EDIT = new Set(['etag', 'last-modified', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'cache-control', 'expires']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// A DevTools command sent while a tab swaps documents can go unanswered; setup and release must still end.
const CDP_SETUP_MS = 10_000;
const CDP_RELEASE_MS = 5_000;

/** Resolves with true when `promise` settles within `ms`, or false when it does not. */
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(resolve, ms, false); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Sends the portal requests of every tab of `context` through `handler`, which gets an object with
 * the parts of a Playwright Route it needs: request(), fetch(), fulfill(), fallback(), abort().
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} origin only requests to this origin are intercepted
 * @param {(route: object) => Promise<void>} handler
 * @param {{bypassCSP?: boolean, onError?: (error: Error) => void}} [options] report failures on later tabs
 * @returns {Promise<() => Promise<void>>} releases this overlay's interception sessions
 */
export async function interceptOrigin(context, origin, handler, options = {}) {
  return interceptOrigins(context, [origin], handler, options);
}

/** One CDP attachment per tab, routing all configured origins without competing Fetch handlers. */
export async function interceptOrigins(context, origins, handler, { bypassCSP = false, onError = (error) => console.error(error.message) } = {}) {
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  if (!allowed.size) throw new Error('At least one portal origin is required');
  const matches = (url) => { try { return allowed.has(new URL(url).origin); } catch { return false; } };
  const attached = new WeakSet();
  const sessions = new Map();
  const pendingAttachments = new Set();
  const pendingClosures = new Set();
  const activeRoutes = new Set();
  let stopped = false;
  let disposal;
  const release = (record) => {
    if (record.closing) return record.closing;
    record.closed = true;
    sessions.delete(record.cdp);
    record.page.off('close', record.onClose);
    if (record.late) record.page.off('domcontentloaded', record.late);
    record.cdp.off('Fetch.requestPaused', record.onPaused);
    record.closing = (async () => {
      // Each DevTools answer is bounded: an unanswered command must not keep the release waiting.
      const step = async (label, action) => {
        if (!(await settlesWithin(action(), CDP_RELEASE_MS))) onError(new Error(`Releasing development interception: ${label} did not answer within ${CDP_RELEASE_MS} ms`));
      };
      // Abort before disabling interception, so an in-flight POST cannot be resumed and repeated.
      await step('pending requests', () => Promise.allSettled([...record.routes].map(async (route) => {
        activeRoutes.delete(route);
        await route.abort();
        await route.disposeResponses();
      })));
      record.routes.clear();
      const restore = [['Fetch.disable', {}], ['Network.setCacheDisabled', { cacheDisabled: false }]];
      if (bypassCSP) restore.push(['Page.setBypassCSP', { enabled: false }]);
      for (const [method, params] of restore) await step(method, () => record.cdp.send(method, params));
      await step('detach', () => record.cdp.detach?.());
    })();
    pendingClosures.add(record.closing);
    record.closing.finally(() => pendingClosures.delete(record.closing)).catch(() => {});
    return record.closing;
  };
  const attach = async (page) => {
    if (stopped || attached.has(page)) return;
    attached.add(page);
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
    } catch (error) {
      if (stopped || page.isClosed()) return;
      throw new Error(`Could not attach development interception: ${error.message}`, { cause: error });
    }
    if (stopped || page.isClosed()) { await cdp.detach?.().catch(() => {}); return; }
    const record = { page, cdp, routes: new Set(), closed: false };
    sessions.set(cdp, record);
    let mainFrameId = null;
    let sawDocument = false;
    record.onPaused = (event) => {
      const isMainDocument = event.resourceType === 'Document' && (mainFrameId === null || event.frameId === mainFrameId);
      if (isMainDocument) sawDocument = true;
      const route = makeRoute({ cdp, context, page, event, isMainDocument });
      activeRoutes.add(route);
      record.routes.add(route);
      // whatever the handler does or fails to do, the request is not left paused
      Promise.resolve()
        .then(() => stopped || record.closed ? route.abort() : matches(event.request.url) ? handler(route) : route.fallback())
        .catch(() => {})
        .then(() => route.answered || route.fallback())
        .finally(async () => {
          activeRoutes.delete(route);
          record.routes.delete(route);
          await route.disposeResponses();
        })
        .catch(() => {});
    };
    cdp.on('Fetch.requestPaused', record.onPaused);
    record.onClose = () => { release(record).catch(() => {}); };
    page.once('close', record.onClose);
    const configure = async (method, params) => {
      if (stopped || record.closed) throw new Error('Browser page closed during interception setup');
      let timer;
      try {
        return await Promise.race([cdp.send(method, params), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} did not answer within ${CDP_SETUP_MS} ms`)), CDP_SETUP_MS); })]);
      } finally { clearTimeout(timer); }
    };
    try {
      mainFrameId = (await configure('Page.getFrameTree')).frameTree.frame.id;
      // CSP remains enforced unless explicitly disabled for this development session.
      if (bypassCSP) await configure('Page.setBypassCSP', { enabled: true });
      // A file the browser has cached from the online site would not be asked for again when its
      // local version comes into play (scope 'changed': the moment you first edit it).
      await configure('Network.enable');
      await configure('Network.setCacheDisabled', { cacheDisabled: true });
      await configure('Fetch.enable', { patterns: [...allowed].map((origin) => ({ urlPattern: `${origin}/*` })) });
    } catch (error) {
      const pageClosed = stopped || record.closed || page.isClosed();
      await release(record);
      if (pageClosed) return;
      throw new Error(`Could not enable development interception: ${error.message}`, { cause: error });
    }
    if (record.closed || stopped) { await release(record); return; }
    // A tab opened by the portal (target=_blank, window.open) may have asked for its page before
    // interception was on. Load that page once more so it gets the local sources too.
    const late = () => {
      if (stopped || sawDocument || page.isClosed() || !matches(page.url())) return;
      sawDocument = true;
      // A late popup may have been opened by a submitted form. Retry with GET, never replay POST.
      page.goto(refreshUrl(page.url()), { waitUntil: 'commit', timeout: 60_000 }).catch(() => {});
    };
    record.late = late;
    page.once('domcontentloaded', late);
    if (matches(page.url())) late();
  };
  const startAttachment = (page, initial = false) => {
    const pending = attach(page);
    pendingAttachments.add(pending);
    pending.then(() => pendingAttachments.delete(pending), (error) => {
      pendingAttachments.delete(pending);
      if (!initial && !stopped) {
        // EventEmitter does not await page handlers. Observe callback failures too, so a
        // reporting callback cannot turn a tab setup error into an unhandled rejection.
        Promise.resolve().then(() => onError(error)).catch(() => {});
      }
    });
    return pending;
  };
  const onPage = (page) => { startAttachment(page); };
  const dispose = () => {
    if (disposal) return disposal;
    stopped = true;
    context.off('page', onPage);
    disposal = (async () => {
      await Promise.allSettled([...pendingAttachments]);
      await Promise.allSettled([...sessions.values()].map(release));
      await Promise.allSettled([...pendingClosures]);
      activeRoutes.clear();
    })();
    return disposal;
  };
  context.on('page', onPage);
  try {
    await Promise.all(context.pages().map((page) => startAttachment(page, true)));
    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}

function makeRoute({ cdp, context, page, event, isMainDocument }) {
  const { requestId, request } = event;
  let fetched = false;
  const responses = new Set();
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const send = (method, params) => {
    if (route.answered) return Promise.resolve();
    route.answered = true;
    // the tab may have moved on or closed; nothing is waiting for the answer then
    return cdp.send(method, { requestId, ...params }).catch(() => {});
  };
  /** The body the browser sends with the request, or undefined. */
  const postData = async () => {
    if (request.postDataEntries?.length && request.postDataEntries.every((entry) => typeof entry.bytes === 'string')) {
      return Buffer.concat(request.postDataEntries.map((entry) => Buffer.from(entry.bytes, 'base64')));
    }
    if (request.postData != null) return request.postData;
    if (!request.hasPostData) return undefined;
    if (!event.networkId) throw new Error('Cannot read the paused request body without its network ID');
    const body = await cdp.send('Network.getRequestPostData', { requestId: event.networkId });
    if (typeof body.postData !== 'string') throw new Error('The browser did not provide the request body');
    return body.base64Encoded ? Buffer.from(body.postData, 'base64') : body.postData;
  };
  const route = {
    answered: false,
    request: () => ({
      postData,
      url: () => request.url + (request.urlFragment ?? ''),
      method: () => request.method,
      resourceType: () => RESOURCE_TYPES[event.resourceType] ?? 'other',
      headers: () => headers,
      isNavigationRequest: () => event.resourceType === 'Document',
      frame: () => ({ page: () => page, parentFrame: () => (isMainDocument || event.resourceType !== 'Document' ? null : {}) }),
    }),
    /** Asks the online portal, with the cookies of the browser. Redirects are not followed unless asked. */
    async fetch({ url, maxRedirects = 0, timeout = 120_000 } = {}) {
      if (route.answered) throw new Error('Request already answered');
      const data = await postData();
      if (route.answered) throw new Error('Request already answered');
      const forwarded = Object.fromEntries(Object.entries(headers).filter(([name]) => !NOT_FORWARDED.has(name)));
      fetched = true;
      const response = await context.request.fetch(url ?? request.url, { method: request.method, headers: forwarded, data, maxRedirects, timeout, failOnStatusCode: false });
      if (route.answered) {
        try { await response.dispose?.(); } catch { /* response already released */ }
        throw new Error('Request finished after the browser stopped waiting');
      }
      responses.add(response);
      // Playwright copies the decoded bytes when body() is requested. Reuse that snapshot for
      // text inspection and an unchanged fulfill instead of fetching/copying the body twice.
      let bytes;
      let text;
      const readBody = () => bytes ??= Promise.resolve().then(() => response.body());
      const readText = () => text ??= readBody().then((body) => body.toString('utf8'));
      return new Proxy(response, {
        get(target, property) {
          if (property === 'body') return readBody;
          if (property === 'text') return readText;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    /** Answers from `response` (what fetch() returned), optionally with another body, or from status/headers/body. */
    async fulfill({ response, status, headers: given, body } = {}) {
      if (route.answered) return;
      let responseHeaders;
      let payload = body;
      const code = status ?? (response ? response.status() : 200);
      const noBody = request.method === 'HEAD' || code === 204 || code === 205 || code === 304;
      if (response) {
        if (payload == null && !noBody) payload = await response.body();
        // the body arrives decoded, so its encoding and length no longer apply
        responseHeaders = response.headersArray().filter((h) => !NOT_REPLAYED.has(h.name.toLowerCase()));
        if (given) {
          const names = new Set(Object.keys(given).map((name) => name.toLowerCase()));
          responseHeaders = responseHeaders.filter((h) => !names.has(h.name.toLowerCase()));
          responseHeaders.push(...Object.entries(given).map(([name, value]) => ({ name, value: String(value) })));
        }
      } else {
        responseHeaders = Object.entries(given ?? {}).map(([name, value]) => ({ name, value: String(value) }));
      }
      responseHeaders = responseHeaders.filter((h) => !NOT_REPLAYED.has(h.name.toLowerCase()));
      if (response && body != null) {
        responseHeaders = responseHeaders.filter((h) => !STALE_AFTER_EDIT.has(h.name.toLowerCase()));
        responseHeaders.push({ name: 'cache-control', value: 'no-store' });
      }
      const bytes = noBody ? Buffer.alloc(0) : Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
      if (!noBody) responseHeaders.push({ name: 'content-length', value: String(bytes.length) });
      await send('Fetch.fulfillRequest', {
        responseCode: code,
        responseHeaders,
        body: bytes.toString('base64'),
      });
    },
    /** Lets the request go to the online portal untouched. */
    fallback: () => fetched && !SAFE_METHODS.has(request.method) ? route.abort() : send('Fetch.continueRequest', {}),
    abort: () => send('Fetch.failRequest', { errorReason: 'Aborted' }),
    disposeResponses: async () => {
      await Promise.allSettled([...responses].map((response) => response.dispose?.()));
      responses.clear();
    },
  };
  return route;
}
