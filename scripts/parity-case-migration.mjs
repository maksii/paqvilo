// Verify one bounded five-partition-to-snapshot case migration from source and evidence.
// This checks preservation and reviewed bindings; it does not determine platform parity.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { hashAst as astHash } from './parity-ast-utils.mjs';

const { parse } = createRequire(import.meta.url)('espree');
const parseSource = (source) => parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export { hashAst as caseMigrationAstHash } from './parity-ast-utils.mjs';
export const caseMigrationSourceHash = digest;
const check = (value, reason) => {
  if (!value) throw Object.assign(new Error(reason), { qualificationCode: reason });
};
const sourceOf = (source, node) => source.slice(node.range[0], node.range[1]);
const identifier = (name) => {
  check(typeof name === 'string' && /^[A-Za-z_$][\w$]*$/u.test(name), 'invalid-case-migration-identifier');
  return name;
};
function walk(node, fn, parent = null) {
  fn(node, parent);
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value]) if (child?.type) walk(child, fn, node);
}
function value(node) {
  if (node?.type === 'Literal') {
    check(
      node.value === null ||
        ['string', 'boolean'].includes(typeof node.value) ||
        (typeof node.value === 'number' && Number.isFinite(node.value)),
      'nonliteral-case-value',
    );
    return node.value;
  }
  if (
    node?.type === 'UnaryExpression' &&
    node.operator === '-' &&
    node.argument.type === 'Literal' &&
    typeof node.argument.value === 'number' &&
    Number.isFinite(node.argument.value)
  )
    return -node.argument.value;
  if (node?.type === 'ArrayExpression') return node.elements.map(value);
  if (node?.type === 'ObjectExpression')
    return Object.fromEntries(
      node.properties.map((property) => {
        check(
          property.type === 'Property' &&
            property.kind === 'init' &&
            !property.computed &&
            !property.method &&
            !property.shorthand &&
            !['__proto__', 'constructor', 'prototype'].includes(property.key.name ?? property.key.value),
          'nonliteral-case-value',
        );
        return [property.key.name ?? property.key.value, value(property.value)];
      }),
    );
  check(false, 'nonliteral-case-value');
}
function declaration(ast, name) {
  const found = ast.body.filter(
    (node) => node.type === 'VariableDeclaration' && node.declarations.some((item) => item.id?.name === name),
  );
  check(
    found.length === 1 && found[0].kind === 'const' && found[0].declarations.length === 1,
    'case-migration-binding',
  );
  return found[0];
}
function assertions(node) {
  const out = [];
  walk(node, (item) => {
    if (
      item.type === 'CallExpression' &&
      item.callee?.type === 'MemberExpression' &&
      item.callee.object?.name === 'assert'
    )
      out.push(item);
  });
  return out;
}
function proofReview(item, reason) {
  check(
    item &&
      typeof item.reviewedBy === 'string' &&
      item.reviewedBy.trim() &&
      typeof item.reason === 'string' &&
      item.reason.trim().length >= 20 &&
      Array.isArray(item.factIds) &&
      item.factIds.length > 0 &&
      item.factIds.every((id) => typeof id === 'string' && id.length > 0),
    reason,
  );
}
function pointer(root, selector) {
  check(typeof selector === 'string' && selector.startsWith('/'), 'invalid-case-evidence-pointer');
  let current = root;
  for (const token of selector.slice(1).split('/')) {
    check(!/~(?![01])/u.test(token), 'invalid-case-evidence-pointer');
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    check(
      current !== null && typeof current === 'object' && Object.hasOwn(current, key),
      'missing-case-evidence-pointer',
    );
    current = current[key];
  }
  return current;
}

/**
 * Sources and evidence bytes are read by the caller from their authoritative locations.
 * Review data supplies explicit corrections and proof links, never a precomputed verifier result.
 */
export function verifyCaseMigration({ baselineSource, currentSource, candidateSource, review, evidence }) {
  const verifyReviewSources = () => {
    for (const [source, expected] of [
      [baselineSource, review?.baselineSha256],
      [currentSource, review?.currentSha256],
      [candidateSource, review?.candidateSha256],
    ])
      check(
        typeof source === 'string' && /^[a-f0-9]{64}$/u.test(expected) && digest(source) === expected,
        'case-migration-source-hash',
      );
    proofReview(review, 'case-migration-review-required');
    check(
      review.caseCount === 193 &&
        Array.isArray(review.partitions) &&
        review.partitions.length === 3 &&
        Array.isArray(review.corrections) &&
        Array.isArray(review.moduleReplacements) &&
        review.moduleReplacements.length <= 3 &&
        Array.isArray(review.moduleAdditions) &&
        review.moduleAdditions.length === 0 &&
        Array.isArray(review.assertionReplacements) &&
        Array.isArray(review.assertionAdditions) &&
        Array.isArray(review.retainedRegistrations) &&
        Array.isArray(review.metadataBindings) &&
        Array.isArray(review.mustRetainAssertions) &&
        review.mustRetainAssertions.length > 0,
      'invalid-case-migration-review',
    );
  };
  verifyReviewSources();
  const caseName = identifier(review.caseBinding),
    baseline = parseSource(baselineSource),
    current = parseSource(currentSource),
    candidate = parseSource(candidateSource);
  const models = [
    [baseline, baselineSource],
    [current, currentSource],
    [candidate, candidateSource],
  ];
  const caseDeclarations = models.map(([ast]) => declaration(ast, caseName));
  const elements = caseDeclarations.map((node) => {
    const init = node.declarations[0].init;
    check(init?.type === 'ArrayExpression' && init.elements.length === 193, 'case-migration-count');
    return init.elements;
  });
  const cases = elements.map((rows) => rows.map(value));
  const corrections = new Map();
  const verifyCorrection = (item) => {
    proofReview(item, 'case-correction-review-required');
    check(
      Number.isInteger(item.caseIndex) &&
        item.caseIndex >= 0 &&
        item.caseIndex < 193 &&
        !corrections.has(item.caseIndex),
      'invalid-case-correction',
    );
    corrections.set(item.caseIndex, item);
  };
  for (const item of review.corrections) verifyCorrection(item);
  const verifyAllCases = () => {
    for (let i = 0; i < 193; i++) {
      for (const table of cases)
        check(Array.isArray(table[i]) && table[i].length === 2 && typeof table[i][0] === 'string', 'invalid-case-row');
      check(cases[0][i][0] === cases[1][i][0] && cases[0][i][0] === cases[2][i][0], 'case-migration-order');
      const row = corrections.get(i),
        changed =
          astHash(elements[0][i]) !== astHash(elements[2][i]) || astHash(elements[1][i]) !== astHash(elements[2][i]);
      if (changed) {
        check(
          row &&
            row.baselineAstSha256 === astHash(elements[0][i]) &&
            row.currentAstSha256 === astHash(elements[1][i]) &&
            row.candidateAstSha256 === astHash(elements[2][i]),
          'unreviewed-case-correction',
        );
      } else check(!row, 'unused-case-correction');
    }
  };
  verifyAllCases();
  check(new Set(cases[2].map((row) => row[0])).size === 193, 'duplicate-case-expression');
  const verifyMatrixEvidence = () => {
    proofReview(review.matrixBinding, 'case-matrix-binding-review');
    check(
      typeof review.matrixBinding.evidenceId === 'string' && Object.hasOwn(evidence, review.matrixBinding.evidenceId),
      'case-matrix-evidence-required',
    );
    const matrixBytes = evidence[review.matrixBinding.evidenceId];
    const matrixEvidence = JSON.parse(Buffer.from(matrixBytes).toString('utf8'));
    check(
      (typeof matrixBytes === 'string' || matrixBytes instanceof Uint8Array) &&
        digest(matrixBytes) === review.matrixBinding.sha256 &&
        pointer(matrixEvidence, review.matrixBinding.pointer) === digest(JSON.stringify(cases[2])),
      'case-matrix-evidence-binding',
    );
    return matrixEvidence;
  };
  const matrixEvidence = verifyMatrixEvidence();
  const verifyRegistrations = () => {
    const loops = models.map(([ast]) =>
      ast.body.filter(
        (node) =>
          node.type === 'ForOfStatement' &&
          node.left?.declarations?.[0]?.id?.type === 'ArrayPattern' &&
          (node.right?.name === caseName ||
            (node.right?.type === 'CallExpression' &&
              node.right.callee?.type === 'MemberExpression' &&
              node.right.callee.object?.name === caseName)),
      ),
    );
    check(loops[0].length === 1 && loops[1].length === 5 && loops[2].length === 1, 'case-migration-loop-count');
    const originalLoop = loops[0][0],
      pattern = originalLoop.left.declarations[0].id,
      formula = identifier(pattern.elements[0]?.name),
      expected = identifier(pattern.elements[1]?.name);
    check(
      pattern.elements.length === 2 &&
        originalLoop.right.type === 'Identifier' &&
        originalLoop.right.name === caseName &&
        loops[1].every((loop) => astHash(loop.left) === astHash(originalLoop.left)) &&
        astHash(loops[2][0].left) === astHash(originalLoop.left),
      'case-migration-loop-binding',
    );
    const getCallback = (loop, snapshot = false) => {
      check(
        loop.body.type === 'BlockStatement' && loop.body.body.length === (snapshot ? 2 : 1),
        'case-migration-registration',
      );
      const registration = loop.body.body[snapshot ? 1 : 0]?.expression;
      check(
        registration?.type === 'CallExpression' &&
          registration.callee?.type === 'Identifier' &&
          registration.arguments.length === 2 &&
          registration.arguments[0]?.type === 'TemplateLiteral' &&
          registration.arguments[1]?.type === 'ArrowFunctionExpression' &&
          !registration.arguments[1].async &&
          registration.arguments[1].params.length === 0,
        'case-migration-registration',
      );
      return { registration, callback: registration.arguments[1] };
    };
    const original = getCallback(originalLoop),
      currentRows = loops[1].map((loop) => getCallback(loop)),
      next = getCallback(loops[2][0], true);
    check(
      original.callback.expression && assertions(original.callback).length === 1,
      'case-migration-original-assertion',
    );
    const originalAssert = original.callback.body,
      originalCalls = assertions(original.callback);
    check(
      originalCalls[0] === originalAssert &&
        originalAssert.callee?.property?.name === 'deepEqual' &&
        originalAssert.arguments.length === 2 &&
        originalAssert.arguments[0]?.type === 'CallExpression' &&
        originalAssert.arguments[0].callee?.type === 'Identifier' &&
        originalAssert.arguments[0].arguments.length === 1 &&
        originalAssert.arguments[0].arguments[0]?.name === formula &&
        originalAssert.arguments[1]?.name === expected,
      'case-migration-original-assertion',
    );
    const sutName = identifier(originalAssert.arguments[0].callee.name),
      testName = identifier(original.registration.callee.name);
    for (const row of currentRows)
      check(
        row.registration.callee.name === testName &&
          astHash(row.registration.arguments[0]) === astHash(original.registration.arguments[0]),
        'case-migration-title',
      );
    return { loops, originalLoop, formula, expected, original, currentRows, next, originalAssert, sutName, testName };
  };
  const { loops, originalLoop, formula, expected, original, currentRows, next, originalAssert, sutName, testName } =
    verifyRegistrations();
  const maps = [],
    oldMaps = [],
    mapNames = [],
    evidenceHashes = {};
  const verifyPartition = (i) => {
    const partition = review.partitions[i];
    proofReview(partition, 'case-partition-review-required');
    const mapName = identifier(partition.mapBinding),
      dataBinding = identifier(partition.evidenceBinding),
      key = identifier(partition.key),
      val = identifier(partition.value),
      list = identifier(partition.list);
    check(
      typeof partition.evidenceId === 'string' &&
        evidence &&
        Object.hasOwn(evidence, partition.evidenceId) &&
        /^[a-f0-9]{64}$/u.test(partition.sha256),
      'case-evidence-required',
    );
    const bytes = evidence[partition.evidenceId];
    check(
      (typeof bytes === 'string' || bytes instanceof Uint8Array) && digest(bytes) === partition.sha256,
      'case-evidence-hash',
    );
    evidenceHashes[partition.evidenceId] = partition.sha256;
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    let rows = pointer(parsed, '/' + list);
    check(Array.isArray(rows), 'case-evidence-rows');
    check(
      typeof partition.currentEvidenceId === 'string' &&
        Object.hasOwn(evidence, partition.currentEvidenceId) &&
        /^[a-f0-9]{64}$/u.test(partition.currentSha256),
      'case-current-evidence-required',
    );
    const oldBytes = evidence[partition.currentEvidenceId];
    check(
      (typeof oldBytes === 'string' || oldBytes instanceof Uint8Array) && digest(oldBytes) === partition.currentSha256,
      'case-current-evidence-hash',
    );
    evidenceHashes[partition.currentEvidenceId] = partition.currentSha256;
    let oldRows = pointer(JSON.parse(Buffer.from(oldBytes).toString('utf8')), '/' + list);
    check(Array.isArray(oldRows), 'case-current-evidence-rows');
    let filterSource = '',
      filterValues = null;
    if (partition.filter) {
      const prefixField = identifier(partition.filter.prefixField),
        stateField = identifier(partition.filter.stateField);
      check(
        typeof partition.filter.prefix === 'string' && typeof partition.filter.state === 'string',
        'case-evidence-filter',
      );
      filterSource = `.filter((row) => row.${prefixField}.startsWith("") && row.${stateField} === "")`;
      filterValues = [partition.filter.prefix, partition.filter.state];
      rows = rows.filter(
        (row) =>
          typeof row[prefixField] === 'string' &&
          row[prefixField].startsWith(partition.filter.prefix) &&
          row[stateField] === partition.filter.state,
      );
      oldRows = oldRows.filter(
        (row) =>
          typeof row[prefixField] === 'string' &&
          row[prefixField].startsWith(partition.filter.prefix) &&
          row[stateField] === partition.filter.state,
      );
    }
    const pairs = rows.map((row) => {
        check(row && typeof row[key] === 'string' && Object.hasOwn(row, val), 'case-evidence-row');
        return [row[key], row[val]];
      }),
      map = new Map(pairs);
    check(map.size === rows.length && rows.length === partition.count, 'case-evidence-duplicates');
    const oldPairs = oldRows.map((row) => {
        check(row && typeof row[key] === 'string' && Object.hasOwn(row, val), 'case-current-evidence-row');
        return [row[key], row[val]];
      }),
      oldMap = new Map(oldPairs);
    check(
      oldMap.size === oldRows.length && oldRows.length === partition.currentCount,
      'case-current-evidence-duplicates',
    );
    if (i === 1) check(astHash(oldRows) === astHash(rows), 'case-clock-evidence-rows-changed');
    const expectedMap = parseSource(
      `const ${mapName} = new Map(${dataBinding}.${list}${filterSource}.map(({ ${key}, ${val} }) => [${key}, ${val}]));`,
    ).body[0];
    if (filterValues) {
      const predicate = expectedMap.declarations[0].init.arguments[0].callee.object.arguments[0].body;
      predicate.left.arguments[0].value = filterValues[0];
      predicate.right.right.value = filterValues[1];
    }
    check(
      astHash(declaration(current, mapName)) === astHash(expectedMap) &&
        astHash(declaration(candidate, mapName)) === astHash(expectedMap),
      'case-migration-map-binding',
    );
    check(
      typeof partition.relativePath === 'string' &&
        partition.relativePath.startsWith('./') &&
        !/[?#\\]/u.test(partition.relativePath),
      'case-evidence-path',
    );
    const data = parseSource(
      `const ${dataBinding} = JSON.parse(fs.readFileSync(new URL(${JSON.stringify(partition.relativePath)}, import.meta.url)));`,
    ).body[0];
    check(astHash(declaration(candidate, dataBinding)) === astHash(data), 'case-migration-evidence-binding');
    check(
      typeof partition.currentRelativePath === 'string' &&
        partition.currentRelativePath.startsWith('./') &&
        !/[?#\\]/u.test(partition.currentRelativePath),
      'case-current-evidence-path',
    );
    const oldData = parseSource(
      `const ${dataBinding} = JSON.parse(fs.readFileSync(new URL(${JSON.stringify(partition.currentRelativePath)}, import.meta.url)));`,
    ).body[0];
    check(astHash(declaration(current, dataBinding)) === astHash(oldData), 'case-migration-current-evidence-binding');
    maps.push(map);
    oldMaps.push(oldMap);
    mapNames.push(mapName);
  };
  for (let i = 0; i < 3; i++) verifyPartition(i);
  const excludedMapChecks = mapNames.map((map) => `!${map}.has(${formula})`).join(' && ');
  const guidProperty = identifier(review.guidProperty),
    expectedFilters = [
      ...mapNames.map((map) => `${caseName}.filter(([${formula}]) => ${map}.has(${formula}))`),
      `${caseName}.filter(([, ${expected}]) => ${expected}?.${guidProperty})`,
      `${caseName}.filter(([${formula}, ${expected}]) => ${excludedMapChecks} && !${expected}?.${guidProperty})`,
    ];
  const verifyCandidateSources = () => {
    for (const ast of [current, candidate]) {
      const parents = new Map();
      walk(ast, (node, parent) => parents.set(node, parent));
      const verifyCaseReference = (node, parent, grandparent) => {
        if (node.name !== caseName) return;
        if (
          (parent?.type === 'VariableDeclarator' && parent.id === node) ||
          (parent?.type === 'ForOfStatement' && parent.right === node)
        )
          return;
        if (parent?.type === 'CallExpression' && parent.arguments.includes(node)) {
          check(
            parent.callee?.type === 'MemberExpression' &&
              !parent.callee.computed &&
              parent.callee.object?.name === 'JSON' &&
              parent.callee.property.name === 'stringify',
            'case-migration-case-escape',
          );
          return;
        }
        check(parent?.type === 'MemberExpression' && parent.object === node, 'case-migration-case-escape');
        if (!parent.computed)
          check(['filter', 'flatMap', 'length'].includes(parent.property.name), 'case-migration-case-mutation');
        let target = parent,
          ancestor = grandparent;
        while (ancestor?.type === 'MemberExpression' && ancestor.object === target) {
          target = ancestor;
          ancestor = parents.get(ancestor);
        }
        check(
          !(ancestor?.type === 'AssignmentExpression' && ancestor.left === target) &&
            !(ancestor?.type === 'UpdateExpression' && ancestor.argument === target),
          'case-migration-case-mutation',
        );
      };
      walk(ast, (node, parent) => {
        if (node.type !== 'Identifier') return;
        const grandparent = parents.get(parent);
        if (mapNames.includes(node.name)) {
          if ((parent?.type === 'VariableDeclarator' && parent.id === node) || parent?.type === 'SpreadElement') return;
          check(
            parent?.type === 'MemberExpression' &&
              parent.object === node &&
              !parent.computed &&
              ['has', 'get'].includes(parent.property.name) &&
              grandparent?.type === 'CallExpression' &&
              grandparent.callee === parent,
            'case-migration-map-escape',
          );
        }
        verifyCaseReference(node, parent, grandparent);
      });
    }
  };
  verifyCandidateSources();
  for (let i = 0; i < 5; i++)
    check(
      astHash(loops[1][i].right) ===
        astHash(parseSource(`for (const [${formula}, ${expected}] of ${expectedFilters[i]}) {}`).body[0].right),
      'case-migration-partition-order',
    );
  const proofCalls = currentRows.slice(0, 3).map((row) => {
    const found = assertions(row.callback);
    check(
      found.length === 2 &&
        astHash(found[1]) === astHash(originalAssert) &&
        row.callback.body.type === 'BlockStatement' &&
        row.callback.body.body.length === 2 &&
        row.callback.body.body.every((statement) => statement.type === 'ExpressionStatement'),
      'case-migration-proof-path',
    );
    return found[0];
  });
  const verifyGuidContract = () => {
    const guidBody = currentRows[3].callback.body,
      guidAssertions = assertions(guidBody);
    check(
      guidBody.type === 'BlockStatement' &&
        guidBody.body.length === 9 &&
        guidBody.body[0].type === 'VariableDeclaration' &&
        guidBody.body[2].type === 'VariableDeclaration' &&
        guidBody.body.filter((statement) => statement.type === 'ExpressionStatement').length === 7 &&
        guidAssertions.length === 7 &&
        astHash(currentRows[4].callback.body) === astHash(originalAssert),
      'case-migration-guid-path',
    );
    const verifyGuidCapture = () => {
      proofReview(review.guid, 'case-guid-review-required');
      check(
        typeof review.guid.evidenceId === 'string' &&
          Object.hasOwn(evidence, review.guid.evidenceId) &&
          /^[a-f0-9]{64}$/u.test(review.guid.sha256),
        'case-guid-evidence-required',
      );
      const guidBytes = evidence[review.guid.evidenceId];
      check(
        (typeof guidBytes === 'string' || guidBytes instanceof Uint8Array) && digest(guidBytes) === review.guid.sha256,
        'case-guid-evidence-hash',
      );
      const guidEvidence = JSON.parse(Buffer.from(guidBytes).toString('utf8'));
      check(Number.isInteger(review.guid.captureIndex) && review.guid.captureIndex >= 0, 'case-guid-capture-index');
      check(
        Array.isArray(review.guid.factBindings) &&
          review.guid.factBindings.length === 2 &&
          review.guid.factBindings[0].pointer === `/captures/${review.guid.captureIndex}/results/0` &&
          review.guid.factBindings[1].pointer === `/captures/${review.guid.captureIndex}/results/1`,
        'case-guid-facts-required',
      );
      for (const fact of review.guid.factBindings)
        check(
          typeof fact.factId === 'string' &&
            fact.factId.length > 0 &&
            /^[a-f0-9]{64}$/u.test(fact.sha256) &&
            astHash(pointer(guidEvidence, fact.pointer)) === fact.sha256,
          'case-guid-fact-binding',
        );
      evidenceHashes[review.guid.evidenceId] = review.guid.sha256;
      const guidCases = cases[2].flatMap((row, index) =>
        row[1] && typeof row[1] === 'object' && row[1][guidProperty] ? [index] : [],
      );
      check(
        guidCases.length === 1 && guidCases[0] === 138 && cases[2][138][1][guidProperty] === 25,
        'case-guid-correction-binding',
      );
      const guidExpression = cases[2][138][0],
        capture = pointer(guidEvidence, `/captures/${review.guid.captureIndex}`);
      check(
        Array.isArray(capture.cases) &&
          capture.cases.length === 2 &&
          capture.cases[0]?.expression === guidExpression &&
          capture.cases[1]?.expression === `IfError(${guidExpression},FirstError.Kind=25)` &&
          Array.isArray(capture.results) &&
          capture.results.length === 2 &&
          capture.results[0]?.kind === 'error' &&
          capture.results[1]?.kind === 'value' &&
          capture.results[1].value === true,
        'case-guid-semantic-facts',
      );
      check(
        Array.isArray(capture.receipts) &&
          capture.receipts.length === 2 &&
          capture.receipts[0].run !== capture.receipts[1].run &&
          capture.receipts.every(
            (receipt) =>
              receipt.emptyAuthenticationProfiles === true &&
              /^[a-f0-9]{64}$/u.test(receipt.rawSha256) &&
              /^[a-f0-9]{64}$/u.test(receipt.executableSha256),
          ) &&
          capture.receipts[0].rawSha256 === capture.receipts[1].rawSha256 &&
          capture.receipts[0].executableSha256 === capture.receipts[1].executableSha256,
        'case-guid-repeated-receipts',
      );
      check(
        Array.isArray(matrixEvidence.runs) &&
          matrixEvidence.runs.length === 2 &&
          Array.isArray(matrixEvidence.captures) &&
          matrixEvidence.captures.length === 2 &&
          matrixEvidence.captures[0].processId !== matrixEvidence.captures[1].processId &&
          matrixEvidence.runs[0].identitySha256 !== matrixEvidence.runs[1].identitySha256 &&
          matrixEvidence.runs[0].resultsSha256 === matrixEvidence.runs[1].resultsSha256,
        'case-guid-matrix-receipts',
      );
      const verifyGuidEvidence = () => {
        for (let i = 0; i < 2; i++) {
          const run = matrixEvidence.runs[i],
            meta = matrixEvidence.captures[i],
            result = run.results?.[138];
          check(
            meta.unprivilegedZeroCapabilities === true &&
              meta.identitySha256 === run.identitySha256 &&
              meta.resultsSha256 === run.resultsSha256 &&
              result?.expression === guidExpression &&
              result.kind === 'error' &&
              result.type === 'ErrorValue' &&
              Array.isArray(result.errors) &&
              result.errors.some((error) => error.kind === 'InvalidArgument'),
            'case-guid-matrix-error-value',
          );
        }
      };
      verifyGuidEvidence();
      return capture;
    };
    const capture = verifyGuidCapture();
    check(
      typeof review.guid.relativePath === 'string' &&
        review.guid.relativePath.startsWith('./') &&
        !/[?#\\]/u.test(review.guid.relativePath),
      'case-guid-evidence-path',
    );
    const guidBytesName = identifier(review.guid.bytesBinding),
      guidHashName = identifier(review.guid.hashBinding),
      guidProofName = identifier(review.guid.proofBinding);
    const guidRead = parseSource(
      `const ${guidBytesName} = fs.readFileSync(new URL(${JSON.stringify(review.guid.relativePath)}, import.meta.url));`,
    ).body[0];
    const guidHash = parseSource(
      `assert.equal(${guidHashName}('sha256').update(${guidBytesName}).digest('hex'), ${JSON.stringify(review.guid.sha256)});`,
    ).body[0].expression;
    check(
      astHash(guidBody.body[0]) === astHash(guidRead) && astHash(guidAssertions[0]) === astHash(guidHash),
      'case-guid-source-evidence-binding',
    );
    check(/^[a-f0-9]{64}$/u.test(capture.captureScriptSha256), 'case-guid-capture-script');
    const expectedProof = parseSource(
      `const ${guidProofName} = JSON.parse(${guidBytesName}).captures[${review.guid.captureIndex}];`,
    ).body[0];
    check(astHash(guidBody.body[2]) === astHash(expectedProof), 'case-guid-proof-source');
    const expectedGuidStatements = parseSource(
      `assert.equal(${guidProofName}.captureScriptSha256, ${JSON.stringify(capture.captureScriptSha256)}); assert.equal(${guidProofName}.cases[0].expression, ${formula}); assert.equal(${guidProofName}.results[0].kind, 'error'); assert.equal(${guidProofName}.cases[1].expression, \`IfError(\${${formula}},FirstError.Kind=\${${expected}.${guidProperty}})\`); assert.deepEqual(${guidProofName}.results[1], { kind: 'value', value: true });`,
    ).body.map((statement) => statement.expression);
    check(
      expectedGuidStatements.every((statement, index) => astHash(statement) === astHash(guidAssertions[index + 1])),
      'case-guid-assertion-semantics',
    );
    check(
      Array.isArray(review.guid.setupAstSha256) &&
        review.guid.setupAstSha256.length === 2 &&
        astHash(guidBody.body[0]) === review.guid.setupAstSha256[0] &&
        astHash(guidBody.body[2]) === review.guid.setupAstSha256[1],
      'case-migration-guid-setup',
    );
    const throws = guidAssertions[6],
      throwCall = throws.arguments?.[0];
    check(
      throws.callee.property.name === 'throws' &&
        throwCall?.type === 'ArrowFunctionExpression' &&
        !throwCall.async &&
        throwCall.params.length === 0 &&
        throwCall.body?.type === 'CallExpression' &&
        throwCall.body.callee?.name === sutName &&
        throwCall.body.arguments.length === 1 &&
        throwCall.body.arguments[0]?.name === formula,
      'case-migration-guid-contract',
    );
    check(
      Array.isArray(review.guidAssertionSha256) &&
        review.guidAssertionSha256.length === 7 &&
        guidAssertions.every((node, index) => astHash(node) === review.guidAssertionSha256[index]),
      'case-migration-guid-binding',
    );
    return { guidBody, guidAssertions };
  };
  const { guidBody, guidAssertions } = verifyGuidContract();
  const snapshotName = identifier(review.snapshotBinding);
  const snapshotMapChecks = mapNames.map((map) => `${map}.has(${formula})`).join(', ');
  const expectedCandidate = parseSource(
    `for (const [${formula}, ${expected}] of ${caseName}) { const ${snapshotName} = [${snapshotMapChecks}, Boolean(${expected}?.${guidProperty})]; ${testName}(__title__, () => { if (${snapshotName}[0]) {} else if (${snapshotName}[1]) {} else if (${snapshotName}[2]) {} if (${snapshotName}[3]) { return; } return __original__; }); }`,
  ).body[0];
  const candidateRegistration = expectedCandidate.body.body[1].expression;
  candidateRegistration.arguments[0] = original.registration.arguments[0];
  const statements = candidateRegistration.arguments[1].body.body;
  let branch = statements[0];
  for (const call of proofCalls) {
    branch.consequent.body = [{ type: 'ExpressionStatement', expression: call }];
    branch = branch.alternate;
  }
  statements[1].consequent.body.unshift(...guidBody.body);
  statements[2].argument = originalAssert;
  check(
    astHash(loops[2][0]) === astHash(expectedCandidate) &&
      astHash(next.registration.arguments[0]) === astHash(original.registration.arguments[0]),
    'case-migration-candidate-body',
  );
  let calls = 0;
  walk(next.callback, (node) => {
    if (node.type === 'CallExpression' && node.callee?.name === sutName) calls++;
  });
  check(calls === 2, 'case-migration-sut-calls');
  const other = (ast, ignoredLoops, caseDeclaration) =>
    ast.body.filter((node) => !ignoredLoops.includes(node) && node !== caseDeclaration);
  const oldNodes = other(current, loops[1], caseDeclarations[1]),
    newNodes = other(candidate, loops[2], caseDeclarations[2]);
  let i = 0,
    j = 0;
  const moduleDelta = [];
  const verifyModuleDelta = () => {
    while (i < oldNodes.length || j < newNodes.length) {
      if (i < oldNodes.length && j < newNodes.length && astHash(oldNodes[i]) === astHash(newNodes[j])) {
        i++;
        j++;
        continue;
      }
      const replacement =
        i < oldNodes.length &&
        j < newNodes.length &&
        review.moduleReplacements.find(
          (item) => item.currentAstSha256 === astHash(oldNodes[i]) && item.candidateAstSha256 === astHash(newNodes[j]),
        );
      if (replacement) {
        proofReview(replacement, 'case-module-replacement-review');
        moduleDelta.push({
          kind: 'replacement',
          ...replacement,
          currentSpan: oldNodes[i].range,
          candidateSpan: newNodes[j].range,
        });
        i++;
        j++;
        continue;
      }
      const addition =
        j < newNodes.length && review.moduleAdditions.find((item) => item.candidateAstSha256 === astHash(newNodes[j]));
      check(addition, 'case-migration-module-change');
      proofReview(addition, 'case-module-addition-review');
      moduleDelta.push({ kind: 'addition', ...addition });
      j++;
    }
  };
  verifyModuleDelta();
  check(
    moduleDelta.filter((item) => item.kind === 'replacement').length === review.moduleReplacements.length &&
      moduleDelta.filter((item) => item.kind === 'addition').length === review.moduleAdditions.length,
    'unused-case-module-review',
  );
  let retainedCount = 0;
  const retained = [],
    allowedReplacements = new Map(),
    usedReplacements = new Set(),
    usedAdditions = new Set(),
    allowedAdditions = new Map();
  const verifyAssertionReplacement = (item) => {
    proofReview(item, 'case-assertion-replacement-review');
    check(
      typeof item.registration === 'string' && Number.isInteger(item.assertionIndex) && item.assertionIndex > 0,
      'invalid-case-assertion-replacement',
    );
    const key = `${item.registration}\0${item.assertionIndex}`;
    check(!allowedReplacements.has(key), 'duplicate-case-assertion-replacement');
    allowedReplacements.set(key, item);
  };
  for (const item of review.assertionReplacements) verifyAssertionReplacement(item);
  const verifyAssertionAddition = (item) => {
    proofReview(item, 'case-assertion-addition-review');
    check(!allowedAdditions.has(item.candidateAstSha256), 'duplicate-case-assertion-addition');
    allowedAdditions.set(item.candidateAstSha256, item);
  };
  for (const item of review.assertionAdditions) verifyAssertionAddition(item);
  const normalizedNodes = new Map();
  const removedNodes = new Set();
  const verifyRetainedRegistrations = () => {
    for (const entry of review.retainedRegistrations) {
      proofReview(entry, 'case-retained-registration-review');
      const find = (ast) =>
        ast.body.filter(
          (node) =>
            node.type === 'ExpressionStatement' &&
            node.expression?.callee?.name === testName &&
            node.expression.arguments[0]?.value === entry.title,
        );
      const before = find(current),
        after = find(candidate);
      check(before.length === 1 && after.length === 1, 'case-retained-registration');
      const oldAssertions = assertions(before[0]),
        newAssertions = assertions(after[0]);
      check(
        oldAssertions.length === entry.count && newAssertions.length >= oldAssertions.length,
        'case-retained-assertion-count',
      );
      let cursor = 0;
      const verifyOriginalAssertion = (assertionIndex) => {
        const assertion = oldAssertions[assertionIndex];
        const originalHash = astHash(assertion),
          replacement = allowedReplacements.get(`${entry.title}\0${assertionIndex + 1}`),
          target = replacement?.candidateAstSha256 ?? originalHash;
        if (replacement) check(replacement.currentAstSha256 === originalHash, 'case-assertion-replacement-source');
        while (cursor < newAssertions.length && astHash(newAssertions[cursor]) !== target) {
          const addition = allowedAdditions.get(astHash(newAssertions[cursor]));
          check(addition && !usedAdditions.has(addition), 'unreviewed-case-assertion-addition');
          usedAdditions.add(addition);
          cursor++;
        }
        check(cursor < newAssertions.length, 'case-retained-assertion-removed');
        if (replacement) {
          check(!usedReplacements.has(replacement), 'duplicate-case-assertion-replacement-use');
          usedReplacements.add(replacement);
          normalizedNodes.set(newAssertions[cursor], assertion);
        }
        retained.push({
          title: entry.title,
          currentAstSha256: originalHash,
          candidateAstSha256: target,
          currentSpan: assertion.range,
          candidateSpan: newAssertions[cursor].range,
        });
        retainedCount++;
        cursor++;
      };
      for (let assertionIndex = 0; assertionIndex < oldAssertions.length; assertionIndex++)
        verifyOriginalAssertion(assertionIndex);
      while (cursor < newAssertions.length) {
        const addition = allowedAdditions.get(astHash(newAssertions[cursor]));
        check(addition && !usedAdditions.has(addition), 'unreviewed-case-assertion-addition');
        usedAdditions.add(addition);
        cursor++;
      }
    }
  };
  verifyRetainedRegistrations();
  check(retainedCount === review.retainedAssertionCount, 'case-retained-total');
  check(
    usedReplacements.size === review.assertionReplacements.length &&
      usedAdditions.size === review.assertionAdditions.length,
    'unused-case-assertion-review',
  );
  const candidateParents = new Map(),
    currentParents = new Map();
  walk(candidate, (node, parent) => candidateParents.set(node, parent));
  walk(current, (node, parent) => currentParents.set(node, parent));
  const verifyRetainedAssertion = (item) => {
    proofReview(item, 'case-must-retain-review');
    const old = assertions(current).filter((node) => astHash(node) === item.astSha256),
      next = assertions(candidate).filter((node) => astHash(node) === item.astSha256);
    check(old.length === 1 && next.length === 1, 'case-required-original-assertion');
    const binding = item.evidenceBinding;
    proofReview(binding, 'case-retained-evidence-review');
    check(
      typeof binding.evidenceId === 'string' &&
        evidence &&
        Object.hasOwn(evidence, binding.evidenceId) &&
        /^[a-f0-9]{64}$/u.test(binding.sha256) &&
        digest(evidence[binding.evidenceId]) === binding.sha256,
      'case-retained-evidence-hash',
    );
    evidenceHashes[binding.evidenceId] = binding.sha256;
    check(
      typeof binding.relativePath === 'string' &&
        binding.relativePath.startsWith('./') &&
        !/[?#\\]/u.test(binding.relativePath),
      'case-retained-evidence-path',
    );
    const bytesName = identifier(binding.bytesBinding),
      proofName = identifier(binding.proofBinding),
      hashName = identifier(binding.hashBinding);
    const expectedBlock = parseSource(
      `{ const ${bytesName} = fs.readFileSync(new URL(${JSON.stringify(binding.relativePath)}, import.meta.url)); assert.equal(${hashName}(${bytesName}), ${JSON.stringify(binding.sha256)}); const ${proofName} = JSON.parse(${bytesName}); ${sourceOf(currentSource, old[0])}; }`,
    ).body[0];
    const block = candidateParents.get(candidateParents.get(next[0]));
    check(
      block?.type === 'BlockStatement' && astHash(block) === astHash(expectedBlock),
      'case-retained-evidence-binding',
    );
    const oldStatement = currentParents.get(old[0]);
    check(oldStatement?.type === 'ExpressionStatement', 'case-retained-original-statement');
    normalizedNodes.set(block, oldStatement);
    const oldProperty = identifier(binding.property),
      oldEvidence = JSON.parse(Buffer.from(evidence[binding.evidenceId]).toString('utf8'));
    const expectedAuth = parseSource(`assert.ok(${proofName}.captures.every(({ ${oldProperty} }) => ${oldProperty}));`)
      .body[0].expression;
    check(
      astHash(old[0]) === astHash(expectedAuth) &&
        Array.isArray(oldEvidence.captures) &&
        oldEvidence.captures.length === 2 &&
        oldEvidence.captures.every((capture) => capture[oldProperty] === true),
      'case-retained-evidence-semantics',
    );
  };
  for (const item of review.mustRetainAssertions) verifyRetainedAssertion(item);
  const registration = (ast, title) => {
    const tests = ast.body.filter(
      (node) =>
        node.type === 'ExpressionStatement' &&
        node.expression?.callee?.name === testName &&
        node.expression.arguments[0]?.value === title,
    );
    check(
      tests.length === 1 && tests[0].expression.arguments[1]?.body?.type === 'BlockStatement',
      'case-metadata-registration',
    );
    return tests[0].expression.arguments[1].body;
  };
  const evidenceObject = (id) => {
    check(
      typeof id === 'string' &&
        Object.hasOwn(evidenceHashes, id) &&
        Object.hasOwn(evidence, id) &&
        digest(evidence[id]) === evidenceHashes[id],
      'case-metadata-evidence',
    );
    return JSON.parse(Buffer.from(evidence[id]).toString('utf8'));
  };
  const checkedMetadata = new Set();
  const verifyContext = (ast, binding, evidenceId, relativePath) => {
    const body = registration(ast, binding.registration),
      bytes = identifier(binding.bytesBinding),
      proof = identifier(binding.proofBinding),
      hashName = identifier(binding.hashBinding),
      arg = identifier(binding.hashArgument),
      crypto = identifier(binding.cryptoBinding);
    check(
      typeof relativePath === 'string' && relativePath.startsWith('./') && !/[?#\\]/u.test(relativePath),
      'case-metadata-path',
    );
    const expected = parseSource(
      `const ${bytes} = fs.readFileSync(new URL(${JSON.stringify(relativePath)}, import.meta.url)); const ${hashName} = (${arg}) => ${crypto}('sha256').update(${arg}).digest('hex'); const ${proof} = JSON.parse(${bytes});`,
    ).body;
    for (const expectedDeclaration of expected)
      check(
        body.body.some((statement) => astHash(statement) === astHash(expectedDeclaration)),
        'case-metadata-proof-context',
      );
    check(Object.hasOwn(evidenceHashes, evidenceId), 'case-metadata-evidence');
    return body;
  };
  check(review.metadataBindings.length === review.assertionReplacements.length, 'case-metadata-binding-count');
  const verifyMetadataBinding = (item) => {
    proofReview(item, 'case-metadata-review-required');
    const key = `${item.registration}\0${item.assertionIndex}`,
      replacement = allowedReplacements.get(key);
    check(
      replacement &&
        !checkedMetadata.has(key) &&
        ['evidenceDigest', 'evidenceField', 'matrixRebinding'].includes(item.kind),
      'case-metadata-replacement',
    );
    checkedMetadata.add(key);
    const oldBody = verifyContext(current, item, item.oldEvidenceId, item.oldRelativePath),
      newBody = verifyContext(
        candidate,
        item,
        item.kind === 'matrixRebinding' ? item.oldEvidenceId : item.newEvidenceId,
        item.kind === 'matrixRebinding' ? item.oldRelativePath : item.newRelativePath,
      );
    if (item.kind === 'evidenceDigest') {
      const oldRead = oldBody.body.find(
        (node) => node.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === item.bytesBinding,
      );
      const newRead = newBody.body.find(
        (node) => node.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === item.bytesBinding,
      );
      check(oldRead && newRead, 'case-metadata-read-normalization');
      normalizedNodes.set(newRead, oldRead);
    }
    const oldAssertion = assertions(oldBody)[item.assertionIndex - 1],
      newAssertion = assertions(newBody).find((node) => astHash(node) === replacement.candidateAstSha256);
    check(
      oldAssertion && newAssertion && astHash(oldAssertion) === replacement.currentAstSha256,
      'case-metadata-assertion',
    );
    const oldData = evidenceObject(item.oldEvidenceId),
      newData = evidenceObject(item.newEvidenceId),
      hashName = identifier(item.hashBinding),
      bytes = identifier(item.bytesBinding),
      proof = identifier(item.proofBinding);
    let expectedOld, expectedNew;
    if (item.kind === 'evidenceDigest') {
      expectedOld = `assert.equal(${hashName}(${bytes}), ${JSON.stringify(evidenceHashes[item.oldEvidenceId])});`;
      expectedNew = `assert.equal(${hashName}(${bytes}), ${JSON.stringify(evidenceHashes[item.newEvidenceId])});`;
    } else if (item.kind === 'evidenceField') {
      const parts = item.pointer?.split('/').slice(1);
      check(parts?.length > 0 && parts.every((part) => /^[A-Za-z_$][\w$]*$/u.test(part)), 'case-metadata-pointer');
      const access = parts.map((part) => `.${part}`).join('');
      expectedOld = `assert.equal(${proof}${access}, ${JSON.stringify(pointer(oldData, item.pointer))});`;
      expectedNew = `assert.equal(${proof}${access}, ${JSON.stringify(pointer(newData, item.pointer))});`;
    } else {
      const newBinding = identifier(item.newDataBinding);
      check(
        review.partitions.some((part) => part.evidenceBinding === newBinding && part.evidenceId === item.newEvidenceId),
        'case-matrix-evidence-binding',
      );
      check(
        pointer(oldData, item.pointer) === digest(JSON.stringify(cases[1])) &&
          pointer(newData, item.pointer) === digest(JSON.stringify(cases[2])),
        'case-matrix-source-values',
      );
      const parts = item.pointer.split('/').slice(1);
      check(parts.length > 0 && parts.every((part) => /^[A-Za-z_$][\w$]*$/u.test(part)), 'case-metadata-pointer');
      const access = parts.map((part) => `.${part}`).join('');
      expectedOld = `assert.equal(${hashName}(JSON.stringify(${caseName})), ${proof}${access});`;
      expectedNew = `assert.equal(${hashName}(JSON.stringify(${caseName})), ${newBinding}${access});`;
    }
    check(
      astHash(oldAssertion) === astHash(parseSource(expectedOld).body[0].expression) &&
        astHash(newAssertion) === astHash(parseSource(expectedNew).body[0].expression),
      'case-metadata-assertion-semantics',
    );
  };
  for (const item of review.metadataBindings) verifyMetadataBinding(item);
  check(checkedMetadata.size === review.assertionReplacements.length, 'case-metadata-binding-count');
  const verifyCapabilityEvidence = () => {
    const capability = review.capabilityBinding;
    proofReview(capability, 'case-capability-review');
    const capabilityEvidence = evidenceObject(capability.evidenceId),
      capabilityProperty = identifier(capability.property),
      capabilityProof = identifier(capability.proofBinding);
    check(
      Array.isArray(capabilityEvidence.captures) &&
        capabilityEvidence.captures.length === 2 &&
        capabilityEvidence.captures.every((capture) => capture[capabilityProperty] === true),
      'case-capability-evidence',
    );
    const capabilityBody = verifyContext(candidate, capability, capability.evidenceId, capability.relativePath);
    const expectedCapability = parseSource(
      `assert.ok(${capabilityProof}.captures.every(({ ${capabilityProperty} }) => ${capabilityProperty}));`,
    ).body[0].expression;
    check(
      astHash(expectedCapability) === capability.assertionAstSha256 &&
        capabilityBody.body.some(
          (statement) =>
            statement.type === 'ExpressionStatement' && astHash(statement.expression) === capability.assertionAstSha256,
        ) &&
        usedAdditions.size &&
        review.assertionAdditions.some((item) => item.candidateAstSha256 === capability.assertionAstSha256),
      'case-capability-assertion',
    );
    const capabilityStatement = capabilityBody.body.find(
      (statement) =>
        statement.type === 'ExpressionStatement' && astHash(statement.expression) === capability.assertionAstSha256,
    );
    removedNodes.add(capabilityStatement);
  };
  verifyCapabilityEvidence();
  const verifyPartitionConsumption = (partition) => {
    const before = declaration(current, partition.evidenceBinding),
      after = declaration(candidate, partition.evidenceBinding);
    if (astHash(before) !== astHash(after)) normalizedNodes.set(after, before);
  };
  for (const partition of review.partitions) verifyPartitionConsumption(partition);
  check(review.moduleAdditions.length === 0, 'case-extra-module-addition');
  const normalize = (node) => {
    if (!node || typeof node !== 'object') return node;
    if (normalizedNodes.has(node)) return normalizedNodes.get(node);
    if (Array.isArray(node)) return node.filter((child) => !removedNodes.has(child)).map(normalize);
    return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, normalize(child)]));
  };
  const normalNodes = normalize(newNodes);
  check(astHash(oldNodes) === astHash(normalNodes), 'case-unreviewed-module-content');

  const rows = [],
    eligible = [],
    historicallyQualified = [];
  const verifyCaseMembership = () => {
    for (let index = 0; index < 193; index++) {
      const [expression, result] = cases[2][index],
        flags = maps.map((map) => map.has(expression)),
        oldFlags = oldMaps.map((map) => map.has(expression)),
        guid = Boolean(result?.[guidProperty]);
      check(astHash(flags) === astHash(oldFlags), 'case-migration-membership-changed');
      check(flags.filter(Boolean).length + Number(guid) <= 1, 'case-migration-overlap');
      const partition = flags.indexOf(true);
      if (partition >= 0) {
        check(
          astHash(maps[partition].get(expression)) === astHash(result) &&
            astHash(oldMaps[partition].get(expression)) === astHash(cases[1][index][1]),
          'case-migration-proof-mismatch',
        );
        historicallyQualified.push(index);
      }
      if (!guid) eligible.push(index);
      rows.push({
        caseIndex: index,
        baselineValue: cases[0][index][1],
        currentValue: cases[1][index][1],
        candidateValue: result,
        expressionSha256: digest(expression),
        registrationSnapshot: [...flags, guid],
        partition,
        guid,
        sutCalls: 1,
        originalAssertionSha256: guid ? null : astHash(originalAssert),
      });
    }
  };
  verifyCaseMembership();
  check(
    Array.isArray(review.selected) &&
      new Set(review.selected).size === review.selected.length &&
      review.selected.every((index) => Number.isInteger(index) && eligible.includes(index) && !rows[index].guid),
    'invalid-selected-case-path',
  );
  return {
    baselineLoopSha256: astHash(originalLoop),
    currentLoopSha256: loops[1].map((node) => astHash(node)),
    candidateLoopSha256: astHash(loops[2][0]),
    candidateLoopHeaderSha256: astHash({
      type: 'CaseLoopHeader',
      left: loops[2][0].left,
      right: loops[2][0].right,
      snapshot: loops[2][0].body.body[0],
    }),
    caseDeclarationSha256: caseDeclarations.map((node) => astHash(node)),
    sourceHashes: [digest(baselineSource), digest(currentSource), digest(candidateSource)],
    evidenceHashes,
    helperAssertions: retained,
    guidAssertionSha256: guidAssertions.map((node) => astHash(node)),
    retainedAssertionHashes: [...proofCalls, ...guidAssertions].map((node) => astHash(node)),
    originalAssertionSha256: astHash(originalAssert),
    moduleDelta,
    eligibleIndices: eligible,
    historicalIndices: historicallyQualified,
    selectedIndices: review.selected,
    rows,
    requiresAllRegistrations: true,
  };
}
