// @test-kind contract: Local safety checks accompany the separately tagged, case-scoped native parity assertions below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { specimenApi, ID, PART } from './support/specimen-api.mjs';
import { captureWebApiInputContract } from '../testing/webapi-contract.mjs';

// @test-kind parity: Native unsupported-query holdouts reproduced twice with identical raw body hashes; only the private table route is replaced by invented specimens.
// @parity-evidence: webapi-native-query.json preserves the three authored inputs, exact response JSON, capture pair body hashes and collector/plan SHA256.
test('Dataverse unsupported query options retain the native redacted-name error', async (t) => {
  const queryBytes = fs.readFileSync(new URL('./fixtures/webapi-native-query.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(queryBytes).digest('hex'),
    'be47d4f9be565ad8439893a39b11d536b058bc2766ebbdef126f9d94e1e91cdb',
  );
  const queryProof = JSON.parse(queryBytes);
  const { request } = await specimenApi(t);
  for (const entry of queryProof.cases)
    await t.test(entry.id, async () => {
      const response = await request('specimens?' + new URLSearchParams({ [entry.key]: entry.value }));
      assert.equal(response.status, entry.status);
      assert.deepEqual(await response.json(), entry.body);
    });
});

// @test-kind parity: Two full native1071 rounds reproduce HTTP400 and exact codes for the six authored invalid PATCH values; fixture binds both native runs and collector sources.
// @parity-evidence: webapi-native-input-errors.json records exact case IDs, status/code guarantees and both raw native response hashes; private schema names alone are replaced by invented fields.
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
