import test from 'node:test';
import assert from 'node:assert/strict';
import { createPowerFxEvaluator, notImplementedPowerFx, validatePowerFxAdapter } from '../lib/canvas-power-fx.mjs';

test('the default Power Fx evaluator is the core engine at behaviour', async () => {
  const evaluator = createPowerFxEvaluator();
  assert.deepEqual(await evaluator.evaluate('1 + 1'), { value: 2 });
  assert.deepEqual(evaluator.evaluateSync('Upper(x)', { values: { x: 'fx' } }), { value: 'FX' });
  assert.deepEqual(evaluator.checkSync('Sum(1, 2)'), { ok: true, diagnostics: [] });
  assert.equal(evaluator.checkSync('x_Unknown(1)').diagnostics[0].code, 'POWERFX_FUNCTION_UNSUPPORTED');
  assert.equal(evaluator.registered, false, 'registered names a pack adapter');
  assert.equal(evaluator.available, true);
  assert.equal(evaluator.source, 'core');
  const behaviour = { level: 'behaviour' };
  assert.deepEqual(evaluator.describe(), {
    name: 'power-fx',
    version: 1,
    kind: 'provider',
    level: 'behaviour',
    source: 'core',
    operations: [
      { name: 'evaluate', ...behaviour },
      { name: 'evaluateSync', ...behaviour },
      { name: 'check', ...behaviour },
      { name: 'checkSync', ...behaviour },
    ],
    requires: [],
    principal: 'caller',
    stateOwner: 'none',
    lifecycle: 'stateless',
  });
});

test('the explicitly disabled engine answers 501 PowerFxNotImplemented and reports contract level', async () => {
  const evaluator = createPowerFxEvaluator({ engine: false });
  await assert.rejects(
    evaluator.evaluate('1 + 1'),
    (error) =>
      error.name === 'DataError' &&
      error.status === 501 &&
      error.code === 'PowerFxNotImplemented' &&
      error.message === 'Power Fx evaluation is disabled; enable the engine or register a pack powerFx adapter.',
  );
  const checked = await evaluator.check('1 + 1', { symbols: {} });
  assert.equal(checked.ok, false);
  assert.equal(checked.diagnostics[0].code, 'POWERFX_NOT_IMPLEMENTED');
  const contract = { level: 'contract' };
  assert.deepEqual(evaluator.describe(), {
    name: 'power-fx',
    version: 1,
    kind: 'provider',
    level: 'contract',
    source: 'disabled',
    operations: [
      { name: 'evaluate', ...contract },
      { name: 'evaluateSync', ...contract },
      { name: 'check', ...contract },
      { name: 'checkSync', ...contract },
    ],
    requires: ['adapter:powerFx'],
    principal: 'caller',
    stateOwner: 'none',
    lifecycle: 'stateless',
  });
  assert.throws(() => notImplementedPowerFx.evaluate('1'), { status: 501 });
  assert.throws(() => evaluator.evaluateSync('1'), { status: 501, code: 'PowerFxNotImplemented' });
  assert.throws(() => evaluator.checkSync('1'), { status: 501, code: 'PowerFxNotImplemented' });
});

test('registered Power Fx adapter receives expression, symbols, values and principal', async () => {
  const calls = [];
  const adapter = {
    evaluate: async (expression, context) => {
      calls.push(['evaluate', expression, context]);
      return { value: context.values.fxCount + 1 };
    },
    check: (expression, context) => {
      calls.push(['check', expression, context]);
      return { ok: true, diagnostics: [], returnType: 'Number' };
    },
  };
  const evaluator = createPowerFxEvaluator({ adapter });
  const symbols = { fxCount: 'Number' },
    principal = { id: '77777777-7777-4777-8777-777777777777' };
  assert.deepEqual(await evaluator.evaluate('fxCount + 1', { symbols, values: { fxCount: 2 }, principal }), {
    value: 3,
  });
  assert.deepEqual(await evaluator.check('fxCount + 1', { symbols }), {
    ok: true,
    diagnostics: [],
    returnType: 'Number',
  });
  assert.deepEqual(calls, [
    ['evaluate', 'fxCount + 1', { symbols, values: { fxCount: 2 }, principal }],
    ['check', 'fxCount + 1', { symbols }],
  ]);
  assert.equal(evaluator.describe().level, 'behaviour');
});

test('Power Fx adapter without check and with an invalid result are reported, not treated as success', async () => {
  const evaluator = createPowerFxEvaluator({ adapter: { evaluate: () => 'bare' } });
  assert.equal((await evaluator.check('1')).ok, false);
  await assert.rejects(evaluator.evaluate('1'), { code: 'PowerFxAdapterInvalid' });
  await assert.rejects(evaluator.evaluate('  '), { code: 'PowerFxExpressionRequired', status: 400 });
});

test('validatePowerFxAdapter rejects missing or non-function members', () => {
  for (const bad of [null, 'fx', {}, { evaluate: 'fx' }, { evaluate: () => ({}), check: 1 }])
    assert.throws(() => validatePowerFxAdapter(bad), TypeError);
  const good = { evaluate: () => ({ value: 1 }) };
  assert.equal(validatePowerFxAdapter(good), good);
  assert.throws(() => createPowerFxEvaluator({ adapter: { check: () => ({}) } }), TypeError);
  assert.throws(() => validatePowerFxAdapter({ evaluateSync: () => ({ value: 1 }), checkSync: 'fx' }), TypeError);
  assert.doesNotThrow(() => validatePowerFxAdapter({ evaluateSync: () => ({ value: 1 }) }));
});

test('a synchronous adapter answers evaluateSync and checkSync, and the async evaluate delegates to it', async () => {
  const adapter = {
    evaluateSync: (expression, context) => ({ value: context.values.n * 2 }),
    checkSync: (_expression, _context) => ({ ok: true, diagnostics: [], returnType: 'Number' }),
  };
  const evaluator = createPowerFxEvaluator({ adapter });
  assert.deepEqual(evaluator.evaluateSync('n', { values: { n: 4 } }), { value: 8 });
  assert.deepEqual(evaluator.checkSync('n', { symbols: { n: 'Number' } }), {
    ok: true,
    diagnostics: [],
    returnType: 'Number',
  });
  assert.deepEqual(await evaluator.evaluate('n', { values: { n: 5 } }), { value: 10 });
  assert.deepEqual(await evaluator.check('n'), { ok: true, diagnostics: [], returnType: 'Number' });
  const operations = Object.fromEntries(evaluator.describe().operations.map(({ name, level }) => [name, level]));
  assert.deepEqual(operations, {
    evaluate: 'behaviour',
    evaluateSync: 'behaviour',
    check: 'behaviour',
    checkSync: 'behaviour',
  });
});

test('an adapter that answers with a promise is refused on the synchronous path with PowerFxAsyncAdapter', async () => {
  const promised = createPowerFxEvaluator({ adapter: { evaluate: () => Promise.resolve({ value: 1 }) } });
  assert.throws(() => promised.evaluateSync('1'), { status: 501, code: 'PowerFxAsyncAdapter' });
  const asyncFunction = createPowerFxEvaluator({ adapter: { evaluate: async () => ({ value: 1 }) } });
  assert.throws(() => asyncFunction.evaluateSync('1'), { status: 501, code: 'PowerFxAsyncAdapter' });
  assert.deepEqual(await asyncFunction.evaluate('1'), { value: 1 });
  assert.equal(
    Object.fromEntries(asyncFunction.describe().operations.map(({ name, level }) => [name, level])).evaluateSync,
    'contract',
  );
});

test('a check-only adapter without checkSync answers checkSync through its synchronous check', () => {
  const evaluator = createPowerFxEvaluator({
    adapter: { evaluate: () => ({ value: 1 }), check: () => ({ ok: true, diagnostics: [] }) },
  });
  assert.deepEqual(evaluator.checkSync('1'), { ok: true, diagnostics: [] });
  const asyncCheck = createPowerFxEvaluator({
    adapter: { evaluate: () => ({ value: 1 }), check: async () => ({ ok: true, diagnostics: [] }) },
  });
  assert.throws(() => asyncCheck.checkSync('1'), { code: 'PowerFxAsyncAdapter' });
});
