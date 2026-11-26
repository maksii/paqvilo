// Adapter for the classic-workflow surface: one recorded scenario of designer-format classic workflows (the recorded
// definitions, created through the Web API and activated as the recording did) -> one Mirage Dataverse organization on its
// own invented runtime -> the workflow outcome in the recording's portable shape.
// The recording ran as an application user that owns the workflows and creates and writes the primary rows on behalf of a
// work account (MSCRMCallerID); here two invented applications play the two roles. Identities are projected to roles:
// application, caller, system (SYSTEM). Projection, the same for every case:
//   create: the primary row create's status and error code and message;
//   jobs: each classic workflow system job (operationtype 10) by workflow name: state, status, wait-until, error code,
//         friendly message, owner and creator roles; beforeResume / afterDue: the waiting workflows' jobs at those reads;
//   resumedBy: the column whose write resumed the waiting job (the probe after which it completed);
//   logs: the workflowlog rows of each job by workflow name (step name, activity, status, error code, message), sorted;
//   item: the primary row's stage, result, state, status and owner/audit roles; wflogs: the rows the workflows wrote.
// Only the parts the recording read (scenario.observe) are answered.
// The runtime clock starts at a fixed instant and only the scenario's own advance moves it, so a wait on the current time
// cannot pass by itself (the recording read it 90 s after the due time).
import { randomUUID } from 'node:crypto';
import { DataStore, emptyState } from '../../../lib/data.mjs';
import { EXTENSIONS } from '../../../lib/dataverse-extensions.mjs';
import { dataverseSettings } from '../../../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../../../lib/dataverse-api.mjs';
import { workflowExtension } from '../../../lib/dataverse-workflows.mjs';
import { settleCommittedWork } from '../../../lib/committed-work.mjs';
import { createScheduler, fixedClock, storeScheduler } from '../../../lib/runtime-clock.mjs';
import { signedInRequester } from '../../support/web-api.mjs';

const T0 = Date.parse('2026-01-05T09:00:00.000Z');
const APPLICATION = '7a000000-0000-4000-8000-000000000001';
const CALLER = '7a000000-0000-4000-8000-000000000002';
const SETS = { pqf6_wfitem: 'pqf6_wfitems', pqf6_wflog: 'pqf6_wflogs' };
const WAITING = new Set(['pqf6 BG wait', 'pqf6 BG time wait']);

// The recorded tables as Mirage mappings: primary name, text, whole number, date and lookup columns; user owned.
function mappingsOf(schema) {
  const mappings = {};
  for (const [table, spec] of Object.entries(schema)) {
    const [primary, primaryLength] = Object.entries(spec.primary)[0];
    const fields = {
      [primary]: { dataverseType: 'nvarchar', maxLength: primaryLength },
      ownerid: { dataverseType: 'owner' },
      statecode: { dataverseType: 'state' },
      statuscode: { dataverseType: 'status' },
    };
    for (const [column, length] of Object.entries(spec.text ?? {}))
      fields[column] = { dataverseType: 'nvarchar', maxLength: length };
    for (const column of spec.whole ?? []) fields[column] = { dataverseType: 'int' };
    for (const column of spec.datetime ?? []) fields[column] = { dataverseType: 'datetime' };
    for (const [column, target] of Object.entries(spec.lookup ?? {}))
      fields[column] = { dataverseType: 'lookup', targets: [target] };
    mappings[table] = {
      logicalName: table,
      entitySet: SETS[table] ?? `${table}s`,
      idColumn: `${table}id`,
      nameColumn: primary,
      ownership: 'user',
      userConfigured: true,
      fields,
      relationships: {},
    };
  }
  return mappings;
}

// A relative instant of the scenario ({ afterStartMs }) as ISO text, any other value as it is.
const valueOf = (value) =>
  value && typeof value === 'object' && 'afterStartMs' in value
    ? new Date(T0 + value.afterStartMs).toISOString()
    : value;
const bodyOf = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, valueOf(value)]));
const idOf = (value) => String(value?.id ?? value ?? '').toLowerCase() || null;

async function organization(input) {
  const cleanups = [];
  const secrets = [APPLICATION, CALLER].map((appId) => {
    const variable = `PAQ_CLASSIC_WORKFLOW_PARITY_${appId.slice(-2)}_${process.pid}_${randomUUID().slice(0, 8).toUpperCase()}`;
    process.env[variable] = `invented-${appId}`;
    cleanups.push(() => delete process.env[variable]);
    return { appId, variable };
  });
  const state = emptyState();
  Object.assign(state.mappings, mappingsOf(input.schema));
  for (const table of Object.keys(input.schema)) state.tables[table] = [];
  const clock = fixedClock(T0);
  const store = await new DataStore({ state, clock }).init();
  const scheduler = storeScheduler(store, createScheduler({ clock, manual: true }));
  cleanups.push(() => scheduler.close());
  const settings = dataverseSettings({
    enabled: true,
    tds: { enabled: false },
    applications: secrets.map(({ appId, variable }) => ({
      appId,
      displayName: appId === APPLICATION ? 'Invented provisioning application' : 'Invented work account',
      secretEnvironmentVariable: variable,
      roles: ['System Administrator'],
    })),
  });
  const api = await startDataverseApi({
    store,
    settings,
    extensions: [...EXTENSIONS, workflowExtension({ facts: [] })],
    log: () => {},
  });
  cleanups.push(() => api.close());
  const application = await signedInRequester(api, APPLICATION, `invented-${APPLICATION}`);
  const callerApp = await signedInRequester(api, CALLER, `invented-${CALLER}`);
  const whoAmI = async (request) => (await request('GET', '/WhoAmI')).json.UserId.toLowerCase();
  const users = { application: await whoAmI(application), caller: await whoAmI(callerApp) };
  // The recording's writes: the application on the work account's behalf.
  const onBehalf = (method, path, body, headers = {}) =>
    application(method, path, body, { MSCRMCallerID: users.caller, ...headers });
  const settle = async () => {
    for (let round = 0; round < 50; round += 1) {
      await scheduler.runDue();
      await settleCommittedWork(store, []);
      if (!scheduler.status().pending) return;
    }
  };
  return {
    store,
    scheduler,
    application,
    onBehalf,
    users,
    settle,
    close: async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
    },
  };
}

/**
 * Runs one recorded scenario on its own runtime.
 * @param {{ schema: object, workflows: object[], scenario: object }} input the recorded definitions and scenario
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<object>} the projected outcome
 */
export default async function run(input, _context) {
  const runtime = await organization(input);
  try {
    return await scenario(runtime, input);
  } finally {
    await runtime.close();
  }
}

async function scenario(runtime, input) {
  const { store, scheduler, application, onBehalf, users, settle } = runtime;
  for (const workflow of input.workflows) {
    const { id, name, mode, runas, primaryentity, scope, triggeroncreate, xaml } = workflow;
    const created = await application('POST', '/workflows', {
      workflowid: id,
      name,
      category: 0,
      type: 1,
      mode,
      runas,
      primaryentity,
      scope,
      triggeroncreate,
      xaml,
    });
    if (created.status !== 204)
      throw new Error(`Creating ${name} answered ${created.status}: ${JSON.stringify(created.json)}`);
    const activated = await application('PATCH', `/workflows(${id})`, { statecode: 1, statuscode: 2 });
    if (activated.status !== 204)
      throw new Error(`Activating ${name} answered ${activated.status}: ${JSON.stringify(activated.json)}`);
  }
  const roles = new Map([
    [users.application, 'application'],
    [users.caller, 'caller'],
  ]);
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM')?.systemuserid;
  if (system) roles.set(String(system).toLowerCase(), 'system');
  const role = (value) => (idOf(value) ? (roles.get(idOf(value)) ?? 'other') : null);
  const nameOfWorkflow = new Map(input.workflows.map((workflow) => [workflow.id, workflow.name]));
  const jobsByName = () => {
    const out = {};
    for (const job of store.tableRows('asyncoperation').filter((row) => Number(row.operationtype) === 10))
      out[job.name] = job;
    return out;
  };
  const stateOf = (job) => ({
    statecode: job.statecode,
    statuscode: job.statuscode,
    postponeuntil: job.postponeuntil ?? null,
  });

  const { scenario: recorded } = input;
  const created = await onBehalf('POST', '/pqf6_wfitems', bodyOf(recorded.create), { prefer: 'return=representation' });
  const output = {
    create: {
      status: created.status,
      code: created.status >= 400 ? (created.json?.error?.code ?? null) : null,
      message: created.status >= 400 ? (created.json?.error?.message ?? null) : null,
    },
  };
  const itemId = created.status < 400 ? idOf(created.json?.pqf6_wfitemid) : null;
  await settle();
  for (const action of recorded.actions) {
    if (action.advanceToMs !== undefined) {
      const elapsed = clockElapsed(store);
      if (action.advanceToMs > elapsed) await scheduler.advance(action.advanceToMs - elapsed);
      await settle();
    }
    if (action.read)
      output[action.read] = Object.fromEntries(
        Object.entries(jobsByName())
          .filter(([name]) => WAITING.has(name))
          .map(([name, job]) => [name, stateOf(job)]),
      );
    if (action.patch) {
      const waitingBefore = Object.entries(jobsByName()).filter(
        ([name, job]) => WAITING.has(name) && Number(job.statecode) === 1,
      );
      const patched = await onBehalf('PATCH', `/pqf6_wfitems(${itemId})`, bodyOf(action.patch));
      if (patched.status !== 204)
        throw new Error(`The scenario write answered ${patched.status}: ${JSON.stringify(patched.json)}`);
      await settle();
      const resumed = waitingBefore.some(([name]) => Number(jobsByName()[name].statecode) === 3);
      if (action.probe && resumed && output.resumedBy === undefined) output.resumedBy = action.probe;
    }
  }
  output.jobs = Object.fromEntries(
    Object.entries(jobsByName())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, job]) => [
        name,
        {
          ...stateOf(job),
          errorcode: job.errorcode ?? null,
          friendlymessage: job.friendlymessage ?? null,
          owner: role(job.ownerid),
          createdBy: role(job.createdby),
        },
      ]),
  );
  // The beforeResume / afterDue reads list the jobs as the recording did: in workflow-name order.
  for (const key of ['beforeResume', 'afterDue'])
    if (output[key])
      output[key] = Object.fromEntries(Object.entries(output[key]).sort(([a], [b]) => a.localeCompare(b)));
  const jobName = new Map(
    store
      .tableRows('asyncoperation')
      .map((job) => [idOf(job.asyncoperationid), job.name ?? nameOfWorkflow.get(idOf(job.workflowactivationid))]),
  );
  const logs = {};
  for (const row of store.tableRows('workflowlog')) {
    const name = jobName.get(idOf(row.asyncoperationid));
    if (!name) continue;
    (logs[name] ??= []).push({
      stepname: row.stepname,
      activityname: row.activityname,
      status: row.status,
      errorcode: row.errorcode ?? null,
      message: row.message ?? null,
    });
  }
  output.logs = Object.fromEntries(
    Object.entries(logs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => [
        name,
        rows.sort((a, b) => a.activityname.localeCompare(b.activityname) || a.stepname.localeCompare(b.stepname)),
      ]),
  );
  if (itemId) {
    const item = store.tableRows('pqf6_wfitem').find((row) => idOf(row.pqf6_wfitemid) === itemId);
    output.item = {
      pqf6_stage: item.pqf6_stage ?? null,
      pqf6_result: item.pqf6_result ?? null,
      statecode: item.statecode,
      statuscode: item.statuscode,
      owner: role(item.ownerid),
      createdBy: role(item.createdby),
      createdOnBehalf: role(item.createdonbehalfby),
      modifiedBy: role(item.modifiedby),
      modifiedOnBehalf: role(item.modifiedonbehalfby),
    };
  }
  output.wflogs = store
    .tableRows('pqf6_wflog')
    .filter((row) => itemId && idOf(row.pqf6_wfitemid) === itemId)
    .map((row) => ({
      pqf6_name: row.pqf6_name,
      owner: role(row.ownerid),
      createdBy: role(row.createdby),
      createdOnBehalf: role(row.createdonbehalfby),
    }))
    .sort((a, b) => a.pqf6_name.localeCompare(b.pqf6_name));
  // Only what the recording read (input.scenario.observe): a real-time scenario was read before background work ran.
  for (const key of ['jobs', 'logs']) if (recorded.observe && !recorded.observe.includes(key)) delete output[key];
  return output;
}

const clockElapsed = (store) => store.clock.now() - T0;
