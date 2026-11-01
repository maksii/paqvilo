// Flow run lifecycle (flow-runtime.mjs runTrackedFlow, flow-runs.mjs createHostFlowRuns): approval waits answered through
// /_sim/api/flow-waits on a standalone runtime, delay and timeout waits on a manual scheduler, restart re-arming from the state
// file, secure outputs, connector retry policies, child flows and CancelAllCloudFlowRuns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns, flowRunsOf } from '../lib/flow-runs.mjs';
import { runTrackedFlow } from '../lib/flow-runtime.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { whenScheduled } from './support/scheduler-gates.mjs';

const FLOW = '77777777-7777-4777-8777-0000000000f1';
const CHILD = '77777777-7777-4777-8777-0000000000f2';
const CLIENT = '77777777-7777-4777-8777-0000000000f3';
const manual = { manual: { type: 'Request', kind: 'Button', inputs: { schema: { type: 'object' } } } };
const approvals = '/providers/Microsoft.PowerApps/apis/shared_approvals';
const approve = {
  type: 'OpenApiConnectionWebhook',
  inputs: {
    host: { apiId: approvals, operationId: 'StartAndWaitForAnApproval' },
    parameters: {
      approvalType: 'Basic',
      'WebhookApprovalCreationInput/title': 'Invented approval',
      'WebhookApprovalCreationInput/assignedTo': 'approver@example.test',
    },
  },
};
const reply = (after, body, statuses = ['Succeeded']) => ({
  type: 'Response',
  runAfter: { [after]: statuses },
  inputs: { statusCode: 200, body },
});

// A DataStore on a fixed clock and a manual scheduler with the host run store attached; flows maps process ids to definitions.
async function unit(t, flows = {}, { file = null, clock = fixedClock(), packs = [] } = {}) {
  const store = await new DataStore({ file, state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  ownedFixture(t).add(() => scheduler.close());
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs });
  const notes = [];
  const flowOf = (id) => (flows[id] ? { definition: flows[id], mode: 'exported', connectors } : null);
  const runs = createHostFlowRuns({
    store,
    clock,
    scheduler,
    diagnostic: (note) => notes.push(note),
    approvals: connectors.approvals,
    flowOf,
  });
  runs.attach({});
  ownedFixture(t).add(() => runs.close());
  const start = (id, input = {}, context = {}) =>
    runTrackedFlow({ runs, processId: id, trigger: 'Test', definition: flows[id], input, store, connectors, context });
  return { store, clock, scheduler, connectors, runs, notes, start };
}

test('a Wait delay suspends the run and the manual scheduler resumes it to Succeeded', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 5, unit: 'Minute' } } },
        done: reply('pause', { ok: true }),
      },
    },
  };
  const { runs, scheduler, clock, start } = await unit(t, flows);
  const waiting = await start(FLOW);
  assert.equal(waiting.status, 'Waiting');
  const run = runs.get(waiting.runId);
  assert.equal(run.status, 'Waiting');
  assert.deepEqual(
    [run.wait.kind, run.wait.actionPath, run.wait.until],
    ['delay', 'pause', new Date(clock.now() + 300000).toISOString()],
  );
  await scheduler.advance(299999);
  assert.equal(runs.get(waiting.runId).status, 'Waiting', 'not due yet');
  await scheduler.advance(1);
  assert.equal(runs.get(waiting.runId).status, 'Succeeded');
  assert.deepEqual(runs.get(waiting.runId).journal.pause, { status: 'Succeeded', outputs: {} });
});

test('an approval wait timeout resumes with TimedOut and the runAfter TimedOut branch runs', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        approve,
        late: { type: 'Compose', runAfter: { approve: ['TimedOut'] }, inputs: 'expired' },
        done: reply('late', "@outputs('late')"),
      },
    },
  };
  const { runs, scheduler, connectors, start } = await unit(t, flows);
  const waiting = await start(FLOW, {}, { waitTimeoutMs: 60000 });
  assert.equal(waiting.suspended.wait.kind, 'approval');
  await scheduler.advance(60000);
  const run = runs.get(waiting.runId);
  assert.equal(run.status, 'Succeeded');
  assert.equal(run.journal.approve.status, 'TimedOut');
  assert.equal(connectors.approvals.get(waiting.suspended.wait.id).status, 'TimedOut');
});

test('after a restart rearm() schedules the recorded wait again and the replay runs from the state file', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'flow-run-lifecycle-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        note: { type: 'Compose', inputs: "@triggerBody()?['name']" },
        pause: { type: 'Wait', runAfter: { note: ['Succeeded'] }, inputs: { interval: { count: 1, unit: 'Hour' } } },
        done: reply('pause', "@outputs('note')"),
      },
    },
  };
  const first = await unit(t, flows, { file });
  const waiting = await first.start(FLOW, { name: 'Invented' });
  first.runs.close();
  first.scheduler.close();
  const second = await unit(t, flows, { file, clock: fixedClock(first.clock.now()) });
  assert.equal(second.runs.get(waiting.runId).status, 'Waiting', 'the run and its wait come back from the state file');
  assert.equal(
    second.scheduler.pending().filter((task) => task.name === 'flow-run-wait').length,
    1,
    'attach re-armed the wait timer',
  );
  await second.scheduler.advance(3600000);
  assert.equal(second.runs.get(waiting.runId).status, 'Succeeded');
});

test('a secure output is never written to state and the run resumes from process memory when its wait ends', async (t) => {
  const pack = {
    id: 'invented',
    connectors: {
      shared_x_invented: {
        operations: { Issue: () => ({ statusCode: 200, body: { token: 'invented-secret-token' } }) },
      },
    },
  };
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        issue: {
          type: 'OpenApiConnection',
          runtimeConfiguration: { secureData: { properties: ['outputs'] } },
          inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_x_invented', operationId: 'Issue' } },
        },
        pause: { type: 'Wait', runAfter: { issue: ['Succeeded'] }, inputs: { interval: { count: 1, unit: 'Minute' } } },
        done: reply('pause', "@body('issue')"),
      },
    },
  };
  const { runs, scheduler, store, start } = await unit(t, flows, { packs: [pack] });
  const waiting = await start(FLOW);
  assert.deepEqual(runs.get(waiting.runId).journal.issue, { status: 'Succeeded', secure: true });
  assert.ok(!JSON.stringify(store.state).includes('invented-secret-token'), 'the secure output is not in state');
  await scheduler.advance(60000);
  assert.equal(runs.get(waiting.runId).status, 'Succeeded');
  assert.ok(!JSON.stringify(store.state).includes('invented-secret-token'), 'still not in state after the resume');
});

// A secure Workflow action waiting on its child never stores the child's answer.
test('a secure child flow answer is never written to state while the parent waits or after it resumes', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        child: {
          type: 'Workflow',
          runtimeConfiguration: { secureData: { properties: ['outputs'] } },
          inputs: { host: { workflowReferenceName: CHILD }, body: {} },
        },
        done: reply('child', {}),
      },
    },
    [CHILD]: {
      triggers: manual,
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } },
        done: reply('pause', { token: 'invented-child-token' }),
      },
    },
  };
  const { runs, scheduler, store, start } = await unit(t, flows);
  const answer = await start(FLOW);
  assert.equal(runs.get(answer.runId).wait.secure, true);
  await scheduler.advance(60000);
  assert.equal(runs.get(answer.runId).status, 'Succeeded');
  assert.deepEqual(runs.get(answer.runId).journal.child, { status: 'Succeeded', secure: true });
  assert.ok(!JSON.stringify(store.state).includes('invented-child-token'));
});

test('a retry policy retries an http provider answering 503 twice and journals the three attempts', async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.writeHead(calls < 3 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ calls }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(() => new Promise((resolve) => server.close(resolve)));
  const uri = `http://127.0.0.1:${server.address().port}/invented`;
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        call: {
          type: 'Http',
          inputs: { method: 'GET', uri, retryPolicy: { type: 'fixed', count: 3, interval: 'PT10S' } },
        },
        done: reply('call', "@body('call')"),
      },
    },
  };
  const { runs, scheduler, start } = await unit(t, flows);
  let retry = whenScheduled(scheduler, 'connector-retry');
  const pending = start(FLOW);
  // Each 503 queues a PT10S retry pause on the manual scheduler (never a real sleep): advance once it is queued.
  for (let i = 0; i < 2; i++) {
    await retry;
    retry = whenScheduled(scheduler, 'connector-retry');
    await scheduler.advance(10000);
  }
  const answer = await pending;
  assert.deepEqual(answer.body, { calls: 3 });
  const [run] = runs.list({ processId: FLOW });
  assert.equal(run.status, 'Succeeded');
  assert.deepEqual(runs.get(run.id).journal.call.attempts, [
    { attempt: 1, statusCode: 503 },
    { attempt: 2, statusCode: 503 },
    { attempt: 3, statusCode: 200 },
  ]);
});

test('a retry policy on a built-in action is a 400 InvalidRequest and an invalid policy is refused', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        make: { type: 'Compose', inputs: { retryPolicy: { type: 'fixed', count: 1, interval: 'PT1S' } } },
        done: reply('make', {}),
      },
    },
    [CHILD]: {
      triggers: manual,
      actions: {
        call: {
          type: 'Http',
          inputs: {
            method: 'GET',
            uri: 'http://127.0.0.1:9/',
            retryPolicy: { type: 'fixed', count: 9, interval: 'PT1S' },
          },
        },
        done: reply('call', {}),
      },
    },
  };
  const { start } = await unit(t, flows);
  await assert.rejects(start(FLOW), {
    status: 400,
    code: 'InvalidRequest',
    message: /not allowed on built-in action make/,
  });
  await assert.rejects(start(CHILD), {
    status: 400,
    code: 'InvalidRequest',
    message: /count must be an integer from 1 to 4/,
  });
});

test('a Workflow action runs the child flow as its own run and a recursive child stops at depth 16', async (t) => {
  const child = {
    type: 'Workflow',
    inputs: { host: { workflowReferenceName: CHILD }, body: { name: "@triggerBody()?['name']" } },
  };
  const flows = {
    [FLOW]: { triggers: manual, actions: { child, done: reply('child', "@body('child')") } },
    [CHILD]: {
      triggers: manual,
      actions: {
        done: { type: 'Response', inputs: { statusCode: 200, body: { greeting: "Hello @{triggerBody()?['name']}" } } },
      },
    },
  };
  const { runs, start } = await unit(t, flows);
  const answer = await start(FLOW, { name: 'Invented' });
  assert.deepEqual(answer.body, { greeting: 'Hello Invented' });
  assert.deepEqual(
    runs
      .list()
      .map((run) => [run.processId, run.triggertype, run.status])
      .sort(),
    [
      [FLOW, 'Test', 'Succeeded'],
      [CHILD, 'ChildFlow', 'Succeeded'],
    ].sort(),
  );

  const recursive = {
    [FLOW]: {
      triggers: manual,
      actions: {
        child: { type: 'Workflow', inputs: { host: { workflowReferenceName: FLOW }, body: {} } },
        done: reply('child', "@outputs('child')", ['Succeeded', 'Failed']),
      },
    },
  };
  const deep = await unit(t, recursive);
  const result = await deep.start(FLOW);
  assert.match(JSON.stringify(result.body), /ChildFlowDepthExceeded/);
  assert.equal(deep.runs.list().length, 17, 'the top run and sixteen nested child runs');
});

// The parent waits on its waiting child (wait kind child, ownership recorded) and the child's completion resumes it.
test('a child flow that waits suspends its parent, is never cancelled, and its completion resumes the parent', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        child: { type: 'Workflow', inputs: { host: { workflowReferenceName: CHILD }, body: {} } },
        done: reply('child', "@body('child')"),
      },
    },
    [CHILD]: {
      triggers: manual,
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } },
        done: reply('pause', { from: 'child' }),
      },
    },
  };
  const { runs, scheduler, store, start } = await unit(t, flows);
  const answer = await start(FLOW);
  assert.equal(answer.status, 'Waiting');
  const [child] = runs.list({ processId: CHILD });
  assert.equal(child.status, 'Waiting', 'the child is not cancelled');
  assert.deepEqual(
    [runs.get(answer.runId).wait.kind, runs.get(answer.runId).wait.id, runs.get(answer.runId).wait.actionPath],
    ['child', child.id, 'child'],
  );
  assert.deepEqual(store.state.simulator.flowRuns[child.id].parent, { runId: answer.runId, actionPath: 'child' });
  await scheduler.advance(60000);
  assert.equal(runs.get(child.id).status, 'Succeeded');
  assert.equal(runs.get(answer.runId).status, 'Succeeded');
  assert.deepEqual(runs.get(answer.runId).journal.child, {
    status: 'Succeeded',
    outputs: { statusCode: 200, headers: {}, body: { from: 'child' } },
  });
});

// A cancelled parent is left alone when its child completes.
test('a parent cancelled while its child waits is not resumed by the child', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        child: { type: 'Workflow', inputs: { host: { workflowReferenceName: CHILD }, body: {} } },
        done: reply('child', {}),
      },
    },
    [CHILD]: {
      triggers: manual,
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } },
        done: reply('pause', {}),
      },
    },
  };
  const { runs, scheduler, notes, start } = await unit(t, flows);
  const answer = await start(FLOW);
  assert.equal(await runs.cancel(answer.runId), true);
  await scheduler.advance(60000);
  assert.deepEqual(
    [runs.get(answer.runId).status, runs.list({ processId: CHILD })[0].status],
    ['Cancelled', 'Succeeded'],
  );
  assert.ok(
    !notes.some((note) => note.code === 'FLOW_RUN_RESUME_FAILED'),
    JSON.stringify(notes.filter((n) => n.code === 'FLOW_RUN_RESUME_FAILED')),
  );
});

// An on-demand run keeps context.background across its resume.
test('an on-demand Button run with a Wait and no Response succeeds after the wait', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } },
        note: { type: 'Compose', runAfter: { pause: ['Succeeded'] }, inputs: 'done' },
      },
    },
  };
  const { runs, scheduler, start } = await unit(t, flows);
  const answer = await start(FLOW, {}, { background: true });
  assert.equal(answer.status, 'Waiting');
  await scheduler.advance(60000);
  assert.equal(runs.get(answer.runId).status, 'Succeeded');
});

// A wait inside a loop suspends with the iteration's journal key; the child's completion resumes the parent there.
test('a child flow that waits inside a parent loop suspends the parent at that iteration and its completion resumes it', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        each: {
          type: 'Foreach',
          foreach: [1],
          actions: { child: { type: 'Workflow', inputs: { host: { workflowReferenceName: CHILD }, body: {} } } },
        },
        done: reply('each', "@outputs('child')", ['Succeeded', 'Failed']),
      },
    },
    [CHILD]: {
      triggers: manual,
      actions: {
        pause: { type: 'Wait', inputs: { interval: { count: 1, unit: 'Minute' } } },
        done: reply('pause', {}),
      },
    },
  };
  const { runs, scheduler, start } = await unit(t, flows);
  const answer = await start(FLOW);
  assert.equal(answer.status, 'Waiting');
  assert.equal(answer.suspended.actionPath, 'each/child');
  await scheduler.advance(60000);
  assert.equal(runs.list({ processId: CHILD })[0].status, 'Succeeded');
  assert.equal(runs.get(answer.runId).status, 'Succeeded');
});

test('without a run store a waiting action keeps answering 501 FlowSuspendNotWired', async (_t) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const connectors = createConnectorRuntime({ store });
  assert.equal(flowRunsOf(store), null);
  const definition = {
    triggers: manual,
    actions: { approve, done: reply('approve', "@outputs('approve')", ['Failed']) },
  };
  const answer = await runTrackedFlow({ runs: null, processId: FLOW, definition, input: {}, store, connectors });
  assert.equal(answer.body.error.code, 'FlowSuspendNotWired');
  assert.deepEqual(store.state.simulator?.approvals ?? {}, {}, 'no approval was recorded');
});

// ---- Standalone runtime: ExecuteWorkflow -> Waiting -> /_sim/api/flow-waits -> Succeeded; CancelAllCloudFlowRuns

async function standalone(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'flow-run-lifecycle-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const definition = {
    properties: {
      definition: {
        triggers: {
          row: {
            type: 'OpenApiConnectionWebhook',
            inputs: {
              host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
              parameters: {
                'subscriptionRequest/message': 3,
                'subscriptionRequest/entityname': 'x_item',
                'subscriptionRequest/scope': 4,
              },
            },
          },
        },
        actions: {
          approve,
          outcome: { type: 'Compose', runAfter: { approve: ['Succeeded'] }, inputs: "@body('approve')?['outcome']" },
        },
      },
    },
  };
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedFlowRuns</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml':
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
    'Workflows/approval.json': JSON.stringify(definition),
    'Workflows/approval.json.data.xml': `<Workflow WorkflowId="${FLOW}" Name="Invented approval flow"><OnDemand>1</OnDemand><PrimaryEntity>x_item</PrimaryEntity><StateCode>1</StateCode></Workflow>`,
  };
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(solution, relative)), { recursive: true });
    await fs.writeFile(path.join(solution, relative), content);
  }
  const profile = {
    userId: '77777777-7777-4777-8777-0000000000f4',
    evidence: 'Invented flow owner',
    grants: [{ entity: 'x_item', operations: ['read'] }],
  };
  const pack = {
    id: 'invented-flow-runs',
    name: 'Invented',
    description: 'Invented flow identity',
    matches: () => true,
    presets: () => ({}),
    flowIdentities: { [FLOW]: profile },
  };
  const sim = await createSimulator({
    runtime: { kind: 'dataverse-api' },
    solutionRoots: [solution],
    projectRoot: root,
    packs: [pack],
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  const json = async (response, status) => {
    const text = await response.text();
    assert.equal(response.status, status, text);
    return text ? JSON.parse(text) : null;
  };
  const registration = await json(
    await fetch(sim.url + '/_sim/api/dataverse/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ appId: CLIENT, displayName: 'Invented client', roles: ['System Administrator'] }),
    }),
    201,
  );
  const token = await json(
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: registration.secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    }),
    200,
  );
  const api = (method, suffix, body) =>
    fetch(sim.dataverse.origin + '/api/data/v9.2' + suffix, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(body ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const simApi = (method, suffix, body) =>
    fetch(sim.url + '/_sim/api' + suffix, {
      method,
      headers: { 'x-sim-csrf': sim.csrf, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const item = await json(await api('POST', '/x_items', { x_name: 'Invented item' }), 201);
  await json(
    await api('POST', `/workflows(${FLOW})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, { EntityId: item.x_itemid }),
    200,
  );
  // The ExecuteWorkflow job runs on the runtime scheduler: settle() returns once it ran and its run suspended.
  await sim.settle();
  const waits = await json(await simApi('GET', '/flow-waits'), 200);
  assert.equal(waits.length, 1, JSON.stringify(waits));
  return { sim, json, api, simApi, wait: waits[0] };
}

test('standalone: ExecuteWorkflow waits for an approval, the flow-waits answer resumes it and the run succeeds', async (t) => {
  const { sim, json, simApi, wait } = await standalone(t);
  assert.equal(wait.kind, 'approval');
  assert.equal((await json(await simApi('GET', `/flow-runs/${wait.runId}`), 200)).status, 'Waiting');
  const answered = await json(
    await simApi('POST', `/flow-waits/${wait.id}`, {
      outcome: 'Approve',
      responder: 'approver@example.test',
      comments: 'Invented',
    }),
    202,
  );
  assert.equal(answered.outcome, 'Approve');
  // The answer resumes the run on the runtime scheduler (202 Accepted): settle() returns once it finished.
  await sim.settle();
  const run = await json(await simApi('GET', `/flow-runs/${wait.runId}`), 200);
  assert.equal(run.status, 'Succeeded', JSON.stringify(run));
  assert.equal(run.journal.approve.outputs.body.outcome, 'Approve');
  assert.equal(run.journal.approve.outputs.body.responses[0].comments, 'Invented');
});

test('standalone: CancelAllCloudFlowRuns cancels the waiting run and removes its wait', async (t) => {
  const { json, api, simApi, wait } = await standalone(t);
  const cancelled = await api('POST', `/workflows(${FLOW})/Microsoft.Dynamics.CRM.CancelAllCloudFlowRuns`, {});
  assert.equal(cancelled.status, 204, await cancelled.clone().text());
  assert.equal((await json(await simApi('GET', `/flow-runs/${wait.runId}`), 200)).status, 'Cancelled');
  assert.deepEqual(await json(await simApi('GET', '/flow-waits'), 200), []);
  const late = await simApi('POST', `/flow-waits/${wait.id}`, { outcome: 'Approve' });
  assert.equal(late.status, 404, 'a cancelled run has no wait to answer');
});

test('a child flow filtered by its trigger condition creates no child history or fabricated Response', async (t) => {
  const flows = {
    [FLOW]: {
      triggers: manual,
      actions: {
        Child: { type: 'Workflow', inputs: { host: { workflowReferenceName: CHILD }, body: {} } },
        Rejected: {
          type: 'Response',
          runAfter: { Child: ['Failed'] },
          inputs: { statusCode: 409, body: "@outputs('Child')" },
        },
      },
    },
    [CHILD]: {
      triggers: { manual: { type: 'Request', kind: 'Button', conditions: [{ expression: '@false' }] } },
      actions: { Reply: { type: 'Response', inputs: { body: 'must not answer' } } },
    },
  };
  const { runs, start } = await unit(t, flows);
  const result = await start(FLOW);
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'ChildFlowNotStarted');
  assert.equal(runs.list({ processId: CHILD }).length, 0);
});
