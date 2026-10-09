// Ecosystem review items (a)-(f) for the Dataverse and Web API runtime (agent B):
// docs/dataverse-parity.md ("Fiscal calendar", "Token failures", "Navigation binding",
// "Platform changes" and the decisions table) and docs/platform-internals-reference.md 7.9.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSimulator } from "../server.mjs";
import { webApiErrorResponse } from "../lib/webapi-handler.mjs";
import { DataError } from "../lib/data-error.mjs";
import { DataStore } from "../lib/data.mjs";
import { executeFetch, parseXmlDocument, planFetch } from "../lib/fetchxml-engine.mjs";
import {
  FISCAL_PERIOD_TYPES,
  fiscalCalendar,
  fiscalOperatorPredicate,
  fiscalPeriodBounds,
  fiscalPeriodOf,
  shiftFiscalPeriod,
} from "../lib/fiscal-calendar.mjs";
import { dateGroupValue, dateOperatorPredicate } from "../lib/dataverse-values.mjs";
import { accountWebRoleIds, platformChangeDiagnostics } from "../lib/platform-changes.mjs";
import { resolvePortalIdentity } from "../lib/permissions.mjs";
import { importPortal } from "../lib/importer.mjs";
import { serverLogicUnsupported } from "../lib/server-logic.mjs";
import { buildSolutionSchema, scanSolutionSources } from "../lib/solution-schema.mjs";

const mirage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const G = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const utc = (text) => Date.parse(`${text}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const settingsYaml = (settings) =>
  Object.entries(settings)
    .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${String(value).replace(/'/g, "''")}'`)
    .join("\n");
const SETTINGS = {
  "Webapi/account/enabled": "true",
  "Webapi/account/fields": "name,openedon,new_producttype,new_ProductType",
  "Webapi/contact/enabled": "true",
  "Webapi/contact/fields": "fullname,parentcustomerid,parentcustomerid_account",
  "Webapi/error/innererror": "true",
};
const fixture = (settings = {}) => ({
  mappings: {
    account: {
      entitySet: "accounts",
      idColumn: "accountid",
      nameColumn: "name",
      schemaComplete: true,
      fields: {
        name: { dataverseType: "nvarchar" },
        description: { dataverseType: "memo" },
        openedon: { dataverseType: "datetime" },
        new_producttype: { dataverseType: "lookup", targets: ["new_producttype"] },
      },
      // A custom lookup's navigation property is its schema name (new_ProductType).
      relationships: { new_ProductType: { entity: "new_producttype", from: "new_producttype", to: "new_producttypeid", many: false } },
    },
    new_producttype: { entitySet: "new_producttypes", idColumn: "new_producttypeid", nameColumn: "new_name" },
    contact: {
      entitySet: "contacts",
      idColumn: "contactid",
      nameColumn: "fullname",
      fields: { fullname: { dataverseType: "nvarchar" }, parentcustomerid: { dataverseType: "customer", targets: ["account"] } },
      relationships: { parentcustomerid_account: { entity: "account", from: "parentcustomerid", to: "accountid", many: false } },
    },
  },
  tables: {
    account: [
      { accountid: G(1), name: "Q1", openedon: "2025-07-01T00:00:00Z" },
      { accountid: G(2), name: "Q2 first day", openedon: "2025-10-01T00:00:00Z" },
      { accountid: G(3), name: "Q4", openedon: "2026-06-30T12:00:00Z" },
      { accountid: G(4), name: "Next year", openedon: "2026-07-01T00:00:00Z" },
    ],
    new_producttype: [{ new_producttypeid: G(21), new_name: "Medicinal" }],
    contact: [{ contactid: G(11), fullname: "Ada" }],
  },
  settings: { permissionMode: "permissive", ...settings },
  simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: G(11), roles: [] }, live: {}, endpoints: [] },
});

async function start(t, { settings = SETTINGS, state = fixture() } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-webapi-ecosystem-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_websiteid: site\nadx_name: Ecosystem\n");
  await fs.writeFile(path.join(directory, "sitesetting.yml"), settingsYaml(settings));
  const app = await createSimulator({ sourceDir: directory, initial: state, watch: false });
  t.after(() => app.close());
  const json = async (route, { method = "GET", body, headers = {}, token = true } = {}) => {
    const response = await fetch(app.url + route, {
      method,
      headers: {
        ...(token ? { __RequestVerificationToken: app.state().csrf } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  return { app, json };
}

// (a) Fiscal calendar: Sql4Cds' period model (MIT) with the documented corrections.
test("fiscal calendar follows the organisation start and period type, half-open and without drift", () => {
  const july = fiscalCalendar({ fiscalCalendarStart: "2025-07-01", fiscalPeriodType: 2002 });
  assert.deepEqual([july.startMonth, july.startDay, july.type, july.periods, july.name], [6, 1, 2002, 4, "quarterly"]);
  // A period's first day belongs to it (Sql4Cds counts it in the previous period).
  assert.deepEqual(fiscalPeriodOf(july, utc("2025-10-01")), { year: 2025, period: 2 });
  assert.deepEqual(fiscalPeriodOf(july, utc("2025-09-30")), { year: 2025, period: 1 });
  assert.deepEqual(fiscalPeriodOf(july, utc("2026-06-30")), { year: 2025, period: 4 });
  assert.deepEqual(fiscalPeriodOf(july, utc("2026-07-01")), { year: 2026, period: 1 });
  assert.deepEqual(fiscalPeriodBounds(july, 2025, 2).map(iso), ["2025-10-01", "2026-01-01"]);
  assert.equal(fiscalPeriodBounds(july, 2025, 5), null, "period 5 of a quarterly year is out of range");
  assert.deepEqual(shiftFiscalPeriod(july, { year: 2025, period: 1 }, -1), { year: 2024, period: 4 });
  assert.deepEqual(shiftFiscalPeriod(july, { year: 2025, period: 4 }, 1), { year: 2026, period: 1 });
  // Monthly from 31 January: each period starts on the 31st or the month's last day, no drift.
  const monthly = fiscalCalendar({ fiscalCalendarStart: "01-31", fiscalPeriodType: "monthly" });
  assert.deepEqual(fiscalPeriodBounds(monthly, 2026, 2).map(iso), ["2026-02-28", "2026-03-31"]);
  assert.deepEqual(fiscalPeriodBounds(monthly, 2026, 12).map(iso), ["2026-12-31", "2027-01-31"]);
  // 28-day periods: period 13 runs to the next start; a 29 February start is 28 February later.
  const weeks = fiscalCalendar({ fiscalCalendarStart: "2026-01-01", fiscalPeriodType: 2004 });
  assert.deepEqual(fiscalPeriodBounds(weeks, 2026, 13).map(iso), ["2026-12-03", "2027-01-01"]);
  assert.deepEqual(fiscalPeriodOf(weeks, utc("2026-12-31")), { year: 2026, period: 13 });
  const leap = fiscalCalendar({ fiscalCalendarStart: "2024-02-29", fiscalPeriodType: "annually" });
  assert.deepEqual(fiscalPeriodBounds(leap, 2026, 1).map(iso), ["2026-02-28", "2027-02-28"]);
  // Settings: the Sql4Cds FiscalPeriodType codes, their names or the earlier periods per year.
  assert.deepEqual(Object.values(FISCAL_PERIOD_TYPES).map((type) => type.periods), [1, 2, 4, 12, 13]);
  assert.equal(fiscalCalendar({ fiscalPeriodType: "semiannually" }).type, 2001);
  assert.equal(fiscalCalendar({ fiscalPeriodsPerYear: 12 }).type, 2003);
  assert.deepEqual([fiscalCalendar().type, fiscalCalendar().startMonth, fiscalCalendar().startDay], [2002, 0, 1]);
  for (const bad of [{ fiscalPeriodsPerYear: 3 }, { fiscalPeriodType: 1999 }, { fiscalCalendarStart: "2026-13-01" }])
    assert.throws(() => fiscalCalendar(bad), (error) => error.code === "InvalidFiscalCalendar");
});

test("fiscal operators: relative years from the current fiscal year, X periods as Sql4Cds, out-of-range periods match nothing", () => {
  const calendar = fiscalCalendar({ fiscalCalendarStart: "2025-07-01", fiscalPeriodType: 2002 });
  const window = (operator, values = [], now) => {
    const predicate = fiscalOperatorPredicate(operator, values, { now, calendar });
    return (dates) => dates.filter((date) => predicate(utc(date)));
  };
  const autumn = utc("2026-10-09"),
    spring = utc("2026-03-01");
  // next-fiscal-year once the fiscal year started this calendar year (Sql4Cds answers the
  // current one), last-fiscal-year before this calendar year's start (Sql4Cds: the current one).
  assert.deepEqual(window("next-fiscal-year", [], autumn)(["2026-07-01", "2027-07-01", "2028-06-30", "2028-07-01"]), ["2027-07-01", "2028-06-30"]);
  assert.deepEqual(window("last-fiscal-year", [], spring)(["2024-07-01", "2025-06-30", "2025-07-01"]), ["2024-07-01", "2025-06-30"]);
  assert.deepEqual(window("this-fiscal-year", [], spring)(["2025-06-30", "2025-07-01", "2026-06-30", "2026-07-01"]), ["2025-07-01", "2026-06-30"]);
  assert.deepEqual(window("this-fiscal-period", [], spring)(["2025-12-31", "2026-01-01", "2026-03-31", "2026-04-01"]), ["2026-01-01", "2026-03-31"]);
  assert.deepEqual(window("last-fiscal-period", [], spring)(["2025-09-30", "2025-10-01", "2025-12-31", "2026-01-01"]), ["2025-10-01", "2025-12-31"]);
  assert.deepEqual(window("next-fiscal-period", [], spring)(["2026-03-31", "2026-04-01", "2026-06-30", "2026-07-01"]), ["2026-04-01", "2026-06-30"]);
  // Sql4Cds: last X runs from the start of the period X before the current one up to now; next X
  // from now to the end of the period X after it.
  // Current period: Jan-Mar 2026 (FY2025 period 3); two before it starts on 1 July 2025.
  assert.deepEqual(window("last-x-fiscal-periods", ["2"], spring)(["2025-06-30", "2025-07-01", "2026-02-28", "2026-03-02"]), ["2025-07-01", "2026-02-28"]);
  assert.deepEqual(window("next-x-fiscal-periods", ["1"], spring)(["2026-02-28", "2026-03-02", "2026-06-30", "2026-07-01"]), ["2026-03-02", "2026-06-30"]);
  assert.deepEqual(window("last-x-fiscal-years", ["1"], spring)(["2024-06-30", "2024-07-01", "2026-02-28", "2026-03-02"]), ["2024-07-01", "2026-02-28"]);
  assert.deepEqual(window("next-x-fiscal-years", ["1"], spring)(["2026-02-28", "2026-03-02", "2027-06-30", "2027-07-01"]), ["2026-03-02", "2027-06-30"]);
  // Absolute operators: period, then year; a period outside the year matches nothing (Learn).
  assert.deepEqual(window("in-fiscal-year", ["2025"])(["2025-06-30", "2025-07-01", "2026-06-30", "2026-07-01"]), ["2025-07-01", "2026-06-30"]);
  assert.deepEqual(window("in-fiscal-period", ["2"])(["2025-10-01", "2025-12-31", "2026-11-15", "2026-01-01"]), ["2025-10-01", "2025-12-31", "2026-11-15"]);
  assert.deepEqual(window("in-fiscal-period", ["5"])(["2025-10-01"]), []);
  assert.deepEqual(window("in-fiscal-period-and-year", ["2", "2025"])(["2025-09-30", "2025-10-01", "2025-12-31", "2026-01-01"]), ["2025-10-01", "2025-12-31"]);
  assert.deepEqual(window("in-or-before-fiscal-period-and-year", ["1", "2026"])(["2026-09-30", "2026-10-01"]), ["2026-09-30"]);
  assert.deepEqual(window("in-or-after-fiscal-period-and-year", ["1", "2026"])(["2026-06-30", "2026-07-01"]), ["2026-07-01"]);
  assert.deepEqual(window("in-or-after-fiscal-period-and-year", ["9", "2026"])(["2030-01-01"]), []);
  assert.throws(() => fiscalOperatorPredicate("in-fiscal-year", ["x"], { calendar }), (error) => error.code === "InvalidQuery");
  // The shared date-operator entry point and the fiscal date groupings use the same calendar;
  // the earlier periods-per-year form keeps a 1 January year.
  assert.equal(dateOperatorPredicate("in-fiscal-period", ["3"], { fiscalPeriods: 4 })(utc("2026-07-15")), true);
  assert.equal(dateGroupValue("2025-10-01T00:00:00Z", "fiscal-period", { fiscal: calendar }), 2);
  assert.equal(dateGroupValue("2026-03-01T00:00:00Z", "fiscal-year", { fiscal: calendar }), 2025);
  assert.equal(dateGroupValue("2025-10-01T00:00:00Z", "quarter", { fiscal: calendar }), 4, "quarter stays the calendar quarter");
});

test("FetchXML, Web API query functions and fiscal groupings read the calendar from settings or the organization row", async (t) => {
  const { json } = await start(t, { state: fixture({ fiscalCalendarStart: "2025-07-01", fiscalPeriodType: "2002" }) });
  const names = (response) => response.body.value.map((row) => row.name);
  const filter = encodeURIComponent("Microsoft.Dynamics.CRM.InFiscalPeriodAndYear(PropertyName='openedon',PropertyValue1=2,PropertyValue2=2025)");
  const period = await json(`/_api/accounts?$select=name&$filter=${filter}`);
  assert.equal(period.status, 200);
  assert.deepEqual(names(period), ["Q2 first day"]);
  const fetchXml = encodeURIComponent('<fetch><entity name="account"><attribute name="name"/><filter><condition attribute="openedon" operator="in-fiscal-year" value="2025"/></filter><order attribute="name"/></entity></fetch>');
  assert.deepEqual(names(await json(`/_api/accounts?fetchXml=${fetchXml}`)), ["Q1", "Q2 first day", "Q4"]);
  // Without simulator settings a single organization row supplies FiscalCalendarStart and
  // FiscalPeriodType; explicit settings win over it.
  const state = fixture();
  state.tables.organization = [{ organizationid: G(90), fiscalcalendarstart: "2025-07-01T00:00:00Z", fiscalperiodtype: 2001 }];
  const store = new DataStore({ state });
  const query = (xml) => store.fetchXml(xml, { admin: true }).entities.map((row) => row.name);
  assert.deepEqual(query('<fetch><entity name="account"><attribute name="name"/><filter><condition attribute="openedon" operator="in-fiscal-period-and-year"><value>2</value><value>2025</value></condition></filter><order attribute="name"/></entity></fetch>'), ["Q4"]);
  const grouped = store.fetchXml('<fetch aggregate="true"><entity name="account"><attribute name="accountid" alias="count" aggregate="count"/><attribute name="openedon" alias="period" groupby="true" dategrouping="fiscal-period"/><attribute name="openedon" alias="year" groupby="true" dategrouping="fiscal-year"/><order alias="year"/><order alias="period"/></entity></fetch>', { admin: true });
  assert.deepEqual(grouped.entities.map((row) => [row.year, row.period, row.count]), [[2025, 1, 2], [2025, 2, 1], [2026, 1, 1]]);
  state.settings.fiscalPeriodType = 2002;
  state.settings.fiscalCalendarStart = "01-01";
  assert.deepEqual(new DataStore({ state }).fetchXml('<fetch><entity name="account"><attribute name="name"/><filter><condition attribute="openedon" operator="in-fiscal-period-and-year"><value>3</value><value>2025</value></condition></filter></entity></fetch>', { admin: true }).entities.map((row) => row.name), ["Q1"]);
});

// (a) filter@hint, Contains, EqualRoleBusinessId and 90040109.
test("filter hint union is accepted everywhere, never changes rows and reports its documented restrictions", async (t) => {
  const parse = (xml) => planFetch(parseXmlDocument(xml, { root: "fetch" }), { profile: "webapi" });
  const union = '<fetch><entity name="account"><attribute name="name"/><filter type="or" hint="union"><condition attribute="name" operator="eq" value="Q1"/><condition attribute="name" operator="eq" value="Q4"/></filter><order attribute="name"/></entity></fetch>';
  assert.deepEqual(parse(union).diagnostics, [], "the documented form is declared, also in the Web API profile");
  const store = new DataStore({ state: fixture() });
  const rows = (xml) => store.fetchXml(xml, { admin: true }, { profile: "webapi" }).entities.map((row) => row.name);
  assert.deepEqual(rows(union), rows(union.replace(' hint="union"', "")));
  assert.deepEqual(rows(union), ["Q1", "Q4"]);
  const codes = (xml) => parse(xml).diagnostics.map((diagnostic) => diagnostic.code);
  assert.deepEqual(codes('<fetch><entity name="account"><filter hint="union"><condition attribute="name" operator="null"/></filter></entity></fetch>'), ["FETCHXML_UNION_HINT_RESTRICTION"], "an and filter");
  assert.deepEqual(
    codes('<fetch><entity name="account"><filter type="or" hint="union"><filter type="or" hint="union"><condition attribute="name" operator="null"/></filter></filter></entity></fetch>'),
    ["FETCHXML_UNION_HINT_RESTRICTION"],
    "a second union hint",
  );
  assert.deepEqual(
    codes('<fetch><entity name="account"><filter><filter><filter><filter type="or" hint="union"><condition attribute="name" operator="null"/></filter></filter></filter></filter></entity></fetch>'),
    ["FETCHXML_UNION_HINT_IGNORED"],
    "four filter levels deep",
  );
  assert.deepEqual(codes('<fetch><entity name="account"><filter type="or" hint="loop"><condition attribute="name" operator="null"/></filter></entity></fetch>'), ["FETCHXML_FILTER_HINT_UNKNOWN"]);
  // Through the portals Web API.
  const { json } = await start(t);
  const response = await json(`/_api/accounts?fetchXml=${encodeURIComponent(union)}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.value.map((row) => row.name), ["Q1", "Q4"]);
  // The static inventory reads the same schema tables.
  const { supportOf } = await import("../webapi-inventory.mjs");
  assert.deepEqual(supportOf("fetchxml.attribute.filter@hint"), { supported: true, note: "accepted; does not change results" });
});

test("Contains answers Dataverse's full-text error and EqualRoleBusinessId is reported unsupported", async (t) => {
  const { json } = await start(t);
  const contains = await json(`/_api/accounts?$select=name&$filter=${encodeURIComponent("Microsoft.Dynamics.CRM.Contains(PropertyName='name',PropertyValue='Q')")}`);
  assert.equal(contains.status, 400);
  assert.deepEqual(contains.body.error, {
    code: "9004010D",
    message: "CDS error occurred.",
    innererror: { code: "0x80041120", message: "Unknown Condition Operator: Contains. FetchXml does not support it" },
  });
  assert.equal(contains.headers.get("x-sim-error-code"), "FullTextConditionUnsupported");
  // The column allow-list applies first, as for every query function.
  const hidden = await json(`/_api/accounts?$select=name&$filter=${encodeURIComponent("Microsoft.Dynamics.CRM.Contains(PropertyName='description',PropertyValue='Q')")}`);
  assert.deepEqual([hidden.status, hidden.body.error.code], [403, "90040101"]);
  const role = await json(`/_api/accounts?$select=name&$filter=${encodeURIComponent("Microsoft.Dynamics.CRM.EqualRoleBusinessId(PropertyName='name')")}`);
  assert.equal(role.status, 400);
  assert.equal(role.body.error.code, "9004010A");
  assert.equal(role.headers.get("x-sim-error-code"), "UnsupportedQuery");
  // The inventory reads the same table.
  const { supportOf } = await import("../webapi-inventory.mjs");
  assert.equal(supportOf("odata.crm-function.Contains").supported, false);
  assert.equal(supportOf("odata.crm-function.EqualRoleBusinessId").supported, false);
  assert.equal(supportOf("odata.crm-function.InFiscalYear").supported, true);
});

// (c) Token failures and 90040109.
test("token failures: no token 401, a wrong token 403, both 90040107; reads ignore tokens and bearer headers", async (t) => {
  const { json } = await start(t);
  const missing = await json("/_api/accounts", { method: "POST", body: { name: "No token" }, token: false });
  assert.deepEqual([missing.status, missing.body.error.code], [401, "90040107"]);
  assert.equal(missing.headers.get("x-sim-error-code"), "MissingPortalRequestVerificationToken");
  const wrong = await json("/_api/accounts", { method: "POST", body: { name: "Wrong token" }, token: false, headers: { __RequestVerificationToken: "stale" } });
  assert.deepEqual([wrong.status, wrong.body.error.code, wrong.body.error.message], [403, "90040107", "The anti-forgery cookie token and form field token do not match."]);
  // Microsoft's clients refresh the token on 403 + 90040107 and retry; the retry succeeds.
  const retried = await json("/_api/accounts", { method: "POST", body: { name: "Wrong token" } });
  assert.equal(retried.status, 204);
  // GETs need no token: a stale token or an invalid bearer header doesn't change a read locally
  // (proposals B-token-read-invalid-header and B-token-invalid-bearer observe the live answer).
  for (const headers of [{ __RequestVerificationToken: "stale" }, { Authorization: "Bearer invalid" }]) {
    const read = await json("/_api/accounts?$select=name", { token: false, headers });
    assert.equal(read.status, 200, JSON.stringify(headers));
  }
  // MissingPortalSessionCookie (90040109) is documented as a 401; no local path raises it.
  const session = webApiErrorResponse(new DataError("x", 401, "MissingPortalSessionCookie"), { innerError: true, innerErrorScope: "all-errors" });
  assert.equal(session.status, 401);
  assert.deepEqual(session.body.error, {
    code: "90040109",
    message: "An Invalid session token was passed into the throwing method.",
    innererror: { code: "90040109", message: "An Invalid session token was passed into the throwing method.", type: "MissingPortalSessionCookie" },
  });
});

// (b) Webapi/<table>/disableodatafilter.
test("disableodatafilter changes no rows and no error", async (t) => {
  const route = `/_api/accounts?$select=name&$filter=${encodeURIComponent("name ne 'Q1'")}&$orderby=name`;
  const results = [];
  for (const value of [undefined, "true", "false"]) {
    const settings = { ...SETTINGS, ...(value === undefined ? {} : { "Webapi/account/disableodatafilter": value }) };
    const { json } = await start(t, { settings });
    const response = await json(route);
    assert.equal(response.status, 200);
    results.push(response.body.value.map((row) => row.name));
  }
  assert.deepEqual(results[1], results[0]);
  assert.deepEqual(results[2], results[0]);
  assert.deepEqual(results[0], ["Next year", "Q2 first day", "Q4"]);
});

// (d) @odata.bind names a navigation property, case-sensitively.
test("@odata.bind accepts only the exact navigation property name", async (t) => {
  const { app, json } = await start(t);
  const exact = await json("/_api/accounts", { method: "POST", body: { name: "Bound", "new_ProductType@odata.bind": `/new_producttypes(${G(21)})` } });
  assert.equal(exact.status, 204);
  const created = app.store.snapshot().tables.account.find((row) => row.name === "Bound");
  assert.equal(created.new_producttype.id, G(21));
  // The lookup's logical name and another case of the navigation property are not navigation
  // properties (troubleshoot web-api-client-errors: parentcustomerid@odata.bind, 0x80048d19).
  for (const name of ["new_producttype", "New_ProductType", "NEW_PRODUCTTYPE"]) {
    const rejected = await json("/_api/accounts", { method: "POST", body: { name: "Wrong case", [`${name}@odata.bind`]: `/new_producttypes(${G(21)})` } });
    assert.deepEqual([rejected.status, rejected.body.error.code], [400, "9004010A"], name);
    assert.equal(rejected.headers.get("x-sim-error-code"), "UndeclaredNavigationProperty");
  }
  assert.equal(app.store.snapshot().tables.account.some((row) => row.name === "Wrong case"), false, "nothing was written");
  // The message names the navigation property to use (recorded as a simulator diagnostic).
  const policyModule = await import("../lib/webapi-policy.mjs");
  const policy = policyModule.webApiPolicy({ settings: { "Webapi/account/enabled": "true", "Webapi/account/fields": "name,new_producttype" } }, app.store, "account");
  assert.throws(() => policy.assertWrite({ "new_producttype@odata.bind": `/new_producttypes(${G(21)})` }), (error) => /did you mean new_ProductType\?/.test(error.message) && error.details.phase === "payload");
  // A name the table doesn't have at all stays InvalidAttribute (90040100).
  const unknown = await json("/_api/accounts", { method: "POST", body: { name: "Unknown", "new_widget@odata.bind": `/new_producttypes(${G(21)})` } });
  assert.deepEqual([unknown.status, unknown.body.error.code], [400, "90040100"]);
  // Learn's example: contact.parentcustomerid binds through parentcustomerid_account.
  const customer = await json("/_api/contacts", { method: "POST", body: { fullname: "Bea", "parentcustomerid_account@odata.bind": `/accounts(${G(1)})` } });
  assert.equal(customer.status, 204);
  const logical = await json("/_api/contacts", { method: "POST", body: { fullname: "Cy", "parentcustomerid@odata.bind": `/accounts(${G(1)})` } });
  assert.deepEqual([logical.status, logical.body.error.code], [400, "9004010A"]);
  // Disassociation (null) follows the same rule.
  const cleared = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { "new_ProductType@odata.bind": null }, headers: { "If-Match": "*" } });
  assert.equal(cleared.status, 204);
  const wrongClear = await json(`/_api/accounts(${G(1)})`, { method: "PATCH", body: { "new_producttype@odata.bind": null }, headers: { "If-Match": "*" } });
  assert.equal(wrongClear.status, 400);
});

test("role-less multi-table relationships get the documented <lookup>_<table> navigation names", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pp-solution-nav-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const relationship = (name, referencing, referenced, attribute) => `<EntityRelationship Name="${name}">
    <EntityRelationshipType>OneToMany</EntityRelationshipType>
    <ReferencingEntityName>${referencing}</ReferencingEntityName>
    <ReferencedEntityName>${referenced}</ReferencedEntityName>
    <CascadeDelete>Cascade</CascadeDelete>
    <ReferencingAttributeName>${attribute}</ReferencingAttributeName>
  </EntityRelationship>`;
  await fs.mkdir(path.join(root, "Other", "Relationships"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Other", "Relationships", "new_widget.xml"),
    `<EntityRelationships>${[
      relationship("new_widget_Annotations", "Annotation", "new_widget", "ObjectId"),
      relationship("new_gadget_Annotations", "Annotation", "new_gadget", "ObjectId"),
      relationship("new_widget_SharePointDocumentLocations", "SharePointDocumentLocation", "new_widget", "RegardingObjectId"),
      relationship("new_widget_new_owner", "new_widget", "contact", "new_OwnerId"),
    ].join("")}</EntityRelationships>`,
  );
  const schema = buildSolutionSchema(await scanSolutionSources([root]));
  const navigation = (name) => Object.values(schema.relationships).find((item) => item.schemaName === name).referencingNavigation;
  // Learn: annotation.objectid navigations are objectid_<table>, document locations regardingobjectid_<table>.
  assert.equal(navigation("new_widget_Annotations"), "objectid_new_widget");
  assert.equal(navigation("new_gadget_Annotations"), "objectid_new_gadget");
  assert.equal(navigation("new_widget_SharePointDocumentLocations"), "regardingobjectid_new_widget");
  // A single-table custom lookup keeps its schema name.
  assert.equal(navigation("new_widget_new_owner"), "new_OwnerId");
});

// (e) The server-logic envelope: the runtime and the fact sheet agree on the wire format.
test("unsupported exported server logic answers in the camelCase envelope", async () => {
  const answer = serverLogicUnsupported({ serverLogics: [{ name: "Echo" }] }, "echo", "post");
  assert.deepEqual(Object.keys(answer.body), ["requestId", "success", "serverLogicName", "data", "error"]);
  assert.deepEqual([answer.status, answer.body.success, answer.body.serverLogicName, answer.body.data], [501, false, "Echo", null]);
});

// (f) Platform changes: enhanced authorization, account web roles, modern lists, list OData
// feeds and table permissions on every form and list.
test("platform change diagnostics name enhanced authorization, list feeds, unsecured components and modern lists", () => {
  const list = (name, metadata) => ({ name, metadata });
  const found = platformChangeDiagnostics({
    website: { enhancedauthorization: 3 },
    lists: [
      list("Feed", { adx_odata_enabled: true, adx_odata_entitysetname: "contactset", adx_entitypermissionsenabled: true }),
      list("Open", { adx_entitypermissionsenabled: false }),
    ],
    forms: [{ name: "Open form", metadata: { adx_entitypermissionsenabled: "false" } }, { name: "Secured", metadata: { adx_entitypermissionsenabled: true } }],
    records: [{ kind: "advancedformstep", id: "s1", adx_name: "Open step", adx_entitypermissionsenabled: false }],
    pages: [{ url: "/products/", html: "{% include 'entity_list' key: 'Products' isModern: 'true' %}" }],
    templates: { t1: { name: "Classic", source: "{% include 'entity_list' key: 'Products' %}" } },
  });
  const byCode = Object.fromEntries(found.map((diagnostic) => [diagnostic.code, diagnostic]));
  assert.deepEqual(Object.keys(byCode).sort(), ["ENHANCED_AUTHORIZATION", "LIST_ODATA_FEED_REMOVED", "MODERN_LIST_RENDERED_CLASSIC", "TABLE_PERMISSIONS_ALWAYS_ENFORCED"]);
  assert.equal(byCode.ENHANCED_AUTHORIZATION.state, "Enabled");
  assert.deepEqual(byCode.LIST_ODATA_FEED_REMOVED.items, ["Feed (/_odata/contactset)"]);
  assert.deepEqual(byCode.TABLE_PERMISSIONS_ALWAYS_ENFORCED.items, ["list Open", "basic form Open form", "advanced form step Open step"]);
  assert.equal(byCode.MODERN_LIST_RENDERED_CLASSIC.count, 1);
  // Disabled enhanced authorization (0) and a site without the column report nothing.
  assert.deepEqual(platformChangeDiagnostics({ website: { enhancedauthorization: 0 } }), []);
  assert.deepEqual(platformChangeDiagnostics({}), []);
});

test("exports surface the platform changes as portal diagnostics", async (t) => {
  const standard = await fs.mkdtemp(path.join(os.tmpdir(), "pp-platform-changes-"));
  t.after(() => fs.rm(standard, { recursive: true, force: true }));
  const files = {
    "website.yml": "adx_websiteid: 4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f\nadx_name: Changes",
    "Home.webpage.yml": "adx_webpageid: 5a000000-0000-4000-8000-000000000001\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true",
    "Home.webpage.copy.html": "<h1>Home</h1>{% include 'entity_list' key: 'Accounts' isModern: 'true' %}",
    "Accounts.list.yml": "adx_entitylistid: 1b000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_entitypermissionsenabled: false\nadx_odata_enabled: true\nadx_odata_entitysetname: accountset",
    "Edit.basicform.yml": "adx_entityformid: 2b000000-0000-4000-8000-000000000001\nadx_name: Edit contact\nadx_entityname: contact\nadx_entitypermissionsenabled: false",
    "Step.advancedformstep.yml": "adx_webformstepid: 3b000000-0000-4000-8000-000000000001\nadx_name: First step\nadx_entitypermissionsenabled: false",
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(standard, name), body);
  const portal = await importPortal(standard);
  const codes = portal.diagnostics.map((diagnostic) => diagnostic.code);
  for (const code of ["LIST_ODATA_FEED_REMOVED", "TABLE_PERMISSIONS_ALWAYS_ENFORCED", "MODERN_LIST_RENDERED_CLASSIC"]) assert.ok(codes.includes(code), code);
  assert.equal(portal.diagnostics.find((diagnostic) => diagnostic.code === "TABLE_PERMISSIONS_ALWAYS_ENFORCED").count, 3);
  // The enhanced site record carries enhancedauthorization (Learn: powerpagesite choices 0-3).
  const enhanced = await fs.mkdtemp(path.join(os.tmpdir(), "pp-platform-changes-enhanced-"));
  t.after(() => fs.rm(enhanced, { recursive: true, force: true }));
  const site = (value) => `<powerpagesites><powerpagesite powerpagesiteid="dddddddd-dddd-4ddd-8ddd-dddddddddddd"><content>{}</content><name>Enhanced</name>${value == null ? "" : `<enhancedauthorization>${value}</enhancedauthorization>`}<statecode>0</statecode></powerpagesite></powerpagesites>`;
  await fs.mkdir(path.join(enhanced, "Assets"), { recursive: true });
  await fs.mkdir(path.join(enhanced, "powerpagecomponents", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), { recursive: true });
  await fs.writeFile(
    path.join(enhanced, "powerpagecomponents", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "powerpagecomponent.xml"),
    '<powerpagecomponent powerpagecomponentid="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"><content>{"partialurl":"/"}</content><name>Home</name><powerpagecomponenttype>2</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>',
  );
  const enhancedCodes = async (value) => {
    await fs.writeFile(path.join(enhanced, "Assets", "powerpagesites.xml"), site(value));
    return (await importPortal(enhanced)).diagnostics.filter((diagnostic) => diagnostic.code === "ENHANCED_AUTHORIZATION").map((diagnostic) => diagnostic.state);
  };
  assert.deepEqual(await enhancedCodes(3), ["Enabled"]);
  assert.deepEqual(await enhancedCodes(1), ["Migration in progress"]);
  assert.deepEqual(await enhancedCodes(0), []);
  assert.deepEqual(await enhancedCodes(null), []);
});

test("web roles of the persona's parent account are reported, not applied", () => {
  const ROLE = { member: "a1000000-0000-4000-8000-000000000001", partner: "a1000000-0000-4000-8000-000000000002" };
  const portal = {
    records: [
      { kind: "webrole", id: ROLE.member, name: "Member" },
      { kind: "webrole", id: ROLE.partner, name: "Partner" },
    ],
  };
  const state = {
    tables: {
      contact: [{ contactid: G(11), fullname: "Ada", statecode: 0, parentcustomerid: { id: G(1), logical_name: "account" } }],
      adx_webrole_account: [{ adx_webrole_accountid: G(70), adx_webroleid: ROLE.partner, accountid: G(1) }],
      powerpagecomponent_mspp_webrole_account: [{ powerpagecomponentid: `{${ROLE.member.toUpperCase()}}`, accountid: G(1) }],
    },
    simulator: { contactRoles: [{ contactId: G(11), roleId: ROLE.member }] },
  };
  assert.deepEqual(accountWebRoleIds(state, G(1)).sort(), [ROLE.member, ROLE.partner]);
  const persona = resolvePortalIdentity(portal, state, { contactId: G(11), roleSource: "memberships" });
  assert.deepEqual(persona.roles, ["Member"], "the account's Partner role isn't applied");
  const reported = persona.diagnostics.find((diagnostic) => diagnostic.code === "PERSONA_ACCOUNT_ROLES_NOT_APPLIED");
  assert.deepEqual([reported.accountId, reported.roles], [G(1), ["Partner"]], "a role the contact already has isn't repeated");
  // Without an account association nothing is reported.
  delete state.tables.adx_webrole_account;
  assert.equal(resolvePortalIdentity(portal, state, { contactId: G(11), roleSource: "memberships" }).diagnostics.length, 0);
});

test("a list with Enable Table Permissions off still reads under table permissions", async (t) => {
  const SITE = "4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-list-permissions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Lists`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": "{% include 'entity_list' key: 'Accounts' %}",
    "Accounts.list.yml": "adx_entitylistid: 1b000000-0000-4000-8000-000000000001\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 5\nadx_entitypermissionsenabled: false",
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const state = fixture({ permissionMode: "enforce" });
  state.permissions = [];
  state.simulator.identity = { id: G(11), roles: ["Reader"] };
  state.simulator.componentSchemas = { Accounts: { entity: "account", fields: [{ name: "name", label: "Name" }] } };
  const app = await createSimulator({ sourceDir: dir, initial: state, watch: false });
  t.after(() => app.close());
  const page = await (await fetch(`${app.url}/`)).text();
  const encoded = /data-view-layouts="([^"]*)"/.exec(page)[1];
  const [layout] = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const grid = async () =>
    (
      await fetch(`${app.url}/_services/entity-grid-data.json/${SITE}`, {
        method: "POST",
        headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf },
        body: JSON.stringify({ base64SecureConfiguration: layout.Base64SecureConfiguration, sortExpression: "", search: "", page: 1, pageSize: 5, pagingCookie: "", filter: null, metaFilter: null, nlSearchFilter: "", timezoneOffset: 0, customParameters: [] }),
      })
    ).json();
  assert.deepEqual(await grid(), { AccessDenied: true }, "no grant: denied although the list turns permissions off");
  const granted = app.store.snapshot();
  granted.permissions = [{ id: "reader-account", entity: "account", scope: "global", roles: ["Reader"], operations: ["read"] }];
  await app.store.replaceState(granted);
  assert.equal((await grid()).Records.length, 4, "a read grant shows the rows");
});
