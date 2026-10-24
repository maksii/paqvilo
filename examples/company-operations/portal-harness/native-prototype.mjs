import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { loadConnection, connectedClient } from 'paqvilo/dataverse';
import { openNativeBrowser } from './native-browser.mjs';
import { captureNativeSnapshot, compareNativeSnapshots, snapshotHash } from './native-capture.mjs';
import { capturedQueries } from './parity.mjs';

const file = process.argv[2];
if (!file || process.argv.length !== 3)
  throw new Error('Usage: node portal-harness/native-prototype.mjs <private-config.json>');
const config = JSON.parse(await readFile(file, 'utf8'));
const origin = new URL(config.portalOrigin);
if (
  origin.protocol !== 'https:' ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  origin.username ||
  origin.password
)
  throw new Error('Explicit HTTPS portal origin required.');
await mkdir(config.outputDir, { recursive: true });
const load = async (file) => JSON.parse(await readFile(file, 'utf8'));
const connection = await loadConnection(config.connection);
const client = connectedClient(connection);
await client.verify(connection.organisationId);
const catalogue = await load(config.catalogue),
  overlays = await Promise.all(config.overlays.map(load));
const deployment = await load(config.deployment);
const input = {
  siteId: config.siteId,
  contactId: config.contactId,
  catalogue,
  overlays,
  resolvedIds: deployment.resolvedIds ?? {},
};
const journalFile = path.join(config.outputDir, 'journal.json');
const journal = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  actor: config.contactId,
  site: config.siteId,
  purpose: 'Fresh baseline R09 qualification; recorder writes only, baseline roles retained',
  originalRoles: [],
  stages: [],
  runs: [],
};
const save = () => writeFile(journalFile, JSON.stringify(journal, null, 2) + '\n');
let report,
  currentAttempt = 0;
const saver = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/capture') {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 16 * 1024 * 1024) throw new Error('Capture size bound.');
      chunks.push(chunk);
    }
    report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    await writeFile(
      path.join(config.outputDir, `attempt-${currentAttempt}.json`),
      JSON.stringify(report, null, 2) + '\n',
    );
    response.writeHead(204).end();
  } catch {
    response.writeHead(400).end();
  }
});
await new Promise((resolve) => saver.listen(0, '127.0.0.1', resolve));
const capturePort = saver.address().port;
let browser;
try {
  const before = await captureNativeSnapshot(client, input);
  journal.originalRoles = before.memberships;
  await writeFile(path.join(config.outputDir, 'snapshot-before.json'), JSON.stringify(before, null, 2));
  if (!before.complete) throw new Error('Native fixture or membership snapshot is incomplete.');
  journal.stages.push({
    stage: 'before-first-mutation',
    time: new Date().toISOString(),
    hashes: {
      permissions: before.permissionSnapshotHash,
      memberships: before.membershipSnapshotHash,
      data: before.dataSnapshotHash,
    },
  });
  await save();
  browser = await openNativeBrowser(config.browser);
  const cache = await browser.run(
    `async(page)=>{await page.goto(${JSON.stringify(origin.origin + '/_services/about')},{waitUntil:'domcontentloaded'});const button=page.locator('input[name=clearConfig]');if(await button.count()!==1)throw new Error('Cache refresh control unavailable');await button.click();await page.waitForLoadState('domcontentloaded');return {time:new Date().toISOString(),path:new URL(page.url()).pathname,action:'Clear config'};}`,
  );
  journal.stages.push({ stage: 'cache-refresh', ...cache });
  await save();
  for (currentAttempt = 1; currentAttempt <= 2; currentAttempt++) {
    report = null;
    const started = Date.now();
    const result = await browser.run(
      `async(page)=>{await page.goto(${JSON.stringify(origin.origin + '/permission-lab/')},{waitUntil:'domcontentloaded',timeout:45000});const context=await page.locator('#co-context').textContent();if(!context.includes(${JSON.stringify(config.contactId)}))throw new Error('Native actor mismatch');await page.locator('#co-cases').selectOption('R09');await page.locator('#co-read').click();const start=Date.now();let report;do{const blocks=await page.locator('#co-results pre[data-observation]').allTextContents();const status=await page.locator('#co-status').textContent();report={time:new Date().toISOString(),status,finished:status!=='Running',results:blocks.map(text=>JSON.parse(text))};await fetch('http://127.0.0.1:${capturePort}/capture',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});if(!report.finished)await page.waitForTimeout(1000);}while(!report.finished&&Date.now()-start<300000);return {finished:report.finished,status:report.status,runId:report.results.at(-1)?.runId??null};}`,
      360000,
    );
    if (!result.finished || !report?.results?.at(-1)?.runId)
      throw new Error('Native prototype did not produce a completed recording.');
    const run = report.results.at(-1);
    const physical = run.pairs.flatMap((pair) =>
      ['liquid', 'webapi'].flatMap((lane) =>
        pair[lane].pages.map((page) => ({
          caseId: pair.caseId,
          lane,
          page: page.page,
          fragment: page.fragment ?? 1,
          operationId: page.operationId,
          ...capturedQueries(page.backendEvents, { operationId: page.operationId }),
        })),
      ),
    );
    journal.runs.push({
      attempt: currentAttempt,
      runId: run.runId,
      durationMs: Date.now() - started,
      pairs: run.pairs.length,
      completeRows:
        run.pairs.length === 1 &&
        run.pairs.every((pair) =>
          ['liquid', 'webapi'].every((lane) => pair[lane].complete && pair[lane].outcome === 'success'),
        ),
      physicalRequests: physical.length,
      capturedQueries: physical.reduce((count, page) => count + page.queries.length, 0),
      captureErrors: physical.flatMap((page) => page.errors),
      artifactBytes: Buffer.byteLength(JSON.stringify(report)),
      physical,
    });
    await save();
  }
  const after = await captureNativeSnapshot(client, input);
  await writeFile(path.join(config.outputDir, 'snapshot-after.json'), JSON.stringify(after, null, 2));
  journal.snapshotComparison = compareNativeSnapshots(before, after);
  const signature = (run) =>
    run.physical.map((page) => ({
      caseId: page.caseId,
      lane: page.lane,
      page: page.page,
      fragment: page.fragment,
      queries: page.queries.map((query) => ({
        artifact: query.artifact,
        stage: query.stage,
        order: query.order,
        type: query.queryType,
        hash: query.fingerprint.structuralHash,
        byteHash: query.fingerprint.sentinelNormalizedByteHash,
        principalFootprint: query.principalFootprint,
      })),
    }));
  journal.stableCapture = snapshotHash(signature(journal.runs[0])) === snapshotHash(signature(journal.runs[1]));
  journal.finishedAt = new Date().toISOString();
  journal.complete =
    journal.snapshotComparison.stable &&
    journal.stableCapture &&
    journal.runs.every((run) => run.completeRows && !run.captureErrors.length);
  await save();
  console.log(
    JSON.stringify({
      complete: journal.complete,
      snapshotsStable: journal.snapshotComparison.stable,
      changed: journal.snapshotComparison.changed,
      repeatedQueryShapesStable: journal.stableCapture,
      runs: journal.runs.map((run) => ({
        attempt: run.attempt,
        durationMs: run.durationMs,
        physicalRequests: run.physicalRequests,
        capturedQueries: run.capturedQueries,
        artifactBytes: run.artifactBytes,
      })),
      outputDir: config.outputDir,
    }),
  );
} catch (error) {
  journal.failure = {
    code: error.code ?? 'NativePrototypeFailed',
    message: 'Prototype failed; private details withheld.',
    time: new Date().toISOString(),
  };
  await save();
  console.error(JSON.stringify(journal.failure));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolve) => saver.close(resolve));
}
