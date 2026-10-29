import { loadConfig } from '../../lense/config.mjs';
import { DEFAULT_PORT, discoveries, miragePaths, samePath } from '../../lense/commands/mirage.mjs';
import { loadProjectConfig } from '../lib/project-config.mjs';
import { createPortalSession } from './sessions.mjs';
import { createPersonaSession } from './personas.mjs';

function requestError(status, value, label = 'Local runtime request') {
  const detail = value?.error?.message ?? value?.message ?? (typeof value?.error === 'string' ? value.error : '');
  return Object.assign(new Error(`${label} failed (${status})${detail ? `: ${detail}` : ''}`), {
    status,
    code: value?.error?.code,
    response: value,
  });
}

// An unknown trace or span answers null, like the in-process trace store.
const unretained = (error) => {
  if (error.code === 'TraceNotFound' || error.code === 'SpanNotFound') return null;
  throw error;
};

// Query strings for the trace routes: a Date keeps its milliseconds (toISOString); undefined and null are left out.
const traceQuery = (filters = {}) => {
  const query = new URLSearchParams();
  for (const [key, value] of filters instanceof URLSearchParams ? filters : Object.entries(filters))
    if (value !== undefined && value !== null)
      query.set(key, value instanceof Date ? value.toISOString() : String(value));
  return query.size ? `?${query}` : '';
};

// The parsed data of each `event: trace` frame of a server-sent event body.
async function* traceFrames(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of frame.split('\n')) {
        const [, name, value] = /^([^:]*):? ?(.*)$/.exec(line);
        if (name === 'event') event = value;
        else if (name === 'data') data.push(value);
      }
      if (event === 'trace') yield JSON.parse(data.join('\n'));
    }
  }
}

export function runtimeOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Runtime origin must be an HTTP loopback origin without credentials, path or query');
  return url.origin;
}

/** Connect to an existing local runtime. This never starts or stops it. */
export async function connectRuntime({ origin, config, site, fetchImpl = globalThis.fetch } = {}) {
  let cfg;
  if (!origin) {
    cfg = await loadConfig({ config, site }, process.env, { checkSource: false });
    if (cfg.mirageConfig.project) {
      const project = await loadProjectConfig(cfg.mirageConfig.project);
      cfg.sourceDir =
        project.portals.find((item) => samePath(item.sourceDir, cfg.sourceDir))?.sourceDir ??
        project.portals.find((item) => item.id === project.defaultPortal).sourceDir;
    }
    const owned = await discoveries(miragePaths(cfg), { probe: false });
    const matching = owned.filter((item) => item.processAlive && samePath(item.sourceDir, cfg.sourceDir));
    if (matching.length > 1) throw new Error('Multiple runtimes match this site; supply origin');
    origin = matching[0]?.url;
    if (!origin) {
      const port = cfg.mirageConfig.port ?? DEFAULT_PORT;
      if (port === 0) throw new Error('No running runtime discovered for this site; supply origin');
      origin = `http://127.0.0.1:${port}`;
    }
  }
  origin = runtimeOrigin(origin);
  let cookie = '';
  // fetch, with an unreachable runtime reported as RuntimeUnreachable instead of a bare "fetch failed".
  const reach = (url, init) =>
    fetchImpl(url, init).catch((cause) => {
      if (init.signal?.aborted || !(cause instanceof TypeError)) throw cause;
      throw Object.assign(new Error(`No Mirage runtime answers at ${origin}; start one or pass --origin.`, { cause }), {
        code: 'RuntimeUnreachable',
      });
    });
  const request = async (
    route,
    { method = 'GET', body, headers = {}, captureReport = false, timeoutMs = 30000 } = {},
  ) => {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
      throw new Error('timeoutMs must be an integer from 0 to 2147483647 (0 disables the client timeout)');
    if (method !== 'GET') headers['x-sim-csrf'] = (await request('/state?summary=1')).csrf;
    const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    try {
      const response = await reach(`${origin}/_sim/api${route}`, {
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...headers,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
      if (response.status === 204) return null;
      const value = await response.json().catch((error) => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (
        !response.ok &&
        !(captureReport && response.status === 409 && value?.shellProfile && Array.isArray(value.failures))
      ) {
        throw requestError(response.status, value);
      }
      const returnedCookie = response.headers.get('set-cookie');
      if (returnedCookie) cookie = returnedCookie.split(';', 1)[0];
      return value;
    } catch (cause) {
      if (captureReport && signal?.aborted)
        throw Object.assign(
          new Error(
            `Shell capture client stopped waiting after ${timeoutMs} ms. Increase captureShell(path, { timeoutMs }) or capture-shell --timeout <milliseconds> (0 disables the timeout). The server may still be working.`,
            { cause },
          ),
          { code: 'SHELL_CAPTURE_TIMEOUT', timeoutMs },
        );
      throw cause;
    }
  };
  const status = await request('/status');
  if (cfg && !samePath(status.sourceDir, cfg.sourceDir))
    throw new Error('Runtime source does not match the catalogue site');
  const setPortalValue = async (section, name, value) => {
    const existing = await request(`/${section}`);
    return existing.some((item) => item.id === name)
      ? request(`/${section}/${encodeURIComponent(name)}`, { method: 'PATCH', body: { value } })
      : request(`/${section}`, { method: 'POST', body: { name, value } });
  };
  // /_sim/api/trace (sim-trace-routes.mjs): the read methods of the in-process simulator.trace, settings, status,
  // configure and clear, and subscribe over the runtime's /_sim/events trace channel.
  const traceTree = (traceId) => request(`/trace/id/${encodeURIComponent(traceId)}`).catch(unretained);
  const traceSpan = (spanId) => request(`/trace/span/${encodeURIComponent(spanId)}`).catch(unretained);
  const trace = Object.freeze({
    query: (filters) => request(`/trace${traceQuery(filters)}`),
    spans: (filters) => request(`/trace/spans${traceQuery(filters)}`),
    tree: traceTree,
    span: traceSpan,
    // The retained spans from the trace root down to spanId (inclusive); [] when the span is not retained.
    async ancestry(spanId) {
      const span = await traceSpan(spanId);
      const tree = span && (await traceTree(span.traceId));
      if (!tree) return span ? [span] : [];
      const byId = new Map(tree.spans.map((record) => [record.spanId, record]));
      const chain = [];
      for (let record = byId.get(spanId); record; record = byId.get(record.parentSpanId)) chain.unshift(record);
      return chain;
    },
    stats: (filters) => request(`/trace/stats${traceQuery(filters)}`),
    // format json (the default) and otlp answer the parsed document; ndjson answers the { trace, spans } lines.
    async export(filters = {}) {
      const query = traceQuery(filters);
      const response = await reach(`${origin}/_sim/api/trace/export${query}`, {
        headers: cookie ? { cookie } : {},
        redirect: 'error',
      });
      const text = await response.text();
      if (!response.ok) throw requestError(response.status, /^\s*\{/.test(text) ? JSON.parse(text) : null);
      return new URLSearchParams(query).get('format') === 'ndjson'
        ? text
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : JSON.parse(text);
    },
    settings: async () => (await request('/trace/settings')).settings,
    status: async () => (await request('/trace/settings')).status,
    configure: async (partial) => (await request('/trace/settings', { method: 'PUT', body: partial })).settings,
    clear: () => request('/trace/clear', { method: 'POST', body: {} }),
    // listener(event) receives each trace frame: { type: 'connected', status } first, then payload-free 'span-start',
    // 'span-end' and 'trace-end' frames. Returns unsubscribe(); unsubscribe.closed resolves when the stream ends
    // (unsubscribe, signal or runtime shutdown) and rejects only when the stream cannot be opened.
    subscribe(listener, { signal } = {}) {
      if (typeof listener !== 'function') throw new TypeError('Trace listeners must be functions.');
      const controller = new AbortController();
      let stopped = false;
      const unsubscribe = () => {
        stopped = true;
        controller.abort();
      };
      signal?.addEventListener('abort', unsubscribe, { once: true });
      if (signal?.aborted) unsubscribe();
      // Resolves when the stream ends; rejects when it cannot be opened or the listener throws.
      const closed = (async () => {
        try {
          const response = await reach(`${origin}/_sim/events?channels=trace`, {
            headers: { accept: 'text/event-stream', ...(cookie ? { cookie } : {}) },
            redirect: 'error',
            signal: controller.signal,
          });
          if (!response.ok)
            throw requestError(response.status, await response.json().catch(() => null), 'Trace stream');
          const frames = traceFrames(response.body);
          for (;;) {
            let next;
            try {
              next = await frames.next();
            } catch {
              break; // a runtime that stops (or unsubscribe) ends the body mid-read: the stream has ended
            }
            if (next.done) break;
            listener(next.value);
          }
        } catch (error) {
          if (!stopped) throw error;
        } finally {
          controller.abort();
          signal?.removeEventListener('abort', unsubscribe);
        }
      })();
      closed.catch(() => {}); // a caller that never awaits closed sees no unhandled rejection
      return Object.assign(unsubscribe, { closed });
    },
  });
  return Object.freeze({
    origin,
    createSession: (options = {}) =>
      options.personaKey || options.scenario
        ? createPersonaSession({ ...options, origin, fetchImpl })
        : createPortalSession({ ...options, origin, fetchImpl }),
    personas: () => request('/personas'),
    savePersonaCatalog: (catalog, { expectedDigest } = {}) =>
      request('/persona-catalog', { method: 'PUT', body: { catalog, expectedDigest } }),
    resetPersonaCatalog: ({ expectedDigest } = {}) =>
      request('/persona-catalog', { method: 'DELETE', body: { expectedDigest } }),
    personaRuntimes: () => request('/persona-runtimes'),
    stopPersonaRuntime: (id) => request('/persona-runtimes/' + encodeURIComponent(id), { method: 'DELETE' }),
    launchPersona: (options) => request('/personas/launch', { method: 'POST', body: options }),
    status: () => request('/status'),
    state: ({ summary = false } = {}) => request(`/state${summary ? '?summary=1' : ''}`),
    witness: ({ tables } = {}) =>
      request(`/verification-witness?tables=${encodeURIComponent(Array.isArray(tables) ? tables.join(',') : '')}`),
    audit: (filters = {}) => request(`/audit?${new URLSearchParams(filters)}`),
    exportAudit: (filters = {}) => request(`/audit/export?${new URLSearchParams(filters)}`),
    trace,
    diagnostics: () => request('/diagnostics'),
    platformSettings: () => request('/platform-settings'),
    setPlatformSettings: (overrides) => request('/platform-settings', { method: 'PATCH', body: overrides }),
    resetPlatformSetting: (key) => request(`/platform-settings/${encodeURIComponent(key)}`, { method: 'DELETE' }),
    siteSettings: () => request('/portal-settings'),
    setSiteSetting: (name, value) => setPortalValue('portal-settings', name, value),
    resetSiteSetting: (name) => request(`/portal-settings/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    resetSnippet: (name) => request(`/portal-snippets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    experiments: (id) => request(`/experiments${id === undefined ? '' : '/' + encodeURIComponent(id)}`),
    saveExperiment: (preset) => request('/experiments', { method: 'POST', body: preset }),
    applyExperiment: (id) => request(`/experiments/${encodeURIComponent(id)}/apply`, { method: 'POST', body: {} }),
    deleteExperiment: (id) => request(`/experiments/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    async signIn(context = null, { contactId, roles, configuredPersona = false } = {}) {
      const state = await request('/state?summary=1');
      if (configuredPersona) {
        const identity = state.config?.identity;
        contactId ??= identity?.contactId ?? identity?.id;
        if (roles === undefined && (identity?.roleSource ?? 'override') === 'override') roles = identity?.roles;
      }
      if (typeof contactId !== 'string' || !contactId.trim())
        throw Object.assign(
          new Error(
            configuredPersona
              ? 'No configured persona contact. Configure an active contact or pass contactId; omit signIn to stay anonymous.'
              : 'Sign-in requires contactId; omit signIn to stay anonymous.',
          ),
          { code: 'MISSING_PERSONA_CONTACT' },
        );
      const body = { contactId, ...(roles !== undefined ? { roles } : {}) };
      if (context) {
        const response = await context.request.post(`${origin}/_sim/api/session/sign-in`, {
          headers: { 'x-sim-csrf': state.csrf },
          data: body,
        });
        if (!response.ok())
          throw requestError(response.status(), await response.json().catch(() => null), 'Local sign-in');
        return response.json();
      }
      await request('/session/sign-in', { method: 'POST', body });
      return { cookie };
    },
    async signOut(context = null) {
      if (!context) return request('/session/sign-out', { method: 'POST', body: {} });
      const state = await request('/state?summary=1');
      const response = await context.request.post(`${origin}/_sim/api/session/sign-out`, {
        headers: { 'x-sim-csrf': state.csrf },
        data: {},
      });
      if (!response.ok())
        throw requestError(response.status(), await response.json().catch(() => null), 'Local sign-out');
      return response.json();
    },
    records: (table, query = {}) => request(`/records/${encodeURIComponent(table)}?${new URLSearchParams(query)}`),
    setSnippet: (name, value) => setPortalValue('portal-snippets', name, value),
    liveConnect: (cdpUrl) => request('/live/connect', { method: 'POST', body: { cdpUrl } }),
    liveDisconnect: () => request('/live/disconnect', { method: 'POST', body: {} }),
    captureShell: (path, options = {}) =>
      request('/assets/capture-shell', {
        method: 'POST',
        body: { path, ...(options.richText === false ? { richText: false } : {}) },
        captureReport: true,
        timeoutMs: options.timeoutMs ?? 0,
      }),
  });
}
