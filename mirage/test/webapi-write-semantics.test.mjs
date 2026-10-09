// Web API write semantics: representations validated before writing, relationship
// writes through the update pipeline, delete cascades, numeric bounds and choice values.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { DataStore } from "../lib/data.mjs";

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const SETTINGS = {
  "Webapi/account/enabled": "true",
  "Webapi/account/fields": "name,revenue,employees,industrycode,statecode,statuscode,contact_customer_accounts,account_tags",
  "Webapi/contact/enabled": "true",
  "Webapi/contact/fields": "fullname,parentcustomerid",
  "Webapi/tag/enabled": "true",
  "Webapi/tag/fields": "name",
  "Webapi/error/innererror": "true",
};
const settingsYaml = (settings) =>
  Object.entries(settings)
    .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${String(value).replace(/'/g, "''")}'`)
    .join("\n");

function fixture({ cascadeDelete } = {}) {
  const cascade = cascadeDelete ? { cascade: { delete: cascadeDelete } } : {};
  return {
    mappings: {
      account: {
        entitySet: "accounts",
        idColumn: "accountid",
        nameColumn: "name",
        stateStatusDefaults: { 0: 1, 1: 2 },
        fields: {
          name: { dataverseType: "nvarchar" },
          revenue: { dataverseType: "money", precision: 2, minValue: 0, maxValue: 1000000 },
          employees: { dataverseType: "int", minValue: 0, maxValue: 500 },
          industrycode: { dataverseType: "picklist", options: [{ value: 1, label: "Accounting" }, { value: 2, label: "Agriculture" }] },
          statecode: { dataverseType: "state", options: [{ value: 0, label: "Active" }, { value: 1, label: "Inactive" }] },
          statuscode: {
            dataverseType: "status",
            statuses: [{ value: 1, label: "Active", state: 0 }, { value: 2, label: "Inactive", state: 1 }],
            options: [{ value: 1, label: "Active", state: 0 }, { value: 2, label: "Inactive", state: 1 }],
          },
        },
        relationships: {
          contact_customer_accounts: { entity: "contact", from: "accountid", to: "parentcustomerid", many: true, schemaName: "contact_customer_accounts", ...cascade },
          account_tags: { entity: "tag", from: "accountid", to: "tagid", many: true, intersect: { entity: "account_tag", from: "accountid", to: "tagid" } },
        },
      },
      contact: {
        entitySet: "contacts",
        idColumn: "contactid",
        nameColumn: "fullname",
        fields: { fullname: { dataverseType: "nvarchar" }, parentcustomerid: { dataverseType: "lookup", targets: ["account"] } },
        relationships: {
          parentcustomerid: { entity: "account", from: "parentcustomerid", to: "accountid", many: false, schemaName: "contact_customer_accounts", ...cascade },
        },
      },
      tag: { entitySet: "tags", idColumn: "tagid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" } } },
      account_tag: { entitySet: "account_tags", idColumn: "account_tagid" },
    },
    tables: {
      account: [{ accountid: G(1), name: "Contoso", statecode: 0, statuscode: 1, versionnumber: 5 }],
      contact: [
        { contactid: G(11), fullname: "Ada", parentcustomerid: { id: G(1), logical_name: "account", name: "Contoso" }, versionnumber: 3 },
        { contactid: G(12), fullname: "Bob", versionnumber: 7 },
      ],
      tag: [{ tagid: G(21), name: "Gold" }],
      account_tag: [{ account_tagid: G(31), accountid: G(1), tagid: G(21) }],
    },
    settings: { permissionMode: "permissive" },
    simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: G(11), roles: [] }, live: {}, endpoints: [] },
  };
}

async function start(t, { state = fixture(), settings = SETTINGS } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-write-semantics-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Write semantics\n");
  await fs.writeFile(path.join(directory, "sitesetting.yml"), settingsYaml(settings));
  const app = await createSimulator({ sourceDir: directory, initial: state, watch: false });
  t.after(() => app.close());
  const json = async (route, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        __RequestVerificationToken: app.state().csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  const rows = (table) => app.store.snapshot().tables[table] ?? [];
  return { app, json, rows };
}
const enforced = (permissions) => {
  const state = fixture();
  state.settings = { permissionMode: "enforce" };
  state.permissions = permissions;
  state.simulator.identity = { id: G(11), roles: ["Writer"] };
  return state;
};

test("Prefer return=representation is checked before the write; nothing commits when the read fails", async (t) => {
  // Create allowed, read denied: 403 90040120 and no new account.
  const createOnly = await start(t, { state: enforced([{ id: "create", entity: "account", scope: "global", roles: ["Writer"], operations: ["create"] }]) });
  const denied = await createOnly.json("/_api/accounts?$select=name", { method: "POST", body: { name: "New" }, headers: { Prefer: "return=representation" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "90040120");
  assert.equal(createOnly.rows("account").length, 1, "no committed row");
  // An unknown $select column fails before the write too.
  const open = await start(t);
  const badSelect = await open.json("/_api/accounts?$select=nosuchcolumn", { method: "POST", body: { name: "New" }, headers: { Prefer: "return=representation" } });
  assert.equal(badSelect.status, 400);
  assert.equal(open.rows("account").length, 1);
  // A row outside the caller's read scope rolls the write back (403, nothing committed).
  const scoped = await start(t, {
    state: enforced([
      { id: "create", entity: "contact", scope: "global", roles: ["Writer"], operations: ["create"] },
      { id: "self", entity: "contact", scope: "self", roles: ["Writer"], operations: ["read"] },
    ]),
  });
  const outside = await scoped.json("/_api/contacts?$select=fullname", { method: "POST", body: { fullname: "Eve" }, headers: { Prefer: "return=representation" } });
  assert.equal(outside.status, 403);
  assert.equal(outside.body.error.code, "90040120");
  assert.equal(scoped.rows("contact").length, 2, "the rolled-back contact isn't stored");
  // An unreadable $expand target fails before an update is applied.
  const update = await start(t, {
    state: enforced([{ id: "accounts", entity: "account", scope: "global", roles: ["Writer"], operations: ["read", "update"] }]),
  });
  const expand = await update.json(`/_api/accounts(${G(1)})?$select=name&$expand=contact_customer_accounts($select=fullname)`, {
    method: "PATCH",
    body: { name: "Renamed" },
    headers: { Prefer: "return=representation" },
  });
  assert.equal(expand.status, 403);
  assert.equal(update.rows("account")[0].name, "Contoso", "the update didn't commit");
  // A permitted representation still answers 201 with the new row.
  const created = await open.json("/_api/accounts?$select=name", { method: "POST", body: { name: "Fabrikam" }, headers: { Prefer: "return=representation" } });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "Fabrikam");
});

test("one-to-many associations update the referencing row's version and modifiedon", async (t) => {
  const { json, rows } = await start(t);
  const before = rows("contact").find((row) => row.contactid === G(12));
  const etag = (await json(`/_api/contacts(${G(12)})?$select=fullname`)).body["@odata.etag"];
  assert.equal(etag, 'W/"7"');
  const linked = await json(`/_api/accounts(${G(1)})/contact_customer_accounts/$ref`, {
    method: "POST",
    body: { "@odata.id": `/_api/contacts(${G(12)})` },
  });
  assert.equal(linked.status, 204);
  const after = rows("contact").find((row) => row.contactid === G(12));
  assert.equal(after.versionnumber, 8);
  assert.notEqual(after.modifiedon, before.modifiedon);
  // The earlier ETag no longer matches, so a stale update fails.
  const stale = await json(`/_api/contacts(${G(12)})`, { method: "PATCH", body: { fullname: "Bobby" }, headers: { "If-Match": etag } });
  assert.equal(stale.status, 412);
  const unlinked = await json(`/_api/accounts(${G(1)})/contact_customer_accounts(${G(12)})/$ref`, { method: "DELETE" });
  assert.equal(unlinked.status, 204);
  assert.equal(rows("contact").find((row) => row.contactid === G(12)).versionnumber, 9);
});

test("deleting a referenced row applies the relationship's CascadeDelete", async () => {
  const store = (cascadeDelete) => new DataStore({ state: fixture({ cascadeDelete }) });
  // Restrict refuses the delete while a contact references the account.
  const restrict = store("Restrict");
  await assert.rejects(restrict.remove("account", G(1), { admin: true }), (error) => error.status === 405 && error.details.innerCode === "0x80040227");
  assert.equal(restrict.state.tables.account.length, 1);
  // Cascade deletes the referencing contact; the intersect row goes with the account.
  const cascade = store("Cascade");
  await cascade.remove("account", G(1), { admin: true });
  assert.deepEqual(cascade.state.tables.contact.map((row) => row.contactid), [G(12)]);
  assert.deepEqual(cascade.state.tables.account_tag, []);
  // RemoveLink clears the lookup through the update pipeline.
  const removeLink = store("RemoveLink");
  await removeLink.remove("account", G(1), { admin: true });
  const ada = removeLink.state.tables.contact.find((row) => row.contactid === G(11));
  assert.equal(ada.parentcustomerid, null);
  assert.equal(ada.versionnumber, 4);
  // NoCascade leaves the contact; no imported configuration means RemoveLink, recorded.
  const none = store("NoCascade");
  await none.remove("account", G(1), { admin: true });
  assert.equal(none.state.tables.contact.find((row) => row.contactid === G(11)).parentcustomerid.id, G(1));
  const defaulted = store(undefined);
  await defaulted.remove("account", G(1), { admin: true });
  assert.equal(defaulted.state.tables.contact.find((row) => row.contactid === G(11)).parentcustomerid, null);
  assert.equal(defaulted.cascadeDiagnostics()[0].code, "CASCADE_DELETE_DEFAULTED");
});

test("a Restrict delete answers 405 CDSError with CannotDeleteDueToAssociation", async (t) => {
  const { json, rows } = await start(t, { state: fixture({ cascadeDelete: "Restrict" }) });
  const response = await json(`/_api/accounts(${G(1)})`, { method: "DELETE" });
  assert.equal(response.status, 405);
  assert.equal(response.body.error.code, "9004010D");
  assert.equal(response.body.error.innererror.code, "0x80040227");
  assert.equal(rows("account").length, 1);
});

test("numeric writes stay inside Edm.Int32 and the column's MinValue/MaxValue", async (t) => {
  const { json, rows } = await start(t);
  const cases = [
    [{ employees: 2147483648 }, "0x80048d19"],
    [{ employees: 501 }, "0x8004432f"],
    [{ employees: -1 }, "0x8004432f"],
    [{ revenue: -0.01 }, "0x80044330"],
    [{ revenue: 1000000.01 }, "0x80044330"],
  ];
  for (const [body, innerCode] of cases) {
    const response = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, "9004010D");
    assert.equal(response.body.error.innererror.code, innerCode, JSON.stringify(body));
  }
  assert.equal(rows("account")[0].employees, undefined, "nothing was written");
  assert.equal((await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { employees: 500, revenue: 1000000 } })).status, 204);
});

test("choice writes use the exported options and a status reason of the record's status", async (t) => {
  const { json, rows } = await start(t);
  const option = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { industrycode: 3 } });
  assert.equal(option.status, 400);
  assert.equal(option.body.error.innererror.code, "0x8004431a");
  const mismatch = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { statecode: 1, statuscode: 1 } });
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.body.error.innererror.code, "0x80048408");
  const created = await json("/_api/accounts", { method: "POST", body: { name: "Inactive", statecode: 0, statuscode: 2 } });
  assert.equal(created.status, 400, "a create checks the combination too");
  // A status alone takes its default reason; a valid pair saves.
  assert.equal((await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { statecode: 1 } })).status, 204);
  assert.equal(rows("account")[0].statuscode, 2);
  assert.equal((await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { statecode: 0, statuscode: 1, industrycode: 2 } })).status, 204);
});
