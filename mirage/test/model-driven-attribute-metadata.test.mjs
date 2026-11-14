// @test-kind contract: imported field metadata and disposed-context refusals preserve local client boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { captureModelDrivenContract } from '../testing/model-driven-contract.mjs';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

function fixture(fields) {
  const record = {};
  return createFormClientRuntime({
    table: { entity: 'x_invented', fields, idColumn: 'x_inventedid', nameColumn: 'x_title' },
    form: { attributes: Object.keys(fields) },
    record,
    read: (name) => record[name],
    write: (name, value) => {
      record[name] = value;
    },
    controlNames: (name) => (name ? [name] : Object.keys(fields)),
    controlField: (name) => name,
  });
}

test('attribute metadata accessors retain source constraints independently of current values', () => {
  const runtime = fixture({
    x_amount: {
      name: 'x_amount',
      type: 'number',
      dataverseType: 'decimal',
      minValue: -12.25,
      maxValue: 0,
      precision: 3,
    },
    x_title: { name: 'x_title', type: 'text', maxLength: 47 },
    x_notes: { name: 'x_notes', type: 'textarea', maxLength: 2000 },
  });
  const amount = runtime.formContext.getAttribute('x_amount');
  amount.setValue(999);
  assert.deepEqual([amount.getMin(), amount.getMax(), amount.getPrecision()], [-12.25, 0, 3]);
  assert.equal(runtime.formContext.getAttribute('x_title').getMaxLength(), 47);
  assert.equal(runtime.formContext.getAttribute('x_notes').getMaxLength(), 2000);
  // Native form-membership facts (SHA256 0cbae975bfa35da7d5266c3be4a2110b5dc00ce6af2ca480e1ddc45a1b8fd3a1) record these getters as absent and the calls as TypeError; observation only, not a replay case.
  assert.throws(() => runtime.formContext.getAttribute('x_title').getMin(), TypeError);
  assert.throws(() => amount.getMaxLength(), TypeError);
  runtime.destroy();
  assert.throws(() => amount.getMax(), /disposed/);
});

test('missing limits refuse numeric accessors while integer precision derives from its type', async (t) => {
  const runtime = fixture({
    x_number: { name: 'x_number', type: 'number', dataverseType: 'int' },
    x_text: { name: 'x_text', type: 'text' },
    x_choice: { name: 'x_choice', type: 'number', options: [{ value: 1, label: 'First' }] },
    x_empty: {
      name: 'x_empty',
      type: 'number',
      dataverseType: 'picklist',
      options: [],
      minValue: 0,
      maxValue: 10,
      precision: 0,
    },
  });
  const number = runtime.formContext.getAttribute('x_number');
  assert.throws(() => number.getMin(), /without imported numeric minValue metadata/);
  assert.throws(() => number.getMax(), /without imported numeric maxValue metadata/);
  // @test-kind observation: two native UCI runs on 2026-11-08 reported integer precision 0 (mirage/test/fixtures/frontend-parity-evidence.md); the row integer.getPrecision is in fixtures/model-driven-contract-expected.json, SHA256 99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8, from the producer with SHA256 e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3, reproduced 2026-11-09. The integer field here is typed by hand, so no replay case records this input.
  await t.test('native integer precision is zero without a decimal scale', () => {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/model-driven-contract-expected.json', import.meta.url)))
        .digest('hex'),
      '99de1dcf0a8b390347e3780db499c30224c1dd39914995bcdf2a414faa2823a8',
    );
    assert.equal(
      createHash('sha256').update(captureModelDrivenContract.toString()).digest('hex'),
      'e80b3ac30fc180e3f62b25b21bc07ddbc5b6e74d93cfd67a67959587b044ecf3',
    );
    assert.equal(number.getPrecision(), 0);
  });
  assert.throws(
    () => runtime.formContext.getAttribute('x_text').getMaxLength(),
    /without imported numeric maxLength metadata/,
  );
  assert.throws(() => runtime.formContext.getAttribute('x_choice').getMax(), /does not support/);
  const empty = runtime.formContext.getAttribute('x_empty');
  assert.equal(empty.getAttributeType(), 'optionset');
  assert.deepEqual(empty.getOptions(), []);
  for (const method of ['getMin', 'getMax', 'getPrecision']) assert.throws(() => empty[method](), /does not support/);
});
