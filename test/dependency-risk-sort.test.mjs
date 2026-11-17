// @test-kind tooling: the type-aware Sonar sort rule checks the actual risk-policy canonicalizer and its failing original form.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';
import ts from 'typescript';
import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';

const source = fs.readFileSync(new URL('../scripts/dependency-risk-acceptance.mjs', import.meta.url), 'utf8');

function findings(t, text) {
  const directory = fs.realpathSync.native(makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-risk-sort-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'policy.mjs');
  fs.writeFileSync(filename, text);
  const program = ts.createProgram([filename], {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    typeRoots: [],
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  });
  return new Linter({ cwd: directory }).verify(
    text,
    [
      {
        files: ['**/*.mjs'],
        languageOptions: { parser, parserOptions: { programs: [program] } },
        plugins: { sonarjs },
        rules: { 'sonarjs/no-alphabetical-sort': 'error' },
      },
    ],
    { filename },
  );
}

test('the policy key sorter passes the actual typed rule and the original implicit sort fails it', (t) => {
  assert.deepEqual(findings(t, source), []);
  const original = source.replace('.sort(compareCanonicalKeys)', '.sort()');
  assert.notEqual(original, source);
  const errors = findings(t, original);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ruleId, 'sonarjs/no-alphabetical-sort');
  assert.equal(errors[0].messageId, 'provideCompareFunctionForArrayOfStrings');
});
