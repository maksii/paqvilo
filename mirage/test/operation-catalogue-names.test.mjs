// @test-kind contract: a cloud flow is bound by its process id, so a display name shared by two flows only makes a name-bound handler ambiguous (Dataverse does not require workflow names to be unique)
import test from 'node:test';
import assert from 'node:assert/strict';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';

const first = '11111111-1111-1111-1111-111111111111';
const second = '22222222-2222-2222-2222-222222222222';
const flow = (name) => ({
  name,
  file: null,
  definition: { properties: { definition: { triggers: {}, actions: {} } } },
});
const workflows = () =>
  new Map([
    [first, flow('Notify owner')],
    [second, flow('Notify owner')],
  ]);
const handlers = (cloudFlowNames = []) => ({
  serverLogics: new Map(),
  cloudFlows: new Map(cloudFlowNames.map((name) => [name, () => {}])),
  flowIdentities: new Map(),
});

test('two cloud flows with one display name keep their own keys and do not throw', () => {
  const diagnostics = [];
  const items = operationCatalogue({
    workflows: workflows(),
    handlers: handlers(),
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.deepEqual(
    items.map((item) => item.key),
    [`cloud-flow:${first}`, `cloud-flow:${second}`],
  );
  assert.deepEqual(
    diagnostics.map((entry) => entry.code),
    ['OPERATION_NAME_AMBIGUOUS'],
  );
});

test('a handler bound to a shared flow name binds neither flow and reports the collision once', () => {
  const diagnostics = [];
  const items = operationCatalogue({
    workflows: workflows(),
    handlers: handlers(['notify owner']),
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.deepEqual(
    items.map((item) => [item.mode, item.registered]),
    [
      ['placeholder', false],
      ['placeholder', false],
    ],
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 'OPERATION_NAME_AMBIGUOUS');
  assert.equal(diagnostics[0].severity, 'warning');
  assert.equal(diagnostics[0].kind, 'cloud-flow');
  assert.deepEqual(diagnostics[0].keys, [`cloud-flow:${first}`, `cloud-flow:${second}`]);
  assert.ok(!JSON.stringify(diagnostics).includes('Notify owner'));
});

test('a single flow with a handler-bound name is not marked ambiguous', () => {
  const diagnostics = [];
  const [item] = operationCatalogue({
    workflows: new Map([[first, flow('Notify owner')]]),
    handlers: handlers(['notify owner']),
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.equal(item.registered, true);
  assert.equal(item.mode, 'handler');
  assert.equal(diagnostics.length, 0);
});

test('two server logics with one name still throw, because the name is their route', () => {
  assert.throws(
    () =>
      operationCatalogue({
        portal: {
          serverLogics: [
            { id: 'logic-a', name: 'Calculate' },
            { id: 'logic-b', name: 'calculate' },
          ],
        },
        handlers: handlers(),
      }),
    { status: 409, code: 'AmbiguousOperation' },
  );
});

test('two operations with one id still throw', () => {
  assert.throws(
    () =>
      operationCatalogue({
        portal: {
          cloudFlows: [
            { id: 'same', name: 'First', processId: first },
            { id: 'same', name: 'Second', processId: second },
          ],
        },
        workflows: workflows(),
        handlers: handlers(),
      }),
    { status: 409, code: 'AmbiguousOperation' },
  );
});
