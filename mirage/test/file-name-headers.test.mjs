// File-name headers on file downloads: x-ms-file-name and Content-Disposition stay valid HTTP headers for any
// name (RFC 6266 quoted fallback plus filename*=UTF-8''), over HTTP. Invented schema and GUIDs only.
import test from "node:test";
import assert from "node:assert/strict";
import { contentDisposition, fileNameHeader, rfc5987 } from "../lib/response-headers.mjs";
import { readFixture } from "./read-projection-fixture.mjs";

const DOC = "77777777-7777-4777-8777-000000000d01";
const mappings = { x_doc: { logicalName: "x_doc", entitySet: "x_docs", idColumn: "x_docid", nameColumn: "x_name",
  fields: { x_name: { dataverseType: "nvarchar" }, x_file: { dataverseType: "file", MaxSizeInKB: 64 } } } };
const tables = { x_doc: [{ x_docid: DOC, x_name: "doc", statecode: 0, statuscode: 1 }] };

// filename* parsed back per RFC 5987.
const starName = (disposition) => decodeURIComponent(/filename\*=UTF-8''([^;]+)/.exec(disposition)[1]);

async function upload(f, name, { viaHeader = false } = {}) {
  const query = viaHeader ? "" : `?x-ms-file-name=${encodeURIComponent(name)}`;
  const headers = { "content-type": "application/octet-stream", ...(viaHeader ? { "x-ms-file-name": Buffer.from(name, "utf8").toString("latin1") } : {}) };
  const response = await f.request("PATCH", `/x_docs(${DOC})/x_file${query}`, "hello", headers);
  assert.equal(response.status, 204, await response.text());
}

test("CJK file name uploads and downloads with a valid filename*", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  await upload(f, "報告書.txt");
  const down = await f.request("GET", `/x_docs(${DOC})/x_file/$value`);
  assert.equal(down.status, 200);
  assert.equal(await down.text(), "hello");
  assert.equal(starName(down.headers.get("content-disposition")), "報告書.txt");
  assert.match(down.headers.get("content-disposition"), /^inline; filename="___\.txt"; /);
  assert.equal(decodeURIComponent(down.headers.get("x-ms-file-name")), "報告書.txt");
});

test("quote, semicolon and CRLF never break or inject headers", async (t) => {
  for (const name of ['a"b;c.txt', "x\r\nSet-Cookie: y=1.txt"]) {
    const value = contentDisposition("attachment", name);
    assert.doesNotMatch(value, /[\r\n]/);
    assert.equal(value.split('"').length, 3, "exactly one quoted filename");
    assert.equal(starName(value), name);
  }
  assert.equal(fileNameHeader("x\r\ny"), "x%0D%0Ay");
  const f = await readFixture(t, { mappings, tables });
  await upload(f, 'a"b;c.txt');
  const down = await f.request("GET", `/x_docs(${DOC})/x_file/$value`);
  assert.equal(down.headers.get("content-disposition"), "inline; filename=\"a_b;c.txt\"; filename*=UTF-8''a%22b%3Bc.txt");
  assert.equal(down.headers.get("x-ms-file-name"), 'a"b;c.txt');
});

test("a latin1 name round-trips", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  await upload(f, "Ünïcödé.txt");
  const down = await f.request("GET", `/x_docs(${DOC})/x_file/$value`);
  assert.equal(starName(down.headers.get("content-disposition")), "Ünïcödé.txt");
  assert.equal(down.headers.get("x-ms-file-name"), rfc5987("Ünïcödé.txt"));
  const meta = await f.json(await f.request("GET", `/x_docs(${DOC})?$select=x_file_name`), 200);
  assert.equal(meta.x_file_name, "Ünïcödé.txt");
});

test("an x-ms-file-name header sent as UTF-8 bytes is stored correctly", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  await upload(f, "Zürich 報告.txt", { viaHeader: true });
  const meta = await f.json(await f.request("GET", `/x_docs(${DOC})?$select=x_file_name`), 200);
  assert.equal(meta.x_file_name, "Zürich 報告.txt");
});

test("SAS download of a Unicode name answers 200 with filename*", async (t) => {
  const f = await readFixture(t, { mappings, tables });
  await upload(f, "報告書.txt");
  const alias = encodeURIComponent(JSON.stringify({ "@odata.id": `x_docs(${DOC})` }));
  const sas = await f.json(await f.request("GET", `/GetFileSasUrl(Target=@t,FileAttributeName='x_file')?@t=${alias}`), 200);
  const down = await fetch(sas.Result.SasUrl, { signal: AbortSignal.timeout(10000) });
  assert.equal(down.status, 200);
  assert.equal(await down.text(), "hello");
  assert.match(down.headers.get("content-disposition"), /^attachment; filename="___\.txt"; /);
  assert.equal(starName(down.headers.get("content-disposition")), "報告書.txt");
});
