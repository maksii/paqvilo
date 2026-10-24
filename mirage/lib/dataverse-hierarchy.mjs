// Record hierarchy in the Dataverse API: the records under or above a record through a table's self-referencing lookup,
// the sets that the hierarchy operators (under, eq-or-under, above, eq-or-above, not-under) select.
//
// A table is hierarchical when a one-to-many relationship references the table from itself and carries IsHierarchical:
// the metadata relationship record (the mapping relationship's `hierarchical: true`, or the solution's IsHierarchical) is read
// through the metadata service. install(api, { hierarchies: { '<table>': '<lookup column>' } }) names a table explicitly and
// wins over the metadata flag.
// Behaviour: api.hierarchy.resolve(table, rootId, direction) walks the lookup breadth first over the table's rows and returns
// the matching record ids (lowercase, no braces), or null when the table is not hierarchical or has no mapping.
// Contract: the FetchXML and OData query operators (QUERY_OPERATORS) are behaviour only once the organization runtime wires them
// and sets api.hierarchyQueryWired = true; until then describe() lists them at contract.
// Diagnostics: HIERARCHY_DEPTH_EXCEEDED once per table when a walk stops at maxDepth; HIERARCHY_CYCLE once per table when a
// lookup loops back to a visited record.
// Not known: the native depth limit of a hierarchy walk and its error (the 100 default is a local bound), and the native
// answer for a cyclic hierarchy (the local walk stops at the repeated record and reports HIERARCHY_CYCLE).
// ponytail: each resolution rescans the table's rows and the relationship records; cache the parent index by store revision when a
// hot query path needs it.
import { createMetadataService } from "./dataverse-metadata.mjs";
import { guidKey } from "./dataverse-values.mjs";
import { packCheck, registerPackExport } from "./pack-exports.mjs";
import { onceReporter, packOverrides } from "./dataverse-addon-common.mjs";

const DIRECTIONS = ["under", "eq-or-under", "above", "eq-or-above"];
const QUERY_OPERATORS = ["under", "eq-or-under", "above", "eq-or-above", "not-under"];
const DEFAULT_MAX_DEPTH = 100; // ponytail: local bound; the native limit is not known (see above).
const NAME = /^[a-z_][a-z0-9_]*$/i;

const refId = (value) => (value !== null && typeof value === "object" ? value.id : value);
const lookupKey = (value) => guidKey(refId(value));

/** Validates the pack export 'hierarchies': { '<table>': '<lookup column>' }. Returns lowercase names; throws TypeError on a bad entry. */
export function validateHierarchies(map) {
  if (map === undefined) return {};
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new TypeError("hierarchies must map table names to lookup columns.");
  const result = {};
  for (const [table, column] of Object.entries(map)) {
    if (!NAME.test(table)) throw new TypeError(`hierarchies key '${table}' must be a logical table name.`);
    if (typeof column !== "string" || !NAME.test(column)) throw new TypeError(`hierarchies['${table}'] must name a lookup column.`);
    result[table.toLowerCase()] = column.toLowerCase();
  }
  return result;
}

/**
 * The record ids of `table` that `direction` selects from `rootId` through the self-lookup `column`, as a Set of lowercase
 * GUIDs. Breadth first, each record visited once. A lookup that reaches a visited record is a loop: the walk does not follow
 * it and reports HIERARCHY_CYCLE once. A walk that would pass maxDepth stops and reports HIERARCHY_DEPTH_EXCEEDED once.
 * Diagnostics go to the optional diagnostic(entry) callback. A root that is not a row of the table yields an empty set.
 * Lookup values may be { id } objects or bare GUIDs; a null or unreadable lookup ends the branch.
 */
export function resolveHierarchy(store, table, column, rootId, direction, { maxDepth = DEFAULT_MAX_DEPTH, diagnostic = null } = {}) {
  if (!DIRECTIONS.includes(direction)) throw new TypeError(`Unknown hierarchy direction '${direction}'.`);
  if (!Number.isInteger(maxDepth) || maxDepth < 0) throw new TypeError("maxDepth must be a non-negative integer.");
  const logical = String(table).toLowerCase();
  const lookup = String(column).toLowerCase();
  const idColumn = store.state.mappings?.[logical]?.idColumn;
  const parents = new Map();
  for (const row of store.tableRows(logical)) {
    const id = guidKey(row[idColumn]);
    if (id) parents.set(id, lookupKey(row[lookup]));
  }
  const root = guidKey(rootId);
  const result = new Set();
  if (!root || !parents.has(root)) return result;

  const down = direction.endsWith("under");
  const children = new Map();
  if (down) {
    for (const [id, parent] of parents) {
      if (parent === null || !parents.has(parent)) continue;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(id);
    }
  }
  const neighbours = (id) => (down ? children.get(id) ?? [] : [parents.get(id)].filter((parent) => parent && parents.has(parent)));

  if (direction.startsWith("eq-or")) result.add(root);
  const seen = new Set([root]);
  let cycle = false;
  let depth = 0;
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      for (const neighbour of neighbours(id)) {
        if (seen.has(neighbour)) {
          cycle = true;
          continue;
        }
        seen.add(neighbour);
        next.push(neighbour);
      }
    }
    if (!next.length) break;
    depth += 1;
    if (depth > maxDepth) {
      diagnostic?.({
        code: "HIERARCHY_DEPTH_EXCEEDED", table: logical, column: lookup, rootId: root, direction, maxDepth,
        message: `The ${direction} walk on '${logical}' stopped at depth ${maxDepth}; records deeper than that are not returned.`,
      });
      break;
    }
    for (const id of next) result.add(id);
    frontier = next;
  }
  if (cycle) diagnostic?.({
    code: "HIERARCHY_CYCLE", table: logical, column: lookup, rootId: root, direction,
    message: `The '${lookup}' lookup of '${logical}' forms a loop; the ${direction} walk stopped at the repeated record.`,
  });
  return result;
}

// ---- Extension

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { explicit: {}, reporter: onceReporter() });
  return states.get(api);
}

// Diagnostics: once per key (code, table, column), then never again until reset.
const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.column ?? ""}`);

// The lookup column of a table's hierarchy: the explicit map first, else a self-referencing 1:N relationship marked IsHierarchical.
function hierarchyOf(api, state, table) {
  const logical = String(table ?? "").toLowerCase();
  if (state.explicit[logical]) return { column: state.explicit[logical] };
  const service = createMetadataService({ organizationId: api.settings.organizationId, schema: api.schema ?? null, mappings: () => api.store.state.mappings });
  const flagged = service.oneToMany(logical).find((r) => r.IsHierarchical === true && r.ReferencingEntity === logical && r.ReferencedEntity === logical);
  return flagged ? { column: String(flagged.ReferencingAttribute).toLowerCase() } : null;
}

function resolveFor(api, state, table, rootId, direction) {
  const logical = String(table ?? "").toLowerCase();
  const hierarchy = hierarchyOf(api, state, logical);
  if (!hierarchy || !api.store.state.mappings?.[logical]) return null;
  return resolveHierarchy(api.store, logical, hierarchy.column, rootId, direction, { diagnostic: (entry) => report(state, entry) });
}

/**
 * install(api, options): options.hierarchies (else the pack export, validateHierarchies); options.diagnostic (else api.diagnostic)
 * receives each diagnostic once. Exposes api.hierarchy = { isHierarchical(table), resolve(table, rootId, direction), diagnostics(), describe() }.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.explicit = validateHierarchies(options.hierarchies ?? packOverrides(api, "hierarchies"));
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  api.hierarchy = {
    isHierarchical: (table) => hierarchyOf(api, state, table),
    resolve: (table, rootId, direction) => resolveFor(api, state, table, rootId, direction),
    diagnostics: () => [...state.reporter.diagnostics],
    describe: () => describe(api),
  };
}

// Reseed: the once-per-key diagnostics start again (the metadata may have changed).
function reset(api) {
  stateOf(api).reporter.clear();
}

/**
 * Capability record. The resolver directions are behaviour. The query operators are behaviour only when the
 * installed api.hierarchyQueryWired is true (set by the organization runtime after it wires them), else contract.
 */
function describe(api = null) {
  const wired = api?.hierarchyQueryWired === true;
  return {
    name: "dataverse-hierarchy",
    version: 1,
    kind: "dataverse-extension",
    level: wired ? "behaviour" : "contract",
    operations: [
      ...DIRECTIONS.map((name) => ({ name: `resolve:${name}`, level: "behaviour" })),
      ...QUERY_OPERATORS.map((name) => ({ name: `query:${name}`, level: wired ? "behaviour" : "contract" })),
    ],
    requires: ["metadata:IsHierarchical"],
    principal: "caller",
    stateOwner: "none",
    lifecycle: "per-request",
  };
}

export const EXTENSION = { name: "dataverse-hierarchy", install, reset, describe };

registerPackExport("hierarchies", { key: (key) => key.toLowerCase(), check: packCheck(validateHierarchies) });
