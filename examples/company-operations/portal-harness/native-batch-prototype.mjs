import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { loadConnection, connectedClient } from 'paqvilo/dataverse';
import { openNativeBrowser } from './native-browser.mjs';
import { deployBatchEndpoint, prepareBatchIntents, decodeBatchResponse } from './batch-capture.mjs';
import { authoredQuery, odataRequest, canonicalRows, stable, pageComplete } from './core.mjs';
import { capturedQueries } from './parity.mjs';
import { captureNativeSnapshot, compareNativeSnapshots, snapshotHash } from './native-capture.mjs';
import { nativeRegistrationFingerprint } from '../plugins/mirage-runtime.mjs';
import { captureNativeRegistry } from './native-registry.mjs';

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
  await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/_services/about')},{waitUntil:'domcontentloaded'});await page.locator('input[name=clearConfig]').click();await page.waitForLoadState('domcontentloaded');return {cleared:true};}`);
  actor = await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/permission-lab/')},{waitUntil:'domcontentloaded'});return page.evaluate(()=>{const xml=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');return {contactId:xml.documentElement.getAttribute('contact-id'),roles:[...xml.querySelectorAll('role')].map(role=>role.textContent)};});}`);
  if (actor.contactId !== config.contactId) throw new Error('Native actor changed during cache refresh.');
  if (config.expectedBusinessRoleNames && stable(actor.roles.filter(name => config.businessRoleNames.includes(name)).sort()) !== stable([...config.expectedBusinessRoleNames].sort())) throw new Error('Native role display has not stabilized after mask update.');
  const selectedPlans = [...manifest.cases, ...(manifest.stressCases ?? []), ...(manifest.odataVariants ?? [])].filter(plan => (config.caseIds ?? ['R09']).includes(plan.id));
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
  const summary = await browser.run(`async(page)=>{await page.goto(${JSON.stringify(config.portalOrigin + '/permission-lab/')},{waitUntil:'domcontentloaded'});const capture=await page.evaluate(async()=>{const requests=${JSON.stringify(requests)};const token=await new Promise((resolve,reject)=>shell.getTokenDeferred().done(resolve).fail(reject));const results=[];const start=Date.now();const api=requests.filter(request=>request.lane==='webapi');let index=0;await Promise.all([...(Array.from({length:Math.min(4,api.length)},()=>async()=>{while(index<api.length){const request=api[index++],before=Date.now(),response=await fetch(request.url,{headers:{Accept:'application/json',__RequestVerificationToken:token},cache:'no-store'});results.push({...request,status:response.status,mime:response.headers.get('content-type'),body:await response.text(),durationMs:Date.now()-before});}}).map(worker=>worker())),(async()=>{for(const batch of ${JSON.stringify(liquidUrls)}){const before=Date.now(),response=await fetch(batch.url,{cache:'no-store'});results.push({lane:'liquid-batch',status:response.status,mime:response.headers.get('content-type'),operationIds:batch.ids,body:await response.text(),durationMs:Date.now()-before});}})()]);return {requests,results,durationMs:Date.now()-start};});await fetch('http://127.0.0.1:${capturePort}/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(capture)});return {calls:capture.results.length,statuses:capture.results.map(result=>result.status),portalDurationMs:capture.durationMs};}`, 360000);
  if (!capture) throw new Error('Batch capture missing.');
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
  capture.qualification.sourcesStable = snapshotHash(logicalSource(siteSources)) === snapshotHash(logicalSource(sourcesAfter));
  const registrationAfter = await captureRegistry();
  await writeFile(path.join(config.outputDir, 'plugin-registration-after.json'), JSON.stringify(registrationAfter, null, 2));
  capture.qualification.registrationSha256 = nativeRegistrationFingerprint(registrationBefore);
  capture.qualification.registrationStable = capture.qualification.registrationSha256 === nativeRegistrationFingerprint(registrationAfter);
  await writeFile(path.join(config.outputDir, 'capture.json'), JSON.stringify(capture, null, 2));
  console.log(JSON.stringify({...summary, totalDurationMs: Date.now() - started, events: events.length, capturedQueries: physical.reduce((count, page) => count + page.queries.length, 0), captureErrors: physical.flatMap(page => page.errors).length, portalActorVerified: capture.qualification.portalActorVerified,
    rowComparisons: capture.rowComparisons, outputDir: config.outputDir}));
} catch (error) {await writeFile(path.join(config.outputDir, 'failure.json'), JSON.stringify({code: error.code ?? 'BatchPrototypeFailed', message: error.message, time: new Date().toISOString()}, null, 2)); console.error('Native batch prototype failed; private diagnostic recorded.'); process.exitCode = 1;}
finally {await browser.close().catch(() => {}); await new Promise(resolve => server.close(resolve));}
