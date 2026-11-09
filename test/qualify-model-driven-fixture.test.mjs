// @test-kind tooling: The late temporary fixture cannot affect a selected earlier parity registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyzeClientLateFixture, describeParitySource } from '../scripts/qualify-parity.mjs';

const file = 'mirage/test/model-driven-client-state.test.mjs';
const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const title = 'globalContext.client.isOffline answers false like the PCF client';
const model = describeParitySource(source, file);
const selected = model.registrations.find((row) => row.title === title);
const spec = { titleExpressionSha256: selected.titleExpressionSha256 };
const check = (text) => analyzeClientLateFixture(describeParitySource(text, file), spec);

test('permits the isolated later temporary fixture', () => {
  const review = check(source);
  assert.equal(review.recognizedBuiltinImports.size, 1);
  assert.equal(review.dependencies.length, 1);
});

test('rejects fixture access before the selected test or outside a direct late call', () => {
  for (const changed of [
    source.replace('const table = {', 'os.tmpdir(); const table = {'),
    source.replace('const table = {', "fs.writeFile('x', 'x'); const table = {"),
    source.replace('const table = {', "path.join('x'); const table = {"),
    source.replace('const table = {', 'ownedFixture({}); const table = {'),
    source.replace('const table = {', "makeTemporaryDirectory('x'); const table = {"),
    source.replace(
      'ownedFixture, makeTemporaryDirectory',
      'ownedFixture, makeTemporaryDirectory, removeFixtureDirectory',
    ),
    source.replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport { removeFixtureDirectory } from '../testing/owned-fixture.mjs';",
    ),
    source.replace('os.tmpdir()', "os['tmpdir']()"),
    source.replace('path.join(os.tmpdir()', 'path.join((() => { const os = {}; return os.tmpdir(); })()'),
    source.replace("test('$batch", "test.only('$batch"),
    source.replace("test('$batch", "test((os.tmpdir(), '$batch"),
    source.replace("test('$batch", "os.tmpdir(); test('$batch"),
    source.replace("whole', () => {", "whole', async () => {"),
    source.replace(`test('${title}', () => {`, `test('${title}', async () => {`),
  ]) {
    assert.throws(() => check(changed));
  }
});
