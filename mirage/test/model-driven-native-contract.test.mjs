// @test-kind observation: two native UCI draft-form runs on 2026-11-08 (mirage/test/fixtures/frontend-parity-evidence.md) produced the 121 rows of fixtures/model-driven-contract-expected.json, SHA256 99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8; producer function SHA256 e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3, reproduced 2026-11-09 (fixtures/model-driven-producer-refresh-2026-11-09.json); the handler-slot ordinal probe was added in those runs without removing earlier assertions. The native plan is not committed and the fields are typed in fixtures/model-driven-contract.mjs, so no replay case records this input.
import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { captureModelDrivenContract } from '../testing/model-driven-contract.mjs';
import { modelDrivenContractFields, modelDrivenContractRuntime } from './fixtures/model-driven-contract.mjs';

const bytes = fs.readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url));

const expected = JSON.parse(bytes);
let actual;
describe('native form contract', () => {
  before(async () => {
    assert.equal(
      createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
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
