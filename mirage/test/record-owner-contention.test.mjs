// @test-kind contract+security: sharing contention cannot lose an ownership marker, admit a different owner, or make retries unbounded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimRecordDirectory, stateRecordOwner } from '../lib/record-file-lease.mjs';

for (const [holdMs, format] of [
  [250, 2],
  [2500, 1],
]) {
  test(`owner relocation recovers a ${holdMs} ms sharing hold for format ${format}`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-owner-contention-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, '.record-owner.json'),
      key = 'a'.repeat(64);
    const before = format === 2 ? { format: 2, key, state: 'b'.repeat(64) } : { format: 1, key };
    fs.writeFileSync(file, JSON.stringify(before));
    const location = stateRecordOwner(path.join(root, 'state.json'));
    let elapsed = 0,
      attempts = 0;
    // A controlled filesystem releases its sharing hold only after the requested waiting budget.
    // No wall-clock sleeps or probabilistic reruns: retain the 250 ms case and cover a legacy
    // marker held beyond the two-second window that failed during full Windows validation.
    t.mock.method(Atomics, 'wait', (_array, _index, _value, timeout) => {
      elapsed += timeout;
      return 'timed-out';
    });
    const result = claimRecordDirectory(root, {
      ownerKey: key,
      location,
      io: {
        ...fs,
        renameSync(...args) {
          attempts++;
          if (elapsed < holdMs) {
            assert.deepEqual(
              JSON.parse(fs.readFileSync(file, 'utf8')),
              before,
              'the preceding marker stays valid throughout contention',
            );
            throw Object.assign(new Error('Invented Windows sharing hold'), { code: 'EPERM' });
          }
          return fs.renameSync(...args);
        },
      },
    });
    assert.deepEqual(result, { key, owned: true });
    assert.ok(attempts > 1 && attempts < 100);
    if (holdMs === 250) assert.ok(elapsed >= 250 && elapsed <= 2000);
    else assert.ok(elapsed >= 2500 && elapsed < 10000);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { format: 2, key, state: location });
    assert.deepEqual(fs.readdirSync(root), ['.record-owner.json']);
  });
}
