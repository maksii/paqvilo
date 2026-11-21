// @test-kind tooling: verifies the scanner's PCF program resolves all source types without component-local build installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tsc } from './tsc.mjs';

test('Sonar TypeScript configuration builds a complete typed PCF program', () => {
  const config = fileURLToPath(new URL('../.github/tsconfig.sonar.json', import.meta.url));
  const checked = tsc(['-p', config]);
  assert.equal(checked.status, 0, checked.output);
  const listed = tsc(['-p', config, '--listFilesOnly']);
  assert.equal(listed.status, 0, listed.output);
  const files = listed.output.split(/\r?\n/).map((file) => file.replaceAll('\\', '/'));
  for (const name of ['pcf-dataset-control', 'pcf-field-control', 'pcf-field-types', 'pcf-web-api-control']) {
    assert.ok(
      files.some((source) => source.includes('/' + name + '/')),
      'Missing component sources: ' + name,
    );
  }
});
