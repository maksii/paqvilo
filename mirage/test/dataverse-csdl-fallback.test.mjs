// @test-kind contract: The internal CSDL normalizer preserves unknown fragments and registration errors without changing recognized declarations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformOperationCsdl } from '../lib/dataverse-operation-contracts.mjs';

test('CSDL normalizer preserves unparsed names and registration errors', () => {
  const fragments = [
    '<Action />',
    '<Action></Action>',
    "<Action Name='Example' />",
    '<Action Name = "Example" />',
    '<Function />',
    '<Function></Function>',
    "<Function Name='Example'></Function>",
    '<Function Name = "Example"></Function>',
  ];
  for (const input of fragments) {
    assert.equal(platformOperationCsdl(input), input);
    assert.equal(platformOperationCsdl(input, null), input);
    assert.equal(platformOperationCsdl(input, undefined), input);
  }

  for (const input of ['<Action Name="Custom" />', '<Function Name="Custom"></Function>']) {
    assert.equal(platformOperationCsdl(input, { name: 'Other', kind: 'action' }), input);
  }

  for (const kind of ['action', 'function']) {
    for (const input of ['<Action />', '<Action></Action>', '<Function />', '<Function></Function>']) {
      assert.equal(platformOperationCsdl(input, { name: undefined, kind }), input);
    }
  }

  const failure = new Error('registration kind getter failed');
  const registration = { name: 'Example' };
  Object.defineProperty(registration, 'kind', {
    get() {
      throw failure;
    },
  });
  assert.throws(
    () => platformOperationCsdl('<Action Name="Example" />', registration),
    (error) => error === failure,
  );
});
