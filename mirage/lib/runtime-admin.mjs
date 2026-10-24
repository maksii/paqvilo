// Generic local administration shared by portal and solution-only hosts.
import fs from 'node:fs/promises';
import { platformSettingEntries, validatePlatformOverrides } from './platform-settings.mjs';
/** The Content-Security-Policy of the /_sim/ administration page on both hosts: same-origin only, no inline script or style. */
export const ADMIN_CSP =
  "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// DOM-free mirage/lib modules the admin page imports; every other asset is a flat file of mirage/admin/.
export const SHARED_ADMIN_MODULES = new Set(['persona-search.mjs', 'persona-picker-view.mjs']);
/** Every /_sim/api prefix createRuntimeAdminRouter can answer; a router lists (router.routes) only those whose callbacks were
 * supplied, which is what a host reports in status `routes`. `/dataverse` includes the staff session route. */
export const RUNTIME_ADMIN_ROUTES = Object.freeze([
  '/status',
  '/state',
  '/config',
  '/simulation',
  '/diagnostics',
  '/platform-settings',
  '/dataverse',
  '/records',
  '/shutdown',
]);
/** Diagnostic count per code (`OBSERVATION` when a diagnostic has none), for status, diagnostics and the dashboard on both hosts. */
export const diagnosticsByCode = (entries) => {
  const counts = {};
  for (const item of entries) counts[item.code ?? 'OBSERVATION'] = (counts[item.code ?? 'OBSERVATION'] ?? 0) + 1;
  return counts;
};
/**
 * The file URL of the /_sim/<name> asset, or null (answer 404): a shared lib module, else `<name>.mjs|css` matching
 * ^[a-z0-9-]+$ that exists in mirage/admin/. `name` is the raw path segment after /_sim/, so an encoded separator never matches.
 */
export async function adminAssetFile(name) {
  if (SHARED_ADMIN_MODULES.has(name)) return new URL(`./${name}`, import.meta.url);
  if (!/^[a-z0-9-]+\.(?:mjs|css)$/.test(name)) return null;
  const file = new URL(`../admin/${name}`, import.meta.url);
  return fs.access(file).then(
    () => file,
    () => null,
  );
}
/** Content type of an admin asset; modules are text/javascript. */
export const adminAssetType = (name) =>
  name.endsWith('.css')
    ? 'text/css; charset=utf-8'
    : name.endsWith('.mjs')
      ? 'text/javascript; charset=utf-8'
      : 'text/html; charset=utf-8';
const error = (message, status = 400, code = 'INVALID_REQUEST') => Object.assign(new Error(message), { status, code });
const decodeAdminIdentifier = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    throw error('Administration identifier has invalid URL encoding.');
  }
};
export function createRuntimeAdminRouter({
  store,
  json,
  jsonObjectBody,
  change,
  csrf,
  status,
  state,
  configuration,
  configure,
  simulation,
  diagnostics,
  shutdown,
  dataverseAdmin,
  staffSession,
}) {
  const records = async (req, res, url, relative) => {
    const method = req.method;
    const record = /^\/records\/([^/]+)(?:\/([^/]+))?$/.exec(relative);
    if (record) {
      const [, entity, id] = record.map((x) => x && decodeAdminIdentifier(x));
      const identity = { admin: true };
      if (
        method === 'GET' &&
        !id &&
        (url.searchParams.has('page') || url.searchParams.has('pageSize') || url.searchParams.has('search'))
      ) {
        const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('pageSize'), 10) || 25));
        const search = (url.searchParams.get('search') ?? '').trim().toLowerCase();
        const rows = store
          .rows(entity, identity)
          .filter((row) => !search || JSON.stringify(row).toLowerCase().includes(search));
        const total = rows.length,
          pageCount = Math.max(1, Math.ceil(total / pageSize)),
          page = Math.min(pageCount, Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1));
        return json(res, 200, {
          items: rows.slice((page - 1) * pageSize, page * pageSize),
          total,
          page,
          pageSize,
          pageCount,
        });
      }
      if (method === 'GET')
        return json(
          res,
          200,
          id ? await store.get(entity, id, identity) : await store.query(entity, url.searchParams, identity),
        );
      return change(async () => {
        if (method === 'POST' && !id)
          return json(res, 201, await store.create(entity, await jsonObjectBody(req), identity));
        if (method === 'PATCH' && id)
          return json(res, 200, await store.update(entity, id, await jsonObjectBody(req), identity));
        if (method === 'DELETE' && id) {
          await store.remove(entity, id, identity);
          return json(res, 204, null);
        }
        throw error('Unsupported record operation.', 405);
      });
    }
  };
  // One table of [prefix, handler]: the dispatcher iterates it and router.routes is read from it, so status `routes` lists
  // exactly the prefixes this router answers. A handler answers true when it served the request.
  const table = [
    ['/status', status && ((c) => c.method === 'GET' && c.relative === '/status' && c.answer(status()))],
    ['/state', state && ((c) => c.method === 'GET' && c.relative === '/state' && c.answer(state(c.url)))],
    [
      '/config',
      (configuration || configure) &&
        (async (c) => {
          if (c.relative !== '/config') return false;
          if (c.method === 'GET' && configuration) return c.answer(configuration());
          if (c.method === 'PATCH' && configure)
            return c.answer(change(async () => configure(await jsonObjectBody(c.req))));
          return false;
        }),
    ],
    [
      '/simulation',
      simulation && ((c) => c.method === 'GET' && c.relative === '/simulation' && c.answer(simulation())),
    ],
    [
      '/diagnostics',
      diagnostics && ((c) => c.method === 'GET' && c.relative === '/diagnostics' && c.answer(diagnostics())),
    ],
    [
      '/platform-settings',
      async (c) => {
        if (c.relative === '/platform-settings' && c.method === 'GET')
          return c.answer(platformSettingEntries(store.state));
        if (c.relative === '/platform-settings' && c.method === 'PATCH')
          return c.answer(
            change(async () => {
              const patch = validatePlatformOverrides(await jsonObjectBody(c.req));
              await store.transact(() => {
                store.state.simulator.platformOverrides = { ...store.state.simulator.platformOverrides, ...patch };
                delete store.state.simulator.activeExperiment;
              });
              return platformSettingEntries(store.state);
            }),
          );
        if (c.relative.startsWith('/platform-settings/') && c.method === 'DELETE')
          return c.answer(
            change(async () => {
              const key = decodeAdminIdentifier(c.relative.slice('/platform-settings/'.length));
              if (!platformSettingEntries(store.state).some((item) => item.key === key))
                throw error('Unknown platform setting.', 404);
              await store.transact(() => {
                delete (store.state.simulator.platformOverrides ?? {})[key];
                delete store.state.simulator.activeExperiment;
              });
              return { reset: key };
            }),
          );
        return false;
      },
    ],
    [
      '/dataverse',
      dataverseAdmin &&
        (async (c) => {
          await dataverseAdmin(c.req, c.res, c.relative);
          return true;
        }),
    ],
    [
      '/records',
      async (c) => {
        if (!/^\/records\/[^/]+(?:\/[^/]+)?$/.test(c.relative)) return false;
        await records(c.req, c.res, c.url, c.relative);
        return true;
      },
    ],
    [
      '/shutdown',
      shutdown &&
        ((c) => {
          if (c.method !== 'POST' || c.relative !== '/shutdown') return false;
          c.res.once('finish', () => {
            Promise.resolve()
              .then(shutdown)
              .catch(() => {});
          });
          json(c.res, 200, { stopped: true });
          return true;
        }),
    ],
  ].filter(([, handle]) => handle);
  const router = async (req, res, url) => {
    const prefix = /^\/(?:_sim|__sim)\/api(?=\/|$)/.exec(url.pathname);
    if (!prefix) return false;
    const relative = url.pathname.slice(prefix[0].length),
      method = req.method;
    const token = csrf();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && (!token || req.headers['x-sim-csrf'] !== token))
      throw error('Missing simulator CSRF token.', 403);
    if (staffSession && (await staffSession(req, res, url))) return true;
    const context = {
      req,
      res,
      url,
      relative,
      method,
      answer: async (value) => {
        json(res, 200, await value);
        return true;
      },
    };
    for (const [route, handle] of table)
      if (relative === route || relative.startsWith(route + '/')) {
        if (await handle(context)) return true;
      }
    return false;
  };
  router.routes = Object.freeze(table.map(([prefix]) => prefix));
  return router;
}
