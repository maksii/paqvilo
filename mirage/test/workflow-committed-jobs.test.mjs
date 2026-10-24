// Classic workflow background runs are durable committed jobs (dataverse-workflows.mjs through committed-work.mjs): the
// Ready asyncoperation row is written inside the triggering commit, a rolled-back write leaves no job, and the store's job
// runner completes it as a Workflow job (operationtype 10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { workflowExtension, workflowHandlers } from '../lib/dataverse-workflows.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';

const WORKFLOW = '77777777-7777-4777-8777-0000000000a1';
const FACT = {
  id: WORKFLOW,
  name: 'Invented background',
  uniquename: 'InventedBackground',
  category: 0,
  type: 1,
  mode: 0,
  scope: 4,
  state: 1,
  ondemand: false,
  primaryentity: 'x_widget',
  triggeroncreate: true,
  xaml: '<Activity />',
};

function initialState() {
  const state = emptyState();
  state.mappings.x_widget = {
    logicalName: 'x_widget',
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    nameColumn: 'x_name',
    fields: { x_name: { type: 'string' } },
  };
  state.tables.x_widget = [];
  return state;
}

test('a background workflow job commits with its trigger and runs on the job runner', async (t) => {
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  const store = await new DataStore({ state: initialState() }).init();
  const handlers = workflowHandlers([
    {
      id: 'fx-workflows',
      workflows: { InventedBackground: async ({ target }) => ({ message: `handled ${target.row.x_name}` }) },
    },
  ]);
  const core = await createOrganizationRuntime({
    store,
    scheduler,
    settings: dataverseSettings({ enabled: false }),
    extensions: [...EXTENSIONS, workflowExtension({ facts: [FACT], handlers, diagnostic: () => {} })],
  });
  t.after(() => core.close());
  const jobs = () => store.tableRows('asyncoperation').filter((row) => row.name === 'Invented background');

  // A write that rolls back takes its job row with it.
  await assert.rejects(
    store.transact(
      async () => {
        await store.create('x_widget', { x_name: 'rolled back' }, { admin: true });
        throw new Error('invented rollback');
      },
      { isolated: true },
    ),
    /invented rollback/,
  );
  assert.equal(store.tableRows('x_widget').length, 0);
  assert.equal(jobs().length, 0);

  // The committed write carries its Ready job row; nothing has run yet.
  await store.create('x_widget', { x_name: 'kept' }, { admin: true });
  // The row is a Workflow job (operationtype 10) from staging on, not only once it completes.
  assert.deepEqual(
    jobs().map((row) => [row.statecode, row.statuscode, row.operationtype, JSON.parse(row.data).kind]),
    [[0, 0, 10, 'workflow']],
  );

  for (let round = 0; round < 10 && jobs()[0].statecode !== 3; round += 1) await scheduler.runDue();
  const [job] = jobs();
  assert.deepEqual([job.statecode, job.statuscode, job.operationtype, job.message], [3, 30, 10, 'handled kept']);
});
