// @test-kind contract: the Power Pages client probe waits for the native readiness API without a default deadline and keeps an explicit one
import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePowerPagesClientContract } from '../testing/power-pages-client.mjs';

const INPUT = { formName: 'Invented form', fields: [{ name: 'fx_name', role: 'field' }] };
const DEADLINE_MESSAGE = 'Power Pages API readiness deadline exceeded.';
const VALIDATION_MESSAGE = 'readyTimeoutMs must be a positive integer.';

// A minimal rendered form: one control, answering the reads the probe makes.
const control = {
  getName: () => 'fx_name',
  getLogicalName: () => 'fx_name',
  getType: () => 'text',
  getDisabled: () => false,
  getRequired: () => false,
  getVisible: () => true,
  isReadOnly: false,
};
const form = {
  id: 'fx-form-1',
  name: 'Invented form',
  isMultiStep: false,
  getVisible: () => true,
  getControlByLogicalName: (name) => (name === 'fx_name' ? control : null),
  getHtmlElement: () => ({ querySelector: () => ({}) }),
};
const forms = { getAll: () => [form], getFormByName: () => form, getFormById: () => form };
const pages = { currentPage: { forms } };

// Installs a Power Pages client whose readiness API is the given function, for the length of one test.
function installClient(t, onPagesClientApiReady) {
  globalThis.Microsoft = { PowerPages: { onPagesClientApiReady } };
  globalThis.CSS = { escape: (value) => value };
  t.after(() => {
    delete globalThis.Microsoft;
    delete globalThis.CSS;
  });
}

test('readiness that arrives after more than five seconds yields the client results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deliver;
  installClient(t, (callback) => {
    deliver = callback;
  });
  const captured = capturePowerPagesClientContract(INPUT);
  // Six seconds of page time pass before the API answers; the probe sets no deadline of its own.
  t.mock.timers.tick(6000);
  deliver(pages);
  const results = await captured;
  assert.deepEqual(
    results.find((result) => result.id === 'forms.count'),
    { id: 'forms.count', value: 1 },
  );
  assert.deepEqual(
    results.find((result) => result.id === 'field.nameMatchesSource'),
    { id: 'field.nameMatchesSource', value: true },
  );
});

test('an explicit readyTimeoutMs still rejects with the deadline message when readiness does not arrive in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installClient(t, () => {});
  const captured = capturePowerPagesClientContract({ ...INPUT, readyTimeoutMs: 250 });
  t.mock.timers.tick(250);
  await assert.rejects(captured, { message: 'Power Pages API readiness deadline exceeded.' });
});

test('readyTimeoutMs must be a positive integer when given', async (t) => {
  installClient(t, (callback) => callback(pages));
  await assert.rejects(capturePowerPagesClientContract({ ...INPUT, readyTimeoutMs: '250' }), {
    message: 'readyTimeoutMs must be a positive integer.',
  });
});

test('without readyTimeoutMs a readiness that is delivered after a long wait still yields the client results', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deliver;
  installClient(t, (callback) => {
    deliver = callback;
  });
  const captured = capturePowerPagesClientContract(INPUT);
  // A minute of page time passes before readiness is delivered; no deadline is armed, so the probe does not reject.
  t.mock.timers.tick(60000);
  deliver(pages);
  const results = await captured;
  assert.deepEqual(
    results.find((result) => result.id === 'forms.count'),
    { id: 'forms.count', value: 1 },
  );
  assert.deepEqual(
    results.find((result) => result.id === 'field.isReadOnly'),
    { id: 'field.isReadOnly', value: false },
  );
});

test('readyTimeoutMs of 1 rejects with the deadline message when readiness never arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  installClient(t, () => {});
  const captured = capturePowerPagesClientContract({ ...INPUT, readyTimeoutMs: 1 });
  t.mock.timers.tick(1);
  await assert.rejects(captured, { message: DEADLINE_MESSAGE });
});

test('readyTimeoutMs must be a positive integer when given: zero, negative, fractional, string and NaN are refused', async (t) => {
  installClient(t, () => {});
  for (const readyTimeoutMs of [0, -1, 1.5, '5', NaN]) {
    await assert.rejects(capturePowerPagesClientContract({ ...INPUT, readyTimeoutMs }), {
      message: VALIDATION_MESSAGE,
    });
  }
});
