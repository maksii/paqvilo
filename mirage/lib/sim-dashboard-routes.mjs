// GET /_sim/api/dashboard: the read-only infrastructure feed both hosts serve. The shared part is
// organizationHost.topology() (organization-host.mjs, memoised per store revision and counters tick); the host adds its own
// listeners, runtimes and rings through extras(). Every part but `activity` is redacted like the messaging routes; `activity`
// is reduced to numbers (plus the few named strings below), so a diagnostic code or counter named like a credential keeps
// its count. The body never carries the administration CSRF token; preflight is not part of it (the page calls
// GET /_sim/api/preflight on demand).
import { redactSecrets } from './sim-messaging-routes.mjs';
import { systemClock } from './runtime-clock.mjs';

const ROUTE = /^\/(?:_sim|__sim)\/api\/dashboard$/;
/** The /_sim/api prefixes this router answers (status `routes`). */
export const routes = Object.freeze(['/dashboard']);
export const DASHBOARD_STATUSES = Object.freeze([
  'listening',
  'ready',
  'declared',
  'disabled',
  'placeholder',
  'missing',
  'error',
  'planned',
]);

// The only strings `activity` keeps: request ring entries (at, method, path, and the traceId / spanId that link them to
// their activity), storage provider ids and the reload time.
const ACTIVITY_STRINGS = new Set(['at', 'method', 'path', 'traceId', 'spanId', 'id', 'lastReloadAt']);
/** Numbers and nulls only (maps keep their keys); any other leaf is dropped. */
export function activityFacts(value, key = '') {
  if (value === null || typeof value === 'number') return value;
  if (typeof value === 'string') return ACTIVITY_STRINGS.has(key) ? value : undefined;
  if (Array.isArray(value)) return value.map((item) => activityFacts(item, key)).filter((item) => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const result = {};
  for (const [name, item] of Object.entries(value)) {
    const fact = activityFacts(item, name);
    if (fact !== undefined) result[name] = fact;
  }
  return result;
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  const { activity, ...rest } = body;
  res.end(
    JSON.stringify(
      activity === undefined ? redactSecrets(rest) : { ...redactSecrets(rest), activity: activityFacts(activity) },
    ),
  );
  return true;
};

/**
 * host: the organization host, or a function returning it (null while a host is still starting: 503 { status: 'starting' }).
 * extras(): { runtime, nodes, edges, activity } the host adds; docs: the docsLinks() map (docs-links.mjs).
 * Resolves true when it answered.
 */
export function createDashboardRoutes({ host, extras = () => ({}), docs = {} }) {
  const current = typeof host === 'function' ? host : () => host;
  return async (req, res, url) => {
    if (!ROUTE.test(url.pathname)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return send(
        res,
        405,
        { error: { code: 'MethodNotAllowed', message: 'The dashboard is read-only; use GET.' } },
        { allow: 'GET, HEAD' },
      );
    const organizationHost = current();
    if (!organizationHost) return send(res, 503, { status: 'starting' }, { 'retry-after': '1' });
    const shared = organizationHost.topology();
    const extra = (await extras()) ?? {};
    const clock = organizationHost.organization?.store?.clock ?? systemClock;
    // An edge is kept only when both of its ends are on this runtime (the shared part names hosts' clients such as client:staff).
    // A connection of a part that is switched off is drawn switched off too, so the map still shows what it would connect to.
    const nodes = [...shared.nodes, ...(extra.nodes ?? [])],
      ids = new Set(nodes.map((node) => String(node.id)));
    const off = new Set(nodes.filter((node) => node.status === 'disabled').map((node) => String(node.id)));
    return send(res, 200, {
      generatedAt: new Date(clock.now()).toISOString(),
      // startedAt never changes; uptimeMs is read on every answer like the activity counters (outside the topology memo).
      runtime: {
        product: 'Mirage',
        ...shared.runtime,
        ...extra.runtime,
        ...(Number.isFinite(organizationHost.startedAt)
          ? {
              startedAt: new Date(organizationHost.startedAt).toISOString(),
              uptimeMs: Math.max(0, Math.round(clock.now() - organizationHost.startedAt)),
            }
          : {}),
      },
      nodes,
      edges: [...shared.edges, ...(extra.edges ?? [])]
        .filter((edge) => ids.has(String(edge.from)) && ids.has(String(edge.to)))
        .map((edge) =>
          off.has(String(edge.from)) || off.has(String(edge.to)) ? { ...edge, status: 'disabled' } : edge,
        ),
      activity: { ...shared.activity, ...extra.activity },
      configuration: {
        ...shared.configuration,
        ...extra.configuration,
        ports: { ...shared.configuration?.ports, ...extra.configuration?.ports },
      },
      docs,
    });
  };
}
