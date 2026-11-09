// @test-kind observation: recorded native draft choice-control cases pending reviewed public evidence capsule.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decode } from '../test-support/model-driven-native-decode.mjs';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

function fixture(type, options = ['A', 'B', 'C'].map((label, i) => ({ label, value: 101 + i }))) {
  const field = { name: 'x_choice', type, options, required: false },
    values = new Map();
  const controls = ['first', 'second'];
  const runtime = createFormClientRuntime({
    table: { fields: { x_choice: field } },
    record: {},
    form: { attributes: ['x_choice'] },
    controlNames: () => controls,
    controlField: () => 'x_choice',
    controlState: (name, key, value) => (value === undefined ? values.get(name + key) : values.set(name + key, value)),
  });
  return { runtime, form: runtime.formContext };
}

const bytes = readFileSync(new URL('./fixtures/model-driven-choice-native-facts.json', import.meta.url));

const evidence = JSON.parse(bytes);

// @parity-evidence: existing native fixture and probe SHA-256 pins are checked before any recorded case executes.
before(() => {
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '4cdfe3a46a4391a0600df6f4eb849cbafcaae09e43a490d6af9763221cd8ddcd',
  );
});

// @test-kind parity: independently repeated native draft source-bound choice and multiselect sibling mutations.
// @parity-evidence: mirage/test/fixtures/model-driven-choice-native-facts.json binds source, probe and both typed native captures, including the NaN blank option.
test('recorded source-bound sibling options follow the same caller mutation', () => {
  for (const capture of evidence.captures)
    for (const [role, type] of [
      ['choice', 'number'],
      ['multi', 'multiselect'],
    ]) {
      const baseline = capture.cases.find((entry) => entry.id === `${role}-baseline`).facts;
      const edited = capture.cases.find((entry) => entry.id === `${role}-add-caller`).facts;
      const before = decode(baseline.state),
        after = decode(edited.state);
      const { runtime, form } = fixture(
        type,
        before.source.map(({ text, value }) => ({ label: text, value })),
      );
      const attr = form.getAttribute('x_choice'),
        first = form.getControl('first'),
        sibling = form.getControl('second');
      assert.notEqual(first, sibling);
      assert.equal(decode(baseline.firstAndSiblingSameObject), false);
      assert.deepEqual(attr.getOptions(), before.source);
      assert.deepEqual(first.getOptions(), before.first);
      assert.deepEqual(sibling.getOptions(), before.sibling);
      const option = { text: 'Zero', value: 0 };
      first.addOption(option, 0);
      option.text = 'Caller mutation';
      assert.deepEqual(attr.getOptions(), after.source);
      assert.deepEqual(first.getOptions(), after.first);
      assert.deepEqual(sibling.getOptions(), after.sibling);
      runtime.destroy();
    }
});

for (const type of ['number', 'multiselect']) {
  test(`${type} sibling controls share edits while attribute options stay intact`, () => {
    const { runtime, form } = fixture(type);
    const attr = form.getAttribute('x_choice'),
      first = form.getControl('first'),
      sibling = form.getControl('second');
    const source = [
      { text: 'A', value: 101 },
      { text: 'B', value: 102 },
      { text: 'C', value: 103 },
    ];
    const original = { text: 'Zero', value: 0 };
    first.addOption(original, 0);
    original.text = 'Changed';
    assert.deepEqual(first.getOptions().slice(1), [{ text: 'Zero', value: 0 }, ...source]);
    assert.deepEqual(sibling.getOptions(), first.getOptions());
    first.removeOption(101);
    assert.deepEqual(sibling.getOptions().slice(1), [{ text: 'Zero', value: 0 }, ...source.slice(1)]);
    first.clearOptions();
    first.addOption({ text: 'Replacement', value: 2 });
    assert.deepEqual(sibling.getOptions().slice(1), [{ text: 'Replacement', value: 2 }]);
    assert.deepEqual(attr.getOptions(), source);
    runtime.destroy();
  });

  test(`${type} accepts recorded numeric additions and duplicate values`, () => {
    const { runtime, form } = fixture(type),
      control = form.getControl('first');
    for (const value of ['3', NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.doesNotThrow(() => control.removeOption(value));
    for (const value of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, 101]) {
      const before = control.getOptions().length;
      assert.equal(control.addOption({ text: 'Added', value }), undefined);
      assert.equal(control.getOptions().length, before + 1);
    }
    assert.throws(() => control.addOption({ text: 'Added', value: '3' }), { name: 'UciError' });
    runtime.destroy();
  });
}

// @test-kind parity: two repeated source-bound native form selector recordings.
// @parity-evidence: mirage/test/fixtures/model-driven-selector-native-facts.json projects native identity and null results without exposing the source form ID.
test('form selector resolves the recorded ID spelling and rejects other spellings', () => {
  const selectorBytes = readFileSync(new URL('./fixtures/model-driven-selector-native-facts.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(selectorBytes).digest('hex'),
    '46d85c4724912db9e27363c33e6103142b8e81cf9cf3c03d7e488eb257e99bca',
  );
  const captures = JSON.parse(selectorBytes).captures;
  const id = 'aabbccdd-1234-4abc-8def-123456abcdef';
  const runtime = createFormClientRuntime({
    table: { fields: {} },
    form: { id, attributes: [] },
    record: {},
    controlNames: () => [],
  });
  const selector = runtime.formContext.ui.formSelector,
    current = selector.getCurrentItem();
  assert.equal(current.getId(), id);
  assert.equal(selector.items.get(id), current);
  assert.equal(selector.items.get(id.toUpperCase()), null);
  assert.equal(selector.items.get(`{${id}}`), null);
  assert.equal(selector.items.get(`{${id.toUpperCase()}}`), null);
  for (const capture of captures)
    for (const row of capture.cases) {
      const key = {
        lowerBare: id,
        upperBare: id.toUpperCase(),
        lowerBraced: `{${id}}`,
        upperBraced: `{${id.toUpperCase()}}`,
      }[row.facts.argumentShape];
      if (key === undefined) continue;
      const actual = selector.items.get(key);
      if (row.facts.returned === 'null') assert.equal(actual, null);
      else {
        assert.equal(actual, current);
        assert.equal(actual.getId(), id);
        assert.equal(row.facts.returned.sameCurrent, true);
        assert.equal(row.facts.returned.returnedIdEqualsSource, true);
      }
    }
  runtime.destroy();
});

// @test-kind parity: repeated native mutations on a reset two-option choice and multiselect control.
// @parity-evidence: mirage/test/fixtures/model-driven-choice-mutation-native-facts.json retains both typed native executions and the exact reset and operation sequence.
test('recorded choice mutation arguments and option ordering', () => {
  const mutationBytes = readFileSync(
    new URL('./fixtures/model-driven-choice-mutation-native-facts.json', import.meta.url),
  );
  assert.equal(
    createHash('sha256').update(mutationBytes).digest('hex'),
    '725698c71bed6aa08714b0f56703faae15d57eafd6c6830eb415fcfe90a6844e',
  );
  for (const capture of JSON.parse(mutationBytes).captures)
    for (const row of capture.cases) {
      const recorded = decode(row.facts.output);
      const source = recorded.reset.state.source;
      const { runtime, form } = fixture(
        row.facts.role === 'choice' ? 'number' : 'multiselect',
        source.map(({ text, value }) => ({ label: text, value })),
      );
      const first = form.getControl('first'),
        sibling = form.getControl('second'),
        attr = form.getAttribute('x_choice');
      first.clearOptions();
      first.addOption(recorded.reset.state.first[1]);
      const check = (state) => {
        assert.deepEqual(attr.getOptions(), state.source);
        assert.deepEqual(first.getOptions(), state.first);
        assert.deepEqual(sibling.getOptions(), state.sibling);
      };
      check(recorded.reset.state);
      if (row.id.includes('duplicate-remove')) {
        assert.equal(first.addOption(recorded.argument), undefined);
        check(recorded.afterAdd);
        assert.equal(first.removeOption(recorded.argument.value), undefined);
        check(recorded.afterRemove);
      } else if (row.id.includes('invalid-remove-added')) {
        if (recorded.gap) {
          assert.throws(() => first.addOption({ text: 'Invalid', value: recorded.argument }), {
            name: recorded.add.error.name,
            message: recorded.add.error.message,
          });
        } else {
          assert.equal(first.addOption({ text: 'Invalid', value: recorded.argument }), undefined);
          check(recorded.afterAdd);
          assert.equal(first.removeOption(recorded.argument), undefined);
          check(recorded.afterRemove);
        }
      } else {
        assert.equal(first.addOption({ text: 'Three', value: 3 }, recorded.argument), undefined);
        check(recorded.after);
      }
      runtime.destroy();
    }
});
