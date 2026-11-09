// @test-kind parity: two native source-bound draft recordings of membership and type-specific accessor presence.
// @parity-evidence: mirage/test/fixtures/model-driven-form-membership-native-facts.json retains both typed runs and the source-form omission checks; it does not establish primary-key status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

const bytes = readFileSync(new URL('./fixtures/model-driven-form-membership-native-facts.json', import.meta.url));
assert.equal(
  createHash('sha256').update(bytes).digest('hex'),
  '0cbae975bfa35da7d5266c3be4a2110b5dc00ce6af2ca480e1ddc45a1b8fd3a1',
);
const evidence = JSON.parse(bytes);
const fields = {
  text: { name: 'text', type: 'text', maxLength: 200 },
  memo: { name: 'memo', type: 'textarea', maxLength: 5000 },
  decimal: { name: 'decimal', type: 'number', dataverseType: 'decimal', minValue: 0, maxValue: 100, precision: 2 },
  integer: { name: 'integer', type: 'number', dataverseType: 'int', minValue: 0, maxValue: 10000 },
  existing_id: { name: 'existing_id', type: 'text' },
  existing_date: { name: 'existing_date', type: 'date' },
};
const present = ['text', 'memo', 'decimal', 'integer'];

test('recorded omitted form members and typed accessor shapes', () => {
  for (const capture of evidence.captures) {
    const runtime = createFormClientRuntime({
      table: { fields },
      form: { attributes: present },
      record: {},
      controlNames: (name) => present.filter((item) => !name || item === name),
      controlField: (name) => name,
    });
    const form = runtime.formContext;
    for (const row of capture.cases) {
      if (row.id.startsWith('accessor-shape-')) {
        const attr = form.getAttribute(row.facts.role);
        const actual = Object.fromEntries(row.facts.rawTypedShape.entries.map(({ key }) => [key, typeof attr[key]]));
        const expected = Object.fromEntries(
          row.facts.rawTypedShape.entries.map(({ key, value }) => [key, value.value]),
        );
        assert.deepEqual(actual, expected);
      } else if (row.facts.member) {
        const name = {
          'existing-id-field': 'existing_id',
          'existing-createdon': 'existing_date',
          'nonexistent-name': 'missing',
        }[row.facts.role];
        assert.equal(row.facts.rawTypedResult.type, 'null');
        assert.equal(row.facts.member === 'attribute' ? form.getAttribute(name) : form.getControl(name), null);
      }
    }
    const textField = 'text',
      decimalField = 'decimal';
    for (const [id, call] of [
      ['unsupported.text.getMin', () => form.getAttribute(textField).getMin()],
      ['unsupported.decimal.getMaxLength', () => form.getAttribute(decimalField).getMaxLength()],
    ]) {
      const expected = capture.cases.find((row) => row.id === id).facts.nativeError;
      assert.throws(call, { name: expected.name, message: expected.message });
    }
    runtime.destroy();
  }
});

// @test-kind parity: two fresh source metadata and form recordings establish omission of the queried primary ID.
// @parity-evidence: mirage/test/fixtures/model-driven-field-source-native-facts.json binds the exact current PrimaryIdAttribute equality and same-form null readbacks.
test('the recorded omitted primary ID is not exposed as a form attribute or control', () => {
  const sourceBytes = readFileSync(new URL('./fixtures/model-driven-field-source-native-facts.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(sourceBytes).digest('hex'),
    '06a82d47665cbefa8f7705628052fa33f5add4750a7a2c0dbee305f057491def',
  );
  for (const capture of JSON.parse(sourceBytes).captures) {
    const binding = capture.cases.find((row) => row.id === 'source-primary-id-equality').facts;
    assert.equal(binding.status.value, 200);
    assert.equal(binding.sourcePrimaryIdEqualsQueriedColumn.value, true);
    assert.equal(binding.sourceFormOmitsQueriedColumn, true);
    const runtime = createFormClientRuntime({
      table: { fields, idColumn: 'existing_id' },
      form: { attributes: present },
      record: {},
      controlNames: (name) => present.filter((item) => !name || item === name),
      controlField: (name) => name,
    });
    for (const member of ['attribute', 'control']) {
      const row = capture.cases.find((item) => item.id === `existing-id-field-${member}`);
      assert.equal(row.facts.rawTypedResult.type, 'null');
      assert.equal(
        member === 'attribute'
          ? runtime.formContext.getAttribute('existing_id')
          : runtime.formContext.getControl('existing_id'),
        null,
      );
    }
    runtime.destroy();
  }
});
