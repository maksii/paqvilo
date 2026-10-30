// Plug-in system jobs: asyncoperation rows for async steps, plugintracelog rows, the Custom API plug-in type route and the
// TriggerServiceEndpointCheck probe.
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import {
  pluginCatalogue,
  pluginHandlers,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesEntity,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { customApiHandlers, install as installCustomApis } from '../lib/dataverse-customapi.mjs';
import { install as installRegistration } from '../lib/dataverse-plugin-registration.mjs';

const WIDGET = 'bbbbbbbb-0000-4000-8000-000000000001';
const STEP = '5c0b0000-0000-4000-8000-000000000001';
const TYPE_ID = '5c0b0000-0000-4000-8000-000000000002';
const ASSEMBLY = '5c0b0000-0000-4000-8000-000000000003';
const TYPE = 'Contoso.Plugins.WidgetAudit';
const ROUTED_TYPE = 'Contoso.Plugins.RoutedApi';

const step = (over = {}) => ({
  id: STEP,
  name: 'Invented asynchronous audit',
  entity: 'contoso_widget',
  message: 'Create',
  enabled: true,
  stage: 40,
  rank: 1,
  mode: 1,
  typeName: TYPE,
  typeId: TYPE_ID,
  assemblyId: ASSEMBLY,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  ...over,
});

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'contoso_name',
    userConfigured: true,
    fields: { contoso_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.contoso_widget = [];
  return state;
}

// A store with the pipeline wired the way server.mjs wires it. With dataverse true the Dataverse API is started on it, which
// seeds the asyncoperation and plugintracelog tables; the runner then writes system jobs.
async function world({ dataverse, handlers, items: _items = () => [], traceLevel = null, steps = [] }) {
  const store = await new DataStore({ state: fixtureState() }).init();
  const diagnostics = [];
  const diagnostic = (entry) => diagnostics.push(entry);
  const api = dataverse
    ? await startDataverseApi({
        store,
        settings: dataverseSettings({ enabled: true }),
        log: () => {},
        extensions: [...EXTENSIONS],
      })
    : null;
  if (traceLevel !== null) {
    // The organization row: the Dataverse API seeds one; a store without the API gets a bare one.
    await store.transact(() => {
      const rows = (store.state.tables.organization ??= []);
      if (rows[0]) rows[0].plugintracelogsetting = traceLevel;
      else store.insertRow('organization', rows, { organizationid: 'org-1', plugintracelogsetting: traceLevel });
    });
  }
  const pluginSteps = () => pluginCatalogue({ plugins: { steps: [...steps] }, handlers });
  store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store, items: pluginSteps(), handlers, diagnostic }),
    ({ entity, operation }) =>
      pluginSteps().some(
        (item) =>
          item.enabled && pluginStepMatchesEntity(item, entity) && String(item.message).toLowerCase() === operation,
      ),
    (context) => pluginPhaseRequiresCheckpoint(pluginSteps(), context),
  );
  const runner = createAsyncPluginRunner({
    store,
    items: pluginSteps,
    handlers,
    runtimes: new Map(),
    diagnostic,
    systemJobs: () => Boolean(api),
  });
  return {
    store,
    api,
    runner,
    diagnostics,
    close: async () => {
      await runner.close();
      await api?.close();
    },
  };
}

describe('async steps write asyncoperation system jobs when the Dataverse API is on', () => {
  let world_;
  afterEach(async () => {
    await world_?.close();
    world_ = null;
  });

  it('a succeeded run ends Completed/Succeeded with the step, the regarding row and the System Event type', async () => {
    const handlers = pluginHandlers([{ id: 'invented', pluginSteps: { [STEP]: () => {} } }]);
    world_ = await world({ dataverse: true, handlers, steps: [step()] });
    await world_.store.create('contoso_widget', { contoso_widgetid: WIDGET, contoso_name: 'alpha' }, { admin: true });
    await world_.runner.drain();
    const [job] = world_.store.tableRows('asyncoperation');
    assert.equal(job.operationtype, 1);
    assert.equal(job.statecode, 3);
    assert.equal(job.statuscode, 30);
    assert.equal(job.owningextensionid.id, STEP);
    assert.equal(job.regardingobjectid.id, WIDGET);
    assert.equal(job.primaryentitytype, 'contoso_widget');
    assert.equal(job.messagename, 'Create');
    assert.equal(job.depth, 1);
    assert.ok(Date.parse(job.startedon) <= Date.parse(job.completedon), `${job.startedon} .. ${job.completedon}`);
  });

  it('a failing run ends Completed/Failed with the message, the friendly message and error code 0 for an error without a Dataverse code', async () => {
    const handlers = pluginHandlers([
      {
        id: 'invented',
        pluginSteps: {
          [STEP]: () => {
            throw new Error('Invented asynchronous rejection');
          },
        },
      },
    ]);
    world_ = await world({ dataverse: true, handlers, steps: [step()] });
    await world_.store.create('contoso_widget', { contoso_widgetid: WIDGET, contoso_name: 'beta' }, { admin: true });
    await world_.runner.drain();
    const [job] = world_.store.tableRows('asyncoperation');
    assert.equal(job.statecode, 3);
    assert.equal(job.statuscode, 31);
    assert.equal(job.message, 'Invented asynchronous rejection');
    assert.equal(job.friendlymessage, 'Invented asynchronous rejection');
    assert.equal(job.errorcode, 0);
  });

  it('asyncautodelete removes a succeeded job row only, and a failed one stays', async () => {
    const handlers = pluginHandlers([
      {
        id: 'invented',
        pluginSteps: {
          [STEP]: (args) => {
            if (args.record.contoso_name === 'fail') throw new Error('Invented');
          },
        },
      },
    ]);
    world_ = await world({ dataverse: true, handlers, steps: [step()] });
    await world_.store.transact(() =>
      world_.store.insertRow('sdkmessageprocessingstep', (world_.store.state.tables.sdkmessageprocessingstep ??= []), {
        sdkmessageprocessingstepid: STEP,
        asyncautodelete: true,
      }),
    );
    await world_.store.create('contoso_widget', { contoso_widgetid: WIDGET, contoso_name: 'ok' }, { admin: true });
    await world_.runner.drain();
    assert.equal(world_.store.tableRows('asyncoperation').length, 0);
    await world_.store.create(
      'contoso_widget',
      { contoso_widgetid: 'bbbbbbbb-0000-4000-8000-000000000002', contoso_name: 'fail' },
      { admin: true },
    );
    await world_.runner.drain();
    assert.deepEqual(
      world_.store.tableRows('asyncoperation').map((job) => job.statuscode),
      [31],
    );
  });
});

describe('the portal path is unchanged by system jobs', () => {
  it('a portal write that triggers an async step returns the same rows with the Dataverse API on and off; only the system job differs', async () => {
    const handlers = pluginHandlers([{ id: 'invented', pluginSteps: { [STEP]: () => {} } }]);
    const run = async (dataverse) => {
      // A fixed clock: createdon and modifiedon are stamped by the write, so both runs must see the same instant.
      mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T12:00:00Z') });
      let world_ = null;
      try {
        world_ = await world({ dataverse, handlers, steps: [step()] });
        const response = await world_.store.create(
          'contoso_widget',
          { contoso_widgetid: WIDGET, contoso_name: 'portal' },
          { admin: true },
        );
        await world_.runner.drain();
        return {
          response: JSON.stringify(response),
          widgets: JSON.stringify(world_.store.tableRows('contoso_widget')),
          jobs: (world_.store.state.tables.asyncoperation ?? []).length,
          completed: world_.diagnostics.filter((entry) => entry.code === 'PLUGIN_ASYNC_COMPLETED').length,
        };
      } finally {
        await world_?.close();
        mock.timers.reset();
      }
    };
    const off = await run(false);
    const on = await run(true);
    assert.equal(on.response, off.response);
    assert.equal(on.widgets, off.widgets);
    assert.equal(on.completed, off.completed);
    assert.equal(off.jobs, 0);
    assert.equal(on.jobs, 1);
  });
});

describe('plugintracelog follows organization.plugintracelogsetting', () => {
  const handlerWithTrace = (behaviour) =>
    pluginHandlers([
      {
        id: 'invented',
        pluginSteps: {
          [STEP]: ({ trace }) => {
            trace('Invented trace line');
            if (behaviour.fail) throw new Error('Invented trace failure');
          },
        },
      },
    ]);
  const syncStep = step({ mode: 0, stage: 20 });
  const write = (world_, name) =>
    world_.store.create('contoso_widget', { contoso_widgetid: WIDGET, contoso_name: name }, { admin: true });

  it('setting 2 keeps every execution with its trace lines and timing', async () => {
    const world_ = await world({ dataverse: true, handlers: handlerWithTrace({}), steps: [syncStep], traceLevel: 2 });
    try {
      await write(world_, 'all');
      const [row] = world_.store.tableRows('plugintracelog');
      assert.equal(row.typename, TYPE);
      assert.equal(row.messagename, 'Create');
      assert.equal(row.primaryentity, 'contoso_widget');
      assert.equal(row.messageblock, 'Invented trace line');
      assert.equal(row.mode, 0);
      assert.equal(row.depth, 1);
      assert.equal(row.exceptiondetails, null);
      assert.equal(row.pluginstepid.id, STEP);
      assert.equal(Number.isInteger(row.performanceexecutionduration), true);
    } finally {
      await world_.close();
    }
  });

  it('setting 1 keeps only failed executions, with their exception details', async () => {
    const world_ = await world({
      dataverse: true,
      handlers: handlerWithTrace({ fail: false }),
      steps: [syncStep],
      traceLevel: 1,
    });
    try {
      await write(world_, 'quiet');
      assert.equal(world_.store.tableRows('plugintracelog').length, 0);
    } finally {
      await world_.close();
    }
    const failing = await world({
      dataverse: true,
      handlers: handlerWithTrace({ fail: true }),
      steps: [syncStep],
      traceLevel: 1,
    });
    try {
      await assert.rejects(write(failing, 'loud'), /Invented trace failure/);
      assert.equal(
        failing.store.tableRows('plugintracelog').length,
        1,
        'the platform trace survives the failed business transaction',
      );
      assert.equal(failing.store.tableRows('contoso_widget').length, 0);
      assert.equal(failing.store.tableRows('plugintracelog')[0].exceptiondetails, 'Invented trace failure');
    } finally {
      await failing.close();
    }
    // An asynchronous failure runs after commit, so its trace row stays.
    const asyncFailing = await world({
      dataverse: true,
      handlers: handlerWithTrace({ fail: true }),
      steps: [step()],
      traceLevel: 1,
    });
    try {
      await write(asyncFailing, 'later');
      await asyncFailing.runner.drain();
      const rows = asyncFailing.store.tableRows('plugintracelog');
      assert.deepEqual(
        rows.map((row) => [row.mode, row.messageblock, row.exceptiondetails]),
        [[1, 'Invented trace line', 'Invented trace failure']],
      );
    } finally {
      await asyncFailing.close();
    }
  });

  it('setting 0 writes nothing, and a Dataverse-off store has no plugintracelog table to write to', async () => {
    const world_ = await world({ dataverse: true, handlers: handlerWithTrace({}), steps: [syncStep], traceLevel: 0 });
    try {
      await write(world_, 'off');
      assert.equal(world_.store.tableRows('plugintracelog').length, 0);
    } finally {
      await world_.close();
    }
    const portal = await world({ dataverse: false, handlers: handlerWithTrace({}), steps: [syncStep], traceLevel: 2 });
    try {
      await write(portal, 'portal');
      assert.equal(portal.store.state.tables.plugintracelog, undefined);
    } finally {
      await portal.close();
    }
  });

  it('a pluginTypes handler traces through context.trace as well', async () => {
    const handlers = pluginHandlers([
      {
        id: 'invented',
        pluginTypes: {
          [TYPE]: ({ context }) => {
            context.trace('Typed trace line');
          },
        },
      },
    ]);
    const world_ = await world({ dataverse: true, handlers, steps: [syncStep], traceLevel: 2 });
    try {
      await write(world_, 'typed');
      assert.equal(world_.store.tableRows('plugintracelog')[0].messageblock, 'Typed trace line');
    } finally {
      await world_.close();
    }
  });
});

describe('a Custom API whose plug-in type has a pluginTypes handler runs it', () => {
  const API_ID = 'cccccccc-0000-4000-8000-000000000001';
  const ADMIN = { systemuserid: 'aaaaaaaa-0000-4000-8000-000000000001' };
  const ORIGIN = 'http://127.0.0.1:5555';
  // A Custom API with no response properties (an action, 204). Its plugintypeid names the plug-in type ROUTED_TYPE.
  async function routed({ customApis = new Map(), typeName = ROUTED_TYPE } = {}) {
    const state = emptyState();
    state.tables.customapi = [
      {
        customapiid: API_ID,
        uniquename: 'sample_Routed',
        isfunction: false,
        bindingtype: 0,
        isprivate: false,
        plugintypeid: 'cccccccc-0000-4000-8000-000000000002',
      },
    ];
    state.tables.plugintype = [{ plugintypeid: 'cccccccc-0000-4000-8000-000000000002', typename: typeName }];
    state.tables.customapirequestparameter = [];
    state.tables.customapiresponseproperty = [];
    const store = new DataStore({ state });
    const ops = [];
    const grants = new Map();
    const registry = {
      register: (op) => ops.push(op),
      has: (name) => ops.some((o) => o.name === name),
      find: () => null,
    };
    const calls = [];
    // The Custom API context (name, inputs, target, caller, trace) is what a plug-in type handler receives for a custom API call.
    const pluginTypes = pluginHandlers([
      {
        id: 'invented',
        pluginTypes: {
          [ROUTED_TYPE]: (args) => {
            calls.push(args.name);
            return { outputs: { fromType: true } };
          },
        },
      },
    ]);
    // Awaited: install also queues its seeding transaction, which must not outlive the test.
    await installCustomApis(
      { store, change: (fn) => fn(), registry, principals: { privileges: () => grants } },
      { handlers: customApis, pluginTypes },
    ).ready;
    const op = ops.find((o) => o.name === 'sample_Routed');
    const call = () =>
      op.handle({
        method: 'POST',
        url: new URL('/api/data/v9.2/sample_Routed', ORIGIN),
        origin: ORIGIN,
        version: 'v9.2',
        params: {},
        body: {},
        user: ADMIN,
      });
    return { call, calls, store };
  }

  it('the type handler runs for the API and its messages name the type', async () => {
    const { call, calls } = await routed();
    const response = await call();
    assert.equal(response.status, 204);
    assert.deepEqual(calls, ['sample_Routed']);
  });

  it('a customApis entry for the same API takes precedence over the type handler', async () => {
    const used = [];
    const handlers = customApiHandlers([
      {
        id: 'p',
        customApis: {
          sample_Routed: () => {
            used.push('customApis');
            return { outputs: {} };
          },
        },
      },
    ]);
    const { call, calls } = await routed({ customApis: handlers });
    await call();
    assert.deepEqual(used, ['customApis']);
    assert.deepEqual(calls, []);
  });

  it('a plug-in type with no handler leaves the API without one and refuses its unavailable main operation', async () => {
    const { call, calls } = await routed({ typeName: 'Contoso.Plugins.Unhandled' });
    await assert.rejects(
      call(),
      (error) => error.status === 501 && error.code === 'LocalPluginMainOperationUnavailable',
    );
    assert.deepEqual(calls, []);
  });
});

describe('TriggerServiceEndpointCheck probes a loopback webhook endpoint', () => {
  let server;
  // Awaited, so the next test starts only after the endpoint stopped listening and dropped its connections.
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    server = null;
  });

  // install registers the action; the probe is called with the endpoint row as its bound target.
  function action() {
    const ops = [];
    installRegistration({
      store: new DataStore({ state: emptyState() }),
      recordHooks: { add() {} },
      registry: { register: (op) => ops.push(op) },
      principals: {},
      settings: {},
    });
    return ops.find((op) => op.name === 'TriggerServiceEndpointCheck');
  }
  const probe = (row) => action().handle({ target: { id: 'row', row }, body: {}, user: { systemuserid: 'x' } });

  it('a loopback webhook that answers 2xx is 204, and it receives a POST', async () => {
    const seen = [];
    server = createServer((req, res) => {
      seen.push(req.method);
      res.writeHead(200);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    assert.deepEqual(await probe({ contract: 8, url: `http://127.0.0.1:${port}/hook` }), { status: 204 });
    assert.deepEqual(seen, ['POST']);
  });

  it('a loopback endpoint that fails is refused with the endpoint error', async () => {
    server = createServer((req, res) => {
      res.writeHead(500);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await assert.rejects(
      probe({ contract: 8, url: `http://127.0.0.1:${server.address().port}/hook` }),
      (error) => error.status === 400 && /Endpoint unavailable/.test(error.message),
    );
  });

  it('a non-loopback URL and another contract are never contacted', async () => {
    const seen = [];
    server = createServer((req, res) => {
      seen.push(req.method);
      res.writeHead(200);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    await assert.rejects(probe({ contract: 8, url: 'https://example.test/hook' }), (error) => error.status === 400);
    await assert.rejects(
      probe({ contract: 2, url: `http://127.0.0.1:${server.address().port}/hook` }),
      (error) => error.status === 400,
    );
    assert.deepEqual(seen, []);
  });
});
