import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildBlueprint } from './blueprint.mjs';
import { permissionPathSequence, permissionPathCatalogue, buildPermissionOrderProbe, diagnosePermissionOrder } from './permission-order.mjs';
import { replayStore } from '../portal-harness/replay.mjs';
import { capturedQueries } from '../portal-harness/parity.mjs';

const jobFile = process.argv[2];
if (!jobFile || process.argv.length !== 3) throw new Error('Usage: node portal-security/permission-order-plan.mjs <private-job.json>');
const read = async file => JSON.parse(await readFile(file, 'utf8'));
const job = await read(jobFile);
if (!path.resolve(job.output ?? '').split(path.sep).includes('.paqvilo')) throw new Error('Order evidence must stay in ignored .paqvilo.');
const inputs = Object.fromEntries(await Promise.all(['schema', 'catalogue', 'nativeComponents', 'nativeSnapshot']
  .map(async field => [field, await read(job[field])])));
const { schema, catalogue, nativeComponents, nativeSnapshot } = inputs;
if (!nativeSnapshot.complete || !/^[a-f0-9]{64}$/.test(nativeSnapshot.permissionSnapshotHash ?? ''))
  throw new Error('A complete frozen native snapshot with its permission hash is required.');
const plan = buildPermissionOrderProbe({ schema, catalogue, blueprint: buildBlueprint(schema, catalogue),
  permissionsSnapshotHash: nativeSnapshot.permissionSnapshotHash, nativeFixtures: nativeSnapshot.tables });
const nativeActor = nativeSnapshot.tables.contact.find(contact => contact.contactid === nativeSnapshot.contactId);
if (!nativeActor) throw new Error('Frozen native snapshot is missing the bound actor.');
const environment = replayStore({ schema, catalogue, nativeComponents,
  overlay: { records: [{ key: 'NATIVE-ORDER-ACTOR', table: 'contact', id: nativeSnapshot.contactId,
    fields: { ...nativeActor, parentcustomerid: nativeActor._parentcustomerid_value
      ? { id: nativeActor._parentcustomerid_value, logical_name: 'account' } : null } }], associations: [] },
  contactId: nativeSnapshot.contactId, roles: nativeSnapshot.memberships.map(role => role.name) });
const catalogues = plan.cases.map(query => permissionPathCatalogue({ permissions: environment.store.state.permissions,
  mappings: environment.store.state.mappings, identity: environment.identity, table: query.table,
  authoredXml: query.fetchXml, permissionsSnapshotHash: nativeSnapshot.permissionSnapshotHash }));
const capturedPaths = [];
if (job.capture) {
  const capture = await read(job.capture);
  for (const request of capture.requests) {
    if (typeof request.authoredFetchXml !== 'string' || !/^\s*<fetch\b/.test(request.authoredFetchXml)) {
      capturedPaths.push({ caseId: request.caseId, lane: request.lane, qualification: 'not-a-fetchxml-order-probe',
        reason: 'OData construction/order is a separate source contract; do not feed its URI to the FetchXML path comparator.' });
      continue;
    }
    const events = capture.backendEvents.filter(event => event._pqvd_operationid_value === request.operationId);
    const checked = capturedQueries(events, { operationId: request.operationId });
    if (checked.errors.length || !checked.queries.length) {
      capturedPaths.push({ caseId: request.caseId, lane: request.lane, qualification: 'unqualified', artifactErrors: checked.errors }); continue;
    }
    // Use the declared incoming-query artifact with greatest stage/order. Every
    // payload part was independently checked by capturedQueries above.
    const final = checked.queries.at(-1);
    const spans = new Map();
    for (const event of events.filter(event => event.pqvd_artifacttype === final.artifact &&
      event.pqvd_stage === final.stage && event.pqvd_executionorder === final.order)) {
      const group = spans.get(event.pqvd_spanid) ?? []; group.push(event); spans.set(event.pqvd_spanid, group);
    }
    const payload = [...spans.values()].map(parts => JSON.parse(parts.sort((a, b) => a.pqvd_partnumber - b.pqvd_partnumber)
      .map(part => part.pqvd_payloadtext).join(''))).find(payload =>
      createHash('sha256').update(payload.content.query.xml).digest('hex') === final.fingerprint.exactHash);
    if (!payload) throw new Error('Final artifact failed exact incoming-query binding.');
    const xml = payload.content.query.xml;
    const native = permissionPathSequence(xml, request.authoredFetchXml);
    const source = catalogues.find(entry => entry.table === native.table);
    capturedPaths.push({ caseId: request.caseId, lane: request.lane, page: request.page,
      qualification: 'diagnostic-single-native-witness', artifact: final.artifact, stage: final.stage, order: final.order,
      sourceArtifactHash: final.fingerprint.exactHash, table: native.table, diagnostics: native.diagnostics,
      orderingHypotheses: source ? diagnosePermissionOrder(source, native.sequence) : {},
      orderedPaths: native.sequence.map(entry => ({ signature: entry.signature,
        permissionIds: source?.entries.filter(candidate => candidate.signature === entry.signature).map(candidate => candidate.permissionId) ?? [],
        links: entry.shape.links.length, terminalAttribute: entry.shape.terminal.attribute })) });
  }
}
const sourceHashes = {};
for (const field of ['schema', 'catalogue', 'nativeComponents', 'nativeSnapshot',
  ...(job.capture ? ['capture'] : []), ...(job.nativeRegistrations ? ['nativeRegistrations'] : [])])
  sourceHashes[field] = createHash('sha256').update(await readFile(job[field])).digest('hex');
const report = { schemaVersion: 1, preparedAt: new Date().toISOString(), qualification: 'diagnostic',
  observerProfileHash: sourceHashes.nativeRegistrations ?? null,
  sourceHashes, plan, catalogues, capturedPaths, liveMutation: false, nativeExecution: false,
  limitations: ['A diagnostic witness does not establish repeat/cache qualification or all-role master order.',
    'No native order profile is installed by this planner; missing/ambiguous paths remain visible.'] };
await mkdir(path.dirname(job.output), { recursive: true });
await writeFile(job.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ qualification: report.qualification, roots: plan.cases.length,
  representativeMasks: plan.representativeMasks.length, calibrationCells: plan.calibrationCells,
  exhaustiveSubsetCells: plan.exhaustiveSubsetCells, nativePathWitnesses: capturedPaths.length,
  unmatchedNativePaths: capturedPaths.flatMap(entry => entry.orderedPaths ?? []).filter(entry => !entry.permissionIds.length).length,
  sourcePathDiagnostics: catalogues.flatMap(entry => entry.diagnostics).length, output: job.output }));
