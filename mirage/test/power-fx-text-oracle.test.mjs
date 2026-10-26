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
