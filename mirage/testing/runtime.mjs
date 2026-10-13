import { loadConfig } from '../../lense/config.mjs';
import { DEFAULT_PORT, discoveries, miragePaths, samePath } from '../../lense/commands/mirage.mjs';
import { loadProjectConfig } from '../lib/project-config.mjs';
import {createPortalSession} from './sessions.mjs';

function requestError(status, value, label = 'Local runtime request') {
  const detail = value?.error?.message ?? value?.message ?? (typeof value?.error === 'string' ? value.error : '');
  return Object.assign(new Error(`${label} failed (${status})${detail ? `: ${detail}` : ''}`), { status, response: value });
}

export function runtimeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
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
      cfg.sourceDir = project.portals.find(item => samePath(item.sourceDir, cfg.sourceDir))?.sourceDir ?? project.portals.find(item => item.id === project.defaultPortal).sourceDir;
    }
    const owned = await discoveries(miragePaths(cfg), { probe: false });
    const matching = owned.filter(item => item.processAlive && samePath(item.sourceDir, cfg.sourceDir));
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
  const request = async (route, { method = 'GET', body, headers = {}, captureReport = false } = {}) => {
    if (method !== 'GET') headers['x-sim-csrf'] = (await request('/state?summary=1')).csrf;
    const response = await fetchImpl(`${origin}/_sim/api${route}`, {
      method, headers: { ...(cookie ? { cookie } : {}), ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    if (response.status === 204) return null;
    const value = await response.json().catch(() => null);
    if (!response.ok && !(captureReport && response.status === 409 && value?.shellProfile && Array.isArray(value.failures))) {
      throw requestError(response.status, value);
    }
    const returnedCookie = response.headers.get('set-cookie');
    if (returnedCookie) cookie = returnedCookie.split(';', 1)[0];
    return value;
  };
  const status = await request('/status');
  if (cfg && !samePath(status.sourceDir, cfg.sourceDir)) throw new Error('Runtime source does not match the catalogue site');
  const setPortalValue = async (section, name, value) => {
    const existing = await request(`/${section}`);
    return existing.some(item => item.id === name)
      ? request(`/${section}/${encodeURIComponent(name)}`, {method: 'PATCH', body: {value}})
      : request(`/${section}`, {method: 'POST', body: {name, value}});
  };
  return Object.freeze({
    origin,
    createSession: options => createPortalSession({...options,origin,fetchImpl}),
    status: () => request('/status'),
    state: ({ summary = false } = {}) => request(`/state${summary ? '?summary=1' : ''}`),
    witness: ({ tables } = {}) => request(`/verification-witness?tables=${encodeURIComponent(Array.isArray(tables) ? tables.join(',') : '')}`),
    audit: (filters = {}) => request(`/audit?${new URLSearchParams(filters)}`),
    exportAudit: (filters = {}) => request(`/audit/export?${new URLSearchParams(filters)}`),
    diagnostics: () => request('/diagnostics'),
    platformSettings: () => request('/platform-settings'),
    setPlatformSettings: overrides => request('/platform-settings', {method: 'PATCH', body: overrides}),
    resetPlatformSetting: key => request(`/platform-settings/${encodeURIComponent(key)}`, {method: 'DELETE'}),
    siteSettings: () => request('/portal-settings'),
    setSiteSetting: (name, value) => setPortalValue('portal-settings', name, value),
    resetSiteSetting: name => request(`/portal-settings/${encodeURIComponent(name)}`, {method: 'DELETE'}),
    resetSnippet: name => request(`/portal-snippets/${encodeURIComponent(name)}`, {method: 'DELETE'}),
    experiments: id => request(`/experiments${id === undefined ? '' : '/' + encodeURIComponent(id)}`),
    saveExperiment: preset => request('/experiments', {method: 'POST', body: preset}),
    applyExperiment: id => request(`/experiments/${encodeURIComponent(id)}/apply`, {method: 'POST', body: {}}),
    deleteExperiment: id => request(`/experiments/${encodeURIComponent(id)}`, {method: 'DELETE'}),
    async signIn(context = null, { contactId, roles, configuredPersona = false } = {}) {
      const state = await request('/state?summary=1');
      if (configuredPersona) {
        contactId ??= state.config.identity?.contactId ?? state.config.identity?.id;
        if (roles === undefined && (state.config.identity?.roleSource ?? 'override') === 'override') roles = state.config.identity.roles;
      }
      const body = { contactId, ...(roles !== undefined ? { roles } : {}) };
      if (context) {
        const response = await context.request.post(`${origin}/_sim/api/session/sign-in`, { headers: { 'x-sim-csrf': state.csrf }, data: body });
        if (!response.ok()) throw requestError(response.status(), await response.json().catch(() => null), 'Local sign-in');
        return response.json();
      }
      await request('/session/sign-in', { method: 'POST', body });
      return { cookie };
    },
    async signOut(context = null) {
      if (!context) return request('/session/sign-out', { method: 'POST', body: {} });
      const state = await request('/state?summary=1');
      const response = await context.request.post(`${origin}/_sim/api/session/sign-out`, { headers: { 'x-sim-csrf': state.csrf }, data: {} });
      if (!response.ok()) throw requestError(response.status(), await response.json().catch(() => null), 'Local sign-out');
      return response.json();
    },
    records: (table, query = {}) => request(`/records/${encodeURIComponent(table)}?${new URLSearchParams(query)}`),
    setSnippet: (name, value) => setPortalValue('portal-snippets', name, value),
    liveConnect: cdpUrl => request('/live/connect', { method: 'POST', body: { cdpUrl } }),
    liveDisconnect: () => request('/live/disconnect', { method: 'POST', body: {} }),
    captureShell: path => request('/assets/capture-shell', { method: 'POST', body: { path }, captureReport: true }),
  });
}
