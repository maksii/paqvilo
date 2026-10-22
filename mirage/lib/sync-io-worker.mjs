// The worker of the synchronous I/O bridge (sync-io-bridge.mjs). It answers each request on the bridge port and wakes the
// waiting main thread through the shared flag. Requests carry no secret: the Service Bus connection string and a web hook's
// authentication value are read from the shared process environment here (env: references), and the key goes only into the
// SASL exchange (message-bus.mjs) or the POST.
import { workerData } from 'node:worker_threads';
import { deliver, loopbackFetch, withAuth } from './dataverse-webhooks.mjs';
import { createServiceBusEmulatorBus } from './message-bus.mjs';

const { port, signal } = workerData, flags = new Int32Array(signal);
const buses = new Map(); // one emulator bus (one AMQP connection) per provider configuration
// An env: reference of the shared process environment (SHARE_ENV), resolved here: the main thread never posts the value.
const fromEnv = (ref) => {
  if (ref == null) return '';
  const name = /^env:([A-Za-z_][A-Za-z0-9_]{0,127})$/.exec(String(ref))?.[1];
  if (!name) throw new Error('The synchronous I/O bridge takes authentication only as an env: reference.');
  return process.env[name] ?? '';
};

const operations = {
  // A loopback web hook POST: the status of the last attempt (dataverse-webhooks.mjs deliver), with the endpoint's
  // authentication applied here from its env: reference (withAuth).
  'http-post': ({ auth, ...request }) => deliver(withAuth({ ...request, auth: auth && { type: auth.type, value: fromEnv(auth.ref) } }), loopbackFetch),
  // One message to the Service Bus emulator.
  async 'amqp-send'({ provider, entity, body, messageId, properties }) {
    const key = JSON.stringify([provider.id, provider.connectionString, provider.amqpPort ?? null]);
    if (!buses.has(key)) buses.set(key, createServiceBusEmulatorBus({ id: provider.id, settings: { connectionString: provider.connectionString, amqpPort: provider.amqpPort }, env: process.env }));
    const sent = await buses.get(key).send(entity, body, { messageId, properties });
    return { messageId: sent.messageId };
  },
};

const reply = (answer) => {
  port.postMessage(answer);
  Atomics.store(flags, 0, 1);
  Atomics.notify(flags, 0);
};
// A crash (an exception or rejection nothing handled) answers every call in flight at once, marked crashed: the waiting
// caller learns of it within its call, not at its deadline, and the bridge stops this worker and starts a new one.
const inFlight = new Set();
let crashed = null;
const failure = (id) => ({ id, crashed: true, error: { message: `The synchronous I/O worker failed: ${crashed}`, status: 502, code: 'SyncIoWorkerFailed', details: null } });
const crash = (error) => {
  crashed ??= String(error?.message ?? error);
  for (const id of inFlight) reply(failure(id));
  inFlight.clear();
};
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

port.on('message', async ({ id, operation, payload }) => {
  if (crashed) { reply(failure(id)); return; }
  inFlight.add(id);
  let answer;
  try {
    if (!Object.hasOwn(operations, operation)) throw new Error(`Unknown synchronous I/O operation '${operation}'.`);
    answer = { id, value: await operations[operation](payload) };
  } catch (error) {
    answer = { id, error: { message: String(error?.message ?? error), status: error?.status ?? null, code: error?.code ?? null, details: error?.details ?? null } };
  }
  if (!inFlight.delete(id)) return; // already answered by a crash
  reply(answer);
});
