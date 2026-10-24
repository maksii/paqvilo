// Mobile offline for the model-driven host: the Solution's mobile offline profile decides which rows a staff session
// downloads, Xrm.WebApi.offline reads and writes that copy while the session is offline, and going online replays the
// queued writes through the organization's Web API (the records pipeline, as the staff user) and downloads again.
// Only the device is simulated: the offline copy is a server-side store per staff session and app.
//
// Platform rules reproduced:
// - Profile items: RecordDistributionCriteria 0 Download related data only, 1 All records, 2 Other data filter, 3 Custom
//   data filter; RecordsOwnedByMe/MyTeam/MyBusinessUnit; ProfileItemEntityFilter; SyncIntervalInMinutes 5..1440; item
//   associations name their SelectedRelationShipsSchema.
// - Filters: a related-rows-only table must itself be in the profile; a selected relationship downloads the related rows
//   following it (up to 15 related tables); a custom filter on a related-rows table is treated as an OR.
// - Client API: Xrm.WebApi.offline works only for tables in the user's offline profile, with basic validation only
//   (lower-case existing columns, data types, no duplicate GUID, the record exists); in offline mode Xrm.WebApi reads the
//   offline data store.
// - Conflicts: with conflict detection off (organization.isconflictdetectionenabledformobileclient, default False) the
//   offline change wins; with it on the server change wins and the user sees a sync conflict error; plug-in or validation
//   failures revert the change locally and are reported as sync errors.
import { randomUUID } from 'node:crypto';
import { DataStore } from '../data.mjs';
import { parseSolutionXml, serializeXml } from '../solution-xml.mjs';
import { HIERARCHY_OPERATORS, dataverseFetchOperator } from '../dataverse-conditions.mjs';

const API = '/api/data/v9.2';
const ADMIN = Object.freeze({ admin: true });
const NAME = /^[a-z_][a-z\d_]*$/;
const GUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const RELATED_LIMIT = 15;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const bare = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const now = () => new Date().toISOString();

// A custom filter is the FetchXML `<filter>`/`<link-entity>` content of the item's table, from a `<fetch>` document or a bare
// `<filter>` (the exported ProfileItemEntityFilter text format is a guess; both shapes are accepted): { text, nodes }.
function customFilter(text, entity) {
  let root;
  try { root = parseSolutionXml(String(text)); } catch { return null; }
  if (root.name === 'filter') return { text: serializeXml(root), nodes: [root] };
  const target = root.name === 'fetch' ? root.children.find(item => item.name === 'entity') : null;
  if (!target || target.attrs.name !== entity) return null;
  const parts = target.children.filter(item => item.name === 'filter' || item.name === 'link-entity');
  return parts.length ? { text: parts.map(serializeXml).join(''), nodes: parts } : null;
}
// Why the download query cannot run a custom filter, or null: every condition operator must be one the organization's
// FetchXML runs for the staff user (dataverse-conditions.mjs), and every link-entity must join a table of the profile. A
// record hierarchy operator (under, above...) runs on a table whose metadata has a hierarchical self-referencing one-to-many
// relationship (hierarchical(table): IsHierarchical); on any other table the organization's FetchXML refuses it, so it is
// a gap there only.
function filterGap(nodes, entity, profileTables, hierarchical = () => false) {
  // [node, the table its conditions apply to]: the link-entity's own table, or the aliased table a condition names (entityname).
  const aliases = new Map();
  const walk = (node, table) => {
    const own = node.name === 'link-entity' ? node.attrs.name : table;
    if (node.name === 'link-entity' && node.attrs.alias) aliases.set(node.attrs.alias, node.attrs.name);
    return [[node, own], ...(node.children ?? []).flatMap(child => walk(child, own))];
  };
  for (const [node, table] of nodes.flatMap(root => walk(root, entity))) {
    const operator = String(node.attrs.operator ?? 'eq');
    const target = node.attrs.entityname ? aliases.get(node.attrs.entityname) ?? node.attrs.entityname : table;
    if (node.name === 'condition' && !dataverseFetchOperator(operator) && !(HIERARCHY_OPERATORS.has(operator) && hierarchical(target)))
      return `The custom filter of ${entity} uses the condition operator ${node.attrs.operator}, which the offline download cannot evaluate${HIERARCHY_OPERATORS.has(operator) ? ` (${target} has no hierarchical relationship)` : ''}.`;
    if (node.name === 'link-entity' && profileTables && !profileTables.has(node.attrs.name))
      return `The custom filter of ${entity} joins ${node.attrs.name ?? 'a table'}, which is not in the offline profile.`;
  }
  return null;
}

/** The FetchXML filter one profile item downloads by (`filter`: '' for all rows, null for related rows only), or the
 * `reason` it cannot be evaluated. A custom filter on a related-rows item is an OR.
 * `profileTables` (the profile's table names) lets the check refuse a link-entity to a table outside the profile;
 * `hierarchical(table)` answers whether a table has a hierarchical relationship (filterGap). */
export function profileItemFilter(item = {}, { profileTables = null, hierarchical } = {}) {
  if (!NAME.test(item.entity ?? '')) return { reason: 'The profile item names no table.' };
  if ((item.relationships ?? []).length > RELATED_LIMIT) return { reason: `More than ${RELATED_LIMIT} relationships on ${item.entity} (Learn: up to ${RELATED_LIMIT} related tables).` };
  const owned = [item.ownedByMe && '<condition attribute="ownerid" operator="eq-userid"/>', item.ownedByMyTeam && '<condition attribute="ownerid" operator="eq-userteams"/>',
    item.ownedByMyBusinessUnit && '<condition attribute="owningbusinessunit" operator="eq-businessid"/>'].filter(Boolean);
  const parsed = item.filter ? customFilter(item.filter, item.entity) : null, custom = parsed?.text ?? null;
  if (item.filter && custom === null) return { reason: `The custom filter of ${item.entity} is not FetchXML for that table.` };
  const unsupported = parsed && filterGap(parsed.nodes, item.entity, profileTables instanceof Set ? profileTables : null, hierarchical);
  if (unsupported) return { reason: unsupported };
  switch (item.distribution) {
    case 1: return { filter: '' };
    case 2: return owned.length ? { filter: `<filter type="or">${owned.join('')}</filter>` }
      : { reason: `Organization rows on ${item.entity} select none of user, team or business unit rows.` };
    case 3: return custom ? { filter: custom } : { reason: `${item.entity} uses a custom filter but defines none.` };
    case 0: return { filter: custom };
    default: return { reason: `Unknown data download filter ${item.distribution} on ${item.entity}.` };
  }
}

/** Items of a profile the simulator cannot evaluate, as [{ entity, reason }] (relationships are checked at sync time). */
export const offlineProfileGaps = (profile, { hierarchical } = {}) => {
  const profileTables = new Set((profile?.items ?? []).map(item => item.entity));
  return (profile?.items ?? []).map(item => ({ entity: item.entity ?? null, reason: profileItemFilter(item, { profileTables, hierarchical }).reason })).filter(gap => gap.reason);
};
/** Whether relationship metadata (EntityDefinitions OneToManyRelationships, or Solution relationship facts) holds a
 * hierarchical self-referencing one-to-many relationship of `table`: IsHierarchical with the table on both sides. */
export const hierarchicalIn = (relationships, table) => (relationships ?? []).some(r => (r.IsHierarchical ?? r.isHierarchical) === true
  && String(r.ReferencingEntity ?? r.referencingEntity ?? '').toLowerCase() === table && String(r.ReferencedEntity ?? r.referencedEntity ?? '').toLowerCase() === table);

// A Web API row as a column row: annotations dropped, `_x_value` lookups under their column name.
const storeRow = raw => Object.fromEntries(Object.entries(raw).filter(([key]) => !key.includes('@'))
  .map(([key, value]) => { const lookup = /^_(.+)_value$/.exec(key); return [lookup ? lookup[1] : key, value]; }));

// The navigation entries of `entity` for a relationship schema name: rows of `entity` hold `from` values that rows of the
// other table carry in `to` (many-to-one: the lookup on this table; one-to-many: the lookup on the related table).
const linksOf = (tables, entity, schemaName) => Object.values(tables[entity]?.relationships ?? {})
  .filter(link => String(link.schemaName ?? '').toLowerCase() === String(schemaName).toLowerCase() && link.entity && link.from && link.to);

/** The private local state an offline session persists in: the store's `simulator.offlineSessions` section (the runtime's
 * private state file under the state directory, never pack DATA), keyed per staff user and app. `change` is the host's
 * persisting write wrapper. */
export function offlineSessionState(store, change = fn => fn()) {
  return {
    load: () => structuredClone(store.state.simulator?.offlineSessions ?? {}),
    save: (key, value) => change(() => store.transact(() => {
      const all = ((store.state.simulator ??= {}).offlineSessions ??= {});
      if (value) all[key] = value; else delete all[key];
    }, { cloneResult: false })),
  };
}

// A session as the private state keeps it, and back: the copy's mappings and rows, the queue, versions, lookup labels,
// the downloaded privileges, conflicts and errors.
const saved = session => ({ app: session.app, profile: session.profile ?? null, mode: session.mode, principal: session.principal, queue: session.queue, conflicts: session.conflicts, errors: session.errors,
  versions: [...session.versions], labels: [...session.labels], rights: session.rights, tables: session.tables, gaps: session.gaps, hierarchical: session.hierarchical ?? [], lastSync: session.lastSync,
  copy: session.db ? { mappings: session.db.state.mappings, tables: session.db.state.tables } : null });
const copyStore = copy => new DataStore({ state: { version: 1, mappings: copy.mappings, tables: copy.tables, settings: { permissionMode: 'permissive' } } });
const revived = value => ({ ...value, versions: new Map(value.versions ?? []), labels: new Map(value.labels ?? []), rights: value.rights ?? {},
  db: value.copy ? copyStore(value.copy) : null, copy: undefined, chain: Promise.resolve() });

export function createOfflineSessions({ webApi, catalogue, state = null }) {
  // Sessions persist in `state` (offlineSessionState) when the host gives one; restored per staff user and app on first use.
  const sessions = new Map();
  let restored = !state;
  const restore = () => {
    if (restored) return;
    restored = true;
    for (const [key, value] of Object.entries(state.load() ?? {})) if (!sessions.has(key) && value && typeof value === 'object') sessions.set(key, revived(value));
  };
  // ponytail: the whole session is serialized after each operation and written when it changed (O(copy)); a per-row journal
  // is the upgrade path for large copies.
  const persist = async session => {
    if (!state) return;
    const value = saved(session), text = JSON.stringify(value);
    if (text === session.savedText) return;
    await state.save(keyOf(session.principal, session.app), value);
    session.savedText = text;
  };
  const call = async (session, method, path, { body, headers = {} } = {}) => {
    if (typeof webApi !== 'function') throw fail('This host does not provide the in-process Web API that mobile offline sync uses.', 501, 'OfflineSyncUnavailable');
    const result = await webApi({ method, path, principal: session.principal, host: session.host, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
    let parsed;
    try { parsed = result.body ? JSON.parse(result.body) : null; } catch { parsed = null; }
    return { status: result.status, body: parsed };
  };
  const appOf = async appId => {
    const source = await catalogue();
    const app = (source.apps ?? []).find(candidate => candidate.id === appId);
    if (!app) throw fail('The app is not in the catalogue.', 404, 'ModelDrivenRequestInvalid');
    return { app, tables: source.tables ?? {} };
  };
  const keyOf = (principal, appId) => `${principal?.kind}:${principal?.principalId}|${appId}`;
  const sessionFor = async (principal, appId, host) => {
    restore();
    const key = keyOf(principal, appId);
    const { app, tables } = await appOf(appId);
    let session = sessions.get(key);
    if (!session) sessions.set(key, session = { app: appId, mode: 'online', principal, queue: [], conflicts: [], errors: [], versions: new Map(), labels: new Map(), rights: {}, db: null, tables: [], gaps: [], lastSync: null, chain: Promise.resolve() });
    Object.assign(session, { principal, host, profile: app.offlineProfiles?.[0] ?? null, catalogueTables: tables });
    return session;
  };
  // One operation at a time per session; the session is saved after each one (a refused one changes nothing it saves).
  const serial = (session, fn) => {
    const run = async () => { try { return await fn(); } finally { await persist(session); } };
    const next = session.chain.then(run, run); session.chain = next.catch(() => {}); return next;
  };
  const requireProfile = session => { if (!session.profile) throw fail('This app has no mobile offline profile in the sources.', 409, 'OfflineProfileMissing'); };

  async function query(session, entity, filter) {
    const table = session.catalogueTables[entity];
    if (!table?.entitySet) throw fail(`${entity} has no imported metadata or local mapping.`, 404, 'OfflineTableUnavailable');
    const fetchXml = `<fetch><entity name="${entity}"><all-attributes/>${filter}</entity></fetch>`;
    // ponytail: one page of up to 5000 rows per query (the Web API page size); paging cookies are the upgrade path.
    const response = await call(session, 'GET', `${API}/${table.entitySet}?fetchXml=${encodeURIComponent(fetchXml)}`, { headers: { prefer: 'odata.maxpagesize=5000,odata.include-annotations="OData.Community.Display.V1.FormattedValue"' } });
    if (response.status >= 400) throw fail(response.body?.error?.message ?? `The Web API answered ${response.status}.`, response.status, response.body?.error?.code);
    return response.body?.value ?? [];
  }

  // The profile tables whose organization metadata has a hierarchical relationship (EntityDefinitions OneToManyRelationships,
  // IsHierarchical), read only when a custom filter uses a record hierarchy operator.
  async function hierarchicalTables(session, items) {
    if (!items.some(item => /operator\s*=\s*["'](?:eq-or-under|eq-or-above|under|above|not-under)["']/i.test(item.filter ?? ''))) return [];
    const found = [];
    for (const entity of new Set(items.map(item => item.entity))) {
      if (!NAME.test(entity ?? '')) continue;
      const response = await call(session, 'GET', `${API}/EntityDefinitions(LogicalName='${entity}')/OneToManyRelationships`);
      if (response.status < 400 && hierarchicalIn(response.body?.value, entity)) found.push(entity);
    }
    return found;
  }
  const hierarchyOf = session => table => (session.hierarchical ?? []).includes(table);

  async function downsync(session) {
    requireProfile(session);
    const tables = session.catalogueTables, items = session.profile.items ?? [], inProfile = new Set(items.map(item => item.entity));
    session.hierarchical = await hierarchicalTables(session, items);
    const hierarchical = hierarchyOf(session);
    const rows = new Map(), versions = new Map(), labels = new Map(), gaps = offlineProfileGaps(session.profile, { hierarchical });
    const gap = (entity, reason) => { if (!gaps.some(entry => entry.entity === entity && entry.reason === reason)) gaps.push({ entity, reason }); };
    const take = (entity, list) => {
      const idColumn = tables[entity].idColumn, bucket = rows.get(entity);
      let added = 0;
      for (const raw of list) {
        const row = storeRow(raw), id = bare(row[idColumn]);
        if (!bucket.has(id)) added++;
        bucket.set(id, { ...row, [idColumn]: id });
        versions.set(`${entity}:${id}`, raw['@odata.etag'] ?? null);
        // Lookup display names as downloaded, for rows whose target is not in the offline copy.
        for (const [key, value] of Object.entries(raw)) { const lookup = /^_(.+)_value@OData\.Community\.Display\.V1\.FormattedValue$/.exec(key); if (lookup) labels.set(`${entity}:${id}:${lookup[1]}`, value); }
      }
      return added;
    };
    for (const item of items) {
      if (!tables[item.entity]) { gap(item.entity, `${item.entity} has no imported metadata or local mapping.`); continue; }
      rows.set(item.entity, rows.get(item.entity) ?? new Map());
      const { filter, reason } = profileItemFilter(item, { profileTables: inProfile, hierarchical });
      if (reason || filter === null) continue;
      // A table whose download fails is not in the copy (only tables of the profile the device holds work offline); the gap
      // says why.
      try { take(item.entity, await query(session, item.entity, filter)); } catch (error) { rows.delete(item.entity); gap(item.entity, error.message); }
    }
    // Related rows follow each selected relationship until no table grows (a related-rows table inherits its parent's rows).
    const asked = new Map();
    for (let pass = 0, grew = true; grew && pass <= items.length; pass++) {
      grew = false;
      for (const item of items) for (const name of item.relationships ?? []) {
        if (!rows.has(item.entity)) continue;
        const links = linksOf(tables, item.entity, name);
        if (!links.length) { gap(item.entity, `Relationship ${name} is not a one-to-many or many-to-one relationship of ${item.entity}.`); continue; }
        for (const link of links) {
          if (!inProfile.has(link.entity)) { gap(item.entity, `The related table ${link.entity} of ${name} is not in the offline profile.`); continue; }
          if (!rows.has(link.entity)) continue; // its download failed: already a gap
          const seen = asked.get(`${name}|${link.entity}|${link.to}`) ?? new Set();
          asked.set(`${name}|${link.entity}|${link.to}`, seen);
          const values = [...new Set([...rows.get(item.entity).values()].map(row => row[link.from]).filter(value => value != null).map(bare))].filter(value => GUID.test(value) && !seen.has(value));
          // ponytail: 500 values per `in` condition; one query per chunk.
          for (let start = 0; start < values.length; start += 500) {
            const chunk = values.slice(start, start + 500);
            chunk.forEach(value => seen.add(value));
            try { if (take(link.entity, await query(session, link.entity, `<filter><condition attribute="${link.to}" operator="in">${chunk.map(value => `<value>${value}</value>`).join('')}</condition></filter>`))) grew = true; }
            catch (error) { rows.delete(link.entity); gap(link.entity, error.message); break; }
          }
        }
      }
    }
    const mappings = Object.fromEntries([...rows.keys()].map(entity => { const table = tables[entity];
      return [entity, { entitySet: table.entitySet, idColumn: table.idColumn, nameColumn: table.nameColumn, fields: table.fields,
        relationships: Object.fromEntries(Object.entries(table.relationships ?? {}).filter(([, link]) => rows.has(link.entity))) }]; }));
    session.db = new DataStore({ state: { version: 1, mappings, tables: Object.fromEntries([...rows].map(([entity, bucket]) => [entity, [...bucket.values()]])), settings: { permissionMode: 'permissive' } } });
    // The staff user's create, update and delete privileges on each downloaded table, from its roles at download time (the
    // organization's own privilege check, webApi.privilegeError): a write the user cannot make is refused when it is queued,
    // with the error the online write answers. null: allowed.
    const rights = Object.fromEntries([...rows.keys()].map(entity => [entity, Object.fromEntries(['create', 'update', 'delete'].map(operation => {
      const error = webApi.privilegeError?.({ principal: session.principal, entity, operation }) ?? null;
      return [operation, error && { status: error.status ?? 403, code: error.details?.innerCode ?? error.code ?? null, message: error.message }];
    }))]));
    Object.assign(session, { versions, labels, gaps, rights, lastSync: now(),
      tables: items.filter(item => rows.has(item.entity)).map(item => ({ entity: item.entity, rows: rows.get(item.entity).size, syncIntervalMinutes: item.syncIntervalMinutes ?? null })) });
  }

  // Conflict detection is the organization setting, False when unset.
  async function conflictDetection(session) {
    const response = await call(session, 'GET', `${API}/organizations?$select=isconflictdetectionenabledformobileclient`);
    return response.status < 400 && response.body?.value?.[0]?.isconflictdetectionenabledformobileclient === true;
  }

  // The current sync conflict or error of one record replaces any older one; a later successful upload of the record clears
  // both (status lists current ones only).
  const settle = (session, entity, id, list = null, record = null) => {
    const other = item => !(item.entity === entity && item.id === id);
    session.conflicts = session.conflicts.filter(other); session.errors = session.errors.filter(other);
    if (list) session[list].push(record);
  };
  // Replays the queue in order, one entry at a time: an entry leaves the queue once the server answered it. An answered failure
  // is listed (412 a conflict, any other a sync error) and the replay goes on. A refusal before or instead of an answer (a 4xx
  // thrown by the pre-check or the in-process Web API: a table no longer in the catalogue, a disabled user) is an answered
  // failure too. Only a call that throws without a client-error status (no answer: transport, host) records a sync error on
  // that entry and stops, so it and every later entry stay queued for the next sync.
  async function upsync(session) {
    if (!session.queue.length) return;
    const detect = await conflictDetection(session), tables = session.catalogueTables;
    while (session.queue.length) {
      const entry = session.queue[0], table = tables[entry.entity], key = `${entry.entity}:${entry.id}`;
      const method = { create: 'POST', update: 'PATCH', delete: 'DELETE' }[entry.operation];
      // If-Match * keeps an update from creating a row the server deleted; with conflict detection the device's version
      // must still match the server's (412 otherwise: the server wins).
      const ifMatch = entry.operation === 'create' ? null : detect ? session.versions.get(key) ?? '*' : '*';
      let response;
      try {
        if (!table?.entitySet) throw fail(`${entry.entity} has no imported metadata or local mapping.`, 404, 'OfflineTableUnavailable');
        response = await call(session, method, `${API}/${table.entitySet}${entry.operation === 'create' ? '' : `(${entry.id})`}`, {
          body: entry.operation === 'delete' ? undefined : entry.body, headers: { prefer: 'return=representation', ...(ifMatch ? { 'if-match': ifMatch } : {}) } });
      } catch (error) {
        if (error.status >= 400 && error.status < 500) response = { status: error.status, body: { error: { code: error.details?.innerCode ?? error.code ?? null, message: String(error.message ?? error) } } };
        else {
        settle(session, entry.entity, entry.id, 'errors', { entity: entry.entity, id: entry.id, operation: entry.operation, status: error.status ?? null, code: error.code ?? 'OfflineSyncFailed',
          message: String(error.message ?? error), queued: true, at: now() });
        throw Object.assign(fail(`Synchronization stopped at the queued ${entry.operation} of ${entry.entity} ${entry.id}: ${error.message ?? error}`, 502, 'OfflineSyncFailed'), { recorded: true }); // native code unknown
        }
      }
      session.queue.shift();
      if (response.status < 400) {
        if (response.body?.['@odata.etag']) session.versions.set(key, response.body['@odata.etag']);
        settle(session, entry.entity, entry.id);
        continue;
      }
      settle(session, entry.entity, entry.id, response.status === 412 ? 'conflicts' : 'errors', { entity: entry.entity, id: entry.id, operation: entry.operation, status: response.status,
        code: response.body?.error?.code ?? null, message: response.body?.error?.message ?? `The Web API answered ${response.status}.`, at: now() });
    }
  }

  const available = (session, entity) => {
    if (session.mode !== 'offline') throw fail('Xrm.WebApi.offline works only while the app is offline.', 409, 'OfflineModeRequired'); // native message and code unknown
    if (!session.db?.state.mappings[entity]) throw fail(`${entity} is not available offline in this user's mobile offline profile.`, 400, 'OfflineTableUnavailable'); // native code unknown
    return session.catalogueTables[entity];
  };
  // A write the downloaded privileges refuse fails when it is queued, with the online privilege error (status, code, message).
  const permitted = (session, entity, operation) => {
    const denied = session.rights?.[entity]?.[operation];
    if (denied) throw fail(denied.message, denied.status, denied.code);
  };
  const params = (options, allowed) => {
    if (typeof options !== 'string' || options && !options.startsWith('?')) throw fail('Query options must start with ?.', 400, 'OfflineQueryInvalid');
    const result = Object.fromEntries(new URLSearchParams(options.slice(1)));
    for (const key of Object.keys(result)) if (!allowed.includes(key)) throw fail(`The offline data store does not support ${key}.`, 400, 'OfflineQueryInvalid');
    return result;
  };
  const exists = (session, entity, id) => session.db.get(entity, id, ADMIN);
  // Basic validation only, as natively offline (lower-case existing columns, lookup bindings, types through the store).
  function localValues(session, table, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw fail('Provide a record values object.', 400, 'OfflineValidationFailed');
    const values = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.endsWith('@odata.bind')) {
        const navigation = key.slice(0, -11), link = table.relationships?.[navigation];
        const column = link?.many === false ? link.from : table.fields?.[navigation]?.type === 'lookup' ? navigation : null;
        if (!column) throw fail(`${navigation} is not a lookup of ${table.entity}.`, 400, 'OfflineValidationFailed');
        if (value === null) { values[column] = null; continue; }
        const match = typeof value === 'string' && /^\/?([A-Za-z_]\w*)\(\{?([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\}?\)$/i.exec(value);
        const target = match && Object.values(session.catalogueTables).find(candidate => candidate.entitySet === match[1]);
        if (!target || (link?.entity && link.entity !== target.entity)) throw fail(`${key} needs a /<entityset>(<id>) path of its target table.`, 400, 'OfflineValidationFailed');
        values[column] = match[2].toLowerCase();
      } else if (key.includes('@') || key !== key.toLowerCase() || !Object.hasOwn(table.fields ?? {}, key)) throw fail(`Column ${key} does not exist on ${table.entity}.`, 400, 'OfflineValidationFailed');
      else values[key] = value;
    }
    return values;
  }
  const storeOptions = table => ({ coerce: true, metadata: () => table.fields });
  const operations = {
    async retrieve(session, { entity, id, options = '' }) {
      const table = available(session, entity), query = params(options, ['$select', '$expand']);
      const row = session.db.queryCore(entity, { ...query, $filter: `${table.idColumn} eq ${bare(id)}` }, ADMIN).value?.[0];
      if (!row) throw fail(`${entity} with id ${bare(id)} does not exist in the offline data store.`, 404, 'OfflineRecordNotFound'); // native code unknown
      return row;
    },
    async retrieveMultiple(session, { entity, options = '' }) {
      available(session, entity);
      const query = params(options, ['$select', '$filter', '$top', '$orderby', '$expand', 'fetchXml']);
      if (query.fetchXml && !new RegExp(`<entity\\s+name=["']${entity}["']`).test(query.fetchXml)) throw fail('The FetchXML query must target this table.', 400, 'OfflineQueryInvalid');
      // Grouping and aggregation are not supported in mobile offline.
      if (/aggregate\s*=\s*["']true/i.test(query.fetchXml ?? '')) throw fail('Grouping and aggregation are not supported offline.', 400, 'OfflineQueryInvalid');
      // ponytail: the whole result in one page; maxPageSize paging with nextLink is the upgrade path (deprecated offline).
      return { entities: session.db.queryCore(entity, query, ADMIN).value ?? [] };
    },
    async create(session, { entity, data }) {
      const table = available(session, entity);
      permitted(session, entity, 'create');
      const values = localValues(session, table, data);
      const id = values[table.idColumn] != null ? bare(values[table.idColumn]) : randomUUID();
      if (!GUID.test(id)) throw fail(`${table.idColumn} must be a GUID.`, 400, 'OfflineValidationFailed');
      if (exists(session, entity, id)) throw fail(`A ${entity} record with id ${id} already exists offline.`, 400, 'OfflineValidationFailed');
      await session.db.create(entity, { ...values, [table.idColumn]: id }, ADMIN, storeOptions(table));
      session.queue.push({ operation: 'create', entity, id, body: { ...data, [table.idColumn]: id }, at: now() });
      return { id, entityType: entity };
    },
    async update(session, { entity, id, data }) {
      const table = available(session, entity);
      permitted(session, entity, 'update');
      const values = localValues(session, table, data), key = bare(id);
      if (!exists(session, entity, key)) throw fail(`${entity} with id ${key} does not exist in the offline data store.`, 404, 'OfflineRecordNotFound');
      delete values[table.idColumn];
      await session.db.update(entity, key, values, ADMIN, storeOptions(table));
      session.queue.push({ operation: 'update', entity, id: key, body: data, at: now() });
      return { id: key, entityType: entity };
    },
    async delete(session, { entity, id }) {
      const table = available(session, entity), key = bare(id);
      permitted(session, entity, 'delete');
      if (!exists(session, entity, key)) throw fail(`${entity} with id ${key} does not exist in the offline data store.`, 404, 'OfflineRecordNotFound');
      await session.db.remove(entity, key, ADMIN, storeOptions(table));
      session.queue.push({ operation: 'delete', entity, id: key, at: now() });
      return { id: key, entityType: entity };
    },
  };

  const status = session => {
    const minutes = session.tables.map(table => table.syncIntervalMinutes).filter(Number.isFinite);
    return { app: session.app, profile: session.profile?.name ?? null, mode: session.mode, lastSync: session.lastSync,
      nextSync: session.lastSync && minutes.length ? new Date(Date.parse(session.lastSync) + Math.min(...minutes) * 60000).toISOString() : null,
      tables: session.tables, gaps: session.gaps.length ? session.gaps : offlineProfileGaps(session.profile, { hierarchical: hierarchyOf(session) }),
      queue: session.queue.map(({ operation, entity, id, body, at }) => ({ operation, entity, id, columns: Object.keys(body ?? {}), at })),
      conflicts: session.conflicts, errors: session.errors };
  };
  // Going online uploads the queue and downloads again (the device syncs when connected); going offline downloads
  // first when nothing is queued, so the copy is current when the connection drops.
  // A failure is recorded (on its queue entry, else as a sync error without an entry) and rethrown with recorded: true; a
  // successful sync clears the sync errors that named no entry.
  const sync = async session => {
    requireProfile(session);
    try { await upsync(session); await downsync(session); }
    catch (error) {
      if (!error.recorded) settle(session, null, null, 'errors', { entity: null, id: null, operation: 'sync', status: error.status ?? null, code: error.code ?? 'OfflineSyncFailed', message: String(error.message ?? error), at: now() });
      throw Object.assign(error, { recorded: true });
    }
    settle(session, null, null);
  };
  // A copy row as the shell reads it: lookup display names from the copy's target row, else as downloaded.
  const display = (session, entity, row) => {
    const table = session.catalogueTables[entity], copy = { ...row }, id = bare(row[table.idColumn]);
    for (const field of Object.values(table.fields ?? {})) {
      if (field.type !== 'lookup' || row[field.name] == null) continue;
      const target = (field.targets ?? []).map(name => session.catalogueTables[name]).find(candidate => candidate && session.db.state.mappings[candidate.entity] && session.db.get(candidate.entity, bare(row[field.name]), ADMIN));
      const name = target ? session.db.get(target.entity, bare(row[field.name]), ADMIN)[target.nameColumn] : session.labels.get(`${entity}:${id}:${field.name}`);
      if (name != null) copy[`${field.name}@OData.Community.Display.V1.FormattedValue`] = name;
    }
    return copy;
  };
  // The shell's validated form values as a Web API body (lookups as @odata.bind), so a shell save queues what a script would.
  const webApiBody = (session, table, values) => Object.fromEntries(Object.entries(values).map(([name, value]) => {
    const field = table.fields?.[name];
    if (field?.type !== 'lookup') return [name, value];
    const entity = value?.entity ?? value?.logicalName ?? value?.logical_name ?? (field.targets?.length === 1 ? field.targets[0] : undefined);
    const navigation = Object.entries(table.relationships ?? {}).find(([, link]) => link.many === false && link.from === name && (!entity || link.entity === entity))?.[0] ?? name;
    if (value == null || value === '') return [`${navigation}@odata.bind`, null];
    const target = entity && session.catalogueTables[entity];
    if (!target?.entitySet) throw fail(`Choose a record and its table for ${name}.`, 400, 'OfflineValidationFailed');
    return [`${navigation}@odata.bind`, `/${target.entitySet}(${bare(value.id ?? value)})`];
  }));
  return {
    /** The record service (dataverse-model-driven.mjs createModelDrivenRecordService shape) over the session's offline copy
     * while it is offline, else null: model-driven/data.mjs then serves the shell's grids, forms and subgrids from the copy. */
    recordsFor(principal, appId) {
      restore();
      const session = sessions.get(keyOf(principal, appId));
      if (session?.mode !== 'offline') return null;
      // A session restored from the private state reads its app's catalogue tables before its first use.
      const run = fn => serial(session, async () => { if (!session.catalogueTables) await sessionFor(principal, appId, session.host); return fn(); });
      const read = (entity, id) => {
        available(session, entity);
        const row = session.db.get(entity, bare(id), ADMIN);
        if (!row) throw fail(`${entity} with id ${bare(id)} does not exist in the offline data store.`, 404, 'OfflineRecordNotFound');
        return { row: display(session, entity, row), etag: session.versions.get(`${entity}:${bare(id)}`) ?? 'W/"offline"' };
      };
      return {
        query: (entity, fetchXml) => run(async () => {
          available(session, entity);
          const result = session.db.fetchXml(fetchXml, ADMIN);
          return { rows: (result.entities ?? []).map(row => display(session, entity, row)), total: result.total_record_count ?? -1, more: Boolean(result.more_records) };
        }),
        get: (entity, id) => run(async () => read(entity, id)),
        retrieve: (entity, id, options = '') => run(() => operations.retrieve(session, { entity, id, options })),
        list: (entity, options = '') => run(() => operations.retrieveMultiple(session, { entity, options })),
        write: ({ entity, id, values = {}, remove = false }) => run(async () => {
          const table = available(session, entity);
          if (remove) { await operations.delete(session, { entity, id }); return { deleted: true }; }
          const data = webApiBody(session, table, values);
          const saved = id ? await operations.update(session, { entity, id, data }) : await operations.create(session, { entity, data });
          return { id: saved.id, ...read(entity, saved.id) };
        }),
        // Offline rights: the copy holds only rows the user could read, and writes follow the privileges downloaded with it;
        // business validation runs on upload.
        capabilities: (entity, _actor, { fields = {} } = {}) => {
          const ok = Boolean(session.db?.state.mappings[entity]), may = operation => ok && !session.rights?.[entity]?.[operation];
          return { read: ok, create: may('create'), update: may('update'), delete: may('delete'), ...(ok ? {} : { reason: `${entity} is not available offline in this user's mobile offline profile.` }),
            fields: Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, { secured: false, read: ok, create: may('create') && !field.isPrimaryId, update: may('update') && !field.isPrimaryId }])) };
        },
      };
    },
    /** Every staff session's offline summary for /_sim/ (counts only, no row values or queued bodies). */
    list: () => { restore(); return [...sessions.values()].map(session => ({ principalId: session.principal.principalId, kind: session.principal.kind, app: session.app, profile: session.profile?.name ?? null,
      mode: session.mode, lastSync: session.lastSync, tables: session.tables.length, queue: session.queue.length, conflicts: session.conflicts.length, errors: session.errors.length })); },
    async status(principal, appId, host) { const session = await sessionFor(principal, appId, host); return serial(session, () => status(session)); },
    async setMode(principal, appId, mode, host) {
      if (!['online', 'offline'].includes(mode)) throw fail('Mode must be online or offline.', 400, 'ModelDrivenRequestInvalid');
      const session = await sessionFor(principal, appId, host);
      return serial(session, async () => {
        if (mode === 'offline') { requireProfile(session); if (!session.queue.length) await downsync(session); session.mode = 'offline'; }
        // The session is online only once the queue is uploaded and the copy downloaded again; a failed sync keeps it offline
        // with the queue and the error in its status.
        else { try { await sync(session); session.mode = 'online'; } catch (error) { if (!error.recorded) throw error; } }
        return status(session);
      });
    },
    async sync(principal, appId, host) {
      const session = await sessionFor(principal, appId, host);
      return serial(session, async () => {
        if (session.mode === 'offline') throw fail('The app is offline; go online to synchronize.', 409, 'OfflineSyncUnavailable'); // native message unknown
        try { await sync(session); } catch (error) { if (!error.recorded) throw error; }
        return status(session);
      });
    },
    async execute(principal, appId, request, host) {
      const session = await sessionFor(principal, appId, host);
      const operation = Object.hasOwn(operations, request.operation) ? operations[request.operation] : null;
      if (!operation) throw fail('Unknown offline operation.', 400, 'ModelDrivenRequestInvalid');
      return serial(session, () => operation(session, request));
    },
  };
}
