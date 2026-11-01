import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { encodeArtifact } from '../portal-harness/core.mjs';
import path from 'node:path';
import os from 'node:os';
import {
  beginNativeMaskWindow,
  nativeMaskCapturePolicy,
  appendNativeMaskPage,
  finishNativeMaskWindow,
} from '../portal-harness/native-mask-window.mjs';
import { makeTemporaryDirectory } from 'paqvilo/mirage/testing/owned-fixture.mjs';

const hash = 'a'.repeat(64),
  contactId = '00000000-0000-0000-0000-000000000001';
const before = {
  snapshot: {
    complete: true,
    siteId: '00000000-0000-0000-0000-000000000002',
    contactId,
    capturedAt: '2026-10-13T00:00:01Z',
    permissionSnapshotHash: hash,
    membershipSnapshotHash: hash,
    dataSnapshotHash: hash,
    rowVersionSnapshotHash: hash,
  },
  siteComponentsSha256: hash,
  registrationSha256: hash,
};
const control = {
  contactId,
  portalIdentityObserved: true,
  businessRoleNames: ['Fixture Reader'],
  permissionSnapshotHash: hash,
  membershipSnapshotHash: hash,
  siteComponentsSha256: hash,
  registrationSha256: hash,
};
async function setup(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mask-window-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const journalFile = path.join(directory, 'window.json'),
    cacheJournalFile = path.join(directory, 'cache.json');
  await writeFile(
    cacheJournalFile,
    JSON.stringify({
      actor: contactId,
      finishedAt: '2026-10-13T00:00:00Z',
      actions: [
        { name: 'clearConfig', status: 'completed' },
        { name: 'clearCache', status: 'completed' },
      ],
    }),
  );
  const window = await beginNativeMaskWindow({
    journalFile,
    mask: 1,
    domainHash: hash,
    before,
    businessRoleNames: ['Fixture Reader'],
    cacheJournalFile,
  });
  return { directory, journalFile, cacheJournalFile, window };
}
async function capture(directory, page) {
  const operationId = `00000000-0000-0000-0000-${String(10 + page).padStart(12, '0')}`;
  const file = path.join(directory, 'page-' + page + '.archive'),
    authoredFetchXml = '<fetch page="' + page + '" />';
  const captured = {
    requests: [{ page, operationId, lane: 'webapi', caseId: 'FixtureRead', authoredFetchXml }],
    qualification: { portalActorVerified: true, physical: [{ operationId, lane: 'webapi', queries: [], errors: [] }] },
    recordingInputs: {
      run: { pqvd_testrunid: '00000000-0000-0000-0000-000000000003' },
      operations: [{ pqvd_testoperationid: operationId }],
    },
  };
  const bytes = gzipSync(Buffer.from(JSON.stringify({ capture: captured })));
  await writeFile(file, bytes);
  const archive = { file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  const journalFile = path.join(directory, 'page-' + page + '-history.json'),
    runId = captured.recordingInputs.run.pqvd_testrunid;
  await writeFile(
    journalFile,
    JSON.stringify({
      kind: 'NativeReadHistory',
      runId,
      runSummary: { status: 'verified', sha256: hash },
      entries: [
        {
          id: operationId,
          status: 'verified',
          summary: { runId, caseId: 'FixtureRead', lane: 'webapi', page, archiveSha256: archive.sha256 },
          body: {
            pqvd_physicalqueryhash: createHash('sha256').update(authoredFetchXml).digest('hex'),
            pqvd_authoredquery: await encodeArtifact(authoredFetchXml),
          },
        },
      ],
    }),
  );
  return { ...captured, history: { runId, operations: 1, runSummarySha256: hash, journalFile }, archive };
}

test('mask pages reuse one actual dual-cache epoch but remain unqualified until shared final data/versions witness', async (t) => {
  const state = await setup(t);
  assert.equal(
    nativeMaskCapturePolicy({ window: state.window, page: 1, actualControl: control }).fixtureWitness,
    'whole-mask-boundaries',
  );
  await appendNativeMaskPage({
    journalFile: state.journalFile,
    page: 1,
    capture: await capture(state.directory, 1),
    beforeControl: control,
    afterControl: control,
  });
  const current = JSON.parse(await readFile(state.journalFile));
  assert.equal(current.qualification, 'unqualified-until-mask-final-boundary');
  assert.equal(current.pages[0].qualification, 'pending-mask-final-boundary');
  const policy = nativeMaskCapturePolicy({ window: current, page: 2, actualControl: control });
  assert.equal(policy.cache, 'reuse-window-dual-cache-receipt');
  assert.equal(policy.cacheJournalSha256, state.window.cacheReceipt.sha256);
  await appendNativeMaskPage({
    journalFile: state.journalFile,
    page: 2,
    capture: await capture(state.directory, 2),
    beforeControl: control,
    afterControl: control,
  });
  const proof = await finishNativeMaskWindow({
    journalFile: state.journalFile,
    after: before,
    continuationsExhausted: true,
  });
  assert.equal(proof.pages, 2);
  assert.equal(proof.physicalRequests, 2);
  assert.equal(proof.nativeMirageParityQualified, false);
});

test('continuation rejects actor/source/registry changes and process-recovered windows before skipping caches', async (t) => {
  const { window } = await setup(t);
  for (const change of [
    { contactId: 'wrong' },
    { membershipSnapshotHash: 'b'.repeat(64) },
    { siteComponentsSha256: 'b'.repeat(64) },
    { registrationSha256: 'b'.repeat(64) },
    { businessRoleNames: [] },
    { portalIdentityObserved: false },
  ])
    assert.throws(
      () => nativeMaskCapturePolicy({ window, page: 1, actualControl: { ...control, ...change } }),
      /drifted/,
    );
  assert.throws(
    () => nativeMaskCapturePolicy({ window: { ...window, pid: -1 }, page: 1, actualControl: control }),
    /recovered/,
  );
  assert.throws(() => nativeMaskCapturePolicy({ window, page: 2, actualControl: control }), /next page/);
});

test('rowversion drift rejects every page and preserves its original archived evidence', async (t) => {
  const state = await setup(t);
  await appendNativeMaskPage({
    journalFile: state.journalFile,
    page: 1,
    capture: await capture(state.directory, 1),
    beforeControl: control,
    afterControl: control,
  });
  await assert.rejects(
    finishNativeMaskWindow({
      journalFile: state.journalFile,
      after: { ...before, snapshot: { ...before.snapshot, rowVersionSnapshotHash: 'b'.repeat(64) } },
      continuationsExhausted: true,
    }),
    /all collected pages remain unqualified/,
  );
  const rejected = JSON.parse(await readFile(state.journalFile));
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.pages[0].qualification, 'pending-mask-final-boundary');
  assert.ok(await readFile(rejected.pages[0].archive.file));
});

test('mask qualification checks original archive bytes and distinct SDK operation IDs across pages', async (t) => {
  const state = await setup(t),
    first = await capture(state.directory, 1);
  await appendNativeMaskPage({
    journalFile: state.journalFile,
    page: 1,
    capture: first,
    beforeControl: control,
    afterControl: control,
  });
  const duplicate = await capture(state.directory, 2);
  duplicate.requests[0].operationId = first.requests[0].operationId;
  await assert.rejects(
    appendNativeMaskPage({
      journalFile: state.journalFile,
      page: 2,
      capture: duplicate,
      beforeControl: control,
      afterControl: control,
    }),
    /archived native capture/,
  );
  await writeFile(first.archive.file, 'changed');
  await assert.rejects(
    finishNativeMaskWindow({ journalFile: state.journalFile, after: before, continuationsExhausted: true }),
    /page-archive/,
  );
});

test('an unchanged archive checksum cannot qualify tampered passed query/context/SDK readback inventory', async (t) => {
  const state = await setup(t),
    original = await capture(state.directory, 1);
  for (const mutate of [
    (value) => (value.requests[0].authoredFetchXml = '<fetch page="9"/>'),
    (value) => (value.recordingInputs.operations[0].pqvd_testoperationid = contactId),
    (value) => value.qualification.physical[0].queries.push({ invented: true }),
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    await assert.rejects(
      appendNativeMaskPage({
        journalFile: state.journalFile,
        page: 1,
        capture: changed,
        beforeControl: control,
        afterControl: control,
      }),
      /archived native capture/,
    );
  }
});
