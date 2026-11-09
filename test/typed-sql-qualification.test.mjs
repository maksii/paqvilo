// @test-kind tooling: Typed SQL qualification binds each case to reviewed facts and rejects stale runtime inputs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { extract } from '../scripts/parity-sql-source.mjs';
import {
  assertParityBindings,
  describeParitySource,
  parityCaseBindings,
  parityHash,
  qualifyParityManifest,
  writeParityQualification,
} from '../scripts/qualify-parity.mjs';
const h = (value) => parityHash(JSON.stringify(value));
const loop =
  "for (const [name, args, expected, ctx] of cases) {\n  test(`${name}(${args.map((a) => (a instanceof Date ? a.toISOString() : typeof a === 'bigint' ? `${a}n` : JSON.stringify(a))).join(', ')})${ctx ? ` ${JSON.stringify(ctx)}` : ''}`, () => {\n    assert.deepStrictEqual(call(name, args, ctx), expected);\n  });\n}";
const defaultSource =
  `// @test-kind unproven: invented matrix for qualification tooling.
import test from 'node:test';
import assert from 'node:assert/strict';
const utc = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
const dec = (decimal) => ({ decimal });
const call = (name, args, ctx) => null;
const cases = [
  ['LEN', [null], null],
  ['LEFT', [null, 2], null],
];
` + loop;
function setup(t, source = defaultSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'sample.test.mjs'), source);
  const extracted = extract(source),
    model = describeParitySource(source, 'sample.test.mjs'),
    row = model.registrations[0],
    names = ['name', 'args', 'expected', 'ctx'];
  const bindings = extracted.rows.map(({ value }) =>
    Object.fromEntries(names.map((name, i) => [name, value[i] ?? { type: 'undefined' }])),
  );
  const review = {
    baseline: 'a'.repeat(40),
    sourceReceiptSha256: 'f'.repeat(64),
    review: {
      cases: extracted.rows.map((_, i) => ({
        index: i,
        originalId: `${row.id}#${i}`,
        sourceTupleSha256: extracted.rowAstSha256[i],
        currentTupleSha256: extracted.rowAstSha256[i],
        sql: `SELECT ${i} AS [value]`,
      })),
    },
  };
  fs.writeFileSync(path.join(root, 'review.json'), JSON.stringify(review));
  const reviewSha = parityHash(fs.readFileSync(path.join(root, 'review.json')));
  const manifestBytes = fs.readFileSync(new URL('./fixtures/microsoft-sql-image-manifest.json', import.meta.url)),
    digest = parityHash(manifestBytes);
  const pkg = {
    ecosystem: 'microsoft-oci',
    id: 'mssql/server',
    sha256: digest,
    source: `https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:${digest}`,
    bodyBase64: manifestBytes.toString('base64'),
  };
  const facts = Object.fromEntries(
    extracted.rows.map((_, i) => [
      `fact-${i}`,
      {
        caseIndex: i,
        baselineId: `${row.id}#${i}`,
        baselineTupleAstSha256: extracted.rowAstSha256[i],
        currentTupleAstSha256: extracted.rowAstSha256[i],
        assertionSha256: row.assertions.map((x) => x.sha256),
        semanticReviewSha256: review.sourceReceiptSha256,
        priorExpected: null,
        currentExpected: null,
        query: `SELECT ${i} AS [value]`,
        typedOutcome: {
          query: `SELECT ${i} AS [value]`,
          outcome: 'result',
          resultSets: [{ columns: [{ name: 'value' }], rows: [[{ kind: 'null' }]] }],
        },
      },
    ]),
  );
  const capsule = {
    package: pkg,
    runs: [
      { runSha256: '1'.repeat(64), facts },
      { runSha256: '2'.repeat(64), facts },
    ],
  };
  fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(capsule));
  const proof = {
    path: 'proof.json',
    sha256: parityHash(fs.readFileSync(path.join(root, 'proof.json'))),
    mode: 'official-package',
    package: pkg,
    packagePointer: '/package',
    capturePointers: ['/runs/0/runSha256', '/runs/1/runSha256'],
    facts: Object.entries(facts).map(([id, fact]) => ({
      id,
      pointer: `/runs/0/facts/${id}`,
      sha256: h(fact),
      replicatedPointers: [`/runs/0/facts/${id}`, `/runs/1/facts/${id}`],
    })),
  };
  const cases = extracted.titles,
    universe = {
      encoding: 'typed-v1',
      count: 2,
      cases,
      casesSha256: h(cases),
      caseBindings: bindings,
      sourceBindings: [{ name: 'cases', initializerAstSha256: extracted.caseArrayAstSha256 }],
      ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
    };
  const spec = {
    baselineId: row.id,
    titleExpressionSha256: row.titleExpressionSha256,
    caseUniverse: universe,
    regions: [{ assertions: row.assertions.map((x) => ({ sha256: x.sha256, factIds: ['fact-0'] })) }],
    caseSelection: { selected: [0, 1].map((caseIndex) => ({ caseIndex, factIds: [`fact-${caseIndex}`] })) },
  };
  const manifest = {
    version: 1,
    baseline: review.baseline,
    files: [
      {
        path: 'sample.test.mjs',
        baselineSha256: parityHash(source),
        currentSha256: parityHash(source),
        guarantees: [
          {
            id: 'typed-case-fixture',
            reason: 'Invented SQL facts to exercise source binding.',
            context: {
              authorResponsibility: true,
              reviewedBy: 'test',
              summary: 'Tooling fixture only; no platform parity is claimed.',
              semanticReviewSha256: review.sourceReceiptSha256,
              semanticReviewCertificateSha256: reviewSha,
              semanticReviewPath: 'review.json',
            },
            proofs: [proof],
            tests: [spec],
          },
        ],
      },
    ],
  };
  return {
    root,
    manifest,
    proof,
    review,
    run: () => qualifyParityManifest(manifest, { root, readBaseline: () => source }),
  };
}
test('typed selections reject swapped facts and rehashed wrong SQL', (t) => {
  const f = setup(t),
    selection = f.manifest.files[0].guarantees[0].tests[0].caseSelection.selected;
  assert.deepEqual(f.run().pending, []);
  [selection[0].factIds, selection[1].factIds] = [selection[1].factIds, selection[0].factIds];
  assert.equal(f.run().pending[0].reason, 'typed-case-fact-mismatch');
  [selection[0].factIds, selection[1].factIds] = [selection[1].factIds, selection[0].factIds];
  const file = path.join(f.root, 'proof.json'),
    capsule = JSON.parse(fs.readFileSync(file));
  for (const run of capsule.runs) {
    run.facts['fact-0'].query = 'SELECT NULL';
    run.facts['fact-0'].typedOutcome.query = 'SELECT NULL';
  }
  fs.writeFileSync(file, JSON.stringify(capsule));
  f.proof.sha256 = parityHash(fs.readFileSync(file));
  f.proof.facts[0].sha256 = h(capsule.runs[0].facts['fact-0']);
  assert.equal(f.run().pending[0].reason, 'typed-case-fact-mismatch');
  for (const run of capsule.runs) {
    run.facts['fact-0'].query = 'SELECT 0 AS [value]';
    run.facts['fact-0'].typedOutcome.query = 'SELECT 0 AS [value]';
    run.facts['fact-0'].typedOutcome.resultSets[0].rows[0][0] = { kind: 'string', value: 'wrong' };
  }
  fs.writeFileSync(file, JSON.stringify(capsule));
  f.proof.sha256 = parityHash(fs.readFileSync(file));
  f.proof.facts[0].sha256 = h(capsule.runs[0].facts['fact-0']);
  assert.equal(f.run().pending[0].reason, 'typed-case-output-mismatch');
});

test('typed cumulative corrections preserve every earlier selection and reject changed inputs', (t) => {
  const correctionSource = defaultSource.replace("['LEFT', [null, 2], null]", "['LEFT', [null, 2], dec('0')]");
  const f = setup(t, correctionSource);
  const file = f.manifest.files[0],
    guarantee = file.guarantees[0],
    spec = guarantee.tests[0];
  f.review.review.cases = f.review.review.cases.slice(0, 1);
  fs.writeFileSync(path.join(f.root, 'review.json'), JSON.stringify(f.review));
  guarantee.context.semanticReviewCertificateSha256 = parityHash(fs.readFileSync(path.join(f.root, 'review.json')));
  spec.caseSelection.selected = spec.caseSelection.selected.slice(0, 1);
  const initial = f.run();
  assert.deepEqual(initial.pending, []);
  writeParityQualification(initial, { root: f.root });
  const guarded = fs.readFileSync(path.join(f.root, 'sample.test.mjs'), 'utf8');
  const candidate = guarded.replace("['LEFT', [null, 2], dec('0')]", "['LEFT', [null, 2], dec('0.0')]");
  assert.notEqual(candidate, guarded);
  const candidatePath = path.join(f.root, 'candidate.mjs');
  fs.writeFileSync(candidatePath, candidate);
  const original = extract(correctionSource),
    updated = extract(correctionSource.replace("['LEFT', [null, 2], dec('0')]", "['LEFT', [null, 2], dec('0.0')]"));
  const correctionReview = {
    baseline: f.manifest.baseline,
    sourceReceiptSha256: 'e'.repeat(64),
    review: {
      cases: [
        {
          index: 1,
          originalId: `${spec.baselineId}#1`,
          sourceTupleSha256: original.rowAstSha256[1],
          currentTupleSha256: updated.rowAstSha256[1],
          sql: 'SELECT 1 AS [value]',
        },
      ],
    },
  };
  const reviewPath = path.join(f.root, 'correction-review.json');
  fs.writeFileSync(reviewPath, JSON.stringify(correctionReview));
  guarantee.context.additionalSemanticReviews = [
    {
      path: 'correction-review.json',
      sha256: parityHash(fs.readFileSync(reviewPath)),
      sourceReceiptSha256: correctionReview.sourceReceiptSha256,
    },
  ];
  const correctionFact = {
    caseIndex: 1,
    baselineId: `${spec.baselineId}#1`,
    baselineTupleAstSha256: original.rowAstSha256[1],
    currentTupleAstSha256: updated.rowAstSha256[1],
    assertionSha256: spec.regions[0].assertions.map((item) => item.sha256),
    semanticReviewSha256: correctionReview.sourceReceiptSha256,
    priorExpected: { decimal: '0' },
    currentExpected: { decimal: '0.0' },
    query: 'SELECT 1 AS [value]',
    typedOutcome: {
      query: 'SELECT 1 AS [value]',
      outcome: 'result',
      resultSets: [
        {
          columns: [{ name: 'value', sqlType: 'decimal', precision: 2, scale: 1 }],
          rows: [
            [
              {
                kind: 'sql-decimal',
                exact: '0.0',
                positive: true,
                precision: 2,
                scale: 1,
                words: ['0', '0', '0', '0'],
              },
            ],
          ],
        },
      ],
    },
  };
  const capsule = {
    package: f.proof.package,
    runs: [
      { runSha256: '3'.repeat(64), facts: { correction: correctionFact } },
      { runSha256: '4'.repeat(64), facts: { correction: correctionFact } },
    ],
  };
  fs.writeFileSync(path.join(f.root, 'correction-proof.json'), JSON.stringify(capsule));
  guarantee.proofs.push({
    path: 'correction-proof.json',
    sha256: parityHash(fs.readFileSync(path.join(f.root, 'correction-proof.json'))),
    mode: 'official-package',
    package: f.proof.package,
    packagePointer: '/package',
    capturePointers: ['/runs/0/runSha256', '/runs/1/runSha256'],
    facts: [
      {
        id: 'correction',
        pointer: '/runs/0/facts/correction',
        replicatedPointers: ['/runs/0/facts/correction', '/runs/1/facts/correction'],
        sha256: h(correctionFact),
      },
    ],
  });
  const correction = {
    binding: 'cases',
    index: 1,
    expectedIndex: 2,
    oldAstSha256: original.rowAstSha256[1],
    currentAstSha256: updated.rowAstSha256[1],
    sameGuarantee: true,
    guaranteeId: guarantee.id,
    factIds: ['correction'],
    reviewedBy: 'test',
    reason: 'Invented repeated evidence checks the original expectation migration.',
  };
  file.moduleReview = {
    reviewedBy: 'test',
    reason: 'Invented correction preserves all original input and test assertions.',
    corrections: [],
    addedTests: [],
    fixtureCorrections: [correction],
  };
  file.typedCaseCorrections = true;
  file.currentSha256 = parityHash(candidate);
  const names = ['name', 'args', 'expected', 'ctx'];
  const bindings = updated.rows.map(({ value }) =>
    Object.fromEntries(names.map((name, i) => [name, value[i] ?? { type: 'undefined' }])),
  );
  spec.caseUniverse.currentCaseBindings = bindings;
  spec.caseUniverse.currentCaseBindingsSha256 = h(bindings);
  spec.caseSelection.selected.push({ caseIndex: 1, factIds: ['correction'] });
  const run = () =>
    qualifyParityManifest(f.manifest, {
      root: f.root,
      readBaseline: () => correctionSource,
      reviewedCandidateFile: candidatePath,
    });
  assert.deepEqual(run().pending, []);
  const selected = spec.caseSelection.selected;
  spec.caseSelection.selected = selected.slice(1);
  assert.equal(run().pending[0].reason, 'existing-case-fact-mapping-omitted');
  spec.caseSelection.selected = selected;
  const priorProof = guarantee.proofs.shift();
  assert.equal(run().pending[0].reason, 'typed-case-fact-mismatch');
  guarantee.proofs.unshift(priorProof);
  const oldReviewPath = guarantee.context.semanticReviewPath;
  guarantee.context.semanticReviewPath = 'correction-review.json';
  assert.equal(run().pending[0].reason, 'typed-semantic-review-required');
  delete guarantee.context.semanticReviewPath;
  assert.equal(run().pending[0].reason, 'typed-semantic-review-required');
  guarantee.context.semanticReviewPath = oldReviewPath;
  const savedSourceHash = spec.caseUniverse.sourceBindings[0].initializerAstSha256;
  spec.caseUniverse.sourceBindings[0].initializerAstSha256 = 'd'.repeat(64);
  assert.equal(run().pending[0].reason, 'changed-source-binding');
  spec.caseUniverse.sourceBindings[0].initializerAstSha256 = savedSourceHash;
  const proofFile = path.join(f.root, 'proof.json'),
    proofBytes = fs.readFileSync(proofFile),
    altered = Buffer.from(proofBytes);
  altered[altered.length - 2] ^= 1;
  fs.writeFileSync(proofFile, altered);
  assert.equal(run().pending[0].reason, 'stale-proof-sha');
  fs.writeFileSync(proofFile, proofBytes);
  const changedContext = candidate.replace(
    'const call = (name, args, ctx) => null;',
    'const call = (name, args, ctx) => 1;',
  );
  fs.writeFileSync(candidatePath, changedContext);
  file.currentSha256 = parityHash(changedContext);
  assert.equal(run().pending[0].reason, 'changed-module-context');
  fs.writeFileSync(candidatePath, candidate);
  file.currentSha256 = parityHash(candidate);
  const changedInput = candidate.replace("['LEFT', [null, 2], dec('0.0')]", "['LEFT', [null, 3], dec('0.0')]");
  fs.writeFileSync(candidatePath, changedInput);
  file.currentSha256 = parityHash(changedInput);
  assert.equal(run().pending[0].reason, 'invalid-fixture-correction');
  fs.writeFileSync(candidatePath, candidate);
  file.currentSha256 = parityHash(candidate);
  const written = run();
  assert.deepEqual(written.pending, []);
  writeParityQualification(written, { root: f.root });
  file.currentSha256 = parityHash(fs.readFileSync(path.join(f.root, 'sample.test.mjs')));
  const rerun = qualifyParityManifest(f.manifest, { root: f.root, readBaseline: () => correctionSource });
  assert.deepEqual(rerun.pending, []);
  assert.equal(rerun.newQualifiedOriginalCases, 0);
});
test('cached typed guard rechecks full live universe, source, proof and review bytes', (t) => {
  const f = setup(t),
    report = f.run();
  assert.deepEqual(report.pending, []);
  writeParityQualification(report, { root: f.root });
  const file = path.join(f.root, 'sample.test.mjs'),
    url = pathToFileURL(file),
    descriptors = report.changes[0].bindings,
    cases = [
      ['LEN', [null], null],
      ['LEFT', [null, 2], null],
    ],
    indices = [0, 1],
    binding = { name: 'LEN', args: [null], expected: null, ctx: undefined };
  assertParityBindings(url, descriptors);
  assertParityBindings(url, descriptors);
  assert.equal(parityCaseBindings(url, cases, indices, binding, descriptors), true);
  const changed = structuredClone(cases);
  changed[1][1][1] = 3;
  assert.throws(() => parityCaseBindings(url, changed, indices, binding, descriptors), /changed-typed-case-universe/);
  for (const [name, reason] of [
    ['proof.json', /stale-proof-sha/],
    ['review.json', /changed-test-input-dependency/],
    ['sample.test.mjs', /changed|invalid|binding/],
  ]) {
    const fd = fs.openSync(path.join(f.root, name), 'r+');
    try {
      const initial = fs.fstatSync(fd);
      fs.futimesSync(fd, initial.atime, initial.mtime);
      const bytes = fs.readFileSync(fd),
        stat = fs.fstatSync(fd),
        modified =
          name === 'sample.test.mjs'
            ? Buffer.from(bytes.toString('utf8').replace("['LEN', [null], null]", "['LEN', [null], true]"))
            : Buffer.from(bytes);
      if (name !== 'sample.test.mjs') modified[modified.length - 2] ^= 1;
      assert.equal(modified.length, bytes.length);
      assert.equal(modified.equals(bytes), false);
      const write = (content) => assert.equal(fs.writeSync(fd, content, 0, content.length, 0), content.length);
      try {
        write(modified);
        fs.futimesSync(fd, stat.atime, stat.mtime);
        const after = fs.fstatSync(fd);
        assert.equal(after.size, stat.size);
        assert.equal(after.mtimeMs, stat.mtimeMs);
        assert.throws(() => assertParityBindings(url, descriptors), reason);
      } finally {
        write(bytes);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  assertParityBindings(url, descriptors);
});

test('typed cumulative selection retains prior evidence and accepts only disjoint additive reviews', (t) => {
  const f = setup(t);
  const file = f.manifest.files[0],
    guarantee = file.guarantees[0],
    spec = guarantee.tests[0];
  const secondRow = f.review.review.cases.pop();
  fs.writeFileSync(path.join(f.root, 'review.json'), JSON.stringify(f.review));
  guarantee.context.semanticReviewCertificateSha256 = parityHash(fs.readFileSync(path.join(f.root, 'review.json')));
  spec.caseSelection.selected = [spec.caseSelection.selected[0]];
  const first = f.run();
  assert.deepEqual(first.pending, []);
  writeParityQualification(first, { root: f.root });
  file.currentSha256 = parityHash(fs.readFileSync(path.join(f.root, file.path)));

  const secondReview = {
    baseline: f.review.baseline,
    sourceReceiptSha256: 'e'.repeat(64),
    review: { cases: [secondRow] },
  };
  fs.writeFileSync(path.join(f.root, 'review-extra.json'), JSON.stringify(secondReview));
  const extraReview = {
    path: 'review-extra.json',
    sha256: parityHash(fs.readFileSync(path.join(f.root, 'review-extra.json'))),
    sourceReceiptSha256: secondReview.sourceReceiptSha256,
  };
  const originalCapsule = JSON.parse(fs.readFileSync(path.join(f.root, 'proof.json')));
  const fact = { ...originalCapsule.runs[0].facts['fact-1'], semanticReviewSha256: secondReview.sourceReceiptSha256 };
  const extraCapsule = {
    package: originalCapsule.package,
    runs: [
      { runSha256: '3'.repeat(64), facts: { 'fact-extra': fact } },
      { runSha256: '4'.repeat(64), facts: { 'fact-extra': fact } },
    ],
  };
  fs.writeFileSync(path.join(f.root, 'proof-extra.json'), JSON.stringify(extraCapsule));
  const extraProof = {
    ...f.proof,
    path: 'proof-extra.json',
    sha256: parityHash(fs.readFileSync(path.join(f.root, 'proof-extra.json'))),
    facts: [
      {
        id: 'fact-extra',
        pointer: '/runs/0/facts/fact-extra',
        sha256: h(fact),
        replicatedPointers: ['/runs/0/facts/fact-extra', '/runs/1/facts/fact-extra'],
      },
    ],
  };
  guarantee.context.additionalSemanticReviews = [extraReview];
  guarantee.proofs.push(extraProof);
  spec.caseSelection.selected.push({ caseIndex: 1, factIds: ['fact-extra'] });
  const cumulative = f.run();
  assert.deepEqual(cumulative.pending, []);
  assert.equal(cumulative.newQualifiedOriginalCases, 1);
  const descriptors = cumulative.changes[0].bindings;
  assert.deepEqual(
    descriptors[0].inputDependencies.map((item) => item.path),
    ['review-extra.json', 'review.json'],
  );

  fs.copyFileSync(path.join(f.root, 'review.json'), path.join(f.root, 'review-replacement.json'));
  guarantee.context.semanticReviewPath = 'review-replacement.json';
  assert.equal(f.run().pending[0].reason, 'existing-case-binding-changed');
  guarantee.context.semanticReviewPath = 'review.json';
  const priorReview = fs.readFileSync(path.join(f.root, 'review.json'));
  fs.writeFileSync(path.join(f.root, 'review.json'), Buffer.concat([priorReview, Buffer.from('\n')]));
  const priorHash = guarantee.context.semanticReviewCertificateSha256;
  guarantee.context.semanticReviewCertificateSha256 = parityHash(fs.readFileSync(path.join(f.root, 'review.json')));
  assert.equal(f.run().pending[0].reason, 'changed-test-input-dependency');
  fs.writeFileSync(path.join(f.root, 'review.json'), priorReview);
  guarantee.context.semanticReviewCertificateSha256 = priorHash;
  spec.caseSelection.selected[1].factIds = ['fact-0'];
  assert.equal(f.run().pending[0].reason, 'typed-case-fact-required');
  spec.caseSelection.selected[1].factIds = ['fact-extra'];
  guarantee.proofs.shift();
  assert.ok(f.run().pending.length);
  guarantee.proofs.unshift(f.proof);

  guarantee.context.additionalSemanticReviews = [{ ...extraReview, path: 'review.json' }];
  assert.equal(f.run().pending[0].reason, 'typed-semantic-review-required');
  guarantee.context.additionalSemanticReviews = [{ ...extraReview, path: './review.json' }];
  assert.equal(f.run().pending[0].reason, 'typed-semantic-review-required');
  guarantee.context.additionalSemanticReviews = [extraReview];
  secondReview.review.cases[0].index = 0;
  fs.writeFileSync(path.join(f.root, 'review-extra.json'), JSON.stringify(secondReview));
  extraReview.sha256 = parityHash(fs.readFileSync(path.join(f.root, 'review-extra.json')));
  assert.equal(f.run().pending[0].reason, 'typed-semantic-review-collision');
  secondReview.review.cases[0].index = 1;
  fs.writeFileSync(path.join(f.root, 'review-extra.json'), JSON.stringify(secondReview));
  extraReview.sha256 = parityHash(fs.readFileSync(path.join(f.root, 'review-extra.json')));
  writeParityQualification(cumulative, { root: f.root });
  const url = pathToFileURL(path.join(f.root, file.path));
  assertParityBindings(url, descriptors);
  fs.appendFileSync(path.join(f.root, 'review-extra.json'), ' ');
  assert.throws(() => assertParityBindings(url, descriptors), /changed-test-input-dependency/);
});

test('typed SQL decimal and Int64 facts require exact representations and reject tampering', (t) => {
  const decimalSource = String(defaultSource).replace(
    "  ['LEN', [null], null],\n  ['LEFT', [null, 2], null],",
    "  ['ABS', [dec('1.50')], dec('1.50')],\n  ['ABS', [-7n], 7n],",
  );
  assert.notEqual(decimalSource, defaultSource);
  const f = setup(t, decimalSource);
  const proofPath = path.join(f.root, 'proof.json');
  const capsule = JSON.parse(fs.readFileSync(proofPath));
  for (const run of capsule.runs) {
    const decimal = run.facts['fact-0'];
    decimal.priorExpected = { decimal: '1.50' };
    decimal.currentExpected = { decimal: '1.50' };
    decimal.typedOutcome.resultSets = [
      {
        columns: [{ name: 'value', sqlType: 'decimal', precision: 3, scale: 2 }],
        rows: [
          [
            {
              kind: 'sql-decimal',
              exact: '1.50',
              positive: true,
              precision: 3,
              scale: 2,
              words: ['150', '0', '0', '0'],
            },
          ],
        ],
      },
    ];
    const bigint = run.facts['fact-1'];
    bigint.priorExpected = { bigint: '7' };
    bigint.currentExpected = { bigint: '7' };
    bigint.typedOutcome.resultSets = [
      {
        columns: [{ name: 'value', sqlType: 'bigint' }],
        rows: [[{ kind: 'System.Int64', exact: '7' }]],
      },
    ];
  }
  const original = structuredClone(capsule);
  function updateProof(value) {
    fs.writeFileSync(proofPath, JSON.stringify(value));
    f.proof.sha256 = parityHash(fs.readFileSync(proofPath));
    for (const fact of f.proof.facts) fact.sha256 = h(value.runs[0].facts[fact.id]);
  }
  updateProof(capsule);
  assert.deepEqual(f.run().pending, []);
  for (const mutate of [
    (fact) => {
      fact.typedOutcome.resultSets[0].rows[0][0].words[0] = '151';
    },
    (fact) => {
      fact.typedOutcome.resultSets[0].rows[0][0].positive = false;
    },
    (fact) => {
      fact.typedOutcome.resultSets[0].rows[0][0].scale = 1;
    },
    (fact) => {
      fact.typedOutcome.resultSets[0].columns[0].precision = 4;
    },
    (fact) => {
      fact.currentExpected.decimal = '1.5';
    },
  ]) {
    const changed = structuredClone(original);
    for (const run of changed.runs) mutate(run.facts['fact-0']);
    updateProof(changed);
    assert.ok(f.run().pending.length, 'modified decimal fact must be rejected');
  }
  const overflow = structuredClone(original);
  for (const run of overflow.runs)
    run.facts['fact-1'].typedOutcome.resultSets[0].rows[0][0].exact = '9223372036854775808';
  updateProof(overflow);
  assert.ok(f.run().pending.length, 'out-of-range Int64 must be rejected');
});

test('typed SQL Int32 facts enforce the signed 32-bit wire range', (t) => {
  for (const [expected, accepted] of [
    [2147483647, true],
    [-2147483648, true],
    [2147483648, false],
    [-2147483649, false],
  ]) {
    const typedSource = String(defaultSource).replace("['LEN', [null], null]", `['LEN', [null], ${expected}]`);
    assert.notEqual(typedSource, defaultSource);
    const f = setup(t, typedSource);
    const proofPath = path.join(f.root, 'proof.json');
    const capsule = JSON.parse(fs.readFileSync(proofPath));
    for (const run of capsule.runs) {
      const fact = run.facts['fact-0'];
      fact.priorExpected = expected;
      fact.currentExpected = expected;
      fact.typedOutcome.resultSets[0].rows[0][0] = { kind: 'System.Int32', exact: String(expected) };
    }
    fs.writeFileSync(proofPath, JSON.stringify(capsule));
    f.proof.sha256 = parityHash(fs.readFileSync(proofPath));
    f.proof.facts[0].sha256 = h(capsule.runs[0].facts['fact-0']);
    const result = f.run();
    if (accepted) assert.deepEqual(result.pending, []);
    else assert.equal(result.pending[0].reason, 'typed-output-unsupported');
  }
});

test('typed SQL float results preserve the sign of zero', (t) => {
  const zeroSource = String(defaultSource).replace("['LEN', [null], null]", "['LEN', [null], 0]");
  assert.notEqual(zeroSource, defaultSource);
  const f = setup(t, zeroSource);
  const proofPath = path.join(f.root, 'proof.json');
  const capsule = JSON.parse(fs.readFileSync(proofPath));
  for (const run of capsule.runs) {
    const fact = run.facts['fact-0'];
    fact.priorExpected = 0;
    fact.currentExpected = 0;
    fact.typedOutcome.resultSets[0].rows[0][0] = {
      kind: 'float64',
      roundtrip: '-0',
      bitsBase64: 'AAAAAAAAAIA=',
    };
  }
  fs.writeFileSync(proofPath, JSON.stringify(capsule));
  f.proof.sha256 = parityHash(fs.readFileSync(proofPath));
  f.proof.facts[0].sha256 = h(capsule.runs[0].facts['fact-0']);
  assert.equal(f.run().pending[0].reason, 'typed-case-output-mismatch');
});
