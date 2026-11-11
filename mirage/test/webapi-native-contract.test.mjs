// @test-kind contract: Local safety checks accompany the separately tagged, case-scoped native parity assertions below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { specimenApi, ID, PART } from './support/specimen-api.mjs';
import { captureWebApiInputContract } from '../testing/webapi-contract.mjs';

// @test-kind observation: two full native rounds (2026-11-08) recorded in fixtures/webapi-native-input-errors.json as case ids, status, code and raw response hashes; the six invalid PATCH values are typed in mirage/testing/webapi-contract.mjs and the oracle request is not recorded, so this is not a replay case.
test('Dataverse rejects invalid HTTP primitives before an Upsert SDK existence observer', async (t) => {
  const inputBytes = fs.readFileSync(new URL('./fixtures/webapi-native-input-errors.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(inputBytes).digest('hex'),
    'f693fb977bf24aeb9b150d5110687fd9e24668164e395e15dccf3fbb5ed9b966',
  );
  assert.equal(
    createHash('sha256')
      .update(fs.readFileSync(new URL('../testing/webapi-contract.mjs', import.meta.url)))
      .digest('hex'),
    '8d30332b553e45f62de42e317e853d0753f98864c062ab688398415e9a378b3a',
  );
  const inputProof = JSON.parse(inputBytes);
  const { store, request } = await specimenApi(t, {
    fields: {
      ratio: { dataverseType: 'float', minValue: -1000, maxValue: 1000 },
      tags: {
        dataverseType: 'multiselectpicklist',
        options: [
          { value: 1, label: 'One' },
          { value: 2, label: 'Two' },
        ],
      },
    },
  });
  store.state.mappings.specimenpart.relationships = {
    specimen: { entity: 'specimen', from: 'specimenid', to: 'specimenid', many: false },
  };
  store.setPluginPipeline(() => {});
  const results = await captureWebApiInputContract({
    request,
    collection: 'specimens',
    recordId: ID,
    fields: { double: 'ratio', choices: 'tags' },
    binding: { collection: 'specimenparts', recordId: PART, navigation: 'specimen', targetCollection: 'specimens' },
  });
  assert.deepEqual(
    results,
    inputProof.cases.map(({ nativeBodySha256: _hashes, ...entry }) => entry),
  );
});
