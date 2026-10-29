import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeCatalogue } from '../scripts/catalogue-stream.mjs';

test('qualification consumes complete table objects across UTF-8, quote and structural chunk boundaries', async () => {
  const original = {
    version: 1,
    defaultApp: 'tables',
    apps: [{ id: 'tables' }],
    tables: {
      x_one: { forms: [{ xml: '<form>Δ 日本語 " \\ } {</form>' }], fields: { a: { type: 'text' } } },
      x_two: { forms: [], fields: {} },
    },
    capabilities: { read: true },
  };
  const bytes = Buffer.from(JSON.stringify(original));
  for (const size of [1, 2, 3, 7, 64, 1024]) {
    const read = {},
      chunks = async function* () {
        for (let index = 0; index < bytes.length; index += size) yield bytes.subarray(index, index + size);
      };
    const result = await consumeCatalogue(chunks(), (name, value) => {
      read[name] = value;
    });
    assert.deepEqual(read, original.tables);
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.tables, 2);
  }
});

test('qualification rejects incomplete or duplicate catalogue tables', async () => {
  for (const text of [
    '{}',
    '{"tables":{"x":{}',
    '{"tables":{"x":{},"x":{}}}',
    '{"tables":{},"tables":{}}',
    '{"tables":{}} garbage',
  ])
    await assert.rejects(consumeCatalogue([Buffer.from(text)], () => {}));
  assert.deepEqual(await consumeCatalogue([Buffer.from('{"tables":{}}')], () => {}), { bytes: 13, tables: 0 });
});
