// @test-kind contract: the JSON form transport's number conversion is Paqvilo's own designed runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// numberControlValue lives inside the browser runtime; extract it the same way the browser evaluates it.
const source = fs.readFileSync(new URL('../lib/webforms-compat.js', import.meta.url), 'utf8');
const numberControlValue = new Function(
  source.slice(source.indexOf('  function numberControlValue'), source.indexOf('  function richTextControlValue')) +
    '\nreturn numberControlValue;',
)();

// A stand-in for the double text box; platform.mjs sets data-numberdecimalseparator="," for comma-decimal languages.
function numberBox(value, decimalSeparator) {
  return {
    value,
    getAttribute: (name) => (name === 'data-numberdecimalseparator' ? (decimalSeparator ?? null) : null),
  };
}

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
