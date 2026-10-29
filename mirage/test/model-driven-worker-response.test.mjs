import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { scanSolutionSources } from '../lib/solution-schema.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { appCatalogue, solutionApps } from '../lib/model-driven/catalogue.mjs';
import { metadataWorkerResponseChunks } from '../lib/model-driven/metadata-worker-response.mjs';
import { encodeModelDrivenProvenance } from '../lib/model-driven/provenance-transport.mjs';
import { stringifyExactJson, parseExactJson } from '../lib/exact-numeric.mjs';
import { writeJsonChunks } from '../lib/json-response.mjs';
import { isSecuredField } from '../lib/dataverse-fls.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { gunzipSync } from 'node:zlib';

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

for (const wire of [false, true])
  for (const gzip of [false, true])
    test(`worker metadata preserves complete JSON bytes, field rights and source references (wire=${wire}, gzip=${gzip})`, async (t) => {
      const source = await catalogue(t),
        { tables, ...rest } = source;
      const root = { ...(wire ? encodeModelDrivenProvenance(rest) : rest), tables };
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
      for await (const chunk of metadataWorkerResponseChunks(source, root, capabilities, res, { wire, gzip }))
        chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks),
        text = stringifyExactJson({ ...root, tables: projected });
      assert.equal((gzip ? gunzipSync(bytes) : bytes).toString(), text);
      if (gzip) assert.ok(bytes.length < Buffer.byteLength(text));
      assert.equal(res.listenerCount('close'), 0);
    });

test(
  'worker metadata cancellation terminates pending compilation and releases the writer',
  { timeout: 5000 },
  async (t) => {
    const source = await catalogue(t),
      res = new EventEmitter();
    res.destroyed = false;
    res.write = () => true;
    res.end = () => assert.fail('Disconnected response cannot end successfully');
    const chunks = metadataWorkerResponseChunks(
      source,
      source,
      (name, fields) => {
        res.destroyed = true;
        res.emit('close');
        return capabilities(name, fields);
      },
      res,
    );
    await assert.rejects(writeJsonChunks(res, chunks), /disconnected|stopped|abort/i);
    assert.equal(res.listenerCount('close'), 0);
  },
);

test('worker compilation errors preserve the failure and terminate the worker', { timeout: 5000 }, async (t) => {
  const source = await catalogue(t),
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
  await assert.rejects(async () => {
    for await (const _chunk of metadataWorkerResponseChunks(broken, source, capabilities, res)) {
      /* consume */
    }
  }, /XML|complete/);
  assert.equal(res.listenerCount('close'), 0);
});

test('worker HTTP metadata keeps field permissions in one serialized read epoch', { timeout: 10000 }, async (t) => {
  const source = await catalogue(t, 128);
  let queue = Promise.resolve(),
    held = false,
    allowed = true,
    changed = false,
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
        if (Buffer.isBuffer(chunk) && !gated) {
          gated = true;
          admitted.resolve();
          await resume.promise;
        }
      }
      payload = JSON.parse(gunzipSync(Buffer.concat(encoded)).toString());
    },
  });
  const pending = handler(
    { method: 'GET', headers: { 'accept-encoding': 'gzip' } },
    res,
    new URL('http://localhost/_apps/api'),
  );
  await admitted.promise;
  const write = read(() => {
    allowed = false;
    changed = true;
  });
  await Promise.resolve();
  assert.equal(changed, false);
  resume.resolve();
  await pending;
  await write;
  assert.equal(changed, true);
  assert.equal(Object.keys(payload.tables).length, Object.keys(source.tables).length);
  for (const table of Object.values(payload.tables)) assert.equal(table.capabilities.read, true);
  assert.equal(res.listenerCount('close'), 0);
});
