// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createFlowRunStore } from '../lib/flow-runs.mjs';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';
import { serveRoutes } from './support/route-server.mjs';

const FLOW = '77777777-7777-4777-8777-777777777777';
const CSRF = 'invented-csrf';

async function fixture(t, { resumeRun, csrf = () => CSRF } = {}) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const connectors = createConnectorRuntime({ store });
  const flowRuns = createFlowRunStore({ store, scheduler, approvals: connectors.approvals });
  const routes = createFlowRoutes({ api: { flowRuns, providers: { connectors } }, csrf, resumeRun });
  const origin = await serveRoutes(t, routes);
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? JSON.parse(text) : null };
  };
  // A waiting run with a secret input and a secure journalled action, plus a finished run.
  const run = await flowRuns.start({ processId: FLOW, input: { password: 'invented-input-secret' } });
  await flowRuns.journal(run.id, 'Get_key', { outputs: { body: 'invented-secure-output' }, secure: true });
  await flowRuns.journal(run.id, 'Create', { outputs: { statusCode: 201, body: { x_itemid: 'i1' } } });
  const approval = await connectors.invoke({
    connectorId: 'shared_approvals',
    operationId: 'StartAndWaitForAnApproval',
    context: { canSuspend: true, runId: run.id },
    parameters: {
      'WebhookApprovalCreationInput/title': 'Invented',
      'WebhookApprovalCreationInput/assignedTo': 'a@example.test',
    },
  });
  await flowRuns.suspend(run.id, { actionPath: 'Approve', wait: approval.suspended });
  const done = await flowRuns.start({ processId: FLOW });
  await flowRuns.complete(done.id);
  return { call, scheduler, connectors, flowRuns, run, done, approvalId: approval.suspended.id };
}

// @test-kind contract+security: run history omits trigger input and secure outputs
test('run history and waits list runs without trigger input or secure outputs', async (t) => {
  const { call, run, done, approvalId } = await fixture(t);
  const list = await call('GET', `/_sim/api/flow-runs?processId=${FLOW}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((r) => r.id).sort(), [run.id, done.id].sort());
  assert.deepEqual(
    (await call('GET', '/_sim/api/flow-runs?status=Waiting')).body.map((r) => r.id),
    [run.id],
  );
  const one = await call('GET', `/_sim/api/flow-runs/${run.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.journal, {
    Get_key: { status: 'Succeeded', secure: true },
    Create: { status: 'Succeeded', outputs: { statusCode: 201, body: { x_itemid: 'i1' } } },
  });
  for (const text of [list.text, one.text]) assert.ok(!/invented-input-secret|invented-secure-output/.test(text));
  assert.equal((await call('GET', '/_sim/api/flow-runs/unknown')).status, 404);
  const waits = await call('GET', '/_sim/api/flow-waits');
  assert.deepEqual(
    waits.body.map((w) => [w.runId, w.id, w.kind]),
    [[run.id, approvalId, 'approval']],
  );
  assert.equal((await call('GET', '/_sim/api/other')).status, 404, 'other admin routes are left to the next handler');
});

// @test-kind contract+security: answering a wait requires the CSRF token
test('answering a wait needs the CSRF token, records the response and schedules resumeRun', async (t) => {
  const resumed = [];
  const { call, scheduler, connectors, run, approvalId } = await fixture(t, {
    resumeRun: (id, outcome) => {
      resumed.push([id, outcome]);
    },
  });
  const path = `/_sim/api/flow-waits/${approvalId}`;
  assert.equal((await call('POST', path, { outcome: 'Approve' })).status, 403);
  assert.equal(connectors.approvals.get(approvalId).status, 'Pending');
  assert.equal((await call('POST', path, { outcome: 'maybe' }, { 'x-sim-csrf': CSRF })).status, 400);
  const answer = await call(
    'POST',
    path,
    { outcome: 'Approve', responder: 'a@example.test', comments: 'ok' },
    { 'x-sim-csrf': CSRF },
  );
  assert.equal(answer.status, 202);
  assert.deepEqual(answer.body, {
    runId: run.id,
    waitId: approvalId,
    kind: 'approval',
    scheduled: true,
    outcome: 'Approve',
  });
  assert.deepEqual(resumed, []);
  await scheduler.runDue();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0][0], run.id);
  assert.equal(resumed[0][1].status, 'Succeeded');
  assert.equal(resumed[0][1].outputs.body.outcome, 'Approve');
  assert.equal(
    (await call('POST', '/_sim/api/flow-waits/unknown', { outcome: 'Approve' }, { 'x-sim-csrf': CSRF })).status,
    404,
  );
});

test('without a host resumeRun answering a wait is 501 FlowResumeNotWired and changes nothing', async (t) => {
  const { call, connectors, approvalId } = await fixture(t);
  const answer = await call(
    'POST',
    `/_sim/api/flow-waits/${approvalId}`,
    { outcome: 'Approve' },
    { 'x-sim-csrf': CSRF },
  );
  assert.equal(answer.status, 501);
  assert.equal(answer.body.error.code, 'FlowResumeNotWired');
  assert.equal(connectors.approvals.get(approvalId).status, 'Pending');
});

// @test-kind contract+security: flow-run payloads redact cookie and authorization headers
test('flow-run payloads redact set-cookie and authorization headers that a connector journalled', async (t) => {
  const { call, flowRuns } = await fixture(t);
  const run = await flowRuns.start({ processId: FLOW });
  await flowRuns.journal(run.id, 'Call_service', {
    outputs: { headers: { 'set-cookie': 'invented-cookie', authorization: 'Bearer invented-bearer' } },
  });
  const one = await call('GET', `/_sim/api/flow-runs/${run.id}`);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body.journal.Call_service.outputs.headers, {
    'set-cookie': '[redacted]',
    authorization: '[redacted]',
  });
  assert.ok(!/invented-cookie|invented-bearer/.test(one.text));
  assert.ok(!/invented-cookie|invented-bearer/.test((await call('GET', '/_sim/api/flow-runs')).text));
});

// @test-kind contract+security: a missing simulator CSRF token fails closed
test('a missing simulator CSRF token fails closed: no header, or no token to compare with, is 403 and resumes nothing', async (t) => {
  const resumed = [];
  const { call, scheduler, connectors, approvalId } = await fixture(t, {
    csrf: () => undefined,
    resumeRun: (id) => {
      resumed.push(id);
    },
  });
  assert.equal((await call('POST', `/_sim/api/flow-waits/${approvalId}`, { outcome: 'Approve' })).status, 403);
  for (const token of ['undefined', ''])
    assert.equal(
      (await call('POST', `/_sim/api/flow-waits/${approvalId}`, { outcome: 'Approve' }, { 'x-sim-csrf': token }))
        .status,
      403,
      `header ${JSON.stringify(token)}`,
    );
  await scheduler.runDue();
  assert.deepEqual(resumed, []);
  assert.equal(connectors.approvals.get(approvalId).status, 'Pending');
});
