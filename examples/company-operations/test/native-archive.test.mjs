import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { archiveOwnedRun, cleanupArchivedRun } from '../portal-harness/native-archive.mjs';
import { makeTemporaryDirectory } from 'paqvilo/mirage/testing/owned-fixture.mjs';
test('owned immutable archive gates conditional cleanup and safely resumes an unknown deletion outcome', async () => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-archive-'));
  const runId = '00000000-0000-4000-8000-000000000001',
    opId = '00000000-0000-4000-8000-000000000002',
    eventId = '00000000-0000-4000-8000-000000000003',
    actor = 'actor';
  const intent = {
    source: 'SDK-created immutable recording intents; measured reads are portal requests',
    runId,
    actor,
    entries: [
      { status: 'created', body: { pqvd_runkey: 'owned' } },
      { status: 'verified', ids: [opId] },
    ],
  };
  const records = new Map(
    [
      [`pqvd_testruns(${runId})`, { pqvd_testrunid: runId, _pqvd_runnercontactid_value: actor, pqvd_runkey: 'owned' }],
      [
        `pqvd_testoperations(${opId})`,
        { pqvd_testoperationid: opId, _pqvd_runnercontactid_value: actor, _pqvd_runid_value: runId },
      ],
      [
        `pqvd_pluginevents(${eventId})`,
        { pqvd_plugineventid: eventId, _pqvd_operationid_value: opId, pqvd_payloadtext: 'recorded' },
      ],
    ].map(([key, row]) => [key, { ...row, '@odata.etag': 'W/"1"' }]),
  );
  let stop = true;
  const client = {
    get: async (query) => structuredClone(records.get(query)),
    optional: async (query) => structuredClone(records.get(query) ?? null),
    list: async (query) =>
      [...records.entries()]
        .filter(([key]) =>
          key.startsWith(query.startsWith('pqvd_testoperations?') ? 'pqvd_testoperations(' : 'pqvd_pluginevents('),
        )
        .map(([, row]) => structuredClone(row)),
    request: async (query, { method, ifMatch }) => {
      assert.equal(method, 'DELETE');
      assert.equal(ifMatch, records.get(query)['@odata.etag']);
      records.delete(query);
      if (stop) {
        stop = false;
        throw new Error('unknown deletion outcome');
      }
    },
  };
  const options = {
      intentJournalFile: path.join(dir, 'intent.json'),
      captureFile: path.join(dir, 'capture.json'),
      archiveFile: path.join(dir, 'archive.gz'),
      receiptFile: path.join(dir, 'receipt.json'),
    },
    cleanup = { receiptFile: options.receiptFile, journalFile: path.join(dir, 'cleanup.json') };
  try {
    await writeFile(options.intentJournalFile, JSON.stringify(intent));
    await writeFile(options.captureFile, JSON.stringify({ runId }));
    const receipt = await archiveOwnedRun(client, options);
    assert.equal(receipt.operationCount, 1);
    assert.equal(receipt.eventCount, 1);
    await assert.rejects(cleanupArchivedRun(client, cleanup), /unknown deletion outcome/);
    assert.equal(records.size, 2);
    await cleanupArchivedRun(client, { ...cleanup, resume: true });
    assert.equal(records.size, 0);
    assert.ok(
      JSON.parse(await readFile(cleanup.journalFile, 'utf8')).entries.every((entry) => entry.status === 'deleted'),
    );
    await writeFile(options.archiveFile, 'tampered');
    await assert.rejects(cleanupArchivedRun(client, { ...cleanup, resume: true }), /verified immutable archive/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
