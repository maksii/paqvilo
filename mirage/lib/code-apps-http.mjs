import { systemIds } from './runtime-clock.mjs';

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
];
const BASE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
};

async function readText(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail(413, 'RequestTooLarge', 'The request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

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
 * (default systemIds, the runtime clock/ids seam).
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
}) {
  // ponytail: one host sessionId per Mirage process; the player renews it on every app open. Per-load ids need a loader-issued cookie.
  const sessionId = ids.uuid();
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
    const match = /^\/_apps\/code\/([^/]+)(\/(.*))?$/.exec(url.pathname);
    if (!match) return false;
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
              environmentId: app.environmentId ?? organization.environmentId ?? organization.organizationId,
              queryParams: Object.fromEntries(url.searchParams),
              dataverseOrgUrl: organization.origin,
              appUrl: new URL(base, url).href,
            },
            user: {
              fullName: row.fullname ?? '',
              objectId: row.azureactivedirectoryobjectid ?? '',
              systemUserId: row.systemuserid,
              tenantId: organization.tenantId ?? '',
              userPrincipalName: row.domainname ?? '',
            },
            host: { sessionId },
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
          const text = await readText(req);
          if (text && /json/i.test(headers['content-type'] ?? '')) {
            try {
              body = JSON.parse(text);
            } catch {
              throw fail(400, 'InvalidJson', 'The request body is not valid JSON.');
            }
          } else body = text || undefined;
        }
        const result = await dataverse({
          method: req.method,
          path: '/api/data/v9.2/' + rest.slice('dataverse/'.length),
          search: url.search,
          headers,
          body,
          principal: { principalId, kind },
        });
        const out = { ...(result.headers ?? {}) };
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
        const reference = (app.connectionReferences ?? []).find(
          (item) => item.key === key || item.dataSources?.includes(key),
        );
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
