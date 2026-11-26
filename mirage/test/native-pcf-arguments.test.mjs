// @test-kind unproven: local model of native PCF arguments (Two Options labels, state scope); platform values await live capture (CPCF-101)
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSyntheticCreateForm } from './support/native-pcf-form.mjs';

async function capture(definitions) {
  const fields = definitions.map((field) => ({
    ...field,
    controlStyle: 756150001,
    codeComponent: {
      name: 'synthetic.Column',
      boundAttributes: [field.name],
      parameters: { value: { kind: 'binding', column: field.name, type: field.pcfType } },
    },
  }));
  const captures = [];
  await renderSyntheticCreateForm(definitions, fields, async (spec) => {
    captures.push(spec);
    return '<div data-test-component></div>';
  });
  return captures;
}

test('native Two Options PCF fields carry the option labels the native control renders', async () => {
  const [flag, labelled] = await capture([
    { name: 'flag', label: 'Flag', dataverseType: 'bit', type: 'boolean', pcfType: 'TwoOptions' },
    {
      name: 'labelled',
      label: 'Labelled',
      dataverseType: 'bit',
      type: 'boolean',
      options: [
        { value: 0, label: 'Off' },
        { value: 1, label: 'On' },
      ],
      pcfType: 'TwoOptions',
    },
  ]);
  assert.deepEqual(flag.nativeBinding.attributes.Options, [
    { Label: 'No', Value: 0 },
    { Label: 'Yes', Value: 1 },
  ]);
  assert.deepEqual(labelled.nativeBinding.attributes.Options, [
    { Label: 'Off', Value: 0 },
    { Label: 'On', Value: 1 },
  ]);
});

// @test-kind observation: the Power Pages host refuses a Lookup column before loading the component (paqvilo-developer pcf-parity capture r2 edit-full pqpcf_contact)
test('a lookup column is refused before the component is requested', async () => {
  const captures = await capture([
    {
      name: 'owner',
      label: 'Owner',
      dataverseType: 'lookup',
      type: 'lookup',
      targets: ['account'],
      pcfType: 'Lookup.Simple',
    },
  ]);
  assert.deepEqual(captures, []);
});

test('native PCF fields scope their saved control state to the form', async () => {
  const [field] = await capture([
    { name: 'title', label: 'Title', dataverseType: 'nvarchar', type: 'text', pcfType: 'SingleLine.Text' },
  ]);
  assert.deepEqual(field.stateScope, { form: 'create', step: null });
});

test('a column-secured field reports IsSecured and a security that follows its read-only state', async () => {
  const [open, locked] = await capture([
    {
      name: 'open',
      label: 'Open',
      dataverseType: 'nvarchar',
      type: 'text',
      isSecured: true,
      pcfType: 'SingleLine.Text',
    },
    {
      name: 'locked',
      label: 'Locked',
      dataverseType: 'nvarchar',
      type: 'text',
      isSecured: true,
      readOnly: true,
      pcfType: 'SingleLine.Text',
    },
  ]);
  assert.equal(open.nativeBinding.attributes.IsSecured, true);
  assert.deepEqual(open.nativeBinding.security, { secured: true, readable: true, editable: true });
  assert.deepEqual(locked.nativeBinding.security, { secured: true, readable: true, editable: false });
});
