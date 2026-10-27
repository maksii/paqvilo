import test from 'node:test';
import assert from 'node:assert/strict';
import { ErrorKind, FxDataSource, FxError, evaluateFx, powerFxEngine } from '../lib/power-fx.mjs';
const run = (formula) => powerFxEngine.evaluateSync(formula).value;

test('Canvas color approximation follows native channel and fade results', () => {
  assert.equal(run('RGBA(1.5,2.5,3.5,0.5)'), 'rgba(1, 2, 3, 0.502)');
  assert.equal(run('ColorValue("#12345680")'), 'rgba(18, 52, 86, 0.502)');
  assert.equal(run('ColorFade(RGBA(100,150,200,1),0.5)'), 'rgba(177, 202, 227, 1)');
  assert.equal(run('ColorFade(RGBA(1,3,5,1),-0.5)'), 'rgba(0, 1, 2, 1)');
  assert.equal(run('Color.Red = ColorValue("Red")'), true);
  assert.equal(run('ColorValue(Blank())'), null);
  assert.equal(run('ColorValue("")'), null);
  const error = evaluateFx('RGBA(256,0,0,1)').value;
  assert.ok(error instanceof FxError);
  assert.equal(error.errors[0].Kind, ErrorKind.InvalidArgument);
});

test('Search matches columns case-insensitively and blank returns all rows', () => {
  assert.equal(run('CountRows(Search([{Name:"Alpha"},{Name:"Beta"}], "PH", Name))'), 1);
  assert.equal(run('CountRows(Search([{Name:Blank()},{Name:"Beta"}], "", Name))'), 2);
  assert.equal(run('CountRows(Search([{Name:"Alpha", City:"York"}], "OR", Name, City))'), 1);
});

test('Rand and RandBetween honor an injected random source and bounded integer ranges', () => {
  const evaluate = (formula, random) => powerFxEngine.evaluateSync(formula, { host: { random } }).value;
  assert.equal(
    evaluate('Rand()', () => 0.25),
    0.25,
  );
  assert.equal(
    evaluate('RandBetween(2,2)', () => 0.9),
    2,
  );
  assert.equal(
    evaluate('RandBetween(-1,1)', () => 0),
    -1,
  );
  assert.equal(
    evaluate('RandBetween(-1,1)', () => 0.999999),
    1,
  );
  assert.equal(
    evaluate('RandBetween(1.1,1.1)', () => 0),
    2,
  );
  const error = evaluateFx('RandBetween(3,2)', { host: { random: () => 0 } }).value;
  assert.ok(error instanceof FxError);
  assert.equal(error.errors[0].Kind, ErrorKind.InvalidArgument);
});

test('EncodeUrl encodes reserved and Unicode characters as in PAC', () => {
  assert.equal(run('EncodeUrl("a b&/é!~*\'()")'), 'a%20b%26%2F%C3%A9%21~%2A%27%28%29');
});

test('Choices refuses an unknown provider without invoking it', () => {
  let invoked = false;
  const source = new FxDataSource('DS', {
    choices: () => {
      invoked = true;
      return { kind: 'choice', values: [] };
    },
  });
  const result = evaluateFx('Choices(DS.Status)', { values: { DS: source } });
  assert.ok(result.value instanceof FxError);
  assert.equal(result.value.errors[0].Kind, ErrorKind.NotSupported);
  assert.equal(invoked, false);
});
