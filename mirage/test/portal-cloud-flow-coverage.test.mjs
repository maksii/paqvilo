// @test-kind compatibility: the Power Pages cloud flow API contract of https://learn.microsoft.com/power-pages/configure/cloud-flow-integration (POST /_api/cloudflow/v1.0/trigger/<guid>, 202 without a Response action, 200 with its body, eventData parameters, CSRF token, web roles); tests that model undocumented behaviour carry their own kind
// OPS-02c coverage: each documented behaviour of a Power Pages request flow, end to end over an invented site and Solution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { operationSimulator } from './operation-fixture.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { awaitPortalFlowResponse, powerPagesFlowAnswer, runExportedCloudFlow } from '../lib/exported-operations.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const ROLE = 'c1000000-0000-4000-8000-000000000001';
const ECHO = 'c1000000-0000-4000-8000-000000000002';
const SILENT = 'c1000000-0000-4000-8000-000000000003';
const WAITING = 'c1000000-0000-4000-8000-000000000004';
const trigger = {
  type: 'Request',
  kind: 'powerpages',
  inputs: {
    schema: {
      type: 'object',
      properties: { Location: { type: 'string' }, Count: { type: 'number' }, Urgent: { type: 'boolean' } },
    },
  },
};
const FLOWS = {
  [ECHO]: {
    name: 'Echo',
    definition: {
      triggers: { manual: trigger },
      actions: {
        reply: {
          type: 'Response',
          kind: 'powerpages',
          inputs: {
            statusCode: 200,
            body: {
              location: "@triggerBody()?['Location']",
              count: "@triggerBody()?['Count']",
              urgent: "@triggerBody()?['Urgent']",
            },
          },
        },
      },
    },
  },
  [SILENT]: {
    name: 'Silent',
    definition: { triggers: { manual: trigger }, actions: { done: { type: 'Compose', inputs: 'Executed' } } },
  },
  [WAITING]: {
    name: 'Waiting',
    definition: {
      triggers: { manual: trigger },
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } },
        reply: {
          type: 'Response',
          kind: 'powerpages',
          runAfter: { pause: ['Succeeded'] },
          inputs: { statusCode: 200, body: { waited: true } },
        },
      },
    },
  },
};

async function site(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-flow-coverage-')));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Invented flows',
    'portal/Runner.webrole.yml': `adx_webroleid: ${ROLE}\nadx_name: Runner`,
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName><Version>1.0</Version></SolutionManifest></ImportExportXml>',
  };
  for (const [id, { name, definition }] of Object.entries(FLOWS)) {
    files[`portal/${name}.cloudflowconsumer.yml`] =
      `adx_cloudflowconsumerid: ${name.toLowerCase()}\nadx_name: ${name}\nadx_processid: ${id}\nadx_flowapiurl: /_api/cloudflow/v1.0/trigger/${id}\nadx_cloudflowconsumer_adx_webrole:\n- ${ROLE}`;
    files[`solution/Workflows/${name}.json`] = JSON.stringify({ properties: { definition } });
    files[`solution/Workflows/${name}.json.data.xml`] =
      `<Workflow WorkflowId="{${id}}" Name="${name}"><StateCode>1</StateCode></Workflow>`;
  }
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await operationSimulator(t, dir);
  // shell.ajaxSafePost sends the token header and jQuery's X-Requested-With.
  const post = (id, body, { token = app.csrf, type = 'application/json', ajax = true } = {}) =>
    fetch(`${app.url}/_api/cloudflow/v1.0/trigger/${id}`, {
      method: 'POST',
      headers: {
        'content-type': type,
        ...(token ? { __RequestVerificationToken: token } : {}),
        ...(ajax ? { 'x-requested-with': 'XMLHttpRequest' } : {}),
      },
      body,
    });
  const runs = (id) => app.store.tableRows('flowrun').filter((row) => String(row.workflowid).toLowerCase() === id);
  return { app, post, runs };
}
const event = (values) => JSON.stringify({ eventData: JSON.stringify(values) });

// @test-kind observation: hosted session F8 envelope and outcomes groups (paqvilo-developer hosted-f8 summary-F8.md, two runs): a 200 Response body is sent as text/html JSON text, a flow without a Response answers 202 {"ErrorCode":"0000000B","Message":"Default"}
test('a flow with a Response answers 200 with its body; one without answers 202 Default', async (t) => {
  const { post } = await site(t);
  const replied = await post(ECHO, event({ Location: 'Invented town', Count: 3, Urgent: true }));
  assert.equal(replied.status, 200, await replied.clone().text());
  assert.equal(replied.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.deepEqual(JSON.parse(await replied.text()), { location: 'Invented town', count: 3, urgent: true });
  const silent = await post(SILENT, event({}));
  assert.equal(silent.status, 202);
  assert.deepEqual(await silent.json(), { ErrorCode: '0000000B', Message: 'Default' });
});

// @test-kind observation: hosted session F8 envelope group (paqvilo-developer hosted-f8 summary-F8.md, two runs): the eventData string, JSON or form-encoded as shell.ajaxSafePost sends it, carries the parameters; raw JSON without eventData runs the flow, which fails at its Response (400 upstream message)
test('parameters arrive as the eventData JSON string, JSON or form-encoded as shell.ajaxSafePost sends them', async (t) => {
  const { post } = await site(t);
  const expected = { location: 'Invented town', count: 2, urgent: false };
  const values = { Location: 'Invented town', Count: 2, Urgent: false };
  for (const [body, type] of [
    [event(values), 'application/json'],
    [new URLSearchParams({ eventData: JSON.stringify(values) }).toString(), 'application/x-www-form-urlencoded'],
  ]) {
    const response = await post(ECHO, body, { type });
    assert.equal(response.status, 200, type);
    assert.deepEqual(JSON.parse(await response.text()), expected, body);
  }
  const direct = await post(ECHO, JSON.stringify(values));
  assert.equal(direct.status, 400);
  assert.match((await direct.json()).Message, /^The server did not receive a response from an upstream server\./);
  // A flow without a Response answers whatever the body is.
  assert.equal((await post(SILENT, '')).status, 202);
});

// @test-kind security: the flow API requires the page's CSRF token, X-Requested-With and a web role the flow is added to; a refused request starts no run (refusal shapes: hosted session F8 envelope and roles groups)
test('a request without the CSRF token or X-Requested-With, or from an identity without the flow role, does not run the flow', async (t) => {
  const { app, post, runs } = await site(t);
  const body = event({ Location: 'Invented town' });
  for (const [label, response] of [
    ['missing token', await post(ECHO, body, { token: null })],
    ['forged token', await post(ECHO, body, { token: 'invented-token' })],
    ['no X-Requested-With', await post(ECHO, body, { ajax: false })],
  ]) {
    assert.equal(response.status, 500, label);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', label);
  }
  const changed = await fetch(`${app.url}/__sim/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ identity: { id: 'person', roles: [], roleSource: 'override' } }),
  });
  assert.equal(changed.status, 200, await changed.text());
  const refused = await post(ECHO, body);
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { ErrorCode: '00000003', Message: 'MissingPermissions' });
  assert.equal(runs(ECHO).length, 0, 'no refused request started a run');
});

// A run store on a manual scheduler, and one request to the Waiting flow through runExportedCloudFlow.
async function heldRun(t, minutes = 1, { diagnostic } = {}) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  ownedFixture(t).add(() => scheduler.close());
  const definition = structuredClone(FLOWS[WAITING].definition);
  definition.actions.pause.inputs.interval.count = minutes;
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    flowOf: (id) => (id === WAITING ? { definition, mode: 'exported' } : null),
    ...(diagnostic ? { diagnostic } : {}),
  });
  runs.attach({});
  ownedFixture(t).add(() => runs.close());
  const workflows = new Map([[WAITING, { name: 'Waiting', definition: { properties: { definition } } }]]);
  const answer = await runExportedCloudFlow({
    record: { processId: WAITING, name: 'Waiting' },
    workflows,
    input: {},
    store,
  });
  return { store, scheduler, runs, answer };
}

// @test-kind observation: hosted session F8 delay group (paqvilo-developer hosted-f8 summary-F8.md, two runs): a flow that waits 5, 60, 100 or 110 s before its Response answers the held request with that Response
test('a request whose run waits before its Response is answered with that Response when the run resumes', async (t) => {
  const { store, scheduler, runs, answer } = await heldRun(t);
  assert.equal(answer.status, 202);
  assert.equal(runs.get(answer.held).status, 'Waiting');
  let settled = null;
  const held = awaitPortalFlowResponse(store, answer).then((value) => (settled = value));
  await scheduler.advance(59_999);
  assert.equal(settled, null, 'still held while the run waits');
  await scheduler.advance(1);
  await held;
  assert.equal(settled.status, 200);
  assert.deepEqual(settled.body, { waited: true });
  assert.equal(runs.get(answer.held).status, 'Succeeded');
});

// @test-kind observation: hosted session F8 delay group and its flow-run rows (paqvilo-developer hosted-f8 summary-F8.md, two runs): 120 s after the request arrived the caller gets 400 {"ErrorCode":"IncorrectPayload","Message":"BadGateway"}; the run continues, its Response action then fails and the run ends Failed
test('a run that does not answer within 120 seconds of the request times it out; its later Response fails the run', async (t) => {
  const { store, scheduler, runs, answer } = await heldRun(t, 5);
  let failure = null;
  const held = awaitPortalFlowResponse(store, answer).catch((error) => (failure = error));
  await scheduler.advance(119_999);
  assert.equal(failure, null, 'still held inside the limit');
  await scheduler.advance(1);
  await held;
  assert.deepEqual([failure.status, failure.code], [504, 'ResponseTimeout']);
  assert.deepEqual(powerPagesFlowAnswer({ error: failure, runId: answer.held }), {
    status: 400,
    error: { ErrorCode: 'IncorrectPayload', Message: 'BadGateway' },
  });
  assert.equal(runs.get(answer.held).status, 'Waiting', 'the run continues after the request timed out');
  await scheduler.advance(180_000);
  const run = runs.get(answer.held);
  assert.equal(run.status, 'Failed', 'the Response after the limit fails the run');
  assert.deepEqual(
    [run.errorCode, run.errorMessage],
    ['ActionFailed', 'An action failed. No dependent actions succeeded.'],
  );
});

// @test-kind observation: hosted session F8 delay group and its flow-run rows (paqvilo-developer hosted-f8 summary-F8.md, two runs): a Response after the 120 s fails the run with ActionFailed; the caller's timeout is kept with the run, so a resume after a restart (a new run store over the saved state, its timers re-armed) fails it too
test('a run whose request timed out still fails its Response when it resumes after a restart', async (t) => {
  const { store, scheduler, runs, answer } = await heldRun(t, 5);
  const held = awaitPortalFlowResponse(store, answer).catch((error) => error);
  await scheduler.advance(120_000);
  assert.equal((await held).code, 'ResponseTimeout');
  runs.close();
  scheduler.close();
  // The restart: the saved state in a new store, a new scheduler on the same clock, a new host run store.
  const restarted = await new DataStore({
    state: structuredClone(store.state),
    clock: store.clock,
    ids: sequentialIds(),
  }).init();
  const nextScheduler = createScheduler({ clock: store.clock, manual: true });
  ownedFixture(t).add(() => nextScheduler.close());
  const definition = structuredClone(FLOWS[WAITING].definition);
  definition.actions.pause.inputs.interval.count = 5;
  const nextRuns = createHostFlowRuns({
    store: restarted,
    clock: store.clock,
    scheduler: nextScheduler,
    flowOf: (id) => (id === WAITING ? { definition, mode: 'exported' } : null),
  });
  nextRuns.attach({});
  ownedFixture(t).add(() => nextRuns.close());
  assert.equal(nextRuns.get(answer.held).status, 'Waiting');
  await nextScheduler.advance(180_000);
  const run = nextRuns.get(answer.held);
  assert.deepEqual([run.status, run.errorCode], ['Failed', 'ActionFailed']);
});

// @test-kind observation: hosted session F8 delay group (paqvilo-developer hosted-f8 summary-F8.md): the 120 s are measured from the request's arrival (run a's 115 s wait timed out at 120.1 s when its flow started about 5 s late)
test('the 120 seconds count from the request arrival, not from the run start', async (t) => {
  const { store, scheduler, answer } = await heldRun(t);
  let failure = null;
  const requestedAt = +store.clock.now() - 75_000;
  const held = awaitPortalFlowResponse(store, answer, { requestedAt }).catch((error) => (failure = error));
  await scheduler.advance(44_999);
  assert.equal(failure, null);
  await scheduler.advance(1);
  await held;
  assert.equal(failure?.code, 'ResponseTimeout', 'the wait of 60 s outlasts the 45 s left');
});

// @test-kind contract: the timed-out request's close mark is written outside the request: a failed write is reported as FLOW_RUN_RESPONSE_CLOSE_FAILED and the request still times out, and a failure of that report fails the held request instead of leaving it unanswered
test('a failed close of a timed-out Response is reported, and a failing report fails the held request', async (t) => {
  const failCloseWrite = (store) => {
    const transact = store.transact;
    store.transact = function () {
      store.transact = transact;
      return Promise.reject(Object.assign(new Error('invented write failure'), { code: 'InventedWriteFailure' }));
    };
  };
  const reported = [];
  const first = await heldRun(t, 5, { diagnostic: (entry) => reported.push(entry) });
  const timedOut = awaitPortalFlowResponse(first.store, first.answer).catch((error) => error);
  failCloseWrite(first.store);
  await first.scheduler.advance(120_000);
  assert.equal((await timedOut).code, 'ResponseTimeout');
  assert.deepEqual(
    reported.map(({ code, runId, error }) => [code, runId, error.code, error.message]),
    [['FLOW_RUN_RESPONSE_CLOSE_FAILED', first.answer.held, 'InventedWriteFailure', 'invented write failure']],
  );

  const reportFailure = new Error('invented diagnostic failure');
  const second = await heldRun(t, 5, {
    diagnostic: () => {
      throw reportFailure;
    },
  });
  const failed = awaitPortalFlowResponse(second.store, second.answer).catch((error) => error);
  failCloseWrite(second.store);
  await second.scheduler.advance(120_000);
  assert.equal(await failed, reportFailure);
});

// @test-kind unproven: a held request of a run that is cancelled answers the cancellation (local 409 FlowRunCancelled, as an unanswered cancelled run does)
test('a held request answers the cancellation of its run', async (t) => {
  const { store, runs, answer } = await heldRun(t);
  const held = awaitPortalFlowResponse(store, answer);
  assert.equal(await runs.cancel(answer.held), true);
  await assert.rejects(held, (error) => error.status === 409 && error.code === 'FlowRunCancelled');
});

// @test-kind contract: without a host run store (an untracked run) the waiting answer is passed through unchanged
test('an answer that is not held, or a store without runs, passes through', async () => {
  const store = await new DataStore({ state: emptyState(), clock: fixedClock(), ids: sequentialIds() }).init();
  const answer = { status: 202, body: { runId: 'invented', status: 'Waiting' }, held: 'invented' };
  assert.equal(await awaitPortalFlowResponse(store, answer), answer);
  assert.deepEqual(await awaitPortalFlowResponse(store, { status: 200, body: {} }), { status: 200, body: {} });
});
