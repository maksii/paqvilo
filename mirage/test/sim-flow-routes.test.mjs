// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds, storeScheduler } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createFlowRunStore, createHostFlowRuns } from '../lib/flow-runs.mjs';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';
import { redactSecrets } from '../lib/sim-messaging-routes.mjs';
import { serveRoutes } from './support/route-server.mjs';
import { serveFlowRoutes } from './support/flow-fixtures.mjs';

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

// @test-kind security: free-text fields are redacted whatever their letter case, and callback signatures are kept
test('redactSecrets masks the free-text error message and body in any letter case and keeps a callback sig', () => {
  assert.deepEqual(
    redactSecrets({
      errorMessage: 'Authorization: Bearer abc.def and Server=x;Password=hunter2',
      Body: 'password=y',
      callbackUrl: 'https://h/p?sig=KEEP',
    }),
    {
      errorMessage: 'Authorization: [redacted] [redacted] and Server=x;Password=[redacted]',
      Body: 'password=[redacted]',
      callbackUrl: 'https://h/p?sig=KEEP',
    },
  );
});

// @test-kind security: a failed run's error message is redacted in the flow-run list and detail
test('a failed run error message is redacted in the flow-run list and detail', async (t) => {
  const { call, flowRuns } = await fixture(t);
  const run = await flowRuns.start({ processId: FLOW });
  await flowRuns.complete(run.id, {
    status: 'Failed',
    error: { code: 'FlowRunFailed', message: 'Authorization: Bearer abc.def and Server=x;Password=hunter2' },
  });
  const redacted = 'Authorization: [redacted] [redacted] and Server=x;Password=[redacted]';
  const listed = (await call('GET', '/_sim/api/flow-runs')).body.find((r) => r.id === run.id);
  assert.equal(listed.errorMessage, redacted);
  const one = await call('GET', `/_sim/api/flow-runs/${run.id}`);
  assert.equal(one.body.errorMessage, redacted);
  assert.ok(!/abc\.def|hunter2/.test(one.text));
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

test('the callback URL is built on the origin the host passes, not on the request Host header', async (t) => {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const definition = {
    triggers: { request: { type: 'Request', kind: 'Http', inputs: { method: 'POST' } } },
    actions: {},
  };
  const vault = { seal: (value) => value, open: (value) => value };
  const api = { store, flowRuns: { vault, flowOf: () => ({ definition, mode: 'exported' }) } };
  const routes = createFlowRoutes({ api, csrf: () => CSRF });
  const server = http.createServer(async (req, res) => {
    // The host's public origin for this listener; the Host header is the caller's and must not decide the URL.
    const url = new URL(req.url, 'http://127.0.0.1:5');
    if (!(await routes(req, res, url))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method: 'POST',
        path: `/_sim/api/flow-triggers/${FLOW}/callback-url`,
        headers: { host: '127.0.0.1:9', 'x-sim-csrf': CSRF },
      },
      (reply) => {
        let text = '';
        reply.setEncoding('utf8');
        reply.on('data', (chunk) => (text += chunk));
        reply.on('end', () => resolve({ status: reply.statusCode, body: JSON.parse(text) }));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(response.status, 200);
  assert.ok(response.body.url.startsWith('http://127.0.0.1:5/'), response.body.url);
});

// The signed callback URL of an HTTP Request trigger, served over a real listener. Returns a poster for that URL.
async function signedHttpTrigger(t, { schema, operationOptions }) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  storeScheduler(store, scheduler);
  t.after(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock });
  const trigger = { type: 'Request', kind: 'Http', inputs: { method: 'POST', schema } };
  if (operationOptions) trigger.operationOptions = operationOptions;
  const definition = {
    triggers: { request: trigger },
    actions: {
      Reply: {
        type: 'Response',
        runAfter: {},
        inputs: { statusCode: 200, body: { hello: "@triggerBody()?['x_name']" } },
      },
    },
  };
  const api = { store, providers: { connectors } };
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    flowOf: () => ({ definition, mode: 'exported', connectors }),
  });
  runs.attach(api);
  t.after(() => runs.close());
  const routes = createFlowRoutes({ api, csrf: () => CSRF });
  const origin = await serveFlowRoutes(t, routes);
  const issued = await fetch(`${origin}/_sim/api/flow-triggers/${FLOW}/callback-url`, {
    method: 'POST',
    headers: { 'x-sim-csrf': CSRF },
  });
  const { url } = await issued.json();
  return async (body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

test('an HTTP Request trigger checks its signed callback body against the schema only with EnableSchemaValidation', async (t) => {
  const schema = { type: 'object', required: ['x_name'], properties: { x_name: { type: 'string' } } };
  const post = await signedHttpTrigger(t, { schema });
  assert.deepEqual(
    await post({}),
    { status: 200, body: { hello: null } },
    'without the option the body is not checked',
  );
  const checked = await signedHttpTrigger(t, { schema, operationOptions: 'EnableSchemaValidation' });
  const refused = await checked({});
  assert.deepEqual([refused.status, refused.body.error.code], [400, 'InvalidRequest']);
});

test('an unsupported schema is refused on the signed callback even without EnableSchemaValidation', async (t) => {
  const post = await signedHttpTrigger(t, { schema: { type: 'banana' } });
  const refused = await post({ x_name: 'invented' });
  assert.deepEqual([refused.status, refused.body.error.code], [400, 'InvalidRequest']);
});

// A run suspended on an approval of the given type, assigned to two invented assignees. `waitExtra` joins the wait.
async function suspendApproval({ flowRuns, connectors }, parameters = {}, waitExtra = {}) {
  const run = await flowRuns.start({ processId: FLOW });
  const started = await connectors.invoke({
    connectorId: 'shared_approvals',
    operationId: 'StartAndWaitForAnApproval',
    context: { canSuspend: true, runId: run.id },
    parameters: {
      'WebhookApprovalCreationInput/title': 'Invented approval',
      'WebhookApprovalCreationInput/assignedTo': 'a@example.test; b@example.test',
      ...parameters,
    },
  });
  await flowRuns.suspend(run.id, { actionPath: 'Approve', wait: { ...started.suspended, ...waitExtra } });
  return { runId: run.id, approvalId: started.suspended.id };
}
const feedWait = async (call, id) => (await call('GET', '/_sim/api/flow-waits')).body.find((w) => w.id === id);
const ASSIGNEES = ['a@example.test', 'b@example.test'];

test('the waits feed lists the approval of each type with its options, assignees, awaiting and requireAll', async (t) => {
  const { call, connectors, flowRuns } = await fixture(t);
  const cases = [
    { type: 'Basic', extra: {}, options: ['Approve', 'Reject'], requireAll: false },
    { type: 'AwaitAll', extra: {}, options: ['Approve', 'Reject'], requireAll: true },
    {
      type: 'Custom',
      extra: { 'WebhookApprovalCreationInput/responseOptions': 'Accept; Decline' },
      options: ['Accept', 'Decline'],
      requireAll: false,
    },
    {
      type: 'CustomAwaitAll',
      extra: { 'WebhookApprovalCreationInput/responseOptions': 'Accept; Decline' },
      options: ['Accept', 'Decline'],
      requireAll: true,
    },
  ];
  for (const item of cases) {
    const { approvalId } = await suspendApproval({ flowRuns, connectors }, { approvalType: item.type, ...item.extra });
    const wait = await feedWait(call, approvalId);
    assert.equal(wait.kind, 'approval');
    assert.deepEqual(wait.approval, {
      type: item.type,
      title: 'Invented approval',
      options: item.options,
      assignees: ASSIGNEES,
      responses: [],
      awaiting: ASSIGNEES,
      requireAll: item.requireAll,
    });
  }
});

test('one response to a wait-for-all approval is listed with its responder and no longer awaited', async (t) => {
  const { call, connectors, flowRuns } = await fixture(t);
  const { approvalId } = await suspendApproval({ flowRuns, connectors }, { approvalType: 'AwaitAll' });
  await connectors.approvals.respond(approvalId, {
    outcome: 'Approve',
    responder: 'a@example.test',
    comments: 'Looks right',
  });
  const { approval } = await feedWait(call, approvalId);
  const responseDate = connectors.approvals.get(approvalId).responses[0].responseDate;
  assert.deepEqual(approval.responses, [
    { responder: 'a@example.test', response: 'Approve', comments: 'Looks right', at: responseDate },
  ]);
  assert.deepEqual(approval.awaiting, ['b@example.test']);
  assert.equal(approval.requireAll, true);
});

test('a wait whose approval no longer exists is listed without the approval block', async (t) => {
  const { call, flowRuns } = await fixture(t);
  const run = await flowRuns.start({ processId: FLOW });
  await flowRuns.suspend(run.id, { actionPath: 'Approve', wait: { kind: 'approval', id: 'no-such-approval' } });
  const wait = await feedWait(call, 'no-such-approval');
  assert.equal(wait.runId, run.id);
  assert.equal(Object.hasOwn(wait, 'approval'), false);
});

test('a secure approval wait lists options and assignees but keeps the response comments back', async (t) => {
  const { call, connectors, flowRuns } = await fixture(t);
  const { approvalId } = await suspendApproval(
    { flowRuns, connectors },
    { approvalType: 'AwaitAll' },
    { secure: true },
  );
  await connectors.approvals.respond(approvalId, {
    outcome: 'Reject',
    responder: 'a@example.test',
    comments: 'invented-secret-comment',
  });
  const wait = await feedWait(call, approvalId);
  assert.deepEqual(wait.approval.options, ['Approve', 'Reject']);
  assert.deepEqual(wait.approval.assignees, ASSIGNEES);
  assert.equal(wait.approval.responses.length, 1);
  assert.equal(Object.hasOwn(wait.approval.responses[0], 'comments'), false);
  assert.equal(wait.approval.responses[0].response, 'Reject');
  assert.ok(!JSON.stringify(wait).includes('invented-secret-comment'));
});
