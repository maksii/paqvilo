// @test-kind contract: Paqvilo keeps source options immutable and accounts for local control state and runtime disposal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';
import { decode } from '../test-support/model-driven-native-decode.mjs';

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

// @test-kind parity+contract: two native recordings prove the continuous choice API sequence; final internal Map accounting remains a Paqvilo contract.
// @parity-evidence: fresh raw captures f72a0a4afdc50005c4ec6d123f03accfc86cc71498287c11a3da951a53beb251 and ec48948ae127e69a9f75fd639b4d4ad7c82d96d01fe1eccf32b4e2208e31a3ca; scope audit 4994194d1c104d36ce1379626201b39380f940e81c938f9dd241e5c758acf7ce. Only control options were initialized to One/Two; underlying attribute metadata One/Two=false. The final Map assertion is excluded from native proof; zero whole-original credit.
test('choice mutations reproduce the native continuous argument sequence', () => {
  const bytes = readFileSync(new URL('./fixtures/model-driven-choice-continuous-native-facts.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'cc58bccd3ab433448c539408eee36adf117ab9c678b4f6840286678e463a5084',
  );
  const evidence = JSON.parse(bytes);
  assert.equal(evidence.captures.length, 2);
  assert.equal(evidence.scope.attributeMetadataOneTwo, false);
  assert.equal(evidence.scope.wholeOriginalCredit, 0);
  for (const capture of evidence.captures) {
    const { runtime, state } = fixture(),
      control = runtime.formContext.getControl('first');
    let caseIndex = 0;
    const compare = (id, args, call) => {
      const expected = capture.cases[caseIndex++];
      assert.equal(expected.id, id);
      assert.deepEqual(decode(expected.args), args);
      assert.deepEqual(control.getOptions(), decode(expected.before));
      let outcome;
      try {
        outcome = { returned: call() };
      } catch (error) {
        outcome = { error: { name: error.name, message: error.message } };
      }
      assert.deepEqual(
        outcome,
        expected.outcome.error ? expected.outcome : { returned: decode(expected.outcome.returned) },
      );
      assert.deepEqual(control.getOptions(), decode(expected.after));
    };
    assert.deepEqual(control.getOptions(), decode(capture.initialControl));
    let valueIndex = 0;
    for (const value of ['3', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      compare('value.' + valueIndex + '.add', [{ text: 'Invalid', value }], () =>
        control.addOption({ text: 'Invalid', value }),
      );
      compare('value.' + valueIndex + '.remove', [value], () => control.removeOption(value));
      valueIndex++;
    }
    let indexIndex = 0;
    for (const index of [-1, 0.5, '0', 3])
      compare('index.' + indexIndex++, [{ text: 'Three', value: 3 }, index], () =>
        control.addOption({ text: 'Three', value: 3 }, index),
      );
    compare('duplicate', [{ text: 'Duplicate', value: 1 }], () => control.addOption({ text: 'Duplicate', value: 1 }));
    assert.equal(caseIndex, 15);
    assert.equal(caseIndex, capture.cases.length);
    // Paqvilo contract only: accepted mutations now create one caller-owned state entry.
    assert.equal(state.size, 1);
    assert.deepEqual([...state.keys()], ['first:options']);
    runtime.destroy();
  }
});
