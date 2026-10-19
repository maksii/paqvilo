// Simulated Dataverse file and image columns through the stream hook, the block actions
// and the record hooks. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { DataError } from "../lib/data-error.mjs";
import { install } from "../lib/dataverse-files.mjs";

const ORIGIN = "http://127.0.0.1:5555";
const VERSION = "v9.2";
const DOC = "6f1d7c1e-0000-4000-8000-000000000001";
const USER = { systemuserid: "aaaaaaaa-0000-4000-8000-000000000001" };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const b64 = (text) => Buffer.from(text).toString("base64");

function harness({ denyUpdate = false, denyRead = false } = {}) {
  const state = emptyState();
  state.mappings.document = {
    logicalName: "document", entitySet: "documents", idColumn: "documentid", nameColumn: "name",
    fields: {
      name: { dataverseType: "nvarchar" },
      attachment: { dataverseType: "file", MaxSizeInKB: 64 },
      photo: { dataverseType: "image" },
      sealed: { dataverseType: "image", canStoreFullImage: false },
      entityimage: { dataverseType: "image" },
    },
  };
  state.tables.document = [{ documentid: DOC, name: "Invoice" }];
  const store = new DataStore({ state });
  const operations = [];
  const principals = {
    authorize: ({ operation }) => {
      operations.push(operation);
      if ((operation === "update" && denyUpdate) || (operation === "read" && denyRead)) {
        throw new DataError("Principal is missing the privilege.", 403, "PrivilegeDenied");
      }
    },
  };
  const ops = [];
  const hooks = {};
  install({
    store, principals, change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (name, fn) => { hooks[name] = fn; } },
  });
  const handle = (name) => ops.find((op) => op.name === name).handle;
  const mapping = store.state.mappings.document;
  return { store, hooks, handle, operations, ops, mapping, row: () => store.state.tables.document[0] };
}

function request(method, { set = "documents", segment = "attachment", value = false, search = "", headers = {}, bodyBuffer } = {}) {
  const tail = value ? `/${segment}/$value` : `/${segment}`;
  return {
    method, user: USER, origin: ORIGIN, version: VERSION, headers, bodyBuffer,
    url: new URL(`${ORIGIN}/api/data/${VERSION}/${set}(${DOC})${tail}${search}`),
    route: { kind: value ? "value" : "property", set, key: DOC, segment },
  };
}

function action(body) {
  return { method: "POST", user: USER, origin: ORIGIN, version: VERSION, headers: {}, body, url: new URL(`${ORIGIN}/api/data/${VERSION}/x`) };
}

const target = { "@odata.type": "Microsoft.Dynamics.CRM.document", documentid: DOC };

test("registers the six unbound actions and the stream, beforeWrite and project hooks", () => {
  const h = harness();
  assert.deepEqual(h.ops.map((op) => op.name).sort(), [
    "CommitFileBlocksUpload", "DeleteFile", "DownloadBlock", "InitializeFileBlocksDownload", "InitializeFileBlocksUpload", "UploadBlock",
  ]);
  assert.ok(h.ops.every((op) => op.kind === "action" && op.binding === "unbound"));
  assert.equal(typeof h.hooks.stream, "function");
  assert.equal(typeof h.hooks.beforeWrite, "function");
  assert.equal(typeof h.hooks.project, "function");
});

test("single upload stores the bytes, sets the name companion and downloads them", async () => {
  const h = harness();
  const put = await h.hooks.stream(request("PATCH", { headers: { "content-type": "application/octet-stream", "x-ms-file-name": "report.pdf" }, bodyBuffer: Buffer.from("hello world") }));
  assert.equal(put.status, 204);
  assert.match(h.row().attachment, /^[0-9a-f-]{36}$/);
  assert.equal(h.row().attachment_name, "report.pdf");
  const get = await h.hooks.stream(request("GET", { value: true }));
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), "hello world");
  assert.equal(get.headers["x-ms-file-size"], "11");
  assert.equal(get.headers["x-ms-file-name"], "report.pdf");
  assert.equal(get.headers["Access-Control-Expose-Headers"], "x-ms-file-size; x-ms-file-name; mimetype");
});

test("chunked upload starts with a Location, takes Content-Range chunks and commits on the last one", async () => {
  const h = harness();
  const start = await h.hooks.stream(request("PATCH", { search: "?x-ms-file-name=query.bin", headers: { "x-ms-transfer-mode": "chunked" } }));
  assert.equal(start.status, 200);
  assert.equal(start.headers["x-ms-chunk-size"], "4194304");
  const location = new URL(start.headers.Location);
  assert.equal(location.origin, ORIGIN);
  const token = location.searchParams.get("sessiontoken");
  const chunkSearch = `?sessiontoken=${token}`;
  const first = await h.hooks.stream(request("PATCH", { search: chunkSearch, headers: { "content-range": "bytes 0-3/8" }, bodyBuffer: Buffer.from("abcd") }));
  assert.equal(first.status, 206);
  const last = await h.hooks.stream(request("PATCH", { search: chunkSearch, headers: { "content-range": "bytes 4-7/8" }, bodyBuffer: Buffer.from("efgh") }));
  assert.equal(last.status, 204);
  assert.equal(h.row().attachment_name, "query.bin");
  const get = await h.hooks.stream(request("GET", { value: true }));
  assert.equal(get.body.toString(), "abcdefgh");
});

test("chunks out of order and an unknown session token are rejected", async () => {
  const h = harness();
  const start = await h.hooks.stream(request("PATCH", { search: "?x-ms-file-name=a.bin", headers: { "x-ms-transfer-mode": "chunked" } }));
  const token = new URL(start.headers.Location).searchParams.get("sessiontoken");
  await assert.rejects(
    h.hooks.stream(request("PATCH", { search: `?sessiontoken=${token}`, headers: { "content-range": "bytes 4-7/8" }, bodyBuffer: Buffer.from("efgh") })),
    (error) => error.status === 400 && error.details.innerCode === "0x80040203",
  );
  await assert.rejects(
    h.hooks.stream(request("PATCH", { search: "?sessiontoken=nope", headers: { "content-range": "bytes 0-3/8" }, bodyBuffer: Buffer.from("abcd") })),
    (error) => error.status === 400,
  );
});

test("ranged download returns 206 with the slice and the chunk size", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("0123456789") }));
  const part = await h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=2-4" } }));
  assert.equal(part.status, 206);
  assert.equal(part.body.toString(), "234");
  assert.equal(part.headers["x-ms-chunk-size"], "4194304");
  assert.equal(part.headers["OData-Version"], "4.0");
  const tail = await h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=8-" } }));
  assert.equal(tail.body.toString(), "89");
});

test("block messages upload in BlockList order, download by block, and DeleteFile clears the column", async () => {
  const h = harness();
  const init = await h.handle("InitializeFileBlocksUpload")(action({ Target: target, FileName: "blocks.txt", FileAttributeName: "attachment" }));
  assert.equal(init.status, 200);
  assert.equal(init.body["@odata.context"], `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.InitializeFileBlocksUploadResponse`);
  const token = init.body.FileContinuationToken;
  const id1 = b64("block-0001"), id2 = b64("block-0002");
  assert.equal((await h.handle("UploadBlock")(action({ BlockId: id1, BlockData: b64("first-"), FileContinuationToken: token }))).status, 204);
  assert.equal((await h.handle("UploadBlock")(action({ BlockId: id2, BlockData: b64("second"), FileContinuationToken: token }))).status, 204);
  await assert.rejects(
    h.handle("UploadBlock")(action({ BlockId: b64("short"), BlockData: b64("x"), FileContinuationToken: token })),
    (error) => error.status === 400,
  );
  const commit = await h.handle("CommitFileBlocksUpload")(action({ FileName: "blocks.txt", MimeType: "text/plain", BlockList: [id2, id1], FileContinuationToken: token }));
  assert.equal(commit.body.FileSizeInBytes, 12);
  const fileId = commit.body.FileId;
  assert.equal(h.row().attachment, fileId);
  const get = await h.hooks.stream(request("GET", { value: true }));
  assert.equal(get.body.toString(), "secondfirst-");

  const download = await h.handle("InitializeFileBlocksDownload")(action({ Target: target, FileAttributeName: "attachment" }));
  assert.equal(download.body.FileSizeInBytes, 12);
  assert.equal(download.body.IsChunkingSupported, true);
  const block = await h.handle("DownloadBlock")(action({ Offset: 6, BlockLength: 5, FileContinuationToken: download.body.FileContinuationToken }));
  assert.equal(Buffer.from(block.body.Data, "base64").toString(), "first");

  assert.equal((await h.handle("DeleteFile")(action({ FileId: fileId }))).status, 204);
  assert.equal(h.row().attachment, null);
  assert.equal(h.row().attachment_name, null);
  assert.equal(h.store.state.dataverse.files[fileId], undefined);
});

test("files over MaxSizeInKB fail with the attachment size error", async () => {
  const h = harness();
  const tooBig = Buffer.alloc(64 * 1024 + 1, 1);
  await assert.rejects(
    h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "big.bin" }, bodyBuffer: tooBig })),
    (error) => error.status === 400 && error.details.innerCode === "0x80044a02" && error.message === "Attachment file size is too big.",
  );
  assert.equal(h.row().attachment, undefined);
});

test("images store and return base64, serve full and thumbnail bytes and honour CanStoreFullImage", async () => {
  const h = harness();
  const put = await h.hooks.stream(request("PATCH", { segment: "photo", headers: { "x-ms-file-name": "p.png" }, bodyBuffer: PNG }));
  assert.equal(put.status, 204);
  const full = await h.hooks.stream(request("GET", { segment: "photo", value: true, search: "?size=full" }));
  assert.equal(full.status, 200);
  assert.deepEqual(full.body, PNG);
  assert.equal(full.headers.mimetype, "image/png");

  await h.hooks.stream(request("PATCH", { segment: "sealed", headers: { "x-ms-file-name": "s.png" }, bodyBuffer: PNG }));
  assert.equal((await h.hooks.stream(request("GET", { segment: "sealed", value: true, search: "?size=full" }))).status, 204);
  assert.deepEqual((await h.hooks.stream(request("GET", { segment: "sealed", value: true }))).body, PNG);
});

test("image upload checks the decoded size and the magic bytes", async () => {
  const h = harness();
  await assert.rejects(
    h.hooks.stream(request("PATCH", { segment: "photo", headers: { "x-ms-file-name": "t.txt" }, bodyBuffer: Buffer.from("hello") })),
    (error) => error.status === 400 && error.details.innerCode === "0x80072553",
  );
  const oversize = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);
  await assert.rejects(
    h.hooks.stream(request("PATCH", { segment: "photo", headers: { "x-ms-file-name": "huge.png" }, bodyBuffer: oversize })),
    (error) => error.details.innerCode === "0x80072553"
      && error.message === "Error occured when processing image. Reason: File size is too big. MaxSize: 10 MB, Uploaded filesize: 11 MB.",
  );
});

test("beforeWrite stores base64 image values and rejects a non-primary image on create", () => {
  const h = harness();
  const data = { name: "New", entityimage: PNG.toString("base64") };
  h.hooks.beforeWrite(request("POST"), h.mapping, { operation: "create", data });
  const fileId = data.entityimage;
  assert.match(fileId, /^[0-9a-f-]{36}$/);
  assert.equal(h.store.state.dataverse.files[fileId].mimeType, "image/png");

  assert.throws(
    () => h.hooks.beforeWrite(request("POST"), h.mapping, { operation: "create", data: { photo: PNG.toString("base64") } }),
    (error) => error.status === 400 && error.details.innerCode === "0x80090487"
      && error.message === "Non-primary image attribute photo of entity document is not allowed to upload during Create operation.",
  );
});

test("project returns the image as base64 with its companion columns and leaves file columns as ids", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { segment: "photo", headers: { "x-ms-file-name": "p.png" }, bodyBuffer: PNG }));
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  const formatted = { documentid: DOC, name: "Invoice", photo: "raw", attachment: h.row().attachment };
  h.hooks.project(request("GET"), h.mapping, formatted);
  assert.equal(formatted.photo, PNG.toString("base64"));
  assert.equal(formatted.photoid, h.row().photo);
  assert.match(formatted.photo_url, /^\/Image\/download\.aspx\?Entity=document&Attribute=photo&Id=/);
  assert.equal(formatted.attachment, h.row().attachment);
});

test("upload and delete need update, download needs read", async () => {
  const denied = harness({ denyUpdate: true });
  await assert.rejects(
    denied.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") })),
    (error) => error.status === 403,
  );
  assert.deepEqual(denied.operations, ["update"]);

  const readOnly = harness({ denyRead: true });
  await readOnly.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  await assert.rejects(readOnly.hooks.stream(request("GET", { value: true })), (error) => error.status === 403);
});

test("DELETE on the property clears the column; other columns and routes pass through", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  assert.equal((await h.hooks.stream(request("DELETE"))).status, 204);
  assert.equal(h.row().attachment, null);
  assert.equal(await h.hooks.stream(request("GET", { segment: "name" })), undefined);
  assert.equal(await h.hooks.stream(request("GET", { set: "unknowns" })), undefined);
});

const NEW_ID = "6f1d7c1e-0000-4000-8000-000000000002";
const FIFTEEN_MINUTES = 15 * 60 * 1000;

test("DELETE after a rolled-back write clears the live row, not a detached copy", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  const fileId = h.row().attachment;
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const failing = h.store.transact(async () => { await gate; throw new Error("boom"); }).catch(() => {});
  const cleared = h.hooks.stream(request("DELETE"));
  openGate();
  await failing;
  assert.equal((await cleared).status, 204);
  assert.equal(h.row().attachment, null);
  assert.equal(h.row().attachment_name, null);
  assert.equal(h.store.state.dataverse.files[fileId], undefined);
});

test("DeleteFile after a rolled-back write clears the live column, not a detached copy", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  const fileId = h.row().attachment;
  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const failing = h.store.transact(async () => { await gate; throw new Error("boom"); }).catch(() => {});
  const deleted = h.handle("DeleteFile")(action({ FileId: fileId }));
  openGate();
  await failing;
  assert.equal((await deleted).status, 204);
  assert.equal(h.row().attachment, null);
  assert.equal(h.row().attachment_name, null);
});

test("an image set on create is deletable once afterWrite gives the record its id", async () => {
  const h = harness();
  const data = { name: "New", entityimage: PNG.toString("base64") };
  h.hooks.beforeWrite(request("POST"), h.mapping, { operation: "create", data });
  const fileId = data.entityimage;
  h.store.state.tables.document.push({ documentid: NEW_ID, ...data });
  h.hooks.afterWrite(request("POST"), h.mapping, { operation: "create", id: NEW_ID });
  assert.equal(h.store.state.dataverse.files[fileId].recordId, NEW_ID);
  assert.equal((await h.handle("DeleteFile")(action({ FileId: fileId }))).status, 204);
  assert.equal(h.store.state.tables.document.find((r) => r.documentid === NEW_ID).entityimage, null);
});

test("UploadBlock refuses the block that pushes one upload past MaxSizeInKB", async () => {
  const h = harness();
  const token = (await h.handle("InitializeFileBlocksUpload")(action({ Target: target, FileName: "big.bin", FileAttributeName: "attachment" }))).body.FileContinuationToken;
  const data = Buffer.alloc(40 * 1024, 1).toString("base64");
  const upload = (blockId) => h.handle("UploadBlock")(action({ BlockId: b64(blockId), BlockData: data, FileContinuationToken: token }));
  assert.equal((await upload("block-0001")).status, 204);
  await assert.rejects(
    upload("block-0002"),
    (error) => error.status === 400 && error.details.innerCode === "0x80044a02" && error.message === "Attachment file size is too big.",
  );
});

test("upload sessions expire fifteen minutes after they start", async (t) => {
  const h = harness();
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const token = (await h.handle("InitializeFileBlocksUpload")(action({ Target: target, FileName: "a.bin", FileAttributeName: "attachment" }))).body.FileContinuationToken;
  now += FIFTEEN_MINUTES + 1;
  await assert.rejects(
    h.handle("UploadBlock")(action({ BlockId: b64("block-0001"), BlockData: b64("x"), FileContinuationToken: token })),
    (error) => error.status === 400 && error.message === "The file continuation token is not valid.",
  );
});

test("DeleteFile takes an uppercase braced FileId and answers 404 for prototype keys", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  const fileId = h.row().attachment;
  assert.equal((await h.handle("DeleteFile")(action({ FileId: `{${fileId.toUpperCase()}}` }))).status, 204);
  assert.equal(h.row().attachment, null);
  await assert.rejects(
    h.handle("DeleteFile")(action({ FileId: "__proto__" })),
    (error) => error.status === 404 && error.message === "File __proto__ does not exist.",
  );
});

test("an inverted Range is 416 and a 206 exposes x-ms-chunk-size", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("0123456789") }));
  await assert.rejects(h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=5-2" } })), (error) => error.status === 416);
  const part = await h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=2-4" } }));
  assert.match(part.headers["Access-Control-Expose-Headers"], /x-ms-chunk-size/);
});

test("a replaced image is released by afterWrite, so a write that never lands keeps the old image", async () => {
  const h = harness();
  const seed = { entityimage: PNG.toString("base64") };
  h.hooks.beforeWrite(request("POST"), h.mapping, { operation: "create", data: seed });
  const oldId = seed.entityimage;
  h.store.state.dataverse.files[oldId].recordId = DOC; // a stored image carries its record id once created
  h.row().entityimage = oldId;
  const data = { entityimage: PNG.toString("base64") };
  h.hooks.beforeWrite(request("PATCH"), h.mapping, { operation: "update", data, existing: h.row() });
  assert.ok(h.store.state.dataverse.files[oldId], "the old image stays until the write is applied");
  h.row().entityimage = data.entityimage;
  h.hooks.afterWrite(request("PATCH"), h.mapping, { operation: "update", id: DOC });
  assert.equal(h.store.state.dataverse.files[oldId], undefined);
  assert.ok(h.store.state.dataverse.files[data.entityimage]);
});

test("project looks the stored rows up once per call, not once per formatted row", () => {
  const h = harness();
  const ids = [DOC, "6f1d7c1e-0000-4000-8000-000000000003", "6f1d7c1e-0000-4000-8000-000000000004"];
  h.store.state.tables.document.push({ documentid: ids[1], name: "B" }, { documentid: ids[2], name: "C" });
  const real = h.store.tableRows.bind(h.store);
  let reads = 0;
  h.store.tableRows = (name) => { reads += 1; return real(name); };
  h.hooks.project(request("GET"), h.mapping, ids.map((id) => ({ documentid: id, photo: "raw" })));
  assert.equal(reads, 1);
});

test("the six actions carry CSDL fragments that name their parameter and response types", () => {
  const h = harness();
  for (const op of h.ops) assert.equal(typeof op.csdl, "string", `${op.name} has csdl`);
  const csdl = h.ops.map((op) => op.csdl).join("\n");
  for (const name of ["InitializeFileBlocksUploadResponse", "CommitFileBlocksUploadResponse", "InitializeFileBlocksDownloadResponse", "DownloadBlockResponse"]) {
    assert.match(csdl, new RegExp(`<ComplexType Name="${name}">`));
  }
  for (const name of ["InitializeFileBlocksUpload", "UploadBlock", "CommitFileBlocksUpload", "InitializeFileBlocksDownload", "DownloadBlock", "DeleteFile"]) {
    assert.match(csdl, new RegExp(`<Action Name="${name}">`));
  }
  assert.match(csdl, /<Parameter Name="FileId" Type="Edm\.Guid" Nullable="false" \/>/);
});
