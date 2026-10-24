// Metadata structural parity against locally pinned standard target facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { implicitAttributes } from '../lib/dataverse-implicit-attributes.mjs';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';

const ORG = '77777777-7777-4777-8777-777777777777';
const fields = {
  x_name: { dataverseType: 'nvarchar' },
  x_assignee: { dataverseType: 'lookup', targets: ['systemuser'] },
  x_reference: { dataverseType: 'lookup', targets: ['x_other'] },
  x_choice: { dataverseType: 'picklist', options: [{ value: 1, label: 'One' }] },
  x_choices: { dataverseType: 'multiselectpicklist' },
  x_flag: { dataverseType: 'bit' },
  x_file: { dataverseType: 'file' },
  x_image: { dataverseType: 'image' },
  x_cost: { dataverseType: 'money', precision: 4 },
};
const mappings = {
  x_component: { entitySet: 'x_components', idColumn: 'x_componentid', nameColumn: 'x_name', ownership: 'UserOwned', fields },
  x_other: { entitySet: 'x_others', idColumn: 'x_otherid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' } } },
};
const service = extra => createMetadataService({ organizationId: ORG, mappings: { ...mappings, ...extra } });
const byName = metadata => Object.fromEntries(metadata.attributes('x_component').map(attribute => [attribute.LogicalName, attribute]));

test('lookup and enum companion definitions preserve native metadata categories and OData visibility', () => {
  const attrs = byName(service());
  for (const name of ['x_assigneename', 'x_assigneeyominame', 'x_referencename', 'owneridname', 'owneridyominame']) {
    assert.equal(attrs[name].AttributeType, 'String');
    assert.equal(attrs[name].MaxLength, 100);
    assert.equal(attrs[name].IsLogical, true);
    assert.equal(attrs[name].IsValidForRead, true);
    assert.equal(attrs[name].IsValidForCreate, false);
    assert.equal(attrs[name].IsValidForUpdate, false);
    assert.equal(attrs[name].IsValidODataAttribute, false);
  }
  assert.equal(attrs.x_assigneename.AttributeOf, 'x_assignee');
  assert.equal(attrs.x_referenceyominame, undefined, 'unknown target phonetic fields are not invented');
  for (const name of ['x_choicename', 'x_choicesname', 'x_flagname', 'statecodename', 'statuscodename']) {
    assert.equal(Object.hasOwn(attrs[name], '@odata.type'), false);
    assert.equal(attrs[name].AttributeType, 'Virtual');
    assert.equal(attrs[name].AttributeTypeName.Value, 'VirtualType');
    assert.equal(attrs[name].IsValidODataAttribute, false);
  }
  assert.equal(attrs.owneridtype.AttributeType, 'EntityName');
  assert.equal(attrs.owneridtype.AttributeOf, 'ownerid');
  assert.equal(attrs.owneridtype.IsLogical, false);
  assert.equal(attrs.owneridtype.IsValidForCreate, true);
  assert.equal(attrs.owninguser.IsLogical, true);
  for (const name of ['owningusername', 'owninguseryominame', 'owningteamname', 'owningteamyominame'])
    assert.equal(attrs[name], undefined, 'logical ownership references do not have name companions');
  const csdl = service().csdl();
  assert.doesNotMatch(csdl, /<Property Name="x_assigneename"/);
  assert.doesNotMatch(csdl, /<Property Name="x_choicename"/);
});

test('file, image and money companions expose the distinct native base and support-column shapes', () => {
  const attrs = byName(service());
  assert.equal(attrs.x_file.IsLogical, false);
  assert.equal(attrs.x_file.IsValidForCreate, false);
  assert.equal(attrs.x_file.IsValidForUpdate, false);
  assert.equal(attrs.x_file_name.AttributeOf, 'x_file');
  assert.equal(attrs.x_file_name.MaxLength, 200);
  assert.equal(attrs.x_file_name.IsValidODataAttribute, true);
  assert.equal(attrs.x_image.IsLogical, true);
  assert.equal(attrs.x_image.AttributeOf, 'x_imageid');
  assert.equal(attrs.x_image.IsValidForCreate, true);
  assert.equal(attrs.x_imageid.AttributeType, 'Uniqueidentifier');
  assert.equal(attrs.x_imageid.AttributeOf, null);
  assert.equal(attrs.x_imageid.IsLogical, false);
  assert.equal(attrs.x_image_timestamp.AttributeType, 'BigInt');
  for (const name of ['x_image_timestamp', 'x_image_url']) {
    assert.equal(attrs[name].AttributeOf, 'x_imageid');
    assert.equal(attrs[name].IsLogical, true);
    assert.equal(attrs[name].IsValidForCreate, false);
    assert.equal(attrs[name].IsValidODataAttribute, true);
  }
  assert.equal(attrs.transactioncurrencyid.Targets[0], 'transactioncurrency');
  assert.equal(attrs.exchangerate.Precision, 12);
  assert.equal(attrs.exchangerate.IsValidForUpdate, false);
  assert.equal(attrs.x_cost_base.AttributeType, 'Money');
  assert.equal(attrs.x_cost_base.IsValidForUpdate, false);
  assert.equal(service().attributes('x_other').some(attribute => ['transactioncurrencyid', 'exchangerate'].includes(attribute.LogicalName)), false);
});

test('regular custom tables gain omitted platform metadata and explicit exported flags remain authoritative', () => {
  const attrs = byName(service());
  assert.equal(attrs.createdonbehalfby.IsValidForCreate, false);
  assert.equal(attrs.modifiedonbehalfby.IsValidForUpdate, false);
  assert.equal(attrs.importsequencenumber.IsValidForCreate, true);
  assert.equal(attrs.importsequencenumber.IsValidForUpdate, false);
  assert.equal(attrs.overriddencreatedon.IsValidForUpdate, false);
  assert.equal(attrs.timezoneruleversionnumber.IsValidForUpdate, true);
  const metadata = service({ x_component: { ...mappings.x_component, fields: { ...fields,
    x_assigneename: { dataverseType: 'nvarchar', validForCreate: true, maxLength: 72,
      columnMetadata: { type: 'nvarchar', validForRead: false, isLogical: false, attributeOf: null },
      dataverseMetadata: { IsValidODataAttribute: true } },
    x_file: { dataverseType: 'file', columnMetadata: { type: 'file', validForCreate: true } },
  } } });
  const explicit = byName(metadata);
  assert.equal(explicit.x_assigneename.IsValidForCreate, true);
  assert.equal(explicit.x_assigneename.IsValidForRead, false);
  assert.equal(explicit.x_assigneename.IsLogical, false);
  assert.equal(explicit.x_assigneename.AttributeOf, null);
  assert.equal(explicit.x_assigneename.IsValidODataAttribute, true);
  assert.equal(explicit.x_file.IsValidForCreate, true);
});

test('virtual, intersect and elastic tables receive no inferred platform companions', () => {
  for (const source of [{ isVirtual: true }, { s: { isIntersect: true } }, { m: { intersect: true } }, { m: { tableType: 'Elastic' } }, { m: { tableType: 'Virtual' } }]) {
    const declared = { ...fields };
    assert.equal(implicitAttributes({ logical: 'x_component', ...source }, declared), declared);
  }
});

function solutionSchema(table = {}) {
  return { tables: { x_component: { logicalName: 'x_component', primaryIdAttribute: 'x_componentid', primaryNameAttribute: 'x_name',
    attributes: { x_name: { name: 'x_name', type: 'nvarchar', maxLength: 80 }, x_untouched: { name: 'x_untouched', type: 'int' } }, ...table } },
  relationships: {}, targets: {}, optionSets: {} };
}

test('metadata API columns remain visible above Solution fields without admitting unrelated thin mapping fields', () => {
  const metadata = createMetadataService({ organizationId: ORG, schema: solutionSchema(), mappings: {
    x_component: { ...mappings.x_component, fields: {
      x_name: { dataverseType: 'nvarchar', maxLength: 7 },
      x_transient: { dataverseType: 'nvarchar' },
      x_added: { dataverseType: 'int', columnMetadata: { type: 'int', isManaged: false, isCustomizable: true } },
    } },
  } });
  const attrs = byName(metadata);
  assert.equal(attrs.x_added.AttributeType, 'Integer');
  assert.equal(attrs.x_name.MaxLength, 80, 'unrelated selected Solution facts retain precedence');
  assert.equal(attrs.x_untouched.AttributeType, 'Integer');
  assert.equal(attrs.x_transient, undefined, 'a thin mapping is not a metadata API-created field');
});

test('mapping virtual facts survive an omitted Solution flag while explicit source false takes precedence', () => {
  for (const virtualFact of [{ tableType: 'Virtual' }, { dataverseMetadata: { TableType: 'Virtual' } }, { isVirtual: true }]) {
    const metadata = createMetadataService({ organizationId: ORG, schema: solutionSchema(), mappings: { x_component: { ...mappings.x_component, ...virtualFact } } });
    assert.equal(metadata.entity('x_component').TableType, 'Virtual');
    assert.equal(byName(metadata).createdon, undefined);
    assert.equal(byName(metadata).importsequencenumber, undefined);
  }
  const explicit = createMetadataService({ organizationId: ORG, schema: solutionSchema({ isVirtual: false }), mappings: {
    x_component: { ...mappings.x_component, tableType: 'Virtual' },
  } });
  assert.equal(explicit.entity('x_component').TableType, 'Standard');
  assert.ok(byName(explicit).createdon, 'explicit non-virtual Solution source controls standard system attributes');
  assert.ok(byName(explicit).importsequencenumber, 'explicit source false also takes precedence over helper fallbacks');
});

test('virtual metadata exposes provider facts with explicit source precedence and nulls for ordinary custom tables', () => {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const providerId = '22222222-2222-4222-8222-222222222222';
  const metadata = createMetadataService({ organizationId: ORG, schema: solutionSchema({ tableType: 'Virtual', dataSourceId: sourceId, dataProviderId: providerId }),
    mappings: { x_component: { ...mappings.x_component, isVirtual: false, dataverseMetadata: { TableType: 'Standard', DataSourceId: 'different', DataProviderId: 'different' } } } });
  const entity = metadata.entity('x_component');
  assert.equal(entity.TableType, 'Virtual');
  assert.equal(entity.DataSourceId, sourceId);
  assert.equal(entity.DataProviderId, providerId);
  assert.equal(entity.IsVirtualEntity, undefined);
  const ordinary = service().entity('x_component');
  assert.equal(ordinary.TableType, 'Standard');
  assert.equal(ordinary.DataSourceId, null);
  assert.equal(ordinary.DataProviderId, null);
});

test('base Attributes omit only proven generic GUID discriminators, including under selected projections', () => {
  const metadata = service({ x_component: { ...mappings.x_component, fields: { ...fields, x_correlation: { dataverseType: 'uniqueidentifier' } } } });
  for (const options of [{}, { select: 'LogicalName,AttributeType' }, { cast: 'AttributeMetadata', select: 'LogicalName' }]) {
    const attrs = Object.fromEntries(metadata.attributes('x_component', options).map(attribute => [attribute.LogicalName, attribute]));
    assert.equal(Object.hasOwn(attrs.x_componentid, '@odata.type'), false);
    assert.equal(Object.hasOwn(attrs.x_imageid, '@odata.type'), false);
    assert.equal(attrs.x_correlation['@odata.type'], '#Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata', 'an ordinary custom GUID is outside the captured generic cases');
  }
  // Preserve internal/SOAP metadata contracts independently of the Web API base collection's JSON representation.
  const sdk = metadata.retrieveEntityResponse('x_component', 2).EntityMetadata.Attributes;
  assert.equal(sdk.find(attribute => attribute.LogicalName === 'x_componentid')['@odata.type'], '#Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata');
  assert.equal(sdk.find(attribute => attribute.LogicalName === 'x_imageid')['@odata.type'], '#Microsoft.Dynamics.CRM.UniqueIdentifierAttributeMetadata');
});
