import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {savePrivateJson} from './private-journal.mjs';

/** Verify the owned exclusive descriptor, rather than reopening its pathname. */
export async function saveNativeReadArchive(file, archive) {
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const handle = await open(file, 'wx+', 0o600);
  try {
    await handle.writeFile(archive); await handle.sync();
    const readback = Buffer.alloc(archive.length);
    let offset = 0;
    while (offset < readback.length) {
      const {bytesRead} = await handle.read(readback, offset, readback.length - offset, offset);
      if (!bytesRead) throw new Error('Native read archive readback ended early.');
      offset += bytesRead;
    }
    if (createHash('sha256').update(readback).digest('hex') !== sha256) throw new Error('Native read archive readback checksum mismatch.');
    return {file, sha256, bytes: archive.length};
  } finally { await handle.close(); }
}

// The bridge accepts source text, so serialize inputs as a JSON string consumed
// by a fixed program. Request metadata never becomes JavaScript object syntax.
export function nativeBatchProgram({portalOrigin, requests, liquidUrls, capturePort}) {
  const origin = new URL(portalOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password)
    throw new Error('Explicit HTTPS portal origin required.');
  if (!Number.isInteger(capturePort) || capturePort < 1 || capturePort > 65535)
    throw new Error('Capture requires an owned loopback port.');
  if (!Array.isArray(requests) || !Array.isArray(liquidUrls)) throw new Error('Batch request arrays required.');
  const localRead = (value, prefix) => {
// eslint-disable-next-line no-control-regex -- Control characters are deliberately rejected at the native request boundary.
    if (typeof value !== 'string' || !value.startsWith(prefix) || value.includes('\\') || /[\x00-\x1f\x7f]/.test(value))
      throw new Error('Batch reads must use portal-relative paths.');
    const url = new URL(value, origin);
    if (url.origin !== origin.origin || !url.pathname.startsWith(prefix) || url.hash)
      throw new Error('Batch read escaped its portal path.');
  };
  for (const request of requests) {
    if (!request || !['webapi', 'liquid'].includes(request.lane)) throw new Error('Unknown batch request lane.');
    if (request.lane === 'webapi') localRead(request.url, '/_api/');
  }
  for (const batch of liquidUrls) {
    if (!batch || !Array.isArray(batch.ids) || batch.ids.some(id => typeof id !== 'string')) throw new Error('Batch operation IDs required.');
    localRead(batch.url, '/');
  }
  const input = {portalUrl: new URL('/permission-lab/', origin).href, requests, liquidUrls,
    captureUrl: new URL('/capture', `http://127.0.0.1:${capturePort}`).href};
  return 'async(page)=>{const input=JSON.parse(' + JSON.stringify(JSON.stringify(input)) + ');return (' + runNativeBatch.toString() + ')(page,input);}';
}

async function runNativeBatch(page, input) {
  await page.goto(input.portalUrl, {waitUntil: 'domcontentloaded'});
  const capture = await page.evaluate(async ({requests, liquidUrls}) => {
    const token = await new Promise((resolve, reject) => window.shell.getTokenDeferred().done(resolve).fail(reject));
    const results = [], start = Date.now(), api = requests.filter(request => request.lane === 'webapi');
    let index = 0;
    const workers = Array.from({length: Math.min(4, api.length)}, async () => {
      while (index < api.length) {
        const request = api[index++], before = Date.now();
        const response = await fetch(request.url, {headers: {Accept: 'application/json', __RequestVerificationToken: token}, cache: 'no-store', redirect: 'error'});
        results.push({...request, status: response.status, mime: response.headers.get('content-type'), body: await response.text(), durationMs: Date.now() - before});
      }
    });
    await Promise.all([...workers, (async () => {
      for (const batch of liquidUrls) {
        const before = Date.now(), response = await fetch(batch.url, {cache: 'no-store', redirect: 'error'});
        results.push({lane: 'liquid-batch', status: response.status, mime: response.headers.get('content-type'), operationIds: batch.ids, body: await response.text(), durationMs: Date.now() - before});
      }
    })()]);
    return {requests, results, durationMs: Date.now() - start};
  }, {requests: input.requests, liquidUrls: input.liquidUrls});
  const saved = await fetch(input.captureUrl, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(capture), redirect: 'error'});
  if (!saved.ok) throw new Error('Batch capture could not be saved.');
  return {calls: capture.results.length, statuses: capture.results.map(result => result.status), portalDurationMs: capture.durationMs};
}

async function main() {
const [
  {loadConnection, connectedClient}, {openNativeBrowser}, {deployBatchEndpoint, prepareBatchIntents, decodeBatchResponse},
  {authoredQuery, odataRequest, canonicalRows, stable, pageComplete}, {capturedQueries},
  {captureNativeSnapshot, compareNativeSnapshots, snapshotHash}, {nativeRegistrationFingerprint}, {captureNativeRegistry}, {persistNativeReadHistory},
] = await Promise.all([
  import('paqvilo/dataverse'), import('./native-browser.mjs'), import('./batch-capture.mjs'), import('./core.mjs'),
  import('./parity.mjs'), import('./native-capture.mjs'), import('../plugins/mirage-runtime.mjs'), import('./native-registry.mjs'), import('./native-history.mjs'),
]);
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const load = async file => JSON.parse(await readFile(file, 'utf8'));
const deployment = await load(config.deployment), manifest = await load(config.manifest);
await mkdir(config.outputDir, {recursive: true});
const connection = await loadConnection(config.connection), api = connectedClient(connection); await api.verify(connection.organisationId);
const browser = await openNativeBrowser(config.browser);
let capture;
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/capture') {response.writeHead(404).end(); return;}
  try {const chunks = []; let count = 0; for await (const chunk of request) {count += chunk.length; if (count > 16 * 1024 * 1024) throw new Error('Bound exceeded'); chunks.push(chunk);} capture = JSON.parse(Buffer.concat(chunks).toString()); await writeFile(path.join(config.outputDir, 'capture.json'), JSON.stringify(capture, null, 2)); response.writeHead(204).end();}
  catch {response.writeHead(400).end();}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  let actor = await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/permission-lab/')},{waitUntil:'domcontentloaded'});return page.evaluate(()=>{const xml=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');return {contactId:xml.documentElement.getAttribute('contact-id'),roles:[...xml.querySelectorAll('role')].map(role=>role.textContent)};});}`);
  if (actor.contactId !== config.contactId) throw new Error('Native actor mismatch.');
  const batch = await deployBatchEndpoint(api, deployment, manifest, path.join(config.outputDir, 'deployment-journal.json'));
  const cacheJournal = {schemaVersion: 1, actor: actor.contactId, startedAt: new Date().toISOString(), actions: [{name: 'clearConfig', status: 'pending'}, {name: 'clearCache', status: 'planned'}]};
  const saveCacheJournal = () => savePrivateJson(path.join(config.outputDir, 'cache-journal.json'), structuredClone(cacheJournal));
  await saveCacheJournal();
  await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/_services/about')},{waitUntil:'domcontentloaded'});await page.locator('input[name=clearConfig]').click();await page.waitForLoadState('domcontentloaded');return {cleared:true};}`);
  cacheJournal.actions[0].status = 'completed'; cacheJournal.actions[1].status = 'pending'; await saveCacheJournal();
  await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/_services/about')},{waitUntil:'domcontentloaded'});page.once('dialog',dialog=>dialog.accept());await page.locator('input[name=clearCache]').click({timeout:90000});await page.waitForLoadState('domcontentloaded');return {cleared:true};}`, 120000);
  cacheJournal.actions[1].status = 'completed'; cacheJournal.finishedAt = new Date().toISOString(); await saveCacheJournal();
  actor = await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/permission-lab/')},{waitUntil:'domcontentloaded'});return page.evaluate(()=>{const xml=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');return {contactId:xml.documentElement.getAttribute('contact-id'),roles:[...xml.querySelectorAll('role')].map(role=>role.textContent)};});}`);
  if (actor.contactId !== config.contactId) throw new Error('Native actor changed during cache refresh.');
  if (config.expectedBusinessRoleNames && stable(actor.roles.filter(name => config.businessRoleNames.includes(name)).sort()) !== stable([...config.expectedBusinessRoleNames].sort())) throw new Error('Native role display has not stabilized after mask update.');
  const selectedPlans = [...manifest.cases, ...(manifest.stressCases ?? []), ...(manifest.odataVariants ?? []), ...(manifest.odataPositiveVariants ?? [])].filter(plan => (config.caseIds ?? ['R09']).includes(plan.id));
  if (selectedPlans.length !== (config.caseIds ?? ['R09']).length) throw new Error('Requested native plan is missing or duplicated.');
  const plans = selectedPlans.flatMap(plan => (plan.fragments ?? [plan]).flatMap(fragment => (config.pages ?? [config.page ?? 1]).map(page => ({...fragment, page}))));
  const snapshotInput = {siteId: config.siteId, contactId: config.contactId, catalogue: await load(config.catalogue), overlays: await Promise.all(config.overlays.map(load)), resolvedIds: deployment.resolvedIds ?? {}};
  const before = await captureNativeSnapshot(api, snapshotInput);
  await writeFile(path.join(config.outputDir, 'snapshot-before.json'), JSON.stringify(before, null, 2));
  if (!before.complete) throw new Error('Native declared fixture/projection completeness failed.');
  const siteSources = await api.list(`powerpagecomponents?$select=powerpagecomponentid,powerpagecomponenttype,name,statecode,statuscode,content,_powerpagesiteid_value&$filter=_powerpagesiteid_value eq ${config.siteId}`);
  await writeFile(path.join(config.outputDir, 'site-components-before.json'), JSON.stringify(siteSources, null, 2));
  const registrationSource = await load(config.nativeRegistration);
  const captureRegistry = () => captureNativeRegistry(api, registrationSource);
  const registrationBefore = await captureRegistry();
  await writeFile(path.join(config.outputDir, 'plugin-registration-before.json'), JSON.stringify(registrationBefore, null, 2));
  const started = Date.now();
  const prepared = await prepareBatchIntents(api, {manifest, actor: actor.contactId, roles: actor.roles, plans, journalFile: path.join(config.outputDir, 'intent-journal.json')});
  const requests = prepared.intents.map(intent => ({caseId: intent.plan.id, variant: intent.plan.variant, page: intent.plan.page, lane: intent.lane, operationId: intent.id,
    authoredFetchXml: intent.plan.queryType === 'odata' ? null : authoredQuery(intent.plan, intent.operation, intent.plan.page),
    authoredRequest: intent.plan.queryType === 'odata' ? odataRequest(intent.plan, intent.operation) : null,
    url: intent.plan.queryType === 'odata' ? odataRequest(intent.plan, intent.operation) : intent.lane === 'webapi' ? `/_api/${intent.plan.entitySet}?fetchXml=${encodeURIComponent(authoredQuery(intent.plan, intent.operation, intent.plan.page))}` : null}));
  const liquidIds = requests.filter(request => request.lane === 'liquid').map(request => request.operationId);
  const liquidUrls = Array.from({length: Math.ceil(liquidIds.length / 30)}, (_, index) => ({ids: liquidIds.slice(index * 30, index * 30 + 30),
    url: batch.path + '?suiteVersion=' + encodeURIComponent(manifest.suiteVersion) + '&operationIds=' + encodeURIComponent(liquidIds.slice(index * 30, index * 30 + 30).join('|'))}));
  const capturePort = server.address().port;
  const summary = await browser.run(nativeBatchProgram({portalOrigin: config.portalOrigin, requests, liquidUrls, capturePort}), 360000);
  if (!capture) throw new Error('Batch capture missing.');
  capture.actorRoles = actor.roles;
  capture.recordingInputs={run:prepared.runRecord,operations:prepared.intents.map(intent=>intent.operation),qualification:'Actual SDK readbacks before measured portal queries; immutable creator/actor/root/lane/markers and initial RowVersions retained.'};
  const liquidPages = capture.results.filter(result => result.lane === 'liquid-batch').flatMap(response => decodeBatchResponse(response.body, {
    operations: prepared.intents.filter(intent => response.operationIds.includes(intent.id)), actor: actor.contactId, roles: actor.roles, datasetVersion: manifest.datasetVersion}));
  capture.rowComparisons = selectedPlans.map(plan => {
    const ids = prepared.intents.filter(intent => intent.plan.id === plan.id).map(intent => intent.id);
    const left = liquidPages.filter(page => ids.includes(page.operationId)), right = capture.results.filter(result => result.lane === 'webapi' && ids.includes(result.operationId));
    const a = left.flatMap(page => canonicalRows(page.rows, plan)).sort((a, b) => stable(a).localeCompare(stable(b)));
    const b = right.flatMap(result => {try {return canonicalRows(JSON.parse(result.body).value ?? [], plan);} catch {return [];}}).sort((a, b) => stable(a).localeCompare(stable(b)));
    const completeLiquid = left.every(page => page.outcome === 'success' && pageComplete({more: page.more, rowCount: page.rows.length, pageSize: plan.pageSize}));
    const completeWebapi = right.every(result => {try {const data = JSON.parse(result.body); return result.status === 200 && Array.isArray(data.value) && !data['@odata.nextLink'] && (plan.queryType === 'odata' ? data['@odata.count'] === data.value.length : data.value.length < plan.pageSize);} catch {return false;}});
    const apiOnly = plan.queryType === 'odata';
    return {caseId: plan.id, apiOnly, liquid: apiOnly ? null : a.length, webapi: b.length, equal: !apiOnly && completeLiquid && completeWebapi ? stable(a) === stable(b) : null, completeLiquid: apiOnly ? null : completeLiquid, completeWebapi, liquidOutcomes: left.map(page => page.outcome), apiStatuses: right.map(result => result.status)};
  });
  capture.liquidPages = liquidPages;
  const eventXml = `<fetch><entity name="pqvd_pluginevent"><all-attributes/><link-entity name="pqvd_testoperation" from="pqvd_testoperationid" to="pqvd_operationid"><filter><condition attribute="pqvd_runid" operator="eq" value="${prepared.runId}"/></filter></link-entity></entity></fetch>`;
  const events = await api.list(`pqvd_pluginevents?fetchXml=${encodeURIComponent(eventXml)}`);
  capture.backendEvents = events; capture.runId = prepared.runId; capture.preparationDurationMs = Date.now() - started - capture.durationMs;
  const physical = prepared.intents.map(intent => ({operationId: intent.id, lane: intent.lane, ...capturedQueries(events.filter(event => event._pqvd_operationid_value === intent.id), {operationId: intent.id})}));
  const bindings = events.filter(event => event.pqvd_partcount === 1).map(event => {try {const payload = JSON.parse(event.pqvd_payloadtext), context2 = payload.context?.extensions?.context2?.values ?? payload.context; return {portalFlag: context2?.IsPortalsClientCall, contactId: context2?.PortalsContactId, actorBinding: payload.content?.actorBinding};} catch {return null;}}).filter(Boolean);
  capture.qualification = {physical, portalActorVerified: bindings.length > 0 && bindings.every(binding => binding.portalFlag === true && binding.contactId === actor.contactId && binding.actorBinding === 'RuntimePortalsContactMatched')};
  const after = await captureNativeSnapshot(api, snapshotInput);
  await writeFile(path.join(config.outputDir, 'snapshot-after.json'), JSON.stringify(after, null, 2));
  const sourcesAfter = await api.list(`powerpagecomponents?$select=powerpagecomponentid,powerpagecomponenttype,name,statecode,statuscode,content,_powerpagesiteid_value&$filter=_powerpagesiteid_value eq ${config.siteId}`);
  await writeFile(path.join(config.outputDir, 'site-components-after.json'), JSON.stringify(sourcesAfter, null, 2));
  const logicalSource = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([field]) => !field.startsWith('@')))).sort((a,b) => a.powerpagecomponentid.localeCompare(b.powerpagecomponentid));
  capture.qualification.snapshotComparison = compareNativeSnapshots(before, after);
  capture.qualification.snapshotHashes = Object.fromEntries(['permissionSnapshotHash', 'membershipSnapshotHash', 'dataSnapshotHash', 'rowVersionSnapshotHash'].map(field => [field, {before: before[field], after: after[field]}]));
  capture.qualification.sourcesStable = snapshotHash(logicalSource(siteSources)) === snapshotHash(logicalSource(sourcesAfter));
  capture.qualification.siteComponentsSha256 = {before: snapshotHash(logicalSource(siteSources)), after: snapshotHash(logicalSource(sourcesAfter))};
  const registrationAfter = await captureRegistry();
  await writeFile(path.join(config.outputDir, 'plugin-registration-after.json'), JSON.stringify(registrationAfter, null, 2));
  capture.qualification.registrationSha256 = nativeRegistrationFingerprint(registrationBefore);
  capture.qualification.registrationStable = capture.qualification.registrationSha256 === nativeRegistrationFingerprint(registrationAfter);
  await writeFile(path.join(config.outputDir, 'capture.json'), JSON.stringify(capture, null, 2));
  if (config.persistHistory) {
    const archive = gzipSync(Buffer.from(JSON.stringify({capture, before, after, siteSources, sourcesAfter, registrationBefore, registrationAfter})), {level: 9});
    capture.archive = await saveNativeReadArchive(path.join(config.outputDir, 'immutable-native-read.json.gz'), archive);
    await savePrivateJson(path.join(config.outputDir, 'archive-receipt.json'), capture.archive, {exclusive: true});
    capture.history = await persistNativeReadHistory(api, {capture, intents: prepared.intents, manifest, campaign: config.campaign, journalFile: path.join(config.outputDir, 'native-history-journal.json')});
    await writeFile(path.join(config.outputDir, 'capture.json'), JSON.stringify(capture, null, 2));
  }
  console.log(JSON.stringify({...summary, totalDurationMs: Date.now() - started, events: events.length, capturedQueries: physical.reduce((count, page) => count + page.queries.length, 0), captureErrors: physical.flatMap(page => page.errors).length, portalActorVerified: capture.qualification.portalActorVerified,
    rowComparisons: capture.rowComparisons, outputDir: config.outputDir}));
} catch (error) {await writeFile(path.join(config.outputDir, 'failure.json'), JSON.stringify({code: error.code ?? 'BatchPrototypeFailed', message: error.message, time: new Date().toISOString()}, null, 2)); console.error('Native batch prototype failed; private diagnostic recorded.'); process.exitCode = 1;}
finally {await browser.close().catch(() => {}); await new Promise(resolve => server.close(resolve));}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
