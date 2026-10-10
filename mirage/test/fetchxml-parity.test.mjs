// FetchXML semantics against documented Dataverse behaviour
// (learn.microsoft.com/power-apps/developer/data-platform/fetchxml/*).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataStore } from "../lib/data.mjs";
import { createPortalRenderer } from "../lib/liquid.mjs";
import { createSimulator } from "../server.mjs";

const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const DAY = 24 * 60 * 60 * 1000;
const isoDaysAgo = (days) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d+Z$/, "Z");

const fixture = () => ({
  mappings: {
    account: {
      entitySet: "accounts",
      idColumn: "accountid",
      nameColumn: "name",
      fields: {
        name: { dataverseType: "nvarchar", maxLength: 100 },
        revenue: { dataverseType: "money", precision: 2 },
        employees: { dataverseType: "int" },
        industrycode: {
          dataverseType: "picklist",
          options: [
            { value: 2, label: "Agriculture" },
            { value: 1, label: "Zoology" },
          ],
        },
        primarycontactid: { dataverseType: "lookup", targets: ["contact"] },
        ownerid: { dataverseType: "owner", targets: ["systemuser"] },
        createdon: { dataverseType: "datetime" },
      },
      relationships: {
        primarycontactid: { entity: "contact", from: "primarycontactid", to: "contactid", many: false },
        contact_customer_accounts: { entity: "contact", from: "accountid", to: "parentcustomerid", many: true },
        account_tags: {
          entity: "tag",
          from: "accountid",
          to: "tagid",
          many: true,
          intersect: { entity: "account_tag", from: "accountid", to: "tagid" },
        },
      },
    },
    contact: {
      entitySet: "contacts",
      idColumn: "contactid",
      nameColumn: "fullname",
      fields: {
        fullname: { dataverseType: "nvarchar" },
        parentcustomerid: { dataverseType: "customer", targets: ["account"] },
      },
      relationships: {
        parentcustomerid: { entity: "account", from: "parentcustomerid", to: "accountid", many: false },
      },
    },
    tag: { entitySet: "tags", idColumn: "tagid", nameColumn: "name" },
    account_tag: { entitySet: "account_tags", idColumn: "account_tagid" },
    systemuser: { entitySet: "systemusers", idColumn: "systemuserid", nameColumn: "fullname" },
  },
  tables: {
    account: [
      { accountid: G(1), name: "Contoso Ltd", revenue: 100, employees: 10, industrycode: 1, primarycontactid: { id: G(11), logical_name: "contact", name: "Ada" }, ownerid: { id: G(91), logical_name: "systemuser", name: "Portal app" }, createdon: isoDaysAgo(1) },
      { accountid: G(2), name: "contoso ltd (sample)", revenue: 50, employees: 5, industrycode: 2, primarycontactid: null, createdon: isoDaysAgo(3) },
      { accountid: G(3), name: "Café Noir", revenue: 25, employees: 3, industrycode: null, primarycontactid: { id: G(12), logical_name: "contact", name: "Bob" }, createdon: isoDaysAgo(10) },
      { accountid: G(4), name: "A_B Corp", revenue: 12.5, employees: 2, industrycode: 1, createdon: isoDaysAgo(40) },
      { accountid: G(5), name: "A[B] Corp", employees: 1, industrycode: 2, createdon: isoDaysAgo(400) },
      { accountid: G(6), name: "Fabrikam", revenue: 7, employees: 7, createdon: isoDaysAgo(2) },
    ],
    contact: [
      { contactid: G(11), fullname: "Ada", parentcustomerid: { id: G(1), logical_name: "account", name: "Contoso Ltd" } },
      { contactid: G(12), fullname: "Bob", parentcustomerid: { id: G(1), logical_name: "account", name: "Contoso Ltd" } },
      { contactid: G(13), fullname: "Cy", parentcustomerid: { id: G(3), logical_name: "account", name: "Café Noir" } },
      { contactid: G(14), fullname: "Dee" },
    ],
    tag: [
      { tagid: G(21), name: "Gold" },
      { tagid: G(22), name: "Silver" },
    ],
    account_tag: [
      { account_tagid: G(31), accountid: G(1), tagid: G(21) },
      { account_tagid: G(32), accountid: G(1), tagid: G(22) },
      { account_tagid: G(33), accountid: G(3), tagid: G(22) },
    ],
    systemuser: [{ systemuserid: G(91), fullname: "Portal app" }],
  },
  settings: { permissionMode: "permissive" },
});
const store = async (state = fixture()) => new DataStore({ state }).init();
const names = (result, column = "name") => result.entities.map((row) => row[column]);
const accounts = (filter, extra = "") =>
  `<fetch><entity name="account"><attribute name="name"/>${extra}<order attribute="name"/><filter>${filter}</filter></entity></fetch>`;

test("like wildcards ([], [^], _ and %) and comparisons use the case- and accent-insensitive collation", async () => {
  const s = await store();
  const run = (filter) => names(s.fetchXml(accounts(filter)));
  assert.deepEqual(run('<condition attribute="name" operator="like" value="contoso%"/>'), ["Contoso Ltd", "contoso ltd (sample)"]);
  assert.deepEqual(run('<condition attribute="name" operator="eq" value="CAFE NOIR"/>'), ["Café Noir"]);
  assert.deepEqual(run('<condition attribute="name" operator="like" value="A[_]B%"/>'), ["A_B Corp"]);
  assert.deepEqual(run('<condition attribute="name" operator="like" value="A_B%"/>'), ["A_B Corp", "A[B] Corp"]);
  assert.deepEqual(run('<condition attribute="name" operator="like" value="[CF]%"/>'), ["Café Noir", "Contoso Ltd", "contoso ltd (sample)", "Fabrikam"]);
  assert.deepEqual(run('<condition attribute="name" operator="like" value="[^C]%"/>'), ["A_B Corp", "A[B] Corp", "Fabrikam"]);
  assert.deepEqual(run('<condition attribute="name" operator="begins-with" value="CONT"/>'), ["Contoso Ltd", "contoso ltd (sample)"]);
  assert.deepEqual(run('<condition attribute="name" operator="ends-with" value="corp"/>'), ["A_B Corp", "A[B] Corp"]);
  assert.deepEqual(run('<condition attribute="name" operator="not-like" value="%o%"/>'), ["A_B Corp", "A[B] Corp", "Café Noir", "Fabrikam"].filter((name) => !/o/i.test(name)));
  assert.deepEqual(run('<condition attribute="name" operator="gt" value="contoso ltd"/>'), ["contoso ltd (sample)", "Fabrikam"]);
});

test("GUID values compare with or without braces and in/not-in take value lists", async () => {
  const s = await store();
  const run = (filter) => names(s.fetchXml(accounts(filter)));
  assert.deepEqual(run(`<condition attribute="accountid" operator="eq" value="{${G(1).toUpperCase()}}"/>`), ["Contoso Ltd"]);
  assert.deepEqual(
    run(`<condition attribute="accountid" operator="in"><value>{${G(1)}}</value><value>${G(3).toUpperCase()}</value></condition>`),
    ["Café Noir", "Contoso Ltd"],
  );
  assert.deepEqual(
    run(`<condition attribute="accountid" operator="not-in"><value>${G(1)}</value><value>${G(2)}</value><value>${G(3)}</value></condition>`),
    ["A_B Corp", "A[B] Corp", "Fabrikam"],
  );
  assert.deepEqual(
    run(`<condition attribute="primarycontactid" operator="eq" value="{${G(12)}}"/>`),
    ["Café Noir"],
  );
});

test("null and not-null apply to lookups and choices, and null columns are omitted from rows", async () => {
  const s = await store();
  const run = (filter) => names(s.fetchXml(accounts(filter)));
  assert.deepEqual(run('<condition attribute="primarycontactid" operator="null"/>'), ["A_B Corp", "A[B] Corp", "contoso ltd (sample)", "Fabrikam"]);
  assert.deepEqual(run('<condition attribute="industrycode" operator="not-null"/>'), ["A_B Corp", "A[B] Corp", "Contoso Ltd", "contoso ltd (sample)"]);
  const rows = s.fetchXml(
    `<fetch><entity name="account"><attribute name="name"/><attribute name="revenue"/><attribute name="industrycode"/><filter><condition attribute="accountid" operator="eq" value="${G(5)}"/></filter></entity></fetch>`,
  ).entities;
  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], "revenue"), false, "FetchXML results omit null columns");
  assert.equal(rows[0].accountid, G(5), "the primary key is returned with non-distinct rows");
  assert.throws(
    () => s.fetchXml(accounts('<condition attribute="name" operator="eq"/>')),
    (error) => error.status === 400,
  );
});

test("date operators evaluate whole days and relative ranges", async () => {
  const s = await store();
  const run = (filter) => names(s.fetchXml(accounts(filter))).sort();
  assert.deepEqual(run('<condition attribute="createdon" operator="last-x-days" value="5"/>'), ["Contoso Ltd", "contoso ltd (sample)", "Fabrikam"].sort());
  assert.deepEqual(run('<condition attribute="createdon" operator="olderthan-x-days" value="30"/>'), ["A_B Corp", "A[B] Corp"].sort());
  const day = isoDaysAgo(10).slice(0, 10);
  assert.deepEqual(run(`<condition attribute="createdon" operator="on" value="${day}"/>`), ["Café Noir"]);
  assert.deepEqual(run(`<condition attribute="createdon" operator="on-or-before" value="${day}"/>`), ["A_B Corp", "A[B] Corp", "Café Noir"].sort());
  const lastYear = new Date().getUTCFullYear() - 1;
  assert.deepEqual(
    run('<condition attribute="createdon" operator="last-year"/>'),
    fixture()
      .tables.account.filter((row) => new Date(row.createdon).getUTCFullYear() === lastYear)
      .map((row) => row.name)
      .sort(),
  );
});

test("distinct removes duplicate projections without adding the primary key", async () => {
  const s = await store();
  const result = s.fetchXml(
    '<fetch distinct="true"><entity name="contact"><attribute name="parentcustomerid"/><filter><condition attribute="parentcustomerid" operator="not-null"/></filter><link-entity name="account" from="accountid" to="parentcustomerid" alias="a"><attribute name="name"/></link-entity></entity></fetch>',
  );
  assert.deepEqual(result.entities.map((row) => row["a.name"]).sort(), ["Café Noir", "Contoso Ltd"]);
  for (const row of result.entities) assert.equal(Object.hasOwn(row, "contactid"), false);
  // An entity without attribute elements returns all of its columns, so the
  // rows stay distinct (select-columns: "If you do not specify columns ...").
  const allColumns = s.fetchXml(
    '<fetch distinct="true"><entity name="contact"><link-entity name="account" from="accountid" to="parentcustomerid" alias="a"><attribute name="name"/></link-entity></entity></fetch>',
  );
  assert.equal(allColumns.entities.length, 3);
});

test("document options no-lock, latematerialize, output-format, mapping, version and useraworderby are accepted", async () => {
  const s = await store();
  const plain = names(s.fetchXml(accounts('<condition attribute="employees" operator="ge" value="5"/>')));
  const decorated = names(
    s.fetchXml(
      '<fetch version="1.0" output-format="xml-platform" mapping="logical" no-lock="true" latematerialize="true" useraworderby="false"><entity name="account"><attribute name="name"/><order attribute="name"/><filter><condition attribute="employees" operator="ge" value="5"/></filter></entity></fetch>',
    ),
  );
  assert.deepEqual(decorated, plain);
});

test("visible, uitype, uiname and uihidden are accepted", async () => {
  const s = await store();
  const result = s.fetchXml(
    `<fetch><entity name="account"><attribute name="name"/><filter><condition attribute="primarycontactid" operator="eq" uitype="contact" uiname="Ada" uihidden="0" value="${G(11)}"/></filter><link-entity name="contact" from="contactid" to="primarycontactid" visible="false" link-type="outer"/></entity></fetch>`,
  );
  assert.deepEqual(names(result), ["Contoso Ltd"]);
});

test("top bounds the result and can't be combined with count, page or returntotalrecordcount", async () => {
  const s = await store();
  assert.equal(s.fetchXml('<fetch top="2"><entity name="account"><attribute name="name"/></entity></fetch>').entities.length, 2);
  for (const attribute of ['count="2"', 'page="1"', 'returntotalrecordcount="true"'])
    assert.throws(
      () => s.fetchXml(`<fetch top="2" ${attribute}><entity name="account"/></fetch>`),
      (error) => error.status === 400,
    );
});

test("aggregates name results by alias: count, countcolumn distinct, sum, avg, min, max and dategrouping", async () => {
  const s = await store();
  const result = s.fetchXml(
    '<fetch aggregate="true"><entity name="account"><attribute name="accountid" alias="n" aggregate="count"/><attribute name="industrycode" alias="industries" aggregate="countcolumn" distinct="true"/><attribute name="revenue" alias="total" aggregate="sum"/><attribute name="employees" alias="mean" aggregate="avg"/><attribute name="employees" alias="least" aggregate="min"/><attribute name="employees" alias="most" aggregate="max"/></entity></fetch>',
  );
  assert.equal(result.entities.length, 1);
  const row = result.entities[0];
  assert.equal(row.n, 6);
  assert.equal(row.industries, 2);
  assert.equal(row.total, 194.5);
  assert.equal(row.mean, 4, "avg of integers truncates like SQL (28 / 6)");
  assert.equal(row.least, 1);
  assert.equal(row.most, 10);
  const grouped = s.fetchXml(
    '<fetch aggregate="true"><entity name="account"><attribute name="industrycode" alias="industry" groupby="true"/><attribute name="accountid" alias="n" aggregate="count"/><order alias="industry"/></entity></fetch>',
  );
  // Choice columns order by label (order-rows), nulls first ascending:
  // null, Agriculture (2), Zoology (1).
  assert.deepEqual(
    grouped.entities.map((item) => [item.industry ?? null, item.n]),
    [[null, 2], [2, 2], [1, 2]],
  );
  const byYear = s.fetchXml(
    '<fetch aggregate="true"><entity name="account"><attribute name="createdon" alias="year" groupby="true" dategrouping="year"/><attribute name="accountid" alias="n" aggregate="count"/></entity></fetch>',
  );
  assert.ok(byYear.entities.every((item) => Number.isInteger(item.year) && item.n >= 1));
  assert.throws(
    () => s.fetchXml('<fetch aggregate="true"><entity name="account"><attribute name="accountid" aggregate="count"/></entity></fetch>'),
    (error) => error.status === 400,
    "aggregate attributes require an alias",
  );
});

test("link-entity joins: inner and outer types, generated aliases and N:N through the intersect table", async () => {
  const s = await store();
  const inner = s.fetchXml(
    '<fetch><entity name="contact"><attribute name="fullname"/><order attribute="fullname"/><link-entity name="account" from="accountid" to="parentcustomerid"><attribute name="name"/></link-entity></entity></fetch>',
  );
  assert.deepEqual(
    inner.entities.map((row) => [row.fullname, row["account1.name"]]),
    [["Ada", "Contoso Ltd"], ["Bob", "Contoso Ltd"], ["Cy", "Café Noir"]],
    "unaliased link columns are named {link name}{position}.{attribute}",
  );
  const outer = s.fetchXml(
    '<fetch><entity name="contact"><attribute name="fullname"/><order attribute="fullname"/><link-entity name="account" from="accountid" to="parentcustomerid" link-type="outer" alias="a"><attribute name="name"/></link-entity></entity></fetch>',
  );
  assert.deepEqual(outer.entities.map((row) => row.fullname), ["Ada", "Bob", "Cy", "Dee"]);
  assert.equal(Object.hasOwn(outer.entities[3], "a.name"), false);
  const many = s.fetchXml(
    `<fetch><entity name="tag"><attribute name="name"/><order attribute="name"/><link-entity name="account_tag" from="tagid" to="tagid" intersect="true"><link-entity name="account" from="accountid" to="accountid" alias="acct"><filter><condition attribute="accountid" operator="eq" value="${G(1)}"/></filter></link-entity></link-entity></entity></fetch>`,
  );
  assert.deepEqual(names(many), ["Gold", "Silver"]);
  const exists = s.fetchXml(
    '<fetch><entity name="account"><attribute name="name"/><order attribute="name"/><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="exists"/></entity></fetch>',
  );
  assert.deepEqual(names(exists), ["Café Noir", "Contoso Ltd"], "semi-joins return each parent once");
  const notAny = s.fetchXml(
    '<fetch><entity name="account"><attribute name="name"/><order attribute="name"/><filter><link-entity name="contact" from="parentcustomerid" to="accountid" link-type="not any"/></filter></entity></fetch>',
  );
  assert.deepEqual(names(notAny), ["A_B Corp", "A[B] Corp", "contoso ltd (sample)", "Fabrikam"]);
});

test("all-attributes returns every non-null column and attribute aliases rename columns", async () => {
  const s = await store();
  const all = s.fetchXml(
    `<fetch><entity name="account"><all-attributes/><filter><condition attribute="accountid" operator="eq" value="${G(4)}"/></filter></entity></fetch>`,
  ).entities[0];
  assert.deepEqual(Object.keys(all).sort(), ["accountid", "createdon", "employees", "industrycode", "name", "revenue"]);
  const aliased = s.fetchXml(
    `<fetch><entity name="account"><attribute name="name" alias="title"/><filter><condition attribute="accountid" operator="eq" value="${G(4)}"/></filter></entity></fetch>`,
  ).entities[0];
  assert.equal(aliased.title, "A_B Corp");
  assert.equal(Object.hasOwn(aliased, "name"), false);
});

test("an identical repeated attribute is selected once; conflicting aliases still fail", async () => {
  const s = await store();
  // Exported Sample templates (for example the ePI public details query) repeat
  // an attribute inside one link-entity and render on the live site.
  const repeated = s.fetchXml(
    '<fetch><entity name="contact"><attribute name="fullname"/><attribute name="fullname"/><order attribute="fullname"/><link-entity name="account" from="accountid" to="parentcustomerid" alias="a"><attribute name="name"/><attribute name="name"/></link-entity></entity></fetch>',
  );
  assert.deepEqual(
    repeated.entities.map((row) => [row.fullname, row["a.name"]]),
    [["Ada", "Contoso Ltd"], ["Bob", "Contoso Ltd"], ["Cy", "Café Noir"]],
  );
  assert.deepEqual(
    repeated.columns.columns.map((column) => column.key),
    ["fullname", "a.name"],
    "each repeated selection appears once",
  );
  for (const conflicting of [
    '<attribute name="fullname" alias="x"/><attribute name="contactid" alias="x"/>',
    '<attribute name="fullname"/><attribute name="contactid" alias="fullname"/>',
  ])
    assert.throws(
      () => s.fetchXml(`<fetch><entity name="contact">${conflicting}</entity></fetch>`),
      (error) => error.status === 400 && /not a unique alias/.test(error.message),
    );
});

test("ordering: choices by label, lookups by name, link-entity orders after entity orders", async () => {
  const s = await store();
  const byChoice = s.fetchXml(
    '<fetch><entity name="account"><attribute name="name"/><order attribute="industrycode"/><order attribute="name"/><filter><condition attribute="industrycode" operator="not-null"/></filter></entity></fetch>',
  );
  assert.deepEqual(names(byChoice), ["A[B] Corp", "contoso ltd (sample)", "A_B Corp", "Contoso Ltd"], "Agriculture (2) sorts before Zoology (1)");
  const raw = s.fetchXml(
    '<fetch useraworderby="true"><entity name="account"><attribute name="name"/><order attribute="industrycode"/><order attribute="name"/><filter><condition attribute="industrycode" operator="not-null"/></filter></entity></fetch>',
  );
  assert.deepEqual(names(raw), ["A_B Corp", "Contoso Ltd", "A[B] Corp", "contoso ltd (sample)"]);
  const byLookup = s.fetchXml(
    '<fetch><entity name="account"><attribute name="name"/><order attribute="primarycontactid" descending="true"/><filter><condition attribute="primarycontactid" operator="not-null"/></filter></entity></fetch>',
  );
  assert.deepEqual(names(byLookup), ["Café Noir", "Contoso Ltd"], "Bob sorts after Ada");
  const linked = s.fetchXml(
    '<fetch><entity name="contact"><attribute name="fullname"/><link-entity name="account" from="accountid" to="parentcustomerid" alias="a"><attribute name="name"/><order attribute="name"/></link-entity><order attribute="fullname" descending="true"/></entity></fetch>',
  );
  assert.deepEqual(linked.entities.map((row) => row.fullname), ["Cy", "Bob", "Ada"], "entity orders apply before link-entity orders");
});

test("nested filters and entityname conditions filter after an outer join", async () => {
  const s = await store();
  const nested = s.fetchXml(
    accounts(
      '<filter type="or"><condition attribute="industrycode" operator="eq" value="1"/><filter type="and"><condition attribute="employees" operator="lt" value="4"/><condition attribute="name" operator="like" value="%Noir"/></filter></filter>',
    ),
  );
  assert.deepEqual(names(nested), ["A_B Corp", "Café Noir", "Contoso Ltd"]);
  const orphan = s.fetchXml(
    '<fetch><entity name="contact"><attribute name="fullname"/><filter><condition entityname="a" attribute="accountid" operator="null"/></filter><link-entity name="account" from="accountid" to="parentcustomerid" link-type="outer" alias="a"/></entity></fetch>',
  );
  assert.deepEqual(names(orphan, "fullname"), ["Dee"]);
});

test("eq-userid matches the portal application user's systemuser id", async () => {
  const s = await store();
  const xml = '<fetch><entity name="account"><attribute name="name"/><filter><condition attribute="ownerid" operator="eq-userid"/></filter></entity></fetch>';
  assert.deepEqual(names(s.fetchXml(xml, { systemUserId: G(91) })), ["Contoso Ltd"]);
  assert.deepEqual(names(s.fetchXml(xml, {})), []);
  const negated = s.fetchXml(xml.replace("eq-userid", "ne-userid"), { systemUserId: G(91) });
  assert.equal(names(negated).includes("Contoso Ltd"), false);
});

test("returntotalrecordcount caps the total at 5000 and reports when the limit is exceeded", async () => {
  const state = fixture();
  state.tables.tag = Array.from({ length: 5003 }, (_, index) => ({ tagid: G(100000 + index), name: `Tag ${String(index).padStart(5, "0")}` }));
  const s = await store(state);
  const result = s.fetchXml('<fetch count="10" page="1" returntotalrecordcount="true"><entity name="tag"><attribute name="name"/></entity></fetch>');
  assert.equal(result.entities.length, 10);
  assert.equal(result.total_record_count, 5000);
  assert.equal(result.total_record_count_limit_exceeded, true);
  assert.equal(result.more_records, true);
  const small = s.fetchXml('<fetch returntotalrecordcount="true"><entity name="account"><attribute name="name"/></entity></fetch>');
  assert.equal(small.total_record_count, 6);
  assert.equal(small.total_record_count_limit_exceeded, false);
});

test("count/page paging cookies round-trip through Liquid and stay XML-attribute safe", async () => {
  const state = fixture();
  state.tables.tag = [`Q "1"`, "R & 2", "S <3>", "T 4", "U 5"].map((name, index) => ({ tagid: G(200 + index), name }));
  const s = await store(state);
  const renderer = createPortalRenderer(
    { templates: {}, snippets: {}, settings: {}, pages: [], webFiles: [], lists: [], entityForms: [], advancedForms: [] },
    { fetchXml: (xml) => s.fetchXml(xml) },
  );
  const page = (number, cookie) =>
    `{% fetchxml rows %}<fetch count="2" page="${number}"${cookie == null ? "" : ` paging-cookie="${cookie}"`}><entity name="tag"><attribute name="name"/><order attribute="name"/></entity></fetch>{% endfetchxml %}{% for row in rows.results.entities %}[{{ row.name }}]{% endfor %}|{{ rows.results.more_records }}|{{ rows.results.paging_cookie | escape }}`;
  const seen = [];
  let cookie = null;
  for (let number = 1; number <= 3; number++) {
    const output = await renderer.renderString(page(number, cookie));
    const [rows, more, nextCookie] = output.split("|");
    seen.push(...[...rows.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]));
    assert.equal(more, number < 3 ? "true" : "false");
    cookie = nextCookie;
    if (number < 3) assert.match(cookie, /^&lt;cookie page=&quot;\d+&quot;&gt;/);
  }
  assert.deepEqual(seen, [`Q "1"`, "R & 2", "S <3>", "T 4", "U 5"], "every row appears exactly once");
});

test("Web API FetchXML publishes the documented paging cookie wrapper and continuation", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-fetch-parity-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Fetch parity\n");
  await fs.writeFile(
    path.join(directory, "sitesetting.yml"),
    "- adx_name: Webapi/tag/enabled\n  adx_value: true\n- adx_name: Webapi/tag/fields\n  adx_value: tagid,name\n",
  );
  const state = fixture();
  state.tables.tag = ["Alpha", "Beta", "Gamma"].map((name, index) => ({ tagid: G(300 + index), name }));
  const app = await createSimulator({ sourceDir: directory, initial: state, watch: false });
  t.after(() => app.close());
  const read = async (cookie) => {
    const xml = `<fetch count="2" page="${cookie ? 2 : 1}"${cookie ? ` paging-cookie="${cookie.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}"` : ""}><entity name="tag"><attribute name="name"/><order attribute="name"/></entity></fetch>`;
    const response = await fetch(`${app.url}/_api/tags?fetchXml=${encodeURIComponent(xml)}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const first = await read();
  assert.deepEqual(first.value.map((row) => row.name), ["Alpha", "Beta"]);
  assert.equal(first["@Microsoft.Dynamics.CRM.morerecords"], true);
  const wrapper = first["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"];
  const match = /^<cookie pagenumber="2" pagingcookie="([^"]+)" istracking="False" \/>$/.exec(wrapper);
  assert.ok(match, wrapper);
  for (const escape of match[1].match(/%[0-9a-fA-F]{2}/g)) assert.equal(escape, escape.toLowerCase(), "escapes are lowercase");
  const inner = decodeURIComponent(decodeURIComponent(match[1]));
  assert.equal(
    inner,
    `<cookie page="1"><name last="Beta" first="Alpha" /><tagid last="{${G(301).toUpperCase()}}" first="{${G(300).toUpperCase()}}" /></cookie>`,
  );
  const second = await read(inner);
  assert.deepEqual(second.value.map((row) => row.name), ["Gamma"]);
  assert.equal(Object.hasOwn(second, "@Microsoft.Dynamics.CRM.morerecords"), false);
  assert.equal(Object.hasOwn(second, "@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"), false);
  assert.ok(second["@odata.context"].endsWith("/_api/$metadata#tags(tagid,name)"), second["@odata.context"]);
  assert.equal(second["@Microsoft.Dynamics.CRM.totalrecordcount"], -1);
});
