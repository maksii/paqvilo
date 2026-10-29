import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SolutionFileCache } from '../lib/solution-cache.mjs';

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
