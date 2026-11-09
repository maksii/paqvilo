// @test-kind tooling: Source and evidence migration checks use invented cases and do not claim platform parity.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  verifyCaseMigration,
  caseMigrationAstHash as hash,
  caseMigrationSourceHash as digest,
} from '../scripts/parity-case-migration.mjs';

const { parse } = createRequire(import.meta.url)('espree');
const parsed = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
const reviewed = {
  reviewedBy: 'invented reviewer',
  reason: 'Explicitly reviewed invented source and repeated evidence.',
  factIds: ['invented-fact'],
};
function calls(node) {
  const found = [];
  function walk(item) {
    if (item.type === 'CallExpression' && item.callee?.object?.name === 'assert') found.push(item);
    for (const value of Object.values(item))
      for (const child of Array.isArray(value) ? value : [value]) if (child?.type) walk(child);
  }
  walk(node);
  return found;
}
function setup(filter = null) {
  const baselineRows = Array.from({ length: 193 }, (_, index) => [`case ${index + 1}`, index === 138 ? true : index]);
  if (filter) for (let i = 0; i < 2; i++) baselineRows[i][0] = `${filter.prefix}${i}`;
  const rows = baselineRows.map((row, index) => (index === 138 ? [row[0], { errorKind: 25 }] : row));
  const matrixResults = rows.map(([expression], index) =>
    index === 138
      ? { expression, kind: 'error', type: 'ErrorValue', errors: [{ kind: 'InvalidArgument' }] }
      : { expression, kind: 'value', value: index },
  );
  const runs = [
    { identitySha256: 'a'.repeat(64), resultsSha256: 'c'.repeat(64), results: matrixResults },
    { identitySha256: 'b'.repeat(64), resultsSha256: 'c'.repeat(64), results: matrixResults },
  ];
  const captures = runs.map((run, index) => ({
    processId: index + 1,
    identitySha256: run.identitySha256,
    resultsSha256: run.resultsSha256,
    unprivilegedZeroCapabilities: true,
    zeroCaps: true,
  }));
  const values = ['p', 'c', 'b'].map((prefix, index) => ({
    id: prefix,
    raw: JSON.stringify({
      source: { allCasesSha256: digest(JSON.stringify(rows)) },
      runs,
      captures,
      qualified:
        index === 0
          ? [
              { expression: rows[0][0], value: 0, ...(filter ? { status: filter.state } : {}) },
              { expression: rows[1][0], value: 1, ...(filter ? { status: filter.state } : {}) },
            ]
          : index === 1
            ? [{ expression: rows[2][0], value: 2 }]
            : [{ expression: rows[3][0], value: 3 }],
    }),
  }));
  const imports = "import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';";
  const functionSource = 'function run(formula) { return formula; }';
  const declarations = values
    .map(
      ({ id }) =>
        `const ${id}Data = JSON.parse(fs.readFileSync(new URL('./${id}.json', import.meta.url))); const ${id}Map = new Map(${id}Data.qualified${filter && id === 'p' ? `.filter((row) => row.expression.startsWith(${JSON.stringify(filter.prefix)}) && row.status === ${JSON.stringify(filter.state)})` : ''}.map(({ expression, value }) => [expression, value]));`,
    )
    .join('\n');
  const legacy = JSON.stringify({ captures: [{ empty: true }, { empty: true }] }),
    legacyHash = digest(legacy);
  const guidEvidence = {
      captures: [
        {
          captureScriptSha256: 'd'.repeat(64),
          cases: [{ expression: rows[138][0] }, { expression: `IfError(${rows[138][0]},FirstError.Kind=25)` }],
          results: [
            { kind: 'error', message: 'Invalid argument' },
            { kind: 'value', value: true },
          ],
          receipts: [
            { run: 1, rawSha256: 'e'.repeat(64), executableSha256: 'f'.repeat(64), emptyAuthenticationProfiles: true },
            { run: 2, rawSha256: 'e'.repeat(64), executableSha256: 'f'.repeat(64), emptyAuthenticationProfiles: true },
          ],
        },
      ],
    },
    guidRaw = JSON.stringify(guidEvidence),
    guidSha = digest(guidRaw);
  const oldAuth = 'assert.ok(proof.captures.every(({ empty }) => empty));';
  const oldChecks = Array.from({ length: 17 }, (_, index) => `assert.equal(${index}, ${index});`).join(' ');
  const oldHelperA = `test('helper-a', () => { const bytes = fs.readFileSync(new URL('./p.json', import.meta.url)); const hash = (value) => createHash('sha256').update(value).digest('hex'); const proof = JSON.parse(bytes); ${oldChecks} ${oldAuth} });`;
  const newHelperA = `test('helper-a', () => { const bytes = fs.readFileSync(new URL('./p.json', import.meta.url)); const hash = (value) => createHash('sha256').update(value).digest('hex'); const proof = JSON.parse(bytes); ${oldChecks} { const legacyBytes = fs.readFileSync(new URL('./legacy.json', import.meta.url)); assert.equal(hash(legacyBytes), '${legacyHash}'); const proof = JSON.parse(legacyBytes); ${oldAuth} } assert.ok(proof.captures.every(({ zeroCaps }) => zeroCaps)); });`;
  const helper = (id, offset) =>
    `test('helper-${id}', () => { ${Array.from({ length: 18 }, (_, index) => `assert.equal(${offset + index}, ${offset + index});`).join(' ')} });`;
  const helpers = [oldHelperA, helper('b', 18), helper('c', 36)].join('\n');
  const nextHelpers = [newHelperA, helper('b', 18), helper('c', 36)].join('\n');
  const original = 'assert.deepEqual(run(formula), expected)';
  const title = '`Case ${formula}`';
  const guidBody = `const bytes = fs.readFileSync(new URL('./guid.json', import.meta.url)); assert.equal(createHash('sha256').update(bytes).digest('hex'), '${guidSha}'); const proof = JSON.parse(bytes).captures[0]; assert.equal(proof.captureScriptSha256, '${'d'.repeat(64)}'); assert.equal(proof.cases[0].expression, formula); assert.equal(proof.results[0].kind, 'error'); assert.equal(proof.cases[1].expression, \`IfError(\${formula},FirstError.Kind=\${expected.errorKind})\`); assert.deepEqual(proof.results[1], { kind: 'value', value: true }); assert.throws(() => run(formula), (error) => error.code === expected.errorKind);`;
  const proof = ['p', 'c', 'b'].map((id) => `assert.deepEqual(${id}Map.get(formula), expected, '${id} proof');`);
  const loops =
    ['p', 'c', 'b']
      .map(
        (id, index) =>
          `for (const [formula, expected] of scenarios.filter(([formula]) => ${id}Map.has(formula))) { test(${title}, () => { ${proof[index]} ${original}; }); }`,
      )
      .join('\n') +
    `\nfor (const [formula, expected] of scenarios.filter(([, expected]) => expected?.errorKind)) { test(${title}, () => { ${guidBody} }); }\nfor (const [formula, expected] of scenarios.filter(([formula, expected]) => !pMap.has(formula) && !cMap.has(formula) && !bMap.has(formula) && !expected?.errorKind)) { test(${title}, () => ${original}); }`;
  const candidateLoop = `for (const [formula, expected] of scenarios) { const snapshot = [pMap.has(formula), cMap.has(formula), bMap.has(formula), Boolean(expected?.errorKind)]; test(${title}, () => { if (snapshot[0]) { ${proof[0]} } else if (snapshot[1]) { ${proof[1]} } else if (snapshot[2]) { ${proof[2]} } if (snapshot[3]) { ${guidBody} return; } return ${original}; }); }`;
  const baselineSource = `${imports} ${functionSource} const scenarios = ${JSON.stringify(baselineRows)}; for (const [formula, expected] of scenarios) { test(${title}, () => ${original}); }`;
  const common = `${imports} ${functionSource} const scenarios = ${JSON.stringify(rows)}; ${declarations}`;
  const currentSource = common + helpers + loops,
    candidateSource = common + nextHelpers + candidateLoop;
  const bAst = parsed(baselineSource),
    cAst = parsed(currentSource),
    candAst = parsed(candidateSource);
  const declaration = (ast) =>
    ast.body.find((node) => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'scenarios')
      .declarations[0].init;
  const b = declaration(bAst),
    c = declaration(cAst),
    d = declaration(candAst);
  const guidLoop = cAst.body.filter((node) => node.type === 'ForOfStatement')[3],
    guid = guidLoop.body.body[0].expression.arguments[1].body;
  const retainedRegistrations = ['a', 'b', 'c'].map((id) => ({ ...reviewed, title: `helper-${id}`, count: 18 }));
  const helperNode = cAst.body.find(
    (node) => node.type === 'ExpressionStatement' && node.expression.arguments[0]?.value === 'helper-a',
  );
  const candidateHelperNode = candAst.body.find(
    (node) => node.type === 'ExpressionStatement' && node.expression.arguments[0]?.value === 'helper-a',
  );
  const currentHelperAssertions = calls(helperNode),
    candidateHelperAssertions = calls(candidateHelperNode);
  const authAssertion = currentHelperAssertions.at(-1);
  const addedAssertions = candidateHelperAssertions.filter(
    (node) => !currentHelperAssertions.some((old) => hash(old) === hash(node)),
  );
  const partitions = values.map(({ id, raw }, index) => ({
    ...reviewed,
    mapBinding: `${id}Map`,
    evidenceBinding: `${id}Data`,
    evidenceId: id,
    currentEvidenceId: id,
    sha256: digest(raw),
    currentSha256: digest(raw),
    relativePath: `./${id}.json`,
    currentRelativePath: `./${id}.json`,
    list: 'qualified',
    key: 'expression',
    value: 'value',
    count: index === 0 ? 2 : 1,
    currentCount: index === 0 ? 2 : 1,
    ...(index === 0 && filter ? { filter: { prefixField: 'expression', stateField: 'status', ...filter } } : {}),
  }));
  const review = {
    ...reviewed,
    baselineSha256: digest(baselineSource),
    currentSha256: digest(currentSource),
    candidateSha256: digest(candidateSource),
    matrixBinding: { ...reviewed, evidenceId: 'p', sha256: digest(values[0].raw), pointer: '/source/allCasesSha256' },
    caseCount: 193,
    caseBinding: 'scenarios',
    snapshotBinding: 'snapshot',
    guidProperty: 'errorKind',
    corrections: [
      {
        ...reviewed,
        caseIndex: 138,
        baselineAstSha256: hash(b.elements[138]),
        currentAstSha256: hash(c.elements[138]),
        candidateAstSha256: hash(d.elements[138]),
      },
    ],
    partitions,
    moduleReplacements: [
      { ...reviewed, currentAstSha256: hash(helperNode), candidateAstSha256: hash(candidateHelperNode) },
    ],
    moduleAdditions: [],
    assertionReplacements: [],
    metadataBindings: [],
    capabilityBinding: {
      ...reviewed,
      registration: 'helper-a',
      evidenceId: 'p',
      relativePath: './p.json',
      bytesBinding: 'bytes',
      proofBinding: 'proof',
      hashBinding: 'hash',
      hashArgument: 'value',
      cryptoBinding: 'createHash',
      property: 'zeroCaps',
      assertionAstSha256: hash(candidateHelperAssertions.at(-1)),
    },
    assertionAdditions: addedAssertions.map((node) => ({ ...reviewed, candidateAstSha256: hash(node) })),
    retainedRegistrations,
    retainedAssertionCount: 54,
    mustRetainAssertions: [
      {
        ...reviewed,
        astSha256: hash(authAssertion),
        evidenceBinding: {
          ...reviewed,
          evidenceId: 'legacy',
          sha256: legacyHash,
          relativePath: './legacy.json',
          bytesBinding: 'legacyBytes',
          proofBinding: 'proof',
          hashBinding: 'hash',
          property: 'empty',
        },
      },
    ],
    guid: {
      ...reviewed,
      setupAstSha256: [hash(guid.body[0]), hash(guid.body[2])],
      evidenceId: 'guid',
      sha256: guidSha,
      relativePath: './guid.json',
      bytesBinding: 'bytes',
      hashBinding: 'createHash',
      proofBinding: 'proof',
      captureIndex: 0,
      factBindings: [
        { factId: 'error', pointer: '/captures/0/results/0', sha256: hash(guidEvidence.captures[0].results[0]) },
        { factId: 'predicate', pointer: '/captures/0/results/1', sha256: hash(guidEvidence.captures[0].results[1]) },
      ],
    },
    guidAssertionSha256: calls(guid).map(hash),
    selected: [0, 1, 2, 3, 4],
  };
  return {
    baselineSource,
    currentSource,
    candidateSource,
    review,
    evidence: {
      ...Object.fromEntries(values.map(({ id, raw }) => [id, Buffer.from(raw)])),
      legacy: Buffer.from(legacy),
      guid: Buffer.from(guidRaw),
    },
  };
}
test('reconstructs all paths and retains proof assertions from source and evidence', () => {
  const input = setup(),
    result = verifyCaseMigration(input);
  assert.equal(result.rows.length, 193);
  assert.equal(result.helperAssertions.length, 54);
  assert.deepEqual(result.historicalIndices, [0, 1, 2, 3]);
  assert.equal(result.eligibleIndices.length, 192);
  assert.equal(result.eligibleIndices.includes(138), false);
  assert.equal(result.rows[138].sutCalls, 1);
  assert.equal(result.requiresAllRegistrations, true);
});
test('matches hostile filter values as literals and rejects altered source semantics', () => {
  const filter = { prefix: `x"'); globalThis.compromised = true; //\\`, state: `\\"\n'); throw Error('x');//` };
  const input = setup(filter);
  assert.equal(verifyCaseMigration(input).rows.length, 193);
  const changed = structuredClone(input);
  changed.candidateSource = changed.candidateSource.replace(
    JSON.stringify(filter.state),
    JSON.stringify(`${filter.state}x`),
  );
  changed.review.candidateSha256 = digest(changed.candidateSource);
  assert.throws(() => verifyCaseMigration(changed), /case-migration-map-binding/);
});
test('rejects reordered and duplicated cases and mismatched proof values', () => {
  const input = setup();
  for (const edit of [
    (text) => text.replace('["case 1",0]', '["case 1",1]'),
    (text) => text.replace('["case 2",1]', '["case 1",1]'),
  ]) {
    const candidateSource = edit(input.candidateSource);
    assert.notEqual(candidateSource, input.candidateSource);
    assert.throws(() =>
      verifyCaseMigration({
        ...input,
        candidateSource,
        review: { ...input.review, candidateSha256: digest(candidateSource) },
      }),
    );
  }
  const evidence = { ...input.evidence, p: Buffer.from('{"qualified":[]}') };
  assert.throws(() => verifyCaseMigration({ ...input, evidence }));
});
test('rejects skip, extra SUT call, async and altered GUID assertions', () => {
  const input = setup();
  for (const edit of [
    (text) => text.replace('return assert.deepEqual(run(formula), expected);', 'return;'),
    (text) =>
      text.replace(
        'return assert.deepEqual(run(formula), expected);',
        'run(formula); return assert.deepEqual(run(formula), expected);',
      ),
    (text) =>
      text.replace(
        'test(`Case ${formula}`, () => { if (snapshot[0])',
        'test(`Case ${formula}`, async () => { if (snapshot[0])',
      ),
    (text) =>
      text.replace("assert.equal(proof.results[0].kind, 'error');", "assert.equal(proof.results[0].kind, 'value');"),
  ]) {
    const candidateSource = edit(input.candidateSource);
    assert.notEqual(candidateSource, input.candidateSource);
    assert.throws(() =>
      verifyCaseMigration({
        ...input,
        candidateSource,
        review: { ...input.review, candidateSha256: digest(candidateSource) },
      }),
    );
  }
});
test('rejects unreviewed module and helper changes or a selected GUID path', () => {
  const input = setup();
  for (const edit of [
    (text) => text.replace('assert.equal(0, 0);', 'assert.equal(0, 1);'),
    (text) => text.replace('const pMap =', 'const hidden = 1; const pMap ='),
  ]) {
    const candidateSource = edit(input.candidateSource);
    assert.notEqual(candidateSource, input.candidateSource);
    assert.throws(() =>
      verifyCaseMigration({
        ...input,
        candidateSource,
        review: { ...input.review, candidateSha256: digest(candidateSource) },
      }),
    );
  }
  assert.throws(() => verifyCaseMigration({ ...input, review: { ...input.review, selected: [138] } }));
});

test('rejects repinned GUID facts that do not describe the original error and kind-25 predicate', () => {
  const input = setup();
  const wrongExpression = JSON.parse(input.evidence.guid.toString('utf8'));
  wrongExpression.captures[0].cases[0].expression = 'different expression';
  const wrongBytes = Buffer.from(JSON.stringify(wrongExpression));
  assert.throws(
    () =>
      verifyCaseMigration({
        ...input,
        evidence: { ...input.evidence, guid: wrongBytes },
        review: { ...input.review, guid: { ...input.review.guid, sha256: digest(wrongBytes) } },
      }),
    /case-guid-semantic-facts/u,
  );
  const wrongResult = JSON.parse(input.evidence.guid.toString('utf8'));
  wrongResult.captures[0].results[1].value = false;
  const wrongResultBytes = Buffer.from(JSON.stringify(wrongResult));
  const factBindings = input.review.guid.factBindings.map((item, index) =>
    index === 1 ? { ...item, sha256: hash(wrongResult.captures[0].results[1]) } : item,
  );
  assert.throws(
    () =>
      verifyCaseMigration({
        ...input,
        evidence: { ...input.evidence, guid: wrongResultBytes },
        review: { ...input.review, guid: { ...input.review.guid, sha256: digest(wrongResultBytes), factBindings } },
      }),
    /case-guid-semantic-facts/u,
  );
  const wrongMatrix = JSON.parse(input.evidence.p.toString('utf8'));
  for (const run of wrongMatrix.runs) run.results[138].type = 'StringValue';
  const wrongMatrixBytes = Buffer.from(JSON.stringify(wrongMatrix)),
    sha256 = digest(wrongMatrixBytes);
  const partitions = input.review.partitions.map((item) =>
    item.evidenceId === 'p' ? { ...item, sha256, currentSha256: sha256 } : item,
  );
  assert.throws(
    () =>
      verifyCaseMigration({
        ...input,
        evidence: { ...input.evidence, p: wrongMatrixBytes },
        review: { ...input.review, matrixBinding: { ...input.review.matrixBinding, sha256 }, partitions },
      }),
    /case-guid-matrix-error-value/u,
  );
});

test('rejects repinned capability evidence when either capture lacks the asserted guarantee', () => {
  const input = setup();
  const data = JSON.parse(input.evidence.p.toString('utf8'));
  data.captures[1].zeroCaps = false;
  const bytes = Buffer.from(JSON.stringify(data));
  const sha256 = digest(bytes);
  const partitions = input.review.partitions.map((item) =>
    item.evidenceId === 'p' ? { ...item, sha256, currentSha256: sha256 } : item,
  );
  assert.throws(
    () =>
      verifyCaseMigration({
        ...input,
        evidence: { ...input.evidence, p: bytes },
        review: { ...input.review, matrixBinding: { ...input.review.matrixBinding, sha256 }, partitions },
      }),
    /case-capability-evidence/u,
  );
});

test('rejects repinned hidden helper calls and filesystem writes', () => {
  for (const injected of ['run("hidden");', 'fs.writeFileSync("hidden", "data");', 'opaque();']) {
    const input = setup();
    const candidateSource = input.candidateSource.replace('assert.equal(0, 0);', `${injected} assert.equal(0, 0);`);
    const ast = parsed(candidateSource);
    const changed = ast.body.find(
      (node) => node.type === 'ExpressionStatement' && node.expression.arguments[0]?.value === 'helper-a',
    );
    const moduleReplacements = input.review.moduleReplacements.map((item) => ({
      ...item,
      candidateAstSha256: hash(changed),
    }));
    assert.throws(
      () =>
        verifyCaseMigration({
          ...input,
          candidateSource,
          review: { ...input.review, candidateSha256: digest(candidateSource), moduleReplacements },
        }),
      /case-unreviewed-module-content/u,
    );
  }
});
