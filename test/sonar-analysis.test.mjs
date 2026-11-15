// @test-kind tooling: verifies the scanner's PCF program resolves all source types without component-local build installs.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

test('Sonar TypeScript configuration builds a complete typed PCF program', () => {
  const file = fileURLToPath(new URL('../.github/tsconfig.sonar.json', import.meta.url));
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  assert.equal(loaded.error, undefined);
  const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(file));
  const program = ts.createProgram(config.fileNames, config.options);
  const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnostics(diagnostics, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => '\n',
    }),
  );
  for (const name of ['pcf-dataset-control', 'pcf-field-control', 'pcf-field-types', 'pcf-web-api-control']) {
    assert.ok(
      config.fileNames.some((source) => source.replaceAll('\\', '/').includes('/' + name + '/')),
      'Missing component sources: ' + name,
    );
  }
});
