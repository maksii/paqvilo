import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FxEnum,
  FxDate,
  FxDataSource,
  FxRecordRef,
  FxError,
  evaluateFx,
  typedPowerFxFunction,
} from '../lib/power-fx.mjs';

test('choice values retain type in typed hosts and serialize numeric values to ordinary hosts', () => {
  let typed, plain;
  const values = { Status: new FxEnum('Status', { Ready: 42 }) };
  const host = {
    functions: {
      'Test.Typed': typedPowerFxFunction((value) => {
        typed = value;
        return value;
      }),
      'Test.Plain': (value) => {
        plain = value;
        return true;
      },
    },
  };
  const result = evaluateFx('Test.Typed(Status.Ready)', { host, values }).value;
  assert.equal(result, values.Status.entries.get('ready'));
  assert.equal(typed, result);
  evaluateFx('Test.Plain(Status.Ready)', { host, values });
  assert.equal(plain, 42);
});

test('typed host functions receive dates, records, tables and references without connector conversion', () => {
  const ref = new FxRecordRef('fixture', '123', () => ({ Name: 'row' }));
  let typed, plain;
  const host = {
    functions: {
      'Test.Typed': typedPowerFxFunction((...values) => {
        typed = values;
        return values[0];
      }),
      'Test.Plain': (...values) => {
        plain = values;
        return true;
      },
    },
  };
  const values = { Lookup: ref };
  const result = evaluateFx('Test.Typed(Date(2026,1,2), {n:1}, [1,2], Lookup)', { host, values }).value;
  assert.ok(result instanceof FxDate);
  assert.ok(typed[0] instanceof FxDate);
  assert.deepEqual(typed[1], { n: 1 });
  assert.deepEqual(typed[2], [{ Value: 1 }, { Value: 2 }]);
  assert.equal(typed[3], ref);
  evaluateFx('Test.Plain(Date(2026,1,2), Lookup)', { host, values });
  assert.equal(plain[0], '2026-01-02');
  assert.deepEqual(plain[1], { id: '123', logical_name: 'fixture' });
});

test('typed hosts do not run on error arguments and reject asynchronous results', () => {
  let called = false;
  const host = {
    functions: {
      'Test.Typed': typedPowerFxFunction(() => {
        called = true;
        return Promise.resolve(1);
      }),
    },
  };
  assert.ok(evaluateFx('Test.Typed(1/0)', { host }).value instanceof FxError);
  assert.equal(called, false);
  assert.throws(() => evaluateFx('Test.Typed(1)', { host }), /synchronously/);
});

test('pure component host refuses mutations through a passed data source', () => {
  let writes = 0;
  const source = new FxDataSource('fixture', {
    create: () => {
      writes++;
      return {};
    },
  });
  const result = evaluateFx('Patch(DS, Defaults(DS), {n:1})', {
    values: { DS: source },
    host: { pureComponent: true },
  }).value;
  assert.ok(result instanceof FxError);
  assert.equal(writes, 0);
});
