// @test-kind observation: classic workflows saved by the process designer with its Specify Condition dialog (summary-F6 DATA-04c2, paqvilo-developer hosted-f6 runs dc2wa/dc2wb): a column wait, a Timeout wait on a date column with and without an offset, a wait on two conditions and a parallel wait branch; the fixtures are the recorded designer XAML with invented table, column and workflow names
// The hosted runs: a column wait suspends with no time (wait-until 9999-12-30) until a write makes it hold; a Timeout wait
// suspends until the due time (plus the offset) and its job completes then; a parallel wait branch suspends until the
// earliest Timeout and runs the branch that holds first (Ready: the row deactivated, the job Succeeded; the timeout: Stop
// workflow Canceled, the row active).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseClassicWorkflow, runClassicWorkflow } from '../lib/classic-workflow-xaml.mjs';

const ITEM = '7e570000-0000-4000-8000-0000000000aa';
const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const MINUTE = 60_000;
const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/classic-workflow-designer-waits/${name}.xaml`, import.meta.url), 'utf8');

function workflow(name) {
  const { program, unsupported } = parseClassicWorkflow(fixture(name));
  assert.equal(unsupported, undefined, `${name}: ${unsupported}`);
  // The hosted Web API creates and activates every one of these designer texts (a Timeout wait's Postpone included).
  assert.deepEqual(program.webApi, [], name);
  return program;
}

// One row and a clock the scenario moves; updates are recorded.
function scenario(values) {
  const state = { row: { test_itemid: ITEM, statecode: 0, statuscode: 1, ...values }, now: T0, updates: [] };
  state.host = () => ({
    primary: { logicalName: 'test_item', id: ITEM, row: state.row },
    idColumn: () => 'test_itemid',
    hasTable: () => true,
    read: () => state.row,
    create: () => assert.fail('no create'),
    update: (table, id, data) => {
      state.updates.push(data);
      state.row = { ...state.row, ...data };
      return state.row;
    },
    trace: () => {},
    now: () => state.now,
  });
  return state;
}
const iso = (ms) => new Date(ms).toISOString();

test('a column wait suspends with no time until a write of the column makes it hold', async () => {
  const program = workflow('waitfield');
  const run = scenario({ test_stage: 1 });
  const waiting = await runClassicWorkflow(program, run.host());
  assert.deepEqual(waiting.wait, { kind: 'condition', until: null, columns: ['test_stage'] });
  run.row.test_stage = 3;
  const still = await runClassicWorkflow(program, run.host(), { resume: waiting.snapshot });
  assert.equal(still.status, 'waiting');
  run.row.test_stage = 5;
  const done = await runClassicWorkflow(program, run.host(), { resume: still.snapshot });
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(run.updates, [{ statecode: 1, statuscode: 2 }]);
});

test('a wait on two conditions holds only when both do', async () => {
  const program = workflow('waitand');
  const run = scenario({ test_stage: 1, test_ready: false });
  let result = await runClassicWorkflow(program, run.host());
  assert.deepEqual(result.wait.columns.toSorted(), ['test_ready', 'test_stage']);
  run.row.test_stage = 5;
  result = await runClassicWorkflow(program, run.host(), { resume: result.snapshot });
  assert.equal(result.status, 'waiting');
  run.row.test_ready = true;
  result = await runClassicWorkflow(program, run.host(), { resume: result.snapshot });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(run.updates, [{ statecode: 1, statuscode: 2 }]);
});

test('a Timeout wait suspends until the due time, or the due time plus its offset, and completes then', async () => {
  for (const [name, offset] of [
    ['waitdue', 0],
    ['waitoffset', 2 * MINUTE],
  ]) {
    const due = T0 + 3 * MINUTE;
    const run = scenario({ test_due: iso(due) });
    const waiting = await runClassicWorkflow(workflow(name), run.host());
    assert.equal(waiting.status, 'waiting', name);
    assert.equal(waiting.wait.kind, 'timeout', name);
    assert.equal(waiting.wait.until, due + offset, name);
    run.now = due + offset - 1;
    const early = await runClassicWorkflow(workflow(name), run.host(), { resume: waiting.snapshot });
    assert.equal(early.status, 'waiting', name);
    run.now = due + offset;
    const done = await runClassicWorkflow(workflow(name), run.host(), { resume: early.snapshot });
    assert.equal(done.status, 'succeeded', name);
    assert.deepEqual(run.updates, [{ statecode: 1, statuscode: 2 }], name);
  }
  // A row without a due time never times out (the designer reads it as DateTime.MaxValue).
  const never = await runClassicWorkflow(workflow('waitdue'), scenario({}).host());
  assert.deepEqual(never.wait, { kind: 'condition', until: null, columns: ['test_due'] });
});

test('a parallel wait branch waits until the earliest timeout and runs the branch that holds first', async () => {
  const due = T0 + 5 * MINUTE;
  const ready = scenario({ test_ready: false, test_due: iso(due) });
  const waiting = await runClassicWorkflow(workflow('parallel'), ready.host());
  assert.equal(waiting.wait.until, due);
  ready.row.test_ready = true;
  const done = await runClassicWorkflow(workflow('parallel'), ready.host(), { resume: waiting.snapshot });
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(ready.updates, [{ statecode: 1, statuscode: 2 }]);

  const late = scenario({ test_ready: false, test_due: iso(T0 + 2 * MINUTE) });
  const pending = await runClassicWorkflow(workflow('parallel'), late.host());
  late.now = T0 + 2 * MINUTE;
  const stopped = await runClassicWorkflow(workflow('parallel'), late.host(), { resume: pending.snapshot });
  assert.equal(stopped.status, 'canceled');
  assert.deepEqual(late.updates, []);
});

// The same designer texts through Mirage's Dataverse organization (the classic-workflow replay adapter's runtime: the
// workflow created and activated through the Web API, the row created, the clock moved): the system job's wait-until and
// outcome as the hosted runs read them.
const { default: runRecorded } = await import('./parity/adapters/classic-workflow.mjs');
const ORGANIZATION_SCHEMA = {
  pqf6_wfitem: { primary: { pqf6_name: 100 }, whole: ['pqf6_stage'], datetime: ['pqf6_due'], boolean: ['pqf6_ready'] },
  pqf6_wflog: { primary: { pqf6_name: 200 } },
};
const onOrganization = (name) =>
  fixture(name)
    .replaceAll('test_item', 'pqf6_wfitem')
    .replaceAll('test_stage', 'pqf6_stage')
    .replaceAll('test_due', 'pqf6_due')
    .replaceAll('test_ready', 'pqf6_ready');
const organizationRun = (name, create, actions) =>
  runRecorded(
    {
      schema: ORGANIZATION_SCHEMA,
      workflows: [
        {
          id: /XrmWorkflow([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})/
            .exec(fixture(name))
            .slice(1)
            .join('-'),
          name: `designer ${name}`,
          mode: 0,
          runas: 1,
          primaryentity: 'pqf6_wfitem',
          scope: 4,
          triggeroncreate: true,
          xaml: onOrganization(name),
        },
      ],
      scenario: { create: { pqf6_name: name, ...create }, actions, waiting: [`designer ${name}`] },
    },
    { surface: 'classic-workflow', suite: 'designer-waits' },
  );
const JOB_FIELDS = ({ statecode, statuscode, postponeuntil }) => ({ statecode, statuscode, postponeuntil });

test('through the organization, a Timeout job waits until the due time and completes then; a parallel branch completes on its condition or stops at its timeout', async () => {
  const due = await organizationRun('waitdue', { pqf6_due: { afterStartMs: 3 * MINUTE } }, [
    { read: 'beforeResume' },
    { advanceToMs: 3 * MINUTE },
    { read: 'afterDue' },
  ]);
  assert.deepEqual(JOB_FIELDS(due.beforeResume['designer waitdue']), {
    statecode: 1,
    statuscode: 10,
    postponeuntil: iso(T0 + 3 * MINUTE),
  });
  assert.deepEqual([due.afterDue['designer waitdue'].statecode, due.afterDue['designer waitdue'].statuscode], [3, 30]);
  assert.deepEqual([due.item.statecode, due.item.statuscode], [1, 2]);

  const ready = await organizationRun('parallel', { pqf6_ready: false, pqf6_due: { afterStartMs: 5 * MINUTE } }, [
    { read: 'beforeResume' },
    { patch: { pqf6_ready: true }, probe: 'pqf6_ready' },
  ]);
  assert.deepEqual(JOB_FIELDS(ready.beforeResume['designer parallel']), {
    statecode: 1,
    statuscode: 10,
    postponeuntil: iso(T0 + 5 * MINUTE),
  });
  assert.equal(ready.resumedBy, 'pqf6_ready');
  assert.deepEqual([ready.jobs['designer parallel'].statecode, ready.jobs['designer parallel'].statuscode], [3, 30]);
  assert.deepEqual([ready.item.statecode, ready.item.statuscode], [1, 2]);

  const timeout = await organizationRun('parallel', { pqf6_ready: false, pqf6_due: { afterStartMs: 2 * MINUTE } }, [
    { advanceToMs: 2 * MINUTE },
  ]);
  assert.deepEqual(
    [timeout.jobs['designer parallel'].statecode, timeout.jobs['designer parallel'].statuscode],
    [3, 32],
  );
  assert.deepEqual([timeout.item.statecode, timeout.item.statuscode], [0, 1]);
});
