import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { protectConfiguration, unprotectConfiguration } from "../lib/native-services.mjs";
import { signInHeaders } from "../testing/session.mjs";

const SITE = "4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const ACCOUNTS = {
  alpha: "a0000000-0000-4000-8000-000000000001",
  beta: "a0000000-0000-4000-8000-000000000002",
  gamma: "a0000000-0000-4000-8000-000000000003",
};
const NOTE = "e0000000-0000-4000-8000-000000000001";
const INTERNAL_NOTE = "e0000000-0000-4000-8000-000000000002";

async function fixture(t, { roles = ["Editor"] } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-services-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Native`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": `{% include 'entity_list' key: 'Accounts' %}{% entityform name: "Edit contact" %}`,
    "Accounts.list.yml": "adx_entitylistid: 1b000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 2\nadx_searchenabled: true",
    "Edit.basicform.yml": "adx_entityformid: 2b000000-0000-4000-8000-000000000001\nadx_name: Edit contact\nadx_entityname: contact\nadx_mode: 100000001",
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const grant = (entity, operations) => ({ id: `editor-${entity}`, entity, scope: "global", roles: ["Editor"], operations });
  const initial = {
    version: 1,
    mappings: {
      contact: {
        entitySet: "contacts",
        idColumn: "contactid",
        nameColumn: "fullname",
        relationships: { parentcustomerid_account: { entity: "account", from: "parentcustomerid", to: "accountid", many: false } },
      },
      account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" },
      annotation: { entitySet: "annotations", idColumn: "annotationid", nameColumn: "subject" },
    },
    tables: {
      contact: [{ contactid: CONTACT, fullname: "Ada", parentcustomerid: { id: ACCOUNTS.alpha, logical_name: "account", name: "Alpha" } }],
      account: [
        { accountid: ACCOUNTS.alpha, name: "Alpha", city: "London" },
        { accountid: ACCOUNTS.beta, name: "Beta", city: "Paris" },
        { accountid: ACCOUNTS.gamma, name: "Gamma", city: "Rome" },
      ],
      annotation: [
        {
          annotationid: NOTE,
          notetext: "*WEB*Shared note",
          subject: "Note created by Ada",
          objecttypecode: "contact",
          objectid: { id: CONTACT, logical_name: "contact" },
          filename: "evidence.txt",
          mimetype: "text/plain",
          documentbody: Buffer.from("evidence").toString("base64"),
          createdon: "2026-01-02T03:04:05Z",
        },
        {
          annotationid: INTERNAL_NOTE,
          notetext: "Internal only",
          subject: "Back office",
          objecttypecode: "contact",
          objectid: { id: CONTACT, logical_name: "contact" },
          createdon: "2026-01-01T00:00:00Z",
        },
      ],
    },
    permissions: [grant("contact", ["read", "update"]), grant("account", ["read"]), grant("annotation", ["read"])],
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      identity: { id: CONTACT, contactId: CONTACT, fullname: "Ada", roles },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {
        Accounts: { entity: "account", fields: [{ name: "name", label: "Account name" }, { name: "city", label: "City" }] },
        "2b000000-0000-4000-8000-000000000001": {
          entity: "contact",
          mode: 100000001,
          fields: [{ name: "fullname", label: "Full name" }, { name: "parentcustomerid", label: "Organisation", type: "lookup" }],
        },
      },
    },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  t.after(() => app.close());
  // Portal requests are signed in explicitly (paqvilo-mirage-auth session) as the persona.
  const session = signInHeaders(app, CONTACT, { roles });
  const token = app.state().csrf;
  const post = (action, body, headers = { __RequestVerificationToken: token }) =>
    fetch(`${app.url}/_services/${action}/${SITE}`, { method: "POST", headers: { "content-type": "application/json", ...session, ...headers }, body: JSON.stringify(body) });
  const get = (pathname) => fetch(app.url + pathname, { headers: session });
  return { app, post, get };
}

const layoutsAfter = (html, marker) => {
  const encoded = /data-view-layouts="([^"]*)"/.exec(html.slice(html.indexOf(marker)))[1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
};
const gridRequest = (secure, extra = {}) => ({
  base64SecureConfiguration: secure,
  sortExpression: "",
  search: "",
  page: 1,
  pageSize: 2,
  pagingCookie: "",
  filter: null,
  metaFilter: null,
  nlSearchFilter: "",
  timezoneOffset: 0,
  customParameters: [],
  ...extra,
});
const names = (data) => data.Records.map((record) => record.Attributes.find((attribute) => attribute.Name === "name").Value);

test("protected grid configuration round-trips and rejects tampering", () => {
  const token = protectConfiguration({ t: "list", w: SITE, list: "x" });
  assert.deepEqual(unprotectConfiguration(token), { t: "list", w: SITE, list: "x" });
  const [payload] = Buffer.from(token, "base64").toString("utf8").split(".");
  const forged = Buffer.from(`${payload}.0000`).toString("base64");
  assert.throws(() => unprotectConfiguration(forged), (error) => error.status === 403);
  assert.throws(() => unprotectConfiguration("not-a-token"), (error) => error.status === 403);
});

test("entity grid service returns the native paging, search and layout-only sort contract", async (t) => {
  const { app, post, get } = await fixture(t);
  const page = await (await get(`/?id=${CONTACT}`)).text();
  assert.match(page, new RegExp(`data-get-url="/_services/entity-grid-data.json/${SITE}"`));
  const [layout] = layoutsAfter(page, 'class="entity-grid entitylist');
  assert.deepEqual(layout.Columns.map((column) => [column.LogicalName, column.Name]), [["name", "Account name"], ["city", "City"]]);
  const secure = layout.Base64SecureConfiguration;
  assert.equal((await post("entity-grid-data.json", gridRequest(secure), {})).status, 403);
  let response = await post("entity-grid-data.json", gridRequest(secure));
  assert.equal(response.status, 200);
  let data = await response.json();
  assert.deepEqual([data.ItemCount, data.PageCount, data.PageNumber, data.PageSize, data.MoreRecords], [3, 2, 1, 2, true]);
  const name = data.Records[0].Attributes.find((attribute) => attribute.Name === "name");
  assert.deepEqual([name.Type, typeof name.FormattedValue], ["System.String", "string"]);
  assert.equal(data.Records[0].EntityName, "account");
  data = await (await post("entity-grid-data.json", gridRequest(secure, { page: 2 }))).json();
  assert.deepEqual([data.Records.length, data.MoreRecords, data.PageNumber], [1, false, 2]);
  // Quick search is begins-with on the view's text columns; * is the wildcard.
  data = await (await post("entity-grid-data.json", gridRequest(secure, { search: "Ga" }))).json();
  assert.deepEqual(names(data), ["Gamma"]);
  data = await (await post("entity-grid-data.json", gridRequest(secure, { search: "*ar" }))).json();
  assert.deepEqual(names(data), ["Beta"]);
  data = await (await post("entity-grid-data.json", gridRequest(secure, { sortExpression: "name DESC", pageSize: 3 }))).json();
  assert.deepEqual(names(data), ["Gamma", "Beta", "Alpha"]);
  // A sort on a column outside the layout is ignored rather than leaking other columns.
  data = await (await post("entity-grid-data.json", gridRequest(secure, { sortExpression: "accountid DESC", pageSize: 3 }))).json();
  assert.equal(data.Records.length, 3);
  // The opaque configuration is bound to its endpoint kind and signature.
  assert.equal((await post("entity-subgrid-data.json", gridRequest(secure))).status, 403);
  const forged = Buffer.from(`${Buffer.from(JSON.stringify({ t: "list", w: SITE })).toString("base64url")}.forged`).toString("base64");
  assert.equal((await post("entity-grid-data.json", gridRequest(forged))).status, 403);
});

test("lookup grid service serves the editable lookup's target view on demand", async (t) => {
  const { app, post, get } = await fixture(t);
  const page = await (await get(`/?id=${CONTACT}`)).text();
  assert.match(page, /id="parentcustomerid_name"[^>]*value="Alpha"/);
  assert.match(page, /<button type="button" class="btn btn-default launchentitylookup"[^>]*aria-label="Organisation Launch lookup modal"/);
  const [layout] = layoutsAfter(page, 'id="parentcustomerid_lookupmodal"');
  assert.equal(layout.Configuration.EntityName, "account");
  const response = await post("entity-lookup-grid-data.json", gridRequest(layout.Base64SecureConfiguration, { pageSize: 10 }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.Records.map((record) => record.Id).sort(), Object.values(ACCOUNTS).sort());
  assert.equal((await post("entity-grid-data.json", gridRequest(layout.Base64SecureConfiguration))).status, 403);
});

test("grid reads follow table permissions and report native access denial", async (t) => {
  const { app, post, get } = await fixture(t);
  const page = await (await get(`/?id=${CONTACT}`)).text();
  const [layout] = layoutsAfter(page, 'class="entity-grid entitylist');
  const state = app.store.snapshot();
  state.permissions = state.permissions.filter((rule) => rule.entity !== "account");
  await app.store.replaceState(state);
  const data = await (await post("entity-grid-data.json", gridRequest(layout.Base64SecureConfiguration))).json();
  assert.deepEqual(data, { AccessDenied: true });
});

test("notes service lists portal notes and annotation downloads stream the document body", async (t) => {
  const { app, post, get } = await fixture(t);
  const response = await post("entity-notes", { regarding: { LogicalName: "contact", Id: CONTACT }, page: 1, pageSize: 10 });
  assert.equal(response.status, 200);
  const notes = await response.json();
  // Only *WEB* notes are portal notes; the prefix is not displayed.
  assert.deepEqual(notes.Records.map((record) => [record.Id, record.UnformattedText, record.HasAttachment]), [[NOTE, "Shared note", true]]);
  assert.equal(notes.Records[0].AttachmentUrl, `/_entity/annotation/${NOTE}/${SITE}`);
  assert.equal(notes.Records[0].AttachmentSizeDisplay, "8 B");
  const download = await get(notes.Records[0].AttachmentUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("content-type"), "text/plain");
  assert.match(download.headers.get("content-disposition"), /^attachment;filename="evidence\.txt"$/);
  assert.equal(await download.text(), "evidence");
  assert.equal((await get(`/_entity/annotation/e0000000-0000-4000-8000-0000000000ff`)).status, 404);
  assert.equal((await post("entity-notes", { regarding: { LogicalName: "contact", Id: CONTACT } }, {})).status, 403);
});

test("anti-forgery token endpoint returns the native hidden input", async (t) => {
  const { app, get } = await fixture(t);
  const html = await (await get(`/_portal/${SITE}/Layout/GetAntiForgeryToken`)).text();
  assert.equal(html, `<input name="__RequestVerificationToken" type="hidden" value="${app.state().csrf}" />`);
});

test("notes service adds, edits and deletes the signed-in contact's own portal notes", async (t) => {
  const { app, post, get } = await fixture(t);
  const state = app.store.snapshot();
  const grant = (entity, operations) => ({ id: `editor-${entity}`, entity, scope: "global", roles: ["Editor"], operations });
  state.permissions = [grant("contact", ["read", "update", "append", "appendTo"]), grant("account", ["read"]), grant("annotation", ["read", "create", "update", "delete", "append", "appendTo"])];
  await app.store.replaceState(state);
  const list = async () => (await (await post("entity-notes", { regarding: { LogicalName: "contact", Id: CONTACT }, page: 1, pageSize: 10 })).json()).Records;

  const added = await post("entity-form-addnote", {
    regardingEntityLogicalName: "contact",
    regardingEntityId: CONTACT,
    text: "Local note",
    file: { name: "local.txt", type: "text/plain", content: Buffer.from("local evidence").toString("base64") },
  });
  assert.equal(added.status, 201);
  const { Id: id } = await added.json();
  let mine = (await list()).find((record) => record.Id === id);
  assert.deepEqual(
    [mine.UnformattedText, mine.IsPostedByCurrentUser, mine.CanWrite, mine.CanDelete, mine.PostedByName, mine.AttachmentFileName, mine.AttachmentSize],
    ["Local note", true, true, true, "Ada", "local.txt", 14],
  );
  assert.equal(await (await get(mine.AttachmentUrl)).text(), "local evidence");
  // Notes the contact did not post stay read-only for it.
  assert.equal((await list()).find((record) => record.Id === NOTE).CanWrite, false);

  assert.equal((await post("entity-form-updatenote", { id, text: "Edited note" })).status, 200);
  mine = (await list()).find((record) => record.Id === id);
  assert.equal(mine.UnformattedText, "Edited note");
  assert.equal((await post("entity-form-updatenote", { id, text: "  " })).status, 417);
  assert.equal((await post("entity-form-updatenote", { id: NOTE, text: "Not mine" })).status, 403);
  assert.equal((await post("entity-form-addnote", { regardingEntityLogicalName: "contact", regardingEntityId: CONTACT, text: "" })).status, 417);
  assert.equal((await post("entity-form-deletenote", { id }, {})).status, 403);

  assert.equal((await post("entity-form-deletenote", { id })).status, 200);
  assert.equal((await list()).some((record) => record.Id === id), false);
  assert.equal((await post("entity-form-deletenote", { id: NOTE })).status, 403);

  // objectid is polymorphic: with one navigation property per regarding table (as solutions
  // declare them), the note binds through the contact's and the other tables' are not applied.
  const polymorphic = app.store.snapshot();
  polymorphic.mappings.annotation.relationships = {
    ObjectId: { entity: "account", from: "objectid", to: "accountid", many: false },
    objectid_contact: { entity: "contact", from: "objectid", to: "contactid", many: false },
  };
  await app.store.replaceState(polymorphic);
  const bound = await post("entity-form-addnote", { regardingEntityLogicalName: "contact", regardingEntityId: CONTACT, text: "Bound note" });
  assert.equal(bound.status, 201);
  const boundId = (await bound.json()).Id;
  assert.deepEqual(app.store.snapshot().tables.annotation.find((row) => row.annotationid === boundId).objectid, { id: CONTACT, logical_name: "contact", name: "Ada" });
  assert.equal((await list()).find((record) => record.Id === boundId).UnformattedText, "Bound note");
  assert.equal((await post("entity-form-addnote", { regardingEntityLogicalName: "contact", regardingEntityId: "c0000000-0000-4000-8000-0000000000ff", text: "Missing" })).status, 404);
});
