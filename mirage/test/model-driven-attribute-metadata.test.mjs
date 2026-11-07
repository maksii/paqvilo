import test from 'node:test';
import assert from 'node:assert/strict';
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
  assert.throws(() => runtime.formContext.getAttribute('x_title').getMin(), /does not support/);
  assert.throws(() => amount.getMaxLength(), /does not support/);
  runtime.destroy();
  assert.throws(() => amount.getMax(), /disposed/);
});

test('missing metadata and choice columns refuse numeric accessors instead of inventing limits', () => {
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
  assert.throws(() => number.getPrecision(), /without imported numeric precision metadata/);
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
