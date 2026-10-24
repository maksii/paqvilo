import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDataverseDecimalString } from '../lib/dataverse-decimal-input.mjs';
test('invariant decimal reader retains 96-bit bounds, scale28 ties-to-even, and exact digits', () => {
  const cases = [
    ['.5', '0.5'],
    ['1.', '1'],
    [' \t+001.250\r\n', '1.25'],
    ['1,2,3.5-', '-123.5'],
    ['1.25 -', '-1.25'],
    ['1.25\u0000', '1.25'],
    ['1,,.25', '1.25'],
    ['0.12345678901234567890123456785', '0.1234567890123456789012345678'],
    ['0.12345678901234567890123456795', '0.123456789012345678901234568'],
    ['0.99999999999999999999999999999', '1'],
    ['79228162514264337593543950335', '79228162514264337593543950335'],
    ['-79228162514264337593543950335', '-79228162514264337593543950335'],
    ['7922816251426433759354395033.55', '7922816251426433759354395034'],
    ['123456789012345.1234567890', '123456789012345.123456789'],
    ['0.' + '0'.repeat(10000) + '5', '0'],
  ];
  for (const [input, expected] of cases)
    assert.equal(parseDataverseDecimalString(input)?.value, expected, input.slice(0, 80));
  for (const value of [
    '',
    ',1',
    '.',
    '1e2',
    'NaN',
    'Infinity',
    '1 25',
    '- 1.25',
    '\u00a01.25\u00a0',
    '+-1',
    '1-+',
    '1.2,3',
    '79228162514264337593543950336',
    '-79228162514264337593543950336',
  ])
    assert.equal(parseDataverseDecimalString(value), null, value);
  assert.equal(
    parseDataverseDecimalString('1' + ' '.repeat(100000) + 'x'),
    null,
    'long invalid trailing whitespace is processed without overlapping whitespace patterns',
  );
});
