// @test-kind parity: two native Power Pages include-template captures on 2026-11-08 reproduce all 20 cases; mirage/test/fixtures/frontend-parity-evidence.md records source and output hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createPortalRenderer } from '../lib/liquid.mjs';
const caseBytes = fs.readFileSync(new URL('./fixtures/power-pages-language-cases.json', import.meta.url));
const expectedBytes = fs.readFileSync(new URL('./fixtures/power-pages-language-expected.json', import.meta.url));
assert.equal(
  createHash('sha256').update(caseBytes).digest('hex'),
  '99c620ba9e0cf548e3ad6464e073122843afaed413a482264fff657b0c09ec91',
);
assert.equal(
  createHash('sha256').update(expectedBytes).digest('hex'),
  '0a42f3a7b11cea8fa2187e71cadeef6aa1bdc3620432048654ea7824b4507ca8',
);
const cases = JSON.parse(caseBytes),
  expected = JSON.parse(expectedBytes);
assert.deepEqual(
  cases.map((row) => row.id),
  expected.map((row) => row.id),
);
const renderer = createPortalRenderer(
  {
    templates: Object.fromEntries(cases.map((row) => [row.id, { id: row.id, name: row.id, source: row.source }])),
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: {},
    pageTemplates: [],
  },
  {
    observed: {
      liquidRuntimeCompatibility: 'observed',
      liquidFilterErrors: 'observed',
      liquidHtmlVoidSerialization: 'html',
      liquidPathAndQueryFragment: 'query',
      evidence:
        'Repeated native 2026-11-08 include-template captures; mirage/test/fixtures/frontend-parity-evidence.md.',
    },
  },
);
for (const [index, row] of cases.entries()) {
  test(`native Power Pages language: ${row.id} (${row.test}, assertion ${row.assertion + 1})`, async () => {
    assert.equal(await renderer.renderString(`{% include '${row.id}' %}`, {}), expected[index].output);
  });
}
