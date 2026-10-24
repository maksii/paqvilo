// SharePoint document integration for Dataverse records: document location rows plus a folder per record,
// with list/upload/delete over the storage provider route `sharepointDocuments`. Bytes never enter state JSON.
//
// Behaviour (when a storage router or provider is passed): location rows (sharepointsite -> table library location ->
// record location), the record folder, list/upload/delete with provider ETags (If-Match passes through), the caller's
// read (list) / write (ensure, upload, delete) privilege on the regarding record, and the organization attachment size
// limit (platform-settings assertAttachmentSize). Without storage every storage-backed operation answers 501
// `SharePointStorageNotConfigured` and reports diagnostic SHAREPOINT_ROUTE_MISSING once; locationsFor still reads rows.
// Contract only: the Power Pages document control wire format and the native auto-folder naming.
//
// Contract: https://learn.microsoft.com/power-pages/configure/manage-sharepoint-documents; an auto-created record
// folder is named "<record_name>_<record_id>" as in Dynamics 365 document locations.
// Guessed: the record id inside the folder name is the GUID upper-case without dashes.
// Guessed: characters SharePoint refuses in folder names (" * : < > ? / \ |) are dropped from the record name.
// Guessed: the record location is named "Documents on <site name>"; the library location carries the table logical name.
// Power Pages document control (createPortalDocumentService, contract): the documented operations (list, upload, download,
//   delete for a record's location) under the local route /_apps/portal-documents/<table>/<id>[/<name>], with the documented
//   permission rules (permissions.mjs portalDocumentAccess: parent Read and Append To, Write to upload; child Document
//   Location Read; Create, Write and Append to upload; Delete to delete) and upload limits (SharePoint/MaxUploadSize, default
//   10 MB, at most 50 MB; SharePoint/MaxTotalUploadSize per request; the organization's blocked attachment extensions).
// The platform's own document control endpoints, payloads and markup (under /_services/) are not documented;
//   the local markup (platform.mjs) and route are labelled local. Subfolders (New folder, navigation, upload, download and
//   delete inside them) use the ?folder=<path> parameter; New folder follows the upload permission rule.
// Outside the portal path the organization MaxUploadFileSize (base64 length) is the upload limit.
// The `sharepointdocument` virtual table is not in the standard table reference this runtime reads; it is not seeded.
// The SharePoint* error codes and their wording are local guesses; native ones are not documented.
// ponytail: one head() per listed file to recover the original name and content type; store the name in the key when
//   folders hold thousands of files.
import { randomUUID } from "node:crypto";
import { DataError } from "./data-error.mjs";
import { assertAttachmentSize } from "./platform-settings.mjs";
import { guardProvider } from "./storage-provider.mjs";
import { createThroughPipeline } from "./dataverse-files.mjs";
import { organizationPrincipalContext } from "./dataverse-principal-context.mjs";

const ROUTE = "sharepointDocuments";
const SITE = "sharepointsite";
const LOCATION = "sharepointdocumentlocation";
const FOLDER_MARKER = "_folder"; // a user file name can never encode to this: "_" is always escaped
const MAX_FOLDER_DEPTH = 16; // ponytail: a local bound on subfolder depth; SharePoint's own limit is the URL length
// Seeded only when dataverse-standard did not provide the mappings (the standard file lists both tables).
const FALLBACK_MAPPINGS = {
  [SITE]: { logicalName: SITE, entitySet: "sharepointsites", idColumn: "sharepointsiteid", nameColumn: "name" },
  [LOCATION]: { logicalName: LOCATION, entitySet: "sharepointdocumentlocations", idColumn: "sharepointdocumentlocationid", nameColumn: "name" },
};

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { storage: null, diagnostic: null, diagnostics: [], seen: new Set() });
  return states.get(api);
}

function report(state, entry) {
  if (state.seen.has(entry.code)) return;
  state.seen.add(entry.code);
  const diagnostic = { severity: "warning", ...entry };
  state.diagnostics.push(diagnostic);
  state.diagnostic?.(diagnostic);
}

function seed(store) {
  store.state.mappings ??= {};
  store.state.tables ??= {};
  for (const [logical, mapping] of Object.entries(FALLBACK_MAPPINGS)) {
    store.state.mappings[logical] ??= { ...mapping };
    store.state.tables[logical] ??= [];
  }
}

const lower = (value) => String(value ?? "").toLowerCase();
const sameId = (a, b) => lower(a) === lower(b);
const refId = (ref) => (ref && typeof ref === "object" ? ref.id : ref) ?? null;

// Storage keys accept [a-z0-9-_./]: every other character (and "_") becomes _<hex>_, so the mapping is unique and
// case-insensitive like SharePoint names.
const encodeSegment = (text) => [...lower(text)].map((ch) => (/[a-z0-9.-]/.test(ch) ? ch : `_${ch.codePointAt(0).toString(16)}_`)).join("");

function assertName(name) {
  if (typeof name !== "string" || !name.trim() || name === "." || name === ".." || /[\\/\0]/.test(name) || name.length > 400)
    throw new DataError("The document name is not valid.", 400, "SharePointInvalidName");
  return name;
}

// A new file or folder name also follows SharePoint's naming rules: no " * : < > ? / \ |, no leading or trailing space,
// no trailing dot, none of the reserved names. The exact SharePoint Online set is a guess (Learn documents these
// characters and the Windows reserved names; .lock, _vti_, desktop.ini, ~$ prefixes and _private are the SharePoint list).
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$|^\.lock$|^desktop\.ini$|^_private$|^~\$|_vti_/i;
function assertNewName(name) {
  assertName(name);
  if (/["*:<>?/\\|]/.test(name) || name !== name.trim() || name.endsWith(".") || RESERVED_NAME.test(name))
    throw new DataError(`'${name}' is not a valid SharePoint file or folder name.`, 400, "SharePointInvalidName");
  return name;
}
const sameNameExists = () => new DataError("A file or folder with this name already exists.", 409, "SharePointNameExists");

function storageOf(api) {
  const state = stateOf(api);
  const unavailable = () => {
    report(state, { code: "SHAREPOINT_ROUTE_MISSING", message: `SharePoint documents need the storage route '${ROUTE}'; pass a storage router or provider.` });
    return new DataError("SharePoint document storage is not configured for this runtime.", 501, "SharePointStorageNotConfigured");
  };
  if (!state.storage) throw unavailable();
  if (typeof state.storage.forRoute !== "function") return state.storage;
  try {
    const provider = state.storage.forRoute(ROUTE);
    if (provider) return provider;
  } catch (error) {
    if (error?.diagnostic === "PROVIDER_ROUTE_MISSING") throw unavailable();
    throw error;
  }
  throw unavailable(); // the route is set to `export`, which has no document store
}

function rowOf(store, logical, id) {
  const mapping = store.resolveMapping(logical);
  const rows = store.tableRows(mapping.logicalName);
  return rows.find((row) => sameId(row[mapping.idColumn], id)) ?? null;
}

// identity: { admin: true } passes; { user } (a systemuser row, the request's c.user) is checked by the security model.
function authorize(api, identity, logical, row, operation) {
  if (identity?.admin === true) return;
  if (!identity?.user) throw new DataError(`SharePoint documents need an authenticated caller for ${operation}.`, 403, "PrivilegeDenied");
  api.principals.authorize({ user: identity.user, entity: logical, operation, row, mapping: api.store.resolveMapping(logical) });
}

function regardingRow(api, regarding) {
  const logical = lower(regarding?.logicalName);
  if (!logical || !regarding?.id || !api.store.state.mappings?.[logical]) throw new DataError("The regarding record is not valid.", 400, "SharePointInvalidRegarding");
  const row = rowOf(api.store, logical, regarding.id);
  if (!row) throw new DataError(`${logical} With Id = ${regarding.id} Does Not Exist`, 404, "NotFound");
  return { logical, row, mapping: api.store.resolveMapping(logical) };
}

// The site row id and the relative URL segments from the site down to the location.
function pathOf(store, location) {
  const segments = [];
  let current = { row: location, logical: LOCATION };
  for (let depth = 0; depth <= 32; depth++) {
    if (current.logical === SITE) return { siteId: lower(current.row.sharepointsiteid), segments };
    segments.unshift(...String(current.row.relativeurl ?? "").split("/").filter(Boolean));
    const ref = current.row.parentsiteorlocation;
    const parentLogical = ref?.logical_name ?? SITE;
    const parent = refId(ref) == null ? null : rowOf(store, parentLogical, refId(ref));
    if (!parent) break;
    current = { row: parent, logical: parentLogical };
  }
  throw new DataError("The document location has no parent SharePoint site.", 400, "SharePointLocationUnresolved");
}

const folderKey = (store, location) => {
  const { siteId, segments } = pathOf(store, location);
  return ["sharepoint", encodeSegment(siteId), ...segments.map(encodeSegment)].join("/");
};

function locationContext(api, locationId, identity, operation) {
  const location = rowOf(api.store, LOCATION, locationId);
  if (!location) throw new DataError(`sharepointdocumentlocation With Id = ${locationId} Does Not Exist`, 404, "NotFound");
  const regarding = location.regardingobjectid;
  const target = refId(regarding) && regarding.logical_name ? rowOf(api.store, regarding.logical_name, refId(regarding)) : null;
  if (target) authorize(api, identity, regarding.logical_name, target, operation);
  else authorize(api, identity, LOCATION, location, operation);
  return { location, folder: folderKey(api.store, location) };
}

const activeLocations = (store, predicate) => store.tableRows(LOCATION).filter((row) => row.statecode !== 1 && predicate(row));
const lookup = (logical, id, name) => ({ id, logical_name: logical, ...(name != null ? { name } : {}) });
// Organization privileges are checked above; admin here only bypasses the separate Power Pages visitor permission model.
const pipelineContext = (store, identity) => (identity?.user
  ? organizationPrincipalContext(store, identity.user, { caller: identity.caller ?? identity.user })
  : { identity: { admin: true } });

function defaultSite(store, parentSite) {
  const sites = store.tableRows(SITE);
  const site = parentSite ? sites.find((row) => sameId(row.sharepointsiteid, parentSite)) : sites.find((row) => row.isdefault === true && row.statecode !== 1);
  if (!site) throw new DataError(parentSite ? `sharepointsite With Id = ${parentSite} Does Not Exist` : "No default SharePoint site is configured.",
    parentSite ? 404 : 400, parentSite ? "NotFound" : "SharePointDefaultSiteMissing");
  return site;
}

function createApi(api) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn));
  const newId = () => api.ids?.uuid?.() ?? randomUUID();

  async function locationsFor(regarding, identity) {
    const target = regardingRow(api, regarding);
    authorize(api, identity, target.logical, target.row, "read");
    return activeLocations(store, (row) => sameId(refId(row.regardingobjectid), regarding.id) && lower(row.regardingobjectid?.logical_name) === target.logical)
      .map((row) => ({ ...row }));
  }

  async function ensureLocation(regarding, { parentSite, relativeUrl } = {}, identity) {
    const target = regardingRow(api, regarding);
    authorize(api, identity, target.logical, target.row, "write");
    const storage = storageOf(api);
    // Both lookups run inside the write so two concurrent calls for one record cannot both create a location.
    const result = await write(async () => {
      const existing = activeLocations(store, (row) => sameId(refId(row.regardingobjectid), regarding.id) && lower(row.regardingobjectid?.logical_name) === target.logical)[0];
      if (existing) return { existing: { ...existing } };
      const site = defaultSite(store, parentSite);
      const name = target.row[target.mapping.nameColumn] ?? "";
      const folder = relativeUrl ?? `${String(name).replace(/["*:<>?/\\|]/g, "").trim()}_${String(regarding.id).replace(/-/g, "").toUpperCase()}`;
      if (!String(folder).split("/").filter(Boolean).length) throw new DataError("The relative URL is not valid.", 400, "SharePointInvalidName");
      const siteRef = lookup(SITE, site.sharepointsiteid, site.name);
      const library = activeLocations(store, (row) => !refId(row.regardingobjectid) && sameId(refId(row.parentsiteorlocation), site.sharepointsiteid)
        && lower(row.relativeurl) === target.logical)[0];
      const libraryId = library?.sharepointdocumentlocationid ?? newId();
      const locationId = newId();
      const libraryRow = library ?? { sharepointdocumentlocationid: libraryId, name: target.logical, relativeurl: target.logical, parentsiteorlocation: siteRef, locationtype: 0, servicetype: 0, statecode: 0, statuscode: 1 };
      const recordRow = {
        sharepointdocumentlocationid: locationId, name: `Documents on ${site.name ?? "Default Site"}`, relativeurl: folder,
        parentsiteorlocation: lookup(LOCATION, libraryId, target.logical), regardingobjectid: lookup(target.logical, target.row[target.mapping.idColumn], name),
        locationtype: 0, servicetype: 0, statecode: 0, statuscode: 1,
      };
      // Bytes before the row commit: an orphaned empty folder marker is harmless, a row without its folder is not.
      const key = ["sharepoint", encodeSegment(lower(site.sharepointsiteid)), encodeSegment(target.logical), ...String(folder).split("/").filter(Boolean).map(encodeSegment)].join("/");
      await storage.put(`${key}/${FOLDER_MARKER}`, Buffer.alloc(0), { contentType: "application/x-folder" });
      const c = pipelineContext(store, identity);
      if (!library) await createThroughPipeline(api, c, LOCATION, libraryRow);
      return { created: { ...(await createThroughPipeline(api, c, LOCATION, recordRow)) } };
    });
    if (!result.existing) return result.created;
    await storage.put(`${folderKey(store, result.existing)}/${FOLDER_MARKER}`, Buffer.alloc(0), { contentType: "application/x-folder" });
    return result.existing;
  }

  // Subfolders of a record's folder (Learn: website users can create subfolders): `path` is the folder names from the
  // record folder down; a subfolder exists when its FOLDER_MARKER (metadata { name }) does.
  async function folderOf(locationId, identity, operation, path = []) {
    const { folder } = locationContext(api, locationId, identity, operation);
    if (!Array.isArray(path) || path.length > MAX_FOLDER_DEPTH) throw new DataError("The folder path is not valid.", 400, "SharePointInvalidName");
    const key = [folder, ...path.map((segment) => encodeSegment(assertName(segment)))].join("/");
    if (path.length && !(await storageOf(api).head(`${key}/${FOLDER_MARKER}`)))
      throw new DataError(`The folder '${path.join("/")}' does not exist in this location.`, 404, "NotFound");
    return key;
  }

  // Lists one folder: its subfolders ({ name, folder: true }) first, then its files.
  async function listDocuments(locationId, identity, { path = [] } = {}) {
    const folder = await folderOf(locationId, identity, "read", path);
    const storage = storageOf(api);
    const documents = [], folders = new Set();
    let continuation;
    do {
      const page = await storage.list(`${folder}/`, { continuation });
      for (const item of page.items) {
        const rest = item.key.slice(folder.length + 1);
        if (rest === FOLDER_MARKER) continue;
        if (rest.includes("/")) { folders.add(rest.slice(0, rest.indexOf("/"))); continue; }
        const head = await storage.head(item.key);
        if (head) documents.push({ name: head.metadata?.name ?? rest, size: head.size, etag: head.etag, contentType: head.contentType, lastModified: head.lastModified });
      }
      continuation = page.continuation;
    } while (continuation);
    const named = [];
    for (const segment of folders) {
      const marker = await storage.head(`${folder}/${segment}/${FOLDER_MARKER}`);
      if (marker) named.push({ name: marker.metadata?.name ?? segment, folder: true, lastModified: marker.lastModified });
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return [...named.sort(byName), ...documents.sort(byName)];
  }

  async function createFolder(locationId, { path = [], name } = {}, identity) {
    // Every created folder must stay addressable: its own path is at most MAX_FOLDER_DEPTH names.
    if (Array.isArray(path) && path.length >= MAX_FOLDER_DEPTH) throw new DataError(`Folders nest at most ${MAX_FOLDER_DEPTH} levels.`, 400, "SharePointInvalidName");
    const parent = await folderOf(locationId, identity, "write", path);
    assertNewName(name);
    const key = `${parent}/${encodeSegment(name)}/${FOLDER_MARKER}`;
    const storage = storageOf(api);
    if (await storage.head(key)) throw new DataError(`A folder named '${name}' already exists.`, 409, "SharePointFolderExists");
    if (await storage.head(`${parent}/${encodeSegment(name)}`)) throw sameNameExists();
    const stored = await storage.put(key, Buffer.alloc(0), { contentType: "application/x-folder", metadata: { name } });
    return { name, folder: true, lastModified: stored.lastModified };
  }

  // Deletes a subfolder and everything in it.
  async function deleteFolder(locationId, path, identity) {
    if (!Array.isArray(path) || !path.length) throw new DataError("The folder path is not valid.", 400, "SharePointInvalidName");
    const folder = await folderOf(locationId, identity, "write", path);
    const storage = storageOf(api);
    const keys = [];
    let continuation;
    do {
      const page = await storage.list(`${folder}/`, { continuation });
      keys.push(...page.items.map((item) => item.key));
      continuation = page.continuation;
    } while (continuation);
    for (const key of keys) await storage.delete(key);
    return { deleted: true };
  }

  // maxBytes: the caller's own size rule (the portal SharePoint/MaxUploadSize) replaces the organization limit.
  async function upload(locationId, { name, bytes, contentType, ifMatch, maxBytes, path = [] } = {}, identity) {
    const folder = await folderOf(locationId, identity, "write", path);
    assertNewName(name);
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (maxBytes == null) assertAttachmentSize(store.state, 4 * Math.ceil(body.length / 3));
    else if (body.length > maxBytes) throw new DataError(`The file exceeds the maximum upload size of ${Math.round(maxBytes / 1048576)} MB.`, 413, "SharePointFileTooLarge");
    const storage = storageOf(api);
    if (await storage.head(`${folder}/${encodeSegment(name)}/${FOLDER_MARKER}`)) throw sameNameExists();
    const stored = await storage.put(`${folder}/${encodeSegment(name)}`, body, { contentType: contentType ?? "application/octet-stream", metadata: { name }, ...(ifMatch !== undefined ? { ifMatch } : {}) });
    return { name, size: stored.size, etag: stored.etag, contentType: stored.contentType, lastModified: stored.lastModified };
  }

  async function remove(locationId, name, { ifMatch, path = [] } = {}, identity) {
    const folder = await folderOf(locationId, identity, "write", path);
    assertName(name);
    const existed = await storageOf(api).delete(`${folder}/${encodeSegment(name)}`, ifMatch !== undefined ? { ifMatch } : {});
    if (!existed) throw new DataError(`The document '${name}' does not exist in this location.`, 404, "NotFound");
    return { deleted: true };
  }

  async function download(locationId, name, identity, { path = [] } = {}) {
    const folder = await folderOf(locationId, identity, "read", path);
    assertName(name);
    const missing = () => new DataError(`The document '${name}' does not exist in this location.`, 404, "NotFound");
    let found;
    try { found = await storageOf(api).get(`${folder}/${encodeSegment(name)}`); } catch (error) { if (error?.code === "NotFound" || error?.status === 404) throw missing(); throw error; }
    if (!found) throw missing();
    // Providers answer the body as a stream (async iterable) or bytes.
    const chunks = [];
    if (found.body && typeof found.body[Symbol.asyncIterator] === "function") for await (const chunk of found.body) chunks.push(Buffer.from(chunk));
    else if (found.body) chunks.push(Buffer.from(found.body));
    return { name: found.metadata?.name ?? name, bytes: Buffer.concat(chunks), contentType: found.contentType ?? "application/octet-stream" };
  }

  return { locationsFor, ensureLocation, listDocuments, createFolder, deleteFolder, upload, download, delete: remove, describe: () => describe(api), diagnostics: () => [...stateOf(api).diagnostics] };
}

/** install(api, { storage, diagnostic }): storage is a storage router (forRoute) or one provider. */
function install(api, options = {}) {
  const state = stateOf(api);
  const storage = options.storage ?? api.providers?.storage ?? null;
  state.storage = storage ? (typeof storage.forRoute === "function" ? storage : guardProvider(storage)) : null;
  state.diagnostic = options.diagnostic ?? api.diagnostic ?? null;
  api.sharepoint = createApi(api);
  return api.store.transact(() => seed(api.store));
}

function reset(api) {
  const state = stateOf(api);
  state.seen.clear();
  state.diagnostics.length = 0;
  seed(api.store);
}

/** Capability record. Storage-backed operations are behaviour only when this api has storage. */
function describe(api) {
  const storageLevel = api && stateOf(api).storage ? "behaviour" : "contract";
  return {
    name: "sharepoint-documents",
    version: 1,
    kind: "dataverse-extension",
    level: storageLevel,
    operations: [
      { name: "locationsFor", level: "behaviour" },
      ...["ensureLocation", "listDocuments", "upload", "delete", "createFolder", "deleteFolder"].map((name) => ({ name, level: storageLevel })),
      { name: "powerPagesDocumentControl", level: "contract" }, // createPortalDocumentService: documented operations and permissions, local route and markup
      { name: "autoFolderNaming", level: "contract" },
    ],
    requires: [`provider:storage/${ROUTE}`, `table:${LOCATION}`],
    principal: "caller",
    stateOwner: "store",
    lifecycle: "per-request",
  };
}

export const EXTENSION = { name: "sharepoint-documents", install, reset, describe };

// ---- Power Pages document control (contract): the documented operations over this module, the portal's table
// permissions and its upload settings. Mounted by the host at PORTAL_DOCUMENTS_ROUTE.
export const PORTAL_DOCUMENTS_ROUTE = "/_apps/portal-documents/";
const MB = 1048576;
const megabytes = (value, fallback, max = Infinity) => { const n = Number(value); return Math.min(Number.isFinite(n) && n > 0 ? n : fallback, max) * MB; };
const siteSetting = (portal, name) => { const entry = Object.entries(portal?.settings ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]; return entry?.value ?? entry ?? null; };
const answer = (res, status, body, headers = {}) => { if (res.headersSent) { res.end(); return true; } res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-sim-route": "portal-documents", ...headers }); res.end(body == null ? undefined : JSON.stringify(body)); return true; };
const failureBody = (error) => ({ error: { code: error.code ?? "PortalDocumentsFailed", message: error.message } });

/**
 * createPortalDocumentService({ sharepoint, store, portal, access, blockedExtensions }) -> { handle(req, res, url, { identity, csrf }) }.
 * `sharepoint` is api.sharepoint of the organization (this module); `access(store, target, identity)` is permissions.mjs
 * portalDocumentAccess; `portal()` answers the effective portal (site settings); `blockedExtensions()` the organization list.
 * Routes (local, documented operations only):
 * Every route takes ?folder=<a/b> (a subfolder of the record folder; 404 when it does not exist):
 *   GET    <route><table>/<id>               -> { folder, folders: [{ name, lastModified }], documents: [{ name, size, contentType, lastModified }], canUpload, canCreateFolder, canDelete }
 *   POST   <route><table>/<id>?name=<n>      -> 201 document (raw body; one file per request)
 *   POST   <route><table>/<id>?newFolder=<n> -> 201 { name, folder: true } (409 when it exists)
 *   GET    <route><table>/<id>/<name>        -> the file bytes
 *   DELETE <route><table>/<id>/<name>        -> 204
 *   DELETE <route><table>/<id>?folder=<a/b>  -> 204 (the folder and its contents)
 * Anything else answers 501 PortalDocumentMemberUnsupported. Without storage: 501 SharePointStorageNotConfigured.
 */
export function createPortalDocumentService({ sharepoint, store, portal = () => ({}), access, blockedExtensions = () => [] }) {
  const system = { admin: true }; // the portal's own permission check runs first; the organization call acts as the site
  async function handle(req, res, url, { identity = {}, csrf = null } = {}) {
    if (!url.pathname.toLowerCase().startsWith(PORTAL_DOCUMENTS_ROUTE)) return false;
    const parts = url.pathname.slice(PORTAL_DOCUMENTS_ROUTE.length).split("/").filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } });
    try {
      // ?folder=a/b addresses a subfolder of the record folder; each name is checked (assertName: no "..", no separators).
      const path = (url.searchParams.get("folder") ?? "").split("/").filter(Boolean);
      const newFolder = url.searchParams.get("newFolder");
      if (parts.length < 2 || parts.length > 3) return answer(res, 501, failureBody({ code: "PortalDocumentMemberUnsupported", message: "This document control member is not available locally." }));
      if (!["GET", "POST", "DELETE"].includes(req.method) || (req.method === "POST" && parts.length !== 2) || (req.method === "DELETE" && parts.length !== 3 && !path.length))
        return answer(res, 501, failureBody({ code: "PortalDocumentMemberUnsupported", message: "This document control member is not available locally." }));
      if (path.length > MAX_FOLDER_DEPTH) throw new DataError("The folder path is not valid.", 400, "SharePointInvalidName");
      for (const segment of path) assertName(segment);
      if (req.method !== "GET" && (!csrf || req.headers.__requestverificationtoken !== csrf)) return answer(res, 403, failureBody({ code: "Forbidden", message: "Missing portal verification token." }));
      // Without storage every operation answers 501, never an empty list.
      if (sharepoint.describe().level !== "behaviour") return answer(res, 501, failureBody({ code: "SharePointStorageNotConfigured", message: "SharePoint document storage is not configured for this runtime." }));
      const [table, id, name] = parts;
      let mapping;
      try { mapping = store.resolveMapping(table); } catch { return answer(res, 404, failureBody({ code: "NotFound", message: `The table ${table} is not known.` })); }
      const row = store.tableRows(mapping.logicalName).find((item) => sameId(item[mapping.idColumn], id));
      // Learn: upload requires the parent record to exist (a create-mode form has none).
      if (!row) return answer(res, 404, failureBody({ code: "NotFound", message: `${mapping.logicalName} With Id = ${id} Does Not Exist` }));
      const regarding = { logicalName: mapping.logicalName, id: row[mapping.idColumn] };
      const location = activeLocations(store, (item) => sameId(refId(item.regardingobjectid), regarding.id) && lower(item.regardingobjectid?.logical_name) === mapping.logicalName)[0] ?? null;
      const allowed = access(store, { entity: mapping.logicalName, row, location }, identity);
      if (req.method === "GET" && !name) {
        if (!allowed.list) return answer(res, 403, failureBody({ code: "PermissionDenied", message: "Table permissions do not allow reading this record's documents." }));
        if (!location && path.length) return answer(res, 404, failureBody({ code: "NotFound", message: `The folder '${path.join("/")}' does not exist in this location.` }));
        const entries = location ? await sharepoint.listDocuments(location.sharepointdocumentlocationid, system, { path }) : [];
        // New folder follows the upload rule (Create, Write and Append on Document Location); Learn names no separate privilege.
        return answer(res, 200, {
          folder: path.join("/"),
          folders: entries.filter((entry) => entry.folder).map(({ name: folder, lastModified }) => ({ name: folder, lastModified })),
          documents: entries.filter((entry) => !entry.folder).map(({ name: file, size, contentType, lastModified }) => ({ name: file, size, contentType, lastModified })),
          canUpload: allowed.upload, canCreateFolder: allowed.upload, canDelete: allowed.delete,
        });
      }
      if (req.method === "GET") {
        if (!allowed.list || !location) return answer(res, allowed.list ? 404 : 403, failureBody({ code: allowed.list ? "NotFound" : "PermissionDenied", message: allowed.list ? "The record has no documents." : "Table permissions do not allow reading this record's documents." }));
        const file = await sharepoint.download(location.sharepointdocumentlocationid, name, system, { path });
        res.writeHead(200, { "content-type": file.contentType, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "cache-control": "no-store", "x-sim-route": "portal-documents" });
        res.end(Buffer.from(file.bytes ?? []));
        return true;
      }
      if (req.method === "DELETE") {
        if (!allowed.delete || !location) return answer(res, allowed.delete ? 404 : 403, failureBody({ code: allowed.delete ? "NotFound" : "PermissionDenied", message: allowed.delete ? "The record has no documents." : "Table permissions do not allow deleting this record's documents." }));
        if (name) await sharepoint.delete(location.sharepointdocumentlocationid, name, { path }, system);
        else await sharepoint.deleteFolder(location.sharepointdocumentlocationid, path, system);
        res.writeHead(204, { "cache-control": "no-store", "x-sim-route": "portal-documents" });
        res.end();
        return true;
      }
      if (!allowed.upload) return answer(res, 403, failureBody({ code: "PermissionDenied", message: "Table permissions do not allow uploading documents to this record." }));
      if (newFolder != null) {
        assertNewName(newFolder);
        if (path.length >= MAX_FOLDER_DEPTH) throw new DataError(`Folders nest at most ${MAX_FOLDER_DEPTH} levels.`, 400, "SharePointInvalidName");
        if (!location && path.length) return answer(res, 404, failureBody({ code: "NotFound", message: `The folder '${path.join("/")}' does not exist in this location.` }));
        const target = location ?? (await sharepoint.ensureLocation(regarding, {}, system));
        return answer(res, 201, await sharepoint.createFolder(target.sharepointdocumentlocationid, { path, name: newFolder }, system));
      }
      if (!location && path.length) return answer(res, 404, failureBody({ code: "NotFound", message: `The folder '${path.join("/")}' does not exist in this location.` }));
      const fileName = url.searchParams.get("name") ?? "";
      assertNewName(fileName);
      const extension = fileName.includes(".") ? fileName.split(".").pop().toLowerCase() : "";
      if (extension && blockedExtensions().includes(extension)) return answer(res, 400, failureBody({ code: "AttachmentTypeBlocked", message: "Attachment extension is blocked by the organization." }));
      const settings = portal();
      const maxBytes = megabytes(siteSetting(settings, "SharePoint/MaxUploadSize"), 10, 50);
      const totalBytes = megabytes(siteSetting(settings, "SharePoint/MaxTotalUploadSize"), Infinity);
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > Math.min(maxBytes, totalBytes)) return answer(res, 413, failureBody({ code: "SharePointFileTooLarge", message: `The file exceeds the maximum upload size of ${Math.round(Math.min(maxBytes, totalBytes) / MB)} MB.` }));
      const chunks = [];
      let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > Math.min(maxBytes, totalBytes)) return answer(res, 413, failureBody({ code: "SharePointFileTooLarge", message: `The file exceeds the maximum upload size of ${Math.round(Math.min(maxBytes, totalBytes) / MB)} MB.` })); chunks.push(chunk); }
      const target = location ?? (await sharepoint.ensureLocation(regarding, {}, system));
      const stored = await sharepoint.upload(target.sharepointdocumentlocationid, { name: fileName, bytes: Buffer.concat(chunks), contentType: String(req.headers["content-type"] ?? "application/octet-stream"), maxBytes, path }, system);
      return answer(res, 201, { name: stored.name, size: stored.size, contentType: stored.contentType, lastModified: stored.lastModified });
    } catch (error) {
      return answer(res, error.status ?? 500, failureBody(error));
    }
  }
  return { handle };
}
