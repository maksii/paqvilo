// Storage routing for Dataverse bytes. With a storage router (install option `storage`, else api.providers.storage):
// - file and image column bytes live under provider route `dataverseFiles` as files/<fileId>; state.dataverse.files keeps
//   metadata and `key` (dataverse-files.mjs reads and writes through setFileStorage);
// - annotation.documentbody and activitymimeattachment.body move to route `annotations` as annotations/<rowId>/<n> in a
//   beforeWrite hook; the row keeps filename, mimetype, filesize and an internal `__blobkey`, and the project hook reads the
//   bytes back only for responses that carry the column, so Web API and SOAP shapes do not change;
// - provider puts happen before the row commits; released keys are deleted after commit when no committed row (or recycle-bin
//   snapshot) still references them; install and reset migrate inline legacy bytes once and sweep unreferenced objects.
// Without a router bytes stay in state; deleting a row still drops the file entries nothing references.
// - pack DATA rows (simulation/deep, the store's storageAdapter owns the table) keep bodies up to PACK_INLINE_BODY_LIMIT inline
//   (base64, the legacy inline format), so a committed DATA file reads on any machine; larger bodies go to the provider;
// - a referenced object the provider no longer has never fails a read: install/reset report one STORAGE_OBJECTS_MISSING,
//   a row read answers a null body with STORAGE_OBJECT_MISSING (a $value read answers 404 STORAGE_OBJECT_MISSING).
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { assertAttachmentSize } from "./platform-settings.mjs";
import { guidKey } from "./dataverse-values.mjs";
import { binRows } from "./dataverse-data-messages.mjs";
import {
  ATTACHMENT_COLUMNS, blobKeyOf, deferBytes, fileKey, hydrateResponses, readStoredBytes, setFileStorage, storedKeysOf,
} from "./dataverse-files.mjs";

const NAME = "dataverse-storage-routing";
const ROUTES = { files: "dataverseFiles", annotations: "annotations" };
const SNAPSHOTS = "deleteditemreference"; // recycle-bin snapshots stay inline: they hold row JSON, whose bytes are already keys
const ID_COLUMN = { annotation: "annotationid", activitymimeattachment: "activitymimeattachmentid" };
const canonical = (text) => typeof text === "string" && Buffer.from(text, "base64").toString("base64") === text;
const states = new WeakMap();
const requestRows = new WeakMap(); // request context -> logical -> id -> stored row (hydrate)
// ponytail: one fixed threshold (decoded bytes); add a simulation setting when a project needs another size.
export const PACK_INLINE_BODY_LIMIT = 64 * 1024;
const inlineInPack = (api, logical, value) =>
  Boolean(api.store.storageAdapter?.packOwned?.(logical)) && Buffer.byteLength(value, "base64") <= PACK_INLINE_BODY_LIMIT;
const missingObject = (error) => error?.code === "NotFound";

// A referenced object its provider no longer has: one diagnostic per key (entity, id, key; never bytes).
function reportMissing(state, logical, id, key) {
  const message = `The stored body of ${logical} ${id} (key ${key}) is missing from its storage provider.`;
  if (state && !state.missing.has(key)) {
    state.missing.add(key);
    report(state, { severity: "error", code: "STORAGE_OBJECT_MISSING", entity: logical, id, key, message: `${message} Row reads answer a null body.` });
  }
  return message;
}

// Bytes of a referenced key, or null (and STORAGE_OBJECT_MISSING) when the provider no longer has them; strict throws 404.
async function storedBody(api, logical, id, key, { strict = false } = {}) {
  try {
    await states.get(api)?.puts.get(guidKey(id))?.catch(() => {});
    return (await readStoredBytes(api, { key })).toString("base64");
  } catch (error) {
    if (!missingObject(error)) throw error;
    const message = reportMissing(states.get(api), logical, id, key);
    if (strict) throw new DataError(message, 404, "STORAGE_OBJECT_MISSING", { innerCode: "STORAGE_OBJECT_MISSING" });
    return null;
  }
}

function report(state, diagnostic) {
  const entry = { severity: "info", ...diagnostic };
  state.diagnostics.push(entry);
  if (state.diagnostics.length > 50) state.diagnostics.shift();
  state.diagnostic?.(entry);
}

// A router answers per route; one provider (tests, packs) serves both. A route that cannot be served keeps bytes in state.
function routeOf(state, storage, route) {
  if (!storage) return null;
  if (typeof storage.forRoute !== "function") return storage;
  try {
    return storage.forRoute(route);
  } catch (error) {
    report(state, { severity: "warning", code: error.diagnostic ?? "PROVIDER_ROUTE_MISSING", message: `Storage route '${route}' is unavailable; its bytes stay in state. ${error.message}` });
    return null;
  }
}

// Liveness against committed state. A file entry lives while its row's column (or a recycle-bin snapshot of that row) holds it,
// or while it is a temporary file (DeleteFile releases those). A blob lives while its own row or a snapshot holds its key.
function liveness(store) {
  const bins = new Map();
  const bin = (logical) => { if (!bins.has(logical)) bins.set(logical, binRows(store, logical)); return bins.get(logical); };
  const fileLive = (id, entry) => {
    if (entry.entity == null) return true;
    let mapping;
    try { mapping = store.resolveMapping(entry.entity); } catch { return false; }
    const holds = (row) => guidKey(row?.[entry.column]) === id;
    const row = store.tableRows(mapping.logicalName).find((r) => guidKey(r[mapping.idColumn]) === guidKey(entry.recordId));
    return holds(row) || (mapping.logicalName !== SNAPSHOTS && bin(mapping.logicalName).some(holds));
  };
  const blobLive = (key) => Object.keys(ATTACHMENT_COLUMNS).some((logical) =>
    store.tableRows(logical).some((row) => blobKeyOf(logical, row) === key) || bin(logical).some((row) => blobKeyOf(logical, row) === key));
  return { fileLive, blobLive };
}

// Deletes `key` only while its ETag is still `etag`; a changed object (PreconditionFailed) is kept. Answers whether it deleted.
async function deleteUnchanged(state, provider, key, etag, failure) {
  try {
    return Boolean(await provider.delete(key, { ifMatch: etag }));
  } catch (error) {
    if (error?.code !== "PreconditionFailed") report(state, { severity: "warning", code: "STORAGE_DELETE_FAILED", message: `${failure}: ${error.message}` });
    return false;
  }
}

// Marks a key in flight (bytes put, owning row write not settled); the returned function ends this hold once.
function hold(state, key) {
  state.inflight.set(key, (state.inflight.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = state.inflight.get(key) - 1;
    if (count > 0) state.inflight.set(key, count); else state.inflight.delete(key);
  };
}

// Holds a key put by a record write's beforeWrite hook until that write commits or rolls back: a no-op transaction started
// outside the caller's transaction queues behind it.
function holdWrite(api, state, key) {
  const unhold = hold(state, key);
  state.detached(() => api.store.transact(() => {}, { skipSaveIfUnchanged: true, lazyReadSnapshot: true })).catch(() => {}).finally(unhold);
}

// Drops the candidate keys no committed row references: their file entries (in one transaction) and then their provider bytes.
async function flush(api, state) {
  const { store } = api;
  while (state.pending.size) {
    const keys = [...state.pending];
    state.pending.clear();
    const providerOf = (key) => (key.startsWith("files/") ? state.files : state.annotations);
    // Each dead key's ETag is read inside the liveness transaction and the delete is conditional on it: bytes put again under
    // the same key after the check (a re-created note with the same id) change the ETag and are kept. An in-flight key (put,
    // its row not settled yet) is not dead.
    const dead = await api.change(() => store.transact(async () => {
      const files = store.state.dataverse?.files ?? {};
      const { fileLive, blobLive } = liveness(store);
      const found = keys.filter((key) => {
        if (state.inflight.has(key)) return false;
        if (!key.startsWith("files/")) return !blobLive(key);
        const id = key.slice(6), entry = files[id];
        if (entry && fileLive(id, entry)) return false;
        if (entry) delete files[id];
        return true;
      });
      const tagged = [];
      for (const key of found) {
        const head = await providerOf(key)?.head(key).catch(() => null);
        if (head) tagged.push({ key, etag: head.etag ?? "*" });
      }
      return tagged;
    }, { incremental: true, cloneResult: false }));
    for (const { key, etag } of dead) await deleteUnchanged(state, providerOf(key), key, etag, "A released object was not deleted");
  }
}

function released(api, state, keys) {
  for (const key of keys) if (key) state.pending.add(key);
  // Detached from the caller's transaction: the check queues behind it and so sees only committed state.
  state.flushing ??= state.detached(() => flush(api, state))
    .catch((error) => report(state, { severity: "warning", code: "STORAGE_RELEASE_FAILED", message: `Released storage keys were not checked: ${error.message}` }))
    .finally(() => { state.flushing = null; });
  return state.flushing;
}

// Moves inline legacy bytes to the providers once; a second load finds nothing inline. One STORAGE_MIGRATED diagnostic.
async function migrate(api, state) {
  const { store } = api;
  const files = store.state.dataverse?.files ?? {};
  const fileMoves = [], rowMoves = [];
  let bytes = 0;
  if (state.files) for (const [id, entry] of Object.entries(files)) {
    if (entry?.data == null || entry.entity === SNAPSHOTS) continue;
    const body = Buffer.from(String(entry.data), "base64");
    await state.files.put(fileKey(id), body, { contentType: entry.mimeType });
    fileMoves.push({ id, data: entry.data });
    bytes += body.length;
  }
  if (state.annotations) for (const [logical, column] of Object.entries(ATTACHMENT_COLUMNS)) {
    for (const row of store.state.tables[logical] ?? []) {
      const id = guidKey(row[ID_COLUMN[logical]]), value = row[column];
      if (!id || !canonical(value) || inlineInPack(api, logical, value)) continue;
      const previous = blobKeyOf(logical, row);
      const key = `annotations/${id}/${previous ? Number(previous.split("/")[2]) + 1 : 1}`;
      const body = Buffer.from(value, "base64");
      await state.annotations.put(key, body, { contentType: row.mimetype ?? undefined });
      rowMoves.push({ logical, id, value, key, previous });
      bytes += body.length;
    }
  }
  if (!fileMoves.length && !rowMoves.length) return null;
  const counts = { files: 0, annotations: 0, attachments: 0, bytes };
  const replaced = [];
  await store.transact(() => {
    const current = store.state.dataverse?.files ?? {};
    for (const { id, data } of fileMoves) {
      const entry = current[id];
      if (entry?.data !== data) continue;
      entry.key = fileKey(id);
      delete entry.data;
      counts.files += 1;
    }
    for (const { logical, id, value, key, previous } of rowMoves) {
      const column = ATTACHMENT_COLUMNS[logical];
      const row = (store.state.tables[logical] ?? []).find((r) => guidKey(r[ID_COLUMN[logical]]) === id);
      if (row?.[column] !== value) continue;
      row[column] = null;
      row.__blobkey = key;
      if (previous) replaced.push(previous);
      counts[logical === "annotation" ? "annotations" : "attachments"] += 1;
    }
  });
  if (replaced.length) released(api, state, replaced);
  report(state, { code: "STORAGE_MIGRATED", message: `Moved ${counts.files} file(s), ${counts.annotations} note(s) and ${counts.attachments} attachment(s) (${bytes} bytes) from state to storage providers.`, counts });
  return counts;
}

// Removes file entries whose row is gone (bytes of rows deleted before this module ran) and provider objects under files/
// and annotations/ that no entry, row or recycle-bin snapshot references.
// EmptyRecycleBin drops snapshot rows without record events, so the bytes they held wait for this sweep.
// Objects are listed first and judged in one transaction afterwards: an in-flight key (bytes put before their row commits) is
// skipped, and a delete is conditional on the listed ETag, so bytes put again under a listed key are kept.
// With an outbox provider (api.providers.outbox) its sweep runs too; its counts are `outbox`.
async function sweep(api, state) {
  const { store } = api;
  const outboxSweep = api.providers?.outbox?.sweep ? () => api.providers.outbox.sweep() : null;
  const outbox = async (result) => (outboxSweep ? { ...result, outbox: await outboxSweep() } : result);
  if (!state.files && !state.annotations) return outbox({ removed: 0, entries: 0 });
  const listed = [];
  for (const [prefix, provider] of [["files/", state.files], ["annotations/", state.annotations]]) {
    if (!provider) continue;
    let continuation = null;
    do {
      const page = await provider.list(prefix, { continuation });
      for (const item of page.items) listed.push({ provider, key: item.key, etag: item.etag ?? "*" });
      continuation = page.continuation;
    } while (continuation);
  }
  const { entries, stale } = await store.transact(() => {
    const files = store.state.dataverse?.files ?? {};
    const { fileLive } = liveness(store);
    const dead = Object.entries(files).filter(([id, entry]) => entry && !fileLive(id, entry)).map(([id]) => id);
    for (const id of dead) delete files[id];
    const referenced = new Set(Object.values(files).map((entry) => entry?.key).filter(Boolean));
    for (const logical of Object.keys(ATTACHMENT_COLUMNS)) {
      for (const row of [...store.tableRows(logical), ...binRows(store, logical)]) referenced.add(blobKeyOf(logical, row));
    }
    return { entries: dead.length, stale: listed.filter((item) => !referenced.has(item.key) && !state.inflight.has(item.key)) };
  }, { incremental: true, cloneResult: false });
  let removed = 0;
  for (const { provider, key, etag } of stale) if (await deleteUnchanged(state, provider, key, etag, "An unreferenced object was not deleted")) removed += 1;
  if (removed || entries) report(state, { code: "STORAGE_SWEPT", message: `Removed ${removed} unreferenced storage object(s) and ${entries} orphaned file entr${entries === 1 ? "y" : "ies"}.`, removed, entries });
  return outbox({ removed, entries });
}

// Checks once that every key a file entry, note, attachment or recycle-bin snapshot references exists in its provider (a pack
// DATA file committed without its private <stateDir>/blobs, a cleaned state directory). One summarised STORAGE_OBJECTS_MISSING
// with the count and the first keys; a provider that cannot answer is not judged here.
async function verifyReferenced(api, state) {
  const { store } = api;
  const keys = new Set(Object.values(store.state.dataverse?.files ?? {}).filter((entry) => entry?.key && entry.data == null).map((entry) => entry.key));
  for (const logical of Object.keys(ATTACHMENT_COLUMNS)) {
    for (const row of [...store.tableRows(logical), ...binRows(store, logical)]) { const key = blobKeyOf(logical, row); if (key) keys.add(key); }
  }
  const missing = [];
  for (const key of keys) {
    const provider = key.startsWith("files/") ? state.files : state.annotations;
    if (!provider) continue;
    const head = await provider.head(key).catch((error) => (missingObject(error) ? null : undefined));
    if (head === undefined) break; // the provider cannot answer (unavailable): reads report per row instead
    if (head === null) missing.push(key);
  }
  if (missing.length) report(state, { severity: "error", code: "STORAGE_OBJECTS_MISSING", count: missing.length, keys: missing.slice(0, 5),
    message: `${missing.length} referenced storage object(s) are missing from their provider (first: ${missing.slice(0, 5).join(", ")}); those rows read with a null body.` });
  return missing.length;
}

/** install(api, { storage, diagnostic }): storage is a storage router (forRoute) or one provider; default api.providers.storage. */
async function install(api, { storage, diagnostic } = {}) {
  const { store, recordHooks } = api;
  storage ??= api.providers?.storage ?? null;
  const state = {
    diagnostic: diagnostic ?? null, diagnostics: [], pending: new Set(), flushing: null, inflight: new Map(), missing: new Set(),
    // Provider puts started by beforeWrite, by row id: afterWrite awaits them (an async drive waits, a sync SDK drive defers
    // them as SDK_DEFERRED_EFFECT) and a read of the row waits for its put before fetching the bytes.
    puts: new Map(),
    // Bound here, outside any request: work started through it runs outside the caller's transaction context.
    detached: AsyncResource.bind((fn) => fn()),
  };
  state.files = routeOf(state, storage, ROUTES.files);
  state.annotations = routeOf(state, storage, ROUTES.annotations);
  states.set(api, state);
  const release = (keys) => released(api, state, keys);
  api.storageRouting = {
    settle: async () => { while (state.flushing) await state.flushing; },
    sweep: () => sweep(api, state),
    diagnostics: () => [...state.diagnostics],
  };

  // A deleted row's file entries and blobs go once the delete has committed (cascades and portal deletes included).
  state.unsubscribe = store.addCommittedEvents((events) => {
    const keys = events.filter((event) => event.operation === "delete").flatMap((event) => storedKeysOf(store, event.entity, event.row));
    if (keys.length) release(keys);
  });
  if (state.files || state.annotations) {
    setFileStorage(api, {
      files: state.files, annotations: state.annotations, released: release,
      hold: (key) => hold(state, key), holdWrite: (key) => holdWrite(api, state, key),
      missing: (logical, id, key) => reportMissing(state, logical, id, key),
    });
    hydrateResponses(api);
    if (state.annotations) {
      recordHooks.add("beforeWrite", (c, mapping, info) => externalise(api, state, mapping, info), "dataverse-storage-routing");
      recordHooks.add("afterWrite", (c, mapping, { id }) => (ATTACHMENT_COLUMNS[mapping.logicalName] ? state.puts.get(guidKey(id)) : undefined), "dataverse-storage-routing");
      recordHooks.add("project", (c, mapping, formatted) => hydrate(api, c, mapping, formatted));
    }
    await migrate(api, state);
  }
  await sweep(api, state);
  await verifyReferenced(api, state);
}

// beforeWrite: a canonical base64 body moves to annotations/<rowId>/<n>; the row keeps a null column and its key. The size
// rule runs here because the record pipeline's attachment policy only sees inline bodies. Non-canonical text stays inline
// so it reads back exactly as written. Rows a module writes with __blobkey already set (block commits) pass through.
function externalise(api, state, mapping, { operation, data, existing }) {
  const logical = mapping.logicalName, column = ATTACHMENT_COLUMNS[logical];
  if (!column || !data || !["create", "update", "upsert"].includes(operation)) return undefined;
  if (!Object.hasOwn(data, column) || Object.hasOwn(data, "__blobkey")) return undefined;
  const value = data[column];
  const previous = existing ? blobKeyOf(logical, existing) : null;
  if (value == null) {
    if (previous) {
      data.__blobkey = null;
      released(api, state, [previous]);
    }
    return undefined;
  }
  if (!canonical(value)) return undefined;
  assertAttachmentSize(api.store.state, Buffer.byteLength(value));
  if (inlineInPack(api, logical, value)) {
    if (previous) {
      data.__blobkey = null;
      released(api, state, [previous]);
    }
    return undefined;
  }
  let id = guidKey(existing?.[mapping.idColumn] ?? data[mapping.idColumn]);
  if (!id) data[mapping.idColumn] = id = (api.ids?.uuid?.() ?? randomUUID()).toLowerCase();
  const key = `annotations/${id}/${previous ? Number(previous.split("/")[2]) + 1 : 1}`;
  data[column] = null;
  data.__blobkey = key;
  if (previous) released(api, state, [previous]);
  holdWrite(api, state, key);
  // The hook itself stays synchronous (an SDK drive refuses an async pre hook); the put is awaited by afterWrite and by readers.
  const put = state.annotations.put(key, Buffer.from(value, "base64"), { contentType: data.mimetype ?? existing?.mimetype ?? undefined })
    .then(() => undefined).finally(() => { if (state.puts.get(id) === put) state.puts.delete(id); });
  state.puts.set(id, put);
  put.catch(() => {});
  return undefined;
}

// project: the internal key never leaves; a carried, empty body column is read from its provider before the response leaves.
function hydrate(api, c, mapping, formatted) {
  const logical = mapping.logicalName, column = ATTACHMENT_COLUMNS[logical];
  if (!column) return;
  let rows = null;
  // One id map per request and table: the hook runs once per formatted row of a list.
  const rowsOf = () => {
    const cache = c && typeof c === "object" ? (requestRows.get(c) ?? requestRows.set(c, new Map()).get(c)) : new Map();
    if (!cache.has(logical)) cache.set(logical, new Map(api.store.tableRows(logical).map((stored) => [guidKey(stored[mapping.idColumn]), stored])));
    return cache.get(logical);
  };
  for (const row of [].concat(formatted ?? [])) {
    if (!row || typeof row !== "object") continue;
    delete row.__blobkey;
    if (!Object.hasOwn(row, column) || row[column] != null) continue;
    rows ??= rowsOf();
    const id = guidKey(row[mapping.idColumn]), key = blobKeyOf(logical, rows.get(id));
    // A missing object reads as a null body (STORAGE_OBJECT_MISSING); a $value read of it answers 404 with that code.
    if (key) deferBytes(c, row, column, () => storedBody(api, logical, id, key, { strict: c?.route?.kind === "value" }));
  }
}

async function reset(api) {
  const state = states.get(api);
  if (!state) return;
  if (state.files || state.annotations) await migrate(api, state);
  await sweep(api, state);
  state.missing.clear();
  await verifyReferenced(api, state);
}

async function close(api) {
  const state = states.get(api);
  state?.unsubscribe?.();
  while (state?.flushing) await state.flushing;
}

/**
 * A note or attachment row's body as base64 (inline or read from its provider), for hosts that read rows directly. A key its
 * provider no longer has reads as null with STORAGE_OBJECT_MISSING; strict (a $value read) throws 404 STORAGE_OBJECT_MISSING.
 */
export async function attachmentBody(api, logical, row, { strict = false } = {}) {
  const column = ATTACHMENT_COLUMNS[logical];
  if (!column || !row) return null;
  if (row[column] != null) return row[column];
  const key = blobKeyOf(logical, row);
  return key ? storedBody(api, logical, guidKey(row[ID_COLUMN[logical]]), key, { strict }) : null;
}

/** Capability record: behaviour with storage routes, contract when bytes stay in state. */
function describe(api) {
  const state = api ? states.get(api) : null;
  const level = state?.files || state?.annotations ? "behaviour" : "contract";
  return {
    name: NAME,
    version: 1,
    kind: "dataverse-extension",
    level,
    operations: [
      { name: "dataverseFiles", level: state?.files ? "behaviour" : "contract" },
      { name: "annotations", level: state?.annotations ? "behaviour" : "contract" },
      { name: "attachments", level: state?.annotations ? "behaviour" : "contract" },
      { name: "sweep", level },
    ],
    requires: [`provider:storage/${ROUTES.files}`, `provider:storage/${ROUTES.annotations}`],
    principal: "runtime",
    stateOwner: "store",
    lifecycle: "in-process",
  };
}

export const EXTENSION = { name: NAME, install, reset, close, describe };
