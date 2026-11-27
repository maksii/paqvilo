// Business rules (lib/dataverse-business-rules.mjs) by scope and action: an Entity-scope rule runs on the server for every
// write surface (the Web API and the portal's internal record pipeline) and applies exactly the actions Learn lists for all
// scopes; the model-driven-only actions and the form scopes have no server behaviour.
// @test-kind compatibility: Learn https://learn.microsoft.com/power-apps/maker/data-platform/data-platform-create-business-rule (scope Entity = "Model-driven app forms and server"; set, clear, default and error actions) and https://learn.microsoft.com/power-apps/maker/model-driven-apps/create-business-rules-recommendations-apply-logic-form ("Actions that only apply to model-driven apps are ignored when the rule is run server-side.")
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION } from '../lib/dataverse-business-rules.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const TICKET = '55555555-5555-4555-8555-555555555501';
const rid = (n) => `55555555-5555-4555-8555-5555555556${String(n).padStart(2, '0')}`;
const rule = (n, name, xaml, extra = {}) => ({
  workflowid: rid(n),
  name,
  category: 2,
  type: 1,
  statecode: 1,
  statuscode: 2,
  primaryentity: 'x_ticket',
  processtriggerscope: 2,
  xaml,
  ...extra,
});
const when = (condition, then, otherwise = '') =>
  `<Activity><ConditionBranchStep>${condition}<Then>${then}</Then>${otherwise ? `<Else>${otherwise}</Else>` : ''}</ConditionBranchStep></Activity>`;

const mappings = {
  x_ticket: {
    logicalName: 'x_ticket',
    entitySet: 'x_tickets',
    idColumn: 'x_ticketid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_severity: { dataverseType: 'int' },
      x_queue: { dataverseType: 'nvarchar' },
      x_source: { dataverseType: 'nvarchar' },
      x_note: { dataverseType: 'nvarchar' },
      x_owner_hint: { dataverseType: 'nvarchar' },
    },
  },
};
const seeded = {
  x_ticketid: TICKET,
  x_name: 'Seeded',
  x_severity: 1,
  x_queue: 'general',
  x_note: 'keep',
  statecode: 0,
  statuscode: 1,
};

async function setup(t, rules) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables: { x_ticket: [seeded], workflow: rules },
    extension: EXTENSION,
    options: { diagnostic: (entry) => diagnostics.push(entry) },
  });
  const stored = (id) => fixture.store.state.tables.x_ticket.find((row) => row.x_ticketid === id) ?? null;
  const named = (name) => fixture.store.state.tables.x_ticket.find((row) => row.x_name === name) ?? null;
  // A portal write: the internal record pipeline the portal /_api and forms call (webapi-handler.mjs, form-service.mjs).
  const portal = { identity: { admin: true }, portal: true, caller: null, method: 'POST', headers: {} };
  const options = { authorized: true, writeOptions: { dataverseWebApi: false } };
  const portalCreate = (data) => fixture.store.recordPipeline.createInternal(portal, 'x_ticket', data, options);
  const portalUpdate = (id, data) =>
    fixture.store.recordPipeline.updateInternal({ ...portal, method: 'PATCH' }, 'x_ticket', id, data, options);
  return { ...fixture, diagnostics, stored, named, portalCreate, portalUpdate };
}

const SET = rule(
  1,
  'Severity routes the queue',
  when(
    '<Condition Attribute="x_severity" Operator="ge" Value="3"/>',
    '<SetAttributeValueStep Attribute="x_queue" Value="&quot;urgent&quot;"/>',
    '<SetAttributeValueStep Attribute="x_queue" Value="&quot;general&quot;"/>',
  ),
);
const CLEAR = rule(
  2,
  'Closed tickets clear the note',
  when(
    '<Condition Attribute="x_name" Operator="eq" Value="&quot;Closed&quot;"/>',
    '<SetAttributeValueStep Attribute="x_note"/>',
  ),
);
const DEFAULT = rule(
  3,
  'Source defaults to web',
  '<Activity><SetDefaultValueStep Attribute="x_source" Value="&quot;web&quot;"/></Activity>',
);
const ERROR = rule(
  4,
  'Severity is bounded',
  when(
    '<Condition Attribute="x_severity" Operator="gt" Value="5"/>',
    '<SetMessageStep Attribute="x_severity" Message="Severity must be 5 or less."/>',
  ),
);

test('set field value runs on the server on create and update, through the Web API and the portal pipeline', async (t) => {
  const { request, json, stored, named, portalCreate, portalUpdate } = await setup(t, [SET]);
  const api = await json(await request('POST', '/x_tickets', { x_name: 'Api', x_severity: 4 }), 201);
  assert.equal(api.x_queue, 'urgent');
  await portalCreate({ x_name: 'Portal', x_severity: 2 });
  assert.equal(named('Portal').x_queue, 'general');
  await json(await request('PATCH', `/x_tickets(${TICKET})`, { x_severity: 3 }), 200);
  assert.equal(stored(TICKET).x_queue, 'urgent', 'the condition reads the merged row on update');
  await portalUpdate(TICKET, { x_severity: 1 });
  assert.equal(stored(TICKET).x_queue, 'general');
});

test('set field value without a value clears the column ("You can also clear the value of the field")', async (t) => {
  const { request, json, stored, portalUpdate } = await setup(t, [CLEAR]);
  await json(await request('PATCH', `/x_tickets(${TICKET})`, { x_severity: 2 }), 200);
  assert.equal(stored(TICKET).x_note, 'keep');
  await portalUpdate(TICKET, { x_name: 'Closed' });
  assert.equal(stored(TICKET).x_note, null);
});

test('set default value sets the column only when it has no value (null)', async (t) => {
  const { request, json, named, portalCreate } = await setup(t, [DEFAULT]);
  const empty = await json(await request('POST', '/x_tickets', { x_name: 'Empty' }), 201);
  assert.equal(empty.x_source, 'web');
  const given = await json(await request('POST', '/x_tickets', { x_name: 'Given', x_source: 'phone' }), 201);
  assert.equal(given.x_source, 'phone');
  await portalCreate({ x_name: 'Portal empty' });
  assert.equal(named('Portal empty').x_source, 'web');
});

test('show error message prevents the save and passes the message back to the caller, on every surface', async (t) => {
  const { request, json, stored, named, portalCreate, portalUpdate } = await setup(t, [ERROR]);
  const created = await json(await request('POST', '/x_tickets', { x_name: 'Too high', x_severity: 9 }), 400);
  assert.equal(created.error.message, 'Severity must be 5 or less.');
  assert.equal(named('Too high'), null);
  await assert.rejects(portalCreate({ x_name: 'Portal too high', x_severity: 6 }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message, 'Severity must be 5 or less.');
    return true;
  });
  assert.equal(named('Portal too high'), null);
  await assert.rejects(portalUpdate(TICKET, { x_severity: 7 }), /Severity must be 5 or less/);
  assert.equal(stored(TICKET).x_severity, 1, 'the update rolled back');
});

test('lock/unlock, set visibility, set business required and recommendations have no server behaviour at Entity scope', async (t) => {
  const CLIENT = rule(
    5,
    'Form-only actions',
    '<Activity><SetDisplayModeStep Attribute="x_queue" IsReadOnly="true"/><SetVisibilityStep Attribute="x_note" Visible="false"/>' +
      '<SetFieldRequiredLevelStep Attribute="x_owner_hint" RequiredLevel="required"/>' +
      '<RecommendationStep><SetAttributeValueStep Attribute="x_queue" Value="&quot;recommended&quot;"/></RecommendationStep>' +
      '<SetAttributeValueStep Attribute="x_source" Value="&quot;rule&quot;"/></Activity>',
  );
  const { request, json, named, portalCreate, diagnostics } = await setup(t, [CLIENT]);
  const created = await json(await request('POST', '/x_tickets', { x_name: 'Client', x_queue: 'general' }), 201);
  assert.equal(created.x_queue, 'general', 'a recommendation sets values only when a form user accepts it');
  assert.equal(created.x_owner_hint ?? null, null, 'set business required does not refuse the empty column');
  assert.equal(created.x_source, 'rule', "the rule's server action still runs");
  await portalCreate({ x_name: 'Portal client' });
  assert.equal(named('Portal client').x_source, 'rule');
  const client = diagnostics.filter((entry) => entry.code === 'BUSINESS_RULE_CLIENT_ONLY');
  assert.equal(client.length, 1, 'reported once per rule');
  assert.deepEqual(client[0].actions, [
    'setdisplaymodestep',
    'setvisibilitystep',
    'setfieldrequiredlevelstep',
    'recommendationstep',
  ]);
});

test('All Forms and specific-form scopes never run on the server', async (t) => {
  const allForms = rule(6, 'All forms', '<Activity><SetMessageStep Message="all forms only"/></Activity>', {
    processtriggerscope: 1,
  });
  const oneForm = rule(
    7,
    'One form',
    '<Activity><SetAttributeValueStep Attribute="x_queue" Value="&quot;form&quot;"/></Activity>',
    {
      processtriggerscope: 3,
      processtriggerformid: '55555555-5555-4555-8555-555555555599',
    },
  );
  const { request, json, named, portalCreate, diagnostics } = await setup(t, [allForms, oneForm]);
  const created = await json(await request('POST', '/x_tickets', { x_name: 'Forms', x_queue: 'general' }), 201);
  assert.equal(created.x_queue, 'general');
  await portalCreate({ x_name: 'Portal forms', x_queue: 'general' });
  assert.equal(named('Portal forms').x_queue, 'general');
  assert.deepEqual(diagnostics, []);
});

// @test-kind unproven: Learn's business-rule articles name AND/OR rule logic and the then/else branches but no operator list; the operator subset and its blank and text semantics are the simulator's local model
test('condition operators and AND/OR rule logic choose the then or else branch', async (t) => {
  const cases = [
    ['eq', '"general"', { x_queue: 'GENERAL' }, true], // text compares case-insensitively
    ['eq', '"general"', { x_queue: 'other' }, false],
    ['ne', '"general"', { x_queue: 'other' }, true],
    ['gt', '2', { x_severity: 3 }, true],
    ['gt', '2', { x_severity: 2 }, false],
    ['ge', '2', { x_severity: 2 }, true],
    ['lt', '2', { x_severity: 1 }, true],
    ['lt', '2', { x_severity: null }, false], // an empty column satisfies no ordering comparison
    ['le', '2', { x_severity: 2 }, true],
    ['null', null, { x_note: null }, true],
    ['null', null, { x_note: 'x' }, false],
    ['not-null', null, { x_note: 'x' }, true],
  ];
  const column = { eq: 'x_queue', ne: 'x_queue', null: 'x_note', 'not-null': 'x_note' };
  // One rule per case, each gated (AND) on its own row name, so every rule is active and only its case's write matches.
  const rules = cases.map(([operator, value], index) =>
    rule(
      20 + index,
      `operator ${index}`,
      `<Activity><ConditionBranchStep Logic="and"><Condition Attribute="x_name" Operator="eq" Value="&quot;op ${index}&quot;"/>` +
        `<Condition Attribute="${column[operator] ?? 'x_severity'}" Operator="${operator}"${value === null ? '' : ` Value="${value.replaceAll('"', '&quot;')}"`}/>` +
        '<Then><SetAttributeValueStep Attribute="x_source" Value="&quot;then&quot;"/></Then></ConditionBranchStep></Activity>',
    ),
  );
  const { request, json } = await setup(t, rules);
  const results = [];
  for (const [index, [operator, , data]] of cases.entries()) {
    const created = await json(await request('POST', '/x_tickets', { x_name: `op ${index}`, ...data }), 201);
    results.push([operator, created.x_source === 'then']);
  }
  assert.deepEqual(
    results,
    cases.map(([operator, , , expected]) => [operator, expected]),
  );

  const logic = (kind) =>
    rule(
      40,
      `logic ${kind}`,
      `<Activity><ConditionBranchStep Logic="${kind}"><Condition Attribute="x_severity" Operator="ge" Value="3"/>` +
        '<Condition Attribute="x_queue" Operator="eq" Value="&quot;vip&quot;"/>' +
        '<Then><SetAttributeValueStep Attribute="x_source" Value="&quot;then&quot;"/></Then>' +
        '<Else><SetAttributeValueStep Attribute="x_source" Value="&quot;else&quot;"/></Else></ConditionBranchStep></Activity>',
    );
  for (const [kind, expected] of [
    ['and', 'else'],
    ['or', 'then'],
  ]) {
    const own = await setup(t, [logic(kind)]);
    const created = await own.json(
      await own.request('POST', '/x_tickets', { x_name: kind, x_severity: 4, x_queue: 'general' }),
      201,
    );
    assert.equal(created.x_source, expected, kind);
  }
});
