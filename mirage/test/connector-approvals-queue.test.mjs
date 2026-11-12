// @test-kind contract: the approval and Service Bus queue connector operations are Paqvilo's designed runtime behaviour over the local store and bus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createLocalMessageBus } from '../lib/message-bus.mjs';
import { createFlowRunStore } from '../lib/flow-runs.mjs';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';
import { serveRoutes } from './support/route-server.mjs';

const flow = { caller: 'flow', canSuspend: true, runId: 'run-1', actionPath: 'Approve' };

async function organization(t) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  return { clock, store, scheduler };
}

test('StartAndWaitForAnApproval records a Pending approval and answers the suspended marker', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const answer = await runtime.invoke({
    connectorId: 'shared_approvals',
    operationId: 'StartAndWaitForAnApproval',
    context: { ...flow, waitTimeoutMs: 3600000 },
    parameters: {
      approvalType: 'Basic',
      'WebhookApprovalCreationInput/title': 'Invented request',
      'WebhookApprovalCreationInput/assignedTo': 'a@example.test; b@example.test',
      'WebhookApprovalCreationInput/details': 'Invented details',
    },
  });
  const id = answer.suspended.id;
  assert.deepEqual(answer.suspended, {
    kind: 'approval',
    id,
    timeoutAt: '2026-01-01T01:00:00.000Z',
    assignedTo: ['a@example.test', 'b@example.test'],
  });
  assert.deepEqual(store.state.simulator.approvals[id].status, 'Pending');
  assert.deepEqual(store.state.simulator.approvals[id].responses, []);
  assert.equal(store.state.simulator.approvals[id].title, 'Invented request');

  // A caller that cannot suspend never gets a success and no record is written.
  await assert.rejects(
    runtime.invoke({
      connectorId: 'shared_approvals',
      operationId: 'StartAndWaitForAnApproval',
      parameters: {
        'WebhookApprovalCreationInput/title': 'x',
        'WebhookApprovalCreationInput/assignedTo': 'a@example.test',
      },
    }),
    { code: 'FlowSuspendNotWired', status: 501 },
  );
  assert.equal(Object.keys(store.state.simulator.approvals).length, 1);

  // WaitForAnApproval suspends while pending and answers outputs once completed.
  assert.equal(
    (
      await runtime.invoke({
        connectorId: 'shared_approvals',
        operationId: 'WaitForAnApproval',
        parameters: { approvalName: id },
        context: flow,
      })
    ).suspended.id,
    id,
  );
  await assert.rejects(
    runtime.invoke({
      connectorId: 'shared_approvals',
      operationId: 'WaitForAnApproval',
      parameters: { approvalName: 'missing' },
      context: flow,
    }),
    { code: 'ApprovalNotFound' },
  );
});

test('respond completes the approval with the documented outcome and responses fields', async (t) => {
  const { store, clock } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const created = await runtime.invoke({
    connectorId: 'shared_approvals',
    operationId: 'CreateAnApproval',
    context: flow,
    parameters: { approvalType: 'Basic', ApprovalCreationInput: { title: 'Invented', assignedTo: 'a@example.test' } },
  });
  const id = created.body.name;
  assert.equal(created.body.outcome, null);
  await assert.rejects(runtime.approvals.respond(id, { outcome: 'approve' }), { code: 'InvalidRequest' });
  clock.advance(60000);
  const outputs = await runtime.approvals.respond(id, {
    outcome: 'Approve',
    responder: 'a@example.test',
    comments: 'Fine',
  });
  assert.equal(outputs.statusCode, 200);
  assert.equal(outputs.body.outcome, 'Approve');
  assert.equal(outputs.body.completionDate, '2026-01-01T00:01:00.000Z');
  assert.deepEqual(outputs.body.responses, [
    {
      responder: { id: null, displayName: 'a@example.test', email: 'a@example.test' },
      requestDate: '2026-01-01T00:00:00.000Z',
      responseDate: '2026-01-01T00:01:00.000Z',
      approverResponse: 'Approve',
      comments: 'Fine',
    },
  ]);
  assert.equal(runtime.approvals.get(id).status, 'Approved');
  await assert.rejects(runtime.approvals.respond(id, { outcome: 'Reject' }), {
    code: 'ApprovalCompleted',
    status: 409,
  });
  const waited = await runtime.invoke({
    connectorId: 'shared_approvals',
    operationId: 'WaitForAnApproval',
    parameters: { approvalName: id },
    context: flow,
  });
  assert.equal(waited.body.outcome, 'Approve');
  assert.equal(waited.suspended, undefined);
});

test('an approval wait timeout marks the approval TimedOut and the run TimedOut', async (t) => {
  const { store, scheduler } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const runs = createFlowRunStore({ store, scheduler, approvals: runtime.approvals });
  const run = await runs.start({ processId: '77777777-7777-4777-8777-777777777777' });
  const answer = await runtime.invoke({
    connectorId: 'shared_approvals',
    operationId: 'StartAndWaitForAnApproval',
    context: { ...flow, runId: run.id, waitTimeoutMs: 1000 },
    parameters: {
      'WebhookApprovalCreationInput/title': 'Invented',
      'WebhookApprovalCreationInput/assignedTo': 'a@example.test',
    },
  });
  await runs.suspend(run.id, { actionPath: 'Approve', wait: answer.suspended });
  await scheduler.advance(1000);
  assert.equal(runtime.approvals.get(answer.suspended.id).status, 'TimedOut');
  assert.equal(runs.get(run.id).status, 'TimedOut');
  assert.deepEqual(runtime.approvals.list({ status: 'Pending' }), []);
});

test('approval names are own keys, so __proto__ and constructor answer ApprovalNotFound', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  for (const approvalName of ['__proto__', 'constructor']) {
    await assert.rejects(
      runtime.invoke({
        connectorId: 'shared_approvals',
        operationId: 'WaitForAnApproval',
        parameters: { approvalName },
        context: flow,
      }),
      { status: 404, code: 'ApprovalNotFound' },
    );
    await assert.rejects(runtime.approvals.respond(approvalName, { outcome: 'Approve' }), {
      status: 404,
      code: 'ApprovalNotFound',
    });
    assert.equal(await runtime.approvals.close(approvalName, 'TimedOut'), false);
    assert.equal(runtime.approvals.get(approvalName), null);
  }
});

const CSRF = 'invented-csrf';
const FLOW = '77777777-7777-4777-8777-777777777777';

// Starts an approval with the given type and assignees (and any extra parameters) in a flow context.
async function startApproval(
  runtime,
  { context = flow, approvalType = 'Basic', assignedTo = 'a@example.test', ...rest } = {},
) {
  return runtime.invoke({
    connectorId: 'shared_approvals',
    operationId: 'StartAndWaitForAnApproval',
    context,
    parameters: {
      approvalType,
      'WebhookApprovalCreationInput/title': 'Invented',
      'WebhookApprovalCreationInput/assignedTo': assignedTo,
      ...rest,
    },
  });
}

// A flow run waiting on an approval, served by the flow-waits route; resumed collects every resumeRun call.
async function waitingRoutes(t, { approvalType, assignedTo }) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const connectors = createConnectorRuntime({ store });
  const flowRuns = createFlowRunStore({ store, scheduler, approvals: connectors.approvals });
  const resumed = [];
  const routes = createFlowRoutes({
    api: { flowRuns, providers: { connectors } },
    csrf: () => CSRF,
    resumeRun: (id, outcome) => resumed.push([id, outcome]),
  });
  const origin = await serveRoutes(t, routes);
  const run = await flowRuns.start({ processId: FLOW });
  const answer = await startApproval(connectors, { context: { ...flow, runId: run.id }, approvalType, assignedTo });
  await flowRuns.suspend(run.id, { actionPath: 'Approve', wait: answer.suspended });
  const post = async (approvalId, body) => {
    const response = await fetch(`${origin}/_sim/api/flow-waits/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': CSRF },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { connectors, scheduler, resumed, run, approvalId: answer.suspended.id, post };
}

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('an AwaitAll approval stays Pending until every assignee approves, then resumes its run once', async (t) => {
  const { connectors, scheduler, resumed, run, approvalId, post } = await waitingRoutes(t, {
    approvalType: 'AwaitAll',
    assignedTo: 'a@example.test; b@example.test',
  });
  const first = await post(approvalId, { outcome: 'Approve', responder: 'a@example.test' });
  assert.equal(first.status, 202);
  assert.equal(first.body.scheduled, false);
  assert.equal(first.body.outcome, null);
  await scheduler.runDue();
  assert.equal(connectors.approvals.get(approvalId).status, 'Pending');
  assert.deepEqual(resumed, []);

  const second = await post(approvalId, { outcome: 'Approve', responder: 'B@example.test' });
  assert.equal(second.status, 202);
  assert.equal(second.body.scheduled, true);
  assert.equal(second.body.outcome, 'Approve');
  await scheduler.runDue();
  assert.equal(connectors.approvals.get(approvalId).status, 'Approved');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0][0], run.id);
  assert.equal(resumed[0][1].status, 'Succeeded');
});

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('a single Reject ends an AwaitAll approval Rejected, and several assignees need a named responder', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime, {
    approvalType: 'AwaitAll',
    assignedTo: 'a@example.test; b@example.test',
  });
  await assert.rejects(runtime.approvals.respond(suspended.id, { outcome: 'Approve' }), {
    status: 400,
    code: 'InvalidRequest',
    message: /a@example\.test, b@example\.test/,
  });
  assert.equal(runtime.approvals.get(suspended.id).status, 'Pending');
  const outputs = await runtime.approvals.respond(suspended.id, {
    outcome: 'Reject',
    responder: 'b@example.test',
    comments: 'No',
  });
  assert.equal(outputs.completed, true);
  assert.equal(outputs.body.outcome, 'Reject');
  assert.equal(runtime.approvals.get(suspended.id).status, 'Rejected');
});

// @test-kind unproven+security: the behaviour follows the product documentation for approval types, no recorded capture
test('a responder who is not assigned is refused with 403 and changes nothing', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime);
  await assert.rejects(
    runtime.approvals.respond(suspended.id, { outcome: 'Approve', responder: 'stranger@example.test' }),
    { status: 403, code: 'ApprovalResponderNotAssigned' },
  );
  assert.equal(runtime.approvals.get(suspended.id).status, 'Pending');
  assert.deepEqual(runtime.approvals.get(suspended.id).responses, []);
  const outputs = await runtime.approvals.respond(suspended.id, {
    outcome: 'Approve',
    responder: { id: null, displayName: 'Ann', email: 'A@Example.TEST' },
  });
  assert.equal(outputs.completed, true);
});

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('a second response from one assignee is refused with 409 and does not complete an AwaitAll approval', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime, {
    approvalType: 'AwaitAll',
    assignedTo: 'a@example.test; b@example.test',
  });
  await runtime.approvals.respond(suspended.id, { outcome: 'Approve', responder: 'a@example.test' });
  assert.equal(runtime.approvals.get(suspended.id).status, 'Pending');
  await assert.rejects(runtime.approvals.respond(suspended.id, { outcome: 'Approve', responder: 'A@example.test' }), {
    status: 409,
    code: 'ApprovalAlreadyAnswered',
  });
  assert.equal(runtime.approvals.get(suspended.id).status, 'Pending');
  assert.equal(runtime.approvals.get(suspended.id).responses.length, 1);
});

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('a Custom approval accepts only its response options and completes on the first of them', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime, {
    approvalType: 'Custom',
    'WebhookApprovalCreationInput/responseOptions': 'Accept; Decline',
  });
  await assert.rejects(runtime.approvals.respond(suspended.id, { outcome: 'Approve', responder: 'a@example.test' }), {
    status: 400,
    code: 'InvalidRequest',
  });
  assert.equal(runtime.approvals.get(suspended.id).status, 'Pending');
  const outputs = await runtime.approvals.respond(suspended.id, { outcome: 'Accept', responder: 'a@example.test' });
  assert.equal(outputs.completed, true);
  assert.equal(runtime.approvals.get(suspended.id).status, 'Completed');
  assert.equal(runtime.approvals.get(suspended.id).outcome, 'Accept');
});

test('a Custom response named like an Object.prototype member completes with its text and keeps the store cloneable', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  for (const outcome of ['constructor', '__proto__', 'toString']) {
    const { suspended } = await startApproval(runtime, {
      approvalType: 'Custom',
      'WebhookApprovalCreationInput/responseOptions': 'constructor; __proto__; toString; Yes',
    });
    const outputs = await runtime.approvals.respond(suspended.id, { outcome, responder: 'a@example.test' });
    assert.equal(outputs.completed, true);
    const approval = runtime.approvals.get(suspended.id);
    assert.equal(approval.status, 'Completed');
    assert.equal(approval.outcome, outcome);
    assert.doesNotThrow(() => structuredClone(store.state));
  }
  const { suspended } = await startApproval(runtime);
  const outputs = await runtime.approvals.respond(suspended.id, { outcome: 'Approve', responder: 'a@example.test' });
  assert.equal(outputs.completed, true);
  assert.equal(runtime.approvals.get(suspended.id).status, 'Approved');
  assert.doesNotThrow(() => structuredClone(store.state));
});

test('case-differing duplicate assignees collapse to one, so an AwaitAll approval completes after one response', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime, {
    approvalType: 'AwaitAll',
    assignedTo: ' A@example.test ; a@example.test ;; ',
  });
  assert.deepEqual(suspended.assignedTo, ['A@example.test']);
  const outputs = await runtime.approvals.respond(suspended.id, { outcome: 'Approve', responder: 'a@example.test' });
  assert.equal(outputs.completed, true);
  assert.equal(runtime.approvals.get(suspended.id).status, 'Approved');
  assert.deepEqual(runtime.approvals.get(suspended.id).answeredBy, ['A@example.test']);
});

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('a CustomAwaitAll approval completes after every assignee answers and joins the responses', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime, {
    approvalType: 'CustomAwaitAll',
    assignedTo: 'a@example.test; b@example.test',
    'WebhookApprovalCreationInput/responseOptions': 'Accept;Decline',
  });
  const first = await runtime.approvals.respond(suspended.id, { outcome: 'Accept', responder: 'a@example.test' });
  assert.equal(first.completed, false);
  assert.equal(runtime.approvals.get(suspended.id).status, 'Pending');
  const second = await runtime.approvals.respond(suspended.id, { outcome: 'Decline', responder: 'b@example.test' });
  assert.equal(second.completed, true);
  assert.equal(runtime.approvals.get(suspended.id).status, 'Completed');
  assert.equal(runtime.approvals.get(suspended.id).outcome, 'Accept, Decline');
});

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('an approval type the provider does not model, or a Custom type without options, is refused at creation', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  await assert.rejects(startApproval(runtime, { approvalType: 'Escalate' }), { status: 400, code: 'ProviderFailed' });
  await assert.rejects(startApproval(runtime, { approvalType: 'Custom' }), { status: 400, code: 'ProviderFailed' });
  assert.equal(Object.keys(store.state.simulator?.approvals ?? {}).length, 0);
});

// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
// @test-kind unproven: the behaviour follows the product documentation for approval types, no recorded capture
test('a response without a responder is recorded for the only assignee', async (t) => {
  const { store } = await organization(t);
  const runtime = createConnectorRuntime({ store });
  const { suspended } = await startApproval(runtime);
  const outputs = await runtime.approvals.respond(suspended.id, { outcome: 'Approve' });
  assert.equal(outputs.completed, true);
  assert.equal(outputs.body.responses[0].responder.email, 'a@example.test');
});

test('Service Bus queue actions send, peek-lock, complete, abandon and dead-letter over the local bus', async (t) => {
  const { store } = await organization(t);
  const bus = createLocalMessageBus({ store, retry: { maxAttempts: 5, backoffMs: [], deadLetter: true } });
  const runtime = createConnectorRuntime({ store, messaging: () => bus });
  const call = (operationId, parameters) =>
    runtime.invoke({ connectorId: 'shared_servicebus', operationId, parameters, context: { caller: 'server-logic' } });
  assert.equal(
    (
      await call('SendMessage', {
        entityName: 'x_orders',
        ContentData: 'eyJpZCI6MX0=',
        Properties: { kind: 'invented' },
        MessageId: 'm1',
      })
    ).statusCode,
    200,
  );
  await call('SendMessages', {
    entityName: 'x_orders',
    messages: [
      { ContentData: 'Mg==', MessageId: 'm2' },
      { ContentData: 'Mw==', MessageId: 'm3' },
    ],
  });
  const received = (await call('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders', maxMessageCount: 3 })).body;
  assert.deepEqual(
    received.map((m) => [m.MessageId, m.ContentData, m.SequenceNumber]),
    [
      ['m1', 'eyJpZCI6MX0=', 1],
      ['m2', 'Mg==', 2],
      ['m3', 'Mw==', 3],
    ],
  );
  assert.deepEqual(received[0].Properties, { kind: 'invented' });
  await call('CompleteMessageInQueue', { queueName: 'x_orders', lockToken: received[0].LockToken });
  await call('AbandonMessageInQueue', { queueName: 'x_orders', lockToken: received[1].LockToken });
  await call('DeadLetterMessageInQueue', {
    queueName: 'x_orders',
    lockToken: received[2].LockToken,
    deadLetterReason: 'Invented',
    deadLetterErrorDescription: 'Rejected locally',
  });
  await assert.rejects(call('CompleteMessageInQueue', { queueName: 'x_orders', lockToken: received[0].LockToken }), {
    code: 'MessageLockLost',
  });
  assert.deepEqual(
    (await call('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders' })).body.map((m) => m.MessageId),
    ['m2'],
  );
  const dead = (await call('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders', queueType: 'DeadLetter' }))
    .body;
  assert.deepEqual(
    dead.map((m) => m.MessageId),
    ['m3'],
  );
  assert.equal(bus.peek('x_orders/$deadletterqueue')[0].deadLetterReason, 'Invented');
  // Inside a flow's store transaction the send, the peek-lock receive and the settlement all join it (no 501, no wait).
  const inFlow = (operationId, parameters) =>
    runtime.invoke({ connectorId: 'shared_servicebus', operationId, parameters, context: { caller: 'flow' } });
  await store.transact(() => inFlow('SendMessage', { entityName: 'x_orders', ContentData: 'NA==', MessageId: 'm4' }));
  const flowReceived = await store.transact(() =>
    inFlow('GetMessagesFromQueueWithPeekLock', { queueName: 'x_orders' }),
  );
  assert.deepEqual(
    flowReceived.body.map((m) => m.MessageId),
    ['m4'],
  );
  await store.transact(() =>
    inFlow('CompleteMessageInQueue', { queueName: 'x_orders', lockToken: flowReceived.body[0].LockToken }),
  );
  assert.deepEqual(
    bus.peek('x_orders').map((m) => m.messageId),
    ['m2'],
    'only the still-locked m2 remains',
  );
});
