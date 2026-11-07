// @test-kind tooling: scripts/check-test-tags.mjs enforces docs/test-kinds.md on changed test files
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTestKinds, check, kindsAt } from '../scripts/check-test-tags.mjs';

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

test('a tag on an indented test covers only that test', () => {
  const nested = [
    '// @test-kind contract: describe-level default',
    "describe('group', () => {",
    '  // @test-kind parity: native recording reproduced twice (invented example)',
    "  it('first', () => {});",
    "  it('second', () => {});",
    '});',
  ].join('\n');
  const parsed = parseTestKinds(nested);
  assert.deepEqual(kindsAt(parsed, 4), ['parity']);
  assert.deepEqual(kindsAt(parsed, 5), ['contract']);
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

test('a listed legacy file is skipped while untagged and checked in full once it carries a tag', () => {
  const untagged = "import test from 'node:test';\ntest('old', () => {});\ntest('older', () => {});";
  const run = (files, text) =>
    check({ files: Object.keys(files), newText: (file) => files[file] ?? text, legacy: new Set(['old.test.mjs']) });
  assert.deepEqual(run({ 'old.test.mjs': untagged }), []);
  assert.equal(run({ 'new.test.mjs': untagged }).length, 2, 'a file outside the list is checked');
  assert.deepEqual(run({ 'old.test.mjs': `// @test-kind contract: tagged when touched\n${untagged}` }), []);
  const perTest =
    "import test from 'node:test';\n// @test-kind contract: one test tagged\ntest('old', () => {});\ntest('older', () => {});";
  assert.match(run({ 'old.test.mjs': perTest })[0], /old\.test\.mjs: line 4: test has no @test-kind/);
});
