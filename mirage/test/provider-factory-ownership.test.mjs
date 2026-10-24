// Pack factory ownership (organization-host.mjs composeProviders adopt/own): what a factory creates is owned by the
// composition before validation, so a rejected instance, a resource opened by a factory that then throws and a promise a
// factory returned are all closed when composition fails, and none of them escapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { composeProviders } from '../lib/organization-host.mjs';
import '../lib/provider-modules.mjs';

const compose = async (factory) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const pack = {
    id: 'fx-pack',
    name: 'Invented',
    description: 'Invented',
    matches: () => true,
    presets: () => ({}),
    storageProviders: { blob: factory },
  };
  return composeProviders({
    store,
    packs: [pack],
    config: { providers: { storage: { s1: { kind: 'pack:fx-pack/blob' } }, routes: { annotations: 's1' } } },
  });
};

test('a factory instance rejected by validation is closed and composition fails', async () => {
  const calls = [];
  await assert.rejects(
    compose(() => ({ descriptor: { id: 'other' }, close: () => calls.push('close') })),
    { code: 'PROVIDER_FACTORY_FAILED' },
  );
  assert.deepEqual(calls, ['close']);
});

test('a resource a factory registered with own() is closed when the factory then throws', async () => {
  const calls = [];
  await assert.rejects(
    compose(({ own }) => {
      own({ settle: () => calls.push('settle'), close: () => calls.push('close') });
      throw new Error('invented failure after open');
    }),
    { code: 'PROVIDER_FACTORY_FAILED' },
  );
  assert.deepEqual(calls, ['settle', 'close']);
});

test('a provider a factory returned as a promise is closed once it resolves', async () => {
  const calls = [];
  await assert.rejects(
    compose(() => Promise.resolve({ descriptor: { id: 's1' }, close: () => calls.push('close') })),
    { code: 'PROVIDER_FACTORY_FAILED' },
  );
  assert.deepEqual(calls, ['close']);
});
