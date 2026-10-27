import test from 'node:test';
import assert from 'node:assert/strict';
import { ALIASES, FxDataSource, evaluateFx, fromFx } from '../lib/power-fx.mjs';

test('sorting by a known display alias treats an unset column as blank', () => {
  const first = { name: 'one' };
  Object.defineProperty(first, ALIASES, { value: new Map([['Created On', 'createdon']]) });
  const { value, fx } = evaluateFx("Sort(Rows, 'Created On')", { values: { Rows: [first] } });
  assert.deepEqual(fromFx(value, fx), [{ name: 'one' }]);
});

test('unknown fields continue to fail rather than becoming blank', () => {
  const first = { name: 'one' };
  Object.defineProperty(first, ALIASES, { value: new Map([['Created On', 'createdon']]) });
  assert.throws(() => evaluateFx("Sort(Rows, 'Invented Missing')", { values: { Rows: [first] } }), {
    code: 'PowerFxNameUnknown',
  });
});

test('ClearCollect materializes a data source instead of wrapping it as a scalar', () => {
  const source = new FxDataSource('DS', { read: () => [] });
  const host = { variables: {} };
  const { value, fx } = evaluateFx('ClearCollect(local, Filter(DS, true)); CountRows(local)', {
    values: { DS: source },
    host,
  });
  assert.equal(fromFx(value, fx), 0);
  assert.deepEqual(host.variables.local, []);
  assert.ok(fx.warnings.some((entry) => entry.operation === 'ClearCollect'));
});

test('materialized records retain aliases and failed reads do not clear existing rows', () => {
  const row = { title: 'first' };
  Object.defineProperty(row, ALIASES, {
    value: new Map([
      ['Title', 'title'],
      ['Created On', 'createdon'],
    ]),
  });
  const source = new FxDataSource('DS', { read: () => [row] });
  const host = { variables: { local: [{ title: 'old' }] } };
  const { value, fx } = evaluateFx("ClearCollect(local, DS); Sort(local, 'Created On')", {
    values: { DS: source },
    host,
  });
  assert.deepEqual(fromFx(value, fx), [{ title: 'first' }]);
  const denied = new FxDataSource('DS', {
    read: () => {
      throw Object.assign(new Error('denied'), { status: 403 });
    },
  });
  assert.throws(() => evaluateFx('ClearCollect(local, DS)', { values: { DS: denied }, host }), { status: 403 });
  assert.equal(host.variables.local[0].title, 'first');
});

test('UpdateIf uses the data source adapter and propagates denied writes', () => {
  const row = { score: 2 };
  let calls = 0;
  const source = new FxDataSource('DS', {
    read: () => [row],
    update: (record, changes) => {
      calls++;
      assert.equal(record, row);
      assert.deepEqual(changes, { score: 3 });
      throw Object.assign(new Error('denied'), { status: 403 });
    },
  });
  const { value } = evaluateFx('UpdateIf(DS, score = 2, {score: score + 1})', { values: { DS: source } });
  assert.throws(() => fromFx(value), { status: 403 });
  assert.equal(calls, 1);
  assert.equal(row.score, 2);
});
