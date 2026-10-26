// Dataverse SOAP metadata messages: DataContract XML in xrm/2011/Metadata, parsed back with the SOAP codec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataError } from '../lib/data-error.mjs';
import { METADATA_NS, metadataRequests } from '../lib/dataverse-soap-metadata.mjs';
import { NS, envelope, parseXml } from '../lib/dataverse-soap-xml.mjs';

const ORG = 'aaaaaaaa-0000-4000-8000-0000000000aa';
const text = (value) => ({ type: 'string', value });

const mappings = {
  invented_widget: {
    logicalName: 'invented_widget',
    entitySet: 'invented_widgets',
    idColumn: 'invented_widgetid',
    nameColumn: 'invented_name',
    fields: {
      invented_name: { dataverseType: 'text' },
      invented_qty: { dataverseType: 'int' },
      invented_ownerid: {
        dataverseType: 'lookup',
        targets: ['invented_owner'],
        label: 'Owner',
        schemaName: 'invented_OwnerId',
      },
    },
    relationships: {
      invented_ownerid: {
        entity: 'invented_owner',
        from: 'invented_ownerid',
        to: 'invented_ownerid',
        many: false,
        partner: 'invented_owner_widget',
        schemaName: 'invented_owner_widget',
        cascade: { Assign: 'NoCascade', Delete: 'RemoveLink' },
        isManaged: false,
        isCustomizable: true,
      },
    },
  },
  invented_owner: {
    logicalName: 'invented_owner',
    entitySet: 'invented_owners',
    idColumn: 'invented_ownerid',
    nameColumn: 'invented_name',
    fields: { invented_name: { dataverseType: 'text' } },
    relationships: {
      invented_owner_widget: {
        entity: 'invented_widget',
        from: 'invented_ownerid',
        to: 'invented_ownerid',
        many: true,
        partner: 'invented_ownerid',
        schemaName: 'invented_owner_widget',
        cascade: { Assign: 'NoCascade', Delete: 'RemoveLink' },
        isManaged: false,
        isCustomizable: true,
      },
    },
  },
};

const api = { settings: { organizationId: ORG }, schema: null, store: { state: { mappings } } };
const handlers = metadataRequests(api);
const run = (name, entries) =>
  handlers.get(name) ? handlers.get(name)(new Map(entries)) : assert.fail(`no handler ${name}`);

// Parses the result's raw key/value pairs and returns the b:value element for the key.
function valueOf(result, key) {
  const raw = result.results.get(key).rawValueXml;
  const root = parseXml(
    envelope(
      `<svc:ExecuteResponse><svc:ExecuteResult><a:Results>${raw}</a:Results></svc:ExecuteResult></svc:ExecuteResponse>`,
    ),
  );
  const results = root.children[0].children[0].children[0].children[0];
  return results.children[0].children.find((node) => node.ns === NS.b && node.name === 'value');
}
const child = (node, name) => node.children.find((c) => c.name === name);
const names = (node) => node.children.map((c) => c.name);
const textOfChild = (node, name) => child(node, name)?.text;
const typeOfNode = (node) => node.attrs.find((a) => a.name === 'type')?.value;

test('entity key AsyncJob is a SOAP EntityReference while its Web API value is a GUID', () => {
  const state = { mappings: structuredClone(mappings) };
  state.mappings.invented_widget.alternateKeys = [
    { name: 'invented_name_key', attributes: ['invented_name'], asyncJob: 'aaaaaaaa-bbbb-4000-8000-000000000001' },
  ];
  const handler = metadataRequests({ ...api, store: { state } }).get('RetrieveEntity');
  const value = valueOf(
    handler(
      new Map([
        ['LogicalName', text('invented_widget')],
        ['EntityFilters', 2],
      ]),
    ),
    'EntityMetadata',
  );
  const job = child(child(value, 'Keys').children[0], 'AsyncJob');
  assert.equal(typeOfNode(job), 'a:EntityReference');
  assert.equal(textOfChild(job, 'Id'), 'aaaaaaaa-bbbb-4000-8000-000000000001');
  assert.equal(textOfChild(job, 'LogicalName'), 'asyncoperation');
  assert.equal(job.text, '');
});

test('the six metadata requests are registered by request name', () => {
  assert.deepEqual([...handlers.keys()].filter((name) => name.startsWith('Retrieve')).sort(), [
    'RetrieveAllEntities',
    'RetrieveAttribute',
    'RetrieveEntity',
    'RetrieveMetadataChanges',
    'RetrieveOptionSet',
    'RetrieveRelationship',
  ]);
  for (const name of [
    'CreateEntity',
    'UpdateEntity',
    'DeleteEntity',
    'CreateAttribute',
    'UpdateAttribute',
    'DeleteAttribute',
    'CreateOneToMany',
    'CreateManyToMany',
    'UpdateRelationship',
    'DeleteRelationship',
    'CreateOptionSet',
    'UpdateOptionSet',
    'DeleteOptionSet',
    'CreateEntityKey',
    'DeleteEntityKey',
  ]) {
    assert.ok(handlers.has(name), name);
  }
});

test('RetrieveEntity emits EntityMetadata in the metadata namespace, base members first', () => {
  const value = valueOf(
    run('RetrieveEntity', [
      ['LogicalName', text('invented_widget')],
      ['EntityFilters', 15],
    ]),
    'EntityMetadata',
  );
  assert.equal(typeOfNode(value), 'm:EntityMetadata');
  assert.equal(value.scope.get('m'), METADATA_NS);
  assert.ok(
    value.children.every((c) => c.ns === METADATA_NS),
    'every member is in xrm/2011/Metadata',
  );
  assert.deepEqual(names(value).slice(0, 2), ['MetadataId', 'HasChanged']);
  const n = names(value);
  assert.ok(
    n.indexOf('LogicalName') < n.indexOf('SchemaName') && n.indexOf('SchemaName') < n.indexOf('EntitySetName'),
    'Order-72 EntitySetName follows the unordered members',
  );
  assert.ok(
    child(value, 'DisplayName').children.every((c) => c.ns === NS.a),
    'Label members are in xrm/2011/Contracts',
  );
  assert.equal(textOfChild(value, 'LogicalName'), 'invented_widget');
  assert.equal(textOfChild(value, 'EntitySetName'), 'invented_widgets');
  assert.equal(textOfChild(value, 'PrimaryIdAttribute'), 'invented_widgetid');
});

test('EntityFilters bits choose the collections: Entity alone omits Attributes, Attributes omits Privileges', () => {
  const entityOnly = names(
    valueOf(
      run('RetrieveEntity', [
        ['LogicalName', text('invented_widget')],
        ['EntityFilters', 1],
      ]),
      'EntityMetadata',
    ),
  );
  assert.ok(!entityOnly.includes('Attributes'));
  const withAttributes = names(
    valueOf(
      run('RetrieveEntity', [
        ['LogicalName', text('invented_widget')],
        ['EntityFilters', 2],
      ]),
      'EntityMetadata',
    ),
  );
  assert.ok(withAttributes.includes('Attributes'));
  assert.ok(!withAttributes.includes('Privileges'));
});

test('Attributes items are AttributeMetadata with xsi:type, base members first, LogicalName before SchemaName', () => {
  const value = valueOf(
    run('RetrieveEntity', [
      ['LogicalName', text('invented_widget')],
      ['EntityFilters', 2],
    ]),
    'EntityMetadata',
  );
  const attributes = child(value, 'Attributes');
  assert.ok(
    ['invented_widgetid', 'invented_name', 'invented_qty', 'invented_ownerid'].every((name) =>
      attributes.children.some((item) => textOfChild(item, 'LogicalName') === name),
    ),
  );
  for (const item of attributes.children) {
    assert.equal(item.name, 'AttributeMetadata');
    assert.equal(item.ns, METADATA_NS);
    assert.deepEqual(names(item).slice(0, 2), ['MetadataId', 'HasChanged']);
    const order = names(item);
    assert.ok(order.indexOf('LogicalName') >= 0 && order.indexOf('LogicalName') < order.indexOf('SchemaName'));
    assert.ok(order.indexOf('SchemaName') < order.indexOf('AttributeTypeName'));
  }
  const lookup = attributes.children.find((item) => textOfChild(item, 'LogicalName') === 'invented_ownerid');
  assert.equal(typeOfNode(lookup), 'm:LookupAttributeMetadata');
});

test('RetrieveAttribute returns the typed AttributeMetadata of one column', () => {
  const value = valueOf(
    run('RetrieveAttribute', [
      ['EntityLogicalName', text('invented_widget')],
      ['LogicalName', text('invented_qty')],
    ]),
    'AttributeMetadata',
  );
  assert.equal(typeOfNode(value), 'm:IntegerAttributeMetadata');
  assert.equal(textOfChild(value, 'LogicalName'), 'invented_qty');
  assert.deepEqual(names(value).slice(0, 2), ['MetadataId', 'HasChanged']);
});

test('a ManagedProperty<T> member is written as its Value, CanBeChanged and ManagedPropertyLogicalName group, never as plain text', () => {
  // The SDK reads IsValidForAdvancedFind as BooleanManagedProperty; a bare <IsValidForAdvancedFind>false</...> is a DataContract error.
  const primary = valueOf(
    run('RetrieveAttribute', [
      ['EntityLogicalName', text('invented_widget')],
      ['LogicalName', text('invented_widgetid')],
    ]),
    'AttributeMetadata',
  );
  const advanced = child(primary, 'IsValidForAdvancedFind');
  assert.deepEqual(names(advanced), ['CanBeChanged', 'ManagedPropertyLogicalName', 'Value']);
  assert.equal(textOfChild(advanced, 'Value'), 'false');
  assert.equal(textOfChild(advanced, 'ManagedPropertyLogicalName'), 'canmodifysearchsettings');
  const qty = valueOf(
    run('RetrieveAttribute', [
      ['EntityLogicalName', text('invented_widget')],
      ['LogicalName', text('invented_qty')],
    ]),
    'AttributeMetadata',
  );
  assert.equal(textOfChild(child(qty, 'IsValidForAdvancedFind'), 'Value'), 'true');
  assert.equal(textOfChild(child(qty, 'IsCustomizable'), 'ManagedPropertyLogicalName'), 'iscustomizable');
});

test('an enum member is written as its DataContract name, not its number (PrivilegeType)', () => {
  const value = valueOf(
    run('RetrieveEntity', [
      ['LogicalName', text('invented_widget')],
      ['EntityFilters', 4],
    ]),
    'EntityMetadata',
  );
  // The invented table declares no ownership, so it has the six organization-owned rights.
  assert.deepEqual(
    child(value, 'Privileges').children.map((privilege) => textOfChild(privilege, 'PrivilegeType')),
    ['Create', 'Read', 'Write', 'Delete', 'Append', 'AppendTo'],
  );
});

test('RetrieveAllEntities returns a collection of both invented tables in the contracts namespace', () => {
  const value = valueOf(run('RetrieveAllEntities', [['EntityFilters', 1]]), 'EntityMetadata');
  assert.equal(typeOfNode(value), 'a:EntityMetadataCollection');
  const logical = value.children.map((item) => textOfChild(item, 'LogicalName'));
  assert.deepEqual(logical.sort(), ['invented_owner', 'invented_widget']);
  assert.ok(value.children.every((item) => item.name === 'EntityMetadata' && item.ns === NS.a));
});

test('RetrieveRelationship returns the one-to-many relationship by SchemaName, typed', () => {
  const value = valueOf(run('RetrieveRelationship', [['Name', text('invented_owner_widget')]]), 'RelationshipMetadata');
  assert.equal(typeOfNode(value), 'm:OneToManyRelationshipMetadata');
  assert.deepEqual(names(value).slice(0, 2), ['MetadataId', 'HasChanged']);
  assert.equal(textOfChild(value, 'SchemaName'), 'invented_owner_widget');
  const order = names(value);
  assert.ok(order.indexOf('SecurityTypes') >= 0 && order.indexOf('SecurityTypes') < order.indexOf('RelationshipType'));
  assert.deepEqual(names(child(value, 'CascadeConfiguration')), [
    'Archive',
    'Assign',
    'Delete',
    'Merge',
    'Reparent',
    'Share',
    'Unshare',
    'RollupView',
  ]);
});

test('RetrieveRelationship writes the RelationshipMetadataBase members: SecurityTypes by name, IsCustomizable as a managed property', () => {
  const value = valueOf(run('RetrieveRelationship', [['Name', text('invented_owner_widget')]]), 'RelationshipMetadata');
  assert.equal(textOfChild(value, 'SecurityTypes'), 'None');
  assert.equal(textOfChild(value, 'RelationshipType'), 'OneToManyRelationship');
  assert.equal(textOfChild(value, 'IsCustomRelationship'), 'true', 'the referencing column carries a table prefix');
  assert.deepEqual(names(child(value, 'IsCustomizable')), ['CanBeChanged', 'ManagedPropertyLogicalName', 'Value']);
  assert.equal(textOfChild(child(value, 'IsCustomizable'), 'ManagedPropertyLogicalName'), 'iscustomizable');
  assert.equal(
    textOfChild(value, 'IsValidForAdvancedFind'),
    'true',
    'a plain bool? on RelationshipMetadataBase (Learn), not a managed property',
  );
  assert.equal(textOfChild(value, 'RelationshipBehavior'), '0');
  assert.equal(
    typeOfNode(child(value, 'AssociatedMenuConfiguration')),
    undefined,
    'a nested member without @odata.type is written untyped',
  );
});

test('a condition operator is read by its MetadataConditionOperator number: 0 Equals, 4 GreaterThan, 5 LessThan', () => {
  const select = (operator, value) =>
    entityNamesOf(
      run('RetrieveMetadataChanges', [
        [
          'Query',
          queryParameter(
            `<m:Criteria><m:FilterOperator>And</m:FilterOperator><m:Conditions>${stringCondition('LogicalName', operator, value)}</m:Conditions></m:Criteria>`,
          ),
        ],
      ]),
    );
  assert.deepEqual(select('0', 'invented_owner'), ['invented_owner']);
  assert.deepEqual(select('Equals', 'invented_owner'), ['invented_owner']);
  assert.deepEqual(select('4', 'invented_owner'), ['invented_widget']);
  assert.deepEqual(select('5', 'invented_widget'), ['invented_owner']);
});

test('unknown names fail with NotFound so the fault carries the platform code', () => {
  assert.throws(
    () => run('RetrieveEntity', [['LogicalName', text('invented_missing')]]),
    (error) => error instanceof DataError && error.code === 'NotFound',
  );
  assert.throws(
    () => run('RetrieveOptionSet', [['Name', text('invented_missing_set')]]),
    (error) => error.code === 'NotFound',
  );
});

// A typed EntityQueryExpression parameter, as the SDK sends it (xsi:type on the parameter value, so the decoder keeps the node).
const QUERY_NS =
  'xmlns:m="http://schemas.microsoft.com/xrm/2011/Metadata" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"';
const queryParameter = (body) => ({
  type: 'Raw',
  node: parseXml(`<m:EntityQueryExpression ${QUERY_NS}>${body}</m:EntityQueryExpression>`),
});
const stringCondition = (name, operator, value) =>
  `<m:MetadataConditionExpression><m:ConditionOperator>${operator}</m:ConditionOperator>` +
  `<m:PropertyName>${name}</m:PropertyName><m:Value i:type="c:string">${value}</m:Value></m:MetadataConditionExpression>`;
const entityNamesOf = (result) =>
  valueOf(result, 'EntityMetadata')
    .children.map((e) => textOfChild(e, 'LogicalName'))
    .sort();

test('RetrieveMetadataChanges without a Query, or with a nil one, is a full read of every table', () => {
  assert.deepEqual(entityNamesOf(run('RetrieveMetadataChanges', [])), ['invented_owner', 'invented_widget']);
  assert.deepEqual(entityNamesOf(run('RetrieveMetadataChanges', [['Query', null]])), [
    'invented_owner',
    'invented_widget',
  ]);
});

test('RetrieveMetadataChanges Query criteria: Or conditions select tables, and And with NotEquals excludes one', () => {
  const either = run('RetrieveMetadataChanges', [
    [
      'Query',
      queryParameter(
        `<m:Properties><m:AllProperties>false</m:AllProperties><m:PropertyNames><c:string>SchemaName</c:string></m:PropertyNames></m:Properties>` +
          `<m:Criteria><m:FilterOperator>Or</m:FilterOperator><m:Conditions>` +
          stringCondition('LogicalName', 'Equals', 'invented_owner') +
          stringCondition('LogicalName', 'Equals', 'invented_widget') +
          `</m:Conditions></m:Criteria>`,
      ),
    ],
  ]);
  assert.deepEqual(entityNamesOf(either), ['invented_owner', 'invented_widget']);
  const notOwner = run('RetrieveMetadataChanges', [
    [
      'Query',
      queryParameter(
        `<m:Criteria><m:FilterOperator>And</m:FilterOperator><m:Conditions>${stringCondition('LogicalName', 'NotEquals', 'invented_owner')}</m:Conditions></m:Criteria>`,
      ),
    ],
  ]);
  assert.deepEqual(entityNamesOf(notOwner), ['invented_widget']);
  // Properties name only SchemaName, so the entity keeps its base keys and drops the unrequested members.
  const widget = valueOf(either, 'EntityMetadata').children.find(
    (e) => textOfChild(e, 'LogicalName') === 'invented_widget',
  );
  assert.equal(textOfChild(widget, 'SchemaName'), 'Invented_widget');
  assert.equal(child(widget, 'DisplayName'), undefined);
});

// ---- SOAP typed metadata writes: decoded typed metadata goes through the Web API metadata writers ----
const WRITE_ORG = 'aaaaaaaa-0000-4000-8000-0000000000ee';
const WRITE_ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const WRITE_SETTINGS = {
  organizationId: WRITE_ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [{ objectId: WRITE_ADMIN, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};
const M_NS =
  'xmlns:m="http://schemas.microsoft.com/xrm/2011/Metadata" xmlns:i="http://www.w3.org/2001/XMLSchema-instance" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts"';
// A typed metadata parameter, as the SOAP decoder hands it over: a Raw node holding the element.
const typed = (xml) => ({ type: 'Raw', node: parseXml(`<root ${M_NS}>${xml}</root>`).children[0] });
const labelXml = (tag, text) =>
  `<m:${tag}><a:LocalizedLabels><a:LocalizedLabel><a:Label>${text}</a:Label><a:LanguageCode>1033</a:LanguageCode></a:LocalizedLabel></a:LocalizedLabels></m:${tag}>`;
const entityXml = (schema) =>
  `<m:Entity i:type="m:EntityMetadata"><m:SchemaName>${schema}</m:SchemaName>${labelXml('DisplayName', 'Bank Account')}` +
  `${labelXml('DisplayCollectionName', 'Bank Accounts')}<m:OwnershipType>UserOwned</m:OwnershipType><m:IsActivity>false</m:IsActivity></m:Entity>`;
const primaryXml = (schema) =>
  `<m:PrimaryAttribute i:type="m:StringAttributeMetadata"><m:SchemaName>${schema}</m:SchemaName>` +
  `${labelXml('DisplayName', 'Account Name')}<m:IsPrimaryName>true</m:IsPrimaryName><m:MaxLength>100</m:MaxLength></m:PrimaryAttribute>`;
const attributeXml = (schema) =>
  `<m:Attribute i:type="m:IntegerAttributeMetadata"><m:SchemaName>${schema}</m:SchemaName>` +
  `${labelXml('DisplayName', 'Quantity')}<m:MinValue>0</m:MinValue><m:MaxValue>100</m:MaxValue></m:Attribute>`;

async function writeSession() {
  const { DataStore, emptyState } = await import('../lib/data.mjs');
  const { createPrincipals, ensureSecurityModel } = await import('../lib/dataverse-security.mjs');
  const store = new DataStore({ state: emptyState() });
  await ensureSecurityModel(store, WRITE_SETTINGS);
  const api = {
    store,
    change: (fn) => fn(),
    settings: { organizationId: WRITE_ORG },
    schema: null,
    addRoute() {},
    principals: createPrincipals(store, WRITE_SETTINGS),
  };
  const caller = api.principals.byObjectId(WRITE_ADMIN);
  const session = {
    api,
    version: 'v9.2',
    origin: 'http://127.0.0.1:5555',
    user: caller,
    caller,
    identity: null,
    requestId: 'r-soap-1',
  };
  return { api, store, session, handlers: metadataRequests(api) };
}

test('CreateEntity decodes the typed EntityMetadata and its primary column, creates the table and answers its EntityId', async () => {
  const { store, session, handlers } = await writeSession();
  const result = await handlers.get('CreateEntity')(
    new Map([
      ['Entity', typed(entityXml('new_BankAccount'))],
      ['PrimaryAttribute', typed(primaryXml('new_AccountName'))],
      ['HasActivities', { type: 'boolean', value: false }],
      ['HasNotes', { type: 'boolean', value: false }],
    ]),
    session,
  );
  assert.equal(result.name, 'CreateEntity');
  assert.equal(result.responseType, 'CreateEntityResponse');
  const entityId = result.results.get('EntityId').value;
  assert.match(entityId, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  const mapping = store.state.mappings.new_bankaccount;
  assert.ok(mapping, 'the invented table exists');
  assert.equal(mapping.dataverseMetadata.labels.DisplayName[1033], 'Bank Account');
  assert.equal(mapping.nameColumn, 'new_accountname', 'the primary column is the primary name');
  assert.equal(mapping.fields.new_accountname?.dataverseType, 'nvarchar');
  assert.equal(mapping.fields.new_accountname.columnMetadata.maxLength, 100);
});

test('CreateAttribute adds a typed column and answers its AttributeId; DeleteAttribute and DeleteEntity remove them', async () => {
  const { store, session, handlers } = await writeSession();
  await handlers.get('CreateEntity')(
    new Map([
      ['Entity', typed(entityXml('new_Shelf'))],
      ['PrimaryAttribute', typed(primaryXml('new_ShelfName'))],
      ['HasActivities', { type: 'boolean', value: false }],
      ['HasNotes', { type: 'boolean', value: false }],
    ]),
    session,
  );
  const created = await handlers.get('CreateAttribute')(
    new Map([
      ['EntityName', { type: 'string', value: 'new_shelf' }],
      ['Attribute', typed(attributeXml('new_Quantity'))],
    ]),
    session,
  );
  assert.equal(created.responseType, 'CreateAttributeResponse');
  assert.match(created.results.get('AttributeId').value, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  const quantity = store.state.mappings.new_shelf.fields.new_quantity;
  assert.equal(quantity?.dataverseType, 'int', 'the column is created with the Web API writer');
  assert.deepEqual([quantity.columnMetadata.minValue, quantity.columnMetadata.maxValue], [0, 100]);

  await handlers.get('DeleteAttribute')(
    new Map([
      ['EntityLogicalName', { type: 'string', value: 'new_shelf' }],
      ['LogicalName', { type: 'string', value: 'new_quantity' }],
    ]),
    session,
  );
  assert.equal(store.state.mappings.new_shelf.fields.new_quantity, undefined);

  const removed = await handlers.get('DeleteEntity')(
    new Map([['LogicalName', { type: 'string', value: 'new_shelf' }]]),
    session,
  );
  assert.equal(removed.name, 'DeleteEntity');
  assert.equal(store.state.mappings.new_shelf, undefined);
});

test('CreateAttribute on a table that does not exist fails through the Web API writer', async () => {
  const { session, handlers } = await writeSession();
  await assert.rejects(
    handlers.get('CreateAttribute')(
      new Map([
        ['EntityName', { type: 'string', value: 'new_missing' }],
        ['Attribute', typed(attributeXml('new_Quantity'))],
      ]),
      session,
    ),
    (error) => error instanceof DataError && error.status === 404,
  );
});

test('a typed request without its required member is refused as InvalidRequest', async () => {
  const { session, handlers } = await writeSession();
  await assert.rejects(
    handlers.get('CreateEntity')(new Map(), session),
    (error) => error instanceof DataError && error.status === 400,
  );
});
