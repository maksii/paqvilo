// Connector runtime: one seam that resolves a flow action (or another caller) to a local connection and invokes a provider.
//
// Resolution chain (each failed hop is a coded error, never an implicit success):
//   action host.{apiId, operationId, connectionName}
//     -> workflow properties.connectionReferences[connectionName].connection.connectionReferenceLogicalName
//     -> connectionreference row (connectionreferencelogicalname) -> connectionid
//     -> project connections[connectionid] -> { connector, provider, principal, settings }
//     -> provider.invoke(request, context)
// An action without a connection reference (the built-in Http action) uses connections[<connectorId>] when declared,
// otherwise the connector's built-in provider. A per-flow principal (pack flowIdentities) overrides a connection principal.
//
// Results use the flow output envelope { statusCode, headers?, body, nextLink? }. Diagnostics never carry parameter
// values, URLs, headers or bodies.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import { DataError } from './data-error.mjs';
import { compileDefinition, validateDefinition } from './connector-definition.mjs';
import { isLoopbackUrl, loopbackFetch } from './dataverse-webhooks.mjs';
import { DEAD_LETTER_SUFFIX } from './message-bus.mjs';
import { localOrganizationService, validateServiceProfile } from './local-organization-service.mjs';
import { parseExpand, parseSelect } from './odata-query.mjs';
import { registerSettingParser } from './config-keys.mjs';
import { registerPackExport } from './pack-exports.mjs';
import { createScheduler, storeScheduler } from './runtime-clock.mjs';
import {
  applyResponsePolicies,
  assertContinuationOrigin,
  buildContinuation,
  buildRequest,
  OAUTH_FLOWS,
  rewrite,
  scriptRuns,
} from './custom-connector.mjs';
import { createScriptHost, SDK_MISSING, UNTRUSTED } from './custom-connector-script.mjs';
import { flowVault } from './flow-vault.mjs';
import { packFlowActions } from './flow-actions.mjs';
import { effectiveEnvironmentVariables } from './secret-resolver.mjs';

export const DATAVERSE_CONNECTOR = 'shared_commondataserviceforapps';
const CODES = {
  ConnectorNotConfigured: 501,
  ConnectorNotSimulated: 501,
  ConnectionNotBound: 409,
  ConnectionUnauthorized: 401,
  PermissionDenied: 403,
  OperationUnsupported: 501,
  ProviderUnavailable: 503,
  ProviderTimeout: 504,
  ProviderFailed: 502,
};
const connectorError = (code, message) => new DataError(message, CODES[code], code);
const fail = (code, message) => {
  throw connectorError(code, message);
};
const same = (a, b) => a != null && b != null && String(a).toLowerCase() === String(b).toLowerCase();
const isMap = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => (value === undefined ? null : structuredClone(value));

/** The connector id at the end of an action apiId (`/providers/Microsoft.PowerApps/apis/<id>`). */
export const connectorOf = (apiId) =>
  String(apiId ?? '')
    .split('/')
    .filter(Boolean)
    .pop() ?? '';
/** The connection reference logical name a flow's connectionReferences entry names, or null. */
export const referenceOf = (connectionReferences, connectionName) => {
  const entry = connectionName == null ? null : connectionReferences?.[connectionName];
  return entry?.connection?.connectionReferenceLogicalName ?? entry?.connectionReferenceLogicalName ?? null;
};

const capability = (
  name,
  { level = 'behaviour', operations, requires = [], principal = 'none', stateOwner = 'none', lifecycle = 'per-call' },
) => ({
  name,
  version: 1,
  kind: 'provider',
  level,
  operations: [...operations],
  requires,
  principal,
  stateOwner,
  lifecycle,
});

// ---- built-in providers

// The Dataverse connector operations and
// their parameter keys: one table read by the provider and by the flow interpreter's allowlist (flow-runtime.mjs), so the
// inspect and invoke paths accept the same parameters. item: whether `item` / `item/<column>` keys carry row values.
// Every record operation runs through the SDK service of the flow's principal (local-organization-service.mjs), which writes
// and reads through the organization's internal entries (store.recordPipeline); nothing here writes the store directly.
// Out of scope (listed in the capability record at inventory): GetRelevantRows (no relevance search), PerformBackgroundOperation,
// the *WithOrganization variants (other environments) and InvokeMCP*.
export const DATAVERSE_OPERATION_SPEC = Object.freeze({
  CreateRecord: { parameters: ['entityName'], item: true, level: 'behaviour' },
  // Native "Upsert a row": updates the row with this id, or creates it with this id when it does not exist.
  UpdateRecord: { parameters: ['entityName', 'recordId'], item: true, level: 'behaviour' },
  // Native "Update a row": the row must exist (NotFound otherwise).
  UpdateOnlyRecord: { parameters: ['entityName', 'recordId'], item: true, level: 'behaviour' },
  DeleteRecord: { parameters: ['entityName', 'recordId', 'partitionId'], level: 'behaviour' },
  GetItem: { parameters: ['entityName', 'recordId', '$select', 'partitionId'], level: 'behaviour' },
  // fetchXml runs through the SDK service's secured fetch(); $expand reads each related table through the SDK service
  // (grants, predicates, the Web API read projection); pages of 5,000 rows continue through $skiptoken / @odata.nextLink.
  ListRecords: {
    parameters: ['entityName', '$select', '$filter', '$orderby', '$top', '$expand', 'fetchXml', '$skiptoken'],
    level: 'behaviour',
  },
  AssociateEntities: {
    parameters: ['entityName', 'recordId', 'associationEntityRelationship', '@odata.id'],
    level: 'behaviour',
  },
  DisassociateEntities: {
    parameters: ['entityName', 'recordId', 'associationEntityRelationship', '$id'],
    level: 'behaviour',
  },
  GetEntityFileImageFieldContent: {
    parameters: ['entityName', 'recordId', 'fileImageFieldName', 'size'],
    level: 'contract',
  },
  UpdateEntityFileImageFieldContent: {
    parameters: ['entityName', 'recordId', 'fileImageFieldName', 'item', 'x-ms-file-name'],
    level: 'contract',
  },
  PerformBoundAction: { parameters: ['entityName', 'actionName', 'recordId'], item: true, level: 'contract' },
  PerformUnboundAction: { parameters: ['actionName'], item: true, level: 'contract' },
  // The ChangeSet scope (flow-runtime.mjs): its Create/Update/Upsert/Delete requests in one SDK savepoint.
  ExecuteChangeset: { parameters: ['requests'], level: 'behaviour' },
});
const DATAVERSE_OPERATIONS = Object.keys(DATAVERSE_OPERATION_SPEC);
export const CHANGESET_OPERATIONS = Object.freeze(['CreateRecord', 'UpdateRecord', 'UpdateOnlyRecord', 'DeleteRecord']);
/** The parameter keys an operation accepts: { allowed(key) } from DATAVERSE_OPERATION_SPEC, or null for an unknown operation. */
export function dataverseParameters(operationId) {
  const spec = Object.hasOwn(DATAVERSE_OPERATION_SPEC, operationId) ? DATAVERSE_OPERATION_SPEC[operationId] : null;
  return spec && { allowed: (key) => spec.parameters.includes(key) || (spec.item === true && key.startsWith('item/')) };
}
// A related row URL (@odata.id / $id): relative (`x_items(<id>)`, `/api/data/v9.2/x_items(<id>)`) or on a loopback origin
// (this local organization). Any other origin is refused: the row of another organization is never related here.
function relatedRow(store, value) {
  const bad = (message) => {
    throw new DataError(message, 400, 'LocalFlowExpression');
  };
  if (typeof value !== 'string' || !value) bad('The related row URL is missing.');
  let path = value;
  if (/^https?:/i.test(value)) {
    let url;
    try {
      url = new URL(value);
    } catch {
      bad('The related row URL is invalid.');
    }
    if (!isLoopbackUrl(url.href))
      bad('The related row URL names another organization; only this local organization is related.');
    path = url.pathname;
  }
  const match = /(?:^|\/)([A-Za-z_][\w]*)\(\{?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}?\)\/?$/i.exec(path);
  if (!match) bad('The related row URL must end with <entity set>(<row id>).');
  return { logicalName: store.resolveMapping(match[1]).logicalName, id: match[2].toLowerCase() };
}
const LIST_PAGE = 5000;
// ListRecords $expand: each expanded navigation reads its table once through the SDK service (explicit read grants and their
// predicates, the Web API read projection), then attaches the rows whose `to` column matches the parent's `from` column;
// the parent's $select applies after the match. A many-to-many navigation needs its intersect rows: 501.
// ponytail: one read of the whole related table per navigation and page; a keyed SDK read when related tables grow large.
function expandRows(store, service, entity, rows, specs, select) {
  const mapping = store.resolveMapping(entity),
    relationships = store.relationshipsFor(mapping, { dataverse: true });
  for (const spec of specs) {
    const rel = expandable(relationships, spec.navigation, mapping);
    const query = Object.fromEntries(
      [
        ['$filter', spec.filter],
        ['$orderby', spec.orderby],
      ].filter(([, v]) => v != null),
    );
    const targets = service.query(rel.entity, query).value,
      keys = targets.map((target) => target[rel.to]);
    expandRows(store, service, rel.entity, targets, spec.expand, spec.select);
    for (const row of rows) {
      let linked = row[rel.from] == null ? [] : targets.filter((_, i) => same(keys[i], row[rel.from]));
      if (spec.top != null) linked = linked.slice(0, Number(spec.top));
      row[spec.navigation] = rel.many === false ? (linked[0] ?? null) : linked;
    }
  }
  if (select)
    rows.splice(
      0,
      rows.length,
      ...rows.map((row) =>
        selected(
          store,
          entity,
          row,
          select,
          specs.map((s) => s.navigation),
        ),
      ),
    );
}
function expandable(relationships, navigation, mapping) {
  const rel = Object.hasOwn(relationships, navigation) ? relationships[navigation] : null;
  if (!rel) throw new DataError(`No relationship ${navigation} on ${mapping.logicalName}.`, 400, 'LocalFlowExpression');
  if (rel.intersect)
    throw new DataError(
      `Expanding the many-to-many relationship ${navigation} is not run by local flow actions.`,
      501,
      'LocalFlowUnsupported',
    );
  return rel;
}
const selected = (store, logical, row, select, navigations) => {
  const keep = new Set([...parseSelect(select), store.resolveMapping(logical).idColumn, ...navigations]);
  return Object.fromEntries(Object.entries(row).filter(([key]) => keep.has(key.split('@')[0])));
};
// The SDK service writes through the organization's internal entries (store.recordPipeline): a flow Dataverse action runs
// the Web API write rules on the asynchronous pipeline (createAsync/updateAsync/removeAsync): its synchronous plug-in steps
// and service endpoint posts are awaited in process, and its record hooks finish before the action answers.
// Relate/unrelate use the service's associateAsync/disassociateAsync: with an organization it runs
// store.recordPipeline.associateInternal / disassociateInternal (asynchronous drive, write hooks) with the explicit-grant check
// and plug-in stages as its write (plugin-association.mjs executeAssociationAsync); without one, executeAssociationAsync alone,
// so a synchronous service endpoint step's post is awaited in process. Files and bound/unbound actions need organization entries
// (store.recordPipeline.fileContentInternal, executeMessageInternal); without them they answer OperationUnsupported (501).
function dataverseProvider(store, diagnostic) {
  const notWired = (what) => {
    throw new DataError(
      `${what} needs the organization's in-process entry, which this runtime does not provide.`,
      501,
      'OperationUnsupported',
    );
  };
  const run = (service, operationId, p, context) => {
    const entity = p.entityName;
    if (!['PerformUnboundAction', 'ExecuteChangeset'].includes(operationId) && typeof entity !== 'string')
      throw new DataError('Dataverse action entityName is missing.', 400, 'LocalFlowExpression');
    const values = {
      ...(isMap(p.item) ? p.item : {}),
      ...Object.fromEntries(
        Object.entries(p)
          .filter(([k]) => k.startsWith('item/'))
          .map(([k, v]) => [k.slice(5), v]),
      ),
    };
    switch (operationId) {
      // Row writes run on the asynchronous pipeline (a flow action is not nested inside a plug-in): a synchronous service
      // endpoint step's post is awaited in process, so Mirage keeps serving while it waits and an in-process receiver answers.
      case 'CreateRecord':
        return service.createAsync(entity, values).then((row) => ({ statusCode: 201, body: clone(row) }));
      case 'UpdateOnlyRecord':
        return service.updateAsync(entity, p.recordId, values).then((row) => ({ statusCode: 200, body: clone(row) }));
      case 'UpdateRecord': {
        // Assumed: the status codes of the upsert answers (201 created, 200 updated).
        let exists = true;
        try {
          service.get(entity, p.recordId);
        } catch (error) {
          if (error.code !== 'NotFound') throw error;
          exists = false;
        }
        if (exists)
          return service.updateAsync(entity, p.recordId, values).then((row) => ({ statusCode: 200, body: clone(row) }));
        return service
          .createAsync(entity, { ...values, [store.resolveMapping(entity).idColumn]: p.recordId })
          .then((row) => ({ statusCode: 201, body: clone(row) }));
      }
      case 'DeleteRecord':
        return service
          .removeAsync(entity, p.recordId, p.partitionId != null ? { partitionId: p.partitionId } : {})
          .then(() => ({ statusCode: 204, body: {} }));
      case 'GetItem': {
        if (p.$select != null && typeof p.$select !== 'string')
          throw new DataError('GetItem select columns require a comma-separated string.', 400, 'LocalFlowExpression');
        const selected = parseSelect(p.$select);
        if (selected?.some((name) => /^_(.+)_value$/.test(name)))
          throw new DataError(
            'GetItem lookup aliases require an explicit connector projection adapter.',
            501,
            'LocalFlowUnsupported',
          );
        return {
          statusCode: 200,
          body: service.get(
            entity,
            p.recordId,
            selected ? { allColumns: false, columns: selected } : undefined,
            p.partitionId != null ? { partitionId: p.partitionId } : {},
          ),
        };
      }
      case 'ListRecords': {
        // 5,000 rows per page; without the pagination setting the answer carries
        // @odata.nextLink, whose skip token ($skiptoken) the next List rows call passes back.
        // Assumed: the skip token's format (a paging cookie with the page number) and the nextLink's host (relative here).
        const page = p.$skiptoken == null ? 1 : Number(/pagenumber="(\d+)"/.exec(String(p.$skiptoken))?.[1]);
        if (!(page >= 1))
          throw new DataError('The skip token is not one a List rows answer issued.', 400, 'LocalFlowExpression');
        const answer = (rows, more, rest = {}) => {
          const link = more
            ? `${store.resolveMapping(entity).entitySet}?$skiptoken=${encodeURIComponent(`<cookie pagenumber="${page + 1}" />`)}`
            : null;
          return {
            statusCode: 200,
            body: { ...rest, value: rows, ...(link ? { '@odata.nextLink': link } : {}) },
            ...(link ? { nextLink: link } : {}),
          };
        };
        if (p.fetchXml != null) {
          // Native behaviour when FetchXML is combined with the OData options is not known; refused here.
          if (['$select', '$filter', '$orderby', '$top', '$expand'].some((key) => p[key] !== undefined))
            throw new DataError(
              'A FetchXML query is not combined with $select, $filter, $orderby, $top or $expand.',
              400,
              'LocalFlowExpression',
            );
          const xml = String(p.fetchXml).replace(
            /<fetch\b([^>]*?)(\/?)>/i,
            (_, attrs, close) => `<fetch${attrs.replace(/\s+page\s*=\s*(["'])[^"']*\1/i, '')} page="${page}"${close}>`,
          );
          const fetched = service.fetch(xml);
          return answer(fetched.entities, fetched.more_records === true);
        }
        const q = {};
        for (const key of ['$filter', '$orderby', '$top', ...(p.$expand ? [] : ['$select'])])
          if (p[key] !== undefined) q[key] = p[key];
        const { value: all, ...rest } = service.query(entity, q);
        // ponytail: every page re-reads the whole filtered list; store keyset paging when lists outgrow memory.
        const rows = all.slice((page - 1) * LIST_PAGE, page * LIST_PAGE);
        if (p.$expand) expandRows(store, service, entity, rows, parseExpand(p.$expand), p.$select);
        return answer(rows, all.length > page * LIST_PAGE, rest);
      }
      case 'AssociateEntities':
      case 'DisassociateEntities': {
        const related = relatedRow(store, operationId === 'AssociateEntities' ? p['@odata.id'] : p.$id);
        if (typeof p.associationEntityRelationship !== 'string' || !p.associationEntityRelationship)
          throw new DataError('The relationship name is missing.', 400, 'LocalFlowExpression');
        return service[operationId === 'AssociateEntities' ? 'associateAsync' : 'disassociateAsync'](
          entity,
          String(p.recordId ?? ''),
          { $type: 'Relationship', schemaName: p.associationEntityRelationship },
          {
            $type: 'EntityReferenceCollection',
            values: [{ $type: 'EntityReference', logicalName: related.logicalName, id: related.id }],
          },
        ).then(() => ({ statusCode: 204, body: {} }));
      }
      case 'GetEntityFileImageFieldContent':
      case 'UpdateEntityFileImageFieldContent': {
        const entry = store.recordPipeline?.fileContentInternal;
        if (typeof entry !== 'function') notWired('A Dataverse file or image column action');
        return entry({
          principal: context.principal,
          operation: operationId === 'GetEntityFileImageFieldContent' ? 'download' : 'upload',
          entity,
          id: p.recordId,
          column: p.fileImageFieldName,
          size: p.size ?? null,
          content: p.item ?? null,
          fileName: p['x-ms-file-name'] ?? null,
        });
      }
      case 'PerformBoundAction':
      case 'PerformUnboundAction': {
        const entry = store.recordPipeline?.executeMessageInternal;
        if (typeof entry !== 'function') notWired('A Dataverse bound or unbound action');
        if (typeof p.actionName !== 'string' || !p.actionName)
          throw new DataError('The action name is missing.', 400, 'LocalFlowExpression');
        return entry({
          principal: context.principal,
          name: p.actionName,
          target: operationId === 'PerformBoundAction' ? { entity, id: p.recordId } : null,
          parameters: values,
        });
      }
      case 'ExecuteChangeset': {
        const requests = p.requests;
        if (
          !Array.isArray(requests) ||
          !requests.length ||
          requests.some((r) => !isMap(r) || !CHANGESET_OPERATIONS.includes(r.operationId))
        )
          throw new DataError(
            'A changeset holds only Add, Update, Upsert and Delete row requests.',
            400,
            'LocalFlowExpression',
          );
        // One SDK savepoint: a failed request rolls back every earlier request of the changeset. The savepoint is promoted to
        // a full state copy because each request is itself a nested SDK call whose row journal ends with it.
        // ponytail: O(state) copy per changeset; a nested row journal in DataStore.sdkMutation would make it O(rows written).
        // Each request joins that savepoint (pluginInTransaction) instead of committing on its own.
        return store
          .sdkMutationAsync(async () => {
            store.promoteRowTransaction();
            const joined = store.pluginInTransaction;
            store.pluginInTransaction = true;
            try {
              const responses = [];
              for (const r of requests)
                responses.push({
                  name: r.name ?? null,
                  ...(await run(service, r.operationId, r.parameters ?? {}, context)),
                });
              return responses;
            } finally {
              store.pluginInTransaction = joined;
            }
          })
          .then((responses) => ({ statusCode: 200, body: { responses } }));
      }
      default:
        throw new DataError('Unsupported local Dataverse flow operation.', 501, 'LocalFlowUnsupported');
    }
  };
  return {
    id: 'dataverse',
    connectors: [DATAVERSE_CONNECTOR],
    operations: DATAVERSE_OPERATIONS,
    capability: capability('dataverse', {
      operations: [
        ...DATAVERSE_OPERATIONS.map((name) => ({ name, level: DATAVERSE_OPERATION_SPEC[name].level })),
        ...['GetRelevantRows', 'PerformBackgroundOperation', 'InvokeMCP'].map((name) => ({ name, level: 'inventory' })),
      ],
      requires: ['store'],
      principal: 'required',
      stateOwner: 'store',
    }),
    invoke({ operationId, parameters, nextLink }, context) {
      if (!context.principal)
        throw new DataError(
          'Dataverse flow actions require an explicit project backend identity/security profile.',
          409,
          'LocalBackendIdentityRequired',
        );
      const spec = dataverseParameters(operationId);
      // A later page (pagination policy) is the same List rows call with the nextLink's skip token.
      const p = nextLink
        ? { ...parameters, $skiptoken: new URL(nextLink, 'http://localhost/').searchParams.get('$skiptoken') }
        : (parameters ?? {});
      if (!spec) throw new DataError('Unsupported local Dataverse flow operation.', 501, 'LocalFlowUnsupported');
      for (const key of Object.keys(p))
        if (!spec.allowed(key))
          throw new DataError(`Unsupported Dataverse parameter ${operationId}/${key}.`, 501, 'LocalFlowUnsupported');
      return run(
        localOrganizationService(store, context.principal, undefined, { diagnostic }),
        operationId,
        p,
        context,
      );
    },
  };
}

// URL rewrites (custom-connector.mjs): the longest matching prefix wins, applied before the loopback check.
export { rewrite };
// The Http action request: method, uri, headers, body, queries (nextLink replaces uri for later pages, on the uri's host
// only: assertContinuationOrigin, the rule custom connector pages use).
function httpRequest({ parameters, nextLink }, settings) {
  const p = parameters ?? {};
  let raw = p.uri ?? p.url;
  if (typeof raw !== 'string' || !raw) fail('ProviderFailed', 'The http request uri is missing.');
  if (nextLink)
    try {
      raw = assertContinuationOrigin(nextLink, raw, settings?.rewrites).href;
    } catch (error) {
      fail(CODES[error.code] ? error.code : 'ProviderFailed', error.message);
    }
  let url = rewrite(raw, settings?.rewrites);
  if (!nextLink && isMap(p.queries)) {
    try {
      const parsed = new URL(url);
      for (const [k, v] of Object.entries(p.queries)) parsed.searchParams.append(k, String(v));
      url = parsed.href;
    } catch {
      fail('ProviderFailed', 'The http request uri is invalid.');
    }
  }
  const headers = isMap(p.headers) ? Object.fromEntries(Object.entries(p.headers).map(([k, v]) => [k, String(v)])) : {};
  const json = p.body !== undefined && p.body !== null && typeof p.body !== 'string';
  if (json && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type'))
    headers['content-type'] = 'application/json';
  return {
    method: String(nextLink ? 'GET' : (p.method ?? 'GET')).toUpperCase(),
    url,
    headers,
    body: p.body == null ? undefined : json ? JSON.stringify(p.body) : p.body,
  };
}
const nextLinkOf = (body) => (isMap(body) ? (body['@odata.nextLink'] ?? body.nextLink ?? undefined) : undefined);

// Sends one built request to a loopback URL (the http provider and compiled custom connectors share it).
async function sendLoopback({ method, url, headers, body }, context) {
  if (!isLoopbackUrl(url))
    fail(
      'ProviderUnavailable',
      'The http provider reaches only loopback URLs; declare a connection rewrite to a local service.',
    );
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.max(1, context.timeoutMs ?? 2000)),
    ...(context.signal ? [context.signal] : []),
  ]);
  let response;
  try {
    response = await loopbackFetch(url, {
      method,
      headers,
      ...(body === undefined || ['GET', 'HEAD'].includes(method) ? {} : { body }),
      signal,
    });
  } catch (error) {
    if (['TimeoutError', 'AbortError'].includes(error.name))
      fail('ProviderTimeout', 'The local http service did not answer within the action time limit.');
    if (/redirect/i.test(String(error.cause?.message ?? error.message)))
      fail('ProviderFailed', 'The local http service answered with a redirect; redirects are refused.');
    fail('ProviderUnavailable', 'The local http service is unreachable.');
  }
  const text = await response.text();
  let parsed = text;
  if (/json/i.test(response.headers.get('content-type') ?? '') && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      fail('ProviderFailed', 'The local http service answered with invalid JSON.');
    }
  }
  const nextLink = nextLinkOf(parsed);
  return {
    statusCode: response.status,
    headers: Object.fromEntries(response.headers),
    body: text ? parsed : null,
    ...(nextLink ? { nextLink } : {}),
  };
}
// The GET of an asynchronous operation's status URL (202 + Location): resolved against the request URI (followAsync passes a
// later Location already resolved against the previous status URL), then the connection rewrites; only loopback
// (sendLoopback) or a pack http fixture answers it. The answer carries statusUrl, the base of the next relative Location. The headers
// the native engine sends with a status poll are not known; none are forwarded here, so no credential reaches the status URL.
const statusUrlOf = (location, { parameters }) => new URL(location, parameters?.uri ?? parameters?.url).href;
const pollRequest = (statusUrl, settings) => ({
  method: 'GET',
  url: rewrite(statusUrl, settings?.rewrites),
  headers: {},
});
function httpProvider() {
  return {
    id: 'http',
    connectors: ['http'],
    operations: ['Http'],
    capability: capability('http', { operations: ['Http'], requires: ['loopback-network'] }),
    invoke: (request, context) => sendLoopback(httpRequest(request, context.settings), context),
    async poll(location, request, context) {
      const statusUrl = statusUrlOf(location, request);
      return { ...(await sendLoopback(pollRequest(statusUrl, context.settings), context)), statusUrl };
    },
  };
}

function fixtureProvider(fixtures) {
  return {
    id: 'fixture',
    connectors: ['http'],
    operations: ['Http'],
    capability: capability('fixture', { operations: ['Http'], requires: ['pack:httpFixtures'] }),
    async invoke(request, context) {
      return (
        (await fixtureAnswer(fixtures, httpRequest(request, context.settings))) ??
        fail('ConnectorNotConfigured', 'No pack http fixture matches this request.')
      );
    },
    async poll(location, request, context) {
      const statusUrl = statusUrlOf(location, request);
      return {
        ...((await fixtureAnswer(fixtures, pollRequest(statusUrl, context.settings))) ??
          fail('ConnectorNotConfigured', 'No pack http fixture matches the status request.')),
        statusUrl,
      };
    },
  };
}
// The pack httpFixtures answer of a built request, or null when no fixture matches.
async function fixtureAnswer(fixtures, req) {
  const fixture = fixtures.find((f) => (f.method === '*' || same(f.method, req.method)) && f.url.test(req.url));
  if (!fixture) return null;
  const answer = await fixture.respond(structuredClone(req));
  if (!isMap(answer)) fail('ProviderFailed', 'The http fixture returned no response object.');
  const nextLink = nextLinkOf(answer.body);
  return {
    statusCode: answer.status ?? 200,
    headers: answer.headers ?? {},
    body: answer.body ?? null,
    ...(nextLink ? { nextLink } : {}),
  };
}

// A compiled Solution custom connector (custom-connector.mjs) at contract: the operation's request is built from the
// OpenAPI definition and its request policy templates (in order), then answered by its C# script (scriptOperations, through
// the local .NET SDK: custom-connector-script.mjs), or by a matching pack http fixture, or sent to a loopback URL after the
// connection rewrites; the Response policy templates apply to the answer. Credentials come only from env:/variable:
// references in the connection settings (auth: { apiKey } | { username, password } | { token } | { clientId, clientSecret });
// connection parameters from settings.parameters; @environmentVariables("n") reads the effective non-secret value. A later
// page (nextLink) and an asynchronous status URL go through buildContinuation (same host only, auth and request policies
// reapplied). The OAuth client credentials flow posts to the definition's tokenUrl (after the rewrites, loopback or pack
// fixture only); its token is cached in this provider's memory until expires_in. The authorization code flow (accessCode)
// uses the token a sign-in stored for the connection (oauth.begin: loopback redirect with PKCE, RFC 7636) and refreshes it
// with its refresh token; tokens live sealed in the connection's state (connectionTokens), never in config or diagnostics.
// The preflight note of a trusted script: its host build reaches the network once (custom-connector-script.mjs).
const SCRIPT_RESTORE =
  'CONNECTOR_SCRIPT_NUGET_RESTORE: the first build of the trusted script host restores Newtonsoft.Json and Microsoft.Extensions.Logging.Abstractions from nuget.org (not loopback; offline it fails); the host runs with your user rights, unsandboxed.';
function customConnectorProvider(connector, fixtures, store, { tokens, scripts, now, diagnostic = () => {} }) {
  const cached = new Map();
  const send = (req, context) =>
    Promise.resolve(fixtureAnswer(fixtures, req)).then((answer) => answer ?? sendLoopback(req, context));
  const form = (grant, credentials, extra) =>
    new URLSearchParams({
      grant_type: grant,
      client_id: credentials.clientId,
      ...(credentials.clientSecret != null ? { client_secret: credentials.clientSecret } : {}),
      ...extra,
    }).toString();
  async function tokenRequest(body, context) {
    const req = {
      method: 'POST',
      url: rewrite(connector.auth.tokenUrl, context.settings?.rewrites),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    };
    const answer = await send(req, context);
    if (answer.statusCode >= 300 || typeof answer.body?.access_token !== 'string')
      fail('ConnectionUnauthorized', 'The OAuth token endpoint issued no access token.');
    return answer.body;
  }
  const scope = () => (connector.auth.scopes.length ? { scope: connector.auth.scopes.join(' ') } : {});
  async function withToken(credentials, context) {
    const auth = connector.auth;
    if (auth.type !== 'oauth' || credentials.token != null || !OAUTH_FLOWS.includes(auth.flow)) return credentials;
    if (!auth.tokenUrl) fail('ConnectionUnauthorized', 'The OAuth flow needs a tokenUrl in the definition.');
    const time = context.clock?.now?.() ?? now();
    if (auth.flow === 'accessCode') {
      const key = context.connectionId ?? connector.name,
        current = tokens.get(key);
      if (!current) return credentials;
      if (current.expiresAt == null || current.expiresAt > time + 5000)
        return { ...credentials, token: current.access_token };
      if (!current.refresh_token || credentials.clientId == null) {
        await tokens.set(key, null);
        return credentials;
      }
      // The refresh token grant (RFC 6749 section 6); a rotated refresh token replaces the old one.
      const body = await tokenRequest(
        form('refresh_token', credentials, { refresh_token: current.refresh_token, ...scope() }),
        context,
      );
      await tokens.set(key, {
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? current.refresh_token,
        expiresAt: body.expires_in ? time + Number(body.expires_in) * 1000 : null,
      });
      return { ...credentials, token: body.access_token };
    }
    if (credentials.clientId == null || credentials.clientSecret == null)
      fail(
        'ConnectionUnauthorized',
        'The OAuth client credentials flow needs clientId and clientSecret references and a tokenUrl in the definition.',
      );
    const key = auth.tokenUrl + '\n' + credentials.clientId,
      hit = cached.get(key);
    if (hit && hit.expires > time) return { ...credentials, token: hit.token };
    const body = await tokenRequest(form('client_credentials', credentials, scope()), context);
    cached.set(key, { token: body.access_token, expires: time + (Number(body.expires_in) || 0) * 1000 });
    return { ...credentials, token: body.access_token };
  }
  const variables = () => (store?.state ? effectiveEnvironmentVariables(store.state) : {});
  const reference = (value) => {
    if (typeof value !== 'string' || !REFERENCE.test(value)) return value;
    const [kind, name] = [value.slice(0, value.indexOf(':')), value.slice(value.indexOf(':') + 1)];
    if (kind === 'env') return process.env[name] ?? null;
    const entry = variables()[name.toLowerCase()];
    return entry && !entry.secret ? (entry.value ?? null) : null;
  };
  const resolved = (map) =>
    Object.fromEntries(
      Object.entries(isMap(map) ? map : {})
        .map(([k, v]) => [k, reference(v)])
        .filter(([, v]) => v != null),
    );
  const environment = (name) => {
    const entry = variables()[String(name).toLowerCase()];
    return entry && !entry.secret ? (entry.value ?? null) : null;
  };
  // Script operations run only for a script the project trusts (connectorScripts) and with the .NET SDK: otherwise they are not
  // served and name the gap (CONNECTOR_SCRIPT_UNTRUSTED before CONNECTOR_SCRIPT_SDK_MISSING); nothing is built for them.
  const scripted = (operationId) => scriptRuns(connector, operationId);
  const gap = !connector.script
    ? null
    : !scripts.trusts(connector.name, connector.script)
      ? UNTRUSTED
      : !scripts.available()
        ? SDK_MISSING
        : null;
  const gapMessage = () =>
    gap === UNTRUSTED ? scripts.untrusted(connector.name, connector.script) : scripts.missing();
  const sdkMissing = gap !== null;
  const operations = connector.blocked
    ? []
    : Object.keys(connector.operations).filter((id) => !(sdkMissing && scripted(id)));
  if (connector.script && !connector.blocked && !sdkMissing)
    scripts.prepare(connector.script, connector.name).catch((error) =>
      diagnostic({
        code: 'CONNECTOR_SCRIPT_BUILD_FAILED',
        connector: connector.name,
        error: { code: error.code ?? 'ProviderFailed', message: error.message },
      }),
    );
  const level = connector.blocked ? 'inventory' : 'contract';
  async function request(operationId, parameters, nextLink, context) {
    let req, connection;
    try {
      connection = {
        parameters: resolved(context.settings?.parameters),
        environment,
        credentials: await withToken(resolved(context.settings?.auth), context),
      };
      req = nextLink
        ? buildContinuation(connector, operationId, nextLink, parameters ?? {}, connection, context.settings?.rewrites)
        : buildRequest(connector, operationId, parameters ?? {}, connection);
    } catch (error) {
      fail(CODES[error.code] ? error.code : 'ProviderFailed', error.message);
    }
    if (req.body instanceof FormData) {
      const encoded = new Response(req.body);
      req.headers['content-type'] = encoded.headers.get('content-type');
      req.body = new Uint8Array(await encoded.arrayBuffer());
    }
    return { req, connection };
  }
  // The loopback (or fixture) exchange of one request after the connection rewrites.
  const exchange = (req, context) => send({ ...req, url: rewrite(req.url, context.settings?.rewrites) }, context);
  return {
    id: 'custom-connector:' + connector.name,
    connectors: connector.connectorIds,
    operations,
    blocked: connector.blocked,
    oauth:
      connector.auth.type === 'oauth'
        ? {
            flow: connector.auth.flow,
            begin: (connectionId, settings, options) =>
              beginAuthorization(connector, connectionId, settings, {
                ...options,
                resolved,
                tokens,
                now,
                tokenRequest,
                form,
                scope,
              }),
          }
        : null,
    reason: (operationId) => (sdkMissing && scripted(operationId) && !connector.blocked ? gapMessage() : null),
    capability: {
      ...capability('custom-connector:' + connector.name, {
        level,
        operations: [
          ...Object.keys(connector.operations).map((name) => ({
            name,
            level: sdkMissing && scripted(name) ? 'inventory' : level,
          })),
          ...connector.policies.map((p) => ({
            name: 'policy:' + p.templateId,
            level: p.supported ? 'contract' : 'inventory',
          })),
          ...(connector.script
            ? [
                {
                  name: 'script',
                  level: sdkMissing ? 'inventory' : level,
                  reason: sdkMissing ? gapMessage() : SCRIPT_RESTORE,
                },
              ]
            : []),
        ],
        requires: ['loopback-network', ...(connector.script ? ['dotnet-sdk'] : [])],
      }),
      ...(connector.blocked ? { reason: connector.blocked.code } : sdkMissing ? { reason: gap } : {}),
    },
    async invoke({ operationId, parameters, nextLink }, context) {
      const { req, connection } = await request(operationId, parameters, nextLink, context);
      // The script replaces the backend request; Context.SendAsync goes through the same rewrites, fixtures and loopback rule.
      const answer =
        scripted(operationId) && !nextLink
          ? await scripts.run({
              connector: connector.name,
              script: connector.script,
              operationId,
              correlationId: context.correlationId ?? null,
              request: req,
              timeoutMs: context.timeoutMs ?? 120000,
              signal: context.signal ?? null,
              send: (outgoing) => exchange(outgoing, context),
            })
          : await exchange(req, context);
      return applyResponsePolicies(connector, operationId, answer, connection);
    },
    async poll(location, { operationId, parameters }, context) {
      const { req, connection } = await request(operationId, parameters, location, context);
      return {
        ...applyResponsePolicies(connector, operationId, await exchange(req, context), connection),
        statusUrl: req.url,
      };
    },
  };
}

// The authorization code sign-in of one connection (OpenAPI 2.0 flow accessCode): a one-time loopback redirect listener
// (http://127.0.0.1:<port>/callback, RFC 8252 section 7.3) receives the code, which is exchanged with the PKCE verifier
// (RFC 7636, S256). Deliberate difference: the native consent redirect (the connector's own redirect URL) is replaced by the loopback one.
// Answers { authorizeUrl, redirectUri, expiresAt, completion }; completion resolves { connectionId, expiresAt } once signed in.
async function beginAuthorization(
  connector,
  connectionId,
  settings,
  { resolved, tokens, now, tokenRequest, form, scope, timeoutMs = 10 * 60000 },
) {
  const auth = connector.auth,
    credentials = resolved(settings.auth);
  if (!auth.authorizationUrl || !auth.tokenUrl)
    fail(
      'ConnectionUnauthorized',
      'The authorization code flow needs authorizationUrl and tokenUrl in the definition.',
    );
  if (credentials.clientId == null)
    fail(
      'ConnectionUnauthorized',
      'The authorization code flow needs a clientId reference in the connection settings.',
    );
  const encode = (bytes) => bytes.toString('base64url');
  const verifier = encode(randomBytes(32)),
    challenge = encode(createHash('sha256').update(verifier).digest()),
    state = encode(randomBytes(16));
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`,
    expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  const url = new URL(rewrite(auth.authorizationUrl, settings.rewrites));
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: credentials.clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...scope(),
  }))
    url.searchParams.set(k, v);
  const page = (res, status, text) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><title>Mirage connection</title><p>${text}</p>`);
  };
  let timer;
  const completion = new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      server.close();
      error ? reject(error) : resolve(value);
    };
    timer = setTimeout(
      () =>
        finish(
          new DataError('The connection sign-in was not completed in time.', 408, 'ConnectionAuthorizationExpired'),
        ),
      timeoutMs,
    );
    timer.unref?.();
    server.on('request', async (req, res) => {
      const query = new URL(req.url, redirectUri).searchParams;
      if (new URL(req.url, redirectUri).pathname !== '/callback') return page(res, 404, 'Not found.');
      if (query.get('state') !== state) return page(res, 400, 'The sign-in answer does not belong to this request.');
      if (query.get('error')) {
        page(res, 400, 'The sign-in was refused.');
        return finish(new DataError('The authorization server refused the sign-in.', 401, 'ConnectionUnauthorized'));
      }
      try {
        const body = await tokenRequest(
          form('authorization_code', credentials, {
            code: query.get('code') ?? '',
            redirect_uri: redirectUri,
            code_verifier: verifier,
          }),
          { settings, timeoutMs: 10000 },
        );
        const at = now(),
          stored = {
            access_token: body.access_token,
            refresh_token: body.refresh_token ?? null,
            expiresAt: body.expires_in ? at + Number(body.expires_in) * 1000 : null,
          };
        await tokens.set(connectionId, stored);
        page(res, 200, 'The connection is signed in. You can close this window.');
        finish(null, {
          connectionId,
          expiresAt: stored.expiresAt == null ? null : new Date(stored.expiresAt).toISOString(),
        });
      } catch (error) {
        page(res, 401, 'The sign-in could not be completed.');
        finish(error.code ? error : connectorError('ConnectionUnauthorized', 'The token exchange failed.'));
      }
    });
  });
  completion.catch(() => {});
  return { authorizeUrl: url.href, redirectUri, expiresAt, completion };
}

function packProvider(pack) {
  const connectors = Object.keys(pack.connectors);
  const operations = [...new Set(connectors.flatMap((id) => Object.keys(pack.connectors[id].operations)))];
  return {
    id: 'pack:' + pack.id,
    connectors,
    operations: null, // per connector, checked in supportsOperation
    capability: capability('pack:' + pack.id, { operations, requires: ['pack:' + pack.id] }),
    supportsOperation: (connectorId, operationId) =>
      Object.hasOwn(pack.connectors[connectorId]?.operations ?? {}, operationId),
    async invoke(request, context) {
      const answer = await pack.connectors[request.connectorId].operations[request.operationId](
        structuredClone({
          connectorId: request.connectorId,
          operationId: request.operationId,
          parameters: request.parameters ?? {},
          ...(request.nextLink ? { nextLink: request.nextLink } : {}),
        }),
        context,
      );
      if (!isMap(answer) || !Number.isInteger(answer.statusCode))
        fail('ProviderFailed', 'The pack connector returned no { statusCode, body } result.');
      return answer;
    },
  };
}

// Local mechanics are behaviour; parity with the native connector (status codes, full output envelope) is contract only.
const levelled = (operations, parity) => [
  ...operations.map((name) => ({ name, level: 'behaviour' })),
  { name: parity, level: 'contract' },
];
const param = (p, key, wrapper) =>
  p[key] ?? (wrapper ? (p[`${wrapper}/${key}`] ?? (isMap(p[wrapper]) ? p[wrapper][key] : undefined)) : undefined);

// Approvals (shared_approvals): CreateAnApproval (approvalType + ApprovalCreationInput), StartAndWaitForAnApproval
// (approvalType + WebhookApprovalCreationInput), WaitForAnApproval (approvalName). Output field names follow the documented
// TextSuggestionApprovalCreationOutput (name, title, details, outcome, requestDate, completionDate, responses[] with
// responder, requestDate, responseDate, approverResponse, comments); "Approve"/"Reject" are case-sensitive.
// Assumed: the outputs of the dynamic operations, their status codes, and the per-type completion rules (only the
// Basic "first to respond" rule is applied: the first response completes the approval).
// A waiting operation answers { suspended: { kind: 'approval', id, timeoutAt, assignedTo } }; only a caller that sets
// context.canSuspend (the flow run store integration) receives it, any other caller gets 501 FlowSuspendNotWired.
const APPROVAL_OPERATIONS = ['CreateAnApproval', 'StartAndWaitForAnApproval', 'WaitForAnApproval'];
// Power Automate runs end after 30 days.
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const APPROVAL_STATUS = { Approve: 'Approved', Reject: 'Rejected' };
const approvalsOf = (store) => ((store.state.simulator ??= {}).approvals ??= {});
const approvalOutputs = (a) => ({
  statusCode: 200,
  body: {
    name: a.id,
    title: a.title,
    details: a.details,
    itemLink: a.itemLink,
    itemLinkDescription: a.itemLinkDescription,
    requestDate: a.requestDate,
    completionDate: a.completionDate ?? null,
    outcome: a.outcome ?? null,
    responses: structuredClone(a.responses),
  },
});
const responderOf = (value) =>
  isMap(value)
    ? { id: value.id ?? null, displayName: value.displayName ?? null, email: value.email ?? null }
    : { id: null, displayName: String(value ?? ''), email: String(value ?? '').includes('@') ? String(value) : null };

function approvalsProvider(store, { now, uuid }) {
  const requireStore = () =>
    store?.transact ? store : fail('ProviderUnavailable', 'The approvals provider needs the organization store.');
  const write = (fn) => requireStore().transact(() => fn(approvalsOf(store)), { nested: true });
  const canWait = (context) => context.canSuspend || fail501();
  const fail501 = () => {
    throw new DataError(
      'Waiting for an approval needs a flow run that can suspend; mock or disable this action.',
      501,
      'FlowSuspendNotWired',
    );
  };
  const suspended = (approval, context) => {
    canWait(context);
    return {
      statusCode: 202,
      body: { name: approval.id },
      suspended: { kind: 'approval', id: approval.id, timeoutAt: approval.timeoutAt, assignedTo: approval.assignedTo },
    };
  };
  const create = (p, wrapper, context) => {
    const title = param(p, 'title', wrapper),
      assignedTo = param(p, 'assignedTo', wrapper);
    if (typeof title !== 'string' || !title.trim()) fail('ProviderFailed', 'The approval title is missing.');
    if (typeof assignedTo !== 'string' || !assignedTo.trim())
      fail('ProviderFailed', 'The approval assignedTo is missing.');
    const at = now(),
      id = uuid();
    const approval = {
      id,
      type: p.approvalType ?? 'Basic',
      title,
      assignedTo: assignedTo
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean),
      details: param(p, 'details', wrapper) ?? null,
      itemLink: param(p, 'itemLink', wrapper) ?? null,
      itemLinkDescription: param(p, 'itemLinkDescription', wrapper) ?? null,
      status: 'Pending',
      responses: [],
      requestDate: new Date(at).toISOString(),
      timeoutAt: new Date(at + Math.max(1, context.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)).toISOString(),
      runId: context.runId ?? null,
      actionPath: context.actionPath ?? null,
    };
    return write((all) => {
      all[id] = approval;
      return approval;
    });
  };
  const operations = {
    CreateAnApproval: async (p, context) => approvalOutputs(await create(p, 'ApprovalCreationInput', context)),
    StartAndWaitForAnApproval: async (p, context) => {
      canWait(context); // before the record is written
      return suspended(await create(p, 'WebhookApprovalCreationInput', context), context);
    },
    WaitForAnApproval: (p, context) => {
      const approval = approvalsOf(requireStore())[p.approvalName];
      if (!approval) throw new DataError('The approval does not exist.', 404, 'ApprovalNotFound');
      return approval.status === 'Pending' ? suspended(approval, context) : approvalOutputs(approval);
    },
  };
  return {
    id: 'approvals',
    connectors: ['shared_approvals'],
    operations: APPROVAL_OPERATIONS,
    capability: capability('approvals', {
      operations: levelled(APPROVAL_OPERATIONS, 'nativeApprovalOutcomeShape'),
      requires: ['store', 'flow-runs'],
      stateOwner: 'state:simulator.approvals',
    }),
    invoke: async ({ operationId, parameters }, context) => operations[operationId](parameters ?? {}, context),
    get: (id) =>
      store?.state?.simulator?.approvals?.[id] ? structuredClone(store.state.simulator.approvals[id]) : null,
    list: ({ status } = {}) =>
      Object.values(store?.state?.simulator?.approvals ?? {})
        .filter((a) => !status || a.status === status)
        .map((a) => structuredClone(a)),
    /** Records one response; the first response completes a Basic approval. Returns the action outputs { statusCode, body }. */
    async respond(id, { outcome, responder, comments = null } = {}) {
      if (!Object.hasOwn(APPROVAL_STATUS, outcome))
        throw new DataError("The approval outcome must be 'Approve' or 'Reject'.", 400, 'InvalidRequest');
      return write((all) => {
        const approval = all[id];
        if (!approval) throw new DataError('The approval does not exist.', 404, 'ApprovalNotFound');
        if (approval.status !== 'Pending')
          throw new DataError('The approval is already completed.', 409, 'ApprovalCompleted');
        const at = new Date(now()).toISOString();
        approval.responses.push({
          responder: responderOf(responder),
          requestDate: approval.requestDate,
          responseDate: at,
          approverResponse: outcome,
          comments: comments == null ? null : String(comments),
        });
        Object.assign(approval, { status: APPROVAL_STATUS[outcome], outcome, completionDate: at });
        return approvalOutputs(approval);
      });
    },
    /** Marks a pending approval TimedOut or Cancelled (called by the flow run store); a completed one is left as is. */
    close(id, status) {
      if (!store?.state?.simulator?.approvals?.[id]) return Promise.resolve(false);
      return write((all) => {
        if (all[id]?.status !== 'Pending') return false;
        all[id].status = status;
        all[id].completionDate = new Date(now()).toISOString();
        return true;
      });
    },
  };
}

// Service Bus (shared_servicebus) queue actions over the local message bus (api.providers.messaging). Topic actions are
// not mapped.
// Assumed: the action status codes and that SendMessage/settlement answer an empty body.
// ponytail: ContentType, Label, CorrelationId, SessionId, To/ReplyTo and TimeToLive are not kept (the bus has body,
// properties, messageId and schedule only); extend the bus row when a scenario reads them back.
const QUEUE_OPERATIONS = [
  'SendMessage',
  'SendMessages',
  'GetMessagesFromQueueWithPeekLock',
  'CompleteMessageInQueue',
  'AbandonMessageInQueue',
  'DeadLetterMessageInQueue',
];
const serviceBusMessage = (m) => ({
  ContentData: m.body,
  ContentType: null,
  Properties: m.properties ?? {},
  MessageId: m.messageId,
  SequenceNumber: m.sequenceNumber,
  LockToken: m.lockToken ?? null,
  ScheduledEnqueueTimeUtc: m.scheduledEnqueueTime ?? null,
});
function queueProvider(messaging) {
  const busOf = () =>
    (typeof messaging === 'function' ? messaging() : messaging) ??
    fail('ProviderUnavailable', 'No local message bus is configured (providers.messaging).');
  const entity = (name, type) => {
    if (typeof name !== 'string' || !name) fail('ProviderFailed', 'The queue or topic name is missing.');
    return type === 'DeadLetter' ? name + DEAD_LETTER_SUFFIX : name;
  };
  const send = (bus, name, m) =>
    bus.send(entity(name), m.ContentData ?? null, {
      messageId: m.MessageId,
      properties: m.Properties ?? {},
      scheduledEnqueueTime: m.ScheduledEnqueueTimeUtc,
      nested: true,
    });
  const settled = { statusCode: 200, body: null };
  const operations = {
    SendMessage: async (bus, p) => {
      await send(bus, p.entityName, isMap(p.message) ? p.message : p);
      return settled;
    },
    // Assumed: the batch body; both a `messages` array and a single message's flat keys are accepted.
    SendMessages: async (bus, p) => {
      for (const m of Array.isArray(p.messages) ? p.messages : [p]) await send(bus, p.entityName, m);
      return settled;
    },
    GetMessagesFromQueueWithPeekLock: async (bus, p) => ({
      statusCode: 200,
      body: (
        await bus.receive(entity(p.queueName, p.queueType), {
          mode: 'peekLock',
          maxMessages: p.maxMessageCount ?? 20,
          nested: true,
        })
      ).map(serviceBusMessage),
    }),
    CompleteMessageInQueue: async (bus, p) => {
      await bus.complete(p.lockToken, { nested: true });
      return settled;
    },
    AbandonMessageInQueue: async (bus, p) => {
      await bus.abandon(p.lockToken, { nested: true });
      return settled;
    },
    DeadLetterMessageInQueue: async (bus, p) => {
      await bus.deadLetter(p.lockToken, {
        reason: p.deadLetterReason,
        description: p.deadLetterErrorDescription,
        nested: true,
      });
      return settled;
    },
  };
  return {
    id: 'memory-queue',
    connectors: ['shared_servicebus'],
    operations: QUEUE_OPERATIONS,
    capability: capability('memory-queue', {
      operations: levelled(QUEUE_OPERATIONS, 'nativeServiceBusParity'),
      requires: ['providers.messaging'],
      stateOwner: 'messaging',
    }),
    invoke: async ({ operationId, parameters }) => operations[operationId](busOf(), parameters ?? {}),
  };
}

// The internal `flow` connector of a child flow action (type Workflow): the caller's context.runChildFlow (the flow run
// lifecycle, flow-runtime.mjs runTrackedFlow) runs the target flow; without it the call is 501 ChildFlowNotWired.
export const CHILD_FLOW_CONNECTOR = 'flow';
function childFlowProvider() {
  return {
    id: 'flow',
    connectors: [CHILD_FLOW_CONNECTOR],
    operations: ['RunChildFlow'],
    capability: capability('flow', { operations: ['RunChildFlow'], requires: ['flow-runs'] }),
    invoke: ({ parameters }, context) => {
      if (typeof context.runChildFlow !== 'function')
        throw new DataError(
          'A child flow action needs the flow run store; mock or disable this action.',
          501,
          'ChildFlowNotWired',
        );
      return context.runChildFlow(parameters?.workflowReferenceName, parameters?.body ?? {});
    },
  };
}

// ---- retry policy

// Action retryPolicy: type fixed | exponential | none, count, interval as an ISO 8601 duration. Locally count is at most 4.
// ponytail: exponential waits interval * 2^(attempt-1) without the native random range or minimum/maximumInterval.
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
/** Milliseconds of an ISO 8601 day-time duration (PnDTnHnMnS), or null. */
export function durationMs(value) {
  const parts = typeof value === 'string' && value !== 'P' && !value.endsWith('T') ? DURATION.exec(value) : null;
  return parts
    ? Math.round(
        (((Number(parts[1] ?? 0) * 24 + Number(parts[2] ?? 0)) * 60 + Number(parts[3] ?? 0)) * 60 +
          Number(parts[4] ?? 0)) *
          1000,
      )
    : null;
}
/** A validated retry policy { type, count, intervalMs }, or throws an Error naming the problem. */
export function parseRetryPolicy(value) {
  if (!isMap(value) || !['fixed', 'exponential', 'none'].includes(value.type))
    throw new Error('retryPolicy.type must be fixed, exponential or none');
  if (value.type === 'none') return { type: 'none', count: 0, intervalMs: 0 };
  if (Object.keys(value).some((key) => !['type', 'count', 'interval'].includes(key)))
    throw new Error('retryPolicy takes only type, count and interval');
  if (!Number.isInteger(value.count) || value.count < 1 || value.count > 4)
    throw new Error('retryPolicy.count must be an integer from 1 to 4');
  const intervalMs = durationMs(value.interval);
  if (intervalMs === null) throw new Error('retryPolicy.interval must be an ISO 8601 duration such as PT10S');
  if (intervalMs > 24 * 60 * 60 * 1000) throw new Error('retryPolicy.interval must be at most one day');
  return { type: value.type, count: value.count, intervalMs };
}
// Transient: a connectivity failure, or an answer of 408, 429 or 5xx.
const transient = (answer, error) =>
  error
    ? ['ProviderUnavailable', 'ProviderTimeout'].includes(error.code) ||
      ['TimeoutError', 'AbortError'].includes(error.name)
    : answer?.statusCode === 408 || answer?.statusCode === 429 || answer?.statusCode >= 500;
// The reason of an aborted signal as a coded error (a flow run's cancellation is FlowRunCancelled).
const aborted = (signal) =>
  signal.reason instanceof DataError
    ? signal.reason
    : new DataError('The connector call was cancelled.', 409, 'FlowRunCancelled');
const header = (headers, name) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
// Retry-After: delay-seconds or an HTTP date, in milliseconds; null when absent or invalid.
function retryAfterMs(value, now) {
  if (value == null || value === '') return null;
  if (/^\d+$/.test(String(value).trim())) return Number(value) * 1000;
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
// ponytail: at most 100 status polls per operation; the run-level deadline normally ends a longer one first.
const MAX_POLLS = 100;

// ---- runtime

function principals(packs) {
  const result = [];
  for (const pack of packs)
    for (const [name, profile] of Object.entries(pack.connectionPrincipals ?? {}))
      result.push({ pack: pack.id, name, profile });
  return result;
}

/**
 * customConnectors: compiled Solution custom connectors (custom-connector.mjs customConnectorsOf), an array or a function
 * answering the current array (sources reload); useCustomConnectors() replaces it later. Pack flowActions and flowTriggers
 * exports are reachable through flowActions() and flowTriggers(connectorId, operationId).
 * stateDirectory: the runtime's private state directory (the vault key of sealed connection tokens, built custom connector
 * script hosts); dotnet: the .NET SDK command that runs custom connector scripts.
 */
export function createConnectorRuntime({
  store,
  connections = {},
  providers = [],
  packs = [],
  diagnostic = () => {},
  clock,
  ids = store?.ids,
  messaging = null,
  scheduler = null,
  customConnectors = [],
  stateDirectory = null,
  dotnet = 'dotnet',
  trustedScripts = [],
} = {}) {
  const now = () => clock?.now?.() ?? store?.clock?.now?.() ?? Date.now();
  const uuid = () => ids?.uuid?.() ?? randomUUID();
  const approvals = approvalsProvider(store, { now, uuid });
  const registry = new Map();
  const add = (provider) => {
    if (registry.has(provider.id)) throw new Error('Ambiguous connector provider: ' + provider.id);
    registry.set(provider.id, provider);
  };
  const definitions = new Map();
  for (const pack of packs)
    for (const [id, document] of Object.entries(pack.connectorDefinitions ?? {})) {
      if (definitions.has(id))
        throw new Error(`Data pack ${pack.id}: connectorDefinitions.${id} is declared by more than one pack`);
      definitions.set(id, compileDefinition(document));
    }
  const validateOperation = (connectorId, request) => {
    const definition = definitions.get(connectorId);
    return definition ? validateDefinition(definition, request) : null;
  };
  const fixtures = packs.flatMap((pack) => pack.httpFixtures ?? []);
  // Connection OAuth tokens (authorization code flow) per connection id: sealed in state.simulator.connectionTokens (flow-vault.mjs),
  // or in this runtime's memory without a store.
  const vault = flowVault(stateDirectory),
    memoryTokens = new Map();
  const tokens = {
    get(id) {
      const sealed = store?.state ? store.state.simulator?.connectionTokens?.[id] : memoryTokens.get(id);
      return sealed ? (vault.open(sealed) ?? null) : null;
    },
    set(id, value) {
      if (!store?.transact) {
        value ? memoryTokens.set(id, vault.seal(value)) : memoryTokens.delete(id);
        return Promise.resolve();
      }
      return store.transact(
        () => {
          const all = ((store.state.simulator ??= {}).connectionTokens ??= {});
          if (value) all[id] = vault.seal(value);
          else delete all[id];
        },
        { nested: true },
      );
    },
  };
  const scripts = createScriptHost({ stateDirectory, command: dotnet, trusted: trustedScripts });
  [
    dataverseProvider(store, diagnostic),
    httpProvider(),
    fixtureProvider(fixtures),
    queueProvider(messaging),
    approvals,
    childFlowProvider(),
  ].forEach(add);
  let ownScheduler = null;
  const tasks = () =>
    scheduler ?? (store ? storeScheduler(store) : (ownScheduler ??= createScheduler({ clock: { now } })));
  // A wait on the scheduler that the caller's signal (a run cancellation) ends at once.
  const pause = (ms, signal = null, name = 'connector-retry') =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(aborted(signal));
      const onAbort = () => {
        tasks().cancel(handle);
        reject(aborted(signal));
      };
      const handle = tasks().schedule(
        () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        ms,
        { name },
      );
      if (handle === null) return reject(connectorError('ProviderUnavailable', 'The runtime is closing.'));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  // Retries a provider call on ProviderUnavailable/ProviderTimeout or an HTTP 429/5xx answer; each attempt is reported
  // through context.onAttempt and the waits run on the scheduler (the store's one by default), never a bare timer.
  async function retried(call, policy, ctx) {
    for (let attempt = 1; ; attempt++) {
      if (ctx.signal?.aborted) throw aborted(ctx.signal);
      let answer, error;
      try {
        answer = await call();
      } catch (cause) {
        error = cause;
      }
      ctx.onAttempt?.({
        attempt,
        ...(error ? { code: error.code ?? 'ProviderFailed' } : { statusCode: answer?.statusCode ?? null }),
      });
      if (!transient(answer, error) || attempt > policy.count) {
        if (error) throw error;
        return answer;
      }
      await pause(
        policy.type === 'exponential' ? policy.intervalMs * 2 ** (attempt - 1) : policy.intervalMs,
        ctx.signal,
      );
    }
  }
  // The asynchronous operation pattern of HTTP-based providers (http, fixture, custom connectors): an answer of 202 with a
  // Location header is polled with GET after Retry-After (1 second by default) until a non-202 answer, which is the result.
  // The run-level deadline (context.timeoutMs) bounds it and the run's cancellation ends it; context.asyncPattern false (the
  // action's DisableAsyncPattern operation option) answers the 202 as is.
  // Assumed: a 202 without a Location header is answered as is. A relative Location resolves against the URI of the
  // response that carried it (RFC 9110 section 10.2.2): the first against the request, a later one against the previous
  // status URL (a provider's poll answers it as statusUrl).
  async function followAsync(provider, request, ctx, answer) {
    const started = Date.now(),
      budget = Math.max(1, ctx.timeoutMs ?? 2000);
    let base = null;
    for (let polls = 0; answer?.statusCode === 202 && header(answer.headers, 'location'); polls++) {
      if (polls >= MAX_POLLS)
        fail('ProviderTimeout', 'The asynchronous operation did not finish within ' + MAX_POLLS + ' status polls.');
      const wait = retryAfterMs(header(answer.headers, 'retry-after'), Date.now()) ?? 1000;
      if (Date.now() - started + wait > budget)
        fail('ProviderTimeout', 'The asynchronous operation did not finish within the action time limit.');
      await pause(wait, ctx.signal, 'connector-async-poll');
      const location = header(answer.headers, 'location');
      const { statusUrl, ...polled } = await provider.poll(base ? new URL(location, base).href : location, request, {
        ...ctx,
        timeoutMs: Math.max(1, budget - (Date.now() - started)),
      });
      answer = polled;
      base = statusUrl ?? base;
    }
    return answer;
  }

  for (const pack of packs) if (pack.connectors !== undefined) add(packProvider(pack));
  for (const provider of providers) add(provider);
  const named = principals(packs);
  const flowActions = Object.freeze(packFlowActions(packs));
  const flowTriggers = {};
  for (const pack of packs)
    for (const [connectorId, ops] of Object.entries(pack.flowTriggers ?? {}))
      for (const [operationId, entry] of Object.entries(ops)) {
        if (flowTriggers[connectorId]?.[operationId])
          throw new Error(
            `Data pack ${pack.id}: flowTriggers.${connectorId}.${operationId} is declared by more than one pack`,
          );
        (flowTriggers[connectorId] ??= {})[operationId] = { pack: pack.id, ...entry };
      }
  // Compiled custom connectors follow the current sources: their providers are replaced when the compiled list changes.
  let customSource = customConnectors,
    customList = null,
    customIds = [];
  const syncCustom = () => {
    const list = (typeof customSource === 'function' ? customSource() : customSource) ?? [];
    if (list === customList) return;
    for (const id of customIds) registry.delete(id);
    customIds = [];
    customList = list;
    for (const connector of list) {
      const provider = customConnectorProvider(connector, fixtures, store, { tokens, scripts, now, diagnostic });
      if (registry.has(provider.id)) {
        diagnostic({ code: 'CONNECTOR_CUSTOM_DUPLICATE', connector: connector.name });
        continue;
      }
      registry.set(provider.id, provider);
      customIds.push(provider.id);
    }
  };

  // The built-in or pack provider for a connector id (pack connectors never shadow built-ins).
  const defaultProvider = (connectorId) => {
    const owners = [...registry.values()].filter((p) => p.id !== 'fixture' && p.connectors.includes(connectorId));
    const builtIn = owners.find((p) => !p.id.startsWith('pack:'));
    if (!builtIn && owners.length > 1)
      fail(
        'ConnectorNotConfigured',
        'More than one pack declares this connector; bind it through a project connection.',
      );
    return builtIn ?? owners[0] ?? null;
  };
  const principalOf = (value) => {
    if (value == null) return null;
    const name = typeof value === 'string' ? value : value.identity,
      pack = typeof value === 'string' ? null : (value.pack ?? null);
    const found = named.filter((p) => p.name === name && (!pack || p.pack === pack));
    if (found.length !== 1)
      fail(
        'ConnectionUnauthorized',
        found.length
          ? 'The connection principal name is ambiguous; name its pack.'
          : 'The connection principal is not declared by a trusted pack.',
      );
    return found[0].profile;
  };
  const supportsOperation = (provider, connectorId, operationId) =>
    Boolean(provider) &&
    provider.connectors.includes(connectorId) &&
    (provider.supportsOperation
      ? provider.supportsOperation(connectorId, operationId)
      : provider.operations.includes(operationId));

  function resolve({
    apiId,
    connectorId = connectorOf(apiId),
    connectionName = null,
    connectionReferences,
    connectionId = null,
    principal = null,
  } = {}) {
    syncCustom();
    const referenceLogicalName = referenceOf(connectionReferences, connectionName);
    const result = (provider, connection, id) => {
      if (!registry.has(provider))
        fail('ConnectorNotConfigured', 'The connection names a provider that is not registered.');
      const resolvedPrincipal = principal ?? principalOf(connection?.principal);
      return {
        connectorId,
        referenceLogicalName,
        connectionId: id ?? null,
        provider,
        principal: resolvedPrincipal,
        settings: connection?.settings ?? {},
        bound: registry.get(provider).capability.principal !== 'required' || Boolean(resolvedPrincipal),
      };
    };
    const unbound = (message) => {
      if (principal && connectorId === DATAVERSE_CONNECTOR) return result('dataverse', null, null); // flowIdentities override
      fail('ConnectionNotBound', message);
    };
    if (connectionId == null && connectionName != null) {
      if (!referenceLogicalName)
        return unbound('The action connection is not declared in the flow connectionReferences.');
      const row = (store?.state?.tables?.connectionreference ?? []).find((r) =>
        same(r.connectionreferencelogicalname, referenceLogicalName),
      );
      if (!row?.connectionid) return unbound('The connection reference has no bound connection id.');
      connectionId = row.connectionid;
    } else if (connectionId == null && Object.hasOwn(connections, connectorId)) connectionId = connectorId;
    if (connectionId != null) {
      const connection = Object.hasOwn(connections, connectionId) ? connections[connectionId] : null;
      if (!connection) return unbound('The bound connection id is not declared in the project connections.');
      if (connection.connector && connection.connector !== connectorId)
        return unbound('The bound connection belongs to another connector.');
      return result(
        connection.provider ??
          defaultProvider(connectorId)?.id ??
          fail(
            definitions.has(connectorId) ? 'ConnectorNotSimulated' : 'ConnectorNotConfigured',
            'No provider serves this connector.',
          ),
        connection,
        connectionId,
      );
    }
    const provider = defaultProvider(connectorId);
    if (!provider) fail('ConnectorNotConfigured', 'No local provider or project connection serves this connector.');
    return result(provider.id, null, null);
  }

  const supports = (connectorId, operationId, providerId) => {
    syncCustom();
    return providerId
      ? supportsOperation(registry.get(providerId), connectorId, operationId)
      : supportsOperation(defaultProvider(connectorId), connectorId, operationId);
  };
  // Why a connector operation is not served, when a compiled custom connector says so (its blocking diagnostic).
  const unsupportedReason = (connectorId, operationId) => {
    syncCustom();
    const custom = customIds.map((id) => registry.get(id)).find((p) => p.connectors.includes(connectorId));
    if (!custom) {
      const definition = definitions.get(connectorId);
      return definition
        ? definition.operations.has(operationId)
          ? 'ConnectorNotSimulated: the operation has no simulated behaviour.'
          : 'CONNECTOR_OPERATION_UNKNOWN: the connector definition has no such operation.'
        : null;
    }
    if (custom.blocked) return `${custom.blocked.code}: ${custom.blocked.message}`;
    return custom.operations.includes(operationId)
      ? null
      : (custom.reason?.(operationId) ??
          `CONNECTOR_OPERATION_UNKNOWN: the custom connector has no operation ${operationId}.`);
  };

  /** Returns the result directly when the provider answers synchronously (built-in Dataverse), else a Promise. Always await it.
   * retry: a parseRetryPolicy result; the call is then always a Promise. */
  function invoke({
    connectorId,
    operationId,
    method,
    path,
    parameters = {},
    connection,
    context = {},
    pagination,
    retry = null,
  } = {}) {
    const started = now();
    syncCustom();
    let resolved;
    const note = (status, error) =>
      diagnostic({
        code: 'CONNECTOR_INVOKE',
        connectorId,
        operationId,
        reference: resolved?.referenceLogicalName ?? null,
        connectionId: resolved?.connectionId ?? null,
        provider: resolved?.provider ?? null,
        principalId: resolved?.principal?.userId ?? null,
        caller: context.caller ?? null,
        status,
        ...(error ? { error } : {}),
        durationMs: now() - started,
        correlationId: context.correlationId ?? null,
      });
    const failed = (error) => {
      const mapped =
        error instanceof DataError
          ? error
          : ['TimeoutError', 'AbortError'].includes(error?.name)
            ? connectorError('ProviderTimeout', 'The connector provider timed out.')
            : connectorError('ProviderFailed', 'The connector provider failed.');
      note(mapped.status, mapped.code);
      throw mapped;
    };
    const finish = (answer) => {
      note(answer?.statusCode ?? null);
      return answer;
    };
    let answer;
    try {
      const operation = validateOperation(connectorId, { operationId, method, path, parameters });
      if (operation) operationId = operation.operationId;
      if (
        !connection &&
        definitions.has(connectorId) &&
        !Object.hasOwn(connections, connectorId) &&
        !defaultProvider(connectorId)
      )
        fail('ConnectorNotSimulated', 'The connector operation has a definition but no simulated behaviour.');
      resolved = connection ?? resolve({ connectorId, principal: context.principal });
      const provider = registry.get(resolved.provider);
      if (!provider) fail('ConnectorNotConfigured', 'The connection names a provider that is not registered.');
      if (!supportsOperation(provider, connectorId, operationId))
        fail(
          definitions.has(connectorId) ? 'ConnectorNotSimulated' : 'OperationUnsupported',
          provider.reason?.(operationId) ?? 'The provider does not implement this connector operation.',
        );
      const ctx = {
        ...context,
        principal: resolved.principal,
        settings: resolved.settings ?? {},
        clock: clock ?? { now },
        connectionId: resolved.connectionId ?? null,
      };
      const request = { connectorId, operationId, parameters };
      const once =
        typeof provider.poll === 'function' && context.asyncPattern !== false
          ? () =>
              Promise.resolve(provider.invoke(request, ctx)).then((first) => followAsync(provider, request, ctx, first))
          : () => provider.invoke(request, ctx);
      answer = retry?.count ? retried(once, retry, ctx) : once();
      if (pagination?.minimumItemCount)
        answer =
          typeof answer?.then === 'function'
            ? answer.then((first) => paginate(provider, request, ctx, first, pagination))
            : paginate(provider, request, ctx, answer, pagination);
    } catch (error) {
      return failed(error);
    }
    return typeof answer?.then === 'function' ? answer.then(finish, failed) : finish(answer);
  }

  // Follow nextLink until minimumItemCount items or maxPages pages; a first page without nextLink stays synchronous.
  function paginate(provider, request, ctx, first, { minimumItemCount, maxPages = 10 }) {
    if (!first?.nextLink || !Array.isArray(first.body?.value)) return first;
    return (async () => {
      const items = [...first.body.value];
      let last = first,
        pages = 1;
      while (last.nextLink && items.length < minimumItemCount) {
        if (pages >= maxPages) {
          diagnostic({
            code: 'CONNECTOR_PAGINATION_TRUNCATED',
            connectorId: request.connectorId,
            operationId: request.operationId,
            pages,
            items: items.length,
            minimumItemCount,
            correlationId: ctx.correlationId ?? null,
          });
          return { ...first, body: linked(first.body, items, last.nextLink), nextLink: last.nextLink };
        }
        last = await provider.invoke({ ...request, nextLink: last.nextLink }, ctx);
        // A failed later page fails the action with that page's status and body, as a failed first page does.
        if (Number.isInteger(last?.statusCode) && (last.statusCode < 200 || last.statusCode > 299)) return last;
        if (!Array.isArray(last?.body?.value)) fail('ProviderFailed', 'A later page has no value array.');
        items.push(...last.body.value);
        pages++;
      }
      const { nextLink, ...rest } = first;
      return { ...rest, body: linked(first.body, items, null) };
    })();
  }
  // The merged body: every page's items, and the body's continuation key(s) naming `link` (the latest page's), or none.
  function linked(body, items, link) {
    const { '@odata.nextLink': odata, nextLink, ...rest } = body;
    return {
      ...rest,
      value: items,
      ...(link && odata !== undefined ? { '@odata.nextLink': link } : {}),
      ...(link && nextLink !== undefined ? { nextLink: link } : {}),
    };
  }

  const flowActionRecord = () =>
    Object.keys(flowActions).length
      ? [
          capability('flow-actions:pack', {
            level: 'contract',
            operations: Object.keys(flowActions).map((name) => ({ name, level: 'contract' })),
            requires: ['pack:flowActions'],
          }),
        ]
      : [];
  const flowTriggerRecord = () =>
    Object.keys(flowTriggers).length
      ? [
          capability('flow-triggers:pack', {
            level: 'contract',
            operations: Object.entries(flowTriggers).flatMap(([c, ops]) =>
              Object.keys(ops).map((o) => ({ name: `${c}/${o}`, level: 'contract' })),
            ),
            requires: ['pack:flowTriggers'],
          }),
        ]
      : [];
  return {
    resolve,
    supports,
    validateOperation,
    hasDefinition: (connectorId) => definitions.has(connectorId),
    invoke,
    unsupportedReason,
    /** Pack flowActions handlers by action type (flow-actions.mjs). */
    flowActions: () => flowActions,
    /** The pack flowTriggers entry { pack, subscribe, unsubscribe, poll? } for a connector trigger operation, or null. */
    flowTriggers: (connectorId, operationId) => flowTriggers[connectorId]?.[operationId] ?? null,
    /** Replaces the compiled custom connectors (an array or a function answering the current array). */
    useCustomConnectors(value) {
      customSource = value;
      customList = null;
      syncCustom();
    },
    /** OAuth sign-in of a project connection whose custom connector uses the authorization code flow: authorize(connectionId)
     * answers { authorizeUrl, redirectUri, expiresAt, completion }; status(connectionId) answers { signedIn, expiresAt } (never a token). */
    oauth: {
      async authorize(connectionId, options = {}) {
        syncCustom();
        const connection = Object.hasOwn(connections, connectionId) ? connections[connectionId] : null;
        if (!connection) throw new DataError('No project connection has this id.', 404, 'ConnectionNotFound');
        const provider = registry.get(connection.provider ?? defaultProvider(connection.connector)?.id);
        if (provider?.oauth?.flow !== 'accessCode')
          throw new DataError(
            'This connection does not sign in with the OAuth authorization code flow.',
            400,
            'ConnectionNotAuthorizationCode',
          );
        return provider.oauth.begin(connectionId, connection.settings ?? {}, options);
      },
      status(connectionId) {
        const token = tokens.get(connectionId);
        return {
          connectionId,
          signedIn: Boolean(token),
          expiresAt: token?.expiresAt == null ? null : new Date(token.expiresAt).toISOString(),
          refreshable: Boolean(token?.refresh_token),
        };
      },
      /** Every project connection with its sign-in kind (accessCode when its custom connector uses the authorization code flow). */
      list() {
        syncCustom();
        return Object.entries(connections).map(([connectionId, connection]) => {
          const provider = registry.get(connection.provider ?? defaultProvider(connection.connector)?.id);
          const signIn = provider?.oauth?.flow === 'accessCode' ? 'accessCode' : null;
          return {
            connectionId,
            connector: connection.connector ?? null,
            provider: provider?.id ?? null,
            signIn,
            ...(signIn ? { signedIn: Boolean(tokens.get(connectionId)) } : {}),
          };
        });
      },
    },
    /** Approval records (state.simulator.approvals); respond() answers the outputs of the waiting action. */
    approvals: { get: approvals.get, list: approvals.list, respond: approvals.respond, close: approvals.close },
    providers: () => {
      syncCustom();
      return [...registry.values()].map((p) => ({
        id: p.id,
        connectors: [...p.connectors],
        operations: p.capability.operations,
        level: p.capability.level,
      }));
    },
    describe: () => {
      syncCustom();
      return [
        ...[...registry.values()].map((p) => structuredClone(p.capability)),
        ...flowActionRecord(),
        ...flowTriggerRecord(),
      ];
    },
  };
}

// ---- validators the project config and pack-export registries call

const CREDENTIAL = /secret|password|key|token/i;
const REFERENCE = /^(?:env|variable):[A-Za-z_][\w.-]*$/;
function credentialFree(value, label, depth = 0) {
  if (depth > 16) throw new Error(`${label} nests too deeply`);
  if (Array.isArray(value)) return value.forEach((item, i) => credentialFree(item, `${label}[${i}]`, depth + 1));
  if (!isMap(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (CREDENTIAL.test(key) && typeof item === 'string' && !REFERENCE.test(item))
      throw new Error(`${label}.${key} must not hold a credential; use an env:NAME or variable: reference`);
    credentialFree(item, `${label}.${key}`, depth + 1);
  }
}
const PROVIDER = /^(?:dataverse|http|fixture|memory-queue|approvals|pack:[\w.-]+|custom-connector:[\w.-]+)$/;
const AUTH_KEYS = ['apiKey', 'username', 'password', 'token', 'clientId', 'clientSecret'];
/** Validates the project `connections` map; returns a plain copy. Credentials are never accepted as literals. */
export function connectionSettings(value, label = 'connections') {
  if (value === undefined) return {};
  if (!isMap(value)) throw new Error(`${label} must map connection ids to local connections`);
  const result = {};
  for (const [id, entry] of Object.entries(value)) {
    const at = `${label}.${id}`;
    if (!id.trim() || id.length > 250 || ['__proto__', 'constructor', 'prototype'].includes(id))
      throw new Error(`${label} has an invalid connection id`);
    if (!isMap(entry)) throw new Error(`${at} must be an object`);
    for (const key of Object.keys(entry))
      if (!['connector', 'provider', 'principal', 'evidence', 'settings'].includes(key))
        throw new Error(`${at}.${key} is not a connection setting`);
    if (
      entry.connector !== undefined &&
      (typeof entry.connector !== 'string' || !/^[\w.-]{1,250}$/.test(entry.connector))
    )
      throw new Error(`${at}.connector must be a connector id`);
    if (entry.provider !== undefined && (typeof entry.provider !== 'string' || !PROVIDER.test(entry.provider)))
      throw new Error(
        `${at}.provider must be dataverse, http, fixture, memory-queue, approvals, pack:<id> or custom-connector:<name>`,
      );
    const principal = entry.principal;
    if (
      principal !== undefined &&
      !(typeof principal === 'string' && principal.trim()) &&
      !(
        isMap(principal) &&
        Object.keys(principal).every((k) => ['pack', 'identity'].includes(k)) &&
        typeof principal.identity === 'string' &&
        principal.identity.trim() &&
        (principal.pack === undefined || typeof principal.pack === 'string')
      )
    )
      throw new Error(`${at}.principal must name a pack connection principal ({ pack, identity } or a name)`);
    if (entry.evidence !== undefined && typeof entry.evidence !== 'string')
      throw new Error(`${at}.evidence must be text`);
    const settings = entry.settings ?? {};
    if (!isMap(settings)) throw new Error(`${at}.settings must be an object`);
    for (const key of Object.keys(settings))
      if (!['rewrites', 'auth', 'parameters'].includes(key))
        throw new Error(`${at}.settings.${key} is not a connection setting`);
    // Custom connector credentials (auth) are always env:NAME or variable:NAME references; parameters are plain values or references.
    if (
      settings.auth !== undefined &&
      (!isMap(settings.auth) ||
        Object.entries(settings.auth).some(
          ([k, v]) => !AUTH_KEYS.includes(k) || typeof v !== 'string' || !REFERENCE.test(v),
        ))
    )
      throw new Error(`${at}.settings.auth takes ${AUTH_KEYS.join(', ')} as env:NAME or variable:NAME references only`);
    if (
      settings.parameters !== undefined &&
      (!isMap(settings.parameters) ||
        Object.values(settings.parameters).some((v) => !['string', 'number', 'boolean'].includes(typeof v)))
    )
      throw new Error(`${at}.settings.parameters must map connection parameter names to text, numbers or booleans`);
    const rewrites = settings.rewrites ?? {};
    if (!isMap(rewrites)) throw new Error(`${at}.settings.rewrites must map URL prefixes to local URL prefixes`);
    for (const [from, to] of Object.entries(rewrites))
      for (const url of [from, to]) {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          throw new Error(`${at}.settings.rewrites needs absolute http(s) URL prefixes`);
        }
        if (
          !['http:', 'https:'].includes(parsed.protocol) ||
          parsed.username ||
          parsed.password ||
          parsed.search ||
          parsed.hash
        )
          throw new Error(
            `${at}.settings.rewrites prefixes must be plain http(s) URLs without credentials, query or fragment`,
          );
      }
    credentialFree({ principal: entry.principal, evidence: entry.evidence, parameters: settings.parameters }, at);
    result[id] = structuredClone(entry);
  }
  return result;
}

const packFail = (packId, message) => {
  throw new Error(`Data pack ${packId}: ${message}`);
};
/** Per-export validators for the pack-export registry; each throws an Error naming the pack. */
export const CONNECTOR_PACK_EXPORTS = {
  connectorDefinitions: {
    check(value, packId) {
      if (!isMap(value)) packFail(packId, 'connectorDefinitions must map connector ids to Swagger 2.0 documents');
      for (const [id, document] of Object.entries(value)) {
        if (!/^[\w.-]{1,250}$/.test(id)) packFail(packId, `connectorDefinitions.${id} is not a connector id`);
        try {
          compileDefinition(document);
        } catch (error) {
          packFail(packId, `connectorDefinitions.${id}: ${error.message}`);
        }
      }
    },
  },
  connectors: {
    check(value, packId) {
      if (!isMap(value)) packFail(packId, 'connectors must map connector ids to { operations }');
      for (const [id, connector] of Object.entries(value)) {
        if (!/^[\w.-]{1,250}$/.test(id) || id === DATAVERSE_CONNECTOR || id === 'http' || id === CHILD_FLOW_CONNECTOR)
          packFail(packId, `connectors.${id} is not a pack connector id`);
        if (!isMap(connector) || !isMap(connector.operations) || Object.keys(connector).some((k) => k !== 'operations'))
          packFail(packId, `connectors.${id} must be { operations }`);
        for (const [operation, handler] of Object.entries(connector.operations))
          if (!operation.trim() || typeof handler !== 'function')
            packFail(packId, `connectors.${id}.operations.${operation} must be a function`);
      }
    },
  },
  httpFixtures: {
    check(value, packId) {
      if (!Array.isArray(value)) packFail(packId, 'httpFixtures must be an array');
      const ids = new Set();
      for (const fixture of value) {
        if (!isMap(fixture) || typeof fixture.id !== 'string' || !fixture.id.trim() || ids.has(fixture.id))
          packFail(packId, 'every http fixture needs a unique id');
        ids.add(fixture.id);
        if (typeof fixture.method !== 'string' || !/^(?:\*|[A-Za-z]+)$/.test(fixture.method))
          packFail(packId, `http fixture ${fixture.id} needs a method or *`);
        if (!(fixture.url instanceof RegExp) || fixture.url.global || fixture.url.sticky)
          packFail(packId, `http fixture ${fixture.id} url must be a RegExp without g or y flags`);
        if (typeof fixture.respond !== 'function')
          packFail(packId, `http fixture ${fixture.id} respond must be a function`);
      }
    },
  },
  connectionPrincipals: {
    check(value, packId) {
      if (!isMap(value)) packFail(packId, 'connectionPrincipals must map names to backend profiles');
      for (const [name, profile] of Object.entries(value)) {
        if (!name.trim()) packFail(packId, 'connectionPrincipals needs non-empty names');
        try {
          validateServiceProfile(profile);
        } catch {
          packFail(packId, `connectionPrincipals.${name} needs userId, evidence and explicit grants`);
        }
      }
    },
  },
};

registerSettingParser('connections', (value, label) => (value == null ? value : connectionSettings(value, label)));
for (const [name, spec] of Object.entries(CONNECTOR_PACK_EXPORTS)) registerPackExport(name, spec);
