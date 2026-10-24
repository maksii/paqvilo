import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION, validateTransitions } from '../lib/dataverse-state-transitions.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';

const TICKET = '55555555-5555-4555-8555-555555555555';
const PLAIN = '66666666-6666-4666-8666-666666666666';
const text = { dataverseType: 'nvarchar' };
const STATECODE = {
  dataverseType: 'int',
  options: [
    { value: 0, label: 'Active', invariantName: 'Active' },
    { value: 1, label: 'Inactive', invariantName: 'Inactive' },
  ],
};
// Status 1 allows 2 and 5; 2 allows 1 and 5; 5 lists no TransitionData (any target); 6 allows 1 only; 3 and 4 are inactive.
const STATUSCODE = {
  dataverseType: 'picklist',
  options: [
    { value: 1, label: 'New', state: 0, TransitionData: [2, 5] },
    { value: 2, label: 'Working', state: 0, TransitionData: [1, 5] },
    { value: 5, label: 'Waiting', state: 0 },
    { value: 6, label: 'Parked', state: 0, TransitionData: [1] },
    { value: 3, label: 'Done', state: 1, TransitionData: [] },
    { value: 4, label: 'Cancelled', state: 1, TransitionData: [] },
  ],
};
const mappings = {
  x_ticket: {
    logicalName: 'x_ticket',
    entitySet: 'x_tickets',
    idColumn: 'x_ticketid',
    nameColumn: 'x_name',
    dataverseMetadata: { EnforceStateTransitions: true },
    relationships: {},
    fields: { x_name: text, statecode: STATECODE, statuscode: STATUSCODE },
  },
  x_plain: {
    logicalName: 'x_plain',
    entitySet: 'x_plains',
    idColumn: 'x_plainid',
    nameColumn: 'x_name',
    relationships: {},
    fields: { x_name: text, statecode: STATECODE, statuscode: STATUSCODE },
  },
};
const seed = (status = 1) => ({
  x_ticket: [{ x_ticketid: TICKET, x_name: 'Invented ticket', statecode: 0, statuscode: status }],
  x_plain: [{ x_plainid: PLAIN, x_name: 'Invented plain', statecode: 0, statuscode: status }],
});

async function setup(t, { status = 1, options = {} } = {}) {
  const diagnostics = [];
  const tables = seed(status);
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables,
    extension: EXTENSION,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  const rowOf = (table, id) => fixture.store.state.tables[table].find((row) => row[`${table}id`] === id);
  return { ...fixture, diagnostics, rowOf };
}

// A refused write answers 400 with the documented inner code; the envelope carries it as error.code.
async function refused(response, pattern) {
  const raw = await response.text();
  assert.equal(response.status, 400, raw);
  const body = JSON.parse(raw);
  assert.equal(String(body.error.code).toLowerCase(), '0x8004f00e');
  if (pattern) assert.match(body.error.message, pattern);
  return body;
}

const patch = (request, table, id, body) => request('PATCH', `/${table}s(${id})`, body);

test('an allowed status change on an enforced table is stored', async (t) => {
  const { request, json, rowOf } = await setup(t);
  await json(await patch(request, 'x_ticket', TICKET, { statuscode: 2 }), 200);
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 2);
});

test('a status change the current status does not allow is refused and stores nothing', async (t) => {
  const { request, rowOf } = await setup(t);
  await refused(await patch(request, 'x_ticket', TICKET, { statuscode: 6 }));
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 1);
});

test('a PATCH that changes the state to an allowed status in that state is stored', async (t) => {
  // Update (PATCH of statecode/statuscode) is the Web API way to change state; only the allowed-target list applies.
  const { request, json, rowOf } = await setup(t, { status: 5, options: { transitions: { x_ticket: { 5: [3] } } } });
  await json(await patch(request, 'x_ticket', TICKET, { statecode: 1, statuscode: 3 }), 200);
  assert.equal(rowOf('x_ticket', TICKET).statecode, 1);
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 3);
});

test('a state change to a status that is not allowed is refused whichever state it belongs to', async (t) => {
  const { request, rowOf } = await setup(t, { status: 5, options: { transitions: { x_ticket: { 5: [3] } } } });
  await refused(await patch(request, 'x_ticket', TICKET, { statecode: 1, statuscode: 4 }), /do not include 4/);
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 5);
  assert.equal(rowOf('x_ticket', TICKET).statecode, 0);
});

test('SOAP SetState on an enforced table changes the state through the same check', async (t) => {
  const { server, rowOf } = await setup(t, { status: 5, options: { transitions: { x_ticket: { 5: [3] } } } });
  // The fixture's application (contract-module-fixture.mjs APP_ID and secret) signs in for the SOAP endpoint.
  const token = await (
    await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: '77777777-7777-4777-8777-777777777777',
        client_secret: 'contract-module-secret',
        scope: `${server.origin}/.default`,
      }),
    })
  ).json();
  const DECL = Object.entries(NS)
    .map(([p, uri]) => `xmlns:${p}="${uri}"`)
    .join(' ');
  const option = (key, value) =>
    `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key><b:value i:type="a:OptionSetValue"><a:Value>${value}</a:Value></b:value></a:KeyValuePairOfstringanyType>`;
  const setState = (status) =>
    fetch(`${server.origin}/XRMServices/2011/Organization.svc/web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.access_token}`, 'content-type': 'text/xml; charset=utf-8' },
      body:
        `<s:Envelope ${DECL}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:SetStateRequest"><a:Parameters>` +
        `<a:KeyValuePairOfstringanyType><b:key>EntityMoniker</b:key><b:value i:type="a:EntityReference"><a:Id>${TICKET}</a:Id><a:LogicalName>x_ticket</a:LogicalName><a:Name i:nil="true"/></b:value></a:KeyValuePairOfstringanyType>` +
        `${option('State', 1)}${option('Status', status)}</a:Parameters><a:RequestName>SetState</a:RequestName></request></Execute></s:Body></s:Envelope>`,
    });
  const refusedSoap = await setState(4);
  const fault = await refusedSoap.text();
  assert.equal(refusedSoap.status, 500, fault);
  assert.match(fault, /<ErrorCode>-2147160050<\/ErrorCode>/);
  assert.match(
    fault,
    /<Message>The status of x_ticket cannot change from 5 to 4: the transitions allowed from status 5 do not include 4\.<\/Message>/,
  );
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 5);
  const accepted = await setState(3);
  const text = await accepted.text();
  assert.equal(accepted.status, 200, text);
  assert.match(text, /SetStateResponse/);
  assert.equal(rowOf('x_ticket', TICKET).statecode, 1);
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 3);
});

test('writing the current status and state again is not a transition', async (t) => {
  // Status 1 does not list itself among its targets, so a check that treated this as a change would refuse it.
  const { request, json, rowOf, diagnostics } = await setup(t);
  await json(await patch(request, 'x_ticket', TICKET, { statuscode: 1, statecode: 0 }), 200);
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 1);
  assert.deepEqual(diagnostics, []);
});

test('a table without enforcement is untouched', async (t) => {
  const { request, json, rowOf, diagnostics } = await setup(t);
  await json(await patch(request, 'x_plain', PLAIN, { statuscode: 3, statecode: 1 }), 200);
  assert.equal(rowOf('x_plain', PLAIN).statuscode, 3);
  assert.equal(rowOf('x_plain', PLAIN).statecode, 1, 'a plain table takes the state change with the status');
  assert.equal(diagnostics.filter((entry) => entry.table === 'x_plain').length, 0);
});

test('a status without TransitionData allows any same-state change and reports it once', async (t) => {
  const { request, json, rowOf, diagnostics, store } = await setup(t, { status: 5 });
  await json(await patch(request, 'x_ticket', TICKET, { statuscode: 2 }), 200);
  store.state.tables.x_ticket[0].statuscode = 5;
  await json(await patch(request, 'x_ticket', TICKET, { statuscode: 1 }), 200);
  assert.equal(rowOf('x_ticket', TICKET).statuscode, 1);
  assert.equal(
    diagnostics.filter((entry) => entry.code === 'STATE_TRANSITIONS_UNCONFIGURED' && entry.status === 5).length,
    1,
  );
});

test('explicit transitions win over the metadata and enforce a table without the flag', async (t) => {
  const { request, json, rowOf } = await setup(t, { options: { transitions: { x_plain: { 1: [5] } } } });
  await refused(await patch(request, 'x_plain', PLAIN, { statuscode: 2 }));
  assert.equal(rowOf('x_plain', PLAIN).statuscode, 1, 'the metadata lists 2 for status 1, the explicit map does not');
  await json(await patch(request, 'x_plain', PLAIN, { statuscode: 5 }), 200);
  assert.equal(rowOf('x_plain', PLAIN).statuscode, 5);
});

const isValid = async ({ request, json }, entitySet, id, status, state) => {
  const entity = encodeURIComponent(JSON.stringify({ '@odata.id': `${entitySet}(${id})` }));
  const response = await request(
    'GET',
    `/IsValidStateTransition(Entity=@e,NewState='${state}',NewStatus=${status})?@e=${entity}`,
  );
  return (await json(response, 200))['IsValid'];
};

test('IsValidStateTransition answers with the same rule on an enforced table, and a plain table keeps the record-messages answer', async (t) => {
  const fixture = await setup(t);
  const check = (status, state) => isValid(fixture, 'x_tickets', TICKET, status, state);
  assert.equal(await check(2, '0'), true, 'status 1 allows 2, an Active target');
  assert.equal(await check(5, '0'), true, 'status 1 allows 5');
  assert.equal(await check(6, '0'), false, 'status 1 does not allow 6');
  assert.equal(await check(3, '1'), false, 'status 1 does not allow 3');
  assert.equal(await check(2, '1'), false, 'the state must match the target status option');
  assert.equal(
    await isValid(fixture, 'x_plains', PLAIN, 3, '1'),
    false,
    'status 1 lists [2, 5] as its targets by metadata',
  );
});

test('IsValidStateTransition follows explicit transitions on a table that enforces them', async (t) => {
  const fixture = await setup(t, { options: { transitions: { x_plain: { 1: [5] } } } });
  assert.equal(
    await isValid(fixture, 'x_plains', PLAIN, 2, '0'),
    false,
    'the metadata lists 2, the explicit map does not',
  );
  assert.equal(await isValid(fixture, 'x_plains', PLAIN, 5, '0'), true, 'the explicit map lists 5');
});

test('the validator accepts the documented shape and rejects bad shapes', () => {
  assert.deepEqual(validateTransitions(undefined), {});
  assert.deepEqual(validateTransitions({ X_Ticket: { 1: [2, 2, 5], 3: [] } }), { x_ticket: { 1: [2, 5], 3: [] } });
  assert.throws(() => validateTransitions([]), /map table names/);
  assert.throws(() => validateTransitions({ 'bad table': { 1: [2] } }), /table logical name/);
  assert.throws(() => validateTransitions({ x_ticket: [1] }), /map statuscodes/);
  assert.throws(() => validateTransitions({ x_ticket: { one: [2] } }), /whole number/);
  assert.throws(() => validateTransitions({ x_ticket: { 1: 2 } }), /array of statuscode integers/);
  assert.throws(() => validateTransitions({ x_ticket: { 1: ['2'] } }), /array of statuscode integers/);
  assert.throws(() => validateTransitions({ x_ticket: { 1: [-1] } }), /array of statuscode integers/);
  assert.throws(() => validateTransitions({ x_ticket: {}, X_TICKET: {} }), /repeats table/);
});

test('describe reports a behaviour level with the metadata requirement', () => {
  const record = EXTENSION.describe();
  assert.equal(record.level, 'behaviour');
  assert.deepEqual(record.requires, ['metadata:TransitionData']);
  assert.deepEqual(record.operations, ['StatusTransition', 'IsValidStateTransition']);
});
