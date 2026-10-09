// FetchXML column validation, bounded joins with early limits, and the inventory's
// capability table derived from the evaluator.
import test from "node:test";
import assert from "node:assert/strict";
import { DataStore } from "../lib/data.mjs";
import { FETCH_UNSUPPORTED_ATTRIBUTES, parseXmlDocument, planFetch } from "../lib/fetchxml-engine.mjs";
import { supportOf } from "../webapi-inventory.mjs";

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
function store({ complete = true, accounts = 2, contactsPerAccount = 2, settings = {} } = {}) {
  const tables = { account: [], contact: [] };
  for (let a = 0; a < accounts; a++) {
    tables.account.push({ accountid: G(a + 1), name: `Account ${String(a).padStart(4, "0")}` });
    for (let c = 0; c < contactsPerAccount; c++)
      tables.contact.push({
        contactid: G(100000 + a * contactsPerAccount + c),
        fullname: `Contact ${a}-${c}`,
        parentcustomerid: { id: G(a + 1), logical_name: "account", name: "" },
      });
  }
  return new DataStore({
    state: {
      mappings: {
        account: {
          entitySet: "accounts",
          idColumn: "accountid",
          nameColumn: "name",
          ...(complete ? { schemaComplete: true, fieldMetadata: { accountid: { dataverseType: "uniqueidentifier" }, name: { dataverseType: "nvarchar" }, statecode: { dataverseType: "state", options: [{ value: 0, label: "Active" }] } } } : {}),
          relationships: { contact_customer_accounts: { entity: "contact", from: "accountid", to: "parentcustomerid", many: true } },
        },
        contact: {
          entitySet: "contacts",
          idColumn: "contactid",
          nameColumn: "fullname",
          ...(complete ? { schemaComplete: true, fieldMetadata: { contactid: { dataverseType: "uniqueidentifier" }, fullname: { dataverseType: "nvarchar" }, parentcustomerid: { dataverseType: "lookup" } } } : {}),
          relationships: { parentcustomerid: { entity: "account", from: "parentcustomerid", to: "accountid", many: false } },
        },
      },
      tables,
      settings: { permissionMode: "permissive", ...settings },
    },
  });
}
const linked = (inner) =>
  `<fetch><entity name="account"><attribute name="name"/>${inner}</entity></fetch>`;

test("strict column validation rejects columns complete metadata lacks, in every position", () => {
  const complete = store({ settings: { fetchColumnValidation: "strict" } });
  const queries = [
    ['<fetch><entity name="account"><attribute name="nosuch"/></entity></fetch>', "attribute"],
    [linked('<filter><condition attribute="nosuch" operator="eq" value="x"/></filter>'), "condition"],
    [linked('<order attribute="nosuch"/>'), "order"],
    [linked('<link-entity name="contact" from="nosuch" to="accountid"><attribute name="fullname"/></link-entity>'), "join"],
    [linked('<link-entity name="contact" from="parentcustomerid" to="nosuch"><attribute name="fullname"/></link-entity>'), "join"],
  ];
  for (const [xml, use] of queries)
    assert.throws(
      () => complete.fetchXml(xml, { admin: true }),
      (error) => error.status === 400 && error.details.innerCode === "0x80041103" && error.details.use === use && error.details.attribute === "nosuch",
      use,
    );
  // Known columns run normally.
  const ok = complete.fetchXml(linked('<link-entity name="contact" from="parentcustomerid" to="accountid" alias="c"><attribute name="fullname"/></link-entity>'), { admin: true });
  assert.equal(ok.entities.length, 4);
});

test("by default unknown columns of complete metadata are diagnostics; virtual name columns are known", () => {
  // Regression: live pages select statecodename, lookup name columns and environment
  // columns that no exported Solution defines.
  const complete = store();
  const unknown = complete.fetchXml('<fetch><entity name="account"><attribute name="name"/><attribute name="environmentonly"/></entity></fetch>', { admin: true });
  assert.equal(unknown.entities.length, 2);
  assert.deepEqual(unknown.diagnostics.map(({ code, attribute }) => [code, attribute]), [["FETCHXML_COLUMN_UNKNOWN", "environmentonly"]]);
  const strict = store({ settings: { fetchColumnValidation: "strict" } });
  const virtual = strict.fetchXml(
    '<fetch><entity name="contact"><attribute name="fullname"/><attribute name="parentcustomeridname"/><link-entity name="account" from="accountid" to="parentcustomerid" alias="a"><attribute name="statecodename"/></link-entity></entity></fetch>',
    { admin: true },
  );
  assert.equal(virtual.entities.length, 4);
  assert.deepEqual(virtual.diagnostics, []);
});

test("FetchXML records unverified columns of tables whose metadata isn't complete", () => {
  const partial = store({ complete: false });
  const result = partial.fetchXml(linked('<filter><condition attribute="nosuch" operator="null"/></filter>'), { admin: true });
  assert.equal(result.entities.length, 2, "the query runs");
  assert.deepEqual(
    result.diagnostics.map(({ code, entity, attribute, use }) => ({ code, entity, attribute, use })),
    [{ code: "FETCHXML_COLUMN_UNVERIFIED", entity: "account", attribute: "nosuch", use: "condition" }],
  );
  // A column a stored row has is known.
  assert.deepEqual(partial.fetchXml(linked(""), { admin: true }).diagnostics, []);
});

test("rowaggregate: the inventory reports what the evaluator rejects, from the same table", () => {
  const reason = FETCH_UNSUPPORTED_ATTRIBUTES.attribute.rowaggregate;
  assert.deepEqual(supportOf("fetchxml.attribute.attribute@rowaggregate"), { supported: false, note: reason });
  assert.throws(
    () => planFetch(parseXmlDocument('<fetch><entity name="account"><attribute name="name" rowaggregate="CountChildren"/></entity></fetch>', { root: "fetch" })),
    (error) => error.message === reason,
  );
  assert.equal(supportOf("fetchxml.attribute.attribute@alias").supported, true);
});

const JOIN = '<link-entity name="contact" from="parentcustomerid" to="accountid" alias="c"><attribute name="fullname"/></link-entity>';

test("joins stop early when the order allows it; the work stays bounded (performance)", () => {
  // 2,000 accounts with 50 contacts each: a full join is 100,000 rows.
  const big = store({ complete: false, accounts: 2000, contactsPerAccount: 50 });
  const started = performance.now();
  const top = big.fetchXml(`<fetch top="5"><entity name="account"><attribute name="name"/><order attribute="name"/>${JOIN}</entity></fetch>`, { admin: true });
  const elapsed = performance.now() - started;
  assert.deepEqual(top.entities.map((row) => [row.name, row["c.fullname"]]), [0, 1, 2, 3, 4].map((c) => ["Account 0000", `Contact 0-${c}`]));
  assert.equal(top.stats.earlyLimit, 5);
  assert.equal(top.stats.joinedRows, 50, "only the first account was joined");
  assert.ok(elapsed < 2000, `top 5 of a 100,000-row join took ${Math.round(elapsed)} ms`);
  // A later page needs the rows up to its end plus one to know whether more exist
  // (Liquid requests the total by default; this query declines it).
  const page = big.fetchXml(`<fetch count="10" page="3" returntotalrecordcount="false"><entity name="account"><attribute name="name"/><order attribute="name" descending="true"/>${JOIN}</entity></fetch>`, { admin: true });
  assert.equal(page.entities.length, 10);
  assert.equal(page.entities[0].name, "Account 1999");
  assert.equal(page.more_records, true);
  assert.equal(page.stats.joinedRows, 50);
  // The Web API profile requests no total unless asked.
  const api = big.fetchXml(`<fetch count="10" page="3"><entity name="account"><attribute name="name"/><order attribute="name"/>${JOIN}</entity></fetch>`, { admin: true }, { profile: "webapi" });
  assert.equal(api.stats.joinedRows, 50);
  // A requested total joins only up to the 5,000-row count limit plus one.
  const counted = big.fetchXml(`<fetch count="10" returntotalrecordcount="true"><entity name="account"><attribute name="name"/>${JOIN}</entity></fetch>`, { admin: true });
  assert.equal(counted.total_record_count, 5000);
  assert.equal(counted.total_record_count_limit_exceeded, true);
  assert.ok(counted.stats.joinedRows <= 5050, `joined ${counted.stats.joinedRows} rows`);
});

test("early limits return the same rows as a full join", () => {
  const small = store({ complete: false, accounts: 30, contactsPerAccount: 3 });
  const early = small.fetchXml(`<fetch count="7" page="4"><entity name="account"><attribute name="name"/><order attribute="name"/>${JOIN}</entity></fetch>`, { admin: true });
  // Ordering by a linked column needs every joined row first (no early limit).
  const full = small.fetchXml(`<fetch><entity name="account"><attribute name="name"/><order attribute="name"/><link-entity name="contact" from="parentcustomerid" to="accountid" alias="c"><attribute name="fullname"/><order attribute="contactid"/></link-entity></entity></fetch>`, { admin: true });
  assert.equal(full.stats.earlyLimit, null);
  const byPage = full.entities.slice(21, 28).map((row) => [row.name, row["c.fullname"]]);
  assert.deepEqual(early.entities.map((row) => [row.name, row["c.fullname"]]), byPage);
  assert.equal(early.more_records, true);
});

test("a join that would materialise more rows than the local bound fails instead of exhausting memory", () => {
  const bounded = store({ complete: false, accounts: 100, contactsPerAccount: 20, settings: { fetchJoinRowLimit: 1000 } });
  const xml = `<fetch><entity name="account"><attribute name="name"/><link-entity name="contact" from="parentcustomerid" to="accountid" alias="c"><attribute name="fullname"/><order attribute="fullname"/></link-entity></entity></fetch>`;
  assert.throws(() => bounded.fetchXml(xml, { admin: true }), (error) => error.code === "UnsupportedQuery" && error.details.limit === 1000);
});
