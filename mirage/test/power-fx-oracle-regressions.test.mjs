// @test-kind unproven: Mirage's own model of coercion, lazy-host and language cases; no native or official recording backs them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorKind, FxError, FxFloat, evaluateFx, powerFxEngine, toFx } from '../lib/power-fx.mjs';

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

test('a record field named __proto__ keeps its value', () => {
  const run = (formula) => powerFxEngine.evaluateSync(formula).value;
  assert.equal(run("{'__proto__': 1}.'__proto__'"), 1);
});

test('host data with a __proto__ key is an own field, not the record prototype', () => {
  const record = toFx(JSON.parse('{"__proto__":{"a":5}}'));
  assert.ok(Object.hasOwn(record, '__proto__'));
  assert.equal(Object.getPrototypeOf(record), Object.prototype);
});

test('AddColumns with a __proto__ column name adds an own column', () => {
  const run = (formula) => powerFxEngine.evaluateSync(formula).value;
  assert.equal(run("First(AddColumns([{a: 1}], '__proto__', 2)).'__proto__'"), 2);
});

test('Set on a record column named __proto__ writes an own field', () => {
  const rec = { a: 1 };
  const result = powerFxEngine.evaluateSync("Set(rec.'__proto__', 2)", { host: { variables: { rec } } });
  assert.equal(result.value, true);
  assert.equal(Object.getOwnPropertyDescriptor(rec, '__proto__')?.value, 2);
  assert.equal(Object.getPrototypeOf(rec), Object.prototype);
});

test('UpdateContext with a __proto__ field writes an own context field, not the context prototype', () => {
  const context = {};
  const result = powerFxEngine.evaluateSync("UpdateContext({'__proto__': {polluted: 1}})", { host: { context } });
  assert.equal(result.value, true);
  assert.equal(Object.getPrototypeOf(context), Object.prototype);
  assert.equal(context.polluted, undefined);
  assert.ok(Object.hasOwn(context, '__proto__'));
  const keys = [];
  const proxied = new Proxy(
    {},
    {
      set(target, key, value) {
        keys.push(key);
        target[key] = value;
        return true;
      },
    },
  );
  powerFxEngine.evaluateSync('UpdateContext({a: 1})', { host: { context: proxied } });
  assert.deepEqual(keys, ['a']);
});

test('Set on a variable named __proto__ writes an own variable, not the variables prototype', () => {
  const variables = {};
  const result = powerFxEngine.evaluateSync('Set(__proto__, {polluted2: 2})', { host: { variables } });
  assert.equal(result.value, true);
  assert.equal(Object.getPrototypeOf(variables), Object.prototype);
  assert.equal(variables.polluted2, undefined);
  assert.ok(Object.hasOwn(variables, '__proto__'));
});

// @test-kind contract: the scope budget is Paqvilo's own local safeguard, not a Power Fx limit.
test('a formula that enters more row scopes than host.scopeBudget stops with PowerFxLimitExceeded', () => {
  const formula = 'ForAll(Sequence(40), ForAll(Sequence(40), Value))';
  assert.equal(evaluateFx(formula).value.length, 40);
  assert.throws(
    () => evaluateFx(formula, { host: { scopeBudget: 100 } }),
    (error) => error.code === 'PowerFxLimitExceeded',
  );
});
