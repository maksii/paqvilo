import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { bindQualificationFixtureRequests } from './qualification-fixtures.mjs';
import { savePrivateJson } from '../portal-harness/private-journal.mjs';
import { stable } from '../portal-harness/core.mjs';
import { authoredQuery, canonicalRows, encodeArtifact, odataRequest } from '../portal-harness/core.mjs';
import { captureNativeRegistry } from '../portal-harness/native-registry.mjs';
import { decodeBatchResponse } from '../portal-harness/batch-capture.mjs';
import { planQualificationActorWrite, restoreQualificationActorWrite } from './qualification-actor-lease.mjs';

const guid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const load = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const clean = row => row && Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('@') && !/password|token|securitystamp|secret|salt/i.test(key)));
const tableOf = (plan, name) => plan.tables.find(table => table.name === name) ?? (() => { throw new Error('Undeclared fixture table.'); })();
const endpointOf = (plan, record) => `${tableOf(plan, record.table).entitySet}(${record.id})`;
const etag = row => row?.['@odata.etag'] ?? (() => { throw new Error('Conditional fixture mutation requires a native ETag.'); })();
const same = (a, b) => stable(a) === stable(b);
const targetFromBody = value => /\(([a-f0-9-]{36})\)$/i.exec(value ?? '')?.[1]?.toLowerCase();

/** Seal tested and desired objects into immutable SDK intent fields. Source5
 * must grow Variant before these records can be prepared natively. */
export function qualificationMutationIntent({ configuration, cell, request, schema }) {
  if (!request) return { caseId: configuration.query.id, variant: configuration.query.variant };
  if (!guid.test(request.target?.id ?? '')) throw new Error('An actual immutable mutation target is required.');
  const lifecycle = configuration.family === 'equipment-lifecycle';
  let caseId = lifecycle ? 'PORTAL-EQUIPMENT-CRUD' : configuration.query.id,
    variant = 'TARGET:' + request.target.id.toLowerCase();
  if (lifecycle && ['append','appendTo'].includes(cell.operation)) {
    const appendTo = cell.operation === 'appendTo', desiredTable = appendTo ? 'pqvd_equipment' : 'pqvd_room';
    if (!guid.test(request.boundTarget?.id ?? '') || request.boundTarget.table !== desiredTable ||
        request.target.table !== (appendTo ? 'pqvd_crudprobe' : 'pqvd_equipment'))
      throw new Error('Source5 lookup intents require actual child and desired counterpart fixture bindings.');
    caseId = appendTo ? 'PORTAL-EQUIPMENT-APPENDTO' : 'PORTAL-EQUIPMENT-APPEND';
    variant += (appendTo ? ';EQUIPMENT:' : ';ROOM:') + request.boundTarget.id.toLowerCase();
  }
  const maximum = schema?.tables?.find(table => table.name === 'pqvd_testoperation')?.columns?.find(column => column.name === 'pqvd_variant')?.maxLength;
  if (maximum !== undefined && maximum < variant.length)
    throw new Error('Source5 requires pqvd_testoperation.pqvd_variant length128 before native immutable target/counterpart intents.');
  return { caseId, variant };
}
const fieldEqual = (record, field, actual, expected) => {
  const type = record.fieldTypes?.[field];
  if (type?.type === 'datetime' && actual != null && expected != null) {
    if (type.behavior === 'DateOnly') return String(actual).slice(0, 10) === String(expected).slice(0, 10);
    const a = Date.parse(actual), b = Date.parse(expected); return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  return same(actual ?? null, expected ?? null);
};

/** All-region readback, including versions. Projection verification reads the
 * complete navigation collection so extra edges cannot masquerade as success. */
export async function captureQualificationFixtures(client, bound) {
  const records = [];
  for (const record of bound.records) {
    const row = await client.optional(endpointOf(bound, record));
    records.push({ table: record.table, id: record.id, region: record.region, row: clean(row),
      etag: row?.['@odata.etag'] ?? null });
  }
  const associations = [];
  for (const request of bound.requests.filter(request => request.kind === 'associate')) {
    const collection = request.endpoint.replace(/\/\$ref$/, ''), target = targetFromBody(request.body['@odata.id']);
    const owner = collection.slice(0, collection.lastIndexOf('/'));
    const rows = await client.optional(owner) ? await client.list(collection) : [];
    const targetRecord = bound.records.find(record => record.id === target);
    if (!targetRecord) throw new Error('Fixture association target is outside the declared disposable universe.');
    const primary = tableOf(bound, targetRecord.table).primaryId;
    associations.push({ collection, target, ids: rows.map(row => row[primary]).sort() });
  }
  const snapshot = { records, associations };
  return { ...snapshot, snapshotSha256: hash(snapshot) };
}

function assertFixtureValues(bound, snapshot) {
  for (const record of bound.records) {
    const actual = snapshot.records.find(row => row.id === record.id && row.table === record.table)?.row;
    if (!actual || Object.entries(record.fields).some(([name, value]) => !fieldEqual(record, name, actual[name], value)) ||
      Object.entries(record.refs).some(([name, value]) => (actual[`_${name}_value`] ?? null) !== (value?.id ?? null)))
      throw new Error('Native disposable fixture fields/lookups differ from the declared three-region graph.');
  }
  for (const collection of new Set(snapshot.associations.map(edge => edge.collection))) {
    const group = snapshot.associations.filter(edge => edge.collection === collection);
    if (!same([...new Set(group.map(edge => edge.target))].sort(), group[0].ids))
      throw new Error('Native disposable fixture projection has missing or foreign associations.');
  }
}

/** One coordinator-owned fixture lease. Every mutation is persisted first;
 * unknown commits are reconciled by state, never by repeating a request. */
export async function provisionQualificationFixtures(client, fixtures, { journalFile, trustedWriterId } = {}) {
  if (!guid.test(trustedWriterId ?? '') || (await client.get('WhoAmI')).UserId.toLowerCase() !== trustedWriterId.toLowerCase())
    throw new Error('Fixture application identity must match the frozen original guard maintainer.');
  const bound = await bindQualificationFixtureRequests(client, fixtures);
  const journal = { schemaVersion: 1, kind: 'native-disposable-fixture-lease', bound, trustedWriterId,
    before: await captureQualificationFixtures(client, bound), entries: [], state: 'prepared' };
  if (journal.before.records.some(record => record.row) || journal.before.associations.some(edge => edge.ids.length))
    throw new Error('Disposable fixture identity collision; no native mutations performed.');
  await savePrivateJson(journalFile, journal, { exclusive: true });
  for (const request of bound.requests) {
    const entry = { request, status: 'pending', before: request.kind === 'deferred-bind' ? await client.get(request.endpoint) : null };
    journal.entries.push(entry); await savePrivateJson(journalFile, journal);
    try {
      await client.request(request.endpoint, { method: request.method, body: request.body,
        ...(request.ifNoneMatch ? { ifNoneMatch: request.ifNoneMatch } : {}),
        ...(request.requireReadbackETag ? { ifMatch: etag(entry.before) } : {}) });
    } catch {
      entry.status = 'unknown'; await savePrivateJson(journalFile, journal);
      throw new Error('Fixture mutation outcome unknown; retained journal requires reconciliation, no retry.');
    }
    entry.status = 'committed'; await savePrivateJson(journalFile, journal);
  }
  const snapshot = await captureQualificationFixtures(client, bound); assertFixtureValues(bound, snapshot);
  journal.after = snapshot; journal.state = 'verified'; await savePrivateJson(journalFile, journal);
  return { actorContactId: bound.actorContactId, nativeDataVerified: true, nativeFixtureSnapshotHash: snapshot.snapshotSha256,
    regionRecordIds: bound.regionRecordIds, ownAccountId: bound.ownAccountId,
    ...(bound.ownedRunId ? { ownedRunId: bound.ownedRunId, ownedRunActorVerified: true,
      stockEquipmentVerified: bound.records.filter(record => record.table === 'pqvd_equipment').every(record =>
        record.fields.pqvd_equipmentstate === 183270000 && record.refs.pqvd_currentassignmentid === null) } : {}) };
}

/** Cleanup uses the authoritative request plan and exact declared identities.
 * Foreign row edits or association additions stop recovery and retain the WAL. */
export async function restoreQualificationFixtures(client, { journalFile } = {}) {
  const journal = await load(journalFile), bound = journal.bound;
  if ((await client.get('WhoAmI')).UserId.toLowerCase() !== journal.trustedWriterId.toLowerCase()) throw new Error('Fixture recovery maintainer changed.');
  if (journal.state === 'restored') return journal.cleanupReceipt;
  for (const entry of [...journal.entries].reverse()) {
    if (entry.status === 'restored') continue;
    const request = entry.request;
    if (request.kind === 'associate') {
      const collection = request.endpoint.replace(/\/\$ref$/, ''), target = targetFromBody(request.body['@odata.id']);
      const row = bound.records.find(record => record.id === target), primary = tableOf(bound, row.table).primaryId;
      const ids = (await client.list(collection)).map(record => record[primary]);
      const declared = bound.requests.filter(candidate => candidate.kind === 'associate' && candidate.endpoint === request.endpoint)
        .map(candidate => targetFromBody(candidate.body['@odata.id']));
      if (ids.some(id => !declared.includes(id))) throw new Error('Foreign fixture association drift; recovery refused.');
      if (ids.includes(target)) {
        entry.recovery = { status: 'pending', method: 'DELETE', endpoint: `${collection}(${target})/$ref` };
        await savePrivateJson(journalFile, journal);
        await client.request(entry.recovery.endpoint, { method: 'DELETE' });
      }
      if ((await client.list(collection)).some(record => record[primary] === target)) throw new Error('Fixture association removal readback failed.');
    } else {
      const row = await client.optional(request.endpoint);
      if (row) {
        const prototype = bound.records.find(record => endpointOf(bound, record) === request.endpoint);
        const hasOwnedIdentity = Object.entries(prototype.fields).some(([key, value]) => typeof value === 'string' &&
          value.includes(prototype.uniqueRunToken) && row[key] === value);
        if (!hasOwnedIdentity || Object.entries(prototype.fields).some(([key, value]) => !fieldEqual(prototype, key, row[key], value)))
          throw new Error('Foreign fixture scalar drift; recovery refused.');
        for (const [column, expected] of Object.entries(prototype.refs)) {
          const actual = row[`_${column}_value`] ?? null;
          const deferred = prototype.deferredRefs.includes(column);
          const desired = expected?.id ?? null;
          if (actual !== desired && !(deferred && actual === null)) throw new Error('Foreign fixture lookup drift; recovery refused.');
        }
        if (request.kind === 'deferred-bind') {
          const body = Object.fromEntries(Object.keys(request.body).map(name => [name, null]));
          entry.recovery = { status: 'pending', method: 'PATCH', endpoint: request.endpoint, body };
          await savePrivateJson(journalFile, journal);
          await client.request(request.endpoint, { method: 'PATCH', body, ifMatch: etag(row) });
        } else {
          entry.recovery = { status: 'pending', method: 'DELETE', endpoint: request.endpoint };
          await savePrivateJson(journalFile, journal);
          await client.request(request.endpoint, { method: 'DELETE', ifMatch: etag(row) });
          if (await client.optional(request.endpoint)) throw new Error('Fixture row removal readback failed.');
        }
      }
    }
    entry.status = 'restored'; delete entry.recovery; await savePrivateJson(journalFile, journal);
  }
  const after = await captureQualificationFixtures(client, { ...bound, requests: [] });
  if (after.records.some(record => record.row)) throw new Error('Fixture cleanup left an owned region row.');
  journal.state = 'restored'; journal.cleanupReceipt = { verified: true, allRegionsRestored: true, snapshotSha256: after.snapshotSha256 };
  await savePrivateJson(journalFile, journal); return journal.cleanupReceipt;
}

/** Actual browser transport, origin-confined and single-shot. Tokens stay in
 * page memory. A missing response is an unknown mutation, never a retry cue. */
export async function executeQualificationPortalRequest(browser, { portalOrigin, shellPath = '/permission-lab/', actorContactId,
  request, journalFile, anonymous = false } = {}) {
  const origin = new URL(portalOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || !guid.test(actorContactId ?? '') ||
      !['GET', 'POST', 'PATCH', 'DELETE'].includes(request?.method)) throw new Error('Bounded native portal request inputs required.');
  const target = new URL(request.url, origin), shell = new URL(shellPath, origin);
  if (target.origin !== origin.origin || shell.origin !== origin.origin || origin.username || origin.password ||
      !target.pathname.startsWith('/_api/') && !target.pathname.startsWith('/permission-lab/')) throw new Error('Portal request escaped the configured origin/test routes.');
  const journal = { request, actorContactId, anonymous, status: 'prepared', attempt: 1 };
  await savePrivateJson(journalFile, journal, { exclusive: true });
  try {
    const result = await browser.run(`async(page)=>{await page.goto(${JSON.stringify(shell.href)},{waitUntil:'domcontentloaded'});return page.evaluate(async input=>{const doc=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');const actor=doc.documentElement.getAttribute('contact-id');if(input.anonymous?actor&&actor!=='00000000-0000-0000-0000-000000000000':actor!==input.actor)throw new Error('Native portal actor changed');const token=await new Promise((resolve,reject)=>shell.getTokenDeferred().done(resolve).fail(reject));const response=await fetch(input.request.url,{method:input.request.method,headers:{Accept:'application/json','Content-Type':'application/json','__RequestVerificationToken':token,...(input.request.ifMatch?{'If-Match':input.request.ifMatch}:{})},body:input.request.body===undefined?undefined:JSON.stringify(input.request.body),credentials:'same-origin',redirect:'error',cache:'no-store'});return{identityReceipt:{serverVerified:true,contactId:actor||'00000000-0000-0000-0000-000000000000',roleNames:[...doc.querySelectorAll('role')].map(role=>role.textContent)},wire:{status:response.status,mime:response.headers.get('content-type'),body:await response.text()},entityId:response.headers.get('entityid')};},{actor:${JSON.stringify(actorContactId)},anonymous:${anonymous},request:${JSON.stringify({ ...request, url: target.pathname + target.search })}});}`);
    journal.status = 'response-received'; journal.result = result; await savePrivateJson(journalFile, journal); return result;
  } catch {
    journal.status = 'unknown'; await savePrivateJson(journalFile, journal);
    throw new Error('Native portal request outcome unknown; inspect target/intent journal and do not repeat mutation.');
  }
}

/** Metadata-bound operations test the named table as Append source or AppendTo
 * target. Guards remain active; successful HTTP alone never implies coverage. */
export function planQualificationCrudRequest({ configuration, cell, fixtures, bound, operationId = randomUUID(), schema } = {}) {
  if (!guid.test(operationId) || cell.operation === 'read') throw new Error('CRUD request requires a unique operation and mutation cell.');
  const own = fixtures.records.find(record => record.region === cell.region && record.table === configuration.query.table);
  if (!own) throw new Error('Mutation target requires an owned disposable record; actual actor records are never modified.');
  const target = `/_api/${endpointOf(bound, own)}`, create = bound.requests.find(request => request.kind === 'create' && request.endpoint === endpointOf(bound, own));
  if (cell.operation === 'create' && !create) throw new Error('Bound native fixture creation payload missing.');
  const marker = 'CO-OP:' + operationId;
  if (cell.operation === 'write') {
    const field = own.table === 'contact' ? 'firstname' : configuration.query.primaryName;
    if (!Object.hasOwn(own.fields, field)) throw new Error('No declared writable scalar for the portal update.');
    return { method: 'PATCH', url: target, body: { [field]: marker }, target: { table: own.table, id: own.id }, expectedMessage: 'Update', operationId };
  }
  if (cell.operation === 'delete') return { method: 'DELETE', url: target, target: { table: own.table, id: own.id }, expectedMessage: 'Delete', operationId };
  if (cell.operation === 'create') {
    const id = randomUUID(), body = { ...create.body, [tableOf(bound, own.table).primaryId]: id };
    const field = own.table === 'contact' ? 'firstname' : configuration.query.primaryName; body[field] = marker;
    for (const [name, value] of Object.entries(body)) if (typeof value === 'string' && !name.endsWith('@odata.bind') && value.includes(own.uniqueRunToken))
      body[name] = value.replace(own.uniqueRunToken, operationId.replaceAll('-', '').slice(0, 20));
    body[field] = marker;
    if (own.table === 'pqvd_equipment' && configuration.family === 'equipment-lifecycle') {
      body.pqvd_assettag = 'CO-CANARY-' + operationId; body.pqvd_equipmentstate = 183270000;
    }
    return { method: 'POST', url: '/_api/' + tableOf(bound, own.table).entitySet, body,
      target: { table: own.table, id }, expectedMessage: 'Create', operationId };
  }
  if (!['append', 'appendTo'].includes(cell.operation)) throw new Error('Unsupported configuration operation.');
  if (configuration.family === 'equipment-lifecycle' && cell.operation === 'append') {
    const room = fixtures.records.find(record => record.region === cell.region && record.table === 'pqvd_room' && record.bindingAlternate);
    const navigation = bound.lookupNavigation?.[own.id]?.pqvd_roomid;
    if (!room || !navigation) throw new Error('Source5 Append requires its second same-account Room and verified native lookup navigation.');
    return { method: 'PATCH', url: target, body: { [navigation + '@odata.bind']: `/pqvd_rooms(${room.id})`, pqvd_name: marker },
      target: { table: own.table, id: own.id }, boundTarget: { table: room.table, id: room.id },
      testedObjectRole: 'append', logicalLookup: 'pqvd_roomid', expectedMessage: 'Update', operationId };
  }
  if (configuration.family === 'equipment-lifecycle' && cell.operation === 'appendTo') {
    const probe = fixtures.records.find(record => record.region === cell.region && record.bindingProbe),
      equipment = fixtures.records.find(record => record.region === cell.region && record.table === 'pqvd_equipment' && record.bindingAlternate);
    const navigation = bound.lookupNavigation?.[probe?.id]?.pqvd_equipmentid;
    if (!probe || !equipment || !navigation) throw new Error('Source5 AppendTo requires the cooperating owned-Run Probe and second Stock Equipment.');
    return { method: 'PATCH', url: '/_api/' + endpointOf(bound, probe), body: { [navigation + '@odata.bind']: `/pqvd_equipments(${equipment.id})` },
      target: { table: probe.table, id: probe.id }, boundTarget: { table: equipment.table, id: equipment.id },
      testedObjectRole: 'appendTo', logicalLookup: 'pqvd_equipmentid', expectedMessage: 'Update', operationId };
  }
  const relationships = schema.relationships.filter(relation => relation.kind === 'oneToMany' &&
    (cell.operation === 'append' ? relation.child === own.table : relation.parent === own.table));
  for (const relation of relationships) {
    const source = cell.operation === 'append' ? own : fixtures.records.find(record => record.region === cell.region && record.table === relation.child);
    const destination = cell.operation === 'appendTo' ? own : fixtures.records.find(record => record.region === cell.region && record.table === relation.parent);
    if (!source || !destination) continue;
    const payload = bound.requests.find(request => request.kind === 'create' && request.endpoint === endpointOf(bound, source));
    const navigation = bound.lookupNavigation?.[source.id]?.[relation.lookup.name] + '@odata.bind';
    if (!payload?.body[navigation] || targetFromBody(payload.body[navigation]) !== destination.id || source.refs[relation.lookup.name]?.id !== destination.id) continue;
    return { method: 'PATCH', url: '/_api/' + endpointOf(bound, source), body: { [navigation]: payload.body[navigation] },
      target: { table: source.table, id: source.id }, boundTarget: { table: destination.table, id: destination.id },
      testedObjectRole: cell.operation, expectedMessage: 'Update', operationId };
  }
  throw new Error('No native-metadata-bound disposable lookup pair for this Append/AppendTo cell; do not substitute SDK association credit.');
}

export const nativeAdapterHelpers = { hash, clean, assertFixtureValues };

/** Source-owned SDK intents. Known GUIDs and immediate readback make an
 * uncertain commit inspectable without repeating Create. Recording history is
 * retained, while disposable business fixtures are cleaned separately. */
async function createRecordingRecord(client, endpoint, id, body, primary, journalFile) {
  if (await client.optional(`${endpoint}(${id})`)) throw new Error('Recording identity collision.');
  const journal = { endpoint, id, body, status: 'pending' };
  await savePrivateJson(journalFile, journal, { exclusive: true });
  try { await client.request(endpoint, { method: 'POST', body: { ...body, [primary]: id } }); }
  catch { journal.status = 'unknown'; await savePrivateJson(journalFile, journal); throw new Error('Recording Create outcome unknown; reconcile its known GUID without retry.'); }
  const row = await client.get(`${endpoint}(${id})`);
  if (row[primary] !== id) throw new Error('Recording identity readback failed.');
  journal.status = 'verified'; journal.row = clean(row); await savePrivateJson(journalFile, journal); return row;
}

async function fixtureMutationCleanup(client, state) {
  const { request, bound, before } = state, endpoint = request.url.replace('/_api/', '');
  if (request.actorScalarLeaseFile) {
    await restoreQualificationActorWrite(client, { journalFile: request.actorScalarLeaseFile });
    const snapshot = await captureQualificationFixtures(client, bound);
    if (snapshot.snapshotSha256 !== before.snapshotSha256) throw new Error('Self Write changed disposable fixture regions.');
    return { verified: true, allRegionsRestored: true, snapshotSha256: snapshot.snapshotSha256 };
  }
  const target = `${tableOf(bound, request.target.table).entitySet}(${request.target.id})`;
  const current = await client.optional(target);
  const expected = request.method === 'POST' ? null : before.records.find(record => record.id === request.target.id)?.row;
  const fieldsMatch = (row, body) => Object.entries(body).every(([name, value]) => name.endsWith('@odata.bind')
    ? (row[`_${name.slice(0, -11)}_value`] ?? null) === targetFromBody(value) : same(row[name] ?? null, value ?? null));
  const mutate = async (endpoint, options) => {
    state.pendingRecovery = { endpoint, options }; await savePrivateJson(state.stateFile, state);
    await client.request(endpoint, options); delete state.pendingRecovery; await savePrivateJson(state.stateFile, state);
  };
  if (request.method === 'POST' && current) {
    // Native navigation names can differ from logical lookup names. Scalar
    // ownership and explicit PK are checked; unchanged lookup graph is verified
    // against the whole owned region snapshot below.
    if (!fieldsMatch(current, Object.fromEntries(Object.entries(request.body).filter(([name]) => !name.endsWith('@odata.bind')))))
      throw new Error('Created fixture identity/scalar drift; cleanup refused.');
    await mutate(target, { method: 'DELETE', ifMatch: etag(current) });
    if (await client.optional(target)) throw new Error('Created canary cleanup readback failed.');
  } else if (request.method === 'DELETE' && !current) {
    const create = bound.requests.find(candidate => candidate.kind === 'create' && candidate.endpoint === target);
    await mutate(target, { method: 'PATCH', body: create.body, ifNoneMatch: '*' });
  } else if (request.method === 'PATCH' && current) {
    const scalarNames = Object.keys(request.body).filter(name => !name.endsWith('@odata.bind'));
    if (scalarNames.some(name => current[name] !== expected[name] && current[name] !== request.body[name]))
      throw new Error('Portal target drift; scalar restoration refused.');
    const restore = Object.fromEntries(scalarNames.map(name => [name, expected[name] ?? null]));
    if (scalarNames.some(name => !same(current[name] ?? null, expected[name] ?? null)))
      await mutate(endpoint, { method: 'PATCH', body: restore, ifMatch: etag(current) });
    for (const property of Object.keys(request.body).filter(name => name.endsWith('@odata.bind'))) {
      const lookup = Object.entries(bound.lookupNavigation[request.target.id]).find(([, navigation]) => navigation + '@odata.bind' === property)?.[0];
      if (!lookup) throw new Error('Mutation lookup navigation lost its exact native metadata binding.');
      const desired = targetFromBody(request.body[property]), previous = expected[`_${lookup}_value`] ?? null;
      const refreshed = await client.get(endpoint), actual = refreshed[`_${lookup}_value`] ?? null;
      if (actual !== desired && actual !== previous) throw new Error('Foreign lookup mutation drift; restore refused.');
      if (actual !== previous) {
        const originalReference = bound.records.find(record => record.id === request.target.id).refs[lookup];
        await mutate(endpoint, { method: 'PATCH', body: { [property]: originalReference
          ? `/${tableOf(bound, originalReference.table).entitySet}(${previous})` : null }, ifMatch: etag(refreshed) });
      }
    }
  }
  for (const preparation of state.sdkPreparations ?? []) {
    const row = await client.get(preparation.endpoint);
    const actual = preparation.lookup ? row[`_${preparation.field}_value`] ?? null : row[preparation.field] ?? null;
    if (actual !== (preparation.before ?? null) && actual !== preparation.desired)
      throw new Error('Prepared portal target marker drift; restore refused.');
    if (actual !== (preparation.before ?? null))
      await mutate(preparation.endpoint, { method: 'PATCH', body: preparation.lookup
        ? { [preparation.navigation + '@odata.bind']: preparation.before ? '/pqvd_testoperations(' + preparation.before + ')' : null }
        : { [preparation.field]: preparation.before ?? null }, ifMatch: etag(row) });
  }
  const after = await captureQualificationFixtures(client, bound);
  for (const row of before.records) {
    const actual = after.records.find(candidate => candidate.id === row.id)?.row;
    // Platform audit timestamps/row versions can advance after an accepted
    // mutation. The declared fixture fields/lookups must still be restored.
    const prototype = bound.records.find(record => record.id === row.id);
    for (const column of [...Object.keys(prototype.fields), ...Object.keys(prototype.refs).map(name => `_${name}_value`)])
      if (!same(row.row?.[column] ?? null, actual?.[column] ?? null)) throw new Error('All-region portal cleanup readback differs.');
  }
  if (!same(before.associations, after.associations)) throw new Error('Portal CRUD changed fixture projections.');
  return { verified: true, allRegionsRestored: true, snapshotSha256: after.snapshotSha256 };
}

/** Concrete client/browser adapters. Device credentials and replay bootstrap
 * stay in the sole writer's private runner. The Liquid endpoint is explicitly
 * supplied after its source/lease is installed; no fallback to SDK execution. */
export function createNativeConfigurationAdapters({ client, browser, anonymousBrowser, portalOrigin, actorContactId, siteId,
  anonymousShellPath,
  trustedWriterId, schema, manifest, registrationSource, assertExclusiveNativeWriter, replayNativeCell,
  liquidEndpointForConfiguration, clearPortalCaches } = {}) {
  for (const callback of [assertExclusiveNativeWriter, replayNativeCell, liquidEndpointForConfiguration, clearPortalCaches])
    if (typeof callback !== 'function') throw new Error('Bind the actual sole-writer lease, source endpoint, cache controls and original-DLL replay.');
  const folders = new Map(), cells = new Map();
  const nav = (entitySet, field) => manifest.navigation?.[entitySet]?.[field] ?? (() => { throw new Error('Native verified recording navigation absent.'); })();
  const readSources = async bound => {
    const [components, memberships, fixtures, registry, actor] = await Promise.all([
      client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${siteId}&$select=powerpagecomponentid,powerpagecomponenttype,name,statecode,statuscode,content,_powerpagesiteid_value`),
      client.list(`contacts(${actorContactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name,statecode,statuscode`),
      captureQualificationFixtures(client, bound), captureNativeRegistry(client, registrationSource),
      client.get(`contacts(${actorContactId})?$select=contactid,firstname,lastname,fullname,statecode,statuscode,_parentcustomerid_value`),
    ]);
    const sorted = rows => rows.map(clean).sort((a, b) => stable(a).localeCompare(stable(b)));
    const result = { components: sorted(components), memberships: sorted(memberships), fixtures, registry, actor: { row: clean(actor), etag: actor['@odata.etag'] } };
    result.witnesses = { nativeConfiguration: hash(result.components.filter(row => [11, 18].includes(row.powerpagecomponenttype))),
      nativeMemberships: hash(result.memberships), nativeFixtures: hash({ fixtures, actor: result.actor }),
      nativeSettings: hash(result.components.filter(row => ![11, 18, 8, 6, 2].includes(row.powerpagecomponenttype))),
      nativeTemplates: hash(result.components.filter(row => [8, 6, 2].includes(row.powerpagecomponenttype))) };
    return result;
  };
  const ensureRun = async directory => {
    const file = path.join(directory, 'owned-run.json');
    try { const saved = await load(file); if (saved.status !== 'verified') throw new Error('Owned run Create requires explicit recovery.'); return saved.id; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const id = randomUUID();
    await createRecordingRecord(client, 'pqvd_testruns', id, { pqvd_name: 'CO Configuration Campaign', pqvd_runkey: randomUUID(),
      [nav('pqvd_testruns', 'pqvd_runnercontactid') + '@odata.bind']: `/contacts(${actorContactId})`, pqvd_suiteversion: manifest.suiteVersion,
      pqvd_manifesthash: manifest.manifestHash, pqvd_datasetversion: manifest.datasetVersion, pqvd_sourcehash: manifest.sourceHash,
      pqvd_startedat: new Date().toISOString(), pqvd_runstate: manifest.choices.pqvd_runstate.Running }, 'pqvd_testrunid', file);
    return id;
  };
  return {
    assertExclusiveNativeWriter, clearPortalCaches, replayNativeCell,
    async provisionFixtures({ phase, fixtures, directory }) {
      if (phase === 'owned-run') return ensureRun(directory);
      const runId = await ensureRun(directory);
      const bindings = await provisionQualificationFixtures(client, fixtures, { journalFile: path.join(directory, 'native-fixtures.json'), trustedWriterId });
      const bound = await bindQualificationFixtureRequests(client, fixtures);
      folders.set(directory, { bound, bindings, runId }); return bindings;
    },
    async verifyFixtures({ directory }) {
      const state = folders.get(directory); if (!state) throw new Error('Fixture provisioning state absent.');
      assertFixtureValues(state.bound, await captureQualificationFixtures(client, state.bound)); return state.bindings;
    },
    async recoverFixtures({ directory }) {
      const fixtureFile = path.join(directory, 'native-fixtures.json');
      // Restore every outstanding per-cell mutation before deleting its parent
      // fixture graph. Unknown requests are reconciled through known target IDs.
      const states = [];
      const scan = async folder => {
        for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
          const file = path.join(folder, entry.name);
          if (entry.isDirectory()) await scan(file);
          else if (/^native-cell-state-\d+\.json$/.test(entry.name)) {
            const state = await load(file);
            if (state.folder !== directory || state.stateFile !== file || state.bound.actorContactId !== actorContactId)
              throw new Error('Native cell recovery journal identity drift.');
            states.push(state);
          }
        }
      };
      await scan(directory);
      for (const state of states) if (!state.cleanupReceipt && state.cell.operation !== 'read') {
        state.cleanupReceipt = await fixtureMutationCleanup(client, state);
        await savePrivateJson(state.stateFile, state);
      }
      try { await fs.access(fixtureFile); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    },
    async cleanupFixtures({ directory }) { return restoreQualificationFixtures(client, { journalFile: path.join(directory, 'native-fixtures.json') }); },
    async prepareCell({ cell, configuration, fixtures, directory, repeat }) {
      const folder = [...folders.keys()].find(folder => directory.startsWith(folder + path.sep));
      const context = folders.get(folder); if (!context) throw new Error('Cell fixture graph absent.');
      if (configuration.roles.some(role => role.anonymous) && !anonymousBrowser) throw new Error('Anonymous cells require a separate configured anonymous native browser.');
      const operationId = randomUUID(), state = { folder, cell, configuration, ...context, operationId,
        stateFile: path.join(directory, `native-cell-state-${repeat}.json`) };
      if (cell.operation !== 'read') state.request = cell.operation === 'write' && cell.region === 'own-scope' &&
        configuration.query.table === 'contact' && configuration.permissions.some(permission => permission.scope === 'Self')
        ? await planQualificationActorWrite(client, { actorContactId, operationId, journalFile: path.join(directory, `native-actor-write-${repeat}.json`) })
        : planQualificationCrudRequest({ configuration, cell, fixtures, bound: state.bound, operationId, schema });
      state.before = await captureQualificationFixtures(client, state.bound);
      await savePrivateJson(state.stateFile, state, { exclusive: true }); cells.set(directory + ':' + repeat, state);
      if (configuration.family === 'equipment-lifecycle' && cell.operation === 'delete') {
        const endpoint = state.request.url.replace('/_api/', ''), row = await client.get(endpoint);
        state.sdkPreparations = [{ endpoint, field: 'pqvd_name', before: row.pqvd_name, desired: 'CO-OP:' + operationId, status: 'pending' }];
        await savePrivateJson(state.stateFile, state);
        await client.request(endpoint, { method: 'PATCH', body: { pqvd_name: state.sdkPreparations[0].desired }, ifMatch: etag(row) });
        if ((await client.get(endpoint)).pqvd_name !== state.sdkPreparations[0].desired) throw new Error('Delete Before-image marker preparation failed.');
        state.sdkPreparations[0].status = 'verified'; await savePrivateJson(state.stateFile, state);
      }
      const message = state.request?.expectedMessage ?? 'RetrieveMultiple';
      const immutableIntent = qualificationMutationIntent({ configuration, cell, request: state.request, schema });
      const intent = { pqvd_name: 'CO Configuration ' + cell.operation,
        [nav('pqvd_testoperations', 'pqvd_runid') + '@odata.bind']: `/pqvd_testruns(${state.runId})`,
        pqvd_pairkey: randomUUID(), pqvd_caseid: immutableIntent.caseId, pqvd_variant: immutableIntent.variant,
        pqvd_lane: cell.lane === 'liquid' ? 183270000 : 183270001, pqvd_phase: manifest.choices.pqvd_phase.Baseline,
        pqvd_attempt: 1, pqvd_pagenumber: 1, pqvd_expectedmessage: message, pqvd_roottable: state.request?.target.table ?? configuration.query.table,
        ...(configuration.roles.some(role => role.anonymous) ? { pqvd_actorprovenance: 'AnonymousPortal.ConfiguredSDKIntent' } : {}) };
      state.operation = await createRecordingRecord(client, 'pqvd_testoperations', operationId, intent, 'pqvd_testoperationid', path.join(directory, `native-intent-${repeat}.json`));
      if (state.operation._pqvd_runnercontactid_value !== actorContactId || state.operation.pqvd_markeroperation !== 'CO-OP:' + operationId)
        throw new Error('Native intent stamp/actor failed.');
      if (configuration.family === 'equipment-lifecycle' && cell.operation === 'appendTo') {
        const endpoint = state.request.url.replace('/_api/', ''), row = await client.get(endpoint),
          navigation = state.bound.lookupNavigation[state.request.target.id].pqvd_activeoperationid;
        const preparation = { endpoint, field: 'pqvd_activeoperationid', navigation, lookup: true,
          before: row._pqvd_activeoperationid_value ?? null, desired: operationId, status: 'pending' };
        state.sdkPreparations = [...state.sdkPreparations ?? [], preparation]; await savePrivateJson(state.stateFile, state);
        await client.request(endpoint, { method: 'PATCH', body: { [navigation + '@odata.bind']: '/pqvd_testoperations(' + operationId + ')' }, ifMatch: etag(row) });
        if ((await client.get(endpoint))._pqvd_activeoperationid_value !== operationId) throw new Error('Probe immutable intent preparation failed.');
        preparation.status = 'verified'; await savePrivateJson(state.stateFile, state);
      }
      await savePrivateJson(state.stateFile, state);
      if (cell.operation === 'read' && cell.lane === 'liquid') {
        const query = configuration.bindingContract.bindRecordIds(Object.values(state.bindings.regionRecordIds).flat());
        state.liquidUrl = await liquidEndpointForConfiguration({ configuration: { ...configuration, query }, operation: state.operation, directory });
        await savePrivateJson(state.stateFile, state);
      }
      return { boundOperation: state.request ? { target: state.request.target, boundTarget: state.request.boundTarget,
        expectedMessage: state.request.expectedMessage, logicalLookup: state.request.logicalLookup,
        testedObjectRole: state.request.testedObjectRole } : undefined };
    },
    async readSourceWitnesses({ directory, repeat }) {
      const state = cells.get(directory + ':' + repeat); state.sourceBefore = await readSources(state.bound);
      await savePrivateJson(path.join(directory, `native-source-before-${repeat}.json`), state.sourceBefore, { exclusive: true });
      return state.sourceBefore.witnesses;
    },
    async collectNativeCell({ cell, configuration, cache, directory, repeat, expectedRoleIds }) {
      const state = cells.get(directory + ':' + repeat), anonymous = configuration.roles.some(role => role.anonymous);
      let request = state.request;
      if (cell.operation === 'read') {
        const xml = authoredQuery(configuration.query, state.operation, 1);
        request = { method: 'GET', url: cell.lane === 'webapi-odata' ? odataRequest(configuration.query, state.operation) + '&$top=10'
          : cell.lane === 'webapi' ? `/_api/${configuration.query.entitySet}?fetchXml=${encodeURIComponent(xml)}`
          : state.liquidUrl };
      }
      const response = await executeQualificationPortalRequest(anonymous ? anonymousBrowser : browser, { portalOrigin, actorContactId,
        request, anonymous, ...(anonymous ? { shellPath: anonymousShellPath ?? (() => { throw new Error('Anonymous source context shell is not configured.'); })() } : {}),
        journalFile: path.join(directory, `native-http-${repeat}.json`) });
      const sourceAfter = await readSources(state.bound);
      await savePrivateJson(path.join(directory, `native-source-after-${repeat}.json`), sourceAfter, { exclusive: true });
      const events = await client.list(`pqvd_pluginevents?$filter=_pqvd_operationid_value eq ${state.operationId}`);
      let rows = [], completePages = false, effectiveXml;
      if (cell.operation === 'read' && ['webapi', 'webapi-odata'].includes(cell.lane)) {
        try { const value = JSON.parse(response.wire.body); if (Array.isArray(value.value)) {
          rows = canonicalRows(value.value, configuration.query); completePages = !value['@odata.nextLink'] && value.value.length < configuration.query.pageSize;
        } else completePages = response.wire.status >= 400; } catch {}
      } else if (cell.operation === 'read' && cell.lane === 'liquid') {
        try {
          const body = response.wire.body.replace(/^\s*<\?xml[^?]*\?>/, '');
          const [parsed] = decodeBatchResponse(`<co-batch-response>${body}</co-batch-response>`, {
            operations: [{ id: state.operationId, plan: configuration.query }], actor: anonymous ? '00000000-0000-0000-0000-000000000000' : actorContactId,
            roles: response.identityReceipt.roleNames, datasetVersion: manifest.datasetVersion });
          rows = canonicalRows(parsed.rows, configuration.query); effectiveXml = parsed.effectiveFetchXml;
          completePages = parsed.more === false || parsed.more !== true && rows.length < configuration.query.pageSize;
        } catch { completePages = false; }
      } else completePages = true;
      if (cell.operation !== 'read') {
        state.cleanupReceipt = await fixtureMutationCleanup(client, state);
        await savePrivateJson(state.stateFile, state);
      }
      const before = state.sourceBefore, wire = response.wire;
      const mutableTarget = state.request?.target;
      const outsideTargetsEqual = before.fixtures.records.every(row => mutableTarget && row.id === mutableTarget.id ||
        same(row, sourceAfter.fixtures.records.find(other => other.id === row.id)));
      const summary = { operationId: state.operationId, request, wire, rows };
      const summaryText = stable(summary), encoded = await encodeArtifact(summaryText);
      if (encoded.length > 65536) throw new Error('Configuration history exceeds operation memo bound; preserve private files and split before native qualification.');
      const operationEndpoint = `pqvd_testoperations(${state.operationId})`, currentIntent = await client.get(operationEndpoint);
      if (currentIntent._pqvd_runnercontactid_value !== actorContactId || currentIntent._pqvd_runid_value !== state.runId)
        throw new Error('Configuration history owner/Run drift.');
      const historyBody = { pqvd_clientsummary: encoded, pqvd_physicalqueryhash: hash(request), pqvd_clientfinishedat: new Date().toISOString() };
      await savePrivateJson(path.join(directory, `native-history-write-${repeat}.json`), { endpoint: operationEndpoint, body: historyBody, status: 'pending' }, { exclusive: true });
      await client.request(operationEndpoint, { method: 'PATCH', body: historyBody, ifMatch: etag(currentIntent) });
      if ((await client.get(operationEndpoint)).pqvd_clientsummary !== encoded) throw new Error('Native configuration history checksum readback failed.');
      const envelope = { cellId: cell.id, inputHash: configuration.inputHash, controllerContactId: actorContactId,
        membershipRoleIds: sourceAfter.memberships.map(row => row.powerpagecomponentid), nativeWitnesses: before.witnesses,
        cacheActions: cache.actions, identityReceipt: response.identityReceipt, completePages,
        pages: [{ page: 1, fragment: 1, wire, rows, effectiveXml }], backendEvents: events,
        snapshotReceipt: { sourceStable: before.witnesses.nativeConfiguration === sourceAfter.witnesses.nativeConfiguration &&
          before.witnesses.nativeTemplates === sourceAfter.witnesses.nativeTemplates,
          settingsStable: before.witnesses.nativeSettings === sourceAfter.witnesses.nativeSettings,
          registrationStable: hash(before.registry.steps) === hash(sourceAfter.registry.steps) && hash(before.registry.images) === hash(sourceAfter.registry.images),
          membershipsStable: before.witnesses.nativeMemberships === sourceAfter.witnesses.nativeMemberships,
          allRegionsVerified: before.fixtures.records.every(row => row.row), dataStable: before.witnesses.nativeFixtures === sourceAfter.witnesses.nativeFixtures,
          onlyDeclaredTargetChanges: outsideTargetsEqual && same(before.fixtures.associations, sourceAfter.fixtures.associations) &&
            (mutableTarget?.id === actorContactId || same(before.actor, sourceAfter.actor)) },
        ...(state.cleanupReceipt ? { cleanupReceipt: state.cleanupReceipt } : {}),
        history: { operationId: state.operationId, summarySha256: hash(summary) }, sdkFixtureExecution: false,
        mutationBinding: state.request ? { target: state.request.target, boundTarget: state.request.boundTarget, expectedMessage: state.request.expectedMessage,
          logicalLookup: state.request.logicalLookup, testedObjectRole: state.request.testedObjectRole } : undefined,
      };
      await savePrivateJson(path.join(directory, `native-history-${repeat}.json`), summary, { exclusive: true }); return envelope;
    },
  };
}
