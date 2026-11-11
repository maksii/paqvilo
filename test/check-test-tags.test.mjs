// @test-kind tooling: scripts/check-test-tags.mjs enforces docs/test-kinds.md on changed test files
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTestKinds, check, kindsAt, diffFacts } from '../scripts/check-test-tags.mjs';

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

const CASE = 'mirage/test/parity/cases/power-fx/root.json';
const GAP = 'mirage/test/parity/known-gaps/power-fx.json';
const LEDGER = 'scripts/parity-retirements.json';
const REASON = 'invented reason long enough for the ledger rule';
const AUTHORITY = 'user request 2026-11-11: checker test';

const caseOf = (id, output = { kind: 'number', value: 7 }) => ({
  id,
  input: { expression: 'Abs(-7)' },
  output,
  volatile: [],
});

const caseFile = ({ cases = [caseOf('abs-negative')], oracle, history = [] } = {}) =>
  JSON.stringify({
    schema: 'paqvilo.parity-cases/1',
    surface: 'power-fx',
    suite: 'root',
    oracle: oracle ?? {
      kind: 'official-package',
      name: 'Microsoft.PowerFx.Interpreter',
      version: '1.4.0',
      scope: 'Invented scope for checker tests only.',
    },
    captures: [
      { id: 'run-1', sha256: 'a'.repeat(64), capturedAt: '2026-11-08' },
      { id: 'run-2', sha256: 'b'.repeat(64), capturedAt: '2026-11-08' },
    ],
    cases,
    history,
  });

const ledger = (retirements = []) => JSON.stringify({ version: 1, retirements });
const retirement = (file) => ({ file, reason: REASON, authority: AUTHORITY });

// Text callbacks that answer by path; any other path reads as absent.
const byPath = (files) => (file) => files[file] ?? null;

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

test('diffFacts reports old and new line numbers and the texts of changed lines', () => {
  const facts = diffFacts('--- a/x\n+++ b/x\n@@ -4 +4,2 @@\n-  old line\n+  new line\n+  extra\n');
  assert.deepEqual(facts.removed, [4]);
  assert.deepEqual(facts.added, [4, 5]);
  assert.deepEqual(facts.removedText, ['  old line']);
  assert.deepEqual(facts.addedText, ['  new line', '  extra']);
  assert.equal(facts.evidence, false);
});

test('a new parity tag on a per-test declaration fails', () => {
  const text = [
    "import test from 'node:test';",
    '// @test-kind parity: native recording reproduced twice (invented example)',
    "test('native', () => {});",
  ].join('\n');
  const failures = check({ files: ['new.test.mjs'], newText: () => text, oldText: () => null, diffOf: () => '' });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /new\.test\.mjs: line 2: a new parity tag is only valid on a replay runner/);
});

test('a new file-level parity tag on a file that declares tests fails', () => {
  const text = [
    '// @test-kind parity: native recording reproduced twice (invented example)',
    "import test from 'node:test';",
    "test('native', () => {});",
  ].join('\n');
  const failures = check({ files: ['new.test.mjs'], newText: () => text, oldText: () => null, diffOf: () => '' });
  assert.match(failures[0], /line 1: a new parity tag/);
});

test('a new replay runner with a file-level parity tag passes, with a for loop or with replayParityDirectory', () => {
  const loop = [
    '// @test-kind parity: native capture reproduced twice (invented example)',
    "import { replayParityCases } from '../../mirage/testing/parity-cases.mjs';",
    "for (const suite of ['root']) {",
    "  replayParityCases(new URL('./cases/power-fx/root.json', import.meta.url), run, { knownGaps: {} });",
    '}',
  ].join('\n');
  const directory = [
    '// @test-kind parity: native capture reproduced twice (invented example)',
    "import { replayParityDirectory } from '../../mirage/testing/parity-cases.mjs';",
    "await replayParityDirectory({ surface: 'power-fx', dir: './cases/power-fx' });",
  ].join('\n');
  for (const text of [loop, directory]) {
    assert.deepEqual(
      check({ files: ['new.test.mjs'], newText: () => text, oldText: () => null, diffOf: () => '' }),
      [],
    );
  }
});

test('an existing parity tag that is unchanged passes', () => {
  assert.deepEqual(
    check({ files: ['a.test.mjs'], newText: () => parityFile, oldText: () => parityFile, diffOf: () => '' }),
    [],
  );
});

test('an existing parity tag whose line moved passes', () => {
  const old = [
    '// @test-kind parity: native capture reproduced twice (invented example)',
    "import { replayParityCases } from '../testing/parity-cases.mjs';",
    "await replayParityCases(new URL('./cases/power-fx/root.json', import.meta.url), run);",
  ].join('\n');
  const moved = [
    "import { replayParityCases } from '../testing/parity-cases.mjs';",
    '// @test-kind parity: native capture reproduced twice (invented example)',
    "await replayParityCases(new URL('./cases/power-fx/root.json', import.meta.url), run);",
  ].join('\n');
  // Moving the tag removes its old line, which is a parity line change and needs proof of its own.
  const diff = [
    '@@ -1 +0,0 @@',
    '-// @test-kind parity: native capture reproduced twice (invented example)',
    '@@ -0,0 +2 @@',
    '+// @test-kind parity: native capture reproduced twice (invented example)',
    '@@ -0,0 +4 @@',
    '+// @parity-evidence: synthetic checker input shows that the moved tag keeps its proof',
    '',
  ].join('\n');
  const failures = check({ files: ['a.test.mjs'], newText: () => moved, oldText: () => old, diffOf: () => diff });
  assert.deepEqual(
    failures.filter((failure) => /a new parity tag/.test(failure)),
    [],
  );
  assert.deepEqual(failures, []);
});

test('a tag changed from unproven to parity on an existing test fails', () => {
  const old = "// @test-kind unproven: local model only\ntest('local', () => {});";
  const changed = "// @test-kind parity: native recording reproduced twice\ntest('local', () => {});";
  const diff =
    '@@ -1 +1 @@\n-// @test-kind unproven: local model only\n+// @test-kind parity: native recording reproduced twice\n';
  const failures = check({ files: ['a.test.mjs'], newText: () => changed, oldText: () => old, diffOf: () => diff });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /a\.test\.mjs: line 1: a new parity tag/);
});

test('an invalid case file fails in file-list mode too', () => {
  const failures = check({ files: [CASE], newText: () => '{"schema":"other"}' });
  assert.ok(failures.length > 0);
  assert.ok(failures.every((failure) => failure.startsWith(`${CASE}: `)));
});

test('changed output of a recorded case without a history entry fails', () => {
  const changed = caseFile({ cases: [caseOf('abs-negative', { kind: 'number', value: 8 })] });
  const failures = check({
    files: [CASE],
    newText: byPath({ [CASE]: changed }),
    oldText: byPath({ [CASE]: caseFile() }),
    diffOf: () => '',
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /changes recorded parity cases \(abs-negative\) without a new history entry/);
});

test('changed output of a recorded case with a new history entry passes', () => {
  const history = [{ date: '2026-11-11', change: 'corrected expected value', evidence: 'third native capture' }];
  const changed = caseFile({ cases: [caseOf('abs-negative', { kind: 'number', value: 8 })], history });
  assert.deepEqual(
    check({
      files: [CASE],
      newText: byPath({ [CASE]: changed }),
      oldText: byPath({ [CASE]: caseFile() }),
      diffOf: () => '',
    }),
    [],
  );
});

test('an added recorded case needs no history entry', () => {
  const added = caseFile({ cases: [caseOf('abs-negative'), caseOf('abs-positive', { kind: 'number', value: 7 })] });
  assert.deepEqual(
    check({
      files: [CASE],
      newText: byPath({ [CASE]: added }),
      oldText: byPath({ [CASE]: caseFile() }),
      diffOf: () => '',
    }),
    [],
  );
});

test('a changed oracle without a history entry fails', () => {
  const changed = caseFile({
    oracle: { kind: 'official-package', name: 'Microsoft.PowerFx.Interpreter', version: '1.5.0', scope: 'Invented.' },
  });
  const failures = check({
    files: [CASE],
    newText: byPath({ [CASE]: changed }),
    oldText: byPath({ [CASE]: caseFile() }),
    diffOf: () => '',
  });
  assert.match(failures[0], /changes recorded parity cases \(oracle\) without a new history entry/);
});

test('a deleted case file fails without a retirement entry and passes with one', () => {
  const oldText = byPath({ [CASE]: caseFile(), [LEDGER]: ledger() });
  const failures = check({ files: [CASE], newText: byPath({}), oldText, diffOf: () => '' });
  assert.match(failures[0], /deletes recorded parity cases; add a retirement entry/);
  const retired = byPath({ [LEDGER]: ledger([retirement(CASE)]) });
  assert.deepEqual(
    check({
      files: [CASE, LEDGER],
      newText: retired,
      oldText: byPath({ [CASE]: caseFile(), [LEDGER]: ledger() }),
      diffOf: () => '',
    }),
    [],
  );
});

test('a new gap for a recorded case fails', () => {
  const gaps = JSON.stringify({ 'root#abs-negative': 'Mirage rounds differently, invented reason here' });
  const failures = check({
    files: [GAP],
    newText: byPath({ [GAP]: gaps }),
    oldText: byPath({ [CASE]: caseFile() }),
    diffOf: () => '',
  });
  assert.match(failures[0], /declares a new gap for recorded case root#abs-negative/);
});

test('a new gap for a case added in the same change passes', () => {
  const gaps = JSON.stringify({ 'root#abs-new': 'Mirage differs on a case that this change adds' });
  assert.deepEqual(
    check({
      files: [GAP],
      newText: byPath({ [GAP]: gaps }),
      oldText: byPath({ [CASE]: caseFile() }),
      diffOf: () => '',
    }),
    [],
  );
});

test('a pointer gap that gains a pointer for a recorded case fails', () => {
  const old = JSON.stringify({ 'root#abs-negative': { '/output/value': 'first reason is long enough' } });
  const gaps = JSON.stringify({
    'root#abs-negative': { '/output/value': 'first reason is long enough', '/output/kind': 'second reason here' },
  });
  const failures = check({
    files: [GAP],
    newText: byPath({ [GAP]: gaps }),
    oldText: byPath({ [GAP]: old, [CASE]: caseFile() }),
    diffOf: () => '',
  });
  assert.match(failures[0], /declares a new gap for recorded case root#abs-negative/);
});

test('a new gap for a recorded case passes with a retirement entry for the gap file', () => {
  const gaps = JSON.stringify({ 'root#abs-negative': 'Mirage rounds differently, invented reason here' });
  assert.deepEqual(
    check({
      files: [GAP, LEDGER],
      newText: byPath({ [GAP]: gaps, [LEDGER]: ledger([retirement(GAP)]) }),
      oldText: byPath({ [CASE]: caseFile(), [LEDGER]: ledger() }),
      diffOf: () => '',
    }),
    [],
  );
});

test('malformed known-gap entries are reported in file-list mode', () => {
  const failures = check({ files: [GAP], newText: () => '{"not-a-key": "reason text here", "root#x": ""}' });
  assert.match(failures.join('\n'), /not-a-key: key must be <suite>#<caseId>/);
  assert.match(failures.join('\n'), /root#x: gap reason must not be empty/);
});

test('malformed retirement entries are reported when the ledger changes', () => {
  const bad = ledger([{ file: 'a/b.test.mjs', reason: 'short', authority: 'x' }]);
  const failures = check({ files: [LEDGER], newText: () => bad, oldText: () => ledger(), diffOf: () => '' });
  assert.match(failures.join('\n'), /reason needs at least 20 characters/);
  assert.match(failures.join('\n'), /authority needs at least 10 characters/);
});

test('a retirement entry lets a deleted parity test file and removed parity lines pass', () => {
  const retired = byPath({ [LEDGER]: ledger([retirement('old.test.mjs')]) });
  assert.deepEqual(
    check({
      files: ['old.test.mjs', LEDGER],
      newText: retired,
      oldText: (file) => (file === 'old.test.mjs' ? parityFile : ledger()),
      diffOf: () => '@@ -1,9 +0,0 @@\n',
    }),
    [],
  );
  const changed = parityFile.replace("'none'", "''");
  const diff = "@@ -4 +4 @@\n-  assert.equal(value(), 'none');\n+  assert.equal(value(), '');\n";
  assert.deepEqual(
    check({
      files: ['a.test.mjs', LEDGER],
      newText: (file) => (file === LEDGER ? ledger([retirement('a.test.mjs')]) : changed),
      oldText: (file) => (file === LEDGER ? ledger() : parityFile),
      diffOf: () => diff,
    }),
    [],
  );
});

test('a retirement entry that already existed in the old ledger does not count', () => {
  const diff = "@@ -4 +4 @@\n-  assert.equal(value(), 'none');\n+  assert.equal(value(), '');\n";
  const existing = ledger([retirement('a.test.mjs')]);
  const failures = check({
    files: ['a.test.mjs', LEDGER],
    newText: (file) => (file === LEDGER ? existing : parityFile.replace("'none'", "''")),
    oldText: (file) => (file === LEDGER ? existing : parityFile),
    diffOf: () => diff,
  });
  assert.match(failures[0], /parity test/);
});

const LEGACY = 'scripts/parity-tags-legacy.json';
const LEGACY_TEST = 'mirage/test/legacy.test.mjs';
const OTHER_TEST = 'mirage/test/other.test.mjs';
const LEGACY_TAG = '// @test-kind parity: native capture reproduced twice (invented example)';
const legacyTestText = ["import test from 'node:test';", LEGACY_TAG, "test('listed', () => {});"].join('\n');
const legacyLedger = (tags) => JSON.stringify({ version: 1, tags });
const legacyProblems = (ledgerText, files = {}) =>
  check({
    files: [LEGACY],
    newText: byPath({ ...files, [LEGACY]: ledgerText }),
    oldText: () => null,
    diffOf: () => '',
  });

test('a new parity tag listed in the legacy ledger for its test file passes', () => {
  const failures = check({
    files: [LEGACY_TEST],
    newText: byPath({ [LEGACY_TEST]: legacyTestText, [LEGACY]: legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] }) }),
    oldText: () => null,
    diffOf: () => '',
  });
  assert.deepEqual(failures, []);
});

test('a listed legacy tag copied onto a second test in the same file fails', () => {
  const copied = [legacyTestText, LEGACY_TAG, "test('copied', () => {});"].join('\n');
  const failures = check({
    files: [LEGACY_TEST],
    newText: byPath({ [LEGACY_TEST]: copied, [LEGACY]: legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] }) }),
    oldText: () => null,
    diffOf: () => '',
  });
  assert.equal(failures.length, 2);
  assert.match(failures[0], /a new parity tag is only valid on a replay runner/);
});

test('a listed legacy tag text used in a file the ledger does not list fails', () => {
  const failures = check({
    files: [OTHER_TEST],
    newText: byPath({ [OTHER_TEST]: legacyTestText, [LEGACY]: legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] }) }),
    oldText: () => null,
    diffOf: () => '',
  });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /mirage\/test\/other\.test\.mjs: line 2: a new parity tag/);
});

test('a legacy ledger that gains an entry fails and one that loses an entry passes', () => {
  const both = legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG], [OTHER_TEST]: [LEGACY_TAG] });
  const one = legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] });
  const texts = { [LEGACY_TEST]: legacyTestText, [OTHER_TEST]: legacyTestText };
  const grew = check({
    files: [LEGACY],
    newText: byPath({ ...texts, [LEGACY]: both }),
    oldText: byPath({ [LEGACY]: one }),
    diffOf: () => '',
  });
  assert.equal(grew.length, 1);
  assert.match(grew[0], /only shrinks/);
  const shrank = check({
    files: [LEGACY],
    newText: byPath({ ...texts, [LEGACY]: one }),
    oldText: byPath({ [LEGACY]: both }),
    diffOf: () => '',
  });
  assert.deepEqual(shrank, []);
});

test('a legacy ledger the change introduces passes', () => {
  const failures = check({
    files: [LEGACY],
    newText: byPath({ [LEGACY_TEST]: legacyTestText, [LEGACY]: legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] }) }),
    oldText: () => null,
    diffOf: () => '',
  });
  assert.deepEqual(failures, []);
});

test('a legacy entry whose test no longer carries the tag fails as stale', () => {
  const stale = legacyProblems(legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] }), {
    [LEGACY_TEST]: "test('listed', () => {});",
  });
  assert.equal(stale.length, 1);
  assert.match(stale[0], /^scripts\/parity-tags-legacy\.json: mirage\/test\/legacy\.test\.mjs: does not carry/);
  assert.match(legacyProblems(legacyLedger({ [LEGACY_TEST]: [LEGACY_TAG] }))[0], /does not carry/);
});

test('malformed legacy ledgers fail', () => {
  const cases = [
    ['{', /not valid JSON/],
    [JSON.stringify({ version: 2, tags: {} }), /version must be 1/],
    [JSON.stringify({ version: 1, tags: [] }), /tags must be an object/],
    [legacyLedger({ [LEGACY_TEST]: ['// @test-kind unproven: local model only'] }), /is not a parity tag line/],
    [legacyLedger({ 'scripts/other.mjs': [LEGACY_TAG] }), /must be a repo-relative test file/],
    [legacyLedger({ [LEGACY_TEST]: [] }), /needs a non-empty array of tag lines/],
  ];
  for (const [ledgerText, pattern] of cases) {
    const failures = legacyProblems(ledgerText, { [LEGACY_TEST]: legacyTestText });
    assert.ok(
      failures.some((failure) => pattern.test(failure)),
      `${pattern} not reported in ${JSON.stringify(failures)}`,
    );
  }
});

test('the committed legacy ledger passes and lists the 176 parity tag lines in 79 test files', () => {
  const readRepo = (file) => {
    try {
      return fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  assert.deepEqual(check({ files: [LEGACY], newText: readRepo }), []);
  const { tags } = JSON.parse(readRepo(LEGACY));
  assert.equal(Object.keys(tags).length, 79);
  assert.equal(Object.values(tags).flat().length, 176);
});
