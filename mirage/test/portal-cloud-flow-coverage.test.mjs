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
import { awaitPortalFlowResponse, runExportedCloudFlow } from '../lib/exported-operations.mjs';
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
    files[`solution/Workflows/${name}.json.data.xml`] = `<Workflow WorkflowId="{${id}}" Name="${name}"/>`;
  }
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const app = await operationSimulator(t, dir);
  const post = (id, body, { token = app.csrf, type = 'application/json' } = {}) =>
    fetch(`${app.url}/_api/cloudflow/v1.0/trigger/${id}`, {
      method: 'POST',
      headers: { 'content-type': type, ...(token ? { __RequestVerificationToken: token } : {}) },
      body,
    });
  return { app, post };
}

test('a flow with a Response answers 200 with its body; one without answers an empty 202', async (t) => {
  const { post } = await site(t);
  const replied = await post(ECHO, JSON.stringify({ Location: 'Invented town', Count: 3, Urgent: true }));
  assert.equal(replied.status, 200);
  assert.match(replied.headers.get('content-type'), /^application\/json/);
  assert.deepEqual(await replied.json(), { location: 'Invented town', count: 3, urgent: true });
  const silent = await post(SILENT, '{}');
  assert.equal(silent.status, 202);
  assert.equal(await silent.text(), '');
});

test('parameters arrive by name, directly, as the eventData JSON string, and form-encoded as shell.ajaxSafePost sends them', async (t) => {
  const { post } = await site(t);
  const expected = { location: 'Invented town', count: 2, urgent: false };
  const values = { Location: 'Invented town', Count: 2, Urgent: false };
  for (const [body, type] of [
    [JSON.stringify(values), 'application/json'],
    [JSON.stringify({ eventData: JSON.stringify(values) }), 'application/json'],
    [new URLSearchParams({ eventData: JSON.stringify(values) }).toString(), 'application/x-www-form-urlencoded'],
  ]) {
    const response = await post(ECHO, body, { type });
    assert.equal(response.status, 200, type);
    assert.deepEqual(await response.json(), expected, body);
  }
  // "If no input parameter is defined in the trigger, pass an empty payload in the request."
  assert.equal((await post(SILENT, '')).status, 202);
});

// @test-kind security: the flow API requires the page's CSRF token and a web role the flow is added to
test('a request without the CSRF token, or from an identity without the flow role, does not run the flow', async (t) => {
  const { app, post } = await site(t);
  const missing = await post(ECHO, '{}', { token: null });
  assert.ok([400, 401, 403].includes(missing.status), String(missing.status));
  const forged = await post(ECHO, '{}', { token: 'invented-token' });
  assert.ok([400, 401, 403].includes(forged.status), String(forged.status));
  const changed = await fetch(`${app.url}/__sim/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
    body: JSON.stringify({ identity: { id: 'person', roles: [], roleSource: 'override' } }),
  });
  assert.equal(changed.status, 200, await changed.text());
  assert.equal((await post(ECHO, '{}')).status, 403);
});

// A run store on a manual scheduler, and one request to the Waiting flow through runExportedCloudFlow.
async function heldRun(t, minutes = 1) {
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

// @test-kind unproven: a Power Pages request whose run waits before its Response is held for that Response within Power Automate's 120 s inbound request limit (https://learn.microsoft.com/power-automate/limits-and-config#timeout); the hosted Power Pages answer of a held request is not captured
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

// @test-kind unproven: past the 120 s inbound request limit the request answers 504 ResponseTimeout (the code of the documented Power Apps flow timeout, https://learn.microsoft.com/troubleshoot/power-platform/power-apps/connections/best-practices-when-updating-a-flow) and the run continues; the hosted Power Pages status and body are not captured
test('a run that does not answer within 120 seconds times the request out and keeps running', async (t) => {
  const { store, scheduler, runs, answer } = await heldRun(t, 5);
  let failure = null;
  const held = awaitPortalFlowResponse(store, answer).catch((error) => (failure = error));
  await scheduler.advance(119_999);
  assert.equal(failure, null, 'still held inside the limit');
  await scheduler.advance(1);
  await held;
  assert.equal(failure.status, 504);
  assert.equal(failure.code, 'ResponseTimeout');
  assert.equal(runs.get(answer.held).status, 'Waiting', 'the run continues after the request timed out');
  await scheduler.advance(180_000);
  assert.equal(runs.get(answer.held).status, 'Succeeded');
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
