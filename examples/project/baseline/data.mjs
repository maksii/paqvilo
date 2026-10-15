#!/usr/bin/env node
// Baseline fixture data: one invented dataset with stable GUIDs (2 parents + 1 deactivated, 14 items (item3, item9–item11 deactivated), 4 children + 1 deactivated), usable three ways —
//   1. `reset` against the live environment (upsert every fixture row, delete every other row of
//      the fixture tables, restore mutable values) so captures start from a known state;
//   2. `mirageTables(testerContactId)` for the Mirage data pack (same rows, Mirage record shape);
//   3. `catalogue(testerContactId)` in the toolkit data-catalogue shape for compare/query tooling.
//
//   node examples/project/baseline/data.mjs reset --connection FILE [--apply] [--tester <contactid>]
//
// The tester contact is the signed-in portal contact of the reference site (org-specific, passed
// in) or the synthetic Mirage contact; nothing here names a real person.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { guid } from "./generate.mjs";

const PREFIX = "pqvd";
const p = (name) => `${PREFIX}_${name}`;
export const ITEM = p("baselineitem");
export const PARENT = p("baselineparent");
export const CHILD = p("baselinechild");
export const TESTER_CONTACT = guid("contact:tester");
export const OTHER_CONTACT = guid("contact:other");
export const ACCOUNT = guid("account:baseline");
export const CURRENCY = "a4300000-0000-4000-8000-000000000001"; // the demo's EUR currency record
export const ids = {
  parent1: guid("parent:1"), parent2: guid("parent:2"), parent3: guid("parent:3"),
  item1: guid("item:1"), item2: guid("item:2"), item3: guid("item:3"), item4: guid("item:4"), item5: guid("item:5"), item6: guid("item:6"), item7: guid("item:7"), item8: guid("item:8"), item9: guid("item:9"), item10: guid("item:10"), item11: guid("item:11"), item12: guid("item:12"), item13: guid("item:13"), item14: guid("item:14"),
  child1: guid("child:1"), child2: guid("child:2"), child3: guid("child:3"), child4: guid("child:4"), child5: guid("child:5"),
  note1: guid("note:1"), note2: guid("note:2"),
  account: ACCOUNT, tester: TESTER_CONTACT, other: OTHER_CONTACT,
};
const BRIEF = Buffer.from("Baseline fixture attachment.\nThis file is invented test data.\n", "utf8");

const item = (key, name, code, extra = {}) => ({ key, id: ids[key], table: ITEM, ...(extra.computed ? { computed: extra.computed } : {}), fields: { [p("name")]: name, [p("code")]: code, [p("required")]: "required value", statecode: 0, statuscode: 1, ...extra.fields }, refs: { [p("parentid")]: "parent1", ...(extra.refs ?? {}) } });

/** Fixture rows in dependency order. `tester` is the signed-in contact of the side being reset. */
export function records(tester = TESTER_CONTACT) {
  const rows = [
    { key: "account", id: ids.account, table: "account", fields: { name: "Baseline Account", accountnumber: "BL-ACC-1", telephone1: "+1 555 0199" }, refs: {} },
    { key: "other", id: ids.other, table: "contact", fields: { firstname: "Baseline", lastname: "Other Contact", emailaddress1: "baseline.other@example.invalid" }, refs: {} },
    { key: "parent1", id: ids.parent1, table: PARENT, fields: { [p("name")]: "Baseline Parent One", [p("code")]: "P-001", [p("rank")]: 1, [p("description")]: "First invented parent.", [p("summary")]: "Parent one summary" }, refs: {} },
    { key: "parent2", id: ids.parent2, table: PARENT, fields: { [p("name")]: "Baseline Parent Two", [p("code")]: "P-002", [p("rank")]: 2, [p("description")]: "Second invented parent.", [p("summary")]: "Parent two summary" }, refs: {} },
    // Deactivated parent and child: the inactive-record states of the parent and child edit forms.
    { key: "parent3", id: ids.parent3, table: PARENT, fields: { [p("name")]: "Baseline Parent Three", [p("code")]: "P-003", [p("rank")]: 3, [p("description")]: "Deactivated invented parent.", statecode: 1, statuscode: 2 }, refs: {} },
    item("item1", "Baseline Item Alpha", "I-001", {
      fields: {
        [p("text")]: "alpha text", [p("textarea")]: "line one\nline two", [p("email")]: "alpha@example.invalid", [p("url")]: "https://example.invalid/alpha", [p("phone")]: "+1 555 0100", [p("ticker")]: "ALP",
        [p("richtext")]: "<p>Rich <strong>text</strong> value</p>", [p("memo")]: "Memo paragraph one.\n\nMemo paragraph two.",
        [p("wholenumber")]: 42, [p("duration")]: 90, [p("timezone")]: 85, [p("language")]: 1033, [p("decimal")]: 12.34, [p("float")]: 1.5, [p("amount")]: 199.99, [p("bigint")]: 9007199254740993,
        [p("datetime")]: "2026-03-04T10:30:00Z", [p("dateonly")]: "2026-03-05", [p("datetimetzi")]: "2026-03-06T08:00:00Z", [p("dateonlyuserlocal")]: "2026-03-07T00:00:00Z",
        [p("localchoice")]: 2, [p("globalchoice")]: 18327002, [p("multichoice")]: "18327010,18327012", [p("flag")]: true, [p("flagcheckbox")]: true,
        [p("recommended")]: "recommended value", [p("readonly")]: "read only value", [p("hidden")]: "hidden value", [p("nolabel")]: "no label value", [p("wide")]: "wide value", [p("relabelled")]: "relabelled value",
        [p("hiddenbyrule")]: "hidden by rule value", [p("lockedbyrule")]: "locked by rule value", [p("requiredbyrule")]: "required by rule value", [p("defaultbyrule")]: "existing value", [p("setbyrule")]: "set by rule" /* the live entity-scope rule writes it on the reset's update */, [p("ruleerror")]: 10,
        [p("secret")]: "secret value", [p("notupdatable")]: "fixed at create", [p("defaulted")]: 7,
      },
      refs: { [p("contactid")]: "tester", [p("accountid")]: "account", [p("customerid")]: "account", [p("anyid")]: "parent2" },
      // Values Dataverse computes on the live row, which the reset cannot write: the file column the reset uploads (BRIEF) and
      // the formula column Concatenate(name, " / ", code). Mirage rows only.
      // ponytail: stopgap formula value; a formula evaluator in core (FormulaDefinitionFileName) replaces it.
      computed: { [p("file")]: guid("file:item1"), [p("file_name")]: "baseline-brief.txt", [p("formula")]: "Baseline Item Alpha / I-001" },
    }),
    item("item2", "Baseline Item Beta", "I-002", { fields: { [p("flag")]: false, [p("wholenumber")]: 7, [p("globalchoice")]: 18327000, [p("datetime")]: "2026-01-15T09:00:00Z" } }),
    item("item3", "Baseline Item Gamma", "I-003", { fields: { statecode: 1, statuscode: 2, [p("wholenumber")]: 3 }, refs: { [p("parentid")]: "parent2" } }),
    item("item4", "Baseline Item Delta", "I-004", { fields: { [p("ruleerror")]: 0, [p("wholenumber")]: 400, [p("globalchoice")]: 18327001 }, refs: { [p("parentid")]: "parent2", [p("contactid")]: "other" } }),
    // item5 belongs to the fixture account but not to the tester contact: it tells the account-scope persona from the contact-scope one.
    item("item5", "Baseline Item Epsilon", "I-005", { fields: { [p("wholenumber")]: 50, [p("decimal")]: 5.5, [p("datetime")]: "2026-05-05T05:05:00Z" }, refs: { [p("accountid")]: "account" } }),
    item("item6", "Baseline Item Zeta", "I-006", { fields: { [p("wholenumber")]: 60, [p("decimal")]: 6.5 }, refs: { [p("parentid")]: "parent2" } }),
    item("item7", "Baseline Item Eta", "I-007", { fields: { [p("wholenumber")]: 70, [p("multichoice")]: "18327011" } }),
    // item8: flag false satisfies the hide-by-flag rule's condition, so its hidden-by-rule value shows what the live form does with the rule.
    item("item8", "Baseline Item Theta", "I-008", { fields: { [p("wholenumber")]: 80, [p("flag")]: false, [p("dateonly")]: "2026-08-08", [p("hiddenbyrule")]: "hidden when flag is false" }, refs: { [p("parentid")]: "parent2", [p("contactid")]: "other" } }),
    // item9–item11: deactivated rows reserved for the form action scenarios (one per actions variant); a scenario activates
    // and deactivates its own row, so the portal's record cache never leaks a state change into another capture and the
    // active views stay unchanged.
    item("item9", "Baseline Item Iota", "I-009", { fields: { statecode: 1, statuscode: 2, [p("wholenumber")]: 90 } }),
    item("item10", "Baseline Item Kappa", "I-010", { fields: { statecode: 1, statuscode: 2, [p("wholenumber")]: 100 } }),
    // item11 has no parent: the parent-scope role (items through their parent) is denied it while the reader reads it (persona probe).
    item("item11", "Baseline Item Lambda", "I-011", { fields: { statecode: 1, statuscode: 2, [p("wholenumber")]: 110 }, refs: { [p("parentid")]: null } }),
    // item12–item14: active rows of the tester contact and the fixture account, so the contact-filtered list (item-list-mine)
    // and the account-filtered list (item-list-options, account-scope persona) show at least four rows each. Name order
    // (Mu, Nu, Omega) differs from code order (I-012 Omega, I-013 Mu, I-014 Nu), so a sort by code visibly reorders them.
    // No parent (the helper defaults to parent1), date or coordinates: parent subgrids, calendars and maps keep their rows.
    item("item12", "Baseline Item Omega", "I-012", { fields: { [p("wholenumber")]: 120 }, refs: { [p("parentid")]: null, [p("contactid")]: "tester", [p("accountid")]: "account" } }),
    item("item13", "Baseline Item Mu", "I-013", { fields: { [p("wholenumber")]: 130 }, refs: { [p("parentid")]: null, [p("contactid")]: "tester", [p("accountid")]: "account" } }),
    item("item14", "Baseline Item Nu", "I-014", { fields: { [p("wholenumber")]: 140 }, refs: { [p("parentid")]: null, [p("contactid")]: "tester", [p("accountid")]: "account" } }),
    { key: "child1", id: ids.child1, table: CHILD, fields: { [p("name")]: "Child One", [p("sortorder")]: 1, [p("note")]: "First child." }, refs: { [p("itemid")]: "item1" } },
    { key: "child2", id: ids.child2, table: CHILD, fields: { [p("name")]: "Child Two", [p("sortorder")]: 2, [p("note")]: "Second child." }, refs: { [p("itemid")]: "item1" } },
    { key: "child3", id: ids.child3, table: CHILD, fields: { [p("name")]: "Child Three", [p("sortorder")]: 3 }, refs: { [p("itemid")]: "item1" } },
    { key: "child4", id: ids.child4, table: CHILD, fields: { [p("name")]: "Child Four", [p("sortorder")]: 1 }, refs: { [p("itemid")]: "item2" } },
    { key: "child5", id: ids.child5, table: CHILD, fields: { [p("name")]: "Child Five", [p("sortorder")]: 5, [p("note")]: "Deactivated child.", statecode: 1, statuscode: 2 }, refs: { [p("itemid")]: "item1" } },
    // The portal shows only notes whose text starts with the site setting KnowledgeManagement/NotesFilter (`*WEB*` on the shared site, D8); portal-created notes carry it.
    { key: "note1", id: ids.note1, table: "annotation", fields: { subject: "Baseline note", notetext: "*WEB*A plain note on the alpha item." }, refs: { objectid: "item1" } },
    { key: "note2", id: ids.note2, table: "annotation", fields: { subject: "Baseline attachment", notetext: "*WEB*A note with a text attachment.", filename: "baseline-brief.txt", mimetype: "text/plain", documentbody: BRIEF.toString("base64"), isdocument: true }, refs: { objectid: "item1" } },
  ];
  const resolved = { tester: { id: tester, table: "contact" } };
  for (const row of rows) resolved[row.key] = { id: row.id, table: row.table };
  return { rows, resolved };
}

export const TABLES = [
  { name: "account", entitySet: "accounts", primaryId: "accountid", keys: [["accountnumber"]] },
  { name: "contact", entitySet: "contacts", primaryId: "contactid", keys: [] },
  { name: PARENT, entitySet: `${PARENT}s`, primaryId: `${PARENT}id`, keys: [[p("code")]] },
  { name: ITEM, entitySet: `${ITEM}s`, primaryId: `${ITEM}id`, keys: [[p("code")]] },
  { name: CHILD, entitySet: `${CHILD}s`, primaryId: `${CHILD}id`, keys: [] },
  { name: "annotation", entitySet: "annotations", primaryId: "annotationid", keys: [] },
];
const entitySet = (table) => TABLES.find((t) => t.name === table).entitySet;
/** Lookup navigation property names on the Web API for each fixture lookup. */
const NAVIGATION = {
  [p("parentid")]: { nav: `${p("parentid")}`, set: `${PARENT}s` },
  [p("contactid")]: { nav: `${p("contactid")}`, set: "contacts" },
  [p("accountid")]: { nav: `${p("accountid")}`, set: "accounts" },
  [p("itemid")]: { nav: `${p("itemid")}`, set: `${ITEM}s` },
  [p("customerid")]: { nav: `${p("customerid")}_account`, set: "accounts" },
  [p("anyid")]: { nav: `${p("anyid")}_${PARENT}`, set: `${PARENT}s` },
  objectid: { nav: `objectid_${ITEM}`, set: `${ITEM}s` },
};

/** Toolkit data-catalogue shape (schemaVersion 1). */
export function catalogue(tester = TESTER_CONTACT) {
  const { rows } = records(tester);
  return {
    schemaVersion: 1,
    datasetId: "paqvilo-baseline",
    version: "1.0.0",
    clock: "2026-10-01T00:00:00Z",
    tables: TABLES,
    records: rows.map((row) => ({ key: row.key, id: row.id, table: row.table, fields: row.fields, refs: Object.fromEntries(Object.entries(row.refs).map(([field, key]) => [field, key === "tester" ? null : key])), deferredRefs: [] })),
    associations: [],
    queries: [],
  };
}

/** Mirage record shape: lookups are { id, logical_name, name } objects. */
export function mirageTables(tester = TESTER_CONTACT) {
  const { rows, resolved } = records(tester);
  const nameOf = (key) => rows.find((row) => row.key === key)?.fields[p("name")] ?? rows.find((row) => row.key === key)?.fields.name ?? (key === "tester" ? "Baseline Tester" : key);
  const tables = {};
  for (const row of rows) {
    const primary = TABLES.find((t) => t.name === row.table).primaryId;
    const record = { [primary]: row.id, ...row.fields, ...row.computed };
    if (row.table === ITEM) record.transactioncurrencyid = { id: CURRENCY, logical_name: "transactioncurrency", name: "Euro" };
    for (const [field, key] of Object.entries(row.refs)) record[field] = key ? { id: resolved[key].id, logical_name: resolved[key].table, name: nameOf(key) } : null;
    (tables[row.table] ??= []).push(record);
  }
  tables.contact = [
    { contactid: tester, firstname: "Baseline", lastname: "Tester", fullname: "Baseline Tester", emailaddress1: "baseline.tester@example.invalid", statecode: 0, statuscode: 1, parentcustomerid: { id: ids.account, logical_name: "account", name: "Baseline Account" } },
    ...(tables.contact ?? []).map((row) => ({ ...row, fullname: `${row.firstname} ${row.lastname}` })),
  ];
  tables.transactioncurrency = [{ transactioncurrencyid: CURRENCY, currencyname: "Euro", isocurrencycode: "EUR", currencysymbol: "€", exchangerate: 1, currencyprecision: 2, statecode: 0 }];
  return tables;
}

/** Live reset: upsert every fixture row, remove every other row of the three fixture tables. */
export async function resetLive(client, { apply = false, tester, log = () => {} }) {
  if (!tester) throw new Error("The live tester contact id is required (--tester).");
  const { rows, resolved } = records(tester);
  const summary = { deleted: [], upserted: [], files: [] };
  const fixtureIds = new Set(rows.map((row) => row.id.toLowerCase()));
  for (const table of [CHILD, ITEM, PARENT]) {
    const set = entitySet(table);
    const existing = await client.list(`${set}?$select=${table}id`);
    for (const row of existing) {
      const id = String(row[`${table}id`]).toLowerCase();
      if (fixtureIds.has(id)) continue;
      summary.deleted.push({ table, id });
      if (apply) await client.request(`${set}(${id})`, { method: "DELETE" });
    }
  }
  const notes = await client.list(`annotations?$select=annotationid&$filter=objecttypecode eq '${ITEM}'`).catch(() => []);
  for (const note of notes) if (!fixtureIds.has(String(note.annotationid).toLowerCase())) {
    summary.deleted.push({ table: "annotation", id: note.annotationid });
    if (apply) await client.request(`annotations(${note.annotationid})`, { method: "DELETE" });
  }
  for (const row of rows) {
    const body = { ...row.fields };
    for (const [field, key] of Object.entries(row.refs)) {
      const navigation = NAVIGATION[field];
      if (!navigation) throw new Error(`No navigation property for ${field}`);
      body[`${navigation.nav}@odata.bind`] = key ? `/${navigation.set}(${resolved[key].id})` : null;
    }
    if (row.table === ITEM) body["transactioncurrencyid@odata.bind"] = `/transactioncurrencies(${CURRENCY})`;
    const { statecode, statuscode, ...rest } = body;
    summary.upserted.push({ table: row.table, id: row.id });
    if (apply) {
      await client.request(`${entitySet(row.table)}(${row.id})`, { method: "PATCH", body: rest });
      if (statecode !== undefined) await client.request(`${entitySet(row.table)}(${row.id})`, { method: "PATCH", body: { statecode, statuscode } });
    }
    log({ reset: row.key, table: row.table });
  }
  // File column data on the alpha item (the Web API uploads single-request files with PATCH).
  summary.files.push({ item: ids.item1, column: p("file") });
  if (apply) {
    const response = await client.fetch(client.url(`${entitySet(ITEM)}(${ids.item1})/${p("file")}`), { method: "PATCH", headers: { Authorization: `Bearer ${await client.token()}`, "Content-Type": "application/octet-stream", "x-ms-file-name": "baseline-brief.txt" }, body: BRIEF });
    if (!response.ok) throw new Error(`File upload failed (HTTP ${response.status})`);
  }
  return summary;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { connection: { type: "string" }, apply: { type: "boolean" }, tester: { type: "string" }, out: { type: "string" } } });
  const action = positionals[0];
  if (action === "catalogue") {
    const out = values.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "catalogue.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(catalogue(), null, 2) + "\n");
    console.log(JSON.stringify({ catalogue: out, records: catalogue().records.length }));
    return;
  }
  if (action !== "reset") throw new Error("Usage: data.mjs reset --connection FILE [--apply] --tester <contactid> | data.mjs catalogue [--out FILE]");
  if (!values.connection) throw new Error("--connection is required");
  const { loadConnection, connectedClient } = await import("../../../lense/dataverse/index.mjs");
  const info = await loadConnection(values.connection);
  const client = connectedClient(info);
  await client.verify(info.organisationId);
  const summary = await resetLive(client, { apply: Boolean(values.apply), tester: values.tester, log: (entry) => console.log(JSON.stringify(entry)) });
  console.log(JSON.stringify({ apply: Boolean(values.apply), deleted: summary.deleted.length, upserted: summary.upserted.length, files: summary.files.length }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
