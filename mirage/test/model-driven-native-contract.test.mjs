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
      '2f29fa7c4642839a8c24b276449de9b37a33a2d88f62fe4ca18a01f7b9912089',
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
