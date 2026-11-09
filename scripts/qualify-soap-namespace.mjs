// Bounded namespace-only qualification for the already source-bound SOAP loop.
// Reviewed evidence and an independently accepted prior authority are required.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveGitExecutable } from './trusted-git.mjs';
import {
  assertSoapParityBindingsFromSource,
  describeParitySource,
  parityAstHash,
  qualifyParityManifest,
  soapBindingsFromSource,
  soapLoopDescriptorFromSource,
} from './qualify-parity.mjs';

const parse = createRequire(import.meta.url)('espree').parse;
const TOOL = fileURLToPath(new URL('./qualify-parity.mjs', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const jsonHash = (value) => hash(JSON.stringify(value));
const requireCondition = (condition, message) => {
  if (!condition) throw new Error(message);
};

export function assertSoapNamespaceToolRoot(root) {
  const expected = path.join(path.resolve(root), 'scripts', 'qualify-parity.mjs');
  requireCondition(fs.realpathSync(expected) === fs.realpathSync(TOOL), 'qualifier does not belong to root');
}

function confined(root, relative) {
  requireCondition(typeof relative === 'string' && relative && !path.isAbsolute(relative), 'invalid proof path');
  const destination = path.resolve(root, relative),
    rel = path.relative(root, destination);
  requireCondition(
    rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel),
    'proof outside root',
  );
  const realRoot = fs.realpathSync(root),
    real = fs.realpathSync(destination),
    actual = path.relative(realRoot, real);
  requireCondition(
    actual && actual !== '..' && !actual.startsWith('..' + path.sep) && !path.isAbsolute(actual),
    'proof symlink outside root',
  );
  return destination;
}

export function soapNodes(source) {
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true });
  const guard = tree.body.find(
    (node) => node.type === 'ExpressionStatement' && node.expression?.callee?.name === '__paqSoapBindings',
  );
  const declaration = tree.body.find(
    (node) => node.type === 'VariableDeclaration' && node.declarations[0]?.id?.name === '__paqSoapDescriptor',
  );
  const imported = tree.body.find(
    (node) =>
      node.type === 'ImportDeclaration' && node.specifiers.some((item) => item.local.name === '__paqSoapBindings'),
  );
  requireCondition(guard && declaration && imported, 'missing SOAP source guard');
  return { tree, guard, declaration, imported };
}

export function analyzeSoapNamespaceInputs({ file, baseline, source, proof, capsule }) {
  const old = describeParitySource(baseline, file),
    current = describeParitySource(source, file);
  requireCondition(!current.identifiers.has('__paqSoapNamespaceProof'), 'namespace guard already present');
  const tests = capsule.source?.tests;
  requireCondition(
    Array.isArray(tests) &&
      tests.length > 0 &&
      tests.length <= 16 &&
      Array.isArray(proof.facts) &&
      proof.facts.length === tests.length,
    'invalid namespace case universe',
  );
  requireCondition(capsule.source.baselineSourceSha256 === hash(baseline), 'changed namespace baseline');
  const regions = [],
    edits = [];
  for (let index = 0; index < tests.length; index++) {
    const test = tests[index],
      fact = proof.facts[index];
    const original = old.registrations.find((row) => row.id === test.id);
    requireCondition(
      original?.kinds.includes('compatibility') &&
        !original.kinds.some((kind) => kind === 'parity' || kind === 'security'),
      'unsupported original kind',
    );
    const rows = current.registrations.filter((row) => row.titleExpressionSha256 === original.titleExpressionSha256);
    requireCondition(rows.length === 1 && rows[0].kinds.includes('compatibility'), 'changed namespace parent');
    const row = rows[0],
      selected = original.assertions[test.assertionIndex],
      actual = row.assertions[test.assertionIndex];
    requireCondition(
      selected &&
        actual &&
        selected.sha256 === test.assertionSha256 &&
        actual.sha256 === selected.sha256 &&
        parityAstHash(original.callback.body) === parityAstHash(row.callback.body),
      'changed original namespace assertion',
    );
    const expected = selected.node.arguments?.[1]?.value;
    requireCondition(
      typeof expected === 'string' &&
        jsonHash(expected) === fact.sha256 &&
        capsule.runs?.length === 2 &&
        capsule.runs.every((run) => run.facts?.[index]?.namespace === expected),
      'namespace fact mismatch',
    );
    const statement = row.callback.body.body.find(
      (item) => item.type === 'ExpressionStatement' && item.expression === actual.node,
    );
    requireCondition(statement, 'namespace assertion is not a direct statement');
    regions.push({
      baselineId: test.id,
      baselineCommit: capsule.baseline,
      baselineSourceSha256: hash(baseline),
      titleExpressionSha256: original.titleExpressionSha256,
      originalBodyAstSha256: parityAstHash(original.callback.body),
      assertionSha256: selected.sha256,
      factId: fact.id,
      namespace: expected,
    });
    edits.push({
      start: statement.range[0],
      end: statement.range[1],
      text: `{\n__paqSoapNamespaceProof(import.meta.url, ${JSON.stringify(fact.id)});\n${source.slice(...statement.range)}\n}`,
    });
  }
  requireCondition(
    new Set(regions.map((region) => region.baselineId)).size === regions.length &&
      new Set(regions.map((region) => region.factId)).size === regions.length,
    'duplicate namespace case',
  );
  return { regions, edits };
}

export function qualifySoapNamespaces({ root, loopManifest, proof, authorityFile, authoritySha256 }) {
  root = path.resolve(root);
  assertSoapNamespaceToolRoot(root);
  requireCondition(
    loopManifest?.files?.length === 1 && loopManifest.files[0].path === 'mirage/test/dataverse-soap-xml.test.mjs',
    'unsupported SOAP target',
  );
  requireCondition(/^[a-f0-9]{40}$/u.test(loopManifest.baseline ?? ''), 'invalid baseline');
  const file = loopManifest.files[0].path,
    target = path.resolve(root, file),
    source = fs.readFileSync(target, 'utf8');
  const loop = qualifyParityManifest(loopManifest, {
    root,
    soapPriorAuthorityFile: authorityFile,
    soapPriorAuthoritySha256: authoritySha256,
  });
  requireCondition(!loop.pending.length && loop.changes.length === 0, 'prior SOAP authority is not current');
  const proofPath = confined(root, proof.path),
    bytes = fs.readFileSync(proofPath),
    capsule = JSON.parse(bytes);
  requireCondition(
    proof.mode === 'official-package' && hash(bytes) === proof.sha256 && capsule.baseline === loopManifest.baseline,
    'invalid namespace proof',
  );
  const baseline = execFileSync(resolveGitExecutable(), ['show', `${loopManifest.baseline}:${file}`], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const bindings = soapBindingsFromSource(source),
    existing = bindings[0].namespaceRegions,
    oldPartialAssertions = soapLoopDescriptorFromSource(source).instances.length;
  if (existing) {
    requireCondition(
      bindings[0].proofs.some((item) => jsonHash(item) === jsonHash(proof)) &&
        existing.length === capsule.source.tests.length &&
        existing.every(
          (region, index) =>
            region.baselineId === capsule.source.tests[index].id &&
            region.assertionSha256 === capsule.source.tests[index].assertionSha256 &&
            region.factId === proof.facts[index].id,
        ),
      'existing namespace authority differs',
    );
    assertSoapParityBindingsFromSource(pathToFileURL(target), bindings, source);
    return {
      path: file,
      before: source,
      after: source,
      oldPartialAssertions,
      previouslyGuardedNamespaceAssertions: existing.length,
      newPartialAssertions: 0,
      newWholeCases: 0,
    };
  }
  const { regions, edits } = analyzeSoapNamespaceInputs({ file, baseline, source, proof, capsule });
  const original = soapNodes(source),
    relative = path.relative(path.dirname(target), TOOL).replaceAll(path.sep, '/');
  requireCondition(!path.isAbsolute(relative), 'tool is outside local repository');
  edits.push({
    start: original.guard.range[1],
    end: original.guard.range[1],
    text: `\nimport { assertSoapNamespaceProof as __paqSoapNamespaceProof } from ${JSON.stringify(relative.startsWith('.') ? relative : './' + relative)};\n`,
  });
  let after = source;
  for (const edit of edits.toSorted((a, b) => b.start - a.start))
    after = after.slice(0, edit.start) + edit.text + after.slice(edit.end);
  const generated = soapNodes(after),
    next = soapBindingsFromSource(after);
  next[0].proofs.push(proof);
  next[0].namespaceRegions = regions;
  next[0].sourceAstSha256 = parityAstHash({
    ...generated.tree,
    body: generated.tree.body.filter(
      (node) => node !== generated.guard && node !== generated.declaration && node !== generated.imported,
    ),
  });
  const argument = generated.guard.expression.arguments[1];
  after = after.slice(0, argument.range[0]) + JSON.stringify(next) + after.slice(argument.range[1]);
  after =
    '// @parity-evidence: Repeated official SDK serialization proves only the source-bound SOAP namespace assertions in these regions.\n' +
    after;
  assertSoapParityBindingsFromSource(pathToFileURL(target), next, after);
  return {
    path: file,
    before: source,
    after,
    oldPartialAssertions,
    previouslyGuardedNamespaceAssertions: 0,
    newPartialAssertions: regions.length,
    newWholeCases: 0,
  };
}

function main(args) {
  const option = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: node scripts/qualify-soap-namespace.mjs --root <repo> --loop-manifest <json> --namespace-proof <json> --authority-file <json> --authority-sha256 <sha256> [--write]\n',
    );
    return;
  }
  const root = path.resolve(option('--root') ?? path.dirname(path.dirname(TOOL)));
  const report = qualifySoapNamespaces({
    root,
    loopManifest: JSON.parse(fs.readFileSync(option('--loop-manifest'), 'utf8')),
    proof: JSON.parse(fs.readFileSync(option('--namespace-proof'), 'utf8')),
    authorityFile: option('--authority-file'),
    authoritySha256: option('--authority-sha256'),
  });
  const target = path.resolve(root, report.path);
  if (args.includes('--write') && report.after !== report.before) {
    requireCondition(fs.readFileSync(target, 'utf8') === report.before, 'source changed before write');
    const directory = fs.mkdtempSync(path.join(path.dirname(target), '.qualify-soap-namespace-')),
      temporary = path.join(directory, 'content');
    try {
      fs.writeFileSync(temporary, report.after, { flag: 'wx' });
      fs.renameSync(temporary, target);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        path: report.path,
        beforeSha256: hash(report.before),
        afterSha256: hash(report.after),
        oldPartialAssertions: report.oldPartialAssertions,
        previouslyGuardedNamespaceAssertions: report.previouslyGuardedNamespaceAssertions,
        newPartialAssertions: report.newPartialAssertions,
        newWholeCases: report.newWholeCases,
        wrote: args.includes('--write') && report.after !== report.before,
      },
      null,
      2,
    ) + '\n',
  );
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.message }) + '\n');
    process.exitCode = 1;
  }
}
