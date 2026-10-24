import { assertAttachmentSize } from './platform-settings.mjs';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_SESSIONS } from './dataverse-settings.mjs';
// Simulated Dataverse file and image columns: single and chunked uploads, ranged
// downloads, the block messages, and image value rules on record writes.
// Upload sessions live in memory, so a restart drops in-flight uploads.
// Bytes: with a storage route (setFileStorage, set by dataverse-storage-routing.mjs) entries keep `key` (files/<fileId>) and the
// provider holds the bytes; without one they stay in state JSON as base64 `data`.
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { systemClock, systemIds } from './runtime-clock.mjs';
import { DataError } from './data-error.mjs';
import { contextUrl, parseDataverseRoute, parseKey } from './dataverse-odata.mjs';
import { guidKey } from './dataverse-values.mjs';
import { contentDisposition, fileNameHeader } from './response-headers.mjs';
import { authorizeGrant, validateServiceProfile } from './local-organization-service.mjs';

const CHUNK_SIZE = 4194304;
const BLOCK_LIMIT = 4194304; // The docs say a block is under 4 MB; the exact native bound is a guess.
const BLOCK_ID_LIMIT = 64;
const DEFAULT_MAX_KB = { file: 32768, image: 10240 };
const CRM = 'Microsoft.Dynamics.CRM.';
const FILE_SIZE_INNER = '0x80044a02';
const IMAGE_INNER = '0x80072553';
const NON_PRIMARY_INNER = '0x80090487';
const MISSING_INNER = '0x80040217';
const RANGE_INNER = '0x80090000';
const BASE64_INNER = '0x80048d19';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAGIC = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/bmp', [0x42, 0x4d]],
];
const EXPOSE = 'x-ms-file-size, x-ms-file-name, mimetype';
const EXPOSE_RANGE = 'x-ms-file-size, x-ms-file-name, x-ms-chunk-size, mimetype';
// ponytail: the 15-minute idle TTL is a guess; it counts from a session's last use, and expired sessions are
// dropped on the next session start or lookup.
const SESSION_TTL_MS = 15 * 60 * 1000;
// CSDL for the six actions, so $metadata lists their parameters and response types.
const CSDL = {
  InitializeTemporaryFileBlocksUpload: `<ComplexType Name="InitializeTemporaryFileBlocksUploadResponse"><Property Name="FileContinuationToken" Type="Edm.String" /><Property Name="RecordId" Type="Edm.Guid" /></ComplexType><Action Name="InitializeTemporaryFileBlocksUpload"><Parameter Name="FileSize" Type="Edm.Int32" Nullable="false" /><Parameter Name="FileName" Type="Edm.String" Nullable="false" /><ReturnType Type="mscrm.InitializeTemporaryFileBlocksUploadResponse" Nullable="false" /></Action>`,
  InitializeFileBlocksUpload: `<ComplexType Name="InitializeFileBlocksUploadResponse">
  <Property Name="FileContinuationToken" Type="Edm.String" />
</ComplexType>
<Action Name="InitializeFileBlocksUpload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="FileAttributeName" Type="Edm.String" Nullable="false" />
  <Parameter Name="FileName" Type="Edm.String" />
  <ReturnType Type="mscrm.InitializeFileBlocksUploadResponse" Nullable="false" />
</Action>`,
  UploadBlock: `<Action Name="UploadBlock">
  <Parameter Name="BlockId" Type="Edm.String" Nullable="false" />
  <Parameter Name="BlockData" Type="Edm.Binary" Nullable="false" />
  <Parameter Name="FileContinuationToken" Type="Edm.String" Nullable="false" />
</Action>`,
  CommitFileBlocksUpload: `<ComplexType Name="CommitFileBlocksUploadResponse">
  <Property Name="FileId" Type="Edm.Guid" />
  <Property Name="FileSizeInBytes" Type="Edm.Int64" />
</ComplexType>
<Action Name="CommitFileBlocksUpload">
  <Parameter Name="FileName" Type="Edm.String" Nullable="false" />
  <Parameter Name="MimeType" Type="Edm.String" Nullable="false" />
  <Parameter Name="BlockList" Type="Collection(Edm.String)" Nullable="false" />
  <Parameter Name="FileContinuationToken" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.CommitFileBlocksUploadResponse" Nullable="false" />
</Action>`,
  InitializeFileBlocksDownload: `<ComplexType Name="InitializeFileBlocksDownloadResponse">
  <Property Name="FileSizeInBytes" Type="Edm.Int64" />
  <Property Name="FileName" Type="Edm.String" />
  <Property Name="FileContinuationToken" Type="Edm.String" />
  <Property Name="IsChunkingSupported" Type="Edm.Boolean" />
</ComplexType>
<Action Name="InitializeFileBlocksDownload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="FileAttributeName" Type="Edm.String" Nullable="false" />
  <Parameter Name="DataSource" Type="Edm.String" />
  <ReturnType Type="mscrm.InitializeFileBlocksDownloadResponse" Nullable="false" />
</Action>`,
  DownloadBlock: `<ComplexType Name="DownloadBlockResponse">
  <Property Name="Data" Type="Edm.Binary" />
</ComplexType>
<Action Name="DownloadBlock">
  <Parameter Name="Offset" Type="Edm.Int64" Nullable="false" />
  <Parameter Name="BlockLength" Type="Edm.Int64" Nullable="false" />
  <Parameter Name="FileContinuationToken" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.DownloadBlockResponse" Nullable="false" />
</Action>`,
  DeleteFile: `<Action Name="DeleteFile">
  <Parameter Name="FileId" Type="Edm.Guid" Nullable="false" />
</Action>`,
  // These response property sets follow the message documentation's summaries; the native CSDL may differ.
  InitializeAnnotationBlocksUpload: `<ComplexType Name="InitializeAnnotationBlocksUploadResponse">
  <Property Name="FileContinuationToken" Type="Edm.String" />
</ComplexType>
<Action Name="InitializeAnnotationBlocksUpload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <ReturnType Type="mscrm.InitializeAnnotationBlocksUploadResponse" Nullable="false" />
</Action>`,
  InitializeAttachmentBlocksUpload: `<ComplexType Name="InitializeAttachmentBlocksUploadResponse">
  <Property Name="FileContinuationToken" Type="Edm.String" />
</ComplexType>
<Action Name="InitializeAttachmentBlocksUpload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <ReturnType Type="mscrm.InitializeAttachmentBlocksUploadResponse" Nullable="false" />
</Action>`,
  CommitAnnotationBlocksUpload: `<ComplexType Name="CommitAnnotationBlocksUploadResponse">
  <Property Name="AnnotationId" Type="Edm.Guid" />
  <Property Name="FileSizeInBytes" Type="Edm.Int64" />
</ComplexType>
<Action Name="CommitAnnotationBlocksUpload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="BlockList" Type="Collection(Edm.String)" Nullable="false" />
  <Parameter Name="FileContinuationToken" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.CommitAnnotationBlocksUploadResponse" Nullable="false" />
</Action>`,
  CommitAttachmentBlocksUpload: `<ComplexType Name="CommitAttachmentBlocksUploadResponse">
  <Property Name="ActivityMimeAttachmentId" Type="Edm.Guid" />
  <Property Name="FileSizeInBytes" Type="Edm.Int64" />
</ComplexType>
<Action Name="CommitAttachmentBlocksUpload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <Parameter Name="BlockList" Type="Collection(Edm.String)" Nullable="false" />
  <Parameter Name="FileContinuationToken" Type="Edm.String" Nullable="false" />
  <ReturnType Type="mscrm.CommitAttachmentBlocksUploadResponse" Nullable="false" />
</Action>`,
  InitializeAnnotationBlocksDownload: `<ComplexType Name="InitializeAnnotationBlocksDownloadResponse">
  <Property Name="FileSizeInBytes" Type="Edm.Int64" />
  <Property Name="FileName" Type="Edm.String" />
  <Property Name="FileContinuationToken" Type="Edm.String" />
  <Property Name="IsChunkingSupported" Type="Edm.Boolean" />
</ComplexType>
<Action Name="InitializeAnnotationBlocksDownload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <ReturnType Type="mscrm.InitializeAnnotationBlocksDownloadResponse" Nullable="false" />
</Action>`,
  InitializeAttachmentBlocksDownload: `<ComplexType Name="InitializeAttachmentBlocksDownloadResponse">
  <Property Name="FileSizeInBytes" Type="Edm.Int64" />
  <Property Name="FileName" Type="Edm.String" />
  <Property Name="FileContinuationToken" Type="Edm.String" />
  <Property Name="IsChunkingSupported" Type="Edm.Boolean" />
</ComplexType>
<Action Name="InitializeAttachmentBlocksDownload">
  <Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" />
  <ReturnType Type="mscrm.InitializeAttachmentBlocksDownloadResponse" Nullable="false" />
</Action>`,
};

const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const missing = (message) => new DataError(message, 404, 'NotFound', { innerCode: MISSING_INNER });
const imageFailure = (logical, id, column) =>
  invalid(
    `Error occured when processing image. Reason: Update image properties failed for objectid: ${id}, logicalName: ${logical}, attribute: ${column}`,
    IMAGE_INNER,
  );
const mb = (bytes) => Number((bytes / 1048576).toFixed(2)); // The native MB rounding in the image size message is a guess.
const sameGuid = (a, b) => guidKey(a) != null && guidKey(a) === guidKey(b);
const header = (c, name) => {
  if (typeof c.headers?.get === 'function') return c.headers.get(name) ?? undefined;
  return Object.entries(c.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
};
// Node decodes header bytes as latin1; a name a client sent as raw UTF-8 bytes is decoded back when it is valid UTF-8.
const utf8Header = (value) => {
  const text = String(value);
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (!/[\x80-\xff]/.test(text) || /[^\x00-\xff]/.test(text)) return text;
  const decoded = Buffer.from(text, 'latin1').toString('utf8');
  return decoded.includes('�') ? text : decoded;
};
const mimeOf = (c) =>
  String(header(c, 'content-type') ?? '')
    .split(';')[0]
    .trim() || 'application/octet-stream';
// Small built-in map: a file column's mimetype comes from the file name's extension (native reports text/plain for .txt).
// ponytail: extensions outside this map fall back to the upload's content type, then application/octet-stream.
const MIME_BY_EXTENSION = {
  txt: 'text/plain',
  csv: 'text/csv',
  htm: 'text/html',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};
const mimeOfName = (name) => {
  const text = String(name ?? '');
  const extension = text.includes('.') ? text.slice(text.lastIndexOf('.') + 1).toLowerCase() : '';
  return Object.hasOwn(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension] : null;
};

const kindOf = (def) => {
  const type = String(def?.dataverseType ?? def?.columnMetadata?.type ?? '').toLowerCase();
  return type === 'file' || type === 'image' ? type : null;
};
// Solution-imported columns live in mapping.fieldMetadata; project mappings in mapping.fields.
const columnsOf = (mapping) => mapping?.fields ?? mapping?.fieldMetadata ?? {};
const fileColumn = (mapping, column) => {
  const def = columnsOf(mapping)[column],
    kind = kindOf(def);
  return kind ? { column, kind, def } : null;
};
const imageColumns = (mapping) => Object.entries(columnsOf(mapping)).filter(([, def]) => kindOf(def) === 'image');
// Without an isPrimary flag, the column named entityimage is taken as the primary image.
const isPrimary = (column, def) => def?.isPrimary === true || column === 'entityimage';
const maxBytes = (kind, def) =>
  Number(def?.MaxSizeInKB ?? def?.columnMetadata?.MaxSizeInKB ?? DEFAULT_MAX_KB[kind]) * 1024;

function assertSize(kind, limit, size) {
  if (size <= limit) return;
  if (kind === 'image') {
    throw invalid(
      `Error occured when processing image. Reason: File size is too big. MaxSize: ${mb(limit)} MB, Uploaded filesize: ${mb(size)} MB.`,
      IMAGE_INNER,
    );
  }
  throw invalid('Attachment file size is too big.', FILE_SIZE_INNER);
}

function sniffImage(bytes) {
  return MAGIC.find(([, signature]) => signature.every((byte, i) => bytes[i] === byte))?.[0] ?? null;
}

// Validates one column's file (its size and first bytes) and returns the entry without its bytes; the caller stores them.
function prepared({ logical, id = null, column, kind, def, name, size, head, mimeType, now = Date.now() }) {
  assertSize(kind, maxBytes(kind, def), size);
  const detected = kind === 'image' ? sniffImage(head) : null;
  if (kind === 'image' && !detected) throw imageFailure(logical, id, column);
  return {
    entity: logical,
    recordId: id,
    column,
    name: name || column,
    mimeType: detected ?? mimeOfName(name) ?? mimeType ?? 'application/octet-stream',
    size,
    createdOn: new Date(now).toISOString(),
  };
}

const filesOf = (store) => ((store.state.dataverse ??= {}).files ??= {});
const filesRead = (store) => store.state.dataverse?.files ?? {};

// ---- Storage routes
// api -> { files, annotations, released(keys) }: guarded providers for the dataverseFiles and annotations routes, and the
// routing module's post-commit release (it deletes the keys no committed row references).
const storageByApi = new WeakMap();
/** Routes this api's file bytes through storage providers; null keeps them in state as base64. */
export function setFileStorage(api, storage) {
  if (storage) storageByApi.set(api, storage);
  else storageByApi.delete(api);
}
export const fileKey = (fileId) => `files/${String(fileId).toLowerCase()}`;
export const ATTACHMENT_COLUMNS = Object.freeze({ annotation: 'documentbody', activitymimeattachment: 'body' });
const BLOB_KEY = /^annotations\/([0-9a-f-]{36})\/(\d+)$/;
/** The provider key of a note or attachment row's bytes, only when it is the row's own key (annotations/<rowId>/<n>). */
export function blobKeyOf(logical, row) {
  const match = BLOB_KEY.exec(String(row?.__blobkey ?? ''));
  const idColumn = logical === 'annotation' ? 'annotationid' : 'activitymimeattachmentid';
  return match && match[1] === guidKey(row[idColumn]) ? row.__blobkey : null;
}

/** The storage keys a row holds: files/<fileId> per file or image column, and a note or attachment row's own blob key. */
export function storedKeysOf(store, logical, row) {
  let mapping;
  try {
    mapping = store.resolveMapping(logical);
  } catch {
    return [];
  }
  const keys = Object.entries(columnsOf(mapping))
    .filter(([, def]) => kindOf(def))
    .map(([column]) => guidKey(row?.[column]))
    .filter(Boolean)
    .map(fileKey);
  const blob = ATTACHMENT_COLUMNS[mapping.logicalName] ? blobKeyOf(mapping.logicalName, row) : null;
  return blob ? [...keys, blob] : keys;
}

/** Reads stored bytes (a file entry, or { key } of a provider object), optionally one inclusive byte range. */
export async function readStoredBytes(api, entry, range) {
  if (entry?.data != null) {
    const all = Buffer.from(String(entry.data), 'base64');
    return range ? all.subarray(range.start, range.end + 1) : all;
  }
  const storage = storageByApi.get(api);
  const provider = String(entry?.key ?? '').startsWith('annotations/') ? storage?.annotations : storage?.files;
  if (!entry?.key || !provider)
    throw new DataError(
      'The file bytes are held by a storage provider this runtime does not have.',
      503,
      'StorageUnavailable',
    );
  const { body } = await provider.get(entry.key, range ? { range } : {});
  // ponytail: responses are Buffers, so a download is buffered once; stream when routes answer AsyncIterable bodies.
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// A project hook cannot await, so it puts a per-request marker string in the column (deferBytes) and the wrapped
// api.records.handle replaces each marker in the response with the loaded base64 before it answers; the records layer copies
// rows after projection, so only a value survives. A caller that bypasses the handler gets null for the column.
const PENDING = Symbol('pendingBytes');
export function deferBytes(c, target, column, load) {
  const pending = c?.[PENDING];
  if (!pending) return void (target[column] = null);
  const marker = `${pending.nonce}:${pending.loads.size}`;
  pending.loads.set(marker, load);
  target[column] = marker;
}
function replaceMarkers(value, loaded) {
  if (Array.isArray(value))
    value.forEach((item, i) => {
      if (typeof item === 'string' && loaded.has(item)) value[i] = loaded.get(item);
      else replaceMarkers(item, loaded);
    });
  else if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && loaded.has(item)) value[key] = loaded.get(item);
      else replaceMarkers(item, loaded);
    }
  }
}
/** Wraps api.records.handle once so deferred bytes are read before the response leaves (Web API, SOAP, TDS and internal callers). */
export function hydrateResponses(api) {
  const records = api.records;
  if (typeof records?.handle !== 'function' || records[PENDING]) return;
  const handle = records.handle;
  records[PENDING] = true;
  records.handle = async (ctx) => {
    const pending = { nonce: `\u0000paqvilo-bytes:${randomBytes(9).toString('base64url')}`, loads: new Map() };
    const result = await handle.call(records, { ...ctx, [PENDING]: pending });
    if (!pending.loads.size) return result;
    const loaded = new Map(await Promise.all([...pending.loads].map(async ([marker, load]) => [marker, await load()])));
    replaceMarkers(result?.body, loaded);
    return result;
  };
}

function recordOf(store, mapping, id) {
  const row = store.tableRows(mapping.logicalName).find((r) => sameGuid(r[mapping.idColumn], id));
  if (!row) throw missing(`${mapping.logicalName} With Id = ${id} Does Not Exist`);
  return row;
}

function targetOf(store, target) {
  const type = String(target?.['@odata.type'] ?? '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  if (!type && (typeof target === 'string' || typeof target?.['@odata.id'] === 'string')) {
    const path = (typeof target === 'string' ? target : target['@odata.id'])
      .replace(/^https?:\/\/[^/]+/i, '')
      .replace(/^\/?api\/data\/v\d+\.\d+\//i, '')
      .replace(/^\//, '');
    const match = /^([A-Za-z_]\w*)\(([0-9a-f-]{36})\)$/i.exec(path);
    if (!match || !guidKey(match[2])) throw invalid('Target must identify a record by its primary key.');
    return { mapping: store.resolveMapping(match[1]), id: match[2] };
  }
  if (!type) throw invalid('Target must be an entity reference with @odata.type.');
  const mapping = store.resolveMapping(type);
  const id = target[mapping.idColumn];
  if (guidKey(id) == null) throw invalid(`Target ${mapping.logicalName} must carry ${mapping.idColumn}.`);
  return { mapping, id };
}

function bodyOf(c) {
  if (typeof c.body !== 'string') return c.body ?? {};
  try {
    return JSON.parse(c.body);
  } catch {
    throw invalid('Request body is not valid JSON.');
  }
}

function mappingOfSet(store, set) {
  try {
    return store.resolveMapping(set);
  } catch {
    return null;
  }
}

// Releases the file currently on a column, adding its key to `released`. Caller holds the store transaction.
function release(store, row, column, kind, released = []) {
  const files = filesOf(store);
  if (row[column] && files[row[column]]) {
    released.push(fileKey(row[column]));
    delete files[row[column]];
  }
  row[column] = null;
  if (kind === 'file') row[`${column}_name`] = null;
}

// Puts a new file on a row, releasing the one it replaces. Returns the new file id.
function place(store, row, column, kind, entry, fileId, released) {
  release(store, row, column, kind, released);
  filesOf(store)[fileId] = entry;
  row[column] = fileId;
  if (kind === 'file') row[`${column}_name`] = entry.name;
  return fileId;
}

/**
 * Creates one row a message builds on the caller's behalf (block-committed notes and attachments, delivered email
 * attachments, SharePoint document locations) through the records layer's internal create (dataverse-records.mjs
 * createInternal, whose JSDoc lists what differs from a Web API create): authorization, state defaults, write hooks,
 * plug-in steps, system columns and the 412 alternate-key answer. Call it inside the caller's store transaction; returns the stored row.
 */
export function createThroughPipeline(api, c, logical, data) {
  return api.records.createInternal(c, logical, data);
}

// Upload and download sessions per API (api -> continuation token -> session). install registers them; reset clears them.
const sessionsByApi = new WeakMap();
const sasInlineByApi = new WeakMap();

// In-memory only: a reset ends every open upload and download session. Files already stored on rows are kept.
export function reset(api) {
  sessionsByApi.get(api)?.clear();
  sasInlineByApi.get(api)?.clear();
}

export function install(api) {
  const { store, change, principals, recordHooks, registry } = api;
  // Upload and download sessions keyed by continuation token.
  const sessions = new Map();
  const sasInline = new Map();
  sasInlineByApi.set(api, sasInline);
  const sasSecret = randomBytes(32);
  const clock = () => api.clock?.() ?? (api.store?.clock ?? systemClock).now();
  const uuid = () => (api.ids ?? api.store?.ids ?? systemIds).uuid();
  const sasSignature = (key, expiry, permission) =>
    createHmac('sha256', sasSecret).update(`${key}\n${expiry}\n${permission}`).digest('base64url');
  const sasUrl = (c, key, permission) => {
    const expiry = new Date(clock() + 3600_000).toISOString();
    return `${c.origin}/_sas/files/${encodeURIComponent(key)}?${new URLSearchParams({ se: expiry, sp: permission, sig: sasSignature(key, expiry, permission) })}`;
  };
  sessionsByApi.set(api, sessions);
  const purge = () => {
    const cutoff = clock() - SESSION_TTL_MS;
    for (const [token, session] of sessions) if (session.touchedAt < cutoff) sessions.delete(token);
    for (const [key, entry] of sasInline) if (entry.expiresAt <= clock()) sasInline.delete(key);
  };
  // Memory bounds (simulator settings maxUploadSessions and maxUploadBytes): open upload sessions, and bytes held in memory by
  // upload sessions plus inline note/attachment SAS copies. Native limits and wording are not known; refusals use the module's
  // 400 InvalidRequest, as its other size limits do.
  const maxSessions = () => api.settings?.maxUploadSessions ?? MAX_UPLOAD_SESSIONS;
  const maxBuffered = () => api.settings?.maxUploadBytes ?? MAX_UPLOAD_BYTES;
  const heldBy = (session) =>
    session.mode === 'range' ? session.received : session.mode === 'blocks' ? session.bytes : 0;
  const buffered = () => {
    let total = 0;
    for (const session of sessions.values()) total += heldBy(session);
    for (const entry of sasInline.values()) total += String(entry.data).length;
    return total;
  };
  // Refuses growing one session (or a new SAS copy, session null) to `size` bytes past the byte budget.
  const reserve = (session, size) => {
    if (buffered() - (session ? heldBy(session) : 0) + size > maxBuffered()) {
      throw invalid(
        `The simulator buffers at most ${maxBuffered()} bytes of in-flight uploads (dataverse.maxUploadBytes).`,
      );
    }
  };
  const openSession = (token, session) => {
    purge();
    if (
      session.mode !== 'download' &&
      [...sessions.values()].filter((s) => s.mode !== 'download').length >= maxSessions()
    ) {
      throw invalid(
        `The simulator allows at most ${maxSessions()} open upload sessions (dataverse.maxUploadSessions).`,
      );
    }
    sessions.set(token, { ...session, touchedAt: clock() });
  };
  // Every use of a session is activity: the idle TTL restarts.
  const liveSession = (token) => {
    purge();
    const session = sessions.get(token);
    if (session) session.touchedAt = clock();
    return session;
  };
  // Note and attachment sessions follow the organization attachment rule (Base64 length); file and image columns follow MaxSizeInKB.
  const assertSessionSize = (session, size) =>
    session.role
      ? assertAttachmentSize(store.state, 4 * Math.ceil(size / 3))
      : assertSize(session.kind, maxBytes(session.kind, session.def), size);
  const write = (fn) => change(() => store.transact(fn));
  const storage = () => storageByApi.get(api) ?? null;
  // Per key: one route may be served while the other is not (a declared provider that is missing keeps its bytes in state).
  const routed = (key) => Boolean(key.startsWith('annotations/') ? storage()?.annotations : storage()?.files);
  // In-flight keys, which the routing sweep and release flush skip: held from before a put until the owning write settles.
  const hold = (key) => storage()?.hold?.(key) ?? (() => {});
  const providerOf = (key) => {
    const provider = key.startsWith('annotations/') ? storage()?.annotations : storage()?.files;
    if (!provider)
      throw new DataError(
        'The file bytes are held by a storage provider this runtime does not have.',
        503,
        'StorageUnavailable',
      );
    return provider;
  };
  // Rollback safety: bytes reach the provider before the row transaction; a write hands the keys it released to the routing
  // module after it settles, which deletes those no committed row references. Bytes a failed write stored are swept as orphans.
  const writeFiles = async (fn) => {
    const released = [];
    try {
      return await write(() => fn(released));
    } finally {
      if (released.length) storage()?.released(released);
    }
  };
  // Stores a prepared entry's bytes: provider put under files/<fileId>, or base64 on the entry.
  const keep = async (entry, fileId, bytes) => {
    if (!routed(fileKey(fileId))) entry.data = bytes.toString('base64');
    else {
      entry.key = fileKey(fileId);
      await storage().files.put(entry.key, bytes, { contentType: entry.mimeType });
    }
    return entry;
  };
  const sizeOf = (block) => (typeof block === 'number' ? block : (block?.length ?? 0));
  // A routed upload session stages its blocks in the provider under the key its bytes will have; in memory otherwise.
  // The memory caps above still count a routed session's bytes, so open sessions bound the provider's staging area too.
  // ponytail: blocks of a session that expires or is reset stay in the provider's staging area; clear staging by age in
  // the provider if abandoned uploads pile up.
  const stageBlock = async (session, blockId, body) => {
    if (!routed(session.key)) return session.blocks.set(blockId, body);
    await providerOf(session.key).put(session.key, body, { blockId });
    session.blocks.set(blockId, body.length);
  };
  // Joins the listed blocks: committed by the provider (never joined in memory) or concatenated. Returns { size, head, bytes? }.
  const joinBlocks = async (session, list, contentType) => {
    if (!routed(session.key)) {
      const bytes = Buffer.concat(list.map((blockId) => session.blocks.get(String(blockId))));
      return { size: bytes.length, head: bytes, bytes };
    }
    const { size } = await providerOf(session.key).commit(session.key, list.map(String), { contentType });
    const head = size
      ? await readStoredBytes(api, { key: session.key }, { start: 0, end: Math.min(size, 16) - 1 })
      : Buffer.alloc(0);
    return { size, head };
  };
  // c.authorized: the caller checked its own explicit grants (fileContentInternal); no role check then.
  const authorize = (c, mapping, operation, row) =>
    c.authorized === true
      ? undefined
      : principals.authorize({ user: c.user, entity: mapping.logicalName, operation, row, mapping });
  const sessionOf = (token, mode) => {
    const session = liveSession(String(token ?? ''));
    if (session?.mode !== mode) throw invalid('The file continuation token is not valid.');
    return session;
  };
  const fileName = (c) => {
    const sent = header(c, 'x-ms-file-name');
    const name = sent != null ? utf8Header(sent) : c.url.searchParams.get('x-ms-file-name');
    if (!name) throw invalid('x-ms-file-name is required.');
    return name;
  };
  const reply = (c, name, fields) => ({
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, `${CRM}${name}Response`), ...fields },
  });

  async function stream(c) {
    const route = c.route;
    if (route?.kind !== 'property' && route?.kind !== 'value') return undefined;
    const mapping = mappingOfSet(store, route.set);
    const found = mapping && fileColumn(mapping, route.segment);
    const id = found ? parseKey(route.key)?.id : undefined;
    if (!found || !id) return undefined;
    if (route.kind === 'value') return c.method === 'GET' ? download(c, { mapping, id, ...found }) : undefined;
    if (c.method === 'PATCH') return upload(c, { mapping, id, ...found });
    if (c.method === 'DELETE') return clear(c, { mapping, id, ...found });
    return undefined;
  }

  async function upload(c, { mapping, id, column, kind, def }) {
    authorize(c, mapping, 'update', recordOf(store, mapping, id));
    const token = c.url.searchParams.get('sessiontoken');
    if (token) return chunk(c, { mapping, id, column, kind, def, token });
    const name = fileName(c);
    if (String(header(c, 'x-ms-transfer-mode') ?? '').toLowerCase() === 'chunked') {
      const continuation = uuid();
      const fileId = uuid();
      openSession(continuation, {
        mode: 'range',
        entity: mapping.logicalName,
        id,
        column,
        kind,
        def,
        name,
        received: 0,
        total: null,
        chunks: [],
        fileId,
        key: fileKey(fileId),
      });
      const location = `${c.origin}/api/data/${c.version}/${c.route.set}(${c.route.key})/${column}?sessiontoken=${continuation}`;
      return {
        status: 200,
        headers: {
          'Accept-Ranges': 'bytes',
          Location: location,
          'x-ms-chunk-size': String(CHUNK_SIZE),
          'Access-Control-Expose-Headers': 'x-ms-chunk-size',
        },
      };
    }
    const bytes = Buffer.from(c.bodyBuffer ?? []),
      fileId = uuid();
    const unhold = hold(fileKey(fileId));
    try {
      const entry = await keep(
        prepared({
          logical: mapping.logicalName,
          id,
          column,
          kind,
          def,
          name,
          size: bytes.length,
          head: bytes,
          mimeType: mimeOf(c),
          now: clock(),
        }),
        fileId,
        bytes,
      );
      await writeFiles((released) => place(store, recordOf(store, mapping, id), column, kind, entry, fileId, released));
    } finally {
      unhold();
    }
    return { status: 204 };
  }

  async function chunk(c, { mapping, id, column, kind, def, token }) {
    const session = liveSession(token);
    if (
      session?.mode !== 'range' ||
      session.entity !== mapping.logicalName ||
      session.column !== column ||
      !sameGuid(session.id, id)
    ) {
      throw invalid('The file upload session is not valid.');
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(header(c, 'content-range') ?? '').trim());
    if (!match) throw invalid('Content-Range must be bytes start-end/size.');
    const [start, end, total] = match.slice(1).map(Number);
    const bytes = Buffer.from(c.bodyBuffer ?? []);
    if (start !== session.received || end < start || end >= total || bytes.length !== end - start + 1) {
      throw invalid('Content-Range does not continue the upload.'); // Native wording not known.
    }
    if (session.total === null) {
      assertSize(kind, maxBytes(kind, def), total);
      session.total = total;
    } else if (session.total !== total) {
      throw invalid('Content-Range size changed during the upload.');
    }
    reserve(session, end + 1);
    if (routed(session.key)) {
      await storage().files.put(session.key, bytes, { blockId: `r${start}` });
      session.chunks.push(`r${start}`);
    } else session.chunks.push(bytes);
    if (start === 0) session.head = bytes.subarray(0, 16);
    session.received = end + 1;
    if (session.received < total) return { status: 206, headers: { 'OData-Version': '4.0' } };
    sessions.delete(token);
    const data = routed(session.key) ? null : Buffer.concat(session.chunks);
    const entry = prepared({
      logical: mapping.logicalName,
      id,
      column,
      kind,
      def,
      name: session.name,
      size: total,
      head: session.head ?? Buffer.alloc(0),
      mimeType: mimeOf(c),
      now: clock(),
    });
    const unhold = hold(session.key);
    try {
      if (data) entry.data = data.toString('base64');
      else {
        entry.key = session.key;
        await storage().files.commit(session.key, session.chunks, { contentType: entry.mimeType });
      }
      await writeFiles((released) =>
        place(store, recordOf(store, mapping, id), column, kind, entry, session.fileId, released),
      );
    } finally {
      unhold();
    }
    return { status: 204, headers: { 'OData-Version': '4.0' } };
  }

  async function download(c, { mapping, id, column, kind, def }) {
    const row = recordOf(store, mapping, id);
    authorize(c, mapping, 'read', row);
    const entry = row[column] ? filesRead(store)[row[column]] : null;
    // Native answers the download route's own errors (404 and 416 observed) as plain application/json, not the OData minimal type.
    const plain = (error) => Object.assign(error, { details: { ...error.details, contentType: 'application/json' } });
    // A file column answers an empty value with 404 (native); an image column answers 204.
    if (!entry) {
      if (kind === 'file') throw plain(missing(`No file attachment found for attribute: ${column} EntityId: ${id}.`));
      return { status: 204 };
    }
    // canStoreFullImage defaults to false, as the metadata does, so size=full answers 204 unless the column stores full images.
    if (kind === 'image' && c.url.searchParams.get('size') === 'full' && def?.canStoreFullImage !== true)
      return { status: 204 };
    const size = entry.data != null ? Buffer.from(String(entry.data), 'base64').length : entry.size;
    // Simple token names retain the organization file-column wire format. Other
    // names use the RFC 6266 fallback so Unicode and punctuation stay safe.
    const base = {
      'x-ms-file-size': String(size),
      'x-ms-file-name': fileNameHeader(entry.name),
      mimetype: entry.mimeType,
      'Content-Disposition': contentDisposition('inline', entry.name, { tokenFilename: true }),
      'Access-Control-Expose-Headers': EXPOSE,
    };
    const range = header(c, 'range');
    // An image without size=full answers the thumbnail with no file headers at all.
    const thumbnail = kind === 'image' && c.url.searchParams.get('size') !== 'full';
    if (range === undefined)
      return {
        status: 200,
        headers: { ...(thumbnail ? {} : base), ...(kind === 'file' ? { 'OData-Version': undefined } : {}) },
        body: await readStoredBytes(api, entry),
      };
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(range).trim());
    if (!match) throw plain(invalid('The Range header must be bytes=start-end.'));
    const start = Number(match[1]);
    // A start past the end (or an end before the start) is native's 416 with the chunk-range code, not the generic range error.
    const unsatisfiable = () =>
      plain(
        new DataError(
          'Chunk range used in this call is either not valid or it is bigger than allowed 4 MB.',
          416,
          'InvalidRange',
          { innerCode: RANGE_INNER },
        ),
      );
    if (start >= size) throw unsatisfiable();
    const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (end < start) throw unsatisfiable();
    return {
      status: 206,
      headers: {
        ...base,
        'Access-Control-Expose-Headers': EXPOSE_RANGE,
        'x-ms-chunk-size': String(CHUNK_SIZE),
        'OData-Version': '4.0',
        'Content-Range': `bytes ${start}-${end}/${size}`,
      },
      body: await readStoredBytes(api, entry, { start, end }),
    };
  }

  async function clear(c, { mapping, id, column, kind }) {
    authorize(c, mapping, 'update', recordOf(store, mapping, id));
    await writeFiles((released) => release(store, recordOf(store, mapping, id), column, kind, released));
    return { status: 204 };
  }

  /**
   * The file and image column entry for callers outside the Web API (the flow Dataverse connector's
   * GetEntityFileImageFieldContent and UpdateEntityFileImageFieldContent): store.recordPipeline.fileContentInternal(
   * { principal, operation: 'download' | 'upload', entity, id, column, size, content, fileName }) -> { statusCode, body }.
   * principal is an explicit local backend profile (local-organization-service.mjs): download needs its read grant on the
   * row, upload its update grant. Both run the Web API download and single-request upload closures (size limits, storage
   * routing, released bytes, the 204 of an empty image). A download answers the flow file shape { $content-type, $content }
   * (base64); an upload takes content as a Buffer, base64 text or that shape, and answers 204 with {}.
   * The connector's exact response shapes for these two actions are a guess.
   */
  // The portal Web API (webapi-handler.mjs fileColumnRequest) also calls it, with operation 'delete' (the column's DELETE)
  // and contentType (the upload's Content-Type); fileContentInternal.kindOf(entity, column) answers 'file', 'image' or null.
  async function fileContentInternal({
    principal,
    operation,
    entity,
    id,
    column,
    size = null,
    content = null,
    fileName = null,
    contentType = null,
    defaultName = false,
  } = {}) {
    validateServiceProfile(principal);
    const mapping = store.resolveMapping(entity);
    const found = fileColumn(mapping, column);
    if (!found) throw invalid(`'${column}' is not a file or image column of ${mapping.logicalName}.`);
    if (!guidKey(id)) throw invalid('The record id must be a GUID.');
    const row = recordOf(store, mapping, id);
    const download = operation === 'download';
    if (!download && operation !== 'upload' && operation !== 'delete')
      throw invalid('The file operation must be download, upload or delete.');
    authorizeGrant(store, principal, mapping.logicalName, download ? 'read' : 'update', row);
    if (operation === 'delete')
      return { statusCode: (await clear({ authorized: true }, { mapping, id, ...found })).status, body: {} };
    const url = new URL(`http://localhost/${download && size === 'full' ? '?size=full' : ''}`);
    if (download) {
      const answer = await downloadFile({ authorized: true, url, headers: {} }, { mapping, id, ...found });
      if (answer.status === 204) return { statusCode: 204, body: {} };
      const entry = filesRead(store)[row[column]];
      const bytes = Buffer.from(answer.body ?? []);
      // file: the stored entry's name, size and MIME type, for callers that send their own download headers (the portal /_api).
      return {
        statusCode: 200,
        body: { '$content-type': entry?.mimeType ?? 'application/octet-stream', $content: bytes.toString('base64') },
        file: {
          name: entry?.name ?? column,
          size: bytes.length,
          mimeType: entry?.mimeType ?? 'application/octet-stream',
        },
      };
    }
    const shaped =
      content !== null && typeof content === 'object' && !Buffer.isBuffer(content) && !(content instanceof Uint8Array);
    const raw = shaped ? content.$content : content;
    if (raw == null) throw invalid('The file content is required.');
    const bytes =
      Buffer.isBuffer(raw) || raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw), 'base64');
    // defaultName (the portal /_api, whose documented sample sends no name): the stored file's name, else <column>.bin.
    // The name the platform stores for a nameless portal upload is a guess.
    const name = fileName || (defaultName ? (filesRead(store)[row[column]]?.name ?? `${column}.bin`) : null);
    if (!name) throw invalid('x-ms-file-name is required.');
    const type = shaped ? content['$content-type'] : contentType;
    const answer = await upload(
      {
        authorized: true,
        url,
        headers: { 'x-ms-file-name': name, ...(type ? { 'content-type': type } : {}) },
        bodyBuffer: bytes,
      },
      { mapping, id, ...found },
    );
    return { statusCode: answer.status ?? 204, body: {} };
  }
  const downloadFile = (c, target) => download(c, target);
  fileContentInternal.kindOf = (entity, column) => fileColumn(store.resolveMapping(entity), column)?.kind ?? null;
  api.records.fileContentInternal = fileContentInternal;

  // Synchronous without a storage route; a routed write returns the provider puts' promise (awaited inside the write).
  function beforeWrite(c, mapping, { operation, data, existing }) {
    if (operation !== 'create' && operation !== 'update') return;
    const files = filesOf(store),
      puts = [];
    for (const [column, def] of imageColumns(mapping)) {
      if (!data || !Object.hasOwn(data, column)) continue;
      const value = data[column];
      if (operation === 'create' && value != null && !isPrimary(column, def)) {
        throw invalid(
          `Non-primary image attribute ${column} of entity ${mapping.logicalName} is not allowed to upload during Create operation.`,
          NON_PRIMARY_INNER,
        );
      }
      // The replaced or cleared image is released in afterWrite, once the row write has landed.
      if (value == null) {
        data[column] = null;
        continue;
      }
      const id = existing?.[mapping.idColumn] ?? data[mapping.idColumn] ?? null;
      // Record writes answer a malformed base64 value with the payload-converter error, quoting the literal (stack trace omitted).
      if (typeof value !== 'string' || !BASE64.test(value)) {
        throw new DataError(
          "Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: Cannot convert the literal '" +
            String(value) +
            "' to the expected type 'Edm.Binary'. ---> System.FormatException: The input is not a valid Base-64 string as it contains a non-base 64 character, more than two padding characters, or an illegal character among the padding characters.",
          400,
          'InvalidRequest',
          { innerCode: BASE64_INNER },
        );
      }
      const bytes = Buffer.from(value, 'base64');
      // A guess: a record write with bytes that are not a supported image answers "Invalid argument." (0x80040203), not the $value wording.
      if (!sniffImage(bytes)) throw invalid('Invalid argument.');
      const fileId = uuid();
      const entry = (files[fileId] = prepared({
        logical: mapping.logicalName,
        id,
        column,
        kind: 'image',
        def,
        name: column,
        size: bytes.length,
        head: bytes,
        now: clock(),
      }));
      if (routed(fileKey(fileId))) {
        storage().holdWrite?.(fileKey(fileId));
        puts.push(keep(entry, fileId, bytes));
      } else entry.data = bytes.toString('base64');
      data[column] = fileId;
    }
    return puts.length ? Promise.all(puts).then(() => undefined) : undefined;
  }

  // Runs after a create or update has committed. A create stored its images before the record had an id, so the
  // id is filled in here; then every image this write replaced or cleared is released.
  // ponytail: the release scans all stored files per image-bearing write; index by record if that gets slow.
  function afterWrite(_c, mapping, { operation, id }) {
    if (operation !== 'create' && operation !== 'update') return;
    const columns = imageColumns(mapping).map(([column]) => column);
    if (!columns.length) return;
    const row = store.tableRows(mapping.logicalName).find((r) => sameGuid(r[mapping.idColumn], id));
    if (!row) return;
    const files = filesOf(store);
    for (const column of columns) {
      if (row[column] && files[row[column]]) files[row[column]].recordId = id;
    }
    const released = [];
    for (const [fileId, entry] of Object.entries(files)) {
      const replaced =
        entry.entity === mapping.logicalName &&
        columns.includes(entry.column) &&
        sameGuid(entry.recordId, id) &&
        row[entry.column] !== fileId;
      if (replaced) {
        released.push(fileKey(fileId));
        delete files[fileId];
      }
    }
    if (released.length) storage()?.released(released);
  }

  // Read returns image columns as base64 with the companion columns Dataverse adds.
  function project(c, mapping, formatted) {
    const images = imageColumns(mapping);
    if (!images.length) return;
    const files = filesRead(store);
    const stored = new Map();
    for (const r of store.tableRows(mapping.logicalName)) {
      const key = guidKey(r[mapping.idColumn]);
      if (key && !stored.has(key)) stored.set(key, r);
    }
    for (const row of [].concat(formatted ?? [])) {
      if (!row || typeof row !== 'object') continue;
      const key = guidKey(row[mapping.idColumn]);
      const raw = key ? stored.get(key) : undefined;
      for (const [column] of images) {
        if (!Object.hasOwn(row, column)) continue;
        const fileId = raw?.[column] ?? null;
        const entry = fileId ? files[fileId] : null;
        const stamp = entry ? Date.parse(entry.createdOn) : null; // The native _timestamp format is a guess.
        if (entry?.data == null && entry?.key)
          deferBytes(c, row, column, async () => {
            // A blob the provider no longer has reads as null with a diagnostic, like storage routing (STORAGE_OBJECT_MISSING).
            try {
              return (await readStoredBytes(api, entry)).toString('base64');
            } catch (error) {
              if (error?.code !== 'NotFound') throw error;
              storageByApi.get(api)?.missing?.(mapping.logicalName, key, entry.key);
              return null;
            }
          });
        else row[column] = entry ? entry.data : null;
        row[`${column}id`] = fileId;
        row[`${column}_timestamp`] = stamp;
        row[`${column}_url`] = entry
          ? `/Image/download.aspx?Entity=${mapping.logicalName}&Attribute=${column}&Id=${fileId}&Timestamp=${stamp}`
          : null;
      }
    }
  }

  // Annotation and attachment block messages. Their size limit is platform-settings assertAttachmentSize (MaxUploadFileSize
  // against the Base64 length, /_sim overrides honoured), checked per block here and again by the record pipeline at commit.
  // Initialize*BlocksUpload takes Target and answers a continuation token. Upload is create-only, so the
  // session names the table being created and the Target the new row regards (a guess at the native Target semantics).
  function initBlocksUpload(c, logical, name) {
    const input = bodyOf(c);
    const { mapping, id } = targetOf(store, input.Target);
    principals.authorize({ user: c.user, entity: logical, operation: 'create' });
    const token = uuid(),
      rowId = uuid();
    openSession(token, {
      mode: 'blocks',
      entity: mapping.logicalName,
      id,
      role: logical,
      kind: 'file',
      def: {},
      name: null,
      blockLength: null,
      bytes: 0,
      blocks: new Map(),
      rowId,
      key: `annotations/${rowId}/1`,
    });
    return reply(c, name, { FileContinuationToken: token });
  }

  // Commit creates one row (annotation or activitymimeattachment) regarding the session's Target, with the joined bytes as base64
  // text, through the record create pipeline (blocked extensions and MIME types, size, ownership, plug-ins, audit, hooks, events).
  // The commit's Target carries filename and mimetype; FileName/MimeType parameters are also read. The mimetype falls
  // back to the file name's extension. objectid (and an attachment's activityid) is the lookup { id, logical_name } of the session's
  // Target, as other note writers store it. The activityid mapping is a guess.
  async function commitRowBlocks(c, logical, name) {
    const input = bodyOf(c);
    const token = String(input.FileContinuationToken ?? '');
    const session = sessionOf(token, 'blocks');
    if (session.role !== logical) throw invalid('The file upload session is not valid.');
    const list = Array.isArray(input.BlockList) ? input.BlockList : [];
    const parts = list.map((blockId) => session.blocks.get(String(blockId)));
    if (!list.length || parts.some((part) => part === undefined))
      throw invalid('BlockList names a block that was not uploaded.');
    principals.authorize({ user: c.user, entity: logical, operation: 'create' });
    const target = input.Target && typeof input.Target === 'object' ? input.Target : {};
    const filename = input.FileName ?? target.filename ?? null;
    const mimetype = input.MimeType ?? target.mimetype ?? mimeOfName(filename) ?? 'application/octet-stream';
    // A routed session's blocks are committed by the provider; the row carries the key and the routing hooks serve the column.
    const unhold = hold(session.key);
    let size;
    try {
      const joined = await joinBlocks(session, list, mimetype);
      size = joined.size;
      const body = joined.bytes ? joined.bytes.toString('base64') : null;
      const id = session.rowId,
        regarding = { id: session.id, logical_name: session.entity };
      const row = { filesize: size, filename, mimetype, ...(joined.bytes ? {} : { __blobkey: session.key }) };
      if (logical === 'annotation') {
        Object.assign(row, {
          annotationid: id,
          objectid: regarding,
          objecttypecode: session.entity,
          documentbody: body,
          isdocument: true,
        });
        if (target.subject != null) row.subject = target.subject;
      } else {
        Object.assign(row, {
          activitymimeattachmentid: id,
          objectid: regarding,
          objecttypecode: session.entity,
          activityid: regarding,
          body,
        });
      }
      await write(() => createThroughPipeline(api, c, logical, row));
    } finally {
      unhold();
    }
    const id = session.rowId;
    sessions.delete(token);
    const answer = logical === 'annotation' ? { AnnotationId: id } : { ActivityMimeAttachmentId: id };
    return reply(c, name, { ...answer, FileSizeInBytes: size });
  }

  // Initialize*BlocksDownload takes Target (the annotation or activitymimeattachment row) and answers the same shape as
  // InitializeFileBlocksDownload. The answer shape and error wording for a row with no bytes are a guess.
  async function initBlocksDownload(c, logical, column, name) {
    const input = bodyOf(c);
    const { mapping, id } = targetOf(store, input.Target);
    if (mapping.logicalName !== logical) throw invalid(`Target must be a ${logical} row.`);
    const row = recordOf(store, mapping, id);
    authorize(c, mapping, 'read', row);
    const key = row[column] == null ? blobKeyOf(logical, row) : null;
    if (row[column] == null && !key) throw missing(`No file found for ${logical} ${id}.`);
    const size = key
      ? ((await providerOf(key).head(key))?.size ?? 0)
      : Buffer.from(String(row[column]), 'base64').length;
    const token = uuid();
    openSession(token, {
      mode: 'download',
      fileId: null,
      ...(key ? { key, size } : { data: row[column] }),
      entity: logical,
      id,
    });
    return reply(c, name, {
      FileSizeInBytes: size,
      FileName: row.filename ?? '',
      FileContinuationToken: token,
      IsChunkingSupported: true,
    });
  }

  const actions = {
    async InitializeTemporaryFileBlocksUpload(c) {
      const input = bodyOf(c),
        size = Number(input.FileSize),
        name = String(input.FileName ?? '');
      if (!name || !Number.isInteger(size) || size <= 0)
        throw invalid('FileName and a positive FileSize are required.');
      assertSize('file', maxBytes('file', {}), size);
      const token = uuid(),
        recordId = uuid(),
        fileId = uuid();
      openSession(token, {
        mode: 'blocks',
        entity: null,
        id: recordId,
        column: null,
        kind: 'file',
        def: {},
        name,
        expectedSize: size,
        creator: c.user?.systemuserid,
        blockLength: null,
        bytes: 0,
        blocks: new Map(),
        fileId,
        key: fileKey(fileId),
      });
      return reply(c, 'InitializeTemporaryFileBlocksUpload', { FileContinuationToken: token, RecordId: recordId });
    },
    async InitializeAnnotationBlocksUpload(c) {
      return initBlocksUpload(c, 'annotation', 'InitializeAnnotationBlocksUpload');
    },

    async InitializeAttachmentBlocksUpload(c) {
      return initBlocksUpload(c, 'activitymimeattachment', 'InitializeAttachmentBlocksUpload');
    },

    async CommitAnnotationBlocksUpload(c) {
      return commitRowBlocks(c, 'annotation', 'CommitAnnotationBlocksUpload');
    },

    async CommitAttachmentBlocksUpload(c) {
      return commitRowBlocks(c, 'activitymimeattachment', 'CommitAttachmentBlocksUpload');
    },

    async InitializeAnnotationBlocksDownload(c) {
      return initBlocksDownload(c, 'annotation', 'documentbody', 'InitializeAnnotationBlocksDownload');
    },

    async InitializeAttachmentBlocksDownload(c) {
      return initBlocksDownload(c, 'activitymimeattachment', 'body', 'InitializeAttachmentBlocksDownload');
    },

    async InitializeFileBlocksUpload(c) {
      const input = bodyOf(c);
      const { mapping, id } = targetOf(store, input.Target);
      const found = fileColumn(mapping, input.FileAttributeName);
      if (!found) throw invalid(`${input.FileAttributeName} is not a file or image column of ${mapping.logicalName}.`);
      const name = String(input.FileName ?? '');
      if (!name) throw invalid('FileName is required.');
      authorize(c, mapping, 'update', recordOf(store, mapping, id));
      const token = uuid(),
        fileId = uuid();
      openSession(token, {
        mode: 'blocks',
        entity: mapping.logicalName,
        id,
        ...found,
        name,
        blockLength: null,
        bytes: 0,
        blocks: new Map(),
        fileId,
        key: fileKey(fileId),
      });
      return reply(c, 'InitializeFileBlocksUpload', { FileContinuationToken: token });
    },

    async UploadBlock(c) {
      const input = bodyOf(c);
      const session = sessionOf(input.FileContinuationToken, 'blocks');
      const blockId = Buffer.from(String(input.BlockId ?? ''), 'base64');
      const block = Buffer.from(String(input.BlockData ?? ''), 'base64');
      if (
        blockId.length === 0 ||
        blockId.length > BLOCK_ID_LIMIT ||
        (session.blockLength !== null && blockId.length !== session.blockLength)
      ) {
        throw invalid('BlockId must be base64 of up to 64 bytes, the same length for every block of a file.');
      }
      if (block.length > BLOCK_LIMIT) throw invalid('BlockData is larger than one block.');
      // Blocks count against MaxSizeInKB as they arrive; a re-sent BlockId replaces its earlier bytes.
      const replaced = sizeOf(session.blocks.get(String(input.BlockId)));
      assertSessionSize(session, session.bytes - replaced + block.length);
      reserve(session, session.bytes - replaced + block.length);
      await stageBlock(session, String(input.BlockId), block);
      session.bytes += block.length - replaced;
      session.blockLength ??= blockId.length;
      return { status: 204 };
    },

    async CommitFileBlocksUpload(c) {
      const input = bodyOf(c);
      const token = String(input.FileContinuationToken ?? '');
      const session = sessionOf(token, 'blocks');
      const list = Array.isArray(input.BlockList) ? input.BlockList : [];
      const parts = list.map((blockId) => session.blocks.get(String(blockId)));
      if (!list.length || parts.some((part) => part === undefined))
        throw invalid('BlockList names a block that was not uploaded.');
      const mapping = session.entity ? store.resolveMapping(session.entity) : null;
      if (mapping) authorize(c, mapping, 'update', recordOf(store, mapping, session.id));
      else if (session.creator !== c.user?.systemuserid) throw invalid('The file continuation token is not valid.');
      const listed = parts.reduce((total, part) => total + sizeOf(part), 0);
      if (session.expectedSize != null && listed !== session.expectedSize)
        throw invalid('The uploaded size does not match FileSize.');
      const fileId = session.fileId,
        unhold = hold(session.key);
      let size;
      try {
        const joined = await joinBlocks(session, list, input.MimeType);
        size = joined.size;
        const entry = prepared({
          logical: session.entity,
          id: session.id,
          column: session.column,
          kind: session.kind,
          def: session.def,
          name: input.FileName || session.name,
          size,
          head: joined.head,
          mimeType: input.MimeType,
          now: clock(),
        });
        if (joined.bytes) entry.data = joined.bytes.toString('base64');
        else entry.key = session.key;
        await writeFiles((released) => {
          if (mapping)
            place(store, recordOf(store, mapping, session.id), session.column, session.kind, entry, fileId, released);
          else filesOf(store)[fileId] = { ...entry, creator: session.creator };
        });
      } finally {
        unhold();
      }
      sessions.delete(token);
      return reply(c, 'CommitFileBlocksUpload', { FileId: fileId, FileSizeInBytes: size });
    },

    async InitializeFileBlocksDownload(c) {
      const input = bodyOf(c);
      const { mapping, id } = targetOf(store, input.Target);
      const found = fileColumn(mapping, input.FileAttributeName);
      if (!found) throw invalid(`${input.FileAttributeName} is not a file or image column of ${mapping.logicalName}.`);
      const row = recordOf(store, mapping, id);
      authorize(c, mapping, 'read', row);
      const entry = row[found.column] ? filesRead(store)[row[found.column]] : null;
      if (!entry) throw missing(`No file found for ${found.column} of ${mapping.logicalName} record ${id}.`); // Native wording not known.
      const token = uuid();
      openSession(token, { mode: 'download', fileId: row[found.column], entity: mapping.logicalName, id });
      return reply(c, 'InitializeFileBlocksDownload', {
        FileSizeInBytes: entry.size,
        FileName: entry.name,
        FileContinuationToken: token,
        IsChunkingSupported: true,
      });
    },

    async DownloadBlock(c) {
      const input = bodyOf(c);
      const session = sessionOf(input.FileContinuationToken, 'download');
      // An annotation or attachment download carries its base64 bytes or provider key in the session (see initBlocksDownload).
      const entry =
        session.data != null
          ? { data: session.data }
          : session.key
            ? { key: session.key, size: session.size }
            : filesRead(store)[session.fileId];
      if (!entry) throw missing(`File ${session.fileId} does not exist.`);
      const mapping = store.resolveMapping(session.entity);
      authorize(c, mapping, 'read', recordOf(store, mapping, session.id));
      const offset = Number(input.Offset ?? 0);
      const length = Number(input.BlockLength ?? 0);
      if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
        throw invalid('Offset must be a whole number and BlockLength one or more.');
      }
      // Native answers a negative Offset with the whole file and ignores BlockLength.
      const size = entry.data != null ? Buffer.from(String(entry.data), 'base64').length : entry.size;
      const block =
        offset >= size
          ? Buffer.alloc(0)
          : await readStoredBytes(
              api,
              entry,
              offset < 0 ? undefined : { start: offset, end: Math.min(offset + length, size) - 1 },
            );
      return reply(c, 'DownloadBlock', { Data: block.toString('base64') });
    },

    async DeleteFile(c) {
      const input = bodyOf(c);
      const key = guidKey(input.FileId);
      const entry = key && Object.hasOwn(filesRead(store), key) ? filesRead(store)[key] : null;
      if (!entry) throw missing(`File ${input.FileId} does not exist.`);
      if (entry.entity == null) {
        if (entry.creator !== c.user?.systemuserid) throw missing(`File ${input.FileId} does not exist.`);
        await writeFiles((released) => {
          delete filesOf(store)[key];
          released.push(fileKey(key));
        });
        return { status: 204 };
      }
      const mapping = store.resolveMapping(entry.entity);
      authorize(c, mapping, 'update', recordOf(store, mapping, entry.recordId));
      const found = fileColumn(mapping, entry.column);
      await writeFiles((released) => {
        const row = recordOf(store, mapping, entry.recordId);
        if (guidKey(row[entry.column]) === key) release(store, row, entry.column, found?.kind, released);
        delete filesOf(store)[key];
        released.push(fileKey(key));
      });
      return { status: 204 };
    },
  };

  // The records layer hands the stream hook no raw body, so a binary PATCH to a file column stored nothing, and it refuses
  // size= on $value before any hook runs. The extension route sees the raw body and the query; other verbs fall through.
  api.addRoute(
    (pathname) => {
      const route = parseDataverseRoute(pathname);
      if (route?.kind !== 'property' && route?.kind !== 'value') return false;
      const mapping = mappingOfSet(store, route.set);
      return Boolean(mapping && fileColumn(mapping, route.segment));
    },
    async (c) => (await stream(c)) ?? api.records.handle(c),
  );
  recordHooks.add('stream', stream);
  recordHooks.add('beforeWrite', beforeWrite);
  recordHooks.add('afterWrite', afterWrite);
  recordHooks.add('project', project);
  for (const [name, handle] of Object.entries(actions)) {
    registry.register({
      name,
      kind: 'action',
      binding: 'unbound',
      handle,
      csdl: CSDL[name],
      ...(name === 'InitializeTemporaryFileBlocksUpload'
        ? {
            signature: {
              params: [
                ['FileSize', 'Edm.Int32'],
                ['FileName', 'Edm.String'],
              ],
              response: [
                ['FileContinuationToken', 'Edm.String'],
                ['RecordId', 'Edm.Guid'],
              ],
            },
          }
        : {}),
    });
  }

  // The returned URL permits anonymous download for one hour. It grants access
  // only to the signed file id; the API request that mints it still authorizes the table and record.
  registry.register({
    name: 'GetFileSasUrl',
    kind: 'function',
    binding: 'unbound',
    csdl: `<ComplexType Name="FileSasUrlResponse"><Property Name="FileName" Type="Edm.String" /><Property Name="FileSizeInBytes" Type="Edm.Int64" /><Property Name="MimeType" Type="Edm.String" /><Property Name="SasUrl" Type="Edm.String" /></ComplexType><ComplexType Name="GetFileSasUrlResponse"><Property Name="Result" Type="mscrm.FileSasUrlResponse" /></ComplexType><Function Name="GetFileSasUrl"><Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" /><Parameter Name="FileAttributeName" Type="Edm.String" Nullable="false" /><Parameter Name="DataSource" Type="Edm.String" /><ReturnType Type="mscrm.GetFileSasUrlResponse" Nullable="false" /></Function>`,
    handle: (c) => {
      const input = { ...bodyOf(c), ...(c.params ?? {}) },
        { mapping, id } = targetOf(store, input.Target);
      const source = String(input.DataSource ?? 'default').toLowerCase();
      if (!['default', 'bin', 'retained'].includes(source))
        throw invalid('DataSource must be default, bin or retained.');
      const row =
        source === 'default'
          ? recordOf(store, mapping, id)
          : (store.datasourceRows?.(source, mapping.logicalName, c.identity) ?? []).find((row) =>
              sameGuid(row[mapping.idColumn], id),
            );
      if (!row) throw missing(`${mapping.logicalName} With Id = ${id} Does Not Exist`);
      authorize(c, mapping, 'read', row);
      let key, entry;
      // A routed note or file is signed by its provider; no byte copy is kept.
      const providerSas = async (storedKey) => {
        const url = await providerOf(storedKey).sas(storedKey, { permission: 'r', expiresOn: clock() + 3600_000 });
        return /^https?:/i.test(url) ? url : `${c.origin}${url}`;
      };
      if (['annotation', 'activitymimeattachment'].includes(mapping.logicalName)) {
        if (input.FileAttributeName !== '') throw invalid('FileAttributeName must be empty for notes and attachments.');
        key = `inline:${uuid()}`;
        const bytes = row[mapping.logicalName === 'annotation' ? 'documentbody' : 'body'];
        const blobKey = bytes == null ? blobKeyOf(mapping.logicalName, row) : null;
        if (blobKey)
          return (async () => {
            const size = (await providerOf(blobKey).head(blobKey))?.size ?? 0;
            return reply(c, 'GetFileSasUrl', {
              Result: {
                FileName: row.filename ?? '',
                FileSizeInBytes: size,
                MimeType: row.mimetype ?? 'application/octet-stream',
                SasUrl: await providerSas(blobKey),
              },
            });
          })();
        if (bytes == null) throw missing('No file attachment found.');
        purge();
        reserve(null, String(bytes).length);
        entry = {
          name: row.filename ?? '',
          mimeType: row.mimetype ?? 'application/octet-stream',
          data: bytes,
          size: Buffer.from(String(bytes), 'base64').length,
        };
        sasInline.set(key, { ...entry, expiresAt: clock() + 3600_000 });
      } else {
        const found = fileColumn(mapping, input.FileAttributeName);
        if (!found) throw invalid('FileAttributeName is not a file or image column.');
        if (found.kind === 'image' && found.def?.canStoreFullImage !== true)
          throw invalid('GetFileSasUrl only works for image columns that store full images.');
        key = row[found.column];
        entry = filesRead(store)[key];
        if (!entry) throw missing('No file attachment found.');
        if (entry.data == null && entry.key)
          return providerSas(entry.key).then((SasUrl) =>
            reply(c, 'GetFileSasUrl', {
              Result: { FileName: entry.name, FileSizeInBytes: entry.size, MimeType: entry.mimeType, SasUrl },
            }),
          );
      }
      return reply(c, 'GetFileSasUrl', {
        Result: {
          FileName: entry.name,
          FileSizeInBytes: entry.size,
          MimeType: entry.mimeType,
          SasUrl: sasUrl(c, key, 'r'),
        },
      });
    },
  });
  // Native CSDL declares Result: InitializeUploadUsingSasResponse. The local upload URL streams one block; callers
  // finish with CommitFileBlocksUpload.
  registry.register({
    name: 'GetFileSasUrlForUpload',
    kind: 'function',
    binding: 'unbound',
    csdl: `<ComplexType Name="InitializeUploadUsingSasResponse"><Property Name="SasUrl" Type="Edm.String" /><Property Name="FileContinuationToken" Type="Edm.String" /></ComplexType><ComplexType Name="GetFileSasUrlForUploadResponse"><Property Name="Result" Type="mscrm.InitializeUploadUsingSasResponse" /></ComplexType><Function Name="GetFileSasUrlForUpload"><Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" /><Parameter Name="FileAttributeName" Type="Edm.String" Nullable="false" /><Parameter Name="FileName" Type="Edm.String" Nullable="false" /><ReturnType Type="mscrm.GetFileSasUrlForUploadResponse" Nullable="false" /></Function>`,
    handle: async (c) => {
      const result = await actions.InitializeFileBlocksUpload({ ...c, body: { ...bodyOf(c), ...(c.params ?? {}) } });
      const token = result.body.FileContinuationToken;
      return reply(c, 'GetFileSasUrlForUpload', {
        Result: { SasUrl: sasUrl(c, `upload:${token}`, 'w'), FileContinuationToken: token },
      });
    },
  });
  api.addRoute(
    (pathname) => pathname.startsWith('/_sas/files/'),
    async (c) => {
      const url = c.url,
        expiry = url.searchParams.get('se'),
        permission = url.searchParams.get('sp'),
        signature = url.searchParams.get('sig') ?? '';
      let key;
      try {
        key = decodeURIComponent(url.pathname.slice('/_sas/files/'.length));
      } catch {
        key = '';
      }
      const expected = sasSignature(key, expiry, permission),
        bytes = Buffer.from(signature);
      const failure = () => ({
        status: 403,
        body: { error: { code: 'AuthenticationFailed', message: 'Signature not valid or expired.' } },
      });
      if (
        !expiry ||
        !Number.isFinite(Date.parse(expiry)) ||
        clock() >= Date.parse(expiry) ||
        bytes.length !== Buffer.byteLength(expected) ||
        !timingSafeEqual(bytes, Buffer.from(expected))
      )
        return failure();
      if (permission === 'w' && c.method === 'PUT' && key.startsWith('upload:')) {
        const session = sessionOf(key.slice(7), 'blocks'),
          blockId = Buffer.from('sas').toString('base64');
        let received = 0;
        // Anonymous routes run before the authenticated body's reader. Verify the capability first, then enforce
        // the same column size limit while streaming; a large request never materializes an unbounded buffer.
        async function* checked() {
          for await (const chunk of c.bodyBuffer != null ? [c.bodyBuffer] : (c.req ?? [])) {
            const bytes = Buffer.from(chunk);
            received += bytes.length;
            assertSessionSize(session, received);
            reserve(session, received);
            yield bytes;
          }
        }
        let block = null;
        // A routed session streams the body straight into the provider's staged block.
        if (routed(session.key)) await providerOf(session.key).put(session.key, checked(), { blockId });
        else {
          const chunks = [];
          for await (const bytes of checked()) chunks.push(bytes);
          block = Buffer.concat(chunks);
        }
        assertSessionSize(session, received);
        session.blocks.clear();
        session.blocks.set(blockId, block ?? received);
        session.bytes = received;
        session.blockLength = 3;
        return { status: 201 };
      }
      if (permission !== 'r' || c.method !== 'GET' || key.startsWith('upload:')) return failure();
      purge();
      const entry = filesRead(store)[key] ?? sasInline.get(key);
      if (entry?.data == null)
        return { status: 404, body: { error: { code: 'NotFound', message: 'File not found.' } } };
      return { status: 200, body: Buffer.from(entry.data, 'base64'), headers: sasHeaders(entry.mimeType, entry.name) };
    },
    { anonymous: true },
  );
  // Provider SAS URLs (storage-local-disk.mjs answers /_sas/storage/<id>/<key>): the provider verifies the signature, the
  // name and type come from the file entry or the note row that still holds the key, so a released key answers 404.
  const denied = () => ({
    status: 403,
    body: { error: { code: 'AuthenticationFailed', message: 'Signature not valid or expired.' } },
  });
  api.addRoute(
    (pathname) => pathname.startsWith('/_sas/storage/'),
    async (c) => {
      const routes = storage();
      if (!routes || c.method !== 'GET') return denied();
      for (const provider of new Set([routes.files, routes.annotations])) {
        let key;
        try {
          ({ key } = await provider.verifySas(c.url.href, { permission: 'r' }));
        } catch {
          continue;
        }
        const meta = describeKey(key);
        if (!meta) return { status: 404, body: { error: { code: 'NotFound', message: 'File not found.' } } };
        return {
          status: 200,
          body: await readStoredBytes(api, { key }),
          headers: sasHeaders(meta.mimeType, meta.name),
        };
      }
      return denied();
    },
    { anonymous: true },
  );
  // { name, mimeType } of the file entry or note/attachment row holding a provider key; null when nothing holds it.
  function describeKey(key) {
    if (key.startsWith('files/')) {
      const entry = filesRead(store)[key.slice(6)];
      return entry?.key === key ? { name: entry.name, mimeType: entry.mimeType } : null;
    }
    for (const logical of Object.keys(ATTACHMENT_COLUMNS)) {
      const row = (store.state.tables[logical] ?? []).find((r) => blobKeyOf(logical, r) === key);
      if (row) return { name: row.filename, mimeType: row.mimetype };
    }
    return null;
  }
}

const sasHeaders = (mimeType, name) => ({
  'Content-Type': mimeType ?? 'application/octet-stream',
  'Content-Disposition': contentDisposition('attachment', name ?? 'download'),
});
