// Virtual tables with external providers in the Dataverse API: reads and writes of a virtual table go to its provider, and the
// local row is its mirror.
//
// A table is virtual when its mapping says so (isVirtual, tableType "Virtual" or a dataSourceId, the markers the Solution and
// metadata readers set) or when install() declares it in virtualTables. Its provider is virtualTableProviders[dataSourceId]
// or, failing that, virtualTableProviders[table]. With a provider, beforeWrite only checks and queues the write; the matching
// operation is called in the records 'external' stage (Learn custom-ve-data-providers: the provider is the main operation,
// stage 30), after the store write passed every check (If-Match, alternate keys, required columns, business rules, store
// plug-ins) and inside the same transaction, and the stored row mirrors the provider's returned row:
//   create (and an upsert that creates)  -> provider.create(row, ctx)        the returned row must carry the primary key
//   update (and an upsert that updates)  -> provider.update(id, patch, ctx)  a returned row is merged into the mirror
//   delete                               -> provider.delete(id, ctx)         the mirror row is removed by the write itself
// A provider that throws fails the write with 400 (VIRTUAL_PROVIDER_FAILED diagnostic) and the local write rolls back. A
// write refused locally (412, 400, a refusing hook) never reaches the provider. A provider
// without the matching operation refuses the write with 501 (VIRTUAL_PROVIDER_OPERATION_MISSING): nothing is written
// locally.
//
// Reads go to the provider through the 'source' record hook (dataverse-records.mjs), which runs before a Web API read answers:
//   collection, $count and navigation reads -> provider.retrieveMultiple({ select, filter, orderby, top }, ctx)
//   a single record, property or $value      -> provider.retrieve(id, ctx) (null: the row does not exist)
// The request carries the caller's $select, $filter and $orderby text and $top as a number (null when absent). The answer
// replaces the table's mirror rows (a row the provider returned merges over its mirror row) without running write hooks, and
// the read then answers through the shared read path, so $filter, $select, $orderby, paging, $expand, column security and
// masking apply to the provider's rows exactly as to local rows. A provider without the operation answers 501
// (VIRTUAL_PROVIDER_OPERATION_MISSING); a provider that throws answers 400 (VIRTUAL_PROVIDER_FAILED).
//
// Without a provider a virtual table answers every read and write with 501 VirtualProviderMissing (VIRTUAL_PROVIDER_MISSING,
// severity error), unless the project declares virtualTables: { <table>: { fallback: 'local' } } (install option or a pack's
// virtualTables export): then its rows are stored and read locally, VIRTUAL_PROVIDER_LOCAL_FALLBACK reports it once and the
// capability record lists the table under LocalFallback.
// The external events OnExternalCreated/Updated/Deleted stay contract: dataverse-misc-messages.mjs answers them and this module
// registers no step or handler for them.
//
// unverified: the native error code and status of a failed external write (400 VirtualProviderFailed is the module's own shape,
// not checked against Microsoft Learn's virtual table error codes).
// unverified: the native status of a write to a virtual table whose data provider lacks the operation (501 is the module's own).
// ponytail: the mirror takes every column the provider returns, as given; no check that the columns exist on the table.
// ponytail: provider failures are reported once per table and operation; every attempt still fails with 400.
// ponytail: select, filter and orderby reach the provider as OData text, unparsed. Every collection read refreshes the whole
// mirror with the provider's answer (a provider that applies $top answers one page; later pages page the local mirror);
// pushing a parsed query and provider paging down is the upgrade path. SDK reads (Retrieve, RetrieveMultiple, FetchXML)
// never read the mirror: they go to the provider's optional synchronous retrieveSync(ctx, id) and
// retrieveMultipleSync(ctx, request) (readSync below), else answer 501 SdkVirtualReadUnsupported. Portal reads (store reads
// outside the Web API records layer) read the mirror as the last Web API read or write left it.
//
// Transactions. Learn (custom-ve-data-providers, Plug-in registration): a data provider's plug-ins run in stage 30, "the main
// core transaction stage for the operation"; Learn (scalable-customization-design/database-transactions, Event pipeline:
// platform step): the pipeline's transaction is a SQL transaction committed or aborted with the operation, and ExecuteTransaction
// and a $batch changeset run their requests in one such transaction. A provider joins that transaction through an optional
// transaction contract, all three or none:
//   begin(ctx)     called once per provider and outermost transaction, before its first write in it
//   commit(ctx)    called once that transaction has committed (store onCommit)
//   rollback(ctx)  called when that transaction rolls back for any reason: a provider failure, a local refusal of a later
//                  request of the changeset (412, 400, a plug-in), a failed afterWrite hook (store onRollback)
// ctx is { table, dataSourceId, operation: 'transaction', userId, initiatingUserId }. Each may answer a promise; a synchronous SDK
// write needs a synchronous begin. A rollback or commit failure is VIRTUAL_PROVIDER_TRANSACTION_FAILED (the outcome stands).
// A provider without the contract is not enlisted: its write is made when it is called and stays when the transaction later
// rolls back; VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED names each such row once the rollback happens. The module never calls an
// inverse operation (no platform step does).
// unverified: Learn does not state what happens to an external system's change when the Dataverse transaction rolls back after
// a provider plug-in ran; an external change outside the SQL transaction is taken to persist.
// ponytail: a provider enlists in the outermost transaction; a savepoint rolled back inside it (an inner SDK call a plug-in
// caught) does not roll the provider back (Learn plug-in troubleshooting: a failed data operation in a synchronous plug-in ends
// the whole transaction, so the outermost rollback follows). An asynchronous rollback or commit completes after the response.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { packCheck, registerPackExport } from "./pack-exports.mjs";
import { onceReporter, packOverrides } from "./dataverse-addon-common.mjs";

const TRANSACTION_OPERATIONS = ["begin", "commit", "rollback"];
const PROVIDER_OPERATIONS = ["retrieve", "retrieveMultiple", "retrieveSync", "retrieveMultipleSync", "create", "update", "delete", "createSync", "updateSync", "deleteSync", "describe", ...TRANSACTION_OPERATIONS];
// Capability operation name -> the provider operation that answers it.
const OPERATIONS = [["Create", "create"], ["Update", "update"], ["Delete", "delete"], ["Retrieve", "retrieve"], ["RetrieveMultiple", "retrieveMultiple"]];
const EXTERNAL_EVENTS = ["OnExternalCreated", "OnExternalUpdated", "OnExternalDeleted"];

// Per-API state: one WeakMap entry per installed API. Never module-global mutable state.
const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { providers: new Map(), virtualTables: new Map(), reporter: onceReporter() });
  return states.get(api);
}

const normalKey = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const isRow = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

// Diagnostics: once per code, table and operation, then never again until reset.
const report = (state, entry) => state.reporter.report(entry, `${entry.code}\u0000${entry.table}\u0000${entry.operation ?? ""}`);

/** Validates the pack export 'virtualTableProviders': data source ids or table names mapping to { retrieve?, retrieveMultiple?, create?, update?, delete?, describe? }. Synchronous or async functions only; throws TypeError with the key. */
export function validateVirtualTableProviders(map) {
  if (map === undefined) return {};
  if (!map || typeof map !== "object" || Array.isArray(map)) throw new TypeError("virtualTableProviders must map data source ids or table names to provider objects.");
  const result = {};
  for (const [key, provider] of Object.entries(map)) {
    const name = normalKey(key);
    if (!name) throw new TypeError("virtualTableProviders keys must name a data source or a table.");
    if (!isRow(provider)) throw new TypeError(`virtualTableProviders['${key}'] must be an object of provider operations.`);
    for (const [operation, fn] of Object.entries(provider)) {
      if (!PROVIDER_OPERATIONS.includes(operation)) throw new TypeError(`virtualTableProviders['${key}'] has an unknown operation '${operation}'.`);
      if (typeof fn !== "function") throw new TypeError(`virtualTableProviders['${key}'].${operation} must be a function.`);
    }
    const declared = TRANSACTION_OPERATIONS.filter((operation) => operation in provider);
    if (declared.length && declared.length !== TRANSACTION_OPERATIONS.length)
      throw new TypeError(`virtualTableProviders['${key}'] declares ${declared.join(", ")}; a transaction contract needs begin, commit and rollback.`);
    result[name] = { ...provider };
  }
  return result;
}

/** Validates virtualTables declarations (install option or pack export): { '<table>': { dataSourceId?: string, fallback?: 'local' } }. */
export function validateVirtualTables(map) {
  if (map === undefined) return {};
  if (!isRow(map)) throw new TypeError("virtualTables must map table names to { dataSourceId?, fallback? }.");
  for (const [table, declaration] of Object.entries(map)) {
    if (!isRow(declaration) || (declaration.dataSourceId !== undefined && typeof declaration.dataSourceId !== "string")
      || (declaration.fallback !== undefined && declaration.fallback !== "local")
      || Object.keys(declaration).some((name) => name !== "dataSourceId" && name !== "fallback"))
      throw new TypeError(`virtualTables['${table}'] must be { dataSourceId?: string, fallback?: 'local' }.`);
  }
  return map;
}

function normalizeVirtualTables(map) {
  const result = new Map();
  for (const [table, declaration] of Object.entries(validateVirtualTables(map))) {
    result.set(normalKey(table), { dataSourceId: declaration.dataSourceId ? normalKey(declaration.dataSourceId) : null, fallback: declaration.fallback === "local" });
  }
  return result;
}

// The table's virtual status and provider. The mapping markers are the ones dataverse-records.mjs and dataverse-misc-messages.mjs read.
function resolveTable(state, mapping) {
  const table = normalKey(mapping.logicalName);
  const declared = state.virtualTables.get(table);
  // The Solution reader stores the id under dataverseMetadata.DataSourceId (solution-data.mjs); metadata captures set mapping.dataSourceId.
  const sourceId = mapping.dataSourceId ?? mapping.dataverseMetadata?.DataSourceId;
  const dataSourceId = declared?.dataSourceId ?? (sourceId ? normalKey(sourceId) : null);
  // The source-backed management adapter already supplies these records and
  // commits their sparse overlays transactionally. Enhanced portal metadata
  // still describes them as virtual, but they do not need an external provider.
  const virtual = mapping.modelDrivenSource !== true && Boolean(declared || mapping.isVirtual || mapping.tableType === "Virtual" || dataSourceId);
  const provider = virtual ? (state.providers.get(dataSourceId) ?? state.providers.get(table) ?? null) : null;
  return { table, dataSourceId, virtual, provider, fallback: declared?.fallback === true };
}

// A virtual table without a provider: 501 unless the project declared fallback 'local' (then false: the caller stays local).
function assertProvider(state, resolved) {
  if (resolved.provider) return true;
  if (resolved.fallback) {
    report(state, { code: "VIRTUAL_PROVIDER_LOCAL_FALLBACK", severity: "info", table: resolved.table, message: `Virtual table '${resolved.table}' has no provider; its declared fallback 'local' stores and reads its rows locally.` });
    return false;
  }
  report(state, { code: "VIRTUAL_PROVIDER_MISSING", severity: "error", table: resolved.table, message: `Virtual table '${resolved.table}' has no provider; its reads and writes answer 501 VirtualProviderMissing.` });
  throw new DataError(`Virtual table '${resolved.table}' has no data provider.`, 501, "VirtualProviderMissing");
}

const contextOf = (resolved, operation, c) => ({
  table: resolved.table,
  dataSourceId: resolved.dataSourceId,
  operation,
  userId: c?.user?.systemuserid ?? null,
  initiatingUserId: c?.caller?.systemuserid ?? c?.user?.systemuserid ?? null,
});

// A provider failure: the diagnostic once per table and operation, and the 400 the caller sees on every attempt.
function failed(state, resolved, operation, message) {
  report(state, { code: "VIRTUAL_PROVIDER_FAILED", severity: "error", table: resolved.table, operation, message: `The ${operation} provider of virtual table '${resolved.table}' failed: ${message}` });
  return new DataError(`The provider of virtual table '${resolved.table}' failed the ${operation}: ${message}`, 400, "VirtualProviderFailed");
}

function missingOperation(state, resolved, operation) {
  report(state, { code: "VIRTUAL_PROVIDER_OPERATION_MISSING", table: resolved.table, operation, message: `The provider of virtual table '${resolved.table}' has no ${operation} operation.` });
  return new DataError(`Virtual table '${resolved.table}' has no provider ${operation} operation.`, 501, "VirtualProviderOperationMissing");
}

// Writes queued by beforeWrite per request context until the external stage of the same write sends them. A write that fails
// in between leaves its entry here, unmatched (entries match by table and primary key), until the context is collected.
const pendingWrites = new WeakMap();

// beforeWrite (synchronous, no provider call): refuses a providerless table (501), a missing provider operation (501) and a
// deep-insert child, then queues the write. A create without a primary key gets a local one so the external stage finds its
// row; the provider never sees that generated key. Associate and disassociate change no columns of this row.
// unverified: the native answer to a deep insert of a virtual table row (501 VirtualProviderDeepInsertUnsupported is the module's own).
function writeThrough(state, c, mapping, { operation, data, existing, deep = false }) {
  const resolved = resolveTable(state, mapping);
  if (!resolved.virtual) return undefined;
  const kind = operation === "delete" ? "delete"
    : operation === "create" || (operation === "upsert" && !existing) ? "create"
      : operation === "update" || operation === "upsert" ? "update" : null;
  if (!kind || !assertProvider(state, resolved)) return undefined;
  if (typeof (resolved.provider[kind] ?? resolved.provider[`${kind}Sync`]) !== "function") throw missingOperation(state, resolved, kind);
  if (deep) throw new DataError(`Virtual table '${resolved.table}' rows are created through its provider one request at a time; a deep insert cannot create them.`, 501, "VirtualProviderDeepInsertUnsupported");
  // generated: the local key given to a create without one (false otherwise); an upsert may still replace it with the caller's key.
  const generated = kind === "create" && data[mapping.idColumn] == null && randomUUID();
  if (generated) data[mapping.idColumn] = generated;
  if (!pendingWrites.has(c)) pendingWrites.set(c, []);
  pendingWrites.get(c).push({ resolved, kind, data, existing, generated, table: mapping.logicalName });
  return undefined;
}

// The external stage (dataverse-records.mjs, after the store write passed every check, before afterWrite): the provider
// answers the queued write and the stored row mirrors what it returned. A throw or a rejected promise answers 400
// VirtualProviderFailed and rolls the local write back. In a synchronous SDK write (info.sync) an async provider operation is
// A synchronous SDK write (info.sync) calls only the provider's declared synchronous write operation (createSync, updateSync,
// deleteSync; the same arguments as create, update, delete), as SDK reads call retrieveSync; without it the write answers 501
// SdkAsyncPreOperationUnsupported before any provider call. A declared synchronous operation that answers a promise fails
// the write with 400 VirtualProviderFailed. Web API writes call create/update/delete, else the synchronous operation.
function sendExternal(state, api, c, mapping, info) {
  const queue = pendingWrites.get(c) ?? [];
  const at = queue.findIndex((p) => p.table === mapping.logicalName
    && normalKey(p.kind === "create" ? p.data[mapping.idColumn] : p.existing?.[mapping.idColumn]) === normalKey(info.id));
  if (at < 0) return undefined;
  const [{ resolved, kind, data, existing, generated }] = queue.splice(at, 1);
  const fn = info.sync ? resolved.provider[`${kind}Sync`] : resolved.provider[kind] ?? resolved.provider[`${kind}Sync`];
  if (typeof fn !== "function") throw new DataError(`Virtual table '${resolved.table}' has no synchronous ${kind} operation (${kind}Sync); a synchronous SDK write cannot wait for its provider.`, 501, "SdkAsyncPreOperationUnsupported");
  const id = existing?.[mapping.idColumn] ?? null;
  const ctx = contextOf(resolved, kind, c);
  // A generated key stays local; a key the caller gave (body or upsert URL) reaches the provider and stays the row's key.
  const callerKeyed = kind === "create" && data[mapping.idColumn] !== generated;
  const payload = kind === "create" ? createPayload(api, mapping, data, info.id) : { ...data };
  if (kind === "create" && !callerKeyed) delete payload[mapping.idColumn];
  // The provider writes inside the operation's transaction (header: Transactions): an enlisted provider is rolled back with it;
  // a provider without the contract keeps its write, and the rollback names the row (VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED).
  const write = () => {
    let answer;
    try {
      answer = kind === "create" ? fn(payload, ctx) : kind === "update" ? fn(id, payload, ctx) : fn(id, ctx);
    } catch (error) {
      throw failed(state, resolved, kind, messageOf(error));
    }
    if (!transactional(resolved.provider)) api.store.onRollback(() => uncompensated(state, resolved, kind, info.id, "its provider declares no transaction contract (begin, commit, rollback)"));
    const done = (returned) => mirrorWrite(state, api, resolved, mapping, kind, returned, info, callerKeyed);
    if (typeof answer?.then !== "function") return done(answer);
    if (info.sync) {
      answer.then(undefined, () => {});
      throw failed(state, resolved, kind, `its ${kind}Sync operation answered a promise`);
    }
    return answer.then(done, (error) => { throw failed(state, resolved, kind, messageOf(error)); });
  };
  const begun = enlist(state, api, resolved, c, info.sync);
  return begun ? begun.then(write) : write();
}

// A create's payload: a nested single-valued navigation object (a deep-inserted standard parent) is passed as the reference
// the store created for it ({ id, logical_name, name }) under its lookup column.
function createPayload(api, mapping, data, id) {
  const payload = { ...data };
  const row = (api.store.state.tables[mapping.logicalName] ?? []).find((item) => normalKey(item[mapping.idColumn]) === normalKey(id));
  for (const [key, value] of Object.entries(data)) {
    const rel = mapping.relationships?.[key];
    if (!rel || rel.many !== false || !isRow(value) || ("id" in value && "logical_name" in value)) continue;
    delete payload[key];
    payload[rel.from] = row?.[rel.from] ?? null;
  }
  return payload;
}

// The transaction contract (header): a provider with begin/commit/rollback enlists once per outermost store transaction; its
// commit and rollback run from the store's onCommit and onRollback notes. null when nothing is awaited, else begin's promise.
const enlisted = new WeakMap();
const transactional = (provider) => typeof provider?.begin === "function";
function enlist(state, api, resolved, c, sync) {
  const { provider } = resolved, store = api.store;
  if (!transactional(provider) || !store.inTransaction?.()) return null;
  let root = store.pluginRollbackBoundary;
  while (root?.parent) root = root.parent;
  if (!root) return null;
  if (!enlisted.has(root)) enlisted.set(root, new Set());
  const providers = enlisted.get(root);
  if (providers.has(provider)) return null;
  providers.add(provider);
  const ctx = contextOf(resolved, "transaction", c);
  const joined = () => {
    store.onRollback(() => finish(state, resolved, "rollback", ctx));
    store.onCommit(() => finish(state, resolved, "commit", ctx));
  };
  const refuse = (message) => { providers.delete(provider); return failed(state, resolved, "begin", message); };
  let answer;
  try {
    answer = provider.begin(ctx);
  } catch (error) {
    throw refuse(messageOf(error));
  }
  if (typeof answer?.then !== "function") { joined(); return null; }
  if (sync) {
    answer.then(undefined, () => {});
    throw refuse("its begin answered a promise; a synchronous SDK write cannot wait for it");
  }
  return answer.then(joined, (error) => { throw refuse(messageOf(error)); });
}
// commit or rollback of an enlisted provider: the transaction's outcome stands; a failure is reported, never thrown.
function finish(state, resolved, step, ctx) {
  const reportFailure = (error) => state.reporter.report({ code: "VIRTUAL_PROVIDER_TRANSACTION_FAILED", severity: "error", table: resolved.table, operation: step,
    message: `The ${step} of the provider of virtual table '${resolved.table}' failed: ${messageOf(error)}` }, `TRANSACTION_FAILED:${resolved.table}:${step}`);
  try {
    const answer = resolved.provider[step](ctx);
    if (typeof answer?.then === "function") answer.then(undefined, reportFailure);
  } catch (error) {
    reportFailure(error);
  }
}
function uncompensated(state, resolved, kind, id, reason) {
  state.reporter.report({ code: "VIRTUAL_PROVIDER_EFFECT_UNCOMPENSATED", severity: "error", table: resolved.table, operation: kind, id,
    message: `The ${kind} of row ${id} in virtual table '${resolved.table}' stays at its provider although the local write rolled back: ${reason}.` }, `UNCOMPENSATED:${resolved.table}:${id}:${kind}`);
}

// ponytail: the provider's columns (and a create's provider-assigned primary key) are merged into the stored row in place,
// after the store's own post-operation plug-ins saw the local row; the afterWrite hooks see the merged row and info.id.
// A caller-keyed create keeps the caller's key.
function mirrorWrite(state, api, resolved, mapping, kind, returned, info, callerKeyed = false) {
  if (kind === "delete") return undefined;
  if (returned === undefined || returned === null) {
    if (kind === "create") throw failed(state, resolved, kind, "it returned no row");
    return; // an update may return nothing: the mirror keeps the requested patch
  }
  if (!isRow(returned)) throw failed(state, resolved, kind, "it did not return a row");
  if (kind === "create" && !callerKeyed && returned[mapping.idColumn] == null) throw failed(state, resolved, kind, `the returned row has no ${mapping.idColumn}`);
  let mirror;
  try {
    mirror = structuredClone(returned);
  } catch (error) {
    throw failed(state, resolved, kind, `the returned row cannot be copied: ${messageOf(error)}`);
  }
  if (kind === "update" || callerKeyed) delete mirror[mapping.idColumn];
  const rows = api.store.state.tables[mapping.logicalName] ?? [];
  const index = rows.findIndex((item) => normalKey(item[mapping.idColumn]) === normalKey(info.id));
  if (index < 0) return undefined;
  // The store's row primitive: journaled with the transaction and keeps the row key indexes current (a re-keyed create).
  api.store.mutateRow(mapping.logicalName, rows, index, mirror);
  info.id = rows[index][mapping.idColumn];
}

// The provider read: rows (an array) for retrieveMultiple, one row or null for retrieve. Throws 501/400 as the writes do.
async function providerRead(state, resolved, kind, argument, c) {
  const fn = resolved.provider[kind];
  if (typeof fn !== "function") throw missingOperation(state, resolved, kind);
  try {
    const answer = await fn(argument, contextOf(resolved, kind, c));
    if (kind === "retrieveMultiple" && (!Array.isArray(answer) || !answer.every(isRow))) throw new Error("it did not return an array of rows");
    if (kind === "retrieve" && answer != null && !isRow(answer)) throw new Error("it did not return a row");
    return structuredClone(answer ?? null);
  } catch (error) {
    throw failed(state, resolved, kind, messageOf(error));
  }
}

// The documented request shape: OData text for select, filter and orderby, top as a number; null when absent.
const requestOf = (params) => {
  const text = (name) => params?.get(name) ?? null;
  const top = text("$top");
  return { select: text("$select"), filter: text("$filter"), orderby: text("$orderby"), top: top == null ? null : Number(top) };
};

// Replaces the mirror (all rows for a collection answer, the one row for a single answer) in one store write, without write hooks.
async function mirror(api, mapping, rows, { id = null } = {}) {
  const logical = mapping.logicalName, idColumn = mapping.idColumn;
  const keyOf = (row) => normalKey(row?.[idColumn]);
  await api.change(() => api.store.transact(() => {
    const current = api.store.state.tables[logical] ?? [];
    const byId = new Map(current.map((row) => [keyOf(row), row]));
    const merged = rows.filter((row) => row[idColumn] != null).map((row) => ({ ...(byId.get(keyOf(row)) ?? {}), ...row }));
    api.store.state.tables[logical] = id == null ? merged : [...current.filter((row) => keyOf(row) !== normalKey(id)), ...merged];
  }));
}

// The 'source' record hook: a read of a virtual table refreshes its mirror from the provider first.
async function readThrough(state, api, c, mapping, { single = false, id = null } = {}) {
  const resolved = resolveTable(state, mapping);
  if (!resolved.virtual || !assertProvider(state, resolved)) return;
  if (single && id != null) {
    const row = await providerRead(state, resolved, "retrieve", id, c);
    if (row && row[mapping.idColumn] == null) row[mapping.idColumn] = id;
    await mirror(api, mapping, row ? [row] : [], { id });
    return;
  }
  // A single read by alternate key asks for every row: the key is matched locally against the refreshed mirror.
  await mirror(api, mapping, await providerRead(state, resolved, "retrieveMultiple", requestOf(single ? null : c?.url?.searchParams), c));
}

// Synchronous reads for callers that cannot await (the SDK IOrganizationService inside the store's synchronous plug-in
// pipeline, records.readInternal): null when the table is read locally (not virtual, or a declared fallback 'local');
// 501 VirtualProviderMissing without a provider; otherwise { rows } from the provider's optional synchronous operations
// retrieveSync(ctx, id) (one row or null) and retrieveMultipleSync(ctx, { select, filter, orderby, top }) (an array of
// rows). A provider without the synchronous operation, a promise answer, or a FetchXML read (fetchXml: no request shape
// carries it) answers 501 SdkVirtualReadUnsupported. The mirror is never read or written here.
function readSync(state, resolved, c, { single = false, id = null, request = null, fetchXml = false } = {}) {
  if (!resolved.virtual || !assertProvider(state, resolved)) return null;
  const kind = single ? "retrieveSync" : "retrieveMultipleSync";
  const fn = fetchXml ? null : resolved.provider[kind];
  if (typeof fn !== "function") {
    throw new DataError(`Virtual table '${resolved.table}' is read through its provider; a synchronous SDK ${fetchXml ? "FetchXML read" : single ? "Retrieve" : "RetrieveMultiple"} needs the provider's ${fetchXml ? "Web API route" : kind} operation.`, 501, "SdkVirtualReadUnsupported");
  }
  let answer;
  try {
    answer = single ? fn(contextOf(resolved, "retrieve", c), id) : fn(contextOf(resolved, "retrieveMultiple", c), { select: null, filter: null, orderby: null, top: null, ...request });
  } catch (error) {
    throw failed(state, resolved, kind, messageOf(error));
  }
  if (typeof answer?.then === "function") {
    answer.catch(() => {});
    throw new DataError(`The ${kind} operation of virtual table '${resolved.table}' answered a promise; a synchronous SDK read cannot wait for it.`, 501, "SdkVirtualReadUnsupported");
  }
  const rows = single ? (answer == null ? [] : [answer]) : answer;
  if (!Array.isArray(rows) || !rows.every(isRow)) throw failed(state, resolved, kind, single ? "it did not return a row" : "it did not return an array of rows");
  return { rows: structuredClone(rows) };
}

// api.virtualProviders.query: the provider's rows for a request { select, filter, orderby, top }, or null without a provider
// operation to ask (a table that is not virtual, a declared local fallback, or no retrieveMultiple).
async function query(state, api, table, request = {}) {
  const resolved = resolveTable(state, api.store.state.mappings?.[normalKey(table)] ?? { logicalName: normalKey(table) });
  if (!resolved.virtual || !assertProvider(state, resolved) || typeof resolved.provider.retrieveMultiple !== "function") return null;
  const { select = null, filter = null, orderby = null, top = null } = request;
  return providerRead(state, resolved, "retrieveMultiple", { select, filter, orderby, top }, null);
}

/**
 * install(api, { virtualTableProviders, virtualTables, diagnostic }): the pack export (validateVirtualTableProviders), the
 * declarations (install option, else the packs' virtualTables export) and the diagnostic sink (called once per diagnostic).
 * Exposes api.virtualProviders = { for(table), query(table, { select, filter, orderby, top }), describe(table), diagnostics() }.
 */
function install(api, options = {}) {
  const state = stateOf(api);
  state.providers = new Map(Object.entries(validateVirtualTableProviders(options.virtualTableProviders ?? packOverrides(api, "virtualTableProviders"))));
  state.virtualTables = normalizeVirtualTables(options.virtualTables ?? packOverrides(api, "virtualTables") ?? undefined);
  state.reporter = onceReporter(options.diagnostic ?? api.diagnostic ?? null);
  const resolve = (table) => resolveTable(state, api.store.state.mappings?.[normalKey(table)] ?? { logicalName: normalKey(table) });
  api.virtualProviders = {
    for: (table) => resolve(table).provider,
    query: (table, options) => query(state, api, table, options),
    describe: (table) => {
      const provider = resolve(table).provider;
      return typeof provider?.describe === "function" ? provider.describe() : null;
    },
    // Synchronous: { virtual, provider, fallback } of a table, for callers that decide before reading.
    status: (table) => {
      const resolved = resolve(table);
      return { virtual: resolved.virtual, provider: Boolean(resolved.provider), fallback: resolved.fallback };
    },
    readSync: (c, table, options) => readSync(state, resolve(table), c, options),
    diagnostics: () => [...state.reporter.diagnostics],
  };
  // The SDK service and records.readInternal reach the synchronous reads through the store's record pipeline.
  if (api.records) api.records.virtualProviders = api.virtualProviders;
  api.recordHooks.add("beforeWrite", (c, mapping, info) => writeThrough(state, c, mapping, info), "dataverse-virtual-providers");
  api.recordHooks.add("external", (c, mapping, info) => sendExternal(state, api, c, mapping, info), "dataverse-virtual-providers");
  api.recordHooks.add("source", (c, mapping, info) => readThrough(state, api, c, mapping, info), "dataverse-virtual-providers");
}

function reset(api) {
  const state = stateOf(api);
  state.reporter.clear();
}

/**
 * Capability record. describe(api) reports what this runtime registered: an operation is behaviour when a registered provider
 * implements it, else contract; declared local fallbacks are listed under LocalFallback (contract, the tables as its reason).
 * External events stay contract. describe() without an api reports the module with no provider registered.
 */
function describe(api) {
  const state = api ? states.get(api) : null;
  const providers = [...(state?.providers.values() ?? [])];
  const operations = OPERATIONS.map(([name, operation]) => ({ name, level: providers.some((provider) => typeof (provider[operation] ?? provider[`${operation}Sync`]) === "function") ? "behaviour" : "contract" }));
  const fallbacks = [...(state?.virtualTables ?? [])].filter(([, declaration]) => declaration.fallback).map(([table]) => table);
  if (fallbacks.length) operations.push({ name: "LocalFallback", level: "contract", reason: `fallback 'local' declared for ${fallbacks.join(", ")}` });
  // Transaction enlistment: behaviour when a registered provider declares begin/commit/rollback.
  operations.push({ name: "TransactionEnlistment", level: providers.some(transactional) ? "behaviour" : "contract" });
  return {
    name: "dataverse-virtual-providers",
    version: 1,
    kind: "dataverse-extension",
    level: operations.some((operation) => operation.level === "behaviour") ? "behaviour" : "contract",
    operations: [...operations, ...EXTERNAL_EVENTS.map((name) => ({ name, level: "contract" }))],
    requires: ["pack:virtualTableProviders"],
    principal: "caller",
    stateOwner: "store",
    lifecycle: "per-request",
  };
}

export const EXTENSION = { name: "dataverse-virtual-providers", install, reset, describe };

registerPackExport("virtualTableProviders", { key: normalKey, check: packCheck(validateVirtualTableProviders) });
registerPackExport("virtualTables", { key: normalKey, check: packCheck(validateVirtualTables) });
