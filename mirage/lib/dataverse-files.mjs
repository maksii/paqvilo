// Simulated Dataverse file and image columns: single and chunked uploads, ranged
// downloads, the block messages, and image value rules on record writes.
// Upload sessions live in memory, so a restart drops in-flight uploads.
// ponytail: file bytes sit in state JSON as base64; move them to a side file under .paqvilo/ if state size matters.
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { contextUrl, parseDataverseRoute, parseKey } from "./dataverse-odata.mjs";
import { guidKey } from "./dataverse-values.mjs";

const CHUNK_SIZE = 4194304;
const BLOCK_LIMIT = 4194304; // unverified: per-block bound (the docs say under 4 MB)
const BLOCK_ID_LIMIT = 64;
const DEFAULT_MAX_KB = { file: 32768, image: 10240 };
const CRM = "Microsoft.Dynamics.CRM.";
const FILE_SIZE_INNER = "0x80044a02";
const IMAGE_INNER = "0x80072553";
const NON_PRIMARY_INNER = "0x80090487";
const MISSING_INNER = "0x80040217";
const RANGE_INNER = "0x80090000";
const BASE64_INNER = "0x80048d19";
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAGIC = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/bmp", [0x42, 0x4d]],
];
const EXPOSE = "x-ms-file-size, x-ms-file-name, mimetype";
const EXPOSE_RANGE = "x-ms-file-size, x-ms-file-name, x-ms-chunk-size, mimetype";
// ponytail: the 15-minute session TTL is a guess [unverified]; expired sessions are dropped on the next session start or lookup.
const SESSION_TTL_MS = 15 * 60 * 1000;
// CSDL for the six actions, so $metadata lists their parameters and response types (Web API action reference).
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
  // unverified: the response property sets are from the Learn pages' summaries (see the message notes in the module).
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

const invalid = (message, innerCode = "0x80040203") => new DataError(message, 400, "InvalidRequest", { innerCode });
const missing = (message) => new DataError(message, 404, "NotFound", { innerCode: MISSING_INNER });
const imageFailure = (logical, id, column) => invalid(
  `Error occured when processing image. Reason: Update image properties failed for objectid: ${id}, logicalName: ${logical}, attribute: ${column}`,
  IMAGE_INNER,
);
const mb = (bytes) => Number((bytes / 1048576).toFixed(2)); // unverified: MB rounding in the image size message
const nowIso = () => new Date().toISOString();
const sameGuid = (a, b) => guidKey(a) != null && guidKey(a) === guidKey(b);
const header = (c, name) => {
  if (typeof c.headers?.get === "function") return c.headers.get(name) ?? undefined;
  return Object.entries(c.headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
};
const mimeOf = (c) => String(header(c, "content-type") ?? "").split(";")[0].trim() || "application/octet-stream";
// Small built-in map: a file column's mimetype comes from the file name's extension (native reports text/plain for .txt).
// ponytail: extensions outside this map fall back to the upload's content type, then application/octet-stream.
const MIME_BY_EXTENSION = {
  txt: "text/plain", csv: "text/csv", htm: "text/html", html: "text/html", css: "text/css", js: "text/javascript", json: "application/json",
  xml: "application/xml", pdf: "application/pdf", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", md: "text/markdown", mp3: "audio/mpeg", mp4: "video/mp4",
};
const mimeOfName = (name) => {
  const text = String(name ?? "");
  const extension = text.includes(".") ? text.slice(text.lastIndexOf(".") + 1).toLowerCase() : "";
  return Object.hasOwn(MIME_BY_EXTENSION, extension) ? MIME_BY_EXTENSION[extension] : null;
};

// unverified: column types are dataverseType "file" and "image"; MaxSizeInKB sits on the field definition
const kindOf = (def) => {
  const type = String(def?.dataverseType ?? def?.columnMetadata?.type ?? "").toLowerCase();
  return type === "file" || type === "image" ? type : null;
};
const fileColumn = (mapping, column) => {
  const kind = kindOf(mapping?.fields?.[column]);
  return kind ? { column, kind, def: mapping.fields[column] } : null;
};
const imageColumns = (mapping) => Object.entries(mapping.fields ?? {}).filter(([, def]) => kindOf(def) === "image");
// unverified: the primary image column is named entityimage
const isPrimary = (column, def) => def?.isPrimary === true || column === "entityimage";
const maxBytes = (kind, def) => Number(def?.MaxSizeInKB ?? def?.columnMetadata?.MaxSizeInKB ?? DEFAULT_MAX_KB[kind]) * 1024;

function assertSize(kind, limit, size) {
  if (size <= limit) return;
  if (kind === "image") {
    throw invalid(`Error occured when processing image. Reason: File size is too big. MaxSize: ${mb(limit)} MB, Uploaded filesize: ${mb(size)} MB.`, IMAGE_INNER);
  }
  throw invalid("Attachment file size is too big.", FILE_SIZE_INNER);
}

function sniffImage(bytes) {
  return MAGIC.find(([, signature]) => signature.every((byte, i) => bytes[i] === byte))?.[0] ?? null;
}

// Validates bytes for one column and returns the file entry; the caller places it on a row.
function prepared({ logical, id = null, column, kind, def, name, bytes, mimeType }) {
  assertSize(kind, maxBytes(kind, def), bytes.length);
  const detected = kind === "image" ? sniffImage(bytes) : null;
  if (kind === "image" && !detected) throw imageFailure(logical, id, column);
  return {
    entity: logical,
    recordId: id,
    column,
    name: name || column,
    mimeType: detected ?? mimeOfName(name) ?? mimeType ?? "application/octet-stream",
    size: bytes.length,
    data: bytes.toString("base64"),
    createdOn: nowIso(),
  };
}

const filesOf = (store) => (store.state.dataverse ??= {}).files ??= {};
const filesRead = (store) => store.state.dataverse?.files ?? {};

function recordOf(store, mapping, id) {
  const row = store.tableRows(mapping.logicalName).find((r) => sameGuid(r[mapping.idColumn], id));
  if (!row) throw missing(`${mapping.logicalName} With Id = ${id} Does Not Exist`);
  return row;
}

function targetOf(store, target) {
  const type = String(target?.["@odata.type"] ?? "").replace(/^#?Microsoft\.Dynamics\.CRM\./, "");
  if (!type && (typeof target === "string" || typeof target?.["@odata.id"] === "string")) {
    const path = (typeof target === "string" ? target : target["@odata.id"]).replace(/^https?:\/\/[^/]+/i, "").replace(/^\/?api\/data\/v\d+\.\d+\//i, "").replace(/^\//, "");
    const match = /^([A-Za-z_]\w*)\(([0-9a-f-]{36})\)$/i.exec(path);
    if (!match || !guidKey(match[2])) throw invalid("Target must identify a record by its primary key.");
    return { mapping: store.resolveMapping(match[1]), id: match[2] };
  }
  if (!type) throw invalid("Target must be an entity reference with @odata.type.");
  const mapping = store.resolveMapping(type);
  const id = target[mapping.idColumn];
  if (guidKey(id) == null) throw invalid(`Target ${mapping.logicalName} must carry ${mapping.idColumn}.`);
  return { mapping, id };
}

// unverified: ctx.body arrives as the parsed JSON object (text when the router does not parse it)
function bodyOf(c) {
  if (typeof c.body !== "string") return c.body ?? {};
  try {
    return JSON.parse(c.body);
  } catch {
    throw invalid("Request body is not valid JSON.");
  }
}

function mappingOfSet(store, set) {
  try {
    return store.resolveMapping(set);
  } catch {
    return null;
  }
}

// Releases the file currently on a column. Caller holds the store transaction.
function release(store, row, column, kind) {
  const files = filesOf(store);
  if (row[column] && files[row[column]]) delete files[row[column]];
  row[column] = null;
  if (kind === "file") row[`${column}_name`] = null;
}

// Puts a new file on a row, releasing the one it replaces. Returns the new file id.
function place(store, row, column, kind, entry) {
  release(store, row, column, kind);
  const fileId = randomUUID();
  filesOf(store)[fileId] = entry;
  row[column] = fileId;
  if (kind === "file") row[`${column}_name`] = entry.name;
  return fileId;
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
  // Upload and download sessions keyed by continuation token (in memory, see header comment).
  const sessions = new Map();
  const sasInline = new Map();
  sasInlineByApi.set(api, sasInline);
  const sasSecret = randomBytes(32);
  const clock = () => api.clock?.() ?? Date.now();
  const sasSignature = (key, expiry, permission) => createHmac("sha256", sasSecret).update(`${key}\n${expiry}\n${permission}`).digest("base64url");
  const sasUrl = (c, key, permission) => {
    const expiry = new Date(clock() + 3600_000).toISOString();
    return `${c.origin}/_sas/files/${encodeURIComponent(key)}?${new URLSearchParams({ se: expiry, sp: permission, sig: sasSignature(key, expiry, permission) })}`;
  };
  sessionsByApi.set(api, sessions);
  const purge = () => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of sessions) if (session.createdAt < cutoff) sessions.delete(token);
    for (const [key, entry] of sasInline) if (entry.expiresAt <= clock()) sasInline.delete(key);
  };
  const openSession = (token, session) => {
    purge();
    sessions.set(token, { ...session, createdAt: Date.now() });
  };
  const liveSession = (token) => {
    purge();
    return sessions.get(token);
  };
  const write = (fn) => change(() => store.transact(fn));
  const authorize = (c, mapping, operation, row) =>
    principals.authorize({ user: c.user, entity: mapping.logicalName, operation, row, mapping });
  const sessionOf = (token, mode) => {
    const session = liveSession(String(token ?? ""));
    if (session?.mode !== mode) throw invalid("The file continuation token is not valid.");
    return session;
  };
  const fileName = (c) => {
    const name = header(c, "x-ms-file-name") ?? c.url.searchParams.get("x-ms-file-name");
    if (!name) throw invalid("x-ms-file-name is required.");
    return name;
  };
  const reply = (c, name, fields) => ({
    status: 200,
    body: { "@odata.context": contextUrl(c.origin, c.version, `${CRM}${name}Response`), ...fields },
  });

  async function stream(c) {
    const route = c.route;
    if (route?.kind !== "property" && route?.kind !== "value") return undefined;
    const mapping = mappingOfSet(store, route.set);
    const found = mapping && fileColumn(mapping, route.segment);
    const id = found ? parseKey(route.key)?.id : undefined;
    if (!found || !id) return undefined;
    if (route.kind === "value") return c.method === "GET" ? download(c, { mapping, id, ...found }) : undefined;
    if (c.method === "PATCH") return upload(c, { mapping, id, ...found });
    if (c.method === "DELETE") return clear(c, { mapping, id, ...found });
    return undefined;
  }

  async function upload(c, { mapping, id, column, kind, def }) {
    authorize(c, mapping, "update", recordOf(store, mapping, id));
    const token = c.url.searchParams.get("sessiontoken");
    if (token) return chunk(c, { mapping, id, column, kind, def, token });
    const name = fileName(c);
    if (String(header(c, "x-ms-transfer-mode") ?? "").toLowerCase() === "chunked") {
      const continuation = randomUUID();
      openSession(continuation, { mode: "range", entity: mapping.logicalName, id, column, kind, def, name, received: 0, total: null, chunks: [] });
      const location = `${c.origin}/api/data/${c.version}/${c.route.set}(${c.route.key})/${column}?sessiontoken=${continuation}`;
      return {
        status: 200,
        headers: { "Accept-Ranges": "bytes", Location: location, "x-ms-chunk-size": String(CHUNK_SIZE), "Access-Control-Expose-Headers": "x-ms-chunk-size" },
      };
    }
    const bytes = Buffer.from(c.bodyBuffer ?? []);
    await write(() => {
      const entry = prepared({ logical: mapping.logicalName, id, column, kind, def, name, bytes, mimeType: mimeOf(c) });
      place(store, recordOf(store, mapping, id), column, kind, entry);
    });
    return { status: 204 };
  }

  async function chunk(c, { mapping, id, column, kind, def, token }) {
    const session = liveSession(token);
    if (session?.mode !== "range" || session.entity !== mapping.logicalName || session.column !== column || !sameGuid(session.id, id)) {
      throw invalid("The file upload session is not valid.");
    }
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(header(c, "content-range") ?? "").trim());
    if (!match) throw invalid("Content-Range must be bytes start-end/size.");
    const [start, end, total] = match.slice(1).map(Number);
    const bytes = Buffer.from(c.bodyBuffer ?? []);
    if (start !== session.received || end < start || end >= total || bytes.length !== end - start + 1) {
      throw invalid("Content-Range does not continue the upload."); // unverified: error wording
    }
    if (session.total === null) {
      assertSize(kind, maxBytes(kind, def), total);
      session.total = total;
    } else if (session.total !== total) {
      throw invalid("Content-Range size changed during the upload.");
    }
    session.chunks.push(bytes);
    session.received = end + 1;
    if (session.received < total) return { status: 206, headers: { "OData-Version": "4.0" } };
    sessions.delete(token);
    const data = Buffer.concat(session.chunks);
    await write(() => {
      const entry = prepared({ logical: mapping.logicalName, id, column, kind, def, name: session.name, bytes: data, mimeType: mimeOf(c) });
      place(store, recordOf(store, mapping, id), column, kind, entry);
    });
    return { status: 204, headers: { "OData-Version": "4.0" } };
  }

  function download(c, { mapping, id, column, kind, def }) {
    const row = recordOf(store, mapping, id);
    authorize(c, mapping, "read", row);
    const entry = row[column] ? filesRead(store)[row[column]] : null;
    // Native answers the download route's own errors (404 and 416 observed) as plain application/json, not the OData minimal type.
    const plain = (error) => Object.assign(error, { details: { ...error.details, contentType: "application/json" } });
    // A file column answers an empty value with 404 (native); an image column answers 204.
    if (!entry) {
      if (kind === "file") throw plain(missing(`No file attachment found for attribute: ${column} EntityId: ${id}.`));
      return { status: 204 };
    }
    // unverified: canStoreFullImage defaults to false, as the metadata does, so size=full answers 204 unless the column stores full images.
    if (kind === "image" && c.url.searchParams.get("size") === "full" && def?.canStoreFullImage !== true) return { status: 204 };
    const bytes = Buffer.from(entry.data, "base64");
    // unverified: the disposition is inline with the bare name; native's quoting for names with spaces is not observed.
    const base = {
      "x-ms-file-size": String(bytes.length), "x-ms-file-name": entry.name, mimetype: entry.mimeType,
      "Content-Disposition": `inline; filename=${entry.name}`, "Access-Control-Expose-Headers": EXPOSE,
    };
    const range = header(c, "range");
    // observed: parity case image.thumbnail; an image without size=full answers the thumbnail with no file headers at all.
    const thumbnail = kind === "image" && c.url.searchParams.get("size") !== "full";
    if (range === undefined) return { status: 200, headers: thumbnail ? {} : base, body: bytes };
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(range).trim());
    if (!match) throw plain(invalid("The Range header must be bytes=start-end."));
    const start = Number(match[1]);
    // A start past the end (or an end before the start) is native's 416 with the chunk-range code, not the generic range error.
    const unsatisfiable = () => plain(new DataError(
      "Chunk range used in this call is either not valid or it is bigger than allowed 4 MB.", 416, "InvalidRange", { innerCode: RANGE_INNER },
    ));
    if (start >= bytes.length) throw unsatisfiable();
    const end = match[2] === "" ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    if (end < start) throw unsatisfiable();
    return {
      status: 206,
      headers: {
        ...base, "Access-Control-Expose-Headers": EXPOSE_RANGE, "x-ms-chunk-size": String(CHUNK_SIZE), "OData-Version": "4.0",
        "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
      },
      body: bytes.subarray(start, end + 1),
    };
  }

  async function clear(c, { mapping, id, column, kind }) {
    authorize(c, mapping, "update", recordOf(store, mapping, id));
    await write(() => release(store, recordOf(store, mapping, id), column, kind));
    return { status: 204 };
  }

  function beforeWrite(c, mapping, { operation, data, existing }) {
    if (operation !== "create" && operation !== "update") return;
    const files = filesOf(store);
    for (const [column, def] of imageColumns(mapping)) {
      if (!data || !Object.hasOwn(data, column)) continue;
      const value = data[column];
      if (operation === "create" && value != null && !isPrimary(column, def)) {
        throw invalid(`Non-primary image attribute ${column} of entity ${mapping.logicalName} is not allowed to upload during Create operation.`, NON_PRIMARY_INNER);
      }
      // The replaced or cleared image is released in afterWrite, once the row write has landed.
      if (value == null) {
        data[column] = null;
        continue;
      }
      const id = existing?.[mapping.idColumn] ?? data[mapping.idColumn] ?? null;
      // Record writes answer a malformed base64 value with the payload-converter error, quoting the literal (stack trace omitted).
      if (typeof value !== "string" || !BASE64.test(value)) {
        throw new DataError(
          "Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: Cannot convert the literal '"
            + String(value) + "' to the expected type 'Edm.Binary'. ---> System.FormatException: The input is not a valid Base-64 string as it contains a non-base 64 character, more than two padding characters, or an illegal character among the padding characters.",
          400,
          "InvalidRequest",
          { innerCode: BASE64_INNER },
        );
      }
      const bytes = Buffer.from(value, "base64");
      // unverified: a record write with bytes that are not a supported image answers "Invalid argument." (0x80040203), not the $value wording.
      if (!sniffImage(bytes)) throw invalid("Invalid argument.");
      const entry = prepared({ logical: mapping.logicalName, id, column, kind: "image", def, name: column, bytes });
      const fileId = randomUUID();
      files[fileId] = entry;
      data[column] = fileId;
    }
  }

  // Runs after a create or update has committed. A create stored its images before the record had an id, so the
  // id is filled in here; then every image this write replaced or cleared is released.
  // ponytail: the release scans all stored files per image-bearing write; index by record if that gets slow.
  function afterWrite(_c, mapping, { operation, id }) {
    if (operation !== "create" && operation !== "update") return;
    const columns = imageColumns(mapping).map(([column]) => column);
    if (!columns.length) return;
    const row = store.tableRows(mapping.logicalName).find((r) => sameGuid(r[mapping.idColumn], id));
    if (!row) return;
    const files = filesOf(store);
    for (const column of columns) {
      if (row[column] && files[row[column]]) files[row[column]].recordId = id;
    }
    for (const [fileId, entry] of Object.entries(files)) {
      const replaced = entry.entity === mapping.logicalName && columns.includes(entry.column)
        && sameGuid(entry.recordId, id) && row[entry.column] !== fileId;
      if (replaced) delete files[fileId];
    }
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
      if (!row || typeof row !== "object") continue;
      const key = guidKey(row[mapping.idColumn]);
      const raw = key ? stored.get(key) : undefined;
      for (const [column] of images) {
        if (!Object.hasOwn(row, column)) continue;
        const fileId = raw?.[column] ?? null;
        const entry = fileId ? files[fileId] : null;
        const stamp = entry ? Date.parse(entry.createdOn) : null; // unverified: _timestamp format
        row[column] = entry ? entry.data : null;
        row[`${column}id`] = fileId;
        row[`${column}_timestamp`] = stamp;
        row[`${column}_url`] = entry
          ? `/Image/download.aspx?Entity=${mapping.logicalName}&Attribute=${column}&Id=${fileId}&Timestamp=${stamp}`
          : null;
      }
    }
  }

  // Annotation and attachment block messages. The limit is organization.maxuploadfilesize (platform-settings default 5242880).
  // unverified: the limit is applied to raw bytes; the setting's own text says base64-encoded.
  const uploadLimit = () => Number((store.state.tables.organization ?? [])[0]?.maxuploadfilesize ?? 5242880);
  // Learn: Initialize*BlocksUpload takes Target and answers a continuation token. Upload is create-only, so the
  // session names the table being created and the Target the new row regards. unverified: Target semantics.
  function initBlocksUpload(c, logical, name) {
    const input = bodyOf(c);
    const { mapping, id } = targetOf(store, input.Target);
    principals.authorize({ user: c.user, entity: logical, operation: "create" });
    const token = randomUUID();
    openSession(token, {
      mode: "blocks", entity: mapping.logicalName, id, role: logical, kind: "file", def: { MaxSizeInKB: Math.floor(uploadLimit() / 1024) },
      name: null, blockLength: null, bytes: 0, blocks: new Map(),
    });
    return reply(c, name, { FileContinuationToken: token });
  }

  // Commit creates one row (annotation or activitymimeattachment) regarding the session's Target, with the joined bytes as base64
  // text. unverified: the row's filename, mimetype and objectid/activityid mapping; the commit's Target argument is not read.
  async function commitRowBlocks(c, logical, name) {
    const input = bodyOf(c);
    const token = String(input.FileContinuationToken ?? "");
    const session = sessionOf(token, "blocks");
    if (session.role !== logical) throw invalid("The file upload session is not valid.");
    const list = Array.isArray(input.BlockList) ? input.BlockList : [];
    const parts = list.map((blockId) => session.blocks.get(String(blockId)));
    if (!list.length || parts.some((part) => part === undefined)) throw invalid("BlockList names a block that was not uploaded.");
    principals.authorize({ user: c.user, entity: logical, operation: "create" });
    const bytes = Buffer.concat(parts);
    assertSize("file", uploadLimit(), bytes.length);
    const id = randomUUID();
    const row = { filesize: bytes.length, filename: input.FileName ?? null, mimetype: null, createdon: nowIso() };
    if (logical === "annotation") {
      Object.assign(row, { annotationid: id, objectid: session.id, objecttypecode: session.entity, documentbody: bytes.toString("base64"), isdocument: true });
    } else {
      Object.assign(row, { activitymimeattachmentid: id, objectid: session.id, objecttypecode: session.entity, activityid: session.id, body: bytes.toString("base64") });
    }
    await write(() => {
      (store.state.tables[logical] ??= []).push(row);
    });
    sessions.delete(token);
    const answer = logical === "annotation" ? { AnnotationId: id } : { ActivityMimeAttachmentId: id };
    return reply(c, name, { ...answer, FileSizeInBytes: bytes.length });
  }

  // Learn: Initialize*BlocksDownload takes Target (the annotation or activitymimeattachment row) and answers the same shape as
  // InitializeFileBlocksDownload. unverified: the answer shape and error wording for a row with no bytes.
  function initBlocksDownload(c, logical, column, name) {
    const input = bodyOf(c);
    const { mapping, id } = targetOf(store, input.Target);
    if (mapping.logicalName !== logical) throw invalid(`Target must be a ${logical} row.`);
    const row = recordOf(store, mapping, id);
    authorize(c, mapping, "read", row);
    if (row[column] == null) throw missing(`No file found for ${logical} ${id}.`);
    const token = randomUUID();
    openSession(token, { mode: "download", fileId: null, data: row[column], entity: logical, id });
    return reply(c, name, {
      FileSizeInBytes: Buffer.from(String(row[column]), "base64").length, FileName: row.filename ?? "", FileContinuationToken: token, IsChunkingSupported: true,
    });
  }

  const actions = {
    async InitializeTemporaryFileBlocksUpload(c) {
      const input = bodyOf(c), size = Number(input.FileSize), name = String(input.FileName ?? "");
      if (!name || !Number.isInteger(size) || size <= 0) throw invalid("FileName and a positive FileSize are required.");
      assertSize("file", maxBytes("file", {}), size);
      const token = randomUUID(), recordId = randomUUID();
      openSession(token, { mode: "blocks", entity: null, id: recordId, column: null, kind: "file", def: {}, name, expectedSize: size, creator: c.user?.systemuserid, blockLength: null, bytes: 0, blocks: new Map() });
      return reply(c, "InitializeTemporaryFileBlocksUpload", { FileContinuationToken: token, RecordId: recordId });
    },
    async InitializeAnnotationBlocksUpload(c) {
      return initBlocksUpload(c, "annotation", "InitializeAnnotationBlocksUpload");
    },

    async InitializeAttachmentBlocksUpload(c) {
      return initBlocksUpload(c, "activitymimeattachment", "InitializeAttachmentBlocksUpload");
    },

    async CommitAnnotationBlocksUpload(c) {
      return commitRowBlocks(c, "annotation", "CommitAnnotationBlocksUpload");
    },

    async CommitAttachmentBlocksUpload(c) {
      return commitRowBlocks(c, "activitymimeattachment", "CommitAttachmentBlocksUpload");
    },

    async InitializeAnnotationBlocksDownload(c) {
      return initBlocksDownload(c, "annotation", "documentbody", "InitializeAnnotationBlocksDownload");
    },

    async InitializeAttachmentBlocksDownload(c) {
      return initBlocksDownload(c, "activitymimeattachment", "body", "InitializeAttachmentBlocksDownload");
    },

    async InitializeFileBlocksUpload(c) {
      const input = bodyOf(c);
      const { mapping, id } = targetOf(store, input.Target);
      const found = fileColumn(mapping, input.FileAttributeName);
      if (!found) throw invalid(`${input.FileAttributeName} is not a file or image column of ${mapping.logicalName}.`);
      const name = String(input.FileName ?? "");
      if (!name) throw invalid("FileName is required.");
      authorize(c, mapping, "update", recordOf(store, mapping, id));
      const token = randomUUID();
      openSession(token, { mode: "blocks", entity: mapping.logicalName, id, ...found, name, blockLength: null, bytes: 0, blocks: new Map() });
      return reply(c, "InitializeFileBlocksUpload", { FileContinuationToken: token });
    },

    async UploadBlock(c) {
      const input = bodyOf(c);
      const session = sessionOf(input.FileContinuationToken, "blocks");
      const blockId = Buffer.from(String(input.BlockId ?? ""), "base64");
      const block = Buffer.from(String(input.BlockData ?? ""), "base64");
      if (blockId.length === 0 || blockId.length > BLOCK_ID_LIMIT || (session.blockLength !== null && blockId.length !== session.blockLength)) {
        throw invalid("BlockId must be base64 of up to 64 bytes, the same length for every block of a file.");
      }
      if (block.length > BLOCK_LIMIT) throw invalid("BlockData is larger than one block.");
      // Blocks count against MaxSizeInKB as they arrive; a re-sent BlockId replaces its earlier bytes.
      const replaced = session.blocks.get(String(input.BlockId))?.length ?? 0;
      assertSize(session.kind, maxBytes(session.kind, session.def), session.bytes - replaced + block.length);
      session.bytes += block.length - replaced;
      session.blockLength ??= blockId.length;
      session.blocks.set(String(input.BlockId), block);
      return { status: 204 };
    },

    async CommitFileBlocksUpload(c) {
      const input = bodyOf(c);
      const token = String(input.FileContinuationToken ?? "");
      const session = sessionOf(token, "blocks");
      const list = Array.isArray(input.BlockList) ? input.BlockList : [];
      const parts = list.map((blockId) => session.blocks.get(String(blockId)));
      if (!list.length || parts.some((part) => part === undefined)) throw invalid("BlockList names a block that was not uploaded.");
      const mapping = session.entity ? store.resolveMapping(session.entity) : null;
      if (mapping) authorize(c, mapping, "update", recordOf(store, mapping, session.id));
      else if (session.creator !== c.user?.systemuserid) throw invalid("The file continuation token is not valid.");
      const bytes = Buffer.concat(parts);
      if (session.expectedSize != null && bytes.length !== session.expectedSize) throw invalid("The uploaded size does not match FileSize.");
      let fileId;
      await write(() => {
        const entry = prepared({
          logical: session.entity, id: session.id, column: session.column, kind: session.kind, def: session.def,
          name: input.FileName || session.name, bytes, mimeType: input.MimeType,
        });
        if (mapping) fileId = place(store, recordOf(store, mapping, session.id), session.column, session.kind, entry);
        else { fileId = randomUUID(); filesOf(store)[fileId] = { ...entry, creator: session.creator }; }
      });
      sessions.delete(token);
      return reply(c, "CommitFileBlocksUpload", { FileId: fileId, FileSizeInBytes: bytes.length });
    },

    async InitializeFileBlocksDownload(c) {
      const input = bodyOf(c);
      const { mapping, id } = targetOf(store, input.Target);
      const found = fileColumn(mapping, input.FileAttributeName);
      if (!found) throw invalid(`${input.FileAttributeName} is not a file or image column of ${mapping.logicalName}.`);
      const row = recordOf(store, mapping, id);
      authorize(c, mapping, "read", row);
      const entry = row[found.column] ? filesRead(store)[row[found.column]] : null;
      if (!entry) throw missing(`No file found for ${found.column} of ${mapping.logicalName} record ${id}.`); // unverified: error wording
      const token = randomUUID();
      openSession(token, { mode: "download", fileId: row[found.column], entity: mapping.logicalName, id });
      return reply(c, "InitializeFileBlocksDownload", {
        FileSizeInBytes: entry.size, FileName: entry.name, FileContinuationToken: token, IsChunkingSupported: true,
      });
    },

    async DownloadBlock(c) {
      const input = bodyOf(c);
      const session = sessionOf(input.FileContinuationToken, "download");
      // An annotation or attachment download carries its base64 bytes in the session (see initBlocksDownload).
      const entry = session.data != null ? { data: session.data } : filesRead(store)[session.fileId];
      if (!entry) throw missing(`File ${session.fileId} does not exist.`);
      const mapping = store.resolveMapping(session.entity);
      authorize(c, mapping, "read", recordOf(store, mapping, session.id));
      const offset = Number(input.Offset ?? 0);
      const length = Number(input.BlockLength ?? 0);
      if (!Number.isInteger(offset) || !Number.isInteger(length) || length <= 0) {
        throw invalid("Offset must be a whole number and BlockLength one or more.");
      }
      // unverified: a negative Offset answers the whole file and ignores BlockLength (native: Offset -1, BlockLength 16 returned all 23 bytes).
      const data = Buffer.from(entry.data, "base64");
      const block = offset < 0 ? data : data.subarray(offset, offset + length);
      return reply(c, "DownloadBlock", { Data: block.toString("base64") });
    },

    async DeleteFile(c) {
      const input = bodyOf(c);
      const key = guidKey(input.FileId);
      const entry = key && Object.hasOwn(filesRead(store), key) ? filesRead(store)[key] : null;
      if (!entry) throw missing(`File ${input.FileId} does not exist.`);
      if (entry.entity == null) {
        if (entry.creator !== c.user?.systemuserid) throw missing(`File ${input.FileId} does not exist.`);
        await write(() => { delete filesOf(store)[key]; });
        return { status: 204 };
      }
      const mapping = store.resolveMapping(entry.entity);
      authorize(c, mapping, "update", recordOf(store, mapping, entry.recordId));
      const found = fileColumn(mapping, entry.column);
      await write(() => {
        const row = recordOf(store, mapping, entry.recordId);
        if (guidKey(row[entry.column]) === key) release(store, row, entry.column, found?.kind);
        delete filesOf(store)[key];
      });
      return { status: 204 };
    },
  };

  // The records layer hands the stream hook no raw body, so a binary PATCH to a file column stored nothing, and it refuses
  // size= on $value before any hook runs. The extension route sees the raw body and the query; other verbs fall through.
  api.addRoute(
    (pathname) => {
      const route = parseDataverseRoute(pathname);
      if (route?.kind !== "property" && route?.kind !== "value") return false;
      const mapping = mappingOfSet(store, route.set);
      return Boolean(mapping && fileColumn(mapping, route.segment));
    },
    async (c) => (await stream(c)) ?? api.records.handle(c),
  );
  recordHooks.add("stream", stream);
  recordHooks.add("beforeWrite", beforeWrite);
  recordHooks.add("afterWrite", afterWrite);
  recordHooks.add("project", project);
  for (const [name, handle] of Object.entries(actions)) {
    registry.register({ name, kind: "action", binding: "unbound", handle, csdl: CSDL[name], ...(name === "InitializeTemporaryFileBlocksUpload" ? { signature: { params: [["FileSize", "Edm.Int32"], ["FileName", "Edm.String"]], response: [["FileContinuationToken", "Edm.String"], ["RecordId", "Edm.Guid"]] } } : {}) });
  }

  // Learn: download-a-file-or-an-image - the returned URL permits anonymous download for one hour. It grants access
  // only to the signed file id; the API request that mints it still authorizes the table and record.
  registry.register({ name: "GetFileSasUrl", kind: "function", binding: "unbound", csdl: `<ComplexType Name="FileSasUrlResponse"><Property Name="FileName" Type="Edm.String" /><Property Name="FileSizeInBytes" Type="Edm.Int64" /><Property Name="MimeType" Type="Edm.String" /><Property Name="SasUrl" Type="Edm.String" /></ComplexType><ComplexType Name="GetFileSasUrlResponse"><Property Name="Result" Type="mscrm.FileSasUrlResponse" /></ComplexType><Function Name="GetFileSasUrl"><Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" /><Parameter Name="FileAttributeName" Type="Edm.String" Nullable="false" /><Parameter Name="DataSource" Type="Edm.String" /><ReturnType Type="mscrm.GetFileSasUrlResponse" Nullable="false" /></Function>`, handle: (c) => {
    const input = { ...bodyOf(c), ...(c.params ?? {}) }, { mapping, id } = targetOf(store, input.Target);
    const source = String(input.DataSource ?? "default").toLowerCase();
    if (!["default", "bin", "retained"].includes(source)) throw invalid("DataSource must be default, bin or retained.");
    const row = source === "default" ? recordOf(store, mapping, id) : (store.datasourceRows?.(source, mapping.logicalName, c.identity) ?? []).find((row) => sameGuid(row[mapping.idColumn], id));
    if (!row) throw missing(`${mapping.logicalName} With Id = ${id} Does Not Exist`);
    authorize(c, mapping, "read", row);
    let key, entry;
    if (["annotation", "activitymimeattachment"].includes(mapping.logicalName)) {
      if (input.FileAttributeName !== "") throw invalid("FileAttributeName must be empty for notes and attachments.");
      key = `inline:${randomUUID()}`;
      const bytes = row[mapping.logicalName === "annotation" ? "documentbody" : "body"];
      if (bytes == null) throw missing("No file attachment found.");
      entry = { name: row.filename ?? "", mimeType: row.mimetype ?? "application/octet-stream", data: bytes, size: Buffer.from(String(bytes), "base64").length };
      purge(); sasInline.set(key, { ...entry, expiresAt: clock() + 3600_000 });
    } else {
      const found = fileColumn(mapping, input.FileAttributeName);
      if (!found) throw invalid("FileAttributeName is not a file or image column.");
      if (found.kind === "image" && found.def?.canStoreFullImage !== true) throw invalid("GetFileSasUrl only works for image columns that store full images.");
      key = row[found.column]; entry = filesRead(store)[key];
      if (!entry) throw missing("No file attachment found.");
    }
    return reply(c, "GetFileSasUrl", { Result: { FileName: entry.name, FileSizeInBytes: entry.size, MimeType: entry.mimeType, SasUrl: sasUrl(c, key, "r") } });
  } });
  // Native CSDL declares Result: InitializeUploadUsingSasResponse. The local upload URL streams one block; callers
  // finish with CommitFileBlocksUpload. The storage-provider details of the hosted service remain unverified.
  registry.register({ name: "GetFileSasUrlForUpload", kind: "function", binding: "unbound", csdl: `<ComplexType Name="InitializeUploadUsingSasResponse"><Property Name="SasUrl" Type="Edm.String" /><Property Name="FileContinuationToken" Type="Edm.String" /></ComplexType><ComplexType Name="GetFileSasUrlForUploadResponse"><Property Name="Result" Type="mscrm.InitializeUploadUsingSasResponse" /></ComplexType><Function Name="GetFileSasUrlForUpload"><Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" /><Parameter Name="FileAttributeName" Type="Edm.String" Nullable="false" /><Parameter Name="FileName" Type="Edm.String" Nullable="false" /><ReturnType Type="mscrm.GetFileSasUrlForUploadResponse" Nullable="false" /></Function>`, handle: async (c) => {
    const result = await actions.InitializeFileBlocksUpload({ ...c, body: { ...bodyOf(c), ...(c.params ?? {}) } });
    const token = result.body.FileContinuationToken;
    return reply(c, "GetFileSasUrlForUpload", { Result: { SasUrl: sasUrl(c, `upload:${token}`, "w"), FileContinuationToken: token } });
  } });
  api.addRoute((pathname) => pathname.startsWith("/_sas/files/"), async (c) => {
    const url = c.url, expiry = url.searchParams.get("se"), permission = url.searchParams.get("sp"), signature = url.searchParams.get("sig") ?? "";
    let key;
    try { key = decodeURIComponent(url.pathname.slice("/_sas/files/".length)); } catch { key = ""; }
    const expected = sasSignature(key, expiry, permission), bytes = Buffer.from(signature);
    const failure = () => ({ status: 403, body: { error: { code: "AuthenticationFailed", message: "Signature not valid or expired." } } });
    if (!expiry || !Number.isFinite(Date.parse(expiry)) || clock() >= Date.parse(expiry) || bytes.length !== Buffer.byteLength(expected) || !timingSafeEqual(bytes, Buffer.from(expected))) return failure();
    if (permission === "w" && c.method === "PUT" && key.startsWith("upload:")) {
      const session = sessionOf(key.slice(7), "blocks"), chunks = [];
      let received = 0;
      // Anonymous routes run before the authenticated body's reader. Verify the capability first, then enforce
      // the same column size limit while streaming; a large request never materializes an unbounded buffer.
      for await (const chunk of c.bodyBuffer != null ? [c.bodyBuffer] : c.req ?? []) {
        const bytes = Buffer.from(chunk); received += bytes.length;
        assertSize(session.kind, maxBytes(session.kind, session.def), received);
        chunks.push(bytes);
      }
      const block = Buffer.concat(chunks);
      assertSize(session.kind, maxBytes(session.kind, session.def), block.length);
      session.blocks.clear(); session.blocks.set(Buffer.from("sas").toString("base64"), block); session.bytes = block.length; session.blockLength = 3;
      return { status: 201 };
    }
    if (permission !== "r" || c.method !== "GET" || key.startsWith("upload:")) return failure();
    purge();
    const entry = filesRead(store)[key] ?? sasInline.get(key);
    if (entry?.data == null) return { status: 404, body: { error: { code: "NotFound", message: "File not found." } } };
    return { status: 200, body: Buffer.from(entry.data, "base64"), headers: { "Content-Type": entry.mimeType ?? "application/octet-stream", "Content-Disposition": `attachment; filename="${String(entry.name ?? "download").replace(/[\r\n"\\]/g, "_")}"` } };
  }, { anonymous: true });
}
