import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSchemaDocument, buildSolutionSchema } from '../lib/solution-schema.mjs';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';

const ORG = '7014a3e5-497a-439e-b4a1-3f2b79879001';
const scanOf = (xml) => ({
  diagnostics: [],
  layers: [
    { index: 0, name: 'Invented', files: [], documents: [{ file: 'invented.xml', facts: parseSchemaDocument(xml) }] },
  ],
});
const serviceOf = (xml) =>
  createMetadataService({ organizationId: ORG, schema: buildSolutionSchema(scanOf(xml)), mappings: {} });
const role = (index, title, order, extra = '') =>
  `<EntityRelationshipRole><AssociationRoleOrdinal>${index}</AssociationRoleOrdinal><RelationshipRoleType>${index === 1 ? 1 : 0}</RelationshipRoleType><NavigationPropertyName>new_nav${index}</NavigationPropertyName><NavPaneDisplayOption>DoNotDisplay</NavPaneDisplayOption><NavPaneArea>Details</NavPaneArea><NavPaneOrder>${order}</NavPaneOrder><CustomLabels><CustomLabel description="${title}" languagecode="1033"/></CustomLabels>${extra}</EntityRelationshipRole>`;

test('source relationships retain every cascade action, role menu labels/order and explicit metadata flags', () => {
  const xml = `<EntityRelationships><EntityRelationship Name="new_parent_children"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>new_child</ReferencingEntityName><ReferencedEntityName>new_parent</ReferencedEntityName><ReferencingAttributeName>new_parentid</ReferencingAttributeName><ReferencedAttributeName>new_parentid</ReferencedAttributeName><IntroducedVersion>2.3.4.5</IntroducedVersion><IsCustomizable>False</IsCustomizable><IsValidForAdvancedFind>0</IsValidForAdvancedFind><RelationshipBehavior>1</RelationshipBehavior><SecurityTypes>Append</SecurityTypes><CascadeAssign>Active</CascadeAssign><CascadeDelete>Restrict</CascadeDelete><CascadeArchive>RemoveLink</CascadeArchive><CascadeReparent>UserOwned</CascadeReparent><CascadeShare>Cascade</CascadeShare><CascadeUnshare>NoCascade</CascadeUnshare><CascadeRollupView>Cascade</CascadeRollupView><EntityRelationshipRoles>${role(1, 'Child records', 10000)}${role(2, 'Parent records', 0)}</EntityRelationshipRoles></EntityRelationship></EntityRelationships>`;
  const service = serviceOf(xml),
    relationship = service.relationship('new_parent_children', { cast: 'OneToManyRelationshipMetadata' });
  assert.deepEqual(relationship.CascadeConfiguration, {
    Assign: 'Active',
    Delete: 'Restrict',
    Archive: 'RemoveLink',
    Merge: 'NoCascade',
    Reparent: 'UserOwned',
    Share: 'Cascade',
    Unshare: 'NoCascade',
    RollupView: 'Cascade',
  });
  assert.equal(relationship.IntroducedVersion, '2.3.4.5');
  assert.equal(relationship.IsCustomizable.Value, false);
  assert.equal(relationship.IsValidForAdvancedFind, false);
  assert.equal(relationship.RelationshipBehavior, 1);
  assert.equal(relationship.SecurityTypes, 'Append');
  assert.equal(relationship.AssociatedMenuConfiguration.Label.UserLocalizedLabel.Label, 'Child records');
  assert.equal(relationship.AssociatedMenuConfiguration.Order, 10000);
  assert.equal(relationship.AssociatedMenuConfiguration.IsCustomizable, false);
  assert.equal(relationship.MetadataId, service.relationship('new_parent_children').MetadataId);
});

test('many-to-many source roles retain independent menus including zero order and role customizability', () => {
  const service = serviceOf(
    `<EntityRelationships><EntityRelationship Name="new_peers"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>new_left</FirstEntityName><SecondEntityName>new_right</SecondEntityName><IntersectEntityName>new_peer</IntersectEntityName><IsCustomizable>1</IsCustomizable><EntityRelationshipRoles>${role(1, 'Left peers', 0)}${role(2, 'Right peers', 9000, '<IsCustomizable>0</IsCustomizable>')}</EntityRelationshipRoles></EntityRelationship></EntityRelationships>`,
  );
  const relationship = service.relationship('new_peers', { cast: 'ManyToManyRelationshipMetadata' });
  assert.equal(relationship.Entity1AssociatedMenuConfiguration.Label.UserLocalizedLabel.Label, 'Left peers');
  assert.equal(relationship.Entity1AssociatedMenuConfiguration.Order, 0);
  assert.equal(relationship.Entity1AssociatedMenuConfiguration.IsCustomizable, true);
  assert.equal(relationship.Entity2AssociatedMenuConfiguration.Label.UserLocalizedLabel.Label, 'Right peers');
  assert.equal(relationship.Entity2AssociatedMenuConfiguration.IsCustomizable, false);
});

test('global choices preserve introduced version, explicit false and empty external values', () => {
  const xml =
    '<optionset Name="new_colour"><OptionSetType>picklist</OptionSetType><IsGlobal>1</IsGlobal><IntroducedVersion>2.3.4.5</IntroducedVersion><IsCustomizable>0</IsCustomizable><options><option value="100000000" ExternalValue="" IsHidden="0"><labels><label languagecode="1033" description="First"/></labels></option><option value="100000001" ExternalValue="external" IsHidden="1"><labels><label languagecode="1033" description="Second"/></labels></option></options></optionset>';
  const facts = parseSchemaDocument(xml),
    service = serviceOf(xml),
    choice = service.globalOptionSet('new_colour');
  assert.equal(facts.optionSets[0].options[0].externalValue, '');
  assert.equal(choice.IntroducedVersion, '2.3.4.5');
  assert.equal(choice.IsCustomizable.Value, false);
  assert.equal(choice.ExternalTypeName, null);
  assert.equal(choice.ParentOptionSetName, null);
  assert.deepEqual(
    choice.Options.map((option) => option.ExternalValue),
    ['', 'external'],
  );
  assert.deepEqual(
    choice.Options.map((option) => option.IsHidden),
    [false, true],
  );
});

test('typed relationship expansions omit redundant JSON types without changing internal metadata', () => {
  const service = createMetadataService({
    organizationId: ORG,
    mappings: {
      new_parent: {
        logicalName: 'new_parent',
        entitySet: 'new_parents',
        idColumn: 'new_parentid',
        fields: { new_parentid: { dataverseType: 'uniqueidentifier' } },
        relationships: {
          children: {
            schemaName: 'new_children',
            entity: 'new_child',
            from: 'new_parentid',
            to: 'new_parentid',
            many: true,
          },
        },
      },
      new_child: {
        logicalName: 'new_child',
        entitySet: 'new_children',
        idColumn: 'new_childid',
        fields: { new_childid: { dataverseType: 'uniqueidentifier' }, new_parentid: { dataverseType: 'lookup' } },
      },
    },
  });
  const expanded = service.entity('new_parent', { expand: 'OneToManyRelationships' });
  assert.deepEqual(
    expanded.OneToManyRelationships.map((relationship) => relationship.SchemaName),
    ['new_children'],
  );
  assert.ok(expanded.OneToManyRelationships.every((relationship) => !Object.hasOwn(relationship, '@odata.type')));
  assert.equal(
    service.oneToMany('new_parent')[0]['@odata.type'],
    '#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata',
  );
});
