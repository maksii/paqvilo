import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
// @test-kind unproven: Local reader-source and lazy-parser models; exact repeated native scalar-cause guarantees are tagged separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  scalarNumberLexemes,
  dataverseScalarCause,
  dataverseHttpReaderContext,
} from '../lib/dataverse-scalar-reader.mjs';
test('source facts preserve lexemes and refuse conflicting nested property spellings', () => {
  const facts = scalarNumberLexemes('{"a":2147483648,"b":1.0,"nested":{"b":1},"c":1e0}');
  assert.equal(facts('a', 2147483648), '2147483648');
  assert.equal(facts('b', 1), undefined);
  assert.equal(facts('c', 1), '1e0');
  assert.equal(
    dataverseScalarCause(2147483648, 'Edm.Int32', {
      numericLexeme: facts('a', 2147483648),
    }),
    "Cannot convert the literal '2147483648' to the expected type 'Edm.Int32'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Decimal' to the expected target type 'Edm.Int32'.",
  );
  assert.equal(dataverseScalarCause(1, 'Edm.String', { numericLexeme: facts('c', 1) }), null);
});

test('reader source parsing is lazy and remains bounded to each actual JSON request', () => {
  const context = dataverseHttpReaderContext({
    method: 'PATCH',
    route: { kind: 'entity', set: 'samples' },
    headers: { 'Content-Type': 'application/json; IEEE754Compatible="true"' },
    bodyBuffer: Buffer.from('not JSON'),
  });
  assert.equal(context.ieee754Compatible, true);
  assert.equal(context.recordPayload, true);
  assert.throws(() => context.numberLexemeFor('quantity', 1), SyntaxError);
  const unrelated = dataverseHttpReaderContext({
    method: 'POST',
    route: { kind: 'action' },
    headers: { 'content-type': 'application/octet-stream' },
    bodyBuffer: Buffer.from('not JSON'),
  });
  assert.equal(unrelated.numberLexemeFor, undefined);
  assert.equal(unrelated.recordPayload, false);
});

test('a numeric string, a numeric lexeme for a text target and an unknown type produce no scalar cause', () => {
  assert.equal(dataverseScalarCause('2147483648', 'Edm.Int32'), null);
  assert.equal(dataverseScalarCause(1, 'Edm.String', { numericLexeme: '1e0' }), null);
  assert.equal(dataverseScalarCause(1, 'Edm.Unknown', { numericLexeme: '1' }), null);
});
// @test-kind parity: Both native1071 cohorts have these exact Boolean True and Edm.Date cause lines; the native68 pair separately proves the empty Boolean cause.
// @parity-evidence: dataverse-existing-scalar-causes.json binds five raw response hashes per cohort; webapi-native-scalar-reader.json binds repeated empty-Boolean inputs. Only first cause lines are asserted, not absence of native CLR suffixes.
test('native Boolean casing and typed causes do not invent CLR stack frames', () => {
  // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/dataverse-scalar-reader.test.mjs:47:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '62131d776eea695851e743c650b443a36192b566a7e8f5978709acc1822530b5',
      originalAssertions: [
        '5c3579540127cbf9889d39d85d46174e6b1c0810de5fbc1e56023450bd585620',
        '7ada6c082081b4ef4de34055a1da8a57b4c0d7ae54f22f990972d0283dbc6990',
        'fed86bb0aa0d0f27b245c510aa603dff2eccab5ed3fe22877ce909c2b2c13025',
      ],
      originalBodyAstSha256: 'ac5040f80cf7ca8980319162c2c8f26e2f680a3b6234e3edc82e080165a861ca',
      originalGuardHashes: [],
      moduleContextAstSha256: '9ef7551a14ac91443f409defeab15770371f2e242f0235e8a09dcfb708b65085',
      importRoles: [
        {
          source: '../lib/dataverse-scalar-reader.mjs',
          role: 'implementation-under-test',
          reviewedBy: '/root/api_qualify',
          reason:
            'Toolkit runtime implementation exercised by these Dataverse behavior assertions; source may evolve as bugs are corrected.',
        },
      ],
      runtimeInputs: [],
      inputDependencies: [],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: ['native Boolean casing and typed causes do not invent CLR stack frames'],
        casesSha256: '51a8a1fda6f9176f6c1fd95066a46e9f3fc493aa1aca333d15654a17eb7d3adf',
        sourceBindings: [],
        ancestorLoops: [],
      },
      assertionLoops: [
        {
          assertionSha256: '5c3579540127cbf9889d39d85d46174e6b1c0810de5fbc1e56023450bd585620',
          loopAstSha256: 'bd646481f751b2d299a3950877d8f19ec58e9bdb38f5cfc513565d0f519a2246',
          caseBindings: [
            { type: 'Edm.String' },
            { type: 'Edm.Int32' },
            { type: 'Edm.Decimal' },
            { type: 'Edm.Double' },
          ],
          caseBindingsSha256: '8d6e7ba57be9600f47e571df1e7511a2a686ba2ec88aff2d055518c2b570bfa6',
          caseFacts: [
            { outerCaseIndex: 0, innerCaseIndex: 0, factIds: ['proof0-case0'] },
            { outerCaseIndex: 0, innerCaseIndex: 1, factIds: ['proof0-case1'] },
            { outerCaseIndex: 0, innerCaseIndex: 2, factIds: ['proof0-case2'] },
            { outerCaseIndex: 0, innerCaseIndex: 3, factIds: ['proof0-case3'] },
          ],
        },
      ],
      proofs: [
        {
          path: 'mirage/test/fixtures/dataverse-existing-scalar-causes.json',
          sha256: '94e865d6371e16fc3ccfeb18da17857c01da56f233e2f6a5fa57af605adaaa0e',
          mode: 'reproduced-native',
          capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
          facts: [
            {
              id: 'proof0-case0',
              pointer: '/captures/0/cases/0/cause',
              sha256: 'f45b0ae0249f4465b5422fc58579e32afdf56f9a887a8d978fc319f67ae6a595',
              replicatedPointers: ['/captures/0/cases/0/cause', '/captures/1/cases/0/cause'],
            },
            {
              id: 'proof0-case1',
              pointer: '/captures/0/cases/1/cause',
              sha256: '4865a3aaf96054fcc42d01e57dab0e459db963d9fb934b8b3ea57244464b27f4',
              replicatedPointers: ['/captures/0/cases/1/cause', '/captures/1/cases/1/cause'],
            },
            {
              id: 'proof0-case2',
              pointer: '/captures/0/cases/2/cause',
              sha256: '07063c32695e34548976e74e0824b05e49f695413ee5eec523c39db9bce11380',
              replicatedPointers: ['/captures/0/cases/2/cause', '/captures/1/cases/2/cause'],
            },
            {
              id: 'proof0-case3',
              pointer: '/captures/0/cases/3/cause',
              sha256: '2e2d4f59942c692b7cf8ab46456c442e22affe5639d10713e96777169b49c5a7',
              replicatedPointers: ['/captures/0/cases/3/cause', '/captures/1/cases/3/cause'],
            },
            {
              id: 'proof0-case4',
              pointer: '/captures/0/cases/4/cause',
              sha256: '32ee1ce8f144ee53eef7810d458dbf3446c1648151e316e1d80acbc937653c9e',
              replicatedPointers: ['/captures/0/cases/4/cause', '/captures/1/cases/4/cause'],
            },
          ],
        },
        {
          path: 'mirage/test/fixtures/webapi-native-scalar-reader.json',
          sha256: 'ca297cf7e3fd91a1ae9fd4a4b4e22eda260c517b384c7747bf71c295809e140b',
          mode: 'reproduced-native',
          capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
          facts: [
            {
              id: 'empty-boolean',
              pointer: '/cases/36/cause',
              sha256: '7cf7c207fe1c61a72499a908eb8c526518bcf3f8a0981931e4b7b474207c8357',
              equalBodyHashesPointer: '/cases/36/nativeBodySha256',
            },
          ],
        },
      ],
      supplementalWitness: {
        path: 'mirage/test/fixtures/dataverse-batch23-scalar272-facts-v2.json',
        sha256: '7e3f4e05c34ce6c50bc7121af4252d17b444d8305b4763662f3261d97eb83250',
        legacyProofSha256: 'ca297cf7e3fd91a1ae9fd4a4b4e22eda260c517b384c7747bf71c295809e140b',
        factId: 'empty-boolean',
      },
    },
  ]);
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('./fixtures/dataverse-existing-scalar-causes.json', import.meta.url)))
      .digest('hex'),
    '94e865d6371e16fc3ccfeb18da17857c01da56f233e2f6a5fa57af605adaaa0e',
  );
  assert.equal(
    createHash('sha256')
      .update(readFileSync(new URL('./fixtures/webapi-native-scalar-reader.json', import.meta.url)))
      .digest('hex'),
    'ca297cf7e3fd91a1ae9fd4a4b4e22eda260c517b384c7747bf71c295809e140b',
  );
  for (const type of ['Edm.String', 'Edm.Int32', 'Edm.Decimal', 'Edm.Double'])
    assert.equal(
      dataverseScalarCause(true, type),
      `Cannot convert the literal 'True' to the expected type '${type}'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Boolean' to the expected target type '${type}'.`,
    );
  assert.equal(
    dataverseScalarCause('', 'Edm.Boolean'),
    "Cannot convert the literal '' to the expected type 'Edm.Boolean'. ---> System.FormatException: String was not recognized as a valid Boolean.",
  );
  assert.equal(
    dataverseScalarCause('2020-02-30', 'Edm.Date'),
    "Cannot convert the literal '2020-02-30' to the expected type 'Edm.Date'. ---> System.FormatException: String '2020-02-30' was not recognized as a valid Edm.Date.",
  );
});

test('leading request BOM preserves numeric lexemes and nested ambiguity without accepting extra BOMs', () => {
  const facts = scalarNumberLexemes('\uFEFF{"name":9007199254740993,"a":1.0,"nested":{"a":1},"label":"\uFEFFinside"}');
  assert.equal(
    facts('name', {
      $type: 'DataverseNumeric',
      numericType: 'Literal',
      value: '9007199254740993',
    }),
    '9007199254740993',
  );
  assert.equal(facts('a', 1), undefined);
  for (const source of ['\uFEFF\uFEFF{}', ' \uFEFF{}']) assert.throws(() => scalarNumberLexemes(source), SyntaxError);
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings 13ba995f0b39661c', () => {
  // @parity-evidence: Tooling-only exposure of the existing source/run/fact/case validator; the same helper and module URL execute once, with every protected binding unchanged.
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});
