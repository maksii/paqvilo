import fs from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { createOfflineSessions } from './offline.mjs';

const assets = { 'app.mjs': 'text/javascript; charset=utf-8', 'client-runtime.mjs': 'text/javascript; charset=utf-8', 'pcf-runtime.mjs': 'text/javascript; charset=utf-8', 'controls.mjs': 'text/javascript; charset=utf-8', 'date-control.mjs': 'text/javascript; charset=utf-8', 'date-control.css': 'text/css; charset=utf-8', 'duration-control.mjs': 'text/javascript; charset=utf-8', 'duration-control.css': 'text/css; charset=utf-8', 'choice-control.mjs': 'text/javascript; charset=utf-8', 'lookup-dialog.mjs': 'text/javascript; charset=utf-8', 'lookup-control.mjs': 'text/javascript; charset=utf-8', 'control-descriptors.mjs': 'text/javascript; charset=utf-8', 'icons.mjs': 'text/javascript; charset=utf-8', 'style.css': 'text/css; charset=utf-8', 'controls.css': 'text/css; charset=utf-8' };
const fail = (message, status) => Object.assign(new Error(message), { status, code: 'ModelDrivenRequestInvalid' });
const metadataOnly = async (catalogue, data, actor, res, { index = false, entity } = {}) => {
  const tables = {};
  let yieldedAt = performance.now();
  for (const [name, { rows: _rows, ...table }] of Object.entries(catalogue.tables)) {
    if (entity && name !== entity) continue;
    if (res.destroyed) throw fail('Catalogue request was cancelled.', 499);
    const { entity: logical, label, singular, idColumn, nameColumn, entitySet, kind, source, projected } = table;
    tables[name] = { ...(index ? { entity: logical, label, singular, idColumn, nameColumn, entitySet, kind, source, projected, metadata: 'lazy' } : table),
      capabilities: data.capabilities?.(name, actor, undefined, index ? {} : table.fields) };
    // Keep the serialized read epoch across yields: writes cannot change the
    // principal or field security halfway through the resulting catalogue.
    if (performance.now() - yieldedAt >= 8) { await setImmediate(); yieldedAt = performance.now(); }
  }
  return { ...catalogue, tables };
};

// Admin-adjacent route, listed in status `adminAdjacentRoutes` on both hosts (status `routes` holds /_sim/api prefixes only): any Web API request as the selected staff user, or as the
// explicit local administrator when no staff cookie is set (staff-session.mjs); CSRF-checked, POST only.
// /_apps/api/offline: the staff session's mobile offline state for one app (offline.mjs): GET ?app= status; POST
// { app, action: 'mode', mode } | { app, action: 'sync' } | { app, action: retrieve|retrieveMultiple|create|update|delete, entity, id, options, data }.
export const routes = Object.freeze(['/_apps/api/webapi', '/_apps/api/offline']);

// offlineState: where mobile offline sessions persist (offline.mjs offlineSessionState over the host's store); memory without it.
export function createModelDrivenHandler({ catalogue, data, csrf, json, readBody, change, read = fn => fn(), principal = () => ({}), clientAssets = () => new Map(), webApi = null, offlineState = null }) {
  const offline = createOfflineSessions({ webApi, catalogue: () => read(async () => catalogue.async?.() ?? catalogue()), state: offlineState });
  // handler.offlineSessions(): every staff session's offline summary, for the /_sim/ administration.
  return Object.assign(async (req, res, url) => {
    const shell = url.pathname === '/main.aspx' || /^\/_apps\/?$/.test(url.pathname);
    const asset = /^\/_apps\/assets\/([^/]+)$/.exec(url.pathname);
    const api = /^\/_apps\/api(?:\/(.*))?$/.exec(url.pathname);
    // The app's own pages read the Dataverse Web API on their address as the signed-in staff user, as a native app does
    // (reads only). Only requests from those pages (same-origin Referer /main.aspx or /_apps/) are answered: the Power
    // Pages host shares this address with the portal, which never answers /api/data.
    const fromAppPage = (() => { try { const referer = new URL(req.headers.referer ?? ''); return referer.host === req.headers.host && (referer.pathname === '/main.aspx' || referer.pathname.startsWith('/_apps/')); } catch { return false; } })();
    const dataApi = Boolean(webApi) && fromAppPage && /^\/api\/data\/v9\.\d(?:\/|$)/.test(url.pathname);
    if (!shell && !asset && !api && !dataApi && !url.pathname.startsWith('/_apps/')) return false;
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'SAMEORIGIN');
    try {
      if (url.pathname.startsWith('/_apps/resources/') || url.pathname.startsWith('/_apps/controls/')) {
        if (!['GET', 'HEAD'].includes(req.method)) throw fail('This resource requires GET.', 405);
        const resource = clientAssets().get(url.pathname);
        // A web resource page may take the native ?data= parameter; every other asset is served without a query.
        if (!resource || url.search && !(/^text\/html/.test(resource.mime) && /^\?data=[^&]*$/.test(url.search))) throw fail('Trusted client asset not found.', 404);
        // A trusted HTML web resource page opens inside the app (navigateTo, side panes, SiteMap) and runs its own scripts.
        res.setHeader('content-security-policy', /^text\/html/.test(resource.mime)
          ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
          : "default-src 'none'; frame-ancestors 'none'");
        res.writeHead(200, { 'content-type': resource.mime }); res.end(req.method === 'HEAD' ? undefined : resource.data); return true;
      }
      if (shell || asset) {
        if (!['GET', 'HEAD'].includes(req.method)) throw fail('This resource requires GET.', 405);
        if (asset && !assets[asset[1]]) throw fail('Asset not found.', 404);
        const name = shell ? 'index.html' : asset[1];
        let content = await fs.readFile(new URL(name, import.meta.url), 'utf8');
        if (shell) content = content.replace('__MIRAGE_CSRF__', csrf());
        // Only explicitly trusted local Solution scripts are served by the resource allowlist.
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
        res.writeHead(200, { 'content-type': shell ? 'text/html; charset=utf-8' : assets[name] });
        res.end(req.method === 'HEAD' ? undefined : content);
        return true;
      }
      if (dataApi) {
        // Same-origin requests carry the signed-in session. Only GET and HEAD are
        // served here, so a page cannot change data through the session cookie; scripts write through Xrm.WebApi.
        if (!['GET', 'HEAD'].includes(req.method)) throw Object.assign(fail('The Web API on the app address accepts GET only; use Xrm.WebApi or the Dataverse Web API listener to change data.', 405), { code: 'AppAddressReadOnly' });
        const actor = principal(req);
        if (!['staff', 'local-admin'].includes(actor?.kind)) throw Object.assign(fail('Sign in to the app to read the Web API on its address.', 401), { code: 'StaffPrincipalUnavailable' });
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([name, value]) => /^(?:prefer|accept|if-none-match)$/i.test(name) && typeof value === 'string'));
        const result = await webApi({ method: 'GET', path: url.pathname + url.search, headers, principal: actor, host: req.headers.host });
        res.writeHead(result.status, { 'content-type': result.headers?.['content-type'] ?? 'application/json; odata.metadata=minimal',
          ...(result.headers?.['odata-version'] ? { 'odata-version': result.headers['odata-version'] } : {}) });
        res.end(req.method === 'HEAD' ? undefined : result.body); return true;
      }
      if (!api) throw fail('Model-driven resource not found.', 404);
      const method = req.method;
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) throw fail('Method not allowed.', 405);
      if (method !== 'GET' && req.headers['x-sim-csrf'] !== csrf()) throw fail('Missing simulator CSRF token.', 403);
      const actor = principal(req);
      if (api[1] === 'offline') {
        if (!['staff', 'local-admin'].includes(actor?.kind)) throw Object.assign(fail('Mobile offline needs a staff session or the local administrator.', 401), { code: 'StaffPrincipalUnavailable' });
        const input = method === 'GET' ? { app: url.searchParams.get('app'), action: 'status' } : method === 'POST' ? await readBody(req) : null;
        if (!input || typeof input !== 'object' || typeof input.app !== 'string' || !input.app || input.app.length > 128) throw fail('Provide the app id and a GET status or POST action.', input ? 400 : 405);
        if (input.entity !== undefined && !/^[a-z_][a-z\d_]*$/.test(input.entity) || input.id !== undefined && !/^\{?[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\}?$/i.test(String(input.id))
          || input.options !== undefined && (typeof input.options !== 'string' || input.options.length > 65536)) throw fail('Provide a table logical name, a GUID record id and text query options.', 400);
        const host = req.headers.host;
        const result = input.action === 'status' ? await offline.status(actor, input.app, host)
          : input.action === 'mode' ? await offline.setMode(actor, input.app, input.mode, host)
            : input.action === 'sync' ? await offline.sync(actor, input.app, host)
              : await offline.execute(actor, input.app, { operation: input.action, entity: input.entity, id: input.id, options: input.options ?? '', data: input.data }, host);
        json(res, 200, result); return true;
      }
      if (api[1] === 'webapi') {
        // Xrm.WebApi.execute/executeMultiple: one Web API request (operation, CRUD or $batch) as the staff principal.
        if (method !== 'POST') throw fail('The Web API bridge requires POST.', 405);
        const input = await readBody(req);
        if (!input || typeof input !== 'object' || !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(input.method) || typeof input.path !== 'string'
          || !/^\/api\/data\/v9\.\d(?:\/|$)/.test(input.path) || input.path.length > 32768 || (input.body !== undefined && typeof input.body !== 'string')) throw fail('Provide a Web API method, /api/data/v9.x path and text body.', 400);
        if (!webApi) throw Object.assign(fail('This host does not provide the in-process Web API for Xrm.WebApi.execute.', 501), { code: 'WebApiExecuteUnavailable' });
        // execute and executeMultiple are online only; nothing reaches the organization while the app's session is offline.
        // The native error code is not known (the offline family's OfflineModeRequired is used).
        if (typeof req.headers['x-mirage-app'] === 'string' && offline.recordsFor(actor, req.headers['x-mirage-app']))
          throw Object.assign(fail('Xrm.WebApi.execute and executeMultiple work only while the app is online.', 409), { code: 'OfflineModeRequired' });
        const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([name, value]) => /^(?:content-type|prefer|if-match|if-none-match|accept)$/i.test(name) && typeof value === 'string').map(([name, value]) => [name.toLowerCase(), value]));
        const result = await webApi({ method: input.method, path: input.path, headers, body: input.body, principal: actor, host: req.headers.host });
        json(res, 200, { status: result.status, headers: result.headers ?? {}, body: result.body ?? '' }); return true;
      }
      const tableMetadata = /^metadata\/([a-z][\w]*)$/i.exec(api[1] ?? '');
      if (!api[1] || api[1] === 'index' || tableMetadata) {
        if (method !== 'GET') throw fail('Catalogue requires GET.', 405);
        const result = await read(async () => {
          const source = await (catalogue.async?.({ cancelled: () => res.destroyed }) ?? catalogue());
          const entity = tableMetadata?.[1];
          if (entity && !Object.hasOwn(source.tables, entity)) throw fail('Table metadata not found.', 404);
          const result = await metadataOnly(source, data, actor, res, { index: api[1] === 'index', entity });
          return entity ? result.tables[entity] : result;
        });
        if (!res.destroyed) json(res, 200, result); return true;
      }
      const route = /^tables\/([a-z][\w]*)(?:\/([^/]+))?$/i.exec(api[1]);
      if (!route) throw fail('Model-driven endpoint not found.', 404);
      const [, entity, encodedId] = route, id = encodedId ? decodeURIComponent(encodedId) : null;
      if (id && (!/^[\w{}-]{1,128}$/.test(id))) throw fail('Invalid record ID.', 400);
      // The shell names its app (x-mirage-app): while that staff session is offline, records come from its offline copy.
      const records = typeof req.headers['x-mirage-app'] === 'string' ? offline.recordsFor(actor, req.headers['x-mirage-app']) : null;
      const reader = records ? { ...actor, recordService: records } : actor;
      if (method === 'GET') {
        let query;
        try { query = JSON.parse(url.searchParams.get('query') ?? '{}'); } catch { throw fail('Invalid grid query JSON.', 400); }
        if (!query || typeof query !== 'object' || Array.isArray(query)) throw fail('Provide a grid query object.', 400);
        if (id) json(res, 200, await data.get(entity, id, reader, query));
        else json(res, 200, await data.list(entity, query, reader));
      } else {
        if (method === 'POST' && id || method !== 'POST' && !id) throw fail('Invalid record operation.', 405);
        const values = method === 'DELETE' ? {} : await readBody(req);
        const write = () => data.write(entity, id, values, { remove: method === 'DELETE', etag: req.headers['if-match'], ...reader });
        const result = records ? await write() : await change(write);
        json(res, method === 'POST' ? 201 : 200, result);
      }
    } catch (error) {
      if (!res.destroyed) json(res, error.status ?? 500, { error: { message: error.message, code: error.code ?? 'ModelDrivenError' } });
    }
    return true;
  }, { offlineSessions: () => offline.list() });
}
