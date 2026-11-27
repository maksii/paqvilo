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

const rowFacts = (contactId) => ({
  identity: { id: contactId, contactId },
  webform: { id: 'wizard', name: 'Wizard' },
  enhanced: false,
  userHostAddress: null,
  stepEntity: () => null,
  stepName: () => null,
});

// @test-kind observation+contract: hosted F2 runs e and f keep every adx_webformsession row (no cleanup, no bulk-delete job), so a contact session backed by its row is never evicted; anonymous sessions and sessions without a row have no evidence and keep Mirage's bound, oldest first
test('the session bound evicts anonymous and row-less sessions only, oldest first', async () => {
  const contacts = ['c1', 'c2', 'c3'].map((suffix) => `c0000000-0000-4000-8000-0000000000${suffix}`);
  const store = await new DataStore({
    state: {
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
      tables: { contact: contacts.map((contactid) => ({ contactid, fullname: 'Invented contact' })) },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const sessions = createWebFormSessions({ store, limit: 2 });
  const stage = async (owner, row = null) => {
    const session = sessions.create('wizard', owner, true);
    await sessions.stage(
      session,
      { ...session, current: 'details', history: [{ stepId: 'start', recordId: null }] },
      false,
      row,
    );
    return session.id;
  };
  const backed = [];
  for (const contact of contacts) backed.push(await stage(`contact:${contact}`, rowFacts(contact)));
  const anonymous = [];
  for (let index = 0; index < 4; index++) anonymous.push(await stage(`visitor:v${index}`));
  // Three row-backed contact sessions survive a bound of two; of four anonymous sessions the newest two remain.
  for (const id of backed) assert.ok(sessions.get(id), id);
  assert.deepEqual(
    anonymous.map((id) => Boolean(sessions.get(id))),
    [false, false, true, true],
  );
  assert.equal(store.tableRows('adx_webformsession').length, 3);
  assert.equal(store.state.portalFormSessions.length, 5);
});

// @test-kind security+observation: hosted session F4 (paqvilo-developer hosted-f4 multistep-private runs a and b) writes an anonymous visitor's adx_webformsession row with its anonymous identification; Mirage writes it only for a visitor the browser's own cookie named, and keeps anonymous sessions bounded even with a row, so cookieless or new-identification visitors cannot grow the session store or the table without bound.
test('anonymous sessions with a row stay bounded and a cookieless visitor writes no row', async () => {
  const store = await new DataStore({
    state: {
      mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' } },
      tables: { contact: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const sessions = createWebFormSessions({ store, limit: 2 });
  const anonymousFacts = (anonymousIdentified) => ({ ...rowFacts(null), identity: {}, anonymousIdentified });
  const stage = async (owner, identified) => {
    const session = sessions.create('wizard', owner, true);
    await sessions.stage(
      session,
      { ...session, current: 'details', history: [{ stepId: 'start', recordId: null }] },
      false,
      anonymousFacts(identified),
    );
    return session.id;
  };
  const visitor = (index) => `visitor:a0000000-0000-4000-8000-00000000000${index}`;
  const identified = [];
  for (let index = 0; index < 3; index++) identified.push(await stage(visitor(index), true));
  assert.equal(store.tableRows('adx_webformsession').length, 3, 'an identified visitor has a row');
  assert.ok(store.tableRows('adx_webformsession').every((row) => row.adx_anonymousidentification && !row.adx_contact));
  // A cookieless visitor (started by the request itself) gets a session but no row.
  const cookieless = await stage(visitor(5), false);
  assert.ok(sessions.get(cookieless));
  assert.equal(store.tableRows('adx_webformsession').length, 3);
  // Rows do not lift the bound for anonymous sessions: the two newest remain.
  assert.deepEqual(
    [...identified, cookieless].map((id) => Boolean(sessions.get(id))),
    [false, false, true, true],
  );
  assert.equal(store.state.portalFormSessions.length, 2);
});
