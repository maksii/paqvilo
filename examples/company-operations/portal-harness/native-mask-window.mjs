import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { compareNativeSnapshots } from './native-capture.mjs';
import { savePrivateJson } from './private-journal.mjs';
import { stable, decodeArtifact } from './core.mjs';

const sha = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value))
    .digest('hex');
const hashPattern = /^[a-f0-9]{64}$/i,
  guidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const read = async (file) => JSON.parse(await readFile(file, 'utf8'));
const capturedInventory = (capture) => {
  const { archive: ignoredArchive, history: ignoredHistory, ...inventory } = capture;
  return inventory;
};
const roleNames = (values) => [...new Set(values)].sort();
const snapshotFields = [
  'permissionSnapshotHash',
  'membershipSnapshotHash',
  'dataSnapshotHash',
  'rowVersionSnapshotHash',
];

function boundary(value) {
  if (
    value?.snapshot?.complete !== true ||
    !guidPattern.test(value.snapshot.siteId ?? '') ||
    !guidPattern.test(value.snapshot.contactId ?? '') ||
    snapshotFields.some((field) => !hashPattern.test(value.snapshot[field] ?? '')) ||
    !hashPattern.test(value.siteComponentsSha256 ?? '') ||
    !hashPattern.test(value.registrationSha256 ?? '')
  )
    throw new Error('A complete actual mask boundary snapshot/source/registry witness is required.');
  return {
    snapshot: Object.fromEntries(
      ['siteId', 'contactId', 'complete', 'capturedAt', ...snapshotFields].map((field) => [
        field,
        value.snapshot[field],
      ]),
    ),
    siteComponentsSha256: value.siteComponentsSha256,
    registrationSha256: value.registrationSha256,
  };
}

function verifyPageControl(actual, window) {
  if (
    !actual ||
    actual.contactId !== window.contactId ||
    actual.portalIdentityObserved !== true ||
    !Array.isArray(actual.businessRoleNames) ||
    stable(roleNames(actual.businessRoleNames)) !== stable(window.businessRoleNames) ||
    actual.permissionSnapshotHash !== window.before.snapshot.permissionSnapshotHash ||
    actual.membershipSnapshotHash !== window.before.snapshot.membershipSnapshotHash ||
    actual.siteComponentsSha256 !== window.before.siteComponentsSha256 ||
    actual.registrationSha256 !== window.before.registrationSha256
  )
    throw new Error('Same-mask continuation actor, memberships, source or registry drifted.');
  return { ...actual, businessRoleNames: roleNames(actual.businessRoleNames) };
}

async function verifyPageArchive(archive, inventoryHash) {
  const bytes = await readFile(archive.file);
  if (bytes.length > 32 * 1024 * 1024 || sha(bytes) !== archive.sha256)
    throw new Error('Native page archive bytes changed.');
  const envelope = JSON.parse(gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8'));
  if (!envelope.capture || sha(capturedInventory(envelope.capture)) !== inventoryHash)
    throw new Error('Original archived native capture does not bind the supplied request/wire/SDK/context inventory.');
  return envelope;
}

async function verifyPageHistory(capture) {
  const history = await read(capture.history.journalFile),
    requests = capture.requests;
  if (
    history.kind !== 'NativeReadHistory' ||
    history.runId !== capture.recordingInputs.run.pqvd_testrunid ||
    history.runId !== capture.history.runId ||
    history.runSummary?.status !== 'verified' ||
    history.runSummary.sha256 !== capture.history.runSummarySha256 ||
    history.entries?.length !== requests.length
  )
    throw new Error('Native page history journal is not bound to the actual captured Run/inventory.');
  for (const request of requests) {
    const entries = history.entries.filter((entry) => entry.id === request.operationId),
      entry = entries[0];
    const authored = request.authoredFetchXml ?? request.authoredRequest;
    if (
      entries.length !== 1 ||
      entry.status !== 'verified' ||
      entry.summary?.runId !== history.runId ||
      entry.summary.caseId !== request.caseId ||
      entry.summary.lane !== request.lane ||
      entry.summary.page !== (request.page ?? 1) ||
      entry.summary.archiveSha256 !== capture.archive.sha256 ||
      entry.body?.pqvd_physicalqueryhash !== sha(authored) ||
      (await decodeArtifact(entry.body?.pqvd_authoredquery)) !== authored
    )
      throw new Error('Native page persisted history does not bind the actual archived authored input.');
  }
  return {
    file: capture.history.journalFile,
    sha256: sha(await readFile(capture.history.journalFile)),
    scope:
      'Durable writer readback receipts; independent native operation/run history is verified by the final campaign ledger.',
  };
}

/** Start only after an actual role/source transition, both cache clears and a
 * full independent fixture/rowversion snapshot. The cached page policy below
 * is bounded to this one durable window; process restart does not reuse it. */
export async function beginNativeMaskWindow({
  journalFile,
  mask,
  domainHash,
  before,
  businessRoleNames,
  cacheJournalFile,
}) {
  if (
    !Number.isInteger(mask) ||
    mask < 0 ||
    mask > 4095 ||
    !hashPattern.test(domainHash ?? '') ||
    !Array.isArray(businessRoleNames) ||
    businessRoleNames.some((name) => typeof name !== 'string' || !name)
  )
    throw new Error('Bind the frozen twelve-role mask/domain and its actual business role names.');
  const source = boundary(before),
    bytes = await readFile(cacheJournalFile),
    cache = JSON.parse(bytes);
  if (
    cache.actor !== source.snapshot.contactId ||
    !Number.isFinite(Date.parse(cache.finishedAt)) ||
    !['clearConfig', 'clearCache'].every(
      (name) => cache.actions?.filter((action) => action.name === name && action.status === 'completed').length === 1,
    ) ||
    cache.actions?.length !== 2 ||
    Date.parse(source.snapshot.capturedAt) < Date.parse(cache.finishedAt) ||
    !Number.isFinite(Date.parse(source.snapshot.capturedAt))
  )
    throw new Error('Mask reuse requires actual completed dual-cache journal and a subsequent full snapshot.');
  const window = {
    schemaVersion: 1,
    kind: 'NativeMaskReadWindow',
    id: randomUUID(),
    mask,
    domainHash,
    pid: process.pid,
    contactId: source.snapshot.contactId,
    businessRoleNames: roleNames(businessRoleNames),
    before: source,
    cacheReceipt: { file: cacheJournalFile, sha256: sha(bytes), finishedAt: cache.finishedAt },
    pages: [],
    state: 'collecting',
    startedAt: new Date().toISOString(),
    qualification: 'unqualified-until-mask-final-boundary',
  };
  await savePrivateJson(journalFile, window, { exclusive: true });
  return window;
}

/** Page1 starts a fresh window. A continuation clears neither cache and does
 * not read the entire fixture graph again. It must still independently read
 * actual actor/memberships/source/registry and prepare distinct SDK intents. */
export function nativeMaskCapturePolicy({ window, page, actualControl }) {
  if (
    window?.kind !== 'NativeMaskReadWindow' ||
    window.pid !== process.pid ||
    window.state !== 'collecting' ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 20 ||
    page !== window.pages.length + 1
  )
    throw new Error(
      'A live owned window and its exact next page are required; recovered windows cannot skip cache refresh.',
    );
  verifyPageControl(actualControl, window);
  return {
    windowId: window.id,
    mask: window.mask,
    page,
    cache: 'reuse-window-dual-cache-receipt',
    cacheJournalFile: window.cacheReceipt.file,
    cacheJournalSha256: window.cacheReceipt.sha256,
    fixtureWitness: 'whole-mask-boundaries',
    perPageControls: ['actual-portal-actor', 'actual-native-memberships', 'source', 'registry'],
    nativeQualification: 'pending-mask-final-boundary',
    sdkIntentPreparation: 'new-independent-operation-per-physical-page',
  };
}

/** Append original bytes/history while withholding qualification. The final
 * boundary is a separate immutable receipt; earlier page captures are never
 * rewritten to pretend that a fresh per-page fixture snapshot occurred. */
export async function appendNativeMaskPage({ journalFile, page, capture, beforeControl, afterControl }) {
  const window = await read(journalFile);
  nativeMaskCapturePolicy({ window, page, actualControl: beforeControl });
  verifyPageControl(afterControl, window);
  if (
    !Array.isArray(capture?.requests) ||
    !capture.requests.length ||
    capture.qualification?.portalActorVerified !== true ||
    !Array.isArray(capture.qualification?.physical) ||
    capture.qualification.physical.length !== capture.requests.length ||
    capture.qualification.physical.some((row) => !Array.isArray(row.errors) || row.errors.length) ||
    capture.history?.operations !== capture.requests.length ||
    !hashPattern.test(capture.history?.runSummarySha256 ?? '') ||
    !hashPattern.test(capture.archive?.sha256 ?? '')
  )
    throw new Error(
      'Every page requires actual actor-bound wire/query checks, SDK history and original immutable archive.',
    );
  const inventoryHash = sha(capturedInventory(capture));
  await verifyPageArchive(capture.archive, inventoryHash);
  const previous = new Set(window.pages.flatMap((row) => row.operationIds)),
    operations = new Set();
  for (const request of capture.requests) {
    if (
      !guidPattern.test(request.operationId ?? '') ||
      (request.page ?? 1) !== page ||
      previous.has(request.operationId) ||
      operations.has(request.operationId)
    )
      throw new Error('Each physical page requires a distinct actual operation and exact authored page binding.');
    operations.add(request.operationId);
    if (
      capture.qualification.physical.filter(
        (row) => row.operationId === request.operationId && row.lane === request.lane,
      ).length !== 1
    )
      throw new Error('Physical native query/wire inventory is not uniquely bound to its request.');
  }
  const sdk = capture.recordingInputs;
  if (
    !guidPattern.test(sdk?.run?.pqvd_testrunid ?? '') ||
    !Array.isArray(sdk.operations) ||
    sdk.operations.length !== operations.size ||
    sdk.operations.some((operation) => !operations.has(operation.pqvd_testoperationid)) ||
    new Set(sdk.operations.map((operation) => operation.pqvd_testoperationid)).size !== operations.size
  )
    throw new Error('Actual SDK Run/operation readbacks must bind the complete page request inventory.');
  const historyReceipt = await verifyPageHistory(capture);
  window.pages.push({
    page,
    physicalRequests: capture.requests.length,
    operationIds: [...operations],
    archive: { ...capture.archive },
    history: { ...capture.history },
    sdkRunId: sdk.run.pqvd_testrunid,
    capturedInventorySha256: inventoryHash,
    historyReceipt,
    beforeControl: verifyPageControl(beforeControl, window),
    afterControl: verifyPageControl(afterControl, window),
    qualification: 'pending-mask-final-boundary',
    capturedAt: new Date().toISOString(),
  });
  await savePrivateJson(journalFile, window);
  return window.pages.at(-1);
}

/** Caller closes only after every observed continuation is exhausted. Missing
 * or failed page collections stay unqualified; source/fixture drift rejects
 * every page in this window rather than treating earlier partials as passes. */
export async function finishNativeMaskWindow({ journalFile, after, continuationsExhausted }) {
  const window = await read(journalFile);
  if (
    window.pid !== process.pid ||
    window.state !== 'collecting' ||
    !window.pages.length ||
    continuationsExhausted !== true
  )
    throw new Error('Only a live complete window can acquire its shared final witness.');
  const final = boundary(after),
    comparison = compareNativeSnapshots(window.before.snapshot, final.snapshot);
  const errors = [...comparison.changed];
  if (window.before.siteComponentsSha256 !== final.siteComponentsSha256) errors.push('site-source');
  if (window.before.registrationSha256 !== final.registrationSha256) errors.push('registry');
  const cacheBytes = await readFile(window.cacheReceipt.file);
  if (sha(cacheBytes) !== window.cacheReceipt.sha256) errors.push('cache-journal');
  for (const page of window.pages) {
    try {
      await verifyPageArchive(page.archive, page.capturedInventorySha256);
    } catch {
      errors.push('page-archive:' + page.page);
    }
    if (sha(await readFile(page.historyReceipt.file)) !== page.historyReceipt.sha256)
      errors.push('page-history:' + page.page);
  }
  window.after = final;
  window.state = errors.length ? 'rejected' : 'closed';
  window.errors = errors;
  window.finishedAt = new Date().toISOString();
  window.qualification = errors.length ? 'unqualified-mask-drift' : 'native-mask-boundary-collection';
  window.receiptSha256 = sha({
    id: window.id,
    mask: window.mask,
    domainHash: window.domainHash,
    before: window.before,
    after: final,
    pages: window.pages,
    cacheReceipt: window.cacheReceipt,
    errors,
  });
  await savePrivateJson(journalFile, window);
  if (errors.length)
    throw new Error('Shared mask boundary changed; all collected pages remain unqualified: ' + errors.join(', '));
  return {
    windowId: window.id,
    mask: window.mask,
    pages: window.pages.length,
    physicalRequests: window.pages.reduce((count, page) => count + page.physicalRequests, 0),
    receiptSha256: window.receiptSha256,
    qualification: window.qualification,
    witnessScope:
      'Actual actor/memberships/source/registry per page; actual fixture/rowversion snapshots at whole-mask boundaries.',
    nativeMirageParityQualified: false,
  };
}
