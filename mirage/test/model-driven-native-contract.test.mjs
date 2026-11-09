// @test-kind parity: two independent native UCI draft-form runs on 2026-11-08; mirage/test/fixtures/frontend-parity-evidence.md records the probe and evidence hashes.
import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { captureModelDrivenContract } from '../testing/model-driven-contract.mjs';
import { modelDrivenContractFields, modelDrivenContractRuntime } from './fixtures/model-driven-contract.mjs';

// @parity-evidence: the identical probe function ran in both native 2026-11-08 captures; its hash is recorded in the evidence manifest.

const bytes = fs.readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url));
// @parity-evidence: two fresh 2026-11-08 native runs add the handler-slot ordinal probe without removing any prior assertion.

const expected = JSON.parse(bytes);
let actual;
describe('native form contract', () => {
  // @parity-evidence: existing native fixture and probe SHA-256 pins are checked before any recorded case executes.
  before(async () => {
    assert.equal(
      createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
      // @parity-evidence: two fresh native UCI runs on 2026-11-09 reproduce the same ordered 121 cases (fixture SHA256 99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8); full post-state matches the unchanged public control. See model-driven-producer-refresh-2026-11-09.json.
      'e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3',
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8',
    );
    const runtime = modelDrivenContractRuntime();
    actual = await captureModelDrivenContract({ fields: modelDrivenContractFields }, runtime.formContext);
    runtime.destroy();
  });

  for (const row of expected) {
    test(`native form contract: ${row.id}`, () => {
      assert.deepEqual(
        actual.find((result) => result.id === row.id),
        row,
      );
    });
  }
});
