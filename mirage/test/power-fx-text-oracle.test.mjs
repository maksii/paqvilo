import test from 'node:test';
import assert from 'node:assert/strict';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';

// Observed with PAC 2.13.1, isolated profile, en-US explicit formatting.
test('Text formats exact Decimal and Float values like the PAC numeric probes', () => {
  const fx = createPowerFxEvaluator();
  for (const [expression, expected] of [
    ['Text(1234567890123456789012345678,"0","en-US")', '1234567890123456789012345678'],
    ['Text(1234567890123456789012345678,"#,##0.00","en-US")', '1,234,567,890,123,456,789,012,345,678.00'],
    ['Text(99999999999999999999,"0.00","en-US")', '99999999999999999999.00'],
    ['Text(1.235,"0.00","en-US")', '1.24'],
    ['Text(-1.235,"0.00","en-US")', '-1.24'],
    ['Text(0.12345,"0.00%","en-US")', '12.35%'],
    ['Text(12.3,"$0.00","en-US")', '$12.30'],
    ['Text(Float(0.1)+Float(0.2),"0.00000000000000000","en-US")', '0.30000000000000000'],
    ['Text(Float(1.2345678901234567),"0.00000000000000000","en-US")', '1.23456789012346000'],
    ['Text(IfError(Float("bad"),"0.1") + Float(0.2),"0.00000000000000000","en-US")', '0.30000000000000000'],
  ])
    assert.equal(fx.evaluateSync(expression).value, expected, expression);
});

test('Text preserves literal positions and numeric placeholder scaling from PAC probes', () => {
  const fx = createPowerFxEvaluator();
  const cases = [
    [12.3, '0.00"%"', '12.30%'],
    [12.3, '0.00\\%', '12.30%'],
    [0.123, '0.00%', '12.30%'],
    [123456, '000-000', '123-456'],
    ['1234567890123456789012345678', '000-000', '1234567890123456789012345-678'],
    [12.3, '0"x".00', '12x.30'],
    [12.3, '0.0"x"0', '12.3x0'],
    [0, '#.##', ''],
    [12.3, '0.#0#', '12.30'],
    [12.3, '.00', '12.30'],
    [12, '0.', '12.'],
    [0, '.##', ''],
    [12, '0#0', '012'],
    [-12, '$0.00', '-$12.00'],
    [12345678, '#,##0,," M"', '12 M'],
    [1234, '0,', '1'],
    [1234, '0,,', '0'],
    [0.123, '0%%', '1230%%'],
    [0, '0#0', '000'],
    [12, '00#', '012'],
    [0, '.00', '.00'],
  ];
  for (const [value, pattern, expected] of cases) {
    const formula = `Text(${value},"${pattern.replaceAll('"', '""')}","en-US")`;
    assert.equal(fx.evaluateSync(formula).value, expected, formula);
  }
});
