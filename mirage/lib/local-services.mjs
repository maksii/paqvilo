// Local services a project depends on (Azure Functions Core Tools, Azurite, the Service Bus emulator, any loopback
// HTTP service): declared in the `localServices` config and probed, never started, by Paqvilo. Every URL is loopback
// only (checked at config time and again before each probe); probes refuse redirects and never print a connection string.
import { isLoopbackUrl, loopbackFetch } from './dataverse-webhooks.mjs';
import { serviceBusEmulatorPreflight } from './message-bus.mjs';
import { requestBound } from './storage-provider.mjs';
import { registerSettingParser } from './config-keys.mjs';
import { localServiceSettings, localServicesSettingParser } from './local-service-settings.mjs';

// Origin and path only: a query can carry a SAS or a function key.
const shown = (href) => {
  const url = new URL(href);
  return `${url.protocol}//${url.host}${url.pathname}`;
};

// The `localServices` contract lives in local-service-settings.mjs, so the config-load path validates it without this module.
export { localServiceSettings };

async function probeHttp(href, { fetch, timeoutMs }) {
  if (!isLoopbackUrl(href))
    return { reachable: false, status: null, message: `${shown(href)} is not loopback; it is never contacted.` };
  const bound = requestBound(timeoutMs);
  try {
    const response = await fetch(href, { method: 'GET', redirect: 'error', signal: bound.signal });
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400)
      return {
        reachable: false,
        status: response.status,
        message: `${shown(href)} answered with a redirect, which is refused.`,
      };
    return { reachable: true, status: response.status, message: `${shown(href)} answered ${response.status}.` };
  } catch (error) {
    const cause = String(error?.cause?.message ?? error?.message ?? '');
    let reason;
    if (/redirect/i.test(cause)) reason = 'a redirect, which is refused';
    else if (error?.name === 'TimeoutError') reason = `no answer within ${bound.limitMs} ms`;
    else reason = error?.cause?.code ?? error?.code ?? 'connection failed';
    return {
      reachable: false,
      status: null,
      message: `${shown(href)} is not reachable (${reason}). Start it outside Paqvilo.`,
    };
  } finally {
    bound.done();
  }
}

/**
 * Probes every declared service. Never throws, never follows redirects and never reports a connection string. A probe ends
 * at the caller's timeoutMs when given, else when the shared idle window passes without an answer (requestBound).
 */
export async function preflightLocalServices(settings, { fetch = loopbackFetch, timeoutMs, env = process.env } = {}) {
  let services;
  try {
    services = localServiceSettings(settings);
  } catch (error) {
    return [{ id: null, kind: null, reachable: false, status: null, required: false, message: error.message }];
  }
  return Promise.all(
    Object.entries(services).map(async ([id, service]) => {
      const base = { id, kind: service.kind, required: service.required };
      if (service.kind === 'service-bus') {
        const connectionString = env[service.connectionStringVariable];
        if (!connectionString)
          return {
            ...base,
            reachable: false,
            status: null,
            message: `Environment variable ${service.connectionStringVariable} is not set.`,
          };
        const result = await serviceBusEmulatorPreflight({ connectionString, timeoutMs });
        const problem = result.diagnostics.find((d) => d.severity === 'error');
        return {
          ...base,
          reachable: result.reachable,
          status: null,
          message:
            problem?.message ??
            `The Service Bus emulator health endpoint answered${result.ready ? '' : ' but is not healthy'}.`,
        };
      }
      const root = service.kind === 'http' ? service.baseUrl : service.blob;
      const href = service.probe ? new URL(service.probe, root).href : root;
      return { ...base, ...(await probeHttp(href, { fetch, timeoutMs })) };
    }),
  );
}

/** Capability records for the declared services: contract level, run as external processes. */
export function describeLocalServices(settings) {
  return Object.entries(localServiceSettings(settings)).map(([id, service]) => ({
    name: `local-service:${id}`,
    version: '1',
    kind: 'provider',
    level: 'contract',
    operations: ['probe'],
    requires: [`external-process:${id}`],
    principal: 'none',
    stateOwner: `external:${id}`,
    lifecycle: 'external-process',
    service: service.kind,
    required: service.required,
  }));
}

// The config-key registry validates `localServices` through this module once it is loaded; an absent key stays absent.
registerSettingParser('localServices', localServicesSettingParser);
