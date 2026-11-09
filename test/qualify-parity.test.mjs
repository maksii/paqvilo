// @test-kind tooling: Strict batch qualification checks evidence/source/case bindings and atomic source edits; invented fixtures never claim Microsoft parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';
import { kindsAt, parseTestKinds } from '../scripts/check-test-tags.mjs';
import {
  assertParityBindings,
  assertParityBindingsFromSource,
  describeParitySource,
  parityHash,
  parityAstHash,
  parityCaseBindings,
  qualifyParityManifest,
  writeParityQualification,
  writeParityPendingFindings,
} from '../scripts/qualify-parity.mjs';

const source = `// @test-kind unproven: Invented model for strict qualifier tests.
import test from 'node:test';
import assert from 'node:assert/strict';
test('example', () => {
  assert.equal(1, 1);
});
`;
const loopSource = `// @test-kind unproven: Invented generator for strict qualifier tests.
import test from 'node:test';
import assert from 'node:assert/strict';
const cases = [1, 2];
for (const value of cases) {
  test('case ' + value, () => {
    assert.ok(value > 0);
  });
}
`;
const hashJson = (value) => parityHash(JSON.stringify(value));

function fixture(t, text = source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-qualifier-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'sample.test.mjs'), text);
  const capsule = {
    captures: [
      { runSha256: '1'.repeat(64), status: 200 },
      { runSha256: '2'.repeat(64), status: 200 },
    ],
    facts: { status: 200 },
  };
  const proofFile = path.join(root, 'proof.json');
  fs.writeFileSync(proofFile, JSON.stringify(capsule));
  const model = describeParitySource(text, 'sample.test.mjs'),
    row = model.registrations[0];
  const cases = text === loopSource ? ['case 1', 'case 2'] : ['example'];
  const spec = {
    baselineId: row.id,
    titleExpressionSha256: row.titleExpressionSha256,
    assertions: row.assertions.map((item) => ({ sha256: item.sha256, factIds: ['status'] })),
    ...(text === loopSource
      ? {
          caseFacts: [
            { caseIndex: 0, assertionIndex: 0, factIds: ['status'] },
            { caseIndex: 1, assertionIndex: 0, factIds: ['status'] },
          ],
        }
      : {}),
    caseUniverse: {
      count: cases.length,
      cases,
      casesSha256: hashJson(cases),
      ...(text === loopSource ? { caseBindings: [{ value: 1 }, { value: 2 }] } : {}),
      sourceBindings:
        text === loopSource
          ? [{ name: 'cases', initializerAstSha256: model.declarations[0].initializerAstSha256 }]
          : [],
      ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
    },
  };
  const manifest = {
    version: 1,
    baseline: 'a'.repeat(40),
    files: [
      {
        path: 'sample.test.mjs',
        baselineSha256: parityHash(text),
        currentSha256: parityHash(text),
        guarantees: [
          {
            id: 'invented-transport-status',
            reason: 'Invented status guarantee used only by the qualifier tooling test.',
            context: {
              reviewedBy: 'tooling-fixture-author',
              authorResponsibility: true,
              summary: 'Invented reviewed context; this does not constitute platform evidence.',
            },
            proofs: [
              {
                path: 'proof.json',
                sha256: parityHash(fs.readFileSync(proofFile)),
                mode: 'reproduced-native',
                capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
                facts: [
                  {
                    id: 'status',
                    pointer: '/facts/status',
                    sha256: hashJson(200),
                    replicatedPointers: ['/captures/0/status', '/captures/1/status'],
                  },
                ],
              },
            ],
            tests: [spec],
          },
        ],
      },
    ],
  };
  const readBaseline = () => text;
  return {
    root,
    manifest,
    spec,
    capsule,
    proofFile,
    readBaseline,
    text,
    run: () => qualifyParityManifest(manifest, { root, readBaseline }),
    updateCurrent(value) {
      fs.writeFileSync(path.join(root, 'sample.test.mjs'), value);
      manifest.files[0].currentSha256 = parityHash(value);
    },
    updateProof(value) {
      fs.writeFileSync(proofFile, JSON.stringify(value));
      manifest.files[0].guarantees[0].proofs[0].sha256 = parityHash(fs.readFileSync(proofFile));
    },
  };
}

function loopFixture(t, text) {
  const f = fixture(t, text),
    model = describeParitySource(text, 'sample.test.mjs');
  f.spec.caseUniverse = {
    count: 2,
    cases: ['case 1', 'case 2'],
    casesSha256: hashJson(['case 1', 'case 2']),
    caseBindings: [{ value: 1 }, { value: 2 }],
    ancestorLoops: model.registrations[0].loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
    sourceBindings: [{ name: 'cases', initializerAstSha256: model.declarations[0].initializerAstSha256 }],
  };
  f.spec.caseFacts = [0, 1].map((caseIndex) => ({ caseIndex, assertionIndex: 0, factIds: ['status'] }));
  return f;
}

test('dry-run binds all originals without writing, then explicit atomic write preserves assertion code', (t) => {
  const f = fixture(t),
    report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 1);
  assert.equal(report.expandedOriginalCases, 1);
  assert.equal(report.newDefinitionsExcluded, 1);
  assert.equal(fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8'), source);
  writeParityQualification(report, { root: f.root });
  const written = fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8');
  assert.ok(written.includes('  assert.equal(1, 1);'));
  assert.match(written, /@test-kind parity:/);
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
});

test('all original assertions must have explicit known fact bindings', (t) => {
  const f = fixture(t);
  f.spec.assertions = [];
  const report = f.run();
  assert.equal(report.pending[0].reason, 'all-original-assertions-required');
  assert.equal(report.changes.length, 0);
});
test('a changed expected literal cannot be repaired by updating only the current source pin', (t) => {
  const f = fixture(t);
  f.updateCurrent(source.replace('assert.equal(1, 1)', 'assert.equal(1, 2)'));
  assert.equal(f.run().pending[0].reason, 'changed-original-assertion');
});

test('reviewed null corrections preserve the operation and optional message and require immutable old values', (t) => {
  const text = `// @test-kind unproven: invented reviewed lookup correction.
import test from 'node:test'; import assert from 'node:assert/strict';
test('example', () => { const expected = 1; assert.equal(7, expected, 'message'); });`;
  const f = fixture(t, text),
    old = describeParitySource(text, 'sample.test.mjs').registrations[0];
  const current = text.replace('assert.equal(7, expected,', 'assert.equal(7, null,');
  f.updateCurrent(current);
  const after = describeParitySource(current, 'sample.test.mjs').registrations[0];
  const value = { result: { type: 'null' } };
  f.capsule.facts.lookup = value;
  for (const capture of f.capsule.captures) capture.lookup = value;
  f.updateProof(f.capsule);
  f.manifest.files[0].guarantees[0].proofs[0].facts = [
    {
      id: 'status',
      pointer: '/facts/lookup',
      sha256: hashJson(value),
      replicatedPointers: ['/captures/0/lookup', '/captures/1/lookup'],
    },
  ];
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Exact invented lookup value is reviewed against repeated fixture facts.',
    addedTests: [],
    corrections: [
      {
        sameGuarantee: true,
        reviewedBy: 'tooling-author',
        reason: 'Only the expected value changes under repeated invented observations.',
        oldAstSha256: old.assertions[0].sha256,
        currentAstSha256: after.assertions[0].sha256,
        guaranteeId: f.manifest.files[0].guarantees[0].id,
        factIds: ['status'],
      },
    ],
  };
  assert.deepEqual(f.run().pending, []);
  f.updateCurrent(current.replace("'message'", "'changed'"));
  assert.ok(f.run().pending.length);
  f.updateCurrent(current.replace('assert.equal(7,', 'assert.equal(8,'));
  assert.ok(f.run().pending.length);
});
test('a partial generator produces a supported-region finding, never a blanket parity tag', (t) => {
  const f = fixture(t, loopSource);
  f.spec.caseUniverse.selectedCaseIndices = [0];
  const report = f.run();
  assert.equal(report.pending[0].reason, 'partial-universe-needs-region-plan');
  assert.equal(report.originalDefinitions, 0);
  assert.equal(report.changes.length, 0);
});
test('two pointers to the same recording are not two independent receipts', (t) => {
  const f = fixture(t);
  f.capsule.captures[1].runSha256 = f.capsule.captures[0].runSha256;
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'independent-receipts-required');
});
test('distinct response hashes are not independent run/process receipts', (t) => {
  const f = fixture(t);
  f.updateProof({ bodySha256: '1'.repeat(64), responseSha256: '2'.repeat(64), facts: { status: 200 } });
  f.manifest.files[0].guarantees[0].proofs[0].capturePointers = ['/bodySha256', '/responseSha256'];
  assert.equal(f.run().pending[0].reason, 'response-hash-is-not-run-receipt');
});
test('stale file and proof bytes fail closed without source edits', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, 'sample.test.mjs'), '// new edit\n');
  assert.equal(f.run().pending[0].reason, 'stale-current-sha');
  f.updateCurrent(source);
  fs.appendFileSync(f.proofFile, ' ');
  assert.equal(f.run().pending[0].reason, 'stale-proof-sha');
});
test('updating capsule checksum without requalifying its selected fact fails', (t) => {
  const f = fixture(t);
  f.capsule.facts.status = 201;
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'changed-proof-fact');
});
test('duplicate title expressions are ambiguous rather than guessed by proximity', (t) => {
  const f = fixture(t);
  f.updateCurrent(source + "test('example', () => { assert.equal(1, 1); });\n");
  assert.equal(f.run().pending[0].reason, 'ambiguous-registration');
});
test('case initializer edits are rejected even when the original assertion remains identical', (t) => {
  const f = fixture(t, loopSource);
  f.updateCurrent(loopSource.replace('[1, 2]', '[1]'));
  assert.equal(f.run().pending[0].reason, 'changed-source-binding');
});
test('shared guard catches an empty/shortened generator outside an unexecuted callback', (t) => {
  const f = fixture(t, loopSource),
    report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  const written = fs
    .readFileSync(file, 'utf8')
    .replace('for (const value of cases) {', 'for (const value of cases) { if (true) continue;');
  fs.writeFileSync(file, written);
  assert.throws(() => assertParityBindings(pathToFileURL(file), report.changes[0].bindings), /changed-loop-header/);
});
test('source guard accepts a bound doesNotThrow wrapper and rejects forged wrappers', (t) => {
  const f = fixture(t),
    report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  const wrapped = fs.readFileSync(file, 'utf8');
  const direct = wrapped.replace(
    'assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));',
    '__paqParitySourceBindings(import.meta.url);',
  );
  assert.notEqual(wrapped, direct);
  fs.writeFileSync(file, direct);
  assertParityBindingsFromSource(pathToFileURL(file));
  f.updateCurrent(wrapped);
  assertParityBindingsFromSource(pathToFileURL(file));
  assert.deepEqual(f.run().pending, []);
  for (const altered of [
    wrapped.replace(
      'assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));',
      'assert.doesNotThrow(() => {});',
    ),
    wrapped.replace(
      'assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));',
      'assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url), "extra");',
    ),
    wrapped.replace(
      'assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));',
      'assert.doesNotThrow(() => { __paqParitySourceBindings(import.meta.url); process.exitCode = 1; });',
    ),
    wrapped.replace("import assert from 'node:assert/strict';", "import assert from './fake-assert.mjs';"),
    wrapped.replace(
      'assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));',
      'const assert = { doesNotThrow() {} }; assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));',
    ),
  ]) {
    fs.writeFileSync(file, altered);
    assert.throws(() => assertParityBindingsFromSource(pathToFileURL(file)));
  }
});
test('existing security kind survives promotion and all source checks finish before write', (t) => {
  const securitySource = source.replace('@test-kind unproven:', '@test-kind security:');
  const f = fixture(t, securitySource),
    report = f.run();
  assert.match(report.changes[0].after, /@test-kind parity\+security:/);
  fs.appendFileSync(path.join(f.root, 'sample.test.mjs'), '// concurrent author edit\n');
  assert.throws(() => writeParityQualification(report, { root: f.root }), /source-changed-before-write/);
  assert.ok(fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8').endsWith('// concurrent author edit\n'));
});
test('failed multi-file writes preserve a concurrent replacement and report published paths', (t) => {
  const f = fixture(t),
    first = path.join(f.root, 'first.txt'),
    second = path.join(f.root, 'second.txt');
  fs.writeFileSync(first, 'first before');
  fs.writeFileSync(second, 'second before');
  const report = {
    pending: [],
    changes: [
      { path: 'first.txt', before: 'first before', after: 'first after' },
      { path: 'second.txt', before: 'second before', after: 'second after' },
    ],
  };
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === second) {
      fs.writeFileSync(first, 'concurrent author');
      throw new Error('injected write failure');
    }
    return rename(from, to);
  };
  try {
    assert.throws(
      () => writeParityQualification(report, { root: f.root }),
      (error) => {
        assert.match(error.message, /injected write failure/);
        assert.deepEqual(error.qualificationPublishedPaths, ['first.txt']);
        return true;
      },
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(fs.readFileSync(first, 'utf8'), 'concurrent author');
  assert.equal(fs.readFileSync(second, 'utf8'), 'second before');
});
test('pending finding exclusive creation preserves a competing writer', (t) => {
  const f = fixture(t),
    directory = path.join(f.root, 'pending'),
    destination = path.join(directory, 'finding.json');
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, data, options) => {
    if (file === destination && options?.flag === 'wx') write(file, 'concurrent finding');
    return write(file, data, options);
  };
  let conflicts;
  try {
    conflicts = writeParityPendingFindings({ pending: [{ id: 'finding' }] }, directory);
  } finally {
    fs.writeFileSync = write;
  }
  assert.equal(conflicts[0].reason, 'existing-finding-differs-preserved');
  assert.equal(fs.readFileSync(destination, 'utf8'), 'concurrent finding');
});
test('retained universe assertion binds the literal tuples and remains runtime protected', (t) => {
  const text = `// @test-kind unproven: Invented tuple fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
const cases = [['first', 1], ['second', 2]];
for (const [name, value] of cases) {
  test(name, () => { assert.equal(value, value); });
}
for (const other of [true, false]) {
  test('sibling ' + other, () => { assert.ok(other === true || other === false); });
}
`;
  const f = fixture(t, text),
    rows = [
      ['first', 1],
      ['second', 2],
    ],
    statement = `assert.equal(createHash('sha256').update(JSON.stringify(cases)).digest('hex'), '${parityHash(JSON.stringify(rows))}');`,
    current = text
      .replace(
        "import test from 'node:test';",
        "import test from 'node:test';\nimport { createHash } from 'node:crypto';",
      )
      .replace('assert.equal(value, value);', statement + ' assert.equal(value, value);'),
    model = describeParitySource(text, 'sample.test.mjs'),
    row = model.registrations[0],
    currentRow = describeParitySource(current, 'sample.test.mjs').registrations[0];
  f.spec.caseUniverse = {
    count: 2,
    cases: ['first', 'second'],
    casesSha256: hashJson(['first', 'second']),
    caseBindings: [
      { name: 'first', value: 1 },
      { name: 'second', value: 2 },
    ],
    sourceBindings: [
      {
        name: 'cases',
        ownerTitle: null,
        initializerAstSha256: model.declarations.find((item) => item.name === 'cases').initializerAstSha256,
      },
    ],
    ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
  };
  f.spec.caseFacts = [0, 1].map((caseIndex) => ({ caseIndex, assertionIndex: 0, factIds: ['status'] }));
  f.spec.retainedUniverseAssertions = [currentRow.assertions[0].sha256];
  f.updateCurrent(current);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    generated = fs.readFileSync(file, 'utf8');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  fs.writeFileSync(file, generated.replace(statement, ''));
  assert.throws(() => assertParityBindings(pathToFileURL(file), report.changes[0].bindings));
});
test('legacy scalar witness binds each original receipt, input, body and fact independently', (t) => {
  const f = fixture(t),
    guarantee = f.manifest.files[0].guarantees[0];
  const cause = 'invented Boolean error',
    body = 'a'.repeat(64);
  const original = {
    captures: [{ runSha256: '1'.repeat(64) }, { runSha256: '2'.repeat(64) }],
    cases: [
      {
        id: 'case',
        field: 'enabled',
        token: '""',
        encoding: 'plain',
        method: 'POST',
        cause,
        nativeBodySha256: [body, body],
      },
    ],
  };
  f.updateProof(original);
  const proof = guarantee.proofs[0];
  proof.facts = [
    {
      id: 'status',
      pointer: '/cases/0/cause',
      sha256: hashJson(cause),
      equalBodyHashesPointer: '/cases/0/nativeBodySha256',
    },
  ];
  const row = {
    id: 'case',
    sourceDirective: { originalCaseIndex: 0, field: 'enabled', token: '""', encoding: 'plain', method: 'POST' },
    nativeType: 'Edm.Boolean',
    responseBodySha256: body,
    facts: { cause },
  };
  const supplement = {
    schemaVersion: 2,
    source: { existingFixtureSha256: proof.sha256 },
    captures: original.captures.map((capture) => ({ ...capture, cases: [structuredClone(row)] })),
  };
  const witnessPath = path.join(f.root, 'supplement.json');
  const update = () => {
    fs.writeFileSync(witnessPath, JSON.stringify(supplement));
    guarantee.supplementalWitness = {
      path: 'supplement.json',
      sha256: parityHash(fs.readFileSync(witnessPath)),
      legacyProofSha256: proof.sha256,
      factId: 'status',
    };
  };
  update();
  const report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    moduleUrl = pathToFileURL(file),
    generated = fs.readFileSync(file);
  assertParityBindings(moduleUrl, report.changes[0].bindings);
  fs.writeFileSync(file, source);
  for (const mutate of [
    (capture) => {
      capture.runSha256 = '3'.repeat(64);
    },
    (capture) => {
      capture.cases[0].sourceDirective.token = 'true';
    },
    (capture) => {
      capture.cases[0].responseBodySha256 = 'b'.repeat(64);
    },
    (capture) => {
      capture.cases[0].facts.cause = 'different';
    },
  ]) {
    const before = structuredClone(supplement.captures[1]);
    mutate(supplement.captures[1]);
    update();
    fs.writeFileSync(file, generated);
    assert.throws(() => assertParityBindings(moduleUrl, report.changes[0].bindings), /stale-supplemental-witness/);
    fs.writeFileSync(file, source);
    assert.equal(f.run().pending[0].reason, 'invalid-supplemental-witness');
    supplement.captures[1] = before;
  }
});
test('missing semantic review or incomplete assertion facts never earn closure', (t) => {
  const f = fixture(t);
  delete f.manifest.files[0].guarantees[0].context.authorResponsibility;
  assert.equal(f.run().pending[0].reason, 'reviewed-semantic-context-required');
  f.manifest.files[0].guarantees[0].context.authorResponsibility = true;
  f.spec.assertions[0].factIds = ['not-proven'];
  assert.equal(f.run().pending[0].reason, 'assertion-fact-binding-required');
});

test('nested package.json cannot redirect root-relative proof resolution', (t) => {
  const f = fixture(t),
    nested = path.join(f.root, 'nested');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'package.json'), '{"type":"module"}');
  fs.renameSync(path.join(f.root, 'sample.test.mjs'), path.join(nested, 'sample.test.mjs'));
  f.manifest.files[0].path = 'nested/sample.test.mjs';
  f.spec.baselineId = f.spec.baselineId.replace('sample.test.mjs:', 'nested/sample.test.mjs:');
  const report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  assert.equal(report.changes[0].bindings[0].repositoryRoot, '..');
  assertParityBindingsFromSource(pathToFileURL(path.join(nested, 'sample.test.mjs')));
});
test('a second explicitly repinned run is idempotent and adds no duplicate source guards', (t) => {
  const f = fixture(t),
    first = f.run();
  writeParityQualification(first, { root: f.root });
  const written = fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8');
  f.updateCurrent(written);
  const second = f.run();
  assert.deepEqual(second.pending, []);
  assert.equal(second.changes.length, 0);
  assert.equal(second.newDefinitionsExcluded, 0);
});
test('a SHA-looking guard containing a side effect is never stripped as proof boilerplate', (t) => {
  const f = fixture(t);
  f.updateCurrent(
    source.replace(
      '  assert.equal(1, 1);',
      `  assert.equal(createHash('sha256').update((mutateInputs(), data)).digest('hex'), '${'a'.repeat(64)}');\n  assert.equal(1, 1);`,
    ),
  );
  assert.equal(f.run().pending[0].reason, 'unmapped-current-assertion');
});
test('a same-named project hash/read helper is not mistaken for reviewed Node proof boilerplate', (t) => {
  const f = fixture(t);
  f.updateCurrent(source + 'function createHash() { mutateInputs(); }\n');
  f.updateCurrent(
    fs
      .readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8')
      .replace(
        '  assert.equal(1, 1);',
        `  assert.equal(createHash('sha256').update(JSON.stringify(cases)).digest('hex'), '${'a'.repeat(64)}');\n  assert.equal(1, 1);`,
      ),
  );
  assert.equal(f.run().pending[0].reason, 'unmapped-current-assertion');
});
test('named and default node:assert aliases are recognized rather than silently treated as zero assertions', (t) => {
  const aliased = source
    .replace("import assert from 'node:assert/strict';", "import { equal as same } from 'node:assert/strict';")
    .replace('assert.equal(1, 1)', 'same(1, 1)');
  const f = fixture(t, aliased);
  assert.equal(f.spec.assertions.length, 1);
  assert.deepEqual(f.run().pending, []);
  const defaultAlias = source.replace('import assert from', 'import check from').replace('assert.equal', 'check.equal');
  assert.equal(describeParitySource(defaultAlias).registrations[0].assertions.length, 1);
});
test('zero recognized assertions produce pending instead of a false whole-test promotion', (t) => {
  const f = fixture(t, source.replace('  assert.equal(1, 1);', '  inspectSomeHelper();'));
  assert.equal(f.run().pending[0].reason, 'recognized-original-assertions-required');
});
test('awaited nested subtests receive comments before the statement and retain effective parity kind', (t) => {
  const nested = source.replace(
    "test('example', () => {\n  assert.equal(1, 1);\n});",
    "test('parent', async (t) => {\n  await t.test('example', () => { assert.equal(1, 1); });\n});",
  );
  const f = fixture(t, nested),
    child = describeParitySource(nested, 'sample.test.mjs').registrations.find((row) => row.title === 'example');
  f.spec.baselineId = child.id;
  f.spec.titleExpressionSha256 = child.titleExpressionSha256;
  f.spec.assertions = child.assertions.map((item) => ({ sha256: item.sha256, factIds: ['status'] }));
  const report = f.run();
  assert.deepEqual(report.pending, []);
  const after = describeParitySource(report.changes[0].after, 'sample.test.mjs');
  assert.ok(after.registrations.find((row) => row.title === 'example').kinds.includes('parity'));
  assert.ok(report.changes[0].after.includes('await t.test('));
});
test('return registrations fail closed without inserting a comment after return', (t) => {
  const returned = source
    .replace("test('example', () => {", "function register() { return test('example', () => {")
    .replace('});\n', '}); }\n');
  const f = fixture(t, returned),
    report = f.run();
  assert.equal(report.pending[0].reason, 'unsupported-registration-execution');
  assert.equal(report.changes.length, 0);
});
test('second-run outcome divergence fails even when receipt hashes are distinct and first-run fact remains unchanged', (t) => {
  const f = fixture(t);
  f.capsule.captures[1].status = 500;
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'unreproduced-proof-fact');
});
test('official package metadata must be exactly bound to the executed receipt capsule', (t) => {
  const f = fixture(t),
    proof = f.manifest.files[0].guarantees[0].proofs[0];
  proof.mode = 'official-package';
  proof.package = {
    id: 'Microsoft.Invented.ToolingFixture',
    version: '1.0',
    sha256: '3'.repeat(64),
    source: 'https://api.nuget.org/v3/invented',
  };
  proof.packagePointer = '/package';
  f.capsule.package = { ...proof.package, version: 'different' };
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'official-package-not-bound-to-receipt');
});
test('one family failing in two files retains the union of original IDs and evidence', (t) => {
  const f = fixture(t),
    second = structuredClone(f.manifest.files[0]);
  second.path = 'other.test.mjs';
  second.guarantees[0].tests[0].baselineId = second.guarantees[0].tests[0].baselineId.replace(
    'sample.test.mjs:',
    'other.test.mjs:',
  );
  fs.writeFileSync(path.join(f.root, second.path), source);
  f.manifest.files.push(second);
  f.capsule.facts.status = 201;
  f.updateProof(f.capsule);
  second.guarantees[0].proofs[0].sha256 = f.manifest.files[0].guarantees[0].proofs[0].sha256;
  const report = f.run();
  assert.equal(report.pending.length, 1);
  assert.deepEqual(report.pending[0].files, ['other.test.mjs', 'sample.test.mjs']);
  assert.equal(report.pending[0].testIds.length, 2);
});
test('file-level stale pins retain every requested original ID and pending-note conflicts are explicit', (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.root, 'sample.test.mjs'), '// concurrent\n');
  const report = f.run();
  assert.deepEqual(report.pending[0].testIds, [f.spec.baselineId]);
  const directory = path.join(f.root, 'pending');
  assert.deepEqual(writeParityPendingFindings(report, directory), []);
  const destination = path.join(directory, report.pending[0].id + '.json');
  fs.appendFileSync(destination, '\nROOT notes must stay\n');
  const existing = fs.readFileSync(destination);
  const conflicts = writeParityPendingFindings(report, directory);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].reason, 'existing-finding-differs-preserved');
  assert.deepEqual(fs.readFileSync(destination), existing);
});
test('a reviewed count cannot omit one literal generator case', (t) => {
  const f = fixture(t, loopSource);
  f.spec.caseUniverse.cases = ['case 1'];
  f.spec.caseUniverse.count = 1;
  f.spec.caseUniverse.casesSha256 = hashJson(f.spec.caseUniverse.cases);
  assert.equal(f.run().pending[0].reason, 'declared-case-count-mismatch');
});
test('explicit zero-tag fallback preserves unselected originals as unproven without closure credit', (t) => {
  const untagged =
    source.replace(/^\/\/ @test-kind[^\n]*\n/u, '') + "test('unselected', () => { assert.equal(2, 2); });\n";
  const f = fixture(t, untagged),
    file = f.manifest.files[0];
  const unselected = describeParitySource(untagged, 'sample.test.mjs').registrations.find(
    (row) => row.title === 'unselected',
  );
  file.fallbackKind = 'unproven';
  file.fallbackReason =
    'Explicitly reviewed legacy models remain unproven; only selected originals have reproduced proof.';
  file.fallbackUnselectedBaselineIds = [unselected.id];
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 1);
  assert.equal(report.expandedOriginalCases, 1);
  const parsed = describeParitySource(report.changes[0].after);
  assert.deepEqual(parsed.registrations.find((row) => row.title === 'unselected').kinds, ['unproven']);
  assert.ok(parsed.registrations.find((row) => row.title === 'example').kinds.includes('parity'));
});
test('fallback cannot replace existing security/parity/malformed declarations or omit an unselected ID', (t) => {
  const f = fixture(t),
    file = f.manifest.files[0];
  file.fallbackKind = 'unproven';
  file.fallbackReason = 'Explicitly reviewed fallback for originally untagged source only.';
  file.fallbackUnselectedBaselineIds = [];
  assert.equal(f.run().pending[0].reason, 'fallback-would-change-existing-kind');
  const untagged =
    source.replace(/^\/\/ @test-kind[^\n]*\n/u, '') + "test('unselected', () => { assert.equal(2, 2); });\n";
  const g = fixture(t, untagged);
  Object.assign(g.manifest.files[0], {
    fallbackKind: 'unproven',
    fallbackReason: file.fallbackReason,
    fallbackUnselectedBaselineIds: [],
  });
  assert.equal(g.run().pending[0].reason, 'unselected-baseline-ids-do-not-match');
});
test('real repository formatting preserves strict generated literal guard behavior', async (t) => {
  const f = fixture(t, loopSource),
    report = f.run();
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  const formatted = await format(fs.readFileSync(file, 'utf8'), {
    parser: 'babel',
    singleQuote: true,
    trailingComma: 'all',
  });
  assert.ok(formatted.includes('baselineId:'));
  fs.writeFileSync(file, formatted);
  assertParityBindingsFromSource(pathToFileURL(file));
});

function partial(f, indices) {
  const assertions = f.spec.assertions;
  delete f.spec.assertions;
  f.spec.regions = indices.map((group) => ({ assertions: group.map((index) => assertions[index]) }));
  return f;
}

test('late TypeScript harness imports cannot escape into a selected SDK test', (t) => {
  const text = `// @test-kind unproven: invented late tooling harness fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('example', () => { assert.equal(1, 1); });
test('SDK declaration accepts a strict TypeScript consumer with a partial client', () => {
  const filename = fileURLToPath(new URL('./input', import.meta.url));
  execFileSync(process.execPath, [filename]);
});
`;
  const f = partial(fixture(t, text), [[0]]),
    file = f.manifest.files[0];
  file.path = 'mirage/test/code-apps-sdk.test.mjs';
  const target = path.join(f.root, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  const baseline = describeParitySource(text, file.path);
  f.spec.baselineId = baseline.registrations[0].id;
  f.spec.titleExpressionSha256 = baseline.registrations[0].titleExpressionSha256;
  assert.deepEqual(f.run().pending, []);
  for (const changed of [
    text.replace('assert.equal(1, 1);', 'execFileSync(process.execPath, []); assert.equal(1, 1);'),
    text.replace(
      'execFileSync(process.execPath, [filename]);',
      'const launch = execFileSync; launch(process.execPath, [filename]);',
    ),
    text.replace("test('example', () => { assert.equal(1, 1); });\n", '') +
      "\ntest('example', () => { assert.equal(1, 1); });\n",
  ]) {
    fs.writeFileSync(target, changed);
    file.currentSha256 = parityHash(changed);
    assert.ok(f.run().pending.length);
  }
});

function threeCasePartial(t, text) {
  const f = partial(fixture(t, text), [[0]]),
    model = describeParitySource(text, 'sample.test.mjs'),
    row = model.registrations[0],
    cases = ['case 1', 'case 2', 'case 3'];
  f.spec.caseUniverse = {
    count: 3,
    cases,
    casesSha256: hashJson(cases),
    caseBindings: [{ value: 1 }, { value: 2 }, { value: 3 }],
    sourceBindings: [{ name: 'cases', initializerAstSha256: model.declarations[0].initializerAstSha256 }],
    ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
  };
  f.spec.caseSelection = { selected: [0, 2].map((caseIndex) => ({ caseIndex, factIds: ['status'] })) };
  return { f, cases };
}

test('case regions bind matched cases while every original case executes in order', async (t) => {
  const text = loopSource
    .replace('[1, 2]', '[\n  1, // first\n  2, // unmatched\n  3, // third\n]')
    .replace(
      "  test('case ' + value, () => {\n    assert.ok(value > 0);\n  });",
      "  test('case ' + value, () => assert.ok(value > 0));",
    );
  const { f } = threeCasePartial(t, text);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 0);
  assert.equal(report.expandedOriginalCases, 0);
  assert.equal(report.qualifiedOriginalCases, 2);
  const selection = structuredClone(f.spec.caseSelection);
  for (const indices of [[0, 0], [2, 0], [0, 3], []]) {
    f.spec.caseSelection.selected = indices.map((caseIndex) => ({ caseIndex, factIds: ['status'] }));
    assert.equal(f.run().pending[0].reason, 'invalid-case-parity-selection');
  }
  f.spec.caseSelection = selection;
  f.updateCurrent(text.replace('() => assert.ok', 'async () => assert.ok'));
  assert.ok(f.run().pending.length);
  f.updateCurrent(text);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    formatted = await format(fs.readFileSync(file, 'utf8'), { parser: 'babel', singleQuote: true });
  fs.writeFileSync(file, formatted);
  const tags = parseTestKinds(formatted),
    lines = formatted.split(/\r?\n/u),
    lineOf = (fragment) => lines.findIndex((line) => line.includes(fragment)) + 1;
  assert.deepEqual(kindsAt(tags, lineOf('1, // first')), ['parity']);
  assert.deepEqual(kindsAt(tags, lineOf('2, // unmatched')), ['unproven']);
  assert.deepEqual(kindsAt(tags, lineOf('3, // third')), ['parity']);
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  const { spawnSync } = await import('node:child_process');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const execution = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], {
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.ok(execution.stdout.indexOf('case 1') < execution.stdout.indexOf('case 2'), execution.stdout);
  assert.ok(execution.stdout.indexOf('case 2') < execution.stdout.indexOf('case 3'));
  const descriptor = report.changes[0].bindings;
  assert.equal(parityCaseBindings(pathToFileURL(file), [1, 2, 3], [0, 2], { value: 2 }, descriptor), false);
  assert.throws(
    () => parityCaseBindings(pathToFileURL(file), [1, 2, 3], [0, 2], { value: 4 }, descriptor),
    /unknown-case-parity-binding/,
  );
  const parsed = describeParitySource(formatted),
    callback = parsed.registrations[0].callback,
    marker = callback.body.body[0];
  const alter = (start, end, value) => formatted.slice(0, start) + value + formatted.slice(end);
  for (const changed of [
    formatted.replace('value: 1', 'value: 9'),
    formatted.replace('2, // unmatched', '4, // unmatched'),
    formatted.replace('const cases = [', 'const unrelatedSetup = 1;\nconst cases = ['),
    alter(...marker.range, ''),
    formatted.replace('parityCaseBindings as __paqParityCaseBindings', 'parityAssertions as __paqParityCaseBindings'),
    formatted.replace('@test-kind unproven:', '@test-kind parity:'),
    alter(callback.range[0], callback.range[0], 'async '),
  ]) {
    assert.notEqual(changed, formatted);
    fs.writeFileSync(file, changed);
    assert.throws(() => assertParityBindings(pathToFileURL(file), descriptor));
  }
  f.updateCurrent(formatted);
  const secondProof = structuredClone(f.manifest.files[0].guarantees[0].proofs[0]);
  secondProof.path = 'proof-second.json';
  secondProof.facts[0].id = 'second-status';
  fs.copyFileSync(f.proofFile, path.join(f.root, secondProof.path));
  f.manifest.files[0].guarantees[0].proofs.push(secondProof);
  f.spec.caseSelection.selected = [
    { caseIndex: 0, factIds: ['status'] },
    { caseIndex: 1, factIds: ['second-status'] },
    { caseIndex: 2, factIds: ['status'] },
  ];
  const cumulative = f.run();
  assert.deepEqual(cumulative.pending, []);
  assert.equal(cumulative.qualifiedOriginalCases, 3);
  assert.equal(cumulative.newQualifiedOriginalCases, 1);
  writeParityQualification(cumulative, { root: f.root });
  const cumulativeSource = fs.readFileSync(file, 'utf8');
  f.updateCurrent(cumulativeSource);
  const repeated = f.run();
  assert.deepEqual(repeated.pending, []);
  assert.equal(repeated.changes.length, 0);
  assert.equal(repeated.newQualifiedOriginalCases, 0);
  f.updateCurrent(cumulativeSource.replace('2, // unmatched', '1, // unmatched'));
  assert.ok(f.run().pending.length);
  f.updateCurrent(cumulativeSource);
  const thirdProof = structuredClone(secondProof);
  thirdProof.path = 'proof-third.json';
  thirdProof.facts[0].id = 'third-status';
  fs.copyFileSync(f.proofFile, path.join(f.root, thirdProof.path));
  f.manifest.files[0].guarantees[0].proofs.push(thirdProof);
  const proofExtension = f.run();
  assert.deepEqual(proofExtension.pending, []);
  assert.equal(proofExtension.newQualifiedOriginalCases, 0);
  writeParityQualification(proofExtension, { root: f.root });
  f.updateCurrent(fs.readFileSync(file, 'utf8'));
  f.manifest.files[0].guarantees[0].proofs.pop();
  assert.equal(f.run().pending[0].reason, 'existing-case-proof-omitted');
  f.manifest.files[0].guarantees[0].proofs.push(thirdProof);
  f.spec.caseSelection.selected = f.spec.caseSelection.selected.slice(0, 2);
  assert.equal(f.run().pending[0].reason, 'existing-case-fact-mapping-omitted');
  f.spec.caseSelection.selected = [
    { caseIndex: 0, factIds: ['second-status'] },
    { caseIndex: 1, factIds: ['second-status'] },
    { caseIndex: 2, factIds: ['status'] },
  ];
  assert.equal(f.run().pending[0].reason, 'existing-case-fact-mapping-omitted');
  f.spec.caseSelection.selected[0].factIds = ['status'];
  f.manifest.files[0].guarantees[0].proofs.pop();
  f.manifest.files[0].guarantees[0].proofs.pop();
  assert.ok(f.run().pending.length);
});

test('case guard coexists with a previously qualified whole test', (t) => {
  const text =
    source +
    `
const cases = [
  1, // first case
  2, // unmatched case
  3, // third case
];
for (const value of cases) test('case ' + value, () => assert.ok(value > 0));
`;
  const f = fixture(t, text),
    baseline = describeParitySource(text, 'sample.test.mjs');
  const whole = f.run();
  assert.deepEqual(whole.pending, []);
  writeParityQualification(whole, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  f.updateCurrent(fs.readFileSync(file, 'utf8'));
  const row = baseline.registrations.find((item) => item.loops.length),
    cases = ['case 1', 'case 2', 'case 3'];
  f.manifest.files[0].guarantees[0].tests = [
    {
      baselineId: row.id,
      titleExpressionSha256: row.titleExpressionSha256,
      caseUniverse: {
        count: 3,
        cases,
        casesSha256: hashJson(cases),
        caseBindings: [{ value: 1 }, { value: 2 }, { value: 3 }],
        sourceBindings: [
          {
            name: 'cases',
            initializerAstSha256: baseline.declarations.find((item) => item.name === 'cases').initializerAstSha256,
          },
        ],
        ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
      },
      caseSelection: { selected: [0, 2].map((caseIndex) => ({ caseIndex, factIds: ['status'] })) },
      regions: [{ assertions: [{ sha256: row.assertions[0].sha256, factIds: ['status'] }] }],
    },
  ];
  const partialReport = f.run();
  assert.deepEqual(partialReport.pending, []);
  writeParityQualification(partialReport, { root: f.root });
  assertParityBindings(pathToFileURL(file), partialReport.changes[0].bindings);
  assertParityBindingsFromSource(pathToFileURL(file));
  f.updateCurrent(fs.readFileSync(file, 'utf8'));
  const repeated = f.run();
  assert.deepEqual(repeated.pending, []);
  assert.equal(repeated.changes.length, 0);
  f.manifest.files[0].guarantees[0].tests = [f.spec];
  const preserveCase = f.run();
  assert.deepEqual(preserveCase.pending, []);
  assert.equal(preserveCase.changes.length, 0);
});

test('partial regions preserve sync and awaited assertions, parent kinds, and proof checks after formatting', async (t) => {
  const text = source.replace(
    "test('example', () => {\n  assert.equal(1, 1);",
    "test('example', async () => {\n  assert.equal(1, 1);\n  assert.equal(await Promise.resolve(2), 2);\n  assert.equal(3, 3);",
  );
  const f = partial(fixture(t, text), [[0, 1]]);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 0);
  assert.equal(report.newDefinitionsExcluded, 0);
  assert.equal(report.files[0].partialRegions, 1);
  const formatted = await format(report.changes[0].after, { parser: 'babel', singleQuote: true });
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), formatted);
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
  const formattedModel = describeParitySource(formatted);
  assert.ok(formatted.split('\n').length > 40, 'real formatting expands the generated descriptor past the tag limit');
  assert.match(formatted.split('\n')[0], /^\/\/ @test-kind unproven:/);
  assert.deepEqual(formattedModel.tags.errors, []);
  assert.equal(formattedModel.registrations[0].kinds[0], 'unproven');
  assert.match(formatted, /assert\.equal\(await Promise\.resolve\(2\), 2\)/);
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), formatted.replace('Promise.resolve(2)', 'Promise.resolve(4)'));
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings),
    /changed-original-body|changed-module-context/,
  );
});

test('partial generator binds the complete case source even when its body never executes', (t) => {
  const f = partial(fixture(t, loopSource), [[0]]);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('const cases = [1, 2]', 'const cases = []'));
  assert.throws(() => assertParityBindings(pathToFileURL(file), report.changes[0].bindings), /changed-source-binding/);
});

test('partial regions reject noncontiguous, unsafe closures, missing facts, and stale evidence', (t) => {
  const text = source.replace('  assert.equal(1, 1);', '  assert.equal(1, 1);\n  sideEffect();\n  assert.equal(2, 2);');
  const f = partial(fixture(t, text), [[0, 1]]);
  assert.equal(f.run().pending[0].reason, 'missing-contiguous-region');
  const closure = source.replace('assert.equal(1, 1)', 'assert.throws(() => assert.equal(1, 2))');
  const g = partial(fixture(t, closure), [[0]]);
  assert.equal(g.run().pending[0].reason, 'nested-assertion-region-unsupported');
  const h = partial(fixture(t), [[0]]);
  h.spec.regions[0].assertions[0].factIds = ['missing'];
  assert.equal(h.run().pending[0].reason, 'assertion-fact-binding-required');
  h.spec.regions[0].assertions[0].factIds = ['status'];
  fs.appendFileSync(h.proofFile, ' ');
  assert.equal(h.run().pending[0].reason, 'stale-proof-sha');
});

test('generated partial code executes with await ordering and rejects removed region guards', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const text = source.replace(
    "test('example', () => {\n  assert.equal(1, 1);",
    `test('example', async () => {
  const events = [];
  queueMicrotask(() => events.push('before'));
  assert.equal(await Promise.resolve(1), 1);
  events.push('after');
  assert.deepEqual(events, ['before', 'after']);`,
  );
  const f = partial(fixture(t, text), [[0]]);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  const execution = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  const changed = fs.readFileSync(file, 'utf8').replace(/__paqParityAssertions\(import\.meta\.url, .*\);\n/, '');
  fs.writeFileSync(file, changed);
  assert.throws(
    () => assertParityBindings(pathToFileURL(file), report.changes[0].bindings),
    /changed-original-body|changed-region-set/,
  );
});

test('partial regions coexist with a previously generated whole-test import', (t) => {
  const text = source.replace('});', "});\ntest('second', () => {\n  assert.equal(2, 2);\n});");
  const f = fixture(t, text);
  const whole = f.run();
  assert.deepEqual(whole.pending, []);
  f.updateCurrent(whole.changes[0].after);
  const old = describeParitySource(text, 'sample.test.mjs').registrations[1];
  f.spec.baselineId = old.id;
  f.spec.titleExpressionSha256 = old.titleExpressionSha256;
  f.spec.caseUniverse.cases = ['second'];
  f.spec.caseUniverse.casesSha256 = hashJson(f.spec.caseUniverse.cases);
  f.spec.assertions = old.assertions.map((item) => ({ sha256: item.sha256, factIds: ['status'] }));
  partial(f, [[0]]);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), report.changes[0].after);
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
});

test('official npm provenance requires exact registry, namespace, integrity and receipt-bound source closure', (t) => {
  const f = fixture(t),
    proof = f.manifest.files[0].guarantees[0].proofs[0];
  proof.mode = 'official-package';
  proof.packagePointer = '/package';
  const original = {
    ecosystem: 'npm',
    id: '@microsoft/invented-fixture',
    version: '1.2.3',
    source: 'https://registry.npmjs.org/@microsoft/invented-fixture/-/invented-fixture-1.2.3.tgz',
    sha256: '3'.repeat(64),
    integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
    executedSourceClosure: [{ path: 'dist/main.js', sha256: '4'.repeat(64) }],
  };
  const run = (pkg, receipt = pkg) => {
    proof.package = structuredClone(pkg);
    f.capsule.package = structuredClone(receipt);
    f.updateProof(f.capsule);
    return f.run();
  };
  assert.deepEqual(run(original).pending, []);
  const prerelease = {
    ...original,
    version: '1.2.3-rc.1-x',
    source: original.source.replace('1.2.3.tgz', '1.2.3-rc.1-x.tgz'),
  };
  assert.deepEqual(run(prerelease).pending, []);
  for (const changed of [
    { ...original, id: '@evil/invented-fixture' },
    { ...original, source: original.source.replace('registry.npmjs.org', 'registry.npmjs.org.attacker.invalid') },
    { ...original, source: original.source.replace('https://', 'http://') },
    { ...original, integrity: 'sha512-AAAA' },
    { ...original, integrity: 'sha256-' + Buffer.alloc(64, 1).toString('base64') },
    { ...original, version: 'latest' },
    { ...original, version: '1.02.3', source: original.source.replace('1.2.3.tgz', '1.02.3.tgz') },
    { ...original, executedSourceClosure: [] },
    { ...original, executedSourceClosure: [{ path: '../main.js', sha256: '4'.repeat(64) }] },
    { ...original, executedSourceClosure: [{ path: 'dist/main.js', sha256: 'oops' }] },
    { ...original, executedSourceClosure: [original.executedSourceClosure[0], original.executedSourceClosure[0]] },
  ])
    assert.equal(run(changed).pending[0].reason, 'official-package-provenance-required');
  const changedClosure = { ...original, executedSourceClosure: [{ path: 'dist/main.js', sha256: '5'.repeat(64) }] };
  assert.equal(run(changedClosure, original).pending[0].reason, 'official-package-not-bound-to-receipt');
  assert.equal(
    run({ ...original, sha256: '6'.repeat(64) }, original).pending[0].reason,
    'official-package-not-bound-to-receipt',
  );
});

test('proof needs distinct capture roots and direct fact replicas', (t) => {
  const f = fixture(t),
    proof = f.manifest.files[0].guarantees[0].proofs[0];
  f.capsule.captures[0].secondRunSha256 = '2'.repeat(64);
  f.capsule.captures[0].otherStatus = 200;
  proof.capturePointers = ['/captures/0/runSha256', '/captures/0/secondRunSha256'];
  proof.facts[0].replicatedPointers = ['/captures/0/status', '/captures/0/otherStatus'];
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'independent-capture-roots-required');
  proof.capturePointers = ['/captures/0/runSha256', '/captures/1/runSha256'];
  delete proof.facts[0].replicatedPointers;
  proof.facts[0].equalBodyHashesPointer = '/bodyHashes';
  f.capsule.bodyHashes = ['a'.repeat(64), 'a'.repeat(64)];
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'independent-fact-replicas-required');
});

test('module setup cannot change without binding, including omitted source bindings', (t) => {
  const text = source
    .replace("test('example'", "const value = 1;\ntest('example'")
    .replace('assert.equal(1, 1)', 'assert.equal(value, 1)');
  const f = partial(fixture(t, text), [[0]]);
  f.updateCurrent(text.replace('const value = 1;', 'const value = 2;'));
  assert.equal(f.run().pending[0].reason, 'reviewed-module-deltas-required');
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented review cannot bypass omitted input changes.',
    corrections: [],
    addedTests: [],
  };
  assert.equal(f.run().pending[0].reason, 'changed-module-context');
});

test('generator case titles, values, and baseline mutations must match the real literal universe', (t) => {
  const f = fixture(t, loopSource);
  f.spec.caseUniverse.cases = ['fiction A', 'fiction B'];
  f.spec.caseUniverse.casesSha256 = hashJson(f.spec.caseUniverse.cases);
  assert.equal(f.run().pending[0].reason, 'case-identities-do-not-match');
  f.spec.caseUniverse.cases = ['case 1', 'case 2'];
  f.spec.caseUniverse.casesSha256 = hashJson(f.spec.caseUniverse.cases);
  f.spec.caseUniverse.caseBindings = [{ value: 100 }, { value: 200 }];
  assert.equal(f.run().pending[0].reason, 'case-bindings-do-not-match');
  const mutated = loopSource.replace('for (const value', 'cases.length = 0;\nfor (const value');
  const g = fixture(t, mutated);
  const model = describeParitySource(mutated, 'sample.test.mjs');
  g.spec.caseUniverse.count = 2;
  g.spec.caseUniverse.cases = ['case 1', 'case 2'];
  g.spec.caseUniverse.casesSha256 = hashJson(g.spec.caseUniverse.cases);
  g.spec.caseUniverse.caseBindings = [{ value: 1 }, { value: 2 }];
  g.spec.caseUniverse.sourceBindings = [
    { name: 'cases', initializerAstSha256: model.declarations[0].initializerAstSha256 },
  ];
  assert.equal(g.run().pending[0].reason, 'dynamic-registration-context-unsupported');
});

test('generated source guard rejects generator mutations after qualification', (t) => {
  const f = partial(fixture(t, loopSource), [[0]]);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  const file = path.join(f.root, 'sample.test.mjs');
  fs.writeFileSync(file, report.changes[0].after);
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  fs.writeFileSync(
    file,
    fs.readFileSync(file, 'utf8').replace('for (const value', 'cases.length = 0;\nfor (const value'),
  );
  assert.throws(() => assertParityBindings(pathToFileURL(file), report.changes[0].bindings), /changed-module-context/);
});

test('non-builtin imports require reviewed roles; test input closure is baseline and runtime bound', (t) => {
  const text = source
    .replace("import test from 'node:test';", "import test from 'node:test';\nimport { value } from './input.mjs';")
    .replace('assert.equal(1, 1)', 'assert.equal(value, 1)');
  const f = fixture(t, text);
  fs.writeFileSync(path.join(f.root, 'input.mjs'), "export { value } from './nested.mjs';\n");
  fs.writeFileSync(path.join(f.root, 'nested.mjs'), 'export const value = 1;\n');
  const baseline = (file) => (file === 'sample.test.mjs' ? text : fs.readFileSync(path.join(f.root, file), 'utf8'));
  const run = () => qualifyParityManifest(f.manifest, { root: f.root, readBaseline: baseline });
  assert.equal(run().pending[0].reason, 'reviewed-import-roles-required');
  f.manifest.files[0].importRoles = [
    {
      source: './input.mjs',
      role: 'test-input',
      reviewedBy: 'tooling-author',
      reason: 'Invented local fixture defines assertion input.',
    },
  ];
  const report = run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.changes[0].bindings[0].inputDependencies.length, 2);
  const file = path.join(f.root, 'sample.test.mjs');
  fs.writeFileSync(file, report.changes[0].after);
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  fs.writeFileSync(path.join(f.root, 'nested.mjs'), 'export const value = 2;\n');
  assert.throws(
    () => assertParityBindings(pathToFileURL(file), report.changes[0].bindings),
    /changed-test-input-dependency/,
  );
});

test('implementation imports need explicit review and do not pin the implementation', (t) => {
  const text = source
    .replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport { value } from './implementation.mjs';",
    )
    .replace('assert.equal(1, 1)', 'assert.equal(value(), 1)');
  const f = fixture(t, text);
  f.manifest.files[0].importRoles = [
    {
      source: './implementation.mjs',
      role: 'implementation-under-test',
      reviewedBy: 'tooling-author',
      reason: 'Invented implementation is the actual subject under test.',
    },
  ];
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.deepEqual(report.changes[0].bindings[0].inputDependencies, []);
});

test('ambient network requires a reviewed source-derived producer and unknown filesystem access fails closed', (t) => {
  const text = source.replace(
    '  assert.equal(1, 1);',
    `  globalThis.fetch = () => 'fixture';
  assert.equal(globalThis.fetch(), 'fixture');`,
  );
  const f = fixture(t, text);
  assert.equal(f.run().pending[0].reason, 'reviewed-runtime-inputs-required');
  const ast = describeParitySource(text).ast;
  const producer = ast.body.find((item) => item.type === 'ExpressionStatement').expression.arguments[1].body.body[0]
    .expression.right;
  f.manifest.files[0].runtimeInputs = [
    {
      kind: 'network',
      baselineId: f.spec.baselineId,
      role: 'source-derived',
      producerAstSha256: parityAstHash(producer),
      reviewedBy: 'tooling-author',
      reason: 'Invented synchronous source fixture supplies the complete response.',
    },
  ];
  assert.deepEqual(f.run().pending, []);
  f.manifest.files[0].runtimeInputs[0].producerAstSha256 = '0'.repeat(64);
  assert.equal(f.run().pending[0].reason, 'unknown-runtime-input-producer');
  const fsText = source
    .replace("import test from 'node:test';", "import test from 'node:test';\nimport fs from 'node:fs';")
    .replace('  assert.equal(1, 1);', "  assert.equal(fs.readFileSync(variable), 'fixture');");
  assert.equal(fixture(t, fsText).run().pending[0].reason, 'unsupported-filesystem-input');
});

test('legacy whole guards migrate only when all original proof and source descriptors match', (t) => {
  const f = fixture(t);
  const first = f.run();
  assert.deepEqual(first.pending, []);
  const current = first.changes[0].bindings[0];
  const legacy = { ...current };
  for (const key of [
    'moduleContextAstSha256',
    'importRoles',
    'runtimeInputs',
    'inputDependencies',
    'caseUniverse',
    'caseFacts',
  ])
    delete legacy[key];
  const oldSource = first.changes[0].after.replace(JSON.stringify([current]), JSON.stringify([legacy]));
  f.updateCurrent(oldSource);
  const migrated = f.run();
  assert.deepEqual(migrated.pending, []);
  assert.match(migrated.changes[0].after, /Existing exact manifest proof retained/);
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), migrated.changes[0].after);
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), migrated.changes[0].bindings);
  f.updateCurrent(oldSource.replace(legacy.proofs[0].sha256, '0'.repeat(64)));
  assert.equal(f.run().pending[0].reason, 'stale-generated-guard');
});

test('whole guard proof updates preserve the exact ordered prior proof prefix', (t) => {
  const f = fixture(t);
  const first = f.run();
  writeParityQualification(first, { root: f.root });
  f.updateCurrent(fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8'));
  const proofs = f.manifest.files[0].guarantees[0].proofs;
  const extra = structuredClone(proofs[0]);
  extra.facts[0].id = 'additional-status';
  proofs.push(extra);
  const appended = f.run();
  assert.deepEqual(appended.pending, []);
  assert.deepEqual(appended.changes[0].bindings[0].proofs[0], first.changes[0].bindings[0].proofs[0]);
  const oldBinding = first.changes[0].bindings[0];
  const withoutPriorProof = { ...oldBinding, proofs: [] };
  const guarded = first.changes[0].after;
  f.updateCurrent(guarded.replace(JSON.stringify([oldBinding]), JSON.stringify([withoutPriorProof])));
  assert.equal(f.run().pending[0].reason, 'stale-generated-guard');
  f.updateCurrent(guarded);
  proofs.reverse();
  assert.equal(f.run().pending[0].reason, 'stale-generated-guard');
  proofs.splice(0, 2, extra);
  assert.ok(f.run().pending.length);
});

test('literal tuple generators bind exact arity, values and names', (t) => {
  const text = `// @test-kind unproven: tuple fixtures have invented values.
import test from 'node:test';
import assert from 'node:assert/strict';
const cases = [['a', 1], ['b', 2], ['c', 3]];
for (const [name, value] of cases) {
  test('case ' + name, () => { assert.ok(value > 0); });
}`;
  const f = fixture(t, text),
    row = describeParitySource(text, 'sample.test.mjs').registrations[0];
  f.spec.caseUniverse = {
    count: 3,
    cases: ['case a', 'case b', 'case c'],
    casesSha256: hashJson(['case a', 'case b', 'case c']),
    caseBindings: [
      { name: 'a', value: 1 },
      { name: 'b', value: 2 },
      { name: 'c', value: 3 },
    ],
    ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
    sourceBindings: [
      { name: 'cases', initializerAstSha256: describeParitySource(text).declarations[0].initializerAstSha256 },
    ],
  };
  f.spec.caseFacts = [0, 1, 2].map((caseIndex) => ({ caseIndex, assertionIndex: 0, factIds: ['status'] }));
  assert.deepEqual(f.run().pending, []);
  f.spec.caseUniverse.caseBindings[1].value = 99;
  assert.equal(f.run().pending[0].reason, 'case-bindings-do-not-match');
});

test('computed globals, aliases and unreachable producers cannot bypass runtime review', (t) => {
  for (const expression of [
    "process['env'].UNREVIEWED_VALUE",
    "globalThis['fetch']",
    "Date['now']()",
    'Math.random()',
  ]) {
    const text = source.replace('assert.equal(1, 1)', `assert.equal(typeof ${expression}, 'function')`);
    assert.ok(fixture(t, text).run().pending.length, expression);
  }
  const alias = source.replace(
    'assert.equal(1, 1);',
    "const ambient = globalThis;\n  assert.equal(typeof ambient.fetch, 'function');",
  );
  assert.equal(fixture(t, alias).run().pending[0].reason, 'unknown-runtime-input-producer');
  const text = source.replace(
    'assert.equal(1, 1);',
    "if (false) globalThis.fetch = () => 'fixture';\n  assert.equal(typeof globalThis.fetch, 'function');",
  );
  const f = fixture(t, text),
    ast = describeParitySource(text).ast;
  const producer = ast.body.find((item) => item.type === 'ExpressionStatement').expression.arguments[1].body.body[0]
    .consequent.expression.right;
  f.manifest.files[0].runtimeInputs = [
    {
      baselineId: f.spec.baselineId,
      kind: 'network',
      role: 'source-derived',
      producerAstSha256: parityAstHash(producer),
      reviewedBy: 'tooling-author',
      reason: 'Invented fixture producer for a tooling test.',
    },
  ];
  assert.equal(f.run().pending[0].reason, 'conditional-assertion-execution');
});

test('static repository fixture reads are baseline checked and runtime pinned', (t) => {
  const text = source
    .replace("import test from 'node:test';", "import test from 'node:test';\nimport { readFileSync } from 'node:fs';")
    .replace(
      'assert.equal(1, 1)',
      "assert.equal(readFileSync(new URL('./fixture.txt', import.meta.url), 'utf8'), 'ok')",
    );
  const f = fixture(t, text),
    asset = path.join(f.root, 'fixture.txt');
  fs.writeFileSync(asset, 'ok');
  const baseline = (file) => (file === 'sample.test.mjs' ? text : 'ok');
  const report = qualifyParityManifest(f.manifest, { root: f.root, readBaseline: baseline });
  assert.deepEqual(report.pending, []);
  assert.deepEqual(
    report.changes[0].bindings[0].inputDependencies.map((entry) => entry.path),
    ['fixture.txt'],
  );
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), report.changes[0].after);
  fs.writeFileSync(asset, 'changed');
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings),
    /changed-test-input-dependency/,
  );
  f.updateCurrent(text);
  assert.equal(
    qualifyParityManifest(f.manifest, { root: f.root, readBaseline: baseline }).pending[0].reason,
    'changed-test-input-dependency',
  );
});

test('an input-module alias cannot hide ambient environment reads', (t) => {
  const text = source
    .replace("import test from 'node:test';", "import test from 'node:test';\nimport { value } from './input.mjs';")
    .replace('assert.equal(1, 1)', "assert.equal(value, 'expected')");
  const f = fixture(t, text),
    input = 'const ambient = globalThis; export const value = ambient.process.env.UNREVIEWED_VALUE;';
  fs.writeFileSync(path.join(f.root, 'input.mjs'), input);
  f.manifest.files[0].importRoles = [
    {
      source: './input.mjs',
      role: 'test-input',
      reviewedBy: 'tooling-author',
      reason: 'Invented input module reviewed for this tooling fixture.',
    },
  ];
  const report = qualifyParityManifest(f.manifest, {
    root: f.root,
    readBaseline: (file) => (file === 'sample.test.mjs' ? text : input),
  });
  assert.equal(report.pending[0].reason, 'unknown-runtime-input-producer');
});

test('builtin imports cannot bypass ambient input classification', (t) => {
  for (const [binding, module] of [
    ['env as importedEnv', 'node:process'],
    ['randomUUID as importedRandom', 'node:crypto'],
    ['randomUUID as importedRandom', 'crypto'],
  ]) {
    const text = source.replace(
      "import test from 'node:test';",
      `import test from 'node:test';\nimport { ${binding} } from '${module}';`,
    );
    assert.equal(fixture(t, text).run().pending[0].reason, 'unsupported-builtin-import');
  }
});

test('JSON.stringify on an arbitrary value is not stripped as a side-effect-free hash guard', (t) => {
  const f = fixture(t);
  const updated = source
    .replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport { createHash } from 'node:crypto';\nconst cases = { toJSON() { mutateInputs(); return {}; } };",
    )
    .replace(
      '  assert.equal(1, 1);',
      `  assert.equal(createHash('sha256').update(JSON.stringify(cases)).digest('hex'), '${'a'.repeat(64)}');\n  assert.equal(1, 1);`,
    );
  f.updateCurrent(updated);
  assert.equal(f.run().pending[0].reason, 'unmapped-current-assertion');
});

test('generator baseline cannot replace the array iterator before registering cases', (t) => {
  const mutated = loopSource
    .replace(
      'for (const value',
      `const prior = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function* () {};
for (const value`,
    )
    .replace(/\n$/, '\nArray.prototype[Symbol.iterator] = prior;\n');
  const f = fixture(t, mutated),
    model = describeParitySource(mutated, 'sample.test.mjs');
  f.spec.caseUniverse.count = 2;
  f.spec.caseUniverse.cases = ['case 1', 'case 2'];
  f.spec.caseUniverse.casesSha256 = hashJson(f.spec.caseUniverse.cases);
  f.spec.caseUniverse.caseBindings = [{ value: 1 }, { value: 2 }];
  f.spec.caseUniverse.sourceBindings = [
    { name: 'cases', initializerAstSha256: model.declarations[0].initializerAstSha256 },
  ];
  f.spec.caseFacts = [0, 1].map((caseIndex) => ({ caseIndex, assertionIndex: 0, factIds: ['status'] }));
  assert.equal(f.run().pending[0].reason, 'dynamic-registration-context-unsupported');
});

test('cumulative partial regeneration preserves all prior proof regions and is idempotent', (t) => {
  const text = source.replace('  assert.equal(1, 1);', '  assert.equal(1, 1);\n  assert.equal(2, 2);');
  const f = partial(fixture(t, text), [[0]]);
  const first = f.run();
  assert.deepEqual(first.pending, []);
  writeParityQualification(first, { root: f.root });
  f.updateCurrent(first.changes[0].after);
  const again = f.run();
  assert.deepEqual(again.pending, []);
  assert.equal(again.changes.length, 0);
  const original = describeParitySource(text, 'sample.test.mjs').registrations[0];
  f.spec.regions.push({ assertions: [{ sha256: original.assertions[1].sha256, factIds: ['status'] }] });
  const cumulative = f.run();
  assert.deepEqual(cumulative.pending, []);
  assert.equal(cumulative.files[0].partialRegions, 2);
  writeParityQualification(cumulative, { root: f.root });
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), cumulative.changes[0].bindings);
  f.updateCurrent(cumulative.changes[0].after);
  f.spec.regions.shift();
  assert.equal(f.run().pending[0].reason, 'existing-partial-region-omitted');
});

test('reviewed module corrections preserve producer and bind original/current evidence', (t) => {
  const text = source + "test('other', () => { assert.equal(3, 2); });\n";
  const f = partial(fixture(t, text), [[0]]);
  const changed = text.replace('assert.equal(3, 2)', 'assert.equal(3, 3)');
  f.updateCurrent(changed);
  assert.equal(f.run().pending[0].reason, 'reviewed-module-deltas-required');
  const before = describeParitySource(text).registrations[1].assertions[0].sha256;
  const after = describeParitySource(changed).registrations[1].assertions[0].sha256;
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented expected-value correction explicitly reviewed.',
    corrections: [
      {
        oldAstSha256: before,
        currentAstSha256: after,
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'The same invented call and input were reviewed twice.',
      },
    ],
    addedTests: [],
  };
  const report = f.run();
  assert.deepEqual(report.pending, []);
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), report.changes[0].after);
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
  const altered = changed.replace('assert.equal(3, 3)', 'assert.equal(4, 3)');
  f.updateCurrent(altered);
  f.manifest.files[0].moduleReview.corrections[0].currentAstSha256 =
    describeParitySource(altered).registrations[1].assertions[0].sha256;
  assert.equal(f.run().pending[0].reason, 'correction-changes-producer-or-input');
});

test('added top-level tests require exact AST and explicit zero-credit interaction review', (t) => {
  const f = partial(fixture(t), [[0]]);
  const changed = source + "test('extra', () => { assert.equal(4, 4); });\n";
  f.updateCurrent(changed);
  const extra = describeParitySource(changed).registrations[1];
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented added test is isolated and reviewed.',
    corrections: [],
    addedTests: [
      {
        titleExpressionSha256: extra.titleExpressionSha256,
        bodyAstSha256: parityAstHash(extra.callback.body),
        reviewedBy: 'tooling-author',
        reason: 'This added test has no shared mutable interactions.',
        zeroOriginalCredit: true,
        interactionReviewed: true,
      },
    ],
  };
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 0);
  f.manifest.files[0].moduleReview.addedTests[0].interactionReviewed = false;
  assert.equal(f.run().pending[0].reason, 'invalid-added-test-review');
});

test('interaction review alone cannot admit an added test that mutates original setup', (t) => {
  const text = source
    .replace("test('example'", "let value = 1;\ntest('example'")
    .replace('assert.equal(1, 1)', 'assert.equal(value, 1)');
  const f = partial(fixture(t, text), [[0]]);
  const changed = text.replace(
    "test('example'",
    "test('extra', () => { value = 2; assert.equal(2, 2); });\ntest('example'",
  );
  f.updateCurrent(changed);
  const extra = describeParitySource(changed).registrations[0];
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented added test review for regression.',
    corrections: [],
    addedTests: [
      {
        titleExpressionSha256: extra.titleExpressionSha256,
        bodyAstSha256: parityAstHash(extra.callback.body),
        reviewedBy: 'tooling-author',
        reason: 'Claimed isolated but mutates the shared original input.',
        zeroOriginalCredit: true,
        interactionReviewed: true,
      },
    ],
  };
  assert.equal(f.run().pending[0].reason, 'added-test-isolation-unproven');
});

test('added-test registration arguments and callback parameters cannot mutate setup', (t) => {
  const text = source
    .replace("test('example'", "let value = 1;\ntest('example'")
    .replace('assert.equal(1, 1)', 'assert.equal(value, 1)');
  for (const added of [
    "test('extra', (value = 2, {}), () => { assert.equal(2, 2); });\n",
    "test('extra', (x = (value = 2)) => { assert.equal(2, 2); });\n",
  ]) {
    const f = partial(fixture(t, text), [[0]]);
    const changed = text.replace("test('example'", added + "test('example'");
    f.updateCurrent(changed);
    const extra = describeParitySource(changed).registrations[0];
    f.manifest.files[0].moduleReview = {
      reviewedBy: 'tooling-author',
      reason: 'Invented interaction regression under review.',
      corrections: [],
      addedTests: [
        {
          titleExpressionSha256: extra.titleExpressionSha256,
          bodyAstSha256: parityAstHash(extra.callback.body),
          reviewedBy: 'tooling-author',
          reason: 'Claimed isolated but registration has side effects.',
          zeroOriginalCredit: true,
          interactionReviewed: true,
        },
      ],
    };
    assert.equal(f.run().pending[0].reason, 'added-test-isolation-unproven');
  }
});

test('partial qualification cannot omit an original baseline hash assertion', (t) => {
  const hash = 'a'.repeat(64);
  const guard = `assert.equal(createHash('sha256').update(fs.readFileSync(new URL('./proof.json', import.meta.url))).digest('hex'), '${hash}');`;
  const text = source
    .replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport fs from 'node:fs';\nimport { createHash } from 'node:crypto';",
    )
    .replace('  assert.equal(1, 1);', `  ${guard}\n  assert.equal(1, 1);`);
  const f = partial(fixture(t, text), [[1]]);
  f.updateCurrent(text.replace(`  ${guard}\n`, ''));
  assert.equal(f.run().pending[0].reason, 'changed-original-body');
});

test('legacy partial guards migrate only after proving the baseline has no omitted original guards', (t) => {
  const f = partial(fixture(t), [[0]]),
    first = f.run();
  assert.deepEqual(first.pending, []);
  const current = first.changes[0].bindings[0],
    legacy = { ...current };
  delete legacy.originalGuardHashes;
  const oldSource = first.changes[0].after.replaceAll(JSON.stringify([current]), JSON.stringify([legacy]));
  f.updateCurrent(oldSource);
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), [legacy]),
    /module-context-binding-required/,
  );
  const migrated = f.run();
  assert.deepEqual(migrated.pending, []);
  assert.equal(migrated.changes.length, 1);
  writeParityQualification(migrated, { root: f.root });
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), migrated.changes[0].bindings);
});

test('only imports used exclusively by exact hash guards are transparent module scaffolding', (t) => {
  const f = partial(fixture(t), [[0]]);
  const digest = parityHash(fs.readFileSync(f.proofFile));
  const text = source
    .replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport fs from 'node:fs';\nimport { createHash } from 'node:crypto';",
    )
    .replace(
      '  assert.equal(1, 1);',
      `  assert.equal(createHash('sha256').update(fs.readFileSync(new URL('./proof.json', import.meta.url))).digest('hex'), '${digest}');\n  assert.equal(1, 1);`,
    );
  f.updateCurrent(text);
  assert.deepEqual(f.run().pending, []);
  f.updateCurrent(text.replace('  assert.equal(1, 1);', '  fs.readFileSync(variable);\n  assert.equal(1, 1);'));
  assert.equal(f.run().pending[0].reason, 'changed-original-body');
});

test('an added awaited hash guard is not transparent because it changes scheduling', (t) => {
  const f = partial(fixture(t), [[0]]),
    digest = parityHash(fs.readFileSync(f.proofFile));
  const text = source
    .replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport { readFile } from 'node:fs/promises';\nimport { createHash } from 'node:crypto';",
    )
    .replace("test('example', () => {", "test('example', async () => {")
    .replace(
      '  assert.equal(1, 1);',
      `  assert.equal(createHash('sha256').update(await readFile(new URL('./proof.json', import.meta.url))).digest('hex'), '${digest}');\n  assert.equal(1, 1);`,
    );
  f.updateCurrent(text);
  assert.ok(f.run().pending.length);
});

test('imports used by original hash assertions remain bound in module context', (t) => {
  const guard = `assert.equal(createHash('sha256').update(fs.readFileSync(new URL('./proof.json', import.meta.url))).digest('hex'), '${'a'.repeat(64)}');`;
  const text = source
    .replace(
      "import test from 'node:test';",
      "import test from 'node:test';\nimport fs from 'node:fs';\nimport { createHash } from 'node:crypto';",
    )
    .replace('  assert.equal(1, 1);', `  ${guard}\n  assert.equal(1, 1);`);
  const f = partial(fixture(t, text), [[1]]),
    proof = fs.readFileSync(f.proofFile, 'utf8');
  f.updateCurrent(text.replace("import { createHash } from 'node:crypto';\n", ''));
  const report = qualifyParityManifest(f.manifest, {
    root: f.root,
    readBaseline: (file) => (file === 'proof.json' ? proof : text),
  });
  assert.equal(report.pending[0].reason, 'reviewed-module-deltas-required');
});

test('a reviewed same-guarantee correction beside a selected region retains the original body binding', (t) => {
  const text = source.replace('  assert.equal(1, 1);', '  assert.equal(1, 1);\n  assert.equal(2, 1);');
  const f = partial(fixture(t, text), [[0]]),
    changed = text.replace('assert.equal(2, 1)', 'assert.equal(2, 2)');
  f.updateCurrent(changed);
  const oldHash = describeParitySource(text).registrations[0].assertions[1].sha256;
  const newHash = describeParitySource(changed).registrations[0].assertions[1].sha256;
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented correction preserves the reviewed exact input.',
    corrections: [
      {
        oldAstSha256: oldHash,
        currentAstSha256: newHash,
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'The two invented proof facts use the same original producer.',
      },
    ],
    addedTests: [],
  };
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.notEqual(
    report.changes[0].bindings[0].baselineBodyAstSha256,
    report.changes[0].bindings[0].originalBodyAstSha256,
  );
  writeParityQualification(report, { root: f.root });
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
  const selectedChange = changed.replace('assert.equal(1, 1)', 'assert.equal(1, 0)');
  f.updateCurrent(selectedChange);
  assert.ok(f.run().pending.length);
});

test('reviewed correction applies only to its owner when original assertion ASTs match', (t) => {
  const text = source + "test('second', () => {\n  assert.equal(1, 1);\n});\n";
  const f = partial(fixture(t, text), [[0]]);
  const rows = describeParitySource(text, 'sample.test.mjs').registrations;
  const second = rows[1];
  const spec = structuredClone(f.spec);
  spec.baselineId = second.id;
  spec.titleExpressionSha256 = second.titleExpressionSha256;
  spec.caseUniverse.cases = ['second'];
  spec.caseUniverse.casesSha256 = hashJson(['second']);
  f.manifest.files[0].guarantees[0].tests.push(spec);
  const changed = text.replace(
    "test('second', () => {\n  assert.equal(1, 1);",
    "test('second', () => {\n  assert.equal(1, 2);",
  );
  f.updateCurrent(changed);
  const current = describeParitySource(changed, 'sample.test.mjs').registrations[1];
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented owner-specific expectation correction.',
    addedTests: [],
    corrections: [
      {
        baselineId: second.id,
        oldAstSha256: second.assertions[0].sha256,
        currentAstSha256: current.assertions[0].sha256,
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'The invented proof applies only to the second original registration.',
      },
    ],
  };
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.files[0].partialRegions, 2);
  assert.notEqual(report.changes[0].bindings[0].regionHashes[0][0], report.changes[0].bindings[1].regionHashes[0][0]);
});

test('generator case count rejects sibling control flow that skips registrations', (t) => {
  for (const line of ['if (value === 1) continue;', 'if (value === 1) break;', 'false &&']) {
    const text =
      line === 'false &&'
        ? loopSource.replace("  test('case '", "  false && test('case '")
        : loopSource.replace("  test('case '", `  ${line}\n  test('case '`);
    const f = loopFixture(t, text);
    assert.equal(
      f.run().pending[0].reason,
      line === 'false &&' ? 'unsupported-registration-execution' : 'dynamic-registration-context-unsupported',
    );
  }
});

test('reviewed native proof never authorizes changing an existing security assertion', (t) => {
  const text = source
    .replace('@test-kind unproven:', '@test-kind security:')
    .replace('  assert.equal(1, 1);', '  assert.equal(1, 1);\n  assert.equal(2, 1);');
  const f = partial(fixture(t, text), [[0]]),
    changed = text.replace('assert.equal(2, 1)', 'assert.equal(2, 2)');
  f.updateCurrent(changed);
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented security correction must remain blocked.',
    corrections: [
      {
        oldAstSha256: describeParitySource(text).registrations[0].assertions[1].sha256,
        currentAstSha256: describeParitySource(changed).registrations[0].assertions[1].sha256,
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'Invented facts do not authorize weakening security.',
      },
    ],
    addedTests: [],
  };
  assert.equal(f.run().pending[0].reason, 'security-correction-requires-user-authorization');
});

test('a test override cannot erase inherited file-level security for correction review', (t) => {
  const text = source
    .replace('@test-kind unproven:', '@test-kind security:')
    .replace("test('example'", "// @test-kind unproven: local mixed assertion remains unproven\ntest('example'")
    .replace('  assert.equal(1, 1);', '  assert.equal(1, 1);\n  assert.equal(2, 1);');
  const f = partial(fixture(t, text), [[0]]),
    changed = text.replace('assert.equal(2, 1)', 'assert.equal(2, 2)');
  f.updateCurrent(changed);
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented inherited security must stay protected.',
    corrections: [
      {
        oldAstSha256: describeParitySource(text).registrations[0].assertions[1].sha256,
        currentAstSha256: describeParitySource(changed).registrations[0].assertions[1].sha256,
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'Invented facts cannot remove inherited security protections.',
      },
    ],
    addedTests: [],
  };
  assert.equal(f.run().pending[0].reason, 'security-correction-requires-user-authorization');
});

test('generated registration options and default parameters cannot hide side effects', (t) => {
  for (const replacement of [
    "test('case ' + value, (null.x, {}), () => {",
    "test('case ' + value, (x = sideEffect()) => {",
  ]) {
    const text = loopSource.replace("test('case ' + value, () => {", replacement);
    const f = loopFixture(t, text);
    assert.equal(f.run().pending[0].reason, 'unsupported-registration-execution');
  }
});

test('standalone or ancestor tests with skip/options or short-circuit registration are never qualified', (t) => {
  const standalone = [
    source.replace("test('example', () => {", "test('example', { skip: true }, () => {"),
    source.replace("test('example', () => {", "false && test('example', () => {"),
  ];
  for (const text of standalone)
    assert.equal(fixture(t, text).run().pending[0].reason, 'unsupported-registration-execution');
  const nested = source.replace(
    "test('example', () => {\n  assert.equal(1, 1);\n});",
    "test('parent', { skip: true }, async (t) => { await t.test('example', () => { assert.equal(1, 1); }); });",
  );
  const f = fixture(t, nested),
    model = describeParitySource(nested, 'sample.test.mjs'),
    child = model.registrations[1];
  f.spec.baselineId = child.id;
  f.spec.titleExpressionSha256 = child.titleExpressionSha256;
  f.spec.parentTitleExpressionSha256 = child.parent.titleExpressionSha256;
  f.spec.assertions = child.assertions.map((item) => ({ sha256: item.sha256, factIds: ['status'] }));
  assert.equal(f.run().pending[0].reason, 'unsupported-registration-execution');
});

test('unreachable, conditional, and skipped assertions cannot earn parity credit', (t) => {
  for (const replacement of [
    '  return;\n  assert.equal(1, 1);',
    '  if (false) { assert.equal(1, 1); }',
    '  if (condition) return;\n  assert.equal(1, 1);',
  ]) {
    const text = source.replace('  assert.equal(1, 1);', replacement);
    const f = fixture(t, text);
    assert.ok(f.run().pending.length, replacement);
  }
  const skipped = source.replace("test('example', () => {", "test('example', (t) => {\n  t.skip();");
  assert.equal(fixture(t, skipped).run().pending[0].reason, 'unsupported-test-context-use');
  const todo = source.replace("test('example', () => {", "test('example', (t) => {\n  t.todo();");
  assert.equal(fixture(t, todo).run().pending[0].reason, 'unsupported-test-context-use');
});

test('shadowed or mutated imported assertion bindings cannot fabricate a passing assertion', (t) => {
  const shadow = source.replace('  assert.equal(1, 1);', '  const assert = { equal() {} };\n  assert.equal(1, 1);');
  assert.equal(fixture(t, shadow).run().pending[0].reason, 'unsafe-assertion-binding');
  const mutate = source.replace('  assert.equal(1, 1);', '  assert.equal = () => {};\n  assert.equal(1, 1);');
  assert.equal(fixture(t, mutate).run().pending[0].reason, 'unsafe-assertion-binding');
});

test('test-context assertion methods cannot be replaced or aliased', (t) => {
  const text = source.replace(
    "test('example', () => {\n  assert.equal(1, 1);",
    "test('example', (t) => {\n  t.assert.equal = () => {};\n  t.assert.equal(1, 1);",
  );
  assert.equal(fixture(t, text).run().pending[0].reason, 'unsafe-assertion-binding');
});

test('partial qualification cannot weaken a baseline parity or security kind', (t) => {
  for (const kind of ['parity', 'security']) {
    const reason =
      kind === 'parity'
        ? 'native recording reproduced twice for invented test'
        : 'invented security guarantee protects this assertion';
    const text = source.replace(
      '// @test-kind unproven: Invented model for strict qualifier tests.',
      `// @test-kind ${kind}: ${reason}`,
    );
    const f = partial(fixture(t, text), [[0]]);
    f.updateCurrent(text.replace(`@test-kind ${kind}:`, '@test-kind unproven:'));
    assert.equal(f.run().pending[0].reason, 'protected-kind-lost');
  }
});

test('a baseline parity correction requires a new adjacent proof comment naming its guarantee', (t) => {
  const text = source
    .replace(
      '// @test-kind unproven: Invented model for strict qualifier tests.',
      '// @test-kind parity: invented native recording reproduced twice for tooling.',
    )
    .replace('  assert.equal(1, 1);', '  assert.equal(1, 1);\n  assert.equal(2, 1);');
  const f = partial(fixture(t, text), [[0]]),
    changed = text.replace('assert.equal(2, 1)', 'assert.equal(2, 2)');
  f.updateCurrent(changed);
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented parity correction preserves the producer.',
    corrections: [
      {
        oldAstSha256: describeParitySource(text).registrations[0].assertions[1].sha256,
        currentAstSha256: describeParitySource(changed).registrations[0].assertions[1].sha256,
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'Invented repeated evidence proves the same input.',
      },
    ],
    addedTests: [],
  };
  assert.equal(f.run().pending[0].reason, 'new-parity-evidence-comment-required');
  f.updateCurrent(
    changed.replace(
      '  assert.equal(2, 2);',
      '  // @parity-evidence: invented-transport-status repeated native evidence for this exact guarantee.\n  assert.equal(2, 2);',
    ),
  );
  assert.deepEqual(f.run().pending, []);
});

test('security correction requires a caller-pinned exact approval and official facts', (t) => {
  const text = source
    .replace('@test-kind unproven:', '@test-kind security:')
    .replace("test('example'", "const evaluate = (formula, value) => value;\ntest('example'")
    .replace(
      '  assert.equal(1, 1);',
      "  assert.equal(1, 1);\n  assert.equal(2, 2);\n  assert.equal(evaluate('operation', 'input'), 'old');",
    );
  const changed = text.replace("'old');", "'new');");
  const f = fixture(t, text),
    before = describeParitySource(text, 'sample.test.mjs').registrations[0],
    after = describeParitySource(changed, 'sample.test.mjs').registrations[0];
  f.updateCurrent(changed);
  const correction = {
    oldAstSha256: before.assertions[2].sha256,
    currentAstSha256: after.assertions[2].sha256,
    sameGuarantee: true,
    guaranteeId: 'invented-transport-status',
    factIds: ['status'],
    reviewedBy: 'tooling-author',
    reason: 'Invented official evidence maps the same exact input.',
  };
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented reviewed correction for the exact assertion.',
    corrections: [correction],
    addedTests: [],
  };
  const proof = f.manifest.files[0].guarantees[0].proofs[0];
  proof.mode = 'official-package';
  proof.packagePointer = '/package';
  proof.package = {
    ecosystem: 'npm',
    id: '@microsoft/invented-fixture',
    version: '1.2.3',
    source: 'https://registry.npmjs.org/@microsoft/invented-fixture/-/invented-fixture-1.2.3.tgz',
    sha256: '3'.repeat(64),
    integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
    executedSourceClosure: [{ path: 'dist/main.js', sha256: '4'.repeat(64) }],
  };
  f.capsule.package = proof.package;
  f.updateProof(f.capsule);
  const receipt = {
    authority: 'directhumanreplyinrootchat',
    answer: 'Approve this exact expectation change',
    file: 'sample.test.mjs',
    baselineId: before.id,
    baselineSourceSha256: parityHash(text),
    currentSourceSha256: parityHash(changed),
    originalAssertionSha256: before.assertions[2].sha256,
    currentAssertionSha256: after.assertions[2].sha256,
    operationAstSha256: parityAstHash(before.assertions[2].node.arguments[0]),
    exactInput: 'input',
    oldExpected: 'old',
    approvedExpected: 'new',
    unchangedLongAssertionHashes: before.assertions.slice(0, 2).map((item) => item.sha256),
  };
  const privateFile = path.join(f.root, 'private-approval.json');
  fs.writeFileSync(privateFile, JSON.stringify(receipt));
  const pin = parityHash(fs.readFileSync(privateFile));
  const run = () =>
    qualifyParityManifest(f.manifest, {
      root: f.root,
      readBaseline: f.readBaseline,
      securityApprovalFile: privateFile,
      securityApprovalSha256: pin,
    });
  f.manifest.files[0].securityApproval = receipt;
  assert.equal(f.run().pending[0].reason, 'security-correction-requires-user-authorization');
  const report = run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.changes[0].bindings[0].securityApprovals[0].sha256, pin);
  assert.ok(!report.changes[0].after.includes(privateFile));
  assert.deepEqual(describeParitySource(report.changes[0].after).registrations[0].kinds, ['parity', 'security']);
  writeParityQualification(report, { root: f.root });
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
  f.updateCurrent(report.changes[0].after.replace('@test-kind parity+security:', '@test-kind parity:'));
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings),
    /protected-security-kind-lost/,
  );
  f.updateCurrent(changed);
  proof.mode = 'reproduced-native';
  assert.equal(run().pending[0].reason, 'security-correction-official-proof-required');
  proof.mode = 'official-package';
  fs.writeFileSync(privateFile, JSON.stringify({ ...receipt, exactInput: 'other' }));
  assert.throws(run, /security-approval-digest-mismatch/);
  fs.writeFileSync(privateFile, JSON.stringify(receipt));
  f.updateCurrent(changed.replace('assert.equal(2, 2)', 'assert.equal(2, 3)'));
  assert.equal(run().pending[0].reason, 'security-correction-requires-user-authorization');
});

test('module and parent test hooks cannot silently skip qualified assertions', (t) => {
  const moduleHook = source.replace(
    "import test from 'node:test';",
    "import test, { beforeEach } from 'node:test';\nbeforeEach((s) => s.skip());",
  );
  assert.equal(fixture(t, moduleHook).run().pending[0].reason, 'unsupported-test-hook-or-registration');
  const nested = source.replace(
    "test('example', () => {\n  assert.equal(1, 1);\n});",
    "test('parent', async (t) => { t.beforeEach((s) => s.skip()); await t.test('example', () => { assert.equal(1, 1); }); });",
  );
  const f = fixture(t, nested),
    model = describeParitySource(nested, 'sample.test.mjs'),
    child = model.registrations[1];
  f.spec.baselineId = child.id;
  f.spec.titleExpressionSha256 = child.titleExpressionSha256;
  f.spec.parentTitleExpressionSha256 = child.parent.titleExpressionSha256;
  f.spec.assertions = child.assertions.map((item) => ({ sha256: item.sha256, factIds: ['status'] }));
  assert.equal(f.run().pending[0].reason, 'unsupported-test-hook-or-registration');
});

test('promise-returning assertions must be awaited', (t) => {
  const text = source.replace('assert.equal(1, 1)', "assert.rejects(Promise.reject(new Error('x')))");
  assert.equal(fixture(t, text).run().pending[0].reason, 'unawaited-async-assertion');
});

test('CDN qualification binds publisher, independent runs, raw source captures and replicated facts', (t) => {
  const f = fixture(t),
    proof = f.manifest.files[0].guarantees[0].proofs[0];
  const privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-private-'));
  t.after(() => fs.rmSync(privateRoot, { recursive: true, force: true }));
  const base = 'https://content.powerapps.com/resource/powerappsportal/controls/';
  const manifestBytes = Buffer.from(JSON.stringify({ hash: '/host/main.abcdef1234.chunk.js' }));
  const manifestUrl = base + 'host/manifest-1.2.3.json',
    scriptUrl = base + 'host/main.abcdef1234.chunk.js';
  const pkg = {
    ecosystem: 'microsoft-cdn',
    id: 'powerappsportal-controls',
    manifests: [
      {
        source: manifestUrl,
        version: '1.2.3',
        sha256: parityHash(manifestBytes),
        bodyBase64: manifestBytes.toString('base64'),
      },
    ],
    executedSourceClosure: [{ source: scriptUrl, sha256: parityHash('script'), size: 6 }],
  };
  const reads = [
    {
      source: manifestUrl,
      finalUrl: manifestUrl,
      status: 200,
      sha256: parityHash(manifestBytes),
      size: manifestBytes.length,
    },
    { source: scriptUrl, finalUrl: scriptUrl, status: 200, sha256: parityHash('script'), size: 6 },
  ];
  const executedScripts = [
    { kind: 'controls', source: scriptUrl, sha256: parityHash('script'), size: 6 },
    { kind: 'other', source: 'inline:0', sha256: parityHash('inline'), size: 6 },
  ];
  const input = { contextSha256: parityHash('context'), executedScripts };
  const policy = {
    contextOffline: true,
    proxyDeny: true,
    allRequestsRouted: true,
    serviceWorkersBlocked: true,
    webSocketsDenied: true,
    unexpectedNetwork: 0,
  };
  const producerSource = "import './producer-helper.js';\nexport const value = 1;",
    helperSource = 'export const helper = 1;';
  const captures = [],
    runs = ['one', 'two'].map((id) => {
      const run = {
        id,
        producerSha256: parityHash(producerSource),
        input: structuredClone(input),
        inputSha256: hashJson(input),
        result: {
          executedScripts: structuredClone(executedScripts),
          networkPolicy: structuredClone(policy),
          behaviorFacts: { answer: 3 },
        },
      };
      const capture = JSON.stringify({
          id: run.id,
          producerSha256: run.producerSha256,
          inputSha256: run.inputSha256,
          input: run.input,
          result: run.result,
        }),
        captureFile = `capture-${id}.json`;
      fs.writeFileSync(path.join(privateRoot, captureFile), capture);
      captures.push({ path: captureFile, sha256: parityHash(capture), pointer: '' });
      run.result.sourceCaptureSha256 = parityHash(capture);
      run.resultSha256 = hashJson(run.result);
      run.receiptSha256 = hashJson({
        id,
        producerSha256: run.producerSha256,
        inputSha256: run.inputSha256,
        resultSha256: run.resultSha256,
      });
      return run;
    });
  const witness = (file, value) => {
    const bytes = JSON.stringify(value);
    fs.writeFileSync(path.join(privateRoot, file), bytes);
    return { path: file, sha256: parityHash(bytes), pointer: '' };
  };
  proof.mode = 'official-package';
  proof.package = pkg;
  proof.packagePointer = '/package';
  proof.capturePointers = ['/captures/0/receiptSha256', '/captures/1/receiptSha256'];
  const privateSpec = {
    publisherReadsPointer: '/publisherReads',
    runsPointer: '/runs',
    publisherWitness: witness('publisher.json', reads),
    runWitnesses: runs.map((run, index) => witness(`run-${index}.json`, run)),
    sourceCaptureWitnesses: captures,
  };
  fs.writeFileSync(path.join(privateRoot, 'producer.js'), producerSource);
  fs.writeFileSync(path.join(privateRoot, 'producer-helper.js'), helperSource);
  fs.writeFileSync(path.join(privateRoot, 'context.bin'), 'context');
  privateSpec.producerClosureWitnesses = [{ path: 'producer-helper.js', sha256: parityHash(helperSource) }];
  privateSpec.contextWitness = { path: 'context.bin', sha256: parityHash('context') };
  fs.writeFileSync(path.join(privateRoot, 'control.js'), 'script');
  fs.writeFileSync(path.join(privateRoot, 'inline.js'), 'inline');
  privateSpec.producerWitness = { path: 'producer.js', sha256: parityHash(producerSource) };
  privateSpec.assetWitnesses = [
    { source: scriptUrl, path: 'control.js', sha256: parityHash('script') },
    { source: 'inline:0', path: 'inline.js', sha256: parityHash('inline') },
  ];
  privateSpec.factBindings = [
    { id: 'status', pointers: ['/runs/0/result/behaviorFacts/answer', '/runs/1/result/behaviorFacts/answer'] },
  ];
  proof.facts = [
    {
      id: 'status',
      pointer: '/captures/0/behaviorFacts/status',
      sha256: hashJson(3),
      replicatedPointers: ['/captures/0/behaviorFacts/status', '/captures/1/behaviorFacts/status'],
    },
  ];
  const bundle = JSON.stringify({ pkg, publisherReads: reads, runs });
  fs.writeFileSync(path.join(privateRoot, 'private-bundle.json'), bundle);
  privateSpec.bundlePath = 'private-bundle.json';
  privateSpec.bundleSha256 = parityHash(bundle);
  proof.privateEvidence = privateSpec;
  proof.portableReceiptPath = 'public-receipt.json';
  f.updateProof({
    package: pkg,
    captures: runs.map((run) => ({ receiptSha256: run.receiptSha256, behaviorFacts: { status: 3 } })),
  });
  const run = () =>
    qualifyParityManifest(f.manifest, { root: f.root, readBaseline: f.readBaseline, evidenceRoot: privateRoot });
  assert.equal(f.run().pending[0].reason, 'cdn-private-evidence-root-required');
  const initial = run();
  assert.deepEqual(initial.pending, []);
  const ignoredDir = path.join(f.root, '.paqvilo');
  fs.mkdirSync(ignoredDir);
  fs.copyFileSync(f.proofFile, path.join(ignoredDir, 'PRIVATE_MARKER.json'));
  const publicPath = proof.path;
  proof.path = '.paqvilo/PRIVATE_MARKER.json';
  assert.equal(run().pending[0].reason, 'cdn-public-path-required');
  proof.path = publicPath;
  const receiptPath = proof.portableReceiptPath;
  proof.portableReceiptPath = '.paqvilo/private-receipt.json';
  assert.equal(run().pending[0].reason, 'cdn-public-path-required');
  proof.portableReceiptPath = receiptPath;
  assert.equal(
    qualifyParityManifest(f.manifest, { root: f.root, readBaseline: f.readBaseline, evidenceRoot: f.root }).pending[0]
      .reason,
    'cdn-public-path-required',
  );
  const publicCapsule = {
    package: pkg,
    captures: runs.map((item) => ({ receiptSha256: item.receiptSha256, behaviorFacts: { status: 3 } })),
  };
  f.updateProof({ ...publicCapsule, unreviewedPrivateField: 'SENSITIVE_PRIVATE_MARKER' });
  assert.equal(run().pending[0].reason, 'cdn-public-shape-invalid');
  f.updateProof(publicCapsule);
  proof.package.unreviewedPrivateField = 'SENSITIVE_PRIVATE_MARKER';
  assert.equal(run().pending[0].reason, 'cdn-public-shape-invalid');
  delete proof.package.unreviewedPrivateField;
  proof.package.manifests[0].unreviewedPrivateField = 'SENSITIVE_PRIVATE_MARKER';
  assert.equal(run().pending[0].reason, 'cdn-public-shape-invalid');
  delete proof.package.manifests[0].unreviewedPrivateField;
  proof.facts[0].unreviewedPrivateField = 'SENSITIVE_PRIVATE_MARKER';
  assert.equal(run().pending[0].reason, 'cdn-public-shape-invalid');
  delete proof.facts[0].unreviewedPrivateField;
  assert.equal(initial.receiptChanges.length, 1);
  assert.ok(!initial.changes[0].after.includes(privateRoot));
  assert.ok(!initial.changes[0].after.includes('private-bundle.json'));
  assert.ok(!initial.changes[0].after.includes('inline:0'));
  const originalFacts = proof.facts,
    originalBindings = privateSpec.factBindings;
  const inputValue = runs[0].input.contextSha256;
  proof.facts = [
    {
      id: 'status',
      pointer: '/captures/0/behaviorFacts/status',
      sha256: hashJson(inputValue),
      replicatedPointers: ['/captures/0/behaviorFacts/status', '/captures/1/behaviorFacts/status'],
    },
  ];
  privateSpec.factBindings = [
    { id: 'status', pointers: ['/runs/0/input/contextSha256', '/runs/1/input/contextSha256'] },
  ];
  f.updateProof({
    package: pkg,
    captures: runs.map((item) => ({ receiptSha256: item.receiptSha256, behaviorFacts: { status: inputValue } })),
  });
  assert.equal(run().pending[0].reason, 'cdn-private-fact-mismatch');
  proof.facts = originalFacts;
  privateSpec.factBindings = originalBindings;
  f.updateProof({
    package: pkg,
    captures: runs.map((item) => ({ receiptSha256: item.receiptSha256, behaviorFacts: { status: 3 } })),
  });

  const closure = privateSpec.producerClosureWitnesses;
  privateSpec.producerClosureWitnesses = [];
  assert.equal(run().pending[0].reason, 'cdn-producer-closure-required');
  privateSpec.producerClosureWitnesses = closure;
  fs.appendFileSync(path.join(privateRoot, 'producer-helper.js'), 'x');
  assert.equal(run().pending[0].reason, 'cdn-executed-bytes-mismatch');
  fs.writeFileSync(path.join(privateRoot, 'producer-helper.js'), helperSource);
  fs.appendFileSync(path.join(privateRoot, 'context.bin'), 'x');
  assert.equal(run().pending[0].reason, 'cdn-context-bytes-mismatch');
  fs.writeFileSync(path.join(privateRoot, 'context.bin'), 'context');
  const savedAssets = privateSpec.assetWitnesses;
  privateSpec.assetWitnesses = savedAssets.slice(0, 1);
  assert.equal(run().pending[0].reason, 'cdn-executed-bytes-required');
  privateSpec.assetWitnesses = savedAssets;
  fs.appendFileSync(path.join(privateRoot, 'inline.js'), 'x');
  assert.equal(run().pending[0].reason, 'cdn-executed-bytes-mismatch');
  fs.writeFileSync(path.join(privateRoot, 'inline.js'), 'inline');
  const saved = privateSpec.sourceCaptureWitnesses;
  delete privateSpec.sourceCaptureWitnesses;
  assert.equal(run().pending[0].reason, 'cdn-independent-witnesses-required');
  privateSpec.sourceCaptureWitnesses = saved;
  privateSpec.runWitnesses.reverse();
  assert.equal(run().pending[0].reason, 'cdn-witness-mismatch');
  privateSpec.runWitnesses.reverse();
  proof.capturePointers.reverse();
  assert.equal(run().pending[0].reason, 'cdn-public-shape-invalid');
  proof.capturePointers.reverse();
  fs.appendFileSync(path.join(privateRoot, captures[0].path), ' ');
  assert.equal(run().pending[0].reason, 'cdn-source-capture-mismatch');
  fs.writeFileSync(
    path.join(privateRoot, captures[0].path),
    JSON.stringify({
      id: runs[0].id,
      producerSha256: runs[0].producerSha256,
      inputSha256: runs[0].inputSha256,
      input: runs[0].input,
      result: Object.fromEntries(Object.entries(runs[0].result).filter(([key]) => key !== 'sourceCaptureSha256')),
    }),
  );
  const testFile = path.join(f.root, 'sample.test.mjs');
  fs.appendFileSync(testFile, '// concurrent edit\n');
  assert.throws(() => writeParityQualification(initial, { root: f.root }), /source-changed-before-write/);
  assert.equal(fs.existsSync(path.join(f.root, 'public-receipt.json')), false);
  fs.writeFileSync(testFile, initial.changes[0].before);
  const receiptFile = path.join(f.root, 'public-receipt.json');
  fs.writeFileSync(receiptFile, 'unrelated existing data');
  assert.throws(() => writeParityQualification(initial, { root: f.root }), /cdn-receipt-changed-before-write/);
  assert.equal(fs.readFileSync(receiptFile, 'utf8'), 'unrelated existing data');
  fs.unlinkSync(receiptFile);
  writeParityQualification(initial, { root: f.root });
  f.updateCurrent(fs.readFileSync(testFile, 'utf8'));
  const idempotent = run();
  assert.deepEqual(idempotent.pending, []);
  assert.equal(idempotent.receiptChanges.length, 0);
  assert.equal(idempotent.changes.length, 0);
  assert.ok(!initial.receiptChanges[0].after.includes(privateRoot));
  assert.ok(!initial.receiptChanges[0].after.includes('inline:0'));
  fs.rmSync(privateRoot, { recursive: true, force: true });
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), initial.changes[0].bindings);
  const written = fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8');
  f.updateCurrent(written);
  f.manifest.files[0].guarantees[0].proofs[0] = initial.changes[0].bindings[0].proofs[0];
  assert.equal(f.run().pending[0].reason, 'cdn-private-evidence-root-required');
});

test('proven generated fixture input is inferred, source-bound, and cannot hide unrelated filesystem reads', (t) => {
  const text = `// @test-kind unproven: invented generated fixture for tooling.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeTemporaryDirectory } from './owned.mjs';
import { render } from './sut.mjs';
async function fixture(t, files) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return dir;
}
const standard = { 'site.yml': 'invented', 'page/index.html': 'example' };
test('example', async (t) => {
  const dir = await fixture(t, standard);
  assert.equal(typeof dir, 'string');
});

test('other', async (t) => {
  const dir = await fixture(t, { ...standard, 'extra.txt': 'extra' });
  await render(dir);
  await fs.readFile(path.join(dir, 'extra.txt'), 'utf8');
});`;
  const f = partial(fixture(t, text), [[0]]);
  const helper = fs.readFileSync(new URL('../mirage/testing/owned-fixture.mjs', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(f.root, 'owned.mjs'), helper);
  f.manifest.files[0].importRoles = [
    {
      source: './owned.mjs',
      role: 'test-input',
      reviewedBy: 'tooling-author',
      reason: 'Invented fixture allocator is a pinned test input.',
    },
    {
      source: './sut.mjs',
      role: 'implementation-under-test',
      reviewedBy: 'tooling-author',
      reason: 'Invented renderer is the implementation under test.',
    },
  ];
  const baseline = (file) => (file === 'sample.test.mjs' ? text : helper);
  const run = () => qualifyParityManifest(f.manifest, { root: f.root, readBaseline: baseline });
  const report = run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.changes[0].bindings[0].generatedFixtures[0].entries.length, 2);
  writeParityQualification(report, { root: f.root });
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
  const guarded = fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8');
  assert.ok(report.changes[0].bindings[0].isolationRegistrationsAstSha256);
  for (const altered of [
    guarded.replace('await render(dir);', 'await render(dir); process.exitCode = 1;'),
    guarded.replace("test('other',", "test('renamed other',"),
    guarded + "\ntest('added', () => {});\n",
    guarded +
      "\ntest('parity source bindings 0123456789abcdef', () => { __paqParitySourceBindings(import.meta.url, process.exitCode = 1); });\n",
  ]) {
    f.updateCurrent(altered);
    assert.throws(
      () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings),
      /changed-isolation-registrations/,
    );
  }
  f.updateCurrent(guarded);
  fs.appendFileSync(path.join(f.root, 'owned.mjs'), '\n');
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings),
    /changed-test-input-dependency/,
  );
  fs.writeFileSync(path.join(f.root, 'owned.mjs'), helper);
  f.updateCurrent(
    text.replace("test('example'", "async function other() { return fs.readFile('/outside'); }\ntest('example'"),
  );
  assert.ok(run().pending.length);
});

test('reviewed isolated fixture-slice changes retain exact selected source and pin every registration', async (t) => {
  const text = `// @test-kind unproven: invented isolated fixture tooling.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { makeTemporaryDirectory } from './owned.mjs'; import { render, importer } from './sut.mjs';
const files = { 'site.yml': 'x' };
async function fixturePortal(t, extra = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ ...files, ...extra })) {
    const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  return importer(dir);
}
async function setup(t, options = {}, extraFiles = {}) { return fixturePortal(t, extraFiles); }
function plain() { const renderer = render({ templates: {} }); return (source, data = {}) => renderer.renderString(source, data); }
test('example', async () => { const view = plain(); assert.equal(await view('x'), 'y'); });
test('other', async (t) => { await setup(t, {}, { 'other.txt': 'x' }); assert.equal(1, 1); });
test('later', async () => { const { value } = await import('./late.mjs'); assert.equal(value, 1); });`;
  const f = fixture(t, text);
  const helper = fs.readFileSync(new URL('../mirage/testing/owned-fixture.mjs', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(f.root, 'owned.mjs'), helper);
  fs.writeFileSync(
    path.join(f.root, 'sut.mjs'),
    `export function render() { return { async renderString(source) { if (source === 'x' && globalThis.__lateEffect) throw Error('late import ran too early'); return source === 'x' ? 'y' : 'b'; } }; } export async function importer() { return {}; }`,
  );
  fs.writeFileSync(path.join(f.root, 'late.mjs'), 'globalThis.__lateEffect = true; export const value = 1;');
  f.manifest.files[0].importRoles = [
    {
      source: './owned.mjs',
      role: 'test-input',
      reviewedBy: 'tooling-author',
      reason: 'Pinned invented owned fixture allocator.',
    },
    {
      source: './sut.mjs',
      role: 'implementation-under-test',
      reviewedBy: 'tooling-author',
      reason: 'Invented renderer and importer under test.',
    },
  ];
  const changed =
    text.replace('assert.equal(1, 1);', 'assert.equal(2, 2);') +
    "\ntest('added', async () => { const view = plain(); assert.equal(await view('a'), 'b'); });\n";
  f.updateCurrent(changed);
  const old = describeParitySource(text, 'sample.test.mjs'),
    current = describeParitySource(changed, 'sample.test.mjs');
  const originalOther = old.registrations.find((row) => row.title === 'other'),
    currentOther = current.registrations.find((row) => row.title === 'other'),
    added = current.registrations.find((row) => row.title === 'added');
  const late = old.registrations.find((row) => row.title === 'later'),
    lateImport = late.callback.body.body[0].declarations[0].init.argument;
  f.manifest.files[0].lateImports = [
    {
      baselineId: late.id,
      importAstSha256: parityAstHash(lateImport),
      source: './late.mjs',
      role: 'post-selected-isolated',
      reviewedBy: 'tooling-author',
      reason: 'The sequential later test completes after the selected assertion.',
    },
  ];
  const reviewed = { reviewedBy: 'tooling-author', reason: 'Invented fixture slice is independently isolated.' };
  f.manifest.files[0].moduleReview = {
    ...reviewed,
    corrections: [],
    addedTests: [
      {
        ...reviewed,
        titleExpressionSha256: added.titleExpressionSha256,
        bodyAstSha256: parityAstHash(added.callback.body),
        zeroOriginalCredit: true,
        interactionReviewed: true,
      },
    ],
    isolatedRegistrationChanges: [
      {
        ...reviewed,
        titleExpressionSha256: originalOther.titleExpressionSha256,
        oldBodyAstSha256: parityAstHash(originalOther.callback.body),
        currentBodyAstSha256: parityAstHash(currentOther.callback.body),
        zeroSelectedCredit: true,
      },
    ],
    isolatedDeclarations: [],
  };
  const readBaseline = (file) => (file === 'sample.test.mjs' ? text : helper);
  const run = () => qualifyParityManifest(f.manifest, { root: f.root, readBaseline });
  const lateReview = f.manifest.files[0].lateImports;
  delete f.manifest.files[0].lateImports;
  assert.equal(run().pending[0].reason, 'dynamic-import-input-unsupported');
  f.manifest.files[0].lateImports = lateReview;
  const report = run();
  assert.deepEqual(report.pending, []);
  assert.ok(report.changes[0].bindings[0].isolationRegistrationsAstSha256);
  assert.equal(report.newOriginalDefinitions, 1);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    guarded = fs.readFileSync(file, 'utf8');
  const legacy = structuredClone(report.changes[0].bindings[0]);
  delete legacy.moduleContextAstSha256;
  delete legacy.originalGuardHashes;
  delete legacy.importRoles;
  delete legacy.inputDependencies;
  const legacySource = guarded.replace(JSON.stringify(report.changes[0].bindings), JSON.stringify([legacy]));
  assert.notEqual(legacySource, guarded);
  f.updateCurrent(legacySource);
  const migration = run();
  assert.deepEqual(migration.pending, []);
  assert.equal(migration.newOriginalDefinitions, 0);
  assert.equal(migration.newExpandedOriginalCases, 0);
  assert.equal(migration.files[0].proofBindingTestsAdded, 0);
  assert.deepEqual(migration.changes[0].bindings[0].proofs, legacy.proofs);
  const tamperedLegacy = structuredClone(legacy);
  tamperedLegacy.originalAssertions[0] = 'f'.repeat(64);
  f.updateCurrent(guarded.replace(JSON.stringify(report.changes[0].bindings), JSON.stringify([tamperedLegacy])));
  assert.equal(run().pending[0].reason, 'legacy-original-body-mismatch');
  const formatted = await format(guarded, { parser: 'babel', singleQuote: true });
  f.updateCurrent(formatted);
  const rerun = run();
  assert.deepEqual(rerun.pending, []);
  assert.equal(rerun.changes.length, 0);
  assert.equal(rerun.newOriginalDefinitions, 0);
  assert.equal(rerun.newExpandedOriginalCases, 0);
  f.updateCurrent(guarded);
  const { spawnSync } = await import('node:child_process');
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const execution = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], {
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  assert.ok(execution.stdout.indexOf('example') < execution.stdout.indexOf('later'));
  fs.writeFileSync(file, guarded.replace('assert.equal(2, 2)', 'assert.equal(2, 3)'));
  assert.throws(
    () => assertParityBindings(pathToFileURL(file), report.changes[0].bindings),
    /changed-isolation-registrations/,
  );
  const lateText =
    "test('later', async () => { const { value } = await import('./late.mjs'); assert.equal(value, 1); });";
  const reordered = guarded.replace(lateText, '').replace("test('example'", `${lateText}\ntest('example'`);
  assert.notEqual(reordered, guarded);
  fs.writeFileSync(file, reordered);
  assert.throws(
    () => assertParityBindings(pathToFileURL(file), report.changes[0].bindings),
    /changed-isolation-registrations/,
  );
  f.updateCurrent(changed.replace(lateText, '').replace("test('example'", `${lateText}\ntest('example'`));
  assert.ok(run().pending.length);
  f.updateCurrent(
    changed.replace(
      "const view = plain(); assert.equal(await view('x')",
      "const view = plain(); await fs.readFile('/outside'); assert.equal(await view('x')",
    ),
  );
  assert.ok(run().pending.length);
  f.updateCurrent(
    changed
      .replace('const files =', 'const shared = []; const files =')
      .replace('await setup(t, {},', "shared.push('changed'); await setup(t, {},"),
  );
  assert.ok(run().pending.length);
});

test('an existing fixture-slice whole guard coexists with a different new partial region', (t) => {
  const text = `// @test-kind unproven: invented fixture-slice coexistence tooling.
import test from 'node:test'; import assert from 'node:assert/strict';
import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path';
import { makeTemporaryDirectory } from './owned.mjs'; import { render, importer } from './sut.mjs';
const files = { 'site.yml': 'x' };
async function fixturePortal(t, extra = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'invented-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries({ ...files, ...extra })) {
    const file = path.join(dir, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  return importer(dir);
}
function plain() { const renderer = render({ templates: {} }); return (source, data = {}) => renderer.renderString(source, data); }
test('example', async () => { const view = plain(); assert.equal(await view('x'), 'y'); });
test('second', async () => { const view = plain(); assert.equal(await view('a'), 'b'); assert.equal(await view('c'), 'd'); });
test('third', async () => { const view = plain(); assert.equal(await view('e'), 'f'); });
test('fixture-user', async (t) => { await fixturePortal(t); assert.equal(1, 1); });`;
  const f = fixture(t, text),
    helper = fs.readFileSync(new URL('../mirage/testing/owned-fixture.mjs', import.meta.url), 'utf8');
  fs.writeFileSync(path.join(f.root, 'owned.mjs'), helper);
  f.manifest.files[0].importRoles = [
    {
      source: './owned.mjs',
      role: 'test-input',
      reviewedBy: 'tooling-author',
      reason: 'Invented fixture allocator is pinned.',
    },
    {
      source: './sut.mjs',
      role: 'implementation-under-test',
      reviewedBy: 'tooling-author',
      reason: 'Invented renderer and importer are under test.',
    },
  ];
  const readBaseline = (file) => (file === 'sample.test.mjs' ? text : helper);
  const run = () => qualifyParityManifest(f.manifest, { root: f.root, readBaseline });
  const first = run();
  assert.deepEqual(first.pending, []);
  writeParityQualification(first, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    guarded = fs.readFileSync(file, 'utf8');
  f.updateCurrent(guarded);
  const row = describeParitySource(text, 'sample.test.mjs').registrations.find((item) => item.title === 'second');
  f.manifest.files[0].guarantees[0].tests = [
    {
      baselineId: row.id,
      titleExpressionSha256: row.titleExpressionSha256,
      regions: [{ assertions: [{ sha256: row.assertions[0].sha256, factIds: ['status'] }] }],
      caseUniverse: {
        count: 1,
        cases: [row.title],
        casesSha256: hashJson([row.title]),
        sourceBindings: [],
        ancestorLoops: [],
      },
    },
  ];
  const next = run();
  assert.deepEqual(next.pending, []);
  assert.equal(next.files[0].partialRegions, 1);
  writeParityQualification(next, { root: f.root });
  const firstPartial = fs.readFileSync(file, 'utf8');
  f.updateCurrent(firstPartial);
  const third = describeParitySource(text, 'sample.test.mjs').registrations.find((item) => item.title === 'third');
  f.manifest.files[0].guarantees[0].tests.push({
    baselineId: third.id,
    titleExpressionSha256: third.titleExpressionSha256,
    regions: [{ assertions: [{ sha256: third.assertions[0].sha256, factIds: ['status'] }] }],
    caseUniverse: {
      count: 1,
      cases: [third.title],
      casesSha256: hashJson([third.title]),
      sourceBindings: [],
      ancestorLoops: [],
    },
  });
  const both = run();
  assert.deepEqual(both.pending, []);
  assert.equal(both.files[0].partialRegions, 2);
  assert.ok(both.changes[0].after.includes('second'));
  const combined = both.changes[0].after;
  const top = describeParitySource(combined).ast.body.find(
    (statement) =>
      statement.type === 'ExpressionStatement' && statement.expression?.callee?.name === '__paqParityBindings',
  ).expression;
  const entries = top.arguments[1].elements;
  assert.equal(entries.length, 2);
  const missingDescriptor = combined.slice(0, entries[0].range[0]) + combined.slice(entries[1].range[0]);
  f.updateCurrent(missingDescriptor);
  assert.throws(
    () => assertParityBindings(pathToFileURL(file), both.changes[0].bindings),
    /changed-region-module-bindings/u,
  );
  f.updateCurrent(
    firstPartial.replace(
      "const view = plain(); assert.equal(await view('e'), 'f')",
      "const view = plain(); process.env.INVENTED; assert.equal(await view('e'), 'f')",
    ),
  );
  assert.ok(run().pending.length);
  f.updateCurrent(guarded.replace("await view('x'), 'y'", "await view('x'), 'z'"));
  assert.ok(run().pending.length);
  f.updateCurrent(
    guarded.replace('await fixturePortal(t); assert.equal(1, 1)', 'await fixturePortal(t); assert.equal(1, 2)'),
  );
  assert.ok(run().pending.length);
  const guardedRow = describeParitySource(guarded).registrations.find((item) => item.title === 'example');
  const [firstStatement, secondStatement] = guardedRow.callback.body.body;
  const moved =
    guarded.slice(0, firstStatement.range[0]) +
    guarded.slice(...secondStatement.range) +
    '\n' +
    guarded.slice(...firstStatement.range) +
    guarded.slice(secondStatement.range[1]);
  f.updateCurrent(moved);
  assert.ok(run().pending.length);
  f.updateCurrent(guarded);
  fs.writeFileSync(f.proofFile, JSON.stringify({ ...f.capsule, facts: { status: 201 } }));
  assert.ok(run().pending.length);
});

test('memory renderer migration pins newly added public proof reads and rejects omissions or mutations', (t) => {
  const text = `// @test-kind unproven: invented memory renderer isolation tooling.
import test from 'node:test'; import assert from 'node:assert/strict';
import { createRenderer } from './sut.mjs';
function renderer(observed, options = {}) { return createRenderer({ templates: {}, settings: { 'invented/key': '2' }, pages: [], observed }, options); }
test('example', async () => { const engine = renderer({ mode: 'observed' }); assert.equal(await engine.renderString('one'), 'result'); });
test('other', async () => { const engine = renderer({ mode: 'observed' }); assert.equal(await engine.renderString('other'), 'result'); });`;
  const f = fixture(t, text),
    old = describeParitySource(text, 'sample.test.mjs');
  const changed = text
    .replace('import { createRenderer }', "import { readFileSync } from 'node:fs'; import { createRenderer }")
    .replace(
      "test('other', async () => {",
      "test('other', async () => { const bytes = readFileSync(new URL('./evidence.json', import.meta.url)); assert.equal(bytes.length, 1);",
    );
  f.updateCurrent(changed);
  fs.writeFileSync(path.join(f.root, 'evidence.json'), 'x');
  f.manifest.files[0].importRoles = [
    {
      source: './sut.mjs',
      role: 'implementation-under-test',
      reviewedBy: 'tooling-author',
      reason: 'Invented fresh renderer is the implementation under test.',
    },
  ];
  const current = describeParitySource(changed, 'sample.test.mjs'),
    before = old.registrations.find((row) => row.title === 'other'),
    after = current.registrations.find((row) => row.title === 'other'),
    read = after.callback.body.body[0].declarations[0].init,
    declaration = current.ast.body.find((node) => node.type === 'ImportDeclaration' && node.source.value === 'node:fs');
  const review = {
    reviewedBy: 'tooling-author',
    reason: 'Invented unrelated proof input remains isolated.',
    zeroSelectedCredit: true,
  };
  f.manifest.files[0].moduleReview = {
    reviewedBy: review.reviewedBy,
    reason: review.reason,
    corrections: [],
    addedTests: [],
    isolatedRegistrationChanges: [
      {
        ...review,
        titleExpressionSha256: before.titleExpressionSha256,
        oldBodyAstSha256: parityAstHash(before.callback.body),
        currentBodyAstSha256: parityAstHash(after.callback.body),
      },
    ],
    isolatedDeclarations: [{ ...review, astSha256: parityAstHash(declaration) }],
  };
  f.manifest.files[0].additionalInputDependencies = [
    {
      path: 'evidence.json',
      sha256: parityHash('x'),
      readAstSha256: parityAstHash(read),
      reviewedBy: 'tooling-author',
      reason: 'Exact invented proof input bytes are pinned.',
    },
  ];
  const originalId = f.spec.baselineId;
  f.spec.baselineId = originalId.replace(/:\d+:\d+$/u, ':999:0');
  assert.equal(f.run().pending[0].reason, 'stale-baseline-id');
  f.spec.baselineId = originalId;
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.ok(report.changes[0].bindings[0].inputDependencies.some((item) => item.path === 'evidence.json'));
  assert.deepEqual(
    report.changes[0].bindings[0].additionalInputDependencies,
    f.manifest.files[0].additionalInputDependencies,
  );
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  fs.writeFileSync(path.join(f.root, 'evidence.json'), 'y');
  assert.throws(
    () => assertParityBindings(pathToFileURL(file), report.changes[0].bindings),
    /changed-test-input-dependency/,
  );
  fs.writeFileSync(path.join(f.root, 'evidence.json'), 'x');
  f.updateCurrent(changed);
  f.manifest.files[0].additionalInputDependencies = [];
  assert.equal(f.run().pending[0].reason, 'invalid-added-input-review');
  const privateText = changed.replace('./evidence.json', './.private.json');
  f.updateCurrent(privateText);
  fs.writeFileSync(path.join(f.root, '.private.json'), 'x');
  const privateRow = describeParitySource(privateText).registrations.find((row) => row.title === 'other');
  f.manifest.files[0].moduleReview.isolatedRegistrationChanges[0].currentBodyAstSha256 = parityAstHash(
    privateRow.callback.body,
  );
  f.manifest.files[0].additionalInputDependencies = [
    {
      path: '.private.json',
      sha256: parityHash('x'),
      readAstSha256: parityAstHash(privateRow.callback.body.body[0].declarations[0].init),
      reviewedBy: 'tooling-author',
      reason: 'Invented private input must never be accepted.',
    },
  ];
  assert.equal(f.run().pending[0].reason, 'cdn-public-path-required');
  const shadowText = changed.replace(
    "readFileSync(new URL('./evidence.json', import.meta.url))",
    "((URL) => readFileSync(new URL('./evidence.json', import.meta.url)))((value) => value)",
  );
  f.updateCurrent(shadowText);
  const shadowRow = describeParitySource(shadowText).registrations.find((row) => row.title === 'other');
  f.manifest.files[0].moduleReview.isolatedRegistrationChanges[0].currentBodyAstSha256 = parityAstHash(
    shadowRow.callback.body,
  );
  const shadowRead = shadowRow.callback.body.body[0].declarations[0].init.callee.body;
  f.manifest.files[0].additionalInputDependencies = [
    {
      path: 'evidence.json',
      sha256: parityHash('x'),
      readAstSha256: parityAstHash(shadowRead),
      reviewedBy: 'tooling-author',
      reason: 'Shadowed URL must never be accepted.',
    },
  ];
  assert.equal(f.run().pending[0].reason, 'unsupported-added-input-read');
});

test('memory context certificates remain mandatory when both generated copies are removed', (t) => {
  const text = `// @test-kind unproven: invented memory context fixture.
import test from 'node:test'; import assert from 'node:assert/strict'; import { createPortalRenderer } from './sut.mjs';
function renderer(observed, options = {}) { return createPortalRenderer({ templates: {}, settings: { 'invented/key': '2' }, pages: [], observed }, options); }
test('example', async () => { const engine = renderer({ mode: 'observed' }); assert.equal(await engine.renderString('one'), 'result'); });
test('context', async () => { const engine = renderer({ mode: 'observed' }); const context = engine.contextForPage({ id: 'fixed' }, '/'); assert.equal(await engine.renderString('previous', context), 'result'); assert.equal(await engine.renderString('target'), 'result'); });`;
  const f = fixture(t, text),
    model = describeParitySource(text, 'sample.test.mjs');
  f.manifest.files[0].importRoles = [
    {
      source: './sut.mjs',
      role: 'implementation-under-test',
      reviewedBy: 'tooling-author',
      reason: 'Invented renderer is the implementation under test.',
    },
  ];
  const makeSpec = (row, assertion) => ({
    baselineId: row.id,
    titleExpressionSha256: row.titleExpressionSha256,
    regions: [{ assertions: [{ sha256: assertion.sha256, factIds: ['status'] }] }],
    caseUniverse: {
      count: 1,
      cases: [row.title],
      casesSha256: hashJson([row.title]),
      sourceBindings: [],
      ancestorLoops: [],
    },
  });
  const [anchor, context] = model.registrations;
  f.manifest.files[0].guarantees[0].tests = [makeSpec(anchor, anchor.assertions[0])];
  const first = f.run();
  assert.deepEqual(first.pending, []);
  writeParityQualification(first, { root: f.root });
  f.updateCurrent(fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8'));
  f.manifest.files[0].guarantees[0].tests.push(makeSpec(context, context.assertions[1]));
  const report = f.run();
  assert.deepEqual(report.pending, []);
  const generated = report.changes[0].after,
    ast = describeParitySource(generated).ast,
    edits = [];
  function visit(node) {
    if (
      node?.type === 'CallExpression' &&
      ['__paqParityBindings', '__paqParityAssertions'].includes(node.callee?.name)
    ) {
      const data = node.arguments[1];
      const bindings = JSON.parse(generated.slice(...data.range));
      if (bindings.some((item) => item.memoryContextCertificates)) {
        for (const item of bindings) delete item.memoryContextCertificates;
        edits.push({ start: data.range[0], end: data.range[1], text: JSON.stringify(bindings) });
      }
    }
    for (const value of Object.values(node ?? {}))
      for (const child of Array.isArray(value) ? value : [value]) if (child?.type) visit(child);
  }
  visit(ast);
  assert.equal(edits.length, 2);
  let tampered = generated;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    tampered = tampered.slice(0, edit.start) + edit.text + tampered.slice(edit.end);
  f.updateCurrent(tampered);
  const bindings = structuredClone(report.changes[0].bindings);
  for (const item of bindings) delete item.memoryContextCertificates;
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), bindings),
    /memory-context-certificate-required/u,
  );
});

test('source inventory retains concise callback registration and its original assertion', () => {
  const text = source.replace('() => {\n  assert.equal(1, 1);\n}', '() => assert.equal(1, 1)');
  const model = describeParitySource(text, 'sample.test.mjs');
  assert.equal(model.registrations.length, 1);
  assert.equal(model.registrations[0].callback.body.type, 'CallExpression');
  assert.equal(model.registrations[0].assertions.length, 1);
});

test('concise synchronous and asynchronous callbacks preserve their return expression when qualified', async (t) => {
  const { spawnSync } = await import('node:child_process');
  for (const asyncPrefix of ['', 'async ']) {
    const text = source.replace('() => {\n  assert.equal(1, 1);\n}', `${asyncPrefix}() => assert.equal(1, 1)`);
    const f = fixture(t, text),
      report = f.run();
    assert.deepEqual(report.pending, []);
    writeParityQualification(report, { root: f.root });
    const written = fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8');
    assert.match(written, /return assert\.equal\(1, 1\);/);
    assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), report.changes[0].bindings);
    const execution = spawnSync(process.execPath, ['--test', path.join(f.root, 'sample.test.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  }
});

test('a concise partial region preserves parent kind and returns the original expression', (t) => {
  const text = source.replace('() => {\n  assert.equal(1, 1);\n}', '() => assert.equal(1, 1)');
  const f = partial(fixture(t, text), [[0]]),
    report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 0);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    written = fs.readFileSync(file, 'utf8');
  assert.match(written, /return assert\.equal\(1, 1\);/);
  assert.equal(describeParitySource(written).registrations[0].kinds[0], 'unproven');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  f.updateCurrent(written);
  const repeated = f.run();
  assert.deepEqual(repeated.pending, []);
  assert.equal(repeated.changes.length, 0);
});

test('concise tuple generators retain exact literal cases and original returned assertions', async (t) => {
  const text = `// @test-kind unproven: invented concise tuple matrix for tooling.
import test from 'node:test';
import assert from 'node:assert/strict';
const cases = [['first', -1], ['second', {Value: 2}]];
for (const [name, expected] of cases) {
  test(\`case \${name}\`, () => assert.deepEqual(expected, expected));
}
test('diagnostic', () => assert.equal(cases.length, 2));`;
  const f = fixture(t, text),
    model = describeParitySource(text, 'sample.test.mjs'),
    row = model.registrations[0];
  f.spec.caseUniverse = {
    count: 2,
    cases: ['case first', 'case second'],
    casesSha256: hashJson(['case first', 'case second']),
    caseBindings: [
      { name: 'first', expected: -1 },
      { name: 'second', expected: { Value: 2 } },
    ],
    ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
    sourceBindings: [{ name: 'cases', initializerAstSha256: model.declarations[0].initializerAstSha256 }],
  };
  f.spec.caseFacts = [0, 1].map((caseIndex) => ({ caseIndex, assertionIndex: 0, factIds: ['status'] }));
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.expandedOriginalCases, 2);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  assertParityBindingsFromSource(pathToFileURL(file));
  const { spawnSync } = await import('node:child_process');
  const execution = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
});

test('parenthesized and awaited concise expressions survive formatting and cumulative reruns', async (t) => {
  for (const expression of ['() => ((assert.equal(1, 1)))', 'async () => (await assert.equal(1, 1))']) {
    const text = source.replace('() => {\n  assert.equal(1, 1);\n}', expression);
    const f = partial(fixture(t, text), [[0]]),
      report = f.run();
    assert.deepEqual(report.pending, []);
    writeParityQualification(report, { root: f.root });
    const file = path.join(f.root, 'sample.test.mjs');
    const formatted = await format(fs.readFileSync(file, 'utf8'), { parser: 'babel', singleQuote: true });
    fs.writeFileSync(file, formatted);
    assert.deepEqual(describeParitySource(formatted).tags.errors, []);
    assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
    f.updateCurrent(formatted);
    const repeated = f.run();
    assert.deepEqual(repeated.pending, []);
    assert.equal(repeated.changes.length, 0);
  }
});

test('original assertion callbacks remain inline but nested assertions stay unproven', async (t) => {
  const text = source.replace('assert.equal(1, 1)', "assert.throws(() => { throw new Error('fixture'); }, /fixture/)");
  const f = partial(fixture(t, text), [[0]]),
    report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  const { spawnSync } = await import('node:child_process');
  const execution = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  const nested = source.replace('assert.equal(1, 1)', 'assert.throws(() => { assert.equal(1, 2); })');
  assert.equal(partial(fixture(t, nested), [[0]]).run().pending[0].reason, 'nested-assertion-region-unsupported');
});

test('unrecognized proof metadata is never copied into generated source', (t) => {
  const f = fixture(t),
    proof = f.manifest.files[0].guarantees[0].proofs[0];
  proof.privateNote = 'SENSITIVE_PRIVATE_MARKER';
  proof.facts[0].privateNote = 'SENSITIVE_PRIVATE_MARKER';
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.ok(!report.changes[0].after.includes('SENSITIVE_PRIVATE_MARKER'));
});

test('nested assertion callbacks cannot hide dynamic code or registrations', (t) => {
  for (const inner of ["new Function('return 1')()", "test('nested', () => {})"]) {
    const text = source.replace('assert.equal(1, 1)', `assert.throws(() => { ${inner}; })`);
    const f = partial(fixture(t, text), [[0]]);
    assert.equal(f.run().pending[0].reason, 'nested-control-region-unsupported');
  }
});

test('whole tests can bind every case of a literal assertion loop without adding registrations', async (t) => {
  const text = source.replace(
    '  assert.equal(1, 1);',
    `  for (const [actual, expected] of [[1, 1], [2, 2]]) {
    assert.equal(actual, expected);
  }`,
  );
  const f = fixture(t, text),
    model = describeParitySource(text, 'sample.test.mjs'),
    row = model.registrations[0];
  const loop = row.callback.body.body[0],
    bindings = [
      { actual: 1, expected: 1 },
      { actual: 2, expected: 2 },
    ];
  f.spec.assertionLoops = [
    {
      assertionSha256: row.assertions[0].sha256,
      loopAstSha256: parityAstHash(loop),
      caseBindings: bindings,
      caseBindingsSha256: hashJson(bindings),
      caseFacts: [0, 1].map((innerCaseIndex) => ({ outerCaseIndex: 0, innerCaseIndex, factIds: ['status'] })),
    },
  ];
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.originalDefinitions, 1);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  assertParityBindings(pathToFileURL(file), report.changes[0].bindings);
  const { spawnSync } = await import('node:child_process');
  const execution = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  f.spec.assertionLoops[0].caseFacts.pop();
  f.updateCurrent(text);
  assert.equal(f.run().pending[0].reason, 'assertion-loop-facts-required');
});

test('internal assertion loops reject early exits and unproven case mappings', (t) => {
  const text = source.replace(
    '  assert.equal(1, 1);',
    `  for (const value of [1, 2]) {
    if (value === 1) break;
    assert.equal(value, value);
  }`,
  );
  const f = fixture(t, text),
    row = describeParitySource(text, 'sample.test.mjs').registrations[0],
    loop = row.callback.body.body[0];
  const cases = [{ value: 1 }, { value: 2 }];
  f.spec.assertionLoops = [
    {
      assertionSha256: row.assertions[0].sha256,
      loopAstSha256: parityAstHash(loop),
      caseBindings: cases,
      caseBindingsSha256: hashJson(cases),
      caseFacts: [0, 1].map((innerCaseIndex) => ({ outerCaseIndex: 0, innerCaseIndex, factIds: ['status'] })),
    },
  ];
  assert.equal(f.run().pending[0].reason, 'unsupported-assertion-loop');
});

test('reviewed fixture-matrix corrections retain every original case and exact producer input', async (t) => {
  const text = `// @test-kind unproven: invented corrected matrix for tooling.
import test from 'node:test';
import assert from 'node:assert/strict';
const cases = [
  ['first', 1], // original first case
  ['second', 1], // corrected second case
];
const actual = (name) => name === 'first' ? 1 : 2;
for (const [name, expected] of cases) {
  test(\`case \${name}\`, () => assert.equal(actual(name), expected));
}`;
  const f = fixture(t, text),
    before = describeParitySource(text, 'sample.test.mjs');
  const changed = text.replace("['second', 1]", "['second', 2]"),
    after = describeParitySource(changed, 'sample.test.mjs');
  f.updateCurrent(changed);
  const row = before.registrations[0],
    oldDecl = before.declarations.find((item) => item.name === 'cases'),
    newDecl = after.declarations.find((item) => item.name === 'cases');
  const oldBindings = [
      { name: 'first', expected: 1 },
      { name: 'second', expected: 1 },
    ],
    currentBindings = [
      { name: 'first', expected: 1 },
      { name: 'second', expected: 2 },
    ];
  f.spec.caseUniverse = {
    count: 2,
    cases: ['case first', 'case second'],
    casesSha256: hashJson(['case first', 'case second']),
    caseBindings: oldBindings,
    currentCaseBindings: currentBindings,
    currentCaseBindingsSha256: hashJson(currentBindings),
    ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
    sourceBindings: [{ name: 'cases', initializerAstSha256: oldDecl.initializerAstSha256 }],
  };
  f.spec.caseFacts = [0, 1].map((caseIndex) => ({ caseIndex, assertionIndex: 0, factIds: ['status'] }));
  f.manifest.files[0].moduleReview = {
    reviewedBy: 'tooling-author',
    reason: 'Invented matrix correction retains both original cases.',
    corrections: [],
    addedTests: [],
    fixtureCorrections: [
      {
        binding: 'cases',
        index: 1,
        oldAstSha256: parityAstHash(oldDecl.initializer.elements[1]),
        currentAstSha256: parityAstHash(newDecl.initializer.elements[1]),
        sameGuarantee: true,
        guaranteeId: 'invented-transport-status',
        factIds: ['status'],
        reviewedBy: 'tooling-author',
        reason: 'Invented repeated result proves the same second input.',
      },
    ],
  };
  const changedInput = changed.replace("['second', 2]", "['different', 2]");
  const changedInputModel = describeParitySource(changedInput, 'sample.test.mjs');
  const correction = f.manifest.files[0].moduleReview.fixtureCorrections[0];
  correction.currentAstSha256 = parityAstHash(
    changedInputModel.declarations.find((item) => item.name === 'cases').initializer.elements[1],
  );
  f.updateCurrent(changedInput);
  assert.equal(f.run().pending[0].reason, 'invalid-fixture-correction');
  correction.currentAstSha256 = parityAstHash(newDecl.initializer.elements[1]);
  f.updateCurrent(changed);
  const originalAssertions = f.spec.assertions;
  partial(f, [[0]]);
  f.spec.caseSelection = { selected: [{ caseIndex: 1, factIds: ['status'] }] };
  const partialReport = f.run();
  assert.deepEqual(partialReport.pending, []);
  assert.equal(partialReport.qualifiedOriginalCases, 1);
  assert.deepEqual(partialReport.changes[0].bindings[0].caseSelection.bindings, currentBindings);
  writeParityQualification(partialReport, { root: f.root });
  const formattedPartial = await format(fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8'), {
    parser: 'babel',
    singleQuote: true,
  });
  fs.writeFileSync(path.join(f.root, 'sample.test.mjs'), formattedPartial);
  assertParityBindings(pathToFileURL(path.join(f.root, 'sample.test.mjs')), partialReport.changes[0].bindings);
  f.updateCurrent(changed);
  f.spec.assertions = originalAssertions;
  delete f.spec.regions;
  delete f.spec.caseSelection;
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.expandedOriginalCases, 2);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs');
  assertParityBindingsFromSource(pathToFileURL(file));
  const { spawnSync } = await import('node:child_process');
  const execution = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  f.spec.caseUniverse.currentCaseBindings[1].expected = 99;
  f.updateCurrent(changed);
  assert.equal(f.run().pending[0].reason, 'corrected-case-bindings-mismatch');
});

test('official SQL OCI binding requires the reviewed registry manifest and capsule identity', (t) => {
  const f = fixture(t),
    bytes = fs.readFileSync(new URL('./fixtures/microsoft-sql-image-manifest.json', import.meta.url));
  const digest = parityHash(bytes),
    proof = f.manifest.files[0].guarantees[0].proofs[0];
  const pkg = {
    ecosystem: 'microsoft-oci',
    id: 'mssql/server',
    sha256: digest,
    source: `https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:${digest}`,
    bodyBase64: bytes.toString('base64'),
  };
  f.capsule.package = pkg;
  f.updateProof(f.capsule);
  proof.mode = 'official-package';
  proof.package = pkg;
  proof.packagePointer = '/package';
  assert.deepEqual(f.run().pending, []);
  proof.package = { ...pkg, source: 'https://example.com/manifest' };
  assert.equal(f.run().pending[0].reason, 'official-package-provenance-required');
  proof.package = pkg;
  f.capsule.package = { ...pkg, id: 'other' };
  f.updateProof(f.capsule);
  assert.equal(f.run().pending[0].reason, 'official-package-not-bound-to-receipt');
});

// @test-kind tooling: a block callback matrix preserves its assertion and rejects altered control flow and evidence markers.
test('block case regions preserve one direct assertion and reject source tampering', async (t) => {
  const text = loopSource.replace('[1, 2]', '[\n  1, // first\n  2, // unmatched\n  3, // third\n]');
  const { f, cases } = threeCasePartial(t, text);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  assert.equal(report.qualifiedOriginalCases, 2);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    generated = fs.readFileSync(file, 'utf8'),
    binding = report.changes[0].bindings;
  assertParityBindings(pathToFileURL(file), binding);
  const tags = parseTestKinds(generated),
    lines = generated.split(/\r?\n/u),
    lineOf = (fragment) => lines.findIndex((line) => line.includes(fragment)) + 1;
  assert.deepEqual(kindsAt(tags, lineOf('1, // first')), ['parity']);
  assert.deepEqual(kindsAt(tags, lineOf('2, // unmatched')), ['unproven']);
  assert.deepEqual(kindsAt(tags, lineOf('3, // third')), ['parity']);
  const { spawnSync } = await import('node:child_process');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const execution = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { encoding: 'utf8', env });
  assert.equal(execution.status, 0, execution.stdout + execution.stderr);
  for (const c of cases) assert.match(execution.stdout, new RegExp(c));
  f.updateCurrent(generated);
  let repeat = f.run();
  assert.deepEqual(repeat.pending, []);
  assert.equal(repeat.changes.length, 0);
  assert.equal(repeat.newQualifiedOriginalCases, 0);
  const secondProof = structuredClone(f.manifest.files[0].guarantees[0].proofs[0]);
  secondProof.path = 'proof-block-second.json';
  secondProof.facts[0].id = 'second-block-status';
  fs.copyFileSync(f.proofFile, path.join(f.root, secondProof.path));
  f.manifest.files[0].guarantees[0].proofs.push(secondProof);
  f.spec.caseSelection.selected = [
    { caseIndex: 0, factIds: ['status'] },
    { caseIndex: 1, factIds: ['second-block-status'] },
    { caseIndex: 2, factIds: ['status'] },
  ];
  const cumulative = f.run();
  assert.deepEqual(cumulative.pending, []);
  assert.equal(cumulative.newQualifiedOriginalCases, 1);
  writeParityQualification(cumulative, { root: f.root });
  const cumulativeSource = fs.readFileSync(file, 'utf8');
  f.updateCurrent(cumulativeSource);
  repeat = f.run();
  assert.deepEqual(repeat.pending, []);
  assert.equal(repeat.changes.length, 0);
  assert.equal(repeat.newQualifiedOriginalCases, 0);
  f.manifest.files[0].guarantees[0].proofs.pop();
  assert.ok(f.run().pending.length);
  f.manifest.files[0].guarantees[0].proofs.push(secondProof);
  f.spec.caseSelection.selected = [
    { caseIndex: 0, factIds: ['status'] },
    { caseIndex: 2, factIds: ['status'] },
  ];
  f.updateCurrent(generated);
  for (const altered of [
    generated.replace('assert.ok(value > 0)', 'assert.ok(value >= 0)'),
    generated.replace('__paqParityCaseBindings(import.meta.url', '__paqParityCaseBindings(null'),
    generated.replace('[0,2], {value}', '[0,1], {value}'),
    generated.replace('assert.ok(value > 0)', 'const injected = 1; assert.ok(value > 0)'),
    generated.replace('assert.ok(value > 0)', 'if (value) assert.ok(value > 0)'),
  ]) {
    assert.notEqual(altered, generated);
    fs.writeFileSync(file, altered);
    assert.throws(() => assertParityBindings(pathToFileURL(file), binding));
  }
  for (const altered of [
    text.replace('assert.ok(value > 0);', 'const injected = 1; assert.ok(value > 0);'),
    text.replace('assert.ok(value > 0);', 'if (value) assert.ok(value > 0);'),
  ]) {
    f.updateCurrent(altered);
    assert.ok(f.run().pending.length);
  }
});

// @test-kind tooling: shared case descriptors are deeply frozen, source-bound and backwards compatible with inline guards.
test('shared case descriptor freezes all values and rejects aliases, shadowing and mutation', async (t) => {
  const text = loopSource.replace('[1, 2]', '[\n  1, // first\n  2, // unmatched\n  3, // third\n]');
  const { f } = threeCasePartial(t, text);
  const report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    generated = fs.readFileSync(file, 'utf8'),
    bindings = report.changes[0].bindings;
  assert.equal((generated.match(/baselineId/g) || []).length, 1);
  assertParityBindings(pathToFileURL(file), bindings);
  const { freezeParityDescriptor } = await import('../scripts/qualify-parity.mjs');
  const frozen = freezeParityDescriptor([{ x: { items: [1] } }]);
  assert.ok(
    Object.isFrozen(frozen) &&
      Object.isFrozen(frozen[0]) &&
      Object.isFrozen(frozen[0].x) &&
      Object.isFrozen(frozen[0].x.items),
  );
  assert.throws(() => frozen[0].x.items.push(2), TypeError);
  const nested = { child: {} };
  Object.freeze(nested);
  freezeParityDescriptor(nested);
  assert.ok(Object.isFrozen(nested.child));
  const cyclic = {};
  cyclic.self = cyclic;
  freezeParityDescriptor(cyclic);
  assert.ok(Object.isFrozen(cyclic));
  for (const mutate of [
    (d) => d[0].caseSelection.selected.pop(),
    (d) => {
      d[0].proofs[0].sha256 = '0'.repeat(64);
    },
  ]) {
    const altered = structuredClone(bindings);
    mutate(altered);
    assert.throws(() => parityCaseBindings(pathToFileURL(file), [1, 2, 3], [0, 2], { value: 1 }, altered));
  }
  const casesBad = [
    generated.replace('const __paqParityShared =', 'let __paqParityShared ='),
    generated.replace('freezeParityDescriptor as __paqParityFreeze', 'freezeParityDescriptor as otherFreeze'),
    generated.replace('assert.ok(value > 0)', 'const stolen = __paqParityShared; assert.ok(value > 0)'),
    generated.replace('assert.ok(value > 0)', '__paqParityShared[0].baselineId = "bad"; assert.ok(value > 0)'),
    generated.replace('assert.ok(value > 0)', 'const __paqParityShared = []; assert.ok(value > 0)'),
    generated.replace(
      '__paqParityBindings(import.meta.url, __paqParityShared)',
      '__paqParityBindings(import.meta.url, missingDescriptor)',
    ),
  ];
  for (const changed of casesBad) {
    assert.notEqual(changed, generated);
    fs.writeFileSync(file, changed);
    assert.throws(() => assertParityBindings(pathToFileURL(file), bindings));
    assert.ok(parseTestKinds(changed).errors.length);
  }
  const decl = generated.match(/const __paqParityShared = __paqParityFreeze\((\[.*\])\);/u);
  assert.ok(decl);
  const legacy = generated
    .replace(decl[0], '')
    .replaceAll('__paqParityShared', decl[1])
    .replace(', freezeParityDescriptor as __paqParityFreeze', '');
  fs.writeFileSync(file, legacy);
  assertParityBindings(pathToFileURL(file), bindings);
});
