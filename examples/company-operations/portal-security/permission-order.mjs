import { createHash } from 'node:crypto';
import { parseXmlDocument } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';
import { compilePermissionFetchXml,permissionOrderGraphFingerprint } from 'paqvilo/mirage/lib/permission-query.mjs';
export {permissionOrderGraphFingerprint};
import { xmlEscape } from '../portal-harness/compile.mjs';
import { normalizeQuerySentinels } from '../portal-harness/parity.mjs';

const stable = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const bytesHash = value => createHash('sha256').update(value).digest('hex');
const walk = function* (element) { yield element; for (const child of element.children) yield* walk(child); };
const id = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();

/** Order-independent fingerprint of the normalized graph used by the compiler.
 * Native raw snapshot hashes remain separate provenance. Membership/actor
 * values are intentionally absent; they are separate qualification domains. */

/** Ordered terminal paths, independent of generated alias numbers. Authored
 * aliases remain excluded. This is diagnostic normalization, never permission
 * evaluation or a backend-query replacement. */
export function permissionPathSequence(receivedXml, authoredXml) {
  const tree = parseXmlDocument(receivedXml, { root: 'fetch' });
  const root = tree.children.find(node => node.name === 'entity');
  if (!root) throw new Error('Received query has no entity.');
  const authored = parseXmlDocument(authoredXml, { root: 'fetch' });
  const authoredAliases = new Set([...walk(authored)].map(node => node.attrs.alias).filter(Boolean));
  const aliases = new Map(), diagnostics = [];
  function links(parent, path = []) {
    for (const link of parent.children.filter(node => node.name === 'link-entity')) {
      const current = [...path, Object.fromEntries(['name', 'from', 'to', 'link-type', 'visible', 'intersect']
        .filter(key => link.attrs[key] != null).map(key => [key, link.attrs[key]]))];
      if (link.attrs.alias && !authoredAliases.has(link.attrs.alias)) {
        if (aliases.has(link.attrs.alias)) diagnostics.push({ code: 'DUPLICATE_RECEIVED_ALIAS', alias: link.attrs.alias });
        aliases.set(link.attrs.alias, current);
      }
      links(link, current);
    }
  }
  links(root);
  const union = root.children.filter(node => node.name === 'filter')
    .flatMap(node => [...walk(node)].filter(child => child.name === 'filter' && child.attrs.hint === 'union'));
  const sequence = [];
  for (const filter of union) for (const condition of [...walk(filter)].filter(node => node.name === 'condition')) {
    const alias = condition.attrs.entityname;
    if (alias && authoredAliases.has(alias)) continue;
    if (alias && !aliases.has(alias)) {
      diagnostics.push({ code: 'UNMAPPED_TERMINAL_ALIAS', alias }); continue;
    }
    const terminal = Object.fromEntries(Object.entries(condition.attrs).filter(([key]) => key !== 'entityname'));
    const shape = { root: root.attrs.name, links: alias ? aliases.get(alias) : [], terminal,
      values: condition.children.filter(node => node.name === 'value').map(node => node.text) };
    sequence.push({ signature: hash(shape), shape });
  }
  if (!union.length) diagnostics.push({ code: 'NO_PERMISSION_UNION',
    message: 'Global, denied, self/direct rewrites or other native contracts need separate qualification.' });
  return { table: root.attrs.name, sequence, diagnostics };
}

/** Generate singleton source paths using the frozen normalized permission
 * graph. Passing rules deliberately selects the leaf independently of roles;
 * ancestor resolution still uses that same graph and actor. */
export function permissionPathCatalogue({ permissions, identity, mappings, table, authoredXml, permissionsSnapshotHash }) {
  const entries = [], diagnostics = [];
  for (const permission of permissions.filter(permission => permission.entity === table && permission.enabled !== false &&
    (permission.operations ?? []).includes('read'))) {
    const pathIds = new Set([id(permission.id)]), byId = new Map(permissions.map(current => [id(current.id), current]));
    let current = permission;
    while (current.scope === 'parent') {
      const parentId = id(current.parentPermissionId ?? current.parentId);
      if (!parentId || pathIds.has(parentId)) break;
      pathIds.add(parentId); current = byId.get(parentId);
      if (!current) break;
    }
    let rootSelection = true;
    const compiled = compilePermissionFetchXml(authoredXml, { permissions, identity, mappings,
      rules: entity => {
        // The compiler first selects root leaves, then validates ancestors.
        // A same-table ancestor must not become a second independent root.
        if (rootSelection) { rootSelection = false; return [permission]; }
        return permissions.filter(current => current.entity === entity && pathIds.has(id(current.id)));
      } });
    const extracted = permissionPathSequence(compiled.xml, authoredXml);
    if (extracted.sequence.length !== 1 || extracted.diagnostics.length) {
      diagnostics.push({ permissionId: permission.id, code: 'SINGLETON_PATH_UNQUALIFIED',
        compiler: compiled.diagnostics, extracted: extracted.diagnostics, terminalCount: extracted.sequence.length });
      continue;
    }
    entries.push({ permissionId: id(permission.id), roleIds: (permission.roleIds ?? []).map(id),
      signature: extracted.sequence[0].signature, shape: extracted.sequence[0].shape });
  }
  if (permissionsSnapshotHash != null && !/^[a-f0-9]{64}$/.test(permissionsSnapshotHash))
    throw new Error('Native permissionsSnapshotHash must be SHA-256.');
  return { table, permissionsSnapshotHash: permissionsSnapshotHash ?? hash(permissions),
    normalizedModelHash: permissionOrderGraphFingerprint(permissions), entries, diagnostics };
}

export function learnPermissionOrder(catalogue, masterWitness) {
  const errors = [];
  if (masterWitness.permissionsSnapshotHash !== catalogue.permissionsSnapshotHash) errors.push('permission-snapshot-mismatch');
  errors.push(...witnessErrors(masterWitness));
  const selected = new Set((masterWitness.roleIds ?? []).map(id));
  if (catalogue.entries.some(entry => !entry.roleIds.some(role => selected.has(role)))) errors.push('master-memberships-incomplete');
  const observed = permissionPathSequence(masterWitness.receivedXml, masterWitness.authoredXml);
  const ids = [], seen = new Set();
  for (const item of observed.sequence) {
    const candidates = catalogue.entries.filter(entry => entry.signature === item.signature);
    // Identical native paths can represent multiple grants: preserve the group,
    // rather than inventing a GUID order that native XML cannot demonstrate.
    if (!candidates.length) { errors.push('unknown-native-path'); continue; }
    if (seen.has(item.signature)) { errors.push('duplicate-native-path'); continue; }
    seen.add(item.signature); ids.push(candidates.map(candidate => candidate.permissionId));
  }
  for (const entry of catalogue.entries) if (!seen.has(entry.signature)) errors.push('missing-master-path');
  if (catalogue.diagnostics.length || observed.diagnostics.length) errors.push('unsupported-path-contract');
  return { table: catalogue.table, permissionsSnapshotHash: catalogue.permissionsSnapshotHash,
    observerProfileHash: masterWitness.observerProfileHash,
    orderedPermissionGroups: ids, signatures: observed.sequence.map(item => item.signature),
    sourceWitnessHash: masterWitness.artifactHash, qualification: errors.length ? 'unqualified' : 'master-order-only',
    errors: [...new Set(errors)], universalPermissionParity: false };
}

export function compareFilteredPermissionOrder(order, catalogue, witness) {
  const errors = [];
  if (order.qualification !== 'master-order-only') errors.push('master-not-qualified');
  if (witness.permissionsSnapshotHash !== order.permissionsSnapshotHash) errors.push('permission-snapshot-mismatch');
  if (witness.observerProfileHash !== order.observerProfileHash) errors.push('observer-profile-mismatch');
  errors.push(...witnessErrors(witness));
  const roles = new Set((witness.roleIds ?? []).map(id));
  const selected = new Set(catalogue.entries.filter(entry => entry.roleIds.some(role => roles.has(role))).map(entry => entry.signature));
  const expected = order.signatures.filter(signature => selected.has(signature));
  const actual = permissionPathSequence(witness.receivedXml, witness.authoredXml);
  if (actual.diagnostics.length) errors.push('unsupported-path-contract');
  const equal = stable(expected) === stable(actual.sequence.map(item => item.signature));
  return { mask: witness.mask, table: order.table, expected, received: actual.sequence.map(item => item.signature),
    verdict: errors.length ? 'unqualified' : equal ? 'equal' : 'different', errors,
    scope: 'one-actual-native-role-subset', universalPermissionParity: false };
}

function witnessErrors(witness) {
  const errors = [];
  if (!witness.nativeMembershipsVerified || !witness.nativeCacheQualified || !witness.artifactIntegrityVerified)
    errors.push('native-witness-incomplete');
  if (!/^[a-f0-9]{64}$/.test(witness.observerProfileHash ?? '')) errors.push('missing-frozen-observer-profile');
  if (typeof witness.receivedXml !== 'string' || witness.artifactHash !== bytesHash(witness.receivedXml))
    errors.push('artifact-hash-mismatch');
  if (typeof witness.repeatReceivedXml !== 'string' ||
      normalizeQuerySentinels(witness.repeatReceivedXml) !== normalizeQuerySentinels(witness.receivedXml))
    errors.push('repeat-not-marker-normalized-byte-stable');
  return errors;
}

/** Hypotheses are diagnostics, never an automatically installed policy. A
 * passing singleton-role sample cannot establish an all-role ordering rule. */
export function diagnosePermissionOrder(catalogue, sequence, { externalOrders = {} } = {}) {
  const entries = catalogue.entries.filter(entry => sequence.some(path => path.signature === entry.signature));
  const observed = sequence.map(entry => entry.signature);
  const candidates = {
    'source-definition-order': entries,
    'permission-guid-lexical': [...entries].sort((a, b) => a.permissionId.localeCompare(b.permissionId)),
    'path-depth-ascending': [...entries].sort((a, b) => a.shape.links.length - b.shape.links.length),
    'path-depth-descending': [...entries].sort((a, b) => b.shape.links.length - a.shape.links.length),
    'relationship-path-lexical': [...entries].sort((a, b) => stable(a.shape.links).localeCompare(stable(b.shape.links))),
    'terminal-attribute-lexical': [...entries].sort((a, b) => a.shape.terminal.attribute.localeCompare(b.shape.terminal.attribute)),
  };
  for (const [name, order] of Object.entries(externalOrders)) {
    if (!Array.isArray(order) || order.length !== entries.length || new Set(order).size !== entries.length ||
        order.some(permissionId => !entries.some(entry => entry.permissionId === id(permissionId))))
      throw new Error('External runtime ordering hypothesis must contain exactly this distinct source permission set.');
    candidates[name] = order.map(permissionId => entries.find(entry => entry.permissionId === id(permissionId)));
  }
  return Object.fromEntries(Object.entries(candidates).map(([name, ordered]) => {
    const unique = [...new Set(ordered.map(entry => entry.signature))];
    return [name, { matches: stable(unique) === stable(observed), predictedPermissionIds: ordered.map(entry => entry.permissionId),
      qualification: 'hypothesis-only' }];
  }));
}

/** Small requests that still force every permission path to be expanded.
 * Received final-observer XML is required even when Dataverse rejects its join budget.
 * A failed read does not become a successful access/result qualification. */
export function buildPermissionOrderProbe({ blueprint, schema, catalogue, permissionsSnapshotHash, nativeFixtures }) {
  if (!/^[a-f0-9]{64}$/.test(permissionsSnapshotHash ?? '')) throw new Error('A frozen native permission snapshot SHA-256 is required.');
  const roles = blueprint.roles.filter(role => role.code !== 'TESTRUNNER');
  if (roles.length !== 12) throw new Error('This fixed-source study requires all twelve source business roles.');
  const all = 4095, masks = new Set([0, all]);
  for (let bit = 0; bit < roles.length; bit++) { masks.add(1 << bit); masks.add(all ^ (1 << bit)); }
  for (let left = 0; left < roles.length; left++) for (let right = left + 1; right < roles.length; right++) masks.add((1 << left) | (1 << right));
  const tables = [...new Set(blueprint.nodes.filter(node => node.active && node.privileges.read && node.role !== 'TESTRUNNER')
    .map(node => node.table))].sort();
  const cases = tables.map((table, index) => {
    const meta = catalogue.tables.find(meta => meta.name === table) ?? schema.tables.find(meta => meta.name === table);
    const fixture = nativeFixtures ? { id: nativeFixtures[table]?.[0]?.[meta.primaryId] }
      : catalogue.records.find(record => record.table === table);
    if (!meta?.primaryId || !fixture?.id) throw new Error('Order study needs source primary key and one existing fixture for ' + table);
    const primaryName = meta.primaryName ?? ({ account: 'name', contact: 'fullname', transactioncurrency: 'currencyname' }[table] ?? 'pqvd_name');
    const fetchXml = `<fetch count="1" page="1"><entity name="${xmlEscape(table)}"><attribute name="${xmlEscape(meta.primaryId)}"></attribute>` +
      `<filter type="and"><condition attribute="${xmlEscape(meta.primaryId)}" operator="eq" value="${xmlEscape(fixture.id)}"></condition></filter>` +
      `<filter type="or"><condition attribute="${xmlEscape(primaryName)}" operator="null"></condition><filter type="and">` +
      `<condition attribute="${xmlEscape(primaryName)}" operator="ne" value="{{markerUtc}}"></condition>` +
      `<condition attribute="${xmlEscape(primaryName)}" operator="ne" value="{{markerOperation}}"></condition></filter></filter></entity></fetch>`;
    return { id: `QF-ORDER-${String(index + 1).padStart(2, '0')}`, table, entitySet: meta.entitySet,
      primaryId: meta.primaryId, primaryName, variant: 'permission-order', pageSize: 1, fetchXml,
      fields: [{ name: meta.primaryId, source: meta.primaryId, type: 'guid', nullable: false }],
      lanes: ['liquid', 'webapi'], authoredJoinCount: 0, logicalQueryHash: hash(fetchXml) };
  });
  return { kind: 'native-permission-order-calibration', qualification: 'plan-only', permissionsSnapshotHash,
    roles, masterMask: all, representativeMasks: [...masks].sort((a, b) => a - b), cases,
    excludedTables: [...new Set(blueprint.nodes.filter(node => !tables.includes(node.table)).map(node => node.table))],
    calibrationCells: masks.size * cases.length * 2,
    exhaustiveSubsetCells: 4096 * cases.length * 2,
    protocol: ['Capture all-twelve-role master paths for each root in both lanes and two stable repeats.',
      'Capture all singleton, pair, complement and empty masks to test filtered-master-order hypothesis.',
      'Only actual native witnesses for all 4096 masks establish the fixed-graph ordering contract.',
      'When no-union/global/denied paths appear, qualify their distinct rewrite contracts separately.',
      'Freeze the exact observer-registration profile and require its final received artifact; missing disabled stages are not invented.',
      'Keep join-budget errors and access outcomes distinct; received XML can qualify order only.'],
    universalPermissionParity: false };
}
