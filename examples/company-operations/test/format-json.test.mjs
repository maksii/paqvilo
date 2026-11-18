// @test-kind tooling: formatJson writes JSON exactly as the toolkit's Prettier configuration formats it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatJson } from '../cli.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolkit = path.resolve(project, '../..');

// Prettier is a toolkit development dependency, not one of this example's: it is taken from the toolkit checkout.
async function toolkitPrettier() {
  try {
    const entry = createRequire(path.join(toolkit, 'package.json')).resolve('prettier');
    if (!entry.startsWith(path.join(toolkit, 'node_modules') + path.sep)) return null;
    return (await import(pathToFileURL(entry).href)).default;
  } catch {
    return null;
  }
}
const prettier = await toolkitPrettier();
const skip = prettier ? false : 'Prettier is not installed in a toolkit checkout above this example';

const numbers = (count, start = 0, step = 1) => Array.from({ length: count }, (_, i) => start + i * step);
const edgeInputs = {
  empty: { a: [], b: {}, c: [[]], d: [{}], e: [[], []], f: { g: {} } },
  longNumbers: { values: numbers(60, 1000) },
  negatives: { values: numbers(50, -500, 17) },
  floats: { values: numbers(40).map((n) => n + 0.125) },
  nestedNumbers: { rows: [numbers(30, 100), numbers(30, 200)] },
  arrayOfPairs: [
    [1, 2],
    [3, 4],
  ],
  mixedArrays: [[1, 2], [3]],
  strings: { list: Array.from({ length: 12 }, (_, i) => `value-${i}-abcdefgh`) },
  unicode: { text: 'café ☃ "quoted" \\ back', ctl: '\u0001' },
  objectsInArray: [{ a: 1 }, { b: 2, c: 3 }],
  arrayOfOneKeyObjects: { xs: [{ a: 1 }, { a: 2 }] },
  nullInArray: { xs: [null, 1, 'a', true] },
  deep: { a: { b: { c: { d: [1, 2, 3], e: 'x'.repeat(100) } } } },
};
// An inline string array around the 120-column limit, with its key and trailing comma.
for (const width of [118, 119, 120, 121, 122])
  edgeInputs[`boundary${width}`] = { k: ['x'.repeat(width - '  "k": ["'.length - '"],'.length)], z: 1 };
// Number arrays whose filled lines end exactly at the limit with and without the trailing comma.
for (let extra = 0; extra < 12; extra++)
  edgeInputs[`fill${extra}`] = { k: [...numbers(23, 10000), ...numbers(extra + 1, 1)] };
for (let digits = 1; digits < 8; digits++)
  edgeInputs[`fillDigits${digits}`] = { k: numbers(40).map((n) => Number('9'.repeat(digits)) + n) };

async function prettierFormat(text, file) {
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(text, { ...options, filepath: file });
}

test('formatJson matches Prettier on edge inputs', { skip }, async () => {
  const file = path.join(project, 'edge.json');
  for (const [name, value] of Object.entries(edgeInputs)) {
    const ours = formatJson(value);
    assert.equal(ours, await prettierFormat(ours, file), name);
  }
});

test('formatJson matches Prettier on the committed generated files', { skip }, async () => {
  for (const committed of [
    'dataverse/manifest.json',
    'data/catalogue.json',
    'data/stress-catalogue.json',
    'plugins/registrations.json',
  ]) {
    const file = path.join(project, committed);
    const ours = formatJson(JSON.parse(fs.readFileSync(file, 'utf8')));
    assert.equal(ours, await prettierFormat(ours, file), committed);
  }
});
