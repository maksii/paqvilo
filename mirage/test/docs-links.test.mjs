import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { docsLinks, DOC_PATHS } from '../lib/docs-links.mjs';

const repo = 'git+https://example.test/org/toolkit.git';

test('a plain release pins every link to its version tag', () => {
  const docs = docsLinks('0.9.6', repo);
  assert.equal(docs.packs.href, 'https://example.test/org/toolkit/blob/v0.9.6/mirage/docs/data-packs.md');
  assert.equal(docs.packs.path, 'mirage/docs/data-packs.md');
  assert.equal(docs.packs.label, 'Data Packs');
  for (const entry of Object.values(docs)) assert.match(entry.href, /\/blob\/v0\.9\.6\//);
});

test('a prerelease links to main and a missing repository yields paths only', () => {
  assert.match(docsLinks('0.9.6-preview.1', repo).setup.href, /\/blob\/main\/docs\/getting-started\.md$/);
  assert.equal(docsLinks('0.9.6', undefined).setup.href, null);
});

test('every documented path exists in the repository', async () => {
  for (const path of Object.values(DOC_PATHS)) await fs.access(new URL(`../../${path}`, import.meta.url));
});
