import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';
import { createFlowRunStore, describe } from '../lib/flow-runs.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';

const FLOW = '77777777-7777-4777-8777-777777777777';

async function fixture(t, options = {}) {
  const clock = fixedClock();
  const store = await new DataStore({ state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  t.after(() => scheduler.close());
  const notes = [];
  const runs = createFlowRunStore({ store, scheduler, diagnostic: (note) => notes.push(note), ...options });
  return { store, clock, scheduler, runs, notes };
}

test('a run writes a flowrun row from Running to Succeeded with start, end and correlation', async (t) => {
  const { store, clock, runs } = await fixture(t);
  const run = await runs.start({
    processId: FLOW,
    trigger: 'Automated',
    input: { x: 1 },
    correlationId: 'corr-1',
    definitionHash: 'h1',
  });
  assert.equal(run.status, 'Running');
  const row = store.state.tables.flowrun.find((r) => r.flowrunid === run.id);
  assert.deepEqual(
    {
      workflowid: row.workflowid,
      status: row.status,
      triggertype: row.triggertype,
      correlationid: row.correlationid,
      endtime: row.endtime,
    },
    { workflowid: FLOW, status: 'Running', triggertype: 'Automated', correlationid: 'corr-1', endtime: null },
  );
  clock.advance(1500);
  const done = await runs.complete(run.id, { status: 'Succeeded' });
  assert.equal(done.status, 'Succeeded');
  assert.equal(store.state.tables.flowrun[0].duration, 1500);
  assert.equal(store.state.simulator.flowRuns[run.id].input, null, 'the trigger input is dropped once the run ends');
  assert.deepEqual(
    runs.list({ processId: FLOW.toUpperCase() }).map((r) => r.id),
    [run.id],
  );
  assert.deepEqual(runs.list({ status: 'Running' }), []);
  await assert.rejects(runs.complete(run.id, { status: 'Waiting' }), { code: 'InvalidRequest' });
});

test('suspend and resume answer the steps mock map that replays journalled actions without re-running them', async (t) => {
  const { runs } = await fixture(t);
  const run = await runs.start({
    processId: FLOW,
    input: { name: 'Invented' },
    steps: { Compose_disabled: { mode: 'disabled' } },
  });
  await runs.journal(run.id, 'Create_row', {
    status: 'Succeeded',
    outputs: { statusCode: 201, body: { x_itemid: 'i1' } },
  });
  await runs.suspend(run.id, {
    actionPath: 'Wait_for_approval',
    wait: { kind: 'approval', id: 'appr-1', timeoutAt: '2026-01-02T00:00:00.000Z', assignedTo: ['a@example.test'] },
  });
  assert.equal(runs.get(run.id).status, 'Waiting');
  assert.deepEqual(
    runs.waits().map((w) => [w.runId, w.id, w.kind, w.actionPath]),
    [[run.id, 'appr-1', 'approval', 'Wait_for_approval']],
  );
  const replay = await runs.resume(run.id, {
    status: 'Succeeded',
    outputs: { statusCode: 200, body: { outcome: 'Approve' } },
  });
  assert.deepEqual(replay.input, { name: 'Invented' });
  assert.deepEqual(replay.steps, {
    Compose_disabled: { mode: 'disabled' },
    Create_row: { mode: 'mock', status: 'Succeeded', outputs: { statusCode: 201, body: { x_itemid: 'i1' } } },
    Wait_for_approval: {
      mode: 'mock',
      status: 'Succeeded',
      outputs: { statusCode: 200, body: { outcome: 'Approve' } },
    },
  });
  assert.equal(runs.get(run.id).status, 'Running');
  assert.deepEqual(runs.waits(), []);
  await assert.rejects(runs.resume(run.id, {}), { code: 'FlowRunNotWaiting' });

  // The map plugs into the interpreter unchanged: the mocked connector actions answer from the journal.
  const definition = {
    triggers: { manual: { type: 'Request', kind: 'powerpages', inputs: { schema: { type: 'object' } } } },
    actions: {
      Create_row: {
        type: 'OpenApiConnection',
        inputs: {
          host: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_x_widgets',
            operationId: 'Create',
            connectionName: 'x',
          },
        },
      },
      Wait_for_approval: {
        type: 'OpenApiConnection',
        runAfter: { Create_row: ['Succeeded'] },
        inputs: {
          host: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_approvals',
            operationId: 'WaitForAnApproval',
            connectionName: 'y',
          },
        },
      },
      Response: {
        type: 'Response',
        runAfter: { Wait_for_approval: ['Succeeded'] },
        inputs: {
          statusCode: 200,
          body: { id: "@body('Create_row')?['x_itemid']", outcome: "@body('Wait_for_approval')?['outcome']" },
        },
      },
    },
  };
  const { Compose_disabled, ...steps } = replay.steps;
  const answer = await executeFlowDefinition({ definition, input: replay.input, steps });
  assert.deepEqual(answer.body, { id: 'i1', outcome: 'Approve' });
});

// Secure outputs are redacted in state; the clear answer lives in this process only.
test('a secure output is never written to state: a resume in the same process replays it, one after a restart is NotResumable', async (t) => {
  const { store, runs, scheduler } = await fixture(t);
  const run = await runs.start({ processId: FLOW });
  await runs.journal(run.id, 'Get_secret', {
    status: 'Succeeded',
    outputs: { body: { value: 'invented-secret' } },
    secure: true,
  });
  assert.ok(!JSON.stringify(store.state).includes('invented-secret'));
  assert.deepEqual(runs.get(run.id).journal, { Get_secret: { status: 'Succeeded', secure: true } });
  await runs.suspend(run.id, { actionPath: 'Approve', wait: { kind: 'approval', id: 'a1', secure: true } });
  const replay = await runs.resume(run.id, {
    status: 'Succeeded',
    outputs: { body: { outcome: 'invented-secret-answer' } },
  });
  assert.deepEqual(replay.journal.Get_secret.outputs, { body: { value: 'invented-secret' } });
  assert.deepEqual(replay.journal.Approve.outputs, { body: { outcome: 'invented-secret-answer' } });
  assert.deepEqual(runs.get(run.id).journal.Approve, { status: 'Succeeded', secure: true });
  assert.ok(!JSON.stringify(store.state).includes('invented-secret'), 'neither secure answer is in state');

  await runs.suspend(run.id, { actionPath: 'Delay', wait: { kind: 'delay', id: 'd1' } });
  const restarted = createFlowRunStore({ store, scheduler });
  await assert.rejects(restarted.resume(run.id, {}), {
    code: 'NotResumable',
    status: 409,
    message: /SecureOutputs \(action Get_secret\)/,
  });
  assert.equal(runs.get(run.id).status, 'Failed');
  assert.equal(store.state.tables.flowrun[0].errorcode, 'NotResumable');
});

test('a connector action journalled twice (a loop) cannot resume', async (t) => {
  const { runs } = await fixture(t);
  const run = await runs.start({ processId: FLOW });
  await runs.journal(run.id, 'Each/Send', { outputs: { n: 1 } });
  await runs.journal(run.id, 'Each/Send', { outputs: { n: 2 } });
  assert.equal(runs.get(run.id).notResumable, 'RepeatedAction');
});

test('a wait timeout on the manual scheduler resumes the run with a TimedOut outcome', async (t) => {
  const resumed = [];
  const { runs, scheduler } = await fixture(t, {
    resumeRun: (id, outcome) => {
      resumed.push([id, outcome.status]);
    },
  });
  const run = await runs.start({ processId: FLOW });
  await runs.suspend(run.id, {
    actionPath: 'Approve',
    wait: { kind: 'approval', id: 'appr-2', timeoutAt: Date.parse('2026-01-01T01:00:00.000Z') },
  });
  await scheduler.advance(59 * 60 * 1000);
  assert.deepEqual(resumed, []);
  await scheduler.advance(60 * 1000);
  assert.deepEqual(resumed, [[run.id, 'TimedOut']]);
  assert.deepEqual(
    runs.waits({ state: 'overdue' }).map((w) => w.id),
    ['appr-2'],
  );
  const replay = await runs.resume(run.id, { status: 'TimedOut', outputs: { error: { code: 'ActionTimedOut' } } });
  assert.equal(replay.steps.Approve.status, 'TimedOut');
});

test('without resumeRun a timeout completes the run TimedOut; a delay end runs resumeRun; rearm restores timers', async (t) => {
  const { runs, scheduler, notes } = await fixture(t);
  const run = await runs.start({ processId: FLOW });
  await runs.suspend(run.id, {
    actionPath: 'Approve',
    wait: { kind: 'approval', id: 'appr-3', timeoutAt: Date.parse('2026-01-01T00:10:00.000Z') },
  });
  await scheduler.advance(10 * 60 * 1000);
  assert.equal(runs.get(run.id).status, 'TimedOut');

  const delayed = await runs.start({ processId: FLOW });
  await runs.suspend(delayed.id, {
    actionPath: 'Delay',
    wait: {
      kind: 'delay',
      id: 'd2',
      until: Date.parse('2026-01-01T00:20:00.000Z'),
      timeoutAt: Date.parse('2026-01-02T00:00:00.000Z'),
    },
  });
  runs.close(); // a restart loses in-memory timers
  assert.equal(scheduler.pending().length, 0);
  const resumed = [];
  runs.setResumeRun((id, outcome) => {
    resumed.push([id, outcome.status]);
  });
  assert.equal(runs.rearm(), 1);
  await scheduler.advance(10 * 60 * 1000);
  assert.deepEqual(resumed, [[delayed.id, 'Succeeded']]);
  assert.ok(!notes.some((n) => n.code === 'FLOW_RESUME_NOT_WIRED'));
});

test('cancel ends open runs, stops their timers and leaves finished runs alone', async (t) => {
  const closed = [];
  const { runs, scheduler } = await fixture(t, {
    approvals: {
      close: async (id, status) => {
        closed.push([id, status]);
      },
    },
  });
  const waiting = await runs.start({ processId: FLOW });
  await runs.suspend(waiting.id, {
    actionPath: 'Approve',
    wait: { kind: 'approval', id: 'appr-4', timeoutAt: Date.parse('2026-01-01T00:05:00.000Z') },
  });
  const running = await runs.start({ processId: FLOW });
  const done = await runs.start({ processId: FLOW });
  await runs.complete(done.id);
  assert.equal(await runs.cancelAll(FLOW), 2);
  assert.deepEqual(closed, [['appr-4', 'Cancelled']]);
  assert.deepEqual(
    [waiting, running, done].map((r) => runs.get(r.id).status),
    ['Cancelled', 'Cancelled', 'Succeeded'],
  );
  assert.equal(scheduler.pending().length, 0);
  assert.equal(await runs.cancel(done.id), false);
  await runs.complete(running.id, { status: 'Succeeded' });
  assert.equal(
    runs.get(running.id).status,
    'Cancelled',
    'a cancelled run keeps its status when the interpreter finishes',
  );
});

test('prune keeps the newest runs and journals within the limits and reports what it dropped', async (t) => {
  const { store, clock, runs, notes } = await fixture(t, { limits: { keepRuns: 3, keepJournals: 1 } });
  const ids = [];
  for (let i = 0; i < 5; i++) {
    clock.advance(1000);
    const run = await runs.start({ processId: FLOW, input: { i } });
    await runs.journal(run.id, 'Act', { outputs: { i } });
    await runs.complete(run.id);
    ids.push(run.id);
  }
  assert.deepEqual(store.state.tables.flowrun.map((r) => r.flowrunid).sort(), ids.slice(2).sort());
  assert.deepEqual(Object.keys(store.state.simulator.flowRuns).sort(), ids.slice(2).sort());
  assert.deepEqual(
    ids.slice(2).map((id) => runs.get(id).journalPruned),
    [true, true, false],
  );
  assert.ok(notes.some((n) => n.code === 'FLOW_RUN_JOURNAL_PRUNED'));
});

test('two resumes of one wait: exactly one answers, the other is FlowRunNotWaiting', async (t) => {
  const { runs } = await fixture(t);
  const run = await runs.start({ processId: FLOW });
  await runs.suspend(run.id, {
    actionPath: 'Delay',
    wait: { kind: 'delay', id: 'delay-1', until: '2026-01-02T00:00:00.000Z' },
  });
  const [first, second] = await Promise.allSettled([runs.resume(run.id, {}), runs.resume(run.id, {})]);
  assert.deepEqual([first.status, second.status].sort(), ['fulfilled', 'rejected']);
  const rejected = first.status === 'rejected' ? first : second;
  assert.equal(rejected.reason.code, 'FlowRunNotWaiting');
  assert.equal(rejected.reason.status, 409);
  assert.equal(runs.get(run.id).status, 'Running');
});

test('prune drops finished approvals beyond keepRuns and keeps every pending one', async (t) => {
  const { store, runs, notes } = await fixture(t, { limits: { keepRuns: 50 } });
  const approvals = ((store.state.simulator ??= {}).approvals ??= {});
  for (let i = 0; i < 300; i++) {
    const at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    approvals[`appr-${i}`] = {
      id: `appr-${i}`,
      status: 'Approved',
      completionDate: at,
      requestDate: at,
      responses: [],
    };
  }
  for (let i = 0; i < 3; i++)
    approvals[`pending-${i}`] = {
      id: `pending-${i}`,
      status: 'Pending',
      completionDate: null,
      requestDate: '2026-01-01T00:00:00.000Z',
      responses: [],
    };
  const result = await runs.prune();
  assert.equal(result.approvals, 250);
  const kept = Object.keys(approvals);
  assert.deepEqual(
    kept.filter((id) => id.startsWith('appr-')).sort(),
    Array.from({ length: 50 }, (_, i) => `appr-${i + 250}`).sort(),
    'the newest finished approvals stay',
  );
  assert.deepEqual(kept.filter((id) => id.startsWith('pending-')).sort(), ['pending-0', 'pending-1', 'pending-2']);
  assert.equal(notes.find((n) => n.code === 'FLOW_RUN_JOURNAL_PRUNED').approvals, 250);
});

test('describe() reports behaviour mechanics and contract parity with its requirements', () => {
  const record = describe();
  assert.equal(record.level, 'behaviour');
  assert.deepEqual(record.requires, ['table:flowrun', 'scheduler']);
  assert.deepEqual(
    record.operations.filter((op) => op.level === 'contract').map((op) => op.name),
    ['approvalOutcomeShape', 'runHistoryApiParity'],
  );
});
