import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EXTENSION } from "../lib/sharepoint-documents.mjs";
import { createLocalDiskStorage } from "../lib/storage-local-disk.mjs";
import { createStorageRouter, storageSettings } from "../lib/storage-provider.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const CASE = "55555555-5555-4555-8555-555555555555";
const SITE = "66666666-6666-4666-8666-666666666666";
const NOBODY = "88888888-8888-4888-8888-888888888888"; // a systemuser with no roles
const ADMIN = { admin: true };
const mappings = {
  x_case: { logicalName: "x_case", entitySet: "x_cases", idColumn: "x_caseid", nameColumn: "x_name", fields: { x_name: { dataverseType: "nvarchar" } } },
};
const tables = {
  x_case: [{ x_caseid: CASE, x_name: "Invented: case", statecode: 0, statuscode: 1 }],
  sharepointsite: [{ sharepointsiteid: SITE, name: "Default Site", absoluteurl: "https://site.example.test/sites/invented", isdefault: true, isgridpresent: true, statecode: 0, statuscode: 1 }],
  systemuser: [{ systemuserid: NOBODY, fullname: "Invented nobody", isdisabled: false, accessmode: 0 }],
};

async function setup(t, { withStorage = true } = {}) {
  const diagnostics = [];
  let storage;
  if (withStorage) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "sharepoint-documents-"));
    ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
    const local = createLocalDiskStorage({ root });
    ownedFixture(t).add(() => local.close());
    storage = createStorageRouter({ config: storageSettings({}), providers: { local } });
  }
  let api;
  // The fixture returns the HTTP handle; the wrapper keeps the internal api the module installs on.
  const extension = { ...EXTENSION, install: (internal, options) => { api = internal; return EXTENSION.install(internal, options); } };
  const fixture = await contractModuleFixture(t, { mappings, tables, extension, options: { storage, diagnostic: (entry) => diagnostics.push(entry) } });
  return { ...fixture, api, sp: api.sharepoint, diagnostics };
}

test("ensureLocation creates the library and record location rows and the folder, once", async (t) => {
  const { sp, store, request, json } = await setup(t);
  const location = await sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, ADMIN);
  assert.equal(location.relativeurl, "Invented case_55555555555545558555555555555555");
  assert.equal(location.regardingobjectid.id, CASE);
  assert.equal(location.parentsiteorlocation.logical_name, "sharepointdocumentlocation");
  const again = await sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, ADMIN);
  assert.equal(again.sharepointdocumentlocationid, location.sharepointdocumentlocationid);
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 2);
  assert.equal((await sp.locationsFor({ logicalName: "x_case", id: CASE }, ADMIN)).length, 1);
  assert.deepEqual(await sp.listDocuments(location.sharepointdocumentlocationid, ADMIN), []);
  // The rows compose with the existing RetrieveAbsoluteAndSiteCollectionUrl message.
  const urls = await json(await request("GET", `/sharepointdocumentlocations(${location.sharepointdocumentlocationid})/Microsoft.Dynamics.CRM.RetrieveAbsoluteAndSiteCollectionUrl()`), 200);
  assert.equal(urls.AbsoluteUrl, "https://site.example.test/sites/invented/x_case/Invented case_55555555555545558555555555555555");
});

test("concurrent ensureLocation calls for one record create one record location", async (t) => {
  const { sp, store } = await setup(t);
  const regarding = { logicalName: "x_case", id: CASE };
  const [first, second] = await Promise.all([sp.ensureLocation(regarding, {}, ADMIN), sp.ensureLocation(regarding, {}, ADMIN)]);
  assert.equal(first.sharepointdocumentlocationid, second.sharepointdocumentlocationid);
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 2);
  assert.equal((await sp.locationsFor(regarding, ADMIN)).length, 1);
});

test("upload, list and delete carry provider ETags and honour If-Match", async (t) => {
  const { sp } = await setup(t);
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, ADMIN);
  const first = await sp.upload(id, { name: "Report A_1.txt", bytes: Buffer.from("one"), contentType: "text/plain" }, ADMIN);
  assert.match(first.etag, /^".+"$/);
  const second = await sp.upload(id, { name: "Report A_1.txt", bytes: Buffer.from("two!"), ifMatch: first.etag }, ADMIN);
  assert.notEqual(second.etag, first.etag);
  await assert.rejects(sp.upload(id, { name: "Report A_1.txt", bytes: Buffer.from("x"), ifMatch: first.etag }, ADMIN), { status: 412 });
  const listed = await sp.listDocuments(id, ADMIN);
  assert.deepEqual(listed.map(({ name, size, etag }) => ({ name, size, etag })), [{ name: "Report A_1.txt", size: 4, etag: second.etag }]);
  await assert.rejects(sp.delete(id, "Report A_1.txt", { ifMatch: first.etag }, ADMIN), { status: 412 });
  assert.deepEqual(await sp.delete(id, "Report A_1.txt", { ifMatch: second.etag }, ADMIN), { deleted: true });
  assert.deepEqual(await sp.listDocuments(id, ADMIN), []);
  await assert.rejects(sp.delete(id, "Report A_1.txt", {}, ADMIN), { status: 404 });
  await assert.rejects(sp.upload(id, { name: "../escape", bytes: Buffer.from("x") }, ADMIN), { code: "SharePointInvalidName" });
});

test("a non-admin caller without privilege on the regarding record is refused", async (t) => {
  const { sp, api, store } = await setup(t);
  const nobody = api.principals.byId(NOBODY);
  assert.ok(nobody);
  await assert.rejects(sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, { user: nobody }), { status: 403 });
  assert.equal(store.state.tables.sharepointdocumentlocation.length, 0);
  // A caller holding the privilege (the fixture's System Administrator application user) passes as a user, not as admin.
  const privileged = api.principals.byApplicationId("77777777-7777-4777-8777-777777777777");
  const { sharepointdocumentlocationid: id, ownerid } = await sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, { user: privileged });
  assert.equal(ownerid.id, privileged.systemuserid);
  await assert.rejects(sp.listDocuments(id, { user: nobody }), { status: 403 });
  await assert.rejects(sp.upload(id, { name: "a.txt", bytes: Buffer.from("a") }, { user: nobody }), { status: 403 });
  await assert.rejects(sp.listDocuments(id), { status: 403 });
});

test("the organization attachment size limit refuses a large upload", async (t) => {
  const { sp, store } = await setup(t);
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, ADMIN);
  store.state.simulator = { ...(store.state.simulator ?? {}), platformOverrides: { MaxUploadFileSize: 8 } };
  await assert.rejects(sp.upload(id, { name: "big.bin", bytes: Buffer.alloc(64) }, ADMIN), { code: "AttachmentTooLarge" });
  assert.deepEqual(await sp.listDocuments(id, ADMIN), []);
});

test("without storage every storage operation answers 501 and reports one diagnostic", async (t) => {
  const { sp, diagnostics } = await setup(t, { withStorage: false });
  await assert.rejects(sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, ADMIN), { status: 501, code: "SharePointStorageNotConfigured" });
  await assert.rejects(sp.ensureLocation({ logicalName: "x_case", id: CASE }, {}, ADMIN), { status: 501 });
  assert.deepEqual(await sp.locationsFor({ logicalName: "x_case", id: CASE }, ADMIN), []);
  assert.equal(diagnostics.filter((entry) => entry.code === "SHAREPOINT_ROUTE_MISSING").length, 1);
  assert.equal(sp.describe().level, "contract");
});

test("describe levels follow storage", async (t) => {
  const { sp } = await setup(t);
  const record = sp.describe();
  assert.equal(record.level, "behaviour");
  assert.deepEqual(record.requires, ["provider:storage/sharepointDocuments", "table:sharepointdocumentlocation"]);
  const levels = Object.fromEntries(record.operations.map((op) => [op.name, op.level]));
  assert.equal(levels.upload, "behaviour");
  assert.equal(levels.powerPagesDocumentControl, "contract");
  assert.equal(levels.autoFolderNaming, "contract");
  assert.equal(EXTENSION.describe().level, "contract");
});
