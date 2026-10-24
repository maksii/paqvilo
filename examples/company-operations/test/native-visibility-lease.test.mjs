import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inspectNativeVisibilityLease,
  activateNativeVisibilityLease,
  restoreNativeVisibilityLease,
} from '../portal-harness/native-visibility-lease.mjs';
const id = '10000000-0000-4000-8000-000000000001',
  record = '20000000-0000-4000-8000-000000000001',
  target = {
    environment: 'https://tenant.example.invalid',
    managementId: id,
    websiteRecordId: record,
    websiteUrl: 'https://demo.example.invalid/',
  };
test('visibility lease journals uncertain writes, restores exact private demo and refuses another target', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'paqvilo-visibility-'));
  try {
    const current = {
      id,
      websiteRecordId: record,
      websiteUrl: target.websiteUrl,
      name: 'Demo',
      type: 'Trial',
      siteVisibility: 'private',
    };
    let fail = true;
    const dep = {
      readSite: async () => structuredClone(current),
      setVisibility: async (options) => {
        current.siteVisibility = options.visibility;
        if (fail) {
          fail = false;
          throw new Error('Unknown committed outcome');
        }
      },
      delay: async () => {},
    };
    const plan = await inspectNativeVisibilityLease(target, dep),
      file = path.join(directory, 'lease.json');
    await assert.rejects(activateNativeVisibilityLease(plan, file, dep), /Unknown committed/);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'pending');
    assert.equal(current.siteVisibility, 'public');
    await restoreNativeVisibilityLease(file, dep);
    assert.equal(current.siteVisibility, 'private');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).state, 'restored');
    await assert.rejects(activateNativeVisibilityLease(plan, file, dep), { code: 'EEXIST' });
    const file2 = path.join(directory, 'lease2.json');
    await activateNativeVisibilityLease(plan, file2, dep);
    current.websiteRecordId = id;
    await assert.rejects(restoreNativeVisibilityLease(file2, dep), /foreign management drift/);
    await assert.rejects(inspectNativeVisibilityLease(target, dep), /exact private trial/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
