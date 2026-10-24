// Going online replays the queue; a queued entry refused before or instead of an answer (a 4xx: its table left the
// catalogue, the user was disabled) is an answered failure: listed, removed, and the replay goes on. Only a call without a
// client-error status (transport) stops the replay with the entry still queued. In-process Web API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOfflineSessions, offlineSessionState } from '../lib/model-driven/offline.mjs';

const APP = 'app-x',
  USER = { kind: 'staff', principalId: 'u-x' };
const table = (name) => ({
  entity: name,
  entitySet: `${name}s`,
  idColumn: `${name}id`,
  nameColumn: 'x_name',
  fields: { [`${name}id`]: { name: `${name}id`, isPrimaryId: true }, x_name: { name: 'x_name' } },
  relationships: {},
});

async function world() {
  let tables = { x_item: table('x_item'), x_gone: table('x_gone') };
  const posts = [];
  let refuse = null,
    transport = false;
  const webApi = async ({ method, path }) => {
    if (method === 'GET' && path.includes('organizations'))
      return { status: 200, body: JSON.stringify({ value: [{}] }) };
    if (method === 'GET') return { status: 200, body: JSON.stringify({ value: [] }) };
    if (transport) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    if (refuse) throw Object.assign(new Error('The user is disabled.'), { status: refuse, code: 'UserDisabled' });
    posts.push(`${method} ${path}`);
    return { status: 201, body: '' };
  };
  const catalogue = async () => ({
    apps: [
      {
        id: APP,
        offlineProfiles: [
          {
            name: 'p',
            items: [
              { entity: 'x_item', distribution: 1 },
              { entity: 'x_gone', distribution: 1 },
            ],
          },
        ],
      },
    ],
    tables,
  });
  const store = await new DataStore({ state: emptyState() }).init();
  const sessions = createOfflineSessions({ webApi, catalogue, state: offlineSessionState(store) });
  await sessions.setMode(USER, APP, 'offline');
  const queue = async (entity, name) =>
    sessions.execute(USER, APP, { operation: 'create', entity, data: { x_name: name } });
  return {
    sessions,
    posts,
    queue,
    drop: () => {
      tables = { x_item: tables.x_item };
    },
    set: (o) => {
      refuse = o.refuse ?? null;
      transport = o.transport ?? false;
    },
  };
}

test('an entry whose table left the catalogue is listed and removed; the replay goes on and the app goes online', async () => {
  const w = await world();
  await w.queue('x_item', 'a');
  await w.queue('x_gone', 'g');
  await w.queue('x_item', 'b');
  w.drop();
  const status = await w.sessions.setMode(USER, APP, 'online');
  assert.deepEqual([status.mode, status.queue.length, w.posts.length], ['online', 0, 2]);
  assert.deepEqual(
    status.errors.map((e) => [e.status, e.code]),
    [[404, 'OfflineTableUnavailable']],
  );
});

test('a 401 from the in-process Web API is an answered failure; a transport error stops with the entry queued', async () => {
  const w = await world();
  await w.queue('x_item', 'a');
  await w.queue('x_item', 'b');
  w.set({ transport: true });
  const stopped = await w.sessions.setMode(USER, APP, 'online');
  assert.deepEqual(
    [stopped.mode, stopped.queue.length, stopped.errors.map((e) => [e.code, e.queued])],
    ['offline', 2, [['ECONNRESET', true]]],
  );
  w.set({ refuse: 401 });
  const status = await w.sessions.setMode(USER, APP, 'online');
  assert.deepEqual([status.mode, status.queue.length, status.errors.map((e) => e.status)], ['online', 0, [401, 401]]);
});
