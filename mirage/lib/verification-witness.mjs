import { createHash } from 'node:crypto';

// Typed representation preserves absent versus explicit undefined, Date,
// bigint and duplicate rows without ambiguous sentinel objects.
const canonical = (value) =>
  value === undefined
    ? ['undefined']
    : value === null
      ? ['null']
      : value instanceof Date
        ? ['date', value.toISOString()]
        : Array.isArray(value)
          ? ['array', value.map(canonical)]
          : typeof value === 'object'
            ? [
                'object',
                Object.keys(value)
                  .sort()
                  .map((key) => [key, canonical(value[key])]),
              ]
            : [typeof value, typeof value === 'number' && Object.is(value, -0) ? '-0' : String(value)];
const hash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
const fail = (message) => {
  throw Object.assign(new Error(message), { status: 400, code: 'InvalidVerificationSelection' });
};
const HASH_KEYS = ['permissions', 'mappings', 'settings', 'sources', 'operationMode', 'actor', 'fixtures', 'selection'];
const receiptScope = (value) => ({
  hashes: value.hashes,
  actor: value.actor,
  selection: { tables: value.selection.tables, rows: value.selection.rows },
  operationMode: value.operationMode,
});

export function verificationTableSelection(tables, state) {
  if (
    !Array.isArray(tables) ||
    !tables.length ||
    tables.length > 32 ||
    tables.some((table) => typeof table !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/i.test(table)) ||
    new Set(tables).size !== tables.length
  )
    fail('Select between one and 32 distinct logical fixture tables.');
  if (tables.some((table) => !Object.hasOwn(state.tables ?? {}, table) || !Object.hasOwn(state.mappings ?? {}, table)))
    fail('Every selected fixture table must exist in the current runtime data and mappings.');
  return [...tables].sort();
}

/** Pure in-memory hashing. The caller holds the DataStore read-operation frame;
 * this function never retrieves records through SDK/permission/plugin hooks.
 * All fields of selected rows are hashed; no row body or setting value leaves
 * this function. No recording table is excluded automatically. */
export function verificationWitness({ state, tables, identity, portal, runtime }) {
  const selection = verificationTableSelection(tables, state);
  const actor = {
    ...identity,
    contactId: identity?.contactId ?? identity?.id ?? null,
    accountId: identity?.accountId ?? null,
    roleSource: identity?.roleSource ?? 'memberships',
    roles: [...(identity?.roles ?? [])].sort(),
    roleIds: [...(identity?.roleIds ?? [])].sort(),
  };
  const rows = Object.fromEntries(
    selection.map((table) => [
      table,
      {
        count: state.tables[table].length,
        sha256: hash(state.tables[table].map((row) => JSON.stringify(canonical(row))).sort()),
      },
    ]),
  );
  const operationMode = {
    permissionMode: state.settings?.permissionMode ?? 'enforce',
    permissionSource: state.simulator?.permissionSource ?? 'configured',
    mode: state.simulator?.mode ?? 'local',
    pageMode: state.simulator?.pageMode ?? 'local',
    identityScope: state.simulator?.identityScope ?? 'sessions',
  };
  const sources = {
    loadedSourceFingerprint: runtime?.loadedSourceFingerprint ?? null,
    currentSourceFingerprint: runtime?.currentSourceFingerprint ?? null,
    loadedImplementationFingerprint: runtime?.loadedImplementationFingerprint ?? null,
    currentImplementationFingerprint: runtime?.currentImplementationFingerprint ?? null,
  };
  const hashes = {
    permissions: hash(state.permissions ?? []),
    mappings: hash(state.mappings ?? {}),
    settings: hash({ settings: state.settings ?? {}, simulator: state.simulator ?? {} }),
    sources: hash({
      ...sources,
      effectivePortalRecords: portal?.records ?? [],
      effectiveSettings: portal?.settings ?? {},
      effectiveSnippets: portal?.snippets ?? {},
      backendDefinitions: state.plugins ?? [],
    }),
    operationMode: hash(operationMode),
    actor: hash(actor),
    fixtures: hash(rows),
    selection: hash(selection),
  };
  const witness = {
    schemaVersion: 1,
    kind: 'MirageVerificationWitness',
    capturedAt: new Date().toISOString(),
    selection: {
      tables: selection,
      rows,
      excludedTables: Object.keys(state.tables ?? {})
        .filter((table) => !selection.includes(table))
        .sort(),
      scope:
        'All stored columns and row multiplicities in explicitly selected fixture tables; excluded collections are unobserved. Effective actor fields are independently hashed.',
    },
    actor: { contactId: actor.contactId, roleSource: actor.roleSource, sha256: hashes.actor },
    operationMode,
    runtime: {
      origin: runtime?.origin ?? null,
      instanceId: runtime?.instanceId ?? null,
      revision: runtime?.revision ?? null,
      storeRevision: runtime?.storeRevision ?? null,
      ...sources,
      backendAssemblyBytes:
        'Unobserved by this read-only endpoint; original DLL/SDK runtime receipts require a separate verifier.',
    },
    hashes,
    nativeParityQualified: false,
  };
  witness.scopeSha256 = hash(receiptScope(witness));
  return witness;
}

export function compareVerificationWitnesses(before, after) {
  for (const value of [before, after]) {
    if (
      value?.kind !== 'MirageVerificationWitness' ||
      value.schemaVersion !== 1 ||
      !value.hashes ||
      Object.keys(value.hashes).length !== HASH_KEYS.length ||
      HASH_KEYS.some((key) => !/^[a-f0-9]{64}$/.test(value.hashes[key] ?? '')) ||
      !Array.isArray(value.selection?.tables) ||
      !value.selection.tables.length ||
      value.selection.tables.length > 32 ||
      new Set(value.selection.tables).size !== value.selection.tables.length ||
      value.selection.tables.some((table) => typeof table !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/i.test(table)) ||
      !value.selection.rows ||
      Object.keys(value.selection.rows).length !== value.selection.tables.length ||
      value.selection.tables.some(
        (table) =>
          !Number.isSafeInteger(value.selection.rows[table]?.count) ||
          value.selection.rows[table].count < 0 ||
          !/^[a-f0-9]{64}$/.test(value.selection.rows[table]?.sha256 ?? ''),
      ) ||
      value.hashes.selection !== hash(value.selection.tables) ||
      value.hashes.fixtures !== hash(value.selection.rows) ||
      value.actor?.sha256 !== value.hashes.actor ||
      value.hashes.operationMode !== hash(value.operationMode) ||
      value.scopeSha256 !== hash(receiptScope(value)) ||
      !value.runtime
    )
      fail('Two complete compatible runtime verification receipts with matching scope checksums are required.');
  }
  const changed = Object.keys(before.hashes).filter((field) => before.hashes[field] !== after.hashes[field]);
  return {
    stable: changed.length === 0,
    changed,
    runtimeRevisionChanged:
      before.runtime.revision !== after.runtime.revision ||
      before.runtime.storeRevision !== after.runtime.storeRevision,
    selectionIdentical: !changed.includes('selection'),
    runtimeInstanceChanged:
      before.runtime.instanceId !== after.runtime.instanceId || before.runtime.origin !== after.runtime.origin,
    scope:
      'Only the stated source/configuration/actor and selected fixture-table hashes are compared; no excluded table coverage.',
    nativeParityQualified: false,
  };
}
