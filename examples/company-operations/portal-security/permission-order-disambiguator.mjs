import { createHash } from 'node:crypto';
import { componentId } from './blueprint.mjs';
import { scopeHierarchyVariantCases, materializeScopeHierarchyVariant } from './qualification-domain.mjs';
import { planQualificationFixtures } from './qualification-fixtures.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const regions = ['own-scope', 'same-company-other-branch', 'foreign-company'];
const scopeValues = { Contact: 756150001, Parent: 756150003 };

/** An order-only experiment whose two independently accessible paths disagree
 * under depth-descending and lexical-path hypotheses. No runtime heuristic or
 * native qualification is installed by constructing these requests. */
export function permissionOrderDisambiguator({ schema, catalogue }) {
  const base = materializeScopeHierarchyVariant([...scopeHierarchyVariantCases()].find(variant =>
    variant.family === 'parent-depth' && variant.parameters.depth === 2 && variant.parameters.parentRead &&
    variant.parameters.leafPrivileges === 1), { schema, catalogue });
  const variantId = 'permission-order:depth-versus-path-lexical';
  const roleId = componentId('qualification:' + variantId + ':role');
  const permissions = [];
  const add = (key, table, scope, parent, relationship) => {
    const permission = { id: componentId('qualification:' + variantId + ':' + key), name: 'CO Order Disambiguator ' + key,
      table, scope, parentId: parent?.id ?? null, relationship, privileges: {
        read: true, create: false, write: false, delete: false, append: false, appendTo: false },
      roleIds: [roleId], active: true, path: key };
    permissions.push(permission); return permission;
  };
  const access = add('access', 'pqvd_accesspermission', 'Contact', null, 'pqvd_contact_access_grantee');
  const account = add('account-top', 'account', 'Parent', access, 'pqvd_access_accounts');
  const orgContact = add('org-contact', 'pqvd_orgcontact', 'Parent', account, 'pqvd_account_orgcontacts');
  const employment = add('employment', 'pqvd_employment', 'Parent', orgContact, 'pqvd_orgcontact_employments');
  const workforce = add('assignment-workforce', 'pqvd_assignment', 'Parent', employment, 'pqvd_employment_assignments');
  const accountMid = add('account-mid', 'account', 'Parent', account, 'account_parent_account');
  const accountChild = add('account-child', 'account', 'Parent', accountMid, 'account_parent_account');
  const equipment = add('equipment', 'pqvd_equipment', 'Parent', accountChild, 'pqvd_account_equipments');
  const assets = add('assignment-equipment', 'pqvd_assignment', 'Parent', equipment, 'pqvd_equipment_assignments');
  const components = [{ id: roleId, type: 11, name: 'CO Order Disambiguator', state: 0,
    content: { anonymoususersrole: false, authenticatedusersrole: false, description: 'Reversible native path-order experiment.' } },
  ...permissions.map(permission => ({ id: permission.id, type: 18, name: permission.name, state: 0,
    content: { entityname: permission.name, entitylogicalname: permission.table, scope: scopeValues[permission.scope],
      read: true, create: false, write: false, delete: false, append: false, appendto: false,
      adx_entitypermission_webrole: [roleId], ...(permission.scope === 'Contact'
        ? { contactrelationship: permission.relationship }
        : { parententitypermission: permission.parentId, parentrelationship: permission.relationship }) } }))];
  const query = { ...base.query, id: 'QF-ORDER-DISAMBIGUATOR', name: 'Depth versus lexical path order',
    table: 'pqvd_assignment', primaryId: 'pqvd_assignmentid', primaryName: 'pqvd_name',
    entitySet: schema.tables.find(table => table.name === 'pqvd_assignment').entitySetName,
    fields: [{ name: 'pqvd_assignmentid', source: 'pqvd_assignmentid', type: 'guid', nullable: false },
      { name: 'pqvd_name', source: 'pqvd_name', type: 'string', nullable: false }],
    variant: 'qualification-order-disambiguator',
    fetchXml: base.query.fetchXml.replaceAll('accountid', 'pqvd_assignmentid')
      .replaceAll('name="account"', 'name="pqvd_assignment"').replaceAll('attribute="name"', 'attribute="pqvd_name"')
      .replaceAll('<attribute name="name">', '<attribute name="pqvd_name">') };
  const configurationCells = [0, 1].flatMap(roleMask => ['liquid', 'webapi'].map(lane => ({
    id: `${variantId}:m${roleMask}:read:${lane}`, variantId, roleMask, lane, operation: 'read',
    regions, wholeFixturePartition: true, nativeQualification: 'unrecorded' })));
  return { ...base, variantId, family: 'permission-order-disambiguator', parameters: {},
    roles: [{ id: roleId, name: components[0].name, active: true, anonymous: false, authenticated: false }],
    permissions, components, query, configurationCells,
    bindingContract: { bindRecordIds(ids) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 16 || ids.some(id =>
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))) throw new Error('Bind one to sixteen verified assignment GUIDs.');
      return { ...query, fixtureBindings: [], fetchXml: query.fetchXml.replace('{{qualificationRecordIdValues}}',
        ids.map(id => `<value>${id.toLowerCase()}</value>`).join('')) };
    } },
    metadataRequirements: [],
    metadataReadbackRequirements: [{ schemaName: 'account_parent_account', referencedEntity: 'account',
      referencingEntity: 'account', referencingAttribute: 'parentaccountid', mustAlreadyExist: true }],
    fixtureRequirements: [...base.fixtureRequirements, { kind: 'two-order-distinguishing-accessible-paths',
      workforcePhysicalJoins: 5, equipmentPhysicalJoins: 6, requiredAccountParentHops: 2,
      requiredAccessAccountTargets: ['child', 'top'], regions }],
    runtimeRequirements: [...base.runtimeRequirements, { kind: 'independent-dual-cache-repeated-query-order',
      minimumRepetitions: 2, requireBothSourcePathsPresent: true, requireFinalLatePreOperationXml: true }],
    hypotheses: { 'depth-descending': [assets.id, workforce.id], 'path-lexical': [workforce.id, assets.id] },
    nativeCellsPerRepeat: 4, minimumRepeatedReadCells: 8, nativeQualifiedCells: 0,
    qualification: 'order-experiment-unrecorded', sourceHashes: {
      schema: hash(schema), catalogue: hash(catalogue), components: hash(components), query: hash(query) } };
}

/** Extend disposable fixtures with two additional parent Accounts per region.
 * Access is associated with both the child and top Accounts: either leaf path
 * is independently positive in the own region, not merely syntactically valid. */
export function planPermissionOrderDisambiguatorFixtures(configuration, options) {
  if (configuration.family !== 'permission-order-disambiguator') throw new Error('Wrong disambiguator configuration.');
  const plan = planQualificationFixtures(configuration, options);
  const originalRecordCount = plan.records.length;
  for (const [regionIndex, region] of regions.entries()) {
    const child = plan.records.find(record => record.table === 'account' && record.region === region);
    const originalParent = child.refs.parentaccountid;
    if (!originalParent?.id || originalParent.table !== 'account') throw new Error('The child Account must have a resolved native parent.');
    const topId = componentId(`qualification-fixture:${plan.runId}:${region}:order-top`);
    const midId = componentId(`qualification-fixture:${plan.runId}:${region}:order-mid`);
    const token = child.uniqueRunToken;
    const account = (key, id, parent) => {
      const fields = { ...child.fields, name: `Qualification order ${key} ${token} ${region}` };
      for (const columns of plan.tables.find(table => table.name === 'account').keys ?? []) for (const column of columns)
        if (typeof fields[column] === 'string') fields[column] = `QF-${token}-${regionIndex}-${key}`;
      return { key: `QF-${token}-${regionIndex}-${key}`, id, table: 'account', region,
        fields, refs: { parentaccountid: parent }, deferredRefs: [], uniqueRunToken: token };
    };
    plan.records.push(account('order-top', topId, originalParent), account('order-mid', midId, { id: topId, table: 'account' }));
    child.refs.parentaccountid = { id: midId, table: 'account' };
    child.deferredRefs = [...new Set([...child.deferredRefs, 'parentaccountid'])];
    const grant = plan.records.find(record => record.table === 'pqvd_accesspermission' && record.region === region);
    for (const relationship of ['pqvd_access_accounts', 'pqvd_access_referenceaccounts']) plan.associations.push({
      relationship, from: { id: grant.id, table: grant.table }, to: { id: topId, table: 'account' }, region });
  }
  // Original dependent records and the child Accounts must be removed before
  // their newly appended parent Accounts, irrespective of cascade policy.
  plan.cleanup = [...plan.records.slice(0, originalRecordCount).reverse(),
    ...plan.records.slice(originalRecordCount).reverse()].map(record => ({ table: record.table, id: record.id,
    expectedUniqueRunToken: record.uniqueRunToken, requireCurrentETag: true, requireOwnedRecordReadback: true }));
  delete plan.planHash; plan.planHash = hash(plan);
  return plan;
}
