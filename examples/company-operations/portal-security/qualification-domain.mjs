import { createHash } from 'node:crypto';

const stable = (value) => JSON.stringify(order(value));
const order = (value) =>
  Array.isArray(value)
    ? value.map(order)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, order(value[key])]),
        )
      : value;
const digest = (value) => createHash('sha256').update(stable(value)).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/;
export const privilegeNames = ['read', 'create', 'write', 'delete', 'append', 'appendTo'];
export const requiredNativeWitnesses = [
  'nativeConfiguration',
  'nativeMemberships',
  'nativeFixtures',
  'nativeSettings',
  'nativeTemplates',
];

/** This is a finite campaign over one fixed exported permission graph, not a
 * statement about every possible permission graph or future Power Pages build. */
export function buildQualificationDomain({ blueprint, schema, catalogue, manifest, witnesses = {} }) {
  const businessRoles = blueprint.roles.filter((role) => role.code !== 'TESTRUNNER');
  if (businessRoles.length !== 12 || new Set(businessRoles.map((role) => role.id)).size !== 12)
    throw new Error('The source-role campaign requires the twelve distinct authored business roles.');
  if (
    !Array.isArray(blueprint.nodes) ||
    new Set(blueprint.nodes.map((node) => node.id)).size !== blueprint.nodes.length
  )
    throw new Error('The source permission graph contains duplicate or missing definitions.');
  const queries = [
    ...(manifest.cases ?? []),
    ...(manifest.stressCases ?? []),
    ...(manifest.odataVariants ?? []),
    ...(manifest.odataPositiveVariants ?? []),
  ].map((plan) => ({
    id: plan.id,
    table: plan.table,
    variant: plan.variant,
    authoredQueryHash: digest({
      fetchXml: plan.fetchXml,
      queryType: plan.queryType ?? 'fetchxml',
      fields: plan.fields,
      ...(plan.queryType === 'odata'
        ? {
            fixtureIds: plan.fixtureIds,
            primaryId: plan.primaryId,
            primaryName: plan.primaryName,
            variant: plan.variant,
          }
        : {}),
    }),
    lanes: plan.queryType === 'odata' ? ['webapi'] : ['liquid', 'webapi'],
    maxPages: 20,
    pageSize: plan.pageSize,
    fragments: (plan.fragments ?? []).map((fragment) => fragment.variant),
  }));
  if (!queries.length || new Set(queries.map((query) => query.id)).size !== queries.length)
    throw new Error('The finite query catalogue must have distinct case IDs.');
  for (const [name, value] of Object.entries(witnesses))
    if (!hashPattern.test(value)) throw new Error(`Witness '${name}' must be a SHA-256 hash of a frozen input.`);
  const source = {
    permissionGraphHash: digest(blueprint.nodes),
    roleDefinitionsHash: digest(blueprint.roles),
    schemaHash: digest(schema),
    fixtureHash: digest(catalogue),
    queryCatalogueHash: digest(queries),
    witnesses,
  };
  const roleMaskCount = 2 ** businessRoles.length;
  const readCellsPerMask = queries.reduce((count, query) => count + query.lanes.length, 0);
  const mutationTables = catalogue.crudFixtures.filter((fixture) => fixture.targets).map((fixture) => fixture.table);
  const domain = {
    schemaVersion: 1,
    kind: 'fixed-source-exhaustive-role-lattice',
    source,
    inputHash: digest(source),
    businessRoles,
    queries,
    roleMaskCount,
    requiredNativeWitnesses,
    missingNativeWitnesses: requiredNativeWitnesses.filter((name) => !witnesses[name]),
    iterationOrder: 'binary-reflected-gray-code',
    readDomain: {
      roleMasks: roleMaskCount,
      queryVariants: queries.length,
      laneCellsPerMask: readCellsPerMask,
      originalODataVariants: manifest.odataVariants?.length ?? 0,
      additionalWellFormedODataVariants: manifest.odataPositiveVariants?.length ?? 0,
      denominator: roleMaskCount * readCellsPerMask,
      pagination: 'Each cell includes every fragment and complete page sequence.',
    },
    privilegeLedgerDomain: {
      roleMasks: roleMaskCount,
      tables: mutationTables,
      privileges: privilegeNames,
      sides: ['A', 'B'],
      denominator: roleMaskCount * mutationTables.length * privilegeNames.length * 2,
      kind: 'configuration-oracle-only',
      nativeQualification: false,
      limitation:
        'Native mutation coverage requires isolated disposable fixtures, original plugin guards and restoration; a local allowed() check is not a native CRUD result.',
    },
    excluded: [
      'Changing arbitrary privilege flags or role associations on the permission graph.',
      'Arbitrary query text, hierarchy shapes, record universes or future platform versions.',
      'Enhanced authorization and Custom Access Preview, which are absent from this traditional-authorization source.',
      'Scope/hierarchy fault variants: these have their own finite scenario domain and cannot be credited as source-role-lattice cells.',
    ],
    prerequisites: [
      'Frozen native source/settings/data snapshots',
      'Verified live contact role associations',
      'Cache stabilization attested by actual terminal permission principal footprint, not only Liquid user.roles',
      'Exact received backend query bytes/context and complete outcomes/rows',
      'No silent unsupported or skipped cases',
    ],
  };
  domain.domainHash = digest(domain);
  return domain;
}

export function* qualificationRoleMasks(domain) {
  let previous = 0;
  for (let index = 0; index < domain.roleMaskCount; index++) {
    const mask = index ^ (index >> 1);
    const selected = domain.businessRoles.filter((_, bit) => mask & (1 << bit));
    yield {
      index,
      mask,
      previousMask: index ? previous : null,
      changedRoleBits: index ? mask ^ previous : mask,
      roleCodes: selected.map((role) => role.code),
      roleIds: selected.map((role) => role.id),
      roleNames: selected.map((role) => role.name),
      runnerRequired: true,
    };
    previous = mask;
  }
}

export function* qualificationReadCells(domain, { masks, afterCellId } = {}) {
  const selection = masks == null ? null : new Set(masks);
  if (selection && [...selection].some((mask) => !Number.isInteger(mask) || mask < 0 || mask >= domain.roleMaskCount))
    throw new Error('Every selected role mask must belong to the finite source-role lattice.');
  let waiting = afterCellId != null;
  for (const roles of qualificationRoleMasks(domain)) {
    if (selection && !selection.has(roles.mask)) continue;
    for (const query of domain.queries)
      for (const lane of query.lanes) {
        const id = `${domain.domainHash}:m${roles.mask}:${query.id}:${lane}`;
        if (waiting) {
          if (id === afterCellId) waiting = false;
          continue;
        }
        yield {
          id,
          domainHash: domain.domainHash,
          inputHash: domain.inputHash,
          mask: roles.mask,
          roleCodes: roles.roleCodes,
          roleIds: roles.roleIds,
          roleNames: roles.roleNames,
          queryId: query.id,
          table: query.table,
          lane,
          authoredQueryHash: query.authoredQueryHash,
          maxPages: query.maxPages,
          requiredFragments: query.fragments,
        };
      }
  }
  if (waiting) throw new Error('The resume cell does not belong to this selected campaign domain.');
}

/** Independent blueprint expectation used to reject stale role/security caches.
 * Multiplicity is preserved: two qualifying paths can have the same principal. */
export function expectedPrincipalFootprint(blueprint, schema, table, roleCodes) {
  const selected = new Set(roleCodes),
    byKey = new Map(blueprint.nodes.map((node) => [node.key, node]));
  const relationships = new Map(schema.relationships.map((relationship) => [relationship.name, relationship]));
  const terminals = [];
  for (const leaf of blueprint.nodes.filter(
    (node) => node.active && node.table === table && node.privileges.read && selected.has(node.role),
  )) {
    const visited = new Set();
    let current = leaf,
      complete = true,
      depth = 0;
    while (current?.parent) {
      if (visited.has(current.key)) throw new Error('Cycle in the finite permission graph.');
      visited.add(current.key);
      depth++;
      const parent = byKey.get(current.parent);
      if (!parent?.active || !parent.privileges.read || !selected.has(parent.role)) {
        complete = false;
        break;
      }
      current = parent;
    }
    if (!complete || !current) continue;
    if (current.scope !== 'Contact') continue; // Self/control grants have a separate endpoint contract.
    const field = relationships.get(current.relationship)?.lookup?.name;
    if (!field) throw new Error('The Contact terminal has no source relationship lookup.');
    terminals.push({ field, role: current.role, permissionId: leaf.id, terminalPermissionId: current.id, depth });
  }
  return terminals.sort(
    (left, right) => left.field.localeCompare(right.field) || left.permissionId.localeCompare(right.permissionId),
  );
}

/** Report failures and missing evidence without converting them into coverage. */
export function summarizeQualification(domain, observations) {
  const queryById = new Map(domain.queries.map((query) => [query.id, query]));
  const seen = new Set(),
    counts = { equal: 0, different: 0, unqualified: 0, blocked: 0 };
  const reasons = {};
  for (const observation of observations) {
    const query = queryById.get(observation.queryId);
    const id = `${domain.domainHash}:m${observation.mask}:${observation.queryId}:${observation.lane}`;
    if (
      observation.id !== id ||
      !Number.isInteger(observation.mask) ||
      observation.mask < 0 ||
      observation.mask >= domain.roleMaskCount ||
      !query?.lanes.includes(observation.lane)
    )
      throw new Error('Observation does not belong to this frozen finite campaign.');
    if (seen.has(id)) throw new Error('Duplicate campaign cell cannot increase coverage.');
    seen.add(id);
    let verdict = observation.verdict;
    const evidence = observation.evidence ?? {};
    const missing = [
      'nativeConfigurationVerified',
      'nativeMembershipsVerified',
      'nativeDataVerified',
      'nativeCacheQualified',
      'completePages',
      'backendBytesCompared',
      'runtimeContextCompared',
      'outcomeCompared',
      'rowsCompared',
    ].filter((name) => evidence[name] !== true);
    if (observation.inputHash !== domain.inputHash) missing.push('frozen-input-hash');
    missing.push(...domain.missingNativeWitnesses.map((name) => `missing-witness:${name}`));
    if (verdict === 'equal' && missing.length) verdict = 'unqualified';
    if (!Object.hasOwn(counts, verdict)) throw new Error('Unknown campaign cell verdict.');
    counts[verdict]++;
    for (const reason of missing) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  const denominator = domain.readDomain.denominator;
  return {
    domainHash: domain.domainHash,
    denominator,
    observed: seen.size,
    missing: denominator - seen.size,
    ...counts,
    coveragePercent: (counts.equal * 100) / denominator,
    complete: counts.equal === denominator,
    qualification: counts.equal === denominator ? 'fixed-source-domain-only' : 'incomplete',
    reasons,
    universalPermissionParity: false,
  };
}

/** Explicit grammar for a separate finite native configuration campaign.
 * These cases are requirements until isolated source/data generators and live
 * capture evidence exist; enumerating a name does not qualify its behavior. */
export function scopeHierarchyVariantDomain() {
  const families = [
    {
      id: 'root-scope',
      dimensions: {
        scope: ['Global', 'Contact', 'Account', 'Self'],
        roleDefault: ['explicit', 'anonymous', 'authenticated'],
      },
    },
    {
      id: 'relationship',
      dimensions: {
        scope: ['Contact', 'Account', 'Parent'],
        direction: ['child-lookup', 'reverse-lookup', 'many-to-many'],
      },
    },
    {
      id: 'parent-depth',
      dimensions: {
        depth: [1, 2, 8, 11],
        parentRead: [true, false],
        leafPrivileges: Array.from({ length: 64 }, (_, mask) => mask),
      },
    },
    {
      id: 'alternative-grants',
      dimensions: {
        shape: ['same-path', 'different-principal', 'different-branch', 'global-plus-scoped'],
        grants: [2, 3],
        overlap: ['disjoint', 'overlapping', 'identical'],
        leafPrivileges: Array.from({ length: 64 }, (_, mask) => mask),
      },
    },
    {
      id: 'activation',
      dimensions: {
        state: ['all-active', 'whole-subtree-inactive', 'inactive-parent-active-child', 'inactive-role'],
        depth: [1, 8, 11],
        childRoles: ['inherited-only', 'same-explicit', 'additional-explicit', 'disjoint-explicit'],
      },
    },
  ];
  const cardinality = (family) => Object.values(family.dimensions).reduce((count, values) => count * values.length, 1);
  return {
    schemaVersion: 1,
    kind: 'bounded-scope-hierarchy-grammar',
    families: families.map((family) => ({ ...family, denominator: cardinality(family) })),
    denominator: families.reduce((count, family) => count + cardinality(family), 0),
    nativeQualifiedCases: 0,
    qualification: 'requirements-only',
    profile: 'traditional-authorization',
    excluded: [
      'Custom Access Preview/enhanced authorization',
      'Arbitrary graph topology beyond these explicit families',
    ],
  };
}

export function* scopeHierarchyVariantCases(domain = scopeHierarchyVariantDomain()) {
  function* product(entries, index = 0, values = {}) {
    if (index === entries.length) {
      yield values;
      return;
    }
    const [name, alternatives] = entries[index];
    for (const value of alternatives) yield* product(entries, index + 1, { ...values, [name]: value });
  }
  for (const family of domain.families)
    for (const parameters of product(Object.entries(family.dimensions)))
      yield {
        id: `${family.id}:${digest(parameters)}`,
        family: family.id,
        parameters,
        leafPrivileges:
          parameters.leafPrivileges == null
            ? undefined
            : Object.fromEntries(
                privilegeNames.map((right, bit) => [right, Boolean(parameters.leafPrivileges & (1 << bit))]),
              ),
        nativeQualification: 'unrecorded',
        requiredOperations: privilegeNames,
        requiredRegions: ['own-scope', 'same-company-other-branch', 'foreign-company'],
        requiresIsolatedGraph: true,
      };
}

const scopeValues = { Global: 756150000, Contact: 756150001, Account: 756150002, Parent: 756150003, Self: 756150004 };
const guidFor = (value) => {
  const chars = digest(value).slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = '8';
  const text = chars.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};
const decodePrivileges = (mask) =>
  Object.fromEntries(privilegeNames.map((right, bit) => [right, Boolean(mask & (1 << bit))]));

/** Materialize actual table/relationship/permission definitions for one finite
 * variant. This remains a plan until the sole live coordinator binds the actor,
 * installs isolated fixture recipes, deploys its templates and records results.
 * Every definition is reusable by native enhanced-data-model components and the
 * local source importer; no live endpoint or contact is embedded here. */
/** Hashes of the shared inputs; a caller materializing many variants computes them once and passes them back. */
export const variantInputHashes = ({ schema, catalogue }) => ({ schema: digest(schema), catalogue: digest(catalogue) });

export function materializeScopeHierarchyVariant(
  variant,
  { schema, catalogue, inputHashes = variantInputHashes({ schema, catalogue }) },
) {
  const grammar = scopeHierarchyVariantDomain(),
    family = grammar.families.find((family) => family.id === variant.family);
  const parameters = variant.parameters;
  if (
    !family ||
    variant.id !== `${family.id}:${digest(parameters)}` ||
    Object.keys(parameters).length !== Object.keys(family.dimensions).length ||
    Object.entries(family.dimensions).some(([name, values]) => !values.includes(parameters[name]))
  )
    throw new Error('Variant is not a member of the declared finite configuration grammar.');
  const relationships = new Map(schema.relationships.map((relationship) => [relationship.name, relationship]));
  relationships.set('contact_customer_accounts', {
    name: 'contact_customer_accounts',
    kind: 'oneToMany',
    parent: 'account',
    child: 'contact',
    lookup: { name: 'parentcustomerid' },
  });
  const relationship = (name) => {
    if (!relationships.has(name)) throw new Error(`The source schema lacks '${name}'.`);
    return name;
  };
  const roleCount =
    family.id === 'alternative-grants'
      ? parameters.grants
      : family.id === 'activation' && ['additional-explicit', 'disjoint-explicit'].includes(parameters.childRoles)
        ? 2
        : 1;
  const short = digest(variant.id).slice(0, 20);
  const roles = Array.from({ length: roleCount }, (_, index) => ({
    id: guidFor([variant.id, 'role', index]),
    code: `Q${index}`,
    name: `CO Qualification ${short} ${index}`,
    active: parameters.state !== 'inactive-role',
    anonymous: parameters.roleDefault === 'anonymous',
    authenticated: parameters.roleDefault === 'authenticated',
  }));
  const permissions = [],
    metadataRequirements = [],
    fixtureRequirements = [],
    runtimeRequirements = [];
  const add = (table, scope, parent = null, relation = null, rights = 1, roleIds = [roles[0].id], path = 'main') => {
    const index = permissions.length;
    const permission = {
      id: guidFor([variant.id, 'permission', index]),
      name: `CO Qualification ${short} ${path} ${index}`,
      table,
      scope,
      parentId: parent?.id ?? null,
      relationship: relation,
      privileges: decodePrivileges(rights),
      roleIds,
      active: true,
      path,
    };
    if (relation) relationship(relation);
    permissions.push(permission);
    return permission;
  };
  const qualifiedContactNn = 'pqvd_qfcontactorgcontacts';
  const ensureContactNn = () => {
    if (!relationships.has(qualifiedContactNn)) {
      const definition = {
        name: qualifiedContactNn,
        kind: 'manyToMany',
        parent: 'contact',
        child: 'pqvd_orgcontact',
        intersectName: qualifiedContactNn,
        intersectColumns: ['contactid', 'pqvd_orgcontactid'],
      };
      relationships.set(qualifiedContactNn, definition);
      metadataRequirements.push({
        kind: 'create-many-to-many-relationship',
        definition,
        nativeBody: {
          '@odata.type': 'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata',
          SchemaName: qualifiedContactNn,
          IntersectEntityName: qualifiedContactNn,
          Entity1LogicalName: 'contact',
          Entity2LogicalName: 'pqvd_orgcontact',
          Entity1IntersectAttribute: 'contactid',
          Entity2IntersectAttribute: 'pqvd_orgcontactid',
          Entity1AssociatedMenuConfiguration: { Behavior: 'DoNotDisplay', Group: 'Details', Order: 10000 },
          Entity2AssociatedMenuConfiguration: { Behavior: 'DoNotDisplay', Group: 'Details', Order: 10000 },
        },
        requiredReadback: [
          'SchemaName',
          'IntersectEntityName',
          'Entity1IntersectAttribute',
          'Entity2IntersectAttribute',
        ],
        publishAndExportRequired: true,
      });
    }
    return qualifiedContactNn;
  };
  // Eleven Parent edges on existing source relationships, including an actual
  // N:N hop. The permission graph is acyclic even when table types repeat.
  const longPath = [
    ['pqvd_accesspermission', 'pqvd_contact_access_grantee'],
    ['account', 'pqvd_access_accounts'],
    ['pqvd_orgcontact', 'pqvd_account_orgcontacts'],
    ['pqvd_employment', 'pqvd_orgcontact_employments'],
    ['pqvd_assignment', 'pqvd_employment_assignments'],
    ['pqvd_servicerequest', 'pqvd_assignment_requests'],
    ['pqvd_workorder', 'pqvd_request_workorders'],
    ['pqvd_worktask', 'pqvd_workorder_tasks'],
    ['pqvd_checklistitem', 'pqvd_task_checklistitems'],
    ['pqvd_inspection', 'pqvd_checklistitem_inspections'],
    ['pqvd_finding', 'pqvd_inspection_findings'],
  ];
  const path = (depth, { parentRead = true, leafPrivileges = 1, childRoles } = {}) => {
    let previous = add('contact', 'Self', null, null, parentRead ? 1 : 0);
    for (let index = 0; index < depth; index++) {
      let assigned = [roles[0].id];
      if (index === depth - 1 && childRoles === 'inherited-only') assigned = [];
      if (index === depth - 1 && childRoles === 'additional-explicit') assigned = roles.map((role) => role.id);
      if (index === depth - 1 && childRoles === 'disjoint-explicit') assigned = [roles[1].id];
      previous = add(
        longPath[index][0],
        'Parent',
        previous,
        longPath[index][1],
        index === depth - 1 ? leafPrivileges : 1,
        assigned,
      );
    }
    return previous;
  };
  let leaf;
  if (family.id === 'root-scope') {
    leaf = add(
      parameters.scope === 'Self' ? 'contact' : 'pqvd_orgcontact',
      parameters.scope,
      null,
      parameters.scope === 'Contact'
        ? 'pqvd_contact_orgcontacts'
        : parameters.scope === 'Account'
          ? 'pqvd_account_orgcontacts'
          : null,
      63,
    );
  } else if (family.id === 'parent-depth') leaf = path(parameters.depth, parameters);
  else if (family.id === 'activation') {
    leaf = path(parameters.depth, { childRoles: parameters.childRoles, leafPrivileges: 63 });
    if (parameters.state === 'whole-subtree-inactive') for (const permission of permissions) permission.active = false;
    if (parameters.state === 'inactive-parent-active-child') permissions.at(-2).active = false;
  } else if (family.id === 'relationship') {
    if (parameters.scope === 'Contact')
      leaf =
        parameters.direction === 'child-lookup'
          ? add('pqvd_orgcontact', 'Contact', null, 'pqvd_contact_orgcontacts', 63)
          : parameters.direction === 'reverse-lookup'
            ? add('account', 'Contact', null, 'contact_customer_accounts', 63)
            : add('pqvd_orgcontact', 'Contact', null, ensureContactNn(), 63);
    else if (parameters.scope === 'Account')
      leaf =
        parameters.direction === 'child-lookup'
          ? add('pqvd_orgcontact', 'Account', null, 'pqvd_account_orgcontacts', 63)
          : parameters.direction === 'reverse-lookup'
            ? add('contact', 'Account', null, 'contact_customer_accounts', 63)
            : add('pqvd_accesspermission', 'Account', null, 'pqvd_access_accounts', 63);
    else if (parameters.direction === 'many-to-many') {
      const root = add('pqvd_accesspermission', 'Contact', null, 'pqvd_contact_access_grantee');
      leaf = add('account', 'Parent', root, 'pqvd_access_accounts', 63);
    } else if (parameters.direction === 'reverse-lookup') {
      const root = add('pqvd_orgcontact', 'Contact', null, 'pqvd_contact_orgcontacts');
      leaf = add('account', 'Parent', root, 'pqvd_account_orgcontacts', 63);
    } else {
      const root = add('pqvd_orgcontact', 'Contact', null, 'pqvd_contact_orgcontacts');
      leaf = add('pqvd_employment', 'Parent', root, 'pqvd_orgcontact_employments', 63);
    }
  } else if (family.id === 'alternative-grants') {
    for (let grant = 0; grant < parameters.grants; grant++) {
      const rightMask =
        parameters.overlap === 'identical'
          ? parameters.leafPrivileges
          : privilegeNames.reduce(
              (mask, _, bit) =>
                mask |
                (parameters.leafPrivileges & (1 << bit) &&
                (bit % parameters.grants === grant ||
                  (parameters.overlap === 'overlapping' && (bit + 1) % parameters.grants === grant))
                  ? 1 << bit
                  : 0),
              0,
            );
      const ownRoles = [roles[grant].id],
        name = `alternative-${grant}`;
      if (parameters.shape === 'global-plus-scoped' && grant === 0)
        leaf = add('account', 'Global', null, null, rightMask, ownRoles, name);
      else {
        const principal = parameters.shape === 'same-path' ? 'grantee' : ['it', 'hr', 'cto'][grant];
        const root = add(
          'pqvd_accesspermission',
          'Contact',
          null,
          `pqvd_contact_access_${principal}`,
          1,
          ownRoles,
          name,
        );
        const rel =
          parameters.shape === 'different-branch' && grant === 1
            ? 'pqvd_access_referenceaccounts'
            : 'pqvd_access_accounts';
        leaf = add('account', 'Parent', root, rel, rightMask, ownRoles, name);
      }
    }
  }
  const table = schema.tables.find((table) => table.name === leaf.table);
  if (!table) throw new Error('The planned leaf table is absent from the source schema.');
  const primaryName =
    table.primaryName?.name ??
    { contact: 'fullname', account: 'name', transactioncurrency: 'currencyname' }[table.name];
  if (!primaryName) throw new Error('The leaf table has no qualified primary name metadata.');
  const fields = [
    { name: `${leaf.table}id`, type: 'guid' },
    { name: primaryName, type: 'string' },
  ];
  const fixtureKeys = catalogue.records.filter((record) => record.table === leaf.table).map((record) => record.key);
  fixtureRequirements.push(
    {
      kind: 'current-recorded-actor',
      binding: 'actorContactId',
      origin: 'Native signed-in shell/Context2; never the SDK application user.',
    },
    {
      kind: 'isolated-three-region-fixture-graphs',
      regions: ['own-scope', 'same-company-other-branch', 'foreign-company'],
      tableTemplates: catalogue.crudFixtures
        .filter((fixture) => fixture.targets)
        .map((fixture) => ({
          table: fixture.table,
          source: `CANARY-A-${fixture.table}`,
          fields: fixture.createTemplate.fields,
          refs: fixture.createTemplate.refs,
          uniqueColumns:
            schema.tables.find((table) => table.name === fixture.table)?.keys?.flatMap((key) => key.columns) ?? [],
          requireUniqueRunKeys: true,
          installIdentity: 'configured-fixture-writer',
          portalMutation: false,
        })),
      existingFixtureKeys: fixtureKeys,
      ownActorContactRef: 'actorContactId',
      accountScopes: ['A-RIV', 'A-HILL', 'B-LAKE'],
      actorLookupBindings: [
        {
          table: 'pqvd_orgcontact',
          column: 'pqvd_contactid',
          ownScope: 'actorContactId',
          otherRegions: 'isolated-peer-contact',
        },
      ],
      requiredPositiveAndNegativeMemberships: true,
      keepOriginalFixturesUnmodified: true,
    },
    {
      kind: 'dedicated-access-projection-rows',
      prototype: 'G-P-STRESS-IT',
      principalBindings: ['grantee', 'it', 'hr', 'cto'],
      actorContactRef: 'actorContactId',
      relationships: ['pqvd_access_accounts', 'pqvd_access_referenceaccounts'],
      exclusiveToQualificationFixtureAccounts: true,
    },
  );
  if (permissions.some((permission) => permission.scope === 'Account'))
    fixtureRequirements.push({
      kind: 'temporary-contact-parent-account',
      contact: 'actorContactId',
      field: 'parentcustomerid',
      value: 'qualification-own-account',
      readbackAndRestoreRequired: true,
    });
  if (metadataRequirements.length)
    fixtureRequirements.push({
      kind: 'contact-many-to-many-positive-and-negative-edges',
      relationship: qualifiedContactNn,
      actorContactRef: 'actorContactId',
      rowRegions: ['own-scope', 'foreign-company'],
      immutablePortal: true,
    });
  const anonymous = roles.some((role) => role.anonymous);
  runtimeRequirements.push(
    {
      kind: 'isolated-role-assignment-lease',
      preserveRoles: ['TESTRUNNER', 'unrelated-source-roles'],
      removeBusinessRoleCodes: [
        'COMPANYMANAGER',
        'BRANCHMANAGER',
        'TEAMLEADER',
        'EMPLOYEE',
        'CONTRACTOR',
        'HR',
        'IT',
        'FACILITIES',
        'PROCUREMENT',
        'AUDITOR',
        'ORGADMIN',
        'CTO',
      ],
      restoreExactBeforeState: true,
      allSubsetsNeedActualNativeWitness: true,
    },
    {
      kind: 'actual-backend-context-and-query-capture',
      stages: ['10/10', '20/10', '20/9900', '40/9900'],
      requireFrozenMembershipsConfigurationDataAndTemplates: true,
      requireTwoStablePrincipalFootprints: true,
    },
    {
      kind: 'business-crud-context-observation',
      tables: [...new Set(permissions.map((permission) => permission.table))],
      requiredMessages: ['Create', 'Update', 'Delete', 'Associate', 'Disassociate'],
      currentGap:
        'The original context observer is registered only on crudprobe/chainnode. Business tables need bounded message/image registrations and immutable intent correlation before CRUD context parity can be qualified.',
    },
    {
      kind: 'retain-original-business-invariant-guards',
      currentGap:
        'Structural/lifecycle Create/Delete/bind changes are blocked by original BusinessProjectionGuard except disposable Stock equipment. A backend guard failure is distinct from a table-permission denial; grant masks cannot be credited as successful CRUD.',
    },
  );
  if (anonymous)
    runtimeRequirements.push({
      kind: 'anonymous-public-read-endpoint-and-observer-provenance',
      contract:
        'Trusted SDK-prepared anonymous intent; Context2 portal flag true, Contact empty, controller ownership separate from anonymous identity. No public recording-table grants.',
    });
  const permissionById = new Map(permissions.map((permission) => [permission.id, permission]));
  const components = [
    ...roles.map((role) => ({
      id: role.id,
      type: 11,
      name: role.name,
      state: role.active ? 0 : 1,
      content: {
        anonymoususersrole: role.anonymous,
        authenticatedusersrole: role.authenticated,
        description: `Bounded native qualification ${variant.id}; coordinator-owned reversible lease.`,
      },
    })),
    ...permissions.map((permission) => ({
      id: permission.id,
      type: 18,
      name: permission.name,
      state: permission.active ? 0 : 1,
      content: {
        entityname: permission.name,
        entitylogicalname: permission.table,
        scope: scopeValues[permission.scope],
        read: permission.privileges.read,
        create: permission.privileges.create,
        write: permission.privileges.write,
        delete: permission.privileges.delete,
        append: permission.privileges.append,
        appendto: permission.privileges.appendTo,
        adx_entitypermission_webrole: permission.roleIds,
        ...(permission.scope === 'Contact' ? { contactrelationship: permission.relationship } : {}),
        ...(permission.scope === 'Account' ? { accountrelationship: permission.relationship } : {}),
        ...(permission.parentId
          ? { parententitypermission: permission.parentId, parentrelationship: permission.relationship }
          : {}),
      },
    })),
  ];
  for (const permission of permissions)
    if (permission.parentId && !permissionById.has(permission.parentId))
      throw new Error('The materialized graph has an unresolved parent.');
  const caseId = `QF-${short}-R`;
  const escape = (value) =>
    String(value).replace(
      /[<>&"']/g,
      (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char],
    );
  const query = {
    id: caseId,
    name: `Qualification ${family.id} ${short}`,
    table: leaf.table,
    entitySet: table.entitySetName,
    primaryId: `${leaf.table}id`,
    primaryName,
    pageSize: 50,
    fields: fields.map((field) => ({ ...field, source: field.name, nullable: false })),
    variant: `qualification-${family.id}`,
    fixtureBindings: ['qualificationRecordIds', 'actorContactId'],
    fetchXml: `<fetch count="{{pageSize}}" page="{{page}}" returntotalrecordcount="true"><entity name="${leaf.table}">${fields.map((field) => `<attribute name="${field.name}"></attribute>`).join('')}<order attribute="${leaf.table}id"></order><filter type="and"><condition attribute="${leaf.table}id" operator="in">{{qualificationRecordIdValues}}</condition></filter><filter type="or"><condition attribute="${primaryName}" operator="null"></condition><filter type="and"><condition attribute="${primaryName}" operator="ne" value="{{markerUtc}}"></condition><condition attribute="${primaryName}" operator="ne" value="{{markerOperation}}"></condition></filter></filter></entity></fetch>`,
  };
  const bindingContract = {
    bindRecordIds(ids) {
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 500 ||
        ids.some((id) => !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
      )
        throw new Error('Qualification queries require one to 500 verified native fixture GUIDs.');
      return {
        ...query,
        fixtureBindings: [],
        fetchXml: query.fetchXml.replace(
          '{{qualificationRecordIdValues}}',
          ids.map((id) => `<value>${escape(id.toLowerCase())}</value>`).join(''),
        ),
      };
    },
  };
  const configurationCells = [];
  for (let mask = 0; mask < 2 ** roleCount; mask++) {
    for (const lane of ['liquid', 'webapi'])
      configurationCells.push({
        id: `${variant.id}:m${mask}:read:${lane}`,
        variantId: variant.id,
        roleMask: mask,
        operation: 'read',
        lane,
        regions: ['own-scope', 'same-company-other-branch', 'foreign-company'],
        wholeFixturePartition: true,
        nativeQualification: 'unrecorded',
      });
    for (const operation of privilegeNames.filter((right) => right !== 'read'))
      for (const region of ['own-scope', 'same-company-other-branch', 'foreign-company'])
        configurationCells.push({
          id: `${variant.id}:m${mask}:${operation}:${region}:webapi`,
          variantId: variant.id,
          roleMask: mask,
          operation,
          lane: 'webapi',
          region,
          nativeQualification: 'unrecorded',
          requiresDisposableCanary: true,
        });
  }
  return {
    schemaVersion: 1,
    kind: 'materialized-finite-configuration-requirement',
    variantId: variant.id,
    family: family.id,
    parameters,
    roles,
    permissions,
    components,
    query,
    bindingContract,
    metadataRequirements,
    fixtureRequirements,
    runtimeRequirements,
    configurationCells,
    roleMaskCount: 2 ** roleCount,
    requiredRegions: ['own-scope', 'same-company-other-branch', 'foreign-company'],
    nativeCellsPerRepeat: 2 ** roleCount * (2 + 5 * 3),
    minimumRepeatedReadCells: 2 ** roleCount * 2 * 2,
    sourceHashes: {
      schema: inputHashes.schema,
      catalogue: inputHashes.catalogue,
      components: digest(components),
      query: digest(query),
    },
    nativeWitnesses: {},
    missingNativeWitnesses: [...requiredNativeWitnesses],
    nativeQualifiedCells: 0,
    qualification: 'requires-materialization-and-native-evidence',
    nativeExecution: false,
  };
}

export function sealConfigurationWitnesses(configuration, { witnesses, boundQuery, boundOperation }) {
  if (
    !configuration?.configurationCells ||
    requiredNativeWitnesses.some((name) => !hashPattern.test(witnesses?.[name] ?? ''))
  )
    throw new Error('Seal the configuration with all five frozen native witness hashes.');
  if (
    !boundQuery ||
    boundQuery.id !== configuration.query.id ||
    boundQuery.table !== configuration.query.table ||
    boundQuery.fetchXml.includes('{{qualificationRecordIdValues}}') ||
    boundQuery.fixtureBindings?.length
  )
    throw new Error('A configuration proof needs its verified native fixture query binding.');
  const nativeWitnesses = Object.fromEntries(requiredNativeWitnesses.map((name) => [name, witnesses[name]]));
  if (
    boundOperation &&
    (!boundOperation.target ||
      !/^[a-z][a-z0-9_]*$/.test(boundOperation.target.table ?? '') ||
      !/^[a-f0-9-]{36}$/i.test(boundOperation.target.id ?? '') ||
      !['Create', 'Update', 'Delete', 'Associate', 'Disassociate'].includes(boundOperation.expectedMessage))
  )
    throw new Error('Seal only the actual metadata-bound mutation target and expected runtime message.');
  const inputHash = digest({
    variantId: configuration.variantId,
    sourceHashes: configuration.sourceHashes,
    nativeWitnesses,
    boundQuery: { id: boundQuery.id, table: boundQuery.table, fetchXml: boundQuery.fetchXml },
    ...(boundOperation ? { boundOperation } : {}),
  });
  return {
    ...configuration,
    query: boundQuery,
    nativeWitnesses,
    missingNativeWitnesses: [],
    inputHash,
    ...(boundOperation ? { boundOperation } : {}),
    qualification: 'sealed-inputs-await-native-comparison',
  };
}

export function summarizeConfigurationQualification(configurations, observations) {
  const cells = new Map(
    configurations.flatMap((configuration) => configuration.configurationCells).map((cell) => [cell.id, cell]),
  );
  if (
    cells.size !== configurations.reduce((count, configuration) => count + configuration.configurationCells.length, 0)
  )
    throw new Error('Materialized configuration domains overlap.');
  const seen = new Set(),
    counts = { equal: 0, different: 0, blocked: 0, unqualified: 0 };
  for (const observation of observations) {
    if (!cells.has(observation.id) || seen.has(observation.id))
      throw new Error('Unknown or duplicated configuration proof cell.');
    seen.add(observation.id);
    const evidence = observation.evidence ?? {};
    const configuration = configurations.find(
      (configuration) => configuration.variantId === cells.get(observation.id).variantId,
    );
    const required = [
      'nativeConfigurationVerified',
      'nativeMembershipsVerified',
      'nativeDataVerified',
      'nativeCacheQualified',
      'actorContextQualified',
      'completePages',
      'backendBytesCompared',
      'runtimeContextCompared',
      'outcomeCompared',
      'rowsCompared',
    ];
    if (cells.get(observation.id).operation !== 'read')
      required.push('permissionBoundaryDistinguishedFromBusinessGuard', 'cleanupVerified');
    const missing =
      required.some((name) => evidence[name] !== true) ||
      configuration.missingNativeWitnesses.length > 0 ||
      !configuration.inputHash ||
      observation.inputHash !== configuration.inputHash;
    const verdict = observation.verdict === 'equal' && missing ? 'unqualified' : observation.verdict;
    if (!Object.hasOwn(counts, verdict)) throw new Error('Unknown configuration proof verdict.');
    counts[verdict]++;
  }
  return {
    denominator: cells.size,
    observed: seen.size,
    missing: cells.size - seen.size,
    ...counts,
    complete: counts.equal === cells.size,
    coveragePercent: (counts.equal * 100) / cells.size,
    qualification: counts.equal === cells.size ? 'bounded-materialized-configuration-domain-only' : 'incomplete',
    universalPermissionParity: false,
  };
}
