// @test-kind contract: a pack module that cannot be imported is refused with its own path once and the import error as cause
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPacks, loadPack } from '../lib/preset-registry.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function packFile(t, name, content) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pack-load-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, name);
  if (content !== undefined) await fs.writeFile(file, content);
  return file;
}

const refusal = (promise) =>
  promise.then(
    () => assert.fail('the pack must be refused'),
    (error) => error,
  );

const occurrences = (text, part) => text.split(part).length - 1;

test('a pack module with a syntax error is refused by its file name', async (t) => {
  const file = await packFile(t, 'syntax.mjs', "export default {\n  id: 'invented';\n};\n");
  const error = await refusal(loadPack(file));
  assert.ok(error.cause instanceof SyntaxError);
  assert.equal(error.message, `Data pack ${file}: could not be loaded: syntax error: ${error.cause.message}`);
  assert.equal(occurrences(error.message, 'Data pack'), 1);
  assert.equal(occurrences(error.message, file), 1);
});

test('a pack module that throws while loading is refused by its file name', async (t) => {
  const file = await packFile(t, 'throws.mjs', "throw new TypeError('invented load failure');\n");
  const error = await refusal(loadPack(file));
  assert.ok(error.cause instanceof TypeError);
  assert.equal(error.message, `Data pack ${file}: could not be loaded: invented load failure`);
});

test('a pack module that does not exist is refused by its file name', async (t) => {
  const file = await packFile(t, 'missing.mjs');
  const error = await refusal(loadPack(file));
  assert.equal(error.cause.code, 'ERR_MODULE_NOT_FOUND');
  assert.equal(error.message, `Data pack ${file}: could not be loaded: the module file was not found`);
});

test('a pack module that imports a missing module keeps the import error text', async (t) => {
  const file = await packFile(t, 'imports.mjs', "import './absent.mjs';\nexport default {};\n");
  const error = await refusal(loadPack(file));
  assert.equal(error.cause.code, 'ERR_MODULE_NOT_FOUND');
  assert.equal(error.message, `Data pack ${file}: could not be loaded: ${error.cause.message}`);
  assert.match(error.message, /absent\.mjs/);
  assert.equal(occurrences(error.message, 'Data pack'), 1);
});

test('pack discovery reports an explicit module that cannot be imported the same way', async (t) => {
  const file = await packFile(t, 'syntax.mjs', 'export default {;\n');
  const error = await refusal(discoverPacks({ root: null, explicit: [{ module: file }] }));
  assert.ok(error.cause instanceof SyntaxError);
  assert.equal(error.message, `Data pack ${file}: could not be loaded: syntax error: ${error.cause.message}`);
});
