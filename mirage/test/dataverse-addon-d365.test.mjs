// Dynamics 365 application messages (lib/dataverse-addon-d365.mjs) over HTTP: goal Recalculate, SyncBulkOperation, SendBulkMail,
// ImmediateBook, CalculatePrice (with its pack hook) and ApplyRecordCreationAndUpdateRule.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { addonHandlerExtension, addonHandlers } from "../lib/dataverse-addon-common.mjs";

const APP_ID = "66666666-6666-6666-6666-666666666666";
const APP_ID_PACK = "77777777-7777-7777-7777-777777777777";
const SECRET_VAR = "PAQVILO_D365_SECRET";
const VERSION = "v9.2";
const CRM = "Microsoft.Dynamics.CRM.";

const id = (n) => `ab000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const METRIC = id(1), NO_ROLLUP_METRIC = id(2), RF = id(3);
const GOAL_ROOT = id(10), GOAL_CHILD = id(11), GOAL_BARE = id(12);
const W1 = id(20), W2 = id(21), W3 = id(22);
const JOB_A = id(30), JOB_B = id(31);
const TEMPLATE = id(40), EMAIL = id(41), OPP = id(42), APPT = id(43);
const SYSTEM_USER = id(44);
const WINDOW = { goalstartdate: "2026-10-01T00:00:00.000Z", goalenddate: "2026-10-31T23:59:59.000Z" };

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: "contoso_widget", entitySet: "contoso_widgets", idColumn: "contoso_widgetid", nameColumn: "name",
    userConfigured: true, fields: { name: { dataverseType: "nvarchar" }, amount: { dataverseType: "decimal" }, createdon: { dataverseType: "datetime" } }, relationships: {},
  };
  state.tables.contoso_widget = [
    { contoso_widgetid: W1, name: "alpha", amount: 10, createdon: "2026-10-05T00:00:00.000Z", emailaddress1: "alpha@contoso.test", statecode: 0, statuscode: 1 },
    { contoso_widgetid: W2, name: "beta", amount: 5, createdon: "2026-10-20T00:00:00.000Z", emailaddress1: "beta@contoso.test", statecode: 0, statuscode: 1 },
    { contoso_widgetid: W3, name: "gamma", amount: 100, createdon: "2026-11-05T00:00:00.000Z", emailaddress1: "gamma@contoso.test", statecode: 0, statuscode: 1 },
  ];
  state.tables.metric = [
    { metricid: METRIC, name: "Invented metric", amountdatatype: 1, isamount: false, statecode: 0 },
    { metricid: NO_ROLLUP_METRIC, name: "Invented bare metric", amountdatatype: 1, isamount: false, statecode: 0 },
  ];
  state.tables.rollupfield = [{ rollupfieldid: RF, metricid: METRIC, sourceentity: "contoso_widget", sourceattribute: "amount", goalattribute: "actual", dateattribute: "createdon" }];
  state.tables.goal = [
    { goalid: GOAL_ROOT, metricid: METRIC, parentgoalid: null, targetdecimal: 60, rolluponlyfromchildgoals: false, consideronlygoalownersrecords: false, ...WINDOW, statecode: 0 },
    { goalid: GOAL_CHILD, metricid: METRIC, parentgoalid: GOAL_ROOT, targetdecimal: 30, rolluponlyfromchildgoals: false, consideronlygoalownersrecords: false, ...WINDOW, statecode: 0 },
    { goalid: GOAL_BARE, metricid: NO_ROLLUP_METRIC, parentgoalid: null, targetdecimal: 10, consideronlygoalownersrecords: false, ...WINDOW, statecode: 0 },
  ];
  state.tables.asyncoperation = [
    { asyncoperationid: JOB_A, name: "Invented bulk A", operationtype: 1, statecode: 0, statuscode: 0 },
    { asyncoperationid: JOB_B, name: "Invented bulk B", operationtype: 1, statecode: 0, statuscode: 0 },
  ];
  state.tables.template = [{ templateid: TEMPLATE, title: "Invented template", subject: "Hello", body: "Body text", templatetypecode: null }];
  state.tables.email = [{ activityid: EMAIL, subject: "Invented draft", statecode: 0, statuscode: 1 }];
  return state;
}

async function startServer({ applicationId = APP_ID, extensions = EXTENSIONS, state = fixtureState() } = {}) {
  process.env[SECRET_VAR] = `d365-secret-${applicationId.slice(0, 4)}`;
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [{ appId: applicationId, displayName: "D365 test app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
  });
  const server = await startDataverseApi({ store, settings, extensions, log: () => {} });
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: applicationId, client_secret: process.env[SECRET_VAR], scope: `${server.origin}/.default` }),
  });
  const authorization = `Bearer ${(await token.json()).access_token}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${server.origin}/api/data/${VERSION}${path}`, {
      method, headers: { authorization, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const text = async (path) => (await fetch(`${server.origin}/api/data/${VERSION}${path}`, { headers: { authorization } })).text();
  return { server, store, call, text, close: () => server.close() };
}

// Polls until the Bulk e-mail job that a SendBulkMail started has completed (the job runs on a later tick).
async function settleBulkMail(store) {
  for (let i = 0; i < 100; i += 1) {
    const job = store.state.tables.asyncoperation.find((row) => row.name === "Bulk e-mail" && row.statecode === 3);
    if (job) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Bulk e-mail job did not complete");
}

describe("Dynamics 365 application messages over HTTP", () => {
  let h;

  before(async () => {
    h = await startServer();
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await h?.close();
  });

  it("every Dynamics 365 application message is declared in $metadata", async () => {
    const metadata = await h.text(`/$metadata`);
    for (const name of ["Recalculate", "SyncBulkOperation", "SendBulkMail", "ImmediateBook", "CalculatePrice", "ApplyRecordCreationAndUpdateRule"]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
    assert.match(metadata, /Name="SyncBulkOperationResponse"/);
  });

  it("recalculate sums owner rows into the goal tree, parents adding their children", async () => {
    const result = await h.call("POST", `/goals(${GOAL_CHILD})/Microsoft.Dynamics.CRM.Recalculate`, {});
    assert.equal(result.status, 204);
    const root = h.store.state.tables.goal.find((row) => row.goalid === GOAL_ROOT);
    const child = h.store.state.tables.goal.find((row) => row.goalid === GOAL_CHILD);
    // W1 (10) and W2 (5) fall in the window; W3 is dated after it. The child holds 15; the root holds its own 15 plus the child's 15.
    assert.equal(child.actualdecimal, 15);
    assert.equal(child.percentage, 50);
    assert.equal(root.actualdecimal, 30);
    assert.equal(root.percentage, 50);
    assert.ok(Date.parse(child.lastrolledupdate) > 0);
  });

  it("recalculate without rollup fields fails with 0x8004F681", async () => {
    const result = await h.call("POST", `/goals(${GOAL_BARE})/Microsoft.Dynamics.CRM.Recalculate`, {});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code.toLowerCase(), "0x8004f681");
    assert.match(result.body.error.message, /atleast one rollup attribute needs to be associated with the goal metric/);
  });

  it("sync bulk operation pauses and cancels asyncoperation jobs and refuses other tables", async () => {
    const jobOf = (jobId) => h.store.state.tables.asyncoperation.find((row) => row.asyncoperationid === jobId);
    const selectAll = [{ EntityName: "asyncoperation" }];
    const pause = await h.call("POST", "/SyncBulkOperation", { QuerySet: selectAll, OperationType: 0 });
    assert.equal(pause.status, 200);
    assert.equal(pause.body.Result, 2);
    assert.deepEqual([jobOf(JOB_A).statecode, jobOf(JOB_A).statuscode], [1, 21]);
    const cancel = await h.call("POST", "/SyncBulkOperation", { QuerySet: selectAll, OperationType: 2 });
    assert.equal(cancel.status, 200);
    assert.deepEqual([jobOf(JOB_B).statecode, jobOf(JOB_B).statuscode], [3, 32]);
    const resume = await h.call("POST", "/SyncBulkOperation", { QuerySet: selectAll, OperationType: 1 });
    assert.equal(resume.status, 200);
    assert.deepEqual([jobOf(JOB_A).statecode, jobOf(JOB_A).statuscode], [0, 0]);
    const other = await h.call("POST", "/SyncBulkOperation", { QuerySet: [{ EntityName: "contoso_widget" }], OperationType: 0 });
    assert.equal(other.status, 400);
    const unknown = await h.call("POST", "/SyncBulkOperation", { QuerySet: selectAll, OperationType: 9 });
    assert.equal(unknown.status, 400);
  });

  it("send bulk mail creates one email per recipient in a completed job", async () => {
    const sent = await h.call("POST", "/SendBulkMail", {
      Sender: { "@odata.type": `${CRM}systemuser`, systemuserid: SYSTEM_USER, internalemailaddress: "sender@contoso.test" },
      TemplateId: TEMPLATE, RegardingType: "contoso_widget", RegardingId: W1, Query: { EntityName: "contoso_widget" },
    });
    assert.equal(sent.status, 204);
    const job = await settleBulkMail(h.store);
    assert.equal(job.operationtype, 2);
    const drafts = h.store.state.tables.email.filter((row) => row.regardingobjectid && row.regardingobjectid.id === W1 && row.torecipients);
    assert.deepEqual(drafts.map((row) => row.torecipients).sort(), ["alpha@contoso.test", "beta@contoso.test", "gamma@contoso.test"]);
    for (const draft of drafts) assert.equal(draft.sender, "sender@contoso.test");
  });

  it("send bulk mail refuses an unknown template", async () => {
    const result = await h.call("POST", "/SendBulkMail", { TemplateId: id(99), RegardingType: "contoso_widget", RegardingId: W1, Query: { EntityName: "contoso_widget" } });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, "0x80040217");
  });

  it("immediate book wraps Book and returns no notifications", async () => {
    const result = await h.call("POST", "/ImmediateBook", {
      Target: { "@odata.type": `${CRM}appointment`, activityid: APPT, subject: "Invented meeting", scheduledstart: "2026-10-21T09:00:00.000Z", scheduledend: "2026-10-21T10:00:00.000Z" },
      AttachmentIds: [], EWSUrl: "", AttachmentToken: "",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.Notifications, []);
    assert.deepEqual(result.body.ValidationResult, { ActivityId: APPT, TraceInfo: { ErrorInfoList: [] }, ValidationSuccess: true });
    assert.ok(h.store.state.tables.appointment?.some((row) => row.activityid === APPT && row.subject === "Invented meeting"));
  });

  it("calculate price answers 404 for an absent table and 204 for a stored one", async () => {
    const absent = await h.call("POST", "/CalculatePrice", { Target: { "@odata.type": `${CRM}opportunity`, opportunityid: OPP } });
    assert.equal(absent.status, 404);
    assert.equal(absent.body.error.code, "0x80040217");
    const stored = await h.call("POST", "/CalculatePrice", { Target: { "@odata.type": `${CRM}contoso_widget`, contoso_widgetid: W2 } });
    assert.equal(stored.status, 204);
  });

  it("apply record creation rule checks the target activity exists", async () => {
    const found = await h.call("POST", "/ApplyRecordCreationAndUpdateRule", { Target: { "@odata.type": `${CRM}email`, activityid: EMAIL } });
    assert.equal(found.status, 204);
    const missing = await h.call("POST", "/ApplyRecordCreationAndUpdateRule", { Target: { "@odata.type": `${CRM}email`, activityid: id(98) } });
    assert.equal(missing.status, 404);
  });
});

describe("calculate price pack hook", () => {
  it("a trusted pack's CalculatePrice handler replaces the absent-table default", async () => {
    const seen = [];
    const pack = {
      id: "contoso-pricing",
      dataverseMessages: { CalculatePrice: async (ctx) => { seen.push({ name: ctx.name, logical: ctx.target }); return undefined; } },
    };
    const extensions = [...EXTENSIONS, addonHandlerExtension(addonHandlers([pack]))];
    const p = await startServer({ applicationId: APP_ID_PACK, extensions });
    try {
      const result = await p.call("POST", "/CalculatePrice", { Target: { "@odata.type": `${CRM}opportunity`, opportunityid: OPP } });
      assert.equal(result.status, 204);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].name, "CalculatePrice");
    } finally {
      delete process.env[SECRET_VAR];
      await p.close();
    }
  });
});
