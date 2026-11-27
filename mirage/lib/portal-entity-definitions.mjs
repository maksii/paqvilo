// The portal Web API's EntityDefinitions read that the Power Pages PCF host sends for context.utils.getEntityMetadata:
// GET /_api/EntityDefinitions(LogicalName='<table>')?$expand=Attributes($filter=LogicalName eq '<a>'[ or LogicalName eq
// '<b>']*) (captured on a live Power Pages site, 2026-11-26). Only that shape, in the captured spelling, and
// the same key without a query, is answered; every other EntityDefinitions or metadata path keeps the portal's error
// envelope, so the organization metadata family stays on the Dataverse API. The body is the Dataverse metadata
// serializer's EntityMetadata (dataverse-api.mjs metadataRead over the organization's metadata service) with the table's
// Privileges.
// Access: the request must carry the host's pcf-entity-logical-name header naming the table; without
// it the portal answers 404 9004010C "Resource not found for the segment EntityMetadata." for administrators and other
// contacts alike, and with it a non-administrator contact gets the full metadata (captured). LOCAL parts (unproven): a
// signed-in contact is required (an anonymous visitor cannot be tested on the private capture sites), a header naming
// another table is refused like a missing one, and the table must be in the exported Solution metadata; an unknown or
// unexported table gets the same 404, so table existence cannot be enumerated. Those refusals carry the
// PCF_ENTITY_DEFINITIONS_LOCAL_ACCESS diagnostic.
import { DataError } from './data-error.mjs';

const PATH = /^\/_api\/EntityDefinitions(?=[(/?]|$)/i;
// The captured spelling only: other letter cases or key forms are refused.
const KEYED = /^\/_api\/EntityDefinitions\(LogicalName='([a-z_][a-z\d_]*)'\)$/;
const COLUMN = String.raw`LogicalName eq '([a-z_][a-z\d_]*)'`;
const EXPAND = new RegExp(String.raw`^Attributes\(\$filter=${COLUMN}((?: or ${COLUMN})*)\)$`);

/** Whether a portal /_api path addresses EntityDefinitions (any shape or case): those requests are answered here. */
export function isPortalEntityDefinitionsPath(pathname) {
  let path;
  try {
    path = decodeURIComponent(String(pathname));
  } catch {
    return false;
  }
  return PATH.test(path);
}

const unsupported = (path) =>
  new DataError(
    `The portal Web API answers only the code component EntityDefinitions read, not ${path}.`,
    400,
    'UnsupportedQuery',
    { phase: 'query' },
  );

const localAccess = (who, table) => ({
  code: 'PCF_ENTITY_DEFINITIONS_LOCAL_ACCESS',
  message: `EntityDefinitions for ${table} refused for ${who}: Mirage's local access rule (unproven) needs a signed-in contact and a table in the exported Solution metadata.`,
});
// The portal's answer without the host header (captured message).
const noEntityMetadata = (details = {}) =>
  new DataError('Resource not found for the segment EntityMetadata.', 404, 'ResourceNotFound', {
    segment: 'EntityMetadata',
    ...details,
  });

/** The requested columns of an accepted $expand, or null without one; throws for any other query shape. */
export function portalEntityDefinitionColumns(searchParams) {
  const names = [...searchParams.keys()];
  if (names.some((name) => name !== '$expand')) throw unsupported('query option ' + names.find((n) => n !== '$expand'));
  if (!searchParams.has('$expand')) return null;
  const match = EXPAND.exec(searchParams.get('$expand'));
  if (!match) throw unsupported('this $expand');
  const rest = [...match[2].matchAll(new RegExp(COLUMN, 'g'))].map((item) => item[1]);
  return [match[1], ...rest];
}

/**
 * Answers GET /_api/EntityDefinitions(LogicalName='t')[?$expand=Attributes($filter=…)] as { status, body }, or rejects with
 * a DataError the portal error envelope formats. metadata: the organization's metadata service (dataverse-metadata.mjs);
 * portal: the portal the Web API policy reads (the exported Solution tables, webApiEntities); headers: the request headers.
 */
export async function portalEntityDefinition({ method, url, origin, identity, metadata, portal, headers = {} }) {
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    throw unsupported(url.pathname);
  }
  if (method !== 'GET')
    throw new DataError(`The HTTP method '${method}' is not allowed for EntityDefinitions.`, 405, 'MethodNotAllowed');
  const keyed = KEYED.exec(path);
  if (!keyed) throw unsupported(path);
  const logical = keyed[1];
  const columns = portalEntityDefinitionColumns(url.searchParams);
  const named = headers['pcf-entity-logical-name'];
  if (named === undefined) throw noEntityMetadata();
  if (named !== logical)
    throw noEntityMetadata({
      permissionDiagnostic: localAccess('a pcf-entity-logical-name header naming ' + named, logical),
    });
  if (!(identity?.contactId ?? identity?.id))
    throw new DataError('You are unauthorized to process this request.', 403, 'PermissionDenied', {
      operation: 'read',
      table: logical,
      permissionDiagnostic: localAccess('an anonymous visitor', logical),
    });
  if (!portal?.webApiEntities?.[logical] || !metadata?.entity(logical))
    throw noEntityMetadata({ permissionDiagnostic: localAccess('a table that is unknown or not exported', logical) });
  const filter = columns?.map((name) => `LogicalName eq '${name}'`).join(' or ');
  const query = columns ? '?$expand=' + encodeURIComponent(`Attributes($filter=${filter})`) : '';
  const dataverseUrl = new URL(`/api/data/v9.1/EntityDefinitions(LogicalName='${logical}')${query}`, origin);
  // Loaded on use: dataverse-api.mjs reaches webapi-handler.mjs through dataverse-odata.mjs (an import cycle).
  const { metadataRead } = await import('./dataverse-api.mjs');
  const answer = metadataRead({ url: dataverseUrl, origin }, metadata, {
    version: 'v9.1',
    kind: 'metadataEntity',
    set: 'EntityDefinitions',
    key: `LogicalName='${logical}'`,
    segment: null,
    segmentKey: null,
    cast: null,
  });
  // The portal returns the Dataverse payload as is: its @odata.context names the organization's v9.1 metadata
  // (captured). The local organization origin is not in the portal's request context, so the portal origin stands in.
  const { Attributes: attributes, ...entity } = answer.body;
  return {
    status: 200,
    body: {
      ...entity,
      Privileges: metadata.retrieveEntityResponse(logical, 'Privileges')?.EntityMetadata?.Privileges ?? [],
      ...(columns ? { Attributes: attributes ?? [] } : {}),
    },
  };
}
