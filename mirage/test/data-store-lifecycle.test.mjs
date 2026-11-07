import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DataStore } from '../lib/data.mjs';

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    (error) => (error.code === 'ENOENT' ? false : Promise.reject(error)),
  );

test('close() removes the temporary record directory of a store without a state file', async () => {
  const store = new DataStore();
  const directory = store.ensureRecordSession().directory;
  store.ensureRecordSession().from([{ itemid: 'one' }], { primaryKey: 'itemid' });
  assert.ok(await exists(directory));
  store.close();
  assert.equal(await exists(directory), false);
  assert.equal(store.recordSession, null);
});

test('process exit removes temporary record directories that were never closed', async () => {
  const module = new URL('../lib/data.mjs', import.meta.url).href;
  const script = `const { DataStore } = await import(${JSON.stringify(module)});
const store = new DataStore();
store.ensureRecordSession().from([{ itemid: 'one' }], { primaryKey: 'itemid' });
const closed = new DataStore();
closed.ensureRecordSession();
closed.close();
process.stdout.write(store.recordSession.directory);`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
  assert.match(path.basename(stdout), /^paqvilo-record-state-/);
  assert.equal(await exists(stdout), false);
});

test('binding a state file to a store without published pages starts later tables beside the file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-record-bind-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new DataStore();
  t.after(() => store.closeRecordStorage());
  const foreign = store.ensureRecordSession();
  const file = path.join(root, 'state.json');
  store.file = file;
  await store.init();
  assert.equal(foreign.closed, true, 'The unused in-memory session retires.');
  assert.equal(store.ensureRecordSession().directory, await fs.realpath(file + '.records'));
  store.state.tables.item = store.ensureRecordSession().from([{ itemid: 'one', name: 'Bound' }], {
    primaryKey: 'itemid',
  });
  store.state.mappings.item = { idColumn: 'itemid', entitySet: 'items' };
  await store.save();
  const reopened = new DataStore({ file });
  t.after(() => reopened.closeRecordStorage());
  await reopened.init();
  assert.equal(reopened.get('items', 'one', { admin: true }).name, 'Bound');
});

test('the record retirement recheck stops once no retired session remains', () => {
  const store = new DataStore();
  let live = true,
    closes = 0;
  store.retiredRecordSessions = new Set([{ hasLiveTables: () => live, close: () => closes++ }]);
  store.scheduleRecordRetirement();
  assert.ok(store.recordRetirementTimer, 'A session that still backs live tables is rechecked.');
  assert.equal(closes, 0);
  live = false;
  store.retireRecordSessions();
  assert.equal(closes, 1);
  assert.equal(store.recordRetirementTimer, null);
  store.scheduleRecordRetirement();
  assert.equal(store.recordRetirementTimer, null, 'Nothing retired, nothing scheduled.');
});
