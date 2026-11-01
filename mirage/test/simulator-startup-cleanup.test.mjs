import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { RecordPageSession } from '../lib/record-tables.mjs';
import { createSimulator } from '../server.mjs';

const pack = {
  id: 'invented-startup-cleanup',
  name: 'Invented startup cleanup',
  description: 'Invented',
  matches: () => true,
  presets: () => ({
    pagedItems: {
      name: 'Invented paged items',
      createOwned({ records }) {
        return {
          mappings: { item: { idColumn: 'itemid', entitySet: 'items' } },
          tables: { item: records.table([{ itemid: 'one', name: 'Invented' }], { primaryKey: 'itemid' }) },
        };
      },
    },
  }),
};

test('a failed startup closes every record owner and reports close failures with the startup error', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'invented-startup-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: invented\nadx_name: Invented cleanup');
  const options = { sourceDir: root, stateFile: path.join(root, 'state.json'), watch: false, packs: [pack] };
  await (await createSimulator({ ...options, preset: 'pagedItems' })).close();
  // The restored storage owner closes first. Its failure must not strand the store.
  const close = RecordPageSession.prototype.close,
    closeStore = DataStore.prototype.closeRecordStorage;
  let failures = 1,
    storeCloses = 0;
  RecordPageSession.prototype.close = function (...args) {
    if (failures-- > 0) throw Error('Invented close failure');
    return close.apply(this, args);
  };
  DataStore.prototype.closeRecordStorage = function (...args) {
    storeCloses++;
    return closeStore.apply(this, args);
  };
  const restore = () => {
    RecordPageSession.prototype.close = close;
    DataStore.prototype.closeRecordStorage = closeStore;
  };
  t.after(restore);
  const failure = await createSimulator({ ...options, preset: 'missing', presetMode: 'always' }).then(
    () => assert.fail('Startup must fail for a missing preset.'),
    (error) => error,
  );
  restore();
  assert.ok(failure instanceof AggregateError, failure.stack);
  assert.match(failure.errors[0].message, /Preset not found/);
  assert.equal(failure.cause, failure.errors[0]);
  assert.deepEqual(
    failure.errors.slice(1).map((error) => error.message),
    ['Invented close failure'],
  );
  assert.equal(storeCloses, 1, 'The store still closes after the first owner failed.');
});
