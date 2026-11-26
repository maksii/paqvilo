// @test-kind contract: the JSON form transport's number conversion is Paqvilo's own designed runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DataStore } from '../lib/data.mjs';
import { submitPortalForm } from '../lib/form-service.mjs';
import { renderComponent } from '../lib/platform.mjs';

// numberControlValue lives inside the browser runtime; extract it the same way the browser evaluates it.
const source = fs.readFileSync(new URL('../lib/webforms-compat.js', import.meta.url), 'utf8');
const numberControlValue = new Function(
  source.slice(source.indexOf('  function numberControlValue'), source.indexOf('  function richTextControlValue')) +
    '\nreturn numberControlValue;',
)();

// A stand-in for the double text box; platform.mjs sets data-numberdecimalseparator="," for comma-decimal languages.
function numberBox(value, decimalSeparator, defaultValue) {
  return {
    value,
    defaultValue,
    dataset: decimalSeparator ? { numberdecimalseparator: decimalSeparator } : {},
  };
}

test('the JSON transport preserves the invariant value emitted by a comma-decimal control', () => {
  assert.equal(numberControlValue(numberBox('1.50', ',', '1.50')), 1.5);
  assert.equal(numberControlValue(numberBox('1.234', ',', '1.234')), 1.234);
  assert.equal(numberControlValue(numberBox('1.234', ',', '')), 1234);
  assert.equal(numberControlValue(numberBox('1.234,56', ',', '1.50')), 1234.56);
  assert.equal(numberControlValue(numberBox('1.50', '.', '1.50')), 1.5);
});

test('number controls read a comma decimal separator as the decimal point, not as a thousands separator', () => {
  assert.equal(numberControlValue(numberBox('1,5', ',')), 1.5);
  assert.equal(numberControlValue(numberBox('1.234,56', ',')), 1234.56);
  assert.equal(numberControlValue(numberBox('1 234,5', ',')), 1234.5);
  assert.equal(numberControlValue(numberBox('1 234,5', ',')), 1234.5);
});

test('number controls keep a period decimal separator and strip the comma group separator', () => {
  assert.equal(numberControlValue(numberBox('1,234.5', '.')), 1234.5);
  assert.equal(numberControlValue(numberBox('1,234.5')), 1234.5);
  assert.equal(numberControlValue(numberBox('-12.25', '.')), -12.25);
  assert.equal(numberControlValue(numberBox('+7')), 7);
});

test('number controls return other text as-is so the server validator rejects it', () => {
  for (const text of ['0x10', '1e3', 'abc', '1,2,3', '1,5e3', '  ']) {
    assert.equal(numberControlValue(numberBox(text, ',')), text, text);
  }
  assert.equal(numberControlValue(numberBox('0x10')), '0x10');
  assert.equal(numberControlValue(numberBox('1e3', '.')), '1e3');
});

test('number controls read a group separator only between two digits, otherwise the text is not a number', () => {
  assert.equal(numberControlValue(numberBox('.5', ',')), '.5');
  assert.equal(numberControlValue(numberBox('5.', ',')), '5.');
  assert.equal(numberControlValue(numberBox('1..2,5', ',')), '1..2,5');
  assert.equal(numberControlValue(numberBox(',5', '.')), ',5');
  assert.equal(numberControlValue(numberBox('5,', '.')), '5,');
  assert.equal(numberControlValue(numberBox('1,,2', '.')), '1,,2');
  assert.equal(numberControlValue(numberBox('1.234,5', ',')), 1234.5);
  assert.equal(numberControlValue(numberBox('1 234,5', ',')), 1234.5);
  assert.equal(numberControlValue(numberBox('1 234,5', ',')), 1234.5);
  assert.equal(numberControlValue(numberBox('1,234.5', '.')), 1234.5);
});

test('number controls accept a decimal point with no digit on one side, as .NET does', () => {
  assert.equal(numberControlValue(numberBox('.5', '.')), 0.5);
  assert.equal(numberControlValue(numberBox('5.', '.')), 5);
  assert.equal(numberControlValue(numberBox('-.25')), -0.25);
  assert.equal(numberControlValue(numberBox(',5', ',')), 0.5);
  assert.equal(numberControlValue(numberBox('5,', ',')), 5);
  assert.equal(numberControlValue(numberBox('.', '.')), '.');
  assert.equal(numberControlValue(numberBox('-.', '.')), '-.');
});

test('number controls keep an empty box as null', () => {
  assert.equal(numberControlValue(numberBox('', ',')), null);
  assert.equal(numberControlValue(null), null);
});

test('edited German Decimal and Money controls send numeric JSON and use the server range checks', async () => {
  const fields = [
    { name: 'total', label: 'Total', dataverseType: 'decimal', minValue: 1, maxValue: 3 },
    { name: 'charge', label: 'Charge', dataverseType: 'money', minValue: 1, maxValue: 3 },
  ];
  const portal = { forms: [{ id: 'form', name: 'Sample', mode: 100000000 }], pages: [] };
  const schemas = {
    form: { entity: 'sample', fields, layout: [{ columns: [{ sections: [{ rows: [[...fields]] }] }] }] },
  };
  const store = await new DataStore({
    state: {
      mappings: { sample: { entitySet: 'samples', idColumn: 'sampleid' } },
      tables: { sample: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const render = async (lcid, nativeFormTransport) => {
    const context = { user: { id: 'visitor' }, request: { params: {} }, __language: { lcid } };
    const html = await renderComponent('entityform', 'form', context, {
      portal,
      schemas,
      store,
      observed: { nativeFormTransport },
    });
    return JSON.parse(html.match(/data-paqvilo-mirage-form-config>([^<]+)/)[1]);
  };
  const config = await render(1031, 'json');
  const collect = (values, manifest = config) => {
    const document = { getElementById: (id) => ({ value: values[id], defaultValue: '', dataset: {} }) };
    return new Function(
      'document',
      source.slice(source.indexOf('  function controlDisabled'), source.indexOf('  function richTextControlValue')) +
        source.slice(
          source.indexOf('function appendSubmittedField'),
          source.indexOf('  function handleNativeResponse'),
        ) +
        '\nreturn submittedFormValues;',
    )(document)(manifest);
  };
  const options = { portal, schemas, store, identity: { id: 'visitor' } };
  const submit = (values) => {
    const body = JSON.parse(JSON.stringify({ values: collect(values) }));
    return submitPortalForm('entityform', 'form', body, options);
  };

  const edited = { total: '1,25', charge: '2,75' };
  assert.deepEqual(collect(edited), { total: 1.25, charge: 2.75 });
  const outcome = await submit(edited);
  assert.equal(outcome.record.total, 1.25);
  assert.equal(outcome.record.charge, 2.75);
  assert.deepEqual(collect({ total: '1.25', charge: '2.75' }), { total: 1.25, charge: 2.75 });
  assert.deepEqual(collect({ total: '1.234,50', charge: '4,75' }), { total: 1234.5, charge: 4.75 });
  await assert.rejects(submit({ total: '1.234,50', charge: '4,75' }), (error) => {
    assert.deepEqual(
      error.details.validationErrors.map(({ field, code }) => [field, code]),
      [
        ['total', 'FormFieldOutOfRange'],
        ['charge', 'FormFieldOutOfRange'],
      ],
    );
    return true;
  });
  assert.equal((await store.query('sample')).value.length, 1);

  const enUs = await render(1033, 'json');
  assert.deepEqual(collect({ total: '1,234.50', charge: '2.75' }, enUs), { total: 1234.5, charge: 2.75 });
  const postback = await render(1031, 'postback');
  assert.equal(postback.transport, 'postback');
  assert.ok(postback.fields.every((field) => !Object.hasOwn(field, 'decimalSeparator')));
});
