import { createHash } from 'node:crypto';
import { componentId } from './blueprint.mjs';
import { scopeHierarchyVariantCases, materializeScopeHierarchyVariant } from './qualification-domain.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Separate bounded native admission calibrations, never inferred denials.
 * Original FetchXML configuration/read denominators remain unchanged. */
export function odataAdmissionCohorts({ schema, catalogue }) {
  const variants = [...scopeHierarchyVariantCases()];
  const requirements = [
    ...['Global', 'Contact', 'Account', 'Self'].map(scope => ['root-scope', { scope, roleDefault: 'explicit' }, 'direct-' + scope.toLowerCase()]),
    ...[1, 2, 8].map(depth => ['parent-depth', { depth, parentRead: true, leafPrivileges: 1 }, 'depth-' + depth]),
    ['relationship', { scope: 'Contact', direction: 'many-to-many' }, 'contact-nn-root'],
    ['relationship', { scope: 'Parent', direction: 'child-lookup' }, 'one-level-cross-table'],
    ['relationship', { scope: 'Parent', direction: 'reverse-lookup' }, 'one-level-reverse'],
    ['alternative-grants', { shape: 'global-plus-scoped', grants: 3, overlap: 'identical', leafPrivileges: 1 }, 'global-scoped-union'],
  ];
  const configurations = requirements.map(([family, parameters, discriminator]) => {
    const variant = variants.find(variant => variant.family === family && equal(variant.parameters, parameters));
    if (!variant) throw new Error('Admission cohort missing from the source grammar.');
    return { ...materializeScopeHierarchyVariant(variant, { schema, catalogue }), discriminator };
  });
  const clone = source => { const { bindingContract, ...data } = source; return structuredClone(data); };
  const depth3 = clone(configurations.find(configuration => configuration.discriminator === 'depth-8'));
  depth3.permissions = depth3.permissions.slice(0, 4);
  depth3.components = depth3.components.filter(component => component.type === 11 || depth3.permissions.some(permission => permission.id === component.id));
  const rootQuery = (configuration, tableName) => {
    const table = schema.tables.find(table => table.name === tableName), previous = configuration.query;
    configuration.query = { ...previous, table: tableName, entitySet: table.entitySetName, primaryId: tableName + 'id',
      fields: [{ name: tableName + 'id', source: tableName + 'id', type: 'guid', nullable: false },
        { name: 'pqvd_name', source: 'pqvd_name', type: 'string', nullable: false }],
      fetchXml: previous.fetchXml.replaceAll(previous.table, tableName) };
  };
  rootQuery(depth3, 'pqvd_orgcontact'); depth3.discriminator = 'depth-3'; configurations.push(depth3);
  const oneToMany = clone(configurations.find(configuration => configuration.discriminator === 'depth-8'));
  oneToMany.permissions = oneToMany.permissions.slice(3, 6);
  const root = oneToMany.permissions[0]; root.scope = 'Contact'; root.parentId = null; root.relationship = 'pqvd_contact_orgcontacts';
  oneToMany.components = oneToMany.components.filter(component => component.type === 11 || oneToMany.permissions.some(permission => permission.id === component.id));
  const rootComponent = oneToMany.components.find(component => component.id === root.id);
  delete rootComponent.content.parententitypermission; delete rootComponent.content.parentrelationship;
  Object.assign(rootComponent.content, { scope: 756150001, contactrelationship: root.relationship });
  rootQuery(oneToMany, 'pqvd_assignment'); oneToMany.discriminator = 'multi-level-one-to-many'; configurations.push(oneToMany);
  const { bindingContract: ignoredBinding, ...sameSource } = configurations.find(configuration => configuration.discriminator === 'depth-2');
  const same = structuredClone(sameSource);
  // Function properties are copied separately: they cannot be cloned through
  // structuredClone and are rebuilt from the final source query below.
  const parent = same.permissions.at(-1), permissionId = componentId('odata-admission:same-table-parent');
  const child = { ...parent, id: permissionId, name: parent.name + ' same-table', parentId: parent.id,
    relationship: 'account_parent_account', scope: 'Parent' };
  same.permissions.push(child); same.components.push({ id: child.id, type: 18, name: child.name, state: 0,
    content: { entityname: child.name, entitylogicalname: child.table, scope: 756150003, read: true, create: false,
      write: false, delete: false, append: false, appendto: false, adx_entitypermission_webrole: child.roleIds,
      parententitypermission: child.parentId, parentrelationship: child.relationship } });
  same.discriminator = 'same-table-parent'; configurations.push(same);
  for (const configuration of configurations) {
    const old = configuration.variantId; configuration.variantId = 'odata-admission:' + configuration.discriminator;
    configuration.query = { ...configuration.query, id: 'QF-ODA-' + hash(configuration.variantId).slice(0, 16), queryType: 'odata',
      variant: 'isolated-odata-admission', pageSize: 10, authoringQualification: 'schema-bound-primary-key-and-name',
      expectedNativeOutcome: 'requires-native-evidence' };
    configuration.bindingContract = { bindRecordIds(ids) {
      if (!ids?.length || ids.some(id => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) throw new Error('Bind actual native fixture GUIDs.');
      return { ...configuration.query, fixtureBindings: [], fixtureIds: ids,
        fetchXml: configuration.query.fetchXml.replace('{{qualificationRecordIdValues}}', ids.map(id => `<value>${id}</value>`).join('')) };
    } };
    configuration.configurationCells = Array.from({ length: configuration.roleMaskCount }, (_, mask) => ({
      id: `${configuration.variantId}:m${mask}:read:webapi-odata`, variantId: configuration.variantId, roleMask: mask,
      operation: 'read', lane: 'webapi-odata', wholeFixturePartition: true,
      regions: [...configuration.requiredRegions], nativeQualification: 'unrecorded' }));
    configuration.sourceHashes = { ...configuration.sourceHashes, components: hash(configuration.components), query: hash(configuration.query),
      admissionCohort: hash({ old, discriminator: configuration.discriminator }) };
    configuration.nativeQualifiedCells = 0;
  }
  const cells = configurations.reduce((count, configuration) => count + configuration.configurationCells.length, 0);
  if (configurations.length !== 14 || cells !== 34) throw new Error('Declare a new admission domain before changing its 14-configuration/34-cell bounds.');
  return { kind: 'isolated-native-odata-admission-cohorts', configurations, configurationsRequired: 14,
    denominator: cells, physicalRepeatedCellsRequired: cells * 2, originalDenominatorsPreserved: true,
    nativeQualifiedCells: 0, sourceFeatureDecision: 'hypothesis-awaiting-independent-native-repeats', universalPermissionParity: false };
}
