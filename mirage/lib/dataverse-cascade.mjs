// Cascade actions of one-to-many relationships in the Dataverse API: Assign executes; Share, Unshare, Reparent and Merge are contract only.
//
// A relationship's CascadeConfiguration (relationship.cascade, read through store.referencesTo) names what happens to the
// referencing rows when the referenced row changes. Assign executes: when an update changes the row's ownerid, the afterWrite
// hook gives the children the new owner inside the write's transaction, by relationship:
//   Cascade    every child;
//   Active     children with statecode 0 only;
//   UserOwned  children owned by the parent's owner from before the write;
//   NoCascade, RemoveLink and any other value: nothing.
// A child whose owner changed applies its own one-to-many relationships the same way, depth bounded by a visited set.
// Children already owned by the new owner are not written. Writes go through store.updateRecord, so their row journal
// rolls back with the write. Before each child is written the caller's Assign privilege on it is checked
// (api.principals.authorize, operation assign); a refusal fails the whole write, the parent included. The store write itself
// is marked admin: that skips only the portal table-permission layer (the delete cascade in data.mjs does the same).
// Assumption: native Assign checks the privilege on each cascaded row as well as on the primary row (only the latter is
// documented). A host without api.principals (portal only) cascades without the check.
// The owner before the write is kept per request context (WeakMap), so a write that fails between beforeWrite and afterWrite
// leaves nothing behind for a later afterWrite to consume.
// Share, Unshare, Reparent and Merge are not simulated: nothing is granted, revoked, re-parented or merged. install and
// every reseed report CASCADE_<ACTION>_NOT_SIMULATED once per table that declares such a cascade; describe() lists the
// seam each one needs in the host (listed in describe().seams).
// Assumption: a child's own Assign cascade also runs for grandchildren (the recursion follows the parental model).
// UserOwned means "owned by the same user as the primary row"; after the write that row has the new owner, so the owner
// from before the write is compared.
// A cascaded child takes the same ownership columns a direct Assign writes (ownershipOptions).
// ponytail: active workflows and business rules on reassigned rows are not deactivated (natively they are); add when a
// test reads them.
import { onceReporter } from './dataverse-addon-common.mjs';

const ASSIGN_BEHAVIOURS = new Set(['Cascade', 'Active', 'UserOwned']);
const NOT_SIMULATED = {
  share: 'CASCADE_SHARE_NOT_SIMULATED',
  unshare: 'CASCADE_UNSHARE_NOT_SIMULATED',
  reparent: 'CASCADE_REPARENT_NOT_SIMULATED',
  merge: 'CASCADE_MERGE_NOT_SIMULATED',
};
const OPERATIONS = ['CascadeAssign', 'CascadeShare', 'CascadeUnshare', 'CascadeReparent', 'CascadeMerge'];
const OPERATION_LEVELS = {
  CascadeAssign: 'behaviour',
  CascadeShare: 'contract',
  CascadeUnshare: 'contract',
  CascadeReparent: 'contract',
  CascadeMerge: 'contract',
};
const SEAMS = {
  CascadeShare:
    'mirage/lib/dataverse-security.mjs grantAccess(store, { target, principal, mask }) for each referencing row, from an afterWrite hook',
  CascadeUnshare:
    'mirage/lib/dataverse-security.mjs revokeAccess(store, { target, principal }) for each referencing row',
  CascadeReparent:
    'no existing seam: a beforeWrite/afterWrite hook on the referencing table where its lookup column changes (mirage/lib/dataverse-records.mjs updateData)',
  CascadeMerge:
    "mirage/lib/dataverse-record-messages.mjs merge(api, ctx), the Merge action, after the subordinate's children move",
};

const bare = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const sameId = (a, b) => a != null && b != null && bare(a) === bare(b);
const keyOf = (logical, id) => `${logical}\u0000${bare(id)}`;

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { reporter: onceReporter(), previousOwner: new WeakMap() });
  return states.get(api);
}

function report(
  state,
  entry,
  key = `${entry.code}\u0000${entry.table}\u0000${entry.referencing ?? ''}\u0000${entry.column ?? ''}`,
) {
  state.reporter.report(entry, key);
}

// Share, Unshare, Reparent and Merge declared by any relationship: one diagnostic per table and action.
function scanDeclared(api, state) {
  for (const logical of Object.keys(api.store.state.mappings ?? {})) {
    for (const reference of api.store.referencesTo(logical, {})) {
      for (const [action, code] of Object.entries(NOT_SIMULATED)) {
        const behaviour = reference.cascade?.[action];
        if (behaviour == null || behaviour === 'NoCascade') continue;
        report(
          state,
          {
            code,
            table: logical,
            referencing: reference.entity,
            column: reference.column,
            relationship: reference.schemaName ?? null,
            message: `The ${action} cascade (${behaviour}) of ${logical} is not simulated: referencing ${reference.entity} rows are left as they are.`,
          },
          `${code}\u0000${logical}`,
        );
      }
    }
  }
}

// Gives the children of `parent` (a row of a table, with its idColumn) the owner `newOwner`, by each relationship's Assign:
// yields each child write as [table, id, values, identity], so the caller runs it on its own drive (cascadeAssign).
function* assignChildren(api, state, c, parent, previousOwner, newOwner, visited) {
  for (const reference of api.store.referencesTo(parent.logicalName, c.identity ?? {})) {
    const behaviour = reference.cascade?.assign;
    if (behaviour == null) {
      report(state, {
        code: 'CASCADE_ASSIGN_DEFAULTED',
        table: parent.logicalName,
        referencing: reference.entity,
        column: reference.column,
        relationship: reference.schemaName ?? null,
        message: `No imported CascadeAssign for ${reference.entity}.${reference.column} -> ${parent.logicalName}; NoCascade, the default this simulator reports for Assign, was applied.`,
      });
      continue;
    }
    if (!ASSIGN_BEHAVIOURS.has(behaviour)) continue;
    const target = refId(parent.row[reference.targetColumn ?? parent.idColumn]);
    if (target == null) continue;
    const childMapping = api.store.resolveMapping(reference.entity);
    const children = api.store.tableRows(reference.entity).filter((child) => {
      const link = child[reference.column];
      if (link && typeof link === 'object' && link.logical_name && link.logical_name !== parent.logicalName)
        return false;
      if (!sameId(refId(link), target)) return false;
      if (behaviour === 'Active' && Number(child.statecode ?? 0) !== 0) return false;
      if (behaviour === 'UserOwned' && !sameId(refId(child.ownerid), previousOwner)) return false;
      return !sameId(refId(child.ownerid), refId(newOwner));
    });
    for (const child of children) {
      const childId = child[childMapping.idColumn];
      const key = keyOf(reference.entity, childId);
      if (visited.has(key)) continue;
      visited.add(key);
      const childPrevious = refId(child.ownerid);
      api.principals?.authorize({
        user: c.user,
        entity: reference.entity,
        operation: 'assign',
        row: child,
        mapping: childMapping,
      });
      yield [
        reference.entity,
        childId,
        { ownerid: structuredClone(newOwner) },
        { ...(c.identity ?? {}), admin: true },
        ownershipOptions(api, c, newOwner),
      ];
      yield* assignChildren(
        api,
        state,
        c,
        { logicalName: reference.entity, idColumn: childMapping.idColumn, row: child },
        childPrevious,
        newOwner,
        visited,
      );
    }
  }
}

// Runs the child writes on the drive of the write that assigned the parent: the synchronous drive (a plug-in's own SDK call)
// writes with store.updateRecord; every other write awaits store.updateRecordAsync, so a child's synchronous service
// endpoint step posts in process instead of on the synchronous I/O bridge.
function cascadeAssign(api, writes, sync) {
  if (sync) {
    for (const [table, id, values, identity, options] of writes)
      api.store.updateRecord(table, id, values, identity, options);
    return undefined;
  }
  return (async () => {
    for (const [table, id, values, identity, options] of writes)
      await api.store.updateRecordAsync(table, id, values, identity, options);
  })();
}

// The child's ownership columns through the pipeline a direct Assign uses (dataverse-records.mjs systemColumns ->
// principals.systemColumns -> ownerColumns): ownerid, owninguser or owningteam, owningbusinessunit (the new owner's business
// unit) on a user-owned table, plus modifiedby/modifiedonbehalfby. A host without api.principals writes ownerid only.
function ownershipOptions(api, c, newOwner) {
  if (!api.principals || !c.user) return {};
  const owner = { id: refId(newOwner), logical_name: newOwner?.logical_name ?? 'systemuser' };
  return {
    systemColumns: (mapping) =>
      api.principals.systemColumns({ user: c.user, caller: c.caller, mapping, owner, create: false }),
  };
}

/** install(api, { diagnostic }): diagnostic receives each diagnostic once. Exposes api.cascades = { diagnostics() }. */
function install(api, { diagnostic } = {}) {
  const state = stateOf(api);
  state.reporter = onceReporter(diagnostic ?? api.diagnostic ?? null);
  api.cascades = { diagnostics: () => [...state.reporter.diagnostics] };
  api.recordHooks.add('beforeWrite', (c, mapping, { operation, existing }) => {
    if ((operation !== 'update' && operation !== 'upsert') || !existing) return;
    if (!state.previousOwner.has(c)) state.previousOwner.set(c, new Map());
    state.previousOwner
      .get(c)
      .set(keyOf(mapping.logicalName, existing[mapping.idColumn]), refId(existing.ownerid) ?? null);
  });
  api.recordHooks.add('afterWrite', (c, mapping, { operation, id, sync = false }) => {
    if (operation !== 'update' && operation !== 'upsert') return;
    const key = keyOf(mapping.logicalName, id);
    const owners = state.previousOwner.get(c);
    if (!owners?.has(key)) return;
    const previous = owners.get(key);
    owners.delete(key);
    const rows = api.store.tableRows(mapping.logicalName);
    const row = rows[api.store.rowIndex(mapping, rows, id)] ?? null;
    if (!row || !row.ownerid || sameId(previous, refId(row.ownerid))) return;
    return cascadeAssign(
      api,
      assignChildren(
        api,
        state,
        c,
        { logicalName: mapping.logicalName, idColumn: mapping.idColumn, row },
        previous,
        row.ownerid,
        new Set([key]),
      ),
      sync,
    );
  });
  scanDeclared(api, state);
}

function reset(api) {
  const state = stateOf(api);
  state.reporter.clear();
  state.previousOwner = new WeakMap();
  scanDeclared(api, state);
}

/** Capability record. Module level is behaviour because Assign executes; operationLevels is per operation. */
function describe() {
  return {
    name: 'dataverse-cascade',
    version: 1,
    kind: 'dataverse-extension',
    level: 'behaviour',
    operations: OPERATIONS,
    operationLevels: OPERATION_LEVELS,
    requires: ['metadata:relationship cascade'],
    principal: 'platform',
    stateOwner: 'none',
    lifecycle: 'per-request',
    seams: SEAMS,
  };
}

export const EXTENSION = { name: 'dataverse-cascade', install, reset, describe };
