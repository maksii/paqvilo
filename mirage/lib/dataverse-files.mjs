// Simulated Dataverse file and image columns: single and chunked uploads, ranged
// downloads, the block messages, and image value rules on record writes.
// Upload sessions live in memory, so a restart drops in-flight uploads.
// ponytail: file bytes sit in state JSON as base64; move them to a side file under .paqvilo/ if state size matters.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { contextUrl, parseKey } from "./dataverse-odata.mjs";
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
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAGIC = [
  ["image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
  ["image/gif", [0x47, 0x49, 0x46, 0x38]],
  ["image/bmp", [0x42, 0x4d]],
];
const EXPOSE = "x-ms-file-size; x-ms-file-name; mimetype";
const EXPOSE_RANGE = "x-ms-file-size; x-ms-file-name; x-ms-chunk-size; mimetype";
// ponytail: the 15-minute session TTL is a guess [unverified]; expired sessions are dropped on the next session start or lookup.
const SESSION_TTL_MS = 15 * 60 * 1000;
// CSDL for the six actions, so $metadata lists their parameters and response types (Web API action reference).
const CSDL = {
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
    mimeType: detected ?? mimeType ?? "application/octet-stream",
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

export function install(api) {
  const { store, change, principals, recordHooks, registry } = api;
  // Upload and download sessions keyed by continuation token (in memory, see header comment).
  const sessions = new Map();
  const purge = () => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of sessions) if (session.createdAt < cutoff) sessions.delete(token);
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
    if (!entry) return { status: 204 };
    if (kind === "image" && c.url.searchParams.get("size") === "full" && def?.canStoreFullImage === false) return { status: 204 };
    const bytes = Buffer.from(entry.data, "base64");
    const base = { "x-ms-file-size": String(bytes.length), "x-ms-file-name": entry.name, mimetype: entry.mimeType, "Access-Control-Expose-Headers": EXPOSE };
    const range = header(c, "range");
    if (range === undefined) return { status: 200, headers: base, body: bytes };
    const match = /^bytes=(\d+)-(\d*)$/.exec(String(range).trim());
    if (!match) throw invalid("The Range header must be bytes=start-end.");
    const start = Number(match[1]);
    if (start >= bytes.length) throw new DataError("The requested range is not satisfiable.", 416, "InvalidRange"); // unverified
    const end = match[2] === "" ? bytes.length - 1 : Math.min(Number(match[2]), bytes.length - 1);
    if (end < start) throw new DataError("The requested range is not satisfiable.", 416, "InvalidRange"); // unverified
    return {
      status: 206,
      headers: { ...base, "Access-Control-Expose-Headers": EXPOSE_RANGE, "x-ms-chunk-size": String(CHUNK_SIZE), "OData-Version": "4.0" },
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
      if (typeof value !== "string" || !BASE64.test(value)) throw imageFailure(mapping.logicalName, id, column);
      const entry = prepared({ logical: mapping.logicalName, id, column, kind: "image", def, name: column, bytes: Buffer.from(value, "base64") });
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

  const actions = {
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
      const mapping = store.resolveMapping(session.entity);
      authorize(c, mapping, "update", recordOf(store, mapping, session.id));
      const bytes = Buffer.concat(parts);
      let fileId;
      await write(() => {
        const entry = prepared({
          logical: session.entity, id: session.id, column: session.column, kind: session.kind, def: session.def,
          name: input.FileName || session.name, bytes, mimeType: input.MimeType,
        });
        fileId = place(store, recordOf(store, mapping, session.id), session.column, session.kind, entry);
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
      const entry = filesRead(store)[session.fileId];
      if (!entry) throw missing(`File ${session.fileId} does not exist.`);
      const mapping = store.resolveMapping(session.entity);
      authorize(c, mapping, "read", recordOf(store, mapping, session.id));
      const offset = Number(input.Offset ?? 0);
      const length = Number(input.BlockLength ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) {
        throw invalid("Offset must be zero or more and BlockLength one or more.");
      }
      const block = Buffer.from(entry.data, "base64").subarray(offset, offset + length);
      return reply(c, "DownloadBlock", { Data: block.toString("base64") });
    },

    async DeleteFile(c) {
      const input = bodyOf(c);
      const key = guidKey(input.FileId);
      const entry = key && Object.hasOwn(filesRead(store), key) ? filesRead(store)[key] : null;
      if (!entry) throw missing(`File ${input.FileId} does not exist.`);
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

  recordHooks.add("stream", stream);
  recordHooks.add("beforeWrite", beforeWrite);
  recordHooks.add("afterWrite", afterWrite);
  recordHooks.add("project", project);
  for (const [name, handle] of Object.entries(actions)) {
    registry.register({ name, kind: "action", binding: "unbound", handle, csdl: CSDL[name] });
  }
}
