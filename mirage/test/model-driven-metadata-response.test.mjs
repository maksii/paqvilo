import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { metadataResponseChunks } from '../lib/model-driven/metadata-response.mjs';
import { writeJsonChunks } from '../lib/json-response.mjs';
import { parseExactJson, stringifyExactJson } from '../lib/exact-numeric.mjs';

test('complete chunked metadata retains identical JSON bytes, precision, forms and capability denials', () => {
  const catalogue = {
    apps: [{ id: 'app-one', name: 'Invented Ї / é / 📦' }],
    tables: Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        'x_table' + index,
        {
          entity: 'x_table' + index,
          fields: { x_amount: { defaultValue: parseExactJson('12345678901234567890.1234'), optional: undefined } },
          forms: Array.from({ length: 32 }, (_, form) => ({ id: 'f-' + form, tabs: [{ fields: ['x_amount'] }] })),
          capabilities: { read: true, write: false, fields: { x_amount: { read: false, write: false } } },
        },
      ]),
    ),
    optional: undefined,
    defaultApp: 'app-one',
  };
  const expected = stringifyExactJson(catalogue);
  assert.equal([...metadataResponseChunks(catalogue)].join(''), expected);
  assert.equal(
    [...metadataResponseChunks(catalogue.tables.x_table0)].join(''),
    stringifyExactJson(catalogue.tables.x_table0),
  );
  assert.equal(
    [...metadataResponseChunks({ ...catalogue, tables: {} })].join(''),
    stringifyExactJson({ ...catalogue, tables: {} }),
  );
});

test(
  'a blocked metadata reader stops further encoding until drain and disconnect closes the generator',
  { timeout: 5000 },
  async () => {
    const response = new EventEmitter();
    response.destroyed = false;
    let encoded = 0,
      ended = false,
      released = false;
    const wroteSecond = Promise.withResolvers();
    response.write = () => {
      if (encoded === 2) wroteSecond.resolve();
      return false;
    };
    response.end = () => {
      ended = true;
    };
    function* pieces() {
      try {
        for (let index = 0; index < 64; index++) {
          encoded++;
          yield 'encoded metadata';
        }
      } finally {
        released = true;
      }
    }
    const pending = writeJsonChunks(response, pieces());
    assert.equal(encoded, 1, 'backpressure bounds the encoded work');
    response.emit('drain');
    await wroteSecond.promise;
    assert.equal(encoded, 2, 'only the admitted piece advances after drain');
    response.destroyed = true;
    response.emit('close');
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(released, true);
    assert.equal(ended, false);
    assert.equal(response.listenerCount('close'), 0);
    assert.equal(response.listenerCount('drain'), 0);
  },
);
