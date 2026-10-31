// @test-kind unproven: local pipeline identity model for RequestId/OperationId/CorrelationId and Unspecified DateTime wire values
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { initializePluginOperation } from '../lib/plugin-operation-context.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const parent = {
  $type: 'ExecutionContext',
  values: {
    RequestId: { $type: 'Guid', value: id(1) },
    OperationId: { $type: 'Guid', value: id(1) },
    CorrelationId: { $type: 'Guid', value: id(2) },
    OperationCreatedOn: { $type: 'DateTime', value: '2026-10-30T11:12:13.1234567' },
  },
};

test('synchronous operation metadata uses one local pipeline identity and keeps authored RequestId separate', () => {
  let next = 0;
  const frame = { suppliedRequestId: id(9) },
    store = { ids: { uuid: () => id(++next) }, clock: fixedClock(Date.parse('2026-10-30T11:12:13.000Z')) };
  initializePluginOperation(frame, store, null);
  assert.equal(frame.requestId, id(1));
  assert.equal(frame.operationId, frame.requestId);
  assert.equal(frame.correlationId, id(2));
  assert.notEqual(frame.correlationId, frame.requestId);
  assert.notEqual(frame.requestId, frame.suppliedRequestId);
  assert.equal(frame.createdOn, '2026-10-30T11:12:13.000Z');
  assert.deepEqual(frame.createdOnWire, { $type: 'DateTime', value: '2026-10-30T11:12:13.000' });
});

test('nested Unspecified wire time stays exact while its internal UTC timestamp is safe in a non-UTC process', () => {
  const source = `import { initializePluginOperation } from ${JSON.stringify(new URL('../lib/plugin-operation-context.mjs', import.meta.url).href)};const parent=${JSON.stringify(parent)},frame={};initializePluginOperation(frame,null,parent);console.log(JSON.stringify({frame,offset:new Date('2026-10-30T00:00:00Z').getTimezoneOffset(),parsed:Date.parse(frame.createdOn)}));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, TZ: 'Europe/Kyiv' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.notEqual(result.offset, 0, 'The process must actually use the non-UTC timezone for this failure control');
  assert.equal(result.frame.requestId, id(1));
  assert.equal(result.frame.operationId, id(1));
  assert.equal(result.frame.correlationId, id(2));
  assert.deepEqual(result.frame.createdOnWire, parent.values.OperationCreatedOn);
  assert.equal(result.frame.createdOn, '2026-10-30T11:12:13.1234567Z');
  assert.equal(result.parsed, Date.UTC(2026, 9, 30, 11, 12, 13, 123));
});

test('explicit asynchronous job identity and timestamp override originating synchronous operation metadata', () => {
  const stamp = '2026-10-31T12:00:00.000Z';
  const frame = {
    requestId: id(1),
    operationId: id(9),
    createdOn: stamp,
    createdOnWire: { $type: 'DateTime', value: stamp },
    asyncOperation: { id: id(9), createdOn: stamp },
  };
  initializePluginOperation(frame, null, parent);
  assert.equal(frame.requestId, id(1));
  assert.equal(frame.operationId, id(9));
  assert.notEqual(frame.operationId, frame.requestId);
  assert.equal(frame.createdOn, stamp);
  assert.deepEqual(frame.createdOnWire, { $type: 'DateTime', value: stamp });
});
