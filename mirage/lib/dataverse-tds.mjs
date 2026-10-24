// Dataverse TDS endpoint: a listener for the read-only SQL surface. Login takes an Entra access
// token (FEDAUTH); the batch runs in dataverse-tds-sql-eval.mjs and every table is read through the Web API record
// handlers as the caller, so table permissions, field security, business units, sharing and service protection apply.
//
// startDataverseTds({ store, authority, principals, records, limits, metadataFields, clock, origin, tlsOrigin, tenantId,
//                     version, tls, host, port, enabled }) -> { port, close() }
//   tls   { key, cert } shared with the HTTPS listener, or null: an in-memory certificate is then generated.
//   enabled false (tds.enabled): the listener still runs, as Dataverse keeps the endpoint reachable, and every login is refused.
//   The caller starts this after the HTTP listeners, so origin and tlsOrigin are known.
import { randomUUID } from 'node:crypto';
import { createSecureContext } from 'node:tls';
import { DataError } from './data-error.mjs';
import { ensureCertificate } from './dataverse-tls.mjs';
import { createTdsServer } from './dataverse-tds-protocol.mjs';
import { buildCatalog, projectRow } from './dataverse-tds-catalog.mjs';
import { executeBatch } from './dataverse-tds-sql-eval.mjs';
import { parseBatch } from './dataverse-tds-sql-parser.mjs';
import { dataverseIdentity } from './dataverse-security.mjs';
import { parseDataverseRoute, parsePrefer } from './dataverse-odata.mjs';

const ANNOTATIONS = 'odata.include-annotations="*"';
const FIVE_MINUTES_MS = 5 * 60_000;
const TWO_MINUTES_MS = 2 * 60_000;
// AST node types that make a batch long-running: a Join or Apply source, or a Derived source (a nested FROM).
const LONG_RUN_NODES = new Set(['Join', 'Apply', 'Derived']);
// The error numbers and texts of the refusals below are guesses.
const SIGN_IN_FAILED = 'Sign-in failed: Request is not authenticated.';
const DISABLED = 'TDS protocol endpoint is disabled for this organization.';
const TIMEOUT = {
  number: -2,
  state: 1,
  class: 11,
  message:
    'Timeout expired. The timeout period elapsed prior to completion of the operation or the server is not responding.',
};
const sqlError = (number, message, cls = 16) => ({ number, message, state: 1, class: cls });
const refOf = (value) => (value !== null && typeof value === 'object' ? value.id : value) ?? undefined;
// The Web API attribute behind a catalog column: lookup columns read `_name_value`, so the select names the lookup.
const attributeOf = (column) => column.source.attribute.replace(/^_(.+)_value$/, '$1');

const ODATA_OPS = { '=': 'eq', '<>': 'ne', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge' };

// An OData literal for a value the evaluator pushed (see pushableValue in dataverse-tds-sql-eval.mjs).
function odataLiteral(sqlType, value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return sqlType === 'uniqueidentifier' ? value : `'${value.replaceAll("'", "''")}'`;
  if (typeof value === 'object') return value.decimal;
  return String(value);
}

// Sets $filter, $top and $orderby from the evaluator's pushdown. Filters address the attribute, not the SQL name.
function applyPushdown(url, table, pushdown) {
  const columnOf = (name) => table.columns.find((c) => c.name === name);
  const clauses = pushdown.filters.map((f) => {
    const { sqlType, source } = columnOf(f.column);
    const literal = (value) => odataLiteral(sqlType, value);
    switch (f.op) {
      case 'is-null':
        return `${source.attribute} eq null`;
      case 'not-null':
        return `${source.attribute} ne null`;
      case 'in':
        return `(${f.values.map((v) => `${source.attribute} eq ${literal(v)}`).join(' or ')})`;
      case 'prefix':
        return `startswith(${source.attribute},${literal(f.value)})`;
      default:
        return `${source.attribute} ${ODATA_OPS[f.op]} ${literal(f.value)}`;
    }
  });
  if (clauses.length) url.searchParams.set('$filter', clauses.join(' and '));
  if (pushdown.top !== null) url.searchParams.set('$top', String(pushdown.top));
  if (pushdown.orderBy) {
    url.searchParams.set(
      '$orderby',
      pushdown.orderBy.map((o) => `${columnOf(o.column).source.attribute} ${o.desc ? 'desc' : 'asc'}`).join(','),
    );
  }
}

// A `*` column (Star) or one of LONG_RUN_NODES anywhere in the tree, subqueries included. String literals are leaves, so
// a literal containing "JOIN" is not a Join.
function hasLongRunShape(node) {
  if (Array.isArray(node)) return node.some(hasLongRunShape);
  if (node === null || typeof node !== 'object') return false;
  if (LONG_RUN_NODES.has(node.type) || node.kind === 'Star') return true;
  return Object.values(node).some(hasLongRunShape);
}

// The query time limit of a batch: 2 minutes for a long-running shape, else 5. A syntax error gets 5 here and fails in the batch.
export function queryLimitMs(sql) {
  let statements;
  try {
    ({ statements } = parseBatch(sql));
  } catch {
    return FIVE_MINUTES_MS;
  }
  return hasLongRunShape(statements) ? TWO_MINUTES_MS : FIVE_MINUTES_MS;
}

export async function startDataverseTds({
  store,
  authority,
  principals,
  records,
  limits,
  metadataFields,
  clock,
  origin,
  tlsOrigin,
  tenantId,
  version,
  tls,
  host,
  port,
  enabled = true,
}) {
  const certificate = tls ?? (await ensureCertificate(null));
  // Wrapped (TDS 7.x) TLS is capped at 1.2; strict (TDS 8) TLS takes the defaults.
  const secureContext = createSecureContext({ key: certificate.key, cert: certificate.cert, maxVersion: 'TLSv1.2' });
  const strictSecureContext = createSecureContext({ key: certificate.key, cert: certificate.cert });
  const stsUrl = `${tlsOrigin ?? origin}/${tenantId}`;
  const apiVersion = `v${version.split('.').slice(0, 2).join('.')}`;

  // FEDAUTH library 0x02 (workflow) gets FEDAUTHINFO first; the token then arrives in a second login. SQL and Windows
  // logins (no FEDAUTH) are refused: the endpoint is Entra ID only.
  // enabled may be a function: the admin Environment settings switch the endpoint off while it runs.
  const isEnabled = () => (typeof enabled === 'function' ? enabled() : enabled);
  function login({ fedAuth }) {
    if (!isEnabled()) return { ok: false, error: sqlError(18456, DISABLED, 14) };
    if (!fedAuth) return { ok: false, error: sqlError(18456, SIGN_IN_FAILED, 14) };
    if (!fedAuth.token) return { fedAuthInfo: { stsUrl, spn: origin } };
    const verdict = authority.verifyBearer(`Bearer ${fedAuth.token}`, { origin, tenantId });
    if (!verdict.ok) return { ok: false, error: sqlError(18456, SIGN_IN_FAILED, 14) };
    const resolved = principals.resolve(verdict.claims);
    if (!resolved.user)
      return { ok: false, error: sqlError(18456, 'Sign-in failed: The user is not a member of the organization.', 14) };
    if (resolved.reason === 'disabled')
      return { ok: false, error: sqlError(18456, 'Sign-in failed: The user is disabled.', 14) };
    return { ok: true, principal: { user: resolved.user, appId: verdict.claims.appid ?? null } };
  }

  // The caller's identity as authenticated() builds it for the HTTP path (no impersonation on this endpoint).
  function identityOf(user, appId) {
    const { hierarchy, userHierarchy, ...identityData } = dataverseIdentity(store, user);
    const dataverse = Object.defineProperties(
      { appId, accessMode: user.accessmode, callerId: user.systemuserid, ...identityData },
      { hierarchy: { value: hierarchy }, userHierarchy: { value: userHierarchy } },
    );
    return {
      admin: true,
      id: user.systemuserid,
      systemUserId: user.systemuserid,
      businessUnitId: refOf(user.businessunitid),
      dataverse,
    };
  }

  async function onQuery({ sql, params, principal, signal }) {
    const { user, appId } = principal;
    // Service protection admits the query as one request for the caller (the HTTP path admits each request).
    const admission = limits.admit(user.systemuserid);
    if (!admission.ok) throw sqlError(40501, admission.error.message, 17);
    const started = clock();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let timedOut = false;
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, queryLimitMs(sql));
    const identity = identityOf(user, appId);

    // One GET of an entity set as the caller; the record handlers apply every security rule.
    async function read(url) {
      const route = parseDataverseRoute(url.pathname);
      if (!route || route.kind === 'unknown' || route.kind === 'invalid')
        throw new DataError(`Invalid object name '${url.pathname}'.`, 400, 'InvalidRoute');
      const result = await records.handle({
        method: 'GET',
        route,
        url,
        origin,
        version: route.version,
        prefer: parsePrefer(ANNOTATIONS),
        headers: { prefer: ANNOTATIONS },
        body: undefined,
        user,
        caller: user,
        identity,
        requestId: randomUUID(),
        bypassCustomPlugins: true, // Retrieve and RetrieveMultiple plug-ins do not run on the TDS endpoint.
      });
      return result ?? { status: 204, headers: {} };
    }

    // Every page of a table, projected onto its catalog columns. Formatted values carry the lookup and choice names.
    async function scan(catalog, logical, { columns, pushdown } = {}) {
      const table = catalog.tables.get(logical);
      const url = new URL(`/api/data/${apiVersion}/${table.entitySet}`, origin);
      const wanted = columns ? table.columns.filter((c) => columns.includes(c.name)) : table.columns;
      url.searchParams.set('$select', [...new Set(wanted.map(attributeOf))].join(','));
      if (pushdown) applyPushdown(url, table, pushdown);
      const rows = [];
      for (let next = url; next;) {
        if (controller.signal.aborted) throw sqlError(3617, 'Query was cancelled by the user.');
        const body = (await read(next)).body ?? {};
        rows.push(...(body.value ?? []));
        next = body['@odata.nextLink'] ? new URL(body['@odata.nextLink'], origin) : null;
      }
      return rows.map((formatted) => projectRow(table, null, formatted));
    }

    try {
      const catalog = buildCatalog({ store, metadataFields });
      return await executeBatch(sql, {
        catalog,
        scan: (logical, request) => scan(catalog, logical, request),
        params,
        principal,
        signal: controller.signal,
        now: () => new Date(clock()),
        collation: store.querySettings().collation,
      });
    } catch (error) {
      if (timedOut) throw TIMEOUT;
      if (error instanceof DataError) throw sqlError(50000, error.message);
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      admission.release(clock() - started);
    }
  }

  const server = createTdsServer({ secureContext, strictSecureContext, onLogin: login, onQuery });
  const address = await server.listen(port, host);
  return { port: address.port, close: () => server.close() };
}
