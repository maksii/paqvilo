// @test-kind contract: Paqvilo's Dynamics 365 application messages (the Sales, Marketing and Service stubs) are designed runtime behaviour.
// Dynamics 365 application messages (lib/dataverse-addon-d365.mjs) over HTTP: goal Recalculate, SyncBulkOperation, SendBulkMail,
// ImmediateBook, CalculatePrice (with its pack hook) and ApplyRecordCreationAndUpdateRule.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import { DEPTH } from '../lib/dataverse-security.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { addonHandlerExtension, addonHandlers } from '../lib/dataverse-addon-common.mjs';

const APP_ID = '66666666-6666-6666-6666-666666666666';
const APP_ID_PACK = '77777777-7777-7777-7777-777777777777';
const SECRET_VAR = 'PAQVILO_D365_SECRET';
const VERSION = 'v9.2';
const CRM = 'Microsoft.Dynamics.CRM.';

const id = (n) => `ab000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const METRIC = id(1),
  NO_ROLLUP_METRIC = id(2),
  RF = id(3);
const GOAL_ROOT = id(10),
  GOAL_CHILD = id(11),
  GOAL_BARE = id(12);
const W1 = id(20),
  W2 = id(21),
  W3 = id(22);
const JOB_A = id(30),
  JOB_B = id(31);
const TEMPLATE = id(40),
  EMAIL = id(41),
  OPP = id(42),
  APPT = id(43);
const SYSTEM_USER = id(44);
const WINDOW = { goalstartdate: '2026-10-01T00:00:00.000Z', goalenddate: '2026-10-31T23:59:59.000Z' };

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: {
      name: { dataverseType: 'nvarchar' },
      amount: { dataverseType: 'decimal' },
      createdon: { dataverseType: 'datetime' },
    },
    relationships: {},
  };
  state.tables.contoso_widget = [
    {
      contoso_widgetid: W1,
      name: 'alpha',
      amount: 10,
      createdon: '2026-10-05T00:00:00.000Z',
      emailaddress1: 'alpha@contoso.test',
      statecode: 0,
      statuscode: 1,
    },
    {
      contoso_widgetid: W2,
      name: 'beta',
      amount: 5,
      createdon: '2026-10-20T00:00:00.000Z',
      emailaddress1: 'beta@contoso.test',
      statecode: 0,
      statuscode: 1,
    },
    {
      contoso_widgetid: W3,
      name: 'gamma',
      amount: 100,
      createdon: '2026-11-05T00:00:00.000Z',
      emailaddress1: 'gamma@contoso.test',
      statecode: 0,
      statuscode: 1,
    },
  ];
  state.tables.metric = [
    { metricid: METRIC, name: 'Invented metric', amountdatatype: 1, isamount: false, statecode: 0 },
    { metricid: NO_ROLLUP_METRIC, name: 'Invented bare metric', amountdatatype: 1, isamount: false, statecode: 0 },
  ];
  state.tables.rollupfield = [
    {
      rollupfieldid: RF,
      metricid: METRIC,
      sourceentity: 'contoso_widget',
      sourceattribute: 'amount',
      goalattribute: 'actual',
      dateattribute: 'createdon',
    },
  ];
  state.tables.goal = [
    {
      goalid: GOAL_ROOT,
      metricid: METRIC,
      parentgoalid: null,
      targetdecimal: 60,
      rolluponlyfromchildgoals: false,
      consideronlygoalownersrecords: false,
      ...WINDOW,
      statecode: 0,
    },
    {
      goalid: GOAL_CHILD,
      metricid: METRIC,
      parentgoalid: GOAL_ROOT,
      targetdecimal: 30,
      rolluponlyfromchildgoals: false,
      consideronlygoalownersrecords: false,
      ...WINDOW,
      statecode: 0,
    },
    {
      goalid: GOAL_BARE,
      metricid: NO_ROLLUP_METRIC,
      parentgoalid: null,
      targetdecimal: 10,
      consideronlygoalownersrecords: false,
      ...WINDOW,
      statecode: 0,
    },
  ];
  state.tables.asyncoperation = [
    { asyncoperationid: JOB_A, name: 'Invented bulk A', operationtype: 1, statecode: 0, statuscode: 0 },
    { asyncoperationid: JOB_B, name: 'Invented bulk B', operationtype: 1, statecode: 0, statuscode: 0 },
  ];
  state.tables.template = [
    { templateid: TEMPLATE, title: 'Invented template', subject: 'Hello', body: 'Body text', templatetypecode: null },
  ];
  state.tables.email = [{ activityid: EMAIL, subject: 'Invented draft', statecode: 0, statuscode: 1 }];
  return state;
}

async function startServer({
  applicationId = APP_ID,
  extensions = EXTENSIONS,
  state = fixtureState(),
  roles = ['System Administrator'],
} = {}) {
  process.env[SECRET_VAR] = `d365-secret-${applicationId.slice(0, 4)}`;
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: applicationId,
        displayName: 'D365 test app',
        secretEnvironmentVariable: SECRET_VAR,
        roles,
      },
    ],
  });
  const server = await startDataverseApi({ store, settings, extensions, log: () => {} });
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: applicationId,
      client_secret: process.env[SECRET_VAR],
      scope: `${server.origin}/.default`,
    }),
  });
  const authorization = `Bearer ${(await token.json()).access_token}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${server.origin}/api/data/${VERSION}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const text = async (path) =>
    (await fetch(`${server.origin}/api/data/${VERSION}${path}`, { headers: { authorization } })).text();
  return { server, store, call, text, close: () => server.close() };
}

// The Bulk e-mail job that a SendBulkMail started, once it has run: the job is a task of the API scheduler (it runs on a
// later tick), and drain() returns when that task has settled.
async function settleBulkMail(store) {
  await store.scheduler.drain();
  const jobs = store.state.tables.asyncoperation.filter((row) => row.name === 'Bulk e-mail');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].statecode, 3, 'the job is Completed');
  return jobs[0];
}

describe('Dynamics 365 application messages over HTTP', () => {
  let h;

  before(async () => {
    h = await startServer();
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await h?.close();
  });

  it('every Dynamics 365 application message is declared in $metadata', async () => {
    const metadata = await h.text(`/$metadata`);
    for (const name of [
      'Recalculate',
      'SyncBulkOperation',
      'SendBulkMail',
      'ImmediateBook',
      'CalculatePrice',
      'ApplyRecordCreationAndUpdateRule',
    ]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
    assert.match(metadata, /Name="SyncBulkOperationResponse"/);
  });

  it('recalculate sums owner rows into the goal tree, parents adding their children', async () => {
    const result = await h.call('POST', `/goals(${GOAL_CHILD})/Microsoft.Dynamics.CRM.Recalculate`, {});
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

  it('recalculate without rollup fields fails with 0x8004F681', async () => {
    const result = await h.call('POST', `/goals(${GOAL_BARE})/Microsoft.Dynamics.CRM.Recalculate`, {});
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code.toLowerCase(), '0x8004f681');
    assert.match(result.body.error.message, /atleast one rollup attribute needs to be associated with the goal metric/);
  });

  it('sync bulk operation pauses and cancels asyncoperation jobs and refuses other tables', async () => {
    const jobOf = (jobId) => h.store.state.tables.asyncoperation.find((row) => row.asyncoperationid === jobId);
    const selectAll = [{ EntityName: 'asyncoperation' }];
    const pause = await h.call('POST', '/SyncBulkOperation', { QuerySet: selectAll, OperationType: 0 });
    assert.equal(pause.status, 200);
    assert.equal(pause.body.Result, 2);
    assert.deepEqual([jobOf(JOB_A).statecode, jobOf(JOB_A).statuscode], [1, 21]);
    const cancel = await h.call('POST', '/SyncBulkOperation', { QuerySet: selectAll, OperationType: 2 });
    assert.equal(cancel.status, 200);
    assert.deepEqual([jobOf(JOB_B).statecode, jobOf(JOB_B).statuscode], [3, 32]);
    const resume = await h.call('POST', '/SyncBulkOperation', { QuerySet: selectAll, OperationType: 1 });
    assert.equal(resume.status, 200);
    assert.deepEqual([jobOf(JOB_A).statecode, jobOf(JOB_A).statuscode], [0, 0]);
    const other = await h.call('POST', '/SyncBulkOperation', {
      QuerySet: [{ EntityName: 'contoso_widget' }],
      OperationType: 0,
    });
    assert.equal(other.status, 400);
    const unknown = await h.call('POST', '/SyncBulkOperation', { QuerySet: selectAll, OperationType: 9 });
    assert.equal(unknown.status, 400);
  });

  it('send bulk mail creates one email per recipient in a completed job', async () => {
    const sent = await h.call('POST', '/SendBulkMail', {
      Sender: {
        '@odata.type': `${CRM}systemuser`,
        systemuserid: SYSTEM_USER,
        internalemailaddress: 'sender@contoso.test',
      },
      TemplateId: TEMPLATE,
      RegardingType: 'contoso_widget',
      RegardingId: W1,
      Query: { EntityName: 'contoso_widget' },
    });
    assert.equal(sent.status, 204);
    const job = await settleBulkMail(h.store);
    assert.equal(job.operationtype, 2);
    const drafts = h.store.state.tables.email.filter(
      (row) => row.regardingobjectid && row.regardingobjectid.id === W1 && row.torecipients,
    );
    assert.deepEqual(drafts.map((row) => row.torecipients).sort(), [
      'alpha@contoso.test',
      'beta@contoso.test',
      'gamma@contoso.test',
    ]);
    for (const draft of drafts) assert.equal(draft.sender, 'sender@contoso.test');
  });

  it('send bulk mail refuses an unknown template', async () => {
    const result = await h.call('POST', '/SendBulkMail', {
      TemplateId: id(99),
      RegardingType: 'contoso_widget',
      RegardingId: W1,
      Query: { EntityName: 'contoso_widget' },
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.code, '0x80040217');
  });

  it('immediate book wraps Book and returns no notifications', async () => {
    const result = await h.call('POST', '/ImmediateBook', {
      Target: {
        '@odata.type': `${CRM}appointment`,
        activityid: APPT,
        subject: 'Invented meeting',
        scheduledstart: '2026-10-21T09:00:00.000Z',
        scheduledend: '2026-10-21T10:00:00.000Z',
      },
      AttachmentIds: [],
      EWSUrl: '',
      AttachmentToken: '',
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.Notifications, []);
    assert.deepEqual(result.body.ValidationResult, {
      ActivityId: APPT,
      TraceInfo: { ErrorInfoList: [] },
      ValidationSuccess: true,
    });
    assert.ok(
      h.store.state.tables.appointment?.some((row) => row.activityid === APPT && row.subject === 'Invented meeting'),
    );
  });

  it('calculate price answers 404 for an absent table and 204 for a stored one', async () => {
    const absent = await h.call('POST', '/CalculatePrice', {
      Target: { '@odata.type': `${CRM}opportunity`, opportunityid: OPP },
    });
    assert.equal(absent.status, 404);
    assert.equal(absent.body.error.code, '0x80040217');
    const stored = await h.call('POST', '/CalculatePrice', {
      Target: { '@odata.type': `${CRM}contoso_widget`, contoso_widgetid: W2 },
    });
    assert.equal(stored.status, 204);
  });

  it('apply record creation rule checks the target activity exists', async () => {
    const found = await h.call('POST', '/ApplyRecordCreationAndUpdateRule', {
      Target: { '@odata.type': `${CRM}email`, activityid: EMAIL },
    });
    assert.equal(found.status, 204);
    const missing = await h.call('POST', '/ApplyRecordCreationAndUpdateRule', {
      Target: { '@odata.type': `${CRM}email`, activityid: id(98) },
    });
    assert.equal(missing.status, 404);
  });
});

describe('calculate price pack hook', () => {
  it("a trusted pack's CalculatePrice handler replaces the absent-table default", async () => {
    const seen = [];
    const pack = {
      id: 'contoso-pricing',
      dataverseMessages: {
        CalculatePrice: async (ctx) => {
          seen.push({ name: ctx.name, logical: ctx.target });
          return undefined;
        },
      },
    };
    const extensions = [...EXTENSIONS, addonHandlerExtension(addonHandlers([pack]))];
    const p = await startServer({ applicationId: APP_ID_PACK, extensions });
    try {
      const result = await p.call('POST', '/CalculatePrice', {
        Target: { '@odata.type': `${CRM}opportunity`, opportunityid: OPP },
      });
      assert.equal(result.status, 204);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].name, 'CalculatePrice');
    } finally {
      delete process.env[SECRET_VAR];
      await p.close();
    }
  });
});

const APP_ID_BASIC = '88888888-8888-8888-8888-888888888888';
const goalRow = (store, goalid) => store.state.tables.goal.find((row) => row.goalid === goalid);
// Makes a goal owned by one systemuser, as an owner column write would.
async function ownGoal(store, goalid, systemuserid) {
  const owner = { id: systemuserid, logical_name: 'systemuser', name: '' };
  await store.transact(() => {
    const row = goalRow(store, goalid);
    row.ownerid = owner;
    row.owninguser = owner;
  });
}

// A grant of one privilege at one depth to the Basic User role, as the seeding writes it.
async function grantBasicUser(store, privilegeName, privilegedepthmask) {
  const role = store.state.tables.role.find((r) => r.name === 'Basic User');
  const privilege = store.state.tables.privilege.find((p) => p.name === privilegeName);
  await store.transact(() =>
    store.state.tables.roleprivileges.push({
      roleprivilegeid: randomUUID(),
      roleid: { id: role.roleid, logical_name: 'role', name: '' },
      privilegeid: { id: privilege.privilegeid, logical_name: 'privilege', name: '' },
      privilegedepthmask,
    }),
  );
}

// The application user holds the Basic User role: it reads every goal and writes only the goals it owns (Basic depth).
describe('Recalculate for an application user that writes only its own goals', () => {
  let b, caller;

  before(async () => {
    b = await startServer({ applicationId: APP_ID_BASIC, roles: ['Basic User'] });
    await grantBasicUser(b.store, 'prvReadGoal', DEPTH.Global);
    await grantBasicUser(b.store, 'prvWriteGoal', DEPTH.Basic);
    // The child goal is the caller's; its root (GOAL_ROOT) belongs to another owner.
    caller = b.store.state.tables.systemuser.find((u) => u.applicationid === APP_ID_BASIC).systemuserid;
    await ownGoal(b.store, GOAL_CHILD, caller);
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await b?.close();
  });

  // The CRUD write of the root is refused with the code the message must give, and Recalculate on the child changes no goal.
  // @test-kind security: Recalculate rewrites every goal of the tree, so it must refuse a tree the caller cannot write and change none of it.
  it('recalculate refuses a goal tree the caller cannot write and updates no goal', async () => {
    const goals = JSON.stringify(b.store.state.tables.goal);
    const crud = await b.call('PATCH', `/goals(${GOAL_ROOT})`, { targetdecimal: 61 });
    assert.equal(crud.status, 403);
    const result = await b.call('POST', `/goals(${GOAL_CHILD})/Microsoft.Dynamics.CRM.Recalculate`, {});
    assert.equal(result.status, 403);
    assert.equal(result.body.error.code, crud.body.error.code);
    assert.equal(JSON.stringify(b.store.state.tables.goal), goals);
  });

  it('recalculate succeeds on a tree the caller can write entirely', async () => {
    await ownGoal(b.store, GOAL_ROOT, caller);
    const result = await b.call('POST', `/goals(${GOAL_CHILD})/Microsoft.Dynamics.CRM.Recalculate`, {});
    assert.equal(result.status, 204);
    assert.equal(goalRow(b.store, GOAL_CHILD).actualdecimal, 15);
    assert.equal(goalRow(b.store, GOAL_ROOT).actualdecimal, 30);
  });
});

// Invented sales tables: an opportunity with two products, an active quote with one line and a won quote.
const SALES = {
  opportunity: id(60),
  emptyOpportunity: id(61),
  activeQuote: id(62),
  wonQuote: id(63),
  order: id(64),
};
const table = (logicalName, entitySet, idColumn, fields) => ({
  logicalName,
  entitySet,
  idColumn,
  nameColumn: 'name',
  userConfigured: true,
  fields: { name: { dataverseType: 'nvarchar' }, ...fields },
  relationships: {},
});
const stateField = (pairs) => ({
  dataverseType: 'state',
  states: pairs.map(([value, defaultStatus]) => ({ value, defaultStatus })),
});
function salesState() {
  const state = emptyState();
  const money = { dataverseType: 'money' };
  const status = { dataverseType: 'status' };
  const lookup = (target) => ({ dataverseType: 'lookup', targets: [target] });
  state.mappings.opportunity = table('opportunity', 'opportunities', 'opportunityid', {
    estimatedvalue: money,
    actualvalue: money,
    description: { dataverseType: 'nvarchar' },
    statecode: stateField([
      [0, 1],
      [1, 3],
      [2, 4],
    ]),
    statuscode: status,
  });
  state.mappings.opportunityproduct = table('opportunityproduct', 'opportunityproducts', 'opportunityproductid', {
    opportunityid: lookup('opportunity'),
    quantity: { dataverseType: 'decimal' },
    extendedamount: money,
  });
  state.mappings.quote = table('quote', 'quotes', 'quoteid', {
    description: { dataverseType: 'nvarchar' },
    opportunityid: lookup('opportunity'),
    totalamount: money,
    statecode: stateField([
      [0, 1],
      [1, 2],
      [2, 4],
      [3, 5],
    ]),
    statuscode: status,
  });
  state.mappings.quotedetail = table('quotedetail', 'quotedetails', 'quotedetailid', {
    quoteid: lookup('quote'),
    quantity: { dataverseType: 'decimal' },
    extendedamount: money,
  });
  state.mappings.quoteclose = table('quoteclose', 'quotecloses', 'activityid', {
    subject: { dataverseType: 'nvarchar' },
    quoteid: lookup('quote'),
  });
  state.mappings.salesorder = table('salesorder', 'salesorders', 'salesorderid', {
    description: { dataverseType: 'nvarchar' },
    quoteid: lookup('quote'),
    totalamount: money,
  });
  state.mappings.salesorderdetail = table('salesorderdetail', 'salesorderdetails', 'salesorderdetailid', {
    salesorderid: lookup('salesorder'),
    quantity: { dataverseType: 'decimal' },
    extendedamount: money,
  });
  state.mappings.invoice = table('invoice', 'invoices', 'invoiceid', {
    description: { dataverseType: 'nvarchar' },
    salesorderid: lookup('salesorder'),
    totalamount: money,
  });
  state.mappings.invoicedetail = table('invoicedetail', 'invoicedetails', 'invoicedetailid', {
    invoiceid: lookup('invoice'),
    quantity: { dataverseType: 'decimal' },
    extendedamount: money,
  });
  state.tables.opportunity = [
    {
      opportunityid: SALES.opportunity,
      name: 'Invented deal',
      description: 'Shared text',
      estimatedvalue: 90,
      statecode: 0,
      statuscode: 1,
    },
    {
      opportunityid: SALES.emptyOpportunity,
      name: 'Invented bare deal',
      estimatedvalue: 70,
      statecode: 1,
      statuscode: 3,
    },
  ];
  state.tables.opportunityproduct = [
    { opportunityproductid: id(70), name: 'Line A', opportunityid: SALES.opportunity, quantity: 2, extendedamount: 40 },
    { opportunityproductid: id(71), name: 'Line B', opportunityid: SALES.opportunity, quantity: 1, extendedamount: 15 },
  ];
  state.tables.quote = [
    {
      quoteid: SALES.activeQuote,
      name: 'Invented quote',
      description: 'Quote text',
      totalamount: 55,
      statecode: 1,
      statuscode: 2,
    },
    { quoteid: SALES.wonQuote, name: 'Invented won quote', totalamount: 20, statecode: 2, statuscode: 4 },
  ];
  state.tables.quotedetail = [
    { quotedetailid: id(72), name: 'Quote line', quoteid: SALES.activeQuote, quantity: 3, extendedamount: 55 },
  ];
  state.tables.quoteclose = [];
  state.tables.salesorder = [
    {
      salesorderid: SALES.order,
      name: 'Invented order',
      description: 'Order text',
      totalamount: 33,
      statecode: 0,
      statuscode: 1,
    },
  ];
  state.tables.salesorderdetail = [
    { salesorderdetailid: id(73), name: 'Order line', salesorderid: SALES.order, quantity: 1, extendedamount: 33 },
  ];
  state.tables.invoice = [];
  state.tables.invoicedetail = [];
  return state;
}

describe('Dynamics 365 sales conversions over HTTP', () => {
  let h;
  before(async () => {
    h = await startServer({ state: salesState() });
  });
  after(async () => {
    delete process.env[SECRET_VAR];
    await h?.close();
  });
  const rows = (logical) => h.store.state.tables[logical];
  const parent = (row, column) => String(row[column]?.id ?? row[column]).toLowerCase();

  // @test-kind unproven: local model of WinQuote (Learn WinQuoteRequest: a quote close activity and the Won state); no native capture
  it('win quote closes an active quote as won with a quote close activity', async () => {
    const won = await h.call('POST', '/WinQuote', {
      QuoteClose: { subject: 'Invented close', 'quoteid@odata.bind': `/quotes(${SALES.activeQuote})` },
      Status: -1,
    });
    assert.equal(won.status, 204, JSON.stringify(won.body));
    const quote = rows('quote').find((row) => row.quoteid === SALES.activeQuote);
    assert.deepEqual([quote.statecode, quote.statuscode], [2, 4]);
    assert.equal(rows('quoteclose').length, 1);
    assert.equal(parent(rows('quoteclose')[0], 'quoteid'), SALES.activeQuote);
    const again = await h.call('POST', '/WinQuote', {
      QuoteClose: { 'quoteid@odata.bind': `/quotes(${SALES.activeQuote})` },
      Status: -1,
    });
    assert.equal(again.status, 400, 'a won quote is not won again');
    assert.equal(rows('quoteclose').length, 1);
  });

  // @test-kind unproven: local model of the documented conversions (Learn "Convert an opportunity to a quote, sales order, or invoice": shared data and products carried over); the carried columns are those both tables have
  it('conversions copy the shared columns and line items and link the new record to its source', async () => {
    const quote = await h.call('GET', `/GenerateQuoteFromOpportunity(OpportunityId=${SALES.opportunity})`);
    assert.equal(quote.status, 200, JSON.stringify(quote.body));
    const created = rows('quote').find((row) => parent(row, 'opportunityid') === SALES.opportunity);
    assert.ok(created, 'a quote of the opportunity');
    assert.equal(created.description, 'Shared text');
    assert.deepEqual(
      rows('quotedetail')
        .filter((row) => parent(row, 'quoteid') === String(created.quoteid).toLowerCase())
        .map((row) => [row.name, row.quantity, row.extendedamount])
        .sort(),
      [
        ['Line A', 2, 40],
        ['Line B', 1, 15],
      ],
    );

    const order = await h.call('GET', `/ConvertQuoteToSalesOrder(QuoteId=${SALES.wonQuote})`);
    assert.equal(order.status, 200, JSON.stringify(order.body));
    const salesorder = rows('salesorder').find((row) => parent(row, 'quoteid') === SALES.wonQuote);
    assert.equal(salesorder.totalamount, 20);

    const invoice = await h.call('GET', `/ConvertSalesOrderToInvoice(SalesOrderId=${SALES.order})`);
    assert.equal(invoice.status, 200, JSON.stringify(invoice.body));
    const created2 = rows('invoice').find((row) => parent(row, 'salesorderid') === SALES.order);
    assert.equal(created2.description, 'Order text');
    assert.deepEqual(
      rows('invoicedetail').map((row) => [row.name, parent(row, 'invoiceid')]),
      [['Order line', String(created2.invoiceid).toLowerCase()]],
    );
    // A draft or closed quote and a won opportunity do not convert.
    assert.equal(
      (await h.call('GET', `/GenerateQuoteFromOpportunity(OpportunityId=${SALES.emptyOpportunity})`)).status,
      400,
    );
  });

  // @test-kind unproven: local model of CalculateActualValueOpportunity (Learn: a won opportunity; Actual Revenue defaults to the estimated revenue); the products' sum and the written actualvalue are assumptions
  it('calculate actual value sums the products of a won opportunity, else its estimated value', async () => {
    const open = await h.call('GET', `/CalculateActualValueOpportunity(OpportunityId=${SALES.opportunity})`);
    assert.equal(open.status, 400, 'only a won opportunity');
    const bare = await h.call('GET', `/CalculateActualValueOpportunity(OpportunityId=${SALES.emptyOpportunity})`);
    assert.equal(bare.status, 200, JSON.stringify(bare.body));
    assert.equal(bare.body.Value, 70);
    assert.equal(rows('opportunity').find((row) => row.opportunityid === SALES.emptyOpportunity).actualvalue, 70);
  });
});

// Invented lead tables: an open lead with a company name, an open lead without one and a qualified lead.
const LEADS = { open: id(80), person: id(81), closed: id(82), currency: id(83), customer: id(84) };
function leadState() {
  const state = emptyState();
  const text = { dataverseType: 'nvarchar' };
  const lookup = (target) => ({ dataverseType: 'lookup', targets: [target] });
  const statusField = (pairs) => ({
    dataverseType: 'status',
    statuses: pairs.map(([value, s]) => ({ value, state: s })),
  });
  state.mappings.lead = table('lead', 'leads', 'leadid', {
    subject: text,
    companyname: text,
    firstname: text,
    lastname: text,
    emailaddress1: text,
    qualifyingopportunityid: lookup('opportunity'),
    statecode: stateField([
      [0, 1],
      [1, 3],
      [2, 4],
    ]),
    statuscode: statusField([
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 2],
      [7, 2],
    ]),
  });
  state.mappings.account = table('account', 'accounts', 'accountid', {
    emailaddress1: text,
    originatingleadid: lookup('lead'),
    primarycontactid: lookup('contact'),
  });
  state.mappings.contact = table('contact', 'contacts', 'contactid', {
    firstname: text,
    lastname: text,
    emailaddress1: text,
    originatingleadid: lookup('lead'),
    parentcustomerid: { dataverseType: 'customer', targets: ['account', 'contact'] },
  });
  state.mappings.opportunity = table('opportunity', 'opportunities', 'opportunityid', {
    originatingleadid: lookup('lead'),
    customerid: { dataverseType: 'customer', targets: ['account', 'contact'] },
    parentaccountid: lookup('account'),
    parentcontactid: lookup('contact'),
    transactioncurrencyid: lookup('transactioncurrency'),
  });
  state.mappings.transactioncurrency = table('transactioncurrency', 'transactioncurrencies', 'transactioncurrencyid', {
    currencyname: text,
  });
  state.tables.lead = [
    {
      leadid: LEADS.open,
      subject: 'Invented interest',
      companyname: 'Invented Company',
      firstname: 'Ada',
      lastname: 'Lead',
      emailaddress1: 'ada@invented.test',
      statecode: 0,
      statuscode: 1,
    },
    { leadid: LEADS.person, subject: 'Invented person', lastname: 'Solo', statecode: 0, statuscode: 1 },
    { leadid: LEADS.closed, subject: 'Invented closed', lastname: 'Done', statecode: 1, statuscode: 3 },
  ];
  state.tables.account = [{ accountid: LEADS.customer, name: 'Invented customer' }];
  state.tables.contact = [];
  state.tables.opportunity = [];
  state.tables.transactioncurrency = [{ transactioncurrencyid: LEADS.currency, name: 'Euro', currencyname: 'Euro' }];
  return state;
}

describe('Dynamics 365 QualifyLead over HTTP', () => {
  let h;
  before(async () => {
    h = await startServer({ state: leadState() });
  });
  after(async () => {
    delete process.env[SECRET_VAR];
    await h?.close();
  });
  const rows = (logical) => h.store.state.tables[logical];
  const ref = (row, column) => String(row?.[column]?.id ?? row?.[column] ?? '').toLowerCase();
  const lead = (leadId) => rows('lead').find((row) => row.leadid === leadId);
  const qualify = (leadId, body) => h.call('POST', `/leads(${leadId})/${CRM}QualifyLead`, body);

  // @test-kind unproven: local model of QualifyLead (Learn QualifyLeadRequest and QualifyLeadResponse.CreatedEntities: the lead becomes Qualified with the given status, the created account is the contact's parent and the contact the account's primary contact); no native capture of the response or the copied columns
  it('qualifies an open lead into an account, a contact and an opportunity and answers their references', async () => {
    const answer = await qualify(LEADS.open, {
      CreateAccount: true,
      CreateContact: true,
      CreateOpportunity: true,
      OpportunityCurrencyId: { '@odata.type': `${CRM}transactioncurrency`, transactioncurrencyid: LEADS.currency },
      Status: 3,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.match(answer.body['@odata.context'], /\$metadata#Collection\(Microsoft\.Dynamics\.CRM\.crmbaseentity\)$/);
    assert.deepEqual(
      answer.body.value.map((entry) => entry['@odata.type']),
      ['#Microsoft.Dynamics.CRM.account', '#Microsoft.Dynamics.CRM.contact', '#Microsoft.Dynamics.CRM.opportunity'],
    );
    const [accountRef, contactRef, opportunityRef] = answer.body.value;
    const account = rows('account').find((row) => row.accountid === accountRef.accountid);
    const contact = rows('contact').find((row) => row.contactid === contactRef.contactid);
    const opportunity = rows('opportunity').find((row) => row.opportunityid === opportunityRef.opportunityid);
    assert.equal(account.name, 'Invented Company');
    assert.equal(account.emailaddress1, 'ada@invented.test');
    assert.equal(ref(account, 'originatingleadid'), LEADS.open);
    assert.equal(ref(account, 'primarycontactid'), contactRef.contactid);
    assert.deepEqual([contact.firstname, contact.lastname], ['Ada', 'Lead']);
    assert.equal(ref(contact, 'parentcustomerid'), accountRef.accountid);
    assert.equal(opportunity.name, 'Invented interest');
    assert.equal(ref(opportunity, 'customerid'), accountRef.accountid);
    assert.equal(ref(opportunity, 'parentcontactid'), contactRef.contactid);
    assert.equal(ref(opportunity, 'transactioncurrencyid'), LEADS.currency);
    assert.equal(ref(opportunity, 'originatingleadid'), LEADS.open);
    const qualified = lead(LEADS.open);
    assert.deepEqual([qualified.statecode, qualified.statuscode], [1, 3]);
    assert.equal(ref(qualified, 'qualifyingopportunityid'), opportunityRef.opportunityid);
  });

  // @test-kind contract: QualifyLead's Status is an Edm.Int32: a non-integer Status is refused before any write even when the lead table declares no status reasons
  it('refuses a non-integer Status on a lead table without status metadata', async () => {
    const state = leadState();
    state.mappings.lead.fields.statuscode = { dataverseType: 'status' };
    const server = await startServer({ state });
    try {
      for (const Status of ['abc', 3.5, true, null]) {
        const answer = await server.call('POST', `/leads(${LEADS.person})/${CRM}QualifyLead`, {
          CreateAccount: false,
          CreateContact: true,
          CreateOpportunity: false,
          Status,
        });
        if (Status === null) continue; // a null Status is the default status (-1)
        assert.equal(answer.status, 400, String(Status));
        assert.match(answer.body.error.message, /Status must be an integer/);
      }
      const lead = server.store.state.tables.lead.find((row) => row.leadid === LEADS.person);
      assert.equal(lead.statecode, 1, 'only the null Status qualified the lead');
      assert.equal(server.store.state.tables.contact.length, 1);
    } finally {
      await server.close();
    }
  });

  // @test-kind unproven: local model of QualifyLead refusals (an already qualified lead, a status of another state) and of the flags (no account without a company name, the given opportunity customer); refusal texts are guesses
  it('refuses a closed lead and a status of another state and creates only what the flags ask for', async () => {
    const before = [rows('account').length, rows('contact').length, rows('opportunity').length];
    const closed = await qualify(LEADS.closed, {
      CreateAccount: false,
      CreateContact: true,
      CreateOpportunity: false,
      Status: 3,
    });
    assert.equal(closed.status, 400);
    const wrongState = await qualify(LEADS.person, {
      CreateAccount: false,
      CreateContact: true,
      CreateOpportunity: false,
      Status: 7,
    });
    assert.equal(wrongState.status, 400);
    assert.match(wrongState.body.error.message, /7 is not a valid status code/);
    assert.deepEqual([rows('account').length, rows('contact').length, rows('opportunity').length], before);
    assert.deepEqual([lead(LEADS.person).statecode, lead(LEADS.person).statuscode], [0, 1]);

    const answer = await qualify(LEADS.person, {
      CreateAccount: true,
      CreateContact: false,
      CreateOpportunity: true,
      OpportunityCustomerId: { '@odata.type': `${CRM}account`, accountid: LEADS.customer },
      Status: -1,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    // The lead has no company name: no account; the opportunity's customer is the given account.
    assert.deepEqual(
      answer.body.value.map((entry) => entry['@odata.type']),
      ['#Microsoft.Dynamics.CRM.opportunity'],
    );
    const opportunity = rows('opportunity').find((row) => row.opportunityid === answer.body.value[0].opportunityid);
    assert.equal(ref(opportunity, 'customerid'), LEADS.customer);
    assert.equal(rows('account').length, before[0]);
    assert.deepEqual([lead(LEADS.person).statecode, lead(LEADS.person).statuscode], [1, 3]);
  });
});
