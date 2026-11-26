// @test-kind contract: Mirage retains the last committed form progress over a local state-file restart and rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from '../lib/data.mjs';
import { createWebFormSessions, webFormSession } from '../lib/form-service.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';

test('recently committed multistep progress survives retention and a state-file restart', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'form-session-retention-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const store = await new DataStore({ file }).init();
  const sessions = createWebFormSessions({ store, limit: 2 });
  const owner = 'contact:editor';
  const form = 'wizard';
  const first = sessions.create(form, owner, true);
  const idle = sessions.create(form, owner, true);
  const firstProgress = { ...first, current: 'details', history: [{ stepId: 'start', recordId: 'item-one' }] };
  await sessions.stage(first, firstProgress);
  await sessions.stage(idle, { ...idle, current: 'details', history: [{ stepId: 'start', recordId: 'item-two' }] });

  const current = sessions.get(first.id);
  const resume = { ...current, current: 'review' };
  const refused = new Error('Synthetic failure after staging progress');
  await assert.rejects(
    store.transact(
      async () => {
        await sessions.stage(current, resume);
        throw refused;
      },
      { incremental: true },
    ),
    (error) => error === refused,
  );
  assert.equal(sessions.get(first.id).current, 'details');
  assert.deepEqual(
    sessions.list(form, owner).map(({ id }) => id),
    [idle.id, first.id],
  );

  await sessions.stage(current, resume);
  const later = sessions.create(form, owner, true);
  await sessions.stage(later, { ...later, current: 'details', history: [{ stepId: 'start', recordId: 'item-three' }] });

  const reloaded = createWebFormSessions({ store: await new DataStore({ file }).init(), limit: 2 });
  assert.deepEqual(
    reloaded.list(form, owner).map(({ id }) => id),
    [later.id, first.id],
  );
  assert.equal(reloaded.get(idle.id), null);
  const resumed = webFormSession({ webformId: form, sessionId: first.id, owner, startNew: true, sessions: reloaded });
  assert.equal(resumed.current, 'review');
  assert.equal(resumed.revision, 2);
  assert.deepEqual(resumed.history, firstProgress.history);
});
