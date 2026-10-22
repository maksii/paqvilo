// A classic background workflow at simulation level: its run history (workflowlog, as asyncoperation) is runtime-owned, so a
// project DATA file that owns only the business table does not fail the run with SimulationDataTargetRequired. Invented ids only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { workflowExtension, workflowHandlers } from '../lib/dataverse-workflows.mjs';
import { createScheduler, fixedClock } from '../lib/runtime-clock.mjs';
import { loadPack } from '../lib/preset-registry.mjs';
import { createSimulationPersistence } from '../lib/simulation-persistence.mjs';

const WORKFLOW = '77777777-7777-4777-8777-0000000000b1';
const FACT = { id: WORKFLOW, name: 'Invented triage', uniquename: 'InventedTriage', category: 0, type: 1, mode: 0, scope: 4, state: 1,
  ondemand: true, primaryentity: 'x_widget', triggeroncreate: true, xaml: '<Activity />' };

test('a classic workflow on Create completes its job at simulation level with a DATA file owning only the business table', async t => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'paqvilo-wf-sim-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'records.json'), JSON.stringify({ tables: { x_widget: [] } }));
  await fs.writeFile(path.join(directory, 'pack.mjs'), `export default {id:'invented',name:'Invented',description:'Invented fixture',matches:()=>true,presets:()=>({}),
    dataFiles:[{file:'records.json',tables:{x_widget:{path:['tables','x_widget'],idColumn:'x_widgetid'}}}]};`);
  const pack = await loadPack(path.join(directory, 'pack.mjs'));
  const storageAdapter = await createSimulationPersistence({ settings: { level: 'simulation' }, packs: [pack], stateFile: path.join(directory, '.runtime', 'state.json') });
  const state = emptyState();
  state.mappings.x_widget = { logicalName: 'x_widget', entitySet: 'x_widgets', idColumn: 'x_widgetid', nameColumn: 'x_name', fields: { x_name: { type: 'string' } } };
  state.tables.x_widget = [];
  const store = await new DataStore({ file: path.join(directory, '.runtime', 'state.json'), state, storageAdapter }).init();
  const scheduler = createScheduler({ clock: fixedClock(), manual: true });
  const handlers = workflowHandlers([{ id: 'invented', workflows: { InventedTriage: async () => ({ message: 'triaged' }) } }]);
  const core = await createOrganizationRuntime({ store, scheduler, settings: dataverseSettings({ enabled: false }),
    extensions: [...EXTENSIONS, workflowExtension({ facts: [FACT], handlers, diagnostic: () => {} })] });
  t.after(() => core.close());
  storageAdapter.activate(store.state);

  await store.create('x_widget', { x_name: 'kept' }, { admin: true });
  const job = () => store.tableRows('asyncoperation').find(row => row.name === 'Invented triage');
  for (let round = 0; round < 10 && job()?.statecode !== 3; round += 1) await scheduler.runDue();
  assert.deepEqual([job().statecode, job().statuscode, job().message], [3, 30, 'triaged']);
  assert.equal(store.tableRows('workflowlog').length, 1, 'the run logged its workflowlog row');
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'records.json'), 'utf8')).tables.x_widget.length, 1, 'the business row went to DATA');
});
