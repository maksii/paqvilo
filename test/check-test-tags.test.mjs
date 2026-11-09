// @test-kind tooling: scripts/check-test-tags.mjs enforces docs/test-kinds.md on changed test files
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseTestKinds, check, kindsAt } from '../scripts/check-test-tags.mjs';
import { parityAstHash } from '../scripts/qualify-parity.mjs';
const { parse } = createRequire(import.meta.url)('espree');

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

test('marker spellings in fixture strings and comments are not executable guards', () => {
  const text = [
    '// @test-kind tooling: invented checker fixture source.',
    '// __paqQueryBindings __paqSoapBindings __paqScalarBindings',
    'const query = "__paqQueryBindings(import.meta.url, [])";',
    'const soap = `__paqSoapBindings(import.meta.url, [])`;',
    'const scalar = /__paqScalarBindings/;',
    "test('fixture', () => assert.ok(query && soap && scalar));",
  ].join('\n');
  assert.deepEqual(parseTestKinds(text).errors, []);
  for (const name of ['__paqQueryBindings', '__paqSoapBindings', '__paqScalarBindings']) {
    const executable = text + `\n${name}(import.meta.url, []);\n`;
    assert.ok(parseTestKinds(executable).errors.some((error) => error.includes('invalid generated')));
  }
  const broken = text + '\n__paqQueryBindings(import.meta.url, [\n';
  assert.ok(parseTestKinds(broken).errors.some((error) => error.includes('invalid generated')));
});

test('query guard protects selected source entries without promoting held cases', () => {
  const lines = [
    '// @test-kind unproven: invented query guard fixture.',
    "import { guard as __paqQueryBindings } from './tool.mjs';",
    'const __paqQueryDescriptor = { selectedIndices: [0, 2, 4, 6, 8] };',
    '__paqQueryBindings(import.meta.url, [{}]);',
    "test('parent', async () => {",
    '  const cases = [',
    ...Array.from({ length: 63 }, (_, index) => `    ['q', '${index}', 400, 'message'],`),
    '  ];',
    '  let count = 0;',
    '  for (const [option, value, status, message] of cases)',
    '    await t.test(value, async () => {',
    '      __paqQueryCase(cases, count++, [option, value, status, message], __paqQueryDescriptor);',
    '      assert.equal(1, 1);',
    '      assert.equal(2, 2);',
    '      assert.equal(3, 3);',
    '    });',
    '  __paqQueryComplete(count, __paqQueryDescriptor);',
    '});',
  ];
  const parsed = parseTestKinds(lines.join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(kindsAt(parsed, 7), ['parity']);
  assert.deepEqual(kindsAt(parsed, 8), ['unproven']);
  const extended = lines
    .join('\n')
    .replace('[0, 2, 4, 6, 8]', JSON.stringify(Array.from({ length: 21 }, (_, index) => index)));
  const extendedParsed = parseTestKinds(extended);
  assert.deepEqual(extendedParsed.errors, []);
  assert.deepEqual(kindsAt(extendedParsed, 27), ['parity']);
  assert.deepEqual(kindsAt(extendedParsed, 28), ['unproven']);
  assert.ok(
    parseTestKinds(lines.join('\n').replace('  __paqQueryComplete(count, __paqQueryDescriptor);', '')).errors.length,
  );
});

test('SOAP loop checker protects selected inputs and markers without tagging held values', () => {
  const lines = [
    '// @test-kind compatibility: invented SOAP marker fixture.',
    "import { value as __paqSoapValue } from './helper.mjs';",
    "import { guard as __paqSoapBindings } from './tool.mjs';",
    `const __paqSoapDescriptor = { selectedIndices: ${JSON.stringify(Array.from({ length: 21 }, (_, index) => index))} };`,
    '__paqSoapBindings(import.meta.url, [{}]);',
    'const VALUES = [',
    ...Array.from({ length: 27 }, (_, index) => `  ${index},`),
    '];',
    "test('loop', () => {",
    '  let index = 0;',
    '  for (const value of VALUES) {',
    '    const xml = value;',
    '    __paqSoapValue(VALUES, index++, value, xml, __paqSoapDescriptor);',
    '    assert.equal(xml, value);',
    '    assert.equal(xml, value);',
    '  }',
    '  __paqSoapComplete(index, __paqSoapDescriptor);',
    '  assert.equal(decodeFrom(__paqSoapTail(1, 0, __paqSoapDescriptor)), 1);',
    '  assert.equal(decodeFrom(__paqSoapTail(2, 1, __paqSoapDescriptor)), 2);',
    '});',
  ];
  const parsed = parseTestKinds(lines.join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(kindsAt(parsed, 7), ['parity']);
  assert.deepEqual(kindsAt(parsed, 28), ['compatibility']);
  assert.deepEqual(kindsAt(parsed, lines.findIndex((line) => line.includes('__paqSoapComplete(')) + 1), ['parity']);
  const extended = lines
    .join('\n')
    .replace(
      JSON.stringify(Array.from({ length: 21 }, (_, index) => index)),
      JSON.stringify(Array.from({ length: 22 }, (_, index) => index)),
    );
  assert.deepEqual(parseTestKinds(extended).errors, []);
  assert.deepEqual(kindsAt(parseTestKinds(extended), 28), ['parity']);
  assert.ok(parseTestKinds(extended.replace('[0,1,2,3', '[0,0,2,3')).errors.length);
  const sibling =
    lines
      .join('\n')
      .replace(
        '__paqSoapBindings(import.meta.url, [{}]);',
        '__paqSoapBindings(import.meta.url, [{namespaceRegions:[{factId:"namespace"}]}]);\n' +
          "import { assertSoapNamespaceProof as __paqSoapNamespaceProof } from './tool.mjs';",
      ) +
    "\ntest('sibling', () => {\n  assert.ok(localOnly);\n  {\n    __paqSoapNamespaceProof(import.meta.url, 'namespace');\n    assert.equal(actualNamespace, expectedNamespace);\n  }\n});\n";
  const siblingTags = parseTestKinds(sibling),
    siblingLines = sibling.split('\n');
  assert.deepEqual(siblingTags.errors, []);
  assert.deepEqual(kindsAt(siblingTags, siblingLines.findIndex((line) => line.includes('assert.ok(localOnly)')) + 1), [
    'compatibility',
  ]);
  assert.deepEqual(
    kindsAt(siblingTags, siblingLines.findIndex((line) => line.includes('assert.equal(actualNamespace')) + 1),
    ['parity'],
  );
  assert.ok(
    parseTestKinds(sibling.replace("__paqSoapNamespaceProof(import.meta.url, 'namespace');", '')).errors.length,
  );
  const valueSibling = sibling
    .replaceAll('SoapNamespaceProof', 'SoapValueProof')
    .replace('namespaceRegions', 'valueRegions');
  const valueTags = parseTestKinds(valueSibling),
    valueLines = valueSibling.split('\n');
  assert.deepEqual(valueTags.errors, []);
  assert.deepEqual(kindsAt(valueTags, valueLines.findIndex((line) => line.includes('assert.ok(localOnly)')) + 1), [
    'compatibility',
  ]);
  assert.deepEqual(
    kindsAt(valueTags, valueLines.findIndex((line) => line.includes('assert.equal(actualNamespace')) + 1),
    ['parity'],
  );
  assert.ok(
    parseTestKinds(valueSibling.replace("__paqSoapValueProof(import.meta.url, 'namespace');", '')).errors.length,
  );
  assert.ok(
    parseTestKinds(lines.join('\n').replace('  __paqSoapComplete(index, __paqSoapDescriptor);', '')).errors.length,
  );
});

test('scalar migration source guard is protected without retagging its parent', () => {
  const source = [
    '// @test-kind contract: invented scalar migration tooling fixture.',
    "import { assertScalarParityBindings as __paqScalarBindings } from './tool.mjs';",
    '__paqScalarBindings(import.meta.url, [{ kind: "scalar-reader-migration-v1" }]);',
    "test('local policy', () => assert.ok(true));",
  ].join('\n');
  const parsed = parseTestKinds(source);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(kindsAt(parsed, 2), ['parity']);
  assert.deepEqual(kindsAt(parsed, 3), ['parity']);
  assert.deepEqual(kindsAt(parsed, 4), ['contract']);
  assert.ok(
    parseTestKinds(
      source.replace(
        '__paqScalarBindings(import.meta.url, [{ kind: "scalar-reader-migration-v1" }]);',
        '__paqScalarBindings(import.meta.url);',
      ),
    ).errors.length,
  );
  const failures = check({
    files: ['scalar.test.mjs'],
    oldText: () => source,
    newText: () =>
      source.replace('__paqScalarBindings(import.meta.url, [{ kind: "scalar-reader-migration-v1" }]);\n', ''),
    diffOf: () => '@@ -3 +3 @@\n-old\n',
  });
  assert.match(failures[0], /parity test/);
});

test('case guard protects mapped entries and shared assertion without tagging unmatched cases', () => {
  const lines = [
    '// @test-kind unproven: invented mixed matrix for tooling.',
    "import { parityCaseBindings as __paqParityCaseBindings, assertParityBindings as __paqParityBindings } from './tool.mjs';",
    '__paqParityBindings(import.meta.url, []);',
    'const cases = [',
    "  ['first', 1],",
    "  ['unmatched', 2],",
    "  ['third', 3],",
    '];',
    'for (const [name, expected] of cases) {',
    '  test(name, () => {',
    '    __paqParityCaseBindings(import.meta.url, cases, [0, 2], [name, expected], []);',
    '    assert.equal(actual(name), expected);',
    '  });',
    '}',
  ];
  const parsed = parseTestKinds(lines.join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(kindsAt(parsed, 5), ['parity']);
  assert.deepEqual(kindsAt(parsed, 6), ['unproven']);
  assert.deepEqual(kindsAt(parsed, 7), ['parity']);
  assert.deepEqual(kindsAt(parsed, 9), ['unproven']);
  assert.deepEqual(kindsAt(parsed, 11), ['parity']);
  assert.deepEqual(kindsAt(parsed, 12), ['parity']);
  for (const line of [5, 7, 11, 12]) {
    const failures = check({
      files: ['mixed.test.mjs'],
      oldText: () => lines.join('\n'),
      newText: () => lines.join('\n'),
      diffOf: () => `@@ -${line} +${line} @@\n-old\n+new\n`,
    });
    assert.match(failures[0], /parity test/);
  }
  assert.ok(parseTestKinds(lines.join('\n').replace('[0, 2]', '[0, 0]')).errors.length);
  const sharedLine = lines.join('\n').replace("['first', 1],\n  ['unmatched', 2],", "['first', 1], ['unmatched', 2],");
  assert.ok(parseTestKinds(sharedLine).errors.length);
});

test('case metadata protects exact retained assertions without tagging their surrounding branch', () => {
  const assertions = Array.from({ length: 7 }, (_, index) => `assert.equal(${index}, ${index});`);
  const retainedHashes = assertions.map((statement) =>
    parityAstHash(parse(statement, { ecmaVersion: 'latest' }).body[0].expression),
  );
  const lines = [
    '// @test-kind unproven: invented retained case proof tooling.',
    'const cases = [',
    '  1,',
    '  2,',
    '];',
    'for (const value of cases) {',
    '  test(value, () => {',
    '    if (value === 1) {',
    ...assertions.map((statement) => `      ${statement}`),
    '    }',
    `    __paqParityCaseBindings(import.meta.url, cases, [0], { value }, [{ caseSelection: { retainedAssertionHashes: ${JSON.stringify(retainedHashes)} } }]);`,
    '    return assert.equal(value, value);',
    '  });',
    '}',
  ];
  const parsed = parseTestKinds(lines.join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(kindsAt(parsed, 8), ['unproven']);
  for (let line = 9; line <= 15; line++) assert.deepEqual(kindsAt(parsed, line), ['parity']);
  assert.deepEqual(kindsAt(parsed, 17), ['parity']);
  assert.deepEqual(kindsAt(parsed, 18), ['parity']);
  assert.ok(parseTestKinds(lines.join('\n').replace('assert.equal(3, 3)', 'assert.equal(3, 4)')).errors.length);
});

test('pre-branch case guard protects retained assertions without tagging the conditional', () => {
  const assertion = 'assert.throws(() => actual(value));';
  const hash = parityAstHash(parse(assertion, { ecmaVersion: 'latest' }).body[0].expression);
  const lines = [
    '// @test-kind unproven: invented guarded branch tooling.',
    'const cases = [',
    ...Array.from({ length: 139 }, (_, index) => `  ${index},`),
    '];',
    'for (const value of cases) {',
    '  test(value, () => {',
    `    __paqParityCaseBindings(import.meta.url, cases, [138], { value }, [{ caseSelection: { guardBeforeGuidBranch: true, retainedAssertionHashes: [${JSON.stringify(hash)}] } }]);`,
    '    if (value === 138) {',
    `      ${assertion}`,
    '      return;',
    '    }',
    '    return assert.equal(actual(value), value);',
    '  });',
    '}',
  ];
  const parsed = parseTestKinds(lines.join('\n'));
  assert.deepEqual(parsed.errors, []);
  const branch = lines.findIndex((line) => line.includes('if (value')) + 1;
  assert.deepEqual(kindsAt(parsed, branch), ['unproven']);
  assert.deepEqual(kindsAt(parsed, branch + 1), ['parity']);
  assert.deepEqual(kindsAt(parsed, branch + 4), ['parity']);
  assert.ok(parseTestKinds(lines.join('\n').replace('[138]', '[137]')).errors.length);
  assert.ok(parseTestKinds(lines.join('\n').replace(assertion, 'assert.throws(() => changed(value));')).errors.length);
});

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

test('awaited native subtests retain their own proof region without retagging outer diagnostics', () => {
  const lines = [
    '// @test-kind contract: outer setup and diagnostic policy',
    "import test from 'node:test';",
    "test('reader matrix', async (t) => {",
    ...Array(40).fill(''),
    '  // @test-kind parity: two source-bound native captures of each reader case',
    "  await t.test('native case', async () => {",
    '    assert.equal(actual, expected);',
    '  });',
    '  assert.equal(localDiagnosticPolicy, true);',
    "  t.test('local contract', () => {});",
    '});',
  ];
  const parsed = parseTestKinds(lines.join('\n'));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.fileKinds, ['contract']);
  const lineOf = (fragment) => lines.findIndex((line) => line.includes(fragment)) + 1;
  assert.deepEqual(kindsAt(parsed, lineOf('actual, expected')), ['parity']);
  assert.deepEqual(kindsAt(parsed, lineOf('localDiagnosticPolicy')), ['contract']);
  assert.deepEqual(kindsAt(parsed, lineOf('local contract')), ['contract']);
  const run = (line) =>
    check({
      files: ['reader.test.mjs'],
      newText: () => lines.join('\n'),
      oldText: () => lines.join('\n'),
      diffOf: () => `@@ -${line} +${line} @@\n-previous\n+current\n`,
    });
  assert.match(run(lineOf('actual, expected'))[0], /parity test/);
  assert.deepEqual(run(lineOf('localDiagnosticPolicy')), []);
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

test('deleting a parity file or stripping a legacy parity tag still requires new proof', () => {
  const files = ['old.test.mjs'];
  const removal = '@@ -1,9 +0,0 @@\n';
  const run = (text, diff = removal) =>
    check({
      files,
      newText: () => text,
      oldText: () => parityFile,
      diffOf: () => diff,
      legacy: new Set(files),
    });
  assert.match(run(null)[0], /parity test/);
  assert.match(run(parityFile.replace(/^\/\/ @test-kind.*\n/gm, ''))[0], /parity test/);
  assert.deepEqual(
    run(null, removal + '+// @parity-evidence: synthetic checker input demonstrates proof handling\n'),
    [],
  );
  assert.deepEqual(
    check({ files, newText: () => null, oldText: () => "test('old', () => {});", diffOf: () => '@@ -1 +0,0 @@\n' }),
    [],
  );
});

test('generated partial blocks protect assertions and source guard while parent remains unproven', () => {
  const text = `// @test-kind unproven: invented partial fixture
import { parityAssertions as __paqParityAssertions, assertParityBindings as __paqParityBindings } from './guard.mjs';
__paqParityBindings(import.meta.url, []);
test('mixed', async () => {
  assert.equal(local(), 1);
  {
    __paqParityAssertions(import.meta.url, []);
    assert.equal(await native(), 2);
  }
  assert.equal(other(), 3);
});`;
  const parsed = parseTestKinds(text);
  assert.deepEqual(kindsAt(parsed, 5), ['unproven']);
  assert.deepEqual(kindsAt(parsed, 8), ['parity']);
  assert.deepEqual(kindsAt(parsed, 10), ['unproven']);
  const run = (line) =>
    check({
      files: ['partial.test.mjs'],
      oldText: () => text,
      newText: () => text,
      diffOf: () => `@@ -${line} +${line} @@\n-old\n+new\n`,
    });
  assert.match(run(8)[0], /parity test/);
  assert.match(run(3)[0], /parity test/);
  assert.deepEqual(run(10), []);
});

test('insertion-only wrapping of a source guard is rejected', () => {
  const old = `// @test-kind unproven: fixture
import { parityAssertions as __paqParityAssertions, assertParityBindings as __paqParityBindings } from './guard.mjs';
__paqParityBindings(import.meta.url, []);
test('mixed', () => { { __paqParityAssertions(import.meta.url, []); assert.equal(1, 1); } });`;
  const changed = old.replace(
    '__paqParityBindings(import.meta.url, []);',
    'if (false) {\n__paqParityBindings(import.meta.url, []);\n}',
  );
  const problems = check({
    files: ['sample.test.mjs'],
    oldText: () => old,
    newText: () => changed,
    diffOf: () => '@@ -2,0 +3 @@\n+if (false) {\n@@ -3,0 +5 @@\n+}\n',
  });
  assert.match(problems[0], /no longer executed at module level/);
});

test('insertion-only wrapping of a whole-test source guard is rejected', () => {
  const old = `// @test-kind unproven: fixture
import { assertParityBindingsFromSource as __paqParitySourceBindings } from './guard.mjs';
test('parity source bindings 0123456789abcdef', () => { __paqParitySourceBindings(import.meta.url); });`;
  const changed = old.replace("test('parity source", "if (false) {\ntest('parity source") + '\n}';
  const problems = check({
    files: ['sample.test.mjs'],
    oldText: () => old,
    newText: () => changed,
    diffOf: () => '@@ -2,0 +3 @@\n+if (false) {\n@@ -3,0 +5 @@\n+}\n',
  });
  assert.match(problems[0], /no longer executed at module level/);
});

test('a decoy top-level guard or executable statement before it cannot replace the real source guard', () => {
  const old = `// @test-kind unproven: fixture
import { parityAssertions as __paqParityAssertions, assertParityBindings as __paqParityBindings } from './guard.mjs';
__paqParityBindings(import.meta.url, [{a: 1}]);
test('mixed', () => { { __paqParityAssertions(import.meta.url, [{a: 1}]); assert.equal(1, 1); } });`;
  const run = (changed) =>
    check({
      files: ['sample.test.mjs'],
      oldText: () => old,
      newText: () => changed,
      diffOf: () => '@@ -2,0 +3 @@\n+insertion\n',
    });
  assert.match(
    run(
      old.replace(
        '__paqParityBindings(import.meta.url, [{a: 1}]);',
        'if (false) { __paqParityBindings(import.meta.url, [{a: 1}]); }\n__paqParityBindings(import.meta.url, []);',
      ),
    )[0],
    /no longer executed/,
  );
  assert.match(
    run(
      old.replace(
        '__paqParityBindings(import.meta.url, [{a: 1}]);',
        'process.exit(0);\n__paqParityBindings(import.meta.url, [{a: 1}]);',
      ),
    )[0],
    /no longer executed/,
  );
});

// @test-kind tooling: shared descriptor source and selected values remain protected, with malformed aliases rejected.
test('shared case descriptor is protected and invalid aliases fail closed', () => {
  const lines = [
    '// @test-kind unproven: invented matrix',
    "import { parityCaseBindings as __paqParityCaseBindings, assertParityBindings as __paqParityBindings, freezeParityDescriptor as __paqParityFreeze } from './scripts/qualify-parity.mjs';",
    'const __paqParityShared = __paqParityFreeze([{caseSelection:{}}]);',
    '__paqParityBindings(import.meta.url, __paqParityShared);',
    'const cases = [',
    "  ['first', 1],",
    "  ['unmatched', 2],",
    "  ['third', 3],",
    '];',
    'for (const [name, expected] of cases) {',
    '  test(name, () => {',
    '    __paqParityCaseBindings(import.meta.url, cases, [0, 2], [name, expected], __paqParityShared);',
    '    assert.equal(actual(name), expected);',
    '  });',
    '}',
  ];
  const text = lines.join('\n'),
    parsed = parseTestKinds(text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(kindsAt(parsed, 3), ['parity']);
  assert.deepEqual(kindsAt(parsed, 6), ['parity']);
  assert.deepEqual(kindsAt(parsed, 7), ['unproven']);
  assert.match(
    check({
      files: ['mixed.test.mjs'],
      oldText: () => text,
      newText: () => text,
      diffOf: () => '@@ -3 +3 @@\n-old\n+new\n',
    })[0],
    /parity test/,
  );
  for (const changed of [
    text.replace('const __paqParityShared', 'let __paqParityShared'),
    text.replace(
      'assert.equal(actual(name), expected);',
      'const alias = __paqParityShared; assert.equal(actual(name), expected);',
    ),
    text.replace(
      '__paqParityBindings(import.meta.url, __paqParityShared)',
      '__paqParityBindings(import.meta.url, unknown)',
    ),
  ])
    assert.ok(parseTestKinds(changed).errors.length);
});
