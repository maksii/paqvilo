import test from 'node:test';
import assert from 'node:assert/strict';
import { implicitRelationships } from '../lib/dataverse-implicit-relationships.mjs';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';

const source = () => ({
  logical: 'sample_record',
  idColumn: 'sample_recordid',
  ownership: 'user',
  ownershipType: 'UserOwned',
  s: { logicalName: 'sample_record', tableType: 'Standard' },
  m: {},
  fields: { sample_file: { dataverseType: 'file' } },
});

test('ordinary source-defined custom tables receive the bounded platform relationship declarations', () => {
  const input = source(),
    before = structuredClone(input);
  const relationships = implicitRelationships(input);
  assert.equal(relationships.length, 10);
  const byName = Object.fromEntries(relationships.map((relationship) => [relationship.schemaName, relationship]));
  assert.equal(new Set(relationships.map((relationship) => relationship.schemaName)).size, 10);
  for (const relationship of relationships) {
    assert.equal(relationship.type, '1:N');
    assert.equal(relationship.referencedEntity, input.logical);
    assert.equal(relationship.referencedAttribute, input.idColumn);
    assert.equal(relationship.referencedNav, relationship.schemaName);
    assert.equal(relationship.referencingNav, `${relationship.referencingAttribute}_${input.logical}`);
    assert.equal(relationship.isCustomRelationship, false);
  }
  assert.equal(byName.sample_record_AsyncOperations.cascade.delete, 'NoCascade');
  assert.equal(byName.sample_record_ProcessSession.cascade.delete, 'NoCascade');
  assert.equal(byName.sample_record_SyncErrors.cascade.delete, 'Cascade');
  assert.equal(byName.sample_record_BulkDeleteFailures.isValidForAdvancedFind, false);
  assert.equal(byName.sample_record_PrincipalObjectAttributeAccesses.isValidForAdvancedFind, false);
  assert.equal(byName.sample_record_FileAttachments.relationshipBehavior, 2);
  assert.equal(byName.sample_record_DuplicateBaseRecord.introducedVersion, '1.0');
  assert.deepEqual(input, before, 'metadata declarations never mutate storage mappings or source facts');
});

test('a file declaration adds FileAttachments while duplicate-detection execution flags do not remove schema', () => {
  const input = source();
  input.fields = { sample_image: { dataverseType: 'image' } };
  input.s.isDuplicateDetectionEnabled = false;
  const relationships = implicitRelationships(input);
  assert.equal(relationships.length, 9);
  assert.equal(
    relationships.some((relationship) => relationship.schemaName.endsWith('_FileAttachments')),
    false,
  );
  assert.equal(relationships.filter((relationship) => relationship.referencingEntity === 'duplicaterecord').length, 2);
});

test('an explicit source SchemaName suppresses its inferred template without deduplicating different relationships', () => {
  const relationships = implicitRelationships(source(), {
    existing: ['SAMPLE_RECORD_ASYNCOPERATIONS', 'different_relationship'],
  });
  assert.equal(relationships.length, 9);
  assert.equal(
    relationships.some((relationship) => relationship.schemaName === 'sample_record_AsyncOperations'),
    false,
  );
});

test('unproven table categories do not inherit the ordinary custom user-owned profile', () => {
  for (const change of [
    { s: null },
    { def: {} },
    { logical: 'account' },
    { ownership: 'org', ownershipType: 'OrganizationOwned' },
    { isVirtual: true },
    { s: { tableType: 'Virtual' } },
    { s: { tableType: 'Elastic' } },
    { s: { isIntersect: true } },
    { s: { isActivity: true } },
  ])
    assert.deepEqual(implicitRelationships({ ...source(), ...change }), []);
});

function metadataFixture(extraRelationships = {}) {
  const mappings = {
    sample_record: {
      entitySet: 'sample_records',
      idColumn: 'sample_recordid',
      nameColumn: 'sample_name',
      ownership: 'UserOwned',
      fields: { sample_name: { dataverseType: 'nvarchar' }, sample_file: { dataverseType: 'file' } },
      relationships: {},
    },
    sample_child: {
      entitySet: 'sample_children',
      idColumn: 'sample_childid',
      nameColumn: 'sample_name',
      fields: { sample_name: { dataverseType: 'nvarchar' } },
      relationships: {},
    },
  };
  const relationship = (schemaName, attribute) => ({
    schemaName,
    type: 'one-to-many',
    referencedEntity: 'sample_record',
    referencedAttribute: 'sample_recordid',
    referencingEntity: 'sample_child',
    referencingAttribute: attribute,
    referencedNavigation: schemaName,
    referencingNavigation: attribute,
  });
  const schema = {
    tables: {
      sample_record: {
        logicalName: 'sample_record',
        ownership: 'UserOwned',
        primaryIdAttribute: 'sample_recordid',
        primaryNameAttribute: 'sample_name',
        attributes: {
          sample_name: { name: 'sample_name', type: 'nvarchar' },
          sample_file: { name: 'sample_file', type: 'file' },
        },
      },
      sample_child: {
        logicalName: 'sample_child',
        ownership: 'OrganizationOwned',
        primaryIdAttribute: 'sample_childid',
        attributes: {
          sample_name: { name: 'sample_name', type: 'nvarchar' },
        },
      },
    },
    relationships: {
      sample_record_children: relationship('sample_record_children', 'sample_parentid'),
      sample_record_secondary: relationship('sample_record_secondary', 'sample_secondaryid'),
      ...extraRelationships,
    },
    targets: {},
    optionSets: {},
  };
  const metadata = createMetadataService({ organizationId: '88888888-8888-4888-8888-888888888888', schema, mappings });
  return { metadata, mappings, schema };
}

test('metadata combines source and platform relationships with canonical ids without touching the CRUD graph', () => {
  const { metadata, mappings } = metadataFixture();
  const before = structuredClone(mappings);
  const relationships = metadata.oneToMany('sample_record');
  assert.equal(relationships.length, 12);
  for (const relationship of relationships)
    assert.equal(relationship.MetadataId, metadata.metadataId('relationship', relationship.SchemaName));
  const byName = Object.fromEntries(relationships.map((relationship) => [relationship.SchemaName, relationship]));
  assert.equal(byName.sample_record_FileAttachments.SecurityTypes, 'ParentChild');
  assert.equal(byName.sample_record_BulkDeleteFailures.IsValidForAdvancedFind, false);
  assert.equal(byName.sample_record_DuplicateBaseRecord.IntroducedVersion, '1.0');
  assert.deepEqual(mappings, before, 'metadata declarations never install storage or cascade relationships');
});

test('an explicit same-name source relationship retains its own columns and metadata', () => {
  const { metadata } = metadataFixture({
    source_override: {
      schemaName: 'sample_record_AsyncOperations',
      type: 'one-to-many',
      referencedEntity: 'sample_record',
      referencedAttribute: 'sample_recordid',
      referencingEntity: 'sample_child',
      referencingAttribute: 'sample_explicitid',
      referencedNavigation: 'explicit_children',
      referencingNavigation: 'sample_explicitid',
      relationshipBehavior: 1,
    },
  });
  const relationships = metadata
    .oneToMany('sample_record')
    .filter((relationship) => relationship.SchemaName === 'sample_record_AsyncOperations');
  assert.equal(relationships.length, 1);
  assert.equal(relationships[0].ReferencingEntity, 'sample_child');
  assert.equal(relationships[0].ReferencingAttribute, 'sample_explicitid');
  assert.equal(relationships[0].ReferencedEntityNavigationPropertyName, 'explicit_children');
  assert.equal(relationships[0].IsCustomRelationship, true);
});
