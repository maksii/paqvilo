import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

function fixture() {
  const original = Object.freeze([
    Object.freeze({ label: 'One', value: 1 }),
    Object.freeze({ label: 'Two', value: 2 }),
  ]);
  const fields = {
    x_choice: { name: 'x_choice', type: 'number', options: original },
    x_tags: { name: 'x_tags', type: 'multiselect', options: original },
    x_count: { name: 'x_count', type: 'number' },
  };
  const bindings = { first: 'x_choice', second: 'x_choice', tags: 'x_tags', count: 'x_count' },
    state = new Map();
  const runtime = createFormClientRuntime({
    table: { entity: 'x_item', fields },
    record: {},
    form: { attributes: Object.keys(fields) },
    controlNames: (name) => Object.keys(bindings).filter((key) => !name || bindings[key] === name),
    controlField: (name) => bindings[name],
    controlState: (name, key, value) =>
      value === undefined ? state.get(name + ':' + key) : state.set(name + ':' + key, value),
  });
  return { runtime, state, original };
}

test('choice mutations use isolated control state while source options and sibling controls remain unchanged', () => {
  const { runtime, state, original } = fixture(),
    form = runtime.formContext,
    first = form.getControl('first'),
    option = { text: 'Zero', value: 0 };
  first.addOption(option, 0);
  option.text = 'Caller mutation';
  assert.deepEqual(state.get('first:options'), [
    { text: 'Zero', value: 0 },
    { text: 'One', value: 1 },
    { text: 'Two', value: 2 },
  ]);
  form.getAttribute('x_choice').controls.get('first').removeOption(1);
  assert.deepEqual(state.get('first:options'), [
    { text: 'Zero', value: 0 },
    { text: 'Two', value: 2 },
  ]);
  assert.equal(state.has('second:options'), false);
  assert.deepEqual(
    form.getAttribute('x_choice').getOptions(),
    original.map((option) => ({ text: option.label, value: option.value })),
  );
  first.clearOptions();
  first.addOption({ text: 'Restored', value: 2 });
  assert.deepEqual(state.get('first:options'), [{ text: 'Restored', value: 2 }]);
  form.getControl('tags').clearOptions();
  form.getControl('tags').addOption({ text: 'Tag zero', value: 0 });
  assert.deepEqual(state.get('tags:options'), [{ text: 'Tag zero', value: 0 }]);
  assert.throws(() => form.getControl('count').clearOptions(), /does not support/);
  runtime.destroy();
  assert.throws(() => first.clearOptions(), /disposed/);
});

test('choice mutations validate enum identities and indices before changing any control state', () => {
  const { runtime, state } = fixture(),
    control = runtime.formContext.getControl('first');
  for (const value of ['3', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => control.addOption({ text: 'Invalid', value }), /safe integer/);
    assert.throws(() => control.removeOption(value), /safe integer/);
  }
  for (const index of [-1, 0.5, '0', 3])
    assert.throws(() => control.addOption({ text: 'Three', value: 3 }, index), /index/);
  assert.throws(() => control.addOption({ text: 'Duplicate', value: 1 }), /already present/);
  assert.equal(state.size, 0);
});
