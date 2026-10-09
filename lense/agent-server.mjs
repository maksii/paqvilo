// Authenticated, loopback-only control of the browser owned by `paqvilo dev`.
// This deliberately exposes bounded inspections, never arbitrary JavaScript or form actions.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { refreshUrl } from './navigation.mjs';

const MAX_EVENTS = 500;
const MAX_BODY = 32 * 1024;
const MAX_TEXT = 2000;
const MAX_ITEMS = 200;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_JSON = 4 * 1024 * 1024;
const DEFAULT_STYLES = ['display', 'visibility', 'position', 'color', 'background-color', 'font-size'];

export function redactUrl(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '[non-HTTP URL]';
    url.username = ''; url.password = ''; url.hash = '';
    // Mutating URL.searchParams repeatedly reparses/serializes the entire URL each time.
    // Build once so a query-heavy portal request cannot stall browser interception/logging.
    const query = new URLSearchParams();
    for (const key of new Set(url.searchParams.keys())) query.append(key, '[redacted]');
    url.search = query.toString();
    return url.href.slice(0, MAX_TEXT);
  } catch { return '[invalid URL]'; }
}

/** Best-effort secret redaction; arbitrary application text can still contain business data. */
export function redactText(value, limit = MAX_TEXT) {
  return String(value ?? '').slice(0, 16_000)
    .replace(/https?:\/\/[^\s<>"']+/gi, redactUrl)
    .replace(/\bBearer\s+[\w.+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted JWT]')
    .replace(/((?:["']?)(?:password|passwd|secret|token|access_token|refresh_token|id_token|authorization|cookie|api[_-]?key)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    .slice(0, limit);
}

const sameOrigin = (url, origin) => { try { return new URL(url).origin === origin; } catch { return false; } };
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const integer = (value, fallback, maximum, minimum = 1) => {
  if (value === undefined || value === null) return fallback;
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw fault(400, 'invalid_argument', `Expected an integer from ${minimum} to ${maximum}`);
  return Number(value);
};
const fields = (body, allowed) => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fault(400, 'invalid_argument', 'Expected a JSON object');
  for (const key of Object.keys(body)) if (!allowed.includes(key)) throw fault(400, 'invalid_argument', `Unknown field: ${key}`);
};

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  let serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized) > MAX_JSON) { status = 413; serialized = JSON.stringify({ error: { code: 'response_too_large', message: 'Response exceeds 4 MiB; request fewer elements/events or shorter text' } }); }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(serialized);
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) throw fault(415, 'content_type', 'Send application/json');
  if (Number(request.headers['content-length']) > MAX_BODY) throw fault(413, 'body_too_large', 'Request body exceeds 32 KiB');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw fault(413, 'body_too_large', 'Request body exceeds 32 KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw fault(400, 'invalid_json', 'Request body is not valid JSON'); }
}

// Runs only this fixed inspection program. The client supplies CSS selectors and property names.
function inspectDom({ origin, selector, limit, textLimit, styles }) {
  if (location.origin !== origin) return { denied: true };
  const nodes = document.querySelectorAll(selector);
  const elements = [];
  let total = 0;
  const blocked = 'script,style,template,noscript,input,textarea,select,option,#paqvilo-panel,[contenteditable]:not([contenteditable="false"])';
  const textOf = (node) => {
    if (node.matches(blocked)) return '';
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    let text = '';
    let inspected = 0;
    for (let child; (child = walker.nextNode()) && text.length < textLimit && inspected++ < 300;) {
      if (!child.parentElement?.closest(blocked)) text += child.data.slice(0, textLimit - text.length) + ' ';
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, textLimit);
  };
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.closest('#paqvilo-panel')) continue;
    total++;
    if (elements.length >= limit) continue;
    const rect = node.getBoundingClientRect();
    const computed = getComputedStyle(node);
    const attributes = {};
    for (const name of ['id', 'class', 'style', 'role', 'aria-label', 'aria-hidden', 'title', 'type', 'name', 'href', 'src', 'disabled', 'checked']) {
      const value = node.getAttribute(name);
      if (value !== null) attributes[name] = value.slice(0, 500);
    }
    elements.push({ index, tag: node.localName, attributes, text: textOf(node), visible: rect.width > 0 && rect.height > 0 && computed.visibility !== 'hidden' && computed.display !== 'none', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, style: Object.fromEntries(styles.map((name) => [name, computed.getPropertyValue(name).slice(0, 500)])) });
  }
  return { url: location.href, title: document.title.slice(0, 500), total, truncated: total > limit, elements };
}

/** Start for an owned browser only. No server or discovery file is created when disabled/attached. */
export async function startAgentServer({ session, context, panel, attached = false, stop = () => {}, runtime = {}, options = {} }) {
  if (attached || session.cfg.agent?.enabled === false) return null;
  const { cfg } = session;
  const id = crypto.randomBytes(12).toString('hex');
  const token = crypto.randomBytes(32).toString('hex');
  const authorization = Buffer.from(`Bearer ${token}`);
  const maxEvents = integer(options.maxEvents, MAX_EVENTS, MAX_EVENTS);
  const directory = path.join(cfg.stateDir, 'agents');
  const discoveryFile = path.join(directory, `${id}.json`);
  const startedAt = new Date().toISOString();
  const events = [];
  const eventSizes = new WeakMap();
  let eventBytes = 0;
  const pages = new Map();
  const pageIds = new WeakMap();
  const requests = new WeakMap();
  const responses = new WeakSet();
  const documents = new WeakMap();
  const pendingNavigations = new WeakMap();
  const currentDocuments = new WeakMap();
  const documentRevisions = new WeakMap();
  const busy = new WeakSet();
  const removers = new Set();
  const sockets = new Set();
  let sequence = 0;
  let requestNumber = 0;
  let pageNumber = 0;
  let stopped = false;
  let operations = 0;
  let closing;
  let discovery;
  const on = (target, name, handler, local) => {
    target.on(name, handler);
    const remove = () => { target.off(name, handler); removers.delete(remove); };
    removers.add(remove); local?.push(remove);
    return remove;
  };
  const push = (event) => {
    if (stopped) return;
    let entry = { sequence: ++sequence, at: new Date().toISOString(), ...event };
    let bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > 32 * 1024) { entry = { sequence, at: entry.at, type: 'truncated', originalType: event.type, reason: 'Event exceeds 32 KiB' }; bytes = Buffer.byteLength(JSON.stringify(entry)); }
    events.push(entry); eventSizes.set(entry, bytes); eventBytes += bytes;
    while (events.length > maxEvents || eventBytes > 1024 * 1024) eventBytes -= eventSizes.get(events.shift());
  };
  const location = (value) => { try { return redactUrl(new URL(value, cfg.origin).href); } catch { return '[invalid URL]'; } };
  const active = (page) => !page.isClosed() && sameOrigin(page.url(), cfg.origin);
  const documentUrl = (url) => { try { const value = new URL(url); value.hash = ''; return value.href; } catch { return null; } };
  const nextDocument = (page) => {
    const revision = (documentRevisions.get(page) ?? 0) + 1;
    documentRevisions.set(page, revision);
    return `${pageIds.get(page)}:${revision}`;
  };
  const reloadAllowed = (page) => documents.get(page)?.method === 'GET' && !pendingNavigations.has(page) && documents.get(page).url === documentUrl(page.url());
  const pageList = () => [...pages].filter(([, page]) => active(page)).map(([pageId, page]) => ({ id: pageId, documentId: currentDocuments.get(page)?.id, url: redactUrl(page.url()), viewport: page.viewportSize?.() ?? null, reloadAllowed: reloadAllowed(page), documentMethod: documents.get(page)?.method ?? null }));
  const recordRequest = (request, page) => {
    if (requests.has(request)) return;
    let pending;
    try {
      if (page && request.isNavigationRequest?.() && request.frame() === page.mainFrame?.()) {
        pending = { request, method: request.method(), url: documentUrl(request.url()), documentId: nextDocument(page) };
        pendingNavigations.set(page, pending);
      }
    } catch { /* a popup's initial navigation can have no public frame */ }
    if (page ? !active(page) && !(sameOrigin(request.url(), cfg.origin) && (page.url() === 'about:blank' || request.isNavigationRequest?.())) : !sameOrigin(request.url(), cfg.origin)) return;
    const record = { requestId: String(++requestNumber), ...(page ? { pageId: pageIds.get(page), documentId: pending?.documentId ?? currentDocuments.get(page)?.id } : { unattributed: true }), method: request.method(), url: redactUrl(request.url()), resourceType: request.resourceType(), started: Date.now() };
    requests.set(request, record);
    const { started, ...publicRecord } = record;
    push({ type: 'request', ...publicRecord });
  };
  const recordResponse = (response) => {
    const record = requests.get(response.request());
    if (!record || responses.has(response)) return;
    responses.add(response);
    const { started, ...publicRecord } = record;
    const headers = response.headers?.() ?? {};
    const length = Number(headers['content-length']);
    push({ type: 'response', ...publicRecord, status: response.status(), durationMs: Date.now() - started, ...(headers['content-type'] ? { contentType: redactText(headers['content-type'], 120) } : {}), ...(Number.isSafeInteger(length) && length >= 0 ? { advertisedBytes: length } : {}) });
  };
  const finishRequest = (request, failed = false) => {
    const record = requests.get(request);
    if (!record) return;
    requests.delete(request);
    const { started, ...publicRecord } = record;
    if (failed) return push({ type: 'requestfailed', ...publicRecord, durationMs: Date.now() - started, error: redactText(request.failure()?.errorText) });
    const raw = request.timing?.() ?? {};
    const timing = Object.fromEntries(['domainLookupStart', 'domainLookupEnd', 'connectStart', 'secureConnectionStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd'].filter((name) => Number.isFinite(raw[name]) && raw[name] >= 0).map((name) => [name, raw[name]]));
    push({ type: 'requestfinished', ...publicRecord, durationMs: Date.now() - started, timing });
  };
  const listenPage = (page) => {
    if (stopped || pageIds.has(page)) return;
    const pageId = String(++pageNumber);
    pageIds.set(page, pageId); pages.set(pageId, page);
    currentDocuments.set(page, { id: nextDocument(page), url: page.url() });
    const local = [];
    on(page, 'close', () => { pages.delete(pageId); for (const remove of local) remove(); push({ type: 'page-closed', pageId }); }, local);
    on(page, 'framenavigated', (frame) => {
      if (frame !== page.mainFrame?.()) return;
      const pending = pendingNavigations.get(page);
      pendingNavigations.delete(page);
      // History restoration and documents already present at startup have no observed request.
      // Treat them as unknown instead of assuming the current document was loaded with GET.
      if (pending && pending.url === documentUrl(frame.url())) documents.set(page, { method: pending.method, url: pending.url });
      else documents.delete(page);
      const previous = currentDocuments.get(page);
      const address = frame.url();
      // Fragment-only changes retain current errors. New documents and SPA route changes
      // get distinct diagnostic revisions, including history restoration without a request.
      const fragmentOnly = !pending && previous?.url !== address && documentUrl(previous?.url) === documentUrl(address);
      if (!fragmentOnly) currentDocuments.set(page, { id: pending?.documentId ?? nextDocument(page), url: address });
      else previous.url = address;
      push(sameOrigin(address, cfg.origin) ? { type: 'navigation', pageId, documentId: currentDocuments.get(page).id, url: redactUrl(address), method: documents.get(page)?.method ?? null } : { type: 'page-left-origin', pageId });
    }, local);
    on(page, 'console', (message) => {
      if (!active(page)) return;
      const location = message.location?.() ?? {};
      push({ type: 'console', pageId, documentId: currentDocuments.get(page).id, level: message.type(), text: redactText(message.text()), ...(location.url ? { url: redactUrl(location.url), line: location.lineNumber + 1, column: location.columnNumber + 1 } : {}) });
    }, local);
    on(page, 'pageerror', (error) => { if (active(page)) push({ type: 'pageerror', pageId, documentId: currentDocuments.get(page).id, text: redactText(error.message) }); }, local);
    on(page, 'request', (request) => recordRequest(request, page), local);
    on(page, 'response', recordResponse, local);
    on(page, 'requestfinished', (request) => finishRequest(request), local);
    on(page, 'requestfailed', (request) => {
      if (pendingNavigations.get(page)?.request === request) { pendingNavigations.delete(page); documents.delete(page); }
      finishRequest(request, true);
    }, local);
  };
  context.pages().forEach(listenPage);
  on(context, 'page', listenPage);
  // Playwright emits a popup's first request/response before its Page exists. Its public
  // Request.frame() remains unavailable; never guess a page from its URL (popups can share it).
  on(context, 'request', (request) => {
    if (!request.isNavigationRequest?.()) return;
    try { request.frame(); } catch { recordRequest(request); }
  });
  on(context, 'response', (response) => { if (requests.get(response.request())?.unattributed) recordResponse(response); });
  on(context, 'requestfinished', (request) => { if (requests.get(request)?.unattributed) finishRequest(request); });
  on(context, 'requestfailed', (request) => { if (requests.get(request)?.unattributed) finishRequest(request, true); });
  on(session, 'fault', (error, url) => push({ type: 'overlay-error', text: redactText(error.message), ...(url ? { url: location(url) } : {}) }));
  on(session, 'refreshed', ({ files = [], how, baselineChanged = false } = {}) => push({ type: 'refresh', files: files.slice(0, MAX_ITEMS).map((file) => session.rel(file)), truncated: files.length > MAX_ITEMS, how, baselineChanged }));
  on(session, 'hit', (hit) => push({ type: 'overlay', pageId: hit.page ? pageIds.get(hit.page) : undefined, url: location(hit.url), kind: hit.type, sources: (hit.sources ?? []).slice(0, 30).map(({ rel, kind, action }) => ({ rel, kind, action })) }));

  const textRows = (rows, keys) => (rows ?? []).slice(0, MAX_ITEMS).map((row) => Object.fromEntries(keys.filter((key) => row[key] !== undefined).map((key) => [key, typeof row[key] === 'string' ? key === 'url' ? location(row[key]) : redactText(row[key]) : typeof row[key] === 'boolean' || typeof row[key] === 'number' ? row[key] : null])));
  const sessionState = () => ({
    id,
    session: { ...discovery, token: undefined },
    readiness: { browser: true, watcher: Boolean(runtime.watching), stopping: stopped },
    browserScope: { mode: cfg.portals ?? 'selected', stopScope: 'browser', targets: (cfg.devTargets ?? [{ siteName: cfg.siteName, envName: cfg.envName, origin: cfg.origin }]).map(({ siteName, envName, origin }) => ({ site: siteName, environment: envName, origin })) },
    access: { portalPageCount: pageList().length, externalTabCount: [...pages.values()].filter((page) => !page.isClosed() && !active(page) && page.url() !== 'about:blank').length, blankTabCount: [...pages.values()].filter((page) => !page.isClosed() && page.url() === 'about:blank').length },
    debugger: { port: runtime.debugPort ?? null, attached: false },
    baseline: { spec: session.baseline.spec, requested: cfg.site.markup?.requestedBaseline ?? session.baseline.spec, commit: session.baseline.commit, available: session.baseline.available, ...(session.baseline.error ? { error: redactText(session.baseline.error) } : {}) },
    git: session.head ? { branch: session.head.branch, commit: session.head.commit, detached: Boolean(session.head.detached), headMoved: Boolean(session.baseline.available && session.head.commit !== session.baseline.commit) } : null,
    overlay: { scope: cfg.site.scope, bypass: session.bypass, liveReload: session.liveReload, stats: { webFiles: session.model.webFileByUrl.size, inlineBlocks: session.rewriter.activeBlocks, patches: session.rewriter.patches.length }, changedFiles: [...session.changedFiles].slice(0, MAX_ITEMS).map((file) => session.rel(file)), changedCount: session.changedFiles.size, disabledSources: [...(session.disabled ?? [])].slice(0, MAX_ITEMS), disabledCount: session.disabled?.size ?? 0, needsDeploy: textRows(session.rewriter.unsupported, ['rel', 'reason']), warnings: (session.model.warnings ?? []).slice(0, MAX_ITEMS).map((value) => redactText(value)) },
    truncated: { changedFiles: session.changedFiles.size > MAX_ITEMS, disabledSources: (session.disabled?.size ?? 0) > MAX_ITEMS, needsDeploy: session.rewriter.unsupported.length > MAX_ITEMS, warnings: (session.model.warnings?.length ?? 0) > MAX_ITEMS },
    pages: pageList(),
  });
  const pageState = (page, pageId) => {
    const state = panel?.stateFor(page);
    const hits = session.pageHits?.get(page) ?? [];
    const documentId = currentDocuments.get(page)?.id;
    const runtimeEvents = events.filter((event) => event.pageId === pageId && event.documentId === documentId && ['pageerror', 'console', 'requestfailed'].includes(event.type));
    return { page: { id: pageId, documentId, url: redactUrl(page.url()), reloadAllowed: reloadAllowed(page), documentMethod: documents.get(page)?.method ?? null }, overlay: { online: session.bypass, live: session.liveReload, scope: cfg.site.scope },
      resources: textRows(state?.items ?? hits.flatMap((hit) => hit.sources ?? []), ['rel', 'kind', 'group', 'url', 'action', 'edited', 'count', 'differs', 'isNew']),
      diagnostics: { problems: textRows(state?.problems, ['type', 'text', 'rel', 'where', 'line', 'col', 'count']), notes: textRows(state?.notes, ['rel', 'reason']), needsDeploy: textRows(state?.needsDeploy ?? session.rewriter.unsupported, ['rel', 'reason']) },
      runtime: { panelDiagnosticsAvailable: Boolean(state), events: runtimeEvents.slice(-100), retention: { oldestSequence: events[0]?.sequence ?? sequence + 1, latestSequence: sequence, retained: events.length, dropped: Math.max(0, sequence - events.length) } },
      limits: { maxItems: MAX_ITEMS, resourcesTruncated: (state?.items?.length ?? hits.reduce((n, hit) => n + (hit.sources?.length ?? 0), 0)) > MAX_ITEMS, problemsTruncated: (state?.problems?.length ?? 0) > MAX_ITEMS, notesTruncated: (state?.notes?.length ?? 0) > MAX_ITEMS, needsDeployTruncated: (state?.needsDeploy ?? session.rewriter.unsupported).length > MAX_ITEMS, runtimeEventsTruncated: runtimeEvents.length > 100 },
    };
  };
  const withPage = async (page, timeoutMs, action) => {
    if (busy.has(page)) throw fault(409, 'page_busy', 'A previous browser operation is still running; resume a paused debugger or wait for it to finish');
    if (operations >= 4) throw fault(409, 'session_busy', 'Four browser operations are already running');
    busy.add(page);
    operations++;
    let timer;
    const running = Promise.resolve().then(action).finally(() => { busy.delete(page); operations--; });
    try {
      const result = await Promise.race([running, new Promise((_, reject) => { timer = setTimeout(() => reject(fault(504, 'action_timeout', 'The browser operation timed out')), timeoutMs); })]);
      if (!active(page)) throw fault(403, 'origin_changed', 'The page left the configured portal origin during the operation');
      return result;
    } finally { clearTimeout(timer); }
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (stopped) throw fault(503, 'stopping', 'Development session is stopping');
      if (request.headers.host !== new URL(discovery.endpoint).host || request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined) throw fault(403, 'browser_request', 'This endpoint accepts local agent requests only');
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !crypto.timingSafeEqual(supplied, authorization)) throw fault(401, 'unauthorized', 'A valid session bearer token is required');
      const url = new URL(request.url, discovery.endpoint);
      if (url.origin !== discovery.endpoint) throw fault(400, 'invalid_url', 'Expected a relative API path');
      if (request.method === 'GET') {
        if (url.pathname === '/v1/session') return json(response, 200, sessionState());
        if (url.pathname === '/v1/pages') return json(response, 200, { pages: pageList() });
        if (url.pathname === '/v1/events') {
          const after = integer(url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 0);
          const limit = integer(url.searchParams.get('limit'), 100, MAX_EVENTS);
          const selected = events.filter((event) => event.sequence > after).slice(0, limit);
          return json(response, 200, { events: selected, oldestSequence: events[0]?.sequence ?? sequence + 1, nextSequence: selected.at(-1)?.sequence ?? after, dropped: Math.max(0, (events[0]?.sequence ?? 1) - after - 1), hasMore: selected.at(-1)?.sequence < sequence });
        }
      }
      if (request.method === 'POST' && url.pathname === '/v1/stop') {
        fields(await readBody(request), []);
        json(response, 200, { stopping: true });
        setImmediate(stop);
        return;
      }
      const match = /^\/v1\/pages\/(\d+)\/(state|dom|screenshot|navigate|reload|viewport)$/.exec(url.pathname);
      if (!match) throw fault(404, 'not_found', 'Unknown agent API endpoint');
      const [, pageId, action] = match;
      const page = pages.get(pageId);
      if (!page || !active(page)) throw fault(404, 'page_not_found', 'The page is closed or outside the configured portal origin');
      if (action === 'state' && request.method === 'GET') return json(response, 200, pageState(page, pageId));
      if (request.method !== 'POST' || action === 'state') throw fault(405, 'method_not_allowed', 'Unsupported HTTP method');
      const body = await readBody(request);
      if (action === 'viewport') {
        fields(body, ['width', 'height']);
        if (body.width === undefined || body.height === undefined) throw fault(400, 'invalid_argument', 'width and height are required');
        const viewport = { width: integer(body.width, undefined, 4096, 320), height: integer(body.height, undefined, 4096, 240) };
        await withPage(page, 10_000, () => page.setViewportSize(viewport));
        return json(response, 200, { page: { id: pageId, url: redactUrl(page.url()) }, viewport });
      }
      if (action === 'dom') {
        fields(body, ['selector', 'limit', 'textLimit', 'styles']);
        const selector = body.selector ?? 'body *';
        if (typeof selector !== 'string' || selector.length > 1000 || !selector.trim()) throw fault(400, 'invalid_argument', 'selector must be a non-empty CSS selector of at most 1000 characters');
        const styles = body.styles ?? DEFAULT_STYLES;
        if (!Array.isArray(styles) || styles.length > 20 || styles.some((name) => typeof name !== 'string' || name.length > 80 || !/^(?:[a-z-]+|--[\w-]+)$/.test(name))) throw fault(400, 'invalid_argument', 'styles must contain at most 20 CSS property names');
        const result = await withPage(page, 10_000, () => page.evaluate(inspectDom, { origin: cfg.origin, selector, limit: integer(body.limit, 100, MAX_ITEMS), textLimit: integer(body.textLimit, 500, 2000, 0), styles }));
        if (result.denied) throw fault(403, 'origin_changed', 'The page left the configured portal origin');
        const pageBase = result.url;
        result.url = redactUrl(result.url); result.title = redactText(result.title, 500);
        for (const element of result.elements) {
          element.text = redactText(element.text);
          for (const [name, value] of Object.entries(element.attributes)) {
            if (!['href', 'src'].includes(name)) element.attributes[name] = redactText(value, 500);
            else { try { element.attributes[name] = redactUrl(new URL(value, pageBase).href); } catch { element.attributes[name] = '[invalid URL]'; } }
          }
          for (const [name, value] of Object.entries(element.style)) element.style[name] = redactText(value, 500);
        }
        return json(response, 200, result);
      }
      if (action === 'screenshot') {
        fields(body, ['fullPage', 'includePanel']);
        if (body.fullPage !== undefined && typeof body.fullPage !== 'boolean') throw fault(400, 'invalid_argument', 'fullPage must be true or false');
        if (body.includePanel !== undefined && typeof body.includePanel !== 'boolean') throw fault(400, 'invalid_argument', 'includePanel must be true or false');
        const image = await withPage(page, 15_000, async () => {
          const dimensions = await page.evaluate(({ origin, full }) => location.origin !== origin ? null : { width: full ? Math.max(document.documentElement.scrollWidth, innerWidth) : innerWidth, height: full ? Math.max(document.documentElement.scrollHeight, innerHeight) : innerHeight }, { origin: cfg.origin, full: Boolean(body.fullPage) });
          if (!dimensions) throw fault(403, 'origin_changed', 'The page left the configured portal origin');
          const { width, height } = dimensions;
          if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 8_388_608) throw fault(413, 'image_too_large', 'Screenshot is limited to 8 megapixels and 8192 pixels per side; use the viewport');
          const bytes = await page.screenshot({ type: 'png', scale: 'css', fullPage: Boolean(body.fullPage), ...(body.includePanel ? {} : { style: '#paqvilo-panel { visibility: hidden !important; }' }), ...(body.fullPage ? { clip: { x: 0, y: 0, width, height } } : {}), timeout: 10_000 });
          if (bytes.length > MAX_IMAGE) throw fault(413, 'image_too_large', 'Screenshot exceeds 8 MiB');
          return bytes;
        });
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': image.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(image); return;
      }
      fields(body, action === 'navigate' ? ['url', 'waitUntil', 'timeoutMs'] : ['waitUntil', 'timeoutMs']);
      const timeout = integer(body.timeoutMs, 30_000, 60_000);
      const waitUntil = body.waitUntil ?? 'domcontentloaded';
      if (!['commit', 'domcontentloaded', 'load'].includes(waitUntil)) throw fault(400, 'invalid_argument', 'waitUntil must be commit, domcontentloaded or load');
      let target;
      if (action === 'navigate') {
        if (typeof body.url !== 'string' || body.url.length > 4096 || /[\\\x00-\x20]/.test(body.url)) throw fault(400, 'invalid_argument', 'url must be a portal URL or path without whitespace/backslashes');
        try { target = new URL(body.url, cfg.origin); } catch { throw fault(400, 'invalid_argument', 'Invalid navigation URL'); }
        if (target.origin !== cfg.origin || target.username || target.password) throw fault(403, 'foreign_origin', 'Navigation must start on the configured portal origin');
      }
      if (action === 'reload' && !reloadAllowed(page)) throw fault(409, 'unsafe_reload', 'Reload requires an observed GET document with no navigation pending; use navigate for an explicitly authorized GET URL');
      // An explicit GET also closes the race where a user submits a form after the guard.
      // Browser reload() can silently repeat the POST that produced the current document.
      const destination = action === 'navigate' ? target.href : refreshUrl(page.url());
      const navigated = await withPage(page, timeout + 1000, () => page.goto(destination, { waitUntil, timeout }));
      json(response, 200, { page: { id: pageId, url: redactUrl(page.url()) }, status: navigated?.status?.() ?? null });
    } catch (error) {
      const message = redactText(error.message);
      const status = error.status ?? (error.name === 'TimeoutError' ? 504 : /(?:not a valid selector|querySelectorAll.*not valid)/i.test(error.message) ? 400 : 500);
      if (status >= 500) push({ type: 'action-error', code: error.code ?? 'action_failed', text: message });
      if (!request.complete) response.setHeader('connection', 'close');
      json(response, status, { error: { code: error.code ?? (status === 504 ? 'action_timeout' : 'action_failed'), message } });
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxRequestsPerSocket = 100; server.maxConnections = 32;
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const close = () => closing ??= (async () => {
    stopped = true;
    for (const remove of removers) remove();
    pages.clear(); events.length = 0; eventBytes = 0;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 250);
      server.close(() => { clearTimeout(timer); resolve(); });
      server.closeIdleConnections();
    });
    fs.rmSync(discoveryFile, { force: true });
  })();
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    discovery = { schemaVersion: 1, id, pid: process.pid, startedAt, site: cfg.siteName, environment: cfg.envName, portalOrigin: cfg.origin, sourceDir: cfg.sourceDir, endpoint: `http://127.0.0.1:${server.address().port}`, token, capabilities: { events: true, state: true, dom: true, screenshot: true, viewport: true, navigate: true, reload: true, stop: true, evaluate: false, formActions: false } };
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(discoveryFile, JSON.stringify(discovery, null, 2), { flag: 'wx', mode: 0o600 });
    on(context, 'close', () => { close().catch(() => {}); });
    return { discoveryFile, endpoint: discovery.endpoint, close };
  } catch (error) { await close(); throw error; }
}
