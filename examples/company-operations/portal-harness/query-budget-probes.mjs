import { createHash } from 'node:crypto';
import { parseXmlDocument } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';
import { authoredQuery, odataRequest, stable } from './core.mjs';
import { odataAdmissionCohorts } from '../portal-security/odata-admission-cohorts.mjs';
import { componentId } from '../portal-security/blueprint.mjs';

const identifier = /^[a-z][a-z0-9_]*$/i;
const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : stable(value))
    .digest('hex');
const quantifiers = ['any', 'not any', 'all', 'not all'];
const ordinaryTypes = ['inner', 'outer'];

/** Count structural features, not the platform's undocumented budget. An `any`
 * root and its ordinary descendants are counted separately. This cannot prove
 * that a platform version exempts a particular category from its join limit. */
export function queryLinkFeatures(xml) {
  const root = parseXmlDocument(xml, { root: 'fetch' });
  const types = {},
    ancestors = [],
    features = {
      total: 0,
      ordinary: 0,
      quantifier: 0,
      other: 0,
      nestedQuantifiers: 0,
      ordinaryUnderQuantifier: 0,
      maximumLinkDepth: 0,
    };
  function walk(node) {
    const isLink = node.name === 'link-entity',
      type = node.attrs?.['link-type'] ?? 'inner';
    if (isLink) {
      types[type] = (types[type] ?? 0) + 1;
      features.total++;
      if (ordinaryTypes.includes(type)) {
        features.ordinary++;
        if (ancestors.some((value) => quantifiers.includes(value))) features.ordinaryUnderQuantifier++;
      } else if (quantifiers.includes(type)) {
        features.quantifier++;
        if (ancestors.some((value) => quantifiers.includes(value))) features.nestedQuantifiers++;
      } else features.other++;
      ancestors.push(type);
      features.maximumLinkDepth = Math.max(features.maximumLinkDepth, ancestors.length);
    }
    for (const child of node.children ?? []) walk(child);
    if (isLink) ancestors.pop();
  }
  walk(root);
  return { ...features, types };
}

function validateRoot(base) {
  if (![base.table, base.entitySet, base.primaryId, base.primaryName].every((value) => identifier.test(value ?? '')))
    throw new Error('Bind actual source root logical names, primary ID/name and entity set.');
  if (!base.fixtureIds?.length || base.fixtureIds.some((value) => !guid.test(value)))
    throw new Error('Bind nonempty native fixture GUIDs; a successful empty query is not a budget witness.');
  if (new Set(base.fixtureIds.map((value) => value.toLowerCase())).size !== base.fixtureIds.length)
    throw new Error('The bound native fixture partition must contain unique GUIDs.');
  if (base.fixtureIds.length > 20)
    throw new Error('The admission control fixture partition is bounded to twenty rows.');
}

function queryRoot(base, children, padding = '') {
  return (
    `<fetch count="{{pageSize}}" page="{{page}}"><entity name="${base.table}">${padding}` +
    `<attribute name="${base.primaryId}"/><order attribute="${base.primaryId}"/>` +
    `<filter type="and"><condition attribute="${base.primaryId}" operator="in">` +
    base.fixtureIds.map((id) => `<value>${id.toLowerCase()}</value>`).join('') +
    '</condition>' +
    `<filter type="or"><condition attribute="${base.primaryName}" operator="null"/><filter type="and">` +
    `<condition attribute="${base.primaryName}" operator="ne" value="{{markerUtc}}"/>` +
    `<condition attribute="${base.primaryName}" operator="ne" value="{{markerOperation}}"/>` +
    `</filter></filter></filter>${children}</entity></fetch>`
  );
}

function ordinary(base, alias, children = '') {
  // Equality of the actual primary key gives exactly one related row per fixture
  // and avoids inventing relationship metadata or changing native fixture data.
  return `<link-entity name="${base.table}" from="${base.primaryId}" to="${base.primaryId}" alias="${alias}" link-type="outer">${children}</link-entity>`;
}

function quantified(base, alias, type, children = '', nested = '') {
  // Each single quantifier is true for every bound self-PK row. FetchXML `all`
  // requires a related row but excludes rows matching its filter; `not all`
  // has the same semantics as `any`. Independent native controls must verify
  // this semantic expectation before their limit outcomes receive credit.
  const operator = ['not any', 'all'].includes(type) ? 'null' : 'not-null';
  return (
    `<filter type="and"><link-entity name="${base.table}" from="${base.primaryId}" to="${base.primaryId}" alias="${alias}" link-type="${type}">` +
    `<filter type="and"><condition attribute="${base.primaryId}" operator="${operator}"/>${nested}</filter>${children}</link-entity></filter>`
  );
}

function probe(base, id, xml, family, dimensions) {
  return {
    ...base,
    id: 'QF-BUDGET-' + id,
    baseCaseId: base.id,
    fetchXml: xml,
    queryType: 'fetchxml',
    variant: family,
    fields: [{ name: base.primaryId, source: base.primaryId, type: 'guid', nullable: false }],
    pageSize: 10,
    dimensions,
    authoredFeatures: queryLinkFeatures(xml),
    authoredTemplateHash: hash(xml),
    fixtureSemantics: 'self-primary-key-matches-bound-root',
    expectedFixtureIds: [...base.fixtureIds],
    expectedNativeOutcome: 'requires-independent-native-evidence',
    nativeQualified: false,
  };
}

/** A separate finite discriminator domain. It is never added to, substituted
 * for, or credited towards the existing role lattice by materialization. */
export function compileQueryBudgetProbes({ basePlan, scopedRoleMask }) {
  validateRoot(basePlan);
  basePlan = { ...basePlan, fixtureIds: basePlan.fixtureIds.map((value) => value.toLowerCase()) };
  if (!Number.isSafeInteger(scopedRoleMask) || scopedRoleMask < 1 || scopedRoleMask > 4095)
    throw new Error('Bind the actual nonzero twelve-role source mask for the scoped controls.');
  const controls = [];
  for (const type of quantifiers) {
    const label = type.replaceAll(' ', '-');
    const dimensions = [
      { shape: 'single-positive-control', quantifierRoots: 1, ordinarySiblings: 0, ordinaryDescendants: 0 },
      { shape: 'quantifier-siblings-total-16', quantifierRoots: 16, ordinarySiblings: 0, ordinaryDescendants: 0 },
      { shape: 'ordinary-siblings-15', quantifierRoots: 1, ordinarySiblings: 15, ordinaryDescendants: 0 },
      { shape: 'ordinary-siblings-16', quantifierRoots: 1, ordinarySiblings: 16, ordinaryDescendants: 0 },
      { shape: 'ordinary-descendants-15', quantifierRoots: 1, ordinarySiblings: 0, ordinaryDescendants: 15 },
      { shape: 'ordinary-descendants-16', quantifierRoots: 1, ordinarySiblings: 0, ordinaryDescendants: 16 },
      {
        shape: 'nested-quantifiers-total-16',
        quantifierRoots: 2,
        ordinarySiblings: 14,
        ordinaryDescendants: 0,
        nested: true,
      },
    ];
    for (const dimension of dimensions) {
      const descendants = Array.from({ length: dimension.ordinaryDescendants }, (_, n) =>
        ordinary(basePlan, 'd' + n),
      ).join('');
      const siblings = Array.from({ length: dimension.ordinarySiblings }, (_, n) => ordinary(basePlan, 's' + n)).join(
        '',
      );
      // A nested `any` matches the self-PK row. It never flips the outer filter's
      // null/not-null truth, so the outer all/not-any controls remain meaningful.
      const nested = dimension.nested ? quantified(basePlan, 'n0', 'any') : '';
      const filters = Array.from({ length: dimension.nested ? 1 : dimension.quantifierRoots }, (_, n) =>
        quantified(basePlan, 'q' + n, type, descendants, nested),
      ).join('');
      controls.push(
        probe(basePlan, label + '-' + dimension.shape, queryRoot(basePlan, filters + siblings), 'quantifier-budget', {
          ...dimension,
          quantifierType: type,
        }),
      );
    }
  }
  for (const ordinarySiblings of [0, 15, 16])
    controls.push(
      probe(
        basePlan,
        'ordinary-' + ordinarySiblings,
        queryRoot(basePlan, Array.from({ length: ordinarySiblings }, (_, n) => ordinary(basePlan, 'o' + n)).join('')),
        'ordinary-budget',
        { ordinarySiblings },
      ),
    );
  const transport = [];
  for (const ordinarySiblings of [0, 3, 11, 12, 15, 16])
    for (const paddingCharacters of [0, 128, 1024, 3072])
      for (const encoding of ['percent-space', 'form-space']) {
        const xml = queryRoot(
          basePlan,
          Array.from({ length: ordinarySiblings }, (_, n) => ordinary(basePlan, 't' + n)).join(''),
          ' '.repeat(paddingCharacters),
        );
        transport.push(
          probe(basePlan, `transport-j${ordinarySiblings}-p${paddingCharacters}-${encoding}`, xml, 'query-transport', {
            ordinarySiblings,
            paddingCharacters,
            encoding,
            preservesParsedQuery: true,
          }),
        );
      }
  const profiles = [
    {
      id: 'isolated-root-global',
      graphRequirement:
        'One active root Global Read grant plus recording ownership grants; no other matching business grants.',
      roleBinding: 'leased-global-control-role',
      rootTable: basePlan.table,
    },
    {
      id: 'frozen-scoped-source',
      graphRequirement: 'Unmodified frozen source graph and membership; captures include generated permissions.',
      roleMask: scopedRoleMask,
      rootTable: basePlan.table,
    },
  ];
  const cells = controls.flatMap((plan) =>
    profiles.flatMap((profile) =>
      ['liquid', 'webapi'].map((lane) => ({
        id: `${profile.id}:${plan.id}:${lane}`,
        profile: profile.id,
        caseId: plan.id,
        lane,
        repeatsRequired: 2,
        nativeQualification: 'unrecorded',
        expectedNativeOutcome: 'requires-independent-native-evidence',
      })),
    ),
  );
  cells.push(
    ...transport.map((plan) => ({
      id: `frozen-scoped-source:${plan.id}:webapi`,
      profile: 'frozen-scoped-source',
      caseId: plan.id,
      lane: 'webapi',
      repeatsRequired: 2,
      nativeQualification: 'unrecorded',
      expectedNativeOutcome: 'requires-independent-native-evidence',
    })),
  );
  if (controls.length !== 31 || transport.length !== 48 || cells.length !== 172)
    throw new Error('Declare a new denominator before changing the 172-cell budget/transport discriminator domain.');
  return {
    kind: 'native-query-budget-discriminators-v1',
    plans: [...controls, ...transport],
    profiles,
    cells,
    denominator: 172,
    physicalRepeatedCellsRequired: 344,
    nativeQualifiedCells: 0,
    originalDenominatorsPreserved: true,
    universalPermissionParity: false,
    requiredWitnesses: [
      'frozen-raw-schema-and-graph',
      'exact-before-and-after-memberships',
      'site-source-and-settings-hash',
      'platform-limit-observation',
      'observer-registration-hash',
      'both-cache-clear-receipts',
      'nonempty-positive-fixture-read-control-per-root-lane-profile',
      'exact-authored-request-and-HTTP-response',
      'original-query-artifacts-all-active-stages-or-qualified-no-backend-receipt',
      'two-independent-unchanged-source-repeats',
    ],
    sourcePlanHash: hash({ controls, transport, profiles, cells }),
  };
}

/** Executable input for the existing reversible qualification lease. It is a
 * separate graph, not an added Global grant on the active role campaign. */
export function materializeBudgetGlobalControl({ schema, catalogue, basePlan }) {
  validateRoot(basePlan);
  const table = schema.tables.find((table) => table.name === basePlan.table);
  if (
    !table ||
    table.entitySetName !== basePlan.entitySet ||
    basePlan.primaryId !== table.name + 'id' ||
    (table.primaryName?.name ?? { account: 'name', contact: 'fullname' }[table.name]) !== basePlan.primaryName
  )
    throw new Error('The isolated budget root must match source logical metadata.');
  const original = odataAdmissionCohorts({ schema, catalogue }).configurations.find(
    (configuration) => configuration.discriminator === 'direct-global',
  );
  const { bindingContract: ignoredBinding, ...data } = original,
    configuration = structuredClone(data);
  const permission = configuration.permissions[0],
    previousId = permission.id;
  permission.id = componentId('query-budget-global:' + table.name);
  permission.table = table.name;
  permission.name = 'Query budget isolated Global Read';
  permission.privileges = 1;
  permission.path = 'isolated-budget-global';
  const component = configuration.components.find((component) => component.id === previousId);
  component.id = permission.id;
  component.name = permission.name;
  Object.assign(component.content, {
    entityname: permission.name,
    entitylogicalname: table.name,
    read: true,
    create: false,
    write: false,
    delete: false,
    append: false,
    appendto: false,
  });
  configuration.variantId = 'query-budget:isolated-root-global';
  configuration.family = 'query-budget-admission';
  configuration.discriminator = 'isolated-root-global';
  configuration.parameters = { scope: 'Global', root: table.name, readOnly: true };
  configuration.query = probe(basePlan, 'global-positive-control', queryRoot(basePlan, ''), 'ordinary-budget', {
    ordinarySiblings: 0,
  });
  configuration.fixtureRequirements = [
    {
      kind: 'existing-frozen-native-positive-control',
      table: table.name,
      ids: [...basePlan.fixtureIds],
      sdkPreparedAndPortalReadBack: true,
      fixtureMutation: false,
    },
  ];
  configuration.runtimeRequirements = configuration.runtimeRequirements.filter(
    (requirement) => requirement.kind !== 'business-crud-context-observation',
  );
  configuration.configurationCells = [];
  configuration.nativeCellsPerRepeat = 0;
  configuration.minimumRepeatedReadCells = 0;
  configuration.sourceHashes = {
    ...configuration.sourceHashes,
    components: hash(configuration.components),
    query: hash(configuration.query),
    budgetGraph: hash(configuration.permissions),
  };
  configuration.nativeQualifiedCells = 0;
  configuration.nativeExecution = false;
  return configuration;
}

export function budgetProbeRequest(plan, operation) {
  const xml = authoredQuery(plan, operation),
    encoded =
      plan.dimensions?.encoding === 'form-space'
        ? new URLSearchParams({ fetchXml: xml }).toString()
        : 'fetchXml=' + encodeURIComponent(xml);
  const url = `/_api/${plan.entitySet}?${encoded}`;
  return { method: 'GET', url, authoredFetchXml: xml, metrics: queryTransportMetrics({ url, authoredXml: xml }) };
}

/** Eight additional scalar transport controls on an independently observed
 * positive OData root. Whitespace changes only the wire length/encoding and
 * preserves the decoded filter. These do not replace any authored OData case. */
export function compileScalarTransportControls({ positivePlan }) {
  validateRoot(positivePlan);
  if (positivePlan.authoringQualification !== 'schema-valid-bounded-request')
    throw new Error('Use the separate source-metadata-bound OData selection.');
  const plans = [0, 128, 1024, 3072].flatMap((paddingCharacters) =>
    ['percent-space', 'form-space'].map((encoding) => ({
      ...positivePlan,
      id: `QF-SCALAR-TRANSPORT-p${paddingCharacters}-${encoding}`,
      baseCaseId: positivePlan.id,
      variant: 'scalar-query-transport',
      dimensions: { paddingCharacters, encoding, preservesParsedFilter: true },
      expectedNativeOutcome: 'requires-independent-native-evidence',
      nativeQualified: false,
    })),
  );
  return {
    kind: 'native-scalar-transport-discriminators-v1',
    plans,
    denominator: 8,
    physicalRepeatedCellsRequired: 16,
    nativeQualifiedCells: 0,
    originalDenominatorsPreserved: true,
    budgetDomainPreserved: true,
    sourcePlanHash: hash(plans),
    universalPermissionParity: false,
  };
}

export function scalarTransportRequest(plan, operation) {
  const original = new URL(odataRequest(plan, operation), 'https://probe.invalid');
  const filter = original.searchParams.get('$filter') + ' '.repeat(plan.dimensions.paddingCharacters);
  original.searchParams.set('$filter', filter);
  original.searchParams.set('$top', '10');
  const query =
    plan.dimensions.encoding === 'form-space'
      ? original.searchParams.toString()
      : [...original.searchParams].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&');
  const url = original.pathname + '?' + query;
  return {
    method: 'GET',
    url,
    authoredFilter: filter,
    metrics: {
      requestCharacters: url.length,
      requestUtf8Bytes: Buffer.byteLength(url),
      authoredFilterCharacters: filter.length,
      authoredFilterUtf8Bytes: Buffer.byteLength(filter),
      decodedFilterHash: hash(filter.trimEnd()),
    },
  };
}

/** Native expanded XML is only known when the recorded incoming query exists.
 * Possible downstream URI sizes remain diagnostic estimates, never a simulated
 * request or an asserted native threshold. */
export function queryTransportMetrics({ url, authoredXml, receivedXml }) {
  const metrics = {
    requestCharacters: url.length,
    requestUtf8Bytes: Buffer.byteLength(url),
    authoredXmlCharacters: authoredXml.length,
    authoredXmlUtf8Bytes: Buffer.byteLength(authoredXml),
    authoredPercentEncodedCharacters: encodeURIComponent(authoredXml).length,
    authoredDoublePercentEncodedCharacters: encodeURIComponent(encodeURIComponent(authoredXml)).length,
  };
  if (receivedXml !== undefined)
    Object.assign(metrics, {
      receivedXmlCharacters: receivedXml.length,
      receivedXmlUtf8Bytes: Buffer.byteLength(receivedXml),
      receivedPercentEncodedCharacters: encodeURIComponent(receivedXml).length,
      receivedDoublePercentEncodedCharacters: encodeURIComponent(encodeURIComponent(receivedXml)).length,
      receivedLinkFeatures: queryLinkFeatures(receivedXml),
    });
  return metrics;
}

export function assertBudgetProbeSourceBinding(binding) {
  const fields = [
    'schema',
    'permissionGraph',
    'memberships',
    'actorFields',
    'fixtures',
    'siteSource',
    'settings',
    'registrations',
  ];
  if (
    fields.some(
      (field) =>
        !/^[a-f0-9]{64}$/.test(binding?.before?.[field] ?? '') || binding.before[field] !== binding?.after?.[field],
    )
  )
    throw new Error(
      'Budget probes require unchanged independent before/after source, actor, fixture and registry hashes.',
    );
  const positive = binding.positiveControl;
  if (
    !/^[a-f0-9]{64}$/.test(binding.bothCacheClearReceipt ?? '') ||
    !Number.isSafeInteger(positive?.fixtureCount) ||
    positive.fixtureCount < 1 ||
    !Number.isSafeInteger(positive?.actualQueryArtifacts) ||
    positive.actualQueryArtifacts < 1
  )
    throw new Error('Cache receipts and an actual nonempty native SDK positive control are required.');
  if (!binding.actualOperationId || !guid.test(binding.actualOperationId) || binding.nativeReplay !== true)
    throw new Error(
      'Actual native operation binding is required; enumeration and local execution cannot qualify native controls.',
    );
  return hash(binding);
}
