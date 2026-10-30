// @test-kind tooling: scripts/check-test-tags.mjs enforces docs/test-kinds.md on changed test files
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTestKinds, check } from '../scripts/check-test-tags.mjs';

const parityFile = [
  '// @test-kind parity: native dev-environment recording, reproduced twice (invented example)',
  "import test from 'node:test';",
  "test('native value', () => {",
  "  assert.equal(value(), 'none');",
  '});',
  '// @test-kind unproven: local model only',
  "test('local model', () => {",
  '  assert.equal(model(), 3);',
  '});',
].join('\n');

test('file and per-test kinds resolve per region and reject untagged or malformed tags', () => {
  const parsed = parseTestKinds(parityFile);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileKinds, ['parity']);
  assert.deepEqual(parsed.regions, [{ start: 6, end: 9, kinds: ['unproven'] }]);
  assert.match(parseTestKinds("test('x', () => {});").errors[0], /no @test-kind/);
  assert.match(parseTestKinds('// @test-kind parity: short\ntest("x", () => {});').errors[0], /evidence source/);
  assert.match(
    parseTestKinds('// @test-kind magic: something plausible\ntest("x", () => {});').errors[0],
    /unknown kind/,
  );
  assert.match(parseTestKinds('// @test-kind parity\ntest("x", () => {});').errors[0], /malformed/);
});

test('a parity line changes only together with a @parity-evidence line', () => {
  const changed = parityFile.replace("'none'", "''");
  const diff = "@@ -4 +4 @@\n-  assert.equal(value(), 'none');\n+  assert.equal(value(), '');\n";
  const run = (patch) =>
    check({ files: ['a.test.mjs'], newText: () => changed, oldText: () => parityFile, diffOf: () => patch });
  assert.match(run(diff)[0], /parity test/);
  assert.deepEqual(run(diff + '+// @parity-evidence: fresh native recording 2026-11-01 shows an empty string\n'), []);
  // Unproven regions change freely.
  const model = '@@ -8 +8 @@\n-  assert.equal(model(), 3);\n+  assert.equal(model(), 4);\n';
  assert.deepEqual(
    check({
      files: ['a.test.mjs'],
      newText: () => parityFile.replace('3);', '4);'),
      oldText: () => parityFile,
      diffOf: () => model,
    }),
    [],
  );
});
