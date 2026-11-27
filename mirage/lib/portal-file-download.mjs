// The file control's download link, GET /File/download.aspx?Entity=<table>&Attribute=<file column>&Id=<record id>
// (platform.mjs renders it on forms). Hosted session F2 (fileapi runs a and b, follow-link:1) answered 200 with the
// bytes, Cache-Control: private, Content-Type: application/octet-stream, Content-Disposition: attachment;
// filename=<name> and Content-Length, without a redirect to a storage URL. The visitor needs the table permission Read on
// the record and Read of the column under column security, as on /_api. A missing, unreadable or empty file is not
// captured: Mirage answers the platform's plain 404 "Not Found" (the shape /_entity/annotation answers in the same
// session), with one X-Sim-Error-Code (FileDownloadNotFound) for every refusal.
import { GUID_PATTERN } from './dataverse-values.mjs';
import { contentDisposition, siteHeaders } from './response-headers.mjs';

const ROUTE = /^\/File\/download\.aspx$/i;

export const isPortalFileDownload = (pathname) => ROUTE.test(pathname);

/** The query value of name, matched case-insensitively as ASP.NET reads query keys. */
function parameter(url, name) {
  for (const [key, value] of url.searchParams) if (key.toLowerCase() === name) return value.trim();
  return '';
}

function notFound(res, portal) {
  const body = Buffer.from('Not Found', 'utf8');
  res.writeHead(404, {
    ...siteHeaders(portal ?? {}),
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.length),
    'x-sim-error-code': 'FileDownloadNotFound',
  });
  res.end(body);
}

/**
 * Answers one /File/download.aspx request. deps: { store, portal, identity, recordDiagnostic }.
 */
export async function handlePortalFileDownload(req, res, url, { store, portal, identity, recordDiagnostic }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...siteHeaders(portal ?? {}), allow: 'GET, HEAD', 'content-length': '0' });
    return res.end();
  }
  const entity = parameter(url, 'entity').toLowerCase();
  const column = parameter(url, 'attribute').toLowerCase();
  const id = parameter(url, 'id')
    .replace(/^\{(.*)\}$/, '$1')
    .toLowerCase();
  const pipeline = store.recordPipeline?.fileContentInternal;
  if (!entity || !column || !GUID_PATTERN.test(id) || !pipeline) return notFound(res, portal);
  let mapping;
  try {
    mapping = store.resolveMapping(entity);
  } catch {
    return notFound(res, portal);
  }
  if (pipeline.kindOf(mapping.logicalName, column) !== 'file') return notFound(res, portal);
  // The portal read of the record, as /_api/<set>(id)/<column>/$value reads it: table permission Read and the reader's
  // column security (a secured or masked column reads as no file id). Every refusal answers the same 404 and the same
  // X-Sim-Error-Code, so the answer never tells an existing record from a missing one.
  let row;
  try {
    row = store.get(mapping.logicalName, id, identity, { portalRequest: true });
  } catch (error) {
    if (error?.code !== 'PermissionDenied') throw error;
    recordDiagnostic?.({
      code: 'TABLE_PERMISSION_DENIED',
      severity: 'warning',
      operation: 'read',
      table: mapping.logicalName,
      path: url.pathname,
      message: error.message,
    });
    return notFound(res, portal);
  }
  if (!row || !GUID_PATTERN.test(String(row[column] ?? ''))) return notFound(res, portal);
  if (store.portalAuthorization?.canReadRawColumn?.(identity, mapping.logicalName, column, id) === false)
    return notFound(res, portal);
  // The table permission check above is the grant; the profile only carries it into the file seam's own check.
  const userId =
    [identity?.contactId, identity?.id].find((value) => GUID_PATTERN.test(String(value ?? ''))) ??
    '00000000-0000-0000-0000-000000000000';
  const answer = await pipeline({
    principal: {
      userId,
      evidence: 'portal table permissions (portal-file-download.mjs)',
      grants: [{ entity: mapping.logicalName, operations: ['read'] }],
    },
    operation: 'download',
    entity: mapping.logicalName,
    id: row[mapping.idColumn],
    column,
  });
  if (answer.statusCode !== 200) return notFound(res, portal);
  const body = Buffer.from(answer.body.$content, 'base64');
  res.writeHead(200, {
    ...siteHeaders(portal ?? {}),
    'cache-control': 'private',
    'content-type': 'application/octet-stream',
    'content-disposition': contentDisposition('attachment', answer.file.name, { tokenFilename: true }),
    'content-length': String(body.length),
    // Not sent by hosted (session F2 fileapi); Mirage adds it as on /_api file reads, so a browser never sniffs an uploaded
    // page out of the octet-stream body on the portal origin (mirage/docs/dataverse-parity.md).
    'x-content-type-options': 'nosniff',
  });
  return res.end(req.method === 'HEAD' ? undefined : body);
}
