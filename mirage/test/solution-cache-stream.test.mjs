import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SolutionFileCache } from '../lib/solution-cache.mjs';
import { scanSolutionSources, buildSolutionSchema } from '../lib/solution-schema.mjs';
import { settleFileTimes } from './support/file-times.mjs';

test('large parse caches round-trip without a complete document JSON string', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-stream-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.xml'),
    file = path.join(root, '.paqvilo/cache.json');
  await fs.writeFile(source, '<invented/>');
  const cache = await SolutionFileCache.open(file);
  const value = { text: Array.from({ length: 96 }, (_, i) => `Invented Δ ${i} ` + 'x'.repeat(128 * 1024)) };
  await cache.parse(source, 'fixture', () => value, { stamp: 'one' });
  const stringify = JSON.stringify,
    parse = JSON.parse;
  let reopened;
  try {
    JSON.stringify = (input, ...options) => {
      if (input?.format === 2 && input.entries) throw new Error('Complete cache encoding is unavailable');
      return stringify(input, ...options);
    };
    assert.equal(await cache.save(), true);
    JSON.parse = (text, ...options) => {
      if (text.startsWith('{"format":2,"entries":')) throw new Error('Complete cache parsing is unavailable');
      return parse(text, ...options);
    };
    reopened = await SolutionFileCache.open(file);
  } finally {
    JSON.stringify = stringify;
    JSON.parse = parse;
  }
  const cached = await reopened.parse(
    source,
    'fixture',
    () => {
      throw new Error('Unexpected reparse');
    },
    { stamp: 'one' },
  );
  assert.equal(cached.cached, true);
  assert.deepEqual(cached.value, value);
  const before = await fs.readFile(file);
  await cache.parse(source, 'invalid', () => ({ number: 1n }), { stamp: 'one' });
  assert.equal(await cache.save(), false);
  assert.deepEqual(await fs.readFile(file), before);
  assert.ok((await fs.readdir(path.dirname(file))).every((name) => !name.endsWith('.tmp')));
});

const entityXml = (column, label = 'Invented item') =>
  `<ImportExportXml><Entities><Entity><Name LocalizedName="${label}">x_item</Name><EntityInfo><entity Name="x_item"><LocalizedNames><LocalizedName description="${label}" languagecode="1033"/><LocalizedName description="Article inventé" languagecode="1036"/></LocalizedNames><attributes><attribute PhysicalName="x_itemid"><LogicalName>x_itemid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="${column}"><LogicalName>${column}</LogicalName><Type>nvarchar</Type></attribute></attributes><EntitySetName>x_items</EntitySetName></entity></EntityInfo></Entity></Entities></ImportExportXml>`;

// One restart: a fresh cache object over the persisted file, a scan, the schema and a save. `observe` counts reads of
// every scanned document's parsed facts, which only a schema compilation needs.
async function restart(roots, cacheFile, lcid = 1033) {
  const cache = await SolutionFileCache.open(cacheFile);
  const scan = await scanSolutionSources(roots, { cache });
  let reads = 0;
  for (const layer of scan.layers)
    for (const document of layer.documents) {
      const facts = document.facts;
      Object.defineProperty(document, 'facts', {
        enumerable: true,
        configurable: true,
        get() {
          reads++;
          return facts;
        },
      });
    }
  const schema = buildSolutionSchema(scan, { lcid });
  await cache.save();
  return { schema, reads };
}

test('an unchanged scan reuses its stored schema across restarts and rebuilds for changed sources and LCID', async (t) => {
  settleFileTimes(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-schema-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution'),
    cacheFile = path.join(root, '.paqvilo/solution-cache.json'),
    source = path.join(solution, 'Other', 'Customizations.xml');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, entityXml('x_name'));
  const fresh = async (lcid = 1033) => buildSolutionSchema(await scanSolutionSources([solution]), { lcid });
  const first = await restart([solution], cacheFile);
  assert.ok(first.reads > 0, 'The first start compiles the schema');
  assert.ok(first.schema.tables.x_item.attributes.x_name);
  const second = await restart([solution], cacheFile);
  assert.equal(second.reads, 0, 'An unchanged restart reads no parsed facts');
  assert.deepEqual(second.schema, await fresh(), 'The stored schema equals a compiled one');
  assert.deepEqual(Object.keys(second.schema), Object.keys(await fresh()), 'and keeps its key order');
  const french = await restart([solution], cacheFile, 1036);
  assert.ok(french.reads > 0, 'Another LCID compiles its own schema');
  assert.equal(french.schema.lcid, 1036);
  assert.deepEqual(french.schema, await fresh(1036));
  await fs.writeFile(source, entityXml('x_changed_column'));
  const changed = await restart([solution], cacheFile);
  assert.ok(changed.reads > 0, 'A changed source compiles the schema again');
  assert.ok(changed.schema.tables.x_item.attributes.x_changed_column);
  assert.equal(changed.schema.tables.x_item.attributes.x_name, undefined);
  assert.deepEqual(changed.schema, await fresh());
  const again = await restart([solution], cacheFile);
  assert.equal(again.reads, 0);
  assert.deepEqual(again.schema, changed.schema);
});

test('the cache file holds one native JSON line per entry and ignores another format', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-cache-lines-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.xml'),
    file = path.join(root, '.paqvilo/cache.json');
  await fs.writeFile(source, '<invented/>');
  const cache = await SolutionFileCache.open(file);
  await cache.parse(source, 'fixture', () => ({ text: 'Invented\nmulti-line value' }), { stamp: 'one' });
  assert.deepEqual(
    cache.deriveValue('invented', () => ({ parts: [1, 2] }), {
      split: (value) => value.parts,
      join: (parts) => ({ parts }),
    }),
    { parts: [1, 2] },
  );
  assert.equal(await cache.save(), true);
  const lines = (await fs.readFile(file, 'utf8')).trimEnd().split('\n');
  assert.deepEqual(lines, [
    '{"format":3}',
    JSON.stringify([source, cache.entries.get(source)]),
    'Dinvented\t1',
    'Dinvented\t2',
  ]);
  const reopened = await SolutionFileCache.open(file);
  let computed = 0;
  const derived = reopened.deriveValue('invented', () => computed++, { join: (parts) => ({ parts }) });
  assert.deepEqual(derived, { parts: [1, 2] });
  assert.notEqual(
    reopened.deriveValue('invented', () => computed++, { join: (parts) => ({ parts }) }),
    derived,
  );
  assert.equal(computed, 0);
  await fs.writeFile(file, JSON.stringify({ format: 2, entries: { [source]: cache.entries.get(source) } }));
  assert.equal((await SolutionFileCache.open(file)).entries.size, 0, 'Another format is rebuilt from sources');
});
