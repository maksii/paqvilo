import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createLocalMessageBus } from '../lib/message-bus.mjs';
import { createFlowRunStore } from '../lib/flow-runs.mjs';

const flow = { caller: 'flow', canSuspend: true, runId: 'run-1', actionPath: 'Approve' };

async function organization(t) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  return { clock, store, scheduler };
}

test('StartAndWaitForAnApproval records a Pending approval and answers the suspended marker', async t => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const answer = await runtime.invoke({ connectorId: 'shared_approvals', operationId: 'StartAndWaitForAnApproval', context: { ...flow, waitTimeoutMs: 3600000 },
    parameters: { approvalType: 'Basic', 'WebhookApprovalCreationInput/title': 'Invented request', 'WebhookApprovalCreationInput/assignedTo': 'a@example.test; b@example.test', 'WebhookApprovalCreationInput/details': 'Invented details' } });
  const id = answer.suspended.id;
  assert.deepEqual(answer.suspended, { kind: 'approval', id, timeoutAt: '2026-01-01T01:00:00.000Z', assignedTo: ['a@example.test', 'b@example.test'] });
  assert.deepEqual(store.state.simulator.approvals[id].status, 'Pending');
  assert.deepEqual(store.state.simulator.approvals[id].responses, []);
  assert.equal(store.state.simulator.approvals[id].title, 'Invented request');

  // A caller that cannot suspend never gets a success and no record is written.
  await assert.rejects(runtime.invoke({ connectorId: 'shared_approvals', operationId: 'StartAndWaitForAnApproval', parameters: { 'WebhookApprovalCreationInput/title': 'x', 'WebhookApprovalCreationInput/assignedTo': 'a@example.test' } }),
    { code: 'FlowSuspendNotWired', status: 501 });
  assert.equal(Object.keys(store.state.simulator.approvals).length, 1);

  // WaitForAnApproval suspends while pending and answers outputs once completed.
  assert.equal((await runtime.invoke({ connectorId: 'shared_approvals', operationId: 'WaitForAnApproval', parameters: { approvalName: id }, context: flow })).suspended.id, id);
  await assert.rejects(runtime.invoke({ connectorId: 'shared_approvals', operationId: 'WaitForAnApproval', parameters: { approvalName: 'missing' }, context: flow }), { code: 'ApprovalNotFound' });
});

test('respond completes the approval with the documented outcome and responses fields', async t => {
  const { store, clock } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const created = await runtime.invoke({ connectorId: 'shared_approvals', operationId: 'CreateAnApproval', context: flow,
    parameters: { approvalType: 'Basic', ApprovalCreationInput: { title: 'Invented', assignedTo: 'a@example.test' } } });
  const id = created.body.name;
  assert.equal(created.body.outcome, null);
  await assert.rejects(runtime.approvals.respond(id, { outcome: 'approve' }), { code: 'InvalidRequest' });
  clock.advance(60000);
  const outputs = await runtime.approvals.respond(id, { outcome: 'Approve', responder: 'a@example.test', comments: 'Fine' });
  assert.equal(outputs.statusCode, 200);
  assert.equal(outputs.body.outcome, 'Approve');
  assert.equal(outputs.body.completionDate, '2026-01-01T00:01:00.000Z');
  assert.deepEqual(outputs.body.responses, [{ responder: { id: null, displayName: 'a@example.test', email: 'a@example.test' }, requestDate: '2026-01-01T00:00:00.000Z',
    responseDate: '2026-01-01T00:01:00.000Z', approverResponse: 'Approve', comments: 'Fine' }]);
  assert.equal(runtime.approvals.get(id).status, 'Approved');
  await assert.rejects(runtime.approvals.respond(id, { outcome: 'Reject' }), { code: 'ApprovalCompleted', status: 409 });
  const waited = await runtime.invoke({ connectorId: 'shared_approvals', operationId: 'WaitForAnApproval', parameters: { approvalName: id }, context: flow });
  assert.equal(waited.body.outcome, 'Approve');
  assert.equal(waited.suspended, undefined);
});

test('an approval wait timeout marks the approval TimedOut and the run TimedOut', async t => {
  const { store, scheduler } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const runs = createFlowRunStore({ store, scheduler, approvals: runtime.approvals });
  const run = await runs.start({ processId: '77777777-7777-4777-8777-777777777777' });
  const answer = await runtime.invoke({ connectorId: 'shared_approvals', operationId: 'StartAndWaitForAnApproval', context: { ...flow, runId: run.id, waitTimeoutMs: 1000 },
    parameters: { 'WebhookApprovalCreationInput/title': 'Invented', 'WebhookApprovalCreationInput/assignedTo': 'a@example.test' } });
  await runs.suspend(run.id, { actionPath: 'Approve', wait: answer.suspended });
  await scheduler.advance(1000);
  assert.equal(runtime.approvals.get(answer.suspended.id).status, 'TimedOut');
  assert.equal(runs.get(run.id).status, 'TimedOut');
  assert.deepEqual(runtime.approvals.list({ status: 'Pending' }), []);
});

test('Service Bus queue actions send, peek-lock, complete, abandon and dead-letter over the local bus', async t => {
  const { store } = await organization(t);
  const bus = createLocalMessageBus({ store, retry: { maxAttempts: 5, backoffMs: [], deadLetter: true } });
  const runtime = createConnectorRuntime({ store, messaging: () => bus });
  const call = (operationId, parameters) => runtime.invoke({ connectorId: 'shared_servicebus', operationId, parameters, context: { caller: 'server-logic' } });
  assert.equal((await call('SendMessage', { entityName: 'x_orders', ContentData: 'eyJpZCI6MX0=', Properties: { kind: 'invented' }, MessageId: 'm1' })).statusCode, 200);
  await call('SendMessages', { entityName: 'x_orders', messages: [{ ContentData: 'Mg==', MessageId: 'm2' }, { ContentData: 'Mw==', MessageId: 'm3' }] });
  const received = (await call('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders', maxMessageCount: 3 })).body;
  assert.deepEqual(received.map(m => [m.MessageId, m.ContentData, m.SequenceNumber]), [['m1', 'eyJpZCI6MX0=', 1], ['m2', 'Mg==', 2], ['m3', 'Mw==', 3]]);
  assert.deepEqual(received[0].Properties, { kind: 'invented' });
  await call('CompleteMessageInQueue', { queueName: 'x_orders', lockToken: received[0].LockToken });
  await call('AbandonMessageInQueue', { queueName: 'x_orders', lockToken: received[1].LockToken });
  await call('DeadLetterMessageInQueue', { queueName: 'x_orders', lockToken: received[2].LockToken, deadLetterReason: 'Invented', deadLetterErrorDescription: 'Rejected locally' });
  await assert.rejects(call('CompleteMessageInQueue', { queueName: 'x_orders', lockToken: received[0].LockToken }), { code: 'MessageLockLost' });
  assert.deepEqual((await call('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders' })).body.map(m => m.MessageId), ['m2']);
  const dead = (await call('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders', queueType: 'DeadLetter' })).body;
  assert.deepEqual(dead.map(m => m.MessageId), ['m3']);
  assert.equal(bus.peek('x_orders/$deadletterqueue')[0].deadLetterReason, 'Invented');
  // Inside a flow's store transaction the send, the peek-lock receive and the settlement all join it (no 501, no wait).
  const inFlow = (operationId, parameters) => runtime.invoke({ connectorId: 'shared_servicebus', operationId, parameters, context: { caller: 'flow' } });
  await store.transact(() => inFlow('SendMessage', { entityName: 'x_orders', ContentData: 'NA==', MessageId: 'm4' }));
  const flowReceived = await store.transact(() => inFlow('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders' }));
  assert.deepEqual(flowReceived.body.map(m => m.MessageId), ['m4']);
  await store.transact(() => inFlow('CompleteMessageInQueue', { queueName: 'x_orders', lockToken: flowReceived.body[0].LockToken }));
  assert.deepEqual(bus.peek('x_orders').map(m => m.messageId), ['m2'], 'only the still-locked m2 remains');
});
