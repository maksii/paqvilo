// @test-kind tooling: Evaluator qualification must bind source, helper behavior, and typed results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  assertParityBindings,
  describeParitySource,
  parityAstHash,
  parityCaseBindings,
  parityHash,
  qualifyParityManifest,
  writeParityQualification,
} from '../scripts/qualify-parity.mjs';

const hashJson = (value) => parityHash(JSON.stringify(value));
function literal(node) {
  if (node.type === 'Literal') return node.value;
  if (node.type === 'ArrayExpression') return node.elements.map(literal);
  if (node.type === 'ObjectExpression')
    return Object.fromEntries(node.properties.map((item) => [item.key.name, literal(item.value)]));
  if (node.type === 'UnaryExpression' && node.operator === '-') return -literal(node.argument);
  throw new Error(`Unsupported literal ${node.type}`);
}

test('evaluator selection binds exact source, helper and reviewed SQL result', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sql-eval-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const guardedSource = fs.readFileSync(
    new URL('../mirage/test/dataverse-tds-sql-eval.test.mjs', import.meta.url),
    'utf8',
  );
  const file = 'sample.test.mjs';
  const initialModel = describeParitySource(guardedSource, file);
  const selected = initialModel.registrations.find((item) =>
    item.loops.some((loop) => loop.right?.name === 'semanticCases'),
  );
  const generated = initialModel.ast.body.filter(
    (node) =>
      (node.type === 'ImportDeclaration' &&
        node.specifiers.some((item) => item.local.name === '__paqParityCaseBindings')) ||
      (node.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === '__paqParityShared') ||
      (node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqParityBindings'),
  );
  assert.equal(generated.length, 3);
  assert.equal(selected.callback.body.body.length, 2);
  const originalExpression = selected.callback.body.body[1];
  assert.equal(originalExpression.type, 'ReturnStatement');
  const edits = generated.map((node) => ({ range: node.range, text: '' }));
  edits.push({ range: selected.callback.body.range, text: guardedSource.slice(...originalExpression.argument.range) });
  let source = guardedSource;
  for (const edit of edits.sort((a, b) => b.range[0] - a.range[0]))
    source = source.slice(0, edit.range[0]) + edit.text + source.slice(edit.range[1]);
  fs.writeFileSync(path.join(root, file), source);
  const model = describeParitySource(source, file);
  const declaration = model.declarations.find((item) => item.name === 'semanticCases');
  const row = model.registrations.find((item) => item.loops.some((loop) => loop.right?.name === 'semanticCases'));
  const entries = literal(declaration.initializer);
  const bindings = entries.map(([label, sql, expected]) => ({ label, sql, expected }));
  const titles = bindings.map(({ label }) => `T-SQL semantics: ${label}`);
  const tupleHash = parityAstHash(declaration.initializer.elements[0]);
  const assertionHash = parityAstHash(row.callback.body);
  const review = {
    baseline: 'a'.repeat(40),
    sourceReceiptSha256: 'f'.repeat(64),
    review: { cases: [{ index: 0, originalId: `${row.id}#0`, tupleSha256: tupleHash, sql: bindings[0].sql }] },
  };
  fs.writeFileSync(path.join(root, 'review.json'), JSON.stringify(review));
  const image = fs.readFileSync(new URL('./fixtures/microsoft-sql-image-manifest.json', import.meta.url));
  const digest = parityHash(image);
  const pkg = {
    ecosystem: 'microsoft-oci',
    id: 'mssql/server',
    sha256: digest,
    source: `https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:${digest}`,
    bodyBase64: image.toString('base64'),
  };
  const fact = {
    caseIndex: 0,
    baselineId: `${row.id}#0`,
    baselineTupleAstSha256: tupleHash,
    currentTupleAstSha256: tupleHash,
    semanticReviewSha256: review.sourceReceiptSha256,
    query: bindings[0].sql,
    expected: bindings[0].expected,
    typedOutcome: {
      query: bindings[0].sql,
      outcome: 'result',
      resultSets: [
        {
          columns: [{ sqlType: 'decimal', precision: 7, scale: 6 }],
          rows: [
            [
              {
                kind: 'sql-decimal',
                exact: '3.500000',
                positive: true,
                precision: 7,
                scale: 6,
                words: ['3500000', '0', '0', '0'],
              },
            ],
          ],
        },
      ],
    },
  };
  const capsule = {
    package: pkg,
    runs: [
      { runSha256: '1'.repeat(64), facts: { fact } },
      { runSha256: '2'.repeat(64), facts: { fact } },
    ],
  };
  const proof = {
    path: 'proof.json',
    mode: 'official-package',
    package: pkg,
    packagePointer: '/package',
    capturePointers: ['/runs/0/runSha256', '/runs/1/runSha256'],
    facts: [
      {
        id: 'fact',
        pointer: '/runs/0/facts/fact',
        replicatedPointers: ['/runs/0/facts/fact', '/runs/1/facts/fact'],
        sha256: hashJson(fact),
      },
    ],
  };
  const saveProof = () => {
    fs.writeFileSync(path.join(root, 'proof.json'), JSON.stringify(capsule));
    proof.sha256 = parityHash(fs.readFileSync(path.join(root, 'proof.json')));
    proof.facts[0].sha256 = hashJson(capsule.runs[0].facts.fact);
  };
  saveProof();
  const manifest = {
    version: 1,
    baseline: review.baseline,
    files: [
      {
        path: file,
        baselineSha256: parityHash(source),
        currentSha256: parityHash(source),
        importRoles: [
          {
            source: '../lib/dataverse-tds-sql-eval.mjs',
            role: 'implementation-under-test',
            reviewedBy: 'test',
            reason: 'The implementation under test is invoked by the original helper.',
          },
        ],
        guarantees: [
          {
            id: 'eval-fixture',
            reason: 'Invented evidence exercises guard mechanics only.',
            context: {
              authorResponsibility: true,
              reviewedBy: 'test',
              summary: 'Invented evidence does not establish platform behavior.',
              semanticReviewSha256: review.sourceReceiptSha256,
              semanticReviewPath: 'review.json',
              semanticReviewCertificateSha256: parityHash(fs.readFileSync(path.join(root, 'review.json'))),
            },
            proofs: [proof],
            tests: [
              {
                baselineId: row.id,
                titleExpressionSha256: row.titleExpressionSha256,
                sqlEvaluator: true,
                caseUniverse: {
                  encoding: 'sql-eval-v1',
                  count: entries.length,
                  cases: titles,
                  casesSha256: hashJson(titles),
                  caseBindings: bindings,
                  sourceBindings: [{ name: 'semanticCases', initializerAstSha256: declaration.initializerAstSha256 }],
                  ancestorLoops: row.loopHeaders.map((headerAstSha256) => ({ headerAstSha256 })),
                },
                regions: [{ assertions: [{ sha256: assertionHash, factIds: ['fact'] }] }],
                caseSelection: { selected: [{ caseIndex: 0, factIds: ['fact'] }] },
              },
            ],
          },
        ],
      },
    ],
  };
  let baselineSource = source;
  const run = () => qualifyParityManifest(manifest, { root, readBaseline: () => baselineSource });
  const qualified = run();
  assert.deepEqual(qualified.pending, []);
  const changedHelper = source.replace("'decimal' in value", "'changed' in value");
  fs.writeFileSync(path.join(root, file), changedHelper);
  manifest.files[0].currentSha256 = parityHash(changedHelper);
  assert.notDeepEqual(run().pending, []);
  const changedUnselected = source.replace("'bigint overflow is 8115'", "'different original case'");
  fs.writeFileSync(path.join(root, file), changedUnselected);
  manifest.files[0].currentSha256 = parityHash(changedUnselected);
  assert.notDeepEqual(run().pending, []);
  fs.writeFileSync(path.join(root, file), source);
  manifest.files[0].currentSha256 = parityHash(source);
  writeParityQualification(qualified, { root });
  const guarded = fs.readFileSync(path.join(root, file), 'utf8');
  const guardedModel = describeParitySource(guarded, file);
  const guardedRow = guardedModel.registrations.find((item) =>
    item.loops.some((loop) => loop.right?.name === 'semanticCases'),
  );
  const callback = guarded.slice(...guardedRow.callback.range);
  const execution = `import { test } from 'node:test';
import assert from 'node:assert/strict';
const semanticCases = [];
const [label, sql, expected] = ['selected', 'SELECT 1', [[1]]];
const __paqParityCaseBindings = () => true;
const __paqParityShared = [];
let shouldReject = false;
const returned = Promise.resolve();
function check() {
  return shouldReject ? Promise.resolve().then(() => assert.fail('controlled asynchronous failure')) : returned;
}
const callback = ${callback};
assert.equal(callback(), returned);
shouldReject = true;
test('selected original callback', callback);
`;
  const executionPath = path.join(root, 'async-execution.test.mjs');
  fs.writeFileSync(executionPath, execution);
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const executionResult = spawnSync(process.execPath, ['--test', executionPath], { encoding: 'utf8', env: childEnv });
  assert.equal(executionResult.status, 1, `${executionResult.stdout}\n${executionResult.stderr}`);
  assert.match(executionResult.stdout, /controlled asynchronous failure/);
  const descriptor = qualified.changes[0].bindings;
  const url = pathToFileURL(path.join(root, file));
  assertParityBindings(url, descriptor);
  assert.equal(descriptor[0].caseUniverse.caseBindingsSha256, hashJson(bindings));
  assert.equal(Object.hasOwn(descriptor[0].caseUniverse, 'caseBindings'), false);
  assert.equal(parityCaseBindings(url, entries, [0], bindings[0], descriptor), true);
  const changedUniverse = structuredClone(entries);
  changedUniverse[1][1] += ' ';
  assert.throws(
    () => parityCaseBindings(url, changedUniverse, [0], bindings[0], descriptor),
    /changed-case-parity-universe/,
  );
  const changedHash = structuredClone(descriptor);
  changedHash[0].caseUniverse.caseBindingsSha256 = '0'.repeat(64);
  assert.throws(() => assertParityBindings(url, changedHash), /changed|invalid/);
  fs.writeFileSync(path.join(root, file), guarded.replace("'decimal' in value", "'changed' in value"));
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(root, file)), qualified.changes[0].bindings),
    /changed|invalid/,
  );
  const changedGuardedCase = guarded.replace("'bigint overflow is 8115'", "'other overflow is 8115'");
  assert.notEqual(changedGuardedCase, guarded);
  fs.writeFileSync(path.join(root, file), changedGuardedCase);
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(root, file)), qualified.changes[0].bindings),
    /changed|invalid/,
  );
  fs.writeFileSync(path.join(root, file), guarded);
  const proofPath = path.join(root, 'proof.json');
  const proofBytes = fs.readFileSync(proofPath);
  const proofStat = fs.statSync(proofPath);
  const changedProof = Buffer.from(proofBytes);
  changedProof[changedProof.length - 2] ^= 1;
  fs.writeFileSync(proofPath, changedProof);
  fs.utimesSync(proofPath, proofStat.atime, proofStat.mtime);
  assert.equal(fs.statSync(proofPath).size, proofStat.size);
  assert.throws(
    () => assertParityBindings(pathToFileURL(path.join(root, file)), qualified.changes[0].bindings),
    /stale-proof-sha/,
  );
  fs.writeFileSync(proofPath, proofBytes);
  assertParityBindings(pathToFileURL(path.join(root, file)), qualified.changes[0].bindings);
  fs.writeFileSync(path.join(root, file), source);
  for (const run of capsule.runs) run.facts.fact.typedOutcome.resultSets[0].rows[0][0].exact = '3.500001';
  saveProof();
  assert.equal(run().pending[0].reason, 'typed-output-unsupported');
  for (const run of capsule.runs) run.facts.fact.typedOutcome.resultSets[0].rows[0][0].exact = '3.500000';
  baselineSource = source.replace("[['9223372036854775808']]", '{ error: 8115 }');
  assert.notEqual(baselineSource, source);
  const originalModel = describeParitySource(baselineSource, file);
  const originalCases = originalModel.declarations.find((item) => item.name === 'semanticCases');
  const oldEntry = originalCases.initializer.elements[11];
  const currentEntry = declaration.initializer.elements[11];
  const originalBindings = literal(originalCases.initializer).map(([label, sql, expected]) => ({
    label,
    sql,
    expected,
  }));
  const correctionId = `${row.id}#11`;
  const correction = {
    id: correctionId,
    baselineTupleAstSha256: parityAstHash(oldEntry),
    currentTupleAstSha256: parityAstHash(currentEntry),
    sql: originalBindings[11].sql,
    baselineExpected: originalBindings[11].expected,
    currentExpected: bindings[11].expected,
  };
  const correctionReview = { baseline: review.baseline, sourceReceiptSha256: 'e'.repeat(64), cases: [correction] };
  const correctionReviewPath = path.join(root, 'corrections-review.json');
  fs.writeFileSync(correctionReviewPath, JSON.stringify(correctionReview));
  const correctionFact = {
    binding: 'semanticCases',
    index: 11,
    baselineId: correctionId,
    oldTupleSha256: correction.baselineTupleAstSha256,
    currentTupleSha256: correction.currentTupleAstSha256,
    query: correction.sql,
    semanticReviewSha256: correctionReview.sourceReceiptSha256,
    typedOutcome: {
      query: correction.sql,
      outcome: 'result',
      resultSets: [
        {
          columns: [{ sqlType: 'decimal', precision: 20, scale: 0 }],
          rows: [
            [
              {
                kind: 'sql-decimal',
                exact: '9223372036854775808',
                positive: true,
                precision: 20,
                scale: 0,
                words: ['0', '-2147483648', '0', '0'],
              },
            ],
          ],
        },
      ],
    },
  };
  for (const run of capsule.runs) run.facts.correction = correctionFact;
  proof.facts.push({
    id: 'correction',
    pointer: '/runs/0/facts/correction',
    replicatedPointers: ['/runs/0/facts/correction', '/runs/1/facts/correction'],
    sha256: hashJson(correctionFact),
  });
  saveProof();
  const entry = manifest.files[0],
    guarantee = entry.guarantees[0],
    spec = guarantee.tests[0];
  entry.baselineSha256 = parityHash(baselineSource);
  entry.moduleReview = {
    reviewedBy: 'test',
    reason: 'Invented correction tests reviewed exact source and expected values.',
    corrections: [],
    addedTests: [],
    fixtureCorrections: [
      {
        binding: 'semanticCases',
        index: 11,
        expectedIndex: 2,
        oldAstSha256: correction.baselineTupleAstSha256,
        currentAstSha256: correction.currentTupleAstSha256,
        sameGuarantee: true,
        guaranteeId: guarantee.id,
        factIds: ['correction'],
        reviewedBy: 'test',
        reason: 'Invented correction evidence exercises strict bindings only.',
      },
    ],
  };
  Object.assign(spec.caseUniverse, {
    caseBindings: originalBindings,
    currentCaseBindings: bindings,
    currentCaseBindingsSha256: hashJson(bindings),
    sourceBindings: [{ name: 'semanticCases', initializerAstSha256: originalCases.initializerAstSha256 }],
  });
  Object.assign(guarantee.context, {
    correctionReviewPath: 'corrections-review.json',
    correctionReviewSha256: parityHash(fs.readFileSync(correctionReviewPath)),
    correctionSourceSha256: correctionReview.sourceReceiptSha256,
  });
  assert.deepEqual(run().pending, []);
  correctionReview.cases[0].sql = 'SELECT unrelated';
  fs.writeFileSync(correctionReviewPath, JSON.stringify(correctionReview));
  guarantee.context.correctionReviewSha256 = parityHash(fs.readFileSync(correctionReviewPath));
  assert.equal(run().pending[0].reason, 'sql-eval-correction-fact-mismatch');
});
