import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continuationCases,
  pendingCampaignMasks,
  campaignFrozenWitnesses,
} from '../portal-harness/native-campaign.mjs';
import { campaignStopRequested } from '../portal-harness/native-campaign.mjs';
import { withNativeCampaignWorkerLease } from '../portal-harness/native-campaign.mjs';
import { nativeAssemblyIdentityMatches } from '../portal-harness/native-campaign.mjs';
import { nativeCampaignContinuationPolicy } from '../portal-harness/native-campaign.mjs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('unfinished shared-boundary collection and unknown policies cannot skip supported per-page checks', () => {
  assert.equal(nativeCampaignContinuationPolicy(), 'per-page');
  assert.throws(() => nativeCampaignContinuationPolicy('mask-window'), /not implemented/);
  for (const value of [null, true, 'cached', '', {}, 'mask-window '])
    assert.throws(() => nativeCampaignContinuationPolicy(value), /continuation policy/);
});
test('native CLR identity matches exact installed assembly fields without inventing installation metadata', () => {
  const actual = {
      name: 'Fixture.Observer',
      version: '1.0.0.0',
      moduleVersionId: '10000000-0000-0000-0000-000000000001',
    },
    expected = { ...actual, available: true };
  assert.equal(nativeAssemblyIdentityMatches(actual, expected), true);
  for (const field of ['name', 'version', 'moduleVersionId'])
    assert.equal(nativeAssemblyIdentityMatches({ ...actual, [field]: 'changed' }, expected), false);
  assert.equal(nativeAssemblyIdentityMatches(actual, { ...expected, available: false }), false);
  assert.equal(nativeAssemblyIdentityMatches(actual, { ...actual }), false);
  assert.equal(nativeAssemblyIdentityMatches(null, expected), false);
});
test('native actor worker lock rejects concurrent and stale ownership before executing work', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-worker-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const siteId = '10000000-0000-0000-0000-000000000001',
    contactId = '10000000-0000-0000-0000-000000000002',
    workerLock = path.join(dir, `${siteId}-${contactId}.native-campaign.lock.json`),
    config = { siteId, contactId, workerLock };
  let invoked = false;
  await withNativeCampaignWorkerLease(config, async () => {
    assert.equal(JSON.parse(await readFile(workerLock, 'utf8')).pid, process.pid);
    await assert.rejects(
      withNativeCampaignWorkerLease(config, () => {
        invoked = true;
      }),
      { code: 'EEXIST' },
    );
  });
  assert.equal(invoked, false);
  await assert.rejects(readFile(workerLock), { code: 'ENOENT' });
  await writeFile(
    workerLock,
    JSON.stringify({ kind: 'NativeCampaignWorkerLease', pid: 999999999, owner: 'interrupted' }),
  );
  await assert.rejects(
    withNativeCampaignWorkerLease(config, () => {
      invoked = true;
    }),
    { code: 'EEXIST' },
  );
  assert.equal(invoked, false);
  assert.equal(JSON.parse(await readFile(workerLock, 'utf8')).owner, 'interrupted');
  await assert.rejects(
    withNativeCampaignWorkerLease({ ...config, workerLock: path.join(dir, 'wrong.json') }, () => {}),
    /shared actor/,
  );
});
test('native actor worker lock releases its own file on failure and preserves changed ownership', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-worker-failure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const siteId = '10000000-0000-0000-0000-000000000003',
    contactId = '10000000-0000-0000-0000-000000000004',
    workerLock = path.join(dir, `${siteId}-${contactId}.native-campaign.lock.json`),
    config = { siteId, contactId, workerLock };
  await assert.rejects(
    withNativeCampaignWorkerLease(config, () => {
      throw new Error('child failed');
    }),
    /child failed/,
  );
  await assert.rejects(readFile(workerLock), { code: 'ENOENT' });
  await assert.rejects(
    withNativeCampaignWorkerLease(config, async () => {
      await writeFile(workerLock, JSON.stringify({ owner: 'other' }));
    }),
    /ownership changed/,
  );
  assert.deepEqual(JSON.parse(await readFile(workerLock, 'utf8')), { owner: 'other' });
});
test('campaign stop control is explicit and never consumes or rewrites its request', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-stop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stop');
  assert.equal(await campaignStopRequested(), false);
  assert.equal(await campaignStopRequested(file), false);
  await writeFile(file, 'Stop after a completed mask.');
  assert.equal(await campaignStopRequested(file), true);
  assert.equal(await campaignStopRequested(file), true);
  await assert.rejects(campaignStopRequested('relative'), /absolute/);
});
test('native campaign only continues measured full/successful pages', () => {
  const manifest = {
      cases: [
        { id: 'page', pageSize: 2 },
        { id: 'denied', pageSize: 2 },
      ],
    },
    capture = {
      requests: [
        { caseId: 'page', operationId: 'one', lane: 'webapi' },
        { caseId: 'denied', operationId: 'two', lane: 'webapi' },
      ],
      results: [
        { operationId: 'one', lane: 'webapi', status: 200, body: '{"value":[{},{}]}' },
        { operationId: 'two', lane: 'webapi', status: 403, body: '{"value":[{},{}]}' },
      ],
    };
  assert.deepEqual(continuationCases(capture, manifest), ['page']);
  capture.results[0].body = '{"value":[]}';
  assert.deepEqual(continuationCases(capture, manifest), []);
});
test('native campaign resume preserves failed attempts without counting them as coverage', () => {
  const domain = {
      domainHash: 'frozen',
      roleMaskCount: 4,
      businessRoles: [
        { code: 'A', id: 'a', name: 'A' },
        { code: 'B', id: 'b', name: 'B' },
      ],
    },
    journal = {
      domainHash: 'frozen',
      masks: [
        { mask: 0, state: 'collected' },
        { mask: 1, state: 'pending' },
      ],
    };
  assert.deepEqual(
    pendingCampaignMasks(domain, journal, 2).map((row) => row.mask),
    [1, 3],
  );
  assert.throws(() => pendingCampaignMasks(domain, { ...journal, domainHash: 'changed' }, 2), /source domain changed/);
  assert.throws(() => pendingCampaignMasks(domain, journal, 0), /batch size/);
});
test('native campaign freeze includes independent row versions and assembly receipt', () => {
  const frozen = {
      snapshot: {
        complete: true,
        permissionSnapshotHash: 'permissions',
        membershipSnapshotHash: 'memberships',
        dataSnapshotHash: 'data',
        rowVersionSnapshotHash: 'v1',
      },
      siteComponentsSha256: 'source',
      registrationSha256: 'steps',
      assemblies: [{ sha256: 'dll' }],
    },
    one = campaignFrozenWitnesses(frozen);
  assert.notEqual(
    campaignFrozenWitnesses({ ...frozen, snapshot: { ...frozen.snapshot, rowVersionSnapshotHash: 'v2' } })
      .nativeFixtures,
    one.nativeFixtures,
  );
  assert.notEqual(
    campaignFrozenWitnesses({ ...frozen, assemblies: [{ sha256: 'newdll' }] }).nativeConfiguration,
    one.nativeConfiguration,
  );
  assert.throws(
    () => campaignFrozenWitnesses({ ...frozen, snapshot: { ...frozen.snapshot, complete: false } }),
    /complete/,
  );
});
