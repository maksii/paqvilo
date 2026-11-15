// @test-kind contract: HTTP metadata ordering is separate from SDK registration order; captured identities overlay only matching generated menu-label cultures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';
import { metadataRead } from '../lib/dataverse-api.mjs';
import { parseDataverseRoute } from '../lib/dataverse-odata.mjs';

const origin = 'http://127.0.0.1:39123';
const read = (service, path) => {
  const url = new URL('/api/data/v9.2/' + path, origin);
  return metadataRead({ url, origin }, service, parseDataverseRoute(url.pathname)).body;
};

// @test-kind observation: native uncast and typed attribute collections use ordinal LogicalName order per fixtures/dataverse-native-metadata-order.json (request and response hashes only); explicit asc/desc and an unknown order field are ignored in the two owned cohorts of fixtures/dataverse-native-deep-facts.json. Requests are typed here, so it is not a replay case.
test('HTTP attribute collections retain native default order across ignored order options', async () => {
  const bytes = await readFile(new URL('./fixtures/dataverse-native-metadata-order.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'dd52593f7c4e69cf79dcd0bf631765224967efc8a6056f1e71fe00599f1bd2f8',
  );
  const deep = await readFile(new URL('./fixtures/dataverse-native-deep-facts.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(deep).digest('hex'),
    'ee6c0d877b0863af30a9c03fea8e7ece92ba5cd9e542f2d4b4e16a01ca924ad6',
  );
  const proof = JSON.parse(bytes),
    holds = JSON.parse(deep);
  assert.equal(proof.expected.attributes, 'ordinal-ascending-LogicalName');
  assert.deepEqual(holds.expected.metadataOrdering, {
    attributesAscIgnored: true,
    attributesDescIgnored: true,
    unknownOrderFieldIgnored: true,
  });
  const service = createMetadataService({
    organizationId: '80000000-0000-4000-8000-000000000001',
    mappings: {
      sample: {
        entitySet: 'samples',
        idColumn: 'sampleid',
        fields: { zulu: { dataverseType: 'nvarchar' }, alpha: { dataverseType: 'nvarchar' } },
      },
    },
  });
  for (const cast of ['', '/Microsoft.Dynamics.CRM.StringAttributeMetadata'])
    for (const order of cast
      ? ['']
      : ['', '&$orderby=LogicalName asc', '&$orderby=LogicalName desc', '&$orderby=invented_missing desc']) {
      const rows = read(
        service,
        "EntityDefinitions(LogicalName='sample')/Attributes" + cast + '?$select=LogicalName' + order,
      ).value;
      assert.deepEqual(
        rows.filter((row) => ['zulu', 'alpha', 'sampleid'].includes(row.LogicalName)).map((row) => row.LogicalName),
        cast ? ['alpha', 'zulu'] : ['alpha', 'sampleid', 'zulu'],
      );
    }
});

test('HTTP ordering leaves SDK and internal attribute registration order unchanged', () => {
  const service = createMetadataService({
    organizationId: '80000000-0000-4000-8000-000000000001',
    mappings: { sample: { fields: { zulu: { dataverseType: 'nvarchar' }, alpha: { dataverseType: 'nvarchar' } } } },
  });
  const names = (values) =>
    values.filter((row) => ['zulu', 'alpha'].includes(row.LogicalName)).map((row) => row.LogicalName);
  assert.deepEqual(names(service.attributes('sample')), ['zulu', 'alpha']);
  assert.deepEqual(names(service.retrieveEntityResponse('sample', 2).EntityMetadata.Attributes), ['zulu', 'alpha']);
  read(service, "EntityDefinitions(LogicalName='sample')/Attributes?$select=LogicalName");
  assert.deepEqual(names(service.attributes('sample')), ['zulu', 'alpha']);
});

// @test-kind observation: native expanded relationship arrays (platform reference, inferred notes, authored source, then file/duplicate template order) recorded as metadata.relationships response hashes in fixtures/dataverse-native-metadata-order.json plus an independent exported-source kind proof; requests are typed here, so it is not a replay case. Direct navigation endpoint order is not covered.
test('expanded HTTP relationships use native source-kind order', async () => {
  const bytes = await readFile(new URL('./fixtures/dataverse-native-metadata-order.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'dd52593f7c4e69cf79dcd0bf631765224967efc8a6056f1e71fe00599f1bd2f8',
  );
  const proof = JSON.parse(bytes);
  assert.equal(proof.captures.length, 2);
  assert.deepEqual(proof.expected.relationshipSourceKindCounts, [7, 1, 1, 3]);
  const schema = {
    targets: {},
    optionSets: {},
    tables: {
      new_sample: {
        logicalName: 'new_sample',
        primaryIdAttribute: 'new_sampleid',
        ownership: 'UserOwned',
        attributes: { new_file: { name: 'new_file', type: 'file' } },
      },
    },
    relationships: {
      authored: {
        type: 'one-to-many',
        schemaName: 'new_sample_children',
        referencedEntity: 'new_sample',
        referencedAttribute: 'new_sampleid',
        referencingEntity: 'new_child',
        referencingAttribute: 'new_parent',
        referencedNavigation: 'new_children',
        referencingNavigation: 'new_parent',
      },
      notes: {
        type: 'one-to-many',
        schemaName: 'new_sample_Annotations',
        referencedEntity: 'new_sample',
        referencedAttribute: 'new_sampleid',
        referencingEntity: 'annotation',
        referencingAttribute: 'objectid',
        referencedNavigation: 'new_sample_Annotations',
        relatedNotes: true,
      },
    },
  };
  const service = createMetadataService({ organizationId: '80000000-0000-4000-8000-000000000001', schema });
  const rows = read(
    service,
    "EntityDefinitions(LogicalName='new_sample')?$select=LogicalName&$expand=OneToManyRelationships",
  ).OneToManyRelationships;
  assert.deepEqual(
    rows.map((row) => row.SchemaName),
    [
      'new_sample_SyncErrors',
      'new_sample_AsyncOperations',
      'new_sample_MailboxTrackingFolders',
      'new_sample_UserEntityInstanceDatas',
      'new_sample_ProcessSession',
      'new_sample_BulkDeleteFailures',
      'new_sample_PrincipalObjectAttributeAccesses',
      'new_sample_Annotations',
      'new_sample_children',
      'new_sample_FileAttachments',
      'new_sample_DuplicateMatchingRecord',
      'new_sample_DuplicateBaseRecord',
    ],
  );
});

test('captured relationship menu identities preserve generated text, culture and defaults', () => {
  const identity = '80000000-0000-4000-8000-000000000002';
  const menu = { labels: { 1033: 'Authored label', 1045: 'Authored second culture' } };
  const relationship = {
    schemaName: 'sample_child',
    entity: 'child',
    from: 'sampleid',
    to: 'parentid',
    many: true,
    associatedMenu: menu,
  };
  const mappings = {
    sample: { idColumn: 'sampleid', fields: {}, relationships: { children: relationship } },
    child: { idColumn: 'childid', fields: {} },
  };
  const service = createMetadataService({ organizationId: identity, mappings });
  const label = () => service.oneToMany('sample')[0].AssociatedMenuConfiguration.Label;
  assert.ok(label().LocalizedLabels.every((row) => row.MetadataId === null));
  relationship.dataverseMetadata = {
    AssociatedMenuConfiguration: {
      Label: {
        LocalizedLabels: [
          { LanguageCode: 1033, MetadataId: identity, Label: 'Must not replace source text', IsManaged: true },
          { LanguageCode: 1045, MetadataId: 'invalid' },
          { LanguageCode: 9999, MetadataId: identity },
        ],
        UserLocalizedLabel: { LanguageCode: 9999, MetadataId: identity },
      },
    },
  };
  const current = label();
  assert.equal(current.UserLocalizedLabel.MetadataId, identity);
  assert.equal(current.UserLocalizedLabel.Label, 'Authored label');
  assert.equal(current.UserLocalizedLabel.LanguageCode, 1033);
  assert.equal(current.UserLocalizedLabel.IsManaged, false);
  assert.deepEqual(
    current.LocalizedLabels.map((row) => [row.LanguageCode, row.MetadataId]),
    [
      [1033, identity],
      [1045, null],
    ],
  );
});
