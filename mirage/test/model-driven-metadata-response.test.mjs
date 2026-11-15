import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { metadataResponseChunks } from '../lib/model-driven/metadata-response.mjs';
import { writeJsonChunks } from '../lib/json-response.mjs';
import { parseExactJson, stringifyExactJson } from '../lib/exact-numeric.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { decodeModelDrivenProvenance, encodeModelDrivenProvenance } from '../lib/model-driven/provenance-transport.mjs';

test('HTTP metadata evaluates capabilities inside its read epoch and streams lazily after it, including compressed provenance', async () => {
  let held = false,
    allowed = true,
    loaded = 0,
    queue = Promise.resolve();
  const read = (fn) => {
    const result = queue.then(async () => {
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  const tables = {};
  for (let index = 0; index < 2000; index++)
    Object.defineProperty(tables, 'x_table' + index, {
      enumerable: true,
      get() {
        loaded++;
        return {
          entity: 'x_table' + index,
          fields: { x_secret: { isSecured: true } },
          forms: [{ id: 'form-' + index }],
          provenanceRefs: [{ id: 'field', key: 'field', ref: 'source.xml', sourceRevision: 'a', contentRevision: 'b' }],
        };
      },
    });
  const admitted = Promise.withResolvers(),
    resume = Promise.withResolvers();
  let payload,
    checks = 0,
    loadedAtRead;
  const handler = createModelDrivenHandler({
    streamMetadata: true,
    catalogue: () => ({ tables }),
    data: {
      capabilities: () => {
        assert.equal(held, true);
        checks++;
        return { read: allowed };
      },
    },
    read,
    csrf: () => 'test',
    json: async (_res, status, _value, _headers, { chunks }) => {
      assert.equal(status, 200);
      const encoded = [];
      for (const chunk of chunks) {
        encoded.push(chunk);
        if (loadedAtRead === undefined && loaded > checks) {
          loadedAtRead = loaded;
          admitted.resolve();
          await resume.promise;
        }
      }
      payload = decodeModelDrivenProvenance(JSON.parse(encoded.join('')));
    },
  });
  const res = { destroyed: false, setHeader() {} };
  const request = handler(
    { method: 'GET', headers: { 'x-mirage-provenance-format': '1' } },
    res,
    new URL('http://localhost/_apps/api'),
  );
  await admitted.promise;
  assert.equal(checks, 2000, 'Every table right is evaluated in the read');
  assert.equal(loadedAtRead, 2001, 'Bodies are projected one at a time after the read');
  assert.equal(held, false, 'The read is released before the first table is sent');
  // A write proceeds while the reader is gated; the response keeps the rights it read.
  let changed = false;
  await read(() => {
    allowed = false;
    changed = true;
  });
  assert.equal(changed, true);
  resume.resolve();
  await request;
  assert.equal(loaded, 4000);
  for (const value of Object.values(payload.tables)) {
    assert.equal(value.capabilities.read, true);
    assert.equal(value.forms.length, 1);
    assert.deepEqual(value.provenanceRefs[0], {
      id: 'field',
      key: 'field',
      ref: 'source.xml',
      sourceRevision: 'a',
      contentRevision: 'b',
    });
  }
});

test('disconnecting a full metadata response releases the read without constructing remaining tables', async () => {
  let loaded = 0,
    held = false,
    destroyed;
  const tables = {};
  for (let index = 0; index < 2000; index++)
    Object.defineProperty(tables, 'x_table' + index, {
      enumerable: true,
      get() {
        loaded++;
        return { entity: 'x_table' + index };
      },
    });
  const res = {
    destroyed: false,
    headersSent: false,
    setHeader() {},
    destroy(error) {
      this.destroyed = true;
      destroyed = error;
    },
  };
  const handler = createModelDrivenHandler({
    streamMetadata: true,
    catalogue: () => ({ tables }),
    data: {},
    csrf: () => 'test',
    read: async (fn) => {
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    },
    json: async (_res, _status, _value, _headers, { chunks }) => {
      res.headersSent = true;
      for (const _chunk of chunks) if (loaded === 1) throw new Error('Controlled disconnect');
    },
  });
  await handler({ method: 'GET', headers: {} }, res, new URL('http://localhost/_apps/api'));
  assert.equal(loaded, 1);
  assert.equal(held, false);
  assert.equal(destroyed.message, 'Controlled disconnect');
});

test('metadata encoding admits one lazy table at a time and does not evaluate disconnected tables', () => {
  const tables = {},
    loaded = [];
  for (let index = 0; index < 2000; index++)
    Object.defineProperty(tables, 'x_table' + index, {
      enumerable: true,
      get() {
        loaded.push(index);
        return { entity: 'x_table' + index, forms: [{ id: 'form-' + index }] };
      },
    });
  const chunks = metadataResponseChunks({ tables });
  assert.equal(chunks.next().value, '{');
  assert.equal(chunks.next().value, '"tables":{');
  assert.deepEqual(loaded, []);
  assert.match(chunks.next().value, /"x_table0":/);
  assert.deepEqual(loaded, [0]);
  chunks.return();
  assert.deepEqual(loaded, [0]);
});

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

for (const wire of [false, true])
  test(`HTTP metadata keeps the 0.9.8 JSON bytes and root key order (wire=${wire})`, async () => {
    const catalogue = {
      version: 1,
      defaultApp: 'app-one',
      apps: [{ id: 'app-one', name: 'Invented Ї / é / 📦' }],
      tables: {
        x_table0: {
          entity: 'x_table0',
          fields: { x_amount: { defaultValue: parseExactJson('12345678901234567890.1234') } },
          provenanceRefs: [{ id: 'f', key: 'f', ref: 'table.xml', sourceRevision: 'a', contentRevision: 'b' }],
        },
      },
      provenanceRefs: [{ id: 'app', key: 'app', ref: 'app.xml', sourceRevision: 'a', contentRevision: 'c' }],
      capabilities: { localCrud: true },
    };
    let bytes;
    const handler = createModelDrivenHandler({
      catalogue: () => catalogue,
      data: { capabilities: (name) => ({ read: name === 'x_table0' }) },
      read: (fn) => fn(),
      csrf: () => 'test',
      json: async (_res, _status, _value, _headers, { chunks }) => {
        bytes = [...chunks].join('');
      },
    });
    await handler(
      { method: 'GET', headers: wire ? { 'x-mirage-provenance-format': '1' } : {} },
      { destroyed: false, setHeader() {} },
      new URL('http://localhost/_apps/api'),
    );
    // 0.9.8: { ...catalogue, tables } with each table's capabilities, then the whole value encoded for the wire.
    const tables = { x_table0: { ...catalogue.tables.x_table0, capabilities: { read: true } } };
    const expected = { ...catalogue, tables };
    assert.equal(bytes, stringifyExactJson(wire ? encodeModelDrivenProvenance(expected) : expected));
    assert.deepEqual(Object.keys(JSON.parse(bytes)).slice(0, 4), ['version', 'defaultApp', 'apps', 'tables']);
  });

test('a blocked metadata reader stops further encoding until drain and disconnect closes the generator', async () => {
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
});
