import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { builtInKey } from '../lib/dataverse-elastic.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { committedJobs, stageCommittedJobs } from '../lib/committed-work.mjs';
import { createScheduler, fixedClock, storeScheduler } from '../lib/runtime-clock.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

// Learn "Asynchronous service": Dataverse saves the asynchronous context in the System Job (AsyncOperation) table as part
// of processing the event, so a committed write always carries its Ready job (or the write does not happen).
const A = '77777777-7777-4777-8777-7777777777a1', B = '77777777-7777-4777-8777-7777777777a2';
const step = (id, entity) => ({ id, name: 'Invented async step', enabled: true, contract: { mode: 1 }, mode: 'handler', entity, message: 'Create', stage: 40, filteringAttributes: [], rank: 1 });
const items = [step('77777777-7777-4777-8777-777777777771', 'x_item'), step('77777777-7777-4777-8777-777777777772', 'x_reading')];

function invented() {
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { dataverseType: 'nvarchar' } } };
  state.mappings.x_reading = { entitySet: 'x_readings', idColumn: 'x_readingid', nameColumn: 'x_name', tableType: 'Elastic', alternateKeys: [builtInKey('x_readingid')], fields: { x_name: { dataverseType: 'nvarchar' }, partitionid: { dataverseType: 'nvarchar' } } };
  state.tables.x_item = []; state.tables.x_reading = [];
  return state;
}

async function open(file, state) {
  const store = await new DataStore({ file, ...(state ? { state } : {}) }).init();
  storeScheduler(store, createScheduler({ clock: fixedClock(), manual: true }));
  const notes = [];
  const runner = createAsyncPluginRunner({ store, items: () => items, handlers: new Map(), runtimes: new Map(), diagnostic: note => notes.push(note) });
  return { store, notes, runner };
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'committed-atomic-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const opened = await open(file, invented());
  ownedFixture(t).add(() => opened.runner.close());
  const saved = async () => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return { tables: {} }; throw error; } };
  return { ...opened, file, saved };
}

const insert = (store, id) => {
  const table = store.state.tables.x_item;
  store.insertRow('x_item', table, { x_itemid: id, x_name: 'Invented ' + id });
  store.recordCommittedEvent('x_item', 'create', table.at(-1), ['x_name'], {});
};
const jobsOf = state => state.tables.asyncoperation ?? [];
const ticks = store => store.scheduler.pending().filter(task => task.name === 'committed-jobs').length;

test('the Ready job row is saved in the same commit as its triggering row and a restart runs it', async t => {
  const { store, saved, file } = await fixture(t);
  await store.transact(() => insert(store, A));
  const disk = await saved();
  assert.equal(disk.tables.x_item.length, 1);
  assert.equal(jobsOf(disk).length, 1);
  assert.deepEqual([jobsOf(disk)[0].statecode, jobsOf(disk)[0].operationtype, jobsOf(disk)[0].regardingobjectid.id], [0, 1, A]);
  assert.equal(ticks(store), 1, 'the post-commit path only schedules the run');
  // A process exit now: a new runtime on the same file finds the staged job and runs it.
  const restarted = await open(file);
  t.after(() => restarted.runner.close());
  committedJobs(restarted.store).resume();
  await restarted.store.scheduler.runDue();
  assert.equal(jobsOf(restarted.store.state).length, 0);
  assert.ok(restarted.notes.some(note => /^PLUGIN_ASYNC_(COMPLETED|FAILED)$/.test(note.code)));
});

test('a failed commit stores neither the row nor its job', async t => {
  const { store, saved, notes } = await fixture(t);
  const save = store.save;
  store.save = async () => { throw Object.assign(new Error('Invented persistence failure'), { persistenceFailure: true }); };
  await assert.rejects(store.transact(() => insert(store, A)), /Invented persistence failure/);
  store.save = save;
  assert.equal(store.state.tables.x_item.length, 0);
  assert.equal(jobsOf(store.state).length, 0);
  assert.equal(jobsOf(await saved()).length, 0);
  assert.equal(ticks(store), 0);
  assert.deepEqual(notes, []);
});

test('a rolled-back caller transaction leaves no job and no chain count', async t => {
  const { store, saved, notes } = await fixture(t);
  await assert.rejects(store.transact(() => { insert(store, A); throw new Error('Invented caller failure'); }), /Invented caller failure/);
  assert.equal(jobsOf(store.state).length, 0);
  assert.equal(jobsOf(await saved()).length, 0);
  assert.equal(ticks(store), 0);
  assert.deepEqual(notes, []);
});

test('isolated, independent and elastic commits stage their jobs with their rows', async t => {
  const { store, saved } = await fixture(t);
  await store.transact(() => insert(store, A), { isolated: true });
  assert.deepEqual(jobsOf(await saved()).map(row => row.regardingobjectid.id), [A]);
  // An independent SDK request commits even though its caller fails; only its event gets a job.
  await assert.rejects(store.transact(() => { store.sdkMutation(() => insert(store, B)); insert(store, '77777777-7777-4777-8777-7777777777a3'); throw new Error('Invented main failure'); }), /Invented main failure/);
  let disk = await saved();
  assert.deepEqual(disk.tables.x_item.map(row => row.x_itemid), [A, B]);
  assert.deepEqual(jobsOf(disk).map(row => row.regardingobjectid.id), [A, B]);
  // An elastic row is retained after its caller fails, and so is its job.
  await assert.rejects(store.transact(async () => { await store.createRecord('x_reading', { x_name: 'Invented reading' }, { admin: true }); throw new Error('Invented main failure'); }), /Invented main failure/);
  disk = await saved();
  assert.equal(disk.tables.x_reading.length, 1);
  assert.deepEqual(jobsOf(disk).map(row => row.regardingobjecttypecode), ['x_item', 'x_item', 'x_reading']);
  assert.equal(jobsOf(disk)[2].regardingobjectid.id, disk.tables.x_reading[0].x_readingid);
});

test('a commit stager must be synchronous and a throwing stager fails the commit', async () => {
  const store = await new DataStore({ state: invented() }).init();
  assert.throws(() => store.addCommitStager(async () => {}), /synchronous/);
  const stop = store.addCommitStager(() => { throw new Error('Invented stager failure'); });
  await assert.rejects(store.transact(() => insert(store, A)), /Invented stager failure/);
  assert.equal(store.state.tables.x_item.length, 0);
  stop();
  await store.transact(() => insert(store, A));
  assert.equal(store.state.tables.x_item.length, 1);
});

test('stageCommittedJobs: the bookkeeping applies only after the commit; a rolled-back stager leaves nothing', async () => {
  const store = await new DataStore({ state: emptyState() }).init();
  storeScheduler(store, createScheduler({ clock: fixedClock(), manual: true }));
  committedJobs(store).register('x_probe', () => {});
  const ledger = { runs: new Map(), accepted: new Set(), own: new Set() }, reported = [];
  const stageOnce = () => stageCommittedJobs(store, { kind: 'x_probe', entries: [{ id: A, chain: { id: 'x-chain', depth: 0 }, event: { entity: 'x_item' } }],
    diagnostics: ['x-note'], report: note => reported.push(note), counts: new Map([['x-chain', 1]]), ledger });
  await assert.rejects(store.transact(() => { stageOnce(); throw new Error('invented rollback'); }));
  assert.deepEqual([store.state.tables.asyncoperation?.length ?? 0, ledger.own.size, reported.length], [0, 0, 0]);
  let after;
  await store.transact(() => { after = stageOnce(); });
  assert.equal(store.state.tables.asyncoperation.length, 1);
  assert.equal(JSON.parse(store.state.tables.asyncoperation[0].data).kind, 'x_probe');
  assert.equal(ledger.own.size, 0, 'nothing is applied before the post-commit step');
  after();
  assert.deepEqual([[...ledger.own], ledger.runs.get('x-chain'), ledger.accepted.has('x-chain'), reported], [[A], 1, true, ['x-note']]);
  assert.equal(stageCommittedJobs(store, { entries: [] }), null, 'nothing staged: the commit is not forced to save');
  assert.equal(typeof committedJobs(store).enqueue, 'undefined');
});
