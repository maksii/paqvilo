// @test-kind tooling: The fixed FROM-less source witness must bind all original rows and the executed loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { SQL_EXTRA_EVALUATOR_CASES, verifySqlMainSource } from '../scripts/parity-sql-main-witness.mjs';
import { check, kindsAt, parseTestKinds } from '../scripts/check-test-tags.mjs';
import { sharedParityDescriptor } from '../scripts/parity-shared-descriptor.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const ast = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

test('main evaluator witness rejects changed selected, unselected and loop source', () => {
  const source = fs.readFileSync(new URL('../mirage/test/dataverse-tds-sql-eval.test.mjs', import.meta.url), 'utf8');
  verifySqlMainSource(ast(source));
  for (const changed of [
    source.replace("SELECT TRY_CAST('abc' AS int) AS v", "SELECT TRY_CAST('def' AS int) AS v"),
    source.replace('WHERE and ORDER BY alias', 'different unselected case'),
    source.replace('for (const [label, sql, expected] of cases)', 'for (const [label, expected, sql] of cases)'),
  ]) {
    assert.notEqual(changed, source);
    assert.throws(() => verifySqlMainSource(ast(changed)), /sql-main-witness-invalid/);
  }
});

test('witness distinguishes property names from real case references', () => {
  const source = fs.readFileSync(new URL('../mirage/test/dataverse-tds-sql-eval.test.mjs', import.meta.url), 'utf8');
  verifySqlMainSource(ast(source + '\nconst harmless = { cases: 0 };\n'));
  for (const suffix of [
    '\nconst alias = cases;\n',
    '\nconst object = { cases };\n',
    '\nconst object = { [cases]: 0 };\n',
    '\nconst object = {}; object[cases];\n',
    '\n{ const cases = []; }\n',
  ]) {
    assert.throws(() => verifySqlMainSource(ast(source + suffix)), /sql-main-witness-invalid/);
  }
});

test('extra witnesses protect only their selected source rows and cannot be removed without evidence', () => {
  const source = fs.readFileSync(new URL('../mirage/test/dataverse-tds-sql-eval.test.mjs', import.meta.url), 'utf8');
  const extra = `"sqlExtraEvaluatorCases":${JSON.stringify({ cases: SQL_EXTRA_EVALUATOR_CASES, reviewPath: 'fixture', reviewSha256: 'a'.repeat(64), sourceReceiptSha256: 'b'.repeat(64) })},`;
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const descriptor = sharedParityDescriptor(tree).data.elements[0];
  const existing = descriptor.properties.find((item) => (item.key.name ?? item.key.value) === 'sqlExtraEvaluatorCases');
  const marked = existing
    ? source.slice(0, existing.range[0]) + extra.slice(0, -1) + source.slice(existing.range[1])
    : source.replace('"sqlEvaluator":true,', `"sqlEvaluator":true,${extra}`);
  assert.notEqual(marked, source);
  const lines = marked.split('\n'),
    tags = parseTestKinds(marked);
  assert.deepEqual(tags.errors, []);
  for (const name of ['TRY_CAST returns NULL on failure', 'binary bytes read as a big-endian int']) {
    const line = lines.findIndex((value) => value.includes(name)) + 1;
    assert.ok(line > 0 && kindsAt(tags, line).includes('parity'));
  }
  for (const name of ['WHERE and ORDER BY alias', 'DECLAREd binary pads a short literal']) {
    const line = lines.findIndex((value) => value.includes(name)) + 1;
    assert.ok(line > 0 && !kindsAt(tags, line).includes('parity'));
  }
  const removed = marked.replace(extra, ''),
    next = removed.split('\n'),
    changed = lines.findIndex((line, index) => line !== next[index]);
  assert.notEqual(removed, marked);
  const diff = `@@ -${changed + 1},1 +${changed + 1},1 @@\n-${lines[changed]}\n+${next[changed]}\n`;
  const failures = check({
    files: ['mirage/test/dataverse-tds-sql-eval.test.mjs'],
    newText: () => removed,
    oldText: () => marked,
    diffOf: () => diff,
  });
  assert.ok(failures.some((message) => message.includes('parity test')));
});
