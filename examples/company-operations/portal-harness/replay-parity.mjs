import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { compilePermissionFetchXml } from 'paqvilo/mirage/lib/permission-query.mjs';
import { replayStore, replayLane } from './replay.mjs';
import { coverageLedger } from './parity.mjs';
import { stable } from './core.mjs';
import { componentId, roleNames } from '../portal-security/blueprint.mjs';
import { deepVariantKeys } from '../portal-security/deep-variant.mjs';

const jobFile = process.argv[2];
if (!jobFile || process.argv.length !== 3) throw new Error('Usage: node portal-harness/replay-parity.mjs <private-job.json>');
const job = JSON.parse(await readFile(jobFile, 'utf8'));
const load = async file => JSON.parse(await readFile(file, 'utf8'));
const [schema, catalogue, manifest, components, baselineOverlay, stressOverlay] = await Promise.all([
  load(job.schema), load(job.catalogue), load(job.manifest), load(job.nativeComponents), load(job.baselineOverlay), load(job.stressOverlay),
]);
const inputHashes = {};
for (const field of ['schema', 'catalogue', 'manifest', 'nativeComponents', 'baselineOverlay', 'stressOverlay']) inputHashes[field] = createHash('sha256').update(await readFile(job[field])).digest('hex');
inputHashes.replayConfiguration = createHash('sha256').update(stable({variants: job.variants ?? {}, observedProfiles: job.observedProfiles ?? {}})).digest('hex');
const indexed = new Map();
for (const file of (await readdir(job.snapshots)).filter(file => /live.*\.json$/.test(file))) {
  let run, envelope, raw; try {raw = await readFile(path.join(job.snapshots, file), 'utf8'); envelope = JSON.parse(raw); run = envelope.results?.at(-1);} catch {continue;}
  if (!run?.runId || !Array.isArray(run.pairs)) continue;
  const old = indexed.get(run.runId);
  const capturedAt = envelope.time ?? '';
  if (!old || capturedAt > old.capturedAt || capturedAt === old.capturedAt && file > old.file) indexed.set(run.runId, {file, run, capturedAt, snapshotHash: createHash('sha256').update(raw).digest('hex')});
}
const report = {schemaVersion: 1, kind: 'reconstructed-native-corpus-mirage-replay', inputHashes, preparedAt: new Date().toISOString(), qualification: 'diagnostic',
  limitations: ['Historical runs do not contain authoritative contemporaneous native table-permission/data snapshots. Reconstructed fixture/variant inputs cannot prove exact deployment parity.', 'This runner does not replay the HTTP middleware or CLR pipeline; missing recorded contexts remain unqualified.', 'Errors and successful empty results remain separate; query shapes are checked against checksummed stage-10 plugin captures.'], runs: []};
const plans = [...manifest.cases, ...manifest.stressCases];
for (const {file, run, snapshotHash, capturedAt} of indexed.values()) {
  const variant = job.variants?.[run.runId] ?? 'baseline';
  if (!['baseline', 'stress', 'safe-secondary-subtree-disabled', 'parent-only-disabled-negative-fault'].includes(variant)) throw new Error('Unknown explicit replay variant.');
  const stress = variant === 'stress', safeDeep = variant === 'safe-secondary-subtree-disabled', orphan = variant === 'parent-only-disabled-negative-fault';
  const inactivePermissionIds = safeDeep ? deepVariantKeys.map(key => componentId('permission:' + key)) : orphan ? [componentId('permission:' + deepVariantKeys[0])] : [];
  const environment = replayStore({schema, catalogue, overlay: stress ? stressOverlay : baselineOverlay, nativeComponents: components, roles: run.roles, contactId: run.contactId, inactivePermissionIds, observed: job.observedProfiles?.[variant] ?? {}});
  const pairs = [];
  for (const pair of run.pairs) {
    const plan = plans.find(plan => plan.id === pair.caseId); if (!plan) {pairs.push({caseId: pair.caseId, verdict: 'unqualified', reason: 'missing-plan'}); continue;}
    const lanes = {};
    for (const name of ['liquid', 'webapi']) {
      const native = pair[name], replay = replayLane(native, plan, {...environment, compile: compilePermissionFetchXml});
      const shape = rows => stable((rows ?? []).map(stable).sort());
      const rowVerdict = native.complete && replay.complete && native.outcome === 'success' && replay.outcome === 'success' ? shape(native.rows) === shape(replay.rows) ? 'equal' : 'different' : 'unqualified';
      lanes[name] = {nativeOutcome: native.outcome, mirageOutcome: replay.outcome, nativeCount: native.rows?.length, mirageCount: replay.rows.length, rowVerdict,
        queryComparisons: replay.queryComparisons, errors: replay.pages.filter(page => page.error).map(page => page.error)};
    }
    pairs.push({caseId: pair.caseId, ...lanes});
  }
  report.runs.push({file, capturedAt, snapshotHash, roleCount: run.roles.filter(role => role.startsWith('CO ') && role !== 'CO Test Runner').length, reconstruction: variant,
    evidenceQualification: {nativeConfigurationVerified: false, nativeMembershipsVerified: false, nativeDataVerified: false, nativeCacheQualified: false},
    observed: job.observedProfiles?.[variant] ?? {}, diagnostics: environment.diagnostics, pairs});
}
report.coverage = coverageLedger([...indexed.values()].map(item => item.run), Object.entries(roleNames).filter(([code]) => code !== 'TESTRUNNER').map(([, name]) => `CO ${name}`));
report.summary = {runs: report.runs.length, pairs: report.runs.reduce((count, run) => count + run.pairs.length, 0)};
for (const verdict of ['equal', 'different', 'unqualified']) {
  report.summary[`${verdict}Rows`] = report.runs.flatMap(run => run.pairs).flatMap(pair => [pair.liquid, pair.webapi]).filter(lane => lane?.rowVerdict === verdict).length;
  report.summary[`${verdict}Queries`] = report.runs.flatMap(run => run.pairs).flatMap(pair => [pair.liquid, pair.webapi]).flatMap(lane => lane?.queryComparisons ?? []).filter(query => query.verdict === verdict).length;
}
const byteComparisons = report.runs.flatMap(run => run.pairs).flatMap(pair => [pair.liquid, pair.webapi]).flatMap(lane => lane?.queryComparisons ?? []);
report.summary.exactBackendXmlMatches = byteComparisons.filter(query => query.exactBackendXml === true).length;
report.summary.exactBackendXmlDifferences = byteComparisons.filter(query => query.exactBackendXml === false).length;
await mkdir(path.dirname(job.output), {recursive: true}); await writeFile(job.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({...report.summary, roleSubsets: report.coverage.observedSubsets, possibleRoleSubsets: report.coverage.possibleSubsets, qualification: report.qualification, output: job.output}));
