// Source-bound, fixed-input SDK value assertions within the protected SOAP test.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGitExecutable } from './trusted-git.mjs';
import { assertSoapNamespaceToolRoot, runSoapQualification, soapNodes } from './qualify-soap-namespace.mjs';
import {
  assertSoapParityBindingsFromSource,
  describeParitySource,
  parityAstHash,
  qualifyParityManifest,
  soapBindingsFromSource,
  soapLoopDescriptorFromSource,
} from './qualify-parity.mjs';
const tool = fileURLToPath(new URL('./qualify-parity.mjs', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const requireCondition = (value, reason) => {
  if (!value) throw new Error(reason);
};
function staticValue(node) {
  if (node?.type === 'Literal') return node.value;
  if (node?.type === 'ArrayExpression') return node.elements.map((element) => staticValue(element));
  if (node?.type === 'ObjectExpression') {
    const result = {};
    for (const property of node.properties) {
      requireCondition(
        property.type === 'Property' &&
          property.kind === 'init' &&
          !property.computed &&
          !property.method &&
          !property.shorthand,
        'unsupported expected value',
      );
      const key = property.key.type === 'Identifier' ? property.key.name : property.key.value;
      requireCondition(
        typeof key === 'string' && !Object.hasOwn(result, key) && key !== '__proto__',
        'unsupported expected key',
      );
      result[key] = staticValue(property.value);
    }
    return result;
  }
  throw new Error('unsupported expected value');
}
export function validateSoapValueEvidence(capsule, reference) {
  requireCondition(
    Array.isArray(capsule.runs) &&
      capsule.runs.length === 2 &&
      Array.isArray(capsule.source) &&
      capsule.source.length === 3,
    'invalid value captures',
  );
  requireCondition(
    capsule.sdkSha256 === capsule.producer?.sdkAssemblySha256 &&
      hash(capsule.columnSetProducer?.source ?? '') === capsule.columnSetProducer?.sourceSha256,
    'changed SDK producer',
  );
  requireCondition(
    reference &&
      JSON.stringify(capsule.interopInputs) ===
        JSON.stringify(reference.cases.filter((item) => item.id === 17 || item.id === 21)) &&
      capsule.runs.every((run, index) => JSON.stringify(run.interopRun) === JSON.stringify(reference.runs[index])),
    'changed interop input or capture',
  );
  const columnMatch = /string xml="((?:\\.|[^"\\])*)";/u.exec(capsule.columnSetProducer.source);
  requireCondition(columnMatch, 'missing ColumnSet producer input');
  const columnXml = JSON.parse('"' + columnMatch[1] + '"');
  for (const run of capsule.runs) {
    const interop = run.interopRun,
      column = run.columnSetRun,
      raw = run.columnSetRaw;
    requireCondition(
      interop?.sdk?.sha256 === capsule.sdkSha256 &&
        raw?.status === 0 &&
        raw.pid === column?.pid &&
        hash(JSON.stringify(raw)) === column.rawSha256 &&
        hash(JSON.stringify([interop.rawSha256, column.rawSha256])) === run.receiptSha256,
      'changed capture provenance',
    );
    const lines = raw.stdout.trim().split(/\r?\n/u);
    requireCondition(
      lines[0] === columnXml &&
        lines[1] === 'allColumns=True;count=1;column=name' &&
        column.allColumns === true &&
        JSON.stringify(column.columns) === '["name"]',
      'changed ColumnSet observation',
    );
    for (const [caseIndex, expectedType] of [
      [17, 'Microsoft.Xrm.Sdk.OptionSetValueCollection'],
      [21, 'System.Int64'],
    ]) {
      const spec = capsule.source.find((item) => item.case === caseIndex),
        input = capsule.interopInputs.find((item) => item.id === caseIndex),
        result = interop.results.find((item) => item.id === caseIndex)?.direct;
      requireCondition(
        spec &&
          input &&
          result?.phase === 'value' &&
          result.sdkType === expectedType &&
          JSON.stringify(result.canonical) === JSON.stringify(spec.expected) &&
          JSON.stringify(input.expected) === JSON.stringify(spec.expected),
        'changed SDK typed value',
      );
    }
  }
  requireCondition(
    capsule.runs[0].interopRun.processId !== capsule.runs[1].interopRun.processId &&
      capsule.runs[0].columnSetRaw.pid !== capsule.runs[1].columnSetRaw.pid &&
      capsule.runs[0].receiptSha256 !== capsule.runs[1].receiptSha256,
    'non-independent value captures',
  );
}
export function analyzeSoapValueInputs({ file, baseline, source, proof, capsule, reference }) {
  validateSoapValueEvidence(capsule, reference);
  const old = describeParitySource(baseline, file),
    current = describeParitySource(source, file),
    regions = [],
    edits = [];
  requireCondition(!current.identifiers.has('__paqSoapValueProof'), 'value guard already present');
  requireCondition(
    capsule.baselineSourceSha256 === hash(baseline) &&
      Array.isArray(capsule.source) &&
      capsule.source.length === proof.facts.length &&
      capsule.source.length > 0 &&
      capsule.source.length <= 16,
    'changed value universe',
  );
  for (let i = 0; i < capsule.source.length; i++) {
    const test = capsule.source[i],
      fact = proof.facts[i],
      original = old.registrations.find((r) => r.id === test.id);
    requireCondition(
      original?.kinds.includes('compatibility') && !original.kinds.some((k) => k === 'parity' || k === 'security'),
      'unsupported original kind',
    );
    const rows = current.registrations.filter((r) => r.titleExpressionSha256 === original.titleExpressionSha256);
    requireCondition(rows.length === 1 && rows[0].kinds.includes('compatibility'), 'changed value parent');
    const row = rows[0],
      selected = original.assertions[test.idx],
      actual = row.assertions[test.idx];
    requireCondition(
      selected &&
        actual &&
        selected.sha256 === test.assertionSha256 &&
        actual.sha256 === selected.sha256 &&
        parityAstHash(original.callback.body) === parityAstHash(row.callback.body),
      'changed original value assertion',
    );
    requireCondition(
      hash(JSON.stringify(staticValue(selected.node.arguments[1]))) === hash(JSON.stringify(test.expected)) &&
        fact.sha256 === hash(JSON.stringify(test.expected)) &&
        capsule.runs?.length === 2 &&
        capsule.runs.every((run) => hash(JSON.stringify(run.facts?.[i])) === fact.sha256),
      'value fact mismatch',
    );
    const statement = row.callback.body.body.find(
      (item) => item.type === 'ExpressionStatement' && item.expression === actual.node,
    );
    requireCondition(statement, 'value assertion is not a direct statement');
    regions.push({
      baselineId: test.id,
      baselineCommit: capsule.baseline,
      baselineSourceSha256: hash(baseline),
      titleExpressionSha256: original.titleExpressionSha256,
      originalBodyAstSha256: parityAstHash(original.callback.body),
      assertionSha256: selected.sha256,
      assertionIndex: test.idx,
      factId: fact.id,
      expected: test.expected,
    });
    edits.push({
      start: statement.range[0],
      end: statement.range[1],
      text: `{\n__paqSoapValueProof(import.meta.url, ${JSON.stringify(fact.id)});\n${source.slice(...statement.range)}\n}`,
    });
  }
  requireCondition(
    new Set(regions.map((r) => r.baselineId)).size === regions.length &&
      new Set(regions.map((r) => r.factId)).size === regions.length,
    'duplicate value case',
  );
  return { regions, edits };
}
export function qualifySoapValues({ root, loopManifest, proof, authorityFile, authoritySha256 }) {
  root = path.resolve(root);
  assertSoapNamespaceToolRoot(root);
  requireCondition(
    loopManifest?.files?.length === 1 && loopManifest.files[0].path === 'mirage/test/dataverse-soap-xml.test.mjs',
    'unsupported SOAP target',
  );
  const file = loopManifest.files[0].path,
    target = path.resolve(root, file),
    source = fs.readFileSync(target, 'utf8');
  const loop = qualifyParityManifest(loopManifest, {
    root,
    soapPriorAuthorityFile: authorityFile,
    soapPriorAuthoritySha256: authoritySha256,
  });
  requireCondition(!loop.pending.length && loop.changes.length === 0, 'prior SOAP authority is not current');
  const relative = path.relative(root, path.resolve(root, proof.path));
  requireCondition(
    relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'proof outside root',
  );
  const proofPath = path.resolve(root, proof.path),
    real = path.relative(fs.realpathSync(root), fs.realpathSync(proofPath));
  requireCondition(
    real && real !== '..' && !real.startsWith('..' + path.sep) && !path.isAbsolute(real),
    'proof symlink outside root',
  );
  const bytes = fs.readFileSync(proofPath),
    capsule = JSON.parse(bytes);
  requireCondition(
    proof.mode === 'official-package' && hash(bytes) === proof.sha256 && capsule.baseline === loopManifest.baseline,
    'invalid value proof',
  );
  const baseline = execFileSync(resolveGitExecutable(), ['show', `${loopManifest.baseline}:${file}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const bindings = soapBindingsFromSource(source),
    existing = bindings[0].valueRegions,
    oldPartialAssertions = soapLoopDescriptorFromSource(source).instances.length;
  if (existing) {
    requireCondition(
      bindings[0].proofs.some((p) => JSON.stringify(p) === JSON.stringify(proof)) &&
        existing.length === capsule.source.length &&
        existing.every(
          (r, i) =>
            r.baselineId === capsule.source[i].id &&
            r.assertionSha256 === capsule.source[i].assertionSha256 &&
            r.factId === proof.facts[i].id,
        ),
      'existing value authority differs',
    );
    assertSoapParityBindingsFromSource(pathToFileURL(target), bindings, source);
    return {
      path: file,
      before: source,
      after: source,
      oldPartialAssertions,
      newPartialAssertions: 0,
      newWholeCases: 0,
    };
  }
  const referenceBytes = fs.readFileSync(
    path.join(root, 'mirage/test/fixtures/dataverse-soap-sdk-interop-46-candidate.json'),
  );
  requireCondition(hash(referenceBytes) === capsule.inputFixtureSha256, 'changed interop fixture');
  const reference = JSON.parse(referenceBytes);
  const { regions, edits } = analyzeSoapValueInputs({ file, baseline, source, proof, capsule, reference }),
    original = soapNodes(source),
    specifier = path.relative(path.dirname(target), tool).replaceAll(path.sep, '/');
  requireCondition(!path.isAbsolute(specifier), 'tool outside local repository');
  edits.push({
    start: original.guard.range[1],
    end: original.guard.range[1],
    text: `\nimport { assertSoapValueProof as __paqSoapValueProof } from ${JSON.stringify(specifier.startsWith('.') ? specifier : './' + specifier)};\n`,
  });
  let after = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  const generated = soapNodes(after),
    next = soapBindingsFromSource(after);
  next[0].proofs.push(proof);
  next[0].valueRegions = regions;
  next[0].sourceAstSha256 = parityAstHash({
    ...generated.tree,
    body: generated.tree.body.filter(
      (n) => n !== generated.guard && n !== generated.declaration && n !== generated.imported,
    ),
  });
  const argument = generated.guard.expression.arguments[1];
  after = after.slice(0, argument.range[0]) + JSON.stringify(next) + after.slice(argument.range[1]);
  after =
    '// @parity-evidence: Repeated official SDK deserialization proves only these fixed-input value projections.\n' +
    after;
  assertSoapParityBindingsFromSource(pathToFileURL(target), next, after);
  return {
    path: file,
    before: source,
    after,
    oldPartialAssertions,
    newPartialAssertions: regions.length,
    newWholeCases: 0,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    runSoapQualification(process.argv.slice(2), {
      name: 'qualify-soap-values.mjs',
      qualify: qualifySoapValues,
      proofOption: '--value-proof',
    });
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
