// @test-kind parity: two independently loaded native Power Pages captures on 2026-11-08; mirage/test/fixtures/frontend-parity-evidence.md binds sources and literal responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createPortalRenderer } from '../lib/liquid.mjs';

const casesBytes = fs.readFileSync(new URL('./fixtures/power-pages-contract-cases.json', import.meta.url));
const expectedBytes = fs.readFileSync(new URL('./fixtures/power-pages-contract-expected.json', import.meta.url));
assert.equal(
  createHash('sha256').update(casesBytes).digest('hex'),
  'f0c2a5579aa331c7b50f6f36a636d65ee1b2978e339821e2e848fc6272d33ee7',
);
assert.equal(
  createHash('sha256').update(expectedBytes).digest('hex'),
  '2e7131f9b19f11c379357320babcf4f7e0b2e58e559ffe3b3a940f126fc3723f',
);
const cases = JSON.parse(casesBytes),
  expected = JSON.parse(expectedBytes);
assert.deepEqual(
  cases.map((row) => row.id),
  expected.map((row) => row.id),
);
const renderer = createPortalRenderer(
  {
    templates: {},
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
      liquidHtmlVoidSerialization: 'html',
      liquidPathAndQueryFragment: 'query',
      evidence: 'Repeated native captures on 2026-11-08; mirage/test/fixtures/frontend-parity-evidence.md.',
    },
  },
);
for (const [index, row] of cases.entries()) {
  test(`native Power Pages Liquid: ${row.id}`, async () => {
    assert.equal(await renderer.renderString(row.source, {}), expected[index].output);
  });
}
