// @test-kind compatibility: Microsoft.Xrm.Sdk / Microsoft.Crm.Sdk.Proxy message contracts (WhoAmI, RetrieveVersion, ExecuteMultiple, ExecuteTransaction, RetrieveEntity, ConcurrencyBehavior) answered on the plug-in SDK drive; no native capture of these messages from a plug-in yet
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkFault } from '../lib/plugin-sdk-messages.mjs';
import { DataError } from '../lib/data-error.mjs';

const objectId = '70000000-0000-0000-0000-000000000001';

async function organization(t) {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const runtime = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: true,
      version: '9.2.99.1',
      users: [
        { objectId, domainname: 'caller@invented.test', fullname: 'Invented caller', roles: ['System Administrator'] },
      ],
    }),
  });
  t.after(() => runtime.close());
  const user = store.tableRows('systemuser').find((row) => row.fullname === 'Invented caller');
  const profile = {
    userId: user.systemuserid,
    evidence: 'Invented SDK organization message caller',
    grants: [{ entity: 'x_item', operations: ['read', 'create', 'update', 'delete'] }],
  };
  const execute = (requestName, values) =>
    store.withOperationContext(() =>
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Execute',
          userId: user.systemuserid,
          arguments: [
            { $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } },
          ],
        },
      }),
    );
  return { store, user, execute };
}
const item = (title, id = '00000000-0000-0000-0000-000000000000', extra = {}) => ({
  $type: 'Entity',
  logicalName: 'x_item',
  id,
  attributes: { x_name: title },
  ...extra,
});
const request = (requestName, values) => ({
  $type: 'OrganizationRequest',
  requestName,
  parameters: { $type: 'ParameterCollection', values },
});

test('WhoAmI and RetrieveVersion answer the service user and the organization version', async (t) => {
  const { store, user, execute } = await organization(t);
  const who = execute('WhoAmI', {});
  assert.equal(who.responseName, 'WhoAmI');
  assert.equal(who.results.UserId.value, user.systemuserid);
  assert.equal(who.results.BusinessUnitId.value, user.businessunitid?.id ?? user.businessunitid);
  assert.ok(who.results.OrganizationId.value);
  assert.equal(execute('RetrieveVersion', {}).results.Version, '9.2.99.1');
  assert.throws(() => execute('WhoAmI', { Unexpected: 1 }), /Unsupported SDK WhoAmI parameter/);
  assert.equal(store.tableRows('x_item').length, 0);
});

test('ExecuteMultiple runs each request, reports faults per item and honours ContinueOnError', async (t) => {
  const { store, execute } = await organization(t);
  const settings = (continueOnError, returnResponses) => ({
    $type: 'Object',
    type: 'Microsoft.Xrm.Sdk.ExecuteMultipleSettings',
    members: { ContinueOnError: continueOnError, ReturnResponses: returnResponses },
  });
  const requests = (...items) => ({
    $type: 'Collection',
    type: 'Microsoft.Xrm.Sdk.OrganizationRequestCollection',
    values: items,
  });
  const missing = { $type: 'EntityReference', logicalName: 'x_item', id: '80000000-0000-0000-0000-000000000009' };
  const answer = execute('ExecuteMultiple', {
    Requests: requests(
      request('Create', { Target: item('first') }),
      request('Delete', { Target: missing }),
      request('Create', { Target: item('third') }),
    ),
    Settings: settings(true, true),
  });
  assert.equal(answer.results.IsFaulted, true);
  const items = answer.results.Responses.values;
  assert.equal(answer.results.Responses.type, 'Microsoft.Xrm.Sdk.ExecuteMultipleResponseItemCollection');
  assert.deepEqual(
    items.map((entry) => entry.members.RequestIndex),
    [0, 1, 2],
  );
  assert.equal(items[0].members.Response.responseName, 'Create');
  assert.equal(items[1].members.Fault.errorCode, 0x80040217 | 0);
  assert.equal(store.tableRows('x_item').length, 2);
  // Without ContinueOnError the batch stops at the faulted item; without ReturnResponses only faults are returned.
  const stopped = execute('ExecuteMultiple', {
    Requests: requests(request('Delete', { Target: missing }), request('Create', { Target: item('never') })),
    Settings: settings(false, false),
  });
  assert.deepEqual(
    stopped.results.Responses.values.map((entry) => entry.members.RequestIndex),
    [0],
  );
  assert.equal(store.tableRows('x_item').length, 2);
  assert.throws(
    () => execute('ExecuteMultiple', { Requests: [], Settings: settings(false, false) }),
    (error) => error.details?.innerCode === '0x80040203',
  );
});

test('ExecuteTransaction commits all requests or none and names the faulted request', async (t) => {
  const { store, execute } = await organization(t);
  const requests = (...items) => ({
    $type: 'Collection',
    type: 'Microsoft.Xrm.Sdk.OrganizationRequestCollection',
    values: items,
  });
  const done = execute('ExecuteTransaction', {
    Requests: requests(request('Create', { Target: item('one') }), request('Create', { Target: item('two') })),
    ReturnResponses: true,
  });
  assert.equal(done.results.Responses.type, 'Microsoft.Xrm.Sdk.OrganizationResponseCollection');
  assert.equal(done.results.Responses.values.length, 2);
  assert.equal(store.tableRows('x_item').length, 2);
  const missing = { $type: 'EntityReference', logicalName: 'x_item', id: '80000000-0000-0000-0000-000000000009' };
  let failure;
  try {
    execute('ExecuteTransaction', {
      Requests: requests(request('Create', { Target: item('rolled back') }), request('Delete', { Target: missing })),
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.faultedRequestIndex, 1);
  assert.equal(sdkFault(failure).faultedRequestIndex, 1);
  assert.equal(store.tableRows('x_item').length, 2, 'the first request of the failed transaction rolled back');
});

test('RetrieveEntity answers the SOAP Execute XML of RetrieveEntityResponse', async (t) => {
  const { execute } = await organization(t);
  const answer = execute('RetrieveEntity', {
    LogicalName: 'x_item',
    EntityFilters: { $type: 'Enum', type: 'Microsoft.Xrm.Sdk.Metadata.EntityFilters', value: 1 },
    MetadataId: { $type: 'Guid', value: '00000000-0000-0000-0000-000000000000' },
    RetrieveAsIfPublished: false,
  });
  assert.equal(answer.$type, 'OrganizationResponseXml');
  assert.match(answer.xml, /<svc:ExecuteResult [^>]*i:type="r:RetrieveEntityResponse"/);
  assert.match(answer.xml, /<b:key>EntityMetadata<\/b:key>/);
  assert.match(answer.xml, /x_item/);
  assert.throws(
    () => execute('RetrieveEntity', { LogicalName: 'x_nope', EntityFilters: { $type: 'Enum', type: 'x', value: 1 } }),
    (error) => error.details?.innerCode === '0x80040217',
  );
});

test('Update and Delete with ConcurrencyBehavior IfRowVersionMatches check the stored row version', async (t) => {
  const { store, execute } = await organization(t);
  const id = execute('Create', { Target: item('versioned') }).results.id.value;
  const version = String(store.tableRows('x_item')[0].versionnumber);
  const behavior = (value) => ({ $type: 'ConcurrencyBehavior', value });
  assert.throws(
    () => execute('Update', { Target: item('no version', id), ConcurrencyBehavior: behavior(1) }),
    (error) => error.details?.innerCode === '0x80060883',
  );
  assert.throws(
    () =>
      execute('Update', {
        Target: item('stale', id, { rowVersion: String(Number(version) - 1) }),
        ConcurrencyBehavior: behavior(1),
      }),
    (error) => error.details?.innerCode === '0x80060882',
  );
  assert.equal(store.tableRows('x_item')[0].x_name, 'versioned');
  execute('Update', { Target: item('matched', id, { rowVersion: version }), ConcurrencyBehavior: behavior(1) });
  assert.equal(store.tableRows('x_item')[0].x_name, 'matched');
  execute('Update', { Target: item('overwritten', id), ConcurrencyBehavior: behavior(2) });
  assert.equal(store.tableRows('x_item')[0].x_name, 'overwritten');
  const current = String(store.tableRows('x_item')[0].versionnumber);
  assert.throws(
    () =>
      execute('Delete', {
        Target: { $type: 'EntityReference', logicalName: 'x_item', id, rowVersion: version },
        ConcurrencyBehavior: behavior(1),
      }),
    (error) => error.details?.innerCode === '0x80060882',
  );
  execute('Delete', {
    Target: { $type: 'EntityReference', logicalName: 'x_item', id, rowVersion: current },
    ConcurrencyBehavior: behavior(1),
  });
  assert.equal(store.tableRows('x_item').length, 0);
  // SuppressDuplicateDetection and SolutionUniqueName are accepted request inputs of Create and Update.
  execute('Create', {
    Target: item('suppressed'),
    SuppressDuplicateDetection: true,
    SolutionUniqueName: 'InventedSolution',
  });
  assert.equal(store.tableRows('x_item').length, 1);
  assert.throws(
    () => execute('Create', { Target: item('x'), SuppressDuplicateDetection: 'yes' }),
    /requires a boolean/,
  );
});

test('organization failures map to the OrganizationServiceFault code the Web API answers', () => {
  assert.equal(sdkFault(new DataError('gone', 404, 'NotFound')).errorCode, 0x80040217 | 0);
  assert.equal(
    sdkFault(new DataError('denied', 403, 'PrivilegeDenied', { innerCode: '0x80040220' })).errorCode,
    0x80040220 | 0,
  );
  // A failure without its own code takes the code its status answers on the Web API.
  assert.equal(typeof sdkFault(new DataError('denied', 403, 'LocalBackendPermissionDenied')).errorCode, 'number');
  // Local adapter gaps (501) and programming errors are not organization faults.
  assert.equal(sdkFault(new DataError('gap', 501, 'LocalPluginSdkUnsupported')), null);
  assert.equal(sdkFault(new TypeError('bug')), null);
});

// Invented 1:N (x_parent -> x_child through x_parentid) and N:N (x_parent <-> x_tag through x_parent_tag) relationships.
function relatedStore() {
  const state = emptyState();
  state.mappings.x_parent = {
    entitySet: 'x_parents',
    idColumn: 'x_parentid',
    relationships: {
      children: { schemaName: 'x_parent_child', entity: 'x_child', from: 'x_parentid', to: 'x_parentid', many: true },
      tags: {
        schemaName: 'x_parent_tag',
        entity: 'x_tag',
        from: 'x_parentid',
        to: 'x_tagid',
        many: true,
        intersect: { entity: 'x_parent_tag', from: 'x_parentid', to: 'x_tagid' },
      },
    },
  };
  state.mappings.x_child = {
    entitySet: 'x_children',
    idColumn: 'x_childid',
    relationships: {
      parent: { schemaName: 'x_parent_child', entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false },
    },
  };
  state.mappings.x_tag = { entitySet: 'x_tags', idColumn: 'x_tagid' };
  state.mappings.x_parent_tag = { entitySet: 'x_parent_tags', idColumn: 'x_parent_tagid' };
  for (const table of ['x_parent', 'x_child', 'x_tag', 'x_parent_tag']) state.tables[table] = [];
  const store = new DataStore({ state });
  const profile = {
    userId: '74000000-0000-0000-0000-000000000001',
    evidence: 'Invented deep insert caller',
    grants: ['x_parent', 'x_child', 'x_tag', 'x_parent_tag'].map((entity) => ({
      entity,
      operations: ['read', 'create', 'update', 'delete', 'associate'],
    })),
  };
  const call = (method, args) =>
    store.withOperationContext(() =>
      dispatchSdkCall({ store, profile, message: { method, userId: profile.userId, arguments: args } }),
    );
  return { store, call };
}
const row = (logicalName, attributes, relatedEntities) => ({
  $type: 'Entity',
  logicalName,
  id: '00000000-0000-0000-0000-000000000000',
  attributes,
  ...(relatedEntities ? { relatedEntities } : {}),
});
const related = (schemaName, rows) => ({
  relationship: { $type: 'Relationship', schemaName },
  entities: { $type: 'EntityCollection', entities: rows },
});

test('Create with RelatedEntities creates 1:N rows with their lookup and associates N:N rows', () => {
  const { store, call } = relatedStore();
  const parent = call('Create', [
    row('x_parent', { x_name: 'parent' }, [
      related('x_parent_child', [row('x_child', { x_name: 'first' }), row('x_child', { x_name: 'second' })]),
      related('x_parent_tag', [row('x_tag', { x_name: 'tagged' })]),
    ]),
  ]).value;
  const children = store.tableRows('x_child');
  assert.deepEqual(children.map((child) => child.x_name).sort(), ['first', 'second']);
  assert.ok(children.every((child) => (child.x_parentid?.id ?? child.x_parentid) === parent));
  assert.equal(store.tableRows('x_tag').length, 1);
  assert.equal(store.tableRows('x_parent_tag').length, 1);
  // A child created through its N:1 relationship exists before the row that looks it up.
  const child = call('Create', [
    row('x_child', { x_name: 'orphan' }, [related('x_parent_child', [row('x_parent', { x_name: 'made first' })])]),
  ]).value;
  const made = store.tableRows('x_parent').find((item) => item.x_name === 'made first');
  const orphan = store.tableRows('x_child').find((item) => item.x_childid === child);
  assert.equal(orphan.x_parentid?.id ?? orphan.x_parentid, made.x_parentid);
  assert.throws(
    () => call('Create', [row('x_parent', { x_name: 'bad' }, [related('x_nope', [row('x_child', {})])])]),
    (error) => error.details?.innerCode === '0x80040203',
  );
});

test('Retrieve with RelatedEntitiesQuery returns the related rows of each relationship', () => {
  const { call } = relatedStore();
  const parent = call('Create', [
    row('x_parent', { x_name: 'parent' }, [
      related('x_parent_child', [row('x_child', { x_name: 'a' }), row('x_child', { x_name: 'b' })]),
    ]),
  ]).value;
  call('Create', [row('x_child', { x_name: 'unrelated' })]);
  const query = (entityName) => ({
    $type: 'QueryExpression',
    entityName,
    columnSet: { $type: 'ColumnSet', allColumns: false, columns: ['x_name'] },
    criteria: { operatorName: 'And', conditions: [], filters: [] },
    orders: [{ attributeName: 'x_name', descending: false }],
    linkEntities: [],
  });
  const answer = call('Execute', [
    request('Retrieve', {
      Target: { $type: 'EntityReference', logicalName: 'x_parent', id: parent },
      ColumnSet: { $type: 'ColumnSet', allColumns: true, columns: [] },
      RelatedEntitiesQuery: {
        $type: 'RelationshipQueryCollection',
        values: [{ relationship: { $type: 'Relationship', schemaName: 'x_parent_child' }, query: query('x_child') }],
      },
    }),
  ]);
  const [children] = answer.results.Entity.relatedEntities;
  assert.equal(children.relationship.schemaName, 'x_parent_child');
  assert.deepEqual(
    children.entities.entities.map((entity) => entity.attributes.x_name),
    ['a', 'b'],
  );
});

test('a QueryExpression with ColumnSet.AttributeExpressions runs as an aggregate query', () => {
  const { call } = relatedStore();
  for (const name of ['a', 'b', 'c']) call('Create', [row('x_child', { x_name: name })]);
  const expression = (members) => ({
    $type: 'Object',
    type: 'Microsoft.Xrm.Sdk.Query.XrmAttributeExpression',
    members,
  });
  const answer = call('RetrieveMultiple', [
    {
      $type: 'QueryExpression',
      entityName: 'x_child',
      columnSet: {
        $type: 'ColumnSet',
        allColumns: false,
        columns: [],
        attributeExpressions: [
          expression({
            AttributeName: 'x_childid',
            Alias: 'total',
            AggregateType: { $type: 'Enum', type: 'Microsoft.Xrm.Sdk.Query.XrmAggregateType', value: 1 },
            HasGroupBy: false,
            DateTimeGrouping: { $type: 'Enum', type: 'Microsoft.Xrm.Sdk.Query.XrmDateTimeGrouping', value: 0 },
          }),
        ],
      },
      criteria: { operatorName: 'And', conditions: [], filters: [] },
      orders: [],
      linkEntities: [],
    },
  ]);
  assert.equal(answer.entities.length, 1);
  const total = answer.entities[0].attributes.total;
  assert.equal(total.$type, 'AliasedValue');
  assert.equal(total.value, 3);
});

test('a polymorphic lookup stored as a bare GUID takes its table from the type column or the row that holds it', async () => {
  const { recordToSdkEntity } = await import('../lib/plugin-clr.mjs');
  const account = '75000000-0000-0000-0000-000000000001',
    contact = '75000000-0000-0000-0000-000000000002';
  const store = new DataStore({
    state: {
      version: 1,
      mappings: {
        x_case: {
          entitySet: 'x_cases',
          idColumn: 'x_caseid',
          fields: { x_customerid: { type: 'customer', targets: ['x_account', 'x_contact'] } },
        },
        x_account: { entitySet: 'x_accounts', idColumn: 'x_accountid' },
        x_contact: { entitySet: 'x_contacts', idColumn: 'x_contactid' },
      },
      tables: { x_case: [], x_account: [{ x_accountid: account }], x_contact: [{ x_contactid: contact }] },
    },
  });
  const typed = recordToSdkEntity(store, 'x_case', {
    x_caseid: '75000000-0000-0000-0000-000000000003',
    x_customerid: contact,
    x_customeridtype: 'x_contact',
  });
  assert.equal(typed.attributes.x_customerid.logicalName, 'x_contact');
  const found = recordToSdkEntity(store, 'x_case', {
    x_caseid: '75000000-0000-0000-0000-000000000003',
    x_customerid: account,
  });
  assert.equal(found.attributes.x_customerid.logicalName, 'x_account');
  assert.throws(
    () =>
      recordToSdkEntity(store, 'x_case', {
        x_caseid: '75000000-0000-0000-0000-000000000003',
        x_customerid: '75000000-0000-0000-0000-000000000009',
      }),
    /one exact source-declared target table/,
  );
});
