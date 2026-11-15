import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateReleaseFiles, REQUIRED_RELEASE_FILES, PROJECT_TEMPLATE_FILES } from '../scripts/release-check.mjs';

test('empty consumer templates are required release files and private template additions are excluded', () => {
  const required = REQUIRED_RELEASE_FILES.map((path) => ({ path }));
  // Every consumer template on disk ships, and the list names nothing that does not exist.
  const templates = fs
    .readdirSync(new URL('../templates/project/', import.meta.url))
    .map((name) => `templates/project/${name}`);
  assert.deepEqual([...PROJECT_TEMPLATE_FILES].sort(), templates.sort());
  assert.equal(validateReleaseFiles(required), required.length);
  for (const file of [
    'templates/project/.env',
    'templates/project/private.json',
    'templates/project/.paqvilo/discovery.json',
    'templates/project/fixtures/business.json',
  ]) {
    assert.throws(() => validateReleaseFiles([...required, { path: file }]), /Unexpected release file/);
  }
  assert.throws(
    () => validateReleaseFiles(required.filter((file) => file.path !== PROJECT_TEMPLATE_FILES[0])),
    /Required release file/,
  );
});
