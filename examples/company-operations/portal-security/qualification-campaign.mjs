import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  scopeHierarchyVariantCases,
  materializeScopeHierarchyVariant,
  sealConfigurationWitnesses,
  requiredNativeWitnesses,
  variantInputHashes,
} from './qualification-domain.mjs';
import { highRiskNativeConfigurations, equipmentLifecycleConfigurations } from './qualification-priority.mjs';
import { planQualificationFixtures } from './qualification-fixtures.mjs';
import { planQualificationLease, withQualificationLease, restoreQualificationLease } from './qualification-lease.mjs';
import { stable } from '../portal-harness/core.mjs';
import { normalizeQuerySentinels } from '../portal-harness/parity.mjs';
import {
  compareRecordedContexts,
  compareRecordedPluginArtifacts,
  recordedPluginPayloads,
} from '../plugins/mirage-runtime.mjs';
import { savePrivateJson } from '../portal-harness/private-journal.mjs';

const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : stable(value))
    .digest('hex');
const sha = /^[a-f0-9]{64}$/;
const roles = (value) => [...new Set(value ?? [])].sort();
const permissionCodes = new Set(['90040120', '90040102', '90040103', '90040104', '90040105', '90040106']);

/** Recompute a genuinely empty root candidate set from the complete raw native
 * graph, including inherited roles and automatic roles. Unresolved parents are
 * rejected rather than treated as evidence of no grant. */
export function validateLiquidNoReadReceipt(configuration, native, local) {
  const source = prepareNoReadSource(configuration, native);
  if (!source) return { verified: false, gaps: ['missing-no-read-source-receipt'] };
  const { receipt, cleaned, gaps } = source;
  const parsed = noReadComponentMaps(cleaned);
  if (!parsed) {
    return { verified: false, gaps: ['invalid-no-read-raw-components'] };
  }
  const { permissions, roleRows } = parsed;
  const actorRoles = new Set((receipt.actorRoleIds ?? []).filter((role) => roleRows.has(role)));
  const anonymous = receipt.portalContactId === '00000000-0000-0000-0000-000000000000';
  validateNoReadActor(configuration, native, receipt, roleRows, actorRoles, anonymous, gaps);
  const candidates = noReadCandidates(permissions, actorRoles, receipt.table, gaps);
  if (candidates.length || receipt.rootCandidateIds?.length !== 0) gaps.push('no-read-root-candidates-not-empty');
  validateNoReadEvidence(receipt, native, local, gaps);
  return {
    verified: gaps.length === 0,
    gaps: [...new Set(gaps)],
    rootCandidateIds: candidates.map((permission) => permission.powerpagecomponentid),
  };
}

function prepareNoReadSource(configuration, native) {
  const receipt = native?.noReadReceipt;
  if (
    !receipt ||
    receipt.table !== configuration.query.table ||
    !Array.isArray(receipt.components) ||
    !receipt.components.length
  )
    return null;
  const cleaned = receipt.components
    .map((component) => Object.fromEntries(Object.entries(component).filter(([name]) => !name.startsWith('@'))))
    .sort((a, b) => a.powerpagecomponentid.localeCompare(b.powerpagecomponentid));
  const gaps = [];
  if (
    receipt.rawConfigSha256 !== hash(cleaned) ||
    receipt.schemaSha256 !== configuration.sourceHashes?.schema ||
    !sha.test(receipt.membershipSnapshotSha256 ?? '') ||
    receipt.membershipSnapshotSha256 !== receipt.afterMembershipSnapshotSha256 ||
    receipt.rawConfigSha256 !== receipt.afterRawConfigSha256
  )
    gaps.push('no-read-source-freeze');
  return { receipt, cleaned, gaps };
}

function validateNoReadEvidence(receipt, native, local, gaps) {
  validateNoReadNativeFlags(receipt, gaps);
  validateNoReadFixture(receipt, gaps);
  validateNoReadPositiveControl(receipt, gaps);
  if (hasNoReadPathEvents(native, local)) gaps.push('no-read-actual-empty-path');
}

function validateNoReadFixture(receipt, gaps) {
  const fixture = receipt.ownedFixture;
  if (
    !fixture?.primaryId ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(fixture.nativeRow?.[fixture.primaryId] ?? '') ||
    fixture.nativeRow[fixture.primaryId] !== fixture.localRow?.[fixture.primaryId] ||
    fixture.nativeRowSha256 !== hash(fixture.nativeRow) ||
    fixture.localRowSha256 !== hash(fixture.localRow)
  )
    gaps.push('no-read-owned-fixture');
}

function validateNoReadPositiveControl(receipt, gaps) {
  const control = receipt.positiveControl;
  if (
    control?.table !== receipt.table ||
    control?.fullActiveRetrieveMultipleObserverProfile !== true ||
    !sha.test(control?.artifactSha256 ?? '') ||
    !sha.test(control?.observerProfileSha256 ?? '') ||
    !Array.isArray(control?.observedStages) ||
    ![10, 20, 40].every((stage) => control.observedStages.includes(stage))
  )
    gaps.push('no-read-root-observer-positive-control');
}

function hasNoReadPathEvents(native, local) {
  return (
    native.backendEvents?.length ||
    local?.backendEvents?.length ||
    native.pages?.some((page) => page.wire?.status !== 200 || page.rows?.length !== 0) ||
    local?.pages?.some((page) => page.wire?.status !== 200 || page.rows?.length !== 0)
  );
}

function noReadComponentMaps(cleaned) {
  const permissions = new Map();
  const roleRows = new Map();
  try {
    for (const component of cleaned) {
      const value = { ...component, parsed: JSON.parse(component.content) };
      if (component.powerpagecomponenttype === 18) permissions.set(component.powerpagecomponentid, value);
      if (component.powerpagecomponenttype === 11 && component.statecode === 0)
        roleRows.set(component.powerpagecomponentid, value);
    }
  } catch {
    return null;
  }
  return { permissions, roleRows };
}

function validateNoReadActor(configuration, native, receipt, roleRows, actorRoles, anonymous, gaps) {
  if (
    anonymous
      ? (receipt.actorRoleIds ?? []).length !== 0
      : stable(roles(receipt.actorRoleIds)) !== stable(roles(native.membershipRoleIds))
  )
    gaps.push('no-read-actual-actor-roles');
  const expectedActorId = configuration.roles.some((role) => role.anonymous)
    ? '00000000-0000-0000-0000-000000000000'
    : native.controllerContactId;
  if (receipt.portalContactId !== expectedActorId) gaps.push('no-read-actual-actor');
  for (const [roleId, role] of roleRows)
    if (anonymous ? role.parsed.anonymoususersrole : role.parsed.authenticatedusersrole) actorRoles.add(roleId);
}

function noReadEffectiveRoles(permission, permissions, visited = new Set()) {
  if (visited.has(permission.powerpagecomponentid)) throw new Error('cycle');
  const seen = new Set([...visited, permission.powerpagecomponentid]);
  const parentId = permission.parsed.parententitypermission;
  const parent = parentId ? permissions.get(parentId) : null;
  if (parentId && parent?.statecode !== 0) throw new Error('unresolved-parent');
  return [
    ...(permission.parsed.adx_entitypermission_webrole ?? []),
    ...(parent ? noReadEffectiveRoles(parent, permissions, seen) : []),
  ];
}

function noReadCandidates(permissions, actorRoles, table, gaps) {
  try {
    return [...permissions.values()]
      .filter(
        (permission) =>
          permission.statecode === 0 &&
          permission.parsed.read === true &&
          permission.parsed.entitylogicalname === table,
      )
      .filter((permission) => noReadEffectiveRoles(permission, permissions).some((role) => actorRoles.has(role)));
  } catch {
    gaps.push('no-read-unresolved-parent-hypothesis');
    return [];
  }
}

function validateNoReadNativeFlags(receipt, gaps) {
  for (const side of ['before', 'after']) {
    const flags = receipt.nativeFlags?.[side];
    if (
      flags?.permission_granted !== false ||
      flags?.global_permission_granted !== false ||
      flags?.rules_exist !== true
    )
      gaps.push('no-read-native-flags');
  }
}

export function configurationCampaignDomain({ schema, catalogue }) {
  // Hash the shared schema and catalogue once, not once per each of the 2117 variants.
  const inputHashes = variantInputHashes({ schema, catalogue });
  const main = [...scopeHierarchyVariantCases()].map((variant) =>
    materializeScopeHierarchyVariant(variant, { schema, catalogue, inputHashes }),
  );
  const roleless = highRiskNativeConfigurations({ schema, catalogue }).configurations.filter(
    (configuration) => configuration.family === 'parent-roleless',
  );
  const equipment = equipmentLifecycleConfigurations({ schema, catalogue }).configurations;
  const configurations = [...main, ...roleless, ...equipment];
  if (
    main.length !== 2117 ||
    roleless.length !== 6 ||
    equipment.length !== 128 ||
    new Set(configurations.map((configuration) => configuration.variantId)).size !== configurations.length
  )
    throw new Error('Configuration campaign bounds or identities changed; declare a new domain.');
  const definitions = configurations.map((configuration) => ({
    variantId: configuration.variantId,
    sourceHashes: configuration.sourceHashes,
    cells: configuration.configurationCells,
  }));
  return {
    kind: 'bounded-native-configuration-campaign',
    configurations,
    domainHash: hash(definitions),
    configurationsRequired: configurations.length,
    originalGrammarConfigurations: main.length,
    rolelessAncestorConfigurations: roleless.length,
    equipmentLifecycleConfigurations: equipment.length,
    denominator: configurations.reduce((count, configuration) => count + configuration.configurationCells.length, 0),
    nativeQualifiedCells: 0,
    universalPermissionParity: false,
  };
}

/** The adapter supplies original native envelopes, not verdict booleans.
 * Immutable files are checked by the driver; this comparator independently
 * binds actor, memberships, frozen inputs, backend bytes, HTTP and contexts. */
export function compareConfigurationCell(configuration, cell, native, local, { desiredRoleIds, actorContactId } = {}) {
  const gaps = [],
    differences = [];
  const portalActorId = configuration.roles.some((role) => role.anonymous)
    ? '00000000-0000-0000-0000-000000000000'
    : actorContactId;
  validateCellBindings(configuration, cell, native, local, desiredRoleIds, actorContactId, gaps);
  const pages = compareCellPages(cell, native, local, differences, gaps);
  const { nativePayloads, localPayloads } = collectCellPayloads(native, local, gaps);
  validateNativePayloadHistory(native, nativePayloads, gaps);
  compareCellQueries(nativePayloads, localPayloads, differences);
  const { leftContexts, rootPortalContexts } = compareCellContexts(
    configuration,
    nativePayloads,
    localPayloads,
    portalActorId,
    gaps,
    differences,
  );
  const permissionDenied = validateCellOutcome(configuration, cell, native, local, pages, nativePayloads, gaps);
  if (!leftContexts.length && !permissionDenied) gaps.push('missing-runtime-actor-context');
  if (leftContexts.length && !rootPortalContexts) gaps.push('missing-root-portal-context');
  if (
    !leftContexts.length &&
    (!native?.identityReceipt?.serverVerified || native.identityReceipt.contactId !== portalActorId)
  )
    gaps.push('denied-request-server-identity');
  if (cell.operation === 'read' && !cellQueryShape(nativePayloads).length && !permissionDenied)
    gaps.push('missing-retrieve-query');
  validateMutationComparison(configuration, cell, native, local, permissionDenied, leftContexts, gaps);
  return {
    id: cell.id,
    inputHash: configuration.inputHash,
    verdict: cellVerdict(gaps, differences),
    gaps: [...new Set(gaps)],
    differences: [...new Set(differences)],
    evidence: cellEvidence(gaps, cell),
    qualification: 'one-source-bound-cell-only',
    universalPermissionParity: false,
  };
}

function cellVerdict(gaps, differences) {
  if (gaps.length) return 'unqualified';
  if (differences.length) return 'different';
  return 'equal';
}

function cellEvidence(gaps, cell) {
  return {
    nativeConfigurationVerified: !gaps.some((gap) => gap.startsWith('native-witness:')),
    nativeMembershipsVerified: !gaps.includes('role-subset-binding'),
    nativeDataVerified: !gaps.includes('native-before-after-freeze'),
    nativeCacheQualified: !gaps.includes('dual-cache-controls'),
    actorContextQualified: !gaps.some((gap) => gap.includes('actor') || gap.includes('identity')),
    completePages: !gaps.includes('incomplete-pages'),
    backendBytesCompared: !gaps.includes('plugin-parts-integrity') && !gaps.includes('missing-retrieve-query'),
    runtimeContextCompared: !gaps.includes('missing-runtime-actor-context'),
    outcomeCompared: true,
    rowsCompared: true,
    permissionBoundaryDistinguishedFromBusinessGuard: !gaps.includes('permission-versus-business-guard-boundary'),
    cleanupVerified: cell.operation === 'read' || !gaps.includes('mutation-cleanup-readback'),
  };
}

function validateCellBindings(configuration, cell, native, local, desiredRoleIds, actorContactId, gaps) {
  validateEnvelopeBindings(configuration, cell, native, local, desiredRoleIds, actorContactId, gaps);
  validateNativeWitnesses(configuration, native, gaps);
  validateCellReceipts(cell, native, local, gaps);
}

function validateEnvelopeBindings(configuration, cell, native, local, desiredRoleIds, actorContactId, gaps) {
  for (const envelope of [native, local]) {
    if (envelope?.cellId !== cell.id || envelope.inputHash !== configuration.inputHash)
      gaps.push('cell-or-sealed-source-binding');
    if (stable(roles(envelope?.membershipRoleIds)) !== stable(roles(desiredRoleIds))) gaps.push('role-subset-binding');
    if (envelope?.controllerContactId !== actorContactId) gaps.push('controller-actor-binding');
  }
}

function validateNativeWitnesses(configuration, native, gaps) {
  for (const name of requiredNativeWitnesses)
    if (
      !sha.test(configuration.nativeWitnesses?.[name] ?? '') ||
      native?.nativeWitnesses?.[name] !== configuration.nativeWitnesses[name]
    )
      gaps.push('native-witness:' + name);
}

function validateCellReceipts(cell, native, local, gaps) {
  validateCacheControls(native, gaps);
  validateSnapshotStability(cell, native, gaps);
  validatePageReceipts(native, local, gaps);
}

function validateCacheControls(native, gaps) {
  if (
    !native?.cacheActions?.some((action) => action.name === 'clearConfig' && action.status === 'completed') ||
    !native?.cacheActions?.some((action) => action.name === 'clearCache' && action.status === 'completed')
  )
    gaps.push('dual-cache-controls');
}

function validateSnapshotStability(cell, native, gaps) {
  if (
    !native?.snapshotReceipt?.sourceStable ||
    !native?.snapshotReceipt?.registrationStable ||
    !native?.snapshotReceipt?.settingsStable ||
    !native?.snapshotReceipt?.membershipsStable ||
    !native?.snapshotReceipt?.allRegionsVerified
  )
    gaps.push('native-before-after-freeze');
  if (
    (cell.operation === 'read' && !native?.snapshotReceipt?.dataStable) ||
    (cell.operation !== 'read' && !native?.snapshotReceipt?.onlyDeclaredTargetChanges)
  )
    gaps.push('native-data-change-boundary');
  if (!native?.history?.operationId || !sha.test(native.history.summarySha256 ?? ''))
    gaps.push('immutable-native-history');
}

function validatePageReceipts(native, local, gaps) {
  if (!native?.completePages || !local?.completePages) gaps.push('incomplete-pages');
  if (!Array.isArray(native?.pages) || !native.pages.length || native.pages.length !== local?.pages?.length)
    gaps.push('physical-page-sequence');
}

function compareCellPages(cell, native, local, differences, gaps) {
  const pages = native?.pages ?? [];
  for (let index = 0; index < pages.length; index++) {
    const left = pages[index],
      right = local?.pages?.[index];
    compareCellPage(cell, left, right, index, differences, gaps);
  }
  return pages;
}

function compareCellPage(cell, left, right, index, differences, gaps) {
  if (!right) return;
  if (left.page !== right.page || left.fragment !== right.fragment) gaps.push('physical-page-binding');
  if (stable(left.wire) !== stable(right.wire)) differences.push('http-wire:' + index);
  if (stable(left.rows) !== stable(right.rows)) differences.push('rows:' + index);
  if (
    cell.lane === 'liquid' &&
    normalizeQuerySentinels(left.effectiveXml ?? '') !== normalizeQuerySentinels(right.effectiveXml ?? '')
  )
    differences.push('liquid-effective-xml:' + index);
}

function collectCellPayloads(native, local, gaps) {
  let nativePayloads = [],
    localPayloads = [];
  try {
    nativePayloads = recordedPluginPayloads(native?.backendEvents ?? []);
    localPayloads = recordedPluginPayloads(local?.backendEvents ?? []);
  } catch {
    gaps.push('plugin-parts-integrity');
  }
  return { nativePayloads, localPayloads };
}

function validateNativePayloadHistory(native, nativePayloads, gaps) {
  if (nativePayloads.some((payload) => payload.operationId !== native?.history?.operationId))
    gaps.push('native-operation-history-binding');
}

function cellQueryShape(payloads) {
  return payloads
    .filter((payload) => payload.content?.query?.xml)
    .map((payload) => ({
      artifact: payload.artifact,
      stage: payload.context?.Stage,
      order: payload.context?.executionOrder,
      xml: normalizeQuerySentinels(payload.content.query.xml),
    }));
}

function compareCellQueries(nativePayloads, localPayloads, differences) {
  if (stable(cellQueryShape(nativePayloads)) !== stable(cellQueryShape(localPayloads)))
    differences.push('backend-query-bytes');
}

function compareCellContexts(configuration, nativePayloads, localPayloads, portalActorId, gaps, differences) {
  const contextShape = (payloads) => payloads.filter((payload) => payload.context);
  const leftContexts = contextShape(nativePayloads),
    rightContexts = contextShape(localPayloads);
  if (leftContexts.length !== rightContexts.length) differences.push('runtime-context-count');
  let rootPortalContexts = 0;
  for (let index = 0; index < leftContexts.length; index++) {
    const left = leftContexts[index],
      right = rightContexts[index];
    if (!right) continue;
    if (!contextsMatch(left, right)) differences.push('runtime-context:' + index);
    if (compareContextPair(configuration, left, right, portalActorId, gaps)) rootPortalContexts++;
  }
  return { leftContexts, rootPortalContexts };
}

function compareContextPair(configuration, left, right, portalActorId, gaps) {
  const portal = left.context.extensions?.context2;
  const rootTable = configuration.boundOperation?.target.table ?? configuration.query.table;
  if (left.context.Depth !== 1 || left.context.PrimaryEntityName !== rootTable) return false;
  if (
    !portal?.observed ||
    portal.values?.IsPortalsClientCall !== true ||
    portal.values?.PortalsContactId !== portalActorId
  )
    gaps.push('actual-portal-context2-actor');
  return true;
}

function contextsMatch(left, right) {
  return (
    left.artifact === right.artifact &&
    compareRecordedContexts(left.context, right.context).stableEqual &&
    compareRecordedPluginArtifacts(left, right).stableEqual
  );
}

function validateCellOutcome(configuration, cell, native, local, pages, nativePayloads, gaps) {
  let code;
  try {
    code = JSON.parse(pages[0]?.wire?.body).error?.code;
  } catch {
    /* Optional payload or browser capability is unavailable. */
  }
  const liquidReceipt =
    cell.operation === 'read' && cell.lane === 'liquid' && !nativePayloads.length
      ? validateLiquidNoReadReceipt(configuration, native, local)
      : null;
  const permissionDenied =
    (pages[0]?.wire?.status === 403 && permissionCodes.has(code) && nativePayloads.length === 0) ||
    liquidReceipt?.verified === true;
  if (liquidReceipt && !liquidReceipt.verified && pages[0]?.wire?.status === 200) gaps.push(...liquidReceipt.gaps);
  return permissionDenied;
}

function validateMutationComparison(configuration, cell, native, local, permissionDenied, leftContexts, gaps) {
  if (cell.operation !== 'read') {
    if (
      configuration.boundOperation &&
      (stable(native.mutationBinding) !== stable(configuration.boundOperation) ||
        stable(local?.mutationBinding) !== stable(configuration.boundOperation))
    )
      gaps.push('actual-mutation-object-binding');
    if (!native?.cleanupReceipt?.verified || !sha.test(native.cleanupReceipt.snapshotSha256 ?? ''))
      gaps.push('mutation-cleanup-readback');
    if (
      !permissionDenied &&
      !leftContexts.some((payload) => payload.context.Stage === 10 || payload.context.Stage === 20)
    )
      gaps.push('permission-versus-business-guard-boundary');
    if (native?.sdkFixtureExecution === true) gaps.push('sdk-not-portal-crud');
  }
}

const adapterNames = [
  'assertExclusiveNativeWriter',
  'provisionFixtures',
  'verifyFixtures',
  'recoverFixtures',
  'cleanupFixtures',
  'prepareCell',
  'readSourceWitnesses',
  'clearPortalCaches',
  'collectNativeCell',
  'replayNativeCell',
];
const load = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));
const persist = (file, value) => savePrivateJson(file, value);
async function immutable(file, value) {
  const text = JSON.stringify(value, null, 2) + '\n';
  await savePrivateJson(file, value, { exclusive: true });
  return { file, sha256: hash(text) };
}
function assertCacheReceipt(receipt) {
  if (
    !receipt?.actions?.some((action) => action.name === 'clearConfig' && action.status === 'completed') ||
    !receipt.actions.some((action) => action.name === 'clearCache' && action.status === 'completed')
  )
    throw new Error('Native cache adapter must return both completed control actions.');
  return receipt;
}
function assertCleanupReceipt(receipt) {
  if (receipt?.verified !== true || receipt?.allRegionsRestored !== true || !sha.test(receipt.snapshotSha256 ?? ''))
    throw new Error('Fixture cleanup requires a verified all-region native readback receipt.');
  return receipt;
}
async function recoverEntry(client, adapters, entry, organisationId) {
  for (const journalFile of [...entry.leaseFiles].reverse()) {
    let leaseJournal;
    try {
      leaseJournal = await load(journalFile);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (leaseJournal.state !== 'restored')
      await restoreQualificationLease(client, leaseJournal, { journalFile, expectedOrganisationId: organisationId });
  }
  await adapters.recoverFixtures({ directory: entry.directory, variantId: entry.variantId });
  entry.cleanupReceipt = assertCleanupReceipt(
    await adapters.cleanupFixtures({ directory: entry.directory, variantId: entry.variantId }),
  );
  entry.cacheRestoreReceipt = assertCacheReceipt(
    await adapters.clearPortalCaches({ directory: entry.directory, phase: 'recovery' }),
  );
  entry.state = 'restored';
  entry.recovered = true;
}

async function processRoleMaskCells({
  configuration,
  mask,
  maskFolder,
  entry,
  lease,
  leaseJournal,
  fixtures,
  bindings,
  journalFile,
  adapters,
  actorContactId,
  journal,
}) {
  const touchedRoles = new Set([...lease.businessRoleIds, ...lease.temporaryRoleIds]);
  const expectedRoleIds = [
    ...leaseJournal.before.memberships.filter((role) => !touchedRoles.has(role)),
    ...lease.desiredRoleIds,
  ];
  for (const cell of configuration.configurationCells.filter((cell) => cell.roleMask === mask))
    await processConfigurationCell({
      cell,
      configuration,
      mask,
      maskFolder,
      entry,
      lease,
      expectedRoleIds,
      fixtures,
      bindings,
      journalFile,
      adapters,
      actorContactId,
      journal,
    });
}

async function processConfigurationCell({
  cell,
  configuration,
  mask,
  maskFolder,
  entry,
  lease,
  expectedRoleIds,
  fixtures,
  bindings,
  journalFile,
  adapters,
  actorContactId,
  journal,
}) {
  const cellFolder = path.join(maskFolder, hash(cell.id).slice(0, 24));
  await fs.mkdir(cellFolder);
  const repetitions = cell.operation === 'read' ? 2 : 1;
  const reports = [];
  const repeatedNative = [];
  for (let repeat = 0; repeat < repetitions; repeat++) {
    // Row versions advance even when a mutation restores the same field values. Each cell gets its actual before-state witness;
    // a stale mask-level snapshot must never qualify later CRUD.
    const captured = await collectConfigurationRepeat({
      cell,
      configuration,
      mask,
      cellFolder,
      repeat,
      fixtures,
      bindings,
      lease,
      expectedRoleIds,
      adapters,
      actorContactId,
    });
    repeatedNative.push(captured.fingerprint);
    reports.push({
      ...captured.report,
      repeat,
      nativeArtifact: captured.nativeArtifact,
      localArtifact: captured.localArtifact,
    });
  }
  const nativeRepeatsStable = new Set(repeatedNative).size === 1;
  const result = {
    id: cell.id,
    repeats: reports,
    nativeRepeatsStable,
    verdict: configurationCellVerdict(nativeRepeatsStable, reports),
  };
  entry.cells.push(await immutable(path.join(cellFolder, 'comparison.json'), result));
  await persist(journalFile, journal);
}

async function collectConfigurationRepeat({
  cell,
  configuration,
  mask,
  cellFolder,
  repeat,
  fixtures,
  bindings,
  lease,
  expectedRoleIds,
  adapters,
  actorContactId,
}) {
  const preparedCell = await adapters.prepareCell({
    cell,
    configuration,
    fixtures,
    bindings,
    directory: cellFolder,
    repeat,
  });
  if (cell.operation !== 'read' && !preparedCell?.boundOperation)
    throw new Error('Native CRUD needs its actual target/message binding before sealing source witnesses.');
  const cache = assertCacheReceipt(
    await adapters.clearPortalCaches({ directory: cellFolder, phase: 'capture', repeat }),
  );
  await immutable(path.join(cellFolder, `cache-controls-${repeat}.json`), cache);
  const witnesses = await adapters.readSourceWitnesses({
    configuration,
    fixtures,
    bindings,
    cell,
    directory: cellFolder,
    roleMask: mask,
    repeat,
  });
  const sealed = sealConfigurationWitnesses(configuration, {
    witnesses,
    boundOperation: preparedCell?.boundOperation,
    boundQuery: configuration.bindingContract.bindRecordIds(Object.values(bindings.regionRecordIds).flat()),
  });
  await immutable(path.join(cellFolder, `sealed-inputs-${repeat}.json`), sealed);
  const native = await adapters.collectNativeCell({
    cell,
    configuration: sealed,
    bindings,
    fixtures,
    cache,
    directory: cellFolder,
    repeat,
    desiredRoleIds: lease.desiredRoleIds,
    expectedRoleIds,
  });
  const nativeArtifact = await immutable(path.join(cellFolder, `native-${repeat}.json`), native);
  const local = await adapters.replayNativeCell({
    cell,
    configuration: sealed,
    native,
    fixtures,
    bindings,
    directory: cellFolder,
    repeat,
  });
  const localArtifact = await immutable(path.join(cellFolder, `local-${repeat}.json`), local);
  const report = compareConfigurationCell(sealed, cell, native, local, {
    desiredRoleIds: expectedRoleIds,
    actorContactId,
  });
  const fingerprint = nativeRepeatFingerprint(native);
  return { report, nativeArtifact, localArtifact, fingerprint };
}

function nativeRepeatFingerprint(native) {
  return hash({
    witnesses: native.nativeWitnesses,
    roles: native.membershipRoleIds,
    pages: native.pages?.map((page) => ({
      page: page.page,
      fragment: page.fragment,
      rows: page.rows,
      status: page.wire?.status,
      mime: page.wire?.mime,
    })),
    queries: recordedPluginPayloads(native.backendEvents ?? [])
      .filter((payload) => payload.content?.query?.xml)
      .map((payload) => ({
        artifact: payload.artifact,
        stage: payload.context?.Stage,
        order: payload.context?.executionOrder,
        xml: normalizeQuerySentinels(payload.content.query.xml),
      })),
  });
}

function configurationCellVerdict(nativeRepeatsStable, reports) {
  if (!nativeRepeatsStable) return 'unqualified';
  if (reports.every((report) => report.verdict === 'equal')) return 'equal';
  if (reports.some((report) => report.verdict === 'different')) return 'different';
  return 'unqualified';
}

async function recoverEntryLeases(entry, client, organisationId) {
  for (const journalFile of [...entry.leaseFiles].reverse()) {
    let leaseJournal;
    try {
      leaseJournal = await load(journalFile);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (leaseJournal.state !== 'restored')
      await restoreQualificationLease(client, leaseJournal, { journalFile, expectedOrganisationId: organisationId });
  }
}

async function runConfigurationEntry(
  configuration,
  {
    directory,
    client,
    adapters,
    blueprint,
    schema,
    catalogue,
    organisationId,
    siteId,
    actorContactId,
    resolvedIds,
    journal,
    journalFile,
  },
) {
  if (
    configuration.family === 'equipment-lifecycle' &&
    !schema.relationships.some((relationship) => relationship.name === 'pqvd_equipment_crudprobes')
  )
    throw new Error(
      'Equipment binding campaign requires its separately provisioned Source5 Probe lookup metadata before native fixture writes.',
    );
  const folder = path.join(directory, hash(configuration.variantId).slice(0, 24) + '-' + randomUUID());
  await fs.mkdir(folder);
  const entry = {
    variantId: configuration.variantId,
    directory: folder,
    state: 'provisioning',
    cells: [],
    leaseFiles: [],
    collected: false,
  };
  journal.entries.push(entry);
  await persist(journalFile, journal);
  await immutable(path.join(folder, 'definition.json'), configuration);
  let failure;
  try {
    const ownedRunId =
      configuration.family === 'equipment-lifecycle'
        ? await adapters.provisionFixtures({ phase: 'owned-run', configuration, directory: folder })
        : undefined;
    const fixtures = planQualificationFixtures(configuration, {
      schema,
      catalogue,
      resolvedIds,
      actorContactId,
      runId: randomUUID(),
      ownedRunId,
      bindingCohorts: configuration.family === 'equipment-lifecycle',
    });
    await immutable(path.join(folder, 'fixture-plan.json'), fixtures);
    await adapters.provisionFixtures({ phase: 'records', configuration, fixtures, directory: folder });
    const bindings = await adapters.verifyFixtures({ configuration, fixtures, directory: folder });
    await runConfigurationMasks({
      configuration,
      folder,
      entry,
      journal,
      journalFile,
      client,
      adapters,
      blueprint,
      organisationId,
      siteId,
      actorContactId,
      fixtures,
      bindings,
    });
    entry.collected = true;
  } catch (error) {
    failure = error;
    entry.failure = { name: error.name, message: error.message };
  } finally {
    // A failed recovery keeps this entry outstanding; the next invocation must reconcile the existing journals before any fresh native writes.
    await recoverEntryLeases(entry, client, organisationId);
    await adapters.recoverFixtures({ directory: folder, variantId: configuration.variantId });
    entry.cleanupReceipt = assertCleanupReceipt(
      await adapters.cleanupFixtures({ directory: folder, variantId: configuration.variantId }),
    );
    entry.cacheRestoreReceipt = assertCacheReceipt(
      await adapters.clearPortalCaches({ directory: folder, phase: 'final-restore' }),
    );
    entry.state = 'restored';
    await persist(journalFile, journal);
  }
  if (failure) throw failure;
}

async function runConfigurationMasks({
  configuration,
  folder,
  entry,
  journal,
  journalFile,
  client,
  adapters,
  blueprint,
  organisationId,
  siteId,
  actorContactId,
  fixtures,
  bindings,
}) {
  for (let mask = 0; mask < configuration.roleMaskCount; mask++) {
    const maskFolder = path.join(folder, 'm' + mask);
    await fs.mkdir(maskFolder);
    const leaseFile = path.join(maskFolder, 'lease.json');
    const lease = planQualificationLease(configuration, {
      blueprint,
      organisationId,
      siteId,
      actorContactId,
      fixtureBindings: bindings,
      roleMask: mask,
    });
    entry.leaseFiles.push(leaseFile);
    entry.state = 'leased';
    await persist(journalFile, journal);
    await withQualificationLease(
      client,
      lease,
      async ({ journal: leaseJournal }) =>
        processRoleMaskCells({
          configuration,
          mask,
          maskFolder,
          entry,
          lease,
          leaseJournal,
          fixtures,
          bindings,
          journalFile,
          adapters,
          actorContactId,
          journal,
        }),
      { journalFile: leaseFile },
    );
    assertCacheReceipt(await adapters.clearPortalCaches({ directory: maskFolder, phase: 'restore' }));
  }
}

/** Explicit power-cut recovery. Never delete a stale lock merely because its
 * timestamp is old. The coordinator must first prove exclusive native writer
 * ownership; an outstanding/foreign lease or drift prevents lock removal. */
export async function recoverNativeConfigurationCampaign({ directory, domainHash, client, adapters, organisationId }) {
  directory = path.resolve(directory);
  if (!directory.split(path.sep).includes('.paqvilo'))
    throw new Error('Native recovery artifacts must remain private.');
  for (const name of ['assertExclusiveNativeWriter', 'recoverFixtures', 'cleanupFixtures', 'clearPortalCaches'])
    if (typeof adapters?.[name] !== 'function') throw new Error('Required native recovery adapter is missing: ' + name);
  await adapters.assertExclusiveNativeWriter();
  const file = path.join(directory, 'campaign.json'),
    journal = await load(file),
    lock = path.join(directory, 'writer.lock');
  const ownership = await load(lock);
  if (journal.domainHash !== domainHash || ownership.domainHash !== domainHash || !ownership.leaseId)
    throw new Error('Recovery lock/source ownership mismatch.');
  for (const entry of journal.entries.filter((entry) => entry.state !== 'restored')) {
    await recoverEntry(client, adapters, entry, organisationId);
    await persist(file, journal);
  }
  const latest = await load(lock);
  if (latest.leaseId !== ownership.leaseId || latest.domainHash !== domainHash)
    throw new Error('Recovery lock changed concurrently.');
  await fs.unlink(lock);
  return { directory, domainHash, baselineRestored: true, nativeQualifiedCells: journal.nativeQualifiedCells };
}

/** Resumable execution driver. All native operations are delegated to the sole
 * writer's bound adapters, including trusted fixture writes and actual portal
 * CRUD. No empty adapter, SDK-only result or static enumeration earns credit.
 * Each invocation is bounded and restores memberships, components, Account,
 * caches and fixtures before another configuration may run. */
export async function runNativeConfigurationCampaign({
  directory,
  domain,
  client,
  adapters,
  blueprint,
  schema,
  catalogue,
  organisationId,
  siteId,
  actorContactId,
  resolvedIds,
  allowNativeConfigurationMutation,
  baseRoleCampaignFreezeActive,
  maxConfigurations = 1,
}) {
  validateCampaignInputs(allowNativeConfigurationMutation, baseRoleCampaignFreezeActive, maxConfigurations, adapters);
  directory = path.resolve(directory);
  if (!directory.split(path.sep).includes('.paqvilo'))
    throw new Error('Native campaign artifacts must remain private.');
  await fs.mkdir(directory, { recursive: true });
  await adapters.assertExclusiveNativeWriter();
  const lock = path.join(directory, 'writer.lock'),
    handle = await fs.open(lock, 'wx', 0o600);
  const ownership = {
    schemaVersion: 1,
    domainHash: domain.domainHash,
    leaseId: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  await handle.writeFile(JSON.stringify(ownership));
  await handle.sync();
  const journalFile = path.join(directory, 'campaign.json');
  let journal;
  try {
    journal = await loadCampaignJournal(journalFile, domain);
    if (journal.domainHash !== domain.domainHash)
      throw new Error('Campaign source domain drifted; create a new private campaign.');
    await recoverPendingEntries(journal, client, adapters, organisationId, journalFile);
    const completed = new Set(journal.entries.filter((entry) => entry.collected).map((entry) => entry.variantId));
    for (const configuration of domain.configurations
      .filter((configuration) => !completed.has(configuration.variantId))
      .slice(0, maxConfigurations))
      await runConfigurationEntry(configuration, {
        directory,
        client,
        adapters,
        blueprint,
        schema,
        catalogue,
        organisationId,
        siteId,
        actorContactId,
        resolvedIds,
        journal,
        journalFile,
      });
    const qualified = await collectQualifiedCells(journal);
    journal.nativeQualifiedCells = qualified.size;
    await persist(journalFile, journal);
    return {
      directory,
      domainHash: domain.domainHash,
      denominator: domain.denominator,
      nativeQualifiedCells: qualified.size,
      collectedConfigurations: new Set(
        journal.entries.filter((entry) => entry.collected).map((entry) => entry.variantId),
      ).size,
      qualification: qualified.size === domain.denominator ? 'bounded-native-configuration-domain-only' : 'incomplete',
      universalPermissionParity: false,
    };
  } finally {
    await handle.close();
    const latest = await load(lock);
    if (latest.leaseId !== ownership.leaseId)
      // eslint-disable-next-line no-unsafe-finally -- Ownership drift must prevent cleanup of a foreign lease even after an operation failure.
      throw new Error('Configuration writer lock changed; refusing foreign cleanup.');
    // An unresolved cleanup needs explicit recovery under the retained lock.
    if (!journal?.entries?.some((entry) => entry.state !== 'restored')) await fs.unlink(lock);
  }
}

function validateCampaignInputs(allowMutation, baseRoleFreeze, maxConfigurations, adapters) {
  if (allowMutation !== true || baseRoleFreeze !== false)
    throw new Error('Explicit native configuration authorization and released base-role freeze are required.');
  if (!Number.isInteger(maxConfigurations) || maxConfigurations < 1 || maxConfigurations > 32)
    throw new Error('Configuration execution needs a bounded batch of one to 32 variants.');
  for (const name of adapterNames)
    if (typeof adapters?.[name] !== 'function')
      throw new Error('Required native execution adapter is missing: ' + name);
}

async function loadCampaignJournal(journalFile, domain) {
  try {
    return await load(journalFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const journal = {
      schemaVersion: 1,
      kind: domain.kind,
      domainHash: domain.domainHash,
      denominator: domain.denominator,
      entries: [],
      nativeQualifiedCells: 0,
    };
    await immutable(journalFile, journal);
    return journal;
  }
}

async function recoverPendingEntries(journal, client, adapters, organisationId, journalFile) {
  for (const pending of journal.entries.filter((entry) => entry.state !== 'restored')) {
    await recoverEntry(client, adapters, pending, organisationId);
    await persist(journalFile, journal);
  }
}

async function collectQualifiedCells(journal) {
  const qualified = new Set();
  for (const entry of journal.entries.filter((entry) => entry.state === 'restored'))
    for (const artifact of entry.cells) {
      const bytes = await fs.readFile(artifact.file, 'utf8');
      if (hash(bytes) !== artifact.sha256) throw new Error('Immutable configuration cell artifact changed.');
      const report = JSON.parse(bytes);
      if (report.verdict === 'equal') qualified.add(report.id);
    }
  return qualified;
}
