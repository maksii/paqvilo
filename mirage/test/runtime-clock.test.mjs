import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { createScheduler, fixedClock, sequentialIds, storeScheduler, MAX_TIMER_DELAY } from '../lib/runtime-clock.mjs';

const NAMESPACE = '77777777-7777-4777-8777-777777777777';
const START = Date.parse('2026-03-01T08:00:00.000Z');

async function organization(t) {
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name', ownership: 'UserOwned', fields: { x_name: { dataverseType: 'nvarchar' } } };
  state.tables.x_item = [];
  const clock = fixedClock(START), ids = sequentialIds(NAMESPACE);
  const store = await new DataStore({ state, clock, ids }).init();
  const scheduler = createScheduler({ clock, manual: true });
  const core = await createOrganizationRuntime({ store, scheduler, settings: dataverseSettings({ enabled: false, auditing: true }), extensions: await sourceOrganizationExtensions() });
  t.after(() => core.close());
  return { store, core, clock, scheduler };
}

async function scriptedRun(t) {
  const { store, core, clock, scheduler } = await organization(t);
  const first = await store.create('x_item', { x_name: 'First invented row' }, { admin: true });
  clock.advance(60_000);
  await store.create('x_item', { x_name: 'Second invented row' }, { admin: true });
  clock.advance(60_000);
  await store.update('x_item', first.x_itemid, { x_name: 'First, renamed' }, { admin: true });
  await store.flushCommittedEvents();
  await scheduler.runDue();
  await core.read(() => {});
  return JSON.stringify(store.snapshot());
}

test('a fixed clock and sequential ids make two identical runs produce byte-identical state', async t => {
  const one = await scriptedRun(t), two = await scriptedRun(t);
  assert.equal(one, two);
  const items = JSON.parse(one).tables.x_item;
  assert.equal(items[0].createdon, '2026-03-01T08:00:00Z');
  assert.equal(items[0].modifiedon, '2026-03-01T08:02:00Z');
  assert.match(items[0].x_itemid, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('sequential ids are valid, distinct version 5 GUIDs and refuse an invalid namespace', () => {
  const ids = sequentialIds(NAMESPACE), again = sequentialIds(NAMESPACE);
  const values = [ids.uuid(), ids.uuid(), ids.uuid()];
  assert.equal(new Set(values).size, 3);
  assert.deepEqual([again.uuid(), again.uuid(), again.uuid()], values);
  assert.throws(() => sequentialIds('not-a-guid'), /Invalid namespace GUID/);
});

test('a manual scheduler runs due tasks in due order on runDue and advance', async () => {
  const clock = fixedClock(START), scheduler = createScheduler({ clock, manual: true }), order = [];
  scheduler.schedule(() => order.push('late'), 5000);
  scheduler.schedule(() => order.push('first'), 0);
  scheduler.schedule(() => order.push('second'), 0);
  scheduler.schedule(() => order.push('middle'), 1000);
  assert.deepEqual(order, []);
  assert.equal(await scheduler.runDue(), 2);
  assert.deepEqual(order, ['first', 'second']);
  await scheduler.advance(999);
  assert.deepEqual(order, ['first', 'second']);
  await scheduler.advance(1);
  assert.deepEqual(order, ['first', 'second', 'middle']);
  // A task that queues a due follow-up runs it in the same runDue.
  scheduler.schedule(() => { order.push('parent'); scheduler.schedule(() => order.push('child'), 0); }, 0);
  await scheduler.advance(4000);
  assert.deepEqual(order, ['first', 'second', 'middle', 'parent', 'late', 'child']);
  assert.deepEqual(scheduler.pending(), []);
  assert.equal(scheduler.status().pending, 0);
});

test('a real scheduler clamps long delays to the timer limit and re-arms the remainder', async t => {
  const created = [];
  t.mock.method(globalThis, 'setTimeout', (task, delay) => {
    const handle = { task, delay, unref() { return this; } };
    created.push(handle);
    return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  const scheduler = createScheduler();
  let ran = false;
  scheduler.schedule(() => { ran = true; }, MAX_TIMER_DELAY + 1000);
  assert.equal(created[0].delay, MAX_TIMER_DELAY);
  created[0].task();
  assert.equal(ran, false);
  assert.equal(created[1].delay, 1000);
  created[1].task();
  await scheduler.drain();
  assert.equal(ran, true);
});

test('close cancels every task and refuses new ones', async () => {
  const scheduler = createScheduler();
  let ran = 0;
  scheduler.schedule(() => { ran += 1; }, 0);
  scheduler.schedule(() => { ran += 1; }, 60_000);
  scheduler.close();
  assert.equal(scheduler.schedule(() => { ran += 1; }, 0), null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ran, 0);
  assert.deepEqual(scheduler.pending(), []);
  assert.equal(scheduler.status().closed, true);
  const manual = createScheduler({ clock: fixedClock(START), manual: true });
  manual.schedule(() => { ran += 1; }, 0);
  manual.close();
  assert.equal(await manual.runDue(), 0);
  assert.equal(ran, 0);
});

test('the faults hook fails chosen attempts and the task runs on a later attempt', async () => {
  const attempts = [];
  const scheduler = createScheduler({ clock: fixedClock(START), manual: true,
    faults: ({ name, attempt }) => { attempts.push([name, attempt]); return attempt < 3 ? new Error('Invented transient fault') : null; } });
  let ran = 0;
  scheduler.schedule(() => { ran += 1; }, 0, { name: 'invented' });
  await scheduler.runDue();
  assert.equal(ran, 1);
  assert.deepEqual(attempts, [['invented', 1], ['invented', 2], ['invented', 3]]);
  assert.equal(scheduler.status().faults, 2);
  assert.equal(scheduler.status().executed, 1);
});

test('drain waits for running tasks and tasks queued for the next turn', async () => {
  const scheduler = createScheduler(), done = [];
  scheduler.schedule(async () => { await new Promise(resolve => setTimeout(resolve, 20)); done.push('slow'); }, 0);
  scheduler.schedule(() => { done.push('quick'); }, 0);
  assert.equal(scheduler.status().pending, 2);
  await scheduler.drain();
  assert.deepEqual(done.sort(), ['quick', 'slow']);
  assert.equal(scheduler.status().pending, 0);
  // A failing task is counted, never thrown into the caller.
  scheduler.schedule(() => { throw new Error('Invented task failure'); }, 0);
  await scheduler.drain();
  assert.equal(scheduler.status().failures, 1);
});

test('storeScheduler keeps a closed scheduler unless the caller reopens it', () => {
  const store = {};
  const first = storeScheduler(store);
  first.close();
  assert.equal(storeScheduler(store), first, 'a stray call after close gets the closed scheduler');
  const reopened = storeScheduler(store, null, { reopen: true });
  assert.notEqual(reopened, first);
  assert.equal(reopened.status().closed, false);
  reopened.close();
  const manual = createScheduler({ manual: true });
  assert.equal(storeScheduler(store, manual), manual, 'a given scheduler replaces a closed one');
  assert.equal(store.scheduler, manual);
});
