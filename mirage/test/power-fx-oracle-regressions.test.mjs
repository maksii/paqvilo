import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorKind, FxError, FxFloat, evaluateFx, powerFxEngine } from '../lib/power-fx.mjs';

// PAC 2.13.1, pure-expression evidence: .paqvilo/power-fx-oracle/iferror{,2}.txt.
test('IfError coerces the selected replacement to its failing value type', () => {
  const run = (formula) => powerFxEngine.evaluateSync(formula).value;
  const invalid = evaluateFx('IfError(1/0, "x")').value;
  assert.ok(invalid instanceof FxError);
  assert.equal(invalid.errors[0].Kind, ErrorKind.InvalidArgument);
  assert.match(invalid.errors[0].Message, /cannot be converted to a number/);
  assert.equal(run('IfError(1/0, "2")'), 2);
  const float = evaluateFx('IfError(Float("bad"), "0.1")').value;
  assert.ok(float instanceof FxFloat);
  assert.equal(float.value, 0.1);
  assert.equal(run('Text(IfError(1/0, "1234567890123456789012345678"))'), '1234567890123456789012345678');
  assert.equal(run('IfError(Text(1/0), "x")'), 'x');
  assert.equal(run('IfError(Text(1/0), 42)'), '42');
  assert.equal(run('IfError(Value("bad"), true)'), 1);
  assert.equal(run('IfError(Boolean("bad"), "true")'), true);
  assert.equal(run('IfError(DateValue("bad"), "2026-01-02")'), '2026-01-02');
  assert.equal(run('IfError(1/0, Blank())'), null);
  assert.equal(run('IfError(1, "bad", "2")'), '2');
  assert.equal(run('IfError(1, "z", Text(1/0), 42)'), '42');
  assert.equal(run('IfError("s", "z", 1/0, "3")'), 3);
});

test('IfError keeps branches lazy and reports unknown replacement type', () => {
  const calls = [];
  const host = {
    functions: {
      Touch: () => {
        calls.push('touch');
        return 1;
      },
    },
  };
  const result = powerFxEngine.evaluateSync('IfError(1/0, "2", Touch(), 3)', { host });
  assert.equal(result.value, 2);
  assert.deepEqual(calls, []);
  const unknown = powerFxEngine.evaluateSync('IfError(Error("bad"), "fallback")');
  assert.equal(unknown.value, 'fallback');
  assert.ok(unknown.diagnostics.some((entry) => entry.code === 'POWER_FX_IFERROR_TYPE_UNKNOWN'));
});

test('Text applies the specified language to numeric separators', () => {
  const run = (formula) => powerFxEngine.evaluateSync(formula).value;
  assert.equal(run('Text(1234.5,"#,##0.00","de-DE")'), '1.234,50');
  assert.equal(run('Text(1234.5,"#,##0.00","fr-FR")'), '1\u202f234,50');
  const invalid = evaluateFx('Text(1234.5,"#,##0.00","x-invalid-@")').value;
  assert.ok(invalid instanceof FxError);
  assert.equal(invalid.errors[0].Kind, ErrorKind.BadLanguageCode);
});
