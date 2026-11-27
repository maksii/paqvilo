// The Power Pages Azure Blob Storage file Web API (Learn: power-pages/configure/webapi-azure-blob):
//   POST   /_api/file/InitializeUpload/<table>(<id>)/blob             create the note and answer its id (the upload token)
//   PUT    /_api/file/UploadBlock/blob?offset=&fileSize=&chunkSize=&token=   stage one chunk of that upload
//   GET    /_api/file/download/annotation(<id>)/blob/$value           a redirect to a short-lived read URL, or the bytes
//   GET    /_api/file/sas/<container>/<annotationid>/<name>?se=&sp=r&sr=b&rscd=&rsct=&sig=   that read URL (Mirage-own)
//   DELETE /_api/file/delete/annotation(<id>)/blob/$value             delete the note and its file
//
// Documented (Learn): the Site/FileManagement/* settings, the FU000xx status, code and message table, the request shapes of
// the sample page (x-ms-file-name and x-ms-file-size headers, the query parameters, the __RequestVerificationToken header on
// writes), the table permissions of the walk-through (record: Read, Append to; note: Read, Write, Create, Append), the
// `.azure.txt` note file name the sample lists and strips, "These APIs will perform multiple updates on the note
// (Annotation) entity as files are uploaded in chunks", the 10 GB file limit, and that the token InitializeUpload answers
// addresses the note (the sample links annotation(<token>) for download and delete).
// Inferred (no published detail): the placeholder body (Mirage's cloud attachment shape { Name, Type, Size, Url }), the
// MIME type taken from the file name's extension, 200 with the token as a JSON string, 204 for UploadBlock and delete,
// Delete on the note for delete (the walk-through grants none, but the API "follows table permissions"), chunks placed by
// offset in any order with the file committed once every chunk arrived, chunkSize absent meaning one unchunked request, and
// FU00010 for a token that names no upload of this visitor and file. The bytes live on storage route
// portalCloudAttachments under <container>/<annotationid>/<file name>.
// Downloads follow the documented Site/FileManagement/DownloadViaSASUri (default true): download answers 302 to a read URL
// that expires after DownloadSASUriExpiryTimeSpan (default 00:10:00). The Azure blob host is a local stand-in on the portal
// origin, /_api/file/sas/<blob path>, with Azure's service SAS query names (se, sp, sr, rscd, rsct, sig) and Get Blob
// answers (200, 206 for a byte range, Accept-Ranges, ETag, the XML error body AuthenticationFailed 403, BlobNotFound 404,
// InvalidRange 416). Unlike an Azure SAS, its signature also binds the URL to the visitor session and identity that asked
// for it, so a copied link is refused in another browser; the redirect status and that binding are Mirage-own. With
// DownloadViaSASUri false the portal streams the file itself, reading the blob DownloadChunkSizeInKB (default 4096) at a time.
// Mirage-own refusals (block geometry, the upload bound) use the
// portal error envelope { error: { code, message } } with the code also in X-Sim-Error-Code; token and method failures
// answer the portal Web API's own errors (webapi-handler.mjs). See mirage/docs/storage-providers.md "Azure file Web API".
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { DataError } from './data-error.mjs';
import { mimeOfName } from './dataverse-files.mjs';
import { GUID_PATTERN } from './dataverse-values.mjs';
import { portalRecordWrites } from './form-service.mjs';
import { readRawBody } from './http-body.mjs';
import { siteSetting } from './redirects.mjs';
import { contentDisposition, siteHeaders } from './response-headers.mjs';
import { assertAntiForgeryToken, webApiErrorResponse } from './webapi-handler.mjs';

const MB = 1024 * 1024;
// Learn: "Chunk size is greater than 100 mb" (FU00013), "More than 128-mb file without chunking" (FU00017),
// "Azure File size of up to 10 GB is supported", MaxFileSize default 1048576 KB.
const MAX_CHUNK = 100 * MB;
const MAX_UNCHUNKED = 128 * MB;
const MAX_FILE = 10 * 1024 * MB;
const DEFAULT_MAX_KB = 1048576;
// Azure block blobs hold at most 50,000 committed blocks.
const MAX_BLOCKS = 50_000;
// Mirage-own bounds of the process-local upload list (as the staged note uploads in server.mjs).
const MAX_UPLOADS = 50;
const UPLOAD_IDLE_MS = 3_600_000;
const INIT_BODY_LIMIT = 64 * 1024;
// Learn: DownloadSASUriExpiryTimeSpan default 00:10:00, DownloadChunkSizeInKB default 4096.
const SAS_DEFAULT_MS = 10 * 60_000;
const SAS_MAX_MS = 7 * 86_400_000;
const DEFAULT_DOWNLOAD_CHUNK_KB = 4096;

const FU = Object.freeze({
  FU00001: [400, "File content isn't specified"],
  FU00002: [404, "Record isn't found"],
  FU00003: [403, "You don't have permissions to perform this operation"],
  FU00004: [400, "File extension isn't supported."],
  FU00005: [400, "File mimetype isn't supported"],
  FU00006: [400, 'File size is greater than {0}MB'],
  FU00007: [400, 'Azure configurations are incorrect'],
  FU00008: [400, 'Header x-ms-file-name is missing in the request'],
  // Hosted session F2 (fileapi runs a and b): the code is FU0009 (four digits, not Learn's FU00009) with this message.
  // Only the download route was captured; the other routes are assumed to answer the same.
  FU0009: [501, 'Azure webapi is not enabled for use'],
  FU00010: [400, "Requested file isn't available for {0}"],
  FU00012: [400, "File doesn't exist"],
  FU00013: [400, 'Chunk size is greater than 100mb'],
  FU00014: [400, 'File size not provided'],
  FU00015: [400, 'File extension is not supported'],
  FU00016: [400, 'File mimetype is not supported'],
  FU00017: [400, 'File size is more than 128mb'],
  FU00018: [403, "Microsoft Entra application doesn't have permissions to perform this operation"],
  FU00022: [400, 'Azure configurations are incorrect'],
});

const fu = (code, argument) => {
  const [status, template] = FU[code];
  return new DataError(template.replace('{0}', String(argument ?? '')), status, code, { fileApi: true });
};
// A Mirage-own refusal: no documented code covers it.
const own = (code, message, status = 400) => new DataError(message, status, code, { fileApi: true, mirageOwn: true });

const AZURE_SUFFIX = '.azure.txt';
const ACCOUNT = /^[a-z0-9]{3,24}$/;
const CONTAINER = /^(?=.{3,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

const ROUTES = [
  {
    kind: 'initialize',
    method: 'POST',
    pattern: /^\/_api\/file\/InitializeUpload\/([a-z_]\w*)\(([^()/]*)\)\/blob$/i,
  },
  { kind: 'upload', method: 'PUT', pattern: /^\/_api\/file\/UploadBlock\/blob$/i },
  { kind: 'download', method: 'GET', pattern: /^\/_api\/file\/download\/([a-z_]\w*)\(([^()/]*)\)\/blob\/\$value$/i },
  { kind: 'delete', method: 'DELETE', pattern: /^\/_api\/file\/delete\/([a-z_]\w*)\(([^()/]*)\)\/blob\/\$value$/i },
  // The local read URL of a blob: <container>/<annotationid>/<name> as keyName() writes it (lower case, no escapes).
  { kind: 'sas', method: 'GET', pattern: /^\/_api\/file\/sas\/([a-z0-9-]{3,63}\/[0-9a-f-]{36}\/[a-z0-9_.-]{1,200})$/ },
];

function fileApiRoute(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match) return { kind: route.kind, method: route.method, table: match[1] ?? null, key: match[2] ?? null };
  }
  return null;
}

// Upload sessions per store (one runtime): annotation id -> session. Process-local, as the staged note uploads are.
const uploadLists = new WeakMap();
const uploadsOf = (store) => {
  let list = uploadLists.get(store);
  if (!list) {
    list = new Map();
    uploadLists.set(store, list);
  }
  return list;
};

const apiHeaders = (portal) => ({
  'x-content-type-options': 'nosniff',
  ...siteHeaders(portal ?? {}),
  'cache-control': 'no-cache',
  pragma: 'no-cache',
  expires: '-1',
});
const text = (value) => String(value ?? '').trim();
const settingTrue = (portal, name) => text(siteSetting(portal, name)).toLowerCase() === 'true';
const now = (deps) => Number(deps.store.clock?.now?.() ?? Date.now());
const guid = (value) => {
  const id = text(value).replace(/^\{(.*)\}$/, '$1');
  return GUID_PATTERN.test(id) ? id.toLowerCase() : null;
};
const integer = (value) => (/^\d{1,15}$/.test(text(value)) ? Number(text(value)) : null);

/**
 * Handle one Azure file Web API request; false when the path is not one of its routes.
 * deps: { store, portal, identity, csrf, owner({ start }), attachmentBody(logical, row), storage(), change(fn), json,
 * recordDiagnostic }. owner({ start: true }) may start a visitor session (setting its cookie on the response).
 */
export async function handlePortalFileApi(req, res, url, deps) {
  const route = fileApiRoute(url.pathname);
  if (!route) return false;
  try {
    await sweep(deps);
    if (!settingTrue(deps.portal, 'Site/FileManagement/EnableWebAPI')) throw fu('FU0009');
    // The read URL also answers HEAD, as Azure Get Blob Properties does.
    const headRead = route.kind === 'sas' && req.method === 'HEAD';
    if (req.method !== route.method && !headRead)
      throw new DataError(
        `The HTTP method '${req.method}' is not allowed for this file API route.`,
        405,
        'MethodNotAllowed',
      );
    if (route.method !== 'GET') assertRequestToken(req, deps.csrf, deps.tokenRefusal);
    if (route.kind === 'initialize') await initializeUpload(route, req, res, deps);
    else if (route.kind === 'upload') await uploadBlock(req, res, url, deps);
    else if (route.kind === 'download') await download(route, res, deps);
    else if (route.kind === 'sas') await blobRead(route.table, req, res, url, deps, { head: headRead });
    else await remove(route, res, deps);
  } catch (error) {
    if (res.headersSent) {
      // A download the client left, or a failure after its headers: end the response without another answer.
      res.destroy();
      return true;
    }
    respondError(error, req, url, res, deps);
  }
  return true;
}

// The portal Web API's anti-forgery rule (webapi-handler.mjs assertAntiForgeryToken).
function assertRequestToken(req, expected, refusal) {
  assertAntiForgeryToken(req.headers.__requestverificationtoken, expected, refusal);
}

function respondError(cause, req, url, res, deps) {
  if (cause?.details?.blob) return blobError(res, cause, { head: req.method === 'HEAD' });
  const headers = apiHeaders(deps.portal);
  if (cause?.code === 'PermissionDenied') {
    permissionDiagnostic(deps, url, cause);
    cause = fu('FU00003');
  } else if (cause?.name === 'ProviderError') cause = providerFailure(cause, deps);
  // The disabled API answers { ErrorCode, Message } with the page cache headers (hosted session F2, fileapi runs a and b).
  if (cause?.code === 'FU0009')
    return deps.json(
      res,
      cause.status,
      { ErrorCode: cause.code, Message: cause.message },
      {
        ...siteHeaders(deps.portal ?? {}),
        'cache-control': 'no-cache, no-store, must-revalidate',
        pragma: 'no-cache',
        expires: '-1',
      },
    );
  if (cause?.details?.fileApi) {
    const body = { error: { code: cause.code, message: cause.message } };
    return deps.json(
      res,
      cause.status,
      body,
      cause.details.mirageOwn ? { ...headers, 'X-Sim-Error-Code': cause.code } : headers,
    );
  }
  const response = webApiErrorResponse(cause, {
    antiForgery: deps.portal?.observed?.webApiAntiForgery,
    errorMethod: req.method,
  });
  return deps.json(res, response.status, response.body, { ...headers, ...response.headers });
}

// An unauthorized provider is the Entra application without storage permissions (FU00018); a missing or unready provider
// is an incorrect Azure configuration (FU00007). Other provider failures stay the portal's unexpected error.
function providerFailure(cause, deps) {
  deps.recordDiagnostic?.({
    code: cause.diagnostic ?? 'FILE_API_STORAGE_FAILED',
    severity: 'error',
    message: `Azure file Web API storage failed: ${cause.message}`,
  });
  if (cause.code === 'Unauthorized') return fu('FU00018');
  if (['Unsupported', 'Unavailable'].includes(cause.code)) return fu('FU00007');
  return cause;
}

function permissionDiagnostic(deps, url, cause) {
  deps.recordDiagnostic?.({
    code: 'TABLE_PERMISSION_DENIED',
    severity: 'warning',
    operation: cause.details?.operation ?? null,
    table: cause.details?.table ?? null,
    path: url.pathname,
    message: cause.message,
  });
}

// Site/FileManagement/BlobStorageAccountName and BlobStorageContainerName are mandatory (FU00022 when absent); a name Azure
// would refuse, or no storage route portalCloudAttachments, is an incorrect configuration (FU00007).
function azureStorage(deps) {
  const account = text(siteSetting(deps.portal, 'Site/FileManagement/BlobStorageAccountName'));
  const container = text(siteSetting(deps.portal, 'Site/FileManagement/BlobStorageContainerName'));
  if (!account || !container) throw fu('FU00022');
  if (!ACCOUNT.test(account) || !CONTAINER.test(container)) throw fu('FU00007');
  let storage = null,
    reason = 'route portalCloudAttachments has no provider';
  try {
    storage = deps.storage();
  } catch (error) {
    reason = error.message;
  }
  if (!storage) {
    deps.recordDiagnostic?.({
      code: 'PROVIDER_ROUTE_MISSING',
      severity: 'error',
      message: `The Azure file Web API cannot store files: ${reason}. Set providers.routes.portalCloudAttachments.`,
    });
    throw fu('FU00007');
  }
  return { container, storage };
}

// Expired uploads end before the request that finds them proceeds, so their staged chunks are gone when it answers.
async function sweep(deps) {
  const uploads = uploadsOf(deps.store),
    time = now(deps);
  const expired = [...uploads].filter(([, session]) => time - session.touched > UPLOAD_IDLE_MS);
  await Promise.all(expired.map(([id, session]) => dropUpload(deps, id, session)));
}

// Ends an upload once its chunk in flight settles: deleting the key discards its staged blocks (every provider's delete
// drops uncommitted blocks). A failed discard is reported, never thrown.
async function dropUpload(deps, id, session, storage = session.storage) {
  const uploads = uploadsOf(deps.store);
  if (uploads.get(id) === session) uploads.delete(id);
  session.ended = true;
  await session.writing;
  try {
    await storage.delete(session.key);
  } catch (error) {
    if (error?.code !== 'NotFound')
      deps.recordDiagnostic?.({
        code: 'FILE_API_STAGED_DISCARD_FAILED',
        severity: 'warning',
        message: `The staged chunks of an ended Azure file upload could not be discarded: ${error.message}`,
      });
  }
}

// x-ms-file-name: the base name as sent, or percent-encoded with x-ms-file-name-encoding uri-component (Mirage's
// attach-file shim marker). A control character, a dot name or a name over 255 UTF-16 code units is refused.
function fileName(headers) {
  const raw = headers['x-ms-file-name'];
  if (raw == null || text(raw) === '') throw fu('FU00008');
  let name = text(raw);
  if (headers['x-ms-file-name-encoding'] === 'uri-component')
    try {
      name = decodeURIComponent(name).trim();
    } catch {
      throw own('FileNameInvalid', 'The file name is not a valid percent-encoded value.');
    }
  // eslint-disable-next-line no-control-regex -- control characters in an untrusted header are refused
  if (/[\u0000-\u001f\u007f]/.test(name)) throw own('FileNameInvalid', 'The file name contains a control character.');
  const base = name.split(/[\\/]/).at(-1).trim();
  if (!base || base === '.' || base === '..' || base.length > 255)
    throw own('FileNameInvalid', 'The file name is not a valid base name.');
  return base;
}

const extensionOf = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '');
const listSetting = (portal, name, separator) =>
  text(siteSetting(portal, name))
    .split(separator)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

// SupportedFileType (comma separated, ".jpeg,.jpg") and SupportedMimeType (";" separated) are mandatory.
function admitType(name, portal) {
  const extensions = listSetting(portal, 'Site/FileManagement/SupportedFileType', ',').map((item) =>
    item.startsWith('.') ? item : `.${item}`,
  );
  if (!extensions.length) throw fu('FU00015');
  const extension = extensionOf(name);
  if (!extension || !extensions.includes(extension)) throw fu('FU00004');
  const mimes = listSetting(portal, 'Site/FileManagement/SupportedMimeType', ';');
  if (!mimes.length) throw fu('FU00016');
  // The sample sends application/octet-stream, so the MIME type comes from the name (the file column map).
  const type = mimeOfName(name) ?? 'application/octet-stream';
  if (!mimes.includes(type)) throw fu('FU00005');
  return type;
}

// MaxFileSize is in KB (default 1048576, 1 GB); the platform supports files up to 10 GB.
function assertMaxSize(size, portal) {
  const configured = integer(siteSetting(portal, 'Site/FileManagement/MaxFileSize'));
  const limit = Math.min((configured && configured > 0 ? configured : DEFAULT_MAX_KB) * 1024, MAX_FILE);
  if (size > limit) throw fu('FU00006', Number((limit / MB).toFixed(2)));
}

const allowed = (store, logical, operation, row, identity) => {
  try {
    return store.allowed(logical, operation, row, identity) === true;
  } catch {
    return false;
  }
};
const deny = (logical, operation) =>
  new DataError(`Table permission denies ${operation} on ${logical}`, 403, 'PermissionDenied', {
    operation,
    table: logical,
  });

async function readRow(deps, logical, id) {
  try {
    return (await deps.store.get(logical, id, deps.identity, { portalRequest: true })) ?? null;
  } catch (error) {
    if (error?.code === 'UnknownEntity') throw fu('FU00002');
    throw error;
  }
}

async function regardingRecord(route, deps) {
  let mapping;
  try {
    mapping = deps.store.resolveMapping(route.table);
  } catch {
    throw fu('FU00002');
  }
  // The route names the table by its logical name, as the Learn sample does (cr463_filetest).
  const id = guid(route.key);
  if (mapping.logicalName !== route.table.toLowerCase() || !id || mapping.logicalName === 'annotation')
    throw fu('FU00002');
  const record = await readRow(deps, mapping.logicalName, id);
  if (!record) throw fu('FU00002');
  if (!allowed(deps.store, mapping.logicalName, 'appendTo', record, deps.identity))
    throw deny(mapping.logicalName, 'appendTo');
  return { mapping, id, record };
}

// The note's lookup to the record, as form attachments write it (form-service.mjs).
function objectBinding(store, mapping, id) {
  const annotation = store.resolveMapping('annotation');
  const binding = Object.entries(annotation.relationships ?? {}).find(
    ([, relation]) =>
      relation.many === false && relation.from === 'objectid' && relation.entity === mapping.logicalName,
  );
  return binding
    ? { [`${binding[0]}@odata.bind`]: `/${mapping.entitySet}(${id})` }
    : { objectid: { id, logical_name: mapping.logicalName } };
}

const placeholderBody = (session) =>
  Buffer.from(
    JSON.stringify({ Name: session.name, Type: session.type, Size: session.size, Url: session.key }),
  ).toString('base64');
const keyName = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 200) || 'file';
const write = (deps, work) =>
  deps.change(() => deps.store.transact(() => work(portalRecordWrites(deps.store)), { incremental: true }));

async function initializeUpload(route, req, res, deps) {
  const { container, storage } = azureStorage(deps);
  await readRawBody(req, {
    maximum: INIT_BODY_LIMIT,
    tooLarge: () => own('FileUploadInitializeBody', 'InitializeUpload carries no file content.', 413),
  });
  const name = fileName(req.headers);
  const sizeHeader = req.headers['x-ms-file-size'];
  if (sizeHeader == null || text(sizeHeader) === '') throw fu('FU00014');
  const size = integer(sizeHeader);
  if (size === null) throw fu('FU00014');
  if (size === 0) throw fu('FU00001');
  const type = admitType(name, deps.portal);
  assertMaxSize(size, deps.portal);
  const { mapping, id: recordId } = await regardingRecord(route, deps);
  const identity = deps.identity;
  const annotationId = randomUUID();
  const candidate = {
    annotationid: annotationId,
    objectid: { id: recordId, logical_name: mapping.logicalName },
    objecttypecode: mapping.logicalName,
    filename: `${name}${AZURE_SUFFIX}`,
    mimetype: 'text/plain',
  };
  // The walk-through's note grants: Create and Append to add it, Write for the updates each chunk makes.
  for (const operation of ['create', 'append', 'update'])
    if (!allowed(deps.store, 'annotation', operation, candidate, identity)) throw deny('annotation', operation);
  const uploads = uploadsOf(deps.store);
  if (uploads.size >= MAX_UPLOADS)
    throw own(
      'FileUploadLimit',
      `The local runtime has ${MAX_UPLOADS} unfinished Azure file uploads. Finish them or wait an hour for unused ones to expire.`,
      409,
    );
  const owner = deps.owner({ start: true });
  const session = {
    owner,
    name,
    size,
    type,
    key: `${container}/${annotationId}/${keyName(name)}`,
    storage,
    chunkSize: null,
    total: null,
    blocks: new Set(),
    writing: Promise.resolve(),
    touched: now(deps),
    ended: false,
  };
  const { objectid: _objectid, ...columns } = candidate; // NOSONAR: binding is excluded from the rest object
  await write(deps, (writes) =>
    writes.create(
      'annotation',
      { ...columns, documentbody: placeholderBody(session), ...objectBinding(deps.store, mapping, recordId) },
      identity,
    ),
  );
  uploads.set(annotationId, session);
  return deps.json(res, 200, annotationId, apiHeaders(deps.portal));
}

function blockGeometry(url, session) {
  const sizeParam = url.searchParams.get('fileSize');
  if (sizeParam == null || text(sizeParam) === '') throw fu('FU00014');
  if (integer(sizeParam) !== session.size) throw fu('FU00010', 'uploadblock');
  const chunkParam = url.searchParams.get('chunkSize');
  let chunkSize;
  if (chunkParam == null || text(chunkParam) === '') {
    if (session.size > MAX_UNCHUNKED) throw fu('FU00017');
    chunkSize = session.size;
  } else {
    chunkSize = integer(chunkParam);
    if (!chunkSize) throw own('FileBlockSizeInvalid', 'chunkSize must be a positive whole number of bytes.');
    if (chunkSize > MAX_CHUNK) throw fu('FU00013');
  }
  if (session.chunkSize !== null && chunkSize !== session.chunkSize)
    throw own('FileBlockSizeInconsistent', 'Every chunk of an upload uses the chunkSize of its first chunk.');
  const total = Math.ceil(session.size / chunkSize);
  if (total > MAX_BLOCKS)
    throw own('FileBlockCountExceeded', `An upload has at most ${MAX_BLOCKS} chunks; use a larger chunkSize.`);
  const offset = integer(url.searchParams.get('offset'));
  if (offset === null || offset >= session.size || offset % chunkSize !== 0)
    throw own('FileBlockOffsetInvalid', 'offset must start a chunk inside the file (a multiple of chunkSize).');
  return { chunkSize, total, offset, index: offset / chunkSize, length: Math.min(chunkSize, session.size - offset) };
}

async function uploadBlock(req, res, url, deps) {
  azureStorage(deps);
  const uploads = uploadsOf(deps.store);
  const token = guid(url.searchParams.get('token'));
  const session = token ? uploads.get(token) : undefined;
  const owner = deps.owner({ start: false });
  // The token binds the upload to the visitor session and identity that started it and to its file.
  if (!session || session.ended || !owner || session.owner !== owner) throw fu('FU00010', 'uploadblock');
  if (fileName(req.headers) !== session.name) throw fu('FU00010', 'uploadblock');
  const geometry = blockGeometry(url, session);
  const block = await readRawBody(req, {
    maximum: geometry.length,
    tooLarge: () => own('FileBlockLengthInvalid', `This chunk must hold exactly ${geometry.length} bytes.`),
  });
  if (!block.length) throw fu('FU00001');
  if (block.length !== geometry.length)
    throw own('FileBlockLengthInvalid', `This chunk must hold exactly ${geometry.length} bytes.`);
  const step = session.writing.then(async () => {
    // Recheck after the body and earlier chunks: the upload may have finished, expired or been deleted meanwhile.
    if (session.ended || uploads.get(token) !== session) throw fu('FU00010', 'uploadblock');
    if (session.chunkSize !== null && geometry.chunkSize !== session.chunkSize)
      throw own('FileBlockSizeInconsistent', 'Every chunk of an upload uses the chunkSize of its first chunk.');
    const note = await readRow(deps, 'annotation', token);
    if (!note) throw fu('FU00002');
    if (!allowed(deps.store, 'annotation', 'update', note, deps.identity)) throw deny('annotation', 'update');
    session.chunkSize = geometry.chunkSize;
    session.total = geometry.total;
    session.touched = now(deps);
    // Learn: the API updates the note as chunks upload; the placeholder names the file, its bytes stay in Azure.
    await write(deps, (writes) =>
      writes.update('annotation', token, { documentbody: placeholderBody(session) }, deps.identity),
    );
    // A repeated chunk replaces its staged block (Azure Put Block); the file is committed once, when every chunk arrived.
    await session.storage.put(session.key, block, { blockId: String(geometry.index).padStart(6, '0') });
    session.blocks.add(geometry.index);
    if (session.blocks.size === session.total) {
      const ids = Array.from({ length: session.total }, (_, index) => String(index).padStart(6, '0'));
      await session.storage.commit(session.key, ids, { contentType: session.type });
      session.ended = true;
      if (uploads.get(token) === session) uploads.delete(token);
    }
  });
  session.writing = step.catch(() => {});
  try {
    await step;
  } catch (error) {
    // A refused chunk leaves the upload usable; a failed write or provider operation ends it.
    if (!(error?.details?.fileApi || error?.code === 'PermissionDenied')) await dropUpload(deps, token, session);
    throw error;
  }
  res.writeHead(204, apiHeaders(deps.portal));
  res.end();
}

// The note of a download or delete: only notes (the sample addresses annotation(<id>)) written by this API.
async function azureNote(route, deps, operation) {
  if (route.table.toLowerCase() !== 'annotation') throw fu('FU00010', operation);
  const id = guid(route.key);
  if (!id) throw fu('FU00002');
  const note = await readRow(deps, 'annotation', id);
  if (!note) throw fu('FU00002');
  const stored = String(note.filename ?? '').toLowerCase();
  if (!stored.endsWith(AZURE_SUFFIX)) throw fu('FU00010', operation);
  let placeholder;
  try {
    const body = await deps.attachmentBody('annotation', note);
    placeholder = body ? JSON.parse(Buffer.from(body, 'base64').toString('utf8')) : null;
  } catch {
    placeholder = null;
  }
  // The object belongs to this note: <container>/<annotationid>/<name>, so a crafted placeholder cannot name another file.
  const key = typeof placeholder?.Url === 'string' ? placeholder.Url : '';
  if (key.split('/')[1] !== id) throw fu('FU00010', operation);
  return { id, note, placeholder, key };
}

async function download(route, res, deps) {
  const { storage } = azureStorage(deps);
  const { id, placeholder, key } = await azureNote(route, deps, 'download');
  if (uploadsOf(deps.store).has(id)) throw fu('FU00012');
  const name = String(placeholder.Name ?? '').trim() || 'download';
  const type = String(placeholder.Type ?? '');
  if (text(siteSetting(deps.portal, 'Site/FileManagement/DownloadViaSASUri')).toLowerCase() !== 'false') {
    // A blob that is not there is the portal's FU00012, as for the streamed download; no read URL is minted.
    if (!(await storage.head(key))) throw fu('FU00012');
    res.writeHead(302, { ...apiHeaders(deps.portal), location: readUrl(deps, key, { name, type }) });
    res.end();
    return;
  }
  const chunk = downloadChunkBytes(deps);
  let object;
  try {
    object = await storage.get(key, { range: { start: 0, end: chunk - 1 } });
  } catch (error) {
    if (error?.code === 'NotFound') throw fu('FU00012');
    // An empty blob has no first range: read it whole.
    if (error?.code !== 'InvalidRange') throw error;
    object = await storage.get(key);
  }
  res.writeHead(200, {
    ...apiHeaders(deps.portal),
    'content-type': type || object.contentType || 'application/octet-stream',
    'content-disposition': contentDisposition('attachment', name),
    ...(Number.isSafeInteger(object.size) ? { 'content-length': String(object.size) } : {}),
  });
  // pipeline honours backpressure and, when the client goes away, stops reading and releases the provider stream.
  await pipeline(chunkedBlob(storage, key, object, chunk), res);
}

// The blob in DownloadChunkSizeInKB reads; each later read must see the first one's ETag and size, so a blob replaced
// meanwhile ends the response instead of joining two versions.
async function* chunkedBlob(storage, key, first, chunk) {
  yield* first.body;
  const size = first.size;
  for (let start = (first.range?.end ?? size - 1) + 1; start < size; start += chunk) {
    const next = await storage.get(key, { range: { start, end: Math.min(start + chunk, size) - 1 } });
    if (next.etag !== first.etag || next.size !== size) throw new Error('The blob changed during the download.');
    yield* next.body;
  }
}

// Site/FileManagement/DownloadChunkSizeInKB (default 4096 KB, 4 MB); a value that is not a positive whole number of KB
// falls back to the default. At most 100 MB, the upload chunk bound.
function downloadChunkBytes(deps) {
  const raw = siteSetting(deps.portal, 'Site/FileManagement/DownloadChunkSizeInKB');
  const kb = integer(raw);
  if (kb && kb > 0) return Math.min(kb * 1024, MAX_CHUNK);
  if (text(raw))
    deps.recordDiagnostic?.({
      code: 'FILE_API_SETTING_INVALID',
      severity: 'warning',
      message: `Site/FileManagement/DownloadChunkSizeInKB "${text(raw)}" is not a positive whole number; the 4096 KB default applies.`,
    });
  return DEFAULT_DOWNLOAD_CHUNK_KB * 1024;
}

// ---- The local read URL (the SAS download)

// One signing key per runtime store: a restart invalidates every read URL it issued.
const signingKeys = new WeakMap();
const signingKey = (store) => {
  let key = signingKeys.get(store);
  if (!key) {
    key = randomBytes(32);
    signingKeys.set(store, key);
  }
  return key;
};
const signature = (deps, fields) =>
  createHmac('sha256', signingKey(deps.store)).update(fields.join('\n')).digest('base64url');
const BLOB_FIELDS = ['se', 'sp', 'sr', 'rscd', 'rsct'];
const TIME_SPAN = /^(?:(\d{1,7})\.)?(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?$/;

// A .NET TimeSpan ([d.]hh:mm[:ss[.fffffff]], or whole days) in milliseconds; null when it is not one.
function timeSpanMs(raw) {
  if (/^\d{1,7}$/.test(raw)) return Number(raw) * 86_400_000;
  const match = TIME_SPAN.exec(raw);
  if (!match) return null;
  const [, days = '0', hours, minutes, seconds = '0', fraction = '0'] = match;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  return (
    ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60_000 +
    Number(seconds) * 1000 +
    Math.floor(Number(`0.${fraction}`) * 1000)
  );
}

// Site/FileManagement/DownloadSASUriExpiryTimeSpan, default 00:10:00. A value that is not a positive span falls back to the
// default; one longer than 7 days (the longest Azure user delegation SAS) is held at 7 days.
function sasLifetimeMs(deps) {
  const raw = text(siteSetting(deps.portal, 'Site/FileManagement/DownloadSASUriExpiryTimeSpan'));
  if (!raw) return SAS_DEFAULT_MS;
  const ms = timeSpanMs(raw);
  if (ms === null || ms <= 0) {
    deps.recordDiagnostic?.({
      code: 'FILE_API_SETTING_INVALID',
      severity: 'warning',
      message: `Site/FileManagement/DownloadSASUriExpiryTimeSpan "${raw}" is not a positive time span; the 00:10:00 default applies.`,
    });
    return SAS_DEFAULT_MS;
  }
  return Math.min(ms, SAS_MAX_MS);
}

// The redirect target: the blob path, Azure's service SAS names and a signature over them, the visitor and identity.
function readUrl(deps, key, { name, type }) {
  // A visitor without a session gets one here (its cookie rides on the redirect), so the URL is bound to this browser.
  const binding = deps.owner({ start: true });
  const expiry = Math.ceil((now(deps) + sasLifetimeMs(deps)) / 1000) * 1000;
  const query = {
    se: new Date(expiry).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sp: 'r',
    sr: 'b',
    rscd: contentDisposition('attachment', name),
    rsct: type || 'application/octet-stream',
  };
  const sig = signature(deps, [key, ...BLOB_FIELDS.map((field) => query[field]), binding]);
  return `/_api/file/sas/${key}?${new URLSearchParams({ ...query, sig })}`;
}

const blobFailure = (status, code, message, extra = {}) =>
  new DataError(message, status, code, { blob: true, ...extra });
const AUTHENTICATION_FAILED =
  'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.';
// The Azure Blob error texts this route answers; the body is built from these constants only, never from an exception.
const BLOB_MESSAGES = new Map([
  ['AuthenticationFailed', AUTHENTICATION_FAILED],
  ['BlobNotFound', 'The specified blob does not exist.'],
  ['InvalidRange', 'The range specified is invalid for the current size of the resource.'],
]);
const BLOB_DETAILS = ['Signature did not match.', 'Signature not valid in the specified time frame.'];

// Azure's error body: <Error><Code/><Message/></Error> with RequestId and Time lines, and the code in x-ms-error-code.
// A HEAD answers the same status and headers without the body (the error code is in x-ms-error-code).
function blobError(res, cause, { head = false } = {}) {
  const requestId = randomUUID();
  const code = BLOB_MESSAGES.has(cause.code) ? cause.code : 'InternalError';
  const message = BLOB_MESSAGES.get(code) ?? 'Server encountered an internal error. Please try again after some time.';
  const known = BLOB_DETAILS.find((text) => text === cause.details.detail);
  const detail = known ? `<AuthenticationErrorDetail>${known}</AuthenticationErrorDetail>` : '';
  const body = `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${message}\nRequestId:${requestId}\nTime:${new Date().toISOString()}</Message>${detail}</Error>`;
  res.writeHead(code === 'InternalError' ? 500 : cause.status, {
    'content-type': 'application/xml',
    'x-content-type-options': 'nosniff',
    'x-ms-error-code': code,
    'x-ms-request-id': requestId,
    'cache-control': 'no-store',
    ...(Number.isSafeInteger(cause.details.size) ? { 'content-range': `bytes */${cause.details.size}` } : {}),
  });
  res.end(head ? undefined : body);
}

// Range or x-ms-range: bytes=<start>-[<end>]; another form is ignored and the whole blob answers (RFC 9110 14.2).
function blobRange(req) {
  const value = req.headers['x-ms-range'] ?? req.headers.range;
  const match = typeof value === 'string' ? /^bytes=(\d{1,15})-(\d{0,15})$/.exec(value.trim()) : null;
  if (!match) return null;
  return { start: Number(match[1]), end: match[2] === '' ? undefined : Number(match[2]) };
}

// The read URL's fields once its signature over them, this browser's binding and its expiry hold; else 403
// AuthenticationFailed, checked whole before anything else is said.
function readUrlFields(blobPath, url, deps, container) {
  const query = url.searchParams;
  const fields = Object.fromEntries(BLOB_FIELDS.map((field) => [field, query.get(field) ?? '']));
  const binding = deps.owner({ start: false });
  const expected = Buffer.from(
    signature(deps, [blobPath, ...BLOB_FIELDS.map((field) => fields[field]), binding ?? '']),
  );
  const given = Buffer.from(query.get('sig') ?? '');
  if (
    !binding ||
    blobPath.split('/')[0] !== container ||
    fields.sp !== 'r' ||
    fields.sr !== 'b' ||
    expected.length !== given.length ||
    !timingSafeEqual(expected, given)
  )
    throw blobFailure(403, 'AuthenticationFailed', AUTHENTICATION_FAILED, { detail: 'Signature did not match.' });
  const expiry = Date.parse(fields.se);
  if (!Number.isFinite(expiry) || expiry <= now(deps))
    throw blobFailure(403, 'AuthenticationFailed', AUTHENTICATION_FAILED, {
      detail: 'Signature not valid in the specified time frame.',
    });
  return fields;
}

// The blob (Get Blob, or its properties alone for a HEAD), with Azure's BlobNotFound and InvalidRange.
async function blobObject(storage, blobPath, { head, range }) {
  try {
    const options = range ? { range } : {};
    const object = head ? await storage.head(blobPath) : await storage.get(blobPath, options);
    if (!object) throw blobFailure(404, 'BlobNotFound', 'The specified blob does not exist.');
    return object;
  } catch (error) {
    if (error?.code === 'NotFound') throw blobFailure(404, 'BlobNotFound', 'The specified blob does not exist.');
    if (error?.code !== 'InvalidRange') throw error;
    const properties = await storage.head(blobPath).catch(() => null);
    throw blobFailure(416, 'InvalidRange', 'The range specified is invalid for the current size of the resource.', {
      size: properties?.size,
    });
  }
}

// The local Get Blob behind a read URL. head: Get Blob Properties (HEAD): the same checks and headers, the whole blob's
// length, no body and no range.
async function blobRead(blobPath, req, res, url, deps, { head = false } = {}) {
  const { container, storage } = azureStorage(deps);
  const fields = readUrlFields(blobPath, url, deps, container);
  const range = head ? null : blobRange(req);
  const object = await blobObject(storage, blobPath, { head, range });
  const partial = Boolean(range && object.range);
  const length = partial ? object.range.end - object.range.start + 1 : object.size;
  res.writeHead(partial ? 206 : 200, {
    'content-type': fields.rsct || object.contentType || 'application/octet-stream',
    'content-disposition': fields.rscd || 'attachment',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'x-ms-blob-type': 'BlockBlob',
    'cache-control': 'no-store',
    ...(object.etag ? { etag: object.etag } : {}),
    ...(object.lastModified ? { 'last-modified': new Date(object.lastModified).toUTCString() } : {}),
    ...(Number.isSafeInteger(length) ? { 'content-length': String(length) } : {}),
    ...(partial ? { 'content-range': `bytes ${object.range.start}-${object.range.end}/${object.size}` } : {}),
  });
  if (head) res.end();
  else await pipeline(object.body, res);
}

async function remove(route, res, deps) {
  const { storage } = azureStorage(deps);
  const { id, note, key } = await azureNote(route, deps, 'delete');
  if (!allowed(deps.store, 'annotation', 'delete', note, deps.identity)) throw deny('annotation', 'delete');
  await write(deps, (writes) => writes.remove('annotation', id, deps.identity));
  const session = uploadsOf(deps.store).get(id);
  if (session) await dropUpload(deps, id, session, storage);
  try {
    await storage.delete(key);
  } catch (error) {
    if (error?.code !== 'NotFound')
      deps.recordDiagnostic?.({
        code: 'FILE_API_BLOB_DELETE_FAILED',
        severity: 'warning',
        message: `The note was deleted, but its Azure file could not be removed: ${error.message}`,
      });
  }
  res.writeHead(204, apiHeaders(deps.portal));
  res.end();
}
