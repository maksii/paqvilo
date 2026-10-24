import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { devDialogs } from '../lense/dev-dialogs.mjs';

test('dev dialog policy follows the actual owned browser and preserves defaults outside target origins without recording them', async () => {
  const context = new EventEmitter(),
    actions = [],
    events = [],
    origin = 'http://127.0.0.1:1234';
  const cfg = { origin, browser: { headless: false } },
    session = new EventEmitter();
  session.on('dialog', (event) => events.push(event));
  const options = { configs: new Map([[origin, cfg]]), sessionFor: () => session, headless: true };
  let stop = devDialogs(context, options);
  const send = async (address, type) => {
    context.emit('dialog', {
      page: () => ({ url: () => address }),
      type: () => type,
      message: () => 'Bearer hidden-token',
      dismiss: async () => actions.push('dismiss'),
      accept: async () => actions.push('accept'),
    });
    await new Promise((r) => setImmediate(r));
  };
  await send(origin, 'confirm');
  await send('http://127.0.0.1:4321', 'alert');
  await send('http://127.0.0.1:4321', 'beforeunload');
  assert.deepEqual(actions, ['dismiss', 'dismiss', 'accept']);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, 'Bearer [redacted]');
  stop();
  stop = devDialogs(context, { ...options, attached: true });
  await send(origin, 'confirm');
  assert.equal(actions.length, 3, 'attached browser dialogs stay user-owned');
  stop();
  stop = devDialogs(context, { ...options, headless: false });
  cfg.browser.headless = true;
  await send(origin, 'confirm');
  assert.equal(actions.length, 3, 'a target configuration cannot override the actual headed browser');
  stop();
  assert.equal(context.listenerCount('dialog'), 0);
});
