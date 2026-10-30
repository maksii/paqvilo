// @test-kind unproven: local model of Dataverse-triggered cloud flow hosting; no native capture cited
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { committedJobs } from '../lib/committed-work.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createScheduler, fixedClock, sequentialIds, storeScheduler } from '../lib/runtime-clock.mjs';
import { createConnectorRuntime } from '../lib/connector-runtime.mjs';
import { createHostFlowRuns } from '../lib/flow-runs.mjs';
import { createFlowTriggerRunner, nextOccurrence } from '../lib/flow-triggers.mjs';
import { inspectFlowTrigger } from '../lib/flow-runtime.mjs';
import { operationCatalogue } from '../lib/operation-catalogue.mjs';
import { createFlowRoutes } from '../lib/sim-flow-routes.mjs';
import { serveRoutes } from './support/route-server.mjs';
import { PACK_EXPORTS } from '../lib/pack-exports.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

// Recurrence and pack connector triggers are hosted by the trigger runner (opt-in: exported mode plus explicit
// local activation); HTTP Request and manual flows start on demand through /_sim/api.
const RECURRING = '77777777-7777-4777-8777-0000000000a1',
  HOOKED = '77777777-7777-4777-8777-0000000000a2';
const BUTTON = '77777777-7777-4777-8777-0000000000a3',
  HTTP_FLOW = '77777777-7777-4777-8777-0000000000a4';
const API = '/providers/Microsoft.PowerApps/apis/shared_fx-5fapi';
const wrap = (definition) => ({
  file: '/invented/flow.json',
  active: true,
  definition: { properties: { definition } },
});
const compose = { Note: { type: 'Compose', runAfter: {}, inputs: "@coalesce(triggerBody()?['x_name'], 'tick')" } };
const WORKFLOWS = {
  [RECURRING]: wrap({
    triggers: { tick: { type: 'Recurrence', recurrence: { frequency: 'Hour', interval: 1 } } },
    actions: compose,
  }),
  [HOOKED]: wrap({
    triggers: {
      hook: {
        type: 'OpenApiConnectionWebhook',
        inputs: { host: { apiId: API, operationId: 'OnNewItem' }, parameters: { x_folder: 'inbox' } },
      },
    },
    actions: compose,
  }),
  [BUTTON]: wrap({
    triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } },
    actions: {
      ...compose,
      Reply: {
        type: 'Response',
        runAfter: { Note: ['Succeeded'] },
        inputs: { statusCode: 200, body: "@outputs('Note')" },
      },
    },
  }),
  [HTTP_FLOW]: wrap({
    triggers: { request: { type: 'Request', kind: 'Http', inputs: { schema: { type: 'object' } } } },
    actions: {
      ...compose,
      Reply: {
        type: 'Response',
        runAfter: { Note: ['Succeeded'] },
        inputs: {
          statusCode: 201,
          headers: {
            'x-fx': 'invented',
            'set-cookie': 'x_fx=1; Path=/',
            location: 'https://example.test/',
            'x-sim-csrf': 'invented',
            'content-security-policy': 'default-src *',
          },
          body: { echo: "@outputs('Note')" },
        },
      },
    },
  }),
};

async function host(t, { overrides = {}, extra = {}, file = null } = {}) {
  const clock = fixedClock(),
    notes = [],
    subscriptions = [],
    unsubscribed = [],
    polls = [];
  const store = await new DataStore({ file, state: emptyState(), clock, ids: sequentialIds() }).init();
  const scheduler = createScheduler({ clock, manual: true });
  storeScheduler(store, scheduler);
  ownedFixture(t).add(() => scheduler.close());
  const pack = {
    id: 'fx-pack',
    flowTriggers: {
      'shared_fx-5fapi': {
        OnNewItem: {
          subscribe: (ctx) => {
            subscriptions.push(ctx);
            return 'invented-subscription';
          },
          unsubscribe: (ctx) => {
            unsubscribed.push(ctx.subscription);
          },
          poll: () => {
            polls.push(clock.now());
            return [];
          },
        },
      },
    },
  };
  const connectors = createConnectorRuntime({ store, scheduler, clock, packs: [pack] });
  const workflows = new Map(Object.entries({ ...WORKFLOWS, ...extra })),
    identities = new Map();
  const items = () =>
    operationCatalogue({ portal: {}, workflows, handlers: { flowIdentities: identities }, overrides, connectors });
  const cloudFlow = (id) => {
    const item = items().find((i) => i.processId === id);
    return workflows.has(id)
      ? {
          definition: workflows.get(id).definition.properties.definition,
          mode: item?.mode ?? 'placeholder',
          steps: item?.configuration?.steps,
          connectors,
        }
      : null;
  };
  const runs = createHostFlowRuns({ store, clock, scheduler, approvals: connectors.approvals, flowOf: cloudFlow });
  const api = { store };
  runs.attach(api);
  ownedFixture(t).add(() => runs.close());
  const runner = createFlowTriggerRunner({
    store,
    items,
    workflows: () => workflows,
    identities: () => identities,
    connectors,
    diagnostic: (n) => notes.push(n),
  });
  ownedFixture(t).add(() => runner.close());
  return { store, scheduler, runs, runner, notes, overrides, subscriptions, unsubscribed, api, clock, polls };
}
const enable = (overrides, id) => {
  overrides['cloud-flow:' + id] = { mode: 'exported', activation: 'local-enabled' };
};

async function flowRouteClient(t, api, runs) {
  const routes = createFlowRoutes({ api: { ...api, flowRuns: runs }, csrf: () => 'invented-csrf' });
  const origin = await serveRoutes(t, routes);
  const call = async (method, path, body, csrf = true) => {
    const response = await fetch(origin + path, {
      method,
      headers: { 'content-type': 'application/json', ...(csrf ? { 'x-sim-csrf': 'invented-csrf' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
  };
  return call;
}

test('a Recurrence flow fires on the manual scheduler only after local activation, and deactivation cancels its timer', async (t) => {
  const { scheduler, runs, runner, overrides } = await host(t);
  await runner.syncTriggers();
  await scheduler.advance(3 * 3600000);
  assert.equal(runs.list().length, 0, 'an exported flow without explicit local activation never runs');
  assert.equal(runner.triggers().find((h) => h.processId === RECURRING).state, 'inactive');

  enable(overrides, RECURRING);
  const listed = (await runner.syncTriggers()).find((h) => h.processId === RECURRING);
  assert.equal(listed.state, 'scheduled');
  await scheduler.advance(3600000);
  await scheduler.advance(3600000);
  const fired = runs.list({ processId: RECURRING });
  assert.deepEqual(
    fired.map((r) => [r.status, r.triggertype]),
    [
      ['Succeeded', 'Recurrence'],
      ['Succeeded', 'Recurrence'],
    ],
  );

  delete overrides['cloud-flow:' + RECURRING];
  await runner.syncTriggers();
  await scheduler.advance(5 * 3600000);
  assert.equal(runs.list({ processId: RECURRING }).length, 2);
  assert.equal(scheduler.status().pending, 0);
});

test('a Windows time-zone id and a schedule outside Day/Week/Month stay explicit errors, and the next occurrence follows startTime', () => {
  const recurrence = (value) => inspectFlowTrigger({ triggers: { t: { type: 'Recurrence', recurrence: value } } });
  assert.match(
    recurrence({ frequency: 'Hour', interval: 1, schedule: { hours: [8] } }).errors.join(' '),
    /needs the Day, Week or Month frequency/,
  );
  assert.match(
    recurrence({ frequency: 'Day', interval: 1, schedule: { weekDays: ['Monday'] } }).errors.join(' '),
    /weekDays needs the Week frequency/,
  );
  assert.match(
    recurrence({ frequency: 'Day', interval: 1, schedule: { hours: [24] } }).errors.join(' '),
    /hours must be integers from 0 to 23/,
  );
  // A Windows id maps through the CLDR windowsZones table; an unknown one is refused by name.
  assert.equal(
    recurrence({ frequency: 'Day', interval: 1, timeZone: 'W. Europe Standard Time' }).recurrence.zone,
    'Europe/Berlin',
  );
  assert.match(
    recurrence({ frequency: 'Day', interval: 1, timeZone: 'Invented Standard Time' }).errors.join(' '),
    /timeZone Invented Standard Time is neither a Windows time-zone id/,
  );
  assert.equal(recurrence({ frequency: 'Fortnight', interval: 1 }).supported, false);
  const start = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(nextOccurrence({ frequency: 'Hour', interval: 2, start }, start + 3 * 3600000), start + 4 * 3600000);
  assert.equal(nextOccurrence({ frequency: 'Month', interval: 1, start }, start), Date.parse('2026-02-01T00:00:00Z'));
});

test('the unsupported-trigger message names mock/disable, not an adapter', () => {
  const answer = inspectFlowTrigger({
    triggers: {
      t: {
        type: 'OpenApiConnectionWebhook',
        inputs: { host: { apiId: '/providers/Microsoft.PowerApps/apis/shared_x_unhosted', operationId: 'OnInvented' } },
      },
    },
  });
  assert.equal(answer.supported, false);
  assert.match(
    answer.errors[0],
    /^Unsupported trigger OpenApiConnectionWebhook\/OnInvented .*configure an explicit flow mock or disable it\.$/,
  );
  assert.doesNotMatch(answer.errors[0], /adapter/);
});

// Recurrence schedule (hours, minutes, weekDays, monthDays) in an IANA timeZone, on a fixed clock.
test('a Recurrence schedule runs at its wall-clock hours, week days and month days in its IANA time zone', () => {
  const parse = (value) => inspectFlowTrigger({ triggers: { t: { type: 'Recurrence', recurrence: value } } });
  // Documented example: every Saturday at 5:00 PM (Week, weekDays Saturday, hours 17, minutes 0). 2026-01-01 is a Thursday.
  const weekly = parse({
    frequency: 'Week',
    interval: 1,
    schedule: { weekDays: ['Saturday'], hours: [17], minutes: [0] },
  });
  assert.equal(weekly.supported, true);
  const now = Date.parse('2026-01-01T09:00:00Z');
  assert.equal(new Date(nextOccurrence(weekly.recurrence, now)).toISOString(), '2026-01-03T17:00:00.000Z');
  // Daily at 8:30 and 16:30, in New York: 13:30Z in winter, 12:30Z after the March change.
  const daily = parse({
    frequency: 'Day',
    interval: 1,
    timeZone: 'America/New_York',
    startTime: '2026-01-01T00:00:00',
    schedule: { hours: [8, 16], minutes: [30] },
  });
  assert.equal(
    daily.recurrence.start,
    Date.parse('2026-01-01T05:00:00Z'),
    'a startTime without Z is wall-clock time in the zone',
  );
  assert.equal(new Date(nextOccurrence(daily.recurrence, now)).toISOString(), '2026-01-01T13:30:00.000Z');
  assert.equal(
    new Date(nextOccurrence(daily.recurrence, Date.parse('2026-03-10T00:00:00Z'))).toISOString(),
    '2026-03-10T12:30:00.000Z',
  );
  // monthDays -1 runs on the last day of each month.
  const last = parse({
    frequency: 'Month',
    interval: 1,
    startTime: '2026-01-01T06:00:00Z',
    schedule: { monthDays: [-1] },
  });
  assert.equal(
    new Date(nextOccurrence(last.recurrence, Date.parse('2026-02-01T00:00:00Z'))).toISOString(),
    '2026-02-28T06:00:00.000Z',
  );
  // Every other Monday (interval 2 weeks from the start week).
  const biweekly = parse({
    frequency: 'Week',
    interval: 2,
    startTime: '2026-01-05T07:00:00Z',
    schedule: { weekDays: ['Monday'] },
  });
  assert.equal(
    new Date(nextOccurrence(biweekly.recurrence, Date.parse('2026-01-05T08:00:00Z'))).toISOString(),
    '2026-01-19T07:00:00.000Z',
  );
});

// A polling connector trigger's first poll is at its startTime.
test('a polling trigger first polls at its startTime, never before it', async (t) => {
  const POLLED = '77777777-7777-4777-8777-0000000000a5',
    FEBRUARY = Date.parse('2026-02-01T00:00:00Z');
  const extra = {
    [POLLED]: wrap({
      triggers: {
        poll: {
          type: 'OpenApiConnection',
          recurrence: { frequency: 'Hour', interval: 1, startTime: '2026-02-01T00:00:00Z' },
          inputs: { host: { apiId: API, operationId: 'OnNewItem' } },
        },
      },
      actions: compose,
    }),
  };
  const { scheduler, runner, overrides, polls } = await host(t, { extra });
  enable(overrides, POLLED);
  const listed = (await runner.syncTriggers()).find((h) => h.processId === POLLED);
  assert.deepEqual([listed.state, listed.nextRun], ['scheduled', '2026-02-01T00:00:00.000Z']);
  await scheduler.advance(FEBRUARY - Date.parse('2026-01-01T00:00:00Z') - 1);
  assert.deepEqual(polls, [], 'no poll in January');
  await scheduler.advance(1);
  assert.deepEqual(polls, [FEBRUARY]);
});

// "When an action is performed" fires through the custom API execution hook (store.messageObservers).
test('a Dataverse action trigger runs a tracked flow with the action inputs and outputs, only for its message', async (t) => {
  const PERFORMED = '77777777-7777-4777-8777-0000000000a6';
  const definition = {
    triggers: {
      performed: {
        type: 'OpenApiConnectionWebhook',
        inputs: {
          host: {
            apiId: '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps',
            operationId: 'BusinessEventsTrigger',
          },
          parameters: { catalog: 'x_invented', category: 'x_events', entityname: 'none', sdkmessagename: 'x_Notify' },
        },
      },
    },
    actions: {
      Note: {
        type: 'Compose',
        runAfter: {},
        inputs: "@concat(triggerBody()?['InputParameters/x_text'], '/', triggerBody()?['OutputParameters/x_ok'])",
      },
    },
  };
  assert.deepEqual(
    (({ supported, kind, message, table }) => ({ supported, kind, message, table }))(inspectFlowTrigger(definition)),
    { supported: true, kind: 'dataverse-action', message: 'x_Notify', table: null },
  );
  assert.match(
    inspectFlowTrigger({
      triggers: {
        p: {
          ...definition.triggers.performed,
          inputs: { ...definition.triggers.performed.inputs, parameters: { sdkmessagename: 'x_Notify', x_other: 1 } },
        },
      },
    }).errors.join(' '),
    /Unsupported Dataverse action trigger parameter: x_other/,
  );
  const file = path.join(await makeTemporaryDirectory(path.join(os.tmpdir(), 'flow-action-trigger-')), 'state.json');
  ownedFixture(t).remove(() => fs.rm(path.dirname(file), { recursive: true, force: true }));
  const first = await host(t, { extra: { [PERFORMED]: wrap(definition) }, file });
  enable(first.overrides, PERFORMED);
  assert.equal((await first.runner.syncTriggers()).find((h) => h.processId === PERFORMED).state, 'subscribed');
  // The committed action event dataverse-customapi.mjs records (operation 'action'); a rolled-back transaction stages nothing.
  const perform = (store, message, inputs, outputs) =>
    store.transact(() => store.recordCommittedEvent('', 'action', {}, [], { message, table: null, inputs, outputs }));
  await assert.rejects(
    first.store.transact(() => {
      first.store.recordCommittedEvent('', 'action', {}, [], {
        message: 'x_Notify',
        table: null,
        inputs: {},
        outputs: {},
      });
      throw new Error('invented rollback');
    }),
    /invented rollback/,
  );
  await perform(first.store, 'x_Other', {}, {});
  assert.equal(
    (first.store.state.tables.asyncoperation ?? []).length,
    0,
    'no job for a rolled-back action or another message',
  );
  await perform(first.store, 'x_notify', { x_text: 'hello' }, { x_ok: 'yes' });
  assert.equal(first.store.state.tables.asyncoperation.length, 1, 'one durable Ready job');

  // Restart before the job ran: a new runtime on the saved state resumes the job and runs the flow.
  const second = await host(t, { extra: { [PERFORMED]: wrap(definition) }, file });
  enable(second.overrides, PERFORMED);
  await second.runner.syncTriggers();
  committedJobs(second.store).resume();
  // runDue() runs the resumed job on the manual scheduler and returns once its run settled.
  await second.scheduler.runDue();
  assert.deepEqual(
    second.runs.list({ processId: PERFORMED }).map((r) => [r.status, r.triggertype]),
    [['Succeeded', 'Automated']],
  );
  assert.equal(second.store.state.tables.asyncoperation.length, 0, 'the job row is removed with its run');
});

test('a pack flowTriggers entry is subscribed on activation, fires tracked runs and is unsubscribed at close', async (t) => {
  assert.throws(() => PACK_EXPORTS.flowTriggers.check({ shared_fx: { OnNewItem: {} } }, 'fx-pack'), /subscribe/);
  const { runs, runner, overrides, subscriptions, unsubscribed } = await host(t);
  enable(overrides, HOOKED);
  const listed = (await runner.syncTriggers()).find((h) => h.processId === HOOKED);
  assert.deepEqual(
    [listed.kind, listed.state, listed.connectorId, listed.operationId],
    ['connector', 'subscribed', 'shared_fx-5fapi', 'OnNewItem'],
  );
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0].parameters, { x_folder: 'inbox' });
  await subscriptions[0].fire({ x_name: 'invented item' });
  const [run] = runs.list({ processId: HOOKED });
  assert.deepEqual([run.status, run.triggertype], ['Succeeded', 'Automated']);
  await runner.close();
  assert.deepEqual(unsubscribed, ['invented-subscription']);
});

test('POST /_sim/api/flow-runs starts a tracked run of a Button, Http or Recurrence flow (403 without csrf); an HTTP Request trigger answers its Response', async (t) => {
  const { runs, overrides, api } = await host(t);
  for (const id of [BUTTON, HTTP_FLOW, RECURRING]) overrides['cloud-flow:' + id] = { mode: 'exported' };
  const call = await flowRouteClient(t, api, runs);
  assert.equal((await call('POST', '/_sim/api/flow-runs', { processId: BUTTON }, false)).status, 403);
  assert.equal(runs.list().length, 0);
  const button = await call('POST', '/_sim/api/flow-runs', { processId: BUTTON, input: { x_name: 'pressed' } });
  assert.equal(button.status, 201);
  assert.deepEqual(
    [button.body.status, button.body.triggertype, button.body.response],
    ['Succeeded', 'Manual', { status: 200, body: 'pressed' }],
  );
  const recurring = await call('POST', '/_sim/api/flow-runs', { processId: RECURRING });
  assert.deepEqual([recurring.status, recurring.body.status], [201, 'Succeeded']);
  const request = await call('POST', `/_sim/api/flow-triggers/${HTTP_FLOW}`, { x_name: 'posted' });
  assert.deepEqual([request.status, request.headers.get('x-fx'), request.body], [201, 'invented', { echo: 'posted' }]);
  // Only content-type and x-* headers reach the simulator origin.
  for (const name of ['set-cookie', 'location', 'x-sim-csrf', 'content-security-policy'])
    assert.equal(request.headers.get(name), null, name);
  assert.equal((await call('POST', `/_sim/api/flow-triggers/${BUTTON}`, {})).body.error.code, 'FlowTriggerUnsupported');
  delete overrides['cloud-flow:' + BUTTON];
  assert.equal((await call('POST', '/_sim/api/flow-runs', { processId: BUTTON })).status, 409);
  const listed = await call('GET', '/_sim/api/flow-triggers');
  assert.deepEqual(
    listed.body.map((h) => [h.processId, h.kind]).sort(),
    [
      [HOOKED, 'connector'],
      [HTTP_FLOW, 'http'],
      [RECURRING, 'recurrence'],
    ].sort(),
  );
  assert.equal(runs.list().length, 3);
  // GET only lists: a newly activated Recurrence flow is not started by it (the host syncs when it applies overrides).
  enable(overrides, RECURRING);
  assert.equal(
    (await call('GET', '/_sim/api/flow-triggers', null, false)).body.find((h) => h.processId === RECURRING).state,
    'inactive',
  );
});

test('recurrence and pack conditions skip before tracked-run creation and report dynamic errors explicitly', async (t) => {
  const recurrence = structuredClone(WORKFLOWS[RECURRING]);
  recurrence.definition.properties.definition.triggers.tick.conditions = [{ expression: '@false' }];
  const hooked = structuredClone(WORKFLOWS[HOOKED]);
  hooked.definition.properties.definition.triggers.hook.conditions = [
    { expression: "@equals(triggerBody()?['enabled'],true)" },
  ];
  const { scheduler, runs, runner, overrides, subscriptions, notes, store } = await host(t, {
    extra: { [RECURRING]: recurrence, [HOOKED]: hooked },
  });
  enable(overrides, RECURRING);
  enable(overrides, HOOKED);
  await runner.syncTriggers();
  await scheduler.advance(3600000);
  // The tick itself must fire and be skipped by its condition, not merely never arm.
  assert.ok(notes.some((note) => note.code === 'FLOW_TRIGGER_SKIPPED' && note.trigger === 'recurrence'));
  await subscriptions[0].fire({ enabled: false });
  assert.equal(runs.list().length, 0);
  assert.equal(store.state.tables.flowrun?.length ?? 0, 0);
  await subscriptions[0].fire({ enabled: true });
  assert.equal(runs.list({ processId: HOOKED }).length, 1);
  assert.ok(notes.some((note) => note.code === 'FLOW_TRIGGER_SKIPPED'));
  hooked.definition.properties.definition.triggers.hook.conditions = [{ expression: "@triggerBody()['missing']" }];
  await runner.syncTriggers();
  await subscriptions.at(-1).fire({ enabled: false });
  assert.equal(runs.list().length, 1);
  assert.ok(notes.some((note) => note.code === 'FLOW_TRIGGER_FAILED' && note.error.code === 'LocalFlowExpression'));
});

test('HTTP condition false answers a local skipped acknowledgement without creating phantom run history', async (t) => {
  const workflow = structuredClone(WORKFLOWS[HTTP_FLOW]);
  workflow.definition.properties.definition.triggers.request.conditions = [
    { expression: "@equals(triggerBody()?['enabled'],true)" },
  ];
  const { runs, api, overrides } = await host(t, { extra: { [HTTP_FLOW]: workflow } });
  overrides['cloud-flow:' + HTTP_FLOW] = { mode: 'exported' };
  const request = await flowRouteClient(t, api, runs);
  const call = async (suffix, body) => {
    const { status, body: result } = await request('POST', '/_sim/api/' + suffix, body);
    return { status, body: result };
  };
  assert.deepEqual(await call('flow-runs', { processId: HTTP_FLOW, input: { enabled: false } }), {
    status: 202,
    body: { runId: null, status: 'Skipped', reason: 'TriggerConditionFalse' },
  });
  const skipped = await call('flow-triggers/' + HTTP_FLOW, { enabled: false });
  assert.deepEqual(skipped, { status: 202, body: { runId: null, status: 'Skipped' } });
  assert.equal(runs.list().length, 0);
  const accepted = await call('flow-triggers/' + HTTP_FLOW, { enabled: true, x_name: 'accepted' });
  assert.deepEqual(accepted, { status: 201, body: { echo: 'accepted' } });
  assert.equal(runs.list().length, 1);
  workflow.definition.properties.definition.triggers.request.conditions = [{ expression: "@'not a boolean'" }];
  const invalid = await call('flow-triggers/' + HTTP_FLOW, {});
  assert.equal(invalid.body.error.code, 'LocalFlowExpression');
  assert.equal(runs.list().length, 1);
});
