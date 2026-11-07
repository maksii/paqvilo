import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { appCatalogue, solutionApps } from '../lib/model-driven/catalogue.mjs';
import {
  metadataWorkerResponseChunks,
  createMetadataWorkers,
  indexFields,
} from '../lib/model-driven/metadata-worker-response.mjs';
import { encodeModelDrivenProvenance } from '../lib/model-driven/provenance-transport.mjs';
import { stringifyExactJson, parseExactJson } from '../lib/exact-numeric.mjs';
import { writeJsonChunks } from '../lib/json-response.mjs';
import { isSecuredField } from '../lib/dataverse-fls.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { once } from 'node:events';

async function catalogue(t, extra = 0) {
  const fixture = await modelDrivenFixture(t, { defer: true });
  const scan = await scanSolutionSources([fixture.solutionDir]);
  const metadata = await importSolutionMetadata([fixture.solutionDir], { scan });
  metadata.modelDrivenApps = solutionApps(scan);
  const mappings = Object.fromEntries(
    Object.keys(metadata.entities).map((name) => [name, { idColumn: name + 'id', nameColumn: 'x_name' }]),
  );
  return appCatalogue({
    lazy: true,
    metadata,
    mappings,
    providers: [
      {
        tables: {
          ...Object.fromEntries(
            Array.from({ length: extra }, (_, i) => [
              'invented' + i,
              {
                entity: 'invented' + i,
                idColumn: 'id',
                nameColumn: 'name',
                fields: { id: { isPrimaryId: true }, name: 'nvarchar' },
              },
            ]),
          ),
          local: {
            entity: 'local',
            label: 'Invented Ї / é / 📦',
            idColumn: 'id',
            nameColumn: 'name',
            fields: {
              id: { isPrimaryId: true },
              name: 'nvarchar',
              optional: null,
              amount: {
                dataverseType: 'decimal',
                defaultValue: parseExactJson('12345678901234567890.1234'),
                validForCreate: false,
              },
            },
            rows: [{ id: 'one', name: 'Not metadata' }],
          },
        },
      },
    ],
  });
}
const capabilities = (_name, fields) => ({
  read: false,
  fields: Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      {
        secured: isSecuredField(field),
        create: !field.isPrimaryId && (field.validForCreate ?? field.columnMetadata?.validForCreate) !== false,
      },
    ]),
  ),
});

const rightsOf = (source) => (name) => capabilities(name, indexFields(source, name));
// The 0.9.8 root: catalogue keys in their own order with `tables` in place, encoded as one value.
const rootOf = (source, tables, wire) => {
  const root = { ...source, tables: undefined };
  const value = wire ? encodeModelDrivenProvenance(root) : root;
  value.tables = tables;
  return value;
};
const pool = (t, options) => {
  const workers = createMetadataWorkers(options),
    exits = [];
  workers.events.on('exit', (exit) => exits.push(exit));
  t.after(() => workers.close());
  return { workers, exits };
};
// A decoder that reads only the first gzip member: the body must be that member and its 8-byte trailer.
const singleMember = (bytes) => {
  assert.deepEqual([...bytes.subarray(0, 4)], [0x1f, 0x8b, 8, 0], 'A plain gzip header without optional fields');
  const { buffer, engine } = inflateRawSync(bytes.subarray(10), { info: true });
  assert.equal(10 + engine.bytesWritten + 8, bytes.length, 'Exactly one gzip member');
  return buffer;
};

for (const wire of [false, true])
  for (const gzip of [false, true])
    test(`worker metadata preserves complete JSON bytes, field rights and source references (wire=${wire}, gzip=${gzip})`, async (t) => {
      const source = await catalogue(t),
        { tables } = source,
        { workers } = pool(t);
      const root = rootOf(source, tables, wire);
      const projected = {};
      for (const name of Object.keys(tables)) {
        const { rows: _rows, ...table } = tables[name];
        const value = { ...table, capabilities: capabilities(name, table.fields) };
        projected[name] = wire ? encodeModelDrivenProvenance(value) : value;
      }
      assert.ok(tables.x_item.provenanceRefs.length > 0, 'Source identities are exercised, not omitted');
      const res = new EventEmitter();
      res.destroyed = false;
      const chunks = [];
      for await (const chunk of metadataWorkerResponseChunks(source, root, rightsOf(source), res, {
        wire,
        gzip,
        workers,
      }))
        chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks),
        text = stringifyExactJson({ ...root, tables: projected });
      assert.equal((gzip ? singleMember(bytes) : bytes).toString(), text);
      if (gzip) assert.equal(gunzipSync(bytes).toString(), text);
      if (gzip) assert.ok(bytes.length < Buffer.byteLength(text));
      const keys = Object.keys(JSON.parse(text));
      assert.equal(keys.indexOf('tables'), keys.indexOf('apps') + 1, 'tables keeps its 0.9.8 place after apps');
      assert.equal(res.listenerCount('close'), 0);
    });

test('worker metadata cancellation terminates pending compilation and releases the writer', async (t) => {
  const source = await catalogue(t),
    { workers, exits } = pool(t),
    res = new EventEmitter();
  res.destroyed = false;
  res.write = () => true;
  res.end = () => assert.fail('Disconnected response cannot end successfully');
  const rights = rightsOf(source);
  const chunks = metadataWorkerResponseChunks(
    source,
    source,
    (name) => {
      res.destroyed = true;
      res.emit('close');
      return rights(name);
    },
    res,
    { workers },
  );
  const exited = once(workers.events, 'exit');
  await assert.rejects(writeJsonChunks(res, chunks), /disconnected|stopped|abort/i);
  assert.equal((await exited)[0].reason, 'cancelled', 'The compiler thread of a cancelled response is terminated');
  assert.equal(res.listenerCount('close'), 0);
  assert.deepEqual(
    exits.map((exit) => exit.reason),
    ['cancelled'],
  );
});

test('worker compilation errors preserve the failure and terminate the worker', async (t) => {
  const source = await catalogue(t),
    { workers } = pool(t),
    res = new EventEmitter();
  res.destroyed = false;
  const input = source.tableInput;
  const broken = {
    ...source,
    compilationContext: source.compilationContext,
    tableIndex: source.tableIndex,
    tableInput(name) {
      const value = input(name);
      value.metadata.forms = [{ id: 'invalid', entity: name, xml: '<form>' }];
      return value;
    },
  };
  const exited = once(workers.events, 'exit');
  await assert.rejects(async () => {
    for await (const _chunk of metadataWorkerResponseChunks(broken, source, rightsOf(source), res, { workers })) {
      /* consume */
    }
  }, /XML|complete/);
  assert.equal((await exited)[0].reason, 'failed');
  assert.equal(res.listenerCount('close'), 0);
});

test('a compiler thread failure between tables surfaces its own error to the response', async (t) => {
  const source = await catalogue(t),
    { workers, exits } = pool(t),
    res = new EventEmitter();
  res.destroyed = false;
  let entry,
    first = true;
  const acquire = workers.acquire;
  workers.acquire = () => (entry = acquire());
  const rights = rightsOf(source);
  const exited = once(workers.events, 'exit');
  await assert.rejects(
    async () => {
      for await (const _chunk of metadataWorkerResponseChunks(
        source,
        source,
        (name) => {
          // No table request is pending while rights are read: the failure is kept for the next table.
          if (first)
            entry.worker.emit(
              'error',
              Object.assign(new Error('Invented heap exhaustion'), { code: 'ERR_WORKER_OUT_OF_MEMORY' }),
            );
          first = false;
          return rights(name);
        },
        res,
        { workers },
      )) {
        /* consume */
      }
    },
    { code: 'ERR_WORKER_OUT_OF_MEMORY', message: 'Invented heap exhaustion' },
  );
  assert.equal((await exited)[0].reason, 'failed');
  assert.equal(exits.length, 1);
});

test('one compiler thread stays warm between responses and stops cleanly when idle or closed', async (t) => {
  const source = await catalogue(t),
    { workers, exits } = pool(t);
  const respond = async () => {
    const res = new EventEmitter();
    res.destroyed = false;
    const chunks = [];
    for await (const chunk of metadataWorkerResponseChunks(source, source, rightsOf(source), res, { workers }))
      chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString());
  };
  const threads = [];
  const acquire = workers.acquire;
  workers.acquire = () => {
    const entry = acquire();
    threads.push(entry.worker.threadId);
    return entry;
  };
  const first = await respond(),
    second = await respond();
  assert.deepEqual(second, first);
  assert.equal(threads.length, 2);
  assert.equal(threads[0], threads[1], 'The second response reuses the warm thread');
  assert.deepEqual(exits, []);
  const closed = once(workers.events, 'exit');
  await workers.close();
  assert.equal((await closed)[0].reason, 'closed');
  assert.throws(() => workers.acquire(), /closed/);
  const idle = pool(t, { idleMs: 0 });
  const entry = idle.workers.acquire();
  const stopped = once(idle.workers.events, 'exit');
  idle.workers.release(entry);
  const [{ reason, error }] = await stopped;
  assert.deepEqual({ reason, error }, { reason: 'idle', error: null });
});

test('worker HTTP metadata evaluates field permissions in one read and releases it before streaming', async (t) => {
  const source = await catalogue(t, 128);
  let queue = Promise.resolve(),
    held = false,
    allowed = true,
    payload;
  const read = (fn) => {
    const run = queue.then(async () => {
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    });
    queue = run.catch(() => {});
    return run;
  };
  const admitted = Promise.withResolvers(),
    resume = Promise.withResolvers();
  t.after(() => resume.resolve());
  const res = new EventEmitter();
  res.destroyed = false;
  res.setHeader = () => {};
  const handler = createModelDrivenHandler({
    streamMetadata: true,
    workerMetadata: true,
    read,
    catalogue: () => source,
    csrf: () => 'fixture',
    data: {
      capabilities: () => {
        assert.equal(held, true);
        return { read: allowed };
      },
    },
    json: async (_res, status, _value, headers, { chunks }) => {
      assert.equal(status, 200);
      assert.equal(headers['content-encoding'], 'gzip');
      assert.equal(headers.vary, 'Accept-Encoding');
      const encoded = [];
      let gated = false;
      for await (const chunk of chunks) {
        encoded.push(Buffer.from(chunk));
        if (!gated) {
          gated = true;
          admitted.resolve();
          await resume.promise;
        }
      }
      payload = JSON.parse(singleMember(Buffer.concat(encoded)).toString());
    },
  });
  t.after(() => handler.close());
  const pending = handler(
    { method: 'GET', headers: { 'accept-encoding': 'gzip' } },
    res,
    new URL('http://localhost/_apps/api'),
  );
  await admitted.promise;
  assert.equal(held, false, 'The read is released before the first byte is sent');
  // A write proceeds while the consumer is gated; the response keeps the rights it read.
  await read(() => {
    allowed = false;
  });
  resume.resolve();
  await pending;
  assert.equal(Object.keys(payload.tables).length, Object.keys(source.tables).length);
  for (const table of Object.values(payload.tables)) assert.equal(table.capabilities.read, true);
  assert.equal(res.listenerCount('close'), 0);
});
