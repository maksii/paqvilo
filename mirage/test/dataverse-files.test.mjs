// Simulated Dataverse file and image columns through the stream hook, the block actions
// and the record hooks. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { DataError } from "../lib/data-error.mjs";
import { install, reset } from "../lib/dataverse-files.mjs";

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
      photo: { dataverseType: "image", canStoreFullImage: true },
      sealed: { dataverseType: "image", canStoreFullImage: false },
      unflagged: { dataverseType: "image" },
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
  const routes = [];
  const api = {
    store, principals, change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add: (name, fn) => { hooks[name] = fn; } },
    addRoute: (match, handler, options) => routes.push({ match, handler, ...options }),
    // Stands in for the records layer: a route this module declines falls through to it.
    records: { handle: async (c) => ({ status: 200, body: { fellThrough: c.route.kind } }) },
  };
  install(api);
  const handle = (name) => ops.find((op) => op.name === name).handle;
  const mapping = store.state.mappings.document;
  return { store, hooks, handle, operations, ops, mapping, api, routes, row: () => store.state.tables.document[0] };
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

test("signed file URLs permit anonymous download for one hour and reject tampering, wrong verbs and expiry", async () => {
  const h = harness(); let now = Date.parse("2026-10-20T08:00:00Z"); h.api.clock = () => now;
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "invoice.txt" }, bodyBuffer: Buffer.from("private bytes") }));
  const response = await h.handle("GetFileSasUrl")({ ...action({}), params: { Target: { "@odata.id": `documents(${DOC})` }, FileAttributeName: "attachment" } });
  assert.equal(response.body.Result.FileSizeInBytes, 13);
  const signed = new URL(response.body.Result.SasUrl), route = h.routes.find((entry) => entry.anonymous);
  assert.equal(signed.origin, ORIGIN); assert.equal(route.match(signed.pathname), true);
  const download = await route.handler({ url: signed, method: "GET" });
  assert.equal(download.status, 200); assert.equal(download.body.toString(), "private bytes");
  assert.equal((await route.handler({ url: signed, method: "PUT", bodyBuffer: Buffer.from("bad") })).status, 403);
  const altered = new URL(signed); altered.searchParams.set("sp", "w");
  assert.equal((await route.handler({ url: altered, method: "PUT" })).status, 403);
  const tampered = new URL(signed); tampered.searchParams.set("sig", "invalid");
  assert.equal((await route.handler({ url: tampered, method: "GET" })).status, 403);
  now += 3600_000;
  assert.equal((await route.handler({ url: signed, method: "GET" })).status, 403);
  assert.equal(h.row().attachment != null, true, "expiry never deletes the underlying file");
});

test("minting a SAS URL checks read access and requires full-size image storage", async () => {
  const h = harness({ denyRead: true });
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("x") }));
  assert.throws(() => h.handle("GetFileSasUrl")({ ...action({}), params: { Target: target, FileAttributeName: "attachment" } }), (error) => error.status === 403);
  const image = harness();
  image.hooks.beforeWrite({}, image.mapping, { operation: "update", data: { sealed: PNG.toString("base64") }, existing: image.row() });
  assert.throws(() => image.handle("GetFileSasUrl")({ ...action({}), params: { Target: target, FileAttributeName: "sealed" } }), /full images/);
});

test("GetFileSasUrlForUpload returns the native Result wrapper and a signed PUT commits through block upload", async () => {
  const h = harness();
  const init = await h.handle("GetFileSasUrlForUpload")({ ...action({}), params: { Target: target, FileAttributeName: "attachment", FileName: "sas.txt" } });
  const { SasUrl, FileContinuationToken } = init.body.Result;
  const route = h.routes.find((entry) => entry.anonymous);
  assert.equal((await route.handler({ url: new URL(SasUrl), method: "PUT", bodyBuffer: Buffer.from("uploaded") })).status, 201);
  assert.equal(h.row().attachment, undefined, "PUT does not implicitly commit the record column");
  const committed = await h.handle("CommitFileBlocksUpload")(action({ FileName: "sas.txt", MimeType: "text/plain", FileContinuationToken, BlockList: [b64("sas")] }));
  assert.equal(committed.body.FileSizeInBytes, 8);
  const downloaded = await h.hooks.stream(request("GET", { value: true }));
  assert.equal(downloaded.body.toString(), "uploaded");
});

test("temporary file uploads validate declared size, bind their owner, and can be deleted after commit", async () => {
  const h = harness();
  await assert.rejects(h.handle("InitializeTemporaryFileBlocksUpload")(action({ FileName: "temp", FileSize: 0 })), /positive FileSize/);
  const init = await h.handle("InitializeTemporaryFileBlocksUpload")(action({ FileName: "temp.txt", FileSize: 4 }));
  const token = init.body.FileContinuationToken;
  assert.match(init.body.RecordId, /^[0-9a-f-]{36}$/);
  await h.handle("UploadBlock")(action({ FileContinuationToken: token, BlockId: b64("one"), BlockData: b64("temp") }));
  await assert.rejects(h.handle("CommitFileBlocksUpload")({ ...action({ FileContinuationToken: token, FileName: "temp.txt", MimeType: "text/plain", BlockList: [b64("one")] }), user: { systemuserid: DOC } }), /not valid/);
  const committed = await h.handle("CommitFileBlocksUpload")(action({ FileContinuationToken: token, FileName: "temp.txt", MimeType: "text/plain", BlockList: [b64("one")] }));
  assert.equal(h.store.state.dataverse.files[committed.body.FileId].data, b64("temp"));
  assert.equal((await h.handle("DeleteFile")(action({ FileId: committed.body.FileId }))).status, 204);
  assert.equal(h.store.state.dataverse.files[committed.body.FileId], undefined);
});

test("registers the file actions, signed URL functions and stream/record hooks", () => {
  const h = harness();
  assert.deepEqual(h.ops.map((op) => op.name).sort(), [
    "CommitAnnotationBlocksUpload", "CommitAttachmentBlocksUpload", "CommitFileBlocksUpload", "DeleteFile", "DownloadBlock", "GetFileSasUrl", "GetFileSasUrlForUpload",
    "InitializeAnnotationBlocksDownload", "InitializeAnnotationBlocksUpload", "InitializeAttachmentBlocksDownload",
    "InitializeAttachmentBlocksUpload", "InitializeFileBlocksDownload", "InitializeFileBlocksUpload", "InitializeTemporaryFileBlocksUpload", "UploadBlock",
  ]);
  assert.ok(h.ops.every((op) => op.kind === (op.name.startsWith("GetFileSas") ? "function" : "action") && op.binding === "unbound"));
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
  assert.equal(get.headers["Access-Control-Expose-Headers"], "x-ms-file-size, x-ms-file-name, mimetype");
  assert.ok(Object.hasOwn(get.headers, 'OData-Version'));
  assert.equal(get.headers['OData-Version'], undefined, 'full file downloads omit the OData header; ranged downloads keep their explicit version');
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

test("an image thumbnail sends no file headers, while size=full keeps them", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { segment: "photo", headers: { "x-ms-file-name": "p.png" }, bodyBuffer: PNG }));
  const thumb = await h.hooks.stream(request("GET", { segment: "photo", value: true }));
  assert.equal(thumb.status, 200);
  for (const name of ["x-ms-file-size", "x-ms-file-name", "mimetype", "content-disposition", "access-control-expose-headers"])
    assert.equal(thumb.headers[name], undefined, name);
  const full = await h.hooks.stream(request("GET", { segment: "photo", value: true, search: "?size=full" }));
  assert.equal(full.headers.mimetype, "image/png");
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

test("reset(api) ends the open upload sessions, so their continuation tokens stop working", async () => {
  const h = harness();
  const init = await h.handle("InitializeFileBlocksUpload")(action({ Target: target, FileName: "a.bin", FileAttributeName: "attachment" }));
  const token = init.body.FileContinuationToken;
  await reset(h.api);
  await assert.rejects(
    h.handle("UploadBlock")(action({ BlockId: b64("block-0001"), BlockData: b64("x"), FileContinuationToken: token })),
    (error) => error.status === 400,
  );
});

test("a never-set or deleted file column answers 404 with the attachment message; an image column answers 204", async () => {
  const h = harness();
  const message = `No file attachment found for attribute: attachment EntityId: ${DOC}.`;
  const unset = () => h.hooks.stream(request("GET", { value: true }));
  await assert.rejects(unset(), (error) => error.status === 404 && error.details.innerCode === "0x80040217" && error.message === message);
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("abc") }));
  await h.hooks.stream(request("DELETE"));
  await assert.rejects(unset(), (error) => error.status === 404);
  assert.equal((await h.hooks.stream(request("GET", { segment: "photo", value: true }))).status, 204);
});

test("a satisfiable range carries Content-Range; a start past the end is 416 with the chunk-range code", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("0123456789") }));
  const part = await h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=2-4" } }));
  assert.equal(part.headers["Content-Range"], "bytes 2-4/10");
  await assert.rejects(
    h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=99999-100000" } })),
    (error) => error.status === 416 && error.details.innerCode === "0x80090000"
      && error.message === "Chunk range used in this call is either not valid or it is bigger than allowed 4 MB.",
  );
});

test("DownloadBlock with a negative Offset answers the whole file; a zero BlockLength is refused", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("0123456789") }));
  const init = await h.handle("InitializeFileBlocksDownload")(action({ Target: target, FileAttributeName: "attachment" }));
  const token = init.body.FileContinuationToken;
  const whole = await h.handle("DownloadBlock")(action({ Offset: -1, BlockLength: 16, FileContinuationToken: token }));
  assert.equal(Buffer.from(whole.body.Data, "base64").toString(), "0123456789");
  await assert.rejects(h.handle("DownloadBlock")(action({ Offset: 0, BlockLength: 0, FileContinuationToken: token })), (error) => error.status === 400);
});

test("a record write of bytes that are not an image is 0x80040203; malformed base64 is 0x80048d19 quoting the literal", () => {
  const h = harness();
  const write = (value) => h.hooks.beforeWrite({}, h.mapping, { operation: "update", data: { photo: value }, existing: h.row() });
  assert.throws(() => write(b64("not an image")), (error) => error.status === 400 && error.details.innerCode === "0x80040203" && error.message === "Invalid argument.");
  assert.throws(
    () => write("!invalid!"),
    (error) => error.status === 400 && error.details.innerCode === "0x80048d19"
      && error.message.includes("Cannot convert the literal '!invalid!' to the expected type 'Edm.Binary'"),
  );
  assert.doesNotThrow(() => write(PNG.toString("base64")));
});

test("the extension route takes file and image property and value routes with the raw body, and declines the rest", async () => {
  const h = harness();
  const [{ match, handler }] = h.routes;
  const at = (segment, tail = "") => `/api/data/${VERSION}/documents(${DOC})/${segment}${tail}`;
  assert.equal(match(at("attachment"), "PATCH"), true);
  assert.equal(match(at("photo", "/$value"), "GET"), true);
  assert.equal(match(at("name"), "PATCH"), false);
  const stored = await handler(request("PATCH", { headers: { "x-ms-file-name": "a.txt" }, bodyBuffer: Buffer.from("raw") }));
  assert.equal(stored.status, 204);
  assert.ok(h.row().attachment, "the raw body reached the stream hook and was stored");
  assert.deepEqual(await handler(request("GET")), { status: 200, body: { fellThrough: "property" } });
});

test("a file column's mimetype comes from the file name's extension; Content-Type stays octet-stream", async () => {
  const h = harness();
  await h.hooks.stream(request("PATCH", { headers: { "content-type": "application/octet-stream", "x-ms-file-name": "notes.TXT" }, bodyBuffer: Buffer.from("hi") }));
  assert.equal(h.store.state.dataverse.files[h.row().attachment].mimeType, "text/plain");
  const get = await h.hooks.stream(request("GET", { value: true }));
  assert.equal(get.headers.mimetype, "text/plain");
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "data.bin" }, bodyBuffer: Buffer.from("x") }));
  assert.equal((await h.hooks.stream(request("GET", { value: true }))).headers.mimetype, "application/octet-stream");
  // A name with no extension, or one outside the map, falls back to application/octet-stream as well.
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "constructor" }, bodyBuffer: Buffer.from("x") }));
  assert.equal((await h.hooks.stream(request("GET", { value: true }))).headers.mimetype, "application/octet-stream");
});

test("the file download route answers its own errors as plain application/json", async () => {
  const h = harness();
  await assert.rejects(
    h.hooks.stream(request("GET", { value: true })),
    (error) => error.status === 404 && error.details.innerCode === "0x80040217" && error.details.contentType === "application/json",
  );
  await h.hooks.stream(request("PATCH", { headers: { "x-ms-file-name": "report.pdf" }, bodyBuffer: Buffer.from("hello world") }));
  await assert.rejects(
    h.hooks.stream(request("GET", { value: true, headers: { range: "bytes=99999-100000" } })),
    (error) => error.status === 416 && error.details.innerCode === "0x80090000" && error.details.contentType === "application/json",
  );
});
