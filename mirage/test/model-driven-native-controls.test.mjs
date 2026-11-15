// @test-kind observation: two native UCI captures on 2026-11-08, taken after the selected controls render, produced the 19 rows of fixtures/model-driven-control-expected.json, SHA256 9d8a8c2989fdd76115db14323d58973c393bfa9686c642fbd52c8c28d77ff024, from the probe with SHA256 6255a59265adfd6608f4caf740e79882b3b049039d783b35d38d220b892e6b1e bound by control-plan.json (SHA256 d5a05a7a7f1575115181c0c9f9e48e6ecbd0260ea09c313def95b3124abc9c27). The empty option value NaN comes from fixtures/model-driven-choice-native-facts.json (SHA256 4cdfe3a46a4391a0600df6f4eb849cbafcaae09e43a490d6af9763221cd8ddcd); the older transport serialized it as JSON null. The probe input is typed in this test and the native plan is not committed, so no replay case records it.
import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';
import { captureModelDrivenControlContract } from '../testing/model-driven-contract.mjs';

const bytes = fs.readFileSync(new URL('./fixtures/model-driven-control-expected.json', import.meta.url));

const expected = JSON.parse(bytes);
const typedBytes = fs.readFileSync(new URL('./fixtures/model-driven-choice-native-facts.json', import.meta.url));

const typed = JSON.parse(typedBytes);

const options = ['Planned', 'In progress', 'Complete'].map((label, index) => ({ label, value: 198720000 + index }));
const fields = {
  x_choice: { name: 'x_choice', type: 'number', options },
  x_multi: { name: 'x_multi', type: 'multiselect', options },
  x_quantity: { name: 'x_quantity', type: 'number', dataverseType: 'int', minValue: 0, maxValue: 10000 },
  x_title: { name: 'x_title', type: 'text' },
};
let actual;
describe('native control contract', () => {
  before(async () => {
    assert.equal(
      createHash('sha256').update(captureModelDrivenControlContract.toString()).digest('hex'),
      '6255a59265adfd6608f4caf740e79882b3b049039d783b35d38d220b892e6b1e',
    );
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      '9d8a8c2989fdd76115db14323d58973c393bfa9686c642fbd52c8c28d77ff024',
    );
    assert.equal(
      createHash('sha256').update(typedBytes).digest('hex'),
      '4cdfe3a46a4391a0600df6f4eb849cbafcaae09e43a490d6af9763221cd8ddcd',
    );
    assert.deepEqual(typed.captures[0].cases, typed.captures[1].cases);
    for (const role of ['choice', 'multi']) {
      const state = typed.captures[0].cases.find((entry) => entry.id === `${role}-baseline`).facts.state;
      const first = state.entries.find((entry) => entry.key === 'first').value;
      const blank = first.entries.find((entry) => entry.key === '0').value;
      assert.deepEqual(blank.entries.find((entry) => entry.key === 'value').value, { type: 'number', value: 'NaN' });
    }
    const record = Object.fromEntries(Object.keys(fields).map((name) => [name, null])),
      state = new Map();
    const runtime = createFormClientRuntime({
      table: { entity: 'x_contract', fields },
      form: { attributes: Object.keys(fields) },
      record,
      read: (name) => record[name],
      write: (name, value) => {
        record[name] = value;
      },
      controlNames: (name) => (name ? [name] : Object.keys(fields)),
      controlField: (name) => name,
      controlState: (name, key, value) =>
        value === undefined ? state.get(name + ':' + key) : state.set(name + ':' + key, value),
      isValid: () =>
        !!record.x_title && (record.x_quantity === null || (record.x_quantity >= 0 && record.x_quantity <= 10000)),
    });
    actual = await captureModelDrivenControlContract(
      {
        names: { choice: 'x_choice', multi: 'x_multi', quantity: 'x_quantity', title: 'x_title' },
        dynamic: { text: 'Invented zero', value: 0 },
        kept: { text: 'Invented source', value: 198720001 },
        removed: 198720000,
        numbers: [-1, 10001, 0, 10000],
      },
      runtime.formContext,
    );
    runtime.destroy();
  });

  for (const row of expected) {
    test(`native control contract: ${row.id}`, () => {
      const result = actual.find((item) => item.id === row.id);
      if (['choice.controlOptionsAfterControlEdit', 'multi.controlOptionsAfterControlEdit'].includes(row.id)) {
        assert.deepEqual(result.value[0], { text: '', value: NaN });
        const serializedEmptyOption = JSON.parse(JSON.stringify(result.value[0]));
        assert.deepEqual({ ...result, value: [serializedEmptyOption, ...result.value.slice(1)] }, row);
      } else assert.deepEqual(result, row);
    });
  }
});
