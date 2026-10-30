// @test-kind contract: Paqvilo's own simulator administration, CLI, configuration and runtime behaviour
// /_sim/api/messages and /_sim/api/outbox over a plain loopback http server with a stub api object.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createLocalMessageBus, messagingSettings } from '../lib/message-bus.mjs';
import { createOutbox } from '../lib/outbox.mjs';
import { createMessagingRoutes, redactSecrets } from '../lib/sim-messaging-routes.mjs';
import { serveRoutes } from './support/route-server.mjs';

const CSRF = 'invented-csrf-token';

async function serve(t, providers, csrf = () => CSRF) {
  const store = await new DataStore({ state: emptyState() }).init();
  const api = { store, providers: providers(store) };
  const routes = createMessagingRoutes({ api, csrf });
  const origin = await serveRoutes(t, routes);
  const call = async (method, path, headers = {}) => {
    const response = await fetch(origin + path, { method, headers });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { api, call };
}

const withBus = (store) => {
  const bus = createLocalMessageBus({ store });
  const outbox = createOutbox({ store });
  return {
    messaging: { bus, settings: messagingSettings({ endpoints: { 'Invented queue': 'local/x-mapped' } }) },
    outbox,
  };
};

test('GET /_sim/api/messages lists entities with stats and peeks one entity with its dead-letter queue, credentials redacted', async (t) => {
  const { api, call } = await serve(t, withBus);
  const { bus } = api.providers.messaging;
  const body = {
    InputParameters: [
      {
        key: 'Target',
        value: {
          Attributes: [
            { key: 'authvalue', value: 'invented-sas-key' },
            { key: 'name', value: 'kept' },
          ],
        },
      },
    ],
    connectionString: 'invented-connection',
  };
  await bus.send('x-queue', body, { messageId: 'm1' });
  await bus.send('x-queue', { n: 2 }, { messageId: 'm2' });
  const [locked] = await bus.receive('x-queue');
  await bus.deadLetter(locked.lockToken, { reason: 'Invented' });

  const list = await call('GET', '/_sim/api/messages');
  assert.equal(list.status, 200);
  assert.equal(list.body.configured, true);
  assert.deepEqual(
    list.body.entities.map((item) => item.entity),
    ['x-mapped', 'x-queue'],
  );
  assert.deepEqual(list.body.entities.find((item) => item.entity === 'x-queue').stats, {
    active: 1,
    locked: 0,
    scheduled: 0,
    deadLettered: 1,
  });

  const dead = await call('GET', `/_sim/api/messages?entity=${encodeURIComponent('x-queue/$deadletterqueue')}`);
  assert.equal(dead.status, 200);
  assert.equal(dead.body.messages.length, 1);
  const text = JSON.stringify(dead.body);
  assert.ok(!text.includes('invented-sas-key') && !text.includes('invented-connection'), text);
  assert.match(text, /"kept"/);
  assert.equal((await call('GET', '/_sim/api/messages?entity=x-queue')).body.messages.length, 1);
});

test('DELETE /_sim/api/messages/<entity> needs the CSRF header and purges only that entity', async (t) => {
  const { api, call } = await serve(t, withBus);
  const { bus } = api.providers.messaging;
  await bus.send('x-queue', { n: 1 });
  await bus.send('x-other', { n: 2 });
  assert.equal((await call('DELETE', '/_sim/api/messages/x-queue')).status, 403);
  assert.equal(bus.peek('x-queue').length, 1);
  const purged = await call('DELETE', '/_sim/api/messages/x-queue', { 'x-sim-csrf': CSRF });
  assert.equal(purged.status, 200);
  assert.deepEqual(purged.body, { entity: 'x-queue', purged: 1 });
  assert.equal(bus.peek('x-queue').length, 0);
  assert.equal(bus.peek('x-other').length, 1);
});

test('GET /_sim/api/outbox filters by correlationId, channel and since', async (t) => {
  const { api, call } = await serve(t, withBus);
  const { outbox } = api.providers;
  await outbox.capture({ channel: 'email', to: ['a@example.test'], subject: 'One', correlationId: 'c-1' });
  await outbox.capture({ channel: 'teams', to: ['b@example.test'], subject: 'Two', correlationId: 'c-2' });
  assert.equal((await call('GET', '/_sim/api/outbox')).body.entries.length, 2);
  assert.deepEqual(
    (await call('GET', '/_sim/api/outbox?correlationId=c-1')).body.entries.map((entry) => entry.subject),
    ['One'],
  );
  assert.deepEqual(
    (await call('GET', '/_sim/api/outbox?channel=teams')).body.entries.map((entry) => entry.subject),
    ['Two'],
  );
  assert.equal((await call('GET', '/_sim/api/outbox?since=2999-01-01T00:00:00Z')).body.entries.length, 0);
  assert.equal((await call('POST', '/_sim/api/outbox', { 'x-sim-csrf': CSRF })).status, 405);
});

test('without providers the GETs answer configured false and the purge 404', async (t) => {
  const { call } = await serve(t, () => ({ messaging: null, outbox: null }));
  assert.deepEqual((await call('GET', '/_sim/api/messages')).body, { configured: false, entities: [], endpoints: {} });
  assert.deepEqual((await call('GET', '/_sim/api/outbox')).body, { configured: false, entries: [] });
  assert.equal((await call('DELETE', '/_sim/api/messages/x-queue', { 'x-sim-csrf': CSRF })).status, 404);
  assert.equal((await call('GET', '/_sim/api/other')).status, 404, 'other paths are left to the host');
});

test('redactSecrets replaces credential values and DataContract pairs only', () => {
  assert.deepEqual(
    redactSecrets({
      authvalue: 'k',
      nested: [
        { key: 'AuthValue', value: 'k' },
        { key: 'x_name', value: 'v' },
      ],
      plain: 'v',
    }),
    {
      authvalue: '[redacted]',
      nested: [
        { key: 'AuthValue', value: '[redacted]' },
        { key: 'x_name', value: 'v' },
      ],
      plain: 'v',
    },
  );
});

test('redactSecrets covers credential suffixes and pair forms, keeping sharedaccesskeyname and the bare key field', () => {
  const context = {
    Target: {
      sastoken: 's1',
      saskey: 's3',
      authvalue: 'a1',
      authorization: 'Bearer b1',
      sharedaccesskeyname: 'invented-key-name',
      'x-functions-key': 'f1',
      key: 'kept',
      Pairs: [
        { key: 'sastoken', value: 's2' },
        { key: 'sharedaccesskeyname', value: 'invented-key-name' },
        { key: 'name', value: 'kept' },
      ],
    },
  };
  assert.deepEqual(redactSecrets(context).Target, {
    sastoken: '[redacted]',
    saskey: '[redacted]',
    authvalue: '[redacted]',
    authorization: '[redacted]',
    sharedaccesskeyname: 'invented-key-name',
    'x-functions-key': '[redacted]',
    key: 'kept',
    Pairs: [
      { key: 'sastoken', value: '[redacted]' },
      { key: 'sharedaccesskeyname', value: 'invented-key-name' },
      { key: 'name', value: 'kept' },
    ],
  });
});

test('DELETE fails closed when the simulator has no CSRF token, even without a header', async (t) => {
  const { api, call } = await serve(t, withBus, () => undefined);
  const { bus } = api.providers.messaging;
  await bus.send('x-queue', { n: 1 });
  assert.equal((await call('DELETE', '/_sim/api/messages/x-queue')).status, 403);
  assert.equal((await call('DELETE', '/_sim/api/messages/x-queue', { 'x-sim-csrf': '' })).status, 403);
  assert.equal(bus.peek('x-queue').length, 1);
});
