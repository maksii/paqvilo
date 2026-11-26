// @test-kind unproven: Mirage's form service validation of field code component hidden inputs (exact digits, refused value types, read-only, omitted hidden fields); the platform's answer to malformed or refused hidden values is not captured, the decoded saved values follow the captured read-back (paqvilo-developer pcf-parity capture r2 submit-save)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { renderComponent } from '../lib/platform.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { decimalParts, decimalText } from '../lib/exact-numeric.mjs';

const identity = { roles: ['Editor'] };
const BIG = '123456789012345.6789';
const component = (name, type) => ({
  name: 'tst_Synthetic.Probe',
  sourceFile: 'row-form.xml',
  boundAttributes: [name],
  parameters: { value: { kind: 'binding', column: name, type } },
});
const fields = [
  { name: 'title', label: 'Title', dataverseType: 'nvarchar', type: 'text', codeComponent: component('title') },
  {
    name: 'amount',
    label: 'Amount',
    dataverseType: 'decimal',
    type: 'number',
    minimum: 0,
    maximum: 100,
    codeComponent: component('amount', 'Decimal'),
  },
  { name: 'big', label: 'Big', dataverseType: 'decimal', type: 'number', codeComponent: component('big', 'Decimal') },
  { name: 'flag', label: 'Flag', dataverseType: 'bit', type: 'boolean', codeComponent: component('flag') },
  {
    name: 'colors',
    label: 'Colors',
    dataverseType: 'multiselectpicklist',
    options: [
      { value: 1, label: 'Red' },
      { value: 2, label: 'Green' },
    ],
    codeComponent: component('colors'),
  },
  {
    name: 'locked',
    label: 'Locked',
    dataverseType: 'nvarchar',
    type: 'text',
    readOnly: true,
    codeComponent: component('locked'),
  },
  {
    name: 'secret',
    label: 'Secret',
    dataverseType: 'nvarchar',
    type: 'text',
    hidden: true,
    codeComponent: component('secret'),
  },
  // A native field without code component metadata.
  { name: 'plain', label: 'Plain', dataverseType: 'nvarchar', type: 'text' },
];
const tab = (names) => ({ columns: [{ sections: [{ rows: names.map((name) => [{ name }]) }] }] });

async function fixture() {
  const store = await new DataStore({
    state: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
      tables: {
        sample: [
          {
            sampleid: 'owned',
            title: 'Before',
            amount: 5,
            big: { $type: 'DataverseNumeric', numericType: 'Decimal', value: BIG },
            flag: true,
            colors: '1',
            locked: 'Kept',
            secret: 'Hidden value',
            plain: 'Native',
          },
        ],
      },
      permissions: [{ entity: 'sample', scope: 'global', roles: identity.roles, operations: ['read', 'update'] }],
      settings: { permissionMode: 'enforce' },
    },
  }).init();
  return {
    store,
    portal: {
      forms: [{ id: 'entry', name: 'Entry', mode: 100000001, metadata: {} }],
      records: fields
        .filter((field) => field.codeComponent)
        .map((field) => ({
          kind: 'basicformmetadata',
          adx_entityform: 'entry',
          adx_attributelogicalname: field.name,
          adx_type: 100000000,
          adx_controlstyle: 756150001,
        })),
    },
    schemas: { entry: { entity: 'sample', fields, layout: [tab(fields.map((field) => field.name))] } },
    identity,
    requestUrl: 'http://localhost/?id=owned',
  };
}
const submit = (options, values) =>
  submitPortalForm(
    'entityform',
    'entry',
    {
      recordId: 'owned',
      values: Object.fromEntries(Object.entries(values).map(([name, text]) => [name, { pcfHiddenValue: text }])),
    },
    options,
  );
const row = (options) => options.store.state.tables.sample[0];
const digits = (value) => decimalText(decimalParts(value));

test('an untouched exact decimal keeps every digit through the hidden input and the save', async () => {
  const options = await fixture();
  const rendered = await renderComponent(
    'entityform',
    'Entry',
    { user: identity, request: { params: { id: 'owned' } } },
    {
      ...options,
      codeComponent: async (spec) => {
        spec.onNativeBinding?.({ properties: ['value'] }, {});
        return '<script src="/__sim-static/pcf-host.js"></script><div></div>';
      },
    },
  );
  const html = String(rendered?.html ?? rendered);
  const hidden = /<input type="hidden" name="[^"]*\$big" id="big" value="([^"]*)">/.exec(html)?.[1];
  assert.equal(hidden, `${BIG}000000`);
  await submit(options, { big: hidden, amount: '5', title: '"Before"' });
  assert.equal(digits(row(options).big), BIG);
  // A changed exact value saves its posted digits.
  await submit(options, { big: '987654321098765.4321' });
  assert.equal(digits(row(options).big), '987654321098765.4321');
});

test('a decoded value goes through the native range and read-only checks', async () => {
  const options = await fixture();
  const before = options.store.snapshot();
  await assert.rejects(submit(options, { amount: '150' }), (error) => {
    assert.ok(
      error.details?.validationErrors?.some((item) => item.field === 'amount' && item.code === 'FormFieldOutOfRange'),
      JSON.stringify(error.details ?? error.message),
    );
    return true;
  });
  await assert.rejects(submit(options, { locked: '"Changed"' }), { code: 'FormFieldReadOnly' });
  assert.deepEqual(options.store.snapshot(), before);
});

test('a hidden input value of the wrong type is a field error and a malformed one fails the save, saving nothing', async () => {
  const options = await fixture();
  const before = options.store.snapshot();
  // Malformed hidden input: the save fails with HTTP 500 (captured for "null" and text that is not JSON, capture g1).
  for (const [name, text] of [
    ['title', 'null'],
    ['title', 'not json'],
    ['colors', '[[1]]'],
  ])
    await assert.rejects(
      submit(options, { [name]: text }),
      (error) => error.status === 500 && error.code === 'FormFieldValueMalformed',
      `${name} ${text}`,
    );
  for (const [name, text] of [
    ['title', '42'],
    ['title', '["Before"]'],
    ['title', '{"Value":1}'],
    ['amount', '"5"'],
    ['amount', '"abc"'],
    ['flag', '"true"'],
  ])
    await assert.rejects(
      submit(options, { [name]: text }),
      (error) =>
        error.code === 'FormFieldInvalid' &&
        error.details?.validationErrors?.[0]?.field === name &&
        error.details.validationErrors[0].code === 'FormFieldInvalid',
      `${name} ${text}`,
    );
  assert.deepEqual(options.store.snapshot(), before);
});

test('an omitted hidden component field and a native field cannot take a hidden input value', async () => {
  const options = await fixture();
  const before = options.store.snapshot();
  await assert.rejects(submit(options, { secret: '"Changed"' }), { code: 'FormFieldNotBound' });
  await assert.rejects(
    submitPortalForm('entityform', 'entry', { recordId: 'owned', values: { secret: 'Changed' } }, options),
    { code: 'FormFieldNotBound' },
  );
  await assert.rejects(submit(options, { plain: '"Changed"' }), { code: 'FormFieldInvalid' });
  assert.deepEqual(options.store.snapshot(), before);
  // Valid hidden inputs save their decoded values.
  await submit(options, { title: '"After"', flag: 'false', colors: '[{"Value":2,"Label":{}}]', amount: '7.25' });
  assert.deepEqual(
    [row(options).title, row(options).flag, String(row(options).colors), Number(row(options).amount)],
    ['After', false, '2', 7.25],
  );
  // An empty hidden input clears the column (captured, capture g1).
  await submit(options, { title: '' });
  assert.equal(row(options).title ?? null, null);
});
