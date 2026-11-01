// Cascade actions of one-to-many relationships in the Dataverse API: Assign and Reparent run here; Share and Unshare run in
// dataverse-security.mjs (grantAccessNow, revokeAccessNow); Merge moves the subordinate's children in
// dataverse-record-messages.mjs (mergeRows).
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
// Reparent: when an update changes a row's lookup to its parent through a relationship whose Reparent cascades, the row
// inherits the new parent's access (dataverse-security.mjs reparentAccess), and so do its own cascading children.
// Assumption: a child's own Assign cascade also runs for grandchildren (the recursion follows the parental model).
// UserOwned means "owned by the same user as the primary row"; after the write that row has the new owner, so the owner
// from before the write is compared.
// A cascaded child takes the same ownership columns a direct Assign writes (ownershipOptions).
// ponytail: active workflows and business rules on reassigned rows are not deactivated (natively they are); add when a
// test reads them.
import { onceReporter } from './dataverse-addon-common.mjs';
import { reparentAccess } from './dataverse-security.mjs';

const ASSIGN_BEHAVIOURS = new Set(['Cascade', 'Active', 'UserOwned']);
const CASCADING = new Set(['Cascade', 'Active', 'UserOwned']);
const OPERATIONS = ['CascadeAssign', 'CascadeShare', 'CascadeUnshare', 'CascadeReparent', 'CascadeMerge'];
const OPERATION_LEVELS = Object.fromEntries(OPERATIONS.map((operation) => [operation, 'behaviour']));

const bare = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const sameId = (a, b) => a != null && b != null && bare(a) === bare(b);
const keyOf = (logical, id) => `${logical}\u0000${bare(id)}`;

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api))
    states.set(api, { reporter: onceReporter(), previousOwner: new WeakMap(), previousParents: new WeakMap() });
  return states.get(api);
}

function report(
  state,
  entry,
  key = `${entry.code}\u0000${entry.table}\u0000${entry.referencing ?? ''}\u0000${entry.column ?? ''}`,
) {
  state.reporter.report(entry, key);
}

// The parents a row of `logical` references through relationships whose Reparent cascades: [{ parent, column }].
// ponytail: scans every relationship per updated row; cache per mapping revision if updates get hot.
function reparentParents(api, logical) {
  const parents = [];
  for (const [parent, references] of api.store.referencesByTable({ admin: true }))
    for (const reference of references)
      if (reference.entity === logical && CASCADING.has(reference.cascade?.reparent))
        parents.push({ parent, column: reference.column });
  return parents;
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
// endpoint step posts in process instead of on the synchronous I/O bridge. done(rows) receives the count of child writes.
function cascadeAssign(api, writes, sync, done) {
  let rows = 0;
  if (sync) {
    for (const [table, id, values, identity, options] of writes) {
      api.store.updateRecord(table, id, values, identity, options);
      rows += 1;
    }
    done(rows);
    return undefined;
  }
  return (async () => {
    for (const [table, id, values, identity, options] of writes) {
      await api.store.updateRecordAsync(table, id, values, identity, options);
      rows += 1;
    }
    done(rows);
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
    const parents = reparentParents(api, mapping.logicalName);
    if (!parents.length) return;
    if (!state.previousParents.has(c)) state.previousParents.set(c, new Map());
    state.previousParents.get(c).set(
      keyOf(mapping.logicalName, existing[mapping.idColumn]),
      parents.map((entry) => ({ ...entry, id: refId(existing[entry.column]) ?? null })),
    );
  });
  // Reparent: a changed parental lookup gives the row (and its cascading children) the new parent's access.
  api.recordHooks.add('afterWrite', (c, mapping, { operation, id }) => {
    if (operation !== 'update' && operation !== 'upsert') return;
    const key = keyOf(mapping.logicalName, id),
      before = state.previousParents.get(c)?.get(key);
    if (!before) return;
    state.previousParents.get(c).delete(key);
    const rows = api.store.tableRows(mapping.logicalName);
    const row = rows[api.store.rowIndex(mapping, rows, id)] ?? null;
    if (!row) return;
    for (const { parent, column, id: previous } of before) {
      const next = row[column];
      if (sameId(refId(next), previous) || (refId(next) == null && previous == null)) continue;
      if (next && typeof next === 'object' && next.logical_name && next.logical_name !== parent) continue;
      reparentAccess(
        api.store,
        { logical: mapping.logicalName, id: row[mapping.idColumn] },
        refId(next) == null ? null : { logical: parent, id: refId(next) },
      );
    }
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
    // Tracing: one cascade event on the assigning write's span when children were reassigned (their writes nest under it).
    const span = api.store.traces?.enabled ? api.store.traces.current() : null;
    const done = (count) =>
      count &&
      span?.event('cascade', {
        attributes: {
          action: 'assign',
          table: mapping.logicalName,
          recordId: String(id),
          rows: count,
          previousOwner: previous ?? null,
          owner: refId(row.ownerid) ?? null,
        },
      });
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
      done,
    );
  });
}

function reset(api) {
  const state = stateOf(api);
  state.reporter.clear();
  state.previousOwner = new WeakMap();
  state.previousParents = new WeakMap();
}

/** Capability record: every cascade action executes; operationLevels is per operation. */
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
  };
}

export const EXTENSION = { name: 'dataverse-cascade', install, reset, describe };
