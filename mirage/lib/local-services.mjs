// Local services a project depends on (Azure Functions Core Tools, Azurite, the Service Bus emulator, any loopback
// HTTP service): declared in the `localServices` config and probed, never started, by Paqvilo. Every URL is loopback
// only (checked at config time and again before each probe); probes refuse redirects and never print a connection string.
import { isLoopbackUrl, loopbackFetch } from './dataverse-webhooks.mjs';
import { serviceBusEmulatorPreflight } from './message-bus.mjs';
import { registerSettingParser } from './config-keys.mjs';

const ID = /^[a-z][a-z0-9-]{0,63}$/i;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KINDS = {
  http: { url: 'baseUrl', keys: ['kind', 'baseUrl', 'probe', 'required', 'description'] },
  'azure-storage': { url: 'blob', keys: ['kind', 'blob', 'probe', 'required', 'description'] },
  'service-bus': { url: null, keys: ['kind', 'connectionStringVariable', 'required', 'description'] },
};
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Origin and path only: a query can carry a SAS or a function key.
const shown = (href) => { const url = new URL(href); return `${url.protocol}//${url.host}${url.pathname}`; };

/** Validates and normalises `localServices`: { <id>: { kind: http|azure-storage|service-bus, ... } }. */
export function localServiceSettings(value, label = 'localServices') {
  if (value === undefined || value === null) return {};
  if (!plainObject(value)) throw new Error(`${label} must be an object keyed by service id`);
  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    const at = `${label}.${id}`;
    if (!ID.test(id)) throw new Error(`${at}: service ids are letters, digits and hyphens`);
    if (!plainObject(entry)) throw new Error(`${at} must be an object`);
    const shape = KINDS[entry.kind];
    if (!shape) throw new Error(`${at}.kind must be one of ${Object.keys(KINDS).join(', ')}`);
    if (Object.hasOwn(entry, 'connectionString')) throw new Error(`${at}: connection strings never live in config; name an environment variable (connectionStringVariable)`);
    for (const key of Object.keys(entry)) if (!shape.keys.includes(key)) throw new Error(`Unknown ${at} key '${key}'`);
    const normal = { kind: entry.kind, required: entry.required ?? false };
    if (typeof normal.required !== 'boolean') throw new Error(`${at}.required must be a boolean`);
    if (entry.description !== undefined) normal.description = String(entry.description);
    if (shape.url) {
      const base = entry[shape.url];
      if (typeof base !== 'string' || !isLoopbackUrl(base)) throw new Error(`${at}.${shape.url} must be an http(s) URL on localhost, 127.0.0.0/8 or ::1`);
      // Same rule as connectionSettings rewrites: credentials and query strings never live in config.
      const url = new URL(base);
      if (url.username || url.password || url.search || url.hash) throw new Error(`${at}.${shape.url} must be a plain http(s) URL without credentials, query or fragment`);
      normal[shape.url] = base;
      if (entry.probe !== undefined) {
        // An absolute path on the same origin; "//host" would name another host.
        if (typeof entry.probe !== 'string' || !entry.probe.startsWith('/') || entry.probe.startsWith('//')) throw new Error(`${at}.probe must be a path starting with /`);
        if (!isLoopbackUrl(new URL(entry.probe, base).href)) throw new Error(`${at}.probe must stay on loopback`);
        normal.probe = entry.probe;
      }
    } else {
      if (typeof entry.connectionStringVariable !== 'string' || !VARIABLE.test(entry.connectionStringVariable)) throw new Error(`${at}.connectionStringVariable must name an environment variable`);
      normal.connectionStringVariable = entry.connectionStringVariable;
    }
    result[id] = normal;
  }
  return result;
}

async function probeHttp(href, { fetch, timeoutMs }) {
  if (!isLoopbackUrl(href)) return { reachable: false, status: null, message: `${shown(href)} is not loopback; it is never contacted.` };
  try {
    const response = await fetch(href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) return { reachable: false, status: response.status, message: `${shown(href)} answered with a redirect, which is refused.` };
    return { reachable: true, status: response.status, message: `${shown(href)} answered ${response.status}.` };
  } catch (error) {
    const cause = String(error?.cause?.message ?? error?.message ?? '');
    const reason = /redirect/i.test(cause) ? 'a redirect, which is refused' : error?.name === 'TimeoutError' ? `no answer within ${timeoutMs} ms` : (error?.cause?.code ?? error?.code ?? 'connection failed');
    return { reachable: false, status: null, message: `${shown(href)} is not reachable (${reason}). Start it outside Paqvilo.` };
  }
}

/** Probes every declared service. Never throws, never follows redirects and never reports a connection string. */
export async function preflightLocalServices(settings, { fetch = loopbackFetch, timeoutMs = 2000, env = process.env } = {}) {
  let services;
  try { services = localServiceSettings(settings); } catch (error) { return [{ id: null, kind: null, reachable: false, status: null, required: false, message: error.message }]; }
  return Promise.all(Object.entries(services).map(async ([id, service]) => {
    const base = { id, kind: service.kind, required: service.required };
    if (service.kind === 'service-bus') {
      const connectionString = env[service.connectionStringVariable];
      if (!connectionString) return { ...base, reachable: false, status: null, message: `Environment variable ${service.connectionStringVariable} is not set.` };
      const result = await serviceBusEmulatorPreflight({ connectionString, timeoutMs });
      const problem = result.diagnostics.find((d) => d.severity === 'error');
      return { ...base, reachable: result.reachable, status: null, message: problem?.message ?? `The Service Bus emulator health endpoint answered${result.ready ? '' : ' but is not healthy'}.` };
    }
    const root = service.kind === 'http' ? service.baseUrl : service.blob;
    const href = service.probe ? new URL(service.probe, root).href : root;
    return { ...base, ...(await probeHttp(href, { fetch, timeoutMs })) };
  }));
}

/** Capability records for the declared services: contract level, run as external processes. */
export function describeLocalServices(settings) {
  return Object.entries(localServiceSettings(settings)).map(([id, service]) => ({
    name: `local-service:${id}`, version: '1', kind: 'provider', level: 'contract', operations: ['probe'],
    requires: [`external-process:${id}`], principal: 'none', stateOwner: `external:${id}`, lifecycle: 'external-process',
    service: service.kind, required: service.required,
  }));
}

// The config-key registry validates `localServices` through this module once it is loaded; an absent key stays absent.
registerSettingParser('localServices', (value, label) => (value == null ? value : localServiceSettings(value, label)));
