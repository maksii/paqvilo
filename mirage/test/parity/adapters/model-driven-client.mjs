// Adapter for the model-driven-client surface: recorded native UCI calls on a single-select choice control ->
// Mirage form client runtime -> the control's options before and after each call, and the call's outcome.
// One session serves every case of a case file, as the native probe ran its calls in order on one control.
// Values travel in the recorded typed encoding ({ type, value } and { type, entries }); `decode` (shared with the
// tests) and `encode` below are the only value-space conversions, so NaN and Infinity survive the JSON comparison.
import assert from 'node:assert/strict';
import { createFormClientRuntime } from '../../../lib/model-driven/client-runtime.mjs';
import { decode } from '../../../test-support/model-driven-native-decode.mjs';

const OPERATIONS = new Set(['addOption', 'removeOption']);

/**
 * Encodes a Mirage value in the recorded typed encoding.
 * @param {unknown} value value returned by Mirage
 * @returns {object} typed node
 */
function encode(value) {
  if (value === undefined) return { type: 'undefined' };
  if (value === null) return { type: 'null' };
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { type: 'number', value: 'NaN' };
    if (value === Infinity) return { type: 'number', value: '+Infinity' };
    return { type: 'number', value };
  }
  if (Array.isArray(value))
    return { type: 'array', entries: value.map((item, index) => ({ key: String(index), value: encode(item) })) };
  if (typeof value === 'object')
    return { type: 'object', entries: Object.entries(value).map(([key, item]) => ({ key, value: encode(item) })) };
  throw new Error(`model-driven-client adapter cannot encode a ${typeof value}`);
}

/**
 * Builds the Mirage form with one choice control named `first` (no attribute metadata options) and performs the
 * recorded setup on it: clearOptions, then addOption for each recorded control option, as the native probe did.
 * @param {{ controlDataOptions: { text: string, value: number }[] }} setup recorded setup of the case file
 * @returns {{ runtime: object, control: object }} the runtime and the control under test
 */
function buildControl(setup) {
  const state = new Map();
  const runtime = createFormClientRuntime({
    table: { entity: 'x_item', fields: { x_choice: { name: 'x_choice', type: 'number', options: [] } } },
    record: {},
    form: { attributes: ['x_choice'] },
    controlNames: () => ['first'],
    controlField: () => 'x_choice',
    controlState: (name, key, value) =>
      value === undefined ? state.get(`${name}:${key}`) : state.set(`${name}:${key}`, value),
  });
  const control = runtime.formContext.getControl('first');
  control.clearOptions();
  for (const option of setup.controlDataOptions) control.addOption({ text: option.text, value: option.value });
  return { runtime, control };
}

/**
 * Opens one stateful session for a case file. The control is built on the first call from that call's recorded
 * setup; every later call must carry the same setup.
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ run: Function, close: Function }>} session whose run returns { outcome, before, after }
 */
export async function open(_context) {
  let session = null;
  return {
    async run(input, _context) {
      if (session === null) session = { ...buildControl(input.setup), setup: structuredClone(input.setup) };
      else assert.deepStrictEqual(input.setup, session.setup, 'the setup must be identical across the case file');
      if (!OPERATIONS.has(input.operation)) throw new Error(`unsupported choice operation ${input.operation}`);
      const { control } = session;
      const before = encode(control.getOptions());
      let outcome;
      try {
        outcome = { returned: encode(control[input.operation](...decode(input.arguments))) };
      } catch (error) {
        outcome = { error: { name: error.name, message: error.message } };
      }
      return { outcome, before, after: encode(control.getOptions()) };
    },
    async close() {
      session?.runtime.destroy();
    },
  };
}
