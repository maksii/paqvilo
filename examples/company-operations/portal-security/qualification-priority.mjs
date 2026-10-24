import { createHash } from 'node:crypto';
import { componentId } from './blueprint.mjs';
import { scopeHierarchyVariantCases, materializeScopeHierarchyVariant } from './qualification-domain.mjs';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Exhaustive leaf flags for a finite positive/negative lifecycle graph.
 * Ancestor cooperation is deliberately a separate dimension: leaf Create or
 * Append alone cannot demonstrate successful lookup binding. */
export function equipmentLifecycleConfigurations({ schema, catalogue }) {
  const baseVariant = [...scopeHierarchyVariantCases()].find(
    (variant) =>
      variant.family === 'parent-depth' && equal(variant.parameters, { depth: 2, parentRead: true, leafPrivileges: 1 }),
  );
  const base = materializeScopeHierarchyVariant(baseVariant, { schema, catalogue });
  const rightNames = ['read', 'create', 'write', 'delete', 'append', 'appendTo'];
  const privileges = (mask) => Object.fromEntries(rightNames.map((right, bit) => [right, Boolean(mask & (1 << bit))]));
  const configurations = [];
  for (const ancestorProfile of ['read-only', 'cooperating-lookup-targets'])
    for (let leafPrivileges = 0; leafPrivileges < 64; leafPrivileges++) {
      const variantId = `equipment-lifecycle:${ancestorProfile}:${leafPrivileges}`;
      const short = hash(variantId).slice(0, 20),
        roleId = componentId('qualification:' + variantId + ':role');
      const configuration = {
        ...base,
        variantId,
        family: 'equipment-lifecycle',
        parameters: { ancestorProfile, leafPrivileges },
        roles: [{ ...base.roles[0], id: roleId, name: `CO Qualification ${short} 0` }],
        permissions: [],
        components: [],
      };
      const add = (table, scope, parent, relationship, flags) => {
        const index = configuration.permissions.length;
        const permission = {
          id: componentId('qualification:' + variantId + ':' + table),
          name: `CO Qualification ${short} ${index}`,
          table,
          scope,
          parentId: parent?.id ?? null,
          relationship,
          privileges: privileges(flags),
          roleIds: [roleId],
          active: true,
          path: 'lifecycle',
        };
        configuration.permissions.push(permission);
        return permission;
      };
      const contact = add('contact', 'Self', null, null, 1);
      const access = add('pqvd_accesspermission', 'Parent', contact, 'pqvd_contact_access_grantee', 1);
      const account = add(
        'account',
        'Parent',
        access,
        'pqvd_access_accounts',
        ancestorProfile === 'read-only' ? 1 : 49,
      );
      const site = add('pqvd_site', 'Parent', account, 'pqvd_account_sites', 1);
      const building = add('pqvd_building', 'Parent', site, 'pqvd_site_buildings', 1);
      add('pqvd_room', 'Parent', building, 'pqvd_building_rooms', ancestorProfile === 'read-only' ? 1 : 49);
      const equipment = add('pqvd_equipment', 'Parent', account, 'pqvd_account_equipments', leafPrivileges);
      configuration.components = [
        {
          id: roleId,
          type: 11,
          name: configuration.roles[0].name,
          state: 0,
          content: {
            anonymoususersrole: false,
            authenticatedusersrole: false,
            description: 'Bounded Equipment lifecycle native qualification.',
          },
        },
        ...configuration.permissions.map((permission) => ({
          id: permission.id,
          type: 18,
          name: permission.name,
          state: 0,
          content: {
            entityname: permission.name,
            entitylogicalname: permission.table,
            scope: permission.scope === 'Self' ? 756150004 : 756150003,
            read: permission.privileges.read,
            create: permission.privileges.create,
            write: permission.privileges.write,
            delete: permission.privileges.delete,
            append: permission.privileges.append,
            appendto: permission.privileges.appendTo,
            adx_entitypermission_webrole: permission.roleIds,
            ...(permission.parentId
              ? { parententitypermission: permission.parentId, parentrelationship: permission.relationship }
              : {}),
          },
        })),
      ];
      configuration.query = {
        ...base.query,
        id: `QF-${short}-R`,
        name: `Equipment lifecycle ${ancestorProfile} ${leafPrivileges}`,
        table: equipment.table,
        entitySet: schema.tables.find((table) => table.name === equipment.table).entitySetName,
        primaryId: 'pqvd_equipmentid',
        primaryName: 'pqvd_name',
        variant: 'qualification-equipment-lifecycle',
        fields: [
          { name: 'pqvd_equipmentid', source: 'pqvd_equipmentid', type: 'guid', nullable: false },
          { name: 'pqvd_name', source: 'pqvd_name', type: 'string', nullable: false },
        ],
        fetchXml: base.query.fetchXml
          .replaceAll('accountid', 'pqvd_equipmentid')
          .replaceAll('name="account"', 'name="pqvd_equipment"')
          .replaceAll('attribute="name"', 'attribute="pqvd_name"')
          .replaceAll('<attribute name="name">', '<attribute name="pqvd_name">'),
      };
      configuration.bindingContract = {
        bindRecordIds(ids) {
          if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 16 ||
            ids.some((id) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
          )
            throw new Error('Lifecycle query needs one to sixteen verified native GUIDs.');
          return {
            ...configuration.query,
            fixtureBindings: [],
            fetchXml: configuration.query.fetchXml.replace(
              '{{qualificationRecordIdValues}}',
              ids.map((id) => `<value>${id.toLowerCase()}</value>`).join(''),
            ),
          };
        },
      };
      configuration.configurationCells = base.configurationCells.map((cell) => ({
        ...cell,
        id: cell.id.replace(base.variantId, variantId),
        variantId,
        actualPortalCRUDRequired: cell.operation !== 'read',
        sdkFixtureProvisioningIsNotPositiveCredit: true,
        ...(cell.operation === 'create' || cell.operation === 'append'
          ? {
              requiredLookupTargets: ['owning-account', 'same-account-room', 'actor-owned-run'],
              objectBoundAppendChecks: true,
            }
          : {}),
      }));
      configuration.metadataRequirements = [];
      configuration.fixtureRequirements = [
        {
          kind: 'owned-stock-lifecycle-equipment',
          requiredColumns: { pqvd_equipmentstate: 183270000, pqvd_currentassignmentid: null },
          requiredCanaryTagPrefix: 'CO-CANARY-',
          requiredActorOwnedRun: true,
          requiredSameAccountRoom: true,
          forbidReferencingAssignmentFinanceServiceRecords: true,
          requireFreshRunUniqueKeys: true,
          regions: ['own-scope', 'same-company-other-branch', 'foreign-company'],
        },
      ];
      configuration.runtimeRequirements = [
        ...base.runtimeRequirements.filter((requirement) => requirement.kind !== 'business-crud-context-observation'),
        {
          kind: 'business-crud-context-observation',
          tables: ['pqvd_equipment'],
          requiredMessages: ['Create', 'Update', 'Delete', 'Associate', 'Disassociate'],
          requireActualPortalActorAndImmutableIntent: true,
        },
        {
          kind: 'original-business-projection-guard-retained',
          requireConfiguredSDKFixtureWriter: true,
          sdkExecutionIsNotPortalCRUDCredit: true,
        },
        {
          kind: 'baseline-equipment-delete-isolation',
          disableOnlyRecorderOwnRunDeletePermission: true,
          restoreExactBeforeState: true,
        },
      ];
      configuration.sourceHashes = {
        ...base.sourceHashes,
        components: hash(configuration.components),
        query: hash(configuration.query),
      };
      configuration.nativeQualifiedCells = 0;
      configuration.nativeQualification = 'unrecorded';
      configurations.push(configuration);
    }
  return {
    kind: 'bounded-equipment-lifecycle-domain',
    configurations,
    dimensions: { leafPrivilegeMasks: 64, ancestorProfiles: 2, roleSubsets: 2, regions: 3 },
    requiredNativeConfigurations: configurations.length,
    requiredNativeCells: configurations.reduce(
      (count, configuration) => count + configuration.configurationCells.length,
      0,
    ),
    nativeQualifiedCells: 0,
    universalPermissionParity: false,
  };
}

/** Highest-risk pilot inputs drawn from the declared grammar, plus six explicit
 * roleless-parent configurations that the original grammar did not contain.
 * Pilots remain actual unrecorded cells; they never replace the full campaign. */
export function highRiskNativeConfigurations({ schema, catalogue }) {
  const variants = [...scopeHierarchyVariantCases()];
  const wanted = [
    ['parent-depth', { depth: 1, parentRead: false, leafPrivileges: 63 }, 'Parent Read=false with fully mutable leaf'],
    [
      'parent-depth',
      { depth: 8, parentRead: false, leafPrivileges: 1 },
      'Deep Read=false ancestor and readable descendant',
    ],
    [
      'activation',
      { state: 'inactive-parent-active-child', depth: 8, childRoles: 'inherited-only' },
      'Inactive parent with inherited child roles',
    ],
    [
      'activation',
      { state: 'inactive-parent-active-child', depth: 8, childRoles: 'same-explicit' },
      'Inactive parent with explicit child roles',
    ],
    [
      'activation',
      { state: 'all-active', depth: 8, childRoles: 'disjoint-explicit' },
      'Disjoint parent/child role combinations',
    ],
    ['relationship', { scope: 'Contact', direction: 'many-to-many' }, 'Contact N:N metadata and identity traversal'],
    ['relationship', { scope: 'Account', direction: 'many-to-many' }, 'Account N:N identity traversal'],
    ['relationship', { scope: 'Parent', direction: 'many-to-many' }, 'Parent N:N permission traversal'],
    ['relationship', { scope: 'Parent', direction: 'reverse-lookup' }, 'Reverse Parent identity traversal'],
    [
      'root-scope',
      { scope: 'Contact', roleDefault: 'anonymous' },
      'Anonymous Contact scope has no authenticated principal',
    ],
    [
      'root-scope',
      { scope: 'Global', roleDefault: 'anonymous' },
      'Anonymous Global grant isolated from recorder permissions',
    ],
    [
      'root-scope',
      { scope: 'Self', roleDefault: 'authenticated' },
      'Authenticated default and baseline Self contamination',
    ],
    [
      'alternative-grants',
      { shape: 'global-plus-scoped', grants: 3, overlap: 'disjoint', leafPrivileges: 63 },
      'Operation union differs across Global/scoped grants',
    ],
    [
      'alternative-grants',
      { shape: 'different-principal', grants: 3, overlap: 'overlapping', leafPrivileges: 63 },
      'Overlapping operation flags and separate principals',
    ],
  ];
  const configurations = wanted.map(([family, parameters, risk]) => {
    const variant = variants.find((variant) => variant.family === family && equal(variant.parameters, parameters));
    if (!variant) throw new Error('Priority requirement absent from finite grammar: ' + family);
    return {
      ...materializeScopeHierarchyVariant(variant, { schema, catalogue }),
      pilotRisk: risk,
      grammarMember: true,
      nativeQualification: 'unrecorded',
    };
  });
  const extra = [];
  for (const depth of [2, 8, 11])
    for (const position of ['root', 'closest-parent']) {
      const variant = variants.find(
        (variant) =>
          variant.family === 'activation' &&
          equal(variant.parameters, { state: 'all-active', depth, childRoles: 'same-explicit' }),
      );
      // depth=2 is an explicit additional graph, constructed from the supported
      // depth=8 activation shape by taking its first three actual source nodes.
      const base =
        variant ??
        variants.find(
          (variant) =>
            variant.family === 'activation' &&
            equal(variant.parameters, { state: 'all-active', depth: 8, childRoles: 'same-explicit' }),
        );
      const configuration = materializeScopeHierarchyVariant(base, { schema, catalogue });
      if (depth === 2) {
        configuration.permissions = configuration.permissions.slice(0, 3);
        configuration.permissions.at(-1).privileges = Object.fromEntries(
          Object.keys(configuration.permissions.at(-1).privileges).map((key) => [key, true]),
        );
        configuration.components = configuration.components.filter(
          (component) =>
            component.type === 11 || configuration.permissions.some((permission) => permission.id === component.id),
        );
        Object.assign(configuration.components.at(-1).content, {
          read: true,
          create: true,
          write: true,
          delete: true,
          append: true,
          appendto: true,
        });
        const table = schema.tables.find((table) => table.name === configuration.permissions.at(-1).table);
        const primaryName = table.primaryName?.name ?? { account: 'name', contact: 'fullname' }[table.name];
        configuration.query = {
          ...configuration.query,
          table: table.name,
          entitySet: table.entitySetName,
          primaryId: `${table.name}id`,
          primaryName,
          fields: [
            { name: `${table.name}id`, source: `${table.name}id`, type: 'guid', nullable: false },
            { name: primaryName, source: primaryName, type: 'string', nullable: false },
          ],
          fetchXml: configuration.query.fetchXml
            .replaceAll(configuration.query.table, table.name)
            .replaceAll(configuration.query.primaryName, primaryName),
        };
      }
      const oldVariantId = configuration.variantId;
      configuration.variantId = `parent-roleless:${depth}:${position}`;
      configuration.family = 'parent-roleless';
      configuration.parameters = { depth, position };
      const ids = new Map(
        configuration.components.map((component) => [
          component.id,
          componentId('qualification-extra:' + configuration.variantId + ':' + component.id),
        ]),
      );
      for (const [index, role] of configuration.roles.entries()) {
        role.id = ids.get(role.id);
        role.name = `CO Qualification ${hash(configuration.variantId).slice(0, 20)} ${index}`;
      }
      for (const permission of configuration.permissions) {
        permission.id = ids.get(permission.id);
        permission.parentId = permission.parentId ? ids.get(permission.parentId) : null;
        permission.roleIds = permission.roleIds.map((role) => ids.get(role));
      }
      for (const component of configuration.components) {
        component.id = ids.get(component.id);
        if (component.type === 11) component.name = configuration.roles.find((role) => role.id === component.id).name;
        if (component.content.adx_entitypermission_webrole)
          component.content.adx_entitypermission_webrole = component.content.adx_entitypermission_webrole.map((role) =>
            ids.get(role),
          );
        if (component.content.parententitypermission)
          component.content.parententitypermission = ids.get(component.content.parententitypermission);
      }
      const roleless = position === 'root' ? configuration.permissions[0] : configuration.permissions.at(-2);
      roleless.roleIds = [];
      configuration.components.find((component) => component.id === roleless.id).content.adx_entitypermission_webrole =
        [];
      configuration.query.id = `QF-${hash(configuration.variantId).slice(0, 20)}-R`;
      configuration.query.variant = 'qualification-parent-roleless';
      configuration.configurationCells = configuration.configurationCells.map((cell) => ({
        ...cell,
        id: cell.id.replace(oldVariantId, configuration.variantId),
        variantId: configuration.variantId,
      }));
      configuration.fixtureRequirements.find(
        (requirement) => requirement.kind === 'isolated-three-region-fixture-graphs',
      ).existingFixtureKeys = catalogue.records
        .filter((record) => record.table === configuration.query.table)
        .map((record) => record.key);
      configuration.runtimeRequirements.find(
        (requirement) => requirement.kind === 'business-crud-context-observation',
      ).tables = [...new Set(configuration.permissions.map((permission) => permission.table))];
      // Rebinding uses the exact modified query; the inherited closure captured
      // the original table and must never silently submit that older query.
      configuration.bindingContract = {
        bindRecordIds(ids) {
          if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 16 ||
            ids.some((id) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
          )
            throw new Error('Roleless-parent pilot requires one to sixteen verified native GUIDs.');
          return {
            ...configuration.query,
            fixtureBindings: [],
            fetchXml: configuration.query.fetchXml.replace(
              '{{qualificationRecordIdValues}}',
              ids.map((id) => `<value>${id.toLowerCase()}</value>`).join(''),
            ),
          };
        },
      };
      configuration.sourceHashes.components = hash(configuration.components);
      configuration.sourceHashes.query = hash(configuration.query);
      configuration.pilotRisk = 'Roleless ancestor with explicitly associated active child';
      configuration.grammarMember = false;
      configuration.nativeQualification = 'unrecorded';
      extra.push(configuration);
    }
  return {
    kind: 'priority-native-configuration-inputs',
    qualification: 'unrecorded',
    configurations: [...configurations, ...extra],
    originalGrammarPilotCount: configurations.length,
    extraDomain: {
      id: 'six-roleless-ancestor-graphs',
      configurations: extra.length,
      requiredNativeCells: extra.reduce((count, configuration) => count + configuration.configurationCells.length, 0),
      nativeQualifiedCells: 0,
    },
    universalPermissionParity: false,
  };
}
