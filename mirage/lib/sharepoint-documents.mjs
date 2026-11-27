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
// Power Pages document control (createPortalDocumentService, sharePointControlMarkup): the platform's markup and its four
//   services /_services/sharepoint-data.json|addfiles|addfolder|deleteitem/<website> with the request bodies, failure
//   shapes and check order hosted session F7 recorded with the SharePoint integration off (summary-F7.md sections 1-4).
//   With the integration on (the storage route, unless observed sharePointIntegration "off") they serve this module's
//   folders; those answers' item values (Id, Url, FileSizeDisplay, ModifiedOnDisplay), success statuses and sort and paging
//   are local, because F7 could not record SharePoint on. Permissions follow Learn (permissions.mjs portalDocumentAccess:
//   parent Read and Append To, Write to upload; child Document Location Read; Create, Write and Append to upload; Delete to
//   delete); upload limits SharePoint/MaxUploadSize (default 10 MB, at most 50 MB) and the total the control renders.
//   A file's Url is the local download route /_apps/portal-documents/<table>/<id>/<name>[?folder=<path>] (the stand-in
//   for the SharePoint file URL).
// Outside the portal path the organization MaxUploadFileSize (base64 length) is the upload limit.
// The `sharepointdocument` table and its reads over these folders are sharepoint-document-table.mjs.
// The SharePoint* error codes and their wording are local guesses; native ones are not documented.
// ponytail: one head() per listed file to recover the original name and content type; store the name in the key when
//   folders hold thousands of files.
import { randomUUID } from 'node:crypto';
import { sameToken } from './admin-origin.mjs';
import { DataError } from './data-error.mjs';
import { assertAttachmentSize } from './platform-settings.mjs';
import { guardProvider } from './storage-provider.mjs';
import { clockFunction, storeScheduler, systemClock } from './runtime-clock.mjs';
import { createThroughPipeline } from './dataverse-files.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';

const ROUTE = 'sharepointDocuments';
const SITE = 'sharepointsite';
const LOCATION = 'sharepointdocumentlocation';
const FOLDER_MARKER = '_folder'; // a user file name can never encode to this: "_" is always escaped
// The kind holding a name (metadata { kind: 'file' | 'folder' }), created once with If-None-Match: *. Runtimes whose
// adapters share one backend (Azurite, a pack) agree on file-versus-folder through this single-key condition.
const NAME_CLAIM = '_name';
// A claim whose file or folder never appeared (its creator stopped) is taken over after this long.
const STALE_CLAIM_MS = 60_000;
const MAX_FOLDER_DEPTH = 16; // ponytail: a local bound on subfolder depth; SharePoint's own limit is the URL length
// Seeded only when dataverse-standard did not provide the mappings (the standard file lists both tables).
const FALLBACK_MAPPINGS = {
  [SITE]: { logicalName: SITE, entitySet: 'sharepointsites', idColumn: 'sharepointsiteid', nameColumn: 'name' },
  [LOCATION]: {
    logicalName: LOCATION,
    entitySet: 'sharepointdocumentlocations',
    idColumn: 'sharepointdocumentlocationid',
    nameColumn: 'name',
  },
};

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { storage: null, diagnostic: null, diagnostics: [], seen: new Set() });
  return states.get(api);
}

function report(state, entry) {
  if (state.seen.has(entry.code)) return;
  state.seen.add(entry.code);
  const diagnostic = { severity: 'warning', ...entry };
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

const lower = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => lower(a) === lower(b);
const refId = (ref) => (ref && typeof ref === 'object' ? ref.id : ref) ?? null;

// Storage keys accept [a-z0-9-_./]: every other character (and "_") becomes _<hex>_, so the mapping is unique and
// case-insensitive like SharePoint names.
const encodeSegment = (text) =>
  [...lower(text)].map((ch) => (/[a-z0-9.-]/.test(ch) ? ch : `_${ch.codePointAt(0).toString(16)}_`)).join('');

function assertName(name) {
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[\\/\0]/.test(name) ||
    name.length > 400
  )
    throw new DataError('The document name is not valid.', 400, 'SharePointInvalidName');
  return name;
}

// A folder path segment: the same check, refused as a folder path so a traversal attempt is named as one.
function assertFolderName(segment) {
  try {
    return assertName(segment);
  } catch {
    throw new DataError(
      'The folder path is not valid: a folder name cannot be empty, "." or "..", or contain a separator (path traversal is refused).',
      400,
      'SharePointInvalidName',
    );
  }
}

// A new file or folder name also follows SharePoint's naming rules: no " * : < > ? / \ |, no leading or trailing space,
// no trailing dot, none of the reserved names. The exact SharePoint Online set is a guess (Learn documents these
// characters and the Windows reserved names; .lock, _vti_, desktop.ini, ~$ prefixes and _private are the SharePoint list).
const RESERVED_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$|^\.lock$|^desktop\.ini$|^_private$|^~\$|_vti_/i;
function assertNewName(name) {
  assertName(name);
  if (/["*:<>?/\\|]/.test(name) || name !== name.trim() || name.endsWith('.') || RESERVED_NAME.test(name))
    throw new DataError(`'${name}' is not a valid SharePoint file or folder name.`, 400, 'SharePointInvalidName');
  return name;
}
// The runtime clock (the store's, which its scheduler and the renewals of a claim also run on), for claim ages.
const apiNow = (api) => () => clockFunction(api.store?.clock ?? api.clock ?? systemClock)();
const sameNameExists = () =>
  new DataError('A file or folder with this name already exists.', 409, 'SharePointNameExists');

function storageOf(api) {
  const state = stateOf(api);
  const unavailable = () => {
    report(state, {
      code: 'SHAREPOINT_ROUTE_MISSING',
      message: `SharePoint documents need the storage route '${ROUTE}'; pass a storage router or provider.`,
    });
    return new DataError(
      'SharePoint document storage is not configured for this runtime.',
      501,
      'SharePointStorageNotConfigured',
    );
  };
  if (!state.storage) throw unavailable();
  if (typeof state.storage.forRoute !== 'function') return state.storage;
  try {
    const provider = state.storage.forRoute(ROUTE);
    if (provider) return provider;
  } catch (error) {
    if (error?.diagnostic === 'PROVIDER_ROUTE_MISSING') throw unavailable();
    throw error;
  }
  throw unavailable(); // the route is set to `export`, which has no document store
}

const storageNameWrites = new WeakMap();

// A file and its competing folder marker have distinct storage keys. Coordinate their writes through
// the in-process provider adapter while leaving same-kind writes to the existing provider conditions.
function withDocumentName(storage, key, kind, operation) {
  let names = storageNameWrites.get(storage);
  if (!names) {
    names = new Map();
    storageNameWrites.set(storage, names);
  }
  const previous = names.get(key);
  const wait = previous?.kind === kind ? previous.wait : previous?.done;
  const run = Promise.resolve(wait).then(operation);
  const done = Promise.allSettled([previous?.done, run]).then(() => {
    if (names.get(key)?.done === done) names.delete(key);
  });
  names.set(key, { kind, wait, done });
  return run;
}

// The claim at `key`, or null: the kind holding the name, its ETag and when it was written.
async function nameClaim(storage, key) {
  const head = await storage.head(`${key}/${NAME_CLAIM}`);
  return head ? { kind: head.metadata?.kind ?? null, etag: head.etag, lastModified: head.lastModified } : null;
}

// The write condition that claims a name over `current`: create when there is none, replace a stale one (nothing stands
// behind it and it is older than STALE_CLAIM_MS), else null (the other kind holds the name).
async function claimCondition(storage, key, current, now) {
  if (!current) return { ifNoneMatch: '*' };
  const held = current.kind === 'folder' ? `${key}/${FOLDER_MARKER}` : key;
  const age = now() - Date.parse(current.lastModified ?? '');
  const stale = Number.isFinite(age) && age > STALE_CLAIM_MS;
  if (!stale || (await storage.head(held))) return null;
  return { ifMatch: current.etag };
}

// Claims the name at `key` for a kind: { kind } of the holder after this call (ours, or the other kind's), and whether
// this call created the claim. A claim with nothing behind it that is older than STALE_CLAIM_MS is replaced conditionally.
async function claimName(storage, key, kind, { now = Date.now } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await nameClaim(storage, key);
    if (current?.kind === kind) return { kind, claimed: false };
    const condition = await claimCondition(storage, key, current, now);
    if (!condition) return { kind: current.kind, claimed: false };
    try {
      await storage.put(`${key}/${NAME_CLAIM}`, Buffer.alloc(0), {
        contentType: 'application/x-name-claim',
        metadata: { kind },
        ...condition,
      });
      return { kind, claimed: true };
    } catch (error) {
      if (!['Conflict', 'PreconditionFailed'].includes(error?.code)) throw error;
    }
  }
  return { kind: (await nameClaim(storage, key))?.kind ?? kind, claimed: false };
}

// While a write of the named file or folder runs (a long upload), its claim is renewed on the runtime scheduler every
// third of STALE_CLAIM_MS, so another runtime never takes over a claim whose write is still in progress. A renewal is
// conditional on the claim's ETag; one that finds the claim gone or replaced stops. Answers stop().
const RENEW_CLAIM_MS = STALE_CLAIM_MS / 3;
function keepClaim(api, storage, key, kind) {
  const scheduler = storeScheduler(api.store);
  let handle = null,
    stopped = false;
  const renew = async () => {
    handle = null;
    if (stopped) return;
    const head = await storage.head(`${key}/${NAME_CLAIM}`).catch(() => null);
    if (stopped || head?.metadata?.kind !== kind) return;
    try {
      await storage.put(`${key}/${NAME_CLAIM}`, Buffer.alloc(0), {
        contentType: 'application/x-name-claim',
        metadata: { kind },
        ifMatch: head.etag,
      });
    } catch (error) {
      if (['Conflict', 'PreconditionFailed'].includes(error?.code)) return;
    }
    if (!stopped) handle = scheduler.schedule(renew, RENEW_CLAIM_MS, { name: 'sharepoint-name-claim' });
  };
  handle = scheduler.schedule(renew, RENEW_CLAIM_MS, { name: 'sharepoint-name-claim' });
  return () => {
    stopped = true;
    if (handle !== null) scheduler.cancel(handle);
    handle = null;
  };
}

// Releases a claim this call created when its write failed, so the name stays usable.
async function releaseName(storage, key) {
  try {
    await storage.delete(`${key}/${NAME_CLAIM}`);
  } catch (error) {
    if (error?.code !== 'NotFound') throw error;
  }
}

function rowOf(store, logical, id) {
  const mapping = store.resolveMapping(logical);
  const rows = store.tableRows(mapping.logicalName);
  return rows.find((row) => sameId(row[mapping.idColumn], id)) ?? null;
}

// identity: { admin: true } passes; { user } (a systemuser row, the request's c.user) is checked by the security model.
function authorize(api, identity, logical, row, operation) {
  if (identity?.admin === true) return;
  if (!identity?.user)
    throw new DataError(`SharePoint documents need an authenticated caller for ${operation}.`, 403, 'PrivilegeDenied');
  api.principals.authorize({
    user: identity.user,
    entity: logical,
    operation,
    row,
    mapping: api.store.resolveMapping(logical),
  });
}

function regardingRow(api, regarding) {
  const logical = lower(regarding?.logicalName);
  if (!logical || !regarding?.id || !api.store.state.mappings?.[logical])
    throw new DataError('The regarding record is not valid.', 400, 'SharePointInvalidRegarding');
  const row = rowOf(api.store, logical, regarding.id);
  if (!row) throw new DataError(`${logical} With Id = ${regarding.id} Does Not Exist`, 404, 'NotFound');
  return { logical, row, mapping: api.store.resolveMapping(logical) };
}

// The site row id and the relative URL segments from the site down to the location.
function pathOf(store, location) {
  const segments = [];
  let current = { row: location, logical: LOCATION };
  for (let depth = 0; depth <= 32; depth++) {
    if (current.logical === SITE) return { siteId: lower(current.row.sharepointsiteid), segments };
    segments.unshift(
      ...String(current.row.relativeurl ?? '')
        .split('/')
        .filter(Boolean),
    );
    const ref = current.row.parentsiteorlocation;
    const parentLogical = ref?.logical_name ?? SITE;
    const parent = refId(ref) == null ? null : rowOf(store, parentLogical, refId(ref));
    if (!parent) break;
    current = { row: parent, logical: parentLogical };
  }
  throw new DataError('The document location has no parent SharePoint site.', 400, 'SharePointLocationUnresolved');
}

const folderKey = (store, location) => {
  const { siteId, segments } = pathOf(store, location);
  return ['sharepoint', encodeSegment(siteId), ...segments.map(encodeSegment)].join('/');
};

function locationContext(api, locationId, identity, operation) {
  const location = rowOf(api.store, LOCATION, locationId);
  if (!location)
    throw new DataError(`sharepointdocumentlocation With Id = ${locationId} Does Not Exist`, 404, 'NotFound');
  const regarding = location.regardingobjectid;
  const target =
    refId(regarding) && regarding.logical_name ? rowOf(api.store, regarding.logical_name, refId(regarding)) : null;
  if (target) authorize(api, identity, regarding.logical_name, target, operation);
  else authorize(api, identity, LOCATION, location, operation);
  return { location, folder: folderKey(api.store, location) };
}

const activeLocations = (store, predicate) =>
  store.tableRows(LOCATION).filter((row) => row.statecode !== 1 && predicate(row));
const lookup = (logical, id, name) => ({ id, logical_name: logical, ...(name != null ? { name } : {}) });
// Organization privileges are checked above; admin here only bypasses the separate Power Pages visitor permission model.
const pipelineContext = (store, identity) =>
  identity?.user
    ? organizationPrincipalContext(store, identity.user, { caller: identity.caller ?? identity.user })
    : { identity: { admin: true } };

function defaultSite(store, parentSite) {
  const sites = store.tableRows(SITE);
  const site = parentSite
    ? sites.find((row) => sameId(row.sharepointsiteid, parentSite))
    : sites.find((row) => row.isdefault === true && row.statecode !== 1);
  if (!site)
    throw new DataError(
      parentSite
        ? `sharepointsite With Id = ${parentSite} Does Not Exist`
        : 'No default SharePoint site is configured.',
      parentSite ? 404 : 400,
      parentSite ? 'NotFound' : 'SharePointDefaultSiteMissing',
    );
  return site;
}

function createApi(api) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn));
  const newId = () => api.ids?.uuid?.() ?? randomUUID();

  async function locationsFor(regarding, identity) {
    const target = regardingRow(api, regarding);
    authorize(api, identity, target.logical, target.row, 'read');
    return activeLocations(
      store,
      (row) =>
        sameId(refId(row.regardingobjectid), regarding.id) &&
        lower(row.regardingobjectid?.logical_name) === target.logical,
    ).map((row) => ({ ...row }));
  }

  async function ensureLocation(regarding, { parentSite, relativeUrl } = {}, identity) {
    const target = regardingRow(api, regarding);
    authorize(api, identity, target.logical, target.row, 'write');
    const storage = storageOf(api);
    // Both lookups run inside the write so two concurrent calls for one record cannot both create a location.
    const result = await write(async () => {
      const existing = activeLocations(
        store,
        (row) =>
          sameId(refId(row.regardingobjectid), regarding.id) &&
          lower(row.regardingobjectid?.logical_name) === target.logical,
      )[0];
      if (existing) return { existing: { ...existing } };
      const site = defaultSite(store, parentSite);
      const name = target.row[target.mapping.nameColumn] ?? '';
      const folder =
        relativeUrl ??
        `${String(name)
          .replace(/["*:<>?/\\|]/g, '')
          .trim()}_${String(regarding.id).replaceAll('-', '').toUpperCase()}`;
      if (!String(folder).split('/').filter(Boolean).length)
        throw new DataError('The relative URL is not valid.', 400, 'SharePointInvalidName');
      const siteRef = lookup(SITE, site.sharepointsiteid, site.name);
      const library = activeLocations(
        store,
        (row) =>
          !refId(row.regardingobjectid) &&
          sameId(refId(row.parentsiteorlocation), site.sharepointsiteid) &&
          lower(row.relativeurl) === target.logical,
      )[0];
      const libraryId = library?.sharepointdocumentlocationid ?? newId();
      const locationId = newId();
      const libraryRow = library ?? {
        sharepointdocumentlocationid: libraryId,
        name: target.logical,
        relativeurl: target.logical,
        parentsiteorlocation: siteRef,
        locationtype: 0,
        servicetype: 0,
        statecode: 0,
        statuscode: 1,
      };
      const recordRow = {
        sharepointdocumentlocationid: locationId,
        name: `Documents on ${site.name ?? 'Default Site'}`,
        relativeurl: folder,
        parentsiteorlocation: lookup(LOCATION, libraryId, target.logical),
        regardingobjectid: lookup(target.logical, target.row[target.mapping.idColumn], name),
        locationtype: 0,
        servicetype: 0,
        statecode: 0,
        statuscode: 1,
      };
      // Bytes before the row commit: an orphaned empty folder marker is harmless, a row without its folder is not.
      const key = [
        'sharepoint',
        encodeSegment(lower(site.sharepointsiteid)),
        encodeSegment(target.logical),
        ...String(folder).split('/').filter(Boolean).map(encodeSegment),
      ].join('/');
      await storage.put(`${key}/${FOLDER_MARKER}`, Buffer.alloc(0), { contentType: 'application/x-folder' });
      const c = pipelineContext(store, identity);
      if (!library) await createThroughPipeline(api, c, LOCATION, libraryRow);
      return { created: { ...(await createThroughPipeline(api, c, LOCATION, recordRow)) } };
    });
    if (!result.existing) return result.created;
    await storage.put(`${folderKey(store, result.existing)}/${FOLDER_MARKER}`, Buffer.alloc(0), {
      contentType: 'application/x-folder',
    });
    return result.existing;
  }

  // Subfolders of a record's folder (Learn: website users can create subfolders): `path` is the folder names from the
  // record folder down; a subfolder exists when its FOLDER_MARKER (metadata { name }) does.
  async function folderOf(locationId, identity, operation, path = []) {
    const { folder } = locationContext(api, locationId, identity, operation);
    if (!Array.isArray(path) || path.length > MAX_FOLDER_DEPTH)
      throw new DataError('The folder path is not valid.', 400, 'SharePointInvalidName');
    const key = [folder, ...path.map((segment) => encodeSegment(assertFolderName(segment)))].join('/');
    if (path.length && !(await storageOf(api).head(`${key}/${FOLDER_MARKER}`)))
      throw new DataError(`The folder '${path.join('/')}' does not exist in this location.`, 404, 'NotFound');
    return key;
  }

  // Lists one folder: its subfolders ({ name, folder: true }) first, then its files.
  async function listDocuments(locationId, identity, { path = [] } = {}) {
    const folder = await folderOf(locationId, identity, 'read', path);
    const storage = storageOf(api);
    const documents = [],
      folders = new Set();
    let continuation;
    do {
      const page = await storage.list(`${folder}/`, { continuation });
      for (const item of page.items) {
        const rest = item.key.slice(folder.length + 1);
        if (rest === FOLDER_MARKER || rest === NAME_CLAIM) continue;
        if (rest.includes('/')) {
          folders.add(rest.slice(0, rest.indexOf('/')));
          continue;
        }
        const head = await storage.head(item.key);
        if (head)
          documents.push({
            name: head.metadata?.name ?? rest,
            size: head.size,
            etag: head.etag,
            contentType: head.contentType,
            lastModified: head.lastModified,
          });
      }
      continuation = page.continuation;
    } while (continuation);
    const named = [];
    for (const segment of folders) {
      const marker = await storage.head(`${folder}/${segment}/${FOLDER_MARKER}`);
      if (marker)
        named.push({ name: marker.metadata?.name ?? segment, folder: true, lastModified: marker.lastModified });
    }
    const byName = (a, b) => a.name.localeCompare(b.name);
    return [...named.sort(byName), ...documents.sort(byName)];
  }

  async function createFolder(locationId, { path = [], name } = {}, identity) {
    // Every created folder must stay addressable: its own path is at most MAX_FOLDER_DEPTH names.
    if (Array.isArray(path) && path.length >= MAX_FOLDER_DEPTH)
      throw new DataError(`Folders nest at most ${MAX_FOLDER_DEPTH} levels.`, 400, 'SharePointInvalidName');
    const parent = await folderOf(locationId, identity, 'write', path);
    assertNewName(name);
    const key = `${parent}/${encodeSegment(name)}`;
    const storage = storageOf(api);
    return withDocumentName(storage, key, 'folder', async () => {
      const marker = `${key}/${FOLDER_MARKER}`;
      const folderExists = () =>
        new DataError(`A folder named '${name}' already exists.`, 409, 'SharePointFolderExists');
      const claim = await claimName(storage, key, 'folder', { now: apiNow(api) });
      if (claim.kind === 'file') throw sameNameExists();
      if (await storage.head(marker)) throw folderExists();
      // A file stored before name claims existed still holds its name.
      if (await storage.head(key)) {
        if (claim.claimed) await releaseName(storage, key);
        throw sameNameExists();
      }
      try {
        const stored = await storage.put(marker, Buffer.alloc(0), {
          contentType: 'application/x-folder',
          metadata: { name },
          ifNoneMatch: '*',
        });
        return { name, folder: true, lastModified: stored.lastModified };
      } catch (error) {
        if (error?.code === 'Conflict') throw folderExists();
        if (claim.claimed) await releaseName(storage, key);
        throw error;
      }
    });
  }

  // Deletes a subfolder and everything in it.
  async function deleteFolder(locationId, path, identity) {
    if (!Array.isArray(path) || !path.length)
      throw new DataError('The folder path is not valid.', 400, 'SharePointInvalidName');
    const folder = await folderOf(locationId, identity, 'write', path);
    const storage = storageOf(api);
    const keys = [];
    let continuation;
    do {
      const page = await storage.list(`${folder}/`, { continuation });
      keys.push(...page.items.map((item) => item.key));
      continuation = page.continuation;
    } while (continuation);
    const markers = [];
    for (const key of keys) {
      if (key.endsWith(`/${FOLDER_MARKER}`) || key.endsWith(`/${NAME_CLAIM}`)) markers.push(key);
      else await storage.delete(key);
    }
    // A provider failure must leave the remaining folder addressable. Keep every marker until its data is gone, and each
    // folder's name claim until its marker is (deepest first; a claim sorts after its folder's marker).
    const order = (left, right) =>
      right.split('/').length - left.split('/').length ||
      Number(left.endsWith(`/${NAME_CLAIM}`)) - Number(right.endsWith(`/${NAME_CLAIM}`));
    for (const key of markers.toSorted(order)) await storage.delete(key);
    return { deleted: true };
  }

  // maxBytes: the caller's own size rule (the portal SharePoint/MaxUploadSize) replaces the organization limit.
  async function upload(locationId, { name, bytes, contentType, ifMatch, maxBytes, path = [] } = {}, identity) {
    const folder = await folderOf(locationId, identity, 'write', path);
    assertNewName(name);
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
    if (maxBytes == null) assertAttachmentSize(store.state, 4 * Math.ceil(body.length / 3));
    else if (body.length > maxBytes)
      throw new DataError(
        `The file exceeds the maximum upload size of ${Math.round(maxBytes / 1048576)} MB.`,
        413,
        'SharePointFileTooLarge',
      );
    const key = `${folder}/${encodeSegment(name)}`;
    const storage = storageOf(api);
    return withDocumentName(storage, key, 'file', async () => {
      const claim = await claimName(storage, key, 'file', { now: apiNow(api) });
      if (claim.kind === 'folder') throw sameNameExists();
      // A folder created before name claims existed still holds its name.
      if (await storage.head(`${key}/${FOLDER_MARKER}`)) {
        if (claim.claimed) await releaseName(storage, key);
        throw sameNameExists();
      }
      let stored;
      const stopKeeping = keepClaim(api, storage, key, 'file');
      try {
        stored = await storage.put(key, body, {
          contentType: contentType ?? 'application/octet-stream',
          metadata: { name },
          ...(ifMatch !== undefined ? { ifMatch } : {}),
        });
      } catch (error) {
        stopKeeping();
        if (claim.claimed) await releaseName(storage, key);
        throw error;
      }
      stopKeeping();
      return {
        name,
        size: stored.size,
        etag: stored.etag,
        contentType: stored.contentType,
        lastModified: stored.lastModified,
      };
    });
  }

  async function remove(locationId, name, { ifMatch, path = [] } = {}, identity) {
    const folder = await folderOf(locationId, identity, 'write', path);
    assertName(name);
    const storage = storageOf(api);
    const key = `${folder}/${encodeSegment(name)}`;
    const existed = await storage.delete(key, ifMatch !== undefined ? { ifMatch } : {});
    if (!existed) throw new DataError(`The document '${name}' does not exist in this location.`, 404, 'NotFound');
    await releaseName(storage, key);
    return { deleted: true };
  }

  async function download(locationId, name, identity, { path = [] } = {}) {
    const folder = await folderOf(locationId, identity, 'read', path);
    assertName(name);
    const missing = () => new DataError(`The document '${name}' does not exist in this location.`, 404, 'NotFound');
    let found;
    try {
      found = await storageOf(api).get(`${folder}/${encodeSegment(name)}`);
    } catch (error) {
      if (error?.code === 'NotFound' || error?.status === 404) throw missing();
      throw error;
    }
    if (!found) throw missing();
    // Providers answer the body as a stream (async iterable) or bytes.
    const chunks = [];
    if (found.body && typeof found.body[Symbol.asyncIterator] === 'function')
      for await (const chunk of found.body) chunks.push(Buffer.from(chunk));
    else if (found.body) chunks.push(Buffer.from(found.body));
    return {
      name: found.metadata?.name ?? name,
      bytes: Buffer.concat(chunks),
      contentType: found.contentType ?? 'application/octet-stream',
    };
  }

  return {
    locationsFor,
    ensureLocation,
    listDocuments,
    createFolder,
    deleteFolder,
    upload,
    download,
    delete: remove,
    describe: () => describe(api),
    diagnostics: () => [...stateOf(api).diagnostics],
  };
}

/** install(api, { storage, diagnostic }): storage is a storage router (forRoute) or one provider. */
function install(api, options = {}) {
  const state = stateOf(api);
  const storage = options.storage ?? api.providers?.storage ?? null;
  if (storage) state.storage = typeof storage.forRoute === 'function' ? storage : guardProvider(storage);
  else state.storage = null;
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
  const storageLevel = api && stateOf(api).storage ? 'behaviour' : 'contract';
  return {
    name: 'sharepoint-documents',
    version: 1,
    kind: 'dataverse-extension',
    level: storageLevel,
    operations: [
      { name: 'locationsFor', level: 'behaviour' },
      ...['ensureLocation', 'listDocuments', 'upload', 'delete', 'createFolder', 'deleteFolder'].map((name) => ({
        name,
        level: storageLevel,
      })),
      // createPortalDocumentService: the markup, services and failure shapes F7 recorded with the integration off; the answers
      // with it on (item values, success statuses) are local.
      { name: 'powerPagesDocumentControl', level: 'contract' },
      { name: 'autoFolderNaming', level: 'contract' },
    ],
    requires: [`provider:storage/${ROUTE}`, `table:${LOCATION}`],
    principal: 'caller',
    stateOwner: 'store',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'sharepoint-documents', install, reset, describe };

// ---- Power Pages document control: the platform's markup and its /_services/sharepoint-* services over this module,
// the portal's table permissions and its upload settings (hosted session F7, summary-F7.md sections 1-4). Mounted by the
// host before the native services; PORTAL_DOCUMENTS_ROUTE is the local download route a listed file's Url names.
export const PORTAL_DOCUMENTS_ROUTE = '/_apps/portal-documents/';
const SERVICE_ROUTE = /^\/_services\/sharepoint-(data\.json|addfiles|addfolder|deleteitem)\/[^/]+\/?$/i;
const MB = 1048576;
const siteSetting = (portal, name) => {
  const entry = Object.entries(portal?.settings ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  return entry?.value ?? entry ?? null;
};
const positive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The upload limits in MB the control renders and the services apply. SharePoint/MaxUploadSize: default 10, capped at
 * 50 (F7: 60 rendered 50, 5 rendered 5; Learn). SharePoint/MaxTotalUploadSize: 50; F7 recorded 20 and 7 both rendering 50,
 * so a lower value does not lower it, and a higher one raises it (Learn: the setting configures the total).
 */
function sharePointUploadLimits(portal) {
  return {
    file: Math.min(positive(siteSetting(portal, 'SharePoint/MaxUploadSize')) ?? 10, 50),
    total: Math.max(positive(siteSetting(portal, 'SharePoint/MaxTotalUploadSize')) ?? 50, 50),
  };
}

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
// The platform's indented dialog targets keep their CR LF line breaks as character references.
const crlfAttribute = (value) => escapeHtml(value).replaceAll('\n', '&#13;&#10;');

const actionMenu =
  '<td aria-label="action menu">{{#unless IsParent}}<div class="{{#if @last}} dropup {{else}} dropdown {{/if}}"><button aria-expanded="false" aria-label="action menu" class="btn btn-default btn-sm" data-bs-toggle="dropdown" href="#" role="button"><span class=\'fa fa-chevron-circle-down fa-fw\' aria-hidden=\'true\'></span></button><ul class="dropdown-menu" role="menu"><li role="presentation"><a class="dropdown-item delete-link" href="#" role="menuitem" tabindex="-1"><span class=\'fa-solid fa-trash-can\' aria-hidden=\'true\'></span>Delete</a></li></ul></div>{{/unless}}</td>';
// The platform's list template (Handlebars), as F7 recorded it; without delete it has no action column.
const sharePointTemplate = (canDelete) => {
  const actions = canDelete ? actionMenu : '';
  const modified =
    '<td class="postedon"><abbr class="timeago" data-datetime="{{ModifiedOnDisplay}}" title="{{ModifiedOnDisplay}}">{{ModifiedOnDisplay}}</abbr></td>';
  return `<script id="sharepoint-template" type="text/x-handlebars-template" nonce=""><div class="view-grid"><table aria-label="Document list" aria-live="polite" aria-relevant="additions" class="table-striped table"><thead><tr><th class="sort-enabled" data-sort-name="FileLeafRef"><a class="sharepoint-custom-icon" href="#"><span class='sharepoint-custom-header'>Name</span></a></th><th class="sort-enabled" data-sort-name="Modified"><a class="sharepoint-custom-icon" href="#"><span class='sharepoint-custom-header'>Modified</span></a></th>${canDelete ? '<th class="sort-disabled"><span class=\'visually-hidden\'>Actions</span></th>' : ''}</tr></thead>{{#each SharePointItems}}{{#if IsFolder}}<tr class="sp-item" data-foldername="{{Name}}" data-folderpath="{{FolderPath}}" data-id="{{Id}}"><td data-type="System.String" data-value="{{Name}}"><a class="sharepoint-custom-icon folder-link" data-folderpath="{{FolderPath}}" href="#">{{#if IsParent}}<span class='fa fa-level-up text-primary' aria-hidden='true'></span> <span class='sharepoint-custom-underline'><span> Up to{{Name}}</span></span>{{else}}<span class='fa fa-folder text-primary' aria-hidden='true'></span><span class='sharepoint-custom-underline' title='{{Name}}'><span> {{Name}} </span></span>{{/if}}</a></td>{{#if IsParent}}<td></td>{{else}}${modified}{{/if}}${actions}</tr>{{else}}<tr class="sp-item" data-filename="{{Name}}" data-id="{{Id}}" data-url="{{Url}}"><td data-type="System.String" data-value="{{Name}}"><a class="sharepoint-custom-icon" href="{{Url}}" target="_blank"><span class='fa fa-file-o' aria-hidden='true'></span><span class='sharepoint-custom-underline' title='{{Name}} ({{FileSizeDisplay}})'><span>{{Name}} <small>({{FileSizeDisplay}})</small></span></span></a></td>${modified}${actions}</tr>{{/if}}{{/each}}</table></div></script>`;
};

const modal = ({ className, title, body, primary }) =>
  `<section aria-hidden="true" aria-label="${title}" class="modal fade ${className}" data-bs-backdrop="static" role="dialog" tabindex="-1"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title" title="${title}">${title}</h1><button aria-label="Close" class="form-close" data-bs-dismiss="modal" style="position: absolute; top: 3%;" tabindex="0" title="Close" type="button"><span aria-hidden="true">×</span><span class="visually-hidden">Close</span></button></div><div class="modal-body">${body}</div><div class="modal-footer"><button aria-label="${primary}" class="primary btn btn-primary" tabindex="0" title="${primary}" type="button">${primary}</button><button aria-label="Cancel" class="cancel btn btn-default" data-bs-dismiss="modal" tabindex="0" title="Cancel" type="button">Cancel</button></div></div></div></section>`;

/**
 * The Document Locations subgrid as the platform renders it on an edit or read-only basic form or multistep step (F7
 * view-s0, read-s0, view-s0-read, view-s0-none, steps-s0): the grid element with the regarding record, the upload limits
 * and the four service URLs, the list template, the toolbar and the add dialogs when adding is enabled, the status
 * panels and pagination, and the delete dialogs when deleting is enabled. `canAdd`/`canDelete`: the visitor's upload and
 * delete permissions, both false on a read-only form.
 */
export function sharePointControlMarkup({ controlId, entity, id, websiteId, canAdd, canDelete, portal }) {
  const regarding = { Id: id, LogicalName: entity, Name: null, KeyAttributes: [], RowVersion: null };
  const dialogTarget = crlfAttribute(JSON.stringify({ LogicalName: entity, Id: id }, null, 2));
  const limits = sharePointUploadLimits(portal);
  const url = (service) => `/_services/sharepoint-${service}/${escapeHtml(websiteId)}`;
  const toolbar = canAdd
    ? '<a class="add-file btn btn-primary action" href="#" role="button"><span class="fa fa-plus-circle" aria-hidden="true"></span> Add files</a><a class="add-folder btn btn-info action" href="#" role="button"><span class="fa fa-folder" aria-hidden="true"></span> New folder</a>'
    : '';
  const panel = (name, text, alert = 'alert-danger') =>
    `<div class="sharepoint-${name} message" role="presentation" style="display: none;" tabindex="0"><div class="alert alert-block ${alert}">${text}</div></div>`;
  const addDialogs = canAdd
    ? modal({
        className: 'modal-add-file',
        title: 'Add files',
        primary: 'Add files',
        body: `<div class="  add-file" data-bs-target="${dialogTarget}" data-url="${url('addfiles')}"><div class="margin-addfile row mb-3"><label class="control-label-addfile col-md-3">Choose files</label><div class="col-md-9"><input aria-label="Choose files" multiple="multiple" name="file" type="file"></div></div><div class="row mb-3"><div class="col-md-3"></div><div class="col-md-9 checkbox"><label><input checked="checked" name="overwrite" type="checkbox">Overwrite existing files</label></div></div><div class="padding-destinationfile destination-group row mb-3"><label class="control-label-addfile col-md-3">Destination</label><div class="col-md-9"><p class="form-control-static-addfile destination-folder"></p></div></div></div>`,
      }) +
      modal({
        className: 'modal-add-folder',
        title: 'New folder',
        primary: 'Create folder',
        body: `<div class="  add-folder" data-bs-target="${dialogTarget}" data-url="${url('addfolder')}"><div class="row mb-3"><div class="col-md-3 text-right table-info required"><label class="col-form-label fw-bold" for="FolderName">Name</label></div><div class="col-md-9"><input aria-label="Name" aria-required="true" autocomplete="nope" class="form-control" id="FolderName" placeholder="Name" type="text"></div></div><div class="destination-group row mb-3"><label class="col-form-label fw-bold col-md-3">Destination</label><div class="col-md-9"><p class="form-control-plaintext destination-folder"></p></div></div></div>`,
      })
    : '';
  const deleteDialogs = canDelete
    ? modal({
        className: 'modal-delete modal-delete-file',
        title: 'Delete file',
        primary: 'Delete',
        body: '<p>Are you sure you want to permanently delete this file?</p>',
      }) +
      modal({
        className: 'modal-delete modal-delete-folder',
        title: 'Delete folder',
        primary: 'Delete',
        body: '<p>Are you sure you want to permanently delete this folder and all of its contents?</p>',
      })
    : '';
  return `<div id="${escapeHtml(controlId)}" class="subgrid"><div class="subgrid sharepoint-grid" data-add-enabled="${canAdd ? 'True' : 'False'}" data-bs-target="${escapeHtml(JSON.stringify(regarding))}" data-delete-enabled="${canDelete ? 'True' : 'False'}" data-maxfileuploadsize="${limits.file}" data-maxtotaluploadsize="${limits.total}" data-pagesize="10" data-url-add-files="${url('addfiles')}" data-url-add-folder="${url('addfolder')}" data-url-delete="${url('deleteitem')}" data-url-get="${url('data.json')}">${sharePointTemplate(canDelete)}<div class="view-toolbar grid-actions clearfix"><div class="float-end">${toolbar}</div></div><ol class="breadcrumb sharepoint-breadcrumbs" style="display: none;"></ol><div class="sharepoint-data"></div>${panel('empty', 'There are no folders or files to display.', 'alert-warning')}${panel('access-denied', 'You don’t have permissions to view these files and folders.')}${panel('config-error', 'SharePoint integration is not enabled. Please contact your system administrator for more details.')}${panel('error', 'Error completing request. <span class="details"></span>')}<div class="sharepoint-loading message text-center" role="presentation" tabindex="0"><span class="fa fa-spinner fa-pulse" aria-hidden="true"></span> Loading...</div><div class="sharepoint-pagination" data-current-page="1" data-pages="1" data-pagesize="10"></div>${addDialogs}${deleteDialogs}</div></div>`;
}

// The error a handler answered itself, read by the request's http root (server.mjs, D-R3-4).
const HTTP_ERROR = Symbol.for('paqvilo.mirage.httpError');
// The services answer with the page no-cache policy and frame confinement (F7 response headers).
const SERVICE_HEADERS = {
  'cache-control': 'no-cache, no-store, must-revalidate',
  expires: '-1',
  pragma: 'no-cache',
  'x-frame-options': 'SAMEORIGIN',
  'x-sim-route': 'portal-documents',
};
function send(res, status, body, headers = {}) {
  if (res.headersSent) {
    res.end();
    return true;
  }
  if (body != null && typeof body !== 'string') return sendJson(res, status, body, headers);
  const bytes = body == null ? null : Buffer.from(body);
  res.writeHead(status, { ...SERVICE_HEADERS, 'content-length': bytes?.length ?? 0, ...headers });
  res.end(bytes ?? undefined);
  return true;
}
// A JSON body (the { Message } envelope with an error's text included) always answers as JSON, never as markup.
function sendJson(res, status, body, headers) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    ...SERVICE_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    ...headers,
  });
  res.end(bytes);
  return true;
}
// The platform's { Message } envelope.
const message = (res, status, text, code = 'SharePointDocuments') => {
  if (status >= 400) res[HTTP_ERROR] = { code, message: text };
  return send(res, status, { Message: text });
};
const NOT_ENABLED = 'SharePoint integration is not enabled. Please contact your system administrator for more details.';
const WRITE_DENIED = 'Permission denied. You do not have the appropriate table permissions to write SharePoint files.';
const DELETE_DENIED = 'Permission denied. You do not have the appropriate table permissions to delete this record.';
const NO_LOGICAL_NAME = 'LogicalName is required when entity id is not specified';
// F7 recorded only this page's title: a write without its anti-forgery token, or Add files without a file.
const ERROR_PAGE_TITLE = "We're sorry, but something went wrong (500)";
const errorPage = (res, code) => {
  res[HTTP_ERROR] = { code, message: ERROR_PAGE_TITLE };
  return send(res, 500, `<!DOCTYPE html><html><head><title>${ERROR_PAGE_TITLE}</title></head><body></body></html>`, {
    'content-type': 'text/html; charset=utf-8',
  });
};
// A list request the platform does not admit (no X-Requested-With, or no valid anti-forgery token) is an authentication
// challenge: an AJAX request gets 200 with the 401 in x-responded-json, another a 302 to the sign-in page (F7
// data-no-token, data-not-ajax).
function challenge(req, res, url, origin) {
  const location = `${origin ?? ''}/SignIn?ReturnUrl=${encodeURIComponent(url.pathname + url.search)}`;
  res[HTTP_ERROR] = { code: 'SharePointListChallenge', message: 'The list request was not admitted.' };
  if (/xmlhttprequest/i.test(req.headers['x-requested-with'] ?? ''))
    return send(res, 200, null, { 'x-responded-json': JSON.stringify({ status: 401, headers: { location } }) });
  return send(res, 302, null, { location });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new DataError('The request is too large.', 413, 'SharePointFileTooLarge');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const jsonBody = (bytes) => {
  try {
    const value = JSON.parse(bytes.toString('utf8') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};
// A service folderPath ("a/b", relative to the record folder): each name is checked (no "..", no separators).
function folderPathOf(value) {
  const path = String(value ?? '')
    .split('/')
    .filter(Boolean);
  if (path.length > MAX_FOLDER_DEPTH)
    throw new DataError('The folder path is not valid.', 400, 'SharePointInvalidName');
  for (const segment of path) assertFolderName(segment);
  return path;
}
const sizeDisplay = (bytes) => `${Math.max(1, Math.round(Number(bytes ?? 0) / 1024))} KB`;
const isoSeconds = (value) => (value ? new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z') : null);

// A write's form fields and files: Add files posts multipart form data, bounded by the rendered total plus the form
// overhead; the other services post a JSON body. A declared length over the bound is refused before any body is read.
async function readWriteRequest(action, req, limits) {
  const limit = action === 'addfiles' ? limits.total * MB + MB : 1 * MB;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit)
    throw new DataError(
      `The files exceed the maximum total upload size of ${limits.total} MB.`,
      413,
      'SharePointFileTooLarge',
    );
  if (action !== 'addfiles') return { fields: jsonBody(await readBody(req, 1 * MB)), files: [] };
  const contentType = String(req.headers['content-type'] ?? '');
  const bytes = await readBody(req, limit);
  const data = await new Response(bytes, { headers: { 'content-type': contentType } }).formData().catch(() => null);
  const fields = {};
  const files = [];
  for (const [name, value] of data ?? []) {
    if (typeof value === 'string') fields[name] ??= value;
    else if (name === 'files' && (value.size || value.name)) files.push(value);
  }
  return { fields, files };
}
// A write's admission and body: the token header is checked before any body is read; Add files may carry its token as a
// form field instead, so a request without the header is read, bounded by its declared length and the limit, before its
// field is checked; Add files needs a file. A refused request answers { refused: <error page code> }.
async function readAdmittedWrite(action, req, accepted, limits) {
  const header = req.headers.__requestverificationtoken;
  if ((header !== undefined || action !== 'addfiles') && !accepted(header))
    return { refused: 'MissingPortalRequestVerificationToken' };
  const request = await readWriteRequest(action, req, limits);
  if (header === undefined && !accepted(request.fields.__RequestVerificationToken))
    return { refused: 'MissingPortalRequestVerificationToken' };
  if (action === 'addfiles' && !request.files.length) return { refused: 'SharePointNoFile' };
  return request;
}
// The record a write names: Add files' form fields, else the JSON body's regarding.
const writeRegarding = (action, fields) =>
  action === 'addfiles'
    ? { LogicalName: fields.regardingEntityLogicalName, Id: fields.regardingEntityId }
    : (fields.regarding ?? {});
// Add files' checks before anything is stored: each file's name, the blocked extensions, the file limit and the total.
function assertUploadable(files, limits, blocked) {
  let total = 0;
  for (const file of files) {
    assertNewName(file.name);
    const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    if (extension && blocked.includes(extension))
      throw new DataError('Attachment extension is blocked by the organization.', 400, 'AttachmentTypeBlocked');
    total += file.size;
    const fileTooLarge = file.size > limits.file * MB;
    if (fileTooLarge || total > limits.total * MB)
      throw new DataError(
        `The file exceeds the maximum upload size of ${fileTooLarge ? limits.file : limits.total} MB.`,
        413,
        'SharePointFileTooLarge',
      );
  }
}

/**
 * createPortalDocumentService({ sharepoint, store, portal, access, blockedExtensions, diagnostic }) -> { handle(req, res, url, ctx) }.
 * `sharepoint` is api.sharepoint of the organization (this module); `access(store, target, identity)` is permissions.mjs
 * portalDocumentAccess; `portal()` answers the effective portal (site settings); `blockedExtensions()` the organization
 * list. ctx: { identity, csrf | tokenAccepted, origin }.
 * Services (POST; any other method answers 404 empty), in the order hosted session F7 recorded:
 *   sharepoint-data.json  { regarding, sortExpression, page, pageSize, folderPath } -> { SharePointItems, PageSize,
 *     PageNumber, PagingInfo, TotalCount, AccessDenied, ConfigError }: admission (X-Requested-With and the token header,
 *     else the sign-in challenge), regarding (500 without one), the record and its Read permission (else AccessDenied),
 *     the integration (500), then Mirage's child Read rule (AccessDenied) and the folder listing.
 *   sharepoint-addfolder  { regarding, name, folderPath }, sharepoint-deleteitem { regarding, id, folderPath },
 *   sharepoint-addfiles   multipart regardingEntityLogicalName, regardingEntityId, files (one per file), overwrite,
 *     __RequestVerificationToken [, folderPath (local)]:
 *     the token (header or field, else the 500 page), Add files' file (else the 500 page), the record (500 "Sequence
 *     contains no elements"), the write or delete permission (400), New folder's empty name (204), the integration (500),
 *     then the operation (204; failures as { Message } with the module's status).
 * Local route: GET PORTAL_DOCUMENTS_ROUTE<table>/<id>/<name>[?folder=a/b] answers a listed file's bytes; any other member
 * of it answers 501 PortalDocumentMemberUnsupported.
 */
/* NOSONAR: preserve asynchronous lifecycle and concurrent operation ordering */ export function createPortalDocumentService({
  sharepoint,
  store,
  portal = () => ({}),
  access,
  blockedExtensions = () => [],
  diagnostic = null,
}) {
  const system = { admin: true }; // the portal's own permission check runs first; the organization call acts as the site
  // The environment's SharePoint integration: on with the storage route, unless observed off (sharePointIntegration).
  const integrationOn = () =>
    store.observed?.sharePointIntegration !== 'off' && sharepoint.describe().level === 'behaviour';
  const locationOf = (logical, id) =>
    activeLocations(
      store,
      (item) => sameId(refId(item.regardingobjectid), id) && lower(item.regardingobjectid?.logical_name) === logical,
    )[0] ?? null;
  // The regarding record: { logical, row } or null when its table or row does not exist.
  const recordOf = (logicalName, id) => {
    let mapping;
    try {
      mapping = store.resolveMapping(lower(logicalName));
    } catch {
      return null;
    }
    const row = id ? store.tableRows(mapping.logicalName).find((item) => sameId(item[mapping.idColumn], id)) : null;
    return row ? { logical: mapping.logicalName, mapping, row, id: row[mapping.idColumn] } : null;
  };
  // Whether the visitor reads every row of the table (a read rule that needs no link to the visitor or a parent).
  const tableReadable = (logicalName, identity) => {
    let mapping;
    try {
      mapping = store.resolveMapping(lower(logicalName));
    } catch {
      return false;
    }
    return Boolean(store.allowed?.(mapping.logicalName, 'read', { [mapping.idColumn]: null }, identity));
  };
  const span = (target, facts) => {
    const current = store.traces?.enabled ? store.traces.current() : null;
    if (!current) return;
    if (target) current.setEntity(target.logical, String(target.id));
    current.set({ documents: 'sharepoint', ...facts });
  };

  async function list(req, res, url, { identity, accepted, origin }) {
    if (
      !/xmlhttprequest/i.test(req.headers['x-requested-with'] ?? '') ||
      !accepted(req.headers.__requestverificationtoken)
    )
      return challenge(req, res, url, origin);
    const body = jsonBody(await readBody(req, 1 * MB));
    const regarding = body.regarding ?? {};
    if (!regarding.Id && !regarding.LogicalName) return message(res, 500, NO_LOGICAL_NAME, 'SharePointNoRegarding');
    const page = Math.max(1, Math.trunc(Number(body.page)) || 1);
    const pageSize = Math.max(1, Math.trunc(Number(body.pageSize)) || 10);
    const envelope = (items, total, denied) => ({
      SharePointItems: items,
      PageSize: pageSize,
      PageNumber: page,
      PagingInfo: null,
      TotalCount: total,
      AccessDenied: denied,
      ConfigError: false,
    });
    const target = recordOf(regarding.LogicalName, regarding.Id);
    span(target, { transfer: 'list' });
    if (!target || !store.allowed(target.logical, 'read', target.row, identity))
      return send(res, 200, envelope([], 0, true));
    if (!integrationOn()) return message(res, 500, NOT_ENABLED, 'SharePointIntegrationDisabled');
    const path = folderPathOf(body.folderPath);
    const location = locationOf(target.logical, target.id);
    if (!access(store, { entity: target.logical, row: target.row, location }, identity).list)
      return send(res, 200, envelope([], 0, true));
    if (!location && path.length)
      throw new DataError(`The folder '${path.join('/')}' does not exist in this location.`, 404, 'NotFound');
    const entries = location
      ? await sharepoint.listDocuments(location.sharepointdocumentlocationid, system, { path })
      : [];
    // Local: folders first, each group in the requested order (FileLeafRef: the name; Modified: the change time).
    const [field, direction] = String(body.sortExpression ?? 'FileLeafRef ASC').split(/\s+/);
    const sign = /^desc$/i.test(direction ?? '') ? -1 : 1;
    const compare = (a, b) =>
      Number(Boolean(b.folder)) - Number(Boolean(a.folder)) ||
      sign *
        (/^modified$/i.test(field)
          ? Date.parse(a.lastModified ?? 0) - Date.parse(b.lastModified ?? 0)
          : a.name.localeCompare(b.name));
    const folder = path.join('/');
    const items = entries.toSorted(compare).map((entry) => {
      const FolderPath = entry.folder ? [...path, entry.name].join('/') : folder;
      const query = folder ? `?folder=${encodeURIComponent(folder)}` : '';
      const download = `${PORTAL_DOCUMENTS_ROUTE}${encodeURIComponent(target.logical)}/${encodeURIComponent(lower(target.id))}/${encodeURIComponent(entry.name)}${query}`;
      return {
        Id: entry.name,
        Name: entry.name,
        IsFolder: Boolean(entry.folder),
        IsParent: false,
        FolderPath,
        Url: entry.folder ? null : download,
        FileSizeDisplay: entry.folder ? null : sizeDisplay(entry.size),
        ModifiedOnDisplay: isoSeconds(entry.lastModified),
      };
    });
    return send(res, 200, envelope(items.slice((page - 1) * pageSize, page * pageSize), items.length, false));
  }

  async function write(action, req, res, { identity, accepted }) {
    const limits = sharePointUploadLimits(portal());
    const request = await readAdmittedWrite(action, req, accepted, limits);
    if (request.refused) return errorPage(res, request.refused);
    const { fields, files } = request;
    const regarding = writeRegarding(action, fields);
    if (!regarding.Id && !regarding.LogicalName) return message(res, 500, NO_LOGICAL_NAME, 'SharePointNoRegarding');
    const target = recordOf(regarding.LogicalName, regarding.Id);
    span(target, { transfer: { addfiles: 'upload', addfolder: 'create-folder', deleteitem: 'delete' }[action] });
    const deleting = action === 'deleteitem';
    const denied = () => message(res, 400, deleting ? DELETE_DENIED : WRITE_DENIED, 'PermissionDenied');
    // F7 recorded the missing record's 500 for a visitor who reads the whole table. Inferred (an existing record the
    // visitor cannot read was not recorded): any other visitor gets the permission answer for a missing record too, so
    // the answer never tells whether a record exists.
    if (!target) return missingRecord(res, regarding.LogicalName, identity, denied);
    let location = locationOf(target.logical, target.id);
    const allowed = access(store, { entity: target.logical, row: target.row, location }, identity);
    if (!(deleting ? allowed.delete : allowed.upload)) return denied();
    if (action === 'addfolder' && !String(fields.name ?? '')) return send(res, 204, null);
    if (!integrationOn()) return message(res, 500, NOT_ENABLED, 'SharePointIntegrationDisabled');
    const path = folderPathOf(fields.folderPath);
    if (!location && path.length)
      throw new DataError(`The folder '${path.join('/')}' does not exist in this location.`, 404, 'NotFound');
    const ensure = async () =>
      (location ??= await sharepoint.ensureLocation({ logicalName: target.logical, id: target.id }, {}, system));
    if (action === 'addfolder') return addFolder(res, fields, path, ensure);
    if (deleting) return deleteItem(res, fields, { target, location, path });
    return addFiles(res, files, fields, { target, path, ensure, limits });
  }

  const missingRecord = (res, logicalName, identity, denied) =>
    tableReadable(logicalName, identity) ? message(res, 500, 'Sequence contains no elements', 'NotFound') : denied();

  // New folder: the name and the depth limit, then the folder under the record location (created on first use).
  async function addFolder(res, fields, path, ensure) {
    assertNewName(fields.name);
    if (path.length >= MAX_FOLDER_DEPTH)
      throw new DataError(`Folders nest at most ${MAX_FOLDER_DEPTH} levels.`, 400, 'SharePointInvalidName');
    await sharepoint.createFolder((await ensure()).sharepointdocumentlocationid, { path, name: fields.name }, system);
    return send(res, 204, null);
  }

  // Delete: the listed file or folder of that name in the folder path.
  async function deleteItem(res, fields, { target, location, path }) {
    const name = String(fields.id ?? '');
    assertName(name);
    if (!location) throw new DataError('The record has no documents.', 404, 'NotFound');
    const entry = (await sharepoint.listDocuments(location.sharepointdocumentlocationid, system, { path })).find(
      (item) => lower(item.name) === lower(name),
    );
    if (!entry) throw new DataError(`The document '${name}' does not exist in this location.`, 404, 'NotFound');
    if (entry.folder) await sharepoint.deleteFolder(location.sharepointdocumentlocationid, [...path, name], system);
    else await sharepoint.delete(location.sharepointdocumentlocationid, name, { path }, system);
    span(target, { fileName: name });
    return send(res, 204, null);
  }

  // Add files: each file's name, the blocked extensions and the file limit; the total is the rendered one. Without
  // overwrite, a name that exists in the folder refuses the whole request before any file is stored.
  async function addFiles(res, files, fields, { target, path, ensure, limits }) {
    assertUploadable(files, limits, blockedExtensions());
    const folder = (await ensure()).sharepointdocumentlocationid;
    if (fields.overwrite !== 'true') {
      const existing = new Set(
        (await sharepoint.listDocuments(folder, system, { path })).map((item) => lower(item.name)),
      );
      if (files.some((file) => existing.has(lower(file.name)))) throw sameNameExists();
    }
    for (const file of files) {
      const stored = await sharepoint.upload(
        folder,
        {
          name: file.name,
          bytes: Buffer.from(await file.arrayBuffer()),
          contentType: file.type || 'application/octet-stream',
          maxBytes: limits.file * MB,
          path,
        },
        system,
      );
      span(target, { fileName: stored.name, fileSize: stored.size, mimetype: stored.contentType ?? null });
    }
    return send(res, 204, null);
  }

  // A listed file's bytes (the local stand-in for its SharePoint URL): the list rule and the integration apply.
  async function download(req, res, url, identity) {
    const parts = url.pathname
      .slice(PORTAL_DOCUMENTS_ROUTE.length)
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    if (req.method !== 'GET' || parts.length !== 3)
      return send(res, 501, {
        error: {
          code: 'PortalDocumentMemberUnsupported',
          message: 'This document control member is not available locally.',
        },
      });
    const [table, id, name] = parts;
    const path = folderPathOf(url.searchParams.get('folder'));
    // A missing record, one the visitor may not list the documents of, and a record without documents answer alike, so
    // the route never tells whether a record exists.
    const missing = () => new DataError(`The document '${name}' does not exist in this location.`, 404, 'NotFound');
    const target = recordOf(table, id);
    span(target, { transfer: 'download', fileName: name });
    const location = target ? locationOf(target.logical, target.id) : null;
    if (!target || !access(store, { entity: target.logical, row: target.row, location }, identity).list)
      throw missing();
    if (!integrationOn())
      throw new DataError('SharePoint integration is not enabled.', 500, 'SharePointIntegrationDisabled');
    if (!location) throw missing();
    const file = await sharepoint.download(location.sharepointdocumentlocationid, name, system, { path });
    span(target, { fileName: file.name, fileSize: file.bytes?.length ?? null, mimetype: file.contentType ?? null });
    res.writeHead(200, {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'no-store',
      'x-sim-route': 'portal-documents',
    });
    res.end(Buffer.from(file.bytes ?? []));
    return true;
  }

  // tokenAccepted(value): whether a token (header or form field) is this request's portal token; by default it is `csrf`.
  async function /* NOSONAR */ handle(
    req,
    res,
    url,
    { identity = {}, csrf = null, tokenAccepted, origin = null } = {},
  ) {
    const accepted = tokenAccepted ?? ((value) => sameToken(value, csrf));
    const service = SERVICE_ROUTE.exec(url.pathname);
    const local = url.pathname.toLowerCase().startsWith(PORTAL_DOCUMENTS_ROUTE);
    if (!service && !local) return false;
    try {
      if (local) return await download(req, res, url, identity);
      if (req.method !== 'POST') return send(res, 404, null);
      const action = service[1].toLowerCase();
      if (action === 'data.json') return await list(req, res, url, { identity, accepted, origin });
      return await write(action, req, res, { identity, accepted });
    } catch (error) {
      // Only a DataError's own message reaches the visitor; any other failure answers a generic message, its detail stays
      // in the local diagnostics.
      const known = error instanceof DataError;
      if (!known)
        diagnostic?.({
          code: 'SHAREPOINT_SERVICE_FAILED',
          severity: 'error',
          message: String(error?.stack ?? error),
        });
      const status = known ? (error.status ?? 500) : 500;
      const text = known ? error.message : 'Error completing request.';
      const code = known ? (error.code ?? 'SharePointDocuments') : 'SharePointDocumentsFailed';
      if (local) return send(res, status, { error: { code, message: text } });
      return message(res, status, text, code);
    }
  }
  return { handle };
}
