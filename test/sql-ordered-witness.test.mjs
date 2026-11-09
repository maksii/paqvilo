// @test-kind tooling: The fixed ordered-case witness must bind the complete universe and original execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { verifySqlOrderedSource } from '../scripts/parity-sql-ordered-witness.mjs';
import { sharedParityDescriptor } from '../scripts/parity-shared-descriptor.mjs';
import { check, kindsAt, parseTestKinds } from '../scripts/check-test-tags.mjs';
const { parse } = createRequire(import.meta.url)('espree');
const ast = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module' });

test('ordered witness pins both original and corrected cases and every other entry', () => {
  const source = fs.readFileSync(new URL('../mirage/test/dataverse-tds-sql-eval.test.mjs', import.meta.url), 'utf8');
  verifySqlOrderedSource(ast(source));
  const original = source.replace("[['扡']]", "[['ab']]");
  assert.notEqual(original, source);
  verifySqlOrderedSource(ast(original), true);
  for (const changed of [
    source.replace("[['扡']]", "[['changed']]"),
    source.replace('binary bytes read as a big-endian int', 'different unselected case'),
    source.replace(
      'for (const [label, sql, expected] of orderedCases)',
      'for (const [label, expected, sql] of orderedCases)',
    ),
    source.replace(
      'for (const [label, sql, expected] of orderedCases) {\n  test(`evaluates: ${label}`, () => check(sql, expected));',
      'for (const [label, sql, expected] of orderedCases) {\n  test(`evaluates: ${label}`, () => check(sql, null));',
    ),
  ]) {
    assert.notEqual(changed, source);
    assert.throws(() => verifySqlOrderedSource(ast(changed)), /sql-ordered-witness-invalid/);
  }
});

test('only the ordered witnessed tuple is protected and dropping its marker needs proof', () => {
  const source = fs.readFileSync(new URL('../mirage/test/dataverse-tds-sql-eval.test.mjs', import.meta.url), 'utf8');
  const marked = source;
  const tree = parse(marked, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
  const descriptor = sharedParityDescriptor(tree).data.elements[0];
  const witness = descriptor.properties.find((item) => (item.key.name ?? item.key.value) === 'sqlOrderedWitness');
  assert.ok(witness);
  const lines = marked.split('\n'),
    tags = parseTestKinds(marked);
  assert.deepEqual(tags.errors, []);
  const selected = lines.findIndex((line) => line.includes('CAST text to varbinary and back to nvarchar')) + 1;
  const unselected = lines.findIndex((line) => line.includes('DECLAREd binary pads a short literal')) + 1;
  const callback = lines.findIndex((line) => line.includes('for (const [label, sql, expected] of orderedCases)')) + 2;
  assert.ok(kindsAt(tags, selected).includes('parity'));
  assert.ok(!kindsAt(tags, unselected).includes('parity'));
  assert.ok(kindsAt(tags, callback).includes('parity'));
  const colliding = marked.replace(
    "  ],\n  ['binary bytes read as a big-endian int'",
    "  ], ['binary bytes read as a big-endian int'",
  );
  assert.notEqual(colliding, marked);
  assert.ok(
    parseTestKinds(colliding).errors.some((message) => message.includes('invalid generated case parity guard')),
  );
  const afterWitness = marked.slice(witness.range[1]);
  assert.match(afterWitness, /^\s*,/u);
  const removed = marked.slice(0, witness.range[0]) + afterWitness.replace(/^(\s*),/u, '$1'),
    newLines = removed.split('\n');
  const changed = lines.findIndex((line, index) => line !== newLines[index]);
  const diff = `@@ -${changed + 1},1 +${changed + 1},1 @@\n-${lines[changed]}\n+${newLines[changed]}\n`;
  const failures = check({
    files: ['mirage/test/dataverse-tds-sql-eval.test.mjs'],
    newText: () => removed,
    oldText: () => marked,
    diffOf: () => diff,
  });
  assert.ok(failures.some((message) => message.includes('parity test')));
});
