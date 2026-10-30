import { systemIds } from './runtime-clock.mjs';
import { readFile } from 'node:fs/promises';
import { codeAppsWorkbenchHtml } from './code-apps-workbench.mjs';
import { recordHttpError, statusFromHttp } from './trace-store.mjs';
import { tracedFetch } from './trace-hosts.mjs';

/*
 * Local bridge for Power Apps code apps under /_apps/code/<name>/.
 *
 * Contract boundary: the DOCUMENTED client-library surface (getContext() IContext, generated data-service calls), not
 * Microsoft's player / local-host wire protocol, which is not publicly described.
 * - IContext (app, user, host): https://learn.microsoft.com/power-apps/developer/code-apps/how-to/retrieve-context
 * - Runtime layers (code <-> client library <-> Power Apps host): https://learn.microsoft.com/power-apps/developer/code-apps/architecture
 * - Generated services create/get/getAll/update/delete returning `{ data }`: https://learn.microsoft.com/power-apps/developer/code-apps/how-to/connect-to-dataverse
 * - Local Play (`pa app run`, host on port 8080 next to the app's dev server): https://learn.microsoft.com/power-apps/developer/code-apps/how-to/create-an-app-from-scratch
 * - CLI: https://learn.microsoft.com/power-apps/developer/code-apps/reference/cli , https://learn.microsoft.com/power-platform/developer/cli/reference/code
 * Not known: how the client library talks to the player (postMessage or HTTP) and what the 8080 local host serves.
 *
 * Endpoints (all relative to /_apps/code/<name>/):
 *   GET  context                         IContext from the selected staff persona (401 without one)
 *   POST token { resource }              access token whose audience is the local Dataverse origin only
 *   ANY  dataverse/<path>                in-process /api/data/v9.2/<path> as the staff principal (never the portal /_api)
 *   POST connectors/<reference>/<opId>   connectors hook, or 501 ConnectorNotSimulated
 *   GET  (root)                          loader page that frames localAppUrl, mirroring "Local Play"
 * Dataverse and connector requests, GET included, require the `x-sim-csrf` header (some Dataverse functions are GET and
 * write); GET context returns the token in that response header.
 */

const MAX_BODY = 16 * 1024 * 1024;
const FORWARDED = [
  'accept',
  'content-type',
  'prefer',
  'if-match',
  'if-none-match',
  'odata-version',
  'odata-maxversion',
  'x-ms-file-name',
  'range',
  'if-range',
  'x-sim-code-app-operation',
];
const BASE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const WORKBENCH_ASSETS = {
  'workbench.js': ['text/javascript; charset=utf-8', new URL('./code-apps-workbench.js', import.meta.url)],
  'workbench.css': ['text/css; charset=utf-8', new URL('./code-apps-workbench.css', import.meta.url)],
};
const FEATURES = Object.freeze({
  context: 'local staff identity and app settings',
  data: 'organization CRUD, queries, metadata, files and images',
  actions: 'registered unbound actions and functions, plus WhoAmI',
  connectors: 'explicit local providers',
  nativeHost: false,
  onlineConnections: false,
  maxRequestBytes: MAX_BODY,
});
const publicApp = (app) => ({
  name: app.name,
  appId: app.appId ?? null,
  environmentId: app.environmentId ?? null,
  localAppUrl: app.localAppUrl ?? null,
  launchUrl: `/_apps/code/${encodeURIComponent(app.name)}/`,
  diagnostics: (app.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  connectionReferences: (app.connectionReferences ?? []).map(({ key, apiId, dataSources }) => ({
    key,
    apiId,
    dataSources,
  })),
  entitySets: app.entitySets ?? {},
  appSettingNames: Object.keys(app.appSettings ?? {}),
  features: FEATURES,
});
// The dev server probe is an http-out span of the request (tracedFetch; a plain fetch without a trace store).
async function serverStatus(app, traces) {
  if (!app.localAppUrl) return { state: 'unavailable' };
  try {
    const response = await tracedFetch(traces, {
      module: 'code-apps',
      operation: 'probe',
      url: app.localAppUrl,
      init: { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(1500) },
    });
    await response.body?.cancel();
    return { state: 'reachable', status: response.status };
  } catch {
    return { state: 'unavailable' };
  }
}
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const writeJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
};

async function readBytes(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail(413, 'RequestTooLarge', 'The request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const readText = async (req) => (await readBytes(req)).toString('utf8');

const readJson = async (req) => {
  const text = await readText(req);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw fail(400, 'InvalidJson', 'The request body is not valid JSON.');
  }
};

/**
 * Adapter from the Dataverse authority (`createAuthority().issueAccessToken`, dataverse-auth.mjs) to `issueToken`.
 * `origin` is the local Dataverse origin: verifyBearer requires iss = `<origin>/<tenant>/`.
 */
export function authorityTokenIssuer({ issueAccessToken, origin, appId }) {
  return ({ resource, user, app }) => {
    const access_token = issueAccessToken({ origin, appId: app?.appId ?? appId, audience: resource, user });
    const { exp } = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url').toString('utf8'));
    return { access_token, expires_on: exp };
  };
}

/**
 * Options: apps() → records from loadCodeApps (code-apps-config.mjs); sessions = createStaffSessions(); user(principalId)
 * → systemuser row; organization { origin (local Dataverse origin), organizationId, environmentId, tenantId };
 * issueToken({ resource, user, app }) → { access_token, expires_on }; dataverse({ method, path, search, headers, body,
 * principal }) → { status, headers?, body }; connectors?({ app, reference, operationId, body, principal }) → result,
 * where undefined means "not simulated"; csrf() → token; diagnostic?(record); ids → { uuid() } for the host sessionId
 * (default systemIds, the runtime clock/ids seam); traces: the host trace store (the request root's actor is the selected
 * staff user, every error answer is recorded on it with recordHttpError, the dev server probe is an http-out span).
 * Returns async (req, res, url?) => boolean; false when the path is not under /_apps/code/.
 */
export function createCodeAppsHandler({
  apps,
  sessions,
  user,
  organization,
  issueToken,
  dataverse,
  connectors,
  csrf,
  diagnostic = () => {},
  ids = systemIds,
  traces = null,
}) {
  // Adapters supply a fresh per-load session ID; direct HTTP consumers share the deterministic host fallback.
  const sessionId = ids.uuid();
  // Every answer of 400 or more is the request root's error (its { error: { code, message } }, else the status).
  const json = (res, status, body, headers) => {
    if (status >= 400)
      recordHttpError(traces?.current() ?? null, status, { code: body?.error?.code, message: body?.error?.message });
    writeJson(res, status, body, headers);
  };
  // The root's actor is the selected staff user; no session (or an unusable one) leaves it anonymous.
  const traceActor = (req) => {
    if (!traces?.enabled) return;
    try {
      const principal = sessions.resolve(req);
      const row = principal.kind === 'staff' ? user(principal.principalId) : null;
      if (row)
        traces.current()?.setActor({
          kind: 'staff',
          id: principal.principalId,
          name: row.fullname ?? row.domainname ?? null,
        });
    } catch {
      /* no actor */
    }
  };
  const principalOf = (req) => {
    const principal = sessions.resolve(req);
    if (principal.kind !== 'staff')
      throw fail(401, 'StaffSessionRequired', 'Select a staff user in /_sim/ before playing a code app.');
    const row = user(principal.principalId);
    if (!row) throw fail(401, 'StaffPrincipalUnavailable', 'The selected staff user is unavailable or disabled.');
    return { ...principal, row };
  };
  const requireCsrf = (req) => {
    if (req.headers['x-sim-csrf'] !== csrf()) throw fail(403, 'CsrfRequired', 'Missing simulator CSRF token.');
  };
  const requireMethod = (req, ...methods) => {
    if (!methods.includes(req.method)) throw fail(405, 'MethodNotAllowed', 'Method not allowed.');
  };

  return async (req, res, url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)) => {
    if (url.pathname === '/_apps/code') {
      res.writeHead(308, { location: '/_apps/code/' + url.search });
      res.end();
      return true;
    }
    if (
      url.pathname === '/_apps/code/' ||
      url.pathname === '/_apps/code/_api/apps' ||
      url.pathname.startsWith('/_apps/code/_assets/')
    ) {
      traceActor(req);
      res.setHeader('cache-control', 'no-store');
      res.setHeader('x-content-type-options', 'nosniff');
      if (!['GET', 'HEAD'].includes(req.method)) {
        json(res, 405, { error: { code: 'MethodNotAllowed', message: 'This resource requires GET.' } });
        return true;
      }
      if (url.pathname === '/_apps/code/_api/apps') {
        const records = apps();
        const inventory = await Promise.all(
          records.map(async (app) => ({
            ...publicApp(app),
            ...(url.searchParams.get('probe') === '1' ? { server: await serverStatus(app, traces) } : {}),
          })),
        );
        json(res, 200, { mode: 'simulation', features: FEATURES, apps: inventory });
        return true;
      }
      const assetName = url.pathname.replace('/_apps/code/_assets/', '');
      const asset = Object.hasOwn(WORKBENCH_ASSETS, assetName) ? WORKBENCH_ASSETS[assetName] : null;
      if (url.pathname.startsWith('/_apps/code/_assets/') && asset) {
        res.writeHead(200, { 'content-type': asset[0] });
        res.end(req.method === 'HEAD' ? undefined : await readFile(asset[1]));
        return true;
      }
      if (url.pathname === '/_apps/code/') {
        const origins = [
          ...new Set(
            apps()
              .filter((app) => app.localAppUrl)
              .map((app) => new URL(app.localAppUrl).origin),
          ),
        ];
        res.setHeader('content-security-policy', BASE_CSP + `; frame-src ${origins.join(' ') || "'none'"}`);
        res.setHeader('x-frame-options', 'SAMEORIGIN');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.method === 'HEAD' ? undefined : codeAppsWorkbenchHtml());
        return true;
      }
      json(res, 404, { error: { code: 'CodeAppResourceNotFound', message: 'Code app resource not found.' } });
      return true;
    }
    const match = /^\/_apps\/code\/([^/]+)(\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
    traceActor(req);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    try {
      let name;
      try {
        name = decodeURIComponent(match[1]);
      } catch {
        throw fail(404, 'CodeAppNotFound', 'Code app not found.');
      }
      const app = apps().find((item) => item.name.toLowerCase() === name.toLowerCase());
      if (!app) throw fail(404, 'CodeAppNotFound', `Code app '${name}' is not configured.`);
      traces?.current()?.set({ app: app.name });
      const base = `/_apps/code/${encodeURIComponent(app.name)}/`;
      if (match[2] === undefined) {
        res.writeHead(308, { location: base + url.search });
        res.end();
        return true;
      }
      const rest = match[3];
      if (rest === '') return (loader(req, res, url, app, base), true);
      if (rest === 'status') {
        requireMethod(req, 'GET');
        json(res, 200, {
          name: app.name,
          mode: 'simulation',
          level: 'contract',
          nativeSdk: false,
          localAppUrl: app.localAppUrl ?? null,
          entitySets: app.entitySets ?? {},
          appSettingNames: Object.keys(app.appSettings ?? {}),
          features: FEATURES,
          diagnostics: (app.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
          connections: (app.connectionReferences ?? []).map(({ key, apiId, dataSources }) => ({
            key,
            apiId,
            dataSources,
          })),
        });
        return true;
      }
      if (rest === 'context') {
        requireMethod(req, 'GET');
        const { row } = principalOf(req);
        json(
          res,
          200,
          {
            app: {
              appId: app.appId ?? '',
              appSettings: app.appSettings ?? {},
              environmentId: app.environmentId ?? organization.environmentId ?? organization.organizationId,
              queryParams: Object.fromEntries(url.searchParams),
              dataverseOrgUrl: organization.origin,
              appUrl: new URL(base, url).href,
            },
            user: {
              fullName: row.fullname ?? '',
              objectId: row.azureactivedirectoryobjectid ?? '',
              systemUserId: row.systemuserid ?? '',
              tenantId: organization.tenantId ?? '',
              userPrincipalName: row.domainname ?? '',
            },
            host: {
              sessionId: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(
                req.headers['x-paqvilo-code-app-session'] ?? '',
              )
                ? req.headers['x-paqvilo-code-app-session']
                : sessionId,
            },
          },
          { 'x-sim-csrf': csrf() },
        );
        return true;
      }
      if (rest === 'token') {
        requireMethod(req, 'POST');
        requireCsrf(req);
        const { row } = principalOf(req);
        const resource = (await readJson(req))?.resource;
        let audience = null;
        try {
          const target = new URL(resource);
          if (
            target.origin === new URL(organization.origin).origin &&
            ['', '/', '/.default'].includes(target.pathname) &&
            !target.search
          )
            audience = target.origin;
        } catch {
          /* refused below */
        }
        if (!audience) {
          diagnostic({
            code: 'CODEAPP_TOKEN_REFUSED',
            app: app.name,
            message: 'Token requested for a resource other than the local Dataverse origin.',
          });
          throw fail(400, 'InvalidResource', 'Only the local Dataverse origin is a valid token resource.');
        }
        const { access_token, expires_on } = await issueToken({ resource: audience, user: row, app });
        json(res, 200, { access_token, expires_on });
        return true;
      }
      if (rest === 'dataverse' || rest.startsWith('dataverse/')) {
        requireMethod(req, 'GET', 'POST', 'PATCH', 'PUT', 'DELETE');
        requireCsrf(req);
        const { principalId, kind } = principalOf(req);
        const headers = Object.fromEntries(
          FORWARDED.filter((name) => req.headers[name] !== undefined).map((name) => [name, req.headers[name]]),
        );
        let body;
        if (req.method !== 'GET') {
          const bytes = await readBytes(req);
          if (bytes.length && /json/i.test(headers['content-type'] ?? '')) {
            try {
              body = JSON.parse(bytes.toString('utf8'));
            } catch {
              throw fail(400, 'InvalidJson', 'The request body is not valid JSON.');
            }
          } else body = bytes.length ? bytes : undefined;
        }
        const result = await dataverse({
          method: req.method,
          path: '/api/data/v9.2/' + rest.slice('dataverse/'.length),
          search: url.search,
          headers,
          body,
          principal: { principalId, kind },
        });
        const out = Object.fromEntries(Object.entries(result.headers ?? {}).filter(([, value]) => value != null));
        // A text or empty answer of 400 or more names its status and, for an OData error text, its code and message on
        // the root (an object body goes through json, which does the same).
        if (
          result.status >= 400 &&
          (typeof result.body !== 'object' || result.body === null || Buffer.isBuffer(result.body))
        ) {
          let error;
          try {
            error = JSON.parse(String(result.body ?? '')).error;
          } catch {
            /* not an OData error text */
          }
          recordHttpError(traces?.current() ?? null, result.status, { code: error?.code, message: error?.message });
        }
        if (result.body === undefined || result.body === null) {
          res.writeHead(result.status ?? 204, out);
          res.end();
        } else if (typeof result.body === 'string' || Buffer.isBuffer(result.body)) {
          res.writeHead(result.status ?? 200, out);
          res.end(result.body);
        } else
          json(res, result.status ?? 200, result.body, {
            'content-type': 'application/json; odata.metadata=minimal; charset=utf-8',
            ...out,
          });
        return true;
      }
      const connector = /^connectors\/([^/]+)\/([^/]+)$/.exec(rest);
      if (connector) {
        requireMethod(req, 'POST');
        requireCsrf(req);
        const principal = principalOf(req);
        let key, operationId;
        try {
          key = decodeURIComponent(connector[1]);
          operationId = decodeURIComponent(connector[2]);
        } catch {
          throw fail(404, 'ConnectionReferenceNotFound', 'Connection reference path is malformed.');
        }
        const references = app.connectionReferences ?? [];
        let reference = references.find((item) => item.key === key);
        if (!reference) {
          const matches = references.filter((item) => item.dataSources?.includes(key));
          if (matches.length > 1)
            throw fail(
              409,
              'ConnectionReferenceAmbiguous',
              `Data source '${key}' maps to multiple connection references.`,
            );
          reference = matches[0];
        }
        if (!reference)
          throw fail(
            404,
            'ConnectionReferenceNotFound',
            `Connection reference '${key}' is not declared in ${app.name}'s power.config.json.`,
          );
        const body = await readJson(req);
        const result = connectors
          ? await connectors({
              app,
              reference,
              operationId,
              body,
              principal: { principalId: principal.principalId, kind: principal.kind },
            })
          : undefined;
        if (result === undefined) {
          diagnostic({ code: 'CODEAPP_CONNECTOR_NOT_SIMULATED', app: app.name, reference: reference.key, operationId });
          throw fail(
            501,
            'ConnectorNotSimulated',
            `Connector operation '${operationId}' on '${reference.apiId ?? reference.key}' is not simulated.`,
          );
        }
        json(res, 200, result);
        return true;
      }
      throw fail(404, 'CodeAppResourceNotFound', 'Code app resource not found.');
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(res, error.status ?? 500, { error: { code: error.code ?? 'CodeAppError', message: error.message } });
      // After the answer (which recorded its envelope): a plug-in fault keeps the identity its spans carry (D-R3-19).
      if (error?.traceError && traces?.enabled && (error.status ?? 500) >= 400)
        traces
          .current()
          ?.setStatus(statusFromHttp(error.status ?? 500))
          .setError(error);
    }
    return true;
  };
}

function loader(req, res, url, app, base) {
  if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'MethodNotAllowed', 'This resource requires GET.');
  const title = `<title>${escapeHtml(app.name)} (Mirage code app)</title>`;
  let body,
    csp = BASE_CSP;
  if (app.localAppUrl) {
    const target = new URL(app.localAppUrl);
    for (const [key, value] of url.searchParams) target.searchParams.append(key, value);
    csp += `; frame-src ${target.origin}`;
    // Mirrors "Local Play": the developer's own dev server is framed; the app reaches Mirage through `base`.
    body = `<iframe src="${escapeHtml(target.href)}" title="${escapeHtml(app.name)}" width="100%" height="900" allow="local-network-access"></iframe>`;
  } else {
    body = `<h1>${escapeHtml(app.name)}</h1><p>No localAppUrl is configured. Set <code>localAppUrl</code> in the project <code>codeApps</code> entry or in power.config.json, start the app's dev server and reload ${escapeHtml(base)}.</p>`;
  }
  const diagnostics = (app.diagnostics ?? [])
    .map(({ code, message }) => `<li><code>${escapeHtml(code)}</code>: ${escapeHtml(message)}</li>`)
    .join('');
  const notice = `<h1>${escapeHtml(app.name)} — Mirage simulation</h1><p>This local bridge uses the Paqvilo adapter. Native Power Apps SDK services require Microsoft's host and online connections. <a href="/_sim/">Select a staff user</a> before using the app. <a href="${escapeHtml(base)}status">Bridge diagnostics</a></p>${diagnostics ? `<ul>${diagnostics}</ul>` : ''}`;
  res.setHeader('content-security-policy', csp);
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    req.method === 'HEAD'
      ? undefined
      : `<!doctype html><html><head><meta charset="utf-8">${title}</head><body>${notice}${body}</body></html>`,
  );
}
