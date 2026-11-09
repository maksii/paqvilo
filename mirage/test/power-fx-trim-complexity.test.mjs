import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
// @test-kind security: Power Fx trimming preserves ASCII-space semantics on unbounded input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { powerFxEngine } from '../lib/power-fx.mjs';

// @test-kind parity+security: All three exact original input and output equalities reproduce in two independent official package processes; the third expected value is the exact user-approved correction.
// @parity-evidence: Manifest guarantee official-20261108-trim-v2; exact capsule/run/fact/source bindings are asserted below.
test('Power Fx Trim and TrimEnds handle long interior space runs', () => {
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/power-fx-trim-complexity.test.mjs:6:0',
      repositoryRoot: '../..',
      titleExpressionSha256: 'cdfa0cba9471af676e0c827827fd1a25cbdbff7c8dc57c3486343e4b852b33e4',
      originalAssertions: [
        'ba1fc40f9a75f48d146c9a420ebfa71fe95be44ff1604c2db56bdc96552ba3a7',
        '4d70e499176a7cb529e165a16688d0035540a15df9252976a6c5686ff833a5b1',
        'a450b7738d366c69e1128357e26b1808a51bf678e94d480968cc64a479ef2510',
      ],
      baselineOriginalAssertions: [
        'ba1fc40f9a75f48d146c9a420ebfa71fe95be44ff1604c2db56bdc96552ba3a7',
        '4d70e499176a7cb529e165a16688d0035540a15df9252976a6c5686ff833a5b1',
        '325570949653ef499927c63c229f64ee084b3d6a1598910e5072114137068c4d',
      ],
      originalBodyAstSha256: 'fb5024ff50733d0fd3f6722cf38830218352ef853b0c64ca1254068bdb12a46a',
      baselineBodyAstSha256: '529061d0e5ed670945164e7e9c2714ccba915cbdf267996736e1d595f71a3e19',
      originalGuardHashes: [],
      moduleContextAstSha256: '13b43bf195e9c564a6e6fb71ff6107c2864fc79f8c2b9b7271def0dd88a9fb9c',
      moduleReview: {
        reviewedBy: 'canvas_official',
        reason:
          'Only the exact direct-user-approved TrimEnds expectation correction is source-bound and reproduced twice.',
        corrections: [
          {
            oldAstSha256: '325570949653ef499927c63c229f64ee084b3d6a1598910e5072114137068c4d',
            currentAstSha256: 'a450b7738d366c69e1128357e26b1808a51bf678e94d480968cc64a479ef2510',
            sameGuarantee: true,
            guaranteeId: 'official-20261108-trim-v2',
            factIds: ['trim-v2-2'],
            reviewedBy: 'canvas_official',
            reason:
              'The exact unchanged TrimEnds operation and tab/newline input reproduce x in both official package executions.',
          },
        ],
        addedTests: [],
      },
      securityApprovals: [
        {
          sha256: 'b3433b31c4c56faefafb6799edcd7a75850fc9e5c96b2a9ac843ff93463373e0',
          file: 'mirage/test/power-fx-trim-complexity.test.mjs',
          baselineId: 'mirage/test/power-fx-trim-complexity.test.mjs:6:0',
          originalAssertionSha256: '325570949653ef499927c63c229f64ee084b3d6a1598910e5072114137068c4d',
          currentAssertionSha256: 'a450b7738d366c69e1128357e26b1808a51bf678e94d480968cc64a479ef2510',
          operationAstSha256: 'badc615bd5f93c903256627c82dafe7f4ad3fdc852db20f2b14fbda5d895b8fa',
        },
      ],
      protectedSecurity: true,
      importRoles: [
        {
          source: '../lib/power-fx.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'canvas_official',
          reason: 'The Power Fx engine is the implementation under test and must remain changeable.',
        },
      ],
      runtimeInputs: [],
      inputDependencies: [],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: [
          {
            baselineId: 'mirage/test/power-fx-trim-complexity.test.mjs:6:0',
            title: 'Power Fx Trim and TrimEnds handle long interior space runs',
            inputGeneratorAstSha256: '0c0b7fbe77abbb505ee36bc7191aa7d1a3d61574b0a6fd9d58e007a4b05a0483',
            inputLength: 300002,
            inputSha256: 'c1cb7c6e172655e8f9199a6c26a5edc50655d484c76a6c2d12deac8f3137d858',
          },
        ],
        casesSha256: '01c56e766ef87976b77161c70c0d599b18e063c5b0391a942e025f32391393cc',
        sourceBindings: [],
        ancestorLoops: [],
      },
      proofs: [
        {
          path: 'mirage/test/fixtures/power-fx-official-20261108-trim-v2.json',
          sha256: '9b0e035efd153ccfece5c2c5fc6d1b9ef6a8ff73a871f252a314042e567eee4b',
          mode: 'official-package',
          capturePointers: ['/runs/0/rawSha256', '/runs/1/rawSha256'],
          package: {
            id: 'Microsoft.PowerApps.CLI',
            version: '2.13.1',
            sha256: '07654af406781c1676d1bc5712c393fab2276e54f15ff10bb74a1bdef0d27d3f',
            source:
              'https://api.nuget.org/v3-flatcontainer/microsoft.powerapps.cli/2.13.1/microsoft.powerapps.cli.2.13.1.nupkg',
          },
          packagePointer: '/package',
          facts: [
            {
              id: 'trim-v2-0',
              pointer: '/runs/0/results/0',
              sha256: 'a6b11e9840fc37333ea3f76ae93e3d3e756defff5a38c42b6dad03c41c160edb',
              replicatedPointers: ['/runs/0/results/0', '/runs/1/results/0'],
            },
            {
              id: 'trim-v2-1',
              pointer: '/runs/0/results/1',
              sha256: '4c1ec1d167c6be23760326db485fa58644cb63ccdd9ed378437153df4728bc9d',
              replicatedPointers: ['/runs/0/results/1', '/runs/1/results/1'],
            },
            {
              id: 'trim-v2-2',
              pointer: '/runs/0/results/2',
              sha256: 'e72f715c955ee2f16faa6388df576df560b0c9406431696ba645956aa5c77077',
              replicatedPointers: ['/runs/0/results/2', '/runs/1/results/2'],
            },
          ],
        },
      ],
    },
  ]);
  const spaces = ' '.repeat(100_000);
  const evaluate = (formula, value) =>
    powerFxEngine.evaluateSync(formula, { host: { variables: {} }, values: { value } }).value;
  assert.equal(evaluate('TrimEnds(value)', `${spaces}x${spaces}y${spaces}`), `x${spaces}y`);
  assert.equal(evaluate('Trim(value)', `${spaces}x${spaces}y${spaces}`), 'x y');
  // @parity-evidence: power-fx-batch-official-evidence.json binds two official executions of the unchanged TrimEnds(value) with this exact bound input, returning x.
  assert.equal(evaluate('TrimEnds(value)', '\t x \n'), 'x');
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings 6b18ac79e18564fd', () => {
  // @parity-evidence: Tooling-only exposure of the existing source/run/fact/case validator; the same helper and module URL execute once, with every protected binding unchanged.
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});
