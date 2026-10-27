// Request interception on the DevTools protocol. Each paused request is answered by this module,
// including handler failures, without relying on another network event to complete the route.
import { refreshUrl } from './navigation.mjs';
import { randomUUID } from 'node:crypto';
const RESOURCE_TYPES = {
  XHR: 'xhr',
  Fetch: 'fetch',
  Document: 'document',
  Stylesheet: 'stylesheet',
  Script: 'script',
  Image: 'image',
  Font: 'font',
  Media: 'media',
};

// set by the browser or recomputed for the body that is actually sent
const NOT_FORWARDED = new Set(['cookie', 'host', 'content-length', 'connection']);
const NOT_REPLAYED = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
const STALE_AFTER_EDIT = new Set([
  'etag',
  'last-modified',
  'content-md5',
  'digest',
  'content-digest',
  'repr-digest',
  'cache-control',
  'expires',
]);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// A DevTools command sent while a tab swaps documents can go unanswered; setup and release must still end.
const CDP_SETUP_MS = 10_000;
const CDP_RELEASE_MS = 5_000;

// Composed input events also cover controls inside closed shadow roots. Keep
// only a document-level boolean; no field contents or node references are stored.
function installLateDraftTracker(slot, origins, binding) {
  if (window !== window.top || !origins.includes(location.origin) || window[slot]) return;
  let changed = false,
    pending = null;
  const navigation = window.navigation;
  const nativeStop = window.stop;
  const stop =
    typeof nativeStop === 'function' &&
    Function.prototype.toString.call(nativeStop) === 'function stop() { [native code] }'
      ? nativeStop.bind(window)
      : null;
  let originalBinding = window[binding];
  let notify = typeof originalBinding === 'function' ? originalBinding.bind(window) : null;
  const clear = () => {
    const previous = pending;
    pending = null;
    previous?.signal?.removeEventListener('abort', previous.abort);
  };
  const navigate = (event) => {
    if (!pending || !event.isTrusted) return;
    if (!pending.started && event.destination?.url === pending.destination) {
      const owned = pending;
      owned.started = true;
      owned.signal = event.signal;
      owned.abort = () => {
        if (pending === owned) clear();
      };
      owned.signal.addEventListener('abort', owned.abort, { once: true });
    } else clear();
  };
  // Browser-initiated navigations can defer Navigation API events until their
  // response arrives. Their second unload attempt still supersedes our repair.
  const beforeUnload = (event) => {
    if (!pending || !event.isTrusted) return;
    if (pending.unloading) clear();
    else pending.unloading = true;
  };
  const input = () => {
    changed = true;
    if (!pending) return;
    clear();
    // Abort the owned provisional navigation in this same browser turn before
    // the accepted edit can be replaced by its response. Let the edit proceed.
    stop();
    try {
      notify('cancelled');
    } catch {
      /* The owned target may be detaching. */
    }
  };
  document.addEventListener('beforeinput', input, true);
  document.addEventListener('input', input, true);
  window.addEventListener('beforeunload', beforeUnload, true);
  navigation?.addEventListener('navigate', navigate);
  navigation?.addEventListener('navigateerror', clear);
  navigation?.addEventListener('navigatesuccess', clear);
  Object.defineProperty(window, slot, {
    configurable: true,
    value: Object.freeze({
      dirty: () => changed,
      refreshBinding() {
        // A new execution context can initialize this early script before its
        // CDP binding is installed. Capture the admitted function before inspection,
        // rather than permanently retaining that earlier absence.
        originalBinding = window[binding];
        notify = typeof originalBinding === 'function' ? originalBinding.bind(window) : null;
      },
      repair(destination) {
        if (!stop || !notify || typeof navigation?.addEventListener !== 'function') return false;
        clear();
        pending = { destination, started: false };
        return true;
      },
      dispose() {
        clear();
        document.removeEventListener('beforeinput', input, true);
        document.removeEventListener('input', input, true);
        window.removeEventListener('beforeunload', beforeUnload, true);
        navigation?.removeEventListener('navigate', navigate);
        navigation?.removeEventListener('navigateerror', clear);
        navigation?.removeEventListener('navigatesuccess', clear);
        if (window[binding] === originalBinding) delete window[binding];
        delete window[slot];
      },
    }),
  });
}

// Runs on a retained document object. No field value leaves the browser, and
// checking drafts and starting the GET happen in the same JavaScript turn.
function repairLateDocument(expected, destination, slot) {
  if (this !== document || location.href !== expected) return 'superseded';
  // Keep cleanup ownership current even when an observed draft declines repair.
  window[slot]?.refreshBinding();
  if (window[slot]?.dirty()) return 'draft';
  for (const node of document.querySelectorAll('input, textarea, select, [contenteditable]')) {
    if (
      node.isContentEditable &&
      (node.contains(document.activeElement) || node.contains(document.getSelection()?.anchorNode))
    )
      return 'draft';
    if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement))
      continue;
    const prototype =
      node instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLSelectElement.prototype;
    // Cloning customized built-ins or custom select descendants can execute
    // application constructors. Preserve those controls without probing them.
    if (
      Object.getPrototypeOf(node) !== prototype ||
      node.hasAttribute('is') ||
      [...node.querySelectorAll('*')].some((child) => child.localName.includes('-') || child.hasAttribute('is'))
    )
      return 'draft';
    const form = document.createElement('form'),
      baseline = node.cloneNode(true);
    baseline.removeAttribute('form');
    form.appendChild(baseline);
    HTMLFormElement.prototype.reset.call(form);
    if (node instanceof HTMLInputElement) {
      if (node.files?.length || node.value !== baseline.value || node.checked !== baseline.checked) return 'draft';
    } else if (node instanceof HTMLTextAreaElement) {
      if (node.value !== baseline.value) return 'draft';
    } else if (node instanceof HTMLSelectElement) {
      if ([...node.options].some((option, index) => option.selected !== baseline.options[index].selected))
        return 'draft';
    }
  }
  if (!window[slot]?.repair(destination)) return 'draft';
  location.assign(destination);
  return 'reloading';
}

/** Resolves with true when `promise` settles within `ms`, or false when it does not. */
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms, false);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Sends the portal requests of every tab of `context` through `handler`, which gets an object with
 * the parts of a Playwright Route it needs: request(), fetch(), fulfill(), fallback(), abort().
 * @param {import('playwright-core').BrowserContext} context
 * @param {string} origin only requests to this origin are intercepted
 * @param {(route: object) => Promise<void>} handler
 * @param {{bypassCSP?: boolean, ownsPage?: (page: object) => boolean, onError?: (error: Error) => void}} [options] report failures on later tabs; ownership is checked before changing browser settings
 * @returns {Promise<() => Promise<void>>} releases this overlay's interception sessions
 */
export async function interceptOrigin(context, origin, handler, options = {}) {
  return interceptOrigins(context, [origin], handler, options);
}

/** One CDP attachment per tab, routing all configured origins without competing Fetch handlers. */
export async function interceptOrigins(
  context,
  origins,
  handler,
  {
    bypassCSP = false,
    ownsPage = () => true,
    onError = (error) => console.error(error.message),
    onTargetError,
    onAttach,
  } = {},
) {
  const allowed = new Set(origins.map((origin) => new URL(origin).origin));
  if (!allowed.size) throw new Error('At least one portal origin is required');
  const matches = (url) => {
    try {
      return allowed.has(new URL(url).origin);
    } catch {
      return false;
    }
  };
  const reloadRequired = () => {
    try {
      Promise.resolve(
        onError(
          Object.assign(
            new Error(
              'The initial document opened before local interception was ready. Its draft was preserved; reload this tab when ready to apply local sources.',
            ),
            { code: 'reload_required', scope: 'target', phase: 'initial document' },
          ),
        ),
      ).catch(() => {});
    } catch {
      /* A diagnostic callback cannot replace or close this document. */
    }
  };
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
    if (record.onDraftSignal) record.cdp.off('Runtime.bindingCalled', record.onDraftSignal);
    record.closing = (async () => {
      // Each DevTools answer is bounded: an unanswered command must not keep the release waiting.
      const step = async (label, action) => {
        if (!(await settlesWithin(Promise.resolve().then(action), CDP_RELEASE_MS)))
          onError(
            Object.assign(
              new Error(`Releasing development interception: ${label} did not answer within ${CDP_RELEASE_MS} ms`),
              { scope: 'target', phase: label },
            ),
          );
      };
      // Abort before disabling interception, so an in-flight POST cannot be resumed and repeated.
      await step('pending requests', () =>
        Promise.allSettled(
          [...record.routes].map(async (route) => {
            activeRoutes.delete(route);
            await route.abort();
            await route.disposeResponses();
          }),
        ),
      );
      record.routes.clear();
      if (record.draftScript?.identifier) {
        await step('draft tracker cleanup', () =>
          record.cdp.send('Runtime.evaluate', { expression: `window[${JSON.stringify(record.draftSlot)}]?.dispose()` }),
        );
        await step('draft tracker script', () =>
          record.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: record.draftScript.identifier }),
        );
      }
      if (record.draftBindingReady)
        await step('draft tracker binding', () =>
          record.cdp.send('Runtime.removeBinding', { name: record.draftBinding }),
        );
      if (record.attachment)
        await step('attachment cleanup', () =>
          typeof record.attachment === 'function' ? record.attachment() : record.attachment.dispose?.(),
        );
      const restore = [
        ['Fetch.disable', {}],
        ['Network.setCacheDisabled', { cacheDisabled: false }],
        ['Network.setBypassServiceWorker', { bypass: false }],
      ];
      if (bypassCSP) restore.push(['Page.setBypassCSP', { enabled: false }]);
      for (const [method, params] of restore) await step(method, () => record.cdp.send(method, params));
      await step('detach', () => record.cdp.detach?.());
    })();
    pendingClosures.add(record.closing);
    record.closing.finally(() => pendingClosures.delete(record.closing)).catch(() => {});
    return record.closing;
  };
  const attach = async (page) => {
    if (stopped || attached.has(page) || !ownsPage(page)) return;
    attached.add(page);
    let cdp;
    try {
      cdp = await context.newCDPSession(page);
    } catch (error) {
      if (stopped || page.isClosed()) return;
      throw Object.assign(new Error(`Could not attach development interception: ${error.message}`, { cause: error }), {
        scope: 'target',
        phase: 'CDP attachment',
      });
    }
    if (stopped || page.isClosed()) {
      await cdp.detach?.().catch(() => {});
      return;
    }
    const record = { page, cdp, routes: new Set(), closed: false };
    sessions.set(cdp, record);
    let mainFrameId = null;
    let sawDocument = false;
    record.onPaused = (event) => {
      const isMainDocument =
        event.resourceType === 'Document' && (mainFrameId === null || event.frameId === mainFrameId);
      if (isMainDocument) sawDocument = true;
      const route = makeRoute({
        cdp,
        context,
        page,
        event,
        isMainDocument,
        onFulfilled: (proof) => record.attachment?.publishProvenance?.(event, proof),
      });
      activeRoutes.add(route);
      record.routes.add(route);
      // whatever the handler does or fails to do, the request is not left paused
      Promise.resolve()
        .then(() =>
          stopped || record.closed ? route.abort() : matches(event.request.url) ? handler(route) : route.fallback(),
        )
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
    record.onClose = () => {
      release(record).catch(() => {});
    };
    page.once('close', record.onClose);
    const configure = async (method, params) => {
      if (stopped || record.closed) throw new Error('Browser page closed during interception setup');
      let timer;
      try {
        return await Promise.race([
          cdp.send(method, params),
          new Promise((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error(`${method} did not answer within ${CDP_SETUP_MS} ms`), { phase: method }),
                ),
              CDP_SETUP_MS,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      mainFrameId = (await configure('Page.getFrameTree')).frameTree.frame.id;
      record.draftSlot = '__paqviloLateDraft_' + randomUUID().replaceAll('-', '');
      record.draftBinding = record.draftSlot + 'Changed';
      record.onDraftSignal = (event) => {
        if (
          !stopped &&
          !record.closed &&
          event.name === record.draftBinding &&
          event.payload === 'cancelled' &&
          !record.draftWarningSent &&
          matches(page.url())
        ) {
          record.draftWarningSent = true;
          reloadRequired();
        }
      };
      cdp.on('Runtime.bindingCalled', record.onDraftSignal);
      const draftSource = `(${installLateDraftTracker.toString()})(${JSON.stringify(record.draftSlot)},${JSON.stringify([...allowed])},${JSON.stringify(record.draftBinding)})`;
      await configure('Page.enable');
      await configure('Runtime.enable');
      await configure('Runtime.addBinding', { name: record.draftBinding });
      record.draftBindingReady = true;
      // Register the tracker and install it in existing contexts in one CDP command.
      // A separate Runtime.evaluate can lose its context during a new-tab navigation,
      // falsely treating a healthy target as an interception failure.
      record.draftScript = await configure('Page.addScriptToEvaluateOnNewDocument', {
        source: draftSource,
        runImmediately: true,
      });
      // CSP remains enforced unless explicitly disabled for this development session.
      if (bypassCSP) await configure('Page.setBypassCSP', { enabled: true });
      // A file the browser has cached from the online site would not be asked for again when its
      // local version comes into play (scope 'changed': the moment you first edit it).
      await configure('Network.enable');
      await configure('Network.setCacheDisabled', { cacheDisabled: true });
      // Attached profiles can already have a worker serving cached resources before
      // Fetch sees them. Bypass it only in this admitted target; never unregister it.
      await configure('Network.setBypassServiceWorker', { bypass: true });
      if (onAttach) {
        let timer;
        const opening = Promise.resolve().then(() => onAttach({ page, cdp, configure }));
        opening
          .then((attachment) => {
            if (record.closed)
              Promise.resolve(typeof attachment === 'function' ? attachment() : attachment?.dispose?.()).catch(
                () => {},
              );
            else record.attachment = attachment;
          })
          .catch(() => {});
        try {
          await Promise.race([
            opening,
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('Interception attachment did not finish within its setup deadline')),
                CDP_SETUP_MS,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      await configure('Fetch.enable', { patterns: [...allowed].map((origin) => ({ urlPattern: `${origin}/*` })) });
    } catch (error) {
      const pageClosed = stopped || record.closed || page.isClosed();
      await release(record);
      if (pageClosed) return;
      throw Object.assign(new Error(`Could not enable development interception: ${error.message}`, { cause: error }), {
        scope: 'target',
        phase: error.phase ?? 'interception setup',
      });
    }
    if (record.closed || stopped) {
      await release(record);
      return;
    }
    // A tab opened by the portal (target=_blank, window.open) may have asked for its page before
    // interception was on. Load that page once more so it gets the local sources too.
    let latePending = false,
      lateQueued = false,
      lateDone = false;
    const late = async () => {
      if (stopped || sawDocument || lateDone || page.isClosed() || !matches(page.url())) return;
      if (latePending) {
        lateQueued = true;
        return;
      }
      latePending = true;
      const address = page.url();
      let objectId, captured;
      const stillCurrent = async () => {
        if (stopped || record.closed || page.isClosed() || page.url() !== address) return false;
        const current = await configure('Page.getFrameTree').then(
          (value) => value.frameTree.frame,
          () => null,
        );
        return current && captured && current.id === captured.id && current.loaderId === captured.loaderId;
      };
      try {
        const before = (captured = (await configure('Page.getFrameTree')).frameTree.frame);
        objectId = (await configure('Runtime.evaluate', { expression: 'document', returnByValue: false })).result
          ?.objectId;
        const after = (await configure('Page.getFrameTree')).frameTree.frame;
        if (
          stopped ||
          record.closed ||
          page.isClosed() ||
          page.url() !== address ||
          before.id !== after.id ||
          before.loaderId !== after.loaderId
        )
          return;
        if (!objectId) {
          lateDone = true;
          return reloadRequired();
        }
        // A loader admitted after the initial about:blank setup can have lost
        // its Runtime binding during the context transition. Re-establish this
        // owned capability in the current context before allowing a repair.
        await configure('Runtime.removeBinding', { name: record.draftBinding });
        await configure('Runtime.addBinding', { name: record.draftBinding });
        if (stopped || record.closed || sawDocument || page.isClosed()) return;
        // A late popup can be a POST result. Assign a new GET URL, never replay
        // that submission. A replaced loader cannot use this document handle.
        const result = await configure('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: repairLateDocument.toString(),
          arguments: [{ value: address }, { value: refreshUrl(address) }, { value: record.draftSlot }],
          returnByValue: true,
        });
        if (result.result?.value === 'reloading') lateDone = true;
        if (
          (result.exceptionDetails || !['reloading', 'superseded'].includes(result.result?.value)) &&
          (await stillCurrent())
        ) {
          lateDone = true;
          reloadRequired();
        }
      } catch {
        if (await stillCurrent()) {
          lateDone = true;
          reloadRequired();
        }
      } finally {
        if (objectId) cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
        latePending = false;
        // A native navigation already in flight before Fetch.enable can finish
        // while the old loader is checked. Its DOMContentLoaded is admission
        // work for the latest document, not proof that any request was overlaid.
        if (lateQueued) {
          lateQueued = false;
          await late();
        }
      }
    };
    record.late = () => {
      late().catch(() => {});
    };
    page.on('domcontentloaded', record.late);
    if (matches(page.url())) await late();
  };
  const startAttachment = (page, initial = false) => {
    const pending = attach(page);
    pendingAttachments.add(pending);
    pending.then(
      () => pendingAttachments.delete(pending),
      (error) => {
        pendingAttachments.delete(pending);
        if (!initial && !stopped) {
          // EventEmitter does not await page handlers. Observe callback failures too, so a
          // reporting callback cannot turn a tab setup error into an unhandled rejection.
          Promise.resolve()
            .then(() => (onTargetError ? onTargetError(error, page) : onError(error)))
            .catch(() => {});
        }
      },
    );
    return pending;
  };
  const onPage = (page) => {
    startAttachment(page);
  };
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

function makeRoute({ cdp, context, page, event, isMainDocument, onFulfilled }) {
  const { requestId, request } = event;
  let fetched = false,
    headersChanged = false;
  const responses = new Set();
  const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const send = (method, params) => {
    if (route.answered) return Promise.resolve(false);
    route.answered = true;
    // the tab may have moved on or closed; nothing is waiting for the answer then
    return cdp.send(method, { requestId, ...params }).then(
      () => true,
      () => false,
    );
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
    /** An opt-in owned developer tool may add a validated request header. */
    setRequestHeader(name, value) {
      if (route.answered || fetched) throw new Error('Request headers are already sent');
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || typeof value !== 'string' || /[\r\n\0]/.test(value))
        throw new Error('Invalid request header');
      headers[name.toLowerCase()] = value;
      headersChanged = true;
    },
    /** Remove an internal owned-tool header before continuing the native request. */
    removeRequestHeader(name) {
      if (route.answered || fetched) throw new Error('Request headers are already sent');
      if (typeof name !== 'string' || !/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) throw new Error('Invalid request header');
      delete headers[name.toLowerCase()];
      headersChanged = true;
    },
    request: () => ({
      postData,
      url: () => request.url + (request.urlFragment ?? ''),
      method: () => request.method,
      resourceType: () => RESOURCE_TYPES[event.resourceType] ?? 'other',
      headers: () => headers,
      isNavigationRequest: () => event.resourceType === 'Document',
      frame: () => ({
        page: () => page,
        parentFrame: () => (isMainDocument || event.resourceType !== 'Document' ? null : {}),
      }),
    }),
    /** Asks the online portal, with the cookies of the browser. Redirects are not followed unless asked. */
    async fetch({ url, maxRedirects = 0, timeout = 120_000 } = {}) {
      if (route.answered) throw new Error('Request already answered');
      const data = await postData();
      if (route.answered) throw new Error('Request already answered');
      const forwarded = Object.fromEntries(Object.entries(headers).filter(([name]) => !NOT_FORWARDED.has(name)));
      fetched = true;
      const response = await context.request.fetch(url ?? request.url, {
        method: request.method,
        headers: forwarded,
        data,
        maxRedirects,
        timeout,
        failOnStatusCode: false,
      });
      if (route.answered) {
        try {
          await response.dispose?.();
        } catch {
          /* response already released */
        }
        throw new Error('Request finished after the browser stopped waiting');
      }
      responses.add(response);
      // Playwright copies the decoded bytes when body() is requested. Reuse that snapshot for
      // text inspection and an unchanged fulfill instead of fetching/copying the body twice.
      let bytes;
      let text;
      const readBody = () => (bytes ??= Promise.resolve().then(() => response.body()));
      const readText = () => (text ??= readBody().then((body) => body.toString('utf8')));
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
    async fulfill({ response, status, headers: given, body, provenance } = {}) {
      if (route.answered) return false;
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
      const acknowledged = await send('Fetch.fulfillRequest', {
        responseCode: code,
        responseHeaders,
        body: bytes.toString('base64'),
      });
      if (acknowledged && provenance)
        await Promise.resolve()
          .then(() => onFulfilled?.(provenance))
          .catch(() => {});
      return acknowledged;
    },
    /** Lets the request go to the online portal untouched. */
    fallback: () =>
      fetched && !SAFE_METHODS.has(request.method)
        ? route.abort()
        : send(
            'Fetch.continueRequest',
            headersChanged
              ? { headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })) }
              : {},
          ),
    abort: () => send('Fetch.failRequest', { errorReason: 'Aborted' }),
    disposeResponses: async () => {
      await Promise.allSettled([...responses].map((response) => response.dispose?.()));
      responses.clear();
    },
  };
  return route;
}
