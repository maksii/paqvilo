// @test-kind contract: rendered host snapshots retain each control's options and non-GUID source form identity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

test('host-owned sibling option snapshots override the shared fallback without changing source metadata', () => {
  const source = [
      { text: 'One', value: 1 },
      { text: 'Two', value: 2 },
    ],
    state = new Map();
  const runtime = createFormClientRuntime({
    table: {
      fields: {
        x_choice: {
          name: 'x_choice',
          type: 'number',
          options: source.map(({ text, value }) => ({ label: text, value })),
        },
      },
    },
    form: { attributes: ['x_choice'] },
    record: {},
    controlNames: () => ['first', 'second'],
    controlField: () => 'x_choice',
    controlState: (name, key, value) => {
      if (value !== undefined) state.set(`${name}:${key}`, value);
      return state.get(`${name}:${key}`) ?? (key === 'options' ? source : undefined);
    },
  });
  try {
    const first = runtime.formContext.getControl('first'),
      second = runtime.formContext.getControl('second');
    first.clearOptions();
    first.addOption({ text: '<b>Zero</b>', value: 0 });
    assert.deepEqual(first.getOptions().slice(1), [{ text: '<b>Zero</b>', value: 0 }]);
    assert.deepEqual(second.getOptions().slice(1), source);
    second.getOptions()[1].text = 'Caller mutation';
    assert.deepEqual(second.getOptions().slice(1), source);
    assert.deepEqual(runtime.formContext.getAttribute('x_choice').getOptions(), source);
  } finally {
    runtime.destroy();
  }
});

test('form selector retains legacy braced non-GUID IDs and source letter case', () => {
  for (const id of ['{item-form}', '{ITEM-FORM}', 'InventedForm', '{not-a-guid}']) {
    const runtime = createFormClientRuntime({
      table: { fields: {} },
      form: { id, attributes: [] },
      record: {},
      controlNames: () => [],
    });
    try {
      assert.equal(runtime.formContext.ui.formSelector.getCurrentItem().getId(), `{${id.replace(/[{}]/g, '')}}`);
    } finally {
      runtime.destroy();
    }
  }
});

test('persisted polymorphic lookup dirty state compares target and ID rather than its display label', () => {
  const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    record = {
      x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      x_customer: id,
      'x_customer@Microsoft.Dynamics.CRM.lookuplogicalname': 'x_targetb',
    };
  let current = { id, entity: 'x_targetb', name: 'Second target' };
  const runtime = createFormClientRuntime({
    table: {
      idColumn: 'x_itemid',
      fields: { x_customer: { name: 'x_customer', type: 'lookup', targets: ['x_targeta', 'x_targetb'] } },
    },
    record,
    form: { attributes: ['x_customer'] },
    controlNames: () => ['x_customer'],
    controlField: () => 'x_customer',
    read: () => current,
  });
  try {
    const attribute = runtime.formContext.getAttribute('x_customer');
    assert.equal(attribute.getIsDirty(), false);
    current = { id, entity: 'x_targeta', name: 'First target' };
    assert.equal(attribute.getIsDirty(), true);
    current = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', entity: 'x_targetb', name: 'Other record' };
    assert.equal(attribute.getIsDirty(), true);
    current = { id: id.toUpperCase(), entity: 'x_targetb', name: 'Changed label' };
    assert.equal(attribute.getIsDirty(), false);
    current = null;
    assert.equal(attribute.getIsDirty(), true);
  } finally {
    runtime.destroy();
  }
});
