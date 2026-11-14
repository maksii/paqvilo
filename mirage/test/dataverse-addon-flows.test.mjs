// Desktop flow messages (lib/dataverse-addon-flows.mjs) over HTTP: run with a pack handler, run without one, cancel, save as,
// leave group and the flow machine groups.
// @test-kind contract: Paqvilo's designed desktop flow behaviour; the store-backed answers and their error codes are guesses listed in the module.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { addonHandlerExtension, addonHandlers } from '../lib/dataverse-addon-common.mjs';
import { install } from '../lib/dataverse-addon-flows.mjs';
import { createFlowRunStore } from '../lib/flow-runs.mjs';

const APP_ID = '66666666-6666-6666-6666-666666666666';
const SECRET_VAR = 'PAQVILO_FLOWS_SECRET';
const VERSION = 'v9.2';
const id = (n) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const W = { run: id(1), handled: id(2), cancel: id(3), saveAs: id(4), addRequired: id(5), runs: id(6) };
const S = { running: id(10), done: id(11), paused: id(12), fresh: id(13), unauthenticated: id(14) };
const G = { busy: id(20), empty: id(21), leave: id(22) };
const M = { leave: id(30), busy: id(31), fresh: id(32) };
const MODULE = id(40);
const SOLUTION = id(50);
const OTHER_OWNER = id(81);
const SOURCE_VERSION = 42;

const SEED = {
  workflow: [
    { workflowid: W.run, name: 'Invented flow run', statecode: 1, statuscode: 2, category: 6 },
    { workflowid: W.handled, name: 'Invented flow with handler', statecode: 1, statuscode: 2 },
    { workflowid: W.cancel, name: 'Invented flow cancel', statecode: 1, statuscode: 2 },
    {
      workflowid: W.saveAs,
      name: 'Invented flow to copy',
      statecode: 1,
      statuscode: 2,
      uniquename: 'contoso_copy',
      ownerid: { id: OTHER_OWNER, logical_name: 'systemuser' },
      versionnumber: SOURCE_VERSION,
    },
    { workflowid: W.addRequired, name: 'Invented flow in solution', statecode: 1, statuscode: 2 },
    { workflowid: W.runs, name: 'Invented flow with runs', statecode: 1, statuscode: 2 },
  ],
  flowsession: [
    { flowsessionid: S.running, regardingobjectid: W.cancel, statuscode: 2, statecode: 0, triggertype: 3 },
    { flowsessionid: S.done, regardingobjectid: W.cancel, statuscode: 4, statecode: 1, triggertype: 3 },
    { flowsessionid: S.paused, regardingobjectid: W.cancel, statuscode: 1, statecode: 0, triggertype: 3 },
    { flowsessionid: S.fresh, regardingobjectid: W.cancel, statuscode: 2, statecode: 0, triggertype: 3 },
    { flowsessionid: S.unauthenticated, regardingobjectid: W.cancel, statuscode: 2, statecode: 0, triggertype: 3 },
  ],
  flowmachinegroup: [
    { flowmachinegroupid: G.busy, name: 'Invented busy group', statecode: 0, statuscode: 1 },
    { flowmachinegroupid: G.empty, name: 'Invented empty group', statecode: 0, statuscode: 1 },
    { flowmachinegroupid: G.leave, name: 'Invented group to leave', statecode: 0, statuscode: 1 },
  ],
  flowmachine: [
    { flowmachineid: M.leave, name: 'Invented machine', flowmachinegroupid: G.leave, statecode: 0, statuscode: 1 },
    {
      flowmachineid: M.busy,
      name: 'Invented machine in busy group',
      flowmachinegroupid: G.busy,
      statecode: 0,
      statuscode: 1,
    },
    {
      flowmachineid: M.fresh,
      name: 'Invented second machine',
      flowmachinegroupid: G.leave,
      statecode: 0,
      statuscode: 1,
    },
  ],
  desktopflowmodule: [{ desktopflowmoduleid: MODULE, name: 'Invented module', statecode: 0, statuscode: 1 }],
  solution: [{ solutionid: SOLUTION, uniquename: 'contoso_solution', statecode: 0, statuscode: 1 }],
  solutioncomponent: [
    { solutioncomponentid: id(60), solutionid: SOLUTION, objectid: W.addRequired, componenttype: 29 },
  ],
  flowrun: [{ flowrunid: id(70), workflowid: W.runs, name: 'Invented run', status: 'Running' }],
};

// The handler waits for `gate`, so a test can hold a run in flight.
let gate = Promise.resolve();
const handlerPack = {
  id: 'flows-pack',
  dataverseMessages: {
    RunDesktopFlow: async (ctx) => {
      await gate;
      return { status: 'Succeeded', outputs: { echo: ctx.args.inputs ?? null } };
    },
  },
};

describe('desktop flow messages over HTTP', () => {
  let api;
  let store;
  let token;

  // A started API with the given packs and the seed rows. Returns its store and token; the main API's pair is kept in the vars.
  async function start(packs) {
    process.env[SECRET_VAR] = 'flows-secret';
    const seeded = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Flows app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    const started = await startDataverseApi({
      store: seeded,
      settings,
      log: () => {},
      extensions: [...EXTENSIONS, addonHandlerExtension(addonHandlers(packs))],
    });
    const response = await fetch(`${started.origin}/${started.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${started.origin}/.default`,
      }),
    });
    const accessToken = (await response.json()).access_token;
    await seeded.transact(() => {
      for (const [logical, rows] of Object.entries(SEED)) {
        seeded.state.tables[logical] ??= [];
        seeded.state.tables[logical].push(...rows);
      }
    });
    return { started, accessToken, store: seeded };
  }

  before(async () => {
    const withPack = await start([handlerPack]);
    api = withPack.started;
    token = withPack.accessToken;
    store = withPack.store;
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  const rowOf = (logical, pk, value) => store.state.tables[logical].find((row) => row[pk] === value);
  // A bound call: POST <entitySet>(<id>)/Microsoft.Dynamics.CRM.<name>. Returns the status and the JSON body.
  async function call(set, key, name, body = {}) {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${set}(${key})/Microsoft.Dynamics.CRM.${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : null };
  }

  it('every flow message is declared in $metadata', async () => {
    const metadata = await (
      await fetch(`${api.origin}/api/data/${VERSION}/$metadata`, { headers: { authorization: `Bearer ${token}` } })
    ).text();
    for (const name of [
      'RunDesktopFlow',
      'CancelDesktopFlowRun',
      'SaveAsDesktopFlow',
      'LeaveGroup',
      'GetHostedRpaCapacity',
      'RetrieveConnectorSettings',
    ]) {
      assert.match(metadata, new RegExp(`Name="${name}"`), name);
    }
    assert.match(metadata, /Name="RunDesktopFlowResponse"/);
  });

  it('run creates a session and the pack handler completes it as a task of the API scheduler', async () => {
    const held = Promise.withResolvers();
    gate = held.promise;
    const result = await call('workflows', W.handled, 'RunDesktopFlow', {
      inputs: '{"a":1}',
      connectionType: 1,
      timeout: 60,
    });
    assert.equal(result.status, 200);
    assert.match(result.body.flowsessionId, /^[0-9a-f-]{36}$/);
    assert.equal(result.body.licenseCheck.code, 'ValidLicenseCoverage');
    const session = () => rowOf('flowsession', 'flowsessionid', result.body.flowsessionId);
    assert.equal(session().regardingobjectid, W.handled);
    assert.equal(session().triggertype, 3);
    // The handler runs after the answer as a task of the API scheduler (queued or running, never an untracked timer),
    // so it is cancelled with the API and drain() settles it.
    assert.equal(session().statuscode, 2);
    assert.equal(store.scheduler.status().pending, 1);
    held.resolve();
    gate = Promise.resolve();
    await store.scheduler.drain();
    assert.equal(store.scheduler.status().pending, 0);
    assert.equal(session().statuscode, 4);
    assert.equal(session().outputs, '{"echo":"{\\"a\\":1}"}');
    assert.ok(session().completedon);
  });

  it('run without a handler is FeatureNotEnabled', async () => {
    const bare = await start([]);
    try {
      const result = await fetch(
        `${bare.started.origin}/api/data/${VERSION}/workflows(${W.run})/Microsoft.Dynamics.CRM.RunDesktopFlow`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${bare.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ connectionType: 1 }),
        },
      );
      const body = await result.json();
      assert.equal(result.status, 400);
      assert.equal(
        body.error.message,
        "This operation couldn't be completed because this feature isn’t enabled for your organization.",
      );
    } finally {
      await bare.started.close();
    }
  });

  it('cancel sets Cancelled only from Paused, Running or Waiting', async () => {
    const result = await call('flowsessions', S.running, 'CancelDesktopFlowRun');
    assert.equal(result.status, 204);
    assert.equal(rowOf('flowsession', 'flowsessionid', S.running).statuscode, 7);
    assert.ok(rowOf('flowsession', 'flowsessionid', S.running).completedon);
    assert.equal((await call('flowsessions', S.paused, 'CancelDesktopFlowRun')).status, 204);
    assert.equal((await call('flowsessions', S.done, 'CancelDesktopFlowRun')).status, 400);
    assert.equal(rowOf('flowsession', 'flowsessionid', S.done).statuscode, 4);
  });

  it('save as clones the flow under a new id and name', async () => {
    const result = await call('workflows', W.saveAs, 'SaveAsDesktopFlow', { desktopFlowName: 'Invented copy' });
    assert.equal(result.status, 200);
    const copy = rowOf('workflow', 'workflowid', result.body.workflowId);
    assert.equal(copy.name, 'Invented copy');
    assert.equal(copy.statecode, 0);
    assert.notEqual(copy.workflowid, W.saveAs);
    assert.ok(rowOf('workflow', 'workflowid', W.saveAs), 'the source stays');
    const module = await call('desktopflowmodules', MODULE, 'SaveAsDesktopFlowModule', {
      desktopFlowModuleName: 'Invented module copy',
    });
    assert.equal(module.status, 200);
    assert.equal(
      rowOf('desktopflowmodule', 'desktopflowmoduleid', module.body.desktopflowmoduleid).name,
      'Invented module copy',
    );
  });

  it('add required components adds the flow to its solutions with the required components', async () => {
    const result = await call('workflows', W.addRequired, 'AddRequiredDesktopFlowComponentsToSolutions');
    assert.equal(result.status, 204);
    assert.equal(store.state.tables.solutioncomponent.filter((row) => row.objectid === W.addRequired).length, 1);
  });

  it('cancel all cloud flow runs cancels the open runs of the flow', async () => {
    const result = await call('workflows', W.runs, 'CancelAllCloudFlowRuns');
    assert.equal(result.status, 204);
    assert.equal(rowOf('flowrun', 'flowrunid', id(70)).status, 'Cancelled');
  });

  it('leave group creates a default group and moves the machine to it', async () => {
    const result = await call('flowmachines', M.leave, 'LeaveGroup');
    assert.equal(result.status, 204);
    const machine = rowOf('flowmachine', 'flowmachineid', M.leave);
    assert.notEqual(machine.flowmachinegroupid, G.leave);
    assert.ok(rowOf('flowmachinegroup', 'flowmachinegroupid', machine.flowmachinegroupid), 'the new group exists');
  });

  it('delete flow machine group refuses a group that still has machines', async () => {
    const busy = await call('flowmachinegroups', G.busy, 'DeleteFlowMachineGroup');
    assert.equal(busy.status, 400);
    assert.ok(rowOf('flowmachinegroup', 'flowmachinegroupid', G.busy));
    const empty = await call('flowmachinegroups', G.empty, 'DeleteFlowMachineGroup');
    assert.equal(empty.status, 204);
    assert.equal(rowOf('flowmachinegroup', 'flowmachinegroupid', G.empty), undefined);
  });

  it('cancel all cloud flow runs stamps each cancelled run with the caller and a new version', async () => {
    const adminId = await callerId();
    await store.transact(() => {
      store.state.tables.flowrun.push({
        flowrunid: id(71),
        workflowid: W.runs,
        name: 'Invented open run',
        status: 'Running',
      });
    });
    assert.equal((await call('workflows', W.runs, 'CancelAllCloudFlowRuns')).status, 204);
    const run = rowOf('flowrun', 'flowrunid', id(71));
    assert.equal(run.status, 'Cancelled');
    assert.equal(run.modifiedby?.id ?? run.modifiedby, adminId);
    assert.equal(typeof run.versionnumber, 'number', 'the cancelled run has a version');
  });

  // A fresh organization whose flow runs table has the given table type (the mapping's own when not given). The runs are
  // read, then the second update of the cancel fails. Returns the response, the failed answer and the two runs before and after.
  async function cancelWithSecondUpdateFailing(tableType = null) {
    const fresh = await start([handlerPack]);
    const freshStore = fresh.store;
    if (tableType) freshStore.state.mappings.flowrun.tableType = tableType;
    await freshStore.transact(() => {
      freshStore.state.tables.flowrun.push({
        flowrunid: id(72),
        workflowid: W.runs,
        name: 'Invented second run',
        status: 'Running',
      });
    });
    const runsOf = () =>
      [id(70), id(72)].map((run) => {
        const row = freshStore.state.tables.flowrun.find((item) => item.flowrunid === run);
        return { status: row.status, modifiedby: row.modifiedby, versionnumber: row.versionnumber };
      });
    const before = runsOf();
    let updates = 0;
    const failingWrite =
      (write) =>
      (...args) => {
        updates += 1;
        if (updates === 2) throw new Error('Invented fault');
        return write.apply(freshStore, args);
      };
    const { updateRecord, updateRecordAsync } = freshStore;
    freshStore.updateRecord = failingWrite(updateRecord);
    freshStore.updateRecordAsync = failingWrite(updateRecordAsync);
    let response;
    try {
      response = await fetch(
        `${fresh.started.origin}/api/data/${VERSION}/workflows(${W.runs})/Microsoft.Dynamics.CRM.CancelAllCloudFlowRuns`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
          body: '{}',
        },
      );
    } finally {
      freshStore.updateRecord = updateRecord;
      freshStore.updateRecordAsync = updateRecordAsync;
      await fresh.started.close();
    }
    return { updates, response, body: await response.json(), before, after: runsOf() };
  }

  // @test-kind compatibility: elastic tables do not support multi-record transactions, so a write to an elastic row is not rolled back with a later failing write, https://learn.microsoft.com/power-apps/developer/data-platform/elastic-tables#transactional-behavior
  it('cancel all cloud flow runs keeps the elastic runs updated before a failed update, and the failed run unchanged', async () => {
    const adminId = await callerId();
    const { updates, response, body, before, after } = await cancelWithSecondUpdateFailing();
    assert.equal(updates, 2, 'the cancel reached the second update');
    assert.ok(response.status >= 400, `the message answers the failure (${response.status})`);
    assert.ok(body.error, 'the failure is answered as an error');
    assert.equal(after[0].status, 'Cancelled', 'the run updated before the failure stays cancelled');
    assert.equal(after[0].modifiedby?.id ?? after[0].modifiedby, adminId, 'the caller is the modifier');
    assert.equal(typeof after[0].versionnumber, 'number', 'the cancelled run has a new version');
    assert.deepEqual(after[1], before[1], 'the run whose update failed is unchanged');
  });

  // The same fault on a standard table: the transaction rolls every update back, so the first run keeps its status, modifier and version.
  it('cancel all cloud flow runs rolls back every earlier update when the flow runs table is a standard table', async () => {
    const { updates, response, body, before, after } = await cancelWithSecondUpdateFailing('Standard');
    assert.equal(updates, 2, 'the cancel reached the second update');
    assert.ok(response.status >= 400, `the message answers the failure (${response.status})`);
    assert.ok(body.error, 'the failure is answered as an error');
    assert.deepEqual(after, before, 'no run is changed');
  });

  it('cancel all cloud flow runs writes nothing when a later run cannot be read', async () => {
    const fresh = await start([handlerPack]);
    const freshStore = fresh.store;
    await freshStore.transact(() => {
      freshStore.state.tables.flowrun.push({
        flowrunid: id(72),
        workflowid: W.runs,
        name: 'Invented readable run',
        status: 'Running',
      });
    });
    const unreadable = { flowrunid: id(73), name: 'Invented unreadable run', status: 'Running' };
    Object.defineProperty(unreadable, 'workflowid', {
      enumerable: true,
      get() {
        throw new Error('Invented fault');
      },
    });
    freshStore.state.tables.flowrun.push(unreadable);
    try {
      const response = await fetch(
        `${fresh.started.origin}/api/data/${VERSION}/workflows(${W.runs})/Microsoft.Dynamics.CRM.CancelAllCloudFlowRuns`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${fresh.accessToken}`, 'content-type': 'application/json' },
          body: '{}',
        },
      );
      assert.notEqual(response.status, 204);
    } finally {
      await fresh.started.close();
    }
    for (const run of [id(70), id(72)]) {
      const row = freshStore.state.tables.flowrun.find((item) => item.flowrunid === run);
      assert.equal(row.status, 'Running', 'no run is cancelled when a later run cannot be read');
      assert.equal(row.versionnumber, undefined);
    }
  });

  // Records the table of each delete the store hands to its recycle collector, which runs as the Web API delete does.
  function recordRecycled(recycled, collect = store.recycleDeleted) {
    store.recycleDeleted = (entries, identity) => {
      recycled.push(entries.at(-1).logicalName);
      return collect?.(entries, identity);
    };
    return () => {
      store.recycleDeleted = collect;
    };
  }

  it('delete flow machine group deletes its row through the store, as a Web API delete does', async () => {
    const recycled = [];
    const restore = recordRecycled(recycled);
    try {
      const spare = id(23);
      store.state.tables.flowmachinegroup.push({
        flowmachinegroupid: spare,
        name: 'Invented spare group',
        statecode: 0,
        statuscode: 1,
      });
      assert.equal((await call('flowmachinegroups', spare, 'DeleteFlowMachineGroup')).status, 204);
      assert.equal(rowOf('flowmachinegroup', 'flowmachinegroupid', spare), undefined);
      assert.deepEqual(recycled, ['flowmachinegroup']);
      const webApi = id(24);
      store.state.tables.flowmachinegroup.push({
        flowmachinegroupid: webApi,
        name: 'Invented web group',
        statecode: 0,
        statuscode: 1,
      });
      const deleted = await fetch(`${api.origin}/api/data/${VERSION}/flowmachinegroups(${webApi})`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(deleted.status, 204);
      assert.deepEqual(recycled, ['flowmachinegroup', 'flowmachinegroup']);
    } finally {
      restore();
    }
  });

  it('delete flow machine group leaves the group in place when the store delete fails', async () => {
    const spare = id(25);
    store.state.tables.flowmachinegroup.push({
      flowmachinegroupid: spare,
      name: 'Invented kept group',
      statecode: 0,
      statuscode: 1,
    });
    const restore = recordRecycled([], () => {
      throw new Error('Invented fault');
    });
    try {
      assert.notEqual((await call('flowmachinegroups', spare, 'DeleteFlowMachineGroup')).status, 204);
    } finally {
      restore();
    }
    assert.ok(rowOf('flowmachinegroup', 'flowmachinegroupid', spare), 'the delete rolled back');
  });
  // The systemuser of the caller, as WhoAmI names it.
  async function callerId() {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/WhoAmI`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return (await result.json()).UserId;
  }

  // The caller's owner, audit stamps and version are written by the record layer, as a Web API write writes them.
  // @test-kind contract: the desktop flow writes stamp the caller and its own version, never the source row's (R1-8)
  it('save as copies the flow owned and stamped by the caller, with a version of its own', async () => {
    const adminId = await callerId();
    const result = await call('workflows', W.saveAs, 'SaveAsDesktopFlow', { desktopFlowName: 'Invented owned copy' });
    assert.equal(result.status, 200);
    const copy = rowOf('workflow', 'workflowid', result.body.workflowId);
    assert.equal(copy.ownerid?.id ?? copy.ownerid, adminId, 'the copy is owned by the caller');
    assert.equal(copy.createdby?.id ?? copy.createdby, adminId, 'the copy names the caller as its creator');
    assert.notEqual(copy.versionnumber, SOURCE_VERSION, 'the copy has a version of its own');
  });

  // @test-kind contract: a cancel and a leave-group write advance the row version and name the caller as its modifier (R1-8)
  it('cancel and leave group advance the row version and name the caller as the modifier', async () => {
    const adminId = await callerId();
    assert.equal((await call('flowsessions', S.fresh, 'CancelDesktopFlowRun')).status, 204);
    const session = rowOf('flowsession', 'flowsessionid', S.fresh);
    assert.equal(session.statuscode, 7);
    assert.equal(session.modifiedby?.id ?? session.modifiedby, adminId);
    assert.equal(typeof session.versionnumber, 'number', 'the cancelled session has a version');
    assert.equal((await call('flowmachines', M.fresh, 'LeaveGroup')).status, 204);
    const machine = rowOf('flowmachine', 'flowmachineid', M.fresh);
    assert.equal(machine.modifiedby?.id ?? machine.modifiedby, adminId);
    assert.equal(typeof machine.versionnumber, 'number', 'the moved machine has a version');
  });

  // @test-kind security: a flow message called without a user has no grant and is refused before any write (R1-8)
  it('a flow message called without a user is refused with 403 and changes no row', async () => {
    const operation = api.organization.registry.find({
      name: 'CancelDesktopFlowRun',
      kind: 'action',
      binding: 'entity',
      entity: 'flowsession',
    });
    assert.ok(operation, 'CancelDesktopFlowRun is registered');
    const before = JSON.stringify(store.state.tables.flowsession);
    await assert.rejects(
      operation.handle({
        user: undefined,
        caller: null,
        target: { id: S.unauthenticated, logicalName: 'flowsession' },
        body: {},
        identity: {},
        origin: api.origin,
        version: VERSION,
        url: new URL(
          `${api.origin}/api/data/${VERSION}/flowsessions(${S.fresh})/Microsoft.Dynamics.CRM.CancelDesktopFlowRun`,
        ),
      }),
      (error) => error.status === 403,
    );
    assert.equal(JSON.stringify(store.state.tables.flowsession), before);
    assert.equal(rowOf('flowsession', 'flowsessionid', S.unauthenticated).statuscode, 2);
  });
});

describe('cancel all cloud flow runs is one write', () => {
  it('a fault after the flow run store cancels nothing: the cancel rolls back with the row write', async () => {
    const state = emptyState();
    state.tables.workflow = [{ workflowid: W.runs, name: 'Invented flow with runs', statecode: 1, statuscode: 2 }];
    state.tables.flowrun = [{ flowrunid: id(71), workflowid: W.runs, name: 'Invented open row', status: 'Running' }];
    const store = await new DataStore({ state }).init();
    const flowRuns = createFlowRunStore({ store, diagnostic: () => {} });
    const run = await flowRuns.start({ processId: W.runs });
    // The second step cannot read a row: the poisoned row is appended after the flow run cancel, so the row loop throws.
    const cancelAll = flowRuns.cancelAll;
    flowRuns.cancelAll = async (processId) => {
      const count = await cancelAll(processId);
      const poisoned = { flowrunid: id(72), name: 'Invented poisoned row', status: 'Running' };
      Object.defineProperty(poisoned, 'workflowid', {
        enumerable: true,
        get() {
          throw new Error('Invented fault');
        },
      });
      store.state.tables.flowrun.push(poisoned);
      return count;
    };
    const registered = new Map();
    const api = {
      store,
      clock: () => 0,
      change: (fn) => fn(),
      flowRuns,
      registry: { register: (spec) => registered.set(spec.name, spec) },
    };
    install(api);
    await assert.rejects(registered.get('CancelAllCloudFlowRuns').handle({ target: { id: W.runs } }), /Invented fault/);
    assert.equal(flowRuns.get(run.id).status, 'Running', 'the flow run cancel rolled back');
    assert.equal(store.state.tables.flowrun.find((row) => row.flowrunid === id(71)).status, 'Running');
  });
});

// @test-kind security: a bound message checks the target row's privileges before it writes, as the CRUD path does for the same row.
describe('bound desktop flow messages check the row privileges of their target', () => {
  const ADMIN_APP = '77777777-7777-4777-8777-777777777777';
  const BASIC_APP = '88888888-8888-4888-8888-888888888888';
  const ADMIN_SECRET = 'PAQVILO_FLOWS_ADMIN_SECRET';
  const BASIC_SECRET = 'PAQVILO_FLOWS_BASIC_SECRET';
  const OWNER_COLUMNS = new Set(['ownerid', 'owninguser', 'owningteam', 'owningbusinessunit']);
  const TABLES = ['flowmachinegroup', 'flowmachine', 'workflow', 'flowsession', 'desktopflowmodule'];
  const SESSION = id(80);
  const MACHINE = id(81);
  let api;
  let store;
  let admin;
  let basic;
  let rows;

  // One request as a token holder; a 204 answer has no body.
  async function send(token, method, path, body) {
    const result = await fetch(`${api.origin}/api/data/${VERSION}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await result.text();
    return { status: result.status, body: text ? JSON.parse(text) : null };
  }
  const bound = (token, set, key, name, body = {}) =>
    send(token, 'POST', `${set}(${key})/Microsoft.Dynamics.CRM.${name}`, body);
  const snapshot = () => JSON.stringify(TABLES.map((name) => store.state.tables[name] ?? []));

  async function tokenFor(appId, secretVar) {
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: process.env[secretVar],
        scope: `${api.origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  // The admin creates the group, flow and module; the session and the machine are seeded with the group's owner columns,
  // so they are owned by the administrator as the group is.
  async function seedRows() {
    const busy = (await send(admin, 'POST', 'flowmachinegroups', { name: 'Invented busy group' })).body
      .flowmachinegroupid;
    const empty = (await send(admin, 'POST', 'flowmachinegroups', { name: 'Invented empty group' })).body
      .flowmachinegroupid;
    const workflow = (
      await send(admin, 'POST', 'workflows', { name: 'Invented flow', category: 6, statecode: 1, statuscode: 2 })
    ).body.workflowid;
    const module = (await send(admin, 'POST', 'desktopflowmodules', { name: 'Invented module' })).body
      .desktopflowmoduleid;
    await store.transact(() => {
      const groupRow = store.state.tables.flowmachinegroup.find((row) => row.flowmachinegroupid === busy);
      const owner = Object.fromEntries(Object.entries(groupRow).filter(([name]) => OWNER_COLUMNS.has(name)));
      store.state.tables.flowsession.push({
        ...owner,
        flowsessionid: SESSION,
        regardingobjectid: workflow,
        statuscode: 2,
        statecode: 0,
        triggertype: 3,
      });
      store.state.tables.flowmachine.push({
        ...owner,
        flowmachineid: MACHINE,
        name: 'Invented machine',
        flowmachinegroupid: busy,
        statecode: 0,
        statuscode: 1,
      });
    });
    return { busy, empty, workflow, module };
  }

  before(async () => {
    process.env[ADMIN_SECRET] = 'flows-admin-secret';
    process.env[BASIC_SECRET] = 'flows-basic-secret';
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: ADMIN_APP,
          displayName: 'Flows admin',
          secretEnvironmentVariable: ADMIN_SECRET,
          roles: ['System Administrator'],
        },
        {
          appId: BASIC_APP,
          displayName: 'Flows basic',
          secretEnvironmentVariable: BASIC_SECRET,
          roles: ['Basic User'],
        },
      ],
    });
    api = await startDataverseApi({
      store,
      settings,
      log: () => {},
      extensions: [...EXTENSIONS, addonHandlerExtension(addonHandlers([handlerPack]))],
    });
    admin = await tokenFor(ADMIN_APP, ADMIN_SECRET);
    basic = await tokenFor(BASIC_APP, BASIC_SECRET);
    rows = await seedRows();
  });

  after(async () => {
    delete process.env[ADMIN_SECRET];
    delete process.env[BASIC_SECRET];
    await api?.close();
  });

  // @test-kind security: a Basic User cannot run a bound message against an admin-owned row
  it('each bound message answers 403 for a Basic User on an admin-owned row and changes no row', async () => {
    const unchanged = snapshot();
    const refused = [
      await bound(basic, 'workflows', rows.workflow, 'RunDesktopFlow', { connectionType: 1, inputs: '{}' }),
      await bound(basic, 'flowsessions', SESSION, 'CancelDesktopFlowRun'),
      await bound(basic, 'workflows', rows.workflow, 'SaveAsDesktopFlow', { desktopFlowName: 'Invented copy' }),
      await bound(basic, 'desktopflowmodules', rows.module, 'SaveAsDesktopFlowModule', {
        desktopFlowModuleName: 'Invented module copy',
      }),
      await bound(basic, 'workflows', rows.workflow, 'CancelAllCloudFlowRuns'),
      await bound(basic, 'flowmachines', MACHINE, 'LeaveGroup'),
      await bound(basic, 'flowmachinegroups', rows.empty, 'DeleteFlowMachineGroup'),
    ];
    assert.deepEqual(
      refused.map((result) => result.status),
      [403, 403, 403, 403, 403, 403, 403],
    );
    assert.equal(snapshot(), unchanged);
  });

  // @test-kind security: the message cannot delete a row the caller is not allowed to delete
  it('the refusal of DeleteFlowMachineGroup is the CRUD delete refusal of the same row', async () => {
    const crud = await send(basic, 'DELETE', `flowmachinegroups(${rows.empty})`);
    const bound403 = await bound(basic, 'flowmachinegroups', rows.empty, 'DeleteFlowMachineGroup');
    assert.equal(crud.status, 403);
    assert.deepEqual(bound403.body, crud.body);
  });

  // @test-kind security: a Basic User cannot add required components on an admin-owned flow or module, and no row changes.
  it('the AddRequired messages answer 403 for a Basic User on an admin-owned flow and module', async () => {
    const unchanged = snapshot();
    const flow = await bound(basic, 'workflows', rows.workflow, 'AddRequiredDesktopFlowComponentsToSolutions');
    const module = await bound(
      basic,
      'desktopflowmodules',
      rows.module,
      'AddRequiredUIElementCollectionComponentsToSolutions',
    );
    assert.equal(flow.status, 403);
    assert.equal(module.status, 403);
    assert.equal(snapshot(), unchanged);
  });

  it('the administrator still gets the success status of each message', async () => {
    assert.equal((await bound(admin, 'workflows', rows.workflow, 'RunDesktopFlow', { connectionType: 1 })).status, 200);
    await store.scheduler.drain();
    assert.equal((await bound(admin, 'flowsessions', SESSION, 'CancelDesktopFlowRun')).status, 204);
    assert.equal(
      (await bound(admin, 'workflows', rows.workflow, 'SaveAsDesktopFlow', { desktopFlowName: 'Copy' })).status,
      200,
    );
    assert.equal(
      (
        await bound(admin, 'desktopflowmodules', rows.module, 'SaveAsDesktopFlowModule', {
          desktopFlowModuleName: 'Copy',
        })
      ).status,
      200,
    );
    assert.equal((await bound(admin, 'workflows', rows.workflow, 'CancelAllCloudFlowRuns')).status, 204);
    assert.equal((await bound(admin, 'flowmachines', MACHINE, 'LeaveGroup')).status, 204);
    assert.equal((await bound(admin, 'flowmachinegroups', rows.empty, 'DeleteFlowMachineGroup')).status, 204);
  });
});
