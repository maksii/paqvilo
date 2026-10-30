import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { createLocalMessageBus, createServiceBusEmulatorBus } from '../lib/message-bus.mjs';
import { startFakeBroker } from '../testing/amqp-fake-broker.mjs';
import { decodeMessage } from '../lib/amqp-client.mjs';
import { exactNumeric, parseExactJson } from '../lib/exact-numeric.mjs';

test('local and AMQP JSON messages retain finite Double range and plain properties alongside exact decimal bodies', async (t) => {
  assert.throws(() => parseExactJson('{"value":1e129}'), { code: 'NumericPrecisionUnsupported' });
  assert.throws(
    () => parseExactJson('{"$type":"DataverseNumeric","numericType":"Money","value":"1"}', { allowFiniteDouble: true }),
    { code: 'NumericPrecisionUnsupported' },
  );
  const broker = await startFakeBroker({ key: 'invented-range-key', queues: ['range-queue'] });
  const emulator = createServiceBusEmulatorBus({
    id: 'emulator',
    settings: { connectionString: 'env:FX_RANGE_BUS', amqpPort: broker.port },
    env: {
      FX_RANGE_BUS:
        'Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=invented-range-key;UseDevelopmentEmulator=true;',
    },
  });
  t.after(async () => {
    await emulator.close();
    await broker.close();
  });
  const local = createLocalMessageBus({ store: new DataStore() });
  const values = [1e129, 1e-129, Number.MAX_VALUE, Number.MIN_VALUE, 9007199254740992];
  for (const bus of [local, emulator]) {
    for (const value of values) {
      await bus.send(
        'range-queue',
        { value, amount: exactNumeric('9007199254740993.25', 'Money') },
        { properties: { value } },
      );
      const [received] = await bus.receive('range-queue', { mode: 'receiveAndDelete' });
      assert.equal(Number(received.body.value?.value ?? received.body.value), value);
      assert.equal(received.body.amount.value, '9007199254740993.25');
      assert.equal(received.properties.value, value);
      assert.equal(typeof received.properties.value, 'number');
    }
  }
  assert.equal(broker.payloads.length, values.length);
  for (const [index, payload] of broker.payloads.entries()) {
    const message = decodeMessage(payload);
    const raw = message.body.toString('utf8');
    assert.equal(JSON.parse(raw).value, values[index]);
    assert.ok(raw.includes('9007199254740993.25'));
    assert.ok(!raw.includes('DataverseNumeric'));
    assert.equal(message.applicationProperties.value, values[index]);
    assert.equal(typeof message.applicationProperties.value, 'number');
  }
});
